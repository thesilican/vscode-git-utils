import {
  type Disposable,
  EventEmitter,
  ExtensionContext,
  ThemeIcon,
  type TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  workspace,
} from "vscode";
import { Status } from "./external/git";
import type { Git, Node } from "./git";

export type RepoNode = { type: "repo" };

export type RefNode = { type: "ref" };

export type RootNode = { type: "root"; children: Node[] };

export type TreeNode = Node | RefNode | RepoNode | RootNode;

export class DiffTreeProvider
  implements TreeDataProvider<TreeNode>, Disposable
{
  update = new EventEmitter<null>();
  onDidChangeTreeData = this.update.event;

  disposables: Disposable[] = [];

  constructor(
    public context: ExtensionContext,
    public git: Git,
  ) {
    this.disposables.push(git.diffUpdate.event(() => this.update.fire(null)));
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
        this.git.diff?.options.repo.split("/").pop() ?? "Select a repository";
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
      const name = this.git.diff?.options.ref ?? "???";
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
      const item = new TreeItem(node.name);
      item.id = "folder:" + node.path;
      item.collapsibleState = TreeItemCollapsibleState.Expanded;
      item.iconPath = new ThemeIcon("folder-opened");
      item.contextValue = "folder";
      return item;
    } else {
      const statusMap = {
        [Status.INDEX_MODIFIED]: "modified",
        [Status.INDEX_ADDED]: "added",
        [Status.INDEX_DELETED]: "deleted",
        [Status.INDEX_RENAMED]: "renamed",
        [Status.INDEX_COPIED]: "copied",
        [Status.MODIFIED]: "modified",
        [Status.DELETED]: "deleted",
        [Status.UNTRACKED]: "untracked",
        [Status.IGNORED]: "ignored",
        [Status.INTENT_TO_ADD]: "added",
        [Status.INTENT_TO_RENAME]: "renamed",
        [Status.TYPE_CHANGED]: "type-changed",
        [Status.ADDED_BY_US]: "conflict",
        [Status.ADDED_BY_THEM]: "conflict",
        [Status.DELETED_BY_US]: "conflict",
        [Status.DELETED_BY_THEM]: "conflict",
        [Status.BOTH_ADDED]: "conflict",
        [Status.BOTH_DELETED]: "conflict",
        [Status.BOTH_MODIFIED]: "conflict",
      };
      const item = new TreeItem(node.name);
      item.id = "file:" + node.path;
      item.collapsibleState = TreeItemCollapsibleState.None;
      item.iconPath = this.context.asAbsolutePath(
        `assets/status-${statusMap[node.change.status]}.svg`,
      );
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
