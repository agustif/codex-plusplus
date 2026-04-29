/**
 * Public SDK for codex-plusplus tweak authors.
 *
 * A tweak is an ES module that default-exports an object satisfying `Tweak`.
 * The runtime calls `start(api)` after the app's settings UI is ready, and
 * `stop()` when the tweak is disabled or the app is shutting down.
 */

export interface TweakManifest {
  /** Reverse-DNS-ish unique id, e.g. "com.you.my-tweak". */
  id: string;
  /** Short human-readable name shown in the Tweaks list. */
  name: string;
  /** Semver version of this tweak. */
  version: string;
  /**
   * Required source repository in `owner/repo` form. Codex++ checks this
   * repository's latest GitHub release once per day and only reports update
   * availability; it never downloads or installs tweak updates automatically.
   */
  githubRepo: string;
  /** Free-form one-liner description. Renders below the name. */
  description?: string;
  /** Author info. Either a string (display name) or a structured record. */
  author?: string | TweakAuthor;
  /** Homepage / source repo URL (rendered as a link in the Tweaks list). */
  homepage?: string;
  /**
   * Icon shown next to the tweak's name. Supports:
   *   - `https://…` URL
   *   - `./path/relative/to/manifest.png` (resolved against the tweak dir)
   *   - data: URL
   * If absent, a generated initial avatar is rendered.
   */
  iconUrl?: string;
  /** Optional tags, e.g. `["ui", "shortcut"]`. */
  tags?: string[];
  /** Semver range of runtime versions this tweak supports. */
  minRuntime?: string;
  /** Optional. If set, the tweak is sandboxed to renderer-only or main-only. */
  scope?: "renderer" | "main" | "both";
  /** Optional path to entry; defaults to `index.js`/`index.mjs`/`index.cjs`. */
  main?: string;
}

export interface TweakAuthor {
  name: string;
  url?: string;
  email?: string;
}

export interface Tweak {
  start(api: TweakApi): void | Promise<void>;
  stop?(): void | Promise<void>;
}

/**
 * The API surface passed to a tweak's `start()`. Renderer-only tweaks see the
 * renderer half; main-only tweaks see the main half. `scope: "both"` tweaks
 * receive whichever half is active in the current process.
 */
export interface TweakApi {
  /** Manifest as parsed from disk. Read-only. */
  manifest: Readonly<TweakManifest>;
  /** Per-tweak persistent KV store, scoped to this tweak's id. */
  storage: TweakStorage;
  /** Per-tweak logger; output goes to the codex-plusplus log file + devtools. */
  log: TweakLogger;
  /** Process this tweak is running in. */
  process: "renderer" | "main";

  /** Renderer-only: register UI in Codex's Settings panel. */
  settings?: SettingsApi;
  /** Renderer-only: React fiber utilities for advanced injection. */
  react?: ReactApi;
  /** Cross-process IPC scoped to this tweak's id. */
  ipc: TweakIpc;
  /** Filesystem helpers, sandboxed to the tweak's data dir. */
  fs: TweakFs;
  /** Main-only: native Codex integration points exposed by Codex++. */
  codex?: CodexApi;
}

export interface TweakStorage {
  get<T = unknown>(key: string, fallback?: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}

export interface TweakLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface SettingsApi {
  /**
   * Register a section in the Codex++ "Tweaks" page. The section appears as
   * a row beneath the tweak's own card. Use this for small per-tweak knobs.
   */
  register(section: SettingsSection): SettingsHandle;

