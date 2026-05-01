# CDP/Browser Runtime Observability For Codex.app

Scope: research lane only. This file maps Chromium DevTools Protocol observability for real Codex.app and Codex (Beta).app instances. It does not change product code.

Date: 2026-05-01.

## Executive Shape

Codex++ should treat CDP as a privileged local diagnostic channel, not as the default product telemetry bus. It is strongest for live renderer proof: target discovery, `Runtime.evaluate`, console/exception capture, network tracing, DOM/layout snapshots, screenshots, and Chromium performance traces. It is weaker as a durable always-on subsystem because an exposed remote-debugging port can inspect and control the app renderer.

The right product shape is:

1. A local-only, opt-in "CDP Attach" mode for stable and beta channels.
2. A small probe library that verifies three separate states: process argv, TCP listener, and inspectable targets.
3. A DevTools Protocol Monitor style UI inside Codex++ that records bounded method/event envelopes and can issue whitelisted commands.
4. Evidence bundles that save `version.json`, target lists, console/network NDJSON, DOM snapshot JSON, screenshots, trace JSON, and log tails with redaction.

Current local evidence:

- Stable is configured with Codex++ CDP enabled on port `9222` in `/Users/af/Library/Application Support/codex-plusplus/config.json`.
- Beta is configured with Codex++ CDP enabled on port `9222` in `/Users/af/Library/Application Support/codex-plusplus-beta/config.json`, which conflicts with stable if both are open. The code defaults beta to `9223`, but this local config currently overrides that.
- On this run, `127.0.0.1:9222` is listening and `/json/version` responds with `Chrome/146.0.7680.179` and protocol `1.3`.
- On this run, `9223` is not listening.
- On this run, `/json/list` and browser-level `Target.getTargets` returned no inspectable targets, which proves a useful distinction: "debug socket alive" is not the same as "Codex renderer is currently discoverable."

## Primary References

- Chrome DevTools Protocol overview and HTTP endpoints: https://chromedevtools.github.io/devtools-protocol/
- Runtime domain and `Runtime.evaluate`: https://chromedevtools.github.io/devtools-protocol/tot/Runtime/
- Target discovery and attachment: https://chromedevtools.github.io/devtools-protocol/tot/Target/
- Network events: https://chromedevtools.github.io/devtools-protocol/tot/Network/
- DOMSnapshot domain: https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/
- Page screenshots: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot
- Tracing: https://chromedevtools.github.io/devtools-protocol/tot/Tracing/
- Chrome DevTools Protocol Monitor: https://developer.chrome.com/docs/devtools/protocol-monitor
- Chrome 136+ remote-debugging security change: https://developer.chrome.com/blog/remote-debugging-port

Important source facts:

- `/json/version` exposes the browser-level `webSocketDebuggerUrl`.
- `/json` and `/json/list` list page-like websocket targets when they are exposed by the browser.
- If Chrome is launched with `--remote-debugging-port=0`, Chromium writes the chosen port and browser path into `DevToolsActivePort` inside the browser profile directory.
- `Runtime.evaluate` evaluates an expression on the inspected global object and can return JSON-compatible values by value.
- `DOMSnapshot.captureSnapshot` returns flattened DOM, layout, and selected computed styles.
- `Page.captureScreenshot` captures a page screenshot as base64 encoded image data.
- `Target.getTargets` returns available targets from the browser websocket even when `/json/list` is insufficient for a given embedder.
- Protocol Monitor records CDP requests/responses/events, saves them, and can send raw commands.
- Since Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are not respected against the default Chrome data directory; they must be paired with a non-standard `--user-data-dir`. Electron/Codex behavior should still be verified empirically per build, but the Chrome change explains many "argv present, no listener" cases for Chrome-based tooling.

## Local Codex++ Seams

Existing code already has the essential attach seam:

