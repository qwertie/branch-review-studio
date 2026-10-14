import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWorktree, countCommitsSince, findMergeBase, findRepoRoot, getBaseBranchChoices, getChangedFiles,
  getCurrentBranch, getDefaultWorktreePath, getFileAtRevision, getGitCommonDir, listBranches, listWorktrees,
  parseBranchRefs, parseWorktreeList,
} from "./git";
import { createTempDir, TempRepo } from "./test-helpers";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (let cleanup of cleanups.splice(0))
    cleanup();
});

/** Creates a repo with `develop` and `feature`, both pointing at the first commit. */
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

    expect(result).toMatchObject({ baseRef: "develop", mergeBaseSha: firstSha });
  });

  it("throws a readable error when the base branch does not exist", async () => {
    let { repo } = createRepoWithFeatureBranch();
    await expect(findMergeBase(repo.root, "nonexistent")).rejects.toThrow(/nonexistent/);
  });

  it("returns the SHAs of HEAD and the base ref", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    let headSha = commitOn(repo, "feature", { "a.txt": "a2\n" });
    let developSha = commitOn(repo, "develop", { "b.txt": "b2\n" });
    repo.git("checkout", "-q", "feature");

    expect(await findMergeBase(repo.root, "develop"))
      .toEqual({ baseRef: "develop", baseSha: developSha, headSha, mergeBaseSha: firstSha });
  });

  it("accepts a commit SHA, an abbreviated SHA, a tag or a revision expression as the base, without looking for "
    + "origin/<sha> or origin/<expression>", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    let headSha = commitOn(repo, "feature", { "a.txt": "a2\n" });
    let developSha = commitOn(repo, "develop", { "b.txt": "b2\n" });
    commitOn(repo, "develop", { "b.txt": "b3\n" });
    repo.git("checkout", "-q", "feature");
    repo.git("tag", "v1", developSha);
    repo.git("update-ref", `refs/remotes/origin/${developSha}`, repo.git("rev-parse", "develop"));
    repo.git("update-ref", "refs/remotes/origin/develop", headSha);

    for (let base of [developSha, developSha.slice(0, 8), "v1", "develop~1"]) {
      expect(await findMergeBase(repo.root, base))
        .toEqual({ baseRef: base, baseSha: developSha, headSha, mergeBaseSha: firstSha });
    }
  });

  it("when the base merged the branch with a merge commit, uses the merge-base from before that merge, which is "
    + "the last base commit that the branch merged", async () => {
    let { repo, lastMergedDevelopSha, headSha } = createBranchThatMergedDevelopTwice();
    let developBeforeMergeSha = commitOn(repo, "develop", { "b.txt": "b4\n" });
    repo.git("merge", "-q", "--no-ff", "-m", "Merge feature", "feature");
    let mergeCommitSha = repo.git("rev-parse", "HEAD");
    commitOn(repo, "develop", { "b.txt": "b5\n" });
    repo.git("checkout", "-q", "feature");

    expect(await findMergeBase(repo.root, "develop")).toMatchObject({ baseRef: "develop", headSha,
      mergeBaseSha: lastMergedDevelopSha, headInBase: { mergeCommitSha, isRecorded: false } });
    // Comparing against the base as it was before the merge needs no special handling
    expect(await findMergeBase(repo.root, developBeforeMergeSha)).toEqual({ baseRef: developBeforeMergeSha,
      baseSha: developBeforeMergeSha, headSha, mergeBaseSha: lastMergedDevelopSha });
  });

  it("when the base was fast-forwarded to the branch, falls back to the first recorded merge-base that is an "
    + "ancestor of HEAD, else HEAD", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    let headSha = commitOn(repo, "feature", { "a.txt": "a2\n" });
    repo.git("checkout", "-q", "develop");
    repo.git("merge", "-q", "--ff-only", "feature");
    let laterDevelopSha = commitOn(repo, "develop", { "b.txt": "b2\n" });
    repo.git("checkout", "-q", "feature");

    expect(await findMergeBase(repo.root, "develop"))
      .toMatchObject({ mergeBaseSha: headSha, headInBase: { mergeCommitSha: undefined, isRecorded: false } });
    expect(await findMergeBase(repo.root, "develop", [headSha, laterDevelopSha, "0".repeat(40), firstSha]))
      .toMatchObject({ mergeBaseSha: firstSha, headInBase: { mergeCommitSha: undefined, isRecorded: true } });
  });

  it("treats a branch without commits of its own like a fast-forwarded one", async () => {
    let { repo } = createRepoWithFeatureBranch();
    commitOn(repo, "develop", { "b.txt": "b2\n" });
    repo.git("checkout", "-q", "feature");
    let headSha = repo.git("rev-parse", "HEAD");

    expect(await findMergeBase(repo.root, "develop", [headSha]))
      .toMatchObject({ mergeBaseSha: headSha, headInBase: { mergeCommitSha: undefined, isRecorded: false } });
  });

  it("is unaffected by a squash merge, since the base then doesn't contain HEAD", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    let headSha = commitOn(repo, "feature", { "a.txt": "a2\n" });
    repo.git("checkout", "-q", "develop");
    repo.git("merge", "-q", "--squash", "feature");
    let developSha = repo.commitAll("Squashed feature");
    repo.git("checkout", "-q", "feature");

    expect(await findMergeBase(repo.root, "develop"))
      .toEqual({ baseRef: "develop", baseSha: developSha, headSha, mergeBaseSha: firstSha });
  });
});

