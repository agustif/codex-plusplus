# Automation QA And Product Proof Notes

Scope: Codex++ testing and product-proof systems only. This file is the owned output for the automation QA lane.

## 1. Best Immediate Wins

### 1.1 Add a CDP-backed product proof harness

Codex++ already has the right runtime seam for this: `packages/runtime/src/main.ts` can enable Chromium remote debugging with `CODEXPP_REMOTE_DEBUG=1` and `CODEXPP_REMOTE_DEBUG_PORT`, then appends Electron's `remote-debugging-port` switch before app readiness. That means the proof harness should connect to the real patched Codex renderer instead of launching a fake browser.

Recommended first script:

```sh
scripts/qa/cdp-proof.mjs
```

Recommended command shape:

```sh
CODEXPP_REMOTE_DEBUG=1 CODEXPP_REMOTE_DEBUG_PORT=9222 open -n /Applications/Codex.app
curl -fsS http://127.0.0.1:9222/json/version | jq .
curl -fsS http://127.0.0.1:9222/json/list | jq '.[] | {id,type,title,url,webSocketDebuggerUrl}'
node scripts/qa/cdp-proof.mjs --endpoint http://127.0.0.1:9222 --out research/evidence/cdp/$(date +%Y%m%d-%H%M%S)
```

Minimum script behavior:

- Poll `http://127.0.0.1:<port>/json/list` until a target with `app://-/index.html` appears.
- Attach with Playwright `chromium.connectOverCDP(endpoint)` for high-level actions and screenshots.
- Create a raw CDP session for low-level facts that Playwright does not expose cleanly.
- Save `targets.json`, `version.json`, `console.ndjson`, `preload-log-tail.txt`, `main-log-tail.txt`, `dom.html`, `accessibility.json`, and screenshots.
- Fail if no target is found, no `[codex-plusplus preload] boot complete` appears, the settings sidebar lacks `Codex++`, or screenshots are blank.

Why Playwright first: official Playwright supports attaching to an existing browser over CDP with `chromium.connectOverCDP("http://localhost:9222")`. It is lower fidelity than Playwright's own protocol, but this repo needs to drive a production Electron app that already exists. Raw CDP stays available for precise calls like `Page.captureScreenshot`, `Runtime.evaluate`, `Log.enable`, and `DOMSnapshot.captureSnapshot`.

Useful primary docs:

- Electron command-line switch: https://www.electronjs.org/docs/latest/api/command-line
- Playwright CDP attach: https://playwright.dev/docs/api/class-browsertype
- Chrome DevTools Protocol `Page.captureScreenshot`: https://chromedevtools.github.io/devtools-protocol/1-3/Page/#method-captureScreenshot
- Playwright screenshots: https://playwright.dev/docs/screenshots
- Playwright traces: https://playwright.dev/docs/trace-viewer-intro

### 1.2 Make preload logs a first-class pass/fail signal

Runtime preload already mirrors renderer progress to disk through `ipcRenderer.send("codexpp:preload-log", ...)` and `ipcMain.on("codexpp:preload-log", ...)`. Treat that as the fastest reliable smoke check because production Codex disables in-window DevTools.

Exact commands:

```sh
tail -n 200 "$HOME/Library/Application Support/codex-plusplus/log/main.log"
tail -n 200 "$HOME/Library/Application Support/codex-plusplus/log/preload.log"
rg -n "remote debugging enabled|preload registered|web-contents-created|boot complete|boot FAILED|preload-error|tweak load failed" "$HOME/Library/Application Support/codex-plusplus/log"
```

Recommended script:

```sh
scripts/qa/preload-log-smoke.mjs --root "$HOME/Library/Application Support/codex-plusplus" --since-minutes 10
```

Pass criteria:

- `main.log` contains `main.ts evaluated`.
- `main.log` contains `preload registered`.
- `main.log` contains at least one `web-contents-created`.
- `preload.log` contains `preload entry`, `react hook installed`, `settings injector started`, `tweak host started`, and `boot complete`.
- No matching `boot FAILED`, `preload-error`, `tweak load failed`, `uncaughtException`, or `unhandledRejection` after the selected start time.

The log checker should output JSON for PR evidence:

