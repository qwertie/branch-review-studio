// Bundles the VS Code extension and the stdio MCP server into dist/.
import * as esbuild from "esbuild";

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
