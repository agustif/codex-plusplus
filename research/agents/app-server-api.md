# App-Server API Research Notes

Owner scope: this note only. Evidence was gathered from the local
`/Users/af/codex-plusplus` checkout, the installed `/Applications/Codex.app`
bundle, the local `codex`/embedded Codex binary, and local Codex config/cache
files.

## 1. Evidence Baseline

1. Installed app and CLI state:
   - `codexplusplus status` reports Codex++ `0.1.4` patched into
     `/Applications/Codex.app`, Codex Desktop `26.429.20946`, stable channel,
     bundle id `com.openai.codex`, patched asar hash OK, and asar fuse off.
   - `/Applications/Codex.app/Contents/Resources/codex --version` reports
     `codex-cli 0.128.0-alpha.1`.
   - `/opt/homebrew/bin/codex --version` reports `codex-cli 0.128.0`.
   - `codex debug app-server --help` exposes only one debug subcommand:
     `send-message-v2 <USER_MESSAGE>`. It does not expose a method catalog.

2. Codex++ runtime bridge evidence:
   - `packages/runtime/src/preload/app-server-bridge.ts` sends IPC messages on
     `codex_desktop:message-from-view` with `{ type: "mcp-request", hostId,
     request: { id, method, params } }`.
   - The same bridge receives `codex_desktop:message-for-view` and accepts
     response envelopes in these shapes: `mcp-response`, `mcp-error`, raw
     `{ type: "response", id }`, or raw JSON-RPC-ish `{ id, result | error }`.
   - It treats app-server pushes as notifications when the envelope is
     `mcp-notification` or any method-only message with no `id`.
   - Default request timeout is 12 seconds. This matters for fs, config, MCP,
     and remote host calls.

3. Current Codex++ tweak surface:
   - `packages/sdk/src/index.ts` exposes `storage`, `log`, `settings`, `react`,
     scoped `ipc`, sandboxed `fs`, optional main-only `codex`, and optional
     `git`.
   - Tweak permissions are currently:
     `ipc`, `filesystem`, `network`, `settings`, `codex.windows`,
     `codex.views`, `git.metadata`.
   - `packages/runtime/src/preload/tweak-host.ts` only exposes `api.git` to
     renderer tweaks that declare `git.metadata`.
   - `packages/runtime/src/main.ts` exposes native Codex windows/views through
     internal `__codexpp_window_services__`, with `createWindow()` and
     `createBrowserView()` registered into Codex host context.
   - `packages/runtime/src/mcp-sync.ts` syncs tweak `manifest.mcp` declarations
     into `~/.codex/config.toml` under a managed block, preserving manual MCP
     config outside the block.

4. Current goal implementation evidence:
   - `packages/runtime/src/preload/goal-feature.ts` already calls
     `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`.
   - It subscribes to `thread/goal/updated` and `thread/goal/cleared`.
   - It extracts `threadId` by scanning `location.pathname`, hash, href,
     `initialRoute`, and recursive `history.state` candidates for `/local/<id>`.
   - Its user-facing errors prove known native constraints: `[features].goals`
     may be disabled, `experimentalApi` negotiation may be required, and older
     app-server builds may not support `thread/goal/*`.

5. App bundle and binary method evidence:
   - `npx asar list /Applications/Codex.app/Contents/Resources/app.asar` shows
     renderer chunks for `app-server-manager-hooks`, `app-server-manager-signals`,
     `config-queries`, `experimental-features-queries`, `mcp-settings`, and
     thread pages.
   - The asar main chunk defines the same IPC channel names:
     `codex_desktop:message-from-view`, `codex_desktop:message-for-view`,
     `codex_desktop:mcp-app-sandbox-guest-message`, and
     `codex_desktop:mcp-app-sandbox-host-message`.
   - Binary strings in `/Applications/Codex.app/Contents/Resources/codex`
     include source anchors for `app-server-protocol/src/protocol/v2.rs`,
     `app-server/src/config_api.rs`, `external_agent_config_api.rs`,
     `fs_api.rs`, `fs_watch.rs`, `command_exec.rs`,
     `thread_goal_handlers.rs`, `plugins.rs`, and app/MCP helpers.