- `packages/runtime/src/main.ts:66-80` documents and appends Electron's `remote-debugging-port` switch before app readiness.
- `packages/runtime/src/main.ts:245-268` resolves startup CDP configuration from argv, env, or `config.json`.
- `packages/runtime/src/main.ts:291-310` parses an active `--remote-debugging-port` from Electron commandLine or `process.argv`.
- `packages/runtime/src/main.ts:313-369` reports status and builds the restart command.
- `packages/installer/src/commands/dev-runtime.ts:182-213` builds stable/beta restart plans and `/json/version` URLs.
- `packages/installer/src/commands/dev-runtime.ts:240-263` restarts the app with `open -na <app> --args --remote-debugging-port=<port>`.
- `research/agents/automation-qa.md:17-34` already proposes a CDP proof harness over the real patched Codex renderer.

The current product gap is not "can we open a port?" It is "can we reliably prove the port maps to the renderer we care about, capture useful evidence, and explain why attachment failed?"

## Port And Process Discovery

Use these commands as the first tier. They are intentionally small and bounded.

```sh
# Show Codex/Codex Beta processes and remote-debugging switches.
ps -axo pid,ppid,command \
  | rg -i 'Codex|remote-debugging|CODEXPP_REMOTE_DEBUG' \
  | rg -v 'rg -i' \
  | sed -n '1,200p'

# Check the expected stable/beta ports.
for port in 9222 9223; do
  printf '\n--- port %s ---\n' "$port"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  curl -fsS --max-time 2 "http://127.0.0.1:$port/json/version" \
    | jq '{Browser, ProtocolVersion: ."Protocol-Version", webSocketDebuggerUrl}' \
    || true
  curl -fsS --max-time 2 "http://127.0.0.1:$port/json/list" \
    | jq '[.[] | {id,type,title,url,hasWs:(.webSocketDebuggerUrl != null)}]' \
    || true
done

# Find Chromium random-port files created by --remote-debugging-port=0.
find /var/folders -name DevToolsActivePort -type f -maxdepth 8 2>/dev/null \
  | while read -r f; do
      printf '\n%s\n' "$f"
      sed -n '1,2p' "$f"
    done
```

Observed on this run:

```txt
--- port 9222 ---
Codex ... TCP 127.0.0.1:9222 (LISTEN)
{
  "Browser": "Chrome/146.0.7680.179",
  "ProtocolVersion": "1.3",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/968612d5-87e1-4081-98e8-cf092686c7a2"
}

--- port 9223 ---
no listener
```

Beta-specific local finding:

```sh
sed -n '1,200p' "$HOME/Library/Application Support/codex-plusplus-beta/config.json"
```

Current beta config includes:

```json
{
  "codexPlusPlus": {
    "cdp": {
      "enabled": true,
      "port": 9222
    }
  }
}
```

That explains one class of beta failure: beta can be configured to use the stable port. If stable already owns `9222`, beta may show a remote-debugging argv/config intent but never become reachable on the expected beta port `9223`.

## Launch Commands

Prefer `codexplusplus dev-runtime --channel <channel> --restart` once it is the active workflow, because it already stages runtime and checks health. For direct reverse engineering, these are the raw command shapes.

Stable:

```sh
CODEXPP_REMOTE_DEBUG=1 CODEXPP_REMOTE_DEBUG_PORT=9222 \
  "/Applications/Codex.app/Contents/MacOS/Codex"
```

Stable via LaunchServices:

```sh
open -na "/Applications/Codex.app" --args --remote-debugging-port=9222
```

Beta:

```sh
CODEX_PLUSPLUS_HOME="$HOME/Library/Application Support/codex-plusplus-beta" \
CODEXPP_REMOTE_DEBUG=1 CODEXPP_REMOTE_DEBUG_PORT=9223 \
  "/Applications/Codex (Beta).app/Contents/MacOS/Codex (Beta)"
```

Beta via LaunchServices:

```sh
open -na "/Applications/Codex (Beta).app" --args --remote-debugging-port=9223
```

Health wait:

```sh
port=9222
until curl -fsS --max-time 1 "http://127.0.0.1:$port/json/version" >/tmp/codex-cdp-version.json; do
  sleep 0.25
done
jq . /tmp/codex-cdp-version.json
```

## Why argv Can Exist But No Port Listens

Treat argv, listener, and targets as separate facts.

