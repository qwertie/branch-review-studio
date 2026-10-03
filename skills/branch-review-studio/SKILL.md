---
name: branch-review-studio
description: Reviews the current git branch before it is merged - the working tree, including uncommitted and untracked files, against its merge-base with the base branch (usually develop) - for bugs, security, performance, project conventions and dependency changes, runs the tests, and posts the findings as comment threads in Branch Review Studio (VS Code) via the `branch-review-studio` MCP tools. Use when asked to review a branch, "my changes" or a PR before merging, or when a prompt says it comes from Branch Review Studio (e.g. answering a review thread). Works in a single context by default; fans out to parallel sub-agents only when asked ("be thorough", "be comprehensive", "deep review", "use subagents", --thorough).
---

# Branch review (Branch Review Studio)

You (Claude Code, Codex, or an agent in VS Code's chat) review the branch checked out in your
project folder, post the findings to Branch Review Studio, and summarize them in chat. Branch
Review Studio is a VS Code extension in which the developer reads findings as comment threads on
the diff and answers them.
Its MCP server (`branch-review-studio`) provides `review_begin`, `review_comment`,
`review_set_groups`, `review_reply`, `review_resolve`, `review_list` and `review_finish`, which act
on the branch checked out in your project folder. If those tools are not available, do the review
anyway and report it in chat only.

Re-runs should converge instead of producing a fresh pile of pedantic noise: respect the threshold
below and don't re-raise what existing threads already say.

## Arguments

The user's request (e.g. the text after `/branch-review-studio` or `$branch-review-studio`) may
contain, in any order:

- `--all`: also show and post Minor findings (Nits stay suppressed)
- `--no-tests`: skip the test runs
- `--base <branch>`: compare against this branch instead of the review's base branch
- `--thorough`, or a request such as "be thorough", "be comprehensive", "deep review", "use
  subagents" or "use multiple sub-agents": thorough mode (Step 4). Without it, review in a single
  context; thorough mode costs several times as many tokens.
- free-form context: what to focus on, or why the change was made

Review the working tree in place. Never check out, switch, pull, reset or stash; if the user names
another branch to review, tell them to open that branch's worktree (Branch Review Studio's
**Switch Branch…**) and run the review there.

## Step 1 — Start the review and get the diff

1. Call `review_begin` (with `baseBranch` if `--base` was given). It reports the base branch
   (`<base>` below; the existing review's base, else `develop`) and the merge-base, and lists the
   open threads. Without the tools, `<base>` is `--base`, else `develop`.
2. Run `git fetch origin <base>` (skip silently if there is no `origin` or no network). If the
   fetch moved `origin/<base>`, call `review_begin` again, since it computes the merge-base from
   `origin/<base>`. Without the tools, use `git merge-base origin/<base> HEAD` (or `<base>` if
   there is no `origin/<base>`).
3. Branch tracking: if `git merge-base --is-ancestor origin/<base> HEAD` fails, the branch is
   behind. Report "Branch is N commits behind `<base>` — needs to catch up"
   (N = `git rev-list --count HEAD..origin/<base>`) as a **Major** item in the summary (Steps 6
   and 7), not as a thread, since a thread needs a file and line. Don't abort.
4. Diff context, with `MB` = the merge-base:

   ```
   git diff --numstat MB
   git diff MB
   git ls-files --others --exclude-standard
   git log --oneline MB..HEAD
   ```

   `git diff MB` (no `..HEAD`) compares the working tree, so uncommitted changes are reviewed too;
   untracked files are new files that the diff omits. Note which top-level areas changed.

## Step 2 — Already-raised set

Call `review_list` with `status: "all"` and keep every thread (open and resolved) as the
"already raised" set. If you happen to have tools for the branch's pull request (e.g. `gh`, or an
Azure DevOps MCP server), add the PR's comment threads to the set too; don't post to the PR.

## Step 3 — Tests (unless `--no-tests`)

