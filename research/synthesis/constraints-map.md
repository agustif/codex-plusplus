# Codex++ Constraints Map

## Stable Integration Rules

1. Own the bridge, not Codex internals.
   - Preferred: Codex++ main/preload services, typed SDK APIs, Settings pages,
     metadata-only providers, Desktop IPC app-server bridge.
   - Avoid: hashed bundle patching, React fiber mutation, ProseMirror state
     mutation, native slash-menu injection.

2. Use current binary evidence for app-server methods.
   - Installed stable and beta embed `codex-cli 0.128.0-alpha.1`.
   - Homebrew CLI is `0.128.0`.
   - `thread/goal/*` request methods are experimental; notifications exist as
     native thread goal events.

3. Treat stable and beta as separate patch targets.
   - Stable and beta need separate Codex++ homes.
   - Shared tweaks can be a symlink, but install state must not be shared.

4. Keep renderer APIs structured and bounded.
   - Renderer tweaks should receive typed capability objects.
   - Main owns subprocesses, filesystem, git, and native window calls.
   - Raw IPC/app-server access should stay private until wrappers exist.

5. Prefer read-only product slices first.
   - Git metadata.
   - Runtime health.
   - Goal status.
   - Tweak catalog/trust cards.
   - MCP preview.
   - Project snapshot.

## Hard Constraints

1. Native slash-menu injection is brittle.
   - The menu registry is private React state in hashed chunks.
   - `/goal` should remain a composer-anchored Codex++ overlay.

2. Native git surfaces are useful research, not stable APIs.
   - Desktop has private worker methods for stable metadata, worktrees, review
     diffs, and watchers.
   - Native `status-summary` is count-only and does not provide per-file badges.
   - Codex++ should keep `git-metadata.ts` as the source for sidebar badges.

3. App updates can remove the patch.
   - Sparkle installs a clean signed app.
   - Watcher/repair failures need to be surfaced clearly.
   - Disk integrity does not prove runtime boot.

4. App-server raw access is powerful.
   - Config writes, command exec, MCP OAuth, plugin install, auth, file writes,
     and update/repair need typed wrappers and visible permission states.

5. Large repositories need partial states.
   - Git provider output caps and timeouts mean UI must represent `truncated`
     as partial, not definitive.

## Product Consequences

1. `/goal` should be a built-in Codex++ feature first, then an SDK wrapper.
2. Git sidebar work should ship as read-only metadata and visual badges before
   any mutation.
3. Observability/update health should be first-class because patch drift is a
   normal state, not an exceptional support case.
4. Multi-agent UX should start with ledgers, report inboxes, handoff builders,
   and worktree visibility before automatic spawning/management.
5. Tweak ecosystem work should start local-first: catalog, trust card, update
   details, dev mode, and managed MCP visibility.

