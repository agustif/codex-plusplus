# Electron Main-Process Reverse Engineering

Scope: Codex.app and Codex (Beta).app on this Mac, with Codex++ as the integration layer. This is a research map only; do not treat it as a product patch plan without adding tests and rollback.

Local state observed on 2026-05-01:

- Stable app: `/Applications/Codex.app`, bundle id `com.openai.codex`, version `26.429.20946`.
- Beta app: `/Applications/Codex (Beta).app`, bundle id `com.openai.codex.beta`, version `26.429.21146`.
- Both apps have `Contents/Resources/app.asar`, `Contents/Resources/app.asar.unpacked`, `Squirrel.framework`, and `Sparkle.framework`.
- Both installed app bundles are already Codex++ patched: `package.json#main` is `codex-plusplus-loader.cjs`; `package.json#__codexpp.originalMain` is `.vite/build/bootstrap.js`.
- Codex++ user roots are `/Users/af/Library/Application Support/codex-plusplus` and `/Users/af/Library/Application Support/codex-plusplus-beta`.
- Both installed app bundles are currently ad-hoc signed after patching. A Developer ID signed stable Codex.app also exists in Sparkle cache at `/Users/af/Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation/cjCSZuGm3/6sPODHVL8/Codex.app`.

## Evidence Commands

Use these commands to refresh the local facts without mutating the app:

```sh
find /Applications/Codex.app '/Applications/Codex (Beta).app' -maxdepth 5 \
  \( -name 'app.asar' -o -name 'app.asar.unpacked' -o -name 'Info.plist' -o -name '*.framework' \)

node --input-type=module -e "import asar from '@electron/asar'; for (const p of ['/Applications/Codex.app/Contents/Resources/app.asar','/Applications/Codex (Beta).app/Contents/Resources/app.asar']) { const pkg=JSON.parse(asar.extractFile(p,'package.json').toString('utf8')); console.log('ASAR', p); console.log(JSON.stringify({name:pkg.name, version:pkg.version, main:pkg.main, codexpp:pkg.__codexpp ?? null}, null, 2)); }"

/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  -c 'Print :CFBundleShortVersionString' \
  -c 'Print :ElectronAsarIntegrity' \
  /Applications/Codex.app/Contents/Info.plist

codesign -dv --verbose=4 /Applications/Codex.app 2>&1 | sed -n '1,80p'
```

Relevant Codex++ files:

- `/Users/af/codex-plusplus/packages/loader/loader.cjs`
- `/Users/af/codex-plusplus/packages/installer/src/asar.ts`
- `/Users/af/codex-plusplus/packages/installer/src/commands/install.ts`
- `/Users/af/codex-plusplus/packages/installer/src/codex-window-services.ts`
- `/Users/af/codex-plusplus/packages/runtime/src/main.ts`
- `/Users/af/codex-plusplus/packages/installer/src/commands/update-codex.ts`
- `/Users/af/codex-plusplus/packages/installer/src/watcher.ts`
- `/Users/af/codex-plusplus/docs/ARCHITECTURE.md`

## Ordered Techniques

### 1. Read asar metadata and entrypoint

Command:

```sh
node --input-type=module -e "import asar from '@electron/asar'; const p='/Applications/Codex.app/Contents/Resources/app.asar'; console.log(JSON.parse(asar.extractFile(p,'package.json').toString('utf8')))"
```

What it reveals:

- Electron package name/version.
- Real main entrypoint before Codex++ patching via `__codexpp.originalMain`.
- Codex++ user root and loader path when already patched.
- Sparkle feed metadata from `package.json`, including `codexSparkleFeedUrl` and `codexSparklePublicKey`.

Feasibility: high. Codex++ already depends on `@electron/asar`, and `packages/installer/src/asar.ts` wraps header reads and file extraction.

Hazards:

