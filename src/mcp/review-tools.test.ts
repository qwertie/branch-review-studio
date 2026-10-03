import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGitCommonDir } from "../core/git";
import { ReviewStore } from "../core/store";
import { TempRepo } from "../core/test-helpers";
import { ReviewTools } from "./review-tools";

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

function createTools(repo: TempRepo, sessionId = "session-1"): ReviewTools {
  return new ReviewTools({ cwd: repo.root, sessionId, agentName: "Claude" });
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
    let followUp = createTools(repo, "session-2");

    await followUp.replyToThread({ threadId, body: "Because." });
    expect(await followUp.listThreads({})).toMatch(/Why 2\?[\s\S]*Claude: Because\./);
    await followUp.resolveThread({ threadId, note: "Fixed." });

    let review = await readReview(repo);
    expect(review.sessions.map(s => [s.sessionId, s.role]))
      .toEqual([["session-1", "review"], ["session-2", "followup"]]);
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
