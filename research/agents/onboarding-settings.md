# Onboarding, Settings, Config, MCP, Safe Mode, and Repair UX

Owner: onboarding/settings product lane.

Scope: product notes only. No code changes proposed here are implemented in this pass.

## 1. Best Immediate Wins

1. Ship a "Recovery Center" inside Settings -> Codex++ -> Config.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.
   - Why: the repo already has the primitives, but they are split across CLI and UI. Config can read runtime config and watcher status through `codexpp:get-config` and `codexpp:get-watcher-health` (`packages/runtime/src/main.ts:453-472`), while CLI has `doctor`, `repair`, `status`, and `safe-mode` commands (`packages/installer/src/cli.ts:83-158`).
   - Current UX gap: in-app Config shows auto-update, update checks, watcher health, uninstall command, and issue reporting (`packages/runtime/src/preload/settings-injector.ts:711-758`, `packages/runtime/src/preload/settings-injector.ts:991-1047`), but it cannot run a repair, run doctor, toggle safe mode, or produce a single "what is wrong and what will be changed" repair plan.
   - Product slice:
     - Add rows for `Safe Mode`, `Run Doctor`, `Repair Codex++`, `Open Logs`, and `Copy Diagnostics`.
     - Use a dry-run style diagnostic first, then require explicit confirmation before repair touches the app bundle.
     - Show "Codex must restart" states using the same terms as the repair command, which already postpones repair when Codex is still running on macOS (`packages/installer/src/commands/repair.ts:118-127`).
   - Acceptance checks:
     - Config page can tell a user whether the patch is intact, watcher is healthy, safe mode is on, and which exact command would be run.
     - The repair path never silently mutates `~/.codex/config.toml` or tweak folders.

2. Promote safe mode from CLI-only to a first-class in-app panic switch.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.
   - Why: safe mode already exists in config and runtime behavior. `codexPlusPlus.safeMode` is part of persisted config (`packages/runtime/src/main.ts:69-78`), and `isTweakEnabled` returns false for every tweak when it is active (`packages/runtime/src/main.ts:125-131`). The CLI toggles this flag and touches a reload marker (`packages/installer/src/commands/safe-mode.ts:22-49`, `packages/installer/src/commands/safe-mode.ts:64-67`). `status` already reports it (`packages/installer/src/commands/status.ts:16-21`, `packages/installer/src/commands/status.ts:88-97`).
   - Current UX gap: if a bad renderer tweak breaks Settings, the user may not know that `codex-plusplus safe-mode --on` exists. If Settings still opens, there is no switch there.
   - Product slice:
     - Show a safe-mode row at the top of Config with a warning tone when enabled.
     - Add a keyboard/CLI fallback callout in troubleshooting docs, but keep the in-app switch as the primary path.
     - When enabled, show disabled tweak rows with "suppressed by safe mode" rather than just their stored per-tweak toggle state.
   - Acceptance checks:
     - Safe mode disables main and renderer tweaks without deleting per-tweak flags.
     - Turning safe mode off restores prior per-tweak enablement.

3. Add a config.toml MCP preview and ownership boundary.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium-high.
   - Dependency: native Codex seam plus Codex++ runtime seam.
   - Why: Codex++ writes managed MCP server blocks into `~/.codex/config.toml` (`packages/runtime/src/main.ts:41-42`, `packages/runtime/src/main.ts:680-697`). The sync code preserves manual servers by stripping only its managed block and skipping names already configured by the user (`packages/runtime/src/mcp-sync.ts:45-87`, `packages/runtime/src/mcp-sync.ts:106-128`).
   - Current UX gap: MCP sync is invisible unless logs are inspected. Users need to know which tweak owns each managed server, which manual server name caused a skip, and what file changed.
   - Product slice:
     - Add a "Managed MCP Servers" Config card listing server name, owning tweak, command, args, env key names only, and status: installed, skipped due to manual config, or invalid manifest.
     - Add "View config diff" before writing future changes; never display env values by default.
     - Keep the managed block markers as the user-facing contract: `# BEGIN CODEX++ MANAGED MCP SERVERS` and `# END CODEX++ MANAGED MCP SERVERS` (`packages/runtime/src/mcp-sync.ts:5-6`).
   - Acceptance checks:
     - Manual MCP servers outside the managed block are preserved.
     - A name collision is reported as "manual server wins" instead of silently hiding the tweak server.

