import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getChangedFiles } from "./git";
import { applyHunks, mapBaseLineToWorkingTree, parseDiffHunks, readDiffHunks } from "./hunks";
import { TempRepo } from "./test-helpers";

let repos: TempRepo[] = [];
afterEach(() => {
  for (let repo of repos.splice(0))
    repo.dispose();
});

describe("parseDiffHunks", () => {
  it("reads every hunk header; an omitted count means 1", () => {
    let output = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2 +2 @@ class A\n-b\n+B\n@@ -4,2 +3,0 @@\n-d\n-e\n"
      + "@@ -9,0 +8,3 @@\n+x\n+y\n+z\n";

    expect(parseDiffHunks(output)).toEqual([
      { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
      { oldStart: 4, oldCount: 2, newStart: 3, newCount: 0 },
      { oldStart: 9, oldCount: 0, newStart: 8, newCount: 3 },
    ]);
  });
});

describe("mapBaseLineToWorkingTree", () => {
  it("shifts lines after hunks and puts removed or changed lines, in order, before the hunk's new lines",
    () => {
      // Base lines 3-4 became three lines; two lines were inserted after base line 5; base line 10
      // was removed after working-tree line 12
      let lines = (count: number) => Array<string>(count).fill("x\n");
      let hunks = [{ oldStart: 3, oldCount: 2, newStart: 3, newLines: lines(3) },
        { oldStart: 5, oldCount: 0, newStart: 7, newLines: lines(2) },
        { oldStart: 10, oldCount: 1, newStart: 12, newLines: [] }];
      expect([1, 3, 4, 5, 6, 9, 10, 11].map(line => mapBaseLineToWorkingTree(hunks, line)))
        .toEqual([1, 2 + 1 / 3, 2 + 2 / 3, 6, 9, 12, 12.5, 13]);
    });
});

describe("applyHunks", () => {
  const base = "a\nb\nc\nd\n";

  it("replaces, removes and inserts lines (at the top and at the end) by base line numbers", () => {
    expect(applyHunks(base, [
      { oldStart: 0, oldCount: 0, newLines: ["top\n"] },
      { oldStart: 2, oldCount: 1, newLines: ["B\n", "B2\n"] },
      { oldStart: 3, oldCount: 1, newLines: [] },
      { oldStart: 4, oldCount: 0, newLines: ["end\n"] },
    ])).toBe("top\na\nB\nB2\nd\nend\n");
    expect(applyHunks(base, [])).toBe(base);
  });

  it("keeps insertions at the same position in order, and keeps line terminators as they are", () => {
    expect(applyHunks("a\r\nb", [{ oldStart: 1, oldCount: 0, newLines: ["x\n"] },
      { oldStart: 1, oldCount: 0, newLines: ["y\r\n"] }])).toBe("a\r\nx\ny\r\nb");
  });
});

describe("readDiffHunks", () => {
  /** Creates a repo whose `develop` has `files`, on branch `feature`; returns it and the merge-base. */
  function createRepo(files: Record<string, string>) {
    let repo = TempRepo.create(files);
    repos.push(repo);
    repo.git("branch", "develop");
    repo.git("checkout", "-q", "-b", "feature");
    return { repo, mergeBaseSha: repo.git("rev-parse", "HEAD") };
  }

  async function readDiffs(repo: TempRepo, mergeBaseSha: string) {
    let files = await getChangedFiles(repo.root, mergeBaseSha);
    return Object.fromEntries(await Promise.all(files.map(async f => [f.path, await readDiffHunks(repo.root,
      mergeBaseSha, f)])));
  }

  it("gets hunks of modified, renamed, untracked and deleted files, with the new lines' text", async () => {
    let { repo, mergeBaseSha } = createRepo({ "m.txt": "a\nb\nc\nd\n", "old.txt": "1\n2\n3\n4\n5\n6\n7\n8\n",
      "gone.txt": "x\ny\n" });
    repo.git("mv", "old.txt", "new.txt");
    repo.git("rm", "-q", "gone.txt");
    repo.writeFiles({ "m.txt": "a\nB\nc\n", "new.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n", "added.txt": "p\nq",
      "added.bin": "p\0q\n" });

    expect(await readDiffs(repo, mergeBaseSha)).toEqual({
      "m.txt": [{ oldStart: 2, oldCount: 1, newStart: 2, newLines: ["B\n"] },
        { oldStart: 4, oldCount: 1, newStart: 3, newLines: [] }],
      "new.txt": [{ oldStart: 8, oldCount: 0, newStart: 9, newLines: ["9\n"] }],
      "added.txt": [{ oldStart: 0, oldCount: 0, newStart: 1, newLines: ["p\n", "q"] }],
      "added.bin": [],
      "gone.txt": [{ oldStart: 1, oldCount: 2, newStart: 0, newLines: [] }],
    });
  });

  it("gives a submodule no hunks", async () => {
    let { repo, mergeBaseSha } = createRepo({ "a.txt": "a\n" });
    let submodule = TempRepo.create({ "s.txt": "s\n" });
    repos.push(submodule);
    fs.cpSync(submodule.root, path.join(repo.root, "sub"), { recursive: true });
    repo.git("-c", "advice.addEmbeddedRepo=false", "add", "sub");

    expect(await readDiffs(repo, mergeBaseSha)).toEqual({ sub: [] });
  });

  it("gets hunks at the top and the end of a file, with CRLF and without a final line terminator", async () => {
    let { repo, mergeBaseSha } = createRepo({ "top.txt": "a\nb\nc\n", "end.txt": "a\r\nb\r\nc" });
    repo.writeFiles({ "top.txt": "c\n", "end.txt": "a\r\nb\r\nc\r\nd" });

    expect(await readDiffs(repo, mergeBaseSha)).toEqual({
      "top.txt": [{ oldStart: 1, oldCount: 2, newStart: 0, newLines: [] }],
      "end.txt": [{ oldStart: 3, oldCount: 1, newStart: 3, newLines: ["c\r\n", "d"] }],
    });
  });
});
