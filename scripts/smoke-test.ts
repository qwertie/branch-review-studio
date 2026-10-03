// Smoke test that runs inside a VS Code extension host (see scripts/run-smoke-test.mjs). It checks
// what unit tests can't: activation, the snapshot of a real repo, diff editors and comment saving.
// It prints PASS/FAIL lines; the workspace must be a repo with a sample review (see
// create-sample-review.ts). It adds one user thread to that review and deletes it again.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import type { BranchReviewStudioExports } from "../src/extension/extension";

export async function run(): Promise<void> {
  let failures = 0;
  let check = async (name: string, action: () => Promise<void> | void) => {
    try {
      await action();
      console.log(`PASS ${name}`);
    } catch (e) {
      failures++;
      console.log(`FAIL ${name}: ${e instanceof Error ? e.stack : e}`);
    }
  };

  let extension = vscode.extensions.getExtension<BranchReviewStudioExports>("barreleye.branch-review-studio");
  let model = (await extension?.activate())?.model;
  await check("activates and finds the repo", () => assert.ok(model, "model is undefined"));
  if (model) {
    await model.refresh();
    let snapshot = model.snapshot;
    console.log(`INFO branch=${snapshot.branch} base=${snapshot.mergeBase?.baseRef}@${snapshot.mergeBase?.mergeBaseSha} `
      + `files=${snapshot.changedFiles.length} threads=${snapshot.review?.threads.length}`);
    await check("snapshot has merge-base, changed files and located threads", () => {
      assert.ok(snapshot.mergeBase);
      assert.ok(snapshot.changedFiles.length > 0);
      assert.ok((snapshot.review?.threads.length ?? 0) > 0);
      for (let thread of snapshot.review?.threads ?? [])
        assert.equal(snapshot.threadLocations.get(thread.id)?.isOutdated, false, `thread ${thread.id} outdated`);
    });
    await check("Open All Changes opens a multi-diff editor", async () => {
      await vscode.commands.executeCommand("branchReviewStudio.openAllChanges");
      await delay(1500);
      let tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
      assert.ok(tabs.some(t => t.label.includes(" vs ")),
        `tabs: ${tabs.map(t => t.label).join(", ")}`);
    });
    let thread = snapshot.review!.threads[0];
    await check("Open File Diff opens base vs working file, base content served", async () => {
      await vscode.commands.executeCommand("branchReviewStudio.openThread", thread.id);
      await delay(1000);
      let input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(input instanceof vscode.TabInputTextDiff, "active tab is not a diff");
      assert.equal(input.original.scheme, "brs-base");
      assert.equal(input.modified.scheme, "file");
      let original = await vscode.workspace.openTextDocument(input.original);
      assert.ok(original.lineCount > 1, "base document is empty");
      let editor = vscode.window.activeTextEditor;
      console.log(`INFO active editor=${editor?.document.uri.toString()} selectionLine=${editor?.selection.active.line}`);
    });
    await check("settings relevant to inline diff and sticky scroll", () => {
      let config = vscode.workspace.getConfiguration();
      console.log(`INFO diffEditor.renderSideBySide=${config.get("diffEditor.renderSideBySide")} `
        + `editor.stickyScroll.enabled=${config.get("editor.stickyScroll.enabled")} `
        + `diffEditor.useInlineViewWhenSpaceIsLimited=${config.get("diffEditor.useInlineViewWhenSpaceIsLimited")}`);
      console.log(`INFO inspect renderSideBySide=${JSON.stringify(config.inspect("diffEditor.renderSideBySide"))}`);
    });
    await check("createThread and reply save user comments; delete removes the thread", async () => {
      let before = snapshot.review!.threads.length;
      let uri = vscode.Uri.file(model.getFullPath(thread.file));
      let draft = { uri, range: new vscode.Range(2, 0, 2, 0), dispose: () => {} };
      await vscode.commands.executeCommand("branchReviewStudio.createThread", { thread: draft, text: "smoke test" });
      let added = model.snapshot.review!.threads.at(-1)!;
      assert.equal(model.snapshot.review!.threads.length, before + 1);
      assert.equal(added.comments[0].body, "smoke test");
      assert.equal(added.anchor.startLine, 3);
      assert.equal(added.comments[0].author.kind, "user");
      console.log(`INFO user comment author=${added.comments[0].author.name}`);
      await model.modifyReview(review => {
        review.threads = review.threads.filter(t => t.id !== added.id);
      });
      assert.equal(model.snapshot.review!.threads.length, before);
    });
  }
  if (model && process.env.BRS_SCREENSHOT_DIR)
    await captureScreenshots(model, process.env.BRS_SCREENSHOT_DIR);
  console.log(failures === 0 ? "SMOKE TEST PASSED" : `SMOKE TEST FAILED (${failures})`);
  if (failures > 0)
    throw new Error(`${failures} smoke checks failed`);
}

/** Saves screenshots of the review UI in side-by-side and inline diff modes (dev aid; agents can't see the UI). */
async function captureScreenshots(model: NonNullable<BranchReviewStudioExports["model"]>, dir: string) {
  let thread = model.snapshot.review!.threads.reduce((a, b) => a.anchor.startLine >= b.anchor.startLine ? a : b);
  await vscode.commands.executeCommand("workbench.view.extension.branchReviewStudio");
  for (let [mode, sideBySide] of [["side-by-side", true], ["inline", false]] as const) {
    await vscode.workspace.getConfiguration().update("diffEditor.renderSideBySide", sideBySide,
      vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("branchReviewStudio.openThread", thread.id);
    await delay(1500);
    let line = model.snapshot.threadLocations.get(thread.id)!.startLine - 1;
    vscode.window.activeTextEditor?.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
    await delay(2500);
    capture(path.join(dir, `diff-${mode}.png`));
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("branchReviewStudio.openAllChanges");
  await delay(4000);
  capture(path.join(dir, "all-changes.png"));

  function capture(outFile: string) {
    let script = path.join(__dirname, "..", "scripts", "capture-window.ps1");
    console.log(execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-OutFile", outFile], { encoding: "utf8" }).trim());
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
