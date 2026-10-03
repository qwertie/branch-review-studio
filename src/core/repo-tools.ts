import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getErrorCode, getErrorMessage } from "./files";
import { getChangedFiles, GitRunOptions, runGit } from "./git";
import { parseDiffHunks } from "./hunks";
import { DiffSide } from "./review";

/** A tool that a language model may call: its name, purpose and JSON schema of its input. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: object;
}

/** Tools that a language model can call, and how to run them (see runToolLoop). */
export interface ToolSet {
  readonly definitions: ToolDefinition[];
  /** Runs a tool; returns its result, or a description of the error ("Error: ..."); never throws */
  callTool(name: string, input: object): Promise<string>;
}

const pathProperty = { type: "string", description: "Repo-relative path with forward slashes, e.g. src/app.ts" };
const globProperty = { type: "string", description: "Optional git pathspec that limits the files, e.g. src/ or "
  + "*.ts (* also matches /)" };

/** The read-only tools of RepoTools, for language models that answer review threads. */
export const repoToolDefinitions: ToolDefinition[] = [
  { name: "read_file", description: "Reads a file of the working tree (tracked or untracked, not ignored by git), "
    + "with line numbers. Without a line range it reads the whole file (long results are truncated).",
  inputSchema: { type: "object", required: ["path"], properties: { path: pathProperty,
    startLine: { type: "number", description: "First line to read (1-based)" },
    endLine: { type: "number", description: "Last line to read (inclusive)" } } } },
  { name: "search_text", description: "Searches the working tree's text files (tracked and untracked, not ignored) "
    + "for an extended regular expression (git grep -E); returns path:line:text lines.",
  inputSchema: { type: "object", required: ["pattern"], properties: { pattern: { type: "string" },
    glob: globProperty, ignoreCase: { type: "boolean" } } } },
  { name: "list_files", description: "Lists the working tree's files (tracked and untracked, not ignored).",
    inputSchema: { type: "object", properties: { glob: globProperty } } },
  { name: "list_changed_files", description: "Lists the files that the branch changed: the working tree compared "
    + "with the merge-base.", inputSchema: { type: "object", properties: {} } },
  { name: "get_file_diff", description: "Gets a file's diff (git diff) between the merge-base and the working tree.",
    inputSchema: { type: "object", required: ["path"], properties: { path: pathProperty } } },
];

/** What the note on a truncated result of each tool suggests (see truncateText). */
const truncationHints: Record<string, string> = {
  read_file: "Read a smaller line range.",
  search_text: "Use a more specific pattern or glob.",
  list_files: "Use a more specific glob.",
  list_changed_files: "The branch changes too many files to list them all.",
  get_file_diff: "Use read_file for parts of the file.",
};

/** Default limit on the length of one tool result, in characters (roughly 5000 tokens). */
const defaultMaxResultChars = 20_000;
/** Lines of search_text results longer than this are cut, e.g. lines of minified files. */
const maxSearchLineChars = 300;
/** selectHunksNear's hunks may be this many lines away from the thread's lines. */
const nearbyLineCount = 5;
/** read_file refuses larger files, rather than read them into memory to show part of them. */
const maxReadFileBytes = 50 * 1024 * 1024;
/** Default time after which a tool's git process is killed, e.g. a slow search of a large repo. */
const defaultGitTimeoutMs = 20_000;

/** Options of RepoTools. */
export interface RepoToolOptions {
  /** Limit on the length of one tool result, in characters */
  maxResultChars?: number;
  /** Time after which a tool's git process is killed, in milliseconds */
  gitTimeoutMs?: number;
  /** Kills the tools' git processes when aborted, e.g. when the user cancels the answer */
  signal?: AbortSignal;
}

/**
 * Read-only tools that let a language model explore one working tree of a git repo: read files,
 * search, list files and see the branch's changes since `mergeBaseSha`. Paths outside the repo,
 * inside `.git` (see resolveRepoPath) and ignored by git are refused, so that the model doesn't
 * see secrets such as `.env` files; results are truncated to `options.maxResultChars`.
 */
export class RepoTools implements ToolSet {
  readonly definitions = repoToolDefinitions;
  private readonly maxResultChars: number;
  /** Options of the tools' git processes */
  private readonly gitOptions: GitRunOptions;

  constructor(private readonly repoRoot: string, private readonly mergeBaseSha: string,
    options: RepoToolOptions = {}) {
    this.maxResultChars = options.maxResultChars ?? defaultMaxResultChars;
    this.gitOptions = { timeoutMs: options.gitTimeoutMs ?? defaultGitTimeoutMs, signal: options.signal };
  }