```json
{
  "ok": true,
  "checkedAt": "2026-05-01T00:00:00.000Z",
  "root": "/Users/af/Library/Application Support/codex-plusplus",
  "requiredMarkers": ["preload registered", "boot complete"],
  "forbiddenMarkers": [],
  "files": ["main.log", "preload.log"]
}
```

### 1.3 Smoke-test the app patch before any visual flow

Patch correctness is a separate lane from renderer UI proof. Always run these before CDP screenshots:

```sh
node packages/installer/dist/cli.js status
node packages/installer/dist/cli.js doctor
node packages/installer/dist/cli.js validate-tweak "$HOME/Library/Application Support/codex-plusplus/tweaks/<tweak-id>"
```

Useful deeper macOS probes:

```sh
plutil -p "/Applications/Codex.app/Contents/Info.plist" | rg -n "ElectronAsarIntegrity|CFBundleIdentifier|CFBundleShortVersionString"
codesign --verify --deep --strict --verbose=2 /Applications/Codex.app
codesign -dv --verbose=4 /Applications/Codex.app 2>&1 | rg -n "Authority|TeamIdentifier|Signature"
launchctl list | rg codexplusplus
tail -n 200 "$HOME/Library/Logs/codex-plusplus-watcher.log"
```

Recommended script:

```sh
scripts/qa/app-patch-smoke.mjs --app /Applications/Codex.app --json research/evidence/app-patch-smoke.json
```

Pass criteria:

- `status` reports a user dir, tweak dir, log dir, install state, and current app metadata.
- `doctor` exits zero.
- Current asar hash matches the patched hash or the script reports a repair-needed state explicitly.
- `Info.plist` integrity hash matches the current asar header hash on macOS.
- macOS code signature verifies after ad-hoc signing.
- Watcher is present unless the install state records `watcher: none`.

### 1.4 Add slash-command QA for `/goal`

The current preload includes a slash-command feature in `packages/runtime/src/preload/goal-feature.ts`. Product proof should exercise it through the real input box, not by unit-testing `parseGoalCommand` alone.

Recommended CDP/Playwright flow:

```sh
node scripts/qa/cdp-slash-goal-smoke.mjs \
  --endpoint http://127.0.0.1:9222 \
  --out research/evidence/slash-goal/$(date +%Y%m%d-%H%M%S)
```

Flow:

1. Attach to the real Codex target.
2. Find the active prompt editable via accessibility role/text fallback.
3. Type `/g`, assert the `/goal` suggestion renders.
4. Press `Tab`, assert text expands to `/goal`.
5. Type ` QA smoke objective <timestamp>` and press `Enter`.
6. Assert a goal panel appears and `preload.log` records `goal set`.
7. Type `/goal`, press `Enter`, assert current goal renders.
8. Type `/goal clear`, press `Enter`, assert goal cleared notice renders.

Evidence to save:

- `before.png`
- `suggestion.png`
- `goal-set.png`
- `goal-query.png`
- `goal-cleared.png`
- `preload-log-tail.txt`
- `trace.zip` if using Playwright tracing
- `result.json` with selector strategy used and timings

Guardrail: the script must not send real model prompts. It should only interact with local slash-command handling and stop before a normal chat submit path when the command parser fails.

### 1.5 Installer drift QA

Installer drift means the installed app, runtime assets, watcher, and source package have stopped describing the same product. Codex++ has several drift surfaces:

- `state.json` has `version`, `patchedAsarHash`, `codexVersion`, `codexChannel`, `watcher`.
- `package.json` has repo version and scripts in the source checkout.
- Runtime assets are copied into `packages/installer/assets/runtime` during build.
- User runtime is staged under `~/Library/Application Support/codex-plusplus/runtime`.
- Sparkle/update mode is tracked under `update-mode.json`.

Recommended script:

```sh
scripts/qa/installer-drift.mjs \
  --source /Users/af/codex-plusplus \
  --user-root "$HOME/Library/Application Support/codex-plusplus" \
  --app /Applications/Codex.app \
  --out research/evidence/installer-drift.json
```

Exact probes:

```sh
node -e "console.log(JSON.stringify(require('$HOME/Library/Application Support/codex-plusplus/state.json'), null, 2))"
node -e "console.log(JSON.stringify(require('$HOME/Library/Application Support/codex-plusplus/config.json'), null, 2))"
diff -qr packages/runtime/dist packages/installer/assets/runtime
diff -qr packages/installer/assets/runtime "$HOME/Library/Application Support/codex-plusplus/runtime"
node packages/installer/dist/cli.js status
node packages/installer/dist/cli.js doctor
```

