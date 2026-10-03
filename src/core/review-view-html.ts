import * as path from "node:path";
import { ChangedFile } from "./git";
import { describeGroupSize } from "./groups";
import { escapeHtml, renderMarkdownSubset, stripMarkdown, truncateText } from "./markdown-subset";
import { isSectionStale, OutlineFile, OutlineSection, OutlineThread, ReviewOutline } from "./review-outline";
import { formatCount } from "./review";

/** What the Branch Review view shows (see renderReviewViewBody). */
export interface ReviewViewData {
  /** Undefined on a detached HEAD */
  branch: string | undefined;
  baseBranch: string;
  mergeBase: { baseRef: string, mergeBaseSha: string } | undefined;
  /** Why `mergeBase` is undefined */
  mergeBaseError: string | undefined;
  /** The review's overall summary (markdown), if any */
  summary: string | undefined;
  outline: ReviewOutline;
}

/** Commands that the buttons in the view's header run, without the `branchReviewStudio.` prefix. */
export const headerCommands = [
  { id: "changeBaseBranch", title: "Change Base Branch…", icon: "arrow-swap" },
  { id: "switchBranch", title: "Switch Branch…", icon: "git-branch" },
  { id: "openAllChanges", title: "Open All Changes", icon: "diff-multiple" },
  { id: "refresh", title: "Refresh", icon: "refresh" },
  { id: "openSettings", title: "Settings and Integrations", icon: "gear" },
] as const;

/** A validated request from the view's script (see parseViewMessage). */
export type ViewRequest =
  | { action: "runCommand", commandId: typeof headerCommands[number]["id"] }
  /** Open the changes of a section's group */
  | { action: "openGroup", section: OutlineSection }
  /** Open a file's diff in the section's view, the file itself, or its whole-file diff */
  | { action: "openFile" | "openEditor" | "openWholeDiff", section: OutlineSection, file: OutlineFile }
  | { action: "revealThread", section: OutlineSection, file: OutlineFile, thread: OutlineThread };

/** Maximum length of the text of a thread row; CSS shortens it further to fit the view's width */
const maxThreadTextLength = 300;

/**
 * Renders the content of the Branch Review view (inside its `<body>`): a header with the branch,
 * merge-base and buttons, then the outline's sections, files and threads as a tree. Each clickable
 * row has `data-action` and the `data-group`/`data-path`/`data-thread` that identify its item, for
 * parseViewMessage; collapsible rows are in a `.node` with a unique `data-key`. The tree's rows
 * and their buttons are not Tab stops; the view's script makes one row the tree's Tab stop. Every
 * string from the review or git is escaped.
 */
export function renderReviewViewBody(data: ReviewViewData): string {
  let { outline } = data;
  let fileCount = outline.sections.flatMap(s => s.files).length;
  let notices = [
    data.mergeBaseError && `<div class="notice error">${escapeHtml(data.mergeBaseError)}</div>`,
    data.branch === undefined && `<div class="notice">HEAD is detached, so comments can't be saved.</div>`,
    data.mergeBase && fileCount === 0 && `<div class="notice">No changes since the merge-base.</div>`,
    outline.isStale && `<div class="notice warning">The merge-base changed since the groups were posted, so the `
      + "diffs show all changes of each file. Ask the agent to post the groups again.</div>",
  ];
  let tree = outline.sections.map(section => section.group ? renderGroup(outline, section)
    : section.files.map(file => renderFile(section, file, 1)).join("")).join("");
  return `${renderHeader(data)}${notices.filter(n => n).join("")}
<div class="tree" role="tree" aria-label="Changed files and review threads">${tree}</div>`;
}

/**
 * Validates a message from the view's script and finds the items it refers to. Returns undefined
 * if the message is malformed or refers to items that the outline doesn't have (e.g. because the
 * review changed since the view was rendered).
 */
