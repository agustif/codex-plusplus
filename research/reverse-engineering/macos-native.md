# macOS Native Reverse-Engineering Lane

Date: 2026-05-01.

Scope: safe, local, process-level techniques for observing Codex.app and
Codex++ behavior on macOS. This note is for building Codex++ observability and
diagnostic tooling, not for bypassing platform protections or modifying Codex
outside the existing Codex++ patch/repair contract.

## Ground Rules

- Prefer passive observation first: `ps`, `lsof`, `log stream`, `sqlite3`
  read-only views, app bundle metadata, and Codex++ logs.
- Treat attach/injection/debugger techniques as lab-only and opt-in. They can
  pause, crash, or invalidate the target process and they may require root,
  Developer Tools approval, Full Disk Access, SIP changes, or entitlement
  changes.
- Do not run `sudo dtruss`, `sudo fs_usage`, `spindump`, or `lldb attach` in
  normal support flows. Provide a copyable command and ask the user to run it
  only when the signal justifies the risk.
- Do not collect raw prompt content, raw tool arguments, auth cookies, SQLite
  row values, or environment variables by default. Store shape metadata and
  redacted paths first.
- Codex++ should integrate these observations as bounded probes with explicit
  timeouts, output caps, and redaction. No long-running global trace by default.

## Current Local Shape

Observed stable app facts:

```sh
codesign -dv --verbose=4 "/Applications/Codex.app" 2>&1
codesign -d --entitlements :- "/Applications/Codex.app" 2>/dev/null
plutil -p "/Applications/Codex.app/Contents/Info.plist"
lsof -nP -c Codex
ps -axo pid,ppid,user,stat,comm,args | grep -E '(/Applications/Codex.app|codex-plusplus|self-mcp|Codex Helper)'
```

Findings from the current machine:

- Stable app path: `/Applications/Codex.app`.
- Bundle id: `com.openai.codex`.
- Desktop version: `26.429.20946`, build `2312`.
- Electron version surfaced by crashpad annotation: `41.2.0`.
- Main process currently launched with `--remote-debugging-port=9222`.
- Child process types include GPU, network utility, renderer, crashpad, and
  `Contents/Resources/codex app-server --analytics-default-enabled`.
- Codex++ runtime processes are Node launchers/servers under
  `/Users/af/Library/Application Support/codex-plusplus/runtime/`.
- `lsof` shows `app.asar`, Chromium HTTP storage SQLite/WAL files, pipes,
  kqueues, and the remote-debug TCP listener.
- The patched stable app is ad-hoc signed on this machine and still has a
  stapled notarization ticket recorded by `codesign -dv`; the current
  entitlements extraction is empty.
- `Info.plist` contains `ElectronAsarIntegrity` for `Resources/app.asar` and an
  `LSEnvironment` entry setting `MallocNanoZone=0`.
- Codex++ launch agents are installed as:
  `~/Library/LaunchAgents/com.codexplusplus.watcher.plist` and
  `~/Library/LaunchAgents/com.codexplusplus.watcher.beta.plist`. They use
  `WatchPaths` on the app bundle/resources/asar and an hourly run interval.

## Technique Matrix

