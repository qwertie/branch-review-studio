# Branch Review Studio: guide

A VS Code extension for reviewing a branch before it is merged, similar to a pull-request review
UI, except that the comment threads are exchanged with AI agents (Claude Code or OpenAI Codex)
rather than humans.

- The **Branch Review** view (Activity Bar) lists every file whose *working-tree* content differs
  from `git merge-base <base> HEAD`, including uncommitted and untracked files, no matter how many
  commits the branch has. `<base>` is `origin/develop` if it exists, else `develop`. A new review
  gets its base branch from the setting `branchReviewStudio.baseBranch` (or from `review_begin`'s
  `baseBranch` argument) and keeps it until you run **Change Base Branch…**.
- Clicking a file opens a diff editor (merge-base vs. working file). The modified side is the real
  file, so you can edit it in place. **Open All Changes** opens all files in one multi-diff editor.
- If the reviewing agent posts groups of related changes, the view lists the files under their
  groups, smallest group first, and each group's diffs show only that group's changes (see
  "Groups of related changes" below).
- Review comments appear as comment threads (VS Code Comments API) in the diff editor, in normal
  editors, and in the Comments panel. You can reply, resolve, reopen, delete, and start new threads
  on changed files.
- **Switch Branch…** opens the worktree of the branch you pick, creating a worktree first if there
  is none. Reviews are stored per branch, so each worktree window shows its own branch's review.
- Agents (Claude Code, Codex) post review findings as threads through the extension's MCP server
  (`review_begin`, `review_comment`, `review_set_groups`, `review_reply`, `review_resolve`,
  `review_list`, `review_finish`). `review_begin`'s result explains how to post findings and
  groups, so a repo's own review command needs to say only "call review_begin and follow the
  instructions it returns". The server records which session posted each thread: Claude Code's
  session id (`CLAUDE_CODE_SESSION_ID`) or Codex's thread id (which Codex sends with every tool
  call).
- **Ask Agent** (next to **Reply** in a thread) saves your message and sends it, with the thread's
  context, to an agent: by default as a fork of the session that wrote the review, with the agent
  that ran it (`claude --resume <id> --fork-session` or `codex fork <id>`, which reuses its prompt
  cache), or as a fresh session of either agent; in a terminal or in the background.
- The **Settings and Integrations** button (gear) in the view's title bar opens the Branch Review
  Studio panel: how to start a review, the base branch, and the status of each integration.

## Install (per user)

Nothing in your repos needs to change, and coworkers who don't install it are unaffected.

1. Build the package: `npm install`, then `npm run package`. This creates
   `branch-review-studio-<version>.vsix`.
2. Install it: `code --install-extension branch-review-studio-<version>.vsix --force`, then reload
   VS Code.
3. Click **Install MCP Server and Skill** for each agent you use in the Branch Review Studio panel
   (gear button), or run the command **Branch Review Studio: Install MCP Server and Skill (Claude
   Code, Codex)**, which installs for every agent whose CLI it finds. It requires `node` on PATH.
   Installing copies the server to `~/.branch-review-studio/mcp-server.js` (a stable path, so
   extension updates don't break the registration; the extension refreshes this copy when it
   changes), registers it, and copies `skills/branch-review-studio/SKILL.md` into the agent's
   skill folder:
   - Claude Code: `claude mcp add --scope user branch-review-studio -- node <that path>`, which
     adds an entry under `mcpServers` in `~/.claude.json`; skill in
     `~/.claude/skills/branch-review-studio/`.
   - Codex: `codex mcp add branch-review-studio -- node <that path>`, which adds a
     `[mcp_servers.branch-review-studio]` table (`command` and `args`) to `~/.codex/config.toml`.
     The Codex CLI, the Codex VS Code extension and the Codex app all read that file. Skill in
     `~/.agents/skills/branch-review-studio/`.
4. To remove them, click **Uninstall** in the panel, or run **Branch Review Studio: Uninstall MCP
   Server and Skills** (or run `claude mcp remove --scope user branch-review-studio` and
   `codex mcp remove branch-review-studio`, and delete the folders above).

## How to run a review connected to the extension

The Branch Review Studio panel (gear button) shows these steps too.

