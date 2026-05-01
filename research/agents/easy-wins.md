# Codex++ Easy Wins

Scope: product-wise easy wins for Codex++ on the current local Codex Desktop shape. This note is ordered by what can ship fastest with the least dependence on brittle native Desktop internals.

Current local baseline:

- Codex.app is installed as `26.429.20946` (`plutil -p /Applications/Codex.app/Contents/Info.plist` showed `CFBundleShortVersionString => 26.429.20946`).
- The repo research context says the embedded app-server is `codex-cli 0.128.0-alpha.1` and includes the `goals` feature flag. See `research/README.md:20-29`.
- The product is still alpha; the README says installer needs real-device testing before declaring victory. See `README.md:7`.

## Immediate Wins

1. Ship a "Project Snapshot" page in Settings.
   - Behavior: show current repo root, branch/head, dirty count, changed file count, insertions/deletions, ahead/behind, and linked worktrees.
   - Why now: the metadata-only provider and tweak permission already exist. This is visible value without mutating repos or parsing raw diffs in the renderer.
   - Product edge: Codex Desktop users routinely lose track of which worktree/thread they are in; a compact status card reduces wrong-branch and dirty-worktree mistakes.
   - Effort: small to medium. Impact: high. Confidence: high.
   - Dependency: Codex++ runtime seam.

2. Ship `/goal` as a guarded Desktop command.
   - Behavior: typing `/goal <objective>` in the composer creates or updates the thread goal, shows a small status panel, and lets the user pause, complete, or clear it.
   - Why now: the preload feature already parses `/goal`, calls `thread/goal/*`, listens for goal notifications, and handles old app-server builds quietly.
   - Product edge: Codex++ can make the hidden app-server goal primitive user-facing before Codex Desktop exposes it natively.
   - Effort: small if the current in-flight implementation is stabilized and gated. Impact: high. Confidence: medium.
   - Dependency: app-server protocol.

3. Add a "Usage and Cost" page backed by the existing Codex session store.
   - Behavior: daily/hourly tokens, model split, estimated API-equivalent cost, and current-thread burn when available.
   - Why now: prior local evidence shows Codex Desktop writes to the shared `~/.codex/sessions/**/*.jsonl` store with `originator:"Codex Desktop"`. This can be implemented as read-only aggregation from main process with byte/time caps.
   - Product edge: Codex Desktop still has weak feedback on spend and context burn; Codex++ can expose this without touching the app-server critical path.
   - Effort: medium. Impact: high. Confidence: medium-high.
   - Dependency: native Codex session files plus Codex++ runtime seam.

4. Turn MCP-backed tweaks into a first-class install story.
   - Behavior: a tweak can declare an MCP server, Codex++ syncs a managed block into `~/.codex/config.toml`, and Settings explains which tools were added.
   - Why now: manifest support and managed MCP config sync already exist. The missing product layer is discoverability, validation, and in-app status.
   - Product edge: Codex++ becomes a real extension system, not just DOM patches.
   - Effort: small to medium. Impact: high. Confidence: high.
   - Dependency: Codex++ runtime seam plus external tweak releases.

5. Add an "Inspect Current Desktop" support panel.
   - Behavior: show Codex version, Codex++ version, patch status, watcher health, preload status, app-server availability, and last loader/main/preload log lines.
   - Why now: the repo already has watcher health, capped logs, config UI, and repair/status commands. Users need one screen to answer "is Codex++ actually loaded?"
   - Product edge: this directly attacks the alpha support burden: patched Electron apps fail in opaque ways.
   - Effort: small. Impact: medium-high. Confidence: high.
   - Dependency: Codex++ runtime seam.

