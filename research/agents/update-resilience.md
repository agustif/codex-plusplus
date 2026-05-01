# Update Resilience Notes

Scope: product and engineering improvements for Codex app updates breaking Codex++ niceties.

Current live state on 2026-05-01:

- `codex-plusplus status` reports Codex++ `0.1.4`, app root `/Applications/Codex.app`, Codex `26.429.20946`, channel `stable`, bundle id `com.openai.codex`, watcher `launchd`, safe mode disabled.
- Integrity is currently healthy: current asar `4fcb53926b39ebc9...` matches the recorded patched hash, plist hash is OK, and the asar integrity fuse is off.
- `launchctl print gui/$(id -u)/com.codexplusplus.watcher` shows the watcher loaded from `~/Library/LaunchAgents/com.codexplusplus.watcher.plist`, not running, last exit code `0`, watching `/Applications/Codex.app/Contents/Resources/app.asar`, and running hourly.
- The installed Codex app plist exposes `CFBundleIdentifier=com.openai.codex`, `CFBundleShortVersionString=26.429.20946`, and `SUPublicEDKey=rhcBvttuqDFriyNqwTQJR3L4UT1WjIK4QxtwtwusVic=`.

## 1. Best Immediate Wins

### 1.1 Add a first-class update resilience status surface

- `Impact`: high
- `Effort`: small
- `Confidence`: high
- `Dependency`: Codex++ runtime seam, installer CLI

Make the Settings page expose the same high-signal fields as `codex-plusplus status`: Codex++ version, Codex version, channel, bundle id, watcher kind, asar drift state, plist hash state, fuse state, update-mode state, and last watcher run. The CLI already computes most of this in `status`, but today the user only sees it if they know to run a terminal command.

Evidence:

- `packages/installer/src/commands/status.ts:12-38` prints user dir, tweaks dir, log dir, safe mode, installed version, app root, Codex version/channel/bundle id, fuse, resign, and watcher.
- `packages/installer/src/commands/status.ts:48-85` compares the current asar header against `state.patchedAsarHash`, prints update mode if present, checks plist integrity, and reads the asar fuse.
- `packages/installer/src/state.ts:7-32` already persists the status contract: Codex++ version, install time, app root, original/patched asar hashes, Codex version/channel/bundle id, fuse, resign, original entry, watcher, and runtime refresh time.

Suggested product shape:

- A compact "Update Health" row in Settings.
- States: `Healthy`, `Codex updating`, `Codex++ paused`, `Repair needed`, `Repair failed`, `Watcher missing`, `Unsupported Codex version`.
- One primary action per state: `Repair now`, `Open logs`, `Restore signed app for updater`, or `Restart Codex`.

### 1.2 Persist watcher health, not just watcher kind

- `Impact`: high
- `Effort`: small to medium
- `Confidence`: high
- `Dependency`: installer CLI

The watcher can be installed and still fail later because the pinned Node path moves, the launchd job loses permissions, the app path changes, or the CLI path is stale. Persist a small heartbeat record each time the watcher starts and exits: timestamp, command, CLI path, Node path, result, app version observed, asar hash observed, and action taken.

Evidence:

- `packages/installer/src/watcher.ts:60-64` writes a launchd command that hardcodes `process.execPath` and `currentCliPath()`.
- The live launchd job currently uses `/opt/homebrew/Cellar/node/25.2.1/bin/node` and `/Users/af/codex-plusplus/packages/installer/dist/cli.js`; this works now, but the Node Cellar path is versioned and can drift after Homebrew upgrades.
- `packages/installer/src/watcher.ts:87-90` logs stdout/stderr to `~/Library/Logs/codex-plusplus-watcher.log`, but `status` does not summarize last run or last error.
- `packages/installer/src/commands/repair.ts:236-247` refreshes the watcher and warns only when not quiet; watcher-driven repairs run quiet, so the user can miss recurring failures.

Suggested engineering shape:

- Add `<user-data-dir>/watcher-health.json`.
- Write `startedAt`, `finishedAt`, `exitCode`, `phase`, `nodePath`, `cliPath`, `codexVersion`, `asarHash`, `action`, and a bounded error summary.
- Teach `status` and the runtime Settings page to render the latest watcher heartbeat.

