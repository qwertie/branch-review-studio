import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onTestFinished } from "vitest";

/** A throwaway git repository in the OS temp folder, used by tests that need real git. */
export class TempRepo {
  private constructor(readonly root: string) {}

  /** Creates a repo whose first commit (on `main`) contains `files`. */
  static create(files: Record<string, string> = { "README.md": "hello\n" }): TempRepo {
    let repo = new TempRepo(createTempDir());
    repo.git("init", "-q", "-b", "main");
    repo.git("config", "user.name", "Test User");
    repo.git("config", "user.email", "test@example.com");
    repo.git("config", "core.autocrlf", "false");
    repo.git("config", "commit.gpgsign", "false");
    repo.writeFiles(files);
    repo.commitAll("initial");
    return repo;
  }

  /** Runs git synchronously in the repo root and returns trimmed stdout. */
  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8" }).trim();
  }

  /** Writes files given by repo-relative path, creating folders as needed. */
  writeFiles(files: Record<string, string>): void {
    for (let [relativePath, text] of Object.entries(files)) {
      let fullPath = path.join(this.root, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, text);
    }
  }

  /** Stages and commits all changes; returns the new commit's SHA. */
  commitAll(message: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  /** Deletes the repo folder (and any worktrees created inside `extraPaths`). */
  dispose(...extraPaths: string[]): void {
    for (let p of [this.root, ...extraPaths])
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Creates files with the given content (paths relative to a new temp folder, which is deleted when
 * the current test finishes) and returns the folder.
 */
export function createFiles(...files: (string | [relativePath: string, text: string])[]): string {
  let dir = createTempDir();
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let file of files) {
    let [relativePath, text] = typeof file === "string" ? [file, ""] : file;
    fs.mkdirSync(path.dirname(path.join(dir, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(dir, relativePath), text);
  }
  return dir;
}

/** Creates an empty folder in the OS temp folder. */
export function createTempDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "brs-test-")));
}

/**
 * Waits for processes that an AbortSignal killed to exit: execFile reports the abort before the
 * process exits, and Windows can't delete a folder that a running process uses (see
 * TempRepo.dispose).
 */
export function waitForKilledProcesses(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 1000));
}
