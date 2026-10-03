import * as fs from "node:fs";
import * as path from "node:path";
import { AgentInvocation, getSessionIdToFork, mcpServerName } from "./agent-commands";
import {
  AgentIntegration, AgentOutputFields, ExecutableSpec, findExecutable, parseJsonObject,
} from "./agent-integration";

/** Where the Codex CLI is: `codex.exe` (or `codex`) on PATH, else an npm `codex.cmd` shim. */
const codexExecutableSpec: ExecutableSpec = {
  windowsNames: ["codex.exe", "codex.cmd"],
  unixNames: ["codex"],
  shimScript: path.join("node_modules", "@openai", "codex", "bin", "codex.js"),
  getFallbackPaths: () => [],
};

/** Runs the OpenAI Codex CLI (`codex`) for Branch Review Studio. */
export const codexIntegration: AgentIntegration = {
  agent: "codex",
  displayName: "Codex",
  authorName: "Codex",
  backgroundCommand: "codex exec",
  canPreassignSessionId: false,
  findExecutable: options => findExecutable(options, codexExecutableSpec),
  buildArgs: buildCodexArgs,
  parseOutputLine: parseCodexJsonLine,
  getMcpAddArgs: serverPath => ["mcp", "add", mcpServerName, "--", "node", serverPath],
  mcpRemoveArgs: ["mcp", "remove", mcpServerName],
  mcpGetArgs: ["mcp", "get", mcpServerName],
  loginStatusArgs: ["login", "status"],
  isSignedIn: output => /^Logged in/im.test(output),
  getSkillDir: homeDir => path.join(homeDir, ".agents", "skills", mcpServerName),
};

/**
 * Builds the argument list for the `codex` executable: `codex [fork <id>] <prompt>` in a terminal,
 * or `codex exec [fork <id>] --json <prompt>` in the background. The `-c` options define this
 * extension's MCP server, whether or not the user registered it (Codex rejects an approval setting
 * for an unregistered server), and let Codex call its tools without asking, since they only write
 * to the review. Codex's sandbox and approval policy for everything else are unchanged.
 */
export function buildCodexArgs(invocation: AgentInvocation): string[] {
  let isBackground = invocation.runMode === "background";
  let isFork = invocation.sessionMode === "fork";
  let args = [...isBackground ? ["exec"] : [], ...isFork ? ["fork"] : [], ...isBackground ? ["--json"] : []];
  // Values are TOML; a JSON string is also a valid TOML string
  let serverConfig = { command: JSON.stringify("node"), args: JSON.stringify([invocation.mcpServerPath]),
    default_tools_approval_mode: JSON.stringify("approve") };
  for (let [key, value] of Object.entries(serverConfig))
    args.push("-c", `mcp_servers.${mcpServerName}.${key}=${value}`);
  if (isFork)
    args.push(getSessionIdToFork(invocation));
  args.push(invocation.prompt);
  return args;
}

/**
 * Extracts the fields this extension needs from one line of `codex exec --json` output: the thread
 * id from `thread.started`, the latest `agent_message`, and errors from `error` and `turn.failed`
 * events.
 */
export function parseCodexJsonLine(line: string): AgentOutputFields {
  let event = parseJsonObject(line);
  let item = event?.item as Record<string, unknown> | undefined;
  let error = event?.error as Record<string, unknown> | undefined;
  let fields: AgentOutputFields = {};
  if (event?.type === "thread.started" && typeof event.thread_id === "string")
    fields.sessionId = event.thread_id;
  if (event?.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string")
    fields.resultText = item.text;
  if (event?.type === "error" && typeof event.message === "string")
    fields.errorMessage = getInnerErrorMessage(event.message);
  if (event?.type === "turn.failed") {
    fields.isError = true;
    if (typeof error?.message === "string")
      fields.errorMessage = getInnerErrorMessage(error.message);
  }
  return fields;
}

/**
 * Lists the Codex CLIs bundled with the OpenAI Codex VS Code extension (`bin/<platform>/codex`).
 * They are updated with the extension, so they are usually newer than a `codex` on PATH.
 */
export function findCodexExtensionExecutables(extensionPath: string, platform: NodeJS.Platform): string[] {
  let binDir = path.join(extensionPath, "bin");
  let platformDirs = fs.existsSync(binDir) ? fs.readdirSync(binDir) : [];
  return platformDirs.map(dir => path.join(binDir, dir, platform === "win32" ? "codex.exe" : "codex"))
    .filter(file => fs.existsSync(file));
}

/**
 * Gets the message inside a Codex error message that wraps an API error as JSON, e.g.
 * `{"type":"error","status":400,"error":{"message":"The 'x' model is not supported..."}}`.
 */
function getInnerErrorMessage(message: string): string {
  let inner = parseJsonObject(message)?.error as Record<string, unknown> | undefined;
  return typeof inner?.message === "string" ? inner.message : message;
}
