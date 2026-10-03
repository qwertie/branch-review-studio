// Stdio MCP server through which Claude Code writes Branch Review Studio reviews. Claude Code
// starts it in the session's project folder; the review belongs to the branch checked out there.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mcpServerName } from "../core/agent-commands";
import { severities } from "../core/review";
import { ReviewTools } from "./review-tools";

void main();

async function main(): Promise<void> {
  let tools = new ReviewTools({ cwd: process.cwd(), sessionId: process.env.CLAUDE_CODE_SESSION_ID || undefined,
    agentName: process.env.BRS_AGENT_NAME || "Claude" });
  let server = new McpServer({ name: mcpServerName, version: "0.2.0" });

  server.registerTool("review_begin", {
    description: "Starts (or resumes) the Branch Review Studio review of the git branch checked out in this "
      + "project, recording this session as the reviewer. The reviewed changes are the WORKING TREE "
      + "(including uncommitted and untracked files) vs `git merge-base origin/<baseBranch> HEAD`. Existing "
      + "threads are kept; the result lists open ones so that you don't post duplicates. Call this first.",
    inputSchema: {
      summary: z.string().optional().describe("Overall review summary (markdown); can also be set by review_finish"),
      baseBranch: z.string().optional().describe("Branch to compare against; default 'develop'"),
    },
  }, args => runTool(() => tools.beginReview(args)));

  server.registerTool("review_comment", {
    description: "Posts one review finding as a new comment thread in Branch Review Studio. Line numbers are "
      + "1-based and refer to the working-tree file unless side is 'base'. Returns the thread id.",
    inputSchema: {
      file: z.string().describe("Repo-relative (or absolute) file path"),
      line: z.number().int().describe("First line of the finding"),
      endLine: z.number().int().optional().describe("Last line (default: same as line)"),
      side: z.enum(["modified", "base"]).optional()
        .describe("'modified' (default) = working-tree file; 'base' = file at the merge-base, e.g. for removed code"),
      severity: z.enum(severities).describe("Critical, Major, Minor or Note"),
      body: z.string().describe("Markdown: the finding and its concrete consequence"),
    },
  }, args => runTool(() => tools.addReviewComment(args)));

  server.registerTool("review_reply", {
    description: "Replies in an existing Branch Review Studio comment thread (e.g. to answer the developer).",
    inputSchema: {
      threadId: z.string(),
      body: z.string().describe("Markdown reply"),
    },
  }, args => runTool(() => tools.replyToThread(args)));

  server.registerTool("review_resolve", {
    description: "Marks a Branch Review Studio thread resolved, optionally with a closing note.",
    inputSchema: {
      threadId: z.string(),
      note: z.string().optional().describe("Markdown note added to the thread before resolving"),
    },
  }, args => runTool(() => tools.resolveThread(args)));

  server.registerTool("review_list", {
    description: "Lists the threads (with all comments and current line numbers) of this branch's review.",
    inputSchema: {
      status: z.enum(["open", "resolved", "all"]).optional().describe("Default 'open'"),
    },
  }, args => runTool(() => tools.listThreads(args)));

  server.registerTool("review_finish", {
    description: "Saves the overall review summary (markdown) after all findings are posted.",
    inputSchema: { summary: z.string() },
  }, args => runTool(() => tools.finishReview(args)));

  await server.connect(new StdioServerTransport());
}

/** Converts a tool's result or error into an MCP tool result. */
async function runTool(action: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await action() }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}
