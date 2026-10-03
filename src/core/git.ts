import { execFile } from "node:child_process";
import * as path from "node:path";

/** How a file differs between the merge-base and the working tree. */
export type ChangeStatus = "Added" | "Modified" | "Deleted" | "Renamed";

/** A file that differs between the merge-base and the working tree (including untracked files). */
export interface ChangedFile {
  /** Repo-relative path with forward slashes (the new path, for renames) */
  path: string;
  status: ChangeStatus;
  /** Repo-relative path at the merge-base; set only when `status` is Renamed */
  oldPath?: string;
}

export interface MergeBaseInfo {
  /** The ref that was compared against, e.g. `origin/develop` or `develop` */
  baseRef: string;
  mergeBaseSha: string;
}

export interface WorktreeInfo {
  /** Absolute path in native format */
  path: string;
  head: string;
  /** Short branch name, or undefined if the worktree has a detached HEAD */
  branch: string | undefined;
}

export interface BranchInfo {
  /** Short branch name without the remote prefix, e.g. `feature/x` */
  name: string;
  /** Whether `refs/heads/<name>` exists */
  isLocal: boolean;
  /** For branches that exist only on a remote, the remote-tracking ref, e.g. `origin/feature/x` */
  remoteRef?: string;
}

/** Thrown when a git command fails; `message` includes git's stderr. */
export class GitError extends Error {}

/**
 * Finds the commit to diff the working tree against: `git merge-base <baseRef> HEAD`, where
 * baseRef is `origin/<baseBranch>` if it exists, else `<baseBranch>`.
 */
export async function findMergeBase(repoRoot: string, baseBranch: string): Promise<MergeBaseInfo> {
  let baseRef = await findBaseRef(repoRoot, baseBranch);
  if (baseRef === undefined)
    throw new GitError(`Base branch '${baseBranch}' was not found (neither origin/${baseBranch} nor ${baseBranch}).`);
  let mergeBaseSha = (await runGit(repoRoot, ["merge-base", baseRef, "HEAD"])).trim();
  return { baseRef, mergeBaseSha };
}

/**
 * Lists files whose working-tree content (including staged, unstaged and untracked changes)
 * differs from `mergeBase`, sorted by path.
 */
