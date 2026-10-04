import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AskAgentDefaults, askAgentSettingOptions, defaultAskAgentSettings, DefaultChoice, getForkProblem,
  newThreadSendTargetKey, parseAskAgentDefaults, resolveDefaultChoice, SendTarget, SessionToFork,
} from "./ask-agent-defaults";
import { IntegrationId } from "./review";

const all: IntegrationId[] = ["claude", "codex", "vscodeChat"];
const claudeSession: SessionToFork = { agent: "claude", cwd: "D:/repo", hasFolder: true };

/** Describes a resolved default, e.g. "claude fork interactive" or "picker: <problem>". */
function describeResult(result: DefaultChoice): string {
  let { choice, problem } = result;
  return choice ? `${choice.agent} ${choice.sessionMode} ${choice.runMode}` : `picker${problem ? `: ${problem}` : ""}`;
}

function resolve(defaults: Partial<AskAgentDefaults>, available: IntegrationId[], session?: SessionToFork) {
  return describeResult(resolveDefaultChoice({ ...defaultAskAgentSettings, ...defaults }, available, session));
}

describe("resolveDefaultChoice", () => {
  it.each([
    ["sameAsReview", "forkWhenPossible", "terminal", "claude fork interactive"],
    ["sameAsReview", "forkWhenPossible", "background", "claude fork background"],
    ["sameAsReview", "fresh", "terminal", "claude fresh interactive"],
    ["sameAsReview", "fresh", "background", "claude fresh background"],
    ["claude", "forkWhenPossible", "terminal", "claude fork interactive"],
    ["claude", "forkWhenPossible", "background", "claude fork background"],
    ["claude", "fresh", "terminal", "claude fresh interactive"],
    ["claude", "fresh", "background", "claude fresh background"],
    ["codex", "forkWhenPossible", "terminal", "codex fresh interactive"],
    ["codex", "forkWhenPossible", "background", "codex fresh background"],
    ["codex", "fresh", "terminal", "codex fresh interactive"],
    ["codex", "fresh", "background", "codex fresh background"],
    ["vscodeChat", "forkWhenPossible", "terminal", "vscodeChat fresh interactive"],
    ["vscodeChat", "forkWhenPossible", "background", "vscodeChat fresh interactive"],
    ["vscodeChat", "fresh", "terminal", "vscodeChat fresh interactive"],
    ["vscodeChat", "fresh", "background", "vscodeChat fresh interactive"],
    ["ask", "forkWhenPossible", "terminal", "picker"],
    ["ask", "forkWhenPossible", "background", "picker"],
    ["ask", "fresh", "terminal", "picker"],
    ["ask", "fresh", "background", "picker"],
  ] as const)("agent=%s, session=%s, runIn=%s with a forkable Claude review session: %s",
    (agent, session, runIn, expected) => {
      expect(resolve({ agent, session, runIn }, all, claudeSession)).toBe(expected);
    });

  it("sameAsReview picks the agent that ran the review session, which only it can fork", () => {
    expect(resolve({}, all, { agent: "codex", cwd: "D:/repo", hasFolder: true })).toBe("codex fork interactive");
    expect(resolve({ runIn: "background" }, all, { agent: "vscodeChat", cwd: "D:/repo", hasFolder: true }))
      .toBe("vscodeChat fresh interactive");
  });

  it("sameAsReview falls back to Claude Code, else to the first available integration", () => {
    expect(resolve({}, all)).toBe("claude fresh interactive");
    expect(resolve({}, ["codex", "vscodeChat"])).toBe("codex fresh interactive");
    expect(resolve({}, ["vscodeChat"])).toBe("vscodeChat fresh interactive");
    expect(resolve({}, [])).toBe("picker");
    // The review's agent isn't available, so its session can't be forked either
    expect(resolve({}, ["claude", "vscodeChat"], { agent: "codex", cwd: "D:/repo", hasFolder: true }))
      .toBe("claude fresh interactive");
  });

  it("starts a fresh session if the review session's folder no longer exists", () => {
    expect(resolve({}, all, { ...claudeSession, hasFolder: false })).toBe("claude fresh interactive");
  });

  it("shows the picker with the problem if the configured agent isn't available", () => {
    expect(resolve({ agent: "codex" }, ["claude", "vscodeChat"], claudeSession)).toBe("picker: Can't send to Codex, "
      + "the default agent (setting branchReviewStudio.askAgent.agent): its CLI was not found (install it, or set "
      + "branchReviewStudio.codexPath).");
    expect(resolve({ agent: "vscodeChat" }, ["claude"])).toBe("picker: Can't send to VS Code Chat, the default "
      + "agent (setting branchReviewStudio.askAgent.agent): this VS Code lacks the chat commands that it needs.");
  });
});