| Technique | Best use | Command shape | Permissions/root needs | Signal-to-noise | Hazards | Codex++ integration idea |
| --- | --- | --- | --- | --- | --- | --- |
| `ps` process tree | Map Electron process roles and app-server children. | `ps -axo pid,ppid,user,stat,comm,args | grep Codex` | User-level. | High for topology, low for internals. | Args can include paths, ports, and env-adjacent details. Output can be huge. | Add a "process topology" health card with pid, role, parent, uptime, and redacted args. |
| `pgrep`/`pkill -0` | Check whether stable/beta/app-server/helper processes exist. | `pgrep -afil 'Codex|codex'` | User-level. | Medium. | Loose matching catches Codex CLI, this agent, and tooling. | Use exact bundle/executable path matching from `ps`, not broad names. |
| `lsof` | Open files, sockets, SQLite/WAL handles, ASAR, remote-debug port. | `lsof -nP -p "$PID"` or `lsof -nP -c Codex` | User-level for same-user processes; root improves completeness. | High when scoped to pid. | Can block on filesystem metadata unless `-b`; reveals private paths and network endpoints. | Build a redacted "open resources" snapshot: app asar, user-data DBs, log files, TCP listeners, Unix sockets. |
| `proc_pidinfo` / `libproc` | Stable structured process metadata from native code. | C/Swift/Rust binding to `proc_pidinfo(2)` and `proc_pidpath(3)` | User-level for many same-user fields; restricted for protected processes. | High if implemented narrowly. | Requires native helper; process info APIs vary by struct/flavor. | Optional native helper returning typed JSON for pids, paths, start time, file descriptors, and socket summaries. |
| `fs_usage` | Real-time filesystem/syscall activity around app startup or a repro. | `sudo fs_usage -w -f filesys -t 15 Codex` | Root required per local man page. Full Disk Access can improve visibility. | Medium-high when filtered by process and time. | Global kernel trace; noisy; can expose file names and content-adjacent paths; runtime overhead. | Support-bundle "guided capture" script with 10-30s timeout, process filter, and path redaction. |
| `log stream` / `log show` | Unified logging, crash/signpost/security messages, launchd/service events. | `log stream --style compact --level info --process Codex --timeout 30s` | Some commands require root; many same-user/default logs work without root. Debug/info persistence may require `log config` root. | Medium. Good for platform failures, poor for app internals unless subsystems log. | Logs redact private strings by default; debug logs can be voluminous; `log config` changes system state. | Read-only live log pane for known processes/subsystems; never auto-run `log config`. |
| `dtrace` / `dtruss` | Syscall timing, child-following, target launch tracing. | `sudo dtruss -f -p "$PID"` or `sudo dtrace -n 'syscall:::entry /pid == $target/ { ... }' -p "$PID"` | Root required for `dtruss`; SIP and hardened runtime can still restrict probes. | High for syscall questions, very noisy otherwise. | Can slow, perturb, or fail against protected/hardened processes; output may include paths and data sizes; root trace surface is sensitive. | Lab-only "trace recipe" docs; not an automatic Codex++ feature until there is a precise failing hypothesis. |
| `sample` | Low-risk CPU stack sample for hangs/spins. | `sample "$PID" 10 1 -file /tmp/codex.sample.txt` | Usually same-user; Developer Tools permissions may be prompted/needed. | High for CPU/hang root cause, limited by symbols. | It samples by briefly suspending threads; output can include paths/symbol names; not semantic app events. | Add "capture stack sample" button gated behind confirmation when Codex.app is hung. |
| `spindump` | System-wide hang report, contention, thread states. | `sudo spindump "$PID" 10 -file /tmp/codex.spindump.txt` | Usually root for useful capture. | Medium-high for severe hangs. | Heavier than `sample`; large reports; privacy-sensitive; may require sysdiagnose-style permissions. | Manual escalation command in bug-report bundle UI, not background capture. |
| `lldb attach` | Inspect native frames, breakpoints, Objective-C/Electron/native module state. | `lldb -p "$PID"` or `lldb -n Codex --wait-for` | Developer Tools approval; may require root or `get-task-allow`/debug allowances; hardened runtime can block. | Very high in lab, very low for routine support. | Stops the process; can crash or alter timing; may violate code-signing/debug policy; easy to leak memory contents. | Keep outside product. Store a runbook for local lab debugging only. |
| DYLD print env / library injection | Understand dynamic library load paths or test native instrumentation. | `DYLD_PRINT_LIBRARIES=1 "/Applications/Codex.app/Contents/MacOS/Codex"`; `DYLD_INSERT_LIBRARIES=...` | DYLD env vars may be ignored for SIP-protected binaries; hardened runtime needs explicit exceptions for DYLD/injection. | Medium for loader diagnostics, high risk for injection. | Library injection is code execution inside Codex.app; hardened runtime/library validation can block; re-signing can break trust/update flows. | Use DYLD print variables only for lab relaunches. Do not use injection as a Codex++ extension mechanism. |
| `codesign` / `spctl` / notarization checks | Verify signature mode, entitlements, hardened runtime flags, Gatekeeper assessment. | `codesign -dv --verbose=4 APP`; `codesign --verify --deep --strict --verbose=4 APP`; `spctl -a -vvv -t execute APP` | User-level for display/verify/assess; signing writes need identity/admin depending on target path. | High. | `codesign --force` mutates bundle signatures; `--deep` signing is deprecated for signing and can hide nested-code mistakes. | Build a signature health card: cdhash, signature type, hardened runtime flag, entitlements presence, asar integrity plist hash. |
| Electron ASAR fuses/integrity | Understand why patched `app.asar` launches or terminates. | `npx @electron/fuses read --app APP` if available; `plutil -p APP/Contents/Info.plist` | User-level reads; fuse writes mutate Electron binary and require re-signing. | High for patch viability. | Fuse flips mutate executable bytes; ASAR integrity mismatch terminates app when enabled. | Codex++ status should show fuse state, `ElectronAsarIntegrity`, current asar hash, and whether repair will rewrite plist/signature. |
| Launch Services metadata | URL schemes, environment, category, minimum OS, Apple Events usage text. | `plutil -p APP/Contents/Info.plist`; `mdls APP`; `lsregister -dump` | User-level. | Medium-high for launch environment. | `lsregister -dump` is huge/noisy. `LSEnvironment` only affects Launch Services launches, not direct binary relaunch. | Add static bundle metadata panel and warn when direct binary launches differ from Launch Services launches. |
| XPC and launchd | App helpers, services, launch agents, watcher health. | `launchctl print gui/$(id -u)/LABEL`; `find APP/Contents -name '*.xpc'`; `log stream --predicate 'process == "launchd"'` | User-level for user agents; root for system domains. | High for Codex++ watcher and bundled helpers. | `launchctl print` can reveal command paths and env. Misusing bootstrap/bootout mutates service state. | Existing watcher health can be expanded with launchd run count, last exit, trigger paths, and stdout/stderr log path. |
| SQLite read-only observation | Inspect schema, WAL existence, row counts, cache/storage drift. | `sqlite3 "file:PATH?mode=ro&immutable=1" '.schema'`; `sqlite3 "file:PATH?mode=ro" 'PRAGMA database_list;'` | User-level if readable; Full Disk Access may be needed for some protected locations. | Medium-high for storage shape, low for live state unless WAL handled. | Reading live DBs can lock or miss WAL state if opened incorrectly; raw rows can expose secrets, prompts, cookies, or tokens. | Capture only schema, table names, row counts, page counts, WAL/shm size, and mtime. Never copy raw rows by default. |

