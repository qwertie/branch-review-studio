// Stdio MCP server through which agents (Claude Code, Codex) write Branch Review Studio reviews.
// The agent starts it in the session's project folder; the review belongs to the branch checked out
// there.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { groupingInstructions, mcpServerName } from "../core/agent-commands";
import { severities } from "../core/review";
import { identifyCaller, ReviewTools } from "./review-tools";

/** package.json's version, which esbuild.mjs substitutes at build time */
declare const EXTENSION_VERSION: string;

void main();

async function main(): Promise<void> {
  let server = new McpServer({ name: mcpServerName, version: EXTENSION_VERSION });
  /** Runs a tool as the agent session identified by the request */
  let runTool = (extra: { _meta?: Record<string, unknown> }, action: (tools: ReviewTools) => Promise<string>) =>
    runToolCore(() => action(new ReviewTools(identifyCaller(process.cwd(), extra._meta, process.env,
      server.server.getClientVersion()?.name))));

  server.registerTool("review_begin", {
    description: "Starts (or resumes) the Branch Review Studio review of the git branch checked out in this "
      + "project, recording this session as the reviewer. The reviewed changes are the WORKING TREE "
      + "(including uncommitted and untracked files) vs `git merge-base origin/<baseBranch> HEAD`. Existing "
      + "threads are kept; the result lists open ones so that you don't post duplicates, and explains how to post "
      + "findings and groups of related changes. Call this first.",
    inputSchema: {
      summary: z.string().optional().describe("Overall review summary (markdown); can also be set by review_finish"),
      baseBranch: z.string().optional()
        .describe("Branch to compare against; default: the existing review's base, else 'develop'"),
    },
  }, (args, extra) => runTool(extra, tools => tools.beginReview(args)));

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
  }, (args, extra) => runTool(extra, tools => tools.addReviewComment(args)));

  server.registerTool("review_reply", {
    description: "Replies in an existing Branch Review Studio comment thread (e.g. to answer the developer).",
    inputSchema: {
      threadId: z.string(),
      body: z.string().describe("Markdown reply"),
    },
  }, (args, extra) => runTool(extra, tools => tools.replyToThread(args)));

  server.registerTool("review_resolve", {
    description: "Marks a Branch Review Studio thread resolved, optionally with a closing note.",
    inputSchema: {
      threadId: z.string(),
      note: z.string().optional().describe("Markdown note added to the thread before resolving"),
    },
  }, (args, extra) => runTool(extra, tools => tools.resolveThread(args)));

  server.registerTool("review_list", {
    description: "Lists the threads (with all comments and current line numbers) of this branch's review.",
    inputSchema: {
      status: z.enum(["open", "resolved", "all"]).optional().describe("Default 'open'"),
    },
  }, (args, extra) => runTool(extra, tools => tools.listThreads(args)));

  let lineRange = z.object({ startLine: z.number().int(), endLine: z.number().int() });
  server.registerTool("review_set_groups", {
    description: "Posts the groups of related changes of the Branch Review Studio review, replacing any earlier "
      + "groups. Branch Review Studio lists each group (smallest first) with its summary and files, and each group's "
      + "diffs show only that group's changes. " + groupingInstructions,
    inputSchema: {
      groups: z.array(z.object({
        id: z.string().describe("Short id, unique among the groups, e.g. 'parser'"),
        name: z.string().describe("Heading shown in the Branch Review view, e.g. 'Fix CSV parser quoting'"),
        summary: z.string().describe("Markdown: what the group's changes do"),
      })),
      files: z.array(z.object({
        file: z.string().describe("Repo-relative (or absolute) path of a changed file"),
        groups: z.array(z.object({
          groupId: z.string(),
          ranges: z.array(lineRange).optional().describe("Working-tree lines (1-based, inclusive) of this group's "
            + "changes in the file; required if the file is in more than one group"),
        })),
      })),
    },
  }, (args, extra) => runTool(extra, tools => tools.setGroups(args)));

  server.registerTool("review_finish", {
    description: "Saves the overall review summary (markdown) after all findings are posted.",
    inputSchema: { summary: z.string() },
  }, (args, extra) => runTool(extra, tools => tools.finishReview(args)));

  await server.connect(new StdioServerTransport());
}

/** Converts a tool's result or error into an MCP tool result. */
async function runToolCore(action: () => Promise<string>) {
  try {
    return { content: [{ type: "text" as const, text: await action() }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}