describe("getForkProblem", () => {
  it("explains why a review session can't be forked", () => {
    expect(getForkProblem(claudeSession, all)).toBeUndefined();
    expect(getForkProblem({ ...claudeSession, agent: "vscodeChat" }, all))
      .toBe("it ran in VS Code's chat, which can't fork chats");
    expect(getForkProblem(claudeSession, ["codex"])).toBe("the Claude Code CLI, which ran it, was not found");
    expect(getForkProblem({ ...claudeSession, hasFolder: false }, all)).toBe("its folder D:/repo no longer exists");
  });
});

describe("parseAskAgentDefaults", () => {
  it("reads valid values and replaces missing or invalid ones with the defaults", () => {
    let values: Record<string, unknown> = { agent: "codex", session: "sometimes", runIn: "background" };
    expect(parseAskAgentDefaults(key => values[key]))
      .toEqual({ agent: "codex", session: "forkWhenPossible", runIn: "background" });
    expect(parseAskAgentDefaults(() => undefined)).toEqual(defaultAskAgentSettings);
  });
});

describe("package.json Ask Agent contributions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"));
  const commandMenu: { command: string, when: string, group: string }[] =
    manifest.contributes.menus["comments/commentThread/context"];
  const getTitle = (command: string) =>
    manifest.contributes.commands.find((c: { command: string }) => c.command === command)?.title;

  it("declares the askAgent settings with the options, labels and defaults of askAgentSettingOptions", () => {
    for (let [key, options] of Object.entries(askAgentSettingOptions)) {
      let setting = manifest.contributes.configuration.properties[`branchReviewStudio.askAgent.${key}`];
      expect(setting.enum).toEqual(options.map(o => o.value));
      expect(setting.enumItemLabels).toEqual(options.map(o => o.label));
      expect(setting.default).toBe(defaultAskAgentSettings[key as keyof AskAgentDefaults]);
      expect(setting.scope).toBe("resource");
    }
  });

  it("shows one Send button per send target as the comment box's first (primary) action", () => {
    let buttons: [SendTarget, string, string][] = [["claude", "sendToClaude", "Send to Claude Code"],
      ["codex", "sendToCodex", "Send to Codex"], ["vscodeChat", "sendToVscodeChat", "Send to VS Code Chat"],
      ["ask", "sendToAgent", "Send to Agent…"]];
    for (let [target, name, title] of buttons) {
      let command = `branchReviewStudio.${name}`;
      expect(getTitle(command)).toBe(title);
      expect(commandMenu.find(m => m.command === command)).toEqual({ command, group: "inline@1",
        when: "commentController == branch-review-studio && (commentThreadIsEmpty && "
          + `${newThreadSendTargetKey} == ${target} || commentThread =~ /\\.${target}$/)` });
    }
    expect(commandMenu.map(m => `${m.group} ${getTitle(m.command)}`).filter(m => !m.includes("@1")))
      .toEqual(["inline@2 Send to…", "inline@3 Add Note to Self"]);
  });
});
