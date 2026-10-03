import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** An executable plus the arguments that must precede Claude Code's own arguments. */
export interface ClaudeCommand {
  command: string;
  args: string[];
}

/** Parameters of `findClaudeExecutable` (injected for testability). */
export interface ClaudeSearchOptions {
  /** User setting `branchReviewStudio.claudePath`; empty if unset */
  configuredPath: string;
  /** Value of the PATH environment variable */
  pathEnv: string;
  homeDir: string;
  platform: NodeJS.Platform;
}

/**
 * Finds the Claude Code CLI: the configured path, else `claude.exe` (or `claude`) on PATH, else an
 * npm `claude.cmd` shim on PATH, else the native installer's `~/.local/bin`. A .cmd shim is
 * replaced by `node <cli.js>`, because passing a multi-line prompt through cmd.exe garbles it.
 */
export function findClaudeExecutable(options: ClaudeSearchOptions): ClaudeCommand | undefined {
  let isWindows = options.platform === "win32";
  if (options.configuredPath)
    return resolveShimIfNeeded(options.configuredPath) ?? { command: options.configuredPath, args: [] };
  let pathDirs = options.pathEnv.split(isWindows ? ";" : ":").filter(dir => dir !== "");
  let names = isWindows ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (let name of names) {
    for (let dir of pathDirs) {
      let candidate = path.join(dir, name);
      if (fs.existsSync(candidate))
        return name.endsWith(".cmd") ? resolveShimIfNeeded(candidate) : { command: candidate, args: [] };
    }
  }
  let installerPath = path.join(options.homeDir, ".local", "bin", isWindows ? "claude.exe" : "claude");
  return fs.existsSync(installerPath) ? { command: installerPath, args: [] } : undefined;
}

/** Finds the Claude Code CLI using the current process's PATH and home folder. */
export function findClaudeExecutableForProcess(configuredPath: string): ClaudeCommand | undefined {
  return findClaudeExecutable({ configuredPath, pathEnv: process.env.PATH ?? "",
    homeDir: process.env.USERPROFILE || process.env.HOME || "", platform: process.platform });
}

/** Runs a short Claude Code CLI command (e.g. `mcp add`); returns stdout; throws on failure. */
export function runClaudeCommand(claude: ClaudeCommand, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(claude.command, [...claude.args, ...args], { cwd, env: getChildEnv(), windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`claude ${args.join(" ")} failed: ${(stderr || stdout).trim() || error.message}`));
        else
          resolve(stdout);
      });
  });
}

/** What the background Claude run reported, collected from its stream-json output. */
export interface BackgroundRunResult {
  sessionId: string | undefined;
  resultText: string | undefined;
  isError: boolean;
  exitCode: number | null;
}

/**
 * Runs `claude -p --output-format stream-json ...` (see buildClaudeArgs) to completion, calling
 * `onLine` for each output line (for logging).
 */
export function runClaudeInBackground(claude: ClaudeCommand, args: string[], cwd: string,
  onLine: (line: string) => void): Promise<BackgroundRunResult> {
  return new Promise((resolve, reject) => {
    let result: BackgroundRunResult = { sessionId: undefined, resultText: undefined, isError: false, exitCode: null };
    let child = spawn(claude.command, [...claude.args, ...args], { cwd, env: getChildEnv(), windowsHide: true,
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
        let event = parseStreamJsonLine(line);
        if (event.sessionId)
          result.sessionId ??= event.sessionId;
        if (event.resultText !== undefined)
          result.resultText = event.resultText;
        if (event.isError)
          result.isError = true;
      }
    }
  });
}

/** Extracts the fields this extension needs from one line of Claude Code's stream-json output. */
export function parseStreamJsonLine(line: string): { sessionId?: string, resultText?: string, isError?: boolean } {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }
  let fields: { sessionId?: string, resultText?: string, isError?: boolean } = {};
  if (typeof event === "object" && event !== null) {
    let record = event as Record<string, unknown>;
    let isInitOrResult = (record.type === "system" && record.subtype === "init") || record.type === "result";
    if (isInitOrResult && typeof record.session_id === "string")
      fields.sessionId = record.session_id;
    if (record.type === "result") {
      if (typeof record.result === "string")
        fields.resultText = record.result;
      fields.isError = record.is_error === true;
    }
  }
  return fields;
}

/**
 * Gets the environment for Claude child processes. VS Code's extension host sets
 * ELECTRON_RUN_AS_NODE, which must not leak into programs that Claude Code starts.
 */
function getChildEnv(): NodeJS.ProcessEnv {
  let { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
  return env;
}

/** For an npm `claude.cmd` shim, gets `node <cli.js>`; returns undefined for other files. */
function resolveShimIfNeeded(filePath: string): ClaudeCommand | undefined {
  if (filePath.toLowerCase().endsWith(".cmd")) {
    let cliPath = path.join(path.dirname(filePath), "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (fs.existsSync(cliPath))
      return { command: "node", args: [cliPath] };
  }
  return undefined;
}
