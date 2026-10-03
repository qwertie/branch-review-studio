# Branch Review Studio

A VS Code extension for reviewing a branch before it is merged, similar to a pull-request review
UI, except that the comment threads are exchanged with AI agents (Claude Code) rather than humans.

- The **Branch Review** view (Activity Bar) lists every file whose *working-tree* content differs
  from `git merge-base <base> HEAD`, including uncommitted and untracked files, no matter how many
  commits the branch has. `<base>` is `origin/develop` if it exists, else `develop` (setting
  `branchReviewStudio.baseBranch`).
- Clicking a file opens a diff editor (merge-base vs. working file). The modified side is the real
  file, so you can edit it in place. **Open All Changes** opens all files in one multi-diff editor.
- Review comments appear as comment threads (VS Code Comments API) in the diff editor, in normal
  editors, and in the Comments panel. You can reply, resolve, reopen, delete, and start new threads
  on changed files.
- **Switch Branch…** opens the worktree of the branch you pick, creating a worktree first if there
  is none. Reviews are stored per branch, so each worktree window shows its own branch's review.
- Claude Code posts review findings as threads through the extension's MCP server
  (`review_begin`, `review_comment`, `review_reply`, `review_resolve`, `review_list`,
  `review_finish`).
- **Ask Agent** (next to **Reply** in a thread) saves your message and sends it, with the thread's
  context, to Claude Code: by default as a fork of the session that wrote the review
  (`claude --resume <id> --fork-session`, which reuses its prompt cache), or as a fresh session;
  in a terminal or in the background.

## Install (per user)

Nothing in your repos needs to change, and coworkers who don't install it are unaffected.

1. Build the package: `npm install`, then `npm run package`. This creates
   `branch-review-studio-<version>.vsix`.
2. Install it: `code --install-extension branch-review-studio-<version>.vsix --force`, then reload
   VS Code.
3. Run the command **Branch Review Studio: Install MCP Server for Claude Code**. It copies the
   server to `~/.branch-review-studio/mcp-server.js` (a stable path, so extension updates don't
   break the registration; the extension refreshes this copy when it changes) and runs
   `claude mcp add --scope user branch-review-studio -- node <that path>`. It requires `node` on
   PATH. Then accept its offer to install the Claude skill (or run **Install Claude Skill**), which
   copies `skills/branch-review-studio/SKILL.md` to `~/.claude/skills/branch-review-studio/`.
4. To remove both, run **Branch Review Studio: Uninstall MCP Server and Claude Skill** (or
   `claude mcp remove --scope user branch-review-studio` and delete the two folders above).

## Usage

1. Open a git repo (or one of its worktrees) in VS Code and click the Branch Review icon in the
   Activity Bar. The header row shows `<branch> vs <baseRef> @ <merge-base>`.
2. The extension never fetches on its own. To update the base, run **Fetch Base Branch** (view
   `...` menu), which runs `git fetch origin <baseBranch>`.
3. Ask Claude Code for a review, e.g. "Review this branch and post your findings with the
   branch-review-studio tools". The threads appear when Claude saves them.
4. To comment, hover over a line of a changed file (either side of the diff) and click `+`.
   Type a message, then click **Reply** / **Add Comment** to just save it, or **Ask Agent** to also
   send it to Claude Code. Ask Agent offers (default first; Enter picks it): fork the review
   session in a terminal, fork it in the background, fresh session in a terminal, fresh session in
   the background. A terminal runs `claude` interactively in the review session's folder. A
   background run (`claude -p`) shows a status bar item, logs to the "Branch Review Studio"
   output channel, and if Claude doesn't answer with `review_reply`, posts its final message as
   the answer. Either way, Claude may call the review tools without asking permission, and the new
   session's id is recorded in the review. If Claude Code hasn't been used in that folder before,
   it first asks whether you trust the folder.
5. To see the diff inline (interleaved) instead of side by side, use the diff editor's `...` menu >
   **Inline View**, or set `"diffEditor.renderSideBySide": false`. VS Code has no per-editor inline
   option, so this is your own user (or workspace) setting; the extension never changes it. Note that
   VS Code already switches to inline view when the editor is narrower than
   `diffEditor.renderSideBySideInlineBreakpoint` (900px) unless
   `diffEditor.useInlineViewWhenSpaceIsLimited` is false.
6. Sticky scroll (namespace/class/method lines pinned at the top) works in diff editors when
   `editor.stickyScroll.enabled` is true (the default). For C#, the C# extension's outline gives
   the best sticky lines; without a language extension, VS Code falls back to indentation, which
   pins `{` lines in Allman-style code.

Settings: `branchReviewStudio.baseBranch` (default `develop`),
`branchReviewStudio.worktreeRoot` (default: a sibling folder `<repoName>.worktrees` of the main
worktree), `branchReviewStudio.openWorktreeInNewWindow` (default false),
`branchReviewStudio.claudePath` (default: `claude.exe`/`claude` on PATH, then `~/.local/bin`).

## Files it creates

The extension and MCP server do not modify any tracked files in your repos. They write only:

- `<git-common-dir>/branch-review-studio/` (for example `D:\MyRepo\.git\branch-review-studio\`),
  which all worktrees of a repo share. Git ignores it because it is inside `.git`.
  - `README.txt` explains where the folder came from; it is safe to delete the whole folder.
  - `reviews/<branch>.json` holds one branch's review (branch name percent-encoded, e.g.
    `feature%2Fx.json`). Each file starts with a `"$comment"` explaining its origin.
  - `reviews/<branch>.json.lock` exists briefly while a review is being saved.
  - The folder is created when the first review or comment is saved.
- New worktrees, only when you create one with **Switch Branch…**.
- When you run the install commands: `~/.branch-review-studio/mcp-server.js`,
  `~/.claude/skills/branch-review-studio/SKILL.md`, and a `branch-review-studio` entry under
  `mcpServers` in `~/.claude.json` (written by `claude mcp add`).

## Development

- `npm run build` / `npm run watch`: bundle `dist/extension.js` and `dist/mcp-server.js` (esbuild)
- `npm test`: unit tests of `src/core/` and `src/mcp/` (vitest; git tests use temporary repos)
- `npm run typecheck`, `npm run package`
- `npm run sample-review -- <repo> [--force]`: writes a sample review for the repo's current branch
- `npm run smoke-test -- <repo>`: runs `scripts/smoke-test.ts` inside VS Code (throwaway profile)
  against a repo that has a sample review. With `BRS_SCREENSHOT_DIR=<folder>` it also saves
  screenshots of the Extension Development Host window (Windows only). With `BRS_SMOKE_ASK_AGENT=1`
  it also runs Ask Agent twice (fork in the background and in a terminal), which spends tokens.
  With `BRS_SMOKE_FRESH_REPO=1` and a repo without reviews, it checks lazy store creation instead.

See AGENTS.md for coding conventions.
