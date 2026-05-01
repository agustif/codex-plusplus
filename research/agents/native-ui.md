# Native-Feeling UI Opportunities

Scope: Codex++ over Codex Desktop, with focus on slash menu, composer, thread
header, sidebar, settings, overlays, and React/fiber seams. This lane only
studied and documented opportunities; no runtime or tweak code was changed.

## 1. Easy Wins

1. Make the `/goal` shim the prototype for a general slash-command registry.
   - Impact: high
   - Effort: small to medium
   - Confidence: high
   - Dependency: Codex++ runtime seam, app-server protocol
   - Notes: `goal-feature.ts` already listens at capture phase, detects
     editable composer targets, renders an anchored suggestion, applies text on
     Tab/Enter, and intercepts `/goal ...` before Codex sends it. Generalize
     that into `api.composer.registerSlashCommand({ name, label, detail,
     run })` instead of keeping `/goal` as a one-off.
   - Native-feeling constraint: keep suggestions anchored to the real composer
     rect, keyboard-first, and visually token-aligned. Do not build a floating
     global command palette until the composer route is proven.

2. Add a composer target helper before adding more composer features.
   - Impact: high
   - Effort: small
   - Confidence: high
   - Dependency: Codex++ runtime seam
   - Notes: today each feature would need to rediscover textarea,
     contenteditable, and `[role="textbox"]` behavior. Promote the existing
     `EditableTarget` logic into a shared private helper, then expose a narrow
     public API later. This reduces duplicate DOM heuristics and keeps future
     composer chips, slash commands, and prompt transforms consistent.
   - Native-feeling constraint: preserve Codex's own input events and selection
     semantics; use the same `InputEvent` pattern already proven by `/goal`.

3. Turn Settings page injection into the stable home for heavier tweak UIs.
   - Impact: high
   - Effort: small
   - Confidence: high
   - Dependency: Codex++ runtime seam
   - Notes: `settings.registerPage` already injects real sidebar entries under
     a "TWEAKS" group and lets page-owning tweaks render full panels. This is
     the right place for feature configuration, keyboard shortcuts, UI
     improvement toggles, slash-command settings, and debug inspectors.
   - Native-feeling constraint: copy Codex's sidebar item classes and token
     variables, but centralize that copying in runtime helpers so tweaks do not
     each clone class strings.

4. Publish a native overlay helper for small transient panels.
   - Impact: medium
   - Effort: small
   - Confidence: high
   - Dependency: Codex++ runtime seam
   - Notes: `/goal` already has a fixed bottom-right panel with actions,
     transient notices, and errors. Make a single overlay host that supports
     anchored composer suggestions, toast-like panels, and modal-ish confirms.
   - Native-feeling constraint: use one z-index owner, escape handling, focus
     return, and collision logic. Multiple tweaks should not independently
     append `z-index: 2147483647` panels to `document.body`.

5. Keep sidebar refinements as token-based DOM marking, not synthetic rewrites.
   - Impact: medium
   - Effort: small
   - Confidence: medium to high
   - Dependency: native Codex seam
   - Notes: Bennett's UI tweak has already proven useful sidebar changes:
     usage in sidebar, matched settings sidebar width, a compact action grid,
     and project row backgrounds. The lowest-risk pattern is to mark existing
     nodes and add token-based CSS. Synthetic replacement buttons should stay
     reserved for features that cannot be expressed by styling existing nodes.

## 2. Medium Bets

1. Add `api.ui` primitives: composer, overlay, sidebar, settings, route.
   - Impact: high
   - Effort: medium
   - Confidence: medium
   - Dependency: Codex++ runtime seam
   - Notes: the public SDK currently exposes `settings`, `react`, `ipc`, `fs`,
     `storage`, `git`, and main-side `codex` hooks, but no first-class UI
     surface beyond Settings. A small `api.ui` would prevent every tweak from
     learning the same fragile Codex DOM.
   - Proposed shape:
     - `api.ui.composer.onCommand(prefix, handler)`
     - `api.ui.overlay.show(anchor | fixed, render, options)`
     - `api.ui.sidebar.findMainSidebar()`
     - `api.ui.route.getThreadId()`
     - `api.ui.settingsSurface.subscribe()`
   - Constraint: keep the first version imperative and DOM-native. Do not
     expose React itself; the current SDK intentionally avoids that.

