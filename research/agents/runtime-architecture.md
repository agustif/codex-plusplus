# Runtime Architecture And Extension Contracts

Scope: ordered architecture/product notes for Codex++ extension contracts,
missing abstractions, capability registry shape, SDK/API opportunities, and
platform risks. This is based on the current working tree, including in-flight
runtime changes under `packages/runtime` and `packages/sdk`.

## 1. Current Architecture Facts

1. Codex++ is an Electron app patch plus user-dir runtime, not a rebuilt Codex
   distribution.
   - The product README says the installer locates Codex.app, backs it up,
     patches `app.asar`, recomputes `ElectronAsarIntegrity`, flips the embedded
     asar integrity fuse, ad-hoc signs the app on macOS, and installs a watcher
     for repair after Codex updates. Evidence: `README.md:46-58`.
   - The architecture doc shows `app.asar`'s `package.json#main` pointing to
     `codex-plusplus-loader.cjs`, which then loads `<user-data-dir>/runtime`.
     Evidence: `docs/ARCHITECTURE.md:3-35`.

2. The runtime has two extension execution planes: main process and renderer
   preload.
   - Main boot validates required env vars, sets user/runtime paths, creates
     tweak/log directories, and imports discovery, lifecycle, MCP sync, storage,
     watcher health, and git metadata modules. Evidence:
     `packages/runtime/src/main.ts:10-27`, `packages/runtime/src/main.ts:28-51`.
   - Renderer boot installs the React hook, starts the built-in goal feature,
     starts settings injection, starts the renderer tweak host, mounts the
     manager, and subscribes to hot reload. Evidence:
     `packages/runtime/src/preload/index.ts:43-57`,
     `packages/runtime/src/preload/index.ts:67-103`.

3. Tweak discovery is folder-and-manifest based.
   - Discovery scans `<userRoot>/tweaks`, requires `manifest.json`, validates
     required fields, resolves `manifest.main` or `index.js`/`index.cjs`/
     `index.mjs`, and silently skips invalid entries. Evidence:
     `packages/runtime/src/tweak-discovery.ts:22-41`,
     `packages/runtime/src/tweak-discovery.ts:44-61`.
   - The public manifest contract lives in SDK types and currently covers id,
     name, version, `githubRepo`, metadata, scope, entry, MCP server, and
     permissions. Evidence: `packages/sdk/src/index.ts:9-51`.

4. Tweak lifecycle is reload-oriented, not per-capability or per-resource.
   - Main reload stops all main tweaks, clears tweak module cache, reloads all
     main tweaks, then broadcasts a renderer reload. Evidence:
     `packages/runtime/src/tweak-lifecycle.ts:19-25`,
     `packages/runtime/test/tweak-lifecycle.test.ts:20-32`.
   - The filesystem watcher debounces changes under the tweak directory and
     delegates to that same reload sequence. Evidence:
     `packages/runtime/src/main.ts:598-628`.

5. Renderer tweaks are evaluated from source strings in preload.
   - The runtime cannot require arbitrary tweak files from sandboxed renderers,
     so main reads the tweak source and preload evaluates it with `new Function`.
     Evidence: `packages/runtime/src/preload/tweak-host.ts:1-13`,
     `packages/runtime/src/preload/tweak-host.ts:104-130`.
   - This means renderer tweak dependencies must be bundled ahead of time, and
     runtime isolation is a policy problem, not just a package format problem.

6. Settings UI is an injected DOM surface with weak native anchors.
   - The settings injector explicitly documents that Codex settings are a routed
     page with no stable `role`, `aria-label`, or `data-testid` hooks, so it
     identifies the sidebar by text/content heuristics. Evidence:
     `packages/runtime/src/preload/settings-injector.ts:1-21`.
   - Registered sections and pages are tracked in renderer state and remounted
     into Codex++ settings surfaces. Evidence:
     `packages/runtime/src/preload/settings-injector.ts:106-129`,
     `packages/runtime/src/preload/settings-injector.ts:224-288`.

