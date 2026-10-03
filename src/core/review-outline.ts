import { AnchorLocation } from "./anchoring";
import { ChangedFile, comparePaths } from "./git";
import { ArrangedGroup, describeGroupSize, GroupLayout } from "./groups";
import { DiffHunk, mapBaseLineToWorkingTree } from "./hunks";
import { Review, ReviewThread } from "./review";

/** What buildReviewOutline needs from the extension's ReviewSnapshot. */
export interface OutlineInput {
  changedFiles: ChangedFile[];
  review: Review | undefined;
  /** Current location of each thread, by thread id */
  threadLocations: Map<string, AnchorLocation>;
  groupLayout: GroupLayout | undefined;
  /**
   * Hunks of the changed files that have threads on the base side, by path, which place those
   * threads among the threads on the modified side
   */
  baseThreadHunks: Map<string, DiffHunk[]>;
}

/**
 * The order in which the Branch Review view, Open All Changes and thread navigation present a
 * review's files and threads: by group (smallest first, then Ungrouped), then by path, then by the
 * threads' current positions in the working tree (see OutlineThread.position).
 */
export interface ReviewOutline {
  /** The review's groups, or, if it has none, one section without a group that lists every file */
  sections: OutlineSection[];
  /** Whether the groups are stale because the merge-base changed (see GroupLayout.isStale) */
  isStale: boolean;
}

/** A group of the outline, or the single section of a review without groups. */
export interface OutlineSection {
  /** Undefined for the single section of a review without groups */
  group: ArrangedGroup | undefined;
  /**
   * The group's heading, numbered unless it is Ungrouped, e.g. "1. Fix CSV quoting"; "" in a review
   * without groups
   */
  title: string;
  /** Sorted by path */
  files: OutlineFile[];
}

/** A file in an OutlineSection. */
export interface OutlineFile {
  /** Repo-relative path with forward slashes */
  path: string;
  /** Undefined for an unchanged file, which is listed because it has threads */
  change: ChangedFile | undefined;
  /** Whether the section's group view of the file hides other groups' changes (see ArrangedFile) */
  isPartial: boolean;
  /** Sorted by position */
  threads: OutlineThread[];
}

/** A thread with its current location. */
export interface OutlineThread {
  thread: ReviewThread;
  /**
   * Current start line (1-based): the start of `location`, else the line where the thread was
   * created
   */
  line: number;
  /**
   * Where the thread's start is in the working-tree file: `line` for a thread on the modified side,
   * else `line` converted by mapBaseLineToWorkingTree (e.g. 12.5 for a line removed after line 12)
   */
  position: number;
  /** Where locateAnchor finds the thread in the file's current text; undefined if not located */
  location: AnchorLocation | undefined;
}

/** A thread at its place in the outline (see listThreadVisits). */
export interface ThreadVisit {
  section: OutlineSection;
  file: OutlineFile;
  thread: OutlineThread;
}

/**
 * Where thread navigation starts: just after/before a thread, or at a line of a file in its
 * working-tree numbering (between the threads of the file whose positions are above and below it).
 */
export type ThreadPosition = { threadId: string } | { file: string, line: number };

/** An entry of the multi-diff editor that Open All Changes opens (see listChangesEntries). */
export type ChangesEntry =
  /** A read-only document that introduces a group: its heading, size and summary */
  | { kind: "heading", section: OutlineSection, fileName: string }
  /** A file's diff, or, if viewGroupId is set, that group's view of it (see buildGroupViewText) */
  | { kind: "file", change: ChangedFile, viewGroupId: string | undefined };

/**
 * Arranges the changed files, the unchanged files that have threads, and the threads into a
 * ReviewOutline.
 */
export function buildReviewOutline(input: OutlineInput): ReviewOutline {
  let threadsByFile = Map.groupBy(input.review?.threads ?? [], t => t.file);
  let createFile = (path: string, isPartial: boolean): OutlineFile => ({ path, isPartial,
    change: input.changedFiles.find(f => f.path === path),
    threads: (threadsByFile.get(path) ?? []).map(thread => {
      let location = input.threadLocations.get(thread.id);
      let line = location?.startLine ?? thread.anchor.startLine;
      let hunks = thread.side === "base" ? input.baseThreadHunks.get(path) : undefined;
      return { thread, location, line, position: hunks ? mapBaseLineToWorkingTree(hunks, line) : line };
    }).sort((a, b) => a.position - b.position || a.line - b.line) });
  let layout = input.groupLayout;
  if (layout) {
    let sections = layout.groups.map((group, i) => ({ group, files: group.files.map(f => createFile(f.path,
      f.isPartial)), title: group.id === undefined ? group.name : `${i + 1}. ${group.name}` }));
    return { sections, isStale: layout.isStale };
  }
  let paths = new Set([...input.changedFiles.map(f => f.path), ...threadsByFile.keys()]);
  let files = [...paths].map(path => createFile(path, false)).sort(comparePaths);
  return { sections: [{ group: undefined, title: "", files }], isStale: false };
}

/**
 * Describes a section's group, e.g. "12 lines, 3 files · regroup: merge-base changed"; "" in a
 * review without groups.
 */
