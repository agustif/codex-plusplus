/**
 * Bundles both the renderer-side preload AND the main-process entry into
 * single files. Both run inside Codex.app's runtime — we don't want to ship
 * a node_modules tree, so we bundle deps in. `electron` and Node built-ins
 * stay external because they're provided by the host.
 */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outputs = {
  preload: resolve(root, "dist/preload.js"),
  main: resolve(root, "dist/main.js"),
  selfMcpServer: resolve(root, "dist/self-mcp-server.js"),
  selfMcpLauncher: resolve(root, "dist/self-mcp-launcher.js"),
};

await build({
  entryPoints: [resolve(root, "src/preload/index.ts")],
  bundle: true,
  outfile: outputs.preload,
  platform: "browser",
  target: "es2022",
  format: "cjs",
  external: ["electron"],
  sourcemap: "inline",
  minify: false,
  logLevel: "info",
});

await build({
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  outfile: outputs.main,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron"],
  sourcemap: "inline",
  minify: false,
  logLevel: "info",
  // chokidar uses dynamic native fsevents on macOS via optional dep; let
  // esbuild treat any failure to resolve as an empty module so we degrade
  // gracefully to polling on platforms without it. (chokidar v4 already
  // handles missing fsevents internally — this is just future-proofing.)
});

await build({
  entryPoints: [resolve(root, "src/self-mcp-server.ts")],
  bundle: true,
  outfile: outputs.selfMcpServer,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: "inline",
  minify: false,
  logLevel: "info",
});

await build({
  entryPoints: [resolve(root, "src/self-mcp-launcher.ts")],
  bundle: true,
  outfile: outputs.selfMcpLauncher,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: "inline",
  minify: false,
  logLevel: "info",
});

await Promise.all(Object.values(outputs).map(stripTrailingWhitespace));

console.log("[bundle] preload + main + self MCP + launcher bundled");

async function stripTrailingWhitespace(file) {
  const original = await readFile(file, "utf8");
  const stripped = original.replace(/[ \t]+$/gm, "");
  if (stripped !== original) await writeFile(file, stripped, "utf8");
}
