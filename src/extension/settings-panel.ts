import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildReviewPrompt, mcpServerName } from "../core/agent-commands";
import { AgentIntegration, runAgentCommand } from "../core/agent-integration";
import { AskAgentDefaults, askAgentSettingOptions, askAgentSettingsSection } from "../core/ask-agent-defaults";
import { getErrorMessage } from "../core/files";
import { getBaseBranchChoices, listBranches } from "../core/git";
import { checkIntegrationStatus, IntegrationStatus, isIntegrationAvailable } from "../core/integration-status";
import { escapeHtml } from "../core/markdown-subset";
import { IntegrationId } from "../core/review";
import { chatAgentName, vscodeChatDisplayName } from "../core/vscode-chat";
import {
  agentIntegrations, AgentServices, codexExtensionId, findAgentCommand, readAskAgentDefaults,
} from "./agents";
import { changeBaseBranchIfConfirmed } from "./change-base-branch";
import { installForAgent, uninstallForAgent } from "./install";
import { BranchReviewModel } from "./model";
import { VscodeChatIntegration, VscodeChatStatus } from "./vscode-chat";

/** A message that the panel's webview script posts when a button is clicked or a value picked. */
interface PanelMessage {
  command: "changeBaseBranch" | "copyReviewPrompt" | "recheck" | "install" | "uninstall" | "setAskAgentDefault"
    | "openReviewFile";
  /** The agent of the integration whose button was clicked */
  agent?: string;
  /** The base branch selected in the panel */
  baseBranch?: string;
  /** The askAgent setting whose dropdown changed (a key of AskAgentDefaults) */
  setting?: string;
  /** The option picked in that dropdown */
  value?: string;
}

