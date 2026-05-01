# Renderer/React Reverse Engineering For Codex.app

Scope: live UI internals for Codex.app and Codex (Beta).app on macOS, with
Codex++ as the injection and tooling layer. This is a research lane only. It
does not require product source edits.

Current local baseline, verified 2026-05-01:

- Stable: `/Applications/Codex.app`, bundle id `com.openai.codex`, version
  `26.429.20946`, build `2312`.
- Beta: `/Applications/Codex (Beta).app`, bundle id `com.openai.codex.beta`,
  version `26.429.21146`, build `2317`.
- Stable asar path: `/Applications/Codex.app/Contents/Resources/app.asar`.
- The installed asar has Vite chunks under `/webview/assets/` and Electron
  preload files under `/.vite/build/`.
- `npx --yes asar list ... | rg '\.map$'` returned `0`, so source maps are not
  shipped in the installed stable asar.
- Codex++ already installs a minimal React DevTools hook in
  `packages/runtime/src/preload/react-hook.ts` and exposes fiber helpers through
  the tweak host.

## Fast Evidence Commands

Use these commands for repeatable local evidence. Keep extraction under `/tmp`
or another scratch directory, not the repo root.

```sh
APP="/Applications/Codex.app"
ASAR="$APP/Contents/Resources/app.asar"
SCRATCH="$(mktemp -d /tmp/codex-renderer.XXXXXX)"

/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist"

npx --yes asar list "$ASAR" | rg '^/(webview|\.vite)/' | sed -n '1,220p'
npx --yes asar list "$ASAR" | rg '\.map$' | wc -l | tr -d ' '

node <<'NODE'
const asar = require("@electron/asar");
const archive = "/Applications/Codex.app/Contents/Resources/app.asar";
for (const p of [
  "webview/index.html",
  ".vite/build/preload.js",
  "webview/assets/composer-B5UwBne4.js",
]) {
  const b = asar.extractFile(archive, p);
  console.log(p, b.length, b.subarray(0, 160).toString("utf8").replace(/\s+/g, " "));
}
NODE
```

For grepable extracted chunks:

```sh
APP="/Applications/Codex.app"
ASAR="$APP/Contents/Resources/app.asar"
SCRATCH="$(mktemp -d /tmp/codex-webview.XXXXXX)"
npx --yes asar extract "$ASAR" "$SCRATCH/app"

rg -n 'ProseMirror|data-codex-composer|data-app-action|settings|thread|history|hostId' \
  "$SCRATCH/app/webview/assets" "$SCRATCH/app/.vite/build"

rg -n 'codex_desktop:message-from-view|codex_desktop:message-for-view|contextBridge|exposeInMainWorld' \
  "$SCRATCH/app/.vite/build"
```

Hazard: `asar extract-file` writes to the current working directory when used
from the CLI. Prefer the Node `@electron/asar` API for one-off reads, or extract
the whole archive into an explicit scratch directory.

## Live Renderer Attachment

The most useful live target is the Electron renderer webContents with remote
debugging enabled. Codex++ already has restart/dev flows that enable CDP.

```sh
cd /Users/af/codex-plusplus
codexplusplus dev-runtime --channel both --restart

# Then discover active DevTools targets.
curl -s http://127.0.0.1:9222/json/version | jq .
curl -s http://127.0.0.1:9222/json/list | jq '.[] | {id,title,url,type,webSocketDebuggerUrl}'
```

If port `9222` is not active, inspect the Codex++ main log for the actual remote
debugging port or restart command:

```sh
tail -200 "$HOME/Library/Application Support/codex-plusplus/log/main.log"
tail -200 "$HOME/Library/Application Support/codex-plusplus/log/preload.log"
```

Feasibility: high. CDP can evaluate snippets, inspect DOM, subscribe to console
and runtime exceptions, collect performance entries, and save screenshots
without source patching.

Hazards:

- CDP evaluation runs in the main world of the page target by default. Keep
  snippets read-only unless testing a dev-only Codex++ inspector.
- Avoid dumping DOM text or prompt content into logs. Prefer selectors, class
  lists, bounding boxes, owner names, and redacted payload shapes.
- CDP target ids change across reloads and Codex updates.

## React DevTools Hook And Fiber Walk