7. MCP, git metadata, and goals are already emerging as platform capabilities.
   - Enabled tweaks with manifest `mcp` can sync managed MCP server entries into
     `~/.codex/config.toml` while preserving user-managed servers. Evidence:
     `packages/runtime/src/main.ts:680-698`,
     `packages/runtime/src/mcp-sync.ts:26-43`,
     `packages/runtime/src/mcp-sync.ts:45-80`.
   - Git metadata is a main-process provider exposed through renderer IPC when
     the manifest declares `git.metadata`. Evidence:
     `packages/runtime/src/git-metadata.ts:154-249`,
     `packages/runtime/src/preload/tweak-host.ts:160-218`.
   - `/goal` is a built-in preload feature using a private app-server bridge to
     `thread/goal/*` calls and notifications. Evidence:
     `packages/runtime/src/preload/app-server-bridge.ts:29-66`,
     `packages/runtime/src/preload/app-server-bridge.ts:86-174`,
     `packages/runtime/src/preload/goal-feature.ts:36-78`,
     `packages/runtime/src/preload/goal-feature.ts:344-360`.

## 2. Extension Contract Gaps To Close First

1. Add one canonical extension descriptor and validation path.
   - Current state: SDK validation and runtime discovery both validate
     manifests, but discovery reimplements a smaller validator and does not call
     `validateTweakManifest`. Evidence: `packages/sdk/src/index.ts:96-188`,
     `packages/runtime/src/tweak-discovery.ts:44-49`.
   - Product risk: a tweak can pass one path and fail or silently disappear in
     another. Silent skipping is acceptable for malformed folders, but authors
     need a reasoned diagnostic model.
   - Proposed contract: `ExtensionDescriptor = { manifest, dir, entry,
     validation, runtimeCompatibility, capabilities }`, produced once by shared
     SDK/runtime code and consumed by manager, lifecycle, MCP sync, CLI validate,
     and docs.
   - Priority: high. Effort: medium. Confidence: high. Dependency:
     Codex++ runtime seam.

2. Enforce `minRuntime` and version compatibility.
   - Current state: `minRuntime` exists in the manifest type and docs, but the
     runtime discovery and loader do not enforce it. Evidence:
     `packages/sdk/src/index.ts:38-43`,
     `docs/WRITING-TWEAKS.md:59-62`,
     `packages/runtime/src/tweak-discovery.ts:44-49`.
   - Product risk: incompatible tweaks can fail at `start()` time, where the
     failure is harder to explain and may leave partial UI/IPC state behind.
   - Proposed contract: discovery should mark incompatible tweaks as discovered
     but disabled with a precise reason, so Settings can show "requires runtime
     >= X" rather than "missing entry" or nothing.
   - Priority: high. Effort: small. Confidence: high. Dependency:
     Codex++ runtime seam.

3. Make permission declarations executable policy, not only metadata.
   - Current state: SDK validates known permissions. Evidence:
     `packages/sdk/src/index.ts:64-83`,
     `packages/sdk/src/index.ts:169-180`,
     `packages/sdk/test/manifest-validation.test.ts:73-88`.
   - Current enforcement is partial: renderer `api.git` is attached only when
     `git.metadata` is declared, but `settings`, `ipc`, and `fs` are always
     present in renderer API, and main-scope tweaks receive `ipc`, `fs`, `git`,
     and `codex` without visible per-permission gating. Evidence:
     `packages/runtime/src/preload/tweak-host.ts:160-218`,
     `packages/runtime/src/main.ts:653-667`.
   - Product risk: permission review cards and manifest metadata will overstate
     real enforcement. This matters before a public tweak ecosystem forms.
   - Proposed contract: every API factory should require a capability decision
     object: `{ granted, reason, source, risk }`. Missing permissions should
     produce absent APIs plus manager warnings.
   - Priority: high. Effort: medium. Confidence: high. Dependency:
     Codex++ runtime seam.

4. Split extension identity from process lifecycle.
   - Current state: `scope` is `"renderer" | "main" | "both"`, and `"both"`
     means `start(api)` is called once per process. Evidence:
     `packages/sdk/src/index.ts:53-55`,
     `packages/sdk/src/index.ts:257-284`,
     `docs/WRITING-TWEAKS.md:71-76`.
   - Product risk: cross-process extensions have to hand-roll coordination over
     ad hoc IPC. The runtime cannot tell which half owns durable state,
     background tasks, settings pages, or MCP tools.
   - Proposed contract: add process components under one extension id:
     `components: { renderer?: RendererEntrypoint, main?: MainEntrypoint,
     mcp?: McpEntrypoint }`, with explicit dependencies and teardown ordering.
   - Priority: medium-high. Effort: large. Confidence: medium. Dependency:
     Codex++ runtime seam.

