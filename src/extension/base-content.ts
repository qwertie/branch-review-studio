import * as vscode from "vscode";
import { getFullPath } from "../core/files";
import { getFileAtRevision } from "../core/git";

/** URI scheme of read-only documents that show a file's content at the merge-base. */
export const baseScheme = "brs-base";

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

/** Serves the documents whose URIs getBaseUri makes. */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let { repoRoot, sha, file } = parseBaseUri(uri);
    return sha === "" ? "" : (await getFileAtRevision(repoRoot, sha, file)) ?? "";
  }
}