Codex++ installs a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` before React mounts
when no hook exists. React calls `hook.inject(rendererInternals)`. The captured
internals include `findFiberByHostInstance`, which is the cleanest DOM-to-fiber
bridge available from preload.

Live console probe:

```js
(() => {
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const codexpp = window.__codexpp__;
  return {
    hasHook: Boolean(hook),
    rendererCount: hook?.renderers?.size ?? codexpp?.renderers?.size ?? 0,
    renderers: [...(hook?.renderers ?? codexpp?.renderers ?? new Map())].map(
      ([id, r]) => ({
        id,
        version: r.version,
        package: r.rendererPackageName,
        bundleType: r.bundleType,
        hasFindFiber: typeof r.findFiberByHostInstance === "function",
      }),
    ),
  };
})();
```

DOM node to fiber:

```js
function fiberForNode(node) {
  for (const r of window.__codexpp__?.renderers?.values?.() ?? []) {
    const fiber = r.findFiberByHostInstance?.(node);
    if (fiber) return fiber;
  }
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber")) return node[key];
  }
  return null;
}

function fiberSummary(fiber, depth = 12) {
  const rows = [];
  for (let f = fiber, i = 0; f && i < depth; f = f.return, i++) {
    const type = f.type;
    rows.push({
      depth: i,
      tag: f.tag,
      key: f.key,
      name:
        type?.displayName ||
        type?.name ||
        f.elementType?.displayName ||
        f.elementType?.name ||
        (typeof type === "string" ? type : null),
      props: Object.keys(f.memoizedProps || {}).slice(0, 24),
      stateKeys:
        f.memoizedState && typeof f.memoizedState === "object"
          ? Object.keys(f.memoizedState).slice(0, 12)
          : [],
    });
  }
  return rows;
}

const composer = document.querySelector('.ProseMirror[data-codex-composer="true"]');
console.table(fiberSummary(fiberForNode(composer)));
```

Finding owner components by name fragment:

```js
function walkFiber(root, visit, seen = new Set()) {
  if (!root || seen.has(root)) return;
  seen.add(root);
  visit(root);
  walkFiber(root.child, visit, seen);
  walkFiber(root.sibling, visit, seen);
}

function rootsFromDom() {
  const roots = [];
  for (const el of document.querySelectorAll("body *")) {
    const f = fiberForNode(el);
    if (f?.stateNode?.containerInfo || f?.return == null) roots.push(f);
  }
  return roots;
}

function findFibersByName(pattern) {
  const rx = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
  const hits = [];
  for (const root of rootsFromDom()) {
    walkFiber(root, (f) => {
      const type = f.type;
      const name = type?.displayName || type?.name || f.elementType?.name;
      if (name && rx.test(name)) hits.push({ name, props: f.memoizedProps, fiber: f });
    });
  }
  return hits;
}

findFibersByName(/composer|thread|settings|sidebar/i).map((h) => ({
  name: h.name,
  propKeys: Object.keys(h.props || {}).slice(0, 30),
}));
```

Feasibility: high for discovery, medium for production features. Fiber can
identify owner names, prop keys, route params, and better DOM anchors. It should
not be used as a write API.

Hazards:

- Fiber fields are private React internals and can change by React version.
- Minification strips or aliases many component names.
- Reading `memoizedProps` can expose prompt text, file paths, and user content.
  Record only key names and redacted primitive shapes by default.
- Mutating fibers, refs, hooks, ProseMirror state, or native props can corrupt
  the current renderer session.

## DOM Mutation Observation

Use MutationObserver for stable surface detection and reinjection. This is the
right default for Codex++ UI because Codex routes and settings pages are
client-rendered and hashed chunks are update-sensitive.

Low-noise surface observer:

```js
const interestingSelectors = [
  '.ProseMirror[data-codex-composer="true"]',
  "[data-app-action-sidebar-scroll]",
  "[data-app-action-sidebar-section]",
  "[data-app-action-sidebar-project-row]",
  "[data-app-action-sidebar-thread-row]",
  '[data-file-tree-virtualized="true"]',
  "main",
  "aside",
  "[role=dialog]",
  "[role=menu]",
];

function describeElement(el) {
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName,
    id: el.id || null,
    role: el.getAttribute("role"),
    cls: String(el.className || "").slice(0, 180),
    attrs: Object.fromEntries(
      [...el.attributes]
        .filter((a) => a.name.startsWith("data-") || a.name === "aria-label")
        .slice(0, 20)
        .map((a) => [a.name, a.value.slice(0, 120)]),
    ),
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  };
}

