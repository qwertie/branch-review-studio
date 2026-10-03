import * as path from "node:path";
import { createAnchor, locateAnchor } from "../core/anchoring";
import { readFileLines } from "../core/files";
import { findMergeBase, findRepoRoot, getCurrentBranch, getGitCommonDir } from "../core/git";
import {
  addComment, addThread, createReview, DiffSide, getThread, recordSession, Review, ReviewThread, Severity,
  ThreadStatus,
} from "../core/review";
import { ReviewStore } from "../core/store";

/** Who is calling the tools; `cwd` is the Claude Code session's project folder. */
export interface ToolCaller {
  cwd: string;
  /** Claude Code session id (CLAUDE_CODE_SESSION_ID), if known */
  sessionId: string | undefined;
  /** Author name shown on the caller's comments, e.g. "Claude" */
  agentName: string;
}

/** Arguments of review_comment. */
export interface NewCommentArgs {
  file: string;
  line: number;
  endLine?: number;
  side?: DiffSide;
  severity: Severity;
  body: string;
}

/** The repo, branch and store that a tool call applies to. */
interface ReviewTarget {
  repoRoot: string;
  branch: string;
  store: ReviewStore;
}

/**
 * Implements the MCP tools (see server.ts) that let an agent write the review of the branch checked
 * out in the agent's project folder. Every method returns the text that the tool returns.
 */
export class ReviewTools {
  constructor(private readonly caller: ToolCaller) {}

  /** Creates or updates the branch's review and records the caller as the reviewing session. */
  async beginReview(args: { summary?: string, baseBranch?: string }): Promise<string> {
    let target = await this.findTarget();
    let review = await this.beginReviewCore(target, args);
    let openThreads = review.threads.filter(t => t.status === "open");
    return [
      `Review of branch '${target.branch}' vs ${review.baseBranch} (merge-base ${review.mergeBaseSha}) is ready.`,
      `The reviewed changes are the working tree (including uncommitted and untracked files) vs the merge-base: `
        + `\`git diff ${review.mergeBaseSha}\` plus \`git ls-files --others --exclude-standard\`. `
        + "Line numbers in review_comment refer to working-tree files (side 'modified').",
      openThreads.length === 0
        ? "There are no open threads yet."
        : "Open threads already exist; don't post duplicates of these:\n"
          + (await this.formatThreads(target, review, openThreads, false)),
    ].join("\n\n");
  }

  /** Adds a thread with one comment on a line range of a file. */
  async addReviewComment(args: NewCommentArgs): Promise<string> {
    let target = await this.findTarget();
    let review = await target.store.readReview(target.branch) ?? await this.beginReviewCore(target, {});
    let file = this.getRepoRelativePath(target.repoRoot, args.file);
    let side = args.side ?? "modified";
    let lines = await readFileLines(target.repoRoot, file, side, review.mergeBaseSha);
    if (lines === undefined)
      throw new Error(`File '${file}' does not exist ${side === "base" ? "at the merge-base" : "in the working tree"}`
        + ".");
    let endLine = args.endLine ?? args.line;
    if (args.line < 1 || endLine < args.line || endLine > lines.length)
      throw new Error(`Lines ${args.line}-${endLine} are out of range; '${file}' has ${lines.length} lines.`);
    let anchor = createAnchor(lines, args.line, endLine);
    let threadId = "";
    await this.modifyReview(target, review => {
      this.recordCaller(review, "review");
      threadId = addThread(review, { file, side, anchor, severity: args.severity, body: args.body,
        author: { kind: "agent", name: this.caller.agentName }, sessionId: this.caller.sessionId }).id;
    });
    return `Created thread ${threadId} on ${file}:${args.line}.`;
  }

  /** Adds the caller's reply to a thread. */
  async replyToThread(args: { threadId: string, body: string }): Promise<string> {
    await this.modifyThread(args.threadId, (review, thread) => this.addAgentComment(review, thread, args.body));
    return `Replied to thread ${args.threadId}.`;
  }

  /** Marks a thread resolved, optionally adding a closing comment. */
  async resolveThread(args: { threadId: string, note?: string }): Promise<string> {
    await this.modifyThread(args.threadId, (review, thread) => {
      if (args.note)
        this.addAgentComment(review, thread, args.note);
      thread.status = "resolved";
    });
    return `Resolved thread ${args.threadId}.`;
  }

  /** Lists threads with all their comments. */
  async listThreads(args: { status?: ThreadStatus | "all" }): Promise<string> {
    let target = await this.findTarget();
    let review = await target.store.readReview(target.branch);
    let status = args.status ?? "open";
    let threads = review?.threads.filter(t => status === "all" || t.status === status) ?? [];
    if (review === undefined || threads.length === 0)
      return review === undefined ? `Branch '${target.branch}' has no review.` : `There are no ${status} threads.`;
    let summary = review.summary ? `Review summary:\n${review.summary}\n\n` : "";
    return summary + (await this.formatThreads(target, review, threads, true));
  }