| Symptom | Likely cause | Probe | Fix |
| --- | --- | --- | --- |
| `--remote-debugging-port=9223` appears in docs/config but `lsof` shows no listener | App is not actually running, crashed before Chromium initialized, or a different app instance won | `ps -axo pid,ppid,command | rg 'Codex \\(Beta\\)|remote-debugging'`; tail beta `main.log` | Relaunch beta directly; check crash/logs before assuming CDP bug |
| Beta expected on `9223`, stable owns `9222`, beta config says `port: 9222` | Channel config drift or shared copied config | inspect both `config.json` files; `lsof -iTCP:9222` | Set beta config to `9223` or let `dev-runtime` avoid sibling default |
| argv is visible on helper/renderer processes but browser process has no listener | You are reading inherited helper argv, not the browser process bind state | `lsof -nP -iTCP:<port> -sTCP:LISTEN`; `/json/version` | Trust listener and HTTP endpoint over helper argv |
| `--remote-debugging-port=0` appears but fixed port is closed | Chromium chose a random port | find `DevToolsActivePort` under the user-data dir or temp profile | Read the file and connect to that port |
| Chrome process has argv but no listener on Chrome 136+ | Chrome ignored remote debugging for the default user data dir | check Chrome version and launch args | use Chrome for Testing or pass a non-default `--user-data-dir` |
| `/json/version` works but `/json/list` is empty | Browser endpoint is alive but no inspectable renderer targets are exposed yet, renderer windows are gone, or embedder target exposure is delayed/filtered | attach to browser websocket and call `Target.getTargets`; tail `web-contents-created` | wait for renderer, bring app window forward, reload, or instrument Electron `webContents` creation |
| `Target.getTargets` also empty | Browser CDP session is alive but target discovery is not surfacing webContents in current state | enable `Target.setDiscoverTargets`; watch `targetCreated`; compare with main log `web-contents-created` | add product-level health state that maps Electron webContents ids to CDP target ids |
| WebSocket closes after opening DevTools manually | A DevTools frontend can replace/detach another client | watch for `Inspector.detached` events | avoid opening embedded DevTools while proof harness runs |
| Listener binds but attach fails intermittently | Multiple automation tools attach, crash, or close the same target | list `chrome-devtools-mcp`, Playwright MCP, Playwriter processes | one owner per proof run; close stale MCP sessions when debugging |

## Raw CDP Probe Scripts

These scripts use Node's built-in `fetch` and `WebSocket` in current local Node. If a future runtime lacks global `WebSocket`, install/use `ws` or run through Bun.

### 1. Version And HTTP Target Probe

```sh
node --input-type=module <<'NODE'
const port = Number(process.env.CDP_PORT ?? 9222);
const endpoint = `http://127.0.0.1:${port}`;

const getJson = async (path) => {
  const res = await fetch(`${endpoint}${path}`);
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
};

const version = await getJson('/json/version');
const list = await getJson('/json/list').catch((error) => ({ error: String(error) }));

console.log(JSON.stringify({
  endpoint,
  version: {
    Browser: version.Browser,
    ProtocolVersion: version['Protocol-Version'],
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
  },
  targets: Array.isArray(list)
    ? list.map((target) => ({
        id: target.id,
        type: target.type,
        title: target.title,
        url: target.url,
        hasWs: Boolean(target.webSocketDebuggerUrl),
      }))
    : list,
}, null, 2));
NODE
```

### 2. Browser Target Discovery Probe

Use this when `/json/list` is empty or suspicious. It connects to the browser websocket from `/json/version` and calls `Target.getTargets`.

```sh
node --input-type=module <<'NODE'
const port = Number(process.env.CDP_PORT ?? 9222);
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());

