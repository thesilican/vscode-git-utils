import vscode, { type ExtensionContext } from "vscode";
import { BlameProvider } from "./blame";
import { Commands } from "./commands";
import { DiffTreeProvider } from "./diff";
import type { GitExtension } from "./external/git";
import { Git } from "./git";

export function activate(context: ExtensionContext) {
	const api = vscode.extensions
		.getExtension<GitExtension>("vscode.git")!
		.exports.getAPI(1);
	const git = new Git(context, api);
	const diffTreeProvider = new DiffTreeProvider(context, git);
	const blameProvider = new BlameProvider(context, git);
	const commands = new Commands(context, git, blameProvider);

	context.subscriptions.push(
		git,
		diffTreeProvider,
		blameProvider,
		commands,
		vscode.window.createTreeView("thesilican.gitUtils.diff", {
			treeDataProvider: diffTreeProvider,
		}),
	);
}

export function deactivate() {}
