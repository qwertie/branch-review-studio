import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { mcpServerName } from "../core/agent-commands";
import { ClaudeCommand, findClaudeExecutableForProcess, runClaudeCommand } from "../core/claude-cli";
import { readFileIfExists } from "../core/files";
import { getErrorMessage } from "./model";

/**
 * Stable per-user copy of dist/mcp-server.js. Claude Code's registration points here rather than
 * into the extension folder, whose path changes with every extension version.
 */
const installedServerPath = path.join(os.homedir(), ".branch-review-studio", "mcp-server.js");
const installedSkillDir = path.join(os.homedir(), ".claude", "skills", "branch-review-studio");

/**
 * Copies the MCP server to `installedServerPath` and registers it with Claude Code at user scope
 * (`claude mcp add --scope user branch-review-studio -- node <path>`), then offers to install the
 * skill.
 */
export async function installMcpServer(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
  let claude = findClaude();
  if (claude) {
    try {
      await copyServer(context);
      // `mcp add` fails if the name is already registered, so remove any old registration first
      await runClaudeCommand(claude, ["mcp", "remove", "--scope", "user", mcpServerName]).catch(() => "");
      let output = await runClaudeCommand(claude,
        ["mcp", "add", "--scope", "user", mcpServerName, "--", "node", installedServerPath]);
      log.appendLine(`Registered MCP server: ${output.trim()}`);
      let choice = await vscode.window.showInformationMessage(`Registered the '${mcpServerName}' MCP server `
        + `for Claude Code (user scope, runs ${installedServerPath}). New Claude Code sessions will load it.`,
        "Install Claude Skill Too");
      if (choice)
        await installSkill(context);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not install the MCP server: ${getErrorMessage(e)}`);
    }
  }
}

/** Copies the branch-review-studio skill to ~/.claude/skills/. */
export async function installSkill(context: vscode.ExtensionContext): Promise<void> {
  await fs.mkdir(installedSkillDir, { recursive: true });
  await fs.copyFile(path.join(context.extensionPath, "skills", "branch-review-studio", "SKILL.md"),
    path.join(installedSkillDir, "SKILL.md"));
  void vscode.window.showInformationMessage(`Installed the Claude skill in ${installedSkillDir}.`);
}

/** Removes the MCP registration, the copied server and the copied skill, after asking. */
export async function uninstall(log: vscode.OutputChannel): Promise<void> {
  let choice = await vscode.window.showWarningMessage(`Remove the '${mcpServerName}' MCP server from Claude Code `
    + `and delete ${path.dirname(installedServerPath)} and ${installedSkillDir}? Reviews are kept.`,
    { modal: true }, "Uninstall");
  let claude = choice === "Uninstall" ? findClaude() : undefined;
  if (claude) {
    let output = await runClaudeCommand(claude, ["mcp", "remove", "--scope", "user", mcpServerName])
      .catch(e => getErrorMessage(e));
    log.appendLine(`claude mcp remove: ${output.trim()}`);
    await fs.rm(path.dirname(installedServerPath), { recursive: true, force: true });
    await fs.rm(installedSkillDir, { recursive: true, force: true });
    void vscode.window.showInformationMessage("Uninstalled the Branch Review Studio MCP server and skill.");
  }
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

/** Finds the Claude Code CLI, showing an error if it is missing. */
export function findClaude(): ClaudeCommand | undefined {
  let configuredPath = vscode.workspace.getConfiguration("branchReviewStudio").get<string>("claudePath") ?? "";
  let claude = findClaudeExecutableForProcess(configuredPath);
  if (claude === undefined) {
    void vscode.window.showErrorMessage("Could not find the Claude Code CLI (claude). Install it, or set "
      + "the branchReviewStudio.claudePath setting.");
  }
  return claude;
}

async function copyServer(context: vscode.ExtensionContext): Promise<void> {
  await fs.mkdir(path.dirname(installedServerPath), { recursive: true });
  await fs.copyFile(getBundledServerPath(context), installedServerPath);
}

function getBundledServerPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "dist", "mcp-server.js");
}
