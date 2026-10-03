import * as fs from "node:fs";
import * as path from "node:path";
import { buildChatThreadPrompt, mcpServerName, ThreadMessageContext } from "./agent-commands";

/** Name of the integration with VS Code's chat in agent mode, shown in the UI and on comments. */
export const vscodeChatDisplayName = "VS Code Chat";

/**
 * Name of the custom agent that this extension contributes to VS Code's chat
 * (agents/branch-reviewer.agent.md, whose `name` must match), which Ask Agent selects.
 */
export const chatAgentName = "Branch Reviewer";

/** Detail line of Ask Agent's choice that sends the message to VS Code's chat. */
export const vscodeChatChoiceDetail = "Runs in VS Code's chat with the model selected there, as a new chat (VS "
  + "Code can't fork chats); the answer appears in the thread when the agent calls review_reply";

/** VS Code's internal command that opens the chat view, optionally with a query to send. */
export const chatOpenCommand = "workbench.action.chat.open";
/** VS Code's internal command that starts a new chat with VS Code's own (local) agent. */
export const newLocalChatCommand = "workbench.action.chat.newLocalChat";

/**
 * Environment variable that the MCP server definition sets (see buildMcpServerLaunch), so that
 * identifyCaller attributes calls to VS Code's chat even without a conversation id.
 */
export const mcpClientEnvVar = "BRS_MCP_CLIENT";

/** A line range in VS Code's internal (1-based) editor coordinates. */
export interface EditorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * Arguments of `workbench.action.chat.open` (see buildChatOpenArgs). The command is internal and
 * undocumented; `mode` selects a chat mode or custom agent by name, `isPartialQuery: false` sends
 * the query, and `attachFiles` attaches files, optionally with line ranges.
 */
export interface ChatOpenArgs<TUri> {
  query: string;
  mode: string;
  isPartialQuery: boolean;
  attachFiles?: { uri: TUri, range: EditorRange }[];
}

/**
 * Builds the arguments with which Ask Agent sends a thread message to VS Code's chat: the
 * Branch Reviewer agent, a prompt from buildChatThreadPrompt, and the thread's lines of
 * `fileUri` (the working-tree file) as an attachment. Base-side threads get no attachment, since
 * the attachment would show the working-tree file; their prompt quotes the lines instead.
 */
export function buildChatOpenArgs<TUri>(context: ThreadMessageContext, fileUri: TUri): ChatOpenArgs<TUri> {
  let { thread, fileLines, location } = context;
  let isFileAttached = thread.side === "modified" && fileLines !== undefined;
  let args: ChatOpenArgs<TUri> = { query: buildChatThreadPrompt(context, isFileAttached), mode: chatAgentName,
    isPartialQuery: false };
  if (isFileAttached) {
    args.attachFiles = [{ uri: fileUri, range: { startLineNumber: location.startLine, startColumn: 1,
      endLineNumber: location.endLine, endColumn: (fileLines?.[location.endLine - 1]?.length ?? 0) + 1 } }];
  }
  return args;
}

/** How VS Code should start the MCP server for its chat (see vscode.McpStdioServerDefinition). */
export interface McpServerLaunch {
  /** Server name in VS Code's UI; VS Code derives the tool set name (`<label>/*`) from it */
  label: string;
  command: string;
  args: string[];
  /** The server reviews the branch checked out in this folder */
  cwd: string;
  env: Record<string, string>;
  /** VS Code offers to refresh the server's tools when this changes */
  version: string;
}

/**
 * Describes how VS Code starts the MCP server script `serverPath` for its chat: with the
 * editor's own Node.js (`nodePath`, i.e. process.execPath, run as Node by ELECTRON_RUN_AS_NODE),
 * so that `node` needn't be on PATH, in the repo folder `cwd`.
 */
export function buildMcpServerLaunch(serverPath: string, nodePath: string, cwd: string, version: string)
  : McpServerLaunch {
  return { label: mcpServerName, command: nodePath, args: [serverPath], cwd, version,
    env: { ELECTRON_RUN_AS_NODE: "1", [mcpClientEnvVar]: "vscodeChat" } };
}

/**
 * Folders in which VS Code's chat looks for skills (by default; see the `chat.agentSkillsLocations`
 * setting), relative to the workspace folder or, with `~/`, to the home folder. VS Code loads one
 * skill per name, preferring these folders (workspace first) to skills that extensions contribute.
 */
const chatSkillFolders = [".agents/skills", ".github/skills", ".claude/skills", "~/.agents/skills",
  "~/.copilot/skills", "~/.claude/skills"];

/**
 * Finds the copies of the branch-review-studio skill that VS Code's chat loads instead of the one
 * that this extension contributes (see chatSkillFolders), most preferred first.
 */
export function findSkillCopiesThatTakePrecedence(homeDir: string, workspaceFolder: string | undefined): string[] {
  return chatSkillFolders.flatMap(folder => {
    let base = folder.startsWith("~/") ? homeDir : workspaceFolder;
    let file = base && path.join(base, folder.replace(/^~\//, ""), mcpServerName, "SKILL.md");
    return file && fs.existsSync(file) ? [file] : [];
  });
}
