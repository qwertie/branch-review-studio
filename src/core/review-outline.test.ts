import { describe, expect, it } from "vitest";
import { AnchorLocation } from "./anchoring";
import { ChangedFile } from "./git";
import { ArrangedGroup, GroupLayout } from "./groups";
import { DiffHunk } from "./hunks";
import { createReview, ReviewThread, ThreadStatus } from "./review";
import {
  buildReviewOutline, findAdjacentThread, getGroupHeading, getWorkingTreeLine, listChangesEntries, listThreadVisits,
  ReviewOutline, ThreadPosition,
} from "./review-outline";

/**
 * Creates a thread created at `createdLine`; `currentLine` (default: the same) is where
 * locateAnchor finds it now.
 */
function thread(id: string, file: string, createdLine: number, currentLine = createdLine,
  status: ThreadStatus = "open"): { thread: ReviewThread, location: [string, AnchorLocation] } {
  let anchor = { startLine: createdLine, endLine: createdLine, lineText: "", contextBefore: [], contextAfter: [] };
  return { thread: { id, file, side: "modified", anchor, status, severity: "Major",
    comments: [{ id: "c" + id, author: { kind: "agent", name: "Claude" }, body: `**Major:** thread ${id}`,
      createdAt: "" }] },
  location: [id, { startLine: currentLine, endLine: currentLine + 2, isOutdated: false }] };
}

function group(id: string | undefined, name: string, files: [path: string, isPartial?: boolean][],
  changedLines = 1): ArrangedGroup {
  return { id, name, summary: `Summary of ${name}`, changedLines: id === undefined ? undefined : changedLines,
    files: files.map(([path, isPartial = false]) => ({ path, isPartial })) };
}

function createOutline(changedPaths: string[], threads: ReturnType<typeof thread>[],
  groupLayout?: GroupLayout, baseThreadHunks = new Map<string, DiffHunk[]>()): ReviewOutline {
  let changedFiles: ChangedFile[] = changedPaths.map(path => ({ path, status: "Modified" }));
  let review = { ...createReview("feature", "develop", "abc"), threads: threads.map(t => t.thread) };
  return buildReviewOutline({ changedFiles, review, threadLocations: new Map(threads.map(t => t.location)),
    groupLayout, baseThreadHunks });
}

/** Threads in b.cs (moved from line 50 to 10, so they swap order), a.cs and unchanged.cs */
const threads = [thread("b1", "src/b.cs", 20), thread("b2", "src/b.cs", 50, 10), thread("a1", "a.cs", 5, 5,
  "resolved"), thread("u1", "unchanged.cs", 1)];

/**
 * Groups: "small" has the second part of b.cs; "big" has a.cs and all of b.cs; Ungrouped has c.cs
 */
const layout: GroupLayout = { isStale: false, groups: [group("small", "Small", [["src/b.cs", true]]),
  group("big", "Big", [["a.cs"], ["src/b.cs", false]], 9), group(undefined, "Ungrouped", [["c.cs"],
    ["unchanged.cs"]])] };

function getIds(outline: ReviewOutline): string[] {
  return listThreadVisits(outline).map(v => v.thread.thread.id);
}

describe("buildReviewOutline and listThreadVisits", () => {
  it("without groups, lists files by path (with unchanged files that have threads) and threads by current line",
    () => {
      let outline = createOutline(["src/b.cs", "c.cs", "a.cs"], threads);
      expect(outline.sections).toHaveLength(1);
      expect(outline.sections[0].files.map(f => [f.path, f.change?.status, f.threads.map(t => t.line)])).toEqual([
        ["a.cs", "Modified", [5]], ["c.cs", "Modified", []], ["src/b.cs", "Modified", [10, 20]],
        ["unchanged.cs", undefined, [1]]]);
      expect(getIds(outline)).toEqual(["a1", "b2", "b1", "u1"]);
    });

  it("places a thread on the base side by its position in the working tree", () => {
    // Base line 15 of src/b.cs is working-tree line 25, since 10 lines were inserted after line 5
    let baseThread = thread("s1", "src/b.cs", 15);
    baseThread.thread.side = "base";
    let hunks = [{ oldStart: 5, oldCount: 0, newStart: 6, newLines: Array<string>(10).fill("x\n") }];
    let outline = createOutline(["src/b.cs"], [...threads, baseThread], undefined, new Map([["src/b.cs", hunks]]));
    expect(getIds(outline)).toEqual(["a1", "b2", "b1", "s1", "u1"]);
    expect(outline.sections[0].files[1].threads.map(t => [t.line, t.position]))
      .toEqual([[10, 10], [20, 20], [15, 25]]);
    expect(findAdjacentThread(outline, { file: "src/b.cs", line: 22 }, 1, false)?.visit.thread.thread.id)
      .toBe("s1");
  });

  it("gives a thread on a removed base line the working-tree line above it, or line 1", () => {
    // Base lines 1 and 15-16 of src/b.cs were removed
    let removedFirst = thread("r1", "src/b.cs", 1);
    let removedLater = thread("r2", "src/b.cs", 16);
    removedFirst.thread.side = removedLater.thread.side = "base";
    let hunks = [{ oldStart: 1, oldCount: 1, newStart: 0, newLines: [] },
      { oldStart: 15, oldCount: 2, newStart: 13, newLines: [] }];
    let outline = createOutline(["src/b.cs"], [removedFirst, removedLater], undefined, new Map([["src/b.cs", hunks]]));
    expect(outline.sections[0].files[0].threads.map(t => [t.position, getWorkingTreeLine(t)]))
      .toEqual([[0.5, 1], [13 + 2 / 3, 13]]);
  });

  it("with groups, numbers the groups, lists files under each group, and visits each thread once", () => {
    let outline = createOutline(["src/b.cs", "c.cs", "a.cs"], threads, layout);
    expect(outline.sections.map(s => [s.title, s.files.map(f => f.path)])).toEqual([["1. Small", ["src/b.cs"]],
      ["2. Big", ["a.cs", "src/b.cs"]], ["Ungrouped", ["c.cs", "unchanged.cs"]]]);
    expect(outline.sections[1].files[1].threads.map(t => t.thread.id)).toEqual(["b2", "b1"]);
    expect(listThreadVisits(outline).map(v => [v.section.title, v.thread.thread.id])).toEqual([
      ["1. Small", "b2"], ["1. Small", "b1"], ["2. Big", "a1"], ["Ungrouped", "u1"]]);
  });
});