4. Turn tweak discovery failures into actionable onboarding states.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.
   - Why: discovery is strict and currently skips invalid tweak folders without surfacing reasons. It requires `manifest.json`, valid JSON, `id`, `name`, `version`, `githubRepo`, valid `githubRepo`, valid scope, and an entry file (`packages/runtime/src/tweak-discovery.ts:22-61`). The SDK validator can already produce structured errors and warnings (`packages/sdk/src/index.ts:96-187`, `packages/sdk/src/index.ts:216-244`).
   - Current UX gap: Tweaks page only shows discovered tweaks or "No tweaks installed" (`packages/runtime/src/preload/settings-injector.ts:1177-1189`). A user with a broken tweak folder gets no explanation.
   - Product slice:
     - Introduce a discovery diagnostics list: valid tweaks, ignored folders, invalid manifests, missing entry, unsupported scope, missing `githubRepo`.
     - Reuse SDK validation messages in runtime discovery so CLI and Settings explain the same failure.
     - Add "Open tweak folder", "Copy manifest error", and "Validate tweak" actions.
   - Acceptance checks:
     - A bad manifest produces a visible reason in Tweaks.
     - A missing entry file is shown as a repairable condition.

5. Make first-run onboarding a state machine instead of README-only instructions.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam plus installer CLI.
   - Why: README documents install steps and side effects (`README.md:46-58`), user directories (`README.md:147-163`), and day-to-day commands (`README.md:59-78`). The installer already performs ordered steps: locate Codex, preflight writable bundle, stage runtime, patch asar, update integrity, flip fuse, re-sign, install watcher, install default tweaks, and persist state (`packages/installer/src/commands/install.ts:36-156`).
   - Current UX gap: once installed, the app does not show "what happened" or "what still needs attention" as a checklist.
   - Product slice:
     - Add a first-run "Setup complete / review" panel in Config: app path, Codex version/channel, watcher installed, runtime path, tweaks path, backup path, safe mode off, default tweaks installed/skipped.
     - Preserve alpha honesty from README status (`README.md:5-8`) but translate it into concrete readiness checks.
   - Acceptance checks:
     - First successful launch shows a green setup checklist.
     - Partial installs show the next command and exact failing check.

## 2. Medium Bets

1. Build a typed config service over `config.json` and `~/.codex/config.toml`.
   - Impact: high.
   - Effort: large.
   - Confidence: medium.
   - Dependency: native Codex seam plus Codex++ runtime seam.
   - Current state: Codex++ config is JSON in `<user-data-dir>/config.json` (`packages/installer/src/paths.ts:5-15`, `packages/runtime/src/main.ts:41`), while Codex MCP config is TOML in `~/.codex/config.toml` (`packages/runtime/src/main.ts:42`). Runtime reads/writes JSON directly (`packages/runtime/src/main.ts:102-123`) and MCP TOML via a managed text block (`packages/runtime/src/mcp-sync.ts:26-43`).
   - Product bet:
     - Create a single config service with typed reads, atomic writes, backups, validation, diffs, and audit log entries.
     - Keep manual Codex TOML ownership explicit; Codex++ only owns its marked MCP block.
     - Add "export diagnostics bundle" with redacted config shape, not secrets.
   - Implementation note for later: this is where a TOML parser dependency should be evaluated instead of expanding ad-hoc string manipulation. Current runtime package dependencies are intentionally small (`packages/runtime/package.json:10-18`), so the dependency tradeoff should be explicit.

2. Add a feature flag registry for Codex++ itself.
   - Impact: medium-high.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: Codex++ runtime seam.
   - Current state: the persisted config has booleans for `autoUpdate` and `safeMode`, but no generic feature flag registry (`packages/runtime/src/main.ts:69-78`). Config UI exposes only auto-update today (`packages/runtime/src/preload/settings-injector.ts:755-781`).
   - Product bet:
     - Introduce `codexPlusPlus.features` as typed feature flags with metadata: title, risk tier, default, owner, kill-switch behavior, and visibility.
     - Use it for experimental product surfaces: MCP preview, repair actions, tweak marketplace/catalog, config editor, git sidebar, goal command, and remote debugging affordances.
     - Add per-feature safe-mode overrides so dangerous experimental features can be disabled without suppressing every tweak.

3. Build tweak discovery as "tweak inbox + catalog" instead of a raw folder list.
   - Impact: medium-high.
   - Effort: large.
   - Confidence: medium.
   - Dependency: external service optional, Codex++ runtime seam required.
   - Current state: default tweaks are installed from GitHub releases and local tweak folders are never overwritten (`docs/ARCHITECTURE.md:43-45`). Installed tweak rows already display version, author, repo, homepage, tags, update badge, review-release action, and enable toggle (`packages/runtime/src/preload/settings-injector.ts:1245-1363`).
   - Product bet:
     - Add a local catalog JSON that lists recommended tweaks, install source, permissions, MCP exposure, and trust tier.
     - Stage downloads into a review inbox; require explicit install after showing manifest, release notes, permissions, and file list.
     - Keep update checks advisory, consistent with security policy that Codex++ never auto-installs tweak code (`SECURITY.md:20-26`, `docs/ARCHITECTURE.md:37-42`).

