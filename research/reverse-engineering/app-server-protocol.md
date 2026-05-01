# App-Server Protocol Reverse Engineering

Owner scope: research note only. This pass read local upstream sources under
`/Users/af/openai-codex/codex/codex-rs` and current Codex++ sources under
`/Users/af/codex-plusplus`. No product code was changed.

## Commands Run

```bash
git -C /Users/af/codex-plusplus status --short --branch
git -C /Users/af/openai-codex/codex status --short --branch
fd -a '^AGENTS\.md$' /Users/af/codex-plusplus /Users/af/openai-codex/codex
rg --files /Users/af/openai-codex/codex/codex-rs/app-server /Users/af/openai-codex/codex/codex-rs/app-server-protocol /Users/af/openai-codex/codex/codex-rs/app-server-client /Users/af/openai-codex/codex/codex-rs/app-server-test-client
rg --files /Users/af/codex-plusplus/packages/runtime/src /Users/af/codex-plusplus/packages/installer/src /Users/af/codex-plusplus/packages/sdk/src /Users/af/codex-plusplus/docs /Users/af/codex-plusplus/research
rg -n "app-server|app_server|codex-app-server|app-server-protocol|jsonrpc|JSON-RPC|stdio|Stdout|stdin|Notification|thread/|turn|interrupt|cancel|shutdown|state_5|session_index|sqlite" /Users/af/openai-codex/codex/codex-rs/app-server /Users/af/openai-codex/codex/codex-rs/app-server-protocol /Users/af/openai-codex/codex/codex-rs/core /Users/af/openai-codex/codex/codex-rs/protocol -g '*.rs' -g '*.md' -g '*.toml'
rg -n "state_5|session_index|sqlite|log_db|LogDb|codex_home|sessions|rollout|jsonl|ThreadManager|CodexThread|submit\(|Op::UserTurn|interrupt|TurnStart|TurnInterrupt|pending_interrupt|running_assistant_turn" /Users/af/openai-codex/codex/codex-rs/core/src /Users/af/openai-codex/codex/codex-rs/state/src /Users/af/openai-codex/codex/codex-rs/protocol/src /Users/af/openai-codex/codex/codex-rs/app-server/src -g '*.rs'
rg -n "state_5|session_index|sqlite|\.codex|sessions|rollout|app-server|thread/list|thread/read" /Users/af/codex-plusplus/packages/runtime/src /Users/af/codex-plusplus/docs /Users/af/codex-plusplus/research/agents -g '*.ts' -g '*.md'
sed -n '...' /Users/af/openai-codex/codex/codex-rs/app-server*/**/*.rs
sed -n '...' /Users/af/openai-codex/codex/codex-rs/core/src/{codex.rs,codex_thread.rs,thread_manager.rs}
sed -n '...' /Users/af/openai-codex/codex/codex-rs/state/src/{lib.rs,runtime.rs,log_db.rs,runtime/threads.rs}
sed -n '...' /Users/af/codex-plusplus/packages/runtime/src/{main.ts,app-server-flow-tap.ts,preload/app-server-bridge.ts}
```

Current worktree note: `/Users/af/codex-plusplus` was already dirty before this
research file was written (`packages/runtime/src/main.ts`,
`packages/runtime/src/preload/settings-injector.ts`, and
`packages/runtime/src/app-server-flow-tap.ts`). The upstream checkout was also
conflicted in `codex-rs/core/src/model_provider_info.rs` and
`codex-rs/tui/src/app.rs`. Treat all reverse-engineering findings as source
reads from that local state, not as a clean upstream release tag.

## Executive Map

The app-server is a bidirectional, JSON-RPC-like control plane used by rich
Codex surfaces. The upstream protocol deliberately omits the `jsonrpc: "2.0"`
wire field even though the README calls it JSON-RPC 2.0 style. Default Desktop
transport is `stdio://`: newline-delimited JSON on stdin/stdout, with tracing
logs on stderr. An experimental websocket transport exists, and newer CLI/TUI
surfaces can embed the same processor through an in-process channel facade.

