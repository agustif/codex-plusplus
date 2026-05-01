# Git Metadata Sidebar Plan

Codex++ now has a main-process git metadata provider that tweak/UI code can call
without shelling out from the renderer. This document captures the sidebar plan
so the next UI slice can use the same contract instead of re-researching native
Desktop internals.

## Current Upstream Shape

Codex Desktop already has native git machinery in its bundled renderer worker.
The useful existing concepts are:

- Stable repository metadata: branch, head SHA, remote URL.
- Status summaries for dirty, staged, unstaged, untracked, and ignored paths.
- Review summaries and diffs for branch-to-remote comparison.
- Worktree listing, including Codex-created worktrees.

The public app-server thread model is much coarser: a thread can expose
`gitInfo` (`sha`, `branch`, `originUrl`) and a unified `gitDiffToRemote`, but
it does not expose per-file staged/unstaged status, linked worktrees, ahead and
behind counts, or sidebar-ready path badges.

## Codex++ Contract

The implemented substrate lives in `packages/runtime/src/git-metadata.ts` and is
exposed to renderer tweaks behind the `git.metadata` manifest permission:

```ts
const status = await api.git?.getStatus(projectPath);
const diff = await api.git?.getDiffSummary(projectPath);
const worktrees = await api.git?.getWorktrees(projectPath);
```

The provider returns metadata only. It runs `git` from the main process with
`spawn(..., { shell: false })`, byte caps, and a timeout. The renderer receives
structured JSON-like objects instead of raw command output.

Available data:

- Repository resolution: root, git dir, common dir, branch, head SHA, bare or
  worktree state, and a structured error when the path is not a repo.
- Branch state: current branch, upstream, ahead, behind, and detached state.
- File status entries from `git status --porcelain=v2 -z --branch`: ordinary
  changes, renames, unmerged files, untracked files, and ignored files.
- Diff summary from `git diff --numstat --find-renames --find-copies HEAD --`:
  file count, insertions, deletions, binary files, and rename old/new paths.
- Linked worktrees from `git worktree list --porcelain -z`: path, head, branch,
  detached, bare, locked, and prunable flags.

## Sidebar UI Model

The first useful sidebar should stay compact and high-signal:

- Repository header:
  - branch name or detached short SHA
  - dirty count
  - ahead/behind against upstream when available
  - current worktree root, with a linked-worktree affordance if more exist
- File list badges:
  - `M` for modified in worktree
  - `S` for staged/index changes
  - `U` for untracked
  - `R` for rename, showing old path in tooltip
  - conflict marker for unmerged paths
  - binary marker for binary diff-summary files
- Diff footer:
  - changed file count
  - insertion/deletion totals
  - truncation warning if the provider capped command output
- Worktree switcher:
  - show branch/head for each linked worktree
  - mark locked/prunable worktrees
  - keep Codex-created worktrees visually distinct once a reliable native marker
    is exposed or inferred from path convention

## Refresh Strategy

Use an event-first, poll-backed model:

- Refresh status on sidebar open, focus regain, route/thread change, and after
  Codex tool calls that write files.
- Poll visible repos slowly, for example every 5 to 10 seconds while the sidebar
  is visible and the app is focused.
- Debounce refreshes per repo root.
- Cache the last successful status by root so the sidebar can render instantly
  and then reconcile.
- Treat `truncated: true` as a UI state, not a hard error.

## Edge Cases To Handle

- Not a git repository: hide git badges and show no repo header.
- Initial commit: `HEAD` may not exist; show status, but diff summary should use
  cached/index data only until the first commit exists.
- Detached HEAD: show the short SHA instead of branch.
- Submodules: porcelain v2 exposes submodule state; preserve that string for a
  later submodule-specific badge.
- Sparse checkouts and ignored files: keep them metadata-only and do not scan
  the filesystem from the renderer.
- Large repos: rely on output caps, debounce, and visible-path filtering before
  adding richer per-file diff previews.

## Next Implementation Slice

1. Identify the existing file-list/sidebar React surface and its route/project
   path source.
2. Add a small `useGitMetadata(rootPath)` hook that calls `api.git.getStatus`
   and `api.git.getDiffSummary`.
3. Render the repository header and simple badges first.
4. Add worktree switcher and richer diff footer after the basic path-status
   mapping is proven in screenshots.
5. Keep all mutating git operations out of scope for this contract. This API is
   read-only by design.
