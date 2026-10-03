import * as path from "node:path";
import { getRepoRelativePath } from "./files";
import { ChangedFile, comparePaths } from "./git";
import { applyHunks, DiffHunk, readDiffHunks } from "./hunks";
import { ChangeGroup, ChangeGroups, formatCount, GroupedFile, GroupedHunk } from "./review";

/** Lines 1-based and inclusive, in the working-tree file. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

/** A file's groups as review_set_groups gets them. */
export interface FileGroupsInput {
  /** Repo-relative or absolute path */
  file: string;
  groups: { groupId: string, ranges?: LineRange[] }[];
}

/** Arguments of review_set_groups. */
export interface ChangeGroupsInput {
  groups: ChangeGroup[];
  files: FileGroupsInput[];
}

/** A group, or the Ungrouped group, as the tree shows it (see arrangeGroups). */
export interface ArrangedGroup {
  /** Undefined for the Ungrouped group */
  id: string | undefined;
  name: string;
  /** Markdown */
  summary: string;
  /**
   * Number of changed lines in the group's hunks: the sum of max(oldCount, newCount) over its
   * hunks, so that a changed line counts once; undefined for the Ungrouped group
   */
  changedLines: number | undefined;
  /** Sorted by path */
  files: ArrangedFile[];
}

/** A file under an ArrangedGroup. */
export interface ArrangedFile {
  path: string;
  /** Whether the group's view of the file hides hunks of other groups (see buildGroupViewText) */
  isPartial: boolean;
}

/** The groups that the tree shows, smallest first, then Ungrouped. */
export interface GroupLayout {
  groups: ArrangedGroup[];
  /**
   * Whether the merge-base changed since the groups were posted; then the hunks are unusable, so
   * no view is partial
   */
  isStale: boolean;
}

/** Name of the group of changed files that no group includes */
const ungroupedName = "Ungrouped";

/**
 * Validates review_set_groups' arguments and freezes the groups: reads each listed file's hunks and
 * assigns them to groups (see assignHunksToGroups). Throws an error listing every problem. Returns
 * the groups plus notes for the agent about hunks and ranges that matched nothing.
 */
export async function createChangeGroups(repoRoot: string, mergeBaseSha: string, changedFiles: ChangedFile[],
  input: ChangeGroupsInput): Promise<{ changeGroups: ChangeGroups, notes: string[] }> {
  let problems: string[] = [];
  let groupIds = input.groups.map(g => g.id);
  for (let [i, group] of input.groups.entries()) {
    if (group.id.trim() === "" || group.name.trim() === "")
      problems.push(`Group ids and names must not be empty (id '${group.id}', name '${group.name}').`);
    else if (groupIds.indexOf(group.id) === i && groupIds.lastIndexOf(group.id) !== i)
      problems.push(`Group id '${group.id}' is used more than once.`);
  }
  let filesToRead: { input: FileGroupsInput, changedFile: ChangedFile }[] = [];
  for (let fileInput of input.files) {
    let file = getRepoRelativePath(repoRoot, path.resolve(repoRoot, fileInput.file));
    let changedFile = changedFiles.find(f => f.path === file);
    let fileGroupIds = fileInput.groups.map(g => g.groupId);
    if (changedFile === undefined)
      problems.push(`'${fileInput.file}' is not a changed file (see \`git diff --name-status ${mergeBaseSha}\`).`);
    else if (filesToRead.some(f => f.changedFile === changedFile))
      problems.push(`'${file}' is listed more than once.`);
    else
      filesToRead.push({ input: fileInput, changedFile });
    for (let groupId of fileGroupIds.filter(id => !groupIds.includes(id)))
      problems.push(`'${fileInput.file}' refers to group '${groupId}', which is not in \`groups\`.`);
    if (fileGroupIds.length === 0 || new Set(fileGroupIds).size < fileGroupIds.length)
      problems.push(`'${fileInput.file}' must list one or more groups, each once.`);
    if (fileGroupIds.length > 1 && fileInput.groups.some(g => !g.ranges?.length))
      problems.push(`'${fileInput.file}' is in several groups, so each of its groups needs \`ranges\`.`);
    for (let range of fileInput.groups.flatMap(g => g.ranges ?? [])) {
      if (range.startLine < 1 || range.endLine < range.startLine)
        problems.push(`'${fileInput.file}' has an invalid range ${range.startLine}-${range.endLine}.`);
    }
  }
  if (problems.length > 0)
    throw new Error("review_set_groups found problems; nothing was saved:\n- " + problems.join("\n- "));

  let notes: string[] = [];
  let files: GroupedFile[] = [];
  for (let { input: fileInput, changedFile } of filesToRead) {
    let { hunks, unmatchedRanges, unassignedLines } = assignHunksToGroups(
      await readDiffHunks(repoRoot, mergeBaseSha, changedFile), fileInput.groups);
    files.push({ file: changedFile.path, groupIds: fileInput.groups.map(g => g.groupId), hunks });
    notes.push(...unmatchedRanges.map(({ groupId, range }) => `${changedFile.path}: the range `
      + `${range.startLine}-${range.endLine} of group '${groupId}' overlaps no change.`));
    if (unassignedLines.length > 0)
      notes.push(`${changedFile.path}: no range covers ${unassignedLines.join(", ")}, so these changes appear in `
        + "every group that lists the file.");
  }
  for (let group of input.groups.filter(g => !files.some(f => getFileGroupIds(f).includes(g.id))))
    notes.push(`Group '${group.id}' includes no changes, so Branch Review Studio doesn't show it.`);
  let changeGroups = { mergeBaseSha, createdAt: new Date().toISOString(), groups: input.groups, files };
  return { changeGroups, notes };
}

