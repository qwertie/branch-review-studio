import { describe, expect, it } from "vitest";
import { MergeBaseInfo } from "./git";
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
        addedLines: 3, removedLines: 1,
        files: [{ path: "a.cs", isPartial: true }, { path: `dir/${evil}.cs`, isPartial: false }] },
      { id: undefined, name: "Ungrouped", summary: "Others", changedLines: undefined, addedLines: undefined,
        removedLines: undefined,
        files: [{ path: "b.cs", isPartial: false }] }] } });
}

const mergeBase: MergeBaseInfo = { baseRef: "origin/develop", baseSha: "baseba5e", headSha: "4ead4ead",
  mergeBaseSha: "0123456789abcdef" };
const mergeBaseHtml = `<code title="merge-base 0123456789abcdef">01234567</code>`;

function render(outline = createOutline(), overrides: Partial<ReviewViewData> = {}): string {
  return renderReviewViewBody({ branch: `feature/${evil}`, baseBranch: "develop", outline, summary: `Review ${evil}`,
    mergeBase, mergeBaseError: undefined, postedGroups: undefined, hasReview: true, reviewedHead: undefined,
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
      let order = ["1. Group", "+3 −1 lines, 2 files", "Summary <strong>bold</strong>", ">a.cs<", ">partial<",
        "Major: first", "Minor: second", ">Ungrouped<", ">b.cs<"].map(text => html.indexOf(text));
      expect(order.every(i => i >= 0), `positions ${order}`).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(html).toContain(`title="2 open threads">2</span>`);
      expect(html).toContain(`<code title="merge-base 0123456789abcdef">01234567</code>`);
    });

  it("gives each thread row a Delete Thread button and the header a Delete Resolved Threads button", () => {
    let html = render();
    let threadRows = html.match(/<div class="row thread-row[^]*?<\/div>/g) ?? [];
    expect(threadRows).toHaveLength(2);
    for (let row of threadRows)
      expect(row).toMatch(/<button [^>]*data-action="deleteThread" title="Delete Thread"/);
    expect(html).toMatch(/<button [^>]*data-action="runCommand" data-command="deleteResolvedThreads"/);
  });

  it("shows notices for a missing merge-base and a detached HEAD, and no stale-groups notice then", () => {
    let outline = { ...createOutline(), isStale: true };
    let html = render(outline, { mergeBase: undefined, mergeBaseError: "no develop", branch: undefined });
    for (let text of ["develop <span class=\"error\">(no merge-base)</span>", "no develop", "HEAD is detached",
      "regroup: merge-base changed"])
      expect(html).toContain(text);
    expect(html).not.toContain("post the groups again");
  });

  it("says from which merge-base to which the merge-base with the base ref moved since the groups were posted",
    () => {
      for (let baseRef of ["origin/develop", undefined]) {
        let html = render({ ...createOutline(), isStale: true },
          { postedGroups: { baseRef, mergeBaseSha: "fedcba9876543210" } });
        expect(html).toContain(`<div class="notice warning">The merge-base with <code>origin/develop</code> moved `
          + `from <code title="merge-base fedcba9876543210">fedcba98</code> to `
          + `<code title="merge-base 0123456789abcdef">01234567</code> since the groups were posted (because this `
          + "branch was rebased, or merged newer commits of <code>origin/develop</code>, or "
          + "<code>origin/develop</code> took in commits of this branch), so the diffs show all changes of each "
          + "file. Ask the agent to post the groups again.</div>");
      }
    });

  it("says when the base already contains HEAD, and what the diff is against then", () => {
    let mergeCommit = { ...mergeBase, headInBase: { mergeCommitSha: "1111111111111111", isRecorded: false } };
    expect(render(undefined, { mergeBase: mergeCommit })).toContain(`<div class="notice">This branch is already `
      + `merged into <code>origin/develop</code> (merge commit <code title="merge commit 1111111111111111">11111111`
      + `</code>), so the diff is against ${mergeBaseHtml}, the merge-base from before the merge.</div>`);
    let recorded = { ...mergeBase, headInBase: { mergeCommitSha: undefined, isRecorded: true } };
    expect(render(undefined, { mergeBase: recorded })).toContain(`<div class="notice"><code>origin/develop</code> `
      + `already contains HEAD (e.g. after a fast-forward merge), so the diff is against ${mergeBaseHtml}, the `
      + "merge-base that the review recorded.</div>");
    let none = { ...mergeBase, headInBase: { mergeCommitSha: undefined, isRecorded: false } };
    let noneNotice = `<div class="notice"><code>origin/develop</code> already contains HEAD, so the diff shows only `
      + "uncommitted changes: this branch was fast-forward merged into it, or has no commits of its own. To see a "
      + "merged branch's changes, use Change Base Branch… to compare with the commit that "
      + "<code>origin/develop</code> was at before the merge.</div>";
    expect(render(undefined, { mergeBase: none })).toContain(noneNotice);
    // Without a review, the branch is presumably new rather than merged
    expect(render(undefined, { mergeBase: none, hasReview: false })).not.toContain("already contains HEAD");
    expect(render()).not.toContain("already");
  });

  it("says which commit the agent reviewed and how many commits HEAD has gained since", () => {
    let reviewedHtml = `<div class="notice">Reviewed commit <code title="reviewed commit abcdef1234567890">abcdef12`
      + "</code>";
    for (let [newCommitCount, text] of [[0, " (the current HEAD)."], [1, "; 1 commit since the review."],
      [3, "; 3 commits since the review."],
      [undefined, ", which HEAD's history no longer contains (rebased or reset?)."]] as const) {
      expect(render(undefined, { reviewedHead: { sha: "abcdef1234567890", newCommitCount } }))
        .toContain(reviewedHtml + text + "</div>");
    }
    expect(render()).not.toContain("Reviewed commit");
  });

  it("says that the base branch changed since the groups were posted, if it did", () => {
    let html = render({ ...createOutline(), isStale: true },
      { postedGroups: { baseRef: `origin/${evil}`, mergeBaseSha: "fedcba9876543210" } });
    expect(html).toContain(`<div class="notice warning">The base branch changed from `
      + `<code>origin/&#60;img src=x onerror=&#34;alert(1)&#34;&#62;</code> to <code>origin/develop</code> since the `
      + "groups were posted, so the diffs show all changes of each file. Ask the agent to post the groups "
      + "again.</div>");
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
    expect(parseViewMessage({ action: "deleteThread", group: "g1", path: "a.cs", thread: "t2" }, outline))
      .toMatchObject({ action: "deleteThread", thread: { thread: { id: "t2" } } });
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
      { action: "deleteThread", group: "g1", path: "a.cs", thread: "missing" },
      { action: "deleteThread", group: "g1", path: "a.cs" }, { action: "deleteThread", path: "b.cs", thread: "t1" },
      { action: "deleteThread", group: "g1", path: "a.cs", thread: ["t1"] },
      { action: "openGroup", group: { toString: () => "g1" } }])
      expect(parseViewMessage(message, outline), JSON.stringify(message)).toBeUndefined();
  });
});
