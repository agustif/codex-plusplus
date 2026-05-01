/**
 * Watcher: a small process scheduled to run at user login that compares the
 * current Codex.app's asar hash against the patched hash we recorded at
 * install. If they don't match, Sparkle has updated Codex over our patch —
 * we either auto-`repair` or surface a notification, depending on user prefs.
 *
 * Implementation per OS:
 *   macOS:   ~/Library/LaunchAgents/com.codexplusplus.watcher.plist (launchd)
 *   Linux:   ~/.config/systemd/user/codex-plusplus-watcher.service (systemd --user)
 *   Windows: Task Scheduler entry via schtasks.exe
 *
 * The watcher itself is just `codex-plusplus repair --quiet` triggered on the
 * relevant event (app launch / login). The simplest cross-platform approach
 * is "run at login" + "run when Codex.app is modified" (FSEvents/inotify on
 * unix, but launchd's WatchPaths handles it on mac).
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type WatcherKind = "launchd" | "login-item" | "scheduled-task" | "systemd" | "none";

export function installWatcher(appRoot: string): WatcherKind {
  switch (platform()) {
    case "darwin":
      return installLaunchd(appRoot);
    case "linux":
      return installSystemd(appRoot);
    case "win32":
      return installScheduledTask(appRoot);
    default:
      return "none";
  }
}

export function uninstallWatcher(): void {
  switch (platform()) {
    case "darwin":
      return uninstallLaunchd();
    case "linux":
      return uninstallSystemd();
    case "win32":
      return uninstallScheduledTask();
  }
}

const LABEL = "com.codexplusplus.watcher";
const BETA_LABEL = "com.codexplusplus.watcher.beta";

function launchdPath(label: string): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function installLaunchd(appRoot: string): WatcherKind {
  if (isRunningFromWatcher()) return "launchd";

  const label = launchdLabelForApp(appRoot);
  const plPath = launchdPath(label);
  mkdirSync(dirname(plPath), { recursive: true });
  // Trigger on login + when the app bundle changes. Watching the bundle and
  // Resources directory catches Sparkle-style atomic replacement in addition
  // to direct app.asar writes.
  const repair = xmlEscape(watcherShellCommand(appRoot));
  const watchPaths = launchdWatchPaths(appRoot)
    .map((path) => `    <string>${xmlEscape(path)}</string>`)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${repair}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>WatchPaths</key>
  <array>
${watchPaths}
  </array>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${join(homedir(), "Library", "Logs", "codex-plusplus-watcher.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), "Library", "Logs", "codex-plusplus-watcher.log")}</string>
  </dict>
</plist>`;
  writeFileSync(plPath, xml);
  if (!bootstrapLaunchd(label, plPath)) {
    try {
      execFileSync("launchctl", ["unload", plPath], { stdio: "ignore" });
    } catch {}
    execFileSync("launchctl", ["load", plPath], { stdio: "ignore" });
  }
  return "launchd";
}

function isRunningFromWatcher(): boolean {
  return process.env.CODEX_PLUSPLUS_WATCHER === "1" || (process.env.XPC_SERVICE_NAME ?? "").startsWith(LABEL);
}

function uninstallLaunchd(): void {
  for (const label of [LABEL, BETA_LABEL]) {
    const plPath = launchdPath(label);
    if (!existsSync(plPath)) continue;
    bootoutLaunchd(plPath);
    try {
      execFileSync("launchctl", ["unload", plPath], { stdio: "ignore" });
    } catch {}
    rmSync(plPath, { force: true });
  }
}

function bootstrapLaunchd(label: string, plPath: string): boolean {
  const domain = launchdGuiDomain();
  if (!domain) return false;
  bootoutLaunchd(plPath);
  try {
    execFileSync("launchctl", ["bootstrap", domain, plPath], { stdio: "ignore" });
    execFileSync("launchctl", ["enable", `${domain}/${label}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function bootoutLaunchd(plPath: string): void {
  const domain = launchdGuiDomain();
  if (!domain) return;
  try {
    execFileSync("launchctl", ["bootout", domain, plPath], { stdio: "ignore" });
  } catch {}
}

function launchdGuiDomain(): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  return typeof uid === "number" ? `gui/${uid}` : null;
}

function launchdWatchPaths(appRoot: string): string[] {
  return [
    appRoot,
    join(appRoot, "Contents", "Resources"),
    join(appRoot, "Contents", "Resources", "app.asar"),
  ];
}

function installSystemd(appRoot: string): WatcherKind {
  const dir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const repair = shellSingleQuote(watcherShellCommand(appRoot));
  const unit = `[Unit]
Description=codex-plusplus repair watcher

[Service]
Type=oneshot
ExecStart=/bin/sh -c ${repair}

[Install]
WantedBy=default.target
`;
  writeFileSync(join(dir, "codex-plusplus-watcher.service"), unit);
  writeFileSync(join(dir, "codex-plusplus-watcher.timer"), `[Unit]
Description=codex-plusplus hourly self-update check

[Timer]
OnBootSec=5m
OnUnitActiveSec=1h
Persistent=true

[Install]
WantedBy=timers.target
`);
  writeFileSync(join(dir, "codex-plusplus-watcher.path"), `[Unit]
Description=codex-plusplus app.asar watcher

[Path]
PathChanged=${appRoot}/resources/app.asar

[Install]
WantedBy=default.target
`);
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    execFileSync("systemctl", ["--user", "enable", "codex-plusplus-watcher.service"], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "enable", "--now", "codex-plusplus-watcher.timer"], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "enable", "--now", "codex-plusplus-watcher.path"], {
      stdio: "ignore",
    });
  } catch {
    /* systemd may not be available */
  }
  return "systemd";
}

