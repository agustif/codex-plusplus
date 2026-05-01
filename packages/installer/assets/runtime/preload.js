"use strict";

// src/preload/index.ts
var import_electron6 = require("electron");

// src/preload/react-hook.ts
function installReactHook() {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
  const renderers = /* @__PURE__ */ new Map();
  let nextId = 1;
  const listeners = /* @__PURE__ */ new Map();
  const hook = {
    supportsFiber: true,
    renderers,
    inject(renderer) {
      const id = nextId++;
      renderers.set(id, renderer);
      console.debug(
        "[codex-plusplus] React renderer attached:",
        renderer.rendererPackageName,
        renderer.version
      );
      return id;
    },
    on(event, fn) {
      let s = listeners.get(event);
      if (!s) listeners.set(event, s = /* @__PURE__ */ new Set());
      s.add(fn);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
    },
    emit(event, ...args) {
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
    onCommitFiberRoot() {
    },
    onCommitFiberUnmount() {
    },
    onScheduleFiberRoot() {
    },
    checkDCE() {
    }
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: true,
    enumerable: false,
    writable: true,
    // allow real DevTools to overwrite if user installs it
    value: hook
  });
  window.__codexpp__ = { hook, renderers };
}
function fiberForNode(node) {
  const renderers = window.__codexpp__?.renderers;
  if (renderers) {
    for (const r of renderers.values()) {
      const f = r.findFiberByHostInstance?.(node);
      if (f) return f;
    }
  }
  for (const k of Object.keys(node)) {
    if (k.startsWith("__reactFiber")) return node[k];
  }
  return null;
}

// src/preload/settings-injector.ts
var import_electron = require("electron");
var state = {
  sections: /* @__PURE__ */ new Map(),
  pages: /* @__PURE__ */ new Map(),
  listedTweaks: [],
  outerWrapper: null,
  nativeNavHeader: null,
  navGroup: null,
  navButtons: null,
  pagesGroup: null,
  pagesGroupKey: null,
  panelHost: null,
  observer: null,
  fingerprint: null,
  sidebarDumped: false,
  activePage: null,
  sidebarRoot: null,
  sidebarRestoreHandler: null,
  settingsSurfaceVisible: false,
  settingsSurfaceHideTimer: null
};
function plog(msg, extra) {
  import_electron.ipcRenderer.send(
    "codexpp:preload-log",
    "info",
    `[settings-injector] ${msg}${extra === void 0 ? "" : " " + safeStringify(extra)}`
  );
}
function safeStringify(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function startSettingsInjector() {
  if (state.observer) return;
  const obs = new MutationObserver(() => {
    tryInject();
    maybeDumpDom();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  state.observer = obs;
  window.addEventListener("popstate", onNav);
  window.addEventListener("hashchange", onNav);
  document.addEventListener("click", onDocumentClick, true);
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function(...args) {
      const r = orig.apply(this, args);
      window.dispatchEvent(new Event(`codexpp-${m}`));
      return r;
    };
    window.addEventListener(`codexpp-${m}`, onNav);
  }
  tryInject();
  maybeDumpDom();
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
    tryInject();
    maybeDumpDom();
    if (ticks > 60) clearInterval(interval);
  }, 500);
}
function onNav() {
  state.fingerprint = null;
  tryInject();
  maybeDumpDom();
}
function onDocumentClick(e) {
  const target = e.target instanceof Element ? e.target : null;
  const control = target?.closest("[role='link'],button,a");
  if (!(control instanceof HTMLElement)) return;
  if (compactSettingsText(control.textContent || "") !== "Back to app") return;
  setTimeout(() => {
    setSettingsSurfaceVisible(false, "back-to-app");
  }, 0);
}
function registerSection(section) {
  state.sections.set(section.id, section);
  if (state.activePage?.kind === "tweaks") rerender();
  return {
    unregister: () => {
      state.sections.delete(section.id);
      if (state.activePage?.kind === "tweaks") rerender();
    }
  };
}
function clearSections() {
  state.sections.clear();
  for (const p of state.pages.values()) {
    try {
      p.teardown?.();
    } catch (e) {
      plog("page teardown failed", { id: p.id, err: String(e) });
    }
  }
  state.pages.clear();
  syncPagesGroup();
  if (state.activePage?.kind === "registered" && !state.pages.has(state.activePage.id)) {
    restoreCodexView();
  } else if (state.activePage?.kind === "tweaks") {
    rerender();
  }
}
function registerPage(tweakId, manifest, page) {
  const id = page.id;
  const entry = { id, tweakId, manifest, page };
  state.pages.set(id, entry);
  plog("registerPage", { id, title: page.title, tweakId });
  syncPagesGroup();
  if (state.activePage?.kind === "registered" && state.activePage.id === id) {
    rerender();
  }
  return {
    unregister: () => {
      const e = state.pages.get(id);
      if (!e) return;
      try {
        e.teardown?.();
      } catch {
      }
      state.pages.delete(id);
      syncPagesGroup();
      if (state.activePage?.kind === "registered" && state.activePage.id === id) {
        restoreCodexView();
      }
    }
  };
}
function setListedTweaks(list) {
  state.listedTweaks = list;
  if (state.activePage?.kind === "tweaks") rerender();
}
function tryInject() {
  const itemsGroup = findSidebarItemsGroup();
  if (!itemsGroup) {
    scheduleSettingsSurfaceHidden();
    plog("sidebar not found");
    return;
  }
  if (state.settingsSurfaceHideTimer) {
    clearTimeout(state.settingsSurfaceHideTimer);
    state.settingsSurfaceHideTimer = null;
  }
  setSettingsSurfaceVisible(true, "sidebar-found");
  const outer = itemsGroup.parentElement ?? itemsGroup;
  state.sidebarRoot = outer;
  syncNativeSettingsHeader(itemsGroup, outer);
  if (state.navGroup && outer.contains(state.navGroup)) {
    syncPagesGroup();
    if (state.activePage !== null) syncCodexNativeNavActive(true);
    return;
  }
  if (state.activePage !== null || state.panelHost !== null) {
    plog("sidebar re-mount detected; clearing stale active state", {
      prevActive: state.activePage
    });
    state.activePage = null;
    state.panelHost = null;
  }
  const group = document.createElement("div");
  group.dataset.codexpp = "nav-group";
  group.className = "flex flex-col gap-px";
  group.appendChild(sidebarGroupHeader("Codex++", "pt-3"));
  const configBtn = makeSidebarItem("Config", configIconSvg());
  const patchManagerBtn = makeSidebarItem("Patch Manager", patchManagerIconSvg());
  const tweaksBtn = makeSidebarItem("Tweaks", tweaksIconSvg());
  configBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activatePage({ kind: "config" });
  });
  patchManagerBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activatePage({ kind: "patch-manager" });
  });
  tweaksBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activatePage({ kind: "tweaks" });
  });
  group.appendChild(configBtn);
  group.appendChild(patchManagerBtn);
  group.appendChild(tweaksBtn);
  outer.appendChild(group);
  state.navGroup = group;
  state.navButtons = { config: configBtn, patchManager: patchManagerBtn, tweaks: tweaksBtn };
  plog("nav group injected", { outerTag: outer.tagName });
  syncPagesGroup();
}
function syncNativeSettingsHeader(itemsGroup, outer) {
  if (state.nativeNavHeader && outer.contains(state.nativeNavHeader)) return;
  if (outer === itemsGroup) return;
  const header = sidebarGroupHeader("General");
  header.dataset.codexpp = "native-nav-header";
  outer.insertBefore(header, itemsGroup);
  state.nativeNavHeader = header;
}
function sidebarGroupHeader(text, topPadding = "pt-2") {
  const header = document.createElement("div");
  header.className = `px-row-x ${topPadding} pb-1 text-[11px] font-medium uppercase tracking-wider text-token-description-foreground select-none`;
  header.textContent = text;
  return header;
}
function scheduleSettingsSurfaceHidden() {
  if (!state.settingsSurfaceVisible || state.settingsSurfaceHideTimer) return;
  state.settingsSurfaceHideTimer = setTimeout(() => {
    state.settingsSurfaceHideTimer = null;
    if (findSidebarItemsGroup()) return;
    if (isSettingsTextVisible()) return;
    setSettingsSurfaceVisible(false, "sidebar-not-found");
  }, 1500);
}
function isSettingsTextVisible() {
  const text = compactSettingsText(document.body?.textContent || "").toLowerCase();
  return text.includes("back to app") && text.includes("general") && text.includes("appearance") && (text.includes("configuration") || text.includes("default permissions"));
}
function compactSettingsText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
function setSettingsSurfaceVisible(visible, reason) {
  if (state.settingsSurfaceVisible === visible) return;
  state.settingsSurfaceVisible = visible;
  try {
    window.__codexppSettingsSurfaceVisible = visible;
    document.documentElement.dataset.codexppSettingsSurface = visible ? "true" : "false";
    window.dispatchEvent(
      new CustomEvent("codexpp:settings-surface", {
        detail: { visible, reason }
      })
    );
  } catch {
  }
  plog("settings surface", { visible, reason, url: location.href });
}
function syncPagesGroup() {
  const outer = state.sidebarRoot;
  if (!outer) return;
  const pages = [...state.pages.values()];
  const desiredKey = pages.length === 0 ? "EMPTY" : pages.map((p) => `${p.id}|${p.page.title}|${p.page.iconSvg ?? ""}`).join("\n");
  const groupAttached = !!state.pagesGroup && outer.contains(state.pagesGroup);
  if (state.pagesGroupKey === desiredKey && (pages.length === 0 ? !groupAttached : groupAttached)) {
    return;
  }
  if (pages.length === 0) {
    if (state.pagesGroup) {
      state.pagesGroup.remove();
      state.pagesGroup = null;
    }
    for (const p of state.pages.values()) p.navButton = null;
    state.pagesGroupKey = desiredKey;
    return;
  }
  let group = state.pagesGroup;
  if (!group || !outer.contains(group)) {
    group = document.createElement("div");
    group.dataset.codexpp = "pages-group";
    group.className = "flex flex-col gap-px";
    group.appendChild(sidebarGroupHeader("Tweaks", "pt-3"));
    outer.appendChild(group);
    state.pagesGroup = group;
  } else {
    while (group.children.length > 1) group.removeChild(group.lastChild);
  }
  for (const p of pages) {
    const icon = p.page.iconSvg ?? defaultPageIconSvg();
    const btn = makeSidebarItem(p.page.title, icon);
    btn.dataset.codexpp = `nav-page-${p.id}`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      activatePage({ kind: "registered", id: p.id });
    });
    p.navButton = btn;
    group.appendChild(btn);
  }
  state.pagesGroupKey = desiredKey;
  plog("pages group synced", {
    count: pages.length,
    ids: pages.map((p) => p.id)
  });
  setNavActive(state.activePage);
}
function makeSidebarItem(label, iconSvg) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.codexpp = `nav-${label.toLowerCase()}`;
  btn.setAttribute("aria-label", label);
  btn.className = "focus-visible:outline-token-border relative px-row-x py-row-y cursor-interaction shrink-0 items-center overflow-hidden rounded-lg text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 gap-2 flex w-full hover:bg-token-list-hover-background font-normal";
  const inner = document.createElement("div");
  inner.className = "flex min-w-0 items-center text-base gap-2 flex-1 text-token-foreground";
  inner.innerHTML = `${iconSvg}<span class="truncate">${label}</span>`;
  btn.appendChild(inner);
  return btn;
}
function setNavActive(active) {
  if (state.navButtons) {
    const builtin = active?.kind === "config" ? "config" : active?.kind === "patch-manager" ? "patchManager" : active?.kind === "tweaks" ? "tweaks" : null;
    for (const [key, btn] of Object.entries(state.navButtons)) {
      applyNavActive(btn, key === builtin);
    }
  }
  for (const p of state.pages.values()) {
    if (!p.navButton) continue;
    const isActive = active?.kind === "registered" && active.id === p.id;
    applyNavActive(p.navButton, isActive);
  }
  syncCodexNativeNavActive(active !== null);
}
function syncCodexNativeNavActive(mute) {
  if (!mute) return;
  const root2 = state.sidebarRoot;
  if (!root2) return;
  const buttons = Array.from(root2.querySelectorAll("button"));
  for (const btn of buttons) {
    if (btn.dataset.codexpp) continue;
    if (btn.getAttribute("aria-current") === "page") {
      btn.removeAttribute("aria-current");
    }
    if (btn.classList.contains("bg-token-list-hover-background")) {
      btn.classList.remove("bg-token-list-hover-background");
      btn.classList.add("hover:bg-token-list-hover-background");
    }
  }
}
function applyNavActive(btn, active) {
  const inner = btn.firstElementChild;
  if (active) {
    btn.classList.remove("hover:bg-token-list-hover-background", "font-normal");
    btn.classList.add("bg-token-list-hover-background");
    btn.setAttribute("aria-current", "page");
    if (inner) {
      inner.classList.remove("text-token-foreground");
      inner.classList.add("text-token-list-active-selection-foreground");
      inner.querySelector("svg")?.classList.add("text-token-list-active-selection-icon-foreground");
    }
  } else {
    btn.classList.add("hover:bg-token-list-hover-background", "font-normal");
    btn.classList.remove("bg-token-list-hover-background");
    btn.removeAttribute("aria-current");
    if (inner) {
      inner.classList.add("text-token-foreground");
      inner.classList.remove("text-token-list-active-selection-foreground");
      inner.querySelector("svg")?.classList.remove("text-token-list-active-selection-icon-foreground");
    }
  }
}
function activatePage(page) {
  const content = findContentArea();
  if (!content) {
    plog("activate: content area not found");
    return;
  }
  state.activePage = page;
  plog("activate", { page });
  for (const child of Array.from(content.children)) {
    if (child.dataset.codexpp === "tweaks-panel") continue;
    if (child.dataset.codexppHidden === void 0) {
      child.dataset.codexppHidden = child.style.display || "";
    }
    child.style.display = "none";
  }
  let panel = content.querySelector('[data-codexpp="tweaks-panel"]');
  if (!panel) {
    panel = document.createElement("div");
    panel.dataset.codexpp = "tweaks-panel";
    panel.style.cssText = "width:100%;height:100%;overflow:auto;";
    content.appendChild(panel);
  }
  panel.style.display = "block";
  state.panelHost = panel;
  rerender();
  setNavActive(page);
  const sidebar = state.sidebarRoot;
  if (sidebar) {
    if (state.sidebarRestoreHandler) {
      sidebar.removeEventListener("click", state.sidebarRestoreHandler, true);
    }
    const handler = (e) => {
      const target = e.target;
      if (!target) return;
      if (state.navGroup?.contains(target)) return;
      if (state.pagesGroup?.contains(target)) return;
      if (target.closest("[data-codexpp-settings-search]")) return;
      restoreCodexView();
    };
    state.sidebarRestoreHandler = handler;
    sidebar.addEventListener("click", handler, true);
  }
}
function restoreCodexView() {
  plog("restore codex view");
  const content = findContentArea();
  if (!content) return;
  if (state.panelHost) state.panelHost.style.display = "none";
  for (const child of Array.from(content.children)) {
    if (child === state.panelHost) continue;
    if (child.dataset.codexppHidden !== void 0) {
      child.style.display = child.dataset.codexppHidden;
      delete child.dataset.codexppHidden;
    }
  }
  state.activePage = null;
  setNavActive(null);
  if (state.sidebarRoot && state.sidebarRestoreHandler) {
    state.sidebarRoot.removeEventListener(
      "click",
      state.sidebarRestoreHandler,
      true
    );
    state.sidebarRestoreHandler = null;
  }
}
function rerender() {
  if (!state.activePage) return;
  const host = state.panelHost;
  if (!host) return;
  host.innerHTML = "";
  const ap = state.activePage;
  if (ap.kind === "registered") {
    const entry = state.pages.get(ap.id);
    if (!entry) {
      restoreCodexView();
      return;
    }
    const root3 = panelShell(entry.page.title, entry.page.description);
    host.appendChild(root3.outer);
    try {
      try {
        entry.teardown?.();
      } catch {
      }
      entry.teardown = null;
      const ret = entry.page.render(root3.sectionsWrap);
      if (typeof ret === "function") entry.teardown = ret;
    } catch (e) {
      const err = document.createElement("div");
      err.className = "text-token-charts-red text-sm";
      err.textContent = `Error rendering page: ${e.message}`;
      root3.sectionsWrap.appendChild(err);
    }
    return;
  }
  if (ap.kind === "patch-manager") {
    const root3 = panelShell("Patch Manager", "Checking Stable and Beta patch state.");
    host.appendChild(root3.outer);
    renderPatchManagerPage(root3.sectionsWrap, root3.subtitle);
    return;
  }
  const title = ap.kind === "tweaks" ? "Tweaks" : "Config";
  const subtitle = ap.kind === "tweaks" ? "Manage your installed Codex++ tweaks." : "Checking installed Codex++ version.";
  const root2 = panelShell(title, subtitle);
  host.appendChild(root2.outer);
  if (ap.kind === "tweaks") renderTweaksPage(root2.sectionsWrap);
  else renderConfigPage(root2.sectionsWrap, root2.subtitle);
}
function renderConfigPage(sectionsWrap, subtitle) {
  const section = document.createElement("section");
  section.className = "flex flex-col gap-2";
  section.appendChild(sectionTitle("Codex++ Updates"));
  const card = roundedCard();
  const loading = rowSimple("Loading update settings", "Checking current Codex++ configuration.");
  card.appendChild(loading);
  section.appendChild(card);
  sectionsWrap.appendChild(section);
  void import_electron.ipcRenderer.invoke("codexpp:get-config").then((config) => {
    if (subtitle) {
      subtitle.textContent = `You have Codex++ ${config.version} installed.`;
    }
    card.textContent = "";
    renderCodexPlusPlusConfig(card, config);
  }).catch((e) => {
    if (subtitle) subtitle.textContent = "Could not load installed Codex++ version.";
    card.textContent = "";
    card.appendChild(rowSimple("Could not load update settings", String(e)));
  });
  const watcher = document.createElement("section");
  watcher.className = "flex flex-col gap-2";
  watcher.appendChild(sectionTitle("Auto-Repair Watcher"));
  const watcherCard = roundedCard();
  watcherCard.appendChild(rowSimple("Checking watcher", "Verifying the updater repair service."));
  watcher.appendChild(watcherCard);
  sectionsWrap.appendChild(watcher);
  renderWatcherHealthCard(watcherCard);
  const cdp = document.createElement("section");
  cdp.className = "flex flex-col gap-2";
  cdp.appendChild(sectionTitle("Developer / CDP"));
  const cdpCard = roundedCard();
  cdpCard.appendChild(rowSimple("Checking CDP", "Reading Chrome DevTools Protocol status."));
  cdp.appendChild(cdpCard);
  sectionsWrap.appendChild(cdp);
  renderCdpCard(cdpCard);
  const flowTap = document.createElement("section");
  flowTap.className = "flex flex-col gap-2";
  flowTap.appendChild(sectionTitle("App Server Flow Tap"));
  const flowTapCard = roundedCard();
  flowTapCard.appendChild(rowSimple("Checking flow tap", "Reading app-server instrumentation status."));
  flowTap.appendChild(flowTapCard);
  sectionsWrap.appendChild(flowTap);
  renderAppServerFlowTapCard(flowTapCard);
  const maintenance = document.createElement("section");
  maintenance.className = "flex flex-col gap-2";
  maintenance.appendChild(sectionTitle("Maintenance"));
  const maintenanceCard = roundedCard();
  maintenanceCard.appendChild(uninstallRow());
  maintenanceCard.appendChild(reportBugRow());
  maintenance.appendChild(maintenanceCard);
  sectionsWrap.appendChild(maintenance);
}
function renderPatchManagerPage(sectionsWrap, subtitle) {
  const refresh2 = compactButton("Refresh", () => {
    sectionsWrap.textContent = "";
    renderPatchManagerPage(sectionsWrap, subtitle);
  });
  const overview = document.createElement("section");
  overview.className = "flex flex-col gap-2";
  overview.appendChild(sectionTitle("Stable / Beta", refresh2));
  const overviewCard = roundedCard();
  overviewCard.appendChild(rowSimple("Checking patch state", "Reading Codex++ homes and app bundles."));
  overview.appendChild(overviewCard);
  sectionsWrap.appendChild(overview);
  const commands = document.createElement("section");
  commands.className = "flex flex-col gap-2";
  commands.appendChild(sectionTitle("Commands"));
  const commandsCard = roundedCard();
  commandsCard.appendChild(rowSimple("Loading commands", "Preparing exact repair and reopen commands."));
  commands.appendChild(commandsCard);
  sectionsWrap.appendChild(commands);
  void import_electron.ipcRenderer.invoke("codexpp:get-patch-manager-status").then((status) => {
    const patch = status;
    if (subtitle) {
      subtitle.textContent = patch.currentChannel === "unknown" ? `Checked ${new Date(patch.checkedAt).toLocaleString()}.` : `Running from ${channelLabel(patch.currentChannel)}. Checked ${new Date(patch.checkedAt).toLocaleString()}.`;
    }
    overviewCard.textContent = "";
    commandsCard.textContent = "";
    for (const channel of patch.channels) {
      overviewCard.appendChild(patchChannelRow(channel));
      commandsCard.appendChild(patchCommandRow(channel));
    }
  }).catch((e) => {
    if (subtitle) subtitle.textContent = "Could not read patch state.";
    overviewCard.textContent = "";
    commandsCard.textContent = "";
    overviewCard.appendChild(rowSimple("Patch state unavailable", String(e)));
    commandsCard.appendChild(rowSimple("Commands unavailable", "Patch status failed before commands were built."));
  });
}
function patchChannelRow(channel) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 items-start gap-3";
  left.appendChild(statusBadge(patchChannelTone(channel), channel.current ? `${channel.label} current` : channel.label));
  const stack = document.createElement("div");
  stack.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = patchChannelTitle(channel);
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.textContent = patchChannelSummary(channel);
  const meta = document.createElement("div");
  meta.className = "text-token-text-secondary min-w-0 truncate text-xs";
  meta.textContent = channel.appRoot;
  stack.append(title, desc, meta);
  left.appendChild(stack);
  row.appendChild(left);
  const actions = document.createElement("div");
  actions.className = "flex shrink-0 items-center gap-2";
  actions.appendChild(
    compactButton("Reveal", () => {
      void import_electron.ipcRenderer.invoke("codexpp:reveal", channel.userRoot);
    })
  );
  if (channel.cdp.jsonListUrl) {
    actions.appendChild(
      compactButton("Targets", () => {
        void import_electron.ipcRenderer.invoke("codexpp:open-cdp-url", channel.cdp.jsonListUrl);
      })
    );
  }
  row.appendChild(actions);
  return row;
}
function patchCommandRow(channel) {
  const row = actionRow(
    `${channel.label} repair`,
    `${commandSummary(channel)} Saved CDP ${channel.cdp.configuredPort}; default ${channel.cdp.expectedPort}.`
  );
  const action = row.querySelector("[data-codexpp-row-actions]");
  action?.appendChild(copyCommandButton("Repair", channel.commands.repair));
  action?.appendChild(copyCommandButton("Reopen", channel.commands.reopenWithCdp));
  action?.appendChild(copyCommandButton("Status", channel.commands.status));
  action?.appendChild(copyCommandButton("Update", channel.commands.updateCodex));
  return row;
}
function copyCommandButton(label, command) {
  return compactButton(label, () => {
    void import_electron.ipcRenderer.invoke("codexpp:copy-text", command);
  });
}
function patchChannelTitle(channel) {
  if (!channel.stateExists) return `${channel.label} is not installed through Codex++`;
  const codex = channel.codexVersion ? `Codex ${channel.codexVersion}` : "Codex version unknown";
  const codexpp = channel.codexPlusPlusVersion ? `Codex++ ${channel.codexPlusPlusVersion}` : "Codex++ version unknown";
  return `${codex} \xB7 ${codexpp}`;
}
function patchChannelSummary(channel) {
  const runtime = channel.runtimePreloadExists ? `runtime ${formatBytes(channel.runtimePreloadBytes)}` : "runtime missing";
  const watcher = channel.watcherLoaded === null ? "watcher unknown" : channel.watcherLoaded ? "watcher loaded" : "watcher not loaded";
  const cdp = channel.cdp.active ? `CDP active on ${channel.cdp.activePort}` : channel.cdp.enabled ? `CDP saved on ${channel.cdp.configuredPort}` : "CDP off";
  const drift = channel.cdp.drift ? `; expected ${channel.cdp.expectedPort}` : "";
  return `${runtime}; ${watcher}; ${cdp}${drift}.`;
}
function commandSummary(channel) {
  if (!channel.appExists) return "App bundle is missing at the recorded path.";
  if (!channel.runtimePreloadExists) return "Runtime preload is missing; repair should refresh it.";
  if (!channel.autoUpdate) return "Automatic repair is disabled.";
  return "Patch files are present.";
}
function patchChannelTone(channel) {
  if (!channel.stateExists || !channel.appExists || !channel.runtimePreloadExists) return "error";
  if (channel.watcherLoaded === false || channel.cdp.drift || !channel.autoUpdate) return "warn";
  return "ok";
}
function channelLabel(channel) {
  if (channel === "stable") return "Stable";
  if (channel === "beta") return "Beta";
  return "Unknown";
}
function formatBytes(bytes) {
  if (bytes === null) return "missing";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function renderCodexPlusPlusConfig(card, config) {
  card.appendChild(autoUpdateRow(config));
  card.appendChild(checkForUpdatesRow(config.updateCheck));
  if (config.updateCheck) card.appendChild(releaseNotesRow(config.updateCheck));
}
function autoUpdateRow(config) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = "Automatically refresh Codex++";
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.textContent = `Installed version v${config.version}. The watcher can refresh the Codex++ runtime after you rerun the GitHub installer.`;
  left.appendChild(title);
  left.appendChild(desc);
  row.appendChild(left);
  row.appendChild(
    switchControl(config.autoUpdate, async (next) => {
      await import_electron.ipcRenderer.invoke("codexpp:set-auto-update", next);
    })
  );
  return row;
}
function checkForUpdatesRow(check) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = check?.updateAvailable ? "Codex++ update available" : "Codex++ is up to date";
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.textContent = updateSummary(check);
  left.appendChild(title);
  left.appendChild(desc);
  row.appendChild(left);
  const actions = document.createElement("div");
  actions.className = "flex shrink-0 items-center gap-2";
  if (check?.releaseUrl) {
    actions.appendChild(
      compactButton("Release Notes", () => {
        void import_electron.ipcRenderer.invoke("codexpp:open-external", check.releaseUrl);
      })
    );
  }
  actions.appendChild(
    compactButton("Check Now", () => {
      row.style.opacity = "0.65";
      void import_electron.ipcRenderer.invoke("codexpp:check-codexpp-update", true).then((next) => {
        const card = row.parentElement;
        if (!card) return;
        card.textContent = "";
        void import_electron.ipcRenderer.invoke("codexpp:get-config").then((config) => {
          renderCodexPlusPlusConfig(card, {
            ...config,
            updateCheck: next
          });
        });
      }).catch((e) => plog("Codex++ update check failed", String(e))).finally(() => {
        row.style.opacity = "";
      });
    })
  );
  row.appendChild(actions);
  return row;
}
function releaseNotesRow(check) {
  const row = document.createElement("div");
  row.className = "flex flex-col gap-2 p-3";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = "Latest release notes";
  row.appendChild(title);
  const body = document.createElement("div");
  body.className = "max-h-60 overflow-auto rounded-md border border-token-border bg-token-foreground/5 p-3 text-sm text-token-text-secondary";
  body.appendChild(renderReleaseNotesMarkdown(check.releaseNotes?.trim() || check.error || "No release notes available."));
  row.appendChild(body);
  return row;
}
function renderCdpCard(card) {
  void import_electron.ipcRenderer.invoke("codexpp:get-cdp-status").then((status) => {
    card.textContent = "";
    renderCdpStatus(card, status);
  }).catch((e) => {
    card.textContent = "";
    card.appendChild(rowSimple("Could not read CDP status", String(e)));
  });
}
function renderCdpStatus(card, status) {
  card.appendChild(cdpToggleRow(card, status));
  card.appendChild(cdpPortRow(card, status));
  card.appendChild(cdpEndpointRow(status));
  card.appendChild(cdpLaunchRow(status));
  if (status.restartRequired) {
    card.appendChild(
      rowSimple(
        "Restart required",
        status.enabled ? "CDP will use the saved port after Codex restarts." : "CDP is still active for this process and will turn off after Codex restarts."
      )
    );
  }
}
function cdpToggleRow(card, status) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 items-start gap-3";
  left.appendChild(cdpStatusBadge(status));
  const stack = document.createElement("div");
  stack.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = "Chrome DevTools Protocol";
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.textContent = cdpStatusSummary(status);
  stack.append(title, desc);
  left.appendChild(stack);
  row.appendChild(left);
  row.appendChild(
    switchControl(status.enabled, async (enabled) => {
      await import_electron.ipcRenderer.invoke("codexpp:set-cdp-config", {
        enabled,
        port: status.configuredPort
      });
      refreshCdpCard(card);
    })
  );
  return row;
}
function cdpPortRow(card, status) {
  const row = actionRow(
    "Remote debugging port",
    status.activePort ? `Current process is listening on ${status.activePort}.` : `Saved port is ${status.configuredPort}.`
  );
  const action = row.querySelector("[data-codexpp-row-actions]");
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.max = "65535";
  input.step = "1";
  input.value = String(status.configuredPort);
  input.className = "h-8 w-24 rounded-lg border border-token-border bg-transparent px-2 text-sm text-token-text-primary focus:outline-none focus:ring-2 focus:ring-token-focus-border";
  action?.appendChild(input);
  action?.appendChild(
    compactButton("Save", () => {
      const port = Number(input.value);
      void import_electron.ipcRenderer.invoke("codexpp:set-cdp-config", {
        enabled: status.enabled,
        port: Number.isInteger(port) ? port : status.configuredPort
      }).then(() => refreshCdpCard(card)).catch((e) => plog("CDP port save failed", String(e)));
    })
  );
  return row;
}
function cdpEndpointRow(status) {
  const row = actionRow(
    status.active ? "Local CDP endpoints" : "Local CDP endpoints",
    status.active && status.jsonListUrl ? `${status.jsonListUrl}` : "Not exposed by the current Codex process."
  );
  const action = row.querySelector("[data-codexpp-row-actions]");
  const openTargets = compactButton("Open Targets", () => {
    if (!status.jsonListUrl) return;
    void import_electron.ipcRenderer.invoke("codexpp:open-cdp-url", status.jsonListUrl);
  });
  openTargets.disabled = !status.jsonListUrl;
  const copyTargets = compactButton("Copy URL", () => {
    if (!status.jsonListUrl) return;
    void import_electron.ipcRenderer.invoke("codexpp:copy-text", status.jsonListUrl);
  });
  copyTargets.disabled = !status.jsonListUrl;
  const openVersion = compactButton("Version", () => {
    if (!status.jsonVersionUrl) return;
    void import_electron.ipcRenderer.invoke("codexpp:open-cdp-url", status.jsonVersionUrl);
  });
  openVersion.disabled = !status.jsonVersionUrl;
  action?.append(openTargets, copyTargets, openVersion);
  return row;
}
function cdpLaunchRow(status) {
  const row = actionRow(
    "Launch command",
    status.appRoot ? status.appRoot : "Codex app path was not found in installer state."
  );
  const action = row.querySelector("[data-codexpp-row-actions]");
  action?.appendChild(
    compactButton("Copy Command", () => {
      void import_electron.ipcRenderer.invoke("codexpp:copy-text", status.launchCommand);
    })
  );
  return row;
}
function refreshCdpCard(card) {
  card.textContent = "";
  card.appendChild(rowSimple("Checking CDP", "Reading Chrome DevTools Protocol status."));
  renderCdpCard(card);
}
function cdpStatusBadge(status) {
  if (status.active) return statusBadge(status.restartRequired ? "warn" : "ok", "Active");
  if (status.restartRequired) return statusBadge("warn", "Restart");
  return statusBadge(status.enabled ? "warn" : "warn", status.enabled ? "Saved" : "Off");
}
function cdpStatusSummary(status) {
  if (status.activePort) {
    const source = status.source === "argv" ? "launch arg" : status.source;
    return `Active on 127.0.0.1:${status.activePort} from ${source}.`;
  }
  if (status.enabled) {
    return `Enabled for next launch on 127.0.0.1:${status.configuredPort}.`;
  }
  return "Disabled for Codex launches managed by Codex++.";
}
function renderAppServerFlowTapCard(card) {
  void import_electron.ipcRenderer.invoke("codexpp:get-app-server-flow-tap-status").then((status) => {
    card.textContent = "";
    renderAppServerFlowTapStatus(card, status);
  }).catch((e) => {
    card.textContent = "";
    card.appendChild(rowSimple("Could not read flow tap status", String(e)));
  });
}
function renderAppServerFlowTapStatus(card, status) {
  card.appendChild(appServerFlowTapToggleRow(card, status));
  card.appendChild(appServerFlowTapSummaryRow(status));
  card.appendChild(appServerFlowTapLogActionsRow(card, status));
  const logRow = document.createElement("div");
  logRow.className = "flex flex-col gap-2 p-3";
  logRow.appendChild(rowInlineTitle("Recent protocol flow"));
  const body = document.createElement("pre");
  body.className = "max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-token-border bg-token-foreground/5 p-3 text-xs text-token-text-secondary";
  body.textContent = "Reading app-server flow log.";
  logRow.appendChild(body);
  card.appendChild(logRow);
  refreshAppServerFlowTapTail(body);
}
function appServerFlowTapToggleRow(card, status) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 items-start gap-3";
  left.appendChild(appServerFlowTapStatusBadge(status));
  const stack = document.createElement("div");
  stack.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = "App-server stdio flow";
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.textContent = appServerFlowTapSummary(status);
  stack.append(title, desc);
  left.appendChild(stack);
  row.appendChild(left);
  row.appendChild(
    switchControl(status.enabled, async (enabled) => {
      await import_electron.ipcRenderer.invoke("codexpp:set-app-server-flow-tap-config", { enabled });
      refreshAppServerFlowTapCard(card);
    })
  );
  return row;
}
function appServerFlowTapSummaryRow(status) {
  const active = status.activePids.length > 0 ? `capturing PID ${status.activePids.join(", ")}` : "waiting for the next app-server child";
  return rowSimple(
    "Capture state",
    `${active}; ${status.capturedMessages} line(s) captured; ${status.rawPayloads ? "raw payloads on" : "summary-only"}; ${status.droppedLogLines} dropped; log ${bytesLabel(status.logSizeBytes)}.`
  );
}
function appServerFlowTapLogActionsRow(card, status) {
  const row = actionRow("Flow log", status.logPath);
  const action = row.querySelector("[data-codexpp-row-actions]");
  action?.appendChild(
    compactButton("Refresh", () => refreshAppServerFlowTapCard(card))
  );
  action?.appendChild(
    compactButton("Copy Tail", () => {
      void import_electron.ipcRenderer.invoke("codexpp:read-app-server-flow-tap-log", 256 * 1024).then((text) => import_electron.ipcRenderer.invoke("codexpp:copy-text", String(text))).catch((e) => plog("flow tap copy failed", String(e)));
    })
  );
  action?.appendChild(
    compactButton("Open Log", () => {
      void import_electron.ipcRenderer.invoke("codexpp:open-app-server-flow-tap-log");
    })
  );
  action?.appendChild(
    compactButton("Reveal", () => {
      void import_electron.ipcRenderer.invoke("codexpp:reveal-app-server-flow-tap-log");
    })
  );
  return row;
}
function refreshAppServerFlowTapCard(card) {
  card.textContent = "";
  card.appendChild(rowSimple("Checking flow tap", "Reading app-server instrumentation status."));
  renderAppServerFlowTapCard(card);
}
function refreshAppServerFlowTapTail(target) {
  void import_electron.ipcRenderer.invoke("codexpp:read-app-server-flow-tap-log", 256 * 1024).then((text) => {
    const formatted = formatAppServerFlowTail(String(text));
    target.textContent = formatted || "No app-server flow has been captured yet.";
  }).catch((e) => {
    target.textContent = `Could not read flow log: ${String(e)}`;
  });
}
function formatAppServerFlowTail(text) {
  const lines = text.trim().split("\n").filter(Boolean).slice(-80);
  return lines.map(formatAppServerFlowLine).join("\n");
}
function formatAppServerFlowLine(line) {
  try {
    const record = JSON.parse(line);
    const ts = record.ts ? record.ts.slice(11, 23) : "--:--:--.---";
    if (record.event !== "line") {
      return `${ts} ${record.event ?? "event"} pid=${record.pid ?? "-"}`;
    }
    const rpc = record.jsonrpc;
    if (rpc) {
      const parts = [
        ts,
        record.stream ?? "?",
        rpc.kind ?? "json",
        rpc.method ?? `id=${rpc.id ?? "-"}`,
        rpc.status ? `status=${rpc.status}` : "",
        rpc.threadId ? `thread=${shortId(rpc.threadId)}` : "",
        rpc.turnId ? `turn=${shortId(rpc.turnId)}` : "",
        typeof rpc.resultDataCount === "number" ? `items=${rpc.resultDataCount}` : "",
        typeof rpc.hasNextCursor === "boolean" ? `next=${rpc.hasNextCursor ? "yes" : "no"}` : "",
        rpc.errorMessage ? `error=${rpc.errorMessage}` : ""
      ].filter(Boolean);
      return parts.join(" ");
    }
    const payload = record.text ? String(record.text).slice(0, 500) : "(payload omitted)";
    return `${ts} ${record.stream ?? "?"} ${payload}`;
  } catch {
    return line;
  }
}
function appServerFlowTapStatusBadge(status) {
  if (status.active) return statusBadge("ok", "Flowing");
  if (status.enabled) return statusBadge("warn", "Armed");
  return statusBadge("warn", "Off");
}
function appServerFlowTapSummary(status) {
  if (status.activePids.length > 0) {
    return `Capturing stdio for app-server PID ${status.activePids.join(", ")}.`;
  }
  if (status.enabled) {
    return "Enabled; restart Codex if the current app-server was spawned before the tap was armed.";
  }
  return "Disabled. Enable it to tee app-server stdin/stdout/stderr summaries into a capped JSONL log.";
}
function rowInlineTitle(text) {
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  title.textContent = text;
  return title;
}
function bytesLabel(bytes) {
  if (bytes === null) return "missing";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function shortId(value) {
  return value.length <= 12 ? value : `${value.slice(0, 6)}\u2026${value.slice(-4)}`;
}
function renderReleaseNotesMarkdown(markdown) {
  const root2 = document.createElement("div");
  root2.className = "flex flex-col gap-2";
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [];
  let list = null;
  let codeLines = null;
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = document.createElement("p");
    p.className = "m-0 leading-5";
    appendInlineMarkdown(p, paragraph.join(" ").trim());
    root2.appendChild(p);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    root2.appendChild(list);
    list = null;
  };
  const flushCode = () => {
    if (!codeLines) return;
    const pre = document.createElement("pre");
    pre.className = "m-0 overflow-auto rounded-md border border-token-border bg-token-foreground/10 p-2 text-xs text-token-text-primary";
    const code = document.createElement("code");
    code.textContent = codeLines.join("\n");
    pre.appendChild(code);
    root2.appendChild(pre);
    codeLines = null;
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (codeLines) flushCode();
      else {
        flushParagraph();
        flushList();
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const h = document.createElement(heading[1].length === 1 ? "h3" : "h4");
      h.className = "m-0 text-sm font-medium text-token-text-primary";
      appendInlineMarkdown(h, heading[2]);
      root2.appendChild(h);
      continue;
    }
    const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph();
      const wantOrdered = Boolean(ordered);
      if (!list || wantOrdered && list.tagName !== "OL" || !wantOrdered && list.tagName !== "UL") {
        flushList();
        list = document.createElement(wantOrdered ? "ol" : "ul");
        list.className = wantOrdered ? "m-0 list-decimal space-y-1 pl-5 leading-5" : "m-0 list-disc space-y-1 pl-5 leading-5";
      }
      const li = document.createElement("li");
      appendInlineMarkdown(li, (unordered ?? ordered)?.[1] ?? "");
      list.appendChild(li);
      continue;
    }
    const quote = /^>\s?(.+)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      flushList();
      const blockquote = document.createElement("blockquote");
      blockquote.className = "m-0 border-l-2 border-token-border pl-3 leading-5";
      appendInlineMarkdown(blockquote, quote[1]);
      root2.appendChild(blockquote);
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  flushCode();
  return root2;
}
function appendInlineMarkdown(parent, text) {
  const pattern = /(`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index === void 0) continue;
    appendText(parent, text.slice(lastIndex, match.index));
    if (match[2] !== void 0) {
      const code = document.createElement("code");
      code.className = "rounded border border-token-border bg-token-foreground/10 px-1 py-0.5 text-xs text-token-text-primary";
      code.textContent = match[2];
      parent.appendChild(code);
    } else if (match[3] !== void 0 && match[4] !== void 0) {
      const a = document.createElement("a");
      a.className = "text-token-text-primary underline underline-offset-2";
      a.href = match[4];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[3];
      parent.appendChild(a);
    } else if (match[5] !== void 0) {
      const strong = document.createElement("strong");
      strong.className = "font-medium text-token-text-primary";
      strong.textContent = match[5];
      parent.appendChild(strong);
    } else if (match[6] !== void 0) {
      const em = document.createElement("em");
      em.textContent = match[6];
      parent.appendChild(em);
    }
    lastIndex = match.index + match[0].length;
  }
  appendText(parent, text.slice(lastIndex));
}
function appendText(parent, text) {
  if (text) parent.appendChild(document.createTextNode(text));
}
function renderWatcherHealthCard(card) {
  void import_electron.ipcRenderer.invoke("codexpp:get-watcher-health").then((health) => {
    card.textContent = "";
    renderWatcherHealth(card, health);
  }).catch((e) => {
    card.textContent = "";
    card.appendChild(rowSimple("Could not check watcher", String(e)));
  });
}
function renderWatcherHealth(card, health) {
  card.appendChild(watcherSummaryRow(health));
  for (const check of health.checks) {
    if (check.status === "ok") continue;
    card.appendChild(watcherCheckRow(check));
  }
}
function watcherSummaryRow(health) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 items-start gap-3";
  left.appendChild(statusBadge(health.status, health.watcher));
  const stack = document.createElement("div");
  stack.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = health.title;
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.textContent = `${health.summary} Checked ${new Date(health.checkedAt).toLocaleString()}.`;
  stack.appendChild(title);
  stack.appendChild(desc);
  left.appendChild(stack);
  row.appendChild(left);
  const action = document.createElement("div");
  action.className = "flex shrink-0 items-center gap-2";
  action.appendChild(
    compactButton("Check Now", () => {
      const card = row.parentElement;
      if (!card) return;
      card.textContent = "";
      card.appendChild(rowSimple("Checking watcher", "Verifying the updater repair service."));
      renderWatcherHealthCard(card);
    })
  );
  row.appendChild(action);
  return row;
}
function watcherCheckRow(check) {
  const row = rowSimple(check.name, check.detail);
  const left = row.firstElementChild;
  if (left) left.prepend(statusBadge(check.status));
  return row;
}
function statusBadge(status, label) {
  const badge = document.createElement("span");
  const tone = status === "ok" ? "border-token-charts-green text-token-charts-green" : status === "warn" ? "border-token-charts-yellow text-token-charts-yellow" : "border-token-charts-red text-token-charts-red";
  badge.className = `inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`;
  badge.textContent = label || (status === "ok" ? "OK" : status === "warn" ? "Review" : "Error");
  return badge;
}
function updateSummary(check) {
  if (!check) return "No update check has run yet.";
  const latest = check.latestVersion ? `Latest v${check.latestVersion}. ` : "";
  const checked = `Checked ${new Date(check.checkedAt).toLocaleString()}.`;
  if (check.error) return `${latest}${checked} ${check.error}`;
  return `${latest}${checked}`;
}
function uninstallRow() {
  const row = actionRow(
    "Uninstall Codex++",
    "Copies the uninstall command. Run it from a terminal after quitting Codex."
  );
  const action = row.querySelector("[data-codexpp-row-actions]");
  action?.appendChild(
    compactButton("Copy Command", () => {
      void import_electron.ipcRenderer.invoke("codexpp:copy-text", "node ~/.codex-plusplus/source/packages/installer/dist/cli.js uninstall").catch((e) => plog("copy uninstall command failed", String(e)));
    })
  );
  return row;
}
function reportBugRow() {
  const row = actionRow(
    "Report a bug",
    "Open a GitHub issue with runtime, installer, or tweak-manager details."
  );
  const action = row.querySelector("[data-codexpp-row-actions]");
  action?.appendChild(
    compactButton("Open Issue", () => {
      const title = encodeURIComponent("[Bug]: ");
      const body = encodeURIComponent(
        [
          "## What happened?",
          "",
          "## Steps to reproduce",
          "1. ",
          "",
          "## Environment",
          "- Codex++ version: ",
          "- Codex app version: ",
          "- OS: ",
          "",
          "## Logs",
          "Attach relevant lines from the Codex++ log directory."
        ].join("\n")
      );
      void import_electron.ipcRenderer.invoke(
        "codexpp:open-external",
        `https://github.com/agustif/codex-plusplus/issues/new?title=${title}&body=${body}`
      );
    })
  );
  return row;
}
function actionRow(titleText, description) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  row.style.flexWrap = "wrap";
  const left = document.createElement("div");
  left.className = "flex min-w-0 flex-col gap-1";
  left.style.flex = "1 1 18rem";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = titleText;
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.style.overflowWrap = "anywhere";
  desc.textContent = description;
  left.appendChild(title);
  left.appendChild(desc);
  row.appendChild(left);
  const actions = document.createElement("div");
  actions.dataset.codexppRowActions = "true";
  actions.className = "flex shrink-0 items-center gap-2";
  actions.style.flexWrap = "wrap";
  actions.style.justifyContent = "flex-end";
  actions.style.maxWidth = "100%";
  row.appendChild(actions);
  return row;
}
function renderTweaksPage(sectionsWrap) {
  const openBtn = openInPlaceButton("Open Tweaks Folder", () => {
    void import_electron.ipcRenderer.invoke("codexpp:reveal", tweaksPath());
  });
  const reloadBtn = openInPlaceButton("Force Reload", () => {
    void import_electron.ipcRenderer.invoke("codexpp:reload-tweaks").catch((e) => plog("force reload (main) failed", String(e))).finally(() => {
      location.reload();
    });
  });
  const reloadSvg = reloadBtn.querySelector("svg");
  if (reloadSvg) {
    reloadSvg.outerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-2xs" aria-hidden="true"><path d="M4 10a6 6 0 0 1 10.24-4.24L16 7.5M16 4v3.5h-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 10a6 6 0 0 1-10.24 4.24L4 12.5M4 16v-3.5h3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  const trailing = document.createElement("div");
  trailing.className = "flex items-center gap-2";
  trailing.appendChild(reloadBtn);
  trailing.appendChild(openBtn);
  if (state.listedTweaks.length === 0) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.appendChild(sectionTitle("Installed Tweaks", trailing));
    const card2 = roundedCard();
    card2.appendChild(
      rowSimple(
        "No tweaks installed",
        `Drop a tweak folder into ${tweaksPath()} and reload.`
      )
    );
    section.appendChild(card2);
    sectionsWrap.appendChild(section);
    return;
  }
  const sectionsByTweak = /* @__PURE__ */ new Map();
  for (const s of state.sections.values()) {
    const tweakId = s.id.split(":")[0];
    if (!sectionsByTweak.has(tweakId)) sectionsByTweak.set(tweakId, []);
    sectionsByTweak.get(tweakId).push(s);
  }
  const wrap = document.createElement("section");
  wrap.className = "flex flex-col gap-2";
  wrap.appendChild(sectionTitle("Installed Tweaks", trailing));
  const card = roundedCard();
  for (const t of state.listedTweaks) {
    card.appendChild(tweakRow(t, sectionsByTweak.get(t.manifest.id) ?? []));
  }
  wrap.appendChild(card);
  sectionsWrap.appendChild(wrap);
}
function tweakRow(t, sections) {
  const m = t.manifest;
  const cell = document.createElement("div");
  cell.className = "flex flex-col";
  if (!t.enabled) cell.style.opacity = "0.7";
  const header = document.createElement("div");
  header.className = "flex items-start justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 flex-1 items-start gap-3";
  const avatar = document.createElement("div");
  avatar.className = "flex shrink-0 items-center justify-center rounded-md border border-token-border overflow-hidden text-token-text-secondary";
  avatar.style.width = "56px";
  avatar.style.height = "56px";
  avatar.style.backgroundColor = "var(--color-token-bg-fog, transparent)";
  if (m.iconUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.className = "size-full object-contain";
    const initial = (m.name?.[0] ?? "?").toUpperCase();
    const fallback = document.createElement("span");
    fallback.className = "text-xl font-medium";
    fallback.textContent = initial;
    avatar.appendChild(fallback);
    img.style.display = "none";
    img.addEventListener("load", () => {
      fallback.remove();
      img.style.display = "";
    });
    img.addEventListener("error", () => {
      img.remove();
    });
    void resolveIconUrl(m.iconUrl, t.dir).then((url) => {
      if (url) img.src = url;
      else img.remove();
    });
    avatar.appendChild(img);
  } else {
    const initial = (m.name?.[0] ?? "?").toUpperCase();
    const span = document.createElement("span");
    span.className = "text-xl font-medium";
    span.textContent = initial;
    avatar.appendChild(span);
  }
  left.appendChild(avatar);
  const stack = document.createElement("div");
  stack.className = "flex min-w-0 flex-col gap-0.5";
  const titleRow = document.createElement("div");
  titleRow.className = "flex items-center gap-2";
  const name = document.createElement("div");
  name.className = "min-w-0 text-sm font-medium text-token-text-primary";
  name.textContent = m.name;
  titleRow.appendChild(name);
  if (m.version) {
    const ver = document.createElement("span");
    ver.className = "text-token-text-secondary text-xs font-normal tabular-nums";
    ver.textContent = `v${m.version}`;
    titleRow.appendChild(ver);
  }
  if (t.update?.updateAvailable) {
    const badge = document.createElement("span");
    badge.className = "rounded-full border border-token-border bg-token-foreground/5 px-2 py-0.5 text-[11px] font-medium text-token-text-primary";
    badge.textContent = "Update Available";
    titleRow.appendChild(badge);
  }
  stack.appendChild(titleRow);
  if (m.description) {
    const desc = document.createElement("div");
    desc.className = "text-token-text-secondary min-w-0 text-sm";
    desc.textContent = m.description;
    stack.appendChild(desc);
  }
  const meta = document.createElement("div");
  meta.className = "flex items-center gap-2 text-xs text-token-text-secondary";
  const authorEl = renderAuthor(m.author);
  if (authorEl) meta.appendChild(authorEl);
  if (m.githubRepo) {
    if (meta.children.length > 0) meta.appendChild(dot());
    const repo = document.createElement("button");
    repo.type = "button";
    repo.className = "inline-flex text-token-text-link-foreground hover:underline";
    repo.textContent = m.githubRepo;
    repo.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void import_electron.ipcRenderer.invoke("codexpp:open-external", `https://github.com/${m.githubRepo}`);
    });
    meta.appendChild(repo);
  }
  if (m.homepage) {
    if (meta.children.length > 0) meta.appendChild(dot());
    const link = document.createElement("a");
    link.href = m.homepage;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "inline-flex text-token-text-link-foreground hover:underline";
    link.textContent = "Homepage";
    meta.appendChild(link);
  }
  if (meta.children.length > 0) stack.appendChild(meta);
  if (m.tags && m.tags.length > 0) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "flex flex-wrap items-center gap-1 pt-0.5";
    for (const tag of m.tags) {
      const pill = document.createElement("span");
      pill.className = "rounded-full border border-token-border bg-token-foreground/5 px-2 py-0.5 text-[11px] text-token-text-secondary";
      pill.textContent = tag;
      tagsRow.appendChild(pill);
    }
    stack.appendChild(tagsRow);
  }
  left.appendChild(stack);
  header.appendChild(left);
  const right = document.createElement("div");
  right.className = "flex shrink-0 items-center gap-2 pt-0.5";
  if (t.update?.updateAvailable && t.update.releaseUrl) {
    right.appendChild(
      compactButton("Review Release", () => {
        void import_electron.ipcRenderer.invoke("codexpp:open-external", t.update.releaseUrl);
      })
    );
  }
  right.appendChild(
    switchControl(t.enabled, async (next) => {
      await import_electron.ipcRenderer.invoke("codexpp:set-tweak-enabled", m.id, next);
    })
  );
  header.appendChild(right);
  cell.appendChild(header);
  if (t.enabled && sections.length > 0) {
    const nested = document.createElement("div");
    nested.className = "flex flex-col divide-y-[0.5px] divide-token-border border-t-[0.5px] border-token-border";
    for (const s of sections) {
      const body = document.createElement("div");
      body.className = "p-3";
      try {
        s.render(body);
      } catch (e) {
        body.textContent = `Error rendering tweak section: ${e.message}`;
      }
      nested.appendChild(body);
    }
    cell.appendChild(nested);
  }
  return cell;
}
function renderAuthor(author) {
  if (!author) return null;
  const wrap = document.createElement("span");
  wrap.className = "inline-flex items-center gap-1";
  if (typeof author === "string") {
    wrap.textContent = `by ${author}`;
    return wrap;
  }
  wrap.appendChild(document.createTextNode("by "));
  if (author.url) {
    const a = document.createElement("a");
    a.href = author.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.className = "inline-flex text-token-text-link-foreground hover:underline";
    a.textContent = author.name;
    wrap.appendChild(a);
  } else {
    const span = document.createElement("span");
    span.textContent = author.name;
    wrap.appendChild(span);
  }
  return wrap;
}
function panelShell(title, subtitle) {
  const outer = document.createElement("div");
  outer.className = "main-surface flex h-full min-h-0 flex-col";
  const toolbar = document.createElement("div");
  toolbar.className = "draggable flex items-center px-panel electron:h-toolbar extension:h-toolbar-sm";
  outer.appendChild(toolbar);
  const scroll = document.createElement("div");
  scroll.className = "flex-1 overflow-y-auto p-panel";
  outer.appendChild(scroll);
  const inner = document.createElement("div");
  inner.className = "mx-auto flex w-full flex-col max-w-2xl electron:min-w-[calc(320px*var(--codex-window-zoom))]";
  scroll.appendChild(inner);
  const headerWrap = document.createElement("div");
  headerWrap.className = "flex items-center justify-between gap-3 pb-panel";
  const headerInner = document.createElement("div");
  headerInner.className = "flex min-w-0 flex-1 flex-col gap-1.5 pb-panel";
  const heading = document.createElement("div");
  heading.className = "electron:heading-lg heading-base truncate";
  heading.textContent = title;
  headerInner.appendChild(heading);
  let subtitleElement;
  if (subtitle) {
    const sub = document.createElement("div");
    sub.className = "text-token-text-secondary text-sm";
    sub.textContent = subtitle;
    headerInner.appendChild(sub);
    subtitleElement = sub;
  }
  headerWrap.appendChild(headerInner);
  inner.appendChild(headerWrap);
  const sectionsWrap = document.createElement("div");
  sectionsWrap.className = "flex flex-col gap-[var(--padding-panel)]";
  inner.appendChild(sectionsWrap);
  return { outer, sectionsWrap, subtitle: subtitleElement };
}
function sectionTitle(text, trailing) {
  const titleRow = document.createElement("div");
  titleRow.className = "flex h-toolbar items-center justify-between gap-2 px-0 py-0";
  const titleInner = document.createElement("div");
  titleInner.className = "flex min-w-0 flex-1 flex-col gap-1";
  const t = document.createElement("div");
  t.className = "text-base font-medium text-token-text-primary";
  t.textContent = text;
  titleInner.appendChild(t);
  titleRow.appendChild(titleInner);
  if (trailing) {
    const right = document.createElement("div");
    right.className = "flex items-center gap-2";
    right.appendChild(trailing);
    titleRow.appendChild(right);
  }
  return titleRow;
}
function openInPlaceButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg text-token-description-foreground enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px]";
  btn.innerHTML = `${label}<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-2xs" aria-hidden="true"><path d="M14.3349 13.3301V6.60645L5.47065 15.4707C5.21095 15.7304 4.78895 15.7304 4.52925 15.4707C4.26955 15.211 4.26955 14.789 4.52925 14.5293L13.3935 5.66504H6.66011C6.29284 5.66504 5.99507 5.36727 5.99507 5C5.99507 4.63273 6.29284 4.33496 6.66011 4.33496H14.9999L15.1337 4.34863C15.4369 4.41057 15.665 4.67857 15.665 5V13.3301C15.6649 13.6973 15.3672 13.9951 14.9999 13.9951C14.6327 13.9951 14.335 13.6973 14.3349 13.3301Z" fill="currentColor"></path></svg>`;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}
function compactButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "border-token-border user-select-none no-drag cursor-interaction inline-flex h-8 items-center whitespace-nowrap rounded-lg border px-2 text-sm text-token-text-primary enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40";
  btn.textContent = label;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}
function roundedCard() {
  const card = document.createElement("div");
  card.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
  card.setAttribute(
    "style",
    "background-color: var(--color-background-panel, var(--color-token-bg-fog));"
  );
  return card;
}
function rowSimple(title, description) {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 items-center gap-3";
  const stack = document.createElement("div");
  stack.className = "flex min-w-0 flex-col gap-1";
  if (title) {
    const t = document.createElement("div");
    t.className = "min-w-0 text-sm text-token-text-primary";
    t.textContent = title;
    stack.appendChild(t);
  }
  if (description) {
    const d = document.createElement("div");
    d.className = "text-token-text-secondary min-w-0 text-sm";
    d.textContent = description;
    stack.appendChild(d);
  }
  left.appendChild(stack);
  row.appendChild(left);
  return row;
}
function switchControl(initial, onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  const pill = document.createElement("span");
  const knob = document.createElement("span");
  knob.className = "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] shadow-sm transition-transform duration-200 ease-out h-4 w-4";
  pill.appendChild(knob);
  const apply = (on) => {
    btn.setAttribute("aria-checked", String(on));
    btn.dataset.state = on ? "checked" : "unchecked";
    btn.className = "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:rounded-full cursor-interaction";
    pill.className = `relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 ease-out h-5 w-8 ${on ? "bg-token-charts-blue" : "bg-token-foreground/20"}`;
    pill.dataset.state = on ? "checked" : "unchecked";
    knob.dataset.state = on ? "checked" : "unchecked";
    knob.style.transform = on ? "translateX(14px)" : "translateX(2px)";
  };
  apply(initial);
  btn.appendChild(pill);
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = btn.getAttribute("aria-checked") !== "true";
    apply(next);
    btn.disabled = true;
    try {
      await onChange(next);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
function dot() {
  const s = document.createElement("span");
  s.className = "text-token-description-foreground";
  s.textContent = "\xB7";
  return s;
}
function configIconSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M3 5h9M15 5h2M3 10h2M8 10h9M3 15h11M17 15h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="13" cy="5" r="1.6" fill="currentColor"/><circle cx="6" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="15" r="1.6" fill="currentColor"/></svg>`;
}
function patchManagerIconSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h7A2.5 2.5 0 0 1 16 5.5v9A2.5 2.5 0 0 1 13.5 17h-7A2.5 2.5 0 0 1 4 14.5v-9Z" stroke="currentColor" stroke-width="1.5"/><path d="M7 7h6M7 10h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M8.25 13.25 9.6 14.6l2.9-3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function tweaksIconSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M10 2.5 L11.4 8.6 L17.5 10 L11.4 11.4 L10 17.5 L8.6 11.4 L2.5 10 L8.6 8.6 Z" fill="currentColor"/><path d="M15.5 3 L16 5 L18 5.5 L16 6 L15.5 8 L15 6 L13 5.5 L15 5 Z" fill="currentColor" opacity="0.7"/></svg>`;
}
function defaultPageIconSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 3v3a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 11h6M7 14h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}
async function resolveIconUrl(url, tweakDir) {
  if (/^(https?:|data:)/.test(url)) return url;
  const rel = url.startsWith("./") ? url.slice(2) : url;
  try {
    return await import_electron.ipcRenderer.invoke(
      "codexpp:read-tweak-asset",
      tweakDir,
      rel
    );
  } catch (e) {
    plog("icon load failed", { url, tweakDir, err: String(e) });
    return null;
  }
}
function findSidebarItemsGroup() {
  const links = Array.from(
    document.querySelectorAll("a[href*='/settings/']")
  );
  if (links.length >= 2) {
    let node = links[0].parentElement;
    while (node) {
      const inside = node.querySelectorAll("a[href*='/settings/']");
      if (inside.length >= Math.max(2, links.length - 1)) return node;
      node = node.parentElement;
    }
  }
  const KNOWN = [
    "General",
    "Appearance",
    "Configuration",
    "Personalization",
    "MCP servers",
    "MCP Servers",
    "Git",
    "Environments"
  ];
  const matches = [];
  const all = document.querySelectorAll(
    "button, a, [role='button'], li, div"
  );
  for (const el2 of Array.from(all)) {
    const t = (el2.textContent ?? "").trim();
    if (t.length > 30) continue;
    if (KNOWN.some((k) => t === k)) matches.push(el2);
    if (matches.length > 50) break;
  }
  if (matches.length >= 2) {
    let node = matches[0].parentElement;
    while (node) {
      let count = 0;
      for (const m of matches) if (node.contains(m)) count++;
      if (count >= Math.min(3, matches.length)) return node;
      node = node.parentElement;
    }
  }
  return null;
}
function findContentArea() {
  const sidebar = findSidebarItemsGroup();
  if (!sidebar) return null;
  let parent = sidebar.parentElement;
  while (parent) {
    for (const child of Array.from(parent.children)) {
      if (child === sidebar || child.contains(sidebar)) continue;
      const r = child.getBoundingClientRect();
      if (r.width > 300 && r.height > 200) return child;
    }
    parent = parent.parentElement;
  }
  return null;
}
function maybeDumpDom() {
  try {
    const sidebar = findSidebarItemsGroup();
    if (sidebar && !state.sidebarDumped) {
      state.sidebarDumped = true;
      const sbRoot = sidebar.parentElement ?? sidebar;
      plog(`codex sidebar HTML`, sbRoot.outerHTML.slice(0, 32e3));
    }
    const content = findContentArea();
    if (!content) {
      if (state.fingerprint !== location.href) {
        state.fingerprint = location.href;
        plog("dom probe (no content)", {
          url: location.href,
          sidebar: sidebar ? describe(sidebar) : null
        });
      }
      return;
    }
    let panel = null;
    for (const child of Array.from(content.children)) {
      if (child.dataset.codexpp === "tweaks-panel") continue;
      if (child.style.display === "none") continue;
      panel = child;
      break;
    }
    const activeNav = sidebar ? Array.from(sidebar.querySelectorAll("button, a")).find(
      (b) => b.getAttribute("aria-current") === "page" || b.getAttribute("data-active") === "true" || b.getAttribute("aria-selected") === "true" || b.classList.contains("active")
    ) : null;
    const heading = panel?.querySelector(
      "h1, h2, h3, [class*='heading']"
    );
    const fingerprint = `${activeNav?.textContent ?? ""}|${heading?.textContent ?? ""}|${panel?.children.length ?? 0}`;
    if (state.fingerprint === fingerprint) return;
    state.fingerprint = fingerprint;
    plog("dom probe", {
      url: location.href,
      activeNav: activeNav?.textContent?.trim() ?? null,
      heading: heading?.textContent?.trim() ?? null,
      content: describe(content)
    });
    if (panel) {
      const html = panel.outerHTML;
      plog(
        `codex panel HTML (${activeNav?.textContent?.trim() ?? "?"})`,
        html.slice(0, 32e3)
      );
    }
  } catch (e) {
    plog("dom probe failed", String(e));
  }
}
function describe(el2) {
  return {
    tag: el2.tagName,
    cls: el2.className.slice(0, 120),
    id: el2.id || void 0,
    children: el2.children.length,
    rect: (() => {
      const r = el2.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })()
  };
}
function tweaksPath() {
  return window.__codexpp_tweaks_dir__ ?? "<user dir>/tweaks";
}

// src/preload/tweak-host.ts
var import_electron2 = require("electron");
var loaded = /* @__PURE__ */ new Map();
var cachedPaths = null;
async function startTweakHost() {
  const tweaks = await import_electron2.ipcRenderer.invoke("codexpp:list-tweaks");
  const paths = await import_electron2.ipcRenderer.invoke("codexpp:user-paths");
  cachedPaths = paths;
  setListedTweaks(tweaks);
  window.__codexpp_tweaks_dir__ = paths.tweaksDir;
  for (const t of tweaks) {
    if (t.manifest.scope === "main") continue;
    if (!t.entryExists) continue;
    if (!t.enabled) continue;
    try {
      await loadTweak(t, paths);
    } catch (e) {
      console.error("[codex-plusplus] tweak load failed:", t.manifest.id, e);
    }
  }
  console.info(
    `[codex-plusplus] renderer host loaded ${loaded.size} tweak(s):`,
    [...loaded.keys()].join(", ") || "(none)"
  );
  import_electron2.ipcRenderer.send(
    "codexpp:preload-log",
    "info",
    `renderer host loaded ${loaded.size} tweak(s): ${[...loaded.keys()].join(", ") || "(none)"}`
  );
}
function teardownTweakHost() {
  for (const [id, t] of loaded) {
    try {
      t.stop?.();
    } catch (e) {
      console.warn("[codex-plusplus] tweak stop failed:", id, e);
    }
  }
  loaded.clear();
  clearSections();
}
async function loadTweak(t, paths) {
  const source = await import_electron2.ipcRenderer.invoke(
    "codexpp:read-tweak-source",
    t.entry
  );
  const module2 = { exports: {} };
  const exports2 = module2.exports;
  const fn = new Function(
    "module",
    "exports",
    "console",
    `${source}
//# sourceURL=codexpp-tweak://${encodeURIComponent(t.manifest.id)}/${encodeURIComponent(t.entry)}`
  );
  fn(module2, exports2, console);
  const mod = module2.exports;
  const tweak = mod.default ?? mod;
  if (typeof tweak?.start !== "function") {
    throw new Error(`tweak ${t.manifest.id} has no start()`);
  }
  const api = makeRendererApi(t.manifest, paths);
  await tweak.start(api);
  loaded.set(t.manifest.id, { stop: tweak.stop?.bind(tweak) });
}
function makeRendererApi(manifest, paths) {
  const id = manifest.id;
  const log = (level, ...a) => {
    const consoleFn = level === "debug" ? console.debug : level === "warn" ? console.warn : level === "error" ? console.error : console.log;
    consoleFn(`[codex-plusplus][${id}]`, ...a);
    try {
      const parts = a.map((v) => {
        if (typeof v === "string") return v;
        if (v instanceof Error) return `${v.name}: ${v.message}`;
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      });
      import_electron2.ipcRenderer.send(
        "codexpp:preload-log",
        level,
        `[tweak ${id}] ${parts.join(" ")}`
      );
    } catch {
    }
  };
  const git = manifest.permissions?.includes("git.metadata") ? rendererGit() : void 0;
  return {
    manifest,
    process: "renderer",
    log: {
      debug: (...a) => log("debug", ...a),
      info: (...a) => log("info", ...a),
      warn: (...a) => log("warn", ...a),
      error: (...a) => log("error", ...a)
    },
    storage: rendererStorage(id),
    settings: {
      register: (s) => registerSection({ ...s, id: `${id}:${s.id}` }),
      registerPage: (p) => registerPage(id, manifest, { ...p, id: `${id}:${p.id}` })
    },
    react: {
      getFiber: (n) => fiberForNode(n),
      findOwnerByName: (n, name) => {
        let f = fiberForNode(n);
        while (f) {
          const t = f.type;
          if (t && (t.displayName === name || t.name === name)) return f;
          f = f.return;
        }
        return null;
      },
      waitForElement: (sel, timeoutMs = 5e3) => new Promise((resolve, reject) => {
        const existing = document.querySelector(sel);
        if (existing) return resolve(existing);
        const deadline = Date.now() + timeoutMs;
        const obs = new MutationObserver(() => {
          const el2 = document.querySelector(sel);
          if (el2) {
            obs.disconnect();
            resolve(el2);
          } else if (Date.now() > deadline) {
            obs.disconnect();
            reject(new Error(`timeout waiting for ${sel}`));
          }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
      })
    },
    ipc: {
      on: (c, h) => {
        const wrapped = (_e, ...args) => h(...args);
        import_electron2.ipcRenderer.on(`codexpp:${id}:${c}`, wrapped);
        return () => import_electron2.ipcRenderer.removeListener(`codexpp:${id}:${c}`, wrapped);
      },
      send: (c, ...args) => import_electron2.ipcRenderer.send(`codexpp:${id}:${c}`, ...args),
      invoke: (c, ...args) => import_electron2.ipcRenderer.invoke(`codexpp:${id}:${c}`, ...args)
    },
    fs: rendererFs(id, paths),
    ...git ? { git } : {}
  };
}
function rendererStorage(id) {
  const key = `codexpp:storage:${id}`;
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      return {};
    }
  };
  const write = (v) => localStorage.setItem(key, JSON.stringify(v));
  return {
    get: (k, d) => k in read() ? read()[k] : d,
    set: (k, v) => {
      const o = read();
      o[k] = v;
      write(o);
    },
    delete: (k) => {
      const o = read();
      delete o[k];
      write(o);
    },
    all: () => read()
  };
}
function rendererFs(id, _paths) {
  return {
    dataDir: `<remote>/tweak-data/${id}`,
    read: (p) => import_electron2.ipcRenderer.invoke("codexpp:tweak-fs", "read", id, p),
    write: (p, c) => import_electron2.ipcRenderer.invoke("codexpp:tweak-fs", "write", id, p, c),
    exists: (p) => import_electron2.ipcRenderer.invoke("codexpp:tweak-fs", "exists", id, p)
  };
}
function rendererGit() {
  return {
    resolveRepository: (path) => import_electron2.ipcRenderer.invoke("codexpp:git-resolve-repository", path),
    getStatus: (path) => import_electron2.ipcRenderer.invoke("codexpp:git-status", path),
    getDiffSummary: (path) => import_electron2.ipcRenderer.invoke("codexpp:git-diff-summary", path),
    getWorktrees: (path) => import_electron2.ipcRenderer.invoke("codexpp:git-worktrees", path)
  };
}

// src/preload/manager.ts
var import_electron3 = require("electron");
async function mountManager() {
  const tweaks = await import_electron3.ipcRenderer.invoke("codexpp:list-tweaks");
  const paths = await import_electron3.ipcRenderer.invoke("codexpp:user-paths");
  registerSection({
    id: "codex-plusplus:manager",
    title: "Tweak Manager",
    description: `${tweaks.length} tweak(s) installed. User dir: ${paths.userRoot}`,
    render(root2) {
      root2.style.cssText = "display:flex;flex-direction:column;gap:8px;";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
      actions.appendChild(
        button(
          "Open tweaks folder",
          () => import_electron3.ipcRenderer.invoke("codexpp:reveal", paths.tweaksDir).catch(() => {
          })
        )
      );
      actions.appendChild(
        button(
          "Open logs",
          () => import_electron3.ipcRenderer.invoke("codexpp:reveal", paths.logDir).catch(() => {
          })
        )
      );
      actions.appendChild(
        button("Reload window", () => location.reload())
      );
      root2.appendChild(actions);
      if (tweaks.length === 0) {
        const empty = document.createElement("p");
        empty.style.cssText = "color:#888;font:13px system-ui;margin:8px 0;";
        empty.textContent = "No user tweaks yet. Drop a folder with manifest.json + index.js into the tweaks dir, then reload.";
        root2.appendChild(empty);
        return;
      }
      const list = document.createElement("ul");
      list.style.cssText = "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;";
      for (const t of tweaks) {
        const li = document.createElement("li");
        li.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border,#2a2a2a);border-radius:6px;";
        const left = document.createElement("div");
        left.innerHTML = `
          <div style="font:600 13px system-ui;">${escape(t.manifest.name)} <span style="color:#888;font-weight:400;">v${escape(t.manifest.version)}</span></div>
          <div style="color:#888;font:12px system-ui;">${escape(t.manifest.description ?? t.manifest.id)}</div>
        `;
        const right = document.createElement("div");
        right.style.cssText = "color:#888;font:12px system-ui;";
        right.textContent = t.entryExists ? "loaded" : "missing entry";
        li.append(left, right);
        list.append(li);
      }
      root2.append(list);
    }
  });
}
function button(label, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = "padding:6px 10px;border:1px solid var(--border,#333);border-radius:6px;background:transparent;color:inherit;font:12px system-ui;cursor:pointer;";
  b.addEventListener("click", onclick);
  return b;
}
function escape(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

// src/preload/app-server-bridge.ts
var import_electron4 = require("electron");
var CODEX_MESSAGE_FROM_VIEW = "codex_desktop:message-from-view";
var CODEX_MESSAGE_FOR_VIEW = "codex_desktop:message-for-view";
var DEFAULT_REQUEST_TIMEOUT_MS = 12e3;
var nextRequestId = 1;
var pendingRequests = /* @__PURE__ */ new Map();
var notificationListeners = /* @__PURE__ */ new Set();
var subscribed = false;
function requestAppServer(method, params, options = {}) {
  ensureSubscribed();
  const id = `codexpp-${Date.now()}-${nextRequestId++}`;
  const hostId = options.hostId ?? readHostId();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timed out waiting for app-server response to ${method}`));
    }, timeoutMs);
    pendingRequests.set(id, {
      id,
      resolve: (value) => resolve(value),
      reject,
      timeout
    });
    const message = {
      type: "mcp-request",
      hostId,
      request: { id, method, params }
    };
    sendMessageFromView(message).then((response) => {
      if (response !== void 0) handleIncomingMessage(response);
    }).catch((error) => {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      pending.reject(toError(error));
    });
  });
}
function onAppServerNotification(listener) {
  ensureSubscribed();
  notificationListeners.add(listener);
  return () => notificationListeners.delete(listener);
}
function readHostId() {
  try {
    const url = new URL(location.href);
    const hostId = url.searchParams.get("hostId")?.trim();
    return hostId || "local";
  } catch {
    return "local";
  }
}
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  import_electron4.ipcRenderer.on(CODEX_MESSAGE_FOR_VIEW, (_event, message) => {
    handleIncomingMessage(message);
  });
  window.addEventListener("message", (event) => {
    handleIncomingMessage(event.data);
  });
}
function handleIncomingMessage(message) {
  const notification = extractNotification(message);
  if (notification) {
    for (const listener of notificationListeners) {
      try {
        listener(notification);
      } catch {
      }
    }
  }
  const response = extractResponse(message);
  if (!response) return;
  const pending = pendingRequests.get(response.id);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingRequests.delete(response.id);
  if (response.error) {
    pending.reject(response.error);
    return;
  }
  pending.resolve(response.result);
}
function extractResponse(message) {
  if (!isRecord(message)) return null;
  if (message.type === "mcp-response" && isRecord(message.response)) {
    return responseFromEnvelope(message.response);
  }
  if (message.type === "mcp-response" && isRecord(message.message)) {
    return responseFromEnvelope(message.message);
  }
  if (message.type === "mcp-error" && typeof message.id === "string") {
    return { id: message.id, error: new Error(readErrorMessage(message.error) ?? "App-server request failed") };
  }
  if (message.type === "response" && typeof message.id === "string") {
    return responseFromEnvelope(message);
  }
  if (typeof message.id === "string" && ("result" in message || "error" in message)) {
    return responseFromEnvelope(message);
  }
  return null;
}
function responseFromEnvelope(envelope) {
  const id = typeof envelope.id === "string" || typeof envelope.id === "number" ? String(envelope.id) : null;
  if (!id) return null;
  if ("error" in envelope) {
    return { id, error: new Error(readErrorMessage(envelope.error) ?? "App-server request failed") };
  }
  return { id, result: envelope.result };
}
function extractNotification(message) {
  if (!isRecord(message)) return null;
  if (message.type === "mcp-notification" && isRecord(message.request)) {
    const method = message.request.method;
    if (typeof method === "string") {
      return { method, params: message.request.params };
    }
  }
  if (message.type === "mcp-notification" && isRecord(message.message)) {
    const method = message.message.method;
    if (typeof method === "string") {
      return { method, params: message.message.params };
    }
  }
  if (message.type === "mcp-notification" && typeof message.method === "string") {
    return { method: message.method, params: message.params };
  }
  if (typeof message.method === "string" && !("id" in message)) {
    return { method: message.method, params: message.params };
  }
  return null;
}
function readErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error)) {
    if (typeof error.message === "string") return error.message;
    if (typeof error.error === "string") return error.error;
  }
  return null;
}
function sendMessageFromView(message) {
  const bridgeSender = window.electronBridge?.sendMessageFromView;
  if (typeof bridgeSender === "function") {
    return bridgeSender.call(window.electronBridge, message).then(() => void 0);
  }
  return import_electron4.ipcRenderer.invoke(CODEX_MESSAGE_FROM_VIEW, message);
}
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/preload/goal-feature.ts
var started = false;
var root = null;
var suggestionRoot = null;
var currentGoal = null;
var hideTimer = null;
var lastThreadId = null;
var lastPanelOptions = null;
var panelDrag = null;
var panelResize = null;
var GOAL_PANEL_STATE_KEY = "codexpp:goal-panel-state";
var GOAL_PANEL_MIN_WIDTH = 280;
var GOAL_PANEL_MIN_HEIGHT = 160;
var GOAL_PANEL_VIEWPORT_MARGIN = 8;
var panelState = readGoalPanelState();
function startGoalFeature(log = () => {
}) {
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
    if (suggestionRoot?.contains(event.target)) return;
    updateGoalSuggestion(findEditableTarget(event));
  }, true);
  window.addEventListener("resize", () => {
    if (!root?.isConnected) return;
    applyGoalPanelSize(root);
    clampGoalPanelToViewport(root);
    applyGoalPanelPosition(root);
  });
  onAppServerNotification((notification) => {
    if (notification.method === "thread/goal/updated" && isRecord2(notification.params)) {
      const goal = notification.params.goal;
      if (isThreadGoal(goal)) {
        if (goal.threadId !== readThreadId()) return;
        currentGoal = goal;
        renderGoal(goal, { transient: false });
      }
      return;
    }
    if (notification.method === "thread/goal/cleared" && isRecord2(notification.params)) {
      const threadId = notification.params.threadId;
      if (typeof threadId === "string" && threadId === readThreadId()) {
        currentGoal = null;
        renderNotice("Goal cleared", "This thread no longer has an active goal.");
      }
    }
  });
  window.addEventListener("popstate", () => refreshGoalForRoute(log));
  const refreshTimer = setInterval(() => refreshGoalForRoute(log), 2500);
  const unref = refreshTimer.unref;
  if (typeof unref === "function") unref.call(refreshTimer);
  queueMicrotask(() => refreshGoalForRoute(log));
  log("goal feature started");
}
async function handleKeydown(event, log) {
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
function parseGoalCommand(text) {
  const match = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { args: (match[1] ?? "").trim() };
}
function parseGoalSuggestion(text) {
  const match = text.trim().match(/^\/([a-z]*)$/i);
  if (!match) return null;
  const query = match[1]?.toLowerCase() ?? "";
  return "goal".startsWith(query) ? { query } : null;
}
async function runGoalCommand(args, log) {
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
    const response2 = await requestAppServer(
      "thread/goal/clear",
      { threadId },
      { hostId }
    );
    currentGoal = null;
    renderNotice(response2.cleared ? "Goal cleared" : "No goal set", "Use /goal <objective> to set a new goal.");
    return;
  }
  if (lower === "pause" || lower === "resume" || lower === "complete") {
    const status = lower === "pause" ? "paused" : lower === "resume" ? "active" : "complete";
    const response2 = await requestAppServer(
      "thread/goal/set",
      { threadId, status },
      { hostId }
    );
    currentGoal = response2.goal;
    renderGoal(response2.goal, { transient: false });
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
  const response = await requestAppServer(
    "thread/goal/set",
    { threadId, objective: args, status: "active" },
    { hostId }
  );
  currentGoal = response.goal;
  log("goal set", { threadId });
  renderGoal(response.goal, { transient: false });
}
async function getGoal(threadId, hostId) {
  const response = await requestAppServer(
    "thread/goal/get",
    { threadId },
    { hostId }
  );
  return response.goal;
}
async function refreshGoalForRoute(log) {
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
    log("goal route refresh skipped", stringifyError(error));
  }
}
function confirmReplaceGoal(existing, nextObjective) {
  return new Promise((resolve) => {
    renderPanel({
      title: "Replace current goal?",
      detail: truncate(existing.objective, 180),
      footer: `New: ${truncate(nextObjective, 180)}`,
      actions: [
        {
          label: "Replace",
          kind: "primary",
          run: () => resolve(true)
        },
        {
          label: "Cancel",
          run: () => resolve(false)
        }
      ],
      persistent: true
    });
  });
}
function renderGoal(goal, options) {
  const status = goalStatusLabel(goal.status);
  const budget = goal.tokenBudget == null ? `${formatNumber(goal.tokensUsed)} tokens` : `${formatNumber(goal.tokensUsed)} / ${formatNumber(goal.tokenBudget)} tokens`;
  renderPanel({
    title: `Goal ${status}`,
    detail: goal.objective,
    footer: `${budget} - ${formatDuration(goal.timeUsedSeconds)}`,
    actions: [
      goal.status === "paused" ? { label: "Resume", kind: "primary", run: () => updateGoalStatus("active") } : { label: "Pause", run: () => updateGoalStatus("paused") },
      { label: "Complete", run: () => updateGoalStatus("complete") },
      { label: "Clear", kind: "danger", run: () => clearCurrentGoal() }
    ],
    persistent: !options.transient
  });
}
function renderNotice(title, detail) {
  renderPanel({ title, detail, actions: [], persistent: false });
}
function renderError(title, detail) {
  renderPanel({ title, detail, actions: [], persistent: false, error: true });
}
function renderPanel(options) {
  lastPanelOptions = options;
  const el2 = ensureRoot();
  if (hideTimer) clearTimeout(hideTimer);
  el2.innerHTML = "";
  el2.className = `codexpp-goal-panel${options.error ? " is-error" : ""}${panelState.collapsed ? " is-collapsed" : ""}`;
  applyGoalPanelSize(el2);
  applyGoalPanelPosition(el2);
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
  el2.appendChild(header);
  if (panelState.collapsed) {
    el2.style.display = "block";
    if (!options.persistent) {
      hideTimer = setTimeout(() => hidePanel(), 8e3);
    }
    return;
  }
  const detail = document.createElement("div");
  detail.className = "codexpp-goal-detail";
  detail.textContent = options.detail;
  el2.appendChild(detail);
  if (options.footer) {
    const footer = document.createElement("div");
    footer.className = "codexpp-goal-footer";
    footer.textContent = options.footer;
    el2.appendChild(footer);
  }
  if (options.actions.length > 0) {
    const actions = document.createElement("div");
    actions.className = "codexpp-goal-actions";
    for (const action of options.actions) {
      const button2 = document.createElement("button");
      button2.type = "button";
      button2.textContent = action.label;
      button2.className = `codexpp-goal-action ${action.kind ?? ""}`;
      button2.addEventListener("click", () => {
        Promise.resolve(action.run()).catch((error) => {
          renderError("Goal action failed", friendlyGoalError(error));
        });
      });
      actions.appendChild(button2);
    }
    el2.appendChild(actions);
  }
  const resize = document.createElement("button");
  resize.className = "codexpp-goal-resize";
  resize.type = "button";
  resize.setAttribute("aria-label", "Resize goal panel");
  resize.addEventListener("pointerdown", startGoalPanelResize);
  resize.addEventListener("keydown", handleGoalPanelResizeKeydown);
  resize.addEventListener("dblclick", resetGoalPanelSize);
  el2.appendChild(resize);
  el2.style.display = "block";
  if (!options.persistent) {
    hideTimer = setTimeout(() => hidePanel(), 8e3);
  }
}
async function updateGoalStatus(status) {
  const threadId = readThreadId() ?? currentGoal?.threadId;
  if (!threadId) return;
  const response = await requestAppServer(
    "thread/goal/set",
    { threadId, status },
    { hostId: readHostId() }
  );
  currentGoal = response.goal;
  renderGoal(response.goal, { transient: false });
}
async function clearCurrentGoal() {
  const threadId = readThreadId() ?? currentGoal?.threadId;
  if (!threadId) return;
  await requestAppServer(
    "thread/goal/clear",
    { threadId },
    { hostId: readHostId() }
  );
  currentGoal = null;
  renderNotice("Goal cleared", "This thread no longer has an active goal.");
}
function ensureRoot() {
  if (root?.isConnected) return root;
  root = document.createElement("div");
  root.id = "codexpp-goal-root";
  root.style.display = "none";
  const parent = document.body || document.documentElement;
  if (parent) parent.appendChild(root);
  return root;
}
function hidePanel() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (root) root.style.display = "none";
}
function startGoalPanelDrag(event) {
  if (event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest("button")) return;
  if (!root) return;
  const rect = root.getBoundingClientRect();
  panelDrag = {
    pointerId: event.pointerId,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height
  };
  root.classList.add("is-dragging");
  event.preventDefault();
  window.addEventListener("pointermove", moveGoalPanel);
  window.addEventListener("pointerup", stopGoalPanelDrag);
}
function moveGoalPanel(event) {
  if (!panelDrag || event.pointerId !== panelDrag.pointerId || !root) return;
  panelState = {
    ...panelState,
    x: clamp(event.clientX - panelDrag.offsetX, 8, window.innerWidth - panelDrag.width - 8),
    y: clamp(event.clientY - panelDrag.offsetY, 8, window.innerHeight - panelDrag.height - 8)
  };
  applyGoalPanelPosition(root);
}
function stopGoalPanelDrag(event) {
  if (panelDrag && event.pointerId !== panelDrag.pointerId) return;
  window.removeEventListener("pointermove", moveGoalPanel);
  window.removeEventListener("pointerup", stopGoalPanelDrag);
  if (root) root.classList.remove("is-dragging");
  panelDrag = null;
  if (root) clampGoalPanelToViewport(root);
  saveGoalPanelState();
}
function startGoalPanelResize(event) {
  if (event.button !== 0 || panelState.collapsed) return;
  if (!root) return;
  const rect = root.getBoundingClientRect();
  ensureExplicitGoalPanelFrame(rect);
  panelResize = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    width: rect.width,
    height: rect.height
  };
  root.classList.add("is-resizing");
  event.preventDefault();
  event.stopPropagation();
  window.addEventListener("pointermove", resizeGoalPanel);
  window.addEventListener("pointerup", stopGoalPanelResize);
}
function resizeGoalPanel(event) {
  if (!panelResize || event.pointerId !== panelResize.pointerId || !root) return;
  const maxWidth = goalPanelMaxWidth();
  const maxHeight = goalPanelMaxHeight();
  panelState = {
    ...panelState,
    width: clamp(panelResize.width + event.clientX - panelResize.startX, GOAL_PANEL_MIN_WIDTH, maxWidth),
    height: clamp(panelResize.height + event.clientY - panelResize.startY, GOAL_PANEL_MIN_HEIGHT, maxHeight)
  };
  applyGoalPanelSize(root);
  clampGoalPanelToViewport(root);
  applyGoalPanelPosition(root);
}
function stopGoalPanelResize(event) {
  if (panelResize && event.pointerId !== panelResize.pointerId) return;
  window.removeEventListener("pointermove", resizeGoalPanel);
  window.removeEventListener("pointerup", stopGoalPanelResize);
  if (root) root.classList.remove("is-resizing");
  panelResize = null;
  saveGoalPanelState();
}
function handleGoalPanelResizeKeydown(event) {
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
    height: clamp((panelState.height ?? rect.height) + heightDelta, GOAL_PANEL_MIN_HEIGHT, goalPanelMaxHeight())
  };
  event.preventDefault();
  event.stopPropagation();
  applyGoalPanelSize(root);
  clampGoalPanelToViewport(root);
  applyGoalPanelPosition(root);
  saveGoalPanelState();
}
function resetGoalPanelSize(event) {
  event.preventDefault();
  event.stopPropagation();
  panelState = { ...panelState, width: null, height: null };
  saveGoalPanelState();
  if (root) {
    applyGoalPanelSize(root);
    applyGoalPanelPosition(root);
  }
}
function resetGoalPanelPosition(event) {
  if (event.target instanceof Element && event.target.closest("button")) return;
  panelState = { ...panelState, x: null, y: null };
  saveGoalPanelState();
  if (root) applyGoalPanelPosition(root);
}
function ensureExplicitGoalPanelFrame(rect) {
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
function applyGoalPanelSize(element) {
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
function applyGoalPanelPosition(element) {
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
function clampGoalPanelToViewport(element) {
  if (panelState.x === null || panelState.y === null) return;
  const rect = element.getBoundingClientRect();
  panelState = {
    ...panelState,
    x: clamp(panelState.x, GOAL_PANEL_VIEWPORT_MARGIN, window.innerWidth - rect.width - GOAL_PANEL_VIEWPORT_MARGIN),
    y: clamp(panelState.y, GOAL_PANEL_VIEWPORT_MARGIN, window.innerHeight - rect.height - GOAL_PANEL_VIEWPORT_MARGIN)
  };
}
function goalPanelMaxWidth() {
  const left = panelState.x ?? GOAL_PANEL_VIEWPORT_MARGIN;
  return Math.max(GOAL_PANEL_MIN_WIDTH, window.innerWidth - left - GOAL_PANEL_VIEWPORT_MARGIN);
}
function goalPanelMaxHeight() {
  const top = panelState.y ?? GOAL_PANEL_VIEWPORT_MARGIN;
  return Math.max(GOAL_PANEL_MIN_HEIGHT, window.innerHeight - top - GOAL_PANEL_VIEWPORT_MARGIN);
}
function readGoalPanelState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GOAL_PANEL_STATE_KEY) ?? "{}");
    return {
      collapsed: parsed.collapsed === true,
      x: typeof parsed.x === "number" && Number.isFinite(parsed.x) ? parsed.x : null,
      y: typeof parsed.y === "number" && Number.isFinite(parsed.y) ? parsed.y : null,
      width: typeof parsed.width === "number" && Number.isFinite(parsed.width) ? parsed.width : null,
      height: typeof parsed.height === "number" && Number.isFinite(parsed.height) ? parsed.height : null
    };
  } catch {
    return { collapsed: false, x: null, y: null, width: null, height: null };
  }
}
function saveGoalPanelState() {
  try {
    localStorage.setItem(GOAL_PANEL_STATE_KEY, JSON.stringify(panelState));
  } catch {
  }
}
function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
function ensureSuggestionRoot() {
  if (suggestionRoot?.isConnected) return suggestionRoot;
  const parent = document.body || document.documentElement;
  if (!parent) return null;
  suggestionRoot = document.createElement("div");
  suggestionRoot.id = "codexpp-goal-suggestion-root";
  suggestionRoot.style.display = "none";
  parent.appendChild(suggestionRoot);
  return suggestionRoot;
}
function updateGoalSuggestion(editable) {
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
function renderGoalSuggestion(editable, query) {
  const el2 = ensureSuggestionRoot();
  if (!el2) return;
  const rect = editable.element.getBoundingClientRect();
  const width = Math.min(420, Math.max(280, rect.width || 320));
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const top = Math.max(12, rect.top - 66);
  el2.innerHTML = "";
  el2.className = "codexpp-goal-suggestion";
  el2.style.left = `${left}px`;
  el2.style.top = `${top}px`;
  el2.style.width = `${width}px`;
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
  el2.appendChild(item);
  el2.style.display = "block";
}
function applyGoalSuggestion(editable) {
  editable.setText("/goal ");
  hideGoalSuggestion();
}
function hideGoalSuggestion() {
  if (suggestionRoot) suggestionRoot.style.display = "none";
}
function installStyles() {
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
function findEditableTarget(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const item of path) {
    if (!(item instanceof HTMLElement)) continue;
    const editable = editableForElement(item);
    if (editable) return editable;
  }
  return event.target instanceof HTMLElement ? editableForElement(event.target) : null;
}
function editableForElement(element) {
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
        } catch {
        }
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      },
      clear: () => {
        element.value = "";
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
    };
  }
  const editable = element.isContentEditable ? element : element.closest('[contenteditable="true"], [role="textbox"]');
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
    }
  };
}
function placeCaretAtEnd(element) {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}
function readThreadId() {
  const candidates = [location.pathname, location.hash, location.href];
  try {
    const url = new URL(location.href);
    const initialRoute = url.searchParams.get("initialRoute");
    if (initialRoute) candidates.push(initialRoute);
  } catch {
  }
  candidates.push(...collectThreadRouteCandidates(history.state));
  candidates.push(...collectDomThreadCandidates());
  for (const candidate of candidates) {
    const threadId = normalizeThreadId(candidate);
    if (threadId) return threadId;
  }
  return null;
}
function normalizeThreadId(value) {
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
function normalizeThreadIdToken(value) {
  const decoded = safeDecode(value).trim();
  const match = decoded.match(/(?:^|:)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
}
function collectDomThreadCandidates() {
  const selectors = [
    '[data-app-action-sidebar-thread-row][data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]',
    '[data-app-action-sidebar-thread-row][aria-current="page"][data-app-action-sidebar-thread-id]',
    '[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]',
    '[data-app-action-sidebar-thread-id][aria-current="page"]'
  ];
  const candidates = [];
  for (const selector of selectors) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const value = element.getAttribute("data-app-action-sidebar-thread-id");
      if (value) candidates.push(value);
    }
  }
  return candidates;
}
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function collectThreadRouteCandidates(value, depth = 0, seen = /* @__PURE__ */ new Set()) {
  if (depth > 5 || value === null || value === void 0 || seen.has(value)) return [];
  if (typeof value === "string") return normalizeThreadId(value) ? [value] : [];
  if (typeof value !== "object") return [];
  seen.add(value);
  const candidates = [];
  for (const child of Object.values(value)) {
    candidates.push(...collectThreadRouteCandidates(child, depth + 1, seen));
  }
  return candidates;
}
function goalStatusLabel(status) {
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
function friendlyGoalError(error) {
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
function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (minutes <= 0) return `${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${remainingSeconds}s`;
  return `${hours}h ${remainingMinutes}m`;
}
function formatNumber(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : "0";
}
function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}
function stringifyError(error) {
  return error instanceof Error ? error.message : String(error);
}
function isThreadGoal(value) {
  return isRecord2(value) && typeof value.threadId === "string" && typeof value.objective === "string" && typeof value.status === "string";
}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/preload/git-sidebar.ts
var import_electron5 = require("electron");
var PROJECT_ROW_SELECTOR = "[data-app-action-sidebar-project-row][data-app-action-sidebar-project-id]";
var ACTIVE_THREAD_SELECTOR = "[data-app-action-sidebar-thread-active='true'],[data-app-action-sidebar-thread-active=true]";
var PROJECT_LIST_SELECTOR = "[data-app-action-sidebar-project-list-id]";
var SUMMARY_ATTR = "data-codexpp-git-summary";
var BADGE_ATTR = "data-codexpp-git-badge";
var STYLE_ID = "codexpp-git-sidebar-style";
var REFRESH_DEBOUNCE_MS = 250;
var STATUS_TTL_MS = 1e4;
var DETAILS_TTL_MS = 15e3;
var MAX_VISIBLE_PROJECT_BADGES = 16;
var MAX_CHANGED_FILES = 7;
var MAX_WORKTREE_ROWS = 3;
var state2 = {
  observer: null,
  refreshTimer: null,
  interval: null,
  runId: 0,
  statusCache: /* @__PURE__ */ new Map(),
  detailsCache: /* @__PURE__ */ new Map()
};
function startGitSidebar() {
  if (state2.observer) return;
  installStyles2();
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
      "data-app-action-sidebar-project-row"
    ]
  });
  state2.observer = observer;
  state2.interval = setInterval(() => scheduleRefresh("interval"), 15e3);
  window.addEventListener("focus", onWindowFocus);
  scheduleRefresh("boot");
}
function onWindowFocus() {
  scheduleRefresh("focus");
}
function shouldReactToMutation(mutation) {
  if (mutation.type === "attributes") {
    const target = mutation.target;
    return target instanceof Element && (target.matches(PROJECT_ROW_SELECTOR) || target.matches(ACTIVE_THREAD_SELECTOR) || target.hasAttribute("data-app-action-sidebar-project-list-id"));
  }
  for (const node of Array.from(mutation.addedNodes)) {
    if (nodeContainsSidebarProject(node)) return true;
  }
  for (const node of Array.from(mutation.removedNodes)) {
    if (nodeContainsSidebarProject(node)) return true;
  }
  return false;
}
function nodeContainsSidebarProject(node) {
  if (!(node instanceof Element)) return false;
  return node.matches(PROJECT_ROW_SELECTOR) || Boolean(node.querySelector(PROJECT_ROW_SELECTOR));
}
function scheduleRefresh(_reason) {
  if (state2.refreshTimer) clearTimeout(state2.refreshTimer);
  state2.refreshTimer = setTimeout(() => {
    state2.refreshTimer = null;
    void refresh();
  }, REFRESH_DEBOUNCE_MS);
}
async function refresh() {
  const runId = ++state2.runId;
  const projects = collectProjectRows();
  if (projects.length === 0) {
    removeSummaryPanel();
    return;
  }
  const activePath = getActiveProjectPath(projects);
  const activeProject = (activePath ? projects.find((project) => project.path === activePath) : null) ?? projects.find((project) => project.row.getAttribute("data-app-action-sidebar-project-collapsed") === "false") ?? projects[0];
  const badgeProjects = prioritizeBadgeProjects(projects, activeProject);
  const badgeStatuses = await Promise.all(
    badgeProjects.map(async (project) => {
      const status2 = await getStatus(project.path);
      return { project, status: status2 };
    })
  );
  if (runId !== state2.runId) return;
  for (const { project, status: status2 } of badgeStatuses) {
    renderProjectBadge(project, status2);
  }
  const summaryProject = badgeStatuses.find(({ project, status: status2 }) => project.path === activeProject?.path && isUsableRepo(status2))?.project ?? badgeStatuses.find(({ status: status2 }) => isUsableRepo(status2))?.project ?? activeProject;
  if (!summaryProject) {
    removeSummaryPanel();
    return;
  }
  const [status, details] = await Promise.all([
    getStatus(summaryProject.path),
    getDetails(summaryProject.path)
  ]);
  if (runId !== state2.runId) return;
  renderSummaryPanel(summaryProject, status, details);
}
function collectProjectRows() {
  const seen = /* @__PURE__ */ new Set();
  const rows = [];
  for (const row of Array.from(document.querySelectorAll(PROJECT_ROW_SELECTOR))) {
    const path = row.getAttribute("data-app-action-sidebar-project-id")?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    rows.push({
      row,
      path,
      label: row.getAttribute("data-app-action-sidebar-project-label")?.trim() || basename(path),
      group: findProjectGroup(row)
    });
  }
  return rows;
}
function findProjectGroup(row) {
  let current = row.parentElement;
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
function getActiveProjectPath(projects) {
  const activeThread = document.querySelector(ACTIVE_THREAD_SELECTOR);
  const projectList = activeThread?.closest(PROJECT_LIST_SELECTOR);
  const listPath = projectList?.getAttribute("data-app-action-sidebar-project-list-id")?.trim();
  if (listPath) return listPath;
  const expanded = projects.find(
    (project) => project.row.getAttribute("data-app-action-sidebar-project-collapsed") === "false"
  );
  return expanded?.path ?? null;
}
function prioritizeBadgeProjects(projects, activeProject) {
  const visible = projects.filter((project) => {
    const rect = project.row.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
  });
  const ordered = activeProject ? [activeProject, ...visible.filter((project) => project.path !== activeProject.path)] : visible;
  return ordered.slice(0, MAX_VISIBLE_PROJECT_BADGES);
}
async function getStatus(path) {
  const now = Date.now();
  const cached = state2.statusCache.get(path);
  if (cached?.value && now - cached.loadedAt < STATUS_TTL_MS) return cached.value;
  if (cached?.pending) return cached.pending;
  const entry = cached ?? {
    value: null,
    error: null,
    loadedAt: 0,
    pending: null
  };
  entry.pending = import_electron5.ipcRenderer.invoke("codexpp:git-status", path).then((status) => {
    entry.value = status;
    entry.error = null;
    entry.loadedAt = Date.now();
    return entry.value;
  }).catch((error) => {
    entry.error = error instanceof Error ? error.message : String(error);
    entry.loadedAt = Date.now();
    return null;
  }).finally(() => {
    entry.pending = null;
  });
  state2.statusCache.set(path, entry);
  return entry.pending;
}
async function getDetails(path) {
  const now = Date.now();
  const cached = state2.detailsCache.get(path);
  if (cached?.value && now - cached.loadedAt < DETAILS_TTL_MS) return cached.value;
  if (cached?.pending) return cached.pending;
  const entry = cached ?? {
    value: null,
    error: null,
    loadedAt: 0,
    pending: null
  };
  entry.pending = Promise.all([
    import_electron5.ipcRenderer.invoke("codexpp:git-diff-summary", path),
    import_electron5.ipcRenderer.invoke("codexpp:git-worktrees", path)
  ]).then(([diff, worktrees]) => {
    entry.value = { diff, worktrees };
    entry.error = null;
    entry.loadedAt = Date.now();
    return entry.value;
  }).catch((error) => {
    entry.error = error instanceof Error ? error.message : String(error);
    entry.loadedAt = Date.now();
    return null;
  }).finally(() => {
    entry.pending = null;
  });
  state2.detailsCache.set(path, entry);
  return entry.pending;
}
function renderProjectBadge(project, status) {
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
    sync.title
  ].filter(Boolean).join(", ");
  badge.textContent = [branch, dirty > 0 ? String(dirty) : "", sync.short].filter(Boolean).join(" ");
}
function ensureBadge(row) {
  const existing = row.querySelector(`[${BADGE_ATTR}]`);
  if (existing) return existing;
  const badge = document.createElement("span");
  badge.setAttribute(BADGE_ATTR, "");
  badge.className = "codexpp-git-project-badge";
  row.appendChild(badge);
  return badge;
}
function renderSummaryPanel(project, status, details) {
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
    metric("conflicts", counts.conflicts)
  );
  panel.append(metrics);
  if (diff) {
    const diffLine = el("div", "codexpp-git-summary-line");
    diffLine.append(
      textEl("span", `${diff.fileCount} file${plural(diff.fileCount)}`),
      textEl("span", `+${diff.insertions}`),
      textEl("span", `-${diff.deletions}`),
      ...diff.truncated ? [textEl("span", "truncated")] : []
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
        textEl("span", basename(worktree.path))
      );
      worktreeList.append(row);
    }
    panel.append(worktreeList);
  }
  const issue = status.repository.error?.message || state2.statusCache.get(project.path)?.error || state2.detailsCache.get(project.path)?.error;
  if (issue) {
    const warning = textEl("div", issue);
    warning.className = "codexpp-git-warning";
    panel.append(warning);
  }
}
function isUsableRepo(status) {
  return Boolean(status?.repository.found && status.repository.isInsideWorkTree);
}
function ensureSummaryPanel(host, row) {
  let panel = document.querySelector(`[${SUMMARY_ATTR}]`);
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
function removeSummaryPanel() {
  document.querySelector(`[${SUMMARY_ATTR}]`)?.remove();
}
function countStatus(entries) {
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
function countDirty(entries) {
  return entries.filter((entry) => entry.kind !== "ignored").length;
}
function countConflicts(entries) {
  return entries.filter((entry) => entry.kind === "unmerged").length;
}
function branchLabel(status) {
  return status.branch.head ?? status.repository.headBranch ?? shortSha(status.branch.oid) ?? shortSha(status.repository.headSha) ?? "detached";
}
function syncLabel(status) {
  const ahead = status.branch.ahead ?? 0;
  const behind = status.branch.behind ?? 0;
  const short = [ahead > 0 ? `A${ahead}` : "", behind > 0 ? `B${behind}` : ""].filter(Boolean).join("/");
  const title = [
    ahead > 0 ? `${ahead} ahead` : "",
    behind > 0 ? `${behind} behind` : "",
    status.branch.upstream ? `upstream ${status.branch.upstream}` : ""
  ].filter(Boolean).join(", ");
  return { short, title };
}
function entryLabel(entry) {
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
function entryPath(entry) {
  if (entry.kind === "rename") return `${entry.originalPath} -> ${entry.path}`;
  return entry.path;
}
function metric(label, value) {
  const item = el("div", "codexpp-git-metric");
  item.append(textEl("span", String(value)), textEl("span", label));
  return item;
}
function shortSha(sha) {
  return sha ? sha.slice(0, 7) : null;
}
function basename(path) {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
function plural(count) {
  return count === 1 ? "" : "s";
}
function clear(node) {
  while (node.firstChild) node.firstChild.remove();
}
function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
function textEl(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}
function installStyles2() {
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

// src/preload/index.ts
function fileLog(stage, extra) {
  const msg = `[codex-plusplus preload] ${stage}${extra === void 0 ? "" : " " + safeStringify2(extra)}`;
  try {
    console.error(msg);
  } catch {
  }
  try {
    import_electron6.ipcRenderer.send("codexpp:preload-log", "info", msg);
  } catch {
  }
}
function safeStringify2(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
fileLog("preload entry", { url: location.href });
try {
  installReactHook();
  fileLog("react hook installed");
} catch (e) {
  fileLog("react hook FAILED", String(e));
}
try {
  startGoalFeature(fileLog);
} catch (e) {
  fileLog("goal feature FAILED", String(e));
}
queueMicrotask(() => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
});
async function boot() {
  fileLog("boot start", { readyState: document.readyState });
  try {
    startSettingsInjector();
    fileLog("settings injector started");
    startGitSidebar();
    fileLog("git sidebar started");
    await startTweakHost();
    fileLog("tweak host started");
    await mountManager();
    fileLog("manager mounted");
    subscribeReload();
    fileLog("boot complete");
  } catch (e) {
    fileLog("boot FAILED", String(e?.stack ?? e));
    console.error("[codex-plusplus] preload boot failed:", e);
  }
}
var reloading = null;
function subscribeReload() {
  import_electron6.ipcRenderer.on("codexpp:tweaks-changed", () => {
    if (reloading) return;
    reloading = (async () => {
      try {
        console.info("[codex-plusplus] hot-reloading tweaks");
        teardownTweakHost();
        await startTweakHost();
        await mountManager();
      } catch (e) {
        console.error("[codex-plusplus] hot reload failed:", e);
      } finally {
        reloading = null;
      }
    })();
  });
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL21hbmFnZXIudHMiLCAiLi4vc3JjL3ByZWxvYWQvYXBwLXNlcnZlci1icmlkZ2UudHMiLCAiLi4vc3JjL3ByZWxvYWQvZ29hbC1mZWF0dXJlLnRzIiwgIi4uL3NyYy9wcmVsb2FkL2dpdC1zaWRlYmFyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlbmRlcmVyIHByZWxvYWQgZW50cnkuIFJ1bnMgaW4gYW4gaXNvbGF0ZWQgd29ybGQgYmVmb3JlIENvZGV4J3MgcGFnZSBKUy5cbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAgIDEuIEluc3RhbGwgYSBSZWFjdCBEZXZUb29scy1zaGFwZWQgZ2xvYmFsIGhvb2sgdG8gY2FwdHVyZSB0aGUgcmVuZGVyZXJcbiAqICAgICAgcmVmZXJlbmNlIHdoZW4gUmVhY3QgbW91bnRzLiBXZSB1c2UgdGhpcyBmb3IgZmliZXIgd2Fsa2luZy5cbiAqICAgMi4gQWZ0ZXIgRE9NQ29udGVudExvYWRlZCwga2ljayBvZmYgc2V0dGluZ3MtaW5qZWN0aW9uIGxvZ2ljLlxuICogICAzLiBEaXNjb3ZlciByZW5kZXJlci1zY29wZWQgdHdlYWtzICh2aWEgSVBDIHRvIG1haW4pIGFuZCBzdGFydCB0aGVtLlxuICogICA0LiBMaXN0ZW4gZm9yIGBjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkYCBmcm9tIG1haW4gKGZpbGVzeXN0ZW0gd2F0Y2hlcikgYW5kXG4gKiAgICAgIGhvdC1yZWxvYWQgdHdlYWtzIHdpdGhvdXQgZHJvcHBpbmcgdGhlIHBhZ2UuXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IGluc3RhbGxSZWFjdEhvb2sgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgeyBzdGFydFNldHRpbmdzSW5qZWN0b3IgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgc3RhcnRUd2Vha0hvc3QsIHRlYXJkb3duVHdlYWtIb3N0IH0gZnJvbSBcIi4vdHdlYWstaG9zdFwiO1xuaW1wb3J0IHsgbW91bnRNYW5hZ2VyIH0gZnJvbSBcIi4vbWFuYWdlclwiO1xuaW1wb3J0IHsgc3RhcnRHb2FsRmVhdHVyZSB9IGZyb20gXCIuL2dvYWwtZmVhdHVyZVwiO1xuaW1wb3J0IHsgc3RhcnRHaXRTaWRlYmFyIH0gZnJvbSBcIi4vZ2l0LXNpZGViYXJcIjtcblxuLy8gRmlsZS1sb2cgcHJlbG9hZCBwcm9ncmVzcyBzbyB3ZSBjYW4gZGlhZ25vc2Ugd2l0aG91dCBEZXZUb29scy4gQmVzdC1lZmZvcnQ6XG4vLyBmYWlsdXJlcyBoZXJlIG11c3QgbmV2ZXIgdGhyb3cgYmVjYXVzZSB3ZSdkIHRha2UgdGhlIHBhZ2UgZG93biB3aXRoIHVzLlxuLy9cbi8vIENvZGV4J3MgcmVuZGVyZXIgaXMgc2FuZGJveGVkIChzYW5kYm94OiB0cnVlKSwgc28gYHJlcXVpcmUoXCJub2RlOmZzXCIpYCBpc1xuLy8gdW5hdmFpbGFibGUuIFdlIGZvcndhcmQgbG9nIGxpbmVzIHRvIG1haW4gdmlhIElQQzsgbWFpbiB3cml0ZXMgdGhlIGZpbGUuXG5mdW5jdGlvbiBmaWxlTG9nKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBgW2NvZGV4LXBsdXNwbHVzIHByZWxvYWRdICR7c3RhZ2V9JHtcbiAgICBleHRyYSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IFwiIFwiICsgc2FmZVN0cmluZ2lmeShleHRyYSlcbiAgfWA7XG4gIHRyeSB7XG4gICAgY29uc29sZS5lcnJvcihtc2cpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChcImNvZGV4cHA6cHJlbG9hZC1sb2dcIiwgXCJpbmZvXCIsIG1zZyk7XG4gIH0gY2F0Y2gge31cbn1cbmZ1bmN0aW9uIHNhZmVTdHJpbmdpZnkodjogdW5rbm93bik6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gU3RyaW5nKHYpO1xuICB9XG59XG5cbmZpbGVMb2coXCJwcmVsb2FkIGVudHJ5XCIsIHsgdXJsOiBsb2NhdGlvbi5ocmVmIH0pO1xuXG4vLyBSZWFjdCBob29rIG11c3QgYmUgaW5zdGFsbGVkICpiZWZvcmUqIENvZGV4J3MgYnVuZGxlIHJ1bnMuXG50cnkge1xuICBpbnN0YWxsUmVhY3RIb29rKCk7XG4gIGZpbGVMb2coXCJyZWFjdCBob29rIGluc3RhbGxlZFwiKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnRyeSB7XG4gIHN0YXJ0R29hbEZlYXR1cmUoZmlsZUxvZyk7XG59IGNhdGNoIChlKSB7XG4gIGZpbGVMb2coXCJnb2FsIGZlYXR1cmUgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnF1ZXVlTWljcm90YXNrKCgpID0+IHtcbiAgaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09IFwibG9hZGluZ1wiKSB7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgYm9vdCwgeyBvbmNlOiB0cnVlIH0pO1xuICB9IGVsc2Uge1xuICAgIGJvb3QoKTtcbiAgfVxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7XG4gIGZpbGVMb2coXCJib290IHN0YXJ0XCIsIHsgcmVhZHlTdGF0ZTogZG9jdW1lbnQucmVhZHlTdGF0ZSB9KTtcbiAgdHJ5IHtcbiAgICBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTtcbiAgICBmaWxlTG9nKFwic2V0dGluZ3MgaW5qZWN0b3Igc3RhcnRlZFwiKTtcbiAgICBzdGFydEdpdFNpZGViYXIoKTtcbiAgICBmaWxlTG9nKFwiZ2l0IHNpZGViYXIgc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgIGZpbGVMb2coXCJ0d2VhayBob3N0IHN0YXJ0ZWRcIik7XG4gICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgZmlsZUxvZyhcIm1hbmFnZXIgbW91bnRlZFwiKTtcbiAgICBzdWJzY3JpYmVSZWxvYWQoKTtcbiAgICBmaWxlTG9nKFwiYm9vdCBjb21wbGV0ZVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZpbGVMb2coXCJib290IEZBSUxFRFwiLCBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSk7XG4gICAgY29uc29sZS5lcnJvcihcIltjb2RleC1wbHVzcGx1c10gcHJlbG9hZCBib290IGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gSG90IHJlbG9hZDogZ2F0ZWQgYmVoaW5kIGEgc21hbGwgaW4tZmxpZ2h0IGxvY2sgc28gYSBmbHVycnkgb2YgZnMgZXZlbnRzXG4vLyBkb2Vzbid0IHJlZW50cmFudGx5IHRlYXIgZG93biB0aGUgaG9zdCBtaWQtbG9hZC5cbmxldCByZWxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcbmZ1bmN0aW9uIHN1YnNjcmliZVJlbG9hZCgpOiB2b2lkIHtcbiAgaXBjUmVuZGVyZXIub24oXCJjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBpZiAocmVsb2FkaW5nKSByZXR1cm47XG4gICAgcmVsb2FkaW5nID0gKGFzeW5jICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUuaW5mbyhcIltjb2RleC1wbHVzcGx1c10gaG90LXJlbG9hZGluZyB0d2Vha3NcIik7XG4gICAgICAgIHRlYXJkb3duVHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IHN0YXJ0VHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IG1vdW50TWFuYWdlcigpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWxvYWRpbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gIH0pO1xufVxuIiwgIi8qKlxuICogSW5zdGFsbCBhIG1pbmltYWwgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fLiBSZWFjdCBjYWxsc1xuICogYGhvb2suaW5qZWN0KHJlbmRlcmVySW50ZXJuYWxzKWAgZHVyaW5nIGBjcmVhdGVSb290YC9gaHlkcmF0ZVJvb3RgLiBUaGVcbiAqIFwiaW50ZXJuYWxzXCIgb2JqZWN0IGV4cG9zZXMgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2UsIHdoaWNoIGxldHMgdXMgdHVybiBhXG4gKiBET00gbm9kZSBpbnRvIGEgUmVhY3QgZmliZXIgXHUyMDE0IG5lY2Vzc2FyeSBmb3Igb3VyIFNldHRpbmdzIGluamVjdG9yLlxuICpcbiAqIFdlIGRvbid0IHdhbnQgdG8gYnJlYWsgcmVhbCBSZWFjdCBEZXZUb29scyBpZiB0aGUgdXNlciBvcGVucyBpdDsgd2UgaW5zdGFsbFxuICogb25seSBpZiBubyBob29rIGV4aXN0cyB5ZXQsIGFuZCB3ZSBmb3J3YXJkIGNhbGxzIHRvIGEgZG93bnN0cmVhbSBob29rIGlmXG4gKiBvbmUgaXMgbGF0ZXIgYXNzaWduZWQuXG4gKi9cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fPzogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgX19jb2RleHBwX18/OiB7XG4gICAgICBob29rOiBSZWFjdERldnRvb2xzSG9vaztcbiAgICAgIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICAgIH07XG4gIH1cbn1cblxuaW50ZXJmYWNlIFJlbmRlcmVySW50ZXJuYWxzIHtcbiAgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2U/OiAobjogTm9kZSkgPT4gdW5rbm93bjtcbiAgdmVyc2lvbj86IHN0cmluZztcbiAgYnVuZGxlVHlwZT86IG51bWJlcjtcbiAgcmVuZGVyZXJQYWNrYWdlTmFtZT86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlYWN0RGV2dG9vbHNIb29rIHtcbiAgc3VwcG9ydHNGaWJlcjogdHJ1ZTtcbiAgcmVuZGVyZXJzOiBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz47XG4gIG9uKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgb2ZmKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgZW1pdChldmVudDogc3RyaW5nLCAuLi5hOiB1bmtub3duW10pOiB2b2lkO1xuICBpbmplY3QocmVuZGVyZXI6IFJlbmRlcmVySW50ZXJuYWxzKTogbnVtYmVyO1xuICBvblNjaGVkdWxlRmliZXJSb290PygpOiB2b2lkO1xuICBvbkNvbW1pdEZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclVubW91bnQ/KCk6IHZvaWQ7XG4gIGNoZWNrRENFPygpOiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFJlYWN0SG9vaygpOiB2b2lkIHtcbiAgaWYgKHdpbmRvdy5fX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18pIHJldHVybjtcbiAgY29uc3QgcmVuZGVyZXJzID0gbmV3IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPigpO1xuICBsZXQgbmV4dElkID0gMTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsIFNldDwoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkPj4oKTtcblxuICBjb25zdCBob29rOiBSZWFjdERldnRvb2xzSG9vayA9IHtcbiAgICBzdXBwb3J0c0ZpYmVyOiB0cnVlLFxuICAgIHJlbmRlcmVycyxcbiAgICBpbmplY3QocmVuZGVyZXIpIHtcbiAgICAgIGNvbnN0IGlkID0gbmV4dElkKys7XG4gICAgICByZW5kZXJlcnMuc2V0KGlkLCByZW5kZXJlcik7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS5kZWJ1ZyhcbiAgICAgICAgXCJbY29kZXgtcGx1c3BsdXNdIFJlYWN0IHJlbmRlcmVyIGF0dGFjaGVkOlwiLFxuICAgICAgICByZW5kZXJlci5yZW5kZXJlclBhY2thZ2VOYW1lLFxuICAgICAgICByZW5kZXJlci52ZXJzaW9uLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBpZDtcbiAgICB9LFxuICAgIG9uKGV2ZW50LCBmbikge1xuICAgICAgbGV0IHMgPSBsaXN0ZW5lcnMuZ2V0KGV2ZW50KTtcbiAgICAgIGlmICghcykgbGlzdGVuZXJzLnNldChldmVudCwgKHMgPSBuZXcgU2V0KCkpKTtcbiAgICAgIHMuYWRkKGZuKTtcbiAgICB9LFxuICAgIG9mZihldmVudCwgZm4pIHtcbiAgICAgIGxpc3RlbmVycy5nZXQoZXZlbnQpPy5kZWxldGUoZm4pO1xuICAgIH0sXG4gICAgZW1pdChldmVudCwgLi4uYXJncykge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmZvckVhY2goKGZuKSA9PiBmbiguLi5hcmdzKSk7XG4gICAgfSxcbiAgICBvbkNvbW1pdEZpYmVyUm9vdCgpIHt9LFxuICAgIG9uQ29tbWl0RmliZXJVbm1vdW50KCkge30sXG4gICAgb25TY2hlZHVsZUZpYmVyUm9vdCgpIHt9LFxuICAgIGNoZWNrRENFKCkge30sXG4gIH07XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX19cIiwge1xuICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICB3cml0YWJsZTogdHJ1ZSwgLy8gYWxsb3cgcmVhbCBEZXZUb29scyB0byBvdmVyd3JpdGUgaWYgdXNlciBpbnN0YWxscyBpdFxuICAgIHZhbHVlOiBob29rLFxuICB9KTtcblxuICB3aW5kb3cuX19jb2RleHBwX18gPSB7IGhvb2ssIHJlbmRlcmVycyB9O1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgUmVhY3QgZmliZXIgZm9yIGEgRE9NIG5vZGUsIGlmIGFueSByZW5kZXJlciBoYXMgb25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpYmVyRm9yTm9kZShub2RlOiBOb2RlKTogdW5rbm93biB8IG51bGwge1xuICBjb25zdCByZW5kZXJlcnMgPSB3aW5kb3cuX19jb2RleHBwX18/LnJlbmRlcmVycztcbiAgaWYgKHJlbmRlcmVycykge1xuICAgIGZvciAoY29uc3QgciBvZiByZW5kZXJlcnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGYgPSByLmZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPy4obm9kZSk7XG4gICAgICBpZiAoZikgcmV0dXJuIGY7XG4gICAgfVxuICB9XG4gIC8vIEZhbGxiYWNrOiByZWFkIHRoZSBSZWFjdCBpbnRlcm5hbCBwcm9wZXJ0eSBkaXJlY3RseSBmcm9tIHRoZSBET00gbm9kZS5cbiAgLy8gUmVhY3Qgc3RvcmVzIGZpYmVycyBhcyBhIHByb3BlcnR5IHdob3NlIGtleSBzdGFydHMgd2l0aCBcIl9fcmVhY3RGaWJlclwiLlxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICBpZiAoay5zdGFydHNXaXRoKFwiX19yZWFjdEZpYmVyXCIpKSByZXR1cm4gKG5vZGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba107XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG4iLCAiLyoqXG4gKiBTZXR0aW5ncyBpbmplY3RvciBmb3IgQ29kZXgncyBTZXR0aW5ncyBwYWdlLlxuICpcbiAqIENvZGV4J3Mgc2V0dGluZ3MgaXMgYSByb3V0ZWQgcGFnZSAoVVJMIHN0YXlzIGF0IGAvaW5kZXguaHRtbD9ob3N0SWQ9bG9jYWxgKVxuICogTk9UIGEgbW9kYWwgZGlhbG9nLiBUaGUgc2lkZWJhciBsaXZlcyBpbnNpZGUgYSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC0xIGdhcC0wXCI+YCB3cmFwcGVyIHRoYXQgaG9sZHMgb25lIG9yIG1vcmUgYDxkaXYgY2xhc3M9XCJmbGV4IGZsZXgtY29sXG4gKiBnYXAtcHhcIj5gIGdyb3VwcyBvZiBidXR0b25zLiBUaGVyZSBhcmUgbm8gc3RhYmxlIGByb2xlYCAvIGBhcmlhLWxhYmVsYCAvXG4gKiBgZGF0YS10ZXN0aWRgIGhvb2tzIG9uIHRoZSBzaGVsbCBzbyB3ZSBpZGVudGlmeSB0aGUgc2lkZWJhciBieSB0ZXh0LWNvbnRlbnRcbiAqIG1hdGNoIGFnYWluc3Qga25vd24gaXRlbSBsYWJlbHMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIENvbmZpZ3VyYXRpb24sIFx1MjAyNikuXG4gKlxuICogTGF5b3V0IHdlIGluamVjdDpcbiAqXG4gKiAgIEdFTkVSQUwgICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFtDb2RleCdzIGV4aXN0aW5nIGl0ZW1zIGdyb3VwXVxuICogICBDT0RFWCsrICAgICAgICAgICAgICAgICAgICAgICAodXBwZXJjYXNlIGdyb3VwIGxhYmVsKVxuICogICBcdTI0RDggQ29uZmlnXG4gKiAgIFx1MjYzMCBUd2Vha3NcbiAqXG4gKiBDbGlja2luZyBDb25maWcgLyBUd2Vha3MgaGlkZXMgQ29kZXgncyBjb250ZW50IHBhbmVsIGNoaWxkcmVuIGFuZCByZW5kZXJzXG4gKiBvdXIgb3duIGBtYWluLXN1cmZhY2VgIHBhbmVsIGluIHRoZWlyIHBsYWNlLiBDbGlja2luZyBhbnkgb2YgQ29kZXgnc1xuICogc2lkZWJhciBpdGVtcyByZXN0b3JlcyB0aGUgb3JpZ2luYWwgdmlldy5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHR5cGUge1xuICBTZXR0aW5nc1NlY3Rpb24sXG4gIFNldHRpbmdzUGFnZSxcbiAgU2V0dGluZ3NIYW5kbGUsXG4gIFR3ZWFrTWFuaWZlc3QsXG59IGZyb20gXCJAY29kZXgtcGx1c3BsdXMvc2RrXCI7XG5cbi8vIE1pcnJvcnMgdGhlIHJ1bnRpbWUncyBtYWluLXNpZGUgTGlzdGVkVHdlYWsgc2hhcGUgKGtlcHQgaW4gc3luYyBtYW51YWxseSkuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICB1cGRhdGU6IFR3ZWFrVXBkYXRlQ2hlY2sgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtVcGRhdGVDaGVjayB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICByZXBvOiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdFRhZzogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvZGV4UGx1c1BsdXNDb25maWcge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGF1dG9VcGRhdGU6IGJvb2xlYW47XG4gIHVwZGF0ZUNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VOb3Rlczogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvZGV4Q2RwU3RhdHVzIHtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgYWN0aXZlOiBib29sZWFuO1xuICBjb25maWd1cmVkUG9ydDogbnVtYmVyO1xuICBhY3RpdmVQb3J0OiBudW1iZXIgfCBudWxsO1xuICByZXN0YXJ0UmVxdWlyZWQ6IGJvb2xlYW47XG4gIHNvdXJjZTogXCJhcmd2XCIgfCBcImVudlwiIHwgXCJjb25maWdcIiB8IFwib2ZmXCI7XG4gIGpzb25MaXN0VXJsOiBzdHJpbmcgfCBudWxsO1xuICBqc29uVmVyc2lvblVybDogc3RyaW5nIHwgbnVsbDtcbiAgbGF1bmNoQ29tbWFuZDogc3RyaW5nO1xuICBhcHBSb290OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgQXBwU2VydmVyRmxvd1RhcFN0YXR1cyB7XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgYWN0aXZlOiBib29sZWFuO1xuICBzb3VyY2U6IFwiZW52XCIgfCBcImNvbmZpZ1wiIHwgXCJvZmZcIjtcbiAgbG9nUGF0aDogc3RyaW5nO1xuICBhY3RpdmVQaWRzOiBudW1iZXJbXTtcbiAgY2hpbGRDb3VudDogbnVtYmVyO1xuICBjYXB0dXJlZE1lc3NhZ2VzOiBudW1iZXI7XG4gIGxhc3RFdmVudEF0OiBzdHJpbmcgfCBudWxsO1xuICByYXdQYXlsb2FkczogYm9vbGVhbjtcbiAgZHJvcHBlZExvZ0xpbmVzOiBudW1iZXI7XG4gIGxvZ1NpemVCeXRlczogbnVtYmVyIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGgge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3VtbWFyeTogc3RyaW5nO1xuICB3YXRjaGVyOiBzdHJpbmc7XG4gIGNoZWNrczogV2F0Y2hlckhlYWx0aENoZWNrW107XG59XG5cbmludGVyZmFjZSBXYXRjaGVySGVhbHRoQ2hlY2sge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCI7XG4gIGRldGFpbDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUGF0Y2hNYW5hZ2VyU3RhdHVzIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIGN1cnJlbnRDaGFubmVsOiBcInN0YWJsZVwiIHwgXCJiZXRhXCIgfCBcInVua25vd25cIjtcbiAgY3VycmVudFVzZXJSb290OiBzdHJpbmc7XG4gIGNoYW5uZWxzOiBQYXRjaENoYW5uZWxTdGF0dXNbXTtcbn1cblxuaW50ZXJmYWNlIFBhdGNoQ2hhbm5lbFN0YXR1cyB7XG4gIGNoYW5uZWw6IFwic3RhYmxlXCIgfCBcImJldGFcIjtcbiAgbGFiZWw6IHN0cmluZztcbiAgY3VycmVudDogYm9vbGVhbjtcbiAgdXNlclJvb3Q6IHN0cmluZztcbiAgc3RhdGVQYXRoOiBzdHJpbmc7XG4gIGNvbmZpZ1BhdGg6IHN0cmluZztcbiAgYXBwUm9vdDogc3RyaW5nO1xuICBhcHBFeGlzdHM6IGJvb2xlYW47XG4gIHN0YXRlRXhpc3RzOiBib29sZWFuO1xuICBjb2RleFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIGNvZGV4UGx1c1BsdXNWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICBidW5kbGVJZDogc3RyaW5nIHwgbnVsbDtcbiAgd2F0Y2hlcjogc3RyaW5nIHwgbnVsbDtcbiAgd2F0Y2hlckxhYmVsOiBzdHJpbmc7XG4gIHdhdGNoZXJMb2FkZWQ6IGJvb2xlYW4gfCBudWxsO1xuICBydW50aW1lUHJlbG9hZFBhdGg6IHN0cmluZztcbiAgcnVudGltZVByZWxvYWRFeGlzdHM6IGJvb2xlYW47XG4gIHJ1bnRpbWVQcmVsb2FkQnl0ZXM6IG51bWJlciB8IG51bGw7XG4gIHJ1bnRpbWVVcGRhdGVkQXQ6IHN0cmluZyB8IG51bGw7XG4gIGF1dG9VcGRhdGU6IGJvb2xlYW47XG4gIGNkcDogUGF0Y2hDZHBTdGF0dXM7XG4gIGNvbW1hbmRzOiBQYXRjaENoYW5uZWxDb21tYW5kcztcbn1cblxuaW50ZXJmYWNlIFBhdGNoQ2RwU3RhdHVzIHtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgY29uZmlndXJlZFBvcnQ6IG51bWJlcjtcbiAgZXhwZWN0ZWRQb3J0OiBudW1iZXI7XG4gIGFjdGl2ZVBvcnQ6IG51bWJlciB8IG51bGw7XG4gIGFjdGl2ZTogYm9vbGVhbjtcbiAgZHJpZnQ6IGJvb2xlYW47XG4gIGpzb25MaXN0VXJsOiBzdHJpbmcgfCBudWxsO1xuICBqc29uVmVyc2lvblVybDogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFBhdGNoQ2hhbm5lbENvbW1hbmRzIHtcbiAgcmVwYWlyOiBzdHJpbmc7XG4gIHJlb3BlbldpdGhDZHA6IHN0cmluZztcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIHVwZGF0ZUNvZGV4OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQSB0d2Vhay1yZWdpc3RlcmVkIHBhZ2UuIFdlIGNhcnJ5IHRoZSBvd25pbmcgdHdlYWsncyBtYW5pZmVzdCBzbyB3ZSBjYW5cbiAqIHJlc29sdmUgcmVsYXRpdmUgaWNvblVybHMgYW5kIHNob3cgYXV0aG9yc2hpcCBpbiB0aGUgcGFnZSBoZWFkZXIuXG4gKi9cbmludGVyZmFjZSBSZWdpc3RlcmVkUGFnZSB7XG4gIC8qKiBGdWxseS1xdWFsaWZpZWQgaWQ6IGA8dHdlYWtJZD46PHBhZ2VJZD5gLiAqL1xuICBpZDogc3RyaW5nO1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBwYWdlOiBTZXR0aW5nc1BhZ2U7XG4gIC8qKiBQZXItcGFnZSBET00gdGVhcmRvd24gcmV0dXJuZWQgYnkgYHBhZ2UucmVuZGVyYCwgaWYgYW55LiAqL1xuICB0ZWFyZG93bj86ICgoKSA9PiB2b2lkKSB8IG51bGw7XG4gIC8qKiBUaGUgaW5qZWN0ZWQgc2lkZWJhciBidXR0b24gKHNvIHdlIGNhbiB1cGRhdGUgaXRzIGFjdGl2ZSBzdGF0ZSkuICovXG4gIG5hdkJ1dHRvbj86IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbn1cblxuLyoqIFdoYXQgcGFnZSBpcyBjdXJyZW50bHkgc2VsZWN0ZWQgaW4gb3VyIGluamVjdGVkIG5hdi4gKi9cbnR5cGUgQWN0aXZlUGFnZSA9XG4gIHwgeyBraW5kOiBcImNvbmZpZ1wiIH1cbiAgfCB7IGtpbmQ6IFwicGF0Y2gtbWFuYWdlclwiIH1cbiAgfCB7IGtpbmQ6IFwidHdlYWtzXCIgfVxuICB8IHsga2luZDogXCJyZWdpc3RlcmVkXCI7IGlkOiBzdHJpbmcgfTtcblxuaW50ZXJmYWNlIEluamVjdG9yU3RhdGUge1xuICBzZWN0aW9uczogTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uPjtcbiAgcGFnZXM6IE1hcDxzdHJpbmcsIFJlZ2lzdGVyZWRQYWdlPjtcbiAgbGlzdGVkVHdlYWtzOiBMaXN0ZWRUd2Vha1tdO1xuICAvKiogT3V0ZXIgd3JhcHBlciB0aGF0IGhvbGRzIENvZGV4J3MgaXRlbXMgZ3JvdXAgKyBvdXIgaW5qZWN0ZWQgZ3JvdXBzLiAqL1xuICBvdXRlcldyYXBwZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIkdlbmVyYWxcIiBsYWJlbCBmb3IgQ29kZXgncyBuYXRpdmUgc2V0dGluZ3MgZ3JvdXAuICovXG4gIG5hdGl2ZU5hdkhlYWRlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiQ29kZXgrK1wiIG5hdiBncm91cCAoQ29uZmlnL1R3ZWFrcykuICovXG4gIG5hdkdyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG5hdkJ1dHRvbnM6IHtcbiAgICBjb25maWc6IEhUTUxCdXR0b25FbGVtZW50O1xuICAgIHBhdGNoTWFuYWdlcjogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gICAgdHdlYWtzOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgfSB8IG51bGw7XG4gIC8qKiBPdXIgXCJUd2Vha3NcIiBuYXYgZ3JvdXAgKHBlci10d2VhayBwYWdlcykuIENyZWF0ZWQgbGF6aWx5LiAqL1xuICBwYWdlc0dyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHBhZ2VzR3JvdXBLZXk6IHN0cmluZyB8IG51bGw7XG4gIHBhbmVsSG9zdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBvYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGw7XG4gIGZpbmdlcnByaW50OiBzdHJpbmcgfCBudWxsO1xuICBzaWRlYmFyRHVtcGVkOiBib29sZWFuO1xuICBhY3RpdmVQYWdlOiBBY3RpdmVQYWdlIHwgbnVsbDtcbiAgc2lkZWJhclJvb3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgc2lkZWJhclJlc3RvcmVIYW5kbGVyOiAoKGU6IEV2ZW50KSA9PiB2b2lkKSB8IG51bGw7XG4gIHNldHRpbmdzU3VyZmFjZVZpc2libGU6IGJvb2xlYW47XG4gIHNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsO1xufVxuXG5jb25zdCBzdGF0ZTogSW5qZWN0b3JTdGF0ZSA9IHtcbiAgc2VjdGlvbnM6IG5ldyBNYXAoKSxcbiAgcGFnZXM6IG5ldyBNYXAoKSxcbiAgbGlzdGVkVHdlYWtzOiBbXSxcbiAgb3V0ZXJXcmFwcGVyOiBudWxsLFxuICBuYXRpdmVOYXZIZWFkZXI6IG51bGwsXG4gIG5hdkdyb3VwOiBudWxsLFxuICBuYXZCdXR0b25zOiBudWxsLFxuICBwYWdlc0dyb3VwOiBudWxsLFxuICBwYWdlc0dyb3VwS2V5OiBudWxsLFxuICBwYW5lbEhvc3Q6IG51bGwsXG4gIG9ic2VydmVyOiBudWxsLFxuICBmaW5nZXJwcmludDogbnVsbCxcbiAgc2lkZWJhckR1bXBlZDogZmFsc2UsXG4gIGFjdGl2ZVBhZ2U6IG51bGwsXG4gIHNpZGViYXJSb290OiBudWxsLFxuICBzaWRlYmFyUmVzdG9yZUhhbmRsZXI6IG51bGwsXG4gIHNldHRpbmdzU3VyZmFjZVZpc2libGU6IGZhbHNlLFxuICBzZXR0aW5nc1N1cmZhY2VIaWRlVGltZXI6IG51bGwsXG59O1xuXG5mdW5jdGlvbiBwbG9nKG1zZzogc3RyaW5nLCBleHRyYT86IHVua25vd24pOiB2b2lkIHtcbiAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICBcImNvZGV4cHA6cHJlbG9hZC1sb2dcIixcbiAgICBcImluZm9cIixcbiAgICBgW3NldHRpbmdzLWluamVjdG9yXSAke21zZ30ke2V4dHJhID09PSB1bmRlZmluZWQgPyBcIlwiIDogXCIgXCIgKyBzYWZlU3RyaW5naWZ5KGV4dHJhKX1gLFxuICApO1xufVxuZnVuY3Rpb24gc2FmZVN0cmluZ2lmeSh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyB2IDogSlNPTi5zdHJpbmdpZnkodik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBTdHJpbmcodik7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIHB1YmxpYyBBUEkgXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5vYnNlcnZlcikgcmV0dXJuO1xuXG4gIGNvbnN0IG9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICB0cnlJbmplY3QoKTtcbiAgICBtYXliZUR1bXBEb20oKTtcbiAgfSk7XG4gIG9icy5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gIHN0YXRlLm9ic2VydmVyID0gb2JzO1xuXG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9wc3RhdGVcIiwgb25OYXYpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcImhhc2hjaGFuZ2VcIiwgb25OYXYpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25Eb2N1bWVudENsaWNrLCB0cnVlKTtcbiAgZm9yIChjb25zdCBtIG9mIFtcInB1c2hTdGF0ZVwiLCBcInJlcGxhY2VTdGF0ZVwiXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IG9yaWcgPSBoaXN0b3J5W21dO1xuICAgIGhpc3RvcnlbbV0gPSBmdW5jdGlvbiAodGhpczogSGlzdG9yeSwgLi4uYXJnczogUGFyYW1ldGVyczx0eXBlb2Ygb3JpZz4pIHtcbiAgICAgIGNvbnN0IHIgPSBvcmlnLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KGBjb2RleHBwLSR7bX1gKSk7XG4gICAgICByZXR1cm4gcjtcbiAgICB9IGFzIHR5cGVvZiBvcmlnO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKGBjb2RleHBwLSR7bX1gLCBvbk5hdik7XG4gIH1cblxuICB0cnlJbmplY3QoKTtcbiAgbWF5YmVEdW1wRG9tKCk7XG4gIGxldCB0aWNrcyA9IDA7XG4gIGNvbnN0IGludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHRpY2tzKys7XG4gICAgdHJ5SW5qZWN0KCk7XG4gICAgbWF5YmVEdW1wRG9tKCk7XG4gICAgaWYgKHRpY2tzID4gNjApIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWwpO1xuICB9LCA1MDApO1xufVxuXG5mdW5jdGlvbiBvbk5hdigpOiB2b2lkIHtcbiAgc3RhdGUuZmluZ2VycHJpbnQgPSBudWxsO1xuICB0cnlJbmplY3QoKTtcbiAgbWF5YmVEdW1wRG9tKCk7XG59XG5cbmZ1bmN0aW9uIG9uRG9jdW1lbnRDbGljayhlOiBNb3VzZUV2ZW50KTogdm9pZCB7XG4gIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCA/IGUudGFyZ2V0IDogbnVsbDtcbiAgY29uc3QgY29udHJvbCA9IHRhcmdldD8uY2xvc2VzdChcIltyb2xlPSdsaW5rJ10sYnV0dG9uLGFcIik7XG4gIGlmICghKGNvbnRyb2wgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkpIHJldHVybjtcbiAgaWYgKGNvbXBhY3RTZXR0aW5nc1RleHQoY29udHJvbC50ZXh0Q29udGVudCB8fCBcIlwiKSAhPT0gXCJCYWNrIHRvIGFwcFwiKSByZXR1cm47XG4gIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUoZmFsc2UsIFwiYmFjay10by1hcHBcIik7XG4gIH0sIDApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJTZWN0aW9uKHNlY3Rpb246IFNldHRpbmdzU2VjdGlvbik6IFNldHRpbmdzSGFuZGxlIHtcbiAgc3RhdGUuc2VjdGlvbnMuc2V0KHNlY3Rpb24uaWQsIHNlY3Rpb24pO1xuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbiAgcmV0dXJuIHtcbiAgICB1bnJlZ2lzdGVyOiAoKSA9PiB7XG4gICAgICBzdGF0ZS5zZWN0aW9ucy5kZWxldGUoc2VjdGlvbi5pZCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbiAgICB9LFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJTZWN0aW9ucygpOiB2b2lkIHtcbiAgc3RhdGUuc2VjdGlvbnMuY2xlYXIoKTtcbiAgLy8gRHJvcCByZWdpc3RlcmVkIHBhZ2VzIHRvbyBcdTIwMTQgdGhleSdyZSBvd25lZCBieSB0d2Vha3MgdGhhdCBqdXN0IGdvdFxuICAvLyB0b3JuIGRvd24gYnkgdGhlIGhvc3QuIFJ1biBhbnkgdGVhcmRvd25zIGJlZm9yZSBmb3JnZXR0aW5nIHRoZW0uXG4gIGZvciAoY29uc3QgcCBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkge1xuICAgIHRyeSB7XG4gICAgICBwLnRlYXJkb3duPy4oKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwbG9nKFwicGFnZSB0ZWFyZG93biBmYWlsZWRcIiwgeyBpZDogcC5pZCwgZXJyOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuICB9XG4gIHN0YXRlLnBhZ2VzLmNsZWFyKCk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIC8vIElmIHdlIHdlcmUgb24gYSByZWdpc3RlcmVkIHBhZ2UgdGhhdCBubyBsb25nZXIgZXhpc3RzLCBmYWxsIGJhY2sgdG9cbiAgLy8gcmVzdG9yaW5nIENvZGV4J3Mgdmlldy5cbiAgaWYgKFxuICAgIHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmXG4gICAgIXN0YXRlLnBhZ2VzLmhhcyhzdGF0ZS5hY3RpdmVQYWdlLmlkKVxuICApIHtcbiAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gIH0gZWxzZSBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikge1xuICAgIHJlcmVuZGVyKCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWdpc3RlciBhIHR3ZWFrLW93bmVkIHNldHRpbmdzIHBhZ2UuIFRoZSBydW50aW1lIGluamVjdHMgYSBzaWRlYmFyIGVudHJ5XG4gKiB1bmRlciBhIFwiVFdFQUtTXCIgZ3JvdXAgaGVhZGVyICh3aGljaCBhcHBlYXJzIG9ubHkgd2hlbiBhdCBsZWFzdCBvbmUgcGFnZVxuICogaXMgcmVnaXN0ZXJlZCkgYW5kIHJvdXRlcyBjbGlja3MgdG8gdGhlIHBhZ2UncyBgcmVuZGVyKHJvb3QpYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyUGFnZShcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdCxcbiAgcGFnZTogU2V0dGluZ3NQYWdlLFxuKTogU2V0dGluZ3NIYW5kbGUge1xuICBjb25zdCBpZCA9IHBhZ2UuaWQ7IC8vIGFscmVhZHkgbmFtZXNwYWNlZCBieSB0d2Vhay1ob3N0IGFzIGAke3R3ZWFrSWR9OiR7cGFnZS5pZH1gXG4gIGNvbnN0IGVudHJ5OiBSZWdpc3RlcmVkUGFnZSA9IHsgaWQsIHR3ZWFrSWQsIG1hbmlmZXN0LCBwYWdlIH07XG4gIHN0YXRlLnBhZ2VzLnNldChpZCwgZW50cnkpO1xuICBwbG9nKFwicmVnaXN0ZXJQYWdlXCIsIHsgaWQsIHRpdGxlOiBwYWdlLnRpdGxlLCB0d2Vha0lkIH0pO1xuICBzeW5jUGFnZXNHcm91cCgpO1xuICAvLyBJZiB0aGUgdXNlciB3YXMgYWxyZWFkeSBvbiB0aGlzIHBhZ2UgKGhvdCByZWxvYWQpLCByZS1tb3VudCBpdHMgYm9keS5cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIHN0YXRlLmFjdGl2ZVBhZ2UuaWQgPT09IGlkKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHVucmVnaXN0ZXI6ICgpID0+IHtcbiAgICAgIGNvbnN0IGUgPSBzdGF0ZS5wYWdlcy5nZXQoaWQpO1xuICAgICAgaWYgKCFlKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBlLnRlYXJkb3duPy4oKTtcbiAgICAgIH0gY2F0Y2gge31cbiAgICAgIHN0YXRlLnBhZ2VzLmRlbGV0ZShpZCk7XG4gICAgICBzeW5jUGFnZXNHcm91cCgpO1xuICAgICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIHN0YXRlLmFjdGl2ZVBhZ2UuaWQgPT09IGlkKSB7XG4gICAgICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xufVxuXG4vKiogQ2FsbGVkIGJ5IHRoZSB0d2VhayBob3N0IGFmdGVyIGZldGNoaW5nIHRoZSB0d2VhayBsaXN0IGZyb20gbWFpbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRMaXN0ZWRUd2Vha3MobGlzdDogTGlzdGVkVHdlYWtbXSk6IHZvaWQge1xuICBzdGF0ZS5saXN0ZWRUd2Vha3MgPSBsaXN0O1xuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGluamVjdGlvbiBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gdHJ5SW5qZWN0KCk6IHZvaWQge1xuICBjb25zdCBpdGVtc0dyb3VwID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gIGlmICghaXRlbXNHcm91cCkge1xuICAgIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk7XG4gICAgcGxvZyhcInNpZGViYXIgbm90IGZvdW5kXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKSB7XG4gICAgY2xlYXJUaW1lb3V0KHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcik7XG4gICAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gbnVsbDtcbiAgfVxuICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKHRydWUsIFwic2lkZWJhci1mb3VuZFwiKTtcbiAgLy8gQ29kZXgncyBpdGVtcyBncm91cCBsaXZlcyBpbnNpZGUgYW4gb3V0ZXIgd3JhcHBlciB0aGF0J3MgYWxyZWFkeSBzdHlsZWRcbiAgLy8gdG8gaG9sZCBtdWx0aXBsZSBncm91cHMgKGBmbGV4IGZsZXgtY29sIGdhcC0xIGdhcC0wYCkuIFdlIGluamVjdCBvdXJcbiAgLy8gZ3JvdXAgYXMgYSBzaWJsaW5nIHNvIHRoZSBuYXR1cmFsIGdhcC0xIGFjdHMgYXMgb3VyIHZpc3VhbCBzZXBhcmF0b3IuXG4gIGNvbnN0IG91dGVyID0gaXRlbXNHcm91cC5wYXJlbnRFbGVtZW50ID8/IGl0ZW1zR3JvdXA7XG4gIHN0YXRlLnNpZGViYXJSb290ID0gb3V0ZXI7XG4gIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwLCBvdXRlcik7XG5cbiAgaWYgKHN0YXRlLm5hdkdyb3VwICYmIG91dGVyLmNvbnRhaW5zKHN0YXRlLm5hdkdyb3VwKSkge1xuICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgLy8gQ29kZXggcmUtcmVuZGVycyBpdHMgbmF0aXZlIHNpZGViYXIgYnV0dG9ucyBvbiBpdHMgb3duIHN0YXRlIGNoYW5nZXMuXG4gICAgLy8gSWYgb25lIG9mIG91ciBwYWdlcyBpcyBhY3RpdmUsIHJlLXN0cmlwIENvZGV4J3MgYWN0aXZlIHN0eWxpbmcgc29cbiAgICAvLyBHZW5lcmFsIGRvZXNuJ3QgcmVhcHBlYXIgYXMgc2VsZWN0ZWQuXG4gICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwpIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZSh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTaWRlYmFyIHdhcyBlaXRoZXIgZnJlc2hseSBtb3VudGVkIChTZXR0aW5ncyBqdXN0IG9wZW5lZCkgb3IgcmUtbW91bnRlZFxuICAvLyAoY2xvc2VkIGFuZCByZS1vcGVuZWQsIG9yIG5hdmlnYXRlZCBhd2F5IGFuZCBiYWNrKS4gSW4gYWxsIG9mIHRob3NlXG4gIC8vIGNhc2VzIENvZGV4IHJlc2V0cyB0byBpdHMgZGVmYXVsdCBwYWdlIChHZW5lcmFsKSwgYnV0IG91ciBpbi1tZW1vcnlcbiAgLy8gYGFjdGl2ZVBhZ2VgIG1heSBzdGlsbCByZWZlcmVuY2UgdGhlIGxhc3QgdHdlYWsvcGFnZSB0aGUgdXNlciBoYWQgb3BlblxuICAvLyBcdTIwMTQgd2hpY2ggd291bGQgY2F1c2UgdGhhdCBuYXYgYnV0dG9uIHRvIHJlbmRlciB3aXRoIHRoZSBhY3RpdmUgc3R5bGluZ1xuICAvLyBldmVuIHRob3VnaCBDb2RleCBpcyBzaG93aW5nIEdlbmVyYWwuIENsZWFyIGl0IHNvIGBzeW5jUGFnZXNHcm91cGAgL1xuICAvLyBgc2V0TmF2QWN0aXZlYCBzdGFydCBmcm9tIGEgbmV1dHJhbCBzdGF0ZS4gVGhlIHBhbmVsSG9zdCByZWZlcmVuY2UgaXNcbiAgLy8gYWxzbyBzdGFsZSAoaXRzIERPTSB3YXMgZGlzY2FyZGVkIHdpdGggdGhlIHByZXZpb3VzIGNvbnRlbnQgYXJlYSkuXG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlICE9PSBudWxsIHx8IHN0YXRlLnBhbmVsSG9zdCAhPT0gbnVsbCkge1xuICAgIHBsb2coXCJzaWRlYmFyIHJlLW1vdW50IGRldGVjdGVkOyBjbGVhcmluZyBzdGFsZSBhY3RpdmUgc3RhdGVcIiwge1xuICAgICAgcHJldkFjdGl2ZTogc3RhdGUuYWN0aXZlUGFnZSxcbiAgICB9KTtcbiAgICBzdGF0ZS5hY3RpdmVQYWdlID0gbnVsbDtcbiAgICBzdGF0ZS5wYW5lbEhvc3QgPSBudWxsO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEdyb3VwIGNvbnRhaW5lciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgZ3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBncm91cC5kYXRhc2V0LmNvZGV4cHAgPSBcIm5hdi1ncm91cFwiO1xuICBncm91cC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLXB4XCI7XG5cbiAgZ3JvdXAuYXBwZW5kQ2hpbGQoc2lkZWJhckdyb3VwSGVhZGVyKFwiQ29kZXgrK1wiLCBcInB0LTNcIikpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBCdWlsdC1pbiBzaWRlYmFyIGl0ZW1zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBjb25maWdCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJDb25maWdcIiwgY29uZmlnSWNvblN2ZygpKTtcbiAgY29uc3QgcGF0Y2hNYW5hZ2VyQnRuID0gbWFrZVNpZGViYXJJdGVtKFwiUGF0Y2ggTWFuYWdlclwiLCBwYXRjaE1hbmFnZXJJY29uU3ZnKCkpO1xuICBjb25zdCB0d2Vha3NCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJUd2Vha3NcIiwgdHdlYWtzSWNvblN2ZygpKTtcblxuICBjb25maWdCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJjb25maWdcIiB9KTtcbiAgfSk7XG4gIHBhdGNoTWFuYWdlckJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInBhdGNoLW1hbmFnZXJcIiB9KTtcbiAgfSk7XG4gIHR3ZWFrc0J0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInR3ZWFrc1wiIH0pO1xuICB9KTtcblxuICBncm91cC5hcHBlbmRDaGlsZChjb25maWdCdG4pO1xuICBncm91cC5hcHBlbmRDaGlsZChwYXRjaE1hbmFnZXJCdG4pO1xuICBncm91cC5hcHBlbmRDaGlsZCh0d2Vha3NCdG4pO1xuICBvdXRlci5hcHBlbmRDaGlsZChncm91cCk7XG5cbiAgc3RhdGUubmF2R3JvdXAgPSBncm91cDtcbiAgc3RhdGUubmF2QnV0dG9ucyA9IHsgY29uZmlnOiBjb25maWdCdG4sIHBhdGNoTWFuYWdlcjogcGF0Y2hNYW5hZ2VyQnRuLCB0d2Vha3M6IHR3ZWFrc0J0biB9O1xuICBwbG9nKFwibmF2IGdyb3VwIGluamVjdGVkXCIsIHsgb3V0ZXJUYWc6IG91dGVyLnRhZ05hbWUgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwOiBIVE1MRWxlbWVudCwgb3V0ZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF0aXZlTmF2SGVhZGVyKSkgcmV0dXJuO1xuICBpZiAob3V0ZXIgPT09IGl0ZW1zR3JvdXApIHJldHVybjtcblxuICBjb25zdCBoZWFkZXIgPSBzaWRlYmFyR3JvdXBIZWFkZXIoXCJHZW5lcmFsXCIpO1xuICBoZWFkZXIuZGF0YXNldC5jb2RleHBwID0gXCJuYXRpdmUtbmF2LWhlYWRlclwiO1xuICBvdXRlci5pbnNlcnRCZWZvcmUoaGVhZGVyLCBpdGVtc0dyb3VwKTtcbiAgc3RhdGUubmF0aXZlTmF2SGVhZGVyID0gaGVhZGVyO1xufVxuXG5mdW5jdGlvbiBzaWRlYmFyR3JvdXBIZWFkZXIodGV4dDogc3RyaW5nLCB0b3BQYWRkaW5nID0gXCJwdC0yXCIpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPVxuICAgIGBweC1yb3cteCAke3RvcFBhZGRpbmd9IHBiLTEgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdXBwZXJjYXNlIHRyYWNraW5nLXdpZGVyIHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZCBzZWxlY3Qtbm9uZWA7XG4gIGhlYWRlci50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk6IHZvaWQge1xuICBpZiAoIXN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgfHwgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKSByZXR1cm47XG4gIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gICAgaWYgKGZpbmRTaWRlYmFySXRlbXNHcm91cCgpKSByZXR1cm47XG4gICAgaWYgKGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpKSByZXR1cm47XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJzaWRlYmFyLW5vdC1mb3VuZFwiKTtcbiAgfSwgMTUwMCk7XG59XG5cbmZ1bmN0aW9uIGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpOiBib29sZWFuIHtcbiAgY29uc3QgdGV4dCA9IGNvbXBhY3RTZXR0aW5nc1RleHQoZG9jdW1lbnQuYm9keT8udGV4dENvbnRlbnQgfHwgXCJcIikudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIChcbiAgICB0ZXh0LmluY2x1ZGVzKFwiYmFjayB0byBhcHBcIikgJiZcbiAgICB0ZXh0LmluY2x1ZGVzKFwiZ2VuZXJhbFwiKSAmJlxuICAgIHRleHQuaW5jbHVkZXMoXCJhcHBlYXJhbmNlXCIpICYmXG4gICAgKHRleHQuaW5jbHVkZXMoXCJjb25maWd1cmF0aW9uXCIpIHx8IHRleHQuaW5jbHVkZXMoXCJkZWZhdWx0IHBlcm1pc3Npb25zXCIpKVxuICApO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0U2V0dGluZ3NUZXh0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh2aXNpYmxlOiBib29sZWFuLCByZWFzb246IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9PT0gdmlzaWJsZSkgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgdHJ5IHtcbiAgICAod2luZG93IGFzIFdpbmRvdyAmIHsgX19jb2RleHBwU2V0dGluZ3NTdXJmYWNlVmlzaWJsZT86IGJvb2xlYW4gfSkuX19jb2RleHBwU2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9IHZpc2libGU7XG4gICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQuY29kZXhwcFNldHRpbmdzU3VyZmFjZSA9IHZpc2libGUgPyBcInRydWVcIiA6IFwiZmFsc2VcIjtcbiAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChcbiAgICAgIG5ldyBDdXN0b21FdmVudChcImNvZGV4cHA6c2V0dGluZ3Mtc3VyZmFjZVwiLCB7XG4gICAgICAgIGRldGFpbDogeyB2aXNpYmxlLCByZWFzb24gfSxcbiAgICAgIH0pLFxuICAgICk7XG4gIH0gY2F0Y2gge31cbiAgcGxvZyhcInNldHRpbmdzIHN1cmZhY2VcIiwgeyB2aXNpYmxlLCByZWFzb24sIHVybDogbG9jYXRpb24uaHJlZiB9KTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgKG9yIHJlLXJlbmRlcikgdGhlIHNlY29uZCBzaWRlYmFyIGdyb3VwIG9mIHBlci10d2VhayBwYWdlcy4gVGhlXG4gKiBncm91cCBpcyBjcmVhdGVkIGxhemlseSBhbmQgcmVtb3ZlZCB3aGVuIHRoZSBsYXN0IHBhZ2UgdW5yZWdpc3RlcnMsIHNvXG4gKiB1c2VycyB3aXRoIG5vIHBhZ2UtcmVnaXN0ZXJpbmcgdHdlYWtzIG5ldmVyIHNlZSBhbiBlbXB0eSBcIlR3ZWFrc1wiIGhlYWRlci5cbiAqL1xuZnVuY3Rpb24gc3luY1BhZ2VzR3JvdXAoKTogdm9pZCB7XG4gIGNvbnN0IG91dGVyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghb3V0ZXIpIHJldHVybjtcbiAgY29uc3QgcGFnZXMgPSBbLi4uc3RhdGUucGFnZXMudmFsdWVzKCldO1xuXG4gIC8vIEJ1aWxkIGEgZGV0ZXJtaW5pc3RpYyBmaW5nZXJwcmludCBvZiB0aGUgZGVzaXJlZCBncm91cCBzdGF0ZS4gSWYgdGhlXG4gIC8vIGN1cnJlbnQgRE9NIGdyb3VwIGFscmVhZHkgbWF0Y2hlcywgdGhpcyBpcyBhIG5vLW9wIFx1MjAxNCBjcml0aWNhbCwgYmVjYXVzZVxuICAvLyBzeW5jUGFnZXNHcm91cCBpcyBjYWxsZWQgb24gZXZlcnkgTXV0YXRpb25PYnNlcnZlciB0aWNrIGFuZCBhbnkgRE9NXG4gIC8vIHdyaXRlIHdvdWxkIHJlLXRyaWdnZXIgdGhhdCBvYnNlcnZlciAoaW5maW5pdGUgbG9vcCwgYXBwIGZyZWV6ZSkuXG4gIGNvbnN0IGRlc2lyZWRLZXkgPSBwYWdlcy5sZW5ndGggPT09IDBcbiAgICA/IFwiRU1QVFlcIlxuICAgIDogcGFnZXMubWFwKChwKSA9PiBgJHtwLmlkfXwke3AucGFnZS50aXRsZX18JHtwLnBhZ2UuaWNvblN2ZyA/PyBcIlwifWApLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IGdyb3VwQXR0YWNoZWQgPSAhIXN0YXRlLnBhZ2VzR3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUucGFnZXNHcm91cCk7XG4gIGlmIChzdGF0ZS5wYWdlc0dyb3VwS2V5ID09PSBkZXNpcmVkS2V5ICYmIChwYWdlcy5sZW5ndGggPT09IDAgPyAhZ3JvdXBBdHRhY2hlZCA6IGdyb3VwQXR0YWNoZWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwKSB7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwLnJlbW92ZSgpO1xuICAgICAgc3RhdGUucGFnZXNHcm91cCA9IG51bGw7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcCBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkgcC5uYXZCdXR0b24gPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBkZXNpcmVkS2V5O1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxldCBncm91cCA9IHN0YXRlLnBhZ2VzR3JvdXA7XG4gIGlmICghZ3JvdXAgfHwgIW91dGVyLmNvbnRhaW5zKGdyb3VwKSkge1xuICAgIGdyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBncm91cC5kYXRhc2V0LmNvZGV4cHAgPSBcInBhZ2VzLWdyb3VwXCI7XG4gICAgZ3JvdXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1weFwiO1xuICAgIGdyb3VwLmFwcGVuZENoaWxkKHNpZGViYXJHcm91cEhlYWRlcihcIlR3ZWFrc1wiLCBcInB0LTNcIikpO1xuICAgIG91dGVyLmFwcGVuZENoaWxkKGdyb3VwKTtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwID0gZ3JvdXA7XG4gIH0gZWxzZSB7XG4gICAgLy8gU3RyaXAgcHJpb3IgYnV0dG9ucyAoa2VlcCB0aGUgaGVhZGVyIGF0IGluZGV4IDApLlxuICAgIHdoaWxlIChncm91cC5jaGlsZHJlbi5sZW5ndGggPiAxKSBncm91cC5yZW1vdmVDaGlsZChncm91cC5sYXN0Q2hpbGQhKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgcCBvZiBwYWdlcykge1xuICAgIGNvbnN0IGljb24gPSBwLnBhZ2UuaWNvblN2ZyA/PyBkZWZhdWx0UGFnZUljb25TdmcoKTtcbiAgICBjb25zdCBidG4gPSBtYWtlU2lkZWJhckl0ZW0ocC5wYWdlLnRpdGxlLCBpY29uKTtcbiAgICBidG4uZGF0YXNldC5jb2RleHBwID0gYG5hdi1wYWdlLSR7cC5pZH1gO1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IHAuaWQgfSk7XG4gICAgfSk7XG4gICAgcC5uYXZCdXR0b24gPSBidG47XG4gICAgZ3JvdXAuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgfVxuICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gZGVzaXJlZEtleTtcbiAgcGxvZyhcInBhZ2VzIGdyb3VwIHN5bmNlZFwiLCB7XG4gICAgY291bnQ6IHBhZ2VzLmxlbmd0aCxcbiAgICBpZHM6IHBhZ2VzLm1hcCgocCkgPT4gcC5pZCksXG4gIH0pO1xuICAvLyBSZWZsZWN0IGN1cnJlbnQgYWN0aXZlIHN0YXRlIGFjcm9zcyB0aGUgcmVidWlsdCBidXR0b25zLlxuICBzZXROYXZBY3RpdmUoc3RhdGUuYWN0aXZlUGFnZSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VTaWRlYmFySXRlbShsYWJlbDogc3RyaW5nLCBpY29uU3ZnOiBzdHJpbmcpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIC8vIENsYXNzIHN0cmluZyBjb3BpZWQgdmVyYmF0aW0gZnJvbSBDb2RleCdzIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCBldGMpLlxuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5kYXRhc2V0LmNvZGV4cHAgPSBgbmF2LSR7bGFiZWwudG9Mb3dlckNhc2UoKX1gO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiZm9jdXMtdmlzaWJsZTpvdXRsaW5lLXRva2VuLWJvcmRlciByZWxhdGl2ZSBweC1yb3cteCBweS1yb3cteSBjdXJzb3ItaW50ZXJhY3Rpb24gc2hyaW5rLTAgaXRlbXMtY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIHRleHQtbGVmdCB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZSBmb2N1cy12aXNpYmxlOm91dGxpbmUtMiBmb2N1cy12aXNpYmxlOm91dGxpbmUtb2Zmc2V0LTIgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNTAgZ2FwLTIgZmxleCB3LWZ1bGwgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvbnQtbm9ybWFsXCI7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBpbm5lci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciB0ZXh0LWJhc2UgZ2FwLTIgZmxleC0xIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICBpbm5lci5pbm5lckhUTUwgPSBgJHtpY29uU3ZnfTxzcGFuIGNsYXNzPVwidHJ1bmNhdGVcIj4ke2xhYmVsfTwvc3Bhbj5gO1xuICBidG4uYXBwZW5kQ2hpbGQoaW5uZXIpO1xuICByZXR1cm4gYnRuO1xufVxuXG4vKiogSW50ZXJuYWwga2V5IGZvciB0aGUgYnVpbHQtaW4gbmF2IGJ1dHRvbnMuICovXG50eXBlIEJ1aWx0aW5QYWdlID0gXCJjb25maWdcIiB8IFwicGF0Y2hNYW5hZ2VyXCIgfCBcInR3ZWFrc1wiO1xuXG5mdW5jdGlvbiBzZXROYXZBY3RpdmUoYWN0aXZlOiBBY3RpdmVQYWdlIHwgbnVsbCk6IHZvaWQge1xuICAvLyBCdWlsdC1pbiAoQ29uZmlnL1R3ZWFrcykgYnV0dG9ucy5cbiAgaWYgKHN0YXRlLm5hdkJ1dHRvbnMpIHtcbiAgICBjb25zdCBidWlsdGluOiBCdWlsdGluUGFnZSB8IG51bGwgPVxuICAgICAgYWN0aXZlPy5raW5kID09PSBcImNvbmZpZ1wiID8gXCJjb25maWdcIiA6XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwicGF0Y2gtbWFuYWdlclwiID8gXCJwYXRjaE1hbmFnZXJcIiA6XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwidHdlYWtzXCIgPyBcInR3ZWFrc1wiIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGJ0bl0gb2YgT2JqZWN0LmVudHJpZXMoc3RhdGUubmF2QnV0dG9ucykgYXMgW0J1aWx0aW5QYWdlLCBIVE1MQnV0dG9uRWxlbWVudF1bXSkge1xuICAgICAgYXBwbHlOYXZBY3RpdmUoYnRuLCBrZXkgPT09IGJ1aWx0aW4pO1xuICAgIH1cbiAgfVxuICAvLyBQZXItcGFnZSByZWdpc3RlcmVkIGJ1dHRvbnMuXG4gIGZvciAoY29uc3QgcCBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkge1xuICAgIGlmICghcC5uYXZCdXR0b24pIGNvbnRpbnVlO1xuICAgIGNvbnN0IGlzQWN0aXZlID0gYWN0aXZlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBhY3RpdmUuaWQgPT09IHAuaWQ7XG4gICAgYXBwbHlOYXZBY3RpdmUocC5uYXZCdXR0b24sIGlzQWN0aXZlKTtcbiAgfVxuICAvLyBDb2RleCdzIG93biBzaWRlYmFyIGJ1dHRvbnMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIGV0YykuIFdoZW4gb25lIG9mXG4gIC8vIG91ciBwYWdlcyBpcyBhY3RpdmUsIENvZGV4IHN0aWxsIGhhcyBhcmlhLWN1cnJlbnQ9XCJwYWdlXCIgYW5kIHRoZVxuICAvLyBhY3RpdmUtYmcgY2xhc3Mgb24gd2hpY2hldmVyIGl0ZW0gaXQgY29uc2lkZXJlZCB0aGUgcm91dGUgXHUyMDE0IHR5cGljYWxseVxuICAvLyBHZW5lcmFsLiBUaGF0IG1ha2VzIGJvdGggYnV0dG9ucyBsb29rIHNlbGVjdGVkLiBTdHJpcCBDb2RleCdzIGFjdGl2ZVxuICAvLyBzdHlsaW5nIHdoaWxlIG9uZSBvZiBvdXJzIGlzIGFjdGl2ZTsgcmVzdG9yZSBpdCB3aGVuIG5vbmUgaXMuXG4gIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShhY3RpdmUgIT09IG51bGwpO1xufVxuXG4vKipcbiAqIE11dGUgQ29kZXgncyBvd24gYWN0aXZlLXN0YXRlIHN0eWxpbmcgb24gaXRzIHNpZGViYXIgYnV0dG9ucy4gV2UgZG9uJ3RcbiAqIHRvdWNoIENvZGV4J3MgUmVhY3Qgc3RhdGUgXHUyMDE0IHdoZW4gdGhlIHVzZXIgY2xpY2tzIGEgbmF0aXZlIGl0ZW0sIENvZGV4XG4gKiByZS1yZW5kZXJzIHRoZSBidXR0b25zIGFuZCByZS1hcHBsaWVzIGl0cyBvd24gY29ycmVjdCBzdGF0ZSwgdGhlbiBvdXJcbiAqIHNpZGViYXItY2xpY2sgbGlzdGVuZXIgZmlyZXMgYHJlc3RvcmVDb2RleFZpZXdgICh3aGljaCBjYWxscyBiYWNrIGludG9cbiAqIGBzZXROYXZBY3RpdmUobnVsbClgIGFuZCBsZXRzIENvZGV4J3Mgc3R5bGluZyBzdGFuZCkuXG4gKlxuICogYG11dGU9dHJ1ZWAgIFx1MjE5MiBzdHJpcCBhcmlhLWN1cnJlbnQgYW5kIHN3YXAgYWN0aXZlIGJnIFx1MjE5MiBob3ZlciBiZ1xuICogYG11dGU9ZmFsc2VgIFx1MjE5MiBuby1vcCAoQ29kZXgncyBvd24gcmUtcmVuZGVyIGFscmVhZHkgcmVzdG9yZWQgdGhpbmdzKVxuICovXG5mdW5jdGlvbiBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUobXV0ZTogYm9vbGVhbik6IHZvaWQge1xuICBpZiAoIW11dGUpIHJldHVybjtcbiAgY29uc3Qgcm9vdCA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoIXJvb3QpIHJldHVybjtcbiAgY29uc3QgYnV0dG9ucyA9IEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIGJ1dHRvbnMpIHtcbiAgICAvLyBTa2lwIG91ciBvd24gYnV0dG9ucy5cbiAgICBpZiAoYnRuLmRhdGFzZXQuY29kZXhwcCkgY29udGludWU7XG4gICAgaWYgKGJ0bi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIikgPT09IFwicGFnZVwiKSB7XG4gICAgICBidG4ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpO1xuICAgIH1cbiAgICBpZiAoYnRuLmNsYXNzTGlzdC5jb250YWlucyhcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKSkge1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LmFkZChcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlOYXZBY3RpdmUoYnRuOiBIVE1MQnV0dG9uRWxlbWVudCwgYWN0aXZlOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGlubmVyID0gYnRuLmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGFjdGl2ZSkge1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiLCBcInBhZ2VcIik7XG4gICAgICBpZiAoaW5uZXIpIHtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyXG4gICAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIilcbiAgICAgICAgICA/LmNsYXNzTGlzdC5hZGQoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1pY29uLWZvcmVncm91bmRcIik7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIsIFwiZm9udC1ub3JtYWxcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgICBpZiAoaW5uZXIpIHtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyXG4gICAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIilcbiAgICAgICAgICA/LmNsYXNzTGlzdC5yZW1vdmUoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1pY29uLWZvcmVncm91bmRcIik7XG4gICAgICB9XG4gICAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgYWN0aXZhdGlvbiBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYWN0aXZhdGVQYWdlKHBhZ2U6IEFjdGl2ZVBhZ2UpOiB2b2lkIHtcbiAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICBwbG9nKFwiYWN0aXZhdGU6IGNvbnRlbnQgYXJlYSBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBwYWdlO1xuICBwbG9nKFwiYWN0aXZhdGVcIiwgeyBwYWdlIH0pO1xuXG4gIC8vIEhpZGUgQ29kZXgncyBjb250ZW50IGNoaWxkcmVuLCBzaG93IG91cnMuXG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQuY29kZXhwcCA9PT0gXCJ0d2Vha3MtcGFuZWxcIikgY29udGludWU7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW4gPSBjaGlsZC5zdHlsZS5kaXNwbGF5IHx8IFwiXCI7XG4gICAgfVxuICAgIGNoaWxkLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgfVxuICBsZXQgcGFuZWwgPSBjb250ZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCdbZGF0YS1jb2RleHBwPVwidHdlYWtzLXBhbmVsXCJdJyk7XG4gIGlmICghcGFuZWwpIHtcbiAgICBwYW5lbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcGFuZWwuZGF0YXNldC5jb2RleHBwID0gXCJ0d2Vha3MtcGFuZWxcIjtcbiAgICBwYW5lbC5zdHlsZS5jc3NUZXh0ID0gXCJ3aWR0aDoxMDAlO2hlaWdodDoxMDAlO292ZXJmbG93OmF1dG87XCI7XG4gICAgY29udGVudC5hcHBlbmRDaGlsZChwYW5lbCk7XG4gIH1cbiAgcGFuZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgc3RhdGUucGFuZWxIb3N0ID0gcGFuZWw7XG4gIHJlcmVuZGVyKCk7XG4gIHNldE5hdkFjdGl2ZShwYWdlKTtcbiAgLy8gcmVzdG9yZSBDb2RleCdzIHZpZXcuIFJlLXJlZ2lzdGVyIGlmIG5lZWRlZC5cbiAgY29uc3Qgc2lkZWJhciA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoc2lkZWJhcikge1xuICAgIGlmIChzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICAgIHNpZGViYXIucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciwgdHJ1ZSk7XG4gICAgfVxuICAgIGNvbnN0IGhhbmRsZXIgPSAoZTogRXZlbnQpID0+IHtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgIGlmICghdGFyZ2V0KSByZXR1cm47XG4gICAgICBpZiAoc3RhdGUubmF2R3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIGJ1dHRvbnNcbiAgICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwPy5jb250YWlucyh0YXJnZXQpKSByZXR1cm47IC8vIG91ciBwYWdlIGJ1dHRvbnNcbiAgICAgIGlmICh0YXJnZXQuY2xvc2VzdChcIltkYXRhLWNvZGV4cHAtc2V0dGluZ3Mtc2VhcmNoXVwiKSkgcmV0dXJuO1xuICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgIH07XG4gICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyID0gaGFuZGxlcjtcbiAgICBzaWRlYmFyLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBoYW5kbGVyLCB0cnVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXN0b3JlQ29kZXhWaWV3KCk6IHZvaWQge1xuICBwbG9nKFwicmVzdG9yZSBjb2RleCB2aWV3XCIpO1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkgcmV0dXJuO1xuICBpZiAoc3RhdGUucGFuZWxIb3N0KSBzdGF0ZS5wYW5lbEhvc3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20oY29udGVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgIGlmIChjaGlsZCA9PT0gc3RhdGUucGFuZWxIb3N0KSBjb250aW51ZTtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNoaWxkLnN0eWxlLmRpc3BsYXkgPSBjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW47XG4gICAgICBkZWxldGUgY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuO1xuICAgIH1cbiAgfVxuICBzdGF0ZS5hY3RpdmVQYWdlID0gbnVsbDtcbiAgc2V0TmF2QWN0aXZlKG51bGwpO1xuICBpZiAoc3RhdGUuc2lkZWJhclJvb3QgJiYgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyKSB7XG4gICAgc3RhdGUuc2lkZWJhclJvb3QucmVtb3ZlRXZlbnRMaXN0ZW5lcihcbiAgICAgIFwiY2xpY2tcIixcbiAgICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcixcbiAgICAgIHRydWUsXG4gICAgKTtcbiAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIgPSBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcmVuZGVyKCk6IHZvaWQge1xuICBpZiAoIXN0YXRlLmFjdGl2ZVBhZ2UpIHJldHVybjtcbiAgY29uc3QgaG9zdCA9IHN0YXRlLnBhbmVsSG9zdDtcbiAgaWYgKCFob3N0KSByZXR1cm47XG4gIGhvc3QuaW5uZXJIVE1MID0gXCJcIjtcblxuICBjb25zdCBhcCA9IHN0YXRlLmFjdGl2ZVBhZ2U7XG4gIGlmIChhcC5raW5kID09PSBcInJlZ2lzdGVyZWRcIikge1xuICAgIGNvbnN0IGVudHJ5ID0gc3RhdGUucGFnZXMuZ2V0KGFwLmlkKTtcbiAgICBpZiAoIWVudHJ5KSB7XG4gICAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKGVudHJ5LnBhZ2UudGl0bGUsIGVudHJ5LnBhZ2UuZGVzY3JpcHRpb24pO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQocm9vdC5vdXRlcik7XG4gICAgdHJ5IHtcbiAgICAgIC8vIFRlYXIgZG93biBhbnkgcHJpb3IgcmVuZGVyIGJlZm9yZSByZS1yZW5kZXJpbmcgKGhvdCByZWxvYWQpLlxuICAgICAgdHJ5IHsgZW50cnkudGVhcmRvd24/LigpOyB9IGNhdGNoIHt9XG4gICAgICBlbnRyeS50ZWFyZG93biA9IG51bGw7XG4gICAgICBjb25zdCByZXQgPSBlbnRyeS5wYWdlLnJlbmRlcihyb290LnNlY3Rpb25zV3JhcCk7XG4gICAgICBpZiAodHlwZW9mIHJldCA9PT0gXCJmdW5jdGlvblwiKSBlbnRyeS50ZWFyZG93biA9IHJldDtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCBlcnIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgZXJyLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi1jaGFydHMtcmVkIHRleHQtc21cIjtcbiAgICAgIGVyci50ZXh0Q29udGVudCA9IGBFcnJvciByZW5kZXJpbmcgcGFnZTogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gO1xuICAgICAgcm9vdC5zZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoZXJyKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGFwLmtpbmQgPT09IFwicGF0Y2gtbWFuYWdlclwiKSB7XG4gICAgY29uc3Qgcm9vdCA9IHBhbmVsU2hlbGwoXCJQYXRjaCBNYW5hZ2VyXCIsIFwiQ2hlY2tpbmcgU3RhYmxlIGFuZCBCZXRhIHBhdGNoIHN0YXRlLlwiKTtcbiAgICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICAgIHJlbmRlclBhdGNoTWFuYWdlclBhZ2Uocm9vdC5zZWN0aW9uc1dyYXAsIHJvb3Quc3VidGl0bGUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpdGxlID0gYXAua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwiVHdlYWtzXCIgOiBcIkNvbmZpZ1wiO1xuICBjb25zdCBzdWJ0aXRsZSA9IGFwLmtpbmQgPT09IFwidHdlYWtzXCJcbiAgICA/IFwiTWFuYWdlIHlvdXIgaW5zdGFsbGVkIENvZGV4KysgdHdlYWtzLlwiXG4gICAgOiBcIkNoZWNraW5nIGluc3RhbGxlZCBDb2RleCsrIHZlcnNpb24uXCI7XG4gIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKHRpdGxlLCBzdWJ0aXRsZSk7XG4gIGhvc3QuYXBwZW5kQ2hpbGQocm9vdC5vdXRlcik7XG4gIGlmIChhcC5raW5kID09PSBcInR3ZWFrc1wiKSByZW5kZXJUd2Vha3NQYWdlKHJvb3Quc2VjdGlvbnNXcmFwKTtcbiAgZWxzZSByZW5kZXJDb25maWdQYWdlKHJvb3Quc2VjdGlvbnNXcmFwLCByb290LnN1YnRpdGxlKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIHBhZ2VzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiByZW5kZXJDb25maWdQYWdlKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsIHN1YnRpdGxlPzogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkNvZGV4KysgVXBkYXRlc1wiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjb25zdCBsb2FkaW5nID0gcm93U2ltcGxlKFwiTG9hZGluZyB1cGRhdGUgc2V0dGluZ3NcIiwgXCJDaGVja2luZyBjdXJyZW50IENvZGV4KysgY29uZmlndXJhdGlvbi5cIik7XG4gIGNhcmQuYXBwZW5kQ2hpbGQobG9hZGluZyk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcImNvZGV4cHA6Z2V0LWNvbmZpZ1wiKVxuICAgIC50aGVuKChjb25maWcpID0+IHtcbiAgICAgIGlmIChzdWJ0aXRsZSkge1xuICAgICAgICBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IGBZb3UgaGF2ZSBDb2RleCsrICR7KGNvbmZpZyBhcyBDb2RleFBsdXNQbHVzQ29uZmlnKS52ZXJzaW9ufSBpbnN0YWxsZWQuYDtcbiAgICAgIH1cbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkLCBjb25maWcgYXMgQ29kZXhQbHVzUGx1c0NvbmZpZyk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGlmIChzdWJ0aXRsZSkgc3VidGl0bGUudGV4dENvbnRlbnQgPSBcIkNvdWxkIG5vdCBsb2FkIGluc3RhbGxlZCBDb2RleCsrIHZlcnNpb24uXCI7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGxvYWQgdXBkYXRlIHNldHRpbmdzXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pO1xuXG4gIGNvbnN0IHdhdGNoZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgd2F0Y2hlci5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgd2F0Y2hlci5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJBdXRvLVJlcGFpciBXYXRjaGVyXCIpKTtcbiAgY29uc3Qgd2F0Y2hlckNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICB3YXRjaGVyQ2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB3YXRjaGVyXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gIHdhdGNoZXIuYXBwZW5kQ2hpbGQod2F0Y2hlckNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQod2F0Y2hlcik7XG4gIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKHdhdGNoZXJDYXJkKTtcblxuICBjb25zdCBjZHAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgY2RwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjZHAuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiRGV2ZWxvcGVyIC8gQ0RQXCIpKTtcbiAgY29uc3QgY2RwQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNkcENhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgQ0RQXCIsIFwiUmVhZGluZyBDaHJvbWUgRGV2VG9vbHMgUHJvdG9jb2wgc3RhdHVzLlwiKSk7XG4gIGNkcC5hcHBlbmRDaGlsZChjZHBDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKGNkcCk7XG4gIHJlbmRlckNkcENhcmQoY2RwQ2FyZCk7XG5cbiAgY29uc3QgZmxvd1RhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBmbG93VGFwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBmbG93VGFwLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkFwcCBTZXJ2ZXIgRmxvdyBUYXBcIikpO1xuICBjb25zdCBmbG93VGFwQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGZsb3dUYXBDYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIGZsb3cgdGFwXCIsIFwiUmVhZGluZyBhcHAtc2VydmVyIGluc3RydW1lbnRhdGlvbiBzdGF0dXMuXCIpKTtcbiAgZmxvd1RhcC5hcHBlbmRDaGlsZChmbG93VGFwQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChmbG93VGFwKTtcbiAgcmVuZGVyQXBwU2VydmVyRmxvd1RhcENhcmQoZmxvd1RhcENhcmQpO1xuXG4gIGNvbnN0IG1haW50ZW5hbmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIG1haW50ZW5hbmNlLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBtYWludGVuYW5jZS5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJNYWludGVuYW5jZVwiKSk7XG4gIGNvbnN0IG1haW50ZW5hbmNlQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZCh1bmluc3RhbGxSb3coKSk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZChyZXBvcnRCdWdSb3coKSk7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChtYWludGVuYW5jZSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclBhdGNoTWFuYWdlclBhZ2Uoc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCwgc3VidGl0bGU/OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCByZWZyZXNoID0gY29tcGFjdEJ1dHRvbihcIlJlZnJlc2hcIiwgKCkgPT4ge1xuICAgIHNlY3Rpb25zV3JhcC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgcmVuZGVyUGF0Y2hNYW5hZ2VyUGFnZShzZWN0aW9uc1dyYXAsIHN1YnRpdGxlKTtcbiAgfSk7XG5cbiAgY29uc3Qgb3ZlcnZpZXcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgb3ZlcnZpZXcuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIG92ZXJ2aWV3LmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIlN0YWJsZSAvIEJldGFcIiwgcmVmcmVzaCkpO1xuICBjb25zdCBvdmVydmlld0NhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBvdmVydmlld0NhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgcGF0Y2ggc3RhdGVcIiwgXCJSZWFkaW5nIENvZGV4KysgaG9tZXMgYW5kIGFwcCBidW5kbGVzLlwiKSk7XG4gIG92ZXJ2aWV3LmFwcGVuZENoaWxkKG92ZXJ2aWV3Q2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChvdmVydmlldyk7XG5cbiAgY29uc3QgY29tbWFuZHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgY29tbWFuZHMuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIGNvbW1hbmRzLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkNvbW1hbmRzXCIpKTtcbiAgY29uc3QgY29tbWFuZHNDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY29tbWFuZHNDYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkxvYWRpbmcgY29tbWFuZHNcIiwgXCJQcmVwYXJpbmcgZXhhY3QgcmVwYWlyIGFuZCByZW9wZW4gY29tbWFuZHMuXCIpKTtcbiAgY29tbWFuZHMuYXBwZW5kQ2hpbGQoY29tbWFuZHNDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKGNvbW1hbmRzKTtcblxuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcImNvZGV4cHA6Z2V0LXBhdGNoLW1hbmFnZXItc3RhdHVzXCIpXG4gICAgLnRoZW4oKHN0YXR1cykgPT4ge1xuICAgICAgY29uc3QgcGF0Y2ggPSBzdGF0dXMgYXMgUGF0Y2hNYW5hZ2VyU3RhdHVzO1xuICAgICAgaWYgKHN1YnRpdGxlKSB7XG4gICAgICAgIHN1YnRpdGxlLnRleHRDb250ZW50ID1cbiAgICAgICAgICBwYXRjaC5jdXJyZW50Q2hhbm5lbCA9PT0gXCJ1bmtub3duXCJcbiAgICAgICAgICAgID8gYENoZWNrZWQgJHtuZXcgRGF0ZShwYXRjaC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCl9LmBcbiAgICAgICAgICAgIDogYFJ1bm5pbmcgZnJvbSAke2NoYW5uZWxMYWJlbChwYXRjaC5jdXJyZW50Q2hhbm5lbCl9LiBDaGVja2VkICR7bmV3IERhdGUocGF0Y2guY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpfS5gO1xuICAgICAgfVxuICAgICAgb3ZlcnZpZXdDYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNvbW1hbmRzQ2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBmb3IgKGNvbnN0IGNoYW5uZWwgb2YgcGF0Y2guY2hhbm5lbHMpIHtcbiAgICAgICAgb3ZlcnZpZXdDYXJkLmFwcGVuZENoaWxkKHBhdGNoQ2hhbm5lbFJvdyhjaGFubmVsKSk7XG4gICAgICAgIGNvbW1hbmRzQ2FyZC5hcHBlbmRDaGlsZChwYXRjaENvbW1hbmRSb3coY2hhbm5lbCkpO1xuICAgICAgfVxuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHN1YnRpdGxlLnRleHRDb250ZW50ID0gXCJDb3VsZCBub3QgcmVhZCBwYXRjaCBzdGF0ZS5cIjtcbiAgICAgIG92ZXJ2aWV3Q2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjb21tYW5kc0NhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgb3ZlcnZpZXdDYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIlBhdGNoIHN0YXRlIHVuYXZhaWxhYmxlXCIsIFN0cmluZyhlKSkpO1xuICAgICAgY29tbWFuZHNDYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvbW1hbmRzIHVuYXZhaWxhYmxlXCIsIFwiUGF0Y2ggc3RhdHVzIGZhaWxlZCBiZWZvcmUgY29tbWFuZHMgd2VyZSBidWlsdC5cIikpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBwYXRjaENoYW5uZWxSb3coY2hhbm5lbDogUGF0Y2hDaGFubmVsU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShwYXRjaENoYW5uZWxUb25lKGNoYW5uZWwpLCBjaGFubmVsLmN1cnJlbnQgPyBgJHtjaGFubmVsLmxhYmVsfSBjdXJyZW50YCA6IGNoYW5uZWwubGFiZWwpKTtcblxuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBwYXRjaENoYW5uZWxUaXRsZShjaGFubmVsKTtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gcGF0Y2hDaGFubmVsU3VtbWFyeShjaGFubmVsKTtcbiAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG1ldGEuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdHJ1bmNhdGUgdGV4dC14c1wiO1xuICBtZXRhLnRleHRDb250ZW50ID0gY2hhbm5lbC5hcHBSb290O1xuICBzdGFjay5hcHBlbmQodGl0bGUsIGRlc2MsIG1ldGEpO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiUmV2ZWFsXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgY2hhbm5lbC51c2VyUm9vdCk7XG4gICAgfSksXG4gICk7XG4gIGlmIChjaGFubmVsLmNkcC5qc29uTGlzdFVybCkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiVGFyZ2V0c1wiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWNkcC11cmxcIiwgY2hhbm5lbC5jZHAuanNvbkxpc3RVcmwpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHBhdGNoQ29tbWFuZFJvdyhjaGFubmVsOiBQYXRjaENoYW5uZWxTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBgJHtjaGFubmVsLmxhYmVsfSByZXBhaXJgLFxuICAgIGAke2NvbW1hbmRTdW1tYXJ5KGNoYW5uZWwpfSBTYXZlZCBDRFAgJHtjaGFubmVsLmNkcC5jb25maWd1cmVkUG9ydH07IGRlZmF1bHQgJHtjaGFubmVsLmNkcC5leHBlY3RlZFBvcnR9LmAsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKGNvcHlDb21tYW5kQnV0dG9uKFwiUmVwYWlyXCIsIGNoYW5uZWwuY29tbWFuZHMucmVwYWlyKSk7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoY29weUNvbW1hbmRCdXR0b24oXCJSZW9wZW5cIiwgY2hhbm5lbC5jb21tYW5kcy5yZW9wZW5XaXRoQ2RwKSk7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoY29weUNvbW1hbmRCdXR0b24oXCJTdGF0dXNcIiwgY2hhbm5lbC5jb21tYW5kcy5zdGF0dXMpKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChjb3B5Q29tbWFuZEJ1dHRvbihcIlVwZGF0ZVwiLCBjaGFubmVsLmNvbW1hbmRzLnVwZGF0ZUNvZGV4KSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvcHlDb21tYW5kQnV0dG9uKGxhYmVsOiBzdHJpbmcsIGNvbW1hbmQ6IHN0cmluZyk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgcmV0dXJuIGNvbXBhY3RCdXR0b24obGFiZWwsICgpID0+IHtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29weS10ZXh0XCIsIGNvbW1hbmQpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcGF0Y2hDaGFubmVsVGl0bGUoY2hhbm5lbDogUGF0Y2hDaGFubmVsU3RhdHVzKTogc3RyaW5nIHtcbiAgaWYgKCFjaGFubmVsLnN0YXRlRXhpc3RzKSByZXR1cm4gYCR7Y2hhbm5lbC5sYWJlbH0gaXMgbm90IGluc3RhbGxlZCB0aHJvdWdoIENvZGV4KytgO1xuICBjb25zdCBjb2RleCA9IGNoYW5uZWwuY29kZXhWZXJzaW9uID8gYENvZGV4ICR7Y2hhbm5lbC5jb2RleFZlcnNpb259YCA6IFwiQ29kZXggdmVyc2lvbiB1bmtub3duXCI7XG4gIGNvbnN0IGNvZGV4cHAgPSBjaGFubmVsLmNvZGV4UGx1c1BsdXNWZXJzaW9uID8gYENvZGV4KysgJHtjaGFubmVsLmNvZGV4UGx1c1BsdXNWZXJzaW9ufWAgOiBcIkNvZGV4KysgdmVyc2lvbiB1bmtub3duXCI7XG4gIHJldHVybiBgJHtjb2RleH0gXHUwMEI3ICR7Y29kZXhwcH1gO1xufVxuXG5mdW5jdGlvbiBwYXRjaENoYW5uZWxTdW1tYXJ5KGNoYW5uZWw6IFBhdGNoQ2hhbm5lbFN0YXR1cyk6IHN0cmluZyB7XG4gIGNvbnN0IHJ1bnRpbWUgPSBjaGFubmVsLnJ1bnRpbWVQcmVsb2FkRXhpc3RzXG4gICAgPyBgcnVudGltZSAke2Zvcm1hdEJ5dGVzKGNoYW5uZWwucnVudGltZVByZWxvYWRCeXRlcyl9YFxuICAgIDogXCJydW50aW1lIG1pc3NpbmdcIjtcbiAgY29uc3Qgd2F0Y2hlciA9IGNoYW5uZWwud2F0Y2hlckxvYWRlZCA9PT0gbnVsbFxuICAgID8gXCJ3YXRjaGVyIHVua25vd25cIlxuICAgIDogY2hhbm5lbC53YXRjaGVyTG9hZGVkXG4gICAgICA/IFwid2F0Y2hlciBsb2FkZWRcIlxuICAgICAgOiBcIndhdGNoZXIgbm90IGxvYWRlZFwiO1xuICBjb25zdCBjZHAgPSBjaGFubmVsLmNkcC5hY3RpdmVcbiAgICA/IGBDRFAgYWN0aXZlIG9uICR7Y2hhbm5lbC5jZHAuYWN0aXZlUG9ydH1gXG4gICAgOiBjaGFubmVsLmNkcC5lbmFibGVkXG4gICAgICA/IGBDRFAgc2F2ZWQgb24gJHtjaGFubmVsLmNkcC5jb25maWd1cmVkUG9ydH1gXG4gICAgICA6IFwiQ0RQIG9mZlwiO1xuICBjb25zdCBkcmlmdCA9IGNoYW5uZWwuY2RwLmRyaWZ0ID8gYDsgZXhwZWN0ZWQgJHtjaGFubmVsLmNkcC5leHBlY3RlZFBvcnR9YCA6IFwiXCI7XG4gIHJldHVybiBgJHtydW50aW1lfTsgJHt3YXRjaGVyfTsgJHtjZHB9JHtkcmlmdH0uYDtcbn1cblxuZnVuY3Rpb24gY29tbWFuZFN1bW1hcnkoY2hhbm5lbDogUGF0Y2hDaGFubmVsU3RhdHVzKTogc3RyaW5nIHtcbiAgaWYgKCFjaGFubmVsLmFwcEV4aXN0cykgcmV0dXJuIFwiQXBwIGJ1bmRsZSBpcyBtaXNzaW5nIGF0IHRoZSByZWNvcmRlZCBwYXRoLlwiO1xuICBpZiAoIWNoYW5uZWwucnVudGltZVByZWxvYWRFeGlzdHMpIHJldHVybiBcIlJ1bnRpbWUgcHJlbG9hZCBpcyBtaXNzaW5nOyByZXBhaXIgc2hvdWxkIHJlZnJlc2ggaXQuXCI7XG4gIGlmICghY2hhbm5lbC5hdXRvVXBkYXRlKSByZXR1cm4gXCJBdXRvbWF0aWMgcmVwYWlyIGlzIGRpc2FibGVkLlwiO1xuICByZXR1cm4gXCJQYXRjaCBmaWxlcyBhcmUgcHJlc2VudC5cIjtcbn1cblxuZnVuY3Rpb24gcGF0Y2hDaGFubmVsVG9uZShjaGFubmVsOiBQYXRjaENoYW5uZWxTdGF0dXMpOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiB7XG4gIGlmICghY2hhbm5lbC5zdGF0ZUV4aXN0cyB8fCAhY2hhbm5lbC5hcHBFeGlzdHMgfHwgIWNoYW5uZWwucnVudGltZVByZWxvYWRFeGlzdHMpIHJldHVybiBcImVycm9yXCI7XG4gIGlmIChjaGFubmVsLndhdGNoZXJMb2FkZWQgPT09IGZhbHNlIHx8IGNoYW5uZWwuY2RwLmRyaWZ0IHx8ICFjaGFubmVsLmF1dG9VcGRhdGUpIHJldHVybiBcIndhcm5cIjtcbiAgcmV0dXJuIFwib2tcIjtcbn1cblxuZnVuY3Rpb24gY2hhbm5lbExhYmVsKGNoYW5uZWw6IFBhdGNoTWFuYWdlclN0YXR1c1tcImN1cnJlbnRDaGFubmVsXCJdKTogc3RyaW5nIHtcbiAgaWYgKGNoYW5uZWwgPT09IFwic3RhYmxlXCIpIHJldHVybiBcIlN0YWJsZVwiO1xuICBpZiAoY2hhbm5lbCA9PT0gXCJiZXRhXCIpIHJldHVybiBcIkJldGFcIjtcbiAgcmV0dXJuIFwiVW5rbm93blwiO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRCeXRlcyhieXRlczogbnVtYmVyIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmIChieXRlcyA9PT0gbnVsbCkgcmV0dXJuIFwibWlzc2luZ1wiO1xuICBpZiAoYnl0ZXMgPCAxMDI0KSByZXR1cm4gYCR7Ynl0ZXN9IEJgO1xuICBpZiAoYnl0ZXMgPCAxMDI0ICogMTAyNCkgcmV0dXJuIGAke01hdGgucm91bmQoYnl0ZXMgLyAxMDI0KX0gS0JgO1xuICByZXR1cm4gYCR7KGJ5dGVzIC8gKDEwMjQgKiAxMDI0KSkudG9GaXhlZCgxKX0gTUJgO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb2RleFBsdXNQbHVzQ29uZmlnKGNhcmQ6IEhUTUxFbGVtZW50LCBjb25maWc6IENvZGV4UGx1c1BsdXNDb25maWcpOiB2b2lkIHtcbiAgY2FyZC5hcHBlbmRDaGlsZChhdXRvVXBkYXRlUm93KGNvbmZpZykpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNoZWNrRm9yVXBkYXRlc1Jvdyhjb25maWcudXBkYXRlQ2hlY2spKTtcbiAgaWYgKGNvbmZpZy51cGRhdGVDaGVjaykgY2FyZC5hcHBlbmRDaGlsZChyZWxlYXNlTm90ZXNSb3coY29uZmlnLnVwZGF0ZUNoZWNrKSk7XG59XG5cbmZ1bmN0aW9uIGF1dG9VcGRhdGVSb3coY29uZmlnOiBDb2RleFBsdXNQbHVzQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkF1dG9tYXRpY2FsbHkgcmVmcmVzaCBDb2RleCsrXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGBJbnN0YWxsZWQgdmVyc2lvbiB2JHtjb25maWcudmVyc2lvbn0uIFRoZSB3YXRjaGVyIGNhbiByZWZyZXNoIHRoZSBDb2RleCsrIHJ1bnRpbWUgYWZ0ZXIgeW91IHJlcnVuIHRoZSBHaXRIdWIgaW5zdGFsbGVyLmA7XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIHJvdy5hcHBlbmRDaGlsZChcbiAgICBzd2l0Y2hDb250cm9sKGNvbmZpZy5hdXRvVXBkYXRlLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpzZXQtYXV0by11cGRhdGVcIiwgbmV4dCk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNoZWNrRm9yVXBkYXRlc1JvdyhjaGVjazogQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHwgbnVsbCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSA/IFwiQ29kZXgrKyB1cGRhdGUgYXZhaWxhYmxlXCIgOiBcIkNvZGV4KysgaXMgdXAgdG8gZGF0ZVwiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSB1cGRhdGVTdW1tYXJ5KGNoZWNrKTtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGlmIChjaGVjaz8ucmVsZWFzZVVybCkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiUmVsZWFzZSBOb3Rlc1wiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsIGNoZWNrLnJlbGVhc2VVcmwpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDaGVjayBOb3dcIiwgKCkgPT4ge1xuICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIjAuNjVcIjtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcImNvZGV4cHA6Y2hlY2stY29kZXhwcC11cGRhdGVcIiwgdHJ1ZSlcbiAgICAgICAgLnRoZW4oKG5leHQpID0+IHtcbiAgICAgICAgICBjb25zdCBjYXJkID0gcm93LnBhcmVudEVsZW1lbnQ7XG4gICAgICAgICAgaWYgKCFjYXJkKSByZXR1cm47XG4gICAgICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdldC1jb25maWdcIikudGhlbigoY29uZmlnKSA9PiB7XG4gICAgICAgICAgICByZW5kZXJDb2RleFBsdXNQbHVzQ29uZmlnKGNhcmQsIHtcbiAgICAgICAgICAgICAgLi4uKGNvbmZpZyBhcyBDb2RleFBsdXNQbHVzQ29uZmlnKSxcbiAgICAgICAgICAgICAgdXBkYXRlQ2hlY2s6IG5leHQgYXMgQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcIkNvZGV4KysgdXBkYXRlIGNoZWNrIGZhaWxlZFwiLCBTdHJpbmcoZSkpKVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIlwiO1xuICAgICAgICB9KTtcbiAgICB9KSxcbiAgKTtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZWxlYXNlTm90ZXNSb3coY2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMiBwLTNcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkxhdGVzdCByZWxlYXNlIG5vdGVzXCI7XG4gIHJvdy5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBib2R5LmNsYXNzTmFtZSA9XG4gICAgXCJtYXgtaC02MCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHAtMyB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgYm9keS5hcHBlbmRDaGlsZChyZW5kZXJSZWxlYXNlTm90ZXNNYXJrZG93bihjaGVjay5yZWxlYXNlTm90ZXM/LnRyaW0oKSB8fCBjaGVjay5lcnJvciB8fCBcIk5vIHJlbGVhc2Ugbm90ZXMgYXZhaWxhYmxlLlwiKSk7XG4gIHJvdy5hcHBlbmRDaGlsZChib2R5KTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ2RwQ2FyZChjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcImNvZGV4cHA6Z2V0LWNkcC1zdGF0dXNcIilcbiAgICAudGhlbigoc3RhdHVzKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlckNkcFN0YXR1cyhjYXJkLCBzdGF0dXMgYXMgQ29kZXhDZHBTdGF0dXMpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IHJlYWQgQ0RQIHN0YXR1c1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ2RwU3RhdHVzKGNhcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY2RwVG9nZ2xlUm93KGNhcmQsIHN0YXR1cykpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNkcFBvcnRSb3coY2FyZCwgc3RhdHVzKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY2RwRW5kcG9pbnRSb3coc3RhdHVzKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY2RwTGF1bmNoUm93KHN0YXR1cykpO1xuICBpZiAoc3RhdHVzLnJlc3RhcnRSZXF1aXJlZCkge1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoXG4gICAgICByb3dTaW1wbGUoXG4gICAgICAgIFwiUmVzdGFydCByZXF1aXJlZFwiLFxuICAgICAgICBzdGF0dXMuZW5hYmxlZFxuICAgICAgICAgID8gXCJDRFAgd2lsbCB1c2UgdGhlIHNhdmVkIHBvcnQgYWZ0ZXIgQ29kZXggcmVzdGFydHMuXCJcbiAgICAgICAgICA6IFwiQ0RQIGlzIHN0aWxsIGFjdGl2ZSBmb3IgdGhpcyBwcm9jZXNzIGFuZCB3aWxsIHR1cm4gb2ZmIGFmdGVyIENvZGV4IHJlc3RhcnRzLlwiLFxuICAgICAgKSxcbiAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNkcFRvZ2dsZVJvdyhjYXJkOiBIVE1MRWxlbWVudCwgc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuXG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoY2RwU3RhdHVzQmFkZ2Uoc3RhdHVzKSk7XG5cbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJDaHJvbWUgRGV2VG9vbHMgUHJvdG9jb2xcIjtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gY2RwU3RhdHVzU3VtbWFyeShzdGF0dXMpO1xuICBzdGFjay5hcHBlbmQodGl0bGUsIGRlc2MpO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIHJvdy5hcHBlbmRDaGlsZChcbiAgICBzd2l0Y2hDb250cm9sKHN0YXR1cy5lbmFibGVkLCBhc3luYyAoZW5hYmxlZCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpzZXQtY2RwLWNvbmZpZ1wiLCB7XG4gICAgICAgIGVuYWJsZWQsXG4gICAgICAgIHBvcnQ6IHN0YXR1cy5jb25maWd1cmVkUG9ydCxcbiAgICAgIH0pO1xuICAgICAgcmVmcmVzaENkcENhcmQoY2FyZCk7XG4gICAgfSksXG4gICk7XG5cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY2RwUG9ydFJvdyhjYXJkOiBIVE1MRWxlbWVudCwgc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiUmVtb3RlIGRlYnVnZ2luZyBwb3J0XCIsXG4gICAgc3RhdHVzLmFjdGl2ZVBvcnRcbiAgICAgID8gYEN1cnJlbnQgcHJvY2VzcyBpcyBsaXN0ZW5pbmcgb24gJHtzdGF0dXMuYWN0aXZlUG9ydH0uYFxuICAgICAgOiBgU2F2ZWQgcG9ydCBpcyAke3N0YXR1cy5jb25maWd1cmVkUG9ydH0uYCxcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICBpbnB1dC50eXBlID0gXCJudW1iZXJcIjtcbiAgaW5wdXQubWluID0gXCIxXCI7XG4gIGlucHV0Lm1heCA9IFwiNjU1MzVcIjtcbiAgaW5wdXQuc3RlcCA9IFwiMVwiO1xuICBpbnB1dC52YWx1ZSA9IFN0cmluZyhzdGF0dXMuY29uZmlndXJlZFBvcnQpO1xuICBpbnB1dC5jbGFzc05hbWUgPVxuICAgIFwiaC04IHctMjQgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10cmFuc3BhcmVudCBweC0yIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnkgZm9jdXM6b3V0bGluZS1ub25lIGZvY3VzOnJpbmctMiBmb2N1czpyaW5nLXRva2VuLWZvY3VzLWJvcmRlclwiO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKGlucHV0KTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiU2F2ZVwiLCAoKSA9PiB7XG4gICAgICBjb25zdCBwb3J0ID0gTnVtYmVyKGlucHV0LnZhbHVlKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcImNvZGV4cHA6c2V0LWNkcC1jb25maWdcIiwge1xuICAgICAgICAgIGVuYWJsZWQ6IHN0YXR1cy5lbmFibGVkLFxuICAgICAgICAgIHBvcnQ6IE51bWJlci5pc0ludGVnZXIocG9ydCkgPyBwb3J0IDogc3RhdHVzLmNvbmZpZ3VyZWRQb3J0LFxuICAgICAgICB9KVxuICAgICAgICAudGhlbigoKSA9PiByZWZyZXNoQ2RwQ2FyZChjYXJkKSlcbiAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiQ0RQIHBvcnQgc2F2ZSBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNkcEVuZHBvaW50Um93KHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBzdGF0dXMuYWN0aXZlID8gXCJMb2NhbCBDRFAgZW5kcG9pbnRzXCIgOiBcIkxvY2FsIENEUCBlbmRwb2ludHNcIixcbiAgICBzdGF0dXMuYWN0aXZlICYmIHN0YXR1cy5qc29uTGlzdFVybFxuICAgICAgPyBgJHtzdGF0dXMuanNvbkxpc3RVcmx9YFxuICAgICAgOiBcIk5vdCBleHBvc2VkIGJ5IHRoZSBjdXJyZW50IENvZGV4IHByb2Nlc3MuXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBjb25zdCBvcGVuVGFyZ2V0cyA9IGNvbXBhY3RCdXR0b24oXCJPcGVuIFRhcmdldHNcIiwgKCkgPT4ge1xuICAgIGlmICghc3RhdHVzLmpzb25MaXN0VXJsKSByZXR1cm47XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tY2RwLXVybFwiLCBzdGF0dXMuanNvbkxpc3RVcmwpO1xuICB9KTtcbiAgb3BlblRhcmdldHMuZGlzYWJsZWQgPSAhc3RhdHVzLmpzb25MaXN0VXJsO1xuICBjb25zdCBjb3B5VGFyZ2V0cyA9IGNvbXBhY3RCdXR0b24oXCJDb3B5IFVSTFwiLCAoKSA9PiB7XG4gICAgaWYgKCFzdGF0dXMuanNvbkxpc3RVcmwpIHJldHVybjtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29weS10ZXh0XCIsIHN0YXR1cy5qc29uTGlzdFVybCk7XG4gIH0pO1xuICBjb3B5VGFyZ2V0cy5kaXNhYmxlZCA9ICFzdGF0dXMuanNvbkxpc3RVcmw7XG4gIGNvbnN0IG9wZW5WZXJzaW9uID0gY29tcGFjdEJ1dHRvbihcIlZlcnNpb25cIiwgKCkgPT4ge1xuICAgIGlmICghc3RhdHVzLmpzb25WZXJzaW9uVXJsKSByZXR1cm47XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tY2RwLXVybFwiLCBzdGF0dXMuanNvblZlcnNpb25VcmwpO1xuICB9KTtcbiAgb3BlblZlcnNpb24uZGlzYWJsZWQgPSAhc3RhdHVzLmpzb25WZXJzaW9uVXJsO1xuICBhY3Rpb24/LmFwcGVuZChvcGVuVGFyZ2V0cywgY29weVRhcmdldHMsIG9wZW5WZXJzaW9uKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY2RwTGF1bmNoUm93KHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIkxhdW5jaCBjb21tYW5kXCIsXG4gICAgc3RhdHVzLmFwcFJvb3QgPyBzdGF0dXMuYXBwUm9vdCA6IFwiQ29kZXggYXBwIHBhdGggd2FzIG5vdCBmb3VuZCBpbiBpbnN0YWxsZXIgc3RhdGUuXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDb3B5IENvbW1hbmRcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvcHktdGV4dFwiLCBzdGF0dXMubGF1bmNoQ29tbWFuZCk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hDZHBDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIENEUFwiLCBcIlJlYWRpbmcgQ2hyb21lIERldlRvb2xzIFByb3RvY29sIHN0YXR1cy5cIikpO1xuICByZW5kZXJDZHBDYXJkKGNhcmQpO1xufVxuXG5mdW5jdGlvbiBjZHBTdGF0dXNCYWRnZShzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBpZiAoc3RhdHVzLmFjdGl2ZSkgcmV0dXJuIHN0YXR1c0JhZGdlKHN0YXR1cy5yZXN0YXJ0UmVxdWlyZWQgPyBcIndhcm5cIiA6IFwib2tcIiwgXCJBY3RpdmVcIik7XG4gIGlmIChzdGF0dXMucmVzdGFydFJlcXVpcmVkKSByZXR1cm4gc3RhdHVzQmFkZ2UoXCJ3YXJuXCIsIFwiUmVzdGFydFwiKTtcbiAgcmV0dXJuIHN0YXR1c0JhZGdlKHN0YXR1cy5lbmFibGVkID8gXCJ3YXJuXCIgOiBcIndhcm5cIiwgc3RhdHVzLmVuYWJsZWQgPyBcIlNhdmVkXCIgOiBcIk9mZlwiKTtcbn1cblxuZnVuY3Rpb24gY2RwU3RhdHVzU3VtbWFyeShzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogc3RyaW5nIHtcbiAgaWYgKHN0YXR1cy5hY3RpdmVQb3J0KSB7XG4gICAgY29uc3Qgc291cmNlID0gc3RhdHVzLnNvdXJjZSA9PT0gXCJhcmd2XCIgPyBcImxhdW5jaCBhcmdcIiA6IHN0YXR1cy5zb3VyY2U7XG4gICAgcmV0dXJuIGBBY3RpdmUgb24gMTI3LjAuMC4xOiR7c3RhdHVzLmFjdGl2ZVBvcnR9IGZyb20gJHtzb3VyY2V9LmA7XG4gIH1cbiAgaWYgKHN0YXR1cy5lbmFibGVkKSB7XG4gICAgcmV0dXJuIGBFbmFibGVkIGZvciBuZXh0IGxhdW5jaCBvbiAxMjcuMC4wLjE6JHtzdGF0dXMuY29uZmlndXJlZFBvcnR9LmA7XG4gIH1cbiAgcmV0dXJuIFwiRGlzYWJsZWQgZm9yIENvZGV4IGxhdW5jaGVzIG1hbmFnZWQgYnkgQ29kZXgrKy5cIjtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQXBwU2VydmVyRmxvd1RhcENhcmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC1hcHAtc2VydmVyLWZsb3ctdGFwLXN0YXR1c1wiKVxuICAgIC50aGVuKChzdGF0dXMpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyQXBwU2VydmVyRmxvd1RhcFN0YXR1cyhjYXJkLCBzdGF0dXMgYXMgQXBwU2VydmVyRmxvd1RhcFN0YXR1cyk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgcmVhZCBmbG93IHRhcCBzdGF0dXNcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckFwcFNlcnZlckZsb3dUYXBTdGF0dXMoY2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogQXBwU2VydmVyRmxvd1RhcFN0YXR1cyk6IHZvaWQge1xuICBjYXJkLmFwcGVuZENoaWxkKGFwcFNlcnZlckZsb3dUYXBUb2dnbGVSb3coY2FyZCwgc3RhdHVzKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoYXBwU2VydmVyRmxvd1RhcFN1bW1hcnlSb3coc3RhdHVzKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoYXBwU2VydmVyRmxvd1RhcExvZ0FjdGlvbnNSb3coY2FyZCwgc3RhdHVzKSk7XG4gIGNvbnN0IGxvZ1JvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxvZ1Jvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTIgcC0zXCI7XG4gIGxvZ1Jvdy5hcHBlbmRDaGlsZChyb3dJbmxpbmVUaXRsZShcIlJlY2VudCBwcm90b2NvbCBmbG93XCIpKTtcbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwcmVcIik7XG4gIGJvZHkuY2xhc3NOYW1lID1cbiAgICBcIm1heC1oLTgwIG92ZXJmbG93LWF1dG8gd2hpdGVzcGFjZS1wcmUtd3JhcCBicmVhay13b3JkcyByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTMgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSBcIlJlYWRpbmcgYXBwLXNlcnZlciBmbG93IGxvZy5cIjtcbiAgbG9nUm93LmFwcGVuZENoaWxkKGJvZHkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGxvZ1Jvdyk7XG4gIHJlZnJlc2hBcHBTZXJ2ZXJGbG93VGFwVGFpbChib2R5KTtcbn1cblxuZnVuY3Rpb24gYXBwU2VydmVyRmxvd1RhcFRvZ2dsZVJvdyhjYXJkOiBIVE1MRWxlbWVudCwgc3RhdHVzOiBBcHBTZXJ2ZXJGbG93VGFwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChhcHBTZXJ2ZXJGbG93VGFwU3RhdHVzQmFkZ2Uoc3RhdHVzKSk7XG5cbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJBcHAtc2VydmVyIHN0ZGlvIGZsb3dcIjtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gYXBwU2VydmVyRmxvd1RhcFN1bW1hcnkoc3RhdHVzKTtcbiAgc3RhY2suYXBwZW5kKHRpdGxlLCBkZXNjKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICByb3cuYXBwZW5kQ2hpbGQoXG4gICAgc3dpdGNoQ29udHJvbChzdGF0dXMuZW5hYmxlZCwgYXN5bmMgKGVuYWJsZWQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6c2V0LWFwcC1zZXJ2ZXItZmxvdy10YXAtY29uZmlnXCIsIHsgZW5hYmxlZCB9KTtcbiAgICAgIHJlZnJlc2hBcHBTZXJ2ZXJGbG93VGFwQ2FyZChjYXJkKTtcbiAgICB9KSxcbiAgKTtcblxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBhcHBTZXJ2ZXJGbG93VGFwU3VtbWFyeVJvdyhzdGF0dXM6IEFwcFNlcnZlckZsb3dUYXBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGFjdGl2ZSA9IHN0YXR1cy5hY3RpdmVQaWRzLmxlbmd0aCA+IDBcbiAgICA/IGBjYXB0dXJpbmcgUElEICR7c3RhdHVzLmFjdGl2ZVBpZHMuam9pbihcIiwgXCIpfWBcbiAgICA6IFwid2FpdGluZyBmb3IgdGhlIG5leHQgYXBwLXNlcnZlciBjaGlsZFwiO1xuICByZXR1cm4gcm93U2ltcGxlKFxuICAgIFwiQ2FwdHVyZSBzdGF0ZVwiLFxuICAgIGAke2FjdGl2ZX07ICR7c3RhdHVzLmNhcHR1cmVkTWVzc2FnZXN9IGxpbmUocykgY2FwdHVyZWQ7ICR7c3RhdHVzLnJhd1BheWxvYWRzID8gXCJyYXcgcGF5bG9hZHMgb25cIiA6IFwic3VtbWFyeS1vbmx5XCJ9OyAke3N0YXR1cy5kcm9wcGVkTG9nTGluZXN9IGRyb3BwZWQ7IGxvZyAke2J5dGVzTGFiZWwoc3RhdHVzLmxvZ1NpemVCeXRlcyl9LmAsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGFwcFNlcnZlckZsb3dUYXBMb2dBY3Rpb25zUm93KGNhcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IEFwcFNlcnZlckZsb3dUYXBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIkZsb3cgbG9nXCIsIHN0YXR1cy5sb2dQYXRoKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIlJlZnJlc2hcIiwgKCkgPT4gcmVmcmVzaEFwcFNlcnZlckZsb3dUYXBDYXJkKGNhcmQpKSxcbiAgKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBUYWlsXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcImNvZGV4cHA6cmVhZC1hcHAtc2VydmVyLWZsb3ctdGFwLWxvZ1wiLCAyNTYgKiAxMDI0KVxuICAgICAgICAudGhlbigodGV4dCkgPT4gaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb3B5LXRleHRcIiwgU3RyaW5nKHRleHQpKSlcbiAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiZmxvdyB0YXAgY29weSBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSksXG4gICk7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIk9wZW4gTG9nXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWFwcC1zZXJ2ZXItZmxvdy10YXAtbG9nXCIpO1xuICAgIH0pLFxuICApO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJSZXZlYWxcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnJldmVhbC1hcHAtc2VydmVyLWZsb3ctdGFwLWxvZ1wiKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVmcmVzaEFwcFNlcnZlckZsb3dUYXBDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIGZsb3cgdGFwXCIsIFwiUmVhZGluZyBhcHAtc2VydmVyIGluc3RydW1lbnRhdGlvbiBzdGF0dXMuXCIpKTtcbiAgcmVuZGVyQXBwU2VydmVyRmxvd1RhcENhcmQoY2FyZCk7XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hBcHBTZXJ2ZXJGbG93VGFwVGFpbCh0YXJnZXQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpyZWFkLWFwcC1zZXJ2ZXItZmxvdy10YXAtbG9nXCIsIDI1NiAqIDEwMjQpXG4gICAgLnRoZW4oKHRleHQpID0+IHtcbiAgICAgIGNvbnN0IGZvcm1hdHRlZCA9IGZvcm1hdEFwcFNlcnZlckZsb3dUYWlsKFN0cmluZyh0ZXh0KSk7XG4gICAgICB0YXJnZXQudGV4dENvbnRlbnQgPSBmb3JtYXR0ZWQgfHwgXCJObyBhcHAtc2VydmVyIGZsb3cgaGFzIGJlZW4gY2FwdHVyZWQgeWV0LlwiO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICB0YXJnZXQudGV4dENvbnRlbnQgPSBgQ291bGQgbm90IHJlYWQgZmxvdyBsb2c6ICR7U3RyaW5nKGUpfWA7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEFwcFNlcnZlckZsb3dUYWlsKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzID0gdGV4dC50cmltKCkuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pLnNsaWNlKC04MCk7XG4gIHJldHVybiBsaW5lcy5tYXAoZm9ybWF0QXBwU2VydmVyRmxvd0xpbmUpLmpvaW4oXCJcXG5cIik7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEFwcFNlcnZlckZsb3dMaW5lKGxpbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVjb3JkID0gSlNPTi5wYXJzZShsaW5lKSBhcyB7XG4gICAgICB0cz86IHN0cmluZztcbiAgICAgIGV2ZW50Pzogc3RyaW5nO1xuICAgICAgc3RyZWFtPzogc3RyaW5nO1xuICAgICAgZGlyZWN0aW9uPzogc3RyaW5nO1xuICAgICAganNvbnJwYz86IHtcbiAgICAgICAga2luZD86IHN0cmluZztcbiAgICAgICAgaWQ/OiBzdHJpbmcgfCBudW1iZXIgfCBudWxsO1xuICAgICAgICBtZXRob2Q/OiBzdHJpbmc7XG4gICAgICAgIHRocmVhZElkPzogc3RyaW5nO1xuICAgICAgICB0dXJuSWQ/OiBzdHJpbmc7XG4gICAgICAgIHN0YXR1cz86IHN0cmluZztcbiAgICAgICAgZXJyb3JNZXNzYWdlPzogc3RyaW5nO1xuICAgICAgICByZXN1bHREYXRhQ291bnQ/OiBudW1iZXI7XG4gICAgICAgIGhhc05leHRDdXJzb3I/OiBib29sZWFuO1xuICAgICAgfTtcbiAgICAgIHRleHQ/OiBzdHJpbmc7XG4gICAgICBwaWQ/OiBudW1iZXIgfCBudWxsO1xuICAgIH07XG4gICAgY29uc3QgdHMgPSByZWNvcmQudHMgPyByZWNvcmQudHMuc2xpY2UoMTEsIDIzKSA6IFwiLS06LS06LS0uLS0tXCI7XG4gICAgaWYgKHJlY29yZC5ldmVudCAhPT0gXCJsaW5lXCIpIHtcbiAgICAgIHJldHVybiBgJHt0c30gJHtyZWNvcmQuZXZlbnQgPz8gXCJldmVudFwifSBwaWQ9JHtyZWNvcmQucGlkID8/IFwiLVwifWA7XG4gICAgfVxuICAgIGNvbnN0IHJwYyA9IHJlY29yZC5qc29ucnBjO1xuICAgIGlmIChycGMpIHtcbiAgICAgIGNvbnN0IHBhcnRzID0gW1xuICAgICAgICB0cyxcbiAgICAgICAgcmVjb3JkLnN0cmVhbSA/PyBcIj9cIixcbiAgICAgICAgcnBjLmtpbmQgPz8gXCJqc29uXCIsXG4gICAgICAgIHJwYy5tZXRob2QgPz8gYGlkPSR7cnBjLmlkID8/IFwiLVwifWAsXG4gICAgICAgIHJwYy5zdGF0dXMgPyBgc3RhdHVzPSR7cnBjLnN0YXR1c31gIDogXCJcIixcbiAgICAgICAgcnBjLnRocmVhZElkID8gYHRocmVhZD0ke3Nob3J0SWQocnBjLnRocmVhZElkKX1gIDogXCJcIixcbiAgICAgICAgcnBjLnR1cm5JZCA/IGB0dXJuPSR7c2hvcnRJZChycGMudHVybklkKX1gIDogXCJcIixcbiAgICAgICAgdHlwZW9mIHJwYy5yZXN1bHREYXRhQ291bnQgPT09IFwibnVtYmVyXCIgPyBgaXRlbXM9JHtycGMucmVzdWx0RGF0YUNvdW50fWAgOiBcIlwiLFxuICAgICAgICB0eXBlb2YgcnBjLmhhc05leHRDdXJzb3IgPT09IFwiYm9vbGVhblwiID8gYG5leHQ9JHtycGMuaGFzTmV4dEN1cnNvciA/IFwieWVzXCIgOiBcIm5vXCJ9YCA6IFwiXCIsXG4gICAgICAgIHJwYy5lcnJvck1lc3NhZ2UgPyBgZXJyb3I9JHtycGMuZXJyb3JNZXNzYWdlfWAgOiBcIlwiLFxuICAgICAgXS5maWx0ZXIoQm9vbGVhbik7XG4gICAgICByZXR1cm4gcGFydHMuam9pbihcIiBcIik7XG4gICAgfVxuICAgIGNvbnN0IHBheWxvYWQgPSByZWNvcmQudGV4dCA/IFN0cmluZyhyZWNvcmQudGV4dCkuc2xpY2UoMCwgNTAwKSA6IFwiKHBheWxvYWQgb21pdHRlZClcIjtcbiAgICByZXR1cm4gYCR7dHN9ICR7cmVjb3JkLnN0cmVhbSA/PyBcIj9cIn0gJHtwYXlsb2FkfWA7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBsaW5lO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFwcFNlcnZlckZsb3dUYXBTdGF0dXNCYWRnZShzdGF0dXM6IEFwcFNlcnZlckZsb3dUYXBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGlmIChzdGF0dXMuYWN0aXZlKSByZXR1cm4gc3RhdHVzQmFkZ2UoXCJva1wiLCBcIkZsb3dpbmdcIik7XG4gIGlmIChzdGF0dXMuZW5hYmxlZCkgcmV0dXJuIHN0YXR1c0JhZGdlKFwid2FyblwiLCBcIkFybWVkXCIpO1xuICByZXR1cm4gc3RhdHVzQmFkZ2UoXCJ3YXJuXCIsIFwiT2ZmXCIpO1xufVxuXG5mdW5jdGlvbiBhcHBTZXJ2ZXJGbG93VGFwU3VtbWFyeShzdGF0dXM6IEFwcFNlcnZlckZsb3dUYXBTdGF0dXMpOiBzdHJpbmcge1xuICBpZiAoc3RhdHVzLmFjdGl2ZVBpZHMubGVuZ3RoID4gMCkge1xuICAgIHJldHVybiBgQ2FwdHVyaW5nIHN0ZGlvIGZvciBhcHAtc2VydmVyIFBJRCAke3N0YXR1cy5hY3RpdmVQaWRzLmpvaW4oXCIsIFwiKX0uYDtcbiAgfVxuICBpZiAoc3RhdHVzLmVuYWJsZWQpIHtcbiAgICByZXR1cm4gXCJFbmFibGVkOyByZXN0YXJ0IENvZGV4IGlmIHRoZSBjdXJyZW50IGFwcC1zZXJ2ZXIgd2FzIHNwYXduZWQgYmVmb3JlIHRoZSB0YXAgd2FzIGFybWVkLlwiO1xuICB9XG4gIHJldHVybiBcIkRpc2FibGVkLiBFbmFibGUgaXQgdG8gdGVlIGFwcC1zZXJ2ZXIgc3RkaW4vc3Rkb3V0L3N0ZGVyciBzdW1tYXJpZXMgaW50byBhIGNhcHBlZCBKU09OTCBsb2cuXCI7XG59XG5cbmZ1bmN0aW9uIHJvd0lubGluZVRpdGxlKHRleHQ6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByZXR1cm4gdGl0bGU7XG59XG5cbmZ1bmN0aW9uIGJ5dGVzTGFiZWwoYnl0ZXM6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoYnl0ZXMgPT09IG51bGwpIHJldHVybiBcIm1pc3NpbmdcIjtcbiAgaWYgKGJ5dGVzIDwgMTAyNCkgcmV0dXJuIGAke2J5dGVzfSBCYDtcbiAgaWYgKGJ5dGVzIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHtNYXRoLnJvdW5kKGJ5dGVzIC8gMTAyNCl9IEtCYDtcbiAgcmV0dXJuIGAkeyhieXRlcyAvICgxMDI0ICogMTAyNCkpLnRvRml4ZWQoMSl9IE1CYDtcbn1cblxuZnVuY3Rpb24gc2hvcnRJZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLmxlbmd0aCA8PSAxMiA/IHZhbHVlIDogYCR7dmFsdWUuc2xpY2UoMCwgNil9XHUyMDI2JHt2YWx1ZS5zbGljZSgtNCl9YDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24obWFya2Rvd246IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvb3QuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIGNvbnN0IGxpbmVzID0gbWFya2Rvd24ucmVwbGFjZSgvXFxyXFxuPy9nLCBcIlxcblwiKS5zcGxpdChcIlxcblwiKTtcbiAgbGV0IHBhcmFncmFwaDogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGxpc3Q6IEhUTUxPTGlzdEVsZW1lbnQgfCBIVE1MVUxpc3RFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjb2RlTGluZXM6IHN0cmluZ1tdIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3QgZmx1c2hQYXJhZ3JhcGggPSAoKSA9PiB7XG4gICAgaWYgKHBhcmFncmFwaC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInBcIik7XG4gICAgcC5jbGFzc05hbWUgPSBcIm0tMCBsZWFkaW5nLTVcIjtcbiAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihwLCBwYXJhZ3JhcGguam9pbihcIiBcIikudHJpbSgpKTtcbiAgICByb290LmFwcGVuZENoaWxkKHApO1xuICAgIHBhcmFncmFwaCA9IFtdO1xuICB9O1xuICBjb25zdCBmbHVzaExpc3QgPSAoKSA9PiB7XG4gICAgaWYgKCFsaXN0KSByZXR1cm47XG4gICAgcm9vdC5hcHBlbmRDaGlsZChsaXN0KTtcbiAgICBsaXN0ID0gbnVsbDtcbiAgfTtcbiAgY29uc3QgZmx1c2hDb2RlID0gKCkgPT4ge1xuICAgIGlmICghY29kZUxpbmVzKSByZXR1cm47XG4gICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInByZVwiKTtcbiAgICBwcmUuY2xhc3NOYW1lID1cbiAgICAgIFwibS0wIG92ZXJmbG93LWF1dG8gcm91bmRlZC1tZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIHAtMiB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgIGNvZGUudGV4dENvbnRlbnQgPSBjb2RlTGluZXMuam9pbihcIlxcblwiKTtcbiAgICBwcmUuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwcmUpO1xuICAgIGNvZGVMaW5lcyA9IG51bGw7XG4gIH07XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgaWYgKGxpbmUudHJpbSgpLnN0YXJ0c1dpdGgoXCJgYGBcIikpIHtcbiAgICAgIGlmIChjb2RlTGluZXMpIGZsdXNoQ29kZSgpO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgICBjb2RlTGluZXMgPSBbXTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY29kZUxpbmVzKSB7XG4gICAgICBjb2RlTGluZXMucHVzaChsaW5lKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICBpZiAoIXRyaW1tZWQpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBmbHVzaExpc3QoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IGhlYWRpbmcgPSAvXigjezEsM30pXFxzKyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChoZWFkaW5nKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb25zdCBoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChoZWFkaW5nWzFdLmxlbmd0aCA9PT0gMSA/IFwiaDNcIiA6IFwiaDRcIik7XG4gICAgICBoLmNsYXNzTmFtZSA9IFwibS0wIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGgsIGhlYWRpbmdbMl0pO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHVub3JkZXJlZCA9IC9eWy0qXVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBjb25zdCBvcmRlcmVkID0gL15cXGQrWy4pXVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAodW5vcmRlcmVkIHx8IG9yZGVyZWQpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBjb25zdCB3YW50T3JkZXJlZCA9IEJvb2xlYW4ob3JkZXJlZCk7XG4gICAgICBpZiAoIWxpc3QgfHwgKHdhbnRPcmRlcmVkICYmIGxpc3QudGFnTmFtZSAhPT0gXCJPTFwiKSB8fCAoIXdhbnRPcmRlcmVkICYmIGxpc3QudGFnTmFtZSAhPT0gXCJVTFwiKSkge1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgbGlzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQod2FudE9yZGVyZWQgPyBcIm9sXCIgOiBcInVsXCIpO1xuICAgICAgICBsaXN0LmNsYXNzTmFtZSA9IHdhbnRPcmRlcmVkXG4gICAgICAgICAgPyBcIm0tMCBsaXN0LWRlY2ltYWwgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCJcbiAgICAgICAgICA6IFwibS0wIGxpc3QtZGlzYyBzcGFjZS15LTEgcGwtNSBsZWFkaW5nLTVcIjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxpID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxpXCIpO1xuICAgICAgYXBwZW5kSW5saW5lTWFya2Rvd24obGksICh1bm9yZGVyZWQgPz8gb3JkZXJlZCk/LlsxXSA/PyBcIlwiKTtcbiAgICAgIGxpc3QuYXBwZW5kQ2hpbGQobGkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgcXVvdGUgPSAvXj5cXHM/KC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHF1b3RlKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb25zdCBibG9ja3F1b3RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJsb2NrcXVvdGVcIik7XG4gICAgICBibG9ja3F1b3RlLmNsYXNzTmFtZSA9IFwibS0wIGJvcmRlci1sLTIgYm9yZGVyLXRva2VuLWJvcmRlciBwbC0zIGxlYWRpbmctNVwiO1xuICAgICAgYXBwZW5kSW5saW5lTWFya2Rvd24oYmxvY2txdW90ZSwgcXVvdGVbMV0pO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChibG9ja3F1b3RlKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHBhcmFncmFwaC5wdXNoKHRyaW1tZWQpO1xuICB9XG5cbiAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgZmx1c2hMaXN0KCk7XG4gIGZsdXNoQ29kZSgpO1xuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gYXBwZW5kSW5saW5lTWFya2Rvd24ocGFyZW50OiBIVE1MRWxlbWVudCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHBhdHRlcm4gPSAvKGAoW15gXSspYHxcXFsoW15cXF1dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKXxcXCpcXCooW14qXSspXFwqXFwqfFxcKihbXipdKylcXCopL2c7XG4gIGxldCBsYXN0SW5kZXggPSAwO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHRleHQubWF0Y2hBbGwocGF0dGVybikpIHtcbiAgICBpZiAobWF0Y2guaW5kZXggPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgYXBwZW5kVGV4dChwYXJlbnQsIHRleHQuc2xpY2UobGFzdEluZGV4LCBtYXRjaC5pbmRleCkpO1xuICAgIGlmIChtYXRjaFsyXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBjb2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImNvZGVcIik7XG4gICAgICBjb2RlLmNsYXNzTmFtZSA9XG4gICAgICAgIFwicm91bmRlZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIHB4LTEgcHktMC41IHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIGNvZGUudGV4dENvbnRlbnQgPSBtYXRjaFsyXTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChjb2RlKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzNdICE9PSB1bmRlZmluZWQgJiYgbWF0Y2hbNF0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICAgICAgYS5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IHVuZGVybGluZSB1bmRlcmxpbmUtb2Zmc2V0LTJcIjtcbiAgICAgIGEuaHJlZiA9IG1hdGNoWzRdO1xuICAgICAgYS50YXJnZXQgPSBcIl9ibGFua1wiO1xuICAgICAgYS5yZWwgPSBcIm5vb3BlbmVyIG5vcmVmZXJyZXJcIjtcbiAgICAgIGEudGV4dENvbnRlbnQgPSBtYXRjaFszXTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChhKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzVdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHN0cm9uZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHJvbmdcIik7XG4gICAgICBzdHJvbmcuY2xhc3NOYW1lID0gXCJmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgICAgc3Ryb25nLnRleHRDb250ZW50ID0gbWF0Y2hbNV07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoc3Ryb25nKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzZdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImVtXCIpO1xuICAgICAgZW0udGV4dENvbnRlbnQgPSBtYXRjaFs2XTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChlbSk7XG4gICAgfVxuICAgIGxhc3RJbmRleCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuICB9XG4gIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCkpO1xufVxuXG5mdW5jdGlvbiBhcHBlbmRUZXh0KHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAodGV4dCkgcGFyZW50LmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHRleHQpKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2F0Y2hlckhlYWx0aENhcmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC13YXRjaGVyLWhlYWx0aFwiKVxuICAgIC50aGVuKChoZWFsdGgpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkLCBoZWFsdGggYXMgV2F0Y2hlckhlYWx0aCk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgY2hlY2sgd2F0Y2hlclwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkOiBIVE1MRWxlbWVudCwgaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQod2F0Y2hlclN1bW1hcnlSb3coaGVhbHRoKSk7XG4gIGZvciAoY29uc3QgY2hlY2sgb2YgaGVhbHRoLmNoZWNrcykge1xuICAgIGlmIChjaGVjay5zdGF0dXMgPT09IFwib2tcIikgY29udGludWU7XG4gICAgY2FyZC5hcHBlbmRDaGlsZCh3YXRjaGVyQ2hlY2tSb3coY2hlY2spKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB3YXRjaGVyU3VtbWFyeVJvdyhoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShoZWFsdGguc3RhdHVzLCBoZWFsdGgud2F0Y2hlcikpO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBoZWFsdGgudGl0bGU7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGAke2hlYWx0aC5zdW1tYXJ5fSBDaGVja2VkICR7bmV3IERhdGUoaGVhbHRoLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBhY3Rpb24uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjYXJkID0gcm93LnBhcmVudEVsZW1lbnQ7XG4gICAgICBpZiAoIWNhcmQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB3YXRjaGVyXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gICAgICByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZChjYXJkKTtcbiAgICB9KSxcbiAgKTtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbik7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHdhdGNoZXJDaGVja1JvdyhjaGVjazogV2F0Y2hlckhlYWx0aENoZWNrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSByb3dTaW1wbGUoY2hlY2submFtZSwgY2hlY2suZGV0YWlsKTtcbiAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChsZWZ0KSBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UoY2hlY2suc3RhdHVzKSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHN0YXR1c0JhZGdlKHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIGxhYmVsPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCB0b25lID1cbiAgICBzdGF0dXMgPT09IFwib2tcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMtZ3JlZW4gdGV4dC10b2tlbi1jaGFydHMtZ3JlZW5cIlxuICAgICAgOiBzdGF0dXMgPT09IFwid2FyblwiXG4gICAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLXllbGxvdyB0ZXh0LXRva2VuLWNoYXJ0cy15ZWxsb3dcIlxuICAgICAgICA6IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1yZWQgdGV4dC10b2tlbi1jaGFydHMtcmVkXCI7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IGBpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBweC0yIHB5LTAuNSB0ZXh0LXhzIGZvbnQtbWVkaXVtICR7dG9uZX1gO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IGxhYmVsIHx8IChzdGF0dXMgPT09IFwib2tcIiA/IFwiT0tcIiA6IHN0YXR1cyA9PT0gXCJ3YXJuXCIgPyBcIlJldmlld1wiIDogXCJFcnJvclwiKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KGNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKCFjaGVjaykgcmV0dXJuIFwiTm8gdXBkYXRlIGNoZWNrIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBsYXRlc3QgPSBjaGVjay5sYXRlc3RWZXJzaW9uID8gYExhdGVzdCB2JHtjaGVjay5sYXRlc3RWZXJzaW9ufS4gYCA6IFwiXCI7XG4gIGNvbnN0IGNoZWNrZWQgPSBgQ2hlY2tlZCAke25ldyBEYXRlKGNoZWNrLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgaWYgKGNoZWNrLmVycm9yKSByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH0gJHtjaGVjay5lcnJvcn1gO1xuICByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH1gO1xufVxuXG5mdW5jdGlvbiB1bmluc3RhbGxSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJVbmluc3RhbGwgQ29kZXgrK1wiLFxuICAgIFwiQ29waWVzIHRoZSB1bmluc3RhbGwgY29tbWFuZC4gUnVuIGl0IGZyb20gYSB0ZXJtaW5hbCBhZnRlciBxdWl0dGluZyBDb2RleC5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNvcHkgQ29tbWFuZFwiLCAoKSA9PiB7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJjb2RleHBwOmNvcHktdGV4dFwiLCBcIm5vZGUgfi8uY29kZXgtcGx1c3BsdXMvc291cmNlL3BhY2thZ2VzL2luc3RhbGxlci9kaXN0L2NsaS5qcyB1bmluc3RhbGxcIilcbiAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiY29weSB1bmluc3RhbGwgY29tbWFuZCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlcG9ydEJ1Z1JvdygpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIlJlcG9ydCBhIGJ1Z1wiLFxuICAgIFwiT3BlbiBhIEdpdEh1YiBpc3N1ZSB3aXRoIHJ1bnRpbWUsIGluc3RhbGxlciwgb3IgdHdlYWstbWFuYWdlciBkZXRhaWxzLlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiT3BlbiBJc3N1ZVwiLCAoKSA9PiB7XG4gICAgICBjb25zdCB0aXRsZSA9IGVuY29kZVVSSUNvbXBvbmVudChcIltCdWddOiBcIik7XG4gICAgICBjb25zdCBib2R5ID0gZW5jb2RlVVJJQ29tcG9uZW50KFxuICAgICAgICBbXG4gICAgICAgICAgXCIjIyBXaGF0IGhhcHBlbmVkP1wiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBTdGVwcyB0byByZXByb2R1Y2VcIixcbiAgICAgICAgICBcIjEuIFwiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBFbnZpcm9ubWVudFwiLFxuICAgICAgICAgIFwiLSBDb2RleCsrIHZlcnNpb246IFwiLFxuICAgICAgICAgIFwiLSBDb2RleCBhcHAgdmVyc2lvbjogXCIsXG4gICAgICAgICAgXCItIE9TOiBcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgTG9nc1wiLFxuICAgICAgICAgIFwiQXR0YWNoIHJlbGV2YW50IGxpbmVzIGZyb20gdGhlIENvZGV4KysgbG9nIGRpcmVjdG9yeS5cIixcbiAgICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLFxuICAgICAgICBgaHR0cHM6Ly9naXRodWIuY29tL2FndXN0aWYvY29kZXgtcGx1c3BsdXMvaXNzdWVzL25ldz90aXRsZT0ke3RpdGxlfSZib2R5PSR7Ym9keX1gLFxuICAgICAgKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gYWN0aW9uUm93KHRpdGxlVGV4dDogc3RyaW5nLCBkZXNjcmlwdGlvbjogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIHJvdy5zdHlsZS5mbGV4V3JhcCA9IFwid3JhcFwiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBsZWZ0LnN0eWxlLmZsZXggPSBcIjEgMSAxOHJlbVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gdGl0bGVUZXh0O1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2Muc3R5bGUub3ZlcmZsb3dXcmFwID0gXCJhbnl3aGVyZVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmRhdGFzZXQuY29kZXhwcFJvd0FjdGlvbnMgPSBcInRydWVcIjtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGFjdGlvbnMuc3R5bGUuZmxleFdyYXAgPSBcIndyYXBcIjtcbiAgYWN0aW9ucy5zdHlsZS5qdXN0aWZ5Q29udGVudCA9IFwiZmxleC1lbmRcIjtcbiAgYWN0aW9ucy5zdHlsZS5tYXhXaWR0aCA9IFwiMTAwJVwiO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrc1BhZ2Uoc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBvcGVuQnRuID0gb3BlbkluUGxhY2VCdXR0b24oXCJPcGVuIFR3ZWFrcyBGb2xkZXJcIiwgKCkgPT4ge1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgdHdlYWtzUGF0aCgpKTtcbiAgfSk7XG4gIGNvbnN0IHJlbG9hZEJ0biA9IG9wZW5JblBsYWNlQnV0dG9uKFwiRm9yY2UgUmVsb2FkXCIsICgpID0+IHtcbiAgICAvLyBGdWxsIHBhZ2UgcmVmcmVzaCBcdTIwMTQgc2FtZSBhcyBEZXZUb29scyBDbWQtUiAvIG91ciBDRFAgUGFnZS5yZWxvYWQuXG4gICAgLy8gTWFpbiByZS1kaXNjb3ZlcnMgdHdlYWtzIGZpcnN0IHNvIHRoZSBuZXcgcmVuZGVyZXIgY29tZXMgdXAgd2l0aCBhXG4gICAgLy8gZnJlc2ggdHdlYWsgc2V0OyB0aGVuIGxvY2F0aW9uLnJlbG9hZCByZXN0YXJ0cyB0aGUgcmVuZGVyZXIgc28gdGhlXG4gICAgLy8gcHJlbG9hZCByZS1pbml0aWFsaXplcyBhZ2FpbnN0IGl0LlxuICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgIC5pbnZva2UoXCJjb2RleHBwOnJlbG9hZC10d2Vha3NcIilcbiAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImZvcmNlIHJlbG9hZCAobWFpbikgZmFpbGVkXCIsIFN0cmluZyhlKSkpXG4gICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIGxvY2F0aW9uLnJlbG9hZCgpO1xuICAgICAgfSk7XG4gIH0pO1xuICAvLyBEcm9wIHRoZSBkaWFnb25hbC1hcnJvdyBpY29uIGZyb20gdGhlIHJlbG9hZCBidXR0b24gXHUyMDE0IGl0IGltcGxpZXMgXCJvcGVuXG4gIC8vIG91dCBvZiBhcHBcIiB3aGljaCBkb2Vzbid0IGZpdC4gUmVwbGFjZSBpdHMgdHJhaWxpbmcgc3ZnIHdpdGggYSByZWZyZXNoLlxuICBjb25zdCByZWxvYWRTdmcgPSByZWxvYWRCdG4ucXVlcnlTZWxlY3RvcihcInN2Z1wiKTtcbiAgaWYgKHJlbG9hZFN2Zykge1xuICAgIHJlbG9hZFN2Zy5vdXRlckhUTUwgPVxuICAgICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi0yeHNcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICAgIGA8cGF0aCBkPVwiTTQgMTBhNiA2IDAgMCAxIDEwLjI0LTQuMjRMMTYgNy41TTE2IDR2My41aC0zLjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgICBgPHBhdGggZD1cIk0xNiAxMGE2IDYgMCAwIDEtMTAuMjQgNC4yNEw0IDEyLjVNNCAxNnYtMy41aDMuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICAgIGA8L3N2Zz5gO1xuICB9XG5cbiAgY29uc3QgdHJhaWxpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0cmFpbGluZy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIHRyYWlsaW5nLmFwcGVuZENoaWxkKHJlbG9hZEJ0bik7XG4gIHRyYWlsaW5nLmFwcGVuZENoaWxkKG9wZW5CdG4pO1xuXG4gIGlmIChzdGF0ZS5saXN0ZWRUd2Vha3MubGVuZ3RoID09PSAwKSB7XG4gICAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICAgIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gICAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJJbnN0YWxsZWQgVHdlYWtzXCIsIHRyYWlsaW5nKSk7XG4gICAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChcbiAgICAgIHJvd1NpbXBsZShcbiAgICAgICAgXCJObyB0d2Vha3MgaW5zdGFsbGVkXCIsXG4gICAgICAgIGBEcm9wIGEgdHdlYWsgZm9sZGVyIGludG8gJHt0d2Vha3NQYXRoKCl9IGFuZCByZWxvYWQuYCxcbiAgICAgICksXG4gICAgKTtcbiAgICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICAgIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBHcm91cCByZWdpc3RlcmVkIFNldHRpbmdzU2VjdGlvbnMgYnkgdHdlYWsgaWQgKHByZWZpeCBzcGxpdCBhdCBcIjpcIikuXG4gIGNvbnN0IHNlY3Rpb25zQnlUd2VhayA9IG5ldyBNYXA8c3RyaW5nLCBTZXR0aW5nc1NlY3Rpb25bXT4oKTtcbiAgZm9yIChjb25zdCBzIG9mIHN0YXRlLnNlY3Rpb25zLnZhbHVlcygpKSB7XG4gICAgY29uc3QgdHdlYWtJZCA9IHMuaWQuc3BsaXQoXCI6XCIpWzBdO1xuICAgIGlmICghc2VjdGlvbnNCeVR3ZWFrLmhhcyh0d2Vha0lkKSkgc2VjdGlvbnNCeVR3ZWFrLnNldCh0d2Vha0lkLCBbXSk7XG4gICAgc2VjdGlvbnNCeVR3ZWFrLmdldCh0d2Vha0lkKSEucHVzaChzKTtcbiAgfVxuXG4gIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgd3JhcC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgd3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJJbnN0YWxsZWQgVHdlYWtzXCIsIHRyYWlsaW5nKSk7XG5cbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGZvciAoY29uc3QgdCBvZiBzdGF0ZS5saXN0ZWRUd2Vha3MpIHtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHR3ZWFrUm93KHQsIHNlY3Rpb25zQnlUd2Vhay5nZXQodC5tYW5pZmVzdC5pZCkgPz8gW10pKTtcbiAgfVxuICB3cmFwLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQod3JhcCk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrUm93KHQ6IExpc3RlZFR3ZWFrLCBzZWN0aW9uczogU2V0dGluZ3NTZWN0aW9uW10pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IG0gPSB0Lm1hbmlmZXN0O1xuXG4gIC8vIE91dGVyIGNlbGwgd3JhcHMgdGhlIGhlYWRlciByb3cgKyAob3B0aW9uYWwpIG5lc3RlZCBzZWN0aW9ucyBzbyB0aGVcbiAgLy8gcGFyZW50IGNhcmQncyBkaXZpZGVyIHN0YXlzIGJldHdlZW4gKnR3ZWFrcyosIG5vdCBiZXR3ZWVuIGhlYWRlciBhbmRcbiAgLy8gYm9keSBvZiB0aGUgc2FtZSB0d2Vhay5cbiAgY29uc3QgY2VsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNlbGwuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sXCI7XG4gIGlmICghdC5lbmFibGVkKSBjZWxsLnN0eWxlLm9wYWNpdHkgPSBcIjAuN1wiO1xuXG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtc3RhcnQganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuXG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBpdGVtcy1zdGFydCBnYXAtM1wiO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBBdmF0YXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGF2YXRhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGF2YXRhci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcm91bmRlZC1tZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBvdmVyZmxvdy1oaWRkZW4gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBhdmF0YXIuc3R5bGUud2lkdGggPSBcIjU2cHhcIjtcbiAgYXZhdGFyLnN0eWxlLmhlaWdodCA9IFwiNTZweFwiO1xuICBhdmF0YXIuc3R5bGUuYmFja2dyb3VuZENvbG9yID0gXCJ2YXIoLS1jb2xvci10b2tlbi1iZy1mb2csIHRyYW5zcGFyZW50KVwiO1xuICBpZiAobS5pY29uVXJsKSB7XG4gICAgY29uc3QgaW1nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImltZ1wiKTtcbiAgICBpbWcuYWx0ID0gXCJcIjtcbiAgICBpbWcuY2xhc3NOYW1lID0gXCJzaXplLWZ1bGwgb2JqZWN0LWNvbnRhaW5cIjtcbiAgICAvLyBJbml0aWFsOiBzaG93IGZhbGxiYWNrIGluaXRpYWwgaW4gY2FzZSB0aGUgaWNvbiBmYWlscyB0byBsb2FkLlxuICAgIGNvbnN0IGluaXRpYWwgPSAobS5uYW1lPy5bMF0gPz8gXCI/XCIpLnRvVXBwZXJDYXNlKCk7XG4gICAgY29uc3QgZmFsbGJhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBmYWxsYmFjay5jbGFzc05hbWUgPSBcInRleHQteGwgZm9udC1tZWRpdW1cIjtcbiAgICBmYWxsYmFjay50ZXh0Q29udGVudCA9IGluaXRpYWw7XG4gICAgYXZhdGFyLmFwcGVuZENoaWxkKGZhbGxiYWNrKTtcbiAgICBpbWcuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICAgIGltZy5hZGRFdmVudExpc3RlbmVyKFwibG9hZFwiLCAoKSA9PiB7XG4gICAgICBmYWxsYmFjay5yZW1vdmUoKTtcbiAgICAgIGltZy5zdHlsZS5kaXNwbGF5ID0gXCJcIjtcbiAgICB9KTtcbiAgICBpbWcuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsICgpID0+IHtcbiAgICAgIGltZy5yZW1vdmUoKTtcbiAgICB9KTtcbiAgICB2b2lkIHJlc29sdmVJY29uVXJsKG0uaWNvblVybCwgdC5kaXIpLnRoZW4oKHVybCkgPT4ge1xuICAgICAgaWYgKHVybCkgaW1nLnNyYyA9IHVybDtcbiAgICAgIGVsc2UgaW1nLnJlbW92ZSgpO1xuICAgIH0pO1xuICAgIGF2YXRhci5hcHBlbmRDaGlsZChpbWcpO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGluaXRpYWwgPSAobS5uYW1lPy5bMF0gPz8gXCI/XCIpLnRvVXBwZXJDYXNlKCk7XG4gICAgY29uc3Qgc3BhbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHNwYW4uY2xhc3NOYW1lID0gXCJ0ZXh0LXhsIGZvbnQtbWVkaXVtXCI7XG4gICAgc3Bhbi50ZXh0Q29udGVudCA9IGluaXRpYWw7XG4gICAgYXZhdGFyLmFwcGVuZENoaWxkKHNwYW4pO1xuICB9XG4gIGxlZnQuYXBwZW5kQ2hpbGQoYXZhdGFyKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgVGV4dCBzdGFjayBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMC41XCI7XG5cbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBuYW1lLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIG5hbWUudGV4dENvbnRlbnQgPSBtLm5hbWU7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKG5hbWUpO1xuICBpZiAobS52ZXJzaW9uKSB7XG4gICAgY29uc3QgdmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgdmVyLmNsYXNzTmFtZSA9XG4gICAgICBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgdGV4dC14cyBmb250LW5vcm1hbCB0YWJ1bGFyLW51bXNcIjtcbiAgICB2ZXIudGV4dENvbnRlbnQgPSBgdiR7bS52ZXJzaW9ufWA7XG4gICAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodmVyKTtcbiAgfVxuICBpZiAodC51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSkge1xuICAgIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgYmFkZ2UuY2xhc3NOYW1lID1cbiAgICAgIFwicm91bmRlZC1mdWxsIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIGJhZGdlLnRleHRDb250ZW50ID0gXCJVcGRhdGUgQXZhaWxhYmxlXCI7XG4gICAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQoYmFkZ2UpO1xuICB9XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlUm93KTtcblxuICBpZiAobS5kZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICAgIGRlc2MudGV4dENvbnRlbnQgPSBtLmRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGRlc2MpO1xuICB9XG5cbiAgY29uc3QgbWV0YSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG1ldGEuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMiB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgY29uc3QgYXV0aG9yRWwgPSByZW5kZXJBdXRob3IobS5hdXRob3IpO1xuICBpZiAoYXV0aG9yRWwpIG1ldGEuYXBwZW5kQ2hpbGQoYXV0aG9yRWwpO1xuICBpZiAobS5naXRodWJSZXBvKSB7XG4gICAgaWYgKG1ldGEuY2hpbGRyZW4ubGVuZ3RoID4gMCkgbWV0YS5hcHBlbmRDaGlsZChkb3QoKSk7XG4gICAgY29uc3QgcmVwbyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgcmVwby50eXBlID0gXCJidXR0b25cIjtcbiAgICByZXBvLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggdGV4dC10b2tlbi10ZXh0LWxpbmstZm9yZWdyb3VuZCBob3Zlcjp1bmRlcmxpbmVcIjtcbiAgICByZXBvLnRleHRDb250ZW50ID0gbS5naXRodWJSZXBvO1xuICAgIHJlcG8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgYGh0dHBzOi8vZ2l0aHViLmNvbS8ke20uZ2l0aHViUmVwb31gKTtcbiAgICB9KTtcbiAgICBtZXRhLmFwcGVuZENoaWxkKHJlcG8pO1xuICB9XG4gIGlmIChtLmhvbWVwYWdlKSB7XG4gICAgaWYgKG1ldGEuY2hpbGRyZW4ubGVuZ3RoID4gMCkgbWV0YS5hcHBlbmRDaGlsZChkb3QoKSk7XG4gICAgY29uc3QgbGluayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICAgIGxpbmsuaHJlZiA9IG0uaG9tZXBhZ2U7XG4gICAgbGluay50YXJnZXQgPSBcIl9ibGFua1wiO1xuICAgIGxpbmsucmVsID0gXCJub3JlZmVycmVyXCI7XG4gICAgbGluay5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gICAgbGluay50ZXh0Q29udGVudCA9IFwiSG9tZXBhZ2VcIjtcbiAgICBtZXRhLmFwcGVuZENoaWxkKGxpbmspO1xuICB9XG4gIGlmIChtZXRhLmNoaWxkcmVuLmxlbmd0aCA+IDApIHN0YWNrLmFwcGVuZENoaWxkKG1ldGEpO1xuXG4gIC8vIFRhZ3Mgcm93IChpZiBhbnkpIFx1MjAxNCBzbWFsbCBwaWxsIGNoaXBzIGJlbG93IHRoZSBtZXRhIGxpbmUuXG4gIGlmIChtLnRhZ3MgJiYgbS50YWdzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCB0YWdzUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICB0YWdzUm93LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGdhcC0xIHB0LTAuNVwiO1xuICAgIGZvciAoY29uc3QgdGFnIG9mIG0udGFncykge1xuICAgICAgY29uc3QgcGlsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgICAgcGlsbC5jbGFzc05hbWUgPVxuICAgICAgICBcInJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wLjUgdGV4dC1bMTFweF0gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICAgICAgcGlsbC50ZXh0Q29udGVudCA9IHRhZztcbiAgICAgIHRhZ3NSb3cuYXBwZW5kQ2hpbGQocGlsbCk7XG4gICAgfVxuICAgIHN0YWNrLmFwcGVuZENoaWxkKHRhZ3NSb3cpO1xuICB9XG5cbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICAvLyBcdTI1MDBcdTI1MDAgVG9nZ2xlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCByaWdodCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJpZ2h0LmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTIgcHQtMC41XCI7XG4gIGlmICh0LnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlICYmIHQudXBkYXRlLnJlbGVhc2VVcmwpIHtcbiAgICByaWdodC5hcHBlbmRDaGlsZChcbiAgICAgIGNvbXBhY3RCdXR0b24oXCJSZXZpZXcgUmVsZWFzZVwiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsIHQudXBkYXRlIS5yZWxlYXNlVXJsKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgcmlnaHQuYXBwZW5kQ2hpbGQoXG4gICAgc3dpdGNoQ29udHJvbCh0LmVuYWJsZWQsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnNldC10d2Vhay1lbmFibGVkXCIsIG0uaWQsIG5leHQpO1xuICAgICAgLy8gVGhlIG1haW4gcHJvY2VzcyBicm9hZGNhc3RzIGEgcmVsb2FkIHdoaWNoIHdpbGwgcmUtZmV0Y2ggdGhlIGxpc3RcbiAgICAgIC8vIGFuZCByZS1yZW5kZXIuIFdlIGRvbid0IG9wdGltaXN0aWNhbGx5IHRvZ2dsZSB0byBhdm9pZCBkcmlmdC5cbiAgICB9KSxcbiAgKTtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKHJpZ2h0KTtcblxuICBjZWxsLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgLy8gSWYgdGhlIHR3ZWFrIGlzIGVuYWJsZWQgYW5kIHJlZ2lzdGVyZWQgc2V0dGluZ3Mgc2VjdGlvbnMsIHJlbmRlciB0aG9zZVxuICAvLyBib2RpZXMgYXMgbmVzdGVkIHJvd3MgYmVuZWF0aCB0aGUgaGVhZGVyIGluc2lkZSB0aGUgc2FtZSBjZWxsLlxuICBpZiAodC5lbmFibGVkICYmIHNlY3Rpb25zLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBuZXN0ZWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIG5lc3RlZC5jbGFzc05hbWUgPVxuICAgICAgXCJmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciBib3JkZXItdC1bMC41cHhdIGJvcmRlci10b2tlbi1ib3JkZXJcIjtcbiAgICBmb3IgKGNvbnN0IHMgb2Ygc2VjdGlvbnMpIHtcbiAgICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYm9keS5jbGFzc05hbWUgPSBcInAtM1wiO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcy5yZW5kZXIoYm9keSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGJvZHkudGV4dENvbnRlbnQgPSBgRXJyb3IgcmVuZGVyaW5nIHR3ZWFrIHNlY3Rpb246ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICAgIH1cbiAgICAgIG5lc3RlZC5hcHBlbmRDaGlsZChib2R5KTtcbiAgICB9XG4gICAgY2VsbC5hcHBlbmRDaGlsZChuZXN0ZWQpO1xuICB9XG5cbiAgcmV0dXJuIGNlbGw7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckF1dGhvcihhdXRob3I6IFR3ZWFrTWFuaWZlc3RbXCJhdXRob3JcIl0pOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBpZiAoIWF1dGhvcikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgd3JhcC5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciBnYXAtMVwiO1xuICBpZiAodHlwZW9mIGF1dGhvciA9PT0gXCJzdHJpbmdcIikge1xuICAgIHdyYXAudGV4dENvbnRlbnQgPSBgYnkgJHthdXRob3J9YDtcbiAgICByZXR1cm4gd3JhcDtcbiAgfVxuICB3cmFwLmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKFwiYnkgXCIpKTtcbiAgaWYgKGF1dGhvci51cmwpIHtcbiAgICBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gICAgYS5ocmVmID0gYXV0aG9yLnVybDtcbiAgICBhLnRhcmdldCA9IFwiX2JsYW5rXCI7XG4gICAgYS5yZWwgPSBcIm5vcmVmZXJyZXJcIjtcbiAgICBhLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggdGV4dC10b2tlbi10ZXh0LWxpbmstZm9yZWdyb3VuZCBob3Zlcjp1bmRlcmxpbmVcIjtcbiAgICBhLnRleHRDb250ZW50ID0gYXV0aG9yLm5hbWU7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChhKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBzcGFuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgc3Bhbi50ZXh0Q29udGVudCA9IGF1dGhvci5uYW1lO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoc3Bhbik7XG4gIH1cbiAgcmV0dXJuIHdyYXA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBjb21wb25lbnRzIFx1MjUwMFx1MjUwMFxuXG4vKiogVGhlIGZ1bGwgcGFuZWwgc2hlbGwgKHRvb2xiYXIgKyBzY3JvbGwgKyBoZWFkaW5nICsgc2VjdGlvbnMgd3JhcCkuICovXG5mdW5jdGlvbiBwYW5lbFNoZWxsKFxuICB0aXRsZTogc3RyaW5nLFxuICBzdWJ0aXRsZT86IHN0cmluZyxcbik6IHsgb3V0ZXI6IEhUTUxFbGVtZW50OyBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50OyBzdWJ0aXRsZT86IEhUTUxFbGVtZW50IH0ge1xuICBjb25zdCBvdXRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG91dGVyLmNsYXNzTmFtZSA9IFwibWFpbi1zdXJmYWNlIGZsZXggaC1mdWxsIG1pbi1oLTAgZmxleC1jb2xcIjtcblxuICBjb25zdCB0b29sYmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdG9vbGJhci5jbGFzc05hbWUgPVxuICAgIFwiZHJhZ2dhYmxlIGZsZXggaXRlbXMtY2VudGVyIHB4LXBhbmVsIGVsZWN0cm9uOmgtdG9vbGJhciBleHRlbnNpb246aC10b29sYmFyLXNtXCI7XG4gIG91dGVyLmFwcGVuZENoaWxkKHRvb2xiYXIpO1xuXG4gIGNvbnN0IHNjcm9sbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHNjcm9sbC5jbGFzc05hbWUgPSBcImZsZXgtMSBvdmVyZmxvdy15LWF1dG8gcC1wYW5lbFwiO1xuICBvdXRlci5hcHBlbmRDaGlsZChzY3JvbGwpO1xuXG4gIGNvbnN0IGlubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaW5uZXIuY2xhc3NOYW1lID1cbiAgICBcIm14LWF1dG8gZmxleCB3LWZ1bGwgZmxleC1jb2wgbWF4LXctMnhsIGVsZWN0cm9uOm1pbi13LVtjYWxjKDMyMHB4KnZhcigtLWNvZGV4LXdpbmRvdy16b29tKSldXCI7XG4gIHNjcm9sbC5hcHBlbmRDaGlsZChpbm5lcik7XG5cbiAgY29uc3QgaGVhZGVyV3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlcldyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTMgcGItcGFuZWxcIjtcbiAgY29uc3QgaGVhZGVySW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJJbm5lci5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgZmxleC1jb2wgZ2FwLTEuNSBwYi1wYW5lbFwiO1xuICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGluZy5jbGFzc05hbWUgPSBcImVsZWN0cm9uOmhlYWRpbmctbGcgaGVhZGluZy1iYXNlIHRydW5jYXRlXCI7XG4gIGhlYWRpbmcudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgaGVhZGVySW5uZXIuYXBwZW5kQ2hpbGQoaGVhZGluZyk7XG4gIGxldCBzdWJ0aXRsZUVsZW1lbnQ6IEhUTUxFbGVtZW50IHwgdW5kZWZpbmVkO1xuICBpZiAoc3VidGl0bGUpIHtcbiAgICBjb25zdCBzdWIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHN1Yi5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgdGV4dC1zbVwiO1xuICAgIHN1Yi50ZXh0Q29udGVudCA9IHN1YnRpdGxlO1xuICAgIGhlYWRlcklubmVyLmFwcGVuZENoaWxkKHN1Yik7XG4gICAgc3VidGl0bGVFbGVtZW50ID0gc3ViO1xuICB9XG4gIGhlYWRlcldyYXAuYXBwZW5kQ2hpbGQoaGVhZGVySW5uZXIpO1xuICBpbm5lci5hcHBlbmRDaGlsZChoZWFkZXJXcmFwKTtcblxuICBjb25zdCBzZWN0aW9uc1dyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzZWN0aW9uc1dyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1bdmFyKC0tcGFkZGluZy1wYW5lbCldXCI7XG4gIGlubmVyLmFwcGVuZENoaWxkKHNlY3Rpb25zV3JhcCk7XG5cbiAgcmV0dXJuIHsgb3V0ZXIsIHNlY3Rpb25zV3JhcCwgc3VidGl0bGU6IHN1YnRpdGxlRWxlbWVudCB9O1xufVxuXG5mdW5jdGlvbiBzZWN0aW9uVGl0bGUodGV4dDogc3RyaW5nLCB0cmFpbGluZz86IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB0aXRsZVJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlUm93LmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtdG9vbGJhciBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIHB4LTAgcHktMFwiO1xuICBjb25zdCB0aXRsZUlubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVJbm5lci5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHQuY2xhc3NOYW1lID0gXCJ0ZXh0LWJhc2UgZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHRpdGxlSW5uZXIuYXBwZW5kQ2hpbGQodCk7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHRpdGxlSW5uZXIpO1xuICBpZiAodHJhaWxpbmcpIHtcbiAgICBjb25zdCByaWdodCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcmlnaHQuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICAgIHJpZ2h0LmFwcGVuZENoaWxkKHRyYWlsaW5nKTtcbiAgICB0aXRsZVJvdy5hcHBlbmRDaGlsZChyaWdodCk7XG4gIH1cbiAgcmV0dXJuIHRpdGxlUm93O1xufVxuXG4vKipcbiAqIENvZGV4J3MgXCJPcGVuIGNvbmZpZy50b21sXCItc3R5bGUgdHJhaWxpbmcgYnV0dG9uOiBnaG9zdCBib3JkZXIsIG11dGVkXG4gKiBsYWJlbCwgdG9wLXJpZ2h0IGRpYWdvbmFsIGFycm93IGljb24uIE1hcmt1cCBtaXJyb3JzIENvbmZpZ3VyYXRpb24gcGFuZWwuXG4gKi9cbmZ1bmN0aW9uIG9wZW5JblBsYWNlQnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uQ2xpY2s6ICgpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgYm9yZGVyIHdoaXRlc3BhY2Utbm93cmFwIGZvY3VzOm91dGxpbmUtbm9uZSBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MCByb3VuZGVkLWxnIHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZCBlbmFibGVkOmhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBkYXRhLVtzdGF0ZT1vcGVuXTpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgYm9yZGVyLXRyYW5zcGFyZW50IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIHB4LTIgcHktMCB0ZXh0LWJhc2UgbGVhZGluZy1bMThweF1cIjtcbiAgYnRuLmlubmVySFRNTCA9XG4gICAgYCR7bGFiZWx9YCArXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi0yeHNcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0xNC4zMzQ5IDEzLjMzMDFWNi42MDY0NUw1LjQ3MDY1IDE1LjQ3MDdDNS4yMTA5NSAxNS43MzA0IDQuNzg4OTUgMTUuNzMwNCA0LjUyOTI1IDE1LjQ3MDdDNC4yNjk1NSAxNS4yMTEgNC4yNjk1NSAxNC43ODkgNC41MjkyNSAxNC41MjkzTDEzLjM5MzUgNS42NjUwNEg2LjY2MDExQzYuMjkyODQgNS42NjUwNCA1Ljk5NTA3IDUuMzY3MjcgNS45OTUwNyA1QzUuOTk1MDcgNC42MzI3MyA2LjI5Mjg0IDQuMzM0OTYgNi42NjAxMSA0LjMzNDk2SDE0Ljk5OTlMMTUuMTMzNyA0LjM0ODYzQzE1LjQzNjkgNC40MTA1NyAxNS42NjUgNC42Nzg1NyAxNS42NjUgNVYxMy4zMzAxQzE1LjY2NDkgMTMuNjk3MyAxNS4zNjcyIDEzLjk5NTEgMTQuOTk5OSAxMy45OTUxQzE0LjYzMjcgMTMuOTk1MSAxNC4zMzUgMTMuNjk3MyAxNC4zMzQ5IDEzLjMzMDFaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiPjwvcGF0aD5gICtcbiAgICBgPC9zdmc+YDtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIG9uQ2xpY2soKTtcbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIGNvbXBhY3RCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgYm9yZGVyIHB4LTIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBlbmFibGVkOmhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MFwiO1xuICBidG4udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIG9uQ2xpY2soKTtcbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIHJvdW5kZWRDYXJkKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNhcmQuY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgZmxleCBmbGV4LWNvbCBkaXZpZGUteS1bMC41cHhdIGRpdmlkZS10b2tlbi1ib3JkZXIgcm91bmRlZC1sZyBib3JkZXJcIjtcbiAgY2FyZC5zZXRBdHRyaWJ1dGUoXG4gICAgXCJzdHlsZVwiLFxuICAgIFwiYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tY29sb3ItYmFja2dyb3VuZC1wYW5lbCwgdmFyKC0tY29sb3ItdG9rZW4tYmctZm9nKSk7XCIsXG4gICk7XG4gIHJldHVybiBjYXJkO1xufVxuXG5mdW5jdGlvbiByb3dTaW1wbGUodGl0bGU6IHN0cmluZyB8IHVuZGVmaW5lZCwgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIGdhcC0zXCI7XG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgaWYgKHRpdGxlKSB7XG4gICAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgdC5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIHQudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgICBzdGFjay5hcHBlbmRDaGlsZCh0KTtcbiAgfVxuICBpZiAoZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBkLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgICBkLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQoZCk7XG4gIH1cbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgcmV0dXJuIHJvdztcbn1cblxuLyoqXG4gKiBDb2RleC1zdHlsZWQgdG9nZ2xlIHN3aXRjaC4gTWFya3VwIG1pcnJvcnMgdGhlIEdlbmVyYWwgPiBQZXJtaXNzaW9ucyByb3dcbiAqIHN3aXRjaCB3ZSBjYXB0dXJlZDogb3V0ZXIgYnV0dG9uIChyb2xlPXN3aXRjaCksIGlubmVyIHBpbGwsIHNsaWRpbmcga25vYi5cbiAqL1xuZnVuY3Rpb24gc3dpdGNoQ29udHJvbChcbiAgaW5pdGlhbDogYm9vbGVhbixcbiAgb25DaGFuZ2U6IChuZXh0OiBib29sZWFuKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPixcbik6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInN3aXRjaFwiKTtcblxuICBjb25zdCBwaWxsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbnN0IGtub2IgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAga25vYi5jbGFzc05hbWUgPVxuICAgIFwicm91bmRlZC1mdWxsIGJvcmRlciBib3JkZXItW2NvbG9yOnZhcigtLWdyYXktMCldIGJnLVtjb2xvcjp2YXIoLS1ncmF5LTApXSBzaGFkb3ctc20gdHJhbnNpdGlvbi10cmFuc2Zvcm0gZHVyYXRpb24tMjAwIGVhc2Utb3V0IGgtNCB3LTRcIjtcbiAgcGlsbC5hcHBlbmRDaGlsZChrbm9iKTtcblxuICBjb25zdCBhcHBseSA9IChvbjogYm9vbGVhbik6IHZvaWQgPT4ge1xuICAgIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWNoZWNrZWRcIiwgU3RyaW5nKG9uKSk7XG4gICAgYnRuLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBidG4uY2xhc3NOYW1lID1cbiAgICAgIFwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIHRleHQtc20gZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW5vbmUgZm9jdXMtdmlzaWJsZTpyaW5nLTIgZm9jdXMtdmlzaWJsZTpyaW5nLXRva2VuLWZvY3VzLWJvcmRlciBmb2N1cy12aXNpYmxlOnJvdW5kZWQtZnVsbCBjdXJzb3ItaW50ZXJhY3Rpb25cIjtcbiAgICBwaWxsLmNsYXNzTmFtZSA9IGByZWxhdGl2ZSBpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIHRyYW5zaXRpb24tY29sb3JzIGR1cmF0aW9uLTIwMCBlYXNlLW91dCBoLTUgdy04ICR7XG4gICAgICBvbiA/IFwiYmctdG9rZW4tY2hhcnRzLWJsdWVcIiA6IFwiYmctdG9rZW4tZm9yZWdyb3VuZC8yMFwiXG4gICAgfWA7XG4gICAgcGlsbC5kYXRhc2V0LnN0YXRlID0gb24gPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCI7XG4gICAga25vYi5kYXRhc2V0LnN0YXRlID0gb24gPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCI7XG4gICAga25vYi5zdHlsZS50cmFuc2Zvcm0gPSBvbiA/IFwidHJhbnNsYXRlWCgxNHB4KVwiIDogXCJ0cmFuc2xhdGVYKDJweClcIjtcbiAgfTtcbiAgYXBwbHkoaW5pdGlhbCk7XG5cbiAgYnRuLmFwcGVuZENoaWxkKHBpbGwpO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgY29uc3QgbmV4dCA9IGJ0bi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWNoZWNrZWRcIikgIT09IFwidHJ1ZVwiO1xuICAgIGFwcGx5KG5leHQpO1xuICAgIGJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IG9uQ2hhbmdlKG5leHQpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBkb3QoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHMuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgcy50ZXh0Q29udGVudCA9IFwiXHUwMEI3XCI7XG4gIHJldHVybiBzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgaWNvbnMgXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGNvbmZpZ0ljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gU2xpZGVycyAvIHNldHRpbmdzIGdseXBoLiAyMHgyMCBjdXJyZW50Q29sb3IuXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMyA1aDlNMTUgNWgyTTMgMTBoMk04IDEwaDlNMyAxNWgxMU0xNyAxNWgwXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjEzXCIgY3k9XCI1XCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI2XCIgY3k9XCIxMFwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiMTVcIiBjeT1cIjE1XCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gcGF0Y2hNYW5hZ2VySWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBBcHAgYnVuZGxlICsgcmVwYWlyL2NoZWNrIGdseXBoLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTQgNS41QTIuNSAyLjUgMCAwIDEgNi41IDNoN0EyLjUgMi41IDAgMCAxIDE2IDUuNXY5QTIuNSAyLjUgMCAwIDEgMTMuNSAxN2gtN0EyLjUgMi41IDAgMCAxIDQgMTQuNXYtOVpcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNyA3aDZNNyAxMGgzXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk04LjI1IDEzLjI1IDkuNiAxNC42bDIuOS0zLjJcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtzSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBTcGFya2xlcyAvIFwiKytcIiBnbHlwaCBmb3IgdHdlYWtzLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTEwIDIuNSBMMTEuNCA4LjYgTDE3LjUgMTAgTDExLjQgMTEuNCBMMTAgMTcuNSBMOC42IDExLjQgTDIuNSAxMCBMOC42IDguNiBaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPHBhdGggZD1cIk0xNS41IDMgTDE2IDUgTDE4IDUuNSBMMTYgNiBMMTUuNSA4IEwxNSA2IEwxMyA1LjUgTDE1IDUgWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBvcGFjaXR5PVwiMC43XCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRQYWdlSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBEb2N1bWVudC9wYWdlIGdseXBoIGZvciB0d2Vhay1yZWdpc3RlcmVkIHBhZ2VzIHdpdGhvdXQgdGhlaXIgb3duIGljb24uXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNNSAzaDdsMyAzdjExYTEgMSAwIDAgMS0xIDFINWExIDEgMCAwIDEtMS0xVjRhMSAxIDAgMCAxIDEtMVpcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk0xMiAzdjNhMSAxIDAgMCAwIDEgMWgyXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNyAxMWg2TTcgMTRoNFwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUljb25VcmwoXG4gIHVybDogc3RyaW5nLFxuICB0d2Vha0Rpcjogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGlmICgvXihodHRwcz86fGRhdGE6KS8udGVzdCh1cmwpKSByZXR1cm4gdXJsO1xuICAvLyBSZWxhdGl2ZSBwYXRoIFx1MjE5MiBhc2sgbWFpbiB0byByZWFkIHRoZSBmaWxlIGFuZCByZXR1cm4gYSBkYXRhOiBVUkwuXG4gIC8vIFJlbmRlcmVyIGlzIHNhbmRib3hlZCBzbyBmaWxlOi8vIHdvbid0IGxvYWQgZGlyZWN0bHkuXG4gIGNvbnN0IHJlbCA9IHVybC5zdGFydHNXaXRoKFwiLi9cIikgPyB1cmwuc2xpY2UoMikgOiB1cmw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICBcImNvZGV4cHA6cmVhZC10d2Vhay1hc3NldFwiLFxuICAgICAgdHdlYWtEaXIsXG4gICAgICByZWwsXG4gICAgKSkgYXMgc3RyaW5nO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcGxvZyhcImljb24gbG9hZCBmYWlsZWRcIiwgeyB1cmwsIHR3ZWFrRGlyLCBlcnI6IFN0cmluZyhlKSB9KTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgRE9NIGhldXJpc3RpY3MgXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGZpbmRTaWRlYmFySXRlbXNHcm91cCgpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICAvLyBBbmNob3Igc3RyYXRlZ3kgZmlyc3QgKHdvdWxkIGJlIGlkZWFsIGlmIENvZGV4IHN3aXRjaGVzIHRvIDxhPikuXG4gIGNvbnN0IGxpbmtzID0gQXJyYXkuZnJvbShcbiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxBbmNob3JFbGVtZW50PihcImFbaHJlZio9Jy9zZXR0aW5ncy8nXVwiKSxcbiAgKTtcbiAgaWYgKGxpbmtzLmxlbmd0aCA+PSAyKSB7XG4gICAgbGV0IG5vZGU6IEhUTUxFbGVtZW50IHwgbnVsbCA9IGxpbmtzWzBdLnBhcmVudEVsZW1lbnQ7XG4gICAgd2hpbGUgKG5vZGUpIHtcbiAgICAgIGNvbnN0IGluc2lkZSA9IG5vZGUucXVlcnlTZWxlY3RvckFsbChcImFbaHJlZio9Jy9zZXR0aW5ncy8nXVwiKTtcbiAgICAgIGlmIChpbnNpZGUubGVuZ3RoID49IE1hdGgubWF4KDIsIGxpbmtzLmxlbmd0aCAtIDEpKSByZXR1cm4gbm9kZTtcbiAgICAgIG5vZGUgPSBub2RlLnBhcmVudEVsZW1lbnQ7XG4gICAgfVxuICB9XG5cbiAgLy8gVGV4dC1jb250ZW50IG1hdGNoIGFnYWluc3QgQ29kZXgncyBrbm93biBzaWRlYmFyIGxhYmVscy5cbiAgY29uc3QgS05PV04gPSBbXG4gICAgXCJHZW5lcmFsXCIsXG4gICAgXCJBcHBlYXJhbmNlXCIsXG4gICAgXCJDb25maWd1cmF0aW9uXCIsXG4gICAgXCJQZXJzb25hbGl6YXRpb25cIixcbiAgICBcIk1DUCBzZXJ2ZXJzXCIsXG4gICAgXCJNQ1AgU2VydmVyc1wiLFxuICAgIFwiR2l0XCIsXG4gICAgXCJFbnZpcm9ubWVudHNcIixcbiAgXTtcbiAgY29uc3QgbWF0Y2hlczogSFRNTEVsZW1lbnRbXSA9IFtdO1xuICBjb25zdCBhbGwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcbiAgICBcImJ1dHRvbiwgYSwgW3JvbGU9J2J1dHRvbiddLCBsaSwgZGl2XCIsXG4gICk7XG4gIGZvciAoY29uc3QgZWwgb2YgQXJyYXkuZnJvbShhbGwpKSB7XG4gICAgY29uc3QgdCA9IChlbC50ZXh0Q29udGVudCA/PyBcIlwiKS50cmltKCk7XG4gICAgaWYgKHQubGVuZ3RoID4gMzApIGNvbnRpbnVlO1xuICAgIGlmIChLTk9XTi5zb21lKChrKSA9PiB0ID09PSBrKSkgbWF0Y2hlcy5wdXNoKGVsKTtcbiAgICBpZiAobWF0Y2hlcy5sZW5ndGggPiA1MCkgYnJlYWs7XG4gIH1cbiAgaWYgKG1hdGNoZXMubGVuZ3RoID49IDIpIHtcbiAgICBsZXQgbm9kZTogSFRNTEVsZW1lbnQgfCBudWxsID0gbWF0Y2hlc1swXS5wYXJlbnRFbGVtZW50O1xuICAgIHdoaWxlIChub2RlKSB7XG4gICAgICBsZXQgY291bnQgPSAwO1xuICAgICAgZm9yIChjb25zdCBtIG9mIG1hdGNoZXMpIGlmIChub2RlLmNvbnRhaW5zKG0pKSBjb3VudCsrO1xuICAgICAgaWYgKGNvdW50ID49IE1hdGgubWluKDMsIG1hdGNoZXMubGVuZ3RoKSkgcmV0dXJuIG5vZGU7XG4gICAgICBub2RlID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gZmluZENvbnRlbnRBcmVhKCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGNvbnN0IHNpZGViYXIgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgaWYgKCFzaWRlYmFyKSByZXR1cm4gbnVsbDtcbiAgbGV0IHBhcmVudCA9IHNpZGViYXIucGFyZW50RWxlbWVudDtcbiAgd2hpbGUgKHBhcmVudCkge1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShwYXJlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICAgIGlmIChjaGlsZCA9PT0gc2lkZWJhciB8fCBjaGlsZC5jb250YWlucyhzaWRlYmFyKSkgY29udGludWU7XG4gICAgICBjb25zdCByID0gY2hpbGQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICBpZiAoci53aWR0aCA+IDMwMCAmJiByLmhlaWdodCA+IDIwMCkgcmV0dXJuIGNoaWxkO1xuICAgIH1cbiAgICBwYXJlbnQgPSBwYXJlbnQucGFyZW50RWxlbWVudDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbWF5YmVEdW1wRG9tKCk6IHZvaWQge1xuICB0cnkge1xuICAgIGNvbnN0IHNpZGViYXIgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgICBpZiAoc2lkZWJhciAmJiAhc3RhdGUuc2lkZWJhckR1bXBlZCkge1xuICAgICAgc3RhdGUuc2lkZWJhckR1bXBlZCA9IHRydWU7XG4gICAgICBjb25zdCBzYlJvb3QgPSBzaWRlYmFyLnBhcmVudEVsZW1lbnQgPz8gc2lkZWJhcjtcbiAgICAgIHBsb2coYGNvZGV4IHNpZGViYXIgSFRNTGAsIHNiUm9vdC5vdXRlckhUTUwuc2xpY2UoMCwgMzIwMDApKTtcbiAgICB9XG4gICAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICAgIGlmICghY29udGVudCkge1xuICAgICAgaWYgKHN0YXRlLmZpbmdlcnByaW50ICE9PSBsb2NhdGlvbi5ocmVmKSB7XG4gICAgICAgIHN0YXRlLmZpbmdlcnByaW50ID0gbG9jYXRpb24uaHJlZjtcbiAgICAgICAgcGxvZyhcImRvbSBwcm9iZSAobm8gY29udGVudClcIiwge1xuICAgICAgICAgIHVybDogbG9jYXRpb24uaHJlZixcbiAgICAgICAgICBzaWRlYmFyOiBzaWRlYmFyID8gZGVzY3JpYmUoc2lkZWJhcikgOiBudWxsLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHBhbmVsOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwID09PSBcInR3ZWFrcy1wYW5lbFwiKSBjb250aW51ZTtcbiAgICAgIGlmIChjaGlsZC5zdHlsZS5kaXNwbGF5ID09PSBcIm5vbmVcIikgY29udGludWU7XG4gICAgICBwYW5lbCA9IGNoaWxkO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNvbnN0IGFjdGl2ZU5hdiA9IHNpZGViYXJcbiAgICAgID8gQXJyYXkuZnJvbShzaWRlYmFyLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiYnV0dG9uLCBhXCIpKS5maW5kKFxuICAgICAgICAgIChiKSA9PlxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIikgPT09IFwicGFnZVwiIHx8XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImRhdGEtYWN0aXZlXCIpID09PSBcInRydWVcIiB8fFxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIpID09PSBcInRydWVcIiB8fFxuICAgICAgICAgICAgYi5jbGFzc0xpc3QuY29udGFpbnMoXCJhY3RpdmVcIiksXG4gICAgICAgIClcbiAgICAgIDogbnVsbDtcbiAgICBjb25zdCBoZWFkaW5nID0gcGFuZWw/LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFxuICAgICAgXCJoMSwgaDIsIGgzLCBbY2xhc3MqPSdoZWFkaW5nJ11cIixcbiAgICApO1xuICAgIGNvbnN0IGZpbmdlcnByaW50ID0gYCR7YWN0aXZlTmF2Py50ZXh0Q29udGVudCA/PyBcIlwifXwke2hlYWRpbmc/LnRleHRDb250ZW50ID8/IFwiXCJ9fCR7cGFuZWw/LmNoaWxkcmVuLmxlbmd0aCA/PyAwfWA7XG4gICAgaWYgKHN0YXRlLmZpbmdlcnByaW50ID09PSBmaW5nZXJwcmludCkgcmV0dXJuO1xuICAgIHN0YXRlLmZpbmdlcnByaW50ID0gZmluZ2VycHJpbnQ7XG4gICAgcGxvZyhcImRvbSBwcm9iZVwiLCB7XG4gICAgICB1cmw6IGxvY2F0aW9uLmhyZWYsXG4gICAgICBhY3RpdmVOYXY6IGFjdGl2ZU5hdj8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBudWxsLFxuICAgICAgaGVhZGluZzogaGVhZGluZz8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBudWxsLFxuICAgICAgY29udGVudDogZGVzY3JpYmUoY29udGVudCksXG4gICAgfSk7XG4gICAgaWYgKHBhbmVsKSB7XG4gICAgICBjb25zdCBodG1sID0gcGFuZWwub3V0ZXJIVE1MO1xuICAgICAgcGxvZyhcbiAgICAgICAgYGNvZGV4IHBhbmVsIEhUTUwgKCR7YWN0aXZlTmF2Py50ZXh0Q29udGVudD8udHJpbSgpID8/IFwiP1wifSlgLFxuICAgICAgICBodG1sLnNsaWNlKDAsIDMyMDAwKSxcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgcGxvZyhcImRvbSBwcm9iZSBmYWlsZWRcIiwgU3RyaW5nKGUpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBkZXNjcmliZShlbDogSFRNTEVsZW1lbnQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB7XG4gICAgdGFnOiBlbC50YWdOYW1lLFxuICAgIGNsczogZWwuY2xhc3NOYW1lLnNsaWNlKDAsIDEyMCksXG4gICAgaWQ6IGVsLmlkIHx8IHVuZGVmaW5lZCxcbiAgICBjaGlsZHJlbjogZWwuY2hpbGRyZW4ubGVuZ3RoLFxuICAgIHJlY3Q6ICgoKSA9PiB7XG4gICAgICBjb25zdCByID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICByZXR1cm4geyB3OiBNYXRoLnJvdW5kKHIud2lkdGgpLCBoOiBNYXRoLnJvdW5kKHIuaGVpZ2h0KSB9O1xuICAgIH0pKCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc1BhdGgoKTogc3RyaW5nIHtcbiAgcmV0dXJuIChcbiAgICAod2luZG93IGFzIHVua25vd24gYXMgeyBfX2NvZGV4cHBfdHdlYWtzX2Rpcl9fPzogc3RyaW5nIH0pLl9fY29kZXhwcF90d2Vha3NfZGlyX18gPz9cbiAgICBcIjx1c2VyIGRpcj4vdHdlYWtzXCJcbiAgKTtcbn1cbiIsICIvKipcbiAqIFJlbmRlcmVyLXNpZGUgdHdlYWsgaG9zdC4gV2U6XG4gKiAgIDEuIEFzayBtYWluIGZvciB0aGUgdHdlYWsgbGlzdCAod2l0aCByZXNvbHZlZCBlbnRyeSBwYXRoKS5cbiAqICAgMi4gRm9yIGVhY2ggcmVuZGVyZXItc2NvcGVkIChvciBcImJvdGhcIikgdHdlYWssIGZldGNoIGl0cyBzb3VyY2UgdmlhIElQQ1xuICogICAgICBhbmQgZXhlY3V0ZSBpdCBhcyBhIENvbW1vbkpTLXNoYXBlZCBmdW5jdGlvbi5cbiAqICAgMy4gUHJvdmlkZSBpdCB0aGUgcmVuZGVyZXIgaGFsZiBvZiB0aGUgQVBJLlxuICpcbiAqIENvZGV4IHJ1bnMgdGhlIHJlbmRlcmVyIHdpdGggc2FuZGJveDogdHJ1ZSwgc28gTm9kZSdzIGByZXF1aXJlKClgIGlzXG4gKiByZXN0cmljdGVkIHRvIGEgdGlueSB3aGl0ZWxpc3QgKGVsZWN0cm9uICsgYSBmZXcgcG9seWZpbGxzKS4gVGhhdCBtZWFucyB3ZVxuICogY2Fubm90IGByZXF1aXJlKClgIGFyYml0cmFyeSB0d2VhayBmaWxlcyBmcm9tIGRpc2suIEluc3RlYWQgd2UgcHVsbCB0aGVcbiAqIHNvdXJjZSBzdHJpbmcgZnJvbSBtYWluIGFuZCBldmFsdWF0ZSBpdCB3aXRoIGBuZXcgRnVuY3Rpb25gIGluc2lkZSB0aGVcbiAqIHByZWxvYWQgY29udGV4dC4gVHdlYWsgYXV0aG9ycyB3aG8gbmVlZCBucG0gZGVwcyBtdXN0IGJ1bmRsZSB0aGVtIGluLlxuICovXG5cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgeyByZWdpc3RlclNlY3Rpb24sIHJlZ2lzdGVyUGFnZSwgY2xlYXJTZWN0aW9ucywgc2V0TGlzdGVkVHdlYWtzIH0gZnJvbSBcIi4vc2V0dGluZ3MtaW5qZWN0b3JcIjtcbmltcG9ydCB7IGZpYmVyRm9yTm9kZSB9IGZyb20gXCIuL3JlYWN0LWhvb2tcIjtcbmltcG9ydCB0eXBlIHtcbiAgVHdlYWtNYW5pZmVzdCxcbiAgVHdlYWtBcGksXG4gIFJlYWN0RmliZXJOb2RlLFxuICBUd2Vhayxcbn0gZnJvbSBcIkBjb2RleC1wbHVzcGx1cy9zZGtcIjtcblxuaW50ZXJmYWNlIExpc3RlZFR3ZWFrIHtcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIGVudHJ5OiBzdHJpbmc7XG4gIGRpcjogc3RyaW5nO1xuICBlbnRyeUV4aXN0czogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgdXBkYXRlOiB7XG4gICAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gICAgcmVwbzogc3RyaW5nO1xuICAgIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gICAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgICBsYXRlc3RUYWc6IHN0cmluZyB8IG51bGw7XG4gICAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gICAgZXJyb3I/OiBzdHJpbmc7XG4gIH0gfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgVXNlclBhdGhzIHtcbiAgdXNlclJvb3Q6IHN0cmluZztcbiAgcnVudGltZURpcjogc3RyaW5nO1xuICB0d2Vha3NEaXI6IHN0cmluZztcbiAgbG9nRGlyOiBzdHJpbmc7XG59XG5cbmNvbnN0IGxvYWRlZCA9IG5ldyBNYXA8c3RyaW5nLCB7IHN0b3A/OiAoKSA9PiB2b2lkIH0+KCk7XG5sZXQgY2FjaGVkUGF0aHM6IFVzZXJQYXRocyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRUd2Vha0hvc3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmxpc3QtdHdlYWtzXCIpKSBhcyBMaXN0ZWRUd2Vha1tdO1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnVzZXItcGF0aHNcIikpIGFzIFVzZXJQYXRocztcbiAgY2FjaGVkUGF0aHMgPSBwYXRocztcbiAgLy8gUHVzaCB0aGUgbGlzdCB0byB0aGUgc2V0dGluZ3MgaW5qZWN0b3Igc28gdGhlIFR3ZWFrcyBwYWdlIGNhbiByZW5kZXJcbiAgLy8gY2FyZHMgZXZlbiBiZWZvcmUgYW55IHR3ZWFrJ3Mgc3RhcnQoKSBydW5zIChhbmQgZm9yIGRpc2FibGVkIHR3ZWFrc1xuICAvLyB0aGF0IHdlIG5ldmVyIGxvYWQpLlxuICBzZXRMaXN0ZWRUd2Vha3ModHdlYWtzKTtcbiAgLy8gU3Rhc2ggZm9yIHRoZSBzZXR0aW5ncyBpbmplY3RvcidzIGVtcHR5LXN0YXRlIG1lc3NhZ2UuXG4gICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fY29kZXhwcF90d2Vha3NfZGlyX18/OiBzdHJpbmcgfSkuX19jb2RleHBwX3R3ZWFrc19kaXJfXyA9XG4gICAgcGF0aHMudHdlYWtzRGlyO1xuXG4gIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICBpZiAodC5tYW5pZmVzdC5zY29wZSA9PT0gXCJtYWluXCIpIGNvbnRpbnVlO1xuICAgIGlmICghdC5lbnRyeUV4aXN0cykgY29udGludWU7XG4gICAgaWYgKCF0LmVuYWJsZWQpIGNvbnRpbnVlO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBsb2FkVHdlYWsodCwgcGF0aHMpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbY29kZXgtcGx1c3BsdXNdIHR3ZWFrIGxvYWQgZmFpbGVkOlwiLCB0Lm1hbmlmZXN0LmlkLCBlKTtcbiAgICB9XG4gIH1cblxuICBjb25zb2xlLmluZm8oXG4gICAgYFtjb2RleC1wbHVzcGx1c10gcmVuZGVyZXIgaG9zdCBsb2FkZWQgJHtsb2FkZWQuc2l6ZX0gdHdlYWsocyk6YCxcbiAgICBbLi4ubG9hZGVkLmtleXMoKV0uam9pbihcIiwgXCIpIHx8IFwiKG5vbmUpXCIsXG4gICk7XG4gIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgXCJjb2RleHBwOnByZWxvYWQtbG9nXCIsXG4gICAgXCJpbmZvXCIsXG4gICAgYHJlbmRlcmVyIGhvc3QgbG9hZGVkICR7bG9hZGVkLnNpemV9IHR3ZWFrKHMpOiAke1suLi5sb2FkZWQua2V5cygpXS5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIn1gLFxuICApO1xufVxuXG4vKipcbiAqIFN0b3AgZXZlcnkgcmVuZGVyZXItc2NvcGUgdHdlYWsgc28gYSBzdWJzZXF1ZW50IGBzdGFydFR3ZWFrSG9zdCgpYCB3aWxsXG4gKiByZS1ldmFsdWF0ZSBmcmVzaCBzb3VyY2UuIE1vZHVsZSBjYWNoZSBpc24ndCByZWxldmFudCBzaW5jZSB3ZSBldmFsXG4gKiBzb3VyY2Ugc3RyaW5ncyBkaXJlY3RseSBcdTIwMTQgZWFjaCBsb2FkIGNyZWF0ZXMgYSBmcmVzaCBzY29wZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRlYXJkb3duVHdlYWtIb3N0KCk6IHZvaWQge1xuICBmb3IgKGNvbnN0IFtpZCwgdF0gb2YgbG9hZGVkKSB7XG4gICAgdHJ5IHtcbiAgICAgIHQuc3RvcD8uKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS53YXJuKFwiW2NvZGV4LXBsdXNwbHVzXSB0d2VhayBzdG9wIGZhaWxlZDpcIiwgaWQsIGUpO1xuICAgIH1cbiAgfVxuICBsb2FkZWQuY2xlYXIoKTtcbiAgY2xlYXJTZWN0aW9ucygpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkVHdlYWsodDogTGlzdGVkVHdlYWssIHBhdGhzOiBVc2VyUGF0aHMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc291cmNlID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICBcImNvZGV4cHA6cmVhZC10d2Vhay1zb3VyY2VcIixcbiAgICB0LmVudHJ5LFxuICApKSBhcyBzdHJpbmc7XG5cbiAgLy8gRXZhbHVhdGUgYXMgQ0pTLXNoYXBlZDogcHJvdmlkZSBtb2R1bGUvZXhwb3J0cy9hcGkuIFR3ZWFrIGNvZGUgbWF5IHVzZVxuICAvLyBgbW9kdWxlLmV4cG9ydHMgPSB7IHN0YXJ0LCBzdG9wIH1gIG9yIGBleHBvcnRzLnN0YXJ0ID0gLi4uYCBvciBwdXJlIEVTTVxuICAvLyBkZWZhdWx0IGV4cG9ydCBzaGFwZSAod2UgYWNjZXB0IGJvdGgpLlxuICBjb25zdCBtb2R1bGUgPSB7IGV4cG9ydHM6IHt9IGFzIHsgZGVmYXVsdD86IFR3ZWFrIH0gJiBUd2VhayB9O1xuICBjb25zdCBleHBvcnRzID0gbW9kdWxlLmV4cG9ydHM7XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8taW1wbGllZC1ldmFsLCBuby1uZXctZnVuY1xuICBjb25zdCBmbiA9IG5ldyBGdW5jdGlvbihcbiAgICBcIm1vZHVsZVwiLFxuICAgIFwiZXhwb3J0c1wiLFxuICAgIFwiY29uc29sZVwiLFxuICAgIGAke3NvdXJjZX1cXG4vLyMgc291cmNlVVJMPWNvZGV4cHAtdHdlYWs6Ly8ke2VuY29kZVVSSUNvbXBvbmVudCh0Lm1hbmlmZXN0LmlkKX0vJHtlbmNvZGVVUklDb21wb25lbnQodC5lbnRyeSl9YCxcbiAgKTtcbiAgZm4obW9kdWxlLCBleHBvcnRzLCBjb25zb2xlKTtcbiAgY29uc3QgbW9kID0gbW9kdWxlLmV4cG9ydHMgYXMgeyBkZWZhdWx0PzogVHdlYWsgfSAmIFR3ZWFrO1xuICBjb25zdCB0d2VhazogVHdlYWsgPSAobW9kIGFzIHsgZGVmYXVsdD86IFR3ZWFrIH0pLmRlZmF1bHQgPz8gKG1vZCBhcyBUd2Vhayk7XG4gIGlmICh0eXBlb2YgdHdlYWs/LnN0YXJ0ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHR3ZWFrICR7dC5tYW5pZmVzdC5pZH0gaGFzIG5vIHN0YXJ0KClgKTtcbiAgfVxuICBjb25zdCBhcGkgPSBtYWtlUmVuZGVyZXJBcGkodC5tYW5pZmVzdCwgcGF0aHMpO1xuICBhd2FpdCB0d2Vhay5zdGFydChhcGkpO1xuICBsb2FkZWQuc2V0KHQubWFuaWZlc3QuaWQsIHsgc3RvcDogdHdlYWsuc3RvcD8uYmluZCh0d2VhaykgfSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VSZW5kZXJlckFwaShtYW5pZmVzdDogVHdlYWtNYW5pZmVzdCwgcGF0aHM6IFVzZXJQYXRocyk6IFR3ZWFrQXBpIHtcbiAgY29uc3QgaWQgPSBtYW5pZmVzdC5pZDtcbiAgY29uc3QgbG9nID0gKGxldmVsOiBcImRlYnVnXCIgfCBcImluZm9cIiB8IFwid2FyblwiIHwgXCJlcnJvclwiLCAuLi5hOiB1bmtub3duW10pID0+IHtcbiAgICBjb25zdCBjb25zb2xlRm4gPVxuICAgICAgbGV2ZWwgPT09IFwiZGVidWdcIiA/IGNvbnNvbGUuZGVidWdcbiAgICAgIDogbGV2ZWwgPT09IFwid2FyblwiID8gY29uc29sZS53YXJuXG4gICAgICA6IGxldmVsID09PSBcImVycm9yXCIgPyBjb25zb2xlLmVycm9yXG4gICAgICA6IGNvbnNvbGUubG9nO1xuICAgIGNvbnNvbGVGbihgW2NvZGV4LXBsdXNwbHVzXVske2lkfV1gLCAuLi5hKTtcbiAgICAvLyBBbHNvIG1pcnJvciB0byBtYWluJ3MgbG9nIGZpbGUgc28gd2UgY2FuIGRpYWdub3NlIHR3ZWFrIGJlaGF2aW9yXG4gICAgLy8gd2l0aG91dCBhdHRhY2hpbmcgRGV2VG9vbHMuIFN0cmluZ2lmeSBlYWNoIGFyZyBkZWZlbnNpdmVseS5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFydHMgPSBhLm1hcCgodikgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHYgPT09IFwic3RyaW5nXCIpIHJldHVybiB2O1xuICAgICAgICBpZiAodiBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gYCR7di5uYW1lfTogJHt2Lm1lc3NhZ2V9YDtcbiAgICAgICAgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHYpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyh2KTsgfVxuICAgICAgfSk7XG4gICAgICBpcGNSZW5kZXJlci5zZW5kKFxuICAgICAgICBcImNvZGV4cHA6cHJlbG9hZC1sb2dcIixcbiAgICAgICAgbGV2ZWwsXG4gICAgICAgIGBbdHdlYWsgJHtpZH1dICR7cGFydHMuam9pbihcIiBcIil9YCxcbiAgICAgICk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBzd2FsbG93IFx1MjAxNCBuZXZlciBsZXQgbG9nZ2luZyBicmVhayBhIHR3ZWFrICovXG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IGdpdCA9IG1hbmlmZXN0LnBlcm1pc3Npb25zPy5pbmNsdWRlcyhcImdpdC5tZXRhZGF0YVwiKSA/IHJlbmRlcmVyR2l0KCkgOiB1bmRlZmluZWQ7XG5cbiAgcmV0dXJuIHtcbiAgICBtYW5pZmVzdCxcbiAgICBwcm9jZXNzOiBcInJlbmRlcmVyXCIsXG4gICAgbG9nOiB7XG4gICAgICBkZWJ1ZzogKC4uLmEpID0+IGxvZyhcImRlYnVnXCIsIC4uLmEpLFxuICAgICAgaW5mbzogKC4uLmEpID0+IGxvZyhcImluZm9cIiwgLi4uYSksXG4gICAgICB3YXJuOiAoLi4uYSkgPT4gbG9nKFwid2FyblwiLCAuLi5hKSxcbiAgICAgIGVycm9yOiAoLi4uYSkgPT4gbG9nKFwiZXJyb3JcIiwgLi4uYSksXG4gICAgfSxcbiAgICBzdG9yYWdlOiByZW5kZXJlclN0b3JhZ2UoaWQpLFxuICAgIHNldHRpbmdzOiB7XG4gICAgICByZWdpc3RlcjogKHMpID0+IHJlZ2lzdGVyU2VjdGlvbih7IC4uLnMsIGlkOiBgJHtpZH06JHtzLmlkfWAgfSksXG4gICAgICByZWdpc3RlclBhZ2U6IChwKSA9PlxuICAgICAgICByZWdpc3RlclBhZ2UoaWQsIG1hbmlmZXN0LCB7IC4uLnAsIGlkOiBgJHtpZH06JHtwLmlkfWAgfSksXG4gICAgfSxcbiAgICByZWFjdDoge1xuICAgICAgZ2V0RmliZXI6IChuKSA9PiBmaWJlckZvck5vZGUobikgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsLFxuICAgICAgZmluZE93bmVyQnlOYW1lOiAobiwgbmFtZSkgPT4ge1xuICAgICAgICBsZXQgZiA9IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGw7XG4gICAgICAgIHdoaWxlIChmKSB7XG4gICAgICAgICAgY29uc3QgdCA9IGYudHlwZSBhcyB7IGRpc3BsYXlOYW1lPzogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0gfCBudWxsO1xuICAgICAgICAgIGlmICh0ICYmICh0LmRpc3BsYXlOYW1lID09PSBuYW1lIHx8IHQubmFtZSA9PT0gbmFtZSkpIHJldHVybiBmO1xuICAgICAgICAgIGYgPSBmLnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICB3YWl0Rm9yRWxlbWVudDogKHNlbCwgdGltZW91dE1zID0gNTAwMCkgPT5cbiAgICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgIGlmIChleGlzdGluZykgcmV0dXJuIHJlc29sdmUoZXhpc3RpbmcpO1xuICAgICAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIHRpbWVvdXRNcztcbiAgICAgICAgICBjb25zdCBvYnMgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTtcbiAgICAgICAgICAgIGlmIChlbCkge1xuICAgICAgICAgICAgICBvYnMuZGlzY29ubmVjdCgpO1xuICAgICAgICAgICAgICByZXNvbHZlKGVsKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoRGF0ZS5ub3coKSA+IGRlYWRsaW5lKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYHRpbWVvdXQgd2FpdGluZyBmb3IgJHtzZWx9YCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIG9icy5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gICAgICAgIH0pLFxuICAgIH0sXG4gICAgaXBjOiB7XG4gICAgICBvbjogKGMsIGgpID0+IHtcbiAgICAgICAgY29uc3Qgd3JhcHBlZCA9IChfZTogdW5rbm93biwgLi4uYXJnczogdW5rbm93bltdKSA9PiBoKC4uLmFyZ3MpO1xuICAgICAgICBpcGNSZW5kZXJlci5vbihgY29kZXhwcDoke2lkfToke2N9YCwgd3JhcHBlZCk7XG4gICAgICAgIHJldHVybiAoKSA9PiBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihgY29kZXhwcDoke2lkfToke2N9YCwgd3JhcHBlZCk7XG4gICAgICB9LFxuICAgICAgc2VuZDogKGMsIC4uLmFyZ3MpID0+IGlwY1JlbmRlcmVyLnNlbmQoYGNvZGV4cHA6JHtpZH06JHtjfWAsIC4uLmFyZ3MpLFxuICAgICAgaW52b2tlOiA8VD4oYzogc3RyaW5nLCAuLi5hcmdzOiB1bmtub3duW10pID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShgY29kZXhwcDoke2lkfToke2N9YCwgLi4uYXJncykgYXMgUHJvbWlzZTxUPixcbiAgICB9LFxuICAgIGZzOiByZW5kZXJlckZzKGlkLCBwYXRocyksXG4gICAgLi4uKGdpdCA/IHsgZ2l0IH0gOiB7fSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyU3RvcmFnZShpZDogc3RyaW5nKSB7XG4gIGNvbnN0IGtleSA9IGBjb2RleHBwOnN0b3JhZ2U6JHtpZH1gO1xuICBjb25zdCByZWFkID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oa2V5KSA/PyBcInt9XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cbiAgfTtcbiAgY29uc3Qgd3JpdGUgPSAodjogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oa2V5LCBKU09OLnN0cmluZ2lmeSh2KSk7XG4gIHJldHVybiB7XG4gICAgZ2V0OiA8VD4oazogc3RyaW5nLCBkPzogVCkgPT4gKGsgaW4gcmVhZCgpID8gKHJlYWQoKVtrXSBhcyBUKSA6IChkIGFzIFQpKSxcbiAgICBzZXQ6IChrOiBzdHJpbmcsIHY6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IG8gPSByZWFkKCk7XG4gICAgICBvW2tdID0gdjtcbiAgICAgIHdyaXRlKG8pO1xuICAgIH0sXG4gICAgZGVsZXRlOiAoazogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCBvID0gcmVhZCgpO1xuICAgICAgZGVsZXRlIG9ba107XG4gICAgICB3cml0ZShvKTtcbiAgICB9LFxuICAgIGFsbDogKCkgPT4gcmVhZCgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlckZzKGlkOiBzdHJpbmcsIF9wYXRoczogVXNlclBhdGhzKSB7XG4gIC8vIFNhbmRib3hlZCByZW5kZXJlciBjYW4ndCB1c2UgTm9kZSBmcyBkaXJlY3RseSBcdTIwMTQgcHJveHkgdGhyb3VnaCBtYWluIElQQy5cbiAgcmV0dXJuIHtcbiAgICBkYXRhRGlyOiBgPHJlbW90ZT4vdHdlYWstZGF0YS8ke2lkfWAsXG4gICAgcmVhZDogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dHdlYWstZnNcIiwgXCJyZWFkXCIsIGlkLCBwKSBhcyBQcm9taXNlPHN0cmluZz4sXG4gICAgd3JpdGU6IChwOiBzdHJpbmcsIGM6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dHdlYWstZnNcIiwgXCJ3cml0ZVwiLCBpZCwgcCwgYykgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBleGlzdHM6IChwOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnR3ZWFrLWZzXCIsIFwiZXhpc3RzXCIsIGlkLCBwKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlckdpdCgpIHtcbiAgcmV0dXJuIHtcbiAgICByZXNvbHZlUmVwb3NpdG9yeTogKHBhdGg6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LXJlc29sdmUtcmVwb3NpdG9yeVwiLCBwYXRoKSxcbiAgICBnZXRTdGF0dXM6IChwYXRoOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdpdC1zdGF0dXNcIiwgcGF0aCksXG4gICAgZ2V0RGlmZlN1bW1hcnk6IChwYXRoOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdpdC1kaWZmLXN1bW1hcnlcIiwgcGF0aCksXG4gICAgZ2V0V29ya3RyZWVzOiAocGF0aDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnaXQtd29ya3RyZWVzXCIsIHBhdGgpLFxuICB9O1xufVxuIiwgIi8qKlxuICogQnVpbHQtaW4gXCJUd2VhayBNYW5hZ2VyXCIgXHUyMDE0IGF1dG8taW5qZWN0ZWQgYnkgdGhlIHJ1bnRpbWUsIG5vdCBhIHVzZXIgdHdlYWsuXG4gKiBMaXN0cyBkaXNjb3ZlcmVkIHR3ZWFrcyB3aXRoIGVuYWJsZSB0b2dnbGVzLCBvcGVucyB0aGUgdHdlYWtzIGRpciwgbGlua3NcbiAqIHRvIGxvZ3MgYW5kIGNvbmZpZy4gTGl2ZXMgaW4gdGhlIHJlbmRlcmVyLlxuICpcbiAqIFRoaXMgaXMgaW52b2tlZCBmcm9tIHByZWxvYWQvaW5kZXgudHMgQUZURVIgdXNlciB0d2Vha3MgYXJlIGxvYWRlZCBzbyBpdFxuICogY2FuIHNob3cgdXAtdG8tZGF0ZSBzdGF0dXMuXG4gKi9cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgeyByZWdpc3RlclNlY3Rpb24gfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbW91bnRNYW5hZ2VyKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0d2Vha3MgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpsaXN0LXR3ZWFrc1wiKSkgYXMgQXJyYXk8e1xuICAgIG1hbmlmZXN0OiB7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBkZXNjcmlwdGlvbj86IHN0cmluZyB9O1xuICAgIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICB9PjtcbiAgY29uc3QgcGF0aHMgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp1c2VyLXBhdGhzXCIpKSBhcyB7XG4gICAgdXNlclJvb3Q6IHN0cmluZztcbiAgICB0d2Vha3NEaXI6IHN0cmluZztcbiAgICBsb2dEaXI6IHN0cmluZztcbiAgfTtcblxuICByZWdpc3RlclNlY3Rpb24oe1xuICAgIGlkOiBcImNvZGV4LXBsdXNwbHVzOm1hbmFnZXJcIixcbiAgICB0aXRsZTogXCJUd2VhayBNYW5hZ2VyXCIsXG4gICAgZGVzY3JpcHRpb246IGAke3R3ZWFrcy5sZW5ndGh9IHR3ZWFrKHMpIGluc3RhbGxlZC4gVXNlciBkaXI6ICR7cGF0aHMudXNlclJvb3R9YCxcbiAgICByZW5kZXIocm9vdCkge1xuICAgICAgcm9vdC5zdHlsZS5jc3NUZXh0ID0gXCJkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo4cHg7XCI7XG5cbiAgICAgIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYWN0aW9ucy5zdHlsZS5jc3NUZXh0ID0gXCJkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDtcIjtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICAgIGJ1dHRvbihcIk9wZW4gdHdlYWtzIGZvbGRlclwiLCAoKSA9PlxuICAgICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6cmV2ZWFsXCIsIHBhdGhzLnR3ZWFrc0RpcikuY2F0Y2goKCkgPT4ge30pLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICAgIGJ1dHRvbihcIk9wZW4gbG9nc1wiLCAoKSA9PlxuICAgICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6cmV2ZWFsXCIsIHBhdGhzLmxvZ0RpcikuY2F0Y2goKCkgPT4ge30pLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICAgIGJ1dHRvbihcIlJlbG9hZCB3aW5kb3dcIiwgKCkgPT4gbG9jYXRpb24ucmVsb2FkKCkpLFxuICAgICAgKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG5cbiAgICAgIGlmICh0d2Vha3MubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInBcIik7XG4gICAgICAgIGVtcHR5LnN0eWxlLmNzc1RleHQgPSBcImNvbG9yOiM4ODg7Zm9udDoxM3B4IHN5c3RlbS11aTttYXJnaW46OHB4IDA7XCI7XG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID1cbiAgICAgICAgICBcIk5vIHVzZXIgdHdlYWtzIHlldC4gRHJvcCBhIGZvbGRlciB3aXRoIG1hbmlmZXN0Lmpzb24gKyBpbmRleC5qcyBpbnRvIHRoZSB0d2Vha3MgZGlyLCB0aGVuIHJlbG9hZC5cIjtcbiAgICAgICAgcm9vdC5hcHBlbmRDaGlsZChlbXB0eSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbGlzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJ1bFwiKTtcbiAgICAgIGxpc3Quc3R5bGUuY3NzVGV4dCA9IFwibGlzdC1zdHlsZTpub25lO21hcmdpbjowO3BhZGRpbmc6MDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo2cHg7XCI7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgdHdlYWtzKSB7XG4gICAgICAgIGNvbnN0IGxpID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxpXCIpO1xuICAgICAgICBsaS5zdHlsZS5jc3NUZXh0ID1cbiAgICAgICAgICBcImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47cGFkZGluZzo4cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMmEyYTJhKTtib3JkZXItcmFkaXVzOjZweDtcIjtcbiAgICAgICAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIGxlZnQuaW5uZXJIVE1MID0gYFxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJmb250OjYwMCAxM3B4IHN5c3RlbS11aTtcIj4ke2VzY2FwZSh0Lm1hbmlmZXN0Lm5hbWUpfSA8c3BhbiBzdHlsZT1cImNvbG9yOiM4ODg7Zm9udC13ZWlnaHQ6NDAwO1wiPnYke2VzY2FwZSh0Lm1hbmlmZXN0LnZlcnNpb24pfTwvc3Bhbj48L2Rpdj5cbiAgICAgICAgICA8ZGl2IHN0eWxlPVwiY29sb3I6Izg4ODtmb250OjEycHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QuZGVzY3JpcHRpb24gPz8gdC5tYW5pZmVzdC5pZCl9PC9kaXY+XG4gICAgICAgIGA7XG4gICAgICAgIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgcmlnaHQuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEycHggc3lzdGVtLXVpO1wiO1xuICAgICAgICByaWdodC50ZXh0Q29udGVudCA9IHQuZW50cnlFeGlzdHMgPyBcImxvYWRlZFwiIDogXCJtaXNzaW5nIGVudHJ5XCI7XG4gICAgICAgIGxpLmFwcGVuZChsZWZ0LCByaWdodCk7XG4gICAgICAgIGxpc3QuYXBwZW5kKGxpKTtcbiAgICAgIH1cbiAgICAgIHJvb3QuYXBwZW5kKGxpc3QpO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBidXR0b24obGFiZWw6IHN0cmluZywgb25jbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGIudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgYi5zdHlsZS5jc3NUZXh0ID1cbiAgICBcInBhZGRpbmc6NnB4IDEwcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIsIzMzMyk7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjppbmhlcml0O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7Y3Vyc29yOnBvaW50ZXI7XCI7XG4gIGIuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uY2xpY2spO1xuICByZXR1cm4gYjtcbn1cblxuZnVuY3Rpb24gZXNjYXBlKHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzLnJlcGxhY2UoL1smPD5cIiddL2csIChjKSA9PlxuICAgIGMgPT09IFwiJlwiXG4gICAgICA/IFwiJmFtcDtcIlxuICAgICAgOiBjID09PSBcIjxcIlxuICAgICAgICA/IFwiJmx0O1wiXG4gICAgICAgIDogYyA9PT0gXCI+XCJcbiAgICAgICAgICA/IFwiJmd0O1wiXG4gICAgICAgICAgOiBjID09PSAnXCInXG4gICAgICAgICAgICA/IFwiJnF1b3Q7XCJcbiAgICAgICAgICAgIDogXCImIzM5O1wiLFxuICApO1xufVxuIiwgImltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5cbmNvbnN0IENPREVYX01FU1NBR0VfRlJPTV9WSUVXID0gXCJjb2RleF9kZXNrdG9wOm1lc3NhZ2UtZnJvbS12aWV3XCI7XG5jb25zdCBDT0RFWF9NRVNTQUdFX0ZPUl9WSUVXID0gXCJjb2RleF9kZXNrdG9wOm1lc3NhZ2UtZm9yLXZpZXdcIjtcbmNvbnN0IERFRkFVTFRfUkVRVUVTVF9USU1FT1VUX01TID0gMTJfMDAwO1xuXG5kZWNsYXJlIGdsb2JhbCB7XG4gIGludGVyZmFjZSBXaW5kb3cge1xuICAgIGVsZWN0cm9uQnJpZGdlPzoge1xuICAgICAgc2VuZE1lc3NhZ2VGcm9tVmlldz8obWVzc2FnZTogdW5rbm93bik6IFByb21pc2U8dm9pZD47XG4gICAgfTtcbiAgfVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFNlcnZlclJlcXVlc3RPcHRpb25zIHtcbiAgaG9zdElkPzogc3RyaW5nO1xuICB0aW1lb3V0TXM/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwU2VydmVyTm90aWZpY2F0aW9uIHtcbiAgbWV0aG9kOiBzdHJpbmc7XG4gIHBhcmFtczogdW5rbm93bjtcbn1cblxuaW50ZXJmYWNlIFBlbmRpbmdSZXF1ZXN0IHtcbiAgaWQ6IHN0cmluZztcbiAgcmVzb2x2ZSh2YWx1ZTogdW5rbm93bik6IHZvaWQ7XG4gIHJlamVjdChlcnJvcjogRXJyb3IpOiB2b2lkO1xuICB0aW1lb3V0OiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0Pjtcbn1cblxubGV0IG5leHRSZXF1ZXN0SWQgPSAxO1xuY29uc3QgcGVuZGluZ1JlcXVlc3RzID0gbmV3IE1hcDxzdHJpbmcsIFBlbmRpbmdSZXF1ZXN0PigpO1xuY29uc3Qgbm90aWZpY2F0aW9uTGlzdGVuZXJzID0gbmV3IFNldDwobm90aWZpY2F0aW9uOiBBcHBTZXJ2ZXJOb3RpZmljYXRpb24pID0+IHZvaWQ+KCk7XG5sZXQgc3Vic2NyaWJlZCA9IGZhbHNlO1xuXG5leHBvcnQgZnVuY3Rpb24gcmVxdWVzdEFwcFNlcnZlcjxUPihcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhcmFtczogdW5rbm93bixcbiAgb3B0aW9uczogQXBwU2VydmVyUmVxdWVzdE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8VD4ge1xuICBlbnN1cmVTdWJzY3JpYmVkKCk7XG4gIGNvbnN0IGlkID0gYGNvZGV4cHAtJHtEYXRlLm5vdygpfS0ke25leHRSZXF1ZXN0SWQrK31gO1xuICBjb25zdCBob3N0SWQgPSBvcHRpb25zLmhvc3RJZCA/PyByZWFkSG9zdElkKCk7XG4gIGNvbnN0IHRpbWVvdXRNcyA9IG9wdGlvbnMudGltZW91dE1zID8/IERFRkFVTFRfUkVRVUVTVF9USU1FT1VUX01TO1xuXG4gIHJldHVybiBuZXcgUHJvbWlzZTxUPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgcGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShpZCk7XG4gICAgICByZWplY3QobmV3IEVycm9yKGBUaW1lZCBvdXQgd2FpdGluZyBmb3IgYXBwLXNlcnZlciByZXNwb25zZSB0byAke21ldGhvZH1gKSk7XG4gICAgfSwgdGltZW91dE1zKTtcblxuICAgIHBlbmRpbmdSZXF1ZXN0cy5zZXQoaWQsIHtcbiAgICAgIGlkLFxuICAgICAgcmVzb2x2ZTogKHZhbHVlKSA9PiByZXNvbHZlKHZhbHVlIGFzIFQpLFxuICAgICAgcmVqZWN0LFxuICAgICAgdGltZW91dCxcbiAgICB9KTtcblxuICAgIGNvbnN0IG1lc3NhZ2UgPSB7XG4gICAgICB0eXBlOiBcIm1jcC1yZXF1ZXN0XCIsXG4gICAgICBob3N0SWQsXG4gICAgICByZXF1ZXN0OiB7IGlkLCBtZXRob2QsIHBhcmFtcyB9LFxuICAgIH07XG5cbiAgICBzZW5kTWVzc2FnZUZyb21WaWV3KG1lc3NhZ2UpLnRoZW4oKHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAocmVzcG9uc2UgIT09IHVuZGVmaW5lZCkgaGFuZGxlSW5jb21pbmdNZXNzYWdlKHJlc3BvbnNlKTtcbiAgICB9KS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgIGNvbnN0IHBlbmRpbmcgPSBwZW5kaW5nUmVxdWVzdHMuZ2V0KGlkKTtcbiAgICAgIGlmICghcGVuZGluZykgcmV0dXJuO1xuICAgICAgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZW91dCk7XG4gICAgICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgICAgIHBlbmRpbmcucmVqZWN0KHRvRXJyb3IoZXJyb3IpKTtcbiAgICB9KTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvbkFwcFNlcnZlck5vdGlmaWNhdGlvbihcbiAgbGlzdGVuZXI6IChub3RpZmljYXRpb246IEFwcFNlcnZlck5vdGlmaWNhdGlvbikgPT4gdm9pZCxcbik6ICgpID0+IHZvaWQge1xuICBlbnN1cmVTdWJzY3JpYmVkKCk7XG4gIG5vdGlmaWNhdGlvbkxpc3RlbmVycy5hZGQobGlzdGVuZXIpO1xuICByZXR1cm4gKCkgPT4gbm90aWZpY2F0aW9uTGlzdGVuZXJzLmRlbGV0ZShsaXN0ZW5lcik7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWFkSG9zdElkKCk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcbiAgICBjb25zdCBob3N0SWQgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImhvc3RJZFwiKT8udHJpbSgpO1xuICAgIHJldHVybiBob3N0SWQgfHwgXCJsb2NhbFwiO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gXCJsb2NhbFwiO1xuICB9XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVN1YnNjcmliZWQoKTogdm9pZCB7XG4gIGlmIChzdWJzY3JpYmVkKSByZXR1cm47XG4gIHN1YnNjcmliZWQgPSB0cnVlO1xuICBpcGNSZW5kZXJlci5vbihDT0RFWF9NRVNTQUdFX0ZPUl9WSUVXLCAoX2V2ZW50LCBtZXNzYWdlKSA9PiB7XG4gICAgaGFuZGxlSW5jb21pbmdNZXNzYWdlKG1lc3NhZ2UpO1xuICB9KTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIChldmVudCkgPT4ge1xuICAgIGhhbmRsZUluY29taW5nTWVzc2FnZShldmVudC5kYXRhKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUluY29taW5nTWVzc2FnZShtZXNzYWdlOiB1bmtub3duKTogdm9pZCB7XG4gIGNvbnN0IG5vdGlmaWNhdGlvbiA9IGV4dHJhY3ROb3RpZmljYXRpb24obWVzc2FnZSk7XG4gIGlmIChub3RpZmljYXRpb24pIHtcbiAgICBmb3IgKGNvbnN0IGxpc3RlbmVyIG9mIG5vdGlmaWNhdGlvbkxpc3RlbmVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgbGlzdGVuZXIobm90aWZpY2F0aW9uKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBpc29sYXRlIGxpc3RlbmVyIGZhaWx1cmVzICovXG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBleHRyYWN0UmVzcG9uc2UobWVzc2FnZSk7XG4gIGlmICghcmVzcG9uc2UpIHJldHVybjtcbiAgY29uc3QgcGVuZGluZyA9IHBlbmRpbmdSZXF1ZXN0cy5nZXQocmVzcG9uc2UuaWQpO1xuICBpZiAoIXBlbmRpbmcpIHJldHVybjtcblxuICBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lb3V0KTtcbiAgcGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShyZXNwb25zZS5pZCk7XG4gIGlmIChyZXNwb25zZS5lcnJvcikge1xuICAgIHBlbmRpbmcucmVqZWN0KHJlc3BvbnNlLmVycm9yKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcGVuZGluZy5yZXNvbHZlKHJlc3BvbnNlLnJlc3VsdCk7XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RSZXNwb25zZShtZXNzYWdlOiB1bmtub3duKTogeyBpZDogc3RyaW5nOyByZXN1bHQ/OiB1bmtub3duOyBlcnJvcj86IEVycm9yIH0gfCBudWxsIHtcbiAgaWYgKCFpc1JlY29yZChtZXNzYWdlKSkgcmV0dXJuIG51bGw7XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3AtcmVzcG9uc2VcIiAmJiBpc1JlY29yZChtZXNzYWdlLnJlc3BvbnNlKSkge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlLnJlc3BvbnNlKTtcbiAgfVxuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwibWNwLXJlc3BvbnNlXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5tZXNzYWdlKSkge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlLm1lc3NhZ2UpO1xuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3AtZXJyb3JcIiAmJiB0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiB7IGlkOiBtZXNzYWdlLmlkLCBlcnJvcjogbmV3IEVycm9yKHJlYWRFcnJvck1lc3NhZ2UobWVzc2FnZS5lcnJvcikgPz8gXCJBcHAtc2VydmVyIHJlcXVlc3QgZmFpbGVkXCIpIH07XG4gIH1cblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcInJlc3BvbnNlXCIgJiYgdHlwZW9mIG1lc3NhZ2UuaWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4gcmVzcG9uc2VGcm9tRW52ZWxvcGUobWVzc2FnZSk7XG4gIH1cblxuICBpZiAodHlwZW9mIG1lc3NhZ2UuaWQgPT09IFwic3RyaW5nXCIgJiYgKFwicmVzdWx0XCIgaW4gbWVzc2FnZSB8fCBcImVycm9yXCIgaW4gbWVzc2FnZSkpIHtcbiAgICByZXR1cm4gcmVzcG9uc2VGcm9tRW52ZWxvcGUobWVzc2FnZSk7XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gcmVzcG9uc2VGcm9tRW52ZWxvcGUoZW52ZWxvcGU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogeyBpZDogc3RyaW5nOyByZXN1bHQ/OiB1bmtub3duOyBlcnJvcj86IEVycm9yIH0gfCBudWxsIHtcbiAgY29uc3QgaWQgPSB0eXBlb2YgZW52ZWxvcGUuaWQgPT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIGVudmVsb3BlLmlkID09PSBcIm51bWJlclwiXG4gICAgPyBTdHJpbmcoZW52ZWxvcGUuaWQpXG4gICAgOiBudWxsO1xuICBpZiAoIWlkKSByZXR1cm4gbnVsbDtcblxuICBpZiAoXCJlcnJvclwiIGluIGVudmVsb3BlKSB7XG4gICAgcmV0dXJuIHsgaWQsIGVycm9yOiBuZXcgRXJyb3IocmVhZEVycm9yTWVzc2FnZShlbnZlbG9wZS5lcnJvcikgPz8gXCJBcHAtc2VydmVyIHJlcXVlc3QgZmFpbGVkXCIpIH07XG4gIH1cblxuICByZXR1cm4geyBpZCwgcmVzdWx0OiBlbnZlbG9wZS5yZXN1bHQgfTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdE5vdGlmaWNhdGlvbihtZXNzYWdlOiB1bmtub3duKTogQXBwU2VydmVyTm90aWZpY2F0aW9uIHwgbnVsbCB7XG4gIGlmICghaXNSZWNvcmQobWVzc2FnZSkpIHJldHVybiBudWxsO1xuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwibWNwLW5vdGlmaWNhdGlvblwiICYmIGlzUmVjb3JkKG1lc3NhZ2UucmVxdWVzdCkpIHtcbiAgICBjb25zdCBtZXRob2QgPSBtZXNzYWdlLnJlcXVlc3QubWV0aG9kO1xuICAgIGlmICh0eXBlb2YgbWV0aG9kID09PSBcInN0cmluZ1wiKSB7XG4gICAgICByZXR1cm4geyBtZXRob2QsIHBhcmFtczogbWVzc2FnZS5yZXF1ZXN0LnBhcmFtcyB9O1xuICAgIH1cbiAgfVxuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwibWNwLW5vdGlmaWNhdGlvblwiICYmIGlzUmVjb3JkKG1lc3NhZ2UubWVzc2FnZSkpIHtcbiAgICBjb25zdCBtZXRob2QgPSBtZXNzYWdlLm1lc3NhZ2UubWV0aG9kO1xuICAgIGlmICh0eXBlb2YgbWV0aG9kID09PSBcInN0cmluZ1wiKSB7XG4gICAgICByZXR1cm4geyBtZXRob2QsIHBhcmFtczogbWVzc2FnZS5tZXNzYWdlLnBhcmFtcyB9O1xuICAgIH1cbiAgfVxuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwibWNwLW5vdGlmaWNhdGlvblwiICYmIHR5cGVvZiBtZXNzYWdlLm1ldGhvZCA9PT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiB7IG1ldGhvZDogbWVzc2FnZS5tZXRob2QsIHBhcmFtczogbWVzc2FnZS5wYXJhbXMgfTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgbWVzc2FnZS5tZXRob2QgPT09IFwic3RyaW5nXCIgJiYgIShcImlkXCIgaW4gbWVzc2FnZSkpIHtcbiAgICByZXR1cm4geyBtZXRob2Q6IG1lc3NhZ2UubWV0aG9kLCBwYXJhbXM6IG1lc3NhZ2UucGFyYW1zIH07XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gcmVhZEVycm9yTWVzc2FnZShlcnJvcjogdW5rbm93bik6IHN0cmluZyB8IG51bGwge1xuICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIGVycm9yLm1lc3NhZ2U7XG4gIGlmICh0eXBlb2YgZXJyb3IgPT09IFwic3RyaW5nXCIpIHJldHVybiBlcnJvcjtcbiAgaWYgKGlzUmVjb3JkKGVycm9yKSkge1xuICAgIGlmICh0eXBlb2YgZXJyb3IubWVzc2FnZSA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGVycm9yLm1lc3NhZ2U7XG4gICAgaWYgKHR5cGVvZiBlcnJvci5lcnJvciA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGVycm9yLmVycm9yO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBzZW5kTWVzc2FnZUZyb21WaWV3KG1lc3NhZ2U6IHVua25vd24pOiBQcm9taXNlPHVua25vd24+IHtcbiAgY29uc3QgYnJpZGdlU2VuZGVyID0gd2luZG93LmVsZWN0cm9uQnJpZGdlPy5zZW5kTWVzc2FnZUZyb21WaWV3O1xuICBpZiAodHlwZW9mIGJyaWRnZVNlbmRlciA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgcmV0dXJuIGJyaWRnZVNlbmRlci5jYWxsKHdpbmRvdy5lbGVjdHJvbkJyaWRnZSwgbWVzc2FnZSkudGhlbigoKSA9PiB1bmRlZmluZWQpO1xuICB9XG4gIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoQ09ERVhfTUVTU0FHRV9GUk9NX1ZJRVcsIG1lc3NhZ2UpO1xufVxuXG5mdW5jdGlvbiB0b0Vycm9yKGVycm9yOiB1bmtub3duKTogRXJyb3Ige1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yIDogbmV3IEVycm9yKFN0cmluZyhlcnJvcikpO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG4iLCAiaW1wb3J0IHsgb25BcHBTZXJ2ZXJOb3RpZmljYXRpb24sIHJlYWRIb3N0SWQsIHJlcXVlc3RBcHBTZXJ2ZXIgfSBmcm9tIFwiLi9hcHAtc2VydmVyLWJyaWRnZVwiO1xuXG50eXBlIEdvYWxTdGF0dXMgPSBcImFjdGl2ZVwiIHwgXCJwYXVzZWRcIiB8IFwiYnVkZ2V0TGltaXRlZFwiIHwgXCJjb21wbGV0ZVwiO1xuXG5pbnRlcmZhY2UgVGhyZWFkR29hbCB7XG4gIHRocmVhZElkOiBzdHJpbmc7XG4gIG9iamVjdGl2ZTogc3RyaW5nO1xuICBzdGF0dXM6IEdvYWxTdGF0dXM7XG4gIHRva2VuQnVkZ2V0OiBudW1iZXIgfCBudWxsO1xuICB0b2tlbnNVc2VkOiBudW1iZXI7XG4gIHRpbWVVc2VkU2Vjb25kczogbnVtYmVyO1xuICBjcmVhdGVkQXQ6IG51bWJlcjtcbiAgdXBkYXRlZEF0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBHb2FsVWlBY3Rpb24ge1xuICBsYWJlbDogc3RyaW5nO1xuICBraW5kPzogXCJwcmltYXJ5XCIgfCBcImRhbmdlclwiO1xuICBydW4oKTogdm9pZCB8IFByb21pc2U8dm9pZD47XG59XG5cbmludGVyZmFjZSBHb2FsUGFuZWxPcHRpb25zIHtcbiAgdGl0bGU6IHN0cmluZztcbiAgZGV0YWlsOiBzdHJpbmc7XG4gIGZvb3Rlcj86IHN0cmluZztcbiAgYWN0aW9uczogR29hbFVpQWN0aW9uW107XG4gIHBlcnNpc3RlbnQ6IGJvb2xlYW47XG4gIGVycm9yPzogYm9vbGVhbjtcbn1cblxuaW50ZXJmYWNlIEdvYWxQYW5lbFN0YXRlIHtcbiAgY29sbGFwc2VkOiBib29sZWFuO1xuICB4OiBudW1iZXIgfCBudWxsO1xuICB5OiBudW1iZXIgfCBudWxsO1xuICB3aWR0aDogbnVtYmVyIHwgbnVsbDtcbiAgaGVpZ2h0OiBudW1iZXIgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgR29hbFBhbmVsRHJhZyB7XG4gIHBvaW50ZXJJZDogbnVtYmVyO1xuICBvZmZzZXRYOiBudW1iZXI7XG4gIG9mZnNldFk6IG51bWJlcjtcbiAgd2lkdGg6IG51bWJlcjtcbiAgaGVpZ2h0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBHb2FsUGFuZWxSZXNpemUge1xuICBwb2ludGVySWQ6IG51bWJlcjtcbiAgc3RhcnRYOiBudW1iZXI7XG4gIHN0YXJ0WTogbnVtYmVyO1xuICB3aWR0aDogbnVtYmVyO1xuICBoZWlnaHQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEVkaXRhYmxlVGFyZ2V0IHtcbiAgZWxlbWVudDogSFRNTEVsZW1lbnQ7XG4gIGdldFRleHQoKTogc3RyaW5nO1xuICBzZXRUZXh0KHZhbHVlOiBzdHJpbmcpOiB2b2lkO1xuICBjbGVhcigpOiB2b2lkO1xufVxuXG5sZXQgc3RhcnRlZCA9IGZhbHNlO1xubGV0IHJvb3Q6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgc3VnZ2VzdGlvblJvb3Q6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgY3VycmVudEdvYWw6IFRocmVhZEdvYWwgfCBudWxsID0gbnVsbDtcbmxldCBoaWRlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5sZXQgbGFzdFRocmVhZElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbmxldCBsYXN0UGFuZWxPcHRpb25zOiBHb2FsUGFuZWxPcHRpb25zIHwgbnVsbCA9IG51bGw7XG5sZXQgcGFuZWxEcmFnOiBHb2FsUGFuZWxEcmFnIHwgbnVsbCA9IG51bGw7XG5sZXQgcGFuZWxSZXNpemU6IEdvYWxQYW5lbFJlc2l6ZSB8IG51bGwgPSBudWxsO1xuXG5jb25zdCBHT0FMX1BBTkVMX1NUQVRFX0tFWSA9IFwiY29kZXhwcDpnb2FsLXBhbmVsLXN0YXRlXCI7XG5jb25zdCBHT0FMX1BBTkVMX01JTl9XSURUSCA9IDI4MDtcbmNvbnN0IEdPQUxfUEFORUxfTUlOX0hFSUdIVCA9IDE2MDtcbmNvbnN0IEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOID0gODtcbmxldCBwYW5lbFN0YXRlOiBHb2FsUGFuZWxTdGF0ZSA9IHJlYWRHb2FsUGFuZWxTdGF0ZSgpO1xuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRHb2FsRmVhdHVyZShsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQgPSAoKSA9PiB7fSk6IHZvaWQge1xuICBpZiAoc3RhcnRlZCkgcmV0dXJuO1xuICBzdGFydGVkID0gdHJ1ZTtcbiAgaW5zdGFsbFN0eWxlcygpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZXZlbnQpID0+IHtcbiAgICB2b2lkIGhhbmRsZUtleWRvd24oZXZlbnQsIGxvZyk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKGV2ZW50KSA9PiB7XG4gICAgdXBkYXRlR29hbFN1Z2dlc3Rpb24oZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50KSk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNpblwiLCAoZXZlbnQpID0+IHtcbiAgICB1cGRhdGVHb2FsU3VnZ2VzdGlvbihmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpKTtcbiAgfSwgdHJ1ZSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICBpZiAoc3VnZ2VzdGlvblJvb3Q/LmNvbnRhaW5zKGV2ZW50LnRhcmdldCBhcyBOb2RlKSkgcmV0dXJuO1xuICAgIHVwZGF0ZUdvYWxTdWdnZXN0aW9uKGZpbmRFZGl0YWJsZVRhcmdldChldmVudCkpO1xuICB9LCB0cnVlKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJyZXNpemVcIiwgKCkgPT4ge1xuICAgIGlmICghcm9vdD8uaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICBhcHBseUdvYWxQYW5lbFNpemUocm9vdCk7XG4gICAgY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KHJvb3QpO1xuICAgIGFwcGx5R29hbFBhbmVsUG9zaXRpb24ocm9vdCk7XG4gIH0pO1xuICBvbkFwcFNlcnZlck5vdGlmaWNhdGlvbigobm90aWZpY2F0aW9uKSA9PiB7XG4gICAgaWYgKG5vdGlmaWNhdGlvbi5tZXRob2QgPT09IFwidGhyZWFkL2dvYWwvdXBkYXRlZFwiICYmIGlzUmVjb3JkKG5vdGlmaWNhdGlvbi5wYXJhbXMpKSB7XG4gICAgICBjb25zdCBnb2FsID0gbm90aWZpY2F0aW9uLnBhcmFtcy5nb2FsO1xuICAgICAgaWYgKGlzVGhyZWFkR29hbChnb2FsKSkge1xuICAgICAgICBpZiAoZ29hbC50aHJlYWRJZCAhPT0gcmVhZFRocmVhZElkKCkpIHJldHVybjtcbiAgICAgICAgY3VycmVudEdvYWwgPSBnb2FsO1xuICAgICAgICByZW5kZXJHb2FsKGdvYWwsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG5vdGlmaWNhdGlvbi5tZXRob2QgPT09IFwidGhyZWFkL2dvYWwvY2xlYXJlZFwiICYmIGlzUmVjb3JkKG5vdGlmaWNhdGlvbi5wYXJhbXMpKSB7XG4gICAgICBjb25zdCB0aHJlYWRJZCA9IG5vdGlmaWNhdGlvbi5wYXJhbXMudGhyZWFkSWQ7XG4gICAgICBpZiAodHlwZW9mIHRocmVhZElkID09PSBcInN0cmluZ1wiICYmIHRocmVhZElkID09PSByZWFkVGhyZWFkSWQoKSkge1xuICAgICAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgICAgIHJlbmRlck5vdGljZShcIkdvYWwgY2xlYXJlZFwiLCBcIlRoaXMgdGhyZWFkIG5vIGxvbmdlciBoYXMgYW4gYWN0aXZlIGdvYWwuXCIpO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCAoKSA9PiByZWZyZXNoR29hbEZvclJvdXRlKGxvZykpO1xuICBjb25zdCByZWZyZXNoVGltZXIgPSBzZXRJbnRlcnZhbCgoKSA9PiByZWZyZXNoR29hbEZvclJvdXRlKGxvZyksIDJfNTAwKTtcbiAgY29uc3QgdW5yZWYgPSAocmVmcmVzaFRpbWVyIGFzIHVua25vd24gYXMgeyB1bnJlZj86ICgpID0+IHZvaWQgfSkudW5yZWY7XG4gIGlmICh0eXBlb2YgdW5yZWYgPT09IFwiZnVuY3Rpb25cIikgdW5yZWYuY2FsbChyZWZyZXNoVGltZXIpO1xuICBxdWV1ZU1pY3JvdGFzaygoKSA9PiByZWZyZXNoR29hbEZvclJvdXRlKGxvZykpO1xuICBsb2coXCJnb2FsIGZlYXR1cmUgc3RhcnRlZFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gaGFuZGxlS2V5ZG93bihldmVudDogS2V5Ym9hcmRFdmVudCwgbG9nOiAoc3RhZ2U6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChldmVudC5pc0NvbXBvc2luZykgcmV0dXJuO1xuXG4gIGNvbnN0IGVkaXRhYmxlID0gZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50KTtcbiAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuO1xuXG4gIGlmIChldmVudC5rZXkgPT09IFwiRXNjYXBlXCIpIHtcbiAgICBoaWRlR29hbFN1Z2dlc3Rpb24oKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoKGV2ZW50LmtleSA9PT0gXCJUYWJcIiB8fCBldmVudC5rZXkgPT09IFwiRW50ZXJcIikgJiYgIWV2ZW50LnNoaWZ0S2V5ICYmICFldmVudC5hbHRLZXkgJiYgIWV2ZW50LmN0cmxLZXkgJiYgIWV2ZW50Lm1ldGFLZXkpIHtcbiAgICBjb25zdCBzdWdnZXN0aW9uID0gcGFyc2VHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZS5nZXRUZXh0KCkpO1xuICAgIGlmIChzdWdnZXN0aW9uICYmIGVkaXRhYmxlLmdldFRleHQoKS50cmltKCkgIT09IFwiL2dvYWxcIikge1xuICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgZXZlbnQuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XG4gICAgICBhcHBseUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBpZiAoZXZlbnQua2V5ICE9PSBcIkVudGVyXCIgfHwgZXZlbnQuc2hpZnRLZXkgfHwgZXZlbnQuYWx0S2V5IHx8IGV2ZW50LmN0cmxLZXkgfHwgZXZlbnQubWV0YUtleSkgcmV0dXJuO1xuXG4gIGNvbnN0IHBhcnNlZCA9IHBhcnNlR29hbENvbW1hbmQoZWRpdGFibGUuZ2V0VGV4dCgpKTtcbiAgaWYgKCFwYXJzZWQpIHJldHVybjtcblxuICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgZXZlbnQuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XG4gIGVkaXRhYmxlLmNsZWFyKCk7XG4gIGhpZGVHb2FsU3VnZ2VzdGlvbigpO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgcnVuR29hbENvbW1hbmQocGFyc2VkLmFyZ3MsIGxvZyk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgbG9nKFwiZ29hbCBjb21tYW5kIGZhaWxlZFwiLCBzdHJpbmdpZnlFcnJvcihlcnJvcikpO1xuICAgIHJlbmRlckVycm9yKFwiR29hbCBjb21tYW5kIGZhaWxlZFwiLCBmcmllbmRseUdvYWxFcnJvcihlcnJvcikpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBhcnNlR29hbENvbW1hbmQodGV4dDogc3RyaW5nKTogeyBhcmdzOiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IHRleHQudHJpbSgpLm1hdGNoKC9eXFwvZ29hbCg/OlxccysoW1xcc1xcU10qKSk/JC8pO1xuICBpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgYXJnczogKG1hdGNoWzFdID8/IFwiXCIpLnRyaW0oKSB9O1xufVxuXG5mdW5jdGlvbiBwYXJzZUdvYWxTdWdnZXN0aW9uKHRleHQ6IHN0cmluZyk6IHsgcXVlcnk6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gdGV4dC50cmltKCkubWF0Y2goL15cXC8oW2Etel0qKSQvaSk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICBjb25zdCBxdWVyeSA9IG1hdGNoWzFdPy50b0xvd2VyQ2FzZSgpID8/IFwiXCI7XG4gIHJldHVybiBcImdvYWxcIi5zdGFydHNXaXRoKHF1ZXJ5KSA/IHsgcXVlcnkgfSA6IG51bGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkdvYWxDb21tYW5kKGFyZ3M6IHN0cmluZywgbG9nOiAoc3RhZ2U6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCk7XG4gIGlmICghdGhyZWFkSWQpIHtcbiAgICByZW5kZXJFcnJvcihcIk5vIGFjdGl2ZSB0aHJlYWRcIiwgXCJPcGVuIGEgbG9jYWwgdGhyZWFkIGJlZm9yZSB1c2luZyAvZ29hbC5cIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGhvc3RJZCA9IHJlYWRIb3N0SWQoKTtcbiAgY29uc3QgbG93ZXIgPSBhcmdzLnRvTG93ZXJDYXNlKCk7XG5cbiAgaWYgKCFhcmdzKSB7XG4gICAgY29uc3QgZ29hbCA9IGF3YWl0IGdldEdvYWwodGhyZWFkSWQsIGhvc3RJZCk7XG4gICAgY3VycmVudEdvYWwgPSBnb2FsO1xuICAgIGlmIChnb2FsKSB7XG4gICAgICByZW5kZXJHb2FsKGdvYWwsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVuZGVyTm90aWNlKFwiTm8gZ29hbCBzZXRcIiwgXCJVc2UgL2dvYWwgPG9iamVjdGl2ZT4gdG8gc2V0IG9uZSBmb3IgdGhpcyB0aHJlYWQuXCIpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAobG93ZXIgPT09IFwiY2xlYXJcIikge1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGNsZWFyZWQ6IGJvb2xlYW4gfT4oXG4gICAgICBcInRocmVhZC9nb2FsL2NsZWFyXCIsXG4gICAgICB7IHRocmVhZElkIH0sXG4gICAgICB7IGhvc3RJZCB9LFxuICAgICk7XG4gICAgY3VycmVudEdvYWwgPSBudWxsO1xuICAgIHJlbmRlck5vdGljZShyZXNwb25zZS5jbGVhcmVkID8gXCJHb2FsIGNsZWFyZWRcIiA6IFwiTm8gZ29hbCBzZXRcIiwgXCJVc2UgL2dvYWwgPG9iamVjdGl2ZT4gdG8gc2V0IGEgbmV3IGdvYWwuXCIpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChsb3dlciA9PT0gXCJwYXVzZVwiIHx8IGxvd2VyID09PSBcInJlc3VtZVwiIHx8IGxvd2VyID09PSBcImNvbXBsZXRlXCIpIHtcbiAgICBjb25zdCBzdGF0dXM6IEdvYWxTdGF0dXMgPSBsb3dlciA9PT0gXCJwYXVzZVwiID8gXCJwYXVzZWRcIiA6IGxvd2VyID09PSBcInJlc3VtZVwiID8gXCJhY3RpdmVcIiA6IFwiY29tcGxldGVcIjtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIH0+KFxuICAgICAgXCJ0aHJlYWQvZ29hbC9zZXRcIixcbiAgICAgIHsgdGhyZWFkSWQsIHN0YXR1cyB9LFxuICAgICAgeyBob3N0SWQgfSxcbiAgICApO1xuICAgIGN1cnJlbnRHb2FsID0gcmVzcG9uc2UuZ29hbDtcbiAgICByZW5kZXJHb2FsKHJlc3BvbnNlLmdvYWwsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGdldEdvYWwodGhyZWFkSWQsIGhvc3RJZCk7XG4gIGlmIChleGlzdGluZyAmJiBleGlzdGluZy5vYmplY3RpdmUgIT09IGFyZ3MpIHtcbiAgICBjb25zdCByZXBsYWNlID0gYXdhaXQgY29uZmlybVJlcGxhY2VHb2FsKGV4aXN0aW5nLCBhcmdzKTtcbiAgICBpZiAoIXJlcGxhY2UpIHtcbiAgICAgIGN1cnJlbnRHb2FsID0gZXhpc3Rpbmc7XG4gICAgICByZW5kZXJHb2FsKGV4aXN0aW5nLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgZ29hbDogVGhyZWFkR29hbCB9PihcbiAgICBcInRocmVhZC9nb2FsL3NldFwiLFxuICAgIHsgdGhyZWFkSWQsIG9iamVjdGl2ZTogYXJncywgc3RhdHVzOiBcImFjdGl2ZVwiIH0sXG4gICAgeyBob3N0SWQgfSxcbiAgKTtcbiAgY3VycmVudEdvYWwgPSByZXNwb25zZS5nb2FsO1xuICBsb2coXCJnb2FsIHNldFwiLCB7IHRocmVhZElkIH0pO1xuICByZW5kZXJHb2FsKHJlc3BvbnNlLmdvYWwsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0R29hbCh0aHJlYWRJZDogc3RyaW5nLCBob3N0SWQ6IHN0cmluZyk6IFByb21pc2U8VGhyZWFkR29hbCB8IG51bGw+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgZ29hbDogVGhyZWFkR29hbCB8IG51bGwgfT4oXG4gICAgXCJ0aHJlYWQvZ29hbC9nZXRcIixcbiAgICB7IHRocmVhZElkIH0sXG4gICAgeyBob3N0SWQgfSxcbiAgKTtcbiAgcmV0dXJuIHJlc3BvbnNlLmdvYWw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlZnJlc2hHb2FsRm9yUm91dGUobG9nOiAoc3RhZ2U6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCk7XG4gIGlmICghdGhyZWFkSWQpIHtcbiAgICBpZiAobGFzdFRocmVhZElkICE9PSBudWxsKSB7XG4gICAgICBsYXN0VGhyZWFkSWQgPSBudWxsO1xuICAgICAgY3VycmVudEdvYWwgPSBudWxsO1xuICAgICAgaGlkZVBhbmVsKCk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuICBpZiAodGhyZWFkSWQgPT09IGxhc3RUaHJlYWRJZCkgcmV0dXJuO1xuICBsYXN0VGhyZWFkSWQgPSB0aHJlYWRJZDtcbiAgdHJ5IHtcbiAgICBjb25zdCBnb2FsID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgcmVhZEhvc3RJZCgpKTtcbiAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgaWYgKGdvYWwpIHtcbiAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBoaWRlUGFuZWwoKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgLy8gT2xkIGFwcC1zZXJ2ZXIgYnVpbGRzIGRvIG5vdCBrbm93IHRocmVhZC9nb2FsLyouIEtlZXAgdGhlIFVJIHF1aWV0IHVudGlsXG4gICAgLy8gdGhlIHVzZXIgZXhwbGljaXRseSB0eXBlcyAvZ29hbCwgdGhlbiBzaG93IHRoZSBhY3Rpb25hYmxlIGVycm9yLlxuICAgIGxvZyhcImdvYWwgcm91dGUgcmVmcmVzaCBza2lwcGVkXCIsIHN0cmluZ2lmeUVycm9yKGVycm9yKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29uZmlybVJlcGxhY2VHb2FsKGV4aXN0aW5nOiBUaHJlYWRHb2FsLCBuZXh0T2JqZWN0aXZlOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgcmVuZGVyUGFuZWwoe1xuICAgICAgdGl0bGU6IFwiUmVwbGFjZSBjdXJyZW50IGdvYWw/XCIsXG4gICAgICBkZXRhaWw6IHRydW5jYXRlKGV4aXN0aW5nLm9iamVjdGl2ZSwgMTgwKSxcbiAgICAgIGZvb3RlcjogYE5ldzogJHt0cnVuY2F0ZShuZXh0T2JqZWN0aXZlLCAxODApfWAsXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBsYWJlbDogXCJSZXBsYWNlXCIsXG4gICAgICAgICAga2luZDogXCJwcmltYXJ5XCIsXG4gICAgICAgICAgcnVuOiAoKSA9PiByZXNvbHZlKHRydWUpLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgbGFiZWw6IFwiQ2FuY2VsXCIsXG4gICAgICAgICAgcnVuOiAoKSA9PiByZXNvbHZlKGZhbHNlKSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBwZXJzaXN0ZW50OiB0cnVlLFxuICAgIH0pO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyR29hbChnb2FsOiBUaHJlYWRHb2FsLCBvcHRpb25zOiB7IHRyYW5zaWVudDogYm9vbGVhbiB9KTogdm9pZCB7XG4gIGNvbnN0IHN0YXR1cyA9IGdvYWxTdGF0dXNMYWJlbChnb2FsLnN0YXR1cyk7XG4gIGNvbnN0IGJ1ZGdldCA9IGdvYWwudG9rZW5CdWRnZXQgPT0gbnVsbFxuICAgID8gYCR7Zm9ybWF0TnVtYmVyKGdvYWwudG9rZW5zVXNlZCl9IHRva2Vuc2BcbiAgICA6IGAke2Zvcm1hdE51bWJlcihnb2FsLnRva2Vuc1VzZWQpfSAvICR7Zm9ybWF0TnVtYmVyKGdvYWwudG9rZW5CdWRnZXQpfSB0b2tlbnNgO1xuICByZW5kZXJQYW5lbCh7XG4gICAgdGl0bGU6IGBHb2FsICR7c3RhdHVzfWAsXG4gICAgZGV0YWlsOiBnb2FsLm9iamVjdGl2ZSxcbiAgICBmb290ZXI6IGAke2J1ZGdldH0gLSAke2Zvcm1hdER1cmF0aW9uKGdvYWwudGltZVVzZWRTZWNvbmRzKX1gLFxuICAgIGFjdGlvbnM6IFtcbiAgICAgIGdvYWwuc3RhdHVzID09PSBcInBhdXNlZFwiXG4gICAgICAgID8geyBsYWJlbDogXCJSZXN1bWVcIiwga2luZDogXCJwcmltYXJ5XCIsIHJ1bjogKCkgPT4gdXBkYXRlR29hbFN0YXR1cyhcImFjdGl2ZVwiKSB9XG4gICAgICAgIDogeyBsYWJlbDogXCJQYXVzZVwiLCBydW46ICgpID0+IHVwZGF0ZUdvYWxTdGF0dXMoXCJwYXVzZWRcIikgfSxcbiAgICAgIHsgbGFiZWw6IFwiQ29tcGxldGVcIiwgcnVuOiAoKSA9PiB1cGRhdGVHb2FsU3RhdHVzKFwiY29tcGxldGVcIikgfSxcbiAgICAgIHsgbGFiZWw6IFwiQ2xlYXJcIiwga2luZDogXCJkYW5nZXJcIiwgcnVuOiAoKSA9PiBjbGVhckN1cnJlbnRHb2FsKCkgfSxcbiAgICBdLFxuICAgIHBlcnNpc3RlbnQ6ICFvcHRpb25zLnRyYW5zaWVudCxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlck5vdGljZSh0aXRsZTogc3RyaW5nLCBkZXRhaWw6IHN0cmluZyk6IHZvaWQge1xuICByZW5kZXJQYW5lbCh7IHRpdGxlLCBkZXRhaWwsIGFjdGlvbnM6IFtdLCBwZXJzaXN0ZW50OiBmYWxzZSB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRXJyb3IodGl0bGU6IHN0cmluZywgZGV0YWlsOiBzdHJpbmcpOiB2b2lkIHtcbiAgcmVuZGVyUGFuZWwoeyB0aXRsZSwgZGV0YWlsLCBhY3Rpb25zOiBbXSwgcGVyc2lzdGVudDogZmFsc2UsIGVycm9yOiB0cnVlIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJQYW5lbChvcHRpb25zOiBHb2FsUGFuZWxPcHRpb25zKTogdm9pZCB7XG4gIGxhc3RQYW5lbE9wdGlvbnMgPSBvcHRpb25zO1xuICBjb25zdCBlbCA9IGVuc3VyZVJvb3QoKTtcbiAgaWYgKGhpZGVUaW1lcikgY2xlYXJUaW1lb3V0KGhpZGVUaW1lcik7XG4gIGVsLmlubmVySFRNTCA9IFwiXCI7XG4gIGVsLmNsYXNzTmFtZSA9IGBjb2RleHBwLWdvYWwtcGFuZWwke29wdGlvbnMuZXJyb3IgPyBcIiBpcy1lcnJvclwiIDogXCJcIn0ke3BhbmVsU3RhdGUuY29sbGFwc2VkID8gXCIgaXMtY29sbGFwc2VkXCIgOiBcIlwifWA7XG4gIGFwcGx5R29hbFBhbmVsU2l6ZShlbCk7XG4gIGFwcGx5R29hbFBhbmVsUG9zaXRpb24oZWwpO1xuXG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1oZWFkZXJcIjtcbiAgaGVhZGVyLmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVyZG93blwiLCBzdGFydEdvYWxQYW5lbERyYWcpO1xuICBoZWFkZXIuYWRkRXZlbnRMaXN0ZW5lcihcImRibGNsaWNrXCIsIHJlc2V0R29hbFBhbmVsUG9zaXRpb24pO1xuXG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtdGl0bGVcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBvcHRpb25zLnRpdGxlO1xuXG4gIGNvbnN0IGNvbnRyb2xzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY29udHJvbHMuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtY29udHJvbHNcIjtcblxuICBjb25zdCBjb2xsYXBzZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGNvbGxhcHNlLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWljb25cIjtcbiAgY29sbGFwc2UudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGNvbGxhcHNlLnRleHRDb250ZW50ID0gcGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIitcIiA6IFwiLVwiO1xuICBjb2xsYXBzZS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIHBhbmVsU3RhdGUuY29sbGFwc2VkID8gXCJFeHBhbmQgZ29hbCBwYW5lbFwiIDogXCJDb2xsYXBzZSBnb2FsIHBhbmVsXCIpO1xuICBjb2xsYXBzZS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIHBhbmVsU3RhdGUgPSB7IC4uLnBhbmVsU3RhdGUsIGNvbGxhcHNlZDogIXBhbmVsU3RhdGUuY29sbGFwc2VkIH07XG4gICAgc2F2ZUdvYWxQYW5lbFN0YXRlKCk7XG4gICAgaWYgKGxhc3RQYW5lbE9wdGlvbnMpIHJlbmRlclBhbmVsKGxhc3RQYW5lbE9wdGlvbnMpO1xuICB9KTtcblxuICBjb25zdCBjbG9zZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGNsb3NlLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWljb25cIjtcbiAgY2xvc2UudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGNsb3NlLnRleHRDb250ZW50ID0gXCJ4XCI7XG4gIGNsb3NlLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJDbG9zZSBnb2FsIHBhbmVsXCIpO1xuICBjbG9zZS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gaGlkZVBhbmVsKCkpO1xuICBjb250cm9scy5hcHBlbmQoY29sbGFwc2UsIGNsb3NlKTtcbiAgaGVhZGVyLmFwcGVuZCh0aXRsZSwgY29udHJvbHMpO1xuICBlbC5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIGlmIChwYW5lbFN0YXRlLmNvbGxhcHNlZCkge1xuICAgIGVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgaWYgKCFvcHRpb25zLnBlcnNpc3RlbnQpIHtcbiAgICAgIGhpZGVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gaGlkZVBhbmVsKCksIDhfMDAwKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgZGV0YWlsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGV0YWlsLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWRldGFpbFwiO1xuICBkZXRhaWwudGV4dENvbnRlbnQgPSBvcHRpb25zLmRldGFpbDtcblxuICBlbC5hcHBlbmRDaGlsZChkZXRhaWwpO1xuXG4gIGlmIChvcHRpb25zLmZvb3Rlcikge1xuICAgIGNvbnN0IGZvb3RlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZm9vdGVyLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWZvb3RlclwiO1xuICAgIGZvb3Rlci50ZXh0Q29udGVudCA9IG9wdGlvbnMuZm9vdGVyO1xuICAgIGVsLmFwcGVuZENoaWxkKGZvb3Rlcik7XG4gIH1cblxuICBpZiAob3B0aW9ucy5hY3Rpb25zLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWFjdGlvbnNcIjtcbiAgICBmb3IgKGNvbnN0IGFjdGlvbiBvZiBvcHRpb25zLmFjdGlvbnMpIHtcbiAgICAgIGNvbnN0IGJ1dHRvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBidXR0b24udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBidXR0b24udGV4dENvbnRlbnQgPSBhY3Rpb24ubGFiZWw7XG4gICAgICBidXR0b24uY2xhc3NOYW1lID0gYGNvZGV4cHAtZ29hbC1hY3Rpb24gJHthY3Rpb24ua2luZCA/PyBcIlwifWA7XG4gICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgICAgUHJvbWlzZS5yZXNvbHZlKGFjdGlvbi5ydW4oKSkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgcmVuZGVyRXJyb3IoXCJHb2FsIGFjdGlvbiBmYWlsZWRcIiwgZnJpZW5kbHlHb2FsRXJyb3IoZXJyb3IpKTtcbiAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoYnV0dG9uKTtcbiAgICB9XG4gICAgZWwuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIH1cblxuICBjb25zdCByZXNpemUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZXNpemUuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtcmVzaXplXCI7XG4gIHJlc2l6ZS50eXBlID0gXCJidXR0b25cIjtcbiAgcmVzaXplLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJSZXNpemUgZ29hbCBwYW5lbFwiKTtcbiAgcmVzaXplLmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVyZG93blwiLCBzdGFydEdvYWxQYW5lbFJlc2l6ZSk7XG4gIHJlc2l6ZS5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBoYW5kbGVHb2FsUGFuZWxSZXNpemVLZXlkb3duKTtcbiAgcmVzaXplLmFkZEV2ZW50TGlzdGVuZXIoXCJkYmxjbGlja1wiLCByZXNldEdvYWxQYW5lbFNpemUpO1xuICBlbC5hcHBlbmRDaGlsZChyZXNpemUpO1xuXG4gIGVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gIGlmICghb3B0aW9ucy5wZXJzaXN0ZW50KSB7XG4gICAgaGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBoaWRlUGFuZWwoKSwgOF8wMDApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZUdvYWxTdGF0dXMoc3RhdHVzOiBHb2FsU3RhdHVzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCkgPz8gY3VycmVudEdvYWw/LnRocmVhZElkO1xuICBpZiAoIXRocmVhZElkKSByZXR1cm47XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgXCJ0aHJlYWQvZ29hbC9zZXRcIixcbiAgICB7IHRocmVhZElkLCBzdGF0dXMgfSxcbiAgICB7IGhvc3RJZDogcmVhZEhvc3RJZCgpIH0sXG4gICk7XG4gIGN1cnJlbnRHb2FsID0gcmVzcG9uc2UuZ29hbDtcbiAgcmVuZGVyR29hbChyZXNwb25zZS5nb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNsZWFyQ3VycmVudEdvYWwoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCkgPz8gY3VycmVudEdvYWw/LnRocmVhZElkO1xuICBpZiAoIXRocmVhZElkKSByZXR1cm47XG4gIGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBjbGVhcmVkOiBib29sZWFuIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvY2xlYXJcIixcbiAgICB7IHRocmVhZElkIH0sXG4gICAgeyBob3N0SWQ6IHJlYWRIb3N0SWQoKSB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IG51bGw7XG4gIHJlbmRlck5vdGljZShcIkdvYWwgY2xlYXJlZFwiLCBcIlRoaXMgdGhyZWFkIG5vIGxvbmdlciBoYXMgYW4gYWN0aXZlIGdvYWwuXCIpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVSb290KCk6IEhUTUxEaXZFbGVtZW50IHtcbiAgaWYgKHJvb3Q/LmlzQ29ubmVjdGVkKSByZXR1cm4gcm9vdDtcbiAgcm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvb3QuaWQgPSBcImNvZGV4cHAtZ29hbC1yb290XCI7XG4gIHJvb3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5ib2R5IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKHBhcmVudCkgcGFyZW50LmFwcGVuZENoaWxkKHJvb3QpO1xuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gaGlkZVBhbmVsKCk6IHZvaWQge1xuICBpZiAoaGlkZVRpbWVyKSB7XG4gICAgY2xlYXJUaW1lb3V0KGhpZGVUaW1lcik7XG4gICAgaGlkZVRpbWVyID0gbnVsbDtcbiAgfVxuICBpZiAocm9vdCkgcm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0R29hbFBhbmVsRHJhZyhldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChldmVudC5idXR0b24gIT09IDApIHJldHVybjtcbiAgaWYgKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgJiYgZXZlbnQudGFyZ2V0LmNsb3Nlc3QoXCJidXR0b25cIikpIHJldHVybjtcbiAgaWYgKCFyb290KSByZXR1cm47XG4gIGNvbnN0IHJlY3QgPSByb290LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBwYW5lbERyYWcgPSB7XG4gICAgcG9pbnRlcklkOiBldmVudC5wb2ludGVySWQsXG4gICAgb2Zmc2V0WDogZXZlbnQuY2xpZW50WCAtIHJlY3QubGVmdCxcbiAgICBvZmZzZXRZOiBldmVudC5jbGllbnRZIC0gcmVjdC50b3AsXG4gICAgd2lkdGg6IHJlY3Qud2lkdGgsXG4gICAgaGVpZ2h0OiByZWN0LmhlaWdodCxcbiAgfTtcbiAgcm9vdC5jbGFzc0xpc3QuYWRkKFwiaXMtZHJhZ2dpbmdcIik7XG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgbW92ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxEcmFnKTtcbn1cblxuZnVuY3Rpb24gbW92ZUdvYWxQYW5lbChldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmICghcGFuZWxEcmFnIHx8IGV2ZW50LnBvaW50ZXJJZCAhPT0gcGFuZWxEcmFnLnBvaW50ZXJJZCB8fCAhcm9vdCkgcmV0dXJuO1xuICBwYW5lbFN0YXRlID0ge1xuICAgIC4uLnBhbmVsU3RhdGUsXG4gICAgeDogY2xhbXAoZXZlbnQuY2xpZW50WCAtIHBhbmVsRHJhZy5vZmZzZXRYLCA4LCB3aW5kb3cuaW5uZXJXaWR0aCAtIHBhbmVsRHJhZy53aWR0aCAtIDgpLFxuICAgIHk6IGNsYW1wKGV2ZW50LmNsaWVudFkgLSBwYW5lbERyYWcub2Zmc2V0WSwgOCwgd2luZG93LmlubmVySGVpZ2h0IC0gcGFuZWxEcmFnLmhlaWdodCAtIDgpLFxuICB9O1xuICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xufVxuXG5mdW5jdGlvbiBzdG9wR29hbFBhbmVsRHJhZyhldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbERyYWcgJiYgZXZlbnQucG9pbnRlcklkICE9PSBwYW5lbERyYWcucG9pbnRlcklkKSByZXR1cm47XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgbW92ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxEcmFnKTtcbiAgaWYgKHJvb3QpIHJvb3QuY2xhc3NMaXN0LnJlbW92ZShcImlzLWRyYWdnaW5nXCIpO1xuICBwYW5lbERyYWcgPSBudWxsO1xuICBpZiAocm9vdCkgY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KHJvb3QpO1xuICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbn1cblxuZnVuY3Rpb24gc3RhcnRHb2FsUGFuZWxSZXNpemUoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQge1xuICBpZiAoZXZlbnQuYnV0dG9uICE9PSAwIHx8IHBhbmVsU3RhdGUuY29sbGFwc2VkKSByZXR1cm47XG4gIGlmICghcm9vdCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gcm9vdC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgZW5zdXJlRXhwbGljaXRHb2FsUGFuZWxGcmFtZShyZWN0KTtcbiAgcGFuZWxSZXNpemUgPSB7XG4gICAgcG9pbnRlcklkOiBldmVudC5wb2ludGVySWQsXG4gICAgc3RhcnRYOiBldmVudC5jbGllbnRYLFxuICAgIHN0YXJ0WTogZXZlbnQuY2xpZW50WSxcbiAgICB3aWR0aDogcmVjdC53aWR0aCxcbiAgICBoZWlnaHQ6IHJlY3QuaGVpZ2h0LFxuICB9O1xuICByb290LmNsYXNzTGlzdC5hZGQoXCJpcy1yZXNpemluZ1wiKTtcbiAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgcmVzaXplR29hbFBhbmVsKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVydXBcIiwgc3RvcEdvYWxQYW5lbFJlc2l6ZSk7XG59XG5cbmZ1bmN0aW9uIHJlc2l6ZUdvYWxQYW5lbChldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmICghcGFuZWxSZXNpemUgfHwgZXZlbnQucG9pbnRlcklkICE9PSBwYW5lbFJlc2l6ZS5wb2ludGVySWQgfHwgIXJvb3QpIHJldHVybjtcbiAgY29uc3QgbWF4V2lkdGggPSBnb2FsUGFuZWxNYXhXaWR0aCgpO1xuICBjb25zdCBtYXhIZWlnaHQgPSBnb2FsUGFuZWxNYXhIZWlnaHQoKTtcbiAgcGFuZWxTdGF0ZSA9IHtcbiAgICAuLi5wYW5lbFN0YXRlLFxuICAgIHdpZHRoOiBjbGFtcChwYW5lbFJlc2l6ZS53aWR0aCArIGV2ZW50LmNsaWVudFggLSBwYW5lbFJlc2l6ZS5zdGFydFgsIEdPQUxfUEFORUxfTUlOX1dJRFRILCBtYXhXaWR0aCksXG4gICAgaGVpZ2h0OiBjbGFtcChwYW5lbFJlc2l6ZS5oZWlnaHQgKyBldmVudC5jbGllbnRZIC0gcGFuZWxSZXNpemUuc3RhcnRZLCBHT0FMX1BBTkVMX01JTl9IRUlHSFQsIG1heEhlaWdodCksXG4gIH07XG4gIGFwcGx5R29hbFBhbmVsU2l6ZShyb290KTtcbiAgY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KHJvb3QpO1xuICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xufVxuXG5mdW5jdGlvbiBzdG9wR29hbFBhbmVsUmVzaXplKGV2ZW50OiBQb2ludGVyRXZlbnQpOiB2b2lkIHtcbiAgaWYgKHBhbmVsUmVzaXplICYmIGV2ZW50LnBvaW50ZXJJZCAhPT0gcGFuZWxSZXNpemUucG9pbnRlcklkKSByZXR1cm47XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgcmVzaXplR29hbFBhbmVsKTtcbiAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJwb2ludGVydXBcIiwgc3RvcEdvYWxQYW5lbFJlc2l6ZSk7XG4gIGlmIChyb290KSByb290LmNsYXNzTGlzdC5yZW1vdmUoXCJpcy1yZXNpemluZ1wiKTtcbiAgcGFuZWxSZXNpemUgPSBudWxsO1xuICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlR29hbFBhbmVsUmVzaXplS2V5ZG93bihldmVudDogS2V5Ym9hcmRFdmVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS5jb2xsYXBzZWQgfHwgIXJvb3QpIHJldHVybjtcbiAgY29uc3QgZGVsdGEgPSBldmVudC5zaGlmdEtleSA/IDMyIDogMTI7XG4gIGxldCB3aWR0aERlbHRhID0gMDtcbiAgbGV0IGhlaWdodERlbHRhID0gMDtcbiAgaWYgKGV2ZW50LmtleSA9PT0gXCJBcnJvd0xlZnRcIikgd2lkdGhEZWx0YSA9IC1kZWx0YTtcbiAgZWxzZSBpZiAoZXZlbnQua2V5ID09PSBcIkFycm93UmlnaHRcIikgd2lkdGhEZWx0YSA9IGRlbHRhO1xuICBlbHNlIGlmIChldmVudC5rZXkgPT09IFwiQXJyb3dVcFwiKSBoZWlnaHREZWx0YSA9IC1kZWx0YTtcbiAgZWxzZSBpZiAoZXZlbnQua2V5ID09PSBcIkFycm93RG93blwiKSBoZWlnaHREZWx0YSA9IGRlbHRhO1xuICBlbHNlIHJldHVybjtcblxuICBjb25zdCByZWN0ID0gcm9vdC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgZW5zdXJlRXhwbGljaXRHb2FsUGFuZWxGcmFtZShyZWN0KTtcbiAgcGFuZWxTdGF0ZSA9IHtcbiAgICAuLi5wYW5lbFN0YXRlLFxuICAgIHdpZHRoOiBjbGFtcCgocGFuZWxTdGF0ZS53aWR0aCA/PyByZWN0LndpZHRoKSArIHdpZHRoRGVsdGEsIEdPQUxfUEFORUxfTUlOX1dJRFRILCBnb2FsUGFuZWxNYXhXaWR0aCgpKSxcbiAgICBoZWlnaHQ6IGNsYW1wKChwYW5lbFN0YXRlLmhlaWdodCA/PyByZWN0LmhlaWdodCkgKyBoZWlnaHREZWx0YSwgR09BTF9QQU5FTF9NSU5fSEVJR0hULCBnb2FsUGFuZWxNYXhIZWlnaHQoKSksXG4gIH07XG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICBhcHBseUdvYWxQYW5lbFNpemUocm9vdCk7XG4gIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChyb290KTtcbiAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbiAgc2F2ZUdvYWxQYW5lbFN0YXRlKCk7XG59XG5cbmZ1bmN0aW9uIHJlc2V0R29hbFBhbmVsU2l6ZShldmVudDogTW91c2VFdmVudCk6IHZvaWQge1xuICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgcGFuZWxTdGF0ZSA9IHsgLi4ucGFuZWxTdGF0ZSwgd2lkdGg6IG51bGwsIGhlaWdodDogbnVsbCB9O1xuICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbiAgaWYgKHJvb3QpIHtcbiAgICBhcHBseUdvYWxQYW5lbFNpemUocm9vdCk7XG4gICAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXNldEdvYWxQYW5lbFBvc2l0aW9uKGV2ZW50OiBNb3VzZUV2ZW50KTogdm9pZCB7XG4gIGlmIChldmVudC50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50ICYmIGV2ZW50LnRhcmdldC5jbG9zZXN0KFwiYnV0dG9uXCIpKSByZXR1cm47XG4gIHBhbmVsU3RhdGUgPSB7IC4uLnBhbmVsU3RhdGUsIHg6IG51bGwsIHk6IG51bGwgfTtcbiAgc2F2ZUdvYWxQYW5lbFN0YXRlKCk7XG4gIGlmIChyb290KSBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVFeHBsaWNpdEdvYWxQYW5lbEZyYW1lKHJlY3Q6IERPTVJlY3QpOiB2b2lkIHtcbiAgaWYgKHBhbmVsU3RhdGUueCA9PT0gbnVsbCB8fCBwYW5lbFN0YXRlLnkgPT09IG51bGwpIHtcbiAgICBwYW5lbFN0YXRlID0geyAuLi5wYW5lbFN0YXRlLCB4OiByZWN0LmxlZnQsIHk6IHJlY3QudG9wIH07XG4gIH1cbiAgaWYgKHBhbmVsU3RhdGUud2lkdGggPT09IG51bGwgfHwgcGFuZWxTdGF0ZS5oZWlnaHQgPT09IG51bGwpIHtcbiAgICBwYW5lbFN0YXRlID0geyAuLi5wYW5lbFN0YXRlLCB3aWR0aDogcmVjdC53aWR0aCwgaGVpZ2h0OiByZWN0LmhlaWdodCB9O1xuICB9XG4gIGlmIChyb290KSB7XG4gICAgYXBwbHlHb2FsUGFuZWxTaXplKHJvb3QpO1xuICAgIGFwcGx5R29hbFBhbmVsUG9zaXRpb24ocm9vdCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsUGFuZWxTaXplKGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbFN0YXRlLmNvbGxhcHNlZCkge1xuICAgIGVsZW1lbnQuc3R5bGUud2lkdGggPSBcIlwiO1xuICAgIGVsZW1lbnQuc3R5bGUuaGVpZ2h0ID0gXCJcIjtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocGFuZWxTdGF0ZS53aWR0aCA9PT0gbnVsbCkge1xuICAgIGVsZW1lbnQuc3R5bGUud2lkdGggPSBcIlwiO1xuICB9IGVsc2Uge1xuICAgIGVsZW1lbnQuc3R5bGUud2lkdGggPSBgJHtjbGFtcChwYW5lbFN0YXRlLndpZHRoLCBHT0FMX1BBTkVMX01JTl9XSURUSCwgZ29hbFBhbmVsTWF4V2lkdGgoKSl9cHhgO1xuICB9XG5cbiAgaWYgKHBhbmVsU3RhdGUuaGVpZ2h0ID09PSBudWxsKSB7XG4gICAgZWxlbWVudC5zdHlsZS5oZWlnaHQgPSBcIlwiO1xuICB9IGVsc2Uge1xuICAgIGVsZW1lbnQuc3R5bGUuaGVpZ2h0ID0gYCR7Y2xhbXAocGFuZWxTdGF0ZS5oZWlnaHQsIEdPQUxfUEFORUxfTUlOX0hFSUdIVCwgZ29hbFBhbmVsTWF4SGVpZ2h0KCkpfXB4YDtcbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbFN0YXRlLnggPT09IG51bGwgfHwgcGFuZWxTdGF0ZS55ID09PSBudWxsKSB7XG4gICAgZWxlbWVudC5zdHlsZS5sZWZ0ID0gXCJhdXRvXCI7XG4gICAgZWxlbWVudC5zdHlsZS50b3AgPSBcImF1dG9cIjtcbiAgICBlbGVtZW50LnN0eWxlLnJpZ2h0ID0gXCIxOHB4XCI7XG4gICAgZWxlbWVudC5zdHlsZS5ib3R0b20gPSBcIjc2cHhcIjtcbiAgICByZXR1cm47XG4gIH1cbiAgY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KGVsZW1lbnQpO1xuICBlbGVtZW50LnN0eWxlLnJpZ2h0ID0gXCJhdXRvXCI7XG4gIGVsZW1lbnQuc3R5bGUuYm90dG9tID0gXCJhdXRvXCI7XG4gIGVsZW1lbnQuc3R5bGUubGVmdCA9IGAke3BhbmVsU3RhdGUueH1weGA7XG4gIGVsZW1lbnQuc3R5bGUudG9wID0gYCR7cGFuZWxTdGF0ZS55fXB4YDtcbn1cblxuZnVuY3Rpb24gY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbFN0YXRlLnggPT09IG51bGwgfHwgcGFuZWxTdGF0ZS55ID09PSBudWxsKSByZXR1cm47XG4gIGNvbnN0IHJlY3QgPSBlbGVtZW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBwYW5lbFN0YXRlID0ge1xuICAgIC4uLnBhbmVsU3RhdGUsXG4gICAgeDogY2xhbXAocGFuZWxTdGF0ZS54LCBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTiwgd2luZG93LmlubmVyV2lkdGggLSByZWN0LndpZHRoIC0gR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU4pLFxuICAgIHk6IGNsYW1wKHBhbmVsU3RhdGUueSwgR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU4sIHdpbmRvdy5pbm5lckhlaWdodCAtIHJlY3QuaGVpZ2h0IC0gR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU4pLFxuICB9O1xufVxuXG5mdW5jdGlvbiBnb2FsUGFuZWxNYXhXaWR0aCgpOiBudW1iZXIge1xuICBjb25zdCBsZWZ0ID0gcGFuZWxTdGF0ZS54ID8/IEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOO1xuICByZXR1cm4gTWF0aC5tYXgoR09BTF9QQU5FTF9NSU5fV0lEVEgsIHdpbmRvdy5pbm5lcldpZHRoIC0gbGVmdCAtIEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOKTtcbn1cblxuZnVuY3Rpb24gZ29hbFBhbmVsTWF4SGVpZ2h0KCk6IG51bWJlciB7XG4gIGNvbnN0IHRvcCA9IHBhbmVsU3RhdGUueSA/PyBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTjtcbiAgcmV0dXJuIE1hdGgubWF4KEdPQUxfUEFORUxfTUlOX0hFSUdIVCwgd2luZG93LmlubmVySGVpZ2h0IC0gdG9wIC0gR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU4pO1xufVxuXG5mdW5jdGlvbiByZWFkR29hbFBhbmVsU3RhdGUoKTogR29hbFBhbmVsU3RhdGUge1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oR09BTF9QQU5FTF9TVEFURV9LRVkpID8/IFwie31cIikgYXMgUGFydGlhbDxHb2FsUGFuZWxTdGF0ZT47XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbGxhcHNlZDogcGFyc2VkLmNvbGxhcHNlZCA9PT0gdHJ1ZSxcbiAgICAgIHg6IHR5cGVvZiBwYXJzZWQueCA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkLngpID8gcGFyc2VkLnggOiBudWxsLFxuICAgICAgeTogdHlwZW9mIHBhcnNlZC55ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShwYXJzZWQueSkgPyBwYXJzZWQueSA6IG51bGwsXG4gICAgICB3aWR0aDogdHlwZW9mIHBhcnNlZC53aWR0aCA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkLndpZHRoKSA/IHBhcnNlZC53aWR0aCA6IG51bGwsXG4gICAgICBoZWlnaHQ6IHR5cGVvZiBwYXJzZWQuaGVpZ2h0ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShwYXJzZWQuaGVpZ2h0KSA/IHBhcnNlZC5oZWlnaHQgOiBudWxsLFxuICAgIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IGNvbGxhcHNlZDogZmFsc2UsIHg6IG51bGwsIHk6IG51bGwsIHdpZHRoOiBudWxsLCBoZWlnaHQ6IG51bGwgfTtcbiAgfVxufVxuXG5mdW5jdGlvbiBzYXZlR29hbFBhbmVsU3RhdGUoKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oR09BTF9QQU5FTF9TVEFURV9LRVksIEpTT04uc3RyaW5naWZ5KHBhbmVsU3RhdGUpKTtcbiAgfSBjYXRjaCB7fVxufVxuXG5mdW5jdGlvbiBjbGFtcCh2YWx1ZTogbnVtYmVyLCBtaW46IG51bWJlciwgbWF4OiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAobWF4IDwgbWluKSByZXR1cm4gbWluO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgodmFsdWUsIG1pbiksIG1heCk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVN1Z2dlc3Rpb25Sb290KCk6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCB7XG4gIGlmIChzdWdnZXN0aW9uUm9vdD8uaXNDb25uZWN0ZWQpIHJldHVybiBzdWdnZXN0aW9uUm9vdDtcbiAgY29uc3QgcGFyZW50ID0gZG9jdW1lbnQuYm9keSB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmICghcGFyZW50KSByZXR1cm4gbnVsbDtcbiAgc3VnZ2VzdGlvblJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdWdnZXN0aW9uUm9vdC5pZCA9IFwiY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24tcm9vdFwiO1xuICBzdWdnZXN0aW9uUm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIHBhcmVudC5hcHBlbmRDaGlsZChzdWdnZXN0aW9uUm9vdCk7XG4gIHJldHVybiBzdWdnZXN0aW9uUm9vdDtcbn1cblxuZnVuY3Rpb24gdXBkYXRlR29hbFN1Z2dlc3Rpb24oZWRpdGFibGU6IEVkaXRhYmxlVGFyZ2V0IHwgbnVsbCk6IHZvaWQge1xuICBpZiAoIWVkaXRhYmxlKSB7XG4gICAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHN1Z2dlc3Rpb24gPSBwYXJzZUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLmdldFRleHQoKSk7XG4gIGlmICghc3VnZ2VzdGlvbikge1xuICAgIGhpZGVHb2FsU3VnZ2VzdGlvbigpO1xuICAgIHJldHVybjtcbiAgfVxuICByZW5kZXJHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZSwgc3VnZ2VzdGlvbi5xdWVyeSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlOiBFZGl0YWJsZVRhcmdldCwgcXVlcnk6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBlbCA9IGVuc3VyZVN1Z2dlc3Rpb25Sb290KCk7XG4gIGlmICghZWwpIHJldHVybjtcbiAgY29uc3QgcmVjdCA9IGVkaXRhYmxlLmVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oNDIwLCBNYXRoLm1heCgyODAsIHJlY3Qud2lkdGggfHwgMzIwKSk7XG4gIGNvbnN0IGxlZnQgPSBNYXRoLm1heCgxMiwgTWF0aC5taW4ocmVjdC5sZWZ0LCB3aW5kb3cuaW5uZXJXaWR0aCAtIHdpZHRoIC0gMTIpKTtcbiAgY29uc3QgdG9wID0gTWF0aC5tYXgoMTIsIHJlY3QudG9wIC0gNjYpO1xuXG4gIGVsLmlubmVySFRNTCA9IFwiXCI7XG4gIGVsLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb25cIjtcbiAgZWwuc3R5bGUubGVmdCA9IGAke2xlZnR9cHhgO1xuICBlbC5zdHlsZS50b3AgPSBgJHt0b3B9cHhgO1xuICBlbC5zdHlsZS53aWR0aCA9IGAke3dpZHRofXB4YDtcblxuICBjb25zdCBpdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgaXRlbS50eXBlID0gXCJidXR0b25cIjtcbiAgaXRlbS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWl0ZW1cIjtcbiAgaXRlbS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiR29hbCBjb21tYW5kXCIpO1xuICBpdGVtLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWRvd25cIiwgKGV2ZW50KSA9PiB7XG4gICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBhcHBseUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlKTtcbiAgfSk7XG5cbiAgY29uc3QgY29tbWFuZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb21tYW5kLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24tY29tbWFuZFwiO1xuICBjb21tYW5kLnRleHRDb250ZW50ID0gXCIvZ29hbFwiO1xuICBpZiAocXVlcnkpIHtcbiAgICBjb21tYW5kLmRhdGFzZXQucXVlcnkgPSBxdWVyeTtcbiAgfVxuXG4gIGNvbnN0IGRldGFpbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBkZXRhaWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1kZXRhaWxcIjtcbiAgZGV0YWlsLnRleHRDb250ZW50ID0gXCJTZXQsIHZpZXcsIHBhdXNlLCByZXN1bWUsIGNvbXBsZXRlLCBvciBjbGVhciB0aGlzIHRocmVhZCBnb2FsXCI7XG5cbiAgaXRlbS5hcHBlbmQoY29tbWFuZCwgZGV0YWlsKTtcbiAgZWwuYXBwZW5kQ2hpbGQoaXRlbSk7XG4gIGVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG59XG5cbmZ1bmN0aW9uIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGU6IEVkaXRhYmxlVGFyZ2V0KTogdm9pZCB7XG4gIGVkaXRhYmxlLnNldFRleHQoXCIvZ29hbCBcIik7XG4gIGhpZGVHb2FsU3VnZ2VzdGlvbigpO1xufVxuXG5mdW5jdGlvbiBoaWRlR29hbFN1Z2dlc3Rpb24oKTogdm9pZCB7XG4gIGlmIChzdWdnZXN0aW9uUm9vdCkgc3VnZ2VzdGlvblJvb3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsU3R5bGVzKCk6IHZvaWQge1xuICBpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjb2RleHBwLWdvYWwtc3R5bGVcIikpIHJldHVybjtcbiAgY29uc3QgcGFyZW50ID0gZG9jdW1lbnQuaGVhZCB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmICghcGFyZW50KSB7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgKCkgPT4gaW5zdGFsbFN0eWxlcygpLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3R5bGVcIik7XG4gIHN0eWxlLmlkID0gXCJjb2RleHBwLWdvYWwtc3R5bGVcIjtcbiAgc3R5bGUudGV4dENvbnRlbnQgPSBgXG4jY29kZXhwcC1nb2FsLXJvb3Qge1xuICBwb3NpdGlvbjogZml4ZWQ7XG4gIHJpZ2h0OiAxOHB4O1xuICBib3R0b206IDc2cHg7XG4gIHotaW5kZXg6IDIxNDc0ODM2NDc7XG4gIHdpZHRoOiBtaW4oNDIwcHgsIGNhbGMoMTAwdncgLSAzNnB4KSk7XG4gIG1heC13aWR0aDogY2FsYygxMDB2dyAtIDE2cHgpO1xuICBtYXgtaGVpZ2h0OiBjYWxjKDEwMHZoIC0gMTZweCk7XG4gIGZvbnQ6IDEzcHgvMS40IC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgXCJTZWdvZSBVSVwiLCBzYW5zLXNlcmlmO1xuICBjb2xvcjogdmFyKC0tdGV4dC1wcmltYXJ5LCAjZjVmN2ZiKTtcbn1cbiNjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1yb290IHtcbiAgcG9zaXRpb246IGZpeGVkO1xuICB6LWluZGV4OiAyMTQ3NDgzNjQ3O1xuICBmb250OiAxM3B4LzEuMzUgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBcIlNlZ29lIFVJXCIsIHNhbnMtc2VyaWY7XG4gIGNvbG9yOiB2YXIoLS10ZXh0LXByaW1hcnksICNmNWY3ZmIpO1xufVxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uIHtcbiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwwLjE0KTtcbiAgYm9yZGVyLXJhZGl1czogOHB4O1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI0LCAyNywgMzMsIDAuOTgpO1xuICBib3gtc2hhZG93OiAwIDE2cHggNDZweCByZ2JhKDAsMCwwLDAuMzIpO1xuICBvdmVyZmxvdzogaGlkZGVuO1xuICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMTRweCk7XG59XG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbSB7XG4gIHdpZHRoOiAxMDAlO1xuICBib3JkZXI6IDA7XG4gIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50O1xuICBjb2xvcjogaW5oZXJpdDtcbiAgZGlzcGxheTogZ3JpZDtcbiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiBhdXRvIDFmcjtcbiAgZ2FwOiAxMnB4O1xuICBhbGlnbi1pdGVtczogY2VudGVyO1xuICBwYWRkaW5nOiAxMHB4IDEycHg7XG4gIHRleHQtYWxpZ246IGxlZnQ7XG4gIGN1cnNvcjogcG9pbnRlcjtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1pdGVtOmhvdmVyLFxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWl0ZW06Zm9jdXMtdmlzaWJsZSB7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4wOSk7XG4gIG91dGxpbmU6IG5vbmU7XG59XG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24tY29tbWFuZCB7XG4gIGZvbnQtZmFtaWx5OiB1aS1tb25vc3BhY2UsIFNGTW9uby1SZWd1bGFyLCBcIlNGIE1vbm9cIiwgTWVubG8sIG1vbm9zcGFjZTtcbiAgZm9udC13ZWlnaHQ6IDY1MDtcbiAgY29sb3I6ICM5ZmM1ZmY7XG59XG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24tZGV0YWlsIHtcbiAgbWluLXdpZHRoOiAwO1xuICBvdmVyZmxvdzogaGlkZGVuO1xuICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgY29sb3I6IHJnYmEoMjQ1LDI0NywyNTEsMC43Mik7XG59XG4uY29kZXhwcC1nb2FsLXBhbmVsIHtcbiAgYm94LXNpemluZzogYm9yZGVyLWJveDtcbiAgZGlzcGxheTogZmxleDtcbiAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgcG9zaXRpb246IGZpeGVkO1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTYpO1xuICBib3JkZXItcmFkaXVzOiA4cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjYsIDI5LCAzNSwgMC45Nik7XG4gIGJveC1zaGFkb3c6IDAgMThweCA2MHB4IHJnYmEoMCwwLDAsMC4zNCk7XG4gIHBhZGRpbmc6IDEycHg7XG4gIGJhY2tkcm9wLWZpbHRlcjogYmx1cigxNHB4KTtcbiAgb3ZlcmZsb3c6IGhpZGRlbjtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWw6bm90KC5pcy1jb2xsYXBzZWQpIHtcbiAgbWluLXdpZHRoOiAyODBweDtcbiAgbWluLWhlaWdodDogMTYwcHg7XG59XG4uY29kZXhwcC1nb2FsLXBhbmVsLmlzLWRyYWdnaW5nIHtcbiAgY3Vyc29yOiBncmFiYmluZztcbiAgdXNlci1zZWxlY3Q6IG5vbmU7XG59XG4uY29kZXhwcC1nb2FsLXBhbmVsLmlzLXJlc2l6aW5nIHtcbiAgY3Vyc29yOiBud3NlLXJlc2l6ZTtcbiAgdXNlci1zZWxlY3Q6IG5vbmU7XG59XG4uY29kZXhwcC1nb2FsLXBhbmVsLmlzLWNvbGxhcHNlZCB7XG4gIHdpZHRoOiBtaW4oMzIwcHgsIGNhbGMoMTAwdncgLSAzNnB4KSk7XG4gIG1pbi1oZWlnaHQ6IDA7XG4gIHBhZGRpbmc6IDEwcHggMTJweDtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtZXJyb3Ige1xuICBib3JkZXItY29sb3I6IHJnYmEoMjU1LCAxMjIsIDEyMiwgMC41NSk7XG59XG4uY29kZXhwcC1nb2FsLWhlYWRlciB7XG4gIGRpc3BsYXk6IGZsZXg7XG4gIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjtcbiAgZ2FwOiAxMnB4O1xuICBmb250LXdlaWdodDogNjUwO1xuICBjdXJzb3I6IGdyYWI7XG4gIHVzZXItc2VsZWN0OiBub25lO1xufVxuLmNvZGV4cHAtZ29hbC10aXRsZSB7XG4gIG1pbi13aWR0aDogMDtcbiAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG4gIHdoaXRlLXNwYWNlOiBub3dyYXA7XG59XG4uY29kZXhwcC1nb2FsLWNvbnRyb2xzIHtcbiAgZGlzcGxheTogZmxleDtcbiAgZmxleC1zaHJpbms6IDA7XG4gIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gIGdhcDogNHB4O1xufVxuLmNvZGV4cHAtZ29hbC1pY29uIHtcbiAgd2lkdGg6IDI0cHg7XG4gIGhlaWdodDogMjRweDtcbiAgYm9yZGVyOiAwO1xuICBib3JkZXItcmFkaXVzOiA2cHg7XG4gIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50O1xuICBjb2xvcjogaW5oZXJpdDtcbiAgY3Vyc29yOiBwb2ludGVyO1xuICBsaW5lLWhlaWdodDogMTtcbn1cbi5jb2RleHBwLWdvYWwtaWNvbjpob3ZlciB7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4xKTtcbn1cbi5jb2RleHBwLWdvYWwtZGV0YWlsIHtcbiAgbWFyZ2luLXRvcDogOHB4O1xuICBmbGV4OiAxIDEgYXV0bztcbiAgbWluLWhlaWdodDogMDtcbiAgbWF4LWhlaWdodDogOTZweDtcbiAgb3ZlcmZsb3c6IGF1dG87XG4gIGNvbG9yOiByZ2JhKDI0NSwyNDcsMjUxLDAuOSk7XG4gIHdvcmQtYnJlYWs6IGJyZWFrLXdvcmQ7XG59XG4uY29kZXhwcC1nb2FsLXBhbmVsW3N0eWxlKj1cImhlaWdodFwiXSAuY29kZXhwcC1nb2FsLWRldGFpbCB7XG4gIG1heC1oZWlnaHQ6IG5vbmU7XG59XG4uY29kZXhwcC1nb2FsLWZvb3RlciB7XG4gIGZsZXg6IDAgMCBhdXRvO1xuICBtYXJnaW4tdG9wOiA4cHg7XG4gIGNvbG9yOiByZ2JhKDI0NSwyNDcsMjUxLDAuNjIpO1xuICBmb250LXNpemU6IDEycHg7XG59XG4uY29kZXhwcC1nb2FsLWFjdGlvbnMge1xuICBmbGV4OiAwIDAgYXV0bztcbiAgZGlzcGxheTogZmxleDtcbiAgZmxleC13cmFwOiB3cmFwO1xuICBnYXA6IDhweDtcbiAgbWFyZ2luLXRvcDogMTJweDtcbn1cbi5jb2RleHBwLWdvYWwtYWN0aW9uIHtcbiAgbWluLWhlaWdodDogMjhweDtcbiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwwLjE0KTtcbiAgYm9yZGVyLXJhZGl1czogN3B4O1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LDAuMDgpO1xuICBjb2xvcjogaW5oZXJpdDtcbiAgcGFkZGluZzogNHB4IDEwcHg7XG4gIGN1cnNvcjogcG9pbnRlcjtcbn1cbi5jb2RleHBwLWdvYWwtYWN0aW9uOmhvdmVyIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjE0KTtcbn1cbi5jb2RleHBwLWdvYWwtYWN0aW9uLnByaW1hcnkge1xuICBib3JkZXItY29sb3I6IHJnYmEoMTI1LCAxODAsIDI1NSwgMC41NSk7XG4gIGJhY2tncm91bmQ6IHJnYmEoNzQsIDEyMSwgMjE2LCAwLjQyKTtcbn1cbi5jb2RleHBwLWdvYWwtYWN0aW9uLmRhbmdlciB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsIDEyMiwgMTIyLCAwLjQ4KTtcbn1cbi5jb2RleHBwLWdvYWwtcmVzaXplIHtcbiAgcG9zaXRpb246IGFic29sdXRlO1xuICByaWdodDogMnB4O1xuICBib3R0b206IDJweDtcbiAgd2lkdGg6IDE4cHg7XG4gIGhlaWdodDogMThweDtcbiAgYm9yZGVyOiAwO1xuICBib3JkZXItcmFkaXVzOiA0cHg7XG4gIGJhY2tncm91bmQ6IHRyYW5zcGFyZW50O1xuICBjdXJzb3I6IG53c2UtcmVzaXplO1xuICBvcGFjaXR5OiAwLjcyO1xufVxuLmNvZGV4cHAtZ29hbC1yZXNpemU6OmJlZm9yZSB7XG4gIGNvbnRlbnQ6IFwiXCI7XG4gIHBvc2l0aW9uOiBhYnNvbHV0ZTtcbiAgcmlnaHQ6IDRweDtcbiAgYm90dG9tOiA0cHg7XG4gIHdpZHRoOiA4cHg7XG4gIGhlaWdodDogOHB4O1xuICBib3JkZXItcmlnaHQ6IDFweCBzb2xpZCByZ2JhKDI0NSwyNDcsMjUxLDAuNyk7XG4gIGJvcmRlci1ib3R0b206IDFweCBzb2xpZCByZ2JhKDI0NSwyNDcsMjUxLDAuNyk7XG59XG4uY29kZXhwcC1nb2FsLXJlc2l6ZTpob3Zlcixcbi5jb2RleHBwLWdvYWwtcmVzaXplOmZvY3VzLXZpc2libGUge1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LDAuMDgpO1xuICBvcGFjaXR5OiAxO1xuICBvdXRsaW5lOiBub25lO1xufVxuYDtcbiAgcGFyZW50LmFwcGVuZENoaWxkKHN0eWxlKTtcbn1cblxuZnVuY3Rpb24gZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50OiBFdmVudCk6IEVkaXRhYmxlVGFyZ2V0IHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSB0eXBlb2YgZXZlbnQuY29tcG9zZWRQYXRoID09PSBcImZ1bmN0aW9uXCIgPyBldmVudC5jb21wb3NlZFBhdGgoKSA6IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGF0aCkge1xuICAgIGlmICghKGl0ZW0gaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGVkaXRhYmxlID0gZWRpdGFibGVGb3JFbGVtZW50KGl0ZW0pO1xuICAgIGlmIChlZGl0YWJsZSkgcmV0dXJuIGVkaXRhYmxlO1xuICB9XG4gIHJldHVybiBldmVudC50YXJnZXQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IGVkaXRhYmxlRm9yRWxlbWVudChldmVudC50YXJnZXQpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gZWRpdGFibGVGb3JFbGVtZW50KGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogRWRpdGFibGVUYXJnZXQgfCBudWxsIHtcbiAgaWYgKGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MVGV4dEFyZWFFbGVtZW50IHx8IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50KSB7XG4gICAgY29uc3QgdHlwZSA9IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50ID8gZWxlbWVudC50eXBlIDogXCJ0ZXh0YXJlYVwiO1xuICAgIGlmICghW1widGV4dFwiLCBcInNlYXJjaFwiLCBcInRleHRhcmVhXCJdLmluY2x1ZGVzKHR5cGUpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgZWxlbWVudCxcbiAgICAgIGdldFRleHQ6ICgpID0+IGVsZW1lbnQudmFsdWUsXG4gICAgICBzZXRUZXh0OiAodmFsdWUpID0+IHtcbiAgICAgICAgZWxlbWVudC52YWx1ZSA9IHZhbHVlO1xuICAgICAgICBlbGVtZW50LmZvY3VzKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZWxlbWVudC5zZXRTZWxlY3Rpb25SYW5nZSh2YWx1ZS5sZW5ndGgsIHZhbHVlLmxlbmd0aCk7XG4gICAgICAgIH0gY2F0Y2gge31cbiAgICAgICAgZWxlbWVudC5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiaW5zZXJ0VGV4dFwiLCBkYXRhOiB2YWx1ZSB9KSk7XG4gICAgICB9LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgZWxlbWVudC52YWx1ZSA9IFwiXCI7XG4gICAgICAgIGVsZW1lbnQuZGlzcGF0Y2hFdmVudChuZXcgSW5wdXRFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSwgaW5wdXRUeXBlOiBcImRlbGV0ZUNvbnRlbnRCYWNrd2FyZFwiIH0pKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGVkaXRhYmxlID0gZWxlbWVudC5pc0NvbnRlbnRFZGl0YWJsZVxuICAgID8gZWxlbWVudFxuICAgIDogZWxlbWVudC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0sIFtyb2xlPVwidGV4dGJveFwiXScpO1xuICBpZiAoIWVkaXRhYmxlKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICBlbGVtZW50OiBlZGl0YWJsZSxcbiAgICBnZXRUZXh0OiAoKSA9PiBlZGl0YWJsZS5pbm5lclRleHQgfHwgZWRpdGFibGUudGV4dENvbnRlbnQgfHwgXCJcIixcbiAgICBzZXRUZXh0OiAodmFsdWUpID0+IHtcbiAgICAgIGVkaXRhYmxlLnRleHRDb250ZW50ID0gdmFsdWU7XG4gICAgICBlZGl0YWJsZS5mb2N1cygpO1xuICAgICAgcGxhY2VDYXJldEF0RW5kKGVkaXRhYmxlKTtcbiAgICAgIGVkaXRhYmxlLmRpc3BhdGNoRXZlbnQobmV3IElucHV0RXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUsIGlucHV0VHlwZTogXCJpbnNlcnRUZXh0XCIsIGRhdGE6IHZhbHVlIH0pKTtcbiAgICB9LFxuICAgIGNsZWFyOiAoKSA9PiB7XG4gICAgICBlZGl0YWJsZS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBlZGl0YWJsZS5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiZGVsZXRlQ29udGVudEJhY2t3YXJkXCIgfSkpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHBsYWNlQ2FyZXRBdEVuZChlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBzZWxlY3Rpb24gPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7XG4gIGlmICghc2VsZWN0aW9uKSByZXR1cm47XG4gIGNvbnN0IHJhbmdlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTtcbiAgcmFuZ2Uuc2VsZWN0Tm9kZUNvbnRlbnRzKGVsZW1lbnQpO1xuICByYW5nZS5jb2xsYXBzZShmYWxzZSk7XG4gIHNlbGVjdGlvbi5yZW1vdmVBbGxSYW5nZXMoKTtcbiAgc2VsZWN0aW9uLmFkZFJhbmdlKHJhbmdlKTtcbn1cblxuZnVuY3Rpb24gcmVhZFRocmVhZElkKCk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtsb2NhdGlvbi5wYXRobmFtZSwgbG9jYXRpb24uaGFzaCwgbG9jYXRpb24uaHJlZl07XG4gIHRyeSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcbiAgICBjb25zdCBpbml0aWFsUm91dGUgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImluaXRpYWxSb3V0ZVwiKTtcbiAgICBpZiAoaW5pdGlhbFJvdXRlKSBjYW5kaWRhdGVzLnB1c2goaW5pdGlhbFJvdXRlKTtcbiAgfSBjYXRjaCB7fVxuICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyhoaXN0b3J5LnN0YXRlKSk7XG4gIGNhbmRpZGF0ZXMucHVzaCguLi5jb2xsZWN0RG9tVGhyZWFkQ2FuZGlkYXRlcygpKTtcblxuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgdGhyZWFkSWQgPSBub3JtYWxpemVUaHJlYWRJZChjYW5kaWRhdGUpO1xuICAgIGlmICh0aHJlYWRJZCkgcmV0dXJuIHRocmVhZElkO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUaHJlYWRJZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGRlY29kZWQgPSBzYWZlRGVjb2RlKHZhbHVlKS50cmltKCk7XG4gIGNvbnN0IHJvdXRlTWF0Y2ggPSBkZWNvZGVkLm1hdGNoKC9cXC9sb2NhbFxcLyhbXi8/I1xcc10rKS8pO1xuICBpZiAocm91dGVNYXRjaD8uWzFdKSB7XG4gICAgY29uc3QgZnJvbVJvdXRlID0gbm9ybWFsaXplVGhyZWFkSWRUb2tlbihyb3V0ZU1hdGNoWzFdKTtcbiAgICBpZiAoZnJvbVJvdXRlKSByZXR1cm4gZnJvbVJvdXRlO1xuICB9XG5cbiAgY29uc3QgdG9rZW5NYXRjaCA9IGRlY29kZWQubWF0Y2goL1xcYig/OlthLXpdW1xcdy4tXSo6KSooWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9KVxcYi9pKTtcbiAgaWYgKHRva2VuTWF0Y2g/LlsxXSkgcmV0dXJuIHRva2VuTWF0Y2hbMV07XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVRocmVhZElkVG9rZW4odmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBkZWNvZGVkID0gc2FmZURlY29kZSh2YWx1ZSkudHJpbSgpO1xuICBjb25zdCBtYXRjaCA9IGRlY29kZWQubWF0Y2goLyg/Ol58OikoWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9KSQvaSk7XG4gIHJldHVybiBtYXRjaD8uWzFdID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3REb21UaHJlYWRDYW5kaWRhdGVzKCk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc2VsZWN0b3JzID0gW1xuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLXJvd11bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT1cInRydWVcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtcm93XVthcmlhLWN1cnJlbnQ9XCJwYWdlXCJdW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1pZF0nLFxuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT1cInRydWVcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRdW2FyaWEtY3VycmVudD1cInBhZ2VcIl0nLFxuICBdO1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIHNlbGVjdG9ycykge1xuICAgIGZvciAoY29uc3QgZWxlbWVudCBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KHNlbGVjdG9yKSkpIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRcIik7XG4gICAgICBpZiAodmFsdWUpIGNhbmRpZGF0ZXMucHVzaCh2YWx1ZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBjYW5kaWRhdGVzO1xufVxuXG5mdW5jdGlvbiBzYWZlRGVjb2RlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyh2YWx1ZTogdW5rbm93biwgZGVwdGggPSAwLCBzZWVuID0gbmV3IFNldDx1bmtub3duPigpKTogc3RyaW5nW10ge1xuICBpZiAoZGVwdGggPiA1IHx8IHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQgfHwgc2Vlbi5oYXModmFsdWUpKSByZXR1cm4gW107XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHJldHVybiBub3JtYWxpemVUaHJlYWRJZCh2YWx1ZSkgPyBbdmFsdWVdIDogW107XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBbXTtcbiAgc2Vlbi5hZGQodmFsdWUpO1xuXG4gIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgT2JqZWN0LnZhbHVlcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyhjaGlsZCwgZGVwdGggKyAxLCBzZWVuKSk7XG4gIH1cbiAgcmV0dXJuIGNhbmRpZGF0ZXM7XG59XG5cbmZ1bmN0aW9uIGdvYWxTdGF0dXNMYWJlbChzdGF0dXM6IEdvYWxTdGF0dXMpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHN0YXR1cykge1xuICAgIGNhc2UgXCJhY3RpdmVcIjpcbiAgICAgIHJldHVybiBcImFjdGl2ZVwiO1xuICAgIGNhc2UgXCJwYXVzZWRcIjpcbiAgICAgIHJldHVybiBcInBhdXNlZFwiO1xuICAgIGNhc2UgXCJidWRnZXRMaW1pdGVkXCI6XG4gICAgICByZXR1cm4gXCJsaW1pdGVkIGJ5IGJ1ZGdldFwiO1xuICAgIGNhc2UgXCJjb21wbGV0ZVwiOlxuICAgICAgcmV0dXJuIFwiY29tcGxldGVcIjtcbiAgfVxufVxuXG5mdW5jdGlvbiBmcmllbmRseUdvYWxFcnJvcihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIGNvbnN0IG1lc3NhZ2UgPSBzdHJpbmdpZnlFcnJvcihlcnJvcik7XG4gIGlmICgvZ29hbHMgZmVhdHVyZSBpcyBkaXNhYmxlZC9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGUgYXBwLXNlcnZlciBoYXMgZ29hbCBzdXBwb3J0LCBidXQgW2ZlYXR1cmVzXS5nb2FscyBpcyBkaXNhYmxlZCBpbiB+Ly5jb2RleC9jb25maWcudG9tbC5cIjtcbiAgfVxuICBpZiAoL3JlcXVpcmVzIGV4cGVyaW1lbnRhbEFwaS9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGUgYXBwLXNlcnZlciByZWplY3RlZCB0aHJlYWQvZ29hbC8qIGJlY2F1c2UgdGhlIGFjdGl2ZSBEZXNrdG9wIGNsaWVudCBkaWQgbm90IG5lZ290aWF0ZSBleHBlcmltZW50YWxBcGkuXCI7XG4gIH1cbiAgaWYgKC91bmtub3dufHVuc3VwcG9ydGVkfG5vdCBmb3VuZHxubyBoYW5kbGVyfGludmFsaWQgcmVxdWVzdHxkZXNlcmlhbGl6ZXx0aHJlYWRcXC9nb2FsL2kudGVzdChtZXNzYWdlKSkge1xuICAgIHJldHVybiBcIlRoaXMgQ29kZXguYXBwIGFwcC1zZXJ2ZXIgZG9lcyBub3Qgc3VwcG9ydCB0aHJlYWQvZ29hbC8qIHlldC4gVXBkYXRlIG9yIHJlcGF0Y2ggQ29kZXguYXBwIHdpdGggYSBidWlsZCB0aGF0IGluY2x1ZGVzIHRoZSBnb2FscyBmZWF0dXJlLlwiO1xuICB9XG4gIHJldHVybiBtZXNzYWdlO1xufVxuXG5mdW5jdGlvbiBmb3JtYXREdXJhdGlvbihzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShzZWNvbmRzKSB8fCBzZWNvbmRzIDw9IDApIHJldHVybiBcIjBzXCI7XG4gIGNvbnN0IG1pbnV0ZXMgPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIGNvbnN0IHJlbWFpbmluZ1NlY29uZHMgPSBNYXRoLmZsb29yKHNlY29uZHMgJSA2MCk7XG4gIGlmIChtaW51dGVzIDw9IDApIHJldHVybiBgJHtyZW1haW5pbmdTZWNvbmRzfXNgO1xuICBjb25zdCBob3VycyA9IE1hdGguZmxvb3IobWludXRlcyAvIDYwKTtcbiAgY29uc3QgcmVtYWluaW5nTWludXRlcyA9IG1pbnV0ZXMgJSA2MDtcbiAgaWYgKGhvdXJzIDw9IDApIHJldHVybiBgJHttaW51dGVzfW0gJHtyZW1haW5pbmdTZWNvbmRzfXNgO1xuICByZXR1cm4gYCR7aG91cnN9aCAke3JlbWFpbmluZ01pbnV0ZXN9bWA7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdE51bWJlcih2YWx1ZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBNYXRoLnJvdW5kKHZhbHVlKS50b0xvY2FsZVN0cmluZygpIDogXCIwXCI7XG59XG5cbmZ1bmN0aW9uIHRydW5jYXRlKHZhbHVlOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLmxlbmd0aCA8PSBtYXhMZW5ndGggPyB2YWx1ZSA6IGAke3ZhbHVlLnNsaWNlKDAsIG1heExlbmd0aCAtIDEpfS4uLmA7XG59XG5cbmZ1bmN0aW9uIHN0cmluZ2lmeUVycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuZnVuY3Rpb24gaXNUaHJlYWRHb2FsKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgVGhyZWFkR29hbCB7XG4gIHJldHVybiBpc1JlY29yZCh2YWx1ZSkgJiZcbiAgICB0eXBlb2YgdmFsdWUudGhyZWFkSWQgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgdmFsdWUub2JqZWN0aXZlID09PSBcInN0cmluZ1wiICYmXG4gICAgdHlwZW9mIHZhbHVlLnN0YXR1cyA9PT0gXCJzdHJpbmdcIjtcbn1cblxuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB2YWx1ZSAhPT0gbnVsbCAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuIiwgImltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgdHlwZSB7XG4gIEdpdERpZmZTdW1tYXJ5LFxuICBHaXRTdGF0dXMsXG4gIEdpdFN0YXR1c0VudHJ5LFxuICBHaXRXb3JrdHJlZSxcbn0gZnJvbSBcIkBjb2RleC1wbHVzcGx1cy9zZGtcIjtcblxuY29uc3QgUFJPSkVDVF9ST1dfU0VMRUNUT1IgPVxuICBcIltkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LXJvd11bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1pZF1cIjtcbmNvbnN0IEFDVElWRV9USFJFQURfU0VMRUNUT1IgPVxuICBcIltkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtYWN0aXZlPSd0cnVlJ10sW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1hY3RpdmU9dHJ1ZV1cIjtcbmNvbnN0IFBST0pFQ1RfTElTVF9TRUxFQ1RPUiA9IFwiW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtbGlzdC1pZF1cIjtcbmNvbnN0IFNVTU1BUllfQVRUUiA9IFwiZGF0YS1jb2RleHBwLWdpdC1zdW1tYXJ5XCI7XG5jb25zdCBCQURHRV9BVFRSID0gXCJkYXRhLWNvZGV4cHAtZ2l0LWJhZGdlXCI7XG5jb25zdCBTVFlMRV9JRCA9IFwiY29kZXhwcC1naXQtc2lkZWJhci1zdHlsZVwiO1xuY29uc3QgUkVGUkVTSF9ERUJPVU5DRV9NUyA9IDI1MDtcbmNvbnN0IFNUQVRVU19UVExfTVMgPSAxMF8wMDA7XG5jb25zdCBERVRBSUxTX1RUTF9NUyA9IDE1XzAwMDtcbmNvbnN0IE1BWF9WSVNJQkxFX1BST0pFQ1RfQkFER0VTID0gMTY7XG5jb25zdCBNQVhfQ0hBTkdFRF9GSUxFUyA9IDc7XG5jb25zdCBNQVhfV09SS1RSRUVfUk9XUyA9IDM7XG5cbmludGVyZmFjZSBQcm9qZWN0Um93IHtcbiAgcm93OiBIVE1MRWxlbWVudDtcbiAgZ3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcGF0aDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgU3RhdHVzQ2FjaGVFbnRyeSB7XG4gIHZhbHVlOiBHaXRTdGF0dXMgfCBudWxsO1xuICBlcnJvcjogc3RyaW5nIHwgbnVsbDtcbiAgbG9hZGVkQXQ6IG51bWJlcjtcbiAgcGVuZGluZzogUHJvbWlzZTxHaXRTdGF0dXMgfCBudWxsPiB8IG51bGw7XG59XG5cbmludGVyZmFjZSBEZXRhaWxzQ2FjaGVFbnRyeSB7XG4gIHZhbHVlOiBHaXREZXRhaWxzIHwgbnVsbDtcbiAgZXJyb3I6IHN0cmluZyB8IG51bGw7XG4gIGxvYWRlZEF0OiBudW1iZXI7XG4gIHBlbmRpbmc6IFByb21pc2U8R2l0RGV0YWlscyB8IG51bGw+IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIEdpdERldGFpbHMge1xuICBkaWZmOiBHaXREaWZmU3VtbWFyeTtcbiAgd29ya3RyZWVzOiBHaXRXb3JrdHJlZVtdO1xufVxuXG5pbnRlcmZhY2UgR2l0U2lkZWJhclN0YXRlIHtcbiAgb2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCBudWxsO1xuICByZWZyZXNoVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbDtcbiAgaW50ZXJ2YWw6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGw7XG4gIHJ1bklkOiBudW1iZXI7XG4gIHN0YXR1c0NhY2hlOiBNYXA8c3RyaW5nLCBTdGF0dXNDYWNoZUVudHJ5PjtcbiAgZGV0YWlsc0NhY2hlOiBNYXA8c3RyaW5nLCBEZXRhaWxzQ2FjaGVFbnRyeT47XG59XG5cbmNvbnN0IHN0YXRlOiBHaXRTaWRlYmFyU3RhdGUgPSB7XG4gIG9ic2VydmVyOiBudWxsLFxuICByZWZyZXNoVGltZXI6IG51bGwsXG4gIGludGVydmFsOiBudWxsLFxuICBydW5JZDogMCxcbiAgc3RhdHVzQ2FjaGU6IG5ldyBNYXAoKSxcbiAgZGV0YWlsc0NhY2hlOiBuZXcgTWFwKCksXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRHaXRTaWRlYmFyKCk6IHZvaWQge1xuICBpZiAoc3RhdGUub2JzZXJ2ZXIpIHJldHVybjtcblxuICBpbnN0YWxsU3R5bGVzKCk7XG5cbiAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigobXV0YXRpb25zKSA9PiB7XG4gICAgaWYgKG11dGF0aW9ucy5zb21lKHNob3VsZFJlYWN0VG9NdXRhdGlvbikpIHtcbiAgICAgIHNjaGVkdWxlUmVmcmVzaChcIm11dGF0aW9uXCIpO1xuICAgIH1cbiAgfSk7XG4gIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7XG4gICAgY2hpbGRMaXN0OiB0cnVlLFxuICAgIHN1YnRyZWU6IHRydWUsXG4gICAgYXR0cmlidXRlczogdHJ1ZSxcbiAgICBhdHRyaWJ1dGVGaWx0ZXI6IFtcbiAgICAgIFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZVwiLFxuICAgICAgXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWNvbGxhcHNlZFwiLFxuICAgICAgXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWlkXCIsXG4gICAgICBcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3Qtcm93XCIsXG4gICAgXSxcbiAgfSk7XG4gIHN0YXRlLm9ic2VydmVyID0gb2JzZXJ2ZXI7XG4gIHN0YXRlLmludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2NoZWR1bGVSZWZyZXNoKFwiaW50ZXJ2YWxcIiksIDE1XzAwMCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNcIiwgb25XaW5kb3dGb2N1cyk7XG4gIHNjaGVkdWxlUmVmcmVzaChcImJvb3RcIik7XG59XG5cbmZ1bmN0aW9uIG9uV2luZG93Rm9jdXMoKTogdm9pZCB7XG4gIHNjaGVkdWxlUmVmcmVzaChcImZvY3VzXCIpO1xufVxuXG5mdW5jdGlvbiBzaG91bGRSZWFjdFRvTXV0YXRpb24obXV0YXRpb246IE11dGF0aW9uUmVjb3JkKTogYm9vbGVhbiB7XG4gIGlmIChtdXRhdGlvbi50eXBlID09PSBcImF0dHJpYnV0ZXNcIikge1xuICAgIGNvbnN0IHRhcmdldCA9IG11dGF0aW9uLnRhcmdldDtcbiAgICByZXR1cm4gdGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCAmJiAoXG4gICAgICB0YXJnZXQubWF0Y2hlcyhQUk9KRUNUX1JPV19TRUxFQ1RPUikgfHxcbiAgICAgIHRhcmdldC5tYXRjaGVzKEFDVElWRV9USFJFQURfU0VMRUNUT1IpIHx8XG4gICAgICB0YXJnZXQuaGFzQXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1saXN0LWlkXCIpXG4gICAgKTtcbiAgfVxuICBmb3IgKGNvbnN0IG5vZGUgb2YgQXJyYXkuZnJvbShtdXRhdGlvbi5hZGRlZE5vZGVzKSkge1xuICAgIGlmIChub2RlQ29udGFpbnNTaWRlYmFyUHJvamVjdChub2RlKSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgZm9yIChjb25zdCBub2RlIG9mIEFycmF5LmZyb20obXV0YXRpb24ucmVtb3ZlZE5vZGVzKSkge1xuICAgIGlmIChub2RlQ29udGFpbnNTaWRlYmFyUHJvamVjdChub2RlKSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBub2RlQ29udGFpbnNTaWRlYmFyUHJvamVjdChub2RlOiBOb2RlKTogYm9vbGVhbiB7XG4gIGlmICghKG5vZGUgaW5zdGFuY2VvZiBFbGVtZW50KSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gbm9kZS5tYXRjaGVzKFBST0pFQ1RfUk9XX1NFTEVDVE9SKSB8fCBCb29sZWFuKG5vZGUucXVlcnlTZWxlY3RvcihQUk9KRUNUX1JPV19TRUxFQ1RPUikpO1xufVxuXG5mdW5jdGlvbiBzY2hlZHVsZVJlZnJlc2goX3JlYXNvbjogc3RyaW5nKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5yZWZyZXNoVGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5yZWZyZXNoVGltZXIpO1xuICBzdGF0ZS5yZWZyZXNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBzdGF0ZS5yZWZyZXNoVGltZXIgPSBudWxsO1xuICAgIHZvaWQgcmVmcmVzaCgpO1xuICB9LCBSRUZSRVNIX0RFQk9VTkNFX01TKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcnVuSWQgPSArK3N0YXRlLnJ1bklkO1xuICBjb25zdCBwcm9qZWN0cyA9IGNvbGxlY3RQcm9qZWN0Um93cygpO1xuICBpZiAocHJvamVjdHMubGVuZ3RoID09PSAwKSB7XG4gICAgcmVtb3ZlU3VtbWFyeVBhbmVsKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYWN0aXZlUGF0aCA9IGdldEFjdGl2ZVByb2plY3RQYXRoKHByb2plY3RzKTtcbiAgY29uc3QgYWN0aXZlUHJvamVjdCA9XG4gICAgKGFjdGl2ZVBhdGggPyBwcm9qZWN0cy5maW5kKChwcm9qZWN0KSA9PiBwcm9qZWN0LnBhdGggPT09IGFjdGl2ZVBhdGgpIDogbnVsbCkgPz9cbiAgICBwcm9qZWN0cy5maW5kKChwcm9qZWN0KSA9PiBwcm9qZWN0LnJvdy5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWNvbGxhcHNlZFwiKSA9PT0gXCJmYWxzZVwiKSA/P1xuICAgIHByb2plY3RzWzBdO1xuXG4gIGNvbnN0IGJhZGdlUHJvamVjdHMgPSBwcmlvcml0aXplQmFkZ2VQcm9qZWN0cyhwcm9qZWN0cywgYWN0aXZlUHJvamVjdCk7XG4gIGNvbnN0IGJhZGdlU3RhdHVzZXMgPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICBiYWRnZVByb2plY3RzLm1hcChhc3luYyAocHJvamVjdCkgPT4ge1xuICAgICAgY29uc3Qgc3RhdHVzID0gYXdhaXQgZ2V0U3RhdHVzKHByb2plY3QucGF0aCk7XG4gICAgICByZXR1cm4geyBwcm9qZWN0LCBzdGF0dXMgfTtcbiAgICB9KSxcbiAgKTtcbiAgaWYgKHJ1bklkICE9PSBzdGF0ZS5ydW5JZCkgcmV0dXJuO1xuICBmb3IgKGNvbnN0IHsgcHJvamVjdCwgc3RhdHVzIH0gb2YgYmFkZ2VTdGF0dXNlcykge1xuICAgIHJlbmRlclByb2plY3RCYWRnZShwcm9qZWN0LCBzdGF0dXMpO1xuICB9XG5cbiAgY29uc3Qgc3VtbWFyeVByb2plY3QgPVxuICAgIGJhZGdlU3RhdHVzZXMuZmluZCgoeyBwcm9qZWN0LCBzdGF0dXMgfSkgPT4gcHJvamVjdC5wYXRoID09PSBhY3RpdmVQcm9qZWN0Py5wYXRoICYmIGlzVXNhYmxlUmVwbyhzdGF0dXMpKVxuICAgICAgPy5wcm9qZWN0ID8/XG4gICAgYmFkZ2VTdGF0dXNlcy5maW5kKCh7IHN0YXR1cyB9KSA9PiBpc1VzYWJsZVJlcG8oc3RhdHVzKSk/LnByb2plY3QgPz9cbiAgICBhY3RpdmVQcm9qZWN0O1xuXG4gIGlmICghc3VtbWFyeVByb2plY3QpIHtcbiAgICByZW1vdmVTdW1tYXJ5UGFuZWwoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBbc3RhdHVzLCBkZXRhaWxzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBnZXRTdGF0dXMoc3VtbWFyeVByb2plY3QucGF0aCksXG4gICAgZ2V0RGV0YWlscyhzdW1tYXJ5UHJvamVjdC5wYXRoKSxcbiAgXSk7XG4gIGlmIChydW5JZCAhPT0gc3RhdGUucnVuSWQpIHJldHVybjtcbiAgcmVuZGVyU3VtbWFyeVBhbmVsKHN1bW1hcnlQcm9qZWN0LCBzdGF0dXMsIGRldGFpbHMpO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0UHJvamVjdFJvd3MoKTogUHJvamVjdFJvd1tdIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCByb3dzOiBQcm9qZWN0Um93W10gPSBbXTtcbiAgZm9yIChjb25zdCByb3cgb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihQUk9KRUNUX1JPV19TRUxFQ1RPUikpKSB7XG4gICAgY29uc3QgcGF0aCA9IHJvdy5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWlkXCIpPy50cmltKCk7XG4gICAgaWYgKCFwYXRoIHx8IHNlZW4uaGFzKHBhdGgpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZChwYXRoKTtcbiAgICByb3dzLnB1c2goe1xuICAgICAgcm93LFxuICAgICAgcGF0aCxcbiAgICAgIGxhYmVsOiByb3cuZ2V0QXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1sYWJlbFwiKT8udHJpbSgpIHx8IGJhc2VuYW1lKHBhdGgpLFxuICAgICAgZ3JvdXA6IGZpbmRQcm9qZWN0R3JvdXAocm93KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gcm93cztcbn1cblxuZnVuY3Rpb24gZmluZFByb2plY3RHcm91cChyb3c6IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgbGV0IGN1cnJlbnQ6IEhUTUxFbGVtZW50IHwgbnVsbCA9IHJvdy5wYXJlbnRFbGVtZW50O1xuICB3aGlsZSAoY3VycmVudCAmJiBjdXJyZW50ICE9PSBkb2N1bWVudC5ib2R5KSB7XG4gICAgaWYgKGN1cnJlbnQuZ2V0QXR0cmlidXRlKFwicm9sZVwiKSA9PT0gXCJsaXN0aXRlbVwiICYmIGN1cnJlbnQudGV4dENvbnRlbnQ/LmluY2x1ZGVzKHJvdy50ZXh0Q29udGVudCA/PyBcIlwiKSkge1xuICAgICAgcmV0dXJuIGN1cnJlbnQ7XG4gICAgfVxuICAgIGlmIChjdXJyZW50LnF1ZXJ5U2VsZWN0b3IoUFJPSkVDVF9ST1dfU0VMRUNUT1IpID09PSByb3cgJiYgY3VycmVudC5xdWVyeVNlbGVjdG9yKFBST0pFQ1RfTElTVF9TRUxFQ1RPUikpIHtcbiAgICAgIHJldHVybiBjdXJyZW50O1xuICAgIH1cbiAgICBjdXJyZW50ID0gY3VycmVudC5wYXJlbnRFbGVtZW50O1xuICB9XG4gIHJldHVybiByb3cucGFyZW50RWxlbWVudDtcbn1cblxuZnVuY3Rpb24gZ2V0QWN0aXZlUHJvamVjdFBhdGgocHJvamVjdHM6IFByb2plY3RSb3dbXSk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBhY3RpdmVUaHJlYWQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihBQ1RJVkVfVEhSRUFEX1NFTEVDVE9SKTtcbiAgY29uc3QgcHJvamVjdExpc3QgPSBhY3RpdmVUaHJlYWQ/LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KFBST0pFQ1RfTElTVF9TRUxFQ1RPUik7XG4gIGNvbnN0IGxpc3RQYXRoID0gcHJvamVjdExpc3Q/LmdldEF0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtbGlzdC1pZFwiKT8udHJpbSgpO1xuICBpZiAobGlzdFBhdGgpIHJldHVybiBsaXN0UGF0aDtcblxuICBjb25zdCBleHBhbmRlZCA9IHByb2plY3RzLmZpbmQoXG4gICAgKHByb2plY3QpID0+IHByb2plY3Qucm93LmdldEF0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtY29sbGFwc2VkXCIpID09PSBcImZhbHNlXCIsXG4gICk7XG4gIHJldHVybiBleHBhbmRlZD8ucGF0aCA/PyBudWxsO1xufVxuXG5mdW5jdGlvbiBwcmlvcml0aXplQmFkZ2VQcm9qZWN0cyhwcm9qZWN0czogUHJvamVjdFJvd1tdLCBhY3RpdmVQcm9qZWN0OiBQcm9qZWN0Um93IHwgdW5kZWZpbmVkKTogUHJvamVjdFJvd1tdIHtcbiAgY29uc3QgdmlzaWJsZSA9IHByb2plY3RzLmZpbHRlcigocHJvamVjdCkgPT4ge1xuICAgIGNvbnN0IHJlY3QgPSBwcm9qZWN0LnJvdy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICByZXR1cm4gcmVjdC53aWR0aCA+IDAgJiYgcmVjdC5oZWlnaHQgPiAwICYmIHJlY3QuYm90dG9tID49IDAgJiYgcmVjdC50b3AgPD0gd2luZG93LmlubmVySGVpZ2h0O1xuICB9KTtcbiAgY29uc3Qgb3JkZXJlZCA9IGFjdGl2ZVByb2plY3RcbiAgICA/IFthY3RpdmVQcm9qZWN0LCAuLi52aXNpYmxlLmZpbHRlcigocHJvamVjdCkgPT4gcHJvamVjdC5wYXRoICE9PSBhY3RpdmVQcm9qZWN0LnBhdGgpXVxuICAgIDogdmlzaWJsZTtcbiAgcmV0dXJuIG9yZGVyZWQuc2xpY2UoMCwgTUFYX1ZJU0lCTEVfUFJPSkVDVF9CQURHRVMpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRTdGF0dXMocGF0aDogc3RyaW5nKTogUHJvbWlzZTxHaXRTdGF0dXMgfCBudWxsPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IGNhY2hlZCA9IHN0YXRlLnN0YXR1c0NhY2hlLmdldChwYXRoKTtcbiAgaWYgKGNhY2hlZD8udmFsdWUgJiYgbm93IC0gY2FjaGVkLmxvYWRlZEF0IDwgU1RBVFVTX1RUTF9NUykgcmV0dXJuIGNhY2hlZC52YWx1ZTtcbiAgaWYgKGNhY2hlZD8ucGVuZGluZykgcmV0dXJuIGNhY2hlZC5wZW5kaW5nO1xuXG4gIGNvbnN0IGVudHJ5OiBTdGF0dXNDYWNoZUVudHJ5ID0gY2FjaGVkID8/IHtcbiAgICB2YWx1ZTogbnVsbCxcbiAgICBlcnJvcjogbnVsbCxcbiAgICBsb2FkZWRBdDogMCxcbiAgICBwZW5kaW5nOiBudWxsLFxuICB9O1xuICBlbnRyeS5wZW5kaW5nID0gaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnaXQtc3RhdHVzXCIsIHBhdGgpXG4gICAgLnRoZW4oKHN0YXR1cykgPT4ge1xuICAgICAgZW50cnkudmFsdWUgPSBzdGF0dXMgYXMgR2l0U3RhdHVzO1xuICAgICAgZW50cnkuZXJyb3IgPSBudWxsO1xuICAgICAgZW50cnkubG9hZGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgcmV0dXJuIGVudHJ5LnZhbHVlO1xuICAgIH0pXG4gICAgLmNhdGNoKChlcnJvcjogdW5rbm93bikgPT4ge1xuICAgICAgZW50cnkuZXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICBlbnRyeS5sb2FkZWRBdCA9IERhdGUubm93KCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGVudHJ5LnBlbmRpbmcgPSBudWxsO1xuICAgIH0pO1xuICBzdGF0ZS5zdGF0dXNDYWNoZS5zZXQocGF0aCwgZW50cnkpO1xuICByZXR1cm4gZW50cnkucGVuZGluZztcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RGV0YWlscyhwYXRoOiBzdHJpbmcpOiBQcm9taXNlPEdpdERldGFpbHMgfCBudWxsPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IGNhY2hlZCA9IHN0YXRlLmRldGFpbHNDYWNoZS5nZXQocGF0aCk7XG4gIGlmIChjYWNoZWQ/LnZhbHVlICYmIG5vdyAtIGNhY2hlZC5sb2FkZWRBdCA8IERFVEFJTFNfVFRMX01TKSByZXR1cm4gY2FjaGVkLnZhbHVlO1xuICBpZiAoY2FjaGVkPy5wZW5kaW5nKSByZXR1cm4gY2FjaGVkLnBlbmRpbmc7XG5cbiAgY29uc3QgZW50cnk6IERldGFpbHNDYWNoZUVudHJ5ID0gY2FjaGVkID8/IHtcbiAgICB2YWx1ZTogbnVsbCxcbiAgICBlcnJvcjogbnVsbCxcbiAgICBsb2FkZWRBdDogMCxcbiAgICBwZW5kaW5nOiBudWxsLFxuICB9O1xuICBlbnRyeS5wZW5kaW5nID0gUHJvbWlzZS5hbGwoW1xuICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LWRpZmYtc3VtbWFyeVwiLCBwYXRoKSBhcyBQcm9taXNlPEdpdERpZmZTdW1tYXJ5PixcbiAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdpdC13b3JrdHJlZXNcIiwgcGF0aCkgYXMgUHJvbWlzZTxHaXRXb3JrdHJlZVtdPixcbiAgXSlcbiAgICAudGhlbigoW2RpZmYsIHdvcmt0cmVlc10pID0+IHtcbiAgICAgIGVudHJ5LnZhbHVlID0geyBkaWZmLCB3b3JrdHJlZXMgfTtcbiAgICAgIGVudHJ5LmVycm9yID0gbnVsbDtcbiAgICAgIGVudHJ5LmxvYWRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHJldHVybiBlbnRyeS52YWx1ZTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICAgIGVudHJ5LmVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgZW50cnkubG9hZGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICBlbnRyeS5wZW5kaW5nID0gbnVsbDtcbiAgICB9KTtcbiAgc3RhdGUuZGV0YWlsc0NhY2hlLnNldChwYXRoLCBlbnRyeSk7XG4gIHJldHVybiBlbnRyeS5wZW5kaW5nO1xufVxuXG5mdW5jdGlvbiByZW5kZXJQcm9qZWN0QmFkZ2UocHJvamVjdDogUHJvamVjdFJvdywgc3RhdHVzOiBHaXRTdGF0dXMgfCBudWxsKTogdm9pZCB7XG4gIGlmICghaXNVc2FibGVSZXBvKHN0YXR1cykpIHtcbiAgICBwcm9qZWN0LnJvdy5xdWVyeVNlbGVjdG9yKGBbJHtCQURHRV9BVFRSfV1gKT8ucmVtb3ZlKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYmFkZ2UgPSBlbnN1cmVCYWRnZShwcm9qZWN0LnJvdyk7XG4gIGNvbnN0IGRpcnR5ID0gY291bnREaXJ0eShzdGF0dXMuZW50cmllcyk7XG4gIGNvbnN0IGNvbmZsaWN0cyA9IGNvdW50Q29uZmxpY3RzKHN0YXR1cy5lbnRyaWVzKTtcbiAgY29uc3QgYnJhbmNoID0gYnJhbmNoTGFiZWwoc3RhdHVzKTtcbiAgY29uc3Qgc3luYyA9IHN5bmNMYWJlbChzdGF0dXMpO1xuICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKFwiY29kZXhwcC1naXQtYmFkZ2UtZGlydHlcIiwgZGlydHkgPiAwKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcImNvZGV4cHAtZ2l0LWJhZGdlLWNvbmZsaWN0XCIsIGNvbmZsaWN0cyA+IDApO1xuICBiYWRnZS50aXRsZSA9IFtcbiAgICBgJHtwcm9qZWN0LmxhYmVsfTogJHticmFuY2h9YCxcbiAgICBkaXJ0eSA9PT0gMCA/IFwiY2xlYW5cIiA6IGAke2RpcnR5fSBjaGFuZ2VkYCxcbiAgICBjb25mbGljdHMgPiAwID8gYCR7Y29uZmxpY3RzfSBjb25mbGljdCR7cGx1cmFsKGNvbmZsaWN0cyl9YCA6IFwiXCIsXG4gICAgc3luYy50aXRsZSxcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiwgXCIpO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IFticmFuY2gsIGRpcnR5ID4gMCA/IFN0cmluZyhkaXJ0eSkgOiBcIlwiLCBzeW5jLnNob3J0XS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZUJhZGdlKHJvdzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGV4aXN0aW5nID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KGBbJHtCQURHRV9BVFRSfV1gKTtcbiAgaWYgKGV4aXN0aW5nKSByZXR1cm4gZXhpc3Rpbmc7XG5cbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2Uuc2V0QXR0cmlidXRlKEJBREdFX0FUVFIsIFwiXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ2l0LXByb2plY3QtYmFkZ2VcIjtcbiAgcm93LmFwcGVuZENoaWxkKGJhZGdlKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiByZW5kZXJTdW1tYXJ5UGFuZWwocHJvamVjdDogUHJvamVjdFJvdywgc3RhdHVzOiBHaXRTdGF0dXMgfCBudWxsLCBkZXRhaWxzOiBHaXREZXRhaWxzIHwgbnVsbCk6IHZvaWQge1xuICBpZiAoIWlzVXNhYmxlUmVwbyhzdGF0dXMpKSB7XG4gICAgcmVtb3ZlU3VtbWFyeVBhbmVsKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaG9zdCA9IHByb2plY3QuZ3JvdXAgPz8gcHJvamVjdC5yb3cucGFyZW50RWxlbWVudDtcbiAgaWYgKCFob3N0KSByZXR1cm47XG5cbiAgY29uc3QgcGFuZWwgPSBlbnN1cmVTdW1tYXJ5UGFuZWwoaG9zdCwgcHJvamVjdC5yb3cpO1xuICBjbGVhcihwYW5lbCk7XG5cbiAgY29uc3QgZGlydHkgPSBjb3VudERpcnR5KHN0YXR1cy5lbnRyaWVzKTtcbiAgY29uc3QgY291bnRzID0gY291bnRTdGF0dXMoc3RhdHVzLmVudHJpZXMpO1xuICBjb25zdCBicmFuY2ggPSBicmFuY2hMYWJlbChzdGF0dXMpO1xuICBjb25zdCBzeW5jID0gc3luY0xhYmVsKHN0YXR1cyk7XG4gIGNvbnN0IGRpZmYgPSBkZXRhaWxzPy5kaWZmID8/IG51bGw7XG4gIGNvbnN0IHdvcmt0cmVlcyA9IGRldGFpbHM/Lndvcmt0cmVlcyA/PyBbXTtcblxuICBjb25zdCBoZWFkZXIgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LXN1bW1hcnktaGVhZGVyXCIpO1xuICBjb25zdCB0aXRsZSA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtc3VtbWFyeS10aXRsZVwiKTtcbiAgdGl0bGUuYXBwZW5kKHRleHRFbChcInNwYW5cIiwgXCJHaXRcIikpO1xuICB0aXRsZS5hcHBlbmQodGV4dEVsKFwic3Ryb25nXCIsIGJyYW5jaCkpO1xuICBpZiAoc3luYy5zaG9ydCkgdGl0bGUuYXBwZW5kKHRleHRFbChcInNwYW5cIiwgc3luYy5zaG9ydCkpO1xuICBjb25zdCBzdGF0ZUNoaXAgPSB0ZXh0RWwoXCJzcGFuXCIsIGRpcnR5ID09PSAwID8gXCJjbGVhblwiIDogYCR7ZGlydHl9IGNoYW5nZWRgKTtcbiAgc3RhdGVDaGlwLmNsYXNzTmFtZSA9IGBjb2RleHBwLWdpdC1zdW1tYXJ5LXN0YXRlICR7ZGlydHkgPT09IDAgPyBcImlzLWNsZWFuXCIgOiBcImlzLWRpcnR5XCJ9YDtcbiAgaGVhZGVyLmFwcGVuZCh0aXRsZSwgc3RhdGVDaGlwKTtcbiAgcGFuZWwuYXBwZW5kKGhlYWRlcik7XG5cbiAgY29uc3QgbWV0cmljcyA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtc3VtbWFyeS1tZXRyaWNzXCIpO1xuICBtZXRyaWNzLmFwcGVuZChcbiAgICBtZXRyaWMoXCJzdGFnZWRcIiwgY291bnRzLnN0YWdlZCksXG4gICAgbWV0cmljKFwidW5zdGFnZWRcIiwgY291bnRzLnVuc3RhZ2VkKSxcbiAgICBtZXRyaWMoXCJ1bnRyYWNrZWRcIiwgY291bnRzLnVudHJhY2tlZCksXG4gICAgbWV0cmljKFwiY29uZmxpY3RzXCIsIGNvdW50cy5jb25mbGljdHMpLFxuICApO1xuICBwYW5lbC5hcHBlbmQobWV0cmljcyk7XG5cbiAgaWYgKGRpZmYpIHtcbiAgICBjb25zdCBkaWZmTGluZSA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtc3VtbWFyeS1saW5lXCIpO1xuICAgIGRpZmZMaW5lLmFwcGVuZChcbiAgICAgIHRleHRFbChcInNwYW5cIiwgYCR7ZGlmZi5maWxlQ291bnR9IGZpbGUke3BsdXJhbChkaWZmLmZpbGVDb3VudCl9YCksXG4gICAgICB0ZXh0RWwoXCJzcGFuXCIsIGArJHtkaWZmLmluc2VydGlvbnN9YCksXG4gICAgICB0ZXh0RWwoXCJzcGFuXCIsIGAtJHtkaWZmLmRlbGV0aW9uc31gKSxcbiAgICAgIC4uLihkaWZmLnRydW5jYXRlZCA/IFt0ZXh0RWwoXCJzcGFuXCIsIFwidHJ1bmNhdGVkXCIpXSA6IFtdKSxcbiAgICApO1xuICAgIHBhbmVsLmFwcGVuZChkaWZmTGluZSk7XG4gIH1cblxuICBjb25zdCBjaGFuZ2VkID0gc3RhdHVzLmVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkua2luZCAhPT0gXCJpZ25vcmVkXCIpLnNsaWNlKDAsIE1BWF9DSEFOR0VEX0ZJTEVTKTtcbiAgaWYgKGNoYW5nZWQubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGxpc3QgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LWNoYW5nZWQtZmlsZXNcIik7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBjaGFuZ2VkKSB7XG4gICAgICBjb25zdCByb3cgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LWZpbGUtcm93XCIpO1xuICAgICAgcm93LmFwcGVuZCh0ZXh0RWwoXCJzcGFuXCIsIGVudHJ5TGFiZWwoZW50cnkpKSwgdGV4dEVsKFwic3BhblwiLCBlbnRyeVBhdGgoZW50cnkpKSk7XG4gICAgICBsaXN0LmFwcGVuZChyb3cpO1xuICAgIH1cbiAgICBpZiAoc3RhdHVzLmVudHJpZXMubGVuZ3RoID4gY2hhbmdlZC5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IG1vcmUgPSB0ZXh0RWwoXCJkaXZcIiwgYCske3N0YXR1cy5lbnRyaWVzLmxlbmd0aCAtIGNoYW5nZWQubGVuZ3RofSBtb3JlYCk7XG4gICAgICBtb3JlLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1naXQtbW9yZVwiO1xuICAgICAgbGlzdC5hcHBlbmQobW9yZSk7XG4gICAgfVxuICAgIHBhbmVsLmFwcGVuZChsaXN0KTtcbiAgfVxuXG4gIGlmICh3b3JrdHJlZXMubGVuZ3RoID4gMSkge1xuICAgIGNvbnN0IHdvcmt0cmVlTGlzdCA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtd29ya3RyZWVzXCIpO1xuICAgIGNvbnN0IGxhYmVsID0gdGV4dEVsKFwiZGl2XCIsIGAke3dvcmt0cmVlcy5sZW5ndGh9IHdvcmt0cmVlc2ApO1xuICAgIGxhYmVsLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1naXQtd29ya3RyZWVzLWxhYmVsXCI7XG4gICAgd29ya3RyZWVMaXN0LmFwcGVuZChsYWJlbCk7XG4gICAgZm9yIChjb25zdCB3b3JrdHJlZSBvZiB3b3JrdHJlZXMuc2xpY2UoMCwgTUFYX1dPUktUUkVFX1JPV1MpKSB7XG4gICAgICBjb25zdCByb3cgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvd1wiKTtcbiAgICAgIHJvdy5hcHBlbmQoXG4gICAgICAgIHRleHRFbChcInNwYW5cIiwgd29ya3RyZWUuYnJhbmNoID8/IHNob3J0U2hhKHdvcmt0cmVlLmhlYWQpID8/IFwiZGV0YWNoZWRcIiksXG4gICAgICAgIHRleHRFbChcInNwYW5cIiwgYmFzZW5hbWUod29ya3RyZWUucGF0aCkpLFxuICAgICAgKTtcbiAgICAgIHdvcmt0cmVlTGlzdC5hcHBlbmQocm93KTtcbiAgICB9XG4gICAgcGFuZWwuYXBwZW5kKHdvcmt0cmVlTGlzdCk7XG4gIH1cblxuICBjb25zdCBpc3N1ZSA9IHN0YXR1cy5yZXBvc2l0b3J5LmVycm9yPy5tZXNzYWdlIHx8IHN0YXRlLnN0YXR1c0NhY2hlLmdldChwcm9qZWN0LnBhdGgpPy5lcnJvciB8fCBzdGF0ZS5kZXRhaWxzQ2FjaGUuZ2V0KHByb2plY3QucGF0aCk/LmVycm9yO1xuICBpZiAoaXNzdWUpIHtcbiAgICBjb25zdCB3YXJuaW5nID0gdGV4dEVsKFwiZGl2XCIsIGlzc3VlKTtcbiAgICB3YXJuaW5nLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1naXQtd2FybmluZ1wiO1xuICAgIHBhbmVsLmFwcGVuZCh3YXJuaW5nKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc1VzYWJsZVJlcG8oc3RhdHVzOiBHaXRTdGF0dXMgfCBudWxsKTogc3RhdHVzIGlzIEdpdFN0YXR1cyB7XG4gIHJldHVybiBCb29sZWFuKHN0YXR1cz8ucmVwb3NpdG9yeS5mb3VuZCAmJiBzdGF0dXMucmVwb3NpdG9yeS5pc0luc2lkZVdvcmtUcmVlKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlU3VtbWFyeVBhbmVsKGhvc3Q6IEhUTUxFbGVtZW50LCByb3c6IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQge1xuICBsZXQgcGFuZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihgWyR7U1VNTUFSWV9BVFRSfV1gKTtcbiAgaWYgKCFwYW5lbCkge1xuICAgIHBhbmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gICAgcGFuZWwuc2V0QXR0cmlidXRlKFNVTU1BUllfQVRUUiwgXCJcIik7XG4gICAgcGFuZWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdpdC1zdW1tYXJ5XCI7XG4gIH1cblxuICBpZiAocGFuZWwucGFyZW50RWxlbWVudCAhPT0gaG9zdCkge1xuICAgIHBhbmVsLnJlbW92ZSgpO1xuICAgIGhvc3QuaW5zZXJ0QmVmb3JlKHBhbmVsLCByb3cubmV4dEVsZW1lbnRTaWJsaW5nKTtcbiAgfSBlbHNlIGlmIChwYW5lbC5wcmV2aW91c0VsZW1lbnRTaWJsaW5nICE9PSByb3cpIHtcbiAgICBob3N0Lmluc2VydEJlZm9yZShwYW5lbCwgcm93Lm5leHRFbGVtZW50U2libGluZyk7XG4gIH1cblxuICByZXR1cm4gcGFuZWw7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZVN1bW1hcnlQYW5lbCgpOiB2b2lkIHtcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcihgWyR7U1VNTUFSWV9BVFRSfV1gKT8ucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIGNvdW50U3RhdHVzKGVudHJpZXM6IEdpdFN0YXR1c0VudHJ5W10pOiB7XG4gIHN0YWdlZDogbnVtYmVyO1xuICB1bnN0YWdlZDogbnVtYmVyO1xuICB1bnRyYWNrZWQ6IG51bWJlcjtcbiAgY29uZmxpY3RzOiBudW1iZXI7XG59IHtcbiAgbGV0IHN0YWdlZCA9IDA7XG4gIGxldCB1bnN0YWdlZCA9IDA7XG4gIGxldCB1bnRyYWNrZWQgPSAwO1xuICBsZXQgY29uZmxpY3RzID0gMDtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgc3dpdGNoIChlbnRyeS5raW5kKSB7XG4gICAgICBjYXNlIFwib3JkaW5hcnlcIjpcbiAgICAgIGNhc2UgXCJyZW5hbWVcIjpcbiAgICAgICAgaWYgKGVudHJ5LmluZGV4ICE9PSBcIi5cIikgc3RhZ2VkKys7XG4gICAgICAgIGlmIChlbnRyeS53b3JrdHJlZSAhPT0gXCIuXCIpIHVuc3RhZ2VkKys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInVudHJhY2tlZFwiOlxuICAgICAgICB1bnRyYWNrZWQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidW5tZXJnZWRcIjpcbiAgICAgICAgY29uZmxpY3RzKys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImlnbm9yZWRcIjpcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IHN0YWdlZCwgdW5zdGFnZWQsIHVudHJhY2tlZCwgY29uZmxpY3RzIH07XG59XG5cbmZ1bmN0aW9uIGNvdW50RGlydHkoZW50cmllczogR2l0U3RhdHVzRW50cnlbXSk6IG51bWJlciB7XG4gIHJldHVybiBlbnRyaWVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LmtpbmQgIT09IFwiaWdub3JlZFwiKS5sZW5ndGg7XG59XG5cbmZ1bmN0aW9uIGNvdW50Q29uZmxpY3RzKGVudHJpZXM6IEdpdFN0YXR1c0VudHJ5W10pOiBudW1iZXIge1xuICByZXR1cm4gZW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5raW5kID09PSBcInVubWVyZ2VkXCIpLmxlbmd0aDtcbn1cblxuZnVuY3Rpb24gYnJhbmNoTGFiZWwoc3RhdHVzOiBHaXRTdGF0dXMpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgIHN0YXR1cy5icmFuY2guaGVhZCA/P1xuICAgIHN0YXR1cy5yZXBvc2l0b3J5LmhlYWRCcmFuY2ggPz9cbiAgICBzaG9ydFNoYShzdGF0dXMuYnJhbmNoLm9pZCkgPz9cbiAgICBzaG9ydFNoYShzdGF0dXMucmVwb3NpdG9yeS5oZWFkU2hhKSA/P1xuICAgIFwiZGV0YWNoZWRcIlxuICApO1xufVxuXG5mdW5jdGlvbiBzeW5jTGFiZWwoc3RhdHVzOiBHaXRTdGF0dXMpOiB7IHNob3J0OiBzdHJpbmc7IHRpdGxlOiBzdHJpbmcgfSB7XG4gIGNvbnN0IGFoZWFkID0gc3RhdHVzLmJyYW5jaC5haGVhZCA/PyAwO1xuICBjb25zdCBiZWhpbmQgPSBzdGF0dXMuYnJhbmNoLmJlaGluZCA/PyAwO1xuICBjb25zdCBzaG9ydCA9IFthaGVhZCA+IDAgPyBgQSR7YWhlYWR9YCA6IFwiXCIsIGJlaGluZCA+IDAgPyBgQiR7YmVoaW5kfWAgOiBcIlwiXVxuICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAuam9pbihcIi9cIik7XG4gIGNvbnN0IHRpdGxlID0gW1xuICAgIGFoZWFkID4gMCA/IGAke2FoZWFkfSBhaGVhZGAgOiBcIlwiLFxuICAgIGJlaGluZCA+IDAgPyBgJHtiZWhpbmR9IGJlaGluZGAgOiBcIlwiLFxuICAgIHN0YXR1cy5icmFuY2gudXBzdHJlYW0gPyBgdXBzdHJlYW0gJHtzdGF0dXMuYnJhbmNoLnVwc3RyZWFtfWAgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiLCBcIik7XG4gIHJldHVybiB7IHNob3J0LCB0aXRsZSB9O1xufVxuXG5mdW5jdGlvbiBlbnRyeUxhYmVsKGVudHJ5OiBHaXRTdGF0dXNFbnRyeSk6IHN0cmluZyB7XG4gIHN3aXRjaCAoZW50cnkua2luZCkge1xuICAgIGNhc2UgXCJvcmRpbmFyeVwiOlxuICAgICAgcmV0dXJuIGAke2VudHJ5LmluZGV4fSR7ZW50cnkud29ya3RyZWV9YC5yZXBsYWNlQWxsKFwiLlwiLCBcIlwiKTtcbiAgICBjYXNlIFwicmVuYW1lXCI6XG4gICAgICByZXR1cm4gXCJSXCI7XG4gICAgY2FzZSBcInVubWVyZ2VkXCI6XG4gICAgICByZXR1cm4gXCJVVVwiO1xuICAgIGNhc2UgXCJ1bnRyYWNrZWRcIjpcbiAgICAgIHJldHVybiBcIj8/XCI7XG4gICAgY2FzZSBcImlnbm9yZWRcIjpcbiAgICAgIHJldHVybiBcIiEhXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW50cnlQYXRoKGVudHJ5OiBHaXRTdGF0dXNFbnRyeSk6IHN0cmluZyB7XG4gIGlmIChlbnRyeS5raW5kID09PSBcInJlbmFtZVwiKSByZXR1cm4gYCR7ZW50cnkub3JpZ2luYWxQYXRofSAtPiAke2VudHJ5LnBhdGh9YDtcbiAgcmV0dXJuIGVudHJ5LnBhdGg7XG59XG5cbmZ1bmN0aW9uIG1ldHJpYyhsYWJlbDogc3RyaW5nLCB2YWx1ZTogbnVtYmVyKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBpdGVtID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC1tZXRyaWNcIik7XG4gIGl0ZW0uYXBwZW5kKHRleHRFbChcInNwYW5cIiwgU3RyaW5nKHZhbHVlKSksIHRleHRFbChcInNwYW5cIiwgbGFiZWwpKTtcbiAgcmV0dXJuIGl0ZW07XG59XG5cbmZ1bmN0aW9uIHNob3J0U2hhKHNoYTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gc2hhID8gc2hhLnNsaWNlKDAsIDcpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gYmFzZW5hbWUocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IHBhdGgucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgY29uc3QgaWR4ID0gdHJpbW1lZC5sYXN0SW5kZXhPZihcIi9cIik7XG4gIHJldHVybiBpZHggPj0gMCA/IHRyaW1tZWQuc2xpY2UoaWR4ICsgMSkgOiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBwbHVyYWwoY291bnQ6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBjb3VudCA9PT0gMSA/IFwiXCIgOiBcInNcIjtcbn1cblxuZnVuY3Rpb24gY2xlYXIobm9kZTogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgd2hpbGUgKG5vZGUuZmlyc3RDaGlsZCkgbm9kZS5maXJzdENoaWxkLnJlbW92ZSgpO1xufVxuXG5mdW5jdGlvbiBlbCh0YWc6IFwiZGl2XCIgfCBcInNlY3Rpb25cIiwgY2xhc3NOYW1lOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IG5vZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7XG4gIG5vZGUuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICByZXR1cm4gbm9kZTtcbn1cblxuZnVuY3Rpb24gdGV4dEVsKHRhZzogXCJkaXZcIiB8IFwic3BhblwiIHwgXCJzdHJvbmdcIiwgdGV4dDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBub2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICBub2RlLnRleHRDb250ZW50ID0gdGV4dDtcbiAgcmV0dXJuIG5vZGU7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxTdHlsZXMoKTogdm9pZCB7XG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChTVFlMRV9JRCkpIHJldHVybjtcbiAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3R5bGVcIik7XG4gIHN0eWxlLmlkID0gU1RZTEVfSUQ7XG4gIHN0eWxlLnRleHRDb250ZW50ID0gYFxuICAgIC5jb2RleHBwLWdpdC1wcm9qZWN0LWJhZGdlIHtcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICBib3JkZXI6IDFweCBzb2xpZCBjb2xvci1taXgoaW4gc3JnYiwgY3VycmVudENvbG9yIDE4JSwgdHJhbnNwYXJlbnQpO1xuICAgICAgYm9yZGVyLXJhZGl1czogNXB4O1xuICAgICAgY29sb3I6IHZhcigtLXRleHQtdGVydGlhcnksIGN1cnJlbnRDb2xvcik7XG4gICAgICBkaXNwbGF5OiBpbmxpbmUtZmxleDtcbiAgICAgIGZsZXg6IDAgMSBhdXRvO1xuICAgICAgZm9udDogNTAwIDEwcHgvMS4yIHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlO1xuICAgICAgZ2FwOiAzcHg7XG4gICAgICBsZXR0ZXItc3BhY2luZzogMDtcbiAgICAgIG1hcmdpbi1sZWZ0OiA2cHg7XG4gICAgICBtYXgtd2lkdGg6IDQ4JTtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICAgIG9wYWNpdHk6IDAuNzI7XG4gICAgICBvdmVyZmxvdzogaGlkZGVuO1xuICAgICAgcGFkZGluZzogMnB4IDRweDtcbiAgICAgIHBvaW50ZXItZXZlbnRzOiBub25lO1xuICAgICAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG4gICAgICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtcHJvamVjdC1iYWRnZS5jb2RleHBwLWdpdC1iYWRnZS1kaXJ0eSB7XG4gICAgICBib3JkZXItY29sb3I6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jb2RleHBwLXByb2plY3QtdGludCwgY3VycmVudENvbG9yKSA0MiUsIHRyYW5zcGFyZW50KTtcbiAgICAgIGNvbG9yOiB2YXIoLS1jb2RleHBwLXByb2plY3QtdGV4dC1jb2xvciwgY3VycmVudENvbG9yKTtcbiAgICAgIG9wYWNpdHk6IDAuOTQ7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1wcm9qZWN0LWJhZGdlLmNvZGV4cHAtZ2l0LWJhZGdlLWNvbmZsaWN0IHtcbiAgICAgIGJvcmRlci1jb2xvcjogcmdiYSgyMjAsIDM4LCAzOCwgMC42NSk7XG4gICAgICBjb2xvcjogcmdiKDIyMCwgMzgsIDM4KTtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnkge1xuICAgICAgYm9yZGVyLWxlZnQ6IDJweCBzb2xpZCB2YXIoLS1jb2RleHBwLXByb2plY3QtdGludCwgY29sb3ItbWl4KGluIHNyZ2IsIGN1cnJlbnRDb2xvciA0MCUsIHRyYW5zcGFyZW50KSk7XG4gICAgICBib3gtc2l6aW5nOiBib3JkZXItYm94O1xuICAgICAgY29sb3I6IHZhcigtLXRleHQtcHJpbWFyeSwgY3VycmVudENvbG9yKTtcbiAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICAgICAgZ2FwOiA2cHg7XG4gICAgICBtYXJnaW46IDFweCA4cHggN3B4IDE4cHg7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgICBwYWRkaW5nOiA3cHggOHB4IDhweCA4cHg7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LWhlYWRlcixcbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1saW5lLFxuICAgIC5jb2RleHBwLWdpdC1maWxlLXJvdyxcbiAgICAuY29kZXhwcC1naXQtd29ya3RyZWUtcm93IHtcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgZ2FwOiA2cHg7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LWhlYWRlciB7XG4gICAgICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXRpdGxlIHtcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgZ2FwOiA1cHg7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXRpdGxlIHNwYW46Zmlyc3QtY2hpbGQsXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlcy1sYWJlbCB7XG4gICAgICBjb2xvcjogdmFyKC0tdGV4dC10ZXJ0aWFyeSwgY3VycmVudENvbG9yKTtcbiAgICAgIGZvbnQ6IDYwMCAxMHB4LzEuMiBzeXN0ZW0tdWksIC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgc2Fucy1zZXJpZjtcbiAgICAgIG9wYWNpdHk6IDAuNztcbiAgICAgIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXRpdGxlIHN0cm9uZyB7XG4gICAgICBmb250OiA2MDAgMTJweC8xLjI1IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlO1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgICAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgICAgIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktc3RhdGUge1xuICAgICAgYm9yZGVyLXJhZGl1czogNXB4O1xuICAgICAgZmxleDogMCAwIGF1dG87XG4gICAgICBmb250OiA2MDAgMTBweC8xLjIgc3lzdGVtLXVpLCAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIHNhbnMtc2VyaWY7XG4gICAgICBwYWRkaW5nOiAycHggNXB4O1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1zdGF0ZS5pcy1jbGVhbiB7XG4gICAgICBiYWNrZ3JvdW5kOiByZ2JhKDM0LCAxOTcsIDk0LCAwLjEyKTtcbiAgICAgIGNvbG9yOiByZ2IoMjIsIDE2MywgNzQpO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1zdGF0ZS5pcy1kaXJ0eSB7XG4gICAgICBiYWNrZ3JvdW5kOiByZ2JhKDI0NSwgMTU4LCAxMSwgMC4xMik7XG4gICAgICBjb2xvcjogcmdiKDE4MCwgODMsIDkpO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1tZXRyaWNzIHtcbiAgICAgIGRpc3BsYXk6IGdyaWQ7XG4gICAgICBnYXA6IDRweDtcbiAgICAgIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDQsIG1pbm1heCgwLCAxZnIpKTtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LW1ldHJpYyB7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1tZXRyaWMgc3BhbjpmaXJzdC1jaGlsZCB7XG4gICAgICBkaXNwbGF5OiBibG9jaztcbiAgICAgIGZvbnQ6IDYwMCAxMnB4LzEuMTUgdWktbW9ub3NwYWNlLCBTRk1vbm8tUmVndWxhciwgTWVubG8sIENvbnNvbGFzLCBtb25vc3BhY2U7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1tZXRyaWMgc3BhbjpsYXN0LWNoaWxkLFxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LWxpbmUsXG4gICAgLmNvZGV4cHAtZ2l0LW1vcmUsXG4gICAgLmNvZGV4cHAtZ2l0LXdhcm5pbmcge1xuICAgICAgY29sb3I6IHZhcigtLXRleHQtdGVydGlhcnksIGN1cnJlbnRDb2xvcik7XG4gICAgICBmb250OiA1MDAgMTBweC8xLjI1IHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmO1xuICAgICAgb3BhY2l0eTogMC43NDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LWNoYW5nZWQtZmlsZXMsXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlcyB7XG4gICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgICAgIGdhcDogM3B4O1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtZmlsZS1yb3csXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvdyB7XG4gICAgICBjb2xvcjogdmFyKC0tdGV4dC1zZWNvbmRhcnksIGN1cnJlbnRDb2xvcik7XG4gICAgICBmb250OiA1MDAgMTFweC8xLjI1IHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtZmlsZS1yb3cgc3BhbjpmaXJzdC1jaGlsZCB7XG4gICAgICBjb2xvcjogdmFyKC0tY29kZXhwcC1wcm9qZWN0LXRleHQtY29sb3IsIGN1cnJlbnRDb2xvcik7XG4gICAgICBmbGV4OiAwIDAgMjRweDtcbiAgICAgIGZvbnQ6IDYwMCAxMHB4LzEuMiB1aS1tb25vc3BhY2UsIFNGTW9uby1SZWd1bGFyLCBNZW5sbywgQ29uc29sYXMsIG1vbm9zcGFjZTtcbiAgICAgIG9wYWNpdHk6IDAuODg7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1maWxlLXJvdyBzcGFuOmxhc3QtY2hpbGQsXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvdyBzcGFuOmxhc3QtY2hpbGQge1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgICAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgICAgIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvdyB7XG4gICAgICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC13b3JrdHJlZS1yb3cgc3BhbjpmaXJzdC1jaGlsZCB7XG4gICAgICBmb250OiA1MDAgMTBweC8xLjI1IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlO1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgICAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgICAgIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICB9XG4gIGA7XG4gIGRvY3VtZW50LmhlYWQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBV0EsSUFBQUEsbUJBQTRCOzs7QUM2QnJCLFNBQVMsbUJBQXlCO0FBQ3ZDLE1BQUksT0FBTywrQkFBZ0M7QUFDM0MsUUFBTSxZQUFZLG9CQUFJLElBQStCO0FBQ3JELE1BQUksU0FBUztBQUNiLFFBQU0sWUFBWSxvQkFBSSxJQUE0QztBQUVsRSxRQUFNLE9BQTBCO0FBQUEsSUFDOUIsZUFBZTtB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QUFTQyxpQkFBc0I7QUFDN0IsTUFBSSxTQUFTLGVBQWUsUUFBUSxFQUFHO0FBQ3ZDLFFBQU0sUUFBUSxTQUFTLGNBQWMsT0FBTztBQUM1QyxRQUFNLEtBQUs7QUFDWCxRQUFNLGNBQWM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQStJcEIsV0FBUyxLQUFLLFlBQVksS0FBSztBQUNqQzs7O0FQNXFCQSxTQUFTLFFBQVEsT0FBZSxPQUF1QjtBQUNyRCxRQUFNLE1BQU0sNEJBQTRCLEtBQUssR0FDM0MsVUFBVSxTQUFZLEtBQUssTUFBTUUsZUFBYyxLQUFLLENBQ3REO0FBQ0EsTUFBSTtBQUNGLFlBQVEsTUFBTSxHQUFHO0FBQUEsRUFDbkIsUUFBUTtBQUFBLEVBQUM7QUFDVCxNQUFJO0FBQ0YsaUNBQVksS0FBSyx1QkFBdUIsUUFBUSxHQUFHO0FBQUEsRUFDckQsUUFBUTtBQUFBLEVBQUM7QUFDWDtBQUNBLFNBQVNBLGVBQWMsR0FBb0I7QUFDekMsTUFBSTtBQUNGLFdBQU8sT0FBTyxNQUFNLFdBQVcsSUFBSSxLQUFLLFVBQVUsQ0FBQztBQUFBLEVBQ3JELFFBQVE7QUFDTixXQUFPLE9BQU8sQ0FBQztBQUFBLEVBQ2pCO0FBQ0Y7QUFFQSxRQUFRLGlCQUFpQixFQUFFLEtBQUssU0FBUyxLQUFLLENBQUM7QUFHL0MsSUFBSTtBQUNGLG1CQUFpQjtBQUNqQixVQUFRLHNCQUFzQjtBQUNoQyxTQUFTLEdBQUc7QUFDVixVQUFRLHFCQUFxQixPQUFPLENBQUMsQ0FBQztBQUN4QztBQUVBLElBQUk7QUFDRixtQkFBaUIsT0FBTztBQUMxQixTQUFTLEdBQUc7QUFDVixVQUFRLHVCQUF1QixPQUFPLENBQUMsQ0FBQztBQUMxQztBQUVBLGVBQWUsTUFBTTtBQUNuQixNQUFJLFNBQVMsZUFBZSxXQUFXO0FBQ3JDLGFBQVMsaUJBQWlCLG9CQUFvQixNQUFNLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUNwRSxPQUFPO0FBQ0wsU0FBSztBQUFBLEVBQ1A7QUFDRixDQUFDO0FBRUQsZUFBZSxPQUFPO0FBQ3BCLFVBQVEsY0FBYyxFQUFFLFlBQVksU0FBUyxXQUFXLENBQUM7QUFDekQsTUFBSTtBQUNGLDBCQUFzQjtBQUN0QixZQUFRLDJCQUEyQjtBQUNuQyxvQkFBZ0I7QUFDaEIsWUFBUSxxQkFBcUI7QUFDN0IsVUFBTSxlQUFlO0FBQ3JCLFlBQVEsb0JBQW9CO0FBQzVCLFVBQU0sYUFBYTtBQUNuQixZQUFRLGlCQUFpQjtBQUN6QixvQkFBZ0I7QUFDaEIsWUFBUSxlQUFlO0FBQUEsRUFDekIsU0FBUyxHQUFHO0FBQ1YsWUFBUSxlQUFlLE9BQVEsR0FBYSxTQUFTLENBQUMsQ0FBQztBQUN2RCxZQUFRLE1BQU0seUNBQXlDLENBQUM7QUFBQSxFQUMxRDtBQUNGO0FBSUEsSUFBSSxZQUFrQztBQUN0QyxTQUFTLGtCQUF3QjtBQUMvQiwrQkFBWSxHQUFHLDBCQUEwQixNQUFNO0FBQzdDLFFBQUksVUFBVztBQUNmLGlCQUFhLFlBQVk7QUFDdkIsVUFBSTtBQUNGLGdCQUFRLEtBQUssdUNBQXVDO0FBQ3BELDBCQUFrQjtBQUNsQixjQUFNLGVBQWU7QUFDckIsY0FBTSxhQUFhO0FBQUEsTUFDckIsU0FBUyxHQUFHO0FBQ1YsZ0JBQVEsTUFBTSx1Q0FBdUMsQ0FBQztBQUFBLE1BQ3hELFVBQUU7QUFDQSxvQkFBWTtBQUFBLE1BQ2Q7QUFBQSxJQUNGLEdBQUc7QUFBQSxFQUNMLENBQUM7QUFDSDsiLAogICJuYW1lcyI6IFsiaW1wb3J0X2VsZWN0cm9uIiwgInJvb3QiLCAicmVmcmVzaCIsICJjYXJkIiwgImVsIiwgImltcG9ydF9lbGVjdHJvbiIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJlbCIsICJpbXBvcnRfZWxlY3Ryb24iLCAicm9vdCIsICJpbXBvcnRfZWxlY3Ryb24iLCAiaXNSZWNvcmQiLCAicmVzcG9uc2UiLCAiZWwiLCAiYnV0dG9uIiwgImltcG9ydF9lbGVjdHJvbiIsICJzdGF0ZSIsICJpbnN0YWxsU3R5bGVzIiwgInN0YXR1cyIsICJzYWZlU3RyaW5naWZ5Il0KfQo=
