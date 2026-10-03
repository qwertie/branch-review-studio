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
import { createAnchor } from "../src/core/anchoring";
import { ChangedFile, getBaseBranchChoices, getFileAtRevision, listBranches, MergeBaseInfo } from "../src/core/git";
import { applyHunks, DiffHunk, readDiffHunks } from "../src/core/hunks";
import { addThread, createReview, findLatestSession, formatCount, IntegrationId } from "../src/core/review";
import { listChangesEntries, listThreadVisits, ThreadVisit } from "../src/core/review-outline";
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
  let exports = await extension?.activate();
  let model = exports?.model;
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
    await check("review_set_groups: the view shows groups; group views show only their hunks", () =>
      checkGroups(model));
    await checkReviewUi(model, exports!, check);
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
  await check("the panel's VS Code Language Models section states its limits and shows the models", async () => {
    let models = await vscode.lm.selectChatModels();
    console.log(`INFO language models: ${JSON.stringify(models.map(m => [m.vendor, m.id, m.name, m.maxInputTokens]))}`);
    let html = exports?.getSettingsPanelHtml() ?? "";
    if (process.env.BRS_SCREENSHOT_DIR)
      fs.writeFileSync(path.join(process.env.BRS_SCREENSHOT_DIR, "settings-panel.html"), html);
    for (let text of ["VS Code Language Models", "<b>can't</b> run branch reviews", "Choose Model…",
      "Reviews need Claude Code or Codex", models.length === 0 ? "No models available"
        : `${formatCount(models.length, "model")} available`])
      assert.ok(html.includes(text), `the panel lacks "${text}"`);
  });
  if (model && process.env.BRS_SMOKE_LM)
    await checkLanguageModelAnswer(model, check);
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
 * Runs Ask Agent with a VS Code language model (the last QuickPick item), which spends tokens and
 * may show VS Code's permission prompt, then removes the thread that it added.
 */
async function checkLanguageModelAnswer(model: Model,
  check: (name: string, action: () => Promise<void>) => Promise<void>) {
  await check("Ask Agent (VS Code language model) posts the model's answer", async () => {
    assert.ok((await vscode.lm.selectChatModels()).length > 0, "no language models are available");
    let added = await askAgentOnNewThread(model, getChoiceIndex(model, "languageModel", "fresh", "background"),
      "Smoke test: in one short sentence, what is this line about?");
    console.log(`INFO thread comments: ${JSON.stringify(added.comments.map(c => [c.author.name, c.body]))}`);
    await model.modifyReview(review => {
      review.threads = review.threads.filter(t => t.id !== added.id);
    });
    assert.ok(added.comments.at(-1)?.author.name.endsWith("(VS Code LM)"), "no answer from the model");
  });
}

/**
 * Posts groups (see postSmokeGroups) with every other changed file in "rest". Checks the groups'
 * layout and both kinds of diff editors, then restores the review's previous groups.
 */
