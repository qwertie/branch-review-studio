import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mcpServerName } from "./agent-commands";
import { claudeIntegration, parseStreamJsonLine } from "./claude-cli";
import { createFiles } from "./test-helpers";

describe("claudeIntegration.findExecutable", () => {
  const options = { configuredPath: "", homeDir: "Z:\\nohome", platform: "win32" as const };

  it("prefers the configured path", () => {
    expect(claudeIntegration.findExecutable({ ...options, configuredPath: "C:\\x\\claude.exe", pathEnv: "" }))
      .toEqual({ command: "C:\\x\\claude.exe", args: [] });
  });

  it("finds claude.exe on PATH before a .cmd shim", () => {
    let shimDir = createFiles("claude.cmd", "node_modules/@anthropic-ai/claude-code/cli.js");
    let exeDir = createFiles("claude.exe");
    expect(claudeIntegration.findExecutable({ ...options, pathEnv: [shimDir, exeDir].join(";") }))
      .toEqual({ command: path.join(exeDir, "claude.exe"), args: [] });
  });

  it("runs an npm .cmd shim's cli.js with node, since terminals can't pass multi-line args through cmd.exe", () => {
    let shimDir = createFiles("claude.cmd", "node_modules/@anthropic-ai/claude-code/cli.js");
    expect(claudeIntegration.findExecutable({ ...options, pathEnv: shimDir })).toEqual({
      command: "node", args: [path.join(shimDir, "node_modules/@anthropic-ai/claude-code/cli.js")],
    });
  });

  it("falls back to the native installer's ~/.local/bin, else returns undefined", () => {
    let home = createFiles(".local/bin/claude.exe");
    expect(claudeIntegration.findExecutable({ ...options, homeDir: home, pathEnv: "" }))
      .toEqual({ command: path.join(home, ".local/bin/claude.exe"), args: [] });
    expect(claudeIntegration.findExecutable({ ...options, pathEnv: "" })).toBeUndefined();
  });
});

describe("claudeIntegration.buildArgs", () => {
  const invocation = { prompt: "hi", mcpServerPath: "C:\\x\\mcp-server.js" };

  it("resumes and forks the review session in an interactive terminal", () => {
    let args = claudeIntegration.buildArgs({ ...invocation, prompt: "hi\nthere", sessionMode: "fork",
      resumeSessionId: "s-1", runMode: "interactive" });
    expect(args).toEqual(["--allowedTools", `mcp__${mcpServerName}`, "--resume", "s-1", "--fork-session",
      "hi\nthere"]);
  });

  it("starts a fresh print-mode session with stream-json output that may call the MCP tools", () => {
    // --allowedTools takes a variable number of values, so it must not come right before the prompt
    expect(claudeIntegration.buildArgs({ ...invocation, sessionMode: "fresh", runMode: "background" })).toEqual([
      "--allowedTools", `mcp__${mcpServerName}`, "-p", "--output-format", "stream-json", "--verbose", "hi",
    ]);
  });

  it("forks in the background with a preassigned id for the new session", () => {
    let args = claudeIntegration.buildArgs({ ...invocation, sessionMode: "fork", resumeSessionId: "s-1",
      newSessionId: "s-2", runMode: "background" });
    expect(args.slice(-6)).toEqual(["--resume", "s-1", "--fork-session", "--session-id", "s-2", "hi"]);
  });

  it("refuses to fork without a session id", () => {
    expect(() => claudeIntegration.buildArgs({ ...invocation, sessionMode: "fork", runMode: "interactive" }))
      .toThrow();
  });
});

describe("parseStreamJsonLine", () => {
  it("extracts the session id from the init event and the text and error flag from the result event", () => {
    expect(parseStreamJsonLine(`{"type":"system","subtype":"init","session_id":"s1","tools":[]}`))
      .toEqual({ sessionId: "s1" });
    let resultLine = `{"type":"result","subtype":"success","is_error":false,"result":"Done.","session_id":"s1"}`;
    expect(parseStreamJsonLine(resultLine))
      .toEqual({ sessionId: "s1", resultText: "Done.", isError: false });
    expect(parseStreamJsonLine(`{"type":"assistant","message":{}}`)).toEqual({});
    expect(parseStreamJsonLine("not json")).toEqual({});
  });
});

describe("claudeIntegration.isSignedIn", () => {
  it("reads loggedIn from `claude auth status`", () => {
    expect(claudeIntegration.isSignedIn(`{"loggedIn": true, "authMethod": "claude.ai"}`)).toBe(true);
    expect(claudeIntegration.isSignedIn(`{"loggedIn": false}`)).toBe(false);
  });
});