export function parseViewMessage(message: unknown, outline: ReviewOutline): ViewRequest | undefined {
  let fields = ["action", "group", "path", "thread", "command"];
  if (typeof message !== "object" || message === null
    || fields.some(key => !["string", "undefined"].includes(typeof Reflect.get(message, key))))
    return undefined;
  let get = (key: string) => Reflect.get(message, key) as string | undefined;
  let action = get("action");
  let groupId = get("group");
  let command = headerCommands.find(c => c.id === get("command"));
  let section = outline.sections.find(s => s.group?.id === groupId);
  let file = section?.files.find(f => f.path === get("path"));
  let thread = file?.threads.find(t => t.thread.id === get("thread"));
  if (action === "runCommand" && command)
    return { action, commandId: command.id };
  if (action === "openGroup" && section?.group)
    return { action, section };
  if ((action === "openFile" || action === "openEditor" || action === "openWholeDiff") && section && file)
    return { action, section, file };
  if (action === "revealThread" && section && file && thread)
    return { action, section, file, thread };
  return undefined;
}

/** Gets the one-line text that represents a thread: its first comment without markdown. */
export function getThreadText(thread: OutlineThread): string {
  return stripMarkdown(thread.thread.comments[0]?.body ?? "") || "(empty)";
}

function renderHeader(data: ReviewViewData): string {
  let branch = escapeHtml(data.branch ?? "(detached HEAD)");
  let base = data.mergeBase ? `${escapeHtml(data.mergeBase.baseRef)} <code title="merge-base ${escapeHtml(
    data.mergeBase.mergeBaseSha)}">${escapeHtml(data.mergeBase.mergeBaseSha.slice(0, 8))}</code>`
    : `${escapeHtml(data.baseBranch)} <span class="error">(no merge-base)</span>`;
  let buttons = headerCommands.map(c => `<button class="icon-button codicon codicon-${c.icon}" `
    + `data-action="runCommand" data-command="${c.id}" title="${c.title}" aria-label="${c.title}"></button>`).join("");
  let summary = data.summary ? `<div class="node review-summary collapsed" data-key="summary">
<div class="row" role="button" tabindex="0" aria-expanded="false" data-toggle>${twistie}Review summary</div>
<div class="children markdown">${renderMarkdownSubset(data.summary)}</div></div>` : "";
  return `<div class="header">
<div class="branch"><span class="codicon codicon-git-compare"></span>`
    + `<span><b>${branch}</b> <span class="dim">vs</span> ${base}</span></div>
<div class="toolbar" role="toolbar" aria-label="Branch Review commands">${buttons}
<label class="filter"><input type="checkbox" id="unresolvedOnly"> Unresolved only</label></div>
${summary}</div>`;
}

function renderGroup(outline: ReviewOutline, section: OutlineSection): string {
  let group = section.group!;
  let attributes = `data-action="openGroup"${groupAttribute(section)} title="Open this group's changes"`;
  let files = section.files.map(file => renderFile(section, file, 2)).join("");
  return `<div class="node group" data-key="${escapeHtml(`g:${group.id ?? ""}`)}">
${renderRow("group-row", 1, true, attributes, `<span class="group-title">${escapeHtml(section.title)}</span>`
    + `<span class="dim">${escapeHtml(describeGroupSize(group))}</span>`
    + (isSectionStale(outline, section) ? `<span class="tag warning">regroup: merge-base changed</span>` : ""))}
<div class="children" role="group"><div class="summary markdown">${renderMarkdownSubset(group.summary)}</div>${files}`
    + `</div></div>`;
}

