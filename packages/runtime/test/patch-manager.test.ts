import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPatchManagerStatus } from "../src/patch-manager";

test("patch manager reports stable and beta homes with CDP drift", async () => {
  await withTempHome(async (home) => {
    const stableHome = join(home, "Library", "Application Support", "codex-plusplus");
    const betaHome = join(home, "Library", "Application Support", "codex-plusplus-beta");
    mkdirSync(join(stableHome, "runtime"), { recursive: true });
    mkdirSync(join(betaHome, "runtime"), { recursive: true });
    writeFileSync(join(stableHome, "runtime", "preload.js"), "stable runtime");
    writeFileSync(join(betaHome, "runtime", "preload.js"), "beta runtime");
    writeFileSync(
      join(stableHome, "state.json"),
      JSON.stringify({
        version: "0.1.4",
        appRoot: "/Applications/Codex.app",
        codexVersion: "26.1.0",
        codexChannel: "stable",
        watcher: "launchd",
      }),
    );
    writeFileSync(
      join(betaHome, "state.json"),
      JSON.stringify({
        version: "0.1.4",
        appRoot: "/Applications/Codex (Beta).app",
        codexVersion: "26.2.0",
        codexChannel: "beta",
        watcher: "launchd",
      }),
    );
    writeFileSync(
      join(betaHome, "config.json"),
      JSON.stringify({ codexPlusPlus: { cdp: { enabled: true, port: 9222 } } }),
    );

    const status = await getPatchManagerStatus({
      userRoot: stableHome,
      runtimeDir: join(stableHome, "runtime"),
      activeCdpPort: 9222,
      appName: "Codex",
      homeDir: home,
      platform: "darwin",
      probeCdp: async (port) => port === 9223,
      commandSucceeds: (_command, args) => args.includes("com.codexplusplus.watcher.beta"),
    });

    const stable = status.channels.find((channel) => channel.channel === "stable");
    const beta = status.channels.find((channel) => channel.channel === "beta");

    assert.equal(status.currentChannel, "stable");
    assert.equal(stable?.current, true);
    assert.equal(stable?.cdp.activePort, 9222);
    assert.equal(stable?.cdp.drift, true);
    assert.equal(stable?.watcherLoaded, false);
    assert.equal(beta?.current, false);
    assert.equal(beta?.cdp.configuredPort, 9222);
    assert.equal(beta?.cdp.activePort, 9223);
    assert.equal(beta?.cdp.drift, true);
    assert.equal(beta?.watcherLoaded, true);
    assert.match(beta?.commands.repair ?? "", /CODEX_PLUSPLUS_HOME='.*codex-plusplus-beta'/);
    assert.match(beta?.commands.reopenWithCdp ?? "", /--remote-debugging-port=9223/);
  });
});

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "codexpp-patch-manager-"));
  try {
    await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
