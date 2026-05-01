import { onAppServerNotification, readHostId, requestAppServer } from "./app-server-bridge";

type GoalStatus = "active" | "paused" | "budgetLimited" | "complete";

interface ThreadGoal {
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

interface GoalUiAction {
  label: string;
  kind?: "primary" | "danger";
  run(): void | Promise<void>;
}

interface GoalPanelOptions {
  title: string;
  detail: string;
  footer?: string;
  actions: GoalUiAction[];
  persistent: boolean;
  error?: boolean;
}

interface GoalPanelState {
  collapsed: boolean;
  x: number | null;
  y: number | null;
  width: number | null;
  height: number | null;
}

interface GoalPanelDrag {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

interface GoalPanelResize {
  pointerId: number;
  startX: number;
  startY: number;
  width: number;
  height: number;
}

interface EditableTarget {
  element: HTMLElement;
  getText(): string;
  setText(value: string): void;
  clear(): void;
}

let started = false;
let root: HTMLDivElement | null = null;
let suggestionRoot: HTMLDivElement | null = null;
let currentGoal: ThreadGoal | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let lastThreadId: string | null = null;
let lastPanelOptions: GoalPanelOptions | null = null;
let panelDrag: GoalPanelDrag | null = null;
let panelResize: GoalPanelResize | null = null;

const GOAL_PANEL_STATE_KEY = "codexpp:goal-panel-state";
const GOAL_PANEL_MIN_WIDTH = 280;
const GOAL_PANEL_MIN_HEIGHT = 160;
const GOAL_PANEL_VIEWPORT_MARGIN = 8;
let panelState: GoalPanelState = readGoalPanelState();

export function startGoalFeature(log: (stage: string, extra?: unknown) => void = () => {}): void {
  if (started) return;
  started = true;
  installStyles();
  document.addEventListener("keydown", (event) => {
    void handleKeydown(event, log);
  }, true);
  document.addEventListener("input", (event) => {
    updateGoalSuggestion(findEditableTarget(event));
  }, true);
  document.addEventListener("focusin", (event) => {
    updateGoalSuggestion(findEditableTarget(event));
  }, true);
  document.addEventListener("click", (event) => {
    if (suggestionRoot?.contains(event.target as Node)) return;
    updateGoalSuggestion(findEditableTarget(event));
  }, true);
  window.addEventListener("resize", () => {
    if (!root?.isConnected) return;
    applyGoalPanelSize(root);
    clampGoalPanelToViewport(root);
    applyGoalPanelPosition(root);
  });
  onAppServerNotification((notification) => {
    if (notification.method === "thread/goal/updated" && isRecord(notification.params)) {
      const goal = notification.params.goal;
      if (isThreadGoal(goal)) {
        if (goal.threadId !== readThreadId()) return;
        currentGoal = goal;
        renderGoal(goal, { transient: false });
      }
      return;
    }
    if (notification.method === "thread/goal/cleared" && isRecord(notification.params)) {
      const threadId = notification.params.threadId;
      if (typeof threadId === "string" && threadId === readThreadId()) {
        currentGoal = null;
        renderNotice("Goal cleared", "This thread no longer has an active goal.");
      }
    }
  });

  window.addEventListener("popstate", () => refreshGoalForRoute(log));
  const refreshTimer = setInterval(() => refreshGoalForRoute(log), 2_500);
  const unref = (refreshTimer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(refreshTimer);
  queueMicrotask(() => refreshGoalForRoute(log));
  log("goal feature started");
}

async function handleKeydown(event: KeyboardEvent, log: (stage: string, extra?: unknown) => void): Promise<void> {
  if (event.isComposing) return;

  const editable = findEditableTarget(event);
  if (!editable) return;

  if (event.key === "Escape") {
    hideGoalSuggestion();
    return;
  }

  if ((event.key === "Tab" || event.key === "Enter") && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
    const suggestion = parseGoalSuggestion(editable.getText());
    if (suggestion && editable.getText().trim() !== "/goal") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      applyGoalSuggestion(editable);
      return;
    }
  }

  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;

  const parsed = parseGoalCommand(editable.getText());
  if (!parsed) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  editable.clear();
  hideGoalSuggestion();

  try {
    await runGoalCommand(parsed.args, log);
  } catch (error) {
    log("goal command failed", stringifyError(error));
    renderError("Goal command failed", friendlyGoalError(error));
  }
}

function parseGoalCommand(text: string): { args: string } | null {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { args: (match[1] ?? "").trim() };
}

function parseGoalSuggestion(text: string): { query: string } | null {
  const match = text.trim().match(/^\/([a-z]*)$/i);
  if (!match) return null;
  const query = match[1]?.toLowerCase() ?? "";
  return "goal".startsWith(query) ? { query } : null;
}

async function runGoalCommand(args: string, log: (stage: string, extra?: unknown) => void): Promise<void> {
  const threadId = readThreadId();
  if (!threadId) {
    renderError("No active thread", "Open a local thread before using /goal.");
    return;
  }
  const hostId = readHostId();
  const lower = args.toLowerCase();

  if (!args) {
    const goal = await getGoal(threadId, hostId);
    currentGoal = goal;
    if (goal) {
      renderGoal(goal, { transient: false });
    } else {
      renderNotice("No goal set", "Use /goal <objective> to set one for this thread.");
    }
    return;
  }

  if (lower === "clear") {
    const response = await requestAppServer<{ cleared: boolean }>(
      "thread/goal/clear",
      { threadId },
      { hostId },
    );
    currentGoal = null;
    renderNotice(response.cleared ? "Goal cleared" : "No goal set", "Use /goal <objective> to set a new goal.");
    return;
  }

  if (lower === "pause" || lower === "resume" || lower === "complete") {
    const status: GoalStatus = lower === "pause" ? "paused" : lower === "resume" ? "active" : "complete";
    const response = await requestAppServer<{ goal: ThreadGoal }>(
      "thread/goal/set",
      { threadId, status },
      { hostId },
    );
    currentGoal = response.goal;
    renderGoal(response.goal, { transient: false });
    return;
  }

  const existing = await getGoal(threadId, hostId);
  if (existing && existing.objective !== args) {
    const replace = await confirmReplaceGoal(existing, args);
    if (!replace) {
      currentGoal = existing;
      renderGoal(existing, { transient: false });
      return;
    }
  }

  const response = await requestAppServer<{ goal: ThreadGoal }>(
    "thread/goal/set",
    { threadId, objective: args, status: "active" },
    { hostId },
  );
  currentGoal = response.goal;
  log("goal set", { threadId });
  renderGoal(response.goal, { transient: false });
}

async function getGoal(threadId: string, hostId: string): Promise<ThreadGoal | null> {
  const response = await requestAppServer<{ goal: ThreadGoal | null }>(
    "thread/goal/get",
    { threadId },
    { hostId },
  );
  return response.goal;
}

async function refreshGoalForRoute(log: (stage: string, extra?: unknown) => void): Promise<void> {
  const threadId = readThreadId();
  if (!threadId) {
    if (lastThreadId !== null) {
      lastThreadId = null;
      currentGoal = null;
      hidePanel();
    }
    return;
  }
  if (threadId === lastThreadId) return;
  lastThreadId = threadId;
  try {
    const goal = await getGoal(threadId, readHostId());
    currentGoal = goal;
    if (goal) {
      renderGoal(goal, { transient: false });
    } else {
      hidePanel();
    }
  } catch (error) {
    // Old app-server builds do not know thread/goal/*. Keep the UI quiet until
    // the user explicitly types /goal, then show the actionable error.
    log("goal route refresh skipped", stringifyError(error));
  }
}

function confirmReplaceGoal(existing: ThreadGoal, nextObjective: string): Promise<boolean> {
  return new Promise((resolve) => {
    renderPanel({
      title: "Replace current goal?",
      detail: truncate(existing.objective, 180),
      footer: `New: ${truncate(nextObjective, 180)}`,
      actions: [
        {
          label: "Replace",
          kind: "primary",
          run: () => resolve(true),
        },
        {
          label: "Cancel",
          run: () => resolve(false),
        },
      ],
      persistent: true,
    });
  });
}

function renderGoal(goal: ThreadGoal, options: { transient: boolean }): void {
  const status = goalStatusLabel(goal.status);
  const budget = goal.tokenBudget == null
    ? `${formatNumber(goal.tokensUsed)} tokens`
    : `${formatNumber(goal.tokensUsed)} / ${formatNumber(goal.tokenBudget)} tokens`;
  renderPanel({
    title: `Goal ${status}`,
    detail: goal.objective,
    footer: `${budget} - ${formatDuration(goal.timeUsedSeconds)}`,
    actions: [
      goal.status === "paused"
        ? { label: "Resume", kind: "primary", run: () => updateGoalStatus("active") }
        : { label: "Pause", run: () => updateGoalStatus("paused") },
      { label: "Complete", run: () => updateGoalStatus("complete") },
      { label: "Clear", kind: "danger", run: () => clearCurrentGoal() },
    ],
    persistent: !options.transient,
  });
}

function renderNotice(title: string, detail: string): void {
  renderPanel({ title, detail, actions: [], persistent: false });
}

function renderError(title: string, detail: string): void {
  renderPanel({ title, detail, actions: [], persistent: false, error: true });
}

function renderPanel(options: GoalPanelOptions): void {
  lastPanelOptions = options;
  const el = ensureRoot();
  if (hideTimer) clearTimeout(hideTimer);
  el.innerHTML = "";
  el.className = `codexpp-goal-panel${options.error ? " is-error" : ""}${panelState.collapsed ? " is-collapsed" : ""}`;
  applyGoalPanelSize(el);
  applyGoalPanelPosition(el);

  const header = document.createElement("div");
  header.className = "codexpp-goal-header";
  header.addEventListener("pointerdown", startGoalPanelDrag);
  header.addEventListener("dblclick", resetGoalPanelPosition);

  const title = document.createElement("div");
  title.className = "codexpp-goal-title";
  title.textContent = options.title;

  const controls = document.createElement("div");
  controls.className = "codexpp-goal-controls";

  const collapse = document.createElement("button");
  collapse.className = "codexpp-goal-icon";
  collapse.type = "button";
  collapse.textContent = panelState.collapsed ? "+" : "-";
  collapse.setAttribute("aria-label", panelState.collapsed ? "Expand goal panel" : "Collapse goal panel");
  collapse.addEventListener("click", () => {
    panelState = { ...panelState, collapsed: !panelState.collapsed };
    saveGoalPanelState();
    if (lastPanelOptions) renderPanel(lastPanelOptions);
  });

  const close = document.createElement("button");
  close.className = "codexpp-goal-icon";
  close.type = "button";
  close.textContent = "x";
  close.setAttribute("aria-label", "Close goal panel");
  close.addEventListener("click", () => hidePanel());
  controls.append(collapse, close);
  header.append(title, controls);
  el.appendChild(header);

  if (panelState.collapsed) {
    el.style.display = "block";
    if (!options.persistent) {
      hideTimer = setTimeout(() => hidePanel(), 8_000);
    }
    return;
  }

  const detail = document.createElement("div");
  detail.className = "codexpp-goal-detail";
  detail.textContent = options.detail;

  el.appendChild(detail);

  if (options.footer) {
    const footer = document.createElement("div");
    footer.className = "codexpp-goal-footer";
    footer.textContent = options.footer;
    el.appendChild(footer);
  }

  if (options.actions.length > 0) {
    const actions = document.createElement("div");
    actions.className = "codexpp-goal-actions";
    for (const action of options.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.className = `codexpp-goal-action ${action.kind ?? ""}`;
      button.addEventListener("click", () => {
        Promise.resolve(action.run()).catch((error) => {
          renderError("Goal action failed", friendlyGoalError(error));
        });
      });
      actions.appendChild(button);
    }
    el.appendChild(actions);
  }

  const resize = document.createElement("button");
  resize.className = "codexpp-goal-resize";
  resize.type = "button";
  resize.setAttribute("aria-label", "Resize goal panel");
  resize.addEventListener("pointerdown", startGoalPanelResize);
  resize.addEventListener("keydown", handleGoalPanelResizeKeydown);
  resize.addEventListener("dblclick", resetGoalPanelSize);
  el.appendChild(resize);

  el.style.display = "block";
  if (!options.persistent) {
    hideTimer = setTimeout(() => hidePanel(), 8_000);
  }
}

async function updateGoalStatus(status: GoalStatus): Promise<void> {
  const threadId = readThreadId() ?? currentGoal?.threadId;
  if (!threadId) return;
  const response = await requestAppServer<{ goal: ThreadGoal }>(
    "thread/goal/set",
    { threadId, status },
    { hostId: readHostId() },
  );
  currentGoal = response.goal;
  renderGoal(response.goal, { transient: false });
}

async function clearCurrentGoal(): Promise<void> {
  const threadId = readThreadId() ?? currentGoal?.threadId;
  if (!threadId) return;
  await requestAppServer<{ cleared: boolean }>(
    "thread/goal/clear",
    { threadId },
    { hostId: readHostId() },
  );
  currentGoal = null;
  renderNotice("Goal cleared", "This thread no longer has an active goal.");
}

function ensureRoot(): HTMLDivElement {
  if (root?.isConnected) return root;
  root = document.createElement("div");
  root.id = "codexpp-goal-root";
  root.style.display = "none";
  const parent = document.body || document.documentElement;
  if (parent) parent.appendChild(root);
  return root;
}

function hidePanel(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (root) root.style.display = "none";
}

function startGoalPanelDrag(event: PointerEvent): void {
  if (event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest("button")) return;
  if (!root) return;
  const rect = root.getBoundingClientRect();
  panelDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
  };
  root.classList.add("is-dragging");
  event.preventDefault();
  window.addEventListener("pointermove", moveGoalPanel);
  window.addEventListener("pointerup", stopGoalPanelDrag);
}

function moveGoalPanel(event: PointerEvent): void {
  if (!panelDrag || event.pointerId !== panelDrag.pointerId || !root) return;
  panelState = {
    ...panelState,
    x: clamp(event.clientX - panelDrag.offsetX, 8, window.innerWidth - panelDrag.width - 8),
    y: clamp(event.clientY - panelDrag.offsetY, 8, window.innerHeight - panelDrag.height - 8),
  };
  applyGoalPanelPosition(root);
}

function stopGoalPanelDrag(event: PointerEvent): void {
  if (panelDrag && event.pointerId !== panelDrag.pointerId) return;
  window.removeEventListener("pointermove", moveGoalPanel);
  window.removeEventListener("pointerup", stopGoalPanelDrag);
  if (root) root.classList.remove("is-dragging");
  panelDrag = null;
  if (root) clampGoalPanelToViewport(root);
  saveGoalPanelState();
}

function startGoalPanelResize(event: PointerEvent): void {
  if (event.button !== 0 || panelState.collapsed) return;
  if (!root) return;
  const rect = root.getBoundingClientRect();
  ensureExplicitGoalPanelFrame(rect);
  panelResize = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    width: rect.width,
    height: rect.height,
  };
  root.classList.add("is-resizing");
  event.preventDefault();
  event.stopPropagation();
  window.addEventListener("pointermove", resizeGoalPanel);
  window.addEventListener("pointerup", stopGoalPanelResize);
}

