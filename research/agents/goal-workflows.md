# Goal Workflows Product Notes

Scope: explore product possibilities around Codex `/goal` for Codex++ without changing runtime code. Ordered from shippable UX wins to protocol-level bets.

## 1. Best Immediate Wins

### 1. Goal Pill In The Thread Chrome

- Impact: high
- Effort: medium
- Confidence: high
- Dependency: Codex++ runtime seam + app-server protocol

Replace the current floating goal panel with a persistent, compact goal pill near the thread header or composer. The pill should show status, objective truncation, token usage, and elapsed time. Click opens the existing actions: Pause, Resume, Complete, Clear.

Why this should be first:

- The server already exposes the state needed for a pill: objective, status, tokenBudget, tokensUsed, timeUsedSeconds, createdAt, and updatedAt.
- The current UI already renders these fields, but as a bottom-right panel that can feel like a toast instead of durable thread state.
- A pill gives users continuous orientation without forcing them to run `/goal` repeatedly.

Evidence:

- Native generated `ThreadGoal` has `threadId`, `objective`, `status`, `tokenBudget`, `tokensUsed`, `timeUsedSeconds`, `createdAt`, and `updatedAt` from `codex app-server generate-ts --experimental --out <tmp>`.
- Codex++ mirrors that shape locally in `packages/runtime/src/preload/goal-feature.ts:3-14`.
- Current rendering already formats status, budget, and elapsed time in `packages/runtime/src/preload/goal-feature.ts:255-272`.
- Current panel is fixed at bottom-right with max z-index in `packages/runtime/src/preload/goal-feature.ts:470-590`, which is useful for a prototype but not a native-feeling thread affordance.

Implementation notes:

- Keep the current panel as the popover content.
- Move persistent display into a pill mounted near a stable route/thread container after DOM reconnaissance.
- Use the existing notification listener and route refresh path first; do not add a second state source for v1.
- Mobile/narrow layout must collapse to a status dot plus short objective.

### 2. Make `/goal` A Real Command Surface

- Impact: high
- Effort: small
- Confidence: high
- Dependency: Codex++ runtime seam + app-server protocol

Current grammar supports `/goal`, `/goal clear`, `/goal pause`, `/goal resume`, `/goal complete`, and `/goal <objective>`. Expand it to:

- `/goal set <objective>`
- `/goal budget 50000`
- `/goal budget none`
- `/goal status`
- `/goal done`
- `/goal clear`

Why this matters:

- `tokenBudget` is already in the protocol but currently not exposed by Codex++ commands.
- Users need predictable subcommands once `/goal` grows beyond a novelty.
- Aliases like `done` should map to `complete` because completion is a high-frequency action.

Evidence:

- Existing parser treats any non-keyword argument as a replacement objective in `packages/runtime/src/preload/goal-feature.ts:121-195`.
- Native generated `ThreadGoalSetParams` accepts optional `objective`, `status`, and `tokenBudget` from `codex app-server generate-ts --experimental --out <tmp>`.
- Status values are exactly `active`, `paused`, `budgetLimited`, and `complete` from generated `ThreadGoalStatus`.
- The `/goal` composer suggestion is already installed in `packages/runtime/src/preload/goal-feature.ts:397-453`.

Implementation notes:

- Parse explicitly before falling back to objective replacement.
- Keep backwards compatibility for `/goal <objective>`.
- Render validation errors in the existing panel path.
- Add tests for command parsing before touching DOM-heavy code.

### 3. Completion Reporting

- Impact: high
- Effort: small
- Confidence: high
- Dependency: app-server protocol

When a goal is marked complete, show a completion report instead of only re-rendering the goal state:

- objective
- final status
- elapsed time
- tokens used
- budget delta when tokenBudget is set
- copyable handoff text

Why this matters:

- Completion is the moment where the product can turn work into an auditable outcome.
- The data already exists in `ThreadGoal`; the missing piece is a focused report view.

Evidence:

- Current `complete` action calls `thread/goal/set` with status `complete` in `packages/runtime/src/preload/goal-feature.ts:165-174` and `packages/runtime/src/preload/goal-feature.ts:344-353`.
- `ThreadGoalUpdatedNotification` includes `turnId: string | null` in generated app-server bindings, which can later tie completion to the turn that changed state.
- Existing render path already formats token/time fields in `packages/runtime/src/preload/goal-feature.ts:255-263`.

Implementation notes:

