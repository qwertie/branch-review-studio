import * as vscode from "vscode";
import { getFullPath } from "../core/files";
import { getFileAtRevision } from "../core/git";
import { buildGroupViewText } from "../core/groups";
import { getGroupHeading } from "../core/review-outline";
import { BranchReviewModel } from "./model";

/** URI scheme of read-only documents that show a file's content at the merge-base. */
export const baseScheme = "brs-base";
/**
 * URI scheme of read-only documents that show the left side of a group's view of a file (see
 * buildGroupViewText). It differs from baseScheme so that these documents get no comment threads,
 * since their line numbers are not merge-base line numbers.
 */
export const groupViewScheme = "brs-group";
/**
 * URI scheme of read-only markdown documents that introduce a group in Open All Changes (see
 * getGroupHeading).
 */
export const headingScheme = "brs-heading";

/**
 * Gets the URI of `file` (repo-relative) at commit `sha`. An empty `sha` gives an empty document,
 * which stands in for the missing side of an added or deleted file. The URI's path is the
 * working-tree file's path (as in the git extension's URIs), so that diff editors don't present the
 * two sides as a rename; the query holds what BaseContentProvider needs.
 */
export function getBaseUri(repoRoot: string, sha: string, file: string): vscode.Uri {
  let query = new URLSearchParams({ sha, root: repoRoot, file }).toString();
  return vscode.Uri.file(getFullPath(repoRoot, file)).with({ scheme: baseScheme, query });
}

/** Parses a URI made by getBaseUri. */
export function parseBaseUri(uri: vscode.Uri): { repoRoot: string, sha: string, file: string } {
  let query = new URLSearchParams(uri.query);
  return { repoRoot: query.get("root") ?? "", sha: query.get("sha") ?? "", file: query.get("file") ?? "" };
}

/** Gets the URI of the left side of group `groupId`'s view of `file` (repo-relative). */
export function getGroupViewUri(repoRoot: string, file: string, groupId: string): vscode.Uri {
  let query = new URLSearchParams({ file, group: groupId }).toString();
  return vscode.Uri.file(getFullPath(repoRoot, file)).with({ scheme: groupViewScheme, query });
}

/**
 * Gets the URI of the heading document of a group (undefined `groupId`: Ungrouped). Its path is the
 * document's file name, which the multi-diff editor shows as the entry's title.
 */
export function getHeadingUri(fileName: string, groupId: string | undefined): vscode.Uri {
  let query = groupId === undefined ? "" : new URLSearchParams({ group: groupId }).toString();
  return vscode.Uri.from({ scheme: headingScheme, path: fileName, query });
}

/**
 * Gets the repo-relative path of the review file that a document shows: a working-tree file, its
 * merge-base version, or the left side of a group's view of it; undefined for other documents.
 */
export function getReviewFileOfUri(model: BranchReviewModel, uri: vscode.Uri): string | undefined {
  let isFileInQuery = uri.scheme === baseScheme || uri.scheme === groupViewScheme;
  return uri.scheme === "file" ? model.getRelativePath(uri.fsPath)
    : isFileInQuery ? new URLSearchParams(uri.query).get("file") ?? undefined : undefined;
}

/** Serves the documents whose URIs getBaseUri makes. */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let { repoRoot, sha, file } = parseBaseUri(uri);
    return sha === "" ? "" : (await getFileAtRevision(repoRoot, sha, file)) ?? "";
  }
}

/**
 * Serves documents of one URI scheme that are computed from the model's snapshot, and updates the
 * open ones whenever the model refreshes.
 */
abstract class SnapshotContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(protected readonly model: BranchReviewModel, scheme: string) {
    this.subscription = model.onDidChange(() => {
      for (let document of vscode.workspace.textDocuments.filter(d => d.uri.scheme === scheme))
        this.changeEmitter.fire(document.uri);
    });
  }

  abstract provideTextDocumentContent(uri: vscode.Uri): Promise<string> | string;

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}

/**
 * Serves the documents whose URIs getGroupViewUri makes, from the current review's groups. If the
 * merge-base changed since the groups were posted, a document shows the file at the current
 * merge-base instead.
 */
export class GroupViewContentProvider extends SnapshotContentProvider {
  constructor(model: BranchReviewModel) {
    super(model, groupViewScheme);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let query = new URLSearchParams(uri.query);
    let file = query.get("file") ?? "";
    let { review, mergeBase, changedFiles } = this.model.snapshot;
    let groupedFile = review?.changeGroups?.files.find(f => f.file === file);
    let mergeBaseSha = mergeBase?.mergeBaseSha ?? "";
    let basePath = changedFiles.find(f => f.path === file)?.oldPath ?? file;
    let baseText = mergeBaseSha === "" ? "" : (await getFileAtRevision(this.model.repoRoot, mergeBaseSha, basePath))
      ?? "";
    return groupedFile && review?.changeGroups?.mergeBaseSha === mergeBaseSha
      ? buildGroupViewText(baseText, groupedFile, query.get("group") ?? "") : baseText;
  }
}

/** Serves the documents whose URIs getHeadingUri makes, from the current review's groups. */
export class HeadingContentProvider extends SnapshotContentProvider {
  constructor(model: BranchReviewModel) {
    super(model, headingScheme);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    let groupId = new URLSearchParams(uri.query).get("group") ?? undefined;
    let { outline } = this.model.snapshot;
    let section = outline.sections.find(s => s.group && s.group.id === groupId);
    return section ? getGroupHeading(outline, section).text : "This group is no longer in the review.\n";
  }
}