- Reading is safe. Repacking is not: it changes the asar header hash and requires `Info.plist` integrity update, fuse handling, and re-signing.
- Do not trust `state.json` alone for original hashes after repeated patch cycles; verify the live asar package metadata too.

Codex++ integration ideas:

- Add a read-only `codexplusplus inspect-asar --app <path>` command that prints package metadata, Codex++ patch metadata, original entry, unpacked-file count, and current integrity hash.
- Store this as support evidence before any repair/install action.

### 2. Extract targeted main-process files to `/tmp`

Command:

```sh
tmp=$(mktemp -d /tmp/codex-asar-sample.XXXXXX)
node --input-type=module - "$tmp" <<'NODE'
import asar from '@electron/asar';
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
const out = process.argv[2];
const p = '/Applications/Codex.app/Contents/Resources/app.asar';
for (const rel of [
  '.vite/build/bootstrap.js',
  '.vite/build/main-SLemWUtC.js',
  '.vite/build/preload.js',
  '.vite/build/sandbox-preload.js',
  '.vite/build/app-session-3mnvnHpB.js',
  'codex-plusplus-loader.cjs',
  'package.json',
]) {
  const dest = join(out, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, asar.extractFile(p, rel));
  console.log(dest);
}
NODE
rg -n "ipcMain|ipcRenderer|BrowserWindow|session|child_process|spawn|execFile|autoUpdater|sparkle|installUpdatesIfAvailable|commandLine|preloadPath|allowDevtools|allowDebugMenu|desktopRoot|repoRoot|createWindow|windowManager|globalState" "$tmp" --text
```

What it reveals:

- Minified but searchable main-process symbols and string literals.
- Stable hook targets: Sparkle install calls, IPC message types, window manager creation paths, preload paths, command-line switches, app-server/session code.
- Whether a new Codex release moved from `.vite/build/bootstrap.js` or changed hashed file names.

Feasibility: high. Targeted extraction avoids a noisy full bundle dump and keeps product code untouched.

Hazards:

- Minified file names like `.vite/build/main-SLemWUtC.js` are release-specific. Always discover file names from the asar header instead of hard-coding them.
- Large single-line minified files can create huge grep output. Prefer bounded context or token counts.

Codex++ integration ideas:

- Add a release-diff collector that extracts only package metadata plus `.vite/build/{bootstrap,main,preload,sandbox-preload,app-session}*.js` to a temp dir and emits a compact fingerprint JSON.
- Track counts and snippets for known tokens such as `installUpdatesIfAvailable`, `createFreshLocalWindow`, `windowManager`, `allowDevtools`, and `preloadPath`.

### 3. Loader entrypoint patch

Local implementation:

- `packages/loader/loader.cjs`
- `packages/installer/src/commands/install.ts`
- `packages/installer/src/asar.ts`

Mechanism:

- Installer extracts/repackages `app.asar`.
- `package.json#main` is rewritten to `codex-plusplus-loader.cjs`.
- Original entry is recorded under `package.json#__codexpp.originalMain`.
- Loader sets `CODEX_PLUSPLUS_USER_ROOT` and `CODEX_PLUSPLUS_RUNTIME`, requires `<userRoot>/runtime/main.js`, then always requires the original main entry.

What it reveals:

- Earliest practical JavaScript hook before Codex's real main code runs.
- Reliable place to install `Module._load`, Electron object, IPC, command-line, session, and process hooks.

Feasibility: already implemented and proven locally.

Hazards:

- Any exception in the loader path can break launch if not caught. The current loader logs and falls through to original main.
- Repacking must preserve the original asar unpacked-file set. `packages/installer/src/asar.ts` documents the `MODULE_NOT_FOUND` failure if a file is marked unpacked in the header but missing from `app.asar.unpacked`.
- Requires integrity hash update and codesigning on macOS.

Codex++ integration ideas:

- Keep loader minimal. Move experimental reverse-engineering hooks into runtime modules with feature flags and kill switches.
- Add loader diagnostics for resolved original main, runtime path, Node/Electron versions, and require timing.

