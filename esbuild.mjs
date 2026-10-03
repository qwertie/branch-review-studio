// Bundles the VS Code extension and the stdio MCP server into dist/.
import * as fs from "node:fs";
import * as esbuild from "esbuild";

const { version } = JSON.parse(fs.readFileSync(new URL("package.json", import.meta.url), "utf8"));

// The Branch Review view (a webview) shows codicons, VS Code's icon font, which webviews can't
// load from VS Code itself; the font's license (CC BY 4.0) requires its license to accompany it
fs.mkdirSync("media/codicons", { recursive: true });
for (let [from, to] of [["dist/codicon.css", "codicon.css"], ["dist/codicon.ttf", "codicon.ttf"],
  ["LICENSE", "LICENSE"]])
  fs.copyFileSync(`node_modules/@vscode/codicons/${from}`, `media/codicons/${to}`);

const isProduction = process.argv.includes("--production");
const isWatch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: { extension: "src/extension/extension.ts", "mcp-server": "src/mcp/server.ts" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outdir: "dist",
  external: ["vscode"],
  define: { EXTENSION_VERSION: JSON.stringify(version) },
  sourcemap: !isProduction,
  minify: isProduction,
  logLevel: "info",
});
if (isWatch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