Primary seams for Codex++:

- Existing Codex++ main-process spawn tap already wraps `child_process.spawn`
  and `execFile`, detects `codex app-server`, and captures stdin/stdout/stderr
  JSONL into `log/app-server-flow.jsonl`.
- Existing preload bridge can send app-server requests through Codex Desktop's
  renderer IPC bridge and subscribe to notifications.
- Upstream state is split across JSONL rollouts, `session_index.jsonl`,
  SQLite metadata `state_5.sqlite`, and SQLite tracing logs `logs_1.sqlite`.
- Stop/interrupt behavior is asynchronous: `turn/interrupt` queues a pending
  response and only answers when the later `TurnAborted` event is observed by
  the app-server listener. Missing terminal events can strand callers.

## Protocol Shape

Upstream declares a "lite" JSON-RPC envelope in
`/Users/af/openai-codex/codex/codex-rs/app-server-protocol/src/jsonrpc_lite.rs:1`.
It defines these untagged message shapes:

- `JSONRPCRequest`: `{ id, method, params?, trace? }`
  at `jsonrpc_lite.rs:33`.
- `JSONRPCNotification`: `{ method, params? }`
  at `jsonrpc_lite.rs:50`.
- `JSONRPCResponse`: `{ id, result }`
  at `jsonrpc_lite.rs:58`.
- `JSONRPCError`: `{ id, error: { code, message, data? } }`
  at `jsonrpc_lite.rs:65`.

The README confirms the transport-level contract:
`/Users/af/openai-codex/codex/codex-rs/app-server/README.md:20` describes the
JSON-RPC-like protocol, `README.md:24` lists supported transports, and
`README.md:36` documents `RUST_LOG` plus `LOG_FORMAT=json` stderr tracing.
Backpressure is explicit: bounded queues reject saturated request ingress with
code `-32001` and message `"Server overloaded; retry later."`
(`README.md:41`).

Request IDs accept either strings or integers:
`jsonrpc_lite.rs:13`. This matters for Codex++ because its preload bridge
normalizes incoming response IDs to strings in
`/Users/af/codex-plusplus/packages/runtime/src/preload/app-server-bridge.ts:159`.

The method catalog is generated from
`/Users/af/openai-codex/codex/codex-rs/app-server-protocol/src/protocol/common.rs`.
The active v2 request definitions start at `common.rs:204`. Key method anchors:

- Thread lifecycle: `thread/start`, `thread/resume`, `thread/fork`,
  `thread/archive`, `thread/unsubscribe`, `thread/name/set`,
  `thread/metadata/update`, `thread/unarchive`, `thread/compact/start`,
  `thread/rollback`, `thread/list`, `thread/loaded/list`, `thread/read`
  at `common.rs:213` through `common.rs:288`.
- Turn lifecycle: `turn/start`, `turn/steer`, `turn/interrupt` at
  `common.rs:322` through `common.rs:333`.
- Realtime/review/model/config/account/MCP/plugin/app surfaces continue below
  `common.rs:335`.

Protocol payloads live in
`/Users/af/openai-codex/codex/codex-rs/app-server-protocol/src/protocol/v2.rs`.
Thread and turn type anchors:

- `ThreadStartParams`: `v2.rs:2217`.
- `ThreadResumeParams`: `v2.rs:2313`.
- `ThreadStatus`: `v2.rs:2746`.
- `Thread`: `v2.rs:3187`.
- `Turn`: `v2.rs:3280`.
- `TurnStatus`: `v2.rs:3468`.
- `TurnStartParams`: `v2.rs:3481`.
- `TurnInterruptParams`: `v2.rs:3610`.
- Notifications: `ThreadStartedNotification` at `v2.rs:4192`,
  `ThreadStatusChangedNotification` at `v2.rs:4199`,
  `TurnStartedNotification` at `v2.rs:4247`,
  `TurnCompletedNotification` at `v2.rs:4273`,
  `ItemStartedNotification` at `v2.rs:4347`, and
  `AgentMessageDeltaNotification` at `v2.rs:4375`.

