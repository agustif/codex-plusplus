import { ipcRenderer } from "electron";
import type {
  GitDiffSummary,
  GitStatus,
  GitStatusEntry,
  GitWorktree,
} from "@codex-plusplus/sdk";

const PROJECT_ROW_SELECTOR =
  "[data-app-action-sidebar-project-row][data-app-action-sidebar-project-id]";
const ACTIVE_THREAD_SELECTOR =
  "[data-app-action-sidebar-thread-active='true'],[data-app-action-sidebar-thread-active=true]";
const PROJECT_LIST_SELECTOR = "[data-app-action-sidebar-project-list-id]";
const SUMMARY_ATTR = "data-codexpp-git-summary";
const BADGE_ATTR = "data-codexpp-git-badge";
const STYLE_ID = "codexpp-git-sidebar-style";
const REFRESH_DEBOUNCE_MS = 250;
const STATUS_TTL_MS = 10_000;
const DETAILS_TTL_MS = 15_000;
const MAX_VISIBLE_PROJECT_BADGES = 16;
const MAX_CHANGED_FILES = 7;
const MAX_WORKTREE_ROWS = 3;

interface ProjectRow {
  row: HTMLElement;
  group: HTMLElement | null;
  path: string;
  label: string;
}

interface StatusCacheEntry {
  value: GitStatus | null;
  error: string | null;
  loadedAt: number;
  pending: Promise<GitStatus | null> | null;
}

interface DetailsCacheEntry {
  value: GitDetails | null;
  error: string | null;
  loadedAt: number;
  pending: Promise<GitDetails | null> | null;
}

interface GitDetails {
  diff: GitDiffSummary;
  worktrees: GitWorktree[];
}

interface GitSidebarState {
  observer: MutationObserver | null;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  interval: ReturnType<typeof setInterval> | null;
  runId: number;
  statusCache: Map<string, StatusCacheEntry>;
  detailsCache: Map<string, DetailsCacheEntry>;
}

const state: GitSidebarState = {
  observer: null,
  refreshTimer: null,
  interval: null,
  runId: 0,
  statusCache: new Map(),
  detailsCache: new Map(),
};

export function startGitSidebar(): void {
  if (state.observer) return;

  installStyles();

  const observer = new MutationObserver((mutations) => {
    if (mutations.some(shouldReactToMutation)) {
      scheduleRefresh("mutation");
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-app-action-sidebar-thread-active",
      "data-app-action-sidebar-project-collapsed",
      "data-app-action-sidebar-project-id",
      "data-app-action-sidebar-project-row",
    ],
  });
  state.observer = observer;
  state.interval = setInterval(() => scheduleRefresh("interval"), 15_000);
  window.addEventListener("focus", onWindowFocus);
  scheduleRefresh("boot");
}

function onWindowFocus(): void {
  scheduleRefresh("focus");
}

function shouldReactToMutation(mutation: MutationRecord): boolean {
  if (mutation.type === "attributes") {
    const target = mutation.target;
    return target instanceof Element && (
      target.matches(PROJECT_ROW_SELECTOR) ||
      target.matches(ACTIVE_THREAD_SELECTOR) ||
      target.hasAttribute("data-app-action-sidebar-project-list-id")
    );
  }
  for (const node of Array.from(mutation.addedNodes)) {
    if (nodeContainsSidebarProject(node)) return true;
  }
  for (const node of Array.from(mutation.removedNodes)) {
    if (nodeContainsSidebarProject(node)) return true;
  }
  return false;
}

function nodeContainsSidebarProject(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  return node.matches(PROJECT_ROW_SELECTOR) || Boolean(node.querySelector(PROJECT_ROW_SELECTOR));
}

function scheduleRefresh(_reason: string): void {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
}

