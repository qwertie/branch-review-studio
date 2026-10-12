import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { updateFileIfOutdated } from "./files";
import { createFiles } from "./test-helpers";

describe("updateFileIfOutdated", () => {
  it("Bug_2026_10_SkillNotUpdatedWithExtension: replaces an installed copy that differs", async () => {
    let dir = createFiles(["bundled/SKILL.md", "new"], ["installed/SKILL.md", "old"]);
    expect(await update(dir)).toBe(true);
    expect(fs.readFileSync(getInstalledPath(dir), "utf8")).toBe("new");
  });

  it("leaves an up-to-date copy alone", async () => {
    let dir = createFiles(["bundled/SKILL.md", "same"], ["installed/SKILL.md", "same"]);
    fs.utimesSync(getInstalledPath(dir), 0, 0);
    expect(await update(dir)).toBe(false);
    expect(fs.statSync(getInstalledPath(dir)).mtimeMs).toBe(0);
  });

  it("doesn't install a file that isn't installed", async () => {
    let dir = createFiles(["bundled/SKILL.md", "new"]);
    expect(await update(dir)).toBe(false);
    expect(fs.existsSync(path.join(dir, "installed"))).toBe(false);
  });

  function update(dir: string): Promise<boolean> {
    return updateFileIfOutdated(getInstalledPath(dir), path.join(dir, "bundled", "SKILL.md"));
  }

  function getInstalledPath(dir: string): string {
    return path.join(dir, "installed", "SKILL.md");
  }
});
