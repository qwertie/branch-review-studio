import { randomBytes } from "node:crypto";

/**
 * The review of one branch: comment threads on files in the branch's working tree, plus the
 * agent sessions that wrote them. Persisted as JSON by ReviewStore.
 */
export interface Review {
  /** Format version of the JSON file (see reviewSchemaVersion) */
  schemaVersion: number;
  /** Short name of the reviewed branch; ReviewStore keeps one review per branch */
  branch: string;
  /**
   * Name of the branch that the review compares against, without `origin/`, e.g. `develop`
   * (findMergeBase uses `origin/develop` if it exists)
   */
  baseBranch: string;
  /**
   * Merge-base commit found by the latest `review_begin` call or Change Base Branch command (or
   * when the extension created the review); the MCP tools read base-side files at this commit
   */
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

/** An agent session (Claude Code session or Codex thread) that contributed to a review. */
export interface ReviewSession {
  /** Claude Code session id, or Codex thread id */
  sessionId: string;
  /** Agent that ran the session; only that agent can fork it */
  agent: AgentKind;
  /** Project folder the session ran in; `claude --resume` looks up sessions per project folder */
  cwd: string;
  /** 'review' = the session that produced the review; 'followup' = a session answering a thread */
  role: SessionRole;
  createdAt: string;
}

export type SessionRole = "review" | "followup";
/** The agents that Branch Review Studio can run: Claude Code and OpenAI Codex. */
export type AgentKind = "claude" | "codex";
/** Severities that an agent can give a finding, most severe first. */
export const severities = ["Critical", "Major", "Minor", "Note"] as const;
export type Severity = typeof severities[number];
export type ThreadStatus = "open" | "resolved";
/** 'modified' = working-tree file; 'base' = file content at the merge-base */
export type DiffSide = "modified" | "base";

/** A conversation about a line range of one file, on one side of the diff. */
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

/** One message in a ReviewThread. */
export interface ReviewComment {
  id: string;
  author: Author;
  /** Markdown */
  body: string;
  createdAt: string;
  /** Agent session that wrote the comment, if an agent wrote it */
  sessionId?: string;
}

/** Who wrote a comment. */
export interface Author {
  kind: "agent" | "user";
  /** Display name: the agent's name (e.g. "Claude") or the user's git user.name */
  name: string;
}

/** Version of the review JSON format that this code writes; ReviewStore refuses newer files. */
export const reviewSchemaVersion = 1;

/** Creates an empty review. */
export function createReview(branch: string, baseBranch: string, mergeBaseSha: string): Review {
  let now = new Date().toISOString();
  return { schemaVersion: reviewSchemaVersion, branch, baseBranch: getBaseBranchName(baseBranch), mergeBaseSha,
    createdAt: now, updatedAt: now, sessions: [], threads: [] };
}

/** Gets the form of a base branch name stored in Review.baseBranch: without a leading `origin/`. */
export function getBaseBranchName(baseBranch: string): string {
  return baseBranch.replace(/^origin\//, "");
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

/** Adds a session to `review.sessions` (in place) unless a session with that id is there. */
export function recordSession(review: Review, sessionId: string, cwd: string, role: SessionRole, agent: AgentKind)
  : void {
  if (!review.sessions.some(s => s.sessionId === sessionId))
    review.sessions.push({ sessionId, agent, cwd, role, createdAt: new Date().toISOString() });
}

/** Gets the most recent session with the given role, if any. */
export function findLatestSession(review: Review, role: SessionRole): ReviewSession | undefined {
  return review.sessions.findLast(s => s.role === role);
}

/** Gets the name shown on a comment, e.g. "Claude (Major)" on an agent's thread-opening comment. */
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
