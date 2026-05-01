# Binary Archaeology Lane: Codex CLI / App-Server

Scope: research-only notes for the bundled Codex Desktop CLI and app-server surface. This file intentionally records commands and evidence paths only; it does not modify product code.

Local baseline captured on 2026-05-01:

- Stable app: `/Applications/Codex.app`, bundle id `com.openai.codex`, version `26.429.20946`, build `2312`.
- Beta app: `/Applications/Codex (Beta).app`, bundle id `com.openai.codex.beta`, version `26.429.21146`, build `2317`.
- Stable embedded CLI: `/Applications/Codex.app/Contents/Resources/codex`, `codex-cli 0.128.0-alpha.1`, arm64 Mach-O, 189 MB, sha256 `f8d19599275545386d1c2f418937f38539fdd7e31934fa36151fee0f7c22c017`.
- Beta embedded CLI: `/Applications/Codex (Beta).app/Contents/Resources/codex`, `codex-cli 0.128.0-alpha.1`, arm64 Mach-O, 189 MB, sha256 `ec7e331a17022461b1498fa9a6af31cb4d3ced18d6289984c10c4335512450d5`.
- Homebrew CLI shim: `/opt/homebrew/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js`, `codex-cli 0.128.0`.
- Stable `app.asar`: 125 MB, sha256 `738ab34411bec4f563798803b045bdfcfeb3717c85b02f2ddcf5c1ab81a7e408`.
- Beta `app.asar`: 125 MB, sha256 `21045e4334a494402c53c98dd2b589532b28bb5a4748ebf0c5f097a5e9d614b6`.

## Ranked Techniques

### 1. Binary strings: method and source-path extraction

Usefulness: very high. This is the fastest way to map app-server method names, Rust crate/source boundaries, feature names, and rough storage/logging surfaces from the stripped Rust binary.

Exact commands:

```bash
BIN="/Applications/Codex.app/Contents/Resources/codex"

strings -a "$BIN" |
  rg -o '([a-z_]+/[a-zA-Z0-9_./-]+)' |
  sort -u |
  rg '^(thread|config|fs|mcp|app|plugin|plugins|external|auth|session|task|agent|review|login|exec|codex|turn)/' |
  sed -n '1,220p'

strings -a "$BIN" |
  rg 'app-server|protocol/v2|config_api|fs_api|thread_goal|external_agent|CODEX_|RUST_LOG|SQLITE|sqlite|CREATE TABLE|schema|migration|codex_cli|codex-core|codex-rs' |
  sed -n '1,240p'
```

Confirmed high-value output:

- App-server protocol/method strings include `thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/turns/list`, `thread/goal/get`, `thread/goal/set`, `thread/goal/clear`, `thread/shellCommand`, `turn/start`, `turn/interrupt`, `review/start`, `fs/readFile`, `fs/writeFile`, `fs/watch`, `config/read`, `config/value/write`, `config/batchWrite`, `config/mcpServer/reload`, `plugin/list`, `plugin/install`, `plugin/read`, `app/list`, and `app/list/updated`.
- Source paths survive in the binary and are often more useful than symbols: `/Users/runner/work/codex/codex/codex-rs/app-server-client/src/lib.rs`, `app-server-client/src/remote.rs`, `core/src/thread_manager.rs`, `core/src/codex_thread.rs`, `core/src/state_db_bridge.rs`, `thread-store/src/local/read_thread.rs`, `core/src/tasks/review.rs`, `core/src/agent/control.rs`, `plugins/src/manifest.rs`, and `config/src/config_toml.rs`.
- Error strings identify behavior boundaries: `unsupported remote app-server request`, `duplicate remote app-server request id`, `failed to initialize in-process app-server client`, and `in-process app-server shutdown failed`.

Best use:

- Build a route/method catalog before touching UI or preload code.
- Discover native capability names that are not exposed through documented CLI help.
- Track whether a release added or removed app-server methods.

Limits:

- `strings` does not prove request/response schemas by itself.
- Some hits are path fragments or concatenated strings; treat malformed strings as leads, not contracts.

### 2. ASAR extraction: packaged JS, TypeScript-adjacent chunks, and dependency inventory

