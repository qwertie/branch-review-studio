import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildReviewPrompt, mcpServerName } from "../core/agent-commands";
import { AgentIntegration, runAgentCommand } from "../core/agent-integration";
import { getBaseBranchChoices, listBranches } from "../core/git";
import { checkIntegrationStatus, IntegrationStatus, isIntegrationAvailable } from "../core/integration-status";
import { agentIntegrations, AgentServices, codexExtensionId, findAgentCommand } from "./agents";
import { changeBaseBranchIfConfirmed } from "./change-base-branch";
import { installForAgent, uninstallForAgent } from "./install";
import { BranchReviewModel } from "./model";

/** A message that the panel's webview script posts when the user clicks a button. */
interface PanelMessage {
  command: "changeBaseBranch" | "copyReviewPrompt" | "recheck" | "install" | "uninstall";
  /** The agent of the integration whose button was clicked */
  agent?: string;
  /** The base branch selected in the panel */
  baseBranch?: string;
}

/**
 * The "Branch Review Studio" panel (a webview in the editor area, since VS Code has no rich modal
 * dialogs). It explains how to start a review, lets the user change the base branch, and shows
 * the status of each agent integration, which it checks when it opens and on Re-check.
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  /** Status of each integration; undefined while checking */
  private statuses: IntegrationStatus[] | undefined;
  /** What the branch section showed when last rendered (see getBranchState) */
  private renderedBranchState = "";

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly model: BranchReviewModel
    | undefined, private readonly services: AgentServices) {
    let subscriptions = [panel.webview.onDidReceiveMessage((message: PanelMessage) => this.handleMessage(message))];
    if (model) {
      subscriptions.push(model.onDidChange(() => {
        // Re-rendering resets the scroll position, so it happens only if the branch section changes
        if (this.getBranchState() !== this.renderedBranchState)
          void this.render();
      }));
    }
    panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
      vscode.Disposable.from(...subscriptions).dispose();
    });
  }

  /** Shows the panel (creating it if needed) and checks the integrations' status. */
  static show(model: BranchReviewModel | undefined, services: AgentServices): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
    } else {
      let panel = vscode.window.createWebviewPanel("branchReviewStudio.settings", "Branch Review Studio",
        vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
      SettingsPanel.current = new SettingsPanel(panel, model, services);
    }
    void SettingsPanel.current.checkStatuses();
  }

  /** Re-renders the panel if it is open, e.g. after an integration error was recorded. */
  static renderIfOpen(): void {
    void SettingsPanel.current?.render();
  }

  private async checkStatuses(): Promise<void> {
    this.statuses = undefined;
    await this.render();
    this.statuses = await Promise.all(agentIntegrations.map(integration =>
      checkIntegrationStatus(integration, findAgentCommand(integration), runAgentCommand)));
    await this.render();
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    let integration = agentIntegrations.find(i => i.agent === message.agent);
    let { model } = this;
    if (message.command === "changeBaseBranch" && model && message.baseBranch) {
      // The message comes from the webview, so accept only a branch that the panel offers
      if ((await getBaseBranchOptions(model)).includes(message.baseBranch))
        await changeBaseBranchIfConfirmed(model, message.baseBranch);
    } else if (message.command === "copyReviewPrompt" && model?.snapshot.branch) {
      await vscode.env.clipboard.writeText(buildReviewPrompt(model.snapshot.branch, model.baseBranch));
      void vscode.window.showInformationMessage("Copied the review prompt. Paste it into Claude Code or Codex.");
    } else if (message.command === "recheck") {
      await this.checkStatuses();
    } else if ((message.command === "install" || message.command === "uninstall") && integration) {
      await (message.command === "install" ? installForAgent : uninstallForAgent)(this.services, integration);
      await this.checkStatuses();
    }
  }

  private async render(): Promise<void> {
    let nonce = randomBytes(16).toString("hex");
    this.renderedBranchState = this.getBranchState();
    let branchSection = this.model ? await this.renderBranchSection(this.model)
      : "<p>No workspace folder is in a git repo.</p>";
    let integrationRows = agentIntegrations.map(i => this.renderIntegration(i, this.statuses?.find(s => s.agent
      === i.agent))).join("\n");
    // The user may have closed the panel during the awaits
    if (SettingsPanel.current === this) {
      this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${styles}</style>
</head>
<body>
<h1>Branch Review Studio</h1>
${renderHowTo(this.model)}
<h2>Branch</h2>
${branchSection}
<h2>Integrations <button class="secondary" data-command="recheck">Re-check</button></h2>
${integrationRows}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
    }
  }

  /** Gets the state that the branch section shows, as a string */
  private getBranchState(): string {
    let snapshot = this.model?.snapshot;
    return JSON.stringify([snapshot?.branch, this.model?.baseBranch, snapshot?.mergeBase, snapshot?.mergeBaseError]);
  }

  private async renderBranchSection(model: BranchReviewModel): Promise<string> {
    let { branch, mergeBase, mergeBaseError } = model.snapshot;
    let baseBranch = model.baseBranch;
    let options = (await getBaseBranchOptions(model))
      .map(name => `<option${name === baseBranch ? " selected" : ""}>${escapeHtml(name)}</option>`);
    let mergeBaseText = mergeBase ? `<code>${mergeBase.mergeBaseSha.slice(0, 10)}</code> (merge-base of HEAD and `
      + `${escapeHtml(mergeBase.baseRef)})` : `<span class="error">${escapeHtml(mergeBaseError ?? "unknown")}</span>`;
    return `<table>
<tr><th>Folder</th><td><code>${escapeHtml(model.repoRoot)}</code></td></tr>
<tr><th>Branch</th><td><code>${escapeHtml(branch ?? "(detached HEAD)")}</code></td></tr>
<tr><th>Base branch</th><td><select id="baseBranch" data-base="${escapeHtml(baseBranch)}">${options.join("")}</select>
  <button data-command="changeBaseBranch">Change Base Branch</button></td></tr>
<tr><th>Merge-base</th><td>${mergeBaseText}</td></tr>
</table>`;
  }

  private renderIntegration(integration: AgentIntegration, status: IntegrationStatus | undefined): string {
    let agent = integration.agent;
    let lastError = this.services.errors.getLastError(agent);
    let skillFile = path.join(integration.getSkillDir(os.homedir()), "SKILL.md");
    let summary = status === undefined ? "Checking…" : isIntegrationAvailable(status)
      ? `<span class="ok">✔ Apparently available</span>` : `<span class="error">✘ Not available</span>`;
    let rows = [
      ["CLI", status === undefined ? "…" : status.executable === undefined
        ? `<span class="error">not found</span> (install it, or set <code>branchReviewStudio.${agent}Path</code>)`
        : `<code>${escapeHtml(status.executable)}</code> ${escapeHtml(status.version ?? "")}`
          + status.problems.map(p => ` <span class="error">${escapeHtml(p)}</span>`).join("")],
      ["Signed in", formatYesNo(status?.isSignedIn)],
      [`MCP server <code>${mcpServerName}</code> registered`, formatYesNo(status?.isMcpServerRegistered)],
      ["Skill installed", `${formatYesNo(fs.existsSync(skillFile))} <code>${escapeHtml(skillFile)}</code>`],
      ...agent === "codex" ? [["Codex VS Code extension", formatCodexExtension()]] : [],
      ["Last error", lastError === undefined ? "none" : `<span class="error">${escapeHtml(lastError.message)}</span>`
        + `<br><span class="dim">${escapeHtml(lastError.operation)}, `
        + `${new Date(lastError.time).toLocaleString()}</span>`],
    ];
    return `<div class="integration">
<h3>${escapeHtml(integration.displayName)} — ${summary}</h3>
<table>${rows.map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`).join("\n")}</table>
<button data-command="install" data-agent="${agent}" title="Registers the MCP server with ${integration.displayName} `
  + `(user scope) and installs the skill">Install MCP Server and Skill</button>
<button class="secondary" data-command="uninstall" data-agent="${agent}">Uninstall</button>
</div>`;
  }
}