Find the repo's test commands in its docs (`AGENTS.md`, `CLAUDE.md`, `README*`, `CONTRIBUTING*`)
or manifests (`package.json` scripts, `*.sln`/`*.slnx` → `dotnet test`, `pubspec.yaml` →
`flutter test`, `pyproject.toml`/`pytest.ini` → `pytest`, `go.mod` → `go test ./...`,
`Cargo.toml` → `cargo test`, `Makefile` targets). Prefer documented commands. Run every suite the
repo has (in the background, in parallel with the review, if you can); capture pass/fail and the
first 1–3 failure messages of each failing suite. Don't install packages or edit files to make a
suite run; if a suite can't run, say why.

## Step 4 — Review

### Threshold for findings (give this verbatim to every reviewer, including yourself)

> A finding qualifies ONLY if at least one is true:
> 1. It's a bug or correctness issue.
> 2. It's a security issue.
> 3. It violates a rule documented in the repo's `CLAUDE.md`, `AGENTS.md`, or skill/rule docs.
> 4. It would cause a concrete future problem: perf regression, data loss, breaking change, or test fragility.
>
> Every finding needs a concrete scenario: the inputs, state or timing that make the code
> misbehave, and the wrong result (or, for a convention, the quoted rule and the line that breaks it).
>
> **Severity tiers:**
> - **Critical** — would block merge: bug, security, data loss.
> - **Major** — should be fixed before merge: significant correctness/perf issue or documented-convention violation.
> - **Minor** — nice to fix, not blocking: small refactor, missing edge-case test.
> - **Nit** — cosmetic. EXCLUDE entirely; `--all` does not surface them.
>
> **DO NOT FLAG (these are noise that drives churn between runs):**
> - "Consider extracting this into a helper" without a concrete reason.
> - "Add a comment explaining X" unless the code is genuinely non-obvious AND a future reader would be confused without it.
> - "Rename for clarity" when the current name is reasonable.
> - "Add JSDoc / XML-doc comments" on internal-only code.
> - Style or formatting not enforced by a linter.
> - "Could be more functional/idiomatic."
> - Anything that mirrors an established choice in the surrounding code.
> - Speculation about hypothetical future requirements.
> - Anything already raised in the existing review or PR threads — unless the issue has materially worsened.
>
> Be honest about uncertainty. If you suspect a bug but can't confirm it from the code, label it "possible" and ask the developer to verify, rather than asserting it.
>
> Findings should be developer-facing: assume the reader wrote the code and is competent. No preamble, no praise, no caveats — just the line.

Candidate findings use this format, one per line (the dependency review uses its own table):

```
SEVERITY | path/to/file.ext:LINE | one-sentence description | concrete consequence if not fixed
```

### Review dimensions

Read the diff and the full files around it yourself; don't rely on summaries.

1. **Correctness & logic** — bugs, null/undefined handling, races, missed edge cases (empty
   collections, concurrent access), regressions in adjacent code, intent vs. implementation. Use
   these angles:
   - Line by line: read every hunk, then the enclosing function (bugs in unchanged lines of a
     touched function are in scope). For each line ask what input, state, timing or platform
     makes it wrong: inverted conditions, off-by-one, missing `await`, falsy-zero checks,
     copy-paste with the wrong variable, swallowed errors.
   - Removed behavior: for every deleted or replaced line, name the invariant it enforced and find
     where the new code re-establishes it; if nowhere, that's a candidate (removed guard, dropped
     error path, narrowed validation, deleted test of a real case).
   - Callers and callees: for each changed function, find its callers and check for new
     preconditions, changed return shapes, new exceptions, ordering dependencies.
   - Language pitfalls of the diff's languages, and wrappers (caches, proxies, adapters) that
     must forward every method to the wrapped object.
2. **Security** — auth, input validation at boundaries, injection (SQL / XSS / command / path),
   secrets in code, deserialization, CSRF, authorization gaps, unsafe handling of user data, races
   with security implications.
