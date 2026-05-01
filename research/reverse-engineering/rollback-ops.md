# Rollback Ops For Aggressive Codex++ Reverse Engineering

Owner scope: research lane only. This file maps practical safety and rollback
guardrails for self-modifying Codex++ work without turning experiments into a
slow release process. It does not change product code.

## Executive Shape

Codex++ already has the right high-level boundary: destructive app/runtime
changes should be supervised by a process outside the Electron process being
modified. The next step is to make every experiment produce a small manifest
and a one-command rollback target.

Fast experimentation should stay possible by splitting writes into three lanes:

1. Repo edits happen in git worktrees with patch manifests.
2. Runtime candidates are staged under versioned/candidate runtime directories
   before becoming active.
3. App bundle mutations are protected by signed/pristine bundle backups,
   backup manifests, and restore commands.

The guardrails should be cheap by default: metadata-only logs, bounded output,
feature flags for risky paths, crash loop counters, and automatic rollback when
health checks fail.

## Current Repo Facts

- `docs/ARCHITECTURE.md` describes Codex++ as an Electron app patch plus a
  user-data runtime. The patched app points `app.asar` at
  `codex-plusplus-loader.cjs`, which loads `<userRoot>/runtime/main.js`.
- The user data layout already has natural rollback surfaces:
  `<userRoot>/runtime`, `<userRoot>/backup`, `<userRoot>/log`, `state.json`,
  and `config.json`.
- `install` backs up `Codex.app`, `app.asar`, `app.asar.unpacked`,
  `Info.plist`, and the Electron Framework binary before patching.
- `repair` already detects intact patched asar hashes, respects update mode,
  refreshes runtime assets when the Codex++ version changes, and reruns install
  when app hashes drift.
- `update-codex` can park a patched app and restore a signed app from either a
  pristine backup or Sparkle cache.
- `dev-runtime --restart` is documented as the right supervisor shape: back up
  current runtime, stage candidate runtime, reopen with CDP, wait for
  `/json/version`, restore previous runtime on failure.
- `codexpp_self_runtime_apply` exposes the same model through self-MCP:
  rebuild, stage runtime, optionally restart, verify CDP health, and restore on
  failure.
- Runtime logging already has a hard cap primitive:
  `appendCappedLog(path, line, maxBytes = 10 MiB)`.
- Self-MCP already caps reads, searches, shell timeouts, and command output, but
  broad self-shell and write tools still need manifests and policy decisions to
  keep experiments reviewable.

## Guardrail Matrix

| Guardrail | Purpose | Fast path | Rollback path | Implementation candidate |
| --- | --- | --- | --- | --- |
| App bundle backup manifest | Know exactly what can restore Codex.app | Write manifest during install/update-codex | `codexplusplus rollback app --to <manifest-id>` | `packages/installer/src/backup-manifest.ts` |
| Git worktree lanes | Isolate agent experiments without reinstalling deps | Create sibling worktree from a prepared golden repo | Remove worktree or reset branch only | `codexplusplus lab worktree create` |
| Runtime candidate snapshots | Test modified runtime without overwriting stable state | Stage `runtime/candidates/<id>` and flip active pointer | Restore `runtime/releases/<previous>` | `packages/installer/src/runtime-manifest.ts` |
| Patch manifests | Make self-modification replayable/reversible | Record files, hashes, commands, env, validation | `git apply --reverse` or restore captured files | `research/evidence` first, later `<userRoot>/patches` |
| Feature flags | Keep risky hooks opt-in | `config.json` gates and env overrides | Toggle flag off, reload/restart | capability registry + Settings |
| Crash loop detection | Stop repeatedly launching broken runtime | Count failed starts per runtime hash | Auto-select previous runtime and write incident | runtime heartbeat + launcher supervisor |
| Log caps/redaction | Preserve evidence without leaking secrets or exploding context | Metadata-only default, capped logs | Delete/redact incident bundle safely | shared log writer |
| Config drift detection | Catch app/user config mutations before repair breaks | Hash known files and show drift state | Restore known file from backup manifest | `status`, `doctor`, Recovery Center |
| One-command rollback | Make failure recovery obvious under stress | Single command chooses app/runtime/config scope | Restore last known good + restart Codex | `codexplusplus rollback` |

## Commands To Standardize

These commands should exist or be documented as the common operator path.

### Preflight Before A Risky Experiment

```bash
cd /Users/af/codex-plusplus
git status --short --branch
npm test
codexplusplus status
codexplusplus doctor
codexplusplus patch-manager status
```

Minimum expected output to capture in a patch manifest:

- repo root and branch,
- head SHA,
- dirty file list,
- Codex++ version,
- stable/beta app roots,
- stable/beta user roots,
- current runtime hash or manifest id,
- current Codex version/channel/bundle id,
- watcher kind and loaded state.

