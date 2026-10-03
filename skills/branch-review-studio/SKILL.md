---
name: branch-review-studio
description: Use when reviewing a branch, or when a prompt says it comes from Branch Review Studio, and the `branch-review-studio` MCP tools (review_begin, review_comment, review_reply, ...) are available. Explains how to post review findings to the developer's VS Code and answer comment threads.
---

# Branch Review Studio

Branch Review Studio is a VS Code extension in which a developer reads review findings as comment
threads on a diff, and answers them. Its MCP server (`branch-review-studio`) gives you the tools
below. They act on the branch checked out in your project folder. If the tools are not available,
ignore this skill.

## What is being reviewed

The developer's diff is the WORKING TREE, including uncommitted and untracked files, compared with
`git merge-base origin/develop HEAD` (or `develop` if there is no `origin/develop`), however many
commits the branch has. To see it, run `git diff <merge-base>` plus
`git ls-files --others --exclude-standard` (review_begin reports the merge-base). Line numbers you
post refer to the working-tree files.

## Posting a review

1. Call `review_begin` (optionally with `summary`). It lists threads that are already open; don't
   post duplicates of them.
2. For each finding, call `review_comment` with `file` (repo-relative), `line` (and `endLine` for
   a range), `severity` (Critical, Major, Minor or Note) and `body`: the finding plus its concrete
   consequence, in markdown. For removed code, use `side: "base"` and line numbers of the
   merge-base version.
3. Call `review_finish` with an overall summary in markdown.

## Answering a thread

When a prompt asks you to answer review thread `<id>`, reply with `review_reply` (`threadId`,
`body`). Change code only if the developer asks you to, and then summarize your edits in the
reply. If the developer's point settles the thread, you may call `review_resolve` instead, with a
`note`. `review_list` shows threads with all their comments.
