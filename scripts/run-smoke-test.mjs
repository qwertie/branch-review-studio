// Runs scripts/smoke-test.ts in the installed VS Code with a throwaway profile, against the repo
// given as the first argument or in BRS_SMOKE_REPO. Usage: npm run smoke-test -- <repo>
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";

let repo = process.argv[2] ?? process.env.BRS_SMOKE_REPO;
if (!repo) {
  console.error("Usage: npm run smoke-test -- <repo> (or set BRS_SMOKE_REPO)");
  process.exit(2);
}
let root = path.resolve(import.meta.dirname, "..");
spawnSync(process.execPath, [path.join(root, "esbuild.mjs")], { cwd: root, stdio: "inherit" });
await esbuild.build({ entryPoints: [path.join(root, "scripts/smoke-test.ts")], bundle: true, platform: "node",
  format: "cjs", outfile: path.join(root, "out/smoke-test.js"), external: ["vscode"], logLevel: "warning" });

let codeExe = process.env.VSCODE_EXE
  ?? path.join(os.homedir(), "AppData/Local/Programs/Microsoft VS Code/Code.exe");
let profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "brs-smoke-"));
let result = spawnSync(codeExe, [
  "--extensionDevelopmentPath=" + root,
  "--extensionTestsPath=" + path.join(root, "out/smoke-test.js"),
  "--user-data-dir=" + path.join(profileDir, "user"),
  "--extensions-dir=" + path.join(profileDir, "extensions"),
  "--disable-workspace-trust",
  "--skip-welcome", "--skip-release-notes",
  repo,
], { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
try {
  fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 });
} catch (e) {
  console.log(`Could not delete ${profileDir}: ${e.message}`);
}
process.exit(result.status ?? 1);