6. Local config and schema/cache evidence:
   - `~/.codex/config.toml` has `[features]` entries for `apps`,
     `apps_mcp_gateway`, `goals`, `multi_agent`, `plugins`,
     `realtime_conversation`, `shell_tool`, `unified_exec`, and other flags.
   - The same config has `[apps._default]` controls:
     `enabled`, `destructive_enabled`, and `open_world_enabled`.
   - The same config has `[agents]` controls:
     `job_max_runtime_seconds`, `max_depth`, and `max_threads`.
   - `~/.codex/cache/codex_apps_tools/*.json` files are local app-tool schema
     caches with top-level `schema_version` and `tools`.

## 2. Native App-Server Surface Seen Locally

1. Thread and turn methods seen in binary strings:
   - `thread/start`
   - `thread/resume`
   - `thread/fork`
   - `thread/archive`
   - `thread/unarchive`
   - `thread/unsubscribe`
   - `thread/list`
   - `thread/loaded/list`
   - `thread/read`
   - `thread/turns/list`
   - `thread/inject_items`
   - `thread/name/set`
   - `thread/metadata/update`
   - `thread/memoryMode/set`
   - `thread/compact/start`
   - `thread/shellCommand`
   - `thread/backgroundTerminals/clean`
   - `thread/rollback`
   - `thread/approveGuardianDeniedAction`
   - `turn/start`
   - `turn/steer`
   - `turn/interrupt`
   - `review/start`

2. Goal methods and notifications seen in binary strings and current code:
   - Requests: `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`.
   - Notifications: `thread/goal/updated`, `thread/goal/cleared`.
   - Response type strings include `ThreadGoalGetResponse`,
     `ThreadGoalSetResponse`, and `ThreadGoalClearResponse`.

3. Filesystem methods seen in binary strings:
   - `fs/readFile`
   - `fs/readDirectory`
   - `fs/writeFile`
   - `fs/createDirectory`
   - `fs/getMetadata`
   - `fs/remove`
   - `fs/copy`
   - `fs/watch`
   - `fs/unwatch`
   - Notification: `fs/changed`.
   - Binary error string: `fs/writeFile requires valid base64 dataBase64`,
     so writes are not plain text-only at the native boundary.

4. Config and feature methods seen in binary/asar strings:
   - `config/read`
   - `config/value/write`
   - `config/batchWrite`
   - `configRequirements/read`
   - `config/mcpServer/reload`
   - `experimentalFeature/list`
   - `experimentalFeature/enablement/set`
   - The Desktop `config-queries` chunk wraps these as:
     `read-config-for-host`, `write-config-value`,
     `batch-write-config-value`, and `get-config-requirements-for-host`.

5. External agent methods seen in binary/asar strings:
   - `externalAgentConfig/detect`
   - `externalAgentConfig/import`
   - Notification: `externalAgentConfig/import/completed`.
   - Config strings also show `local-custom-agents`, `agents`, `roles`, and
     agent-role config paths.

6. Apps, plugins, MCP, and marketplace methods seen locally:
   - Apps: `app/list`, notification `app/list/updated`.
   - Plugins: `plugin/list`, `plugin/read`, `plugin/install`,
     `plugin/uninstall`.
   - Skills/hooks/marketplace: `skills/list`, `skills/config/write`,
     `hooks/list`, `marketplace/add`, `marketplace/remove`,
     `marketplace/upgrade`.
   - MCP: `mcpServer/oauth/login`, `mcpServerStatus/list`,
     `mcpServer/resource/read`, `mcpServer/tool/call`,
     `config/mcpServer/reload`.
   - MCP notifications include OAuth login completion, server status updates,
     and tool-call progress.

