import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentInvocation } from "./agent-commands";
import { AgentKind } from "./review";

/**
 * What Branch Review Studio needs to know about an agent CLI (Claude Code or Codex) to run it, to
 * register the MCP server with it, and to check its status. See claudeIntegration and
 * codexIntegration.
 */
export interface AgentIntegration {
  readonly agent: AgentKind;
  /** Product name shown in the UI, e.g. "Claude Code" */
  readonly displayName: string;
  /** Author name of comments that the extension posts on the agent's behalf, e.g. "Claude" */
  readonly authorName: string;
  /** Command line of a background run, shown in Ask Agent's choices, e.g. "claude -p" */
  readonly backgroundCommand: string;
  /** Whether `buildArgs` can preassign the new session's id (AgentInvocation.newSessionId) */
  readonly canPreassignSessionId: boolean;
  findExecutable(options: ExecutableSearchOptions): AgentCommand | undefined;
  /** Builds the agent's argument list (an argv array, never a shell string) */
  buildArgs(invocation: AgentInvocation): string[];
  /** Extracts what this extension needs from one line of a background run's JSON output */
  parseOutputLine(line: string): AgentOutputFields;
  /** Arguments that register the MCP server, which runs `node <serverPath>`, with the agent */
  getMcpAddArgs(serverPath: string): string[];
  /** Arguments that remove the MCP server's registration */
  readonly mcpRemoveArgs: string[];
  /** Arguments of a command that succeeds only if the MCP server is registered */
  readonly mcpGetArgs: string[];
  /** Arguments of a command that reports whether the user is signed in (see isSignedIn) */
  readonly loginStatusArgs: string[];
  /** Interprets the output of a successful `loginStatusArgs` command */
  isSignedIn(loginStatusOutput: string): boolean;
  /** Folder into which the install commands copy the branch-review-studio skill */
  getSkillDir(homeDir: string): string;
}

/** An executable plus the arguments that must precede the agent's own arguments. */
export interface AgentCommand {
  command: string;
  args: string[];
}

/** Parameters of `AgentIntegration.findExecutable` (injected for testability). */
export interface ExecutableSearchOptions {
  /** User setting such as `branchReviewStudio.claudePath`; empty if unset */
  configuredPath: string;
  /** Executables to try after `configuredPath` and before PATH, e.g. the Codex extension's CLI */
  preferredPaths?: string[];
  /** Value of the PATH environment variable */
  pathEnv: string;
  homeDir: string;
  platform: NodeJS.Platform;
}

/** Where `findExecutable` looks for an agent CLI. */
export interface ExecutableSpec {
  /** File names to look for in PATH folders, most preferred first */
  windowsNames: string[];
  unixNames: string[];
  /** Path of an npm package's script, relative to the folder of the package's `.cmd` shim */
  shimScript: string;
  /** Paths (relative to the home folder) to try after PATH */
  getFallbackPaths(isWindows: boolean): string[];
}

/**
 * Finds an agent CLI: the configured path, else the first existing preferred path, else the first
 * of `spec`'s names found on PATH, else a fallback path. A .cmd shim is replaced by
 * `node <script>`, because passing a multi-line prompt through cmd.exe garbles it.
 */
export function findExecutable(options: ExecutableSearchOptions, spec: ExecutableSpec): AgentCommand | undefined {
  let isWindows = options.platform === "win32";
  if (options.configuredPath)
    return getAgentCommand(options.configuredPath, spec) ?? { command: options.configuredPath, args: [] };
  let pathDirs = options.pathEnv.split(isWindows ? ";" : ":").filter(dir => dir !== "");
  let candidates = [...options.preferredPaths ?? [],
    ...(isWindows ? spec.windowsNames : spec.unixNames).flatMap(name => pathDirs.map(dir => path.join(dir, name))),
    ...spec.getFallbackPaths(isWindows).map(relativePath => path.join(options.homeDir, relativePath))];
  for (let candidate of candidates) {
    let command = fs.existsSync(candidate) ? getAgentCommand(candidate, spec) : undefined;
    if (command)
      return command;
  }
  return undefined;
}

