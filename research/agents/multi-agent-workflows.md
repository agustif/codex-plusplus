# Multi-Agent Workflow Product Notes

Owned lane: Codex++ multi-agent orchestration inside Codex Desktop.

Evidence anchors:

- Codex++ can already inject renderer UI, Settings pages, and tweak lifecycle via `packages/runtime/src/preload/index.ts`, `settings-injector`, and `tweak-host`.
- `packages/runtime/src/preload/app-server-bridge.ts` can send app-server requests and subscribe to app-server notifications from the renderer.
- `packages/runtime/src/preload/goal-feature.ts` proves `thread/goal/get`, `thread/goal/set`, `thread/goal/clear`, and `thread/goal/*` notifications can drive thread-scoped UX.
- `packages/runtime/src/main.ts` exposes Codex-native window/view creation through `api.codex.createWindow` and `api.codex.createBrowserView`.
- `packages/runtime/src/mcp-sync.ts` can register tweak-provided MCP servers into Codex config.
- `packages/runtime/src/git-metadata.ts` plus `api.git` provide metadata-only repository, status, diff, and worktree reads.

## 1. Best Immediate Wins

### 1.1 Agent Run Ledger

Impact: high  
Effort: medium  
Confidence: high  
Dependency: Codex++ runtime seam, app-server protocol

Add a Codex++ Settings page or side panel that shows the current thread's agent work as an ordered ledger: parent turn, spawned subagents, pending waits, finished reports, changed files, commands run, and blockers. The first version can be passive and metadata-only: read current thread id from route, subscribe through the existing app-server notification bridge, and persist user-visible annotations in per-tweak storage.

Why it matters: multi-agent work fails when orchestration state lives only in chat prose. A ledger makes it obvious which lanes are still running, which outputs are trusted, and which handoffs remain unintegrated.

Implementation seams:

- Renderer tweak with `api.settings.registerPage` for a first administrative surface.
- `requestAppServer` and `onAppServerNotification` for current thread metadata and any available run events.
- `api.storage` for ledger rows that are not yet present in upstream app-server state.
- Later promotion to a dedicated route/window through `api.codex.createWindow`.

EffectTS v4 shape:

- Model rows with Effect Schema: `AgentRun`, `AgentEvent`, `AgentReport`, `AgentBlocker`.
- Keep ingestion as a small Effect service boundary: `RunLedgerStore`, `AppServerEvents`, `ThreadContext`.
- Avoid parsing raw transcript HTML in the core service. Keep DOM scraping as a replaceable adapter if needed.

### 1.2 Subagent Report Inbox

Impact: high  
Effort: small  
Confidence: high  
Dependency: Codex++ runtime seam

Create a report inbox that turns subagent final messages into structured cards: summary, findings, changed files, validation, residual risk, and next action. This should work even before Codex exposes rich subagent state by letting the parent agent paste or generate report blocks into the thread and having the tweak extract bounded report sections.

Why it matters: today the parent must visually scan long chat history and remember what each explorer/worker returned. A compact report inbox makes integration and review faster without needing to own spawning yet.

Implementation seams:

- Renderer page in the Codex++ Tweaks sidebar.
- Lightweight parser for explicit report fences or headings in visible thread text.
- `api.storage` cache by `threadId + messageId` once message identity is available.
- Optional "copy integration checklist" action that writes a concise parent-agent checklist to clipboard using existing IPC.

Implementation note: the preferred durable path is not generic LLM summarization. Use an explicit report contract first, then add summarization only as a fallback.

### 1.3 Handoff Summary Builder

Impact: high  
Effort: medium  
Confidence: high  
Dependency: Codex++ runtime seam, git.metadata

Add a handoff builder for context-window recovery and thread continuation. It should gather cwd, repo root, git status, changed files, current goal, recently completed subagent report cards, commands run if available, unresolved blockers, and exact next actions into a compact Markdown artifact.

Why it matters: Codex++ is already close to the user's recovery doctrine. A one-click handoff reduces saturated-thread failures and prevents bulk-dumping rollout logs into a new thread.