async function refresh(): Promise<void> {
  const runId = ++state.runId;
  const projects = collectProjectRows();
  if (projects.length === 0) {
    removeSummaryPanel();
    return;
  }

  const activePath = getActiveProjectPath(projects);
  const activeProject =
    (activePath ? projects.find((project) => project.path === activePath) : null) ??
    projects.find((project) => project.row.getAttribute("data-app-action-sidebar-project-collapsed") === "false") ??
    projects[0];

  const badgeProjects = prioritizeBadgeProjects(projects, activeProject);
  const badgeStatuses = await Promise.all(
    badgeProjects.map(async (project) => {
      const status = await getStatus(project.path);
      return { project, status };
    }),
  );
  if (runId !== state.runId) return;
  for (const { project, status } of badgeStatuses) {
    renderProjectBadge(project, status);
  }

  const summaryProject =
    badgeStatuses.find(({ project, status }) => project.path === activeProject?.path && isUsableRepo(status))
      ?.project ??
    badgeStatuses.find(({ status }) => isUsableRepo(status))?.project ??
    activeProject;

  if (!summaryProject) {
    removeSummaryPanel();
    return;
  }

  const [status, details] = await Promise.all([
    getStatus(summaryProject.path),
    getDetails(summaryProject.path),
  ]);
  if (runId !== state.runId) return;
  renderSummaryPanel(summaryProject, status, details);
}

function collectProjectRows(): ProjectRow[] {
  const seen = new Set<string>();
  const rows: ProjectRow[] = [];
  for (const row of Array.from(document.querySelectorAll<HTMLElement>(PROJECT_ROW_SELECTOR))) {
    const path = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    rows.push({
      row,
      path,
      label: row.getAttribute("data-app-action-sidebar-project-label")?.trim() || basename(path),
      group: findProjectGroup(row),
    });
  }
  return rows;
}

function findProjectGroup(row: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = row.parentElement;
  while (current && current !== document.body) {
    if (current.getAttribute("role") === "listitem" && current.textContent?.includes(row.textContent ?? "")) {
      return current;
    }
    if (current.querySelector(PROJECT_ROW_SELECTOR) === row && current.querySelector(PROJECT_LIST_SELECTOR)) {
      return current;
    }
    current = current.parentElement;
  }
  return row.parentElement;
}

function getActiveProjectPath(projects: ProjectRow[]): string | null {
  const activeThread = document.querySelector<HTMLElement>(ACTIVE_THREAD_SELECTOR);
  const projectList = activeThread?.closest<HTMLElement>(PROJECT_LIST_SELECTOR);
  const listPath = projectList?.getAttribute("data-app-action-sidebar-project-list-id")?.trim();
  if (listPath) return listPath;

  const expanded = projects.find(
    (project) => project.row.getAttribute("data-app-action-sidebar-project-collapsed") === "false",
  );
  return expanded?.path ?? null;
}

function prioritizeBadgeProjects(projects: ProjectRow[], activeProject: ProjectRow | undefined): ProjectRow[] {
  const visible = projects.filter((project) => {
    const rect = project.row.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
  });
  const ordered = activeProject
    ? [activeProject, ...visible.filter((project) => project.path !== activeProject.path)]
    : visible;
  return ordered.slice(0, MAX_VISIBLE_PROJECT_BADGES);
}

async function getStatus(path: string): Promise<GitStatus | null> {
  const now = Date.now();
  const cached = state.statusCache.get(path);
  if (cached?.value && now - cached.loadedAt < STATUS_TTL_MS) return cached.value;
  if (cached?.pending) return cached.pending;

  const entry: StatusCacheEntry = cached ?? {
    value: null,
    error: null,
    loadedAt: 0,
    pending: null,
  };
  entry.pending = ipcRenderer
    .invoke("codexpp:git-status", path)
    .then((status) => {
      entry.value = status as GitStatus;
      entry.error = null;
      entry.loadedAt = Date.now();
      return entry.value;
    })
    .catch((error: unknown) => {
      entry.error = error instanceof Error ? error.message : String(error);
      entry.loadedAt = Date.now();
      return null;
    })
    .finally(() => {
      entry.pending = null;
    });
  state.statusCache.set(path, entry);
  return entry.pending;
}

