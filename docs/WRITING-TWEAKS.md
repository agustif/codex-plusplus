# Writing tweaks

A tweak is a folder containing `manifest.json` and an entry script. Drop it into your tweaks dir:

- macOS: `~/Library/Application Support/codex-plusplus/tweaks/`
- Linux: `~/.local/share/codex-plusplus/tweaks/`
- Windows: `%APPDATA%/codex-plusplus/tweaks/`

…then reload Codex (Cmd/Ctrl+R in the window, or restart the app). The Tweak Manager (in Settings → Tweaks) shows everything that loaded.

## Minimal example

```
my-tweak/
├── manifest.json
└── index.js
```

`manifest.json`:

```json
{
  "id": "com.you.my-tweak",
  "name": "My Tweak",
  "version": "0.1.0",
  "githubRepo": "you/my-tweak",
  "description": "Does a thing.",
  "scope": "renderer"
}
```

`index.js`:

```js
module.exports = {
  start(api) {
    api.settings.register({
      id: "main",
      title: "My Tweak",
      render(root) {
        root.innerHTML = "<p>hello</p>";
      },
    });
  },
  stop() {},
};
```

## Manifest fields

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Reverse-DNS-ish unique id. |
| `name` | yes | Human display name. |
| `version` | yes | Semver. |
| `githubRepo` | yes | GitHub repository in `owner/repo` form. Used for daily release checks. |
| `author` | no | Free-form. |
| `description` | no | One-liner shown in the manager. |
| `scope` | no | `"renderer"` (default), `"main"`, or `"both"`. |
| `main` | no | Entry filename. Defaults to `index.js`/`.cjs`/`.mjs`. |
| `minRuntime` | no | Semver of the minimum runtime your tweak needs. |

## Update checks

Codex++ checks `https://api.github.com/repos/<owner>/<repo>/releases/latest` at most once per day per tweak. If the latest release tag is a higher semver than `version`, the Tweaks page shows **Update Available** and links to the GitHub release.

Updates are never installed automatically. Users should review release notes, code changes, and repository ownership before manually replacing local tweak files.

## API surface

Your tweak default-exports `{ start(api), stop?() }`. The shape of `api` depends on `scope`:

- **renderer**: `api.settings`, `api.react`, `api.ipc`, `api.fs`, `api.storage`, `api.log`, and `api.git` when the manifest declares `git.metadata`
- **main**: `api.ipc.handle`, `api.fs`, `api.storage`, `api.log`, `api.git`
- **both**: `start(api)` is called once per process; check `api.process` to disambiguate

### Settings (renderer)

```ts
api.settings.register({
  id: "section-id",
  title: "Visible title",
  description: "Optional subtitle",
  render(root) {
    // imperatively populate the root element however you like.
    // return a cleanup function or void.
  },
});
```

Each registered section becomes a row inside Codex's Settings → Tweaks tab.

### React fiber utilities (renderer)

```ts
const fiber = api.react.getFiber(domNode);          // null if not React
const card  = api.react.findOwnerByName(node, "Card"); // by component displayName/name
const el    = await api.react.waitForElement("[data-testid=foo]", 5000);
```

These let you reach into Codex's React tree for advanced injection (reading props, locating a specific component instance). We deliberately do not give you a React reference — render your own UI imperatively or with your own bundled framework.

### Storage

Per-tweak namespaced KV. Renderer storage uses `localStorage`; main storage is currently in-memory (will move to `<userRoot>/storage/<id>.json` in a future release).

```ts
api.storage.set("foo", 42);
api.storage.get("foo", 0);
```

### IPC

Channels are namespaced by tweak id. Renderer:

```ts
const off = api.ipc.on("event", (...args) => {});
api.ipc.send("event", payload);
const result = await api.ipc.invoke("compute", input);
```

Main:

```ts
api.ipc.handle("compute", (input) => /* ... */);
```

### Git metadata

Declare the metadata-only git permission before using `api.git` from renderer tweaks:

```json
{
  "permissions": ["git.metadata"]
}
```

```ts
const status = await api.git.getStatus("/path/to/repo");
const worktrees = await api.git.getWorktrees(status.repository.root);
```

The git API returns branch, dirty entries, diff counts, and worktree metadata. It intentionally does not return raw diff hunks, file contents, remote credentials, or ignored file trees by default. Main process owns the git subprocess work and uses bounded `git` invocations with timeouts; renderer tweaks only receive structured metadata over IPC.

### Filesystem sandbox

Each tweak gets its own writable directory at `<userRoot>/tweak-data/<id>/`. Use `api.fs.read/write/exists` to access it.

## Lifecycle

- `start(api)` is called once after the runtime decides this tweak should run. For renderer tweaks, this is after the page's DOM is ready.
- `stop()` is called on:
  - app shutdown (main side)
  - the user disabling the tweak (planned)
  - hot reload (planned)

Make `stop()` idempotent. Clean up DOM nodes you added, IPC listeners, timers.

## TypeScript

If you want type checking, install the SDK and import types:

```sh
npm i -D @codex-plusplus/sdk
```

```ts
import { defineTweak } from "@codex-plusplus/sdk";

export default defineTweak({
  start(api) { /* ... */ },
  stop() {},
});
```

You'll need to bundle/transpile to JS yourself before dropping into the tweaks dir. The runtime does not transpile TS.

## Patterns

### Wait for a Codex element to exist

```ts
const composer = await api.react.waitForElement("[data-testid='composer']");
composer.style.outline = "2px solid hotpink";
```

### Read props from a Codex component

```ts
const node = document.querySelector("[data-testid='message-row']");
const fiber = api.react.getFiber(node);
console.log(fiber?.memoizedProps);
```

### Replace a button's behavior

```ts
const btn = await api.react.waitForElement("button[aria-label='Send']");
const clone = btn.cloneNode(true);
btn.replaceWith(clone);
clone.addEventListener("click", (e) => { /* your behavior */ }, true);
```

### Add a global keybind

```ts
addEventListener("keydown", (e) => {
  if (e.metaKey && e.shiftKey && e.key === "K") doThing();
});
```

## Debugging

- Open DevTools (View menu, or the Codex command palette).
- Filter console for `[codex-plusplus]`.
- Check `<userRoot>/log/main.log` for main-process errors.
- `codex-plusplus doctor` from a terminal for installer/integrity issues.
