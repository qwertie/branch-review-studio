import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { mcpServerName } from "../core/agent-commands";
import { AgentCommand, AgentIntegration, runAgentCommand } from "../core/agent-integration";
import { getErrorMessage, readFileIfExists } from "../core/files";
import {
  agentIntegrations, AgentServices, findAgentCommand, getBundledServerPath, getBundledSkillPath,
} from "./agents";

/**
 * Stable per-user copy of dist/mcp-server.js. Agents' registrations point here rather than into the
 * extension folder, whose path changes with every extension version.
 */
const installedServerPath = path.join(os.homedir(), ".branch-review-studio", "mcp-server.js");

/**
 * Installs the MCP server and the skill (see installForAgent) for every agent whose CLI is found.
 */
export async function installMcpServer(services: AgentServices): Promise<void> {
  let installed: string[] = [];
  for (let integration of getIntegrationsWithCli()) {
    if (await installForAgent(services, integration))
      installed.push(integration.displayName);
  }
  if (installed.length > 0) {
    void vscode.window.showInformationMessage(`Registered the '${mcpServerName}' MCP server (which runs `
      + `${installedServerPath}) and installed the skill for ${installed.join(" and ")}. New sessions will load them.`);
  }
}

/**
 * Copies the MCP server to `installedServerPath`, registers it with the agent at user scope (e.g.
 * `claude mcp add --scope user branch-review-studio -- node <path>`), and copies the skill into the
 * agent's skill folder. Shows and records any error; returns true on success.
 */
export async function installForAgent(services: AgentServices, integration: AgentIntegration): Promise<boolean> {
  return await runInstallStep(services, integration, "Install", async command => {
    await copyServer(services.context);
    // `mcp add` fails if the name is already registered, so remove any old registration first
    await runAgentCommand(command, integration.mcpRemoveArgs).catch(() => "");
    let output = await runAgentCommand(command, integration.getMcpAddArgs(installedServerPath));
    services.log.appendLine(`Registered the MCP server with ${integration.displayName}: ${output.trim()}`);
    await installSkillForAgent(services.context, integration);
  });
}

/** Copies the branch-review-studio skill into the skill folder of each agent whose CLI is found. */
export async function installSkill(context: vscode.ExtensionContext): Promise<void> {
  let skillDirs: string[] = [];
  for (let integration of getIntegrationsWithCli())
    skillDirs.push(await installSkillForAgent(context, integration));
  if (skillDirs.length > 0)
    void vscode.window.showInformationMessage(`Installed the skill in ${skillDirs.join(" and ")}.`);
}

/** Removes every agent's MCP registration and skill, and the copied server, after asking. */
export async function uninstall(services: AgentServices): Promise<void> {
  let skillDirs = agentIntegrations.map(i => i.getSkillDir(os.homedir()));
  let choice = await vscode.window.showWarningMessage(`Remove the '${mcpServerName}' MCP server from Claude Code `
    + `and Codex and delete ${[path.dirname(installedServerPath), ...skillDirs].join(", ")}? Reviews are kept.`,
    { modal: true }, "Uninstall");
  if (choice === "Uninstall") {
    for (let integration of getIntegrationsWithCli())
      await uninstallForAgent(services, integration);
    for (let dir of [path.dirname(installedServerPath), ...skillDirs])
      await fs.rm(dir, { recursive: true, force: true });
    void vscode.window.showInformationMessage("Uninstalled the Branch Review Studio MCP server and skills.");
  }
}

/** Removes the MCP server's registration and the skill of one agent. Returns true on success. */
export async function uninstallForAgent(services: AgentServices, integration: AgentIntegration): Promise<boolean> {
  return await runInstallStep(services, integration, "Uninstall", async command => {
    let output = await runAgentCommand(command, integration.mcpRemoveArgs)
      .catch(e => `(${getErrorMessage(e)})`);
    services.log.appendLine(`Unregistered the MCP server from ${integration.displayName}: ${output.trim()}`);
    await fs.rm(integration.getSkillDir(os.homedir()), { recursive: true, force: true });
  });
}

/** If the MCP server is installed but differs from this extension version's copy, replaces it. */
export async function updateInstalledServerIfOutdated(context: vscode.ExtensionContext,
  log: vscode.OutputChannel): Promise<void> {
  let installed = await readFileIfExists(installedServerPath);
  if (installed !== undefined && installed !== await fs.readFile(getBundledServerPath(context), "utf8")) {
    await copyServer(context);
    log.appendLine(`Updated ${installedServerPath}`);
  }
}

/** Gets the integrations whose CLI is found, showing an error if there are none. */
function getIntegrationsWithCli(): AgentIntegration[] {
  let integrations = agentIntegrations.filter(i => findAgentCommand(i));
  if (integrations.length === 0) {
    void vscode.window.showErrorMessage("Could not find the Claude Code CLI (claude) or the Codex CLI (codex). "
      + "Install one, or set the branchReviewStudio.claudePath or branchReviewStudio.codexPath setting.");
  }
  return integrations;
}

/**
 * Runs an install or uninstall step for one agent with the agent's CLI, recording the outcome in
 * `services.errors` and showing any error. Returns true on success.
 */
async function runInstallStep(services: AgentServices, integration: AgentIntegration, operation: string,
  step: (command: AgentCommand) => Promise<void>): Promise<boolean> {
  try {
    let command = findAgentCommand(integration);
    if (command === undefined)
      throw new Error(`Could not find the ${integration.displayName} CLI.`);
    await step(command);
    await services.errors.recordSuccess(integration.agent);
    return true;
  } catch (e) {
    void vscode.window.showErrorMessage(`${operation} for ${integration.displayName} failed: ${getErrorMessage(e)}`);
    await services.errors.recordError(integration.agent, operation, getErrorMessage(e));
    return false;
  }
}

/** Copies the skill into the agent's skill folder and returns the folder. */
async function installSkillForAgent(context: vscode.ExtensionContext, integration: AgentIntegration)
  : Promise<string> {
  let skillDir = integration.getSkillDir(os.homedir());
  await fs.mkdir(skillDir, { recursive: true });
  await fs.copyFile(getBundledSkillPath(context), path.join(skillDir, "SKILL.md"));
  return skillDir;
}

async function copyServer(context: vscode.ExtensionContext): Promise<void> {
  await fs.mkdir(path.dirname(installedServerPath), { recursive: true });
  await fs.copyFile(getBundledServerPath(context), installedServerPath);
}