- On status transition to `complete`, render a report variant with Copy Summary, Clear, and Resume.
- Keep report text local and deterministic; do not ask the model to summarize in v1.
- Later, attach changed files/checks if a git metadata sidebar lands.

### 4. Budget UX And Budget-Limited State

- Impact: high
- Effort: medium
- Confidence: medium
- Dependency: app-server protocol

Expose budget as a first-class goal control:

- set token budget when creating a goal
- edit budget from the pill menu
- show remaining tokens and percent used
- render `budgetLimited` as a blocking or warning state

Evidence:

- `ThreadGoal` includes `tokenBudget` and `tokensUsed`; current UI displays either `used tokens` or `used / budget tokens` in `packages/runtime/src/preload/goal-feature.ts:255-263`.
- The app-server status enum includes `budgetLimited`; Codex++ already labels it as `limited by budget` in `packages/runtime/src/preload/goal-feature.ts:694-704`.
- `ThreadGoalSetParams` includes `tokenBudget?: number | null` from generated app-server bindings.

Unknowns:

- I did not prove whether the app-server itself enforces tokenBudget or only stores it.
- I did not prove whether `budgetLimited` is set automatically by native runtime accounting or only by explicit status mutation.

Implementation notes:

- Treat budget as advisory until native enforcement is proven.
- Do not block user input purely in Codex++ v1; visually warn and offer Complete, Resume, or Increase Budget.
- Add app-server smoke tests before claiming native budget enforcement.

### 5. Feature Detection And Error States

- Impact: medium
- Effort: small
- Confidence: high
- Dependency: app-server protocol

Make the goal affordance self-gating:

- hide passive goal UI when app-server support is missing
- show a precise setup action when `goals` is disabled
- report experimentalApi negotiation errors separately

Evidence:

- Local config currently has `[features].goals = true` at `/Users/af/.codex/config.toml:38-47`.
- `codex features list` reports `goals under development true`.
- `codex --help` has no top-level `goal` command; this is an app-server/TUI feature, not a standalone CLI workflow.
- Existing Codex++ error mapper already distinguishes disabled goals, missing `experimentalApi`, and unsupported `thread/goal/*` in `packages/runtime/src/preload/goal-feature.ts:707-718`.
- Route refresh intentionally stays quiet on unsupported old app-server builds in `packages/runtime/src/preload/goal-feature.ts:206-230`.

Implementation notes:

- Add a cached `goalFeatureAvailable` state after first successful `thread/goal/get`.
- Do not spam app-server every 2.5s after a definitive unsupported error.
- Keep manual `/goal` attempts noisy and actionable.

## 2. Medium Bets

### 1. Thread Goal History

- Impact: high
- Effort: medium
- Confidence: medium
- Dependency: Codex++ runtime seam first, app-server protocol later

Build local thread goal history as an append-only Codex++ journal:

- created
- objective changed
- budget changed
- paused/resumed
- completed
- cleared

Why this is a Codex++ layer first:

- The generated app-server protocol exposes get, set, clear, updated notification, and cleared notification.
- It does not expose a goal history/list endpoint.
- Codex++ can record event history from notifications without requiring upstream changes.

Evidence:

- Current Codex++ listens for `thread/goal/updated` and `thread/goal/cleared` in `packages/runtime/src/preload/goal-feature.ts:53-70`.
- Generated `ThreadGoalUpdatedNotification` has `threadId`, `turnId`, and `goal`.
- Generated `ThreadGoalClearedNotification` has `threadId`.
- The bridge can receive notifications independent of request/response matching in `packages/runtime/src/preload/app-server-bridge.ts:94-118` and `packages/runtime/src/preload/app-server-bridge.ts:155-173`.

Implementation notes:

- Store only metadata by default: threadId, event type, timestamps, goal fields, and optional turnId.
- Do not store raw chat content.
- Reconcile on startup by calling `thread/goal/get` for the current thread and appending a synthetic snapshot only if the local journal has no current state.
- Later app-server ask: `thread/goal/history/list`.

### 2. Goal Templates

- Impact: medium
- Effort: medium
- Confidence: medium
- Dependency: Codex++ runtime seam

Add reusable templates for common work:

- "Fix CI on current PR"
- "Implement feature with tests"
- "Review pending PR"
- "Visual QA route"
- "Write research artifact"
- "Prepare handoff summary"

Template fields:

- objective text with variables
- default token budget
- optional reminder cadence
- completion report format