5. Replace untyped string IPC with a scoped contract registry.
   - Current state: tweak IPC namespaces channels by id, but channel payloads
     and handlers are untyped. Evidence:
     `packages/sdk/src/index.ts:370-377`,
     `packages/runtime/src/preload/tweak-host.ts:206-215`,
     `packages/runtime/src/main.ts:868-885`.
   - Product risk: API drift appears only at runtime, and one half of a `"both"`
     tweak can register stale handlers after reload if teardown is incomplete.
   - Proposed contract: SDK helper for `defineIpcContract({ methods, events })`
     with runtime validation, duplicate handler protection, and unload cleanup.
   - Priority: medium. Effort: medium. Confidence: high. Dependency:
     Codex++ runtime seam.

6. Make storage semantics consistent across processes.
   - Current state: main storage is disk-backed with debounced atomic writes,
     while renderer storage uses `localStorage`. Evidence:
     `packages/runtime/src/storage.ts:1-7`,
     `packages/runtime/src/storage.ts:27-87`,
     `packages/runtime/src/preload/tweak-host.ts:221-245`.
   - Documentation drift: current docs still say main storage is in-memory and
     will move to disk later. Evidence: `docs/WRITING-TWEAKS.md:103-106`.
   - Product risk: users and tweak authors cannot reason about backup, sync,
     deletion, corruption, and privacy if renderer/main data stores differ.
   - Proposed contract: one `api.storage` implementation backed by main process
     for both renderer and main, with optional `sessionStorage` or `uiState`
     namespaces when renderer-local state is intentional.
   - Priority: medium-high. Effort: medium. Confidence: high. Dependency:
     Codex++ runtime seam.

## 3. Capability Registry Shape

1. Registry goal.
   - Build a central registry that maps declarative manifest permissions to
     concrete runtime APIs, settings UI copy, validation errors, process
     availability, and platform risk.
   - This should become the single source for SDK types, CLI validation,
     Settings permission review, runtime API factories, and release notes.

2. Minimum registry fields.
   - `id`: stable capability id, for example `settings.page`, `ipc.scoped`,
     `fs.tweakData`, `git.metadata`, `codex.window`, `codex.view`,
     `mcp.server`, `appServer.goal`, `network.githubReleases`.
   - `permission`: manifest permission string if user-authorized, or `internal`
     for built-in runtime features.
   - `processes`: `renderer`, `main`, or both.
   - `apiFactory`: function that builds the API or returns a denied reason.
   - `risk`: short user-facing description of what the capability can observe
     or mutate.
   - `proof`: diagnostic status for manager UI, for example available,
     unavailable on this Codex build, denied by manifest, denied by safe mode,
     or failed to initialize.
   - `tests`: required test anchors for validation.

