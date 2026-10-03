import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoTools, repoToolDefinitions, resolveRepoPath, selectHunksNear, truncateText } from "./repo-tools";
import { TempRepo, waitForKilledProcesses } from "./test-helpers";

let repos: TempRepo[] = [];
afterEach(() => {
  for (let repo of repos.splice(0))
    repo.dispose();
});

/**
 * Creates a repo whose merge-base commit has src/a.ts (10 lines) and docs/readme.md, then changes
 * line 5 of a.ts and adds an untracked file; returns tools on it.
 */
function setUp(maxResultChars?: number) {
  let lines = Array.from({ length: 10 }, (_, i) => `const v${i + 1} = ${i + 1};`);
  let repo = TempRepo.create({ "src/a.ts": lines.join("\n") + "\n", "docs/readme.md": "Hello world\n" });
  repos.push(repo);
  let mergeBaseSha = repo.git("rev-parse", "HEAD");
  lines[4] = "const v5 = 'changed';";
  repo.writeFiles({ "src/a.ts": lines.join("\n") + "\n", "src/new.ts": "export const fresh = true;\n" });
  return { repo, mergeBaseSha, tools: new RepoTools(repo.root, mergeBaseSha, { maxResultChars }) };
}

describe("resolveRepoPath", () => {
  const root = path.resolve("/repo");

  it("accepts repo-relative paths with either kind of slash", () => {
    expect(resolveRepoPath(root, "src/a.ts")).toBe(path.join(root, "src", "a.ts"));
    expect(resolveRepoPath(root, "src\\b\\..\\a.ts")).toBe(path.join(root, "src", "a.ts"));
    expect(resolveRepoPath(root, "./README.md")).toBe(path.join(root, "README.md"));
  });

  it("rejects paths outside the repo, absolute paths and paths in .git", () => {
    for (let bad of ["../x", "src/../../x", "/etc/passwd", "C:\\Windows\\win.ini", "C:x", "\\\\server\\share\\f",
      ".git/config", "sub/.GIT/HEAD", ".git", ""])
      expect(() => resolveRepoPath(root, bad), bad).toThrow();
  });
});

describe("truncateText", () => {
  it("keeps short text and cuts long text at a line break, with a note saying how to see more", () => {
    expect(truncateText("abc\ndef", 7, "Narrow it.")).toBe("abc\ndef");
    let truncated = truncateText("line one\nline two\nline three\n", 20, "Narrow it.");
    expect(truncated).toBe("line one\nline two\n[Truncated: showed 18 of 29 characters. Narrow it.]");
    expect(truncateText("\nabc", 0, "No room.")).toBe("[Truncated: showed 0 of 4 characters. No room.]");
  });
});

describe("selectHunksNear", () => {
  const diff = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -2,3 +2,3 @@\n a\n-b\n+B\n c\n@@ -40,2 +40,3 @@\n x\n+y\n z\n";

  it("selects the hunks that overlap the lines (or come within 5 lines) on the given side", () => {
    expect(selectHunksNear(diff, "modified", 8, 8)).toBe("@@ -2,3 +2,3 @@\n a\n-b\n+B\n c");
    expect(selectHunksNear(diff, "base", 41, 41)).toBe("@@ -40,2 +40,3 @@\n x\n+y\n z");
    expect(selectHunksNear(diff, "modified", 20, 25)).toBeUndefined();
  });
});

