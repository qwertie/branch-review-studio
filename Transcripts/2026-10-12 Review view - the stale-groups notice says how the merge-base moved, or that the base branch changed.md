# Review view: the stale-groups notice says how the merge-base moved, or that the base branch changed

## Planning

User's request (relayed by the coordinating agent, verbatim):

> The Branch Review sidebar shows this warning (src/core/review-view-html.ts ~line 59, driven by
> `outline.isStale`; see src/core/groups.ts ~line 58 and src/extension/base-content.ts ~line 98):
>
> "The merge-base changed since the groups were posted, so the diffs show all changes of each file.
> Ask the agent to post the groups again."
>
> David, the user, was confused: "as far as I know the merge base was `develop` before and still is
> `develop`." He's conflating the base branch with the merge-base commit. Change the notice to say
> what the old and new merge-base are, and why it might have changed, so it can't be confused with
> the base branch. Something like: "The merge-base with `develop` moved from `abc1234` to `def5678`
> (`develop` gained commits that were merged into this branch, or the branch was rebased) since the
> groups were posted, so the diffs show all changes of each file. Ask the agent to post the groups
> again." Use short SHAs. Ideally include each commit's subject or date as a tooltip or short
> suffix, if it's cheap to get from the data already available; don't add git calls on a hot path
> just for this. Find where the merge-base recorded with the groups is stored (it must be, to
> detect staleness) and thread both values to the view. Work out the actual possible causes from
> how the merge-base is computed (e.g. from `origin/<base>` after a fetch, merging develop into
> the branch, rebase, or a base-branch change), and phrase the cause hint accurately — keep it
> short. If the base branch itself changed, say that instead. Check for other places that show the
> same staleness to the user or to agents (e.g. MCP tool results, review_begin output) and make
> them consistent.

Findings:

- F1: `ChangeGroups.mergeBaseSha` stores the merge-base at the time of `review_set_groups`;
  `arrangeGroups` marks the layout stale when it differs from the current merge-base. The groups
  did not record which base ref that merge-base came from, so "the base branch changed" could not
  be told apart from "the merge-base moved".
- F2: `findMergeBase` runs `git merge-base <baseRef> HEAD`, with `baseRef` = `origin/<base>` if it
  exists, else `<base>`. New base commits that the branch doesn't contain do not move it. It moves
  when HEAD's history changes (rebase or reset; merging newer base commits) or when `baseRef` takes
  in commits that HEAD contains (e.g. part of the branch was merged into develop and then fetched,
  or origin/develop catches up with a local develop the branch had merged). It also changes when
  the base branch changes (Change Base Branch…, `review_begin` with `baseBranch`) or when
  `origin/<base>` appears or disappears.
- F3: Other places that show staleness: the "regroup: merge-base changed" tag on group rows and in
  the Open All Changes heading text (`describeSection`), and docs/guide.md. No MCP tool result or
  the skill mentions stale groups (`review_set_groups` always recomputes the merge-base).
- F4: No commit subjects or dates are available without a git call per refresh.

Decisions (made without asking, since the run was non-interactive):

- D1: `ChangeGroups` gets an optional `baseRef`, saved by `createChangeGroups` (which now takes a
  `MergeBaseInfo`); groups posted by 1.1.0 or earlier lack it and are treated as having the same
  base ref.
- D2: Wording: "The merge-base with `origin/develop` moved from `fedcba98` to `01234567` since the
  groups were posted (because this branch was rebased, or merged newer commits of
  `origin/develop`, or `origin/develop` took in commits of this branch), so the diffs show all
  changes of each file. Ask the agent to post the groups again." If the stored base ref differs:
  "The base branch changed from `origin/main` to `origin/develop` since the groups were posted, so
  ...". 8-character SHAs like the header, with the full SHA as tooltip; no subjects/dates (F4).
- D3: The notice is not shown when the current merge-base is unknown; the error notice explains
  that instead.
- D4: The "regroup: merge-base changed" tags stay as they are (still accurate in both cases); no
  new staleness text in MCP results (F3); docs/guide.md's "Stale groups" bullet now lists causes.

## Questions and assumptions

- Assumed (unasked): no ticket number; commit as the coordinator asked.
- Assumed (unasked): D1-D4 above.

## End phase

- Tests: `npx tsc --noEmit` passes; `npx vitest run` passes (21 files, 180 tests). New/changed
  tests: the moved notice (with and without a stored base ref), the base-branch-changed notice
  (escaped), no stale notice without a merge-base, and `setGroups` saving `baseRef`; they failed
  before the change.
- Second pass (subagent): removed a redundant local in `setGroups`, added a doc comment to
  `renderCode`. Noted: if groups were posted with only a local `develop` and `origin/develop`
  appears later, the notice says the base branch changed from `develop` to `origin/develop`
  (accurate about refs, rare); force-pushes of the base branch aren't listed as a cause.