/** Renders the how-to at the top of the panel: how to run a review that posts to this extension. */
function renderHowTo(model: BranchReviewModel | undefined): string {
  let skillDirs = agentIntegrations.map(i => `${i.displayName}: <code>${escapeHtml(i.getSkillDir(os.homedir()))}`
    + "</code>").join("; ");
  let folder = model ? `<code>${escapeHtml(model.repoRoot)}</code>` : "this branch's worktree folder";
  let copyButton = model?.snapshot.branch ? ` <button data-command="copyReviewPrompt">Copy Review Prompt</button>` : "";
  return `<h2>How to run a review connected to this extension</h2>
<ol>
<li><b>Prerequisite:</b> the review tools (the <code>${mcpServerName}</code> MCP server) must be registered with the
  agent you'll use: click <b>Install MCP Server and Skill</b> in its section under Integrations below. That also
  installs the skill, a full branch-review workflow (tests, branch tracking, correctness, security, performance,
  conventions and dependency checks) that posts its findings with those tools (${skillDirs}).</li>
<li><b>Start the review:</b> open Claude Code (CLI, VS Code extension or T3 Code) or Codex (CLI, VS Code extension
  or app) in ${folder}, then run the skill (<code>/${mcpServerName}</code> in Claude Code,
  <code>$${mcpServerName}</code> in Codex) or paste the review prompt.${copyButton}
  The skill reviews in a single context; add "be thorough" (or <code>--thorough</code>) for a review by
  parallel sub-agents, which costs several times as many tokens. If the repo has its own review command
  that posts to Branch Review Studio (e.g. Barreleye's <code>/branch-review</code>), you can use that
  instead.</li>
<li><b>Then:</b> the agent's findings appear as comment threads in the Branch Review view as it posts them. Answer
  with <b>Reply</b>, or with <b>Ask Agent</b> to send your message to a fork of the reviewing session (with the
  same agent) or to a fresh session.</li>
</ol>`;
}