3. Initial registry rows.
   - `settings.page`: renderer; permission `settings`; backs
     `api.settings.register` and `api.settings.registerPage`. Evidence:
     `packages/sdk/src/index.ts:300-341`,
     `packages/runtime/src/preload/tweak-host.ts:172-176`.
   - `ipc.scoped`: both; permission `ipc`; backs namespaced tweak channels.
     Evidence: `packages/sdk/src/index.ts:370-377`,
     `packages/runtime/src/preload/tweak-host.ts:206-215`,
     `packages/runtime/src/main.ts:868-885`.
   - `fs.tweakData`: both; permission `filesystem`; backs per-tweak data
     directory only. Evidence: `packages/sdk/src/index.ts:379-385`,
     `packages/runtime/src/main.ts:535-552`,
     `packages/runtime/src/main.ts:888-905`.
   - `git.metadata`: both eventually, renderer-gated now; permission
     `git.metadata`; backs repository resolution, status, diff summary, and
     worktree metadata. Evidence: `packages/sdk/src/index.ts:387-392`,
     `packages/runtime/src/git-metadata.ts:130-135`,
     `packages/runtime/src/preload/tweak-host.ts:261-271`.
   - `codex.window`: main; permission should map to `codex.windows`; backs
     Codex window creation through native private services. Evidence:
     `packages/sdk/src/index.ts:64-83`,
     `packages/runtime/src/main.ts:937-988`.
   - `codex.view`: main; permission should map to `codex.views`; backs
     embedded `BrowserView` creation and registration. Evidence:
     `packages/runtime/src/main.ts:907-935`,
     `packages/runtime/src/main.ts:991-1037`.
   - `mcp.server`: main/internal plus manifest declaration; backs managed MCP
     config generation from `manifest.mcp`. Evidence:
     `packages/sdk/src/index.ts:45-51`,
     `packages/runtime/src/mcp-sync.ts:56-80`.
   - `appServer.goal`: internal for now; backs the built-in `/goal` feature.
     Evidence: `packages/runtime/src/preload/app-server-bridge.ts:29-66`,
     `packages/runtime/src/preload/goal-feature.ts:187-231`.

4. UI consequence.
   - The Tweak Manager should not only show "loaded" or "missing entry".
     Current minimal manager rendering lists name, version, description, and
     entry state. Evidence: `packages/runtime/src/preload/manager.ts:12-75`.
   - It should show capability rows: requested, granted, unavailable, and
     why. That makes the extension system reviewable before installs become
     one-click.

## 4. SDK/API Opportunities

1. Add `defineTweak` and make docs true.
   - Current docs import `defineTweak`, but SDK does not export it in the
     inspected source. Evidence: `docs/WRITING-TWEAKS.md:159-176`,
     `packages/sdk/src/index.ts:252-284`.
   - Ship a zero-runtime helper first:
     `defineTweak<T extends Tweak>(tweak: T): T`.
   - Priority: high. Effort: small. Confidence: high.

2. Provide a buildable TypeScript tweak starter.
   - Current `create-tweak` writes CommonJS `index.js`, a private package, and
     SDK `^0.1.3` dependency. Evidence:
     `packages/installer/src/commands/create-tweak.ts:55-68`,
     `packages/installer/src/commands/create-tweak.ts:87-151`.
   - Product opportunity: `codexplusplus create-tweak --template ts` should
     produce `src/index.ts`, `tsconfig.json`, a bundler script, `validate`, and
     a generated manifest. This directly removes the gap created by preload
     source evaluation and bundled-dependency requirements.
   - Priority: high. Effort: small-medium. Confidence: high.

3. Export typed platform clients instead of raw optional bags.
   - Current `TweakApi` exposes optional `settings`, `react`, `codex`, and `git`
     based on process/capability. Evidence: `packages/sdk/src/index.ts:262-284`.
   - Opportunity: add process-specific SDK entrypoints:
     `defineRendererTweak`, `defineMainTweak`, `defineDualTweak`. These helpers
     can narrow available APIs, require declared capabilities, and reduce
     runtime "undefined API" failures.
   - Priority: medium-high. Effort: medium. Confidence: high.

4. Promote `app-server` bridge into a guarded internal API, then decide whether
   to expose it.
   - Current bridge is functional but private and message-shape tolerant.
     Evidence: `packages/runtime/src/preload/app-server-bridge.ts:29-66`,
     `packages/runtime/src/preload/app-server-bridge.ts:120-174`.
   - Product opportunity: start with internal typed clients for `thread.goal`.
     If stable across Codex Desktop builds, expose read-only thread context and
     goal APIs to tweaks behind a new permission such as `codex.threadMetadata`.
   - Priority: medium. Effort: medium. Confidence: medium.

5. Add watch/event APIs for metadata surfaces.
   - Current git metadata is request/response only. Evidence:
     `packages/sdk/src/index.ts:387-392`,
     `packages/runtime/src/git-metadata.ts:130-135`.
   - Existing research asks for event-first, poll-backed sidebar refresh.
     Evidence: `docs/GIT_METADATA_SIDEBAR.md:76-88`,
     `research/agents/git-sidebar.md:183-207`.
   - Product opportunity: `api.git.watchStatus(root, callback)` or runtime
     event hooks would prevent every sidebar/page tweak from inventing its own
     polling policy.
   - Priority: medium. Effort: medium-large. Confidence: medium.

