import { ToolDefinition, ToolSet, truncateText } from "./repo-tools";
import { addComment, formatCount } from "./review";
import { ReviewStore } from "./store";

/** Name of the integration that answers threads with VS Code's language models, shown in the UI. */
export const languageModelDisplayName = "VS Code Language Models";

/** Detail line of Ask Agent's choice that sends the message to a VS Code language model. */
export const languageModelChoiceDetail = "Answers only, read-only, no session: it reads the repo with read-only "
  + "tools, can't edit files, and its answer appears in the thread";

/** Default limit on the rounds of tool calls in which runToolLoop runs tools. */
export const defaultMaxToolRounds = 12;
/** Rough number of characters per token; low (code has short tokens) so that estimates err high. */
const charsPerToken = 3;
/**
 * Share of a model's maxInputTokens that runToolLoop lets the conversation use, by its estimate
 * (see charsPerToken); the rest allows for the estimate's error.
 */
const inputBudgetShare = 0.8;
/** Share of that budget after which runToolLoop tells the model to answer without more tool calls. */
const nearlyUsedBudgetShare = 0.9;

/** A request from a language model to call a tool. */
export interface ToolCall {
  /** Id that pairs the call with its ToolResult */
  callId: string;
  name: string;
  input: object;
}

/** The result of a ToolCall, which goes back to the model. */
export interface ToolResult {
  callId: string;
  text: string;
}

/**
 * A message of a conversation with a language model: the user's (the prompt, or the results of the
 * model's tool calls, with an optional note), or the model's (text and tool calls).
 */
export type ChatMessage =
  | { role: "user", text: string, toolResults?: ToolResult[] }
  | { role: "assistant", text: string, toolCalls: ToolCall[] };

/** A language model's complete reply to one request. */
export interface ModelReply {
  text: string;
  /** Empty if the model gave its answer instead of calling tools */
  toolCalls: ToolCall[];
}

/**
 * A chat model that can request tool calls, e.g. a VS Code language model (see
 * src/extension/language-models.ts, which adapts `vscode.lm` to this interface).
 */
export interface ToolCallingModel {
  /** Human-readable name, e.g. "GPT-5" */
  readonly name: string;
  /** Limit on the size of one request (the conversation and the tool definitions), in tokens */
  readonly maxInputTokens: number;
  /** Sends the conversation and the tools that the model may call; resolves to the model's reply */
  sendRequest(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelReply>;
}

/** What runToolLoop returns. */
export interface ToolLoopResult {
  /** Text of the model's last reply */
  text: string;
  /** Number of rounds in which tools ran */
  toolRounds: number;
  /**
   * True if the model still wanted to call tools when runToolLoop stopped running them (after
   * `maxToolRounds` rounds, or when the conversation nearly reached the model's input limit)
   */
  isStoppedEarly: boolean;
}

/**
 * Sends `prompt` to `model` and, as long as the model calls tools, runs them and sends their
 * results back, for at most `maxToolRounds` rounds. Tool results are truncated to keep the
 * conversation within a budget based on the model's maxInputTokens (see inputBudgetShare). With
 * the results of the last round (by `maxToolRounds`, or when the budget is nearly used), the model
 * is told to answer without more tool calls. Calls `onToolCall` before running each tool. Throws
 * the model's errors.
 */
export async function runToolLoop(model: ToolCallingModel, prompt: string, tools: ToolSet,
  maxToolRounds = defaultMaxToolRounds, onToolCall?: (call: ToolCall) => void): Promise<ToolLoopResult> {
  let messages: ChatMessage[] = [{ role: "user", text: prompt }];
  let budgetChars = Math.floor(model.maxInputTokens * charsPerToken * inputBudgetShare);
  let usedChars = prompt.length + JSON.stringify(tools.definitions).length;
  let lastRoundNote: string | undefined;
  for (let toolRounds = 0; ; toolRounds++) {
    let reply = await model.sendRequest(messages, tools.definitions);
    if (reply.toolCalls.length === 0 || lastRoundNote !== undefined || toolRounds === maxToolRounds)
      return { text: reply.text, toolRounds, isStoppedEarly: reply.toolCalls.length > 0 };
    messages.push({ role: "assistant", ...reply });
    usedChars += reply.text.length + JSON.stringify(reply.toolCalls).length;
    let toolResults: ToolResult[] = [];
    for (let call of reply.toolCalls) {
      onToolCall?.(call);
      let text = truncateText(await tools.callTool(call.name, call.input), Math.max(0, budgetChars - usedChars),
        "The conversation is near your input limit.");
      usedChars += text.length;
      toolResults.push({ callId: call.callId, text });
    }
    lastRoundNote = usedChars >= budgetChars * nearlyUsedBudgetShare
      ? "The conversation is nearly as long as your input limit allows."
      : toolRounds + 1 === maxToolRounds ? `That was the last round of tool calls (the limit is ${maxToolRounds}).`
        : undefined;
    messages.push({ role: "user", toolResults, text: lastRoundNote === undefined ? ""
      : `${lastRoundNote} Make no more tool calls; answer now with what you know, and say what you couldn't check.` });
  }
}

/** Parameters of `answerThreadWithModel`. */
export interface ModelAnswerRequest {
  store: ReviewStore;
  branch: string;
  threadId: string;
  model: ToolCallingModel;
  /** From buildLanguageModelPrompt */
  prompt: string;
  tools: ToolSet;
  maxToolRounds?: number;
  onToolCall?: (call: ToolCall) => void;
}

/**
 * Answers a thread with a language model (see runToolLoop) and posts the answer to the thread, as
 * a comment by the model (see getModelAuthorName). Throws the model's errors without posting.
 */
export async function answerThreadWithModel(request: ModelAnswerRequest): Promise<ToolLoopResult> {
  let { model, threadId } = request;
  let result = await runToolLoop(model, request.prompt, request.tools, request.maxToolRounds, request.onToolCall);
  let body = result.text.trim() !== "" ? result.text : result.isStoppedEarly
    ? `(${model.name} stopped after ${formatCount(result.toolRounds, "round")} of tool calls without answering.)`
    : `(${model.name} gave an empty answer.)`;
  await request.store.updateReview(request.branch, review => {
    let thread = review?.threads.find(t => t.id === threadId);
    if (review && thread)
      addComment(review, thread, { kind: "agent", name: getModelAuthorName(model.name) }, body);
    return thread ? review : undefined;
  });
  return result;
}

/** Gets the author name of a language model's comments, e.g. "GPT-5 (VS Code LM)". */
export function getModelAuthorName(modelName: string): string {
  return `${modelName} (VS Code LM)`;
}

/** What findPreferredModel needs to know about a language model (a subset of vscode.LanguageModelChat). */
export interface ModelInfo {
  vendor: string;
  id: string;
  family: string;
  name: string;
}

/**
 * Finds the model that `preference` (the `branchReviewStudio.languageModel` setting) names, as
 * `vendor/id`, id, family or name (ignoring case); else the first model; undefined if none.
 */
export function findPreferredModel<T extends ModelInfo>(models: T[], preference: string): T | undefined {
  let wanted = preference.trim().toLowerCase();
  let getKeys = (m: ModelInfo) => [getModelPreference(m), m.id, m.family, m.name].map(key => key.toLowerCase());
  return (wanted === "" ? undefined : models.find(m => getKeys(m).includes(wanted))) ?? models[0];
}

/** Gets the value of the `branchReviewStudio.languageModel` setting that names a model: `vendor/id`. */
export function getModelPreference(model: ModelInfo): string {
  return `${model.vendor}/${model.id}`;
}
