/**
 * Renders agent-written markdown (group summaries, review summaries) as HTML for the Branch Review
 * webview. Only a safe subset is supported: all HTML in the input is escaped first, then **bold**,
 * *italic*, `code`, paragraphs, line breaks, headings (as bold paragraphs) and simple lists are
 * converted. Links and images are shown as their text, so the output has no URLs or attributes.
 */
export function renderMarkdownSubset(markdown: string): string {
  // renderInline uses NUL characters as placeholders
  let blocks = escapeHtml(markdown.replace(/\r\n?/g, "\n").replace(/\u0000/g, "")).split(/\n[ \t]*\n/);
  return blocks.map(renderBlock).join("");
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
 * headings become bold paragraphs, and other runs of lines become paragraphs with line breaks.
 */
function renderBlock(block: string): string {
  let html = "";
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol", items: string[] } | undefined;
  for (let line of block.split("\n").filter(l => l.trim() !== "")) {
    let item = listItemPattern.exec(line);
    let heading = headingPattern.exec(line);
    let tag: "ol" | "ul" | undefined = item ? (/\d/.test(item[1]) ? "ol" : "ul") : undefined;
    if (tag !== list?.tag)
      flushList();
    if (item || heading)
      flushParagraph();
    if (item && tag) {
      list ??= { tag, items: [] };
      list.items.push(item[2]);
    } else if (heading) {
      html += `<p><strong>${renderInline(heading[1])}</strong></p>`;
    } else {
      paragraph.push(line.trim());
    }
  }
  flushList();
  flushParagraph();
  return html;

  function flushParagraph() {
    if (paragraph.length > 0)
      html += `<p>${paragraph.map(renderInline).join("<br>")}</p>`;
    paragraph = [];
  }

  function flushList() {
    if (list)
      html += `<${list.tag}>${list.items.map(i => `<li>${renderInline(i)}</li>`).join("")}</${list.tag}>`;
    list = undefined;
  }
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
