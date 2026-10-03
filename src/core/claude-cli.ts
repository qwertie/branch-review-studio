import * as path from "node:path";
import { AgentInvocation, getSessionIdToFork, mcpServerName } from "./agent-commands";
import {
  AgentIntegration, AgentOutputFields, ExecutableSpec, findExecutable, parseJsonObject,
} from "./agent-integration";

/**
 * Where the Claude Code CLI is: `claude.exe` (or `claude`) on PATH, else an npm `claude.cmd` shim
 * on PATH, else the native installer's `~/.local/bin`.
 */
const claudeExecutableSpec: ExecutableSpec = {
  windowsNames: ["claude.exe", "claude.cmd"],
  unixNames: ["claude"],
  shimScript: path.join("node_modules", "@anthropic-ai", "claude-code", "cli.js"),
  getFallbackPaths: isWindows => [path.join(".local", "bin", isWindows ? "claude.exe" : "claude")],
};

/** Runs Claude Code (`claude`) for Branch Review Studio. */
export const claudeIntegration: AgentIntegration = {
  agent: "claude",
  displayName: "Claude Code",
  authorName: "Claude",
  backgroundCommand: "claude -p",
  canPreassignSessionId: true,
  findExecutable: options => findExecutable(options, claudeExecutableSpec),
  buildArgs: buildClaudeArgs,
  parseOutputLine: parseStreamJsonLine,
  getMcpAddArgs: serverPath => ["mcp", "add", "--scope", "user", mcpServerName, "--", "node", serverPath],
  mcpRemoveArgs: ["mcp", "remove", "--scope", "user", mcpServerName],
  mcpGetArgs: ["mcp", "get", mcpServerName],
  loginStatusArgs: ["auth", "status"],
  isSignedIn: output => parseJsonObject(output)?.loggedIn === true,
  getSkillDir: homeDir => path.join(homeDir, ".claude", "skills", mcpServerName),
};

/**
 * Builds the argument list for the `claude` executable. Claude may call this extension's MCP tools
 * without asking, since they only write to the review.
 */
export function buildClaudeArgs(invocation: AgentInvocation): string[] {
  // --allowedTools takes a variable number of values, so an option, not the prompt, must follow it
  let args = ["--allowedTools", `mcp__${mcpServerName}`];
  if (invocation.runMode === "background")
    args.push("-p", "--output-format", "stream-json", "--verbose");
  if (invocation.sessionMode === "fork")
    args.push("--resume", getSessionIdToFork(invocation), "--fork-session");
  if (invocation.newSessionId)
    args.push("--session-id", invocation.newSessionId);
  args.push(invocation.prompt);
  return args;
}

/** Extracts the fields this extension needs from one line of Claude Code's stream-json output. */
export function parseStreamJsonLine(line: string): AgentOutputFields {
  let event = parseJsonObject(line);
  let fields: AgentOutputFields = {};
  let isInitOrResult = (event?.type === "system" && event.subtype === "init") || event?.type === "result";
  if (isInitOrResult && typeof event?.session_id === "string")
    fields.sessionId = event.session_id;
  if (event?.type === "result") {
    if (typeof event.result === "string")
      fields.resultText = event.result;
    fields.isError = event.is_error === true;
  }
  return fields;
}