function resizeGoalPanel(event: PointerEvent): void {
  if (!panelResize || event.pointerId !== panelResize.pointerId || !root) return;
  const maxWidth = goalPanelMaxWidth();
  const maxHeight = goalPanelMaxHeight();
  panelState = {
    ...panelState,
    width: clamp(panelResize.width + event.clientX - panelResize.startX, GOAL_PANEL_MIN_WIDTH, maxWidth),
    height: clamp(panelResize.height + event.clientY - panelResize.startY, GOAL_PANEL_MIN_HEIGHT, maxHeight),
  };
  applyGoalPanelSize(root);
  clampGoalPanelToViewport(root);
  applyGoalPanelPosition(root);
}

function stopGoalPanelResize(event: PointerEvent): void {
  if (panelResize && event.pointerId !== panelResize.pointerId) return;
  window.removeEventListener("pointermove", resizeGoalPanel);
  window.removeEventListener("pointerup", stopGoalPanelResize);
  if (root) root.classList.remove("is-resizing");
  panelResize = null;
  saveGoalPanelState();
}

function handleGoalPanelResizeKeydown(event: KeyboardEvent): void {
  if (panelState.collapsed || !root) return;
  const delta = event.shiftKey ? 32 : 12;
  let widthDelta = 0;
  let heightDelta = 0;
  if (event.key === "ArrowLeft") widthDelta = -delta;
  else if (event.key === "ArrowRight") widthDelta = delta;
  else if (event.key === "ArrowUp") heightDelta = -delta;
  else if (event.key === "ArrowDown") heightDelta = delta;
  else return;

  const rect = root.getBoundingClientRect();
  ensureExplicitGoalPanelFrame(rect);
  panelState = {
    ...panelState,
    width: clamp((panelState.width ?? rect.width) + widthDelta, GOAL_PANEL_MIN_WIDTH, goalPanelMaxWidth()),
    height: clamp((panelState.height ?? rect.height) + heightDelta, GOAL_PANEL_MIN_HEIGHT, goalPanelMaxHeight()),
  };
  event.preventDefault();
  event.stopPropagation();
  applyGoalPanelSize(root);
  clampGoalPanelToViewport(root);
  applyGoalPanelPosition(root);
  saveGoalPanelState();
}

