# Branch Review Studio: guide

A VS Code extension for reviewing a branch before it is merged, similar to a pull-request review
UI, except that the comment threads are exchanged with AI agents (Claude Code, OpenAI Codex or
VS Code's own chat agent) rather than humans.

- The **Branch Review** view (Activity Bar) lists every file whose *working-tree* content differs
  from `git merge-base <base> HEAD`, including uncommitted and untracked files, no matter how many
  commits the branch has. `<base>` is `origin/develop` if it exists, else `develop`. A new review
  gets its base branch from the setting `branchReviewStudio.baseBranch` (or from `review_begin`'s
  `baseBranch` argument) and keeps it until you run **Change Base Branch…**.
- Clicking a file opens a diff editor (merge-base vs. working file). The modified side is the real
  file, so you can edit it in place. **Open All Changes** opens all files in one multi-diff editor,
  in the order of the view.
- If the reviewing agent posts groups of related changes, the view lists the files under their
  groups, smallest group first, and each group's diffs show only that group's changes (see
  "Groups of related changes" below).
- Each file lists its threads, sorted by their current line (a thread on the base side by where
  its line appears in the diff), with severity, open/resolved state and the start of the first
  comment. Clicking a thread opens the file's diff and scrolls to the thread, so that its last
  line and the thread's comments (which VS Code shows below that line) are visible. **Unresolved
  only** (in the view's header) hides resolved threads.
- **Previous Thread** / **Next Thread**, **Previous Unresolved Thread** / **Next Unresolved
  Thread** and **Go to Thread…** (a searchable list) are buttons in the editor's title bar (top
  right) while the review has threads, and commands in the Command Palette. They follow the view's
  order, starting from the cursor in the active editor if it shows a review file (in a diff, a
  group's view or Open All Changes), else from the last thread you went to, and wrap around at the
  end with a message in the status bar.
- Review comments appear as comment threads (VS Code Comments API) in the diff editor, in normal
  editors, and in the Comments panel. You can reply, resolve, reopen, delete, and start new threads
  on changed files.
- To delete a thread, click the trash button in its title bar, or the trash button that its row in
  the Branch Review view shows when you hover over it. **Delete Resolved Threads** (a button in the
  view's header, and in the view's `...` menu) deletes all resolved threads. **Clear Review** (view
  `...` menu) deletes everything in the branch's review except its base branch: threads, summary,
  groups of related changes, and the recorded agent sessions (so Ask Agent can no longer fork the
  review session). Each asks for confirmation first, and each is also a command in the Command
  Palette.
- **Switch Branch…** opens the worktree of the branch you pick, creating a worktree first if there
  is none. Reviews are stored per branch, so each worktree window shows its own branch's review.
- Agents (Claude Code, Codex, VS Code's chat) post review findings as threads through the
  extension's MCP server (`review_begin`, `review_comment`, `review_set_groups`, `review_reply`,
  `review_resolve`, `review_list`, `review_finish`). `review_begin`'s result explains how to post
  findings and groups, so a repo's own review command needs to say only "call review_begin and
  follow the instructions it returns". The server records which session posted each thread:
  Claude Code's session id (`CLAUDE_CODE_SESSION_ID`), Codex's thread id (which Codex sends with
  every tool call) or VS Code's chat id (`vscode.conversationId`, which VS Code sends with every
  tool call).
- A comment box (of a new thread or of a reply) has three buttons. **Send to** _agent_ (e.g.
  **Send to Claude Code**; the highlighted button, which Ctrl+Enter clicks) saves your message and
  sends it, with the thread's context, to the default agent: unless you change the **Ask Agent
  defaults**, the agent that ran the review, as a fork of the session that wrote the review
  (`claude --resume <id> --fork-session` or `codex fork <id>`, which reuses its prompt cache), in a
  terminal. **Send to…** (Ask Agent) lets you pick: a fork of the review session or a fresh session
  of either agent, in a terminal or in the background, or a new chat in VS Code's chat (see "VS Code
  Chat" below). **Add Note to Self** saves the message without sending it.
- The **Settings and Integrations** button (gear) in the view's header opens the Branch Review
  Studio panel: how to start a review, the Ask Agent defaults, the base branch, and the status of
  each integration.

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
   VS Code's chat needs no install (see "VS Code Chat" below).
4. To remove them, click **Uninstall** in the panel, or run **Branch Review Studio: Uninstall MCP
   Server and Skills** (or run `claude mcp remove --scope user branch-review-studio` and
   `codex mcp remove branch-review-studio`, and delete the folders above).

## How to run a review connected to the extension

The Branch Review Studio panel (gear button) shows these steps too.

1. Prerequisite: the review tools (the `branch-review-studio` MCP server) must be registered with
   the agent you'll use (see Install, step 3; VS Code's chat needs nothing). The skill is
   recommended: it is a full branch-review workflow (see below). Without it, the tools'
   descriptions explain the essentials.