1. Prerequisite: the review tools (the `branch-review-studio` MCP server) must be registered with
   the agent you'll use (see Install, step 3). The skill is recommended: it is a full
   branch-review workflow (see below). Without it, the tools' descriptions explain the essentials.
2. Start the review: open Claude Code (CLI, VS Code extension or T3 Code) or Codex (CLI, VS Code
   extension or app) in the branch's worktree folder, then run the skill
   (`/branch-review-studio` in Claude Code, `$branch-review-studio` in Codex) or paste the review
   prompt that the panel's **Copy Review Prompt** button copies: "Use the branch-review-studio
   skill to review branch `feature/x` against `develop`. If you don't have that skill, call
   review_begin (`branch-review-studio` MCP tools) and follow its instructions." The skill reviews in a
   single context; add "be thorough" (or `--thorough`) for a review by parallel sub-agents, which
   costs several times as many tokens.
   If the repo has its own review command that posts to Branch Review Studio (e.g. Barreleye's
   `/branch-review`), you can use that instead.
3. The agent's findings appear as comment threads in the Branch Review view as it posts them.
   Answer with **Reply**, or with **Ask Agent** (see Usage, step 5).

The skill (`skills/branch-review-studio/SKILL.md`, based on Barreleye's `/branch-review` command)
fetches the base branch, checks whether the branch is behind it, runs the repo's tests (found in
its docs and manifests), reviews correctness, security, performance, project conventions (from
`CLAUDE.md`, `AGENTS.md` and skill/rule docs) and dependency changes, skips findings that existing
threads already raise, posts Critical and Major findings (plus Minor with `--all`) as threads,
posts groups of related changes, and summarizes the changes and findings in chat. Options:
`--all`, `--no-tests`, `--base <branch>`, `--thorough`, plus free-form context. It never switches
branches or stashes.

## Usage

1. Open a git repo (or one of its worktrees) in VS Code and click the Branch Review icon in the
   Activity Bar. The header row shows `<branch> vs <baseRef> @ <merge-base>`.
