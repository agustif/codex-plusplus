# Reverse-Engineering Product Opportunities

Scope: research lane only. This maps Codex++ reverse-engineering and
instrumentation seams into native-feeling product surfaces. It does not propose
editing product code in this lane.

Date: 2026-05-01.

## Product Thesis

Codex++ can turn low-level reverse-engineering into product value when it keeps
three boundaries clear:

1. Capture first-party events at owned seams before decoding private internals:
   preload boot, app-server bridge, app-server stdio tap, HMR reload, watcher
   health, patch manager, self-MCP tools, git metadata, and local process state.
2. Show redacted shapes and timings by default, not raw prompts, tool arguments,
   secrets, or message bodies.
3. Treat mutating controls as supervised operations with command previews,
   rollback paths, and acceptance checks. Read-only inspection should ship
   before "fix it for me" buttons.

## Current Instrumentation Inventory

| Surface | Existing seam | Product value |
| --- | --- | --- |
| App-server bridge | `packages/runtime/src/preload/app-server-bridge.ts` sends `mcp-request`, receives responses and notifications, tracks request ids and 12s timeouts. | Request timeline, protocol catalog, stuck request debugger, feature capability probes. |
| App-server flow tap | `packages/runtime/src/app-server-flow-tap.ts` can wrap `child_process` spawns of `codex app-server`, tap stdin/stdout/stderr, summarize JSON-RPC lines, and write capped logs. | Live protocol timeline that sees messages outside Codex++-initiated calls. |
| Runtime logs | `packages/runtime/src/logging.ts`, `main.ts`, preload boot, tweak host, and watcher health already emit useful stages. | In-app log console, error inbox, health strip. |
| Patch and update state | `packages/runtime/src/patch-manager.ts`, `watcher-health.ts`, installer `status`, `repair`, `update-codex`. | Update hijack monitor, rollback/restart dashboard, channel health. |
| HMR and runtime apply | README and architecture docs describe `dev-runtime`, reload marker, preload reload, and `--restart` rollback loop. | HMR status page, candidate/stable runtime panel, restart proof. |
| Self-modification tools | `packages/runtime/src/self-mcp-server.ts` exposes status, list/search/read/write, git apply, shell, runtime apply, and MCP restart. | Self-mod tool panel with scoped status, diff preview, apply/restart buttons. |
| Git metadata | `packages/runtime/src/git-metadata.ts` and research roadmap already treat repo state as a platform capability. | Turn inspector context, process tree cwd mapping, rollback dashboard evidence. |
| Native UI mounting | Settings injection, overlay helpers, React hook, and private window/view services. | Native debug pages without competing with the chat transcript. |

## Ordered Easy Wins

### 1. Live Protocol Timeline

- Impact: very high.
- Effort: small to medium.
- Confidence: high.
- Primary seams: app-server bridge, app-server flow tap.
- Native UI home: Settings -> Codex++ -> Protocol.

Ship a redacted waterfall of app-server requests, responses, errors,
notifications, stdio direction, host id, request id, method, duration, status,
thread id, turn id, and timeout state. Start with Codex++-initiated bridge
traffic, then fold in `app-server-flow-tap` events when enabled.

Why first: it explains the most valuable class of failure: "Codex is thinking,
but which protocol edge is actually stuck?"

Acceptance checks:

- A `/goal` get/set/clear call appears with method, request id, host id,
  duration, and success/error state.
- A timed-out app-server request renders as `timeout` with the configured
  timeout value and no raw params.
- Notifications render even when the method is unknown; payload display is
  limited to depth-bounded key/type/array-length shapes.
- Flow-tap mode shows stdin/stdout/stderr sequence numbers and child pid without
  requiring a Codex restart when the tap is already installed.
- Exported evidence is redacted and capped; no prompt text, secret-like values,
  full tool arguments, or unbounded JSON dumps are copied.

### 2. Stuck Turn Debugger

- Impact: very high.
- Effort: medium.
- Confidence: medium-high.
- Primary seams: protocol timeline, app-server notifications, goal telemetry,
  local JSONL/log summaries.
- Native UI home: thread header chip plus Settings detail page.

Build a "why is this turn stuck?" view keyed by current thread/turn. It should
show latest turn lifecycle notification, last agent/message delta, pending
app-server requests, command/tool activity, token usage update age, last output
age, and whether the app-server child is still alive.

Acceptance checks:

- While a turn is active, the panel identifies the current thread id and newest
  known turn id from route/app-server data.