4. Add a "Repair Timeline" and notification history.
   - Impact: medium.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: installer CLI plus runtime UI.
   - Current state: watcher health can inspect launchd/systemd/scheduled-task state and recent watcher log tail (`packages/runtime/src/watcher-health.ts:38-89`, `packages/runtime/src/watcher-health.ts:92-207`). Repair has several branches: update mode active, patch intact, runtime update, forced install, postponed while app is running (`packages/installer/src/commands/repair.ts:49-147`).
   - Product bet:
     - Persist a compact event log: install, repair, watcher refresh, Codex update detected, runtime update skipped due to auto-update off, safe mode toggled, MCP block changed.
     - Show "last repair reason" and "next repair action" in Config.

5. Make settings injection self-diagnosing.
   - Impact: medium.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: native Codex seam.
   - Current state: settings injection is DOM-heuristic based and looks for Codex's routed settings sidebar by known labels, not stable test IDs (`packages/runtime/src/preload/settings-injector.ts:1-21`, `packages/runtime/src/preload/settings-injector.ts:298-371`). The architecture doc still describes an older modal/dialog/tablist model (`docs/ARCHITECTURE.md:72-75`), so docs and implementation drift have already happened.
   - Product bet:
     - Add a hidden "Settings injector diagnostics" dump in Config or logs: sidebar labels found, content area found, active page state, last injection failure.
     - Update architecture docs alongside the UI so future product work does not target stale Radix dialog assumptions.

## 3. Wild Ideas / Moonshots

1. "Undoable Desktop Surgery" mode.
   - Impact: moonshot.
   - Effort: large.
   - Confidence: medium.
   - Dependency: installer CLI, app bundle, runtime UI.
   - Idea: every app-bundle operation becomes a reversible transaction shown in UI: planned files, hashes before/after, signature state, backup path, rollback command. This would make app patching feel less like a black box.
   - Anchor: install already records original and patched hashes plus app metadata in state (`packages/installer/src/commands/install.ts:134-148`), and status compares current asar/plist/fuse state (`packages/installer/src/commands/status.ts:59-85`).

2. MCP permission firewall.
   - Impact: moonshot.
   - Effort: large.
   - Confidence: low-medium.
   - Dependency: native Codex seam plus external MCP process supervision.
   - Idea: instead of only writing MCP commands to `config.toml`, Codex++ could launch managed MCP servers through a supervisor that enforces env redaction, cwd restrictions, process lifetime, logging, and per-tool allow/deny policy.
   - Anchor: current manifest supports a single `mcp` object with command, args, and env (`packages/sdk/src/index.ts:44-62`), and sync writes those values into TOML (`packages/runtime/src/mcp-sync.ts:141-155`).

3. Tweak marketplace with verified provenance.
   - Impact: moonshot.
   - Effort: large.
   - Confidence: medium.
   - Dependency: external service optional.
   - Idea: signed tweak manifests, release attestation, maintainer identity, permissions diff, and user review gates. Codex++ should remain local-first, but the catalog could rank "trusted enough to inspect" rather than "trusted to auto-run."
   - Anchor: current security stance says tweaks are local code, untrusted until reviewed, and updates are advisory (`SECURITY.md:20-26`).

4. Guided repair chat inside Settings.
   - Impact: moonshot.
   - Effort: research.
   - Confidence: low-medium.
   - Dependency: native Codex seam plus local logs.
   - Idea: an in-app repair assistant that reads bounded diagnostics, explains failure states, and proposes exact repair commands without sending raw logs or secrets by default.
   - Boundary: keep this metadata-only unless user explicitly attaches logs. Logs and config may contain paths, usernames, repo names, or env shape.

## 4. Constraints And Exact Evidence

1. Config and state are split.
   - `config.json` stores user preferences and per-tweak flags (`packages/runtime/src/main.ts:69-78`, `packages/runtime/src/main.ts:102-137`).
   - `state.json` stores installer records (`packages/installer/src/paths.ts:12-15`, `docs/ARCHITECTURE.md:31-33`).
   - `~/.codex/config.toml` is touched only for MCP sync (`packages/runtime/src/main.ts:41-42`, `packages/runtime/src/main.ts:680-697`).

2. Tweak loading has separate main and renderer paths.
   - Main discovers tweaks and starts main-scope tweaks (`packages/runtime/src/main.ts:632-678`).
   - Renderer host asks main for tweak list and user paths, then loads renderer-scope tweaks (`packages/runtime/src/preload/tweak-host.ts:53-85`).
   - Runtime reload stops main tweaks, clears module cache, reloads, and broadcasts (`packages/runtime/src/tweak-lifecycle.ts:19-36`, `packages/runtime/src/main.ts:591-610`).

