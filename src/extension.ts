import path from "node:path";
import vscode, {
  ConfigurationTarget,
  Uri,
  type ExtensionContext,
} from "vscode";
import { BlameProvider } from "./blame";
import { DiffTreeProvider, RootNode, TreeNode } from "./diff";
import { GitExtension, RefType, Status } from "./external/git";
import { FileNode, Git, Node } from "./git";

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

export function activate(context: ExtensionContext) {
  const disposables = [];
  const api = vscode.extensions
    .getExtension<GitExtension>("vscode.git")!
    .exports.getAPI(1);
  const git = new Git(context, api);
  const diffTreeDataProvider = new DiffTreeProvider(context, git);
  const blameProvider = new BlameProvider(context, git);

  disposables.push(
    git,
    diffTreeDataProvider,
    blameProvider,
    vscode.window.createTreeView("thesilican.gitUtils.diff", {
      treeDataProvider: diffTreeDataProvider,
    }),
    vscode.commands.registerCommand(
      "thesilican.gitUtils.changeRepository",
      async () => {
        const items = git.api.repositories
          .map((repo) => ({
            repo,
            label: path.basename(repo.rootUri.fsPath),
            description: repo.rootUri.fsPath,
          }))
          .sort((a, b) => a.label.localeCompare(b.label));
        const item = await vscode.window.showQuickPick(items, {
          title: "Change Repository",
          placeHolder: "Choose a git repository...",
        });
        if (!item) {
          return;
        }
        git.updateDiffRepo(item.repo.rootUri.fsPath);
      },
    ),
    vscode.commands.registerCommand(
      "thesilican.gitUtils.changeBase",
      async () => {
        const repo = git.api.getRepository(
          Uri.file(git.diff?.options.repo ?? ""),
        );
        if (!repo) {
          vscode.window.showErrorMessage("Please select a repository first.");
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
        const item = await vscode.window.showQuickPick(items, {
          title: "Change Base",
          placeHolder: "Choose a base ref to diff against...",
        });
        if (!item) {
          return;
        }
        if ("ref" in item) {
          if (!item.ref.name) {
            vscode.window.showErrorMessage("Selected ref has no name.");
            return;
          }
          git.updateDiffRef(item.ref.name);
          return;
        }
        const hash = await vscode.window.showInputBox({
          title: "Change Base",
          placeHolder: "Enter a commit hash...",
        });
        if (!hash) {
          return;
        }
        const commit = await repo.getCommit(hash);
        await git.updateDiffRef(commit.hash);
      },
    ),
    vscode.commands.registerCommand("thesilican.gitUtils.refresh", () => {
      git.calculateDiffTree();
    }),
    vscode.commands.registerCommand(
      "thesilican.gitUtils.toggleFileBlame",
      () => {
        const config = vscode.workspace.getConfiguration("thesilican.gitUtils");
        const enabled = config.get<boolean>("fileBlame");
        config.update("fileBlame", !enabled, ConfigurationTarget.Global);
      },
    ),
    vscode.commands.registerCommand(
      "thesilican.gitUtils.toggleDiffMode",
      () => {
        const config = vscode.workspace.getConfiguration("thesilican.gitUtils");
        const currentMode = config.get<string>("diffMode");
        const newMode = currentMode === "full" ? "compact" : "full";
        config.update("diffMode", newMode, ConfigurationTarget.Global);
      },
    ),
    vscode.commands.registerCommand(
      "thesilican.gitUtils.openChanges",
      (node: Node | void) => {
        if (node?.type !== "file") {
          return;
        }
        const filename = path.basename(node.change.uri.fsPath);
        const ref = git.diff?.options.ref;
        if (!ref) {
          vscode.window.showErrorMessage(
            "Please select a base ref to diff against.",
          );
          return;
        }
        if (ADDED.includes(node.change.status)) {
          vscode.commands.executeCommand("vscode.open", node.change.uri);
        } else if (MODIFIED.includes(node.change.status)) {
          console.log(git.api.toGitUri(node.change.uri, ref));
          vscode.commands.executeCommand(
            "vscode.diff",
            git.api.toGitUri(node.change.uri, ref),
            node.change.uri,
            `${filename} (Working Tree)`,
            { preview: true },
          );
        } else if (RENAMED.includes(node.change.status)) {
          vscode.commands.executeCommand(
            "vscode.diff",
            git.api.toGitUri(node.change.originalUri, ref),
            node.change.uri,
            `${filename} (Working Tree)`,
            { preview: true },
          );
        } else if (DELETED.includes(node.change.status)) {
          vscode.commands.executeCommand(
            "vscode.open",
            git.api.toGitUri(node.change.uri, ref),
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "thesilican.gitUtils.openFile",
      (node: Node | void) => {
        if (node?.type !== "file") {
          return;
        }
        const ref = git.diff?.options.ref;
        if (!ref) {
          vscode.window.showErrorMessage(
            "Please select a base ref to diff against.",
          );
          return;
        }
        if (DELETED.includes(node.change.status)) {
          vscode.commands.executeCommand(
            "vscode.open",
            git.api.toGitUri(node.change.uri, ref),
          );
        } else {
          vscode.commands.executeCommand("vscode.open", node.change.uri);
        }
      },
    ),
    vscode.commands.registerCommand(
      "thesilican.gitUtils.discardChanges",
      async (node: TreeNode | void) => {
        if (!node || node.type === "ref" || node.type === "repo") {
          return;
        }
        const repo = git.api.getRepository(Uri.file(git.diff!.options.repo));
        if (!repo) {
          vscode.window.showErrorMessage(
            "The selected repository is no longer open.",
          );
          return;
        }
        const ref = git.diff?.options.ref;
        if (!ref) {
          vscode.window.showErrorMessage(
            "Please select a base ref to diff against.",
          );
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
        const choice = await vscode.window.showWarningMessage(
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
          vscode.window.showErrorMessage(`Failed to discard changes: ${msg}`);
        }
        git.calculateDiffTree();
      },
    ),
  );

  context.subscriptions.push(...disposables);
}

export function deactivate() {}