6. Add a debug attach mode that is explicit, temporary, and visible.
   - Behavior: Settings or CLI can restart Codex with `CODEXPP_REMOTE_DEBUG=1`, show the selected port, and display the `/json` attach URL.
   - Why now: Codex production disables in-window DevTools, but Chromium remote debugging works via the command-line switch before app init.
   - Product edge: gives maintainers and power users browser-grade diagnostics without requiring permanent devtools or source patching.
   - Effort: small. Impact: medium. Confidence: high.
   - Dependency: native Codex seam plus Codex++ runtime seam.

7. Package a TypeScript tweak starter that actually bundles.
   - Behavior: `codexplusplus create-tweak --template ts` produces a buildable tweak with SDK types, manifest validation, and one command to install/reload.
   - Why now: the runtime does not transpile TypeScript and renderer tweaks must bundle dependencies. A starter removes the most common authoring trap.
   - Product edge: increases tweak ecosystem throughput without widening runtime permissions.
   - Effort: small. Impact: medium. Confidence: high.
   - Dependency: Codex++ SDK/installer seam.

8. Add stale-update and broken-update explanation to the in-app Config page.
   - Behavior: if Sparkle or Codex++ self-update is in progress, explain whether the open window is still running old code and what restart/repair action is needed.
   - Why now: release history already added update-mode status, watcher health, restart prompts, and safer Sparkle restoration.
   - Product edge: prevents users from assuming a repair failed when only the currently open Electron process is stale.
   - Effort: small. Impact: medium. Confidence: high.
   - Dependency: Codex++ installer/runtime seam.

9. Add a "safe defaults" permission review card for every tweak.
   - Behavior: Settings lists declared permissions, entry existence, update source, MCP server declarations, and whether git/file APIs are available.
   - Why now: permissions metadata, manifest validation, update checks, and MCP declarations exist, but the current manager still presents mostly name/version/load state.
   - Product edge: builds trust around an extension system that evaluates local tweak code.
   - Effort: small. Impact: medium. Confidence: high.
   - Dependency: Codex++ runtime seam.

10. Ship route-aware default tweak pages instead of only rows inside "Tweaks".
    - Behavior: large tweaks can register dedicated Settings sidebar pages with icons and their own surfaces.
    - Why now: the SDK already exposes `settings.registerPage`, and the injector already creates a tweak pages group.
    - Product edge: lets Codex++ ship substantial features without cramming everything into one manager section.
    - Effort: small. Impact: medium. Confidence: high.
    - Dependency: Codex++ runtime seam.

## Implementation Seams

- Additive preload: runtime registers its preload with `session.setPreloads()` so Codex's own preload still runs. This is the safest default injection seam. Evidence: `docs/ARCHITECTURE.md:60-71`, `docs/ARCHITECTURE.md:95-97`.
- Settings injection: current Desktop settings is a routed page with weak selectors, so injection must use DOM observation and text/content heuristics rather than stable test IDs. Evidence: `packages/runtime/src/preload/settings-injector.ts:1-21`, `packages/runtime/src/preload/settings-injector.ts:169-201`.
- Renderer constraint: the renderer is sandboxed, cannot use Node fs, and cannot require arbitrary tweak files. Tweak source is fetched from main and evaluated in preload; dependencies must be bundled. Evidence: `packages/runtime/src/preload/tweak-host.ts:1-13`, `packages/runtime/src/preload/tweak-host.ts:104-130`.
- Main-process tweak seam: main-scoped tweaks get disk storage, namespaced IPC, filesystem helpers, git metadata, and a native Codex API. Evidence: `packages/runtime/src/main.ts:647-667`.
- Git metadata seam: main process owns bounded `git` subprocesses; renderer receives structured metadata only. Evidence: `docs/GIT_METADATA_SIDEBAR.md:23-49`, `packages/runtime/src/git-metadata.ts:154-249`.
- App-server seam: preload can send `codex_desktop:message-from-view` MCP-shaped requests and subscribe to `codex_desktop:message-for-view` responses/notifications. Evidence: `packages/runtime/src/preload/app-server-bridge.ts:1-66`, `packages/runtime/src/preload/app-server-bridge.ts:86-174`.
- Goal seam: `/goal` already maps composer text to `thread/goal/set`, `thread/goal/get`, update notifications, and status actions. Evidence: `packages/runtime/src/preload/goal-feature.ts:36-78`, `packages/runtime/src/preload/goal-feature.ts:187-231`, `packages/runtime/src/preload/goal-feature.ts:255-272`.
- MCP seam: enabled tweaks can contribute managed MCP server entries without overwriting user-managed servers. Evidence: `packages/runtime/src/main.ts:680-698`, `packages/runtime/src/mcp-sync.ts:26-43`, `packages/runtime/src/mcp-sync.ts:47-80`.
- Native window seam: main tweaks can ask Codex's window services to create registered BrowserViews/windows, but this depends on a minified-fingerprint patch staying valid. Evidence: `packages/installer/src/codex-window-services.ts:17-30`, `packages/runtime/src/main.ts:907-988`.
- Update/repair seam: Codex updates overwrite the patch; watcher repair is expected to reapply it. Evidence: `docs/ARCHITECTURE.md:99-107`.
- Debug seam: production Codex disables in-window DevTools, but Codex++ can enable Chromium remote debugging before app ready via env. Evidence: `packages/runtime/src/main.ts:53-67`.