/** Gets the parameters of `findExecutable` for the current process's PATH and home folder. */
export function getSearchOptionsForProcess(configuredPath: string, preferredPaths: string[] = [])
  : ExecutableSearchOptions {
  return { configuredPath, preferredPaths, pathEnv: process.env.PATH ?? "",
    homeDir: process.env.USERPROFILE || process.env.HOME || "", platform: process.platform };
}

/**
 * Runs a short agent CLI command (e.g. `mcp add`); returns stdout, or stderr if stdout is empty
 * (`codex login status` writes to stderr); throws on failure.
 */
export function runAgentCommand(agent: AgentCommand, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(agent.command, [...agent.args, ...args], { cwd, env: getChildEnv(), windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`'${getCommandLine(agent, args)}' failed: ${(stderr || stdout).trim() || error.message}`));
        else
          resolve(stdout.trim() === "" ? stderr : stdout);
      });
  });
}

/** Fields of one line of an agent's JSON output that this extension uses. */
export interface AgentOutputFields {
  /** Id of the session that the run created */
  sessionId?: string;
  /** The agent's final message (or its latest message so far) */
  resultText?: string;
  /** True if the agent reported that the run failed */
  isError?: boolean;
  /** Description of an error that the agent reported */
  errorMessage?: string;
}

/** What a background agent run reported, collected from its JSON output. */
export interface BackgroundRunResult {
  sessionId: string | undefined;
  resultText: string | undefined;
  isError: boolean;
  errorMessage: string | undefined;
  exitCode: number | null;
}

/**
 * Runs an agent without a UI (e.g. `claude -p --output-format stream-json ...` or
 * `codex exec --json ...`) to completion, calling `onLine` for each output line (for logging).
 */
export function runAgentInBackground(agent: AgentCommand, args: string[], cwd: string,
  parseLine: (line: string) => AgentOutputFields, onLine: (line: string) => void): Promise<BackgroundRunResult> {
  return new Promise((resolve, reject) => {
    let result: BackgroundRunResult = { sessionId: undefined, resultText: undefined, isError: false,
      errorMessage: undefined, exitCode: null };
    // stdin is closed, since `codex exec` otherwise waits for more input
    let child = spawn(agent.command, [...agent.args, ...args], { cwd, env: getChildEnv(), windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    let pending = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      let lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (let line of lines)
        handleLine(line);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => onLine("stderr: " + chunk.trimEnd()));
    child.on("error", reject);
    child.on("close", exitCode => {
      handleLine(pending);
      resolve({ ...result, exitCode });
    });

    function handleLine(line: string) {
      if (line.trim() !== "") {
        onLine(line);
        let fields = parseLine(line);
        result.sessionId ??= fields.sessionId;
        result.resultText = fields.resultText ?? result.resultText;
        result.errorMessage = fields.errorMessage ?? result.errorMessage;
        result.isError ||= fields.isError === true;
      }
    }
  });
}

/** Parses a line of JSON output into an object, or returns undefined if it isn't a JSON object. */
export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    let value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Gets a short command line for messages, e.g. "codex.exe mcp get x" or "node cli.js auth status". */
function getCommandLine(agent: AgentCommand, args: string[]): string {
  return [...[agent.command, ...agent.args].map(file => path.basename(file)), ...args].join(" ");
}

/**
 * Gets the environment for agent child processes. VS Code's extension host sets
 * ELECTRON_RUN_AS_NODE, which must not leak into programs that the agent starts.
 */
function getChildEnv(): NodeJS.ProcessEnv {
  let { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  return env;
}

/**
 * Gets the command that runs an existing agent executable: the file itself, or for an npm `.cmd`
 * shim, `node <script>`. Returns undefined for a shim whose script is missing.
 */
function getAgentCommand(filePath: string, spec: ExecutableSpec): AgentCommand | undefined {
  if (filePath.toLowerCase().endsWith(".cmd")) {
    let scriptPath = path.join(path.dirname(filePath), spec.shimScript);
    return fs.existsSync(scriptPath) ? { command: "node", args: [scriptPath] } : undefined;
  }
  return { command: filePath, args: [] };
}
