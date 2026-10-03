// Smoke test that runs inside a VS Code extension host (see scripts/run-smoke-test.mjs). It checks
// what unit tests can't: activation, the snapshot of a real repo, diff editors and comment saving.
// It prints PASS/FAIL lines; the workspace must be a repo with a sample review (see
// create-sample-review.ts). It adds one user thread to that review and deletes it again.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AgentRunMode, AgentSessionMode, getAgentChoices } from "../src/core/agent-commands";
import { ChangedFile, getBaseBranchChoices, getFileAtRevision, listBranches, MergeBaseInfo } from "../src/core/git";
import { applyHunks, DiffHunk, readDiffHunks } from "../src/core/hunks";
import { AgentKind, createReview, findLatestSession } from "../src/core/review";
import { ReviewStore } from "../src/core/store";
import type { BranchReviewStudioExports } from "../src/extension/extension";
import { ReviewTools } from "../src/mcp/review-tools";

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

  let extension = vscode.extensions.getExtension<BranchReviewStudioExports>("qwertie.branch-review-studio");
  let model = (await extension?.activate())?.model;
  await check("activates and finds the repo", () => assert.ok(model, "model is undefined"));
  if (model && process.env.BRS_SMOKE_FRESH_REPO) {
    await check("creates the review folder lazily; the watcher sees a review written by another process",
      async () => {
        assert.equal(fs.existsSync(model.store.dir), false, "store folder exists after activation");
        await new ReviewStore(path.dirname(model.store.dir)).updateReview(model.snapshot.branch!,
          () => createReview(model.snapshot.branch!, "develop", "abc"));
        await delay(4000);
        assert.ok(model.snapshot.review, "the model did not pick up the new review");
      });
  } else if (model) {
    await model.refresh();
    let snapshot = model.snapshot;
    let base = snapshot.mergeBase;
    console.log(`INFO branch=${snapshot.branch} base=${base?.baseRef}@${base?.mergeBaseSha} `
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
      console.log(`INFO active editor=${editor?.document.uri.toString()} `
        + `selectionLine=${editor?.selection.active.line}`);
    });
    await check("review_set_groups: the tree shows groups; group views show only their hunks", () =>
      checkGroups(model));
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
    await check("changeBaseBranch stores the base and its merge-base in the review; changing back restores them",
      async () => {
        let originalBase = model.baseBranch;
        let otherBase = getBaseBranchChoices(await listBranches(model.repoRoot), originalBase, snapshot.branch)[1];
        assert.ok(otherBase, "the test repo needs a second branch to use as a base");
        for (let base of [otherBase, originalBase]) {
          await model.changeBaseBranch(base);
          let mergeBase: MergeBaseInfo | undefined = model.snapshot.mergeBase;
          console.log(`INFO base=${base} baseRef=${mergeBase?.baseRef} mergeBase=${mergeBase?.mergeBaseSha}`);
          assert.equal(model.snapshot.review?.baseBranch, base);
          assert.equal(model.snapshot.review?.mergeBaseSha, mergeBase?.mergeBaseSha);
          assert.ok(mergeBase?.baseRef.endsWith(base), `baseRef ${mergeBase?.baseRef}`);
        }
        assert.equal(model.snapshot.mergeBase?.mergeBaseSha, snapshot.mergeBase?.mergeBaseSha);
      });
    if (process.env.BRS_SMOKE_ASK_AGENT) {
      await check("Ask Agent (fork, background) puts Claude's answer in the thread", async () => {
        let added = await askAgentOnNewThread(model, getChoiceIndex(model, "claude", "fork", "background"),
          "Smoke test: in one short sentence, what is this line about? Answer via review_reply.");
        let review = model.snapshot.review!;
        console.log(`INFO thread comments: ${JSON.stringify(added.comments.map(c => [c.author.name, c.body]))}`);
        console.log(`INFO sessions: ${JSON.stringify(review.sessions)}`);
        assert.ok(added.comments.length >= 2 && added.comments.at(-1)!.author.kind === "agent", "no agent answer");
        assert.ok(review.sessions.some(s => s.role === "followup"), "no follow-up session recorded");
      });
      await check("Ask Agent (fork, interactive) opens a Claude terminal", async () => {
        await askAgentOnNewThread(model, getChoiceIndex(model, "claude", "fork", "interactive"), "Smoke test "
          + "(interactive): in one short sentence, what is this line about?\nSecond line of the message, to check "
          + "multi-line arguments.");
        await delay(6000);
        let terminal = vscode.window.terminals.at(-1);
        let terminalNames = vscode.window.terminals.map(t => t.name);
        assert.ok(terminal && terminal.name.startsWith("Claude:"), `terminals: ${terminalNames}`);
        await delay(20000);
        assert.equal(terminal.exitStatus, undefined, `claude exited: ${JSON.stringify(terminal.exitStatus)}`);
        if (process.env.BRS_SCREENSHOT_DIR)
          captureWindow(path.join(process.env.BRS_SCREENSHOT_DIR, "ask-agent-interactive.png"));
      });
    }
    if (process.env.BRS_SMOKE_CODEX)
      await checkCodex(model, check);
  }
  await check("Settings and Integrations opens the Branch Review Studio panel", async () => {
    await vscode.commands.executeCommand("branchReviewStudio.openSettings");
    await delay(8000);
    let tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.ok(tabs.some(t => t.label === "Branch Review Studio" && t.input instanceof vscode.TabInputWebview),
      `tabs: ${tabs.map(t => t.label).join(", ")}`);
    if (process.env.BRS_SCREENSHOT_DIR) {
      // Makes room so that the screenshot shows the whole panel
      for (let command of ["workbench.action.closePanel", "workbench.action.closeSidebar",
        "workbench.action.closeAuxiliaryBar", "workbench.action.zoomOut", "workbench.action.zoomOut"])
        await vscode.commands.executeCommand(command);
      await delay(1500);
      captureWindow(path.join(process.env.BRS_SCREENSHOT_DIR, "settings-panel.png"));
      await vscode.commands.executeCommand("workbench.action.zoomReset");
    }
  });
  if (model && process.env.BRS_SCREENSHOT_DIR)
    await captureScreenshots(model, process.env.BRS_SCREENSHOT_DIR);
  console.log(failures === 0 ? "SMOKE TEST PASSED" : `SMOKE TEST FAILED (${failures})`);
  if (failures > 0)
    throw new Error(`${failures} smoke checks failed`);
}

