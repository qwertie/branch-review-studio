import * as path from "node:path";
import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import { findRepoRoot, getGitCommonDir, getGitDir } from "../core/git";
import { IntegrationErrorLog } from "../core/integration-status";
import { IntegrationId } from "../core/review";
import { ReviewStore } from "../core/store";
import { AgentServices } from "./agents";
import { askAgent, trackSendTargets } from "./ask-agent";
import {
  BaseContentProvider, baseScheme, getReviewFileOfUri, GroupViewContentProvider, groupViewScheme,
  HeadingContentProvider, headingScheme,
} from "./base-content";
import { changeBaseBranch } from "./change-base-branch";
import { ReviewCommentController } from "./comments";
import { clearReview, deleteResolvedThreads } from "./delete-commands";
import { fetchBase, openAllChanges, openFileDiff, openGroupChanges } from "./diff-commands";
import { installMcpServer, installSkill, uninstall, updateInstalledServerIfOutdated } from "./install";
import { BranchReviewModel } from "./model";
import { ReviewViewProvider, reviewViewId } from "./review-view";
import { SettingsPanel } from "./settings-panel";
import { switchBranch } from "./switch-branch";
import { ThreadNavigator } from "./thread-navigation";
import { VscodeChatIntegration } from "./vscode-chat";

/** What `activate` returns; scripts/smoke-test.ts uses it to inspect the extension's state. */
export interface BranchReviewStudioExports {
  model: BranchReviewModel | undefined;
  getSettingsPanelHtml: () => string | undefined;
  /** Gets the body HTML of the Branch Review view */
  getReviewViewHtml: () => string;
  /** Handles a message as if the Branch Review view's script had posted it */
  handleReviewViewMessage: (message: unknown) => Promise<void>;
  /** Handles a message as if the open settings panel's script had posted it */
  handleSettingsPanelMessage: (message: unknown) => Promise<void>;
  /** Gets the `contextValue` of a thread's VS Code thread, which tells the menus its Send button */
  getThreadContextValue: (threadId: string) => string | undefined;
  /** The provider of the "+" (new thread) ranges, whose method scripts/smoke-test.ts wraps */
  commentingRangeProvider: vscode.CommentingRangeProvider | undefined;
  vscodeChat: VscodeChatIntegration;
}

/**
 * Sets up Branch Review Studio for the first workspace folder that is in a git repo. Without one,
 * the commands only show an error.
 */
export async function activate(context: vscode.ExtensionContext): Promise<BranchReviewStudioExports> {
  let log = vscode.window.createOutputChannel("Branch Review Studio");
  context.subscriptions.push(log);
  let services: AgentServices = { context, log,
    errors: new IntegrationErrorLog(context.globalState, () => SettingsPanel.renderIfOpen()) };
  void updateInstalledServerIfOutdated(context, log).catch(e => log.appendLine(getErrorMessage(e)));
  let model = await createModel(log);
  let vscodeChat = new VscodeChatIntegration(services, model);
  context.subscriptions.push(vscodeChat);
  registerRepoIndependentCommands(services, model, vscodeChat);
  let comments = model && new ReviewCommentController(model);
  let navigator = model && comments && new ThreadNavigator(model, comments);
  let view = new ReviewViewProvider(context.extensionUri, model, navigator);
  context.subscriptions.push(view, vscode.window.registerWebviewViewProvider(reviewViewId, view,
    { webviewOptions: { retainContextWhenHidden: true } }));
  registerCommands(context, model, services, comments, navigator);
  if (model && comments && navigator) {
    let groupViews = new GroupViewContentProvider(model);
    let headings = new HeadingContentProvider(model);
    context.subscriptions.push(model, comments, navigator, groupViews, headings,
      trackSendTargets(model, comments, log),
      vscode.workspace.registerTextDocumentContentProvider(baseScheme, new BaseContentProvider()),
      vscode.workspace.registerTextDocumentContentProvider(groupViewScheme, groupViews),
      vscode.workspace.registerTextDocumentContentProvider(headingScheme, headings));
    await watchForChanges(context, model);
    await model.refresh();
  }
  return { model, getSettingsPanelHtml: SettingsPanel.getHtmlIfOpen, getReviewViewHtml: () => view.getBody(),
    handleReviewViewMessage: message => view.handleMessage(message),
    handleSettingsPanelMessage: SettingsPanel.handleMessageIfOpen,
    getThreadContextValue: threadId => comments?.getThreadContextValue(threadId),
    commentingRangeProvider: comments?.commentingRangeProvider, vscodeChat };
}

export function deactivate(): void {}

async function createModel(log: vscode.OutputChannel): Promise<BranchReviewModel | undefined> {
  for (let folder of vscode.workspace.workspaceFolders ?? []) {
    let repoRoot = folder.uri.scheme === "file" ? await findRepoRoot(folder.uri.fsPath) : undefined;
    if (repoRoot !== undefined) {
      let store = new ReviewStore(await getGitCommonDir(repoRoot));
      log.appendLine(`Repo: ${repoRoot}; review store: ${store.dir}`);
      return new BranchReviewModel(repoRoot, store, log);
    }
  }
  return undefined;
}

