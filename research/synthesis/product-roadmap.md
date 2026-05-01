# Codex++ Product Roadmap

This roadmap synthesizes the agent notes under `research/agents/` into ordered
shipping slices. It favors features that use Codex++ owned seams and avoid
private native internals.

## P0: Stabilize The Foundation

1. Goal command MVP.
   - Impact: high.
   - Effort: small.
   - Confidence: medium-high.
   - Dependency: app-server protocol.
   - Ship: `/goal`, `/goal clear`, `/goal pause`, `/goal resume`, `/goal complete`,
     composer suggestion, status panel, unsupported-build error state.
   - Done when: stable and beta both show preload boot, goal feature startup,
     suggestion overlay, and real thread goal set/get/clear on a local thread.

2. Dual-channel patch support.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: installer CLI.
   - Ship: documented stable/beta repair commands and status checks; later add a
     first-class `--channel beta` or multi-app status command.
   - Done when: stable and beta install states are separate and both apps report
     patched integrity OK.

3. Project Snapshot page.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: `api.git`.
   - Ship: branch/SHA, ahead/behind, dirty counts, changed files, insertions,
     deletions, worktree list, partial/truncated states.
   - Done when: clean repo, dirty repo, detached HEAD, bare repo, non-repo, and
     linked worktree states render without raw diff/file content.

4. Recovery Center.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: runtime/installer bridge.
   - Ship: patch status, watcher health, safe mode, open logs, copy diagnostics,
     repair command preview.
   - Done when: the Sparkle drift class is visible as a product state instead of
     "Codex++ disappeared".

## P1: Make Daily Use Better

1. Observability page.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: runtime seam.
   - Ship: live log tail, runtime health strip, app-server request timeline,
     goal token/budget telemetry.

2. Git-aware sidebar.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: `api.git` and sidebar DOM anchors.
   - Ship: repo header branch/dirty/ahead-behind, changed-files panel, diff
     footer, worktree popover.
   - Defer: mutating git actions, row mutation inside virtualized file tree,
     conflict-resolution cockpit.

3. Tweak Center.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: SDK/runtime.
   - Ship: installed/default/dev tweak catalog, permission badges, update
     details, storage paths, MCP declarations, trust card.

4. MCP managed-config preview.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium-high.
   - Dependency: runtime config service.
   - Ship: managed server list, owner tweak, env key names only, collision
     states, before/after TOML preview.

5. Handoff Summary Builder.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: goal + git + report inbox.
   - Ship: cwd, repo root, branch/SHA, dirty files, current goal, finished
     subagent cards, blockers, next actions, compact Markdown output.

## P2: Agentic Workflow Layer

1. Agent Run Ledger.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium-high.
   - Dependency: app-server events and local storage.
   - Ship: parent turn, spawned agents, waits, completed reports, changed files,
     commands run, blockers.

2. Subagent Report Inbox.
   - Impact: high.
   - Effort: small-medium.
   - Confidence: high.
   - Dependency: thread parsing/app-server events.
   - Ship: structured cards for final reports with changed files, commands,
     validation, risks, and exact next action.

3. Spawn Plan Composer.
   - Impact: high.
   - Effort: large.
   - Confidence: medium.
   - Dependency: native Codex seam if automatic spawning becomes available.
   - Ship first: prompt generator with role, ownership boundary, worktree
     guidance, report contract, validation expectations.

4. Worktree Fleet Manager.
   - Impact: high.
   - Effort: large.
   - Confidence: medium.
   - Dependency: git metadata and future write permission.
   - Ship first: read-only worktree inventory, owner notes, linked thread/report.
   - Defer: create/delete/cleanup until command previews and permission gates.

## P3: Larger Bets

1. App-server typed SDK:
   - `api.goal`
   - `api.thread.readonly`
   - `api.config.read`
   - `api.appServer.features`

2. Git watcher bridge:
   - main-process watcher keyed by repo root/commonDir,
   - debounced `codexpp:git-repo-changed`,
   - visible stale age and manual refresh.

3. Usage and cost panel:
   - bounded session JSONL aggregation,
   - model split,
   - unknown pricing states,
   - daily/hourly token trends.

4. Local tweak marketplace:
   - local catalog first,
   - GitHub release update details,
   - install receipts,
   - later signed/reviewed registry.

## Moonshots

1. Meta-supervisor mode:
   - detects stale agents, missing validation, overbroad prompts, write-scope
     collisions, and finalization risk.

2. Threaded goal graph:
   - parent/child objectives, budgets, dependencies, acceptance criteria, and
     handoff links across threads.

3. Replayable agent session trace:
   - structured timeline of messages, tool calls, diffs, checks, screenshots,
     and final evidence with redaction at capture time.

4. Compatibility canary for new Codex releases:
   - download new signed app,
   - run patch probes and smoke tests,
   - publish compatibility verdict for repair/status UI.

## Immediate Next Implementation Order

1. Finish live QA for `/goal` on stable and beta.
2. Add Project Snapshot settings page using `api.git`.
3. Add Recovery Center v1 and watcher failure visibility.
4. Add Observability page with log tail and app-server bridge timeline.
5. Add Tweak Center trust card and MCP preview.