### Golden Worktree Creation

Goal: fresh worktrees without paying setup tax.

```bash
ROOT=/Users/af/codex-plusplus
GOLDEN=/Users/af/codex-plusplus
LANES=/Users/af/codex-plusplus-worktrees
BRANCH=lab/rollback-ops-$(date +%Y%m%d-%H%M%S)
DEST="$LANES/$BRANCH"

mkdir -p "$LANES"
git -C "$GOLDEN" fetch origin
git -C "$GOLDEN" worktree add -b "$BRANCH" "$DEST" origin/main

# Reuse install artifacts when same platform/lockfile. Prefer symlink only for
# read-heavy experiments; run npm ci if the lockfile changes.
ln -s "$GOLDEN/node_modules" "$DEST/node_modules"
```

Rollback:

```bash
git -C /Users/af/codex-plusplus worktree remove "$DEST"
git -C /Users/af/codex-plusplus branch -D "$BRANCH"
```

Candidate improvement: make this a CLI command that refuses to create a lane if
the golden checkout has lockfile drift or missing `node_modules`.

```bash
codexplusplus lab worktree create --from /Users/af/codex-plusplus --name rollback-ops
```

### App Bundle Snapshot

Current install already backs up key artifacts. The missing piece is a
manifest with restore metadata.

```bash
APP="/Applications/Codex.app"
HOME_DIR="$HOME/Library/Application Support/codex-plusplus"
OUT="$HOME_DIR/backup/manual-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$OUT"
ditto "$APP" "$OUT/Codex.app"
shasum -a 256 "$APP/Contents/Resources/app.asar" > "$OUT/app.asar.sha256"
/usr/bin/codesign --verify --deep --strict "$OUT/Codex.app" > "$OUT/codesign.verify.txt" 2>&1 || true
/usr/bin/codesign -dv "$OUT/Codex.app" > "$OUT/codesign.detail.txt" 2>&1 || true
/usr/bin/defaults read "$OUT/Codex.app/Contents/Info" CFBundleShortVersionString > "$OUT/codex-version.txt"
```

Restore:

```bash
APP="/Applications/Codex.app"
BACKUP="$HOME/Library/Application Support/codex-plusplus/backup/manual-YYYYMMDD-HHMMSS/Codex.app"

osascript -e 'tell application "Codex" to quit' || true
mv "$APP" "$APP.rollback-$(date +%Y%m%d-%H%M%S)"
ditto "$BACKUP" "$APP"
xattr -dr com.apple.quarantine "$APP" || true
open "$APP"
```

Implementation candidate:

```bash
codexplusplus backup create --scope app --channel stable
codexplusplus backup list
codexplusplus rollback app --backup <id> --restart
```

Manifest fields:

```json
{
  "id": "20260501T104500Z-stable-app",
  "scope": "app",
  "channel": "stable",
  "appRoot": "/Applications/Codex.app",
  "codexVersion": "26.429.20946",
  "bundleId": "com.openai.codex",
  "teamIdentifier": "verified-team-id-or-null",
  "adHoc": false,
  "paths": {
    "app": "backup/20260501T104500Z-stable-app/Codex.app",
    "asar": "backup/20260501T104500Z-stable-app/app.asar"
  },
  "hashes": {
    "appAsarSha256": "...",
    "plistSha256": "..."
  },
  "verifiedAt": "2026-05-01T10:45:00.000Z",
  "restoreCommand": "codexplusplus rollback app --backup 20260501T104500Z-stable-app --restart"
}
```

### Runtime Snapshot And Apply

Current documented shape is already right. Formalize it as a manifest-backed
candidate workflow.

```bash
cd /Users/af/codex-plusplus
npm run build
codexplusplus dev-runtime --channel stable --restart
```

Future command:

```bash
codexplusplus runtime snapshot --channel stable --label before-flow-tap
codexplusplus runtime apply --candidate dist --channel stable --restart --health cdp
codexplusplus rollback runtime --channel stable --to previous --restart
```

Runtime manifest fields:

```json
{
  "id": "runtime-20260501T105100Z",
  "channel": "stable",
  "sourceRepo": "/Users/af/codex-plusplus",
  "sourceHead": "git-sha",
  "sourceDirty": true,
  "files": {
    "main.js": "sha256",
    "preload.js": "sha256",
    "self-mcp-server.js": "sha256",
    "self-mcp-launcher.js": "sha256"
  },
  "health": {
    "cdpJsonVersion": "ok",
    "runtimeHeartbeat": "missing|ok|failed",
    "startedAt": "...",
    "finishedAt": "..."
  },
  "previousRuntimeId": "runtime-..."
}
```

### Patch Manifest For Self-Modifying Tools