function resetGoalPanelSize(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  panelState = { ...panelState, width: null, height: null };
  saveGoalPanelState();
  if (root) {
    applyGoalPanelSize(root);
    applyGoalPanelPosition(root);
  }
}

function resetGoalPanelPosition(event: MouseEvent): void {
  if (event.target instanceof Element && event.target.closest("button")) return;
  panelState = { ...panelState, x: null, y: null };
  saveGoalPanelState();
  if (root) applyGoalPanelPosition(root);
}

function ensureExplicitGoalPanelFrame(rect: DOMRect): void {
  if (panelState.x === null || panelState.y === null) {
    panelState = { ...panelState, x: rect.left, y: rect.top };
  }
  if (panelState.width === null || panelState.height === null) {
    panelState = { ...panelState, width: rect.width, height: rect.height };
  }
  if (root) {
    applyGoalPanelSize(root);
    applyGoalPanelPosition(root);
  }
}

function applyGoalPanelSize(element: HTMLElement): void {
  if (panelState.collapsed) {
    element.style.width = "";
    element.style.height = "";
    return;
  }

  if (panelState.width === null) {
    element.style.width = "";
  } else {
    element.style.width = `${clamp(panelState.width, GOAL_PANEL_MIN_WIDTH, goalPanelMaxWidth())}px`;
  }

  if (panelState.height === null) {
    element.style.height = "";
  } else {
    element.style.height = `${clamp(panelState.height, GOAL_PANEL_MIN_HEIGHT, goalPanelMaxHeight())}px`;
  }
}

