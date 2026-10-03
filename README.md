# Branch Review Studio

A VS Code extension for reviewing a branch before you merge it, like a pull-request review, except
that the comment threads are exchanged with AI agents (Claude Code or OpenAI Codex) instead of
people.

- **The diff:** your working tree, including uncommitted and untracked files, against the
  merge-base with a base branch (`develop` by default). The right side of each diff is the real
  file, so you can edit as you review.
- **Agent reviews:** an agent (Claude Code or Codex) reviews the branch with the included skill
  (`/branch-review-studio`) and posts its findings as comment threads through the extension's MCP
  server. It can also group related changes, and each group's diff then shows only that group's
  changes.
- **Conversations:** reply in a thread, or use **Ask Agent** to send your message to a fork of
  the session that wrote the review, or to a fresh session, so the answer lands back in the
  thread.
- **Branch switching:** pick a branch; the extension opens its worktree, creating one if needed.

It's per-user and doesn't modify tracked files in your repos, so teammates who don't use it aren't
affected. You need the `claude` and/or `codex` CLI, and `node` on your PATH.

## Getting started

1. Install the extension, then reload VS Code.
2. Open the **Branch Review** view in the Activity Bar and click the gear. The panel explains how
   to start a review. Click **Install MCP Server and Skill** for each agent you use.
3. In your branch's folder, run `/branch-review-studio` in Claude Code (`$branch-review-studio`
   in Codex). Add "be thorough" for a more expensive review by parallel sub-agents.

See [docs/guide.md](docs/guide.md) for details: building from source, what's stored where,
settings, change groups, and how Ask Agent works.

## License

Public domain ([Unlicense](LICENSE)). Initially built by Claude Opus 5.5 in Claude Code, directed by
David Piepgrass.
