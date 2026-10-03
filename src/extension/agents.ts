import * as path from "node:path";
import * as vscode from "vscode";
import { AgentCommand, AgentIntegration, getSearchOptionsForProcess } from "../core/agent-integration";
import { claudeIntegration } from "../core/claude-cli";
import { codexIntegration, findCodexExtensionExecutables } from "../core/codex-cli";
import { IntegrationErrorLog } from "../core/integration-status";

/** The agent integrations, in the order in which the UI lists them. */
export const agentIntegrations: AgentIntegration[] = [claudeIntegration, codexIntegration];

/** Id of the OpenAI Codex VS Code extension. */
export const codexExtensionId = "openai.chatgpt";

/** What the agent-related commands need from the extension. */
export interface AgentServices {
  context: vscode.ExtensionContext;
  log: vscode.OutputChannel;
  /** Last error of each integration, which the settings panel shows */
  errors: IntegrationErrorLog;
}

/**
 * Finds an agent's CLI: the path in the setting `branchReviewStudio.<agent>Path` if set; for Codex,
 * the CLI bundled with the Codex VS Code extension if installed, since it is usually newer than a
 * `codex` on PATH; else the agent's usual places (see AgentIntegration.findExecutable).
 */
export function findAgentCommand(integration: AgentIntegration): AgentCommand | undefined {
  let configuredPath = vscode.workspace.getConfiguration("branchReviewStudio")
    .get<string>(`${integration.agent}Path`) ?? "";
  let codexExtension = integration.agent === "codex" ? vscode.extensions.getExtension(codexExtensionId) : undefined;
  let preferredPaths = codexExtension ? findCodexExtensionExecutables(codexExtension.extensionPath, process.platform)
    : [];
  return integration.findExecutable(getSearchOptionsForProcess(configuredPath, preferredPaths));
}

/** Gets the path of the MCP server script bundled with this extension. */
export function getBundledServerPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "dist", "mcp-server.js");
}

/**
 * Opens a Codex thread in the Codex VS Code extension's sidebar through its URI handler, which
 * navigates the sidebar to the route `/local/<threadId>`.
 */
export async function openCodexThread(threadId: string): Promise<void> {
  let uri = vscode.Uri.parse(`${vscode.env.uriScheme}://${codexExtensionId}/local/${encodeURIComponent(threadId)}`);
  await vscode.env.openExternal(uri);
}
