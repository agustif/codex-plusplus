# Git Metadata Sidebar

Codex++ now has a main-process git metadata provider and a built-in renderer
sidebar layer for Codex Desktop project rows. The renderer never shells out; it
uses the existing IPC-backed provider and renders metadata-only state in the
Projects sidebar.

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

The first visible implementation lives in
`packages/runtime/src/preload/git-sidebar.ts`.

It uses Codex Desktop's project-row attributes instead of guessing paths:

- `data-app-action-sidebar-project-id` provides the absolute project cwd.
- `data-app-action-sidebar-project-label` provides the visible project label.
- The active thread, when present, sits under
  `data-app-action-sidebar-project-list-id`, which identifies the active cwd.

Rendered surfaces:

- Project-row badges for visible repos:
  - branch name or detached short SHA
  - dirty entry count
  - ahead/behind short markers when available
  - conflict styling when porcelain reports unmerged entries
- Active repo panel under the active or first usable project:
  - branch/upstream state
  - staged, unstaged, untracked, and conflict counts
  - diff file count plus insertion/deletion totals
  - first changed paths with porcelain labels
  - linked worktree count and a compact worktree list when more than one exists

The target shape remains compact and high-signal:

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

The implemented sidebar uses an event-first, poll-backed model:

- Refresh status on boot, focus regain, and project/sidebar DOM mutations.
- Poll visible repos slowly while the app is open.
- Debounce refreshes to avoid observer loops.
- Cache status/details per repo root so repeated sidebar changes do not rerun
  `git` immediately.
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

1. Add direct file-list badges if Codex exposes a stable file/path list surface
   beyond the Projects sidebar.
2. Add a worktree switcher action once there is a Codex-native way to open a
   project/worktree from renderer UI.
3. Add richer per-file diff previews behind explicit expansion; keep the default
   sidebar compact.
4. Refresh after confirmed Codex tool calls that write files, if the app-server
   exposes a stable event for that.
5. Keep all mutating git operations out of scope for this contract. This API is
   read-only by design.