const seen = new WeakSet();
const observer = new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      for (const selector of interestingSelectors) {
        const matches = node.matches(selector)
          ? [node]
          : [...node.querySelectorAll(selector)];
        for (const el of matches) {
          if (seen.has(el)) continue;
          seen.add(el);
          console.debug("[codexpp:surface]", selector, describeElement(el));
        }
      }
    }
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });
```

Recommended Codex++ productization:

- Add a dev-only `api.ui.inspectSurfaces()` or hidden Settings page.
- Store a ring buffer of element descriptions, not raw `outerHTML`.
- Include selector, route, bounding box, owner component name, and screenshot
  reference.
- Add one-click "copy redacted evidence" for research artifacts.

Feasibility: high. Existing settings injection already uses DOM and history
observation.

Hazards:

- Whole-document observers can become noisy. Use throttling and selector
  filtering.
- Avoid logging raw `innerText`, `outerHTML`, prompt text, or terminal output.
- Virtualized lists reuse DOM nodes. Surface records must include time, route,
  and geometry, not assume node identity equals data identity.

## Event Listener Tracing

Event tracing answers which native surface owns keyboard, pointer, focus, and
ProseMirror behavior. Use temporary capture listeners first. Monkey-patching
`addEventListener` is powerful but should be dev-only and reversible.

Capture-phase trace for composer and popovers:

```js
const eventTypes = [
  "keydown",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionend",
  "click",
  "pointerdown",
  "focusin",
  "focusout",
];

function eventSummary(e) {
  const path = e.composedPath().slice(0, 8).map((n) => {
    if (!(n instanceof Element)) return n.constructor?.name || String(n);
    return {
      tag: n.tagName,
      role: n.getAttribute("role"),
      data: [...n.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => `${a.name}=${a.value}`),
      cls: String(n.className || "").split(/\s+/).slice(0, 8).join(" "),
    };
  });
  return {
    type: e.type,
    key: e.key,
    inputType: e.inputType,
    defaultPrevented: e.defaultPrevented,
    target: e.target instanceof Element ? e.target.tagName : null,
    path,
  };
}

const stop = [];
for (const type of eventTypes) {
  const fn = (e) => console.debug("[codexpp:event]", eventSummary(e));
  document.addEventListener(type, fn, true);
  stop.push(() => document.removeEventListener(type, fn, true));
}
// later: stop.forEach((fn) => fn())
```

Dev-only listener registry:

```js
(() => {
  if (window.__codexppListenerTrace) return window.__codexppListenerTrace;
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  const listeners = [];

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    listeners.push({
      type,
      target:
        this === window ? "window" :
        this === document ? "document" :
        this instanceof Element ? this.tagName : this.constructor?.name,
      capture: typeof options === "boolean" ? options : Boolean(options?.capture),
      stack: new Error().stack?.split("\n").slice(2, 8).join("\n"),
      at: Date.now(),
    });
    return originalAdd.call(this, type, listener, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    return originalRemove.call(this, type, listener, options);
  };

  return (window.__codexppListenerTrace = {
    listeners,
    restore() {
      EventTarget.prototype.addEventListener = originalAdd;
      EventTarget.prototype.removeEventListener = originalRemove;
    },
  });
})();
```

Feasibility: medium-high. Capturing event flow is reliable. Mapping minified
listener stacks back to logical components depends on bundle archaeology or
source maps.

Hazards:

- Patching `EventTarget.prototype` after app boot misses earlier listeners.
- Patching too early or incorrectly can break React, ProseMirror, menus, and
  Electron context-menu handlers.
- Stack capture on every event listener registration has overhead. Keep it
  behind a debug flag and restore it.

## Route And History State

Codex uses `app://-/index.html?hostId=local` as a renderer URL, then client-side
route state for settings, thread pages, and host-scoped views. Codex++ goal
handling already derives thread id from route, hash, href, `initialRoute`, and
history state.

Read current route state:

```js
(() => ({
  href: location.href,
  origin: location.origin,
  pathname: location.pathname,
  search: location.search,
  hash: location.hash,
  title: document.title,
  historyState: history.state,
  initialRoute: window.initialRoute,
  hostId: new URL(location.href).searchParams.get("hostId"),
}))();
```