2. Build a thread header enrichment lane.
   - Impact: high
   - Effort: medium
   - Confidence: medium
   - Dependency: native Codex seam, app-server protocol, React/fiber seam
   - Notes: thread header is the right place for goal status, repo/branch,
     run mode, model, active worktree, and token budget. Today `/goal` floats
     status in an overlay because there is no stable header mount. The next
     slice should identify the header DOM/fiber owner and add a read-only chip
     region before attempting controls.
   - Constraint: header chips must be passive first. Any mutating controls
     should call app-server/runtime APIs and show reversible pending states.

3. Make git metadata visible in the sidebar and thread header.
   - Impact: high
   - Effort: medium
   - Confidence: high for data, medium for native placement
   - Dependency: Codex++ runtime seam, native Codex seam
   - Notes: the git metadata provider already returns structured repo status,
     ahead/behind, diff summary, and linked worktrees without raw diff hunks.
     Use it for a compact branch/dirty header and file/list badges.
   - Constraint: keep mutating git operations out of scope. This should remain
     metadata-only and poll-backed until route and file-list anchors are stable.

4. Provide a fiber-inspector research tweak for Codex UI seams.
   - Impact: medium
   - Effort: medium
   - Confidence: medium
   - Dependency: React/fiber seam
   - Notes: the runtime captures React renderer internals before Codex mounts,
     and exposes `getFiber`, `findOwnerByName`, and `waitForElement`. A
     developer-only inspector could record component names, owner chains, props
     keys, and stable DOM anchors for composer, thread header, sidebar rows,
     settings, and overlays.
   - Constraint: never persist raw prompt text, messages, secrets, or full props
     by default. Store component names and redacted prop-key summaries.

5. Normalize native settings and main-sidebar width/spacing behavior.
   - Impact: medium
   - Effort: medium
   - Confidence: high
   - Dependency: native Codex seam
   - Notes: the default UI tweak already fixes settings sidebar width mismatch
     and layout jumps. Move the underlying measurements and token CSS into a
     reusable runtime helper so other tweaks can mount UI without fighting the
     same shell geometry.

6. Bridge app-server notifications into UI state stores.
   - Impact: medium
   - Effort: medium
   - Confidence: medium
   - Dependency: app-server protocol
   - Notes: `app-server-bridge.ts` can send `mcp-request` messages and receive
     notifications. `/goal` already consumes `thread/goal/updated` and
     `thread/goal/cleared`. A small typed notification registry would let UI
     modules subscribe to thread events without copying response extraction
     logic.
   - Constraint: every request needs timeout, hostId handling, and graceful
     fallback for older Codex/app-server builds.

## 3. Moonshots

1. Native command palette augmentation.
   - Impact: moonshot
   - Effort: large
   - Confidence: low to medium
   - Dependency: React/fiber seam, native Codex seam
   - Notes: instead of building a separate palette, locate Codex's existing
     command bar (`Cmd+K` is seeded by the keyboard tweak) and append Codex++
     actions into the same command model. This would feel more native than a
     duplicate overlay, but it requires stronger fiber or app-state access.

2. First-class right-side inspector panel.
   - Impact: moonshot
   - Effort: large
   - Confidence: medium
   - Dependency: main Codex window/view services
   - Notes: main-side `codex.createBrowserView` and `codex.createWindow` can
     create Codex-routed surfaces through Desktop's own window services. A
     persistent inspector panel could show goal, git, task DAG, run logs, and
     tweak debug state without crowding the chat.
   - Constraint: BrowserView lifecycle, focus, route sync, and parent window
     resizing need proof before exposing this to general tweak authors.

3. Semantic UI hook registry for Codex Desktop.
   - Impact: moonshot
   - Effort: large
   - Confidence: medium
   - Dependency: React/fiber seam
   - Notes: maintain a versioned map of native surfaces: composer, header,
     thread list, file tree, message row, settings sidebar, popover/menu root.
     Each entry would have selectors, text heuristics, fiber owner names, and
     screenshot proof for the current Codex Desktop build.
   - Constraint: must be generated or verified by a small inspector/test suite,
     not hand-maintained forever.

