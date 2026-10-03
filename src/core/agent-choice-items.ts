import { AgentChoice, getAgentChoices } from "./agent-commands";
import { AgentIntegration } from "./agent-integration";
import { claudeIntegration } from "./claude-cli";
import { codexIntegration } from "./codex-cli";
import { languageModelChoiceDetail, languageModelDisplayName } from "./language-model";
import { AgentKind, ReviewSession } from "./review";

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
 * default first, with a separator per agent if there are several agents. `languageModelName` is
 * the name of the VS Code language model to offer, if any.
 */
export function getAgentChoiceItems(availableAgents: AgentKind[],
  forkableSession: Pick<ReviewSession, "agent" | "sessionId"> | undefined, languageModelName: string | undefined)
  : AgentChoiceItem[] {
  let choices = getAgentChoices(availableAgents, forkableSession?.agent, languageModelName !== undefined);
  let hasSeveralAgents = new Set(choices.map(c => c.agent)).size > 1;
  let items: AgentChoiceItem[] = [];
  for (let choice of choices) {
    let { agent } = choice;
    let integration = agent === "languageModel" ? undefined : getAgentIntegration(agent);
    if (hasSeveralAgents && items.at(-1)?.choice?.agent !== agent)
      items.push({ label: integration?.displayName ?? languageModelDisplayName, isSeparator: true });
    if (integration) {
      let isFork = choice.sessionMode === "fork";
      let where = choice.runMode === "interactive" ? "interactive terminal" : "background";
      items.push({ choice, label: `${isFork ? "$(repo-forked) Fork review session" : "$(add) Fresh session"}, ${where}`,
        description: isFork ? `forks session ${forkableSession?.sessionId.slice(0, 8)}` : undefined,
        detail: choice.runMode === "background"
          ? `Runs ${integration.backgroundCommand}; the answer appears in the thread` : undefined });
    } else {
      items.push({ label: `$(comment-discussion) ${languageModelName}, background`,
        description: "VS Code language model", detail: languageModelChoiceDetail, choice });
    }
  }
  return items;
}
