import * as vscode from "vscode";
import { AnchorLocation, createAnchor } from "../core/anchoring";
import { newThreadSendTargetKey, SendTarget } from "../core/ask-agent-defaults";
import { getErrorMessage } from "../core/files";
import { assignChangedProperties } from "../core/objects";
import { addComment, addThread, DiffSide, getAuthorLabel, getThread, ReviewThread, ThreadStatus } from "../core/review";
import { baseScheme, getBaseUri, parseBaseUri } from "./base-content";
import { deleteThreadIfConfirmed } from "./delete-commands";
import { BranchReviewModel, ReviewSnapshot } from "./model";

/** Id of the CommentController, which package.json menus test (`commentController == ...`). */
const controllerId = "branch-review-studio";

/** Name of the setting that says which documents get the "+" (new thread) button */
export const commentButtonSetting = "branchReviewStudio.commentButton";
/**
 * The values of the commentButton setting, default first, with the labels (which match
 * package.json's enumItemLabels) and tooltips of the settings panel's radio buttons.
 */
export const commentButtonOptions = [
  { value: "allFiles", label: "Show on all files", tooltip: "Any file in the repo, changed or not" },
  { value: "openDiffs", label: "Show only on files whose diff is open", tooltip: "Also shows the button in a "
    + "normal editor of a file while the file's diff is open, since both editors show the same document" },
] as const;
export type CommentButtonMode = typeof commentButtonOptions[number]["value"];

/**
 * Shows the review's threads with the VS Code Comments API and saves the user's comments. A
 * thread on the modified side is attached to the real file URI, so it appears both in normal
 * editors and in the modified side of diff editors; a base-side thread is attached to the
 * merge-base document (see getBaseUri).
 */