## Command Recipes

### Process And Topology

Use this first; it is cheap and usually enough to separate main, renderer,
app-server, helper, crashpad, and Codex++ runtime processes.

```sh
ps -axo pid,ppid,user,stat,lstart,etime,comm,args \
  | grep -E '(/Applications/Codex( \\(Beta\\))?\\.app|codex-plusplus|self-mcp|Codex Helper)' \
  | grep -v grep
```

Safer machine-readable variant:

```sh
pgrep -f '/Applications/Codex.app/Contents/MacOS/Codex' \
  | while read -r pid; do
      ps -p "$pid" -o pid=,ppid=,stat=,etime=,comm=,args=
    done
```

Permissions/root: none for same-user Codex. Root may reveal more for processes
owned by other users, but Codex++ should not need it.

Signal-to-noise: high if exact executable paths are used. Broad `Codex` matching
also catches CLI commands, current agents, temp `asar` extraction processes, and
watcher commands.

Codex++ idea:

- Keep a typed process-role detector:
  - main: `Contents/MacOS/Codex`
  - renderer: `--type=renderer`
  - GPU: `--type=gpu-process`
  - network: `--utility-sub-type=network.mojom.NetworkService`
  - app-server: `Contents/Resources/codex app-server`
  - Codex++ self-MCP: `self-mcp-launcher.js` / `self-mcp-server.js`
- Show only role, pid, ppid, uptime, status, and redacted args.

### Open Files, Ports, And SQLite Handles

```sh
PID="$(pgrep -f '/Applications/Codex.app/Contents/MacOS/Codex' | head -1)"
lsof -nP -p "$PID"
lsof -nP -a -p "$PID" -iTCP
lsof -nP -a -p "$PID" | grep -E 'app\\.asar|sqlite|\\.wal|\\.shm|Library/Application Support|HTTPStorages'
```

