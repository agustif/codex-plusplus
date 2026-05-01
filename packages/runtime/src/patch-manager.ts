import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir as osHomedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

export type PatchChannel = "stable" | "beta";

export interface PatchManagerStatus {
  checkedAt: string;
  currentChannel: PatchChannel | "unknown";
  currentUserRoot: string;
  channels: PatchChannelStatus[];
}

export interface PatchChannelStatus {
  channel: PatchChannel;
  label: string;
  current: boolean;
  userRoot: string;
  statePath: string;
  configPath: string;
  appRoot: string;
  appExists: boolean;
  stateExists: boolean;
  codexVersion: string | null;
  codexPlusPlusVersion: string | null;
  bundleId: string | null;
  watcher: string | null;
  watcherLabel: string;
  watcherLoaded: boolean | null;
  runtimePreloadPath: string;
  runtimePreloadExists: boolean;
  runtimePreloadBytes: number | null;
  runtimeUpdatedAt: string | null;
  autoUpdate: boolean;
  cdp: PatchCdpStatus;
  commands: PatchChannelCommands;
}

export interface PatchCdpStatus {
  enabled: boolean;
  configuredPort: number;
  expectedPort: number;
  activePort: number | null;
  active: boolean;
  drift: boolean;
  jsonListUrl: string | null;
  jsonVersionUrl: string | null;
}

export interface PatchChannelCommands {
  repair: string;
  reopenWithCdp: string;
  status: string;
  updateCodex: string;
}

interface InstallerState {
  version?: string;
  appRoot?: string;
  codexVersion?: string | null;
  codexChannel?: PatchChannel | "unknown";
  codexBundleId?: string | null;
  watcher?: string;
  runtimeUpdatedAt?: string;
}

interface RuntimeConfig {
  codexPlusPlus?: {
    autoUpdate?: boolean;
    cdp?: {
      enabled?: boolean;
      port?: number;
    };
  };
}

interface PatchManagerOptions {
  userRoot: string;
  runtimeDir: string;
  activeCdpPort: number | null;
  appName?: string;
  now?: () => Date;
  homeDir?: string;
  platform?: NodeJS.Platform;
  probeCdp?: (port: number) => Promise<boolean>;
  commandSucceeds?: (command: string, args: string[]) => boolean;
}

const STABLE_PORT = 9222;
const BETA_PORT = 9223;

export async function getPatchManagerStatus(options: PatchManagerOptions): Promise<PatchManagerStatus> {
  const platform = options.platform ?? osPlatform();
  const homeDir = options.homeDir ?? osHomedir();
  const currentState = readJson<InstallerState>(join(options.userRoot, "state.json"));
  const currentChannel = inferCurrentChannel(options.userRoot, currentState, options.appName);
  const probeCdp = options.probeCdp ?? defaultProbeCdp;
  const commandSucceeds = options.commandSucceeds ?? defaultCommandSucceeds;

  const channels = await Promise.all(
    (["stable", "beta"] as PatchChannel[]).map((channel) =>
      readPatchChannelStatus({
        channel,
        currentChannel,
        currentUserRoot: options.userRoot,
        runtimeDir: options.runtimeDir,
        activeCdpPort: options.activeCdpPort,
        homeDir,
        platform,
        probeCdp,
        commandSucceeds,
      }),
    ),
  );

  return {
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    currentChannel,
    currentUserRoot: options.userRoot,
    channels,
  };
}

function inferCurrentChannel(
  userRoot: string,
  state: InstallerState | null,
  appName?: string,
): PatchChannel | "unknown" {
  if (state?.codexChannel === "stable" || state?.codexChannel === "beta") return state.codexChannel;
  const text = `${userRoot} ${state?.appRoot ?? ""} ${state?.codexBundleId ?? ""} ${appName ?? ""}`;
  if (/codex-plusplus-beta|Codex \(Beta\)|com\.openai\.codex\.beta|\bbeta\b/i.test(text)) return "beta";
  if (/codex-plusplus|Codex\.app|com\.openai\.codex|\bcodex\b/i.test(text)) return "stable";
  return "unknown";
}