async function checkGroups(model: Model) {
  let { changedFiles, mergeBase } = model.snapshot;
  let split = await findSplitFile(model);
  let previousGroups = model.snapshot.review!.changeGroups;
  try {
    await postSmokeGroups(model, split, changedFiles);
    let layout = model.snapshot.groupLayout;
    console.log(`INFO layout: ${JSON.stringify(layout?.groups.map(g => [g.name, g.changedLines, g.files.length]))}`);
    let firstGroup = layout?.groups.find(g => g.id === "first");
    assert.deepEqual(firstGroup?.files, [{ path: split.file.path, isPartial: true }]);
    assert.ok(layout?.groups.find(g => g.id === "rest")?.files.some(f => f.path === split.file.path && f.isPartial));

    await vscode.commands.executeCommand("branchReviewStudio.openGroupChanges", "first");
    await delay(1500);
    let tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
    assert.ok(tabs.some(t => t.label.includes("1. Smoke: first hunk")), `tabs: ${tabs.map(t => t.label).join(", ")}`);
    await vscode.commands.executeCommand("branchReviewStudio.openFileDiff", split.file.path, "first");
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

/**
 * Posts smoke-test groups (see postSmokeGroups) with up to three other modified files in "rest",
 * and adds a 34-line Major thread and a resolved thread to the longest added file and a thread to
 * the split file's first hunk. Checks the Branch Review view's HTML, the grouped Open All Changes
 * editor, thread navigation and the reveal of the long thread (with screenshots if
 * BRS_SCREENSHOT_DIR is set), then restores the review's groups and threads.
 */
async function checkReviewUi(model: Model, exports: BranchReviewStudioExports,
  check: (name: string, action: () => Promise<void>) => Promise<void>) {
  let { changedFiles, branch, mergeBase } = model.snapshot;
  let split = await findSplitFile(model);
  let previous = model.snapshot.review!;
  let previousThreadIds = previous.threads.map(t => t.id);
  let longFile = await findLongestAddedFile(model);
  let longThreadId = "";
  let screenshot = (name: string) => process.env.BRS_SCREENSHOT_DIR
    && captureWindow(path.join(process.env.BRS_SCREENSHOT_DIR, name));
  try {
    await postSmokeGroups(model, split, changedFiles.filter(f => f.status === "Modified").slice(0, 3));
    let longLines = (await model.getFileLines(longFile, "modified"))!;
    let splitLines = (await model.getFileLines(split.file.path, "modified"))!;
    let claude = { kind: "agent" as const, name: "Claude" };
    await model.modifyReview(review => {
      longThreadId = addThread(review, { file: longFile, side: "modified", anchor: createAnchor(longLines, 30, 63),
        severity: "Major", author: claude, body: "**Major:** these one-time costs are counted twice, since "
          + "`Totals.Add` runs once per scenario. <img src=x onerror=alert(1)> Smoke test thread on lines 30-63." }).id;
      let line = split.hunks[0].newStart;
      addThread(review, { file: split.file.path, side: "modified", anchor: createAnchor(splitLines, line, line),
        severity: "Minor", author: claude, body: "**Minor:** a smoke-test thread in group `first`." });
      addThread(review, { file: longFile, side: "modified", anchor: createAnchor(longLines, 10, 10),
        severity: "Note", author: claude, body: "A *resolved* smoke-test thread." }).status = "resolved";
    });
    let visits = listThreadVisits(model.snapshot.outline);
    console.log(`INFO thread order: ${JSON.stringify(visits.map(v => [v.section.title, v.file.path, v.thread.line]))}`);

    await check("the Branch Review view lists numbered groups, files and threads in order; agent text is escaped",
      async () => {
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
        await vscode.commands.executeCommand("workbench.view.extension.branchReviewStudio");
        await delay(2000);
        let html = exports.getReviewViewHtml();
        let positions = ["1. Smoke: first hunk", "Minor: a smoke-test thread", "2. Smoke: the rest",
          ">Ungrouped<", "A resolved smoke-test thread", "Major: these one-time costs"].map(text => html.indexOf(text));
        assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), `positions ${positions}`);
        assert.ok(!html.includes("<img") && html.includes("&#60;img src=x"), "agent text was not escaped");
        screenshot("review-view.png");
        if (process.env.BRS_SCREENSHOT_DIR)
          fs.writeFileSync(path.join(process.env.BRS_SCREENSHOT_DIR, "review-view.html"), html);
      });
    await check("Open All Changes shows group headings, then each group's files; a file in two groups twice",
      async () => {
        let entries = listChangesEntries(model.snapshot.outline);
        assert.deepEqual(entries.flatMap(e => e.kind === "file" && e.change.path === split.file.path ? [e.viewGroupId]
          : []), ["first", "rest"]);
        await vscode.commands.executeCommand("branchReviewStudio.openAllChanges");
        await delay(4000);
        let tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.label);
        assert.ok(tabs.includes(`${branch} vs ${mergeBase!.baseRef} (${entries.length} files)`), `tabs: ${tabs}`);
        let headings = vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === "brs-heading");
        console.log(`INFO visible editors: ${vscode.window.visibleTextEditors.map(e => e.document.uri.toString())}`);
        // The modified side of an entry is the real file, so it can be edited (the test then undoes
        // its edit and saves)
        let fileEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === "file");
        let start = new vscode.Position(0, 0);
        assert.ok(fileEditor && await fileEditor.edit(b => b.insert(start, "x")) && fileEditor.document.isDirty,
          "could not edit the file in the multi-diff editor");
        await fileEditor.edit(b => b.delete(new vscode.Range(start, start.translate(0, 1))));
        await fileEditor.document.save();
        let headingText = headings[0]?.document.getText();
        assert.ok(headingText?.startsWith("# 1. Smoke: first hunk\n\n1 line, 1 file\n\nThe **first**"),
          `heading: ${headingText}`);
        // Makes room so that the screenshot shows the second group
        for (let command of ["workbench.action.closePanel", "workbench.action.closeAuxiliaryBar",
          "workbench.action.zoomOut", "workbench.action.zoomOut"])
          await vscode.commands.executeCommand(command);
        await delay(2000);
        screenshot("all-changes-grouped.png");
        await vscode.commands.executeCommand("workbench.action.zoomReset");
      });
    await check("Next/Previous (Unresolved) Thread follow the view's order and wrap around", async () => {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      let expectRevealed = async (command: string, visit: ThreadVisit) => {
        await vscode.commands.executeCommand(`branchReviewStudio.${command}`);
        await delay(1200);
        let editors = vscode.window.visibleTextEditors.map(e => `${model.getRelativePath(e.document.uri.fsPath)}:`
          + (e.selection.active.line + 1));
        let expected = `${visit.file.path}:${visit.thread.line}`;
        assert.ok(editors.includes(expected), `after ${command}, expected ${expected}; editors: ${editors}`);
      };
      await vscode.commands.executeCommand("branchReviewStudio.openThread", visits[0].thread.thread.id);
      await delay(500);
      await expectRevealed("nextThread", visits[1]);
      await expectRevealed("previousThread", visits[0]);
      await expectRevealed("previousThread", visits.at(-1)!);
      await expectRevealed("nextUnresolvedThread", visits.find(v => v.thread.thread.status === "open")!);
      screenshot("navigation.png");
    });
    await check("Bug_2026_10_RevealedThreadWidgetOffScreen: revealing a long thread shows its last line and "
      + "its widget, which is below that line", async () => {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await vscode.commands.executeCommand("branchReviewStudio.openThread", longThreadId);
      await delay(2000);
      let editor = vscode.window.activeTextEditor!;
      let ranges = editor.visibleRanges.map(r => `${r.start.line + 1}-${r.end.line + 1}`);
      console.log(`INFO long thread: active=${editor.document.uri.fsPath} cursor=${editor.selection.active.line + 1} `
        + `visible=${ranges}`);
      assert.equal(model.getRelativePath(editor.document.uri.fsPath), longFile);
      assert.equal(editor.selection.active.line + 1, 30);
      // Line 64 is below the widget, so the widget is visible if lines 63 and 64 are
      assert.ok(editor.visibleRanges.some(r => r.start.line + 1 <= 63 && r.end.line + 1 >= 64), `visible ${ranges}`);
      screenshot("reveal-long-thread.png");
    });
    await check("Go to Thread… lists the threads in order and reveals the picked one", async () => {
      let index = visits.findIndex(v => v.thread.thread.id === longThreadId);
      let pending = vscode.commands.executeCommand("branchReviewStudio.openThread");
      await delay(1500);
      screenshot("go-to-thread.png");
      await vscode.commands.executeCommand("workbench.action.quickOpenSelectNext");
      await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
      await pending;
      await delay(1200);
      let target = visits[(index + 1) % visits.length];
      let editors = vscode.window.visibleTextEditors.map(e => model.getRelativePath(e.document.uri.fsPath));
      assert.ok(editors.includes(target.file.path), `expected ${target.file.path}; editors: ${editors}`);
    });
  } finally {
    await model.modifyReview(review => {
      review.changeGroups = previous.changeGroups;
      review.threads = review.threads.filter(t => previousThreadIds.includes(t.id));
    });
  }
}