## Transport And Routing

The binary entrypoint is
`/Users/af/openai-codex/codex/codex-rs/app-server/src/main.rs`. CLI args expose
`--listen`, defaulting to `AppServerTransport::DEFAULT_LISTEN_URL`
(`main.rs:14` through `main.rs:24`), then call `run_main_with_transport`
(`main.rs:36`).

`AppServerTransport` is defined in
`/Users/af/openai-codex/codex/codex-rs/app-server/src/transport.rs:106`.
`stdio://` is the default at `transport.rs:135`; websocket URLs are parsed as
`ws://IP:PORT` at `transport.rs:143`.

Stdio transport:

- Connection ID is always `ConnectionId(0)`.
- `start_stdio_connection` opens a bounded writer queue, sends
  `TransportEvent::ConnectionOpened`, then spawns a stdin reader and stdout
  writer (`transport.rs:238` through `transport.rs:303`).
- The stdin reader uses `BufReader::lines()` and parses one JSON object per
  newline (`transport.rs:256` through `transport.rs:268`).
- The stdout writer serializes `OutgoingMessage`, appends `\n`, and writes to
  stdout (`transport.rs:288` through `transport.rs:300`).

Websocket transport:

- `start_websocket_acceptor` binds with Axum and exposes `/readyz` and
  `/healthz` (`transport.rs:306` through `transport.rs:337`).
- `run_websocket_connection` registers a writer and split websocket streams
  (`transport.rs:339` onward).
- Websocket is marked experimental/unsupported in the README at
  `app-server/README.md:26` and `app-server/README.md:34`.

Backpressure path:

- `CHANNEL_CAPACITY` is 128 (`transport.rs:49`).
- `enqueue_incoming_message` tries to enqueue transport events first
  (`transport.rs:496`).
- If ingress is full and the dropped message is a request, it sends the
  overload JSON-RPC error directly to that connection (`transport.rs:509`
  through `transport.rs:521`).
- Non-request events may await queue space (`transport.rs:533`), so a debugger
  should distinguish retryable overload responses from true transport death.

Routing:

- `run_main_with_transport` constructs a transport event queue, outbound queue,
  and outbound-control queue at
  `/Users/af/openai-codex/codex/codex-rs/app-server/src/lib.rs:340`.
- The outbound task tracks per-connection `OutboundConnectionState` and routes
  envelopes at `lib.rs:532` through `lib.rs:585`.
- The processor task creates `MessageProcessor`, subscribes to thread creation
  and running-turn count, and tracks connection state at `lib.rs:587` through
  `lib.rs:615`.
- Signal handling is graceful for websocket/multi-client mode: first signal
  waits for running assistant turns; second signal forces disconnect
  (`lib.rs:157` through `lib.rs:196`).

There is also an in-process transport replacement:
`/Users/af/openai-codex/codex/codex-rs/app-server/src/in_process.rs:1`.
It preserves app-server semantics with typed channels, uses the same
`MessageProcessor`, and documents that event fanout can drop notifications
under saturation while server requests are failed back instead of abandoned
(`in_process.rs:26` through `in_process.rs:32`). The public facade for TUI/exec
is `/Users/af/openai-codex/codex/codex-rs/app-server-client/src/lib.rs:1`.
That facade specifically treats `TurnCompleted` and legacy terminal events as
delivery-required to avoid hangs (`app-server-client/src/lib.rs:60` through
`app-server-client/src/lib.rs:76`).

## Handshake And Request Processing

`MessageProcessor` handles untyped JSON-RPC requests in
`/Users/af/openai-codex/codex/codex-rs/app-server/src/message_processor.rs`.
Raw JSON requests are converted into typed `ClientRequest` values at
`message_processor.rs:236` through `message_processor.rs:287`.

Important connection lifecycle behavior:

- Client notifications are currently logged, not semantically processed:
  `message_processor.rs:332`.
- `initialize` is special-cased before the normal initialized gate; all other
  requests before initialization get `"Not initialized"` at
  `message_processor.rs:509` through `message_processor.rs:517`.
