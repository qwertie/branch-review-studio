import { AnchorLocation } from "./anchoring";
import { AgentKind, getAuthorLabel, Review, ReviewThread } from "./review";

/** Name under which the MCP server is registered with agents (`claude mcp add <name>`). */
export const mcpServerName = "branch-review-studio";

/**
 * 'fork' = fork the review session (e.g. `claude --resume <id> --fork-session`); 'fresh' = start a
 * new one
 */
export type AgentSessionMode = "fork" | "fresh";
/** 'interactive' = a VS Code terminal running the agent; 'background' = e.g. `claude -p` (no UI) */
export type AgentRunMode = "interactive" | "background";

/** What `buildThreadPrompt` needs to know about a thread that just got a message from the user. */
export interface ThreadMessageContext {
  review: Review;
  /** The thread; its last comment is the user's new message */
  thread: ReviewThread;
  /** Current lines of the thread's file on the thread's side; undefined if the file is missing */
  fileLines: string[] | undefined;
  /** Where the thread's anchor is in `fileLines` (see locateAnchor) */
  location: AnchorLocation;
}

/** Number of lines shown above and below the thread's lines in the prompt's excerpt. */
const excerptContextLines = 5;

/**
 * Builds the prompt that sends the user's newest thread message to an agent. A forked session
 * already knows the review, so only a fresh session gets the review summary and merge-base.
 */
export function buildThreadPrompt(context: ThreadMessageContext, sessionMode: AgentSessionMode): string {
  let { review, thread, fileLines, location } = context;
  let priorComments = thread.comments.slice(0, -1);
  let newComment = thread.comments[thread.comments.length - 1];
  let sideText = thread.side === "base" ? `the merge-base version (${review.mergeBaseSha})` : "the working tree";
  let lineText = location.startLine === location.endLine
    ? `line ${location.startLine}` : `lines ${location.startLine}-${location.endLine}`;
  let parts: string[] = [];

  if (sessionMode === "fresh") {
    parts.push(`You are helping review branch \`${review.branch}\`. The branch's changes are the working tree `
      + `(including uncommitted and untracked files) compared with its merge-base with ${review.baseBranch}; `
      + `see them with \`git diff ${review.mergeBaseSha}\` plus \`git status\`.`);
    if (review.summary)
      parts.push(`Review summary:\n\n${review.summary}`);
  }

  parts.push(`In Branch Review Studio, ${newComment.author.name} wrote a message in review thread ${thread.id}, `
    + `which is about ${thread.file} ${lineText} in ${sideText}`
    + (location.isOutdated ? " (the thread is outdated: its original line text is no longer there)." : "."));
  parts.push(fileLines === undefined
    ? "The file does not exist in that version."
    : "Current lines:\n\n```\n" + formatExcerpt(fileLines, location) + "\n```");
  if (priorComments.length > 0) {
    parts.push("Earlier messages in the thread:\n\n"
      + priorComments.map(c => `- ${getAuthorLabel(thread, c)}: ${c.body}`).join("\n"));
  }
  parts.push(`New message from ${newComment.author.name}:\n\n${newComment.body}`);
  parts.push(`Answer by calling the \`${mcpServerName}\` MCP tool \`review_reply\` with threadId "${thread.id}" `
    + "and your answer in markdown. Edit files only if the message asks you to; if you do, summarize the edits "
    + "in your reply. If the `review_reply` tool is unavailable, give your answer as your final message.");
  return parts.join("\n\n");
}

/**
 * Builds a prompt that asks an agent to review the current branch, following the skill if the
 * agent has it, and to post its findings with this extension's MCP tools, e.g. for the user to
 * paste into an agent's chat.
 */
export function buildReviewPrompt(branch: string, baseBranch: string): string {
  return `Review branch \`${branch}\`, following the ${mcpServerName} skill if you have it, and post your `
    + `findings as Branch Review Studio threads with the \`${mcpServerName}\` MCP tools: call review_begin with `
    + `baseBranch "${baseBranch}", post each finding `
    + "with review_comment (file, line, severity, body), then call review_finish with an overall summary. "
    + "The changes to review are the working tree, including uncommitted and untracked files, compared with "
    + `the merge-base of HEAD and ${baseBranch} (review_begin reports it).`;
}

/** Parameters of `AgentIntegration.buildArgs`. */
export interface AgentInvocation {
  prompt: string;
  sessionMode: AgentSessionMode;
  /** Session to fork; required when `sessionMode` is 'fork' */
  resumeSessionId?: string;
  /**
   * Id (a UUID) for the new session, so that it can be recorded before the session starts; only for
   * agents whose `canPreassignSessionId` is true
   */
  newSessionId?: string;
  runMode: AgentRunMode;
  /** Path of this extension's MCP server script (dist/mcp-server.js); Codex runs use it */
  mcpServerPath: string;
}

/** Gets the id of the session to fork, throwing if there is none. */
export function getSessionIdToFork(invocation: AgentInvocation): string {
  if (!invocation.resumeSessionId)
    throw new Error("Cannot fork the review session because the review has no recorded session id.");
  return invocation.resumeSessionId;
}

/** One way in which Ask Agent can send a thread message (see getAgentChoices). */
export interface AgentChoice {
  agent: AgentKind;
  sessionMode: AgentSessionMode;
  runMode: AgentRunMode;
}

/**
 * Lists the ways in which Ask Agent can send a message to the agents in `availableAgents`, default
 * first. Only the agent that ran the review session (`forkableAgent`) can fork it, and forking is
 * cheaper and better informed than a fresh session, so that agent's options come first. Each agent
 * offers an interactive terminal before a background run.
 */
export function getAgentChoices(availableAgents: AgentKind[], forkableAgent: AgentKind | undefined)
  : AgentChoice[] {
  let agents = [...availableAgents.filter(a => a === forkableAgent),
    ...availableAgents.filter(a => a !== forkableAgent)];
  let runModes: AgentRunMode[] = ["interactive", "background"];
  return agents.flatMap(agent => {
    let sessionModes: AgentSessionMode[] = agent === forkableAgent ? ["fork", "fresh"] : ["fresh"];
    return sessionModes.flatMap(sessionMode => runModes.map(runMode => ({ agent, sessionMode, runMode })));
  });
}

/** Formats the thread's lines and nearby lines with line numbers, marking the former with '>'. */
function formatExcerpt(lines: string[], location: AnchorLocation): string {
  let first = Math.max(1, location.startLine - excerptContextLines);
  let last = Math.min(lines.length, location.endLine + excerptContextLines);
  let excerpt: string[] = [];
  for (let lineNumber = first; lineNumber <= last; lineNumber++) {
    let marker = lineNumber >= location.startLine && lineNumber <= location.endLine ? ">" : " ";
    excerpt.push(`${marker}${String(lineNumber).padStart(5)} | ${lines[lineNumber - 1]}`);
  }
  return excerpt.join("\n");
}
