# Review view: summaries reflow wrapped lines; group sizes show added and removed lines

## Planning

User's request (relayed by the coordinating agent; David's three items, verbatim):

> 1. **Soft line breaks in summaries.** `renderMarkdownSubset` in src/core/markdown-subset.ts joins
> a paragraph's lines with `<br>` (flushParagraph). Group summaries are now copied verbatim from
> commit messages, which are hard-wrapped at ~72 chars, so in the narrow Branch Review sidebar
> (src/core/review-view-html.ts renders `group.summary`) they wrap awkwardly. Make it follow
> CommonMark: a single newline inside a paragraph is a space; a hard break only where a line ends
> with two or more spaces or a backslash; blank lines still separate paragraphs. Also: an indented
> (or any non-item, non-heading) line directly following a list item continues that item (joined
> with a space) instead of breaking out of the list — commit messages wrap bullets like
> "- foo bar\n  baz". Check other callers of renderMarkdownSubset (comments in the review view,
> etc.) and make sure nothing relied on the <br> behavior in a way that matters; update existing
> tests that encoded the old behavior. Don't add the "keep breaks after short lines" heuristic.
>
> 2. **Group heading documents not all green.** In Open All Changes / group multi-diff editors,
> each group is introduced by a heading document (src/core/review-outline.ts `getGroupHeading`,
> served by `HeadingContentProvider` in src/extension/base-content.ts, opened in
> src/extension/diff-commands.ts `openMultiDiff` as `[uri, undefined, uri]`). Because the original
> side is undefined, VS Code shows it as an added file and every line is green, which is
> distracting. Change it so the original side is a second document containing the text WITHOUT
> its first four lines [...] and the modified side is the full text. So only the heading/size
> lines are green and the summary shows as unchanged. Needs a distinct URI for the original [...]
> make sure refreshes fire change events for both. In your single VS Code test launch, check
> whether the multi-diff editor folds the unchanged summary lines away (hideUnchangedRegions) and
> report what you see — if summaries longer than a few lines get folded into "N unchanged lines",
> say so and propose options rather than shipping something hacky.
>
> 3. **Added and removed line counts.** The size text (e.g. "292 lines, 14 files", from
> `describeSection` in src/core/review-outline.ts and wherever else a size like that is shown,
> e.g. the sidebar) should show lines added and lines removed separately, e.g. "+250 −42 lines,
> 14 files" (pick a clear format consistent with the codebase; mention your choice). Find where the
> line count comes from (numstat or diff hunks) and whether per-group counts (from group ranges)
> can be split into added/removed; keep per-group accuracy at least as good as now.

Correction from David during the work (item 2): "make the first THREE lines green, not four —
i.e. the `# heading` line, the blank line, and the size line are 'added'; the blank line after
the size line and the summary are unchanged (present in the original document)."

Findings and decisions:

- F1: `renderMarkdownSubset` has two callers, both in review-view-html.ts: the review summary and
  group summaries. Thread comments go through VS Code's Comments API (already CommonMark), so
  nothing else relied on the `<br>` behavior.
- F2: Group sizes come from the frozen `GroupedHunk`s (`git diff -U0` hunks assigned to groups):
  `changedLines` = sum of max(oldCount, newCount). Splitting into added (sum of `newCount`) and
  removed (sum of `oldCount`) is exact per hunk, so per-group accuracy is unchanged.
- D1: Size format "+12 −3 lines, 3 files" (U+2212 minus, like the request); a zero count is left
  out ("+1 line, 1 file", "−4 lines, 2 files"), "0 lines, 1 file" if both are zero (e.g. a group
  with only a binary file), Ungrouped stays "3 files", an empty group stays "no changes".
  `changedLines` stays as the sort key, so group order doesn't change.
- D2: A text line that follows a list item continues it even without indentation (CommonMark's
  lazy continuation), so "* b.cs\nDone." now renders "Done." inside the item; the existing test
  was changed to put a blank line before "Done.".

## Questions and assumptions

- Assumed (unasked): no ticket number; commit without one, as the coordinator asked for commits.
- Assumed (unasked): item 2 should not ship if the multi-diff editor folds the summary away (see
  End phase), since the request said to report and propose options in that case. Item 2's code
  is kept in a separate commit that is not on `main`.

## End phase

- Tests: `npx tsc --noEmit -p .` passes; `npx vitest run` passes (21 files, 178 tests on `main`;
  179 with item 2). New tests: CommonMark soft breaks, hard breaks (two spaces, backslash, bold
  across a hard break, literal backslash at the end), list item continuation, per-group added and
  removed counts, `describeGroupSize` formats, the sidebar's size text; the markdown tests failed
  before the change.
- Second pass (subagent): fixed B1, bold could not span a hard line break because `renderLines`
  joined lines with "\n" (which the bold pattern doesn't cross) before turning it into `<br>`;
  shortened `describeGroupSize`; rewrapped comments. Noted F3: a code span that crosses a hard
  break gets a `<br>` inside `<code>` (rare; left alone).
- Smoke test (`npm run smoke-test -- D:\brs-sandbox\Barreleye`, one launch, with item 2 included
  and BRS_SCREENSHOT_DIR set): all 34 checks passed, none failed.
- Folding observation (item 2): VS Code's multi-diff editor hides unchanged regions in the heading
  entries. With the 3 heading lines green, it shows the 3 lines of context after them (the blank
  line and 2 summary lines) and folds the rest: the smoke test's 6-line summary showed "3 hidden
  lines", and a 12-line summary showed only its first 2 lines then "10 hidden lines". So any
  summary longer than about 3 lines is mostly hidden behind a click, which is worse than the
  all-green heading. Options:
  - P1: Keep the all-green heading (what `main` does now).
  - P2: Ship item 2 anyway, accepting that long summaries are folded (one click shows them).
  - P3: Item 2 plus unwrapping each paragraph/bullet of the summary to one line in the heading
    document (markdown documents word-wrap in VS Code), so typical commit-message summaries have
    ~3-5 lines and are often not folded; long ones still are.
  - Hacks such as changing a line every 6 lines to defeat folding, or altering the user's
    `diffEditor.hideUnchangedRegions` setting, were not pursued.
- Item 2 is kept as commit (see the coordinator's report) on top of this commit, not on `main`.
