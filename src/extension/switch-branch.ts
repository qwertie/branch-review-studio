import * as vscode from "vscode";
import {
  addWorktree, BranchInfo, getDefaultWorktreePath, listBranches, listWorktrees, WorktreeInfo,
} from "../core/git";
import { BranchReviewModel, getErrorMessage } from "./model";

interface BranchPickItem extends vscode.QuickPickItem {
  branch: BranchInfo;
  worktree: WorktreeInfo | undefined;
}

/**
 * Lets the user pick a branch, then opens the branch's worktree, creating the worktree first if
 * there is none. Reviews are keyed by branch, so the opened window shows that branch's review.
 */
export async function switchBranch(model: BranchReviewModel): Promise<void> {
  let [branches, worktrees] = await Promise.all([listBranches(model.repoRoot), listWorktrees(model.repoRoot)]);
  let currentBranch = model.snapshot.branch;
  let items = branches.map((branch): BranchPickItem => {
    let worktree = worktrees.find(w => w.branch === branch.name);
    let isCurrent = branch.name === currentBranch;
    return {
      label: (isCurrent ? "$(check) " : worktree ? "$(folder) " : branch.isLocal ? "$(git-branch) " : "$(cloud) ")
        + branch.name,
      description: isCurrent ? "current" : worktree ? `(worktree: ${worktree.path})` : branch.remoteRef,
      branch,
      worktree,
    };
  });
  let picked = await vscode.window.showQuickPick(items, { matchOnDescription: true,
    placeHolder: "Pick a branch to open in its worktree (a worktree is created if needed)" });
  if (picked && picked.branch.name !== currentBranch)
    await openWorktree(model, picked.branch, picked.worktree, worktrees[0]);
}

/** Opens the existing worktree of `branch`, or creates one after asking the user. */
async function openWorktree(model: BranchReviewModel, branch: BranchInfo, worktree: WorktreeInfo | undefined,
  mainWorktree: WorktreeInfo): Promise<void> {
  let config = vscode.workspace.getConfiguration("branchReviewStudio");
  let worktreePath = worktree?.path;
  if (worktreePath === undefined) {
    let newPath = getDefaultWorktreePath(mainWorktree.path, config.get<string>("worktreeRoot") ?? "", branch.name);
    let source = branch.isLocal ? "" : ` from ${branch.remoteRef}`;
    let choice = await vscode.window.showInformationMessage(
      `Create a worktree for '${branch.name}'${source} at ${newPath}?`, { modal: true }, "Create Worktree");
    if (choice === "Create Worktree") {
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
          title: `Creating worktree for ${branch.name}…` }, () => addWorktree(model.repoRoot, newPath, branch));
        worktreePath = newPath;
      } catch (e) {
        void vscode.window.showErrorMessage(getErrorMessage(e));
      }
    }
  }
  if (worktreePath !== undefined) {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktreePath),
      { forceNewWindow: config.get<boolean>("openWorktreeInNewWindow") ?? false });
  }
}