function applyGoalPanelPosition(element: HTMLElement): void {
  if (panelState.x === null || panelState.y === null) {
    element.style.left = "auto";
    element.style.top = "auto";
    element.style.right = "18px";
    element.style.bottom = "76px";
    return;
  }
  clampGoalPanelToViewport(element);
  element.style.right = "auto";
  element.style.bottom = "auto";
  element.style.left = `${panelState.x}px`;
  element.style.top = `${panelState.y}px`;
}

function clampGoalPanelToViewport(element: HTMLElement): void {
  if (panelState.x === null || panelState.y === null) return;
  const rect = element.getBoundingClientRect();
  panelState = {
    ...panelState,
    x: clamp(panelState.x, GOAL_PANEL_VIEWPORT_MARGIN, window.innerWidth - rect.width - GOAL_PANEL_VIEWPORT_MARGIN),
    y: clamp(panelState.y, GOAL_PANEL_VIEWPORT_MARGIN, window.innerHeight - rect.height - GOAL_PANEL_VIEWPORT_MARGIN),
  };
}

function goalPanelMaxWidth(): number {
  const left = panelState.x ?? GOAL_PANEL_VIEWPORT_MARGIN;
  return Math.max(GOAL_PANEL_MIN_WIDTH, window.innerWidth - left - GOAL_PANEL_VIEWPORT_MARGIN);
}