async function getDetails(path: string): Promise<GitDetails | null> {
  const now = Date.now();
  const cached = state.detailsCache.get(path);
  if (cached?.value && now - cached.loadedAt < DETAILS_TTL_MS) return cached.value;
  if (cached?.pending) return cached.pending;

  const entry: DetailsCacheEntry = cached ?? {
    value: null,
    error: null,
    loadedAt: 0,
    pending: null,
  };
  entry.pending = Promise.all([
    ipcRenderer.invoke("codexpp:git-diff-summary", path) as Promise<GitDiffSummary>,
    ipcRenderer.invoke("codexpp:git-worktrees", path) as Promise<GitWorktree[]>,
  ])
    .then(([diff, worktrees]) => {
      entry.value = { diff, worktrees };
      entry.error = null;
      entry.loadedAt = Date.now();
      return entry.value;
    })
    .catch((error: unknown) => {
      entry.error = error instanceof Error ? error.message : String(error);
      entry.loadedAt = Date.now();
      return null;
    })
    .finally(() => {
      entry.pending = null;
    });
  state.detailsCache.set(path, entry);
  return entry.pending;
}

function renderProjectBadge(project: ProjectRow, status: GitStatus | null): void {
  if (!isUsableRepo(status)) {
    project.row.querySelector(`[${BADGE_ATTR}]`)?.remove();
    return;
  }

  const badge = ensureBadge(project.row);
  const dirty = countDirty(status.entries);
  const conflicts = countConflicts(status.entries);
  const branch = branchLabel(status);
  const sync = syncLabel(status);
  badge.classList.toggle("codexpp-git-badge-dirty", dirty > 0);
  badge.classList.toggle("codexpp-git-badge-conflict", conflicts > 0);
  badge.title = [
    `${project.label}: ${branch}`,
    dirty === 0 ? "clean" : `${dirty} changed`,
    conflicts > 0 ? `${conflicts} conflict${plural(conflicts)}` : "",
    sync.title,
  ].filter(Boolean).join(", ");
  badge.textContent = [branch, dirty > 0 ? String(dirty) : "", sync.short].filter(Boolean).join(" ");
}

function ensureBadge(row: HTMLElement): HTMLElement {
  const existing = row.querySelector<HTMLElement>(`[${BADGE_ATTR}]`);
  if (existing) return existing;

  const badge = document.createElement("span");
  badge.setAttribute(BADGE_ATTR, "");
  badge.className = "codexpp-git-project-badge";
  row.appendChild(badge);
  return badge;
}

function renderSummaryPanel(project: ProjectRow, status: GitStatus | null, details: GitDetails | null): void {
  if (!isUsableRepo(status)) {
    removeSummaryPanel();
    return;
  }

  const host = project.group ?? project.row.parentElement;
  if (!host) return;

  const panel = ensureSummaryPanel(host, project.row);
  clear(panel);

  const dirty = countDirty(status.entries);
  const counts = countStatus(status.entries);
  const branch = branchLabel(status);
  const sync = syncLabel(status);
  const diff = details?.diff ?? null;
  const worktrees = details?.worktrees ?? [];

  const header = el("div", "codexpp-git-summary-header");
  const title = el("div", "codexpp-git-summary-title");
  title.append(textEl("span", "Git"));
  title.append(textEl("strong", branch));
  if (sync.short) title.append(textEl("span", sync.short));
  const stateChip = textEl("span", dirty === 0 ? "clean" : `${dirty} changed`);
  stateChip.className = `codexpp-git-summary-state ${dirty === 0 ? "is-clean" : "is-dirty"}`;
  header.append(title, stateChip);
  panel.append(header);

  const metrics = el("div", "codexpp-git-summary-metrics");
  metrics.append(
    metric("staged", counts.staged),
    metric("unstaged", counts.unstaged),
    metric("untracked", counts.untracked),
    metric("conflicts", counts.conflicts),
  );
  panel.append(metrics);

  if (diff) {
    const diffLine = el("div", "codexpp-git-summary-line");
    diffLine.append(
      textEl("span", `${diff.fileCount} file${plural(diff.fileCount)}`),
      textEl("span", `+${diff.insertions}`),
      textEl("span", `-${diff.deletions}`),
      ...(diff.truncated ? [textEl("span", "truncated")] : []),
    );
    panel.append(diffLine);
  }

  const changed = status.entries.filter((entry) => entry.kind !== "ignored").slice(0, MAX_CHANGED_FILES);
  if (changed.length > 0) {
    const list = el("div", "codexpp-git-changed-files");
    for (const entry of changed) {
      const row = el("div", "codexpp-git-file-row");
      row.append(textEl("span", entryLabel(entry)), textEl("span", entryPath(entry)));
      list.append(row);
    }
    if (status.entries.length > changed.length) {
      const more = textEl("div", `+${status.entries.length - changed.length} more`);
      more.className = "codexpp-git-more";
      list.append(more);
    }
    panel.append(list);
  }

  if (worktrees.length > 1) {
    const worktreeList = el("div", "codexpp-git-worktrees");
    const label = textEl("div", `${worktrees.length} worktrees`);
    label.className = "codexpp-git-worktrees-label";
    worktreeList.append(label);
    for (const worktree of worktrees.slice(0, MAX_WORKTREE_ROWS)) {
      const row = el("div", "codexpp-git-worktree-row");
      row.append(
        textEl("span", worktree.branch ?? shortSha(worktree.head) ?? "detached"),
        textEl("span", basename(worktree.path)),
      );
      worktreeList.append(row);
    }
    panel.append(worktreeList);
  }

  const issue = status.repository.error?.message || state.statusCache.get(project.path)?.error || state.detailsCache.get(project.path)?.error;
  if (issue) {
    const warning = textEl("div", issue);
    warning.className = "codexpp-git-warning";
    panel.append(warning);
  }
}