- Experimental request variants are rejected unless the session negotiated
  experimental API access (`message_processor.rs:521` through
  `message_processor.rs:529`).
- Most app-server methods delegate to `CodexMessageProcessor` after config and
  external-agent special handling (`message_processor.rs:594` through
  `message_processor.rs:601`).

`CodexMessageProcessor` dispatches typed v2 requests in
`/Users/af/openai-codex/codex/codex-rs/app-server/src/codex_message_processor.rs`.
The dispatch table for thread and turn methods starts at
`codex_message_processor.rs:629`, with `turn/interrupt` routed at
`codex_message_processor.rs:745`.

## Thread Lifecycle

Thread start:

- `thread_start` unpacks `ThreadStartParams`, builds config overrides, and
  spawns `thread_start_task` (`codex_message_processor.rs:1809` through
  `codex_message_processor.rs:1865`).
- `thread_start_task` derives config, validates dynamic tools, and calls
  `ThreadManager::start_thread_with_tools_and_service_name`
  (`codex_message_processor.rs:1868` through `codex_message_processor.rs:1938`).
- On success it builds an API `Thread`, auto-attaches a listener, sends
  `ThreadStartResponse`, then broadcasts `thread/started`
  (`codex_message_processor.rs:1940` through `codex_message_processor.rs:2002`).

Thread resume:

- `thread_resume` first checks whether the thread is currently closing, then
  tries `resume_running_thread` for already-loaded threads
  (`codex_message_processor.rs:3185` through `codex_message_processor.rs:3208`).
- If not loaded, it resumes from explicit history or rollout path
  (`codex_message_processor.rs:3210` through `codex_message_processor.rs:3243`).
- It derives config based on resume history cwd, calls
  `ThreadManager::resume_thread_with_history`, auto-attaches a listener, and
  returns `ThreadResumeResponse` (`codex_message_processor.rs:3245` through
  `codex_message_processor.rs:3355`).
- For already-running threads, `handle_pending_thread_resume_request` composes
  a response with rollout turns plus the active in-memory turn snapshot, replays
  pending server requests to the new connection, and subscribes the connection
  (`codex_message_processor.rs:6896` through `codex_message_processor.rs:6989`).

Thread state manager:

- Per-thread state tracks `pending_interrupts`, pending rollback, current
  turn summary, listener cancellation, raw-event mode, and current turn history
  in `/Users/af/openai-codex/codex/codex-rs/app-server/src/thread_state.rs:52`.
- `set_listener` cancels any previous listener and increments a listener
  generation counter (`thread_state.rs:73` through `thread_state.rs:85`).
- `clear_listener` cancels and resets current turn history
  (`thread_state.rs:88` through `thread_state.rs:95`).
- Subscription state is tracked per connection and per thread in
  `ThreadStateManager` (`thread_state.rs:140` onward).

Core thread creation:

- `ThreadManager::spawn_thread_with_source` eventually calls `Codex::spawn` and
  finalizes the new thread (`/Users/af/openai-codex/codex/codex-rs/core/src/thread_manager.rs:583`
  through `thread_manager.rs:617`).
- `CodexThread` is a thin conduit over `Codex`, exposing `submit`,
  `steer_input`, `next_event`, `rollout_path`, and config snapshot helpers in
  `/Users/af/openai-codex/codex/codex-rs/core/src/codex_thread.rs:43`.

## Turn Lifecycle

`turn/start`:

- Validates input limit and loads the thread
  (`codex_message_processor.rs:5662` through `codex_message_processor.rs:5678`).
- Optionally sets the app-server client name and normalizes collaboration mode
  (`codex_message_processor.rs:5679` through `codex_message_processor.rs:5691`).
- If turn-level overrides exist, submits `Op::OverrideTurnContext`
  (`codex_message_processor.rs:5700` through `codex_message_processor.rs:5725`).
- Starts the turn by submitting `Op::UserInput`, then immediately returns a
  synthetic `Turn { status: InProgress, items: [] }` in `TurnStartResponse`
  (`codex_message_processor.rs:5728` through `codex_message_processor.rs:5746`).