Permissions/root: same-user is enough for useful Codex data. `sudo` can fill in
missing kernel/network details but should not be default.

Signal-to-noise: high when scoped to one pid. `lsof -c Codex` is useful but
includes many helpers and can be long.

Hazards:

- Reveals absolute paths, socket endpoints, and browser storage names.
- Can block on filesystem metadata; use `-b` in scripts when blocking matters.
- Do not print all open files in bug reports without redaction.

Codex++ idea:

- Add an "open resources" probe with allowlisted categories:
  `app.asar`, Codex user-data DBs, Codex++ logs, local TCP listeners, Unix
  sockets, native modules, and crashpad database path.
- Store counts and path basenames by default; reveal full paths only locally.

### Unified Logging

```sh
log stream --style compact --level info --process Codex --timeout 30s
log show --last 10m --style compact --predicate 'process == "Codex"'
log stream --style compact --predicate 'subsystem CONTAINS "com.openai" OR process CONTAINS "Codex"' --timeout 30s
```

Permissions/root: local `man log` says some commands require root. Basic stream
and show for visible process logs usually work as the user; `log config` and
system-wide changes require root.

Signal-to-noise: medium. Good for launchd, crash, security, and framework
messages. Poor for semantic app-server events unless Codex or Codex++ logs them
to unified logging.

Hazards:

- `--level debug` and `log config --mode` can increase volume and mutate system
  logging policy.
- Logs may still include private paths and error details.
- Avoid broad predicates in long captures.

Codex++ idea:

- First-class read-only log page should prefer Codex++ file logs and use
  unified logging as a bounded "platform supplement".
- Add copyable commands for user-run captures with `--timeout` and
  `--predicate`; do not silently enable debug persistence.

### Filesystem Activity

```sh
sudo fs_usage -w -f filesys -t 15 Codex
sudo fs_usage -w -f pathname -t 15 Codex
sudo fs_usage -w -f exec -t 15 Codex
```

Permissions/root: `fs_usage` requires root because it uses kernel tracing.
Full Disk Access may improve visibility on privacy-protected paths.

Signal-to-noise: medium-high for "what files did launch/reload touch?" if the
capture is short and filtered by command. Very noisy globally.

Hazards:

- Kernel trace surface; do not run globally for minutes.
- Pathnames can reveal project names, home paths, database names, and temp file
  layout.
- It can perturb timing and generate large output.

Codex++ idea:

- Provide a `codex-plusplus doctor --fs-capture 15s` command that prints the
  exact `sudo fs_usage` command and captures to a local redacted artifact only
  after explicit confirmation.

### DTrace And dtruss

```sh
sudo dtruss -f -p "$PID"
sudo dtruss -f -t open -p "$PID"
sudo dtrace -n 'syscall:::entry /pid == $target/ { @[probefunc] = count(); }' -p "$PID"
```

Permissions/root: `dtruss` requires root. `dtrace` generally needs root for
useful live tracing. SIP and hardened runtime protections can restrict what is
observable even as root.

Signal-to-noise: high for a precise syscall question, low for broad discovery.

Hazards:

- Tracing can slow or destabilize target processes.
- Output can expose paths and sizes, and stack traces can include code layout.
- On modern macOS, some probes are unavailable or restricted; failure can be a
  platform boundary rather than a Codex issue.

Codex++ idea:

- Keep a "DTrace recipes" appendix for developers. Do not ship automatic DTrace
  integration unless a future feature has a narrow, supportable use case.

### Sampling And Hangs

```sh
PID="$(pgrep -f '/Applications/Codex.app/Contents/MacOS/Codex' | head -1)"
sample "$PID" 10 1 -file "/tmp/codex-main.$PID.sample.txt"
sample Codex 10 1 -wait -mayDie -file "/tmp/codex-launch.sample.txt"
sudo spindump "$PID" 10 -file "/tmp/codex-main.$PID.spindump.txt"
```

Permissions/root: `sample` is often usable for same-user processes, subject to
Developer Tools/TCC approval. `spindump` is usually an admin/root escalation for
useful reports.

