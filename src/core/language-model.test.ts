import { describe, expect, it } from "vitest";
import {
  answerThreadWithModel, ChatMessage, findPreferredModel, ModelReply, runToolLoop, ToolCallingModel,
} from "./language-model";
import { ToolSet } from "./repo-tools";
import { addThread, createReview } from "./review";
import { ReviewStore } from "./store";
import { createFiles } from "./test-helpers";

/**
 * Creates a fake model that gives `replies` in order (an Error is thrown instead) and records the
 * messages of each request.
 */
function createModel(...replies: (ModelReply | Error)[]) {
  return createModelWithInputLimit(100_000, ...replies);
}

function createModelWithInputLimit(maxInputTokens: number, ...replies: (ModelReply | Error)[]) {
  let requests: ChatMessage[][] = [];
  let model: ToolCallingModel = {
    name: "Fake GPT",
    maxInputTokens,
    sendRequest: async messages => {
      requests.push(structuredClone(messages));
      let reply = replies.shift() ?? { text: "(no more replies)", toolCalls: [] };
      if (reply instanceof Error)
        throw reply;
      return reply;
    },
  };
  return { model, requests };
}

/**
 * Creates fake tools that echo their name and input (followed by `padding`), and record their
 * names in `calls`.
 */
function createTools(padding = ""): ToolSet & { calls: string[] } {
  let calls: string[] = [];
  return {
    calls,
    definitions: [{ name: "echo", description: "Echoes", inputSchema: { type: "object" } }],
    callTool: async (name, input) => {
      calls.push(name);
      return `${name} got ${JSON.stringify(input)}${padding}`;
    },
  };
}

const toolCall = (callId: string, input: object = {}) => ({ callId, name: "echo", input });