6. Add platform component APIs for Settings UI.
   - Current settings rendering is imperative DOM. Evidence:
     `packages/sdk/src/index.ts:319-341`,
     `docs/WRITING-TWEAKS.md:77-91`.
   - Product opportunity: a tiny SDK component kit for cards, rows, toggles,
     badges, empty/error states, permission rows, and links would keep tweaks
     visually consistent without exposing Codex's React runtime.
   - Priority: medium. Effort: medium. Confidence: high.

7. Turn MCP-backed tweaks into an install/status product.
   - Current sync creates managed config blocks and skips conflicting
     user-managed server names. Evidence:
     `packages/runtime/src/mcp-sync.ts:45-80`,
     `packages/runtime/test/mcp-sync.test.ts:47-65`,
     `packages/runtime/test/mcp-sync.test.ts:68-133`.
   - Product opportunity: Settings should show which MCP servers an extension
     declares, whether each was synced, skipped, or invalid, and the exact
     generated server name. This is a high-leverage bridge from "DOM tweaks" to
     real Codex tool extensions.
   - Priority: high. Effort: small-medium. Confidence: high.

## 5. Platform Risks

1. Native Codex UI selectors are brittle.
   - Settings injection depends on current text and DOM shape, not stable
     first-party extension points. Evidence:
     `packages/runtime/src/preload/settings-injector.ts:1-21`,
     `packages/runtime/src/preload/settings-injector.ts:1666-1695`.
   - Risk response: every injected surface should have an availability probe,
     a visible fallback in manager/doctor, and screenshot-based verification
     after Codex Desktop updates.

2. Preload execution is powerful and currently trust-based.
   - Renderer tweaks are source strings evaluated with `new Function` in the
     preload context. Evidence:
     `packages/runtime/src/preload/tweak-host.ts:104-130`.
   - Risk response: before broad distribution, introduce permission-enforced
     API construction, extension trust/source metadata, and at least a
     "review local code before enabling" flow. Do not imply this is a browser
     sandbox.

3. Private app-server protocol can drift.
   - The bridge accepts multiple response/notification shapes, which is useful
     but proves this is not a formal public API. Evidence:
     `packages/runtime/src/preload/app-server-bridge.ts:120-174`.
   - Risk response: build feature probes per method, fail closed, and keep
     app-server integrations internal until several Codex Desktop versions are
     validated.

4. Private window services can disappear or change.
   - `makeCodexApi()` depends on a global `__codexpp_window_services__` object
     and native service methods. Evidence:
     `packages/runtime/src/main.ts:907-948`,
     `packages/runtime/src/main.ts:1046-1049`.
   - Risk response: expose `codex.window`/`codex.view` as optional
     capabilities with detailed unavailable reasons instead of assuming a
     reinstall fixes every failure.

5. Main-process APIs need path containment hardening everywhere.
   - Renderer source and asset reads have containment checks. Evidence:
     `packages/runtime/src/main.ts:474-483`,
     `packages/runtime/src/main.ts:485-524`.
   - Renderer `tweak-fs` rejects ids and `..`, but main `makeMainFs` joins
     paths directly under the data dir without the same containment guard.
     Evidence: `packages/runtime/src/main.ts:535-552`,
     `packages/runtime/src/main.ts:888-905`.
   - Risk response: centralize `resolveTweakDataPath(id, relPath)` and use it
     for main and renderer filesystem APIs.

6. Docs and generated assets can drift from source.
   - Current docs say main storage is in-memory even though source shows
     disk-backed storage. Evidence: `docs/WRITING-TWEAKS.md:103-106`,
     `packages/runtime/src/storage.ts:1-7`.
   - Tests already compare source and bundled runtime for reload behavior,
     showing this repo has prior drift concerns between TS source and bundled
     installer assets. Evidence:
     `packages/runtime/test/main-toggle-reload.test.ts:6-16`,
     `packages/runtime/test/main-toggle-reload.test.ts:24-98`.
   - Risk response: add contract tests for public docs snippets, SDK exports,
     and generated runtime assets, or make docs generated from SDK metadata.