### 4. `require` / `Module._load` hooks

Local implementation:

- `packages/runtime/src/main.ts` installs `installSparkleUpdateHook()`.
- `packages/loader/loader.cjs` already imports `node:module` and adjusts `Module.globalPaths`.

Current Codex++ use:

- Runtime wraps `Module._load`.
- When the requested module name matches `/sparkle(?:\.node)?$/i`, it wraps exported `installUpdatesIfAvailable`.
- Before invoking the real function, Codex++ restores a signed Codex.app and writes update-mode state.

What it can reveal:

- Which native or JS modules Codex loads in main process.
- Exact paths for Electron, Sparkle, app-server, node-pty, shell, filesystem, or telemetry modules.
- Late-bound module exports that are easier to wrap after `require()` than by patching minified source.

Feasibility: high from loader/runtime because it runs before original main. Medium for invasive module replacement because Codex may bundle much code into a few Vite files.

Hazards:

- Global `_load` hooks affect every require in main. They can create recursion, break native module initialization, or change timing.
- Multiple wrappers need idempotence markers like `__codexppSparkleWrapped`.
- Hook must always call original loader and preserve `this`, args, return value, and thrown errors unless intentionally intercepting.

Codex++ integration ideas:

- Generalize the Sparkle hook into a typed hook registry:
  - `match(request, parent)`.
  - `wrap(exports, context)`.
  - `enabled` from config/env.
  - capped JSONL diagnostics under `<userRoot>/log/module-load.jsonl`.
- Start with observation-only mode: record module request, parent filename, export keys, and load duration.

### 5. `child_process` interception

Local evidence:

- Codex main bundle contains `child_process`, `spawn`, and `execFile` references in `.vite/build/bootstrap.js`, `.vite/build/main-SLemWUtC.js`, and `.vite/build/app-session-3mnvnHpB.js`.
- Codex++ itself uses `execFileSync`/`spawnSync` for codesign, ditto, xattr, watcher, and update operations.

Technique:

- Install a `Module._load` hook for `node:child_process` and `child_process`.
- Wrap `spawn`, `execFile`, `fork`, `exec`, and sync variants.
- Log command, args, cwd, env allowlist, parent module, exit status, duration, and stderr tail.
- Optionally deny or rewrite only behind a hard feature flag.

What it can reveal:

- CLI invocations Codex uses for app-server, git, terminal, update, pty, helper tools, or local background jobs.
- Whether failures originate in the main process, helper process, shell wrapper, or renderer.
- Exact command lines needed to reproduce app-server behavior outside Electron.

Feasibility: high for logging if installed before original main. Medium for patching because some subprocess use may be through imported wrappers already captured before the hook or through native bindings.

Hazards:

- Env logging can leak secrets. Default to metadata-only and redact values by key.
- Wrapping sync calls can perturb timing during startup.
- Denying process launches can strand Codex in partially initialized states.

Codex++ integration ideas:

- Add an opt-in `process-tap` runtime module that emits redacted JSONL to `<userRoot>/log/child-process.jsonl`.
- Surface a "recent subprocesses" panel in Patch Manager with command, cwd, status, and duration, not raw env.

### 6. IPC channel mapping

Local Codex++ IPC surface:

- `codexpp:list-tweaks`
- `codexpp:get-tweak-enabled`
- `codexpp:set-tweak-enabled`
- `codexpp:get-config`
- `codexpp:set-auto-update`
- `codexpp:get-cdp-status`
- `codexpp:set-cdp-config`
- `codexpp:get-app-server-flow-tap-status`
- `codexpp:set-app-server-flow-tap-config`
- `codexpp:check-codexpp-update`
- `codexpp:get-watcher-health`
- `codexpp:get-patch-manager-status`
- `codexpp:read-tweak-source`
- `codexpp:read-tweak-asset`
- `codexpp:preload-log`
- `codexpp:tweak-fs`
- `codexpp:user-paths`
- `codexpp:git-resolve-repository`
- `codexpp:git-status`
- `codexpp:git-diff-summary`
- `codexpp:git-worktrees`
- `codexpp:reveal`
- `codexpp:open-external`
- `codexpp:open-cdp-url`
- `codexpp:read-app-server-flow-tap-log`
- `codexpp:open-app-server-flow-tap-log`
- `codexpp:reveal-app-server-flow-tap-log`
- `codexpp:copy-text`
- `codexpp:reload-tweaks`