describe("runToolLoop", () => {
  it("runs the tools that the model calls, sends their results back, and returns the final text", async () => {
    let { model, requests } = createModel(
      { text: "Let me look.", toolCalls: [toolCall("c1", { path: "a.ts" }), toolCall("c2")] },
      { text: "It's fine.", toolCalls: [] });
    let tools = createTools();

    let result = await runToolLoop(model, "Why?", tools);

    expect(result).toEqual({ text: "It's fine.", toolRounds: 1, isStoppedEarly: false });
    expect(tools.calls).toEqual(["echo", "echo"]);
    expect(requests[1]).toEqual([
      { role: "user", text: "Why?" },
      { role: "assistant", text: "Let me look.", toolCalls: [toolCall("c1", { path: "a.ts" }), toolCall("c2")] },
      { role: "user", text: "", toolResults: [{ callId: "c1", text: `echo got {"path":"a.ts"}` },
        { callId: "c2", text: "echo got {}" }] },
    ]);
  });

  it("stops running tools after the round limit, telling the model to answer", async () => {
    let { model, requests } = createModel(
      { text: "", toolCalls: [toolCall("c1")] },
      { text: "", toolCalls: [toolCall("c2")] },
      { text: "Partial answer.", toolCalls: [toolCall("c3")] });
    let tools = createTools();

    let result = await runToolLoop(model, "Why?", tools, 2);

    expect(result).toEqual({ text: "Partial answer.", toolRounds: 2, isStoppedEarly: true });
    expect(tools.calls).toHaveLength(2);
    expect(requests).toHaveLength(3);
    expect(requests[2].at(-1)).toMatchObject({ role: "user", text: expect.stringMatching(/no more tool calls/i) });
  });

  it("truncates tool results to fit the model's input limit, and then tells the model to answer", async () => {
    let { model, requests } = createModelWithInputLimit(1000,
      { text: "", toolCalls: [toolCall("c1"), toolCall("c2")] },
      { text: "Partial answer.", toolCalls: [toolCall("c3")] });
    let tools = createTools("x".repeat(5000));

    let result = await runToolLoop(model, "Why?", tools);

    expect(result).toEqual({ text: "Partial answer.", toolRounds: 1, isStoppedEarly: true });
    let lastMessage = requests[1].at(-1);
    expect(lastMessage).toMatchObject({ role: "user",
      text: expect.stringMatching(/input limit.*no more tool calls/i) });
    // 1000 tokens are roughly 3000 characters, of which 80% (2400) is the budget
    let resultTexts = lastMessage?.role === "user" ? lastMessage.toolResults?.map(r => r.text) ?? [] : [];
    expect(resultTexts[0]).toMatch(/^echo got \{\}x+\n\[Truncated: showed 2\d\d\d of 5011 characters\. .*input limit/);
    expect(resultTexts[1]).toMatch(/^\[Truncated: showed 0 of 5011 characters/);
  });

  it("propagates the model's errors", async () => {
    let { model } = createModel({ text: "", toolCalls: [toolCall("c1")] }, new Error("quota exceeded"));
    await expect(runToolLoop(model, "Why?", createTools())).rejects.toThrow("quota exceeded");
  });
});

describe("answerThreadWithModel", () => {
  /** Creates a store with one thread that has a user message. */
  async function setUpThread() {
    let store = new ReviewStore(createFiles());
    let threadId = "";
    await store.updateReview("b", () => {
      let review = createReview("b", "develop", "abc");
      let anchor = { startLine: 1, endLine: 1, lineText: "x", contextBefore: [], contextAfter: [] };
      threadId = addThread(review, { file: "a.ts", side: "modified", anchor, author: { kind: "user", name: "U" },
        body: "Why?" }).id;
      return review;
    });
    return { store, threadId };
  }

  it("posts the model's answer as an agent comment named after the model", async () => {
    let { store, threadId } = await setUpThread();
    let { model } = createModel({ text: "", toolCalls: [toolCall("c1")] }, { text: "Because.", toolCalls: [] });

    await answerThreadWithModel({ store, branch: "b", threadId, model, prompt: "Why?", tools: createTools() });

    let comment = (await store.readReview("b"))!.threads[0].comments.at(-1);
    expect(comment).toMatchObject({ author: { kind: "agent", name: "Fake GPT (VS Code LM)" }, body: "Because." });
    expect(comment?.sessionId).toBeUndefined();
  });

  it("posts a note if the model answers with no text, e.g. after hitting the round limit", async () => {
    let { store, threadId } = await setUpThread();
    let { model } = createModel({ text: "", toolCalls: [toolCall("c1")] }, { text: "", toolCalls: [toolCall("c2")] });

    await answerThreadWithModel({ store, branch: "b", threadId, model, prompt: "Why?", tools: createTools(),
      maxToolRounds: 1 });

    expect((await store.readReview("b"))!.threads[0].comments.at(-1)?.body)
      .toBe("(Fake GPT stopped after 1 round of tool calls without answering.)");
  });
});

describe("findPreferredModel", () => {
  const models = [
    { vendor: "copilot", id: "gpt-5", family: "gpt-5", name: "GPT-5" },
    { vendor: "copilot", id: "claude-sonnet-4.5", family: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { vendor: "byok", id: "claude-sonnet-4.5", family: "claude", name: "Sonnet (my key)" },
  ];

  it("matches the preference as vendor/id, id, family or name, case-insensitively", () => {
    expect(findPreferredModel(models, "byok/claude-sonnet-4.5")).toBe(models[2]);
    expect(findPreferredModel(models, "CLAUDE-SONNET-4.5")).toBe(models[1]);
    expect(findPreferredModel(models, "claude")).toBe(models[2]);
    expect(findPreferredModel(models, "Sonnet (my key)")).toBe(models[2]);
  });

  it("falls back to the first model without a preference or if the preference matches none", () => {
    expect(findPreferredModel(models, "")).toBe(models[0]);
    expect(findPreferredModel(models, "gemini")).toBe(models[0]);
    expect(findPreferredModel([], "gpt-5")).toBeUndefined();
  });
});
