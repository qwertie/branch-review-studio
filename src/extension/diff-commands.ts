import * as path from "node:path";
import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import { ChangedFile, fetchBranch } from "../core/git";
import { getBaseUri } from "./base-content";
import { BranchReviewModel } from "./model";

/** Opens all changed files in VS Code's multi-diff editor ("changes" editor). */
export async function openAllChanges(model: BranchReviewModel): Promise<void> {
  let { mergeBase, changedFiles, branch } = model.snapshot;
  if (mergeBase === undefined) {
    void vscode.window.showErrorMessage(model.snapshot.mergeBaseError ?? "The merge-base is unknown.");
  } else if (changedFiles.length === 0) {
    void vscode.window.showInformationMessage("No files changed since the merge-base.");
  } else {
    let resources = changedFiles.map(file => {
      let { originalUri, modifiedUri } = getDiffUris(model, file, mergeBase.mergeBaseSha);
      return [vscode.Uri.file(model.getFullPath(file.path)), originalUri, modifiedUri];
    });
    let title = `${branch ?? "HEAD"} vs ${mergeBase.baseRef}`;
    await vscode.commands.executeCommand("vscode.changes", title, resources);
  }
}

/** Opens a diff editor showing a file at the merge-base vs. the working tree. */
export async function openFileDiff(model: BranchReviewModel, filePath: string, selection?: vscode.Range)
  : Promise<void> {
  let { mergeBase, changedFiles } = model.snapshot;
  let file: ChangedFile = changedFiles.find(f => f.path === filePath) ?? { path: filePath, status: "Modified" };
  if (mergeBase === undefined) {
    await vscode.window.showTextDocument(vscode.Uri.file(model.getFullPath(filePath)), { selection });
  } else {
    let { originalUri, modifiedUri } = getDiffUris(model, file, mergeBase.mergeBaseSha);
    let title = `${path.posix.basename(filePath)} (${mergeBase.baseRef} ↔ Working Tree)`;
    await vscode.commands.executeCommand("vscode.diff", originalUri ?? getBaseUri(model.repoRoot, "", file.path),
      modifiedUri ?? getBaseUri(model.repoRoot, "", file.path), title, { selection, preview: false });
  }
}

/** Opens the diff of a thread's file and selects the thread's lines. */
export async function openThread(model: BranchReviewModel, threadId: string): Promise<void> {
  let { review, threadLocations } = model.snapshot;
  let thread = review?.threads.find(t => t.id === threadId);
  let location = threadLocations.get(threadId);
  if (thread && location) {
    let selection = new vscode.Range(location.startLine - 1, 0, location.startLine - 1, 0);
    await openFileDiff(model, thread.file, thread.side === "modified" ? selection : undefined);
  }
}

/**
 * Runs `git fetch origin <baseBranch>`, then refreshes. If the branch has a review, it also stores
 * the new merge-base in it, because the MCP tools read base-side files at `review.mergeBaseSha`.
 * Nothing else in the extension fetches.
 */
export async function fetchBase(model: BranchReviewModel): Promise<void> {
  let baseBranch = model.baseBranch;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
    title: `Fetching origin/${baseBranch}…` }, async () => {
    try {
      await fetchBranch(model.repoRoot, "origin", baseBranch);
    } catch (e) {
      void vscode.window.showErrorMessage(getErrorMessage(e));
    }
  });
  if (model.snapshot.review)
    await model.changeBaseBranch(baseBranch);
  else
    await model.refresh();
}

/**
 * Gets the URIs of both sides of a file's diff; a side is undefined if the file doesn't exist
 * there (Added: no original; Deleted: no modified).
 */
function getDiffUris(model: BranchReviewModel, file: ChangedFile, mergeBaseSha: string)
  : { originalUri: vscode.Uri | undefined, modifiedUri: vscode.Uri | undefined } {
  return {
    originalUri: file.status === "Added"
      ? undefined : getBaseUri(model.repoRoot, mergeBaseSha, file.oldPath ?? file.path),
    modifiedUri: file.status === "Deleted" ? undefined : vscode.Uri.file(model.getFullPath(file.path)),
  };
}
