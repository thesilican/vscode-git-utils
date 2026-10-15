# TheSilican Git Utils

This extension contains a number of git related utilities for VS Code.

Features:
- Git Diff: Compare changes between your working tree and any commit in the git
  history (see Diff view in the Source Control tab).
- Git Blame: For each line of a file, view which commit introduced the change
  (hotkey: `Opt+Shift+B`).

## Build & Install

These instructions allow you to build and install this VS Code extension locally.

You must have node.js installed.

1. Run `npm install`
2. Run `npm run build`
3. In VSCode, open the command palette (`Cmd+Shift+P`),
   then run the command `Developer: Install Extension from Location...`
4. Select the root folder of this repository
