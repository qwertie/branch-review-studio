import * as path from "node:path";
import * as vscode from "vscode";
import { ChangedFile, comparePaths } from "../core/git";
import { ReviewThread } from "../core/review";
import { BranchReviewModel, ReviewSnapshot } from "./model";

/** A node of the Branch Review tree view. */
export type ReviewTreeNode =
  | { kind: "header" }
  | { kind: "message", text: string }
  | { kind: "file", file: ChangedFile | UnchangedFile, threads: ReviewThread[] }
  | { kind: "thread", thread: ReviewThread };

/** A file that has threads but no changes (e.g. its changes were reverted after the review). */
export interface UnchangedFile {
  path: string;
  status: undefined;
}

const statusLetters = { Added: "A", Modified: "M", Deleted: "D", Renamed: "R" };

/**
 * Shows the branch and its merge-base, then the changed files (plus unchanged files that have
 * threads), each with its threads as children.
 */
export class ReviewTreeProvider implements vscode.TreeDataProvider<ReviewTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ReviewTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: BranchReviewModel) {
    this.subscription = model.onDidChange(() => this.changeEmitter.fire(undefined));
  }

  getChildren(node?: ReviewTreeNode): ReviewTreeNode[] {
    let snapshot = this.model.snapshot;
    if (node === undefined) {
      let roots: ReviewTreeNode[] = [{ kind: "header" }];
      if (snapshot.mergeBaseError)
        roots.push({ kind: "message", text: snapshot.mergeBaseError });
      else if (snapshot.changedFiles.length === 0)
        roots.push({ kind: "message", text: "No changes since the merge-base." });
      if (snapshot.branch === undefined)
        roots.push({ kind: "message", text: "HEAD is detached, so comments can't be saved." });
      return [...roots, ...getFileNodes(snapshot)];
    }
    return node.kind === "file" ? node.threads.map(thread => ({ kind: "thread", thread })) : [];
  }

  getTreeItem(node: ReviewTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "header": return this.createHeaderItem();
      case "message": return new vscode.TreeItem(node.text);
      case "file": return this.createFileItem(node.file, node.threads);
      case "thread": return this.createThreadItem(node.thread);
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }

  private createHeaderItem(): vscode.TreeItem {
    let { branch, mergeBase, review } = this.model.snapshot;
    let baseBranch = this.model.baseBranch;
    let item = new vscode.TreeItem(branch ?? "(detached HEAD)");
    item.iconPath = new vscode.ThemeIcon("git-compare");
    item.contextValue = "brsHeader";
    if (mergeBase) {
      item.description = `vs ${mergeBase.baseRef} @ ${mergeBase.mergeBaseSha.slice(0, 8)}`;
      item.command = { command: "branchReviewStudio.openAllChanges", title: "Open All Changes" };
    } else {
      item.description = `vs ${baseBranch} (no merge-base)`;
      item.command = { command: "branchReviewStudio.changeBaseBranch", title: "Change Base Branch…" };
    }
    let baseSource = review?.baseBranch ? "this branch's review" : "the setting `branchReviewStudio.baseBranch`";
    let tooltip = new vscode.MarkdownString(
      `**${branch ?? "detached HEAD"}** compared with \`git merge-base ${mergeBase?.baseRef ?? "?"} HEAD\``
      + ` = \`${mergeBase?.mergeBaseSha ?? "?"}\`\n\nBase branch: **${baseBranch}** (from ${baseSource}). `
      + "To change it, click $(arrow-swap) on this row or run **Change Base Branch…**.", true);
    if (review?.summary)
      tooltip.appendMarkdown("\n\n---\n\n" + review.summary);
    item.tooltip = tooltip;
    return item;
  }

  private createFileItem(file: ChangedFile | UnchangedFile, threads: ReviewThread[]): vscode.TreeItem {
    let openCount = threads.filter(t => t.status === "open").length;
    let item = new vscode.TreeItem(path.posix.basename(file.path),
      threads.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    let folder = path.posix.dirname(file.path);
    let details = [
      file.status === undefined ? "unchanged" : statusLetters[file.status],
      openCount > 0 ? `${openCount} open` : "",
      folder === "." ? "" : folder,
      file.status === "Renamed" ? `← ${file.oldPath}` : "",
    ];
    item.description = details.filter(d => d !== "").join(" · ");
    item.resourceUri = vscode.Uri.file(this.model.getFullPath(file.path));
    item.tooltip = file.path;
    item.contextValue = "brsFile";
    item.command = { command: "branchReviewStudio.openFileDiff", title: "Open File Diff", arguments: [file.path] };
    return item;
  }

  private createThreadItem(thread: ReviewThread): vscode.TreeItem {
    let firstLine = thread.comments[0]?.body.split(/\r?\n/).find(line => line.trim() !== "") ?? "(empty)";
    let item = new vscode.TreeItem(firstLine.length > 100 ? firstLine.slice(0, 99) + "…" : firstLine);
    let location = this.model.snapshot.threadLocations.get(thread.id);
    let details = [
      location ? `L${location.startLine}` : "",
      thread.side === "base" ? "base" : "",
      thread.severity ?? "",
      thread.status === "resolved" ? "resolved" : "",
      location?.isOutdated ? "outdated" : "",
    ];
    item.description = details.filter(d => d !== "").join(" · ");
    item.iconPath = new vscode.ThemeIcon(thread.status === "resolved" ? "pass" : "comment-discussion");
    item.tooltip = new vscode.MarkdownString(thread.comments.map(c => `**${c.author.name}:** ${c.body}`).join("\n\n"));
    item.command = { command: "branchReviewStudio.openThread", title: "Go to Thread", arguments: [thread.id] };
    return item;
  }
}

/** Creates nodes for changed files and for unchanged files that have threads, sorted by path. */
function getFileNodes(snapshot: ReviewSnapshot): ReviewTreeNode[] {
  let threadsByFile = Map.groupBy(snapshot.review?.threads ?? [], t => t.file);
  let files: (ChangedFile | UnchangedFile)[] = [...snapshot.changedFiles];
  for (let file of threadsByFile.keys()) {
    if (!snapshot.changedFiles.some(f => f.path === file))
      files.push({ path: file, status: undefined });
  }
  return files.sort(comparePaths).map(file => ({ kind: "file", file, threads: threadsByFile.get(file.path) ?? [] }));
}