  /** Saves the review summary. */
  async finishReview(args: { summary: string }): Promise<string> {
    let target = await this.findTarget();
    let review = await this.modifyReview(target, review => {
      review.summary = args.summary;
      this.recordCaller(review, "review");
    });
    let openCount = review.threads.filter(t => t.status === "open").length;
    return `Saved the summary of the review of '${target.branch}', which has ${openCount} open threads.`;
  }

  /**
   * Creates the branch's review, or updates its merge-base, and records the caller as the reviewing
   * session. Existing threads are kept, so that re-running a review converges.
   */
  private async beginReviewCore(target: ReviewTarget, args: { summary?: string, baseBranch?: string })
    : Promise<Review> {
    let mergeBase = await findMergeBase(target.repoRoot, args.baseBranch || "develop");
    let saved = await target.store.updateReview(target.branch, review => {
      review ??= createReview(target.branch, mergeBase.baseRef, mergeBase.mergeBaseSha);
      review.baseBranch = mergeBase.baseRef;
      review.mergeBaseSha = mergeBase.mergeBaseSha;
      if (args.summary)
        review.summary = args.summary;
      this.recordCaller(review, "review");
      return review;
    });
    return saved!;
  }

  private async findTarget(): Promise<ReviewTarget> {
    let repoRoot = await findRepoRoot(this.caller.cwd);
    let branch = repoRoot && await getCurrentBranch(repoRoot);
    if (repoRoot === undefined || branch === undefined)
      throw new Error(`The MCP server's folder (${this.caller.cwd}) is not in a git repo with a branch checked out.`);
    return { repoRoot, branch, store: new ReviewStore(await getGitCommonDir(repoRoot)) };
  }

  /** Modifies the branch's review in place via ReviewStore.updateReview; throws if none. */
  private async modifyReview(target: ReviewTarget, mutate: (review: Review) => void): Promise<Review> {
    let saved = await target.store.updateReview(target.branch, review => {
      if (review)
        mutate(review);
      return review;
    });
    if (saved === undefined)
      throw new Error(`Branch '${target.branch}' has no review; call review_begin first.`);
    return saved;
  }

  private async modifyThread(threadId: string, mutate: (review: Review, thread: ReviewThread) => void)
    : Promise<void> {
    let target = await this.findTarget();
    await this.modifyReview(target, review => mutate(review, getThread(review, threadId)));
  }

  private addAgentComment(review: Review, thread: ReviewThread, body: string): void {
    this.recordCaller(review, "followup");
    addComment(review, thread, { kind: "agent", name: this.caller.agentName }, body, this.caller.sessionId);
  }

  /** Records the caller's session if new, since `claude --resume` needs its id and cwd. */
  private recordCaller(review: Review, role: "review" | "followup"): void {
    if (this.caller.sessionId)
      recordSession(review, this.caller.sessionId, this.caller.cwd, role);
  }

  /** Converts an absolute or relative path (either slash style) to a repo-relative '/' path. */
  private getRepoRelativePath(repoRoot: string, file: string): string {
    let relativePath = path.relative(repoRoot, path.resolve(repoRoot, file));
    if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath))
      throw new Error(`'${file}' is not inside the repo ${repoRoot}.`);
    return relativePath.split(path.sep).join("/");
  }

  /** Formats threads as a markdown list, with all comments if `includeComments`. */
  private async formatThreads(target: ReviewTarget, review: Review, threads: ReviewThread[],
    includeComments: boolean): Promise<string> {
    let entries: string[] = [];
    for (let thread of threads) {
      let lines = await readFileLines(target.repoRoot, thread.file, thread.side, review.mergeBaseSha);
      let location = locateAnchor(lines ?? [], thread.anchor);
      let header = `- Thread ${thread.id}: ${thread.file}:${location.startLine}`
        + (thread.side === "base" ? " (base side)" : "") + (location.isOutdated ? " (outdated)" : "")
        + ` [${thread.severity ?? "comment"}, ${thread.status}]`;
      let comments = includeComments ? thread.comments : thread.comments.slice(0, 1);
      entries.push(header + "\n" + comments.map(c => `  - ${c.author.name}: ${indent(c.body)}`).join("\n"));
    }
    return entries.join("\n");
  }
}


/** Indents continuation lines of a comment body so that it stays inside its list item. */
function indent(body: string): string {
  return body.replace(/\r?\n/g, "\n    ");
}