4. Tweak-owned mini apps using native Codex routes.
   - Impact: moonshot
   - Effort: large
   - Confidence: low
   - Dependency: main Codex window/view services, app-server protocol
   - Notes: create routed native-feeling Codex++ surfaces for task graphs,
     screenshots, review queue, and automation dashboards. This is possible if
     window services stay available, but it is a later bet after overlay and
     settings primitives are stable.

## 4. Constraints And Evidence Anchors

1. Codex++ currently injects through Electron preload, not source patches.
   - Evidence: `docs/ARCHITECTURE.md:47-75` describes loader, main runtime,
     renderer preload, settings injector, and tweak host boot.
   - Evidence: `docs/ARCHITECTURE.md:87-90` says Codex is a Vite/Rollup build
     with no exposed module registry, so preload plus DOM observation is the
     intended stability boundary.

2. The runtime reaches every sandboxed renderer through Electron preload.
   - Evidence: `packages/runtime/src/main.ts:351-384` uses
     `session.registerPreloadScript` with a `setPreloads` fallback.
   - Evidence: `packages/runtime/src/main.ts:395-414` logs new webContents and
     preload errors, including sandbox/contextIsolation status.
   - Evidence: local `main.log` on 2026-05-01 shows sandboxed renderer windows
     and successful `registerPreloadScript` registration.

3. Renderer tweaks are sandboxed and evaluated from source strings.
   - Evidence: `packages/runtime/src/preload/tweak-host.ts:1-13` explains that
     Codex renderers run with `sandbox: true`, so arbitrary disk `require()` is
     unavailable and tweak source is evaluated in preload context.
   - Evidence: `packages/runtime/src/preload/tweak-host.ts:104-123` reads tweak
     source via IPC and evaluates it with `new Function`.

4. Settings is currently the strongest native UI surface.
   - Evidence: `packages/runtime/src/preload/settings-injector.ts:1-21` says
     Codex settings is a routed page, not a modal, and the injector finds the
     sidebar by known labels because there are no stable role/testid hooks.
   - Evidence: `packages/runtime/src/preload/settings-injector.ts:169-200`
     observes DOM and history navigation to inject/reinject settings UI.
   - Evidence: `packages/runtime/src/preload/settings-injector.ts:298-371`
     injects a "Codex++" sidebar group with Config and Tweaks entries.
   - Evidence: `packages/runtime/src/preload/settings-injector.ts:431-495`
     lazily injects a per-tweak "TWEAKS" group for `registerPage`.
   - Evidence: `packages/runtime/src/preload/settings-injector.ts:497-510`
     copies Codex sidebar item classes for native visual fit.

5. The composer/slash seam is real but currently private and goal-specific.
   - Evidence: `packages/runtime/src/preload/goal-feature.ts:36-78` installs
     capture listeners and app-server goal notifications.
   - Evidence: `packages/runtime/src/preload/goal-feature.ts:80-119`
     intercepts Tab/Enter and `/goal` submissions before Codex handles them.
   - Evidence: `packages/runtime/src/preload/goal-feature.ts:397-448` renders
     a suggestion anchored to the editable target's bounding rect.
   - Evidence: `packages/runtime/src/preload/goal-feature.ts:594-644`
     supports textarea, text/search input, contenteditable, and `[role=textbox]`.
   - Evidence: `packages/runtime/src/preload/goal-feature.ts:656-670`
     derives thread id from route, hash, href, `initialRoute`, and history
     state.

6. App-server bridge exists and should be reused for thread-native state.
   - Evidence: `packages/runtime/src/preload/app-server-bridge.ts:29-66`
     sends `mcp-request` envelopes through `codex_desktop:message-from-view`
     with request ids, hostId, and timeout handling.
   - Evidence: `packages/runtime/src/preload/app-server-bridge.ts:68-118`
     subscribes to `codex_desktop:message-for-view`, extracts notifications,
     and resolves responses.
   - Evidence: extracted installed `preload.js` from Codex Desktop
     `26.429.20946` exposes `electronBridge.sendMessageFromView` on the same
     channel and dispatches incoming app-server messages to `window`.

