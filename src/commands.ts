import path from "node:path";
import {
	ConfigurationTarget,
	commands,
	type Disposable,
	type ExtensionContext,
	Uri,
	window,
	workspace,
} from "vscode";
import type { RootNode, TreeNode } from "./diff";
import { RefType, Status } from "./external/git";
import type { FileNode, Git, Node } from "./git";

const ADDED = [
	Status.UNTRACKED,
	Status.INDEX_ADDED,
	Status.INTENT_TO_ADD,
	Status.IGNORED,
	Status.ADDED_BY_US,
	Status.ADDED_BY_THEM,
	Status.BOTH_ADDED,
];

const MODIFIED = [
	Status.INDEX_MODIFIED,
	Status.INDEX_COPIED,
	Status.MODIFIED,
	Status.TYPE_CHANGED,
	Status.BOTH_MODIFIED,
];

const RENAMED = [Status.INDEX_RENAMED, Status.INTENT_TO_RENAME];

const DELETED = [
	Status.INDEX_DELETED,
	Status.DELETED,
	Status.DELETED_BY_US,
	Status.DELETED_BY_THEM,
	Status.BOTH_DELETED,
];

type CommandMethod = (this: Commands, ...args: never[]) => unknown;

const registry = new Map<string, CommandMethod>();

function command(id: string) {
	return (
		method: CommandMethod,
		_context: ClassMethodDecoratorContext<Commands>,
	) => {
		registry.set(id, method);
	};
}

export class Commands implements Disposable {
	disposables: Disposable[] = [];
	context: ExtensionContext;
	git: Git;

	constructor(context: ExtensionContext, git: Git) {
		this.context = context;
		this.git = git;
		for (const [id, method] of registry) {
			this.disposables.push(commands.registerCommand(id, method, this));
		}
	}