function uninstallSystemd(): void {
  const path = join(homedir(), ".config", "systemd", "user", "codex-plusplus-watcher.service");
  if (!existsSync(path)) return;
  try {
    execFileSync("systemctl", ["--user", "disable", "codex-plusplus-watcher.service"], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "disable", "--now", "codex-plusplus-watcher.path"], {
      stdio: "ignore",
    });
    execFileSync("systemctl", ["--user", "disable", "--now", "codex-plusplus-watcher.timer"], {
      stdio: "ignore",
    });
  } catch {}
  rmSync(path, { force: true });
  rmSync(join(homedir(), ".config", "systemd", "user", "codex-plusplus-watcher.path"), {
    force: true,
  });
  rmSync(join(homedir(), ".config", "systemd", "user", "codex-plusplus-watcher.timer"), {
    force: true,
  });
}

function installScheduledTask(_appRoot: string): WatcherKind {
  // schtasks.exe creates a logon-trigger task. We pass the watcher command via /TR.
  const repair = windowsWatcherTaskCommand();
  try {
    deleteScheduledTask("codex-plusplus-watcher-daily");
    execFileSync("schtasks.exe", [
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      "codex-plusplus-watcher",
      "/TR",
      repair,
    ]);
    execFileSync("schtasks.exe", [
      "/Create",
      "/F",
      "/SC",
      "HOURLY",
      "/MO",
      "1",
      "/TN",
      "codex-plusplus-watcher-hourly",
      "/TR",
      repair,
    ]);
    return "scheduled-task";
  } catch {
    return "none";
  }
}

function cliShellCommand(command: string, args: string[] = []): string {
  const env = [
    "CODEX_PLUSPLUS_WATCHER=1",
    process.env.CODEX_PLUSPLUS_HOME
      ? `CODEX_PLUSPLUS_HOME=${shellQuote(process.env.CODEX_PLUSPLUS_HOME)}`
      : null,
  ].filter((item): item is string => item !== null);

  return [
    ...env,
    shellQuote(process.execPath),
    ...process.execArgv.map(shellQuote),
    shellQuote(currentCliPath()),
    command,
    ...args.map(shellQuote),
  ].join(" ");
}

function watcherShellCommand(appRoot: string): string {
  const update = cliShellCommand("update", ["--watcher", "--quiet"]);
  const repair = cliShellCommand("repair", ["--quiet", "--app", appRoot]);
  return [
    "sleep 3",
    "echo \"[codex-plusplus watcher] start $(date -u +%Y-%m-%dT%H:%M:%SZ)\"",
    update,
    "update_status=$?",
    "if [ \"$update_status\" -eq 0 ]; then echo \"[codex-plusplus watcher] update/repair check ok\"; exit 0; fi",
    "echo \"[codex-plusplus watcher] update failed ($update_status); trying repair\"",
    repair,
    "repair_status=$?",
    "if [ \"$repair_status\" -eq 0 ]; then echo \"[codex-plusplus watcher] repair ok\"; exit 0; fi",
    "echo \"[codex-plusplus watcher] repair failed ($repair_status)\"",
    "exit \"$repair_status\"",
  ].join("; ");
}

function launchdLabelForApp(appRoot: string): string {
  return /beta/i.test(appRoot) ? BETA_LABEL : LABEL;
}

function currentCliPath(): string {
  const currentModulePath = fileURLToPath(import.meta.url);
  const extension = currentModulePath.endsWith(".ts") ? ".ts" : ".js";
  return join(dirname(currentModulePath), `cli${extension}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function windowsCommand(command: string, args: string[] = []): string {
  return [
    windowsQuote(process.execPath),
    ...process.execArgv.map(windowsQuote),
    windowsQuote(currentCliPath()),
    command,
    ...args,
  ].join(" ");
}

function windowsWatcherTaskCommand(): string {
  const comspec = process.env.ComSpec || "cmd.exe";
  return `"${comspec}" /d /s /c "${windowsCommand("update", ["--watcher", "--quiet"])} || ${windowsCommand("repair", ["--quiet"])}"`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, `\\"`)}"`;
}

function uninstallScheduledTask(): void {
  deleteScheduledTask("codex-plusplus-watcher");
  deleteScheduledTask("codex-plusplus-watcher-hourly");
  deleteScheduledTask("codex-plusplus-watcher-daily");
}

function deleteScheduledTask(name: string): void {
  try {
    execFileSync("schtasks.exe", ["/Delete", "/F", "/TN", name], {
      stdio: "ignore",
    });
  } catch {}
}
