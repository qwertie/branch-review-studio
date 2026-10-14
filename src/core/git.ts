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

/** The commit that a branch's changes are compared against, and how it was found. */
export interface MergeBaseInfo {
  /**
   * The ref that was compared against, e.g. `origin/develop` or `develop`, or a commit SHA, tag or
   * other revision
   */
  baseRef: string;
  /** Commit that `baseRef` points to */
  baseSha: string;
  /** Commit checked out in the working tree (HEAD) */
  headSha: string;
  mergeBaseSha: string;
  /**
   * Set if `baseRef` already contains HEAD, e.g. because the branch was merged into it; then
   * `git merge-base <baseRef> HEAD` is HEAD itself, and `mergeBaseSha` is found another way (see
   * findMergeBase)
   */
  headInBase?: HeadInBaseInfo;
}

/** How findMergeBase chose the merge-base of a branch that the base already contains. */
export interface HeadInBaseInfo {
  /**
   * The commit on the base's first-parent history that merged HEAD into the base; undefined if
   * that history includes HEAD itself (after a fast-forward merge, or if the branch has no commits
   * of its own) or the merge is too far back to look for
   */
  mergeCommitSha: string | undefined;
  /** Whether the merge-base is one that the review recorded earlier (see findMergeBase) */
  isRecorded: boolean;
}

/** A working tree of the repo, from `git worktree list`. */
export interface WorktreeInfo {
  /** Absolute path in native format */
  path: string;
  /** SHA of the commit checked out in the worktree */
  head: string;
  /** Short branch name, or undefined if the worktree has a detached HEAD */
  branch: string | undefined;
}

/** A branch that Switch Branch can open. */
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
 * baseRef is `baseBranch` if that is a commit SHA, else `origin/<baseBranch>` if it exists, else
 * `<baseBranch>` (a local branch, tag or other revision).
 *
 * If baseRef already contains HEAD, that merge-base is HEAD, so the diff would show only
 * uncommitted changes. Then, if baseRef's first-parent history has a merge commit M that brought
 * HEAD in, the merge-base is `git merge-base M^1 HEAD`, i.e. the merge-base as it was before the
 * merge. Otherwise (e.g. after a fast-forward merge) it is the first of `recordedMergeBases` that
 * is an ancestor of HEAD other than HEAD itself, if any.
 */
export async function findMergeBase(repoRoot: string, baseBranch: string, recordedMergeBases: string[] = [])
  : Promise<MergeBaseInfo> {
  let base = await findBaseRef(repoRoot, baseBranch);
  if (base === undefined) {
    throw new GitError(`Base '${baseBranch}' was not found (neither origin/${baseBranch} nor ${baseBranch} is a `
      + "branch or commit).");
  }
  let headSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).trim();
  let mergeBaseSha = (await runGit(repoRoot, ["merge-base", base.sha, headSha])).trim();
  let info: MergeBaseInfo = { baseRef: base.ref, baseSha: base.sha, headSha, mergeBaseSha };
  if (mergeBaseSha === headSha) {
    let merge = await findMergeOfHead(repoRoot, base.sha, headSha);
    let recordedSha = merge ? undefined : await findAsync(recordedMergeBases, async sha => sha !== headSha
      && await tryRunGit(repoRoot, ["merge-base", "--is-ancestor", sha, headSha]) !== undefined);
    info.mergeBaseSha = merge?.mergeBaseSha ?? recordedSha ?? headSha;
    info.headInBase = { mergeCommitSha: merge?.mergeCommitSha, isRecorded: recordedSha !== undefined };
  }
  return info;
}

/**
 * Counts the commits in HEAD's history that aren't in `sha`'s; returns undefined if HEAD's history
 * doesn't contain `sha` (e.g. after a rebase) or `sha` doesn't exist.
 */
export async function countCommitsSince(repoRoot: string, sha: string): Promise<number | undefined> {
  let output = await tryRunGit(repoRoot, ["rev-list", "--left-right", "--count", `${sha}...HEAD`]);
  let [onlyInSha, onlyInHead] = output?.trim().split(/\s+/).map(Number) ?? [];
  return onlyInSha === 0 ? onlyInHead : undefined;
}

/**
 * Gets whether `revision` is the commit SHA `sha` or an abbreviation of it, i.e. names the commit by
 * its SHA rather than by a branch or tag.
 */
export function isShaOf(revision: string, sha: string): boolean {
  return sha.startsWith(revision.toLowerCase());
}

/** Gets the full SHA of the commit that `revision` names, or undefined if it names none. */
export async function tryGetCommitSha(repoRoot: string, revision: string): Promise<string | undefined> {
  return (await tryRunGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]))?.trim();
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
  return files.sort(comparePaths);
}

/** Gets the text of a file at a revision, or undefined if the file does not exist there. */
export function getFileAtRevision(repoRoot: string, revision: string, filePath: string)
  : Promise<string | undefined> {
  return tryRunGit(repoRoot, ["show", `${revision}:${filePath}`]);
}

/** Gets the top folder of the working tree containing `folder`; undefined if not in a repo. */
export async function findRepoRoot(folder: string): Promise<string | undefined> {
  let output = await tryRunGit(folder, ["rev-parse", "--show-toplevel"]);
  return output === undefined ? undefined : path.resolve(output.trim());
}

