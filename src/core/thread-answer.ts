import { AgentCommand, AgentIntegration, BackgroundRunResult, runAgentInBackground } from "./agent-integration";
import { addComment, AgentKind, recordSession, Review } from "./review";
import { ReviewStore } from "./store";

/** Parameters of `answerThreadInBackground`. */
export interface BackgroundAnswerRequest {
  store: ReviewStore;
  branch: string;
  threadId: string;
  agent: AgentIntegration;
  command: AgentCommand;
  /** Arguments from `agent.buildArgs` (runMode 'background') */
  args: string[];
  cwd: string;
  /**
   * The new session's preassigned id (see AgentIntegration.canPreassignSessionId), which is
   * recorded as a follow-up session before the agent starts; otherwise the session id that the
   * agent reports is recorded when it finishes
   */
  newSessionId?: string;
  onLine: (line: string) => void;
}

/** What `answerThreadInBackground` reports about the agent's run. */
export interface BackgroundAnswer extends BackgroundRunResult {
  /** True if the agent didn't reply via review_reply, so its final message was posted for it */
  isFallbackPosted: boolean;
}

/**
 * Runs an agent without a UI to answer a thread. If the agent doesn't answer by calling
 * review_reply, its final message (or an error note) is posted to the thread as its reply.
 */
export async function answerThreadInBackground(request: BackgroundAnswerRequest): Promise<BackgroundAnswer> {
  let { store, branch, threadId, agent } = request;
  let startedAt = new Date().toISOString();
  if (request.newSessionId)
    await recordFollowupSession(store, branch, request.newSessionId, request.cwd, agent.agent);
  let result = await runAgentInBackground(request.command, request.args, request.cwd, agent.parseOutputLine,
    request.onLine);
  let sessionId = result.sessionId ?? request.newSessionId;
  let isFallbackPosted = false;
  await store.updateReview(branch, review => {
    let thread = review?.threads.find(t => t.id === threadId);
    let hasAgentReplied = thread?.comments.some(c => c.author.kind === "agent" && c.createdAt >= startedAt);
    let oldSessionCount = review?.sessions.length;
    if (review && sessionId)
      recordSession(review, sessionId, request.cwd, "followup", agent.agent);
    if (review && thread && !hasAgentReplied) {
      let errorText = result.errorMessage ? `\n\nError: ${result.errorMessage}` : "";
      let body = result.resultText
        ?? `(${agent.displayName} exited with code ${result.exitCode} without answering.)${errorText}`;
      addComment(review, thread, { kind: "agent", name: agent.authorName }, body, sessionId);
      isFallbackPosted = true;
    }
    return isFallbackPosted || review?.sessions.length !== oldSessionCount ? review : undefined;
  });
  return { ...result, isFallbackPosted };
}

/** Records a follow-up session in a branch's review (e.g. before starting an interactive one). */
export async function recordFollowupSession(store: ReviewStore, branch: string, sessionId: string, cwd: string,
  agent: AgentKind): Promise<Review | undefined> {
  return await store.updateReview(branch, review => {
    if (review)
      recordSession(review, sessionId, cwd, "followup", agent);
    return review;
  });
}