7. Release/update trust is advisory today.
   - Tweak updates are checked against GitHub Releases but not installed
     automatically. Evidence: `docs/WRITING-TWEAKS.md:63-68`,
     `packages/runtime/src/main.ts:757-788`,
     `packages/runtime/src/main.ts:790-828`.
   - Risk response: keep auto-install out of scope until there is signed
     package metadata, ownership continuity checks, hash pinning, and rollback.

## 6. Ordered Product Plan

1. Capability registry plus permission review card.
   - Behavior: Settings shows every requested capability, grant status, risk
     text, and unavailable reasons.
   - Why first: this turns the extension system from "trust this folder" into a
     reviewable platform while reusing existing manifest permissions.
   - Acceptance: a tweak with `git.metadata`, `mcp`, `settings`, `ipc`, and
     missing `minRuntime` renders a precise capability table; disabling a
     permission removes the API from the relevant process.
   - Impact: high. Effort: medium. Confidence: high.

2. Canonical descriptor and compatibility diagnostics.
   - Behavior: discovery returns valid, invalid, disabled, incompatible, and
     missing-entry tweaks with structured reasons.
   - Why second: every higher-level UI, CLI, and SDK workflow depends on not
     silently losing extensions.
   - Acceptance: `validate-tweak`, runtime discovery, and manager show the same
     errors for malformed permissions, MCP config, entry path, and min runtime.
   - Impact: high. Effort: medium. Confidence: high.

3. SDK ergonomics release.
   - Behavior: export `defineTweak`, process-specific helpers, typed IPC
     contracts, and a buildable TypeScript starter.
   - Why third: once contracts are real, make the happy path hard to misuse.
   - Acceptance: `codexplusplus create-tweak --template ts` creates a tweak
     that builds, validates, loads in renderer/main as selected, and uses SDK
     types without docs-only imports.
   - Impact: high. Effort: medium. Confidence: high.

4. MCP extension status.
   - Behavior: manager shows declared MCP servers, generated names, sync state,
     conflict/skipped state, and config path.
   - Why fourth: MCP is the clearest bridge from tweak UI to Codex tool
     capability, and the underlying sync is already implemented.
   - Acceptance: tests cover synced, skipped, removed, malformed, relative
     server script, and no-MCP cases; Settings mirrors those states.
   - Impact: high. Effort: small-medium. Confidence: high.

5. Internal app-server client boundary.
   - Behavior: built-in goals and future thread/project features use a typed
     app-server client with feature probes and fail-closed states.
   - Why fifth: `/goal` is valuable but private protocol drift is a platform
     risk. Stabilize the internal boundary before exposing it to third-party
     tweaks.
   - Acceptance: current goal flows work on the known app-server build, and
     unsupported builds produce one visible unsupported state without repeated
     errors.
   - Impact: high. Effort: medium. Confidence: medium.

6. Read-only project metadata platform.
   - Behavior: first-party or default tweak can render project snapshot,
     sidebar badges, diff footer, and worktree state from `api.git`.
   - Why sixth: git metadata is already intentionally read-only and matches the
     user's high-value workflow, but should depend on the capability registry
     and event/watch policy to avoid N independent polling loops.
   - Acceptance: clean repo, dirty repo, initial commit, detached HEAD, bare
     repo, non-repo path, linked worktree, and truncated-output states are all
     visibly distinct.
   - Impact: high. Effort: medium. Confidence: high.

## 7. Suggested Next Slice

Implement the registry/descriptor foundation before adding new user-facing
capabilities:

1. Introduce `packages/sdk/src/capabilities.ts` or equivalent registry source.
2. Replace duplicated manifest validation in runtime discovery with the SDK
   validator plus compatibility checks.
3. Add manager data fields for `validation`, `compatibility`, and
   `capabilities`.
4. Gate API construction by capability decisions in both renderer and main.
5. Add tests proving granted and denied states for `git.metadata`,
   `filesystem`, `ipc`, `settings`, `codex.windows`, and `codex.views`.

Keep mutating project operations, automatic tweak updates, public app-server
SDK exposure, and broad Codex window/view guarantees out of this slice.
