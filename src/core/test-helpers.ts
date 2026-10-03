import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A throwaway git repository in the OS temp folder, used by tests that need real git. */
export class TempRepo {
  private constructor(readonly root: string) {}

  /** Creates a repo whose first commit (on `main`) contains `files`. */
  static create(files: Record<string, string> = { "README.md": "hello\n" }): TempRepo {
    let root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "brs-test-")));
    let repo = new TempRepo(root);
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

/** Creates an empty folder in the OS temp folder. */
export function createTempDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "brs-test-")));
}
