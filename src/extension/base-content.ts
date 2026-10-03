import * as vscode from "vscode";
import { getFullPath } from "../core/files";
import { getFileAtRevision } from "../core/git";
import { buildGroupViewText } from "../core/groups";
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

/** Serves the documents whose URIs getBaseUri makes. */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let { repoRoot, sha, file } = parseBaseUri(uri);
    return sha === "" ? "" : (await getFileAtRevision(repoRoot, sha, file)) ?? "";
  }
}

/**
 * Serves the documents whose URIs getGroupViewUri makes, from the current review's groups. If the
 * merge-base changed since the groups were posted, a document shows the file at the current
 * merge-base instead. Open documents are updated whenever the model refreshes.
 */
export class GroupViewContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly model: BranchReviewModel) {
    this.subscription = model.onDidChange(() => {
      for (let document of vscode.workspace.textDocuments.filter(d => d.uri.scheme === groupViewScheme))
        this.changeEmitter.fire(document.uri);
    });
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

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }
}
