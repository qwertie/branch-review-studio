import * as vscode from "vscode";
import { AnchorLocation, createAnchor } from "../core/anchoring";
import { addComment, addThread, DiffSide, getAuthorLabel, getThread, ReviewThread, ThreadStatus } from "../core/review";
import { baseScheme, getBaseUri, parseBaseUri } from "./base-content";
import { BranchReviewModel, getErrorMessage, ReviewSnapshot } from "./model";

/** Id of the CommentController, which package.json menus test (`commentController == ...`). */
const controllerId = "branch-review-studio";

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
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly model: BranchReviewModel) {
    this.controller.options = { prompt: "Add a review comment", placeHolder: "Markdown is supported" };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => this.isCommentable(document) && document.lineCount > 0
        ? [new vscode.Range(0, 0, document.lineCount - 1, 0)] : [],
    };
    this.subscriptions.push(model.onDidChange(snapshot => this.showThreads(snapshot)));
  }

  /**
   * Saves the user's message as a reply in an existing thread or as the first comment of a new
   * thread, and returns the thread's id (undefined if saving failed).
   */
  async saveMessage(reply: vscode.CommentReply): Promise<string | undefined> {
    return this.threadIds.has(reply.thread) ? await this.reply(reply) : await this.createThread(reply);
  }

  /** Saves a new VS Code thread's first comment as a new review thread; returns its id. */
  async createThread(reply: vscode.CommentReply): Promise<string | undefined> {
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

  /** Gets the review thread id of a VS Code thread; undefined if it isn't saved yet. */
  getThreadId(vscodeThread: vscode.CommentThread): string | undefined {
    return this.threadIds.get(vscodeThread);
  }

  /** Saves a reply in an existing thread; returns the thread's id. */
  async reply(reply: vscode.CommentReply): Promise<string | undefined> {
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

  /** Deletes a thread from the review after asking for confirmation. */
  async deleteThread(vscodeThread: vscode.CommentThread): Promise<void> {
    let threadId = this.threadIds.get(vscodeThread);
    if (threadId === undefined) {
      vscodeThread.dispose();
    } else {
      let choice = await vscode.window.showWarningMessage("Delete this thread and all its comments?",
        { modal: true }, "Delete");
      if (choice === "Delete") {
        await this.saveOrShowError(() => this.model.modifyReview(review => {
          review.threads = review.threads.filter(t => t.id !== threadId);
        }));
      }
    }
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
    vscodeThread.label = [thread.severity ?? "Comment", location.isOutdated ? "outdated" : ""]
      .filter(s => s !== "").join(" · ");
    vscodeThread.state = thread.status === "resolved"
      ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    vscodeThread.contextValue = thread.status === "resolved" ? "brsResolved" : "brsOpen";
    vscodeThread.comments = thread.comments.map(comment => ({
      body: new vscode.MarkdownString(comment.body),
      mode: vscode.CommentMode.Preview,
      author: { name: getAuthorLabel(thread, comment) },
      timestamp: new Date(comment.createdAt),
      contextValue: comment.author.kind,
    }));
  }

  /** Disposes the VS Code thread of a review thread, if it has one. */
  private hideThread(threadId: string): void {
    this.vscodeThreads.get(threadId)?.dispose();
    this.vscodeThreads.delete(threadId);
  }

  /** Gets the URI that a thread is shown on, or undefined if the base side can't be shown. */
  private getThreadUri(thread: ReviewThread, snapshot: ReviewSnapshot): vscode.Uri | undefined {
    if (thread.side === "modified")
      return vscode.Uri.file(this.model.getFullPath(thread.file));
    return snapshot.mergeBase && getBaseUri(this.model.repoRoot, snapshot.mergeBase.mergeBaseSha, thread.file);
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

  /** Allows new threads in the changed files of the current branch, on either side of the diff. */
  private isCommentable(document: vscode.TextDocument): boolean {
    let target = this.getCommentTarget(document.uri);
    return target !== undefined && this.model.snapshot.changedFiles.some(f => f.path === target.file
      || (target.side === "base" && f.oldPath === target.file));
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
