import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWorktree, findMergeBase, findRepoRoot, getChangedFiles, getCurrentBranch, getDefaultWorktreePath, getFileAtRevision,
  getGitCommonDir, listBranches, listWorktrees, parseBranchRefs, parseWorktreeList,
} from "./git";
import { createTempDir, TempRepo } from "./test-helpers";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (let cleanup of cleanups.splice(0))
    cleanup();
});

/** Creates a repo with `develop` (one extra commit) and `feature` branched from the first commit. */
function createRepoWithFeatureBranch() {
  let repo = TempRepo.create({ "a.txt": "a1\n", "b.txt": "b1\n", "gone.txt": "bye\n", "old name.txt": "x\n" });
  cleanups.push(() => repo.dispose());
  let firstSha = repo.git("rev-parse", "HEAD");
  repo.git("branch", "develop");
  repo.git("checkout", "-q", "-b", "feature");
  return { repo, firstSha };
}

describe("findMergeBase", () => {
  it("prefers origin/<base> over the local base branch", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    repo.writeFiles({ "a.txt": "a2\n" });
    let featureSha = repo.commitAll("feature change");
    repo.git("update-ref", "refs/remotes/origin/develop", featureSha);

    let result = await findMergeBase(repo.root, "develop");

    expect(result.baseRef).toBe("origin/develop");
    expect(result.mergeBaseSha).toBe(featureSha);
    expect(result.mergeBaseSha).not.toBe(firstSha);
  });

  it("falls back to the local base branch when origin/<base> is missing", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    repo.writeFiles({ "a.txt": "a2\n" });
    repo.commitAll("feature change");

    let result = await findMergeBase(repo.root, "develop");

    expect(result).toEqual({ baseRef: "develop", mergeBaseSha: firstSha });
  });

  it("throws a readable error when the base branch does not exist", async () => {
    let { repo } = createRepoWithFeatureBranch();
    await expect(findMergeBase(repo.root, "nonexistent")).rejects.toThrow(/nonexistent/);
  });
});

describe("getChangedFiles", () => {
  it("combines committed, staged, unstaged and untracked changes since the merge-base", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    // A change on develop after the branch point must not appear
    repo.git("checkout", "-q", "develop");
    repo.writeFiles({ "b.txt": "b2\n" });
    repo.commitAll("develop change");
    repo.git("checkout", "-q", "feature");
    repo.writeFiles({ "committed-new.txt": "n\n" });
    repo.commitAll("add file on feature");
    repo.git("mv", "old name.txt", "new name.txt");
    repo.writeFiles({ "a.txt": "a2 unstaged\n", "dir/untracked ü.txt": "u\n" });
    fs.rmSync(path.join(repo.root, "gone.txt"));

    let files = await getChangedFiles(repo.root, firstSha);

    expect(files).toEqual([
      { path: "a.txt", status: "Modified" },
      { path: "committed-new.txt", status: "Added" },
      { path: "dir/untracked ü.txt", status: "Added" },
      { path: "gone.txt", status: "Deleted" },
      { path: "new name.txt", status: "Renamed", oldPath: "old name.txt" },
    ]);
  });

  it("returns an empty list when nothing changed", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    expect(await getChangedFiles(repo.root, firstSha)).toEqual([]);
  });
});

describe("getFileAtRevision", () => {
  it("returns file content at a revision, or undefined when the file did not exist", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    repo.writeFiles({ "a.txt": "a2\n" });
    repo.commitAll("change");

    expect(await getFileAtRevision(repo.root, firstSha, "a.txt")).toBe("a1\n");
    expect(await getFileAtRevision(repo.root, firstSha, "missing.txt")).toBeUndefined();
  });
});