Implementation seams:

- Use `api.git.resolveRepository`, `api.git.getStatus`, `api.git.getDiffSummary`, and `api.git.getWorktrees` for metadata-only repo state.
- Use existing `/goal` bridge for objective/status/tokens when the app-server supports goals.
- Store handoff drafts in tweak storage keyed by thread id.
- Provide copy-to-clipboard first; later add "open fresh Codex window with handoff prompt" through `api.codex.createWindow`.

Acceptance check:

- Generated handoff includes original thread id when available, cwd/repo root, current branch/SHA, dirty files, changed-file counts, active goal, blockers, and the next three actions.
- It never embeds full logs, secrets, raw diffs, or unbounded transcript chunks by default.

### 1.4 Goal Thread Header

Impact: medium  
Effort: small  
Confidence: high  
Dependency: app-server protocol

Promote the existing `/goal` feature from floating panel into a persistent thread header chip: objective, status, budget usage, elapsed time, and quick actions for pause/resume/complete. This makes threaded goals visible without requiring users to type `/goal`.

Why it matters: goals become useful orchestration state only when they remain visible during long runs.

Implementation seams:

- Reuse `thread/goal/get` and `thread/goal/set` from `goal-feature.ts`.
- Reuse the route refresh logic that already tracks `threadId`.
- Render into the existing Codex DOM with the same conservative mutation-observer approach as Settings injection.

Constraint: keep the existing `/goal` command as the source of truth for the first slice. The header should be a view/controller, not a parallel goal store.

### 1.5 Review Lane Checklist

Impact: high  
Effort: medium  
Confidence: medium  
Dependency: Codex++ runtime seam, git.metadata

Add a review-lane panel that turns a multi-agent code task into explicit review lanes: diff review, tests, docs, visual proof, security/trust boundary, PR description, and unresolved questions. Each lane can be assigned to "parent", "explorer", or "worker" and marked blocked/ready/done.

Why it matters: multi-agent output is only useful if the parent can see what still needs human-quality integration. This also maps cleanly to the repo's PR evidence standard.

Implementation seams:

- Start as local checklist state in `api.storage`.
- Prepopulate lanes from git status and file types via `api.git.getStatus`.
- Add optional report-card links from the Subagent Report Inbox.
- Later connect to GitHub PR state through MCP or CLI-backed tweak permissions.

## 2. Medium Bets

### 2.1 Task DAG Canvas

Impact: high  
Effort: large  
Confidence: medium  
Dependency: Codex++ runtime seam

Build a DAG view where nodes are tasks, subagents, validation lanes, blockers, and handoffs. Edges represent "blocks", "verifies", "integrates", or "supersedes". The first useful version should be dense and operational, not a decorative canvas.

Why it matters: the parent agent needs a working map of what is parallelizable versus what is on the critical path. A DAG prevents duplicated work, idle waits, and stale blockers.

Implementation seams:

- Dedicated Settings page first; later a detached Codex++ window through `api.codex.createWindow`.
- Store graph state in tweak storage as normalized tables: nodes, edges, statuses, evidence refs.
- Import from handoff summary and report inbox.
- Export to Markdown so the graph survives without the UI.

Dependency candidates:

- Use EffectTS v4 services and Schema for graph validation, cycle detection, and stale status checks.
- Consider React Flow or a similarly maintained graph renderer only after the data model is stable. Keep graph computation independent of the view dependency.

Acceptance check:

- Detect cycles.
- Detect nodes with missing owner/status.
- Highlight current critical path.
- Show "ready to spawn" nodes separately from "blocked until report arrives" nodes.

### 2.2 Spawn Plan Composer

Impact: high  
Effort: large  
Confidence: medium  
Dependency: native Codex seam, app-server protocol

Create a composer assistant that turns a broad task into bounded subagent prompts with role, ownership boundary, write scope, worktree guidance, report contract, and validation expectations. The first version should generate prompts for manual spawning; later versions can call a native spawn API if Codex exposes one.

