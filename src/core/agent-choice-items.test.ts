import { describe, expect, it } from "vitest";
import { getAgentChoiceItems } from "./agent-choice-items";
import { languageModelChoiceDetail } from "./language-model";

describe("getAgentChoiceItems", () => {
  const describeItems = (items: ReturnType<typeof getAgentChoiceItems>) =>
    items.map(i => i.isSeparator ? `--- ${i.label}` : i.label);

  it("lists each agent's choices under a separator, with the language model's last", () => {
    let items = getAgentChoiceItems(["claude"], { agent: "claude", sessionId: "1234567890" }, "GPT-5");

    expect(describeItems(items)).toEqual([
      "--- Claude Code",
      "$(repo-forked) Fork review session, interactive terminal",
      "$(repo-forked) Fork review session, background",
      "$(add) Fresh session, interactive terminal",
      "$(add) Fresh session, background",
      "--- VS Code Language Models",
      "$(comment-discussion) GPT-5, background",
    ]);
    expect(items[1].description).toBe("forks session 12345678");
    expect(items[4].detail).toBe("Runs claude -p; the answer appears in the thread");
  });

  it("states the language model's limits in its item's detail", () => {
    let items = getAgentChoiceItems([], undefined, "GPT-5");

    expect(items).toEqual([{ label: "$(comment-discussion) GPT-5, background", description: "VS Code language model",
      detail: languageModelChoiceDetail,
      choice: { agent: "languageModel", sessionMode: "fresh", runMode: "background" } }]);
    expect(languageModelChoiceDetail).toBe("Answers only, read-only, no session: it reads the repo with read-only "
      + "tools, can't edit files, and its answer appears in the thread");
  });

  it("omits separators when only one agent is available", () => {
    expect(describeItems(getAgentChoiceItems(["codex"], undefined, undefined)))
      .toEqual(["$(add) Fresh session, interactive terminal", "$(add) Fresh session, background"]);
  });
});
