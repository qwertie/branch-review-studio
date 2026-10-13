/**
 * Renders agent-written markdown (group summaries, review summaries) as HTML for the Branch Review
 * webview. Only a safe subset is supported: all HTML in the input is escaped first, then **bold**,
 * *italic*, `code`, paragraphs, line breaks, headings (as bold paragraphs) and simple lists are
 * converted. As in CommonMark, a single newline is a space unless the line ends with two spaces or
 * a backslash (a line break), so hard-wrapped text such as commit messages reflows. Links and
 * images are shown as their text, so the output has no URLs or attributes.
 */
export function renderMarkdownSubset(markdown: string): string {
  // renderInline uses NUL characters as placeholders
  let blocks = escapeHtml(markdown.replace(/\r\n?/g, "\n").replace(/\u0000/g, "")).split(/\n[ \t]*\n/);
  return blocks.map(renderBlock).join("");
}

/**
 * Joins the wrapped lines of each paragraph and list item of markdown into one line, as
 * renderMarkdownSubset does, so that an editor that word-wraps shows the text in fewer lines. List
 * items and headings start new lines; paragraphs and items keep their first line's indentation
 * (and marker); hard breaks and blank lines are kept; fenced code blocks are unchanged. Used for
 * Open All Changes' group headings.
 */
export function reflowMarkdown(markdown: string): string {
  let output: string[] = [];
  let block: string[] = [];
  /** The opening fence (e.g. "```") of the code block that the current line is in */
  let fence: string | undefined;
  for (let line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    let fenceLine = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      output.push(line);
      if (fenceLine?.startsWith(fence) && line.trim() === fenceLine)
        fence = undefined;
    } else if (fenceLine || line.trim() === "") {
      flushBlock();
      output.push(line);
      fence = fenceLine;
    } else {
      block.push(line);
    }
  }
  flushBlock();
  return output.join("\n");

  function flushBlock() {
    for (let part of parseBlock(block)) {
      if (part.kind === "heading") {
        output.push(part.line);
      } else {
        // Lines after a hard break are indented to the first line's text, so they stay in the item
        let prefix = part.kind === "item" ? part.prefix : /^\s*/.exec(part.lines[0])?.[0] ?? "";
        output.push(...joinWrappedLines(part.lines).map((s, i) =>
          (i === 0 ? prefix : " ".repeat(prefix.length)) + s.text + (s.breakMarker ?? "")));
      }
    }
    block = [];
  }
}

/**
 * Converts markdown to one line of plain text, e.g. "**Major:** see `Foo`" to "Major: see Foo", for
 * labels that show the start of a message.
 */
export function stripMarkdown(markdown: string): string {
  return markdown.split(/\r?\n/).map(line => line.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, ""))
    .join(" ")
    .replace(codeSpanPattern, "$1")
    .replace(linkPattern, "$1")
    .replace(strongPattern, "$2")
    .replace(emphasisPattern, "$1$3")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shortens text to `maxLength` characters or fewer, ending it with "…" if it was shortened. */
export function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength - 1).trimEnd() + "…";
}

