import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { AnchorLocation, locateAnchor, splitLines } from "../core/anchoring";
import { readFileLines } from "../core/files";
import {
  ChangedFile, findMergeBase, getChangedFiles, getConfigValue, getCurrentBranch, MergeBaseInfo,
} from "../core/git";
import { createReview, Review, ReviewThread } from "../core/review";
import { ReviewStore } from "../core/store";

/** Everything the UI shows about the current branch, computed by BranchReviewModel.refresh. */
export interface ReviewSnapshot {
  /** Undefined on a detached HEAD; reviews are keyed by branch, so there is no review then */
  branch: string | undefined;
  mergeBase: MergeBaseInfo | undefined;
  /** Why `mergeBase` is undefined, e.g. the base branch does not exist */
  mergeBaseError: string | undefined;
  changedFiles: ChangedFile[];
  review: Review | undefined;
  /** Current location of each thread in `review`, by thread id */
  threadLocations: Map<string, AnchorLocation>;
}

const emptySnapshot: ReviewSnapshot = { branch: undefined, mergeBase: undefined, mergeBaseError: undefined,
  changedFiles: [], review: undefined, threadLocations: new Map() };

/**
 * Holds the review state of one working tree (its branch, merge-base, changed files and review)
 * and recomputes it on request. The tree view and the comment controller render `snapshot`.
 */
export class BranchReviewModel implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ReviewSnapshot>();
  /** Fires after each refresh */
  readonly onDidChange = this.changeEmitter.event;
  private currentSnapshot = emptySnapshot;
  private refreshTimer: NodeJS.Timeout | undefined;
  private runningRefresh: Promise<void> | undefined;
  private isRefreshPending = false;
  private userName: string | undefined;

  constructor(readonly repoRoot: string, readonly store: ReviewStore, private readonly log: vscode.OutputChannel) {}

  get snapshot(): ReviewSnapshot {
    return this.currentSnapshot;
  }

  get baseBranchSetting(): string {
    return vscode.workspace.getConfiguration("branchReviewStudio").get<string>("baseBranch") || "develop";
  }

  /** Refreshes after a short delay, so that a burst of events causes one refresh. */
  scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.refresh(), 300);
  }

  /** Recomputes the snapshot. If a refresh is already running, another one runs after it. */
  async refresh(): Promise<void> {
    if (this.runningRefresh) {
      this.isRefreshPending = true;
      return this.runningRefresh;
    }
    this.runningRefresh = (async () => {
      do {
        this.isRefreshPending = false;
        try {
          this.currentSnapshot = await this.computeSnapshot();
        } catch (e) {
          this.log.appendLine(`Refresh failed: ${getErrorMessage(e)}`);
        }
        this.changeEmitter.fire(this.currentSnapshot);
      } while (this.isRefreshPending);
    })();
    try {
      await this.runningRefresh;
    } finally {
      this.runningRefresh = undefined;
    }
  }

  /**
   * Modifies the current branch's review in place (creating the review if there is none) via
   * ReviewStore.updateReview, then refreshes. Throws if HEAD is detached.
   */
  async modifyReview(mutate: (review: Review) => void): Promise<void> {
    let { branch, mergeBase } = this.currentSnapshot;
    if (branch === undefined)
      throw new Error("HEAD is detached, so there is no branch to associate a review with.");
    await this.store.updateReview(branch, review => {
      review ??= createReview(branch, mergeBase?.baseRef ?? this.baseBranchSetting, mergeBase?.mergeBaseSha ?? "");
      mutate(review);
      return review;
    });
    await this.refresh();
  }

  /** Gets the author name of the user's comments: git's user.name, else the OS user name. */
  async getUserName(): Promise<string> {
    this.userName ??= (await getConfigValue(this.repoRoot, "user.name")) || os.userInfo().username;
    return this.userName;
  }

  /** Gets the absolute path of a repo-relative file path. */
  getFullPath(file: string): string {
    return path.join(this.repoRoot, ...file.split("/"));
  }

  /** Gets the repo-relative path (forward slashes) of a file; undefined if outside the repo. */
  getRelativePath(fsPath: string): string | undefined {
    let relativePath = path.relative(this.repoRoot, fsPath);
    let isInside = relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
    return isInside ? relativePath.split(path.sep).join("/") : undefined;
  }

  /**
   * Gets the lines of a file on one side of the diff (base side: at `mergeBaseSha`), or
   * undefined if the file doesn't exist there. The modified side includes unsaved changes.
   */
  async getFileLines(file: string, side: ReviewThread["side"],
    mergeBaseSha = this.currentSnapshot.mergeBase?.mergeBaseSha): Promise<string[] | undefined> {
    let openDocument = side === "modified" ? vscode.workspace.textDocuments.find(d => d.uri.scheme === "file"
      && this.getRelativePath(d.uri.fsPath) === file) : undefined;
    if (openDocument)
      return splitLines(openDocument.getText());
    return mergeBaseSha === undefined && side === "base"
      ? undefined : await readFileLines(this.repoRoot, file, side, mergeBaseSha ?? "");
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.changeEmitter.dispose();
  }

  private async computeSnapshot(): Promise<ReviewSnapshot> {
    let branch = await getCurrentBranch(this.repoRoot);
    let mergeBase: MergeBaseInfo | undefined;
    let mergeBaseError: string | undefined;
    try {
      mergeBase = await findMergeBase(this.repoRoot, this.baseBranchSetting);
    } catch (e) {
      mergeBaseError = getErrorMessage(e);
    }
    let [changedFiles, review] = await Promise.all([
      mergeBase ? getChangedFiles(this.repoRoot, mergeBase.mergeBaseSha) : Promise.resolve([]),
      branch === undefined ? Promise.resolve(undefined) : this.store.readReview(branch),
    ]);
    let threadLocations = new Map<string, AnchorLocation>();
    let linesByFile = new Map<string, Promise<string[] | undefined>>();
    for (let thread of review?.threads ?? []) {
      let key = thread.side + ":" + thread.file;
      if (!linesByFile.has(key))
        linesByFile.set(key, this.getFileLines(thread.file, thread.side, mergeBase?.mergeBaseSha));
      threadLocations.set(thread.id, locateAnchor((await linesByFile.get(key)) ?? [], thread.anchor));
    }
    return { branch, mergeBase, mergeBaseError, changedFiles, review, threadLocations };
  }
}

export function getErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