2. Start the review: open Claude Code (CLI, VS Code extension or T3 Code) or Codex (CLI, VS Code
   extension or app) in the branch's worktree folder, then run the skill
   (`/branch-review-studio` in Claude Code, `$branch-review-studio` in Codex) or paste the review
   prompt that the panel's **Copy Review Prompt** button copies: "Use the branch-review-studio
   skill to review branch `feature/x` against `develop`. If you don't have that skill, call
   review_begin (`branch-review-studio` MCP tools) and follow its instructions." Or, in VS Code's
   chat in agent mode, pick the **Branch Reviewer** agent or type `/branch-review-studio` (see "VS
   Code Chat" below). The skill reviews in a single context; add "be thorough" (or `--thorough`)
   for a review by parallel sub-agents, which costs several times as many tokens.
   If the repo has its own review command that posts to Branch Review Studio (e.g. a
   `/branch-review` command), you can use that instead.
3. The agent's findings appear as comment threads in the Branch Review view as it posts them.
   Answer with **Send to** _agent_ or **Send to…** (see Usage, step 5).

The skill (`skills/branch-review-studio/SKILL.md`, based on an in-house `/branch-review` command)
fetches the base branch, checks whether the branch is behind it, runs the repo's tests (found in
its docs and manifests), reviews correctness, security, performance, project conventions (from
`CLAUDE.md`, `AGENTS.md` and skill/rule docs) and dependency changes, skips findings that existing
threads already raise, posts Critical and Major findings (plus Minor with `--all`) as threads,
posts groups of related changes, and summarizes the changes and findings in chat. Options:
`--all`, `--no-tests`, `--base <branch>`, `--thorough`, plus free-form context. It never switches
branches or stashes.

## Usage

1. Open a git repo (or one of its worktrees) in VS Code and click the Branch Review icon in the
   Activity Bar. The view's header shows `<branch> vs <baseRef> <merge-base>` and buttons for
   **Change Base Branch…**, **Switch Branch…**, **Open All Changes**, **Delete Resolved Threads**,
   **Refresh** and **Settings and Integrations**. Hover over a file for buttons that open the file
   itself or its whole-file diff, and over a thread for a button that deletes it.
   The view is a webview. As in VS Code's trees, Tab moves to the list of files as a whole, and the
   arrow keys, Home, End and Enter work on its rows. The view keeps the groups and files you
   collapsed while VS Code runs.
2. To compare against a different branch (e.g. `main` instead of `develop`), click the
   **Change Base Branch…** button (two arrows) in the view's header, and
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
   Type a message, then click one of the comment box's buttons (a reply in a thread has the same
   buttons):
   - **Send to** _agent_, the highlighted button (Ctrl+Enter clicks it), saves the message and
     sends it as the **Ask Agent defaults** say: the settings `branchReviewStudio.askAgent.agent`
     (**Same agent as the review**, the default: the agent that ran the session that opened the
     thread, else the latest review session; if there is none or its agent isn't available,
     Claude Code, else the first available one; or **Claude Code**, **Codex**, **VS Code Chat**, or
     **Ask each time**), `branchReviewStudio.askAgent.session` (**Fork the review session when
     possible**, the default: if that agent ran it and its folder still exists; or **Fresh
     session**) and `branchReviewStudio.askAgent.runIn` (**Terminal**, the default, or
     **Background**; VS Code Chat always gets a new chat). The button names the agent, e.g. **Send to
     Claude Code**, and so differs between threads whose review sessions ran in different agents.
     With **Ask each time**, or if the agent isn't available (e.g. its CLI wasn't found), the button
     is **Send to Agent…**, which works like **Send to…** and says why the agent isn't available.
     The Branch Review Studio panel (gear) has dropdowns for these settings, which you can also set
     per workspace in VS Code's settings.
   - **Send to…** (Ask Agent) saves the message and lists the ways to send it, default first (Enter
     picks it), grouped by agent if both CLIs are installed: fork the review session in a terminal,
     fork it in the background (only with the agent that ran the review session, since neither
     agent can fork the other's sessions), then a fresh session in a terminal or in the background,
     for each agent, and last, **VS Code Chat (agent mode)**, a new chat in VS Code's chat (see "VS
     Code Chat" below).
   - **Add Note to Self** saves the message without sending it.

   How the agents run, with either Send button (a fresh session gets the review summary and
   merge-base in its prompt):
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
`openai.chatgpt` if installed, since it is usually newer than the one on PATH, else `codex` on PATH),
`branchReviewStudio.askAgent.agent`, `branchReviewStudio.askAgent.session` and
`branchReviewStudio.askAgent.runIn` (what **Send to** _agent_ does; see Usage, step 5).