export class ReviewCommentController implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController(controllerId, "Branch Review");
  /** VS Code threads by review thread id */
  private readonly vscodeThreads = new Map<string, vscode.CommentThread>();
  /** Review thread ids by VS Code thread (only for threads that are saved in the review) */
  private readonly threadIds = new WeakMap<vscode.CommentThread, string>();
  /** The content that each VS Code comment shows, as a JSON key that getVscodeComments compares */
  private readonly commentContents = new WeakMap<vscode.Comment, string>();
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Gets the SendTarget of a thread (undefined = a new thread); see setSendTargetFinder */
  private findSendTarget: (threadId: string | undefined) => SendTarget = () => "ask";
  /**
   * Offers the "+" (new thread) button on every line of the documents that isCommentable accepts.
   * Public for scripts/smoke-test.ts, which records the ranges it returns.
   */
  readonly commentingRangeProvider: vscode.CommentingRangeProvider = {
    provideCommentingRanges: document => this.isCommentable(document) && document.lineCount > 0
      ? [new vscode.Range(0, 0, document.lineCount - 1, 0)] : [],
  };
  /**
   * What isCommentable's answers depended on when commentingRangeProvider was last assigned (the
   * commentButton setting, and the open diffs or the changed files), as JSON
   */
  private commentableDocumentsKey: string | undefined;

  constructor(private readonly model: BranchReviewModel) {
    this.controller.options = { prompt: "Add a review comment", placeHolder: "Markdown is supported" };
    this.updateCommentingRangesIfNeeded();
    this.subscriptions.push(
      model.onDidChange(snapshot => {
        this.showThreads(snapshot);
        this.updateCommentingRangesIfNeeded();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.updateCommentingRangesIfNeeded()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(commentButtonSetting))
          this.updateCommentingRangesIfNeeded();
      }));
  }

  /**
   * Saves the user's message as a reply in an existing thread or as the first comment of a new
   * thread, and returns the thread's id (undefined if saving failed).
   */
  async saveMessage(reply: vscode.CommentReply): Promise<string | undefined> {
    return this.threadIds.has(reply.thread) ? await this.reply(reply) : await this.createThread(reply);
  }

  /** Saves a new VS Code thread's first comment as a new review thread; returns its id. */
  private async createThread(reply: vscode.CommentReply): Promise<string | undefined> {
    let target = this.getCommentTarget(reply.thread.uri);
    if (target) {
      let lines = await this.model.getFileLines(target.file, target.side) ?? [];
      let range = reply.thread.range;
      let anchor = createAnchor(lines, (range?.start.line ?? 0) + 1, (range?.end.line ?? 0) + 1);
      let author = { kind: "user" as const, name: await this.model.getUserName() };
      let threadId: string | undefined;
      let isSaved = await this.saveOrShowError(() => this.model.modifyReview(review => {
        threadId = addThread(review, { file: target.file, side: target.side, anchor, author, body: reply.text }).id;
      }), reply.thread);
      return isSaved ? threadId : undefined;
    }
    return undefined;
  }

  /**
   * Sets the function that gets each thread's SendTarget, and applies it: a thread's `contextValue`
   * ends with its SendTarget, and the context key newThreadSendTargetKey holds that of new threads,
   * so that package.json's comment menu shows the matching "Send to <agent>" button.
   */
  setSendTargetFinder(findSendTarget: (threadId: string | undefined) => SendTarget): void {
    this.findSendTarget = findSendTarget;
    void vscode.commands.executeCommand("setContext", newThreadSendTargetKey, findSendTarget(undefined));
    for (let thread of this.model.snapshot.review?.threads ?? []) {
      let vscodeThread = this.vscodeThreads.get(thread.id);
      if (vscodeThread)
        assignChangedProperties(vscodeThread, { contextValue: this.getContextValue(thread) });
    }
  }

  /** Gets the VS Code thread of a review thread, for scripts/smoke-test.ts. */
  getVscodeThread(threadId: string): vscode.CommentThread | undefined {
    return this.vscodeThreads.get(threadId);
  }

  /** Expands a review thread's widget in the editors that show it, e.g. before revealing it. */
  expandThread(threadId: string): void {
    let vscodeThread = this.vscodeThreads.get(threadId);
    if (vscodeThread)
      vscodeThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  /** Gets the review thread id of a VS Code thread; undefined if it isn't saved yet. */
  getThreadId(vscodeThread: vscode.CommentThread): string | undefined {
    return this.threadIds.get(vscodeThread);
  }

  /** Saves a reply in an existing thread; returns the thread's id. */
  private async reply(reply: vscode.CommentReply): Promise<string | undefined> {
    let threadId = this.threadIds.get(reply.thread);
    if (threadId !== undefined) {
      let author = { kind: "user" as const, name: await this.model.getUserName() };
      let isSaved = await this.saveOrShowError(() => this.model.modifyReview(review => {
        addComment(review, getThread(review, threadId), author, reply.text);
      }));
      return isSaved ? threadId : undefined;
    }
    return undefined;
  }

  /** Sets a thread's status to resolved or open. */
  async setThreadStatus(vscodeThread: vscode.CommentThread, status: ThreadStatus): Promise<void> {
    let threadId = this.threadIds.get(vscodeThread);
    if (threadId !== undefined) {
      await this.saveOrShowError(() => this.model.modifyReview(review => {
        getThread(review, threadId).status = status;
      }));
    }
  }

  /** Deletes a thread from the review after asking for confirmation (see deleteThreadIfConfirmed). */
  async deleteThread(vscodeThread: vscode.CommentThread): Promise<void> {
    let threadId = this.threadIds.get(vscodeThread);
    if (threadId === undefined)
      vscodeThread.dispose();
    else
      await deleteThreadIfConfirmed(this.model, threadId);
  }

  dispose(): void {
    for (let subscription of this.subscriptions)
      subscription.dispose();
    this.controller.dispose();
  }

  /** Creates, updates and disposes VS Code threads to match the review in `snapshot`. */
  private showThreads(snapshot: ReviewSnapshot): void {
    let threads = snapshot.review?.threads ?? [];
    let liveIds = new Set(threads.map(t => t.id));
    for (let id of this.vscodeThreads.keys()) {
      if (!liveIds.has(id))
        this.hideThread(id);
    }
    for (let thread of threads) {
      let uri = this.getThreadUri(thread, snapshot);
      let location = snapshot.threadLocations.get(thread.id);
      if (uri !== undefined && location !== undefined)
        this.showThread(thread, uri, location);
      else
        this.hideThread(thread.id);
    }
  }

  private showThread(thread: ReviewThread, uri: vscode.Uri, location: AnchorLocation): void {
    let range = new vscode.Range(location.startLine - 1, 0, location.endLine - 1, 0);
    let vscodeThread = this.vscodeThreads.get(thread.id);
    if (vscodeThread && vscodeThread.uri.toString() !== uri.toString()) {
      vscodeThread.dispose();
      vscodeThread = undefined;
    }
    if (vscodeThread === undefined) {
      vscodeThread = this.controller.createCommentThread(uri, range, []);
      vscodeThread.collapsibleState = thread.status === "open"
        ? vscode.CommentThreadCollapsibleState.Expanded : vscode.CommentThreadCollapsibleState.Collapsed;
      this.vscodeThreads.set(thread.id, vscodeThread);
      this.threadIds.set(vscodeThread, thread.id);
    } else if (!vscodeThread.range?.isEqual(range)) {
      vscodeThread.range = range;
    }
    vscodeThread.canReply = true;
    // model.refresh shows the threads again even if nothing changed
    assignChangedProperties(vscodeThread, {
      label: [thread.severity ?? "Comment", location.isOutdated ? "outdated" : ""].filter(s => s !== "").join(" · "),
      state: thread.status === "resolved" ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved,
      contextValue: this.getContextValue(thread),
      comments: this.getVscodeComments(thread, vscodeThread.comments),
    });
  }

  /**
   * Converts a thread's comments to VS Code comments, reusing those in `shownComments` (the
   * comments its VS Code thread has now) that show the same content. VS Code tells comments apart
   * by object identity: it replaces the widget of each new comment object, and the new widget of a
   * long comment (whose height is capped) lacks a scrollbar until something resizes the editor.
   */
  private getVscodeComments(thread: ReviewThread, shownComments: readonly vscode.Comment[]): vscode.Comment[] {
    let shownByContent = new Map(shownComments.map(c => [this.commentContents.get(c), c]));
    return thread.comments.map(comment => {
      let author = getAuthorLabel(thread, comment);
      let content = JSON.stringify([comment.id, comment.body, author, comment.createdAt, comment.author.kind]);
      let vscodeComment = shownByContent.get(content);
      if (vscodeComment === undefined) {
        vscodeComment = {
          body: new vscode.MarkdownString(comment.body),
          mode: vscode.CommentMode.Preview,
          author: { name: author },
          timestamp: new Date(comment.createdAt),
          contextValue: comment.author.kind,
        };
        this.commentContents.set(vscodeComment, content);
      }
      return vscodeComment;
    });
  }

  /**
   * Gets the `contextValue` of a thread, which package.json's menus test: its status and its
   * SendTarget, e.g. "brsOpen.claude".
   */
  private getContextValue(thread: ReviewThread): string {
    return `${thread.status === "resolved" ? "brsResolved" : "brsOpen"}.${this.findSendTarget(thread.id)}`;
  }

  /** Disposes the VS Code thread of a review thread, if it has one. */
  private hideThread(threadId: string): void {
    this.vscodeThreads.get(threadId)?.dispose();
    this.vscodeThreads.delete(threadId);
  }

  /** Gets the URI that a thread is shown on, or undefined if the base side can't be shown. */
  getThreadUri(thread: ReviewThread, snapshot: ReviewSnapshot): vscode.Uri | undefined {
    if (thread.side === "modified")
      return vscode.Uri.file(this.model.getFullPath(thread.file));
    return snapshot.mergeBase && getBaseUri(this.model.repoRoot, snapshot.mergeBase.mergeBaseSha, thread.file);
  }

  /**
   * Assigns commentingRangeProvider to the controller if the set of documents that isCommentable
   * accepts may differ from the last time, because VS Code asks for the commenting ranges of open
   * editors again only when the provider is assigned.
   */
  private updateCommentingRangesIfNeeded(): void {
    let mode = this.readCommentButtonMode();
    let key = JSON.stringify([mode, mode === "openDiffs" ? [...getOpenDiffUris()].sort()
      : this.model.snapshot.changedFiles.map(f => [f.path, f.oldPath])]);
    if (key !== this.commentableDocumentsKey) {
      this.commentableDocumentsKey = key;
      this.controller.commentingRangeProvider = this.commentingRangeProvider;
    }
  }

  /** Reads the commentButton setting of the repo's folder. */
  private readCommentButtonMode(): CommentButtonMode {
    return readCommentButtonMode(vscode.Uri.file(this.model.repoRoot));
  }

  /** Gets the review file and side of a document, or undefined if it is not in this review. */
  private getCommentTarget(uri: vscode.Uri): { file: string, side: DiffSide } | undefined {
    if (uri.scheme === "file") {
      let file = this.model.getRelativePath(uri.fsPath);
      return file === undefined ? undefined : { file, side: "modified" };
    }
    if (uri.scheme === baseScheme) {
      let { repoRoot, sha, file } = parseBaseUri(uri);
      return repoRoot === this.model.repoRoot && sha !== "" ? { file, side: "base" } : undefined;
    }
    return undefined;
  }

  /**
   * Allows new threads, as the commentButton setting says, in documents of this review: with
   * "openDiffs", in either side of an open diff; else in the repo's files, except `.git` and the
   * files in it (such as the review file), and in the base side of a changed file.
   */
  private isCommentable(document: vscode.TextDocument): boolean {
    let target = this.getCommentTarget(document.uri);
    return target !== undefined && (this.readCommentButtonMode() === "openDiffs"
      ? getOpenDiffUris().has(document.uri.toString())
      : target.side === "modified" ? target.file.split("/")[0] !== ".git"
        : this.model.snapshot.changedFiles.some(f => f.path === target.file || f.oldPath === target.file));
  }

  /**
   * Runs a save action, showing an error message if it fails. On success, disposes `draftThread`
   * (a thread the user started), since showThreads then shows the saved thread. Returns whether
   * the save succeeded.
   */
  private async saveOrShowError(save: () => Promise<void>, draftThread?: vscode.CommentThread): Promise<boolean> {
    try {
      await save();
      draftThread?.dispose();
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`Branch Review Studio could not save the comment: ${getErrorMessage(e)}`);
      return false;
    }
  }
}

