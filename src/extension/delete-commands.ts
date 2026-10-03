import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import {
  clearReviewContent, deleteThreads, describeReviewContent, formatCount, getResolvedThreadIds, Review,
} from "../core/review";
import { BranchReviewModel } from "./model";

/**
 * Deletes a thread of the current branch's review if the user confirms. The comment widget's
 * Delete Thread button and the Branch Review view's thread rows use it.
 */
export async function deleteThreadIfConfirmed(model: BranchReviewModel, threadId: string): Promise<void> {
  let thread = model.snapshot.review?.threads.find(t => t.id === threadId);
  if (thread && await confirm(`Delete this thread and its ${formatCount(thread.comments.length, "comment")}?`,
    "This can't be undone.", "Delete")) {
    await modifyReviewOrShowError(model, "delete the thread", review => deleteThreads(review, [threadId]));
  }
}

/**
 * Deletes the resolved threads of the current branch's review if the user confirms. Threads that
 * an agent resolves or reopens while the confirmation is open are kept, so that the confirmed
 * count stays accurate.
 */
export async function deleteResolvedThreads(model: BranchReviewModel): Promise<void> {
  let threadIds = getResolvedThreadIds(model.snapshot.review);
  if (threadIds.length === 0) {
    void vscode.window.showInformationMessage("The review has no resolved threads.");
  } else if (await confirm(`Delete ${formatCount(threadIds.length, "resolved thread")}?`,
    "Their comments are deleted too. This can't be undone.", "Delete")) {
    await modifyReviewOrShowError(model, "delete the resolved threads",
      review => deleteThreads(review, getResolvedThreadIds(review).filter(id => threadIds.includes(id))));
  }
}

/**
 * Removes everything from the current branch's review but its base branch (see
 * clearReviewContent) if the user confirms, so that the view shows the branch as if it had no
 * review. Removes nothing (and shows an error) if the review's content changed while the
 * confirmation, which lists that content, was open, e.g. because an agent posted a thread.
 */
export async function clearReview(model: BranchReviewModel): Promise<void> {
  let { review, branch } = model.snapshot;
  let content = review ? describeReviewContent(review) : [];
  if (review === undefined || content.length === 0) {
    void vscode.window.showInformationMessage("The current branch has no review to clear.");
  } else if (await confirm(`Clear the review of branch ${branch}?`, `This deletes:\n${content.map(c => `- ${c}`)
    .join("\n")}\n\nThe base branch (${review.baseBranch}) is kept. This can't be undone.`, "Clear Review")) {
    await modifyReviewOrShowError(model, "clear the review", stored => {
      if (describeReviewContent(stored).join("\n") !== content.join("\n"))
        throw new Error("the review changed while the confirmation was open. Nothing was deleted.");
      clearReviewContent(stored);
    });
  }
}

/** Asks a question in a modal dialog; returns whether the user clicked `button`. */
async function confirm(message: string, detail: string, button: string): Promise<boolean> {
  return await vscode.window.showWarningMessage(message, { modal: true, detail }, button) === button;
}

/**
 * Calls BranchReviewModel.modifyReview, showing an error message if it fails.
 * @param task Completes the error message "Branch Review Studio could not ...", e.g. "clear the review"
 */
async function modifyReviewOrShowError(model: BranchReviewModel, task: string, mutate: (review: Review) => void)
  : Promise<void> {
  try {
    await model.modifyReview(mutate);
  } catch (e) {
    void vscode.window.showErrorMessage(`Branch Review Studio could not ${task}: ${getErrorMessage(e)}`);
  }
}