## VS Code Chat

VS Code's chat in agent mode (VS Code's own "Local" agent) can run branch reviews and answer
threads with the extension's MCP tools, using the models you've enabled in VS Code: GitHub
Copilot's, API keys you add with **Manage Models** in the chat's model picker, or other providers'
models. A Claude Code or ChatGPT subscription can't back these models. Nothing needs to be
installed:

- **MCP server:** the extension registers its MCP server with VS Code
  (`vscode.lm.registerMcpServerDefinitionProvider`). VS Code runs `dist/mcp-server.js` from the
  extension's folder with its own Node.js (`Code.exe` with `ELECTRON_RUN_AS_NODE=1`, so `node`
  needn't be on PATH), in the repo folder that the Branch Review view shows (in a multi-root
  workspace, the first folder that is in a git repo). VS Code starts it when a chat needs its tools;
  **MCP: List Servers** shows its state and output. VS Code trusts MCP servers that extensions
  provide without asking, but in Restricted Mode it first asks you to trust the workspace. The tools
  appear in the chat's tool picker as `branch-review-studio`.
- **Skill and agent:** the extension provides the `branch-review-studio` skill (type
  `/branch-review-studio` in the chat) and a **Branch Reviewer** custom agent (pick it in the chat's
  agent picker), whose instructions follow the skill and whose tools are read, search, terminal,
  edit, todo, subagents and the `branch-review-studio` tools. Both are offered only in VS Code's
  own (local) agent. VS Code loads one skill per name, and a skill in your skill folders
  (`~/.claude/skills`, `~/.agents/skills`, `~/.copilot/skills`, or the repo's `.claude/skills`,
  `.agents/skills` or `.github/skills`) takes precedence over the extension's, so if you installed
  the skill for Claude Code or Codex, VS Code uses that copy; the panel says whether it differs from
  the extension's version.
- **Reviews:** start them in the chat as above. The MCP server records the chat as the review
  session (VS Code sends the chat's id as `vscode.conversationId` with every tool call), and the
  agent's comments are by "VS Code Chat".
- **Ask Agent:** **Send to VS Code Chat**, or the **VS Code Chat (agent mode)** choice of **Send
  to…**, saves your message, starts a new chat with VS Code's own agent
  (`workbench.action.chat.newLocalChat`), and sends it, with the Branch Reviewer agent and the
  model selected in the chat, a prompt that names the thread, its file and lines and
  its messages and asks for an answer with `review_reply`; the thread's lines are attached (for a
  thread on the base side, the prompt quotes them instead). The answer appears in the thread when
  the agent calls `review_reply`; extensions can't read chat replies, so there is no fallback. VS
  Code has no API to fork a chat, so this is always a new chat, and a review session that ran in
  VS Code's chat can't be forked. The commands that open the chat are internal to VS Code, so if
  they fail (e.g. in another VS Code version), Ask Agent shows the error and records it as the
  integration's last error.
- **What doesn't use it:** VS Code's built-in Claude and Codex agents (agent-host sessions) don't
  use this registration; they read the Claude Code and Codex configuration that **Install MCP
  Server and Skill** writes.

## Groups of related changes

A review can divide the branch's changes into groups of related changes, e.g. "Fix CSV quoting" and
"Rename `Widget` to `Gadget`", so that you can review one topic at a time.

