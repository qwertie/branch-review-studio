import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { getAgentChoiceItems, getAgentIntegration } from "../core/agent-choice-items";
import { AgentChoice, buildThreadPrompt, ThreadMessageContext } from "../core/agent-commands";
import { AgentCommand, AgentIntegration } from "../core/agent-integration";
import { getForkProblem, resolveDefaultChoice, SendTarget, SessionToFork } from "../core/ask-agent-defaults";
import { getErrorMessage } from "../core/files";
import { findLatestSession, IntegrationId, Review, ReviewSession, ReviewThread } from "../core/review";
import { answerThreadInBackground, BackgroundAnswerRequest, recordFollowupSession } from "../core/thread-answer";
import {
  buildChatOpenArgs, chatAgentName, chatOpenCommand, newLocalChatCommand, vscodeChatDisplayName,
} from "../core/vscode-chat";
import {
  AgentServices, AvailableIntegrations, codexExtensionId, findAvailableIntegrations, getBundledServerPath,
  openCodexThread, readAskAgentDefaults,
} from "./agents";
import { ReviewCommentController } from "./comments";
import { BranchReviewModel } from "./model";

/**
 * Saves the user's message in a thread and sends it, with the thread's context, to an agent
 * (Claude Code or Codex): either as a fork of the session that wrote the review (which reuses its
 * prompt cache), with the agent that ran that session, or as a fresh session, in a terminal or in
 * the background. Alternatively, a new chat in VS Code's chat answers it (see askInVscodeChat).
 * With `defaultAgent` (the "Send to <agent>" buttons), it sends to that agent as the askAgent
 * settings say (see resolveDefaultChoice); otherwise, or if that agent isn't available, the user
 * picks how.
 */
export async function askAgent(model: BranchReviewModel, comments: ReviewCommentController,
  reply: vscode.CommentReply, services: AgentServices, defaultAgent?: IntegrationId): Promise<void> {
  let integrations = await findAvailableIntegrations();
  let { commands, available } = integrations;
  if (reply.text.trim() === "") {
    void vscode.window.showErrorMessage("Type a message for the agent first.");
  } else if (available.length === 0) {
    void vscode.window.showErrorMessage("Could not find the Claude Code CLI (claude), the Codex CLI (codex) or VS "
      + "Code's chat. Install a CLI (or set the branchReviewStudio.claudePath or branchReviewStudio.codexPath "
      + "setting).");
  } else {
    let review = model.snapshot.review;
    let reviewSession = review && findSessionToFork(review, comments.getThreadId(reply.thread));
    let sessionToFork = reviewSession && describeSessionToFork(reviewSession);
    let forkProblem = sessionToFork && getForkProblem(sessionToFork, available);
    let forkableSession = forkProblem === undefined ? reviewSession : undefined;
    let defaults = readAskAgentDefaults(getScope(model));
    // Resolved even for the pickers, which then say why the default agent isn't available
    let resolved = resolveDefaultChoice({ ...defaults, agent: defaultAgent ?? defaults.agent }, available,
      sessionToFork);
    let choice = (defaultAgent ? resolved.choice : undefined)
      ?? await pickChoice(integrations, forkableSession, resolved.problem, forkProblem);
    let threadId = choice && await comments.saveMessage(reply);
    let { review: savedReview, branch } = model.snapshot;
    let thread = savedReview?.threads.find(t => t.id === threadId);
    let command = choice && choice.agent !== "vscodeChat" ? commands.get(choice.agent) : undefined;
    let context = thread && savedReview && await getMessageContext(model, savedReview, thread);
    if (choice?.agent === "vscodeChat" && context) {
      await askInVscodeChat(model, services, context);
    } else if (choice && choice.agent !== "vscodeChat" && command && thread && context && branch) {
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

/**
 * Keeps the comment boxes' primary buttons ("Send to <agent>") up to date: after each refresh of
 * `model` and each change of this extension's settings, resolves the askAgent settings for each
 * thread and for new threads (see resolveDefaultChoice), and gives `comments` the results.
 */
export function trackSendTargets(model: BranchReviewModel, comments: ReviewCommentController,
  log: vscode.OutputChannel): vscode.Disposable {
  let update = () => void findSendTargets(model).then(findTarget => comments.setSendTargetFinder(findTarget),
    e => log.appendLine(`Could not update the Send buttons: ${getErrorMessage(e)}`));
  update();
  return vscode.Disposable.from(model.onDidChange(update), vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration("branchReviewStudio"))
      update();
  }));
}

