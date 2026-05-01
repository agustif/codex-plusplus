"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPatchManagerStatus = getPatchManagerStatus;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const STABLE_PORT = 9222;
const BETA_PORT = 9223;
async function getPatchManagerStatus(options) {
    const platform = options.platform ?? (0, node_os_1.platform)();
    const homeDir = options.homeDir ?? (0, node_os_1.homedir)();
    const currentState = readJson((0, node_path_1.join)(options.userRoot, "state.json"));
    const currentChannel = inferCurrentChannel(options.userRoot, currentState, options.appName);
    const probeCdp = options.probeCdp ?? defaultProbeCdp;
    const commandSucceeds = options.commandSucceeds ?? defaultCommandSucceeds;
    const channels = await Promise.all(["stable", "beta"].map((channel) => readPatchChannelStatus({
        channel,
        currentChannel,
        currentUserRoot: options.userRoot,
        runtimeDir: options.runtimeDir,
        activeCdpPort: options.activeCdpPort,
        homeDir,
        platform,
        probeCdp,
        commandSucceeds,
    })));
    return {
        checkedAt: (options.now ?? (() => new Date()))().toISOString(),
        currentChannel,
        currentUserRoot: options.userRoot,
        channels,
    };
}
function inferCurrentChannel(userRoot, state, appName) {
    if (state?.codexChannel === "stable" || state?.codexChannel === "beta")
        return state.codexChannel;
    const text = `${userRoot} ${state?.appRoot ?? ""} ${state?.codexBundleId ?? ""} ${appName ?? ""}`;
    if (/codex-plusplus-beta|Codex \(Beta\)|com\.openai\.codex\.beta|\bbeta\b/i.test(text))
        return "beta";
    if (/codex-plusplus|Codex\.app|com\.openai\.codex|\bcodex\b/i.test(text))
        return "stable";
    return "unknown";
}
async function readPatchChannelStatus(options) {
    const userRoot = channelUserRoot(options.channel, options.homeDir, options.platform);
    const statePath = (0, node_path_1.join)(userRoot, "state.json");
    const configPath = (0, node_path_1.join)(userRoot, "config.json");
    const state = readJson(statePath);
    const config = readJson(configPath);
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
    const runtimePreloadPath = (0, node_path_1.join)(userRoot, "runtime", "preload.js");
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
        appExists: (0, node_fs_1.existsSync)(appRoot),
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
            drift: Boolean(activePort && activePort !== configuredPort) ||
                configuredPort !== expectedPort ||
                (activePort !== null && !enabled),
            jsonListUrl: activePort ? cdpUrl(activePort, "json/list") : null,
            jsonVersionUrl: activePort ? cdpUrl(activePort, "json/version") : null,
        },
        commands: buildCommands(options.channel, userRoot, appRoot, reopenPort),
    };
}
function channelUserRoot(channel, homeDir, platform) {
    const dir = channel === "beta" ? "codex-plusplus-beta" : "codex-plusplus";
    if (platform === "darwin")
        return (0, node_path_1.join)(homeDir, "Library", "Application Support", dir);
    if (platform === "win32")
        return (0, node_path_1.join)(process.env.APPDATA ?? homeDir, dir);
    return (0, node_path_1.join)(homeDir, `.${dir}`);
}
function defaultAppRoot(channel, homeDir, platform) {
    if (platform === "darwin") {
        return channel === "beta" ? "/Applications/Codex (Beta).app" : "/Applications/Codex.app";
    }
    if (platform === "win32")
        return (0, node_path_1.join)(process.env.LOCALAPPDATA ?? homeDir, "Programs", "Codex");
    return (0, node_path_1.join)(homeDir, "Applications", channel === "beta" ? "Codex Beta.AppImage" : "Codex.AppImage");
}
function watcherLabelForChannel(channel) {
    return channel === "beta" ? "com.codexplusplus.watcher.beta" : "com.codexplusplus.watcher";
}
function watcherLoaded(label, platform, commandSucceeds) {
    if (platform === "darwin")
        return commandSucceeds("launchctl", ["list", label]);
    if (platform === "linux")
        return commandSucceeds("systemctl", ["--user", "is-active", "--quiet", `${label}.path`]);
    if (platform === "win32")
        return commandSucceeds("schtasks.exe", ["/Query", "/TN", label]);
    return null;
}
async function resolveActivePort(options) {
    if (options.current && options.activeCdpPort !== null)
        return options.activeCdpPort;
    if (await options.probeCdp(options.expectedPort))
        return options.expectedPort;
    if (options.configuredPort !== options.expectedPort &&
        options.configuredPort !== options.otherDefaultPort &&
        await options.probeCdp(options.configuredPort)) {
        return options.configuredPort;
    }
    return null;
}
function buildCommands(channel, userRoot, appRoot, cdpPort) {
    const env = `CODEX_PLUSPLUS_HOME=${shellQuote(userRoot)}`;
    const appArg = `--app ${shellQuote(appRoot)}`;
    return {
        repair: `${env} codex-plusplus repair ${appArg} --force`,
        reopenWithCdp: `open -na ${shellQuote(appRoot)} --args --remote-debugging-port=${cdpPort}`,
        status: `${env} codex-plusplus status`,
        updateCodex: `${env} codex-plusplus update-codex ${appArg}`,
    };
}
function normalizePort(value, fallback) {
    const parsed = typeof value === "number" ? value : Number(String(value ?? ""));
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}
function cdpUrl(port, path) {
    return `http://127.0.0.1:${port}/${path}`;
}
function readJson(path) {
    try {
        return JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
    }
    catch {
        return null;
    }
}
function fileSize(path) {
    try {
        return (0, node_fs_1.statSync)(path).size;
    }
    catch {
        return null;
    }
}
async function defaultProbeCdp(port) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
        const response = await fetch(cdpUrl(port, "json/version"), { signal: controller.signal });
        return response.ok;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
function defaultCommandSucceeds(command, args) {
    try {
        return (0, node_child_process_1.spawnSync)(command, args, { stdio: "ignore", timeout: 2_000 }).status === 0;
    }
    catch {
        return false;
    }
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function samePath(a, b) {
    return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}
//# sourceMappingURL=patch-manager.js.map