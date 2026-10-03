import { Anchor } from "./review";

/** Where an Anchor was found in the current text of its file (1-based, inclusive lines). */
export interface AnchorLocation {
  startLine: number;
  endLine: number;
  /** True if the anchored line text was not found, so the old line numbers were kept */
  isOutdated: boolean;
}

/** Maximum number of lines in `Anchor.contextBefore` and `Anchor.contextAfter` */
const contextSize = 3;

/** Splits file text into lines, accepting both LF and CRLF line endings. */
export function splitLines(text: string): string[] {
  let lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "")
    lines.pop();
  return lines;
}

/** Creates an Anchor for lines `startLine..endLine` (1-based, clamped to the file) of `lines`. */
export function createAnchor(lines: string[], startLine: number, endLine: number): Anchor {
  let lineCount = Math.max(lines.length, 1);
  let start = clamp(startLine, 1, lineCount);
  let end = clamp(Math.max(endLine, start), start, lineCount);
  return {
    startLine: start,
    endLine: end,
    lineText: lines[start - 1] ?? "",
    contextBefore: lines.slice(Math.max(0, start - 1 - contextSize), start - 1),
    contextAfter: lines.slice(end, end + contextSize),
  };
}

/**
 * Finds `anchor` in the current lines of its file. If `anchor.lineText` is still at
 * `anchor.startLine`, the location is unchanged. Otherwise, among the lines equal to `lineText`
 * (ignoring leading/trailing whitespace), the one with the most matching context lines wins, with
 * ties going to the one nearest the old location. If there is no such line, the old location is
 * kept (clamped to the file) and marked outdated.
 */
export function locateAnchor(lines: string[], anchor: Anchor): AnchorLocation {
  let lastLineOffset = anchor.endLine - anchor.startLine;
  let target = anchor.lineText.trim();
  let candidates: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === target)
      candidates.push(i + 1);
  }

  let best: number | undefined;
  if (candidates.includes(anchor.startLine)) {
    best = anchor.startLine;
  } else {
    let bestScore = -1;
    let bestDistance = Infinity;
    for (let candidate of candidates) {
      let score = countMatchingContextLines(lines, anchor, candidate, lastLineOffset);
      let distance = Math.abs(candidate - anchor.startLine);
      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        best = candidate;
        bestScore = score;
        bestDistance = distance;
      }
    }
  }

  if (best !== undefined)
    return { startLine: best, endLine: best + lastLineOffset, isOutdated: false };
  let lastLine = Math.max(lines.length, 1);
  let startLine = clamp(anchor.startLine, 1, lastLine);
  return { startLine, endLine: clamp(startLine + lastLineOffset, startLine, lastLine), isOutdated: true };
}

/** Counts how many of the anchor's context lines match the lines around a candidate start line. */
function countMatchingContextLines(lines: string[], anchor: Anchor, startLine: number, lastLineOffset: number)
  : number {
  let count = 0;
  anchor.contextBefore.forEach((text, i) => {
    let lineIndex = startLine - 1 - anchor.contextBefore.length + i;
    if (lines[lineIndex]?.trim() === text.trim())
      count++;
  });
  anchor.contextAfter.forEach((text, i) => {
    let lineIndex = startLine + lastLineOffset + i;
    if (lines[lineIndex]?.trim() === text.trim())
      count++;
  });
  return count;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