Signal-to-noise: high for CPU loops, renderer hangs, native deadlocks, and
"Codex is beachballing" incidents. Less useful for protocol bugs.

Hazards:

- `sample` suspends threads at intervals.
- `spindump` is heavier and produces large, privacy-sensitive reports.
- Symbolication may be poor for stripped Electron/native code.

Codex++ idea:

- Add a hung-state escalation button that generates a copyable `sample` command
  for the selected pid and links to the output file path. Make `spindump` a
  manual advanced command.

### LLDB Attach

```sh
lldb -p "$PID"
lldb -n Codex --wait-for
lldb --batch -p "$PID" -o 'thread backtrace all' -o detach -o quit
```

Permissions/root: may require Developer Tools authorization, root, and/or a
target that permits task-port access. Hardened runtime and entitlements can
block attaching. For distribution builds, absence of `get-task-allow` is the
normal secure state.

Signal-to-noise: high in local lab debugging when asking a native question; not
appropriate for normal user diagnostics.

Hazards:

- Attaching pauses the target and can crash or change timing.
- Memory/register inspection can expose secrets.
- Breakpoints and expression evaluation mutate behavior.

Codex++ idea:

- Do not integrate LLDB into the product. Document exact lab commands for
  maintainers and keep generated reports outside user-facing support bundles
  unless the user explicitly provides them.

### DYLD, Library Injection, And Hardened Runtime

Loader diagnostics:

```sh
DYLD_PRINT_LIBRARIES=1 DYLD_PRINT_TO_FILE=/tmp/codex.dyld.log \
  "/Applications/Codex.app/Contents/MacOS/Codex"

DYLD_PRINT_SEARCHING=1 DYLD_PRINT_TO_FILE=/tmp/codex.dyld-search.log \
  "/Applications/Codex.app/Contents/MacOS/Codex"
```

Injection lab shape:

```sh
DYLD_INSERT_LIBRARIES=/path/to/libProbe.dylib \
  "/Applications/Codex.app/Contents/MacOS/Codex"
```

Permissions/root: root is not the primary issue. SIP ignores DYLD environment
variables for SIP-protected binaries. Hardened runtime also constrains DYLD
variables, code injection, and library validation unless the target has
specific runtime exceptions.

Signal-to-noise:

- `DYLD_PRINT_*` is useful for launch-time loader questions.
- `DYLD_INSERT_LIBRARIES` is not a safe observability primitive for Codex++.

Hazards:

- Injection is arbitrary code execution inside Codex.app.
- Library validation requires loaded code to be Apple-signed or signed with the
  same Team ID unless disabled.
- Allowing DYLD environment variables and disabling library validation are broad
  security exceptions. Apple warns to use the narrowest runtime exceptions.
- Re-signing Codex.app with these exceptions can change Gatekeeper, update, and
  trust behavior.

Codex++ idea:

- Continue using the existing JS/preload/app-server seams, app bundle repair
  flow, and local runtime logs.
- Do not introduce a dylib-injection extension path.
- Use `DYLD_PRINT_*` only as an advanced relaunch diagnostic.

### Code Signing, Notarization, And Electron Fuses

Read-only checks:

```sh
APP="/Applications/Codex.app"
codesign -dv --verbose=4 "$APP" 2>&1
codesign -d --entitlements :- "$APP" 2>/dev/null
codesign --verify --deep --strict --verbose=4 "$APP"
spctl -a -vvv -t execute "$APP"
plutil -p "$APP/Contents/Info.plist" | grep -A6 ElectronAsarIntegrity
```

Mutation commands that should stay in installer/repair paths:

```sh
codesign --force --deep --sign - "/Applications/Codex.app"
```

Permissions/root: read-only checks are user-level. Mutating `/Applications`
bundles may need admin ownership/write privileges.

Signal-to-noise: high. This explains launch failures after patching, update
repairs, and ASAR integrity mismatch.

Hazards:

- `codesign --force` mutates trust state.
- `--deep` signing is deprecated for signing as of macOS 13 and can apply
  options recursively in surprising ways; it remains useful for verification.
- Notarization is a distribution trust check, not App Review. Current Apple
  tooling uses `notarytool`, not deprecated `altool`.
