import { throttle } from "lodash";
import vscode, {
  ConfigurationChangeEvent,
  Disposable,
  EventEmitter,
  ExtensionContext,
  Uri,
  workspace,
} from "vscode";
import { API, Change, Repository, Status } from "./external/git";

const DIFF_OPTIONS_KEY = "thesilican.gitUtils.diffOptions";

export type FileNode = {
  type: "file";
  name: string;
  path: string;
  change: Change;
};

export type FolderNode = {
  type: "folder";
  name: string;
  path: string;
  children: Node[];
};

export type Node = FileNode | FolderNode;

export type DiffOptions = {
  repo: string;
  ref: string;
};

export class Git implements Disposable {
  listeners = new Map<string, Disposable>();
  diff: { options: DiffOptions; tree: Node[] | null; count: number } | null =
    null;
  diffUpdate = new EventEmitter<void>();
  disposables: Disposable[] = [];

  constructor(
    public context: ExtensionContext,
    public api: API,
  ) {
    const state = context.workspaceState.get<DiffOptions>(DIFF_OPTIONS_KEY);
    if (state) {
      this.diff = { options: state, tree: null, count: 0 };
      this.calculateDiffTree();
    }

    const handleOpenRepo = (repo: Repository) => {
      const listener = repo.state.onDidChange(
        throttle(() => this.handleRepoStateChange(repo), 1000),
      );
      // Remove any existing listener
      this.listeners.get(repo.rootUri.fsPath)?.dispose();
      this.listeners.set(repo.rootUri.fsPath, listener);
      this.tryOpenRepo(repo);
    };
    this.disposables.push(
      api.onDidOpenRepository(handleOpenRepo),
      api.onDidCloseRepository((repo) => {
        this.listeners.get(repo.rootUri.fsPath)?.dispose();
        this.listeners.delete(repo.rootUri.fsPath);
        if (this.diff?.options.repo === repo.rootUri.fsPath) {
          this.updateDiffRepo(this.api.repositories[0]?.rootUri.fsPath ?? null);
        }
      }),
      new Disposable(() => this.listeners.forEach((l) => void l.dispose())),
      workspace.onDidChangeConfiguration((e) =>
        this.handleWorkspaceConfigurationChange(e),
      ),
      this.diffUpdate.event(() => {
        this.context.workspaceState.update(
          DIFF_OPTIONS_KEY,
          this.diff?.options ?? null,
        );
      }),
    );
    for (const repo of api.repositories) {
      handleOpenRepo(repo);
    }
  }

  async updateDiffRepo(repoPath: string | null) {
    if (repoPath !== null) {
      const repo = this.api.getRepository(Uri.file(repoPath));
      if (repo) {
        const ref = repo.state.HEAD?.name;
        if (ref) {
          this.diff = {
            options: { repo: repoPath, ref },
            tree: null,
            count: 0,
          };
          this.calculateDiffTree();
          return;
        }
      }
    }
    this.diff = null;
    this.diffUpdate.fire();
  }

  async updateDiffRef(ref: string) {
    if (this.diff) {
      this.diff.options.ref = ref;
      await this.calculateDiffTree();
    }
  }

  async tryOpenRepo(repo: Repository) {
    if (this.diff === null && repo.state.HEAD) {
      this.diff = {
        options: {
          repo: repo.rootUri.fsPath,
          ref: repo.state.HEAD?.name ?? "HEAD",
        },
        tree: null,
        count: 0,
      };
      this.calculateDiffTree();
    }
  }

  async handleRepoStateChange(repo: Repository) {
    if (this.diff === null) {
      this.tryOpenRepo(repo);
    } else if (this.diff?.options.repo === repo.rootUri.fsPath) {
      this.calculateDiffTree();
    }
  }

  async handleWorkspaceConfigurationChange(e: ConfigurationChangeEvent) {
    if (e.affectsConfiguration("thesilican.gitUtils")) {
      this.calculateDiffTree();
    }
  }

  async calculateDiffTree() {
    if (!this.diff) {
      this.diffUpdate.fire();
      return;
    }
    const { ref, repo: repoPath } = this.diff.options;
    const repo = this.api.getRepository(Uri.file(repoPath));
    if (!repo) {
      this.diffUpdate.fire();
      return;
    }
    const full =
      workspace.getConfiguration("thesilican.gitUtils").get("diffMode") ===
      "full";
    const changes = await getDiff(repo, ref, full);
    this.diff.tree = buildDiffTree(repo, changes);
    this.diff.count = changes.length;
    this.diffUpdate.fire();
  }

  dispose() {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

async function getDiff(
  repo: Repository,
  ref: string,
  full: boolean,
): Promise<Change[]> {
  const start = performance.now();
  if (!full) {
    const newRef = await repo.getMergeBase(ref, "HEAD");
    if (!newRef) {
      vscode.window.showErrorMessage(
        `${ref} and HEAD have no common merge base`,
      );
      return [];
    }
    ref = newRef;
  }
  const changes = await repo.diffWith(ref);
  const changeMap = new Map<string, Change>();
  for (const change of changes) {
    changeMap.set(change.uri.path, change);
  }
  for (const change of repo.state.workingTreeChanges) {
    if (change.status === Status.UNTRACKED) {
      changeMap.set(change.uri.path, change);
    }
  }
  console.log(`getDiff: ${(performance.now() - start).toFixed(2)}ms`);
  return Array.from(changeMap.values());
}

function buildDiffTree(repo: Repository, changes: Change[]): Node[] {
  const repoPath = repo.rootUri.fsPath;
  const root: FolderNode = {
    type: "folder",
    name: "/",
    path: repoPath,
    children: [],
  };
  for (const change of changes) {
    const path = change.uri.fsPath;
    if (!path.startsWith(`${repoPath}/`)) {
      throw new Error(`Expected ${path} to start with ${repoPath}/`);
    }
    const parts = path.slice(repoPath.length + 1).split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      if (i < parts.length - 1) {
        const folder = node.children.find(
          (node) => node.type === "folder" && node.name === name,
        ) as FolderNode | undefined;
        if (folder) {
          node = folder;
        } else {
          const folder: FolderNode = {
            type: "folder",
            name,
            path: `${node.path}/${name}`,
            children: [],
          };
          node.children.push(folder);
          node = folder;
        }
      } else {
        node.children.push({
          type: "file",
          name,
          path: `${node.path}/${name}`,
          change,
        });
      }
    }
  }
  // Collapse nested folders with only one child
  function collapseRecursive(node: Node) {
    if (node.type === "folder") {
      for (const child of node.children) {
        collapseRecursive(child);
      }
      if (node.children.length === 1 && node.children[0]?.type === "folder") {
        const child = node.children[0];
        node.name = `${node.name}/${child.name}`;
        node.path = child.path;
        node.children = child.children;
      }
    }
  }
  collapseRecursive(root);
  // Sort nodes
  function sortRecursive(node: Node) {
    if (node.type === "folder") {
      node.children.sort((a, b) => {
        if (a.type === "folder" && b.type === "file") return -1;
        if (a.type === "file" && b.type === "folder") return 1;
        return a.name.localeCompare(b.name);
      });
      for (const child of node.children) {
        sortRecursive(child);
      }
    }
  }
  sortRecursive(root);

  return root.children;
}