/**
 * Posts groups with ReviewTools (as the MCP server would): the first and the other hunks of
 * `split.file` go into groups "first" and "rest", and `restFiles` into "rest".
 */
async function postSmokeGroups(model: Model, split: { file: ChangedFile, hunks: DiffHunk[] },
  restFiles: ChangedFile[]) {
  let firstHunk = split.hunks[0];
  let tools = new ReviewTools({ cwd: model.repoRoot, sessionId: undefined, agent: "claude", agentName: "Claude" });
  let result = await tools.setGroups({ groups: [{ id: "first", name: "Smoke: first hunk", summary: "The **first** "
    + "hunk of a file with several hunks; this summary is long enough to be wrapped onto two lines.\n\n- It has "
    + "a list with `code`\n- and <img src=x onerror=alert(1)> [a link](javascript:alert(1))" },
  { id: "rest", name: "Smoke: the rest", summary: "Everything else." }],
  files: [{ file: split.file.path, groups: [
    { groupId: "first", ranges: [{ startLine: firstHunk.newStart, endLine: firstHunk.newStart }] },
    { groupId: "rest", ranges: split.hunks.slice(1).map(h => ({ startLine: Math.max(h.newStart, 1),
      endLine: Math.max(h.newStart + h.newLines.length - 1, h.newStart, 1) })) }] },
  ...restFiles.filter(f => f !== split.file).map(f => ({ file: f.path, groups: [{ groupId: "rest" }] }))] });
  console.log(`INFO review_set_groups: ${result}`);
  await model.refresh();
}

/** Finds a modified file with two or more hunks, the first of which adds lines. */
async function findSplitFile(model: Model): Promise<{ file: ChangedFile, hunks: DiffHunk[] }> {
  let { changedFiles, mergeBase } = model.snapshot;
  for (let file of changedFiles.filter(f => f.status === "Modified")) {
    let hunks = await readDiffHunks(model.repoRoot, mergeBase!.mergeBaseSha, file);
    if (hunks.length >= 2 && hunks[0].newLines.length > 0)
      return { file, hunks };
  }
  throw new Error("the test repo needs a modified file with two or more hunks");
}

/** Finds the added file with the most lines (it needs 80 or more), preferring source files. */
async function findLongestAddedFile(model: Model): Promise<string> {
  let best = { file: "", lineCount: 0 };
  for (let file of model.snapshot.changedFiles.filter(f => f.status === "Added" && /\.(cs|tsx?|go)$/.test(f.path))) {
    let lineCount = (await model.getFileLines(file.path, "modified"))?.length ?? 0;
    if (lineCount > best.lineCount)
      best = { file: file.path, lineCount };
  }
  assert.ok(best.lineCount >= 80, "the test repo needs an added source file with 80 or more lines");
  return best.file;
}

/** Gets the index of an Ask Agent QuickPick item for a new thread, if both agents are found. */
function getChoiceIndex(model: Model, agent: IntegrationId, sessionMode: AgentSessionMode, runMode: AgentRunMode) {
  let forkableAgent = findLatestSession(model.snapshot.review!, "review")?.agent;
  return getAgentChoices(["claude", "codex"], forkableAgent, true)
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
