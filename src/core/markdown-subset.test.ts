import { describe, expect, it } from "vitest";
import { reflowMarkdown, renderMarkdownSubset, stripMarkdown, truncateText } from "./markdown-subset";

describe("renderMarkdownSubset", () => {
  it("renders bold, italic, code, paragraphs and lists", () => {
    expect(renderMarkdownSubset("**Fix** the *CSV* `quote` logic in two places.\n\n- one\n- two __bold__\n\n"
      + "1. first\n2. second")).toBe("<p><strong>Fix</strong> the <em>CSV</em> <code>quote</code> logic in two "
      + "places.</p><ul><li>one</li><li>two <strong>bold</strong></li></ul><ol><li>first</li>"
      + "<li>second</li></ol>");
  });

  it("splits a paragraph followed by a list, and renders headings as bold paragraphs", () => {
    expect(renderMarkdownSubset("## Changes\r\nThese files:\r\n* a.cs\r\n* b.cs\r\n\r\nDone."))
      .toBe("<p><strong>Changes</strong></p><p>These files:</p><ul><li>a.cs</li><li>b.cs</li></ul><p>Done.</p>");
  });

  it("joins hard-wrapped lines with spaces, as in CommonMark, so wrapped commit messages reflow", () => {
    expect(renderMarkdownSubset("Group summaries are copied from\n  commit *messages,\nwhich* are wrapped.\n\n"
      + "Second paragraph."))
      .toBe("<p>Group summaries are copied from commit <em>messages, which</em> are wrapped.</p>"
        + "<p>Second paragraph.</p>");
  });

  it("breaks lines that end with two or more spaces or a backslash", () => {
    expect(renderMarkdownSubset("one  \ntwo\\\n**three \\\nfour**   \n- item  \n  more\\"))
      .toBe("<p>one<br>two<br><strong>three<br>four</strong></p><ul><li>item<br>more\\</li></ul>");
  });

  it("continues a list item with the lines that follow it until the next item, heading or blank line", () => {
    expect(renderMarkdownSubset("- Wrapped bullet of a\n  commit message\n- next item\nlazy line\n1. new list\n"
      + "# Heading\nParagraph"))
      .toBe("<ul><li>Wrapped bullet of a commit message</li><li>next item lazy line</li></ul><ol><li>new list</li>"
        + "</ol><p><strong>Heading</strong></p><p>Paragraph</p>");
  });

  it("leaves snake_case, lone asterisks and markers inside code literal", () => {
    expect(renderMarkdownSubset("Use snake_case_names, 2 * 3 * 4, and `**not bold**`."))
      .toBe("<p>Use snake_case_names, 2 * 3 * 4, and <code>**not bold**</code>.</p>");
  });

  it("escapes HTML, so tags and event handlers in the markdown stay text", () => {
    let html = renderMarkdownSubset(`<img src=x onerror="alert(1)"> <script>alert('x')</script> **<b>hi</b>**`);
    expect(html).not.toMatch(/<(img|script|b)\b/);
    expect(html).toBe("<p>&#60;img src=x onerror=&#34;alert(1)&#34;&#62; &#60;script&#62;alert(&#39;x&#39;)"
      + "&#60;/script&#62; <strong>&#60;b&#62;hi&#60;/b&#62;</strong></p>");
  });

  it("shows links and images as their text, so javascript: URLs never become attributes", () => {
    let html = renderMarkdownSubset(`[click me](javascript:alert(1)) ![logo](https://x.test/a.png "t") `
      + `[a "quoted" one](http://x.test/" onclick="alert(1))`);
    expect(html).toBe("<p>click me logo a &#34;quoted&#34; one</p>");
    expect(html).not.toMatch(/javascript|href|src=|onclick/);
  });

  it("escapes HTML inside backticks and ignores NUL characters (used internally as placeholders)", () => {
    expect(renderMarkdownSubset("`<img src=x onerror=alert(1)>` \u00000\u0000"))
      .toBe("<p><code>&#60;img src=x onerror=alert(1)&#62;</code> 0</p>");
  });
});

describe("reflowMarkdown", () => {
  it("joins wrapped lines, keeping list items, headings, hard breaks and blank lines", () => {
    expect(reflowMarkdown("Group summaries are copied\r\n  from commit messages.\r\n\r\n\r\n## Changes\n"
      + "- Wrapped bullet of a\n  commit message\n  1. nested item\n     wrapped\nlazy line\n\n"
      + "one  \ntwo\\\nthree\nfour"))
      .toBe("Group summaries are copied from commit messages.\n\n\n## Changes\n- Wrapped bullet of a commit message\n"
        + "  1. nested item wrapped lazy line\n\none  \ntwo\\\nthree four");
  });

  it("keeps the indentation of paragraphs and of list items' lines after hard breaks", () => {
    expect(reflowMarkdown("- one  \n  two\n  three\n\n  Item's second\n  paragraph\n\n  1. a\\\n     b"))
      .toBe("- one  \n  two three\n\n  Item's second paragraph\n\n  1. a\\\n     b");
  });

  it("leaves fenced code blocks untouched", () => {
    let fenced = "```ts\nlet x =\n  1;\n\n\nreturn x;\n```";
    expect(reflowMarkdown(`Before\nit.\n${fenced}\nAfter\nit.\n~~~\nraw\n  text\n~~~`))
      .toBe(`Before it.\n${fenced}\nAfter it.\n~~~\nraw\n  text\n~~~`);
  });
});

describe("stripMarkdown", () => {
  it("makes one line of plain text", () => {
    expect(stripMarkdown("**Major:** these one-time costs\nare `counted` *twice*; see [Foo](http://x).\n\n- item"))
      .toBe("Major: these one-time costs are counted twice; see Foo. item");
    expect(stripMarkdown("## Heading\n> quoted snake_case")).toBe("Heading quoted snake_case");
  });
});

describe("truncateText", () => {
  it("adds an ellipsis only when it shortens the text", () => {
    expect(truncateText("abcdef", 6)).toBe("abcdef");
    expect(truncateText("abc def", 5)).toBe("abc…");
  });
});
