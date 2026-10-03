import { describe, expect, it } from "vitest";
import { AgentCommand } from "./agent-integration";
import { claudeIntegration } from "./claude-cli";
import { codexIntegration } from "./codex-cli";
import { checkIntegrationStatus, IntegrationErrorLog, isIntegrationAvailable } from "./integration-status";

/** Creates a fake command runner whose output (or failure, if an Error) depends on the args. */
function createRunner(outputs: Record<string, string | Error>) {
  return async (_: AgentCommand, args: string[]) => {
    let output = outputs[args.slice(0, 2).join(" ")] ?? outputs[args[0]];
    if (output === undefined || output instanceof Error)
      throw output ?? new Error(`unexpected command ${args.join(" ")}`);
    return output;
  };
}

describe("checkIntegrationStatus", () => {
  const command = { command: "C:\\bin\\codex.exe", args: [] };

  it("reports the version, sign-in and MCP registration of an available CLI", async () => {
    let run = createRunner({ "--version": "codex-cli 0.160.0\n", "login status": "Logged in using ChatGPT\n",
      "mcp get": "branch-review-studio\n  enabled: true" });

    let status = await checkIntegrationStatus(codexIntegration, command, run);

    expect(status).toEqual({ agent: "codex", executable: "C:\\bin\\codex.exe", version: "codex-cli 0.160.0",
      isSignedIn: true, isMcpServerRegistered: true, problems: [] });
    expect(isIntegrationAvailable(status)).toBe(true);
  });

  it("reports a CLI that is signed out, has no MCP registration, or can't report its version", async () => {
    let run = createRunner({ "--version": new Error("spawn EACCES"), "auth status": `{"loggedIn": false}`,
      "mcp get": new Error("No MCP server found") });

    let status = await checkIntegrationStatus(claudeIntegration, command, run);

    expect(status).toMatchObject({ version: undefined, isSignedIn: false, isMcpServerRegistered: false,
      problems: ["spawn EACCES"] });
    expect(isIntegrationAvailable(status)).toBe(false);
  });

  it("checks nothing without a CLI", async () => {
    let status = await checkIntegrationStatus(codexIntegration, undefined, createRunner({}));
    expect(status).toEqual({ agent: "codex", executable: undefined, version: undefined, isSignedIn: undefined,
      isMcpServerRegistered: undefined, problems: [] });
  });
});

describe("IntegrationErrorLog", () => {
  /** Creates a log on a Map-based storage, which a second log can read to check persistence. */
  function createLog() {
    let values = new Map<string, unknown>();
    let storage = { get: <T>(key: string) => values.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void values.set(key, value) };
    let changeCount = 0;
    return { log: new IntegrationErrorLog(storage, () => changeCount++), storage, getChangeCount: () => changeCount };
  }

  it("persists the last error of each agent until the agent is used successfully", async () => {
    let { log, storage, getChangeCount } = createLog();
    let time = new Date("2026-10-03T12:00:00Z");

    await log.recordError("codex", "Ask Agent (background)", "first", time);
    await log.recordError("codex", "Install", "second", time);
    await log.recordError("claude", "Install", "claude failed", time);

    expect(new IntegrationErrorLog(storage).getLastError("codex"))
      .toEqual({ operation: "Install", message: "second", time: "2026-10-03T12:00:00.000Z" });
    await log.recordSuccess("codex");
    expect(log.getLastError("codex")).toBeUndefined();
    expect(log.getLastError("claude")?.message).toBe("claude failed");
    expect(getChangeCount()).toBe(4);
  });

  it("does not write when recording a success without an error", async () => {
    let { log, getChangeCount } = createLog();
    await log.recordSuccess("claude");
    expect(getChangeCount()).toBe(0);
  });
});
