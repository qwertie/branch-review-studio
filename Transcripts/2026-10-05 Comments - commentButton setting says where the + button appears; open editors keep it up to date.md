# Comments: commentButton setting says where the + button appears; open editors keep it up to date

## Planning

This task was delegated by a coordinating agent; the user's messages reached this agent through it.

User (earlier, verbatim): "The "+" button for branch-review threads is available in all editors.
Useful but surprising; can we make a checkbox for that in settings?"

The coordinator first decided not to add a setting and asked for a bug fix (B1), found by an
earlier investigation: in src/extension/comments.ts, `ReviewCommentController` assigned
`commentingRangeProvider` once, so when the set of changed files changed (a file became changed
or unchanged, the branch or base branch changed, a refresh), open editors kept their old "+"
ranges until reopened. Fix: re-assign the provider on `model.onDidChange` when a key of the
commentable files changes. Add a smoke check if practical, and restore the sandbox
(D:\brs-sandbox\Barreleye) afterwards.

Then the scope changed. User (verbatim): "Hmm. The extension could provide that "+" in all
editors, couldn't it? If so the options could be "Show only on files whose diff is open" (with
tooltip explaining that side effect) and "Show on all files" (because it's sort of confusing
having it on some normal editors and not others)"

Spec from the coordinator (summarized):

- Enum setting (named here `branchReviewStudio.commentButton`): `allFiles` (default) = any `file:`
  document in the repo, changed or not, plus base sides as before; `openDiffs` = only documents in
  open diffs (`TabInputTextDiff`, and multi-diff tabs' entries). Files outside the repo, untitled,
  `git:` etc. never get one. Threads on unchanged files must work end to end.
- Re-assign the provider when the setting changes, when tabs change (openDiffs), and when the set
  of commentable files changes (B1).
- Settings panel: dropdown or radio pair with labels "Show on all files" / "Show only on files
  whose diff is open", tooltip on the latter; written like the Ask Agent dropdowns, validated
  server-side.
- package.json contribution; docs/guide.md.
- Smoke checks for both modes; restore settings and the sandbox.

Later instruction from the coordinator: limit VS Code launches (the user was disrupted by test
windows popping up); rely on vitest and tsc, and run the full smoke test once at the end.

## Findings during research

- F1: VS Code's extension host setter `commentingRangeProvider` always calls
  `$updateCommentingRanges`, so re-assigning the same provider object makes VS Code ask open
  editors again.
- F2: VS Code also re-asks when a document's content changes (e.g. reloaded from disk), which
  happens before the model refreshes, so a smoke check on a `file:` document must wait for that
  query before refreshing. With that, the first version of the B1 check (an unchanged `.md` file
  in a normal editor) failed without the fix ("range counts: [0,0,0]") and passed with it.
- F3: The stable typings lack `TabInputTextMultiDiff`, but the extension host creates it for
  multi-diff tabs with a `textDiffs` array of `TabInputTextDiff`, so it is duck-typed.
- F4: Threads on unchanged files already work: `computeSnapshot` anchors every thread with
  `getFileLines`, and `buildReviewOutline` lists unchanged files that have threads.

## Questions and assumptions

No questions were asked. Assumptions (unasked):

- D1: In `allFiles` mode, files under `.git` (e.g. the review JSON that Open Review File opens)
  get no "+".
- D2: In `openDiffs` mode, a document counts if it is either side of an open diff, whether or not
  the file is changed (e.g. VS Code's own SCM diffs count for their `file:` side).
- D3: Base-side documents in `allFiles` mode still need the file to be changed, as before.
- D4: The panel uses a radio pair (a `title` tooltip on `<option>` is unreliable) in a new
  "Comment threads" section with the row label 'Comment + button'.
- D5: Since `allFiles` makes every repo file commentable on the modified side, the B1 smoke check
  uses the base side of an unchanged file (`brs-base:` document), whose commentability still
  depends on the changed files. This version of the check was not run without the fix (to limit
  VS Code launches); the base document's content doesn't change, so only the re-assignment can
  make VS Code ask again.

## Second pass

A subagent reviewed the changes and edited them: it made the `.git` exclusion also cover a `.git`
file, made the key contain only what the current mode depends on, renamed `commentableFilesKey`
to `commentableDocumentsKey`, made `updateSetting` take `(scope, setting name, value)`, made the
smoke check open the diff with the `branchReviewStudio.openFileDiff` command, and tidied comments.
Issues it noted but left: in `openDiffs` mode, a change in the file list of an already open Open
All Changes tab may not fire `onDidChangeTabs`; `getCommentTarget` accepts a `brs-base:` URI at
any non-empty sha (pre-existing); gitignored files get the "+" in `allFiles` mode.

## End phase

- `npx tsc --noEmit -p .`: clean. `npx vitest run`: 169 tests pass.
- `npm run smoke-test -- D:/brs-sandbox/Barreleye`: 32 PASS, 1 FAIL, the known environmental
  failure "Ctrl+Enter in a new comment box clicks its primary button" (the test window lacked OS
  focus). New checks pass: "commentButton allFiles: an unchanged file gets the + button; a new
  thread there is saved, anchored and shown", "commentButton openDiffs: a changed file opened
  normally gets the + button only while its diff is open", "Bug_2026_10_StaleCommentingRanges: the
  base side of a file gets the + button when the file becomes changed and loses it when the file is
  unchanged again", and "the panel's Comment threads section shows the commentButton setting;
  picking a radio button writes it". (An earlier run had a mangled repo path, so the extension
  found no repo; it was rerun.) The sandbox's `git status` is clean afterwards.
- No ticket number was given; the commit has none.
