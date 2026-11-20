/** biome-ignore-all lint/suspicious/noAssignInExpressions: makes regex cleaner */

import { format, formatDistanceToNowStrict } from "date-fns";
import { throttle } from "lodash";
import {
	type DecorationOptions,
	type Disposable,
	type ExtensionContext,
	MarkdownString,
	ProgressLocation,
	Range,
	type TextEditor,
	type TextEditorDecorationType,
	ThemeColor,
	window,
	workspace,
} from "vscode";
import type { OpenCommitDiffArgs } from "./commands";
import type { Commit, Repository } from "./external/git";
import type { Git } from "./git";
import { truncateAndPad } from "./util";

const UNCOMMITTED = "0000000000000000000000000000000000000000";

type LineBlame = {
	hash: string;
	author: string;
	timestamp: number;
	summary: string;
	filename: string;
	previous?: { hash: string; filename: string };
};

type BlameBatch = {
	blame: LineBlame;
	lines: number;
};

type BlameResult = {
	version: number;
	batches: BlameBatch[];
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
				const key = doc.uri.toString();
				const reset = () => {
					editor.setDecorations(this.decorationType, []);
					editor.setDecorations(this.highlightType, []);
				};
				const editorChanged = (version: number) => {
					return (
						window.activeTextEditor !== editor ||
						doc.version !== version ||
						!this.blames.has(key)
					);
				};
				if (
					!["file", "git"].includes(doc.uri.scheme) ||
					!this.blames.has(key) ||
					!repo
				) {
					return reset();
				}
				try {
					// Calculate blame
					const cached = this.blames.get(key);
					let version: number;
					let batches: BlameBatch[];
					if (cached?.version === doc.version) {
						version = cached.version;
						batches = cached.batches;
					} else {
						const file = doc.uri.fsPath;
						// Capture version before running blame
						version = doc.version;
						const text = doc.getText();
						// Get ref from git uri, index ("" or "~") and merge stage refs
						// ("~1" to "~3") aren't commits so we blame them like regular files
						let ref: string | undefined;
						if (doc.uri.scheme === "git") {
							const query = JSON.parse(doc.uri.query) as { ref?: string };
							if (query.ref && !query.ref.startsWith("~")) {
								ref = query.ref;
							}
						}
						const root = repo.rootUri.fsPath;
						const output = await this.git.runBlame(root, file, text, ref);
						batches = await parseBlame(output, text);
						// Ensure setting hasn't changed
						if (!this.blames.has(key)) {
							return;
						}
						this.blames.set(key, { batches, version });
					}

					// Update gutter decorations
					if (editorChanged(version)) {
						return;
					}
					const gutter = buildGutterDecorations(editor, batches);
					const highlights = buildHighlightDecorations(editor, batches);
					editor.setDecorations(this.decorationType, gutter);
					editor.setDecorations(this.highlightType, highlights);
					this.updateHighlight(editor);

					// Calculate hover decorations
					const hover = await buildHoverDecorations(editor, batches, repo);

					// Update hover decoration
					if (editorChanged(version)) {
						return;
					}
					editor.setDecorations(this.decorationType, [...gutter, ...hover]);
				} catch {
					reset();
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
		const highlights = buildHighlightDecorations(editor, result.batches);
		editor.setDecorations(this.highlightType, highlights);
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
	editor: TextEditor,
	batches: BlameBatch[],
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
				range: editor.document.lineAt(i).range,
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

function buildHighlightDecorations(editor: TextEditor, batches: BlameBatch[]) {
	const cursorLines = new Set(editor.selections.map((s) => s.active.line));
	const hashes = new Set<string>();
	let start = 0;
	for (const { blame, lines } of batches) {
		for (const line of cursorLines) {
			if (line >= start && line < start + lines) {
				hashes.add(blame.hash);
			}
		}
		start += lines;
	}
	const ranges: Range[] = [];
	start = 0;
	for (const { blame, lines } of batches) {
		if (hashes.has(blame.hash)) {
			ranges.push(
				new Range(
					editor.document.lineAt(start).range.start,
					editor.document.lineAt(start + lines - 1).range.end,
				),
			);
		}
		start += lines;
	}
	return ranges;
}

async function buildHoverDecorations(
	editor: TextEditor,
	batches: BlameBatch[],
	repo: Repository,
): Promise<DecorationOptions[]> {
	const hashes = Array.from(
		new Set(
			batches
				.map((batch) => batch.blame.hash)
				.filter((hash) => hash !== UNCOMMITTED),
		),
	);
	// Parallelize fetching commit information
	const commits = await Promise.all(hashes.map((hash) => repo.getCommit(hash)));
	const commitMap = new Map(commits.map((commit) => [commit.hash, commit]));
	const decorations: DecorationOptions[] = [];
	let start = 0;
	for (const { blame, lines } of batches) {
		const commit = commitMap.get(blame.hash);
		const hoverMessage = formatHover(blame, commit, repo.rootUri.fsPath);
		// Attach to start of line (the gutter annotation)
		for (let i = start; i < start + lines; i++) {
			decorations.push({
				range: editor.document.validateRange(new Range(i, 0, i, 0)),
				hoverMessage,
			});
		}
		start += lines;
	}
	return decorations;
}

async function parseBlame(
	text: string | null,
	docText: string,
): Promise<BlameBatch[]> {
	const batches: BlameBatch[] = [];
	const reset: LineBlame = {
		hash: "",
		author: "",
		timestamp: 0,
		summary: "",
		filename: "",
	};
	// If text is null, entire file is uncommitted
	if (text === null) {
		const lines = docText.split("\n").length;
		return [{ blame: { ...reset, hash: UNCOMMITTED }, lines }];
	}
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
	blame: LineBlame,
	commit: Commit | undefined,
	repoRoot: string,
): MarkdownString {
	const { timestamp, hash, filename, previous, author } = blame;
	const md = new MarkdownString();
	md.supportHtml = true;
	md.supportThemeIcons = true;
	md.isTrusted = {
		enabledCommands: [
			"thesilican.gitUtils.openCommitDiff",
			"thesilican.gitUtils.copyToClipboard",
		],
	};
	if (!commit) {
		const dateText = format(new Date(), "MMM d, yyyy h:mm a");
		md.appendMarkdown(`**You** just now (${dateText})\n\n`);
		md.appendText("Uncommitted changes");
		return md;
	}
	const blameDate = new Date(timestamp * 1000);
	const ago = formatDistanceToNowStrict(blameDate, { addSuffix: true });
	const date = format(blameDate, "MMM d, yyyy h:mm a");
	function makeHref<T>(command: string, args: T) {
		return `command:${command}?${encodeURIComponent(JSON.stringify([args]))}`;
	}
	const commitHref = makeHref<OpenCommitDiffArgs>(
		"thesilican.gitUtils.openCommitDiff",
		{ repoRoot, ref: hash },
	);
	const fileHref = makeHref<OpenCommitDiffArgs>(
		"thesilican.gitUtils.openCommitDiff",
		{ repoRoot, ref: hash, filename, ...(previous && { previous }) },
	);
	const hashShort = hash.slice(0, 8);
	const copyHref = makeHref<string>(
		"thesilican.gitUtils.copyToClipboard",
		hashShort,
	);
	md.appendMarkdown(`**${author}** ${ago} (${date})\n\n`);
	let links =
		`[$(copy)${hashShort}](${copyHref} "Copy to clipboard") &middot;` +
		` [View File](${fileHref}) &middot;` +
		` [View Commit](${commitHref})`;
	if (commit.shortStat) {
		const { files, insertions, deletions } = commit.shortStat;
		links +=
			` (${files} ${files === 1 ? "file" : "files"}, ` +
			`<span style="color:#3fb950;">+${insertions}</span> ` +
			`<span style="color:#f85149;">-${deletions}</span>)`;
	}
	md.appendMarkdown(`${links}\n\n`);
	md.appendMarkdown(`---\n\n`);
	md.appendCodeblock(commit.message.trim(), "text");
	return md;
}