	@command("thesilican.gitUtils.changeRepository")
	async changeRepository() {
		const items = this.git.api.repositories
			.map((repo) => ({
				repo,
				label: path.basename(repo.rootUri.fsPath),
				description: repo.rootUri.fsPath,
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
		const item = await window.showQuickPick(items, {
			title: "Change Repository",
			placeHolder: "Choose a git repository...",
		});
		if (!item) {
			return;
		}
		this.git.updateDiffRepo(item.repo.rootUri.fsPath);
	}

	@command("thesilican.gitUtils.changeBase")
	async changeBase() {
		const repo = this.git.api.getRepository(
			Uri.file(this.git.diff?.options.repo ?? ""),
		);
		if (!repo) {
			window.showErrorMessage("Please select a repository first.");
			return;
		}
		const refs = await repo.getRefs({ sort: "committerdate" });
		const heads = refs
			.filter((ref) => ref.type === RefType.Head)
			.map((ref) => ({
				ref,
				label: `${ref.name}`,
				description: `${ref.commit?.slice(0, 7)}`,
			}));
		const tags = refs
			.filter((ref) => ref.type === RefType.Tag)
			.map((ref) => ({
				ref,
				label: `${ref.name}`,
				description: `tag ${ref.commit?.slice(0, 7)}`,
			}));
		const remotes = refs
			.filter((ref) => ref.type === RefType.RemoteHead)
			.map((ref) => ({
				ref,
				label: `${ref.name}`,
				description: `remote ${ref.commit?.slice(0, 7)}`,
			}));
		const items = [
			{ label: "Choose commit hash..." } as const,
			...heads,
			...tags,
			...remotes,
		];
		const item = await window.showQuickPick(items, {
			title: "Change Base",
			placeHolder: "Choose a base ref to diff against...",
		});
		if (!item) {
			return;
		}
		if ("ref" in item) {
			if (!item.ref.name) {
				window.showErrorMessage("Selected ref has no name.");
				return;
			}
			await this.git.updateDiffRef(item.ref.name);
		} else {
			const hash = await window.showInputBox({
				title: "Change Base",
				placeHolder: "Enter a commit hash...",
			});
			if (!hash) {
				return;
			}
			const commit = await repo.getCommit(hash);
			await this.git.updateDiffRef(commit.hash);
		}
	}

	@command("thesilican.gitUtils.refresh")
	refresh() {
		this.git.calculateDiffTree();
	}

	@command("thesilican.gitUtils.toggleDiffMode")
	toggleDiffMode() {
		const config = workspace.getConfiguration("thesilican.gitUtils");
		const currentMode = config.get<string>("diffMode");
		const newMode = currentMode === "full" ? "compact" : "full";
		config.update("diffMode", newMode, ConfigurationTarget.Global);
	}

	@command("thesilican.gitUtils.openChanges")
	openChanges(node?: Node) {
		if (node?.type !== "file") {
			return;
		}
		const filename = path.basename(node.change.uri.fsPath);
		const ref = this.git.diff?.options.ref;
		if (!ref) {
			window.showErrorMessage("Please select a base ref to diff against.");
			return;
		}
		if (ADDED.includes(node.change.status)) {
			commands.executeCommand("vscode.open", node.change.uri);
		} else if (MODIFIED.includes(node.change.status)) {
			commands.executeCommand(
				"vscode.diff",
				this.git.api.toGitUri(node.change.uri, ref),
				node.change.uri,
				`${filename} (Working Tree)`,
				{ preview: true },
			);
		} else if (RENAMED.includes(node.change.status)) {
			commands.executeCommand(
				"vscode.diff",
				this.git.api.toGitUri(node.change.originalUri, ref),
				node.change.uri,
				`${filename} (Working Tree)`,
				{ preview: true },
			);
		} else if (DELETED.includes(node.change.status)) {
			commands.executeCommand(
				"vscode.open",
				this.git.api.toGitUri(node.change.uri, ref),
			);
		}
	}

	@command("thesilican.gitUtils.openAllChanges")
	openAllChanges() {}

	@command("thesilican.gitUtils.openFile")
	openFile(node?: Node) {
		if (node?.type !== "file") {
			return;
		}
		const ref = this.git.diff?.options.ref;
		if (!ref) {
			window.showErrorMessage("Please select a base ref to diff against.");
			return;
		}
		if (DELETED.includes(node.change.status)) {
			commands.executeCommand(
				"vscode.open",
				this.git.api.toGitUri(node.change.uri, ref),
			);
		} else {
			commands.executeCommand("vscode.open", node.change.uri);
		}
	}

	@command("thesilican.gitUtils.discardChanges")
	async discardChanges(node?: TreeNode) {
		if (!node || node.type === "ref" || node.type === "repo") {
			return;
		}
		const repo = this.git.api.getRepository(
			Uri.file(this.git.diff!.options.repo),
		);
		if (!repo) {
			window.showErrorMessage("The selected repository is no longer open.");
			return;
		}
		const ref = this.git.diff?.options.ref;
		if (!ref) {
			window.showErrorMessage("Please select a base ref to diff against.");
			return;
		}
		const nodes: FileNode[] = [];
		let message: string;
		if (node.type === "file") {
			nodes.push(node);
			const name = path.basename(node.change.uri.fsPath);
			const status = node.change.status;
			if (ADDED.includes(status)) {
				message = `Are you sure you want to delete ${name}?`;
			} else {
				message = `Are you sure you want to restore ${name}?`;
			}
		} else {
			function collectFiles(node: Node | RootNode) {
				if (node.type === "file") {
					nodes.push(node);
				} else {
					for (const child of node.children) {
						collectFiles(child);
					}
				}
			}
			collectFiles(node);
			message = `Are you sure you want to restore ${nodes.length} files to ${ref}?`;
		}
		const choice = await window.showWarningMessage(
			message,
			{ modal: true },
			"Discard Changes",
		);
		if (choice !== "Discard Changes") {
			return;
		}

		try {
			if (nodes.length > 0) {
				const files: string[] = [];
				for (const node of nodes) {
					files.push(node.change.originalUri.fsPath);
					if (node.change.renameUri) {
						files.push(node.change.renameUri.fsPath);
					}
				}
				await repo.restore(files, { ref });
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			window.showErrorMessage(`Failed to discard changes: ${msg}`);
		}
		this.git.calculateDiffTree();
	}

	@command("thesilican.gitUtils.toggleFileBlame")
	toggleFileBlame() {
		const config = workspace.getConfiguration("thesilican.gitUtils");
		const enabled = config.get<boolean>("fileBlame");
		config.update("fileBlame", !enabled, ConfigurationTarget.Global);
	}

	dispose() {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
