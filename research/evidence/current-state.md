# Current State Evidence

Date: 2026-05-01.

## Apps

Stable:

- App path: `/Applications/Codex.app`.
- Bundle id: `com.openai.codex`.
- Codex Desktop version: `26.429.20946`.
- Build: `2312`.
- Embedded CLI: `codex-cli 0.128.0-alpha.1`.
- Codex++ user dir: `/Users/af/Library/Application Support/codex-plusplus`.
- `codex-plusplus status`: patched asar hash matches, plist hash OK, asar
  fuse off, safe mode disabled, watcher `launchd`.

Beta:

- App path: `/Applications/Codex (Beta).app`.
- Bundle id: `com.openai.codex.beta`.
- Codex Desktop version: `26.429.21146`.
- Build: `2317`.
- Embedded CLI: `codex-cli 0.128.0-alpha.1`.
- Codex++ user dir: `/Users/af/Library/Application Support/codex-plusplus-beta`.
- `CODEX_PLUSPLUS_HOME=...beta codex-plusplus status`: patched asar hash
  matches, plist hash OK, asar fuse off, safe mode disabled, watcher `launchd`.

Both apps have `package.json#main = codex-plusplus-loader.cjs` in their
`app.asar` and include `codex-plusplus-loader.cjs`.

Homebrew CLI:

- `/opt/homebrew/bin/codex --version`: `codex-cli 0.128.0`.

## Local Codex Config

Config path: `/Users/af/.codex/config.toml`.

Important feature flags:

- `[features].goals = true`.
- `[features].multi_agent = true`.
- `[features].plugins = true`.
- `[features].apps = true`.
- `[features].apps_mcp_gateway = true`.
- `[features].shell_tool = true`.
- `[features].unified_exec = true`.

Agent controls:

- `[agents].job_max_runtime_seconds = 86400`.
- `[agents].max_depth = 64`.
- `[agents].max_threads = 4096`.

MCP servers kept enabled for this work:

- `chrome-devtools`
- `github`
- `openaiDeveloperDocs`
- `playwright`
- `playwriter`

MCP servers disabled for this work:

- `agentation`
- `alphaxiv`
- `context7`
- `figma`
- `linear`
- `notion`
- `pencil`
- `sentry`

Backup before MCP trimming:

- `/Users/af/.codex/config.toml.bak-20260501-072809`

## Implemented In This Checkout

Goal frontend:

- `packages/runtime/src/preload/app-server-bridge.ts`
- `packages/runtime/src/preload/goal-feature.ts`
- `packages/runtime/src/preload/index.ts`

Git metadata substrate:

- `packages/runtime/src/git-metadata.ts`
- `packages/runtime/test/git-metadata.test.ts`
- `packages/runtime/src/main.ts`
- `packages/runtime/src/preload/tweak-host.ts`
- `packages/sdk/src/index.ts`
- `packages/sdk/test/manifest-validation.test.ts`
- `docs/WRITING-TWEAKS.md`
- `docs/GIT_METADATA_SIDEBAR.md`

Generated installer payloads were rebuilt under:

- `packages/installer/assets/runtime/`

## Verification Already Run

- `npx tsc -p packages/runtime/tsconfig.json --noEmit`: passed.
- `npm test`: passed, 87 tests.
- `git diff --check`: passed.
- `npm run build`: passed.
- Stable `codex-plusplus status`: patched and integrity OK.
- Beta `CODEX_PLUSPLUS_HOME=...beta codex-plusplus status`: patched and
  integrity OK.
- `/opt/homebrew/bin/codex mcp list`: confirms useful MCPs enabled and unused
  MCPs disabled.

## Live App Proof

Stable was relaunched with:

```sh
CODEXPP_REMOTE_DEBUG=1 CODEXPP_REMOTE_DEBUG_PORT=9222 \
  "/Applications/Codex.app/Contents/MacOS/Codex"
```

Proof:

- `http://127.0.0.1:9222/json/version` responded with
  `Codex/26.429.20946`.
- Main log includes `remote debugging enabled on port 9222` and
  `preload registered`.
- Preload log includes `goal feature started`, `boot complete`, and
  `renderer host loaded 2 tweak(s)`.
- CDP DOM check on `app://-/index.html?hostId=local`:
  - `goalStyle: true`
  - `composer: true`
- Screenshot: `/tmp/codex-plusplus-stable.png`.

Beta was relaunched with:

```sh
CODEXPP_REMOTE_DEBUG=1 CODEXPP_REMOTE_DEBUG_PORT=9223 \
  "/Applications/Codex (Beta).app/Contents/MacOS/Codex (Beta)"
```

Proof:

- `http://127.0.0.1:9223/json/version` responded with
  `Codex(Beta)/26.429.21146`.
- Main log includes `remote debugging enabled on port 9223` and
  `preload registered`.
- Preload log includes `goal feature started`, `boot complete`, and
  `renderer host loaded 2 tweak(s)`.
- CDP DOM check on `app://-/index.html?hostId=local`:
  - `goalStyle: true`
  - `goalRoot: true`
  - `goalSuggestionRoot: true`
  - `composer: true`
- Screenshot: `/tmp/codex-plusplus-beta.png`.

## Corrections

One QA research note mentioned that `package.json` had drifted into a patched
Codex app package. That is stale or from a different view. Current evidence:

- `git diff -- package.json` is empty.
- `shasum -a 256 package.json <(git show HEAD:package.json)` produced matching
  hashes.
- `package.json` still reports `name: codex-plusplus`, `version: 0.1.4`.