describe("RepoTools", () => {
  it("defines read_file, search_text, list_files, list_changed_files and get_file_diff", () => {
    expect(repoToolDefinitions.map(t => t.name))
      .toEqual(["read_file", "search_text", "list_files", "list_changed_files", "get_file_diff"]);
  });

  it("read_file returns numbered lines, optionally a range", async () => {
    let { tools } = setUp();

    expect(await tools.callTool("read_file", { path: "src/a.ts", startLine: 4, endLine: 5 }))
      .toBe("src/a.ts, lines 4-5 of 10:\n    4 | const v4 = 4;\n    5 | const v5 = 'changed';");
    expect(await tools.callTool("read_file", { path: "src/new.ts" }))
      .toBe("src/new.ts, lines 1-1 of 1:\n    1 | export const fresh = true;");
  });

  it("read_file refuses paths outside the repo, in .git, and symlinks that lead outside", async () => {
    let { repo, tools } = setUp();
    let outside = path.join(path.dirname(repo.root), path.basename(repo.root) + "-outside.txt");
    fs.writeFileSync(outside, "secret\n");
    let canLink = tryCreateSymlink(outside, path.join(repo.root, "link.txt"));

    expect(await tools.callTool("read_file", { path: "../" + path.basename(outside) })).toMatch(/^Error: .*outside/);
    expect(await tools.callTool("read_file", { path: outside })).toMatch(/^Error: /);
    expect(await tools.callTool("read_file", { path: ".git/config" })).toMatch(/^Error: .*\.git/);
    if (canLink)
      expect(await tools.callTool("read_file", { path: "link.txt" })).toMatch(/^Error: .*outside/);
    expect(await tools.callTool("read_file", { path: "missing.ts" })).toMatch(/^Error: .*not found/);
    expect(await tools.callTool("read_file", { path: "src" })).toMatch(/^Error: .*folder/);
    fs.rmSync(outside);
  });

  it("read_file refuses files that git ignores, like list_files, but reads tracked files that match .gitignore",
    async () => {
      let { repo, tools } = setUp();
      repo.writeFiles({ ".gitignore": ".env\ndocs/\n", ".env": "SECRET=1\n" });

      expect(await tools.callTool("read_file", { path: ".env" })).toMatch(/^Error: .*ignored/);
      expect((await tools.callTool("list_files", {})).split("\n")).not.toContain(".env");
      expect(await tools.callTool("read_file", { path: "docs/readme.md" })).toContain("1 | Hello world");
    });

  it("reports a tool's git process as cancelled when the signal is aborted", async () => {
    let { repo, mergeBaseSha } = setUp();
    let tools = new RepoTools(repo.root, mergeBaseSha, { signal: AbortSignal.abort() });

    expect(await tools.callTool("list_files", {})).toMatch(/^Error: git .*was cancelled/);
    await waitForKilledProcesses();
  });

  it("search_text finds matches in tracked and untracked files, optionally limited by a glob", async () => {
    let { tools } = setUp();

    expect(await tools.callTool("search_text", { pattern: "fresh|v5 =" }))
      .toBe("src/a.ts:5:const v5 = 'changed';\nsrc/new.ts:1:export const fresh = true;");
    expect(await tools.callTool("search_text", { pattern: "HELLO", glob: "*.md", ignoreCase: true }))
      .toBe("docs/readme.md:1:Hello world");
    expect(await tools.callTool("search_text", { pattern: "nothing-matches-this" })).toBe("No matches.");
    expect(await tools.callTool("search_text", { pattern: "x", glob: "../*" })).toMatch(/^Error: /);
    expect(await tools.callTool("search_text", { pattern: "x", glob: ":(exclude)docs" })).toMatch(/^Error: /);
  });

  it("search_text treats a pattern that starts with '-' as a pattern, not as an option", async () => {
    let { tools } = setUp();
    expect(await tools.callTool("search_text", { pattern: "-v" })).toBe("No matches.");
  });

  it("list_files lists tracked and untracked files, optionally limited by a glob", async () => {
    let { tools } = setUp();

    expect(await tools.callTool("list_files", {})).toBe("docs/readme.md\nsrc/a.ts\nsrc/new.ts");
    expect(await tools.callTool("list_files", { glob: "src/*" })).toBe("src/a.ts\nsrc/new.ts");
  });

  it("list_changed_files and get_file_diff show the changes since the merge-base", async () => {
    let { tools } = setUp();

    expect(await tools.callTool("list_changed_files", {})).toBe("Modified src/a.ts\nAdded src/new.ts");
    expect(await tools.callTool("get_file_diff", { path: "src/a.ts" }))
      .toContain("@@ -2,7 +2,7 @@ const v1 = 1;\n const v2 = 2;\n const v3 = 3;\n const v4 = 4;\n-const v5 = 5;\n"
        + "+const v5 = 'changed';");
    expect(await tools.callTool("get_file_diff", { path: "src/new.ts" })).toMatch(/untracked.*read_file/);
    expect(await tools.callTool("get_file_diff", { path: "docs/readme.md" })).toMatch(/^No changes/);
  });

  it("get_file_diff treats the path literally, not as a pathspec with wildcards or magic", async () => {
    let { tools } = setUp();
    for (let file of ["*", "src/*.ts", ":(exclude)docs", ":(glob)**"])
      expect(await tools.callTool("get_file_diff", { path: file }), file).toMatch(/^No changes/);
  });

  it("truncates long results and reports bad tool calls as errors", async () => {
    let { tools } = setUp(60);

    expect(await tools.callTool("read_file", { path: "src/a.ts" })).toMatch(/\n\[Truncated: showed \d+ of \d+ /);
    expect(await tools.callTool("read_file", {})).toMatch(/^Error: .*path/);
    expect(await tools.callTool("write_file", { path: "x" })).toMatch(/^Error: .*unknown tool/i);
  });

  it("getDiffNear gets the hunks of the file's diff near a thread's lines", async () => {
    let { tools } = setUp();

    expect(await tools.getDiffNear("src/a.ts", "modified", 5, 5))
      .toMatch(/^@@ -2,7 \+2,7 @@[^]*\+const v5 = 'changed';/);
    expect(await tools.getDiffNear("docs/readme.md", "modified", 1, 1)).toBeUndefined();
  });
});

/** Creates a file symlink; returns false if the OS doesn't allow it (e.g. Windows without developer mode). */
function tryCreateSymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}
