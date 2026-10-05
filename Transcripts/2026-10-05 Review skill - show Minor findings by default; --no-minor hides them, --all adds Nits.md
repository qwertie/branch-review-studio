# Review skill: show Minor findings by default; --no-minor hides them, --all adds Nits

## Planning

User: "For the version of the review in D:\branch-review-studio, the "--all" behavior should be the default with a new option for major only/suppressing minor. Suggestions?"

Assistant (summarized by the delegating agent): proposed P1 = name the option `--no-minor`
(parallels `--no-tests`; makes clear that Critical stays; the skill also recognizes plain requests
such as "major only", "skip minor findings" or "just the important stuff", the way "be thorough"
triggers thorough mode).

User: "ok do P1 and let --all show nits instead."

Plan, as given to the implementing agent:

- Default: show in chat and post as threads Critical, Major and Minor findings (what `--all` did).
- `--no-minor` (or a plain request for major-only findings): Critical and Major only, in chat and
  in threads; end the chat list with `(N Minor findings hidden — re-run without --no-minor to see
  them)`.
- `--all`: also show and post Nits (cosmetic findings). The threshold's DO NOT FLAG list still
  applies. Without `--all`, Nits are dropped.
- Add "Nit" as a severity in src/core/review.ts (`severities`), used by the MCP tool
  `review_comment`, and update everything that enumerates severities or describes the options.
- Test: T1 (src/core/agent-commands.test.ts) `findingInstructions` lists every severity, most
  severe first: "Critical, Major, Minor, Nit or Note". T1 failed before the implementation.

## Decisions and assumptions (unasked)

- D1: Severity order is Critical, Major, Minor, Nit, Note. "Note" marks a comment that is not a
  defect (an observation or a question), so it ranks below a cosmetic defect. Nothing in the code
  sorts by severity; the order matters for the doc comment on `severities` and for the text
  agents see.
- D2: A Nit badge in the Branch Review view uses the default gray `.severity` color from
  media/review-view.css, like Note; no CSS change.
- D3: The new `severityList` in src/core/review.ts derives "Critical, Major, Minor, Nit or Note"
  from `severities`, replacing the hand-written lists in `findingInstructions` and in the
  `review_comment` zod schema (src/mcp/server.ts).
- D4: The threshold block (given verbatim to sub-reviewers, who don't see the CLI arguments) says
  a cosmetic issue qualifies as a Nit only "if you were told that the review includes Nits
  (`--all`)", and the thorough-mode briefing now includes whether the review includes Nits.
- D5: Sub-reviewers still report Minor findings under `--no-minor`, so Step 5 can count the hidden
  ones. With both `--no-minor` and `--all`, "keep Critical + Major only" also drops Nits; not
  documented separately.
- D6: The settings panel and README don't describe severity options, so they were left alone.

## Second pass

A subagent reviewed the diff. It removed the duplicated "only with `--all`" rule from the Nit line
(the exception line now carries it, plus the DO NOT FLAG note), restored the original wrapping of
the thorough-mode paragraph to shrink the diff, and switched `severityList` to
`severities.at(-1)`. It found no stale references. It noted (C3) that verifiers in thorough mode
check only Critical and Major candidates, so Minor findings, now shown by default, go unverified;
this was already true under the old `--all` and was left as is. Afterwards the main agent replaced
the Nit example "a comment that contradicts the code" (arguably Minor) with "a typo in a name,
comment, message or doc".

## End phase

Tests:

- `npx vitest run`: 19 files, 169 tests passed.
- `npx tsc --noEmit -p .`: no errors.
- `npm run smoke-test -- D:\brs-sandbox\Barreleye`: 28 checks passed, 1 failed: "Ctrl+Enter in a
  new comment box clicks its primary button" (the text went into the file instead of the comment
  box), the known failure when the test window lacks OS focus.

No ticket number was given; committed without one.

Commit message:

```
Review skill: show Minor findings by default; --no-minor hides them, --all adds Nits

The review skill used to hide Minor findings unless the user passed `--all`, and dropped Nits
(cosmetic findings) even then. Now it shows and posts Critical, Major and Minor findings by
default, `--no-minor` (or a plain request such as "major only", "skip minor findings" or "just the
important stuff") limits it to Critical and Major, and `--all` also shows and posts Nits. The name
`--no-minor` parallels `--no-tests` and makes clear that Critical findings stay.

- skills/branch-review-studio/SKILL.md: Arguments lists `--no-minor` and the new meaning of
  `--all`. In the threshold block, an exception lets a cosmetic issue qualify as a Nit when the
  reviewer was told that the review includes Nits (the DO NOT FLAG list still applies), and the
  thorough-mode briefing tells sub-reviewers whether it does. Step 5 sorts Nits after Minor, hides
  Minor findings only with `--no-minor` (ending the list with "(N Minor findings hidden — re-run
  without --no-minor to see them)") and drops Nits unless `--all` was given.
- src/core/review.ts: `severities` gains "Nit" between "Minor" and "Note", so `review_comment`
  can post Nits. "Note" stays last because it marks a comment that isn't a defect (an observation
  or a question), which ranks below a cosmetic defect. A Nit badge in the Branch Review view gets
  the default gray color, like Note.
  - The new `severityList` ("Critical, Major, Minor, Nit or Note") replaces the hand-written lists
    in `findingInstructions` (src/core/agent-commands.ts) and in the `review_comment` schema
    (src/mcp/server.ts).
- agents/branch-reviewer.agent.md and docs/guide.md describe the new options.
```
