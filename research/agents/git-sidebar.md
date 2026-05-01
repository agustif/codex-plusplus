# Git Metadata In Sidebar Surfaces

## 1. Best Immediate Wins

1. Project/sidebar repository header.
   - Product: show the active branch or detached short SHA beside the project name, then compact `+ahead/-behind`, dirty count, and current worktree root.
   - Why: the current project surface can tell the user where they are before they ask an agent to edit. This prevents wrong-branch and wrong-worktree mistakes.
   - Evidence: `docs/GIT_METADATA_SIDEBAR.md` says the runtime already exposes repository resolution, branch, upstream, ahead, behind, detached state, root, git dir, common dir, bare state, and worktree state. `packages/runtime/src/git-metadata.ts` returns `GitStatus.branch` with `head`, `upstream`, `ahead`, and `behind`, plus `GitRepositoryResolution.root`, `headBranch`, and `headSha`.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.

2. File/project sidebar badges for path state.
   - Product: add tiny fixed-width badges in file rows: `S` for staged/index changes, `M` for worktree changes, `U` for untracked, `R` for rename, conflict marker for unmerged, and binary marker when diff summary marks a path binary.
   - Why: agents and humans both need to see whether a file is dirty before opening or editing it. The key value is not full diff rendering; it is cheap ambient awareness.
   - Evidence: the docs name these exact first-pass badges. `GitStatusEntry` separates ordinary, rename, unmerged, untracked, and ignored entries; ordinary and rename entries preserve `index` and `worktree` status columns from porcelain v2. `GitDiffFileSummary` carries `binary`, `oldPath`, insertions, and deletions.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.

3. Dirty-files section scoped to visible project paths.
   - Product: a collapsible "Changed files" cluster in the project sidebar, ordered by conflict, staged, unstaged, untracked, renamed, ignored. Include count chips and keep ignored hidden behind an explicit toggle.
   - Why: a sidebar file tree should not require a terminal status check for basic situational awareness. This is also the safest first UX because it is read-only.
   - Evidence: `getStatus(path)` already returns all entries from `git status --porcelain=v2 -z --branch --untracked-files=all`; ignored entries are parsed as `kind: "ignored"` if present. The runtime doc says metadata is read-only and does not scan the filesystem from the renderer.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.

4. Diff footer for project health at a glance.
   - Product: show `N files`, `+insertions`, `-deletions`, and a `truncated` warning in the sidebar footer or project header hovercard.
   - Why: this gives enough size signal to decide whether to review now, split work, or ask an agent to summarize before continuing.
   - Evidence: `getDiffSummary(path)` returns `fileCount`, `insertions`, `deletions`, per-file summaries, and `truncated`. The provider uses `git diff --numstat -z --find-renames --find-copies HEAD --` when `HEAD` exists and cached diff in initial-commit repos.
   - Impact: medium.
   - Effort: small.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.

5. Worktree switcher and collision warning.
   - Product: if more than one linked worktree exists, expose a worktree popover with branch/head/path rows and warning states for locked or prunable worktrees. Mark the current root clearly.
   - Why: this directly supports parallel agent work. It also catches the common "same branch checked out elsewhere" or "stale prunable worktree" problem before edits start.
   - Evidence: `getWorktrees(path)` parses `git worktree list --porcelain -z` into `path`, `head`, `branch`, `detached`, `bare`, `locked`, `lockedReason`, `prunable`, and `prunableReason`. The sidebar doc already calls out linked worktree display and locked/prunable marking.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.

6. Read-only review mode entrypoint.
   - Product: add a "Review changes" command from the sidebar that opens a review panel seeded with current dirty files and diff summary. Initial version can be metadata-only: counts, path list, staged/unstaged/conflict grouping, and "ask agent to review" handoff.
   - Why: the runtime deliberately avoids raw hunks today, but the product can still create a strong review doorway without adding mutating git operations.
   - Evidence: docs say the app-server thread model exposes coarse `gitInfo` and `gitDiffToRemote`, while Codex++ exposes richer per-file status and diff summary. `docs/WRITING-TWEAKS.md` says `api.git` intentionally does not return raw diff hunks or file contents.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: Codex++ runtime seam plus native Codex UI seam.

## 2. Medium Bets

1. PR context chip in the repository header.
   - Product: when upstream branch or remote URL maps to GitHub, show PR number/title/status if discoverable, with a fallback to "No PR context". Keep this separate from the read-only git metadata provider.
   - Why: branch and dirty state are local; reviewers also need to know whether the current branch already has an open PR, failing checks, unresolved reviews, or merge conflicts.
   - Evidence: current runtime git API has local branch/upstream/head/worktree data only. No API currently returns GitHub PR metadata, checks, reviews, labels, or mergeability. `docs/ARCHITECTURE.md` shows the runtime already has advisory GitHub release metadata fetching for tweak updates, but that is not repo PR context.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: external service.

