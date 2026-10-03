import * as path from "node:path";
import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import { ChangedFile, fetchBranch } from "../core/git";
import { ChangesEntry, listChangesEntries } from "../core/review-outline";
import { getBaseUri, getGroupViewUri, getHeadingUri } from "./base-content";
import { ReviewCommentController } from "./comments";
import { BranchReviewModel } from "./model";

/**
 * Opens all changed files in VS Code's multi-diff editor ("changes" editor), under headings of
 * their groups if the review has groups (see listChangesEntries).
 */
export async function openAllChanges(model: BranchReviewModel): Promise<void> {
  let { mergeBase, branch, outline } = model.snapshot;
  await openMultiDiff(model, `${branch ?? "HEAD"} vs ${mergeBase?.baseRef}`, listChangesEntries(outline),
    "No files changed since the merge-base.");
}

/**
 * Opens a group's heading and changed files in a multi-diff editor titled with the group's heading;
 * files of which the group shows only part (see ArrangedFile.isPartial) show the group's view.
 * `groupId` undefined means the Ungrouped group.
 */
export async function openGroupChanges(model: BranchReviewModel, groupId: string | undefined): Promise<void> {
  let { outline } = model.snapshot;
  let section = outline.sections.find(s => s.group && s.group.id === groupId);
  if (section)
    await openMultiDiff(model, section.title, listChangesEntries(outline, [section]),
      `The group "${section.title}" has no changed files.`);
}

/**
 * Opens a diff editor showing a file at the merge-base vs. the working tree, or, with
 * `viewGroupId`, that group's view of the file (see buildGroupViewText).
 */
export async function openFileDiff(model: BranchReviewModel, filePath: string, selection?: vscode.Range,
  viewGroupId?: string): Promise<void> {
  let { mergeBase, changedFiles, groupLayout } = model.snapshot;
  let groupName = groupLayout?.groups.find(g => g.id !== undefined && g.id === viewGroupId)?.name;
  let file: ChangedFile = changedFiles.find(f => f.path === filePath) ?? { path: filePath, status: "Modified" };
  if (mergeBase === undefined) {
    await vscode.window.showTextDocument(vscode.Uri.file(model.getFullPath(filePath)), { selection });
  } else {
    let { originalUri, modifiedUri } = getDiffUris(model, file, mergeBase.mergeBaseSha,
      groupName === undefined ? undefined : viewGroupId);
    let title = `${path.posix.basename(filePath)} (${groupName ?? `${mergeBase.baseRef} ↔ Working Tree`})`;
    await vscode.commands.executeCommand("vscode.diff", originalUri ?? getBaseUri(model.repoRoot, "", file.path),
      modifiedUri ?? getBaseUri(model.repoRoot, "", file.path), title, { selection, preview: false });
  }
}

/**
 * Opens the diff of a thread's file (for a thread on the modified side, group `viewGroupId`'s view
 * of it, if given), puts the cursor on the thread's first line and focuses the thread's side,
 * expands the thread, and scrolls so that the thread's last line and the thread's widget, which
 * VS Code shows below that line, are visible. Uses the thread's current location (see
 * locateAnchor).
 */
export async function revealThread(model: BranchReviewModel, comments: ReviewCommentController, threadId: string,
  viewGroupId?: string): Promise<void> {
  let { review, threadLocations } = model.snapshot;
  let thread = review?.threads.find(t => t.id === threadId);
  let location = threadLocations.get(threadId);
  if (thread && location) {
    comments.expandThread(threadId);
    let start = new vscode.Position(location.startLine - 1, 0);
    let isModifiedSide = thread.side === "modified";
    await openFileDiff(model, thread.file, isModifiedSide ? new vscode.Range(start, start) : undefined,
      isModifiedSide ? viewGroupId : undefined);
    let uri = comments.getThreadUri(thread, model.snapshot)?.toString();
    let editor = [vscode.window.activeTextEditor, ...vscode.window.visibleTextEditors]
      .find(e => e?.document.uri.toString() === uri);
    if (editor) {
      editor.selection = new vscode.Selection(start, start);
      if (!isModifiedSide)
        await vscode.commands.executeCommand("workbench.action.compareEditor.focusSecondarySide");
      // Revealing the line after the last one includes the widget, which sits between them. If
      // the editor just opened, VS Code adds the widget later and offers no event for that, so the
      // reveal is repeated after a delay found by experiment.
      let reveal = () => editor.revealRange(new vscode.Range(location.endLine - 1, 0, location.endLine, 0),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      reveal();
      setTimeout(reveal, 300);
    }
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
 * Opens a multi-diff editor that shows heading documents and files' diffs (or groups' views of
 * them). Each resource is [label URI, original, modified]; VS Code identifies an entry by its
 * original and modified URIs and ignores the label URI (see listChangesEntries). Shows
 * `noChangesMessage` instead if no entry is a file.
 */
async function openMultiDiff(model: BranchReviewModel, title: string, entries: ChangesEntry[],
  noChangesMessage: string): Promise<void> {
  let { mergeBase } = model.snapshot;
  if (mergeBase === undefined) {
    void vscode.window.showErrorMessage(model.snapshot.mergeBaseError ?? "The merge-base is unknown.");
  } else if (!entries.some(e => e.kind === "file")) {
    void vscode.window.showInformationMessage(noChangesMessage);
  } else {
    let resources = entries.map(entry => {
      if (entry.kind === "heading") {
        let uri = getHeadingUri(entry.fileName, entry.section.group?.id);
        return [uri, undefined, uri];
      }
      let { originalUri, modifiedUri } = getDiffUris(model, entry.change, mergeBase.mergeBaseSha, entry.viewGroupId);
      return [vscode.Uri.file(model.getFullPath(entry.change.path)), originalUri, modifiedUri];
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