- **Grouping:** the skill (and `review_begin`'s instructions) tells the agent to take the groups
  from the branch's commit messages: each change that a message describes is a group, named after
  the message's subject, with the message's text about it, verbatim, as its summary. The agent then
  assigns each change in the diff to a group; only changes that no message describes (e.g.
  uncommitted work) get new groups, whose summaries start with "Missing from commit message."
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
- **View:** each group is a numbered heading ("1. Name") with its size and number of files,
  followed by its summary (markdown: bold, italic, code, lists; HTML and links are shown as text)
  and its files, sorted by path, each with its threads. A file appears under every
  group whose view of it shows a change (one of the group's hunks or an unassigned hunk), and a file
  without hunks under every group listed for it; "partial" marks a file of which the group shows
  only some changes. Groups are sorted by size, smallest first, where size = the number of changed
  lines in the group's hunks (per hunk, the larger of its removed and added line counts, so a
  modified line counts once). Changed files that no group includes (e.g. files changed after the groups were
  posted) and unchanged files with threads are listed last, under **Ungrouped**. Grouped files
  that are no longer changed are hidden; a group left with no changes still appears (as "no
  changes", sorted first), so that a grouping mistake stands out. `review_set_groups` also tells
  the agent about changed files it put in no group. Without groups, the view lists the files by
  path. Thread navigation visits the threads of a file that is in several groups under the first.
- **Open All Changes** shows, for each group in the view's order, a heading entry (a read-only
  markdown document named like "1. Name — 12 lines, 3 files.md" that holds the summary), then the
  group's files, each showing that group's view of the file. A file in several groups appears once
  per group. Ungrouped files come last, under an "Ungrouped" heading. (VS Code's multi-diff editor
  shows nothing if two entries have the same left and right documents, so a file's later
  appearances always use the group's view, whose left side differs per group.) With stale groups
  (see below), it lists the changed files by path.
- **Diffs:** clicking a group's heading opens its heading entry and files in a multi-diff editor
  titled with the group's heading; clicking a file under a group opens that group's view of the
  file. In a group's view, the left
  side is the merge-base version with the hunks that belong only to other groups applied, so the
  diff shows this group's hunks, unassigned hunks, and any changes made after the groups were
  posted. The right side is the real file, so editing and comment threads work as usual, but
  threads on the base side and new comments on the left side are available only in the whole-file
  diff (the diff button on the file's row, or **Open All Changes** without groups). A thread opens
  in a single-file diff even when Open All Changes is open, since VS Code offers extensions no
  reliable way to scroll its multi-diff editor to a line.
- **Stale groups:** if the merge-base changes (e.g. after **Fetch Base Branch** or **Change Base
  Branch…**), the frozen hunks no longer apply, so the diffs show whole files and the group rows
  say "regroup: merge-base changed"; ask the agent to post the groups again.

## Branch Review Studio panel

The gear button in the Branch Review view's title bar (or the command **Branch Review Studio:
Settings and Integrations**) opens a panel in the editor area. (VS Code has no rich modal
dialogs, so it is a webview tab.) It shows:

- How to run a review connected to the extension, with a **Copy Review Prompt** button.
- **Ask Agent defaults:** a dropdown for each `branchReviewStudio.askAgent.*` setting (see Usage,
  step 5), which shows the setting's current value. Changing a dropdown writes the setting to your
  user settings, or to the workspace's (or workspace folder's) settings if it is set there.
- The branch, its base branch (with a selector and **Change Base Branch**, which works like the
  command of that name), the merge-base, and the path of the branch's review file, with
  **Show in File Explorer** (**Reveal in Finder** on macOS), which shows the file, or the review
  store's folder if the branch has no review yet.
- One section per CLI integration (Claude Code, Codex): the CLI's path and version, whether you are
  signed in (`claude auth status`, `codex login status`), whether the MCP server is registered
  (`claude mcp get`, `codex mcp get`), whether the skill is installed, for Codex whether the Codex
  VS Code extension is installed, and the last error from using the integration (Ask Agent
  launches, background runs that fail, terminals that exit with a non-zero code, install and
  uninstall), with its time. The last error is kept in VS Code's global extension state until the
  next successful use. **Install MCP Server and Skill** and **Uninstall** act on that agent only.
  The panel runs these checks when it opens and when you click **Re-check**.
- A section for VS Code Chat: what it can do (see above), how VS Code runs the MCP server and when
  it last started it in this window, whether VS Code uses the extension's skill or your copy, and
  the last error (Ask Agent's chat commands). There is nothing to install, so it has no
  **Install** button.

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
  against a repo that has a sample review, which it leaves as it found it. With
  `BRS_SCREENSHOT_DIR=<folder>` it also saves screenshots of the Extension Development Host window
  (Windows only) and the HTML of the panel and the Branch Review view. It
  checks the VS Code Chat integration without a chat request: VS Code starts the MCP server and
  lists its tools, registers the skill and agent, and Ask Agent's VS Code Chat choice runs the chat
  commands (which the check intercepts) with the expected arguments. It also checks the comment
  box's buttons: which **Send to** _agent_ button each thread shows for several settings, that
  **Send to Claude Code** (also by Ctrl+Enter) and **Send to VS Code Chat** save the message and
  start the agent (in a terminal that the check replaces, or in the intercepted chat), that **Add
  Note to Self** sends nothing, and that the panel's Ask Agent defaults dropdowns write the
  settings. With `BRS_SMOKE_ASK_AGENT=1`
  it also runs Ask Agent twice (fork in the background and in a terminal), which spends tokens.
  With `BRS_SMOKE_CODEX=1` it runs Ask Agent with Codex twice (a fresh background session that
  calls `review_begin`, then a background fork of it), which also spends tokens, and then removes
  the threads and sessions it added; `BRS_SMOKE_CODEX_PATH=<codex.exe>` picks the Codex CLI, since
  the throwaway profile lacks the Codex extension's bundled CLI.
  With `BRS_SMOKE_FRESH_REPO=1` and a repo without reviews, it checks lazy store creation instead.

See AGENTS.md for coding conventions.