### 1.3 Make `repair --quiet` quiet for normal success, not invisible on failure

- `Impact`: high
- `Effort`: small
- `Confidence`: high
- `Dependency`: installer CLI, notification UX

Watcher repair should be silent for healthy no-ops and successful repairs, but visible and actionable when it cannot restore Codex++. Right now generic CLI failures show a terminal report URL and `repair` failures try an AppleScript alert, but quiet watcher mode can still disappear into launchd logs if AppleScript fails.

Evidence:

- `packages/installer/src/cli.ts:28-44` wraps command failures, prints a GitHub issue URL, and exits nonzero.
- `packages/installer/src/cli.ts:55-59` only calls `showPatchFailedAlert` for the `repair` command.
- `packages/installer/src/alerts.ts:11-26` offers a "Report on GitHub" action for patch failures.
- `packages/installer/src/alerts.ts:150-160` implements notifications with `osascript display notification`, which is best-effort and swallowed on failure.

Suggested engineering shape:

- Keep AppleScript dialogs for blocking choices, but use macOS `UserNotifications.framework` for durable local notifications from a tiny helper app or signed companion. Apple documents local notifications as the supported way for an app to present alerts even when not foregrounded.
- Add a fallback `codex-plusplus status --json` plus `codex-plusplus repair --explain-last-failure` so the UI and terminal show the same diagnosis.

### 1.4 Harden auto-repatch around the "Codex is still running" path

- `Impact`: high
- `Effort`: medium
- `Confidence`: high
- `Dependency`: installer CLI, native Codex seam

Current repair correctly avoids patching under a running macOS app unless the user accepts restart. The weak spot is the period where Codex has updated and launched without Codex++; the user may not know the niceties are unavailable or why.

Evidence:

- `packages/installer/src/commands/repair.ts:49-80` announces update detection, waits for macOS update files to settle, checks update mode, then compares current asar hash to the patched hash.
- `packages/installer/src/commands/repair.ts:119-128` prompts to quit/repatch if Codex is running; if the user declines, repair is postponed and Codex keeps running without the updated Codex++ patch.
- `packages/installer/src/alerts.ts:89-105` asks for "Restart and Re-Patch" and returns `false` when the user chooses later.

Suggested product shape:

- Record `repairPostponedAt` and `reason=codex-running`.
- Surface "Codex is running without Codex++ after update" in the next injected runtime if possible, or in the companion status if not injected.
- Add `codex-plusplus repair --when-codex-quits` to park a one-shot launchd job that waits for Codex exit, patches, then reopens.

### 1.5 Add compatibility gating before writing the patch

- `Impact`: high
- `Effort`: medium
- `Confidence`: medium
- `Dependency`: native Codex seam, installer CLI

Codex++ should distinguish "known compatible", "unknown but likely compatible", and "known incompatible" Codex versions before mutating the app. The installer already records versions and can read bundle metadata; the missing piece is a compatibility matrix tied to hook probes.

Evidence:

- `packages/installer/src/platform.ts:104-110` infers stable versus beta channel from bundle id/name.
- `packages/installer/src/commands/install.ts:53-55` reads and prints Codex version/channel before patching.
- `packages/installer/src/commands/install.ts:224-237` searches for the Codex window services hook and throws `Codex window services hook point not found` if the minified app shape has changed.
- `docs/ARCHITECTURE.md:117-121` already names layout changes, Settings DOM changes, and targeted anti-tamper as unprotected update classes.

Suggested engineering shape:

- Add `compatibility.json` keyed by Codex channel/version with required probes: package main exists, preload strategy still additive, window services hook found, Settings mount heuristic found, app-server bridge shape.
- Let `repair` run probes before mutation. If unknown, create a full backup and proceed with a visible "experimental compatibility" state; if known bad, stop before writing and show the exact failing probe.

## 2. Medium Bets

### 2.1 Split runtime staging into stable, candidate, and active slots

- `Impact`: medium to high
- `Effort`: medium
- `Confidence`: high
- `Dependency`: Codex++ runtime seam

`repair` can refresh runtime assets when the app patch is intact and Codex++ version advances. Today `stageAssets(paths.runtime)` writes directly into the active runtime directory. Use staged slots so a bad Codex++ runtime update does not break the currently working injected runtime.

