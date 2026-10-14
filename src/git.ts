import { throttle } from "lodash";
import vscode, {
	type ConfigurationChangeEvent,
	Disposable,
	EventEmitter,
	type ExtensionContext,
	Uri,
	workspace,
} from "vscode";
import { type API, type Change, type Repository, Status } from "./external/git";

const DIFF_TARGET_KEY = "thesilican.gitUtils.diffTarget";

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

type DiffState = {
	tree: Node[] | null;
	count: number;
};

type DiffTarget = {
	path: string;
	ref: string;
};

export class Git implements Disposable {
	api: API;
	context: ExtensionContext;
	diff: DiffState | null = null;
	diffTarget: DiffTarget | null = null;
	diffUpdate = new EventEmitter<void>();
	repoListeners = new Map<string, Disposable>();
	disposables: Disposable[] = [];

	constructor(context: ExtensionContext, api: API) {
		this.context = context;
		this.api = api;
		this.diffTarget = context.workspaceState.get(DIFF_TARGET_KEY) ?? null;

		this.disposables.push(
			api.onDidOpenRepository(this.handleOpenRepo.bind(this)),
			api.onDidCloseRepository(this.handleCloseRepo.bind(this)),
			workspace.onDidChangeConfiguration(this.handleConfigChange.bind(this)),
			this.diffUpdate.event(() => {
				this.context.workspaceState.update(
					DIFF_TARGET_KEY,
					this.diffTarget ?? undefined,
				);
			}),
			new Disposable(() => this.repoListeners.forEach((l) => void l.dispose())),
		);
		for (const repo of api.repositories) {
			this.handleOpenRepo(repo);
		}
	}

	handleOpenRepo(repo: Repository) {
		// Remove any existing listener
		this.repoListeners.get(repo.rootUri.fsPath)?.dispose();
		// Listen for repo changes
		const listener = repo.state.onDidChange(
			throttle(() => this.handleRepoStateChange(repo), 1000),
		);
		this.repoListeners.set(repo.rootUri.fsPath, listener);
		// If there is no diff target, set this repo as diff target
		if (this.diffTarget === null && repo.state.HEAD?.name) {
			this.setDiffTarget({
				path: repo.rootUri.fsPath,
				ref: repo.state.HEAD.name,
			});
		}
	}

	handleCloseRepo(repo: Repository) {
		this.repoListeners.get(repo.rootUri.fsPath)?.dispose();
		this.repoListeners.delete(repo.rootUri.fsPath);
		// If the current diff target is the repo being closed, set to next available repo
		if (this.diffTarget?.path === repo.rootUri.fsPath) {
			const path = this.api.repositories[0]?.rootUri.fsPath ?? null;
			this.setDiffTarget(path ? { path } : null);
		}
	}

	async setDiffTarget(target: Partial<DiffTarget> | null) {
		if (target === null) {
			this.diffTarget = null;
			this.diff = null;
			this.diffUpdate.fire();
			return;
		}
		const path = target.path ?? this.diffTarget?.path ?? null;
		if (path === null) {
			this.diffTarget = null;
			this.diff = null;
			this.diffUpdate.fire();
			return;
		}
		const repo = this.api.getRepository(Uri.file(path));
		if (!repo) {
			this.diffTarget = null;
			this.diff = null;
			this.diffUpdate.fire();
			return;
		}
		const pathChanged = path !== this.diffTarget?.path;
		const head = repo.state.HEAD?.name;
		const oldRef = this.diffTarget?.ref;
		const ref = target.ref ?? (pathChanged ? head : oldRef) ?? null;
		if (!ref) {
			this.diffTarget = null;
			this.diff = null;
			this.diffUpdate.fire();
			return;
		}

		this.diffTarget = { path, ref };
		this.diff = null;
		return this.calculateDiff();
	}

	async handleRepoStateChange(repo: Repository) {
		if (this.diffTarget?.path === repo.rootUri.fsPath) {
			this.calculateDiff();
		}
	}

	async handleConfigChange(e: ConfigurationChangeEvent) {
		if (e.affectsConfiguration("thesilican.gitUtils")) {
			this.calculateDiff();
		}
	}

	async calculateDiff() {
		vscode.window.withProgress(
			{ location: { viewId: "thesilican.gitUtils.diff" } },
			async () => {
				if (!this.diffTarget) {
					this.diffUpdate.fire();
					return;
				}
				const { ref, path } = this.diffTarget;
				const repo = this.api.getRepository(Uri.file(path));
				if (!repo) {
					this.diffUpdate.fire();
					return;
				}
				const full =
					workspace.getConfiguration("thesilican.gitUtils").get("diffMode") ===
					"full";
				const changes = await getDiff(repo, ref, full);
				const tree = buildDiffTree(repo, changes);
				const count = changes.length;
				this.diff = { tree, count };
				this.diffUpdate.fire();
			},
		);
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