Trace route transitions:

```js
(() => {
  if (window.__codexppRouteTrace) return window.__codexppRouteTrace;
  const events = [];
  const push = history.pushState;
  const replace = history.replaceState;
  const record = (kind, args) => {
    queueMicrotask(() => {
      events.push({
        at: new Date().toISOString(),
        kind,
        href: location.href,
        state: history.state,
        args: args.map((x) => (typeof x === "string" ? x : Object.keys(x || {}))),
      });
      console.debug("[codexpp:route]", events.at(-1));
    });
  };
  history.pushState = function (...args) {
    const ret = push.apply(this, args);
    record("pushState", args);
    return ret;
  };
  history.replaceState = function (...args) {
    const ret = replace.apply(this, args);
    record("replaceState", args);
    return ret;
  };
  addEventListener("popstate", () => record("popstate", []));
  return (window.__codexppRouteTrace = {
    events,
    restore() {
      history.pushState = push;
      history.replaceState = replace;
    },
  });
})();
```

Feasibility: high. This is safe for read-only inspection and useful for a
versioned Codex++ route helper.

Hazards:

- Route state can include thread ids, host ids, and project paths. Redact before
  attaching artifacts.
- History monkey patches must preserve exact return values and argument
  behavior.

## Minified Bundle Archaeology

Treat hashed chunks as evidence, not stable contracts. Stable and Beta chunk
hashes differ even when logical modules are similar. Use bundle archaeology to
discover selectors, app-server method names, event channel names, and candidate
owner names, then turn findings into DOM/API probes.

Useful command set:

```sh
APP="/Applications/Codex.app"
ASAR="$APP/Contents/Resources/app.asar"
SCRATCH="$(mktemp -d /tmp/codex-bundle.XXXXXX)"
npx --yes asar extract "$ASAR" "$SCRATCH/app"

# Size and rank JS chunks.
find "$SCRATCH/app/webview/assets" -name '*.js' -print0 |
  xargs -0 wc -c |
  sort -nr |
  sed -n '1,80p'

# Find likely UI modules by readable chunk names and embedded strings.
find "$SCRATCH/app/webview/assets" -name '*.js' -maxdepth 1 -print |
  rg 'composer|thread|settings|sidebar|worktree|review|terminal|mcp|goal|command'

rg -n 'data-codex-composer|ProseMirror|data-app-action-sidebar|file-tree|virtualized|thread/|mcp-request|message-for-view' \
  "$SCRATCH/app/webview/assets" "$SCRATCH/app/.vite/build"

# Pretty-print one chunk for local reading.
npx --yes prettier --parser babel "$SCRATCH/app/webview/assets/composer-B5UwBne4.js" \
  > "$SCRATCH/composer.pretty.js"
rg -n 'ProseMirror|data-codex-composer|keydown|beforeinput|slash|command' "$SCRATCH/composer.pretty.js"
```

Heuristics:

- Vite chunk names often preserve logical source/module names before the hash:
  `composer-*`, `settings-page-*`, `thread-page-header-*`,
  `app-server-manager-*`.
- Search strings beat function names. Look for data attributes, route fragments,
  app-server method names, button labels, settings labels, and Electron channel
  constants.
- Chunk import graphs are useful. Parse `import ... from "./x.js"` and dynamic
  `import("./x.js")` edges to understand route-local surfaces.

Feasibility: high for discovery, low for direct production patching.

Hazards:

- Do not patch hashed chunks as the default integration strategy. Codex updates
  replace them.
- Do not commit extracted proprietary chunks into this repository.
- Avoid broad paste of minified code into issues or PRs. Record commands,
  offsets, and short string anchors instead.

## Source-Map Recovery

Installed stable currently ships no `.map` files in `app.asar`, so source-map
recovery is limited to:

1. Checking whether a future build includes `.map` assets.
2. Checking hidden `sourceMappingURL` comments in extracted JS.
3. Checking whether DevTools can load maps from a remote URL.
4. Reconstructing module boundaries from Vite chunk names, import graph, and
   readable strings.

Commands:

```sh
ASAR="/Applications/Codex.app/Contents/Resources/app.asar"
npx --yes asar list "$ASAR" | rg '\.map$|source-map|sourcemap'

SCRATCH="$(mktemp -d /tmp/codex-sm.XXXXXX)"
npx --yes asar extract "$ASAR" "$SCRATCH/app"
rg -n 'sourceMappingURL|sourcesContent|webpack://|vite://|rollup' \
  "$SCRATCH/app/webview/assets" "$SCRATCH/app/.vite/build"
```

