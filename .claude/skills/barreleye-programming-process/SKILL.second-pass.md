---
name: bpp-second-pass
description: Instructions for a subagent performing a second pass during the Barreleye Programming Process (BPP)
---

Follow these steps when you've been asked to review code that was just written.

0. You should have been given AGENTS.md and diff hunks with limited context. Limited context is deliberate because you'll start by finding things that are unclear without broad context. However, read README.md if background information about the project might help you understand the changes. <!-- adapted for branch-review-studio -->
1. Based only on the hunks provided (no tool calls), write your first impressions of anything being unclear or poorly communicated in comments or names: a buried lede, a vague/ambiguous reference, a vague/ambiguous term, an obscure term, a noun where a sentence belongs, failure to use active voice, a transitive verb without an object, a statement that lacks an obvious connection to the code right before/after it, a statement whose raison d'etre isn't clear until reading further down, a statement in front of an `if` that doesn't clearly distinguish whether it describes the current situation or the situation that would be true if the condition is met, etc. You'll re-evaluate this list later.
2. Ask your parent agent for the user's original prompts, Q&A, and user-approved final plan if any. If you can't call the parent from your environment (so you must end your turn to send a message), just save your notes in a temporary file, report your inability to send messages together with a link to your notes, and ask the parent agent to create another subagent to resume from step 3.
3. Read relevant files as you normally would to understand the context around the changes.
4. Look for inelegancy (such as repetition) and ways to write the new code more concisely, e.g. combine this example into one LoC:

        var theFoo = GetFoo(x);
        return Bar(theFoo).Baz;

5. Follow prime directives from AGENTS.md.
6. Follow style & other directives from AGENTS.md.
7. Rename things whose changed behavior invalidates their name.
8. Check if you can see any bugs.
9. If something weird is done justifiably (e.g. violating common programming principles like information hiding, separation of concerns or generalized DRY), ensure there is a comment to explain why. If unjustified fix or complain (see below).
10. Ensure new items have doc comments (variables/functions/types) and that inaccurate comments are updated.
11. Ensure all new and edited comments follow these rules for human legibility:
  a. DO NOT describe WHAT is being done: the specs on related members/types should make the WHAT self-evident. For example, an `if (pipe.FlowLps > 0.1)` statement MUST NOT have a comment saying whether negative flow is included. Instead, the doc comment on FlowLps's definition should say whether it's signed. Exception: ONE-LINE summaries of BLOCKS of code are fine.
  b. DO NOT permit comments for fixed bugs or how things once were; only commit messages should talk about changes. For example, if `try { Presolve(...); Solve(...); }` was split into two try-catches, there MUST NOT be a comment saying "Presolve in a separate try block, so that a presolver bug is not misreported as solver not available". Exception: describing a bug in a regression test, or why a design is awkward.
  c. When in doubt, omit the comment.
  d. Consider each of your notes from step 0 and decide which points still need addressing while keeping the following in mind: (i) doc comments should be friendly by assuming the reader has little familiarity with other items (types/members). (ii) to avoid wordiness, all other comments SHOULD assume the reader knows frequently-used vocabulary and is familiar with doc comments on symbols used in the code that the comment describes (since IDEs let humans locate such members' doc comments easily), but they SHOULD NOT rely on obscure terms (hilltop > crest), paraphrases that hinder lookup (MaxFlowLps > max flow), or obscure facts about obscure members.
  e. Document parameters or return values iff their purpose is non-obvious without reading the function (except if the function is a one-liner; the reader can see it for themselves)
  f. If an item is special-purpose (designed for use by only one module or type), its comment should mention what uses it.
  g. Doc comments on functions must use sentences: say "Gets elevations of pumps" not "Elevations of pumps"
  h. To reduce ambiguity, try describing an item with different words than the item's name uses. Real examples: a comment on `IEndpoint endpoint` says "Final destination of water flowing through current connection/entity."; comment on `BuildSingleProblem` says "Converts a set of ConnectionDBO into a SolverProblem"
<!-- adapted for branch-review-studio: removed rule i about items duplicated from C# -->

Edit files whenever you see how something should be improved. Then tell the parent agent which files you changed, and what issues you found but left alone.
