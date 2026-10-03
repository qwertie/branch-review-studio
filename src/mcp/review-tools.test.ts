import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findingInstructions, groupingInstructions } from "../core/agent-commands";
import { getGitCommonDir } from "../core/git";
import { ReviewStore } from "../core/store";
import { TempRepo } from "../core/test-helpers";
import { AgentKind } from "../core/review";
import { identifyCaller, ReviewTools } from "./review-tools";

let repos: TempRepo[] = [];
afterEach(() => {
  for (let repo of repos.splice(0))
    repo.dispose();
});

/** Creates a repo on branch `feature` (from `develop`) with a working-tree change in src/a.ts. */
function createFeatureRepo(): TempRepo {
  let repo = TempRepo.create({ "src/a.ts": "class A {\n  f() {\n    return 1;\n  }\n}\n" });
  repos.push(repo);
  repo.git("branch", "develop");
  repo.git("checkout", "-q", "-b", "feature");
  repo.writeFiles({ "src/a.ts": "class A {\n  f() {\n    return 2;\n  }\n}\n" });
  return repo;
}

function createTools(repo: TempRepo, sessionId = "session-1", agent: AgentKind = "claude"): ReviewTools {
  return new ReviewTools({ cwd: repo.root, sessionId, agent, agentName: agent === "claude" ? "Claude" : "Codex" });
}

async function readReview(repo: TempRepo) {
  return (await new ReviewStore(await getGitCommonDir(repo.root)).readReview("feature"))!;
}