Core turn execution:

- `Codex::submit` creates a UUIDv7 submission ID and sends it over `tx_sub`
  (`/Users/af/openai-codex/codex/codex-rs/core/src/codex.rs:580` through
  `codex.rs:602`).
- Core `Session` has at most one running task at a time
  (`codex.rs:652` through `codex.rs:667`).
- The submission loop dispatches `Op::Interrupt` directly and eventually routes
  user input/user turn operations to handlers (`codex.rs:4019` through
  `codex.rs:4029`).
- `handlers::user_input_or_turn` creates a new turn context and either steers
  input into an active task or spawns a new task
  (`codex.rs:4350` through `codex.rs:4418`).

Protocol-level notifications:

- Core `Op::Interrupt` says it emits `EventMsg::TurnAborted` in response in
  `/Users/af/openai-codex/codex/codex-rs/protocol/src/protocol.rs:185`.
- Core `TurnStartedEvent` carries `turn_id`, model context window, and
  collaboration mode kind (`protocol.rs:1694`).
- A test documents that `TurnAbortedEvent` can deserialize without `turn_id`,
  which is important for inspector correlation heuristics
  (`protocol.rs:4103` through `protocol.rs:4114`).

## Stop, Interrupt, And Failure Modes

`turn/interrupt` is not a simple request/response operation:

- The app-server loads the target thread, pushes the request ID into
  `ThreadState.pending_interrupts`, then submits `Op::Interrupt`
  (`codex_message_processor.rs:6237` through `codex_message_processor.rs:6264`).
- Core `Session::interrupt_task` aborts the active task if one exists, otherwise
  cancels MCP startup (`codex.rs:3867` through `codex.rs:3874`).
- Approval abort paths also call `interrupt_task` for exec/patch approvals
  (`codex.rs:4525` through `codex.rs:4537`).

Likely failure modes to inspect:

1. Pending interrupt without terminal event.
   The app-server only has the pending request ID until listener logic observes
   a later abort/completion event. If the listener was replaced, cancelled, or
   failed to attach, the caller can time out while core has already aborted.

2. Terminal event dropped under backpressure.
   In-process clients explicitly protect `TurnCompleted` and legacy terminal
   events from being dropped (`app-server-client/src/lib.rs:60`), but the
   lower-level in-process module still warns that event fanout may drop
   notifications under saturation (`in_process.rs:26`). Stdio/websocket also
   use bounded queues.

3. Turn ID mismatch during steering or interrupt correlation.
   `turn/steer` fails if `expectedTurnId` does not match the active turn
   (`codex_message_processor.rs:5801` through `codex_message_processor.rs:5829`).
   `TurnAbortedEvent` may not include a `turn_id`, so inspectors need to
   correlate by latest in-progress turn on that thread, not by event field only.

4. Resume during unload.
   `thread/resume` explicitly rejects a thread that is closing and tells clients
   to retry after close (`codex_message_processor.rs:3185` through
   `codex_message_processor.rs:3200`).

5. Graceful shutdown hides active-turn state.
   Websocket mode drains on first signal while assistant turns run and forces on
   second signal (`lib.rs:157`). A debugger should show "server draining" versus
   "turn interrupted" as distinct states.

6. Request ingress overload.
   Saturation returns `-32001` with retry guidance; this should be rendered as a
   recoverable transport pressure event, not as a failed user turn.

7. App-server bridge timeout.
   Codex++ preload requests time out after 12s in
   `packages/runtime/src/preload/app-server-bridge.ts:5` and
   `app-server-bridge.ts:47` through `app-server-bridge.ts:51`. A protocol
   inspector should compare bridge-level timeouts against actual app-server
   stdout later responses.

## Persistence, Logs, And State Files

State DB:

- The state crate defines `STATE_DB_FILENAME = "state"` and
  `STATE_DB_VERSION = 5`, producing `state_5.sqlite`
  (`/Users/af/openai-codex/codex/codex-rs/state/src/lib.rs:56` through
  `lib.rs:59`).