function goalPanelMaxHeight(): number {
  const top = panelState.y ?? GOAL_PANEL_VIEWPORT_MARGIN;
  return Math.max(GOAL_PANEL_MIN_HEIGHT, window.innerHeight - top - GOAL_PANEL_VIEWPORT_MARGIN);
}

function readGoalPanelState(): GoalPanelState {
  try {
    const parsed = JSON.parse(localStorage.getItem(GOAL_PANEL_STATE_KEY) ?? "{}") as Partial<GoalPanelState>;
    return {
      collapsed: parsed.collapsed === true,
      x: typeof parsed.x === "number" && Number.isFinite(parsed.x) ? parsed.x : null,
      y: typeof parsed.y === "number" && Number.isFinite(parsed.y) ? parsed.y : null,
      width: typeof parsed.width === "number" && Number.isFinite(parsed.width) ? parsed.width : null,
      height: typeof parsed.height === "number" && Number.isFinite(parsed.height) ? parsed.height : null,
    };
  } catch {
    return { collapsed: false, x: null, y: null, width: null, height: null };
  }
}

function saveGoalPanelState(): void {
  try {
    localStorage.setItem(GOAL_PANEL_STATE_KEY, JSON.stringify(panelState));
  } catch {}
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function ensureSuggestionRoot(): HTMLDivElement | null {
  if (suggestionRoot?.isConnected) return suggestionRoot;
  const parent = document.body || document.documentElement;
  if (!parent) return null;
  suggestionRoot = document.createElement("div");
  suggestionRoot.id = "codexpp-goal-suggestion-root";
  suggestionRoot.style.display = "none";
  parent.appendChild(suggestionRoot);
  return suggestionRoot;
}

function updateGoalSuggestion(editable: EditableTarget | null): void {
  if (!editable) {
    hideGoalSuggestion();
    return;
  }
  const suggestion = parseGoalSuggestion(editable.getText());
  if (!suggestion) {
    hideGoalSuggestion();
    return;
  }
  renderGoalSuggestion(editable, suggestion.query);
}

function renderGoalSuggestion(editable: EditableTarget, query: string): void {
  const el = ensureSuggestionRoot();
  if (!el) return;
  const rect = editable.element.getBoundingClientRect();
  const width = Math.min(420, Math.max(280, rect.width || 320));
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const top = Math.max(12, rect.top - 66);

  el.innerHTML = "";
  el.className = "codexpp-goal-suggestion";
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${width}px`;

  const item = document.createElement("button");
  item.type = "button";
  item.className = "codexpp-goal-suggestion-item";
  item.setAttribute("aria-label", "Goal command");
  item.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyGoalSuggestion(editable);
  });

  const command = document.createElement("span");
  command.className = "codexpp-goal-suggestion-command";
  command.textContent = "/goal";
  if (query) {
    command.dataset.query = query;
  }

  const detail = document.createElement("span");
  detail.className = "codexpp-goal-suggestion-detail";
  detail.textContent = "Set, view, pause, resume, complete, or clear this thread goal";

  item.append(command, detail);
  el.appendChild(item);
  el.style.display = "block";
}

function applyGoalSuggestion(editable: EditableTarget): void {
  editable.setText("/goal ");
  hideGoalSuggestion();
}

function hideGoalSuggestion(): void {
  if (suggestionRoot) suggestionRoot.style.display = "none";
}

function installStyles(): void {
  if (document.getElementById("codexpp-goal-style")) return;
  const parent = document.head || document.documentElement;
  if (!parent) {
    document.addEventListener("DOMContentLoaded", () => installStyles(), { once: true });
    return;
  }

  const style = document.createElement("style");
  style.id = "codexpp-goal-style";
  style.textContent = `
#codexpp-goal-root {
  position: fixed;
  right: 18px;
  bottom: 76px;
  z-index: 2147483647;
  width: min(420px, calc(100vw - 36px));
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text-primary, #f5f7fb);
}
#codexpp-goal-suggestion-root {
  position: fixed;
  z-index: 2147483647;
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text-primary, #f5f7fb);
}
.codexpp-goal-suggestion {
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 8px;
  background: rgba(24, 27, 33, 0.98);
  box-shadow: 0 16px 46px rgba(0,0,0,0.32);
  overflow: hidden;
  backdrop-filter: blur(14px);
}
.codexpp-goal-suggestion-item {
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
  align-items: center;
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
}
.codexpp-goal-suggestion-item:hover,
.codexpp-goal-suggestion-item:focus-visible {
  background: rgba(255,255,255,0.09);
  outline: none;
}
.codexpp-goal-suggestion-command {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-weight: 650;
  color: #9fc5ff;
}
.codexpp-goal-suggestion-detail {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(245,247,251,0.72);
}
.codexpp-goal-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  position: fixed;
  border: 1px solid rgba(255,255,255,0.16);
  border-radius: 8px;
  background: rgba(26, 29, 35, 0.96);
  box-shadow: 0 18px 60px rgba(0,0,0,0.34);
  padding: 12px;
  backdrop-filter: blur(14px);
  overflow: hidden;
}
.codexpp-goal-panel:not(.is-collapsed) {
  min-width: 280px;
  min-height: 160px;
}
.codexpp-goal-panel.is-dragging {
  cursor: grabbing;
  user-select: none;
}
.codexpp-goal-panel.is-resizing {
  cursor: nwse-resize;
  user-select: none;
}
.codexpp-goal-panel.is-collapsed {
  width: min(320px, calc(100vw - 36px));
  min-height: 0;
  padding: 10px 12px;
}
.codexpp-goal-panel.is-error {
  border-color: rgba(255, 122, 122, 0.55);
}
.codexpp-goal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 650;
  cursor: grab;
  user-select: none;
}
.codexpp-goal-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codexpp-goal-controls {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
}
.codexpp-goal-icon {
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  line-height: 1;
}
.codexpp-goal-icon:hover {
  background: rgba(255,255,255,0.1);
}
.codexpp-goal-detail {
  margin-top: 8px;
  flex: 1 1 auto;
  min-height: 0;
  max-height: 96px;
  overflow: auto;
  color: rgba(245,247,251,0.9);
  word-break: break-word;
}
.codexpp-goal-panel[style*="height"] .codexpp-goal-detail {
  max-height: none;
}
.codexpp-goal-footer {
  flex: 0 0 auto;
  margin-top: 8px;
  color: rgba(245,247,251,0.62);
  font-size: 12px;
}
.codexpp-goal-actions {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.codexpp-goal-action {
  min-height: 28px;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 7px;
  background: rgba(255,255,255,0.08);
  color: inherit;
  padding: 4px 10px;
  cursor: pointer;
}
.codexpp-goal-action:hover {
  background: rgba(255,255,255,0.14);
}
.codexpp-goal-action.primary {
  border-color: rgba(125, 180, 255, 0.55);
  background: rgba(74, 121, 216, 0.42);
}
.codexpp-goal-action.danger {
  border-color: rgba(255, 122, 122, 0.48);
}
.codexpp-goal-resize {
  position: absolute;
  right: 2px;
  bottom: 2px;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: nwse-resize;
  opacity: 0.72;
}
.codexpp-goal-resize::before {
  content: "";
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 8px;
  height: 8px;
  border-right: 1px solid rgba(245,247,251,0.7);
  border-bottom: 1px solid rgba(245,247,251,0.7);
}
.codexpp-goal-resize:hover,
.codexpp-goal-resize:focus-visible {
  background: rgba(255,255,255,0.08);
  opacity: 1;
  outline: none;
}
`;
  parent.appendChild(style);
}

function findEditableTarget(event: Event): EditableTarget | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue;
    const editable = editableForElement(item);
    if (editable) return editable;
  }
  return event.target instanceof HTMLElement ? editableForElement(event.target) : null;
}

function editableForElement(element: HTMLElement): EditableTarget | null {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const type = element instanceof HTMLInputElement ? element.type : "textarea";
    if (!["text", "search", "textarea"].includes(type)) return null;
    return {
      element,
      getText: () => element.value,
      setText: (value) => {
        element.value = value;
        element.focus();
        try {
          element.setSelectionRange(value.length, value.length);
        } catch {}
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      },
      clear: () => {
        element.value = "";
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      },
    };
  }

  const editable = element.isContentEditable
    ? element
    : element.closest<HTMLElement>('[contenteditable="true"], [role="textbox"]');
  if (!editable) return null;
  return {
    element: editable,
    getText: () => editable.innerText || editable.textContent || "",
    setText: (value) => {
      editable.textContent = value;
      editable.focus();
      placeCaretAtEnd(editable);
      editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    },
    clear: () => {
      editable.textContent = "";
      editable.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    },
  };
}

function placeCaretAtEnd(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function readThreadId(): string | null {
  const candidates: string[] = [location.pathname, location.hash, location.href];
  try {
    const url = new URL(location.href);
    const initialRoute = url.searchParams.get("initialRoute");
    if (initialRoute) candidates.push(initialRoute);
  } catch {}
  candidates.push(...collectThreadRouteCandidates(history.state));
  candidates.push(...collectDomThreadCandidates());

  for (const candidate of candidates) {
    const threadId = normalizeThreadId(candidate);
    if (threadId) return threadId;
  }
  return null;
}

function normalizeThreadId(value: string): string | null {
  const decoded = safeDecode(value).trim();
  const routeMatch = decoded.match(/\/local\/([^/?#\s]+)/);
  if (routeMatch?.[1]) {
    const fromRoute = normalizeThreadIdToken(routeMatch[1]);
    if (fromRoute) return fromRoute;
  }

  const tokenMatch = decoded.match(/\b(?:[a-z][\w.-]*:)*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  if (tokenMatch?.[1]) return tokenMatch[1];

  return null;
}

function normalizeThreadIdToken(value: string): string | null {
  const decoded = safeDecode(value).trim();
  const match = decoded.match(/(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
}

function collectDomThreadCandidates(): string[] {
  const selectors = [
    '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]',
    '[data-app-action-sidebar-thread-row][aria-current="page"][data-app-action-sidebar-thread-id]',
    '[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]',
    '[data-app-action-sidebar-thread-id][aria-current="page"]',
  ];
  const candidates: string[] = [];
  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const value = element.getAttribute("data-app-action-sidebar-thread-id");
      if (value) candidates.push(value);
    }
  }
  return candidates;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectThreadRouteCandidates(value: unknown, depth = 0, seen = new Set<unknown>()): string[] {
  if (depth > 5 || value === null || value === undefined || seen.has(value)) return [];
  if (typeof value === "string") return normalizeThreadId(value) ? [value] : [];
  if (typeof value !== "object") return [];
  seen.add(value);

  const candidates: string[] = [];
  for (const child of Object.values(value as Record<string, unknown>)) {
    candidates.push(...collectThreadRouteCandidates(child, depth + 1, seen));
  }
  return candidates;
}

function goalStatusLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "budgetLimited":
      return "limited by budget";
    case "complete":
      return "complete";
  }
}

function friendlyGoalError(error: unknown): string {
  const message = stringifyError(error);
  if (/goals feature is disabled/i.test(message)) {
    return "The app-server has goal support, but [features].goals is disabled in ~/.codex/config.toml.";
  }
  if (/requires experimentalApi/i.test(message)) {
    return "The app-server rejected thread/goal/* because the active Desktop client did not negotiate experimentalApi.";
  }
  if (/unknown|unsupported|not found|no handler|invalid request|deserialize|thread\/goal/i.test(message)) {
    return "This Codex.app app-server does not support thread/goal/* yet. Update or repatch Codex.app with a build that includes the goals feature.";
  }
  return message;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (minutes <= 0) return `${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${remainingSeconds}s`;
  return `${hours}h ${remainingMinutes}m`;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isThreadGoal(value: unknown): value is ThreadGoal {
  return isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.objective === "string" &&
    typeof value.status === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
