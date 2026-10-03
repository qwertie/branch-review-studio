import { describe, expect, it } from "vitest";
import {
  addComment, addThread, createReview, findLatestSession, getAuthorLabel, getThread, recordSession,
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
});