/**
 * Runs Ask Agent with Codex twice, which spends tokens: a fresh background session that calls
 * review_begin (so it becomes the latest review session), then a background fork of that session.
 * Then removes the threads and sessions that the checks added. BRS_SMOKE_CODEX_PATH can name the
 * Codex CLI, since the throwaway profile lacks the Codex extension and its newer bundled CLI.
 */
async function checkCodex(model: Model, check: (name: string, action: () => Promise<void>) => Promise<void>) {
  if (process.env.BRS_SMOKE_CODEX_PATH) {
    await vscode.workspace.getConfiguration("branchReviewStudio").update("codexPath",
      process.env.BRS_SMOKE_CODEX_PATH, vscode.ConfigurationTarget.Global);
  }
  let originalSessionIds = new Set(model.snapshot.review!.sessions.map(s => s.sessionId));
  let addedThreadIds: string[] = [];
  let reviewSessionId: string | undefined;
  await check("Ask Agent (Codex, fresh, background): Codex answers and its thread id is recorded", async () => {
    let added = await askAgentOnNewThread(model, getChoiceIndex(model, "codex", "fresh", "background"),
      "Smoke test: call the review_begin tool without arguments, then answer this thread via review_reply with "
      + "the single word 'begun'.");
    addedThreadIds.push(added.id);
    let sessions = model.snapshot.review!.sessions.filter(s => !originalSessionIds.has(s.sessionId));
    console.log(`INFO thread comments: ${JSON.stringify(added.comments.map(c => [c.author.name, c.body]))}`);
    console.log(`INFO new sessions: ${JSON.stringify(sessions)}`);
    assert.equal(added.comments.at(-1)?.author.name, "Codex", "no Codex answer");
    reviewSessionId = sessions.find(s => s.agent === "codex" && s.role === "review")?.sessionId;
    assert.ok(reviewSessionId, "review_begin did not record a Codex review session");
  });
  await check("Ask Agent (Codex, fork, background) forks the Codex review session", async () => {
    assert.equal(findLatestSession(model.snapshot.review!, "review")?.agent, "codex");
    let added = await askAgentOnNewThread(model, getChoiceIndex(model, "codex", "fork", "background"),
      "Smoke test: in one short sentence, which tool did you call in the previous turn? Answer via review_reply.");
    addedThreadIds.push(added.id);
    let answer = added.comments.at(-1)!;
    console.log(`INFO thread comments: ${JSON.stringify(added.comments.map(c => [c.author.name, c.body]))}`);
    assert.equal(answer.author.name, "Codex", "no Codex answer");
    assert.ok(answer.sessionId && answer.sessionId !== reviewSessionId, `answer session ${answer.sessionId}`);
    assert.ok(model.snapshot.review!.sessions.some(s => s.sessionId === answer.sessionId && s.agent === "codex"
      && s.role === "followup"), "the fork was not recorded as a Codex follow-up session");
  });
  await model.modifyReview(review => {
    review.threads = review.threads.filter(t => !addedThreadIds.includes(t.id));
    review.sessions = review.sessions.filter(s => originalSessionIds.has(s.sessionId));
  });
}