2. To compare against a different branch (e.g. `main` instead of `develop`), click the
   **Change Base Branch…** button (two arrows) in the view's title bar or on the header row, and
   pick a branch; the current base is listed first, then `develop`, `main` and `master`. The choice
   is saved in the branch's review (which is created if needed), so it applies to this branch only,
   and Claude Code's review tools use it too; the `branchReviewStudio.baseBranch` setting doesn't
   change. Threads on the base side of the diff were anchored to the old merge-base, so they may
   move or show as outdated (you're asked first if there are any).
3. The extension never fetches on its own. To update the base, run **Fetch Base Branch** (view
   `...` menu), which runs `git fetch origin <baseBranch>`.
4. Ask an agent for a review (see "How to run a review connected to the extension" above). The
   threads appear when the agent saves them.
5. To comment, hover over a line of a changed file (either side of the diff) and click `+`.
   Type a message, then click **Reply** / **Add Comment** to just save it, or **Ask Agent** to also
   send it to an agent. Ask Agent lists, default first (Enter picks it), grouped by agent if both
   CLIs are installed: fork the review session in a terminal, fork it in the background (only
   with the agent that ran the review session, since neither agent can fork the other's
   sessions), then a fresh session in a terminal or in the background, for each agent. A fresh
   session gets the review summary and merge-base in its prompt.
   - A terminal runs the agent interactively (`claude` or `codex`) in the review session's folder.
   - A background run (`claude -p`, or `codex exec --json`) shows a status bar item, logs to the
     "Branch Review Studio" output channel, and if the agent doesn't answer with `review_reply`,
     posts its final message (or its error) as the answer. When a Codex run finishes and the
     Codex VS Code extension is installed, the notification offers **Continue in Codex**, which
     opens the new Codex thread in the Codex sidebar.
   - Permissions: the agent may call the review tools without asking; everything else follows the
     agent's usual permission rules. Claude Code gets `--allowedTools mcp__branch-review-studio`.
     Codex gets `-c` options that define the `branch-review-studio` server for that run (so it
     works even if you didn't register it) with `default_tools_approval_mode="approve"`; its
     sandbox and approval policy are unchanged, so `codex exec` runs in its default read-only
     sandbox. (Without that option, `codex exec` fails MCP calls: "MCP tool call requires
     approval, but approval policy is never".) So a background run can answer questions but
     can't edit files; ask in a terminal if you want edits.
   - The new session's id is recorded in the review: Claude Code's before it starts; Codex's when
     the background run reports it or when Codex calls a review tool.
   - If Claude Code hasn't been used in that folder before, it first asks whether you trust the
     folder.
6. To see the diff inline (interleaved) instead of side by side, use the diff editor's `...` menu >
   **Inline View**, or set `"diffEditor.renderSideBySide": false`. VS Code has no per-editor inline
   option, so this is your own user (or workspace) setting; the extension never changes it. Note that
   VS Code already switches to inline view when the editor is narrower than
   `diffEditor.renderSideBySideInlineBreakpoint` (900px) unless
   `diffEditor.useInlineViewWhenSpaceIsLimited` is false.
7. Sticky scroll (namespace/class/method lines pinned at the top) works in diff editors when
   `editor.stickyScroll.enabled` is true (the default). For C#, the C# extension's outline gives
   the best sticky lines; without a language extension, VS Code falls back to indentation, which
   pins `{` lines in Allman-style code.

Settings: `branchReviewStudio.baseBranch` (default `develop`),
`branchReviewStudio.worktreeRoot` (default: a sibling folder `<repoName>.worktrees` of the main
worktree), `branchReviewStudio.openWorktreeInNewWindow` (default false),
`branchReviewStudio.claudePath` (default: `claude.exe`/`claude` on PATH, then `~/.local/bin`),
`branchReviewStudio.codexPath` (default: the Codex CLI bundled with the Codex VS Code extension
`openai.chatgpt` if installed, since it is usually newer than the one on PATH, else `codex` on PATH).

## Groups of related changes

A review can divide the branch's changes into groups of related changes, e.g. "Fix CSV quoting" and
"Rename `Widget` to `Gadget`", so that you can review one topic at a time.

- **Posting:** the agent calls `review_set_groups` with the groups (`id`, `name`, markdown
  `summary`) and, for each changed file, its groups. For a file in more than one group, it gives
  each group's `ranges`: the working-tree lines (1-based, inclusive) of that group's changes; for
  removed lines, the working-tree line just above or below where they were. Calling it again
  replaces the groups.
- **Freezing:** the tool then reads each listed file's hunks (`git diff -U0 <merge-base>`; a new or
  deleted file is one hunk, a binary file has none) and assigns each hunk to every group whose
  ranges overlap its new lines (a removal: the line above or below it). A hunk that only adds lines
  is split where the groups whose ranges include its lines change, so a new file can be divided
  among groups; other hunks stay whole, so they can belong to several groups. A hunk that no range overlaps is unassigned.
  The review JSON stores the hunks by merge-base line numbers (with their new lines where a view
  needs them), plus the merge-base, so later edits don't shift them. The tool's result lists
  ranges that overlap no change and changes that no range covers, so the agent can correct them.
- **Tree:** each group is a row with its name, size and number of files (tooltip: the summary),
  followed by its summary (dimmed) and its files, each with its threads. A file appears under every
  group whose view of it shows a change (one of the group's hunks or an unassigned hunk), and a file
  without hunks under every group listed for it; "partial" marks a file of which the group shows
  only some changes. Groups are sorted by size, smallest first, where size = the number of changed
  lines in the group's hunks (per hunk, the larger of its removed and added line counts, so a
  modified line counts once). Changed files that no group includes (e.g. files changed after the groups were
  posted) and unchanged files with threads are listed last, under **Ungrouped**. Grouped files
  that are no longer changed are hidden; a group left with no changes still appears (as "no
  changes", sorted first), so that a grouping mistake stands out. `review_set_groups` also tells
  the agent about changed files it put in no group. Without groups, the tree lists the files by
  path.
- **Diffs:** clicking a group opens its files in a multi-diff editor titled with the group's name;
  clicking a file under a group opens that group's view of the file. In a group's view, the left
  side is the merge-base version with the hunks that belong only to other groups applied, so the
  diff shows this group's hunks, unassigned hunks, and any changes made after the groups were
  posted. The right side is the real file, so editing and comment threads work as usual, but
  threads on the base side and new comments on the left side are available only in the whole-file
  diff (the diff button on the file's row, or **Open All Changes**).
- **Stale groups:** if the merge-base changes (e.g. after **Fetch Base Branch** or **Change Base
  Branch…**), the frozen hunks no longer apply, so the diffs show whole files and the group rows
  say "regroup: merge-base changed"; ask the agent to post the groups again.

## Branch Review Studio panel

The gear button in the Branch Review view's title bar (or the command **Branch Review Studio:
Settings and Integrations**) opens a panel in the editor area. (VS Code has no rich modal
dialogs, so it is a webview tab.) It shows:

- How to run a review connected to the extension, with a **Copy Review Prompt** button.
- The branch, its base branch (with a selector and **Change Base Branch**, which works like the
  command of that name) and the merge-base.
- One section per integration (Claude Code, Codex): the CLI's path and version, whether you are
  signed in (`claude auth status`, `codex login status`), whether the MCP server is registered
  (`claude mcp get`, `codex mcp get`), whether the skill is installed, for Codex whether the Codex
  VS Code extension is installed, and the last error from using the integration (Ask Agent
  launches, background runs that fail, terminals that exit with a non-zero code, install and
  uninstall), with its time. The last error is kept in VS Code's global extension state until the
  next successful use. **Install MCP Server and Skill** and **Uninstall** act on that agent only.
  The panel runs these checks when it opens and when you click **Re-check**.

## Files it creates

The extension and MCP server do not modify any tracked files in your repos. They write only:

- `<git-common-dir>/branch-review-studio/` (for example `D:\MyRepo\.git\branch-review-studio\`),
  which all worktrees of a repo share. Git ignores it because it is inside `.git`.
  - `README.txt` explains where the folder came from; it is safe to delete the whole folder.
  - `reviews/<branch>.json` holds one branch's review (branch name percent-encoded, e.g.
    `feature%2Fx.json`): its threads, sessions, summary and groups. Each file starts with a
    `"$comment"` explaining its origin.
  - `reviews/<branch>.json.lock` exists briefly while a review is being saved.
  - The folder is created when the first review or comment is saved.
- New worktrees, only when you create one with **Switch Branch…**.
- When you run the install commands: `~/.branch-review-studio/mcp-server.js`; for Claude Code,
  `~/.claude/skills/branch-review-studio/SKILL.md` and a `branch-review-studio` entry under
  `mcpServers` in `~/.claude.json` (written by `claude mcp add`); for Codex,
  `~/.agents/skills/branch-review-studio/SKILL.md` and a `[mcp_servers.branch-review-studio]`
  table in `~/.codex/config.toml` (written by `codex mcp add`).
- Ask Agent's Codex runs pass their settings as `-c` options and don't change
  `~/.codex/config.toml`. Codex keeps its threads in `~/.codex/sessions/` as usual.

## Development

- `npm run build` / `npm run watch`: bundle `dist/extension.js` and `dist/mcp-server.js` (esbuild)
- `npm test`: unit tests of `src/core/` and `src/mcp/` (vitest; git tests use temporary repos)
- `npm run typecheck`, `npm run package`
- `npm run sample-review -- <repo> [--force]`: writes a sample review for the repo's current branch
- `npm run smoke-test -- <repo>`: runs `scripts/smoke-test.ts` inside VS Code (throwaway profile)
  against a repo that has a sample review. With `BRS_SCREENSHOT_DIR=<folder>` it also saves
  screenshots of the Extension Development Host window (Windows only). With `BRS_SMOKE_ASK_AGENT=1`
  it also runs Ask Agent twice (fork in the background and in a terminal), which spends tokens.
  With `BRS_SMOKE_CODEX=1` it runs Ask Agent with Codex twice (a fresh background session that
  calls `review_begin`, then a background fork of it), which also spends tokens, and then removes
  the threads and sessions it added; `BRS_SMOKE_CODEX_PATH=<codex.exe>` picks the Codex CLI, since
  the throwaway profile lacks the Codex extension's bundled CLI.
  With `BRS_SMOKE_FRESH_REPO=1` and a repo without reviews, it checks lazy store creation instead.

See AGENTS.md for coding conventions.