## Current Desktop Constraints

- App bundle mutation is inherently fragile. Codex++ patches `app.asar`, updates Electron asar integrity metadata, flips the embedded asar fuse as a safety net, and ad-hoc re-signs the app. Evidence: `README.md:46-55`.
- Official Codex updates conflict with a patched/ad-hoc signed app. The documented flow restores a Developer ID signed Codex.app before Sparkle updates, then relies on watcher repair. Evidence: `README.md:80-90`, `docs/ARCHITECTURE.md:99-113`.
- Codex's renderer bundle is not a friendly extension target. The architecture notes say it is a Vite/Rollup single-entry build with no exposed module registry, so source string-patching is brittle. Evidence: `docs/ARCHITECTURE.md:87-89`.
- Settings DOM can drift across Codex releases. The documented fallback is console warning and missing settings UI until heuristics are updated. Evidence: `docs/ARCHITECTURE.md:117-121`, `docs/TROUBLESHOOTING.md:40-45`.
- Renderer code must assume sandboxing. Filesystem, git, and tweak source reads should remain main-process IPC services with timeouts and caps. Evidence: `packages/runtime/src/preload/index.ts:19-24`, `packages/runtime/src/preload/tweak-host.ts:248-258`.
- App-server methods and feature flags are version-bound. `/goal` should degrade quietly on older builds and only show actionable errors after explicit user invocation. Evidence: `research/README.md:20-29`, `packages/runtime/src/preload/goal-feature.ts:226-230`.
- Native window services are useful but less stable than Settings/preload/app-server seams because the installer has to fingerprint minified Desktop code. Evidence: `packages/installer/src/codex-window-services.ts:16-30`, `CHANGELOG.md:49-52`.

## Effort / Impact / Confidence

| Rank | Win | Effort | Impact | Confidence | Primary seam |
|---:|---|---|---|---|---|
| 1 | Project Snapshot page | small/medium | high | high | Git metadata API + settings page |
| 2 | Guarded `/goal` command | small | high | medium | app-server protocol |
| 3 | Usage and Cost page | medium | high | medium-high | session JSONL + main IPC |
| 4 | MCP-backed tweak install/status | small/medium | high | high | manifest MCP sync |
| 5 | Inspect Current Desktop panel | small | medium-high | high | status/log/watcher APIs |
| 6 | Temporary debug attach mode | small | medium | high | env-gated remote debugging |
| 7 | Buildable TS tweak starter | small | medium | high | installer + SDK |
| 8 | Stale-update explanations | small | medium | high | watcher/update-mode state |
| 9 | Permission review card | small | medium | high | manifest validation |
| 10 | Dedicated tweak pages | small | medium | high | `settings.registerPage` |

