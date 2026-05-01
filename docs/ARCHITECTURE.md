# Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                                Codex.app                                │
│  Contents/Resources/                                                    │
│  ├─ app.asar                                                            │
│  │   ├─ package.json   (main: codex-plusplus-loader.cjs)  ◄─ patched   │
│  │   ├─ codex-plusplus-loader.cjs                          ◄─ injected │
│  │   └─ <original Codex code …>                                         │
│  ├─ Frameworks/Electron Framework.framework/.../Electron Framework      │
│  │   └─ fuse: EnableEmbeddedAsarIntegrityValidation = off  ◄─ patched  │
│  └─ Info.plist                                                          │
│      └─ ElectronAsarIntegrity["Resources/app.asar"] = <new hash>  ◄─   │
└────────────────────────────────────────────────────────────────────────┘
                                 │
                  loader.cjs requires runtime/main.js
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│  <user-data-dir>/codex-plusplus/                                        │
│  ├─ runtime/                                                            │
│  │   ├─ main.js          — main process; hooks BrowserWindow            │
│  │   ├─ preload.js       — bundled preload (renderer side)              │
│  │   └─ tweak-discovery.js                                              │
│  ├─ tweaks/                                                             │
│  │   └─ <tweak-id>/                                                     │
│  │       ├─ manifest.json                                               │
│  │       └─ index.js                                                    │
│  ├─ tweak-data/<tweak-id>/   — per-tweak filesystem sandbox             │
│  ├─ backup/                  — original asar / plist / framework binary │
│  ├─ log/                                                                │
│  ├─ state.json               — installer records                        │
│  └─ config.json              — user preferences (enable flags etc.)     │
└────────────────────────────────────────────────────────────────────────┘
```

## Tweak update checks

Tweak updates are deliberately advisory. `manifest.json` must include `githubRepo` in `owner/repo` form. The main process checks GitHub Releases at most once per day per tweak and caches the result in `<user-data-dir>/state.json`.

The renderer only receives cached metadata (`latestVersion`, `releaseUrl`, `updateAvailable`) and can open the GitHub release for review. There is no automatic download, install, or replacement path in the runtime.

## Default tweaks

The installer seeds the default tweak set from external GitHub release tarballs instead of carrying their source in this repository. Existing local tweak folders are never overwritten. Pass `--no-default-tweaks` for a clean install with only the Codex++ runtime.

## Boot sequence

1. User launches Codex.app.
2. macOS verifies the (re-signed) ad-hoc signature → Gatekeeper allows launch.
3. Electron reads `Info.plist` → checks asar integrity hash.
   - The hash now matches the patched asar, so this passes.
   - As belt-and-suspenders the `EnableEmbeddedAsarIntegrityValidation` fuse is off too.
4. Electron loads the asar's `package.json#main`, which now points to `codex-plusplus-loader.cjs`.
5. The loader (in the asar):
   - Reads `__codexpp.userRoot` from package.json.
   - Sets `CODEX_PLUSPLUS_USER_ROOT` and `CODEX_PLUSPLUS_RUNTIME` envs.
   - `require()`s `<userRoot>/runtime/main.js`.
   - `require()`s the original `__codexpp.originalMain` (Codex's real entry).
6. Runtime's `main.js`:
   - Registers our preload via `session.setPreloads()` (additive — Codex's own preload still runs).
   - Discovers tweaks under `<userRoot>/tweaks`.
   - Starts main-scoped tweaks immediately.
   - Sets up IPC handlers.
7. Codex creates its `BrowserWindow`. Both Codex's preload AND our preload run in each renderer.
8. Our preload:
   - Installs a React DevTools-shaped global hook (so we can fiber-walk later).
   - Asks main for the tweak list and user paths over IPC.
   - For each renderer-scoped tweak, `require()`s its entry and calls `start(api)`.
   - Starts the Settings injector (MutationObserver waiting for the Settings dialog).
   - Mounts the built-in Tweak Manager section.
9. When the user opens Settings, our injector:
   - Detects the Radix `[role="dialog"]` matching "Settings".
   - Appends a "Tweaks" tab to the dialog's `[role="tablist"]`.
   - Creates a sibling content panel that shows registered sections when the tab is clicked, and hides itself when other tabs are clicked.

## Why these choices

### Why patch asar entry instead of always using the fuse?

The fuse alone would let us swap in a new asar, but Codex's asar is large (~115 MB) — pointlessly recopying it every install/update is slow. Patching the entry adds ~1 KB. We do flip the fuse anyway as a safety net: if a future Codex update brings asar integrity back via a different mechanism, the fuse still neutralizes it.

### Why ad-hoc re-sign instead of disabling SIP?

Re-signing is local-only, reversible, and doesn't compromise system security. Ad-hoc signatures are accepted by Gatekeeper for apps the user already approved. We never touch SIP, hardened runtime, or kernel-level protections.

### Why a preload, not source-patching the React tree?

Codex is a Vite/Rollup build with a single entry chunk and no module registry exposed at runtime — there's no `webpackChunk` trick. String-patching the minified output is brittle (every Codex release changes the build). Preload + DOM observation is decoupled from Codex's bundle structure: we only depend on stable affordances (Radix attributes, `[role="dialog"]`, etc.), so most Codex updates just work.

### Why a separate runtime in user-dir?

So you can iterate on tweaks (and even on the runtime itself) without re-running the installer. The installer's job is the one-time "punch a hole in the bundle"; everything else lives outside.

### Why `session.setPreloads()` instead of `webPreferences.preload`?

`webPreferences.preload` is a single string; setting it would replace Codex's own preload and break the app. `session.setPreloads()` is *additive* — it appends to whatever the renderer already has. Available since Electron 23+.

## Update handling

When Codex auto-updates via Sparkle:

1. Sparkle downloads a new Codex.app and replaces ours on disk.
2. Our patch is gone; the new app launches normally.
3. Our launchd / systemd / scheduled-task watcher fires (macOS and Linux watch `app.asar`; Windows runs at logon).
4. The watcher runs `codex-plusplus repair --quiet`.
5. `repair` is idempotent: if the current asar hash still matches `patchedAsarHash`, it exits without touching the app; if the hash drifted after an update, it re-runs the install patch against the new app bundle.

## Codex++ self-updates

The watcher also runs hourly using the GitHub-installed local CLI at `~/.codex-plusplus/source/packages/installer/dist/cli.js`. It checks the latest Codex++ GitHub Release, downloads and rebuilds a newer release when available, then runs `repair`. When the app patch is intact but the installed Codex++ version in `state.json` is older than the running CLI, `repair` refreshes `<user-data-dir>/runtime/` and updates state. It does not modify user tweak folders.

Users can disable Codex++ runtime auto-updates from Settings → Codex Plus Plus → Config. The setting is stored in `<user-data-dir>/config.json`; app-update repair still works, but intact-app runtime refreshes are skipped while auto-update is disabled.

The Config page can also check for Codex++ updates manually. It reads GitHub release metadata and opens GitHub release pages for review.

## Runtime development HMR

`codexplusplus dev-runtime` is the fast loop for Codex++ built-in UI work. It rebuilds `packages/runtime`, stages `packages/runtime/dist` into a temporary runtime directory, swaps it into one or more Codex++ homes, writes a small manifest with hashes for `main.js`, `preload.js`, `self-mcp-server.js`, and `self-mcp-launcher.js`, and touches `<user-data-dir>/runtime/.codexpp-runtime-reload`.

The runtime main process watches `runtime/preload.js` and the reload marker. When either changes, it calls `reloadIgnoringCache()` on open `app://` renderer windows. This reloads the Codex window, reruns the fresh preload bundle, and picks up renderer-side changes such as Settings pages, `/goal`, the git sidebar, and Patch Manager without quitting Codex.

This is not full main-process HMR. `runtime/main.js` is loaded by Node once from `loader.cjs`, and replacing it in-place would leave old IPC handlers and app hooks resident. Main-process runtime changes still require restarting Codex.

For changes to main-process runtime code, including the HMR watcher itself, `codexplusplus dev-runtime --restart` uses an external restart loop:

1. Back up the current `<user-data-dir>/runtime/` bundle.
2. Stage the candidate runtime bundle.
3. Reopen Codex with `--remote-debugging-port=<port>`.
4. Wait for the local CDP `/json/version` health endpoint.
5. Restore the previous runtime and reopen Codex if the candidate does not become healthy.

That boundary is also the right shape for an LLM-callable self-modification tool: the tool should run outside the app process, stage a candidate runtime, restart into it, verify health, and roll back on failure.

## LLM-callable self-modification tools

Codex++ exposes self-modification to Codex through Codex's normal tool layer, not by trying to make the renderer impersonate the model runtime. `codexplusplus self-tools --root <repo>` writes a managed `codexpp-self` MCP launcher block into `~/.codex/config.toml`.

The launcher lives at `<user-data-dir>/runtime/self-mcp-launcher.js`, runs `<user-data-dir>/runtime/self-mcp-server.js`, and keeps the stdio connection stable while it respawns the worker. The worker gets `CODEXPP_SELF_ROOT=<repo>` and intentionally has repo-wide capability:

- `codexpp_self_status` reports the configured root and git status.
- `codexpp_self_list_files` lists files from the root.
- `codexpp_self_search` searches the root with ripgrep-style options.
- `codexpp_self_read` reads repo files.
- `codexpp_self_write` replaces or appends repo files.
- `codexpp_self_git_apply` applies unified git diffs.
- `codexpp_self_shell` runs arbitrary shell commands from the root.
- `codexpp_self_runtime_apply` rebuilds the repo by default so installer and self-tool edits are included, then stages/restarts the Codex++ runtime with rollback.
- `codexpp_self_restart_mcp` restarts the worker so newly staged self-tool code becomes active.

The frontend can render Patch Manager controls and explain the current candidate/stable state, but the callable tool implementation lives in a separate Node process. That keeps the rollback supervisor outside the Electron process it may need to replace.

## What's not protected against

- **A Codex update that changes the asar layout** (e.g., moves the entry script) will break our injection. The installer's `injectLoader` reads `package.json#main` so this should be robust to renames, but if Codex ever ships an executable that doesn't go through Electron's normal asar-loading path, we'd need new strategies.
- **A Codex update that changes the Settings DOM enough that our heuristics fail.** The runtime falls back to a console warning; tweak authors can register sections that simply don't appear until heuristics are updated.
- **Targeted anti-tamper.** Codex doesn't currently appear to do TOCTOU integrity re-checks at runtime. If they ever start, more work is required (LD hooks, MachO patching, etc.) — but this is a different threat model.