/**
 * Assigns each hunk to the groups whose ranges overlap it. For a removal (no new lines), a range
 * overlaps if it includes the working-tree line just above or just below the removed lines. A group
 * without ranges (allowed only if it is the file's only group) gets every hunk. An insertion (no
 * removed lines) is split where the set of groups whose ranges include its lines changes, so that,
 * e.g., a new file can be divided among groups. Other hunks are kept whole, so they may belong to
 * several groups. Also returns the ranges that overlap no hunk, and describes the working-tree
 * lines of the hunks that belong to no group (e.g. "lines 3-5").
 */
export function assignHunksToGroups(hunks: DiffHunk[], groups: FileGroupsInput["groups"])
  : { hunks: GroupedHunk[], unmatchedRanges: { groupId: string, range: LineRange }[], unassignedLines: string[] } {
  let matchedRanges = new Set<LineRange>();
  let grouped: GroupedHunk[] = [];
  let unassignedLines: string[] = [];
  for (let hunk of hunks) {
    let newCount = hunk.newLines.length;
    if (newCount === 0) {
      addHunk(hunk.oldStart, hunk.oldCount, [], findGroupIds(hunk.newStart, hunk.newStart + 1), hunk.newStart);
    } else if (hunk.oldCount > 0) {
      addHunk(hunk.oldStart, hunk.oldCount, hunk.newLines, findGroupIds(hunk.newStart, hunk.newStart + newCount - 1),
        hunk.newStart);
    } else {
      let lineGroupIds = hunk.newLines.map((_, i) => findGroupIds(hunk.newStart + i, hunk.newStart + i));
      let runStart = 0;
      for (let i = 1; i <= newCount; i++) {
        if (i === newCount || lineGroupIds[i].join("\n") !== lineGroupIds[runStart].join("\n")) {
          addHunk(hunk.oldStart, 0, hunk.newLines.slice(runStart, i), lineGroupIds[runStart],
            hunk.newStart + runStart);
          runStart = i;
        }
      }
    }
  }
  // newLines are needed only to hide a hunk in the view of another of the file's groups
  for (let hunk of grouped) {
    if (hunk.groupIds.length === 0 || hunk.groupIds.length === groups.length)
      delete hunk.newLines;
  }
  let unmatchedRanges = groups.flatMap(g => (g.ranges ?? []).filter(r => !matchedRanges.has(r))
    .map(range => ({ groupId: g.groupId, range })));
  return { hunks: grouped, unmatchedRanges, unassignedLines };

  function findGroupIds(firstLine: number, lastLine: number): string[] {
    let groupIds: string[] = [];
    for (let group of groups) {
      let overlappingRanges = group.ranges?.filter(r => r.startLine <= lastLine && firstLine <= r.endLine) ?? [];
      for (let range of overlappingRanges)
        matchedRanges.add(range);
      if (!group.ranges?.length || overlappingRanges.length > 0)
        groupIds.push(group.groupId);
    }
    return groupIds;
  }

  function addHunk(oldStart: number, oldCount: number, newLines: string[], groupIds: string[], newStart: number) {
    grouped.push({ oldStart, oldCount, newCount: newLines.length, newLines, groupIds });
    if (groupIds.length === 0) {
      unassignedLines.push(newLines.length === 0
        ? (newStart === 0 ? "the removal at the top of the file" : `the removal after line ${newStart}`)
        : newLines.length === 1 ? `line ${newStart}` : `lines ${newStart}-${newStart + newLines.length - 1}`);
    }
  }
}

