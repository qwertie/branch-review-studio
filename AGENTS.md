# AGENTS.md

Sections below marked (verbatim) are copied from Barreleye's AGENTS.md.

This repo contains Branch Review Studio, a per-user tool for reviewing a branch before it is merged,
with comment threads exchanged with AI agents (Claude Code or Codex). It has three parts:

1. src/extension/ (VS Code extension): tree view of changed files vs. the merge-base with the base
   branch, diff editors, comment threads (Comments API), branch/worktree switching, a settings and
   status panel, and commands that send thread messages to an agent ("Ask Agent").
2. src/mcp/ (stdio MCP server): tools (`review_begin`, `review_comment`, `review_reply`, ...) that
   let agents post review threads into the review store.
3. skills/branch-review-studio/ (agent skill): the branch review procedure, which posts findings
   with the MCP tools.

src/core/ holds the logic shared by the extension and the MCP server (git, review store, anchoring,
agent CLI invocations behind `AgentIntegration`). It must not import `vscode`, and it is
unit-tested with vitest.

Encapsulation rule: nothing in the user's repos may depend on this tool. It writes only to
`<git-common-dir>/branch-review-studio/` (which git ignores), to `~/.branch-review-studio/`, and to
user-level Claude Code / Codex config and skill folders when the user runs an install command.

Read .claude/skills/barreleye-programming-process/SKILL.md ("BPP") before writing code.

### Prime directives (verbatim)

- Concise, elegant, reuseable and reused code are crucial to maximize the team's productivity. Concise does NOT mean minimizing newlines. Instead, follow the generalized DRY principle: factor code to avoid repeating patterns of any kind. When adding features, actively seek out similar functionality to find opportunities for code re-use. Make the code concise via in-function refactoring during the Second Pass. Do not without approval add large ancillary code blocks to handle special cases.
- Care about Separation of Concerns and Information Hiding
- To give human reviewers a simpler diff, avoid unnecessary changes during tasks (but you can ignore added/removed BOMs)
- NEVER USE `as any`. DO NOT USE `: any`. AVOID `as unknown as`.
- Communicate clearly (see below)

### Style directives (verbatim)

- Put high-level code first and callers before callees (helper functions at bottom).
  - Put nested functions at the bottom of the outer function or of the block it is called from.
- Renaming something? If the file has that name, rename it too.
- Wrap code before column 120 and comments before column 100
- Naming:
  - Use verb phrases for names of new functions: findFoo(), not fooLookup()
  - Affixes: XIfY() = do X in case of Y, TryX() = "do X if possible" or "does not throw on failure", MaybeX() = do X if a condition to complex to describe in an IfY suffix holds; XCore() = XCore is the "core" of X() which does ancillary tasks like checking permissions
  - Use Is/Are/Get prefix on getter functions, but React Components and fast property-like queries can use a noun: `double MinimumAt(timeIndex)`
  - Use the codebase's dominant vocabulary for concepts & avoid coining terms: don't say "Q" if existing code says "flow rate"
  - Indicate whether transforms are in-place or not (`reverse()` vs `getReversed()`)
  - Very long names are OK on rarely-used symbols; very oft-used words/symbols can be abbreviated
- Avoid excessive wrapping in JSX and parameter lists, e.g. `<TextFieldH label="Pressure" value={pressureH} unit={units.pressure}/>` needs no newlines
- Avoid one-liner loops/flow: spread `if (x) continue` and `for (let x of list) write(x)` over two lines
- Prefer nesting over early exit, e.g. instead of

    let c = list.find(...);
    if (!c) break;
    Change(c);
    ...

  write
  
    let c = list.find(...);
    if (c) {
        Change(c);
        ...
    }

### Other (verbatim)

- Use subagents more often when your task is large and context exceeds 100K tokens
- Unless you're on a dedicated temporary worktree, other agents may be working in the same tree so prefer not to stash and never switch branches when the user didn't explicitly ask for it

## Communication (verbatim)

Always write clearly, plainly, and unambiguously:

1. Prefer active voice to make the subject of each sentence explicit
2. Prefer unabbreviated code symbols over English paraphrase or pronouns: problems => `HydraulicsProblem`s
3. Be specific.
4. Don't use mannered prose, e.g. avoid "gate" and similar metaphors, and prioritize clarity over concision: "showMiniMap flows to SolverTab which now gates HydraulicsDayMiniMapPreview on it" => "HeaderBar sets the new showMiniMap prop on SolverTab, which shows a HydraulicsDayMiniMapPreview when it's true".
5. Talk like Peter Miller, Scott Alexander, Matt Yglesias, Spencer Greenberg or Julia Galef
6. Label things with numbered codes that are unique within a conversation, so the user can refer to them unambiguously:
  - P1, P2, ..., Pn: Numbered proposals or propositions
  - F1...Fn: findings
  - D1...Dn: decisions
  - T1...Tn: tests
  - B1...Bn: bugs
  - S1...Sn: sections
  - You can invent new series too
7. Assume your human is unfamiliar with the code: you read (and wrote) it so they didn't have to. As you start a paragraph, share background info to help make sense of what comes next.
8. When your speech was vague/ambiguous, follow up immediately with a clarifying example, parenthetical or ", I mean..."
9. When writing plans, state where in the code each change will be made, and include member/function/type names with signatures.
