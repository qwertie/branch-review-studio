import { describe, expect, it } from "vitest";
import { createReview, ReviewThread } from "./review";
import { buildReviewOutline, ReviewOutline } from "./review-outline";
import { parseViewMessage, renderReviewViewBody, ReviewViewData } from "./review-view-html";

const evil = `<img src=x onerror="alert(1)">`;

function createThread(id: string, file: string, line: number, body: string): ReviewThread {
  return { id, file, side: "modified", status: "open", severity: "Major",
    anchor: { startLine: line, endLine: line, lineText: "", contextBefore: [], contextAfter: [] },
    comments: [{ id: "c" + id, author: { kind: "agent", name: "Claude" }, body, createdAt: "" }] };
}

/** An outline with group "g1" (a.cs, and a file whose name is HTML) and Ungrouped (b.cs) */
function createOutline(): ReviewOutline {
  let review = { ...createReview("feature", "develop", "abc"), threads: [
    createThread("t2", "a.cs", 30, "**Minor:** second"), createThread("t1", "a.cs", 3, `**Major:** first ${evil}`)] };
  return buildReviewOutline({ review, threadLocations: new Map(), baseThreadHunks: new Map(),
    changedFiles: [{ path: "a.cs", status: "Modified" }, { path: "b.cs", status: "Added" },
      { path: `dir/${evil}.cs`, status: "Added" }],
    groupLayout: { isStale: false, groups: [
      { id: "g1", name: `Group ${evil}`, summary: `Summary **bold** ${evil}`, changedLines: 4,
        files: [{ path: "a.cs", isPartial: true }, { path: `dir/${evil}.cs`, isPartial: false }] },
      { id: undefined, name: "Ungrouped", summary: "Others", changedLines: undefined,
        files: [{ path: "b.cs", isPartial: false }] }] } });
}

function render(outline = createOutline(), overrides: Partial<ReviewViewData> = {}): string {
  return renderReviewViewBody({ branch: `feature/${evil}`, baseBranch: "develop", outline, summary: `Review ${evil}`,
    mergeBase: { baseRef: "origin/develop", mergeBaseSha: "0123456789abcdef" }, mergeBaseError: undefined,
    ...overrides });
}

describe("renderReviewViewBody", () => {
  it("escapes every string from the review and git", () => {
    let html = render(createOutline(), { mergeBaseError: evil });
    expect(html).not.toMatch(/<img/);
    expect(html).toContain("feature/&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
  });

  it("shows numbered groups with summaries, files with status and counts, threads by line without markdown",
    () => {
      let html = render();
      let order = ["1. Group", "Summary <strong>bold</strong>", ">a.cs<", ">partial<", "Major: first", "Minor: second",
        ">Ungrouped<", ">b.cs<"].map(text => html.indexOf(text));
      expect(order.every(i => i >= 0), `positions ${order}`).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(html).toContain(`title="2 open threads">2</span>`);
      expect(html).toContain(`<code title="merge-base 0123456789abcdef">01234567</code>`);
    });

  it("shows notices for a missing merge-base, a detached HEAD and stale groups", () => {
    let outline = { ...createOutline(), isStale: true };
    let html = render(outline, { mergeBase: undefined, mergeBaseError: "no develop", branch: undefined });
    for (let text of ["develop <span class=\"error\">(no merge-base)</span>", "no develop", "HEAD is detached",
      "post the groups again", "regroup: merge-base changed"])
      expect(html).toContain(text);
  });
});

describe("parseViewMessage", () => {
  let outline = createOutline();

  it("accepts messages about items that exist in the outline", () => {
    expect(parseViewMessage({ action: "revealThread", group: "g1", path: "a.cs", thread: "t1" }, outline))
      .toMatchObject({ action: "revealThread", thread: { thread: { id: "t1" } },
        section: { title: "1. Group " + evil } });
    expect(parseViewMessage({ action: "openFile", path: "b.cs" }, outline))
      .toMatchObject({ action: "openFile", file: { path: "b.cs" }, section: { title: "Ungrouped" } });
    expect(parseViewMessage({ action: "openGroup", group: "g1" }, outline)).toMatchObject({ action: "openGroup" });
    expect(parseViewMessage({ action: "runCommand", command: "refresh" }, outline))
      .toEqual({ action: "runCommand", commandId: "refresh" });
  });

  it("rejects malformed messages and items that aren't in the outline or not in that group", () => {
    for (let message of [undefined, null, "openFile", 42, {}, { action: "deleteEverything" },
      { action: "runCommand", command: "workbench.action.terminal.new" }, { action: "openFile", path: "../x.cs" },
      { action: "openFile", path: "b.cs", group: "g1" }, { action: "openFile", path: ["a.cs"], group: "g1" },
      { action: "revealThread", group: "g1", path: "a.cs", thread: "missing" },
      { action: "revealThread", path: "b.cs", thread: "t1" }, { action: "openGroup", group: "nope" },
      { action: "openGroup", group: { toString: () => "g1" } }])
      expect(parseViewMessage(message, outline), JSON.stringify(message)).toBeUndefined();
  });
});