CDP-side check:

```js
performance.getEntriesByType("resource")
  .map((e) => e.name)
  .filter((n) => n.includes(".map") || n.includes("source"))
```

Feasibility: low for true source recovery today. Medium if future builds expose
maps or if local DevTools caches them during development.

Hazards:

- Do not assume third-party source maps are public or redistributable.
- Do not build Codex++ features that require source-map availability.

## Preload And Isolated-World Bridges

Codex++ runs through Electron preload. Codex renderers are sandboxed and
context-isolated, so the preload layer is the correct boundary for privileged
bridges, app-server observation, logs, filesystem access, and tweak hosting.

Bundle archaeology command:

```sh
ASAR="/Applications/Codex.app/Contents/Resources/app.asar"
node <<'NODE'
const asar = require("@electron/asar");
const archive = "/Applications/Codex.app/Contents/Resources/app.asar";
const preload = asar.extractFile(archive, ".vite/build/preload.js").toString("utf8");
for (const needle of [
  "contextBridge",
  "exposeInMainWorld",
  "codex_desktop:message-from-view",
  "codex_desktop:message-for-view",
  "electronBridge",
]) {
  console.log(needle, preload.indexOf(needle));
}
NODE
```

Live bridge inventory:

```js
Object.fromEntries(
  Object.getOwnPropertyNames(window)
    .filter((k) => /bridge|codex|electron|desktop|app/i.test(k))
    .sort()
    .map((k) => [k, typeof window[k]]),
);
```

Codex++ bridge ideas:

- `api.debug.getBridgeInventory()` returning only names and primitive types.
- `api.debug.tapAppServer({ redact: true })` at the existing app-server bridge
  boundary.
- `api.debug.evaluateInMainWorld(snippetId)` with allowlisted snippets only,
  avoiding arbitrary user-provided code execution.
- `api.ui.getSurfaceMap()` combining route, selectors, fiber owner names, and
  bounding boxes.

Feasibility: high. Codex++ already owns a preload bridge and logs sandboxed
preload boot stages.

Hazards:

- Never expose raw filesystem, shell, or arbitrary eval through renderer UI
  without explicit capabilities and user intent.
- Keep isolated-world/main-world boundaries clear. Prefer typed, narrow bridges
  over leaking Electron or Node primitives.
- Main-world script injection should be dev-only unless it becomes a reviewed
  narrow API.

## Renderer Log Capture

Codex++ currently writes preload logs to:

- Stable: `~/Library/Application Support/codex-plusplus/log/preload.log`
- Stable main: `~/Library/Application Support/codex-plusplus/log/main.log`
- Beta: `~/Library/Application Support/codex-plusplus-beta/log/preload.log`
- Beta main: `~/Library/Application Support/codex-plusplus-beta/log/main.log`

Tail commands:

```sh
tail -f "$HOME/Library/Application Support/codex-plusplus/log/main.log"
tail -f "$HOME/Library/Application Support/codex-plusplus/log/preload.log"
tail -f "$HOME/Library/Application Support/codex-plusplus-beta/log/main.log"
tail -f "$HOME/Library/Application Support/codex-plusplus-beta/log/preload.log"
```

CDP console capture sketch:

```js
// Node script after selecting a webSocketDebuggerUrl from /json/list.
const WebSocket = require("ws");
const ws = new WebSocket(process.env.CDP_WS);
let id = 0;
const send = (method, params = {}) =>
  ws.send(JSON.stringify({ id: ++id, method, params }));
ws.on("open", () => {
  send("Runtime.enable");
  send("Log.enable");
});
ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.method === "Runtime.consoleAPICalled") {
    console.log("[console]", msg.params.type, msg.params.args.map((a) => a.value ?? a.description));
  }
  if (msg.method === "Log.entryAdded") {
    console.log("[log]", msg.params.entry.level, msg.params.entry.text);
  }
});
```

Feasibility: high for live debugging. Medium for persistent capture because
privacy and volume controls matter.

Hazards:

- Console logs can contain user prompts, file paths, tool output, and stack
  traces. Redact before storage or PR attachment.
