import { BackgroundRunResult, ClaudeCommand, runClaudeInBackground } from "./claude-cli";
import { addComment, recordSession, Review } from "./review";
import { ReviewStore } from "./store";

/** Parameters of `answerThreadInBackground`. */
export interface BackgroundAnswerRequest {
  store: ReviewStore;
  branch: string;
  threadId: string;
  claude: ClaudeCommand;
  /** Arguments from buildClaudeArgs (runMode 'background', with `newSessionId`) */
  args: string[];
  cwd: string;
  /** The id passed as `--session-id`; recorded as a follow-up session before Claude starts */
  newSessionId: string;
  /** Author name for the fallback comment, e.g. "Claude" */
  agentName: string;
  onLine: (line: string) => void;
}

/** What `answerThreadInBackground` reports about Claude's run. */
export interface BackgroundAnswer extends BackgroundRunResult {
  /** True if the agent didn't reply via review_reply, so its final message was posted for it */
  isFallbackPosted: boolean;
}

/**
 * Runs Claude Code without a UI to answer a thread. If Claude doesn't answer by calling
 * review_reply, its final message (or an error note) is posted to the thread as its reply.
 */
export async function answerThreadInBackground(request: BackgroundAnswerRequest): Promise<BackgroundAnswer> {
  let { store, branch, threadId } = request;
  let startedAt = new Date().toISOString();
  await recordFollowupSession(store, branch, request.newSessionId, request.cwd);
  let result = await runClaudeInBackground(request.claude, request.args, request.cwd, request.onLine);
  let isFallbackPosted = false;
  await store.updateReview(branch, review => {
    let thread = review?.threads.find(t => t.id === threadId);
    let hasAgentReplied = thread?.comments.some(c => c.author.kind === "agent" && c.createdAt >= startedAt);
    if (review && thread && !hasAgentReplied) {
      let body = result.resultText ?? `(Claude exited with code ${result.exitCode} without answering.)`;
      addComment(review, thread, { kind: "agent", name: request.agentName }, body,
        result.sessionId ?? request.newSessionId);
      isFallbackPosted = true;
    }
    return isFallbackPosted ? review : undefined;
  });
  return { ...result, isFallbackPosted };
}

/** Records a follow-up session in a branch's review (e.g. before starting an interactive one). */
export async function recordFollowupSession(store: ReviewStore, branch: string, sessionId: string, cwd: string)
  : Promise<Review | undefined> {
  return await store.updateReview(branch, review => {
    if (review)
      recordSession(review, sessionId, cwd, "followup");
    return review;
  });
}
