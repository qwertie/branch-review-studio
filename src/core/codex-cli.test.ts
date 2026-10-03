import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { mcpServerName } from "./agent-commands";
import { codexIntegration, findCodexExtensionExecutables, parseCodexJsonLine } from "./codex-cli";
import { createFiles } from "./test-helpers";

describe("codexIntegration.buildArgs", () => {
  const invocation = { prompt: "hi\nthere", mcpServerPath: "C:\\x\\mcp-server.js" };
  // Defines the MCP server and lets Codex call its tools without asking; values are TOML
  const serverOptions = ["-c", `mcp_servers.${mcpServerName}.command="node"`,
    "-c", `mcp_servers.${mcpServerName}.args=["C:\\\\x\\\\mcp-server.js"]`,
    "-c", `mcp_servers.${mcpServerName}.default_tools_approval_mode="approve"`];

  it("starts a fresh interactive session with the prompt", () => {
    expect(codexIntegration.buildArgs({ ...invocation, sessionMode: "fresh", runMode: "interactive" }))
      .toEqual([...serverOptions, "hi\nthere"]);
  });

  it("forks the review session in an interactive terminal", () => {
    expect(codexIntegration.buildArgs({ ...invocation, sessionMode: "fork", resumeSessionId: "t-1",
      runMode: "interactive" })).toEqual(["fork", ...serverOptions, "t-1", "hi\nthere"]);
  });

  it("runs `codex exec` with JSONL output in the background, fresh or forked", () => {
    expect(codexIntegration.buildArgs({ ...invocation, sessionMode: "fresh", runMode: "background" }))
      .toEqual(["exec", "--json", ...serverOptions, "hi\nthere"]);
    expect(codexIntegration.buildArgs({ ...invocation, sessionMode: "fork", resumeSessionId: "t-1",
      runMode: "background" })).toEqual(["exec", "fork", "--json", ...serverOptions, "t-1", "hi\nthere"]);
  });

  it("refuses to fork without a session id", () => {
    expect(() => codexIntegration.buildArgs({ ...invocation, sessionMode: "fork", runMode: "background" }))
      .toThrow();
  });
});

describe("parseCodexJsonLine", () => {
  // Lines from real `codex exec --json` runs (codex-cli 0.160.0)
  it("extracts the thread id and agent messages", () => {
    expect(parseCodexJsonLine(`{"type":"thread.started","thread_id":"01a102c7-f4b6"}`))
      .toEqual({ sessionId: "01a102c7-f4b6" });
    expect(parseCodexJsonLine(`{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done"}}`))
      .toEqual({ resultText: "done" });
    let toolCall = `{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"s","tool":"t",`
      + `"arguments":{},"result":{"content":[]},"error":null,"status":"completed"}}`;
    expect(parseCodexJsonLine(toolCall)).toEqual({});
    expect(parseCodexJsonLine(`{"type":"turn.completed","usage":{"input_tokens":33742}}`)).toEqual({});
    expect(parseCodexJsonLine("not json")).toEqual({});
  });

  it("reports a failed turn with the API error's message, but not a warning item", () => {
    let apiError = JSON.stringify({ type: "error", status: 400,
      error: { type: "invalid_request_error", message: "The 'x' model is not supported." } });
    expect(parseCodexJsonLine(JSON.stringify({ type: "error", message: apiError })))
      .toEqual({ errorMessage: "The 'x' model is not supported." });
    expect(parseCodexJsonLine(JSON.stringify({ type: "turn.failed", error: { message: apiError } })))
      .toEqual({ isError: true, errorMessage: "The 'x' model is not supported." });
    expect(parseCodexJsonLine(JSON.stringify({ type: "turn.failed", error: { message: "plain" } })))
      .toEqual({ isError: true, errorMessage: "plain" });
    expect(parseCodexJsonLine(`{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model `
      + `metadata for x not found."}}`)).toEqual({});
  });
});

describe("Codex executables", () => {
  const options = { configuredPath: "", homeDir: "Z:\\nohome", platform: "win32" as const };

  it("findCodexExtensionExecutables finds the CLIs bundled with the Codex VS Code extension", () => {
    let extensionDir = createFiles("bin/windows-x86_64/codex.exe", "bin/linux-x86_64/codex", "package.json");
    expect(findCodexExtensionExecutables(extensionDir, "win32"))
      .toEqual([path.join(extensionDir, "bin/windows-x86_64/codex.exe")]);
    expect(findCodexExtensionExecutables(path.join(extensionDir, "nothing"), "win32")).toEqual([]);
  });

  it("findExecutable prefers the preferred paths (the extension's CLI) to PATH, and runs a .cmd shim with node",
    () => {
      let shimDir = createFiles("codex.cmd", "node_modules/@openai/codex/bin/codex.js");
      let bundled = path.join(createFiles("codex.exe"), "codex.exe");
      expect(codexIntegration.findExecutable({ ...options, pathEnv: shimDir, preferredPaths: [bundled] }))
        .toEqual({ command: bundled, args: [] });
      expect(codexIntegration.findExecutable({ ...options, pathEnv: shimDir }))
        .toEqual({ command: "node", args: [path.join(shimDir, "node_modules/@openai/codex/bin/codex.js")] });
      expect(codexIntegration.findExecutable({ ...options, pathEnv: "" })).toBeUndefined();
    });

  it("isSignedIn reads `codex login status`", () => {
    expect(codexIntegration.isSignedIn("Logged in using ChatGPT\n")).toBe(true);
    expect(codexIntegration.isSignedIn("Not logged in\n")).toBe(false);
  });
});
