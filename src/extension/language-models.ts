import * as vscode from "vscode";
import { getErrorMessage } from "../core/files";
import {
  ChatMessage, findPreferredModel, getModelPreference, ModelReply, ToolCallingModel,
} from "../core/language-model";

/** Explains where VS Code's language models come from, for messages about there being none. */
export const noLanguageModelsMessage = "No VS Code language models are available. They come from GitHub Copilot "
  + "(install GitHub Copilot Chat and sign in), from API keys you add with Manage Models in the Chat view's model "
  + "picker, or from extensions that provide models.";

/** What the settings panel shows about the VS Code Language Models integration. */
export interface LanguageModelStatus {
  /** Whether this editor has VS Code's Language Model API (`vscode.lm`) */
  isApiAvailable: boolean;
  models: vscode.LanguageModelChat[];
  /** The model that Ask Agent offers (see findLanguageModel) */
  selected: vscode.LanguageModelChat | undefined;
  /**
   * Whether VS Code lets this extension send requests to `selected`; undefined if VS Code hasn't
   * asked the user yet (it asks on the first request) or there is no model
   */
  canSendRequest: boolean | undefined;
}

/** Checks whether VS Code's language models are available, which ones, and which one Ask Agent uses. */
export async function checkLanguageModelStatus(context: vscode.ExtensionContext): Promise<LanguageModelStatus> {
  let models = await listLanguageModels();
  let selected = findPreferredModel(models, getLanguageModelSetting());
  return { isApiAvailable: isLanguageModelApiAvailable(), models, selected,
    canSendRequest: selected && context.languageModelAccessInformation.canSendRequest(selected) };
}

/**
 * Finds the language model that Ask Agent uses: the one that the `branchReviewStudio.languageModel`
 * setting names, else the first available one (see findPreferredModel); undefined if there is none.
 */
export async function findLanguageModel(): Promise<vscode.LanguageModelChat | undefined> {
  return findPreferredModel(await listLanguageModels(), getLanguageModelSetting());
}

/**
 * Lets the user pick the language model that answers threads, from a QuickPick of the available
 * models, and saves the choice in the `branchReviewStudio.languageModel` user setting.
 */
export async function chooseLanguageModel(): Promise<void> {
  let models = await listLanguageModels();
  if (models.length === 0) {
    void vscode.window.showErrorMessage(noLanguageModelsMessage);
  } else {
    let current = findPreferredModel(models, getLanguageModelSetting());
    let item = await vscode.window.showQuickPick(models.map(model => ({ model, label: model.name,
      description: `${model.vendor} · ${model.family}${model === current ? " · current" : ""}`,
      detail: `${model.maxInputTokens.toLocaleString()} max input tokens · ${getModelPreference(model)}` })),
    { placeHolder: "Which language model should answer threads (Ask Agent)?", matchOnDescription: true });
    if (item) {
      await vscode.workspace.getConfiguration("branchReviewStudio").update("languageModel",
        getModelPreference(item.model), vscode.ConfigurationTarget.Global);
    }
  }
}

/**
 * Adapts a VS Code language model to the ToolCallingModel interface, which the core's tool-call
 * loop uses; `token` cancels its requests.
 */
export function createToolCallingModel(chat: vscode.LanguageModelChat, token: vscode.CancellationToken)
  : ToolCallingModel {
  return {
    name: chat.name,
    maxInputTokens: chat.maxInputTokens,
    sendRequest: async (messages, tools) => {
      let response = await chat.sendRequest(messages.map(toVscodeMessage), { tools,
        justification: "Branch Review Studio sends your thread message, with the code it is about, to answer it." },
      token);
      let reply: ModelReply = { text: "", toolCalls: [] };
      for await (let part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart)
          reply.text += part.value;
        else if (part instanceof vscode.LanguageModelToolCallPart)
          reply.toolCalls.push({ callId: part.callId, name: part.name, input: part.input });
      }
      return reply;
    },
  };
}

/** Gets the message of a language model request's error, explaining VS Code's error codes. */
export function describeLanguageModelError(e: unknown): string {
  let explanations: Record<string, string> = {
    [vscode.LanguageModelError.NoPermissions.name]: "VS Code did not allow Branch Review Studio to use this language "
      + "model (e.g. you declined its permission prompt). ",
    [vscode.LanguageModelError.Blocked.name]: "The language model blocked the request (e.g. a quota was exceeded). ",
    [vscode.LanguageModelError.NotFound.name]: "The language model is no longer available. ",
  };
  let code = e instanceof vscode.LanguageModelError ? e.code : "";
  return (Object.hasOwn(explanations, code) ? explanations[code] : "") + getErrorMessage(e);
}

/** Whether this editor has VS Code's Language Model API; editors based on VS Code may lack it. */
function isLanguageModelApiAvailable(): boolean {
  return typeof vscode.lm?.selectChatModels === "function";
}

/** Lists VS Code's chat models; none if the Language Model API is missing. */
async function listLanguageModels(): Promise<vscode.LanguageModelChat[]> {
  return isLanguageModelApiAvailable() ? await vscode.lm.selectChatModels() : [];
}

/** Gets the `branchReviewStudio.languageModel` setting, which names the preferred model. */
export function getLanguageModelSetting(): string {
  return vscode.workspace.getConfiguration("branchReviewStudio").get<string>("languageModel") ?? "";
}

/** Converts a core ChatMessage into a VS Code chat message, with tool results before the text. */
function toVscodeMessage(message: ChatMessage): vscode.LanguageModelChatMessage {
  let textParts = message.text === "" ? [] : [new vscode.LanguageModelTextPart(message.text)];
  return message.role === "assistant"
    ? vscode.LanguageModelChatMessage.Assistant([...textParts,
      ...message.toolCalls.map(call => new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input))])
    : vscode.LanguageModelChatMessage.User([...(message.toolResults ?? []).map(result =>
      new vscode.LanguageModelToolResultPart(result.callId, [new vscode.LanguageModelTextPart(result.text)])),
    ...textParts]);
}
