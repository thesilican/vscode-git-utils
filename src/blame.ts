/** biome-ignore-all lint/suspicious/noAssignInExpressions: makes regex cleaner */

import { execFile } from "node:child_process";
import path from "node:path";
import { format, formatDistanceToNowStrict } from "date-fns";
import { throttle } from "lodash";
import {
	type DecorationOptions,
	type Disposable,
	type ExtensionContext,
	MarkdownString,
	ProgressLocation,
	Range,
	type TextDocument,
	type TextEditor,
	type TextEditorDecorationType,
	ThemeColor,
	window,
	workspace,
} from "vscode";
import type { OpenCommitDiffArgs } from "./commands";
import type { Repository } from "./external/git";
import type { Git } from "./git";

const UNCOMMITTED = "0000000000000000000000000000000000000000";

type LineBlame = {
	hash: string;
	author: string;
	timestamp: number;
	summary: string;
	filename: string;
	previous?: { hash: string; filename: string };
};

type LineBlameBatch = {
	blame: LineBlame;
	lines: number;
};

type BlameResult = {
	version: number;
	batches: LineBlameBatch[];
};

export class BlameProvider implements Disposable {
	disposables: Disposable[] = [];
	context: ExtensionContext;
	git: Git;
	decorationType: TextEditorDecorationType;
	highlightType: TextEditorDecorationType;
	blames = new Map<string, BlameResult | null>();

