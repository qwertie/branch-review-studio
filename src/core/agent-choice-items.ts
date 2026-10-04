import { AgentChoice, getAgentChoices } from "./agent-commands";
import { AgentIntegration } from "./agent-integration";
import { claudeIntegration } from "./claude-cli";
import { codexIntegration } from "./codex-cli";
import { AgentKind, IntegrationId, ReviewSession } from "./review";
import { vscodeChatChoiceDetail, vscodeChatDisplayName } from "./vscode-chat";

/** An item of Ask Agent's QuickPick (a vscode.QuickPickItem without VS Code types). */
export interface AgentChoiceItem {
  label: string;
  description?: string;
  detail?: string;
  /** What the item does; undefined for a separator */
  choice?: AgentChoice;
  /** True for a separator, which heads one agent's items */
  isSeparator?: boolean;
}

/** Gets the integration that runs the given agent CLI. */
export function getAgentIntegration(agent: AgentKind): AgentIntegration {
  return agent === "claude" ? claudeIntegration : codexIntegration;
}

/**
 * Builds Ask Agent's QuickPick items for the ways to send the message (see getAgentChoices),
 * default first, with a separator per agent if there are several agents. `forkableSession` can be
 * forked only if a CLI agent in `availableAgents` ran it.
 */
export function getAgentChoiceItems(availableAgents: AgentKind[],
  forkableSession: Pick<ReviewSession, "agent" | "sessionId"> | undefined, hasVscodeChat: boolean)
  : AgentChoiceItem[] {
  let choices = getAgentChoices(availableAgents, forkableSession?.agent, hasVscodeChat);
  let hasSeveralAgents = new Set(choices.map(c => c.agent)).size > 1;
  let items: AgentChoiceItem[] = [];
  for (let choice of choices) {
    let { agent } = choice;
    if (hasSeveralAgents && items.at(-1)?.choice?.agent !== agent)
      items.push({ label: getIntegrationDisplayName(agent), isSeparator: true });
    if (agent === "vscodeChat") {
      items.push({ label: `$(chat-sparkle) ${vscodeChatDisplayName} (agent mode)`, description: "new chat",
        detail: vscodeChatChoiceDetail, choice });
    } else {
      let integration = getAgentIntegration(agent);
      let isFork = choice.sessionMode === "fork";
      let where = choice.runMode === "interactive" ? "interactive terminal" : "background";
      items.push({ choice, label: `${isFork ? "$(repo-forked) Fork review session" : "$(add) Fresh session"}, ${where}`,
        description: isFork ? `forks session ${forkableSession?.sessionId.slice(0, 8)}` : undefined,
        detail: choice.runMode === "background"
          ? `Runs ${integration.backgroundCommand}; the answer appears in the thread` : undefined });
    }
  }
  return items;
}

/** Gets the name of an integration shown in the UI, e.g. "Claude Code" or "VS Code Chat". */
export function getIntegrationDisplayName(integration: IntegrationId): string {
  return integration === "vscodeChat" ? vscodeChatDisplayName : getAgentIntegration(integration).displayName;
}
