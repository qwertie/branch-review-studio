import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("finishReview saves the summary, and fails if there is no review", async () => {
    let repo = createFeatureRepo();
    let tools = createTools(repo);
    await expect(tools.finishReview({ summary: "s" })).rejects.toThrow(/review_begin/);

    await tools.beginReview({});
    expect(await tools.finishReview({ summary: "All good." })).toContain("0 open threads");
    expect((await readReview(repo)).summary).toBe("All good.");
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
