# Codex++ Observability Product Notes

## 1. Best immediate wins

### 1. In-app live log console

- Impact: high
- Effort: small
- Confidence: high
- Dependency: Codex++ runtime seam

Ship a first-class "Observability" page under the existing Codex++ settings group that tails `main.log`, `preload.log`, `loader.log`, and the platform watcher log. The current manager can only reveal the log directory, which is useful for bug reports but too slow for live debugging.

Evidence anchors:

- `packages/runtime/src/logging.ts:3-25` caps appended runtime log files at 10 MiB.
- `packages/runtime/src/main.ts:39-40` defines the runtime log directory and `main.log`.
- `packages/runtime/src/main.ts:527-532` forwards sandboxed preload log lines into `preload.log`.
- `packages/runtime/src/preload/index.ts:19-33` already emits preload boot stages via IPC.
- `packages/runtime/src/preload/settings-injector.ts:1100-1113` asks users to attach relevant log lines when filing a bug, but does not surface them inline.

Shippable slice:

1. Add a read-only IPC handler that returns the last N lines for known log files only.
2. Render a compact table with time, source, level, message, and "copy visible lines".
3. Poll every 1 to 2 seconds only while the page is visible.
4. Redact obvious tokens, absolute home subpaths behind `~`, and long base64/data URLs before display.

### 2. Runtime health strip

- Impact: high
- Effort: small
- Confidence: high
- Dependency: Codex++ runtime seam

Add a top-level runtime health strip showing whether the preload is registered, renderer boot completed, tweak host loaded, settings injector mounted, hot reload is idle, remote debug is enabled, and the app-server bridge has pending requests. This should be the "is Codex++ alive?" answer before the user reads raw logs.

Evidence anchors:

- `packages/runtime/src/main.ts:351-383` registers the preload and logs success or failure.
- `packages/runtime/src/main.ts:386-416` logs every `web-contents-created` event plus preload errors.
- `packages/runtime/src/preload/index.ts:67-80` has explicit boot stages and a boot failure path.
- `packages/runtime/src/preload/tweak-host.ts:53-84` loads renderer tweaks and logs the loaded tweak count.
- `packages/runtime/src/main.ts:591-610` supports manual reload plus debounced tweak reload.

Shippable slice:

1. Keep an in-memory `RuntimeHealthSnapshot` in main with `lastPreloadRegistration`, `lastWebContents`, `lastPreloadBoot`, `lastTweakHostLoad`, `lastReload`, and `lastError`.
2. Update the snapshot from existing log call sites before building a larger telemetry bus.
3. Expose it through `codexpp:get-runtime-health`.
4. Render one compact status row above the live logs.

### 3. App-server request timeline

- Impact: high
- Effort: medium
- Confidence: high
- Dependency: app-server protocol

Instrument Codex++ app-server calls at the bridge boundary. The bridge already sees method, host id, request id, request start, response, notifications, timeouts, and errors. A timeline here would explain "why did `/goal` hang?", "which app-server method is noisy?", and "what native Codex events did we receive?" without reverse-engineering every Codex internal route.

Evidence anchors:

- `packages/runtime/src/preload/app-server-bridge.ts:3-5` names Codex desktop message channels and the default 12 second timeout.
- `packages/runtime/src/preload/app-server-bridge.ts:29-65` creates app-server requests, assigns Codex++ request ids, tracks pending requests, and handles invoke failures.
- `packages/runtime/src/preload/app-server-bridge.ts:86-118` subscribes to app-server messages and resolves or rejects pending requests.
- `packages/runtime/src/preload/app-server-bridge.ts:155-173` normalizes notifications into `{ method, params }`.
- `packages/runtime/src/preload/goal-feature.ts:187-203` already uses `thread/goal/set` and `thread/goal/get`.

Shippable slice:

1. Add a renderer-local ring buffer in `app-server-bridge.ts` for request and notification events.
2. Store method, id, hostId, start/end time, duration, status, error message, and a redacted parameter shape.
3. Dispatch a DOM event or expose a debug getter consumed by the Observability page.
4. Show requests as a waterfall grouped by host id and method.

### 4. Goal token and budget telemetry

- Impact: high
- Effort: small
- Confidence: high
- Dependency: app-server protocol

Promote `/goal` token and elapsed-time fields from a transient panel into a persistent debug view. This gives Codex++ an immediate token/budget telemetry story without needing model-provider billing hooks.

Evidence anchors:

- `packages/runtime/src/preload/goal-feature.ts:3-14` defines `ThreadGoal` with `tokenBudget`, `tokensUsed`, and `timeUsedSeconds`.
- `packages/runtime/src/preload/goal-feature.ts:53-70` listens for `thread/goal/updated` and `thread/goal/cleared` notifications.
- `packages/runtime/src/preload/goal-feature.ts:255-264` renders current token usage and elapsed time in the goal panel.
- `research/README.md:22-27` records that the current patched Codex Desktop build exposes `codex-cli 0.128.0-alpha.1`, the `goals` flag, and `thread/goal/*` support.

Shippable slice:

1. Add the current goal to the runtime health snapshot.
2. Render budget used, budget remaining, elapsed time, and burn rate.
3. Add warning states at 75 percent and 95 percent budget usage.
4. Keep this per-thread and do not aggregate across projects until the underlying app-server contract is better understood.

### 5. Patch, update, and watcher health dashboard

- Impact: high
- Effort: small
- Confidence: high
- Dependency: Codex++ runtime seam

Unify CLI `status`, CLI `doctor`, in-app watcher health, and Codex++ self-update state into one patch health dashboard. Users should be able to answer "am I patched?", "will repair run after a Codex update?", "is update mode active?", and "what should I run next?" from the app.

Evidence anchors:

- `packages/runtime/src/watcher-health.ts:38-90` produces a structured watcher health summary from `state.json`, `config.json`, app path, and platform checks.
- `packages/runtime/src/watcher-health.ts:196-206` scans the watcher log tail for recent errors.
- `packages/runtime/src/preload/settings-injector.ts:736-743` already renders an Auto-Repair Watcher section.
- `packages/runtime/src/preload/settings-injector.ts:991-1043` renders watcher status and a "Check Now" action.
- `packages/installer/src/commands/status.ts:12-85` prints user dirs, install state, current app version, update mode, asar hash match, plist hash, and fuse state.
- `packages/installer/src/commands/doctor.ts:15-81` checks writable user dir, app presence, asar hash, code signature, and runtime/tweaks/log dirs.

Shippable slice:

1. Move the status/doctor facts into a shared JSON-producing health module instead of duplicating CLI-only output.
2. Extend `codexpp:get-watcher-health` or add `codexpp:get-patch-health`.
3. Render failed checks first with exact command suggestions: `codexplusplus repair`, `codexplusplus doctor`, or `codexplusplus update-codex`.
4. Include "last successful repair/runtime refresh" from `state.json`.

### 6. Error inbox

- Impact: medium
- Effort: small
- Confidence: high
- Dependency: Codex++ runtime seam

Collect main-process uncaught exceptions, preload boot failures, app-server timeout errors, tweak load failures, watcher failures, and update-check failures into a small deduped error inbox. This is more actionable than forcing users to scan four logs.

Evidence anchors:

- `packages/runtime/src/main.ts:263-269` logs main-process uncaught exceptions and unhandled rejections.
- `packages/runtime/src/preload/index.ts:78-80` logs preload boot failures.
- `packages/runtime/src/preload/tweak-host.ts:65-73` logs renderer tweak load failures.
- `packages/runtime/src/preload/app-server-bridge.ts:40-43` emits app-server request timeouts.
- `packages/runtime/src/preload/settings-injector.ts:823` logs Codex++ update-check failures.
- `packages/runtime/src/watcher-health.ts:200-205` detects watcher-log errors.

Shippable slice:

1. Parse recent known log files into normalized `ObservedError` records.
2. Deduplicate by source, message prefix, and stack top frame.
3. Render severity, first seen, last seen, count, and suggested next command.
4. Add "copy bug report bundle" with health snapshot plus redacted recent errors.

## 2. Medium bets

### 7. Tool-call timeline from app-server and renderer events

- Impact: high
- Effort: research
- Confidence: medium
- Dependency: app-server protocol

Build a timeline that correlates user prompt submission, app-server notifications, tool calls, filesystem mutations, git status changes, patch application, and renderer updates. Start with events Codex++ already owns, then add app-server notification decoders as real observed method names are cataloged.

Evidence anchors:

- `packages/runtime/src/preload/app-server-bridge.ts:155-173` can capture all notifications even before Codex++ understands their payloads.
- `packages/runtime/src/git-metadata.ts` exists as the local git metadata provider for file/worktree state.
- `docs/GIT_METADATA_SIDEBAR.md:80-87` explicitly wants status refresh on sidebar open, focus regain, route/thread change, and after Codex tool calls that write files.
- `packages/runtime/src/main.ts:845-856` broadcasts tweak reloads to all web contents.

Shippable slice:

1. Introduce an append-only local timeline store with event type, timestamp, thread id when known, host id, and redacted payload shape.
2. Emit first-party Codex++ events: boot, preload, tweak load, reload, app-server request/response, notification, git refresh, patch repair.
3. Render as a swimlane view: Renderer, Main, App-server, Tools, Git, Updater.
4. Add decoders only for observed app-server methods; unknown methods stay visible as raw method names with redacted shapes.

### 8. Optional OpenTelemetry export

- Impact: medium
- Effort: medium
- Confidence: medium
- Dependency: external service

Use a local-first event model that can later export to OpenTelemetry without making OTLP a required runtime dependency. This lets advanced users send Codex++ traces/logs/metrics to their own collector while keeping default installs private and offline.

Evidence anchors:

- OpenTelemetry JavaScript official docs describe generating and collecting traces, metrics, and logs in Node.js and browser contexts: https://opentelemetry.io/docs/languages/js/
- The official OTLP spec defines the encoding, transport, and delivery mechanism for telemetry between sources, collectors, and backends: https://opentelemetry.io/docs/specs/otlp/
- `packages/runtime/src/logging.ts:21-25` treats logging as best-effort and non-fatal, which should remain true for any exporter.
- `SECURITY.md:20` says tweaks are local code and Codex++ does not automatically install replacement code, so telemetry export should be opt-in and explicit.

Shippable slice:

1. Keep the internal event schema independent from OpenTelemetry packages.
2. Add a disabled-by-default exporter setting with `off`, `local-jsonl`, and `otlp-http` modes.
3. For `local-jsonl`, write newline-delimited redacted events under `<user-data-dir>/log/events.jsonl`.
4. For OTLP, require an explicit local endpoint and never export prompt content or raw tool arguments by default.

### 9. App-server protocol catalog

- Impact: medium
- Effort: medium
- Confidence: medium
- Dependency: app-server protocol

Add a debug-only catalog of app-server methods observed in the current session: request methods, notification methods, success/error counts, median latency, and sample redacted payload schemas. This helps future Codex++ features avoid guessing.

Evidence anchors:

- `packages/runtime/src/preload/app-server-bridge.ts:29-65` is the single request path for Codex++ initiated app-server calls.
- `packages/runtime/src/preload/app-server-bridge.ts:94-118` is the single response dispatch path.
- `packages/runtime/src/preload/app-server-bridge.ts:155-173` is the notification normalization path.

Shippable slice:

1. Count methods in memory for the current renderer session.
2. Show only key names, primitive types, array lengths, and object depth-limited shapes.
3. Add "copy schema sample" for research notes.
4. Persist nothing unless the user toggles "record protocol evidence".

### 10. Debug dashboard for tweak authors

- Impact: medium
- Effort: medium
- Confidence: high
- Dependency: Codex++ runtime seam

Make tweak authoring observable: lifecycle events, start/stop duration, load failure stack, declared permissions, storage size, registered settings pages, app-server calls made through Codex++ helpers, and git API calls.

Evidence anchors:

- `packages/sdk/src/index.ts:42-66` defines manifest capabilities including `permissions`, `scope`, `mcp`, and `git.metadata`.
- `packages/runtime/src/tweak-lifecycle.ts` owns reload, enable/disable, and lifecycle handling.
- `packages/runtime/src/preload/tweak-host.ts:104-123` evaluates renderer tweak code.
- `packages/runtime/src/main.ts:859-865` scopes main tweak logs by tweak id.

Shippable slice:

1. Emit `tweak.lifecycle` events around discovery, validation, start, stop, reload, and failure.
2. Add per-tweak "debug" expansion in the Tweaks page.
3. Show only local metadata by default; keep source code and user data out of the event stream.

## 3. Wild ideas or moonshots

### 11. Replayable agent session trace

- Impact: moonshot
- Effort: large
- Confidence: low
- Dependency: app-server protocol

Record a privacy-preserving trace of an agent run that can be replayed as a timeline: prompt submission, model stream phases, tool calls, patches, command outputs summaries, review events, and final response. The valuable version is not a screen recording; it is a structured event replay where sensitive payloads can be redacted at capture time.

Evidence anchors:

- `packages/runtime/src/preload/app-server-bridge.ts:52-55` shows Codex++ can send app-server MCP requests with ids.
- `packages/runtime/src/preload/app-server-bridge.ts:155-173` shows Codex++ can observe app-server notifications generically.
- `docs/GIT_METADATA_SIDEBAR.md:18-20` notes that the public app-server thread model is coarse today, so richer run replay depends on protocol discovery rather than current documented guarantees.

Shippable slice:

1. Start with Codex++ owned events only.
2. Add app-server notification capture behind a "record evidence" toggle.
3. Export a single redacted JSON trace plus an HTML viewer.

