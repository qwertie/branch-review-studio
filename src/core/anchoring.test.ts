import { describe, expect, it } from "vitest";
import { createAnchor, locateAnchor, splitLines } from "./anchoring";

const original = splitLines("namespace N {\nclass C {\n  void F() {\n    x = 1;\n    y = 2;\n  }\n}\n}\n");

describe("createAnchor", () => {
  it("captures the start line's text and up to 3 context lines on each side, clamped to the file", () => {
    expect(createAnchor(original, 2, 4)).toEqual({
      startLine: 2, endLine: 4, lineText: "class C {",
      contextBefore: ["namespace N {"], contextAfter: ["    y = 2;", "  }", "}"],
    });
  });

  it("clamps line numbers that are out of range", () => {
    expect(createAnchor(original, 0, 99)).toMatchObject({ startLine: 1, endLine: original.length });
  });
});

describe("locateAnchor", () => {
  const anchor = createAnchor(original, 4, 5);

  it("keeps the location when the file is unchanged", () => {
    expect(locateAnchor(original, anchor)).toEqual({ startLine: 4, endLine: 5, isOutdated: false });
  });

  it("follows the line when lines are inserted above it", () => {
    let edited = ["// header", "", ...original];
    expect(locateAnchor(edited, anchor)).toEqual({ startLine: 6, endLine: 7, isOutdated: false });
  });

  it("matches despite indentation changes and CRLF line endings", () => {
    let edited = splitLines(original.map(line => "  " + line).join("\r\n"));
    expect(locateAnchor(edited, anchor)).toEqual({ startLine: 4, endLine: 5, isOutdated: false });
  });

  it("prefers the duplicate whose context matches over a nearer duplicate", () => {
    let duplicateAnchor = createAnchor(splitLines("a\nb\nx = 1;\nc\nd"), 3, 3);
    let edited = splitLines("q\nx = 1;\nr\na\nb\nx = 1;\nc\nd");
    expect(locateAnchor(edited, duplicateAnchor)).toEqual({ startLine: 6, endLine: 6, isOutdated: false });
  });

  it("marks the thread outdated at its old line when the line text is gone", () => {
    let edited = original.filter(line => line !== "    x = 1;");
    expect(locateAnchor(edited, anchor)).toEqual({ startLine: 4, endLine: 5, isOutdated: true });
  });

  it("clamps an outdated location to the end of a shortened file", () => {
    expect(locateAnchor(["only line"], anchor)).toEqual({ startLine: 1, endLine: 1, isOutdated: true });
  });
});
