import { describe, expect, it } from "vitest";
import { buildClaudeArgs, buildThreadPrompt, mcpServerName } from "./agent-commands";
import { createAnchor, splitLines } from "./anchoring";
import { addComment, addThread, createReview } from "./review";

function createSample() {
  let lines = splitLines(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
  let review = createReview("feature/x", "origin/develop", "abc1234def");
  review.summary = "Overall the branch looks fine.";
  let thread = addThread(review, { file: "src/a.ts", side: "modified", anchor: createAnchor(lines, 10, 11),
    severity: "Major", author: { kind: "agent", name: "Claude" }, body: "This might divide by zero." });
  addComment(review, thread, { kind: "user", name: "David" }, "Can it really? Explain.");
  let location = { startLine: 12, endLine: 13, isOutdated: false };
  return { review, thread, lines, location };
}

describe("buildThreadPrompt", () => {
  it("includes the thread location, a numbered excerpt, earlier messages, the new message and how to reply", () => {
    let { review, thread, lines, location } = createSample();

    let prompt = buildThreadPrompt({ review, thread, fileLines: lines, location }, "fork");

    expect(prompt).toContain(`thread ${thread.id}`);
    expect(prompt).toContain("src/a.ts lines 12-13");
    expect(prompt).toContain(">   12 | line 12");
    expect(prompt).toContain("    7 | line 7");
    expect(prompt).not.toContain("line 6\n");
    expect(prompt).toContain("Claude (Major): This might divide by zero.");
    expect(prompt).toMatch(/New message from David:\s+Can it really\? Explain\./);
    expect(prompt).toContain(`\`${mcpServerName}\` MCP tool \`review_reply\` with threadId "${thread.id}"`);
    expect(prompt).not.toContain(review.summary);
  });

  it("adds the review summary and the merge-base for a fresh session", () => {
    let { review, thread, lines, location } = createSample();

    let prompt = buildThreadPrompt({ review, thread, fileLines: lines, location }, "fresh");

    expect(prompt).toContain("Overall the branch looks fine.");
    expect(prompt).toContain("git diff abc1234def");
  });

  it("says when the thread is outdated or the file is missing", () => {
    let { review, thread, location } = createSample();

    let prompt = buildThreadPrompt({ review, thread, fileLines: undefined, location: { ...location, isOutdated: true } },
      "fork");

    expect(prompt).toContain("outdated");
    expect(prompt).toContain("file does not exist");
  });
});

describe("buildClaudeArgs", () => {
  it("resumes and forks the review session in an interactive terminal", () => {
    expect(buildClaudeArgs({ prompt: "hi\nthere", sessionMode: "fork", resumeSessionId: "s-1", runMode: "interactive" }))
      .toEqual(["--resume", "s-1", "--fork-session", "hi\nthere"]);
  });

  it("starts a fresh print-mode session with stream-json output that may call the MCP tools", () => {
    expect(buildClaudeArgs({ prompt: "hi", sessionMode: "fresh", runMode: "background" })).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--allowedTools", `mcp__${mcpServerName}`, "hi",
    ]);
  });

  it("refuses to fork without a session id", () => {
    expect(() => buildClaudeArgs({ prompt: "hi", sessionMode: "fork", runMode: "interactive" })).toThrow();
  });
});
