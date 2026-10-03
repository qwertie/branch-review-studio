import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import { getViewGroupId } from "../core/review-outline";
import { parseViewMessage, renderReviewViewBody } from "../core/review-view-html";
import { deleteThreadIfConfirmed } from "./delete-commands";
import { openFileDiff, openGroupChanges } from "./diff-commands";
import { BranchReviewModel } from "./model";
import { ThreadNavigator } from "./thread-navigation";

/**
 * Id of the Branch Review view in package.json. It is the id of the tree view that the webview
 * replaced, since VS Code remembers where the user moved a view by its id.
 */
export const reviewViewId = "branchReviewStudio.files";

/**
 * The Branch Review view (a webview in the sidebar): the branch and merge-base with buttons for the
 * main commands, then the changed files under their groups, each with its threads (see
 * renderReviewViewBody). It re-renders its content whenever the model refreshes; its script
 * (media/review-view.js) keeps the collapsed rows, the filter, the focus and the scroll position.
 */
export class ReviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  /** The body HTML that the view shows */
  private body = "";
  private readonly subscription: vscode.Disposable | undefined;

  /** `model` and `navigator` are undefined if no workspace folder is in a git repo. */
  constructor(private readonly extensionUri: vscode.Uri, private readonly model: BranchReviewModel | undefined,
    private readonly navigator: ThreadNavigator | undefined) {
    this.subscription = model?.onDidChange(() => this.update());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    let mediaUri = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
    this.body = this.renderBody();
    view.webview.html = this.renderPage(view.webview, mediaUri);
    view.webview.onDidReceiveMessage(message => this.handleMessage(message)
      .catch(e => void vscode.window.showErrorMessage(getErrorMessage(e))));
    view.onDidDispose(() => this.view = undefined);
  }

  /** Gets the body HTML that the view shows, for scripts/smoke-test.ts. */
  getBody(): string {
    return this.body;
  }

  dispose(): void {
    this.subscription?.dispose();
  }

  /** Sends the view's script new body HTML if it changed. */
  private update(): void {
    let body = this.renderBody();
    if (body !== this.body) {
      this.body = body;
      void this.view?.webview.postMessage({ type: "render", html: body });
    }
  }

  private renderBody(): string {
    let { model } = this;
    return model ? renderReviewViewBody({ ...model.snapshot, baseBranch: model.baseBranch,
      summary: model.snapshot.review?.summary }) : `<p class="notice">No workspace folder is in a git repo.</p>`;
  }

  private renderPage(webview: vscode.Webview, mediaUri: vscode.Uri): string {
    let nonce = randomBytes(16).toString("hex");
    let getUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; `
      + `style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${getUri("codicons/codicon.css")}">
<link rel="stylesheet" href="${getUri("review-view.css")}">
</head>
<body>
<div id="root">${this.body}</div>
<script nonce="${nonce}" src="${getUri("review-view.js")}"></script>
</body>
</html>`;
  }

  /**
   * Carries out a request from the view's script, if parseViewMessage accepts it. Public for
   * scripts/smoke-test.ts.
   */
  async handleMessage(message: unknown): Promise<void> {
    let { model, navigator } = this;
    let request = model && parseViewMessage(message, model.snapshot.outline);
    if (model && navigator && request) {
      switch (request.action) {
        case "runCommand":
          return void await vscode.commands.executeCommand(`branchReviewStudio.${request.commandId}`);
        case "openGroup":
          return openGroupChanges(model, request.section.group?.id);
        case "openFile":
          return openFileDiff(model, request.file.path, undefined, getViewGroupId(request.section, request.file));
        case "openWholeDiff":
          return openFileDiff(model, request.file.path);
        case "openEditor":
          return void await vscode.window.showTextDocument(vscode.Uri.file(model.getFullPath(request.file.path)));
        case "revealThread":
          return navigator.revealThread(request.thread.thread.id, getViewGroupId(request.section, request.file));
        case "deleteThread":
          return deleteThreadIfConfirmed(model, request.thread.thread.id);
      }
    }
  }
}
