# Settings panel: Show the review file in File Explorer

## Planning

User:

> Also I'd like an option in settings page to visit the file Holding the review data in the File
> Explorer

No questions were asked. Assumptions made without asking:

- A1: The option belongs in the panel's Branch section, as a "Review file" row that shows the
  branch's review file (`<git-common-dir>/branch-review-studio/reviews/<branch>.json`) and a button
  that runs VS Code's `revealFileInOS` on it. The button's label follows the OS ("Show in File
  Explorer" on Windows, "Reveal in Finder" on macOS, "Open Containing Folder" on Linux).
- A2: If the branch has no review file yet, the button shows the nearest existing folder of the
  review store, or says that there is no review yet.

## End phase

- settings-panel.ts: the "Review file" row, the `revealReviewFile` message and its handler;
  `getBranchState` includes whether a review exists, so "(not created yet)" disappears when the
  file is created.
- scripts/smoke-test.ts: checks that the panel shows the review file's path and the button.
- docs/guide.md: describes the row.

Tests: vitest 168 passed; tsc clean; the smoke test in VS Code (sandbox repo) passed, including
the new check. The button itself wasn't clicked by a test, since it opens a File Explorer window.

## Follow-up: open the file in VS Code instead

User:

> oh if it's just one file it's would actually be better to open it in VS Code I think

The button is now **Open Review File** (`vscode.window.showTextDocument`), shown only once the
branch has a review; the File Explorer button and its fallback to the store's folder were removed.
The smoke-test check now clicks the button and checks that the review file is the active editor;
it passed. In the same smoke-test runs, "Ctrl+Enter in a new comment box clicks its primary
button" failed ("the text went into the file instead of the comment box"); it also failed on the
previous commit (e60ecf7), which had passed earlier, so the failure depends on the environment
(the comment box apparently needs the test window to have OS focus), not on this change.
