import { execFile } from "node:child_process";
import path from "node:path";
import {
  type DecorationOptions,
  type Disposable,
  type ExtensionContext,
  MarkdownString,
  Range,
  type TextDocument,
  type TextEditor,
  ThemeColor,
  window,
  workspace,
} from "vscode";
import type { Git } from "./git";

const UNCOMMITTED = "0000000000000000000000000000000000000000";

type LineBlame = {
  sha: string;
  author: string;
  timestamp: number;
  summary: string;
};

type BlameResult = {
  version: number;
  lines: (LineBlame | null)[];
};

export class BlameProvider implements Disposable {
  decorationType = window.createTextEditorDecorationType({
    before: {
      color: new ThemeColor("editorCodeLens.foreground"),
      fontWeight: "normal",
      fontStyle: "normal",
      margin: "0 1em 0 0",
    },
  });
  cache = new Map<string, BlameResult>();
  disposables: Disposable[] = [];

  constructor(
    public context: ExtensionContext,
    public git: Git,
  ) {
    this.disposables.push(
      window.onDidChangeVisibleTextEditors(() => {
        this.refreshVisibleEditors();
      }),
      workspace.onDidChangeTextDocument((event) => {
        const editor = window.visibleTextEditors.find(
          (e) => e.document.uri.fsPath === event.document.uri.fsPath,
        );
        if (editor) {
          this.refresh(editor);
        }
      }),
      workspace.onDidCloseTextDocument((doc) => {
        this.cache.delete(doc.uri.toString());
      }),
      workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("thesilican.gitUtils.fileBlame")) {
          this.refreshVisibleEditors();
        }
      }),
      git.api.onDidOpenRepository(() => {
        this.refreshVisibleEditors();
      }),
      git.api.onDidCloseRepository(() => {
        this.refreshVisibleEditors();
      }),
    );
    this.refreshVisibleEditors();
  }

  enabled(): boolean {
    return (
      workspace
        .getConfiguration("thesilican.gitUtils")
        .get<boolean>("fileBlame") ?? false
    );
  }

  async refreshVisibleEditors() {
    for (const editor of window.visibleTextEditors) {
      await this.refresh(editor);
    }
  }

  async refresh(editor: TextEditor | undefined) {
    if (!editor) {
      return;
    }
    if (!this.enabled() || editor.document.uri.scheme !== "file") {
      editor.setDecorations(this.decorationType, []);
      return;
    }
    const doc = editor.document;
    const repo = this.git.api.getRepository(doc.uri);
    if (!repo) {
      editor.setDecorations(this.decorationType, []);
      return;
    }
    try {
      const result = await this.getBlame(doc, repo.rootUri.fsPath);
      // Bail if the editor changed or the document was edited while we waited.
      if (
        window.activeTextEditor !== editor ||
        doc.version !== result.version
      ) {
        return;
      }
      editor.setDecorations(
        this.decorationType,
        this.buildDecorations(doc, result.lines),
      );
    } catch {
      editor.setDecorations(this.decorationType, []);
    }
  }

  async getBlame(doc: TextDocument, repoRoot: string): Promise<BlameResult> {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === doc.version) {
      return cached;
    }
    const start = performance.now();
    const relPath = path.relative(repoRoot, doc.uri.fsPath);
    const output = await runGitBlame(
      this.git.api.git.path,
      repoRoot,
      relPath,
      doc.getText(),
    );
    const result: BlameResult = {
      version: doc.version,
      lines: parseBlame(output),
    };
    this.cache.set(key, result);
    console.log(`getBlame: ${(performance.now() - start).toFixed(2)}ms`);
    return result;
  }

  buildDecorations(
    doc: TextDocument,
    lines: (LineBlame | null)[],
  ): DecorationOptions[] {
    const decorations: DecorationOptions[] = [];
    const count = Math.min(doc.lineCount, lines.length);
    for (let i = 0; i < count; i++) {
      const blame = lines[i];
      if (!blame) {
        continue;
      }
      const start = doc.lineAt(i).range.start;
      decorations.push({
        range: new Range(start, start),
        renderOptions: { before: { contentText: formatAnnotation(blame) } },
        hoverMessage: formatHover(blame),
      });
    }
    return decorations;
  }

  dispose() {
    this.decorationType.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

function runGitBlame(
  gitPath: string,
  cwd: string,
  relPath: string,
  contents: string,
): Promise<string> {
  return new Promise((res, rej) => {
    const child = execFile(
      gitPath,
      ["blame", "--line-porcelain", "--contents", "-", "--", relPath],
      { cwd, maxBuffer: 100 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rej(new Error(stderr || error.message));
        } else {
          res(stdout);
        }
      },
    );
    child.stdin?.end(contents);
  });
}

function parseBlame(output: string): (LineBlame | null)[] {
  const lines: (LineBlame | null)[] = [];
  let sha = "";
  let author = "";
  let time = 0;
  let summary = "";
  for (const line of output.split("\n")) {
    if (/^[0-9a-f]{40} /.test(line)) {
      sha = line.slice(0, 40);
    } else if (line.startsWith("author ")) {
      author = line.slice("author ".length);
    } else if (line.startsWith("author-time ")) {
      time = Number.parseInt(line.slice("author-time ".length), 10);
    } else if (line.startsWith("summary ")) {
      summary = line.slice("summary ".length);
    } else if (line.startsWith("\t")) {
      // The content line terminates a per-line porcelain block.
      lines.push({ sha, author, timestamp: time, summary });
    }
  }
  return lines;
}

function formatAnnotation(info: LineBlame): string {
  if (info.sha === UNCOMMITTED) {
    return "You • Uncommitted changes";
  }
  return `${info.author}, ${relativeDate(info.timestamp)} • ${info.summary}`;
}

function formatHover(info: LineBlame): MarkdownString {
  const md = new MarkdownString();
  if (info.sha === UNCOMMITTED) {
    md.appendText("Uncommitted changes");
    return md;
  }
  md.appendMarkdown(`**${info.summary}**\n\n`);
  md.appendText(
    `${info.author} • ${new Date(info.timestamp * 1000).toLocaleString()}`,
  );
  md.appendMarkdown(`\n\n\`${info.sha.slice(0, 8)}\``);
  return md;
}

function relativeDate(epochSeconds: number): string {
  const seconds = Math.floor(Date.now() / 1000 - epochSeconds);
  if (seconds < 60) {
    return "just now";
  }
  const units: [label: string, secs: number][] = [
    ["year", 365 * 24 * 60 * 60],
    ["month", 30 * 24 * 60 * 60],
    ["week", 7 * 24 * 60 * 60],
    ["day", 24 * 60 * 60],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  for (const [label, secs] of units) {
    const value = Math.floor(seconds / secs);
    if (value >= 1) {
      return `${value} ${label}${value === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}
