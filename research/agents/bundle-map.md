# Codex Desktop Bundle And UI Surface Map

Owner scope: recovered integration note for the read-only bundle/UI
reverse-engineering lanes. Evidence came from the installed stable and beta
Codex app bundles plus the agent reports returned in the thread.

## 1. Evidence Baseline

1. Stable app:
   - Path: `/Applications/Codex.app`.
   - Bundle id: `com.openai.codex`.
   - Version: `26.429.20946`.
   - Build: `2312`.
   - Embedded CLI: `codex-cli 0.128.0-alpha.1`.

2. Beta app:
   - Path: `/Applications/Codex (Beta).app`.
   - Bundle id: `com.openai.codex.beta`.
   - Version: `26.429.21146`.
   - Build: `2317`.
   - Embedded CLI: `codex-cli 0.128.0-alpha.1`.

3. Both bundles use the same Vite/asar shape, but chunk hashes differ. Any
   integration that targets hashed chunk names must be treated as release-local
   evidence, not a stable contract.

## 2. Key Chunks

Stable app chunks observed with `npx asar list`:

- Composer: `/webview/assets/composer-B5UwBne4.js`.
- Rich editor, sidebar, file tree, and model settings: `/webview/assets/use-model-settings-D_GIIENF.js`.
- Thread header: `/webview/assets/thread-page-header-BE4NuQx7.js`.
- Settings shell: `/webview/assets/settings-page-D8hwzVMU.js`.
- Settings sections: `/webview/assets/settings-sections-0MrNUF6p.js`.
- App-server manager hooks/signals: `/webview/assets/app-server-manager-hooks-DEjiw62x.js`, `/webview/assets/app-server-manager-signals-B_sRWyjv.js`.
- Config and feature queries: `/webview/assets/config-queries-C-qINdQW.js`, `/webview/assets/experimental-features-queries-CNZ33-q_.js`.
- MCP settings: `/webview/assets/mcp-settings-Cra-v5Bl.js`.
- Worktree UI: `/webview/assets/worktree-DpJJHWcT.js`, `/webview/assets/worktrees-settings-page-nrR4SaaQ.js`.
- Review UI: `/webview/assets/review-conversation-files-model-RS7Qf2Dn.js`, `/webview/assets/review-runtime-bridge-BmeBHgt2.js`.

## 3. Best Immediate Wins

1. Use Codex++ settings pages for admin/product surfaces.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.
   - Reason: Settings has an existing Codex++ injection path. It avoids bundle
     string patching and keeps product UI under a Codex++ owned root.

2. Use a composer-anchored `/goal` overlay instead of native slash-menu
   injection.
   - Impact: high.
   - Effort: small.
   - Confidence: medium-high.
   - Dependency: Codex++ preload plus app-server protocol.
   - Reason: the composer is ProseMirror, not a textarea. The native slash menu
     is populated through private React hooks/signals in hashed chunks. A
     Codex++ overlay can observe the editor and own its DOM.

3. Use sidebar project/thread data attributes for read-only badges.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium-high.
   - Dependency: Codex++ runtime seam.
   - Useful selectors from the read-only pass:
     - `[data-app-action-sidebar-scroll]`
     - `[data-app-action-sidebar-section]`
     - `[data-app-action-sidebar-project-row]`
     - `[data-app-action-sidebar-thread-row]`
   - Reason: these are better anchors than minified component names.

4. Treat the file tree as a harder surface.
   - Impact: high.
   - Effort: medium-large.
   - Confidence: medium.
   - Dependency: native Codex seam plus Codex++ git metadata.
   - Evidence: the file tree uses a virtualized custom/shadow surface with
     `data-file-tree-virtualized="true"`.
   - Recommendation: start with an outside-panel changed-files list and sidebar
     header badges before mutating virtualized rows.

## 4. Constraints And Exact Evidence

1. The composer is ProseMirror.
   - Stable selector from the read-only pass:
     `.ProseMirror[data-codex-composer="true"][data-virtualkeyboard="true"]`.
   - Do not set `.textContent` directly. Use passive reads, external UI, and
     carefully scoped keyboard handling only while the Codex++ overlay is open.

2. Native slash menu is not safely extensible today.
   - The native command registry is private to minified React chunks.
   - No public global, module registry, or app-server command-registration API
     was found.
   - Replacing or mutating native rows would be brittle across stable/beta.

3. React fiber is an inspection aid, not an extension contract.
   - Safe: read owner props for diagnostics, prefer stable DOM attributes, mount
     Codex++ UI in its own root, and clean up observers/listeners.
   - Unsafe: mutate fibers, refs, ProseMirror state, minified function state, or
     native component props.

4. Stable and beta differ by chunk hashes.
   - Product features should avoid hard-coded chunk filenames. Keep chunk names
     in research artifacts for local evidence only.

## 5. Suggested Next Slice

1. Keep `/goal` as a Codex++ command overlay:
   - Observe the ProseMirror composer.
   - Show a small suggestion when the current token is `/g`, `/go`, `/goal`, or
     `/goal `.
   - Complete on Tab/click and execute on exact `/goal` Enter.
   - Yield when the native slash menu/dialog is visible.

2. Build sidebar git awareness in layers:
   - Project header branch/dirty/ahead-behind.
   - Changed-files panel.
   - File row badges only after shadow/virtualized row behavior is tested.

3. Put support/admin tools in Settings first:
   - Recovery Center.
   - Observability page.
   - Tweak Center.
   - Project Snapshot page.