Usefulness: very high. The Electron package exposes renderer/main bundle shape, dependency names, stable-ish domain chunks, IPC channel names, and frontend callsites that explain how the app-server is consumed.

Exact commands:

```bash
ASAR="npx --yes asar"
APP="/Applications/Codex.app"
TMP="$(mktemp -d)"

$ASAR list "$APP/Contents/Resources/app.asar" |
  rg 'schema|types?|protocol|app-server|config|mcp|thread|sqlite|\\.json$|\\.map$' |
  sed -n '1,240p'

$ASAR extract "$APP/Contents/Resources/app.asar" "$TMP"

jq '{name,version,main,productName,dependencies:(.dependencies|keys)}' "$TMP/package.json"

rg --files "$TMP" |
  rg 'app-server|config-queries|mcp-settings|thread|automation|settings|package.json' |
  sed -n '1,200p'

rm -rf "$TMP"
```

Confirmed output:

- Extracted `package.json` identifies the app as `openai-codex-electron`, version `26.429.20946`, product `Codex`, main `codex-plusplus-loader.cjs`.
- Dependencies include `app-server-types`, `protocol`, `better-sqlite3`, `zod`, `smol-toml`, `node-pty`, `ws`, `react`, and `react-dom`.
- Stable app chunks observed locally include:
  - `/webview/assets/app-server-connection-state-qvZU6MxX.js`
  - `/webview/assets/app-server-manager-hooks-DEjiw62x.js`
  - `/webview/assets/app-server-manager-signals-B_sRWyjv.js`
  - `/webview/assets/config-queries-C-qINdQW.js`
  - `/webview/assets/mcp-settings-Cra-v5Bl.js`
  - `/webview/assets/thread-page-header-BE4NuQx7.js`
  - `/.vite/build/app-session-3mnvnHpB.js`
  - `/.vite/build/main-SLemWUtC.js`

Best use:

- Find renderer-visible protocol usage and stable DOM or route anchors.
- Identify dependency-provided schema packages before reverse-engineering minified chunks by hand.
- Confirm whether a Codex++ patch has changed the app entrypoint. Here `main` is `codex-plusplus-loader.cjs`, so this installed stable app is already Codex++ patched.

Limits:

- Chunk filenames are hash-local and changed between stable and beta.
- `asar extract-file` returned empty for this patched ASAR in local testing; full `asar extract` worked reliably.
- Minified chunks can emit enormous single-line matches. Prefer `rg -o`, `sed -n`, and file lists over dumping matched lines.

### 3. SQLite schema inspection: state, logs, goals, agents, and event storage

Usefulness: very high for durable state contracts. SQLite schemas are less ambiguous than binary strings and directly reveal app persistence boundaries.

Exact commands:

```bash
find "$HOME/.codex" -maxdepth 5 -type f \
  \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print

sqlite3 "$HOME/.codex/logs_2.sqlite" '.tables'
sqlite3 "$HOME/.codex/logs_2.sqlite" '.schema'

sqlite3 "$HOME/.codex/state_5.sqlite" '.tables'
sqlite3 "$HOME/.codex/state_5.sqlite" '.schema threads'
sqlite3 "$HOME/.codex/state_5.sqlite" '.schema thread_goals'
sqlite3 "$HOME/.codex/state_5.sqlite" '.schema thread_spawn_edges'
sqlite3 "$HOME/.codex/state_5.sqlite" '.schema agent_jobs'
sqlite3 "$HOME/.codex/state_5.sqlite" '.schema agent_job_items'
sqlite3 "$HOME/.codex/state_5.sqlite" '.schema remote_control_enrollments'

sqlite3 "$HOME/.codex/sqlite/codex-dev.db" '.tables'
sqlite3 "$HOME/.codex/sqlite/codex-dev.db" '.schema'
```

Confirmed local schemas:

```sql
CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL,
    level TEXT NOT NULL,
    target TEXT NOT NULL,
    feedback_log_body TEXT,
    module_path TEXT,
    file TEXT,
    line INTEGER,
    thread_id TEXT,
    process_uuid TEXT,
    estimated_bytes INTEGER NOT NULL DEFAULT 0
);
```

