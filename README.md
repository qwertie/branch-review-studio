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
- Coming next (Phase B/C): an MCP server through which Claude Code posts review threads, and an
  "Ask Agent" action that sends a thread message to Claude Code as a fork of the review session.

## Install (per user)

Nothing in your repos needs to change, and coworkers who don't install it are unaffected.

1. Build the package: `npm install`, then `npm run package`. This creates
   `branch-review-studio-<version>.vsix`.
2. Install it: `code --install-extension branch-review-studio-<version>.vsix --force`, then reload
   VS Code.

## Usage

1. Open a git repo (or one of its worktrees) in VS Code and click the Branch Review icon in the
   Activity Bar. The header row shows `<branch> vs <baseRef> @ <merge-base>`.
2. The extension never fetches on its own. To update the base, run **Fetch Base Branch** (view
   `...` menu), which runs `git fetch origin <baseBranch>`.
3. To comment, hover over a line of a changed file (either side of the diff) and click `+`.
4. To see the diff inline (interleaved) instead of side by side, use the diff editor's `...` menu >
   **Inline View**, or set `"diffEditor.renderSideBySide": false`. VS Code has no per-editor inline
   option, so this is your own user (or workspace) setting; the extension never changes it. Note that
   VS Code already switches to inline view when the editor is narrower than
   `diffEditor.renderSideBySideInlineBreakpoint` (900px) unless
   `diffEditor.useInlineViewWhenSpaceIsLimited` is false.
5. Sticky scroll (namespace/class/method lines pinned at the top) works in diff editors when
   `editor.stickyScroll.enabled` is true (the default). For C#, the C# extension's outline gives
   the best sticky lines; without a language extension, VS Code falls back to indentation, which
   pins `{` lines in Allman-style code.

Settings: `branchReviewStudio.baseBranch` (default `develop`),
`branchReviewStudio.worktreeRoot` (default: a sibling folder `<repoName>.worktrees` of the main
worktree), `branchReviewStudio.openWorktreeInNewWindow` (default false).

## Files it creates

The extension does not modify any tracked files in your repos. It writes only:

- `<git-common-dir>/branch-review-studio/` (for example `D:\MyRepo\.git\branch-review-studio\`),
  which all worktrees of a repo share. Git ignores it because it is inside `.git`.
  - `README.txt` explains where the folder came from; it is safe to delete the whole folder.
  - `reviews/<branch>.json` holds one branch's review (branch name percent-encoded, e.g.
    `feature%2Fx.json`). Each file starts with a `"$comment"` explaining its origin.
  - `reviews/<branch>.json.lock` exists briefly while a review is being saved.
- New worktrees, only when you create one with **Switch Branch…**.

## Development

- `npm run build` / `npm run watch`: bundle `dist/extension.js` and `dist/mcp-server.js` (esbuild)
- `npm test`: unit tests of `src/core/` (vitest; git tests use temporary repos)
- `npm run typecheck`, `npm run package`
- `npm run sample-review -- <repo> [--force]`: writes a sample review for the repo's current branch
- `npm run smoke-test -- <repo>`: runs `scripts/smoke-test.ts` inside VS Code (throwaway profile)
  against a repo that has a sample review. With `BRS_SCREENSHOT_DIR=<folder>` it also saves
  screenshots of the Extension Development Host window (Windows only).

See AGENTS.md for coding conventions.