/**
 * The "Branch Review Studio" panel (a webview in the editor area, since VS Code has no rich modal
 * dialogs). It explains how to start a review, lets the user set the askAgent settings and change
 * the base branch, and shows the status of each agent integration, which it checks when it opens
 * and on Re-check, and of VS Code's chat.
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  /** Status of each integration; undefined while checking */
  private statuses: IntegrationStatus[] | undefined;
  /** What the branch section showed when last rendered (see getBranchState) */
  private renderedBranchState = "";

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly model: BranchReviewModel
    | undefined, private readonly services: AgentServices, private readonly vscodeChat: VscodeChatIntegration) {
    let subscriptions = [panel.webview.onDidReceiveMessage((message: PanelMessage) => this.handleMessage(message)
      .catch(e => void vscode.window.showErrorMessage(getErrorMessage(e)))),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(askAgentSettingsSection))
        void this.render();
    })];
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
  static show(model: BranchReviewModel | undefined, services: AgentServices, vscodeChat: VscodeChatIntegration)
    : void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
    } else {
      let panel = vscode.window.createWebviewPanel("branchReviewStudio.settings", "Branch Review Studio",
        vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
      SettingsPanel.current = new SettingsPanel(panel, model, services, vscodeChat);
    }
    void SettingsPanel.current.checkStatuses();
  }

  /** Re-renders the panel if it is open, e.g. after an integration error was recorded. */
  static renderIfOpen(): void {
    void SettingsPanel.current?.render();
  }

  /** Handles a message as if the open panel's script had posted it, for scripts/smoke-test.ts. */
  static async handleMessageIfOpen(message: unknown): Promise<void> {
    await SettingsPanel.current?.handleMessage(message as PanelMessage);
  }

  /** Gets the open panel's HTML, for scripts/smoke-test.ts; undefined if the panel isn't open. */
  static getHtmlIfOpen(): string | undefined {
    return SettingsPanel.current?.panel.webview.html;
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
      void vscode.window.showInformationMessage("Copied the review prompt. Paste it into Claude Code, Codex or VS "
        + "Code's chat.");
    } else if (message.command === "openReviewFile" && model?.snapshot.branch) {
      await vscode.window.showTextDocument(vscode.Uri.file(model.store.getReviewPath(model.snapshot.branch)));
    } else if (message.command === "recheck") {
      await this.checkStatuses();
    } else if ((message.command === "install" || message.command === "uninstall") && integration) {
      await (message.command === "install" ? installForAgent : uninstallForAgent)(this.services, integration);
      await this.checkStatuses();
    } else if (message.command === "setAskAgentDefault" && message.setting) {
      // The message comes from the webview, so accept only a setting and value that the panel lists
      let options = Object.entries(askAgentSettingOptions).find(([key]) => key === message.setting)?.[1];
      if (options?.some(o => o.value === message.value))
        await updateAskAgentSetting(this.getScope(), message.setting, message.value);
    }
  }

  private async render(): Promise<void> {
    let nonce = randomBytes(16).toString("hex");
    this.renderedBranchState = this.getBranchState();
    let branchSection = this.model ? await this.renderBranchSection(this.model)
      : "<p>No workspace folder is in a git repo.</p>";
    let integrationRows = agentIntegrations.map(i => this.renderIntegration(i, this.statuses?.find(s => s.agent
      === i.agent))).join("\n");
    let vscodeChatSection = this.renderVscodeChatIntegration(await this.vscodeChat.getStatus());
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
${renderAskAgentDefaults(readAskAgentDefaults(this.getScope()))}
<h2>Branch</h2>
${branchSection}
<h2>Integrations <button class="secondary" data-command="recheck">Re-check</button></h2>
${integrationRows}
${vscodeChatSection}
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
    }
  }

  /** Gets the folder whose settings the panel shows: the repo's, if there is one. */
  private getScope(): vscode.Uri | undefined {
    return this.model && vscode.Uri.file(this.model.repoRoot);
  }

  /** Gets the state that the branch section shows, as a string */
  private getBranchState(): string {
    let snapshot = this.model?.snapshot;
    return JSON.stringify([snapshot?.branch, this.model?.baseBranch, snapshot?.mergeBase, snapshot?.mergeBaseError,
      snapshot?.review === undefined]);
  }

  private async renderBranchSection(model: BranchReviewModel): Promise<string> {
    let { branch, mergeBase, mergeBaseError, review } = model.snapshot;
    let baseBranch = model.baseBranch;
    let options = (await getBaseBranchOptions(model))
      .map(name => `<option${name === baseBranch ? " selected" : ""}>${escapeHtml(name)}</option>`);
    let mergeBaseText = mergeBase ? `<code>${mergeBase.mergeBaseSha.slice(0, 10)}</code> (merge-base of HEAD and `
      + `${escapeHtml(mergeBase.baseRef)})` : `<span class="error">${escapeHtml(mergeBaseError ?? "unknown")}</span>`;
    let reviewFileText = branch === undefined ? "none (detached HEAD)"
      : `<code>${escapeHtml(model.store.getReviewPath(branch))}</code> ` + (review
        ? `<button class="secondary" data-command="openReviewFile">Open Review File</button>` : "(not created yet)");
    return `<table>
<tr><th>Folder</th><td><code>${escapeHtml(model.repoRoot)}</code></td></tr>
<tr><th>Branch</th><td><code>${escapeHtml(branch ?? "(detached HEAD)")}</code></td></tr>
<tr><th>Base branch</th><td><select id="baseBranch" data-base="${escapeHtml(baseBranch)}">${options.join("")}</select>
  <button data-command="changeBaseBranch">Change Base Branch</button></td></tr>
<tr><th>Merge-base</th><td>${mergeBaseText}</td></tr>
<tr><th>Review file</th><td>${reviewFileText}</td></tr>
</table>`;
  }

  private renderIntegration(integration: AgentIntegration, status: IntegrationStatus | undefined): string {
    let agent = integration.agent;
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
      ["Last error", this.formatLastError(agent)],
    ];
    return `<div class="integration">
<h3>${escapeHtml(integration.displayName)} — ${summary}</h3>
${renderTable(rows)}
<button data-command="install" data-agent="${agent}" title="Registers the MCP server with ${integration.displayName} `
  + `(user scope) and installs the skill">Install MCP Server and Skill</button>
<button class="secondary" data-command="uninstall" data-agent="${agent}">Uninstall</button>
</div>`;
  }

  /**
   * Renders the section of the VS Code Chat integration: what it can and can't do, and its status.
   * The extension registers the MCP server with VS Code and contributes the skill, so the section
   * has no Install button.
   */
  private renderVscodeChatIntegration(status: VscodeChatStatus): string {
    let { server, skillCopy } = status;
    let summary = server ? `<span class="ok">✔ MCP server registered</span>`
      : `<span class="error">✘ MCP server not registered</span>`;
    let skill = !status.areSkillsEnabled
      ? `<span class="error">off</span>: VS Code's setting <code>chat.useAgentSkills</code> is false`
      : skillCopy === undefined ? `<span class="ok">provided</span> by this extension`
        : `VS Code uses your copy <code>${escapeHtml(skillCopy.path)}</code>, since skills in your skill folders take `
          + "precedence over skills that extensions provide; " + (skillCopy.isCurrent ? "it is this version's skill"
            : `<span class="error">it differs from this version's skill</span> (to update a copy that this extension `
              + "installed, click Install MCP Server and Skill above)");
    let rows = [
      [`MCP server <code>${mcpServerName}</code>`, server
        ? `<span class="ok">registered</span>: VS Code runs <code>${escapeHtml([server.command, ...server.args]
          .join(" "))}</code> in <code>${escapeHtml(server.cwd)}</code>`
        : `<span class="error">${escapeHtml(status.registrationProblem ?? "unknown problem")}</span>`],
      ["Server process", (status.lastStartTime ? `VS Code started it at ${status.lastStartTime.toLocaleTimeString()}`
        : "not started yet in this window: VS Code starts it when a chat needs its tools")
        + " (<b>MCP: List Servers</b> shows its state)"],
      ["Trust", "VS Code trusts MCP servers that extensions provide without asking; in Restricted Mode, it asks you "
        + "to trust the workspace first"],
      [`Skill <code>${mcpServerName}</code>`, skill],
      [`Agent <code>${escapeHtml(chatAgentName)}</code>`, "provided by this extension"],
      ["Last error", this.formatLastError("vscodeChat")],
    ];
    return `<div class="integration">
<h3>${vscodeChatDisplayName} — ${summary}</h3>
<p>VS Code's chat in agent mode (its own agent, with the models you've enabled there: GitHub Copilot, API keys
  you add with <b>Manage Models</b>, or other providers; <b>not</b> your Claude Code or ChatGPT subscription) can
  run full branch reviews and answer threads, with this extension's review tools. Nothing needs to be installed:
  pick the <b>${escapeHtml(chatAgentName)}</b> agent in the chat, or type <code>/${mcpServerName}</code>.
  <b>Ask Agent</b>'s ${vscodeChatDisplayName} choice opens a new chat with your message; the answer appears in the
  thread when the agent calls <code>review_reply</code>. VS Code can't fork chats, so it can't continue the reviewing
  chat. VS Code's built-in Claude and Codex agents don't use this; they use the Claude Code and Codex registrations
  above.</p>
${renderTable(rows)}
</div>`;
  }

  /** Formats the last error of an integration, with its operation and time. */
  private formatLastError(integration: IntegrationId): string {
    let lastError = this.services.errors.getLastError(integration);
    return lastError === undefined ? "none" : `<span class="error">${escapeHtml(lastError.message)}</span>`
      + `<br><span class="dim">${escapeHtml(lastError.operation)}, `
      + `${new Date(lastError.time).toLocaleString()}</span>`;
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
  agent you'll use. For Claude Code or Codex, click <b>Install MCP Server and Skill</b> in its section under
  Integrations below. That also installs the skill, a full branch-review workflow (tests, branch tracking,
  correctness, security, performance, conventions and dependency checks) that posts its findings with those tools
  (${skillDirs}). VS Code's chat needs no install: this extension registers the tools and provides the skill and the
  <b>${escapeHtml(chatAgentName)}</b> agent (see ${vscodeChatDisplayName} below).</li>
<li><b>Start the review:</b> open Claude Code (CLI, VS Code extension or T3 Code) or Codex (CLI, VS Code extension
  or app) in ${folder}, then run the skill (<code>/${mcpServerName}</code> in Claude Code,
  <code>$${mcpServerName}</code> in Codex) or paste the review prompt.${copyButton}
  Or, in VS Code's chat in agent mode, pick the <b>${escapeHtml(chatAgentName)}</b> agent or type
  <code>/${mcpServerName}</code>; it uses the models you've enabled in VS Code.
  The skill reviews in a single context; add "be thorough" (or <code>--thorough</code>) for a review by
  parallel sub-agents, which costs several times as many tokens. If the repo has its own review command
  that posts to Branch Review Studio (e.g. a <code>/branch-review</code> command), you can use that
  instead.</li>
<li><b>Then:</b> the agent's findings appear as comment threads in the Branch Review view as it posts them, and
  if it posts groups of related changes, the view lists the files under their groups. Answer in a thread with
  <b>Send to</b> <i>agent</i>, which sends your message to the agent set under Ask Agent defaults below (by
  default, a fork of the reviewing session, with the same agent), or with <b>Send to…</b> to pick a fork of the
  reviewing session, a fresh session, or a new chat in VS Code's chat. <b>Add Note to Self</b> saves your message
  without sending it.</li>
</ol>`;
}

/** Renders the section with a dropdown per askAgent setting, showing its value in `defaults`. */
function renderAskAgentDefaults(defaults: AskAgentDefaults): string {
  return `<h2>Ask Agent defaults</h2>
<p>The main button of a comment box, <b>Send to</b> <i>agent</i> (or Ctrl+Enter), saves your message and sends it,
  with the thread's context, to the agent set here. <b>Send to…</b> next to it lets you choose each time. If that
  agent isn't available, the main button is <b>Send to Agent…</b>, which lets you choose and says why. Changes are
  saved in your user settings, or in the workspace's settings if the setting is set there
  (<code>${askAgentSettingsSection}.*</code>).</p>
${renderTable([["Agent", renderSelect("agent")], ["Session", renderSelect("session")],
  ["Run in", `${renderSelect("runIn")} <span class="dim">(Claude Code and Codex; VS Code Chat always opens a new `
    + "chat)</span>"]])}`;

  function renderSelect(key: keyof AskAgentDefaults): string {
    let options = askAgentSettingOptions[key].map(o =>
      `<option value="${o.value}"${o.value === defaults[key] ? " selected" : ""}>${escapeHtml(o.label)}</option>`);
    return `<select data-setting="${key}">${options.join("")}</select>`;
  }
}

/**
 * Writes an askAgent setting where its current value comes from: the workspace folder's or the
 * workspace's settings if it is set there, else the user settings.
 */
async function updateAskAgentSetting(scope: vscode.Uri | undefined, key: string, value: unknown): Promise<void> {
  let config = vscode.workspace.getConfiguration(askAgentSettingsSection, scope);
  let inspected = config.inspect(key);
  let target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
    : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

/** Lists the branches that the panel offers as base branches (see getBaseBranchChoices). */
async function getBaseBranchOptions(model: BranchReviewModel): Promise<string[]> {
  return getBaseBranchChoices(await listBranches(model.repoRoot).catch(() => []), model.baseBranch,
    model.snapshot.branch);
}



/** Renders a two-column table of rows' names and values (HTML). */
function renderTable(rows: string[][]): string {
  return `<table>${rows.map(([name, value]) => `<tr><th>${name}</th><td>${value}</td></tr>`).join("\n")}</table>`;
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

/**
 * The webview's script: posts a PanelMessage when a button with `data-command` is clicked or a
 * dropdown with `data-setting` changes, and keeps the base branch that the user selected (but
 * didn't apply yet) when the panel re-renders.
 */
const script = `
const vscode = acquireVsCodeApi();
const select = document.getElementById("baseBranch");
const state = vscode.getState();
if (select && state?.base === select.dataset.base && [...select.options].some(o => o.value === state.selected))
  select.value = state.selected;
select?.addEventListener("change", () => vscode.setState({ base: select.dataset.base, selected: select.value }));
document.addEventListener("change", event => {
  const setting = event.target.closest("select[data-setting]");
  if (setting)
    vscode.postMessage({ command: "setAskAgentDefault", setting: setting.dataset.setting, value: setting.value });
});
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