async function readPatchChannelStatus(options: {
  channel: PatchChannel;
  currentChannel: PatchChannel | "unknown";
  currentUserRoot: string;
  runtimeDir: string;
  activeCdpPort: number | null;
  homeDir: string;
  platform: NodeJS.Platform;
  probeCdp: (port: number) => Promise<boolean>;
  commandSucceeds: (command: string, args: string[]) => boolean;
}): Promise<PatchChannelStatus> {
  const userRoot = channelUserRoot(options.channel, options.homeDir, options.platform);
  const statePath = join(userRoot, "state.json");
  const configPath = join(userRoot, "config.json");
  const state = readJson<InstallerState>(statePath);
  const config = readJson<RuntimeConfig>(configPath);
  const expectedPort = options.channel === "beta" ? BETA_PORT : STABLE_PORT;
  const configuredPort = normalizePort(config?.codexPlusPlus?.cdp?.port, expectedPort);
  const otherDefaultPort = options.channel === "beta" ? STABLE_PORT : BETA_PORT;
  const reopenPort = configuredPort === otherDefaultPort ? expectedPort : configuredPort;
  const enabled = config?.codexPlusPlus?.cdp?.enabled === true;
  const current = options.currentChannel === options.channel || samePath(userRoot, options.currentUserRoot);
  const activePort = await resolveActivePort({
    current,
    activeCdpPort: options.activeCdpPort,
    expectedPort,
    configuredPort,
    otherDefaultPort,
    probeCdp: options.probeCdp,
  });
  const appRoot = state?.appRoot ?? defaultAppRoot(options.channel, options.homeDir, options.platform);
  const runtimePreloadPath = join(userRoot, "runtime", "preload.js");
  const runtimePreloadBytes = fileSize(runtimePreloadPath);
  const watcherLabel = watcherLabelForChannel(options.channel);

  return {
    channel: options.channel,
    label: options.channel === "beta" ? "Beta" : "Stable",
    current,
    userRoot,
    statePath,
    configPath,
    appRoot,
    appExists: existsSync(appRoot),
    stateExists: state !== null,
    codexVersion: state?.codexVersion ?? null,
    codexPlusPlusVersion: state?.version ?? null,
    bundleId: state?.codexBundleId ?? null,
    watcher: state?.watcher ?? null,
    watcherLabel,
    watcherLoaded: watcherLoaded(watcherLabel, options.platform, options.commandSucceeds),
    runtimePreloadPath,
    runtimePreloadExists: runtimePreloadBytes !== null,
    runtimePreloadBytes,
    runtimeUpdatedAt: state?.runtimeUpdatedAt ?? null,
    autoUpdate: config?.codexPlusPlus?.autoUpdate !== false,
    cdp: {
      enabled,
      configuredPort,
      expectedPort,
      activePort,
      active: activePort !== null,
      drift:
        Boolean(activePort && activePort !== configuredPort) ||
        configuredPort !== expectedPort ||
        (activePort !== null && !enabled),
      jsonListUrl: activePort ? cdpUrl(activePort, "json/list") : null,
      jsonVersionUrl: activePort ? cdpUrl(activePort, "json/version") : null,
    },
    commands: buildCommands(options.channel, userRoot, appRoot, reopenPort),
  };
}

function channelUserRoot(channel: PatchChannel, homeDir: string, platform: NodeJS.Platform): string {
  const dir = channel === "beta" ? "codex-plusplus-beta" : "codex-plusplus";
  if (platform === "darwin") return join(homeDir, "Library", "Application Support", dir);
  if (platform === "win32") return join(process.env.APPDATA ?? homeDir, dir);
  return join(homeDir, `.${dir}`);
}

function defaultAppRoot(channel: PatchChannel, homeDir: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return channel === "beta" ? "/Applications/Codex (Beta).app" : "/Applications/Codex.app";
  }
  if (platform === "win32") return join(process.env.LOCALAPPDATA ?? homeDir, "Programs", "Codex");
  return join(homeDir, "Applications", channel === "beta" ? "Codex Beta.AppImage" : "Codex.AppImage");
}

function watcherLabelForChannel(channel: PatchChannel): string {
  return channel === "beta" ? "com.codexplusplus.watcher.beta" : "com.codexplusplus.watcher";
}

function watcherLoaded(
  label: string,
  platform: NodeJS.Platform,
  commandSucceeds: (command: string, args: string[]) => boolean,
): boolean | null {
  if (platform === "darwin") return commandSucceeds("launchctl", ["list", label]);
  if (platform === "linux") return commandSucceeds("systemctl", ["--user", "is-active", "--quiet", `${label}.path`]);
  if (platform === "win32") return commandSucceeds("schtasks.exe", ["/Query", "/TN", label]);
  return null;
}

async function resolveActivePort(options: {
  current: boolean;
  activeCdpPort: number | null;
  expectedPort: number;
  configuredPort: number;
  otherDefaultPort: number;
  probeCdp: (port: number) => Promise<boolean>;
}): Promise<number | null> {
  if (options.current && options.activeCdpPort !== null) return options.activeCdpPort;
  if (await options.probeCdp(options.expectedPort)) return options.expectedPort;
  if (
    options.configuredPort !== options.expectedPort &&
    options.configuredPort !== options.otherDefaultPort &&
    await options.probeCdp(options.configuredPort)
  ) {
    return options.configuredPort;
  }
  return null;
}

function buildCommands(
  channel: PatchChannel,
  userRoot: string,
  appRoot: string,
  cdpPort: number,
): PatchChannelCommands {
  const env = `CODEX_PLUSPLUS_HOME=${shellQuote(userRoot)}`;
  const appArg = `--app ${shellQuote(appRoot)}`;
  return {
    repair: `${env} codex-plusplus repair ${appArg} --force`,
    reopenWithCdp: `open -na ${shellQuote(appRoot)} --args --remote-debugging-port=${cdpPort}`,
    status: `${env} codex-plusplus status`,
    updateCodex: `${env} codex-plusplus update-codex ${appArg}`,
  };
}

function normalizePort(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

function cdpUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}/${path}`;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

async function defaultProbeCdp(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(cdpUrl(port, "json/version"), { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function defaultCommandSucceeds(command: string, args: string[]): boolean {
  try {
    return spawnSync(command, args, { stdio: "ignore", timeout: 2_000 }).status === 0;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
