import * as fs from "node:fs/promises";
import * as path from "node:path";
import { splitLines } from "./anchoring";
import { getFileAtRevision } from "./git";
import { DiffSide } from "./review";

/**
 * Reads the lines of a repo-relative file in the working tree ('modified') or at `mergeBaseSha`
 * ('base'). Returns undefined if the file doesn't exist there.
 */
export async function readFileLines(repoRoot: string, file: string, side: DiffSide, mergeBaseSha: string)
  : Promise<string[] | undefined> {
  let text = side === "base"
    ? await getFileAtRevision(repoRoot, mergeBaseSha, file)
    : await readFileIfExists(path.join(repoRoot, ...file.split("/")));
  return text === undefined ? undefined : splitLines(text);
}

/** Reads a UTF-8 file, returning undefined if it doesn't exist. */
export async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT")
      return undefined;
    throw e;
  }
}