	constructor(context: ExtensionContext, git: Git) {
		this.context = context;
		this.git = git;
		this.decorationType = window.createTextEditorDecorationType({
			before: {
				color: new ThemeColor("editorCodeLens.foreground"),
				fontWeight: "normal",
				fontStyle: "normal",
				margin: "0 4px 0 0",
			},
		});
		this.highlightType = window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new ThemeColor("editor.wordHighlightBackground"),
		});
		this.disposables.push(
			this.decorationType,
			this.highlightType,
			window.onDidChangeVisibleTextEditors(() => {
				this.refreshVisibleEditors();
			}),
			window.onDidChangeTextEditorSelection((event) => {
				this.updateHighlight(event.textEditor);
			}),
			workspace.onDidChangeTextDocument(
				throttle((event) => {
					const editor = window.visibleTextEditors.find(
						(e) => e.document.uri.toString() === event.document.uri.toString(),
					);
					if (editor) {
						this.refresh(editor);
					}
				}, 100),
			),
			workspace.onDidCloseTextDocument((doc) => {
				this.blames.delete(doc.uri.toString());
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

	async refreshVisibleEditors() {
		for (const editor of window.visibleTextEditors) {
			await this.refresh(editor);
		}
	}

	async refresh(editor: TextEditor) {
		window.withProgress(
			{
				location: ProgressLocation.Window,
				title: "Generating file blame...",
			},
			async () => {
				const doc = editor.document;
				const repo = this.git.api.getRepository(doc.uri);
				if (
					doc.uri.scheme !== "file" ||
					!this.blames.has(doc.uri.toString()) ||
					!repo
				) {
					editor.setDecorations(this.decorationType, []);
					editor.setDecorations(this.highlightType, []);
					return;
				}
				try {
					const key = doc.uri.toString();
					const cached = this.blames.get(key);
					let result: BlameResult;
					if (cached && cached.version === doc.version) {
						result = cached;
					} else {
						const relPath = path.relative(repo.rootUri.fsPath, doc.uri.fsPath);
						const output = await runGitBlame(
							this.git.api.git.path,
							repo.rootUri.fsPath,
							relPath,
							doc.getText(),
						);
						const batches = await parseBlame(output);
						result = {
							version: doc.version,
							batches,
						};
						this.blames.set(key, result);
					}
					const decorations = buildGutterDecorations(doc, result.batches);
					// Bail if the editor changed or the document was edited while we waited.
					if (
						window.activeTextEditor !== editor ||
						doc.version !== result.version ||
						!this.blames.has(doc.uri.toString())
					) {
						return;
					}
					editor.setDecorations(this.decorationType, decorations);
					this.updateHighlight(editor);
					const hoverDecorations = await buildHoverDecorations(
						doc,
						result.batches,
						repo,
					);
					if (
						window.activeTextEditor !== editor ||
						doc.version !== result.version ||
						!this.blames.has(doc.uri.toString())
					) {
						return;
					}
					editor.setDecorations(this.decorationType, [
						...decorations,
						...hoverDecorations,
					]);
				} catch (err) {
					console.log(err);
					editor.setDecorations(this.decorationType, []);
					editor.setDecorations(this.highlightType, []);
				}
			},
		);
	}

	updateHighlight(editor: TextEditor) {
		const doc = editor.document;
		const result = this.blames.get(doc.uri.toString());
		if (!result || result.version !== doc.version) {
			editor.setDecorations(this.highlightType, []);
			return;
		}
		const cursorLines = new Set(editor.selections.map((s) => s.active.line));
		const hashes = new Set<string>();
		let start = 0;
		for (const { blame, lines } of result.batches) {
			for (const line of cursorLines) {
				if (line >= start && line < start + lines) {
					hashes.add(blame.hash);
				}
			}
			start += lines;
		}
		const ranges: Range[] = [];
		start = 0;
		for (const { blame, lines } of result.batches) {
			if (hashes.has(blame.hash)) {
				ranges.push(
					new Range(
						doc.lineAt(start).range.start,
						doc.lineAt(start + lines - 1).range.end,
					),
				);
			}
			start += lines;
		}
		editor.setDecorations(this.highlightType, ranges);
	}

	async toggleEditor(editor: TextEditor) {
		const key = editor.document.uri.toString();
		if (this.blames.has(key)) {
			this.blames.delete(key);
			editor.setDecorations(this.decorationType, []);
			editor.setDecorations(this.highlightType, []);
		} else {
			this.blames.set(key, null);
			this.refresh(editor);
		}
	}

	dispose() {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

function buildGutterDecorations(
	doc: TextDocument,
	batches: LineBlameBatch[],
): DecorationOptions[] {
	const decorations: DecorationOptions[] = [];
	let longestAuthor = 0;
	let longestSummary = 0;
	for (const batch of batches) {
		longestAuthor = Math.max(batch.blame.author.length, longestAuthor);
		longestSummary = Math.max(batch.blame.summary.length, longestSummary);
	}

	let start = 0;
	for (const { blame, lines } of batches) {
		const annotation = formatAnnotation(blame, longestAuthor, longestSummary);
		// Set annotation on each line in range
		for (let i = start; i < start + lines; i++) {
			// Only the first line renders annotation text
			const contentText =
				i === start ? annotation : "\xa0".repeat(annotation.length);
			const borderWidth = i === start + lines - 1 ? "0 0 1px 0" : "0 0 0 0";
			decorations.push({
				range: doc.lineAt(i).range,
				renderOptions: {
					before: {
						contentText,
						backgroundColor: "#fff1",
						height: "100%",
						// Inject styles via textDecoration
						textDecoration: `none;border-color:#0000;border-style:solid;border-width:${borderWidth}`,
					},
				},
			});
		}
		start += lines;
	}
	return decorations;
}

async function buildHoverDecorations(
	doc: TextDocument,
	batches: LineBlameBatch[],
	repo: Repository,
): Promise<DecorationOptions[]> {
	const hashes = new Set(
		batches
			.map((batch) => batch.blame.hash)
			.filter((hash) => hash !== UNCOMMITTED),
	);
	// Parallelize fetching commit information
	const commits = await Promise.all(
		Array.from(hashes).map((hash) => repo.getCommit(hash)),
	);
	const messages = new Map(
		commits.map((commit) => [commit.hash, commit.message]),
	);
	const decorations: DecorationOptions[] = [];
	let start = 0;
	for (const { blame, lines } of batches) {
		decorations.push({
			range: new Range(
				doc.lineAt(start).range.start,
				doc.lineAt(start + lines - 1).range.end,
			),
			hoverMessage: formatHover(
				blame,
				messages.get(blame.hash) ?? "",
				repo.rootUri.fsPath,
			),
		});
		start += lines;
	}
	return decorations;
}

function runGitBlame(
	gitPath: string,
	repoRoot: string,
	relPath: string,
	contents: string,
): Promise<string> {
	return new Promise((res, rej) => {
		const child = execFile(
			gitPath,
			["blame", "--line-porcelain", "--contents", "-", "--", relPath],
			{ cwd: repoRoot, maxBuffer: 1_000_000_000 },
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

async function parseBlame(text: string): Promise<LineBlameBatch[]> {
	const batches: LineBlameBatch[] = [];
	const reset: LineBlame = {
		hash: "",
		author: "",
		timestamp: 0,
		summary: "",
		filename: "",
	};
	let blame = { ...reset };
	for (const line of text.split("\n")) {
		let match: RegExpMatchArray | null;
		if ((match = line.match(/^author (.+)$/))) {
			blame.author = match[1] ?? "???";
		} else if ((match = line.match(/^author-time (.+)$/))) {
			blame.timestamp = Number.parseInt(match[1] ?? "0", 10);
		} else if ((match = line.match(/^summary (.+)$/))) {
			blame.summary = match[1] ?? "???";
		} else if ((match = line.match(/^previous ([0-9a-f]{40}) (.+)$/))) {
			blame.previous = { hash: match[1] ?? "", filename: match[2] ?? "" };
		} else if ((match = line.match(/^filename (.+)$/))) {
			blame.filename = match[1] ?? "";
		} else if ((match = line.match(/^([0-9a-f]{40}) /))) {
			blame.hash = match[1] ?? "";
		} else if (line.startsWith("\t")) {
			if (!blame.hash) {
				window.showErrorMessage("Missing SHA for line");
				throw new Error("Missing SHA for line");
			}
			if (blame.hash === UNCOMMITTED) {
				blame = { ...reset, hash: UNCOMMITTED };
			}
			const prev = batches.at(-1);
			if (prev && prev.blame.hash === blame.hash) {
				prev.lines++;
			} else {
				batches.push({ blame, lines: 1 });
			}
			blame = { ...reset };
		}
	}
	return batches;
}

function formatAnnotation(
	info: LineBlame,
	longestAuthor: number,
	longestSummary: number,
): string {
	function shortRelativeDate(timestamp: number): string {
		const secs = Math.floor(Date.now() / 1000 - timestamp);
		if (secs < 60) {
			return "now";
		}
		const units = new Map([
			["y", 365 * 24 * 60 * 60],
			["mo", 30 * 24 * 60 * 60],
			["d", 24 * 60 * 60],
			["h", 60 * 60],
			["m", 60],
		]);
		for (const [label, cutoff] of units) {
			const value = Math.floor(secs / cutoff);
			if (value >= 1) {
				return `${value}${label}`;
			}
		}
		return "????";
	}
	const nbsp = "\xa0";
	const authorCut = Math.min(longestAuthor, 16);
	const dateCut = 4;
	const summaryCut = Math.min(longestSummary, 40);
	if (info.hash === UNCOMMITTED) {
		const author = "You".padEnd(authorCut, nbsp);
		const summary = "Uncommited changes".padEnd(summaryCut + dateCut + 1, nbsp);
		return `${author}${nbsp}${summary}`;
	}
	const author = truncateAndPad(info.author, authorCut, nbsp);
	const date = truncateAndPad(shortRelativeDate(info.timestamp), dateCut, nbsp);
	const summary = truncateAndPad(info.summary, summaryCut, nbsp);
	return `${author}${nbsp}${summary}${nbsp}${date}`;
}

function formatHover(
	info: LineBlame,
	commitMessage: string,
	repoRoot: string,
): MarkdownString {
	const md = new MarkdownString();
	md.isTrusted = { enabledCommands: ["thesilican.gitUtils.openCommitDiff"] };
	if (info.hash === UNCOMMITTED) {
		const dateText = format(new Date(), "MMM d, yyyy h:mm a");
		md.appendMarkdown(`**You** just now (${dateText})\n\n`);
		md.appendText("Uncommitted changes");
		return md;
	}
	const date = new Date(info.timestamp * 1000);
	const ago = formatDistanceToNowStrict(date, { addSuffix: true });
	const dateText = format(date, "MMM d, yyyy h:mm a");
	const args: OpenCommitDiffArgs = {
		repoRoot,
		hash: info.hash,
		filename: info.filename,
		...(info.previous && { previous: info.previous }),
	};
	const href = `command:thesilican.gitUtils.openCommitDiff?${encodeURIComponent(JSON.stringify([args]))}`;
	const hash = info.hash.slice(0, 8);
	const prevHash = info.previous?.hash.slice(0, 8);
	const label = prevHash ? `${prevHash} ↔ ${hash}` : hash;
	md.appendMarkdown(`[${label}](${href})\n\n`);
	md.appendMarkdown(`**${info.author}** ${ago} (${dateText})\n\n`);
	md.appendCodeblock(`${commitMessage}`, "markdown");
	return md;
}

function truncateAndPad(text: string, len: number, char = " "): string {
	if (len === 0) {
		return "";
	}
	// If longer than max len, truncate right after first non-space char
	if (text.length > len) {
		// i is position of ellipses
		let i = len - 1;
		while (i > 0 && text[i - 1] === " ") {
			i--;
		}
		text = `${text.slice(0, i)}…`;
	}
	return text.padEnd(len, char);
}