/** Registers commands that work without a git repo. */
function registerRepoIndependentCommands(services: AgentServices, model: BranchReviewModel | undefined,
  vscodeChat: VscodeChatIntegration): void {
  services.context.subscriptions.push(
    vscode.commands.registerCommand("branchReviewStudio.installMcpServer", () => installMcpServer(services)),
    vscode.commands.registerCommand("branchReviewStudio.installSkill", () => installSkill(services.context)),
    vscode.commands.registerCommand("branchReviewStudio.uninstall", () => uninstall(services)),
    vscode.commands.registerCommand("branchReviewStudio.openSettings",
      () => SettingsPanel.show(model, services, vscodeChat)));
}

/** Registers commands that need a git repo; without one (`model` undefined), they show an error. */
function registerCommands(context: vscode.ExtensionContext, model: BranchReviewModel | undefined,
  services: AgentServices, comments?: ReviewCommentController, navigator?: ThreadNavigator): void {
  let commands: Record<string, (model: BranchReviewModel, ...args: never[]) => unknown> = {
    refresh: m => m.refresh(),
    openAllChanges,
    openGroupChanges: (m, groupId?: string) => openGroupChanges(m, groupId),
    openFileDiff: (m, file = getActiveEditorFile(m), viewGroupId?: string) =>
      file === undefined ? undefined : openFileDiff(m, file, undefined, viewGroupId),
    // From the Command Palette or the editor title bar (no arguments), the user picks a thread
    openThread: (_, threadId?: string) => threadId === undefined ? navigator?.pickThread()
      : navigator?.revealThread(threadId),
    previousThread: () => navigator?.revealAdjacentThread(-1, false),
    nextThread: () => navigator?.revealAdjacentThread(1, false),
    previousUnresolvedThread: () => navigator?.revealAdjacentThread(-1, true),
    nextUnresolvedThread: () => navigator?.revealAdjacentThread(1, true),
    switchBranch,
    changeBaseBranch,
    fetchBase,
    addNote: (_, reply: vscode.CommentReply) => reply.text.trim() === ""
      ? void vscode.window.showErrorMessage("Type a note first.") : comments?.saveMessage(reply),
    resolveThread: (_, thread: vscode.CommentThread) => comments?.setThreadStatus(thread, "resolved"),
    unresolveThread: (_, thread: vscode.CommentThread) => comments?.setThreadStatus(thread, "open"),
    deleteThread: (_, thread: vscode.CommentThread) => comments?.deleteThread(thread),
    deleteResolvedThreads,
    clearReview,
    // "Send to…" and "Send to Agent…" let the user pick; "Send to <agent>" sends as the
    // askAgent settings say
    askAgent: sendTo(),
    sendToAgent: sendTo(),
    sendToClaude: sendTo("claude"),
    sendToCodex: sendTo("codex"),
    sendToVscodeChat: sendTo("vscodeChat"),
  };
  for (let [name, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`branchReviewStudio.${name}`, (...args: never[]) =>
      model === undefined
        ? vscode.window.showErrorMessage("Branch Review Studio: no workspace folder is in a git repo.")
        : handler(model, ...args)));
  }

  /** Gets the handler of a comment box's Send button, which runs askAgent with `agent`. */
  function sendTo(agent?: IntegrationId) {
    return (m: BranchReviewModel, reply: vscode.CommentReply) =>
      comments && askAgent(m, comments, reply, services, agent);
  }
}

/** Refreshes the model on file saves, review store or HEAD changes, and window focus. */
async function watchForChanges(context: vscode.ExtensionContext, model: BranchReviewModel): Promise<void> {
  let schedule = () => model.scheduleRefresh();
  let gitDir = await getGitDir(model.repoRoot);
  // ReviewStore creates its folder when it first saves a review, so the review watcher is
  // (re)created when the folder appears.
  let reviewWatcher = watchFolder(model.store.reviewsDir, "*.json", schedule);
  let watchReviews = () => {
    reviewWatcher.dispose();
    reviewWatcher = watchFolder(model.store.reviewsDir, "*.json", schedule);
    schedule();
  };
  context.subscriptions.push({ dispose: () => reviewWatcher.dispose() },
    watchFolder(path.dirname(model.store.dir), path.basename(model.store.dir), watchReviews),
    watchFolder(gitDir, "HEAD", schedule),
    watchFolder(path.join(gitDir, "logs"), "HEAD", schedule),
    vscode.workspace.onDidSaveTextDocument(schedule),
    vscode.workspace.onDidCreateFiles(schedule), vscode.workspace.onDidDeleteFiles(schedule),
    vscode.workspace.onDidRenameFiles(schedule),
    vscode.window.onDidChangeWindowState(state => {
      if (state.focused)
        schedule();
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("branchReviewStudio.baseBranch"))
        schedule();
    }));
}

/** Calls `onEvent` when files matching `glob` directly in `folder` are created/changed/deleted. */
function watchFolder(folder: string, glob: string, onEvent: () => void): vscode.Disposable {
  let watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(folder), glob));
  let subscriptions = [watcher.onDidCreate(onEvent), watcher.onDidChange(onEvent), watcher.onDidDelete(onEvent)];
  return vscode.Disposable.from(watcher, ...subscriptions);
}

function getActiveEditorFile(model: BranchReviewModel): string | undefined {
  let uri = vscode.window.activeTextEditor?.document.uri;
  return uri && getReviewFileOfUri(model, uri);
}