7. React/fiber seam is available but unstable by nature.
   - Evidence: `packages/runtime/src/preload/react-hook.ts:1-10` installs a
     React DevTools-shaped hook to capture renderer internals before mount.
   - Evidence: `packages/runtime/src/preload/react-hook.ts:88-102` resolves a
     fiber from renderer internals or `__reactFiber*` DOM properties.
   - Evidence: `packages/runtime/src/preload/tweak-host.ts:177-205` exposes
     `getFiber`, `findOwnerByName`, and `waitForElement` to renderer tweaks.
   - Constraint: fiber names and owner chains can change on Codex updates, so
     this is best for discovery and guarded enrichments, not the first line of
     production UI integration.

8. Sidebar DOM is useful but brittle.
   - Evidence: Bennett's installed UI tweak documents that Codex's shell lacks
     stable testids/aria labels for many widgets and uses text-content matching
     for resilience.
   - Evidence: installed `co.bennett.ui-improvements/index.js:173-180` ranks
     sidebar candidates by geometry and semantic hints.
   - Evidence: installed `co.bennett.ui-improvements/index.js:1566-1575`
     describes project rows as `div[role=listitem]` with `group/cwd` classes
     and favors marking existing nodes plus token CSS.

9. Native app window/view services are already partially exposed to main tweaks.
   - Evidence: `packages/runtime/src/main.ts:907-935` creates BrowserViews
     through Codex window services and registers them with the window manager.
   - Evidence: `packages/runtime/src/main.ts:937-988` creates/focuses native
     Codex windows by route, hostId, appearance, parent, and bounds.
   - Constraint: this is powerful but main-process-only and must remain behind
     explicit capabilities because it can affect focus, windows, and app chrome.

10. Existing default tweaks are already pushing toward native UI.
    - Evidence: local `main.log` shows two installed tweaks:
      `co.bennett.custom-keyboard-shortcuts` and `co.bennett.ui-improvements`.
    - Evidence: `co.bennett.custom-keyboard-shortcuts/index.js:1-29` discovers,
      remaps, and disables shortcuts, while explicitly excluding native app-menu
      accelerators from renderer scope.
    - Evidence: `co.bennett.custom-keyboard-shortcuts/index.js:111-146` seeds
      shortcuts including sidebar, command bar, settings, model picker, terminal,
      file tree, and send message.

## 5. Recommended UI Strategy

1. Treat Settings as the stable configuration plane.
   - Keep all heavy tweak UI in `registerPage` surfaces.
   - Move copied classes and token styling into runtime helpers.
   - Add screenshot-based proof for settings pages whenever pixels change.

2. Promote `/goal` into a small composer/slash-command platform.
   - First extract private shared helpers: editable target, thread id, anchored
     suggestion root, keyboard interception, and app-server error handling.
   - Then expose a narrow `api.ui.composer` registry to tweaks.
   - Start with read-only or app-server-backed commands; avoid command actions
     that synthesize arbitrary chat sends.

3. Build one overlay manager before adding more overlays.
   - Centralize z-index, focus return, escape behavior, collision positioning,
     and cleanup.
   - Use it for slash suggestions, goal panels, warning notices, and future
     mini inspectors.

4. Use native DOM first, fiber second, source patching never by default.
   - DOM/text/role geometry is best for broad compatibility.
   - Fiber is best for finding better anchors and reading stable prop keys.
   - Source patching is last resort because Codex's bundle is minified and
     update-sensitive.

5. Add a discovery harness before deeper native UI work.
   - A developer-only tweak should inspect composer, header, sidebar, settings,
     message rows, and popovers, then write redacted evidence under
     `research/evidence/`.
   - It should record selectors, bounding boxes, owner component names, and
     screenshots, not raw user content.

6. Next implementation slice:
   - Implement internal shared composer helpers from `goal-feature.ts`.
   - Add an internal overlay host and migrate `/goal` to it.
   - Add a dev-only fiber/DOM evidence tweak for thread header and sidebar
     anchors.
   - After screenshots prove those anchors, expose `api.ui.composer` and
     `api.ui.overlay` in the SDK.