describe("ReviewTools", () => {
  it("beginReview creates the review, records the session, and lists open threads on re-runs", async () => {
    let repo = createFeatureRepo();
    let tools = createTools(repo);

    expect(await tools.beginReview({ summary: "first" })).toContain("There are no open threads yet.");
    await tools.addReviewComment({ file: "src/a.ts", line: 3, severity: "Major", body: "Why 2?" });
    let rerun = await tools.beginReview({});

    let review = await readReview(repo);
    expect(review).toMatchObject({ branch: "feature", baseBranch: "develop", summary: "first",
      mergeBaseSha: repo.git("rev-parse", "develop") });
    expect(review.sessions)
      .toEqual([expect.objectContaining({ sessionId: "session-1", cwd: repo.root, role: "review" })]);
    expect(rerun).toMatch(/don't post duplicates[\s\S]*src\/a\.ts:3 \[Major, open\][\s\S]*Why 2\?/);
  });

  it("beginReview keeps an existing review's base branch (without `origin/`) unless another one is given", async () => {
    let repo = createFeatureRepo();
    let tools = createTools(repo);

    await tools.beginReview({ baseBranch: "origin/main" });
    await tools.beginReview({});
    expect((await readReview(repo)).baseBranch).toBe("main");
    await tools.beginReview({ baseBranch: "develop" });
    expect((await readReview(repo)).baseBranch).toBe("develop");
  });

  it("addReviewComment accepts absolute or backslashed paths and anchors the line text", async () => {
    let repo = createFeatureRepo();
    let tools = createTools(repo);

    let result = await tools.addReviewComment({ file: path.join(repo.root, "src", "a.ts"), line: 3, endLine: 4,
      severity: "Minor", body: "b" });
    await tools.addReviewComment({ file: "src\\a.ts", line: 1, side: "base", severity: "Note", body: "c" });

    let [first, second] = (await readReview(repo)).threads;
    expect(result).toBe(`Created thread ${first.id} on src/a.ts:3.`);
    expect(first).toMatchObject({ file: "src/a.ts", side: "modified", severity: "Minor", status: "open",
      anchor: { startLine: 3, endLine: 4, lineText: "    return 2;" } });
    expect(first.comments[0]).toMatchObject({ author: { kind: "agent", name: "Claude" }, sessionId: "session-1" });
    expect(second).toMatchObject({ file: "src/a.ts", side: "base", anchor: { lineText: "class A {" } });
  });

  it("addReviewComment rejects missing files, out-of-range lines and paths outside the repo", async () => {
    let repo = createFeatureRepo();
    let tools = createTools(repo);
    let comment = (file: string, line: number) => tools.addReviewComment({ file, line, severity: "Note", body: "x" });

    await expect(comment("missing.ts", 1)).rejects.toThrow(/does not exist/);
    await expect(comment("src/a.ts", 99)).rejects.toThrow(/out of range; 'src\/a.ts' has 5 lines/);
    await expect(comment("../outside.ts", 1)).rejects.toThrow(/not inside the repo/);
  });

  it("replyToThread records a follow-up session; resolveThread adds a note; listThreads filters", async () => {
    let repo = createFeatureRepo();
    await createTools(repo).addReviewComment({ file: "src/a.ts", line: 3, severity: "Major", body: "Why 2?" });
    let threadId = (await readReview(repo)).threads[0].id;
    let followUp = createTools(repo, "thread-2", "codex");

    await followUp.replyToThread({ threadId, body: "Because." });
    expect(await followUp.listThreads({})).toMatch(/Why 2\?[\s\S]*Codex: Because\./);
    await followUp.resolveThread({ threadId, note: "Fixed." });

    let review = await readReview(repo);
    expect(review.sessions.map(s => [s.sessionId, s.role, s.agent]))
      .toEqual([["session-1", "review", "claude"], ["thread-2", "followup", "codex"]]);
    expect(review.threads[0].status).toBe("resolved");
    expect(review.threads[0].comments.map(c => c.body)).toEqual(["Why 2?", "Because.", "Fixed."]);
    expect(await followUp.listThreads({})).toBe("There are no open threads.");
    expect(await followUp.listThreads({ status: "resolved" })).toContain(threadId);
    await expect(followUp.replyToThread({ threadId: "nope", body: "x" })).rejects.toThrow(/nope/);
  });

  it("beginReview explains how to post findings and groups", async () => {
    let result = await createTools(createFeatureRepo()).beginReview({});

    expect(result).toContain(findingInstructions);
    expect(result).toContain(groupingInstructions);
  });

  it("setGroups freezes each file's hunks with their groups, reports the layout, and replaces earlier groups",
    async () => {
      let repo = createFeatureRepo();
      repo.writeFiles({ "src/b.ts": "one\ntwo\nthree\n" });
      let tools = createTools(repo);
      let groups = [{ id: "a", name: "Return 2", summary: "Returns **2**." },
        { id: "b", name: "New file b", summary: "Adds b." }, { id: "c", name: "Unused", summary: "" }];

      let result = await tools.setGroups({ groups, files: [
        { file: "src/a.ts", groups: [{ groupId: "a" }] },
        { file: "src\\b.ts", groups: [{ groupId: "a", ranges: [{ startLine: 1, endLine: 1 }] },
          { groupId: "b", ranges: [{ startLine: 2, endLine: 2 }, { startLine: 9, endLine: 9 }] }] },
      ] });

      let review = await readReview(repo);
      expect(review.changeGroups).toMatchObject({ mergeBaseSha: review.mergeBaseSha, groups, files: [
        { file: "src/a.ts", groupIds: ["a"], hunks: [{ oldStart: 3, oldCount: 1, newCount: 1, groupIds: ["a"] }] },
        { file: "src/b.ts", groupIds: ["a", "b"], hunks: [
          { oldStart: 0, oldCount: 0, newCount: 1, newLines: ["one\n"], groupIds: ["a"] },
          { oldStart: 0, oldCount: 0, newCount: 1, newLines: ["two\n"], groupIds: ["b"] },
          { oldStart: 0, oldCount: 0, newCount: 1, groupIds: [] },
        ] },
      ] });
      expect(result).toBe("Saved the groups. Branch Review Studio shows them smallest first:\n"
        + "- New file b (1 line, 1 file): src/b.ts (partial)\n"
        + "- Return 2 (2 lines, 2 files): src/a.ts, src/b.ts (partial)\n\n"
        + "To correct the following, call review_set_groups again (it replaces the groups):\n"
        + "- src/b.ts: the range 9-9 of group 'b' overlaps no change.\n"
        + "- src/b.ts: no range covers line 3, so these changes appear in every group that lists the file.\n"
        + "- Group 'c' includes no changes, so Branch Review Studio doesn't show it.");

      await tools.setGroups({ groups: [groups[1]], files: [{ file: "src/b.ts", groups: [{ groupId: "b" }] }] });
      expect((await readReview(repo)).changeGroups).toMatchObject({ groups: [groups[1]],
        files: [{ file: "src/b.ts", hunks: [{ newCount: 3, groupIds: ["b"] }] }] });
    });

  it("setGroups freezes the hunks against the current merge-base and saves it in the review", async () => {
    let repo = createFeatureRepo();
    let tools = createTools(repo);
    await tools.beginReview({});
    repo.writeFiles({ "src/c.ts": "c\n" });
    repo.git("add", "src/c.ts");
    repo.git("commit", "-q", "-m", "Add c");
    repo.git("branch", "-f", "develop", "HEAD");

    await tools.setGroups({ groups: [{ id: "a", name: "A", summary: "" }],
      files: [{ file: "src/a.ts", groups: [{ groupId: "a" }] }] });

    let review = await readReview(repo);
    expect(review.mergeBaseSha).toBe(repo.git("rev-parse", "HEAD"));
    expect(review.changeGroups?.mergeBaseSha).toBe(review.mergeBaseSha);
  });

  it("setGroups rejects invalid groups and files, listing every problem, and saves nothing", async () => {
    let repo = createFeatureRepo();
    let tools = createTools(repo);
    await tools.beginReview({});
    let group = { id: "a", name: "A", summary: "" };

    let setGroups = tools.setGroups({ groups: [group, group, { id: "", name: "B", summary: "" }], files: [
      { file: "README.md", groups: [{ groupId: "a" }] },
      { file: "src/a.ts", groups: [{ groupId: "a", ranges: [{ startLine: 3, endLine: 2 }] }, { groupId: "x" }] },
      { file: "src/a.ts", groups: [] },
    ] });

    await expect(setGroups).rejects.toThrow("review_set_groups found problems; nothing was saved:\n"
      + "- Group id 'a' is used more than once.\n"
      + "- Group ids and names must not be empty (id '', name 'B').\n"
      + "- 'README.md' is not a changed file (see `git diff --name-status " + (await readReview(repo)).mergeBaseSha
      + "`).\n"
      + "- 'src/a.ts' refers to group 'x', which is not in `groups`.\n"
      + "- 'src/a.ts' is in several groups, so each of its groups needs `ranges`.\n"
      + "- 'src/a.ts' has an invalid range 3-2.\n"
      + "- 'src/a.ts' is listed more than once.\n"
      + "- 'src/a.ts' must list one or more groups, each once.");
    expect((await readReview(repo)).changeGroups).toBeUndefined();
  });

  it("finishReview saves the summary, and fails if there is no review", async () => {
    let repo = createFeatureRepo();
    let tools = createTools(repo);
    await expect(tools.finishReview({ summary: "s" })).rejects.toThrow(/review_begin/);

    await tools.beginReview({});
    expect(await tools.finishReview({ summary: "All good." })).toContain("which has 0 open threads.");
    expect((await readReview(repo)).summary).toBe("All good.");
    await tools.addReviewComment({ file: "src/a.ts", line: 3, severity: "Major", body: "Why 2?" });
    expect(await tools.finishReview({ summary: "One finding." })).toContain("which has 1 open thread.");
  });
});

describe("identifyCaller", () => {
  it("identifies Codex by the thread id in the request's _meta, or by its client name", () => {
    // _meta of a real tools/call request from codex-cli 0.160.0 (abridged)
    let meta = { "x-codex-turn-metadata": { session_id: "t-1", thread_id: "t-1", turn_id: "u-1" }, threadId: "t-1",
      sessionId: "t-1" };
    expect(identifyCaller("D:/r", meta, { CLAUDE_CODE_SESSION_ID: "c-1" }, "codex-mcp-client"))
      .toEqual({ cwd: "D:/r", sessionId: "t-1", agent: "codex", agentName: "Codex" });
    expect(identifyCaller("D:/r", { "x-codex-turn-metadata": { thread_id: "t-2" } }, {}, undefined))
      .toMatchObject({ sessionId: "t-2", agent: "codex" });
    expect(identifyCaller("D:/r", undefined, {}, "codex-mcp-client"))
      .toMatchObject({ sessionId: undefined, agent: "codex" });
  });

  it("identifies Claude Code by CLAUDE_CODE_SESSION_ID otherwise", () => {
    expect(identifyCaller("D:/r", { progressToken: 1 }, { CLAUDE_CODE_SESSION_ID: "c-1" }, "claude-code"))
      .toEqual({ cwd: "D:/r", sessionId: "c-1", agent: "claude", agentName: "Claude" });
  });
});