Pass criteria:

- Source version, installer state version, and runtime `CODEX_PLUSPLUS_VERSION` match unless a runtime update is intentionally pending.
- `packages/runtime/dist` and `packages/installer/assets/runtime` match after build.
- Installed user runtime matches `packages/installer/assets/runtime` after install/repair.
- `update-mode.json` is absent or fresh and intentionally active.
- Watcher command points at the installed CLI and does not depend on global npm.

### 1.6 Visual proof bundle

Every visible UI change needs route/state screenshots. For Codex++ this is less about routes and more about host states:

- App launched, no settings open.
- Settings open with Codex native settings restored.
- Settings open with Codex++ Config selected.
- Settings open with Tweaks selected.
- Tweaks page with zero tweaks.
- Tweaks page with one valid renderer tweak.
- Tweak registered page visible in sidebar.
- Tweak load failure visible in logs and not a broken UI.
- Safe mode enabled.
- Update available state.

Recommended command:

```sh
node scripts/qa/cdp-visual-proof.mjs \
  --endpoint http://127.0.0.1:9222 \
  --matrix desktop=1440x1000,narrow=430x932 \
  --out research/evidence/visual/$(date +%Y%m%d-%H%M%S)
```

Recommended proof manifest:

```json
{
  "app": "/Applications/Codex.app",
  "endpoint": "http://127.0.0.1:9222",
  "viewports": ["1440x1000", "430x932"],
  "screenshots": [
    {
      "name": "settings-codexpp-config-desktop.png",
      "viewport": "1440x1000",
      "assertions": ["Codex++ header visible", "auto-update toggle visible"]
    }
  ],
  "logs": ["main-log-tail.txt", "preload-log-tail.txt"],
  "result": "passed"
}
```

Blank/false-positive checks:

```sh
sips -g pixelWidth -g pixelHeight research/evidence/visual/*/*.png
```

The script should also perform a simple pixel entropy check using `sharp` or `pngjs` so a white/transparent/black screenshot fails even if Playwright says capture succeeded.

## 2. Medium Bets

### 2.1 Add Playwright Test as the evidence runner

Current repo tests use Node's built-in test runner through:

```sh
node --import tsx --test packages/*/test/*.test.ts
```

Keep that for pure package tests. Add Playwright Test only for product proof, artifact management, traces, screenshots, retries, and HTML/JSON reporting.

Recommended dependency set, from current npm metadata checked on 2026-05-01:

- `@playwright/test` 1.59.1, Apache-2.0, high-level browser automation and reporters.
- `playwright-core` 1.59.1, Apache-2.0, enough when browsers are not installed because the target is existing Codex over CDP.
- `chrome-remote-interface` 0.34.0, MIT, optional for raw CDP scripts that should not carry Playwright.
- `pixelmatch` 7.2.0, ISC, small pixel-diff engine.
- `pngjs` 7.0.0, MIT, pure JS PNG decode/encode for pixelmatch.
- `sharp` 0.34.5, Apache-2.0, faster image processing and entropy/resize checks.

Recommended first package addition:

```sh
npm install -D @playwright/test pixelmatch pngjs sharp
```

If keeping install weight low:

```sh
npm install -D playwright-core pixelmatch pngjs
```

Recommended config:

```sh
playwright.config.ts
```

Minimum settings:

- `testDir: "testing/product-proof"`
- `outputDir: "research/evidence/playwright-results"`
- `reporter: [["list"], ["json", { outputFile: "research/evidence/playwright-results/results.json" }], ["html", { outputFolder: "research/evidence/playwright-report", open: "never" }]]`
- `use.trace: "retain-on-failure"`
- `use.screenshot: "only-on-failure"` for regular tests, explicit `page.screenshot()` for proof states.
- `retries: 0` locally; retries can hide product-proof flakes.

Commands:

```sh
npx playwright test --config playwright.config.ts
npx playwright show-report research/evidence/playwright-report
npx playwright show-trace research/evidence/playwright-results/<trace>.zip
```

### 2.2 Create a tiny fixture tweak pack