7. Command execution methods seen locally:
   - `command/exec`
   - `command/exec/write`
   - `command/exec/terminate`
   - `command/exec/resize`
   - Notification: `command/exec/outputDelta`.
   - Response type strings include `CommandExecResponse`,
     `CommandExecWriteResponse`, `CommandExecTerminateResponse`, and
     `CommandExecResizeResponse`.

8. Notifications seen in binary type strings:
   - Thread lifecycle: started, archived, unarchived, closed, name updated,
     status changed, token usage updated.
   - Turn lifecycle: started, completed, diff updated, plan updated.
   - Item streams: agent message delta, plan delta, reasoning deltas, raw
     response item completion, file-change deltas, command-output deltas.
   - MCP/app/config: app list updated, MCP status updated, MCP OAuth completed,
     MCP tool-call progress, config warning.
   - System/account/model: warning, guardian warning, deprecation notice,
     account updates, rate-limit updates, model reroute/verification.
   - Realtime: start, item added, transcript deltas/done, output audio delta,
     SDP, error, closed.

## 3. Product Ideas For What Codex++ Should Expose To Tweaks

1. `api.appServer.request()` as an advanced, permission-gated escape hatch.
   - Impact: high.
   - Effort: small to medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam plus app-server protocol.
   - Proposed shape:
     `request<T>(method: string, params: unknown, options?: { hostId?: string; timeoutMs?: number }): Promise<T>`.
   - Gate behind a new manifest permission such as `codex.appServer.raw`.
   - Default to deny in examples. Encourage typed wrappers first.
   - Add method allowlists per permission so raw access can be reviewed.

2. `api.thread` typed wrapper for read-mostly thread metadata and lifecycle.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: app-server protocol.
   - Expose safe reads first:
     `list`, `loadedList`, `read`, `turnsList`, `getCurrentThreadId`,
     `onThreadStatusChanged`, `onTurnCompleted`, `onTokenUsageUpdated`.
   - Defer mutating methods (`start`, `resume`, `fork`, `archive`,
     `inject_items`, `rollback`, `compact/start`) until there is a clear
     permission and UX confirmation model.
   - Product use: richer sidebars, thread dashboards, token/budget monitors,
     checkpoint views, resume-state badges, recent-thread search, and
     "open thread in new Codex window" actions.

3. `api.goal` wrapper as the first productionized app-server feature.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: current Codex++ runtime seam plus `features.goals`.
   - Current `/goal` feature proves the method path. Generalize it for tweaks:
     `get(threadId)`, `set(threadId, patch)`, `clear(threadId)`,
     `onUpdated`, and `onCleared`.
   - Add `api.appServer.features.has("goals")` or a failure classifier so
     tweaks can degrade cleanly when the app-server lacks the method or the
     feature flag is off.
   - Product use: persistent goal widgets, goal-aware notifications, token
     budget dashboards, and "complete goal when checks pass" automations.

4. `api.config` wrapper for safe config inspection and constrained writes.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: app-server protocol plus config write-risk policy.
   - Read wrapper:
     `read({ hostId, cwd, includeLayers })`,
     `requirements({ hostId })`,
     `listExperimentalFeatures({ hostId })`.
   - Write wrapper:
     `writeValue({ keyPath, value, mergeStrategy, target })` and
     `batchWrite(...)`, but only for declared key prefixes.
   - First allowed prefixes:
     `features.<name>`, `mcp_servers.<name>.*`, maybe app settings under
     `apps.<id>.*`.
   - Product use: feature-flag toggles, MCP server manager, config provenance
     viewer, workspace-specific config editor.
   - Constraint: Desktop chunks compute write targets from layered config and
     expected versions. Codex++ should reuse app-server config write APIs
     rather than directly editing TOML when possible.