Evidence:

- `packages/installer/src/commands/repair.ts:78-105` refreshes runtime assets when the asar patch is intact and `CODEX_PLUSPLUS_VERSION` is newer than `state.version`.
- `packages/installer/src/commands/install.ts:78-80` stages runtime before app patching.
- `packages/installer/src/commands/install.ts:250-267` copies assets directly into `runtimeDir`.
- `packages/installer/src/paths.ts:8-15` defines a single `runtime/` directory and a single `backup/` directory.

Suggested engineering shape:

- Write `runtime/releases/<codexpp-version>/`.
- Keep `runtime/active` as a symlink or manifest pointer.
- Let the loader read an atomic manifest first; on failure, fall back to previous active runtime.
- Add `runtimeUpdatedAt`, `runtimeActiveVersion`, `runtimePreviousVersion`, and `runtimeCandidateVersion` to state.

### 2.2 Treat `update-codex` as a guided repair/update wizard

- `Impact`: medium
- `Effort`: medium
- `Confidence`: high
- `Dependency`: installer CLI, repair UX

`update-codex` already knows how to restore a signed app from a pristine backup or Sparkle cache, pause Codex++ patching with update mode, install the watcher, and reopen Codex. This is close to a product-quality "let official updater run" flow, but it is CLI-only and state is only loosely visible.

Evidence:

- `packages/installer/src/commands/update-codex.ts:38-45` finds a signed backup or Sparkle-cached app and gives a specific recovery error if none exists.
- `packages/installer/src/commands/update-codex.ts:53-59` writes update mode and installs the watcher.
- `packages/installer/src/commands/update-codex.ts:65-78` parks the patched app, restores a signed app, clears quarantine, and verifies signature.
- `packages/installer/src/update-mode.ts:3-45` models a six-hour update-mode window and describes stale paused state.

Suggested product shape:

- Settings button: "Update Codex safely".
- Steps: verify signed backup, restore signed app, launch Codex updater, show paused state, detect new version, reapply Codex++, restart Codex.
- Persist each phase so interrupted flows resume instead of forcing the user to remember terminal commands.

### 2.3 Add a backup manifest and restore policy

- `Impact`: medium
- `Effort`: medium
- `Confidence`: high
- `Dependency`: installer CLI

The backup directory is crucial, but it is mostly implicit. Add a manifest that records what each backup can restore, source signature status, Codex version/channel, hash, creation time, and whether it was verified after copy.

Evidence:

- `packages/installer/src/commands/install.ts:61-74` backs up signed Codex.app, app.asar, app.asar.unpacked, Info.plist, and Electron Framework.
- `packages/installer/src/commands/install.ts:169-175` only keeps a pristine app backup if signature info is valid, non-ad-hoc, and has a team identifier.
- `packages/installer/src/commands/update-codex.ts:92-109` chooses Sparkle cache candidates before pristine backup and prefers newer signed versions.
- `packages/installer/src/state.ts:12-15` stores original and patched asar hashes, but not a backup inventory.

Suggested engineering shape:

- Add `<user-data-dir>/backup/manifest.json`.
- Store entries for `pristine-app`, `prepatch-asar`, `plist`, `framework`, and `parked-patched-app`.
- Include `verifiedAt`, `teamIdentifier`, `adHoc`, `codexVersion`, `hash`, `path`, and `restoreCommand`.
- Status should warn when a backup is missing or older than the recorded install.

### 2.4 Add a post-update synthetic smoke test

- `Impact`: medium
- `Effort`: medium
- `Confidence`: medium
- `Dependency`: Codex++ runtime seam, app-server protocol

After repair succeeds, automatically confirm the injected runtime is actually alive. Hash equality proves the patch is on disk; it does not prove the runtime loaded, the Settings affordance mounted, or the app-server bridge still works.

Evidence:

- `packages/installer/src/commands/status.ts:59-85` checks disk integrity and fuse state only.
- `docs/ARCHITECTURE.md:119-120` notes DOM heuristic drift as a separate failure mode from asar layout drift.
- `research/README.md:22-29` records current runtime features that depend on app-server and preload bridges, including `/goal` and git metadata.

Suggested engineering shape:

- Add a renderer heartbeat file or IPC ping from runtime load.
- Store last runtime heartbeat by Codex version and Codex++ version.
- If disk repair succeeds but runtime heartbeat never appears after launch, status should say "patched on disk, runtime not observed".

## 3. Wild Ideas Or Moonshots

### 3.1 Companion menu bar app for update state

- `Impact`: medium
- `Effort`: large
- `Confidence`: medium
- `Dependency`: external service, installer CLI

A tiny signed companion app could own notifications, repair prompts, status UI, logs, and update orchestration without depending on injected Codex UI. This is the cleanest product surface for the moments when Codex++ is not injected because Codex just updated.

Evidence:

- All current UI prompts are AppleScript shell-outs from `packages/installer/src/alerts.ts:144-160`.
- Once Sparkle replaces Codex.app, Codex++ cannot rely on injected renderer UI until repair succeeds, as described in `docs/ARCHITECTURE.md:101-108`.

### 3.2 Compatibility canary for new Codex releases

- `Impact`: high
- `Effort`: large
- `Confidence`: medium
- `Dependency`: native Codex seam, external service

Run a CI or local scheduled canary against new Codex appcast releases before users hit them. It would download the latest signed Codex, run patch probes, produce a compatibility verdict, and publish a small manifest consumed by `repair`.

Evidence:

- The live Codex app has Sparkle metadata and a public key in `Info.plist`; the root package metadata also carries `codexSparkleFeedUrl` and `codexSparklePublicKey`.
- `packages/installer/src/commands/update-codex.ts:111-120` already knows Sparkle cache layout for installed updates.
- Sparkle documentation treats regular app bundles and archives as normal update artifacts; package installers are documented as a special case for custom needs.

### 3.3 Multi-strategy patch backend

- `Impact`: moonshot
- `Effort`: large
- `Confidence`: low to medium
- `Dependency`: native Codex seam

Keep current asar entry patch as the default, but add a strategy registry for future Codex layouts: asar package main patch, Electron session preload append, launcher wrapper, or companion-only mode. This turns "Codex layout changed" into a strategy negotiation instead of a binary failure.

Evidence:

- `packages/installer/src/commands/install.ts:178-221` has a single injection strategy: rewrite `package.json#main`, copy `codex-plusplus-loader.cjs`, and patch window services.
- `docs/ARCHITECTURE.md:79-93` explains why the current patch is efficient and why runtime lives outside the app, but also names layout changes as a class of breakage.

## 4. Constraints And Exact Evidence

- Do not patch while Codex is actively running unless the user accepts restart. Current repair enforces this on macOS in `packages/installer/src/commands/repair.ts:119-128`.
- Do not erase user tweaks during repair or runtime refresh. The architecture states self-update repair refreshes runtime and state without modifying user tweak folders in `docs/ARCHITECTURE.md:109-113`.
- Watcher reinstallation must preserve an explicit no-watcher install. `packages/installer/src/commands/repair.ts:133-139` passes `watcher: state?.watcher === "none" ? false : true`.
- Update mode must expire. `packages/installer/src/update-mode.ts:3-45` defines a six-hour freshness window and marks stale paused state.
- The current patch health proof is disk-level, not runtime-level. `status` checks asar hash, plist hash, and fuse state in `packages/installer/src/commands/status.ts:59-85`.
- External primitive note: prefer `UserNotifications.framework` for durable macOS local notifications over raw `osascript display notification`; Apple documents it as the framework for local and remote user-facing notifications. Keep AppleScript dialogs only where a terminal process needs a synchronous choice.
- External Sparkle note: treat Sparkle as the source of truth for official Codex app replacement, but do not try to become a Sparkle plugin inside Codex. Sparkle docs discourage package-style update paths unless there is a custom installation need, and Codex++ should stay outside the official updater boundary.

## 5. Suggested Next Slice

Implement the smallest resilience slice in this order:

1. Add `watcher-health.json` and write it from watcher-launched `update` and `repair` paths.
2. Extend `status` with watcher heartbeat, last repair action, update-mode age, and a machine-readable `--json` mode.
3. Add a Settings "Update Health" panel that reads the same status contract.
4. Add a one-shot "repair when Codex quits" path for postponed repairs.
5. Add a compatibility probe file with hard stops for known-bad Codex versions and warnings for unknown versions.