Technique for Codex internals:

- Wrap `ipcMain.handle`, `ipcMain.on`, `webContents.send`, and `ipcMain.emit` early.
- Log channel, direction, sender id/type/url, payload shape, duration, and error status.
- For renderer-originated messages, include frame routing ids where available.

What it can reveal:

- Codex's app-server message bridge.
- Window lifecycle messages.
- Update, settings, auth, hotkey, deep link, and debug action channels.
- Which renderer initiates each main action.

Feasibility: high for future handler registrations, medium for handlers registered before the runtime hook. Since Codex++ runtime loads before original main, it should capture most Codex registrations if installed at top-level.

Hazards:

- IPC payloads can include secrets, prompts, file contents, or account data. Shape-only logging should be the default.
- Wrapping `webContents.send` can be hot-path noisy.
- Accidentally changing return promises or thrown errors will break renderer expectations.

Codex++ integration ideas:

- Add `ipc-tap` with two modes:
  - `shape`: channel plus schema-ish payload summary.
  - `sample`: bounded redacted payload snippets for a user-selected channel.
- Use it to generate channel maps for each Codex release and diff them across stable/beta.

### 7. BrowserWindow, BrowserView, webContents, and session hooks

Local implementation:

- `packages/runtime/src/main.ts` registers preloads via `session.registerPreloadScript` when available, with `session.setPreloads` fallback.
- It hooks `app.on("session-created")`.
- It logs `app.on("web-contents-created")` and `preload-error`.
- It exposes Codex window services via `globalThis.__codexpp_window_services__`.
- It can create Codex-registered windows and BrowserViews from main-scope tweaks.

Technique:

- Wrap `BrowserWindow` constructor and `BrowserView` constructor if needed, but prefer session-level preload registration first.
- Observe `app.on("browser-window-created")`, `app.on("web-contents-created")`, `session-created`, `will-navigate`, `did-finish-load`, `preload-error`, and permission handlers.
- Inspect `webContents.getLastWebPreferences()` where available.

What it can reveal:

- Window creation options, route URLs, preload path, sandbox/contextIsolation, devTools flags, partition/session use, and webContents type.
- Which renderers miss Codex++ preload injection.
- Whether Codex changes from BrowserWindow to BrowserView/WebContentsView in future releases.

Feasibility: high for observation and preload injection. Medium for constructor patching because Electron exports can be frozen or captured before wrapping if hook order changes.

Hazards:

- Mutating webPreferences can break sandbox assumptions.
- Constructor wrapping can break `instanceof`, static methods, or native prototypes if implemented casually.
- Session preloads must be registered before target renderer creation; late registration only affects future loads.

Codex++ integration ideas:

- Keep session-level preload as primary path.
- Add a window/session diagnostics page showing webContents id, type, URL, partition, sandbox, contextIsolation, preload status, and last preload error.
- Treat constructor patching as a debug-only fallback.

### 8. Command-line switches and CDP

Local implementation:

- `packages/runtime/src/main.ts` supports `CODEXPP_REMOTE_DEBUG=1`, `CODEXPP_REMOTE_DEBUG_PORT`, config-backed `codexPlusPlus.cdp`, and app argument detection.
- Defaults are stable `9222`, beta `9223`, though current beta config also shows port `9222`.
- Runtime appends `--remote-debugging-port=<port>` via `app.commandLine.appendSwitch()` before app ready.

