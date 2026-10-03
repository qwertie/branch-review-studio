import * as fs from "node:fs/promises";
import { getFullPath } from "./files";
import { ChangedFile, getFileAtRevision, runGit } from "./git";

/**
 * A change between a file's merge-base version and its working-tree version, as `git diff -U0`
 * reports it: base lines oldStart..oldStart+oldCount-1 became `newLines`, the first of which is
 * working-tree line `newStart`. If oldCount is 0, the lines were inserted after base line oldStart
 * (0 = at the top). If `newLines` is empty, the base lines were removed after working-tree line
 * newStart (0 = at the top).
 */
export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  /** Each line with its line terminator (the last line of a file may lack one) */
  newLines: string[];
}

/** The part of a DiffHunk that applyHunks needs. */
export type HunkEdit = Pick<DiffHunk, "oldStart" | "oldCount" | "newLines">;

/**
 * Gets the hunks of a changed file: from `git diff -U0` for a modified or renamed file, or a single
 * hunk spanning the whole file for an added (e.g. untracked) or deleted file. A binary file, a
 * submodule and a symlink have no hunks.
 */
export async function readDiffHunks(repoRoot: string, mergeBaseSha: string, file: ChangedFile)
  : Promise<DiffHunk[]> {
  let fullPath = getFullPath(repoRoot, file.path);
  let workingStats = file.status === "Deleted" ? undefined : await fs.lstat(fullPath).catch(() => undefined);
  let workingText = workingStats?.isFile() ? await fs.readFile(fullPath, "utf8") : "";
  let workingLines = splitLinesKeepingEnds(workingText);
  if (workingStats !== undefined && !workingStats.isFile()) {
    // Git diffs a submodule's commit or a symlink's target path, not file content
    return [];
  } else if (file.status === "Added" || file.status === "Deleted") {
    let baseText = file.status === "Added" ? "" : (await getFileAtRevision(repoRoot, mergeBaseSha, file.path)) ?? "";
    let baseLineCount = splitLinesKeepingEnds(baseText).length;
    // Like git, this treats a file that contains a NUL character as binary
    let isBinary = (baseText + workingText).includes("\0");
    return isBinary || baseLineCount + workingLines.length === 0 ? [] : [{ oldStart: baseLineCount === 0 ? 0 : 1,
      oldCount: baseLineCount, newStart: workingLines.length === 0 ? 0 : 1, newLines: workingLines }];
  } else {
    // Naming both paths of a renamed file lets git pair them
    let paths = file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];
    let output = await runGit(repoRoot,
      ["diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "-M", mergeBaseSha, "--", ...paths]);
    return parseDiffHunks(output).map(h => ({ oldStart: h.oldStart, oldCount: h.oldCount, newStart: h.newStart,
      newLines: workingLines.slice(h.newStart - 1, h.newStart - 1 + h.newCount) }));
  }
}

/** Parses the hunk headers (`@@ -a,b +c,d @@`) of `git diff` output; an omitted count means 1. */
export function parseDiffHunks(diffOutput: string)
  : { oldStart: number, oldCount: number, newStart: number, newCount: number }[] {
  return [...diffOutput.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(m => ({
    oldStart: Number(m[1]), oldCount: Number(m[2] ?? 1), newStart: Number(m[3]), newCount: Number(m[4] ?? 1),
  }));
}

/**
 * Applies `hunks` (sorted by position; insertions at the same position keep their order) to
 * `baseText` and returns the result. Line terminators are kept as they are in both inputs.
 */
export function applyHunks(baseText: string, hunks: HunkEdit[]): string {
  let baseLines = splitLinesKeepingEnds(baseText);
  let result: string[] = [];
  let nextBaseIndex = 0;
  for (let hunk of hunks) {
    let removedIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    result.push(...baseLines.slice(nextBaseIndex, removedIndex), ...hunk.newLines);
    nextBaseIndex = removedIndex + hunk.oldCount;
  }
  result.push(...baseLines.slice(nextBaseIndex));
  return result.join("");
}

/** Splits text into lines, keeping each line's terminator (LF or CRLF). */
export function splitLinesKeepingEnds(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