describe("findAdjacentThread", () => {
  let outline = createOutline(["src/b.cs", "c.cs", "a.cs"], threads);
  let find = (from: ThreadPosition | undefined, direction: 1 | -1, isUnresolvedOnly = false) => {
    let result = findAdjacentThread(outline, from, direction, isUnresolvedOnly);
    return result && `${result.visit.thread.thread.id}${result.isWrapped ? " (wrapped)" : ""}`;
  };

  it("goes to the next or previous thread after a thread, wrapping around", () => {
    expect(find({ threadId: "b2" }, 1)).toBe("b1");
    expect(find({ threadId: "b2" }, -1)).toBe("a1");
    expect(find({ threadId: "u1" }, 1)).toBe("a1 (wrapped)");
    expect(find({ threadId: "a1" }, -1)).toBe("u1 (wrapped)");
  });

  it("goes to the next or previous thread from a line of a file, by the threads' current lines", () => {
    expect(find({ file: "src/b.cs", line: 15 }, 1)).toBe("b1");
    expect(find({ file: "src/b.cs", line: 15 }, -1)).toBe("b2");
    expect(find({ file: "src/b.cs", line: 10 }, 1)).toBe("b1");
    expect(find({ file: "src/b.cs", line: 10 }, -1)).toBe("a1");
    // c.cs has no threads; it comes between a.cs and src/b.cs
    expect(find({ file: "c.cs", line: 100 }, 1)).toBe("b2");
    expect(find({ file: "c.cs", line: 1 }, -1)).toBe("a1");
    expect(find({ file: "unchanged.cs", line: 2 }, 1)).toBe("a1 (wrapped)");
  });

  it("skips resolved threads if asked", () => {
    expect(find({ threadId: "u1" }, 1, true)).toBe("b2 (wrapped)");
    expect(find({ file: "c.cs", line: 1 }, -1, true)).toBe("u1 (wrapped)");
  });

  it("starts at the first or last thread without a known position", () => {
    expect(find(undefined, 1)).toBe("a1");
    expect(find(undefined, -1)).toBe("u1");
    expect(find({ file: "other.cs", line: 3 }, 1)).toBe("a1");
    expect(find({ threadId: "deleted" }, -1, true)).toBe("u1");
    expect(findAdjacentThread(createOutline(["a.cs"], []), undefined, 1, false)).toBeUndefined();
  });

  it("follows group order, visiting a file's threads under its first group", () => {
    let grouped = createOutline(["src/b.cs", "c.cs", "a.cs"], threads, layout);
    expect(findAdjacentThread(grouped, { threadId: "b1" }, 1, false)?.visit.thread.thread.id).toBe("a1");
    expect(findAdjacentThread(grouped, { file: "a.cs", line: 1 }, -1, false)?.visit.thread.thread.id).toBe("b1");
  });
});

describe("listChangesEntries", () => {
  it("lists a heading per group, then the group's changed files by path, a file once per group, Ungrouped last",
    () => {
      let outline = createOutline(["src/b.cs", "c.cs", "a.cs"], threads, layout);
      let entries = listChangesEntries(outline).map(e => e.kind === "heading" ? `# ${e.fileName}`
        : `${e.change.path}${e.viewGroupId ? ` (view of ${e.viewGroupId})` : ""}`);
      // src/b.cs isn't partial in "big", but it was already shown, and VS Code fails on duplicate
      // entries
      expect(entries).toEqual(["# 1. Small — 1 line, 1 file.md", "src/b.cs (view of small)",
        "# 2. Big — 9 lines, 2 files.md", "a.cs", "src/b.cs (view of big)", "# Ungrouped — 2 files.md", "c.cs"]);
      expect(getGroupHeading(outline, outline.sections[1]).text)
        .toBe("# 2. Big\n\n9 lines, 2 files\n\nSummary of Big\n");
    });

  it("lists one group's entries, or files by path without groups or with stale groups", () => {
    let grouped = createOutline(["src/b.cs", "c.cs", "a.cs"], threads, layout);
    expect(listChangesEntries(grouped, [grouped.sections[1]])
      .map(e => e.kind === "file" ? e.viewGroupId ?? e.change.path : e.fileName))
      .toEqual(["2. Big — 9 lines, 2 files.md", "a.cs", "src/b.cs"]);
    for (let outline of [createOutline(["src/b.cs", "c.cs", "a.cs"], threads),
      createOutline(["src/b.cs", "c.cs", "a.cs"], threads, { ...layout, isStale: true })]) {
      expect(listChangesEntries(outline).map(e => e.kind === "file" && !e.viewGroupId && e.change.path))
        .toEqual(["a.cs", "c.cs", "src/b.cs"]);
    }
  });

  it("replaces slashes in group names, since the heading's file name is a URI path", () => {
    let outline = createOutline(["a.cs"], [], { isStale: false, groups: [group("g", "Fix a/b", [["a.cs"]])] });
    expect(listChangesEntries(outline)[0])
      .toMatchObject({ kind: "heading", fileName: "1. Fix a-b — 1 line, 1 file.md" });
  });
});