- `StateRuntime::init` opens `state_5.sqlite` and `logs_1.sqlite` under the
  configured Codex home, runs migrations, and removes legacy DB files
  (`/Users/af/openai-codex/codex/codex-rs/state/src/runtime.rs:80` through
  `runtime.rs:121`).
- File names and paths are generated at `runtime.rs:146` through
  `runtime.rs:164`.
- Core initializes the state runtime through
  `/Users/af/openai-codex/codex/codex-rs/core/src/state_db.rs:23`, using
  `config.sqlite_home` and `config.model_provider_id` at `state_db.rs:28`
  through `state_db.rs:33`.

Thread metadata DB:

- `StateRuntime::get_thread` selects `id`, `rollout_path`, timestamps, source,
  agent metadata, model provider, cwd, title, sandbox/approval, token and git
  fields from `threads` (`state/src/runtime/threads.rs:3` through
  `threads.rs:36`).
- `find_rollout_path_by_id` uses the `threads` table directly
  (`threads.rs:78` through `threads.rs:99`).
- `list_threads` pages over the `threads` table with filtering/sorting fields
  (`threads.rs:102` through `threads.rs:139`).
- `apply_rollout_items` incrementally updates thread metadata from rollout
  items and persists dynamic tools (`threads.rs:445` through `threads.rs:498`).

Rollout JSONL:

- `RolloutRecorder` persists session rollouts as JSONL and documents inspection
  with `jq`/`fx` at
  `/Users/af/openai-codex/codex/codex-rs/core/src/rollout/recorder.rs:61`.
- It stores the active `rollout_path` and optional `state_db` handle
  (`recorder.rs:70` through `recorder.rs:76`).
- Create/resume modes are explicit (`recorder.rs:79` through `recorder.rs:92`).

Session index:

- Session name lookup goes through `session_index.jsonl`; the index reader scans
  line-by-line and newest-first for ID/name matching in
  `/Users/af/openai-codex/codex/codex-rs/core/src/rollout/session_index.rs:84`
  through `session_index.rs:147`.

Tracing logs DB:

- `logs_1.sqlite` captures `tracing` events via `codex_state::log_db`
  (`/Users/af/openai-codex/codex/codex-rs/state/src/log_db.rs:1`).
- The writer uses a bounded queue of 512, batches 128 inserts, and flushes every
  2 seconds (`log_db.rs:43` through `log_db.rs:47`).
- The tracing layer extracts thread IDs from span/event fields and writes
  `LogEntry` rows (`log_db.rs:128` through `log_db.rs:141`).
- Runtime retention caps logs per thread or process partition at 10 MiB
  (`state/src/runtime.rs:60` through `runtime.rs:64`).

## Codex++ Current Seams

Renderer app-server bridge:

- `requestAppServer` sends `{ type: "mcp-request", hostId, request: { id,
  method, params } }` through `codex_desktop:message-from-view`
  (`/Users/af/codex-plusplus/packages/runtime/src/preload/app-server-bridge.ts:37`
  through `app-server-bridge.ts:66`).
- It subscribes to `codex_desktop:message-for-view` and `window.message`
  (`app-server-bridge.ts:96` through `app-server-bridge.ts:105`).
- It accepts `mcp-response`, `mcp-error`, raw `type: "response"`, or raw
  JSON-RPC-ish response envelopes (`app-server-bridge.ts:133` through
  `app-server-bridge.ts:170`).
- It treats `mcp-notification` and method-only messages with no `id` as
  notifications (`app-server-bridge.ts:172` through
  `app-server-bridge.ts:197`).

Main-process flow tap:

- `main.ts` installs the app-server flow tap during startup and logs to
  `CODEX_PLUSPLUS_USER_ROOT/log/app-server-flow.jsonl`
  (`/Users/af/codex-plusplus/packages/runtime/src/main.ts:46` through
  `main.ts:87`).