/**
 * Posts groups with ReviewTools (as the MCP server would): the first and the other hunks of a
 * modified file with several hunks go into groups "first" and "rest", and every other changed file
 * into "rest". Checks the tree's layout and both kinds of diff editors, then restores the review's
 * previous groups.
 */
async function checkGroups(model: Model) {
  let { changedFiles, mergeBase } = model.snapshot;
  let split: { file: ChangedFile, hunks: DiffHunk[] } | undefined;
  for (let file of changedFiles.filter(f => f.status === "Modified")) {
    let hunks = await readDiffHunks(model.repoRoot, mergeBase!.mergeBaseSha, file);
    if (split === undefined && hunks.length >= 2 && hunks[0].newLines.length > 0)
      split = { file, hunks };
  }
  assert.ok(split, "the test repo needs a modified file with two or more hunks");
  let firstHunk = split.hunks[0];
  let previousGroups = model.snapshot.review!.changeGroups;
  let tools = new ReviewTools({ cwd: model.repoRoot, sessionId: undefined, agent: "claude", agentName: "Claude" });
  try {
    let result = await tools.setGroups({ groups: [{ id: "first", name: "Smoke: first hunk", summary: "The **first** "
      + "hunk of a file with several hunks; this summary is long enough to be wrapped onto two lines in the tree." },
    { id: "rest", name: "Smoke: the rest", summary: "Everything else." }],
    files: changedFiles.map(f => f === split.file ? { file: f.path, groups: [
      { groupId: "first", ranges: [{ startLine: firstHunk.newStart, endLine: firstHunk.newStart }] },
      { groupId: "rest", ranges: split.hunks.slice(1).map(h => ({ startLine: Math.max(h.newStart, 1),
        endLine: Math.max(h.newStart + h.newLines.length - 1, h.newStart, 1) })) }] }
      : { file: f.path, groups: [{ groupId: "rest" }] }) });
    console.log(`INFO review_set_groups: ${result}`);
    await model.refresh();
    let layout = model.snapshot.groupLayout;
    console.log(`INFO layout: ${JSON.stringify(layout?.groups.map(g => [g.name, g.changedLines, g.files.length]))}`);
    let firstGroup = layout?.groups.find(g => g.id === "first");
    assert.deepEqual(firstGroup?.files, [{ path: split.file.path, isPartial: true }]);
    assert.ok(layout?.groups.find(g => g.id === "rest")?.files.some(f => f.path === split.file.path && f.isPartial));

    await vscode.commands.executeCommand("branchReviewStudio.openGroupChanges", firstGroup);
    await delay(1500);
    let tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.ok(tabs.some(t => t.label.includes("Smoke: first hunk")), `tabs: ${tabs.map(t => t.label).join(", ")}`);
    await vscode.commands.executeCommand("branchReviewStudio.openFileDiff", split.file.path,
      { groupId: "first", groupName: firstGroup!.name });
    await delay(1000);
    let input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, "active tab is not a diff");
    assert.equal(input.original.scheme, "brs-group");
    let viewText = (await vscode.workspace.openTextDocument(input.original)).getText();
    let baseText = await getFileAtRevision(model.repoRoot, mergeBase!.mergeBaseSha, split.file.path) ?? "";
    let expected = applyHunks(baseText, split.hunks.slice(1));
    assert.equal(viewText.replace(/\r\n/g, "\n"), expected.replace(/\r\n/g, "\n"),
      "the first group's view should apply every hunk but the first");
    if (process.env.BRS_SCREENSHOT_DIR) {
      await vscode.commands.executeCommand("workbench.view.extension.branchReviewStudio");
      await delay(2000);
      captureWindow(path.join(process.env.BRS_SCREENSHOT_DIR, "groups.png"));
    }
  } finally {
    await model.modifyReview(review => {
      review.changeGroups = previousGroups;
    });
  }
}