/**
 * Finds the available integrations and reads the askAgent settings, and returns a function that
 * gets the SendTarget of a thread of the current review (undefined = a new thread).
 */
async function findSendTargets(model: BranchReviewModel): Promise<(threadId: string | undefined) => SendTarget> {
  let { available } = await findAvailableIntegrations();
  let defaults = readAskAgentDefaults(getScope(model));
  return threadId => {
    let review = model.snapshot.review;
    let session = review && findSessionToFork(review, threadId);
    return resolveDefaultChoice(defaults, available, session && describeSessionToFork(session)).choice?.agent
      ?? "ask";
  };
}

/**
 * Lets the user pick how to send the message from Ask Agent's choices (see getAgentChoiceItems).
 * The QuickPick's title shows `problem` (why the default agent can't be used), and its prompt
 * `forkProblem` (why the review session can't be forked).
 */
async function pickChoice({ commands, available }: AvailableIntegrations, forkableSession: ReviewSession | undefined,
  problem: string | undefined, forkProblem: string | undefined): Promise<AgentChoice | undefined> {
  let items = getAgentChoiceItems([...commands.keys()], forkableSession, available.includes("vscodeChat"))
    .map(i => i.isSeparator ? { ...i, kind: vscode.QuickPickItemKind.Separator } : i);
  let question = "How should the agent answer? (Enter = first option)";
  let placeHolder = forkProblem ? `The review session can't be forked because ${forkProblem}. ${question}` : question;
  return (await vscode.window.showQuickPick(items, { title: problem, placeHolder }))?.choice;
}

/**
 * Gets the session to fork: the one that opened the thread, if recorded, else the latest session
 * that wrote the review.
 */
function findSessionToFork(review: Review, threadId: string | undefined): ReviewSession | undefined {
  let openingSessionId = review.threads.find(t => t.id === threadId)?.comments[0]?.sessionId;
  return review.sessions.find(s => s.sessionId === openingSessionId) ?? findLatestSession(review, "review");
}

/** Gets what resolveDefaultChoice needs to know about a session; checks that its folder exists. */
function describeSessionToFork(session: ReviewSession): SessionToFork {
  return { ...session, hasFolder: fs.existsSync(session.cwd) };
}

/** Gets the folder whose settings Ask Agent uses (the askAgent settings are resource-scoped). */
function getScope(model: BranchReviewModel): vscode.Uri {
  return vscode.Uri.file(model.repoRoot);
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
 * Starts a new chat with VS Code's own agent (not an agent-host harness such as VS Code's Claude
 * agent), and sends it the thread message, with the thread's lines attached, for the Branch
 * Reviewer agent (see buildChatOpenArgs). The answer reaches the thread only if the agent calls
 * review_reply, since extensions can't read chat replies. The chat commands are internal, so a
 * failure is shown and recorded as the integration's last error.
 */
async function askInVscodeChat(model: BranchReviewModel, services: AgentServices, context: ThreadMessageContext)
  : Promise<void> {
  let args = buildChatOpenArgs(context, vscode.Uri.file(model.getFullPath(context.thread.file)));
  services.log.appendLine(`Asking ${vscodeChatDisplayName} (${chatAgentName} agent) about thread `
    + context.thread.id);
  try {
    await vscode.commands.executeCommand(newLocalChatCommand);
    await vscode.commands.executeCommand(chatOpenCommand, args);
    await services.errors.recordSuccess("vscodeChat");
  } catch (e) {
    let message = `${getErrorMessage(e)} (Ask Agent uses VS Code's internal commands ${newLocalChatCommand} and `
      + `${chatOpenCommand}, which this VS Code version may not support.)`;
    void vscode.window.showErrorMessage(`Could not open ${vscodeChatDisplayName}: ${message}`);
    await services.errors.recordError("vscodeChat", "Ask Agent (VS Code Chat)", message);
  }
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