Why it matters: spawning is powerful but failure-prone. The real product leverage is making each delegated lane bounded, non-overlapping, and reviewable.

Implementation seams:

- UI uses current thread goal plus git dirty state to warn about unsafe write scopes.
- Prompt templates live as data, not hard-coded prose, so teams can tune conventions.
- Manual mode: copy prompts to clipboard.
- Native mode, if available later: route through app-server request bridge or an MCP tool registered by Codex++.

Report contract:

- Each prompt should require: changed files, commands run, final status, blockers, exact next action, and whether it touched only the assigned ownership boundary.

### 2.3 Worktree Fleet Manager

Impact: high  
Effort: large  
Confidence: medium  
Dependency: git.metadata, Codex++ runtime seam

Add a manager for multi-agent worktrees: golden worktree source, fresh child worktrees, branch naming, dirty state, lock reason, stale/prunable detection, and per-lane ownership notes.

Why it matters: the user explicitly wants new worktrees copied from a golden ready-to-run checkout to avoid setup tax and clashes. Codex++ can surface this inside the app before adding mutating operations.

Implementation seams:

- Read-only first with `api.git.getWorktrees`.
- Add metadata notes in tweak storage: owner lane, purpose, linked thread, linked report.
- Mutating operations should require a new explicit permission, for example `git.worktree.write`, and should run in main with `spawn(..., { shell: false })`.
- For "copy golden" implementation, prefer a repo-local script or a Codex++ installer-managed helper instead of ad hoc shell strings in renderer code.

Risk:

- Worktree creation can destroy productivity if it touches the wrong path. Keep mutation out of the first slice and show the exact command preview before any future write path.

### 2.4 Agent Dashboard Window

Impact: medium  
Effort: medium  
Confidence: medium  
Dependency: native Codex seam

Use `api.codex.createWindow` to create a dedicated dashboard window for long-running orchestration: active threads, goals, subagent reports, handoff drafts, and review lanes. The dashboard should be separate from Settings once the product is used daily.

Why it matters: Settings is good for MVP, but orchestration is primary work. A dashboard window lets the user keep command/chat visible while the supervisor state stays open.

Implementation seams:

- Start from a Settings page.
- Promote to native Codex window when routing and layout are proven.
- Keep all data services shared so Settings and dashboard are two views over the same store.

### 2.5 Evidence Index

Impact: medium  
Effort: medium  
Confidence: medium  
Dependency: Codex++ runtime seam, git.metadata

Create an evidence index for a thread: commands run, screenshots, changed files, PR links, failing checks, passing checks, and source anchors. This is the substrate for high-quality PR descriptions and final answers.

Implementation seams:

- Pull git state from `api.git`.
- Let users attach file paths or clipboard snippets manually first.
- Later ingest terminal/session events if Codex exposes them.
- Export reviewer-facing PR evidence sections.

Constraint:

- Do not auto-claim checks passed. Evidence rows need status, timestamp, command, and result summary.

## 3. Wild Ideas Or Moonshots

### 3.1 Meta-Supervisor Mode

Impact: moonshot  
Effort: large  
Confidence: low  
Dependency: native Codex seam, app-server protocol

Add a supervisor mode that continuously evaluates the active thread's orchestration health: missing plan, too-serial execution, stale subagent, unbounded prompt, conflicting write scopes, missing validation, or unsafe finalization. It should suggest interventions and generate bounded prompts rather than silently taking action.

Implementation seams:

- Start as deterministic rules over the ledger, DAG, reports, and git state.
- Add model-assisted critique only after the deterministic states are reliable.
- Make all suggestions auditable: input facts, rule fired, suggested action.

### 3.2 Threaded Goal Graph

Impact: moonshot  
Effort: large  
Confidence: medium  
Dependency: app-server protocol

Extend single-thread goals into a goal graph: parent objective, child objectives, budgets, dependencies, completion criteria, and handoff links. The UI should show which thread owns which part of a larger objective.

Implementation seams:

- Use existing `thread/goal/*` as node-local state.
- Store cross-thread graph in Codex++ storage until upstream supports it.
- Include import/export so graph state can be carried between machines or threads.

Risk:

- Split-brain state if upstream eventually owns cross-thread goals. Keep IDs and schema versioned from day one.

### 3.3 Auto-Handoff Fresh Thread Launcher

Impact: moonshot  
Effort: large  
Confidence: low  
Dependency: native Codex seam

When context saturation is detected or requested, generate a handoff, open a fresh Codex window/thread, seed the handoff as the first prompt, and keep a back-link to the archival thread.

Implementation seams:

- Handoff Summary Builder is prerequisite.
- Needs a reliable native route or compose API. Until then, only copy the prompt and open a fresh window.
- Must avoid copying old saturated model-visible history.

### 3.4 Multi-Agent Replay

Impact: moonshot  
Effort: research  
Confidence: low  
Dependency: external service, app-server protocol

Replay a completed multi-agent session as a timeline with decisions, reports, edits, checks, and final state. Useful for training future agents, debugging bad orchestration, and creating reusable runbooks.

Implementation seams:

- Event model from Agent Run Ledger.
- Evidence Index for command/check attachments.
- Export as compact JSONL plus Markdown summary.

## 4. Constraints And Exact Evidence

Current product constraints:

- Codex++ is a local patch/runtime system, not a fork of Codex Desktop. Durable features should prefer preload, app-server bridge, settings injection, and main-process APIs over minified bundle patching.
- Renderer code should not shell out. Main-process services already own git metadata and should own any future mutating filesystem/git operations.
- Existing public tweak permissions do not include agent orchestration, transcript access, terminal event access, or git mutation. New sensitive surfaces should be permission-gated.
- `thread/goal/*` exists in the local context but can fail on older app-server builds or when the goals feature is disabled. Goal-based UX needs graceful degradation.
- Worktree and subagent mutation has high blast radius. First slices should be read-only, copy-to-clipboard, or explicit command-preview flows.

Useful existing seams:

- UI: `api.settings.registerPage`, Settings injector, DOM/fiber utilities.
- Native windowing: `api.codex.createWindow`, `api.codex.createBrowserView`.
- App-server: `requestAppServer`, `onAppServerNotification`, host id and thread route helpers in `goal-feature.ts`.
- Local persistence: per-tweak storage under user data.
- Git metadata: repository resolution, status, diff summary, worktrees.
- MCP: tweak manifests can declare MCP servers that Codex++ syncs into `~/.codex/config.toml`.

Data contracts to establish before implementation:

- `ThreadRef`: host id, thread id, route, cwd/project path if known.
- `AgentRun`: id, parent thread, role, status, created/updated timestamps, ownership boundary.
- `AgentReport`: run id, summary, files changed, commands run, findings, blockers, next actions.
- `TaskNode`: id, title, owner, status, dependencies, acceptance checks, evidence refs.
- `HandoffSummary`: source thread, repo metadata, goal state, changed files, completed reports, blockers, next actions.

## 5. Suggested Next Slice

Build the read-only orchestration MVP in this order:

1. Add an internal data model for `ThreadRef`, `AgentReport`, `TaskNode`, and `HandoffSummary` using EffectTS v4 Schema in a future implementation slice.
2. Implement Subagent Report Inbox as a Settings page with explicit report-block parsing and per-thread storage.
3. Implement Handoff Summary Builder using report cards, current goal state, and `api.git` metadata.
4. Add Review Lane Checklist seeded from changed file types and linked to report cards.
5. Promote the most-used surface into a dedicated Agent Dashboard window after the Settings-page UX proves useful.

Definition of done for the first implementation PR:

- No mutating git/worktree operations.
- No raw transcript or log bulk capture.
- Works when `thread/goal/*` is unavailable by omitting goal state with a clear local note.
- Generated handoff is bounded, copyable, and includes exact repo metadata from `api.git`.
- PR includes screenshots because this is UI-affecting work.
