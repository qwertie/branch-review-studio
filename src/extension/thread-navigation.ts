import * as vscode from "vscode";
import { mapBaseLineToWorkingTree, readDiffHunks } from "../core/hunks";
import { truncateText } from "../core/markdown-subset";
import {
  findAdjacentThread, getViewGroupId, listThreadVisits, ThreadPosition, ThreadVisit,
} from "../core/review-outline";
import { getThreadText } from "../core/review-view-html";
import { baseScheme, getReviewFileOfUri } from "./base-content";
import { ReviewCommentController } from "./comments";
import { revealThread } from "./diff-commands";
import { BranchReviewModel } from "./model";

/** Context key that package.json's editor/title menu tests to show the thread navigation buttons */
const hasThreadsContextKey = "branchReviewStudio.hasThreads";

/**
 * Reveals threads (see revealThread) for the Branch Review view and the thread navigation commands
 * (Previous/Next Thread, Previous/Next Unresolved Thread, Go to Thread…), and remembers the last
 * thread revealed, from which navigation continues when the active editor isn't showing a review
 * file. Navigation follows the order of listThreadVisits.
 */
export class ThreadNavigator implements vscode.Disposable {
  private lastThreadId: string | undefined;
  private hasThreads: boolean | undefined;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: BranchReviewModel, private readonly comments: ReviewCommentController) {
    this.subscription = model.onDidChange(snapshot => {
      let hasThreads = (snapshot.review?.threads.length ?? 0) > 0;
      if (hasThreads !== this.hasThreads)
        void vscode.commands.executeCommand("setContext", hasThreadsContextKey, hasThreads);
      this.hasThreads = hasThreads;
    });
  }

  /**
   * Reveals a thread; for a thread on the modified side, `viewGroupId` (if given) chooses that
   * group's view of the file.
   */
  async revealThread(threadId: string, viewGroupId?: string): Promise<void> {
    this.lastThreadId = threadId;
    await revealThread(this.model, this.comments, threadId, viewGroupId);
  }

  /**
   * Reveals the thread after (`direction` 1) or before (-1) the cursor in the active editor, if it
   * shows a review file, else the last thread revealed. Shows a status bar message if it wraps
   * around.
   */
  async revealAdjacentThread(direction: 1 | -1, isUnresolvedOnly: boolean): Promise<void> {
    let result = findAdjacentThread(this.model.snapshot.outline, await this.getPosition(), direction,
      isUnresolvedOnly);
    let kind = isUnresolvedOnly ? "unresolved thread" : "thread";
    if (result === undefined) {
      void vscode.window.showInformationMessage(`This branch's review has no ${kind}s.`);
    } else {
      if (result.isWrapped)
        vscode.window.setStatusBarMessage(`Branch Review: wrapped around to the ${direction === 1 ? "first" : "last"} `
          + kind, 4000);
      await this.revealVisit(result.visit);
    }
  }

  /** Lets the user pick a thread from a QuickPick, in navigation order, and reveals it. */
  async pickThread(): Promise<void> {
    let items = listThreadVisits(this.model.snapshot.outline).map(visit => {
      let { thread, line, location } = visit.thread;
      let details = [thread.severity, thread.status, `L${line}`, thread.side === "base" ? "base" : undefined,
        location?.isOutdated ? "outdated" : undefined];
      return { visit, label: disableIcons(`${visit.file.path}: ${truncateText(getThreadText(visit.thread), 80)}`),
        description: details.filter(d => d !== undefined).join(" · ") };
    });
    if (items.length === 0) {
      void vscode.window.showInformationMessage("This branch's review has no threads.");
    } else {
      let quickPick = vscode.window.createQuickPick<typeof items[number]>();
      quickPick.items = items;
      quickPick.placeholder = "Go to a review thread (type to filter by file or text)";
      quickPick.matchOnDescription = true;
      quickPick.activeItems = items.filter(i => i.visit.thread.thread.id === this.lastThreadId);
      let picked = await new Promise<typeof items[number] | undefined>(resolve => {
        quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
        quickPick.onDidHide(() => resolve(undefined));
        quickPick.show();
      });
      quickPick.dispose();
      if (picked)
        await this.revealVisit(picked.visit);
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private revealVisit(visit: ThreadVisit): Promise<void> {
    return this.revealThread(visit.thread.thread.id, getViewGroupId(visit.section, visit.file));
  }

  /**
   * Gets the position from which to navigate: the cursor (see getCursorPosition), else the last
   * thread revealed. If the cursor is at the start of the last thread revealed, the position is
   * that thread, which tells it apart from other threads that start on the same line.
   */
  private async getPosition(): Promise<ThreadPosition | undefined> {
    let lastVisit = listThreadVisits(this.model.snapshot.outline).find(v => v.thread.thread.id === this.lastThreadId);
    let cursor = await this.getCursorPosition();
    let isAtLastThread = cursor?.file === lastVisit?.file.path && cursor?.line === lastVisit?.thread.position;
    return cursor && !isAtLastThread ? cursor : lastVisit && { threadId: lastVisit.thread.thread.id };
  }

  /**
   * Gets the file and the line (in working-tree numbering) of the cursor, if the active editor (a
   * normal editor, either side of a diff, or an entry of a multi-diff editor) shows a review file.
   */
  private async getCursorPosition(): Promise<{ file: string, line: number } | undefined> {
    let { outline, mergeBase } = this.model.snapshot;
    let editor = vscode.window.activeTextEditor;
    let path = editor && getReviewFileOfUri(this.model, editor.document.uri);
    let file = outline.sections.flatMap(s => s.files).find(f => f.path === path);
    let position: { file: string, line: number } | undefined;
    if (editor && file) {
      // The base side of an added file is empty. A line on the left side of a group's view is used
      // as is, although that side lacks the group's own changes.
      let baseChange = editor.document.uri.scheme === baseScheme && file.change?.status !== "Added"
        ? file.change : undefined;
      let line = editor.selection.active.line + 1;
      position = { file: file.path, line: baseChange && mergeBase ? mapBaseLineToWorkingTree(
        await readDiffHunks(this.model.repoRoot, mergeBase.mergeBaseSha, baseChange), line) : line };
    }
    return position;
  }
}

/** Changes text so that a QuickPick shows `$(name)` in it as text rather than as an icon. */
function disableIcons(text: string): string {
  return text.replaceAll("$(", "$\u200b(");
}
