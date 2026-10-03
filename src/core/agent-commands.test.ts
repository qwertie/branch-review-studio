import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentChoice, buildLanguageModelPrompt, buildReviewPrompt, buildThreadPrompt, getAgentChoices, groupingInstructions,
  mcpServerName,
} from "./agent-commands";
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

    let outdatedLocation = { ...location, isOutdated: true };
    let prompt = buildThreadPrompt({ review, thread, fileLines: undefined, location: outdatedLocation }, "fork");

    expect(prompt).toContain("outdated");
    expect(prompt).toContain("file does not exist");
  });
});

describe("buildLanguageModelPrompt", () => {
  it("includes the review summary, the thread's location, excerpt, nearby diff and messages, and the tools", () => {
    let { review, thread, lines, location } = createSample();

    let nearbyDiff = "@@ -12 +12 @@\n-old\n+line 12";
    let prompt = buildLanguageModelPrompt({ review, thread, fileLines: lines, location }, nearbyDiff);

    expect(prompt).toContain("branch `feature/x`");
    expect(prompt).toContain("Overall the branch looks fine.");
    expect(prompt).toContain("src/a.ts lines 12-13");
    expect(prompt).toContain(">   12 | line 12");
    expect(prompt).toContain("```diff\n@@ -12 +12 @@\n-old\n+line 12\n```");
    expect(prompt).toContain("Claude (Major): This might divide by zero.");
    expect(prompt).toMatch(/New message from David:\s+Can it really\? Explain\./);
    expect(prompt).toMatch(/read-only tools/);
    expect(prompt).toMatch(/cannot edit files/);
    expect(prompt).not.toContain("review_reply");
  });

  it("omits the diff section when there is no nearby diff", () => {
    let { review, thread, lines, location } = createSample();
    expect(buildLanguageModelPrompt({ review, thread, fileLines: lines, location }, undefined))
      .not.toContain("```diff");
  });
});

describe("getAgentChoices", () => {
  const describeChoices = (choices: AgentChoice[]) => choices.map(c => `${c.agent} ${c.sessionMode} ${c.runMode}`);

  it("offers forking only with the agent that ran the review session, and lists that agent first", () => {
    expect(describeChoices(getAgentChoices(["claude", "codex"], "codex"))).toEqual([
      "codex fork interactive", "codex fork background", "codex fresh interactive", "codex fresh background",
      "claude fresh interactive", "claude fresh background",
    ]);
  });

  it("offers only fresh sessions without a review session or when the session's agent is unavailable", () => {
    expect(describeChoices(getAgentChoices(["claude", "codex"], undefined))).toEqual([
      "claude fresh interactive", "claude fresh background", "codex fresh interactive", "codex fresh background",
    ]);
    expect(describeChoices(getAgentChoices(["codex"], "claude")))
      .toEqual(["codex fresh interactive", "codex fresh background"]);
  });

  it("offers a VS Code language model last, only as a fresh background answer", () => {
    expect(describeChoices(getAgentChoices(["claude"], "claude", true))).toEqual([
      "claude fork interactive", "claude fork background", "claude fresh interactive", "claude fresh background",
      "languageModel fresh background",
    ]);
    expect(describeChoices(getAgentChoices([], undefined, true))).toEqual(["languageModel fresh background"]);
  });
});

describe("buildReviewPrompt", () => {
  it("names the skill, the branch and the base branch, with review_begin as the fallback", () => {
    expect(buildReviewPrompt("feature/x", "develop")).toBe("Use the " + mcpServerName + " skill to review branch "
      + "`feature/x` against `develop`. If you don't have that skill, call review_begin (`" + mcpServerName
      + "` MCP tools) and follow its instructions.");
  });
});

describe("groupingInstructions", () => {
  it("appears verbatim (up to line wrapping) in the skill", () => {
    let skill = fs.readFileSync(path.join(__dirname, "../../skills/branch-review-studio/SKILL.md"), "utf8");
    let normalize = (text: string) => text.replace(/\s+/g, " ");

    expect(normalize(skill)).toContain(normalize(groupingInstructions));
  });
});
