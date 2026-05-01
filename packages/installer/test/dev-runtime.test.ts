import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRuntimeRestartPlan,
  normalizeRuntimeChannel,
  resolveRuntimeHomes,
  stageRuntimeToHomes,
} from "../src/commands/dev-runtime";

test("runtime channel parser accepts known channels only", () => {
  assert.equal(normalizeRuntimeChannel(undefined), "auto");
  assert.equal(normalizeRuntimeChannel("stable"), "stable");
  assert.equal(normalizeRuntimeChannel("Beta"), "beta");
  assert.equal(normalizeRuntimeChannel("both"), "both");
  assert.throws(() => normalizeRuntimeChannel("prod"), /--channel/);
});

test("runtime home resolver prefers explicit CODEX_PLUSPLUS_HOME", () => {
  const homes = resolveRuntimeHomes(
    {},
    { CODEX_PLUSPLUS_HOME: "~/custom-codexpp" },
    "/Users/example",
    "darwin",
  );

  assert.deepEqual(homes, [
    {
      channel: "current",
      root: "/Users/example/custom-codexpp",
      runtimeDir: "/Users/example/custom-codexpp/runtime",
    },
  ]);
});

test("runtime home resolver can target stable and beta together", () => {
  const homes = resolveRuntimeHomes({ channel: "both" }, {}, "/Users/example", "darwin");

  assert.equal(homes.length, 2);
  assert.equal(homes[0].channel, "stable");
  assert.equal(homes[0].root, "/Users/example/Library/Application Support/codex-plusplus");
  assert.equal(homes[1].channel, "beta");
  assert.equal(homes[1].root, "/Users/example/Library/Application Support/codex-plusplus-beta");
});

test("runtime staging copies dist and touches the reload marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-dev-runtime-"));
  try {
    const dist = join(root, "dist");
    const home = join(root, "home");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "main.js"), "main", "utf8");
    writeFileSync(join(dist, "preload.js"), "preload", "utf8");
    writeFileSync(join(dist, "self-mcp-server.js"), "self", "utf8");
    writeFileSync(join(dist, "self-mcp-launcher.js"), "launcher", "utf8");

    const [result] = stageRuntimeToHomes(
      dist,
      [{ channel: "custom", root: home, runtimeDir: join(home, "runtime") }],
      123,
    );

    assert.equal(readFileSync(join(home, "runtime", "main.js"), "utf8"), "main");
    assert.equal(readFileSync(join(home, "runtime", "preload.js"), "utf8"), "preload");
    assert.equal(readFileSync(join(home, "runtime", "self-mcp-server.js"), "utf8"), "self");
    assert.equal(readFileSync(join(home, "runtime", "self-mcp-launcher.js"), "utf8"), "launcher");
    assert.equal(readFileSync(result.markerPath, "utf8"), "123\n");
    assert.match(readFileSync(result.manifestPath, "utf8"), /"self-mcp-server\.js"/);
    assert.match(readFileSync(result.manifestPath, "utf8"), /"self-mcp-launcher\.js"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime staging can keep a rollback backup before overwriting", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-dev-runtime-backup-"));
  try {
    const dist = join(root, "dist");
    const home = join(root, "home");
    const runtime = join(home, "runtime");
    mkdirSync(dist, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "preload.js"), "old preload", "utf8");
    writeFileSync(join(runtime, "stale.js"), "stale", "utf8");
    writeFileSync(join(dist, "main.js"), "new main", "utf8");
    writeFileSync(join(dist, "preload.js"), "new preload", "utf8");
    writeFileSync(join(dist, "self-mcp-server.js"), "new self", "utf8");
    writeFileSync(join(dist, "self-mcp-launcher.js"), "new launcher", "utf8");

    const [result] = stageRuntimeToHomes(
      dist,
      [{ channel: "custom", root: home, runtimeDir: runtime }],
      123,
      { backup: true },
    );

    assert.ok(result.backupDir);
    assert.equal(readFileSync(join(result.backupDir, "preload.js"), "utf8"), "old preload");
    assert.equal(readFileSync(join(result.backupDir, "stale.js"), "utf8"), "stale");
    assert.equal(readFileSync(join(runtime, "preload.js"), "utf8"), "new preload");
    assert.equal(existsSync(join(runtime, "stale.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime staging requires bundled main, preload, self MCP, and launcher assets", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-dev-runtime-missing-"));
  try {
    mkdirSync(root, { recursive: true });
    assert.throws(
      () =>
        stageRuntimeToHomes(root, [
          { channel: "custom", root: join(root, "home"), runtimeDir: join(root, "home", "runtime") },
        ]),
      /Built runtime not found/,
    );
    assert.equal(existsSync(join(root, "home", "runtime")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime restart plan uses recorded app root and configured CDP port", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-dev-runtime-restart-"));
  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({
        appRoot: "/Applications/Codex (Beta).app",
        codexBundleId: "com.openai.codex.beta",
      }),
      "utf8",
    );
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ codexPlusPlus: { cdp: { enabled: true, port: 9223 } } }),
      "utf8",
    );

    const plan = buildRuntimeRestartPlan(
      { channel: "custom", root: home, runtimeDir: join(home, "runtime") },
      "darwin",
    );

    assert.equal(plan.appRoot, "/Applications/Codex (Beta).app");
    assert.equal(plan.bundleId, "com.openai.codex.beta");
    assert.equal(plan.cdpPort, 9223);
    assert.equal(plan.cdpVersionUrl, "http://127.0.0.1:9223/json/version");
    assert.equal(
      plan.launchCommand,
      "open -na '/Applications/Codex (Beta).app' --args --remote-debugging-port=9223",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime restart plan does not let beta reuse the stable default CDP port", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-dev-runtime-restart-beta-"));
  try {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "state.json"),
      JSON.stringify({ appRoot: "/Applications/Codex (Beta).app" }),
      "utf8",
    );
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ codexPlusPlus: { cdp: { enabled: true, port: 9222 } } }),
      "utf8",
    );

    const plan = buildRuntimeRestartPlan(
      { channel: "beta", root: home, runtimeDir: join(home, "runtime") },
      "darwin",
    );

    assert.equal(plan.cdpPort, 9223);
    assert.match(plan.launchCommand, /remote-debugging-port=9223/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
