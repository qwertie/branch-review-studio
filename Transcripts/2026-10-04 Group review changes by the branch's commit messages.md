# Group review changes by the branch's commit messages

## Planning

User:

> I'd like both versions of the skill to be updated such that rather than asking the agent to detect
> code groups and producing summaries of the groups itself, it should gather all the commit messages
> from the branch, extract groups and verbatim descriptions from those, then figure out for each
> piece of code which group it is in, creating a new group only if it's in none of them (any such
> groups should say "missing from commit message" in description).

User (while the work was in progress):

> Also use 1.0 as next version number

No questions were asked. Assumptions made without asking:

- A1: "Both versions of the skill" means the extension's skill (skills/branch-review-studio/SKILL.md,
  which quotes `groupingInstructions`, the text that `review_begin` returns) and the main repo's
  `/branch-review` command (.claude/commands/branch-review.md), whose own Grouping section was
  replaced in the main repo's working copy (left uncommitted there).
- A2: Groups come from the changes that a message describes: its main change, and each item it
  describes separately (e.g. under "### Also", per the commit-message rules in AGENTS.md). Merge
  commits are skipped (`git log --no-merges`), so merges from the base branch don't become groups.
- A3: A trivial change that its commit's message omits (as AGENTS.md says messages should, e.g.
  removing unused imports) belongs to that commit's main group, not to a "Missing from commit
  message." group.
- A4 (from the second pass): if several messages describe the same change, they form one group
  named with the earliest subject; a message that describes no change (e.g. "WIP") gives no group.

## End phase

Changes:

- src/core/agent-commands.ts: `groupingInstructions` (returned by `review_begin` and included in
  `review_set_groups`'s description) now tells the agent to take the groups from the commit
  messages, as above; the SKILL.md Grouping section quotes it verbatim (a test checks this).
- src/mcp/server.ts: `review_set_groups`'s `summary` description says the summary is the verbatim
  commit-message text or "Missing from commit message." plus what the changes do.
- docs/guide.md, README.md: describe the commit-message grouping.
- Version 1.0.0.

Tests: all 168 vitest tests pass; `tsc --noEmit` is clean; `npm run package` builds
branch-review-studio-1.0.0.vsix.
