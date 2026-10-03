import { AnchorLocation } from "./anchoring";
import { AgentKind, getAuthorLabel, Review, ReviewThread } from "./review";

/** Name under which the MCP server is registered with agents (`claude mcp add <name>`). */
export const mcpServerName = "branch-review-studio";

/** Tells an agent how to post findings; review_begin returns it. */
export const findingInstructions = "Post each finding with review_comment: file, line (and endLine for a range), "
  + "severity (Critical, Major, Minor or Note) and a markdown body that states the concrete consequence. Line "
  + "numbers refer to the working-tree file; for removed code, use side \"base\" and line numbers in the merge-base "
  + "version.";

/**
 * Tells an agent how to group the changes and post the groups; review_begin returns it, and the
 * skill (skills/branch-review-studio/SKILL.md) quotes it verbatim.
 */
export const groupingInstructions = "Group the changes: partition them by apparent independence, so that "
  + "unrelated or tenuously related changes are in different groups; one file's changes may span groups, and a "
  + "frontend change and a backend change may share a group. Post the groups with review_set_groups: give each "
  + "group an id, a name (a short heading) and a short markdown summary of what its changes do, and list every "
  + "changed file with its groups. For a file in more than one group, give each of its groups `ranges`: the "
  + "working-tree lines (1-based, inclusive) of that group's changes in the file; for removed lines, give the "
  + "working-tree line just above or below where they were. A change that the ranges of several groups overlap "
  + "appears in each of those groups; a change that no range covers appears in all of the file's groups. Calling "
  + "review_set_groups again replaces the groups.";

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
 * Builds a short prompt that asks an agent to review the current branch with the skill, for the user
 * to paste into an agent's chat. The skill holds the procedure; without the skill, review_begin's
 * result tells the agent how to post its findings.
 */
export function buildReviewPrompt(branch: string, baseBranch: string): string {
  return `Use the ${mcpServerName} skill to review branch \`${branch}\` against \`${baseBranch}\`. `
    + `If you don't have that skill, call review_begin (\`${mcpServerName}\` MCP tools) and follow its instructions.`;
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
