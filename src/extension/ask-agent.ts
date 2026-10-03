import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { AgentRunMode, AgentSessionMode, buildClaudeArgs, buildThreadPrompt } from "../core/agent-commands";
import { findLatestSession, Review, ReviewSession } from "../core/review";
import { answerThreadInBackground, BackgroundAnswerRequest, recordFollowupSession } from "../core/thread-answer";
import { ReviewCommentController } from "./comments";
import { findClaude } from "./install";
import { BranchReviewModel, getErrorMessage } from "./model";

/** An item of Ask Agent's QuickPick: how Claude Code should answer. */
interface AgentChoice extends vscode.QuickPickItem {
  sessionMode: AgentSessionMode;
  runMode: AgentRunMode;
}

/**
 * Saves the user's message in a thread and sends it, with the thread's context, to Claude Code:
 * either as a fork of the session that wrote the review (which reuses its prompt cache) or as a
 * fresh session, in a terminal or in the background.
 */
export async function askAgent(model: BranchReviewModel, comments: ReviewCommentController,
  reply: vscode.CommentReply, log: vscode.OutputChannel): Promise<void> {
  let review = model.snapshot.review;
  let claude = findClaude();
  if (reply.text.trim() === "") {
    void vscode.window.showErrorMessage("Type a message for the agent first.");
  } else if (claude) {
    let reviewSession = review && findSessionToFork(review, comments.getThreadId(reply.thread));
    // `claude --resume` finds a session only in the folder it ran in
    let forkableSession = reviewSession && fs.existsSync(reviewSession.cwd) ? reviewSession : undefined;
    let question = "How should Claude Code answer? (Enter = first option)";
    let placeHolder = reviewSession && !forkableSession
      ? `The review session can't be forked because its folder ${reviewSession.cwd} no longer exists. ${question}`
      : question;
    let choice = await vscode.window.showQuickPick(getAgentChoices(forkableSession), { placeHolder });
    let threadId = choice && await comments.saveMessage(reply);
    let { review: savedReview, branch } = model.snapshot;
    let thread = savedReview?.threads.find(t => t.id === threadId);
    if (choice && thread && savedReview && branch) {
      let cwd = choice.sessionMode === "fork" && forkableSession ? forkableSession.cwd : model.repoRoot;
      let location = model.snapshot.threadLocations.get(thread.id) ?? { ...thread.anchor, isOutdated: false };
      let threadTitle = `${thread.file.split("/").pop()}:${location.startLine}`;
      let prompt = buildThreadPrompt({ review: savedReview, thread,
        fileLines: await model.getFileLines(thread.file, thread.side), location }, choice.sessionMode);
      let newSessionId = randomUUID();
      let args = buildClaudeArgs({ prompt, sessionMode: choice.sessionMode,
        resumeSessionId: forkableSession?.sessionId, newSessionId, runMode: choice.runMode });
      log.appendLine(`Asking Claude about thread ${thread.id} (${choice.sessionMode}, ${choice.runMode}) in ${cwd}`);
      try {
        if (choice.runMode === "interactive") {
          await recordFollowupSession(model.store, branch, newSessionId, cwd);
          let terminal = vscode.window.createTerminal({ name: `Claude: ${threadTitle}`, cwd,
            shellPath: claude.command, shellArgs: [...claude.args, ...args] });
          terminal.show();
        } else {
          await answerInBackground(model, threadTitle, { store: model.store, branch, threadId: thread.id, claude, args,
            cwd, newSessionId, agentName: "Claude", onLine: line => log.appendLine(line.slice(0, 500)) });
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`Could not start Claude Code: ${getErrorMessage(e)}`);
      }
    }
  }
}

/**
 * Lists the ways to send the message, default first: forking the review session is cheaper and
 * better informed than a fresh session, so it comes first when there is a session to fork.
 */
function getAgentChoices(reviewSession: ReviewSession | undefined): AgentChoice[] {
  let forkDescription = reviewSession ? `forks session ${reviewSession.sessionId.slice(0, 8)}` : "";
  let fork: AgentChoice[] = reviewSession === undefined ? [] : [
    { label: "$(repo-forked) Fork review session, interactive terminal", description: forkDescription,
      sessionMode: "fork", runMode: "interactive" },
    { label: "$(repo-forked) Fork review session, background", description: forkDescription,
      detail: "Runs claude -p; the answer appears in the thread", sessionMode: "fork", runMode: "background" },
  ];
  return [...fork,
    { label: "$(add) Fresh session, interactive terminal", sessionMode: "fresh", runMode: "interactive" },
    { label: "$(add) Fresh session, background", detail: "Runs claude -p; the answer appears in the thread",
      sessionMode: "fresh", runMode: "background" },
  ];
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
 * Runs answerThreadInBackground while showing progress in the status bar. `threadTitle` names the
 * thread in messages, e.g. "model.ts:42".
 */
async function answerInBackground(model: BranchReviewModel, threadTitle: string, request: BackgroundAnswerRequest)
  : Promise<void> {
  let statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusItem.text = `$(sync~spin) Claude: ${threadTitle}`;
  statusItem.tooltip = "Claude Code is answering a Branch Review Studio thread (see the Branch Review Studio log)";
  statusItem.show();
  try {
    let answer = await answerThreadInBackground(request);
    await model.refresh();
    let message = answer.isError || answer.exitCode !== 0
      ? `Claude Code failed to answer the thread on ${threadTitle} (exit code ${answer.exitCode}).`
      : `Claude Code answered the thread on ${threadTitle}.`;
    void vscode.window.showInformationMessage(message, "Show Thread").then(choice => choice
      && vscode.commands.executeCommand("branchReviewStudio.openThread", request.threadId));
  } finally {
    statusItem.dispose();
  }
}
