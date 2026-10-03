import * as os from "node:os";
import * as vscode from "vscode";
import { getErrorMessage, readFileIfExists } from "../core/files";
import { buildMcpServerLaunch, findSkillCopiesThatTakePrecedence, McpServerLaunch } from "../core/vscode-chat";
import { AgentServices, getBundledServerPath, getBundledSkillPath } from "./agents";
import { BranchReviewModel } from "./model";

/** Id of the MCP server definition provider, as contributed in package.json. */
const mcpProviderId = "branchReviewStudio.mcpServer";

/** What the settings panel shows about the VS Code Chat integration. */
export interface VscodeChatStatus {
  /** How VS Code starts the MCP server; undefined if the server isn't registered */
  server: McpServerLaunch | undefined;
  /** Why the server isn't registered, if it isn't */
  registrationProblem: string | undefined;
  /** When VS Code last started the server in this window (it starts it when a chat needs it) */
  lastStartTime: Date | undefined;
  /** The copy of the skill that VS Code's chat loads instead of the contributed one, if any */
  skillCopy: { path: string, isCurrent: boolean } | undefined;
  /** Value of VS Code's `chat.useAgentSkills` setting */
  areSkillsEnabled: boolean;
}

/**
 * Registers this extension's MCP server with VS Code, so that VS Code's chat in agent mode can use
 * the review tools in the repo of `model` (the server reviews the branch checked out in its
 * working folder), and reports the integration's status. VS Code's agent-host harnesses (its
 * Claude and Codex agents) don't use this registration. package.json contributes the rest of the
 * integration: the skill and the Branch Reviewer agent.
 */
export class VscodeChatIntegration implements vscode.Disposable {
  private readonly registration: vscode.Disposable | undefined;
  private readonly registrationProblem: string | undefined;
  private lastStartTime: Date | undefined;

  constructor(private readonly services: AgentServices, private readonly model: BranchReviewModel | undefined) {
    let launch = this.getServerLaunch();
    try {
      // Editors based on VS Code may lack the API
      if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== "function") {
        this.registrationProblem = "This editor lacks VS Code's API for MCP servers "
          + "(vscode.lm.registerMcpServerDefinitionProvider).";
      } else {
        this.registration = vscode.lm.registerMcpServerDefinitionProvider(mcpProviderId, {
          provideMcpServerDefinitions: () => launch ? [createServerDefinition(launch)] : [],
          resolveMcpServerDefinition: server => {
            this.lastStartTime = new Date();
            services.log.appendLine(`VS Code is starting the MCP server for its chat in ${launch?.cwd}`);
            return server;
          },
        });
        this.registrationProblem = launch ? undefined : "No workspace folder is in a git repo.";
      }
    } catch (e) {
      this.registrationProblem = getErrorMessage(e);
      void services.errors.recordError("vscodeChat", "Register MCP server", this.registrationProblem);
    }
  }

  /** Gets the MCP server launch that the provider gives VS Code; undefined without a git repo. */
  getServerLaunch(): McpServerLaunch | undefined {
    let { context } = this.services;
    return this.model && buildMcpServerLaunch(getBundledServerPath(context), process.execPath, this.model.repoRoot,
      String(context.extension.packageJSON.version));
  }

  /** Checks the registration, the server's last start and which copy of the skill VS Code uses. */
  async getStatus(): Promise<VscodeChatStatus> {
    let [skillPath] = findSkillCopiesThatTakePrecedence(os.homedir(), this.model?.repoRoot);
    let skillCopy = skillPath === undefined ? undefined : { path: skillPath, isCurrent:
      await readFileIfExists(skillPath) === await readFileIfExists(getBundledSkillPath(this.services.context)) };
    return { server: this.registrationProblem ? undefined : this.getServerLaunch(),
      registrationProblem: this.registrationProblem, lastStartTime: this.lastStartTime, skillCopy,
      areSkillsEnabled: vscode.workspace.getConfiguration("chat").get<boolean>("useAgentSkills") !== false };
  }

  dispose(): void {
    this.registration?.dispose();
  }
}

/** Converts a McpServerLaunch into the definition that the provider gives VS Code. */
function createServerDefinition(launch: McpServerLaunch): vscode.McpStdioServerDefinition {
  let definition = new vscode.McpStdioServerDefinition(launch.label, launch.command, launch.args, launch.env,
    launch.version);
  // Without a cwd, VS Code starts servers that extensions provide in an unrelated folder
  definition.cwd = vscode.Uri.file(launch.cwd);
  return definition;
}