## Evidence Anchors

- Product alpha and install mechanics: `README.md:5-15`, `README.md:46-58`, `README.md:147-168`.
- Current repo research context: `research/README.md:20-29`.
- Architecture boot path and constraints: `docs/ARCHITECTURE.md:47-75`, `docs/ARCHITECTURE.md:77-121`.
- Tweak authoring and API surface: `docs/WRITING-TWEAKS.md:49-76`, `docs/WRITING-TWEAKS.md:128-144`, `docs/WRITING-TWEAKS.md:159-177`.
- SDK permissions and settings pages: `packages/sdk/src/index.ts:64-83`, `packages/sdk/src/index.ts:300-341`.
- Runtime preload and hot reload: `packages/runtime/src/preload/index.ts:1-17`, `packages/runtime/src/preload/index.ts:67-103`.
- Renderer execution model: `packages/runtime/src/preload/tweak-host.ts:1-13`, `packages/runtime/src/preload/tweak-host.ts:104-130`, `packages/runtime/src/preload/tweak-host.ts:160-218`.
- Git provider and plan: `packages/runtime/src/git-metadata.ts:154-249`, `docs/GIT_METADATA_SIDEBAR.md:23-111`.
- App-server bridge and goal feature: `packages/runtime/src/preload/app-server-bridge.ts:29-66`, `packages/runtime/src/preload/app-server-bridge.ts:86-174`, `packages/runtime/src/preload/goal-feature.ts:36-78`.
- MCP sync: `packages/runtime/src/mcp-sync.ts:26-43`, `packages/runtime/test/mcp-sync.test.ts:68-133`.
- Existing test coverage for git metadata and lifecycle reload: `packages/runtime/test/git-metadata.test.ts:9-153`, `packages/runtime/test/main-toggle-reload.test.ts:24-98`.

## Next 3 Shippable Slices

1. Project Snapshot default page.
   - Ship target: one built-in Codex++ page under Settings that renders repo status for a chosen/current project path.
   - Scope:
     - Use `api.git.getStatus`, `api.git.getDiffSummary`, and `api.git.getWorktrees`.
     - Start with a stored path picker if current-thread project path extraction is not reliable yet.
     - Render branch/head, dirty counts, changed files, insertions/deletions, and worktree list.
     - Keep mutations out of scope.
   - Acceptance:
     - Works on clean repo, dirty repo, detached HEAD, non-repo path, and linked worktree.
     - Uses existing metadata-only API; no raw file contents or diff hunks.
     - Includes desktop/narrow screenshots because this is visible UI.

2. Guarded `/goal` MVP.
   - Ship target: `/goal` composer command plus status panel behind an explicit Codex++ config flag and feature detection.
   - Scope:
     - Keep current app-server calls to `thread/goal/set`, `thread/goal/get`, status update, and clear.
     - Add one visible "unsupported on this Codex build" state only after the user types `/goal`.
     - Avoid assuming every Desktop build has the `goals` flag.
   - Acceptance:
     - On current `26.429.20946` baseline, set/get/update/clear works against a real thread.
     - On unsupported app-server response, the UI fails closed and does not spam panels on route changes.
     - Include a short screen recording or screenshots of command suggestion, active goal, and complete/clear.

3. Usage and Cost read-only panel.
   - Ship target: a Codex++ Settings page that aggregates local session JSONL into daily/hourly usage and model-level estimates.
   - Scope:
     - Main process reads bounded chunks from `~/.codex/sessions/**/*.jsonl`.
     - Renderer receives aggregate rows only.
     - Price table must mark unknown pricing as unavailable rather than guessing.
     - Start with local-only totals; thread-specific attribution can be a follow-up.
   - Acceptance:
     - Handles missing session dir, malformed lines, very large files, and unknown models.
     - Shows partial/unavailable pricing explicitly.
     - Cross-check one sample day against a known `clanker-stats --daily-stats --api-cost --by-model` run or equivalent local script.
