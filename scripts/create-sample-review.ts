// Creates a sample review for the current branch of a repo, so that the extension's tree view and
// comment threads can be tried without asking an agent for a review. Usage (from this repo's root):
//   npm run sample-review -- <path-to-repo> [--force]
// It writes only to <git-common-dir>/branch-review-studio/reviews/<branch>.json.
import * as path from "node:path";
import { createAnchor } from "../src/core/anchoring";
import { readFileLines } from "../src/core/files";
import {
  ChangedFile, findMergeBase, findRepoRoot, getChangedFiles, getCurrentBranch, getGitCommonDir, runGit,
} from "../src/core/git";
import { addComment, addThread, createReview, DiffSide, Review, Severity } from "../src/core/review";
import { ReviewStore } from "../src/core/store";

const claude = { kind: "agent" as const, name: "Claude" };

void main().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

async function main(): Promise<void> {
  let repoArg = process.argv.slice(2).find(arg => !arg.startsWith("--")) ?? process.cwd();
  let force = process.argv.includes("--force");
  let repoRoot = await findRepoRoot(path.resolve(repoArg));
  let branch = repoRoot && await getCurrentBranch(repoRoot);
  if (repoRoot === undefined || branch === undefined)
    throw new Error(`${repoArg} is not in a git repo with a branch checked out.`);
  let baseBranch = "develop";
  let mergeBase = await findMergeBase(repoRoot, baseBranch);
  // Prefer source files, where sticky scroll has class/method lines to show
  let isSourceFile = (f: ChangedFile) => /\.(cs|tsx?|dart)$/.test(f.path);
  let changedFiles = (await getChangedFiles(repoRoot, mergeBase.mergeBaseSha)).filter(f => f.status !== "Deleted")
    .sort((a, b) => Number(isSourceFile(b)) - Number(isSourceFile(a)));
  let store = new ReviewStore(await getGitCommonDir(repoRoot));
  if (!force && await store.readReview(branch))
    throw new Error(`Branch '${branch}' already has a review. Use --force to replace it.`);

  let review = createReview(branch, baseBranch, mergeBase.mergeBaseSha);
  review.summary = "**Sample review** created by scripts/create-sample-review.ts. "
    + `It has threads on ${Math.min(changedFiles.length, 3)} changed files.`;
  let samples: [Severity, string][] = [
    ["Major", "This sample finding is on the first changed line of the file. **Markdown** works: `code`."],
    ["Minor", "A minor sample finding. Reply to it, then try Resolve."],
    ["Note", "A note-level sample comment."],
  ];
  for (let [i, file] of changedFiles.slice(0, samples.length).entries()) {
    let [severity, body] = samples[i];
    await addSampleThread(review, repoRoot, mergeBase.mergeBaseSha, file, "modified", severity, body);
  }
  let modifiedFile = changedFiles.find(f => f.status === "Modified");
  if (modifiedFile) {
    let thread = await addSampleThread(review, repoRoot, mergeBase.mergeBaseSha, modifiedFile, "base", "Minor",
      "A sample thread on the **base** (merge-base) side, at the first removed or changed line.");
    addComment(review, thread, { kind: "user", name: "Sample User" }, "A sample reply from a user.");
    thread.status = "resolved";
  }
  await store.updateReview(branch, () => review);
  console.log(`Wrote ${review.threads.length} threads to ${store.getReviewPath(branch)}`);
}

async function addSampleThread(review: Review, repoRoot: string, mergeBaseSha: string, file: ChangedFile,
  side: DiffSide, severity: Severity, body: string) {
  let lines = await readFileLines(repoRoot, side === "base" ? file.oldPath ?? file.path : file.path, side,
    mergeBaseSha);
  let line = await findFirstChangedLine(repoRoot, mergeBaseSha, file, side);
  let anchor = createAnchor(lines ?? [], line, line);
  return addThread(review, { file: file.path, side, anchor, severity, author: claude, body });
}

/** Finds the first line of the file's first diff hunk on the given side (1 for untracked files). */
async function findFirstChangedLine(repoRoot: string, mergeBaseSha: string, file: ChangedFile, side: DiffSide) {
  let diff = await runGit(repoRoot, ["diff", "-U0", mergeBaseSha, "--", file.path]);
  let match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/m.exec(diff);
  return Math.max(1, match ? Number(side === "base" ? match[1] : match[2]) : 1);
}
