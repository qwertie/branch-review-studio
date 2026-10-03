import * as path from "node:path";
import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import { ChangedFile, fetchBranch } from "../core/git";
import { ArrangedGroup } from "../core/groups";
import { getBaseUri, getGroupViewUri } from "./base-content";
import { BranchReviewModel } from "./model";

/** Opens all changed files in VS Code's multi-diff editor ("changes" editor). */
export async function openAllChanges(model: BranchReviewModel): Promise<void> {
  let { mergeBase, changedFiles, branch } = model.snapshot;
  await openMultiDiff(model, `${branch ?? "HEAD"} vs ${mergeBase?.baseRef}`, changedFiles.map(file => ({ file })));
}

/**
 * Opens a group's changed files in a multi-diff editor titled with the group's name; files of which
 * the group shows only part (see ArrangedFile.isPartial) show the group's view.
 */
export async function openGroupChanges(model: BranchReviewModel, group: ArrangedGroup): Promise<void> {
  let views = group.files.flatMap(f => model.snapshot.changedFiles.filter(c => c.path === f.path)
    .map(file => ({ file, viewGroupId: f.isPartial ? group.id : undefined })));
  await openMultiDiff(model, group.name, views);
}

/**
 * Opens a diff editor showing a file at the merge-base vs. the working tree, or, with `view`, the
 * group's view of the file (see buildGroupViewText).
 */
export async function openFileDiff(model: BranchReviewModel, filePath: string, selection?: vscode.Range,
  view?: { groupId: string, groupName: string }): Promise<void> {
  let { mergeBase, changedFiles } = model.snapshot;
  let file: ChangedFile = changedFiles.find(f => f.path === filePath) ?? { path: filePath, status: "Modified" };
  if (mergeBase === undefined) {
    await vscode.window.showTextDocument(vscode.Uri.file(model.getFullPath(filePath)), { selection });
  } else {
    let { originalUri, modifiedUri } = getDiffUris(model, file, mergeBase.mergeBaseSha, view?.groupId);
    let title = `${path.posix.basename(filePath)} (${view?.groupName ?? `${mergeBase.baseRef} ↔ Working Tree`})`;
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

/** Opens files' diffs (or groups' views of them) in a multi-diff editor. */
async function openMultiDiff(model: BranchReviewModel, title: string,
  views: { file: ChangedFile, viewGroupId?: string }[]): Promise<void> {
  let { mergeBase } = model.snapshot;
  if (mergeBase === undefined) {
    void vscode.window.showErrorMessage(model.snapshot.mergeBaseError ?? "The merge-base is unknown.");
  } else if (views.length === 0) {
    void vscode.window.showInformationMessage("No files changed since the merge-base.");
  } else {
    let resources = views.map(({ file, viewGroupId }) => {
      let { originalUri, modifiedUri } = getDiffUris(model, file, mergeBase.mergeBaseSha, viewGroupId);
      return [vscode.Uri.file(model.getFullPath(file.path)), originalUri, modifiedUri];
    });
    await vscode.commands.executeCommand("vscode.changes", title, resources);
  }
}

/**
 * Gets the URIs of both sides of a file's diff, or of group `viewGroupId`'s view of it; a side is
 * undefined if the file doesn't exist there (Added: no original; Deleted: no modified).
 */
function getDiffUris(model: BranchReviewModel, file: ChangedFile, mergeBaseSha: string, viewGroupId?: string)
  : { originalUri: vscode.Uri | undefined, modifiedUri: vscode.Uri | undefined } {
  return {
    originalUri: viewGroupId !== undefined ? getGroupViewUri(model.repoRoot, file.path, viewGroupId)
      : file.status === "Added" ? undefined : getBaseUri(model.repoRoot, mergeBaseSha, file.oldPath ?? file.path),
    modifiedUri: file.status === "Deleted" ? undefined : vscode.Uri.file(model.getFullPath(file.path)),
  };
}
