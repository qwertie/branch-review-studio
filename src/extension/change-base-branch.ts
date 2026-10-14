import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import { getBaseBranchChoices, listBranches, tryGetCommitSha } from "../core/git";
import { BranchReviewModel } from "./model";

interface BaseBranchPickItem extends vscode.QuickPickItem {
  /** Undefined for the item that asks for a commit or other revision */
  name: string | undefined;
}

/**
 * Lets the user pick the branch, or enter the commit (or tag or other revision), that the current
 * branch is compared against, and saves it in the branch's review (creating the review if there
 * is none). The tree and diffs then use the new merge-base. The `branchReviewStudio.baseBranch`
 * setting is unchanged.
 */
export async function changeBaseBranch(model: BranchReviewModel): Promise<void> {
  let currentBase = model.baseBranch;
  let branch = model.snapshot.branch ?? "HEAD";
  let names = getBaseBranchChoices(await listBranches(model.repoRoot), currentBase, model.snapshot.branch);
  let items = names.map((name): BaseBranchPickItem => name === currentBase
    ? { label: "$(check) " + name, description: "current base", name }
    : { label: "$(git-branch) " + name, name });
  // alwaysShow keeps the item visible when the typed text (e.g. a SHA) matches no branch
  items.splice(1, 0, { label: "$(git-commit) Use a commit or other ref…", alwaysShow: true, name: undefined,
    description: "e.g. the base's commit from before the branch was merged" });
  let picked = await pickItem(items, "Change Base Branch",
    `Pick the branch, or type the commit, to compare ${branch} against (currently ${currentBase})`);
  let newBase = picked && (picked.item.name ?? await askForRevision(model, branch, picked.typedText));
  if (newBase)
    await changeBaseBranchIfConfirmed(model, newBase);
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
 * Shows a quick pick of `items`; returns the accepted item and the text typed in the quick pick, or
 * undefined if the user cancels.
 */
async function pickItem<T extends vscode.QuickPickItem>(items: T[], title: string, placeholder: string)
  : Promise<{ item: T, typedText: string } | undefined> {
  let quickPick = vscode.window.createQuickPick<T>();
  quickPick.title = title;
  quickPick.placeholder = placeholder;
  quickPick.items = items;
  try {
    return await new Promise(resolve => {
      quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0] && { item: quickPick.selectedItems[0],
        typedText: quickPick.value }));
      quickPick.onDidHide(() => resolve(undefined));
      quickPick.show();
    });
  } finally {
    quickPick.dispose();
  }
}

/**
 * Asks for a commit SHA, tag or other revision, starting with `typedText`, and accepts only one
 * that names a commit; returns undefined if the user cancels.
 */
async function askForRevision(model: BranchReviewModel, branch: string, typedText: string)
  : Promise<string | undefined> {
  let revision = await vscode.window.showInputBox({ title: "Change Base Branch", value: typedText.trim(),
    prompt: `Commit SHA, tag or other revision to compare ${branch} against`,
    validateInput: async text => await tryGetCommitSha(model.repoRoot, text.trim()) === undefined
      ? "This is not a commit of this repo." : undefined });
  return revision?.trim();
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
