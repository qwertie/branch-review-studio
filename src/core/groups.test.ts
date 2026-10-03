import { afterEach, describe, expect, it } from "vitest";
import { getChangedFiles } from "./git";
import {
  arrangeGroups, assignHunksToGroups, buildGroupViewText, ChangeGroupsInput, createChangeGroups, FileGroupsInput,
} from "./groups";
import { ChangeGroups, GroupedFile, GroupedHunk } from "./review";
import { TempRepo } from "./test-helpers";

let repos: TempRepo[] = [];
afterEach(() => {
  for (let repo of repos.splice(0))
    repo.dispose();
});

/** Lines "a\n", "b\n", ... for each letter of `letters` */
function toLines(letters: string): string[] {
  return [...letters].map(ch => ch + "\n");
}

/**
 * Commits `baseText` as f.txt on `develop`, writes `workingText` on branch `feature`, groups f.txt
 * with createChangeGroups, and returns the grouped file and the notes.
 */
async function groupFile(baseText: string | undefined, workingText: string, groups: FileGroupsInput["groups"]) {
  let repo = TempRepo.create(baseText === undefined ? undefined : { "f.txt": baseText });
  repos.push(repo);
  let mergeBaseSha = repo.git("rev-parse", "HEAD");
  repo.writeFiles({ "f.txt": workingText });
  let input: ChangeGroupsInput = { groups: groups.map(g => ({ id: g.groupId, name: g.groupId, summary: "" })),
    files: [{ file: "f.txt", groups }] };
  let { changeGroups, notes } = await createChangeGroups(repo.root, mergeBaseSha,
    await getChangedFiles(repo.root, mergeBaseSha), input);
  return { groupedFile: changeGroups.files[0], notes };
}

describe("buildGroupViewText (with createChangeGroups)", () => {
  const base = toLines("abcdefgh").join("");

  it("hides other groups' hunks, matches removals by the line above or below, keeps unassigned hunks",
    async () => {
      // Working lines: 1 a, 2 B (group A), 3 c, [d removed: group B], 4 e, 5 F (no group), 6 g, 7 h, 8 i (group A)
      let working = "a\nB\nc\ne\nF\ng\nh\ni\n";
      for (let removalLine of [3, 4]) {
        let { groupedFile, notes } = await groupFile(base, working, [
          { groupId: "A", ranges: [{ startLine: 2, endLine: 2 }, { startLine: 8, endLine: 8 }] },
          { groupId: "B", ranges: [{ startLine: removalLine, endLine: removalLine }] },
        ]);

        expect(buildGroupViewText(base, groupedFile, "A")).toBe("a\nb\nc\ne\nf\ng\nh\n");
        expect(buildGroupViewText(base, groupedFile, "B")).toBe("a\nB\nc\nd\ne\nf\ng\nh\ni\n");
        expect(notes).toEqual(["f.txt: no range covers line 5, so these changes appear in every group that lists "
          + "the file."]);
      }
    });

  it("splits an insertion (e.g. a new file) among groups; overlapping ranges put lines in both groups", async () => {
    let { groupedFile } = await groupFile(undefined, toLines("123456").join(""), [
      { groupId: "A", ranges: [{ startLine: 1, endLine: 3 }] },
      { groupId: "B", ranges: [{ startLine: 3, endLine: 6 }] },
    ]);

    expect(groupedFile.hunks).toEqual([
      { oldStart: 0, oldCount: 0, newCount: 2, newLines: ["1\n", "2\n"], groupIds: ["A"] },
      { oldStart: 0, oldCount: 0, newCount: 1, groupIds: ["A", "B"] },
      { oldStart: 0, oldCount: 0, newCount: 3, newLines: ["4\n", "5\n", "6\n"], groupIds: ["B"] },
    ]);
    expect(buildGroupViewText("", groupedFile, "A")).toBe("4\n5\n6\n");
    expect(buildGroupViewText("", groupedFile, "B")).toBe("1\n2\n");
  });

  it("keeps a replacement whole, in every group whose ranges overlap it", async () => {
    let { groupedFile } = await groupFile(base, "a\nB\nC\nd\ne\nf\ng\nh\n", [
      { groupId: "A", ranges: [{ startLine: 2, endLine: 2 }] },
      { groupId: "B", ranges: [{ startLine: 3, endLine: 3 }] },
    ]);

    expect(groupedFile.hunks).toEqual([{ oldStart: 2, oldCount: 2, newCount: 2, groupIds: ["A", "B"] }]);
    expect(buildGroupViewText(base, groupedFile, "A")).toBe(base);
  });
});

