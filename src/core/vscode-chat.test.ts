import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createAnchor, splitLines } from "./anchoring";
import { addComment, addThread, createReview, DiffSide } from "./review";
import { buildChatOpenArgs, buildMcpServerLaunch, chatAgentName, mcpClientEnvVar } from "./vscode-chat";

const repoRoot = path.join(__dirname, "../..");

/** Creates the context of a thread on lines 12-13 of a 30-line file, the user's message last. */
function createContext(side: DiffSide) {
  let lines = splitLines(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
  let review = createReview("feature/x", "develop", "abc1234def");
  let thread = addThread(review, { file: "src/a.ts", side, anchor: createAnchor(lines, 12, 13), severity: "Major",
    author: { kind: "agent", name: "Claude" }, body: "This might divide by zero." });
  addComment(review, thread, { kind: "user", name: "David" }, "Can it really?");
  return { review, thread, fileLines: lines, location: { startLine: 12, endLine: 13, isOutdated: false } };
}

describe("buildChatOpenArgs", () => {
  it("sends the prompt to the Branch Reviewer agent and attaches the thread's lines of the working-tree file", () => {
    let context = createContext("modified");

    let args = buildChatOpenArgs(context, "file:///r/src/a.ts");

    expect(args).toMatchObject({ mode: "Branch Reviewer", isPartialQuery: false, attachFiles: [{
      uri: "file:///r/src/a.ts", range: { startLineNumber: 12, startColumn: 1, endLineNumber: 13, endColumn: 8 } }] });
    expect(args.query).toContain(`review thread ${context.thread.id}`);
    expect(args.query).toContain("review_reply");
    expect(args.query).not.toContain("| line 12");
  });

  it("quotes the lines of a base-side thread instead of attaching the working-tree file", () => {
    let args = buildChatOpenArgs(createContext("base"), "file:///r/src/a.ts");

    expect(args.attachFiles).toBeUndefined();
    expect(args.query).toContain(">   12 | line 12");
  });
});

describe("buildMcpServerLaunch", () => {
  it("runs the server script with the editor's Node.js in the repo folder, marked as VS Code's chat", () => {
    expect(buildMcpServerLaunch("C:/ext/dist/mcp-server.js", "C:/Code/Code.exe", "D:/repo", "0.8.0")).toEqual({
      label: "branch-review-studio", command: "C:/Code/Code.exe", args: ["C:/ext/dist/mcp-server.js"], cwd: "D:/repo",
      env: { ELECTRON_RUN_AS_NODE: "1", [mcpClientEnvVar]: "vscodeChat" }, version: "0.8.0" });
  });
});

describe("package.json chat contributions", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const vscodeIgnore = fs.readFileSync(path.join(repoRoot, ".vscodeignore"), "utf8").split(/\r?\n/);
  const readContributedFile = (key: string) => {
    let file = path.join(repoRoot, manifest.contributes[key][0].path);
    // .vscodeignore excludes everything (**) except the patterns it negates
    expect(vscodeIgnore).toContain(`!${path.relative(repoRoot, file).split(path.sep)[0]}/**`);
    return { file, text: fs.readFileSync(file, "utf8") };
  };

  it("contributes the skill in a folder named like the skill, and packages it", () => {
    let { file, text } = readContributedFile("chatSkills");
    expect(text).toMatch(new RegExp(`^---\r?\nname: ${path.basename(path.dirname(file))}\r?\n`));
  });

  it("contributes the Branch Reviewer agent with the MCP server's tools, and packages it", () => {
    let { text } = readContributedFile("chatAgents");
    expect(text).toMatch(new RegExp(`\nname: ${chatAgentName}\r?\n`));
    expect(text).toMatch(/\ntools: \[.*'branch-review-studio\/\*'.*\]\r?\n/);
    expect(manifest.contributes.mcpServerDefinitionProviders).toHaveLength(1);
  });
});