3. MCP sync is already conservative but not visible.
   - Managed block markers are explicit (`packages/runtime/src/mcp-sync.ts:5-6`).
   - Manual server names are detected after stripping managed content (`packages/runtime/src/mcp-sync.ts:45-68`, `packages/runtime/src/mcp-sync.ts:89-114`).
   - Relative commands/args are resolved against tweak directories (`packages/runtime/src/mcp-sync.ts:141-170`).

4. Safe mode is effective but discoverability is weak.
   - Safe mode is a persisted config flag (`packages/runtime/src/main.ts:69-78`).
   - Runtime suppresses all tweak enablement when safe mode is true (`packages/runtime/src/main.ts:125-131`).
   - CLI supports `safe-mode --on`, `--off`, and `--status` (`packages/installer/src/cli.ts:152-158`, `packages/installer/src/commands/safe-mode.ts:22-49`).

5. Repair UX already has robust backend concepts.
   - `doctor` checks user dir, install state, app presence, asar hash, signature, and key directories (`packages/installer/src/commands/doctor.ts:15-82`).
   - `repair` preserves user config and tweaks, refreshes watcher, waits for app updates to settle, respects auto-update, and can postpone when Codex is running (`packages/installer/src/commands/repair.ts:30-147`, `packages/installer/src/commands/repair.ts:167-177`, `packages/installer/src/commands/repair.ts:179-220`).
   - Watcher health already summarizes state for in-app display (`packages/runtime/src/watcher-health.ts:38-89`, `packages/runtime/src/watcher-health.ts:209-233`).

6. Security posture should stay local-first and review-first.
   - Default tweak updates are advisory, not automatic (`README.md:139-145`, `docs/ARCHITECTURE.md:37-42`).
   - Security docs explicitly warn that renderer and main-process tweaks are local code with real capabilities (`SECURITY.md:20-26`).
   - Renderer file access is sandboxed through IPC and per-tweak data dirs (`packages/runtime/src/main.ts:535-552`, `packages/runtime/src/preload/tweak-host.ts:248-258`).

7. Documentation drift is a product risk.
   - Current settings injector comments describe a routed settings page with sidebar label matching (`packages/runtime/src/preload/settings-injector.ts:1-21`).
   - Architecture docs still describe Radix dialog/tablist injection (`docs/ARCHITECTURE.md:72-75`).
   - Any onboarding or Settings roadmap should include a docs correction slice before another agent builds against stale DOM assumptions.

## 5. Suggested Next Slice

1. Implement Recovery Center v1 behind a local Codex++ feature flag.
   - Write set for a future worker:
     - `packages/runtime/src/main.ts`
     - `packages/runtime/src/preload/settings-injector.ts`
     - `packages/runtime/src/watcher-health.ts` if diagnostics need richer fields
     - focused tests under `packages/runtime/test/`
   - Keep installer command behavior unchanged in v1; UI can copy commands or call read-only diagnostics first.
   - Add UI rows:
     - Safe Mode toggle.
     - Doctor summary with "Copy Diagnostics".
     - Watcher summary with current detail rows.
     - Repair CTA that starts as "Copy repair command" unless/until a safe IPC command runner is designed.
     - Managed MCP summary with skipped/manual collisions.
   - Acceptance checks:
     - `npm run test --workspace @codex-plusplus/runtime`
     - targeted tests for safe-mode config read/write and MCP summary derivation
     - manual screenshot of Config page with safe mode off/on and watcher status

2. Then implement Tweak Diagnostics v1.
   - Write set for a future worker:
     - `packages/runtime/src/tweak-discovery.ts`
     - `packages/sdk/src/index.ts` only if validator output needs extra issue codes
     - `packages/runtime/src/preload/settings-injector.ts`
     - tests under `packages/runtime/test/tweak-discovery.test.ts` and `packages/sdk/test/manifest-validation.test.ts`
   - Acceptance checks:
     - invalid JSON, missing `githubRepo`, bad scope, missing entry, and valid tweak fixtures all render distinct states.
     - Existing valid tweak behavior remains unchanged.

3. Follow with Config Service v1 only after the UI proves the shape.
   - Write set for a future worker:
     - new runtime config module
     - new installer shared config helper if CLI and runtime should share it
     - MCP sync tests that prove manual TOML content is preserved
   - Acceptance checks:
     - config writes are atomic.
     - backups are created before touching `~/.codex/config.toml`.
     - env values are never rendered in diagnostics unless explicitly revealed.
