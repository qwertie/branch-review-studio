import { AgentCommand, AgentIntegration } from "./agent-integration";
import { getErrorMessage } from "./files";
import { AgentKind, IntegrationId } from "./review";

/** What checkIntegrationStatus found out about one agent integration. */
export interface IntegrationStatus {
  agent: AgentKind;
  /** Command line of the agent's CLI; undefined if the CLI wasn't found */
  executable: string | undefined;
  /** First line of the CLI's `--version` output, e.g. "codex-cli 0.160.0" */
  version: string | undefined;
  /** Undefined if unknown because there is no CLI */
  isSignedIn: boolean | undefined;
  /** Whether the MCP server is registered with the agent; undefined if unknown */
  isMcpServerRegistered: boolean | undefined;
  /**
   * Errors of the `--version` check, e.g. a CLI that doesn't run. (A failing sign-in or MCP check
   * counts as "no" instead.)
   */
  problems: string[];
}

/** Runs an agent CLI with the given arguments; returns stdout; throws on failure. */
export type AgentCommandRunner = (command: AgentCommand, args: string[]) => Promise<string>;

/**
 * Checks whether an agent integration apparently works by running its CLI (`command`, if found)
 * three times: `--version`, the sign-in status command, and the command that shows the MCP server
 * registration.
 */
export async function checkIntegrationStatus(integration: AgentIntegration, command: AgentCommand | undefined,
  run: AgentCommandRunner): Promise<IntegrationStatus> {
  let status: IntegrationStatus = { agent: integration.agent,
    executable: command && [command.command, ...command.args].join(" "), version: undefined, isSignedIn: undefined,
    isMcpServerRegistered: undefined, problems: [] };
  if (command) {
    let [version, login, mcp] = await Promise.allSettled([run(command, ["--version"]),
      run(command, integration.loginStatusArgs), run(command, integration.mcpGetArgs)]);
    if (version.status === "fulfilled")
      status.version = version.value.trim().split(/\r?\n/)[0];
    else
      status.problems.push(getErrorMessage(version.reason));
    status.isSignedIn = login.status === "fulfilled" && integration.isSignedIn(login.value);
    status.isMcpServerRegistered = mcp.status === "fulfilled";
  }
  return status;
}

/**
 * Whether an integration apparently works: its CLI runs, the user is signed in, and the MCP server
 * is registered.
 */
export function isIntegrationAvailable(status: IntegrationStatus): boolean {
  return status.version !== undefined && status.isSignedIn === true && status.isMcpServerRegistered === true;
}

/** The last error that occurred while using an integration (see IntegrationErrorLog). */
export interface IntegrationError {
  /** What failed, e.g. "Ask Agent (background)" */
  operation: string;
  message: string;
  /** ISO timestamp */
  time: string;
}

/** Persistent key-value storage, e.g. VS Code's ExtensionContext.globalState. */
export interface KeyValueStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

/**
 * Remembers, in persistent storage, the last error that occurred while using each integration
 * (an agent CLI, or VS Code's chat), until the next successful use of that integration.
 */
export class IntegrationErrorLog {
  private static readonly storageKey = "branchReviewStudio.integrationErrors";

  /** `onDidChange` is called after every change */
  constructor(private readonly storage: KeyValueStorage, private readonly onDidChange: () => void = () => {}) {}

  getLastError(integration: IntegrationId): IntegrationError | undefined {
    return this.getErrors()[integration];
  }

  async recordError(integration: IntegrationId, operation: string, message: string, time = new Date())
    : Promise<void> {
    await this.saveErrors({ ...this.getErrors(), [integration]: { operation, message, time: time.toISOString() } });
  }

  /** Forgets the integration's last error, if any. */
  async recordSuccess(integration: IntegrationId): Promise<void> {
    let { [integration]: lastError, ...otherErrors } = this.getErrors();
    if (lastError)
      await this.saveErrors(otherErrors);
  }

  private getErrors(): Partial<Record<IntegrationId, IntegrationError>> {
    return this.storage.get(IntegrationErrorLog.storageKey) ?? {};
  }

  private async saveErrors(errors: Partial<Record<IntegrationId, IntegrationError>>): Promise<void> {
    await this.storage.update(IntegrationErrorLog.storageKey, errors);
    this.onDidChange();
  }
}