2. Workspace health strip.
   - Product: a compact health line: repo found/not found, branch state, dirty count, conflict count, truncated status, worktree count, upstream ahead/behind, and stale metadata age.
   - Why: this converts raw git facts into an operational "safe to work?" signal for agents and users.
   - Evidence: the provider already returns structured errors for not-a-repository, timeout, spawn-error, and git-failed; it also returns `truncated`, `clean`, and worktree metadata. It does not yet return refresh timestamps, so the UI should own `lastFetchedAt`.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.

3. Conflict-first mode.
   - Product: when any `unmerged` entry exists, promote conflicts above the normal file tree and expose "open conflicted files", "ask agent to resolve", and "show conflict count" actions.
   - Why: conflicts are qualitatively different from ordinary dirty state. They should interrupt review mode and workspace health.
   - Evidence: porcelain v2 `u` entries are parsed into `GitUnmergedStatusEntry` with `index`, `worktree`, `submodule`, and `path`. There is no hunk-level conflict API, so the first version should navigate and triage, not attempt resolution from the sidebar.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam plus native Codex file navigation seam.

4. Staged vs unstaged review grouping.
   - Product: show separate groups for staged/index changes, unstaged/worktree changes, and untracked files. For a file with both staged and unstaged changes, show a split badge such as `S+M`.
   - Why: staged files indicate user intent; unstaged files indicate active work. Agents should not blur them.
   - Evidence: ordinary and rename status entries carry both `index` and `worktree` columns. The current diff summary is aggregate against `HEAD`, so per-file staged-vs-unstaged line counts would require a later API addition.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.

5. Branch-to-remote review summary.
   - Product: show "local changes" separately from "branch review delta" once branch comparison to upstream/remote is available. Use this for PR review mode and "what will reviewers see?".
   - Why: local dirty files and committed branch delta are different decisions. The sidebar should not make users infer PR scope from working-tree scope.
   - Evidence: `docs/GIT_METADATA_SIDEBAR.md` says upstream Codex has review summaries and branch-to-remote comparison, while app-server `gitDiffToRemote` is coarse. The Codex++ provider currently exposes ahead/behind but not committed-file diff to upstream.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: native Codex seam or expanded Codex++ runtime seam.

6. Safe "handoff to agent" context package.
   - Product: from a file/project/sidebar action, package branch, head SHA, root, dirty entries, diff summary, worktree list, and truncation flags into a structured prompt attachment for a new agent.
   - Why: it gives agents exact git state without dumping raw diffs or credentials into chat. It also aligns with the runtime's metadata-only contract.
   - Evidence: `api.git` already returns JSON-like metadata over IPC, and `docs/WRITING-TWEAKS.md` explicitly says it does not expose raw diff hunks, file contents, remote credentials, or ignored file trees by default.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: Codex++ runtime seam plus native Codex composer/thread seam.

## 3. Wild Ideas Or Moonshots

1. Multi-worktree mission control.
   - Product: a sidebar workspace map where each worktree is a lane with branch, head, PR, dirty/conflict state, assigned agent, last command, and health.
   - Why: Codex++ can become the orchestrator surface for parallel agent branches rather than only a tweak runtime.
   - Evidence: current `getWorktrees` gives enough local topology to start. Agent assignment, last command, and PR state are not in the git provider.
   - Impact: moonshot.
   - Effort: large.
   - Confidence: medium.
   - Dependency: Codex++ runtime seam plus external service plus agent/task state.

2. Review heatmap over the file tree.
   - Product: shade files by diff size, churn, binary status, and conflict risk; fold generated or ignored paths by default.
   - Why: reviewers and agents need to spend attention where the change is largest or riskiest.
   - Evidence: `getDiffSummary` has per-file insertions/deletions/binary/rename data but not hunk-level semantics, ownership, generated-file detection, or language parser output.
   - Impact: high.
   - Effort: large.
   - Confidence: medium.
   - Dependency: Codex++ runtime seam plus optional local analysis.

3. PR readiness gate.
   - Product: a "ready to PR?" panel that checks dirty state, staged leakage, conflicts, branch sync, tests last run, review status, CI, and screenshot evidence for visual changes.
   - Why: this turns sidebar git metadata into a release/review workflow.
   - Evidence: local git state is available; test history, screenshot evidence, CI, and review threads are not currently part of this provider.
   - Impact: high.
   - Effort: large.
   - Confidence: medium.
   - Dependency: external service plus repo-local validation artifacts.