Command:

```sh
open -na /Applications/Codex.app --args --remote-debugging-port=9222
curl http://127.0.0.1:9222/json/version
curl http://127.0.0.1:9222/json/list
```

What it can reveal:

- Renderer targets, URLs, frame state, console/runtime evaluation, screenshots, DOM, and network activity through Chrome DevTools Protocol.
- Good proof channel for preload injection and renderer-side state.

Feasibility: high after restart. CDP must be enabled before Chromium initializes.

Hazards:

- Local CDP port exposes powerful browser control on localhost. Keep bound to loopback and avoid predictable always-on ports when possible.
- Enabling CDP does not directly expose main-process Node internals; it is mainly renderer/CDP observability.
- Port conflicts are common if stable and beta both use `9222`.

Codex++ integration ideas:

- Fix beta default/config migration so beta uses `9223` unless explicitly overridden.
- Add a health checker that validates `/json/version`, lists app targets, and stores a bounded diagnostic snapshot.

### 9. Preload lifecycle inspection

Local implementation:

- Runtime preload bundle lives at `<userRoot>/runtime/preload.js`.
- Source lives under `packages/runtime/src/preload/`.
- Main watches `runtime/preload.js` and `.codexpp-runtime-reload`; it reloads `app://` renderer windows with `reloadIgnoringCache()`.

Technique:

- Register preload through `session.registerPreloadScript({ type: "frame", filePath, id })`.
- Capture `preload-error`.
- From preload, emit `codexpp:preload-log` and a ready marker via IPC.
- Use CDP to verify globals/hooks in renderer.

What it can reveal:

- Whether sandboxed renderers run the preload.
- Which frames get Codex++ hooks.
- Renderer boot order relative to Codex preload and app hydration.

Feasibility: high. This is Codex++'s current renderer integration.

Hazards:

- Multiple preloads can race. Avoid assuming Codex globals exist at preload top-level.
- Sandboxed preload cannot use Node APIs directly; route filesystem and privileged actions through main IPC.
- HMR reload only refreshes renderer-side runtime. Main runtime still requires app restart.

Codex++ integration ideas:

- Add per-webContents preload heartbeat keyed by webContents id.
- Expose missing-preload diagnostics in Patch Manager.
- Keep main-process runtime changes on the existing external restart/rollback path.

### 10. Sparkle/update hooks

Local implementation:

- `packages/runtime/src/main.ts` wraps Sparkle module exports.
- `packages/installer/src/commands/update-codex.ts` can select a signed app from pristine backup or Sparkle cache.
- `packages/installer/src/watcher.ts` installs launchd watchers over the app bundle, resources dir, and `app.asar`.

Current hook behavior:

- `installSparkleUpdateHook()` wraps modules matching `/sparkle(?:\.node)?$/i`.
- Wrapped `installUpdatesIfAvailable` calls `prepareSignedCodexForSparkleInstall()`.
- Preparation writes `<userRoot>/update-mode.json` and restores a Developer ID signed backup with `ditto` before Sparkle installs.

What it can reveal:

- Whether Codex triggers update checks from startup, settings, or IPC.
- Update lifecycle timing and when patched app must become signed again.
- Location and contents of Sparkle cached app bundles.

Feasibility: already implemented for install interception. Medium for broader update lifecycle events, because native Sparkle may emit through native bindings or app-specific wrapper code.

Hazards:

- Updating while Codex is running can replace the app under a live process.
- Restoring signed app requires a valid Developer ID backup; ad-hoc patched app cannot pass Sparkle's assumptions.
- Failed update-mode cleanup can leave repair paused or confusing status.

Codex++ integration ideas:

- Add an update-lifecycle trace that records `checkForUpdates`, `installUpdatesIfAvailable`, update-mode write/clear, watcher repair, and final asar hash.
- Surface Sparkle cache candidates and signatures in `codexplusplus doctor`.