const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method) {
    console.error(JSON.stringify({ event: message.method, params: message.params }));
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Target.setDiscoverTargets', { discover: true });
const targets = await send('Target.getTargets');
console.log(JSON.stringify({
  browser: version.Browser,
  targetInfos: targets.result?.targetInfos?.map((target) => ({
    targetId: target.targetId,
    type: target.type,
    title: target.title,
    url: target.url,
    attached: target.attached,
  })) ?? [],
}, null, 2));

ws.close();
NODE
```

### 3. Attach To A Page Target And Evaluate

This script uses browser-level `Target.attachToTarget` with `flatten: true`, then sends session-scoped commands. It should be the canonical raw primitive for Codex++ QA because it works even when direct page websocket URLs are not available from `/json/list`.

```sh
node --input-type=module <<'NODE'
const port = Number(process.env.CDP_PORT ?? 9222);
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const targets = await send('Target.getTargets');
const page = targets.result?.targetInfos?.find((target) =>
  target.type === 'page' || target.type === 'webview' || target.url?.startsWith('app://')
);

if (!page) {
  console.error(JSON.stringify({ error: 'no-inspectable-page-target', targets }, null, 2));
  process.exit(2);
}

const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const sessionId = attached.result.sessionId;
const sendSession = (method, params = {}) => send(method, { sessionId, ...params });

await sendSession('Runtime.enable');
const evaluated = await sendSession('Runtime.evaluate', {
  expression: `({
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    hasCodexPlusPlus: Boolean(document.querySelector('[data-codex-plusplus], .codex-plusplus, [data-codexpp]')),
    bodyText: document.body?.innerText?.slice(0, 300) ?? ''
  })`,
  returnByValue: true,
  awaitPromise: true,
});

console.log(JSON.stringify({
  target: page,
  value: evaluated.result?.result?.value,
  exception: evaluated.result?.exceptionDetails,
}, null, 2));

ws.close();
NODE
```

## Console And Exception Tracing

CDP console tracing needs domain enablement before the interesting event occurs. Run it as a live recorder, then trigger the UI flow manually or through a second CDP command.

```sh
mkdir -p /tmp/codex-cdp
CDP_PORT=9222 node --input-type=module > /tmp/codex-cdp/console.ndjson <<'NODE'
const port = Number(process.env.CDP_PORT ?? 9222);
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

const write = (value) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...value })}\n`);

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
    write({ method: message.method, params: message.params });
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const targets = await send('Target.getTargets');
const page = targets.result?.targetInfos?.find((target) => target.type === 'page' || target.type === 'webview');
if (!page) throw new Error('no page target');

const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const sessionId = attached.result.sessionId;
const sendSession = (method, params = {}) => send(method, { sessionId, ...params });

await sendSession('Runtime.enable');
await sendSession('Log.enable');
write({ status: 'recording', target: page });
setInterval(() => {}, 60_000);
NODE
```

Product rule: do not display raw console arguments by default. Convert them to level, type, URL, line/column, stack presence, and short preview. Raw payload expansion should be a local-only user action.

## Network Tracing

For request timing and failures:

```sh
CDP_PORT=9222 node --input-type=module > /tmp/codex-cdp/network.ndjson <<'NODE'
const port = Number(process.env.CDP_PORT ?? 9222);
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

const write = (value) => process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...value })}\n`);

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method?.startsWith('Network.')) {
    const p = message.params ?? {};
    write({
      method: message.method,
      requestId: p.requestId,
      url: p.request?.url ?? p.response?.url,
      type: p.type,
      status: p.response?.status,
      errorText: p.errorText,
      timestamp: p.timestamp,
    });
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const targets = await send('Target.getTargets');
const page = targets.result?.targetInfos?.find((target) => target.type === 'page' || target.type === 'webview');
if (!page) throw new Error('no page target');

const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const sessionId = attached.result.sessionId;
const sendSession = (method, params = {}) => send(method, { sessionId, ...params });

await sendSession('Network.enable', { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000 });
write({ status: 'recording-network', target: page });
setInterval(() => {}, 60_000);
NODE
```

Useful events to normalize:

- `Network.requestWillBeSent`: URL, method, initiator, type, request id.
- `Network.responseReceived`: status, MIME type, headers shape, timing.
- `Network.loadingFinished`: encoded data length and completion.
- `Network.loadingFailed`: failure reason.
- `Network.webSocketCreated`, `Network.webSocketFrameSent`, `Network.webSocketFrameReceived`: useful only with payload redaction.
- `Network.eventSourceMessageReceived`: useful for streamed app/server events if present.

Codex++ UI should group by request id and default to host/path/status/timing, not full query strings or request/response bodies.

## DOM Snapshot And Layout Proof

`DOMSnapshot.captureSnapshot` is better than `document.documentElement.outerHTML` when the goal is visual/debug evidence because it can include layout boxes and whitelisted computed styles.

```sh
CDP_PORT=9222 node --input-type=module <<'NODE'
import { writeFileSync, mkdirSync } from 'node:fs';

const out = process.env.OUT_DIR ?? '/tmp/codex-cdp';
mkdirSync(out, { recursive: true });

const port = Number(process.env.CDP_PORT ?? 9222);
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const targets = await send('Target.getTargets');
const page = targets.result?.targetInfos?.find((target) => target.type === 'page' || target.type === 'webview');
if (!page) throw new Error('no page target');

const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const sessionId = attached.result.sessionId;
const sendSession = (method, params = {}) => send(method, { sessionId, ...params });

await sendSession('DOMSnapshot.enable');
const snapshot = await sendSession('DOMSnapshot.captureSnapshot', {
  computedStyles: ['display', 'visibility', 'opacity', 'position', 'z-index', 'color', 'background-color', 'font-size'],
  includeDOMRects: true,
  includePaintOrder: true,
});

writeFileSync(`${out}/domsnapshot.json`, JSON.stringify(snapshot.result, null, 2));
console.log(`${out}/domsnapshot.json`);
ws.close();
NODE
```

Codex++ product idea: add a "DOM Snapshot Diff" tab for before/after tweak validation. It should summarize node count, text samples, selectors of mounted Codex++ roots, hidden/zero-size nodes, and z-index extrema. Full JSON should stay downloadable, not rendered inline by default.

## Screenshots

Raw CDP screenshot:

```sh
CDP_PORT=9222 OUT_DIR=/tmp/codex-cdp node --input-type=module <<'NODE'
import { writeFileSync, mkdirSync } from 'node:fs';

const out = process.env.OUT_DIR ?? '/tmp/codex-cdp';
mkdirSync(out, { recursive: true });

const port = Number(process.env.CDP_PORT ?? 9222);
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

const targets = await send('Target.getTargets');
const page = targets.result?.targetInfos?.find((target) => target.type === 'page' || target.type === 'webview');
if (!page) throw new Error('no page target');

const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const sessionId = attached.result.sessionId;
const sendSession = (method, params = {}) => send(method, { sessionId, ...params });

await sendSession('Page.enable');
await sendSession('Page.bringToFront').catch(() => {});
const screenshot = await sendSession('Page.captureScreenshot', {
  format: 'png',
  fromSurface: true,
  captureBeyondViewport: false,
});

writeFileSync(`${out}/screenshot.png`, Buffer.from(screenshot.result.data, 'base64'));
console.log(`${out}/screenshot.png`);
ws.close();
NODE
```

For responsive proof, prefer Playwright after CDP attach if targets are discoverable:

```js
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => candidate.url().startsWith('app://')) ?? context.pages()[0];
await page.setViewportSize({ width: 1440, height: 1000 });
await page.screenshot({ path: '/tmp/codex-cdp/desktop.png', fullPage: true });
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: '/tmp/codex-cdp/mobile.png', fullPage: true });
await browser.close();
```

Screenshot product checks:

- Reject files below a small byte threshold, e.g. `< 10 KiB`.
- Decode PNG dimensions and ensure width/height match expected viewport.
- Sample pixels to detect all-white/all-black captures.
- Store route, target id, viewport, channel, port, app version, and feature flags next to the image.

## Performance And Trace Capture

For lightweight metrics:

```sh
Runtime.evaluate({ expression: 'performance.getEntriesByType("navigation")', returnByValue: true })
Performance.enable
Performance.getMetrics
```

Raw trace capture with stream output:

```sh
CDP_PORT=9222 OUT_DIR=/tmp/codex-cdp node --input-type=module <<'NODE'
import { writeFileSync, mkdirSync } from 'node:fs';

const out = process.env.OUT_DIR ?? '/tmp/codex-cdp';
mkdirSync(out, { recursive: true });
const port = Number(process.env.CDP_PORT ?? 9222);
const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((res) => res.json());
const ws = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
let tracingComplete;
const traceDone = new Promise((resolve) => (tracingComplete = resolve));

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Tracing.tracingComplete') tracingComplete(message.params);
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Tracing.start', {
  transferMode: 'ReturnAsStream',
  traceConfig: {
    includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink.user_timing'],
  },
});

await new Promise((resolve) => setTimeout(resolve, 5_000));
await send('Tracing.end');
const complete = await traceDone;