3. **Performance** — N+1 queries, expensive work inside loops or on hot paths, missing indexes for
   new query patterns, read-only ORM queries that track entities needlessly, unnecessary
   frontend re-renders, missing memoization of expensive computations.
4. **Project conventions** — read the `CLAUDE.md` and `AGENTS.md` files at the repo root and in
   ancestor folders of changed files, and the repo's skill or rule docs that match the touched
   areas (e.g. `.claude/skills/`, `.cursor/skills/`, `.cursor/rules/`, `.agents/skills/`,
   `.github/copilot-instructions.md`). Flag a violation only when you can quote the rule.
5. **Dependencies** — look for changes to dependency manifests and lockfiles: `package.json`,
   `yarn.lock`, `package-lock.json`, `pnpm-lock.yaml`, `*.csproj` `<PackageReference>`,
   `Directory.Packages.props`, `pubspec.yaml`/`pubspec.lock`, `requirements*.txt`,
   `pyproject.toml`, `poetry.lock`, `go.mod`, `Cargo.toml`, `Gemfile`, Dockerfiles and tool
   version files. If the repo documents a dependency policy (search its docs and skills for
   "dependency" or "license"), follow it. Otherwise, for every new direct dependency or direct
   version bump, check: an existing dependency or the standard library doesn't already solve it;
   it meets a current need (not speculative); first published more than 12 months ago; more than
   one maintainer or backed by an organization; released within the last 12 months; healthy
   download counts for its ecosystem; a license the project can use (MIT/Apache-2.0/BSD/ISC are
   fine; MPL-2.0 with care; flag GPL/AGPL/LGPL/SSPL/custom); the new version has been out for
   more than 72 hours; it comes from the registry the lockfile uses. Output one table, not
   per-line findings:

   ```
   | Package | Direction | Old → New | Soak | Maintainers | License | Concerns |
   ```

   plus a one-line verdict per package (✓ ok, ⚠ verify, ✗ block). Summarize transitive-only
   lockfile churn in one line.

**Default (single context):** work through the five dimensions yourself, in order. Then re-check
each candidate against the code and drop any you can't back with a concrete scenario or a quoted
rule.

**Thorough mode:** if you can launch subagents (e.g. Claude Code's Agent tool or VS Code's
`runSubagent` tool), launch five reviewers in parallel, one per dimension, and brief each like a
colleague: the merge-base SHA and the diff commands from Step 1, the `--numstat` summary, the
user's context, the already-raised set, the threshold verbatim, and the output format. They read
the diff and files themselves; don't pre-summarize. An empty answer is valid. When they return,
run one verifier per Critical or Major candidate (in parallel) that gets the candidate, the diff
and the relevant files, and answers exactly one of: **CONFIRMED** (names the triggering
inputs/state and the wrong result, quoting the line), **PLAUSIBLE** (the mechanism is real, the
trigger is uncertain; says what would confirm it) or **REFUTED** (the code doesn't say that, or a
guard elsewhere handles it, quoting the line). Keep CONFIRMED and PLAUSIBLE; label PLAUSIBLE ones
"possible". Finally, make one more pass as a fresh reviewer who has the list, looking only for
what's missing: moved or extracted code that dropped a guard, setup/teardown asymmetry in tests,
flipped config defaults. Without subagents, do all of these passes yourself, in sequence, and say
so in the summary.

### Grouping (in parallel with the reviewers, or after your own review)

Read enough context to see which class and method each change is in, so that you can group the
changes functionally:

