import { AnchorLocation } from "./anchoring";
import { getAuthorLabel, Review, ReviewThread } from "./review";

/** Name under which the MCP server is registered with Claude Code (`claude mcp add <name>`). */
export const mcpServerName = "branch-review-studio";

/** 'fork' = resume the review session as a fork (`--fork-session`); 'fresh' = start a new one */
export type AgentSessionMode = "fork" | "fresh";
/** 'interactive' = a VS Code terminal running claude; 'background' = `claude -p` with no UI */
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
 * Builds the prompt that sends the user's newest thread message to Claude Code. A forked session
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

/** Parameters of `buildClaudeArgs`. */
export interface ClaudeInvocation {
  prompt: string;
  sessionMode: AgentSessionMode;
  /** Session to fork; required when `sessionMode` is 'fork' */
  resumeSessionId?: string;
  runMode: AgentRunMode;
}

/**
 * Builds the argument list for the `claude` executable (an argv array, never a shell string, so
 * multi-line prompts need no quoting). Background runs may call this extension's MCP tools
 * without asking, since there is nobody to answer a permission prompt.
 */
export function buildClaudeArgs(invocation: ClaudeInvocation): string[] {
  let args: string[] = [];
  if (invocation.sessionMode === "fork") {
    if (!invocation.resumeSessionId)
      throw new Error("Cannot fork the review session because the review has no recorded session id.");
    args.push("--resume", invocation.resumeSessionId, "--fork-session");
  }
  if (invocation.runMode === "background")
    args.push("-p", "--output-format", "stream-json", "--verbose", "--allowedTools", `mcp__${mcpServerName}`);
  args.push(invocation.prompt);
  return args;
}

/** Formats the thread's lines and surrounding lines with line numbers, marking the former with '>'. */
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
