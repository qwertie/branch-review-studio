import { describe, expect, it } from "vitest";
import {
  addComment, addThread, clearReviewContent, createReview, deleteThreads, describeReviewContent, findLatestSession,
  getAuthorLabel, getResolvedThreadIds, getThread, recordSession, Review,
} from "./review";

const anchor = { startLine: 1, endLine: 1, lineText: "x", contextBefore: [], contextAfter: [] };

describe("review model", () => {
  it("getAuthorLabel adds the severity only to the agent comment that opened the thread", () => {
    let review = createReview("b", "develop", "abc");
    let thread = addThread(review, { file: "a.txt", side: "modified", anchor, severity: "Minor",
      author: { kind: "agent", name: "Claude" }, body: "first" });
    let reply = addComment(review, thread, { kind: "agent", name: "Claude" }, "second");

    expect(getAuthorLabel(thread, thread.comments[0])).toBe("Claude (Minor)");
    expect(getAuthorLabel(thread, reply)).toBe("Claude");
  });

  it("createReview stores the base branch without `origin/`", () => {
    expect(createReview("b", "origin/develop", "abc").baseBranch).toBe("develop");
  });

  it("getThread throws an error naming the missing id", () => {
    expect(() => getThread(createReview("b", "develop", "abc"), "deadbeef")).toThrow(/deadbeef/);
  });

  it("recordSession ignores a session that is already recorded; findLatestSession finds the newest by role", () => {
    let review = createReview("b", "develop", "abc");
    recordSession(review, "s1", "D:/x", "review", "claude");
    recordSession(review, "s2", "D:/x", "review", "codex");
    recordSession(review, "s1", "D:/y", "followup", "claude");

    expect(review.sessions.map(s => [s.sessionId, s.agent])).toEqual([["s1", "claude"], ["s2", "codex"]]);
    expect(findLatestSession(review, "review")?.sessionId).toBe("s2");
    expect(findLatestSession(review, "followup")).toBeUndefined();
  });

  it("getResolvedThreadIds finds the resolved threads, which deleteThreads removes", () => {
    let review = createFullReview();
    let resolvedIds = getResolvedThreadIds(review);

    expect(resolvedIds).toEqual([review.threads[1].id, review.threads[2].id]);
    expect(getResolvedThreadIds(undefined)).toEqual([]);
    deleteThreads(review, resolvedIds);
    expect(review.threads.map(t => t.comments[0].body)).toEqual(["open"]);
  });

  it("clearReviewContent leaves a review like a new one with the same base; describeReviewContent lists what it "
    + "removes", () => {
    let review = createFullReview();
    let { branch, baseBranch, mergeBaseSha } = review;

    expect(describeReviewContent(review)).toEqual(["3 threads (4 comments)", "the review summary",
      "1 group of related changes", "1 recorded agent session, which Ask Agent can fork"]);
    clearReviewContent(review);
    expect(review).toEqual({ ...createReview(branch, baseBranch, mergeBaseSha),
      createdAt: review.createdAt, updatedAt: review.updatedAt });
    expect(describeReviewContent(review)).toEqual([]);
  });
});

/** Creates a review with a summary, a group, a session and threads "open", "resolved" and "resolved too". */
function createFullReview(): Review {
  let review = createReview("b", "main", "abc");
  let author = { kind: "agent" as const, name: "Claude" };
  for (let body of ["open", "resolved", "resolved too"]) {
    let thread = addThread(review, { file: "a.txt", side: "modified", anchor, author, body });
    thread.status = body === "open" ? "open" : "resolved";
  }
  addComment(review, review.threads[0], author, "reply");
  recordSession(review, "s1", "D:/x", "review", "claude");
  review.summary = "Summary";
  review.changeGroups = { mergeBaseSha: "abc", createdAt: "", groups: [{ id: "g", name: "G", summary: "" }],
    files: [] };
  return review;
}
