import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findClaudeExecutable, parseStreamJsonLine } from "./claude-cli";
import { createTempDir } from "./test-helpers";

let tempDirs: string[] = [];
afterEach(() => {
  for (let dir of tempDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Creates empty files (relative to a new temp folder) and returns the folder. */
function createFiles(...relativePaths: string[]): string {
  let dir = createTempDir();
  tempDirs.push(dir);
  for (let relativePath of relativePaths) {
    fs.mkdirSync(path.dirname(path.join(dir, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(dir, relativePath), "");
  }
  return dir;
}

describe("findClaudeExecutable", () => {
  const options = { configuredPath: "", homeDir: "Z:\\nohome", platform: "win32" as const };

  it("prefers the configured path", () => {
    expect(findClaudeExecutable({ ...options, configuredPath: "C:\\x\\claude.exe", pathEnv: "" }))
      .toEqual({ command: "C:\\x\\claude.exe", args: [] });
  });

  it("finds claude.exe on PATH before a .cmd shim", () => {
    let shimDir = createFiles("claude.cmd", "node_modules/@anthropic-ai/claude-code/cli.js");
    let exeDir = createFiles("claude.exe");
    expect(findClaudeExecutable({ ...options, pathEnv: [shimDir, exeDir].join(";") }))
      .toEqual({ command: path.join(exeDir, "claude.exe"), args: [] });
  });

  it("runs an npm .cmd shim's cli.js with node, since terminals can't pass multi-line args through cmd.exe", () => {
    let shimDir = createFiles("claude.cmd", "node_modules/@anthropic-ai/claude-code/cli.js");
    expect(findClaudeExecutable({ ...options, pathEnv: shimDir })).toEqual({
      command: "node", args: [path.join(shimDir, "node_modules/@anthropic-ai/claude-code/cli.js")],
    });
  });

  it("falls back to the native installer's ~/.local/bin, else returns undefined", () => {
    let home = createFiles(".local/bin/claude.exe");
    expect(findClaudeExecutable({ ...options, homeDir: home, pathEnv: "" }))
      .toEqual({ command: path.join(home, ".local/bin/claude.exe"), args: [] });
    expect(findClaudeExecutable({ ...options, pathEnv: "" })).toBeUndefined();
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
