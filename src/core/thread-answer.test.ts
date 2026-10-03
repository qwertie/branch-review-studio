import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addThread, createReview } from "./review";
import { ReviewStore } from "./store";
import { createTempDir } from "./test-helpers";
import { answerThreadInBackground } from "./thread-answer";

let tempDirs: string[] = [];
afterEach(() => {
  for (let dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Creates a store with one thread, plus a fake `claude` (node script) printing stream-json. */
async function setUp(fakeOutput: object[]) {
  let dir = createTempDir();
  tempDirs.push(dir);
  let store = new ReviewStore(dir);
  let threadId = "";
  await store.updateReview("b", () => {
    let review = createReview("b", "develop", "abc");
    let anchor = { startLine: 1, endLine: 1, lineText: "x", contextBefore: [], contextAfter: [] };
    threadId = addThread(review, { file: "a.ts", side: "modified", anchor, author: { kind: "user", name: "U" },
      body: "Why?" }).id;
    return review;
  });
  let fakeClaude = path.join(dir, "fake-claude.js");
  fs.writeFileSync(fakeClaude, fakeOutput.map(o => `console.log(${JSON.stringify(JSON.stringify(o))});`).join("\n"));
  let request = { store, branch: "b", threadId, claude: { command: process.execPath, args: [fakeClaude] }, args: [],
    cwd: dir, newSessionId: "new-session", agentName: "Claude", onLine: () => {} };
  return { store, request };
}

describe("answerThreadInBackground", () => {
  it("records the follow-up session and posts Claude's final message if Claude didn't reply via MCP", async () => {
    let { store, request } = await setUp([
      { type: "system", subtype: "init", session_id: "new-session" },
      { type: "result", subtype: "success", is_error: false, result: "Because of X.", session_id: "new-session" },
    ]);

    let answer = await answerThreadInBackground(request);

    let review = (await store.readReview("b"))!;
    expect(answer).toMatchObject({ sessionId: "new-session", resultText: "Because of X.", isFallbackPosted: true,
      exitCode: 0 });
    expect(review.sessions).toEqual([expect.objectContaining({ sessionId: "new-session", role: "followup" })]);
    expect(review.threads[0].comments.at(-1)).toMatchObject({ author: { kind: "agent", name: "Claude" },
      body: "Because of X.", sessionId: "new-session" });
  });

  it("posts a note when Claude exits without a result", async () => {
    let { store, request } = await setUp([]);
    await answerThreadInBackground(request);
    expect((await store.readReview("b"))!.threads[0].comments.at(-1)?.body).toMatch(/exited with code 0/);
  });
});
