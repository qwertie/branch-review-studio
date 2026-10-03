import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentCommand } from "./agent-integration";
import { createFiles } from "./test-helpers";

describe("runAgentCommand", () => {
  it("returns stdout, or stderr if stdout is empty (as from `codex login status`), and throws on failure",
    async () => {
      let dir = createFiles(["out.js", "console.log('to stdout'); console.error('warning')"],
        ["err.js", "console.error('Logged in using ChatGPT')"], ["fail.js", "console.error('bad'); process.exit(2)"]);
      let node = { command: process.execPath, args: [] };

      expect(await runAgentCommand(node, [path.join(dir, "out.js")])).toBe("to stdout\n");
      expect(await runAgentCommand(node, [path.join(dir, "err.js")])).toBe("Logged in using ChatGPT\n");
      await expect(runAgentCommand(node, [path.join(dir, "fail.js")])).rejects.toThrow(/fail\.js' failed: bad/);
    });
});