/** Renders a file's row, and its threads' rows under it; `level` is the depth of the file's row. */
function renderFile(section: OutlineSection, file: OutlineFile, level: number): string {
  let folder = path.posix.dirname(file.path);
  let openCount = file.threads.filter(t => t.thread.status === "open").length;
  let status = file.change?.status;
  let attributes = `data-action="openFile"${groupAttribute(section)} data-path="${escapeHtml(file.path)}" `
    + `title="${escapeHtml(describeFile(file, section))}"`;
  let content = `<span class="status status-${status ?? "Unchanged"}" title="${status ?? "Unchanged"}">`
    + `${status ? statusLetters[status] : "–"}</span>`
    + `<span class="name">${escapeHtml(path.posix.basename(file.path))}</span>`
    + (folder === "." ? "" : `<span class="dim folder">${escapeHtml(folder)}</span>`)
    + (file.isPartial ? `<span class="tag">partial</span>` : "")
    + (openCount > 0 ? `<span class="count" title="${formatCount(openCount, "open thread")}">${openCount}</span>` : "")
    + `<span class="actions"><button class="icon-button codicon codicon-go-to-file" tabindex="-1" `
    + `data-action="openEditor" title="Open File" aria-label="Open File"></button>`
    + `<button class="icon-button codicon codicon-diff" tabindex="-1" data-action="openWholeDiff" `
    + `title="Open Changes (whole file)" aria-label="Open Changes (whole file)"></button></span>`;
  let threads = file.threads.map(t => renderThread(section, file, t, level + 1)).join("");
  let row = renderRow("file-row", level, file.threads.length > 0, attributes, content);
  return file.threads.length === 0 ? row : `<div class="node" data-key="${escapeHtml(`f:${section.group?.id ?? ""}:`
    + file.path)}">${row}<div class="children" role="group">${threads}</div></div>`;
}

function renderThread(section: OutlineSection, file: OutlineFile, thread: OutlineThread, level: number): string {
  let { status, side, id } = thread.thread;
  let severity = thread.thread.severity && escapeHtml(thread.thread.severity);
  let text = truncateText(getThreadText(thread), maxThreadTextLength);
  let details = [`L${thread.line}`, side === "base" ? "base" : "", thread.location?.isOutdated ? "outdated" : ""]
    .filter(d => d !== "").join(" · ");
  let attributes = `data-action="revealThread"${groupAttribute(section)} data-path="${escapeHtml(file.path)}" `
    + `data-thread="${escapeHtml(id)}" title="${escapeHtml(text)}"`;
  let content = `<span class="codicon codicon-${status === "resolved" ? "pass" : "comment-discussion"} state" `
    + `title="${status === "resolved" ? "Resolved" : "Open"}"></span>`
    + (severity ? `<span class="severity severity-${severity}">${severity}</span>` : "")
    + `<span class="text">${escapeHtml(text)}</span><span class="dim">${details}</span>`;
  return renderRow(`thread-row ${escapeHtml(status)}`, level, false, attributes, content);
}

/**
 * Renders a tree row; `isExpandable` rows get a twistie (`data-toggle`) and aria-expanded, which
 * the view's script updates.
 */
function renderRow(className: string, level: number, isExpandable: boolean, attributes: string, content: string)
  : string {
  return `<div class="row ${className}" role="treeitem" aria-level="${level}" tabindex="-1" ${attributes}`
    + `${isExpandable ? ` aria-expanded="true"` : ""}>${isExpandable ? twistie : `<span class="twistie"></span>`}`
    + `${content}</div>`;
}

/**
 * Gets the `data-group` attribute of a section's rows; none for the Ungrouped group and for the
 * section of a review without groups.
 */
function groupAttribute(section: OutlineSection): string {
  return section.group?.id === undefined ? "" : ` data-group="${escapeHtml(section.group.id)}"`;
}

function describeFile(file: OutlineFile, section: OutlineSection): string {
  let renamed = file.change?.oldPath ? ` (renamed from ${file.change.oldPath})` : "";
  return file.path + renamed + (file.isPartial ? `\nThe diff shows the changes of group '${section.group?.name}', `
    + "changes that no group includes, and changes made after the groups were posted." : "");
}

const twistie = `<span class="twistie codicon codicon-chevron-down" data-toggle></span>`;
const statusLetters: Record<ChangedFile["status"], string> = { Added: "A", Modified: "M", Deleted: "D", Renamed: "R" };
