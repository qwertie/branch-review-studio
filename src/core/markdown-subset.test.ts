import { describe, expect, it } from "vitest";
import { renderMarkdownSubset, stripMarkdown, truncateText } from "./markdown-subset";

describe("renderMarkdownSubset", () => {
  it("renders bold, italic, code, paragraphs, line breaks and lists", () => {
    expect(renderMarkdownSubset("**Fix** the *CSV* `quote` logic\nin two places.\n\n- one\n- two __bold__\n\n"
      + "1. first\n2. second")).toBe("<p><strong>Fix</strong> the <em>CSV</em> <code>quote</code> logic<br>"
      + "in two places.</p><ul><li>one</li><li>two <strong>bold</strong></li></ul><ol><li>first</li>"
      + "<li>second</li></ol>");
  });

  it("splits a paragraph followed by a list, and renders headings as bold paragraphs", () => {
    expect(renderMarkdownSubset("## Changes\r\nThese files:\r\n* a.cs\r\n* b.cs\r\nDone."))
      .toBe("<p><strong>Changes</strong></p><p>These files:</p><ul><li>a.cs</li><li>b.cs</li></ul><p>Done.</p>");
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