  /**
   * Register a *dedicated settings page* for this tweak. The page gets its
   * own entry in the Codex sidebar (under a "TWEAKS" group header that
   * appears only when at least one tweak has registered a page).
   *
   * Use this when your tweak is large enough that a single row is cramped.
   * Inside `render(root)` you can mount any DOM you like — see the
   * components in `tweaks/AGENTS.md`.
   */
  registerPage(page: SettingsPage): SettingsHandle;
}

export interface SettingsSection {
  id: string;
  title: string;
  description?: string;
  /** Imperative render. Called when the section is mounted. */
  render(root: HTMLElement): void | (() => void);
}

export interface SettingsPage {
  /** Stable id, scoped to the tweak. Becomes part of the sidebar key. */
  id: string;
  /** Sidebar label, also shown as the page heading. */
  title: string;
  /** Optional subtitle below the page heading. */
  description?: string;
  /**
   * Optional 20×20 currentColor SVG markup for the sidebar item icon.
   * If omitted, the tweak's manifest icon (or initial avatar) is used.
   */
  iconSvg?: string;
  /** Imperative render into the page body. May return a teardown fn. */
  render(root: HTMLElement): void | (() => void);
}

export interface SettingsHandle {
  unregister(): void;
}

export interface ReactApi {
  /**
   * Locate a React fiber by walking from a DOM node. Returns null if the
   * node isn't part of Codex's React tree.
   */
  getFiber(node: Element): ReactFiberNode | null;
  /** Find the nearest fiber whose `type` (component) name matches. */
  findOwnerByName(node: Element, name: string): ReactFiberNode | null;
  /** Wait for an element matching `selector` to exist in the DOM. */
  waitForElement(selector: string, timeoutMs?: number): Promise<Element>;
}

/** Minimal subset of React's internal fiber shape we expose. */
export interface ReactFiberNode {
  type: unknown;
  stateNode: unknown;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: unknown;
  return: ReactFiberNode | null;
  child: ReactFiberNode | null;
  sibling: ReactFiberNode | null;
}

export interface TweakIpc {
  on(channel: string, handler: (...args: unknown[]) => void): () => void;
  send(channel: string, ...args: unknown[]): void;
  /** Renderer ↔ main round-trip; resolves with the handler's return value. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  /** Main-side: handle invokes from the renderer. */
  handle?(channel: string, handler: (...args: unknown[]) => unknown): void;
}

export interface TweakFs {
  /** Absolute path to this tweak's writable data dir. */
  dataDir: string;
  read(relPath: string): Promise<string>;
  write(relPath: string, contents: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
}

export interface CodexApi {
  /**
   * Main-only: create an embedded BrowserView registered with Codex's host
   * context. The returned object is Electron's BrowserView in the main
   * process, typed as unknown so renderer-only tweak bundles do not need
   * Electron types.
   */
  createBrowserView(options: CodexCreateViewOptions): Promise<unknown>;

  /**
   * Create a Codex-registered native window for an in-app route.
   *
   * The returned window is registered with Codex's own host/app-server
   * context, so routes such as `/local/<conversation-id>` render the native
   * chat UI instead of a detached shell.
   */
  createWindow(options: CodexCreateWindowOptions): Promise<CodexWindowRef>;
}

export interface CodexCreateWindowOptions {
  /** Absolute Codex route, e.g. `/local/<conversation-id>` or `/`. */
  route: string;
  /** Host id. Defaults to `local`. */
  hostId?: string;
  /** Show the window after creating it. Defaults to true. */
  show?: boolean;
  /** Native Codex window appearance. Defaults to `secondary`. */
  appearance?: string;
  /** Parent BrowserWindow id. Defaults to the focused window when available. */
  parentWindowId?: number;
  /** Optional initial bounds in screen coordinates. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface CodexCreateViewOptions {
  /** Absolute Codex route, e.g. `/local/<conversation-id>` or `/`. */
  route: string;
  /** Host id. Defaults to `local`. */
  hostId?: string;
  /** Native Codex appearance token used for registration. */
  appearance?: string;
}

export interface CodexWindowRef {
  windowId: number;
  webContentsId: number;
}

/** Helper to give authors type inference without `satisfies`. */
export function defineTweak(tweak: Tweak): Tweak {
  return tweak;
}