5. `api.fsNative` wrapper separate from current Codex++ tweak sandbox `api.fs`.
   - Impact: high.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: app-server protocol and permissions.
   - Current `api.fs` is per-tweak storage under Codex++ user data. Keep that.
   - Native fs API should be explicit and permission-gated, for example
     `codex.fs.readonly` and `codex.fs.write`.
   - Start with:
     `readFile`, `readDirectory`, `getMetadata`, `watch`, `unwatch`,
     `onChanged`.
   - Writes (`writeFile`, `createDirectory`, `remove`, `copy`) should require
     a stronger permission and probably user confirmation unless scoped to the
     active workspace.
   - Product use: file tree overlays, document previews, generated artifact
     watchers, route-level reloads, "show changed files" panels.
   - Constraint: native `fs/writeFile` expects base64 data, so SDK wrappers
     should own encoding/decoding and byte limits.

6. `api.commands` wrapper for terminal/command sessions.
   - Impact: medium to high.
   - Effort: large.
   - Confidence: medium.
   - Dependency: app-server protocol and safety/approval policy.
   - Start read-only around notifications:
     command output deltas, command termination, current running command state.
   - Mutating commands (`command/exec`, write stdin, resize, terminate) need
     explicit permission, visible UI, and clear ownership of approval flow.
   - Product use: terminal panel tweaks, run/test dashboards, command receipts,
     "rerun failed check" buttons, and proof collection.
   - Constraint: Codex already has approval/reviewer semantics. Codex++ should
     not bypass them from tweaks.

7. `api.notifications` event bus.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: current Codex++ app-server bridge.
   - Expose a typed `on(method, handler)` and lower-level `onAny`.
   - Add helper subscriptions:
     `onThread`, `onTurn`, `onCommand`, `onMcp`, `onFs`, `onConfigWarning`.
   - Product use: live dashboards, badges, toast integrations, background
     automations, goal progress, and route refresh without polling.
   - Constraint: notifications are host-scoped. The SDK should always surface
     `hostId` context when available and let tweaks filter.

8. `api.externalAgents` wrapper for import/detect workflows.
   - Impact: medium.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: app-server protocol plus config semantics.
   - Expose:
     `detect({ hostId, cwd? })`, `import(...)`,
     `onImportCompleted`, and read-only custom agent role lists.
   - Product use: "import Cursor/Claude/Codex agent config" affordances,
     agent-role dashboards, per-workspace agent templates, migration assistant.
   - Constraint: agent config can touch user-level config. Treat as a
     high-risk write path, not a silent tweak operation.

9. `api.apps` and `api.mcp` wrappers.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: app-server protocol, local app schema cache, MCP config.
   - Apps:
     `list`, `onListUpdated`, maybe app enablement helpers via `api.config`.
   - MCP:
     `listServerStatus`, `readResource`, `callTool`, `oauthLogin`,
     `reloadConfig`, `onServerStatusUpdated`, `onToolCallProgress`.
   - Product use: app/plugin marketplace panels, MCP health dashboard, OAuth
     repair flows, resource browser, tool-call inspectors.
   - Constraint: MCP tool calls can be destructive or auth-sensitive. Respect
     app config fields like `destructive_enabled`, `open_world_enabled`, and
     per-tool approval modes.

10. `api.codex.windows` should be linked to thread/app-server wrappers.
    - Impact: medium.
    - Effort: small.
    - Confidence: high.
    - Dependency: existing Codex++ runtime seam.
    - Existing `createWindow` and `createBrowserView` need convenience helpers:
      `openThread(threadId)`, `openRoute(route, hostId)`, and maybe
      `openCurrentThreadClone()`.
    - Product use: detachable goal dashboards, PR/review secondary windows,
      multi-thread monitor, app/MCP admin pages.

## 4. Constraints And Guardrails

1. Native protocol stability is not guaranteed.
   - The only stable thing Codex++ owns today is the IPC bridge shape and its
     wrappers. Method names come from local binary/asar evidence, not a public
     versioned SDK.
   - Every typed wrapper should feature-detect by attempting a safe read or
     checking `experimentalFeature/list`, then cache the capability by
     `hostId + appServerVersion`.