### 12. Patch/update black box recorder

- Impact: high
- Effort: large
- Confidence: medium
- Dependency: Codex++ runtime seam

When repair or self-update fails, preserve the exact health snapshot, command phase, version, app hash, state diff, watcher state, and tail logs as a single local diagnostic bundle. This is especially important because Codex++ modifies app bundles, signatures, fuses, launch agents, and runtime assets.

Evidence anchors:

- `packages/installer/src/commands/repair.ts:38-147` has multiple early returns and repair paths for update mode, intact patch, runtime refresh, running app, and full reinstall.
- `packages/installer/src/commands/self-update.ts:51-98` downloads source, installs dependencies, builds, swaps source roots, runs repair, and rolls back on failure.
- `packages/installer/src/watcher.ts:55-100` creates the macOS launchd watcher with stdout/stderr pointed at a watcher log.

Shippable slice:

1. Emit phase markers during repair and self-update.
2. On failure, write `<user-data-dir>/log/diagnostics/<timestamp>.json`.
3. Add an in-app "Diagnostic bundles" list with copy/reveal actions.

### 13. Health gates before dangerous actions

- Impact: medium
- Effort: medium
- Confidence: medium
- Dependency: Codex++ runtime seam

Before actions like Codex update mode, self-update, repair, tweak reload, or enabling remote debug, show a small health gate that says which checks passed, which are risky, and whether the action will touch the app bundle, runtime dir, tweak dirs, launch agents, or network.

Evidence anchors:

- `packages/runtime/src/main.ts:53-67` exposes remote debugging through environment variables.
- `packages/installer/src/commands/update-codex.ts:26-90` owns the official Codex update path.
- `packages/installer/src/commands/repair.ts:133-147` can rerun install and reopen/prompt Codex.
- `README.md:83-90` explains the Sparkle update constraint and `codexplusplus update-codex`.

Shippable slice:

1. Reuse patch health checks to classify action risk.
2. Require explicit confirmation only for app-bundle or network-touching actions.
3. Log every action decision as an observability event.

## 4. Constraints and exact evidence

- Codex++ lives outside the app bundle after initial patching, so observability should be implemented in the user-dir runtime first, not by source-patching Codex internals. Evidence: `docs/ARCHITECTURE.md:19-33`.
- Renderer code is sandboxed and cannot use Node fs directly, so log/timeline reads need main-process IPC. Evidence: `packages/runtime/src/preload/index.ts:19-23` and `packages/runtime/src/preload/tweak-host.ts:8-12`.
- Logging must stay best-effort and non-fatal. Evidence: `packages/runtime/src/logging.ts:21-25` and `packages/installer/src/logging.ts:15-21`.
- Any observability export must be opt-in, redacted, and local-first because this project runs inside a modified Codex desktop app and can see sensitive prompts, tool outputs, project paths, and repository state.
- App-server protocol work should preserve unknown messages rather than assuming stable names. Evidence: `packages/runtime/src/preload/app-server-bridge.ts:120-173` accepts several envelope shapes and generic notifications.
- Patch health is multi-layered: app bundle, asar hash, plist hash, Electron fuse, code signature, runtime assets, state file, watcher service, update mode, and running app state. Evidence: `packages/installer/src/commands/status.ts:12-85`, `packages/installer/src/commands/doctor.ts:15-81`, and `packages/runtime/src/watcher-health.ts:38-90`.
- Tweak observability cannot trust tweak code. Tweak source is evaluated from disk in renderer preload and should be treated as untrusted local code. Evidence: `packages/runtime/src/preload/tweak-host.ts:104-123` and `SECURITY.md:20`.

## 5. Suggested next slice

Build "Observability v0" as a runtime-owned page with no new required dependencies:

1. `codexpp:get-log-tail`: main IPC handler returning redacted tails for allowlisted log files.
2. `codexpp:get-runtime-health`: main IPC handler returning preload/tweak/reload/error snapshot.
3. `app-server-bridge` renderer ring buffer: request, response, timeout, error, and notification events.
4. Observability settings page: health strip, live logs, app-server timeline, error inbox.
5. Tests: capped log tail parsing, redaction, runtime health snapshot updates, app-server ring buffer behavior.
6. Manual proof: open Codex++ Config/Observability, force reload tweaks, run `/goal`, trigger an update check, and capture desktop plus narrow screenshots if the UI changes.

Keep the first PR read-only and local-only. Defer OTLP export, persisted traces, diagnostic bundles, and deep tool-call decoding until the page proves useful with the telemetry Codex++ already owns.