Most visual states need known tweak data. Add a future fixture tweak pack under a test-only location, then link it with the existing CLI:

```sh
node packages/installer/dist/cli.js create-tweak testing/fixtures/tweaks/qa-renderer --id qa.renderer --name "QA Renderer" --repo agustif/codex-plusplus --scope renderer
node packages/installer/dist/cli.js validate-tweak testing/fixtures/tweaks/qa-renderer
node packages/installer/dist/cli.js dev testing/fixtures/tweaks/qa-renderer --name qa.renderer --replace --no-watch
```

Fixture tweak behaviors:

- Register a small section on the Tweaks page.
- Register a dedicated page with deterministic text and a button.
- Log `qa renderer started`.
- Write/read one storage value.
- Expose one safe IPC round trip to a main fixture tweak.

Do not depend on real user tweaks for product proof. Real tweak folders can contain private code and unstable UI.

### 2.3 Add a patch sandbox for install/repair tests

The current test suite has unit coverage for platform detection, tweak validation, update-mode, watcher health, storage, mcp sync, discovery, lifecycle, and git metadata. The missing middle is a disposable Electron-like app bundle fixture that can be patched end-to-end without touching `/Applications/Codex.app`.

Recommended fixture generator:

```sh
scripts/qa/make-fake-codex-app.mjs --out /tmp/codexpp-fake/Codex.app
```

It should create:

- `Contents/Info.plist`
- `Contents/Resources/app.asar`
- `Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`
- An asar with `package.json` and a tiny main entry.

Recommended smoke:

```sh
npm run build
node packages/installer/dist/cli.js install --app /tmp/codexpp-fake/Codex.app --no-resign --no-watcher --no-default-tweaks
node packages/installer/dist/cli.js status
node packages/installer/dist/cli.js doctor
node packages/installer/dist/cli.js repair --app /tmp/codexpp-fake/Codex.app --force
node packages/installer/dist/cli.js uninstall --app /tmp/codexpp-fake/Codex.app
```

This catches asar layout drift, loader injection failures, state mismatches, and uninstall restore issues without requiring a real Codex install.

### 2.4 Add QA result normalization

Recommended script:

```sh
scripts/qa/write-proof-summary.mjs --in research/evidence/<run> --out research/evidence/<run>/SUMMARY.md
```

The summary should contain:

- App path.
- Codex version and channel.
- Codex++ source commit.
- Dirty worktree summary.
- Commands run.
- Pass/fail table.
- Screenshot list with viewport.
- Log marker table.
- Exact files attached or ready to attach to PR.

This prevents "tested locally" PR bodies. The PR body can link or paste this summary.

## 3. Wild Ideas Or Moonshots

### 3.1 In-app QA tweak

Build a test-only main+renderer tweak that exposes a local QA control panel inside Codex++ itself. It could request screenshots, dump target metadata, force reload tweaks, and render known states. This would be useful for manual dogfooding but should stay test-only and disabled by default.

### 3.2 MCP proof server

Codex++ already syncs tweak-provided MCP servers into `~/.codex/config.toml`. A dedicated QA MCP server could expose `codexpp_proof_run`, `codexpp_screenshot`, `codexpp_logs`, and `codexpp_installer_drift` tools for agents. That lets future agents generate product proof without remembering script flags.

### 3.3 Visual history

Store one screenshot manifest per release in `research/evidence/releases/<version>/`. The next release candidate can compare current screenshots against the previous release with `pixelmatch` and produce a diff bundle.

This should not gate every PR at first. Use it for release candidates and large UI changes until baselines are stable.

## 4. Constraints And Exact Evidence

### 4.1 Current repo command caveat

At exploration time, `/Users/af/codex-plusplus/package.json` in the working tree had drifted into a patched Codex app `package.json` with `name: "openai-codex-electron"` and `main: "codex-plusplus-loader.cjs"`. The committed root package still has the expected Codex++ workspace scripts.

Use this to inspect the committed scripts without touching the dirty file:

```sh
git show HEAD:package.json | jq '.scripts'
```

Committed expected scripts:

```sh
npm run build
npm test
npm run audit
```

Direct package commands that avoid relying on root script discovery:

```sh
npm --prefix packages/sdk run build
npm --prefix packages/runtime run build
npm --prefix packages/installer run build
node --import tsx --test packages/*/test/*.test.ts
```