2. Host identity is first-class.
   - Current bridge defaults `hostId` to the URL search param or `local`.
   - Desktop supports remote connections and remote-control state. Tweaks
     should not assume `local` when acting on current routes.

3. Thread id discovery is currently route-derived.
   - `goal-feature.ts` proves route scanning works for `/local/<id>`, but this
     is a UI heuristic.
   - Better product seam: expose `api.thread.current()` from Codex Desktop
     manager state when possible, with the route heuristic as fallback.

4. Some APIs are config- or negotiation-gated.
   - `goals` can be disabled in `~/.codex/config.toml`.
   - Goal calls may require `experimentalApi` negotiation.
   - Apps/plugins/MCP depend on feature flags and installed connectors.
   - Product UI should show "unsupported", "disabled", and "permission denied"
     as distinct states.

5. Do not collapse two filesystem concepts.
   - Codex++ `api.fs` is tweak-private data storage.
   - Native app-server `fs/*` is workspace/user filesystem access.
   - Names and permissions should keep these separate to avoid accidental data
     exposure.

6. Do not bypass Codex safety.
   - Command exec, file writes/removes, MCP tool calls, plugin installs, config
     imports, and agent imports are high-blast-radius.
   - Codex++ should route through app-server approvals and visible UI instead
     of silent main-process shortcuts.

7. Watchers and notifications need cleanup handles.
   - `fs/watch` implies `fs/unwatch`.
   - Tweak hot reload already calls `stop()`. App-server subscriptions should
     register teardown functions so reloads do not leak event handlers.

8. In-memory app-server state can outlive config edits.
   - Prior local recovery notes observed that changing config does not salvage
     an already-full in-memory thread; new sessions see config changes more
     reliably than saturated existing threads.
   - Product copy should avoid promising that config/feature changes mutate
     every active thread immediately.

9. Local caches are useful but not authority.
   - `~/.codex/cache/codex_apps_tools/*.json` gives app tool schema snapshots,
     but app-server and configured apps can change. Treat cache as a UI seed,
     then refresh through `app/list` and MCP status APIs.

## 5. Recommended Codex++ API Shape

1. Add `AppServerApi` to the SDK:

   ```ts
   export interface AppServerApi {
     request<T = unknown>(
       method: string,
       params?: unknown,
       options?: { hostId?: string; timeoutMs?: number },
     ): Promise<T>;
     on(
       method: string,
       handler: (params: unknown, context: AppServerEventContext) => void,
     ): () => void;
     onAny(
       handler: (event: AppServerEvent) => void,
     ): () => void;
   }
   ```

2. Add focused wrappers over the raw API:

   ```ts
   export interface CodexNativeApi {
     appServer?: AppServerApi;
     thread?: ThreadApi;
     goal?: GoalApi;
     config?: ConfigApi;
     fsNative?: NativeFsApi;
     commands?: CommandApi;
     notifications?: NotificationApi;
     externalAgents?: ExternalAgentsApi;
     apps?: AppsApi;
     mcp?: McpApi;
   }
   ```

3. Add permission strings by area:
   - `codex.appServer.raw`
   - `codex.thread.read`
   - `codex.thread.write`
   - `codex.goal`
   - `codex.config.read`
   - `codex.config.write`
   - `codex.fs.read`
   - `codex.fs.write`
   - `codex.commands.read`
   - `codex.commands.exec`
   - `codex.notifications`
   - `codex.externalAgents`
   - `codex.apps.read`
   - `codex.mcp.read`
   - `codex.mcp.call`

4. Keep `git.metadata` as a separate domain.
   - The current git provider is metadata-only and implemented in Codex++ main
     process, not app-server.
   - It should remain separate until native app-server git coverage is richer
     than `thread.gitInfo` and `gitDiffToRemote`.

5. Build wrappers as progressive capability objects.
   - Example:
     `api.goal` exists only when the tweak has permission and the runtime can
     route app-server requests.
   - `api.goal.capabilities()` should return support states:
     `available`, `feature-disabled`, `unsupported`, `permission-denied`,
     `host-unavailable`.

