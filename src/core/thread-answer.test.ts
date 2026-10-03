import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentIntegration } from "./agent-integration";
import { claudeIntegration } from "./claude-cli";
import { codexIntegration } from "./codex-cli";
import { addThread, createReview } from "./review";
import { ReviewStore } from "./store";
import { createFiles } from "./test-helpers";
import { answerThreadInBackground } from "./thread-answer";

/**
 * Creates a store with one thread, plus a fake agent CLI (node script) that prints `fakeOutput` as
 * JSON lines and exits with `exitCode`.
 */
async function setUp(agent: AgentIntegration, fakeOutput: object[], exitCode = 0) {
  let script = fakeOutput.map(o => `console.log(${JSON.stringify(JSON.stringify(o))});`).join("\n")
    + `\nprocess.exitCode = ${exitCode};`;
  let dir = createFiles(["fake-agent.js", script]);
  let store = new ReviewStore(dir);
  let threadId = "";
  await store.updateReview("b", () => {
    let review = createReview("b", "develop", "abc");
    let anchor = { startLine: 1, endLine: 1, lineText: "x", contextBefore: [], contextAfter: [] };
    threadId = addThread(review, { file: "a.ts", side: "modified", anchor, author: { kind: "user", name: "U" },
      body: "Why?" }).id;
    return review;
  });
  let command = { command: process.execPath, args: [path.join(dir, "fake-agent.js")] };
  let request = { store, branch: "b", threadId, agent, command, args: [], cwd: dir, onLine: () => {} };
  return { store, request };
}

describe("answerThreadInBackground", () => {
  it("records the preassigned session and posts Claude's final message if Claude didn't reply via MCP", async () => {
    let { store, request } = await setUp(claudeIntegration, [
      { type: "system", subtype: "init", session_id: "new-session" },
      { type: "result", subtype: "success", is_error: false, result: "Because of X.", session_id: "new-session" },
    ]);

    let answer = await answerThreadInBackground({ ...request, newSessionId: "new-session" });

    let review = (await store.readReview("b"))!;
    expect(answer).toMatchObject({ sessionId: "new-session", resultText: "Because of X.", isFallbackPosted: true,
      exitCode: 0 });
    expect(review.sessions).toEqual([expect.objectContaining({ sessionId: "new-session", role: "followup",
      agent: "claude" })]);
    expect(review.threads[0].comments.at(-1)).toMatchObject({ author: { kind: "agent", name: "Claude" },
      body: "Because of X.", sessionId: "new-session" });
  });

  it("posts a note when Claude exits without a result", async () => {
    let { store, request } = await setUp(claudeIntegration, []);
    await answerThreadInBackground(request);
    expect((await store.readReview("b"))!.threads[0].comments.at(-1)?.body).toMatch(/exited with code 0/);
  });

  it("records the Codex thread reported by `codex exec --json` and posts Codex's last message", async () => {
    let { store, request } = await setUp(codexIntegration, [
      { type: "thread.started", thread_id: "codex-thread" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Looking." } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Because of Y." } },
      { type: "turn.completed", usage: {} },
    ]);

    let answer = await answerThreadInBackground(request);

    let review = (await store.readReview("b"))!;
    expect(answer).toMatchObject({ sessionId: "codex-thread", isError: false, isFallbackPosted: true });
    expect(review.sessions).toEqual([expect.objectContaining({ sessionId: "codex-thread", agent: "codex" })]);
    expect(review.threads[0].comments.at(-1)).toMatchObject({ author: { kind: "agent", name: "Codex" },
      body: "Because of Y.", sessionId: "codex-thread" });
  });

  it("posts Codex's error message when its turn fails", async () => {
    let { store, request } = await setUp(codexIntegration, [
      { type: "thread.started", thread_id: "codex-thread" },
      { type: "turn.failed", error: { message: "The model is not supported." } },
    ], 1);

    let answer = await answerThreadInBackground(request);

    expect(answer).toMatchObject({ isError: true, errorMessage: "The model is not supported.", exitCode: 1 });
    expect((await store.readReview("b"))!.threads[0].comments.at(-1)?.body)
      .toBe("(Codex exited with code 1 without answering.)\n\nError: The model is not supported.");
  });
});
