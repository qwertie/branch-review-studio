import * as path from "node:path";
import * as vscode from "vscode";
import { ChangedFile, comparePaths } from "../core/git";
import { ArrangedGroup, describeGroupSize } from "../core/groups";
import { ReviewThread } from "../core/review";
import { BranchReviewModel, ReviewSnapshot } from "./model";

/** A node of the Branch Review tree view. */
export type ReviewTreeNode =
  | { kind: "header" }
  | { kind: "message", text: string }
  | { kind: "group", group: ArrangedGroup }
  /** A line of a group's summary */
  | { kind: "summary", text: string, group: ArrangedGroup }
  /** `group` and `isPartial` are set for a file under a group */
  | { kind: "file", file: ChangedFile | UnchangedFile, threads: ReviewThread[], group?: ArrangedGroup,
    isPartial?: boolean }
  | { kind: "thread", thread: ReviewThread };

/** A file that has threads but no changes (e.g. its changes were reverted after the review). */
export interface UnchangedFile {
  path: string;
  status: undefined;
}

const statusLetters = { Added: "A", Modified: "M", Deleted: "D", Renamed: "R" };

/**
 * Shows the branch and its merge-base, then the changed files (plus unchanged files that have
 * threads), each with its threads as children. If the review has groups of related changes, the
 * files are shown under their groups, each of which starts with its summary.
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
      let groups = snapshot.groupLayout?.groups;
      return [...roots, ...groups ? groups.map(group => ({ kind: "group" as const, group })) : getFileNodes(snapshot)];
    }
    return node.kind === "group" ? getGroupChildren(snapshot, node.group)
      : node.kind === "file" ? node.threads.map(thread => ({ kind: "thread", thread })) : [];
  }

  getTreeItem(node: ReviewTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case "header": return this.createHeaderItem();
      case "message": return new vscode.TreeItem(node.text);
      case "group": return this.createGroupItem(node.group);
      case "summary": return this.createSummaryItem(node.text, node.group);
      case "file": return this.createFileItem(node);
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

  private createGroupItem(group: ArrangedGroup): vscode.TreeItem {
    let item = new vscode.TreeItem(group.name, vscode.TreeItemCollapsibleState.Expanded);
    let isStale = this.model.snapshot.groupLayout?.isStale && group.id !== undefined;
    item.description = describeGroupSize(group) + (isStale ? " · regroup: merge-base changed" : "");
    item.iconPath = new vscode.ThemeIcon("layers");
    item.contextValue = "brsGroup";
    item.tooltip = createGroupTooltip(group, isStale);
    item.command = { command: "branchReviewStudio.openGroupChanges", title: "Open Group Changes", arguments: [group] };
    return item;
  }

  private createSummaryItem(text: string, group: ArrangedGroup): vscode.TreeItem {
    // The description is shown dimmed, which sets the summary apart from the files below it
    let item = new vscode.TreeItem("");
    item.description = text;
    item.tooltip = createGroupTooltip(group, false);
    return item;
  }

  private createFileItem({ file, threads, group, isPartial }: Extract<ReviewTreeNode, { kind: "file" }>)
    : vscode.TreeItem {
    let openCount = threads.filter(t => t.status === "open").length;
    let item = new vscode.TreeItem(path.posix.basename(file.path),
      threads.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    let folder = path.posix.dirname(file.path);
    let details = [
      file.status === undefined ? "unchanged" : statusLetters[file.status],
      openCount > 0 ? `${openCount} open` : "",
      folder === "." ? "" : folder,
      file.status === "Renamed" ? `← ${file.oldPath}` : "",
      isPartial ? "partial" : "",
    ];
    item.description = details.filter(d => d !== "").join(" · ");
    item.resourceUri = vscode.Uri.file(this.model.getFullPath(file.path));
    item.tooltip = isPartial ? `${file.path}\n\nThe diff shows the changes of group '${group?.name}', changes `
      + "that no group includes, and changes made after the groups were posted. The diff button on this row "
      + "shows all changes." : file.path;
    item.contextValue = "brsFile";
    let view = isPartial && group?.id !== undefined ? { groupId: group.id, groupName: group.name } : undefined;
    item.command = { command: "branchReviewStudio.openFileDiff", title: "Open File Diff",
      arguments: [file.path, view] };
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

/** Creates a group's child nodes: the lines of its summary, then its files with their threads. */
function getGroupChildren(snapshot: ReviewSnapshot, group: ArrangedGroup): ReviewTreeNode[] {
  // Wraps the summary, without markdown emphasis, onto lines of up to 40 characters, which fit in a
  // sidebar of the default width
  let summaryText = group.summary.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  let summaryLines = summaryText.match(/.{1,40}(\s|$)|\S+/g) ?? [];
  return [
    ...summaryLines.map(line => ({ kind: "summary" as const, text: line.trim(), group })),
    ...group.files.map(({ path, isPartial }) => ({ kind: "file" as const, group, isPartial,
      file: snapshot.changedFiles.find(f => f.path === path) ?? { path, status: undefined },
      threads: snapshot.review?.threads.filter(t => t.file === path) ?? [] })),
  ];
}

/** Creates a group's tooltip: its name and summary, plus a note if the groups are stale. */
function createGroupTooltip(group: ArrangedGroup, isStale: boolean | undefined): vscode.MarkdownString {
  let staleNote = isStale ? "\n\n*The merge-base changed since the groups were posted, so the diffs show all "
    + "changes of each file. Ask the agent to post the groups again.*" : "";
  return new vscode.MarkdownString(`**${group.name}**\n\n${group.summary}${staleNote}`);
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
