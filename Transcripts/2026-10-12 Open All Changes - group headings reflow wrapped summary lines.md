# Open All Changes: group headings reflow wrapped summary lines

## Planning

Context: the coordinator asked (for David) to cherry-pick 359e1c1 ("Open All Changes: only a group
heading's heading and size lines are green") onto `main`, accepting that VS Code folds part of
long summaries; it is commit 6045127 on `main`, and `wip/heading-original-side` was deleted. Then:

User's request (relayed by the coordinating agent, verbatim):

> One more addition from David, to do after the cherry-pick (before the single
> package/install/smoke test): in the group heading document's text (getGroupHeading in
> src/core/review-outline.ts), reflow the summary the way the markdown renderer now does: join the
> wrapped lines of each paragraph and of each list item onto one line, keep blank lines between
> paragraphs, keep list items on their own lines, keep hard breaks (lines ending in 2+ spaces or a
> backslash) and leave fenced code blocks untouched. Share the line-joining logic with
> renderMarkdownSubset in src/core/markdown-subset.ts rather than duplicating it. Purpose: VS Code
> word-wraps markdown documents, so fewer physical lines means less of the summary gets folded in
> the multi-diff editor. The original-side document must get the same reflowed summary so the
> summary still shows as unchanged. Separate commit, with tests; same Co-Authored-By line. In the
> smoke-test launch, if cheap, confirm the reflowed summary word-wraps in the multi-diff editor
> and report.

Plan and decisions (made without asking, since the run was non-interactive):

- D1: markdown-subset.ts: split `renderBlock`'s loop into a shared `parseBlock(lines)`
  (paragraphs, list items with their indentation and marker, headings) and `renderLines`'s
  joining into a shared `joinWrappedLines(lines)` (segments split at hard breaks). The new
  `reflowMarkdown(markdown)` uses both and passes fenced code blocks through unchanged.
  `renderMarkdownSubset`'s output must not change.
- D2: Blank lines are kept verbatim (not collapsed to one).
- D3: `getGroupHeading` reflows the summary into `originalText`, which `text` ends with, so both
  sides of the heading diff get the same summary.
- D4: Not handled: setext headings (`Title\n===`), wrapped `>` quote lines, fences indented 4+
  spaces, and indented code blocks are joined like paragraphs, as the renderer already does.

## Questions and assumptions

- Assumed (unasked): no ticket number; D1-D4 above.

## End phase

- Tests: `npx tsc --noEmit` passes; `npx vitest run` passes (21 files, 185 tests). New tests:
  `reflowMarkdown` joins wrapped paragraph and item lines and keeps items, headings, hard breaks
  and blank lines; keeps indentation of paragraphs and of item lines after hard breaks; leaves
  fenced code untouched; `getGroupHeading` reflows the summary. They failed before the change.
- Second pass (subagent): verified that `renderMarkdownSubset` gives identical HTML before and
  after the refactor (by reasoning and by comparing both versions on 300,000 random inputs); made
  `reflowMarkdown` keep a paragraph's indentation and indent lines after a hard break to the
  item's text; simplified the closing-fence check; added the indentation test.
