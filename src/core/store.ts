import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Review, reviewSchemaVersion } from "./review";

/** Explains, inside every file that ReviewStore writes, where the file came from. */
export const provenanceNote = "Created by the Branch Review Studio VS Code extension / MCP server "
  + "(repo D:\\branch-review-studio). Safe to delete. Git ignores it because it is inside the .git folder.";

/** If a lock file is older than this, its owner presumably crashed, so the lock is broken. */
const staleLockMs = 10_000;
/** updateReview gives up if it cannot acquire the lock for this long. */
const lockTimeoutMs = 30_000;

/**
 * Reads and writes the reviews of one repo. Reviews live in
 * `<git-common-dir>/branch-review-studio/`, which all worktrees of the repo share, one JSON file
 * per branch. Both the VS Code extension and
 * the MCP server process modify these files, so every modification goes through `updateReview`,
 * which holds an exclusive lock file while it reads, mutates and atomically replaces the file.
 */
export class ReviewStore {
  /** Folder containing README.txt and reviews/ */
  readonly dir: string;
  readonly reviewsDir: string;

  constructor(gitCommonDir: string) {
    this.dir = path.join(gitCommonDir, "branch-review-studio");
    this.reviewsDir = path.join(this.dir, "reviews");
  }

  getReviewPath(branch: string): string {
    return path.join(this.reviewsDir, encodeBranchForFileName(branch) + ".json");
  }

  /** Creates the store folders and README.txt if they don't exist yet. */
  async ensureExists(): Promise<void> {
    await fs.mkdir(this.reviewsDir, { recursive: true });
    let readmePath = path.join(this.dir, "README.txt");
    try {
      await fs.writeFile(readmePath, provenanceNote + "\n\nreviews/ contains one JSON file per branch.\n",
        { flag: "wx" });
    } catch (e) {
      if (getErrorCode(e) !== "EEXIST")
        throw e;
    }
  }

  /** Reads the review of `branch`, or returns undefined if there is none. */
  async readReview(branch: string): Promise<Review | undefined> {
    let text = await retryIfBusy(() => readFileIfExists(this.getReviewPath(branch)));
    return text === undefined ? undefined : parseReview(text);
  }

  /**
   * Reads the review of `branch` (undefined if none), calls `mutate`, and saves the review that
   * `mutate` returns; `mutate` may modify its argument in place and return it. If `mutate` returns
   * undefined, nothing is written. Returns the saved review (or undefined).
   */
  async updateReview(branch: string, mutate: (review: Review | undefined) => Review | undefined)
    : Promise<Review | undefined> {
    await this.ensureExists();
    let filePath = this.getReviewPath(branch);
    return await withLockFile(filePath + ".lock", async () => {
      let text = await retryIfBusy(() => readFileIfExists(filePath));
      let review = mutate(text === undefined ? undefined : parseReview(text));
      if (review !== undefined) {
        review.updatedAt = new Date().toISOString();
        await writeFileAtomically(filePath, serializeReview(review));
      }
      return review;
    });
  }
}

/**
 * Converts a branch name into a file name (without extension) by percent-encoding the UTF-8 bytes
 * of every character other than ASCII letters, digits, '.', '_' and '-'.
 */
export function encodeBranchForFileName(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]/gu,
    ch => [...Buffer.from(ch, "utf8")].map(b => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join(""));
}

function serializeReview(review: Review): string {
  return JSON.stringify({ $comment: provenanceNote, ...review, schemaVersion: reviewSchemaVersion }, undefined, 2);
}

function parseReview(text: string): Review {
  let { $comment: _, ...review } = JSON.parse(text) as Review & { $comment?: string };
  if (review.schemaVersion > reviewSchemaVersion)
    throw new Error(`This review was written by a newer version of Branch Review Studio `
      + `(schemaVersion ${review.schemaVersion}). Please update the extension.`);
  return review;
}

/** Runs `action` while holding an exclusive lock file, breaking the lock if it is stale. */
async function withLockFile<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  let startTime = Date.now();
  let delayMs = 5;
  let handle: fs.FileHandle | undefined;
  while (handle === undefined) {
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (e) {
      if (getErrorCode(e) !== "EEXIST" && getErrorCode(e) !== "EPERM")
        throw e;
      if (Date.now() - startTime > lockTimeoutMs)
        throw new Error(`Timed out waiting for lock file ${lockPath}`);
      await deleteLockFileIfStale(lockPath);
      await delay(delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
  try {
    await handle.writeFile(`pid ${process.pid} at ${new Date().toISOString()}\n`);
    await handle.close();
    return await action();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

async function deleteLockFileIfStale(lockPath: string): Promise<void> {
  try {
    let stats = await fs.stat(lockPath);
    if (Date.now() - stats.mtimeMs > staleLockMs)
      await fs.rm(lockPath, { force: true });
  } catch (e) {
    if (getErrorCode(e) !== "ENOENT" && getErrorCode(e) !== "EPERM")
      throw e;
  }
}

/** Writes a temp file and renames it over `filePath`, so readers never see a partial file. */
async function writeFileAtomically(filePath: string, text: string): Promise<void> {
  let tempPath = `${filePath}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await fs.writeFile(tempPath, text);
  try {
    await retryIfBusy(() => fs.rename(tempPath, filePath));
  } catch (e) {
    await fs.rm(tempPath, { force: true });
    throw e;
  }
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (e) {
    if (getErrorCode(e) === "ENOENT")
      return undefined;
    throw e;
  }
}

/**
 * Runs `action`, retrying for up to ~2 seconds if it fails with EPERM/EBUSY/EACCES. On Windows,
 * renaming over a file (or reading it) can fail briefly while another process has it open.
 */
async function retryIfBusy<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await action();
    } catch (e) {
      let isBusy = ["EPERM", "EBUSY", "EACCES"].includes(getErrorCode(e) ?? "");
      if (!isBusy || attempt >= 20)
        throw e;
      await delay(100);
    }
  }
}

function getErrorCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