Evidence:

- Research scoring already expects ideas to carry Impact, Effort, Confidence, and Dependency in `research/README.md:11-18`.
- Codex++ tweak storage exists as a renderer API in `packages/runtime/src/preload/tweak-host.ts:1-20` and the broader runtime stores user preferences under `<user-data-dir>/config.json` per `docs/ARCHITECTURE.md:20-34`.
- `/goal` creation only needs `threadId`, `objective`, `status`, and optionally `tokenBudget`, so templates can stay client-side until the app-server has native support.

Implementation notes:

- Start with local JSON templates in Codex++ config or tweak-data.
- Offer template selection from the `/goal` suggestion popover once the user types `/goal `.
- Keep templates editable from Settings later, not in the first pill slice.

### 3. Goal Reminders

- Impact: medium
- Effort: medium
- Confidence: medium
- Dependency: Codex++ runtime seam

Add opt-in local reminders:

- "No progress for 15 minutes"
- "Budget 80% used"
- "Goal active across route/thread switch"
- "Goal still active at close/quit"

Evidence:

- Current feature already refreshes route state on popstate and every 2.5s in `packages/runtime/src/preload/goal-feature.ts:72-77`.
- App-server notifications can drive event-first updates through `onAppServerNotification` in `packages/runtime/src/preload/app-server-bridge.ts:68-74`.
- Token and time values are available on every `ThreadGoal`.

Implementation notes:

- Keep reminders local and dismissible.
- Do not fire reminders while a turn is actively producing output unless native turn status is wired in.
- Use notification-driven state first, then poll as a fallback.
- Later app-server ask: goal dueAt/reminderAt fields, but avoid inventing them before proving local UX.

### 4. Goal-Aware Thread List And Recents

- Impact: medium
- Effort: large
- Confidence: low
- Dependency: native Codex seam + app-server protocol

Show active goals outside the current thread:

- sidebar/recents badge for active or budget-limited goals
- filter "threads with active goals"
- resume unfinished goal thread

Constraint:

- The current generated protocol proves per-thread get/set/clear, but not a cross-thread goal list.
- Codex++ can only know other thread goals if it has observed them or if it can enumerate threads and call `thread/goal/get` per thread without causing load.

Implementation notes:

- Do not start by polling all threads.
- First, show badges only for threads seen in the local Codex++ journal.
- Later app-server ask: `thread/goal/list` with status filters and lightweight pagination.

## 3. Wild Ideas Or Moonshots

### 1. Multi-Goal DAGs And Epics

- Impact: moonshot
- Effort: large
- Confidence: low
- Dependency: external service or new app-server protocol

Build a small goal graph above native single-goal threads:

- parent epic
- child goals per thread/subagent
- dependencies
- acceptance checks
- completion artifacts

Why this is not v1:

- Native `ThreadGoalGetResponse` returns one goal or null.
- Native `ThreadGoalSetParams` sets one objective/status/budget for one thread.
- Multi-goal DAGs would be a Codex++ product layer, not a thin `/goal` UI.

### 2. Goal-Aware Work Reports

- Impact: high
- Effort: large
- Confidence: medium
- Dependency: Codex++ runtime seam + git metadata + optional external service

Use completion reports as structured work proof:

- goal objective
- completion status
- changed files
- commands run
- screenshots or visual proof
- PR body draft

Evidence:

- The git metadata plan notes that app-server thread git data is coarse, while Codex++ has a richer main-process git provider available behind `git.metadata` permission in `docs/GIT_METADATA_SIDEBAR.md:18-36`.
- A completion report already has core time/token fields from `ThreadGoal`.

Implementation notes:

- Do not block the first `/goal` work on git integration.
- Add "Attach evidence" after completion reporting is proven.

### 3. Goal Templates From Repo Context

- Impact: medium
- Effort: large
- Confidence: low
- Dependency: native Codex seam + Codex++ runtime seam

Generate goal templates from repo shape:

- AGENTS.md instructions
- Justfile/package scripts
- current branch and PR
- failing checks
- dirty files

This should be explicit user action, not automatic prompt stuffing. The safe version proposes templates; it does not silently modify the current goal.

## 4. Constraints And Exact Evidence

### Protocol Constraints