describe("countCommitsSince", () => {
  it("counts HEAD's new commits, or returns undefined if HEAD's history lacks the commit", async () => {
    let { repo, firstSha } = createRepoWithFeatureBranch();
    let secondSha = commitOn(repo, "feature", { "a.txt": "a2\n" });
    commitOn(repo, "feature", { "a.txt": "a3\n" });
    let developSha = commitOn(repo, "develop", { "b.txt": "b2\n" });
    repo.git("checkout", "-q", "feature");

    expect(await countCommitsSince(repo.root, firstSha)).toBe(2);
    expect(await countCommitsSince(repo.root, secondSha)).toBe(1);
    expect(await countCommitsSince(repo.root, repo.git("rev-parse", "HEAD"))).toBe(0);
    expect(await countCommitsSince(repo.root, developSha)).toBeUndefined();
    expect(await countCommitsSince(repo.root, "0".repeat(40))).toBeUndefined();
  });
});

/** Checks out `branch`, commits `files` there and returns the commit's SHA; leaves `branch` checked out. */
function commitOn(repo: TempRepo, branch: string, files: Record<string, string>): string {
  repo.git("checkout", "-q", branch);
  repo.writeFiles(files);
  return repo.commitAll(`${branch}: ${Object.values(files).join(" ").trim()}`);
}

/**
 * Creates a `feature` branch that merged `develop` twice (each time after develop gained a commit)
 * and then gained another commit; leaves `develop` checked out.
 */
function createBranchThatMergedDevelopTwice() {
  let { repo } = createRepoWithFeatureBranch();
  let lastMergedDevelopSha = "";
  for (let i = 2; i <= 3; i++) {
    commitOn(repo, "feature", { "a.txt": `a${i}\n` });
    lastMergedDevelopSha = commitOn(repo, "develop", { "b.txt": `b${i}\n` });
    repo.git("checkout", "-q", "feature");
    repo.git("merge", "-q", "--no-ff", "-m", "Merge develop", "develop");
  }
  let headSha = commitOn(repo, "feature", { "a.txt": "a4\n" });
  repo.git("checkout", "-q", "develop");
  return { repo, lastMergedDevelopSha, headSha };
}

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

describe("getBaseBranchChoices", () => {
  let branches = parseBranchRefs(["refs/heads/feature/x", "refs/heads/zeta", "refs/heads/master",
    "refs/heads/develop", "refs/remotes/origin/develop", "refs/remotes/origin/alpha", "refs/remotes/origin/main",
    "refs/remotes/upstream/beta"]);

  it("lists the current base, then develop/main/master, then the rest, without the current branch", () => {
    expect(getBaseBranchChoices(branches, "alpha", "feature/x"))
      .toEqual(["alpha", "develop", "main", "master", "zeta"]);
  });

  it("lists develop once though origin/develop also exists, lists a missing current base first, and omits "
    + "branches that exist only on a remote other than origin", () => {
    expect(getBaseBranchChoices(branches, "release/1", "zeta"))
      .toEqual(["release/1", "develop", "main", "master", "feature/x", "alpha"]);
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