Do not run any command that rewrites app bundles or root metadata in this dirty checkout until the package drift is intentionally resolved or moved into a clean worktree.

### 4.2 Existing product surfaces found

Runtime/product proof anchors:

- Remote debug env in `packages/runtime/src/main.ts`: `CODEXPP_REMOTE_DEBUG=1`, `CODEXPP_REMOTE_DEBUG_PORT`.
- Preload registration in `packages/runtime/src/main.ts`: prefers `session.registerPreloadScript`, falls back to `session.setPreloads`.
- WebContents diagnostics in `packages/runtime/src/main.ts`: logs `web-contents-created` and `preload-error`.
- Preload milestones in `packages/runtime/src/preload/index.ts`: `preload entry`, `react hook installed`, `settings injector started`, `tweak host started`, `manager mounted`, `boot complete`.
- Settings DOM injection in `packages/runtime/src/preload/settings-injector.ts`.
- Renderer tweak host and load-failure console/log behavior in `packages/runtime/src/preload/tweak-host.ts`.
- Slash-command `/goal` flow in `packages/runtime/src/preload/goal-feature.ts`.
- App-server bridge in `packages/runtime/src/preload/app-server-bridge.ts`.
- Installer commands in `packages/installer/src/cli.ts`: `install`, `uninstall`, `repair`, `update-codex`, `update`, `status`, `doctor`, `create-tweak`, `validate-tweak`, `dev`, `safe-mode`.
- Watcher install and update/repair scheduling in `packages/installer/src/watcher.ts`.
- CI baseline in `.github/workflows/ci.yml`: `npm ci`, `npm test`, `npm run build`.

### 4.3 Existing docs that should stay in sync

- `README.md`: install, status, repair, update, update-codex, user paths.
- `docs/ARCHITECTURE.md`: loader, runtime, preload, update handling.
- `docs/TROUBLESHOOTING.md`: current manual DevTools/log guidance.
- `docs/WRITING-TWEAKS.md`: tweak author diagnostics and API.

The future QA scripts should update troubleshooting docs only after they exist. For this lane, the recommended scripts are documented here only.

### 4.4 Security and safety boundaries

- CDP port must be opt-in and local-only. Prefer `127.0.0.1` in scripts and never expose it on a public interface.
- QA slash-command scripts must not send normal chat prompts if `/goal` parsing fails.
- Evidence bundles must redact user paths when publishing outside the repo if they contain private home directory or tweak IDs.
- Do not upload raw `preload.log`/`main.log` wholesale to public PRs. Tail and filter to Codex++ markers.
- Fixture tweaks should be test-owned and deterministic. Do not run visual proof against arbitrary user tweak folders by default.
- Installer smoke commands must default to a fake app bundle or explicit `--app` path. Never silently patch whichever Codex install is auto-detected in CI.

## 5. Suggested Next Slice

1. Recover or isolate the root package drift in a clean worktree before running root `npm` scripts.
2. Add `scripts/qa/preload-log-smoke.mjs` first because it has no browser dependency and directly validates the existing log contract.
3. Add `scripts/qa/cdp-proof.mjs` using Playwright over `CODEXPP_REMOTE_DEBUG_PORT=9222`.
4. Add `testing/fixtures/tweaks/qa-renderer` and a main fixture only after the CDP proof can attach and capture screenshots.
5. Add `scripts/qa/app-patch-smoke.mjs` and `scripts/qa/installer-drift.mjs`.
6. Add Playwright Test config and move CDP proof flows into `testing/product-proof/*.spec.ts` once the script API is stable.
7. Wire CI in two layers:
   - Always: unit tests, build, fixture fake-app install/repair smoke.
   - Manual macOS workflow: real Codex app patch proof, CDP screenshots, slash-command QA, and installer drift.

Definition of done for the next implementation PR:

- `node scripts/qa/preload-log-smoke.mjs --root "$HOME/Library/Application Support/codex-plusplus"` emits machine-readable JSON and non-zero exit on missing/failed markers.
- `node scripts/qa/cdp-proof.mjs --endpoint http://127.0.0.1:9222 --out <dir>` captures at least one nonblank screenshot and target manifest.
- PR body includes exact commands, evidence paths, and says whether visual proof was against fake app, real Codex stable, or real Codex beta.
