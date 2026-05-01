import kleur from "kleur";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type RuntimeChannel = "stable" | "beta" | "auto" | "both";
type RuntimeHomeChannel = "stable" | "beta" | "current" | "custom";

export interface DevRuntimeOpts {
  channel?: string;
  home?: string;
  watch?: boolean;
  build?: boolean;
  restart?: boolean;
  quiet?: boolean;
}

export interface RuntimeHome {
  channel: RuntimeHomeChannel;
  root: string;
  runtimeDir: string;
}

export interface RuntimeStageResult {
  home: RuntimeHome;
  markerPath: string;
  manifestPath: string;
  backupDir: string | null;
}

export interface RuntimeRestartPlan {
  home: RuntimeHome;
  appRoot: string;
  bundleId: string | null;
  cdpPort: number;
  cdpVersionUrl: string;
  launchCommand: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const runtimeSourceDir = join(repoRoot, "packages", "runtime", "src");
const runtimeDistDir = join(repoRoot, "packages", "runtime", "dist");
const reloadMarkerName = ".codexpp-runtime-reload";
const runtimeBackupDirName = ".codexpp-runtime-backup";
const runtimeManifestName = "codexpp-runtime-manifest.json";
const requiredRuntimeFiles = ["main.js", "preload.js", "self-mcp-server.js", "self-mcp-launcher.js"] as const;
const DEFAULT_CDP_STABLE_PORT = 9222;
const DEFAULT_CDP_BETA_PORT = 9223;
const RUNTIME_HEALTH_TIMEOUT_MS = 15_000;

export async function devRuntime(opts: DevRuntimeOpts = {}): Promise<void> {
  const homes = resolveRuntimeHomes(opts);
  if (homes.length === 0) {
    throw new Error("No Codex++ runtime homes selected.");
  }

  const run = () => {
    if (opts.build !== false) buildRuntime(repoRoot, opts.quiet === true);
    const results = stageRuntimeToHomes(runtimeDistDir, homes, Date.now(), {
      backup: opts.restart === true,
    });
    if (opts.quiet !== true) {
      for (const result of results) {
        console.log(
          `${kleur.green("staged")} ${kleur.cyan(result.home.channel)} ${kleur.dim(result.home.runtimeDir)}`,
        );
      }
      if (opts.restart === true) {
        console.log(kleur.dim("Renderer windows reload automatically; main-process changes apply through a supervised app restart."));
      } else {
        console.log(kleur.dim("Renderer windows reload automatically after the runtime watcher sees the marker."));
        console.log(kleur.dim("Main-process runtime changes still need one app restart. Pass --restart to apply them."));
      }
    }
    return results;
  };

  const runAndMaybeRestart = async () => {
    const results = run();
    if (opts.restart === true) {
      await restartAndVerifyRuntimeHomes(results, opts.quiet === true);
    }
  };

  await runAndMaybeRestart();

  if (opts.watch === false) return;

  console.log();
  console.log(kleur.dim(`Watching ${runtimeSourceDir}. Press Ctrl+C to stop.`));
  await watchRuntimeSources(runtimeSourceDir, runAndMaybeRestart);
}

export function resolveRuntimeHomes(
  opts: Pick<DevRuntimeOpts, "channel" | "home"> = {},
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
  os = platform(),
): RuntimeHome[] {
  if (opts.home) {
    const root = expandHome(opts.home, homeDir);
    return [{ channel: "custom", root, runtimeDir: join(root, "runtime") }];
  }

  if (env.CODEX_PLUSPLUS_HOME) {
    const root = expandHome(env.CODEX_PLUSPLUS_HOME, homeDir);
    return [{ channel: "current", root, runtimeDir: join(root, "runtime") }];
  }

  const channel = normalizeRuntimeChannel(opts.channel);
  const stable = defaultRuntimeHome("stable", homeDir, os);
  const beta = defaultRuntimeHome("beta", homeDir, os);

  if (channel === "stable") return [stable];
  if (channel === "beta") return [beta];
  if (channel === "both") return [stable, beta];

  const installed = [stable, beta].filter((home) => homeLooksInstalled(home.root));
  return installed.length > 0 ? installed : [stable];
}

export function normalizeRuntimeChannel(value: unknown): RuntimeChannel {
  const normalized = String(value ?? "auto").trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "stable" ||
    normalized === "beta" ||
    normalized === "both"
  ) {
    return normalized;
  }
  throw new Error("--channel must be one of: auto, stable, beta, both");
}