- Electron ASAR integrity validates `app.asar` header hash from
  `ElectronAsarIntegrity`; when the corresponding fuse is enabled, a mismatch
  forcefully terminates the app.
- Fuse writes mutate Electron binary bytes and require re-signing.

Codex++ idea:

- Extend `codex-plusplus status` with:
  - signature type and cdhash
  - hardened runtime flag presence
  - entitlement keys
  - `ElectronAsarIntegrity` hash for `Resources/app.asar`
  - current ASAR header hash
  - Electron fuse readout if `@electron/fuses` is available
  - Gatekeeper assessment result from `spctl`

### XPC, Launchd, And Launch Services

Codex bundle/service map:

```sh
find "/Applications/Codex.app/Contents" -maxdepth 3 \
  \( -name '*.xpc' -o -name '*.app' -o -name '*.framework' \) -print

plutil -p "/Applications/Codex.app/Contents/Info.plist"
mdls "/Applications/Codex.app"
```

Codex++ watcher state:

```sh
launchctl print "gui/$(id -u)/com.codexplusplus.watcher"
launchctl print "gui/$(id -u)/com.codexplusplus.watcher.beta"
tail -200 "$HOME/Library/Logs/codex-plusplus-watcher.log"
```

Permissions/root: user launch agents are readable by the user. System launch
daemons require root/system domain access. `bootout`, `bootstrap`, and `kickstart`
mutate service state and should stay inside installer/repair commands.

Signal-to-noise: high for watcher failures and app helper inventory; medium for
Launch Services because databases are large.

Hazards:

- Launchctl output includes command paths, inherited environment names, and
  trigger paths.
- Relaunching or booting out services can race app updates and repairs.
- XPC message contents are not visible from `launchctl`; use it for topology,
  not payload introspection.

Codex++ idea:

- Upgrade watcher health to include launchd `state`, `runs`, `last exit code`,
  `run interval`, trigger path readiness, stdout/stderr path, and whether the
  command points at the expected CLI/runtime.
- Add a static app bundle map for helpers/frameworks/native modules.

### SQLite And WAL Observation

Discovery:

```sh
find "$HOME/Library/Application Support/Codex" \
     "$HOME/Library/HTTPStorages/com.openai.codex" \
     "$HOME/Library/Application Support/codex-plusplus" \
  -maxdepth 3 -type f \
  \( -name '*.db' -o -name '*.sqlite' -o -name '*-wal' -o -name '*-shm' \)
```

Read-only schema and counts:

```sh
DB="$HOME/Library/Application Support/Codex/codex.db"
sqlite3 "file:$DB?mode=ro" '.tables'
sqlite3 "file:$DB?mode=ro" '.schema'
sqlite3 "file:$DB?mode=ro" 'PRAGMA database_list; PRAGMA journal_mode; PRAGMA wal_checkpoint(PASSIVE);'
```

Immutable snapshot read when no live WAL state is needed:

```sh
sqlite3 "file:$DB?mode=ro&immutable=1" '.schema'
```

Permissions/root: user-level when files are readable. Full Disk Access may be
needed in some user-data or browser-storage locations.

Signal-to-noise: high for schema/table/storage shape; risky for raw data.

Hazards:

- Live WAL databases have `db`, `db-wal`, and `db-shm`; reading only the main DB
  can miss recent committed data.
- `immutable=1` tells SQLite the file will not change and can ignore locking;
  do not use it when you need live WAL changes.
- Raw rows may include prompts, messages, tokens, cookies, or account data.
- `PRAGMA wal_checkpoint` is not a pure read; avoid it against app-owned DBs
  unless you own the operational consequence. Prefer file size/mtime/schema.

Codex++ idea:

- Add `storage.inventory` as metadata-only:
  path category, size, mtime, SQLite page count, journal mode, table names,
  table row counts if safe, WAL/shm presence and size.
- Default redaction: no row values, no cookie values, no prompt content.
- For bug bundles, copy DB schema and stats, not databases.

## Safe Observation Pipeline For Codex++

1. Identify app roots and channels:
   `/Applications/Codex.app`, `/Applications/Codex (Beta).app`, bundle ids,
   versions, `Info.plist`, ASAR hash, signature state.