### 11. Source fingerprint patching

Local implementation:

- `packages/installer/src/codex-window-services.ts`
- `packages/installer/src/commands/install.ts`

Mechanism:

- During asar patching, installer searches Codex's original main and `.vite/build/main-*.js`.
- It detects the window-services factory by fingerprints such as `allowDevtools:`, `allowDebugMenu:`, `globalState:`, `desktopRoot:`, `preloadPath:`, `repoRoot:`, and `disposables:`.
- It injects `globalThis.__codexpp_window_services__=<serviceVar>;`.

What it can reveal:

- Stable internal service objects that are otherwise hidden inside minified closures.
- Entry points for Codex-native window creation, host context registration, and BrowserView integration.

Feasibility: high while the fingerprint remains valid. This survived at least one minified startup shape change per changelog notes.

Hazards:

- String-patching minified source is brittle and must be regression-tested against each Codex release.
- A false positive can inject into the wrong object and corrupt runtime behavior.
- The patch changes asar bytes and forces the full integrity/signing pipeline.

Codex++ integration ideas:

- Expand from a single hook to a fingerprint library with fixture tests against stable and beta extracted bundles.
- Emit a patch report: candidate files, match score, injected variable name, changed byte count, and post-patch smoke result.

### 12. Native and process-level fallbacks

Techniques:

- Electron fuses: inspect/flip `EnableEmbeddedAsarIntegrityValidation`.
- `Info.plist` integrity: update `ElectronAsarIntegrity["Resources/app.asar"].hash`.
- Codesign: verify Developer ID vs ad-hoc, re-sign after mutation.
- Native hooks: avoid unless Codex starts doing runtime anti-tamper or JS-level hooks become impossible.

Local implementation:

- `packages/installer/src/fuses.ts`
- `packages/installer/src/integrity.ts`
- `packages/installer/src/codesign.ts`
- `packages/installer/src/commands/install.ts`

What it can reveal:

- Whether Electron will accept a patched asar.
- Whether macOS will launch the modified bundle.
- Whether app update systems expect Developer ID signatures.

Feasibility: high for existing fuse/integrity/codesign path. Low for native hooking unless the threat model changes.

Hazards:

- Native patching increases blast radius and can trigger security tooling.
- Ad-hoc signing can break official update flow until a signed backup is restored.
- macOS App Management can deny writes to `/Applications`.

Codex++ integration ideas:

- Keep native-level changes limited to the current integrity/fuse/codesign requirements.
- Prefer JavaScript/runtime hooks for observability.
- Add preflight checks that fail before mutation when App Management or signature prerequisites are not satisfied.

## Priority Recommendations

1. Build `inspect-asar` and `fingerprint-release` first. They are read-only, low-risk, and make every later patch safer.
2. Add observation-only hook registries for `Module._load`, IPC, child_process, and window/session lifecycle. Default to shape-only/redacted logs.
3. Promote existing Sparkle wrapping into the hook registry while preserving the current behavior.
4. Add release fixture tests for stable and beta extracted main bundles. Validate window-services fingerprinting, Sparkle token presence, and main entrypoint detection.
5. Treat source patching as the last step in the pipeline: inspect, fingerprint, patch in temp, update integrity, re-sign, launch with CDP, verify health, then persist state.

## Definition Of Done For A Future Implementation

- `codexplusplus inspect-main --app /Applications/Codex.app` runs without mutating the app.
- It writes a bounded report under `<userRoot>/log/inspect-main.json`.
- It reports asar package metadata, original main, Codex++ patch metadata, integrity hash, signature status, framework/update presence, known hook fingerprints, and current CDP status.
- Optional taps are independently feature-gated: `module-load`, `ipc`, `child-process`, `window-session`, `sparkle`.
- All taps are redacted by default and capped on disk.
- Any mutating patch path has rollback from signed backup or pristine asar and validates launch through CDP `/json/version`.