/** Gets the checked-out branch's short name, or undefined on a detached HEAD. */
export async function getCurrentBranch(repoRoot: string): Promise<string | undefined> {
  return (await tryRunGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim();
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

/** Lists local branches plus remote-only branches, most recently committed first. */
export async function listBranches(repoRoot: string): Promise<BranchInfo[]> {
  let output = await runGit(repoRoot,
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"]);
  return parseBranchRefs(output.split("\n").filter(line => line !== ""));
}

/**
 * Gets the branch names offered by Change Base Branch: `currentBase` first (even if it doesn't
 * exist), then develop, main and master if they exist, then the other `branches` in their order.
 * Excludes `currentBranch`, since a branch's merge-base with itself is HEAD, and branches that
 * exist only on a remote other than origin, since findMergeBase looks only in origin.
 */
export function getBaseBranchChoices(branches: BranchInfo[], currentBase: string, currentBranch: string | undefined)
  : string[] {
  let names = branches.filter(b => b.isLocal || b.remoteRef?.startsWith("origin/")).map(b => b.name);
  let preferredNames = ["develop", "main", "master"].filter(name => names.includes(name));
  return [...new Set([currentBase, ...preferredNames, ...names])].filter(name => name !== currentBranch);
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
 * `worktreeRoot` or, if that is empty, of a sibling of the main worktree named
 * `<repoName>.worktrees`.
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
  return (await tryRunGit(repoRoot, ["config", "--get", key]))?.trim();
}

/** Orders items by `path` (ordinal string comparison), for use with `Array.sort`. */
export function comparePaths(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
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
      let isOriginReplacingOtherRemote = remote === "origin" && existing?.isLocal === false
        && !existing.remoteRef?.startsWith("origin/");
      if (existing === undefined || isOriginReplacingOtherRemote)
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

/** Runs git like `runGit`, but returns undefined instead of throwing GitError. */
async function tryRunGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await runGit(cwd, args);
  } catch (e) {
    if (e instanceof GitError)
      return undefined;
    throw e;
  }
}

/**
 * Finds the ref that findMergeBase compares against, and its commit: `baseBranch` if it is a
 * (possibly abbreviated) commit SHA or can't be a branch name (e.g. `develop~3`), else
 * `origin/<baseBranch>`, else `<baseBranch>` as a local branch or any other revision (e.g. a tag).
 */
async function findBaseRef(repoRoot: string, baseBranch: string): Promise<{ ref: string, sha: string } | undefined> {
  let sha = await tryGetCommitSha(repoRoot, baseBranch);
  // The characters that `git check-ref-format` forbids in ref names, other than "/" and "."
  let isRevisionExpression = /[~^:?*[\\\s]|@\{/.test(baseBranch);
  if (sha && (isShaOf(baseBranch, sha) || isRevisionExpression))
    return { ref: baseBranch, sha };
  for (let [ref, fullRef] of [[`origin/${baseBranch}`, `refs/remotes/origin/${baseBranch}`],
    [baseBranch, `refs/heads/${baseBranch}`]]) {
    let branchSha = await tryGetCommitSha(repoRoot, fullRef);
    if (branchSha !== undefined)
      return { ref, sha: branchSha };
  }
  return sha === undefined ? undefined : { ref: baseBranch, sha };
}

/**
 * For a base commit that contains HEAD, finds the oldest commit M on the base's first-parent
 * history that contains HEAD and, if M is a merge (M^1 lacks HEAD), returns M and
 * `git merge-base M^1 HEAD`. Returns undefined if HEAD is on that history or M is further back
 * than maxFirstParentCommits. Results are cached, since the view refreshes often.
 */
function findMergeOfHead(repoRoot: string, baseSha: string, headSha: string): Promise<MergeOfHead | undefined> {
  let key = `${baseSha} ${headSha}`;
  let result = mergeOfHeadCache.get(key);
  if (result === undefined) {
    if (mergeOfHeadCache.size >= 100)
      mergeOfHeadCache.clear();
    result = findMergeOfHeadCore();
    mergeOfHeadCache.set(key, result);
    result.catch(() => mergeOfHeadCache.delete(key));
  }
  return result;

  async function findMergeOfHeadCore(): Promise<MergeOfHead | undefined> {
    let range = `${headSha}..${baseSha}`;
    let [firstParentOutput, descendantOutput] = await Promise.all([
      runGit(repoRoot, ["rev-list", "--first-parent", "--parents", `--max-count=${maxFirstParentCommits}`, range]),
      runGit(repoRoot, ["rev-list", "--ancestry-path", range]),
    ]);
    // The base's first-parent history (newest first, each commit with its parents) contains HEAD
    // from its start up to M; if all of the listed part contains HEAD, M may be further back
    let descendants = new Set(descendantOutput.split("\n"));
    let firstParents = firstParentOutput.split("\n").filter(line => line !== "").map(line => line.split(" "));
    let mIndex = firstParents.findLastIndex(([sha]) => descendants.has(sha));
    let [mergeCommitSha, firstParentSha] = mIndex < maxFirstParentCommits - 1 ? firstParents[mIndex] ?? [] : [];
    let mergeBaseSha = firstParentSha !== undefined && firstParentSha !== headSha
      ? (await tryRunGit(repoRoot, ["merge-base", firstParentSha, headSha]))?.trim() : undefined;
    return mergeBaseSha ? { mergeCommitSha, mergeBaseSha } : undefined;
  }
}

/** A merge commit that brought HEAD into the base, and HEAD's merge-base with the commit's first parent. */
interface MergeOfHead {
  mergeCommitSha: string;
  mergeBaseSha: string;
}

/** Caches the results of findMergeOfHead by base and HEAD commit. */
const mergeOfHeadCache = new Map<string, Promise<MergeOfHead | undefined>>();
/**
 * findMergeOfHead looks for the merge of HEAD among this many of the newest commits of the base's
 * first-parent history.
 */
const maxFirstParentCommits = 10_000;

/** Finds the first item for which `predicate` returns true, testing one item at a time. */
async function findAsync<T>(items: T[], predicate: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (let item of items) {
    if (await predicate(item))
      return item;
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