/**
 * Gets the text of the left side of `groupId`'s view of a file: the merge-base text with the hunks
 * of the file's other groups applied, so that the diff with the working file shows only this group's
 * hunks, the unassigned hunks, and changes made after the groups were posted.
 */
export function buildGroupViewText(baseText: string, groupedFile: GroupedFile, groupId: string): string {
  return applyHunks(baseText, groupedFile.hunks.filter(h => isHiddenInView(h, groupId))
    .map(h => ({ oldStart: h.oldStart, oldCount: h.oldCount, newLines: h.newLines ?? [] })));
}

/**
 * Arranges the changed files into groups for the tree: each grouped file appears under every group
 * whose view of it shows a hunk (see getFileGroupIds). Groups are sorted by size, smallest first
 * (ties keep the agent's order); groups without changed files are omitted. Changed files that are in
 * no group, e.g. files changed after the groups were posted, go into a final Ungrouped group, with
 * `unchangedFiles` (files that the tree lists although they have no changes, e.g. because they have
 * threads).
 */
export function arrangeGroups(changeGroups: ChangeGroups, changedFiles: string[], mergeBaseSha: string | undefined,
  unchangedFiles: string[] = []): GroupLayout {
  let isStale = mergeBaseSha !== changeGroups.mergeBaseSha;
  let groupedFiles = changeGroups.files.filter(f => changedFiles.includes(f.file));
  let groups: ArrangedGroup[] = changeGroups.groups.map(group => {
    let files = groupedFiles.filter(f => getFileGroupIds(f).includes(group.id));
    let changedLines = files.flatMap(f => f.hunks.filter(h => h.groupIds.includes(group.id)))
      .reduce((sum, h) => sum + Math.max(h.oldCount, h.newCount), 0);
    let arrangedFiles = files.map(f => ({ path: f.file, isPartial: !isStale && f.hunks.some(h => isHiddenInView(h,
      group.id)) }));
    return { ...group, changedLines, files: arrangedFiles.sort(comparePaths) };
  }).filter(g => g.files.length > 0).sort((a, b) => a.changedLines - b.changedLines);
  let ungroupedFiles = [...changedFiles.filter(file => !groups.some(g => g.files.some(f => f.path === file))),
    ...unchangedFiles];
  if (ungroupedFiles.length > 0) {
    groups.push({ id: undefined, name: ungroupedName, changedLines: undefined,
      summary: "Files that no group includes, e.g. files changed after the groups were posted.",
      files: ungroupedFiles.map(path => ({ path, isPartial: false })).sort(comparePaths) });
  }
  return { groups, isStale };
}

/** Describes a group's size, e.g. "12 lines, 3 files" (the Ungrouped group: "3 files"). */
export function describeGroupSize(group: ArrangedGroup): string {
  return (group.changedLines === undefined ? "" : formatCount(group.changedLines, "line") + ", ")
    + formatCount(group.files.length, "file");
}

/**
 * Gets the groups under which the tree lists a file: the groups listed for it whose views show one
 * or more of its hunks (their own hunks or unassigned ones), or all of them if the file has no hunks
 * (e.g. a binary file).
 */
function getFileGroupIds(groupedFile: GroupedFile): string[] {
  return groupedFile.groupIds.filter(id => groupedFile.hunks.length === 0
    || groupedFile.hunks.some(h => !isHiddenInView(h, id)));
}

/** Whether the view of `groupId` hides a hunk, i.e. the hunk belongs only to other groups. */
function isHiddenInView(hunk: GroupedHunk, groupId: string): boolean {
  return hunk.groupIds.length > 0 && !hunk.groupIds.includes(groupId);
}
