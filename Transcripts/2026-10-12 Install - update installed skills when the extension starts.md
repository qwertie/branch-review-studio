# Install: update installed skills when the extension starts

## Planning phase

This task was delegated to a subagent by the main agent; the user's request as relayed (verbatim):

> Problem: the extension auto-updates the installed MCP server when the extension version changes
> (`updateInstalledServerIfOutdated` in src/extension/install.ts, called on activation from
> src/extension/extension.ts line ~52), but it never updates the installed skill copies
> (`installSkillForAgent` copies the bundled skills/branch-review-studio/SKILL.md into each agent's
> skill dir, `integration.getSkillDir(os.homedir())`, e.g. ~/.claude/skills/branch-review-studio).
> So after upgrading to 1.1.0 the user's Claude Code still had the 1.0 skill, which has different
> `--all` semantics (1.0: `--all` shows Minor; 1.1: Minor shown by default, `--no-minor` hides,
> `--all` adds Nits). The user got told "re-run with --all to see Minor findings" while on 1.1.
>
> Fix: on activation, for every agent integration (in `agentIntegrations`) whose skill is already
> installed (SKILL.md exists in its skill dir), replace it if its contents differ from the bundled
> copy, and log it to the output channel — the same pattern as updateInstalledServerIfOutdated
> (consider generalizing into one function, e.g. `updateInstalledFilesIfOutdated`). Don't install a
> skill for an agent that doesn't have one (respect uninstall). Don't require the agent CLI to be
> found for this. Errors should be logged, not thrown. Also check whether docs (README.md,
> docs/guide.md, release-notes-ish text) tell users they must click "Install MCP Server and Skill"
> again after upgrading; if so, update that wording to say it's automatic now.
>
> Add unit tests (vitest) if the logic can be tested without VS Code (e.g. factor the
> compare-and-copy into src/core with injected paths). Keep VS Code test launches rare: each one
> pops a window over the user's work. Develop against `npx tsc --noEmit` and vitest; run the VS
> Code smoke test at most once at the end (a Ctrl+Enter failure when the window lacks focus is a
> known flake).
>
> When done: commit (message style like existing log, e.g. "Install: ..."; end the commit message
> with "Co-Authored-By: ..."), then `npm run package` and `code --install-extension <the new vsix>
> --force`. Don't bump the version, push, or make a release. Note: I already manually copied the
> 1.1.0 SKILL.md into C:\Users\qwert\.claude\skills\branch-review-studio, so the user's copy is
> current now; don't touch it. Report: commit hash, what changed, test results, and anything left
> open.

Plan (not confirmed with the user; the request was specific enough to proceed):

- src/core/files.ts: `updateFileIfOutdated(installedPath, sourcePath): Promise<boolean>`, which
  overwrites an existing file whose contents differ and never creates a missing one.
- src/extension/install.ts: replace `updateInstalledServerIfOutdated` with
  `updateInstalledFilesIfOutdated(context, log)`, which runs `updateFileIfOutdated` for the server
  and for each `agentIntegrations` entry's SKILL.md, logging updates and errors per file. New
  helper `getInstalledSkillPath`, shared with `installSkillForAgent`.
- src/extension/extension.ts: call it on activation.
- Tests T1-T3 in src/core/files.test.ts: replaces a differing copy; leaves an identical copy
  untouched (mtime unchanged); doesn't create a missing copy.
- Docs: README.md says nothing about upgrading. docs/guide.md's install section mentioned only the
  server refresh; the settings panel told users to click Install MCP Server and Skill to update a
  differing skill copy. Update both.

## Questions and assumptions

- Assumed (unasked): no ticket number; commit without one, as the user asked for a commit.
- Assumed (unasked): overwriting a user's hand-edited installed SKILL.md on every start is
  acceptable, since the request says to replace it whenever its contents differ (the server copy
  already behaves this way).

## End phase

- Tests: `npx tsc --noEmit` passes; `npx vitest run` passes (21 files, 173 tests), including
  T1-T3, which failed before `updateFileIfOutdated` existed.
- Smoke test (`npm run smoke-test -- D:/brs-sandbox/Barreleye`), run once: all visible checks
  passed, including the settings panel's VS Code Chat section, but one check failed whose name was
  cut off from the captured output; it was not re-run, to avoid another window popping up.
- Second pass (subagent): merged two test path helpers into `getInstalledPath`; noted that hand
  edits to installed skills get overwritten (C1), that a panel opened right at startup may briefly
  say the skill differs (C2), and a Markdown continuation quirk in the guide (C3, fixed for the new
  paragraph by adding a blank line).
