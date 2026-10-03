---
name: barreleye-programming-process
description: Always read this "BPP" before writing code
---

## The Barreleye Programming Process (BPP) ##

FOLLOW THIS PROCESS unless asked to "bypass" it or "prototype".

### Ask questions during planning and implementation

Agents tend to assume too much, likely because their only options are "make an assumption and continue" or "ask a question and block indefinitely". A timed question is the third option: state your default in chat, ask, and wait a length of time you choose. <!-- adapted for branch-review-studio: the ask_with_timeout skill is not in this repo -->

If developer has their own skill for timed questions, use that instead.

### Planning phase

Gather info as usual. When not asked to plan, do some planning anyway:

- If the task seems really large, view README.md in repo root for more background and philosophy. <!-- adapted for branch-review-studio --> Sometimes, Transcripts/ will have previous agent conversations related to the task.
- After researching, if the user's request still seems ambiguous/confusing/vague, or if the user said anything that doesn't make sense, STOP and ask user to clarify.
- Look for multiple ways to fulfill the user's request. For each decision point where you see two or more distinctly different approaches, consider if one is clearly the best. If not, write an outline of each approach and ask user for guidance.
- Do not make major assumptions without confirmation. If you see a way to accomplish a task by making changes that might suprise the user, or that might seem out of scope to the user, STOP and ask for confirmation before proceeding.
- After all that, write out a plan, including tests to be written. Make the plan detailed in Plan Mode, brief in Agent Mode, but specific in both. Ask user to confirm or refine.
- Once the plan is confirmed, create a task list (TaskCreate) with one task per implementation item plus these: "Second pass", "Tests pass", and one task per End phase step. Check tasks off as you go; the End phase begins by reviewing the list.

Questions in any phase follow the timed-question protocol described above. <!-- adapted for branch-review-studio --> "STOP and ask" above means a blocking question; most other questions should be timed ones.

### Testing

Do TDD with vitest tests (can skip this for cosmetic changes & pure refactors) <!-- adapted for branch-review-studio -->

- Use existing helper functions to make domain objects (e.g. the temp-repo helpers in src/core tests). <!-- adapted for branch-review-studio -->
- Make new helper functions to avoid code duplication or verbose tests
- Bug fix tests are named `Bug_YYYY_MM_X` or `Regression_YYYY_MM_X` where X is what went wrong or must happen, e.g. `Bug_2026_01_CouldNotDeserialize`
- Verify that new tests fail unless you're already sure

### Implementation phase

While making changes:

- "When in Rome": mimic existing patterns.
- Use frequently-used functions/types where applicable. Unless your task is tiny or is just debugging, skim src/core/ to learn what's available. <!-- adapted for branch-review-studio -->
- Do not make major assumptions without confirmation. If necessary, stop and ask questions in the middle of implementation. Small assumptions are what timed questions are for: ask, keep working on independent parts, and check the answer before the dependent part.
- If, as you work, you notice pre-existing code that is confusing or buggy, highlight this code to the user, but only fix it if it's very clearly wrong.

### Second pass

Use a subagent to review the code you just wrote, but start by giving the subagent minimal context: instruct it to read the main AGENTS.md, and the diff hunks themselves, plus some basic context that including the name of the class and function(s) being modified and a few relevant lines of code above, but not below, the changes. Limiting context is deliberate because the subagent is asked to notice things that are unclear when broad context is missing. Also direct it to read SKILL.second-pass.md in this skill's folder, which you need not read yourself.

The subagent should call you back to get your user's original prompts, Q&A, and user-approved final plan if any, to help it finish the review. It'll report its changes and any unresolved fundings.

If it found an issue that is hard to avoid without a lot more code or work,

1. If a different solution now seems clearly better:
  - If user asked for the current solution in particular, explain the issue and ask how to proceed.
  - If you chose a poor solution, scrap it and redo implementation or planning

2. Otherwise, don't do the extra code/work. Instead write a comment about the issue in the code and explain the issue to the user.

### Debugging

1. Run tests and fix problems. If a problem is hard to avoid without a lot of extra code or work, see previous section.
2. If debugging via console logs, prefix logs with `???` to mark them temporary in case they are accidentally committed.

### End phase

1. Review the task list (TaskList). Any BPP step not checked off, do it now.
2. Create a new file in Transcripts/, writing in it a transcript of (1) the planning phase conversation, including user's messages verbatim but not thinking or research steps; (2) every question you asked, with its answer, and every assumption you proceeded on without an answer (timed-out or unasked), marked as such; (3) any relevant mermaid diagrams; (4) all text from the end phase. Naming convention: "YYYY-MM-DD Title from proposed commit message.md". Do not break out the transcript to a separate commit.
3. Learned anything interesting that your skills/AGENTS.md didn't tell you? Want to "remember" something? Save it in your agent-wiki.
4. Ask whether to commit now, with preset options "Commit" and "Don't commit yet". <!-- adapted for branch-review-studio: this repo has no work items -->
4. Write the commit message following SKILL.commit-messages.md (read it now)
5. Make a commit by default, or write the commit message in chat if the user doesn't want to commit yet. If there are changes in the working tree that you (and subagent) didn't make, avoid committing those changes if you can, and write a heading "Polluted working tree" and summarize those other changes briefly (don't read mystery files for the sole purpose of make the summary, though). If you must include those changes in the commit, describe them in the commit message.
6. Write brief release notes for a nontechnical audience. For changes that are substantial but not user-visible (e.g. migrations), copy "Internal" parts from commit message.