function isUsableRepo(status: GitStatus | null): status is GitStatus {
  return Boolean(status?.repository.found && status.repository.isInsideWorkTree);
}

function ensureSummaryPanel(host: HTMLElement, row: HTMLElement): HTMLElement {
  let panel = document.querySelector<HTMLElement>(`[${SUMMARY_ATTR}]`);
  if (!panel) {
    panel = document.createElement("section");
    panel.setAttribute(SUMMARY_ATTR, "");
    panel.className = "codexpp-git-summary";
  }

  if (panel.parentElement !== host) {
    panel.remove();
    host.insertBefore(panel, row.nextElementSibling);
  } else if (panel.previousElementSibling !== row) {
    host.insertBefore(panel, row.nextElementSibling);
  }

  return panel;
}

function removeSummaryPanel(): void {
  document.querySelector(`[${SUMMARY_ATTR}]`)?.remove();
}

function countStatus(entries: GitStatusEntry[]): {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
} {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const entry of entries) {
    switch (entry.kind) {
      case "ordinary":
      case "rename":
        if (entry.index !== ".") staged++;
        if (entry.worktree !== ".") unstaged++;
        break;
      case "untracked":
        untracked++;
        break;
      case "unmerged":
        conflicts++;
        break;
      case "ignored":
        break;
    }
  }
  return { staged, unstaged, untracked, conflicts };
}

function countDirty(entries: GitStatusEntry[]): number {
  return entries.filter((entry) => entry.kind !== "ignored").length;
}

function countConflicts(entries: GitStatusEntry[]): number {
  return entries.filter((entry) => entry.kind === "unmerged").length;
}

function branchLabel(status: GitStatus): string {
  return (
    status.branch.head ??
    status.repository.headBranch ??
    shortSha(status.branch.oid) ??
    shortSha(status.repository.headSha) ??
    "detached"
  );
}

function syncLabel(status: GitStatus): { short: string; title: string } {
  const ahead = status.branch.ahead ?? 0;
  const behind = status.branch.behind ?? 0;
  const short = [ahead > 0 ? `A${ahead}` : "", behind > 0 ? `B${behind}` : ""]
    .filter(Boolean)
    .join("/");
  const title = [
    ahead > 0 ? `${ahead} ahead` : "",
    behind > 0 ? `${behind} behind` : "",
    status.branch.upstream ? `upstream ${status.branch.upstream}` : "",
  ].filter(Boolean).join(", ");
  return { short, title };
}

function entryLabel(entry: GitStatusEntry): string {
  switch (entry.kind) {
    case "ordinary":
      return `${entry.index}${entry.worktree}`.replaceAll(".", "");
    case "rename":
      return "R";
    case "unmerged":
      return "UU";
    case "untracked":
      return "??";
    case "ignored":
      return "!!";
  }
}

