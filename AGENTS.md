# AGENTS.md

This repo contains Branch Review Studio, a per-user tool for reviewing a branch before it is merged,
with comment threads exchanged with AI agents (Claude Code or Codex). It has three parts:

1. src/extension/ (VS Code extension): Branch Review view (a webview) of changed files vs. the
   merge-base with the base branch, diff editors, comment threads (Comments API), thread
   navigation, branch/worktree switching, a settings and status panel, and commands that send
   thread messages to an agent ("Ask Agent").
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

## The Programming Process (TPP)

FOLLOW THIS PROCESS for all coding unless asked to "bypass" it or "prototype".

### Planning phase

Gather info as usual. When not asked to plan, do some planning anyway:

- After researching, if the user's request still seems ambiguous/confusing/vague, or if the user said anything that doesn't make sense, STOP and ask user to clarify.
- Look for multiple ways to fulfill the user's request. For each decision point where you see two or more distinctly different approaches, consider if one is clearly the best. If not, write an outline of each approach and ask user for guidance.
- Do not make major assumptions without confirmation. If you see a way to accomplish a task by making changes that might suprise the user, or that might seem out of scope to the user, STOP and ask for confirmation before proceeding.
- After all that, write out a plan, including tests to be written. Make the plan detailed in Plan Mode, brief in Agent Mode, but specific in both. Ask user to confirm or refine.
- Once the plan is confirmed, create a task list (TaskCreate) with one task per implementation item plus these: "Second pass", "Tests pass", and one task per End phase step. Check tasks off as you go; the End phase begins by reviewing the list.

### Testing

Do TDD with vitest/NUnit tests (can skip this for cosmetic changes & pure refactors)

- Find or make helper functions to avoid code duplication or verbose tests
- Bug fix tests are named `Bug_YYYY_MM_X` or `Regression_YYYY_MM_X` where X is what went wrong or must happen, e.g. `Bug_2026_01_CouldNotDeserialize`
- Verify that new tests fail unless you're already sure

### Implementation phase

While making changes:

- "When in Rome": mimic existing patterns.
- Use frequently-used functions/types where applicable.
- Do not make major assumptions without confirmation. If necessary, stop and ask questions in the middle of implementation, using timed questions if a skill for that is available.
- If, as you work, you notice pre-existing code that is confusing or buggy, highlight this code to the user, but only fix it if it's very clearly wrong.

### Second pass

Use a subagent to review the code you just wrote, sending it the user's original prompts, Q&A, and user-approved final plan if any, asking it to follow these instructions to edit the changes:

1. Look for inelegancy (such as repetition) and ways to write the new code more concisely, e.g. combine this example into one LoC:

        var theFoo = GetFoo(x);
        return Bar(theFoo).Baz;

2. Follow prime directives from AGENTS.md.
3. Follow style & other directives from AGENTS.md.
4. Rename things whose changed behavior invalidates their name.
5. Look for bugs
6. If you do something weird (e.g. violating normal programming principles is necessary), add a comment to explain why.
7. Add doc comments on new items (variables/functions/types) and update comments you saw that are no longer accurate
8. Ensure all new and edited comments follow these rules, deleting comments where appropriate:
  a. DO NOT describe WHAT is being done: the specs on related members/types should make the WHAT self-evident. For example, an `if (pipe.FlowLps > 0.1)` statement MUST NOT have a comment saying whether negative flow is included. Instead, the doc comment on FlowLps's definition should say whether it's signed. Exception: ONE-LINE summaries of BLOCKS of code are fine
  b. DO NOT write comments for fixed bugs or how things once were; only commit messages should talk about changes. For example, if you split `try { Presolve(...); Solve(...); }` into two try-catches, you MUST NOT write a comment saying "Presolve in a separate try block, so that a presolver bug is not misreported as solver not available". Exception: describing a bug in a regression test or why a design is awkward.
  c. WHEN IN DOUBT, DELETE THE COMMENT.
  d. Document parameters or return values iff their purpose is non-obvious without reading the function
  e. If an item is special-purpose (designed for use by only one module or type), mention what uses it.
  f. Doc comments on functions must use sentences: say "Gets number of children" not "Number of children"
  g. To reduce ambiguity, try describing an item with different words than the item's name uses. Real examples: a comment on `IEndpoint endpoint` says "Final destination of water flowing through current connection/entity."; comment on `BuildSingleProblem` says "Converts a set of ConnectionDBO into a SolverProblem"
  h. Use theory-of-mind to verify that comments make sense in context and are clear and unambiguous. Doc comments should be friendly by assuming the reader has little familiarity with other items (types/members), but to avoid wordiness, comments on logic and on private members SHOULD assume the reader is familiar with all 'summary' doc comments

If a newly identified issue is hard to avoid without a lot more code or work, the main agent must decide between these two options:

1. If a different solution now seems clearly better:
  - If user asked for this, explain the issue and ask how to proceed.
  - If you chose a poor solution, scrap it and redo implementation or planning

2. Otherwise, don't do the extra code/work. Instead write a comment about the issue in the code and explain the issue to the user.

### Debugging

1. Run tests and fix problems. If a problem is hard to avoid without a lot of extra code or work, see previous section.
2. If debugging via console logs, prefix logs with `???` to mark them temporary in case they are accidentally committed.

### End phase