- A turn with no app-server output for a threshold shows `no protocol activity
  for N seconds`, not a generic error.
- Pending requests list method, age, and timeout deadline.
- A completed turn clears the stuck warning and records completion time.
- The debugger can generate a compact handoff block with thread id, turn id,
  last activity, pending requests, and recent redacted errors.

### 3. HMR Status

- Impact: high.
- Effort: small.
- Confidence: high.
- Primary seams: runtime reload marker, preload reload logs, runtime manifest,
  `dev-runtime` behavior.
- Native UI home: Settings -> Codex++ -> Dev.

Show whether the current runtime bundle matches the staged dev runtime, whether
preload HMR is idle/reloading/failed, when the renderer last reloaded, which
files changed, and whether main-process changes require restart.

Acceptance checks:

- Editing/rebuilding `preload.js` updates last reload time and marks the current
  renderer as booted after reload.
- Editing `main.js` or self-MCP files shows "restart required" instead of
  implying renderer reload is enough.
- The page distinguishes Stable and Beta homes, including configured CDP ports.
- A failed reload links to the relevant main/preload log tail.

### 4. Update Hijack Monitor

- Impact: high.
- Effort: small to medium.
- Confidence: high.
- Primary seams: `patch-manager.ts`, `watcher-health.ts`, installer state,
  watcher log.
- Native UI home: Settings -> Codex++ -> Recovery.

Turn patch/update drift into a visible state machine: healthy, official update
mode, watcher missing, app drifted, runtime stale, patched-on-disk but runtime
not observed, repair failed, safe mode.

Acceptance checks:

- Stable and Beta show separate Codex version, app root, user root, watcher
  label, watcher loaded state, runtime preload existence, auto-update setting,
  CDP active port, and drift state.
- When watcher checks fail, the UI names the failing check and command path
  rather than only showing `repair needed`.
- Update mode shows expiry time and next action.
- The monitor surfaces "patched on disk, runtime heartbeat missing" as a
  separate state once heartbeat exists.

### 5. Rollback / Restart Dashboard

- Impact: high.
- Effort: medium.
- Confidence: high.
- Primary seams: `dev-runtime --restart`, `codexpp_self_runtime_apply`,
  patch manager CDP health, runtime backup.
- Native UI home: Settings -> Codex++ -> Recovery or Dev.

Expose the candidate/stable runtime state in a supervised dashboard: current
bundle hash, candidate hash, backup path, last apply result, CDP health probe,
restore command, and restart command preview.

Acceptance checks:

- "Restart with candidate" shows the exact command and target channel before
  execution.
- Successful restart records CDP `/json/version` proof and current runtime
  manifest/hash.
- Failed restart restores the prior runtime and records the failure reason.
- The dashboard can copy a reviewer-ready proof block containing command,
  result, active app version, active port, and rollback status.

### 6. Thread / Turn Inspector

- Impact: high.
- Effort: medium.
- Confidence: medium.
- Primary seams: app-server protocol catalog, current route parsing, observed
  notifications, goal feature thread-id extraction.
- Native UI home: right-side inspector later; Settings page first.

Create a read-only inspector for current and recent threads: current route,
thread id, loaded thread list when available, turn list when available, turn
status changes, token usage updates, active goal, and recent app-server methods
touching that thread.

Acceptance checks:

- Current thread id is derived from route/history/app-server evidence and shown
  with confidence level.
- Turn list falls back cleanly when `thread/turns/list` is unavailable.
- Inspector never renders raw transcript text by default.
- A "copy handoff skeleton" action includes cwd/repo when available, thread id,
  active goal, last turn status, changed-file summary, and next actions.

### 7. CDP Console

- Impact: high.
- Effort: medium.
- Confidence: medium-high.
- Primary seams: CDP port config in patch manager, remote debugging launch,
  `/json/list` and `/json/version`.
- Native UI home: Settings -> Codex++ -> Dev.

Build a local developer console for attached Codex renderer targets: list
targets, inspect URL/title, show console errors/warnings, evaluate read-only
snippets from a curated library, and link to DevTools.

Acceptance checks:

- Stable and Beta target lists are discovered from their configured/default CDP
  ports.
- Console messages are grouped by target and timestamp.
- Curated probes run read-only checks such as composer exists, Codex++ style
  tag exists, settings root exists, and goal roots exist.
- Arbitrary evaluation is either absent in v1 or clearly gated as destructive
  developer mode.

### 8. Process Tree