2. Build process topology:
   main, renderer, GPU, utility, crashpad, app-server, Codex++ runtime/MCP.
3. Collect Codex++ first-party logs:
   `main.log`, `preload.log`, `loader.log`, watcher log, app-server-flow JSONL.
4. Add platform supplement:
   short `log show --last 10m` predicate for Codex processes; no debug config.
5. Add open-resource metadata:
   `lsof` scoped to Codex pids, categorized and redacted.
6. Add storage metadata:
   SQLite schemas/table names/row counts when safe, WAL/shm sizes, no raw rows.
7. Offer advanced manual captures:
   `sample` for hangs, `fs_usage` for file-touch mysteries, `dtruss` only for
   precise syscall hypotheses.

## Product Ideas

### Native Health Snapshot

- Impact: high
- Effort: medium
- Confidence: high
- Dependency: Codex++ runtime seam

Expose a single local snapshot that combines bundle metadata, signature state,
process topology, watcher health, runtime log status, open resource categories,
and storage inventory. This should be the default "what is running and what did
Codex++ touch?" answer.

Acceptance checks:

- Runs without root.
- Completes in under 2 seconds in the common case.
- Redacts home paths to `~` and omits row values/env values.
- Produces JSON for support bundles and a compact UI card for Settings.

### Guided Escalation Captures

- Impact: medium
- Effort: small
- Confidence: high
- Dependency: external process tools

Add copyable, scoped commands for advanced captures instead of running them
automatically:

- Hang: `sample "$PID" 10 1 -file ...`
- Filesystem mystery: `sudo fs_usage -w -f filesys -t 15 Codex`
- Syscall hypothesis: `sudo dtruss -f -t open -p "$PID"`
- Platform logs: `log stream --style compact --process Codex --timeout 30s`

Acceptance checks:

- Each command names what it captures, permissions needed, and privacy risk.
- Commands include timeouts and output file paths.
- The UI refuses to call `sudo` itself.

### Signature And ASAR Integrity Doctor

- Impact: high
- Effort: small
- Confidence: high
- Dependency: native Codex seam

Build a `doctor.signature` probe that compares the app's current code-signing,
notarization/Gatekeeper assessment, ASAR integrity plist, and current ASAR hash
against Codex++ install state.

Acceptance checks:

- Read-only by default.
- Points to `codex-plusplus repair --app ...` only when drift is confirmed.
- Explains whether failure is signature, ASAR integrity, missing loader,
  watcher, or app update drift.

### Metadata-Only SQLite Inventory

- Impact: medium
- Effort: small
- Confidence: medium
- Dependency: Codex++ runtime seam

Inventory Codex and Codex++ SQLite stores without extracting content. This helps
debug "state is stale", "HTTP storage is large", and "WAL keeps growing" without
leaking conversation or cookie data.

Acceptance checks:

- Uses `mode=ro`.
- No raw rows.
- Reports DB/WAL/shm sizes, table names, row counts when allowed, page counts,
  and mtimes.

## Source Notes

- Local manuals checked on this machine:
  `fs_usage(1)`, `log(1)`, `sample(1)`, `dtrace(1)`, `dtruss(1m)`,
  `lldb(1)`, `dyld(1)`, `codesign(1)`, `spctl(8)`, `lsof(8)`, `sqlite3(1)`.
- Apple docs:
  - Hardened Runtime:
    https://developer.apple.com/documentation/security/hardened_runtime
  - Configuring hardened runtime:
    https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime
  - Disable Library Validation entitlement:
    https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.cs.disable-library-validation
  - Notarizing macOS software:
    https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
  - Resolving common notarization issues:
    https://developer.apple.com/documentation/security/resolving-common-notarization-issues
  - XPC services:
    https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingXPCServices.html
  - Launch daemons and agents:
    https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
  - Service Management:
    https://developer.apple.com/documentation/servicemanagement
  - Launch Services keys:
    https://developer-mdn.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/LaunchServicesKeys.html
- Electron docs:
  - ASAR integrity:
    https://www.electronjs.org/docs/latest/tutorial/asar-integrity
  - Fuses:
    https://www.electronjs.org/docs/latest/tutorial/fuses
