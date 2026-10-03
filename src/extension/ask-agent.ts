import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { getAgentChoiceItems, getAgentIntegration } from "../core/agent-choice-items";
import { buildLanguageModelPrompt, buildThreadPrompt, ThreadMessageContext } from "../core/agent-commands";
import { AgentCommand, AgentIntegration } from "../core/agent-integration";
import { getErrorMessage } from "../core/files";
import { answerThreadWithModel } from "../core/language-model";
import { RepoTools } from "../core/repo-tools";
import { AgentKind, findLatestSession, Review, ReviewSession, ReviewThread } from "../core/review";
import { answerThreadInBackground, BackgroundAnswerRequest, recordFollowupSession } from "../core/thread-answer";
import {
  agentIntegrations, AgentServices, codexExtensionId, findAgentCommand, getBundledServerPath, openCodexThread,
} from "./agents";
import { ReviewCommentController } from "./comments";
import { createToolCallingModel, describeLanguageModelError, findLanguageModel } from "./language-models";
import { BranchReviewModel } from "./model";

/**
 * Saves the user's message in a thread and sends it, with the thread's context, to an agent
 * (Claude Code or Codex): either as a fork of the session that wrote the review (which reuses its
 * prompt cache), with the agent that ran that session, or as a fresh session, in a terminal or in
 * the background. Alternatively, a VS Code language model answers it (see answerWithLanguageModel).
 */
