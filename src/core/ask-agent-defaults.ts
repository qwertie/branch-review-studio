import { getIntegrationDisplayName } from "./agent-choice-items";
import { AgentChoice } from "./agent-commands";
import { IntegrationId, ReviewSession } from "./review";

/**
 * Values of the settings `branchReviewStudio.askAgent.*`, which say what the primary button of a
 * comment box ("Send to <agent>") does.
 */
export interface AskAgentDefaults {
  /**
   * Who answers: 'sameAsReview' = the integration that ran the review session (see
   * resolveDefaultChoice); 'ask' = Ask Agent's picker each time
   */
  agent: "sameAsReview" | IntegrationId | "ask";
  /** Whether to fork the review session when possible, or always start a fresh one */
  session: "forkWhenPossible" | "fresh";
  /** Where Claude Code and Codex run (VS Code's chat always opens a new chat) */
  runIn: "terminal" | "background";
}

/** Section of the askAgent settings, e.g. `branchReviewStudio.askAgent.agent`. */
export const askAgentSettingsSection = "branchReviewStudio.askAgent";

/**
 * The options of each askAgent setting with their labels, default first, as package.json declares
 * them and the settings panel lists them.
 */
export const askAgentSettingOptions: {
  [K in keyof AskAgentDefaults]: { value: AskAgentDefaults[K], label: string }[]
} = {
  agent: [{ value: "sameAsReview", label: "Same agent as the review" },
    ...(["claude", "codex", "vscodeChat"] as const).map(value => ({ value, label: getIntegrationDisplayName(value) })),
    { value: "ask", label: "Ask each time" }],
  session: [{ value: "forkWhenPossible", label: "Fork the review session when possible" },
    { value: "fresh", label: "Fresh session" }],
  runIn: [{ value: "terminal", label: "Terminal" }, { value: "background", label: "Background" }],
};

/** The askAgent settings' values when the user hasn't set them (the first option of each). */
export const defaultAskAgentSettings: AskAgentDefaults = { agent: askAgentSettingOptions.agent[0].value,
  session: askAgentSettingOptions.session[0].value, runIn: askAgentSettingOptions.runIn[0].value };

/**
 * Who a comment box's "Send to <agent>" button sends to: an integration, or 'ask' = the button is
 * "Send to Agent…", which shows Ask Agent's picker.
 */
export type SendTarget = IntegrationId | "ask";

/**
 * Context key that holds the SendTarget of new threads, which have no `contextValue` of their own
 * (a saved thread's `contextValue` ends with `.<SendTarget>`). package.json's comment menu tests
 * it.
 */
export const newThreadSendTargetKey = "branchReviewStudio.newThreadSendTarget";

/** Reads the askAgent settings with `get(key)`, replacing missing or invalid values by defaults. */
export function parseAskAgentDefaults(get: (key: keyof AskAgentDefaults) => unknown): AskAgentDefaults {
  let read = <K extends keyof AskAgentDefaults>(key: K) =>
    askAgentSettingOptions[key].find(o => o.value === get(key))?.value ?? defaultAskAgentSettings[key];
  return { agent: read("agent"), session: read("session"), runIn: read("runIn") };
}

/** The session that Ask Agent would fork for a thread, and whether its folder still exists. */
export interface SessionToFork extends Pick<ReviewSession, "agent" | "cwd"> {
  /** False if `cwd` is gone; `claude --resume` finds a session only in the folder it ran in */
  hasFolder: boolean;
}

/**
 * Explains why Ask Agent can't fork `session` with the integrations in `available`, as a clause
 * that follows "because"; undefined if it can.
 */
export function getForkProblem(session: SessionToFork, available: readonly IntegrationId[]): string | undefined {
  return session.agent === "vscodeChat" ? "it ran in VS Code's chat, which can't fork chats"
    : !available.includes(session.agent)
      ? `the ${getIntegrationDisplayName(session.agent)} CLI, which ran it, was not found`
      : !session.hasFolder ? `its folder ${session.cwd} no longer exists` : undefined;
}

/** What "Send to <agent>" does: send with `choice`, or if it's undefined, show the picker. */
export interface DefaultChoice {
  choice?: AgentChoice;
  /** Why the picker is shown instead of sending to the configured agent */
  problem?: string;
}

/**
 * Resolves the askAgent settings into what "Send to <agent>" does for a thread, given the
 * integrations that are `available` and the review `session` that Ask Agent would fork.
 * 'sameAsReview' picks the integration that ran `session` if available, else Claude Code, else the
 * first available one. An unavailable configured agent yields the picker with a problem. The
 * choice forks `session` only if `defaults.session` allows it, the chosen agent ran `session`, and
 * it can be forked (see getForkProblem). VS Code's chat always gets a new chat.
 */
export function resolveDefaultChoice(defaults: AskAgentDefaults, available: readonly IntegrationId[],
  session: SessionToFork | undefined): DefaultChoice {
  let agent = defaults.agent === "ask" ? undefined : defaults.agent === "sameAsReview"
    ? [session?.agent, "claude" as const, ...available].find(a => a !== undefined && available.includes(a))
    : defaults.agent;
  if (agent === undefined)
    return {};
  if (!available.includes(agent)) {
    let reason = agent === "vscodeChat" ? "this VS Code lacks the chat commands that it needs"
      : `its CLI was not found (install it, or set branchReviewStudio.${agent}Path)`;
    return { problem: `Can't send to ${getIntegrationDisplayName(agent)}, the default agent (setting `
      + `${askAgentSettingsSection}.agent): ${reason}.` };
  }
  if (agent === "vscodeChat")
    return { choice: { agent, sessionMode: "fresh", runMode: "interactive" } };
  let canFork = defaults.session === "forkWhenPossible" && session?.agent === agent
    && getForkProblem(session, available) === undefined;
  return { choice: { agent, sessionMode: canFork ? "fork" : "fresh",
    runMode: defaults.runIn === "terminal" ? "interactive" : "background" } };
}