Every broad write path should emit a patch manifest before it changes files.
This keeps experiments fast while making failures auditable.

```bash
codexplusplus self patch begin --label app-server-flow-tap --root /Users/af/codex-plusplus
codexplusplus self patch apply --manifest <id> --patch changes.diff
codexplusplus self patch validate --manifest <id> -- npm test
codexplusplus self patch rollback --manifest <id>
```

Minimum manifest:

```json
{
  "id": "patch-20260501T110000Z-app-server-flow-tap",
  "root": "/Users/af/codex-plusplus",
  "baseHead": "git-sha",
  "branch": "lab/app-server-flow-tap",
  "agentThread": "thread-or-rollout-id",
  "tool": "codexpp_self_git_apply",
  "startedAt": "2026-05-01T11:00:00.000Z",
  "filesBefore": {
    "packages/runtime/src/main.ts": "sha256"
  },
  "filesAfter": {
    "packages/runtime/src/main.ts": "sha256"
  },
  "commands": [
    {
      "argv": ["npm", "test"],
      "exitCode": 0,
      "durationMs": 12345,
      "stdoutBytes": 65536,
      "stderrBytes": 2048,
      "redacted": true
    }
  ],
  "rollback": {
    "kind": "git-apply-reverse",
    "patchPath": "patches/patch-20260501T110000Z-app-server-flow-tap.diff"
  }
}
```

## Log Caps And Redaction Toggles

Keep the current 10 MiB capped-log primitive, but make redaction explicit and
default-on for agent-facing surfaces.

Recommended config:

```json
{
  "codexPlusPlus": {
    "logs": {
      "maxBytesPerFile": 10485760,
      "maxBytesPerEvent": 131072,
      "redaction": "metadata-only",
      "includeRawToolOutput": false,
      "includeEnvValues": false,
      "includeFileContents": false,
      "secretPatterns": [
        "sk-[A-Za-z0-9_-]+",
        "OPENAI_API_KEY=.*",
        "ANTHROPIC_API_KEY=.*"
      ]
    }
  }
}
```

Modes:

- `metadata-only`: default. Paths, command argv, exit codes, byte counts,
  hashes, statuses. No raw file contents or env values.
- `redacted-snippets`: bounded text snippets with secret regex replacement.
- `raw-local`: explicit opt-in for local debugging; never included in PR bodies
  or agent handoff summaries by default.

Implementation candidate:

- Move `appendCappedLog` behind a shared `LogSink` API.
- Store a redaction decision with every event: `mode`, `patternsVersion`,
  `truncated`, `originalBytes`, `writtenBytes`.
- Add tests for large output, UTF-8 truncation boundaries, and common secret
  patterns.

## Feature Flags And Safety Levels

Feature flags should disable risky classes instantly without removing code.

Suggested config:

```json
{
  "codexPlusPlus": {
    "safeMode": false,
    "experiments": {
      "selfModification": false,
      "appServerFlowTap": false,
      "rawAppServerAccess": false,
      "runtimeCandidateApply": true,
      "autoRollbackOnCrashLoop": true,
      "rawLogCapture": false
    }
  }
}
```

Safety levels:

- `observe`: read-only metadata, capped logs, no writes.
- `stage`: write only to candidate/worktree locations.
- `apply`: mutate active runtime or app after preflight.
- `recover`: restore previous known-good state and disable failed flag.

Implementation candidate:

- Add a typed flag reader used by installer, runtime, and self-MCP.
- Make broad self-MCP tools check `selfModification` unless launched with an
  explicit local env override.
- Recovery Center should show active risky flags and one-click disable them.

## Crash Loop Detection

Crash loops should be detected by the external supervisor, not by code inside
the candidate runtime that may fail to load.

Signals:

- app launched with candidate runtime id,
- CDP `/json/version` never becomes healthy,
- renderer heartbeat file missing after timeout,
- process exits repeatedly within a short window,
- same candidate id fails N times.

Suggested state file:

```json
{
  "activeRuntimeId": "runtime-20260501T105100Z",
  "previousRuntimeId": "runtime-20260501T101500Z",
  "attempts": [
    {
      "runtimeId": "runtime-20260501T105100Z",
      "startedAt": "...",
      "finishedAt": "...",
      "result": "cdp-timeout",
      "exitCode": null
    }
  ],
  "policy": {
    "maxFailures": 2,
    "windowMs": 300000,
    "rollbackOnFailure": true
  }
}
```

Rollback action:

```bash
codexplusplus rollback runtime --channel stable --to previous --reason crash-loop --restart
```

After rollback, disable the experiment flag that introduced the candidate and
write an incident summary to `<userRoot>/log/incidents/<id>.json`.

## Config Drift Detection

Config drift matters in three places:

