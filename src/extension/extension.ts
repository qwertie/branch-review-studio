import * as path from "node:path";
import * as vscode from "vscode";
import { findRepoRoot, getGitCommonDir, getGitDir } from "../core/git";
import { ReviewStore } from "../core/store";
import { askAgent } from "./ask-agent";
import { BaseContentProvider, baseScheme } from "./base-content";
import { changeBaseBranch } from "./change-base-branch";
import { ReviewCommentController } from "./comments";
import { fetchBase, openAllChanges, openFileDiff, openThread } from "./diff-commands";
import { installMcpServer, installSkill, uninstall, updateInstalledServerIfOutdated } from "./install";
import { BranchReviewModel, getErrorMessage } from "./model";
import { ReviewTreeNode, ReviewTreeProvider } from "./review-tree";
import { switchBranch } from "./switch-branch";

/** What `activate` returns; scripts/smoke-test.ts uses it to inspect the extension's state. */
export interface BranchReviewStudioExports {
  model: BranchReviewModel | undefined;
}

/**
 * Sets up Branch Review Studio for the first workspace folder that is in a git repo. Without one,
 * the commands only show an error.
 */
export async function activate(context: vscode.ExtensionContext): Promise<BranchReviewStudioExports> {
  let log = vscode.window.createOutputChannel("Branch Review Studio");
  context.subscriptions.push(log);
  registerInstallCommands(context, log);
  void updateInstalledServerIfOutdated(context, log).catch(e => log.appendLine(getErrorMessage(e)));
  let model = await createModel(log);
  if (model === undefined) {
    registerCommands(context, undefined, log);
  } else {
    let comments = new ReviewCommentController(model);
    let tree = new ReviewTreeProvider(model);
    context.subscriptions.push(model, comments, tree,
      vscode.window.registerTreeDataProvider("branchReviewStudio.files", tree),
      vscode.workspace.registerTextDocumentContentProvider(baseScheme, new BaseContentProvider()));
    registerCommands(context, model, log, comments);
    await watchForChanges(context, model);
    await model.refresh();
  }
  return { model };
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
function registerInstallCommands(context: vscode.ExtensionContext, log: vscode.OutputChannel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("branchReviewStudio.installMcpServer", () => installMcpServer(context, log)),
    vscode.commands.registerCommand("branchReviewStudio.installSkill", () => installSkill(context)),
    vscode.commands.registerCommand("branchReviewStudio.uninstall", () => uninstall(log)));
}

/** Registers commands that need a git repo; without one (`model` undefined), they show an error. */
function registerCommands(context: vscode.ExtensionContext, model: BranchReviewModel | undefined,
  log: vscode.OutputChannel, comments?: ReviewCommentController): void {
  let commands: Record<string, (model: BranchReviewModel, ...args: never[]) => unknown> = {
    refresh: m => m.refresh(),
    openAllChanges,
    openFileDiff: (m, arg?: string | ReviewTreeNode) => {
      let file = typeof arg === "string" ? arg : arg?.kind === "file" ? arg.file.path : getActiveEditorFile(m);
      return file === undefined ? undefined : openFileDiff(m, file);
    },
    openFile: (m, node?: ReviewTreeNode) => node?.kind === "file"
      ? vscode.window.showTextDocument(vscode.Uri.file(m.getFullPath(node.file.path))) : undefined,
    openThread: (m, threadId: string) => openThread(m, threadId),
    switchBranch,
    changeBaseBranch,
    fetchBase,
    createThread: (_, reply: vscode.CommentReply) => comments?.createThread(reply),
    reply: (_, reply: vscode.CommentReply) => comments?.reply(reply),
    resolveThread: (_, thread: vscode.CommentThread) => comments?.setThreadStatus(thread, "resolved"),
    unresolveThread: (_, thread: vscode.CommentThread) => comments?.setThreadStatus(thread, "open"),
    deleteThread: (_, thread: vscode.CommentThread) => comments?.deleteThread(thread),
    askAgent: (m, reply: vscode.CommentReply) => comments && askAgent(m, comments, reply, log),
  };
  for (let [name, handler] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`branchReviewStudio.${name}`, (...args: never[]) =>
      model === undefined
        ? vscode.window.showErrorMessage("Branch Review Studio: no workspace folder is in a git repo.")
        : handler(model, ...args)));
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
  return uri?.scheme === "file" ? model.getRelativePath(uri.fsPath) : undefined;
}