/** Escapes text for use in HTML content and in quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
}

/** Patterns of inline markup; links and images are replaced by their text */
const codeSpanPattern = /`([^`]+)`/g;
const linkPattern = /!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g;
const strongPattern = /(\*\*|__)(.+?)\1/g;
/** A single `*` or `_` pair; `_` must not be inside a word, so snake_case stays literal */
const emphasisPattern = /(^|[^\w*])([*_])([^*_\s](?:[^*_]*[^*_\s])?)\2(?![\w*])/g;
const listItemPattern = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const headingPattern = /^\s*#{1,6}\s+(.*)$/;

/**
 * Renders a block of escaped markdown (text between blank lines): runs of list items become lists,
 * headings become bold paragraphs, and other text becomes paragraphs (see parseBlock).
 */
function renderBlock(block: string): string {
  let html = "";
  /** Each item is rendered HTML */
  let list: { tag: "ul" | "ol", items: string[] } | undefined;
  for (let part of parseBlock(block.split("\n"))) {
    if (part.kind !== "item" || part.tag !== list?.tag)
      flushList();
    if (part.kind === "item") {
      list ??= { tag: part.tag, items: [] };
      list.items.push(`<li>${renderLines(part.lines)}</li>`);
    } else {
      html += part.kind === "heading" ? `<p><strong>${renderInline(part.text)}</strong></p>`
        : `<p>${renderLines(part.lines)}</p>`;
    }
  }
  flushList();
  return html;

  function flushList() {
    if (list)
      html += `<${list.tag}>${list.items.join("")}</${list.tag}>`;
    list = undefined;
  }
}

/** A paragraph, list item or heading of a block of markdown (see parseBlock). */
type BlockPart =
  | { kind: "paragraph", lines: string[] }
  /** `prefix` is the item's first line up to its text, e.g. "  1. " */
  | { kind: "item", tag: "ul" | "ol", prefix: string, lines: string[] }
  /** `text` is `line` without the `#` marks */
  | { kind: "heading", line: string, text: string };

/**
 * Divides a block of markdown (lines between blank lines) into paragraphs, list items and
 * headings, for renderBlock and reflowMarkdown. A line that is not an item or heading continues
 * the list item or paragraph above it, if any (e.g. a wrapped bullet).
 */
function parseBlock(lines: string[]): BlockPart[] {
  let parts: BlockPart[] = [];
  for (let line of lines.filter(l => l.trim() !== "")) {
    let item = listItemPattern.exec(line);
    let heading = headingPattern.exec(line);
    let previous = parts.at(-1);
    if (item) {
      parts.push({ kind: "item", tag: /\d/.test(item[1]) ? "ol" : "ul",
        prefix: line.slice(0, line.length - item[2].length), lines: [item[2]] });
    } else if (heading) {
      parts.push({ kind: "heading", line, text: heading[1] });
    } else if (previous && previous.kind !== "heading") {
      previous.lines.push(line);
    } else {
      parts.push({ kind: "paragraph", lines: [line] });
    }
  }
  return parts;
}

/** Renders the lines of a paragraph or list item (escaped markdown) as HTML (see joinWrappedLines). */
function renderLines(lines: string[]): string {
  return renderInline(joinWrappedLines(lines).map(s => s.text + (s.breakMarker ? "<br>" : "")).join(""));
}

/**
 * Joins the lines of a paragraph or list item with spaces, as CommonMark does, except after a line
 * that ends with a hard break (two or more spaces or a backslash). Returns the joined segments,
 * each with the hard break that ends it (removed from `text`; undefined for the last segment).
 */
function joinWrappedLines(lines: string[]): { text: string, breakMarker: string | undefined }[] {
  let segments: { text: string, breakMarker: string | undefined }[] = [];
  let segmentLines: string[] = [];
  for (let [i, line] of lines.entries()) {
    let breakMarker = i < lines.length - 1 ? /(?: {2,}|\\)$/.exec(line)?.[0] : undefined;
    segmentLines.push((breakMarker === "\\" ? line.slice(0, -1) : line).trim());
    if (breakMarker || i === lines.length - 1) {
      segments.push({ text: segmentLines.join(" "), breakMarker });
      segmentLines = [];
    }
  }
  return segments;
}

/** Renders the inline markup of escaped markdown: code spans, emphasis, links/images as text. */
function renderInline(text: string): string {
  let codeSpans: string[] = [];
  // Code spans are set aside first so that emphasis markers inside them stay literal
  return text.replace(codeSpanPattern, (_, code: string) => `\u0000${codeSpans.push(`<code>${code}</code>`) - 1}\u0000`)
    .replace(linkPattern, "$1")
    .replace(strongPattern, "<strong>$2</strong>")
    .replace(emphasisPattern, "$1<em>$3</em>")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => codeSpans[Number(i)]);
}
