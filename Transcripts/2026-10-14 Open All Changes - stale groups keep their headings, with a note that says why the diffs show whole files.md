# Open All Changes: stale groups keep their headings, with a note that says why the diffs show whole files

## Planning

User's request (relayed by the coordinating agent; David approved the plan), verbatim:

> Background: when a review's change groups are stale (`ReviewOutline.isStale`, i.e. the
> merge-base moved since the groups were posted — e.g. David merged develop into the branch after
> the review), `listChangesEntries` in src/core/review-outline.ts (~line 203) drops the group
> heading documents and lists plain whole-file diffs. So "Open All Changes" and the per-group
> multi-diff editor (openGroupChanges in src/extension/diff-commands.ts) lose the group's heading
> and summary. But only the groups' line ranges are unreliable; the names, summaries and file
> lists are still useful.
>
> Change: when stale, keep the heading documents and group structure, with whole-file diffs (no
> group views, since ranges are unusable). Since VS Code's multi-diff editor shows nothing if two
> entries have the same original and modified documents, a file in several groups is listed only
> under its first group in that editor (check whether the per-group editor, which shows one
> section, is fine to list the file even if it's in other groups — it should be). In the heading
> document (getGroupHeading in review-outline.ts, served by HeadingContentProvider), add a note
> between the heading/size part and the summary, explaining why the diffs below may be
> inaccurate. Base its wording on the sidebar's stale-groups notice (renderStaleGroupsNotice in
> src/core/review-view-html.ts; it names the old and new merge-base, or the base-branch change) —
> share the text-building logic rather than duplicating it, adapted to plain markdown, e.g. ">
> **Regroup needed:** the merge-base with `origin/develop` moved from `5c110abc` to `f6900332`
> since the groups were posted, so the diffs below show whole files, including changes that
> belong to other groups. Ask the agent to post the groups again." Mention the "listed only under
> its first group" effect too if it applies to that group (or keep it generic and short). The
> note should be in the green (added) part of the heading diff — i.e. the original-side document
> (the one without the first lines; see the `6045127` "only a group heading's heading and size
> lines are green" change) still starts at the summary — so the note is always visible and not
> folded away. Keep the reflowed-summary behavior (3db4038).
>
> Real-world case to sanity check against (read-only, don't modify): D:\Barreleye3, branch
> feature/2516_disposal_capacity_time_series [...] groups posted against 5c110abc, current
> merge-base f6900332 (the branch is already merged into origin/develop).

Mid-task message from the coordinator (for David): VS Code had finished updating, so run the
smoke test once at the end (it also covers the previously untested commit 80cf02e), and after
committing, `git push origin main`.

Plan and decisions (made without asking, since the run was non-interactive):

- D1: review-outline.ts: new `GroupsBaseMove` (`posted`, `current`) and `CodeFormat`
  (`formatCode`, `formatSha`) types and `describeGroupsBaseMove(move, format, isCauseIncluded)`,
  which builds the clause "the merge-base with X moved from A to B since the groups were posted"
  (or "the base branch changed from X to Y ..."). The sidebar's `renderStaleGroupsNotice` uses it
  with an HTML format and the "(because this branch was rebased, ...)" cause, and capitalizes it;
  the heading note uses a markdown format without the cause, as in David's example. The sidebar's
  wording is unchanged.
- D2: `getGroupHeading(outline, section, move?)`: the note goes into `text` between the size line
  and the summary; `originalText` still has only the summary, so the note is green.
  `HeadingContentProvider` passes `move` from `snapshot.review.changeGroups` and
  `snapshot.mergeBase`.
- D3: `listChangesEntries` keeps headings when stale and lists a file only under its first group;
  the per-group editor (one section) lists all of the group's files.
- D4: The sentence "In Open All Changes, a file that is also in an earlier group is listed only
  there." is added only to groups that have such a file. The same heading document serves both
  editors, so the sentence names Open All Changes.
- D5: Ungrouped's heading gets no note, since its files always show whole-file diffs.

In the real-world case (read-only check), the small groups (e.g. "agent-wiki", "AddIssueOnSolveDate")
come first, so the big "time series" group loses several shared files (e.g.
HydraulicsPresolver.cs) to them in Open All Changes, and its heading gets the "listed only there"
sentence.

## Questions and assumptions

- Assumed (unasked): D1-D5; no ticket number.

## End phase

- Tests: `npx tsc --noEmit` passes; `npx vitest run` passes (21 files, 199 tests). New tests:
  stale groups keep headings with whole-file diffs, a file only under its first group, and the
  group's own editor lists all its files; a stale group's heading document has the note in its
  added lines (merge-base moved, base branch changed, "listed only there" sentence only where it
  applies, none for Ungrouped). They failed before the change. The sidebar notice tests pass
  unchanged.
- Second pass (subagent): split the note's nested ternary into an `if` block, fixed the
  `GroupsBaseMove` doc comment (a changed `baseRef` alone doesn't make groups stale), passed
  `renderSha` directly, rewrapped long lines.
- docs/guide.md: Open All Changes with stale groups.
- Smoke test against D:/brs-sandbox/Barreleye: SMOKE TEST PASSED (all checks). A second run was
  launched by mistake right after; it was left to finish rather than killed mid-run.