/** Gets the index of an Ask Agent QuickPick item for a new thread, if both agents are found. */
function getChoiceIndex(model: Model, agent: AgentKind, sessionMode: AgentSessionMode, runMode: AgentRunMode) {
  let forkableAgent = findLatestSession(model.snapshot.review!, "review")?.agent;
  return getAgentChoices(["claude", "codex"], forkableAgent)
    .findIndex(c => c.agent === agent && c.sessionMode === sessionMode && c.runMode === runMode);
}

type Model = NonNullable<BranchReviewStudioExports["model"]>;

/**
 * Saves screenshots of the review UI in side-by-side and inline diff modes, so that agents can see
 * the UI.
 */
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
    let range = new vscode.Range(line, 0, line, 0);
    vscode.window.activeTextEditor?.revealRange(range, vscode.TextEditorRevealType.InCenter);
    await delay(2500);
    captureWindow(path.join(dir, `diff-${mode}.png`));
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("branchReviewStudio.openAllChanges");
  await delay(4000);
  captureWindow(path.join(dir, "all-changes.png"));
}

/**
 * Runs Ask Agent on a new thread at line 54 of the sample's SolverIssue.cs (or line 3 of the first
 * thread's file), picking the QuickPick item at `choiceIndex`; returns the saved thread.
 */
async function askAgentOnNewThread(model: NonNullable<BranchReviewStudioExports["model"]>, choiceIndex: number,
  text: string) {
  let threads = model.snapshot.review!.threads;
  let file = threads.find(t => t.file.endsWith("SolverIssue.cs"))?.file ?? threads[0].file;
  let line = file.endsWith("SolverIssue.cs") ? 53 : 2;
  let range = new vscode.Range(line, 0, line, 0);
  let draft = { uri: vscode.Uri.file(model.getFullPath(file)), range, dispose() {} };
  let pending = vscode.commands.executeCommand("branchReviewStudio.askAgent", { thread: draft, text });
  await delay(1500);
  for (let i = 0; i < choiceIndex; i++)
    await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await pending;
  await model.refresh();
  return model.snapshot.review!.threads.findLast(t => t.comments[0].body === text)!;
}

/** Saves a PNG of the Extension Development Host window. */
function captureWindow(outFile: string) {
  let script = path.join(__dirname, "..", "scripts", "capture-window.ps1");
  console.log(execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-OutFile", outFile], { encoding: "utf8" }).trim());
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