export function stageRuntimeToHomes(
  distDir: string,
  homes: RuntimeHome[],
  now = Date.now(),
  opts: { backup?: boolean } = {},
): RuntimeStageResult[] {
  assertRuntimeBundle(distDir);

  return homes.map((home, index) => {
    mkdirSync(home.root, { recursive: true });
    const backupDir = opts.backup === true ? backupRuntime(home) : null;
    const nextRuntimeDir = join(home.root, `.codexpp-runtime-next-${now}-${process.pid}-${index}`);
    rmDir(nextRuntimeDir);
    try {
      cpSync(distDir, nextRuntimeDir, { recursive: true });
      writeFileSync(
        join(nextRuntimeDir, runtimeManifestName),
        buildRuntimeManifest(distDir, now),
        "utf8",
      );
      rmDir(home.runtimeDir);
      renameSync(nextRuntimeDir, home.runtimeDir);
    } catch (e) {
      rmDir(nextRuntimeDir);
      throw e;
    }
    const markerPath = join(home.runtimeDir, reloadMarkerName);
    writeFileSync(markerPath, `${now}\n`, "utf8");
    return { home, markerPath, manifestPath: join(home.runtimeDir, runtimeManifestName), backupDir };
  });
}

export function buildRuntimeRestartPlan(
  home: RuntimeHome,
  os: NodeJS.Platform = process.platform,
): RuntimeRestartPlan {
  const state = readJson<Record<string, unknown>>(join(home.root, "state.json"));
  const config = readJson<{
    codexPlusPlus?: { cdp?: { port?: number; enabled?: boolean } };
  }>(join(home.root, "config.json"));
  const appRoot = readString(state?.appRoot) ?? defaultAppRoot(home.channel, os);
  if (!appRoot) {
    throw new Error(`No appRoot is recorded for ${home.root}; pass --home only after install/repair has written state.json.`);
  }

  const expectedPort = defaultCdpPort(home.channel, appRoot);
  const configuredPort = normalizePort(
    config?.codexPlusPlus?.cdp?.port,
    expectedPort,
  );
  const cdpPort = avoidSiblingDefaultPort(home.channel, appRoot, configuredPort, expectedPort);
  const bundleId = readString(state?.codexBundleId) ?? defaultBundleId(home.channel, appRoot);

  return {
    home,
    appRoot,
    bundleId,
    cdpPort,
    cdpVersionUrl: `http://127.0.0.1:${cdpPort}/json/version`,
    launchCommand:
      os === "darwin"
        ? `open -na ${shellQuote(appRoot)} --args --remote-debugging-port=${cdpPort}`
        : `${shellQuote(appRoot)} --remote-debugging-port=${cdpPort}`,
  };
}

async function restartAndVerifyRuntimeHomes(
  results: RuntimeStageResult[],
  quiet: boolean,
): Promise<void> {
  for (const result of results) {
    const plan = buildRuntimeRestartPlan(result.home);
    try {
      restartRuntime(plan, quiet);
      await waitForRuntimeHealth(plan);
      if (!quiet) {
        console.log(`${kleur.green("healthy")} ${kleur.cyan(result.home.channel)} ${kleur.dim(plan.cdpVersionUrl)}`);
      }
    } catch (e) {
      if (!quiet) {
        console.error(`${kleur.red("restart failed")} ${result.home.channel}: ${e instanceof Error ? e.message : String(e)}`);
        console.error(kleur.yellow("Restoring the previous runtime bundle and reopening Codex."));
      }
      restoreRuntimeBackup(result);
      restartRuntime(plan, quiet);
      throw e;
    }
  }
}

function restartRuntime(plan: RuntimeRestartPlan, quiet: boolean): void {
  if (process.platform === "darwin") {
    if (plan.bundleId) {
      spawnSync("osascript", ["-e", `quit app id "${escapeAppleScriptString(plan.bundleId)}"`], {
        stdio: "ignore",
      });
    }
    const result = spawnSync("open", ["-na", plan.appRoot, "--args", `--remote-debugging-port=${plan.cdpPort}`], {
      stdio: quiet ? "ignore" : "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`open failed for ${plan.appRoot} with exit ${result.status}`);
    }
    return;
  }

  const result = spawnSync(plan.appRoot, [`--remote-debugging-port=${plan.cdpPort}`], {
    stdio: "ignore",
  });
  if (result.error) throw result.error;
  if (result.status !== null && result.status !== 0) {
    throw new Error(`launch failed for ${plan.appRoot} with exit ${result.status}`);
  }
}

async function waitForRuntimeHealth(plan: RuntimeRestartPlan): Promise<void> {
  const deadline = Date.now() + RUNTIME_HEALTH_TIMEOUT_MS;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), 1_000);
      try {
        const response = await fetch(plan.cdpVersionUrl, { signal: controller.signal });
        if (response.ok) return;
        lastError = `HTTP ${response.status}`;
      } finally {
        globalThis.clearTimeout(timeout);
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await delay(500);
  }

  throw new Error(`runtime health check timed out at ${plan.cdpVersionUrl}${lastError ? ` (${lastError})` : ""}`);
}