- Flow tap state tracks install/enabled/active status, active PIDs, child count,
  captured message count, and last event time
  (`/Users/af/codex-plusplus/packages/runtime/src/app-server-flow-tap.ts:21`
  through `app-server-flow-tap.ts:46`).
- `isCodexAppServerSpawn` detects `codex app-server` spawned by `codex` or
  `codex.exe` (`app-server-flow-tap.ts:123` through
  `app-server-flow-tap.ts:129`).
- It wraps future `child_process` loads and existing `spawn`/`execFile`
  (`app-server-flow-tap.ts:168` through `app-server-flow-tap.ts:220`).
- It taps stdout/stderr plus stdin writes/end calls (`app-server-flow-tap.ts:222`
  through `app-server-flow-tap.ts:294`).
- It buffers by stream, splits on newline, truncates single lines beyond 200k
  chars, and appends capped JSONL flow events (`app-server-flow-tap.ts:297`
  through `app-server-flow-tap.ts:367`).
- `summarizeJsonRpcLine` classifies messages as request/notification/response/
  error and extracts method, ID, thread ID, turn ID, status, and error message
  (`app-server-flow-tap.ts:131` through `app-server-flow-tap.ts:166`).

Existing product research already identified app-server bridge and goal feature
opportunities in
`/Users/af/codex-plusplus/research/agents/app-server-api.md:20` through
`app-server-api.md:31`, and the research README records local embedded app-server
context at `/Users/af/codex-plusplus/research/README.md:20` through
`research/README.md:33`.

## Inspector Data Model

A Codex++ inspector should normalize all evidence into a small append-only
event model:

```ts
type ProtocolDirection =
  | "electron-main->app-server"
  | "app-server->electron-main"
  | "app-server->stderr"
  | "renderer->desktop-bridge"
  | "desktop-bridge->renderer";

interface ProtocolEvent {
  ts: string;
  seq: number;
  pid?: number | null;
  direction: ProtocolDirection;
  kind: "request" | "notification" | "response" | "error" | "log" | "lifecycle";
  id?: string | number | null;
  method?: string;
  threadId?: string;
  turnId?: string;
  status?: string;
  errorMessage?: string;
  bytes?: number;
  truncated?: boolean;
  rawRef?: string;
}
```

Derived indexes:

- By request ID: request -> response/error latency, timeout, retry.
- By thread ID: lifecycle, loaded/subscribed connections, active turn,
  pending server requests, pending interrupts.
- By turn ID: `turn/start` response -> `turn/started` -> items/deltas ->
  `turn/completed` or abort/failure.
- By app-server child PID: spawn, stderr logs, EOF/exit, reconnects.
- By storage pointer: thread ID -> rollout path -> state DB row -> recent logs.

## Ranked Implementation Ideas

1. Protocol Flow Timeline
   - Impact: high.
   - Effort: small to medium.
   - Confidence: high.
   - Dependency: Codex++ runtime seam plus existing flow tap.
   - Build a Settings/diagnostics page over `log/app-server-flow.jsonl`.
     Render request/response pairs, notification streams, latency, pending IDs,
     and stderr lines. Use existing flow tap summaries first; no app-server
     mutation required.

2. Turn Lifecycle Inspector
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: app-server protocol.
   - Group events by `threadId` and `turnId`. Show expected transitions:
     `turn/start response -> turn/started -> item/* -> turn/completed`.
     Flag missing terminal notifications, duplicate starts, stale in-progress
     turns, and bridge-level timeouts where app-server later answered.

3. Stop/Interrupt Debugger
   - Impact: high.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: app-server protocol plus flow tap.
   - Track `turn/interrupt` requests, pending response age, nearest active turn,
     subsequent `turn_aborted`/`turn/completed` notifications, and bridge timeout.
     This directly targets the failure class where stop appears broken because
     the app-server is waiting on listener-observed abort state.

4. State And Rollout Cross-Linker
   - Impact: high.
   - Effort: medium.
   - Confidence: high.
   - Dependency: local state files.
   - Read `~/.codex/state_5.sqlite`, `~/.codex/logs_1.sqlite`,
     `~/.codex/session_index.jsonl`, and rollout JSONL with hard byte/time caps.
     For any visible thread, show DB metadata, rollout path, last JSONL event,
     current archive/name/source status, and recent tracing rows.