1. The goal protocol is thread-scoped and single-goal shaped.
   - Generated `ThreadGoalGetParams`: `{ threadId: string }`.
   - Generated `ThreadGoalGetResponse`: `{ goal: ThreadGoal | null }`.
   - Generated `ThreadGoalSetParams`: `{ threadId: string, objective?: string | null, status?: ThreadGoalStatus | null, tokenBudget?: number | null }`.
   - Generated `ThreadGoalClearResponse`: `{ cleared: boolean }`.

2. The only proven statuses are:
   - `active`
   - `paused`
   - `budgetLimited`
   - `complete`

3. The only proven goal notifications are:
   - `thread/goal/updated`
   - `thread/goal/cleared`

4. History, templates, reminders, due dates, multi-goal lists, and cross-thread goal querying are not proven native protocol features.

### Codex++ Runtime Constraints

1. The goal feature is a preload-level DOM shim, not native React source.
   - `startGoalFeature` is called before normal boot in `packages/runtime/src/preload/index.ts:53-57`.
   - The architecture prefers preload/DOM observation because Codex's renderer bundle is brittle to source patching in `docs/ARCHITECTURE.md:87-89`.

2. The app-server bridge is request/response over Codex desktop IPC.
   - Requests use `codex_desktop:message-from-view`, `type: "mcp-request"`, `hostId`, and `{ id, method, params }` in `packages/runtime/src/preload/app-server-bridge.ts:29-66`.
   - Notifications arrive through `codex_desktop:message-for-view` and are decoded separately from responses in `packages/runtime/src/preload/app-server-bridge.ts:86-118`.
   - Default request timeout is 12 seconds in `packages/runtime/src/preload/app-server-bridge.ts:3-5`.

3. Thread id extraction is route-derived and local-thread-biased.
   - `readThreadId` searches location, hash, href, initialRoute, and history state for `/local/<id>` in `packages/runtime/src/preload/goal-feature.ts:656-670`.
   - This means remote or future non-local route shapes need explicit validation before goal UI is claimed supported.

4. Current polling only refreshes on route/thread changes.
   - `refreshGoalForRoute` returns early when `threadId === lastThreadId` in `packages/runtime/src/preload/goal-feature.ts:206-230`.
   - Live updates depend on notifications, not repeated same-thread polling.

5. Renderer filesystem access is constrained.
   - The preload notes that sandboxed renderer cannot `require("node:fs")`; logs are forwarded to main via IPC in `packages/runtime/src/preload/index.ts:19-33`.
   - Any local goal history store should use main-process storage or existing tweak storage rather than renderer filesystem writes.

### Environment Evidence

1. Repo context says Codex Desktop `26.429.20946`, embedded `codex-cli 0.128.0-alpha.1`, and goals flag are present in `research/README.md:20-29`.
2. Installed CLI is `codex-cli 0.128.0`.
3. `codex features list` reports `goals under development true`.
4. `/Users/af/.codex/config.toml:38-47` has `[features].goals = true`.
5. `codex app-server --help` marks app-server as experimental and exposes protocol generation commands.

## 5. Suggested Next Slice

1. Add typed protocol drift check.
   - Generate app-server TS bindings in a temp dir during a local script/test.
   - Assert `ThreadGoal`, `ThreadGoalStatus`, and `ThreadGoalSetParams` still match the Codex++ local assumptions.
   - Acceptance: fails loudly if native protocol renames fields or statuses.

2. Ship command grammar expansion.
   - Add explicit parsing for `set`, `budget`, `budget none`, `status`, and `done`.
   - Acceptance: parser tests prove old `/goal <objective>` behavior still works.

3. Convert the panel into a pill + popover.
   - Keep existing app-server calls.
   - Acceptance: screenshots for no goal, active goal, paused goal, budget-limited goal, and completed report at desktop and narrow widths.

4. Add completion report.
   - Detect transition to `complete`.
   - Render objective, time, token usage, and budget summary.
   - Acceptance: copyable report text is deterministic and includes exact numbers from `ThreadGoal`.

5. Add local event journal.
   - Record updated/cleared notifications with metadata only.
   - Acceptance: current thread can show a goal history timeline after reload without storing chat content.

6. Add templates and reminders after history is real.
   - Templates need persistence.
   - Reminders need dismiss/snooze state.
   - Both should reuse the event journal rather than creating another state island.

7. Prepare upstream app-server asks.
   - `thread/goal/history/list`
   - `thread/goal/list`
   - optional `dueAt` / reminder fields
   - explicit budget enforcement semantics
   - stable feature detection for `thread/goal/*`