export async function askAgent(model: BranchReviewModel, comments: ReviewCommentController,
  reply: vscode.CommentReply, services: AgentServices): Promise<void> {
  let review = model.snapshot.review;
  let commands = new Map(agentIntegrations.flatMap(i => {
    let command = findAgentCommand(i);
    return command ? [[i.agent, command] as const] : [];
  }));
  let languageModel = await findLanguageModel();
  if (reply.text.trim() === "") {
    void vscode.window.showErrorMessage("Type a message for the agent first.");
  } else if (commands.size === 0 && languageModel === undefined) {
    void vscode.window.showErrorMessage("Could not find the Claude Code CLI (claude), the Codex CLI (codex) or a VS "
      + "Code language model. Install a CLI (or set the branchReviewStudio.claudePath or branchReviewStudio.codexPath "
      + "setting), or make a language model available, e.g. with GitHub Copilot.");
  } else {
    let reviewSession = review && findSessionToFork(review, comments.getThreadId(reply.thread));
    // `claude --resume` finds a session only in the folder it ran in
    let forkableSession = reviewSession && fs.existsSync(reviewSession.cwd) && commands.has(reviewSession.agent)
      ? reviewSession : undefined;
    let items = getAgentChoiceItems([...commands.keys()], forkableSession, languageModel?.name)
      .map(i => i.isSeparator ? { ...i, kind: vscode.QuickPickItemKind.Separator } : i);
    let item = await vscode.window.showQuickPick(items,
      { placeHolder: getPlaceHolder(reviewSession, forkableSession, commands) });
    let threadId = item?.choice && await comments.saveMessage(reply);
    let { review: savedReview, branch } = model.snapshot;
    let thread = savedReview?.threads.find(t => t.id === threadId);
    let choice = item?.choice;
    let command = choice && choice.agent !== "languageModel" ? commands.get(choice.agent) : undefined;
    let context = thread && savedReview && await getMessageContext(model, savedReview, thread);
    if (choice?.agent === "languageModel" && languageModel && context) {
      await answerWithLanguageModel(model, services, languageModel, context);
    } else if (choice && choice.agent !== "languageModel" && command && thread && context && branch) {
      let integration = getAgentIntegration(choice.agent);
      let cwd = choice.sessionMode === "fork" && forkableSession ? forkableSession.cwd : model.repoRoot;
      let threadTitle = getThreadTitle(context);
      let prompt = buildThreadPrompt(context, choice.sessionMode);
      let newSessionId = integration.canPreassignSessionId ? randomUUID() : undefined;
      let where = choice.runMode === "interactive" ? "terminal" : "background";
      let operation = `Ask Agent (${choice.sessionMode}, ${where})`;
      services.log.appendLine(`Asking ${integration.displayName} about thread ${thread.id} `
        + `(${choice.sessionMode}, ${choice.runMode}) in ${cwd}`);
      try {
        let args = integration.buildArgs({ prompt, sessionMode: choice.sessionMode,
          resumeSessionId: forkableSession?.sessionId, newSessionId, runMode: choice.runMode,
          mcpServerPath: getBundledServerPath(services.context) });
        if (choice.runMode === "interactive") {
          if (newSessionId)
            await recordFollowupSession(model.store, branch, newSessionId, cwd, integration.agent);
          startTerminal(services, integration, command, args, cwd, `${integration.authorName}: ${threadTitle}`,
            operation);
        } else {
          await answerInBackground(model, services, threadTitle, operation, { store: model.store, branch,
            threadId: thread.id, agent: integration, command, args, cwd, newSessionId,
            onLine: line => services.log.appendLine(line.slice(0, 500)) });
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not start ${integration.displayName}: ${getErrorMessage(e)}`);
        await services.errors.recordError(integration.agent, operation, getErrorMessage(e));
      }
    }
  }
}

/** Gets the QuickPick's prompt, explaining why the review session can't be forked if it can't. */
function getPlaceHolder(reviewSession: ReviewSession | undefined, forkableSession: ReviewSession | undefined,
  commands: Map<AgentKind, AgentCommand>): string {
  let question = "How should the agent answer? (Enter = first option)";
  if (reviewSession && !forkableSession) {
    let reason = commands.has(reviewSession.agent) ? `its folder ${reviewSession.cwd} no longer exists`
      : `the ${getAgentIntegration(reviewSession.agent).displayName} CLI, which ran it, was not found`;
    return `The review session can't be forked because ${reason}. ${question}`;
  }
  return question;
}

/**
 * Gets the session to fork: the one that opened the thread, if recorded, else the latest session
 * that wrote the review.
 */
function findSessionToFork(review: Review, threadId: string | undefined): ReviewSession | undefined {
  let openingSessionId = review.threads.find(t => t.id === threadId)?.comments[0]?.sessionId;
  return review.sessions.find(s => s.sessionId === openingSessionId) ?? findLatestSession(review, "review");
}

/**
 * Runs the agent in a new terminal. When the terminal's process exits, its exit code is recorded
 * as a success (0) or an error of `operation`.
 */
function startTerminal(services: AgentServices, integration: AgentIntegration, command: AgentCommand,
  args: string[], cwd: string, name: string, operation: string): void {
  let terminal = vscode.window.createTerminal({ name, cwd, shellPath: command.command,
    shellArgs: [...command.args, ...args] });
  terminal.show();
  let subscription = vscode.window.onDidCloseTerminal(closed => {
    let exitCode = closed.exitStatus?.code;
    if (closed === terminal) {
      subscription.dispose();
      if (exitCode === 0)
        void services.errors.recordSuccess(integration.agent);
      else if (exitCode !== undefined)
        void services.errors.recordError(integration.agent, operation, `The terminal exited with code ${exitCode}.`);
    }
  });
  services.context.subscriptions.push(subscription);
}

/**
 * Runs answerThreadInBackground while showing progress in the status bar, and records the outcome
 * as a success or an error of `operation`. `threadTitle` names the thread in messages, e.g.
 * "model.ts:42".
 */
async function answerInBackground(model: BranchReviewModel, services: AgentServices, threadTitle: string,
  operation: string, request: BackgroundAnswerRequest): Promise<void> {
  let { agent } = request;
  let statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusItem.text = `$(sync~spin) ${agent.authorName}: ${threadTitle}`;
  statusItem.tooltip = `${agent.displayName} is answering a Branch Review Studio thread (see the Branch Review `
    + "Studio log)";
  statusItem.show();
  try {
    let answer = await answerThreadInBackground(request);
    await model.refresh();
    let isFailure = answer.isError || answer.exitCode !== 0;
    if (isFailure) {
      await services.errors.recordError(agent.agent, operation,
        answer.errorMessage ?? `${agent.displayName} exited with code ${answer.exitCode}.`);
    } else {
      await services.errors.recordSuccess(agent.agent);
    }
    let message = isFailure
      ? `${agent.displayName} failed to answer the thread on ${threadTitle} (exit code ${answer.exitCode}).`
      : `${agent.displayName} answered the thread on ${threadTitle}.`;
    let canOpenInCodex = agent.agent === "codex" && answer.sessionId
      && vscode.extensions.getExtension(codexExtensionId) !== undefined;
    let buttons = ["Show Thread", ...canOpenInCodex ? ["Continue in Codex"] : []];
    void vscode.window.showInformationMessage(message, ...buttons).then(button => button === "Show Thread"
      ? vscode.commands.executeCommand("branchReviewStudio.openThread", request.threadId)
      : button && answer.sessionId && openCodexThread(answer.sessionId));
  } finally {
    statusItem.dispose();
  }
}

/**
 * Answers a thread with a VS Code language model, which may read the repo with read-only tools
 * (see RepoTools and answerThreadWithModel), while a cancellable progress notification names each
 * tool call. Records the outcome as a success or an error of the language model integration;
 * cancelling isn't an error.
 */
async function answerWithLanguageModel(model: BranchReviewModel, services: AgentServices,
  chat: vscode.LanguageModelChat, context: ThreadMessageContext): Promise<void> {
  let { review, thread, location } = context;
  let threadTitle = getThreadTitle(context);
  let cancellation = new AbortController();
  let tools = new RepoTools(model.repoRoot, model.snapshot.mergeBase?.mergeBaseSha ?? review.mergeBaseSha,
    { signal: cancellation.signal });
  let nearbyDiff = await tools.getDiffNear(thread.file, thread.side, location.startLine, location.endLine)
    .catch(() => undefined);
  services.log.appendLine(`Asking ${chat.name} (${chat.vendor}/${chat.id}) about thread ${thread.id}`);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
    title: `${chat.name} is answering the thread on ${threadTitle}` }, async (progress, token) => {
    let subscription = token.onCancellationRequested(() => cancellation.abort());
    try {
      await answerThreadWithModel({ store: model.store, branch: review.branch, threadId: thread.id,
        model: createToolCallingModel(chat, token), prompt: buildLanguageModelPrompt(context, nearbyDiff), tools,
        onToolCall: call => {
          let callText = `${call.name} ${JSON.stringify(call.input)}`;
          progress.report({ message: callText.slice(0, 100) });
          services.log.appendLine(`  ${callText}`);
        } });
      await services.errors.recordSuccess("languageModel");
      await model.refresh();
      void vscode.window.showInformationMessage(`${chat.name} answered the thread on ${threadTitle}.`, "Show Thread")
        .then(button => button && vscode.commands.executeCommand("branchReviewStudio.openThread", thread.id));
    } catch (e) {
      if (token.isCancellationRequested) {
        services.log.appendLine(`Cancelled asking ${chat.name}.`);
      } else {
        let message = describeLanguageModelError(e);
        services.log.appendLine(`${chat.name} failed: ${message}`);
        void vscode.window.showErrorMessage(`${chat.name} failed to answer the thread on ${threadTitle}: ${message}`);
        await services.errors.recordError("languageModel", "Ask Agent (language model)", message);
      }
    } finally {
      subscription.dispose();
    }
  });
}

/** Gets what the prompts need to know about a thread whose last comment is the user's new message. */
async function getMessageContext(model: BranchReviewModel, review: Review, thread: ReviewThread)
  : Promise<ThreadMessageContext> {
  let location = model.snapshot.threadLocations.get(thread.id) ?? { ...thread.anchor, isOutdated: false };
  return { review, thread, fileLines: await model.getFileLines(thread.file, thread.side), location };
}

/** Gets a short name of a thread for messages, e.g. "model.ts:42". */
function getThreadTitle({ thread, location }: ThreadMessageContext): string {
  return `${thread.file.split("/").pop()}:${location.startLine}`;
}
