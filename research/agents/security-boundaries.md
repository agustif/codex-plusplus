# Security And Capability Boundaries

Owner scope: recovered note from the read-only security/trust-boundary lane.
This is product/platform guidance for Codex++ capability design. It does not
change code.

## 1. Best Immediate Wins

1. Make read-only metadata ambient.
   - Impact: high.
   - Effort: small.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.
   - Safe default: app version/platform, current route, read-only config
     inspection, read-only git status/diff metadata inside selected workspace,
     app-server health, update availability state, and bounded logs.

2. Keep `api.git` as the model for privacy-preserving APIs.
   - Impact: high.
   - Effort: already started.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.
   - Reason: it runs fixed git argv arrays in main, uses timeouts and byte caps,
     returns structured metadata, and avoids raw file contents, raw hunks, and
     credentials.

3. Add explicit capability groups before exposing raw app-server access.
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: app-server protocol.
   - Suggested groups: read-only, workspace-read, workspace-write, config-write,
     tool-exec, auth, plugin-install, MCP, update/repair.

4. Add audit rows for authority increases.
   - Impact: medium-high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.
   - Examples: enabling `danger-full-access`, network expansion, Unix socket
     permissions, MCP config changes, plugin install, auth login/logout,
     worktree mutation, repair/update actions.

## 2. Medium Bets

1. Permission enforcement matrix.
   - Product: show declared, enforced, and advisory permissions for each tweak.
   - Reason: today `git.metadata` is clearly gated, while some manifest
     permissions are author declarations rather than hard runtime blocks.

2. App-server typed wrapper layer.
   - Product: expose narrow wrappers like `api.goal`, `api.thread.readonly`,
     and `api.config.read` before any raw `api.appServer.request`.
   - Reason: typed wrappers make permissions reviewable and keep unsafe methods
     out of ordinary tweaks.

3. Native-visible confirmation for privileged writes.
   - Product: a modal or repair center that shows old/new values and exact
     command/file effects before config, repair, update, or worktree mutation.
   - Reason: renderer-originated privileged actions should not be silent.

## 3. High-Risk Findings

1. Raw local WebSocket app-server is spoofable if exposed without auth.
   - Risk: any local/browser client that can reach a fixed unauthenticated port
     can attempt privileged JSON-RPC methods.
   - Guardrail: prefer Desktop IPC or stdio. If WebSocket is required, use a
     random loopback port, high-entropy bearer token, Origin verification, and
     explicit non-loopback opt-in.

2. A compromised renderer can drive powerful native methods if the bridge is
   too broad.
   - Risk methods include config writes, external config import, command exec,
     account login/logout, plugin install, MCP OAuth, file writes, sandbox
     setup, and update/repair.
   - Guardrail: do not expose raw app-server methods to ordinary tweaks.

3. Renderer-controlled update repair is too privileged.
   - Guardrail: update/repair should stay native, signed, rollback-aware,
     user-visible, and diagnosable through status/doctor/repair surfaces.

## 4. Lower-Risk Findings

1. Read-only git metadata/diff summaries are reasonable when scoped to the
   selected workspace and implemented in main.
2. App-server goal read/write can be exposed safely as a typed feature because
   it is thread-scoped and already has dedicated methods.
3. Settings and observability pages are safer integration surfaces than bundle
   patching or React/fiber mutation.

## 5. Capability Policy

Safe by default:

- Version/platform/status.
- Current UI route.
- Read-only config inspection.
- Read-only git status, branch, diff summary, and worktree metadata.
- App-server feature detection and health.
- Bounded local logs with redaction.

Requires visible permission:

- File writes.
- Command execution.
- Config writes.
- Sandbox/network permission changes.
- Plugin/tweak install.
- MCP OAuth/config changes.
- Account login/logout.
- Worktree create/delete/cleanup.
- Update/repair.

Avoid:

- Fixed unauthenticated app-server ports.
- Wildcard localhost app-server access.
- Exposing raw `ipcRenderer` events or arbitrary IPC channels.
- Renderer-supplied update/repair commands.
- Silent `danger-full-access` toggles.
- DOM-driven privileged actions without schema validation and capability checks.

## 6. Suggested Next Slice

1. Document a permission matrix in SDK docs:
   - permission string,
   - current enforcement,
   - exposed APIs,
   - expected user-visible copy,
   - examples.

2. Add a `Trust Card` data model for tweaks:
   - source,
   - manifest permissions,
   - actual gated APIs,
   - MCP servers,
   - update state,
   - storage paths,
   - loaded scopes.

3. Keep raw app-server access private until wrappers exist for the common cases:
   - `api.goal`,
   - `api.thread.readonly`,
   - `api.config.read`,
   - `api.git`.

