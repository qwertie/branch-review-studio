import * as vscode from "vscode";
import { findRepoRoot, getGitCommonDir, getGitDir } from "../core/git";
import { ReviewStore } from "../core/store";
import { BaseContentProvider, baseScheme } from "./base-content";
import { ReviewCommentController } from "./comments";
import { fetchBase, openAllChanges, openFileDiff, openThread } from "./diff-commands";
import { BranchReviewModel } from "./model";
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
  let model = await createModel(log);
  if (model === undefined) {
    registerCommands(context, undefined);
  } else {
    let comments = new ReviewCommentController(model);
    let tree = new ReviewTreeProvider(model);
    context.subscriptions.push(model, comments, tree,
      vscode.window.registerTreeDataProvider("branchReviewStudio.files", tree),
      vscode.workspace.registerTextDocumentContentProvider(baseScheme, new BaseContentProvider()));
    registerCommands(context, model, comments);
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
      await store.ensureExists();
      log.appendLine(`Repo: ${repoRoot}; review store: ${store.dir}`);
      return new BranchReviewModel(repoRoot, store, log);
    }
  }
  return undefined;
}

function registerCommands(context: vscode.ExtensionContext, model: BranchReviewModel | undefined,
  comments?: ReviewCommentController): void {
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
    fetchBase,
    createThread: (_, reply: vscode.CommentReply) => comments?.createThread(reply),
    reply: (_, reply: vscode.CommentReply) => comments?.reply(reply),
    resolveThread: (_, thread: vscode.CommentThread) => comments?.setThreadStatus(thread, "resolved"),
    unresolveThread: (_, thread: vscode.CommentThread) => comments?.setThreadStatus(thread, "open"),
    deleteThread: (_, thread: vscode.CommentThread) => comments?.deleteThread(thread),
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
  let storeWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(model.store.reviewsDir), "*.json"));
  let headWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(await getGitDir(model.repoRoot)), "{HEAD,logs/HEAD}"));
  context.subscriptions.push(storeWatcher, headWatcher,
    storeWatcher.onDidChange(schedule), storeWatcher.onDidCreate(schedule), storeWatcher.onDidDelete(schedule),
    headWatcher.onDidChange(schedule), headWatcher.onDidCreate(schedule),
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

function getActiveEditorFile(model: BranchReviewModel): string | undefined {
  let uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? model.getRelativePath(uri.fsPath) : undefined;
}