Group the changes: partition them by apparent independence, so that unrelated or tenuously related
changes are in different groups; one file's changes may span groups, and a frontend change and a
backend change may share a group. Post the groups with review_set_groups: give each group an id, a
name (a short heading) and a short markdown summary of what its changes do, and list every changed
file with its groups. For a file in more than one group, give each of its groups `ranges`: the
working-tree lines (1-based, inclusive) of that group's changes in the file; for removed lines, give
the working-tree line just above or below where they were. A change that the ranges of several
groups overlap appears in each of those groups; a change that no range covers appears in all of the
file's groups. Calling review_set_groups again replaces the groups.

(Branch Review Studio then lists the groups, smallest first, each with its summary and files, and
each group's diffs show only that group's changes.)

## Step 5 — Merge, filter and group the findings

1. Combine the findings (the dependency table is handled separately in Step 7).
2. Deduplicate: collapse near-duplicates that point at the same `file:line` or describe the same
   root issue; prefer the more specific wording.
3. Drop anything covered by an already-raised thread — that's the cross-run convergence mechanism.
4. Assign findings to the groups from Step 4.
5. Within each group, sort by severity (Critical → Major → Minor), then file path, then line.
6. By default keep Critical + Major only. If Minor findings exist, end the list with
   `(N Minor findings hidden — re-run with --all to see them)`.
7. Nits are dropped entirely, regardless of `--all`.

## Step 6 — Post to Branch Review Studio

If the tools are available, post without asking (it only writes to the developer's local review):

- `review_comment` for each kept finding: `file` (repo-relative), `line` (and `endLine` for a
  range), `severity`, and a markdown `body` with the description and its concrete consequence.
  Line numbers refer to the working-tree file; for removed code, use `side: "base"` and line
  numbers in the merge-base version.
- `review_set_groups` with the groups from Step 4 (see Grouping there). If its result lists a
  range that overlaps no change, or a change that no range covers although you meant to assign it,
  correct the ranges and call it again.
- `review_finish` with a markdown summary: tests, branch tracking, dependency verdicts, and one
  line per group with its finding counts.

## Step 7 — Present the results in chat

First the group-agnostic facts:

1. Failing tests, with up to 3 failure messages per suite.
2. **Branch & tracking**, e.g. `On feature/foo — up to date with develop ✓` or
   `feature/foo — 5 commits behind develop`.
3. **Dependency changes**: the table, if any manifest changed. Lead with ✗ rows, and close with a
   one-line summary like `3 new direct deps, 2 bumps — 4 ✓, 1 ⚠ verify (x bump within 72h soak window)`.

Then for each group, in this order:

1. **Code summary** (below)
2. **Findings**, by severity, numbered, with clickable `path:line` links
3. **What's done well**: one or two lines, only if there's something genuine to say

End with `Posted N threads to Branch Review Studio.` if you posted.

### Code summary

Present each changed file as a `path:line` link followed by a quasi-diff. Show the parent nodes of
changes (e.g. the containing class or function) with minimal redaction, but collapse long blocks
of changes into prose or pseudocode summaries, e.g.

**src/Project/Subfolder/ExampleClass.cs:51-205**

```cs
 public class ExampleClass : BaseClass
 ...
+    public void CompleteUnredactedNameOfNewMethod(string argument1, int argument2)
+    {/* what the method does */}
 ...
     public int ExistingMethod(Dictionary<SomeEnum, string> argument1, SomeEnum argument2, ...
     {/*
         original behavior in brief
-        removed behavior
+        added behavior
         more original behavior
-+       changed behavior, e.g. `return x` became `return y`
     */}
 ...
-    public List<int> RemovedPropRepeatedVerbatimBecauseItsCodeIsShort { get; set; }
```

If many files (e.g. lockfiles) have basically the same changes, give a representative example and
only links for the others.

## Answering a thread

When a prompt asks you to answer review thread `<id>` (Branch Review Studio's **Ask Agent** sends
such prompts), reply with `review_reply` (`threadId`, `body`). Change code only if the developer
asks you to, and then summarize your edits in the reply. If the developer's point settles the
thread, you may call `review_resolve` instead, with a `note`. `review_list` shows threads with all
their comments.