- Keep log capture opt-in and session-scoped by default.
- Ring buffers should cap memory and write size.

## Native Codex++ UI And Tooling Ideas

### 1. Renderer Inspector Settings Page

Impact: high. Effort: medium. Confidence: high. Dependency: Codex++ runtime
seam.

Add a hidden/dev Settings page that shows:

- Current route, host id, history state keys, and thread id candidate.
- React renderer version/package and fiber availability.
- Known surfaces: composer, thread header, sidebar, settings panel, file tree,
  popovers, dialogs.
- For each surface: selector, bounding box, data attributes, owner component
  name, prop key names, and last-seen timestamp.
- "Copy redacted evidence" and "Save evidence JSON" actions.

This directly supports future semantic UI hook maps without hand-maintained
guesswork.

### 2. Semantic Surface Registry

Impact: high. Effort: medium-large. Confidence: medium. Dependency: React/fiber
seam plus DOM observation.

Runtime-maintained registry:

```ts
type SurfaceId =
  | "composer"
  | "thread-header"
  | "sidebar"
  | "settings-content"
  | "file-tree"
  | "message-list"
  | "popover-root";

interface SurfaceEvidence {
  id: SurfaceId;
  route: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  attrs: Record<string, string>;
  fiberOwnerNames: string[];
  confidence: "low" | "medium" | "high";
  observedAt: string;
}
```

Expose a read-only `api.ui.surfaces.subscribe()` first. Add mutation/insertion
helpers only after screenshot proof across Stable and Beta.

### 3. Event Timeline

Impact: high. Effort: medium. Confidence: high. Dependency: Codex++ runtime
seam.

Record a redacted ring buffer of:

- Route transitions.
- DOM surface added/removed.
- Composer key/input events by type only.
- App-server requests/responses at Codex++ bridge boundary.
- Tweak lifecycle events.
- Preload boot and reload events.

Render it as a swimlane in Settings. This would turn reverse engineering into a
repeatable workflow and help explain bugs like route races, duplicate
injection, missed settings anchors, and app-server hangs.

### 4. Bundle Diff Reporter

Impact: medium. Effort: medium. Confidence: high. Dependency: native Codex
seam.

CLI command:

```sh
codexplusplus inspect-bundle --channel stable --out research/evidence/bundle-stable.json
codexplusplus inspect-bundle --channel beta --out research/evidence/bundle-beta.json
codexplusplus diff-bundles research/evidence/bundle-stable.json research/evidence/bundle-beta.json
```

Captured fields:

- App version/build.
- Chunk names, sizes, import edges, string anchors.
- Presence/absence of source maps.
- Known surface selectors found.
- Electron/app-server channel constants found.

This should not store raw chunk contents.

### 5. Dev-Only Main-World Probe Loader

Impact: medium. Effort: medium. Confidence: medium. Dependency: preload
isolated-world bridge.

Provide allowlisted snippets for:

- Route trace.
- Event trace.
- Surface observer.
- Fiber summary.
- Resource/source-map probe.

Each snippet should have a `stop()` or `restore()` path, a max runtime, and
redacted output. This is safer than asking tweak authors to paste arbitrary
snippets into DevTools.

## Production Guidance

1. Use DOM observation and Codex++ owned roots for production UI.
2. Use React fiber for discovery and guarded diagnostics, not as a mutation
   interface.
3. Use app-server and preload bridges for stateful Codex integrations.
4. Use settings pages and overlay hosts for native-feeling UI before attempting
   deeper React insertion.
5. Treat minified bundle anchors as release-local evidence.
6. Keep renderer research artifacts redacted by default.
7. Validate across Stable and Beta because chunk hashes and possibly component
   boundaries differ.
8. When a feature can affect pixels, capture desktop and narrow screenshots as
   part of proof.

## Recommended Next Slice

Build a dev-only Renderer Inspector page in Codex++ Settings:

1. Add a surface observer with selector allowlist and redacted element
   descriptions.
2. Add fiber owner summaries using the existing React hook helpers.
3. Add route/history trace with restore support.
4. Add app-server event counts from the existing bridge boundary.
5. Add "copy redacted evidence" and save JSON under
   `research/evidence/renderer-inspector/`.
6. Test on both `/Applications/Codex.app` and `/Applications/Codex (Beta).app`
   with screenshots before exposing any public tweak API.
