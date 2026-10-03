# Branch Review Studio: VS Code extension for reviewing branches with Claude Code agents

Transcript of the planning conversation (T3 Code thread, Claude Opus 5.5 as coordinator; implementation
and second pass were delegated to subagents). User messages are verbatim; assistant messages are
abridged where noted.

## S1. Planning conversation

### User (message 1)

> [screenshot of Visual Studio's sticky scroll: `namespace Barreleye.DbEntities` / `public class
> EntityDBO : PieceOfScenarioWithColor,` / `public void Assign(EntityDBO other)` pinned above
> lines 421–423]
>
> I want an improved workflow for reviewing and editing branches prior to committing to `develop`.
> This could maybe be done as a Visual Studio Code extension or as a purpose-built app. Help me
> figure out what should be built.
>
> I want it to be similar to the user interface on DevOps for reviewing pull requests, except
> instead of leaving comments for humans I will be sending and receiving messages to/from agents.
>
> - I want a special editor interface that will show an interleaved diff, ideally with context
>   lines on top (like in VS, see screenshot) but still permit editing individual lines like in VS
>   Code and ALSO allow sending/receiving comments from agents
> - I will want to be able to connect it directly or indirectly (probably indirectly, given Claude
>   Code's terms of service) to my Claude Code subscription so that apart from sending messages to
>   agents from the editor, I could run a command similar to `/branch-review` which will perform a
>   code review and put comments in relevant places in the app.
> - It would actually be nice if it were connected to T3 Code (which, in turn, is connected to
>   Claude Code) somehow... like, if I have to input a command in T3 Code to kick off the review,
>   that's perfectly fine and probably better because by having the thread in T3 code, I would be
>   able to see that thread from other machines. The tricky part would then be getting the results
>   of the code review into my new code review interface. Likewise if sending a message in the code
>   review tool was actually sending a message to T3 code (but with context) that's fine too.
> - When I send a message to an agent via this new app, but a code review is already in progress,
>   I think the appropriate default behavior is to send a message to a forked version of the thread
>   that produced the code review so that the agent has ample context. But I guess there should be
>   an option for starting a fresh thread as well.
> - I want an easy way to switch to a branch. Usually I would rather pick a branch than a worktree
>   and then if there is already a worktree associated with the branch, the app would go there, but
>   if there is no worktree it will create one. I guess that the tool should have an association
>   between branches and code reviews so that if I switch branches I can switch which code review
>   I'm seeing as well.
> - If it's not a VS Code extension it will need features for navigating around, expecially
>   Ctrl+Shift+F for quick search and Ctrl+P for jumping to files

### Assistant (abridged)

Recommended a VS Code extension rather than a standalone app, because VS Code already provides
the inline diff editor (modified side editable), sticky scroll, the multi-file diff editor
(`vscode.changes`), the Comments API, Ctrl+P and Ctrl+Shift+F. Proposed architecture:

```mermaid
flowchart LR
  T3[T3 Code] -- runs --> CC[Claude Code session]
  CC -- MCP tool calls --> MCP[review-bridge MCP server]
  MCP -- writes --> Store[(review store in git common dir)]
  Ext[VS Code extension] -- reads/writes --> Store
  Ext -- WebSocket commands --> T3
```

Findings from inspecting the local T3 Code Nightly install: T3 Code has no fork command (only
`thread.create` with `historyImport` + `thread.history.import`, which copies message text only);
the T3 server listens on 0.0.0.0:3773. Proposed a build order (1. read-only UI; 2. MCP bridge and
review skill; 3. T3 adapter; 4. polish) and named risks (inline diff + editing + sticky scroll +
comments together; unstable T3 API; MCP loading in T3-spawned sessions; comment re-anchoring).

### User (message 2)

> [screenshot: T3 Code error "VCS process timed out in GitVcsDriver.isInsideWorkTree: git (D:\)
> after 5000ms"] oh something weird happened in T3 code.
>
> Something I forgot to mention, but which is perhaps obvious, is that I mainly want to compare the
> current local directory with `develop` no matter how many commits it differs by.
>
> I'm not sure what you mean about `git rev-parse --git-common-dir` Because that returns the same
> folder for all worktrees. If you can store JSON files in there that is specific to our tool, and
> do not interfere with `git`, make sure that it has an unambiguous name and comment inside so I
> can tell where it came from when I see it later.
>
> There is already a `/branch-review` tbc, but it sounds like you are proposing a new one.
>
> I wanted proper fork behavior. Anything that trashes the cache and forces new input tokens is not
> helpful. May as well just always start with a clean thread with some basic context if that's not
> possible. Am I to understand that T3 Code can't directly read Claude Code threads? Probably our
> new tool should support both T3 Code and Claude Code if the latter can support forking better...
> Plus if you are going to be building against unstable interfaces in T3 code, we certainly want a
> Claude Code fallback to be available.
>
> I like the idea of a VS Code extension. The extension should be implemented in TypeScript,
> right? It's probably best if you hand off the work to a sub-agent so that your own context stays
> cleaner. Let's see how practical this is: please build it. Follow the Barreleye Programming
> Process (D:\Barreleye\.cursor\skills\barreleye-programming-process\SKILL.md) and Barreleye
> AGENTS.md to the extent they are applicable to this new extension. Make a new repo that includes
> verbatim parts from those files that are relevant to the extension.
>
> One more thing. I want to make sure this is well-encapsulated so that I can easily share it with
> coworkers without requiring that the coworkers use it.
>
> It sounds like you want to just do step one for now? I guess that's okay but why?

### Assistant (abridged)

- The T3 error was a one-off: `git rev-parse` in `D:\` took 0.04 s when re-run.
- Diff base: working files (including uncommitted/untracked) vs `git merge-base origin/develop
  HEAD`, same as DevOps PRs and `/branch-review`.
- The git common dir is shared by all worktrees, which is the point: reviews are per branch. The
  store gets an unambiguous folder name, a `README.txt` and a `"$comment"` field in each JSON file.
- Instead of a new `/branch-review`, add a conditional step to the existing one.
- Each T3 thread is a normal Claude Code session saved under `~/.claude/projects/`; T3 can't adopt
  outside sessions or fork, but `claude --resume <id> --fork-session` is a true fork that keeps the
  prompt-cache prefix. So forks run through the Claude Code CLI (visible in Claude Code, not T3).
- Step 1 alone was suggested to test the riskiest UI assumption first; instead, build in phases
  with a checkpoint after the UI.

## S2. Questions asked and answers

- Q1. Name and location? Options: `agent-review` at `D:\agent-review` (recommended),
  `branch-review-studio` at `D:\branch-review-studio`. **Answer:** "branch-review-studio at
  D:\branch-review-studio".
- Q2. Scope this round? **Answer:** "UI + store + MCP + Claude fork (Recommended)" — phases A, B, C,
  with a checkpoint after A; T3 adapter later.
- Q3. How should forked sessions run? **Answer:** "Both, chosen per message" (default interactive
  terminal, with a background option).
- Q4. May the subagent edit Barreleye's `branch-review.md`? **Answer:** "probably both―We need a way
  for the extension to be conveniently used in different projects, but hooking it into the
  existing branch review makes sense for Barreleye in particular" → generic skill in this repo plus
  an uncommitted conditional hook in Barreleye.
- Q5 (after Phase A checkpoint). Continue with B and C? **Answer:** "yes, continue B and C. I will
  read your message up above in the meantime."
- Q6. Build a generated `.code-workspace` so inline diff applies only to review windows?
  **Unanswered** — not built.
- Q7. Change Barreleye `/branch-review` Step 3 to diff the working tree (`git diff $MERGE_BASE`)
  instead of `$MERGE_BASE..HEAD`? **Unanswered** — not changed.

## S3. Assumptions made without the user's confirmation

- A1. Base branch is configurable (`branchReviewStudio.baseBranch`, default `develop`); an existing
  review's base branch takes precedence over the setting and over the MCP default.
- A2. No per-editor inline diff exists in VS Code 1.140, so the extension does not change
  `diffEditor.renderSideBySide`; the README tells users to pick Inline View themselves.
- A3. Sessions started by Ask Agent pre-approve only this tool's MCP tools
  (`--allowedTools mcp__branch-review-studio`) so replying to a thread doesn't prompt.
- A4. The Barreleye hook posts findings to Branch Review Studio without asking, because posting is
  local.
- A5. Worktrees are created under a sibling folder `<repoName>.worktrees/<branch>` (setting
  `branchReviewStudio.worktreeRoot`).
- A6. The MCP server is registered for the user (`claude mcp add --scope user`) with a stable copy
  at `~/.branch-review-studio/mcp-server.js`; `node` must be on PATH.
- A7. The provenance note names the tool and extension id (`barreleye.branch-review-studio`) rather
  than a local repo path, so it is correct on coworkers' machines.
- A8. Fork options are hidden when the review session's folder no longer exists, because
  `claude --resume` finds sessions by project folder.
- A9. T3 Code sessions load user-scope MCP servers (T3's server bundle passes
  `settingSources: ["user","project","local"]`); not yet observed in a live T3 session.

## S4. End phase

The implementation subagent delivered Phase A (commits `dd8e415`, `4cf4a99`) and Phases B+C
(`50f14fb`). A second-pass subagent then removed duplicated code, added doc comments, and fixed
findings F1–F6:

- F1/F2: `Review.baseBranch` holds a plain branch name; an existing review's base branch takes
  precedence over the setting in both the extension and the MCP server.
- F3: Ask Agent offers only fresh sessions when the review session's folder no longer exists.
- F4: esbuild injects the package version into the MCP server.
- F5: comment threads that can no longer be shown are disposed.
- F6: terminal names and status text use a thread's current line.
- Also: `claude.cmd` shims whose `cli.js` is missing no longer stop the search for `claude.exe`;
  the provenance note names the extension id instead of a local path.

Typecheck passes, 53 vitest tests pass, and the build succeeds. No ticket number (this repo has no
work items). Commit message:

```
Second pass: consistent base branch, safer Ask Agent, less duplication

Agents and the extension could compare a branch against different bases, because the
extension always used the `branchReviewStudio.baseBranch` setting while `review_begin`
defaulted to develop. Now `Review.baseBranch` holds a plain branch name (old
`origin/<branch>` values are normalized by `parseReview`), and an existing review's base
branch takes precedence over both the setting and the MCP default.

### Also

- ask-agent.ts: the QuickPick offers only fresh sessions when the review session's folder
  no longer exists, since `claude --resume` finds sessions by project folder; terminal names
  and status text show a thread's current line instead of the line it was created on
- comments.ts: `hideThread` disposes VS Code comment threads that can no longer be shown,
  e.g. base-side threads when the merge-base is unknown
- claude-cli.ts: Bug fix: a `claude.cmd` shim whose `cli.js` was missing ended the search
  for `claude` before `~/.local/bin` was checked
- store.ts: the provenance note names the extension id instead of the local repo path
- esbuild.mjs injects package.json's version into the MCP server
- files.ts, git.ts: shared `getFullPath`, `getRepoRelativePath`, `getErrorCode`,
  `tryRunGit` and `comparePaths` replace duplicated code; added missing doc comments
- Transcripts/: planning transcript
```

Release notes: Branch Review Studio is a new VS Code extension for reviewing a branch's
uncommitted and committed changes against `develop` with Claude Code. Claude posts review comments
into the diff, and you can reply in a comment thread to send the question to a fork of the session
that wrote the review. Nothing changes for coworkers who don't install it.

## S5. Follow-up: base branch selector

### User

> I don't see a selector for switching to select a base branch. Please add that. That is an
> interesting icon you made for the extension by the way.
>
> [The rest of this message asked about VS Code's AI-model features, using the Claude Code and
> ChatGPT extensions from this extension; that research is tracked separately.]

Assumptions made without asking: the choice is stored in the branch's review, never in settings;
only branches that are local or on `origin` are offered; arbitrary refs can't be typed; when no
merge-base exists, clicking the header row opens Change Base Branch; Fetch Base Branch now also
stores the new merge-base in an existing review (second-pass finding F3).

## S6. Follow-up: Codex, settings panel, full review skill

### User (abridged only where it repeats research results)

> it sounds like the Claude Code extension is not possible to fully integrate with our extension (I
> want replies by the Claude to go into the code review). I just installed the Codex extension into
> my VS Code, and my proposal is to integrate our new extension with that not with the ChatGPT
> desktop app. Or integrate with the Codex CLI if the extension is not easy to integrate with. I
> don't care what order you add the integrations in, but since we will have multiple integrations,
> add a configuration button to our new sidebar that will show a modal to let the user select a
> base branch and also see the status of the integrations (for each supported integration, show
> whether it is apparently available and, if an error occurred during the last attempt to use an
> integration, the error should be shown there)

> I intended for the diff to be the working tree versus a base branch. I don't see how it could
> work any other way because the code review window is supposed to allow the user to edit code.
> Are you saying that's not how it works? Because I am allowed to edit in the combined diff view

> oh I am reluctant to change the skill in Barreleye itself, but it's okay, don't revert. isn't
> there a version of the skill in the extensions folder? Now that I think about it, the
> configuration modal I requested should explain at the top how to do a code review that is
> connected with the extension

> I want the branch-review skill in the extension's folder to be full-featured and based mainly on
> the barreleye one. However the fan-out thing is expensive in tokens I would like a version of
> the skill that only does the fan-out if requested by the user includes an instruction like "use
> multiple sub-agents" or "be thorough" or "be comprehensive". The default code review skill
> (which I think is called /review?) Does a pretty good job and so what I really want is a version
> of the skill that combines the best of both that doesn't fan-out by default (unless the default
> one does?)

Research findings that shaped the plan: `vscode.lm` models need API keys or Copilot, never a
Claude Code or ChatGPT subscription; the Claude Code extension exports no API and its documented
`vscode://anthropic.claude-code/open` link can't fork or auto-send; the Codex extension can't
start a thread with a prompt but can open one by id (`vscode://openai.chatgpt/local/<threadId>`);
the Codex CLI supports true forks and MCP; Claude Code's `/review` is an alias of `/code-review`,
which (with Opus) fans out to subagents only at `max` effort.

Decisions and assumptions (not asked): Codex runs through the Codex CLI (preferring the CLI bundled
with the Codex extension); the "modal" is a webview tab because VS Code has no rich modals; Codex
runs pre-approve only this tool's MCP server via `-c` overrides; Install copies the skill to
`~/.claude/skills/` and `~/.agents/skills/`; Barreleye's `/branch-review` Step 3 now diffs the
working tree (uncommitted in Barreleye).

Unanswered: whether Install should add `default_tools_approval_mode = "approve"` for this server
to `~/.codex/config.toml`.

## S7. Follow-up: change groups

### User

> oh something that I forgot to mention, I think, is that `/branch-review` puts the changes into
> groups. From the perspective of this extension, the groups could still exist but they would have
> to be complete files, I think, right? [...] I think the way to meet this challenge is to allow the
> same file to potentially go into multiple groups. I propose this algorithm: [per-file group
> membership with conceptual-line counts and minor-line counts; groups with name and summary;
> groups sorted smallest to largest; a cutoff for repeating a file under secondary groups with
> three settings: min lines, min percentage, minor-line weight 0.2]. Implement this if it all makes
> sense

The assistant pointed out that a group's diff can show only that group's changes by serving a
synthetic left side (merge-base plus other groups' changes) while the right side stays the real,
editable file. Answers: "Only that group's changes"; thresholds "meet EITHER"; for Barreleye: "I'd
like the branch-review command to have only minor changes. It should tell the agent to do this by
pointing it at another file or command" (so the Step 8 hook became a two-line pointer to the
instructions `review_begin` returns).

> Your observation that the base file could be Modified to suppress lines from other groups is
> astute and prima facie removes the need for the whole algorithm I presented and the 3 settings.
> However, I wonder how this interacts with editing functionality. If a file is shown twice and
> edited in one place, Whether it is edited by a human or by AI, that edit will definitely appear
> in both places right? The design requires more thought than I have given it.

The assistant explained that every view's right side is the same live document, and proposed
freezing the grouping as hunks anchored to merge-base line numbers, so later edits never shift
anything and simply appear in every view of the file. Answer: "Frozen hunks, no counts".

```mermaid
flowchart LR
  Agent -- review_set_groups(groups, files+ranges) --> Tool[MCP tool]
  Tool -- git diff -U0 at call time --> Hunks[hunks frozen by base line numbers + group ids]
  Hunks --> Left["group G's left side = merge-base + hunks not in G"]
  Live[live working file] --> Right[right side, editable]
  Left --> View[group G's diff view]
  Right --> View
```

## S8. Follow-up: publishing, VS Code Language Models

### User

> I added a repo at https://github.com/qwertie/branch-review-studio.git and I'd like you to push to
> it with a brief readme and some kind of public domain dedication. How do we get this thing onto
> the Database of extensions in Visual Studio Code?

Answers: publish everything with full history; Unlicense; publisher `qwertie`. "the dedication
should mention it was initially built by Opus 5.5"; "but don't actually put it on the marketplace
until I've reviewed it more". Later: "Yes use readme to avoid NOASSERTION. Oh also I've updated
AGENTS.md, please commit that."

> How hard would it be to add an integration for the new VS Code "Language Models" feature?

The assistant proposed P1 (answers only), P2 (answers with read-only tools) and P3 (full branch
reviews, not recommended).

> OK do P2 and Ensure that the UI Indicates the ability and limitation of this integration (That
> it can't do full branch reviews)

Assumptions made without asking: background-only; read-only tools confined to the repo that refuse
`.git`, paths outside the repo, special files and gitignored files; 12 tool rounds, 20,000-character
results, an input budget of 80% of the model's limit; 20-second git timeouts; failures post
nothing and are shown as the integration's last error.

## S9. Follow-up: webview sidebar, grouped All Changes, thread navigation

### User

> Hmm weird. I told an agent to post its review to the extension [...] 1. I see no group headings or
> group descriptions. Nor does it appear like the files are ordered in ascending order by group
> size [...] 2. [...] it's too hard to tell whether there are comments above or below the current
> scroll position. [...] Could you add a toolbar at the top right of the editor pane? Probably
> there should be 4 buttons for going To next thread, Previous thread. Next unresolved threat and
> previous unresolved thread, plus a dropdown showing all threads. In the drop down the individual
> items should show the relative path + filename and beginning of thread text (X/Y.cs: blah blah
> blah...) 3. BTW I didn't say anything about the sort order within a group. Within a group The
> files should be listed in order by path and filename.

> Now that you mention it, I do see a bunch of stuff in the sidebar that looks like the 6 groups.
> I didn't know what to make of it at first. Was this implemented instead of the thing I wanted?

> That tree view on the left is kind of confusing; the groups aren't distinctive, the description
> looks like stray text as you say, and the files are not indented with respect to their groups

> Is there some reason why the sidebar sidebar has to be a tree view? But the tree view seems like
> a straitjacket for formatting.

Answer: "Webview, replace the tree"; grouped Open All Changes: "Yes, try it".

> - issues in sidebar are not shown in proper order; The order should of course match the order
>   they appear in code and the order they appear in the main combined view
> - clicking on one of the threads in the sidebar doesn't necessarily scroll to it in the main pane
>   [...] when I click the second issue it scrolls too high [...] The issue (about "one-time
>   costs") appears on line 258

Cause of the scrolling bug: VS Code draws a thread's widget below the last line of its range, but
the reveal targeted the first line. VS Code findings: identical (modified, original) pairs blank
the multi-diff editor; no reliable way exists to reveal a line inside the multi-diff editor, so
threads open in a single-file diff editor. Unanswered: whether the sidebar's buttons should move
back to the view's title bar.