function backupRuntime(home: RuntimeHome): string | null {
  if (!existsSync(home.runtimeDir)) return null;
  const backupDir = join(home.root, runtimeBackupDirName);
  rmDir(backupDir);
  cpSync(home.runtimeDir, backupDir, { recursive: true });
  return backupDir;
}

function restoreRuntimeBackup(result: RuntimeStageResult): void {
  if (!result.backupDir || !existsSync(result.backupDir)) return;
  rmDir(result.home.runtimeDir);
  cpSync(result.backupDir, result.home.runtimeDir, { recursive: true });
  writeFileSync(result.markerPath, `${Date.now()}\n`, "utf8");
}

function assertRuntimeBundle(distDir: string): void {
  const missing = requiredRuntimeFiles.filter((file) => !existsSync(join(distDir, file)));
  if (missing.length > 0) {
    throw new Error(
      `Built runtime not found at ${distDir}; missing ${missing.join(", ")}. Run \`npm run build --workspace @codex-plusplus/runtime\`.`,
    );
  }
}

function buildRuntimeManifest(distDir: string, stagedAt: number): string {
  return `${JSON.stringify(
    {
      version: 1,
      stagedAt,
      files: requiredRuntimeFiles.map((file) => {
        const path = join(distDir, file);
        return {
          path: file,
          bytes: statSync(path).size,
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        };
      }),
    },
    null,
    2,
  )}\n`;
}

function buildRuntime(root: string, quiet: boolean): void {
  const result = spawnSync("npm", ["run", "build", "--workspace", "@codex-plusplus/runtime"], {
    cwd: root,
    stdio: quiet ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = quiet
      ? `\n${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`
      : "";
    throw new Error(`runtime build failed with exit ${result.status}${detail}`);
  }
}

function watchRuntimeSources(sourceDir: string, run: () => void | Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  let rerunRequested = false;

  const schedule = (changedPath: string | null) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      if (busy) {
        rerunRequested = true;
        return;
      }
      busy = true;
      const label = changedPath ? relative(sourceDir, changedPath) : "source change";
      try {
        console.log(`${kleur.cyan("change")} ${label}`);
        await run();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`${kleur.red("hmr failed")} ${message}`);
      } finally {
        busy = false;
        if (rerunRequested) {
          rerunRequested = false;
          schedule(null);
        }
      }
    }, 150);
  };

  const watcher = watch(sourceDir, { recursive: true }, (_event, filename) => {
    if (filename && String(filename).includes("node_modules")) return;
    schedule(filename ? join(sourceDir, String(filename)) : null);
  });

  return new Promise((resolvePromise) => {
    const stop = () => {
      if (timer) clearTimeout(timer);
      watcher.close();
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function defaultRuntimeHome(channel: "stable" | "beta", homeDir: string, os: string): RuntimeHome {
  const suffix = channel === "beta" ? "codex-plusplus-beta" : "codex-plusplus";
  let root: string;
  switch (os) {
    case "darwin":
      root = join(homeDir, "Library", "Application Support", suffix);
      break;
    case "win32":
      root = join(process.env.APPDATA ?? join(homeDir, "AppData", "Roaming"), suffix);
      break;
    default:
      root = join(process.env.XDG_DATA_HOME ?? join(homeDir, ".local", "share"), suffix);
      break;
  }
  return { channel, root, runtimeDir: join(root, "runtime") };
}

function defaultAppRoot(channel: RuntimeHomeChannel, os: NodeJS.Platform): string | null {
  if (os !== "darwin") return null;
  if (channel === "beta") return "/Applications/Codex (Beta).app";
  return "/Applications/Codex.app";
}

function defaultBundleId(channel: RuntimeHomeChannel, appRoot: string): string | null {
  if (channel === "beta" || /\bbeta\b/i.test(appRoot)) return "com.openai.codex.beta";
  if (channel === "stable" || /Codex\.app$/i.test(appRoot)) return "com.openai.codex";
  return null;
}

function defaultCdpPort(channel: RuntimeHomeChannel, appRoot: string): number {
  return channel === "beta" || /\bbeta\b/i.test(appRoot)
    ? DEFAULT_CDP_BETA_PORT
    : DEFAULT_CDP_STABLE_PORT;
}

function normalizePort(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : fallback;
}

function avoidSiblingDefaultPort(
  channel: RuntimeHomeChannel,
  appRoot: string,
  configuredPort: number,
  expectedPort: number,
): number {
  const isBeta = channel === "beta" || /\bbeta\b/i.test(appRoot);
  if (isBeta && configuredPort === DEFAULT_CDP_STABLE_PORT) return DEFAULT_CDP_BETA_PORT;
  if (!isBeta && configuredPort === DEFAULT_CDP_BETA_PORT) return DEFAULT_CDP_STABLE_PORT;
  return configuredPort || expectedPort;
}

function homeLooksInstalled(root: string): boolean {
  return existsSync(join(root, "state.json")) || existsSync(join(root, "runtime"));
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return resolve(value);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function rmDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
