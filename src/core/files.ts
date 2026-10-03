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
    : await readFileIfExists(getFullPath(repoRoot, file));
  return text === undefined ? undefined : splitLines(text);
}

/** Reads a UTF-8 file, returning undefined if it doesn't exist. */
export async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (getErrorCode(e) === "ENOENT")
      return undefined;
    throw e;
  }
}

/** Converts a repo-relative path with forward slashes into an absolute native path. */
export function getFullPath(repoRoot: string, file: string): string {
  return path.join(repoRoot, ...file.split("/"));
}

/**
 * Converts an absolute native path into a repo-relative path with forward slashes; returns
 * undefined if the path is the repo root itself or outside the repo.
 */
export function getRepoRelativePath(repoRoot: string, fullPath: string): string | undefined {
  let relativePath = path.relative(repoRoot, fullPath);
  let isInside = relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  return isInside ? relativePath.split(path.sep).join("/") : undefined;
}

/** Gets the `code` of a Node.js system error, e.g. "ENOENT". */
export function getErrorCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

/** Gets the message of an error, or the string form of a non-Error value. */
export function getErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