export async function getChangedFiles(repoRoot: string, mergeBase: string): Promise<ChangedFile[]> {
  let [diffOutput, untrackedOutput] = await Promise.all([
    runGit(repoRoot, ["diff", "--name-status", "-z", "-M", "--no-ext-diff", mergeBase, "--"]),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  let files = parseNameStatus(diffOutput);
  for (let untrackedPath of splitNul(untrackedOutput))
    files.push({ path: untrackedPath, status: "Added" });
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Gets the text of a file at a revision, or undefined if the file does not exist there. */
export async function getFileAtRevision(repoRoot: string, revision: string, filePath: string)
  : Promise<string | undefined> {
  try {
    return await runGit(repoRoot, ["show", `${revision}:${filePath}`]);
  } catch (e) {
    if (e instanceof GitError)
      return undefined;
    throw e;
  }
}

/** Gets the top-level folder of the working tree containing `folder`, or undefined if not in a repo. */
export async function findRepoRoot(folder: string): Promise<string | undefined> {
  try {
    return path.resolve((await runGit(folder, ["rev-parse", "--show-toplevel"])).trim());
  } catch (e) {
    if (e instanceof GitError)
      return undefined;
    throw e;
  }
}

/** Gets the checked-out branch's short name, or undefined on a detached HEAD. */
export async function getCurrentBranch(repoRoot: string): Promise<string | undefined> {
  try {
    return (await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch (e) {
    if (e instanceof GitError)
      return undefined;
    throw e;
  }
}

/** Gets the absolute `.git` folder shared by all worktrees of the repo. */
export async function getGitCommonDir(repoRoot: string): Promise<string> {
  return path.resolve((await runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
}

/** Gets the absolute git folder of this worktree (where its HEAD file lives). */
export async function getGitDir(repoRoot: string): Promise<string> {
  return path.resolve((await runGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim());
}

/** Lists the repo's worktrees (excluding bare ones); the main worktree comes first. */
export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  return parseWorktreeList(await runGit(repoRoot, ["worktree", "list", "--porcelain"]));
}

/** Lists local branches plus branches that exist only on a remote, most recently committed first. */
export async function listBranches(repoRoot: string): Promise<BranchInfo[]> {
  let output = await runGit(repoRoot,
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  return parseBranchRefs(output.split("\n").filter(line => line !== ""));
}

/**
 * Creates a worktree at `worktreePath` with `branch` checked out. For a remote-only branch, it
 * creates a local branch of the same name that tracks the remote branch.
 */
export async function addWorktree(repoRoot: string, worktreePath: string, branch: BranchInfo): Promise<void> {
  let args = branch.isLocal || branch.remoteRef === undefined
    ? ["worktree", "add", worktreePath, branch.name]
    : ["worktree", "add", "--track", "-b", branch.name, worktreePath, branch.remoteRef];
  await runGit(repoRoot, args);
}

/**
 * Gets the folder in which Switch Branch creates a new worktree for `branch`: a subfolder of
 * `worktreeRoot` or, if that is empty, of a sibling of the main worktree named `<repoName>.worktrees`.
 */
export function getDefaultWorktreePath(mainWorktreePath: string, worktreeRoot: string, branch: string): string {
  let root = worktreeRoot || path.join(path.dirname(mainWorktreePath), path.basename(mainWorktreePath) + ".worktrees");
  return path.resolve(root, branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
}

/** Runs `git fetch <remote> <branch>`. */
export async function fetchBranch(repoRoot: string, remote: string, branch: string): Promise<void> {
  await runGit(repoRoot, ["fetch", remote, branch]);
}

/** Gets a git config value such as `user.name`, or undefined if unset. */
export async function getConfigValue(repoRoot: string, key: string): Promise<string | undefined> {
  try {
    return (await runGit(repoRoot, ["config", "--get", key])).trim();
  } catch (e) {
    if (e instanceof GitError)
      return undefined;
    throw e;
  }
}

/** Parses `git worktree list --porcelain` output, skipping bare entries. */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  let worktrees: WorktreeInfo[] = [];
  for (let block of porcelain.split(/\r?\n\r?\n/)) {
    let lines = block.split(/\r?\n/).filter(line => line !== "");
    let worktreeLine = lines.find(line => line.startsWith("worktree "));
    if (worktreeLine !== undefined && !lines.includes("bare")) {
      let branchRef = lines.find(line => line.startsWith("branch "))?.slice("branch ".length);
      worktrees.push({
        path: path.resolve(worktreeLine.slice("worktree ".length)),
        head: lines.find(line => line.startsWith("HEAD "))?.slice("HEAD ".length) ?? "",
        branch: branchRef?.replace(/^refs\/heads\//, ""),
      });
    }
  }
  return worktrees;
}

/**
 * Converts full ref names (refs/heads/..., refs/remotes/...) into a branch list in which a remote
 * branch appears only if no local branch has the same name; `origin` wins over other remotes.
 */
export function parseBranchRefs(refNames: string[]): BranchInfo[] {
  let branches = new Map<string, BranchInfo>();
  for (let ref of refNames) {
    if (ref.startsWith("refs/heads/")) {
      let name = ref.slice("refs/heads/".length);
      branches.set(name, { name, isLocal: true });
    }
  }
  for (let ref of refNames) {
    let match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
    if (match && match[2] !== "HEAD") {
      let [, remote, name] = match;
      let existing = branches.get(name);
      if (existing === undefined || (!existing.isLocal && remote === "origin" && !existing.remoteRef?.startsWith("origin/")))
        branches.set(name, { name, isLocal: false, remoteRef: `${remote}/${name}` });
    }
  }
  return [...branches.values()];
}

/** Runs git without a shell and returns stdout; throws GitError on a nonzero exit code. */
export function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.quotepath=false", ...args],
      { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          reject(new GitError(`git ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
        else
          resolve(stdout);
      });
  });
}

/** Finds `origin/<baseBranch>`, else `<baseBranch>` as a local branch or any other revision. */
async function findBaseRef(repoRoot: string, baseBranch: string): Promise<string | undefined> {
  for (let [candidate, fullRef] of [
    [`origin/${baseBranch}`, `refs/remotes/origin/${baseBranch}`],
    [baseBranch, `refs/heads/${baseBranch}`],
    [baseBranch, baseBranch],
  ]) {
    try {
      await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${fullRef}^{commit}`]);
      return candidate;
    } catch (e) {
      if (!(e instanceof GitError))
        throw e;
    }
  }
  return undefined;
}

/** Parses `git diff --name-status -z` output. */
function parseNameStatus(output: string): ChangedFile[] {
  let fields = splitNul(output);
  let files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    let code = fields[i][0];
    if (code === "R") {
      files.push({ path: fields[i + 2], status: "Renamed", oldPath: fields[i + 1] });
      i += 2;
    } else if (code === "C") {
      files.push({ path: fields[i + 2], status: "Added" });
      i += 2;
    } else {
      files.push({ path: fields[++i], status: code === "A" ? "Added" : code === "D" ? "Deleted" : "Modified" });
    }
  }
  return files;
}

function splitNul(output: string): string[] {
  return output.split("\0").filter(field => field !== "");
}