/** Lists the branches that the panel offers as base branches (see getBaseBranchChoices). */
async function getBaseBranchOptions(model: BranchReviewModel): Promise<string[]> {
  return getBaseBranchChoices(await listBranches(model.repoRoot).catch(() => []), model.baseBranch,
    model.snapshot.branch);
}

/** Describes the Codex VS Code extension's installation for the Codex integration's section. */
function formatCodexExtension(): string {
  let extension = vscode.extensions.getExtension(codexExtensionId);
  let version = extension?.packageJSON?.version;
  return extension === undefined ? "not installed"
    : `installed (${escapeHtml(`${codexExtensionId} ${typeof version === "string" ? version : ""}`.trim())}); `
      + "Ask Agent prefers its bundled Codex CLI, and offers to continue background answers in its sidebar";
}

/** Formats a check's result; undefined means that the check hasn't finished or couldn't run. */
function formatYesNo(value: boolean | undefined): string {
  return value === undefined ? "…" : value ? `<span class="ok">yes</span>` : `<span class="error">no</span>`;
}

/** Escapes text for use in HTML content and in quoted attribute values. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}

/**
 * The webview's script: posts a PanelMessage when a button with `data-command` is clicked, and
 * keeps the base branch that the user selected (but didn't apply yet) when the panel re-renders.
 */
const script = `
const vscode = acquireVsCodeApi();
const select = document.getElementById("baseBranch");
const state = vscode.getState();
if (select && state?.base === select.dataset.base && [...select.options].some(o => o.value === state.selected))
  select.value = state.selected;
select?.addEventListener("change", () => vscode.setState({ base: select.dataset.base, selected: select.value }));
document.addEventListener("click", event => {
  const button = event.target.closest("button[data-command]");
  if (button) {
    vscode.postMessage({ command: button.dataset.command, agent: button.dataset.agent,
      baseBranch: document.getElementById("baseBranch")?.value });
  }
});`;

/** The webview's CSS, which uses VS Code's theme colors. */
const styles = `
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
  padding: 0 20px 20px; max-width: 960px; line-height: 1.45; }
h2 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 28px; }
h3 { margin: 0 0 8px; }
th { text-align: left; font-weight: 600; padding: 3px 16px 3px 0; vertical-align: top; white-space: nowrap; }
td { padding: 3px 0; }
code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px; border-radius: 3px; }
li { margin-bottom: 8px; }
.integration { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 12px; margin: 12px 0; }
.ok { color: var(--vscode-testing-iconPassed); }
.error { color: var(--vscode-errorForeground); }
.dim { color: var(--vscode-descriptionForeground); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none;
  padding: 4px 12px; margin: 8px 6px 0 0; cursor: pointer; font-family: inherit; border-radius: 2px; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground); outline: 1px solid var(--vscode-panel-border); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
h2 button { font-size: 0.8em; margin: 0 0 0 12px; vertical-align: middle; }
select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border); padding: 3px; font-family: inherit; }`;