```sql
CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'budget_limited', 'complete')),
    token_budget INTEGER,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
```

```sql
CREATE TABLE thread_spawn_edges (
    parent_thread_id TEXT NOT NULL,
    child_thread_id TEXT NOT NULL PRIMARY KEY,
    status TEXT NOT NULL
);
```

```sql
CREATE TABLE agent_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    instruction TEXT NOT NULL,
    output_schema_json TEXT,
    input_headers_json TEXT NOT NULL,
    input_csv_path TEXT NOT NULL,
    output_csv_path TEXT NOT NULL,
    auto_export INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    last_error TEXT,
    max_runtime_seconds INTEGER
);
```

Best use:

- Infer durable entities and status enums: goals, spawned-agent edges, agent jobs, dynamic tools, logs, automations, remote enrollments.
- Build Codex++ features against observed persistence boundaries rather than fragile UI strings.
- Validate whether app-server methods have a backing table and what exact status vocabulary they use.

Limits:

- Local DBs are user-state snapshots. Always combine with migration/source-path strings before assuming every table exists on every install.
- Do not dump row contents into research artifacts unless the task explicitly needs it; schemas are enough for most protocol archaeology and avoid private data exposure.

### 4. Prod-vs-beta comparison: release drift and hash-local UI chunks

Usefulness: high. Comparing stable and beta quickly separates stable protocol contracts from release-local asset names.

Exact commands:

```bash
for app in "/Applications/Codex.app" "/Applications/Codex (Beta).app"; do
  echo "### $app"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist"
  shasum -a 256 "$app/Contents/Resources/app.asar"
  "$app/Contents/Resources/codex" --version
done

TMP="$(mktemp -d)"
npx --yes asar list "/Applications/Codex.app/Contents/Resources/app.asar" | sort > "$TMP/stable.list"
npx --yes asar list "/Applications/Codex (Beta).app/Contents/Resources/app.asar" | sort > "$TMP/beta.list"
comm -23 "$TMP/stable.list" "$TMP/beta.list" | sed -n '1,80p'
comm -13 "$TMP/stable.list" "$TMP/beta.list" | sed -n '1,80p'
rm -rf "$TMP"

for app in "/Applications/Codex.app" "/Applications/Codex (Beta).app"; do
  out="/tmp/$(basename "$app" | tr -cd 'A-Za-zBeta').methods"
  strings -a "$app/Contents/Resources/codex" |
    rg -o '([a-z_]+/[a-zA-Z0-9_./-]+)' |
    sort -u |
    rg '^(thread|config|fs|plugin|plugins|app|turn|review|exec|auth|externalAgentConfig|account)/' > "$out"
  wc -l "$out"
done
comm -23 /tmp/Codexapp.methods /tmp/CodexBetaapp.methods
comm -13 /tmp/Codexapp.methods /tmp/CodexBetaapp.methods
```

Confirmed result:

- Stable and beta embedded CLI method-string catalogs both had 146 filtered method-like entries.
- No filtered method-string differences were observed between stable and beta for the command above.
- ASAR chunks differed heavily by hash: for example stable `composer-B5UwBne4.js` vs beta `composer-hnck5THl.js`, stable `config-queries-C-qINdQW.js` vs beta `config-queries-mr08pnDg.js`, and stable `app-server-manager-hooks-DEjiw62x.js` vs beta `app-server-manager-hooks-pChEMmQm.js`.

Best use:

- Rank protocol strings higher than hashed chunk filenames.
- Detect app-server surface changes before attempting a Codex++ compatibility update.
- Keep per-release bundle evidence without treating chunk names as stable extension points.

Limits:

- Equal method strings do not prove equal semantics.
- Beta can differ in minified frontend behavior even when Rust method strings match.

### 5. CLI help and debug surfaces

Usefulness: medium-high. Help output is stable, cheap, and proves what is intentionally exposed.

Exact commands:

```bash
/Applications/Codex.app/Contents/Resources/codex --version
/Applications/Codex.app/Contents/Resources/codex debug --help
/Applications/Codex.app/Contents/Resources/codex debug app-server --help
/opt/homebrew/bin/codex --version
```