/**
 * Reads the commentButton setting (see commentButtonOptions) for a folder, e.g. the repo's; an
 * invalid value counts as the default.
 */
export function readCommentButtonMode(scope: vscode.Uri | undefined): CommentButtonMode {
  let value = vscode.workspace.getConfiguration(undefined, scope).get(commentButtonSetting);
  return commentButtonOptions.find(o => o.value === value)?.value ?? commentButtonOptions[0].value;
}

/**
 * Gets the URIs (as strings) of the documents on either side of the diffs in the open tabs,
 * including the diffs in multi-diff editors such as Open All Changes.
 */
function getOpenDiffUris(): Set<string> {
  let diffs = vscode.window.tabGroups.all.flatMap(group => group.tabs).flatMap(tab => getTextDiffs(tab.input));
  return new Set(diffs.flatMap(diff => [diff.original.toString(), diff.modified.toString()]));

  /**
   * Gets the diffs of a tab. A multi-diff tab's input is a TabInputTextMultiDiff, which VS Code's
   * stable API doesn't declare, so it is recognized by its `textDiffs`.
   */
  function getTextDiffs(input: unknown): vscode.TabInputTextDiff[] {
    if (input instanceof vscode.TabInputTextDiff)
      return [input];
    let textDiffs = typeof input === "object" && input !== null && "textDiffs" in input ? input.textDiffs : [];
    return Array.isArray(textDiffs) ? textDiffs.filter(d => d instanceof vscode.TabInputTextDiff) : [];
  }
}