4. Conflict-resolution cockpit.
   - Product: when conflicts are detected, open a guided side-by-side flow with file navigation, base/ours/theirs summaries, agent suggestions, and post-resolution status checks.
   - Why: conflict resolution is a high-friction task where agents can help, but only if the UI keeps exact state visible.
   - Evidence: current API can detect unmerged paths only. It does not expose stages, blob contents, conflict hunks, merge base, or resolution commands.
   - Impact: moonshot.
   - Effort: large.
   - Confidence: low.
   - Dependency: expanded Codex++ runtime seam.

## 4. Constraints And Exact Evidence

1. Renderer access is permission-gated.
   - Evidence: `docs/WRITING-TWEAKS.md` requires `"permissions": ["git.metadata"]`; `packages/runtime/src/preload/tweak-host.ts` only attaches `api.git` when the manifest includes `git.metadata`; `packages/sdk/src/index.ts` validates `git.metadata` as a known permission.
   - Product constraint: every sidebar tweak that reads git metadata needs a manifest update and a no-permission empty state.

2. The provider is metadata-only and read-only.
   - Evidence: docs say it does not return raw diff hunks, file contents, remote credentials, or ignored file trees by default. The runtime API only includes `resolveRepository`, `getStatus`, `getDiffSummary`, and `getWorktrees`.
   - Product constraint: first sidebar versions should not promise commit, stage, checkout, merge, fetch, or conflict-resolution actions.

3. Main process owns git subprocesses.
   - Evidence: `packages/runtime/src/git-metadata.ts` uses `spawn(config.gitPath, args, { shell: false })`, bounded stdout/stderr byte caps, and a timeout. Preload exposes IPC handlers `codexpp:git-status`, `codexpp:git-diff-summary`, and `codexpp:git-worktrees`.
   - Product constraint: renderer code should request structured metadata and cache/debounce it; it should not shell out.

4. Large repos and truncated output are first-class states.
   - Evidence: default caps are `1 MiB` stdout and `64 KiB` stderr; status and diff summary return `truncated`.
   - Product constraint: show "partial" or "truncated" state instead of silently presenting incomplete counts as definitive.

5. Initial commits, detached HEAD, bare repositories, and non-repositories need explicit states.
   - Evidence: `resolveRepository` can return `found: false`, `isBare`, `isInsideWorkTree`, null root/head branch/head SHA. `getDiffSummary` falls back to cached diff when `headSha` is missing.
   - Product constraint: no repo should hide git UI, bare repo should not show working-tree file badges, initial commit should avoid branch-to-HEAD assumptions, detached HEAD should show short SHA.

6. Current diff summary is against `HEAD`, not split by index/worktree.
   - Evidence: `getDiffSummary` uses `git diff --numstat ... HEAD --` when `HEAD` exists and cached diff only when no `HEAD` exists.
   - Product constraint: `S` and `M` badges can come from status entries, but staged-vs-unstaged insertion/deletion counts require a future API.

7. Current PR context is not available in the git provider.
   - Evidence: runtime git types have no PR, check, review, mergeability, issue, or remote-host API. GitHub usage in the runtime is currently release metadata for tweaks, not project PR state.
   - Product constraint: PR chips should be a second data source with clear loading, auth, and offline states.

## 5. Suggested Next Slice

1. Build a read-only `useGitMetadata(rootPath)` hook in the sidebar tweak layer.
   - Fetch `getStatus`, `getDiffSummary`, and `getWorktrees` in parallel.
   - Cache by repository root.
   - Refresh on sidebar open, focus regain, route/project change, and after known file-writing tool events if that seam is available.
   - Debounce per root and show stale age.

2. Render the smallest useful UI first.
   - Header: branch or short SHA, dirty count, ahead/behind, current worktree.
   - File rows: `S`, `M`, `U`, `R`, conflict, binary badges.
   - Footer: file count, insertions, deletions, truncated warning.

3. Add worktree and review affordances after screenshots prove the basics.
   - Worktree popover with path, branch/head, locked/prunable flags.
   - Metadata-only "Review changes" panel grouped by conflict, staged, unstaged, untracked, renamed, binary.

4. Defer mutating operations.
   - No stage/unstage, checkout, branch creation, fetch, merge, rebase, conflict resolution, or PR writes until the read-only model proves stable.

5. Future API extensions worth considering.
   - `getDiffSummary(path, { base: "HEAD" | "index" | "worktree" | "upstream" })` for staged/unstaged and branch-to-remote grouping.
   - `getRemoteInfo(path)` returning sanitized remote host/owner/repo/default branch without credentials.
   - `getConflictSummary(path)` returning unmerged stage metadata without file contents.
   - `watchGitMetadata(root)` or event hooks so the UI can avoid slow polling.