let trace = '';
for (;;) {
  const chunk = await send('IO.read', { handle: complete.stream });
  trace += chunk.result.data ?? '';
  if (chunk.result.eof) break;
}
await send('IO.close', { handle: complete.stream });

writeFileSync(`${out}/trace.json`, trace);
console.log(`${out}/trace.json`);
ws.close();
NODE
```

Codex++ UI idea: "Trace 5s" button that records a Chrome trace while also showing app-server request timeline and runtime logs for the same wall-clock interval. This should be gated behind an explicit local debug mode because trace data can contain URLs and script names.

## Protocol Monitor Equivalent For Codex++

Chrome's Protocol Monitor has four useful product primitives:

- It records CDP messages.
- It shows request/response details.
- It can download the message log.
- It can send raw commands with target selection and schema-aware params.

Codex++ should ship a safer, app-specific version:

1. **Target Picker**
   - Rows: channel, port, browser version, target id, type, title, URL, attached state, last seen.
   - Status chips: `argv`, `listening`, `browser-ws`, `targets`, `renderer-ready`.
   - Explicit warning when stable and beta both point at one port.

2. **Message Table**
   - Columns: timestamp, direction, session id, method, id, duration, status.
   - Default payload: redacted shape only.
   - Expanders: local-only raw JSON, copy shape, copy command.

3. **Command Palette**
   - Whitelisted presets: `Runtime.evaluate` for safe readonly snippets, `Page.captureScreenshot`, `DOMSnapshot.captureSnapshot`, `Performance.getMetrics`, `Target.getTargets`.
   - Advanced raw mode behind a confirmation.
   - Autocomplete can be generated from `/json/protocol` for the active browser version.

4. **Evidence Recorder**
   - One-click "record 30 seconds" for console, exceptions, network summary, app-server timeline, logs, targets, and screenshot.
   - Writes a manifest:

```json
{
  "capturedAt": "2026-05-01T00:00:00.000Z",
  "channel": "stable",
  "port": 9222,
  "browser": "Chrome/146.0.7680.179",
  "protocolVersion": "1.3",
  "targetCount": 1,
  "files": {
    "version": "version.json",
    "targets": "targets.json",
    "console": "console.ndjson",
    "network": "network.ndjson",
    "domSnapshot": "domsnapshot.json",
    "screenshot": "screenshot.png",
    "trace": "trace.json"
  },
  "redaction": {
    "rawBodies": false,
    "queryStrings": "stripped",
    "homeDirectory": "~"
  }
}
```

## Codex++ UI Ideas

### 1. CDP Health Strip

- Impact: high
- Effort: small
- Confidence: high
- Dependency: Codex++ runtime seam

Show stable/beta CDP state in Settings -> Codex++ -> Observability:

```txt
Stable  config on 9222  argv on 9222  listening  browser ws ok  targets 0
Beta    config on 9222  argv unknown  closed     conflict: stable owns 9222
```

This directly answers "why Beta port might be on argv but not listening" without opening terminal.

### 2. Target Discovery Timeline

- Impact: high
- Effort: medium
- Confidence: medium
- Dependency: CDP + Electron webContents logs

Correlate:

- `web-contents-created` from `main.log`
- `/json/list`
- `Target.targetCreated`
- `Target.getTargets`
- app URL/title from `Runtime.evaluate`

The product gap shown today is an empty CDP target list despite webContents logs. A timeline makes that visible and gives the next implementation a concrete target: map Electron `webContents.id` to CDP target id where possible.

### 3. Safe Evaluate Notebook

- Impact: medium
- Effort: medium
- Confidence: high
- Dependency: CDP runtime

Provide readonly snippets:

- document title/location/readyState
- mounted Codex++ roots
- React root/container probes
- active element
- selected computed styles
- local storage key names only
- performance navigation summary

Do not include raw prompt text, local storage values, cookies, or full DOM text by default.

### 4. Console/Network Incident Bundle

- Impact: high
- Effort: medium
- Confidence: high
- Dependency: CDP + runtime logs

When a feature fails, the user should click "Capture incident" and get a folder with:

- `manifest.json`
- `version.json`
- `targets.json`
- `console.ndjson`
- `network.ndjson`
- `main-log-tail.txt`
- `preload-log-tail.txt`
- `screenshot.png`

The UI should show a compact summary before revealing files:

```txt
2 exceptions, 4 console errors, 1 failed request, target count changed 1 -> 0, preload boot complete seen 3m ago.
```

### 5. Visual Proof Harness

- Impact: high
- Effort: medium
- Confidence: high
- Dependency: CDP + Playwright

Codex++ PR evidence should be able to run:

```sh
node scripts/qa/cdp-proof.mjs \
  --channel stable \
  --endpoint http://127.0.0.1:9222 \
  --out research/evidence/cdp/$(date +%Y%m%d-%H%M%S)