describe("assignHunksToGroups", () => {
  it("gives every hunk to a file's only group if it has no ranges, and reports ranges that overlap no hunk", () => {
    let hunks = [{ oldStart: 2, oldCount: 1, newStart: 2, newLines: ["B\n"] },
      { oldStart: 5, oldCount: 0, newStart: 5, newLines: ["x\n"] }];

    expect(assignHunksToGroups(hunks, [{ groupId: "A" }])).toEqual({ unmatchedRanges: [], unassignedLines: [],
      hunks: [{ oldStart: 2, oldCount: 1, newCount: 1, groupIds: ["A"] },
        { oldStart: 5, oldCount: 0, newCount: 1, groupIds: ["A"] }] });
    expect(assignHunksToGroups(hunks, [{ groupId: "A", ranges: [{ startLine: 9, endLine: 9 }] }]))
      .toMatchObject({ unmatchedRanges: [{ groupId: "A", range: { startLine: 9, endLine: 9 } }],
        unassignedLines: ["line 2", "line 5"] });
  });

  it("describes unassigned removals at the top of the file and after a line", () => {
    let hunks = [{ oldStart: 1, oldCount: 2, newStart: 0, newLines: [] },
      { oldStart: 6, oldCount: 1, newStart: 3, newLines: [] }];

    expect(assignHunksToGroups(hunks, [{ groupId: "A", ranges: [{ startLine: 9, endLine: 9 }] }]).unassignedLines)
      .toEqual(["the removal at the top of the file", "the removal after line 3"]);
  });
});

describe("arrangeGroups", () => {
  /** Creates a hunk of `size` changed lines in the given groups */
  const hunk = (size: number, ...groupIds: string[]): GroupedHunk =>
    ({ oldStart: 1, oldCount: size, newCount: 1, newLines: ["x\n"], groupIds });
  const file = (path: string, ...hunks: GroupedHunk[]): GroupedFile =>
    ({ file: path, groupIds: [...new Set(hunks.flatMap(h => h.groupIds))], hunks });
  const changeGroups: ChangeGroups = { mergeBaseSha: "mb", createdAt: "", groups: [
    { id: "big", name: "Big", summary: "" }, { id: "small", name: "Small", summary: "s" },
    { id: "tie", name: "Tie", summary: "" }, { id: "gone", name: "Gone", summary: "" },
  ], files: [
    file("z.ts", hunk(10, "big"), hunk(2, "small")),
    file("a.ts", hunk(5, "big")),
    file("t.ts", hunk(2, "tie")),
    { file: "unassigned.ts", groupIds: ["tie"], hunks: [hunk(3)] },
    file("reverted.ts", hunk(9, "gone")),
    { file: "image.png", groupIds: ["small"], hunks: [] },
  ] };
  const describeLayout = (layout: ReturnType<typeof arrangeGroups>) => layout.groups.map(g => `${g.name} `
    + `${g.changedLines}: ${g.files.map(f => f.path + (f.isPartial ? " (partial)" : "")).join(", ")}`);

  it("sorts groups smallest first (empty ones included), lists files under each of their groups, and ends with "
    + "Ungrouped", () => {
    let layout = arrangeGroups(changeGroups, ["a.ts", "image.png", "new.ts", "t.ts", "unassigned.ts",
      "z.ts"], "mb", ["old.ts"]);

    expect(layout.isStale).toBe(false);
    expect(describeLayout(layout)).toEqual([
      "Gone 0: ",
      "Small 2: image.png, z.ts (partial)",
      "Tie 2: t.ts, unassigned.ts",
      "Big 15: a.ts, z.ts (partial)",
      "Ungrouped undefined: new.ts, old.ts",
    ]);
  });

  it("marks the layout stale, with no partial views, if the merge-base changed", () => {
    let layout = arrangeGroups(changeGroups, ["z.ts"], "other");

    expect(layout.isStale).toBe(true);
    expect(describeLayout(layout)).toEqual(["Tie 0: ", "Gone 0: ", "Small 2: z.ts", "Big 10: z.ts"]);
  });
});