5. App-Server Health HUD
   - Impact: medium.
   - Effort: small.
   - Confidence: high.
   - Dependency: Codex++ runtime seam.
   - Extend current Settings status with active app-server PID, flow tap enabled
     source, captured message count, last event timestamp, log size, and recent
     overload/error counts. This is mostly presentation over
     `getAppServerFlowTapRuntimeStatus()`.

6. Schema-Aware Protocol Decoder
   - Impact: medium.
   - Effort: medium.
   - Confidence: high.
   - Dependency: app-server-protocol schema fixtures.
   - Bundle or generate v2 JSON schema/TypeScript definitions from upstream
     `app-server-protocol/schema`. Decode request/response bodies by method and
     mark unknown fields. Start read-only; later generate typed Codex++ wrappers.

7. Bridge Timeout Explainer
   - Impact: medium.
   - Effort: small.
   - Confidence: high.
   - Dependency: preload bridge.
   - Instrument `requestAppServer` with optional debug notifications that record
     bridge timeout versus eventual protocol response. Useful because the bridge
     timeout is 12s while app-server operations can legitimately run longer.

8. Pending Server Request Panel
   - Impact: medium.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: protocol flow and app-server state inference.
   - Infer outbound server requests that require client response, such as
     approvals, external auth refresh, dynamic tools, user input, and MCP
     elicitations. Show age and whether a client response arrived. This helps
     diagnose hangs where the model is waiting on UI.

9. Websocket Debug Harness
   - Impact: low to medium.
   - Effort: medium.
   - Confidence: medium.
   - Dependency: upstream experimental websocket transport.
   - For dev builds, launch `codex app-server --listen ws://127.0.0.1:PORT` and
     exercise `/readyz`, `/healthz`, and raw websocket JSON frames. Keep out of
     production because upstream marks websocket unsupported.

10. Recovery Handoff Generator
    - Impact: high for saturated-thread operations.
    - Effort: medium.
    - Confidence: medium.
    - Dependency: local state files plus inspector indexes.
    - Given a thread ID, synthesize a compact recovery prompt with rollout path,
      cwd, current DB metadata, last N protocol events, pending app-server
      requests, and exact next actions. This should read bounded slices of JSONL
      and SQLite, not bulk dump session files.

## Recommended First Build

Ship a read-only Protocol Flow Timeline first:

1. Reuse `app-server-flow-tap.ts` as the capture layer.
2. Add a main-process IPC read API that returns bounded parsed flow events from
   `CODEX_PLUSPLUS_USER_ROOT/log/app-server-flow.jsonl`.
3. Add a Settings diagnostics panel with filters for method, thread ID, turn ID,
   request ID, direction, and errors.
4. Add derived warnings for pending requests older than 12s, `turn/start`
   without terminal notification, `turn/interrupt` without abort/completion, and
   app-server overload responses.
5. Keep raw payload display opt-in and truncated by default because request
   bodies can include user/private content.

This path is low-risk because the tap already exists, no upstream app-server
contract needs to change, and it gives immediate evidence for the stop/interrupt
and timeout classes that are otherwise invisible from Codex Desktop UI.

## Open Questions

- Does the installed Desktop bridge always spawn an external `codex app-server`,
  or can some channels move to in-process app-server only? Current Codex++ flow
  tap only sees child processes.
- Which app-server notification methods are opted out per connection in current
  Desktop? `OutboundConnectionState` tracks opt-outs, but the renderer-level
  negotiation needs bundle/runtime confirmation.
- Are `state_5.sqlite` and `logs_1.sqlite` always under `~/.codex`, or does
  Desktop use `CODEX_SQLITE_HOME`/alternate `sqlite_home` in some channels?
- Which app-server methods can expose secrets or raw user content? The inspector
  should default to metadata-only summaries and require explicit reveal.
