import { describe, expect, it } from "vitest";
import { getAgentChoiceItems } from "./agent-choice-items";
import { vscodeChatChoiceDetail } from "./vscode-chat";

describe("getAgentChoiceItems", () => {
  const describeItems = (items: ReturnType<typeof getAgentChoiceItems>) =>
    items.map(i => i.isSeparator ? `--- ${i.label}` : i.label);

  it("lists each agent's choices under a separator, with VS Code's chat last", () => {
    let items = getAgentChoiceItems(["claude"], { agent: "claude", sessionId: "1234567890" }, true);

    expect(describeItems(items)).toEqual([
      "--- Claude Code",
      "$(repo-forked) Fork review session, interactive terminal",
      "$(repo-forked) Fork review session, background",
      "$(add) Fresh session, interactive terminal",
      "$(add) Fresh session, background",
      "--- VS Code Chat",
      "$(chat-sparkle) VS Code Chat (agent mode)",
    ]);
    expect(items[1].description).toBe("forks session 12345678");
    expect(items[4].detail).toBe("Runs claude -p; the answer appears in the thread");
  });

  it("offers VS Code's chat as a new chat, and no fork of a review session that ran in VS Code's chat", () => {
    let items = getAgentChoiceItems(["claude"], { agent: "vscodeChat", sessionId: "chat-1" }, true);

    expect(describeItems(items)).toEqual([
      "--- Claude Code",
      "$(add) Fresh session, interactive terminal",
      "$(add) Fresh session, background",
      "--- VS Code Chat",
      "$(chat-sparkle) VS Code Chat (agent mode)",
    ]);
    expect(items[4]).toEqual({ label: "$(chat-sparkle) VS Code Chat (agent mode)", description: "new chat",
      detail: vscodeChatChoiceDetail, choice: { agent: "vscodeChat", sessionMode: "fresh", runMode: "interactive" } });
    expect(vscodeChatChoiceDetail).toBe("Runs in VS Code's chat with the model selected there, as a new chat (VS "
      + "Code can't fork chats); the answer appears in the thread when the agent calls review_reply");
  });

  it("omits separators when only one agent is available", () => {
    expect(describeItems(getAgentChoiceItems(["codex"], undefined, false)))
      .toEqual(["$(add) Fresh session, interactive terminal", "$(add) Fresh session, background"]);
    expect(describeItems(getAgentChoiceItems([], undefined, true)))
      .toEqual(["$(chat-sparkle) VS Code Chat (agent mode)"]);
  });
});