function entryPath(entry: GitStatusEntry): string {
  if (entry.kind === "rename") return `${entry.originalPath} -> ${entry.path}`;
  return entry.path;
}

function metric(label: string, value: number): HTMLElement {
  const item = el("div", "codexpp-git-metric");
  item.append(textEl("span", String(value)), textEl("span", label));
  return item;
}

function shortSha(sha: string | null | undefined): string | null {
  return sha ? sha.slice(0, 7) : null;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.firstChild.remove();
}

function el(tag: "div" | "section", className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function textEl(tag: "div" | "span" | "strong", text: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .codexpp-git-project-badge {
      align-items: center;
      border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      border-radius: 5px;
      color: var(--text-tertiary, currentColor);
      display: inline-flex;
      flex: 0 1 auto;
      font: 500 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      gap: 3px;
      letter-spacing: 0;
      margin-left: 6px;
      max-width: 48%;
      min-width: 0;
      opacity: 0.72;
      overflow: hidden;
      padding: 2px 4px;
      pointer-events: none;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .codexpp-git-project-badge.codexpp-git-badge-dirty {
      border-color: color-mix(in srgb, var(--codexpp-project-tint, currentColor) 42%, transparent);
      color: var(--codexpp-project-text-color, currentColor);
      opacity: 0.94;
    }
    .codexpp-git-project-badge.codexpp-git-badge-conflict {
      border-color: rgba(220, 38, 38, 0.65);
      color: rgb(220, 38, 38);
    }
    .codexpp-git-summary {
      border-left: 2px solid var(--codexpp-project-tint, color-mix(in srgb, currentColor 40%, transparent));
      box-sizing: border-box;
      color: var(--text-primary, currentColor);
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 1px 8px 7px 18px;
      min-width: 0;
      padding: 7px 8px 8px 8px;
    }
    .codexpp-git-summary-header,
    .codexpp-git-summary-line,
    .codexpp-git-file-row,
    .codexpp-git-worktree-row {
      align-items: center;
      display: flex;
      gap: 6px;
      min-width: 0;
    }
    .codexpp-git-summary-header {
      justify-content: space-between;
    }
    .codexpp-git-summary-title {
      align-items: center;
      display: flex;
      gap: 5px;
      min-width: 0;
    }
    .codexpp-git-summary-title span:first-child,
    .codexpp-git-worktrees-label {
      color: var(--text-tertiary, currentColor);
      font: 600 10px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      opacity: 0.7;
      text-transform: uppercase;
    }
    .codexpp-git-summary-title strong {
      font: 600 12px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .codexpp-git-summary-state {
      border-radius: 5px;
      flex: 0 0 auto;
      font: 600 10px/1.2 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 2px 5px;
    }
    .codexpp-git-summary-state.is-clean {
      background: rgba(34, 197, 94, 0.12);
      color: rgb(22, 163, 74);
    }
    .codexpp-git-summary-state.is-dirty {
      background: rgba(245, 158, 11, 0.12);
      color: rgb(180, 83, 9);
    }
    .codexpp-git-summary-metrics {
      display: grid;
      gap: 4px;
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
    .codexpp-git-metric {
      min-width: 0;
    }
    .codexpp-git-metric span:first-child {
      display: block;
      font: 600 12px/1.15 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .codexpp-git-metric span:last-child,
    .codexpp-git-summary-line,
    .codexpp-git-more,
    .codexpp-git-warning {
      color: var(--text-tertiary, currentColor);
      font: 500 10px/1.25 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      opacity: 0.74;
    }
    .codexpp-git-changed-files,
    .codexpp-git-worktrees {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .codexpp-git-file-row,
    .codexpp-git-worktree-row {
      color: var(--text-secondary, currentColor);
      font: 500 11px/1.25 system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    .codexpp-git-file-row span:first-child {
      color: var(--codexpp-project-text-color, currentColor);
      flex: 0 0 24px;
      font: 600 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      opacity: 0.88;
    }
    .codexpp-git-file-row span:last-child,
    .codexpp-git-worktree-row span:last-child {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .codexpp-git-worktree-row {
      justify-content: space-between;
    }
    .codexpp-git-worktree-row span:first-child {
      font: 500 10px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}
