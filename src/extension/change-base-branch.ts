import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import { getBaseBranchChoices, listBranches } from "../core/git";
import { BranchReviewModel } from "./model";

interface BaseBranchPickItem extends vscode.QuickPickItem {
  name: string;
}

/**
 * Lets the user pick the branch that the current branch is compared against, and saves it in the
 * branch's review (creating the review if there is none). The tree and diffs then use the new
 * merge-base. The `branchReviewStudio.baseBranch` setting is unchanged.
 */
export async function changeBaseBranch(model: BranchReviewModel): Promise<void> {
  let currentBase = model.baseBranch;
  let names = getBaseBranchChoices(await listBranches(model.repoRoot), currentBase, model.snapshot.branch);
  let items = names.map((name): BaseBranchPickItem => name === currentBase
    ? { label: "$(check) " + name, description: "current base", name }
    : { label: "$(git-branch) " + name, name });
  let picked = await vscode.window.showQuickPick(items, { title: "Change Base Branch",
    placeHolder: `Pick the branch to compare ${model.snapshot.branch ?? "HEAD"} against (currently ${currentBase})` });
  if (picked)
    await changeBaseBranchIfConfirmed(model, picked.name);
}

/**
 * Makes `newBase` the base branch of the current branch's review (see
 * BranchReviewModel.changeBaseBranch) if it differs from the current base and the user confirms
 * (see confirmIfBaseSideThreads). Shows any error.
 */
export async function changeBaseBranchIfConfirmed(model: BranchReviewModel, newBase: string): Promise<void> {
  if (newBase !== model.baseBranch && await confirmIfBaseSideThreads(model, newBase)) {
    try {
      await model.changeBaseBranch(newBase);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not change the base branch: ${getErrorMessage(e)}`);
    }
  }
}

/**
 * Asks whether to change the base branch if the review has threads on the base side of the diff,
 * since those were anchored to the old merge-base. Returns true if there are none or the user
 * confirms.
 */
async function confirmIfBaseSideThreads(model: BranchReviewModel, newBase: string): Promise<boolean> {
  let count = model.snapshot.review?.threads.filter(t => t.side === "base").length ?? 0;
  let threads = count === 1 ? "1 comment thread is" : `${count} comment threads are`;
  return count === 0 || await vscode.window.showWarningMessage(
    `Change the base branch from ${model.baseBranch} to ${newBase}?`,
    { modal: true, detail: `${threads} on the base side of the diff. They were anchored to the merge-base with `
      + `${model.baseBranch}, so they may move or show as outdated. Threads on working-tree files are unaffected.` },
    "Change Base Branch") === "Change Base Branch";
}