## 6. Prioritized Implementation Slices

1. Slice A: expose notifications and raw request behind permissions.
   - Add SDK types for `AppServerApi`.
   - Wire renderer API to existing `requestAppServer` and
     `onAppServerNotification`.
   - Add manifest validation for `codex.appServer.raw` and
     `codex.notifications`.
   - Acceptance: a local test tweak can call a harmless read method and listen
     to a notification, then unload cleanly.

2. Slice B: productize `api.goal`.
   - Move goal request/notification code behind a typed SDK wrapper.
   - Keep the existing `/goal` UI using the wrapper.
   - Add capability/error classification.
   - Acceptance: `/goal` behavior remains unchanged, and a tweak can render a
     goal widget without reimplementing method strings.

3. Slice C: config and feature flag panel.
   - Add read-only `api.config.read` and `api.config.listExperimentalFeatures`.
   - Add guarded write support for feature flags and MCP enabled flags.
   - Acceptance: a tweak can display effective config provenance and toggle a
     low-risk feature through app-server `batchWrite`, not direct TOML edits.

4. Slice D: apps/MCP admin API.
   - Add `api.apps.list`, `api.mcp.listServerStatus`, `api.mcp.readResource`,
     and `api.mcp.reloadConfig`.
   - Defer `api.mcp.callTool` until approval and destructive-tool UX is clear.
   - Acceptance: MCP status dashboard can render server auth/health and react
     to status notifications.

5. Slice E: native fs read/watch.
   - Add read-only `fsNative` plus watch/unwatch.
   - Keep writes out of scope until permissions/confirmation are designed.
   - Acceptance: a tweak can watch active workspace files and refresh UI on
     `fs/changed`, with cleanup on tweak stop.

6. Slice F: command read model.
   - Subscribe to command output/terminal notifications and expose structured
     command receipts.
   - Defer execution controls.
   - Acceptance: a tweak can show running command output without starting or
     terminating commands.

## 7. Open Questions

1. Can Codex++ access Desktop's app-server manager instance directly enough to
   read current thread and host identity without route heuristics?

2. Is `experimentalApi` negotiation controlled by Desktop client info, feature
   flags, or both? The existing goal error path proves the failure mode but not
   the negotiation hook.

3. Which app-server methods are safe on remote hosts? Config, fs, command, and
   MCP calls may have different remote-host permission behavior.

4. Does `experimentalFeature/enablement/set` persist to config or only mutate
   session state? Desktop's experimental-features chunk writes via
   `batch-write-config-value`, but the binary also exposes a direct enablement
   method.

5. Should tweak-provided MCP servers remain synced through Codex++'s TOML
   managed block, or should future versions call app-server config APIs to add
   them with provenance and expected-version checks?

6. What is the app-server payload schema for `thread/start`, `turn/start`, and
   `command/exec` in this build? Binary method names prove existence, but a
   wrapper needs exact field contracts before exposing mutations.

7. Should Codex++ expose app/plugin install/uninstall at all? It is powerful
   but crosses from "tweak" into package manager and auth territory.

## 8. Next Evidence To Collect

1. Attach to a running Codex renderer and capture one harmless app-server
   request/response pair for:
   - `thread/list`
   - `thread/read`
   - `config/read`
   - `experimentalFeature/list`
   - `mcpServerStatus/list`

2. Test `thread/goal/get` with goals enabled and then disabled to lock the
   exact error strings for capability classification.

3. Inspect app-server manager state in the renderer to find a non-route
   current-thread source.

4. Use a local throwaway tweak to verify whether raw app-server notification
   subscriptions survive hot reload and whether teardown fully removes
   listeners.

5. Extract field-level schemas from app-server protocol artifacts if a
   generated TypeScript export or JSON schema exists in a future build. Current
   local evidence exposes method and type names, not all request payload fields.
