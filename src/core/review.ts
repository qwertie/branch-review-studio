import { randomBytes } from "node:crypto";

/**
 * The review of one branch: comment threads on files in the branch's working tree, plus the
 * Claude Code sessions that wrote them. Persisted as JSON by ReviewStore.
 */
export interface Review {
  schemaVersion: number;
  branch: string;
  /** Ref that the review compares against, e.g. `origin/develop` */
  baseBranch: string;
  /** Commit that the review compared against when it was last begun (see MergeBaseInfo) */
  mergeBaseSha: string;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp, set by ReviewStore on every write */
  updatedAt: string;
  /** Overall review summary in markdown, written by the reviewing agent */
  summary?: string;
  sessions: ReviewSession[];
  threads: ReviewThread[];
}

/** A Claude Code session that contributed to a review. */
export interface ReviewSession {
  sessionId: string;
  /** Project folder the session ran in; `claude --resume` looks up sessions per project folder */
  cwd: string;
  /** 'review' = the session that produced the review; 'followup' = a session answering a thread */
  role: SessionRole;
  createdAt: string;
}

export type SessionRole = "review" | "followup";
export type Severity = "Critical" | "Major" | "Minor" | "Note";
export const severities: readonly Severity[] = ["Critical", "Major", "Minor", "Note"];
export type ThreadStatus = "open" | "resolved";
/** 'modified' = working-tree file; 'base' = file content at the merge-base */
export type DiffSide = "modified" | "base";

export interface ReviewThread {
  id: string;
  /** Repo-relative path with forward slashes */
  file: string;
  side: DiffSide;
  anchor: Anchor;
  severity?: Severity;
  status: ThreadStatus;
  comments: ReviewComment[];
}

/**
 * Location of a thread, plus enough surrounding text for `locateAnchor` to find the location
 * again after the file is edited. Line numbers are 1-based and inclusive.
 */
export interface Anchor {
  startLine: number;
  endLine: number;
  /** Text of `startLine` when the thread was created */
  lineText: string;
  /** Up to 3 lines immediately above `startLine` */
  contextBefore: string[];
  /** Up to 3 lines immediately below `endLine` */
  contextAfter: string[];
}

export interface ReviewComment {
  id: string;
  author: Author;
  /** Markdown */
  body: string;
  createdAt: string;
  /** Claude Code session that wrote the comment, if an agent wrote it */
  sessionId?: string;
}

export interface Author {
  kind: "agent" | "user";
  name: string;
}

export const reviewSchemaVersion = 1;

/** Creates an empty review. */
export function createReview(branch: string, baseBranch: string, mergeBaseSha: string): Review {
  let now = new Date().toISOString();
  return { schemaVersion: reviewSchemaVersion, branch, baseBranch, mergeBaseSha, createdAt: now, updatedAt: now,
    sessions: [], threads: [] };
}

/** Parameters of `addThread`. */
export interface NewThread {
  file: string;
  side: DiffSide;
  anchor: Anchor;
  severity?: Severity;
  author: Author;
  body: string;
  sessionId?: string;
}

/** Adds an open thread with one comment to `review` (in place) and returns the thread. */
export function addThread(review: Review, init: NewThread): ReviewThread {
  let thread: ReviewThread = { id: createUniqueId(review), file: init.file, side: init.side, anchor: init.anchor,
    severity: init.severity, status: "open", comments: [] };
  review.threads.push(thread);
  addComment(review, thread, init.author, init.body, init.sessionId);
  return thread;
}

/** Appends a comment to `thread` (in place) and returns the comment. */
export function addComment(review: Review, thread: ReviewThread, author: Author, body: string, sessionId?: string)
  : ReviewComment {
  let comment: ReviewComment = { id: createUniqueId(review), author, body, createdAt: new Date().toISOString() };
  if (sessionId)
    comment.sessionId = sessionId;
  thread.comments.push(comment);
  return comment;
}

/** Finds a thread by id, throwing an error that names the id if it is missing. */
export function getThread(review: Review, threadId: string): ReviewThread {
  let thread = review.threads.find(t => t.id === threadId);
  if (thread === undefined)
    throw new Error(`Thread '${threadId}' was not found in the review of branch '${review.branch}'.`);
  return thread;
}

/** Adds a session to `review.sessions` (in place) unless a session with the same id is already there. */
export function recordSession(review: Review, sessionId: string, cwd: string, role: SessionRole): void {
  if (!review.sessions.some(s => s.sessionId === sessionId))
    review.sessions.push({ sessionId, cwd, role, createdAt: new Date().toISOString() });
}

/** Gets the most recent session with the given role, if any. */
export function findLatestSession(review: Review, role: SessionRole): ReviewSession | undefined {
  return review.sessions.findLast(s => s.role === role);
}

/** Gets the name shown on a comment, e.g. "Claude (Major)" for the agent comment that opened a thread. */
export function getAuthorLabel(thread: ReviewThread, comment: ReviewComment): string {
  let isOpeningAgentComment = comment.author.kind === "agent" && thread.comments[0] === comment;
  return isOpeningAgentComment && thread.severity ? `${comment.author.name} (${thread.severity})` : comment.author.name;
}

/** Creates an 8-hex-digit id not used by any thread or comment in `review`. */
function createUniqueId(review: Review): string {
  let usedIds = new Set(review.threads.flatMap(t => [t.id, ...t.comments.map(c => c.id)]));
  let id: string;
  do {
    id = randomBytes(4).toString("hex");
  } while (usedIds.has(id));
  return id;
}