- Impact: medium-high.
- Effort: medium.
- Confidence: medium.
- Primary seams: app-server flow tap pids, Node/Electron process inspection,
  command exec notifications.
- Native UI home: Settings -> Codex++ -> Processes.

Show Codex main process, renderer targets, app-server child, command exec
children when observable, self-MCP launcher/worker, watcher job, and runtime
apply subprocesses. Use it to connect hung turns to live child processes.

Acceptance checks:

- The app-server child pid from flow tap appears with spawn time, args summary,
  and active/inactive state.
- Self-MCP launcher and worker are distinguished when env markers are visible.
- Watcher process/job status is linked to watcher health.
- Process args are redacted and truncated; environment values are never shown
  by default.

### 9. App-Server DB Browser

- Impact: medium-high.
- Effort: research to medium.
- Confidence: low-medium until storage location is proven.
- Primary seams: app-server config/cache paths, thread APIs, local Codex state,
  filesystem read-only browse.
- Native UI home: Settings -> Codex++ -> Data.

Start as a "data source browser" rather than assuming a single DB. Catalog
known local Codex state locations, cache files, app tool schemas, config layers,
thread metadata APIs, and any discovered SQLite/JSONL stores. Only add a DB
browser after the storage engine and privacy boundary are confirmed.

Acceptance checks:

- v1 lists known data sources with path, kind, size, mtime, and privacy label.
- JSON/schema caches can be inspected by key/type shape, not full values.
- Any SQLite browsing is read-only, opens a copied snapshot, and hides prompt
  and message columns by default.
- The page documents whether a datum came from app-server API, config file,
  cache file, or inferred filesystem scan.

### 10. Self-Mod Tool Panel

- Impact: medium-high.
- Effort: medium.
- Confidence: high.
- Primary seams: `codexpp-self` MCP tools and runtime apply.
- Native UI home: Settings -> Codex++ -> Self.

Expose self-modification as an observable control plane, not a raw shell box:
configured root, git status, pending diff, last shell command summary, last
runtime apply, MCP worker generation, and restart/apply actions.

Acceptance checks:

- The panel shows configured root, git branch, dirty files, user root, installer
  CLI path, launcher status, and worker id.
- Write/apply/shell actions require explicit developer-mode enablement and show
  command/diff preview.
- Runtime apply uses the same rollback/restart proof as the dashboard.
- The panel refuses to show or persist raw secret-like output in history.

## Wild Ideas

### 1. Native Run Ledger

Correlate protocol events, thread/turn state, tool calls, git changes, command
output deltas, screenshots, subagent reports, HMR reloads, and final evidence
into a replayable local ledger. This is the natural product layer above the
timeline and stuck debugger.

Acceptance checks:

- Each ledger entry has timestamp, source, thread/turn id when known, redacted
  payload shape, and evidence links.
- File-change events store paths and diff stats by default, not full diffs.
- A run can export a compact PR-proof summary with exact commands and results.

### 2. Protocol Method Catalog And Schema Sampler

Build a session-local catalog of all app-server request and notification
methods with counts, median latency, failure rate, sample redacted shapes, and
first/last seen time. This turns reverse-engineering into a maintained product
dataset.

Acceptance checks:

- Unknown methods remain visible without crashing decoders.
- Shape samples are depth-limited and redact value strings by default.
- Users can pin a method to watch in the timeline.

### 3. Turn-State Diff Viewer

For a selected turn, show what changed across notifications: status, plan,
token usage, file-change delta, command-output delta, tool-call progress, and
goal state. This is the thread inspector's power-user mode.

Acceptance checks:

- Diff view can be built entirely from captured event shapes.
- It handles missing intermediate events and labels gaps.
- It never requires raw transcript/message content to provide value.

### 4. Native Repair Assistant

Use the update monitor, CDP console, logs, and rollback dashboard to produce one
diagnosis and one next action: repair, reopen with CDP, update safely, restore
backup, disable auto-update, or collect bug bundle.

Acceptance checks:

- The assistant always cites the failing checks behind its recommendation.
- Destructive actions show exact commands and expected rollback.
- It can create a bug bundle with status, logs, versions, hashes, and redacted
  protocol timeline.

### 5. Worktree And Subagent Fleet Overlay

Combine git metadata, process tree, self-tools, and thread/turn inspector into
a fleet view for many Codex worktrees and agents. This is especially valuable
for Codex++ goals around parallel agent supervision.

Acceptance checks:

- Each worktree row shows branch, dirty count, linked thread, active process,
  current turn state, and validation status.
