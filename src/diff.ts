import {
	type Disposable,
	EventEmitter,
	FileDecoration,
	type FileDecorationProvider,
	ThemeIcon,
	type TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
	Uri,
	window,
	workspace,
} from "vscode";
import { Status } from "./external/git";
import type { Git, Node } from "./git";

export type RepoNode = { type: "repo" };

export type RefNode = { type: "ref" };

export type RootNode = { type: "root"; children: Node[] };

export type TreeNode = Node | RefNode | RepoNode | RootNode;

const scheme = "git-utils-diff";

export class DiffTreeProvider
	implements TreeDataProvider<TreeNode>, FileDecorationProvider, Disposable
{
	update = new EventEmitter<null>();
	onDidChangeTreeData = this.update.event;

	git: Git;
	disposables: Disposable[] = [];

	constructor(git: Git) {
		this.git = git;
		this.disposables.push(
			git.diffUpdate.event(() => this.update.fire(null)),
			window.registerFileDecorationProvider(this),
		);
	}

	provideFileDecoration(uri: Uri): FileDecoration | undefined {
		if (uri.scheme !== scheme || !uri.query) {
			return;
		}
		return new FileDecoration(uri.query);
	}

	getChildren(node?: TreeNode | undefined): TreeNode[] {
		if (!node) {
			if (this.git.diff) {
				return [
					{ type: "repo" },
					{ type: "ref" },
					{ type: "root", children: this.git.diff?.tree ?? [] },
				];
			} else {
				return [{ type: "repo" }];
			}
		} else if (node.type === "folder" || node.type === "root") {
			return node.children;
		} else {
			return [];
		}
	}

	getTreeItem(node: TreeNode): TreeItem {
		if (node.type === "repo") {
			const name =
				this.git.diffTarget?.path.split("/").pop() ?? "Select a repository";
			const item = new TreeItem(name);
			item.id = "repo";
			item.collapsibleState = TreeItemCollapsibleState.None;
			item.iconPath = new ThemeIcon("repo");
			item.contextValue = "repo";
			item.command = {
				command: "thesilican.gitUtils.changeRepository",
				title: "Change Repository...",
			};
			return item;
		} else if (node.type === "ref") {
			const name = this.git.diffTarget?.ref ?? "???";
			const item = new TreeItem(name);
			item.id = "ref";
			item.collapsibleState = TreeItemCollapsibleState.None;
			item.iconPath = new ThemeIcon("git-branch");
			item.contextValue = "ref";
			item.command = {
				command: "thesilican.gitUtils.changeBase",
				title: "Change Base...",
			};
			return item;
		} else if (node.type === "root") {
			const full =
				workspace.getConfiguration("thesilican.gitUtils").get("diffMode") ===
				"full";
			const count = this.git.diff?.count ?? 0;
			const name = `${count} change${count === 1 ? "" : "s"}${full ? " (full)" : ""}`;
			const item = new TreeItem(name);
			item.id = "root";
			item.collapsibleState = TreeItemCollapsibleState.Expanded;
			item.iconPath = new ThemeIcon("folder-opened");
			item.contextValue = "root";
			return item;
		} else if (node.type === "folder") {
			const item = new TreeItem(Uri.from({ scheme, path: node.path }));
			item.label = node.name;
			item.id = `folder:${node.path}`;
			item.collapsibleState = TreeItemCollapsibleState.Expanded;
			item.iconPath = ThemeIcon.Folder;
			item.contextValue = "folder";
			return item;
		} else {
			const status = node.change.status;
			const badge = {
				[Status.INDEX_MODIFIED]: "M",
				[Status.INDEX_ADDED]: "A",
				[Status.INDEX_DELETED]: "D",
				[Status.INDEX_RENAMED]: "R",
				[Status.INDEX_COPIED]: "C",
				[Status.MODIFIED]: "M",
				[Status.DELETED]: "D",
				[Status.UNTRACKED]: "U",
				[Status.IGNORED]: "I",
				[Status.INTENT_TO_ADD]: "A",
				[Status.INTENT_TO_RENAME]: "R",
				[Status.TYPE_CHANGED]: "T",
				[Status.ADDED_BY_US]: "!",
				[Status.ADDED_BY_THEM]: "!",
				[Status.DELETED_BY_US]: "!",
				[Status.DELETED_BY_THEM]: "!",
				[Status.BOTH_ADDED]: "!",
				[Status.BOTH_DELETED]: "!",
				[Status.BOTH_MODIFIED]: "!",
			}[status];
			const item = new TreeItem(
				Uri.from({ scheme, path: node.path, query: badge }),
			);
			if (status === Status.INDEX_DELETED || status === Status.DELETED) {
				// Apply strike-through using unicode combining character
				item.label = node.name.replace(/./gu, "$&\u0336");
			}
			item.id = `file:${node.path}`;
			item.collapsibleState = TreeItemCollapsibleState.None;
			item.iconPath = ThemeIcon.File;
			item.contextValue = "file";
			item.command = {
				command: "thesilican.gitUtils.openChanges",
				title: "Open Changes",
				arguments: [node],
			};
			return item;
		}
	}

	dispose() {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}