  async callTool(name: string, input: object): Promise<string> {
    let args = input as Record<string, unknown>;
    let tools: Record<string, () => Promise<string>> = {
      read_file: () => this.readFile(getString(args, "path"), getNumber(args, "startLine"), getNumber(args, "endLine")),
      search_text: () => this.searchText(getString(args, "pattern"), getOptionalString(args, "glob"),
        args.ignoreCase === true),
      list_files: () => this.listFiles(getOptionalString(args, "glob")),
      list_changed_files: () => this.listChangedFiles(),
      get_file_diff: () => this.getFileDiff(getString(args, "path")),
    };
    try {
      if (!Object.hasOwn(tools, name))
        throw new Error(`unknown tool '${name}'.`);
      return truncateText(await tools[name](), this.maxResultChars, truncationHints[name]);
    } catch (e) {
      return `Error: ${getErrorMessage(e)}`;
    }
  }

  /**
   * Gets the hunks of a file's diff since the merge-base that are near lines `startLine`..`endLine`
   * of the given side (see selectHunksNear); undefined if there are none. Ask Agent puts them in a
   * language model's prompt.
   */
  async getDiffNear(file: string, side: DiffSide, startLine: number, endLine: number): Promise<string | undefined> {
    return selectHunksNear(await this.readDiff(this.getLiteralPathspec(file)), side, startLine, endLine);
  }

  private async readFile(file: string, startLine: number | undefined, endLine: number | undefined)
    : Promise<string> {
    let fullPath = resolveRepoPath(this.repoRoot, file);
    let realPath = await fs.realpath(fullPath).catch(e => {
      throw getErrorCode(e) === "ENOENT" ? new Error(`${file} was not found.`) : e;
    });
    // A symbolic link could lead outside the repo, or to an ignored file
    let realRoot = await fs.realpath(this.repoRoot);
    checkInsideRepo(realRoot, realPath, file);
    let stats = await fs.stat(realPath);
    // Reading a FIFO or device could block forever
    if (!stats.isFile()) {
      throw new Error(stats.isDirectory() ? `${file} is a folder; use list_files to see its files.`
        : `${file} is not a regular file.`);
    }
    if (stats.size > maxReadFileBytes)
      throw new Error(`${file} is too large (${stats.size} bytes); use search_text to find lines in it.`);
    let listed = await this.runGit(["ls-files", "--cached", "--others", "--exclude-standard", "--",
      toLiteralPathspec(path.relative(realRoot, realPath))]);
    if (listed.trim() === "")
      throw new Error(`${file} is ignored by git (e.g. by .gitignore), so the tools don't read it.`);
    let text = await fs.readFile(realPath, "utf8");
    if (text.includes("\0"))
      throw new Error(`${file} is a binary file.`);
    let lines = text.split(/\r?\n/);
    if (lines.at(-1) === "")
      lines.pop();
    let first = Math.max(1, startLine ?? 1);
    let last = Math.min(lines.length, endLine ?? lines.length);
    let numbered = lines.slice(first - 1, last).map((line, i) => `${String(first + i).padStart(5)} | ${line}`);
    return [`${file}, lines ${first}-${last} of ${lines.length}:`, ...numbered].join("\n");
  }

  private async searchText(pattern: string, glob: string | undefined, ignoreCase: boolean): Promise<string> {
    let output = await this.runGit(["grep", "-n", "-I", "--untracked", "--no-color", "-E",
      ...ignoreCase ? ["-i"] : [], "-e", pattern, ...getPathspecArgs(glob)], [1]);
    let lines = output.split("\n").filter(line => line !== "")
      .map(line => line.length > maxSearchLineChars ? line.slice(0, maxSearchLineChars) + "…" : line);
    return lines.length === 0 ? "No matches." : lines.join("\n");
  }

  private async listFiles(glob: string | undefined): Promise<string> {
    let output = await this.runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard",
      "--deduplicate", ...getPathspecArgs(glob)]);
    let files = [...new Set(output.split("\0").filter(file => file !== ""))].sort();
    return files.length === 0 ? "No files." : files.join("\n");
  }

  private async listChangedFiles(): Promise<string> {
    let files = await getChangedFiles(this.repoRoot, this.mergeBaseSha, this.gitOptions);
    return files.length === 0 ? "No files changed."
      : files.map(f => `${f.status} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ""}`).join("\n");
  }

  private async getFileDiff(file: string): Promise<string> {
    let pathspec = this.getLiteralPathspec(file);
    let diff = await this.readDiff(pathspec);
    if (diff !== "")
      return diff;
    let untracked = await this.runGit(["ls-files", "--others", "--exclude-standard", "--", pathspec]);
    return untracked.trim() !== "" ? `${file} is a new, untracked file; use read_file to see it.`
      : `No changes to ${file} since the merge-base.`;
  }

  /** Runs `git diff <merge-base> -- <pathspec>`. */
  private readDiff(pathspec: string): Promise<string> {
    return this.runGit(["diff", "--no-color", "--no-ext-diff", this.mergeBaseSha, "--", pathspec]);
  }

  /** Gets a literal pathspec (see toLiteralPathspec) of a path that a language model gave. */
  private getLiteralPathspec(file: string): string {
    return toLiteralPathspec(path.relative(this.repoRoot, resolveRepoPath(this.repoRoot, file)));
  }

  /** Runs git in the repo with the tools' timeout and abort signal. */
  private runGit(args: string[], acceptedExitCodes?: number[]): Promise<string> {
    return runGit(this.repoRoot, args, { ...this.gitOptions, acceptedExitCodes });
  }
}