describe("repo queries", () => {
  it("findRepoRoot, getCurrentBranch and getGitCommonDir work from the main worktree", async () => {
    let { repo } = createRepoWithFeatureBranch();
    fs.mkdirSync(path.join(repo.root, "sub"));

    expect(await findRepoRoot(path.join(repo.root, "sub"))).toBe(repo.root);
    expect(await getCurrentBranch(repo.root)).toBe("feature");
    expect(await getGitCommonDir(repo.root)).toBe(path.join(repo.root, ".git"));
  });

  it("findRepoRoot returns undefined outside a repo", async () => {
    let dir = createTempDir();
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect(await findRepoRoot(dir)).toBeUndefined();
  });

  it("getCurrentBranch returns undefined on a detached HEAD", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    repo.git("checkout", "-q", firstSha);
    expect(await getCurrentBranch(repo.root)).toBeUndefined();
  });
});

describe("parseWorktreeList", () => {
  it("parses porcelain output including detached and bare worktrees", () => {
    let porcelain = [
      "worktree D:/Repo", "HEAD 1111111111111111111111111111111111111111", "branch refs/heads/feature/x", "",
      "worktree C:/Dev/Other", "HEAD 2222222222222222222222222222222222222222", "detached", "locked", "",
      "worktree D:/Bare", "bare", "",
    ].join("\n");

    expect(parseWorktreeList(porcelain)).toEqual([
      { path: path.resolve("D:/Repo"), head: "1111111111111111111111111111111111111111", branch: "feature/x" },
      { path: path.resolve("C:/Dev/Other"), head: "2222222222222222222222222222222222222222", branch: undefined },
    ]);
  });
});

describe("parseBranchRefs", () => {
  it("lists local branches plus remote-only branches, skipping origin/HEAD", () => {
    let refs = [
      "refs/heads/develop", "refs/heads/feature/a", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop",
      "refs/remotes/origin/feature/b", "refs/remotes/upstream/feature/b", "refs/remotes/upstream/feature/c",
    ];

    expect(parseBranchRefs(refs)).toEqual([
      { name: "develop", isLocal: true },
      { name: "feature/a", isLocal: true },
      { name: "feature/b", isLocal: false, remoteRef: "origin/feature/b" },
      { name: "feature/c", isLocal: false, remoteRef: "upstream/feature/c" },
    ]);
  });
});

describe("getDefaultWorktreePath", () => {
  it("uses a sibling '<repoName>.worktrees' folder unless a worktree root is configured", () => {
    expect(getDefaultWorktreePath(path.resolve("D:/src/Repo"), "", "feature/2460 x"))
      .toBe(path.resolve("D:/src/Repo.worktrees/feature-2460-x"));
    expect(getDefaultWorktreePath(path.resolve("D:/src/Repo"), "E:/wt", "fix"))
      .toBe(path.resolve("E:/wt/fix"));
  });
});

describe("worktrees", () => {
  it("addWorktree checks out a local branch, or creates a tracking branch for a remote-only branch", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    repo.git("remote", "add", "origin", repo.root);
    repo.git("update-ref", "refs/remotes/origin/remote-only", firstSha);
    let worktreeParent = createTempDir();
    cleanups.push(() => fs.rmSync(worktreeParent, { recursive: true, force: true }));
    let developPath = path.join(worktreeParent, "develop");
    let remotePath = path.join(worktreeParent, "remote-only");

    let branches = await listBranches(repo.root);
    await addWorktree(repo.root, developPath, branches.find(b => b.name === "develop")!);
    await addWorktree(repo.root, remotePath, branches.find(b => b.name === "remote-only")!);

    let worktrees = await listWorktrees(repo.root);
    expect(worktrees.map(w => [w.path, w.branch])).toEqual([
      [repo.root, "feature"], [developPath, "develop"], [remotePath, "remote-only"],
    ]);
    expect(await getGitCommonDir(remotePath)).toBe(path.join(repo.root, ".git"));
    expect(repo.git("rev-parse", "--abbrev-ref", "remote-only@{upstream}")).toBe("origin/remote-only");
  });
});