1. Review the task list (TaskList). Any TPP step not checked off, do it now.
2. Create a new file in Transcripts/, writing in it a transcript of (1) the planning phase conversation, including user's messages verbatim but not thinking or research steps; (2) every question you asked, with its answer, and every assumption you proceeded on without an answer (timed-out or unasked), marked as such; (3) any relevant mermaid diagrams; (4) all text from the end phase. Naming convention: "YYYY-MM-DD Title from proposed commit message.md". Do not break out the transcript to a separate commit.
3. If no ticket number was provided, ask "To include a ticket number in the commit message, enter it now." with preset options "Don't commit yet" and "Commit without it".
4. Write the commit message as directed below
5. Make a commit by default, or write the commit message in chat if the user doesn't want to commit yet. If there are changes in the working tree that you (and subagent) didn't make, avoid committing those changes if you can, and write a heading "Polluted working tree" and summarize those other changes briefly (don't read mystery files for the sole purpose of make the summary, though). If you must include those changes in the commit, describe them in the commit message.

## Directives

### Prime directives

- Concise, elegant, reuseable and reused code are crucial to maximize agents' productivity. Concise does NOT mean minimizing newlines. Instead, follow the generalized DRY principle: factor code to avoid repeating patterns of any kind. When adding features, actively seek out similar functionality to find opportunities for code re-use. Make the code concise via in-function refactoring during the Second Pass. Do not without approval add large ancillary code blocks to handle special cases.
- Care about Separation of Concerns and Information Hiding
- To give reviewers a simpler diff, avoid unnecessary changes during tasks (but you can ignore added/removed BOMs)
- NEVER USE `as any`. DO NOT USE `: any`. AVOID `as unknown as`.

### Style directives

- Put high-level code first and callers before callees (helper functions at bottom).
  - Put nested functions at the bottom of the outer function or of the block it is called from.
- Renaming something? If the file has that name, rename it too.
- Wrap code before column 120 and comments before column 100
- Naming:
  - Use verb phrases for names of new functions: findFoo(), not fooLookup()
  - Affixes: XIfY() = do X in case of Y, TryX() = "do X if possible" or "does not throw on failure", MaybeX() = do X if a condition to complex to describe in an IfY suffix holds; XCore() = XCore is the "core" of X() which does ancillary tasks like checking permissions
  - Use Is/Are/Get prefix on getter functions, but React Components and fast property-like queries can use a noun: `double MinimumAt(timeIndex)`
  - Indicate whether transforms are in-place or not (`reverse()` vs `getReversed()`)
  - Very long names are OK on rarely-used symbols; very oft-used words/symbols can be abbreviated
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

### Other

- Use subagents more often when your task is large and context exceeds 100K tokens
- Unless you're on a dedicated temporary worktree, other agents may be working in the same tree so prefer not to stash and never switch branches when the user didn't explicitly ask for it
- By default, create a commit after completing a feature or bug fix, and offer to push it.

## Writing commit messages

Commit messages should mention

1. The task/issue number
2. *the goal* of the changes
3. *the reasons why* the changes were made (you can leave this out if the reasons are obvious. The reason to fix a bug or add a feature is usually obvious but the reason refactoring was needed is usually not and deserves a motivating explanation.)

### Structure

1. Subject line: `#<work item> <area>: <summary>`, where the optional area is a domain of substantial size e.g. TreeList (representing TreeList.tsx)
2. Superstructure: main, then Also; divide the work into a *main* work product and *ancillary* changes that the main work does not depend on, if any. Describe the main product first. Build each half independently by the rules below.

#### For each section

If it is one clear change, describe it in prose with no bullets, starting with motivation/use case, then how to use the UI if relevant, then the technical approach (mentioning real code symbols). If there are many related changes, start with an unbulleted paragraph summarizing the whole in this way, then give details as bullets. Ancillary changes follow under an `### Also` line.

When multiple bullets:

1. Plan a first draft of top-level bullets in a way that feels natural to you. Each bullet should start by saying which file(s) or class(es) were changed unless all changes are to the same file that was already mentioned.
  - For bugs, say what the bug caused, the circumstances required to trigger it, and then the bug's cause: "Bug fix: in [context], no error appeared if acquiring a lock failed because `msgBox` was uninitialized in the temporary `ViewModel`".
2. Improve the draft by merging or grouping similar/related bullets (e.g. those that share one rationale, that could only be done together, or that changed the same file).
  - Completely leave out trivial changes that don't affect the UI if their rationale is not worth recording, e.g. cleaning up `using` statements, improving a comment's wording, renaming something for clarity, or correcting a minor inefficiency.
  - Test: could a reviewer revert this bullet on its own? If not, merge it with others.
  - If there are multiple changes to the same file, consider grouping them under a `- FileName.ext:` bullet
  - Follow the usual communication directives
3. When a change C was done to help/enable/improve another change B, make C a child/sub-bullet of B (You can also break up a large bullet point into sub-bullets.) When C helps multiple other bullets, place C at the outer level immediately below the bullets to which it is subordinate and say something like "[Location]: To complete the N changes above it was necessary to [C]"
4. Identify bullets that are "internal", meaning changes that end-users wouldn't see, such as refactors, or fixes of theoretical non-reproduceable bugs. Show a separate section headed "Internal:" for those.

## Communication (verbatim)

Always write clearly, plainly, and unambiguously:

1. Prefer active voice to make the subject of each sentence explicit
2. Prefer unabbreviated code symbols over English paraphrase or pronouns: problems => `WordProblem`s
3. Be specific.
4. Don't use mannered prose, e.g. avoid "gate" and similar metaphors, and prioritize clarity over concision: "showMiniMap flows to SolverTab which now gates MiniMapPreview on it" => "HeaderBar sets the new showMiniMap prop on SolverTab, which shows a MiniMapPreview when it's true".
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
