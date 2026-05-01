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
  const left = document.createElement("div");
  left.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "min-w-0 text-sm text-token-text-primary";
  title.textContent = titleText;
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.textContent = description;
  left.appendChild(title);
  left.appendChild(desc);
  row.appendChild(left);
  const actions = document.createElement("div");
  actions.dataset.codexppRowActions = "true";
  actions.className = "flex shrink-0 items-center gap-2";
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL21hbmFnZXIudHMiLCAiLi4vc3JjL3ByZWxvYWQvYXBwLXNlcnZlci1icmlkZ2UudHMiLCAiLi4vc3JjL3ByZWxvYWQvZ29hbC1mZWF0dXJlLnRzIiwgIi4uL3NyYy9wcmVsb2FkL2dpdC1zaWRlYmFyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlbmRlcmVyIHByZWxvYWQgZW50cnkuIFJ1bnMgaW4gYW4gaXNvbGF0ZWQgd29ybGQgYmVmb3JlIENvZGV4J3MgcGFnZSBKUy5cbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAgIDEuIEluc3RhbGwgYSBSZWFjdCBEZXZUb29scy1zaGFwZWQgZ2xvYmFsIGhvb2sgdG8gY2FwdHVyZSB0aGUgcmVuZGVyZXJcbiAqICAgICAgcmVmZXJlbmNlIHdoZW4gUmVhY3QgbW91bnRzLiBXZSB1c2UgdGhpcyBmb3IgZmliZXIgd2Fsa2luZy5cbiAqICAgMi4gQWZ0ZXIgRE9NQ29udGVudExvYWRlZCwga2ljayBvZmYgc2V0dGluZ3MtaW5qZWN0aW9uIGxvZ2ljLlxuICogICAzLiBEaXNjb3ZlciByZW5kZXJlci1zY29wZWQgdHdlYWtzICh2aWEgSVBDIHRvIG1haW4pIGFuZCBzdGFydCB0aGVtLlxuICogICA0LiBMaXN0ZW4gZm9yIGBjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkYCBmcm9tIG1haW4gKGZpbGVzeXN0ZW0gd2F0Y2hlcikgYW5kXG4gKiAgICAgIGhvdC1yZWxvYWQgdHdlYWtzIHdpdGhvdXQgZHJvcHBpbmcgdGhlIHBhZ2UuXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IGluc3RhbGxSZWFjdEhvb2sgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgeyBzdGFydFNldHRpbmdzSW5qZWN0b3IgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgc3RhcnRUd2Vha0hvc3QsIHRlYXJkb3duVHdlYWtIb3N0IH0gZnJvbSBcIi4vdHdlYWstaG9zdFwiO1xuaW1wb3J0IHsgbW91bnRNYW5hZ2VyIH0gZnJvbSBcIi4vbWFuYWdlclwiO1xuaW1wb3J0IHsgc3RhcnRHb2FsRmVhdHVyZSB9IGZyb20gXCIuL2dvYWwtZmVhdHVyZVwiO1xuaW1wb3J0IHsgc3RhcnRHaXRTaWRlYmFyIH0gZnJvbSBcIi4vZ2l0LXNpZGViYXJcIjtcblxuLy8gRmlsZS1sb2cgcHJlbG9hZCBwcm9ncmVzcyBzbyB3ZSBjYW4gZGlhZ25vc2Ugd2l0aG91dCBEZXZUb29scy4gQmVzdC1lZmZvcnQ6XG4vLyBmYWlsdXJlcyBoZXJlIG11c3QgbmV2ZXIgdGhyb3cgYmVjYXVzZSB3ZSdkIHRha2UgdGhlIHBhZ2UgZG93biB3aXRoIHVzLlxuLy9cbi8vIENvZGV4J3MgcmVuZGVyZXIgaXMgc2FuZGJveGVkIChzYW5kYm94OiB0cnVlKSwgc28gYHJlcXVpcmUoXCJub2RlOmZzXCIpYCBpc1xuLy8gdW5hdmFpbGFibGUuIFdlIGZvcndhcmQgbG9nIGxpbmVzIHRvIG1haW4gdmlhIElQQzsgbWFpbiB3cml0ZXMgdGhlIGZpbGUuXG5mdW5jdGlvbiBmaWxlTG9nKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBgW2NvZGV4LXBsdXNwbHVzIHByZWxvYWRdICR7c3RhZ2V9JHtcbiAgICBleHRyYSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IFwiIFwiICsgc2FmZVN0cmluZ2lmeShleHRyYSlcbiAgfWA7XG4gIHRyeSB7XG4gICAgY29uc29sZS5lcnJvcihtc2cpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChcImNvZGV4cHA6cHJlbG9hZC1sb2dcIiwgXCJpbmZvXCIsIG1zZyk7XG4gIH0gY2F0Y2gge31cbn1cbmZ1bmN0aW9uIHNhZmVTdHJpbmdpZnkodjogdW5rbm93bik6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gU3RyaW5nKHYpO1xuICB9XG59XG5cbmZpbGVMb2coXCJwcmVsb2FkIGVudHJ5XCIsIHsgdXJsOiBsb2NhdGlvbi5ocmVmIH0pO1xuXG4vLyBSZWFjdCBob29rIG11c3QgYmUgaW5zdGFsbGVkICpiZWZvcmUqIENvZGV4J3MgYnVuZGxlIHJ1bnMuXG50cnkge1xuICBpbnN0YWxsUmVhY3RIb29rKCk7XG4gIGZpbGVMb2coXCJyZWFjdCBob29rIGluc3RhbGxlZFwiKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnRyeSB7XG4gIHN0YXJ0R29hbEZlYXR1cmUoZmlsZUxvZyk7XG59IGNhdGNoIChlKSB7XG4gIGZpbGVMb2coXCJnb2FsIGZlYXR1cmUgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnF1ZXVlTWljcm90YXNrKCgpID0+IHtcbiAgaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09IFwibG9hZGluZ1wiKSB7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgYm9vdCwgeyBvbmNlOiB0cnVlIH0pO1xuICB9IGVsc2Uge1xuICAgIGJvb3QoKTtcbiAgfVxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7XG4gIGZpbGVMb2coXCJib290IHN0YXJ0XCIsIHsgcmVhZHlTdGF0ZTogZG9jdW1lbnQucmVhZHlTdGF0ZSB9KTtcbiAgdHJ5IHtcbiAgICBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTtcbiAgICBmaWxlTG9nKFwic2V0dGluZ3MgaW5qZWN0b3Igc3RhcnRlZFwiKTtcbiAgICBzdGFydEdpdFNpZGViYXIoKTtcbiAgICBmaWxlTG9nKFwiZ2l0IHNpZGViYXIgc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgIGZpbGVMb2coXCJ0d2VhayBob3N0IHN0YXJ0ZWRcIik7XG4gICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgZmlsZUxvZyhcIm1hbmFnZXIgbW91bnRlZFwiKTtcbiAgICBzdWJzY3JpYmVSZWxvYWQoKTtcbiAgICBmaWxlTG9nKFwiYm9vdCBjb21wbGV0ZVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZpbGVMb2coXCJib290IEZBSUxFRFwiLCBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSk7XG4gICAgY29uc29sZS5lcnJvcihcIltjb2RleC1wbHVzcGx1c10gcHJlbG9hZCBib290IGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gSG90IHJlbG9hZDogZ2F0ZWQgYmVoaW5kIGEgc21hbGwgaW4tZmxpZ2h0IGxvY2sgc28gYSBmbHVycnkgb2YgZnMgZXZlbnRzXG4vLyBkb2Vzbid0IHJlZW50cmFudGx5IHRlYXIgZG93biB0aGUgaG9zdCBtaWQtbG9hZC5cbmxldCByZWxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcbmZ1bmN0aW9uIHN1YnNjcmliZVJlbG9hZCgpOiB2b2lkIHtcbiAgaXBjUmVuZGVyZXIub24oXCJjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBpZiAocmVsb2FkaW5nKSByZXR1cm47XG4gICAgcmVsb2FkaW5nID0gKGFzeW5jICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUuaW5mbyhcIltjb2RleC1wbHVzcGx1c10gaG90LXJlbG9hZGluZyB0d2Vha3NcIik7XG4gICAgICAgIHRlYXJkb3duVHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IHN0YXJ0VHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IG1vdW50TWFuYWdlcigpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWxvYWRpbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gIH0pO1xufVxuIiwgIi8qKlxuICogSW5zdGFsbCBhIG1pbmltYWwgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fLiBSZWFjdCBjYWxsc1xuICogYGhvb2suaW5qZWN0KHJlbmRlcmVySW50ZXJuYWxzKWAgZHVyaW5nIGBjcmVhdGVSb290YC9gaHlkcmF0ZVJvb3RgLiBUaGVcbiAqIFwiaW50ZXJuYWxzXCIgb2JqZWN0IGV4cG9zZXMgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2UsIHdoaWNoIGxldHMgdXMgdHVybiBhXG4gKiBET00gbm9kZSBpbnRvIGEgUmVhY3QgZmliZXIgXHUyMDE0IG5lY2Vzc2FyeSBmb3Igb3VyIFNldHRpbmdzIGluamVjdG9yLlxuICpcbiAqIFdlIGRvbid0IHdhbnQgdG8gYnJlYWsgcmVhbCBSZWFjdCBEZXZUb29scyBpZiB0aGUgdXNlciBvcGVucyBpdDsgd2UgaW5zdGFsbFxuICogb25seSBpZiBubyBob29rIGV4aXN0cyB5ZXQsIGFuZCB3ZSBmb3J3YXJkIGNhbGxzIHRvIGEgZG93bnN0cmVhbSBob29rIGlmXG4gKiBvbmUgaXMgbGF0ZXIgYXNzaWduZWQuXG4gKi9cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fPzogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgX19jb2RleHBwX18/OiB7XG4gICAgICBob29rOiBSZWFjdERldnRvb2xzSG9vaztcbiAgICAgIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICAgIH07XG4gIH1cbn1cblxuaW50ZXJmYWNlIFJlbmRlcmVySW50ZXJuYWxzIHtcbiAgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2U/OiAobjogTm9kZSkgPT4gdW5rbm93bjtcbiAgdmVyc2lvbj86IHN0cmluZztcbiAgYnVuZGxlVHlwZT86IG51bWJlcjtcbiAgcmVuZGVyZXJQYWNrYWdlTmFtZT86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlYWN0RGV2dG9vbHNIb29rIHtcbiAgc3VwcG9ydHNGaWJlcjogdHJ1ZTtcbiAgcmVuZGVyZXJzOiBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz47XG4gIG9uKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgb2ZmKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgZW1pdChldmVudDogc3RyaW5nLCAuLi5hOiB1bmtub3duW10pOiB2b2lkO1xuICBpbmplY3QocmVuZGVyZXI6IFJlbmRlcmVySW50ZXJuYWxzKTogbnVtYmVyO1xuICBvblNjaGVkdWxlRmliZXJSb290PygpOiB2b2lkO1xuICBvbkNvbW1pdEZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclVubW91bnQ/KCk6IHZvaWQ7XG4gIGNoZWNrRENFPygpOiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFJlYWN0SG9vaygpOiB2b2lkIHtcbiAgaWYgKHdpbmRvdy5fX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18pIHJldHVybjtcbiAgY29uc3QgcmVuZGVyZXJzID0gbmV3IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPigpO1xuICBsZXQgbmV4dElkID0gMTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsIFNldDwoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkPj4oKTtcblxuICBjb25zdCBob29rOiBSZWFjdERldnRvb2xzSG9vayA9IHtcbiAgICBzdXBwb3J0c0ZpYmVyOiB0cnVlLFxuICAgIHJlbmRlcmVycyxcbiAgICBpbmplY3QocmVuZGVyZXIpIHtcbiAgICAgIGNvbnN0IGlkID0gbmV4dElkKys7XG4gICAgICByZW5kZXJlcnMuc2V0KGlkLCByZW5kZXJlcik7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS5kZWJ1ZyhcbiAgICAgICAgXCJbY29kZXgtcGx1c3BsdXNdIFJlYWN0IHJlbmRlcmVyIGF0dGFjaGVkOlwiLFxuICAgICAgICByZW5kZXJlci5yZW5kZXJlclBhY2thZ2VOYW1lLFxuICAgICAgICByZW5kZXJlci52ZXJzaW9uLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBpZDtcbiAgICB9LFxuICAgIG9uKGV2ZW50LCBmbikge1xuICAgICAgbGV0IHMgPSBsaXN0ZW5lcnMuZ2V0KGV2ZW50KTtcbiAgICAgIGlmICghcykgbGlzdGVuZXJzLnNldChldmVudCwgKHMgPSBuZXcgU2V0KCkpKTtcbiAgICAgIHMuYWRkKGZuKTtcbiAgICB9LFxuICAgIG9mZihldmVudCwgZm4pIHtcbiAgICAgIGxpc3RlbmVycy5nZXQoZXZlbnQpPy5kZWxldGUoZm4pO1xuICAgIH0sXG4gICAgZW1pdChldmVudCwgLi4uYXJncykge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmZvckVhY2goKGZuKSA9PiBmbiguLi5hcmdzKSk7XG4gICAgfSxcbiAgICBvbkNvbW1pdEZpYmVyUm9vdCgpIHt9LFxuICAgIG9uQ29tbWl0RmliZXJVbm1vdW50KCkge30sXG4gICAgb25TY2hlZHVsZUZpYmVyUm9vdCgpIHt9LFxuICAgIGNoZWNrRENFKCkge30sXG4gIH07XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX19cIiwge1xuICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICB3cml0YWJsZTogdHJ1ZSwgLy8gYWxsb3cgcmVhbCBEZXZUb29scyB0byBvdmVyd3JpdGUgaWYgdXNlciBpbnN0YWxscyBpdFxuICAgIHZhbHVlOiBob29rLFxuICB9KTtcblxuICB3aW5kb3cuX19jb2RleHBwX18gPSB7IGhvb2ssIHJlbmRlcmVycyB9O1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgUmVhY3QgZmliZXIgZm9yIGEgRE9NIG5vZGUsIGlmIGFueSByZW5kZXJlciBoYXMgb25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpYmVyRm9yTm9kZShub2RlOiBOb2RlKTogdW5rbm93biB8IG51bGwge1xuICBjb25zdCByZW5kZXJlcnMgPSB3aW5kb3cuX19jb2RleHBwX18/LnJlbmRlcmVycztcbiAgaWYgKHJlbmRlcmVycykge1xuICAgIGZvciAoY29uc3QgciBvZiByZW5kZXJlcnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGYgPSByLmZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPy4obm9kZSk7XG4gICAgICBpZiAoZikgcmV0dXJuIGY7XG4gICAgfVxuICB9XG4gIC8vIEZhbGxiYWNrOiByZWFkIHRoZSBSZWFjdCBpbnRlcm5hbCBwcm9wZXJ0eSBkaXJlY3RseSBmcm9tIHRoZSBET00gbm9kZS5cbiAgLy8gUmVhY3Qgc3RvcmVzIGZpYmVycyBhcyBhIHByb3BlcnR5IHdob3NlIGtleSBzdGFydHMgd2l0aCBcIl9fcmVhY3RGaWJlclwiLlxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICBpZiAoay5zdGFydHNXaXRoKFwiX19yZWFjdEZpYmVyXCIpKSByZXR1cm4gKG5vZGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba107XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG4iLCAiLyoqXG4gKiBTZXR0aW5ncyBpbmplY3RvciBmb3IgQ29kZXgncyBTZXR0aW5ncyBwYWdlLlxuICpcbiAqIENvZGV4J3Mgc2V0dGluZ3MgaXMgYSByb3V0ZWQgcGFnZSAoVVJMIHN0YXlzIGF0IGAvaW5kZXguaHRtbD9ob3N0SWQ9bG9jYWxgKVxuICogTk9UIGEgbW9kYWwgZGlhbG9nLiBUaGUgc2lkZWJhciBsaXZlcyBpbnNpZGUgYSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC0xIGdhcC0wXCI+YCB3cmFwcGVyIHRoYXQgaG9sZHMgb25lIG9yIG1vcmUgYDxkaXYgY2xhc3M9XCJmbGV4IGZsZXgtY29sXG4gKiBnYXAtcHhcIj5gIGdyb3VwcyBvZiBidXR0b25zLiBUaGVyZSBhcmUgbm8gc3RhYmxlIGByb2xlYCAvIGBhcmlhLWxhYmVsYCAvXG4gKiBgZGF0YS10ZXN0aWRgIGhvb2tzIG9uIHRoZSBzaGVsbCBzbyB3ZSBpZGVudGlmeSB0aGUgc2lkZWJhciBieSB0ZXh0LWNvbnRlbnRcbiAqIG1hdGNoIGFnYWluc3Qga25vd24gaXRlbSBsYWJlbHMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIENvbmZpZ3VyYXRpb24sIFx1MjAyNikuXG4gKlxuICogTGF5b3V0IHdlIGluamVjdDpcbiAqXG4gKiAgIEdFTkVSQUwgICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFtDb2RleCdzIGV4aXN0aW5nIGl0ZW1zIGdyb3VwXVxuICogICBDT0RFWCsrICAgICAgICAgICAgICAgICAgICAgICAodXBwZXJjYXNlIGdyb3VwIGxhYmVsKVxuICogICBcdTI0RDggQ29uZmlnXG4gKiAgIFx1MjYzMCBUd2Vha3NcbiAqXG4gKiBDbGlja2luZyBDb25maWcgLyBUd2Vha3MgaGlkZXMgQ29kZXgncyBjb250ZW50IHBhbmVsIGNoaWxkcmVuIGFuZCByZW5kZXJzXG4gKiBvdXIgb3duIGBtYWluLXN1cmZhY2VgIHBhbmVsIGluIHRoZWlyIHBsYWNlLiBDbGlja2luZyBhbnkgb2YgQ29kZXgnc1xuICogc2lkZWJhciBpdGVtcyByZXN0b3JlcyB0aGUgb3JpZ2luYWwgdmlldy5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHR5cGUge1xuICBTZXR0aW5nc1NlY3Rpb24sXG4gIFNldHRpbmdzUGFnZSxcbiAgU2V0dGluZ3NIYW5kbGUsXG4gIFR3ZWFrTWFuaWZlc3QsXG59IGZyb20gXCJAY29kZXgtcGx1c3BsdXMvc2RrXCI7XG5cbi8vIE1pcnJvcnMgdGhlIHJ1bnRpbWUncyBtYWluLXNpZGUgTGlzdGVkVHdlYWsgc2hhcGUgKGtlcHQgaW4gc3luYyBtYW51YWxseSkuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICB1cGRhdGU6IFR3ZWFrVXBkYXRlQ2hlY2sgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtVcGRhdGVDaGVjayB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICByZXBvOiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdFRhZzogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvZGV4UGx1c1BsdXNDb25maWcge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGF1dG9VcGRhdGU6IGJvb2xlYW47XG4gIHVwZGF0ZUNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VOb3Rlczogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvZGV4Q2RwU3RhdHVzIHtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgYWN0aXZlOiBib29sZWFuO1xuICBjb25maWd1cmVkUG9ydDogbnVtYmVyO1xuICBhY3RpdmVQb3J0OiBudW1iZXIgfCBudWxsO1xuICByZXN0YXJ0UmVxdWlyZWQ6IGJvb2xlYW47XG4gIHNvdXJjZTogXCJhcmd2XCIgfCBcImVudlwiIHwgXCJjb25maWdcIiB8IFwib2ZmXCI7XG4gIGpzb25MaXN0VXJsOiBzdHJpbmcgfCBudWxsO1xuICBqc29uVmVyc2lvblVybDogc3RyaW5nIHwgbnVsbDtcbiAgbGF1bmNoQ29tbWFuZDogc3RyaW5nO1xuICBhcHBSb290OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgV2F0Y2hlckhlYWx0aCB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHdhdGNoZXI6IHN0cmluZztcbiAgY2hlY2tzOiBXYXRjaGVySGVhbHRoQ2hlY2tbXTtcbn1cblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGhDaGVjayB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBQYXRjaE1hbmFnZXJTdGF0dXMge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgY3VycmVudENoYW5uZWw6IFwic3RhYmxlXCIgfCBcImJldGFcIiB8IFwidW5rbm93blwiO1xuICBjdXJyZW50VXNlclJvb3Q6IHN0cmluZztcbiAgY2hhbm5lbHM6IFBhdGNoQ2hhbm5lbFN0YXR1c1tdO1xufVxuXG5pbnRlcmZhY2UgUGF0Y2hDaGFubmVsU3RhdHVzIHtcbiAgY2hhbm5lbDogXCJzdGFibGVcIiB8IFwiYmV0YVwiO1xuICBsYWJlbDogc3RyaW5nO1xuICBjdXJyZW50OiBib29sZWFuO1xuICB1c2VyUm9vdDogc3RyaW5nO1xuICBzdGF0ZVBhdGg6IHN0cmluZztcbiAgY29uZmlnUGF0aDogc3RyaW5nO1xuICBhcHBSb290OiBzdHJpbmc7XG4gIGFwcEV4aXN0czogYm9vbGVhbjtcbiAgc3RhdGVFeGlzdHM6IGJvb2xlYW47XG4gIGNvZGV4VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgY29kZXhQbHVzUGx1c1ZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIGJ1bmRsZUlkOiBzdHJpbmcgfCBudWxsO1xuICB3YXRjaGVyOiBzdHJpbmcgfCBudWxsO1xuICB3YXRjaGVyTGFiZWw6IHN0cmluZztcbiAgd2F0Y2hlckxvYWRlZDogYm9vbGVhbiB8IG51bGw7XG4gIHJ1bnRpbWVQcmVsb2FkUGF0aDogc3RyaW5nO1xuICBydW50aW1lUHJlbG9hZEV4aXN0czogYm9vbGVhbjtcbiAgcnVudGltZVByZWxvYWRCeXRlczogbnVtYmVyIHwgbnVsbDtcbiAgcnVudGltZVVwZGF0ZWRBdDogc3RyaW5nIHwgbnVsbDtcbiAgYXV0b1VwZGF0ZTogYm9vbGVhbjtcbiAgY2RwOiBQYXRjaENkcFN0YXR1cztcbiAgY29tbWFuZHM6IFBhdGNoQ2hhbm5lbENvbW1hbmRzO1xufVxuXG5pbnRlcmZhY2UgUGF0Y2hDZHBTdGF0dXMge1xuICBlbmFibGVkOiBib29sZWFuO1xuICBjb25maWd1cmVkUG9ydDogbnVtYmVyO1xuICBleHBlY3RlZFBvcnQ6IG51bWJlcjtcbiAgYWN0aXZlUG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgYWN0aXZlOiBib29sZWFuO1xuICBkcmlmdDogYm9vbGVhbjtcbiAganNvbkxpc3RVcmw6IHN0cmluZyB8IG51bGw7XG4gIGpzb25WZXJzaW9uVXJsOiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgUGF0Y2hDaGFubmVsQ29tbWFuZHMge1xuICByZXBhaXI6IHN0cmluZztcbiAgcmVvcGVuV2l0aENkcDogc3RyaW5nO1xuICBzdGF0dXM6IHN0cmluZztcbiAgdXBkYXRlQ29kZXg6IHN0cmluZztcbn1cblxuLyoqXG4gKiBBIHR3ZWFrLXJlZ2lzdGVyZWQgcGFnZS4gV2UgY2FycnkgdGhlIG93bmluZyB0d2VhaydzIG1hbmlmZXN0IHNvIHdlIGNhblxuICogcmVzb2x2ZSByZWxhdGl2ZSBpY29uVXJscyBhbmQgc2hvdyBhdXRob3JzaGlwIGluIHRoZSBwYWdlIGhlYWRlci5cbiAqL1xuaW50ZXJmYWNlIFJlZ2lzdGVyZWRQYWdlIHtcbiAgLyoqIEZ1bGx5LXF1YWxpZmllZCBpZDogYDx0d2Vha0lkPjo8cGFnZUlkPmAuICovXG4gIGlkOiBzdHJpbmc7XG4gIHR3ZWFrSWQ6IHN0cmluZztcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIHBhZ2U6IFNldHRpbmdzUGFnZTtcbiAgLyoqIFBlci1wYWdlIERPTSB0ZWFyZG93biByZXR1cm5lZCBieSBgcGFnZS5yZW5kZXJgLCBpZiBhbnkuICovXG4gIHRlYXJkb3duPzogKCgpID0+IHZvaWQpIHwgbnVsbDtcbiAgLyoqIFRoZSBpbmplY3RlZCBzaWRlYmFyIGJ1dHRvbiAoc28gd2UgY2FuIHVwZGF0ZSBpdHMgYWN0aXZlIHN0YXRlKS4gKi9cbiAgbmF2QnV0dG9uPzogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xufVxuXG4vKiogV2hhdCBwYWdlIGlzIGN1cnJlbnRseSBzZWxlY3RlZCBpbiBvdXIgaW5qZWN0ZWQgbmF2LiAqL1xudHlwZSBBY3RpdmVQYWdlID1cbiAgfCB7IGtpbmQ6IFwiY29uZmlnXCIgfVxuICB8IHsga2luZDogXCJwYXRjaC1tYW5hZ2VyXCIgfVxuICB8IHsga2luZDogXCJ0d2Vha3NcIiB9XG4gIHwgeyBraW5kOiBcInJlZ2lzdGVyZWRcIjsgaWQ6IHN0cmluZyB9O1xuXG5pbnRlcmZhY2UgSW5qZWN0b3JTdGF0ZSB7XG4gIHNlY3Rpb25zOiBNYXA8c3RyaW5nLCBTZXR0aW5nc1NlY3Rpb24+O1xuICBwYWdlczogTWFwPHN0cmluZywgUmVnaXN0ZXJlZFBhZ2U+O1xuICBsaXN0ZWRUd2Vha3M6IExpc3RlZFR3ZWFrW107XG4gIC8qKiBPdXRlciB3cmFwcGVyIHRoYXQgaG9sZHMgQ29kZXgncyBpdGVtcyBncm91cCArIG91ciBpbmplY3RlZCBncm91cHMuICovXG4gIG91dGVyV3JhcHBlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiR2VuZXJhbFwiIGxhYmVsIGZvciBDb2RleCdzIG5hdGl2ZSBzZXR0aW5ncyBncm91cC4gKi9cbiAgbmF0aXZlTmF2SGVhZGVyOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIC8qKiBPdXIgXCJDb2RleCsrXCIgbmF2IGdyb3VwIChDb25maWcvVHdlYWtzKS4gKi9cbiAgbmF2R3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgbmF2QnV0dG9uczoge1xuICAgIGNvbmZpZzogSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gICAgcGF0Y2hNYW5hZ2VyOiBIVE1MQnV0dG9uRWxlbWVudDtcbiAgICB0d2Vha3M6IEhUTUxCdXR0b25FbGVtZW50O1xuICB9IHwgbnVsbDtcbiAgLyoqIE91ciBcIlR3ZWFrc1wiIG5hdiBncm91cCAocGVyLXR3ZWFrIHBhZ2VzKS4gQ3JlYXRlZCBsYXppbHkuICovXG4gIHBhZ2VzR3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcGFnZXNHcm91cEtleTogc3RyaW5nIHwgbnVsbDtcbiAgcGFuZWxIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbDtcbiAgZmluZ2VycHJpbnQ6IHN0cmluZyB8IG51bGw7XG4gIHNpZGViYXJEdW1wZWQ6IGJvb2xlYW47XG4gIGFjdGl2ZVBhZ2U6IEFjdGl2ZVBhZ2UgfCBudWxsO1xuICBzaWRlYmFyUm9vdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBzaWRlYmFyUmVzdG9yZUhhbmRsZXI6ICgoZTogRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogYm9vbGVhbjtcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG59XG5cbmNvbnN0IHN0YXRlOiBJbmplY3RvclN0YXRlID0ge1xuICBzZWN0aW9uczogbmV3IE1hcCgpLFxuICBwYWdlczogbmV3IE1hcCgpLFxuICBsaXN0ZWRUd2Vha3M6IFtdLFxuICBvdXRlcldyYXBwZXI6IG51bGwsXG4gIG5hdGl2ZU5hdkhlYWRlcjogbnVsbCxcbiAgbmF2R3JvdXA6IG51bGwsXG4gIG5hdkJ1dHRvbnM6IG51bGwsXG4gIHBhZ2VzR3JvdXA6IG51bGwsXG4gIHBhZ2VzR3JvdXBLZXk6IG51bGwsXG4gIHBhbmVsSG9zdDogbnVsbCxcbiAgb2JzZXJ2ZXI6IG51bGwsXG4gIGZpbmdlcnByaW50OiBudWxsLFxuICBzaWRlYmFyRHVtcGVkOiBmYWxzZSxcbiAgYWN0aXZlUGFnZTogbnVsbCxcbiAgc2lkZWJhclJvb3Q6IG51bGwsXG4gIHNpZGViYXJSZXN0b3JlSGFuZGxlcjogbnVsbCxcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogZmFsc2UsXG4gIHNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcjogbnVsbCxcbn07XG5cbmZ1bmN0aW9uIHBsb2cobXNnOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGBbc2V0dGluZ3MtaW5qZWN0b3JdICR7bXNnfSR7ZXh0cmEgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiBcIiBcIiArIHNhZmVTdHJpbmdpZnkoZXh0cmEpfWAsXG4gICk7XG59XG5mdW5jdGlvbiBzYWZlU3RyaW5naWZ5KHY6IHVua25vd24pOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IHYgOiBKU09OLnN0cmluZ2lmeSh2KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFN0cmluZyh2KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgcHVibGljIEFQSSBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0U2V0dGluZ3NJbmplY3RvcigpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm9ic2VydmVyKSByZXR1cm47XG5cbiAgY29uc3Qgb2JzID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIHRyeUluamVjdCgpO1xuICAgIG1heWJlRHVtcERvbSgpO1xuICB9KTtcbiAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgc3RhdGUub2JzZXJ2ZXIgPSBvYnM7XG5cbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCBvbk5hdik7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiaGFzaGNoYW5nZVwiLCBvbk5hdik7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkRvY3VtZW50Q2xpY2ssIHRydWUpO1xuICBmb3IgKGNvbnN0IG0gb2YgW1wicHVzaFN0YXRlXCIsIFwicmVwbGFjZVN0YXRlXCJdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgb3JpZyA9IGhpc3RvcnlbbV07XG4gICAgaGlzdG9yeVttXSA9IGZ1bmN0aW9uICh0aGlzOiBIaXN0b3J5LCAuLi5hcmdzOiBQYXJhbWV0ZXJzPHR5cGVvZiBvcmlnPikge1xuICAgICAgY29uc3QgciA9IG9yaWcuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoYGNvZGV4cHAtJHttfWApKTtcbiAgICAgIHJldHVybiByO1xuICAgIH0gYXMgdHlwZW9mIG9yaWc7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoYGNvZGV4cHAtJHttfWAsIG9uTmF2KTtcbiAgfVxuXG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbiAgbGV0IHRpY2tzID0gMDtcbiAgY29uc3QgaW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgdGlja3MrKztcbiAgICB0cnlJbmplY3QoKTtcbiAgICBtYXliZUR1bXBEb20oKTtcbiAgICBpZiAodGlja3MgPiA2MCkgY2xlYXJJbnRlcnZhbChpbnRlcnZhbCk7XG4gIH0sIDUwMCk7XG59XG5cbmZ1bmN0aW9uIG9uTmF2KCk6IHZvaWQge1xuICBzdGF0ZS5maW5nZXJwcmludCA9IG51bGw7XG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbn1cblxuZnVuY3Rpb24gb25Eb2N1bWVudENsaWNrKGU6IE1vdXNlRXZlbnQpOiB2b2lkIHtcbiAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50ID8gZS50YXJnZXQgOiBudWxsO1xuICBjb25zdCBjb250cm9sID0gdGFyZ2V0Py5jbG9zZXN0KFwiW3JvbGU9J2xpbmsnXSxidXR0b24sYVwiKTtcbiAgaWYgKCEoY29udHJvbCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSkgcmV0dXJuO1xuICBpZiAoY29tcGFjdFNldHRpbmdzVGV4dChjb250cm9sLnRleHRDb250ZW50IHx8IFwiXCIpICE9PSBcIkJhY2sgdG8gYXBwXCIpIHJldHVybjtcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJiYWNrLXRvLWFwcFwiKTtcbiAgfSwgMCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNlY3Rpb24oc2VjdGlvbjogU2V0dGluZ3NTZWN0aW9uKTogU2V0dGluZ3NIYW5kbGUge1xuICBzdGF0ZS5zZWN0aW9ucy5zZXQoc2VjdGlvbi5pZCwgc2VjdGlvbik7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICByZXR1cm4ge1xuICAgIHVucmVnaXN0ZXI6ICgpID0+IHtcbiAgICAgIHN0YXRlLnNlY3Rpb25zLmRlbGV0ZShzZWN0aW9uLmlkKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclNlY3Rpb25zKCk6IHZvaWQge1xuICBzdGF0ZS5zZWN0aW9ucy5jbGVhcigpO1xuICAvLyBEcm9wIHJlZ2lzdGVyZWQgcGFnZXMgdG9vIFx1MjAxNCB0aGV5J3JlIG93bmVkIGJ5IHR3ZWFrcyB0aGF0IGp1c3QgZ290XG4gIC8vIHRvcm4gZG93biBieSB0aGUgaG9zdC4gUnVuIGFueSB0ZWFyZG93bnMgYmVmb3JlIGZvcmdldHRpbmcgdGhlbS5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHAudGVhcmRvd24/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBsb2coXCJwYWdlIHRlYXJkb3duIGZhaWxlZFwiLCB7IGlkOiBwLmlkLCBlcnI6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cbiAgc3RhdGUucGFnZXMuY2xlYXIoKTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gSWYgd2Ugd2VyZSBvbiBhIHJlZ2lzdGVyZWQgcGFnZSB0aGF0IG5vIGxvbmdlciBleGlzdHMsIGZhbGwgYmFjayB0b1xuICAvLyByZXN0b3JpbmcgQ29kZXgncyB2aWV3LlxuICBpZiAoXG4gICAgc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiZcbiAgICAhc3RhdGUucGFnZXMuaGFzKHN0YXRlLmFjdGl2ZVBhZ2UuaWQpXG4gICkge1xuICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIGEgdHdlYWstb3duZWQgc2V0dGluZ3MgcGFnZS4gVGhlIHJ1bnRpbWUgaW5qZWN0cyBhIHNpZGViYXIgZW50cnlcbiAqIHVuZGVyIGEgXCJUV0VBS1NcIiBncm91cCBoZWFkZXIgKHdoaWNoIGFwcGVhcnMgb25seSB3aGVuIGF0IGxlYXN0IG9uZSBwYWdlXG4gKiBpcyByZWdpc3RlcmVkKSBhbmQgcm91dGVzIGNsaWNrcyB0byB0aGUgcGFnZSdzIGByZW5kZXIocm9vdClgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJQYWdlKFxuICB0d2Vha0lkOiBzdHJpbmcsXG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LFxuICBwYWdlOiBTZXR0aW5nc1BhZ2UsXG4pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIGNvbnN0IGlkID0gcGFnZS5pZDsgLy8gYWxyZWFkeSBuYW1lc3BhY2VkIGJ5IHR3ZWFrLWhvc3QgYXMgYCR7dHdlYWtJZH06JHtwYWdlLmlkfWBcbiAgY29uc3QgZW50cnk6IFJlZ2lzdGVyZWRQYWdlID0geyBpZCwgdHdlYWtJZCwgbWFuaWZlc3QsIHBhZ2UgfTtcbiAgc3RhdGUucGFnZXMuc2V0KGlkLCBlbnRyeSk7XG4gIHBsb2coXCJyZWdpc3RlclBhZ2VcIiwgeyBpZCwgdGl0bGU6IHBhZ2UudGl0bGUsIHR3ZWFrSWQgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIC8vIElmIHRoZSB1c2VyIHdhcyBhbHJlYWR5IG9uIHRoaXMgcGFnZSAoaG90IHJlbG9hZCksIHJlLW1vdW50IGl0cyBib2R5LlxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHtcbiAgICByZXJlbmRlcigpO1xuICB9XG4gIHJldHVybiB7XG4gICAgdW5yZWdpc3RlcjogKCkgPT4ge1xuICAgICAgY29uc3QgZSA9IHN0YXRlLnBhZ2VzLmdldChpZCk7XG4gICAgICBpZiAoIWUpIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGUudGVhcmRvd24/LigpO1xuICAgICAgfSBjYXRjaCB7fVxuICAgICAgc3RhdGUucGFnZXMuZGVsZXRlKGlkKTtcbiAgICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHtcbiAgICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgICAgfVxuICAgIH0sXG4gIH07XG59XG5cbi8qKiBDYWxsZWQgYnkgdGhlIHR3ZWFrIGhvc3QgYWZ0ZXIgZmV0Y2hpbmcgdGhlIHR3ZWFrIGxpc3QgZnJvbSBtYWluLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldExpc3RlZFR3ZWFrcyhsaXN0OiBMaXN0ZWRUd2Vha1tdKTogdm9pZCB7XG4gIHN0YXRlLmxpc3RlZFR3ZWFrcyA9IGxpc3Q7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgaW5qZWN0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0cnlJbmplY3QoKTogdm9pZCB7XG4gIGNvbnN0IGl0ZW1zR3JvdXAgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgaWYgKCFpdGVtc0dyb3VwKSB7XG4gICAgc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTtcbiAgICBwbG9nKFwic2lkZWJhciBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHtcbiAgICBjbGVhclRpbWVvdXQoc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKTtcbiAgICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBudWxsO1xuICB9XG4gIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUodHJ1ZSwgXCJzaWRlYmFyLWZvdW5kXCIpO1xuICAvLyBDb2RleCdzIGl0ZW1zIGdyb3VwIGxpdmVzIGluc2lkZSBhbiBvdXRlciB3cmFwcGVyIHRoYXQncyBhbHJlYWR5IHN0eWxlZFxuICAvLyB0byBob2xkIG11bHRpcGxlIGdyb3VwcyAoYGZsZXggZmxleC1jb2wgZ2FwLTEgZ2FwLTBgKS4gV2UgaW5qZWN0IG91clxuICAvLyBncm91cCBhcyBhIHNpYmxpbmcgc28gdGhlIG5hdHVyYWwgZ2FwLTEgYWN0cyBhcyBvdXIgdmlzdWFsIHNlcGFyYXRvci5cbiAgY29uc3Qgb3V0ZXIgPSBpdGVtc0dyb3VwLnBhcmVudEVsZW1lbnQgPz8gaXRlbXNHcm91cDtcbiAgc3RhdGUuc2lkZWJhclJvb3QgPSBvdXRlcjtcbiAgc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXAsIG91dGVyKTtcblxuICBpZiAoc3RhdGUubmF2R3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF2R3JvdXApKSB7XG4gICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAvLyBDb2RleCByZS1yZW5kZXJzIGl0cyBuYXRpdmUgc2lkZWJhciBidXR0b25zIG9uIGl0cyBvd24gc3RhdGUgY2hhbmdlcy5cbiAgICAvLyBJZiBvbmUgb2Ygb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgcmUtc3RyaXAgQ29kZXgncyBhY3RpdmUgc3R5bGluZyBzb1xuICAgIC8vIEdlbmVyYWwgZG9lc24ndCByZWFwcGVhciBhcyBzZWxlY3RlZC5cbiAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCkgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpZGViYXIgd2FzIGVpdGhlciBmcmVzaGx5IG1vdW50ZWQgKFNldHRpbmdzIGp1c3Qgb3BlbmVkKSBvciByZS1tb3VudGVkXG4gIC8vIChjbG9zZWQgYW5kIHJlLW9wZW5lZCwgb3IgbmF2aWdhdGVkIGF3YXkgYW5kIGJhY2spLiBJbiBhbGwgb2YgdGhvc2VcbiAgLy8gY2FzZXMgQ29kZXggcmVzZXRzIHRvIGl0cyBkZWZhdWx0IHBhZ2UgKEdlbmVyYWwpLCBidXQgb3VyIGluLW1lbW9yeVxuICAvLyBgYWN0aXZlUGFnZWAgbWF5IHN0aWxsIHJlZmVyZW5jZSB0aGUgbGFzdCB0d2Vhay9wYWdlIHRoZSB1c2VyIGhhZCBvcGVuXG4gIC8vIFx1MjAxNCB3aGljaCB3b3VsZCBjYXVzZSB0aGF0IG5hdiBidXR0b24gdG8gcmVuZGVyIHdpdGggdGhlIGFjdGl2ZSBzdHlsaW5nXG4gIC8vIGV2ZW4gdGhvdWdoIENvZGV4IGlzIHNob3dpbmcgR2VuZXJhbC4gQ2xlYXIgaXQgc28gYHN5bmNQYWdlc0dyb3VwYCAvXG4gIC8vIGBzZXROYXZBY3RpdmVgIHN0YXJ0IGZyb20gYSBuZXV0cmFsIHN0YXRlLiBUaGUgcGFuZWxIb3N0IHJlZmVyZW5jZSBpc1xuICAvLyBhbHNvIHN0YWxlIChpdHMgRE9NIHdhcyBkaXNjYXJkZWQgd2l0aCB0aGUgcHJldmlvdXMgY29udGVudCBhcmVhKS5cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwgfHwgc3RhdGUucGFuZWxIb3N0ICE9PSBudWxsKSB7XG4gICAgcGxvZyhcInNpZGViYXIgcmUtbW91bnQgZGV0ZWN0ZWQ7IGNsZWFyaW5nIHN0YWxlIGFjdGl2ZSBzdGF0ZVwiLCB7XG4gICAgICBwcmV2QWN0aXZlOiBzdGF0ZS5hY3RpdmVQYWdlLFxuICAgIH0pO1xuICAgIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICAgIHN0YXRlLnBhbmVsSG9zdCA9IG51bGw7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgR3JvdXAgY29udGFpbmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGdyb3VwLmRhdGFzZXQuY29kZXhwcCA9IFwibmF2LWdyb3VwXCI7XG4gIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcblxuICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJDb2RleCsrXCIsIFwicHQtM1wiKSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEJ1aWx0LWluIHNpZGViYXIgaXRlbXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGNvbmZpZ0J0biA9IG1ha2VTaWRlYmFySXRlbShcIkNvbmZpZ1wiLCBjb25maWdJY29uU3ZnKCkpO1xuICBjb25zdCBwYXRjaE1hbmFnZXJCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJQYXRjaCBNYW5hZ2VyXCIsIHBhdGNoTWFuYWdlckljb25TdmcoKSk7XG4gIGNvbnN0IHR3ZWFrc0J0biA9IG1ha2VTaWRlYmFySXRlbShcIlR3ZWFrc1wiLCB0d2Vha3NJY29uU3ZnKCkpO1xuXG4gIGNvbmZpZ0J0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcImNvbmZpZ1wiIH0pO1xuICB9KTtcbiAgcGF0Y2hNYW5hZ2VyQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwicGF0Y2gtbWFuYWdlclwiIH0pO1xuICB9KTtcbiAgdHdlYWtzQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwidHdlYWtzXCIgfSk7XG4gIH0pO1xuXG4gIGdyb3VwLmFwcGVuZENoaWxkKGNvbmZpZ0J0bik7XG4gIGdyb3VwLmFwcGVuZENoaWxkKHBhdGNoTWFuYWdlckJ0bik7XG4gIGdyb3VwLmFwcGVuZENoaWxkKHR3ZWFrc0J0bik7XG4gIG91dGVyLmFwcGVuZENoaWxkKGdyb3VwKTtcblxuICBzdGF0ZS5uYXZHcm91cCA9IGdyb3VwO1xuICBzdGF0ZS5uYXZCdXR0b25zID0geyBjb25maWc6IGNvbmZpZ0J0biwgcGF0Y2hNYW5hZ2VyOiBwYXRjaE1hbmFnZXJCdG4sIHR3ZWFrczogdHdlYWtzQnRuIH07XG4gIHBsb2coXCJuYXYgZ3JvdXAgaW5qZWN0ZWRcIiwgeyBvdXRlclRhZzogb3V0ZXIudGFnTmFtZSB9KTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbn1cblxuZnVuY3Rpb24gc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXA6IEhUTUxFbGVtZW50LCBvdXRlcjogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm5hdGl2ZU5hdkhlYWRlciAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5uYXRpdmVOYXZIZWFkZXIpKSByZXR1cm47XG4gIGlmIChvdXRlciA9PT0gaXRlbXNHcm91cCkgcmV0dXJuO1xuXG4gIGNvbnN0IGhlYWRlciA9IHNpZGViYXJHcm91cEhlYWRlcihcIkdlbmVyYWxcIik7XG4gIGhlYWRlci5kYXRhc2V0LmNvZGV4cHAgPSBcIm5hdGl2ZS1uYXYtaGVhZGVyXCI7XG4gIG91dGVyLmluc2VydEJlZm9yZShoZWFkZXIsIGl0ZW1zR3JvdXApO1xuICBzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgPSBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIHNpZGViYXJHcm91cEhlYWRlcih0ZXh0OiBzdHJpbmcsIHRvcFBhZGRpbmcgPSBcInB0LTJcIik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9XG4gICAgYHB4LXJvdy14ICR7dG9wUGFkZGluZ30gcGItMSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bSB1cHBlcmNhc2UgdHJhY2tpbmctd2lkZXIgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIHNlbGVjdC1ub25lYDtcbiAgaGVhZGVyLnRleHRDb250ZW50ID0gdGV4dDtcbiAgcmV0dXJuIGhlYWRlcjtcbn1cblxuZnVuY3Rpb24gc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTogdm9pZCB7XG4gIGlmICghc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSB8fCBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHJldHVybjtcbiAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gbnVsbDtcbiAgICBpZiAoZmluZFNpZGViYXJJdGVtc0dyb3VwKCkpIHJldHVybjtcbiAgICBpZiAoaXNTZXR0aW5nc1RleHRWaXNpYmxlKCkpIHJldHVybjtcbiAgICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKGZhbHNlLCBcInNpZGViYXItbm90LWZvdW5kXCIpO1xuICB9LCAxNTAwKTtcbn1cblxuZnVuY3Rpb24gaXNTZXR0aW5nc1RleHRWaXNpYmxlKCk6IGJvb2xlYW4ge1xuICBjb25zdCB0ZXh0ID0gY29tcGFjdFNldHRpbmdzVGV4dChkb2N1bWVudC5ib2R5Py50ZXh0Q29udGVudCB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gKFxuICAgIHRleHQuaW5jbHVkZXMoXCJiYWNrIHRvIGFwcFwiKSAmJlxuICAgIHRleHQuaW5jbHVkZXMoXCJnZW5lcmFsXCIpICYmXG4gICAgdGV4dC5pbmNsdWRlcyhcImFwcGVhcmFuY2VcIikgJiZcbiAgICAodGV4dC5pbmNsdWRlcyhcImNvbmZpZ3VyYXRpb25cIikgfHwgdGV4dC5pbmNsdWRlcyhcImRlZmF1bHQgcGVybWlzc2lvbnNcIikpXG4gICk7XG59XG5cbmZ1bmN0aW9uIGNvbXBhY3RTZXR0aW5nc1RleHQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcodmFsdWUgfHwgXCJcIikucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKHZpc2libGU6IGJvb2xlYW4sIHJlYXNvbjogc3RyaW5nKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID09PSB2aXNpYmxlKSByZXR1cm47XG4gIHN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgPSB2aXNpYmxlO1xuICB0cnkge1xuICAgICh3aW5kb3cgYXMgV2luZG93ICYgeyBfX2NvZGV4cHBTZXR0aW5nc1N1cmZhY2VWaXNpYmxlPzogYm9vbGVhbiB9KS5fX2NvZGV4cHBTZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC5jb2RleHBwU2V0dGluZ3NTdXJmYWNlID0gdmlzaWJsZSA/IFwidHJ1ZVwiIDogXCJmYWxzZVwiO1xuICAgIHdpbmRvdy5kaXNwYXRjaEV2ZW50KFxuICAgICAgbmV3IEN1c3RvbUV2ZW50KFwiY29kZXhwcDpzZXR0aW5ncy1zdXJmYWNlXCIsIHtcbiAgICAgICAgZGV0YWlsOiB7IHZpc2libGUsIHJlYXNvbiB9LFxuICAgICAgfSksXG4gICAgKTtcbiAgfSBjYXRjaCB7fVxuICBwbG9nKFwic2V0dGluZ3Mgc3VyZmFjZVwiLCB7IHZpc2libGUsIHJlYXNvbiwgdXJsOiBsb2NhdGlvbi5ocmVmIH0pO1xufVxuXG4vKipcbiAqIFJlbmRlciAob3IgcmUtcmVuZGVyKSB0aGUgc2Vjb25kIHNpZGViYXIgZ3JvdXAgb2YgcGVyLXR3ZWFrIHBhZ2VzLiBUaGVcbiAqIGdyb3VwIGlzIGNyZWF0ZWQgbGF6aWx5IGFuZCByZW1vdmVkIHdoZW4gdGhlIGxhc3QgcGFnZSB1bnJlZ2lzdGVycywgc29cbiAqIHVzZXJzIHdpdGggbm8gcGFnZS1yZWdpc3RlcmluZyB0d2Vha3MgbmV2ZXIgc2VlIGFuIGVtcHR5IFwiVHdlYWtzXCIgaGVhZGVyLlxuICovXG5mdW5jdGlvbiBzeW5jUGFnZXNHcm91cCgpOiB2b2lkIHtcbiAgY29uc3Qgb3V0ZXIgPSBzdGF0ZS5zaWRlYmFyUm9vdDtcbiAgaWYgKCFvdXRlcikgcmV0dXJuO1xuICBjb25zdCBwYWdlcyA9IFsuLi5zdGF0ZS5wYWdlcy52YWx1ZXMoKV07XG5cbiAgLy8gQnVpbGQgYSBkZXRlcm1pbmlzdGljIGZpbmdlcnByaW50IG9mIHRoZSBkZXNpcmVkIGdyb3VwIHN0YXRlLiBJZiB0aGVcbiAgLy8gY3VycmVudCBET00gZ3JvdXAgYWxyZWFkeSBtYXRjaGVzLCB0aGlzIGlzIGEgbm8tb3AgXHUyMDE0IGNyaXRpY2FsLCBiZWNhdXNlXG4gIC8vIHN5bmNQYWdlc0dyb3VwIGlzIGNhbGxlZCBvbiBldmVyeSBNdXRhdGlvbk9ic2VydmVyIHRpY2sgYW5kIGFueSBET01cbiAgLy8gd3JpdGUgd291bGQgcmUtdHJpZ2dlciB0aGF0IG9ic2VydmVyIChpbmZpbml0ZSBsb29wLCBhcHAgZnJlZXplKS5cbiAgY29uc3QgZGVzaXJlZEtleSA9IHBhZ2VzLmxlbmd0aCA9PT0gMFxuICAgID8gXCJFTVBUWVwiXG4gICAgOiBwYWdlcy5tYXAoKHApID0+IGAke3AuaWR9fCR7cC5wYWdlLnRpdGxlfXwke3AucGFnZS5pY29uU3ZnID8/IFwiXCJ9YCkuam9pbihcIlxcblwiKTtcbiAgY29uc3QgZ3JvdXBBdHRhY2hlZCA9ICEhc3RhdGUucGFnZXNHcm91cCAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5wYWdlc0dyb3VwKTtcbiAgaWYgKHN0YXRlLnBhZ2VzR3JvdXBLZXkgPT09IGRlc2lyZWRLZXkgJiYgKHBhZ2VzLmxlbmd0aCA9PT0gMCA/ICFncm91cEF0dGFjaGVkIDogZ3JvdXBBdHRhY2hlZCkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXApIHtcbiAgICAgIHN0YXRlLnBhZ2VzR3JvdXAucmVtb3ZlKCk7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwID0gbnVsbDtcbiAgICB9XG4gICAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSBwLm5hdkJ1dHRvbiA9IG51bGw7XG4gICAgc3RhdGUucGFnZXNHcm91cEtleSA9IGRlc2lyZWRLZXk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbGV0IGdyb3VwID0gc3RhdGUucGFnZXNHcm91cDtcbiAgaWYgKCFncm91cCB8fCAhb3V0ZXIuY29udGFpbnMoZ3JvdXApKSB7XG4gICAgZ3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGdyb3VwLmRhdGFzZXQuY29kZXhwcCA9IFwicGFnZXMtZ3JvdXBcIjtcbiAgICBncm91cC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLXB4XCI7XG4gICAgZ3JvdXAuYXBwZW5kQ2hpbGQoc2lkZWJhckdyb3VwSGVhZGVyKFwiVHdlYWtzXCIsIFwicHQtM1wiKSk7XG4gICAgb3V0ZXIuYXBwZW5kQ2hpbGQoZ3JvdXApO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBncm91cDtcbiAgfSBlbHNlIHtcbiAgICAvLyBTdHJpcCBwcmlvciBidXR0b25zIChrZWVwIHRoZSBoZWFkZXIgYXQgaW5kZXggMCkuXG4gICAgd2hpbGUgKGdyb3VwLmNoaWxkcmVuLmxlbmd0aCA+IDEpIGdyb3VwLnJlbW92ZUNoaWxkKGdyb3VwLmxhc3RDaGlsZCEpO1xuICB9XG5cbiAgZm9yIChjb25zdCBwIG9mIHBhZ2VzKSB7XG4gICAgY29uc3QgaWNvbiA9IHAucGFnZS5pY29uU3ZnID8/IGRlZmF1bHRQYWdlSWNvblN2ZygpO1xuICAgIGNvbnN0IGJ0biA9IG1ha2VTaWRlYmFySXRlbShwLnBhZ2UudGl0bGUsIGljb24pO1xuICAgIGJ0bi5kYXRhc2V0LmNvZGV4cHAgPSBgbmF2LXBhZ2UtJHtwLmlkfWA7XG4gICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiLCBpZDogcC5pZCB9KTtcbiAgICB9KTtcbiAgICBwLm5hdkJ1dHRvbiA9IGJ0bjtcbiAgICBncm91cC5hcHBlbmRDaGlsZChidG4pO1xuICB9XG4gIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBkZXNpcmVkS2V5O1xuICBwbG9nKFwicGFnZXMgZ3JvdXAgc3luY2VkXCIsIHtcbiAgICBjb3VudDogcGFnZXMubGVuZ3RoLFxuICAgIGlkczogcGFnZXMubWFwKChwKSA9PiBwLmlkKSxcbiAgfSk7XG4gIC8vIFJlZmxlY3QgY3VycmVudCBhY3RpdmUgc3RhdGUgYWNyb3NzIHRoZSByZWJ1aWx0IGJ1dHRvbnMuXG4gIHNldE5hdkFjdGl2ZShzdGF0ZS5hY3RpdmVQYWdlKTtcbn1cblxuZnVuY3Rpb24gbWFrZVNpZGViYXJJdGVtKGxhYmVsOiBzdHJpbmcsIGljb25Tdmc6IHN0cmluZyk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgLy8gQ2xhc3Mgc3RyaW5nIGNvcGllZCB2ZXJiYXRpbSBmcm9tIENvZGV4J3Mgc2lkZWJhciBidXR0b25zIChHZW5lcmFsIGV0YykuXG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmRhdGFzZXQuY29kZXhwcCA9IGBuYXYtJHtsYWJlbC50b0xvd2VyQ2FzZSgpfWA7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIGxhYmVsKTtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJmb2N1cy12aXNpYmxlOm91dGxpbmUtdG9rZW4tYm9yZGVyIHJlbGF0aXZlIHB4LXJvdy14IHB5LXJvdy15IGN1cnNvci1pbnRlcmFjdGlvbiBzaHJpbmstMCBpdGVtcy1jZW50ZXIgb3ZlcmZsb3ctaGlkZGVuIHJvdW5kZWQtbGcgdGV4dC1sZWZ0IHRleHQtc20gZm9jdXMtdmlzaWJsZTpvdXRsaW5lIGZvY3VzLXZpc2libGU6b3V0bGluZS0yIGZvY3VzLXZpc2libGU6b3V0bGluZS1vZmZzZXQtMiBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS01MCBnYXAtMiBmbGV4IHctZnVsbCBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZm9udC1ub3JtYWxcIjtcblxuICBjb25zdCBpbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIHRleHQtYmFzZSBnYXAtMiBmbGV4LTEgdGV4dC10b2tlbi1mb3JlZ3JvdW5kXCI7XG4gIGlubmVyLmlubmVySFRNTCA9IGAke2ljb25Tdmd9PHNwYW4gY2xhc3M9XCJ0cnVuY2F0ZVwiPiR7bGFiZWx9PC9zcGFuPmA7XG4gIGJ0bi5hcHBlbmRDaGlsZChpbm5lcik7XG4gIHJldHVybiBidG47XG59XG5cbi8qKiBJbnRlcm5hbCBrZXkgZm9yIHRoZSBidWlsdC1pbiBuYXYgYnV0dG9ucy4gKi9cbnR5cGUgQnVpbHRpblBhZ2UgPSBcImNvbmZpZ1wiIHwgXCJwYXRjaE1hbmFnZXJcIiB8IFwidHdlYWtzXCI7XG5cbmZ1bmN0aW9uIHNldE5hdkFjdGl2ZShhY3RpdmU6IEFjdGl2ZVBhZ2UgfCBudWxsKTogdm9pZCB7XG4gIC8vIEJ1aWx0LWluIChDb25maWcvVHdlYWtzKSBidXR0b25zLlxuICBpZiAoc3RhdGUubmF2QnV0dG9ucykge1xuICAgIGNvbnN0IGJ1aWx0aW46IEJ1aWx0aW5QYWdlIHwgbnVsbCA9XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwiY29uZmlnXCIgPyBcImNvbmZpZ1wiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJwYXRjaC1tYW5hZ2VyXCIgPyBcInBhdGNoTWFuYWdlclwiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwidHdlYWtzXCIgOiBudWxsO1xuICAgIGZvciAoY29uc3QgW2tleSwgYnRuXSBvZiBPYmplY3QuZW50cmllcyhzdGF0ZS5uYXZCdXR0b25zKSBhcyBbQnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50XVtdKSB7XG4gICAgICBhcHBseU5hdkFjdGl2ZShidG4sIGtleSA9PT0gYnVpbHRpbik7XG4gICAgfVxuICB9XG4gIC8vIFBlci1wYWdlIHJlZ2lzdGVyZWQgYnV0dG9ucy5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgaWYgKCFwLm5hdkJ1dHRvbikgY29udGludWU7XG4gICAgY29uc3QgaXNBY3RpdmUgPSBhY3RpdmU/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIGFjdGl2ZS5pZCA9PT0gcC5pZDtcbiAgICBhcHBseU5hdkFjdGl2ZShwLm5hdkJ1dHRvbiwgaXNBY3RpdmUpO1xuICB9XG4gIC8vIENvZGV4J3Mgb3duIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCwgQXBwZWFyYW5jZSwgZXRjKS4gV2hlbiBvbmUgb2ZcbiAgLy8gb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgQ29kZXggc3RpbGwgaGFzIGFyaWEtY3VycmVudD1cInBhZ2VcIiBhbmQgdGhlXG4gIC8vIGFjdGl2ZS1iZyBjbGFzcyBvbiB3aGljaGV2ZXIgaXRlbSBpdCBjb25zaWRlcmVkIHRoZSByb3V0ZSBcdTIwMTQgdHlwaWNhbGx5XG4gIC8vIEdlbmVyYWwuIFRoYXQgbWFrZXMgYm90aCBidXR0b25zIGxvb2sgc2VsZWN0ZWQuIFN0cmlwIENvZGV4J3MgYWN0aXZlXG4gIC8vIHN0eWxpbmcgd2hpbGUgb25lIG9mIG91cnMgaXMgYWN0aXZlOyByZXN0b3JlIGl0IHdoZW4gbm9uZSBpcy5cbiAgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKGFjdGl2ZSAhPT0gbnVsbCk7XG59XG5cbi8qKlxuICogTXV0ZSBDb2RleCdzIG93biBhY3RpdmUtc3RhdGUgc3R5bGluZyBvbiBpdHMgc2lkZWJhciBidXR0b25zLiBXZSBkb24ndFxuICogdG91Y2ggQ29kZXgncyBSZWFjdCBzdGF0ZSBcdTIwMTQgd2hlbiB0aGUgdXNlciBjbGlja3MgYSBuYXRpdmUgaXRlbSwgQ29kZXhcbiAqIHJlLXJlbmRlcnMgdGhlIGJ1dHRvbnMgYW5kIHJlLWFwcGxpZXMgaXRzIG93biBjb3JyZWN0IHN0YXRlLCB0aGVuIG91clxuICogc2lkZWJhci1jbGljayBsaXN0ZW5lciBmaXJlcyBgcmVzdG9yZUNvZGV4Vmlld2AgKHdoaWNoIGNhbGxzIGJhY2sgaW50b1xuICogYHNldE5hdkFjdGl2ZShudWxsKWAgYW5kIGxldHMgQ29kZXgncyBzdHlsaW5nIHN0YW5kKS5cbiAqXG4gKiBgbXV0ZT10cnVlYCAgXHUyMTkyIHN0cmlwIGFyaWEtY3VycmVudCBhbmQgc3dhcCBhY3RpdmUgYmcgXHUyMTkyIGhvdmVyIGJnXG4gKiBgbXV0ZT1mYWxzZWAgXHUyMTkyIG5vLW9wIChDb2RleCdzIG93biByZS1yZW5kZXIgYWxyZWFkeSByZXN0b3JlZCB0aGluZ3MpXG4gKi9cbmZ1bmN0aW9uIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShtdXRlOiBib29sZWFuKTogdm9pZCB7XG4gIGlmICghbXV0ZSkgcmV0dXJuO1xuICBjb25zdCByb290ID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghcm9vdCkgcmV0dXJuO1xuICBjb25zdCBidXR0b25zID0gQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpKTtcbiAgZm9yIChjb25zdCBidG4gb2YgYnV0dG9ucykge1xuICAgIC8vIFNraXAgb3VyIG93biBidXR0b25zLlxuICAgIGlmIChidG4uZGF0YXNldC5jb2RleHBwKSBjb250aW51ZTtcbiAgICBpZiAoYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIpIHtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgfVxuICAgIGlmIChidG4uY2xhc3NMaXN0LmNvbnRhaW5zKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseU5hdkFjdGl2ZShidG46IEhUTUxCdXR0b25FbGVtZW50LCBhY3RpdmU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgaW5uZXIgPSBidG4uZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoYWN0aXZlKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiLCBcImZvbnQtbm9ybWFsXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIsIFwicGFnZVwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBhY3RpdmF0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBhY3RpdmF0ZVBhZ2UocGFnZTogQWN0aXZlUGFnZSk6IHZvaWQge1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkge1xuICAgIHBsb2coXCJhY3RpdmF0ZTogY29udGVudCBhcmVhIG5vdCBmb3VuZFwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IHBhZ2U7XG4gIHBsb2coXCJhY3RpdmF0ZVwiLCB7IHBhZ2UgfSk7XG5cbiAgLy8gSGlkZSBDb2RleCdzIGNvbnRlbnQgY2hpbGRyZW4sIHNob3cgb3Vycy5cbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwID09PSBcInR3ZWFrcy1wYW5lbFwiKSBjb250aW51ZTtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbiA9IGNoaWxkLnN0eWxlLmRpc3BsYXkgfHwgXCJcIjtcbiAgICB9XG4gICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICB9XG4gIGxldCBwYW5lbCA9IGNvbnRlbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLWNvZGV4cHA9XCJ0d2Vha3MtcGFuZWxcIl0nKTtcbiAgaWYgKCFwYW5lbCkge1xuICAgIHBhbmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBwYW5lbC5kYXRhc2V0LmNvZGV4cHAgPSBcInR3ZWFrcy1wYW5lbFwiO1xuICAgIHBhbmVsLnN0eWxlLmNzc1RleHQgPSBcIndpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3ZlcmZsb3c6YXV0bztcIjtcbiAgICBjb250ZW50LmFwcGVuZENoaWxkKHBhbmVsKTtcbiAgfVxuICBwYW5lbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICBzdGF0ZS5wYW5lbEhvc3QgPSBwYW5lbDtcbiAgcmVyZW5kZXIoKTtcbiAgc2V0TmF2QWN0aXZlKHBhZ2UpO1xuICAvLyByZXN0b3JlIENvZGV4J3Mgdmlldy4gUmUtcmVnaXN0ZXIgaWYgbmVlZGVkLlxuICBjb25zdCBzaWRlYmFyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmIChzaWRlYmFyKSB7XG4gICAgaWYgKHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgICAgc2lkZWJhci5yZW1vdmVFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLCB0cnVlKTtcbiAgICB9XG4gICAgY29uc3QgaGFuZGxlciA9IChlOiBFdmVudCkgPT4ge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICAgIGlmIChzdGF0ZS5uYXZHcm91cD8uY29udGFpbnModGFyZ2V0KSkgcmV0dXJuOyAvLyBvdXIgYnV0dG9uc1xuICAgICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIHBhZ2UgYnV0dG9uc1xuICAgICAgaWYgKHRhcmdldC5jbG9zZXN0KFwiW2RhdGEtY29kZXhwcC1zZXR0aW5ncy1zZWFyY2hdXCIpKSByZXR1cm47XG4gICAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gICAgfTtcbiAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIgPSBoYW5kbGVyO1xuICAgIHNpZGViYXIuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZXIsIHRydWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc3RvcmVDb2RleFZpZXcoKTogdm9pZCB7XG4gIHBsb2coXCJyZXN0b3JlIGNvZGV4IHZpZXdcIik7XG4gIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm47XG4gIGlmIChzdGF0ZS5wYW5lbEhvc3QpIHN0YXRlLnBhbmVsSG9zdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkID09PSBzdGF0ZS5wYW5lbEhvc3QpIGNvbnRpbnVlO1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbjtcbiAgICAgIGRlbGV0ZSBjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW47XG4gICAgfVxuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICBzZXROYXZBY3RpdmUobnVsbCk7XG4gIGlmIChzdGF0ZS5zaWRlYmFyUm9vdCAmJiBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdC5yZW1vdmVFdmVudExpc3RlbmVyKFxuICAgICAgXCJjbGlja1wiLFxuICAgICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciA9IG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVyZW5kZXIoKTogdm9pZCB7XG4gIGlmICghc3RhdGUuYWN0aXZlUGFnZSkgcmV0dXJuO1xuICBjb25zdCBob3N0ID0gc3RhdGUucGFuZWxIb3N0O1xuICBpZiAoIWhvc3QpIHJldHVybjtcbiAgaG9zdC5pbm5lckhUTUwgPSBcIlwiO1xuXG4gIGNvbnN0IGFwID0gc3RhdGUuYWN0aXZlUGFnZTtcbiAgaWYgKGFwLmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgY29uc3QgZW50cnkgPSBzdGF0ZS5wYWdlcy5nZXQoYXAuaWQpO1xuICAgIGlmICghZW50cnkpIHtcbiAgICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qgcm9vdCA9IHBhbmVsU2hlbGwoZW50cnkucGFnZS50aXRsZSwgZW50cnkucGFnZS5kZXNjcmlwdGlvbik7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChyb290Lm91dGVyKTtcbiAgICB0cnkge1xuICAgICAgLy8gVGVhciBkb3duIGFueSBwcmlvciByZW5kZXIgYmVmb3JlIHJlLXJlbmRlcmluZyAoaG90IHJlbG9hZCkuXG4gICAgICB0cnkgeyBlbnRyeS50ZWFyZG93bj8uKCk7IH0gY2F0Y2gge31cbiAgICAgIGVudHJ5LnRlYXJkb3duID0gbnVsbDtcbiAgICAgIGNvbnN0IHJldCA9IGVudHJ5LnBhZ2UucmVuZGVyKHJvb3Quc2VjdGlvbnNXcmFwKTtcbiAgICAgIGlmICh0eXBlb2YgcmV0ID09PSBcImZ1bmN0aW9uXCIpIGVudHJ5LnRlYXJkb3duID0gcmV0O1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGVyciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBlcnIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWNoYXJ0cy1yZWQgdGV4dC1zbVwiO1xuICAgICAgZXJyLnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyBwYWdlOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICByb290LnNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChlcnIpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoYXAua2luZCA9PT0gXCJwYXRjaC1tYW5hZ2VyXCIpIHtcbiAgICBjb25zdCByb290ID0gcGFuZWxTaGVsbChcIlBhdGNoIE1hbmFnZXJcIiwgXCJDaGVja2luZyBTdGFibGUgYW5kIEJldGEgcGF0Y2ggc3RhdGUuXCIpO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQocm9vdC5vdXRlcik7XG4gICAgcmVuZGVyUGF0Y2hNYW5hZ2VyUGFnZShyb290LnNlY3Rpb25zV3JhcCwgcm9vdC5zdWJ0aXRsZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdGl0bGUgPSBhcC5raW5kID09PSBcInR3ZWFrc1wiID8gXCJUd2Vha3NcIiA6IFwiQ29uZmlnXCI7XG4gIGNvbnN0IHN1YnRpdGxlID0gYXAua2luZCA9PT0gXCJ0d2Vha3NcIlxuICAgID8gXCJNYW5hZ2UgeW91ciBpbnN0YWxsZWQgQ29kZXgrKyB0d2Vha3MuXCJcbiAgICA6IFwiQ2hlY2tpbmcgaW5zdGFsbGVkIENvZGV4KysgdmVyc2lvbi5cIjtcbiAgY29uc3Qgcm9vdCA9IHBhbmVsU2hlbGwodGl0bGUsIHN1YnRpdGxlKTtcbiAgaG9zdC5hcHBlbmRDaGlsZChyb290Lm91dGVyKTtcbiAgaWYgKGFwLmtpbmQgPT09IFwidHdlYWtzXCIpIHJlbmRlclR3ZWFrc1BhZ2Uocm9vdC5zZWN0aW9uc1dyYXApO1xuICBlbHNlIHJlbmRlckNvbmZpZ1BhZ2Uocm9vdC5zZWN0aW9uc1dyYXAsIHJvb3Quc3VidGl0bGUpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgcGFnZXMgXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHJlbmRlckNvbmZpZ1BhZ2Uoc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCwgc3VidGl0bGU/OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiQ29kZXgrKyBVcGRhdGVzXCIpKTtcbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNvbnN0IGxvYWRpbmcgPSByb3dTaW1wbGUoXCJMb2FkaW5nIHVwZGF0ZSBzZXR0aW5nc1wiLCBcIkNoZWNraW5nIGN1cnJlbnQgQ29kZXgrKyBjb25maWd1cmF0aW9uLlwiKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChsb2FkaW5nKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuXG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnZXQtY29uZmlnXCIpXG4gICAgLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgaWYgKHN1YnRpdGxlKSB7XG4gICAgICAgIHN1YnRpdGxlLnRleHRDb250ZW50ID0gYFlvdSBoYXZlIENvZGV4KysgJHsoY29uZmlnIGFzIENvZGV4UGx1c1BsdXNDb25maWcpLnZlcnNpb259IGluc3RhbGxlZC5gO1xuICAgICAgfVxuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJDb2RleFBsdXNQbHVzQ29uZmlnKGNhcmQsIGNvbmZpZyBhcyBDb2RleFBsdXNQbHVzQ29uZmlnKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgaWYgKHN1YnRpdGxlKSBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IFwiQ291bGQgbm90IGxvYWQgaW5zdGFsbGVkIENvZGV4KysgdmVyc2lvbi5cIjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgbG9hZCB1cGRhdGUgc2V0dGluZ3NcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG5cbiAgY29uc3Qgd2F0Y2hlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICB3YXRjaGVyLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICB3YXRjaGVyLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkF1dG8tUmVwYWlyIFdhdGNoZXJcIikpO1xuICBjb25zdCB3YXRjaGVyQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIHdhdGNoZXJDYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIHdhdGNoZXJcIiwgXCJWZXJpZnlpbmcgdGhlIHVwZGF0ZXIgcmVwYWlyIHNlcnZpY2UuXCIpKTtcbiAgd2F0Y2hlci5hcHBlbmRDaGlsZCh3YXRjaGVyQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZCh3YXRjaGVyKTtcbiAgcmVuZGVyV2F0Y2hlckhlYWx0aENhcmQod2F0Y2hlckNhcmQpO1xuXG4gIGNvbnN0IGNkcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBjZHAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIGNkcC5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJEZXZlbG9wZXIgLyBDRFBcIikpO1xuICBjb25zdCBjZHBDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2RwQ2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyBDRFBcIiwgXCJSZWFkaW5nIENocm9tZSBEZXZUb29scyBQcm90b2NvbCBzdGF0dXMuXCIpKTtcbiAgY2RwLmFwcGVuZENoaWxkKGNkcENhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoY2RwKTtcbiAgcmVuZGVyQ2RwQ2FyZChjZHBDYXJkKTtcblxuICBjb25zdCBtYWludGVuYW5jZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBtYWludGVuYW5jZS5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgbWFpbnRlbmFuY2UuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiTWFpbnRlbmFuY2VcIikpO1xuICBjb25zdCBtYWludGVuYW5jZUNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBtYWludGVuYW5jZUNhcmQuYXBwZW5kQ2hpbGQodW5pbnN0YWxsUm93KCkpO1xuICBtYWludGVuYW5jZUNhcmQuYXBwZW5kQ2hpbGQocmVwb3J0QnVnUm93KCkpO1xuICBtYWludGVuYW5jZS5hcHBlbmRDaGlsZChtYWludGVuYW5jZUNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQobWFpbnRlbmFuY2UpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJQYXRjaE1hbmFnZXJQYWdlKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsIHN1YnRpdGxlPzogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgcmVmcmVzaCA9IGNvbXBhY3RCdXR0b24oXCJSZWZyZXNoXCIsICgpID0+IHtcbiAgICBzZWN0aW9uc1dyYXAudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIHJlbmRlclBhdGNoTWFuYWdlclBhZ2Uoc2VjdGlvbnNXcmFwLCBzdWJ0aXRsZSk7XG4gIH0pO1xuXG4gIGNvbnN0IG92ZXJ2aWV3ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIG92ZXJ2aWV3LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBvdmVydmlldy5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJTdGFibGUgLyBCZXRhXCIsIHJlZnJlc2gpKTtcbiAgY29uc3Qgb3ZlcnZpZXdDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgb3ZlcnZpZXdDYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIHBhdGNoIHN0YXRlXCIsIFwiUmVhZGluZyBDb2RleCsrIGhvbWVzIGFuZCBhcHAgYnVuZGxlcy5cIikpO1xuICBvdmVydmlldy5hcHBlbmRDaGlsZChvdmVydmlld0NhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQob3ZlcnZpZXcpO1xuXG4gIGNvbnN0IGNvbW1hbmRzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIGNvbW1hbmRzLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjb21tYW5kcy5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJDb21tYW5kc1wiKSk7XG4gIGNvbnN0IGNvbW1hbmRzQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNvbW1hbmRzQ2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMb2FkaW5nIGNvbW1hbmRzXCIsIFwiUHJlcGFyaW5nIGV4YWN0IHJlcGFpciBhbmQgcmVvcGVuIGNvbW1hbmRzLlwiKSk7XG4gIGNvbW1hbmRzLmFwcGVuZENoaWxkKGNvbW1hbmRzQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChjb21tYW5kcyk7XG5cbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC1wYXRjaC1tYW5hZ2VyLXN0YXR1c1wiKVxuICAgIC50aGVuKChzdGF0dXMpID0+IHtcbiAgICAgIGNvbnN0IHBhdGNoID0gc3RhdHVzIGFzIFBhdGNoTWFuYWdlclN0YXR1cztcbiAgICAgIGlmIChzdWJ0aXRsZSkge1xuICAgICAgICBzdWJ0aXRsZS50ZXh0Q29udGVudCA9XG4gICAgICAgICAgcGF0Y2guY3VycmVudENoYW5uZWwgPT09IFwidW5rbm93blwiXG4gICAgICAgICAgICA/IGBDaGVja2VkICR7bmV3IERhdGUocGF0Y2guY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpfS5gXG4gICAgICAgICAgICA6IGBSdW5uaW5nIGZyb20gJHtjaGFubmVsTGFiZWwocGF0Y2guY3VycmVudENoYW5uZWwpfS4gQ2hlY2tlZCAke25ldyBEYXRlKHBhdGNoLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgICAgIH1cbiAgICAgIG92ZXJ2aWV3Q2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjb21tYW5kc0NhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgZm9yIChjb25zdCBjaGFubmVsIG9mIHBhdGNoLmNoYW5uZWxzKSB7XG4gICAgICAgIG92ZXJ2aWV3Q2FyZC5hcHBlbmRDaGlsZChwYXRjaENoYW5uZWxSb3coY2hhbm5lbCkpO1xuICAgICAgICBjb21tYW5kc0NhcmQuYXBwZW5kQ2hpbGQocGF0Y2hDb21tYW5kUm93KGNoYW5uZWwpKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgaWYgKHN1YnRpdGxlKSBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IFwiQ291bGQgbm90IHJlYWQgcGF0Y2ggc3RhdGUuXCI7XG4gICAgICBvdmVydmlld0NhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY29tbWFuZHNDYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIG92ZXJ2aWV3Q2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJQYXRjaCBzdGF0ZSB1bmF2YWlsYWJsZVwiLCBTdHJpbmcoZSkpKTtcbiAgICAgIGNvbW1hbmRzQ2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb21tYW5kcyB1bmF2YWlsYWJsZVwiLCBcIlBhdGNoIHN0YXR1cyBmYWlsZWQgYmVmb3JlIGNvbW1hbmRzIHdlcmUgYnVpbHQuXCIpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gcGF0Y2hDaGFubmVsUm93KGNoYW5uZWw6IFBhdGNoQ2hhbm5lbFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuXG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhdHVzQmFkZ2UocGF0Y2hDaGFubmVsVG9uZShjaGFubmVsKSwgY2hhbm5lbC5jdXJyZW50ID8gYCR7Y2hhbm5lbC5sYWJlbH0gY3VycmVudGAgOiBjaGFubmVsLmxhYmVsKSk7XG5cbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gcGF0Y2hDaGFubmVsVGl0bGUoY2hhbm5lbCk7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IHBhdGNoQ2hhbm5lbFN1bW1hcnkoY2hhbm5lbCk7XG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtZXRhLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRydW5jYXRlIHRleHQteHNcIjtcbiAgbWV0YS50ZXh0Q29udGVudCA9IGNoYW5uZWwuYXBwUm9vdDtcbiAgc3RhY2suYXBwZW5kKHRpdGxlLCBkZXNjLCBtZXRhKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIlJldmVhbFwiLCAoKSA9PiB7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6cmV2ZWFsXCIsIGNoYW5uZWwudXNlclJvb3QpO1xuICAgIH0pLFxuICApO1xuICBpZiAoY2hhbm5lbC5jZHAuanNvbkxpc3RVcmwpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlRhcmdldHNcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1jZHAtdXJsXCIsIGNoYW5uZWwuY2RwLmpzb25MaXN0VXJsKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBwYXRjaENvbW1hbmRSb3coY2hhbm5lbDogUGF0Y2hDaGFubmVsU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgYCR7Y2hhbm5lbC5sYWJlbH0gcmVwYWlyYCxcbiAgICBgJHtjb21tYW5kU3VtbWFyeShjaGFubmVsKX0gU2F2ZWQgQ0RQICR7Y2hhbm5lbC5jZHAuY29uZmlndXJlZFBvcnR9OyBkZWZhdWx0ICR7Y2hhbm5lbC5jZHAuZXhwZWN0ZWRQb3J0fS5gLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChjb3B5Q29tbWFuZEJ1dHRvbihcIlJlcGFpclwiLCBjaGFubmVsLmNvbW1hbmRzLnJlcGFpcikpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKGNvcHlDb21tYW5kQnV0dG9uKFwiUmVvcGVuXCIsIGNoYW5uZWwuY29tbWFuZHMucmVvcGVuV2l0aENkcCkpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKGNvcHlDb21tYW5kQnV0dG9uKFwiU3RhdHVzXCIsIGNoYW5uZWwuY29tbWFuZHMuc3RhdHVzKSk7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoY29weUNvbW1hbmRCdXR0b24oXCJVcGRhdGVcIiwgY2hhbm5lbC5jb21tYW5kcy51cGRhdGVDb2RleCkpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb3B5Q29tbWFuZEJ1dHRvbihsYWJlbDogc3RyaW5nLCBjb21tYW5kOiBzdHJpbmcpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIHJldHVybiBjb21wYWN0QnV0dG9uKGxhYmVsLCAoKSA9PiB7XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvcHktdGV4dFwiLCBjb21tYW5kKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHBhdGNoQ2hhbm5lbFRpdGxlKGNoYW5uZWw6IFBhdGNoQ2hhbm5lbFN0YXR1cyk6IHN0cmluZyB7XG4gIGlmICghY2hhbm5lbC5zdGF0ZUV4aXN0cykgcmV0dXJuIGAke2NoYW5uZWwubGFiZWx9IGlzIG5vdCBpbnN0YWxsZWQgdGhyb3VnaCBDb2RleCsrYDtcbiAgY29uc3QgY29kZXggPSBjaGFubmVsLmNvZGV4VmVyc2lvbiA/IGBDb2RleCAke2NoYW5uZWwuY29kZXhWZXJzaW9ufWAgOiBcIkNvZGV4IHZlcnNpb24gdW5rbm93blwiO1xuICBjb25zdCBjb2RleHBwID0gY2hhbm5lbC5jb2RleFBsdXNQbHVzVmVyc2lvbiA/IGBDb2RleCsrICR7Y2hhbm5lbC5jb2RleFBsdXNQbHVzVmVyc2lvbn1gIDogXCJDb2RleCsrIHZlcnNpb24gdW5rbm93blwiO1xuICByZXR1cm4gYCR7Y29kZXh9IFx1MDBCNyAke2NvZGV4cHB9YDtcbn1cblxuZnVuY3Rpb24gcGF0Y2hDaGFubmVsU3VtbWFyeShjaGFubmVsOiBQYXRjaENoYW5uZWxTdGF0dXMpOiBzdHJpbmcge1xuICBjb25zdCBydW50aW1lID0gY2hhbm5lbC5ydW50aW1lUHJlbG9hZEV4aXN0c1xuICAgID8gYHJ1bnRpbWUgJHtmb3JtYXRCeXRlcyhjaGFubmVsLnJ1bnRpbWVQcmVsb2FkQnl0ZXMpfWBcbiAgICA6IFwicnVudGltZSBtaXNzaW5nXCI7XG4gIGNvbnN0IHdhdGNoZXIgPSBjaGFubmVsLndhdGNoZXJMb2FkZWQgPT09IG51bGxcbiAgICA/IFwid2F0Y2hlciB1bmtub3duXCJcbiAgICA6IGNoYW5uZWwud2F0Y2hlckxvYWRlZFxuICAgICAgPyBcIndhdGNoZXIgbG9hZGVkXCJcbiAgICAgIDogXCJ3YXRjaGVyIG5vdCBsb2FkZWRcIjtcbiAgY29uc3QgY2RwID0gY2hhbm5lbC5jZHAuYWN0aXZlXG4gICAgPyBgQ0RQIGFjdGl2ZSBvbiAke2NoYW5uZWwuY2RwLmFjdGl2ZVBvcnR9YFxuICAgIDogY2hhbm5lbC5jZHAuZW5hYmxlZFxuICAgICAgPyBgQ0RQIHNhdmVkIG9uICR7Y2hhbm5lbC5jZHAuY29uZmlndXJlZFBvcnR9YFxuICAgICAgOiBcIkNEUCBvZmZcIjtcbiAgY29uc3QgZHJpZnQgPSBjaGFubmVsLmNkcC5kcmlmdCA/IGA7IGV4cGVjdGVkICR7Y2hhbm5lbC5jZHAuZXhwZWN0ZWRQb3J0fWAgOiBcIlwiO1xuICByZXR1cm4gYCR7cnVudGltZX07ICR7d2F0Y2hlcn07ICR7Y2RwfSR7ZHJpZnR9LmA7XG59XG5cbmZ1bmN0aW9uIGNvbW1hbmRTdW1tYXJ5KGNoYW5uZWw6IFBhdGNoQ2hhbm5lbFN0YXR1cyk6IHN0cmluZyB7XG4gIGlmICghY2hhbm5lbC5hcHBFeGlzdHMpIHJldHVybiBcIkFwcCBidW5kbGUgaXMgbWlzc2luZyBhdCB0aGUgcmVjb3JkZWQgcGF0aC5cIjtcbiAgaWYgKCFjaGFubmVsLnJ1bnRpbWVQcmVsb2FkRXhpc3RzKSByZXR1cm4gXCJSdW50aW1lIHByZWxvYWQgaXMgbWlzc2luZzsgcmVwYWlyIHNob3VsZCByZWZyZXNoIGl0LlwiO1xuICBpZiAoIWNoYW5uZWwuYXV0b1VwZGF0ZSkgcmV0dXJuIFwiQXV0b21hdGljIHJlcGFpciBpcyBkaXNhYmxlZC5cIjtcbiAgcmV0dXJuIFwiUGF0Y2ggZmlsZXMgYXJlIHByZXNlbnQuXCI7XG59XG5cbmZ1bmN0aW9uIHBhdGNoQ2hhbm5lbFRvbmUoY2hhbm5lbDogUGF0Y2hDaGFubmVsU3RhdHVzKTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIge1xuICBpZiAoIWNoYW5uZWwuc3RhdGVFeGlzdHMgfHwgIWNoYW5uZWwuYXBwRXhpc3RzIHx8ICFjaGFubmVsLnJ1bnRpbWVQcmVsb2FkRXhpc3RzKSByZXR1cm4gXCJlcnJvclwiO1xuICBpZiAoY2hhbm5lbC53YXRjaGVyTG9hZGVkID09PSBmYWxzZSB8fCBjaGFubmVsLmNkcC5kcmlmdCB8fCAhY2hhbm5lbC5hdXRvVXBkYXRlKSByZXR1cm4gXCJ3YXJuXCI7XG4gIHJldHVybiBcIm9rXCI7XG59XG5cbmZ1bmN0aW9uIGNoYW5uZWxMYWJlbChjaGFubmVsOiBQYXRjaE1hbmFnZXJTdGF0dXNbXCJjdXJyZW50Q2hhbm5lbFwiXSk6IHN0cmluZyB7XG4gIGlmIChjaGFubmVsID09PSBcInN0YWJsZVwiKSByZXR1cm4gXCJTdGFibGVcIjtcbiAgaWYgKGNoYW5uZWwgPT09IFwiYmV0YVwiKSByZXR1cm4gXCJCZXRhXCI7XG4gIHJldHVybiBcIlVua25vd25cIjtcbn1cblxuZnVuY3Rpb24gZm9ybWF0Qnl0ZXMoYnl0ZXM6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoYnl0ZXMgPT09IG51bGwpIHJldHVybiBcIm1pc3NpbmdcIjtcbiAgaWYgKGJ5dGVzIDwgMTAyNCkgcmV0dXJuIGAke2J5dGVzfSBCYDtcbiAgaWYgKGJ5dGVzIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHtNYXRoLnJvdW5kKGJ5dGVzIC8gMTAyNCl9IEtCYDtcbiAgcmV0dXJuIGAkeyhieXRlcyAvICgxMDI0ICogMTAyNCkpLnRvRml4ZWQoMSl9IE1CYDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkOiBIVE1MRWxlbWVudCwgY29uZmlnOiBDb2RleFBsdXNQbHVzQ29uZmlnKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoYXV0b1VwZGF0ZVJvdyhjb25maWcpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnLnVwZGF0ZUNoZWNrKSk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hlY2spIGNhcmQuYXBwZW5kQ2hpbGQocmVsZWFzZU5vdGVzUm93KGNvbmZpZy51cGRhdGVDaGVjaykpO1xufVxuXG5mdW5jdGlvbiBhdXRvVXBkYXRlUm93KGNvbmZpZzogQ29kZXhQbHVzUGx1c0NvbmZpZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJBdXRvbWF0aWNhbGx5IHJlZnJlc2ggQ29kZXgrK1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgSW5zdGFsbGVkIHZlcnNpb24gdiR7Y29uZmlnLnZlcnNpb259LiBUaGUgd2F0Y2hlciBjYW4gcmVmcmVzaCB0aGUgQ29kZXgrKyBydW50aW1lIGFmdGVyIHlvdSByZXJ1biB0aGUgR2l0SHViIGluc3RhbGxlci5gO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICByb3cuYXBwZW5kQ2hpbGQoXG4gICAgc3dpdGNoQ29udHJvbChjb25maWcuYXV0b1VwZGF0ZSwgYXN5bmMgKG5leHQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6c2V0LWF1dG8tdXBkYXRlXCIsIG5leHQpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXNSb3coY2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayB8IG51bGwpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGNoZWNrPy51cGRhdGVBdmFpbGFibGUgPyBcIkNvZGV4KysgdXBkYXRlIGF2YWlsYWJsZVwiIDogXCJDb2RleCsrIGlzIHVwIHRvIGRhdGVcIjtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gdXBkYXRlU3VtbWFyeShjaGVjayk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBpZiAoY2hlY2s/LnJlbGVhc2VVcmwpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlJlbGVhc2UgTm90ZXNcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCBjaGVjay5yZWxlYXNlVXJsKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgTm93XCIsICgpID0+IHtcbiAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCIwLjY1XCI7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJjb2RleHBwOmNoZWNrLWNvZGV4cHAtdXBkYXRlXCIsIHRydWUpXG4gICAgICAgIC50aGVuKChuZXh0KSA9PiB7XG4gICAgICAgICAgY29uc3QgY2FyZCA9IHJvdy5wYXJlbnRFbGVtZW50O1xuICAgICAgICAgIGlmICghY2FyZCkgcmV0dXJuO1xuICAgICAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnZXQtY29uZmlnXCIpLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgICAgICAgcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkLCB7XG4gICAgICAgICAgICAgIC4uLihjb25maWcgYXMgQ29kZXhQbHVzUGx1c0NvbmZpZyksXG4gICAgICAgICAgICAgIHVwZGF0ZUNoZWNrOiBuZXh0IGFzIENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJDb2RleCsrIHVwZGF0ZSBjaGVjayBmYWlsZWRcIiwgU3RyaW5nKGUpKSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCJcIjtcbiAgICAgICAgfSk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVsZWFzZU5vdGVzUm93KGNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTIgcC0zXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJMYXRlc3QgcmVsZWFzZSBub3Rlc1wiO1xuICByb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5jbGFzc05hbWUgPVxuICAgIFwibWF4LWgtNjAgb3ZlcmZsb3ctYXV0byByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJvZHkuYXBwZW5kQ2hpbGQocmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24oY2hlY2sucmVsZWFzZU5vdGVzPy50cmltKCkgfHwgY2hlY2suZXJyb3IgfHwgXCJObyByZWxlYXNlIG5vdGVzIGF2YWlsYWJsZS5cIikpO1xuICByb3cuYXBwZW5kQ2hpbGQoYm9keSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNkcENhcmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC1jZHAtc3RhdHVzXCIpXG4gICAgLnRoZW4oKHN0YXR1cykgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJDZHBTdGF0dXMoY2FyZCwgc3RhdHVzIGFzIENvZGV4Q2RwU3RhdHVzKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCByZWFkIENEUCBzdGF0dXNcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNkcFN0YXR1cyhjYXJkOiBIVE1MRWxlbWVudCwgc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IHZvaWQge1xuICBjYXJkLmFwcGVuZENoaWxkKGNkcFRvZ2dsZVJvdyhjYXJkLCBzdGF0dXMpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjZHBQb3J0Um93KGNhcmQsIHN0YXR1cykpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNkcEVuZHBvaW50Um93KHN0YXR1cykpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNkcExhdW5jaFJvdyhzdGF0dXMpKTtcbiAgaWYgKHN0YXR1cy5yZXN0YXJ0UmVxdWlyZWQpIHtcbiAgICBjYXJkLmFwcGVuZENoaWxkKFxuICAgICAgcm93U2ltcGxlKFxuICAgICAgICBcIlJlc3RhcnQgcmVxdWlyZWRcIixcbiAgICAgICAgc3RhdHVzLmVuYWJsZWRcbiAgICAgICAgICA/IFwiQ0RQIHdpbGwgdXNlIHRoZSBzYXZlZCBwb3J0IGFmdGVyIENvZGV4IHJlc3RhcnRzLlwiXG4gICAgICAgICAgOiBcIkNEUCBpcyBzdGlsbCBhY3RpdmUgZm9yIHRoaXMgcHJvY2VzcyBhbmQgd2lsbCB0dXJuIG9mZiBhZnRlciBDb2RleCByZXN0YXJ0cy5cIixcbiAgICAgICksXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjZHBUb2dnbGVSb3coY2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcblxuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1zdGFydCBnYXAtM1wiO1xuICBsZWZ0LmFwcGVuZENoaWxkKGNkcFN0YXR1c0JhZGdlKHN0YXR1cykpO1xuXG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiQ2hyb21lIERldlRvb2xzIFByb3RvY29sXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGNkcFN0YXR1c1N1bW1hcnkoc3RhdHVzKTtcbiAgc3RhY2suYXBwZW5kKHRpdGxlLCBkZXNjKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICByb3cuYXBwZW5kQ2hpbGQoXG4gICAgc3dpdGNoQ29udHJvbChzdGF0dXMuZW5hYmxlZCwgYXN5bmMgKGVuYWJsZWQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6c2V0LWNkcC1jb25maWdcIiwge1xuICAgICAgICBlbmFibGVkLFxuICAgICAgICBwb3J0OiBzdGF0dXMuY29uZmlndXJlZFBvcnQsXG4gICAgICB9KTtcbiAgICAgIHJlZnJlc2hDZHBDYXJkKGNhcmQpO1xuICAgIH0pLFxuICApO1xuXG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNkcFBvcnRSb3coY2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIlJlbW90ZSBkZWJ1Z2dpbmcgcG9ydFwiLFxuICAgIHN0YXR1cy5hY3RpdmVQb3J0XG4gICAgICA/IGBDdXJyZW50IHByb2Nlc3MgaXMgbGlzdGVuaW5nIG9uICR7c3RhdHVzLmFjdGl2ZVBvcnR9LmBcbiAgICAgIDogYFNhdmVkIHBvcnQgaXMgJHtzdGF0dXMuY29uZmlndXJlZFBvcnR9LmAsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbnB1dFwiKTtcbiAgaW5wdXQudHlwZSA9IFwibnVtYmVyXCI7XG4gIGlucHV0Lm1pbiA9IFwiMVwiO1xuICBpbnB1dC5tYXggPSBcIjY1NTM1XCI7XG4gIGlucHV0LnN0ZXAgPSBcIjFcIjtcbiAgaW5wdXQudmFsdWUgPSBTdHJpbmcoc3RhdHVzLmNvbmZpZ3VyZWRQb3J0KTtcbiAgaW5wdXQuY2xhc3NOYW1lID1cbiAgICBcImgtOCB3LTI0IHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdHJhbnNwYXJlbnQgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGZvY3VzOm91dGxpbmUtbm9uZSBmb2N1czpyaW5nLTIgZm9jdXM6cmluZy10b2tlbi1mb2N1cy1ib3JkZXJcIjtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChpbnB1dCk7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIlNhdmVcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgcG9ydCA9IE51bWJlcihpbnB1dC52YWx1ZSk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJjb2RleHBwOnNldC1jZHAtY29uZmlnXCIsIHtcbiAgICAgICAgICBlbmFibGVkOiBzdGF0dXMuZW5hYmxlZCxcbiAgICAgICAgICBwb3J0OiBOdW1iZXIuaXNJbnRlZ2VyKHBvcnQpID8gcG9ydCA6IHN0YXR1cy5jb25maWd1cmVkUG9ydCxcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oKCkgPT4gcmVmcmVzaENkcENhcmQoY2FyZCkpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcIkNEUCBwb3J0IHNhdmUgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjZHBFbmRwb2ludFJvdyhzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgc3RhdHVzLmFjdGl2ZSA/IFwiTG9jYWwgQ0RQIGVuZHBvaW50c1wiIDogXCJMb2NhbCBDRFAgZW5kcG9pbnRzXCIsXG4gICAgc3RhdHVzLmFjdGl2ZSAmJiBzdGF0dXMuanNvbkxpc3RVcmxcbiAgICAgID8gYCR7c3RhdHVzLmpzb25MaXN0VXJsfWBcbiAgICAgIDogXCJOb3QgZXhwb3NlZCBieSB0aGUgY3VycmVudCBDb2RleCBwcm9jZXNzLlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgY29uc3Qgb3BlblRhcmdldHMgPSBjb21wYWN0QnV0dG9uKFwiT3BlbiBUYXJnZXRzXCIsICgpID0+IHtcbiAgICBpZiAoIXN0YXR1cy5qc29uTGlzdFVybCkgcmV0dXJuO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWNkcC11cmxcIiwgc3RhdHVzLmpzb25MaXN0VXJsKTtcbiAgfSk7XG4gIG9wZW5UYXJnZXRzLmRpc2FibGVkID0gIXN0YXR1cy5qc29uTGlzdFVybDtcbiAgY29uc3QgY29weVRhcmdldHMgPSBjb21wYWN0QnV0dG9uKFwiQ29weSBVUkxcIiwgKCkgPT4ge1xuICAgIGlmICghc3RhdHVzLmpzb25MaXN0VXJsKSByZXR1cm47XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvcHktdGV4dFwiLCBzdGF0dXMuanNvbkxpc3RVcmwpO1xuICB9KTtcbiAgY29weVRhcmdldHMuZGlzYWJsZWQgPSAhc3RhdHVzLmpzb25MaXN0VXJsO1xuICBjb25zdCBvcGVuVmVyc2lvbiA9IGNvbXBhY3RCdXR0b24oXCJWZXJzaW9uXCIsICgpID0+IHtcbiAgICBpZiAoIXN0YXR1cy5qc29uVmVyc2lvblVybCkgcmV0dXJuO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWNkcC11cmxcIiwgc3RhdHVzLmpzb25WZXJzaW9uVXJsKTtcbiAgfSk7XG4gIG9wZW5WZXJzaW9uLmRpc2FibGVkID0gIXN0YXR1cy5qc29uVmVyc2lvblVybDtcbiAgYWN0aW9uPy5hcHBlbmQob3BlblRhcmdldHMsIGNvcHlUYXJnZXRzLCBvcGVuVmVyc2lvbik7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNkcExhdW5jaFJvdyhzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJMYXVuY2ggY29tbWFuZFwiLFxuICAgIHN0YXR1cy5hcHBSb290ID8gc3RhdHVzLmFwcFJvb3QgOiBcIkNvZGV4IGFwcCBwYXRoIHdhcyBub3QgZm91bmQgaW4gaW5zdGFsbGVyIHN0YXRlLlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBDb21tYW5kXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb3B5LXRleHRcIiwgc3RhdHVzLmxhdW5jaENvbW1hbmQpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZWZyZXNoQ2RwQ2FyZChjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyBDRFBcIiwgXCJSZWFkaW5nIENocm9tZSBEZXZUb29scyBQcm90b2NvbCBzdGF0dXMuXCIpKTtcbiAgcmVuZGVyQ2RwQ2FyZChjYXJkKTtcbn1cblxuZnVuY3Rpb24gY2RwU3RhdHVzQmFkZ2Uoc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgaWYgKHN0YXR1cy5hY3RpdmUpIHJldHVybiBzdGF0dXNCYWRnZShzdGF0dXMucmVzdGFydFJlcXVpcmVkID8gXCJ3YXJuXCIgOiBcIm9rXCIsIFwiQWN0aXZlXCIpO1xuICBpZiAoc3RhdHVzLnJlc3RhcnRSZXF1aXJlZCkgcmV0dXJuIHN0YXR1c0JhZGdlKFwid2FyblwiLCBcIlJlc3RhcnRcIik7XG4gIHJldHVybiBzdGF0dXNCYWRnZShzdGF0dXMuZW5hYmxlZCA/IFwid2FyblwiIDogXCJ3YXJuXCIsIHN0YXR1cy5lbmFibGVkID8gXCJTYXZlZFwiIDogXCJPZmZcIik7XG59XG5cbmZ1bmN0aW9uIGNkcFN0YXR1c1N1bW1hcnkoc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IHN0cmluZyB7XG4gIGlmIChzdGF0dXMuYWN0aXZlUG9ydCkge1xuICAgIGNvbnN0IHNvdXJjZSA9IHN0YXR1cy5zb3VyY2UgPT09IFwiYXJndlwiID8gXCJsYXVuY2ggYXJnXCIgOiBzdGF0dXMuc291cmNlO1xuICAgIHJldHVybiBgQWN0aXZlIG9uIDEyNy4wLjAuMToke3N0YXR1cy5hY3RpdmVQb3J0fSBmcm9tICR7c291cmNlfS5gO1xuICB9XG4gIGlmIChzdGF0dXMuZW5hYmxlZCkge1xuICAgIHJldHVybiBgRW5hYmxlZCBmb3IgbmV4dCBsYXVuY2ggb24gMTI3LjAuMC4xOiR7c3RhdHVzLmNvbmZpZ3VyZWRQb3J0fS5gO1xuICB9XG4gIHJldHVybiBcIkRpc2FibGVkIGZvciBDb2RleCBsYXVuY2hlcyBtYW5hZ2VkIGJ5IENvZGV4KysuXCI7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJlbGVhc2VOb3Rlc01hcmtkb3duKG1hcmtkb3duOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb290LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjb25zdCBsaW5lcyA9IG1hcmtkb3duLnJlcGxhY2UoL1xcclxcbj8vZywgXCJcXG5cIikuc3BsaXQoXCJcXG5cIik7XG4gIGxldCBwYXJhZ3JhcGg6IHN0cmluZ1tdID0gW107XG4gIGxldCBsaXN0OiBIVE1MT0xpc3RFbGVtZW50IHwgSFRNTFVMaXN0RWxlbWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgY29kZUxpbmVzOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IGZsdXNoUGFyYWdyYXBoID0gKCkgPT4ge1xuICAgIGlmIChwYXJhZ3JhcGgubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwXCIpO1xuICAgIHAuY2xhc3NOYW1lID0gXCJtLTAgbGVhZGluZy01XCI7XG4gICAgYXBwZW5kSW5saW5lTWFya2Rvd24ocCwgcGFyYWdyYXBoLmpvaW4oXCIgXCIpLnRyaW0oKSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwKTtcbiAgICBwYXJhZ3JhcGggPSBbXTtcbiAgfTtcbiAgY29uc3QgZmx1c2hMaXN0ID0gKCkgPT4ge1xuICAgIGlmICghbGlzdCkgcmV0dXJuO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQobGlzdCk7XG4gICAgbGlzdCA9IG51bGw7XG4gIH07XG4gIGNvbnN0IGZsdXNoQ29kZSA9ICgpID0+IHtcbiAgICBpZiAoIWNvZGVMaW5lcykgcmV0dXJuO1xuICAgIGNvbnN0IHByZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwcmVcIik7XG4gICAgcHJlLmNsYXNzTmFtZSA9XG4gICAgICBcIm0tMCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIGNvbnN0IGNvZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY29kZVwiKTtcbiAgICBjb2RlLnRleHRDb250ZW50ID0gY29kZUxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgcHJlLmFwcGVuZENoaWxkKGNvZGUpO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQocHJlKTtcbiAgICBjb2RlTGluZXMgPSBudWxsO1xuICB9O1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmIChsaW5lLnRyaW0oKS5zdGFydHNXaXRoKFwiYGBgXCIpKSB7XG4gICAgICBpZiAoY29kZUxpbmVzKSBmbHVzaENvZGUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgY29kZUxpbmVzID0gW107XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNvZGVMaW5lcykge1xuICAgICAgY29kZUxpbmVzLnB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG4gICAgaWYgKCF0cmltbWVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkaW5nID0gL14oI3sxLDN9KVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAoaGVhZGluZykge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoaGVhZGluZ1sxXS5sZW5ndGggPT09IDEgPyBcImgzXCIgOiBcImg0XCIpO1xuICAgICAgaC5jbGFzc05hbWUgPSBcIm0tMCB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihoLCBoZWFkaW5nWzJdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoaCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB1bm9yZGVyZWQgPSAvXlstKl1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgY29uc3Qgb3JkZXJlZCA9IC9eXFxkK1suKV1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHVub3JkZXJlZCB8fCBvcmRlcmVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgY29uc3Qgd2FudE9yZGVyZWQgPSBCb29sZWFuKG9yZGVyZWQpO1xuICAgICAgaWYgKCFsaXN0IHx8ICh3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiT0xcIikgfHwgKCF3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiVUxcIikpIHtcbiAgICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICAgIGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHdhbnRPcmRlcmVkID8gXCJvbFwiIDogXCJ1bFwiKTtcbiAgICAgICAgbGlzdC5jbGFzc05hbWUgPSB3YW50T3JkZXJlZFxuICAgICAgICAgID8gXCJtLTAgbGlzdC1kZWNpbWFsIHNwYWNlLXktMSBwbC01IGxlYWRpbmctNVwiXG4gICAgICAgICAgOiBcIm0tMCBsaXN0LWRpc2Mgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCI7XG4gICAgICB9XG4gICAgICBjb25zdCBsaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGxpLCAodW5vcmRlcmVkID8/IG9yZGVyZWQpPy5bMV0gPz8gXCJcIik7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGxpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHF1b3RlID0gL14+XFxzPyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChxdW90ZSkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgYmxvY2txdW90ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJibG9ja3F1b3RlXCIpO1xuICAgICAgYmxvY2txdW90ZS5jbGFzc05hbWUgPSBcIm0tMCBib3JkZXItbC0yIGJvcmRlci10b2tlbi1ib3JkZXIgcGwtMyBsZWFkaW5nLTVcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGJsb2NrcXVvdGUsIHF1b3RlWzFdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoYmxvY2txdW90ZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBwYXJhZ3JhcGgucHVzaCh0cmltbWVkKTtcbiAgfVxuXG4gIGZsdXNoUGFyYWdyYXBoKCk7XG4gIGZsdXNoTGlzdCgpO1xuICBmbHVzaENvZGUoKTtcbiAgcmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZElubGluZU1hcmtkb3duKHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBwYXR0ZXJuID0gLyhgKFteYF0rKWB8XFxbKFteXFxdXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCl8XFwqXFwqKFteKl0rKVxcKlxcKnxcXCooW14qXSspXFwqKS9nO1xuICBsZXQgbGFzdEluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZXh0Lm1hdGNoQWxsKHBhdHRlcm4pKSB7XG4gICAgaWYgKG1hdGNoLmluZGV4ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCwgbWF0Y2guaW5kZXgpKTtcbiAgICBpZiAobWF0Y2hbMl0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgICAgY29kZS5jbGFzc05hbWUgPVxuICAgICAgICBcInJvdW5kZWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBweC0xIHB5LTAuNSB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBjb2RlLnRleHRDb250ZW50ID0gbWF0Y2hbMl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFszXSAhPT0gdW5kZWZpbmVkICYmIG1hdGNoWzRdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICAgIGEuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSB1bmRlcmxpbmUgdW5kZXJsaW5lLW9mZnNldC0yXCI7XG4gICAgICBhLmhyZWYgPSBtYXRjaFs0XTtcbiAgICAgIGEudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICAgIGEucmVsID0gXCJub29wZW5lciBub3JlZmVycmVyXCI7XG4gICAgICBhLnRleHRDb250ZW50ID0gbWF0Y2hbM107XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoYSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs1XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBzdHJvbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3Ryb25nXCIpO1xuICAgICAgc3Ryb25nLmNsYXNzTmFtZSA9IFwiZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIHN0cm9uZy50ZXh0Q29udGVudCA9IG1hdGNoWzVdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKHN0cm9uZyk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs2XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJlbVwiKTtcbiAgICAgIGVtLnRleHRDb250ZW50ID0gbWF0Y2hbNl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoZW0pO1xuICAgIH1cbiAgICBsYXN0SW5kZXggPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgfVxuICBhcHBlbmRUZXh0KHBhcmVudCwgdGV4dC5zbGljZShsYXN0SW5kZXgpKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kVGV4dChwYXJlbnQ6IEhUTUxFbGVtZW50LCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHRleHQpIHBhcmVudC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnZXQtd2F0Y2hlci1oZWFsdGhcIilcbiAgICAudGhlbigoaGVhbHRoKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwgaGVhbHRoIGFzIFdhdGNoZXJIZWFsdGgpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGNoZWNrIHdhdGNoZXJcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZDogSFRNTEVsZW1lbnQsIGhlYWx0aDogV2F0Y2hlckhlYWx0aCk6IHZvaWQge1xuICBjYXJkLmFwcGVuZENoaWxkKHdhdGNoZXJTdW1tYXJ5Um93KGhlYWx0aCkpO1xuICBmb3IgKGNvbnN0IGNoZWNrIG9mIGhlYWx0aC5jaGVja3MpIHtcbiAgICBpZiAoY2hlY2suc3RhdHVzID09PSBcIm9rXCIpIGNvbnRpbnVlO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQod2F0Y2hlckNoZWNrUm93KGNoZWNrKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gd2F0Y2hlclN1bW1hcnlSb3coaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhdHVzQmFkZ2UoaGVhbHRoLnN0YXR1cywgaGVhbHRoLndhdGNoZXIpKTtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gaGVhbHRoLnRpdGxlO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgJHtoZWFsdGguc3VtbWFyeX0gQ2hlY2tlZCAke25ldyBEYXRlKGhlYWx0aC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCl9LmA7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgY29uc3QgYWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgYWN0aW9uLmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDaGVjayBOb3dcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY2FyZCA9IHJvdy5wYXJlbnRFbGVtZW50O1xuICAgICAgaWYgKCFjYXJkKSByZXR1cm47XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgd2F0Y2hlclwiLCBcIlZlcmlmeWluZyB0aGUgdXBkYXRlciByZXBhaXIgc2VydmljZS5cIikpO1xuICAgICAgcmVuZGVyV2F0Y2hlckhlYWx0aENhcmQoY2FyZCk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb24pO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiB3YXRjaGVyQ2hlY2tSb3coY2hlY2s6IFdhdGNoZXJIZWFsdGhDaGVjayk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gcm93U2ltcGxlKGNoZWNrLm5hbWUsIGNoZWNrLmRldGFpbCk7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGVmdCkgbGVmdC5wcmVwZW5kKHN0YXR1c0JhZGdlKGNoZWNrLnN0YXR1cykpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBzdGF0dXNCYWRnZShzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiLCBsYWJlbD86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29uc3QgdG9uZSA9XG4gICAgc3RhdHVzID09PSBcIm9rXCJcbiAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLWdyZWVuIHRleHQtdG9rZW4tY2hhcnRzLWdyZWVuXCJcbiAgICAgIDogc3RhdHVzID09PSBcIndhcm5cIlxuICAgICAgICA/IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy15ZWxsb3cgdGV4dC10b2tlbi1jaGFydHMteWVsbG93XCJcbiAgICAgICAgOiBcImJvcmRlci10b2tlbi1jaGFydHMtcmVkIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICBiYWRnZS5jbGFzc05hbWUgPSBgaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCBib3JkZXIgcHgtMiBweS0wLjUgdGV4dC14cyBmb250LW1lZGl1bSAke3RvbmV9YDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBsYWJlbCB8fCAoc3RhdHVzID09PSBcIm9rXCIgPyBcIk9LXCIgOiBzdGF0dXMgPT09IFwid2FyblwiID8gXCJSZXZpZXdcIiA6IFwiRXJyb3JcIik7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlU3VtbWFyeShjaGVjazogQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmICghY2hlY2spIHJldHVybiBcIk5vIHVwZGF0ZSBjaGVjayBoYXMgcnVuIHlldC5cIjtcbiAgY29uc3QgbGF0ZXN0ID0gY2hlY2subGF0ZXN0VmVyc2lvbiA/IGBMYXRlc3QgdiR7Y2hlY2subGF0ZXN0VmVyc2lvbn0uIGAgOiBcIlwiO1xuICBjb25zdCBjaGVja2VkID0gYENoZWNrZWQgJHtuZXcgRGF0ZShjaGVjay5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCl9LmA7XG4gIGlmIChjaGVjay5lcnJvcikgcmV0dXJuIGAke2xhdGVzdH0ke2NoZWNrZWR9ICR7Y2hlY2suZXJyb3J9YDtcbiAgcmV0dXJuIGAke2xhdGVzdH0ke2NoZWNrZWR9YDtcbn1cblxuZnVuY3Rpb24gdW5pbnN0YWxsUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiVW5pbnN0YWxsIENvZGV4KytcIixcbiAgICBcIkNvcGllcyB0aGUgdW5pbnN0YWxsIGNvbW1hbmQuIFJ1biBpdCBmcm9tIGEgdGVybWluYWwgYWZ0ZXIgcXVpdHRpbmcgQ29kZXguXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDb3B5IENvbW1hbmRcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpjb3B5LXRleHRcIiwgXCJub2RlIH4vLmNvZGV4LXBsdXNwbHVzL3NvdXJjZS9wYWNrYWdlcy9pbnN0YWxsZXIvZGlzdC9jbGkuanMgdW5pbnN0YWxsXCIpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNvcHkgdW5pbnN0YWxsIGNvbW1hbmQgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZXBvcnRCdWdSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJSZXBvcnQgYSBidWdcIixcbiAgICBcIk9wZW4gYSBHaXRIdWIgaXNzdWUgd2l0aCBydW50aW1lLCBpbnN0YWxsZXIsIG9yIHR3ZWFrLW1hbmFnZXIgZGV0YWlscy5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIk9wZW4gSXNzdWVcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgdGl0bGUgPSBlbmNvZGVVUklDb21wb25lbnQoXCJbQnVnXTogXCIpO1xuICAgICAgY29uc3QgYm9keSA9IGVuY29kZVVSSUNvbXBvbmVudChcbiAgICAgICAgW1xuICAgICAgICAgIFwiIyMgV2hhdCBoYXBwZW5lZD9cIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgU3RlcHMgdG8gcmVwcm9kdWNlXCIsXG4gICAgICAgICAgXCIxLiBcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgRW52aXJvbm1lbnRcIixcbiAgICAgICAgICBcIi0gQ29kZXgrKyB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gQ29kZXggYXBwIHZlcnNpb246IFwiLFxuICAgICAgICAgIFwiLSBPUzogXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIExvZ3NcIixcbiAgICAgICAgICBcIkF0dGFjaCByZWxldmFudCBsaW5lcyBmcm9tIHRoZSBDb2RleCsrIGxvZyBkaXJlY3RvcnkuXCIsXG4gICAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgICk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIixcbiAgICAgICAgYGh0dHBzOi8vZ2l0aHViLmNvbS9hZ3VzdGlmL2NvZGV4LXBsdXNwbHVzL2lzc3Vlcy9uZXc/dGl0bGU9JHt0aXRsZX0mYm9keT0ke2JvZHl9YCxcbiAgICAgICk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGFjdGlvblJvdyh0aXRsZVRleHQ6IHN0cmluZywgZGVzY3JpcHRpb246IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gdGl0bGVUZXh0O1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuZGF0YXNldC5jb2RleHBwUm93QWN0aW9ucyA9IFwidHJ1ZVwiO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZW5kZXJUd2Vha3NQYWdlKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgb3BlbkJ0biA9IG9wZW5JblBsYWNlQnV0dG9uKFwiT3BlbiBUd2Vha3MgRm9sZGVyXCIsICgpID0+IHtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6cmV2ZWFsXCIsIHR3ZWFrc1BhdGgoKSk7XG4gIH0pO1xuICBjb25zdCByZWxvYWRCdG4gPSBvcGVuSW5QbGFjZUJ1dHRvbihcIkZvcmNlIFJlbG9hZFwiLCAoKSA9PiB7XG4gICAgLy8gRnVsbCBwYWdlIHJlZnJlc2ggXHUyMDE0IHNhbWUgYXMgRGV2VG9vbHMgQ21kLVIgLyBvdXIgQ0RQIFBhZ2UucmVsb2FkLlxuICAgIC8vIE1haW4gcmUtZGlzY292ZXJzIHR3ZWFrcyBmaXJzdCBzbyB0aGUgbmV3IHJlbmRlcmVyIGNvbWVzIHVwIHdpdGggYVxuICAgIC8vIGZyZXNoIHR3ZWFrIHNldDsgdGhlbiBsb2NhdGlvbi5yZWxvYWQgcmVzdGFydHMgdGhlIHJlbmRlcmVyIHNvIHRoZVxuICAgIC8vIHByZWxvYWQgcmUtaW5pdGlhbGl6ZXMgYWdhaW5zdCBpdC5cbiAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAuaW52b2tlKFwiY29kZXhwcDpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJmb3JjZSByZWxvYWQgKG1haW4pIGZhaWxlZFwiLCBTdHJpbmcoZSkpKVxuICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICBsb2NhdGlvbi5yZWxvYWQoKTtcbiAgICAgIH0pO1xuICB9KTtcbiAgLy8gRHJvcCB0aGUgZGlhZ29uYWwtYXJyb3cgaWNvbiBmcm9tIHRoZSByZWxvYWQgYnV0dG9uIFx1MjAxNCBpdCBpbXBsaWVzIFwib3BlblxuICAvLyBvdXQgb2YgYXBwXCIgd2hpY2ggZG9lc24ndCBmaXQuIFJlcGxhY2UgaXRzIHRyYWlsaW5nIHN2ZyB3aXRoIGEgcmVmcmVzaC5cbiAgY29uc3QgcmVsb2FkU3ZnID0gcmVsb2FkQnRuLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIik7XG4gIGlmIChyZWxvYWRTdmcpIHtcbiAgICByZWxvYWRTdmcub3V0ZXJIVE1MID1cbiAgICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tMnhzXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgICBgPHBhdGggZD1cIk00IDEwYTYgNiAwIDAgMSAxMC4yNC00LjI0TDE2IDcuNU0xNiA0djMuNWgtMy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgICAgYDxwYXRoIGQ9XCJNMTYgMTBhNiA2IDAgMCAxLTEwLjI0IDQuMjRMNCAxMi41TTQgMTZ2LTMuNWgzLjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgICBgPC9zdmc+YDtcbiAgfVxuXG4gIGNvbnN0IHRyYWlsaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdHJhaWxpbmcuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICB0cmFpbGluZy5hcHBlbmRDaGlsZChyZWxvYWRCdG4pO1xuICB0cmFpbGluZy5hcHBlbmRDaGlsZChvcGVuQnRuKTtcblxuICBpZiAoc3RhdGUubGlzdGVkVHdlYWtzLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiSW5zdGFsbGVkIFR3ZWFrc1wiLCB0cmFpbGluZykpO1xuICAgIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoXG4gICAgICByb3dTaW1wbGUoXG4gICAgICAgIFwiTm8gdHdlYWtzIGluc3RhbGxlZFwiLFxuICAgICAgICBgRHJvcCBhIHR3ZWFrIGZvbGRlciBpbnRvICR7dHdlYWtzUGF0aCgpfSBhbmQgcmVsb2FkLmAsXG4gICAgICApLFxuICAgICk7XG4gICAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gR3JvdXAgcmVnaXN0ZXJlZCBTZXR0aW5nc1NlY3Rpb25zIGJ5IHR3ZWFrIGlkIChwcmVmaXggc3BsaXQgYXQgXCI6XCIpLlxuICBjb25zdCBzZWN0aW9uc0J5VHdlYWsgPSBuZXcgTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uW10+KCk7XG4gIGZvciAoY29uc3QgcyBvZiBzdGF0ZS5zZWN0aW9ucy52YWx1ZXMoKSkge1xuICAgIGNvbnN0IHR3ZWFrSWQgPSBzLmlkLnNwbGl0KFwiOlwiKVswXTtcbiAgICBpZiAoIXNlY3Rpb25zQnlUd2Vhay5oYXModHdlYWtJZCkpIHNlY3Rpb25zQnlUd2Vhay5zZXQodHdlYWtJZCwgW10pO1xuICAgIHNlY3Rpb25zQnlUd2Vhay5nZXQodHdlYWtJZCkhLnB1c2gocyk7XG4gIH1cblxuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHdyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiSW5zdGFsbGVkIFR3ZWFrc1wiLCB0cmFpbGluZykpO1xuXG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBmb3IgKGNvbnN0IHQgb2Ygc3RhdGUubGlzdGVkVHdlYWtzKSB7XG4gICAgY2FyZC5hcHBlbmRDaGlsZCh0d2Vha1Jvdyh0LCBzZWN0aW9uc0J5VHdlYWsuZ2V0KHQubWFuaWZlc3QuaWQpID8/IFtdKSk7XG4gIH1cbiAgd3JhcC5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHdyYXApO1xufVxuXG5mdW5jdGlvbiB0d2Vha1Jvdyh0OiBMaXN0ZWRUd2Vhaywgc2VjdGlvbnM6IFNldHRpbmdzU2VjdGlvbltdKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBtID0gdC5tYW5pZmVzdDtcblxuICAvLyBPdXRlciBjZWxsIHdyYXBzIHRoZSBoZWFkZXIgcm93ICsgKG9wdGlvbmFsKSBuZXN0ZWQgc2VjdGlvbnMgc28gdGhlXG4gIC8vIHBhcmVudCBjYXJkJ3MgZGl2aWRlciBzdGF5cyBiZXR3ZWVuICp0d2Vha3MqLCBub3QgYmV0d2VlbiBoZWFkZXIgYW5kXG4gIC8vIGJvZHkgb2YgdGhlIHNhbWUgdHdlYWsuXG4gIGNvbnN0IGNlbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjZWxsLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbFwiO1xuICBpZiAoIXQuZW5hYmxlZCkgY2VsbC5zdHlsZS5vcGFjaXR5ID0gXCIwLjdcIjtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcblxuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcblxuICAvLyBcdTI1MDBcdTI1MDAgQXZhdGFyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBhdmF0YXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhdmF0YXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgb3ZlcmZsb3ctaGlkZGVuIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgYXZhdGFyLnN0eWxlLndpZHRoID0gXCI1NnB4XCI7XG4gIGF2YXRhci5zdHlsZS5oZWlnaHQgPSBcIjU2cHhcIjtcbiAgYXZhdGFyLnN0eWxlLmJhY2tncm91bmRDb2xvciA9IFwidmFyKC0tY29sb3ItdG9rZW4tYmctZm9nLCB0cmFuc3BhcmVudClcIjtcbiAgaWYgKG0uaWNvblVybCkge1xuICAgIGNvbnN0IGltZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbWdcIik7XG4gICAgaW1nLmFsdCA9IFwiXCI7XG4gICAgaW1nLmNsYXNzTmFtZSA9IFwic2l6ZS1mdWxsIG9iamVjdC1jb250YWluXCI7XG4gICAgLy8gSW5pdGlhbDogc2hvdyBmYWxsYmFjayBpbml0aWFsIGluIGNhc2UgdGhlIGljb24gZmFpbHMgdG8gbG9hZC5cbiAgICBjb25zdCBpbml0aWFsID0gKG0ubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICAgIGNvbnN0IGZhbGxiYWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgZmFsbGJhY2suY2xhc3NOYW1lID0gXCJ0ZXh0LXhsIGZvbnQtbWVkaXVtXCI7XG4gICAgZmFsbGJhY2sudGV4dENvbnRlbnQgPSBpbml0aWFsO1xuICAgIGF2YXRhci5hcHBlbmRDaGlsZChmYWxsYmFjayk7XG4gICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICBpbWcuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgKCkgPT4ge1xuICAgICAgZmFsbGJhY2sucmVtb3ZlKCk7XG4gICAgICBpbWcuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgfSk7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICBpbWcucmVtb3ZlKCk7XG4gICAgfSk7XG4gICAgdm9pZCByZXNvbHZlSWNvblVybChtLmljb25VcmwsIHQuZGlyKS50aGVuKCh1cmwpID0+IHtcbiAgICAgIGlmICh1cmwpIGltZy5zcmMgPSB1cmw7XG4gICAgICBlbHNlIGltZy5yZW1vdmUoKTtcbiAgICB9KTtcbiAgICBhdmF0YXIuYXBwZW5kQ2hpbGQoaW1nKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBpbml0aWFsID0gKG0ubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICAgIGNvbnN0IHNwYW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBzcGFuLmNsYXNzTmFtZSA9IFwidGV4dC14bCBmb250LW1lZGl1bVwiO1xuICAgIHNwYW4udGV4dENvbnRlbnQgPSBpbml0aWFsO1xuICAgIGF2YXRhci5hcHBlbmRDaGlsZChzcGFuKTtcbiAgfVxuICBsZWZ0LmFwcGVuZENoaWxkKGF2YXRhcik7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRleHQgc3RhY2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTAuNVwiO1xuXG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmFtZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBuYW1lLnRleHRDb250ZW50ID0gbS5uYW1lO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZChuYW1lKTtcbiAgaWYgKG0udmVyc2lvbikge1xuICAgIGNvbnN0IHZlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHZlci5jbGFzc05hbWUgPVxuICAgICAgXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQteHMgZm9udC1ub3JtYWwgdGFidWxhci1udW1zXCI7XG4gICAgdmVyLnRleHRDb250ZW50ID0gYHYke20udmVyc2lvbn1gO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHZlcik7XG4gIH1cbiAgaWYgKHQudXBkYXRlPy51cGRhdGVBdmFpbGFibGUpIHtcbiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIGJhZGdlLmNsYXNzTmFtZSA9XG4gICAgICBcInJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wLjUgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICBiYWRnZS50ZXh0Q29udGVudCA9IFwiVXBkYXRlIEF2YWlsYWJsZVwiO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKGJhZGdlKTtcbiAgfVxuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZVJvdyk7XG5cbiAgaWYgKG0uZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgICBkZXNjLnRleHRDb250ZW50ID0gbS5kZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgfVxuXG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtZXRhLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGNvbnN0IGF1dGhvckVsID0gcmVuZGVyQXV0aG9yKG0uYXV0aG9yKTtcbiAgaWYgKGF1dGhvckVsKSBtZXRhLmFwcGVuZENoaWxkKGF1dGhvckVsKTtcbiAgaWYgKG0uZ2l0aHViUmVwbykge1xuICAgIGlmIChtZXRhLmNoaWxkcmVuLmxlbmd0aCA+IDApIG1ldGEuYXBwZW5kQ2hpbGQoZG90KCkpO1xuICAgIGNvbnN0IHJlcG8gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIHJlcG8udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgcmVwby5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gICAgcmVwby50ZXh0Q29udGVudCA9IG0uZ2l0aHViUmVwbztcbiAgICByZXBvLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsIGBodHRwczovL2dpdGh1Yi5jb20vJHttLmdpdGh1YlJlcG99YCk7XG4gICAgfSk7XG4gICAgbWV0YS5hcHBlbmRDaGlsZChyZXBvKTtcbiAgfVxuICBpZiAobS5ob21lcGFnZSkge1xuICAgIGlmIChtZXRhLmNoaWxkcmVuLmxlbmd0aCA+IDApIG1ldGEuYXBwZW5kQ2hpbGQoZG90KCkpO1xuICAgIGNvbnN0IGxpbmsgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICBsaW5rLmhyZWYgPSBtLmhvbWVwYWdlO1xuICAgIGxpbmsudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICBsaW5rLnJlbCA9IFwibm9yZWZlcnJlclwiO1xuICAgIGxpbmsuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCB0ZXh0LXRva2VuLXRleHQtbGluay1mb3JlZ3JvdW5kIGhvdmVyOnVuZGVybGluZVwiO1xuICAgIGxpbmsudGV4dENvbnRlbnQgPSBcIkhvbWVwYWdlXCI7XG4gICAgbWV0YS5hcHBlbmRDaGlsZChsaW5rKTtcbiAgfVxuICBpZiAobWV0YS5jaGlsZHJlbi5sZW5ndGggPiAwKSBzdGFjay5hcHBlbmRDaGlsZChtZXRhKTtcblxuICAvLyBUYWdzIHJvdyAoaWYgYW55KSBcdTIwMTQgc21hbGwgcGlsbCBjaGlwcyBiZWxvdyB0aGUgbWV0YSBsaW5lLlxuICBpZiAobS50YWdzICYmIG0udGFncy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgdGFnc1JvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgdGFnc1Jvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBnYXAtMSBwdC0wLjVcIjtcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBtLnRhZ3MpIHtcbiAgICAgIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIHBpbGwuY2xhc3NOYW1lID1cbiAgICAgICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQtWzExcHhdIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICAgIHBpbGwudGV4dENvbnRlbnQgPSB0YWc7XG4gICAgICB0YWdzUm93LmFwcGVuZENoaWxkKHBpbGwpO1xuICAgIH1cbiAgICBzdGFjay5hcHBlbmRDaGlsZCh0YWdzUm93KTtcbiAgfVxuXG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRvZ2dsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByaWdodC5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yIHB0LTAuNVwiO1xuICBpZiAodC51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSAmJiB0LnVwZGF0ZS5yZWxlYXNlVXJsKSB7XG4gICAgcmlnaHQuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiUmV2aWV3IFJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCB0LnVwZGF0ZSEucmVsZWFzZVVybCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIHJpZ2h0LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2wodC5lbmFibGVkLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpzZXQtdHdlYWstZW5hYmxlZFwiLCBtLmlkLCBuZXh0KTtcbiAgICAgIC8vIFRoZSBtYWluIHByb2Nlc3MgYnJvYWRjYXN0cyBhIHJlbG9hZCB3aGljaCB3aWxsIHJlLWZldGNoIHRoZSBsaXN0XG4gICAgICAvLyBhbmQgcmUtcmVuZGVyLiBXZSBkb24ndCBvcHRpbWlzdGljYWxseSB0b2dnbGUgdG8gYXZvaWQgZHJpZnQuXG4gICAgfSksXG4gICk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChyaWdodCk7XG5cbiAgY2VsbC5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIC8vIElmIHRoZSB0d2VhayBpcyBlbmFibGVkIGFuZCByZWdpc3RlcmVkIHNldHRpbmdzIHNlY3Rpb25zLCByZW5kZXIgdGhvc2VcbiAgLy8gYm9kaWVzIGFzIG5lc3RlZCByb3dzIGJlbmVhdGggdGhlIGhlYWRlciBpbnNpZGUgdGhlIHNhbWUgY2VsbC5cbiAgaWYgKHQuZW5hYmxlZCAmJiBzZWN0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgbmVzdGVkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBuZXN0ZWQuY2xhc3NOYW1lID1cbiAgICAgIFwiZmxleCBmbGV4LWNvbCBkaXZpZGUteS1bMC41cHhdIGRpdmlkZS10b2tlbi1ib3JkZXIgYm9yZGVyLXQtWzAuNXB4XSBib3JkZXItdG9rZW4tYm9yZGVyXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNlY3Rpb25zKSB7XG4gICAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJvZHkuY2xhc3NOYW1lID0gXCJwLTNcIjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHMucmVuZGVyKGJvZHkpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBib2R5LnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyB0d2VhayBzZWN0aW9uOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICB9XG4gICAgICBuZXN0ZWQuYXBwZW5kQ2hpbGQoYm9keSk7XG4gICAgfVxuICAgIGNlbGwuYXBwZW5kQ2hpbGQobmVzdGVkKTtcbiAgfVxuXG4gIHJldHVybiBjZWxsO1xufVxuXG5mdW5jdGlvbiByZW5kZXJBdXRob3IoYXV0aG9yOiBUd2Vha01hbmlmZXN0W1wiYXV0aG9yXCJdKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgaWYgKCFhdXRob3IpIHJldHVybiBudWxsO1xuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTFcIjtcbiAgaWYgKHR5cGVvZiBhdXRob3IgPT09IFwic3RyaW5nXCIpIHtcbiAgICB3cmFwLnRleHRDb250ZW50ID0gYGJ5ICR7YXV0aG9yfWA7XG4gICAgcmV0dXJuIHdyYXA7XG4gIH1cbiAgd3JhcC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShcImJ5IFwiKSk7XG4gIGlmIChhdXRob3IudXJsKSB7XG4gICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICAgIGEuaHJlZiA9IGF1dGhvci51cmw7XG4gICAgYS50YXJnZXQgPSBcIl9ibGFua1wiO1xuICAgIGEucmVsID0gXCJub3JlZmVycmVyXCI7XG4gICAgYS5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gICAgYS50ZXh0Q29udGVudCA9IGF1dGhvci5uYW1lO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoYSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgc3BhbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHNwYW4udGV4dENvbnRlbnQgPSBhdXRob3IubmFtZTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKHNwYW4pO1xuICB9XG4gIHJldHVybiB3cmFwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgY29tcG9uZW50cyBcdTI1MDBcdTI1MDBcblxuLyoqIFRoZSBmdWxsIHBhbmVsIHNoZWxsICh0b29sYmFyICsgc2Nyb2xsICsgaGVhZGluZyArIHNlY3Rpb25zIHdyYXApLiAqL1xuZnVuY3Rpb24gcGFuZWxTaGVsbChcbiAgdGl0bGU6IHN0cmluZyxcbiAgc3VidGl0bGU/OiBzdHJpbmcsXG4pOiB7IG91dGVyOiBIVE1MRWxlbWVudDsgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudDsgc3VidGl0bGU/OiBIVE1MRWxlbWVudCB9IHtcbiAgY29uc3Qgb3V0ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdXRlci5jbGFzc05hbWUgPSBcIm1haW4tc3VyZmFjZSBmbGV4IGgtZnVsbCBtaW4taC0wIGZsZXgtY29sXCI7XG5cbiAgY29uc3QgdG9vbGJhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvb2xiYXIuY2xhc3NOYW1lID1cbiAgICBcImRyYWdnYWJsZSBmbGV4IGl0ZW1zLWNlbnRlciBweC1wYW5lbCBlbGVjdHJvbjpoLXRvb2xiYXIgZXh0ZW5zaW9uOmgtdG9vbGJhci1zbVwiO1xuICBvdXRlci5hcHBlbmRDaGlsZCh0b29sYmFyKTtcblxuICBjb25zdCBzY3JvbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzY3JvbGwuY2xhc3NOYW1lID0gXCJmbGV4LTEgb3ZlcmZsb3cteS1hdXRvIHAtcGFuZWxcIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQoc2Nyb2xsKTtcblxuICBjb25zdCBpbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9XG4gICAgXCJteC1hdXRvIGZsZXggdy1mdWxsIGZsZXgtY29sIG1heC13LTJ4bCBlbGVjdHJvbjptaW4tdy1bY2FsYygzMjBweCp2YXIoLS1jb2RleC13aW5kb3ctem9vbSkpXVwiO1xuICBzY3JvbGwuYXBwZW5kQ2hpbGQoaW5uZXIpO1xuXG4gIGNvbnN0IGhlYWRlcldyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJXcmFwLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zIHBiLXBhbmVsXCI7XG4gIGNvbnN0IGhlYWRlcklubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVySW5uZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0xLjUgcGItcGFuZWxcIjtcbiAgY29uc3QgaGVhZGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRpbmcuY2xhc3NOYW1lID0gXCJlbGVjdHJvbjpoZWFkaW5nLWxnIGhlYWRpbmctYmFzZSB0cnVuY2F0ZVwiO1xuICBoZWFkaW5nLnRleHRDb250ZW50ID0gdGl0bGU7XG4gIGhlYWRlcklubmVyLmFwcGVuZENoaWxkKGhlYWRpbmcpO1xuICBsZXQgc3VidGl0bGVFbGVtZW50OiBIVE1MRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgaWYgKHN1YnRpdGxlKSB7XG4gICAgY29uc3Qgc3ViID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBzdWIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQtc21cIjtcbiAgICBzdWIudGV4dENvbnRlbnQgPSBzdWJ0aXRsZTtcbiAgICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZChzdWIpO1xuICAgIHN1YnRpdGxlRWxlbWVudCA9IHN1YjtcbiAgfVxuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlcklubmVyKTtcbiAgaW5uZXIuYXBwZW5kQ2hpbGQoaGVhZGVyV3JhcCk7XG5cbiAgY29uc3Qgc2VjdGlvbnNXcmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2VjdGlvbnNXcmFwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtW3ZhcigtLXBhZGRpbmctcGFuZWwpXVwiO1xuICBpbm5lci5hcHBlbmRDaGlsZChzZWN0aW9uc1dyYXApO1xuXG4gIHJldHVybiB7IG91dGVyLCBzZWN0aW9uc1dyYXAsIHN1YnRpdGxlOiBzdWJ0aXRsZUVsZW1lbnQgfTtcbn1cblxuZnVuY3Rpb24gc2VjdGlvblRpdGxlKHRleHQ6IHN0cmluZywgdHJhaWxpbmc/OiBIVE1MRWxlbWVudCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLXRvb2xiYXIgaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiBweC0wIHB5LTBcIjtcbiAgY29uc3QgdGl0bGVJbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlSW5uZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0LmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0aXRsZUlubmVyLmFwcGVuZENoaWxkKHQpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh0aXRsZUlubmVyKTtcbiAgaWYgKHRyYWlsaW5nKSB7XG4gICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJpZ2h0LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgICByaWdodC5hcHBlbmRDaGlsZCh0cmFpbGluZyk7XG4gICAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQocmlnaHQpO1xuICB9XG4gIHJldHVybiB0aXRsZVJvdztcbn1cblxuLyoqXG4gKiBDb2RleCdzIFwiT3BlbiBjb25maWcudG9tbFwiLXN0eWxlIHRyYWlsaW5nIGJ1dHRvbjogZ2hvc3QgYm9yZGVyLCBtdXRlZFxuICogbGFiZWwsIHRvcC1yaWdodCBkaWFnb25hbCBhcnJvdyBpY29uLiBNYXJrdXAgbWlycm9ycyBDb25maWd1cmF0aW9uIHBhbmVsLlxuICovXG5mdW5jdGlvbiBvcGVuSW5QbGFjZUJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIGJvcmRlciB3aGl0ZXNwYWNlLW5vd3JhcCBmb2N1czpvdXRsaW5lLW5vbmUgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDAgcm91bmRlZC1sZyB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGF0YS1bc3RhdGU9b3Blbl06YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGJvcmRlci10cmFuc3BhcmVudCBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciBweC0yIHB5LTAgdGV4dC1iYXNlIGxlYWRpbmctWzE4cHhdXCI7XG4gIGJ0bi5pbm5lckhUTUwgPVxuICAgIGAke2xhYmVsfWAgK1xuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tMnhzXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTQuMzM0OSAxMy4zMzAxVjYuNjA2NDVMNS40NzA2NSAxNS40NzA3QzUuMjEwOTUgMTUuNzMwNCA0Ljc4ODk1IDE1LjczMDQgNC41MjkyNSAxNS40NzA3QzQuMjY5NTUgMTUuMjExIDQuMjY5NTUgMTQuNzg5IDQuNTI5MjUgMTQuNTI5M0wxMy4zOTM1IDUuNjY1MDRINi42NjAxMUM2LjI5Mjg0IDUuNjY1MDQgNS45OTUwNyA1LjM2NzI3IDUuOTk1MDcgNUM1Ljk5NTA3IDQuNjMyNzMgNi4yOTI4NCA0LjMzNDk2IDYuNjYwMTEgNC4zMzQ5NkgxNC45OTk5TDE1LjEzMzcgNC4zNDg2M0MxNS40MzY5IDQuNDEwNTcgMTUuNjY1IDQuNjc4NTcgMTUuNjY1IDVWMTMuMzMwMUMxNS42NjQ5IDEzLjY5NzMgMTUuMzY3MiAxMy45OTUxIDE0Ljk5OTkgMTMuOTk1MUMxNC42MzI3IDEzLjk5NTEgMTQuMzM1IDEzLjY5NzMgMTQuMzM0OSAxMy4zMzAxWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIj48L3BhdGg+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0QnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uQ2xpY2s6ICgpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBweC0yIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnkgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIjtcbiAgYnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiByb3VuZGVkQ2FyZCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIGZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIHJvdW5kZWQtbGcgYm9yZGVyXCI7XG4gIGNhcmQuc2V0QXR0cmlidXRlKFxuICAgIFwic3R5bGVcIixcbiAgICBcImJhY2tncm91bmQtY29sb3I6IHZhcigtLWNvbG9yLWJhY2tncm91bmQtcGFuZWwsIHZhcigtLWNvbG9yLXRva2VuLWJnLWZvZykpO1wiLFxuICApO1xuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gcm93U2ltcGxlKHRpdGxlOiBzdHJpbmcgfCB1bmRlZmluZWQsIGRlc2NyaXB0aW9uPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciBnYXAtM1wiO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGlmICh0aXRsZSkge1xuICAgIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHQuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICB0LnRleHRDb250ZW50ID0gdGl0bGU7XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQodCk7XG4gIH1cbiAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZC5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gICAgZC50ZXh0Q29udGVudCA9IGRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGQpO1xuICB9XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIHJldHVybiByb3c7XG59XG5cbi8qKlxuICogQ29kZXgtc3R5bGVkIHRvZ2dsZSBzd2l0Y2guIE1hcmt1cCBtaXJyb3JzIHRoZSBHZW5lcmFsID4gUGVybWlzc2lvbnMgcm93XG4gKiBzd2l0Y2ggd2UgY2FwdHVyZWQ6IG91dGVyIGJ1dHRvbiAocm9sZT1zd2l0Y2gpLCBpbm5lciBwaWxsLCBzbGlkaW5nIGtub2IuXG4gKi9cbmZ1bmN0aW9uIHN3aXRjaENvbnRyb2woXG4gIGluaXRpYWw6IGJvb2xlYW4sXG4gIG9uQ2hhbmdlOiAobmV4dDogYm9vbGVhbikgPT4gdm9pZCB8IFByb21pc2U8dm9pZD4sXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJzd2l0Y2hcIik7XG5cbiAgY29uc3QgcGlsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCBrbm9iID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGtub2IuY2xhc3NOYW1lID1cbiAgICBcInJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLVtjb2xvcjp2YXIoLS1ncmF5LTApXSBiZy1bY29sb3I6dmFyKC0tZ3JheS0wKV0gc2hhZG93LXNtIHRyYW5zaXRpb24tdHJhbnNmb3JtIGR1cmF0aW9uLTIwMCBlYXNlLW91dCBoLTQgdy00XCI7XG4gIHBpbGwuYXBwZW5kQ2hpbGQoa25vYik7XG5cbiAgY29uc3QgYXBwbHkgPSAob246IGJvb2xlYW4pOiB2b2lkID0+IHtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jaGVja2VkXCIsIFN0cmluZyhvbikpO1xuICAgIGJ0bi5kYXRhc2V0LnN0YXRlID0gb24gPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCI7XG4gICAgYnRuLmNsYXNzTmFtZSA9XG4gICAgICBcImlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXIgZm9jdXMtdmlzaWJsZTpyb3VuZGVkLWZ1bGwgY3Vyc29yLWludGVyYWN0aW9uXCI7XG4gICAgcGlsbC5jbGFzc05hbWUgPSBgcmVsYXRpdmUgaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCB0cmFuc2l0aW9uLWNvbG9ycyBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC01IHctOCAke1xuICAgICAgb24gPyBcImJnLXRva2VuLWNoYXJ0cy1ibHVlXCIgOiBcImJnLXRva2VuLWZvcmVncm91bmQvMjBcIlxuICAgIH1gO1xuICAgIHBpbGwuZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGtub2IuZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGtub2Iuc3R5bGUudHJhbnNmb3JtID0gb24gPyBcInRyYW5zbGF0ZVgoMTRweClcIiA6IFwidHJhbnNsYXRlWCgycHgpXCI7XG4gIH07XG4gIGFwcGx5KGluaXRpYWwpO1xuXG4gIGJ0bi5hcHBlbmRDaGlsZChwaWxsKTtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGNvbnN0IG5leHQgPSBidG4uZ2V0QXR0cmlidXRlKFwiYXJpYS1jaGVja2VkXCIpICE9PSBcInRydWVcIjtcbiAgICBhcHBseShuZXh0KTtcbiAgICBidG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBvbkNoYW5nZShuZXh0KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgYnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gZG90KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBzLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIHMudGV4dENvbnRlbnQgPSBcIlx1MDBCN1wiO1xuICByZXR1cm4gcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGljb25zIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjb25maWdJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNsaWRlcnMgLyBzZXR0aW5ncyBnbHlwaC4gMjB4MjAgY3VycmVudENvbG9yLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTMgNWg5TTE1IDVoMk0zIDEwaDJNOCAxMGg5TTMgMTVoMTFNMTcgMTVoMFwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxM1wiIGN5PVwiNVwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiNlwiIGN5PVwiMTBcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjE1XCIgY3k9XCIxNVwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHBhdGNoTWFuYWdlckljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gQXBwIGJ1bmRsZSArIHJlcGFpci9jaGVjayBnbHlwaC5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk00IDUuNUEyLjUgMi41IDAgMCAxIDYuNSAzaDdBMi41IDIuNSAwIDAgMSAxNiA1LjV2OUEyLjUgMi41IDAgMCAxIDEzLjUgMTdoLTdBMi41IDIuNSAwIDAgMSA0IDE0LjV2LTlaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcgN2g2TTcgMTBoM1wiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNOC4yNSAxMy4yNSA5LjYgMTQuNmwyLjktMy4yXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc0ljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gU3BhcmtsZXMgLyBcIisrXCIgZ2x5cGggZm9yIHR3ZWFrcy5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0xMCAyLjUgTDExLjQgOC42IEwxNy41IDEwIEwxMS40IDExLjQgTDEwIDE3LjUgTDguNiAxMS40IEwyLjUgMTAgTDguNiA4LjYgWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTUuNSAzIEwxNiA1IEwxOCA1LjUgTDE2IDYgTDE1LjUgOCBMMTUgNiBMMTMgNS41IEwxNSA1IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIgb3BhY2l0eT1cIjAuN1wiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0UGFnZUljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gRG9jdW1lbnQvcGFnZSBnbHlwaCBmb3IgdHdlYWstcmVnaXN0ZXJlZCBwYWdlcyB3aXRob3V0IHRoZWlyIG93biBpY29uLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTUgM2g3bDMgM3YxMWExIDEgMCAwIDEtMSAxSDVhMSAxIDAgMCAxLTEtMVY0YTEgMSAwIDAgMSAxLTFaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTIgM3YzYTEgMSAwIDAgMCAxIDFoMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcgMTFoNk03IDE0aDRcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVJY29uVXJsKFxuICB1cmw6IHN0cmluZyxcbiAgdHdlYWtEaXI6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoL14oaHR0cHM/OnxkYXRhOikvLnRlc3QodXJsKSkgcmV0dXJuIHVybDtcbiAgLy8gUmVsYXRpdmUgcGF0aCBcdTIxOTIgYXNrIG1haW4gdG8gcmVhZCB0aGUgZmlsZSBhbmQgcmV0dXJuIGEgZGF0YTogVVJMLlxuICAvLyBSZW5kZXJlciBpcyBzYW5kYm94ZWQgc28gZmlsZTovLyB3b24ndCBsb2FkIGRpcmVjdGx5LlxuICBjb25zdCByZWwgPSB1cmwuc3RhcnRzV2l0aChcIi4vXCIpID8gdXJsLnNsaWNlKDIpIDogdXJsO1xuICB0cnkge1xuICAgIHJldHVybiAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJjb2RleHBwOnJlYWQtdHdlYWstYXNzZXRcIixcbiAgICAgIHR3ZWFrRGlyLFxuICAgICAgcmVsLFxuICAgICkpIGFzIHN0cmluZztcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJpY29uIGxvYWQgZmFpbGVkXCIsIHsgdXJsLCB0d2Vha0RpciwgZXJyOiBTdHJpbmcoZSkgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIERPTSBoZXVyaXN0aWNzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgLy8gQW5jaG9yIHN0cmF0ZWd5IGZpcnN0ICh3b3VsZCBiZSBpZGVhbCBpZiBDb2RleCBzd2l0Y2hlcyB0byA8YT4pLlxuICBjb25zdCBsaW5rcyA9IEFycmF5LmZyb20oXG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQW5jaG9yRWxlbWVudD4oXCJhW2hyZWYqPScvc2V0dGluZ3MvJ11cIiksXG4gICk7XG4gIGlmIChsaW5rcy5sZW5ndGggPj0gMikge1xuICAgIGxldCBub2RlOiBIVE1MRWxlbWVudCB8IG51bGwgPSBsaW5rc1swXS5wYXJlbnRFbGVtZW50O1xuICAgIHdoaWxlIChub2RlKSB7XG4gICAgICBjb25zdCBpbnNpZGUgPSBub2RlLnF1ZXJ5U2VsZWN0b3JBbGwoXCJhW2hyZWYqPScvc2V0dGluZ3MvJ11cIik7XG4gICAgICBpZiAoaW5zaWRlLmxlbmd0aCA+PSBNYXRoLm1heCgyLCBsaW5rcy5sZW5ndGggLSAxKSkgcmV0dXJuIG5vZGU7XG4gICAgICBub2RlID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICAgIH1cbiAgfVxuXG4gIC8vIFRleHQtY29udGVudCBtYXRjaCBhZ2FpbnN0IENvZGV4J3Mga25vd24gc2lkZWJhciBsYWJlbHMuXG4gIGNvbnN0IEtOT1dOID0gW1xuICAgIFwiR2VuZXJhbFwiLFxuICAgIFwiQXBwZWFyYW5jZVwiLFxuICAgIFwiQ29uZmlndXJhdGlvblwiLFxuICAgIFwiUGVyc29uYWxpemF0aW9uXCIsXG4gICAgXCJNQ1Agc2VydmVyc1wiLFxuICAgIFwiTUNQIFNlcnZlcnNcIixcbiAgICBcIkdpdFwiLFxuICAgIFwiRW52aXJvbm1lbnRzXCIsXG4gIF07XG4gIGNvbnN0IG1hdGNoZXM6IEhUTUxFbGVtZW50W10gPSBbXTtcbiAgY29uc3QgYWxsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXG4gICAgXCJidXR0b24sIGEsIFtyb2xlPSdidXR0b24nXSwgbGksIGRpdlwiLFxuICApO1xuICBmb3IgKGNvbnN0IGVsIG9mIEFycmF5LmZyb20oYWxsKSkge1xuICAgIGNvbnN0IHQgPSAoZWwudGV4dENvbnRlbnQgPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICh0Lmxlbmd0aCA+IDMwKSBjb250aW51ZTtcbiAgICBpZiAoS05PV04uc29tZSgoaykgPT4gdCA9PT0gaykpIG1hdGNoZXMucHVzaChlbCk7XG4gICAgaWYgKG1hdGNoZXMubGVuZ3RoID4gNTApIGJyZWFrO1xuICB9XG4gIGlmIChtYXRjaGVzLmxlbmd0aCA+PSAyKSB7XG4gICAgbGV0IG5vZGU6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG1hdGNoZXNbMF0ucGFyZW50RWxlbWVudDtcbiAgICB3aGlsZSAobm9kZSkge1xuICAgICAgbGV0IGNvdW50ID0gMDtcbiAgICAgIGZvciAoY29uc3QgbSBvZiBtYXRjaGVzKSBpZiAobm9kZS5jb250YWlucyhtKSkgY291bnQrKztcbiAgICAgIGlmIChjb3VudCA+PSBNYXRoLm1pbigzLCBtYXRjaGVzLmxlbmd0aCkpIHJldHVybiBub2RlO1xuICAgICAgbm9kZSA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGZpbmRDb250ZW50QXJlYSgpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gIGlmICghc2lkZWJhcikgcmV0dXJuIG51bGw7XG4gIGxldCBwYXJlbnQgPSBzaWRlYmFyLnBhcmVudEVsZW1lbnQ7XG4gIHdoaWxlIChwYXJlbnQpIHtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20ocGFyZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBpZiAoY2hpbGQgPT09IHNpZGViYXIgfHwgY2hpbGQuY29udGFpbnMoc2lkZWJhcikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgciA9IGNoaWxkLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgaWYgKHIud2lkdGggPiAzMDAgJiYgci5oZWlnaHQgPiAyMDApIHJldHVybiBjaGlsZDtcbiAgICB9XG4gICAgcGFyZW50ID0gcGFyZW50LnBhcmVudEVsZW1lbnQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG1heWJlRHVtcERvbSgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gICAgaWYgKHNpZGViYXIgJiYgIXN0YXRlLnNpZGViYXJEdW1wZWQpIHtcbiAgICAgIHN0YXRlLnNpZGViYXJEdW1wZWQgPSB0cnVlO1xuICAgICAgY29uc3Qgc2JSb290ID0gc2lkZWJhci5wYXJlbnRFbGVtZW50ID8/IHNpZGViYXI7XG4gICAgICBwbG9nKGBjb2RleCBzaWRlYmFyIEhUTUxgLCBzYlJvb3Qub3V0ZXJIVE1MLnNsaWNlKDAsIDMyMDAwKSk7XG4gICAgfVxuICAgIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgICBpZiAoIWNvbnRlbnQpIHtcbiAgICAgIGlmIChzdGF0ZS5maW5nZXJwcmludCAhPT0gbG9jYXRpb24uaHJlZikge1xuICAgICAgICBzdGF0ZS5maW5nZXJwcmludCA9IGxvY2F0aW9uLmhyZWY7XG4gICAgICAgIHBsb2coXCJkb20gcHJvYmUgKG5vIGNvbnRlbnQpXCIsIHtcbiAgICAgICAgICB1cmw6IGxvY2F0aW9uLmhyZWYsXG4gICAgICAgICAgc2lkZWJhcjogc2lkZWJhciA/IGRlc2NyaWJlKHNpZGViYXIpIDogbnVsbCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGxldCBwYW5lbDogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20oY29udGVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgaWYgKGNoaWxkLmRhdGFzZXQuY29kZXhwcCA9PT0gXCJ0d2Vha3MtcGFuZWxcIikgY29udGludWU7XG4gICAgICBpZiAoY2hpbGQuc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIpIGNvbnRpbnVlO1xuICAgICAgcGFuZWwgPSBjaGlsZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjb25zdCBhY3RpdmVOYXYgPSBzaWRlYmFyXG4gICAgICA/IEFycmF5LmZyb20oc2lkZWJhci5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcImJ1dHRvbiwgYVwiKSkuZmluZChcbiAgICAgICAgICAoYikgPT5cbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpID09PSBcInBhZ2VcIiB8fFxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFjdGl2ZVwiKSA9PT0gXCJ0cnVlXCIgfHxcbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiKSA9PT0gXCJ0cnVlXCIgfHxcbiAgICAgICAgICAgIGIuY2xhc3NMaXN0LmNvbnRhaW5zKFwiYWN0aXZlXCIpLFxuICAgICAgICApXG4gICAgICA6IG51bGw7XG4gICAgY29uc3QgaGVhZGluZyA9IHBhbmVsPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcbiAgICAgIFwiaDEsIGgyLCBoMywgW2NsYXNzKj0naGVhZGluZyddXCIsXG4gICAgKTtcbiAgICBjb25zdCBmaW5nZXJwcmludCA9IGAke2FjdGl2ZU5hdj8udGV4dENvbnRlbnQgPz8gXCJcIn18JHtoZWFkaW5nPy50ZXh0Q29udGVudCA/PyBcIlwifXwke3BhbmVsPy5jaGlsZHJlbi5sZW5ndGggPz8gMH1gO1xuICAgIGlmIChzdGF0ZS5maW5nZXJwcmludCA9PT0gZmluZ2VycHJpbnQpIHJldHVybjtcbiAgICBzdGF0ZS5maW5nZXJwcmludCA9IGZpbmdlcnByaW50O1xuICAgIHBsb2coXCJkb20gcHJvYmVcIiwge1xuICAgICAgdXJsOiBsb2NhdGlvbi5ocmVmLFxuICAgICAgYWN0aXZlTmF2OiBhY3RpdmVOYXY/LnRleHRDb250ZW50Py50cmltKCkgPz8gbnVsbCxcbiAgICAgIGhlYWRpbmc6IGhlYWRpbmc/LnRleHRDb250ZW50Py50cmltKCkgPz8gbnVsbCxcbiAgICAgIGNvbnRlbnQ6IGRlc2NyaWJlKGNvbnRlbnQpLFxuICAgIH0pO1xuICAgIGlmIChwYW5lbCkge1xuICAgICAgY29uc3QgaHRtbCA9IHBhbmVsLm91dGVySFRNTDtcbiAgICAgIHBsb2coXG4gICAgICAgIGBjb2RleCBwYW5lbCBIVE1MICgke2FjdGl2ZU5hdj8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBcIj9cIn0pYCxcbiAgICAgICAgaHRtbC5zbGljZSgwLCAzMjAwMCksXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJkb20gcHJvYmUgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZGVzY3JpYmUoZWw6IEhUTUxFbGVtZW50KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4ge1xuICAgIHRhZzogZWwudGFnTmFtZSxcbiAgICBjbHM6IGVsLmNsYXNzTmFtZS5zbGljZSgwLCAxMjApLFxuICAgIGlkOiBlbC5pZCB8fCB1bmRlZmluZWQsXG4gICAgY2hpbGRyZW46IGVsLmNoaWxkcmVuLmxlbmd0aCxcbiAgICByZWN0OiAoKCkgPT4ge1xuICAgICAgY29uc3QgciA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgcmV0dXJuIHsgdzogTWF0aC5yb3VuZChyLndpZHRoKSwgaDogTWF0aC5yb3VuZChyLmhlaWdodCkgfTtcbiAgICB9KSgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha3NQYXRoKCk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19jb2RleHBwX3R3ZWFrc19kaXJfXz86IHN0cmluZyB9KS5fX2NvZGV4cHBfdHdlYWtzX2Rpcl9fID8/XG4gICAgXCI8dXNlciBkaXI+L3R3ZWFrc1wiXG4gICk7XG59XG4iLCAiLyoqXG4gKiBSZW5kZXJlci1zaWRlIHR3ZWFrIGhvc3QuIFdlOlxuICogICAxLiBBc2sgbWFpbiBmb3IgdGhlIHR3ZWFrIGxpc3QgKHdpdGggcmVzb2x2ZWQgZW50cnkgcGF0aCkuXG4gKiAgIDIuIEZvciBlYWNoIHJlbmRlcmVyLXNjb3BlZCAob3IgXCJib3RoXCIpIHR3ZWFrLCBmZXRjaCBpdHMgc291cmNlIHZpYSBJUENcbiAqICAgICAgYW5kIGV4ZWN1dGUgaXQgYXMgYSBDb21tb25KUy1zaGFwZWQgZnVuY3Rpb24uXG4gKiAgIDMuIFByb3ZpZGUgaXQgdGhlIHJlbmRlcmVyIGhhbGYgb2YgdGhlIEFQSS5cbiAqXG4gKiBDb2RleCBydW5zIHRoZSByZW5kZXJlciB3aXRoIHNhbmRib3g6IHRydWUsIHNvIE5vZGUncyBgcmVxdWlyZSgpYCBpc1xuICogcmVzdHJpY3RlZCB0byBhIHRpbnkgd2hpdGVsaXN0IChlbGVjdHJvbiArIGEgZmV3IHBvbHlmaWxscykuIFRoYXQgbWVhbnMgd2VcbiAqIGNhbm5vdCBgcmVxdWlyZSgpYCBhcmJpdHJhcnkgdHdlYWsgZmlsZXMgZnJvbSBkaXNrLiBJbnN0ZWFkIHdlIHB1bGwgdGhlXG4gKiBzb3VyY2Ugc3RyaW5nIGZyb20gbWFpbiBhbmQgZXZhbHVhdGUgaXQgd2l0aCBgbmV3IEZ1bmN0aW9uYCBpbnNpZGUgdGhlXG4gKiBwcmVsb2FkIGNvbnRleHQuIFR3ZWFrIGF1dGhvcnMgd2hvIG5lZWQgbnBtIGRlcHMgbXVzdCBidW5kbGUgdGhlbSBpbi5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJTZWN0aW9uLCByZWdpc3RlclBhZ2UsIGNsZWFyU2VjdGlvbnMsIHNldExpc3RlZFR3ZWFrcyB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5pbXBvcnQgeyBmaWJlckZvck5vZGUgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgdHlwZSB7XG4gIFR3ZWFrTWFuaWZlc3QsXG4gIFR3ZWFrQXBpLFxuICBSZWFjdEZpYmVyTm9kZSxcbiAgVHdlYWssXG59IGZyb20gXCJAY29kZXgtcGx1c3BsdXMvc2RrXCI7XG5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHVwZGF0ZToge1xuICAgIGNoZWNrZWRBdDogc3RyaW5nO1xuICAgIHJlcG86IHN0cmluZztcbiAgICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICAgIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gICAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gICAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFVzZXJQYXRocyB7XG4gIHVzZXJSb290OiBzdHJpbmc7XG4gIHJ1bnRpbWVEaXI6IHN0cmluZztcbiAgdHdlYWtzRGlyOiBzdHJpbmc7XG4gIGxvZ0Rpcjogc3RyaW5nO1xufVxuXG5jb25zdCBsb2FkZWQgPSBuZXcgTWFwPHN0cmluZywgeyBzdG9wPzogKCkgPT4gdm9pZCB9PigpO1xubGV0IGNhY2hlZFBhdGhzOiBVc2VyUGF0aHMgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0VHdlYWtIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0d2Vha3MgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpsaXN0LXR3ZWFrc1wiKSkgYXMgTGlzdGVkVHdlYWtbXTtcbiAgY29uc3QgcGF0aHMgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp1c2VyLXBhdGhzXCIpKSBhcyBVc2VyUGF0aHM7XG4gIGNhY2hlZFBhdGhzID0gcGF0aHM7XG4gIC8vIFB1c2ggdGhlIGxpc3QgdG8gdGhlIHNldHRpbmdzIGluamVjdG9yIHNvIHRoZSBUd2Vha3MgcGFnZSBjYW4gcmVuZGVyXG4gIC8vIGNhcmRzIGV2ZW4gYmVmb3JlIGFueSB0d2VhaydzIHN0YXJ0KCkgcnVucyAoYW5kIGZvciBkaXNhYmxlZCB0d2Vha3NcbiAgLy8gdGhhdCB3ZSBuZXZlciBsb2FkKS5cbiAgc2V0TGlzdGVkVHdlYWtzKHR3ZWFrcyk7XG4gIC8vIFN0YXNoIGZvciB0aGUgc2V0dGluZ3MgaW5qZWN0b3IncyBlbXB0eS1zdGF0ZSBtZXNzYWdlLlxuICAod2luZG93IGFzIHVua25vd24gYXMgeyBfX2NvZGV4cHBfdHdlYWtzX2Rpcl9fPzogc3RyaW5nIH0pLl9fY29kZXhwcF90d2Vha3NfZGlyX18gPVxuICAgIHBhdGhzLnR3ZWFrc0RpcjtcblxuICBmb3IgKGNvbnN0IHQgb2YgdHdlYWtzKSB7XG4gICAgaWYgKHQubWFuaWZlc3Quc2NvcGUgPT09IFwibWFpblwiKSBjb250aW51ZTtcbiAgICBpZiAoIXQuZW50cnlFeGlzdHMpIGNvbnRpbnVlO1xuICAgIGlmICghdC5lbmFibGVkKSBjb250aW51ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgbG9hZFR3ZWFrKHQsIHBhdGhzKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSB0d2VhayBsb2FkIGZhaWxlZDpcIiwgdC5tYW5pZmVzdC5pZCwgZSk7XG4gICAgfVxuICB9XG5cbiAgY29uc29sZS5pbmZvKFxuICAgIGBbY29kZXgtcGx1c3BsdXNdIHJlbmRlcmVyIGhvc3QgbG9hZGVkICR7bG9hZGVkLnNpemV9IHR3ZWFrKHMpOmAsXG4gICAgWy4uLmxvYWRlZC5rZXlzKCldLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwiLFxuICApO1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGByZW5kZXJlciBob3N0IGxvYWRlZCAke2xvYWRlZC5zaXplfSB0d2VhayhzKTogJHtbLi4ubG9hZGVkLmtleXMoKV0uam9pbihcIiwgXCIpIHx8IFwiKG5vbmUpXCJ9YCxcbiAgKTtcbn1cblxuLyoqXG4gKiBTdG9wIGV2ZXJ5IHJlbmRlcmVyLXNjb3BlIHR3ZWFrIHNvIGEgc3Vic2VxdWVudCBgc3RhcnRUd2Vha0hvc3QoKWAgd2lsbFxuICogcmUtZXZhbHVhdGUgZnJlc2ggc291cmNlLiBNb2R1bGUgY2FjaGUgaXNuJ3QgcmVsZXZhbnQgc2luY2Ugd2UgZXZhbFxuICogc291cmNlIHN0cmluZ3MgZGlyZWN0bHkgXHUyMDE0IGVhY2ggbG9hZCBjcmVhdGVzIGEgZnJlc2ggc2NvcGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0ZWFyZG93blR3ZWFrSG9zdCgpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBbaWQsIHRdIG9mIGxvYWRlZCkge1xuICAgIHRyeSB7XG4gICAgICB0LnN0b3A/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihcIltjb2RleC1wbHVzcGx1c10gdHdlYWsgc3RvcCBmYWlsZWQ6XCIsIGlkLCBlKTtcbiAgICB9XG4gIH1cbiAgbG9hZGVkLmNsZWFyKCk7XG4gIGNsZWFyU2VjdGlvbnMoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFR3ZWFrKHQ6IExpc3RlZFR3ZWFrLCBwYXRoczogVXNlclBhdGhzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNvdXJjZSA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgXCJjb2RleHBwOnJlYWQtdHdlYWstc291cmNlXCIsXG4gICAgdC5lbnRyeSxcbiAgKSkgYXMgc3RyaW5nO1xuXG4gIC8vIEV2YWx1YXRlIGFzIENKUy1zaGFwZWQ6IHByb3ZpZGUgbW9kdWxlL2V4cG9ydHMvYXBpLiBUd2VhayBjb2RlIG1heSB1c2VcbiAgLy8gYG1vZHVsZS5leHBvcnRzID0geyBzdGFydCwgc3RvcCB9YCBvciBgZXhwb3J0cy5zdGFydCA9IC4uLmAgb3IgcHVyZSBFU01cbiAgLy8gZGVmYXVsdCBleHBvcnQgc2hhcGUgKHdlIGFjY2VwdCBib3RoKS5cbiAgY29uc3QgbW9kdWxlID0geyBleHBvcnRzOiB7fSBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWsgfTtcbiAgY29uc3QgZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzO1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWltcGxpZWQtZXZhbCwgbm8tbmV3LWZ1bmNcbiAgY29uc3QgZm4gPSBuZXcgRnVuY3Rpb24oXG4gICAgXCJtb2R1bGVcIixcbiAgICBcImV4cG9ydHNcIixcbiAgICBcImNvbnNvbGVcIixcbiAgICBgJHtzb3VyY2V9XFxuLy8jIHNvdXJjZVVSTD1jb2RleHBwLXR3ZWFrOi8vJHtlbmNvZGVVUklDb21wb25lbnQodC5tYW5pZmVzdC5pZCl9LyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQuZW50cnkpfWAsXG4gICk7XG4gIGZuKG1vZHVsZSwgZXhwb3J0cywgY29uc29sZSk7XG4gIGNvbnN0IG1vZCA9IG1vZHVsZS5leHBvcnRzIGFzIHsgZGVmYXVsdD86IFR3ZWFrIH0gJiBUd2VhaztcbiAgY29uc3QgdHdlYWs6IFR3ZWFrID0gKG1vZCBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9KS5kZWZhdWx0ID8/IChtb2QgYXMgVHdlYWspO1xuICBpZiAodHlwZW9mIHR3ZWFrPy5zdGFydCAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGB0d2VhayAke3QubWFuaWZlc3QuaWR9IGhhcyBubyBzdGFydCgpYCk7XG4gIH1cbiAgY29uc3QgYXBpID0gbWFrZVJlbmRlcmVyQXBpKHQubWFuaWZlc3QsIHBhdGhzKTtcbiAgYXdhaXQgdHdlYWsuc3RhcnQoYXBpKTtcbiAgbG9hZGVkLnNldCh0Lm1hbmlmZXN0LmlkLCB7IHN0b3A6IHR3ZWFrLnN0b3A/LmJpbmQodHdlYWspIH0pO1xufVxuXG5mdW5jdGlvbiBtYWtlUmVuZGVyZXJBcGkobWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3QsIHBhdGhzOiBVc2VyUGF0aHMpOiBUd2Vha0FwaSB7XG4gIGNvbnN0IGlkID0gbWFuaWZlc3QuaWQ7XG4gIGNvbnN0IGxvZyA9IChsZXZlbDogXCJkZWJ1Z1wiIHwgXCJpbmZvXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiwgLi4uYTogdW5rbm93bltdKSA9PiB7XG4gICAgY29uc3QgY29uc29sZUZuID1cbiAgICAgIGxldmVsID09PSBcImRlYnVnXCIgPyBjb25zb2xlLmRlYnVnXG4gICAgICA6IGxldmVsID09PSBcIndhcm5cIiA/IGNvbnNvbGUud2FyblxuICAgICAgOiBsZXZlbCA9PT0gXCJlcnJvclwiID8gY29uc29sZS5lcnJvclxuICAgICAgOiBjb25zb2xlLmxvZztcbiAgICBjb25zb2xlRm4oYFtjb2RleC1wbHVzcGx1c11bJHtpZH1dYCwgLi4uYSk7XG4gICAgLy8gQWxzbyBtaXJyb3IgdG8gbWFpbidzIGxvZyBmaWxlIHNvIHdlIGNhbiBkaWFnbm9zZSB0d2VhayBiZWhhdmlvclxuICAgIC8vIHdpdGhvdXQgYXR0YWNoaW5nIERldlRvb2xzLiBTdHJpbmdpZnkgZWFjaCBhcmcgZGVmZW5zaXZlbHkuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcnRzID0gYS5tYXAoKHYpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2ID09PSBcInN0cmluZ1wiKSByZXR1cm4gdjtcbiAgICAgICAgaWYgKHYgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIGAke3YubmFtZX06ICR7di5tZXNzYWdlfWA7XG4gICAgICAgIHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSh2KTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcodik7IH1cbiAgICAgIH0pO1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICAgICAgXCJjb2RleHBwOnByZWxvYWQtbG9nXCIsXG4gICAgICAgIGxldmVsLFxuICAgICAgICBgW3R3ZWFrICR7aWR9XSAke3BhcnRzLmpvaW4oXCIgXCIpfWAsXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc3dhbGxvdyBcdTIwMTQgbmV2ZXIgbGV0IGxvZ2dpbmcgYnJlYWsgYSB0d2VhayAqL1xuICAgIH1cbiAgfTtcblxuICBjb25zdCBnaXQgPSBtYW5pZmVzdC5wZXJtaXNzaW9ucz8uaW5jbHVkZXMoXCJnaXQubWV0YWRhdGFcIikgPyByZW5kZXJlckdpdCgpIDogdW5kZWZpbmVkO1xuXG4gIHJldHVybiB7XG4gICAgbWFuaWZlc3QsXG4gICAgcHJvY2VzczogXCJyZW5kZXJlclwiLFxuICAgIGxvZzoge1xuICAgICAgZGVidWc6ICguLi5hKSA9PiBsb2coXCJkZWJ1Z1wiLCAuLi5hKSxcbiAgICAgIGluZm86ICguLi5hKSA9PiBsb2coXCJpbmZvXCIsIC4uLmEpLFxuICAgICAgd2FybjogKC4uLmEpID0+IGxvZyhcIndhcm5cIiwgLi4uYSksXG4gICAgICBlcnJvcjogKC4uLmEpID0+IGxvZyhcImVycm9yXCIsIC4uLmEpLFxuICAgIH0sXG4gICAgc3RvcmFnZTogcmVuZGVyZXJTdG9yYWdlKGlkKSxcbiAgICBzZXR0aW5nczoge1xuICAgICAgcmVnaXN0ZXI6IChzKSA9PiByZWdpc3RlclNlY3Rpb24oeyAuLi5zLCBpZDogYCR7aWR9OiR7cy5pZH1gIH0pLFxuICAgICAgcmVnaXN0ZXJQYWdlOiAocCkgPT5cbiAgICAgICAgcmVnaXN0ZXJQYWdlKGlkLCBtYW5pZmVzdCwgeyAuLi5wLCBpZDogYCR7aWR9OiR7cC5pZH1gIH0pLFxuICAgIH0sXG4gICAgcmVhY3Q6IHtcbiAgICAgIGdldEZpYmVyOiAobikgPT4gZmliZXJGb3JOb2RlKG4pIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbCxcbiAgICAgIGZpbmRPd25lckJ5TmFtZTogKG4sIG5hbWUpID0+IHtcbiAgICAgICAgbGV0IGYgPSBmaWJlckZvck5vZGUobikgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsO1xuICAgICAgICB3aGlsZSAoZikge1xuICAgICAgICAgIGNvbnN0IHQgPSBmLnR5cGUgYXMgeyBkaXNwbGF5TmFtZT86IHN0cmluZzsgbmFtZT86IHN0cmluZyB9IHwgbnVsbDtcbiAgICAgICAgICBpZiAodCAmJiAodC5kaXNwbGF5TmFtZSA9PT0gbmFtZSB8fCB0Lm5hbWUgPT09IG5hbWUpKSByZXR1cm4gZjtcbiAgICAgICAgICBmID0gZi5yZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgICAgd2FpdEZvckVsZW1lbnQ6IChzZWwsIHRpbWVvdXRNcyA9IDUwMDApID0+XG4gICAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTtcbiAgICAgICAgICBpZiAoZXhpc3RpbmcpIHJldHVybiByZXNvbHZlKGV4aXN0aW5nKTtcbiAgICAgICAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyB0aW1lb3V0TXM7XG4gICAgICAgICAgY29uc3Qgb2JzID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7XG4gICAgICAgICAgICBpZiAoZWwpIHtcbiAgICAgICAgICAgICAgb2JzLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICAgICAgcmVzb2x2ZShlbCk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKERhdGUubm93KCkgPiBkZWFkbGluZSkge1xuICAgICAgICAgICAgICBvYnMuZGlzY29ubmVjdCgpO1xuICAgICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGB0aW1lb3V0IHdhaXRpbmcgZm9yICR7c2VsfWApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgICBvYnMub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICAgICAgICB9KSxcbiAgICB9LFxuICAgIGlwYzoge1xuICAgICAgb246IChjLCBoKSA9PiB7XG4gICAgICAgIGNvbnN0IHdyYXBwZWQgPSAoX2U6IHVua25vd24sIC4uLmFyZ3M6IHVua25vd25bXSkgPT4gaCguLi5hcmdzKTtcbiAgICAgICAgaXBjUmVuZGVyZXIub24oYGNvZGV4cHA6JHtpZH06JHtjfWAsIHdyYXBwZWQpO1xuICAgICAgICByZXR1cm4gKCkgPT4gaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoYGNvZGV4cHA6JHtpZH06JHtjfWAsIHdyYXBwZWQpO1xuICAgICAgfSxcbiAgICAgIHNlbmQ6IChjLCAuLi5hcmdzKSA9PiBpcGNSZW5kZXJlci5zZW5kKGBjb2RleHBwOiR7aWR9OiR7Y31gLCAuLi5hcmdzKSxcbiAgICAgIGludm9rZTogPFQ+KGM6IHN0cmluZywgLi4uYXJnczogdW5rbm93bltdKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoYGNvZGV4cHA6JHtpZH06JHtjfWAsIC4uLmFyZ3MpIGFzIFByb21pc2U8VD4sXG4gICAgfSxcbiAgICBmczogcmVuZGVyZXJGcyhpZCwgcGF0aHMpLFxuICAgIC4uLihnaXQgPyB7IGdpdCB9IDoge30pLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlclN0b3JhZ2UoaWQ6IHN0cmluZykge1xuICBjb25zdCBrZXkgPSBgY29kZXhwcDpzdG9yYWdlOiR7aWR9YDtcbiAgY29uc3QgcmVhZCA9ICgpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKGtleSkgPz8gXCJ7fVwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiB7fTtcbiAgICB9XG4gIH07XG4gIGNvbnN0IHdyaXRlID0gKHY6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PlxuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKGtleSwgSlNPTi5zdHJpbmdpZnkodikpO1xuICByZXR1cm4ge1xuICAgIGdldDogPFQ+KGs6IHN0cmluZywgZD86IFQpID0+IChrIGluIHJlYWQoKSA/IChyZWFkKClba10gYXMgVCkgOiAoZCBhcyBUKSksXG4gICAgc2V0OiAoazogc3RyaW5nLCB2OiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBvID0gcmVhZCgpO1xuICAgICAgb1trXSA9IHY7XG4gICAgICB3cml0ZShvKTtcbiAgICB9LFxuICAgIGRlbGV0ZTogKGs6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgbyA9IHJlYWQoKTtcbiAgICAgIGRlbGV0ZSBvW2tdO1xuICAgICAgd3JpdGUobyk7XG4gICAgfSxcbiAgICBhbGw6ICgpID0+IHJlYWQoKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJGcyhpZDogc3RyaW5nLCBfcGF0aHM6IFVzZXJQYXRocykge1xuICAvLyBTYW5kYm94ZWQgcmVuZGVyZXIgY2FuJ3QgdXNlIE5vZGUgZnMgZGlyZWN0bHkgXHUyMDE0IHByb3h5IHRocm91Z2ggbWFpbiBJUEMuXG4gIHJldHVybiB7XG4gICAgZGF0YURpcjogYDxyZW1vdGU+L3R3ZWFrLWRhdGEvJHtpZH1gLFxuICAgIHJlYWQ6IChwOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnR3ZWFrLWZzXCIsIFwicmVhZFwiLCBpZCwgcCkgYXMgUHJvbWlzZTxzdHJpbmc+LFxuICAgIHdyaXRlOiAocDogc3RyaW5nLCBjOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnR3ZWFrLWZzXCIsIFwid3JpdGVcIiwgaWQsIHAsIGMpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgZXhpc3RzOiAocDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcImV4aXN0c1wiLCBpZCwgcCkgYXMgUHJvbWlzZTxib29sZWFuPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJHaXQoKSB7XG4gIHJldHVybiB7XG4gICAgcmVzb2x2ZVJlcG9zaXRvcnk6IChwYXRoOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdpdC1yZXNvbHZlLXJlcG9zaXRvcnlcIiwgcGF0aCksXG4gICAgZ2V0U3RhdHVzOiAocGF0aDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnaXQtc3RhdHVzXCIsIHBhdGgpLFxuICAgIGdldERpZmZTdW1tYXJ5OiAocGF0aDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnaXQtZGlmZi1zdW1tYXJ5XCIsIHBhdGgpLFxuICAgIGdldFdvcmt0cmVlczogKHBhdGg6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LXdvcmt0cmVlc1wiLCBwYXRoKSxcbiAgfTtcbn1cbiIsICIvKipcbiAqIEJ1aWx0LWluIFwiVHdlYWsgTWFuYWdlclwiIFx1MjAxNCBhdXRvLWluamVjdGVkIGJ5IHRoZSBydW50aW1lLCBub3QgYSB1c2VyIHR3ZWFrLlxuICogTGlzdHMgZGlzY292ZXJlZCB0d2Vha3Mgd2l0aCBlbmFibGUgdG9nZ2xlcywgb3BlbnMgdGhlIHR3ZWFrcyBkaXIsIGxpbmtzXG4gKiB0byBsb2dzIGFuZCBjb25maWcuIExpdmVzIGluIHRoZSByZW5kZXJlci5cbiAqXG4gKiBUaGlzIGlzIGludm9rZWQgZnJvbSBwcmVsb2FkL2luZGV4LnRzIEFGVEVSIHVzZXIgdHdlYWtzIGFyZSBsb2FkZWQgc28gaXRcbiAqIGNhbiBzaG93IHVwLXRvLWRhdGUgc3RhdHVzLlxuICovXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJTZWN0aW9uIH0gZnJvbSBcIi4vc2V0dGluZ3MtaW5qZWN0b3JcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1vdW50TWFuYWdlcigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHdlYWtzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6bGlzdC10d2Vha3NcIikpIGFzIEFycmF5PHtcbiAgICBtYW5pZmVzdDogeyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZzsgZGVzY3JpcHRpb24/OiBzdHJpbmcgfTtcbiAgICBlbnRyeUV4aXN0czogYm9vbGVhbjtcbiAgfT47XG4gIGNvbnN0IHBhdGhzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dXNlci1wYXRoc1wiKSkgYXMge1xuICAgIHVzZXJSb290OiBzdHJpbmc7XG4gICAgdHdlYWtzRGlyOiBzdHJpbmc7XG4gICAgbG9nRGlyOiBzdHJpbmc7XG4gIH07XG5cbiAgcmVnaXN0ZXJTZWN0aW9uKHtcbiAgICBpZDogXCJjb2RleC1wbHVzcGx1czptYW5hZ2VyXCIsXG4gICAgdGl0bGU6IFwiVHdlYWsgTWFuYWdlclwiLFxuICAgIGRlc2NyaXB0aW9uOiBgJHt0d2Vha3MubGVuZ3RofSB0d2VhayhzKSBpbnN0YWxsZWQuIFVzZXIgZGlyOiAke3BhdGhzLnVzZXJSb290fWAsXG4gICAgcmVuZGVyKHJvb3QpIHtcbiAgICAgIHJvb3Quc3R5bGUuY3NzVGV4dCA9IFwiZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6OHB4O1wiO1xuXG4gICAgICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGFjdGlvbnMuc3R5bGUuY3NzVGV4dCA9IFwiZGlzcGxheTpmbGV4O2dhcDo4cHg7ZmxleC13cmFwOndyYXA7XCI7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgICBidXR0b24oXCJPcGVuIHR3ZWFrcyBmb2xkZXJcIiwgKCkgPT5cbiAgICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnJldmVhbFwiLCBwYXRocy50d2Vha3NEaXIpLmNhdGNoKCgpID0+IHt9KSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgICBidXR0b24oXCJPcGVuIGxvZ3NcIiwgKCkgPT5cbiAgICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnJldmVhbFwiLCBwYXRocy5sb2dEaXIpLmNhdGNoKCgpID0+IHt9KSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgICBidXR0b24oXCJSZWxvYWQgd2luZG93XCIsICgpID0+IGxvY2F0aW9uLnJlbG9hZCgpKSxcbiAgICAgICk7XG4gICAgICByb290LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuXG4gICAgICBpZiAodHdlYWtzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwXCIpO1xuICAgICAgICBlbXB0eS5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTNweCBzeXN0ZW0tdWk7bWFyZ2luOjhweCAwO1wiO1xuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9XG4gICAgICAgICAgXCJObyB1c2VyIHR3ZWFrcyB5ZXQuIERyb3AgYSBmb2xkZXIgd2l0aCBtYW5pZmVzdC5qc29uICsgaW5kZXguanMgaW50byB0aGUgdHdlYWtzIGRpciwgdGhlbiByZWxvYWQuXCI7XG4gICAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwidWxcIik7XG4gICAgICBsaXN0LnN0eWxlLmNzc1RleHQgPSBcImxpc3Qtc3R5bGU6bm9uZTttYXJnaW46MDtwYWRkaW5nOjA7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6NnB4O1wiO1xuICAgICAgZm9yIChjb25zdCB0IG9mIHR3ZWFrcykge1xuICAgICAgICBjb25zdCBsaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcbiAgICAgICAgbGkuc3R5bGUuY3NzVGV4dCA9XG4gICAgICAgICAgXCJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6OHB4IDEwcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIsIzJhMmEyYSk7Ym9yZGVyLXJhZGl1czo2cHg7XCI7XG4gICAgICAgIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICBsZWZ0LmlubmVySFRNTCA9IGBcbiAgICAgICAgICA8ZGl2IHN0eWxlPVwiZm9udDo2MDAgMTNweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5uYW1lKX0gPHNwYW4gc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQtd2VpZ2h0OjQwMDtcIj52JHtlc2NhcGUodC5tYW5pZmVzdC52ZXJzaW9uKX08L3NwYW4+PC9kaXY+XG4gICAgICAgICAgPGRpdiBzdHlsZT1cImNvbG9yOiM4ODg7Zm9udDoxMnB4IHN5c3RlbS11aTtcIj4ke2VzY2FwZSh0Lm1hbmlmZXN0LmRlc2NyaXB0aW9uID8/IHQubWFuaWZlc3QuaWQpfTwvZGl2PlxuICAgICAgICBgO1xuICAgICAgICBjb25zdCByaWdodCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIHJpZ2h0LnN0eWxlLmNzc1RleHQgPSBcImNvbG9yOiM4ODg7Zm9udDoxMnB4IHN5c3RlbS11aTtcIjtcbiAgICAgICAgcmlnaHQudGV4dENvbnRlbnQgPSB0LmVudHJ5RXhpc3RzID8gXCJsb2FkZWRcIiA6IFwibWlzc2luZyBlbnRyeVwiO1xuICAgICAgICBsaS5hcHBlbmQobGVmdCwgcmlnaHQpO1xuICAgICAgICBsaXN0LmFwcGVuZChsaSk7XG4gICAgICB9XG4gICAgICByb290LmFwcGVuZChsaXN0KTtcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gYnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uY2xpY2s6ICgpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICBiLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGIuc3R5bGUuY3NzVGV4dCA9XG4gICAgXCJwYWRkaW5nOjZweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMzMzMpO2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6aW5oZXJpdDtmb250OjEycHggc3lzdGVtLXVpO2N1cnNvcjpwb2ludGVyO1wiO1xuICBiLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbmNsaWNrKTtcbiAgcmV0dXJuIGI7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZShzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcy5yZXBsYWNlKC9bJjw+XCInXS9nLCAoYykgPT5cbiAgICBjID09PSBcIiZcIlxuICAgICAgPyBcIiZhbXA7XCJcbiAgICAgIDogYyA9PT0gXCI8XCJcbiAgICAgICAgPyBcIiZsdDtcIlxuICAgICAgICA6IGMgPT09IFwiPlwiXG4gICAgICAgICAgPyBcIiZndDtcIlxuICAgICAgICAgIDogYyA9PT0gJ1wiJ1xuICAgICAgICAgICAgPyBcIiZxdW90O1wiXG4gICAgICAgICAgICA6IFwiJiMzOTtcIixcbiAgKTtcbn1cbiIsICJpbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuXG5jb25zdCBDT0RFWF9NRVNTQUdFX0ZST01fVklFVyA9IFwiY29kZXhfZGVza3RvcDptZXNzYWdlLWZyb20tdmlld1wiO1xuY29uc3QgQ09ERVhfTUVTU0FHRV9GT1JfVklFVyA9IFwiY29kZXhfZGVza3RvcDptZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBERUZBVUxUX1JFUVVFU1RfVElNRU9VVF9NUyA9IDEyXzAwMDtcblxuZGVjbGFyZSBnbG9iYWwge1xuICBpbnRlcmZhY2UgV2luZG93IHtcbiAgICBlbGVjdHJvbkJyaWRnZT86IHtcbiAgICAgIHNlbmRNZXNzYWdlRnJvbVZpZXc/KG1lc3NhZ2U6IHVua25vd24pOiBQcm9taXNlPHZvaWQ+O1xuICAgIH07XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBTZXJ2ZXJSZXF1ZXN0T3B0aW9ucyB7XG4gIGhvc3RJZD86IHN0cmluZztcbiAgdGltZW91dE1zPzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFNlcnZlck5vdGlmaWNhdGlvbiB7XG4gIG1ldGhvZDogc3RyaW5nO1xuICBwYXJhbXM6IHVua25vd247XG59XG5cbmludGVyZmFjZSBQZW5kaW5nUmVxdWVzdCB7XG4gIGlkOiBzdHJpbmc7XG4gIHJlc29sdmUodmFsdWU6IHVua25vd24pOiB2b2lkO1xuICByZWplY3QoZXJyb3I6IEVycm9yKTogdm9pZDtcbiAgdGltZW91dDogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD47XG59XG5cbmxldCBuZXh0UmVxdWVzdElkID0gMTtcbmNvbnN0IHBlbmRpbmdSZXF1ZXN0cyA9IG5ldyBNYXA8c3RyaW5nLCBQZW5kaW5nUmVxdWVzdD4oKTtcbmNvbnN0IG5vdGlmaWNhdGlvbkxpc3RlbmVycyA9IG5ldyBTZXQ8KG5vdGlmaWNhdGlvbjogQXBwU2VydmVyTm90aWZpY2F0aW9uKSA9PiB2b2lkPigpO1xubGV0IHN1YnNjcmliZWQgPSBmYWxzZTtcblxuZXhwb3J0IGZ1bmN0aW9uIHJlcXVlc3RBcHBTZXJ2ZXI8VD4oXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXJhbXM6IHVua25vd24sXG4gIG9wdGlvbnM6IEFwcFNlcnZlclJlcXVlc3RPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFQ+IHtcbiAgZW5zdXJlU3Vic2NyaWJlZCgpO1xuICBjb25zdCBpZCA9IGBjb2RleHBwLSR7RGF0ZS5ub3coKX0tJHtuZXh0UmVxdWVzdElkKyt9YDtcbiAgY29uc3QgaG9zdElkID0gb3B0aW9ucy5ob3N0SWQgPz8gcmVhZEhvc3RJZCgpO1xuICBjb25zdCB0aW1lb3V0TXMgPSBvcHRpb25zLnRpbWVvdXRNcyA/PyBERUZBVUxUX1JFUVVFU1RfVElNRU9VVF9NUztcblxuICByZXR1cm4gbmV3IFByb21pc2U8VD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoaWQpO1xuICAgICAgcmVqZWN0KG5ldyBFcnJvcihgVGltZWQgb3V0IHdhaXRpbmcgZm9yIGFwcC1zZXJ2ZXIgcmVzcG9uc2UgdG8gJHttZXRob2R9YCkpO1xuICAgIH0sIHRpbWVvdXRNcyk7XG5cbiAgICBwZW5kaW5nUmVxdWVzdHMuc2V0KGlkLCB7XG4gICAgICBpZCxcbiAgICAgIHJlc29sdmU6ICh2YWx1ZSkgPT4gcmVzb2x2ZSh2YWx1ZSBhcyBUKSxcbiAgICAgIHJlamVjdCxcbiAgICAgIHRpbWVvdXQsXG4gICAgfSk7XG5cbiAgICBjb25zdCBtZXNzYWdlID0ge1xuICAgICAgdHlwZTogXCJtY3AtcmVxdWVzdFwiLFxuICAgICAgaG9zdElkLFxuICAgICAgcmVxdWVzdDogeyBpZCwgbWV0aG9kLCBwYXJhbXMgfSxcbiAgICB9O1xuXG4gICAgc2VuZE1lc3NhZ2VGcm9tVmlldyhtZXNzYWdlKS50aGVuKChyZXNwb25zZSkgPT4ge1xuICAgICAgaWYgKHJlc3BvbnNlICE9PSB1bmRlZmluZWQpIGhhbmRsZUluY29taW5nTWVzc2FnZShyZXNwb25zZSk7XG4gICAgfSkuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICBjb25zdCBwZW5kaW5nID0gcGVuZGluZ1JlcXVlc3RzLmdldChpZCk7XG4gICAgICBpZiAoIXBlbmRpbmcpIHJldHVybjtcbiAgICAgIGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVvdXQpO1xuICAgICAgcGVuZGluZ1JlcXVlc3RzLmRlbGV0ZShpZCk7XG4gICAgICBwZW5kaW5nLnJlamVjdCh0b0Vycm9yKGVycm9yKSk7XG4gICAgfSk7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gb25BcHBTZXJ2ZXJOb3RpZmljYXRpb24oXG4gIGxpc3RlbmVyOiAobm90aWZpY2F0aW9uOiBBcHBTZXJ2ZXJOb3RpZmljYXRpb24pID0+IHZvaWQsXG4pOiAoKSA9PiB2b2lkIHtcbiAgZW5zdXJlU3Vic2NyaWJlZCgpO1xuICBub3RpZmljYXRpb25MaXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgcmV0dXJuICgpID0+IG5vdGlmaWNhdGlvbkxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVhZEhvc3RJZCgpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG4gICAgY29uc3QgaG9zdElkID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJob3N0SWRcIik/LnRyaW0oKTtcbiAgICByZXR1cm4gaG9zdElkIHx8IFwibG9jYWxcIjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwibG9jYWxcIjtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbnN1cmVTdWJzY3JpYmVkKCk6IHZvaWQge1xuICBpZiAoc3Vic2NyaWJlZCkgcmV0dXJuO1xuICBzdWJzY3JpYmVkID0gdHJ1ZTtcbiAgaXBjUmVuZGVyZXIub24oQ09ERVhfTUVTU0FHRV9GT1JfVklFVywgKF9ldmVudCwgbWVzc2FnZSkgPT4ge1xuICAgIGhhbmRsZUluY29taW5nTWVzc2FnZShtZXNzYWdlKTtcbiAgfSk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwibWVzc2FnZVwiLCAoZXZlbnQpID0+IHtcbiAgICBoYW5kbGVJbmNvbWluZ01lc3NhZ2UoZXZlbnQuZGF0YSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVJbmNvbWluZ01lc3NhZ2UobWVzc2FnZTogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBub3RpZmljYXRpb24gPSBleHRyYWN0Tm90aWZpY2F0aW9uKG1lc3NhZ2UpO1xuICBpZiAobm90aWZpY2F0aW9uKSB7XG4gICAgZm9yIChjb25zdCBsaXN0ZW5lciBvZiBub3RpZmljYXRpb25MaXN0ZW5lcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGxpc3RlbmVyKG5vdGlmaWNhdGlvbik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogaXNvbGF0ZSBsaXN0ZW5lciBmYWlsdXJlcyAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gZXh0cmFjdFJlc3BvbnNlKG1lc3NhZ2UpO1xuICBpZiAoIXJlc3BvbnNlKSByZXR1cm47XG4gIGNvbnN0IHBlbmRpbmcgPSBwZW5kaW5nUmVxdWVzdHMuZ2V0KHJlc3BvbnNlLmlkKTtcbiAgaWYgKCFwZW5kaW5nKSByZXR1cm47XG5cbiAgY2xlYXJUaW1lb3V0KHBlbmRpbmcudGltZW91dCk7XG4gIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUocmVzcG9uc2UuaWQpO1xuICBpZiAocmVzcG9uc2UuZXJyb3IpIHtcbiAgICBwZW5kaW5nLnJlamVjdChyZXNwb25zZS5lcnJvcik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHBlbmRpbmcucmVzb2x2ZShyZXNwb25zZS5yZXN1bHQpO1xufVxuXG5mdW5jdGlvbiBleHRyYWN0UmVzcG9uc2UobWVzc2FnZTogdW5rbm93bik6IHsgaWQ6IHN0cmluZzsgcmVzdWx0PzogdW5rbm93bjsgZXJyb3I/OiBFcnJvciB9IHwgbnVsbCB7XG4gIGlmICghaXNSZWNvcmQobWVzc2FnZSkpIHJldHVybiBudWxsO1xuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwibWNwLXJlc3BvbnNlXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5yZXNwb25zZSkpIHtcbiAgICByZXR1cm4gcmVzcG9uc2VGcm9tRW52ZWxvcGUobWVzc2FnZS5yZXNwb25zZSk7XG4gIH1cblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1yZXNwb25zZVwiICYmIGlzUmVjb3JkKG1lc3NhZ2UubWVzc2FnZSkpIHtcbiAgICByZXR1cm4gcmVzcG9uc2VGcm9tRW52ZWxvcGUobWVzc2FnZS5tZXNzYWdlKTtcbiAgfVxuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwibWNwLWVycm9yXCIgJiYgdHlwZW9mIG1lc3NhZ2UuaWQgPT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4geyBpZDogbWVzc2FnZS5pZCwgZXJyb3I6IG5ldyBFcnJvcihyZWFkRXJyb3JNZXNzYWdlKG1lc3NhZ2UuZXJyb3IpID8/IFwiQXBwLXNlcnZlciByZXF1ZXN0IGZhaWxlZFwiKSB9O1xuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJyZXNwb25zZVwiICYmIHR5cGVvZiBtZXNzYWdlLmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UpO1xuICB9XG5cbiAgaWYgKHR5cGVvZiBtZXNzYWdlLmlkID09PSBcInN0cmluZ1wiICYmIChcInJlc3VsdFwiIGluIG1lc3NhZ2UgfHwgXCJlcnJvclwiIGluIG1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UpO1xuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHJlc3BvbnNlRnJvbUVudmVsb3BlKGVudmVsb3BlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHsgaWQ6IHN0cmluZzsgcmVzdWx0PzogdW5rbm93bjsgZXJyb3I/OiBFcnJvciB9IHwgbnVsbCB7XG4gIGNvbnN0IGlkID0gdHlwZW9mIGVudmVsb3BlLmlkID09PSBcInN0cmluZ1wiIHx8IHR5cGVvZiBlbnZlbG9wZS5pZCA9PT0gXCJudW1iZXJcIlxuICAgID8gU3RyaW5nKGVudmVsb3BlLmlkKVxuICAgIDogbnVsbDtcbiAgaWYgKCFpZCkgcmV0dXJuIG51bGw7XG5cbiAgaWYgKFwiZXJyb3JcIiBpbiBlbnZlbG9wZSkge1xuICAgIHJldHVybiB7IGlkLCBlcnJvcjogbmV3IEVycm9yKHJlYWRFcnJvck1lc3NhZ2UoZW52ZWxvcGUuZXJyb3IpID8/IFwiQXBwLXNlcnZlciByZXF1ZXN0IGZhaWxlZFwiKSB9O1xuICB9XG5cbiAgcmV0dXJuIHsgaWQsIHJlc3VsdDogZW52ZWxvcGUucmVzdWx0IH07XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3ROb3RpZmljYXRpb24obWVzc2FnZTogdW5rbm93bik6IEFwcFNlcnZlck5vdGlmaWNhdGlvbiB8IG51bGwge1xuICBpZiAoIWlzUmVjb3JkKG1lc3NhZ2UpKSByZXR1cm4gbnVsbDtcblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1ub3RpZmljYXRpb25cIiAmJiBpc1JlY29yZChtZXNzYWdlLnJlcXVlc3QpKSB7XG4gICAgY29uc3QgbWV0aG9kID0gbWVzc2FnZS5yZXF1ZXN0Lm1ldGhvZDtcbiAgICBpZiAodHlwZW9mIG1ldGhvZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgcmV0dXJuIHsgbWV0aG9kLCBwYXJhbXM6IG1lc3NhZ2UucmVxdWVzdC5wYXJhbXMgfTtcbiAgICB9XG4gIH1cblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1ub3RpZmljYXRpb25cIiAmJiBpc1JlY29yZChtZXNzYWdlLm1lc3NhZ2UpKSB7XG4gICAgY29uc3QgbWV0aG9kID0gbWVzc2FnZS5tZXNzYWdlLm1ldGhvZDtcbiAgICBpZiAodHlwZW9mIG1ldGhvZCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgcmV0dXJuIHsgbWV0aG9kLCBwYXJhbXM6IG1lc3NhZ2UubWVzc2FnZS5wYXJhbXMgfTtcbiAgICB9XG4gIH1cblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1ub3RpZmljYXRpb25cIiAmJiB0eXBlb2YgbWVzc2FnZS5tZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICByZXR1cm4geyBtZXRob2Q6IG1lc3NhZ2UubWV0aG9kLCBwYXJhbXM6IG1lc3NhZ2UucGFyYW1zIH07XG4gIH1cblxuICBpZiAodHlwZW9mIG1lc3NhZ2UubWV0aG9kID09PSBcInN0cmluZ1wiICYmICEoXCJpZFwiIGluIG1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIHsgbWV0aG9kOiBtZXNzYWdlLm1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnBhcmFtcyB9O1xuICB9XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHJlYWRFcnJvck1lc3NhZ2UoZXJyb3I6IHVua25vd24pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKGVycm9yIGluc3RhbmNlb2YgRXJyb3IpIHJldHVybiBlcnJvci5tZXNzYWdlO1xuICBpZiAodHlwZW9mIGVycm9yID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3I7XG4gIGlmIChpc1JlY29yZChlcnJvcikpIHtcbiAgICBpZiAodHlwZW9mIGVycm9yLm1lc3NhZ2UgPT09IFwic3RyaW5nXCIpIHJldHVybiBlcnJvci5tZXNzYWdlO1xuICAgIGlmICh0eXBlb2YgZXJyb3IuZXJyb3IgPT09IFwic3RyaW5nXCIpIHJldHVybiBlcnJvci5lcnJvcjtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gc2VuZE1lc3NhZ2VGcm9tVmlldyhtZXNzYWdlOiB1bmtub3duKTogUHJvbWlzZTx1bmtub3duPiB7XG4gIGNvbnN0IGJyaWRnZVNlbmRlciA9IHdpbmRvdy5lbGVjdHJvbkJyaWRnZT8uc2VuZE1lc3NhZ2VGcm9tVmlldztcbiAgaWYgKHR5cGVvZiBicmlkZ2VTZW5kZXIgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIHJldHVybiBicmlkZ2VTZW5kZXIuY2FsbCh3aW5kb3cuZWxlY3Ryb25CcmlkZ2UsIG1lc3NhZ2UpLnRoZW4oKCkgPT4gdW5kZWZpbmVkKTtcbiAgfVxuICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKENPREVYX01FU1NBR0VfRlJPTV9WSUVXLCBtZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gdG9FcnJvcihlcnJvcjogdW5rbm93bik6IEVycm9yIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvciA6IG5ldyBFcnJvcihTdHJpbmcoZXJyb3IpKTtcbn1cblxuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB2YWx1ZSAhPT0gbnVsbCAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuIiwgImltcG9ydCB7IG9uQXBwU2VydmVyTm90aWZpY2F0aW9uLCByZWFkSG9zdElkLCByZXF1ZXN0QXBwU2VydmVyIH0gZnJvbSBcIi4vYXBwLXNlcnZlci1icmlkZ2VcIjtcblxudHlwZSBHb2FsU3RhdHVzID0gXCJhY3RpdmVcIiB8IFwicGF1c2VkXCIgfCBcImJ1ZGdldExpbWl0ZWRcIiB8IFwiY29tcGxldGVcIjtcblxuaW50ZXJmYWNlIFRocmVhZEdvYWwge1xuICB0aHJlYWRJZDogc3RyaW5nO1xuICBvYmplY3RpdmU6IHN0cmluZztcbiAgc3RhdHVzOiBHb2FsU3RhdHVzO1xuICB0b2tlbkJ1ZGdldDogbnVtYmVyIHwgbnVsbDtcbiAgdG9rZW5zVXNlZDogbnVtYmVyO1xuICB0aW1lVXNlZFNlY29uZHM6IG51bWJlcjtcbiAgY3JlYXRlZEF0OiBudW1iZXI7XG4gIHVwZGF0ZWRBdDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgR29hbFVpQWN0aW9uIHtcbiAgbGFiZWw6IHN0cmluZztcbiAga2luZD86IFwicHJpbWFyeVwiIHwgXCJkYW5nZXJcIjtcbiAgcnVuKCk6IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xufVxuXG5pbnRlcmZhY2UgR29hbFBhbmVsT3B0aW9ucyB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGRldGFpbDogc3RyaW5nO1xuICBmb290ZXI/OiBzdHJpbmc7XG4gIGFjdGlvbnM6IEdvYWxVaUFjdGlvbltdO1xuICBwZXJzaXN0ZW50OiBib29sZWFuO1xuICBlcnJvcj86IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBHb2FsUGFuZWxTdGF0ZSB7XG4gIGNvbGxhcHNlZDogYm9vbGVhbjtcbiAgeDogbnVtYmVyIHwgbnVsbDtcbiAgeTogbnVtYmVyIHwgbnVsbDtcbiAgd2lkdGg6IG51bWJlciB8IG51bGw7XG4gIGhlaWdodDogbnVtYmVyIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIEdvYWxQYW5lbERyYWcge1xuICBwb2ludGVySWQ6IG51bWJlcjtcbiAgb2Zmc2V0WDogbnVtYmVyO1xuICBvZmZzZXRZOiBudW1iZXI7XG4gIHdpZHRoOiBudW1iZXI7XG4gIGhlaWdodDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgR29hbFBhbmVsUmVzaXplIHtcbiAgcG9pbnRlcklkOiBudW1iZXI7XG4gIHN0YXJ0WDogbnVtYmVyO1xuICBzdGFydFk6IG51bWJlcjtcbiAgd2lkdGg6IG51bWJlcjtcbiAgaGVpZ2h0OiBudW1iZXI7XG59XG5cbmludGVyZmFjZSBFZGl0YWJsZVRhcmdldCB7XG4gIGVsZW1lbnQ6IEhUTUxFbGVtZW50O1xuICBnZXRUZXh0KCk6IHN0cmluZztcbiAgc2V0VGV4dCh2YWx1ZTogc3RyaW5nKTogdm9pZDtcbiAgY2xlYXIoKTogdm9pZDtcbn1cblxubGV0IHN0YXJ0ZWQgPSBmYWxzZTtcbmxldCByb290OiBIVE1MRGl2RWxlbWVudCB8IG51bGwgPSBudWxsO1xubGV0IHN1Z2dlc3Rpb25Sb290OiBIVE1MRGl2RWxlbWVudCB8IG51bGwgPSBudWxsO1xubGV0IGN1cnJlbnRHb2FsOiBUaHJlYWRHb2FsIHwgbnVsbCA9IG51bGw7XG5sZXQgaGlkZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xubGV0IGxhc3RUaHJlYWRJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5sZXQgbGFzdFBhbmVsT3B0aW9uczogR29hbFBhbmVsT3B0aW9ucyB8IG51bGwgPSBudWxsO1xubGV0IHBhbmVsRHJhZzogR29hbFBhbmVsRHJhZyB8IG51bGwgPSBudWxsO1xubGV0IHBhbmVsUmVzaXplOiBHb2FsUGFuZWxSZXNpemUgfCBudWxsID0gbnVsbDtcblxuY29uc3QgR09BTF9QQU5FTF9TVEFURV9LRVkgPSBcImNvZGV4cHA6Z29hbC1wYW5lbC1zdGF0ZVwiO1xuY29uc3QgR09BTF9QQU5FTF9NSU5fV0lEVEggPSAyODA7XG5jb25zdCBHT0FMX1BBTkVMX01JTl9IRUlHSFQgPSAxNjA7XG5jb25zdCBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTiA9IDg7XG5sZXQgcGFuZWxTdGF0ZTogR29hbFBhbmVsU3RhdGUgPSByZWFkR29hbFBhbmVsU3RhdGUoKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0R29hbEZlYXR1cmUobG9nOiAoc3RhZ2U6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKSA9PiB2b2lkID0gKCkgPT4ge30pOiB2b2lkIHtcbiAgaWYgKHN0YXJ0ZWQpIHJldHVybjtcbiAgc3RhcnRlZCA9IHRydWU7XG4gIGluc3RhbGxTdHlsZXMoKTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgKGV2ZW50KSA9PiB7XG4gICAgdm9pZCBoYW5kbGVLZXlkb3duKGV2ZW50LCBsb2cpO1xuICB9LCB0cnVlKTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsIChldmVudCkgPT4ge1xuICAgIHVwZGF0ZUdvYWxTdWdnZXN0aW9uKGZpbmRFZGl0YWJsZVRhcmdldChldmVudCkpO1xuICB9LCB0cnVlKTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImZvY3VzaW5cIiwgKGV2ZW50KSA9PiB7XG4gICAgdXBkYXRlR29hbFN1Z2dlc3Rpb24oZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50KSk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGV2ZW50KSA9PiB7XG4gICAgaWYgKHN1Z2dlc3Rpb25Sb290Py5jb250YWlucyhldmVudC50YXJnZXQgYXMgTm9kZSkpIHJldHVybjtcbiAgICB1cGRhdGVHb2FsU3VnZ2VzdGlvbihmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpKTtcbiAgfSwgdHJ1ZSk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicmVzaXplXCIsICgpID0+IHtcbiAgICBpZiAoIXJvb3Q/LmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgYXBwbHlHb2FsUGFuZWxTaXplKHJvb3QpO1xuICAgIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChyb290KTtcbiAgICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xuICB9KTtcbiAgb25BcHBTZXJ2ZXJOb3RpZmljYXRpb24oKG5vdGlmaWNhdGlvbikgPT4ge1xuICAgIGlmIChub3RpZmljYXRpb24ubWV0aG9kID09PSBcInRocmVhZC9nb2FsL3VwZGF0ZWRcIiAmJiBpc1JlY29yZChub3RpZmljYXRpb24ucGFyYW1zKSkge1xuICAgICAgY29uc3QgZ29hbCA9IG5vdGlmaWNhdGlvbi5wYXJhbXMuZ29hbDtcbiAgICAgIGlmIChpc1RocmVhZEdvYWwoZ29hbCkpIHtcbiAgICAgICAgaWYgKGdvYWwudGhyZWFkSWQgIT09IHJlYWRUaHJlYWRJZCgpKSByZXR1cm47XG4gICAgICAgIGN1cnJlbnRHb2FsID0gZ29hbDtcbiAgICAgICAgcmVuZGVyR29hbChnb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChub3RpZmljYXRpb24ubWV0aG9kID09PSBcInRocmVhZC9nb2FsL2NsZWFyZWRcIiAmJiBpc1JlY29yZChub3RpZmljYXRpb24ucGFyYW1zKSkge1xuICAgICAgY29uc3QgdGhyZWFkSWQgPSBub3RpZmljYXRpb24ucGFyYW1zLnRocmVhZElkO1xuICAgICAgaWYgKHR5cGVvZiB0aHJlYWRJZCA9PT0gXCJzdHJpbmdcIiAmJiB0aHJlYWRJZCA9PT0gcmVhZFRocmVhZElkKCkpIHtcbiAgICAgICAgY3VycmVudEdvYWwgPSBudWxsO1xuICAgICAgICByZW5kZXJOb3RpY2UoXCJHb2FsIGNsZWFyZWRcIiwgXCJUaGlzIHRocmVhZCBubyBsb25nZXIgaGFzIGFuIGFjdGl2ZSBnb2FsLlwiKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9wc3RhdGVcIiwgKCkgPT4gcmVmcmVzaEdvYWxGb3JSb3V0ZShsb2cpKTtcbiAgY29uc3QgcmVmcmVzaFRpbWVyID0gc2V0SW50ZXJ2YWwoKCkgPT4gcmVmcmVzaEdvYWxGb3JSb3V0ZShsb2cpLCAyXzUwMCk7XG4gIGNvbnN0IHVucmVmID0gKHJlZnJlc2hUaW1lciBhcyB1bmtub3duIGFzIHsgdW5yZWY/OiAoKSA9PiB2b2lkIH0pLnVucmVmO1xuICBpZiAodHlwZW9mIHVucmVmID09PSBcImZ1bmN0aW9uXCIpIHVucmVmLmNhbGwocmVmcmVzaFRpbWVyKTtcbiAgcXVldWVNaWNyb3Rhc2soKCkgPT4gcmVmcmVzaEdvYWxGb3JSb3V0ZShsb2cpKTtcbiAgbG9nKFwiZ29hbCBmZWF0dXJlIHN0YXJ0ZWRcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUtleWRvd24oZXZlbnQ6IEtleWJvYXJkRXZlbnQsIGxvZzogKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bikgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoZXZlbnQuaXNDb21wb3NpbmcpIHJldHVybjtcblxuICBjb25zdCBlZGl0YWJsZSA9IGZpbmRFZGl0YWJsZVRhcmdldChldmVudCk7XG4gIGlmICghZWRpdGFibGUpIHJldHVybjtcblxuICBpZiAoZXZlbnQua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKChldmVudC5rZXkgPT09IFwiVGFiXCIgfHwgZXZlbnQua2V5ID09PSBcIkVudGVyXCIpICYmICFldmVudC5zaGlmdEtleSAmJiAhZXZlbnQuYWx0S2V5ICYmICFldmVudC5jdHJsS2V5ICYmICFldmVudC5tZXRhS2V5KSB7XG4gICAgY29uc3Qgc3VnZ2VzdGlvbiA9IHBhcnNlR29hbFN1Z2dlc3Rpb24oZWRpdGFibGUuZ2V0VGV4dCgpKTtcbiAgICBpZiAoc3VnZ2VzdGlvbiAmJiBlZGl0YWJsZS5nZXRUZXh0KCkudHJpbSgpICE9PSBcIi9nb2FsXCIpIHtcbiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIGV2ZW50LnN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpO1xuICAgICAgYXBwbHlHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG5cbiAgaWYgKGV2ZW50LmtleSAhPT0gXCJFbnRlclwiIHx8IGV2ZW50LnNoaWZ0S2V5IHx8IGV2ZW50LmFsdEtleSB8fCBldmVudC5jdHJsS2V5IHx8IGV2ZW50Lm1ldGFLZXkpIHJldHVybjtcblxuICBjb25zdCBwYXJzZWQgPSBwYXJzZUdvYWxDb21tYW5kKGVkaXRhYmxlLmdldFRleHQoKSk7XG4gIGlmICghcGFyc2VkKSByZXR1cm47XG5cbiAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gIGV2ZW50LnN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpO1xuICBlZGl0YWJsZS5jbGVhcigpO1xuICBoaWRlR29hbFN1Z2dlc3Rpb24oKTtcblxuICB0cnkge1xuICAgIGF3YWl0IHJ1bkdvYWxDb21tYW5kKHBhcnNlZC5hcmdzLCBsb2cpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGxvZyhcImdvYWwgY29tbWFuZCBmYWlsZWRcIiwgc3RyaW5naWZ5RXJyb3IoZXJyb3IpKTtcbiAgICByZW5kZXJFcnJvcihcIkdvYWwgY29tbWFuZCBmYWlsZWRcIiwgZnJpZW5kbHlHb2FsRXJyb3IoZXJyb3IpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBwYXJzZUdvYWxDb21tYW5kKHRleHQ6IHN0cmluZyk6IHsgYXJnczogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSB0ZXh0LnRyaW0oKS5tYXRjaCgvXlxcL2dvYWwoPzpcXHMrKFtcXHNcXFNdKikpPyQvKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IGFyZ3M6IChtYXRjaFsxXSA/PyBcIlwiKS50cmltKCkgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VHb2FsU3VnZ2VzdGlvbih0ZXh0OiBzdHJpbmcpOiB7IHF1ZXJ5OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IHRleHQudHJpbSgpLm1hdGNoKC9eXFwvKFthLXpdKikkL2kpO1xuICBpZiAoIW1hdGNoKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcXVlcnkgPSBtYXRjaFsxXT8udG9Mb3dlckNhc2UoKSA/PyBcIlwiO1xuICByZXR1cm4gXCJnb2FsXCIuc3RhcnRzV2l0aChxdWVyeSkgPyB7IHF1ZXJ5IH0gOiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5Hb2FsQ29tbWFuZChhcmdzOiBzdHJpbmcsIGxvZzogKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bikgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aHJlYWRJZCA9IHJlYWRUaHJlYWRJZCgpO1xuICBpZiAoIXRocmVhZElkKSB7XG4gICAgcmVuZGVyRXJyb3IoXCJObyBhY3RpdmUgdGhyZWFkXCIsIFwiT3BlbiBhIGxvY2FsIHRocmVhZCBiZWZvcmUgdXNpbmcgL2dvYWwuXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBob3N0SWQgPSByZWFkSG9zdElkKCk7XG4gIGNvbnN0IGxvd2VyID0gYXJncy50b0xvd2VyQ2FzZSgpO1xuXG4gIGlmICghYXJncykge1xuICAgIGNvbnN0IGdvYWwgPSBhd2FpdCBnZXRHb2FsKHRocmVhZElkLCBob3N0SWQpO1xuICAgIGN1cnJlbnRHb2FsID0gZ29hbDtcbiAgICBpZiAoZ29hbCkge1xuICAgICAgcmVuZGVyR29hbChnb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJlbmRlck5vdGljZShcIk5vIGdvYWwgc2V0XCIsIFwiVXNlIC9nb2FsIDxvYmplY3RpdmU+IHRvIHNldCBvbmUgZm9yIHRoaXMgdGhyZWFkLlwiKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGxvd2VyID09PSBcImNsZWFyXCIpIHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBjbGVhcmVkOiBib29sZWFuIH0+KFxuICAgICAgXCJ0aHJlYWQvZ29hbC9jbGVhclwiLFxuICAgICAgeyB0aHJlYWRJZCB9LFxuICAgICAgeyBob3N0SWQgfSxcbiAgICApO1xuICAgIGN1cnJlbnRHb2FsID0gbnVsbDtcbiAgICByZW5kZXJOb3RpY2UocmVzcG9uc2UuY2xlYXJlZCA/IFwiR29hbCBjbGVhcmVkXCIgOiBcIk5vIGdvYWwgc2V0XCIsIFwiVXNlIC9nb2FsIDxvYmplY3RpdmU+IHRvIHNldCBhIG5ldyBnb2FsLlwiKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAobG93ZXIgPT09IFwicGF1c2VcIiB8fCBsb3dlciA9PT0gXCJyZXN1bWVcIiB8fCBsb3dlciA9PT0gXCJjb21wbGV0ZVwiKSB7XG4gICAgY29uc3Qgc3RhdHVzOiBHb2FsU3RhdHVzID0gbG93ZXIgPT09IFwicGF1c2VcIiA/IFwicGF1c2VkXCIgOiBsb3dlciA9PT0gXCJyZXN1bWVcIiA/IFwiYWN0aXZlXCIgOiBcImNvbXBsZXRlXCI7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgZ29hbDogVGhyZWFkR29hbCB9PihcbiAgICAgIFwidGhyZWFkL2dvYWwvc2V0XCIsXG4gICAgICB7IHRocmVhZElkLCBzdGF0dXMgfSxcbiAgICAgIHsgaG9zdElkIH0sXG4gICAgKTtcbiAgICBjdXJyZW50R29hbCA9IHJlc3BvbnNlLmdvYWw7XG4gICAgcmVuZGVyR29hbChyZXNwb25zZS5nb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCBnZXRHb2FsKHRocmVhZElkLCBob3N0SWQpO1xuICBpZiAoZXhpc3RpbmcgJiYgZXhpc3Rpbmcub2JqZWN0aXZlICE9PSBhcmdzKSB7XG4gICAgY29uc3QgcmVwbGFjZSA9IGF3YWl0IGNvbmZpcm1SZXBsYWNlR29hbChleGlzdGluZywgYXJncyk7XG4gICAgaWYgKCFyZXBsYWNlKSB7XG4gICAgICBjdXJyZW50R29hbCA9IGV4aXN0aW5nO1xuICAgICAgcmVuZGVyR29hbChleGlzdGluZywgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgXCJ0aHJlYWQvZ29hbC9zZXRcIixcbiAgICB7IHRocmVhZElkLCBvYmplY3RpdmU6IGFyZ3MsIHN0YXR1czogXCJhY3RpdmVcIiB9LFxuICAgIHsgaG9zdElkIH0sXG4gICk7XG4gIGN1cnJlbnRHb2FsID0gcmVzcG9uc2UuZ29hbDtcbiAgbG9nKFwiZ29hbCBzZXRcIiwgeyB0aHJlYWRJZCB9KTtcbiAgcmVuZGVyR29hbChyZXNwb25zZS5nb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldEdvYWwodGhyZWFkSWQ6IHN0cmluZywgaG9zdElkOiBzdHJpbmcpOiBQcm9taXNlPFRocmVhZEdvYWwgfCBudWxsPiB7XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfCBudWxsIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvZ2V0XCIsXG4gICAgeyB0aHJlYWRJZCB9LFxuICAgIHsgaG9zdElkIH0sXG4gICk7XG4gIHJldHVybiByZXNwb25zZS5nb2FsO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoR29hbEZvclJvdXRlKGxvZzogKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bikgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aHJlYWRJZCA9IHJlYWRUaHJlYWRJZCgpO1xuICBpZiAoIXRocmVhZElkKSB7XG4gICAgaWYgKGxhc3RUaHJlYWRJZCAhPT0gbnVsbCkge1xuICAgICAgbGFzdFRocmVhZElkID0gbnVsbDtcbiAgICAgIGN1cnJlbnRHb2FsID0gbnVsbDtcbiAgICAgIGhpZGVQYW5lbCgpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHRocmVhZElkID09PSBsYXN0VGhyZWFkSWQpIHJldHVybjtcbiAgbGFzdFRocmVhZElkID0gdGhyZWFkSWQ7XG4gIHRyeSB7XG4gICAgY29uc3QgZ29hbCA9IGF3YWl0IGdldEdvYWwodGhyZWFkSWQsIHJlYWRIb3N0SWQoKSk7XG4gICAgY3VycmVudEdvYWwgPSBnb2FsO1xuICAgIGlmIChnb2FsKSB7XG4gICAgICByZW5kZXJHb2FsKGdvYWwsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgaGlkZVBhbmVsKCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIE9sZCBhcHAtc2VydmVyIGJ1aWxkcyBkbyBub3Qga25vdyB0aHJlYWQvZ29hbC8qLiBLZWVwIHRoZSBVSSBxdWlldCB1bnRpbFxuICAgIC8vIHRoZSB1c2VyIGV4cGxpY2l0bHkgdHlwZXMgL2dvYWwsIHRoZW4gc2hvdyB0aGUgYWN0aW9uYWJsZSBlcnJvci5cbiAgICBsb2coXCJnb2FsIHJvdXRlIHJlZnJlc2ggc2tpcHBlZFwiLCBzdHJpbmdpZnlFcnJvcihlcnJvcikpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbmZpcm1SZXBsYWNlR29hbChleGlzdGluZzogVGhyZWFkR29hbCwgbmV4dE9iamVjdGl2ZTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIHJlbmRlclBhbmVsKHtcbiAgICAgIHRpdGxlOiBcIlJlcGxhY2UgY3VycmVudCBnb2FsP1wiLFxuICAgICAgZGV0YWlsOiB0cnVuY2F0ZShleGlzdGluZy5vYmplY3RpdmUsIDE4MCksXG4gICAgICBmb290ZXI6IGBOZXc6ICR7dHJ1bmNhdGUobmV4dE9iamVjdGl2ZSwgMTgwKX1gLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICB7XG4gICAgICAgICAgbGFiZWw6IFwiUmVwbGFjZVwiLFxuICAgICAgICAgIGtpbmQ6IFwicHJpbWFyeVwiLFxuICAgICAgICAgIHJ1bjogKCkgPT4gcmVzb2x2ZSh0cnVlKSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGxhYmVsOiBcIkNhbmNlbFwiLFxuICAgICAgICAgIHJ1bjogKCkgPT4gcmVzb2x2ZShmYWxzZSksXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcGVyc2lzdGVudDogdHJ1ZSxcbiAgICB9KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckdvYWwoZ29hbDogVGhyZWFkR29hbCwgb3B0aW9uczogeyB0cmFuc2llbnQ6IGJvb2xlYW4gfSk6IHZvaWQge1xuICBjb25zdCBzdGF0dXMgPSBnb2FsU3RhdHVzTGFiZWwoZ29hbC5zdGF0dXMpO1xuICBjb25zdCBidWRnZXQgPSBnb2FsLnRva2VuQnVkZ2V0ID09IG51bGxcbiAgICA/IGAke2Zvcm1hdE51bWJlcihnb2FsLnRva2Vuc1VzZWQpfSB0b2tlbnNgXG4gICAgOiBgJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbnNVc2VkKX0gLyAke2Zvcm1hdE51bWJlcihnb2FsLnRva2VuQnVkZ2V0KX0gdG9rZW5zYDtcbiAgcmVuZGVyUGFuZWwoe1xuICAgIHRpdGxlOiBgR29hbCAke3N0YXR1c31gLFxuICAgIGRldGFpbDogZ29hbC5vYmplY3RpdmUsXG4gICAgZm9vdGVyOiBgJHtidWRnZXR9IC0gJHtmb3JtYXREdXJhdGlvbihnb2FsLnRpbWVVc2VkU2Vjb25kcyl9YCxcbiAgICBhY3Rpb25zOiBbXG4gICAgICBnb2FsLnN0YXR1cyA9PT0gXCJwYXVzZWRcIlxuICAgICAgICA/IHsgbGFiZWw6IFwiUmVzdW1lXCIsIGtpbmQ6IFwicHJpbWFyeVwiLCBydW46ICgpID0+IHVwZGF0ZUdvYWxTdGF0dXMoXCJhY3RpdmVcIikgfVxuICAgICAgICA6IHsgbGFiZWw6IFwiUGF1c2VcIiwgcnVuOiAoKSA9PiB1cGRhdGVHb2FsU3RhdHVzKFwicGF1c2VkXCIpIH0sXG4gICAgICB7IGxhYmVsOiBcIkNvbXBsZXRlXCIsIHJ1bjogKCkgPT4gdXBkYXRlR29hbFN0YXR1cyhcImNvbXBsZXRlXCIpIH0sXG4gICAgICB7IGxhYmVsOiBcIkNsZWFyXCIsIGtpbmQ6IFwiZGFuZ2VyXCIsIHJ1bjogKCkgPT4gY2xlYXJDdXJyZW50R29hbCgpIH0sXG4gICAgXSxcbiAgICBwZXJzaXN0ZW50OiAhb3B0aW9ucy50cmFuc2llbnQsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJOb3RpY2UodGl0bGU6IHN0cmluZywgZGV0YWlsOiBzdHJpbmcpOiB2b2lkIHtcbiAgcmVuZGVyUGFuZWwoeyB0aXRsZSwgZGV0YWlsLCBhY3Rpb25zOiBbXSwgcGVyc2lzdGVudDogZmFsc2UgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckVycm9yKHRpdGxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogdm9pZCB7XG4gIHJlbmRlclBhbmVsKHsgdGl0bGUsIGRldGFpbCwgYWN0aW9uczogW10sIHBlcnNpc3RlbnQ6IGZhbHNlLCBlcnJvcjogdHJ1ZSB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyUGFuZWwob3B0aW9uczogR29hbFBhbmVsT3B0aW9ucyk6IHZvaWQge1xuICBsYXN0UGFuZWxPcHRpb25zID0gb3B0aW9ucztcbiAgY29uc3QgZWwgPSBlbnN1cmVSb290KCk7XG4gIGlmIChoaWRlVGltZXIpIGNsZWFyVGltZW91dChoaWRlVGltZXIpO1xuICBlbC5pbm5lckhUTUwgPSBcIlwiO1xuICBlbC5jbGFzc05hbWUgPSBgY29kZXhwcC1nb2FsLXBhbmVsJHtvcHRpb25zLmVycm9yID8gXCIgaXMtZXJyb3JcIiA6IFwiXCJ9JHtwYW5lbFN0YXRlLmNvbGxhcHNlZCA/IFwiIGlzLWNvbGxhcHNlZFwiIDogXCJcIn1gO1xuICBhcHBseUdvYWxQYW5lbFNpemUoZWwpO1xuICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKGVsKTtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaGVhZGVyXCI7XG4gIGhlYWRlci5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgc3RhcnRHb2FsUGFuZWxEcmFnKTtcbiAgaGVhZGVyLmFkZEV2ZW50TGlzdGVuZXIoXCJkYmxjbGlja1wiLCByZXNldEdvYWxQYW5lbFBvc2l0aW9uKTtcblxuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXRpdGxlXCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gb3B0aW9ucy50aXRsZTtcblxuICBjb25zdCBjb250cm9scyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNvbnRyb2xzLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWNvbnRyb2xzXCI7XG5cbiAgY29uc3QgY29sbGFwc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjb2xsYXBzZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1pY29uXCI7XG4gIGNvbGxhcHNlLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjb2xsYXBzZS50ZXh0Q29udGVudCA9IHBhbmVsU3RhdGUuY29sbGFwc2VkID8gXCIrXCIgOiBcIi1cIjtcbiAgY29sbGFwc2Uuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBwYW5lbFN0YXRlLmNvbGxhcHNlZCA/IFwiRXhwYW5kIGdvYWwgcGFuZWxcIiA6IFwiQ29sbGFwc2UgZ29hbCBwYW5lbFwiKTtcbiAgY29sbGFwc2UuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICBwYW5lbFN0YXRlID0geyAuLi5wYW5lbFN0YXRlLCBjb2xsYXBzZWQ6ICFwYW5lbFN0YXRlLmNvbGxhcHNlZCB9O1xuICAgIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xuICAgIGlmIChsYXN0UGFuZWxPcHRpb25zKSByZW5kZXJQYW5lbChsYXN0UGFuZWxPcHRpb25zKTtcbiAgfSk7XG5cbiAgY29uc3QgY2xvc2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjbG9zZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1pY29uXCI7XG4gIGNsb3NlLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjbG9zZS50ZXh0Q29udGVudCA9IFwieFwiO1xuICBjbG9zZS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiQ2xvc2UgZ29hbCBwYW5lbFwiKTtcbiAgY2xvc2UuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IGhpZGVQYW5lbCgpKTtcbiAgY29udHJvbHMuYXBwZW5kKGNvbGxhcHNlLCBjbG9zZSk7XG4gIGhlYWRlci5hcHBlbmQodGl0bGUsIGNvbnRyb2xzKTtcbiAgZWwuYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICBpZiAocGFuZWxTdGF0ZS5jb2xsYXBzZWQpIHtcbiAgICBlbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICAgIGlmICghb3B0aW9ucy5wZXJzaXN0ZW50KSB7XG4gICAgICBoaWRlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGhpZGVQYW5lbCgpLCA4XzAwMCk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGRldGFpbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRldGFpbC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1kZXRhaWxcIjtcbiAgZGV0YWlsLnRleHRDb250ZW50ID0gb3B0aW9ucy5kZXRhaWw7XG5cbiAgZWwuYXBwZW5kQ2hpbGQoZGV0YWlsKTtcblxuICBpZiAob3B0aW9ucy5mb290ZXIpIHtcbiAgICBjb25zdCBmb290ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGZvb3Rlci5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1mb290ZXJcIjtcbiAgICBmb290ZXIudGV4dENvbnRlbnQgPSBvcHRpb25zLmZvb3RlcjtcbiAgICBlbC5hcHBlbmRDaGlsZChmb290ZXIpO1xuICB9XG5cbiAgaWYgKG9wdGlvbnMuYWN0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1hY3Rpb25zXCI7XG4gICAgZm9yIChjb25zdCBhY3Rpb24gb2Ygb3B0aW9ucy5hY3Rpb25zKSB7XG4gICAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYnV0dG9uLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYnV0dG9uLnRleHRDb250ZW50ID0gYWN0aW9uLmxhYmVsO1xuICAgICAgYnV0dG9uLmNsYXNzTmFtZSA9IGBjb2RleHBwLWdvYWwtYWN0aW9uICR7YWN0aW9uLmtpbmQgPz8gXCJcIn1gO1xuICAgICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICAgIFByb21pc2UucmVzb2x2ZShhY3Rpb24ucnVuKCkpLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgIHJlbmRlckVycm9yKFwiR29hbCBhY3Rpb24gZmFpbGVkXCIsIGZyaWVuZGx5R29hbEVycm9yKGVycm9yKSk7XG4gICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gICAgfVxuICAgIGVsLmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICB9XG5cbiAgY29uc3QgcmVzaXplID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgcmVzaXplLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXJlc2l6ZVwiO1xuICByZXNpemUudHlwZSA9IFwiYnV0dG9uXCI7XG4gIHJlc2l6ZS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiUmVzaXplIGdvYWwgcGFuZWxcIik7XG4gIHJlc2l6ZS5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgc3RhcnRHb2FsUGFuZWxSZXNpemUpO1xuICByZXNpemUuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgaGFuZGxlR29hbFBhbmVsUmVzaXplS2V5ZG93bik7XG4gIHJlc2l6ZS5hZGRFdmVudExpc3RlbmVyKFwiZGJsY2xpY2tcIiwgcmVzZXRHb2FsUGFuZWxTaXplKTtcbiAgZWwuYXBwZW5kQ2hpbGQocmVzaXplKTtcblxuICBlbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICBpZiAoIW9wdGlvbnMucGVyc2lzdGVudCkge1xuICAgIGhpZGVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gaGlkZVBhbmVsKCksIDhfMDAwKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiB1cGRhdGVHb2FsU3RhdHVzKHN0YXR1czogR29hbFN0YXR1cyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aHJlYWRJZCA9IHJlYWRUaHJlYWRJZCgpID8/IGN1cnJlbnRHb2FsPy50aHJlYWRJZDtcbiAgaWYgKCF0aHJlYWRJZCkgcmV0dXJuO1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvc2V0XCIsXG4gICAgeyB0aHJlYWRJZCwgc3RhdHVzIH0sXG4gICAgeyBob3N0SWQ6IHJlYWRIb3N0SWQoKSB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IHJlc3BvbnNlLmdvYWw7XG4gIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbGVhckN1cnJlbnRHb2FsKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0aHJlYWRJZCA9IHJlYWRUaHJlYWRJZCgpID8/IGN1cnJlbnRHb2FsPy50aHJlYWRJZDtcbiAgaWYgKCF0aHJlYWRJZCkgcmV0dXJuO1xuICBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgY2xlYXJlZDogYm9vbGVhbiB9PihcbiAgICBcInRocmVhZC9nb2FsL2NsZWFyXCIsXG4gICAgeyB0aHJlYWRJZCB9LFxuICAgIHsgaG9zdElkOiByZWFkSG9zdElkKCkgfSxcbiAgKTtcbiAgY3VycmVudEdvYWwgPSBudWxsO1xuICByZW5kZXJOb3RpY2UoXCJHb2FsIGNsZWFyZWRcIiwgXCJUaGlzIHRocmVhZCBubyBsb25nZXIgaGFzIGFuIGFjdGl2ZSBnb2FsLlwiKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlUm9vdCgpOiBIVE1MRGl2RWxlbWVudCB7XG4gIGlmIChyb290Py5pc0Nvbm5lY3RlZCkgcmV0dXJuIHJvb3Q7XG4gIHJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb290LmlkID0gXCJjb2RleHBwLWdvYWwtcm9vdFwiO1xuICByb290LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgY29uc3QgcGFyZW50ID0gZG9jdW1lbnQuYm9keSB8fCBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQ7XG4gIGlmIChwYXJlbnQpIHBhcmVudC5hcHBlbmRDaGlsZChyb290KTtcbiAgcmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIGhpZGVQYW5lbCgpOiB2b2lkIHtcbiAgaWYgKGhpZGVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChoaWRlVGltZXIpO1xuICAgIGhpZGVUaW1lciA9IG51bGw7XG4gIH1cbiAgaWYgKHJvb3QpIHJvb3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xufVxuXG5mdW5jdGlvbiBzdGFydEdvYWxQYW5lbERyYWcoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQge1xuICBpZiAoZXZlbnQuYnV0dG9uICE9PSAwKSByZXR1cm47XG4gIGlmIChldmVudC50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50ICYmIGV2ZW50LnRhcmdldC5jbG9zZXN0KFwiYnV0dG9uXCIpKSByZXR1cm47XG4gIGlmICghcm9vdCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gcm9vdC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgcGFuZWxEcmFnID0ge1xuICAgIHBvaW50ZXJJZDogZXZlbnQucG9pbnRlcklkLFxuICAgIG9mZnNldFg6IGV2ZW50LmNsaWVudFggLSByZWN0LmxlZnQsXG4gICAgb2Zmc2V0WTogZXZlbnQuY2xpZW50WSAtIHJlY3QudG9wLFxuICAgIHdpZHRoOiByZWN0LndpZHRoLFxuICAgIGhlaWdodDogcmVjdC5oZWlnaHQsXG4gIH07XG4gIHJvb3QuY2xhc3NMaXN0LmFkZChcImlzLWRyYWdnaW5nXCIpO1xuICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJtb3ZlXCIsIG1vdmVHb2FsUGFuZWwpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJ1cFwiLCBzdG9wR29hbFBhbmVsRHJhZyk7XG59XG5cbmZ1bmN0aW9uIG1vdmVHb2FsUGFuZWwoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQge1xuICBpZiAoIXBhbmVsRHJhZyB8fCBldmVudC5wb2ludGVySWQgIT09IHBhbmVsRHJhZy5wb2ludGVySWQgfHwgIXJvb3QpIHJldHVybjtcbiAgcGFuZWxTdGF0ZSA9IHtcbiAgICAuLi5wYW5lbFN0YXRlLFxuICAgIHg6IGNsYW1wKGV2ZW50LmNsaWVudFggLSBwYW5lbERyYWcub2Zmc2V0WCwgOCwgd2luZG93LmlubmVyV2lkdGggLSBwYW5lbERyYWcud2lkdGggLSA4KSxcbiAgICB5OiBjbGFtcChldmVudC5jbGllbnRZIC0gcGFuZWxEcmFnLm9mZnNldFksIDgsIHdpbmRvdy5pbm5lckhlaWdodCAtIHBhbmVsRHJhZy5oZWlnaHQgLSA4KSxcbiAgfTtcbiAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbn1cblxuZnVuY3Rpb24gc3RvcEdvYWxQYW5lbERyYWcoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQge1xuICBpZiAocGFuZWxEcmFnICYmIGV2ZW50LnBvaW50ZXJJZCAhPT0gcGFuZWxEcmFnLnBvaW50ZXJJZCkgcmV0dXJuO1xuICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJtb3ZlXCIsIG1vdmVHb2FsUGFuZWwpO1xuICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJ1cFwiLCBzdG9wR29hbFBhbmVsRHJhZyk7XG4gIGlmIChyb290KSByb290LmNsYXNzTGlzdC5yZW1vdmUoXCJpcy1kcmFnZ2luZ1wiKTtcbiAgcGFuZWxEcmFnID0gbnVsbDtcbiAgaWYgKHJvb3QpIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChyb290KTtcbiAgc2F2ZUdvYWxQYW5lbFN0YXRlKCk7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0R29hbFBhbmVsUmVzaXplKGV2ZW50OiBQb2ludGVyRXZlbnQpOiB2b2lkIHtcbiAgaWYgKGV2ZW50LmJ1dHRvbiAhPT0gMCB8fCBwYW5lbFN0YXRlLmNvbGxhcHNlZCkgcmV0dXJuO1xuICBpZiAoIXJvb3QpIHJldHVybjtcbiAgY29uc3QgcmVjdCA9IHJvb3QuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIGVuc3VyZUV4cGxpY2l0R29hbFBhbmVsRnJhbWUocmVjdCk7XG4gIHBhbmVsUmVzaXplID0ge1xuICAgIHBvaW50ZXJJZDogZXZlbnQucG9pbnRlcklkLFxuICAgIHN0YXJ0WDogZXZlbnQuY2xpZW50WCxcbiAgICBzdGFydFk6IGV2ZW50LmNsaWVudFksXG4gICAgd2lkdGg6IHJlY3Qud2lkdGgsXG4gICAgaGVpZ2h0OiByZWN0LmhlaWdodCxcbiAgfTtcbiAgcm9vdC5jbGFzc0xpc3QuYWRkKFwiaXMtcmVzaXppbmdcIik7XG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJtb3ZlXCIsIHJlc2l6ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxSZXNpemUpO1xufVxuXG5mdW5jdGlvbiByZXNpemVHb2FsUGFuZWwoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQge1xuICBpZiAoIXBhbmVsUmVzaXplIHx8IGV2ZW50LnBvaW50ZXJJZCAhPT0gcGFuZWxSZXNpemUucG9pbnRlcklkIHx8ICFyb290KSByZXR1cm47XG4gIGNvbnN0IG1heFdpZHRoID0gZ29hbFBhbmVsTWF4V2lkdGgoKTtcbiAgY29uc3QgbWF4SGVpZ2h0ID0gZ29hbFBhbmVsTWF4SGVpZ2h0KCk7XG4gIHBhbmVsU3RhdGUgPSB7XG4gICAgLi4ucGFuZWxTdGF0ZSxcbiAgICB3aWR0aDogY2xhbXAocGFuZWxSZXNpemUud2lkdGggKyBldmVudC5jbGllbnRYIC0gcGFuZWxSZXNpemUuc3RhcnRYLCBHT0FMX1BBTkVMX01JTl9XSURUSCwgbWF4V2lkdGgpLFxuICAgIGhlaWdodDogY2xhbXAocGFuZWxSZXNpemUuaGVpZ2h0ICsgZXZlbnQuY2xpZW50WSAtIHBhbmVsUmVzaXplLnN0YXJ0WSwgR09BTF9QQU5FTF9NSU5fSEVJR0hULCBtYXhIZWlnaHQpLFxuICB9O1xuICBhcHBseUdvYWxQYW5lbFNpemUocm9vdCk7XG4gIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChyb290KTtcbiAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbn1cblxuZnVuY3Rpb24gc3RvcEdvYWxQYW5lbFJlc2l6ZShldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbFJlc2l6ZSAmJiBldmVudC5wb2ludGVySWQgIT09IHBhbmVsUmVzaXplLnBvaW50ZXJJZCkgcmV0dXJuO1xuICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJtb3ZlXCIsIHJlc2l6ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxSZXNpemUpO1xuICBpZiAocm9vdCkgcm9vdC5jbGFzc0xpc3QucmVtb3ZlKFwiaXMtcmVzaXppbmdcIik7XG4gIHBhbmVsUmVzaXplID0gbnVsbDtcbiAgc2F2ZUdvYWxQYW5lbFN0YXRlKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZUdvYWxQYW5lbFJlc2l6ZUtleWRvd24oZXZlbnQ6IEtleWJvYXJkRXZlbnQpOiB2b2lkIHtcbiAgaWYgKHBhbmVsU3RhdGUuY29sbGFwc2VkIHx8ICFyb290KSByZXR1cm47XG4gIGNvbnN0IGRlbHRhID0gZXZlbnQuc2hpZnRLZXkgPyAzMiA6IDEyO1xuICBsZXQgd2lkdGhEZWx0YSA9IDA7XG4gIGxldCBoZWlnaHREZWx0YSA9IDA7XG4gIGlmIChldmVudC5rZXkgPT09IFwiQXJyb3dMZWZ0XCIpIHdpZHRoRGVsdGEgPSAtZGVsdGE7XG4gIGVsc2UgaWYgKGV2ZW50LmtleSA9PT0gXCJBcnJvd1JpZ2h0XCIpIHdpZHRoRGVsdGEgPSBkZWx0YTtcbiAgZWxzZSBpZiAoZXZlbnQua2V5ID09PSBcIkFycm93VXBcIikgaGVpZ2h0RGVsdGEgPSAtZGVsdGE7XG4gIGVsc2UgaWYgKGV2ZW50LmtleSA9PT0gXCJBcnJvd0Rvd25cIikgaGVpZ2h0RGVsdGEgPSBkZWx0YTtcbiAgZWxzZSByZXR1cm47XG5cbiAgY29uc3QgcmVjdCA9IHJvb3QuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIGVuc3VyZUV4cGxpY2l0R29hbFBhbmVsRnJhbWUocmVjdCk7XG4gIHBhbmVsU3RhdGUgPSB7XG4gICAgLi4ucGFuZWxTdGF0ZSxcbiAgICB3aWR0aDogY2xhbXAoKHBhbmVsU3RhdGUud2lkdGggPz8gcmVjdC53aWR0aCkgKyB3aWR0aERlbHRhLCBHT0FMX1BBTkVMX01JTl9XSURUSCwgZ29hbFBhbmVsTWF4V2lkdGgoKSksXG4gICAgaGVpZ2h0OiBjbGFtcCgocGFuZWxTdGF0ZS5oZWlnaHQgPz8gcmVjdC5oZWlnaHQpICsgaGVpZ2h0RGVsdGEsIEdPQUxfUEFORUxfTUlOX0hFSUdIVCwgZ29hbFBhbmVsTWF4SGVpZ2h0KCkpLFxuICB9O1xuICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgYXBwbHlHb2FsUGFuZWxTaXplKHJvb3QpO1xuICBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQocm9vdCk7XG4gIGFwcGx5R29hbFBhbmVsUG9zaXRpb24ocm9vdCk7XG4gIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xufVxuXG5mdW5jdGlvbiByZXNldEdvYWxQYW5lbFNpemUoZXZlbnQ6IE1vdXNlRXZlbnQpOiB2b2lkIHtcbiAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gIHBhbmVsU3RhdGUgPSB7IC4uLnBhbmVsU3RhdGUsIHdpZHRoOiBudWxsLCBoZWlnaHQ6IG51bGwgfTtcbiAgc2F2ZUdvYWxQYW5lbFN0YXRlKCk7XG4gIGlmIChyb290KSB7XG4gICAgYXBwbHlHb2FsUGFuZWxTaXplKHJvb3QpO1xuICAgIGFwcGx5R29hbFBhbmVsUG9zaXRpb24ocm9vdCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzZXRHb2FsUGFuZWxQb3NpdGlvbihldmVudDogTW91c2VFdmVudCk6IHZvaWQge1xuICBpZiAoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCAmJiBldmVudC50YXJnZXQuY2xvc2VzdChcImJ1dHRvblwiKSkgcmV0dXJuO1xuICBwYW5lbFN0YXRlID0geyAuLi5wYW5lbFN0YXRlLCB4OiBudWxsLCB5OiBudWxsIH07XG4gIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xuICBpZiAocm9vdCkgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlRXhwbGljaXRHb2FsUGFuZWxGcmFtZShyZWN0OiBET01SZWN0KTogdm9pZCB7XG4gIGlmIChwYW5lbFN0YXRlLnggPT09IG51bGwgfHwgcGFuZWxTdGF0ZS55ID09PSBudWxsKSB7XG4gICAgcGFuZWxTdGF0ZSA9IHsgLi4ucGFuZWxTdGF0ZSwgeDogcmVjdC5sZWZ0LCB5OiByZWN0LnRvcCB9O1xuICB9XG4gIGlmIChwYW5lbFN0YXRlLndpZHRoID09PSBudWxsIHx8IHBhbmVsU3RhdGUuaGVpZ2h0ID09PSBudWxsKSB7XG4gICAgcGFuZWxTdGF0ZSA9IHsgLi4ucGFuZWxTdGF0ZSwgd2lkdGg6IHJlY3Qud2lkdGgsIGhlaWdodDogcmVjdC5oZWlnaHQgfTtcbiAgfVxuICBpZiAocm9vdCkge1xuICAgIGFwcGx5R29hbFBhbmVsU2l6ZShyb290KTtcbiAgICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5R29hbFBhbmVsU2l6ZShlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS5jb2xsYXBzZWQpIHtcbiAgICBlbGVtZW50LnN0eWxlLndpZHRoID0gXCJcIjtcbiAgICBlbGVtZW50LnN0eWxlLmhlaWdodCA9IFwiXCI7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHBhbmVsU3RhdGUud2lkdGggPT09IG51bGwpIHtcbiAgICBlbGVtZW50LnN0eWxlLndpZHRoID0gXCJcIjtcbiAgfSBlbHNlIHtcbiAgICBlbGVtZW50LnN0eWxlLndpZHRoID0gYCR7Y2xhbXAocGFuZWxTdGF0ZS53aWR0aCwgR09BTF9QQU5FTF9NSU5fV0lEVEgsIGdvYWxQYW5lbE1heFdpZHRoKCkpfXB4YDtcbiAgfVxuXG4gIGlmIChwYW5lbFN0YXRlLmhlaWdodCA9PT0gbnVsbCkge1xuICAgIGVsZW1lbnQuc3R5bGUuaGVpZ2h0ID0gXCJcIjtcbiAgfSBlbHNlIHtcbiAgICBlbGVtZW50LnN0eWxlLmhlaWdodCA9IGAke2NsYW1wKHBhbmVsU3RhdGUuaGVpZ2h0LCBHT0FMX1BBTkVMX01JTl9IRUlHSFQsIGdvYWxQYW5lbE1heEhlaWdodCgpKX1weGA7XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkge1xuICAgIGVsZW1lbnQuc3R5bGUubGVmdCA9IFwiYXV0b1wiO1xuICAgIGVsZW1lbnQuc3R5bGUudG9wID0gXCJhdXRvXCI7XG4gICAgZWxlbWVudC5zdHlsZS5yaWdodCA9IFwiMThweFwiO1xuICAgIGVsZW1lbnQuc3R5bGUuYm90dG9tID0gXCI3NnB4XCI7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChlbGVtZW50KTtcbiAgZWxlbWVudC5zdHlsZS5yaWdodCA9IFwiYXV0b1wiO1xuICBlbGVtZW50LnN0eWxlLmJvdHRvbSA9IFwiYXV0b1wiO1xuICBlbGVtZW50LnN0eWxlLmxlZnQgPSBgJHtwYW5lbFN0YXRlLnh9cHhgO1xuICBlbGVtZW50LnN0eWxlLnRvcCA9IGAke3BhbmVsU3RhdGUueX1weGA7XG59XG5cbmZ1bmN0aW9uIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgcGFuZWxTdGF0ZSA9IHtcbiAgICAuLi5wYW5lbFN0YXRlLFxuICAgIHg6IGNsYW1wKHBhbmVsU3RhdGUueCwgR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU4sIHdpbmRvdy5pbm5lcldpZHRoIC0gcmVjdC53aWR0aCAtIEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOKSxcbiAgICB5OiBjbGFtcChwYW5lbFN0YXRlLnksIEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOLCB3aW5kb3cuaW5uZXJIZWlnaHQgLSByZWN0LmhlaWdodCAtIEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gZ29hbFBhbmVsTWF4V2lkdGgoKTogbnVtYmVyIHtcbiAgY29uc3QgbGVmdCA9IHBhbmVsU3RhdGUueCA/PyBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTjtcbiAgcmV0dXJuIE1hdGgubWF4KEdPQUxfUEFORUxfTUlOX1dJRFRILCB3aW5kb3cuaW5uZXJXaWR0aCAtIGxlZnQgLSBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTik7XG59XG5cbmZ1bmN0aW9uIGdvYWxQYW5lbE1heEhlaWdodCgpOiBudW1iZXIge1xuICBjb25zdCB0b3AgPSBwYW5lbFN0YXRlLnkgPz8gR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU47XG4gIHJldHVybiBNYXRoLm1heChHT0FMX1BBTkVMX01JTl9IRUlHSFQsIHdpbmRvdy5pbm5lckhlaWdodCAtIHRvcCAtIEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOKTtcbn1cblxuZnVuY3Rpb24gcmVhZEdvYWxQYW5lbFN0YXRlKCk6IEdvYWxQYW5lbFN0YXRlIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKEdPQUxfUEFORUxfU1RBVEVfS0VZKSA/PyBcInt9XCIpIGFzIFBhcnRpYWw8R29hbFBhbmVsU3RhdGU+O1xuICAgIHJldHVybiB7XG4gICAgICBjb2xsYXBzZWQ6IHBhcnNlZC5jb2xsYXBzZWQgPT09IHRydWUsXG4gICAgICB4OiB0eXBlb2YgcGFyc2VkLnggPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKHBhcnNlZC54KSA/IHBhcnNlZC54IDogbnVsbCxcbiAgICAgIHk6IHR5cGVvZiBwYXJzZWQueSA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkLnkpID8gcGFyc2VkLnkgOiBudWxsLFxuICAgICAgd2lkdGg6IHR5cGVvZiBwYXJzZWQud2lkdGggPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKHBhcnNlZC53aWR0aCkgPyBwYXJzZWQud2lkdGggOiBudWxsLFxuICAgICAgaGVpZ2h0OiB0eXBlb2YgcGFyc2VkLmhlaWdodCA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkLmhlaWdodCkgPyBwYXJzZWQuaGVpZ2h0IDogbnVsbCxcbiAgICB9O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBjb2xsYXBzZWQ6IGZhbHNlLCB4OiBudWxsLCB5OiBudWxsLCB3aWR0aDogbnVsbCwgaGVpZ2h0OiBudWxsIH07XG4gIH1cbn1cblxuZnVuY3Rpb24gc2F2ZUdvYWxQYW5lbFN0YXRlKCk6IHZvaWQge1xuICB0cnkge1xuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKEdPQUxfUEFORUxfU1RBVEVfS0VZLCBKU09OLnN0cmluZ2lmeShwYW5lbFN0YXRlKSk7XG4gIH0gY2F0Y2gge31cbn1cblxuZnVuY3Rpb24gY2xhbXAodmFsdWU6IG51bWJlciwgbWluOiBudW1iZXIsIG1heDogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKG1heCA8IG1pbikgcmV0dXJuIG1pbjtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KHZhbHVlLCBtaW4pLCBtYXgpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVTdWdnZXN0aW9uUm9vdCgpOiBIVE1MRGl2RWxlbWVudCB8IG51bGwge1xuICBpZiAoc3VnZ2VzdGlvblJvb3Q/LmlzQ29ubmVjdGVkKSByZXR1cm4gc3VnZ2VzdGlvblJvb3Q7XG4gIGNvbnN0IHBhcmVudCA9IGRvY3VtZW50LmJvZHkgfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoIXBhcmVudCkgcmV0dXJuIG51bGw7XG4gIHN1Z2dlc3Rpb25Sb290ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3VnZ2VzdGlvblJvb3QuaWQgPSBcImNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLXJvb3RcIjtcbiAgc3VnZ2VzdGlvblJvb3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICBwYXJlbnQuYXBwZW5kQ2hpbGQoc3VnZ2VzdGlvblJvb3QpO1xuICByZXR1cm4gc3VnZ2VzdGlvblJvb3Q7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlOiBFZGl0YWJsZVRhcmdldCB8IG51bGwpOiB2b2lkIHtcbiAgaWYgKCFlZGl0YWJsZSkge1xuICAgIGhpZGVHb2FsU3VnZ2VzdGlvbigpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzdWdnZXN0aW9uID0gcGFyc2VHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZS5nZXRUZXh0KCkpO1xuICBpZiAoIXN1Z2dlc3Rpb24pIHtcbiAgICBoaWRlR29hbFN1Z2dlc3Rpb24oKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcmVuZGVyR29hbFN1Z2dlc3Rpb24oZWRpdGFibGUsIHN1Z2dlc3Rpb24ucXVlcnkpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQsIHF1ZXJ5OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgZWwgPSBlbnN1cmVTdWdnZXN0aW9uUm9vdCgpO1xuICBpZiAoIWVsKSByZXR1cm47XG4gIGNvbnN0IHJlY3QgPSBlZGl0YWJsZS5lbGVtZW50LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBjb25zdCB3aWR0aCA9IE1hdGgubWluKDQyMCwgTWF0aC5tYXgoMjgwLCByZWN0LndpZHRoIHx8IDMyMCkpO1xuICBjb25zdCBsZWZ0ID0gTWF0aC5tYXgoMTIsIE1hdGgubWluKHJlY3QubGVmdCwgd2luZG93LmlubmVyV2lkdGggLSB3aWR0aCAtIDEyKSk7XG4gIGNvbnN0IHRvcCA9IE1hdGgubWF4KDEyLCByZWN0LnRvcCAtIDY2KTtcblxuICBlbC5pbm5lckhUTUwgPSBcIlwiO1xuICBlbC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uXCI7XG4gIGVsLnN0eWxlLmxlZnQgPSBgJHtsZWZ0fXB4YDtcbiAgZWwuc3R5bGUudG9wID0gYCR7dG9wfXB4YDtcbiAgZWwuc3R5bGUud2lkdGggPSBgJHt3aWR0aH1weGA7XG5cbiAgY29uc3QgaXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGl0ZW0udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGl0ZW0uY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1pdGVtXCI7XG4gIGl0ZW0uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIkdvYWwgY29tbWFuZFwiKTtcbiAgaXRlbS5hZGRFdmVudExpc3RlbmVyKFwibW91c2Vkb3duXCIsIChldmVudCkgPT4ge1xuICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYXBwbHlHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZSk7XG4gIH0pO1xuXG4gIGNvbnN0IGNvbW1hbmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29tbWFuZC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWNvbW1hbmRcIjtcbiAgY29tbWFuZC50ZXh0Q29udGVudCA9IFwiL2dvYWxcIjtcbiAgaWYgKHF1ZXJ5KSB7XG4gICAgY29tbWFuZC5kYXRhc2V0LnF1ZXJ5ID0gcXVlcnk7XG4gIH1cblxuICBjb25zdCBkZXRhaWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgZGV0YWlsLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24tZGV0YWlsXCI7XG4gIGRldGFpbC50ZXh0Q29udGVudCA9IFwiU2V0LCB2aWV3LCBwYXVzZSwgcmVzdW1lLCBjb21wbGV0ZSwgb3IgY2xlYXIgdGhpcyB0aHJlYWQgZ29hbFwiO1xuXG4gIGl0ZW0uYXBwZW5kKGNvbW1hbmQsIGRldGFpbCk7XG4gIGVsLmFwcGVuZENoaWxkKGl0ZW0pO1xuICBlbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xufVxuXG5mdW5jdGlvbiBhcHBseUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlOiBFZGl0YWJsZVRhcmdldCk6IHZvaWQge1xuICBlZGl0YWJsZS5zZXRUZXh0KFwiL2dvYWwgXCIpO1xuICBoaWRlR29hbFN1Z2dlc3Rpb24oKTtcbn1cblxuZnVuY3Rpb24gaGlkZUdvYWxTdWdnZXN0aW9uKCk6IHZvaWQge1xuICBpZiAoc3VnZ2VzdGlvblJvb3QpIHN1Z2dlc3Rpb25Sb290LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbn1cblxuZnVuY3Rpb24gaW5zdGFsbFN0eWxlcygpOiB2b2lkIHtcbiAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiY29kZXhwcC1nb2FsLXN0eWxlXCIpKSByZXR1cm47XG4gIGNvbnN0IHBhcmVudCA9IGRvY3VtZW50LmhlYWQgfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAoIXBhcmVudCkge1xuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJET01Db250ZW50TG9hZGVkXCIsICgpID0+IGluc3RhbGxTdHlsZXMoKSwgeyBvbmNlOiB0cnVlIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN0eWxlXCIpO1xuICBzdHlsZS5pZCA9IFwiY29kZXhwcC1nb2FsLXN0eWxlXCI7XG4gIHN0eWxlLnRleHRDb250ZW50ID0gYFxuI2NvZGV4cHAtZ29hbC1yb290IHtcbiAgcG9zaXRpb246IGZpeGVkO1xuICByaWdodDogMThweDtcbiAgYm90dG9tOiA3NnB4O1xuICB6LWluZGV4OiAyMTQ3NDgzNjQ3O1xuICB3aWR0aDogbWluKDQyMHB4LCBjYWxjKDEwMHZ3IC0gMzZweCkpO1xuICBtYXgtd2lkdGg6IGNhbGMoMTAwdncgLSAxNnB4KTtcbiAgbWF4LWhlaWdodDogY2FsYygxMDB2aCAtIDE2cHgpO1xuICBmb250OiAxM3B4LzEuNCAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIFwiU2Vnb2UgVUlcIiwgc2Fucy1zZXJpZjtcbiAgY29sb3I6IHZhcigtLXRleHQtcHJpbWFyeSwgI2Y1ZjdmYik7XG59XG4jY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24tcm9vdCB7XG4gIHBvc2l0aW9uOiBmaXhlZDtcbiAgei1pbmRleDogMjE0NzQ4MzY0NztcbiAgZm9udDogMTNweC8xLjM1IC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgXCJTZWdvZSBVSVwiLCBzYW5zLXNlcmlmO1xuICBjb2xvcjogdmFyKC0tdGV4dC1wcmltYXJ5LCAjZjVmN2ZiKTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbiB7XG4gIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsMC4xNCk7XG4gIGJvcmRlci1yYWRpdXM6IDhweDtcbiAgYmFja2dyb3VuZDogcmdiYSgyNCwgMjcsIDMzLCAwLjk4KTtcbiAgYm94LXNoYWRvdzogMCAxNnB4IDQ2cHggcmdiYSgwLDAsMCwwLjMyKTtcbiAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgYmFja2Ryb3AtZmlsdGVyOiBibHVyKDE0cHgpO1xufVxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWl0ZW0ge1xuICB3aWR0aDogMTAwJTtcbiAgYm9yZGVyOiAwO1xuICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDtcbiAgY29sb3I6IGluaGVyaXQ7XG4gIGRpc3BsYXk6IGdyaWQ7XG4gIGdyaWQtdGVtcGxhdGUtY29sdW1uczogYXV0byAxZnI7XG4gIGdhcDogMTJweDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgcGFkZGluZzogMTBweCAxMnB4O1xuICB0ZXh0LWFsaWduOiBsZWZ0O1xuICBjdXJzb3I6IHBvaW50ZXI7XG59XG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbTpob3Zlcixcbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1pdGVtOmZvY3VzLXZpc2libGUge1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LDAuMDkpO1xuICBvdXRsaW5lOiBub25lO1xufVxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWNvbW1hbmQge1xuICBmb250LWZhbWlseTogdWktbW9ub3NwYWNlLCBTRk1vbm8tUmVndWxhciwgXCJTRiBNb25vXCIsIE1lbmxvLCBtb25vc3BhY2U7XG4gIGZvbnQtd2VpZ2h0OiA2NTA7XG4gIGNvbG9yOiAjOWZjNWZmO1xufVxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWRldGFpbCB7XG4gIG1pbi13aWR0aDogMDtcbiAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG4gIHdoaXRlLXNwYWNlOiBub3dyYXA7XG4gIGNvbG9yOiByZ2JhKDI0NSwyNDcsMjUxLDAuNzIpO1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbCB7XG4gIGJveC1zaXppbmc6IGJvcmRlci1ib3g7XG4gIGRpc3BsYXk6IGZsZXg7XG4gIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG4gIHBvc2l0aW9uOiBmaXhlZDtcbiAgYm9yZGVyOiAxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwwLjE2KTtcbiAgYm9yZGVyLXJhZGl1czogOHB4O1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI2LCAyOSwgMzUsIDAuOTYpO1xuICBib3gtc2hhZG93OiAwIDE4cHggNjBweCByZ2JhKDAsMCwwLDAuMzQpO1xuICBwYWRkaW5nOiAxMnB4O1xuICBiYWNrZHJvcC1maWx0ZXI6IGJsdXIoMTRweCk7XG4gIG92ZXJmbG93OiBoaWRkZW47XG59XG4uY29kZXhwcC1nb2FsLXBhbmVsOm5vdCguaXMtY29sbGFwc2VkKSB7XG4gIG1pbi13aWR0aDogMjgwcHg7XG4gIG1pbi1oZWlnaHQ6IDE2MHB4O1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbC5pcy1kcmFnZ2luZyB7XG4gIGN1cnNvcjogZ3JhYmJpbmc7XG4gIHVzZXItc2VsZWN0OiBub25lO1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbC5pcy1yZXNpemluZyB7XG4gIGN1cnNvcjogbndzZS1yZXNpemU7XG4gIHVzZXItc2VsZWN0OiBub25lO1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbC5pcy1jb2xsYXBzZWQge1xuICB3aWR0aDogbWluKDMyMHB4LCBjYWxjKDEwMHZ3IC0gMzZweCkpO1xuICBtaW4taGVpZ2h0OiAwO1xuICBwYWRkaW5nOiAxMHB4IDEycHg7XG59XG4uY29kZXhwcC1nb2FsLXBhbmVsLmlzLWVycm9yIHtcbiAgYm9yZGVyLWNvbG9yOiByZ2JhKDI1NSwgMTIyLCAxMjIsIDAuNTUpO1xufVxuLmNvZGV4cHAtZ29hbC1oZWFkZXIge1xuICBkaXNwbGF5OiBmbGV4O1xuICBhbGlnbi1pdGVtczogY2VudGVyO1xuICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47XG4gIGdhcDogMTJweDtcbiAgZm9udC13ZWlnaHQ6IDY1MDtcbiAgY3Vyc29yOiBncmFiO1xuICB1c2VyLXNlbGVjdDogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtdGl0bGUge1xuICBtaW4td2lkdGg6IDA7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICB3aGl0ZS1zcGFjZTogbm93cmFwO1xufVxuLmNvZGV4cHAtZ29hbC1jb250cm9scyB7XG4gIGRpc3BsYXk6IGZsZXg7XG4gIGZsZXgtc2hyaW5rOiAwO1xuICBhbGlnbi1pdGVtczogY2VudGVyO1xuICBnYXA6IDRweDtcbn1cbi5jb2RleHBwLWdvYWwtaWNvbiB7XG4gIHdpZHRoOiAyNHB4O1xuICBoZWlnaHQ6IDI0cHg7XG4gIGJvcmRlcjogMDtcbiAgYm9yZGVyLXJhZGl1czogNnB4O1xuICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDtcbiAgY29sb3I6IGluaGVyaXQ7XG4gIGN1cnNvcjogcG9pbnRlcjtcbiAgbGluZS1oZWlnaHQ6IDE7XG59XG4uY29kZXhwcC1nb2FsLWljb246aG92ZXIge1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LDAuMSk7XG59XG4uY29kZXhwcC1nb2FsLWRldGFpbCB7XG4gIG1hcmdpbi10b3A6IDhweDtcbiAgZmxleDogMSAxIGF1dG87XG4gIG1pbi1oZWlnaHQ6IDA7XG4gIG1heC1oZWlnaHQ6IDk2cHg7XG4gIG92ZXJmbG93OiBhdXRvO1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjkpO1xuICB3b3JkLWJyZWFrOiBicmVhay13b3JkO1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbFtzdHlsZSo9XCJoZWlnaHRcIl0gLmNvZGV4cHAtZ29hbC1kZXRhaWwge1xuICBtYXgtaGVpZ2h0OiBub25lO1xufVxuLmNvZGV4cHAtZ29hbC1mb290ZXIge1xuICBmbGV4OiAwIDAgYXV0bztcbiAgbWFyZ2luLXRvcDogOHB4O1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjYyKTtcbiAgZm9udC1zaXplOiAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb25zIHtcbiAgZmxleDogMCAwIGF1dG87XG4gIGRpc3BsYXk6IGZsZXg7XG4gIGZsZXgtd3JhcDogd3JhcDtcbiAgZ2FwOiA4cHg7XG4gIG1hcmdpbi10b3A6IDEycHg7XG59XG4uY29kZXhwcC1nb2FsLWFjdGlvbiB7XG4gIG1pbi1oZWlnaHQ6IDI4cHg7XG4gIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsMC4xNCk7XG4gIGJvcmRlci1yYWRpdXM6IDdweDtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjA4KTtcbiAgY29sb3I6IGluaGVyaXQ7XG4gIHBhZGRpbmc6IDRweCAxMHB4O1xuICBjdXJzb3I6IHBvaW50ZXI7XG59XG4uY29kZXhwcC1nb2FsLWFjdGlvbjpob3ZlciB7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4xNCk7XG59XG4uY29kZXhwcC1nb2FsLWFjdGlvbi5wcmltYXJ5IHtcbiAgYm9yZGVyLWNvbG9yOiByZ2JhKDEyNSwgMTgwLCAyNTUsIDAuNTUpO1xuICBiYWNrZ3JvdW5kOiByZ2JhKDc0LCAxMjEsIDIxNiwgMC40Mik7XG59XG4uY29kZXhwcC1nb2FsLWFjdGlvbi5kYW5nZXIge1xuICBib3JkZXItY29sb3I6IHJnYmEoMjU1LCAxMjIsIDEyMiwgMC40OCk7XG59XG4uY29kZXhwcC1nb2FsLXJlc2l6ZSB7XG4gIHBvc2l0aW9uOiBhYnNvbHV0ZTtcbiAgcmlnaHQ6IDJweDtcbiAgYm90dG9tOiAycHg7XG4gIHdpZHRoOiAxOHB4O1xuICBoZWlnaHQ6IDE4cHg7XG4gIGJvcmRlcjogMDtcbiAgYm9yZGVyLXJhZGl1czogNHB4O1xuICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDtcbiAgY3Vyc29yOiBud3NlLXJlc2l6ZTtcbiAgb3BhY2l0eTogMC43Mjtcbn1cbi5jb2RleHBwLWdvYWwtcmVzaXplOjpiZWZvcmUge1xuICBjb250ZW50OiBcIlwiO1xuICBwb3NpdGlvbjogYWJzb2x1dGU7XG4gIHJpZ2h0OiA0cHg7XG4gIGJvdHRvbTogNHB4O1xuICB3aWR0aDogOHB4O1xuICBoZWlnaHQ6IDhweDtcbiAgYm9yZGVyLXJpZ2h0OiAxcHggc29saWQgcmdiYSgyNDUsMjQ3LDI1MSwwLjcpO1xuICBib3JkZXItYm90dG9tOiAxcHggc29saWQgcmdiYSgyNDUsMjQ3LDI1MSwwLjcpO1xufVxuLmNvZGV4cHAtZ29hbC1yZXNpemU6aG92ZXIsXG4uY29kZXhwcC1nb2FsLXJlc2l6ZTpmb2N1cy12aXNpYmxlIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjA4KTtcbiAgb3BhY2l0eTogMTtcbiAgb3V0bGluZTogbm9uZTtcbn1cbmA7XG4gIHBhcmVudC5hcHBlbmRDaGlsZChzdHlsZSk7XG59XG5cbmZ1bmN0aW9uIGZpbmRFZGl0YWJsZVRhcmdldChldmVudDogRXZlbnQpOiBFZGl0YWJsZVRhcmdldCB8IG51bGwge1xuICBjb25zdCBwYXRoID0gdHlwZW9mIGV2ZW50LmNvbXBvc2VkUGF0aCA9PT0gXCJmdW5jdGlvblwiID8gZXZlbnQuY29tcG9zZWRQYXRoKCkgOiBbXTtcbiAgZm9yIChjb25zdCBpdGVtIG9mIHBhdGgpIHtcbiAgICBpZiAoIShpdGVtIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpKSBjb250aW51ZTtcbiAgICBjb25zdCBlZGl0YWJsZSA9IGVkaXRhYmxlRm9yRWxlbWVudChpdGVtKTtcbiAgICBpZiAoZWRpdGFibGUpIHJldHVybiBlZGl0YWJsZTtcbiAgfVxuICByZXR1cm4gZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgSFRNTEVsZW1lbnQgPyBlZGl0YWJsZUZvckVsZW1lbnQoZXZlbnQudGFyZ2V0KSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGVkaXRhYmxlRm9yRWxlbWVudChlbGVtZW50OiBIVE1MRWxlbWVudCk6IEVkaXRhYmxlVGFyZ2V0IHwgbnVsbCB7XG4gIGlmIChlbGVtZW50IGluc3RhbmNlb2YgSFRNTFRleHRBcmVhRWxlbWVudCB8fCBlbGVtZW50IGluc3RhbmNlb2YgSFRNTElucHV0RWxlbWVudCkge1xuICAgIGNvbnN0IHR5cGUgPSBlbGVtZW50IGluc3RhbmNlb2YgSFRNTElucHV0RWxlbWVudCA/IGVsZW1lbnQudHlwZSA6IFwidGV4dGFyZWFcIjtcbiAgICBpZiAoIVtcInRleHRcIiwgXCJzZWFyY2hcIiwgXCJ0ZXh0YXJlYVwiXS5pbmNsdWRlcyh0eXBlKSkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHtcbiAgICAgIGVsZW1lbnQsXG4gICAgICBnZXRUZXh0OiAoKSA9PiBlbGVtZW50LnZhbHVlLFxuICAgICAgc2V0VGV4dDogKHZhbHVlKSA9PiB7XG4gICAgICAgIGVsZW1lbnQudmFsdWUgPSB2YWx1ZTtcbiAgICAgICAgZWxlbWVudC5mb2N1cygpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGVsZW1lbnQuc2V0U2VsZWN0aW9uUmFuZ2UodmFsdWUubGVuZ3RoLCB2YWx1ZS5sZW5ndGgpO1xuICAgICAgICB9IGNhdGNoIHt9XG4gICAgICAgIGVsZW1lbnQuZGlzcGF0Y2hFdmVudChuZXcgSW5wdXRFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSwgaW5wdXRUeXBlOiBcImluc2VydFRleHRcIiwgZGF0YTogdmFsdWUgfSkpO1xuICAgICAgfSxcbiAgICAgIGNsZWFyOiAoKSA9PiB7XG4gICAgICAgIGVsZW1lbnQudmFsdWUgPSBcIlwiO1xuICAgICAgICBlbGVtZW50LmRpc3BhdGNoRXZlbnQobmV3IElucHV0RXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUsIGlucHV0VHlwZTogXCJkZWxldGVDb250ZW50QmFja3dhcmRcIiB9KSk7XG4gICAgICB9LFxuICAgIH07XG4gIH1cblxuICBjb25zdCBlZGl0YWJsZSA9IGVsZW1lbnQuaXNDb250ZW50RWRpdGFibGVcbiAgICA/IGVsZW1lbnRcbiAgICA6IGVsZW1lbnQuY2xvc2VzdDxIVE1MRWxlbWVudD4oJ1tjb250ZW50ZWRpdGFibGU9XCJ0cnVlXCJdLCBbcm9sZT1cInRleHRib3hcIl0nKTtcbiAgaWYgKCFlZGl0YWJsZSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgZWxlbWVudDogZWRpdGFibGUsXG4gICAgZ2V0VGV4dDogKCkgPT4gZWRpdGFibGUuaW5uZXJUZXh0IHx8IGVkaXRhYmxlLnRleHRDb250ZW50IHx8IFwiXCIsXG4gICAgc2V0VGV4dDogKHZhbHVlKSA9PiB7XG4gICAgICBlZGl0YWJsZS50ZXh0Q29udGVudCA9IHZhbHVlO1xuICAgICAgZWRpdGFibGUuZm9jdXMoKTtcbiAgICAgIHBsYWNlQ2FyZXRBdEVuZChlZGl0YWJsZSk7XG4gICAgICBlZGl0YWJsZS5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiaW5zZXJ0VGV4dFwiLCBkYXRhOiB2YWx1ZSB9KSk7XG4gICAgfSxcbiAgICBjbGVhcjogKCkgPT4ge1xuICAgICAgZWRpdGFibGUudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgZWRpdGFibGUuZGlzcGF0Y2hFdmVudChuZXcgSW5wdXRFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSwgaW5wdXRUeXBlOiBcImRlbGV0ZUNvbnRlbnRCYWNrd2FyZFwiIH0pKTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBwbGFjZUNhcmV0QXRFbmQoZWxlbWVudDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgc2VsZWN0aW9uID0gd2luZG93LmdldFNlbGVjdGlvbigpO1xuICBpZiAoIXNlbGVjdGlvbikgcmV0dXJuO1xuICBjb25zdCByYW5nZSA9IGRvY3VtZW50LmNyZWF0ZVJhbmdlKCk7XG4gIHJhbmdlLnNlbGVjdE5vZGVDb250ZW50cyhlbGVtZW50KTtcbiAgcmFuZ2UuY29sbGFwc2UoZmFsc2UpO1xuICBzZWxlY3Rpb24ucmVtb3ZlQWxsUmFuZ2VzKCk7XG4gIHNlbGVjdGlvbi5hZGRSYW5nZShyYW5nZSk7XG59XG5cbmZ1bmN0aW9uIHJlYWRUaHJlYWRJZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgY2FuZGlkYXRlczogc3RyaW5nW10gPSBbbG9jYXRpb24ucGF0aG5hbWUsIGxvY2F0aW9uLmhhc2gsIGxvY2F0aW9uLmhyZWZdO1xuICB0cnkge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwobG9jYXRpb24uaHJlZik7XG4gICAgY29uc3QgaW5pdGlhbFJvdXRlID0gdXJsLnNlYXJjaFBhcmFtcy5nZXQoXCJpbml0aWFsUm91dGVcIik7XG4gICAgaWYgKGluaXRpYWxSb3V0ZSkgY2FuZGlkYXRlcy5wdXNoKGluaXRpYWxSb3V0ZSk7XG4gIH0gY2F0Y2gge31cbiAgY2FuZGlkYXRlcy5wdXNoKC4uLmNvbGxlY3RUaHJlYWRSb3V0ZUNhbmRpZGF0ZXMoaGlzdG9yeS5zdGF0ZSkpO1xuICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdERvbVRocmVhZENhbmRpZGF0ZXMoKSk7XG5cbiAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICAgIGNvbnN0IHRocmVhZElkID0gbm9ybWFsaXplVGhyZWFkSWQoY2FuZGlkYXRlKTtcbiAgICBpZiAodGhyZWFkSWQpIHJldHVybiB0aHJlYWRJZDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplVGhyZWFkSWQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBkZWNvZGVkID0gc2FmZURlY29kZSh2YWx1ZSkudHJpbSgpO1xuICBjb25zdCByb3V0ZU1hdGNoID0gZGVjb2RlZC5tYXRjaCgvXFwvbG9jYWxcXC8oW14vPyNcXHNdKykvKTtcbiAgaWYgKHJvdXRlTWF0Y2g/LlsxXSkge1xuICAgIGNvbnN0IGZyb21Sb3V0ZSA9IG5vcm1hbGl6ZVRocmVhZElkVG9rZW4ocm91dGVNYXRjaFsxXSk7XG4gICAgaWYgKGZyb21Sb3V0ZSkgcmV0dXJuIGZyb21Sb3V0ZTtcbiAgfVxuXG4gIGNvbnN0IHRva2VuTWF0Y2ggPSBkZWNvZGVkLm1hdGNoKC9cXGIoPzpbYS16XVtcXHcuLV0qOikqKFswLTlhLWZdezh9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezEyfSlcXGIvaSk7XG4gIGlmICh0b2tlbk1hdGNoPy5bMV0pIHJldHVybiB0b2tlbk1hdGNoWzFdO1xuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUaHJlYWRJZFRva2VuKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgZGVjb2RlZCA9IHNhZmVEZWNvZGUodmFsdWUpLnRyaW0oKTtcbiAgY29uc3QgbWF0Y2ggPSBkZWNvZGVkLm1hdGNoKC8oPzpefDopKFswLTlhLWZdezh9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezR9LVswLTlhLWZdezEyfSkkL2kpO1xuICByZXR1cm4gbWF0Y2g/LlsxXSA/PyBudWxsO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0RG9tVGhyZWFkQ2FuZGlkYXRlcygpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHNlbGVjdG9ycyA9IFtcbiAgICAnW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1yb3ddW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1hY3RpdmU9XCJ0cnVlXCJdW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1pZF0nLFxuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLXJvd11bYXJpYS1jdXJyZW50PVwicGFnZVwiXVtkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRdJyxcbiAgICAnW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1hY3RpdmU9XCJ0cnVlXCJdW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1pZF0nLFxuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXVthcmlhLWN1cnJlbnQ9XCJwYWdlXCJdJyxcbiAgXTtcbiAgY29uc3QgY2FuZGlkYXRlczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBzZWxlY3RvcnMpIHtcbiAgICBmb3IgKGNvbnN0IGVsZW1lbnQgb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihzZWxlY3RvcikpKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXCIpO1xuICAgICAgaWYgKHZhbHVlKSBjYW5kaWRhdGVzLnB1c2godmFsdWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gY2FuZGlkYXRlcztcbn1cblxuZnVuY3Rpb24gc2FmZURlY29kZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gZGVjb2RlVVJJQ29tcG9uZW50KHZhbHVlKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHZhbHVlO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RUaHJlYWRSb3V0ZUNhbmRpZGF0ZXModmFsdWU6IHVua25vd24sIGRlcHRoID0gMCwgc2VlbiA9IG5ldyBTZXQ8dW5rbm93bj4oKSk6IHN0cmluZ1tdIHtcbiAgaWYgKGRlcHRoID4gNSB8fCB2YWx1ZSA9PT0gbnVsbCB8fCB2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHNlZW4uaGFzKHZhbHVlKSkgcmV0dXJuIFtdO1xuICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiKSByZXR1cm4gbm9ybWFsaXplVGhyZWFkSWQodmFsdWUpID8gW3ZhbHVlXSA6IFtdO1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gW107XG4gIHNlZW4uYWRkKHZhbHVlKTtcblxuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGNoaWxkIG9mIE9iamVjdC52YWx1ZXModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgY2FuZGlkYXRlcy5wdXNoKC4uLmNvbGxlY3RUaHJlYWRSb3V0ZUNhbmRpZGF0ZXMoY2hpbGQsIGRlcHRoICsgMSwgc2VlbikpO1xuICB9XG4gIHJldHVybiBjYW5kaWRhdGVzO1xufVxuXG5mdW5jdGlvbiBnb2FsU3RhdHVzTGFiZWwoc3RhdHVzOiBHb2FsU3RhdHVzKTogc3RyaW5nIHtcbiAgc3dpdGNoIChzdGF0dXMpIHtcbiAgICBjYXNlIFwiYWN0aXZlXCI6XG4gICAgICByZXR1cm4gXCJhY3RpdmVcIjtcbiAgICBjYXNlIFwicGF1c2VkXCI6XG4gICAgICByZXR1cm4gXCJwYXVzZWRcIjtcbiAgICBjYXNlIFwiYnVkZ2V0TGltaXRlZFwiOlxuICAgICAgcmV0dXJuIFwibGltaXRlZCBieSBidWRnZXRcIjtcbiAgICBjYXNlIFwiY29tcGxldGVcIjpcbiAgICAgIHJldHVybiBcImNvbXBsZXRlXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZnJpZW5kbHlHb2FsRXJyb3IoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICBjb25zdCBtZXNzYWdlID0gc3RyaW5naWZ5RXJyb3IoZXJyb3IpO1xuICBpZiAoL2dvYWxzIGZlYXR1cmUgaXMgZGlzYWJsZWQvaS50ZXN0KG1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIFwiVGhlIGFwcC1zZXJ2ZXIgaGFzIGdvYWwgc3VwcG9ydCwgYnV0IFtmZWF0dXJlc10uZ29hbHMgaXMgZGlzYWJsZWQgaW4gfi8uY29kZXgvY29uZmlnLnRvbWwuXCI7XG4gIH1cbiAgaWYgKC9yZXF1aXJlcyBleHBlcmltZW50YWxBcGkvaS50ZXN0KG1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIFwiVGhlIGFwcC1zZXJ2ZXIgcmVqZWN0ZWQgdGhyZWFkL2dvYWwvKiBiZWNhdXNlIHRoZSBhY3RpdmUgRGVza3RvcCBjbGllbnQgZGlkIG5vdCBuZWdvdGlhdGUgZXhwZXJpbWVudGFsQXBpLlwiO1xuICB9XG4gIGlmICgvdW5rbm93bnx1bnN1cHBvcnRlZHxub3QgZm91bmR8bm8gaGFuZGxlcnxpbnZhbGlkIHJlcXVlc3R8ZGVzZXJpYWxpemV8dGhyZWFkXFwvZ29hbC9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGlzIENvZGV4LmFwcCBhcHAtc2VydmVyIGRvZXMgbm90IHN1cHBvcnQgdGhyZWFkL2dvYWwvKiB5ZXQuIFVwZGF0ZSBvciByZXBhdGNoIENvZGV4LmFwcCB3aXRoIGEgYnVpbGQgdGhhdCBpbmNsdWRlcyB0aGUgZ29hbHMgZmVhdHVyZS5cIjtcbiAgfVxuICByZXR1cm4gbWVzc2FnZTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0RHVyYXRpb24oc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc2Vjb25kcykgfHwgc2Vjb25kcyA8PSAwKSByZXR1cm4gXCIwc1wiO1xuICBjb25zdCBtaW51dGVzID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gNjApO1xuICBjb25zdCByZW1haW5pbmdTZWNvbmRzID0gTWF0aC5mbG9vcihzZWNvbmRzICUgNjApO1xuICBpZiAobWludXRlcyA8PSAwKSByZXR1cm4gYCR7cmVtYWluaW5nU2Vjb25kc31zYDtcbiAgY29uc3QgaG91cnMgPSBNYXRoLmZsb29yKG1pbnV0ZXMgLyA2MCk7XG4gIGNvbnN0IHJlbWFpbmluZ01pbnV0ZXMgPSBtaW51dGVzICUgNjA7XG4gIGlmIChob3VycyA8PSAwKSByZXR1cm4gYCR7bWludXRlc31tICR7cmVtYWluaW5nU2Vjb25kc31zYDtcbiAgcmV0dXJuIGAke2hvdXJzfWggJHtyZW1haW5pbmdNaW51dGVzfW1gO1xufVxuXG5mdW5jdGlvbiBmb3JtYXROdW1iZXIodmFsdWU6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gTWF0aC5yb3VuZCh2YWx1ZSkudG9Mb2NhbGVTdHJpbmcoKSA6IFwiMFwiO1xufVxuXG5mdW5jdGlvbiB0cnVuY2F0ZSh2YWx1ZTogc3RyaW5nLCBtYXhMZW5ndGg6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5sZW5ndGggPD0gbWF4TGVuZ3RoID8gdmFsdWUgOiBgJHt2YWx1ZS5zbGljZSgwLCBtYXhMZW5ndGggLSAxKX0uLi5gO1xufVxuXG5mdW5jdGlvbiBzdHJpbmdpZnlFcnJvcihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG59XG5cbmZ1bmN0aW9uIGlzVGhyZWFkR29hbCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFRocmVhZEdvYWwge1xuICByZXR1cm4gaXNSZWNvcmQodmFsdWUpICYmXG4gICAgdHlwZW9mIHZhbHVlLnRocmVhZElkID09PSBcInN0cmluZ1wiICYmXG4gICAgdHlwZW9mIHZhbHVlLm9iamVjdGl2ZSA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIHR5cGVvZiB2YWx1ZS5zdGF0dXMgPT09IFwic3RyaW5nXCI7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4gdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTtcbn1cbiIsICJpbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHR5cGUge1xuICBHaXREaWZmU3VtbWFyeSxcbiAgR2l0U3RhdHVzLFxuICBHaXRTdGF0dXNFbnRyeSxcbiAgR2l0V29ya3RyZWUsXG59IGZyb20gXCJAY29kZXgtcGx1c3BsdXMvc2RrXCI7XG5cbmNvbnN0IFBST0pFQ1RfUk9XX1NFTEVDVE9SID1cbiAgXCJbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1yb3ddW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtaWRdXCI7XG5jb25zdCBBQ1RJVkVfVEhSRUFEX1NFTEVDVE9SID1cbiAgXCJbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT0ndHJ1ZSddLFtkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtYWN0aXZlPXRydWVdXCI7XG5jb25zdCBQUk9KRUNUX0xJU1RfU0VMRUNUT1IgPSBcIltkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWxpc3QtaWRdXCI7XG5jb25zdCBTVU1NQVJZX0FUVFIgPSBcImRhdGEtY29kZXhwcC1naXQtc3VtbWFyeVwiO1xuY29uc3QgQkFER0VfQVRUUiA9IFwiZGF0YS1jb2RleHBwLWdpdC1iYWRnZVwiO1xuY29uc3QgU1RZTEVfSUQgPSBcImNvZGV4cHAtZ2l0LXNpZGViYXItc3R5bGVcIjtcbmNvbnN0IFJFRlJFU0hfREVCT1VOQ0VfTVMgPSAyNTA7XG5jb25zdCBTVEFUVVNfVFRMX01TID0gMTBfMDAwO1xuY29uc3QgREVUQUlMU19UVExfTVMgPSAxNV8wMDA7XG5jb25zdCBNQVhfVklTSUJMRV9QUk9KRUNUX0JBREdFUyA9IDE2O1xuY29uc3QgTUFYX0NIQU5HRURfRklMRVMgPSA3O1xuY29uc3QgTUFYX1dPUktUUkVFX1JPV1MgPSAzO1xuXG5pbnRlcmZhY2UgUHJvamVjdFJvdyB7XG4gIHJvdzogSFRNTEVsZW1lbnQ7XG4gIGdyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHBhdGg6IHN0cmluZztcbiAgbGFiZWw6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFN0YXR1c0NhY2hlRW50cnkge1xuICB2YWx1ZTogR2l0U3RhdHVzIHwgbnVsbDtcbiAgZXJyb3I6IHN0cmluZyB8IG51bGw7XG4gIGxvYWRlZEF0OiBudW1iZXI7XG4gIHBlbmRpbmc6IFByb21pc2U8R2l0U3RhdHVzIHwgbnVsbD4gfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgRGV0YWlsc0NhY2hlRW50cnkge1xuICB2YWx1ZTogR2l0RGV0YWlscyB8IG51bGw7XG4gIGVycm9yOiBzdHJpbmcgfCBudWxsO1xuICBsb2FkZWRBdDogbnVtYmVyO1xuICBwZW5kaW5nOiBQcm9taXNlPEdpdERldGFpbHMgfCBudWxsPiB8IG51bGw7XG59XG5cbmludGVyZmFjZSBHaXREZXRhaWxzIHtcbiAgZGlmZjogR2l0RGlmZlN1bW1hcnk7XG4gIHdvcmt0cmVlczogR2l0V29ya3RyZWVbXTtcbn1cblxuaW50ZXJmYWNlIEdpdFNpZGViYXJTdGF0ZSB7XG4gIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbDtcbiAgcmVmcmVzaFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG4gIGludGVydmFsOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRJbnRlcnZhbD4gfCBudWxsO1xuICBydW5JZDogbnVtYmVyO1xuICBzdGF0dXNDYWNoZTogTWFwPHN0cmluZywgU3RhdHVzQ2FjaGVFbnRyeT47XG4gIGRldGFpbHNDYWNoZTogTWFwPHN0cmluZywgRGV0YWlsc0NhY2hlRW50cnk+O1xufVxuXG5jb25zdCBzdGF0ZTogR2l0U2lkZWJhclN0YXRlID0ge1xuICBvYnNlcnZlcjogbnVsbCxcbiAgcmVmcmVzaFRpbWVyOiBudWxsLFxuICBpbnRlcnZhbDogbnVsbCxcbiAgcnVuSWQ6IDAsXG4gIHN0YXR1c0NhY2hlOiBuZXcgTWFwKCksXG4gIGRldGFpbHNDYWNoZTogbmV3IE1hcCgpLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0R2l0U2lkZWJhcigpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm9ic2VydmVyKSByZXR1cm47XG5cbiAgaW5zdGFsbFN0eWxlcygpO1xuXG4gIGNvbnN0IG9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKG11dGF0aW9ucykgPT4ge1xuICAgIGlmIChtdXRhdGlvbnMuc29tZShzaG91bGRSZWFjdFRvTXV0YXRpb24pKSB7XG4gICAgICBzY2hlZHVsZVJlZnJlc2goXCJtdXRhdGlvblwiKTtcbiAgICB9XG4gIH0pO1xuICBvYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwge1xuICAgIGNoaWxkTGlzdDogdHJ1ZSxcbiAgICBzdWJ0cmVlOiB0cnVlLFxuICAgIGF0dHJpYnV0ZXM6IHRydWUsXG4gICAgYXR0cmlidXRlRmlsdGVyOiBbXG4gICAgICBcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1hY3RpdmVcIixcbiAgICAgIFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1jb2xsYXBzZWRcIixcbiAgICAgIFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1pZFwiLFxuICAgICAgXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LXJvd1wiLFxuICAgIF0sXG4gIH0pO1xuICBzdGF0ZS5vYnNlcnZlciA9IG9ic2VydmVyO1xuICBzdGF0ZS5pbnRlcnZhbCA9IHNldEludGVydmFsKCgpID0+IHNjaGVkdWxlUmVmcmVzaChcImludGVydmFsXCIpLCAxNV8wMDApO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcImZvY3VzXCIsIG9uV2luZG93Rm9jdXMpO1xuICBzY2hlZHVsZVJlZnJlc2goXCJib290XCIpO1xufVxuXG5mdW5jdGlvbiBvbldpbmRvd0ZvY3VzKCk6IHZvaWQge1xuICBzY2hlZHVsZVJlZnJlc2goXCJmb2N1c1wiKTtcbn1cblxuZnVuY3Rpb24gc2hvdWxkUmVhY3RUb011dGF0aW9uKG11dGF0aW9uOiBNdXRhdGlvblJlY29yZCk6IGJvb2xlYW4ge1xuICBpZiAobXV0YXRpb24udHlwZSA9PT0gXCJhdHRyaWJ1dGVzXCIpIHtcbiAgICBjb25zdCB0YXJnZXQgPSBtdXRhdGlvbi50YXJnZXQ7XG4gICAgcmV0dXJuIHRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgJiYgKFxuICAgICAgdGFyZ2V0Lm1hdGNoZXMoUFJPSkVDVF9ST1dfU0VMRUNUT1IpIHx8XG4gICAgICB0YXJnZXQubWF0Y2hlcyhBQ1RJVkVfVEhSRUFEX1NFTEVDVE9SKSB8fFxuICAgICAgdGFyZ2V0Lmhhc0F0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtbGlzdC1pZFwiKVxuICAgICk7XG4gIH1cbiAgZm9yIChjb25zdCBub2RlIG9mIEFycmF5LmZyb20obXV0YXRpb24uYWRkZWROb2RlcykpIHtcbiAgICBpZiAobm9kZUNvbnRhaW5zU2lkZWJhclByb2plY3Qobm9kZSkpIHJldHVybiB0cnVlO1xuICB9XG4gIGZvciAoY29uc3Qgbm9kZSBvZiBBcnJheS5mcm9tKG11dGF0aW9uLnJlbW92ZWROb2RlcykpIHtcbiAgICBpZiAobm9kZUNvbnRhaW5zU2lkZWJhclByb2plY3Qobm9kZSkpIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gbm9kZUNvbnRhaW5zU2lkZWJhclByb2plY3Qobm9kZTogTm9kZSk6IGJvb2xlYW4ge1xuICBpZiAoIShub2RlIGluc3RhbmNlb2YgRWxlbWVudCkpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIG5vZGUubWF0Y2hlcyhQUk9KRUNUX1JPV19TRUxFQ1RPUikgfHwgQm9vbGVhbihub2RlLnF1ZXJ5U2VsZWN0b3IoUFJPSkVDVF9ST1dfU0VMRUNUT1IpKTtcbn1cblxuZnVuY3Rpb24gc2NoZWR1bGVSZWZyZXNoKF9yZWFzb246IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUucmVmcmVzaFRpbWVyKSBjbGVhclRpbWVvdXQoc3RhdGUucmVmcmVzaFRpbWVyKTtcbiAgc3RhdGUucmVmcmVzaFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc3RhdGUucmVmcmVzaFRpbWVyID0gbnVsbDtcbiAgICB2b2lkIHJlZnJlc2goKTtcbiAgfSwgUkVGUkVTSF9ERUJPVU5DRV9NUyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlZnJlc2goKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJ1bklkID0gKytzdGF0ZS5ydW5JZDtcbiAgY29uc3QgcHJvamVjdHMgPSBjb2xsZWN0UHJvamVjdFJvd3MoKTtcbiAgaWYgKHByb2plY3RzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJlbW92ZVN1bW1hcnlQYW5lbCgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGFjdGl2ZVBhdGggPSBnZXRBY3RpdmVQcm9qZWN0UGF0aChwcm9qZWN0cyk7XG4gIGNvbnN0IGFjdGl2ZVByb2plY3QgPVxuICAgIChhY3RpdmVQYXRoID8gcHJvamVjdHMuZmluZCgocHJvamVjdCkgPT4gcHJvamVjdC5wYXRoID09PSBhY3RpdmVQYXRoKSA6IG51bGwpID8/XG4gICAgcHJvamVjdHMuZmluZCgocHJvamVjdCkgPT4gcHJvamVjdC5yb3cuZ2V0QXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1jb2xsYXBzZWRcIikgPT09IFwiZmFsc2VcIikgPz9cbiAgICBwcm9qZWN0c1swXTtcblxuICBjb25zdCBiYWRnZVByb2plY3RzID0gcHJpb3JpdGl6ZUJhZGdlUHJvamVjdHMocHJvamVjdHMsIGFjdGl2ZVByb2plY3QpO1xuICBjb25zdCBiYWRnZVN0YXR1c2VzID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgYmFkZ2VQcm9qZWN0cy5tYXAoYXN5bmMgKHByb2plY3QpID0+IHtcbiAgICAgIGNvbnN0IHN0YXR1cyA9IGF3YWl0IGdldFN0YXR1cyhwcm9qZWN0LnBhdGgpO1xuICAgICAgcmV0dXJuIHsgcHJvamVjdCwgc3RhdHVzIH07XG4gICAgfSksXG4gICk7XG4gIGlmIChydW5JZCAhPT0gc3RhdGUucnVuSWQpIHJldHVybjtcbiAgZm9yIChjb25zdCB7IHByb2plY3QsIHN0YXR1cyB9IG9mIGJhZGdlU3RhdHVzZXMpIHtcbiAgICByZW5kZXJQcm9qZWN0QmFkZ2UocHJvamVjdCwgc3RhdHVzKTtcbiAgfVxuXG4gIGNvbnN0IHN1bW1hcnlQcm9qZWN0ID1cbiAgICBiYWRnZVN0YXR1c2VzLmZpbmQoKHsgcHJvamVjdCwgc3RhdHVzIH0pID0+IHByb2plY3QucGF0aCA9PT0gYWN0aXZlUHJvamVjdD8ucGF0aCAmJiBpc1VzYWJsZVJlcG8oc3RhdHVzKSlcbiAgICAgID8ucHJvamVjdCA/P1xuICAgIGJhZGdlU3RhdHVzZXMuZmluZCgoeyBzdGF0dXMgfSkgPT4gaXNVc2FibGVSZXBvKHN0YXR1cykpPy5wcm9qZWN0ID8/XG4gICAgYWN0aXZlUHJvamVjdDtcblxuICBpZiAoIXN1bW1hcnlQcm9qZWN0KSB7XG4gICAgcmVtb3ZlU3VtbWFyeVBhbmVsKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgW3N0YXR1cywgZGV0YWlsc10gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgZ2V0U3RhdHVzKHN1bW1hcnlQcm9qZWN0LnBhdGgpLFxuICAgIGdldERldGFpbHMoc3VtbWFyeVByb2plY3QucGF0aCksXG4gIF0pO1xuICBpZiAocnVuSWQgIT09IHN0YXRlLnJ1bklkKSByZXR1cm47XG4gIHJlbmRlclN1bW1hcnlQYW5lbChzdW1tYXJ5UHJvamVjdCwgc3RhdHVzLCBkZXRhaWxzKTtcbn1cblxuZnVuY3Rpb24gY29sbGVjdFByb2plY3RSb3dzKCk6IFByb2plY3RSb3dbXSB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3Qgcm93czogUHJvamVjdFJvd1tdID0gW107XG4gIGZvciAoY29uc3Qgcm93IG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oUFJPSkVDVF9ST1dfU0VMRUNUT1IpKSkge1xuICAgIGNvbnN0IHBhdGggPSByb3cuZ2V0QXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1pZFwiKT8udHJpbSgpO1xuICAgIGlmICghcGF0aCB8fCBzZWVuLmhhcyhwYXRoKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQocGF0aCk7XG4gICAgcm93cy5wdXNoKHtcbiAgICAgIHJvdyxcbiAgICAgIHBhdGgsXG4gICAgICBsYWJlbDogcm93LmdldEF0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtbGFiZWxcIik/LnRyaW0oKSB8fCBiYXNlbmFtZShwYXRoKSxcbiAgICAgIGdyb3VwOiBmaW5kUHJvamVjdEdyb3VwKHJvdyksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIHJvd3M7XG59XG5cbmZ1bmN0aW9uIGZpbmRQcm9qZWN0R3JvdXAocm93OiBIVE1MRWxlbWVudCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGxldCBjdXJyZW50OiBIVE1MRWxlbWVudCB8IG51bGwgPSByb3cucGFyZW50RWxlbWVudDtcbiAgd2hpbGUgKGN1cnJlbnQgJiYgY3VycmVudCAhPT0gZG9jdW1lbnQuYm9keSkge1xuICAgIGlmIChjdXJyZW50LmdldEF0dHJpYnV0ZShcInJvbGVcIikgPT09IFwibGlzdGl0ZW1cIiAmJiBjdXJyZW50LnRleHRDb250ZW50Py5pbmNsdWRlcyhyb3cudGV4dENvbnRlbnQgPz8gXCJcIikpIHtcbiAgICAgIHJldHVybiBjdXJyZW50O1xuICAgIH1cbiAgICBpZiAoY3VycmVudC5xdWVyeVNlbGVjdG9yKFBST0pFQ1RfUk9XX1NFTEVDVE9SKSA9PT0gcm93ICYmIGN1cnJlbnQucXVlcnlTZWxlY3RvcihQUk9KRUNUX0xJU1RfU0VMRUNUT1IpKSB7XG4gICAgICByZXR1cm4gY3VycmVudDtcbiAgICB9XG4gICAgY3VycmVudCA9IGN1cnJlbnQucGFyZW50RWxlbWVudDtcbiAgfVxuICByZXR1cm4gcm93LnBhcmVudEVsZW1lbnQ7XG59XG5cbmZ1bmN0aW9uIGdldEFjdGl2ZVByb2plY3RQYXRoKHByb2plY3RzOiBQcm9qZWN0Um93W10pOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgYWN0aXZlVGhyZWFkID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oQUNUSVZFX1RIUkVBRF9TRUxFQ1RPUik7XG4gIGNvbnN0IHByb2plY3RMaXN0ID0gYWN0aXZlVGhyZWFkPy5jbG9zZXN0PEhUTUxFbGVtZW50PihQUk9KRUNUX0xJU1RfU0VMRUNUT1IpO1xuICBjb25zdCBsaXN0UGF0aCA9IHByb2plY3RMaXN0Py5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWxpc3QtaWRcIik/LnRyaW0oKTtcbiAgaWYgKGxpc3RQYXRoKSByZXR1cm4gbGlzdFBhdGg7XG5cbiAgY29uc3QgZXhwYW5kZWQgPSBwcm9qZWN0cy5maW5kKFxuICAgIChwcm9qZWN0KSA9PiBwcm9qZWN0LnJvdy5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWNvbGxhcHNlZFwiKSA9PT0gXCJmYWxzZVwiLFxuICApO1xuICByZXR1cm4gZXhwYW5kZWQ/LnBhdGggPz8gbnVsbDtcbn1cblxuZnVuY3Rpb24gcHJpb3JpdGl6ZUJhZGdlUHJvamVjdHMocHJvamVjdHM6IFByb2plY3RSb3dbXSwgYWN0aXZlUHJvamVjdDogUHJvamVjdFJvdyB8IHVuZGVmaW5lZCk6IFByb2plY3RSb3dbXSB7XG4gIGNvbnN0IHZpc2libGUgPSBwcm9qZWN0cy5maWx0ZXIoKHByb2plY3QpID0+IHtcbiAgICBjb25zdCByZWN0ID0gcHJvamVjdC5yb3cuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgcmV0dXJuIHJlY3Qud2lkdGggPiAwICYmIHJlY3QuaGVpZ2h0ID4gMCAmJiByZWN0LmJvdHRvbSA+PSAwICYmIHJlY3QudG9wIDw9IHdpbmRvdy5pbm5lckhlaWdodDtcbiAgfSk7XG4gIGNvbnN0IG9yZGVyZWQgPSBhY3RpdmVQcm9qZWN0XG4gICAgPyBbYWN0aXZlUHJvamVjdCwgLi4udmlzaWJsZS5maWx0ZXIoKHByb2plY3QpID0+IHByb2plY3QucGF0aCAhPT0gYWN0aXZlUHJvamVjdC5wYXRoKV1cbiAgICA6IHZpc2libGU7XG4gIHJldHVybiBvcmRlcmVkLnNsaWNlKDAsIE1BWF9WSVNJQkxFX1BST0pFQ1RfQkFER0VTKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0U3RhdHVzKHBhdGg6IHN0cmluZyk6IFByb21pc2U8R2l0U3RhdHVzIHwgbnVsbD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBjYWNoZWQgPSBzdGF0ZS5zdGF0dXNDYWNoZS5nZXQocGF0aCk7XG4gIGlmIChjYWNoZWQ/LnZhbHVlICYmIG5vdyAtIGNhY2hlZC5sb2FkZWRBdCA8IFNUQVRVU19UVExfTVMpIHJldHVybiBjYWNoZWQudmFsdWU7XG4gIGlmIChjYWNoZWQ/LnBlbmRpbmcpIHJldHVybiBjYWNoZWQucGVuZGluZztcblxuICBjb25zdCBlbnRyeTogU3RhdHVzQ2FjaGVFbnRyeSA9IGNhY2hlZCA/PyB7XG4gICAgdmFsdWU6IG51bGwsXG4gICAgZXJyb3I6IG51bGwsXG4gICAgbG9hZGVkQXQ6IDAsXG4gICAgcGVuZGluZzogbnVsbCxcbiAgfTtcbiAgZW50cnkucGVuZGluZyA9IGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcImNvZGV4cHA6Z2l0LXN0YXR1c1wiLCBwYXRoKVxuICAgIC50aGVuKChzdGF0dXMpID0+IHtcbiAgICAgIGVudHJ5LnZhbHVlID0gc3RhdHVzIGFzIEdpdFN0YXR1cztcbiAgICAgIGVudHJ5LmVycm9yID0gbnVsbDtcbiAgICAgIGVudHJ5LmxvYWRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHJldHVybiBlbnRyeS52YWx1ZTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICAgIGVudHJ5LmVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgZW50cnkubG9hZGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICBlbnRyeS5wZW5kaW5nID0gbnVsbDtcbiAgICB9KTtcbiAgc3RhdGUuc3RhdHVzQ2FjaGUuc2V0KHBhdGgsIGVudHJ5KTtcbiAgcmV0dXJuIGVudHJ5LnBlbmRpbmc7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldERldGFpbHMocGF0aDogc3RyaW5nKTogUHJvbWlzZTxHaXREZXRhaWxzIHwgbnVsbD4ge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBjYWNoZWQgPSBzdGF0ZS5kZXRhaWxzQ2FjaGUuZ2V0KHBhdGgpO1xuICBpZiAoY2FjaGVkPy52YWx1ZSAmJiBub3cgLSBjYWNoZWQubG9hZGVkQXQgPCBERVRBSUxTX1RUTF9NUykgcmV0dXJuIGNhY2hlZC52YWx1ZTtcbiAgaWYgKGNhY2hlZD8ucGVuZGluZykgcmV0dXJuIGNhY2hlZC5wZW5kaW5nO1xuXG4gIGNvbnN0IGVudHJ5OiBEZXRhaWxzQ2FjaGVFbnRyeSA9IGNhY2hlZCA/PyB7XG4gICAgdmFsdWU6IG51bGwsXG4gICAgZXJyb3I6IG51bGwsXG4gICAgbG9hZGVkQXQ6IDAsXG4gICAgcGVuZGluZzogbnVsbCxcbiAgfTtcbiAgZW50cnkucGVuZGluZyA9IFByb21pc2UuYWxsKFtcbiAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdpdC1kaWZmLXN1bW1hcnlcIiwgcGF0aCkgYXMgUHJvbWlzZTxHaXREaWZmU3VtbWFyeT4sXG4gICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnaXQtd29ya3RyZWVzXCIsIHBhdGgpIGFzIFByb21pc2U8R2l0V29ya3RyZWVbXT4sXG4gIF0pXG4gICAgLnRoZW4oKFtkaWZmLCB3b3JrdHJlZXNdKSA9PiB7XG4gICAgICBlbnRyeS52YWx1ZSA9IHsgZGlmZiwgd29ya3RyZWVzIH07XG4gICAgICBlbnRyeS5lcnJvciA9IG51bGw7XG4gICAgICBlbnRyeS5sb2FkZWRBdCA9IERhdGUubm93KCk7XG4gICAgICByZXR1cm4gZW50cnkudmFsdWU7XG4gICAgfSlcbiAgICAuY2F0Y2goKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgICBlbnRyeS5lcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIGVudHJ5LmxvYWRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0pXG4gICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgZW50cnkucGVuZGluZyA9IG51bGw7XG4gICAgfSk7XG4gIHN0YXRlLmRldGFpbHNDYWNoZS5zZXQocGF0aCwgZW50cnkpO1xuICByZXR1cm4gZW50cnkucGVuZGluZztcbn1cblxuZnVuY3Rpb24gcmVuZGVyUHJvamVjdEJhZGdlKHByb2plY3Q6IFByb2plY3RSb3csIHN0YXR1czogR2l0U3RhdHVzIHwgbnVsbCk6IHZvaWQge1xuICBpZiAoIWlzVXNhYmxlUmVwbyhzdGF0dXMpKSB7XG4gICAgcHJvamVjdC5yb3cucXVlcnlTZWxlY3RvcihgWyR7QkFER0VfQVRUUn1dYCk/LnJlbW92ZSgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGJhZGdlID0gZW5zdXJlQmFkZ2UocHJvamVjdC5yb3cpO1xuICBjb25zdCBkaXJ0eSA9IGNvdW50RGlydHkoc3RhdHVzLmVudHJpZXMpO1xuICBjb25zdCBjb25mbGljdHMgPSBjb3VudENvbmZsaWN0cyhzdGF0dXMuZW50cmllcyk7XG4gIGNvbnN0IGJyYW5jaCA9IGJyYW5jaExhYmVsKHN0YXR1cyk7XG4gIGNvbnN0IHN5bmMgPSBzeW5jTGFiZWwoc3RhdHVzKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcImNvZGV4cHAtZ2l0LWJhZGdlLWRpcnR5XCIsIGRpcnR5ID4gMCk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJjb2RleHBwLWdpdC1iYWRnZS1jb25mbGljdFwiLCBjb25mbGljdHMgPiAwKTtcbiAgYmFkZ2UudGl0bGUgPSBbXG4gICAgYCR7cHJvamVjdC5sYWJlbH06ICR7YnJhbmNofWAsXG4gICAgZGlydHkgPT09IDAgPyBcImNsZWFuXCIgOiBgJHtkaXJ0eX0gY2hhbmdlZGAsXG4gICAgY29uZmxpY3RzID4gMCA/IGAke2NvbmZsaWN0c30gY29uZmxpY3Qke3BsdXJhbChjb25mbGljdHMpfWAgOiBcIlwiLFxuICAgIHN5bmMudGl0bGUsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIsIFwiKTtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBbYnJhbmNoLCBkaXJ0eSA+IDAgPyBTdHJpbmcoZGlydHkpIDogXCJcIiwgc3luYy5zaG9ydF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVCYWRnZShyb3c6IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBleGlzdGluZyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihgWyR7QkFER0VfQVRUUn1dYCk7XG4gIGlmIChleGlzdGluZykgcmV0dXJuIGV4aXN0aW5nO1xuXG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLnNldEF0dHJpYnV0ZShCQURHRV9BVFRSLCBcIlwiKTtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdpdC1wcm9qZWN0LWJhZGdlXCI7XG4gIHJvdy5hcHBlbmRDaGlsZChiYWRnZSk7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyU3VtbWFyeVBhbmVsKHByb2plY3Q6IFByb2plY3RSb3csIHN0YXR1czogR2l0U3RhdHVzIHwgbnVsbCwgZGV0YWlsczogR2l0RGV0YWlscyB8IG51bGwpOiB2b2lkIHtcbiAgaWYgKCFpc1VzYWJsZVJlcG8oc3RhdHVzKSkge1xuICAgIHJlbW92ZVN1bW1hcnlQYW5lbCgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGhvc3QgPSBwcm9qZWN0Lmdyb3VwID8/IHByb2plY3Qucm93LnBhcmVudEVsZW1lbnQ7XG4gIGlmICghaG9zdCkgcmV0dXJuO1xuXG4gIGNvbnN0IHBhbmVsID0gZW5zdXJlU3VtbWFyeVBhbmVsKGhvc3QsIHByb2plY3Qucm93KTtcbiAgY2xlYXIocGFuZWwpO1xuXG4gIGNvbnN0IGRpcnR5ID0gY291bnREaXJ0eShzdGF0dXMuZW50cmllcyk7XG4gIGNvbnN0IGNvdW50cyA9IGNvdW50U3RhdHVzKHN0YXR1cy5lbnRyaWVzKTtcbiAgY29uc3QgYnJhbmNoID0gYnJhbmNoTGFiZWwoc3RhdHVzKTtcbiAgY29uc3Qgc3luYyA9IHN5bmNMYWJlbChzdGF0dXMpO1xuICBjb25zdCBkaWZmID0gZGV0YWlscz8uZGlmZiA/PyBudWxsO1xuICBjb25zdCB3b3JrdHJlZXMgPSBkZXRhaWxzPy53b3JrdHJlZXMgPz8gW107XG5cbiAgY29uc3QgaGVhZGVyID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC1zdW1tYXJ5LWhlYWRlclwiKTtcbiAgY29uc3QgdGl0bGUgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LXN1bW1hcnktdGl0bGVcIik7XG4gIHRpdGxlLmFwcGVuZCh0ZXh0RWwoXCJzcGFuXCIsIFwiR2l0XCIpKTtcbiAgdGl0bGUuYXBwZW5kKHRleHRFbChcInN0cm9uZ1wiLCBicmFuY2gpKTtcbiAgaWYgKHN5bmMuc2hvcnQpIHRpdGxlLmFwcGVuZCh0ZXh0RWwoXCJzcGFuXCIsIHN5bmMuc2hvcnQpKTtcbiAgY29uc3Qgc3RhdGVDaGlwID0gdGV4dEVsKFwic3BhblwiLCBkaXJ0eSA9PT0gMCA/IFwiY2xlYW5cIiA6IGAke2RpcnR5fSBjaGFuZ2VkYCk7XG4gIHN0YXRlQ2hpcC5jbGFzc05hbWUgPSBgY29kZXhwcC1naXQtc3VtbWFyeS1zdGF0ZSAke2RpcnR5ID09PSAwID8gXCJpcy1jbGVhblwiIDogXCJpcy1kaXJ0eVwifWA7XG4gIGhlYWRlci5hcHBlbmQodGl0bGUsIHN0YXRlQ2hpcCk7XG4gIHBhbmVsLmFwcGVuZChoZWFkZXIpO1xuXG4gIGNvbnN0IG1ldHJpY3MgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LXN1bW1hcnktbWV0cmljc1wiKTtcbiAgbWV0cmljcy5hcHBlbmQoXG4gICAgbWV0cmljKFwic3RhZ2VkXCIsIGNvdW50cy5zdGFnZWQpLFxuICAgIG1ldHJpYyhcInVuc3RhZ2VkXCIsIGNvdW50cy51bnN0YWdlZCksXG4gICAgbWV0cmljKFwidW50cmFja2VkXCIsIGNvdW50cy51bnRyYWNrZWQpLFxuICAgIG1ldHJpYyhcImNvbmZsaWN0c1wiLCBjb3VudHMuY29uZmxpY3RzKSxcbiAgKTtcbiAgcGFuZWwuYXBwZW5kKG1ldHJpY3MpO1xuXG4gIGlmIChkaWZmKSB7XG4gICAgY29uc3QgZGlmZkxpbmUgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LXN1bW1hcnktbGluZVwiKTtcbiAgICBkaWZmTGluZS5hcHBlbmQoXG4gICAgICB0ZXh0RWwoXCJzcGFuXCIsIGAke2RpZmYuZmlsZUNvdW50fSBmaWxlJHtwbHVyYWwoZGlmZi5maWxlQ291bnQpfWApLFxuICAgICAgdGV4dEVsKFwic3BhblwiLCBgKyR7ZGlmZi5pbnNlcnRpb25zfWApLFxuICAgICAgdGV4dEVsKFwic3BhblwiLCBgLSR7ZGlmZi5kZWxldGlvbnN9YCksXG4gICAgICAuLi4oZGlmZi50cnVuY2F0ZWQgPyBbdGV4dEVsKFwic3BhblwiLCBcInRydW5jYXRlZFwiKV0gOiBbXSksXG4gICAgKTtcbiAgICBwYW5lbC5hcHBlbmQoZGlmZkxpbmUpO1xuICB9XG5cbiAgY29uc3QgY2hhbmdlZCA9IHN0YXR1cy5lbnRyaWVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LmtpbmQgIT09IFwiaWdub3JlZFwiKS5zbGljZSgwLCBNQVhfQ0hBTkdFRF9GSUxFUyk7XG4gIGlmIChjaGFuZ2VkLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBsaXN0ID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC1jaGFuZ2VkLWZpbGVzXCIpO1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgY2hhbmdlZCkge1xuICAgICAgY29uc3Qgcm93ID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC1maWxlLXJvd1wiKTtcbiAgICAgIHJvdy5hcHBlbmQodGV4dEVsKFwic3BhblwiLCBlbnRyeUxhYmVsKGVudHJ5KSksIHRleHRFbChcInNwYW5cIiwgZW50cnlQYXRoKGVudHJ5KSkpO1xuICAgICAgbGlzdC5hcHBlbmQocm93KTtcbiAgICB9XG4gICAgaWYgKHN0YXR1cy5lbnRyaWVzLmxlbmd0aCA+IGNoYW5nZWQubGVuZ3RoKSB7XG4gICAgICBjb25zdCBtb3JlID0gdGV4dEVsKFwiZGl2XCIsIGArJHtzdGF0dXMuZW50cmllcy5sZW5ndGggLSBjaGFuZ2VkLmxlbmd0aH0gbW9yZWApO1xuICAgICAgbW9yZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ2l0LW1vcmVcIjtcbiAgICAgIGxpc3QuYXBwZW5kKG1vcmUpO1xuICAgIH1cbiAgICBwYW5lbC5hcHBlbmQobGlzdCk7XG4gIH1cblxuICBpZiAod29ya3RyZWVzLmxlbmd0aCA+IDEpIHtcbiAgICBjb25zdCB3b3JrdHJlZUxpc3QgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LXdvcmt0cmVlc1wiKTtcbiAgICBjb25zdCBsYWJlbCA9IHRleHRFbChcImRpdlwiLCBgJHt3b3JrdHJlZXMubGVuZ3RofSB3b3JrdHJlZXNgKTtcbiAgICBsYWJlbC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ2l0LXdvcmt0cmVlcy1sYWJlbFwiO1xuICAgIHdvcmt0cmVlTGlzdC5hcHBlbmQobGFiZWwpO1xuICAgIGZvciAoY29uc3Qgd29ya3RyZWUgb2Ygd29ya3RyZWVzLnNsaWNlKDAsIE1BWF9XT1JLVFJFRV9ST1dTKSkge1xuICAgICAgY29uc3Qgcm93ID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC13b3JrdHJlZS1yb3dcIik7XG4gICAgICByb3cuYXBwZW5kKFxuICAgICAgICB0ZXh0RWwoXCJzcGFuXCIsIHdvcmt0cmVlLmJyYW5jaCA/PyBzaG9ydFNoYSh3b3JrdHJlZS5oZWFkKSA/PyBcImRldGFjaGVkXCIpLFxuICAgICAgICB0ZXh0RWwoXCJzcGFuXCIsIGJhc2VuYW1lKHdvcmt0cmVlLnBhdGgpKSxcbiAgICAgICk7XG4gICAgICB3b3JrdHJlZUxpc3QuYXBwZW5kKHJvdyk7XG4gICAgfVxuICAgIHBhbmVsLmFwcGVuZCh3b3JrdHJlZUxpc3QpO1xuICB9XG5cbiAgY29uc3QgaXNzdWUgPSBzdGF0dXMucmVwb3NpdG9yeS5lcnJvcj8ubWVzc2FnZSB8fCBzdGF0ZS5zdGF0dXNDYWNoZS5nZXQocHJvamVjdC5wYXRoKT8uZXJyb3IgfHwgc3RhdGUuZGV0YWlsc0NhY2hlLmdldChwcm9qZWN0LnBhdGgpPy5lcnJvcjtcbiAgaWYgKGlzc3VlKSB7XG4gICAgY29uc3Qgd2FybmluZyA9IHRleHRFbChcImRpdlwiLCBpc3N1ZSk7XG4gICAgd2FybmluZy5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ2l0LXdhcm5pbmdcIjtcbiAgICBwYW5lbC5hcHBlbmQod2FybmluZyk7XG4gIH1cbn1cblxuZnVuY3Rpb24gaXNVc2FibGVSZXBvKHN0YXR1czogR2l0U3RhdHVzIHwgbnVsbCk6IHN0YXR1cyBpcyBHaXRTdGF0dXMge1xuICByZXR1cm4gQm9vbGVhbihzdGF0dXM/LnJlcG9zaXRvcnkuZm91bmQgJiYgc3RhdHVzLnJlcG9zaXRvcnkuaXNJbnNpZGVXb3JrVHJlZSk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVN1bW1hcnlQYW5lbChob3N0OiBIVE1MRWxlbWVudCwgcm93OiBIVE1MRWxlbWVudCk6IEhUTUxFbGVtZW50IHtcbiAgbGV0IHBhbmVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oYFske1NVTU1BUllfQVRUUn1dYCk7XG4gIGlmICghcGFuZWwpIHtcbiAgICBwYW5lbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICAgIHBhbmVsLnNldEF0dHJpYnV0ZShTVU1NQVJZX0FUVFIsIFwiXCIpO1xuICAgIHBhbmVsLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1naXQtc3VtbWFyeVwiO1xuICB9XG5cbiAgaWYgKHBhbmVsLnBhcmVudEVsZW1lbnQgIT09IGhvc3QpIHtcbiAgICBwYW5lbC5yZW1vdmUoKTtcbiAgICBob3N0Lmluc2VydEJlZm9yZShwYW5lbCwgcm93Lm5leHRFbGVtZW50U2libGluZyk7XG4gIH0gZWxzZSBpZiAocGFuZWwucHJldmlvdXNFbGVtZW50U2libGluZyAhPT0gcm93KSB7XG4gICAgaG9zdC5pbnNlcnRCZWZvcmUocGFuZWwsIHJvdy5uZXh0RWxlbWVudFNpYmxpbmcpO1xuICB9XG5cbiAgcmV0dXJuIHBhbmVsO1xufVxuXG5mdW5jdGlvbiByZW1vdmVTdW1tYXJ5UGFuZWwoKTogdm9pZCB7XG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoYFske1NVTU1BUllfQVRUUn1dYCk/LnJlbW92ZSgpO1xufVxuXG5mdW5jdGlvbiBjb3VudFN0YXR1cyhlbnRyaWVzOiBHaXRTdGF0dXNFbnRyeVtdKToge1xuICBzdGFnZWQ6IG51bWJlcjtcbiAgdW5zdGFnZWQ6IG51bWJlcjtcbiAgdW50cmFja2VkOiBudW1iZXI7XG4gIGNvbmZsaWN0czogbnVtYmVyO1xufSB7XG4gIGxldCBzdGFnZWQgPSAwO1xuICBsZXQgdW5zdGFnZWQgPSAwO1xuICBsZXQgdW50cmFja2VkID0gMDtcbiAgbGV0IGNvbmZsaWN0cyA9IDA7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgIHN3aXRjaCAoZW50cnkua2luZCkge1xuICAgICAgY2FzZSBcIm9yZGluYXJ5XCI6XG4gICAgICBjYXNlIFwicmVuYW1lXCI6XG4gICAgICAgIGlmIChlbnRyeS5pbmRleCAhPT0gXCIuXCIpIHN0YWdlZCsrO1xuICAgICAgICBpZiAoZW50cnkud29ya3RyZWUgIT09IFwiLlwiKSB1bnN0YWdlZCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ1bnRyYWNrZWRcIjpcbiAgICAgICAgdW50cmFja2VkKys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInVubWVyZ2VkXCI6XG4gICAgICAgIGNvbmZsaWN0cysrO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJpZ25vcmVkXCI6XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyBzdGFnZWQsIHVuc3RhZ2VkLCB1bnRyYWNrZWQsIGNvbmZsaWN0cyB9O1xufVxuXG5mdW5jdGlvbiBjb3VudERpcnR5KGVudHJpZXM6IEdpdFN0YXR1c0VudHJ5W10pOiBudW1iZXIge1xuICByZXR1cm4gZW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5raW5kICE9PSBcImlnbm9yZWRcIikubGVuZ3RoO1xufVxuXG5mdW5jdGlvbiBjb3VudENvbmZsaWN0cyhlbnRyaWVzOiBHaXRTdGF0dXNFbnRyeVtdKTogbnVtYmVyIHtcbiAgcmV0dXJuIGVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkua2luZCA9PT0gXCJ1bm1lcmdlZFwiKS5sZW5ndGg7XG59XG5cbmZ1bmN0aW9uIGJyYW5jaExhYmVsKHN0YXR1czogR2l0U3RhdHVzKTogc3RyaW5nIHtcbiAgcmV0dXJuIChcbiAgICBzdGF0dXMuYnJhbmNoLmhlYWQgPz9cbiAgICBzdGF0dXMucmVwb3NpdG9yeS5oZWFkQnJhbmNoID8/XG4gICAgc2hvcnRTaGEoc3RhdHVzLmJyYW5jaC5vaWQpID8/XG4gICAgc2hvcnRTaGEoc3RhdHVzLnJlcG9zaXRvcnkuaGVhZFNoYSkgPz9cbiAgICBcImRldGFjaGVkXCJcbiAgKTtcbn1cblxuZnVuY3Rpb24gc3luY0xhYmVsKHN0YXR1czogR2l0U3RhdHVzKTogeyBzaG9ydDogc3RyaW5nOyB0aXRsZTogc3RyaW5nIH0ge1xuICBjb25zdCBhaGVhZCA9IHN0YXR1cy5icmFuY2guYWhlYWQgPz8gMDtcbiAgY29uc3QgYmVoaW5kID0gc3RhdHVzLmJyYW5jaC5iZWhpbmQgPz8gMDtcbiAgY29uc3Qgc2hvcnQgPSBbYWhlYWQgPiAwID8gYEEke2FoZWFkfWAgOiBcIlwiLCBiZWhpbmQgPiAwID8gYEIke2JlaGluZH1gIDogXCJcIl1cbiAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgLmpvaW4oXCIvXCIpO1xuICBjb25zdCB0aXRsZSA9IFtcbiAgICBhaGVhZCA+IDAgPyBgJHthaGVhZH0gYWhlYWRgIDogXCJcIixcbiAgICBiZWhpbmQgPiAwID8gYCR7YmVoaW5kfSBiZWhpbmRgIDogXCJcIixcbiAgICBzdGF0dXMuYnJhbmNoLnVwc3RyZWFtID8gYHVwc3RyZWFtICR7c3RhdHVzLmJyYW5jaC51cHN0cmVhbX1gIDogXCJcIixcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiwgXCIpO1xuICByZXR1cm4geyBzaG9ydCwgdGl0bGUgfTtcbn1cblxuZnVuY3Rpb24gZW50cnlMYWJlbChlbnRyeTogR2l0U3RhdHVzRW50cnkpOiBzdHJpbmcge1xuICBzd2l0Y2ggKGVudHJ5LmtpbmQpIHtcbiAgICBjYXNlIFwib3JkaW5hcnlcIjpcbiAgICAgIHJldHVybiBgJHtlbnRyeS5pbmRleH0ke2VudHJ5Lndvcmt0cmVlfWAucmVwbGFjZUFsbChcIi5cIiwgXCJcIik7XG4gICAgY2FzZSBcInJlbmFtZVwiOlxuICAgICAgcmV0dXJuIFwiUlwiO1xuICAgIGNhc2UgXCJ1bm1lcmdlZFwiOlxuICAgICAgcmV0dXJuIFwiVVVcIjtcbiAgICBjYXNlIFwidW50cmFja2VkXCI6XG4gICAgICByZXR1cm4gXCI/P1wiO1xuICAgIGNhc2UgXCJpZ25vcmVkXCI6XG4gICAgICByZXR1cm4gXCIhIVwiO1xuICB9XG59XG5cbmZ1bmN0aW9uIGVudHJ5UGF0aChlbnRyeTogR2l0U3RhdHVzRW50cnkpOiBzdHJpbmcge1xuICBpZiAoZW50cnkua2luZCA9PT0gXCJyZW5hbWVcIikgcmV0dXJuIGAke2VudHJ5Lm9yaWdpbmFsUGF0aH0gLT4gJHtlbnRyeS5wYXRofWA7XG4gIHJldHVybiBlbnRyeS5wYXRoO1xufVxuXG5mdW5jdGlvbiBtZXRyaWMobGFiZWw6IHN0cmluZywgdmFsdWU6IG51bWJlcik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgaXRlbSA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtbWV0cmljXCIpO1xuICBpdGVtLmFwcGVuZCh0ZXh0RWwoXCJzcGFuXCIsIFN0cmluZyh2YWx1ZSkpLCB0ZXh0RWwoXCJzcGFuXCIsIGxhYmVsKSk7XG4gIHJldHVybiBpdGVtO1xufVxuXG5mdW5jdGlvbiBzaG9ydFNoYShzaGE6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIHNoYSA/IHNoYS5zbGljZSgwLCA3KSA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGJhc2VuYW1lKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBwYXRoLnJlcGxhY2UoL1xcLyskLywgXCJcIik7XG4gIGNvbnN0IGlkeCA9IHRyaW1tZWQubGFzdEluZGV4T2YoXCIvXCIpO1xuICByZXR1cm4gaWR4ID49IDAgPyB0cmltbWVkLnNsaWNlKGlkeCArIDEpIDogdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gcGx1cmFsKGNvdW50OiBudW1iZXIpOiBzdHJpbmcge1xuICByZXR1cm4gY291bnQgPT09IDEgPyBcIlwiIDogXCJzXCI7XG59XG5cbmZ1bmN0aW9uIGNsZWFyKG5vZGU6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHdoaWxlIChub2RlLmZpcnN0Q2hpbGQpIG5vZGUuZmlyc3RDaGlsZC5yZW1vdmUoKTtcbn1cblxuZnVuY3Rpb24gZWwodGFnOiBcImRpdlwiIHwgXCJzZWN0aW9uXCIsIGNsYXNzTmFtZTogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBub2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICBub2RlLmNsYXNzTmFtZSA9IGNsYXNzTmFtZTtcbiAgcmV0dXJuIG5vZGU7XG59XG5cbmZ1bmN0aW9uIHRleHRFbCh0YWc6IFwiZGl2XCIgfCBcInNwYW5cIiB8IFwic3Ryb25nXCIsIHRleHQ6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQodGFnKTtcbiAgbm9kZS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBub2RlO1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsU3R5bGVzKCk6IHZvaWQge1xuICBpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoU1RZTEVfSUQpKSByZXR1cm47XG4gIGNvbnN0IHN0eWxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN0eWxlXCIpO1xuICBzdHlsZS5pZCA9IFNUWUxFX0lEO1xuICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiAgICAuY29kZXhwcC1naXQtcHJvamVjdC1iYWRnZSB7XG4gICAgICBhbGlnbi1pdGVtczogY2VudGVyO1xuICAgICAgYm9yZGVyOiAxcHggc29saWQgY29sb3ItbWl4KGluIHNyZ2IsIGN1cnJlbnRDb2xvciAxOCUsIHRyYW5zcGFyZW50KTtcbiAgICAgIGJvcmRlci1yYWRpdXM6IDVweDtcbiAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LXRlcnRpYXJ5LCBjdXJyZW50Q29sb3IpO1xuICAgICAgZGlzcGxheTogaW5saW5lLWZsZXg7XG4gICAgICBmbGV4OiAwIDEgYXV0bztcbiAgICAgIGZvbnQ6IDUwMCAxMHB4LzEuMiB1aS1tb25vc3BhY2UsIFNGTW9uby1SZWd1bGFyLCBNZW5sbywgQ29uc29sYXMsIG1vbm9zcGFjZTtcbiAgICAgIGdhcDogM3B4O1xuICAgICAgbGV0dGVyLXNwYWNpbmc6IDA7XG4gICAgICBtYXJnaW4tbGVmdDogNnB4O1xuICAgICAgbWF4LXdpZHRoOiA0OCU7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgICBvcGFjaXR5OiAwLjcyO1xuICAgICAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgICAgIHBhZGRpbmc6IDJweCA0cHg7XG4gICAgICBwb2ludGVyLWV2ZW50czogbm9uZTtcbiAgICAgIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXByb2plY3QtYmFkZ2UuY29kZXhwcC1naXQtYmFkZ2UtZGlydHkge1xuICAgICAgYm9yZGVyLWNvbG9yOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tY29kZXhwcC1wcm9qZWN0LXRpbnQsIGN1cnJlbnRDb2xvcikgNDIlLCB0cmFuc3BhcmVudCk7XG4gICAgICBjb2xvcjogdmFyKC0tY29kZXhwcC1wcm9qZWN0LXRleHQtY29sb3IsIGN1cnJlbnRDb2xvcik7XG4gICAgICBvcGFjaXR5OiAwLjk0O1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtcHJvamVjdC1iYWRnZS5jb2RleHBwLWdpdC1iYWRnZS1jb25mbGljdCB7XG4gICAgICBib3JkZXItY29sb3I6IHJnYmEoMjIwLCAzOCwgMzgsIDAuNjUpO1xuICAgICAgY29sb3I6IHJnYigyMjAsIDM4LCAzOCk7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5IHtcbiAgICAgIGJvcmRlci1sZWZ0OiAycHggc29saWQgdmFyKC0tY29kZXhwcC1wcm9qZWN0LXRpbnQsIGNvbG9yLW1peChpbiBzcmdiLCBjdXJyZW50Q29sb3IgNDAlLCB0cmFuc3BhcmVudCkpO1xuICAgICAgYm94LXNpemluZzogYm9yZGVyLWJveDtcbiAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LXByaW1hcnksIGN1cnJlbnRDb2xvcik7XG4gICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgICAgIGdhcDogNnB4O1xuICAgICAgbWFyZ2luOiAxcHggOHB4IDdweCAxOHB4O1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgICAgcGFkZGluZzogN3B4IDhweCA4cHggOHB4O1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1oZWFkZXIsXG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktbGluZSxcbiAgICAuY29kZXhwcC1naXQtZmlsZS1yb3csXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvdyB7XG4gICAgICBhbGlnbi1pdGVtczogY2VudGVyO1xuICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgIGdhcDogNnB4O1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1oZWFkZXIge1xuICAgICAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS10aXRsZSB7XG4gICAgICBhbGlnbi1pdGVtczogY2VudGVyO1xuICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgIGdhcDogNXB4O1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS10aXRsZSBzcGFuOmZpcnN0LWNoaWxkLFxuICAgIC5jb2RleHBwLWdpdC13b3JrdHJlZXMtbGFiZWwge1xuICAgICAgY29sb3I6IHZhcigtLXRleHQtdGVydGlhcnksIGN1cnJlbnRDb2xvcik7XG4gICAgICBmb250OiA2MDAgMTBweC8xLjIgc3lzdGVtLXVpLCAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIHNhbnMtc2VyaWY7XG4gICAgICBvcGFjaXR5OiAwLjc7XG4gICAgICB0ZXh0LXRyYW5zZm9ybTogdXBwZXJjYXNlO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS10aXRsZSBzdHJvbmcge1xuICAgICAgZm9udDogNjAwIDEycHgvMS4yNSB1aS1tb25vc3BhY2UsIFNGTW9uby1SZWd1bGFyLCBNZW5sbywgQ29uc29sYXMsIG1vbm9zcGFjZTtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICAgIG92ZXJmbG93OiBoaWRkZW47XG4gICAgICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgICAgIHdoaXRlLXNwYWNlOiBub3dyYXA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXN0YXRlIHtcbiAgICAgIGJvcmRlci1yYWRpdXM6IDVweDtcbiAgICAgIGZsZXg6IDAgMCBhdXRvO1xuICAgICAgZm9udDogNjAwIDEwcHgvMS4yIHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmO1xuICAgICAgcGFkZGluZzogMnB4IDVweDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktc3RhdGUuaXMtY2xlYW4ge1xuICAgICAgYmFja2dyb3VuZDogcmdiYSgzNCwgMTk3LCA5NCwgMC4xMik7XG4gICAgICBjb2xvcjogcmdiKDIyLCAxNjMsIDc0KTtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktc3RhdGUuaXMtZGlydHkge1xuICAgICAgYmFja2dyb3VuZDogcmdiYSgyNDUsIDE1OCwgMTEsIDAuMTIpO1xuICAgICAgY29sb3I6IHJnYigxODAsIDgzLCA5KTtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktbWV0cmljcyB7XG4gICAgICBkaXNwbGF5OiBncmlkO1xuICAgICAgZ2FwOiA0cHg7XG4gICAgICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCg0LCBtaW5tYXgoMCwgMWZyKSk7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1tZXRyaWMge1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtbWV0cmljIHNwYW46Zmlyc3QtY2hpbGQge1xuICAgICAgZGlzcGxheTogYmxvY2s7XG4gICAgICBmb250OiA2MDAgMTJweC8xLjE1IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtbWV0cmljIHNwYW46bGFzdC1jaGlsZCxcbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1saW5lLFxuICAgIC5jb2RleHBwLWdpdC1tb3JlLFxuICAgIC5jb2RleHBwLWdpdC13YXJuaW5nIHtcbiAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LXRlcnRpYXJ5LCBjdXJyZW50Q29sb3IpO1xuICAgICAgZm9udDogNTAwIDEwcHgvMS4yNSBzeXN0ZW0tdWksIC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgc2Fucy1zZXJpZjtcbiAgICAgIG9wYWNpdHk6IDAuNzQ7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1jaGFuZ2VkLWZpbGVzLFxuICAgIC5jb2RleHBwLWdpdC13b3JrdHJlZXMge1xuICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG4gICAgICBnYXA6IDNweDtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LWZpbGUtcm93LFxuICAgIC5jb2RleHBwLWdpdC13b3JrdHJlZS1yb3cge1xuICAgICAgY29sb3I6IHZhcigtLXRleHQtc2Vjb25kYXJ5LCBjdXJyZW50Q29sb3IpO1xuICAgICAgZm9udDogNTAwIDExcHgvMS4yNSBzeXN0ZW0tdWksIC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgc2Fucy1zZXJpZjtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LWZpbGUtcm93IHNwYW46Zmlyc3QtY2hpbGQge1xuICAgICAgY29sb3I6IHZhcigtLWNvZGV4cHAtcHJvamVjdC10ZXh0LWNvbG9yLCBjdXJyZW50Q29sb3IpO1xuICAgICAgZmxleDogMCAwIDI0cHg7XG4gICAgICBmb250OiA2MDAgMTBweC8xLjIgdWktbW9ub3NwYWNlLCBTRk1vbm8tUmVndWxhciwgTWVubG8sIENvbnNvbGFzLCBtb25vc3BhY2U7XG4gICAgICBvcGFjaXR5OiAwLjg4O1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtZmlsZS1yb3cgc3BhbjpsYXN0LWNoaWxkLFxuICAgIC5jb2RleHBwLWdpdC13b3JrdHJlZS1yb3cgc3BhbjpsYXN0LWNoaWxkIHtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICAgIG92ZXJmbG93OiBoaWRkZW47XG4gICAgICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgICAgIHdoaXRlLXNwYWNlOiBub3dyYXA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC13b3JrdHJlZS1yb3cge1xuICAgICAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtd29ya3RyZWUtcm93IHNwYW46Zmlyc3QtY2hpbGQge1xuICAgICAgZm9udDogNTAwIDEwcHgvMS4yNSB1aS1tb25vc3BhY2UsIFNGTW9uby1SZWd1bGFyLCBNZW5sbywgQ29uc29sYXMsIG1vbm9zcGFjZTtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICAgIG92ZXJmbG93OiBoaWRkZW47XG4gICAgICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgICAgIHdoaXRlLXNwYWNlOiBub3dyYXA7XG4gICAgfVxuICBgO1xuICBkb2N1bWVudC5oZWFkLmFwcGVuZENoaWxkKHN0eWxlKTtcbn1cbiJd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QTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBb01wQixTQUFPLFlBQVksS0FBSztBQUMxQjtBQUVBLFNBQVMsbUJBQW1CLE9BQXFDO0FBQy9ELFFBQU0sT0FBTyxPQUFPLE1BQU0saUJBQWlCLGFBQWEsTUFBTSxhQUFhLElBQUksQ0FBQztBQUNo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QVc7QUFDckMsYUFBUyxpQkFBaUIsb0JBQW9CLE1BQU0sRUFBRSxNQUFNLEtBQUssQ0FBQztBQUFBLEVBQ3BFLE9BQU87QUFDTCxTQUFLO0FBQUEsRUFDUDtBQUNGLENBQUM7QUFFRCxlQUFlLE9BQU87QUFDcEIsVUFBUSxjQUFjLEVBQUUsWUFBWSxTQUFTLFdBQVcsQ0FBQztBQUN6RCxNQUFJO0FBQ0YsMEJBQXNCO0FBQ3RCLFlBQVEsMkJBQTJCO0FBQ25DLG9CQUFnQjtBQUNoQixZQUFRLHFCQUFxQjtBQUM3QixVQUFNLGVBQWU7QUFDckIsWUFBUSxvQkFBb0I7QUFDNUIsVUFBTSxhQUFhO0FBQ25CLFlBQVEsaUJBQWlCO0FBQ3pCLG9CQUFnQjtBQUNoQixZQUFRLGVBQWU7QUFBQSxFQUN6QixTQUFTLEdBQUc7QUFDVixZQUFRLGVBQWUsT0FBUSxHQUFhLFNBQVMsQ0FBQyxDQUFDO0FBQ3ZELFlBQVEsTUFBTSx5Q0FBeUMsQ0FBQztBQUFBLEVBQzFEO0FBQ0Y7QUFJQSxJQUFJLFlBQWtDO0FBQ3RDLFNBQVMsa0JBQXdCO0FBQy9CLCtCQUFZLEdBQUcsMEJBQTBCLE1BQU07QUFDN0MsUUFBSSxVQUFXO0FBQ2YsaUJBQWEsWUFBWTtBQUN2QixVQUFJO0FBQ0YsZ0JBQVEsS0FBSyx1Q0FBdUM7QUFDcEQsMEJBQWtCO0FBQ2xCLGNBQU0sZUFBZTtBQUNyQixjQUFNLGFBQWE7QUFBQSxNQUNyQixTQUFTLEdBQUc7QUFDVixnQkFBUSxNQUFNLHVDQUF1QyxDQUFDO0FBQUEsTUFDeEQsVUFBRTtBQUNBLG9CQUFZO0FBQUEsTUFDZDtBQUFBLElBQ0YsR0FBRztBQUFBLEVBQ0wsQ0FBQztBQUNIOyIsCiAgIm5hbWVzIjogWyJpbXBvcnRfZWxlY3Ryb24iLCAicm9vdCIsICJyZWZyZXNoIiwgImNhcmQiLCAiZWwiLCAiaW1wb3J0X2VsZWN0cm9uIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImVsIiwgImltcG9ydF9lbGVjdHJvbiIsICJyb290IiwgImltcG9ydF9lbGVjdHJvbiIsICJpc1JlY29yZCIsICJyZXNwb25zZSIsICJlbCIsICJidXR0b24iLCAiaW1wb3J0X2VsZWN0cm9uIiwgInN0YXRlIiwgImluc3RhbGxTdHlsZXMiLCAic3RhdHVzIiwgInNhZmVTdHJpbmdpZnkiXQp9Cg==