/**
 * Converts a path that a language model gave into an absolute path in the repo. Throws if the path
 * is absolute, leads outside the repo (`..`), or is in a `.git` folder.
 */
export function resolveRepoPath(repoRoot: string, file: string): string {
  let normalized = file.replace(/\\/g, "/");
  if (normalized === "" || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized))
    throw new Error(`'${file}' is not a repo-relative path.`);
  let fullPath = path.resolve(repoRoot, ...normalized.split("/"));
  checkInsideRepo(repoRoot, fullPath, file);
  return fullPath;
}

/**
 * Cuts `text` to at most `maxChars` characters (at a line break, if there is one in its second
 * half) and appends a note saying how much was shown, followed by `hint`.
 */
export function truncateText(text: string, maxChars: number, hint: string): string {
  if (text.length <= maxChars)
    return text;
  let lineBreak = maxChars > 0 ? text.lastIndexOf("\n", maxChars - 1) : -1;
  let shown = text.slice(0, lineBreak >= maxChars / 2 ? lineBreak + 1 : maxChars);
  return `${shown}${shown === "" || shown.endsWith("\n") ? "" : "\n"}[Truncated: showed ${shown.length} of `
    + `${text.length} characters. ${hint}]`;
}

/**
 * Selects the hunks of `git diff` output whose lines on `side` ('modified' = new lines) overlap
 * lines `startLine`..`endLine`, or come within `nearbyLineCount` lines of them. Returns them
 * joined, or undefined if none.
 */
export function selectHunksNear(diffOutput: string, side: DiffSide, startLine: number, endLine: number)
  : string | undefined {
  let hunkTexts = diffOutput.split(/^(?=@@ )/m).slice(1);
  let selected = hunkTexts.filter(hunkText => {
    let [hunk] = parseDiffHunks(hunkText);
    let [start, count] = side === "base" ? [hunk.oldStart, hunk.oldCount] : [hunk.newStart, hunk.newCount];
    return start <= endLine + nearbyLineCount && start + Math.max(count, 1) - 1 >= startLine - nearbyLineCount;
  });
  return selected.length === 0 ? undefined : selected.join("").trimEnd();
}

/**
 * Throws if an absolute path is outside the repo or in a `.git` folder; `file` is the path that
 * the language model gave, for the message.
 */
function checkInsideRepo(repoRoot: string, fullPath: string, file: string): void {
  let relativePath = path.relative(repoRoot, fullPath);
  if (relativePath === ".." || relativePath.startsWith(".." + path.sep) || path.isAbsolute(relativePath))
    throw new Error(`'${file}' is outside the repo.`);
  if (relativePath.split(path.sep).some(segment => segment.toLowerCase() === ".git"))
    throw new Error(`'${file}' is in the .git folder, which the tools don't read.`);
}

/**
 * Gets a git pathspec that matches exactly the given path relative to the repo root, so that
 * wildcards and pathspec magic in it (e.g. `*` or `:(exclude)`) have no effect.
 */
function toLiteralPathspec(relativePath: string): string {
  return ":(literal)" + relativePath.split(path.sep).join("/");
}

/**
 * Gets the pathspec arguments for a glob that a language model gave: none for no glob; throws for
 * a pathspec with magic (`:(...)`), an absolute path or `..`.
 */
function getPathspecArgs(glob: string | undefined): string[] {
  if (glob === undefined || glob === "")
    return [];
  if (glob.startsWith(":") || glob.split(/[\\/]/).includes("..") || /^([\\/]|[A-Za-z]:)/.test(glob))
    throw new Error(`'${glob}' is not a repo-relative glob.`);
  return ["--", glob];
}

/** Gets a required string argument of a tool call, throwing if it is missing. */
function getString(args: Record<string, unknown>, name: string): string {
  let value = args[name];
  if (typeof value !== "string" || value === "")
    throw new Error(`the '${name}' argument (a string) is required.`);
  return value;
}

/** Gets an optional string argument of a tool call; undefined if it is missing or not a string. */
function getOptionalString(args: Record<string, unknown>, name: string): string | undefined {
  return typeof args[name] === "string" ? args[name] : undefined;
}

/** Gets an optional numeric argument of a tool call, rounded down to an integer. */
function getNumber(args: Record<string, unknown>, name: string): number | undefined {
  return typeof args[name] === "number" ? Math.floor(args[name]) : undefined;
}