Confirmed output:

- Embedded app CLI reports `codex-cli 0.128.0-alpha.1`.
- Homebrew shim reports `codex-cli 0.128.0`.
- `codex debug` exposes `models`, `app-server`, and `prompt-input`.
- `codex debug app-server` exposes only `send-message-v2 <USER_MESSAGE>`.
- Debug commands accept `-c key=value`, `--enable <FEATURE>`, and `--disable <FEATURE>`, which map to `features.<name>=true/false`.

Best use:

- Establish a non-invasive probe surface before dynamic experiments.
- Toggle features for runtime validation without editing `~/.codex/config.toml`.
- Confirm whether a method catalog is officially exposed. Locally, it is not.

Limits:

- The app-server debug surface is narrow and conversation-oriented; it is not a general RPC explorer.

### 6. Environment/log toggle extraction

Usefulness: medium. Useful for finding knobs, but noisy because vendored libraries contribute many environment names.

Exact command:

```bash
BIN="/Applications/Codex.app/Contents/Resources/codex"

strings -a "$BIN" |
  rg -o '\\b[A-Z][A-Z0-9_]{2,}\\b' |
  sort -u |
  rg '^(CODEX|RUST|OPENAI|APP|MCP|DEBUG|TRACE|LOG|OTEL|TOKIO|SQL|DATABASE|HOME|XDG|NO_|HTTPS?|SSL|BROWSER|ELECTRON|CHROME|AGENT|TS_|CARGO|TUI|TERM|SHELL|TMP)' |
  sed -n '1,240p'
```

Confirmed useful hits:

- `CODEX_HOME`
- `CODEX_URL`
- `CODEX_AGENT_IDENTITY`
- `CODEX_CA_CERTIFICATE`
- `CODEX_GITHUB_PERSONAL_ACCESS_TOKEN`
- `OPENAI_API_KEY`
- `RUST_BACKTRACE`
- `RUST_LIB_BACKTRACE`
- `OTEL_TRACES_SAMPLER`
- `OTEL_TRACES_SAMPLER_ARG`
- `SQLITE_FORCE_PROXY_LOCKING`
- `SQLITE_TMPDIR`
- `LOG_SENSITIVE_BODIES`
- `LOG_SIGNABLE_BODY`
- proxy variables such as `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`

Best use:

- Discover runtime toggles for dynamic experiments.
- Feed a controlled launch wrapper for log-heavy app-server probing.
- Identify sensitive logging flags that must not be enabled casually.

Limits:

- Many names come from OpenSSL, SQLite, OpenTelemetry, AWS, or HTTP crates rather than Codex-owned code.
- Environment strings prove the binary references a name, not that a given code path uses it in the app-server.

### 7. Mach-O linkage and symbol-table work: `file`, `otool`, `nm`

Usefulness: medium-low for app-server protocols, medium for platform capability mapping.

Exact commands:

```bash
for b in \
  "/Applications/Codex.app/Contents/Resources/codex" \
  "/Applications/Codex (Beta).app/Contents/Resources/codex" \
  "/Applications/Codex.app/Contents/Resources/codex_chronicle" \
  "/Applications/Codex.app/Contents/MacOS/Codex"; do
  echo "### $b"
  file "$b"
  shasum -a 256 "$b"
  ls -lh "$b"
  "$b" --version 2>&1 | sed -n '1,3p' || true
done

otool -L "/Applications/Codex.app/Contents/Resources/codex" | sed -n '1,80p'
nm -m "/Applications/Codex.app/Contents/Resources/codex" 2>&1 | sed -n '1,80p'
nm -m "/Applications/Codex.app/Contents/Resources/codex" 2>&1 |
  rg ' no symbols|app_server|codex|rust|tokio|serde|sqlite|rusqlite|sqlx' |
  sed -n '1,160p'
```

Confirmed output:

- The embedded CLI is a 64-bit arm64 Mach-O executable.
- `otool -L` shows platform capability dependencies including `AppKit`, `CoreGraphics`, `IOKit`, `AVFoundation`, `AudioToolbox`, `CoreMedia`, `VideoToolbox`, `Metal`, `MetalKit`, `ScreenCaptureKit` as weak, `Security`, `CoreImage`, `liblzma`, `libbz2`, `libz`, and `libc++`.
- `nm -m` mostly exposes undefined external platform symbols. It did not expose useful Rust app-server symbols in this local build.

Best use:

- Confirm binary architecture, signing-era drift, and native framework blast radius.
- Identify surprising native capabilities such as audio/video/screen capture framework linkage.
- Fingerprint prod/beta/app helper binaries.

Limits:

- Rust symbols appear stripped or not useful for app-server mapping.
- `nm` is far less productive than `strings` on this binary.

### 8. Embedded artifact/type extraction from package dependencies

Usefulness: medium. The dependency list proves packages named `app-server-types` and `protocol` are bundled, but this local asar extraction did not expose readable files under those package directories with the simple file walk used.

Exact commands:

```bash
TMP="$(mktemp -d)"
npx --yes asar extract "/Applications/Codex.app/Contents/Resources/app.asar" "$TMP"

find "$TMP/node_modules/app-server-types" "$TMP/node_modules/protocol" -maxdepth 3 -type f 2>/dev/null |
  sed -n '1,160p'

rg --files "$TMP/node_modules" |
  rg 'app-server-types|protocol' |
  sed -n '1,120p'

rm -rf "$TMP"
```

Observed result:

- `package.json` lists `app-server-types` and `protocol`.
- The above direct file walks produced no useful readable files locally. Likely explanations: bundled/virtualized packages, pruned package contents, or code folded into Vite chunks.

Best use:

- Start here before hand-parsing minified code; if readable type files appear in a future build, they should outrank minified chunk archaeology.
- Use dependency presence to choose search terms inside extracted `.vite/build` and `webview/assets`.

Limits:

- Not currently enough by itself on this install.

## Recommended Workflow

1. Fingerprint binaries and app bundles first.
   - Run `file`, `shasum -a 256`, `--version`, `PlistBuddy`, and ASAR hash commands.
   - Record stable and beta versions together.

2. Build the app-server method catalog from `strings`.
   - Keep the filtered method list as a release-local artifact.
   - Diff stable vs beta to catch added/removed methods.

3. Extract ASAR to a temp directory.
   - Read `package.json`.
   - Locate app-server/config/MCP/thread chunks.
   - Search with `rg -o` and bounded output to avoid huge minified lines.

4. Inspect SQLite schemas, not private rows.
   - Capture table names and `.schema` output for relevant tables.
   - Use schema enums and foreign keys to validate protocol hypotheses.

5. Use debug CLI commands for intentional surfaces.
   - Prefer `--enable`, `--disable`, and `-c` overrides for experiments.
   - Do not assume debug app-server exposes the full app-server RPC surface.

6. Use `otool`/`nm` only after the string/schema passes.
   - `otool` is useful for native capability mapping.
   - `nm` has low yield for Rust app-server internals in the current local binary.

## Ranked Summary

| Rank | Technique | Usefulness | Why |
| --- | --- | --- | --- |
| 1 | `strings` method/source extraction | Very high | Fastest way to expose app-server methods and Rust crate/source anchors. |
| 2 | Full `app.asar` extraction | Very high | Shows packaged JS, IPC chunks, dependency inventory, and Codex++ loader state. |
| 3 | SQLite `.schema` inspection | Very high | Reveals durable state contracts, enums, and relationship tables with low ambiguity. |
| 4 | Stable vs beta diffs | High | Separates stable protocol strings from hash-local UI chunks and detects release drift. |
| 5 | CLI debug help | Medium-high | Proves intentional public/debug surfaces and feature override syntax. |
| 6 | Env/log toggle extraction | Medium | Finds useful knobs but has heavy vendored-library noise. |
| 7 | `file`/`otool`/`nm` | Medium-low | Good for binary fingerprinting and native capabilities; weak for Rust protocol internals. |
| 8 | Direct embedded type package extraction | Medium today | Promising because packages exist, but this local build did not expose readable package files directly. |