```

Acceptance checks:

- `/json/version` responds.
- `Target.getTargets` returns at least one page/webview/app target.
- `Runtime.evaluate` returns `location.href`, title, readyState.
- `DOMSnapshot.captureSnapshot` writes JSON.
- screenshot is nonblank.
- console recorder saw no new `Runtime.exceptionThrown` during the smoke flow.

### 6. CDP Conflict Doctor

- Impact: high
- Effort: small
- Confidence: high
- Dependency: installer/runtime config

Add a diagnostic that checks:

- stable config port
- beta config port
- actual listeners
- owning process per port
- `/json/version` Browser string per port
- whether app channel and port match expected defaults

It should emit machine-readable JSON:

```json
{
  "ok": false,
  "problems": [
    {
      "code": "beta-port-conflicts-with-stable",
      "message": "Beta config uses 9222 while stable is listening on 9222.",
      "fix": "Set beta Codex++ CDP port to 9223 or run dev-runtime with channel-aware defaults."
    }
  ]
}
```

## Security Boundaries

- Bind to `127.0.0.1` only. Do not expose CDP on `0.0.0.0`.
- CDP can evaluate JavaScript, inspect DOM, observe network, and capture screenshots. Treat it as full local app control.
- Do not persist cookies, auth headers, prompt text, tool arguments, response bodies, or full local storage values in default evidence.
- Keep raw command mode behind an explicit local confirmation.
- Prefer redacted shapes and bounded NDJSON over full dumps.
- When using Chrome 136+ directly, never point remote debugging at the user's default Chrome data directory; use Chrome for Testing or an isolated `--user-data-dir`.
- One owner per target during proof runs. Avoid running Chrome DevTools MCP, Playwright MCP, Playwriter, and raw scripts against the same target unless the test is explicitly about multi-client behavior.

## Recommended Implementation DAG

1. **Probe script first**
   - Add a read-only `cdp-doctor` script that reports argv, listener, `/json/version`, `/json/list`, `Target.getTargets`, config ports, and owner process.
   - Acceptance: stable/beta port conflict is detected with a clear fix.

2. **Evidence recorder**
   - Add `cdp-record` that writes manifest, version, targets, console/network NDJSON, DOM snapshot, screenshot, and log tails.
   - Acceptance: command exits nonzero if no inspectable target exists.

3. **Settings health strip**
   - Surface the probe output in Codex++ settings.
   - Acceptance: UI distinguishes `configured`, `argv`, `listening`, and `targets`.

4. **Protocol monitor view**
   - Add bounded live CDP message table with target picker and whitelisted commands.
   - Acceptance: can send `Target.getTargets`, `Runtime.evaluate`, and `Page.captureScreenshot`; can download redacted log.

5. **PR proof harness**
   - Wrap recorder with desktop/mobile screenshots and pass/fail checks.
   - Acceptance: PR descriptions can include exact evidence paths and viewport metadata.

## Open Questions

- Does current Electron/Codex expose renderer targets only after a specific window focus/navigation point, or is the empty target list caused by the current multi-agent/MCP process state?
- Can Codex++ reliably map Electron `webContents.id` to CDP `targetId` from the main process, or do we need a renderer-origin handshake?
- Should beta CDP config automatically avoid stable's configured/listening port at startup, or should that remain a doctor/repair action?
- Should Codex++ prefer `--remote-debugging-port=0` plus `DevToolsActivePort` discovery for conflict-free runs, or fixed channel defaults for easier manual attach?
- Which evidence fields are safe enough for PR attachment versus local-only support bundles?