- The UI detects likely write-scope collisions by overlapping changed paths.
- Read-only inventory ships before create/delete worktree controls.

### 6. UI Hook Inspector

Use React hook/fiber metadata plus DOM anchors to discover composer, thread
header, settings, sidebar, popovers, and message rows. Store only component
names, owner chains, prop keys, and screenshot/probe proof.

Acceptance checks:

- Inspector can verify known anchors after a Codex update.
- Persisted data contains no props values unless explicitly opted in.
- A compatibility report lists changed/missing anchors.

## Moonshots

### 1. Replayable Agent Session Trace

Create a privacy-preserving replay of a Codex session: protocol events,
rendered UI states, screenshots, command output excerpts, git changes, HMR
events, tool-call progress, and final proof. This becomes the definitive
debugging and PR-review artifact.

Acceptance checks:

- A trace can replay timing and state transitions without raw prompt text.
- Redaction happens at capture time, not only during export.
- Trace export includes enough evidence to reproduce stuck-turn and update
  failures.

### 2. Meta-Supervisor Mode

Detect stale agents, missing validation, subagent report gaps, oversized tool
outputs, write-scope conflicts, unresolved review threads, and finalization
risk. Feed warnings back into the native UI while the work is still running.

Acceptance checks:

- Supervisor warnings cite the specific event/file/check that triggered them.
- It distinguishes "blocked", "stale", "waiting on child", and "ready to
  finalize".
- It can generate a bounded handoff when context-window risk rises.

### 3. Local Codex App-State Explorer

Reverse-engineer the local app-server persistence layer enough to browse thread
metadata, turn status, config layers, app/plugin/tool schemas, and cache
lineage from a single read-only explorer.

Acceptance checks:

- All sources are labeled by provenance and freshness.
- Browsing happens against snapshots or read-only APIs.
- Sensitive columns/fields require explicit reveal and are excluded from
  default exports.

### 4. Native Command And Tool Console

Augment Codex's own command palette/tool surfaces so Codex++ actions appear as
native commands: show timeline, inspect stuck turn, repair patch, restart with
candidate, copy handoff, open CDP target, attach trace.

Acceptance checks:

- Commands are discoverable from Codex's native command model, not a duplicate
  global palette.
- Each command declares permission, risk, and rollback behavior.
- Commands degrade gracefully when app-server or UI anchors change.

### 5. Compatibility Canary Control Room

For every new Codex Desktop build, run patch probes, runtime boot probes,
settings-injection probes, app-server feature probes, CDP smoke tests, and
screenshot checks. Publish a compatibility verdict consumed by the update
monitor.

Acceptance checks:

- Canary report includes Codex version/build, patch result, runtime heartbeat,
  protocol feature matrix, UI anchor status, screenshots, and known breakages.
- The local update monitor can warn before applying a risky official update.
- Failed canaries create actionable repair tasks, not just red status.

## Recommended Build Order

1. Live Protocol Timeline.
2. HMR Status.
3. Update Hijack Monitor.
4. Rollback / Restart Dashboard.
5. Stuck Turn Debugger.
6. Thread / Turn Inspector.
7. CDP Console.
8. Process Tree.
9. Self-Mod Tool Panel.
10. App-Server Data Source Browser.

This order front-loads existing owned seams and keeps destructive controls behind
observability. The first four also create the proof substrate needed for every
later debugger and supervisor surface.

## Cross-Cutting Acceptance Checks

- Privacy: default views show redacted method names, ids, timings, paths, byte
  counts, object key/type shapes, and statuses. Raw prompts, messages, secrets,
  env values, and full tool arguments require explicit reveal or are never
  captured.
- Boundedness: every log/protocol/process capture is ring-buffered or capped by
  bytes, count, and time.
- Provenance: every row says where it came from: bridge, flow tap, CDP, runtime
  log, watcher health, installer state, config file, git metadata, or self-MCP.
- Channel awareness: Stable and Beta states are separate by default.
- Read-only first: inspectors and dashboards ship before mutation buttons.
- Command preview: repair, restart, update, shell, git apply, and runtime apply
  actions show exact command/diff/channel before execution.
- Rollback: runtime apply and app restart paths must record backup location,
  health probe result, and restore result.
- Failure labels: show `unsupported`, `disabled`, `unavailable`, `timeout`,
  `stale`, `drift`, and `permission denied` distinctly.
- Evidence export: every surface can copy a compact reviewer/debugger block with
  exact timestamps, versions, commands, results, and redacted recent events.

