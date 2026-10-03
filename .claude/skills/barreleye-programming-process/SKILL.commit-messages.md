---
name: bpp-commit-messages
description: How to write the commit message in the BPP End phase. Read it when you reach that step.
---

# Commit messages

Commit messages should mention

1. The task/issue/PBI number, if any (this repo has no work items) <!-- adapted for branch-review-studio -->
2. *the goal* of the changes
3. *the reasons why* the changes were made (you can leave this out if the reasons are obvious. The reason to fix a bug or add a feature is usually obvious but the reason refactoring was needed is usually not and deserves a motivating explanation.)

## Structure

1. Subject line: `<area>: <summary>`, where the optional area is a domain of substantial size e.g. Comments, MCP server, or Tree view. <!-- adapted for branch-review-studio: no work items or DB migrations here -->
2. Superstructure: main, then Also; divide the work into a *main* work product and *ancillary* changes that the main work does not depend on, if any. Describe the main product first. Build each half independently by the rules below.

### For each section

If it is one clear change, describe it in prose with no bullets, starting with motivation/use case, then how to use the UI if relevant, then the technical approach (mentioning real code symbols). If there are many related changes, start with an unbulleted paragraph summarizing the whole in this way, then give details as bullets. Ancillary changes follow under an `### Also` line.

#### When multiple bullets

1. Plan a first draft of top-level bullets in a way that feels natural to you. Each bullet should start by saying which file(s) or class(es) were changed unless all changes are to the same file that was already mentioned.
  - For bugs, say what the bug caused, the circumstances required to trigger it, and then the bug's cause: "Bug fix: in [context], no error appeared if acquiring a lock failed because `msgBox` was uninitialized in the temporary `ViewModel`".
  - Don't detail tests. Adding "(with tests)" on associated functionality suffices.
2. Improve the draft by merging or grouping similar/related bullets (e.g. those that share one rationale, that could only be done together, or that changed the same file).
  - Completely leave out trivial changes that don't affect the UI if their rationale is not worth recording, e.g. cleaning up `using` statements, improving a comment's wording, renaming something for clarity, or correcting a minor inefficiency.
  - Test: could a reviewer revert this bullet on its own? If not, merge it with others.
  - If there are multiple changes to the same file, consider grouping them under a `- FileName.ext:` bullet
  - Follow the usual communication directives
3. When a change C was done to help/enable/improve another change B, make C a child/sub-bullet of B (You can also break up a large bullet point into sub-bullets.) When C helps multiple other bullets, place C at the outer level immediately below the bullets to which it is subordinate and say something like "[Location]: To complete the N changes above it was necessary to [C]"
4. Arrange the bullets into sections in this order: "Extension", "MCP server", "Both" (for bullet points substantively spanning both), "Extension (internal)", "MCP server (internal)", "Both (internal)", "Other". Omit these headings iff one would be the sole section. Use "internal" sections for changes that end-users wouldn't see, such as refactors or fixes of theoretical non-reproduceable bugs. <!-- adapted for branch-review-studio -->
  - Include the file/type that was changed in the heading iff all bullets change the same file/type.

## Example: good

```
#1012 Bug fix: missing spinners and error messages during import

Spinners never appeared during entity import because the temporary
`ViewModelData` that import-sources-and-projects.tsx constructs left
`doWithSpinner` uninitialized.

### Also

C#:
- `ImportController.Import`: to report the lock holder instead of a generic 
  failure, return 409 when the scenario is locked by another user

TypeScript:
- ImportModal.tsx: report the import complete before editing locks are
  released, since the user has nothing left to wait for at that point
  - 3-caches/Utils.tsx: speed up releases by changing `releaseEditingLocks` 
    to release in parallel
- Bug fix in `ViewModel`: no error appeared if acquiring a lock failed during
 import because `msgBox` was uninitialized in temporary `ViewModel`s
- Bug fix in editing-management.ts: `getEntitiesInScenario` reported success
  when acquiring an editing lock failed (tested)

TypeScript (internal):
- collections.ts: `first(iterable)` was typed non-nullable but it returns
  undefined on an empty iterable
```

This does not mention _how_ the main bug was fixed because it's implied: import-sources-and-projects.tsx now inits `doWithSpinner`

## Example: bad

```
Improve import reliability and user feedback

Hardens the entity import flow and delivers consistent, responsive feedback
throughout long-running operations.

- Initialize spinner infrastructure in the temporary view model to ensure
  consistent loading feedback
- Make `doWithSpinner` available during the import lifecycle
- Streamline import completion so the success state is reached promptly
- Add progress indication during lock cleanup
- Parallelize lock release for improved performance
- Initialize message box support in the temporary view model for robust
  error surfacing
- Ensure lock acquisition failures propagate correctly to the user
- Return accurate completion status from `getEntitiesInScenario`
- Improve type safety of the `first()` helper
- Verified import flow end-to-end
```

- Way too vague throughout
- Not split into sections
- Locations/symbols are missing
- First and second bullet are mergeable
- Wordiness: "For improved performance" is what parallelizing always does.
- Missing info: "To ensure consistent loading feedback" restates what a spinner is for. The real content, that the field was uninitialized and spinners silently never appeared, is gone.
- Bugs are not clearly distinguished from features
- Hidden decision: Bullet 3 says "streamline" where the real change was a policy choice: stop waiting for lock release before declaring success; reader cannot tell behaviour changed.
- Slickness/mannered prose is bad: "Hardens", "delivers", "lifecycle", "robust".