1. Codex app bundle files: `app.asar`, `Info.plist`, Electron Framework binary.
2. Codex++ user config: `config.json`, `state.json`, `update-mode.json`.
3. Codex MCP config: `~/.codex/config.toml` managed blocks.

Drift check command shape:

```bash
codexplusplus drift check --channel stable --format json
codexplusplus drift check --scope app,runtime,config,mcp --explain
```

Detection rules:

- If app asar hash differs from `state.patchedAsarHash`, show `repair-needed`
  unless update mode is fresh.
- If `Info.plist` integrity hash does not match current asar, show
  `plist-integrity-drift`.
- If Electron fuse state differs from `state.fuseFlipped`, show `fuse-drift`.
- If runtime active files differ from active runtime manifest, show
  `runtime-drift`.
- If `config.json` has unknown risky flags enabled, show `config-risk-drift`.
- If managed MCP blocks differ from the generated model, show `mcp-drift` and
  preview before/after TOML instead of rewriting silently.

## One-Command Rollback

The operator should not need to remember which layer broke.

```bash
codexplusplus rollback --last-known-good --restart
```

Resolution order:

1. If active runtime candidate failed health, restore previous runtime only.
2. Else if app bundle drift is detected and a signed backup exists, restore app.
3. Else if config drift is detected, restore last config snapshot.
4. Else print exact status and refuse to mutate.

Scoped forms:

```bash
codexplusplus rollback runtime --channel stable --to previous --restart
codexplusplus rollback app --channel beta --backup latest-signed --restart
codexplusplus rollback config --snapshot latest
codexplusplus rollback mcp --managed-only
codexplusplus rollback patch --manifest patch-20260501T110000Z-app-server-flow-tap
```

The command should always:

- write a rollback manifest before mutating,
- quit/reopen Codex only when `--restart` is present,
- verify post-restore health,
- print the exact restored ids,
- leave failed candidate artifacts in place for inspection unless `--prune` is
  explicit.

## Implementation Candidates

### P0: Manifest Backbone

- Add `packages/installer/src/manifest-store.ts` for append-only JSON manifests
  under `<userRoot>/manifests`.
- Add types for `BackupManifest`, `RuntimeManifest`, `PatchManifest`,
  `DriftReport`, and `RollbackManifest`.
- Use EffectTS v4 native primitives for implementation slices that touch
  TypeScript error handling, filesystem effects, command execution, and
  validation.
- Tests: manifest round-trip, corrupt manifest quarantine, latest lookup,
  channel filtering.

### P0: Runtime Candidate Apply

- Promote the documented `dev-runtime --restart` behavior into a reusable
  service.
- Stage candidate runtime under `runtime/candidates/<id>`.
- Keep active runtime as either:
  - `runtime/active` pointer plus loader resolution, or
  - current `runtime/` directory plus `runtime/releases/<id>` backups.
- Health checks: CDP `/json/version`, runtime heartbeat, bounded renderer log
  scan.
- Rollback: restore previous active runtime and reopen app.

### P0: Rollback CLI

- Add `codexplusplus rollback` with dry-run as the default explanation mode.
- Require `--apply` or a scoped command for mutation unless invoked by an
  automatic crash-loop policy.
- Use backup/runtime/patch manifests to avoid guessing.
- Preserve current `repair` behavior; rollback is for known-good restore,
  repair is for reapplying Codex++ to a changed Codex app.

### P1: Recovery Center Surface

- Show app status, runtime status, watcher status, feature flags, last incident,
  and rollback commands.
- Keep raw logs behind an explicit toggle.
- Copy diagnostics should be metadata-only by default and include manifest ids.

### P1: Patch Manifest In Self-MCP

- Wrap `codexpp_self_write`, `codexpp_self_git_apply`,
  `codexpp_self_shell`, and `codexpp_self_runtime_apply`.
- Before mutation: capture branch/head, dirty status, file hashes, command
  budget, and intended rollback.
- After mutation: capture changed files, validation commands, output byte
  counts, and health results.
- Expose `codexpp_self_patch_status` and `codexpp_self_patch_rollback`.

### P1: Config Drift Detector

- Hash known app/runtime/config files after every successful install, repair,
  rollback, and runtime apply.
- Add `codexplusplus drift check`.
- Feed Recovery Center and PR descriptions with the same structured report.

## Done Criteria

This lane is ready to implement when the following contracts are accepted:

- Every app/runtime/config mutation writes a manifest before and after.
- Runtime experiments can be applied with health checks and rolled back without
  manual file surgery.
- Failed candidates are retained for evidence but not left active.
- Broad self-MCP writes are patch-manifested and output-capped.
- Recovery Center can show "what changed, what is active, what can be restored"
  without raw secrets or giant logs.
- One command can restore the last known-good runtime or app layer and report
  exactly what it restored.