export function describeSection(outline: ReviewOutline, section: OutlineSection): string {
  return section.group ? describeGroupSize(section.group)
    + (isSectionStale(outline, section) ? " · regroup: merge-base changed" : "") : "";
}

/**
 * Checks whether a section is a group (other than Ungrouped) whose hunks no longer apply because
 * the merge-base changed (see ReviewOutline.isStale).
 */
export function isSectionStale(outline: ReviewOutline, section: OutlineSection): boolean {
  return outline.isStale && section.group?.id !== undefined;
}

/**
 * Gets the group whose view of a file a section shows (see buildGroupViewText): the section's group
 * if the file is partial in it, else undefined, meaning the whole-file diff.
 */
export function getViewGroupId(section: OutlineSection, file: OutlineFile): string | undefined {
  return file.isPartial ? section.group?.id : undefined;
}

/**
 * Gets the line of the working-tree file at which a thread starts, or, for a thread on the base
 * side, the line above which its base lines were (e.g. 12 for position 12.5; at least 1).
 * revealThread puts the cursor of a diff's modified side there.
 */
export function getWorkingTreeLine(thread: OutlineThread): number {
  return Math.max(Math.floor(thread.position), 1);
}

/**
 * Lists the outline's threads in order, each once: a file that is in several groups lists its
 * threads under each of them, but they are visited under the first.
 */
export function listThreadVisits(outline: ReviewOutline): ThreadVisit[] {
  let visits = outline.sections.flatMap(section => section.files.flatMap(file => file.threads.map(thread =>
    ({ section, file, thread }))));
  return visits.filter((v, i) => visits.findIndex(w => w.thread.thread.id === v.thread.thread.id) === i);
}

/**
 * Finds the thread after (`direction` 1) or before (-1) a position, in the order of
 * listThreadVisits, optionally skipping resolved threads. Wraps around at the end, and starts at
 * the first (or last) thread if `from` is undefined or not in the outline. Returns undefined if
 * there is no such thread.
 */
export function findAdjacentThread(outline: ReviewOutline, from: ThreadPosition | undefined, direction: 1 | -1,
  isUnresolvedOnly: boolean): { visit: ThreadVisit, isWrapped: boolean } | undefined {
  let visits = listThreadVisits(outline);
  let filePaths = [...new Set(outline.sections.flatMap(s => s.files.map(f => f.path)))];
  // Compares a visit with `from`: negative if the visit comes first
  let compare: ((visit: ThreadVisit, index: number) => number) | undefined;
  if (from && "threadId" in from) {
    let fromIndex = visits.findIndex(v => v.thread.thread.id === from.threadId);
    if (fromIndex >= 0)
      compare = (_, index) => index - fromIndex;
  } else if (from && filePaths.includes(from.file)) {
    let fileIndex = filePaths.indexOf(from.file);
    compare = visit => (filePaths.indexOf(visit.file.path) - fileIndex) || (visit.thread.position - from.line);
  }
  let candidates = visits.map((visit, index) => ({ visit, index }))
    .filter(c => !isUnresolvedOnly || c.visit.thread.thread.status === "open");
  if (direction === -1)
    candidates.reverse();
  let next = compare && candidates.find(c => compare(c.visit, c.index) * direction > 0);
  let target = next ?? candidates[0];
  return target && { visit: target.visit, isWrapped: next === undefined && compare !== undefined };
}

/**
 * Lists the entries of a multi-diff editor that shows the given sections (by default, all of them).
 * If the review has groups that aren't stale, each group starts with a heading document, then its
 * changed files, each showing the group's view of the file if it is partial. A file in several
 * groups appears under each; since VS Code's multi-diff editor fails (shows nothing) if two
 * entries have the same original and modified documents, a file's later appearances use the
 * group's view even if it isn't partial. Otherwise, the entries are the changed files by path.
 */
export function listChangesEntries(outline: ReviewOutline, sections = outline.sections): ChangesEntry[] {
  if (outline.isStale || sections.some(s => s.group === undefined)) {
    let changes = new Map(sections.flatMap(s => s.files.flatMap(f => f.change ? [[f.path, f.change]] : [])));
    return [...changes.values()].sort(comparePaths).map(change => ({ kind: "file", change, viewGroupId: undefined }));
  }
  let shownPaths = new Set<string>();
  return sections.flatMap(section => {
    let heading = { kind: "heading" as const, section, fileName: getGroupHeading(outline, section).fileName };
    let files = section.files.flatMap(file => {
      let isShown = shownPaths.has(file.path);
      shownPaths.add(file.path);
      return file.change ? [{ kind: "file" as const, change: file.change,
        viewGroupId: isShown ? section.group?.id : getViewGroupId(section, file) }] : [];
    });
    return [heading, ...files];
  });
}

/**
 * Gets the document that introduces a group in Open All Changes: its file name, e.g. "1. Name —
 * 12 lines, 3 files.md" (the multi-diff editor labels each entry with its document's file name),
 * and its markdown text: heading, size and summary.
 */
export function getGroupHeading(outline: ReviewOutline, section: OutlineSection): { fileName: string, text: string } {
  let size = describeSection(outline, section);
  return { fileName: `${section.title} — ${size}.md`.replace(/[/\\]/g, "-"),
    text: `# ${section.title}\n\n${size}\n\n${section.group?.summary ?? ""}\n` };
}
