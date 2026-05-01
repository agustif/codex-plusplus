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
  const tweaksBtn = makeSidebarItem("Tweaks", tweaksIconSvg());
  configBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activatePage({ kind: "config" });
  });
  tweaksBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    activatePage({ kind: "tweaks" });
  });
  group.appendChild(configBtn);
  group.appendChild(tweaksBtn);
  outer.appendChild(group);
  state.navGroup = group;
  state.navButtons = { config: configBtn, tweaks: tweaksBtn };
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
    const builtin = active?.kind === "config" ? "config" : active?.kind === "tweaks" ? "tweaks" : null;
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
var GOAL_PANEL_STATE_KEY = "codexpp:goal-panel-state";
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
function resetGoalPanelPosition(event) {
  if (event.target instanceof Element && event.target.closest("button")) return;
  panelState = { ...panelState, x: null, y: null };
  saveGoalPanelState();
  if (root) applyGoalPanelPosition(root);
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
    x: clamp(panelState.x, 8, window.innerWidth - rect.width - 8),
    y: clamp(panelState.y, 8, window.innerHeight - rect.height - 8)
  };
}
function readGoalPanelState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GOAL_PANEL_STATE_KEY) ?? "{}");
    return {
      collapsed: parsed.collapsed === true,
      x: typeof parsed.x === "number" && Number.isFinite(parsed.x) ? parsed.x : null,
      y: typeof parsed.y === "number" && Number.isFinite(parsed.y) ? parsed.y : null
    };
  } catch {
    return { collapsed: false, x: null, y: null };
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
  border: 1px solid rgba(255,255,255,0.16);
  border-radius: 8px;
  background: rgba(26, 29, 35, 0.96);
  box-shadow: 0 18px 60px rgba(0,0,0,0.34);
  padding: 12px;
  backdrop-filter: blur(14px);
}
.codexpp-goal-panel.is-dragging {
  cursor: grabbing;
  user-select: none;
}
.codexpp-goal-panel.is-collapsed {
  width: min(320px, calc(100vw - 36px));
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
  max-height: 96px;
  overflow: auto;
  color: rgba(245,247,251,0.9);
  word-break: break-word;
}
.codexpp-goal-footer {
  margin-top: 8px;
  color: rgba(245,247,251,0.62);
  font-size: 12px;
}
.codexpp-goal-actions {
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL21hbmFnZXIudHMiLCAiLi4vc3JjL3ByZWxvYWQvYXBwLXNlcnZlci1icmlkZ2UudHMiLCAiLi4vc3JjL3ByZWxvYWQvZ29hbC1mZWF0dXJlLnRzIiwgIi4uL3NyYy9wcmVsb2FkL2dpdC1zaWRlYmFyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlbmRlcmVyIHByZWxvYWQgZW50cnkuIFJ1bnMgaW4gYW4gaXNvbGF0ZWQgd29ybGQgYmVmb3JlIENvZGV4J3MgcGFnZSBKUy5cbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAgIDEuIEluc3RhbGwgYSBSZWFjdCBEZXZUb29scy1zaGFwZWQgZ2xvYmFsIGhvb2sgdG8gY2FwdHVyZSB0aGUgcmVuZGVyZXJcbiAqICAgICAgcmVmZXJlbmNlIHdoZW4gUmVhY3QgbW91bnRzLiBXZSB1c2UgdGhpcyBmb3IgZmliZXIgd2Fsa2luZy5cbiAqICAgMi4gQWZ0ZXIgRE9NQ29udGVudExvYWRlZCwga2ljayBvZmYgc2V0dGluZ3MtaW5qZWN0aW9uIGxvZ2ljLlxuICogICAzLiBEaXNjb3ZlciByZW5kZXJlci1zY29wZWQgdHdlYWtzICh2aWEgSVBDIHRvIG1haW4pIGFuZCBzdGFydCB0aGVtLlxuICogICA0LiBMaXN0ZW4gZm9yIGBjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkYCBmcm9tIG1haW4gKGZpbGVzeXN0ZW0gd2F0Y2hlcikgYW5kXG4gKiAgICAgIGhvdC1yZWxvYWQgdHdlYWtzIHdpdGhvdXQgZHJvcHBpbmcgdGhlIHBhZ2UuXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IGluc3RhbGxSZWFjdEhvb2sgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgeyBzdGFydFNldHRpbmdzSW5qZWN0b3IgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgc3RhcnRUd2Vha0hvc3QsIHRlYXJkb3duVHdlYWtIb3N0IH0gZnJvbSBcIi4vdHdlYWstaG9zdFwiO1xuaW1wb3J0IHsgbW91bnRNYW5hZ2VyIH0gZnJvbSBcIi4vbWFuYWdlclwiO1xuaW1wb3J0IHsgc3RhcnRHb2FsRmVhdHVyZSB9IGZyb20gXCIuL2dvYWwtZmVhdHVyZVwiO1xuaW1wb3J0IHsgc3RhcnRHaXRTaWRlYmFyIH0gZnJvbSBcIi4vZ2l0LXNpZGViYXJcIjtcblxuLy8gRmlsZS1sb2cgcHJlbG9hZCBwcm9ncmVzcyBzbyB3ZSBjYW4gZGlhZ25vc2Ugd2l0aG91dCBEZXZUb29scy4gQmVzdC1lZmZvcnQ6XG4vLyBmYWlsdXJlcyBoZXJlIG11c3QgbmV2ZXIgdGhyb3cgYmVjYXVzZSB3ZSdkIHRha2UgdGhlIHBhZ2UgZG93biB3aXRoIHVzLlxuLy9cbi8vIENvZGV4J3MgcmVuZGVyZXIgaXMgc2FuZGJveGVkIChzYW5kYm94OiB0cnVlKSwgc28gYHJlcXVpcmUoXCJub2RlOmZzXCIpYCBpc1xuLy8gdW5hdmFpbGFibGUuIFdlIGZvcndhcmQgbG9nIGxpbmVzIHRvIG1haW4gdmlhIElQQzsgbWFpbiB3cml0ZXMgdGhlIGZpbGUuXG5mdW5jdGlvbiBmaWxlTG9nKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBgW2NvZGV4LXBsdXNwbHVzIHByZWxvYWRdICR7c3RhZ2V9JHtcbiAgICBleHRyYSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IFwiIFwiICsgc2FmZVN0cmluZ2lmeShleHRyYSlcbiAgfWA7XG4gIHRyeSB7XG4gICAgY29uc29sZS5lcnJvcihtc2cpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChcImNvZGV4cHA6cHJlbG9hZC1sb2dcIiwgXCJpbmZvXCIsIG1zZyk7XG4gIH0gY2F0Y2gge31cbn1cbmZ1bmN0aW9uIHNhZmVTdHJpbmdpZnkodjogdW5rbm93bik6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gU3RyaW5nKHYpO1xuICB9XG59XG5cbmZpbGVMb2coXCJwcmVsb2FkIGVudHJ5XCIsIHsgdXJsOiBsb2NhdGlvbi5ocmVmIH0pO1xuXG4vLyBSZWFjdCBob29rIG11c3QgYmUgaW5zdGFsbGVkICpiZWZvcmUqIENvZGV4J3MgYnVuZGxlIHJ1bnMuXG50cnkge1xuICBpbnN0YWxsUmVhY3RIb29rKCk7XG4gIGZpbGVMb2coXCJyZWFjdCBob29rIGluc3RhbGxlZFwiKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnRyeSB7XG4gIHN0YXJ0R29hbEZlYXR1cmUoZmlsZUxvZyk7XG59IGNhdGNoIChlKSB7XG4gIGZpbGVMb2coXCJnb2FsIGZlYXR1cmUgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnF1ZXVlTWljcm90YXNrKCgpID0+IHtcbiAgaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09IFwibG9hZGluZ1wiKSB7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgYm9vdCwgeyBvbmNlOiB0cnVlIH0pO1xuICB9IGVsc2Uge1xuICAgIGJvb3QoKTtcbiAgfVxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7XG4gIGZpbGVMb2coXCJib290IHN0YXJ0XCIsIHsgcmVhZHlTdGF0ZTogZG9jdW1lbnQucmVhZHlTdGF0ZSB9KTtcbiAgdHJ5IHtcbiAgICBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTtcbiAgICBmaWxlTG9nKFwic2V0dGluZ3MgaW5qZWN0b3Igc3RhcnRlZFwiKTtcbiAgICBzdGFydEdpdFNpZGViYXIoKTtcbiAgICBmaWxlTG9nKFwiZ2l0IHNpZGViYXIgc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgIGZpbGVMb2coXCJ0d2VhayBob3N0IHN0YXJ0ZWRcIik7XG4gICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgZmlsZUxvZyhcIm1hbmFnZXIgbW91bnRlZFwiKTtcbiAgICBzdWJzY3JpYmVSZWxvYWQoKTtcbiAgICBmaWxlTG9nKFwiYm9vdCBjb21wbGV0ZVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZpbGVMb2coXCJib290IEZBSUxFRFwiLCBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSk7XG4gICAgY29uc29sZS5lcnJvcihcIltjb2RleC1wbHVzcGx1c10gcHJlbG9hZCBib290IGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gSG90IHJlbG9hZDogZ2F0ZWQgYmVoaW5kIGEgc21hbGwgaW4tZmxpZ2h0IGxvY2sgc28gYSBmbHVycnkgb2YgZnMgZXZlbnRzXG4vLyBkb2Vzbid0IHJlZW50cmFudGx5IHRlYXIgZG93biB0aGUgaG9zdCBtaWQtbG9hZC5cbmxldCByZWxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcbmZ1bmN0aW9uIHN1YnNjcmliZVJlbG9hZCgpOiB2b2lkIHtcbiAgaXBjUmVuZGVyZXIub24oXCJjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBpZiAocmVsb2FkaW5nKSByZXR1cm47XG4gICAgcmVsb2FkaW5nID0gKGFzeW5jICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUuaW5mbyhcIltjb2RleC1wbHVzcGx1c10gaG90LXJlbG9hZGluZyB0d2Vha3NcIik7XG4gICAgICAgIHRlYXJkb3duVHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IHN0YXJ0VHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IG1vdW50TWFuYWdlcigpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWxvYWRpbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gIH0pO1xufVxuIiwgIi8qKlxuICogSW5zdGFsbCBhIG1pbmltYWwgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fLiBSZWFjdCBjYWxsc1xuICogYGhvb2suaW5qZWN0KHJlbmRlcmVySW50ZXJuYWxzKWAgZHVyaW5nIGBjcmVhdGVSb290YC9gaHlkcmF0ZVJvb3RgLiBUaGVcbiAqIFwiaW50ZXJuYWxzXCIgb2JqZWN0IGV4cG9zZXMgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2UsIHdoaWNoIGxldHMgdXMgdHVybiBhXG4gKiBET00gbm9kZSBpbnRvIGEgUmVhY3QgZmliZXIgXHUyMDE0IG5lY2Vzc2FyeSBmb3Igb3VyIFNldHRpbmdzIGluamVjdG9yLlxuICpcbiAqIFdlIGRvbid0IHdhbnQgdG8gYnJlYWsgcmVhbCBSZWFjdCBEZXZUb29scyBpZiB0aGUgdXNlciBvcGVucyBpdDsgd2UgaW5zdGFsbFxuICogb25seSBpZiBubyBob29rIGV4aXN0cyB5ZXQsIGFuZCB3ZSBmb3J3YXJkIGNhbGxzIHRvIGEgZG93bnN0cmVhbSBob29rIGlmXG4gKiBvbmUgaXMgbGF0ZXIgYXNzaWduZWQuXG4gKi9cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fPzogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgX19jb2RleHBwX18/OiB7XG4gICAgICBob29rOiBSZWFjdERldnRvb2xzSG9vaztcbiAgICAgIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICAgIH07XG4gIH1cbn1cblxuaW50ZXJmYWNlIFJlbmRlcmVySW50ZXJuYWxzIHtcbiAgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2U/OiAobjogTm9kZSkgPT4gdW5rbm93bjtcbiAgdmVyc2lvbj86IHN0cmluZztcbiAgYnVuZGxlVHlwZT86IG51bWJlcjtcbiAgcmVuZGVyZXJQYWNrYWdlTmFtZT86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlYWN0RGV2dG9vbHNIb29rIHtcbiAgc3VwcG9ydHNGaWJlcjogdHJ1ZTtcbiAgcmVuZGVyZXJzOiBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz47XG4gIG9uKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgb2ZmKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgZW1pdChldmVudDogc3RyaW5nLCAuLi5hOiB1bmtub3duW10pOiB2b2lkO1xuICBpbmplY3QocmVuZGVyZXI6IFJlbmRlcmVySW50ZXJuYWxzKTogbnVtYmVyO1xuICBvblNjaGVkdWxlRmliZXJSb290PygpOiB2b2lkO1xuICBvbkNvbW1pdEZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclVubW91bnQ/KCk6IHZvaWQ7XG4gIGNoZWNrRENFPygpOiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFJlYWN0SG9vaygpOiB2b2lkIHtcbiAgaWYgKHdpbmRvdy5fX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18pIHJldHVybjtcbiAgY29uc3QgcmVuZGVyZXJzID0gbmV3IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPigpO1xuICBsZXQgbmV4dElkID0gMTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsIFNldDwoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkPj4oKTtcblxuICBjb25zdCBob29rOiBSZWFjdERldnRvb2xzSG9vayA9IHtcbiAgICBzdXBwb3J0c0ZpYmVyOiB0cnVlLFxuICAgIHJlbmRlcmVycyxcbiAgICBpbmplY3QocmVuZGVyZXIpIHtcbiAgICAgIGNvbnN0IGlkID0gbmV4dElkKys7XG4gICAgICByZW5kZXJlcnMuc2V0KGlkLCByZW5kZXJlcik7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS5kZWJ1ZyhcbiAgICAgICAgXCJbY29kZXgtcGx1c3BsdXNdIFJlYWN0IHJlbmRlcmVyIGF0dGFjaGVkOlwiLFxuICAgICAgICByZW5kZXJlci5yZW5kZXJlclBhY2thZ2VOYW1lLFxuICAgICAgICByZW5kZXJlci52ZXJzaW9uLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBpZDtcbiAgICB9LFxuICAgIG9uKGV2ZW50LCBmbikge1xuICAgICAgbGV0IHMgPSBsaXN0ZW5lcnMuZ2V0KGV2ZW50KTtcbiAgICAgIGlmICghcykgbGlzdGVuZXJzLnNldChldmVudCwgKHMgPSBuZXcgU2V0KCkpKTtcbiAgICAgIHMuYWRkKGZuKTtcbiAgICB9LFxuICAgIG9mZihldmVudCwgZm4pIHtcbiAgICAgIGxpc3RlbmVycy5nZXQoZXZlbnQpPy5kZWxldGUoZm4pO1xuICAgIH0sXG4gICAgZW1pdChldmVudCwgLi4uYXJncykge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmZvckVhY2goKGZuKSA9PiBmbiguLi5hcmdzKSk7XG4gICAgfSxcbiAgICBvbkNvbW1pdEZpYmVyUm9vdCgpIHt9LFxuICAgIG9uQ29tbWl0RmliZXJVbm1vdW50KCkge30sXG4gICAgb25TY2hlZHVsZUZpYmVyUm9vdCgpIHt9LFxuICAgIGNoZWNrRENFKCkge30sXG4gIH07XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX19cIiwge1xuICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICB3cml0YWJsZTogdHJ1ZSwgLy8gYWxsb3cgcmVhbCBEZXZUb29scyB0byBvdmVyd3JpdGUgaWYgdXNlciBpbnN0YWxscyBpdFxuICAgIHZhbHVlOiBob29rLFxuICB9KTtcblxuICB3aW5kb3cuX19jb2RleHBwX18gPSB7IGhvb2ssIHJlbmRlcmVycyB9O1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgUmVhY3QgZmliZXIgZm9yIGEgRE9NIG5vZGUsIGlmIGFueSByZW5kZXJlciBoYXMgb25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpYmVyRm9yTm9kZShub2RlOiBOb2RlKTogdW5rbm93biB8IG51bGwge1xuICBjb25zdCByZW5kZXJlcnMgPSB3aW5kb3cuX19jb2RleHBwX18/LnJlbmRlcmVycztcbiAgaWYgKHJlbmRlcmVycykge1xuICAgIGZvciAoY29uc3QgciBvZiByZW5kZXJlcnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGYgPSByLmZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPy4obm9kZSk7XG4gICAgICBpZiAoZikgcmV0dXJuIGY7XG4gICAgfVxuICB9XG4gIC8vIEZhbGxiYWNrOiByZWFkIHRoZSBSZWFjdCBpbnRlcm5hbCBwcm9wZXJ0eSBkaXJlY3RseSBmcm9tIHRoZSBET00gbm9kZS5cbiAgLy8gUmVhY3Qgc3RvcmVzIGZpYmVycyBhcyBhIHByb3BlcnR5IHdob3NlIGtleSBzdGFydHMgd2l0aCBcIl9fcmVhY3RGaWJlclwiLlxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICBpZiAoay5zdGFydHNXaXRoKFwiX19yZWFjdEZpYmVyXCIpKSByZXR1cm4gKG5vZGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba107XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG4iLCAiLyoqXG4gKiBTZXR0aW5ncyBpbmplY3RvciBmb3IgQ29kZXgncyBTZXR0aW5ncyBwYWdlLlxuICpcbiAqIENvZGV4J3Mgc2V0dGluZ3MgaXMgYSByb3V0ZWQgcGFnZSAoVVJMIHN0YXlzIGF0IGAvaW5kZXguaHRtbD9ob3N0SWQ9bG9jYWxgKVxuICogTk9UIGEgbW9kYWwgZGlhbG9nLiBUaGUgc2lkZWJhciBsaXZlcyBpbnNpZGUgYSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC0xIGdhcC0wXCI+YCB3cmFwcGVyIHRoYXQgaG9sZHMgb25lIG9yIG1vcmUgYDxkaXYgY2xhc3M9XCJmbGV4IGZsZXgtY29sXG4gKiBnYXAtcHhcIj5gIGdyb3VwcyBvZiBidXR0b25zLiBUaGVyZSBhcmUgbm8gc3RhYmxlIGByb2xlYCAvIGBhcmlhLWxhYmVsYCAvXG4gKiBgZGF0YS10ZXN0aWRgIGhvb2tzIG9uIHRoZSBzaGVsbCBzbyB3ZSBpZGVudGlmeSB0aGUgc2lkZWJhciBieSB0ZXh0LWNvbnRlbnRcbiAqIG1hdGNoIGFnYWluc3Qga25vd24gaXRlbSBsYWJlbHMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIENvbmZpZ3VyYXRpb24sIFx1MjAyNikuXG4gKlxuICogTGF5b3V0IHdlIGluamVjdDpcbiAqXG4gKiAgIEdFTkVSQUwgICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFtDb2RleCdzIGV4aXN0aW5nIGl0ZW1zIGdyb3VwXVxuICogICBDT0RFWCsrICAgICAgICAgICAgICAgICAgICAgICAodXBwZXJjYXNlIGdyb3VwIGxhYmVsKVxuICogICBcdTI0RDggQ29uZmlnXG4gKiAgIFx1MjYzMCBUd2Vha3NcbiAqXG4gKiBDbGlja2luZyBDb25maWcgLyBUd2Vha3MgaGlkZXMgQ29kZXgncyBjb250ZW50IHBhbmVsIGNoaWxkcmVuIGFuZCByZW5kZXJzXG4gKiBvdXIgb3duIGBtYWluLXN1cmZhY2VgIHBhbmVsIGluIHRoZWlyIHBsYWNlLiBDbGlja2luZyBhbnkgb2YgQ29kZXgnc1xuICogc2lkZWJhciBpdGVtcyByZXN0b3JlcyB0aGUgb3JpZ2luYWwgdmlldy5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHR5cGUge1xuICBTZXR0aW5nc1NlY3Rpb24sXG4gIFNldHRpbmdzUGFnZSxcbiAgU2V0dGluZ3NIYW5kbGUsXG4gIFR3ZWFrTWFuaWZlc3QsXG59IGZyb20gXCJAY29kZXgtcGx1c3BsdXMvc2RrXCI7XG5cbi8vIE1pcnJvcnMgdGhlIHJ1bnRpbWUncyBtYWluLXNpZGUgTGlzdGVkVHdlYWsgc2hhcGUgKGtlcHQgaW4gc3luYyBtYW51YWxseSkuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICB1cGRhdGU6IFR3ZWFrVXBkYXRlQ2hlY2sgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtVcGRhdGVDaGVjayB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICByZXBvOiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdFRhZzogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvZGV4UGx1c1BsdXNDb25maWcge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGF1dG9VcGRhdGU6IGJvb2xlYW47XG4gIHVwZGF0ZUNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VOb3Rlczogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvZGV4Q2RwU3RhdHVzIHtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgYWN0aXZlOiBib29sZWFuO1xuICBjb25maWd1cmVkUG9ydDogbnVtYmVyO1xuICBhY3RpdmVQb3J0OiBudW1iZXIgfCBudWxsO1xuICByZXN0YXJ0UmVxdWlyZWQ6IGJvb2xlYW47XG4gIHNvdXJjZTogXCJhcmd2XCIgfCBcImVudlwiIHwgXCJjb25maWdcIiB8IFwib2ZmXCI7XG4gIGpzb25MaXN0VXJsOiBzdHJpbmcgfCBudWxsO1xuICBqc29uVmVyc2lvblVybDogc3RyaW5nIHwgbnVsbDtcbiAgbGF1bmNoQ29tbWFuZDogc3RyaW5nO1xuICBhcHBSb290OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgV2F0Y2hlckhlYWx0aCB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHdhdGNoZXI6IHN0cmluZztcbiAgY2hlY2tzOiBXYXRjaGVySGVhbHRoQ2hlY2tbXTtcbn1cblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGhDaGVjayB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQSB0d2Vhay1yZWdpc3RlcmVkIHBhZ2UuIFdlIGNhcnJ5IHRoZSBvd25pbmcgdHdlYWsncyBtYW5pZmVzdCBzbyB3ZSBjYW5cbiAqIHJlc29sdmUgcmVsYXRpdmUgaWNvblVybHMgYW5kIHNob3cgYXV0aG9yc2hpcCBpbiB0aGUgcGFnZSBoZWFkZXIuXG4gKi9cbmludGVyZmFjZSBSZWdpc3RlcmVkUGFnZSB7XG4gIC8qKiBGdWxseS1xdWFsaWZpZWQgaWQ6IGA8dHdlYWtJZD46PHBhZ2VJZD5gLiAqL1xuICBpZDogc3RyaW5nO1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBwYWdlOiBTZXR0aW5nc1BhZ2U7XG4gIC8qKiBQZXItcGFnZSBET00gdGVhcmRvd24gcmV0dXJuZWQgYnkgYHBhZ2UucmVuZGVyYCwgaWYgYW55LiAqL1xuICB0ZWFyZG93bj86ICgoKSA9PiB2b2lkKSB8IG51bGw7XG4gIC8qKiBUaGUgaW5qZWN0ZWQgc2lkZWJhciBidXR0b24gKHNvIHdlIGNhbiB1cGRhdGUgaXRzIGFjdGl2ZSBzdGF0ZSkuICovXG4gIG5hdkJ1dHRvbj86IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbn1cblxuLyoqIFdoYXQgcGFnZSBpcyBjdXJyZW50bHkgc2VsZWN0ZWQgaW4gb3VyIGluamVjdGVkIG5hdi4gKi9cbnR5cGUgQWN0aXZlUGFnZSA9XG4gIHwgeyBraW5kOiBcImNvbmZpZ1wiIH1cbiAgfCB7IGtpbmQ6IFwidHdlYWtzXCIgfVxuICB8IHsga2luZDogXCJyZWdpc3RlcmVkXCI7IGlkOiBzdHJpbmcgfTtcblxuaW50ZXJmYWNlIEluamVjdG9yU3RhdGUge1xuICBzZWN0aW9uczogTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uPjtcbiAgcGFnZXM6IE1hcDxzdHJpbmcsIFJlZ2lzdGVyZWRQYWdlPjtcbiAgbGlzdGVkVHdlYWtzOiBMaXN0ZWRUd2Vha1tdO1xuICAvKiogT3V0ZXIgd3JhcHBlciB0aGF0IGhvbGRzIENvZGV4J3MgaXRlbXMgZ3JvdXAgKyBvdXIgaW5qZWN0ZWQgZ3JvdXBzLiAqL1xuICBvdXRlcldyYXBwZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIkdlbmVyYWxcIiBsYWJlbCBmb3IgQ29kZXgncyBuYXRpdmUgc2V0dGluZ3MgZ3JvdXAuICovXG4gIG5hdGl2ZU5hdkhlYWRlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiQ29kZXgrK1wiIG5hdiBncm91cCAoQ29uZmlnL1R3ZWFrcykuICovXG4gIG5hdkdyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG5hdkJ1dHRvbnM6IHsgY29uZmlnOiBIVE1MQnV0dG9uRWxlbWVudDsgdHdlYWtzOiBIVE1MQnV0dG9uRWxlbWVudCB9IHwgbnVsbDtcbiAgLyoqIE91ciBcIlR3ZWFrc1wiIG5hdiBncm91cCAocGVyLXR3ZWFrIHBhZ2VzKS4gQ3JlYXRlZCBsYXppbHkuICovXG4gIHBhZ2VzR3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcGFnZXNHcm91cEtleTogc3RyaW5nIHwgbnVsbDtcbiAgcGFuZWxIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbDtcbiAgZmluZ2VycHJpbnQ6IHN0cmluZyB8IG51bGw7XG4gIHNpZGViYXJEdW1wZWQ6IGJvb2xlYW47XG4gIGFjdGl2ZVBhZ2U6IEFjdGl2ZVBhZ2UgfCBudWxsO1xuICBzaWRlYmFyUm9vdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBzaWRlYmFyUmVzdG9yZUhhbmRsZXI6ICgoZTogRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogYm9vbGVhbjtcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG59XG5cbmNvbnN0IHN0YXRlOiBJbmplY3RvclN0YXRlID0ge1xuICBzZWN0aW9uczogbmV3IE1hcCgpLFxuICBwYWdlczogbmV3IE1hcCgpLFxuICBsaXN0ZWRUd2Vha3M6IFtdLFxuICBvdXRlcldyYXBwZXI6IG51bGwsXG4gIG5hdGl2ZU5hdkhlYWRlcjogbnVsbCxcbiAgbmF2R3JvdXA6IG51bGwsXG4gIG5hdkJ1dHRvbnM6IG51bGwsXG4gIHBhZ2VzR3JvdXA6IG51bGwsXG4gIHBhZ2VzR3JvdXBLZXk6IG51bGwsXG4gIHBhbmVsSG9zdDogbnVsbCxcbiAgb2JzZXJ2ZXI6IG51bGwsXG4gIGZpbmdlcnByaW50OiBudWxsLFxuICBzaWRlYmFyRHVtcGVkOiBmYWxzZSxcbiAgYWN0aXZlUGFnZTogbnVsbCxcbiAgc2lkZWJhclJvb3Q6IG51bGwsXG4gIHNpZGViYXJSZXN0b3JlSGFuZGxlcjogbnVsbCxcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogZmFsc2UsXG4gIHNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcjogbnVsbCxcbn07XG5cbmZ1bmN0aW9uIHBsb2cobXNnOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGBbc2V0dGluZ3MtaW5qZWN0b3JdICR7bXNnfSR7ZXh0cmEgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiBcIiBcIiArIHNhZmVTdHJpbmdpZnkoZXh0cmEpfWAsXG4gICk7XG59XG5mdW5jdGlvbiBzYWZlU3RyaW5naWZ5KHY6IHVua25vd24pOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IHYgOiBKU09OLnN0cmluZ2lmeSh2KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFN0cmluZyh2KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgcHVibGljIEFQSSBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0U2V0dGluZ3NJbmplY3RvcigpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm9ic2VydmVyKSByZXR1cm47XG5cbiAgY29uc3Qgb2JzID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIHRyeUluamVjdCgpO1xuICAgIG1heWJlRHVtcERvbSgpO1xuICB9KTtcbiAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgc3RhdGUub2JzZXJ2ZXIgPSBvYnM7XG5cbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCBvbk5hdik7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiaGFzaGNoYW5nZVwiLCBvbk5hdik7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkRvY3VtZW50Q2xpY2ssIHRydWUpO1xuICBmb3IgKGNvbnN0IG0gb2YgW1wicHVzaFN0YXRlXCIsIFwicmVwbGFjZVN0YXRlXCJdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgb3JpZyA9IGhpc3RvcnlbbV07XG4gICAgaGlzdG9yeVttXSA9IGZ1bmN0aW9uICh0aGlzOiBIaXN0b3J5LCAuLi5hcmdzOiBQYXJhbWV0ZXJzPHR5cGVvZiBvcmlnPikge1xuICAgICAgY29uc3QgciA9IG9yaWcuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoYGNvZGV4cHAtJHttfWApKTtcbiAgICAgIHJldHVybiByO1xuICAgIH0gYXMgdHlwZW9mIG9yaWc7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoYGNvZGV4cHAtJHttfWAsIG9uTmF2KTtcbiAgfVxuXG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbiAgbGV0IHRpY2tzID0gMDtcbiAgY29uc3QgaW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgdGlja3MrKztcbiAgICB0cnlJbmplY3QoKTtcbiAgICBtYXliZUR1bXBEb20oKTtcbiAgICBpZiAodGlja3MgPiA2MCkgY2xlYXJJbnRlcnZhbChpbnRlcnZhbCk7XG4gIH0sIDUwMCk7XG59XG5cbmZ1bmN0aW9uIG9uTmF2KCk6IHZvaWQge1xuICBzdGF0ZS5maW5nZXJwcmludCA9IG51bGw7XG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbn1cblxuZnVuY3Rpb24gb25Eb2N1bWVudENsaWNrKGU6IE1vdXNlRXZlbnQpOiB2b2lkIHtcbiAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50ID8gZS50YXJnZXQgOiBudWxsO1xuICBjb25zdCBjb250cm9sID0gdGFyZ2V0Py5jbG9zZXN0KFwiW3JvbGU9J2xpbmsnXSxidXR0b24sYVwiKTtcbiAgaWYgKCEoY29udHJvbCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSkgcmV0dXJuO1xuICBpZiAoY29tcGFjdFNldHRpbmdzVGV4dChjb250cm9sLnRleHRDb250ZW50IHx8IFwiXCIpICE9PSBcIkJhY2sgdG8gYXBwXCIpIHJldHVybjtcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJiYWNrLXRvLWFwcFwiKTtcbiAgfSwgMCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNlY3Rpb24oc2VjdGlvbjogU2V0dGluZ3NTZWN0aW9uKTogU2V0dGluZ3NIYW5kbGUge1xuICBzdGF0ZS5zZWN0aW9ucy5zZXQoc2VjdGlvbi5pZCwgc2VjdGlvbik7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICByZXR1cm4ge1xuICAgIHVucmVnaXN0ZXI6ICgpID0+IHtcbiAgICAgIHN0YXRlLnNlY3Rpb25zLmRlbGV0ZShzZWN0aW9uLmlkKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclNlY3Rpb25zKCk6IHZvaWQge1xuICBzdGF0ZS5zZWN0aW9ucy5jbGVhcigpO1xuICAvLyBEcm9wIHJlZ2lzdGVyZWQgcGFnZXMgdG9vIFx1MjAxNCB0aGV5J3JlIG93bmVkIGJ5IHR3ZWFrcyB0aGF0IGp1c3QgZ290XG4gIC8vIHRvcm4gZG93biBieSB0aGUgaG9zdC4gUnVuIGFueSB0ZWFyZG93bnMgYmVmb3JlIGZvcmdldHRpbmcgdGhlbS5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHAudGVhcmRvd24/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBsb2coXCJwYWdlIHRlYXJkb3duIGZhaWxlZFwiLCB7IGlkOiBwLmlkLCBlcnI6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cbiAgc3RhdGUucGFnZXMuY2xlYXIoKTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gSWYgd2Ugd2VyZSBvbiBhIHJlZ2lzdGVyZWQgcGFnZSB0aGF0IG5vIGxvbmdlciBleGlzdHMsIGZhbGwgYmFjayB0b1xuICAvLyByZXN0b3JpbmcgQ29kZXgncyB2aWV3LlxuICBpZiAoXG4gICAgc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiZcbiAgICAhc3RhdGUucGFnZXMuaGFzKHN0YXRlLmFjdGl2ZVBhZ2UuaWQpXG4gICkge1xuICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIGEgdHdlYWstb3duZWQgc2V0dGluZ3MgcGFnZS4gVGhlIHJ1bnRpbWUgaW5qZWN0cyBhIHNpZGViYXIgZW50cnlcbiAqIHVuZGVyIGEgXCJUV0VBS1NcIiBncm91cCBoZWFkZXIgKHdoaWNoIGFwcGVhcnMgb25seSB3aGVuIGF0IGxlYXN0IG9uZSBwYWdlXG4gKiBpcyByZWdpc3RlcmVkKSBhbmQgcm91dGVzIGNsaWNrcyB0byB0aGUgcGFnZSdzIGByZW5kZXIocm9vdClgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJQYWdlKFxuICB0d2Vha0lkOiBzdHJpbmcsXG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LFxuICBwYWdlOiBTZXR0aW5nc1BhZ2UsXG4pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIGNvbnN0IGlkID0gcGFnZS5pZDsgLy8gYWxyZWFkeSBuYW1lc3BhY2VkIGJ5IHR3ZWFrLWhvc3QgYXMgYCR7dHdlYWtJZH06JHtwYWdlLmlkfWBcbiAgY29uc3QgZW50cnk6IFJlZ2lzdGVyZWRQYWdlID0geyBpZCwgdHdlYWtJZCwgbWFuaWZlc3QsIHBhZ2UgfTtcbiAgc3RhdGUucGFnZXMuc2V0KGlkLCBlbnRyeSk7XG4gIHBsb2coXCJyZWdpc3RlclBhZ2VcIiwgeyBpZCwgdGl0bGU6IHBhZ2UudGl0bGUsIHR3ZWFrSWQgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIC8vIElmIHRoZSB1c2VyIHdhcyBhbHJlYWR5IG9uIHRoaXMgcGFnZSAoaG90IHJlbG9hZCksIHJlLW1vdW50IGl0cyBib2R5LlxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHtcbiAgICByZXJlbmRlcigpO1xuICB9XG4gIHJldHVybiB7XG4gICAgdW5yZWdpc3RlcjogKCkgPT4ge1xuICAgICAgY29uc3QgZSA9IHN0YXRlLnBhZ2VzLmdldChpZCk7XG4gICAgICBpZiAoIWUpIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGUudGVhcmRvd24/LigpO1xuICAgICAgfSBjYXRjaCB7fVxuICAgICAgc3RhdGUucGFnZXMuZGVsZXRlKGlkKTtcbiAgICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHtcbiAgICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgICAgfVxuICAgIH0sXG4gIH07XG59XG5cbi8qKiBDYWxsZWQgYnkgdGhlIHR3ZWFrIGhvc3QgYWZ0ZXIgZmV0Y2hpbmcgdGhlIHR3ZWFrIGxpc3QgZnJvbSBtYWluLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldExpc3RlZFR3ZWFrcyhsaXN0OiBMaXN0ZWRUd2Vha1tdKTogdm9pZCB7XG4gIHN0YXRlLmxpc3RlZFR3ZWFrcyA9IGxpc3Q7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgaW5qZWN0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0cnlJbmplY3QoKTogdm9pZCB7XG4gIGNvbnN0IGl0ZW1zR3JvdXAgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgaWYgKCFpdGVtc0dyb3VwKSB7XG4gICAgc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTtcbiAgICBwbG9nKFwic2lkZWJhciBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHtcbiAgICBjbGVhclRpbWVvdXQoc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKTtcbiAgICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBudWxsO1xuICB9XG4gIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUodHJ1ZSwgXCJzaWRlYmFyLWZvdW5kXCIpO1xuICAvLyBDb2RleCdzIGl0ZW1zIGdyb3VwIGxpdmVzIGluc2lkZSBhbiBvdXRlciB3cmFwcGVyIHRoYXQncyBhbHJlYWR5IHN0eWxlZFxuICAvLyB0byBob2xkIG11bHRpcGxlIGdyb3VwcyAoYGZsZXggZmxleC1jb2wgZ2FwLTEgZ2FwLTBgKS4gV2UgaW5qZWN0IG91clxuICAvLyBncm91cCBhcyBhIHNpYmxpbmcgc28gdGhlIG5hdHVyYWwgZ2FwLTEgYWN0cyBhcyBvdXIgdmlzdWFsIHNlcGFyYXRvci5cbiAgY29uc3Qgb3V0ZXIgPSBpdGVtc0dyb3VwLnBhcmVudEVsZW1lbnQgPz8gaXRlbXNHcm91cDtcbiAgc3RhdGUuc2lkZWJhclJvb3QgPSBvdXRlcjtcbiAgc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXAsIG91dGVyKTtcblxuICBpZiAoc3RhdGUubmF2R3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF2R3JvdXApKSB7XG4gICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAvLyBDb2RleCByZS1yZW5kZXJzIGl0cyBuYXRpdmUgc2lkZWJhciBidXR0b25zIG9uIGl0cyBvd24gc3RhdGUgY2hhbmdlcy5cbiAgICAvLyBJZiBvbmUgb2Ygb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgcmUtc3RyaXAgQ29kZXgncyBhY3RpdmUgc3R5bGluZyBzb1xuICAgIC8vIEdlbmVyYWwgZG9lc24ndCByZWFwcGVhciBhcyBzZWxlY3RlZC5cbiAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCkgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpZGViYXIgd2FzIGVpdGhlciBmcmVzaGx5IG1vdW50ZWQgKFNldHRpbmdzIGp1c3Qgb3BlbmVkKSBvciByZS1tb3VudGVkXG4gIC8vIChjbG9zZWQgYW5kIHJlLW9wZW5lZCwgb3IgbmF2aWdhdGVkIGF3YXkgYW5kIGJhY2spLiBJbiBhbGwgb2YgdGhvc2VcbiAgLy8gY2FzZXMgQ29kZXggcmVzZXRzIHRvIGl0cyBkZWZhdWx0IHBhZ2UgKEdlbmVyYWwpLCBidXQgb3VyIGluLW1lbW9yeVxuICAvLyBgYWN0aXZlUGFnZWAgbWF5IHN0aWxsIHJlZmVyZW5jZSB0aGUgbGFzdCB0d2Vhay9wYWdlIHRoZSB1c2VyIGhhZCBvcGVuXG4gIC8vIFx1MjAxNCB3aGljaCB3b3VsZCBjYXVzZSB0aGF0IG5hdiBidXR0b24gdG8gcmVuZGVyIHdpdGggdGhlIGFjdGl2ZSBzdHlsaW5nXG4gIC8vIGV2ZW4gdGhvdWdoIENvZGV4IGlzIHNob3dpbmcgR2VuZXJhbC4gQ2xlYXIgaXQgc28gYHN5bmNQYWdlc0dyb3VwYCAvXG4gIC8vIGBzZXROYXZBY3RpdmVgIHN0YXJ0IGZyb20gYSBuZXV0cmFsIHN0YXRlLiBUaGUgcGFuZWxIb3N0IHJlZmVyZW5jZSBpc1xuICAvLyBhbHNvIHN0YWxlIChpdHMgRE9NIHdhcyBkaXNjYXJkZWQgd2l0aCB0aGUgcHJldmlvdXMgY29udGVudCBhcmVhKS5cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwgfHwgc3RhdGUucGFuZWxIb3N0ICE9PSBudWxsKSB7XG4gICAgcGxvZyhcInNpZGViYXIgcmUtbW91bnQgZGV0ZWN0ZWQ7IGNsZWFyaW5nIHN0YWxlIGFjdGl2ZSBzdGF0ZVwiLCB7XG4gICAgICBwcmV2QWN0aXZlOiBzdGF0ZS5hY3RpdmVQYWdlLFxuICAgIH0pO1xuICAgIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICAgIHN0YXRlLnBhbmVsSG9zdCA9IG51bGw7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgR3JvdXAgY29udGFpbmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGdyb3VwLmRhdGFzZXQuY29kZXhwcCA9IFwibmF2LWdyb3VwXCI7XG4gIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcblxuICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJDb2RleCsrXCIsIFwicHQtM1wiKSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFR3byBzaWRlYmFyIGl0ZW1zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBjb25maWdCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJDb25maWdcIiwgY29uZmlnSWNvblN2ZygpKTtcbiAgY29uc3QgdHdlYWtzQnRuID0gbWFrZVNpZGViYXJJdGVtKFwiVHdlYWtzXCIsIHR3ZWFrc0ljb25TdmcoKSk7XG5cbiAgY29uZmlnQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwiY29uZmlnXCIgfSk7XG4gIH0pO1xuICB0d2Vha3NCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJ0d2Vha3NcIiB9KTtcbiAgfSk7XG5cbiAgZ3JvdXAuYXBwZW5kQ2hpbGQoY29uZmlnQnRuKTtcbiAgZ3JvdXAuYXBwZW5kQ2hpbGQodHdlYWtzQnRuKTtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQoZ3JvdXApO1xuXG4gIHN0YXRlLm5hdkdyb3VwID0gZ3JvdXA7XG4gIHN0YXRlLm5hdkJ1dHRvbnMgPSB7IGNvbmZpZzogY29uZmlnQnRuLCB0d2Vha3M6IHR3ZWFrc0J0biB9O1xuICBwbG9nKFwibmF2IGdyb3VwIGluamVjdGVkXCIsIHsgb3V0ZXJUYWc6IG91dGVyLnRhZ05hbWUgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwOiBIVE1MRWxlbWVudCwgb3V0ZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF0aXZlTmF2SGVhZGVyKSkgcmV0dXJuO1xuICBpZiAob3V0ZXIgPT09IGl0ZW1zR3JvdXApIHJldHVybjtcblxuICBjb25zdCBoZWFkZXIgPSBzaWRlYmFyR3JvdXBIZWFkZXIoXCJHZW5lcmFsXCIpO1xuICBoZWFkZXIuZGF0YXNldC5jb2RleHBwID0gXCJuYXRpdmUtbmF2LWhlYWRlclwiO1xuICBvdXRlci5pbnNlcnRCZWZvcmUoaGVhZGVyLCBpdGVtc0dyb3VwKTtcbiAgc3RhdGUubmF0aXZlTmF2SGVhZGVyID0gaGVhZGVyO1xufVxuXG5mdW5jdGlvbiBzaWRlYmFyR3JvdXBIZWFkZXIodGV4dDogc3RyaW5nLCB0b3BQYWRkaW5nID0gXCJwdC0yXCIpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPVxuICAgIGBweC1yb3cteCAke3RvcFBhZGRpbmd9IHBiLTEgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdXBwZXJjYXNlIHRyYWNraW5nLXdpZGVyIHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZCBzZWxlY3Qtbm9uZWA7XG4gIGhlYWRlci50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk6IHZvaWQge1xuICBpZiAoIXN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgfHwgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKSByZXR1cm47XG4gIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gICAgaWYgKGZpbmRTaWRlYmFySXRlbXNHcm91cCgpKSByZXR1cm47XG4gICAgaWYgKGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpKSByZXR1cm47XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJzaWRlYmFyLW5vdC1mb3VuZFwiKTtcbiAgfSwgMTUwMCk7XG59XG5cbmZ1bmN0aW9uIGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpOiBib29sZWFuIHtcbiAgY29uc3QgdGV4dCA9IGNvbXBhY3RTZXR0aW5nc1RleHQoZG9jdW1lbnQuYm9keT8udGV4dENvbnRlbnQgfHwgXCJcIikudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIChcbiAgICB0ZXh0LmluY2x1ZGVzKFwiYmFjayB0byBhcHBcIikgJiZcbiAgICB0ZXh0LmluY2x1ZGVzKFwiZ2VuZXJhbFwiKSAmJlxuICAgIHRleHQuaW5jbHVkZXMoXCJhcHBlYXJhbmNlXCIpICYmXG4gICAgKHRleHQuaW5jbHVkZXMoXCJjb25maWd1cmF0aW9uXCIpIHx8IHRleHQuaW5jbHVkZXMoXCJkZWZhdWx0IHBlcm1pc3Npb25zXCIpKVxuICApO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0U2V0dGluZ3NUZXh0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh2aXNpYmxlOiBib29sZWFuLCByZWFzb246IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9PT0gdmlzaWJsZSkgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgdHJ5IHtcbiAgICAod2luZG93IGFzIFdpbmRvdyAmIHsgX19jb2RleHBwU2V0dGluZ3NTdXJmYWNlVmlzaWJsZT86IGJvb2xlYW4gfSkuX19jb2RleHBwU2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9IHZpc2libGU7XG4gICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQuY29kZXhwcFNldHRpbmdzU3VyZmFjZSA9IHZpc2libGUgPyBcInRydWVcIiA6IFwiZmFsc2VcIjtcbiAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChcbiAgICAgIG5ldyBDdXN0b21FdmVudChcImNvZGV4cHA6c2V0dGluZ3Mtc3VyZmFjZVwiLCB7XG4gICAgICAgIGRldGFpbDogeyB2aXNpYmxlLCByZWFzb24gfSxcbiAgICAgIH0pLFxuICAgICk7XG4gIH0gY2F0Y2gge31cbiAgcGxvZyhcInNldHRpbmdzIHN1cmZhY2VcIiwgeyB2aXNpYmxlLCByZWFzb24sIHVybDogbG9jYXRpb24uaHJlZiB9KTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgKG9yIHJlLXJlbmRlcikgdGhlIHNlY29uZCBzaWRlYmFyIGdyb3VwIG9mIHBlci10d2VhayBwYWdlcy4gVGhlXG4gKiBncm91cCBpcyBjcmVhdGVkIGxhemlseSBhbmQgcmVtb3ZlZCB3aGVuIHRoZSBsYXN0IHBhZ2UgdW5yZWdpc3RlcnMsIHNvXG4gKiB1c2VycyB3aXRoIG5vIHBhZ2UtcmVnaXN0ZXJpbmcgdHdlYWtzIG5ldmVyIHNlZSBhbiBlbXB0eSBcIlR3ZWFrc1wiIGhlYWRlci5cbiAqL1xuZnVuY3Rpb24gc3luY1BhZ2VzR3JvdXAoKTogdm9pZCB7XG4gIGNvbnN0IG91dGVyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghb3V0ZXIpIHJldHVybjtcbiAgY29uc3QgcGFnZXMgPSBbLi4uc3RhdGUucGFnZXMudmFsdWVzKCldO1xuXG4gIC8vIEJ1aWxkIGEgZGV0ZXJtaW5pc3RpYyBmaW5nZXJwcmludCBvZiB0aGUgZGVzaXJlZCBncm91cCBzdGF0ZS4gSWYgdGhlXG4gIC8vIGN1cnJlbnQgRE9NIGdyb3VwIGFscmVhZHkgbWF0Y2hlcywgdGhpcyBpcyBhIG5vLW9wIFx1MjAxNCBjcml0aWNhbCwgYmVjYXVzZVxuICAvLyBzeW5jUGFnZXNHcm91cCBpcyBjYWxsZWQgb24gZXZlcnkgTXV0YXRpb25PYnNlcnZlciB0aWNrIGFuZCBhbnkgRE9NXG4gIC8vIHdyaXRlIHdvdWxkIHJlLXRyaWdnZXIgdGhhdCBvYnNlcnZlciAoaW5maW5pdGUgbG9vcCwgYXBwIGZyZWV6ZSkuXG4gIGNvbnN0IGRlc2lyZWRLZXkgPSBwYWdlcy5sZW5ndGggPT09IDBcbiAgICA/IFwiRU1QVFlcIlxuICAgIDogcGFnZXMubWFwKChwKSA9PiBgJHtwLmlkfXwke3AucGFnZS50aXRsZX18JHtwLnBhZ2UuaWNvblN2ZyA/PyBcIlwifWApLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IGdyb3VwQXR0YWNoZWQgPSAhIXN0YXRlLnBhZ2VzR3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUucGFnZXNHcm91cCk7XG4gIGlmIChzdGF0ZS5wYWdlc0dyb3VwS2V5ID09PSBkZXNpcmVkS2V5ICYmIChwYWdlcy5sZW5ndGggPT09IDAgPyAhZ3JvdXBBdHRhY2hlZCA6IGdyb3VwQXR0YWNoZWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwKSB7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwLnJlbW92ZSgpO1xuICAgICAgc3RhdGUucGFnZXNHcm91cCA9IG51bGw7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcCBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkgcC5uYXZCdXR0b24gPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBkZXNpcmVkS2V5O1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxldCBncm91cCA9IHN0YXRlLnBhZ2VzR3JvdXA7XG4gIGlmICghZ3JvdXAgfHwgIW91dGVyLmNvbnRhaW5zKGdyb3VwKSkge1xuICAgIGdyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBncm91cC5kYXRhc2V0LmNvZGV4cHAgPSBcInBhZ2VzLWdyb3VwXCI7XG4gICAgZ3JvdXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1weFwiO1xuICAgIGdyb3VwLmFwcGVuZENoaWxkKHNpZGViYXJHcm91cEhlYWRlcihcIlR3ZWFrc1wiLCBcInB0LTNcIikpO1xuICAgIG91dGVyLmFwcGVuZENoaWxkKGdyb3VwKTtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwID0gZ3JvdXA7XG4gIH0gZWxzZSB7XG4gICAgLy8gU3RyaXAgcHJpb3IgYnV0dG9ucyAoa2VlcCB0aGUgaGVhZGVyIGF0IGluZGV4IDApLlxuICAgIHdoaWxlIChncm91cC5jaGlsZHJlbi5sZW5ndGggPiAxKSBncm91cC5yZW1vdmVDaGlsZChncm91cC5sYXN0Q2hpbGQhKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgcCBvZiBwYWdlcykge1xuICAgIGNvbnN0IGljb24gPSBwLnBhZ2UuaWNvblN2ZyA/PyBkZWZhdWx0UGFnZUljb25TdmcoKTtcbiAgICBjb25zdCBidG4gPSBtYWtlU2lkZWJhckl0ZW0ocC5wYWdlLnRpdGxlLCBpY29uKTtcbiAgICBidG4uZGF0YXNldC5jb2RleHBwID0gYG5hdi1wYWdlLSR7cC5pZH1gO1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IHAuaWQgfSk7XG4gICAgfSk7XG4gICAgcC5uYXZCdXR0b24gPSBidG47XG4gICAgZ3JvdXAuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgfVxuICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gZGVzaXJlZEtleTtcbiAgcGxvZyhcInBhZ2VzIGdyb3VwIHN5bmNlZFwiLCB7XG4gICAgY291bnQ6IHBhZ2VzLmxlbmd0aCxcbiAgICBpZHM6IHBhZ2VzLm1hcCgocCkgPT4gcC5pZCksXG4gIH0pO1xuICAvLyBSZWZsZWN0IGN1cnJlbnQgYWN0aXZlIHN0YXRlIGFjcm9zcyB0aGUgcmVidWlsdCBidXR0b25zLlxuICBzZXROYXZBY3RpdmUoc3RhdGUuYWN0aXZlUGFnZSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VTaWRlYmFySXRlbShsYWJlbDogc3RyaW5nLCBpY29uU3ZnOiBzdHJpbmcpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIC8vIENsYXNzIHN0cmluZyBjb3BpZWQgdmVyYmF0aW0gZnJvbSBDb2RleCdzIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCBldGMpLlxuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5kYXRhc2V0LmNvZGV4cHAgPSBgbmF2LSR7bGFiZWwudG9Mb3dlckNhc2UoKX1gO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiZm9jdXMtdmlzaWJsZTpvdXRsaW5lLXRva2VuLWJvcmRlciByZWxhdGl2ZSBweC1yb3cteCBweS1yb3cteSBjdXJzb3ItaW50ZXJhY3Rpb24gc2hyaW5rLTAgaXRlbXMtY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIHRleHQtbGVmdCB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZSBmb2N1cy12aXNpYmxlOm91dGxpbmUtMiBmb2N1cy12aXNpYmxlOm91dGxpbmUtb2Zmc2V0LTIgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNTAgZ2FwLTIgZmxleCB3LWZ1bGwgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvbnQtbm9ybWFsXCI7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBpbm5lci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciB0ZXh0LWJhc2UgZ2FwLTIgZmxleC0xIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICBpbm5lci5pbm5lckhUTUwgPSBgJHtpY29uU3ZnfTxzcGFuIGNsYXNzPVwidHJ1bmNhdGVcIj4ke2xhYmVsfTwvc3Bhbj5gO1xuICBidG4uYXBwZW5kQ2hpbGQoaW5uZXIpO1xuICByZXR1cm4gYnRuO1xufVxuXG4vKiogSW50ZXJuYWwga2V5IGZvciB0aGUgYnVpbHQtaW4gbmF2IGJ1dHRvbnMuICovXG50eXBlIEJ1aWx0aW5QYWdlID0gXCJjb25maWdcIiB8IFwidHdlYWtzXCI7XG5cbmZ1bmN0aW9uIHNldE5hdkFjdGl2ZShhY3RpdmU6IEFjdGl2ZVBhZ2UgfCBudWxsKTogdm9pZCB7XG4gIC8vIEJ1aWx0LWluIChDb25maWcvVHdlYWtzKSBidXR0b25zLlxuICBpZiAoc3RhdGUubmF2QnV0dG9ucykge1xuICAgIGNvbnN0IGJ1aWx0aW46IEJ1aWx0aW5QYWdlIHwgbnVsbCA9XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwiY29uZmlnXCIgPyBcImNvbmZpZ1wiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwidHdlYWtzXCIgOiBudWxsO1xuICAgIGZvciAoY29uc3QgW2tleSwgYnRuXSBvZiBPYmplY3QuZW50cmllcyhzdGF0ZS5uYXZCdXR0b25zKSBhcyBbQnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50XVtdKSB7XG4gICAgICBhcHBseU5hdkFjdGl2ZShidG4sIGtleSA9PT0gYnVpbHRpbik7XG4gICAgfVxuICB9XG4gIC8vIFBlci1wYWdlIHJlZ2lzdGVyZWQgYnV0dG9ucy5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgaWYgKCFwLm5hdkJ1dHRvbikgY29udGludWU7XG4gICAgY29uc3QgaXNBY3RpdmUgPSBhY3RpdmU/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIGFjdGl2ZS5pZCA9PT0gcC5pZDtcbiAgICBhcHBseU5hdkFjdGl2ZShwLm5hdkJ1dHRvbiwgaXNBY3RpdmUpO1xuICB9XG4gIC8vIENvZGV4J3Mgb3duIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCwgQXBwZWFyYW5jZSwgZXRjKS4gV2hlbiBvbmUgb2ZcbiAgLy8gb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgQ29kZXggc3RpbGwgaGFzIGFyaWEtY3VycmVudD1cInBhZ2VcIiBhbmQgdGhlXG4gIC8vIGFjdGl2ZS1iZyBjbGFzcyBvbiB3aGljaGV2ZXIgaXRlbSBpdCBjb25zaWRlcmVkIHRoZSByb3V0ZSBcdTIwMTQgdHlwaWNhbGx5XG4gIC8vIEdlbmVyYWwuIFRoYXQgbWFrZXMgYm90aCBidXR0b25zIGxvb2sgc2VsZWN0ZWQuIFN0cmlwIENvZGV4J3MgYWN0aXZlXG4gIC8vIHN0eWxpbmcgd2hpbGUgb25lIG9mIG91cnMgaXMgYWN0aXZlOyByZXN0b3JlIGl0IHdoZW4gbm9uZSBpcy5cbiAgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKGFjdGl2ZSAhPT0gbnVsbCk7XG59XG5cbi8qKlxuICogTXV0ZSBDb2RleCdzIG93biBhY3RpdmUtc3RhdGUgc3R5bGluZyBvbiBpdHMgc2lkZWJhciBidXR0b25zLiBXZSBkb24ndFxuICogdG91Y2ggQ29kZXgncyBSZWFjdCBzdGF0ZSBcdTIwMTQgd2hlbiB0aGUgdXNlciBjbGlja3MgYSBuYXRpdmUgaXRlbSwgQ29kZXhcbiAqIHJlLXJlbmRlcnMgdGhlIGJ1dHRvbnMgYW5kIHJlLWFwcGxpZXMgaXRzIG93biBjb3JyZWN0IHN0YXRlLCB0aGVuIG91clxuICogc2lkZWJhci1jbGljayBsaXN0ZW5lciBmaXJlcyBgcmVzdG9yZUNvZGV4Vmlld2AgKHdoaWNoIGNhbGxzIGJhY2sgaW50b1xuICogYHNldE5hdkFjdGl2ZShudWxsKWAgYW5kIGxldHMgQ29kZXgncyBzdHlsaW5nIHN0YW5kKS5cbiAqXG4gKiBgbXV0ZT10cnVlYCAgXHUyMTkyIHN0cmlwIGFyaWEtY3VycmVudCBhbmQgc3dhcCBhY3RpdmUgYmcgXHUyMTkyIGhvdmVyIGJnXG4gKiBgbXV0ZT1mYWxzZWAgXHUyMTkyIG5vLW9wIChDb2RleCdzIG93biByZS1yZW5kZXIgYWxyZWFkeSByZXN0b3JlZCB0aGluZ3MpXG4gKi9cbmZ1bmN0aW9uIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShtdXRlOiBib29sZWFuKTogdm9pZCB7XG4gIGlmICghbXV0ZSkgcmV0dXJuO1xuICBjb25zdCByb290ID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghcm9vdCkgcmV0dXJuO1xuICBjb25zdCBidXR0b25zID0gQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpKTtcbiAgZm9yIChjb25zdCBidG4gb2YgYnV0dG9ucykge1xuICAgIC8vIFNraXAgb3VyIG93biBidXR0b25zLlxuICAgIGlmIChidG4uZGF0YXNldC5jb2RleHBwKSBjb250aW51ZTtcbiAgICBpZiAoYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIpIHtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgfVxuICAgIGlmIChidG4uY2xhc3NMaXN0LmNvbnRhaW5zKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseU5hdkFjdGl2ZShidG46IEhUTUxCdXR0b25FbGVtZW50LCBhY3RpdmU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgaW5uZXIgPSBidG4uZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoYWN0aXZlKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiLCBcImZvbnQtbm9ybWFsXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIsIFwicGFnZVwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBhY3RpdmF0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBhY3RpdmF0ZVBhZ2UocGFnZTogQWN0aXZlUGFnZSk6IHZvaWQge1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkge1xuICAgIHBsb2coXCJhY3RpdmF0ZTogY29udGVudCBhcmVhIG5vdCBmb3VuZFwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IHBhZ2U7XG4gIHBsb2coXCJhY3RpdmF0ZVwiLCB7IHBhZ2UgfSk7XG5cbiAgLy8gSGlkZSBDb2RleCdzIGNvbnRlbnQgY2hpbGRyZW4sIHNob3cgb3Vycy5cbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwID09PSBcInR3ZWFrcy1wYW5lbFwiKSBjb250aW51ZTtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbiA9IGNoaWxkLnN0eWxlLmRpc3BsYXkgfHwgXCJcIjtcbiAgICB9XG4gICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICB9XG4gIGxldCBwYW5lbCA9IGNvbnRlbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLWNvZGV4cHA9XCJ0d2Vha3MtcGFuZWxcIl0nKTtcbiAgaWYgKCFwYW5lbCkge1xuICAgIHBhbmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBwYW5lbC5kYXRhc2V0LmNvZGV4cHAgPSBcInR3ZWFrcy1wYW5lbFwiO1xuICAgIHBhbmVsLnN0eWxlLmNzc1RleHQgPSBcIndpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3ZlcmZsb3c6YXV0bztcIjtcbiAgICBjb250ZW50LmFwcGVuZENoaWxkKHBhbmVsKTtcbiAgfVxuICBwYW5lbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICBzdGF0ZS5wYW5lbEhvc3QgPSBwYW5lbDtcbiAgcmVyZW5kZXIoKTtcbiAgc2V0TmF2QWN0aXZlKHBhZ2UpO1xuICAvLyByZXN0b3JlIENvZGV4J3Mgdmlldy4gUmUtcmVnaXN0ZXIgaWYgbmVlZGVkLlxuICBjb25zdCBzaWRlYmFyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmIChzaWRlYmFyKSB7XG4gICAgaWYgKHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgICAgc2lkZWJhci5yZW1vdmVFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLCB0cnVlKTtcbiAgICB9XG4gICAgY29uc3QgaGFuZGxlciA9IChlOiBFdmVudCkgPT4ge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICAgIGlmIChzdGF0ZS5uYXZHcm91cD8uY29udGFpbnModGFyZ2V0KSkgcmV0dXJuOyAvLyBvdXIgYnV0dG9uc1xuICAgICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIHBhZ2UgYnV0dG9uc1xuICAgICAgaWYgKHRhcmdldC5jbG9zZXN0KFwiW2RhdGEtY29kZXhwcC1zZXR0aW5ncy1zZWFyY2hdXCIpKSByZXR1cm47XG4gICAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gICAgfTtcbiAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIgPSBoYW5kbGVyO1xuICAgIHNpZGViYXIuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZXIsIHRydWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc3RvcmVDb2RleFZpZXcoKTogdm9pZCB7XG4gIHBsb2coXCJyZXN0b3JlIGNvZGV4IHZpZXdcIik7XG4gIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm47XG4gIGlmIChzdGF0ZS5wYW5lbEhvc3QpIHN0YXRlLnBhbmVsSG9zdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkID09PSBzdGF0ZS5wYW5lbEhvc3QpIGNvbnRpbnVlO1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbjtcbiAgICAgIGRlbGV0ZSBjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW47XG4gICAgfVxuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICBzZXROYXZBY3RpdmUobnVsbCk7XG4gIGlmIChzdGF0ZS5zaWRlYmFyUm9vdCAmJiBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdC5yZW1vdmVFdmVudExpc3RlbmVyKFxuICAgICAgXCJjbGlja1wiLFxuICAgICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciA9IG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVyZW5kZXIoKTogdm9pZCB7XG4gIGlmICghc3RhdGUuYWN0aXZlUGFnZSkgcmV0dXJuO1xuICBjb25zdCBob3N0ID0gc3RhdGUucGFuZWxIb3N0O1xuICBpZiAoIWhvc3QpIHJldHVybjtcbiAgaG9zdC5pbm5lckhUTUwgPSBcIlwiO1xuXG4gIGNvbnN0IGFwID0gc3RhdGUuYWN0aXZlUGFnZTtcbiAgaWYgKGFwLmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgY29uc3QgZW50cnkgPSBzdGF0ZS5wYWdlcy5nZXQoYXAuaWQpO1xuICAgIGlmICghZW50cnkpIHtcbiAgICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qgcm9vdCA9IHBhbmVsU2hlbGwoZW50cnkucGFnZS50aXRsZSwgZW50cnkucGFnZS5kZXNjcmlwdGlvbik7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChyb290Lm91dGVyKTtcbiAgICB0cnkge1xuICAgICAgLy8gVGVhciBkb3duIGFueSBwcmlvciByZW5kZXIgYmVmb3JlIHJlLXJlbmRlcmluZyAoaG90IHJlbG9hZCkuXG4gICAgICB0cnkgeyBlbnRyeS50ZWFyZG93bj8uKCk7IH0gY2F0Y2gge31cbiAgICAgIGVudHJ5LnRlYXJkb3duID0gbnVsbDtcbiAgICAgIGNvbnN0IHJldCA9IGVudHJ5LnBhZ2UucmVuZGVyKHJvb3Quc2VjdGlvbnNXcmFwKTtcbiAgICAgIGlmICh0eXBlb2YgcmV0ID09PSBcImZ1bmN0aW9uXCIpIGVudHJ5LnRlYXJkb3duID0gcmV0O1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGVyciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBlcnIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWNoYXJ0cy1yZWQgdGV4dC1zbVwiO1xuICAgICAgZXJyLnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyBwYWdlOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICByb290LnNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChlcnIpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0aXRsZSA9IGFwLmtpbmQgPT09IFwidHdlYWtzXCIgPyBcIlR3ZWFrc1wiIDogXCJDb25maWdcIjtcbiAgY29uc3Qgc3VidGl0bGUgPSBhcC5raW5kID09PSBcInR3ZWFrc1wiXG4gICAgPyBcIk1hbmFnZSB5b3VyIGluc3RhbGxlZCBDb2RleCsrIHR3ZWFrcy5cIlxuICAgIDogXCJDaGVja2luZyBpbnN0YWxsZWQgQ29kZXgrKyB2ZXJzaW9uLlwiO1xuICBjb25zdCByb290ID0gcGFuZWxTaGVsbCh0aXRsZSwgc3VidGl0bGUpO1xuICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICBpZiAoYXAua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVuZGVyVHdlYWtzUGFnZShyb290LnNlY3Rpb25zV3JhcCk7XG4gIGVsc2UgcmVuZGVyQ29uZmlnUGFnZShyb290LnNlY3Rpb25zV3JhcCwgcm9vdC5zdWJ0aXRsZSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBwYWdlcyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcmVuZGVyQ29uZmlnUGFnZShzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LCBzdWJ0aXRsZT86IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJDb2RleCsrIFVwZGF0ZXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY29uc3QgbG9hZGluZyA9IHJvd1NpbXBsZShcIkxvYWRpbmcgdXBkYXRlIHNldHRpbmdzXCIsIFwiQ2hlY2tpbmcgY3VycmVudCBDb2RleCsrIGNvbmZpZ3VyYXRpb24uXCIpO1xuICBjYXJkLmFwcGVuZENoaWxkKGxvYWRpbmcpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC1jb25maWdcIilcbiAgICAudGhlbigoY29uZmlnKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHtcbiAgICAgICAgc3VidGl0bGUudGV4dENvbnRlbnQgPSBgWW91IGhhdmUgQ29kZXgrKyAkeyhjb25maWcgYXMgQ29kZXhQbHVzUGx1c0NvbmZpZykudmVyc2lvbn0gaW5zdGFsbGVkLmA7XG4gICAgICB9XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlckNvZGV4UGx1c1BsdXNDb25maWcoY2FyZCwgY29uZmlnIGFzIENvZGV4UGx1c1BsdXNDb25maWcpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHN1YnRpdGxlLnRleHRDb250ZW50ID0gXCJDb3VsZCBub3QgbG9hZCBpbnN0YWxsZWQgQ29kZXgrKyB2ZXJzaW9uLlwiO1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCBsb2FkIHVwZGF0ZSBzZXR0aW5nc1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcblxuICBjb25zdCB3YXRjaGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdhdGNoZXIuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHdhdGNoZXIuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiQXV0by1SZXBhaXIgV2F0Y2hlclwiKSk7XG4gIGNvbnN0IHdhdGNoZXJDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgd2F0Y2hlckNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgd2F0Y2hlclwiLCBcIlZlcmlmeWluZyB0aGUgdXBkYXRlciByZXBhaXIgc2VydmljZS5cIikpO1xuICB3YXRjaGVyLmFwcGVuZENoaWxkKHdhdGNoZXJDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHdhdGNoZXIpO1xuICByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZCh3YXRjaGVyQ2FyZCk7XG5cbiAgY29uc3QgY2RwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIGNkcC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgY2RwLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkRldmVsb3BlciAvIENEUFwiKSk7XG4gIGNvbnN0IGNkcENhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjZHBDYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIENEUFwiLCBcIlJlYWRpbmcgQ2hyb21lIERldlRvb2xzIFByb3RvY29sIHN0YXR1cy5cIikpO1xuICBjZHAuYXBwZW5kQ2hpbGQoY2RwQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChjZHApO1xuICByZW5kZXJDZHBDYXJkKGNkcENhcmQpO1xuXG4gIGNvbnN0IG1haW50ZW5hbmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIG1haW50ZW5hbmNlLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBtYWludGVuYW5jZS5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJNYWludGVuYW5jZVwiKSk7XG4gIGNvbnN0IG1haW50ZW5hbmNlQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZCh1bmluc3RhbGxSb3coKSk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZChyZXBvcnRCdWdSb3coKSk7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChtYWludGVuYW5jZSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNvZGV4UGx1c1BsdXNDb25maWcoY2FyZDogSFRNTEVsZW1lbnQsIGNvbmZpZzogQ29kZXhQbHVzUGx1c0NvbmZpZyk6IHZvaWQge1xuICBjYXJkLmFwcGVuZENoaWxkKGF1dG9VcGRhdGVSb3coY29uZmlnKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY2hlY2tGb3JVcGRhdGVzUm93KGNvbmZpZy51cGRhdGVDaGVjaykpO1xuICBpZiAoY29uZmlnLnVwZGF0ZUNoZWNrKSBjYXJkLmFwcGVuZENoaWxkKHJlbGVhc2VOb3Rlc1Jvdyhjb25maWcudXBkYXRlQ2hlY2spKTtcbn1cblxuZnVuY3Rpb24gYXV0b1VwZGF0ZVJvdyhjb25maWc6IENvZGV4UGx1c1BsdXNDb25maWcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiQXV0b21hdGljYWxseSByZWZyZXNoIENvZGV4KytcIjtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gYEluc3RhbGxlZCB2ZXJzaW9uIHYke2NvbmZpZy52ZXJzaW9ufS4gVGhlIHdhdGNoZXIgY2FuIHJlZnJlc2ggdGhlIENvZGV4KysgcnVudGltZSBhZnRlciB5b3UgcmVydW4gdGhlIEdpdEh1YiBpbnN0YWxsZXIuYDtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgcm93LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2woY29uZmlnLmF1dG9VcGRhdGUsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnNldC1hdXRvLXVwZGF0ZVwiLCBuZXh0KTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY2hlY2tGb3JVcGRhdGVzUm93KGNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBjaGVjaz8udXBkYXRlQXZhaWxhYmxlID8gXCJDb2RleCsrIHVwZGF0ZSBhdmFpbGFibGVcIiA6IFwiQ29kZXgrKyBpcyB1cCB0byBkYXRlXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IHVwZGF0ZVN1bW1hcnkoY2hlY2spO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgaWYgKGNoZWNrPy5yZWxlYXNlVXJsKSB7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgIGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlIE5vdGVzXCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgY2hlY2sucmVsZWFzZVVybCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiMC42NVwiO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpjaGVjay1jb2RleHBwLXVwZGF0ZVwiLCB0cnVlKVxuICAgICAgICAudGhlbigobmV4dCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGNhcmQgPSByb3cucGFyZW50RWxlbWVudDtcbiAgICAgICAgICBpZiAoIWNhcmQpIHJldHVybjtcbiAgICAgICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2V0LWNvbmZpZ1wiKS50aGVuKChjb25maWcpID0+IHtcbiAgICAgICAgICAgIHJlbmRlckNvZGV4UGx1c1BsdXNDb25maWcoY2FyZCwge1xuICAgICAgICAgICAgICAuLi4oY29uZmlnIGFzIENvZGV4UGx1c1BsdXNDb25maWcpLFxuICAgICAgICAgICAgICB1cGRhdGVDaGVjazogbmV4dCBhcyBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2ssXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiQ29kZXgrKyB1cGRhdGUgY2hlY2sgZmFpbGVkXCIsIFN0cmluZyhlKSkpXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICAgIH0pO1xuICAgIH0pLFxuICApO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbGVhc2VOb3Rlc1JvdyhjaGVjazogQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yIHAtM1wiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiTGF0ZXN0IHJlbGVhc2Ugbm90ZXNcIjtcbiAgcm93LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJvZHkuY2xhc3NOYW1lID1cbiAgICBcIm1heC1oLTYwIG92ZXJmbG93LWF1dG8gcm91bmRlZC1tZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcC0zIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBib2R5LmFwcGVuZENoaWxkKHJlbmRlclJlbGVhc2VOb3Rlc01hcmtkb3duKGNoZWNrLnJlbGVhc2VOb3Rlcz8udHJpbSgpIHx8IGNoZWNrLmVycm9yIHx8IFwiTm8gcmVsZWFzZSBub3RlcyBhdmFpbGFibGUuXCIpKTtcbiAgcm93LmFwcGVuZENoaWxkKGJvZHkpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZW5kZXJDZHBDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnZXQtY2RwLXN0YXR1c1wiKVxuICAgIC50aGVuKChzdGF0dXMpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyQ2RwU3RhdHVzKGNhcmQsIHN0YXR1cyBhcyBDb2RleENkcFN0YXR1cyk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgcmVhZCBDRFAgc3RhdHVzXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDZHBTdGF0dXMoY2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiB2b2lkIHtcbiAgY2FyZC5hcHBlbmRDaGlsZChjZHBUb2dnbGVSb3coY2FyZCwgc3RhdHVzKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY2RwUG9ydFJvdyhjYXJkLCBzdGF0dXMpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjZHBFbmRwb2ludFJvdyhzdGF0dXMpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjZHBMYXVuY2hSb3coc3RhdHVzKSk7XG4gIGlmIChzdGF0dXMucmVzdGFydFJlcXVpcmVkKSB7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChcbiAgICAgIHJvd1NpbXBsZShcbiAgICAgICAgXCJSZXN0YXJ0IHJlcXVpcmVkXCIsXG4gICAgICAgIHN0YXR1cy5lbmFibGVkXG4gICAgICAgICAgPyBcIkNEUCB3aWxsIHVzZSB0aGUgc2F2ZWQgcG9ydCBhZnRlciBDb2RleCByZXN0YXJ0cy5cIlxuICAgICAgICAgIDogXCJDRFAgaXMgc3RpbGwgYWN0aXZlIGZvciB0aGlzIHByb2Nlc3MgYW5kIHdpbGwgdHVybiBvZmYgYWZ0ZXIgQ29kZXggcmVzdGFydHMuXCIsXG4gICAgICApLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2RwVG9nZ2xlUm93KGNhcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChjZHBTdGF0dXNCYWRnZShzdGF0dXMpKTtcblxuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkNocm9tZSBEZXZUb29scyBQcm90b2NvbFwiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBjZHBTdGF0dXNTdW1tYXJ5KHN0YXR1cyk7XG4gIHN0YWNrLmFwcGVuZCh0aXRsZSwgZGVzYyk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgcm93LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2woc3RhdHVzLmVuYWJsZWQsIGFzeW5jIChlbmFibGVkKSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnNldC1jZHAtY29uZmlnXCIsIHtcbiAgICAgICAgZW5hYmxlZCxcbiAgICAgICAgcG9ydDogc3RhdHVzLmNvbmZpZ3VyZWRQb3J0LFxuICAgICAgfSk7XG4gICAgICByZWZyZXNoQ2RwQ2FyZChjYXJkKTtcbiAgICB9KSxcbiAgKTtcblxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjZHBQb3J0Um93KGNhcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJSZW1vdGUgZGVidWdnaW5nIHBvcnRcIixcbiAgICBzdGF0dXMuYWN0aXZlUG9ydFxuICAgICAgPyBgQ3VycmVudCBwcm9jZXNzIGlzIGxpc3RlbmluZyBvbiAke3N0YXR1cy5hY3RpdmVQb3J0fS5gXG4gICAgICA6IGBTYXZlZCBwb3J0IGlzICR7c3RhdHVzLmNvbmZpZ3VyZWRQb3J0fS5gLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW5wdXRcIik7XG4gIGlucHV0LnR5cGUgPSBcIm51bWJlclwiO1xuICBpbnB1dC5taW4gPSBcIjFcIjtcbiAgaW5wdXQubWF4ID0gXCI2NTUzNVwiO1xuICBpbnB1dC5zdGVwID0gXCIxXCI7XG4gIGlucHV0LnZhbHVlID0gU3RyaW5nKHN0YXR1cy5jb25maWd1cmVkUG9ydCk7XG4gIGlucHV0LmNsYXNzTmFtZSA9XG4gICAgXCJoLTggdy0yNCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRyYW5zcGFyZW50IHB4LTIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1czpvdXRsaW5lLW5vbmUgZm9jdXM6cmluZy0yIGZvY3VzOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCI7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoaW5wdXQpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJTYXZlXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IHBvcnQgPSBOdW1iZXIoaW5wdXQudmFsdWUpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpzZXQtY2RwLWNvbmZpZ1wiLCB7XG4gICAgICAgICAgZW5hYmxlZDogc3RhdHVzLmVuYWJsZWQsXG4gICAgICAgICAgcG9ydDogTnVtYmVyLmlzSW50ZWdlcihwb3J0KSA/IHBvcnQgOiBzdGF0dXMuY29uZmlndXJlZFBvcnQsXG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHJlZnJlc2hDZHBDYXJkKGNhcmQpKVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJDRFAgcG9ydCBzYXZlIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY2RwRW5kcG9pbnRSb3coc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIHN0YXR1cy5hY3RpdmUgPyBcIkxvY2FsIENEUCBlbmRwb2ludHNcIiA6IFwiTG9jYWwgQ0RQIGVuZHBvaW50c1wiLFxuICAgIHN0YXR1cy5hY3RpdmUgJiYgc3RhdHVzLmpzb25MaXN0VXJsXG4gICAgICA/IGAke3N0YXR1cy5qc29uTGlzdFVybH1gXG4gICAgICA6IFwiTm90IGV4cG9zZWQgYnkgdGhlIGN1cnJlbnQgQ29kZXggcHJvY2Vzcy5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGNvbnN0IG9wZW5UYXJnZXRzID0gY29tcGFjdEJ1dHRvbihcIk9wZW4gVGFyZ2V0c1wiLCAoKSA9PiB7XG4gICAgaWYgKCFzdGF0dXMuanNvbkxpc3RVcmwpIHJldHVybjtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1jZHAtdXJsXCIsIHN0YXR1cy5qc29uTGlzdFVybCk7XG4gIH0pO1xuICBvcGVuVGFyZ2V0cy5kaXNhYmxlZCA9ICFzdGF0dXMuanNvbkxpc3RVcmw7XG4gIGNvbnN0IGNvcHlUYXJnZXRzID0gY29tcGFjdEJ1dHRvbihcIkNvcHkgVVJMXCIsICgpID0+IHtcbiAgICBpZiAoIXN0YXR1cy5qc29uTGlzdFVybCkgcmV0dXJuO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb3B5LXRleHRcIiwgc3RhdHVzLmpzb25MaXN0VXJsKTtcbiAgfSk7XG4gIGNvcHlUYXJnZXRzLmRpc2FibGVkID0gIXN0YXR1cy5qc29uTGlzdFVybDtcbiAgY29uc3Qgb3BlblZlcnNpb24gPSBjb21wYWN0QnV0dG9uKFwiVmVyc2lvblwiLCAoKSA9PiB7XG4gICAgaWYgKCFzdGF0dXMuanNvblZlcnNpb25VcmwpIHJldHVybjtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1jZHAtdXJsXCIsIHN0YXR1cy5qc29uVmVyc2lvblVybCk7XG4gIH0pO1xuICBvcGVuVmVyc2lvbi5kaXNhYmxlZCA9ICFzdGF0dXMuanNvblZlcnNpb25Vcmw7XG4gIGFjdGlvbj8uYXBwZW5kKG9wZW5UYXJnZXRzLCBjb3B5VGFyZ2V0cywgb3BlblZlcnNpb24pO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjZHBMYXVuY2hSb3coc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiTGF1bmNoIGNvbW1hbmRcIixcbiAgICBzdGF0dXMuYXBwUm9vdCA/IHN0YXR1cy5hcHBSb290IDogXCJDb2RleCBhcHAgcGF0aCB3YXMgbm90IGZvdW5kIGluIGluc3RhbGxlciBzdGF0ZS5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNvcHkgQ29tbWFuZFwiLCAoKSA9PiB7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29weS10ZXh0XCIsIHN0YXR1cy5sYXVuY2hDb21tYW5kKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVmcmVzaENkcENhcmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgQ0RQXCIsIFwiUmVhZGluZyBDaHJvbWUgRGV2VG9vbHMgUHJvdG9jb2wgc3RhdHVzLlwiKSk7XG4gIHJlbmRlckNkcENhcmQoY2FyZCk7XG59XG5cbmZ1bmN0aW9uIGNkcFN0YXR1c0JhZGdlKHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGlmIChzdGF0dXMuYWN0aXZlKSByZXR1cm4gc3RhdHVzQmFkZ2Uoc3RhdHVzLnJlc3RhcnRSZXF1aXJlZCA/IFwid2FyblwiIDogXCJva1wiLCBcIkFjdGl2ZVwiKTtcbiAgaWYgKHN0YXR1cy5yZXN0YXJ0UmVxdWlyZWQpIHJldHVybiBzdGF0dXNCYWRnZShcIndhcm5cIiwgXCJSZXN0YXJ0XCIpO1xuICByZXR1cm4gc3RhdHVzQmFkZ2Uoc3RhdHVzLmVuYWJsZWQgPyBcIndhcm5cIiA6IFwid2FyblwiLCBzdGF0dXMuZW5hYmxlZCA/IFwiU2F2ZWRcIiA6IFwiT2ZmXCIpO1xufVxuXG5mdW5jdGlvbiBjZHBTdGF0dXNTdW1tYXJ5KHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBzdHJpbmcge1xuICBpZiAoc3RhdHVzLmFjdGl2ZVBvcnQpIHtcbiAgICBjb25zdCBzb3VyY2UgPSBzdGF0dXMuc291cmNlID09PSBcImFyZ3ZcIiA/IFwibGF1bmNoIGFyZ1wiIDogc3RhdHVzLnNvdXJjZTtcbiAgICByZXR1cm4gYEFjdGl2ZSBvbiAxMjcuMC4wLjE6JHtzdGF0dXMuYWN0aXZlUG9ydH0gZnJvbSAke3NvdXJjZX0uYDtcbiAgfVxuICBpZiAoc3RhdHVzLmVuYWJsZWQpIHtcbiAgICByZXR1cm4gYEVuYWJsZWQgZm9yIG5leHQgbGF1bmNoIG9uIDEyNy4wLjAuMToke3N0YXR1cy5jb25maWd1cmVkUG9ydH0uYDtcbiAgfVxuICByZXR1cm4gXCJEaXNhYmxlZCBmb3IgQ29kZXggbGF1bmNoZXMgbWFuYWdlZCBieSBDb2RleCsrLlwiO1xufVxuXG5mdW5jdGlvbiByZW5kZXJSZWxlYXNlTm90ZXNNYXJrZG93bihtYXJrZG93bjogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm9vdC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgY29uc3QgbGluZXMgPSBtYXJrZG93bi5yZXBsYWNlKC9cXHJcXG4/L2csIFwiXFxuXCIpLnNwbGl0KFwiXFxuXCIpO1xuICBsZXQgcGFyYWdyYXBoOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgbGlzdDogSFRNTE9MaXN0RWxlbWVudCB8IEhUTUxVTGlzdEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGNvZGVMaW5lczogc3RyaW5nW10gfCBudWxsID0gbnVsbDtcblxuICBjb25zdCBmbHVzaFBhcmFncmFwaCA9ICgpID0+IHtcbiAgICBpZiAocGFyYWdyYXBoLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IHAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICBwLmNsYXNzTmFtZSA9IFwibS0wIGxlYWRpbmctNVwiO1xuICAgIGFwcGVuZElubGluZU1hcmtkb3duKHAsIHBhcmFncmFwaC5qb2luKFwiIFwiKS50cmltKCkpO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQocCk7XG4gICAgcGFyYWdyYXBoID0gW107XG4gIH07XG4gIGNvbnN0IGZsdXNoTGlzdCA9ICgpID0+IHtcbiAgICBpZiAoIWxpc3QpIHJldHVybjtcbiAgICByb290LmFwcGVuZENoaWxkKGxpc3QpO1xuICAgIGxpc3QgPSBudWxsO1xuICB9O1xuICBjb25zdCBmbHVzaENvZGUgPSAoKSA9PiB7XG4gICAgaWYgKCFjb2RlTGluZXMpIHJldHVybjtcbiAgICBjb25zdCBwcmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicHJlXCIpO1xuICAgIHByZS5jbGFzc05hbWUgPVxuICAgICAgXCJtLTAgb3ZlcmZsb3ctYXV0byByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvMTAgcC0yIHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICBjb25zdCBjb2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImNvZGVcIik7XG4gICAgY29kZS50ZXh0Q29udGVudCA9IGNvZGVMaW5lcy5qb2luKFwiXFxuXCIpO1xuICAgIHByZS5hcHBlbmRDaGlsZChjb2RlKTtcbiAgICByb290LmFwcGVuZENoaWxkKHByZSk7XG4gICAgY29kZUxpbmVzID0gbnVsbDtcbiAgfTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBpZiAobGluZS50cmltKCkuc3RhcnRzV2l0aChcImBgYFwiKSkge1xuICAgICAgaWYgKGNvZGVMaW5lcykgZmx1c2hDb2RlKCk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICAgIGNvZGVMaW5lcyA9IFtdO1xuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjb2RlTGluZXMpIHtcbiAgICAgIGNvZGVMaW5lcy5wdXNoKGxpbmUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgIGlmICghdHJpbW1lZCkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgaGVhZGluZyA9IC9eKCN7MSwzfSlcXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKGhlYWRpbmcpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBmbHVzaExpc3QoKTtcbiAgICAgIGNvbnN0IGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KGhlYWRpbmdbMV0ubGVuZ3RoID09PSAxID8gXCJoM1wiIDogXCJoNFwiKTtcbiAgICAgIGguY2xhc3NOYW1lID0gXCJtLTAgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgICAgYXBwZW5kSW5saW5lTWFya2Rvd24oaCwgaGVhZGluZ1syXSk7XG4gICAgICByb290LmFwcGVuZENoaWxkKGgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgdW5vcmRlcmVkID0gL15bLSpdXFxzKyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGNvbnN0IG9yZGVyZWQgPSAvXlxcZCtbLildXFxzKyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmICh1bm9yZGVyZWQgfHwgb3JkZXJlZCkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGNvbnN0IHdhbnRPcmRlcmVkID0gQm9vbGVhbihvcmRlcmVkKTtcbiAgICAgIGlmICghbGlzdCB8fCAod2FudE9yZGVyZWQgJiYgbGlzdC50YWdOYW1lICE9PSBcIk9MXCIpIHx8ICghd2FudE9yZGVyZWQgJiYgbGlzdC50YWdOYW1lICE9PSBcIlVMXCIpKSB7XG4gICAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgICBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh3YW50T3JkZXJlZCA/IFwib2xcIiA6IFwidWxcIik7XG4gICAgICAgIGxpc3QuY2xhc3NOYW1lID0gd2FudE9yZGVyZWRcbiAgICAgICAgICA/IFwibS0wIGxpc3QtZGVjaW1hbCBzcGFjZS15LTEgcGwtNSBsZWFkaW5nLTVcIlxuICAgICAgICAgIDogXCJtLTAgbGlzdC1kaXNjIHNwYWNlLXktMSBwbC01IGxlYWRpbmctNVwiO1xuICAgICAgfVxuICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihsaSwgKHVub3JkZXJlZCA/PyBvcmRlcmVkKT8uWzFdID8/IFwiXCIpO1xuICAgICAgbGlzdC5hcHBlbmRDaGlsZChsaSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBxdW90ZSA9IC9ePlxccz8oLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAocXVvdGUpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBmbHVzaExpc3QoKTtcbiAgICAgIGNvbnN0IGJsb2NrcXVvdGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYmxvY2txdW90ZVwiKTtcbiAgICAgIGJsb2NrcXVvdGUuY2xhc3NOYW1lID0gXCJtLTAgYm9yZGVyLWwtMiBib3JkZXItdG9rZW4tYm9yZGVyIHBsLTMgbGVhZGluZy01XCI7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihibG9ja3F1b3RlLCBxdW90ZVsxXSk7XG4gICAgICByb290LmFwcGVuZENoaWxkKGJsb2NrcXVvdGUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgcGFyYWdyYXBoLnB1c2godHJpbW1lZCk7XG4gIH1cblxuICBmbHVzaFBhcmFncmFwaCgpO1xuICBmbHVzaExpc3QoKTtcbiAgZmx1c2hDb2RlKCk7XG4gIHJldHVybiByb290O1xufVxuXG5mdW5jdGlvbiBhcHBlbmRJbmxpbmVNYXJrZG93bihwYXJlbnQ6IEhUTUxFbGVtZW50LCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgcGF0dGVybiA9IC8oYChbXmBdKylgfFxcWyhbXlxcXV0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpfFxcKlxcKihbXipdKylcXCpcXCp8XFwqKFteKl0rKVxcKikvZztcbiAgbGV0IGxhc3RJbmRleCA9IDA7XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgdGV4dC5tYXRjaEFsbChwYXR0ZXJuKSkge1xuICAgIGlmIChtYXRjaC5pbmRleCA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBhcHBlbmRUZXh0KHBhcmVudCwgdGV4dC5zbGljZShsYXN0SW5kZXgsIG1hdGNoLmluZGV4KSk7XG4gICAgaWYgKG1hdGNoWzJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY29kZVwiKTtcbiAgICAgIGNvZGUuY2xhc3NOYW1lID1cbiAgICAgICAgXCJyb3VuZGVkIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvMTAgcHgtMSBweS0wLjUgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgICAgY29kZS50ZXh0Q29udGVudCA9IG1hdGNoWzJdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKGNvZGUpO1xuICAgIH0gZWxzZSBpZiAobWF0Y2hbM10gIT09IHVuZGVmaW5lZCAmJiBtYXRjaFs0XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gICAgICBhLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXByaW1hcnkgdW5kZXJsaW5lIHVuZGVybGluZS1vZmZzZXQtMlwiO1xuICAgICAgYS5ocmVmID0gbWF0Y2hbNF07XG4gICAgICBhLnRhcmdldCA9IFwiX2JsYW5rXCI7XG4gICAgICBhLnJlbCA9IFwibm9vcGVuZXIgbm9yZWZlcnJlclwiO1xuICAgICAgYS50ZXh0Q29udGVudCA9IG1hdGNoWzNdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKGEpO1xuICAgIH0gZWxzZSBpZiAobWF0Y2hbNV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3Qgc3Ryb25nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN0cm9uZ1wiKTtcbiAgICAgIHN0cm9uZy5jbGFzc05hbWUgPSBcImZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBzdHJvbmcudGV4dENvbnRlbnQgPSBtYXRjaFs1XTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChzdHJvbmcpO1xuICAgIH0gZWxzZSBpZiAobWF0Y2hbNl0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZW1cIik7XG4gICAgICBlbS50ZXh0Q29udGVudCA9IG1hdGNoWzZdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKGVtKTtcbiAgICB9XG4gICAgbGFzdEluZGV4ID0gbWF0Y2guaW5kZXggKyBtYXRjaFswXS5sZW5ndGg7XG4gIH1cbiAgYXBwZW5kVGV4dChwYXJlbnQsIHRleHQuc2xpY2UobGFzdEluZGV4KSk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZFRleHQocGFyZW50OiBIVE1MRWxlbWVudCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICh0ZXh0KSBwYXJlbnQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUodGV4dCkpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZChjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcImNvZGV4cHA6Z2V0LXdhdGNoZXItaGVhbHRoXCIpXG4gICAgLnRoZW4oKGhlYWx0aCkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIGhlYWx0aCBhcyBXYXRjaGVySGVhbHRoKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCBjaGVjayB3YXRjaGVyXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQ6IEhUTUxFbGVtZW50LCBoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiB2b2lkIHtcbiAgY2FyZC5hcHBlbmRDaGlsZCh3YXRjaGVyU3VtbWFyeVJvdyhoZWFsdGgpKTtcbiAgZm9yIChjb25zdCBjaGVjayBvZiBoZWFsdGguY2hlY2tzKSB7XG4gICAgaWYgKGNoZWNrLnN0YXR1cyA9PT0gXCJva1wiKSBjb250aW51ZTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHdhdGNoZXJDaGVja1JvdyhjaGVjaykpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHdhdGNoZXJTdW1tYXJ5Um93KGhlYWx0aDogV2F0Y2hlckhlYWx0aCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1zdGFydCBnYXAtM1wiO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKGhlYWx0aC5zdGF0dXMsIGhlYWx0aC53YXRjaGVyKSk7XG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGhlYWx0aC50aXRsZTtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gYCR7aGVhbHRoLnN1bW1hcnl9IENoZWNrZWQgJHtuZXcgRGF0ZShoZWFsdGguY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpfS5gO1xuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKGRlc2MpO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGFjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGFjdGlvbi5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgTm93XCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNhcmQgPSByb3cucGFyZW50RWxlbWVudDtcbiAgICAgIGlmICghY2FyZCkgcmV0dXJuO1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIHdhdGNoZXJcIiwgXCJWZXJpZnlpbmcgdGhlIHVwZGF0ZXIgcmVwYWlyIHNlcnZpY2UuXCIpKTtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQpO1xuICAgIH0pLFxuICApO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9uKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gd2F0Y2hlckNoZWNrUm93KGNoZWNrOiBXYXRjaGVySGVhbHRoQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IHJvd1NpbXBsZShjaGVjay5uYW1lLCBjaGVjay5kZXRhaWwpO1xuICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGxlZnQpIGxlZnQucHJlcGVuZChzdGF0dXNCYWRnZShjaGVjay5zdGF0dXMpKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gc3RhdHVzQmFkZ2Uoc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiwgbGFiZWw/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbnN0IHRvbmUgPVxuICAgIHN0YXR1cyA9PT0gXCJva1wiXG4gICAgICA/IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1ncmVlbiB0ZXh0LXRva2VuLWNoYXJ0cy1ncmVlblwiXG4gICAgICA6IHN0YXR1cyA9PT0gXCJ3YXJuXCJcbiAgICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMteWVsbG93IHRleHQtdG9rZW4tY2hhcnRzLXllbGxvd1wiXG4gICAgICAgIDogXCJib3JkZXItdG9rZW4tY2hhcnRzLXJlZCB0ZXh0LXRva2VuLWNoYXJ0cy1yZWRcIjtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gYGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgYm9yZGVyIHB4LTIgcHktMC41IHRleHQteHMgZm9udC1tZWRpdW0gJHt0b25lfWA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gbGFiZWwgfHwgKHN0YXR1cyA9PT0gXCJva1wiID8gXCJPS1wiIDogc3RhdHVzID09PSBcIndhcm5cIiA/IFwiUmV2aWV3XCIgOiBcIkVycm9yXCIpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVN1bW1hcnkoY2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoIWNoZWNrKSByZXR1cm4gXCJObyB1cGRhdGUgY2hlY2sgaGFzIHJ1biB5ZXQuXCI7XG4gIGNvbnN0IGxhdGVzdCA9IGNoZWNrLmxhdGVzdFZlcnNpb24gPyBgTGF0ZXN0IHYke2NoZWNrLmxhdGVzdFZlcnNpb259LiBgIDogXCJcIjtcbiAgY29uc3QgY2hlY2tlZCA9IGBDaGVja2VkICR7bmV3IERhdGUoY2hlY2suY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpfS5gO1xuICBpZiAoY2hlY2suZXJyb3IpIHJldHVybiBgJHtsYXRlc3R9JHtjaGVja2VkfSAke2NoZWNrLmVycm9yfWA7XG4gIHJldHVybiBgJHtsYXRlc3R9JHtjaGVja2VkfWA7XG59XG5cbmZ1bmN0aW9uIHVuaW5zdGFsbFJvdygpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIlVuaW5zdGFsbCBDb2RleCsrXCIsXG4gICAgXCJDb3BpZXMgdGhlIHVuaW5zdGFsbCBjb21tYW5kLiBSdW4gaXQgZnJvbSBhIHRlcm1pbmFsIGFmdGVyIHF1aXR0aW5nIENvZGV4LlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBDb21tYW5kXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcImNvZGV4cHA6Y29weS10ZXh0XCIsIFwibm9kZSB+Ly5jb2RleC1wbHVzcGx1cy9zb3VyY2UvcGFja2FnZXMvaW5zdGFsbGVyL2Rpc3QvY2xpLmpzIHVuaW5zdGFsbFwiKVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJjb3B5IHVuaW5zdGFsbCBjb21tYW5kIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVwb3J0QnVnUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiUmVwb3J0IGEgYnVnXCIsXG4gICAgXCJPcGVuIGEgR2l0SHViIGlzc3VlIHdpdGggcnVudGltZSwgaW5zdGFsbGVyLCBvciB0d2Vhay1tYW5hZ2VyIGRldGFpbHMuXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJPcGVuIElzc3VlXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IHRpdGxlID0gZW5jb2RlVVJJQ29tcG9uZW50KFwiW0J1Z106IFwiKTtcbiAgICAgIGNvbnN0IGJvZHkgPSBlbmNvZGVVUklDb21wb25lbnQoXG4gICAgICAgIFtcbiAgICAgICAgICBcIiMjIFdoYXQgaGFwcGVuZWQ/XCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIFN0ZXBzIHRvIHJlcHJvZHVjZVwiLFxuICAgICAgICAgIFwiMS4gXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIEVudmlyb25tZW50XCIsXG4gICAgICAgICAgXCItIENvZGV4KysgdmVyc2lvbjogXCIsXG4gICAgICAgICAgXCItIENvZGV4IGFwcCB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gT1M6IFwiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBMb2dzXCIsXG4gICAgICAgICAgXCJBdHRhY2ggcmVsZXZhbnQgbGluZXMgZnJvbSB0aGUgQ29kZXgrKyBsb2cgZGlyZWN0b3J5LlwiLFxuICAgICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICApO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgIFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsXG4gICAgICAgIGBodHRwczovL2dpdGh1Yi5jb20vYWd1c3RpZi9jb2RleC1wbHVzcGx1cy9pc3N1ZXMvbmV3P3RpdGxlPSR7dGl0bGV9JmJvZHk9JHtib2R5fWAsXG4gICAgICApO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBhY3Rpb25Sb3codGl0bGVUZXh0OiBzdHJpbmcsIGRlc2NyaXB0aW9uOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IHRpdGxlVGV4dDtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmRhdGFzZXQuY29kZXhwcFJvd0FjdGlvbnMgPSBcInRydWVcIjtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtzUGFnZShzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IG9wZW5CdG4gPSBvcGVuSW5QbGFjZUJ1dHRvbihcIk9wZW4gVHdlYWtzIEZvbGRlclwiLCAoKSA9PiB7XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnJldmVhbFwiLCB0d2Vha3NQYXRoKCkpO1xuICB9KTtcbiAgY29uc3QgcmVsb2FkQnRuID0gb3BlbkluUGxhY2VCdXR0b24oXCJGb3JjZSBSZWxvYWRcIiwgKCkgPT4ge1xuICAgIC8vIEZ1bGwgcGFnZSByZWZyZXNoIFx1MjAxNCBzYW1lIGFzIERldlRvb2xzIENtZC1SIC8gb3VyIENEUCBQYWdlLnJlbG9hZC5cbiAgICAvLyBNYWluIHJlLWRpc2NvdmVycyB0d2Vha3MgZmlyc3Qgc28gdGhlIG5ldyByZW5kZXJlciBjb21lcyB1cCB3aXRoIGFcbiAgICAvLyBmcmVzaCB0d2VhayBzZXQ7IHRoZW4gbG9jYXRpb24ucmVsb2FkIHJlc3RhcnRzIHRoZSByZW5kZXJlciBzbyB0aGVcbiAgICAvLyBwcmVsb2FkIHJlLWluaXRpYWxpemVzIGFnYWluc3QgaXQuXG4gICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgLmludm9rZShcImNvZGV4cHA6cmVsb2FkLXR3ZWFrc1wiKVxuICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiZm9yY2UgcmVsb2FkIChtYWluKSBmYWlsZWRcIiwgU3RyaW5nKGUpKSlcbiAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgbG9jYXRpb24ucmVsb2FkKCk7XG4gICAgICB9KTtcbiAgfSk7XG4gIC8vIERyb3AgdGhlIGRpYWdvbmFsLWFycm93IGljb24gZnJvbSB0aGUgcmVsb2FkIGJ1dHRvbiBcdTIwMTQgaXQgaW1wbGllcyBcIm9wZW5cbiAgLy8gb3V0IG9mIGFwcFwiIHdoaWNoIGRvZXNuJ3QgZml0LiBSZXBsYWNlIGl0cyB0cmFpbGluZyBzdmcgd2l0aCBhIHJlZnJlc2guXG4gIGNvbnN0IHJlbG9hZFN2ZyA9IHJlbG9hZEJ0bi5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpO1xuICBpZiAocmVsb2FkU3ZnKSB7XG4gICAgcmVsb2FkU3ZnLm91dGVySFRNTCA9XG4gICAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLTJ4c1wiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgICAgYDxwYXRoIGQ9XCJNNCAxMGE2IDYgMCAwIDEgMTAuMjQtNC4yNEwxNiA3LjVNMTYgNHYzLjVoLTMuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICAgIGA8cGF0aCBkPVwiTTE2IDEwYTYgNiAwIDAgMS0xMC4yNCA0LjI0TDQgMTIuNU00IDE2di0zLjVoMy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgICAgYDwvc3ZnPmA7XG4gIH1cblxuICBjb25zdCB0cmFpbGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRyYWlsaW5nLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgdHJhaWxpbmcuYXBwZW5kQ2hpbGQocmVsb2FkQnRuKTtcbiAgdHJhaWxpbmcuYXBwZW5kQ2hpbGQob3BlbkJ0bik7XG5cbiAgaWYgKHN0YXRlLmxpc3RlZFR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gICAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkluc3RhbGxlZCBUd2Vha3NcIiwgdHJhaWxpbmcpKTtcbiAgICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKFxuICAgICAgcm93U2ltcGxlKFxuICAgICAgICBcIk5vIHR3ZWFrcyBpbnN0YWxsZWRcIixcbiAgICAgICAgYERyb3AgYSB0d2VhayBmb2xkZXIgaW50byAke3R3ZWFrc1BhdGgoKX0gYW5kIHJlbG9hZC5gLFxuICAgICAgKSxcbiAgICApO1xuICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gICAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEdyb3VwIHJlZ2lzdGVyZWQgU2V0dGluZ3NTZWN0aW9ucyBieSB0d2VhayBpZCAocHJlZml4IHNwbGl0IGF0IFwiOlwiKS5cbiAgY29uc3Qgc2VjdGlvbnNCeVR3ZWFrID0gbmV3IE1hcDxzdHJpbmcsIFNldHRpbmdzU2VjdGlvbltdPigpO1xuICBmb3IgKGNvbnN0IHMgb2Ygc3RhdGUuc2VjdGlvbnMudmFsdWVzKCkpIHtcbiAgICBjb25zdCB0d2Vha0lkID0gcy5pZC5zcGxpdChcIjpcIilbMF07XG4gICAgaWYgKCFzZWN0aW9uc0J5VHdlYWsuaGFzKHR3ZWFrSWQpKSBzZWN0aW9uc0J5VHdlYWsuc2V0KHR3ZWFrSWQsIFtdKTtcbiAgICBzZWN0aW9uc0J5VHdlYWsuZ2V0KHR3ZWFrSWQpIS5wdXNoKHMpO1xuICB9XG5cbiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICB3cmFwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICB3cmFwLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkluc3RhbGxlZCBUd2Vha3NcIiwgdHJhaWxpbmcpKTtcblxuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgZm9yIChjb25zdCB0IG9mIHN0YXRlLmxpc3RlZFR3ZWFrcykge1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQodHdlYWtSb3codCwgc2VjdGlvbnNCeVR3ZWFrLmdldCh0Lm1hbmlmZXN0LmlkKSA/PyBbXSkpO1xuICB9XG4gIHdyYXAuYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZCh3cmFwKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtSb3codDogTGlzdGVkVHdlYWssIHNlY3Rpb25zOiBTZXR0aW5nc1NlY3Rpb25bXSk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgbSA9IHQubWFuaWZlc3Q7XG5cbiAgLy8gT3V0ZXIgY2VsbCB3cmFwcyB0aGUgaGVhZGVyIHJvdyArIChvcHRpb25hbCkgbmVzdGVkIHNlY3Rpb25zIHNvIHRoZVxuICAvLyBwYXJlbnQgY2FyZCdzIGRpdmlkZXIgc3RheXMgYmV0d2VlbiAqdHdlYWtzKiwgbm90IGJldHdlZW4gaGVhZGVyIGFuZFxuICAvLyBib2R5IG9mIHRoZSBzYW1lIHR3ZWFrLlxuICBjb25zdCBjZWxsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2VsbC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2xcIjtcbiAgaWYgKCF0LmVuYWJsZWQpIGNlbGwuc3R5bGUub3BhY2l0eSA9IFwiMC43XCI7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1zdGFydCBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEF2YXRhciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgYXZhdGFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYXZhdGFyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIG92ZXJmbG93LWhpZGRlbiB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGF2YXRhci5zdHlsZS53aWR0aCA9IFwiNTZweFwiO1xuICBhdmF0YXIuc3R5bGUuaGVpZ2h0ID0gXCI1NnB4XCI7XG4gIGF2YXRhci5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBcInZhcigtLWNvbG9yLXRva2VuLWJnLWZvZywgdHJhbnNwYXJlbnQpXCI7XG4gIGlmIChtLmljb25VcmwpIHtcbiAgICBjb25zdCBpbWcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW1nXCIpO1xuICAgIGltZy5hbHQgPSBcIlwiO1xuICAgIGltZy5jbGFzc05hbWUgPSBcInNpemUtZnVsbCBvYmplY3QtY29udGFpblwiO1xuICAgIC8vIEluaXRpYWw6IHNob3cgZmFsbGJhY2sgaW5pdGlhbCBpbiBjYXNlIHRoZSBpY29uIGZhaWxzIHRvIGxvYWQuXG4gICAgY29uc3QgaW5pdGlhbCA9IChtLm5hbWU/LlswXSA/PyBcIj9cIikudG9VcHBlckNhc2UoKTtcbiAgICBjb25zdCBmYWxsYmFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIGZhbGxiYWNrLmNsYXNzTmFtZSA9IFwidGV4dC14bCBmb250LW1lZGl1bVwiO1xuICAgIGZhbGxiYWNrLnRleHRDb250ZW50ID0gaW5pdGlhbDtcbiAgICBhdmF0YXIuYXBwZW5kQ2hpbGQoZmFsbGJhY2spO1xuICAgIGltZy5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJsb2FkXCIsICgpID0+IHtcbiAgICAgIGZhbGxiYWNrLnJlbW92ZSgpO1xuICAgICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuICAgIH0pO1xuICAgIGltZy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKCkgPT4ge1xuICAgICAgaW1nLnJlbW92ZSgpO1xuICAgIH0pO1xuICAgIHZvaWQgcmVzb2x2ZUljb25VcmwobS5pY29uVXJsLCB0LmRpcikudGhlbigodXJsKSA9PiB7XG4gICAgICBpZiAodXJsKSBpbWcuc3JjID0gdXJsO1xuICAgICAgZWxzZSBpbWcucmVtb3ZlKCk7XG4gICAgfSk7XG4gICAgYXZhdGFyLmFwcGVuZENoaWxkKGltZyk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgaW5pdGlhbCA9IChtLm5hbWU/LlswXSA/PyBcIj9cIikudG9VcHBlckNhc2UoKTtcbiAgICBjb25zdCBzcGFuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgc3Bhbi5jbGFzc05hbWUgPSBcInRleHQteGwgZm9udC1tZWRpdW1cIjtcbiAgICBzcGFuLnRleHRDb250ZW50ID0gaW5pdGlhbDtcbiAgICBhdmF0YXIuYXBwZW5kQ2hpbGQoc3Bhbik7XG4gIH1cbiAgbGVmdC5hcHBlbmRDaGlsZChhdmF0YXIpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBUZXh0IHN0YWNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0wLjVcIjtcblxuICBjb25zdCB0aXRsZVJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlUm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5hbWUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgbmFtZS50ZXh0Q29udGVudCA9IG0ubmFtZTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQobmFtZSk7XG4gIGlmIChtLnZlcnNpb24pIHtcbiAgICBjb25zdCB2ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICB2ZXIuY2xhc3NOYW1lID1cbiAgICAgIFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSB0ZXh0LXhzIGZvbnQtbm9ybWFsIHRhYnVsYXItbnVtc1wiO1xuICAgIHZlci50ZXh0Q29udGVudCA9IGB2JHttLnZlcnNpb259YDtcbiAgICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXIpO1xuICB9XG4gIGlmICh0LnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlKSB7XG4gICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBiYWRnZS5jbGFzc05hbWUgPVxuICAgICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQtWzExcHhdIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgYmFkZ2UudGV4dENvbnRlbnQgPSBcIlVwZGF0ZSBBdmFpbGFibGVcIjtcbiAgICB0aXRsZVJvdy5hcHBlbmRDaGlsZChiYWRnZSk7XG4gIH1cbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGVSb3cpO1xuXG4gIGlmIChtLmRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gICAgZGVzYy50ZXh0Q29udGVudCA9IG0uZGVzY3JpcHRpb247XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIH1cblxuICBjb25zdCBtZXRhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbWV0YS5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBjb25zdCBhdXRob3JFbCA9IHJlbmRlckF1dGhvcihtLmF1dGhvcik7XG4gIGlmIChhdXRob3JFbCkgbWV0YS5hcHBlbmRDaGlsZChhdXRob3JFbCk7XG4gIGlmIChtLmdpdGh1YlJlcG8pIHtcbiAgICBpZiAobWV0YS5jaGlsZHJlbi5sZW5ndGggPiAwKSBtZXRhLmFwcGVuZENoaWxkKGRvdCgpKTtcbiAgICBjb25zdCByZXBvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICByZXBvLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIHJlcG8uY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCB0ZXh0LXRva2VuLXRleHQtbGluay1mb3JlZ3JvdW5kIGhvdmVyOnVuZGVybGluZVwiO1xuICAgIHJlcG8udGV4dENvbnRlbnQgPSBtLmdpdGh1YlJlcG87XG4gICAgcmVwby5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCBgaHR0cHM6Ly9naXRodWIuY29tLyR7bS5naXRodWJSZXBvfWApO1xuICAgIH0pO1xuICAgIG1ldGEuYXBwZW5kQ2hpbGQocmVwbyk7XG4gIH1cbiAgaWYgKG0uaG9tZXBhZ2UpIHtcbiAgICBpZiAobWV0YS5jaGlsZHJlbi5sZW5ndGggPiAwKSBtZXRhLmFwcGVuZENoaWxkKGRvdCgpKTtcbiAgICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gICAgbGluay5ocmVmID0gbS5ob21lcGFnZTtcbiAgICBsaW5rLnRhcmdldCA9IFwiX2JsYW5rXCI7XG4gICAgbGluay5yZWwgPSBcIm5vcmVmZXJyZXJcIjtcbiAgICBsaW5rLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggdGV4dC10b2tlbi10ZXh0LWxpbmstZm9yZWdyb3VuZCBob3Zlcjp1bmRlcmxpbmVcIjtcbiAgICBsaW5rLnRleHRDb250ZW50ID0gXCJIb21lcGFnZVwiO1xuICAgIG1ldGEuYXBwZW5kQ2hpbGQobGluayk7XG4gIH1cbiAgaWYgKG1ldGEuY2hpbGRyZW4ubGVuZ3RoID4gMCkgc3RhY2suYXBwZW5kQ2hpbGQobWV0YSk7XG5cbiAgLy8gVGFncyByb3cgKGlmIGFueSkgXHUyMDE0IHNtYWxsIHBpbGwgY2hpcHMgYmVsb3cgdGhlIG1ldGEgbGluZS5cbiAgaWYgKG0udGFncyAmJiBtLnRhZ3MubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHRhZ3NSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHRhZ3NSb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIgZ2FwLTEgcHQtMC41XCI7XG4gICAgZm9yIChjb25zdCB0YWcgb2YgbS50YWdzKSB7XG4gICAgICBjb25zdCBwaWxsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBwaWxsLmNsYXNzTmFtZSA9XG4gICAgICAgIFwicm91bmRlZC1mdWxsIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gICAgICBwaWxsLnRleHRDb250ZW50ID0gdGFnO1xuICAgICAgdGFnc1Jvdy5hcHBlbmRDaGlsZChwaWxsKTtcbiAgICB9XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQodGFnc1Jvdyk7XG4gIH1cblxuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBUb2dnbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcmlnaHQuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMiBwdC0wLjVcIjtcbiAgaWYgKHQudXBkYXRlPy51cGRhdGVBdmFpbGFibGUgJiYgdC51cGRhdGUucmVsZWFzZVVybCkge1xuICAgIHJpZ2h0LmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlJldmlldyBSZWxlYXNlXCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgdC51cGRhdGUhLnJlbGVhc2VVcmwpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICByaWdodC5hcHBlbmRDaGlsZChcbiAgICBzd2l0Y2hDb250cm9sKHQuZW5hYmxlZCwgYXN5bmMgKG5leHQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6c2V0LXR3ZWFrLWVuYWJsZWRcIiwgbS5pZCwgbmV4dCk7XG4gICAgICAvLyBUaGUgbWFpbiBwcm9jZXNzIGJyb2FkY2FzdHMgYSByZWxvYWQgd2hpY2ggd2lsbCByZS1mZXRjaCB0aGUgbGlzdFxuICAgICAgLy8gYW5kIHJlLXJlbmRlci4gV2UgZG9uJ3Qgb3B0aW1pc3RpY2FsbHkgdG9nZ2xlIHRvIGF2b2lkIGRyaWZ0LlxuICAgIH0pLFxuICApO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQocmlnaHQpO1xuXG4gIGNlbGwuYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICAvLyBJZiB0aGUgdHdlYWsgaXMgZW5hYmxlZCBhbmQgcmVnaXN0ZXJlZCBzZXR0aW5ncyBzZWN0aW9ucywgcmVuZGVyIHRob3NlXG4gIC8vIGJvZGllcyBhcyBuZXN0ZWQgcm93cyBiZW5lYXRoIHRoZSBoZWFkZXIgaW5zaWRlIHRoZSBzYW1lIGNlbGwuXG4gIGlmICh0LmVuYWJsZWQgJiYgc2VjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG5lc3RlZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgbmVzdGVkLmNsYXNzTmFtZSA9XG4gICAgICBcImZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIGJvcmRlci10LVswLjVweF0gYm9yZGVyLXRva2VuLWJvcmRlclwiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzZWN0aW9ucykge1xuICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib2R5LmNsYXNzTmFtZSA9IFwicC0zXCI7XG4gICAgICB0cnkge1xuICAgICAgICBzLnJlbmRlcihib2R5KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgYm9keS50ZXh0Q29udGVudCA9IGBFcnJvciByZW5kZXJpbmcgdHdlYWsgc2VjdGlvbjogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gO1xuICAgICAgfVxuICAgICAgbmVzdGVkLmFwcGVuZENoaWxkKGJvZHkpO1xuICAgIH1cbiAgICBjZWxsLmFwcGVuZENoaWxkKG5lc3RlZCk7XG4gIH1cblxuICByZXR1cm4gY2VsbDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQXV0aG9yKGF1dGhvcjogVHdlYWtNYW5pZmVzdFtcImF1dGhvclwiXSk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGlmICghYXV0aG9yKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICB3cmFwLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGdhcC0xXCI7XG4gIGlmICh0eXBlb2YgYXV0aG9yID09PSBcInN0cmluZ1wiKSB7XG4gICAgd3JhcC50ZXh0Q29udGVudCA9IGBieSAke2F1dGhvcn1gO1xuICAgIHJldHVybiB3cmFwO1xuICB9XG4gIHdyYXAuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoXCJieSBcIikpO1xuICBpZiAoYXV0aG9yLnVybCkge1xuICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICBhLmhyZWYgPSBhdXRob3IudXJsO1xuICAgIGEudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICBhLnJlbCA9IFwibm9yZWZlcnJlclwiO1xuICAgIGEuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCB0ZXh0LXRva2VuLXRleHQtbGluay1mb3JlZ3JvdW5kIGhvdmVyOnVuZGVybGluZVwiO1xuICAgIGEudGV4dENvbnRlbnQgPSBhdXRob3IubmFtZTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGEpO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHNwYW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBzcGFuLnRleHRDb250ZW50ID0gYXV0aG9yLm5hbWU7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChzcGFuKTtcbiAgfVxuICByZXR1cm4gd3JhcDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGNvbXBvbmVudHMgXHUyNTAwXHUyNTAwXG5cbi8qKiBUaGUgZnVsbCBwYW5lbCBzaGVsbCAodG9vbGJhciArIHNjcm9sbCArIGhlYWRpbmcgKyBzZWN0aW9ucyB3cmFwKS4gKi9cbmZ1bmN0aW9uIHBhbmVsU2hlbGwoXG4gIHRpdGxlOiBzdHJpbmcsXG4gIHN1YnRpdGxlPzogc3RyaW5nLFxuKTogeyBvdXRlcjogSFRNTEVsZW1lbnQ7IHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQ7IHN1YnRpdGxlPzogSFRNTEVsZW1lbnQgfSB7XG4gIGNvbnN0IG91dGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3V0ZXIuY2xhc3NOYW1lID0gXCJtYWluLXN1cmZhY2UgZmxleCBoLWZ1bGwgbWluLWgtMCBmbGV4LWNvbFwiO1xuXG4gIGNvbnN0IHRvb2xiYXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b29sYmFyLmNsYXNzTmFtZSA9XG4gICAgXCJkcmFnZ2FibGUgZmxleCBpdGVtcy1jZW50ZXIgcHgtcGFuZWwgZWxlY3Ryb246aC10b29sYmFyIGV4dGVuc2lvbjpoLXRvb2xiYXItc21cIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQodG9vbGJhcik7XG5cbiAgY29uc3Qgc2Nyb2xsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2Nyb2xsLmNsYXNzTmFtZSA9IFwiZmxleC0xIG92ZXJmbG93LXktYXV0byBwLXBhbmVsXCI7XG4gIG91dGVyLmFwcGVuZENoaWxkKHNjcm9sbCk7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBpbm5lci5jbGFzc05hbWUgPVxuICAgIFwibXgtYXV0byBmbGV4IHctZnVsbCBmbGV4LWNvbCBtYXgtdy0yeGwgZWxlY3Ryb246bWluLXctW2NhbGMoMzIwcHgqdmFyKC0tY29kZXgtd2luZG93LXpvb20pKV1cIjtcbiAgc2Nyb2xsLmFwcGVuZENoaWxkKGlubmVyKTtcblxuICBjb25zdCBoZWFkZXJXcmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyV3JhcC5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMyBwYi1wYW5lbFwiO1xuICBjb25zdCBoZWFkZXJJbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlcklubmVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMS41IHBiLXBhbmVsXCI7XG4gIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkaW5nLmNsYXNzTmFtZSA9IFwiZWxlY3Ryb246aGVhZGluZy1sZyBoZWFkaW5nLWJhc2UgdHJ1bmNhdGVcIjtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlO1xuICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZChoZWFkaW5nKTtcbiAgbGV0IHN1YnRpdGxlRWxlbWVudDogSFRNTEVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gIGlmIChzdWJ0aXRsZSkge1xuICAgIGNvbnN0IHN1YiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgc3ViLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSB0ZXh0LXNtXCI7XG4gICAgc3ViLnRleHRDb250ZW50ID0gc3VidGl0bGU7XG4gICAgaGVhZGVySW5uZXIuYXBwZW5kQ2hpbGQoc3ViKTtcbiAgICBzdWJ0aXRsZUVsZW1lbnQgPSBzdWI7XG4gIH1cbiAgaGVhZGVyV3JhcC5hcHBlbmRDaGlsZChoZWFkZXJJbm5lcik7XG4gIGlubmVyLmFwcGVuZENoaWxkKGhlYWRlcldyYXApO1xuXG4gIGNvbnN0IHNlY3Rpb25zV3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHNlY3Rpb25zV3JhcC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLVt2YXIoLS1wYWRkaW5nLXBhbmVsKV1cIjtcbiAgaW5uZXIuYXBwZW5kQ2hpbGQoc2VjdGlvbnNXcmFwKTtcblxuICByZXR1cm4geyBvdXRlciwgc2VjdGlvbnNXcmFwLCBzdWJ0aXRsZTogc3VidGl0bGVFbGVtZW50IH07XG59XG5cbmZ1bmN0aW9uIHNlY3Rpb25UaXRsZSh0ZXh0OiBzdHJpbmcsIHRyYWlsaW5nPzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC10b29sYmFyIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTIgcHgtMCBweS0wXCI7XG4gIGNvbnN0IHRpdGxlSW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZUlubmVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdC5jbGFzc05hbWUgPSBcInRleHQtYmFzZSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdGl0bGVJbm5lci5hcHBlbmRDaGlsZCh0KTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGVJbm5lcik7XG4gIGlmICh0cmFpbGluZykge1xuICAgIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByaWdodC5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gICAgcmlnaHQuYXBwZW5kQ2hpbGQodHJhaWxpbmcpO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHJpZ2h0KTtcbiAgfVxuICByZXR1cm4gdGl0bGVSb3c7XG59XG5cbi8qKlxuICogQ29kZXgncyBcIk9wZW4gY29uZmlnLnRvbWxcIi1zdHlsZSB0cmFpbGluZyBidXR0b246IGdob3N0IGJvcmRlciwgbXV0ZWRcbiAqIGxhYmVsLCB0b3AtcmlnaHQgZGlhZ29uYWwgYXJyb3cgaWNvbi4gTWFya3VwIG1pcnJvcnMgQ29uZmlndXJhdGlvbiBwYW5lbC5cbiAqL1xuZnVuY3Rpb24gb3BlbkluUGxhY2VCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBib3JkZXIgd2hpdGVzcGFjZS1ub3dyYXAgZm9jdXM6b3V0bGluZS1ub25lIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwIHJvdW5kZWQtbGcgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRhdGEtW3N0YXRlPW9wZW5dOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBib3JkZXItdHJhbnNwYXJlbnQgaC10b2tlbi1idXR0b24tY29tcG9zZXIgcHgtMiBweS0wIHRleHQtYmFzZSBsZWFkaW5nLVsxOHB4XVwiO1xuICBidG4uaW5uZXJIVE1MID1cbiAgICBgJHtsYWJlbH1gICtcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLTJ4c1wiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE0LjMzNDkgMTMuMzMwMVY2LjYwNjQ1TDUuNDcwNjUgMTUuNDcwN0M1LjIxMDk1IDE1LjczMDQgNC43ODg5NSAxNS43MzA0IDQuNTI5MjUgMTUuNDcwN0M0LjI2OTU1IDE1LjIxMSA0LjI2OTU1IDE0Ljc4OSA0LjUyOTI1IDE0LjUyOTNMMTMuMzkzNSA1LjY2NTA0SDYuNjYwMTFDNi4yOTI4NCA1LjY2NTA0IDUuOTk1MDcgNS4zNjcyNyA1Ljk5NTA3IDVDNS45OTUwNyA0LjYzMjczIDYuMjkyODQgNC4zMzQ5NiA2LjY2MDExIDQuMzM0OTZIMTQuOTk5OUwxNS4xMzM3IDQuMzQ4NjNDMTUuNDM2OSA0LjQxMDU3IDE1LjY2NSA0LjY3ODU3IDE1LjY2NSA1VjEzLjMzMDFDMTUuNjY0OSAxMy42OTczIDE1LjM2NzIgMTMuOTk1MSAxNC45OTk5IDEzLjk5NTFDMTQuNjMyNyAxMy45OTUxIDE0LjMzNSAxMy42OTczIDE0LjMzNDkgMTMuMzMwMVpcIiBmaWxsPVwiY3VycmVudENvbG9yXCI+PC9wYXRoPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gY29tcGFjdEJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGlubGluZS1mbGV4IGgtOCBpdGVtcy1jZW50ZXIgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcm91bmRlZENhcmQoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciByb3VuZGVkLWxnIGJvcmRlclwiO1xuICBjYXJkLnNldEF0dHJpYnV0ZShcbiAgICBcInN0eWxlXCIsXG4gICAgXCJiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1jb2xvci1iYWNrZ3JvdW5kLXBhbmVsLCB2YXIoLS1jb2xvci10b2tlbi1iZy1mb2cpKTtcIixcbiAgKTtcbiAgcmV0dXJuIGNhcmQ7XG59XG5cbmZ1bmN0aW9uIHJvd1NpbXBsZSh0aXRsZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTNcIjtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBpZiAodGl0bGUpIHtcbiAgICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICB0LmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgdC50ZXh0Q29udGVudCA9IHRpdGxlO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKHQpO1xuICB9XG4gIGlmIChkZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGQuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICAgIGQudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkKTtcbiAgfVxuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICByZXR1cm4gcm93O1xufVxuXG4vKipcbiAqIENvZGV4LXN0eWxlZCB0b2dnbGUgc3dpdGNoLiBNYXJrdXAgbWlycm9ycyB0aGUgR2VuZXJhbCA+IFBlcm1pc3Npb25zIHJvd1xuICogc3dpdGNoIHdlIGNhcHR1cmVkOiBvdXRlciBidXR0b24gKHJvbGU9c3dpdGNoKSwgaW5uZXIgcGlsbCwgc2xpZGluZyBrbm9iLlxuICovXG5mdW5jdGlvbiBzd2l0Y2hDb250cm9sKFxuICBpbml0aWFsOiBib29sZWFuLFxuICBvbkNoYW5nZTogKG5leHQ6IGJvb2xlYW4pID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+LFxuKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3dpdGNoXCIpO1xuXG4gIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29uc3Qga25vYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBrbm9iLmNsYXNzTmFtZSA9XG4gICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci1bY29sb3I6dmFyKC0tZ3JheS0wKV0gYmctW2NvbG9yOnZhcigtLWdyYXktMCldIHNoYWRvdy1zbSB0cmFuc2l0aW9uLXRyYW5zZm9ybSBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC00IHctNFwiO1xuICBwaWxsLmFwcGVuZENoaWxkKGtub2IpO1xuXG4gIGNvbnN0IGFwcGx5ID0gKG9uOiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiLCBTdHJpbmcob24pKTtcbiAgICBidG4uZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGJ0bi5jbGFzc05hbWUgPVxuICAgICAgXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyIGZvY3VzLXZpc2libGU6cm91bmRlZC1mdWxsIGN1cnNvci1pbnRlcmFjdGlvblwiO1xuICAgIHBpbGwuY2xhc3NOYW1lID0gYHJlbGF0aXZlIGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgdHJhbnNpdGlvbi1jb2xvcnMgZHVyYXRpb24tMjAwIGVhc2Utb3V0IGgtNSB3LTggJHtcbiAgICAgIG9uID8gXCJiZy10b2tlbi1jaGFydHMtYmx1ZVwiIDogXCJiZy10b2tlbi1mb3JlZ3JvdW5kLzIwXCJcbiAgICB9YDtcbiAgICBwaWxsLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLnN0eWxlLnRyYW5zZm9ybSA9IG9uID8gXCJ0cmFuc2xhdGVYKDE0cHgpXCIgOiBcInRyYW5zbGF0ZVgoMnB4KVwiO1xuICB9O1xuICBhcHBseShpbml0aWFsKTtcblxuICBidG4uYXBwZW5kQ2hpbGQocGlsbCk7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBjb25zdCBuZXh0ID0gYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiKSAhPT0gXCJ0cnVlXCI7XG4gICAgYXBwbHkobmV4dCk7XG4gICAgYnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgb25DaGFuZ2UobmV4dCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIGRvdCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgcy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiO1xuICBzLnRleHRDb250ZW50ID0gXCJcdTAwQjdcIjtcbiAgcmV0dXJuIHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBpY29ucyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY29uZmlnSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBTbGlkZXJzIC8gc2V0dGluZ3MgZ2x5cGguIDIweDIwIGN1cnJlbnRDb2xvci5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0zIDVoOU0xNSA1aDJNMyAxMGgyTTggMTBoOU0zIDE1aDExTTE3IDE1aDBcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiMTNcIiBjeT1cIjVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjZcIiBjeT1cIjEwXCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxNVwiIGN5PVwiMTVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiB0d2Vha3NJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNwYXJrbGVzIC8gXCIrK1wiIGdseXBoIGZvciB0d2Vha3MuXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTAgMi41IEwxMS40IDguNiBMMTcuNSAxMCBMMTEuNCAxMS40IEwxMCAxNy41IEw4LjYgMTEuNCBMMi41IDEwIEw4LjYgOC42IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE1LjUgMyBMMTYgNSBMMTggNS41IEwxNiA2IEwxNS41IDggTDE1IDYgTDEzIDUuNSBMMTUgNSBaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiIG9wYWNpdHk9XCIwLjdcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gZGVmYXVsdFBhZ2VJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIERvY3VtZW50L3BhZ2UgZ2x5cGggZm9yIHR3ZWFrLXJlZ2lzdGVyZWQgcGFnZXMgd2l0aG91dCB0aGVpciBvd24gaWNvbi5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk01IDNoN2wzIDN2MTFhMSAxIDAgMCAxLTEgMUg1YTEgMSAwIDAgMS0xLTFWNGExIDEgMCAwIDEgMS0xWlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTEyIDN2M2ExIDEgMCAwIDAgMSAxaDJcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk03IDExaDZNNyAxNGg0XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlSWNvblVybChcbiAgdXJsOiBzdHJpbmcsXG4gIHR3ZWFrRGlyOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKC9eKGh0dHBzPzp8ZGF0YTopLy50ZXN0KHVybCkpIHJldHVybiB1cmw7XG4gIC8vIFJlbGF0aXZlIHBhdGggXHUyMTkyIGFzayBtYWluIHRvIHJlYWQgdGhlIGZpbGUgYW5kIHJldHVybiBhIGRhdGE6IFVSTC5cbiAgLy8gUmVuZGVyZXIgaXMgc2FuZGJveGVkIHNvIGZpbGU6Ly8gd29uJ3QgbG9hZCBkaXJlY3RseS5cbiAgY29uc3QgcmVsID0gdXJsLnN0YXJ0c1dpdGgoXCIuL1wiKSA/IHVybC5zbGljZSgyKSA6IHVybDtcbiAgdHJ5IHtcbiAgICByZXR1cm4gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgIFwiY29kZXhwcDpyZWFkLXR3ZWFrLWFzc2V0XCIsXG4gICAgICB0d2Vha0RpcixcbiAgICAgIHJlbCxcbiAgICApKSBhcyBzdHJpbmc7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwbG9nKFwiaWNvbiBsb2FkIGZhaWxlZFwiLCB7IHVybCwgdHdlYWtEaXIsIGVycjogU3RyaW5nKGUpIH0pO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBET00gaGV1cmlzdGljcyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIC8vIEFuY2hvciBzdHJhdGVneSBmaXJzdCAod291bGQgYmUgaWRlYWwgaWYgQ29kZXggc3dpdGNoZXMgdG8gPGE+KS5cbiAgY29uc3QgbGlua3MgPSBBcnJheS5mcm9tKFxuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEFuY2hvckVsZW1lbnQ+KFwiYVtocmVmKj0nL3NldHRpbmdzLyddXCIpLFxuICApO1xuICBpZiAobGlua3MubGVuZ3RoID49IDIpIHtcbiAgICBsZXQgbm9kZTogSFRNTEVsZW1lbnQgfCBudWxsID0gbGlua3NbMF0ucGFyZW50RWxlbWVudDtcbiAgICB3aGlsZSAobm9kZSkge1xuICAgICAgY29uc3QgaW5zaWRlID0gbm9kZS5xdWVyeVNlbGVjdG9yQWxsKFwiYVtocmVmKj0nL3NldHRpbmdzLyddXCIpO1xuICAgICAgaWYgKGluc2lkZS5sZW5ndGggPj0gTWF0aC5tYXgoMiwgbGlua3MubGVuZ3RoIC0gMSkpIHJldHVybiBub2RlO1xuICAgICAgbm9kZSA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgICB9XG4gIH1cblxuICAvLyBUZXh0LWNvbnRlbnQgbWF0Y2ggYWdhaW5zdCBDb2RleCdzIGtub3duIHNpZGViYXIgbGFiZWxzLlxuICBjb25zdCBLTk9XTiA9IFtcbiAgICBcIkdlbmVyYWxcIixcbiAgICBcIkFwcGVhcmFuY2VcIixcbiAgICBcIkNvbmZpZ3VyYXRpb25cIixcbiAgICBcIlBlcnNvbmFsaXphdGlvblwiLFxuICAgIFwiTUNQIHNlcnZlcnNcIixcbiAgICBcIk1DUCBTZXJ2ZXJzXCIsXG4gICAgXCJHaXRcIixcbiAgICBcIkVudmlyb25tZW50c1wiLFxuICBdO1xuICBjb25zdCBtYXRjaGVzOiBIVE1MRWxlbWVudFtdID0gW107XG4gIGNvbnN0IGFsbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFxuICAgIFwiYnV0dG9uLCBhLCBbcm9sZT0nYnV0dG9uJ10sIGxpLCBkaXZcIixcbiAgKTtcbiAgZm9yIChjb25zdCBlbCBvZiBBcnJheS5mcm9tKGFsbCkpIHtcbiAgICBjb25zdCB0ID0gKGVsLnRleHRDb250ZW50ID8/IFwiXCIpLnRyaW0oKTtcbiAgICBpZiAodC5sZW5ndGggPiAzMCkgY29udGludWU7XG4gICAgaWYgKEtOT1dOLnNvbWUoKGspID0+IHQgPT09IGspKSBtYXRjaGVzLnB1c2goZWwpO1xuICAgIGlmIChtYXRjaGVzLmxlbmd0aCA+IDUwKSBicmVhaztcbiAgfVxuICBpZiAobWF0Y2hlcy5sZW5ndGggPj0gMikge1xuICAgIGxldCBub2RlOiBIVE1MRWxlbWVudCB8IG51bGwgPSBtYXRjaGVzWzBdLnBhcmVudEVsZW1lbnQ7XG4gICAgd2hpbGUgKG5vZGUpIHtcbiAgICAgIGxldCBjb3VudCA9IDA7XG4gICAgICBmb3IgKGNvbnN0IG0gb2YgbWF0Y2hlcykgaWYgKG5vZGUuY29udGFpbnMobSkpIGNvdW50Kys7XG4gICAgICBpZiAoY291bnQgPj0gTWF0aC5taW4oMywgbWF0Y2hlcy5sZW5ndGgpKSByZXR1cm4gbm9kZTtcbiAgICAgIG5vZGUgPSBub2RlLnBhcmVudEVsZW1lbnQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBmaW5kQ29udGVudEFyZWEoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICBpZiAoIXNpZGViYXIpIHJldHVybiBudWxsO1xuICBsZXQgcGFyZW50ID0gc2lkZWJhci5wYXJlbnRFbGVtZW50O1xuICB3aGlsZSAocGFyZW50KSB7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKHBhcmVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgaWYgKGNoaWxkID09PSBzaWRlYmFyIHx8IGNoaWxkLmNvbnRhaW5zKHNpZGViYXIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHIgPSBjaGlsZC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIGlmIChyLndpZHRoID4gMzAwICYmIHIuaGVpZ2h0ID4gMjAwKSByZXR1cm4gY2hpbGQ7XG4gICAgfVxuICAgIHBhcmVudCA9IHBhcmVudC5wYXJlbnRFbGVtZW50O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBtYXliZUR1bXBEb20oKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICAgIGlmIChzaWRlYmFyICYmICFzdGF0ZS5zaWRlYmFyRHVtcGVkKSB7XG4gICAgICBzdGF0ZS5zaWRlYmFyRHVtcGVkID0gdHJ1ZTtcbiAgICAgIGNvbnN0IHNiUm9vdCA9IHNpZGViYXIucGFyZW50RWxlbWVudCA/PyBzaWRlYmFyO1xuICAgICAgcGxvZyhgY29kZXggc2lkZWJhciBIVE1MYCwgc2JSb290Lm91dGVySFRNTC5zbGljZSgwLCAzMjAwMCkpO1xuICAgIH1cbiAgICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gICAgaWYgKCFjb250ZW50KSB7XG4gICAgICBpZiAoc3RhdGUuZmluZ2VycHJpbnQgIT09IGxvY2F0aW9uLmhyZWYpIHtcbiAgICAgICAgc3RhdGUuZmluZ2VycHJpbnQgPSBsb2NhdGlvbi5ocmVmO1xuICAgICAgICBwbG9nKFwiZG9tIHByb2JlIChubyBjb250ZW50KVwiLCB7XG4gICAgICAgICAgdXJsOiBsb2NhdGlvbi5ocmVmLFxuICAgICAgICAgIHNpZGViYXI6IHNpZGViYXIgPyBkZXNjcmliZShzaWRlYmFyKSA6IG51bGwsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgcGFuZWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHAgPT09IFwidHdlYWtzLXBhbmVsXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNoaWxkLnN0eWxlLmRpc3BsYXkgPT09IFwibm9uZVwiKSBjb250aW51ZTtcbiAgICAgIHBhbmVsID0gY2hpbGQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY29uc3QgYWN0aXZlTmF2ID0gc2lkZWJhclxuICAgICAgPyBBcnJheS5mcm9tKHNpZGViYXIucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJidXR0b24sIGFcIikpLmZpbmQoXG4gICAgICAgICAgKGIpID0+XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIgfHxcbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiZGF0YS1hY3RpdmVcIikgPT09IFwidHJ1ZVwiIHx8XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImFyaWEtc2VsZWN0ZWRcIikgPT09IFwidHJ1ZVwiIHx8XG4gICAgICAgICAgICBiLmNsYXNzTGlzdC5jb250YWlucyhcImFjdGl2ZVwiKSxcbiAgICAgICAgKVxuICAgICAgOiBudWxsO1xuICAgIGNvbnN0IGhlYWRpbmcgPSBwYW5lbD8ucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXG4gICAgICBcImgxLCBoMiwgaDMsIFtjbGFzcyo9J2hlYWRpbmcnXVwiLFxuICAgICk7XG4gICAgY29uc3QgZmluZ2VycHJpbnQgPSBgJHthY3RpdmVOYXY/LnRleHRDb250ZW50ID8/IFwiXCJ9fCR7aGVhZGluZz8udGV4dENvbnRlbnQgPz8gXCJcIn18JHtwYW5lbD8uY2hpbGRyZW4ubGVuZ3RoID8/IDB9YDtcbiAgICBpZiAoc3RhdGUuZmluZ2VycHJpbnQgPT09IGZpbmdlcnByaW50KSByZXR1cm47XG4gICAgc3RhdGUuZmluZ2VycHJpbnQgPSBmaW5nZXJwcmludDtcbiAgICBwbG9nKFwiZG9tIHByb2JlXCIsIHtcbiAgICAgIHVybDogbG9jYXRpb24uaHJlZixcbiAgICAgIGFjdGl2ZU5hdjogYWN0aXZlTmF2Py50ZXh0Q29udGVudD8udHJpbSgpID8/IG51bGwsXG4gICAgICBoZWFkaW5nOiBoZWFkaW5nPy50ZXh0Q29udGVudD8udHJpbSgpID8/IG51bGwsXG4gICAgICBjb250ZW50OiBkZXNjcmliZShjb250ZW50KSxcbiAgICB9KTtcbiAgICBpZiAocGFuZWwpIHtcbiAgICAgIGNvbnN0IGh0bWwgPSBwYW5lbC5vdXRlckhUTUw7XG4gICAgICBwbG9nKFxuICAgICAgICBgY29kZXggcGFuZWwgSFRNTCAoJHthY3RpdmVOYXY/LnRleHRDb250ZW50Py50cmltKCkgPz8gXCI/XCJ9KWAsXG4gICAgICAgIGh0bWwuc2xpY2UoMCwgMzIwMDApLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwbG9nKFwiZG9tIHByb2JlIGZhaWxlZFwiLCBTdHJpbmcoZSkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGRlc2NyaWJlKGVsOiBIVE1MRWxlbWVudCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHtcbiAgICB0YWc6IGVsLnRhZ05hbWUsXG4gICAgY2xzOiBlbC5jbGFzc05hbWUuc2xpY2UoMCwgMTIwKSxcbiAgICBpZDogZWwuaWQgfHwgdW5kZWZpbmVkLFxuICAgIGNoaWxkcmVuOiBlbC5jaGlsZHJlbi5sZW5ndGgsXG4gICAgcmVjdDogKCgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIHJldHVybiB7IHc6IE1hdGgucm91bmQoci53aWR0aCksIGg6IE1hdGgucm91bmQoci5oZWlnaHQpIH07XG4gICAgfSkoKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtzUGF0aCgpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fY29kZXhwcF90d2Vha3NfZGlyX18/OiBzdHJpbmcgfSkuX19jb2RleHBwX3R3ZWFrc19kaXJfXyA/P1xuICAgIFwiPHVzZXIgZGlyPi90d2Vha3NcIlxuICApO1xufVxuIiwgIi8qKlxuICogUmVuZGVyZXItc2lkZSB0d2VhayBob3N0LiBXZTpcbiAqICAgMS4gQXNrIG1haW4gZm9yIHRoZSB0d2VhayBsaXN0ICh3aXRoIHJlc29sdmVkIGVudHJ5IHBhdGgpLlxuICogICAyLiBGb3IgZWFjaCByZW5kZXJlci1zY29wZWQgKG9yIFwiYm90aFwiKSB0d2VhaywgZmV0Y2ggaXRzIHNvdXJjZSB2aWEgSVBDXG4gKiAgICAgIGFuZCBleGVjdXRlIGl0IGFzIGEgQ29tbW9uSlMtc2hhcGVkIGZ1bmN0aW9uLlxuICogICAzLiBQcm92aWRlIGl0IHRoZSByZW5kZXJlciBoYWxmIG9mIHRoZSBBUEkuXG4gKlxuICogQ29kZXggcnVucyB0aGUgcmVuZGVyZXIgd2l0aCBzYW5kYm94OiB0cnVlLCBzbyBOb2RlJ3MgYHJlcXVpcmUoKWAgaXNcbiAqIHJlc3RyaWN0ZWQgdG8gYSB0aW55IHdoaXRlbGlzdCAoZWxlY3Ryb24gKyBhIGZldyBwb2x5ZmlsbHMpLiBUaGF0IG1lYW5zIHdlXG4gKiBjYW5ub3QgYHJlcXVpcmUoKWAgYXJiaXRyYXJ5IHR3ZWFrIGZpbGVzIGZyb20gZGlzay4gSW5zdGVhZCB3ZSBwdWxsIHRoZVxuICogc291cmNlIHN0cmluZyBmcm9tIG1haW4gYW5kIGV2YWx1YXRlIGl0IHdpdGggYG5ldyBGdW5jdGlvbmAgaW5zaWRlIHRoZVxuICogcHJlbG9hZCBjb250ZXh0LiBUd2VhayBhdXRob3JzIHdobyBuZWVkIG5wbSBkZXBzIG11c3QgYnVuZGxlIHRoZW0gaW4uXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiwgcmVnaXN0ZXJQYWdlLCBjbGVhclNlY3Rpb25zLCBzZXRMaXN0ZWRUd2Vha3MgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgZmliZXJGb3JOb2RlIH0gZnJvbSBcIi4vcmVhY3QtaG9va1wiO1xuaW1wb3J0IHR5cGUge1xuICBUd2Vha01hbmlmZXN0LFxuICBUd2Vha0FwaSxcbiAgUmVhY3RGaWJlck5vZGUsXG4gIFR3ZWFrLFxufSBmcm9tIFwiQGNvZGV4LXBsdXNwbHVzL3Nka1wiO1xuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICB1cGRhdGU6IHtcbiAgICBjaGVja2VkQXQ6IHN0cmluZztcbiAgICByZXBvOiBzdHJpbmc7XG4gICAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgICBsYXRlc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICAgIGxhdGVzdFRhZzogc3RyaW5nIHwgbnVsbDtcbiAgICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICAgIHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgfSB8IG51bGw7XG59XG5cbmludGVyZmFjZSBVc2VyUGF0aHMge1xuICB1c2VyUm9vdDogc3RyaW5nO1xuICBydW50aW1lRGlyOiBzdHJpbmc7XG4gIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICBsb2dEaXI6IHN0cmluZztcbn1cblxuY29uc3QgbG9hZGVkID0gbmV3IE1hcDxzdHJpbmcsIHsgc3RvcD86ICgpID0+IHZvaWQgfT4oKTtcbmxldCBjYWNoZWRQYXRoczogVXNlclBhdGhzIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydFR3ZWFrSG9zdCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHdlYWtzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6bGlzdC10d2Vha3NcIikpIGFzIExpc3RlZFR3ZWFrW107XG4gIGNvbnN0IHBhdGhzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dXNlci1wYXRoc1wiKSkgYXMgVXNlclBhdGhzO1xuICBjYWNoZWRQYXRocyA9IHBhdGhzO1xuICAvLyBQdXNoIHRoZSBsaXN0IHRvIHRoZSBzZXR0aW5ncyBpbmplY3RvciBzbyB0aGUgVHdlYWtzIHBhZ2UgY2FuIHJlbmRlclxuICAvLyBjYXJkcyBldmVuIGJlZm9yZSBhbnkgdHdlYWsncyBzdGFydCgpIHJ1bnMgKGFuZCBmb3IgZGlzYWJsZWQgdHdlYWtzXG4gIC8vIHRoYXQgd2UgbmV2ZXIgbG9hZCkuXG4gIHNldExpc3RlZFR3ZWFrcyh0d2Vha3MpO1xuICAvLyBTdGFzaCBmb3IgdGhlIHNldHRpbmdzIGluamVjdG9yJ3MgZW1wdHktc3RhdGUgbWVzc2FnZS5cbiAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19jb2RleHBwX3R3ZWFrc19kaXJfXz86IHN0cmluZyB9KS5fX2NvZGV4cHBfdHdlYWtzX2Rpcl9fID1cbiAgICBwYXRocy50d2Vha3NEaXI7XG5cbiAgZm9yIChjb25zdCB0IG9mIHR3ZWFrcykge1xuICAgIGlmICh0Lm1hbmlmZXN0LnNjb3BlID09PSBcIm1haW5cIikgY29udGludWU7XG4gICAgaWYgKCF0LmVudHJ5RXhpc3RzKSBjb250aW51ZTtcbiAgICBpZiAoIXQuZW5hYmxlZCkgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGxvYWRUd2Vhayh0LCBwYXRocyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihcIltjb2RleC1wbHVzcGx1c10gdHdlYWsgbG9hZCBmYWlsZWQ6XCIsIHQubWFuaWZlc3QuaWQsIGUpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnNvbGUuaW5mbyhcbiAgICBgW2NvZGV4LXBsdXNwbHVzXSByZW5kZXJlciBob3N0IGxvYWRlZCAke2xvYWRlZC5zaXplfSB0d2VhayhzKTpgLFxuICAgIFsuLi5sb2FkZWQua2V5cygpXS5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIixcbiAgKTtcbiAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICBcImNvZGV4cHA6cHJlbG9hZC1sb2dcIixcbiAgICBcImluZm9cIixcbiAgICBgcmVuZGVyZXIgaG9zdCBsb2FkZWQgJHtsb2FkZWQuc2l6ZX0gdHdlYWsocyk6ICR7Wy4uLmxvYWRlZC5rZXlzKCldLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwifWAsXG4gICk7XG59XG5cbi8qKlxuICogU3RvcCBldmVyeSByZW5kZXJlci1zY29wZSB0d2VhayBzbyBhIHN1YnNlcXVlbnQgYHN0YXJ0VHdlYWtIb3N0KClgIHdpbGxcbiAqIHJlLWV2YWx1YXRlIGZyZXNoIHNvdXJjZS4gTW9kdWxlIGNhY2hlIGlzbid0IHJlbGV2YW50IHNpbmNlIHdlIGV2YWxcbiAqIHNvdXJjZSBzdHJpbmdzIGRpcmVjdGx5IFx1MjAxNCBlYWNoIGxvYWQgY3JlYXRlcyBhIGZyZXNoIHNjb3BlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGVhcmRvd25Ud2Vha0hvc3QoKTogdm9pZCB7XG4gIGZvciAoY29uc3QgW2lkLCB0XSBvZiBsb2FkZWQpIHtcbiAgICB0cnkge1xuICAgICAgdC5zdG9wPy4oKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oXCJbY29kZXgtcGx1c3BsdXNdIHR3ZWFrIHN0b3AgZmFpbGVkOlwiLCBpZCwgZSk7XG4gICAgfVxuICB9XG4gIGxvYWRlZC5jbGVhcigpO1xuICBjbGVhclNlY3Rpb25zKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRUd2Vhayh0OiBMaXN0ZWRUd2VhaywgcGF0aHM6IFVzZXJQYXRocyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzb3VyY2UgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgIFwiY29kZXhwcDpyZWFkLXR3ZWFrLXNvdXJjZVwiLFxuICAgIHQuZW50cnksXG4gICkpIGFzIHN0cmluZztcblxuICAvLyBFdmFsdWF0ZSBhcyBDSlMtc2hhcGVkOiBwcm92aWRlIG1vZHVsZS9leHBvcnRzL2FwaS4gVHdlYWsgY29kZSBtYXkgdXNlXG4gIC8vIGBtb2R1bGUuZXhwb3J0cyA9IHsgc3RhcnQsIHN0b3AgfWAgb3IgYGV4cG9ydHMuc3RhcnQgPSAuLi5gIG9yIHB1cmUgRVNNXG4gIC8vIGRlZmF1bHQgZXhwb3J0IHNoYXBlICh3ZSBhY2NlcHQgYm90aCkuXG4gIGNvbnN0IG1vZHVsZSA9IHsgZXhwb3J0czoge30gYXMgeyBkZWZhdWx0PzogVHdlYWsgfSAmIFR3ZWFrIH07XG4gIGNvbnN0IGV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cztcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1pbXBsaWVkLWV2YWwsIG5vLW5ldy1mdW5jXG4gIGNvbnN0IGZuID0gbmV3IEZ1bmN0aW9uKFxuICAgIFwibW9kdWxlXCIsXG4gICAgXCJleHBvcnRzXCIsXG4gICAgXCJjb25zb2xlXCIsXG4gICAgYCR7c291cmNlfVxcbi8vIyBzb3VyY2VVUkw9Y29kZXhwcC10d2VhazovLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQubWFuaWZlc3QuaWQpfS8ke2VuY29kZVVSSUNvbXBvbmVudCh0LmVudHJ5KX1gLFxuICApO1xuICBmbihtb2R1bGUsIGV4cG9ydHMsIGNvbnNvbGUpO1xuICBjb25zdCBtb2QgPSBtb2R1bGUuZXhwb3J0cyBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWs7XG4gIGNvbnN0IHR3ZWFrOiBUd2VhayA9IChtb2QgYXMgeyBkZWZhdWx0PzogVHdlYWsgfSkuZGVmYXVsdCA/PyAobW9kIGFzIFR3ZWFrKTtcbiAgaWYgKHR5cGVvZiB0d2Vhaz8uc3RhcnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgdHdlYWsgJHt0Lm1hbmlmZXN0LmlkfSBoYXMgbm8gc3RhcnQoKWApO1xuICB9XG4gIGNvbnN0IGFwaSA9IG1ha2VSZW5kZXJlckFwaSh0Lm1hbmlmZXN0LCBwYXRocyk7XG4gIGF3YWl0IHR3ZWFrLnN0YXJ0KGFwaSk7XG4gIGxvYWRlZC5zZXQodC5tYW5pZmVzdC5pZCwgeyBzdG9wOiB0d2Vhay5zdG9wPy5iaW5kKHR3ZWFrKSB9KTtcbn1cblxuZnVuY3Rpb24gbWFrZVJlbmRlcmVyQXBpKG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LCBwYXRoczogVXNlclBhdGhzKTogVHdlYWtBcGkge1xuICBjb25zdCBpZCA9IG1hbmlmZXN0LmlkO1xuICBjb25zdCBsb2cgPSAobGV2ZWw6IFwiZGVidWdcIiB8IFwiaW5mb1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIC4uLmE6IHVua25vd25bXSkgPT4ge1xuICAgIGNvbnN0IGNvbnNvbGVGbiA9XG4gICAgICBsZXZlbCA9PT0gXCJkZWJ1Z1wiID8gY29uc29sZS5kZWJ1Z1xuICAgICAgOiBsZXZlbCA9PT0gXCJ3YXJuXCIgPyBjb25zb2xlLndhcm5cbiAgICAgIDogbGV2ZWwgPT09IFwiZXJyb3JcIiA/IGNvbnNvbGUuZXJyb3JcbiAgICAgIDogY29uc29sZS5sb2c7XG4gICAgY29uc29sZUZuKGBbY29kZXgtcGx1c3BsdXNdWyR7aWR9XWAsIC4uLmEpO1xuICAgIC8vIEFsc28gbWlycm9yIHRvIG1haW4ncyBsb2cgZmlsZSBzbyB3ZSBjYW4gZGlhZ25vc2UgdHdlYWsgYmVoYXZpb3JcbiAgICAvLyB3aXRob3V0IGF0dGFjaGluZyBEZXZUb29scy4gU3RyaW5naWZ5IGVhY2ggYXJnIGRlZmVuc2l2ZWx5LlxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJ0cyA9IGEubWFwKCh2KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHY7XG4gICAgICAgIGlmICh2IGluc3RhbmNlb2YgRXJyb3IpIHJldHVybiBgJHt2Lm5hbWV9OiAke3YubWVzc2FnZX1gO1xuICAgICAgICB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkodik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKHYpOyB9XG4gICAgICB9KTtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgICAgICBsZXZlbCxcbiAgICAgICAgYFt0d2VhayAke2lkfV0gJHtwYXJ0cy5qb2luKFwiIFwiKX1gLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHN3YWxsb3cgXHUyMDE0IG5ldmVyIGxldCBsb2dnaW5nIGJyZWFrIGEgdHdlYWsgKi9cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgZ2l0ID0gbWFuaWZlc3QucGVybWlzc2lvbnM/LmluY2x1ZGVzKFwiZ2l0Lm1ldGFkYXRhXCIpID8gcmVuZGVyZXJHaXQoKSA6IHVuZGVmaW5lZDtcblxuICByZXR1cm4ge1xuICAgIG1hbmlmZXN0LFxuICAgIHByb2Nlc3M6IFwicmVuZGVyZXJcIixcbiAgICBsb2c6IHtcbiAgICAgIGRlYnVnOiAoLi4uYSkgPT4gbG9nKFwiZGVidWdcIiwgLi4uYSksXG4gICAgICBpbmZvOiAoLi4uYSkgPT4gbG9nKFwiaW5mb1wiLCAuLi5hKSxcbiAgICAgIHdhcm46ICguLi5hKSA9PiBsb2coXCJ3YXJuXCIsIC4uLmEpLFxuICAgICAgZXJyb3I6ICguLi5hKSA9PiBsb2coXCJlcnJvclwiLCAuLi5hKSxcbiAgICB9LFxuICAgIHN0b3JhZ2U6IHJlbmRlcmVyU3RvcmFnZShpZCksXG4gICAgc2V0dGluZ3M6IHtcbiAgICAgIHJlZ2lzdGVyOiAocykgPT4gcmVnaXN0ZXJTZWN0aW9uKHsgLi4ucywgaWQ6IGAke2lkfToke3MuaWR9YCB9KSxcbiAgICAgIHJlZ2lzdGVyUGFnZTogKHApID0+XG4gICAgICAgIHJlZ2lzdGVyUGFnZShpZCwgbWFuaWZlc3QsIHsgLi4ucCwgaWQ6IGAke2lkfToke3AuaWR9YCB9KSxcbiAgICB9LFxuICAgIHJlYWN0OiB7XG4gICAgICBnZXRGaWJlcjogKG4pID0+IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGwsXG4gICAgICBmaW5kT3duZXJCeU5hbWU6IChuLCBuYW1lKSA9PiB7XG4gICAgICAgIGxldCBmID0gZmliZXJGb3JOb2RlKG4pIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbDtcbiAgICAgICAgd2hpbGUgKGYpIHtcbiAgICAgICAgICBjb25zdCB0ID0gZi50eXBlIGFzIHsgZGlzcGxheU5hbWU/OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB8IG51bGw7XG4gICAgICAgICAgaWYgKHQgJiYgKHQuZGlzcGxheU5hbWUgPT09IG5hbWUgfHwgdC5uYW1lID09PSBuYW1lKSkgcmV0dXJuIGY7XG4gICAgICAgICAgZiA9IGYucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfSxcbiAgICAgIHdhaXRGb3JFbGVtZW50OiAoc2VsLCB0aW1lb3V0TXMgPSA1MDAwKSA9PlxuICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7XG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSByZXR1cm4gcmVzb2x2ZShleGlzdGluZyk7XG4gICAgICAgICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgdGltZW91dE1zO1xuICAgICAgICAgIGNvbnN0IG9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgICAgaWYgKGVsKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlc29sdmUoZWwpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChEYXRlLm5vdygpID4gZGVhZGxpbmUpIHtcbiAgICAgICAgICAgICAgb2JzLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgdGltZW91dCB3YWl0aW5nIGZvciAke3NlbH1gKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgICAgICAgfSksXG4gICAgfSxcbiAgICBpcGM6IHtcbiAgICAgIG9uOiAoYywgaCkgPT4ge1xuICAgICAgICBjb25zdCB3cmFwcGVkID0gKF9lOiB1bmtub3duLCAuLi5hcmdzOiB1bmtub3duW10pID0+IGgoLi4uYXJncyk7XG4gICAgICAgIGlwY1JlbmRlcmVyLm9uKGBjb2RleHBwOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGBjb2RleHBwOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgIH0sXG4gICAgICBzZW5kOiAoYywgLi4uYXJncykgPT4gaXBjUmVuZGVyZXIuc2VuZChgY29kZXhwcDoke2lkfToke2N9YCwgLi4uYXJncyksXG4gICAgICBpbnZva2U6IDxUPihjOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKGBjb2RleHBwOiR7aWR9OiR7Y31gLCAuLi5hcmdzKSBhcyBQcm9taXNlPFQ+LFxuICAgIH0sXG4gICAgZnM6IHJlbmRlcmVyRnMoaWQsIHBhdGhzKSxcbiAgICAuLi4oZ2l0ID8geyBnaXQgfSA6IHt9KSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJTdG9yYWdlKGlkOiBzdHJpbmcpIHtcbiAgY29uc3Qga2V5ID0gYGNvZGV4cHA6c3RvcmFnZToke2lkfWA7XG4gIGNvbnN0IHJlYWQgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpID8/IFwie31cIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICB9O1xuICBjb25zdCB3cml0ZSA9ICh2OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT5cbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHYpKTtcbiAgcmV0dXJuIHtcbiAgICBnZXQ6IDxUPihrOiBzdHJpbmcsIGQ/OiBUKSA9PiAoayBpbiByZWFkKCkgPyAocmVhZCgpW2tdIGFzIFQpIDogKGQgYXMgVCkpLFxuICAgIHNldDogKGs6IHN0cmluZywgdjogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbyA9IHJlYWQoKTtcbiAgICAgIG9ba10gPSB2O1xuICAgICAgd3JpdGUobyk7XG4gICAgfSxcbiAgICBkZWxldGU6IChrOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IG8gPSByZWFkKCk7XG4gICAgICBkZWxldGUgb1trXTtcbiAgICAgIHdyaXRlKG8pO1xuICAgIH0sXG4gICAgYWxsOiAoKSA9PiByZWFkKCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyRnMoaWQ6IHN0cmluZywgX3BhdGhzOiBVc2VyUGF0aHMpIHtcbiAgLy8gU2FuZGJveGVkIHJlbmRlcmVyIGNhbid0IHVzZSBOb2RlIGZzIGRpcmVjdGx5IFx1MjAxNCBwcm94eSB0aHJvdWdoIG1haW4gSVBDLlxuICByZXR1cm4ge1xuICAgIGRhdGFEaXI6IGA8cmVtb3RlPi90d2Vhay1kYXRhLyR7aWR9YCxcbiAgICByZWFkOiAocDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcInJlYWRcIiwgaWQsIHApIGFzIFByb21pc2U8c3RyaW5nPixcbiAgICB3cml0ZTogKHA6IHN0cmluZywgYzogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcIndyaXRlXCIsIGlkLCBwLCBjKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGV4aXN0czogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dHdlYWstZnNcIiwgXCJleGlzdHNcIiwgaWQsIHApIGFzIFByb21pc2U8Ym9vbGVhbj4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyR2l0KCkge1xuICByZXR1cm4ge1xuICAgIHJlc29sdmVSZXBvc2l0b3J5OiAocGF0aDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnaXQtcmVzb2x2ZS1yZXBvc2l0b3J5XCIsIHBhdGgpLFxuICAgIGdldFN0YXR1czogKHBhdGg6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LXN0YXR1c1wiLCBwYXRoKSxcbiAgICBnZXREaWZmU3VtbWFyeTogKHBhdGg6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LWRpZmYtc3VtbWFyeVwiLCBwYXRoKSxcbiAgICBnZXRXb3JrdHJlZXM6IChwYXRoOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdpdC13b3JrdHJlZXNcIiwgcGF0aCksXG4gIH07XG59XG4iLCAiLyoqXG4gKiBCdWlsdC1pbiBcIlR3ZWFrIE1hbmFnZXJcIiBcdTIwMTQgYXV0by1pbmplY3RlZCBieSB0aGUgcnVudGltZSwgbm90IGEgdXNlciB0d2Vhay5cbiAqIExpc3RzIGRpc2NvdmVyZWQgdHdlYWtzIHdpdGggZW5hYmxlIHRvZ2dsZXMsIG9wZW5zIHRoZSB0d2Vha3MgZGlyLCBsaW5rc1xuICogdG8gbG9ncyBhbmQgY29uZmlnLiBMaXZlcyBpbiB0aGUgcmVuZGVyZXIuXG4gKlxuICogVGhpcyBpcyBpbnZva2VkIGZyb20gcHJlbG9hZC9pbmRleC50cyBBRlRFUiB1c2VyIHR3ZWFrcyBhcmUgbG9hZGVkIHNvIGl0XG4gKiBjYW4gc2hvdyB1cC10by1kYXRlIHN0YXR1cy5cbiAqL1xuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtb3VudE1hbmFnZXIoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmxpc3QtdHdlYWtzXCIpKSBhcyBBcnJheTx7XG4gICAgbWFuaWZlc3Q6IHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nIH07XG4gICAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIH0+O1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnVzZXItcGF0aHNcIikpIGFzIHtcbiAgICB1c2VyUm9vdDogc3RyaW5nO1xuICAgIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICAgIGxvZ0Rpcjogc3RyaW5nO1xuICB9O1xuXG4gIHJlZ2lzdGVyU2VjdGlvbih7XG4gICAgaWQ6IFwiY29kZXgtcGx1c3BsdXM6bWFuYWdlclwiLFxuICAgIHRpdGxlOiBcIlR3ZWFrIE1hbmFnZXJcIixcbiAgICBkZXNjcmlwdGlvbjogYCR7dHdlYWtzLmxlbmd0aH0gdHdlYWsocykgaW5zdGFsbGVkLiBVc2VyIGRpcjogJHtwYXRocy51c2VyUm9vdH1gLFxuICAgIHJlbmRlcihyb290KSB7XG4gICAgICByb290LnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweDtcIjtcblxuICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBhY3Rpb25zLnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO1wiO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiB0d2Vha3MgZm9sZGVyXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMudHdlYWtzRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiBsb2dzXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMubG9nRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiUmVsb2FkIHdpbmRvd1wiLCAoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSksXG4gICAgICApO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAgICAgaWYgKHR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICAgICAgZW1wdHkuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEzcHggc3lzdGVtLXVpO21hcmdpbjo4cHggMDtcIjtcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPVxuICAgICAgICAgIFwiTm8gdXNlciB0d2Vha3MgeWV0LiBEcm9wIGEgZm9sZGVyIHdpdGggbWFuaWZlc3QuanNvbiArIGluZGV4LmpzIGludG8gdGhlIHR3ZWFrcyBkaXIsIHRoZW4gcmVsb2FkLlwiO1xuICAgICAgICByb290LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInVsXCIpO1xuICAgICAgbGlzdC5zdHlsZS5jc3NUZXh0ID0gXCJsaXN0LXN0eWxlOm5vbmU7bWFyZ2luOjA7cGFkZGluZzowO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjZweDtcIjtcbiAgICAgIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICAgIGxpLnN0eWxlLmNzc1RleHQgPVxuICAgICAgICAgIFwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjhweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMyYTJhMmEpO2JvcmRlci1yYWRpdXM6NnB4O1wiO1xuICAgICAgICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgbGVmdC5pbm5lckhUTUwgPSBgXG4gICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQ6NjAwIDEzcHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QubmFtZSl9IDxzcGFuIHN0eWxlPVwiY29sb3I6Izg4ODtmb250LXdlaWdodDo0MDA7XCI+diR7ZXNjYXBlKHQubWFuaWZlc3QudmVyc2lvbil9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5kZXNjcmlwdGlvbiA/PyB0Lm1hbmlmZXN0LmlkKX08L2Rpdj5cbiAgICAgICAgYDtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICByaWdodC5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI7XG4gICAgICAgIHJpZ2h0LnRleHRDb250ZW50ID0gdC5lbnRyeUV4aXN0cyA/IFwibG9hZGVkXCIgOiBcIm1pc3NpbmcgZW50cnlcIjtcbiAgICAgICAgbGkuYXBwZW5kKGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgbGlzdC5hcHBlbmQobGkpO1xuICAgICAgfVxuICAgICAgcm9vdC5hcHBlbmQobGlzdCk7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbmNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBiLnN0eWxlLmNzc1RleHQgPVxuICAgIFwicGFkZGluZzo2cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMzMzKTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOmluaGVyaXQ7Zm9udDoxMnB4IHN5c3RlbS11aTtjdXJzb3I6cG9pbnRlcjtcIjtcbiAgYi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25jbGljayk7XG4gIHJldHVybiBiO1xufVxuXG5mdW5jdGlvbiBlc2NhcGUoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+XG4gICAgYyA9PT0gXCImXCJcbiAgICAgID8gXCImYW1wO1wiXG4gICAgICA6IGMgPT09IFwiPFwiXG4gICAgICAgID8gXCImbHQ7XCJcbiAgICAgICAgOiBjID09PSBcIj5cIlxuICAgICAgICAgID8gXCImZ3Q7XCJcbiAgICAgICAgICA6IGMgPT09ICdcIidcbiAgICAgICAgICAgID8gXCImcXVvdDtcIlxuICAgICAgICAgICAgOiBcIiYjMzk7XCIsXG4gICk7XG59XG4iLCAiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcblxuY29uc3QgQ09ERVhfTUVTU0FHRV9GUk9NX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mcm9tLXZpZXdcIjtcbmNvbnN0IENPREVYX01FU1NBR0VfRk9SX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mb3Itdmlld1wiO1xuY29uc3QgREVGQVVMVF9SRVFVRVNUX1RJTUVPVVRfTVMgPSAxMl8wMDA7XG5cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgZWxlY3Ryb25CcmlkZ2U/OiB7XG4gICAgICBzZW5kTWVzc2FnZUZyb21WaWV3PyhtZXNzYWdlOiB1bmtub3duKTogUHJvbWlzZTx2b2lkPjtcbiAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwU2VydmVyUmVxdWVzdE9wdGlvbnMge1xuICBob3N0SWQ/OiBzdHJpbmc7XG4gIHRpbWVvdXRNcz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBTZXJ2ZXJOb3RpZmljYXRpb24ge1xuICBtZXRob2Q6IHN0cmluZztcbiAgcGFyYW1zOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ1JlcXVlc3Qge1xuICBpZDogc3RyaW5nO1xuICByZXNvbHZlKHZhbHVlOiB1bmtub3duKTogdm9pZDtcbiAgcmVqZWN0KGVycm9yOiBFcnJvcik6IHZvaWQ7XG4gIHRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+O1xufVxuXG5sZXQgbmV4dFJlcXVlc3RJZCA9IDE7XG5jb25zdCBwZW5kaW5nUmVxdWVzdHMgPSBuZXcgTWFwPHN0cmluZywgUGVuZGluZ1JlcXVlc3Q+KCk7XG5jb25zdCBub3RpZmljYXRpb25MaXN0ZW5lcnMgPSBuZXcgU2V0PChub3RpZmljYXRpb246IEFwcFNlcnZlck5vdGlmaWNhdGlvbikgPT4gdm9pZD4oKTtcbmxldCBzdWJzY3JpYmVkID0gZmFsc2U7XG5cbmV4cG9ydCBmdW5jdGlvbiByZXF1ZXN0QXBwU2VydmVyPFQ+KFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGFyYW1zOiB1bmtub3duLFxuICBvcHRpb25zOiBBcHBTZXJ2ZXJSZXF1ZXN0T3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxUPiB7XG4gIGVuc3VyZVN1YnNjcmliZWQoKTtcbiAgY29uc3QgaWQgPSBgY29kZXhwcC0ke0RhdGUubm93KCl9LSR7bmV4dFJlcXVlc3RJZCsrfWA7XG4gIGNvbnN0IGhvc3RJZCA9IG9wdGlvbnMuaG9zdElkID8/IHJlYWRIb3N0SWQoKTtcbiAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0TXMgPz8gREVGQVVMVF9SRVFVRVNUX1RJTUVPVVRfTVM7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlPFQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgICAgIHJlamVjdChuZXcgRXJyb3IoYFRpbWVkIG91dCB3YWl0aW5nIGZvciBhcHAtc2VydmVyIHJlc3BvbnNlIHRvICR7bWV0aG9kfWApKTtcbiAgICB9LCB0aW1lb3V0TXMpO1xuXG4gICAgcGVuZGluZ1JlcXVlc3RzLnNldChpZCwge1xuICAgICAgaWQsXG4gICAgICByZXNvbHZlOiAodmFsdWUpID0+IHJlc29sdmUodmFsdWUgYXMgVCksXG4gICAgICByZWplY3QsXG4gICAgICB0aW1lb3V0LFxuICAgIH0pO1xuXG4gICAgY29uc3QgbWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6IFwibWNwLXJlcXVlc3RcIixcbiAgICAgIGhvc3RJZCxcbiAgICAgIHJlcXVlc3Q6IHsgaWQsIG1ldGhvZCwgcGFyYW1zIH0sXG4gICAgfTtcblxuICAgIHNlbmRNZXNzYWdlRnJvbVZpZXcobWVzc2FnZSkudGhlbigocmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAhPT0gdW5kZWZpbmVkKSBoYW5kbGVJbmNvbWluZ01lc3NhZ2UocmVzcG9uc2UpO1xuICAgIH0pLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgY29uc3QgcGVuZGluZyA9IHBlbmRpbmdSZXF1ZXN0cy5nZXQoaWQpO1xuICAgICAgaWYgKCFwZW5kaW5nKSByZXR1cm47XG4gICAgICBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lb3V0KTtcbiAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoaWQpO1xuICAgICAgcGVuZGluZy5yZWplY3QodG9FcnJvcihlcnJvcikpO1xuICAgIH0pO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9uQXBwU2VydmVyTm90aWZpY2F0aW9uKFxuICBsaXN0ZW5lcjogKG5vdGlmaWNhdGlvbjogQXBwU2VydmVyTm90aWZpY2F0aW9uKSA9PiB2b2lkLFxuKTogKCkgPT4gdm9pZCB7XG4gIGVuc3VyZVN1YnNjcmliZWQoKTtcbiAgbm90aWZpY2F0aW9uTGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gIHJldHVybiAoKSA9PiBub3RpZmljYXRpb25MaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWRIb3N0SWQoKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuICAgIGNvbnN0IGhvc3RJZCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiaG9zdElkXCIpPy50cmltKCk7XG4gICAgcmV0dXJuIGhvc3RJZCB8fCBcImxvY2FsXCI7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcImxvY2FsXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW5zdXJlU3Vic2NyaWJlZCgpOiB2b2lkIHtcbiAgaWYgKHN1YnNjcmliZWQpIHJldHVybjtcbiAgc3Vic2NyaWJlZCA9IHRydWU7XG4gIGlwY1JlbmRlcmVyLm9uKENPREVYX01FU1NBR0VfRk9SX1ZJRVcsIChfZXZlbnQsIG1lc3NhZ2UpID0+IHtcbiAgICBoYW5kbGVJbmNvbWluZ01lc3NhZ2UobWVzc2FnZSk7XG4gIH0pO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgKGV2ZW50KSA9PiB7XG4gICAgaGFuZGxlSW5jb21pbmdNZXNzYWdlKGV2ZW50LmRhdGEpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlSW5jb21pbmdNZXNzYWdlKG1lc3NhZ2U6IHVua25vd24pOiB2b2lkIHtcbiAgY29uc3Qgbm90aWZpY2F0aW9uID0gZXh0cmFjdE5vdGlmaWNhdGlvbihtZXNzYWdlKTtcbiAgaWYgKG5vdGlmaWNhdGlvbikge1xuICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2Ygbm90aWZpY2F0aW9uTGlzdGVuZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBsaXN0ZW5lcihub3RpZmljYXRpb24pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGlzb2xhdGUgbGlzdGVuZXIgZmFpbHVyZXMgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCByZXNwb25zZSA9IGV4dHJhY3RSZXNwb25zZShtZXNzYWdlKTtcbiAgaWYgKCFyZXNwb25zZSkgcmV0dXJuO1xuICBjb25zdCBwZW5kaW5nID0gcGVuZGluZ1JlcXVlc3RzLmdldChyZXNwb25zZS5pZCk7XG4gIGlmICghcGVuZGluZykgcmV0dXJuO1xuXG4gIGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVvdXQpO1xuICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKHJlc3BvbnNlLmlkKTtcbiAgaWYgKHJlc3BvbnNlLmVycm9yKSB7XG4gICAgcGVuZGluZy5yZWplY3QocmVzcG9uc2UuZXJyb3IpO1xuICAgIHJldHVybjtcbiAgfVxuICBwZW5kaW5nLnJlc29sdmUocmVzcG9uc2UucmVzdWx0KTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFJlc3BvbnNlKG1lc3NhZ2U6IHVua25vd24pOiB7IGlkOiBzdHJpbmc7IHJlc3VsdD86IHVua25vd247IGVycm9yPzogRXJyb3IgfSB8IG51bGwge1xuICBpZiAoIWlzUmVjb3JkKG1lc3NhZ2UpKSByZXR1cm4gbnVsbDtcblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1yZXNwb25zZVwiICYmIGlzUmVjb3JkKG1lc3NhZ2UucmVzcG9uc2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UucmVzcG9uc2UpO1xuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3AtcmVzcG9uc2VcIiAmJiBpc1JlY29yZChtZXNzYWdlLm1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UubWVzc2FnZSk7XG4gIH1cblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1lcnJvclwiICYmIHR5cGVvZiBtZXNzYWdlLmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHsgaWQ6IG1lc3NhZ2UuaWQsIGVycm9yOiBuZXcgRXJyb3IocmVhZEVycm9yTWVzc2FnZShtZXNzYWdlLmVycm9yKSA/PyBcIkFwcC1zZXJ2ZXIgcmVxdWVzdCBmYWlsZWRcIikgfTtcbiAgfVxuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwicmVzcG9uc2VcIiAmJiB0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIiAmJiAoXCJyZXN1bHRcIiBpbiBtZXNzYWdlIHx8IFwiZXJyb3JcIiBpbiBtZXNzYWdlKSkge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlKTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZXNwb25zZUZyb21FbnZlbG9wZShlbnZlbG9wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB7IGlkOiBzdHJpbmc7IHJlc3VsdD86IHVua25vd247IGVycm9yPzogRXJyb3IgfSB8IG51bGwge1xuICBjb25zdCBpZCA9IHR5cGVvZiBlbnZlbG9wZS5pZCA9PT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgZW52ZWxvcGUuaWQgPT09IFwibnVtYmVyXCJcbiAgICA/IFN0cmluZyhlbnZlbG9wZS5pZClcbiAgICA6IG51bGw7XG4gIGlmICghaWQpIHJldHVybiBudWxsO1xuXG4gIGlmIChcImVycm9yXCIgaW4gZW52ZWxvcGUpIHtcbiAgICByZXR1cm4geyBpZCwgZXJyb3I6IG5ldyBFcnJvcihyZWFkRXJyb3JNZXNzYWdlKGVudmVsb3BlLmVycm9yKSA/PyBcIkFwcC1zZXJ2ZXIgcmVxdWVzdCBmYWlsZWRcIikgfTtcbiAgfVxuXG4gIHJldHVybiB7IGlkLCByZXN1bHQ6IGVudmVsb3BlLnJlc3VsdCB9O1xufVxuXG5mdW5jdGlvbiBleHRyYWN0Tm90aWZpY2F0aW9uKG1lc3NhZ2U6IHVua25vd24pOiBBcHBTZXJ2ZXJOb3RpZmljYXRpb24gfCBudWxsIHtcbiAgaWYgKCFpc1JlY29yZChtZXNzYWdlKSkgcmV0dXJuIG51bGw7XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5yZXF1ZXN0KSkge1xuICAgIGNvbnN0IG1ldGhvZCA9IG1lc3NhZ2UucmVxdWVzdC5tZXRob2Q7XG4gICAgaWYgKHR5cGVvZiBtZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7IG1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnJlcXVlc3QucGFyYW1zIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5tZXNzYWdlKSkge1xuICAgIGNvbnN0IG1ldGhvZCA9IG1lc3NhZ2UubWVzc2FnZS5tZXRob2Q7XG4gICAgaWYgKHR5cGVvZiBtZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7IG1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLm1lc3NhZ2UucGFyYW1zIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgdHlwZW9mIG1lc3NhZ2UubWV0aG9kID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHsgbWV0aG9kOiBtZXNzYWdlLm1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnBhcmFtcyB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBtZXNzYWdlLm1ldGhvZCA9PT0gXCJzdHJpbmdcIiAmJiAhKFwiaWRcIiBpbiBtZXNzYWdlKSkge1xuICAgIHJldHVybiB7IG1ldGhvZDogbWVzc2FnZS5tZXRob2QsIHBhcmFtczogbWVzc2FnZS5wYXJhbXMgfTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZWFkRXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgaWYgKHR5cGVvZiBlcnJvciA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGVycm9yO1xuICBpZiAoaXNSZWNvcmQoZXJyb3IpKSB7XG4gICAgaWYgKHR5cGVvZiBlcnJvci5tZXNzYWdlID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgICBpZiAodHlwZW9mIGVycm9yLmVycm9yID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3IuZXJyb3I7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHNlbmRNZXNzYWdlRnJvbVZpZXcobWVzc2FnZTogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xuICBjb25zdCBicmlkZ2VTZW5kZXIgPSB3aW5kb3cuZWxlY3Ryb25CcmlkZ2U/LnNlbmRNZXNzYWdlRnJvbVZpZXc7XG4gIGlmICh0eXBlb2YgYnJpZGdlU2VuZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICByZXR1cm4gYnJpZGdlU2VuZGVyLmNhbGwod2luZG93LmVsZWN0cm9uQnJpZGdlLCBtZXNzYWdlKS50aGVuKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cbiAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShDT0RFWF9NRVNTQUdFX0ZST01fVklFVywgbWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIHRvRXJyb3IoZXJyb3I6IHVua25vd24pOiBFcnJvciB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSk7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4gdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTtcbn1cbiIsICJpbXBvcnQgeyBvbkFwcFNlcnZlck5vdGlmaWNhdGlvbiwgcmVhZEhvc3RJZCwgcmVxdWVzdEFwcFNlcnZlciB9IGZyb20gXCIuL2FwcC1zZXJ2ZXItYnJpZGdlXCI7XG5cbnR5cGUgR29hbFN0YXR1cyA9IFwiYWN0aXZlXCIgfCBcInBhdXNlZFwiIHwgXCJidWRnZXRMaW1pdGVkXCIgfCBcImNvbXBsZXRlXCI7XG5cbmludGVyZmFjZSBUaHJlYWRHb2FsIHtcbiAgdGhyZWFkSWQ6IHN0cmluZztcbiAgb2JqZWN0aXZlOiBzdHJpbmc7XG4gIHN0YXR1czogR29hbFN0YXR1cztcbiAgdG9rZW5CdWRnZXQ6IG51bWJlciB8IG51bGw7XG4gIHRva2Vuc1VzZWQ6IG51bWJlcjtcbiAgdGltZVVzZWRTZWNvbmRzOiBudW1iZXI7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICB1cGRhdGVkQXQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEdvYWxVaUFjdGlvbiB7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGtpbmQ/OiBcInByaW1hcnlcIiB8IFwiZGFuZ2VyXCI7XG4gIHJ1bigpOiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIEdvYWxQYW5lbE9wdGlvbnMge1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXRhaWw6IHN0cmluZztcbiAgZm9vdGVyPzogc3RyaW5nO1xuICBhY3Rpb25zOiBHb2FsVWlBY3Rpb25bXTtcbiAgcGVyc2lzdGVudDogYm9vbGVhbjtcbiAgZXJyb3I/OiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgR29hbFBhbmVsU3RhdGUge1xuICBjb2xsYXBzZWQ6IGJvb2xlYW47XG4gIHg6IG51bWJlciB8IG51bGw7XG4gIHk6IG51bWJlciB8IG51bGw7XG59XG5cbmludGVyZmFjZSBHb2FsUGFuZWxEcmFnIHtcbiAgcG9pbnRlcklkOiBudW1iZXI7XG4gIG9mZnNldFg6IG51bWJlcjtcbiAgb2Zmc2V0WTogbnVtYmVyO1xuICB3aWR0aDogbnVtYmVyO1xuICBoZWlnaHQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEVkaXRhYmxlVGFyZ2V0IHtcbiAgZWxlbWVudDogSFRNTEVsZW1lbnQ7XG4gIGdldFRleHQoKTogc3RyaW5nO1xuICBzZXRUZXh0KHZhbHVlOiBzdHJpbmcpOiB2b2lkO1xuICBjbGVhcigpOiB2b2lkO1xufVxuXG5sZXQgc3RhcnRlZCA9IGZhbHNlO1xubGV0IHJvb3Q6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgc3VnZ2VzdGlvblJvb3Q6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgY3VycmVudEdvYWw6IFRocmVhZEdvYWwgfCBudWxsID0gbnVsbDtcbmxldCBoaWRlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5sZXQgbGFzdFRocmVhZElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbmxldCBsYXN0UGFuZWxPcHRpb25zOiBHb2FsUGFuZWxPcHRpb25zIHwgbnVsbCA9IG51bGw7XG5sZXQgcGFuZWxEcmFnOiBHb2FsUGFuZWxEcmFnIHwgbnVsbCA9IG51bGw7XG5cbmNvbnN0IEdPQUxfUEFORUxfU1RBVEVfS0VZID0gXCJjb2RleHBwOmdvYWwtcGFuZWwtc3RhdGVcIjtcbmxldCBwYW5lbFN0YXRlOiBHb2FsUGFuZWxTdGF0ZSA9IHJlYWRHb2FsUGFuZWxTdGF0ZSgpO1xuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRHb2FsRmVhdHVyZShsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQgPSAoKSA9PiB7fSk6IHZvaWQge1xuICBpZiAoc3RhcnRlZCkgcmV0dXJuO1xuICBzdGFydGVkID0gdHJ1ZTtcbiAgaW5zdGFsbFN0eWxlcygpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZXZlbnQpID0+IHtcbiAgICB2b2lkIGhhbmRsZUtleWRvd24oZXZlbnQsIGxvZyk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKGV2ZW50KSA9PiB7XG4gICAgdXBkYXRlR29hbFN1Z2dlc3Rpb24oZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50KSk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNpblwiLCAoZXZlbnQpID0+IHtcbiAgICB1cGRhdGVHb2FsU3VnZ2VzdGlvbihmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpKTtcbiAgfSwgdHJ1ZSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICBpZiAoc3VnZ2VzdGlvblJvb3Q/LmNvbnRhaW5zKGV2ZW50LnRhcmdldCBhcyBOb2RlKSkgcmV0dXJuO1xuICAgIHVwZGF0ZUdvYWxTdWdnZXN0aW9uKGZpbmRFZGl0YWJsZVRhcmdldChldmVudCkpO1xuICB9LCB0cnVlKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJyZXNpemVcIiwgKCkgPT4ge1xuICAgIGlmICghcm9vdD8uaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQocm9vdCk7XG4gICAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbiAgfSk7XG4gIG9uQXBwU2VydmVyTm90aWZpY2F0aW9uKChub3RpZmljYXRpb24pID0+IHtcbiAgICBpZiAobm90aWZpY2F0aW9uLm1ldGhvZCA9PT0gXCJ0aHJlYWQvZ29hbC91cGRhdGVkXCIgJiYgaXNSZWNvcmQobm90aWZpY2F0aW9uLnBhcmFtcykpIHtcbiAgICAgIGNvbnN0IGdvYWwgPSBub3RpZmljYXRpb24ucGFyYW1zLmdvYWw7XG4gICAgICBpZiAoaXNUaHJlYWRHb2FsKGdvYWwpKSB7XG4gICAgICAgIGlmIChnb2FsLnRocmVhZElkICE9PSByZWFkVGhyZWFkSWQoKSkgcmV0dXJuO1xuICAgICAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobm90aWZpY2F0aW9uLm1ldGhvZCA9PT0gXCJ0aHJlYWQvZ29hbC9jbGVhcmVkXCIgJiYgaXNSZWNvcmQobm90aWZpY2F0aW9uLnBhcmFtcykpIHtcbiAgICAgIGNvbnN0IHRocmVhZElkID0gbm90aWZpY2F0aW9uLnBhcmFtcy50aHJlYWRJZDtcbiAgICAgIGlmICh0eXBlb2YgdGhyZWFkSWQgPT09IFwic3RyaW5nXCIgJiYgdGhyZWFkSWQgPT09IHJlYWRUaHJlYWRJZCgpKSB7XG4gICAgICAgIGN1cnJlbnRHb2FsID0gbnVsbDtcbiAgICAgICAgcmVuZGVyTm90aWNlKFwiR29hbCBjbGVhcmVkXCIsIFwiVGhpcyB0aHJlYWQgbm8gbG9uZ2VyIGhhcyBhbiBhY3RpdmUgZ29hbC5cIik7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvcHN0YXRlXCIsICgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSk7XG4gIGNvbnN0IHJlZnJlc2hUaW1lciA9IHNldEludGVydmFsKCgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSwgMl81MDApO1xuICBjb25zdCB1bnJlZiA9IChyZWZyZXNoVGltZXIgYXMgdW5rbm93biBhcyB7IHVucmVmPzogKCkgPT4gdm9pZCB9KS51bnJlZjtcbiAgaWYgKHR5cGVvZiB1bnJlZiA9PT0gXCJmdW5jdGlvblwiKSB1bnJlZi5jYWxsKHJlZnJlc2hUaW1lcik7XG4gIHF1ZXVlTWljcm90YXNrKCgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSk7XG4gIGxvZyhcImdvYWwgZmVhdHVyZSBzdGFydGVkXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVLZXlkb3duKGV2ZW50OiBLZXlib2FyZEV2ZW50LCBsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGV2ZW50LmlzQ29tcG9zaW5nKSByZXR1cm47XG5cbiAgY29uc3QgZWRpdGFibGUgPSBmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpO1xuICBpZiAoIWVkaXRhYmxlKSByZXR1cm47XG5cbiAgaWYgKGV2ZW50LmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgIGhpZGVHb2FsU3VnZ2VzdGlvbigpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgoZXZlbnQua2V5ID09PSBcIlRhYlwiIHx8IGV2ZW50LmtleSA9PT0gXCJFbnRlclwiKSAmJiAhZXZlbnQuc2hpZnRLZXkgJiYgIWV2ZW50LmFsdEtleSAmJiAhZXZlbnQuY3RybEtleSAmJiAhZXZlbnQubWV0YUtleSkge1xuICAgIGNvbnN0IHN1Z2dlc3Rpb24gPSBwYXJzZUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLmdldFRleHQoKSk7XG4gICAgaWYgKHN1Z2dlc3Rpb24gJiYgZWRpdGFibGUuZ2V0VGV4dCgpLnRyaW0oKSAhPT0gXCIvZ29hbFwiKSB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIGlmIChldmVudC5rZXkgIT09IFwiRW50ZXJcIiB8fCBldmVudC5zaGlmdEtleSB8fCBldmVudC5hbHRLZXkgfHwgZXZlbnQuY3RybEtleSB8fCBldmVudC5tZXRhS2V5KSByZXR1cm47XG5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VHb2FsQ29tbWFuZChlZGl0YWJsZS5nZXRUZXh0KCkpO1xuICBpZiAoIXBhcnNlZCkgcmV0dXJuO1xuXG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICBldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgZWRpdGFibGUuY2xlYXIoKTtcbiAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBydW5Hb2FsQ29tbWFuZChwYXJzZWQuYXJncywgbG9nKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBsb2coXCJnb2FsIGNvbW1hbmQgZmFpbGVkXCIsIHN0cmluZ2lmeUVycm9yKGVycm9yKSk7XG4gICAgcmVuZGVyRXJyb3IoXCJHb2FsIGNvbW1hbmQgZmFpbGVkXCIsIGZyaWVuZGx5R29hbEVycm9yKGVycm9yKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcGFyc2VHb2FsQ29tbWFuZCh0ZXh0OiBzdHJpbmcpOiB7IGFyZ3M6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gdGV4dC50cmltKCkubWF0Y2goL15cXC9nb2FsKD86XFxzKyhbXFxzXFxTXSopKT8kLyk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhcmdzOiAobWF0Y2hbMV0gPz8gXCJcIikudHJpbSgpIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlR29hbFN1Z2dlc3Rpb24odGV4dDogc3RyaW5nKTogeyBxdWVyeTogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSB0ZXh0LnRyaW0oKS5tYXRjaCgvXlxcLyhbYS16XSopJC9pKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHF1ZXJ5ID0gbWF0Y2hbMV0/LnRvTG93ZXJDYXNlKCkgPz8gXCJcIjtcbiAgcmV0dXJuIFwiZ29hbFwiLnN0YXJ0c1dpdGgocXVlcnkpID8geyBxdWVyeSB9IDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuR29hbENvbW1hbmQoYXJnczogc3RyaW5nLCBsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKTtcbiAgaWYgKCF0aHJlYWRJZCkge1xuICAgIHJlbmRlckVycm9yKFwiTm8gYWN0aXZlIHRocmVhZFwiLCBcIk9wZW4gYSBsb2NhbCB0aHJlYWQgYmVmb3JlIHVzaW5nIC9nb2FsLlwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgaG9zdElkID0gcmVhZEhvc3RJZCgpO1xuICBjb25zdCBsb3dlciA9IGFyZ3MudG9Mb3dlckNhc2UoKTtcblxuICBpZiAoIWFyZ3MpIHtcbiAgICBjb25zdCBnb2FsID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgaG9zdElkKTtcbiAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgaWYgKGdvYWwpIHtcbiAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICByZW5kZXJOb3RpY2UoXCJObyBnb2FsIHNldFwiLCBcIlVzZSAvZ29hbCA8b2JqZWN0aXZlPiB0byBzZXQgb25lIGZvciB0aGlzIHRocmVhZC5cIik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChsb3dlciA9PT0gXCJjbGVhclwiKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgY2xlYXJlZDogYm9vbGVhbiB9PihcbiAgICAgIFwidGhyZWFkL2dvYWwvY2xlYXJcIixcbiAgICAgIHsgdGhyZWFkSWQgfSxcbiAgICAgIHsgaG9zdElkIH0sXG4gICAgKTtcbiAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgcmVuZGVyTm90aWNlKHJlc3BvbnNlLmNsZWFyZWQgPyBcIkdvYWwgY2xlYXJlZFwiIDogXCJObyBnb2FsIHNldFwiLCBcIlVzZSAvZ29hbCA8b2JqZWN0aXZlPiB0byBzZXQgYSBuZXcgZ29hbC5cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGxvd2VyID09PSBcInBhdXNlXCIgfHwgbG93ZXIgPT09IFwicmVzdW1lXCIgfHwgbG93ZXIgPT09IFwiY29tcGxldGVcIikge1xuICAgIGNvbnN0IHN0YXR1czogR29hbFN0YXR1cyA9IGxvd2VyID09PSBcInBhdXNlXCIgPyBcInBhdXNlZFwiIDogbG93ZXIgPT09IFwicmVzdW1lXCIgPyBcImFjdGl2ZVwiIDogXCJjb21wbGV0ZVwiO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgICBcInRocmVhZC9nb2FsL3NldFwiLFxuICAgICAgeyB0aHJlYWRJZCwgc3RhdHVzIH0sXG4gICAgICB7IGhvc3RJZCB9LFxuICAgICk7XG4gICAgY3VycmVudEdvYWwgPSByZXNwb25zZS5nb2FsO1xuICAgIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgaG9zdElkKTtcbiAgaWYgKGV4aXN0aW5nICYmIGV4aXN0aW5nLm9iamVjdGl2ZSAhPT0gYXJncykge1xuICAgIGNvbnN0IHJlcGxhY2UgPSBhd2FpdCBjb25maXJtUmVwbGFjZUdvYWwoZXhpc3RpbmcsIGFyZ3MpO1xuICAgIGlmICghcmVwbGFjZSkge1xuICAgICAgY3VycmVudEdvYWwgPSBleGlzdGluZztcbiAgICAgIHJlbmRlckdvYWwoZXhpc3RpbmcsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvc2V0XCIsXG4gICAgeyB0aHJlYWRJZCwgb2JqZWN0aXZlOiBhcmdzLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICB7IGhvc3RJZCB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IHJlc3BvbnNlLmdvYWw7XG4gIGxvZyhcImdvYWwgc2V0XCIsIHsgdGhyZWFkSWQgfSk7XG4gIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRHb2FsKHRocmVhZElkOiBzdHJpbmcsIGhvc3RJZDogc3RyaW5nKTogUHJvbWlzZTxUaHJlYWRHb2FsIHwgbnVsbD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIHwgbnVsbCB9PihcbiAgICBcInRocmVhZC9nb2FsL2dldFwiLFxuICAgIHsgdGhyZWFkSWQgfSxcbiAgICB7IGhvc3RJZCB9LFxuICApO1xuICByZXR1cm4gcmVzcG9uc2UuZ29hbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaEdvYWxGb3JSb3V0ZShsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKTtcbiAgaWYgKCF0aHJlYWRJZCkge1xuICAgIGlmIChsYXN0VGhyZWFkSWQgIT09IG51bGwpIHtcbiAgICAgIGxhc3RUaHJlYWRJZCA9IG51bGw7XG4gICAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgICBoaWRlUGFuZWwoKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aHJlYWRJZCA9PT0gbGFzdFRocmVhZElkKSByZXR1cm47XG4gIGxhc3RUaHJlYWRJZCA9IHRocmVhZElkO1xuICB0cnkge1xuICAgIGNvbnN0IGdvYWwgPSBhd2FpdCBnZXRHb2FsKHRocmVhZElkLCByZWFkSG9zdElkKCkpO1xuICAgIGN1cnJlbnRHb2FsID0gZ29hbDtcbiAgICBpZiAoZ29hbCkge1xuICAgICAgcmVuZGVyR29hbChnb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGhpZGVQYW5lbCgpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBPbGQgYXBwLXNlcnZlciBidWlsZHMgZG8gbm90IGtub3cgdGhyZWFkL2dvYWwvKi4gS2VlcCB0aGUgVUkgcXVpZXQgdW50aWxcbiAgICAvLyB0aGUgdXNlciBleHBsaWNpdGx5IHR5cGVzIC9nb2FsLCB0aGVuIHNob3cgdGhlIGFjdGlvbmFibGUgZXJyb3IuXG4gICAgbG9nKFwiZ29hbCByb3V0ZSByZWZyZXNoIHNraXBwZWRcIiwgc3RyaW5naWZ5RXJyb3IoZXJyb3IpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb25maXJtUmVwbGFjZUdvYWwoZXhpc3Rpbmc6IFRocmVhZEdvYWwsIG5leHRPYmplY3RpdmU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICByZW5kZXJQYW5lbCh7XG4gICAgICB0aXRsZTogXCJSZXBsYWNlIGN1cnJlbnQgZ29hbD9cIixcbiAgICAgIGRldGFpbDogdHJ1bmNhdGUoZXhpc3Rpbmcub2JqZWN0aXZlLCAxODApLFxuICAgICAgZm9vdGVyOiBgTmV3OiAke3RydW5jYXRlKG5leHRPYmplY3RpdmUsIDE4MCl9YCxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGxhYmVsOiBcIlJlcGxhY2VcIixcbiAgICAgICAgICBraW5kOiBcInByaW1hcnlcIixcbiAgICAgICAgICBydW46ICgpID0+IHJlc29sdmUodHJ1ZSksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBsYWJlbDogXCJDYW5jZWxcIixcbiAgICAgICAgICBydW46ICgpID0+IHJlc29sdmUoZmFsc2UpLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHBlcnNpc3RlbnQ6IHRydWUsXG4gICAgfSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJHb2FsKGdvYWw6IFRocmVhZEdvYWwsIG9wdGlvbnM6IHsgdHJhbnNpZW50OiBib29sZWFuIH0pOiB2b2lkIHtcbiAgY29uc3Qgc3RhdHVzID0gZ29hbFN0YXR1c0xhYmVsKGdvYWwuc3RhdHVzKTtcbiAgY29uc3QgYnVkZ2V0ID0gZ29hbC50b2tlbkJ1ZGdldCA9PSBudWxsXG4gICAgPyBgJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbnNVc2VkKX0gdG9rZW5zYFxuICAgIDogYCR7Zm9ybWF0TnVtYmVyKGdvYWwudG9rZW5zVXNlZCl9IC8gJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbkJ1ZGdldCl9IHRva2Vuc2A7XG4gIHJlbmRlclBhbmVsKHtcbiAgICB0aXRsZTogYEdvYWwgJHtzdGF0dXN9YCxcbiAgICBkZXRhaWw6IGdvYWwub2JqZWN0aXZlLFxuICAgIGZvb3RlcjogYCR7YnVkZ2V0fSAtICR7Zm9ybWF0RHVyYXRpb24oZ29hbC50aW1lVXNlZFNlY29uZHMpfWAsXG4gICAgYWN0aW9uczogW1xuICAgICAgZ29hbC5zdGF0dXMgPT09IFwicGF1c2VkXCJcbiAgICAgICAgPyB7IGxhYmVsOiBcIlJlc3VtZVwiLCBraW5kOiBcInByaW1hcnlcIiwgcnVuOiAoKSA9PiB1cGRhdGVHb2FsU3RhdHVzKFwiYWN0aXZlXCIpIH1cbiAgICAgICAgOiB7IGxhYmVsOiBcIlBhdXNlXCIsIHJ1bjogKCkgPT4gdXBkYXRlR29hbFN0YXR1cyhcInBhdXNlZFwiKSB9LFxuICAgICAgeyBsYWJlbDogXCJDb21wbGV0ZVwiLCBydW46ICgpID0+IHVwZGF0ZUdvYWxTdGF0dXMoXCJjb21wbGV0ZVwiKSB9LFxuICAgICAgeyBsYWJlbDogXCJDbGVhclwiLCBraW5kOiBcImRhbmdlclwiLCBydW46ICgpID0+IGNsZWFyQ3VycmVudEdvYWwoKSB9LFxuICAgIF0sXG4gICAgcGVyc2lzdGVudDogIW9wdGlvbnMudHJhbnNpZW50LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyTm90aWNlKHRpdGxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogdm9pZCB7XG4gIHJlbmRlclBhbmVsKHsgdGl0bGUsIGRldGFpbCwgYWN0aW9uczogW10sIHBlcnNpc3RlbnQ6IGZhbHNlIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFcnJvcih0aXRsZTogc3RyaW5nLCBkZXRhaWw6IHN0cmluZyk6IHZvaWQge1xuICByZW5kZXJQYW5lbCh7IHRpdGxlLCBkZXRhaWwsIGFjdGlvbnM6IFtdLCBwZXJzaXN0ZW50OiBmYWxzZSwgZXJyb3I6IHRydWUgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclBhbmVsKG9wdGlvbnM6IEdvYWxQYW5lbE9wdGlvbnMpOiB2b2lkIHtcbiAgbGFzdFBhbmVsT3B0aW9ucyA9IG9wdGlvbnM7XG4gIGNvbnN0IGVsID0gZW5zdXJlUm9vdCgpO1xuICBpZiAoaGlkZVRpbWVyKSBjbGVhclRpbWVvdXQoaGlkZVRpbWVyKTtcbiAgZWwuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWwuY2xhc3NOYW1lID0gYGNvZGV4cHAtZ29hbC1wYW5lbCR7b3B0aW9ucy5lcnJvciA/IFwiIGlzLWVycm9yXCIgOiBcIlwifSR7cGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIiBpcy1jb2xsYXBzZWRcIiA6IFwiXCJ9YDtcbiAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihlbCk7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWhlYWRlclwiO1xuICBoZWFkZXIuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIHN0YXJ0R29hbFBhbmVsRHJhZyk7XG4gIGhlYWRlci5hZGRFdmVudExpc3RlbmVyKFwiZGJsY2xpY2tcIiwgcmVzZXRHb2FsUGFuZWxQb3NpdGlvbik7XG5cbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC10aXRsZVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IG9wdGlvbnMudGl0bGU7XG5cbiAgY29uc3QgY29udHJvbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb250cm9scy5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1jb250cm9sc1wiO1xuXG4gIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29sbGFwc2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaWNvblwiO1xuICBjb2xsYXBzZS50eXBlID0gXCJidXR0b25cIjtcbiAgY29sbGFwc2UudGV4dENvbnRlbnQgPSBwYW5lbFN0YXRlLmNvbGxhcHNlZCA/IFwiK1wiIDogXCItXCI7XG4gIGNvbGxhcHNlLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgcGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIkV4cGFuZCBnb2FsIHBhbmVsXCIgOiBcIkNvbGxhcHNlIGdvYWwgcGFuZWxcIik7XG4gIGNvbGxhcHNlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgcGFuZWxTdGF0ZSA9IHsgLi4ucGFuZWxTdGF0ZSwgY29sbGFwc2VkOiAhcGFuZWxTdGF0ZS5jb2xsYXBzZWQgfTtcbiAgICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbiAgICBpZiAobGFzdFBhbmVsT3B0aW9ucykgcmVuZGVyUGFuZWwobGFzdFBhbmVsT3B0aW9ucyk7XG4gIH0pO1xuXG4gIGNvbnN0IGNsb3NlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY2xvc2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaWNvblwiO1xuICBjbG9zZS50eXBlID0gXCJidXR0b25cIjtcbiAgY2xvc2UudGV4dENvbnRlbnQgPSBcInhcIjtcbiAgY2xvc2Uuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIkNsb3NlIGdvYWwgcGFuZWxcIik7XG4gIGNsb3NlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBoaWRlUGFuZWwoKSk7XG4gIGNvbnRyb2xzLmFwcGVuZChjb2xsYXBzZSwgY2xvc2UpO1xuICBoZWFkZXIuYXBwZW5kKHRpdGxlLCBjb250cm9scyk7XG4gIGVsLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgaWYgKHBhbmVsU3RhdGUuY29sbGFwc2VkKSB7XG4gICAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICBpZiAoIW9wdGlvbnMucGVyc2lzdGVudCkge1xuICAgICAgaGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBoaWRlUGFuZWwoKSwgOF8wMDApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBkZXRhaWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXRhaWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtZGV0YWlsXCI7XG4gIGRldGFpbC50ZXh0Q29udGVudCA9IG9wdGlvbnMuZGV0YWlsO1xuXG4gIGVsLmFwcGVuZENoaWxkKGRldGFpbCk7XG5cbiAgaWYgKG9wdGlvbnMuZm9vdGVyKSB7XG4gICAgY29uc3QgZm9vdGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBmb290ZXIuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtZm9vdGVyXCI7XG4gICAgZm9vdGVyLnRleHRDb250ZW50ID0gb3B0aW9ucy5mb290ZXI7XG4gICAgZWwuYXBwZW5kQ2hpbGQoZm9vdGVyKTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLmFjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtYWN0aW9uc1wiO1xuICAgIGZvciAoY29uc3QgYWN0aW9uIG9mIG9wdGlvbnMuYWN0aW9ucykge1xuICAgICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGFjdGlvbi5sYWJlbDtcbiAgICAgIGJ1dHRvbi5jbGFzc05hbWUgPSBgY29kZXhwcC1nb2FsLWFjdGlvbiAke2FjdGlvbi5raW5kID8/IFwiXCJ9YDtcbiAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgICBQcm9taXNlLnJlc29sdmUoYWN0aW9uLnJ1bigpKS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICByZW5kZXJFcnJvcihcIkdvYWwgYWN0aW9uIGZhaWxlZFwiLCBmcmllbmRseUdvYWxFcnJvcihlcnJvcikpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgIH1cbiAgICBlbC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgfVxuXG4gIGVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gIGlmICghb3B0aW9ucy5wZXJzaXN0ZW50KSB7XG4gICAgaGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBoaWRlUGFuZWwoKSwgOF8wMDApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZUdvYWxTdGF0dXMoc3RhdHVzOiBHb2FsU3RhdHVzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCkgPz8gY3VycmVudEdvYWw/LnRocmVhZElkO1xuICBpZiAoIXRocmVhZElkKSByZXR1cm47XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgXCJ0aHJlYWQvZ29hbC9zZXRcIixcbiAgICB7IHRocmVhZElkLCBzdGF0dXMgfSxcbiAgICB7IGhvc3RJZDogcmVhZEhvc3RJZCgpIH0sXG4gICk7XG4gIGN1cnJlbnRHb2FsID0gcmVzcG9uc2UuZ29hbDtcbiAgcmVuZGVyR29hbChyZXNwb25zZS5nb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNsZWFyQ3VycmVudEdvYWwoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCkgPz8gY3VycmVudEdvYWw/LnRocmVhZElkO1xuICBpZiAoIXRocmVhZElkKSByZXR1cm47XG4gIGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBjbGVhcmVkOiBib29sZWFuIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvY2xlYXJcIixcbiAgICB7IHRocmVhZElkIH0sXG4gICAgeyBob3N0SWQ6IHJlYWRIb3N0SWQoKSB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IG51bGw7XG4gIHJlbmRlck5vdGljZShcIkdvYWwgY2xlYXJlZFwiLCBcIlRoaXMgdGhyZWFkIG5vIGxvbmdlciBoYXMgYW4gYWN0aXZlIGdvYWwuXCIpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVSb290KCk6IEhUTUxEaXZFbGVtZW50IHtcbiAgaWYgKHJvb3Q/LmlzQ29ubmVjdGVkKSByZXR1cm4gcm9vdDtcbiAgcm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvb3QuaWQgPSBcImNvZGV4cHAtZ29hbC1yb290XCI7XG4gIHJvb3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5ib2R5IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKHBhcmVudCkgcGFyZW50LmFwcGVuZENoaWxkKHJvb3QpO1xuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gaGlkZVBhbmVsKCk6IHZvaWQge1xuICBpZiAoaGlkZVRpbWVyKSB7XG4gICAgY2xlYXJUaW1lb3V0KGhpZGVUaW1lcik7XG4gICAgaGlkZVRpbWVyID0gbnVsbDtcbiAgfVxuICBpZiAocm9vdCkgcm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0R29hbFBhbmVsRHJhZyhldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChldmVudC5idXR0b24gIT09IDApIHJldHVybjtcbiAgaWYgKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgJiYgZXZlbnQudGFyZ2V0LmNsb3Nlc3QoXCJidXR0b25cIikpIHJldHVybjtcbiAgaWYgKCFyb290KSByZXR1cm47XG4gIGNvbnN0IHJlY3QgPSByb290LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBwYW5lbERyYWcgPSB7XG4gICAgcG9pbnRlcklkOiBldmVudC5wb2ludGVySWQsXG4gICAgb2Zmc2V0WDogZXZlbnQuY2xpZW50WCAtIHJlY3QubGVmdCxcbiAgICBvZmZzZXRZOiBldmVudC5jbGllbnRZIC0gcmVjdC50b3AsXG4gICAgd2lkdGg6IHJlY3Qud2lkdGgsXG4gICAgaGVpZ2h0OiByZWN0LmhlaWdodCxcbiAgfTtcbiAgcm9vdC5jbGFzc0xpc3QuYWRkKFwiaXMtZHJhZ2dpbmdcIik7XG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgbW92ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxEcmFnKTtcbn1cblxuZnVuY3Rpb24gbW92ZUdvYWxQYW5lbChldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmICghcGFuZWxEcmFnIHx8IGV2ZW50LnBvaW50ZXJJZCAhPT0gcGFuZWxEcmFnLnBvaW50ZXJJZCB8fCAhcm9vdCkgcmV0dXJuO1xuICBwYW5lbFN0YXRlID0ge1xuICAgIC4uLnBhbmVsU3RhdGUsXG4gICAgeDogY2xhbXAoZXZlbnQuY2xpZW50WCAtIHBhbmVsRHJhZy5vZmZzZXRYLCA4LCB3aW5kb3cuaW5uZXJXaWR0aCAtIHBhbmVsRHJhZy53aWR0aCAtIDgpLFxuICAgIHk6IGNsYW1wKGV2ZW50LmNsaWVudFkgLSBwYW5lbERyYWcub2Zmc2V0WSwgOCwgd2luZG93LmlubmVySGVpZ2h0IC0gcGFuZWxEcmFnLmhlaWdodCAtIDgpLFxuICB9O1xuICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xufVxuXG5mdW5jdGlvbiBzdG9wR29hbFBhbmVsRHJhZyhldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbERyYWcgJiYgZXZlbnQucG9pbnRlcklkICE9PSBwYW5lbERyYWcucG9pbnRlcklkKSByZXR1cm47XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgbW92ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxEcmFnKTtcbiAgaWYgKHJvb3QpIHJvb3QuY2xhc3NMaXN0LnJlbW92ZShcImlzLWRyYWdnaW5nXCIpO1xuICBwYW5lbERyYWcgPSBudWxsO1xuICBpZiAocm9vdCkgY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KHJvb3QpO1xuICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbn1cblxuZnVuY3Rpb24gcmVzZXRHb2FsUGFuZWxQb3NpdGlvbihldmVudDogTW91c2VFdmVudCk6IHZvaWQge1xuICBpZiAoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCAmJiBldmVudC50YXJnZXQuY2xvc2VzdChcImJ1dHRvblwiKSkgcmV0dXJuO1xuICBwYW5lbFN0YXRlID0geyAuLi5wYW5lbFN0YXRlLCB4OiBudWxsLCB5OiBudWxsIH07XG4gIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xuICBpZiAocm9vdCkgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkge1xuICAgIGVsZW1lbnQuc3R5bGUubGVmdCA9IFwiYXV0b1wiO1xuICAgIGVsZW1lbnQuc3R5bGUudG9wID0gXCJhdXRvXCI7XG4gICAgZWxlbWVudC5zdHlsZS5yaWdodCA9IFwiMThweFwiO1xuICAgIGVsZW1lbnQuc3R5bGUuYm90dG9tID0gXCI3NnB4XCI7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChlbGVtZW50KTtcbiAgZWxlbWVudC5zdHlsZS5yaWdodCA9IFwiYXV0b1wiO1xuICBlbGVtZW50LnN0eWxlLmJvdHRvbSA9IFwiYXV0b1wiO1xuICBlbGVtZW50LnN0eWxlLmxlZnQgPSBgJHtwYW5lbFN0YXRlLnh9cHhgO1xuICBlbGVtZW50LnN0eWxlLnRvcCA9IGAke3BhbmVsU3RhdGUueX1weGA7XG59XG5cbmZ1bmN0aW9uIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgcGFuZWxTdGF0ZSA9IHtcbiAgICAuLi5wYW5lbFN0YXRlLFxuICAgIHg6IGNsYW1wKHBhbmVsU3RhdGUueCwgOCwgd2luZG93LmlubmVyV2lkdGggLSByZWN0LndpZHRoIC0gOCksXG4gICAgeTogY2xhbXAocGFuZWxTdGF0ZS55LCA4LCB3aW5kb3cuaW5uZXJIZWlnaHQgLSByZWN0LmhlaWdodCAtIDgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZWFkR29hbFBhbmVsU3RhdGUoKTogR29hbFBhbmVsU3RhdGUge1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oR09BTF9QQU5FTF9TVEFURV9LRVkpID8/IFwie31cIikgYXMgUGFydGlhbDxHb2FsUGFuZWxTdGF0ZT47XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbGxhcHNlZDogcGFyc2VkLmNvbGxhcHNlZCA9PT0gdHJ1ZSxcbiAgICAgIHg6IHR5cGVvZiBwYXJzZWQueCA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkLngpID8gcGFyc2VkLnggOiBudWxsLFxuICAgICAgeTogdHlwZW9mIHBhcnNlZC55ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShwYXJzZWQueSkgPyBwYXJzZWQueSA6IG51bGwsXG4gICAgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgY29sbGFwc2VkOiBmYWxzZSwgeDogbnVsbCwgeTogbnVsbCB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVHb2FsUGFuZWxTdGF0ZSgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShHT0FMX1BBTkVMX1NUQVRFX0tFWSwgSlNPTi5zdHJpbmdpZnkocGFuZWxTdGF0ZSkpO1xuICB9IGNhdGNoIHt9XG59XG5cbmZ1bmN0aW9uIGNsYW1wKHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChtYXggPCBtaW4pIHJldHVybiBtaW47XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heCh2YWx1ZSwgbWluKSwgbWF4KTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlU3VnZ2VzdGlvblJvb3QoKTogSFRNTERpdkVsZW1lbnQgfCBudWxsIHtcbiAgaWYgKHN1Z2dlc3Rpb25Sb290Py5pc0Nvbm5lY3RlZCkgcmV0dXJuIHN1Z2dlc3Rpb25Sb290O1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5ib2R5IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKCFwYXJlbnQpIHJldHVybiBudWxsO1xuICBzdWdnZXN0aW9uUm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN1Z2dlc3Rpb25Sb290LmlkID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1yb290XCI7XG4gIHN1Z2dlc3Rpb25Sb290LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgcGFyZW50LmFwcGVuZENoaWxkKHN1Z2dlc3Rpb25Sb290KTtcbiAgcmV0dXJuIHN1Z2dlc3Rpb25Sb290O1xufVxuXG5mdW5jdGlvbiB1cGRhdGVHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQgfCBudWxsKTogdm9pZCB7XG4gIGlmICghZWRpdGFibGUpIHtcbiAgICBoaWRlR29hbFN1Z2dlc3Rpb24oKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc3VnZ2VzdGlvbiA9IHBhcnNlR29hbFN1Z2dlc3Rpb24oZWRpdGFibGUuZ2V0VGV4dCgpKTtcbiAgaWYgKCFzdWdnZXN0aW9uKSB7XG4gICAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJlbmRlckdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLCBzdWdnZXN0aW9uLnF1ZXJ5KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyR29hbFN1Z2dlc3Rpb24oZWRpdGFibGU6IEVkaXRhYmxlVGFyZ2V0LCBxdWVyeTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGVsID0gZW5zdXJlU3VnZ2VzdGlvblJvb3QoKTtcbiAgaWYgKCFlbCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gZWRpdGFibGUuZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbig0MjAsIE1hdGgubWF4KDI4MCwgcmVjdC53aWR0aCB8fCAzMjApKTtcbiAgY29uc3QgbGVmdCA9IE1hdGgubWF4KDEyLCBNYXRoLm1pbihyZWN0LmxlZnQsIHdpbmRvdy5pbm5lcldpZHRoIC0gd2lkdGggLSAxMikpO1xuICBjb25zdCB0b3AgPSBNYXRoLm1heCgxMiwgcmVjdC50b3AgLSA2Nik7XG5cbiAgZWwuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvblwiO1xuICBlbC5zdHlsZS5sZWZ0ID0gYCR7bGVmdH1weGA7XG4gIGVsLnN0eWxlLnRvcCA9IGAke3RvcH1weGA7XG4gIGVsLnN0eWxlLndpZHRoID0gYCR7d2lkdGh9cHhgO1xuXG4gIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBpdGVtLnR5cGUgPSBcImJ1dHRvblwiO1xuICBpdGVtLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbVwiO1xuICBpdGVtLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJHb2FsIGNvbW1hbmRcIik7XG4gIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlZG93blwiLCAoZXZlbnQpID0+IHtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGUpO1xuICB9KTtcblxuICBjb25zdCBjb21tYW5kID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbW1hbmQuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1jb21tYW5kXCI7XG4gIGNvbW1hbmQudGV4dENvbnRlbnQgPSBcIi9nb2FsXCI7XG4gIGlmIChxdWVyeSkge1xuICAgIGNvbW1hbmQuZGF0YXNldC5xdWVyeSA9IHF1ZXJ5O1xuICB9XG5cbiAgY29uc3QgZGV0YWlsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGRldGFpbC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWRldGFpbFwiO1xuICBkZXRhaWwudGV4dENvbnRlbnQgPSBcIlNldCwgdmlldywgcGF1c2UsIHJlc3VtZSwgY29tcGxldGUsIG9yIGNsZWFyIHRoaXMgdGhyZWFkIGdvYWxcIjtcblxuICBpdGVtLmFwcGVuZChjb21tYW5kLCBkZXRhaWwpO1xuICBlbC5hcHBlbmRDaGlsZChpdGVtKTtcbiAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQpOiB2b2lkIHtcbiAgZWRpdGFibGUuc2V0VGV4dChcIi9nb2FsIFwiKTtcbiAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG59XG5cbmZ1bmN0aW9uIGhpZGVHb2FsU3VnZ2VzdGlvbigpOiB2b2lkIHtcbiAgaWYgKHN1Z2dlc3Rpb25Sb290KSBzdWdnZXN0aW9uUm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxTdHlsZXMoKTogdm9pZCB7XG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNvZGV4cHAtZ29hbC1zdHlsZVwiKSkgcmV0dXJuO1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5oZWFkIHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKCFwYXJlbnQpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCAoKSA9PiBpbnN0YWxsU3R5bGVzKCksIHsgb25jZTogdHJ1ZSB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcbiAgc3R5bGUuaWQgPSBcImNvZGV4cHAtZ29hbC1zdHlsZVwiO1xuICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiNjb2RleHBwLWdvYWwtcm9vdCB7XG4gIHBvc2l0aW9uOiBmaXhlZDtcbiAgcmlnaHQ6IDE4cHg7XG4gIGJvdHRvbTogNzZweDtcbiAgei1pbmRleDogMjE0NzQ4MzY0NztcbiAgd2lkdGg6IG1pbig0MjBweCwgY2FsYygxMDB2dyAtIDM2cHgpKTtcbiAgZm9udDogMTNweC8xLjQgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBcIlNlZ29lIFVJXCIsIHNhbnMtc2VyaWY7XG4gIGNvbG9yOiB2YXIoLS10ZXh0LXByaW1hcnksICNmNWY3ZmIpO1xufVxuI2NvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLXJvb3Qge1xuICBwb3NpdGlvbjogZml4ZWQ7XG4gIHotaW5kZXg6IDIxNDc0ODM2NDc7XG4gIGZvbnQ6IDEzcHgvMS4zNSAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIFwiU2Vnb2UgVUlcIiwgc2Fucy1zZXJpZjtcbiAgY29sb3I6IHZhcigtLXRleHQtcHJpbWFyeSwgI2Y1ZjdmYik7XG59XG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24ge1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xuICBib3JkZXItcmFkaXVzOiA4cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjQsIDI3LCAzMywgMC45OCk7XG4gIGJveC1zaGFkb3c6IDAgMTZweCA0NnB4IHJnYmEoMCwwLDAsMC4zMik7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIGJhY2tkcm9wLWZpbHRlcjogYmx1cigxNHB4KTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1pdGVtIHtcbiAgd2lkdGg6IDEwMCU7XG4gIGJvcmRlcjogMDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBkaXNwbGF5OiBncmlkO1xuICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IGF1dG8gMWZyO1xuICBnYXA6IDEycHg7XG4gIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gIHBhZGRpbmc6IDEwcHggMTJweDtcbiAgdGV4dC1hbGlnbjogbGVmdDtcbiAgY3Vyc29yOiBwb2ludGVyO1xufVxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWl0ZW06aG92ZXIsXG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbTpmb2N1cy12aXNpYmxlIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjA5KTtcbiAgb3V0bGluZTogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1jb21tYW5kIHtcbiAgZm9udC1mYW1pbHk6IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIFwiU0YgTW9ub1wiLCBNZW5sbywgbW9ub3NwYWNlO1xuICBmb250LXdlaWdodDogNjUwO1xuICBjb2xvcjogIzlmYzVmZjtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1kZXRhaWwge1xuICBtaW4td2lkdGg6IDA7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjcyKTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwge1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTYpO1xuICBib3JkZXItcmFkaXVzOiA4cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjYsIDI5LCAzNSwgMC45Nik7XG4gIGJveC1zaGFkb3c6IDAgMThweCA2MHB4IHJnYmEoMCwwLDAsMC4zNCk7XG4gIHBhZGRpbmc6IDEycHg7XG4gIGJhY2tkcm9wLWZpbHRlcjogYmx1cigxNHB4KTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtZHJhZ2dpbmcge1xuICBjdXJzb3I6IGdyYWJiaW5nO1xuICB1c2VyLXNlbGVjdDogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtY29sbGFwc2VkIHtcbiAgd2lkdGg6IG1pbigzMjBweCwgY2FsYygxMDB2dyAtIDM2cHgpKTtcbiAgcGFkZGluZzogMTBweCAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbC5pcy1lcnJvciB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsIDEyMiwgMTIyLCAwLjU1KTtcbn1cbi5jb2RleHBwLWdvYWwtaGVhZGVyIHtcbiAgZGlzcGxheTogZmxleDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuICBnYXA6IDEycHg7XG4gIGZvbnQtd2VpZ2h0OiA2NTA7XG4gIGN1cnNvcjogZ3JhYjtcbiAgdXNlci1zZWxlY3Q6IG5vbmU7XG59XG4uY29kZXhwcC1nb2FsLXRpdGxlIHtcbiAgbWluLXdpZHRoOiAwO1xuICBvdmVyZmxvdzogaGlkZGVuO1xuICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbn1cbi5jb2RleHBwLWdvYWwtY29udHJvbHMge1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LXNocmluazogMDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgZ2FwOiA0cHg7XG59XG4uY29kZXhwcC1nb2FsLWljb24ge1xuICB3aWR0aDogMjRweDtcbiAgaGVpZ2h0OiAyNHB4O1xuICBib3JkZXI6IDA7XG4gIGJvcmRlci1yYWRpdXM6IDZweDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBjdXJzb3I6IHBvaW50ZXI7XG4gIGxpbmUtaGVpZ2h0OiAxO1xufVxuLmNvZGV4cHAtZ29hbC1pY29uOmhvdmVyIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjEpO1xufVxuLmNvZGV4cHAtZ29hbC1kZXRhaWwge1xuICBtYXJnaW4tdG9wOiA4cHg7XG4gIG1heC1oZWlnaHQ6IDk2cHg7XG4gIG92ZXJmbG93OiBhdXRvO1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjkpO1xuICB3b3JkLWJyZWFrOiBicmVhay13b3JkO1xufVxuLmNvZGV4cHAtZ29hbC1mb290ZXIge1xuICBtYXJnaW4tdG9wOiA4cHg7XG4gIGNvbG9yOiByZ2JhKDI0NSwyNDcsMjUxLDAuNjIpO1xuICBmb250LXNpemU6IDEycHg7XG59XG4uY29kZXhwcC1nb2FsLWFjdGlvbnMge1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LXdyYXA6IHdyYXA7XG4gIGdhcDogOHB4O1xuICBtYXJnaW4tdG9wOiAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24ge1xuICBtaW4taGVpZ2h0OiAyOHB4O1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xuICBib3JkZXItcmFkaXVzOiA3cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4wOCk7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBwYWRkaW5nOiA0cHggMTBweDtcbiAgY3Vyc29yOiBwb2ludGVyO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb246aG92ZXIge1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24ucHJpbWFyeSB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgxMjUsIDE4MCwgMjU1LCAwLjU1KTtcbiAgYmFja2dyb3VuZDogcmdiYSg3NCwgMTIxLCAyMTYsIDAuNDIpO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24uZGFuZ2VyIHtcbiAgYm9yZGVyLWNvbG9yOiByZ2JhKDI1NSwgMTIyLCAxMjIsIDAuNDgpO1xufVxuYDtcbiAgcGFyZW50LmFwcGVuZENoaWxkKHN0eWxlKTtcbn1cblxuZnVuY3Rpb24gZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50OiBFdmVudCk6IEVkaXRhYmxlVGFyZ2V0IHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSB0eXBlb2YgZXZlbnQuY29tcG9zZWRQYXRoID09PSBcImZ1bmN0aW9uXCIgPyBldmVudC5jb21wb3NlZFBhdGgoKSA6IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGF0aCkge1xuICAgIGlmICghKGl0ZW0gaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGVkaXRhYmxlID0gZWRpdGFibGVGb3JFbGVtZW50KGl0ZW0pO1xuICAgIGlmIChlZGl0YWJsZSkgcmV0dXJuIGVkaXRhYmxlO1xuICB9XG4gIHJldHVybiBldmVudC50YXJnZXQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IGVkaXRhYmxlRm9yRWxlbWVudChldmVudC50YXJnZXQpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gZWRpdGFibGVGb3JFbGVtZW50KGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogRWRpdGFibGVUYXJnZXQgfCBudWxsIHtcbiAgaWYgKGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MVGV4dEFyZWFFbGVtZW50IHx8IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50KSB7XG4gICAgY29uc3QgdHlwZSA9IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50ID8gZWxlbWVudC50eXBlIDogXCJ0ZXh0YXJlYVwiO1xuICAgIGlmICghW1widGV4dFwiLCBcInNlYXJjaFwiLCBcInRleHRhcmVhXCJdLmluY2x1ZGVzKHR5cGUpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgZWxlbWVudCxcbiAgICAgIGdldFRleHQ6ICgpID0+IGVsZW1lbnQudmFsdWUsXG4gICAgICBzZXRUZXh0OiAodmFsdWUpID0+IHtcbiAgICAgICAgZWxlbWVudC52YWx1ZSA9IHZhbHVlO1xuICAgICAgICBlbGVtZW50LmZvY3VzKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZWxlbWVudC5zZXRTZWxlY3Rpb25SYW5nZSh2YWx1ZS5sZW5ndGgsIHZhbHVlLmxlbmd0aCk7XG4gICAgICAgIH0gY2F0Y2gge31cbiAgICAgICAgZWxlbWVudC5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiaW5zZXJ0VGV4dFwiLCBkYXRhOiB2YWx1ZSB9KSk7XG4gICAgICB9LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgZWxlbWVudC52YWx1ZSA9IFwiXCI7XG4gICAgICAgIGVsZW1lbnQuZGlzcGF0Y2hFdmVudChuZXcgSW5wdXRFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSwgaW5wdXRUeXBlOiBcImRlbGV0ZUNvbnRlbnRCYWNrd2FyZFwiIH0pKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGVkaXRhYmxlID0gZWxlbWVudC5pc0NvbnRlbnRFZGl0YWJsZVxuICAgID8gZWxlbWVudFxuICAgIDogZWxlbWVudC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0sIFtyb2xlPVwidGV4dGJveFwiXScpO1xuICBpZiAoIWVkaXRhYmxlKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICBlbGVtZW50OiBlZGl0YWJsZSxcbiAgICBnZXRUZXh0OiAoKSA9PiBlZGl0YWJsZS5pbm5lclRleHQgfHwgZWRpdGFibGUudGV4dENvbnRlbnQgfHwgXCJcIixcbiAgICBzZXRUZXh0OiAodmFsdWUpID0+IHtcbiAgICAgIGVkaXRhYmxlLnRleHRDb250ZW50ID0gdmFsdWU7XG4gICAgICBlZGl0YWJsZS5mb2N1cygpO1xuICAgICAgcGxhY2VDYXJldEF0RW5kKGVkaXRhYmxlKTtcbiAgICAgIGVkaXRhYmxlLmRpc3BhdGNoRXZlbnQobmV3IElucHV0RXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUsIGlucHV0VHlwZTogXCJpbnNlcnRUZXh0XCIsIGRhdGE6IHZhbHVlIH0pKTtcbiAgICB9LFxuICAgIGNsZWFyOiAoKSA9PiB7XG4gICAgICBlZGl0YWJsZS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBlZGl0YWJsZS5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiZGVsZXRlQ29udGVudEJhY2t3YXJkXCIgfSkpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHBsYWNlQ2FyZXRBdEVuZChlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBzZWxlY3Rpb24gPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7XG4gIGlmICghc2VsZWN0aW9uKSByZXR1cm47XG4gIGNvbnN0IHJhbmdlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTtcbiAgcmFuZ2Uuc2VsZWN0Tm9kZUNvbnRlbnRzKGVsZW1lbnQpO1xuICByYW5nZS5jb2xsYXBzZShmYWxzZSk7XG4gIHNlbGVjdGlvbi5yZW1vdmVBbGxSYW5nZXMoKTtcbiAgc2VsZWN0aW9uLmFkZFJhbmdlKHJhbmdlKTtcbn1cblxuZnVuY3Rpb24gcmVhZFRocmVhZElkKCk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtsb2NhdGlvbi5wYXRobmFtZSwgbG9jYXRpb24uaGFzaCwgbG9jYXRpb24uaHJlZl07XG4gIHRyeSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcbiAgICBjb25zdCBpbml0aWFsUm91dGUgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImluaXRpYWxSb3V0ZVwiKTtcbiAgICBpZiAoaW5pdGlhbFJvdXRlKSBjYW5kaWRhdGVzLnB1c2goaW5pdGlhbFJvdXRlKTtcbiAgfSBjYXRjaCB7fVxuICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyhoaXN0b3J5LnN0YXRlKSk7XG4gIGNhbmRpZGF0ZXMucHVzaCguLi5jb2xsZWN0RG9tVGhyZWFkQ2FuZGlkYXRlcygpKTtcblxuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgdGhyZWFkSWQgPSBub3JtYWxpemVUaHJlYWRJZChjYW5kaWRhdGUpO1xuICAgIGlmICh0aHJlYWRJZCkgcmV0dXJuIHRocmVhZElkO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUaHJlYWRJZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGRlY29kZWQgPSBzYWZlRGVjb2RlKHZhbHVlKS50cmltKCk7XG4gIGNvbnN0IHJvdXRlTWF0Y2ggPSBkZWNvZGVkLm1hdGNoKC9cXC9sb2NhbFxcLyhbXi8/I1xcc10rKS8pO1xuICBpZiAocm91dGVNYXRjaD8uWzFdKSB7XG4gICAgY29uc3QgZnJvbVJvdXRlID0gbm9ybWFsaXplVGhyZWFkSWRUb2tlbihyb3V0ZU1hdGNoWzFdKTtcbiAgICBpZiAoZnJvbVJvdXRlKSByZXR1cm4gZnJvbVJvdXRlO1xuICB9XG5cbiAgY29uc3QgdG9rZW5NYXRjaCA9IGRlY29kZWQubWF0Y2goL1xcYig/OlthLXpdW1xcdy4tXSo6KSooWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9KVxcYi9pKTtcbiAgaWYgKHRva2VuTWF0Y2g/LlsxXSkgcmV0dXJuIHRva2VuTWF0Y2hbMV07XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVRocmVhZElkVG9rZW4odmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBkZWNvZGVkID0gc2FmZURlY29kZSh2YWx1ZSkudHJpbSgpO1xuICBjb25zdCBtYXRjaCA9IGRlY29kZWQubWF0Y2goLyg/Ol58OikoWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9KSQvaSk7XG4gIHJldHVybiBtYXRjaD8uWzFdID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3REb21UaHJlYWRDYW5kaWRhdGVzKCk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc2VsZWN0b3JzID0gW1xuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLXJvd11bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT1cInRydWVcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtcm93XVthcmlhLWN1cnJlbnQ9XCJwYWdlXCJdW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1pZF0nLFxuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT1cInRydWVcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRdW2FyaWEtY3VycmVudD1cInBhZ2VcIl0nLFxuICBdO1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIHNlbGVjdG9ycykge1xuICAgIGZvciAoY29uc3QgZWxlbWVudCBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KHNlbGVjdG9yKSkpIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRcIik7XG4gICAgICBpZiAodmFsdWUpIGNhbmRpZGF0ZXMucHVzaCh2YWx1ZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBjYW5kaWRhdGVzO1xufVxuXG5mdW5jdGlvbiBzYWZlRGVjb2RlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyh2YWx1ZTogdW5rbm93biwgZGVwdGggPSAwLCBzZWVuID0gbmV3IFNldDx1bmtub3duPigpKTogc3RyaW5nW10ge1xuICBpZiAoZGVwdGggPiA1IHx8IHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQgfHwgc2Vlbi5oYXModmFsdWUpKSByZXR1cm4gW107XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHJldHVybiBub3JtYWxpemVUaHJlYWRJZCh2YWx1ZSkgPyBbdmFsdWVdIDogW107XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBbXTtcbiAgc2Vlbi5hZGQodmFsdWUpO1xuXG4gIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgT2JqZWN0LnZhbHVlcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyhjaGlsZCwgZGVwdGggKyAxLCBzZWVuKSk7XG4gIH1cbiAgcmV0dXJuIGNhbmRpZGF0ZXM7XG59XG5cbmZ1bmN0aW9uIGdvYWxTdGF0dXNMYWJlbChzdGF0dXM6IEdvYWxTdGF0dXMpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHN0YXR1cykge1xuICAgIGNhc2UgXCJhY3RpdmVcIjpcbiAgICAgIHJldHVybiBcImFjdGl2ZVwiO1xuICAgIGNhc2UgXCJwYXVzZWRcIjpcbiAgICAgIHJldHVybiBcInBhdXNlZFwiO1xuICAgIGNhc2UgXCJidWRnZXRMaW1pdGVkXCI6XG4gICAgICByZXR1cm4gXCJsaW1pdGVkIGJ5IGJ1ZGdldFwiO1xuICAgIGNhc2UgXCJjb21wbGV0ZVwiOlxuICAgICAgcmV0dXJuIFwiY29tcGxldGVcIjtcbiAgfVxufVxuXG5mdW5jdGlvbiBmcmllbmRseUdvYWxFcnJvcihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIGNvbnN0IG1lc3NhZ2UgPSBzdHJpbmdpZnlFcnJvcihlcnJvcik7XG4gIGlmICgvZ29hbHMgZmVhdHVyZSBpcyBkaXNhYmxlZC9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGUgYXBwLXNlcnZlciBoYXMgZ29hbCBzdXBwb3J0LCBidXQgW2ZlYXR1cmVzXS5nb2FscyBpcyBkaXNhYmxlZCBpbiB+Ly5jb2RleC9jb25maWcudG9tbC5cIjtcbiAgfVxuICBpZiAoL3JlcXVpcmVzIGV4cGVyaW1lbnRhbEFwaS9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGUgYXBwLXNlcnZlciByZWplY3RlZCB0aHJlYWQvZ29hbC8qIGJlY2F1c2UgdGhlIGFjdGl2ZSBEZXNrdG9wIGNsaWVudCBkaWQgbm90IG5lZ290aWF0ZSBleHBlcmltZW50YWxBcGkuXCI7XG4gIH1cbiAgaWYgKC91bmtub3dufHVuc3VwcG9ydGVkfG5vdCBmb3VuZHxubyBoYW5kbGVyfGludmFsaWQgcmVxdWVzdHxkZXNlcmlhbGl6ZXx0aHJlYWRcXC9nb2FsL2kudGVzdChtZXNzYWdlKSkge1xuICAgIHJldHVybiBcIlRoaXMgQ29kZXguYXBwIGFwcC1zZXJ2ZXIgZG9lcyBub3Qgc3VwcG9ydCB0aHJlYWQvZ29hbC8qIHlldC4gVXBkYXRlIG9yIHJlcGF0Y2ggQ29kZXguYXBwIHdpdGggYSBidWlsZCB0aGF0IGluY2x1ZGVzIHRoZSBnb2FscyBmZWF0dXJlLlwiO1xuICB9XG4gIHJldHVybiBtZXNzYWdlO1xufVxuXG5mdW5jdGlvbiBmb3JtYXREdXJhdGlvbihzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShzZWNvbmRzKSB8fCBzZWNvbmRzIDw9IDApIHJldHVybiBcIjBzXCI7XG4gIGNvbnN0IG1pbnV0ZXMgPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIGNvbnN0IHJlbWFpbmluZ1NlY29uZHMgPSBNYXRoLmZsb29yKHNlY29uZHMgJSA2MCk7XG4gIGlmIChtaW51dGVzIDw9IDApIHJldHVybiBgJHtyZW1haW5pbmdTZWNvbmRzfXNgO1xuICBjb25zdCBob3VycyA9IE1hdGguZmxvb3IobWludXRlcyAvIDYwKTtcbiAgY29uc3QgcmVtYWluaW5nTWludXRlcyA9IG1pbnV0ZXMgJSA2MDtcbiAgaWYgKGhvdXJzIDw9IDApIHJldHVybiBgJHttaW51dGVzfW0gJHtyZW1haW5pbmdTZWNvbmRzfXNgO1xuICByZXR1cm4gYCR7aG91cnN9aCAke3JlbWFpbmluZ01pbnV0ZXN9bWA7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdE51bWJlcih2YWx1ZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBNYXRoLnJvdW5kKHZhbHVlKS50b0xvY2FsZVN0cmluZygpIDogXCIwXCI7XG59XG5cbmZ1bmN0aW9uIHRydW5jYXRlKHZhbHVlOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLmxlbmd0aCA8PSBtYXhMZW5ndGggPyB2YWx1ZSA6IGAke3ZhbHVlLnNsaWNlKDAsIG1heExlbmd0aCAtIDEpfS4uLmA7XG59XG5cbmZ1bmN0aW9uIHN0cmluZ2lmeUVycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuZnVuY3Rpb24gaXNUaHJlYWRHb2FsKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgVGhyZWFkR29hbCB7XG4gIHJldHVybiBpc1JlY29yZCh2YWx1ZSkgJiZcbiAgICB0eXBlb2YgdmFsdWUudGhyZWFkSWQgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgdmFsdWUub2JqZWN0aXZlID09PSBcInN0cmluZ1wiICYmXG4gICAgdHlwZW9mIHZhbHVlLnN0YXR1cyA9PT0gXCJzdHJpbmdcIjtcbn1cblxuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB2YWx1ZSAhPT0gbnVsbCAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuIiwgImltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgdHlwZSB7XG4gIEdpdERpZmZTdW1tYXJ5LFxuICBHaXRTdGF0dXMsXG4gIEdpdFN0YXR1c0VudHJ5LFxuICBHaXRXb3JrdHJlZSxcbn0gZnJvbSBcIkBjb2RleC1wbHVzcGx1cy9zZGtcIjtcblxuY29uc3QgUFJPSkVDVF9ST1dfU0VMRUNUT1IgPVxuICBcIltkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LXJvd11bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1pZF1cIjtcbmNvbnN0IEFDVElWRV9USFJFQURfU0VMRUNUT1IgPVxuICBcIltkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtYWN0aXZlPSd0cnVlJ10sW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1hY3RpdmU9dHJ1ZV1cIjtcbmNvbnN0IFBST0pFQ1RfTElTVF9TRUxFQ1RPUiA9IFwiW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtbGlzdC1pZF1cIjtcbmNvbnN0IFNVTU1BUllfQVRUUiA9IFwiZGF0YS1jb2RleHBwLWdpdC1zdW1tYXJ5XCI7XG5jb25zdCBCQURHRV9BVFRSID0gXCJkYXRhLWNvZGV4cHAtZ2l0LWJhZGdlXCI7XG5jb25zdCBTVFlMRV9JRCA9IFwiY29kZXhwcC1naXQtc2lkZWJhci1zdHlsZVwiO1xuY29uc3QgUkVGUkVTSF9ERUJPVU5DRV9NUyA9IDI1MDtcbmNvbnN0IFNUQVRVU19UVExfTVMgPSAxMF8wMDA7XG5jb25zdCBERVRBSUxTX1RUTF9NUyA9IDE1XzAwMDtcbmNvbnN0IE1BWF9WSVNJQkxFX1BST0pFQ1RfQkFER0VTID0gMTY7XG5jb25zdCBNQVhfQ0hBTkdFRF9GSUxFUyA9IDc7XG5jb25zdCBNQVhfV09SS1RSRUVfUk9XUyA9IDM7XG5cbmludGVyZmFjZSBQcm9qZWN0Um93IHtcbiAgcm93OiBIVE1MRWxlbWVudDtcbiAgZ3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcGF0aDogc3RyaW5nO1xuICBsYWJlbDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgU3RhdHVzQ2FjaGVFbnRyeSB7XG4gIHZhbHVlOiBHaXRTdGF0dXMgfCBudWxsO1xuICBlcnJvcjogc3RyaW5nIHwgbnVsbDtcbiAgbG9hZGVkQXQ6IG51bWJlcjtcbiAgcGVuZGluZzogUHJvbWlzZTxHaXRTdGF0dXMgfCBudWxsPiB8IG51bGw7XG59XG5cbmludGVyZmFjZSBEZXRhaWxzQ2FjaGVFbnRyeSB7XG4gIHZhbHVlOiBHaXREZXRhaWxzIHwgbnVsbDtcbiAgZXJyb3I6IHN0cmluZyB8IG51bGw7XG4gIGxvYWRlZEF0OiBudW1iZXI7XG4gIHBlbmRpbmc6IFByb21pc2U8R2l0RGV0YWlscyB8IG51bGw+IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIEdpdERldGFpbHMge1xuICBkaWZmOiBHaXREaWZmU3VtbWFyeTtcbiAgd29ya3RyZWVzOiBHaXRXb3JrdHJlZVtdO1xufVxuXG5pbnRlcmZhY2UgR2l0U2lkZWJhclN0YXRlIHtcbiAgb2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCBudWxsO1xuICByZWZyZXNoVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbDtcbiAgaW50ZXJ2YWw6IFJldHVyblR5cGU8dHlwZW9mIHNldEludGVydmFsPiB8IG51bGw7XG4gIHJ1bklkOiBudW1iZXI7XG4gIHN0YXR1c0NhY2hlOiBNYXA8c3RyaW5nLCBTdGF0dXNDYWNoZUVudHJ5PjtcbiAgZGV0YWlsc0NhY2hlOiBNYXA8c3RyaW5nLCBEZXRhaWxzQ2FjaGVFbnRyeT47XG59XG5cbmNvbnN0IHN0YXRlOiBHaXRTaWRlYmFyU3RhdGUgPSB7XG4gIG9ic2VydmVyOiBudWxsLFxuICByZWZyZXNoVGltZXI6IG51bGwsXG4gIGludGVydmFsOiBudWxsLFxuICBydW5JZDogMCxcbiAgc3RhdHVzQ2FjaGU6IG5ldyBNYXAoKSxcbiAgZGV0YWlsc0NhY2hlOiBuZXcgTWFwKCksXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRHaXRTaWRlYmFyKCk6IHZvaWQge1xuICBpZiAoc3RhdGUub2JzZXJ2ZXIpIHJldHVybjtcblxuICBpbnN0YWxsU3R5bGVzKCk7XG5cbiAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigobXV0YXRpb25zKSA9PiB7XG4gICAgaWYgKG11dGF0aW9ucy5zb21lKHNob3VsZFJlYWN0VG9NdXRhdGlvbikpIHtcbiAgICAgIHNjaGVkdWxlUmVmcmVzaChcIm11dGF0aW9uXCIpO1xuICAgIH1cbiAgfSk7XG4gIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7XG4gICAgY2hpbGRMaXN0OiB0cnVlLFxuICAgIHN1YnRyZWU6IHRydWUsXG4gICAgYXR0cmlidXRlczogdHJ1ZSxcbiAgICBhdHRyaWJ1dGVGaWx0ZXI6IFtcbiAgICAgIFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZVwiLFxuICAgICAgXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWNvbGxhcHNlZFwiLFxuICAgICAgXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWlkXCIsXG4gICAgICBcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3Qtcm93XCIsXG4gICAgXSxcbiAgfSk7XG4gIHN0YXRlLm9ic2VydmVyID0gb2JzZXJ2ZXI7XG4gIHN0YXRlLmludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4gc2NoZWR1bGVSZWZyZXNoKFwiaW50ZXJ2YWxcIiksIDE1XzAwMCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNcIiwgb25XaW5kb3dGb2N1cyk7XG4gIHNjaGVkdWxlUmVmcmVzaChcImJvb3RcIik7XG59XG5cbmZ1bmN0aW9uIG9uV2luZG93Rm9jdXMoKTogdm9pZCB7XG4gIHNjaGVkdWxlUmVmcmVzaChcImZvY3VzXCIpO1xufVxuXG5mdW5jdGlvbiBzaG91bGRSZWFjdFRvTXV0YXRpb24obXV0YXRpb246IE11dGF0aW9uUmVjb3JkKTogYm9vbGVhbiB7XG4gIGlmIChtdXRhdGlvbi50eXBlID09PSBcImF0dHJpYnV0ZXNcIikge1xuICAgIGNvbnN0IHRhcmdldCA9IG11dGF0aW9uLnRhcmdldDtcbiAgICByZXR1cm4gdGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCAmJiAoXG4gICAgICB0YXJnZXQubWF0Y2hlcyhQUk9KRUNUX1JPV19TRUxFQ1RPUikgfHxcbiAgICAgIHRhcmdldC5tYXRjaGVzKEFDVElWRV9USFJFQURfU0VMRUNUT1IpIHx8XG4gICAgICB0YXJnZXQuaGFzQXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1saXN0LWlkXCIpXG4gICAgKTtcbiAgfVxuICBmb3IgKGNvbnN0IG5vZGUgb2YgQXJyYXkuZnJvbShtdXRhdGlvbi5hZGRlZE5vZGVzKSkge1xuICAgIGlmIChub2RlQ29udGFpbnNTaWRlYmFyUHJvamVjdChub2RlKSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgZm9yIChjb25zdCBub2RlIG9mIEFycmF5LmZyb20obXV0YXRpb24ucmVtb3ZlZE5vZGVzKSkge1xuICAgIGlmIChub2RlQ29udGFpbnNTaWRlYmFyUHJvamVjdChub2RlKSkgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBub2RlQ29udGFpbnNTaWRlYmFyUHJvamVjdChub2RlOiBOb2RlKTogYm9vbGVhbiB7XG4gIGlmICghKG5vZGUgaW5zdGFuY2VvZiBFbGVtZW50KSkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gbm9kZS5tYXRjaGVzKFBST0pFQ1RfUk9XX1NFTEVDVE9SKSB8fCBCb29sZWFuKG5vZGUucXVlcnlTZWxlY3RvcihQUk9KRUNUX1JPV19TRUxFQ1RPUikpO1xufVxuXG5mdW5jdGlvbiBzY2hlZHVsZVJlZnJlc2goX3JlYXNvbjogc3RyaW5nKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5yZWZyZXNoVGltZXIpIGNsZWFyVGltZW91dChzdGF0ZS5yZWZyZXNoVGltZXIpO1xuICBzdGF0ZS5yZWZyZXNoVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBzdGF0ZS5yZWZyZXNoVGltZXIgPSBudWxsO1xuICAgIHZvaWQgcmVmcmVzaCgpO1xuICB9LCBSRUZSRVNIX0RFQk9VTkNFX01TKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcnVuSWQgPSArK3N0YXRlLnJ1bklkO1xuICBjb25zdCBwcm9qZWN0cyA9IGNvbGxlY3RQcm9qZWN0Um93cygpO1xuICBpZiAocHJvamVjdHMubGVuZ3RoID09PSAwKSB7XG4gICAgcmVtb3ZlU3VtbWFyeVBhbmVsKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYWN0aXZlUGF0aCA9IGdldEFjdGl2ZVByb2plY3RQYXRoKHByb2plY3RzKTtcbiAgY29uc3QgYWN0aXZlUHJvamVjdCA9XG4gICAgKGFjdGl2ZVBhdGggPyBwcm9qZWN0cy5maW5kKChwcm9qZWN0KSA9PiBwcm9qZWN0LnBhdGggPT09IGFjdGl2ZVBhdGgpIDogbnVsbCkgPz9cbiAgICBwcm9qZWN0cy5maW5kKChwcm9qZWN0KSA9PiBwcm9qZWN0LnJvdy5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWNvbGxhcHNlZFwiKSA9PT0gXCJmYWxzZVwiKSA/P1xuICAgIHByb2plY3RzWzBdO1xuXG4gIGNvbnN0IGJhZGdlUHJvamVjdHMgPSBwcmlvcml0aXplQmFkZ2VQcm9qZWN0cyhwcm9qZWN0cywgYWN0aXZlUHJvamVjdCk7XG4gIGNvbnN0IGJhZGdlU3RhdHVzZXMgPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICBiYWRnZVByb2plY3RzLm1hcChhc3luYyAocHJvamVjdCkgPT4ge1xuICAgICAgY29uc3Qgc3RhdHVzID0gYXdhaXQgZ2V0U3RhdHVzKHByb2plY3QucGF0aCk7XG4gICAgICByZXR1cm4geyBwcm9qZWN0LCBzdGF0dXMgfTtcbiAgICB9KSxcbiAgKTtcbiAgaWYgKHJ1bklkICE9PSBzdGF0ZS5ydW5JZCkgcmV0dXJuO1xuICBmb3IgKGNvbnN0IHsgcHJvamVjdCwgc3RhdHVzIH0gb2YgYmFkZ2VTdGF0dXNlcykge1xuICAgIHJlbmRlclByb2plY3RCYWRnZShwcm9qZWN0LCBzdGF0dXMpO1xuICB9XG5cbiAgY29uc3Qgc3VtbWFyeVByb2plY3QgPVxuICAgIGJhZGdlU3RhdHVzZXMuZmluZCgoeyBwcm9qZWN0LCBzdGF0dXMgfSkgPT4gcHJvamVjdC5wYXRoID09PSBhY3RpdmVQcm9qZWN0Py5wYXRoICYmIGlzVXNhYmxlUmVwbyhzdGF0dXMpKVxuICAgICAgPy5wcm9qZWN0ID8/XG4gICAgYmFkZ2VTdGF0dXNlcy5maW5kKCh7IHN0YXR1cyB9KSA9PiBpc1VzYWJsZVJlcG8oc3RhdHVzKSk/LnByb2plY3QgPz9cbiAgICBhY3RpdmVQcm9qZWN0O1xuXG4gIGlmICghc3VtbWFyeVByb2plY3QpIHtcbiAgICByZW1vdmVTdW1tYXJ5UGFuZWwoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBbc3RhdHVzLCBkZXRhaWxzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBnZXRTdGF0dXMoc3VtbWFyeVByb2plY3QucGF0aCksXG4gICAgZ2V0RGV0YWlscyhzdW1tYXJ5UHJvamVjdC5wYXRoKSxcbiAgXSk7XG4gIGlmIChydW5JZCAhPT0gc3RhdGUucnVuSWQpIHJldHVybjtcbiAgcmVuZGVyU3VtbWFyeVBhbmVsKHN1bW1hcnlQcm9qZWN0LCBzdGF0dXMsIGRldGFpbHMpO1xufVxuXG5mdW5jdGlvbiBjb2xsZWN0UHJvamVjdFJvd3MoKTogUHJvamVjdFJvd1tdIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCByb3dzOiBQcm9qZWN0Um93W10gPSBbXTtcbiAgZm9yIChjb25zdCByb3cgb2YgQXJyYXkuZnJvbShkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihQUk9KRUNUX1JPV19TRUxFQ1RPUikpKSB7XG4gICAgY29uc3QgcGF0aCA9IHJvdy5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWlkXCIpPy50cmltKCk7XG4gICAgaWYgKCFwYXRoIHx8IHNlZW4uaGFzKHBhdGgpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZChwYXRoKTtcbiAgICByb3dzLnB1c2goe1xuICAgICAgcm93LFxuICAgICAgcGF0aCxcbiAgICAgIGxhYmVsOiByb3cuZ2V0QXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1sYWJlbFwiKT8udHJpbSgpIHx8IGJhc2VuYW1lKHBhdGgpLFxuICAgICAgZ3JvdXA6IGZpbmRQcm9qZWN0R3JvdXAocm93KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gcm93cztcbn1cblxuZnVuY3Rpb24gZmluZFByb2plY3RHcm91cChyb3c6IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgbGV0IGN1cnJlbnQ6IEhUTUxFbGVtZW50IHwgbnVsbCA9IHJvdy5wYXJlbnRFbGVtZW50O1xuICB3aGlsZSAoY3VycmVudCAmJiBjdXJyZW50ICE9PSBkb2N1bWVudC5ib2R5KSB7XG4gICAgaWYgKGN1cnJlbnQuZ2V0QXR0cmlidXRlKFwicm9sZVwiKSA9PT0gXCJsaXN0aXRlbVwiICYmIGN1cnJlbnQudGV4dENvbnRlbnQ/LmluY2x1ZGVzKHJvdy50ZXh0Q29udGVudCA/PyBcIlwiKSkge1xuICAgICAgcmV0dXJuIGN1cnJlbnQ7XG4gICAgfVxuICAgIGlmIChjdXJyZW50LnF1ZXJ5U2VsZWN0b3IoUFJPSkVDVF9ST1dfU0VMRUNUT1IpID09PSByb3cgJiYgY3VycmVudC5xdWVyeVNlbGVjdG9yKFBST0pFQ1RfTElTVF9TRUxFQ1RPUikpIHtcbiAgICAgIHJldHVybiBjdXJyZW50O1xuICAgIH1cbiAgICBjdXJyZW50ID0gY3VycmVudC5wYXJlbnRFbGVtZW50O1xuICB9XG4gIHJldHVybiByb3cucGFyZW50RWxlbWVudDtcbn1cblxuZnVuY3Rpb24gZ2V0QWN0aXZlUHJvamVjdFBhdGgocHJvamVjdHM6IFByb2plY3RSb3dbXSk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBhY3RpdmVUaHJlYWQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihBQ1RJVkVfVEhSRUFEX1NFTEVDVE9SKTtcbiAgY29uc3QgcHJvamVjdExpc3QgPSBhY3RpdmVUaHJlYWQ/LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KFBST0pFQ1RfTElTVF9TRUxFQ1RPUik7XG4gIGNvbnN0IGxpc3RQYXRoID0gcHJvamVjdExpc3Q/LmdldEF0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtbGlzdC1pZFwiKT8udHJpbSgpO1xuICBpZiAobGlzdFBhdGgpIHJldHVybiBsaXN0UGF0aDtcblxuICBjb25zdCBleHBhbmRlZCA9IHByb2plY3RzLmZpbmQoXG4gICAgKHByb2plY3QpID0+IHByb2plY3Qucm93LmdldEF0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtY29sbGFwc2VkXCIpID09PSBcImZhbHNlXCIsXG4gICk7XG4gIHJldHVybiBleHBhbmRlZD8ucGF0aCA/PyBudWxsO1xufVxuXG5mdW5jdGlvbiBwcmlvcml0aXplQmFkZ2VQcm9qZWN0cyhwcm9qZWN0czogUHJvamVjdFJvd1tdLCBhY3RpdmVQcm9qZWN0OiBQcm9qZWN0Um93IHwgdW5kZWZpbmVkKTogUHJvamVjdFJvd1tdIHtcbiAgY29uc3QgdmlzaWJsZSA9IHByb2plY3RzLmZpbHRlcigocHJvamVjdCkgPT4ge1xuICAgIGNvbnN0IHJlY3QgPSBwcm9qZWN0LnJvdy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICByZXR1cm4gcmVjdC53aWR0aCA+IDAgJiYgcmVjdC5oZWlnaHQgPiAwICYmIHJlY3QuYm90dG9tID49IDAgJiYgcmVjdC50b3AgPD0gd2luZG93LmlubmVySGVpZ2h0O1xuICB9KTtcbiAgY29uc3Qgb3JkZXJlZCA9IGFjdGl2ZVByb2plY3RcbiAgICA/IFthY3RpdmVQcm9qZWN0LCAuLi52aXNpYmxlLmZpbHRlcigocHJvamVjdCkgPT4gcHJvamVjdC5wYXRoICE9PSBhY3RpdmVQcm9qZWN0LnBhdGgpXVxuICAgIDogdmlzaWJsZTtcbiAgcmV0dXJuIG9yZGVyZWQuc2xpY2UoMCwgTUFYX1ZJU0lCTEVfUFJPSkVDVF9CQURHRVMpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRTdGF0dXMocGF0aDogc3RyaW5nKTogUHJvbWlzZTxHaXRTdGF0dXMgfCBudWxsPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IGNhY2hlZCA9IHN0YXRlLnN0YXR1c0NhY2hlLmdldChwYXRoKTtcbiAgaWYgKGNhY2hlZD8udmFsdWUgJiYgbm93IC0gY2FjaGVkLmxvYWRlZEF0IDwgU1RBVFVTX1RUTF9NUykgcmV0dXJuIGNhY2hlZC52YWx1ZTtcbiAgaWYgKGNhY2hlZD8ucGVuZGluZykgcmV0dXJuIGNhY2hlZC5wZW5kaW5nO1xuXG4gIGNvbnN0IGVudHJ5OiBTdGF0dXNDYWNoZUVudHJ5ID0gY2FjaGVkID8/IHtcbiAgICB2YWx1ZTogbnVsbCxcbiAgICBlcnJvcjogbnVsbCxcbiAgICBsb2FkZWRBdDogMCxcbiAgICBwZW5kaW5nOiBudWxsLFxuICB9O1xuICBlbnRyeS5wZW5kaW5nID0gaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnaXQtc3RhdHVzXCIsIHBhdGgpXG4gICAgLnRoZW4oKHN0YXR1cykgPT4ge1xuICAgICAgZW50cnkudmFsdWUgPSBzdGF0dXMgYXMgR2l0U3RhdHVzO1xuICAgICAgZW50cnkuZXJyb3IgPSBudWxsO1xuICAgICAgZW50cnkubG9hZGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgcmV0dXJuIGVudHJ5LnZhbHVlO1xuICAgIH0pXG4gICAgLmNhdGNoKChlcnJvcjogdW5rbm93bikgPT4ge1xuICAgICAgZW50cnkuZXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICBlbnRyeS5sb2FkZWRBdCA9IERhdGUubm93KCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGVudHJ5LnBlbmRpbmcgPSBudWxsO1xuICAgIH0pO1xuICBzdGF0ZS5zdGF0dXNDYWNoZS5zZXQocGF0aCwgZW50cnkpO1xuICByZXR1cm4gZW50cnkucGVuZGluZztcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0RGV0YWlscyhwYXRoOiBzdHJpbmcpOiBQcm9taXNlPEdpdERldGFpbHMgfCBudWxsPiB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGNvbnN0IGNhY2hlZCA9IHN0YXRlLmRldGFpbHNDYWNoZS5nZXQocGF0aCk7XG4gIGlmIChjYWNoZWQ/LnZhbHVlICYmIG5vdyAtIGNhY2hlZC5sb2FkZWRBdCA8IERFVEFJTFNfVFRMX01TKSByZXR1cm4gY2FjaGVkLnZhbHVlO1xuICBpZiAoY2FjaGVkPy5wZW5kaW5nKSByZXR1cm4gY2FjaGVkLnBlbmRpbmc7XG5cbiAgY29uc3QgZW50cnk6IERldGFpbHNDYWNoZUVudHJ5ID0gY2FjaGVkID8/IHtcbiAgICB2YWx1ZTogbnVsbCxcbiAgICBlcnJvcjogbnVsbCxcbiAgICBsb2FkZWRBdDogMCxcbiAgICBwZW5kaW5nOiBudWxsLFxuICB9O1xuICBlbnRyeS5wZW5kaW5nID0gUHJvbWlzZS5hbGwoW1xuICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LWRpZmYtc3VtbWFyeVwiLCBwYXRoKSBhcyBQcm9taXNlPEdpdERpZmZTdW1tYXJ5PixcbiAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdpdC13b3JrdHJlZXNcIiwgcGF0aCkgYXMgUHJvbWlzZTxHaXRXb3JrdHJlZVtdPixcbiAgXSlcbiAgICAudGhlbigoW2RpZmYsIHdvcmt0cmVlc10pID0+IHtcbiAgICAgIGVudHJ5LnZhbHVlID0geyBkaWZmLCB3b3JrdHJlZXMgfTtcbiAgICAgIGVudHJ5LmVycm9yID0gbnVsbDtcbiAgICAgIGVudHJ5LmxvYWRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHJldHVybiBlbnRyeS52YWx1ZTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyb3I6IHVua25vd24pID0+IHtcbiAgICAgIGVudHJ5LmVycm9yID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgZW50cnkubG9hZGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICBlbnRyeS5wZW5kaW5nID0gbnVsbDtcbiAgICB9KTtcbiAgc3RhdGUuZGV0YWlsc0NhY2hlLnNldChwYXRoLCBlbnRyeSk7XG4gIHJldHVybiBlbnRyeS5wZW5kaW5nO1xufVxuXG5mdW5jdGlvbiByZW5kZXJQcm9qZWN0QmFkZ2UocHJvamVjdDogUHJvamVjdFJvdywgc3RhdHVzOiBHaXRTdGF0dXMgfCBudWxsKTogdm9pZCB7XG4gIGlmICghaXNVc2FibGVSZXBvKHN0YXR1cykpIHtcbiAgICBwcm9qZWN0LnJvdy5xdWVyeVNlbGVjdG9yKGBbJHtCQURHRV9BVFRSfV1gKT8ucmVtb3ZlKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgYmFkZ2UgPSBlbnN1cmVCYWRnZShwcm9qZWN0LnJvdyk7XG4gIGNvbnN0IGRpcnR5ID0gY291bnREaXJ0eShzdGF0dXMuZW50cmllcyk7XG4gIGNvbnN0IGNvbmZsaWN0cyA9IGNvdW50Q29uZmxpY3RzKHN0YXR1cy5lbnRyaWVzKTtcbiAgY29uc3QgYnJhbmNoID0gYnJhbmNoTGFiZWwoc3RhdHVzKTtcbiAgY29uc3Qgc3luYyA9IHN5bmNMYWJlbChzdGF0dXMpO1xuICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKFwiY29kZXhwcC1naXQtYmFkZ2UtZGlydHlcIiwgZGlydHkgPiAwKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcImNvZGV4cHAtZ2l0LWJhZGdlLWNvbmZsaWN0XCIsIGNvbmZsaWN0cyA+IDApO1xuICBiYWRnZS50aXRsZSA9IFtcbiAgICBgJHtwcm9qZWN0LmxhYmVsfTogJHticmFuY2h9YCxcbiAgICBkaXJ0eSA9PT0gMCA/IFwiY2xlYW5cIiA6IGAke2RpcnR5fSBjaGFuZ2VkYCxcbiAgICBjb25mbGljdHMgPiAwID8gYCR7Y29uZmxpY3RzfSBjb25mbGljdCR7cGx1cmFsKGNvbmZsaWN0cyl9YCA6IFwiXCIsXG4gICAgc3luYy50aXRsZSxcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiwgXCIpO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IFticmFuY2gsIGRpcnR5ID4gMCA/IFN0cmluZyhkaXJ0eSkgOiBcIlwiLCBzeW5jLnNob3J0XS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZUJhZGdlKHJvdzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGV4aXN0aW5nID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KGBbJHtCQURHRV9BVFRSfV1gKTtcbiAgaWYgKGV4aXN0aW5nKSByZXR1cm4gZXhpc3Rpbmc7XG5cbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2Uuc2V0QXR0cmlidXRlKEJBREdFX0FUVFIsIFwiXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ2l0LXByb2plY3QtYmFkZ2VcIjtcbiAgcm93LmFwcGVuZENoaWxkKGJhZGdlKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiByZW5kZXJTdW1tYXJ5UGFuZWwocHJvamVjdDogUHJvamVjdFJvdywgc3RhdHVzOiBHaXRTdGF0dXMgfCBudWxsLCBkZXRhaWxzOiBHaXREZXRhaWxzIHwgbnVsbCk6IHZvaWQge1xuICBpZiAoIWlzVXNhYmxlUmVwbyhzdGF0dXMpKSB7XG4gICAgcmVtb3ZlU3VtbWFyeVBhbmVsKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaG9zdCA9IHByb2plY3QuZ3JvdXAgPz8gcHJvamVjdC5yb3cucGFyZW50RWxlbWVudDtcbiAgaWYgKCFob3N0KSByZXR1cm47XG5cbiAgY29uc3QgcGFuZWwgPSBlbnN1cmVTdW1tYXJ5UGFuZWwoaG9zdCwgcHJvamVjdC5yb3cpO1xuICBjbGVhcihwYW5lbCk7XG5cbiAgY29uc3QgZGlydHkgPSBjb3VudERpcnR5KHN0YXR1cy5lbnRyaWVzKTtcbiAgY29uc3QgY291bnRzID0gY291bnRTdGF0dXMoc3RhdHVzLmVudHJpZXMpO1xuICBjb25zdCBicmFuY2ggPSBicmFuY2hMYWJlbChzdGF0dXMpO1xuICBjb25zdCBzeW5jID0gc3luY0xhYmVsKHN0YXR1cyk7XG4gIGNvbnN0IGRpZmYgPSBkZXRhaWxzPy5kaWZmID8/IG51bGw7XG4gIGNvbnN0IHdvcmt0cmVlcyA9IGRldGFpbHM/Lndvcmt0cmVlcyA/PyBbXTtcblxuICBjb25zdCBoZWFkZXIgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LXN1bW1hcnktaGVhZGVyXCIpO1xuICBjb25zdCB0aXRsZSA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtc3VtbWFyeS10aXRsZVwiKTtcbiAgdGl0bGUuYXBwZW5kKHRleHRFbChcInNwYW5cIiwgXCJHaXRcIikpO1xuICB0aXRsZS5hcHBlbmQodGV4dEVsKFwic3Ryb25nXCIsIGJyYW5jaCkpO1xuICBpZiAoc3luYy5zaG9ydCkgdGl0bGUuYXBwZW5kKHRleHRFbChcInNwYW5cIiwgc3luYy5zaG9ydCkpO1xuICBjb25zdCBzdGF0ZUNoaXAgPSB0ZXh0RWwoXCJzcGFuXCIsIGRpcnR5ID09PSAwID8gXCJjbGVhblwiIDogYCR7ZGlydHl9IGNoYW5nZWRgKTtcbiAgc3RhdGVDaGlwLmNsYXNzTmFtZSA9IGBjb2RleHBwLWdpdC1zdW1tYXJ5LXN0YXRlICR7ZGlydHkgPT09IDAgPyBcImlzLWNsZWFuXCIgOiBcImlzLWRpcnR5XCJ9YDtcbiAgaGVhZGVyLmFwcGVuZCh0aXRsZSwgc3RhdGVDaGlwKTtcbiAgcGFuZWwuYXBwZW5kKGhlYWRlcik7XG5cbiAgY29uc3QgbWV0cmljcyA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtc3VtbWFyeS1tZXRyaWNzXCIpO1xuICBtZXRyaWNzLmFwcGVuZChcbiAgICBtZXRyaWMoXCJzdGFnZWRcIiwgY291bnRzLnN0YWdlZCksXG4gICAgbWV0cmljKFwidW5zdGFnZWRcIiwgY291bnRzLnVuc3RhZ2VkKSxcbiAgICBtZXRyaWMoXCJ1bnRyYWNrZWRcIiwgY291bnRzLnVudHJhY2tlZCksXG4gICAgbWV0cmljKFwiY29uZmxpY3RzXCIsIGNvdW50cy5jb25mbGljdHMpLFxuICApO1xuICBwYW5lbC5hcHBlbmQobWV0cmljcyk7XG5cbiAgaWYgKGRpZmYpIHtcbiAgICBjb25zdCBkaWZmTGluZSA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtc3VtbWFyeS1saW5lXCIpO1xuICAgIGRpZmZMaW5lLmFwcGVuZChcbiAgICAgIHRleHRFbChcInNwYW5cIiwgYCR7ZGlmZi5maWxlQ291bnR9IGZpbGUke3BsdXJhbChkaWZmLmZpbGVDb3VudCl9YCksXG4gICAgICB0ZXh0RWwoXCJzcGFuXCIsIGArJHtkaWZmLmluc2VydGlvbnN9YCksXG4gICAgICB0ZXh0RWwoXCJzcGFuXCIsIGAtJHtkaWZmLmRlbGV0aW9uc31gKSxcbiAgICAgIC4uLihkaWZmLnRydW5jYXRlZCA/IFt0ZXh0RWwoXCJzcGFuXCIsIFwidHJ1bmNhdGVkXCIpXSA6IFtdKSxcbiAgICApO1xuICAgIHBhbmVsLmFwcGVuZChkaWZmTGluZSk7XG4gIH1cblxuICBjb25zdCBjaGFuZ2VkID0gc3RhdHVzLmVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkua2luZCAhPT0gXCJpZ25vcmVkXCIpLnNsaWNlKDAsIE1BWF9DSEFOR0VEX0ZJTEVTKTtcbiAgaWYgKGNoYW5nZWQubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGxpc3QgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LWNoYW5nZWQtZmlsZXNcIik7XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBjaGFuZ2VkKSB7XG4gICAgICBjb25zdCByb3cgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LWZpbGUtcm93XCIpO1xuICAgICAgcm93LmFwcGVuZCh0ZXh0RWwoXCJzcGFuXCIsIGVudHJ5TGFiZWwoZW50cnkpKSwgdGV4dEVsKFwic3BhblwiLCBlbnRyeVBhdGgoZW50cnkpKSk7XG4gICAgICBsaXN0LmFwcGVuZChyb3cpO1xuICAgIH1cbiAgICBpZiAoc3RhdHVzLmVudHJpZXMubGVuZ3RoID4gY2hhbmdlZC5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IG1vcmUgPSB0ZXh0RWwoXCJkaXZcIiwgYCske3N0YXR1cy5lbnRyaWVzLmxlbmd0aCAtIGNoYW5nZWQubGVuZ3RofSBtb3JlYCk7XG4gICAgICBtb3JlLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1naXQtbW9yZVwiO1xuICAgICAgbGlzdC5hcHBlbmQobW9yZSk7XG4gICAgfVxuICAgIHBhbmVsLmFwcGVuZChsaXN0KTtcbiAgfVxuXG4gIGlmICh3b3JrdHJlZXMubGVuZ3RoID4gMSkge1xuICAgIGNvbnN0IHdvcmt0cmVlTGlzdCA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtd29ya3RyZWVzXCIpO1xuICAgIGNvbnN0IGxhYmVsID0gdGV4dEVsKFwiZGl2XCIsIGAke3dvcmt0cmVlcy5sZW5ndGh9IHdvcmt0cmVlc2ApO1xuICAgIGxhYmVsLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1naXQtd29ya3RyZWVzLWxhYmVsXCI7XG4gICAgd29ya3RyZWVMaXN0LmFwcGVuZChsYWJlbCk7XG4gICAgZm9yIChjb25zdCB3b3JrdHJlZSBvZiB3b3JrdHJlZXMuc2xpY2UoMCwgTUFYX1dPUktUUkVFX1JPV1MpKSB7XG4gICAgICBjb25zdCByb3cgPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvd1wiKTtcbiAgICAgIHJvdy5hcHBlbmQoXG4gICAgICAgIHRleHRFbChcInNwYW5cIiwgd29ya3RyZWUuYnJhbmNoID8/IHNob3J0U2hhKHdvcmt0cmVlLmhlYWQpID8/IFwiZGV0YWNoZWRcIiksXG4gICAgICAgIHRleHRFbChcInNwYW5cIiwgYmFzZW5hbWUod29ya3RyZWUucGF0aCkpLFxuICAgICAgKTtcbiAgICAgIHdvcmt0cmVlTGlzdC5hcHBlbmQocm93KTtcbiAgICB9XG4gICAgcGFuZWwuYXBwZW5kKHdvcmt0cmVlTGlzdCk7XG4gIH1cblxuICBjb25zdCBpc3N1ZSA9IHN0YXR1cy5yZXBvc2l0b3J5LmVycm9yPy5tZXNzYWdlIHx8IHN0YXRlLnN0YXR1c0NhY2hlLmdldChwcm9qZWN0LnBhdGgpPy5lcnJvciB8fCBzdGF0ZS5kZXRhaWxzQ2FjaGUuZ2V0KHByb2plY3QucGF0aCk/LmVycm9yO1xuICBpZiAoaXNzdWUpIHtcbiAgICBjb25zdCB3YXJuaW5nID0gdGV4dEVsKFwiZGl2XCIsIGlzc3VlKTtcbiAgICB3YXJuaW5nLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1naXQtd2FybmluZ1wiO1xuICAgIHBhbmVsLmFwcGVuZCh3YXJuaW5nKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc1VzYWJsZVJlcG8oc3RhdHVzOiBHaXRTdGF0dXMgfCBudWxsKTogc3RhdHVzIGlzIEdpdFN0YXR1cyB7XG4gIHJldHVybiBCb29sZWFuKHN0YXR1cz8ucmVwb3NpdG9yeS5mb3VuZCAmJiBzdGF0dXMucmVwb3NpdG9yeS5pc0luc2lkZVdvcmtUcmVlKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlU3VtbWFyeVBhbmVsKGhvc3Q6IEhUTUxFbGVtZW50LCByb3c6IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQge1xuICBsZXQgcGFuZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihgWyR7U1VNTUFSWV9BVFRSfV1gKTtcbiAgaWYgKCFwYW5lbCkge1xuICAgIHBhbmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gICAgcGFuZWwuc2V0QXR0cmlidXRlKFNVTU1BUllfQVRUUiwgXCJcIik7XG4gICAgcGFuZWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdpdC1zdW1tYXJ5XCI7XG4gIH1cblxuICBpZiAocGFuZWwucGFyZW50RWxlbWVudCAhPT0gaG9zdCkge1xuICAgIHBhbmVsLnJlbW92ZSgpO1xuICAgIGhvc3QuaW5zZXJ0QmVmb3JlKHBhbmVsLCByb3cubmV4dEVsZW1lbnRTaWJsaW5nKTtcbiAgfSBlbHNlIGlmIChwYW5lbC5wcmV2aW91c0VsZW1lbnRTaWJsaW5nICE9PSByb3cpIHtcbiAgICBob3N0Lmluc2VydEJlZm9yZShwYW5lbCwgcm93Lm5leHRFbGVtZW50U2libGluZyk7XG4gIH1cblxuICByZXR1cm4gcGFuZWw7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZVN1bW1hcnlQYW5lbCgpOiB2b2lkIHtcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcihgWyR7U1VNTUFSWV9BVFRSfV1gKT8ucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIGNvdW50U3RhdHVzKGVudHJpZXM6IEdpdFN0YXR1c0VudHJ5W10pOiB7XG4gIHN0YWdlZDogbnVtYmVyO1xuICB1bnN0YWdlZDogbnVtYmVyO1xuICB1bnRyYWNrZWQ6IG51bWJlcjtcbiAgY29uZmxpY3RzOiBudW1iZXI7XG59IHtcbiAgbGV0IHN0YWdlZCA9IDA7XG4gIGxldCB1bnN0YWdlZCA9IDA7XG4gIGxldCB1bnRyYWNrZWQgPSAwO1xuICBsZXQgY29uZmxpY3RzID0gMDtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgc3dpdGNoIChlbnRyeS5raW5kKSB7XG4gICAgICBjYXNlIFwib3JkaW5hcnlcIjpcbiAgICAgIGNhc2UgXCJyZW5hbWVcIjpcbiAgICAgICAgaWYgKGVudHJ5LmluZGV4ICE9PSBcIi5cIikgc3RhZ2VkKys7XG4gICAgICAgIGlmIChlbnRyeS53b3JrdHJlZSAhPT0gXCIuXCIpIHVuc3RhZ2VkKys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcInVudHJhY2tlZFwiOlxuICAgICAgICB1bnRyYWNrZWQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidW5tZXJnZWRcIjpcbiAgICAgICAgY29uZmxpY3RzKys7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBcImlnbm9yZWRcIjpcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IHN0YWdlZCwgdW5zdGFnZWQsIHVudHJhY2tlZCwgY29uZmxpY3RzIH07XG59XG5cbmZ1bmN0aW9uIGNvdW50RGlydHkoZW50cmllczogR2l0U3RhdHVzRW50cnlbXSk6IG51bWJlciB7XG4gIHJldHVybiBlbnRyaWVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LmtpbmQgIT09IFwiaWdub3JlZFwiKS5sZW5ndGg7XG59XG5cbmZ1bmN0aW9uIGNvdW50Q29uZmxpY3RzKGVudHJpZXM6IEdpdFN0YXR1c0VudHJ5W10pOiBudW1iZXIge1xuICByZXR1cm4gZW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5raW5kID09PSBcInVubWVyZ2VkXCIpLmxlbmd0aDtcbn1cblxuZnVuY3Rpb24gYnJhbmNoTGFiZWwoc3RhdHVzOiBHaXRTdGF0dXMpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgIHN0YXR1cy5icmFuY2guaGVhZCA/P1xuICAgIHN0YXR1cy5yZXBvc2l0b3J5LmhlYWRCcmFuY2ggPz9cbiAgICBzaG9ydFNoYShzdGF0dXMuYnJhbmNoLm9pZCkgPz9cbiAgICBzaG9ydFNoYShzdGF0dXMucmVwb3NpdG9yeS5oZWFkU2hhKSA/P1xuICAgIFwiZGV0YWNoZWRcIlxuICApO1xufVxuXG5mdW5jdGlvbiBzeW5jTGFiZWwoc3RhdHVzOiBHaXRTdGF0dXMpOiB7IHNob3J0OiBzdHJpbmc7IHRpdGxlOiBzdHJpbmcgfSB7XG4gIGNvbnN0IGFoZWFkID0gc3RhdHVzLmJyYW5jaC5haGVhZCA/PyAwO1xuICBjb25zdCBiZWhpbmQgPSBzdGF0dXMuYnJhbmNoLmJlaGluZCA/PyAwO1xuICBjb25zdCBzaG9ydCA9IFthaGVhZCA+IDAgPyBgQSR7YWhlYWR9YCA6IFwiXCIsIGJlaGluZCA+IDAgPyBgQiR7YmVoaW5kfWAgOiBcIlwiXVxuICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAuam9pbihcIi9cIik7XG4gIGNvbnN0IHRpdGxlID0gW1xuICAgIGFoZWFkID4gMCA/IGAke2FoZWFkfSBhaGVhZGAgOiBcIlwiLFxuICAgIGJlaGluZCA+IDAgPyBgJHtiZWhpbmR9IGJlaGluZGAgOiBcIlwiLFxuICAgIHN0YXR1cy5icmFuY2gudXBzdHJlYW0gPyBgdXBzdHJlYW0gJHtzdGF0dXMuYnJhbmNoLnVwc3RyZWFtfWAgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiLCBcIik7XG4gIHJldHVybiB7IHNob3J0LCB0aXRsZSB9O1xufVxuXG5mdW5jdGlvbiBlbnRyeUxhYmVsKGVudHJ5OiBHaXRTdGF0dXNFbnRyeSk6IHN0cmluZyB7XG4gIHN3aXRjaCAoZW50cnkua2luZCkge1xuICAgIGNhc2UgXCJvcmRpbmFyeVwiOlxuICAgICAgcmV0dXJuIGAke2VudHJ5LmluZGV4fSR7ZW50cnkud29ya3RyZWV9YC5yZXBsYWNlQWxsKFwiLlwiLCBcIlwiKTtcbiAgICBjYXNlIFwicmVuYW1lXCI6XG4gICAgICByZXR1cm4gXCJSXCI7XG4gICAgY2FzZSBcInVubWVyZ2VkXCI6XG4gICAgICByZXR1cm4gXCJVVVwiO1xuICAgIGNhc2UgXCJ1bnRyYWNrZWRcIjpcbiAgICAgIHJldHVybiBcIj8/XCI7XG4gICAgY2FzZSBcImlnbm9yZWRcIjpcbiAgICAgIHJldHVybiBcIiEhXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW50cnlQYXRoKGVudHJ5OiBHaXRTdGF0dXNFbnRyeSk6IHN0cmluZyB7XG4gIGlmIChlbnRyeS5raW5kID09PSBcInJlbmFtZVwiKSByZXR1cm4gYCR7ZW50cnkub3JpZ2luYWxQYXRofSAtPiAke2VudHJ5LnBhdGh9YDtcbiAgcmV0dXJuIGVudHJ5LnBhdGg7XG59XG5cbmZ1bmN0aW9uIG1ldHJpYyhsYWJlbDogc3RyaW5nLCB2YWx1ZTogbnVtYmVyKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBpdGVtID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC1tZXRyaWNcIik7XG4gIGl0ZW0uYXBwZW5kKHRleHRFbChcInNwYW5cIiwgU3RyaW5nKHZhbHVlKSksIHRleHRFbChcInNwYW5cIiwgbGFiZWwpKTtcbiAgcmV0dXJuIGl0ZW07XG59XG5cbmZ1bmN0aW9uIHNob3J0U2hhKHNoYTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gc2hhID8gc2hhLnNsaWNlKDAsIDcpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gYmFzZW5hbWUocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IHBhdGgucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgY29uc3QgaWR4ID0gdHJpbW1lZC5sYXN0SW5kZXhPZihcIi9cIik7XG4gIHJldHVybiBpZHggPj0gMCA/IHRyaW1tZWQuc2xpY2UoaWR4ICsgMSkgOiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBwbHVyYWwoY291bnQ6IG51bWJlcik6IHN0cmluZyB7XG4gIHJldHVybiBjb3VudCA9PT0gMSA/IFwiXCIgOiBcInNcIjtcbn1cblxuZnVuY3Rpb24gY2xlYXIobm9kZTogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgd2hpbGUgKG5vZGUuZmlyc3RDaGlsZCkgbm9kZS5maXJzdENoaWxkLnJlbW92ZSgpO1xufVxuXG5mdW5jdGlvbiBlbCh0YWc6IFwiZGl2XCIgfCBcInNlY3Rpb25cIiwgY2xhc3NOYW1lOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IG5vZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7XG4gIG5vZGUuY2xhc3NOYW1lID0gY2xhc3NOYW1lO1xuICByZXR1cm4gbm9kZTtcbn1cblxuZnVuY3Rpb24gdGV4dEVsKHRhZzogXCJkaXZcIiB8IFwic3BhblwiIHwgXCJzdHJvbmdcIiwgdGV4dDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBub2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh0YWcpO1xuICBub2RlLnRleHRDb250ZW50ID0gdGV4dDtcbiAgcmV0dXJuIG5vZGU7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxTdHlsZXMoKTogdm9pZCB7XG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChTVFlMRV9JRCkpIHJldHVybjtcbiAgY29uc3Qgc3R5bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3R5bGVcIik7XG4gIHN0eWxlLmlkID0gU1RZTEVfSUQ7XG4gIHN0eWxlLnRleHRDb250ZW50ID0gYFxuICAgIC5jb2RleHBwLWdpdC1wcm9qZWN0LWJhZGdlIHtcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICBib3JkZXI6IDFweCBzb2xpZCBjb2xvci1taXgoaW4gc3JnYiwgY3VycmVudENvbG9yIDE4JSwgdHJhbnNwYXJlbnQpO1xuICAgICAgYm9yZGVyLXJhZGl1czogNXB4O1xuICAgICAgY29sb3I6IHZhcigtLXRleHQtdGVydGlhcnksIGN1cnJlbnRDb2xvcik7XG4gICAgICBkaXNwbGF5OiBpbmxpbmUtZmxleDtcbiAgICAgIGZsZXg6IDAgMSBhdXRvO1xuICAgICAgZm9udDogNTAwIDEwcHgvMS4yIHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlO1xuICAgICAgZ2FwOiAzcHg7XG4gICAgICBsZXR0ZXItc3BhY2luZzogMDtcbiAgICAgIG1hcmdpbi1sZWZ0OiA2cHg7XG4gICAgICBtYXgtd2lkdGg6IDQ4JTtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICAgIG9wYWNpdHk6IDAuNzI7XG4gICAgICBvdmVyZmxvdzogaGlkZGVuO1xuICAgICAgcGFkZGluZzogMnB4IDRweDtcbiAgICAgIHBvaW50ZXItZXZlbnRzOiBub25lO1xuICAgICAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG4gICAgICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtcHJvamVjdC1iYWRnZS5jb2RleHBwLWdpdC1iYWRnZS1kaXJ0eSB7XG4gICAgICBib3JkZXItY29sb3I6IGNvbG9yLW1peChpbiBzcmdiLCB2YXIoLS1jb2RleHBwLXByb2plY3QtdGludCwgY3VycmVudENvbG9yKSA0MiUsIHRyYW5zcGFyZW50KTtcbiAgICAgIGNvbG9yOiB2YXIoLS1jb2RleHBwLXByb2plY3QtdGV4dC1jb2xvciwgY3VycmVudENvbG9yKTtcbiAgICAgIG9wYWNpdHk6IDAuOTQ7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1wcm9qZWN0LWJhZGdlLmNvZGV4cHAtZ2l0LWJhZGdlLWNvbmZsaWN0IHtcbiAgICAgIGJvcmRlci1jb2xvcjogcmdiYSgyMjAsIDM4LCAzOCwgMC42NSk7XG4gICAgICBjb2xvcjogcmdiKDIyMCwgMzgsIDM4KTtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnkge1xuICAgICAgYm9yZGVyLWxlZnQ6IDJweCBzb2xpZCB2YXIoLS1jb2RleHBwLXByb2plY3QtdGludCwgY29sb3ItbWl4KGluIHNyZ2IsIGN1cnJlbnRDb2xvciA0MCUsIHRyYW5zcGFyZW50KSk7XG4gICAgICBib3gtc2l6aW5nOiBib3JkZXItYm94O1xuICAgICAgY29sb3I6IHZhcigtLXRleHQtcHJpbWFyeSwgY3VycmVudENvbG9yKTtcbiAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICAgICAgZ2FwOiA2cHg7XG4gICAgICBtYXJnaW46IDFweCA4cHggN3B4IDE4cHg7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgICBwYWRkaW5nOiA3cHggOHB4IDhweCA4cHg7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LWhlYWRlcixcbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1saW5lLFxuICAgIC5jb2RleHBwLWdpdC1maWxlLXJvdyxcbiAgICAuY29kZXhwcC1naXQtd29ya3RyZWUtcm93IHtcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgZ2FwOiA2cHg7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LWhlYWRlciB7XG4gICAgICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXRpdGxlIHtcbiAgICAgIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgZ2FwOiA1cHg7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXRpdGxlIHNwYW46Zmlyc3QtY2hpbGQsXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlcy1sYWJlbCB7XG4gICAgICBjb2xvcjogdmFyKC0tdGV4dC10ZXJ0aWFyeSwgY3VycmVudENvbG9yKTtcbiAgICAgIGZvbnQ6IDYwMCAxMHB4LzEuMiBzeXN0ZW0tdWksIC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgc2Fucy1zZXJpZjtcbiAgICAgIG9wYWNpdHk6IDAuNztcbiAgICAgIHRleHQtdHJhbnNmb3JtOiB1cHBlcmNhc2U7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXRpdGxlIHN0cm9uZyB7XG4gICAgICBmb250OiA2MDAgMTJweC8xLjI1IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlO1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgICAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgICAgIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktc3RhdGUge1xuICAgICAgYm9yZGVyLXJhZGl1czogNXB4O1xuICAgICAgZmxleDogMCAwIGF1dG87XG4gICAgICBmb250OiA2MDAgMTBweC8xLjIgc3lzdGVtLXVpLCAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIHNhbnMtc2VyaWY7XG4gICAgICBwYWRkaW5nOiAycHggNXB4O1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1zdGF0ZS5pcy1jbGVhbiB7XG4gICAgICBiYWNrZ3JvdW5kOiByZ2JhKDM0LCAxOTcsIDk0LCAwLjEyKTtcbiAgICAgIGNvbG9yOiByZ2IoMjIsIDE2MywgNzQpO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1zdGF0ZS5pcy1kaXJ0eSB7XG4gICAgICBiYWNrZ3JvdW5kOiByZ2JhKDI0NSwgMTU4LCAxMSwgMC4xMik7XG4gICAgICBjb2xvcjogcmdiKDE4MCwgODMsIDkpO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1tZXRyaWNzIHtcbiAgICAgIGRpc3BsYXk6IGdyaWQ7XG4gICAgICBnYXA6IDRweDtcbiAgICAgIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDQsIG1pbm1heCgwLCAxZnIpKTtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LW1ldHJpYyB7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1tZXRyaWMgc3BhbjpmaXJzdC1jaGlsZCB7XG4gICAgICBkaXNwbGF5OiBibG9jaztcbiAgICAgIGZvbnQ6IDYwMCAxMnB4LzEuMTUgdWktbW9ub3NwYWNlLCBTRk1vbm8tUmVndWxhciwgTWVubG8sIENvbnNvbGFzLCBtb25vc3BhY2U7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1tZXRyaWMgc3BhbjpsYXN0LWNoaWxkLFxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LWxpbmUsXG4gICAgLmNvZGV4cHAtZ2l0LW1vcmUsXG4gICAgLmNvZGV4cHAtZ2l0LXdhcm5pbmcge1xuICAgICAgY29sb3I6IHZhcigtLXRleHQtdGVydGlhcnksIGN1cnJlbnRDb2xvcik7XG4gICAgICBmb250OiA1MDAgMTBweC8xLjI1IHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmO1xuICAgICAgb3BhY2l0eTogMC43NDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LWNoYW5nZWQtZmlsZXMsXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlcyB7XG4gICAgICBkaXNwbGF5OiBmbGV4O1xuICAgICAgZmxleC1kaXJlY3Rpb246IGNvbHVtbjtcbiAgICAgIGdhcDogM3B4O1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtZmlsZS1yb3csXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvdyB7XG4gICAgICBjb2xvcjogdmFyKC0tdGV4dC1zZWNvbmRhcnksIGN1cnJlbnRDb2xvcik7XG4gICAgICBmb250OiA1MDAgMTFweC8xLjI1IHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtZmlsZS1yb3cgc3BhbjpmaXJzdC1jaGlsZCB7XG4gICAgICBjb2xvcjogdmFyKC0tY29kZXhwcC1wcm9qZWN0LXRleHQtY29sb3IsIGN1cnJlbnRDb2xvcik7XG4gICAgICBmbGV4OiAwIDAgMjRweDtcbiAgICAgIGZvbnQ6IDYwMCAxMHB4LzEuMiB1aS1tb25vc3BhY2UsIFNGTW9uby1SZWd1bGFyLCBNZW5sbywgQ29uc29sYXMsIG1vbm9zcGFjZTtcbiAgICAgIG9wYWNpdHk6IDAuODg7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1maWxlLXJvdyBzcGFuOmxhc3QtY2hpbGQsXG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvdyBzcGFuOmxhc3QtY2hpbGQge1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgICAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgICAgIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvdyB7XG4gICAgICBqdXN0aWZ5LWNvbnRlbnQ6IHNwYWNlLWJldHdlZW47XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC13b3JrdHJlZS1yb3cgc3BhbjpmaXJzdC1jaGlsZCB7XG4gICAgICBmb250OiA1MDAgMTBweC8xLjI1IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlO1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgICAgb3ZlcmZsb3c6IGhpZGRlbjtcbiAgICAgIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICAgICAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbiAgICB9XG4gIGA7XG4gIGRvY3VtZW50LmhlYWQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBV0EsSUFBQUEsbUJBQTRCOzs7QUM2QnJCLFNBQVMsbUJBQXlCO0FBQ3ZDLE1BQUksT0FBTywrQkFBZ0M7QUFDM0MsUUFBTSxZQUFZLG9CQUFJLElBQStCO0FBQ3JELE1BQUksU0FBUztBQUNiLFFBQU0sWUFBWSxvQkFBSSxJQUE0QztBQUVsRSxRQUFNLE9BQTBCO0FBQUEsSUFDOUIsZUFBZTtBQUFBLElBQ2Y7QUFBQSxJQUNBLE9BQU8sVUFBVTtBQUNmLFlBQU0sS0FBSztBQUNYLGdCQUFVLElBQUksSUFBSSxRQUFRO0FBRTFCLGNBQVE7QUFBQSxRQUNOO0FBQUEsUUFDQSxTQUFTO0FBQUEsUUFDVCxTQUFTO0FBQUEsTUFDWDtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxHQUFHLE9BQU8sSUFBSTtBQUNaLFVBQUksSUFBSSxVQUFVLElBQUksS0FBSztBQUMzQixVQUFJLENBQUMsRUFBRyxXQUFVLElBQUksT0FBUSxJQUFJLG9CQUFJLElBQUksQ0FBRTtBQUM1QyxRQUFFLElBQUksRUFBRTtBQUFBLElBQ1Y7QUFBQSxJQUNBLElBQUksT0FBTyxJQUFJO0FBQ2IsZ0JBQVUsSUFBSSxLQUFLLEdBQUcsT0FBTyxFQUFFO0FBQUEsSUFDakM7QUFBQSxJQUNBLEtBQUssVUFBVSxNQUFNO0FBQ25CLGdCQUFVLElBQUksS0FBSyxHQUFHLFFBQVEsQ0FBQyxPQUFPLEdBQUcsR0FBRyxJQUFJLENBQUM7QUFBQSxJQUNuRDtBQUFBLElBQ0Esb0JBQW9CO0FBQUEsSUFBQztBQUFBLElBQ3JCLHVCQUF1QjtBQUFBLElBQUM7QUFBQSxJQUN4QixzQkFBc0I7QUFBQSxJQUFDO0FBQUEsSUFDdkIsV0FBVztBQUFBLElBQUM7QUFBQSxFQUNkO0FBRUEsU0FBTyxlQUFlLFFBQVEsa0NBQWtDO0FBQUEsSUFDOUQsY0FBYztBQUFBLElBQ2QsWUFBWTtBQUFBLElBQ1os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QU0sS0FBSyxDQUFDO0FBQ25GO0FBQUEsRUFDRjtBQUVBLFFBQU0sUUFBUSxTQUFTLGNBQWMsT0FBTztBQUM1QyxRQUFNLEtBQUs7QUFDWCxRQUFNLGNBQWM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFpSnBCLFNBQU8sWUFBWSxLQUFLO0FBQzFCO0FBRUEsU0FBUyxtQkFBbUIsT0FBcUM7QUFDL0QsUUFBTSxPQUFPLE9BQU8sTUFBTSxpQkFBaUIsYUFBYSxNQUFNLGFBQWEsSUFBSSxDQUFDO0FBQ2hGLGFBQVcsUUFBUSxNQUFNO0FBQ3ZCLFFBQUksRUFBRSxnQkFBZ0IsYUFBYztBQUNwQyxVQUFNLFdBQVcsbUJBQW1CLElBQUk7QUFDeEMsUUFBSSxTQUFVLFFBQU87QUFBQSxFQUN2QjtBQUNBLFNBQU8sTUFBTSxrQkFBa0IsY0FBYyxtQkFBbUIsTUFBTSxNQUFNLElBQUk7QUFDbEY7QUFFQSxTQUFTLG1CQUFtQixTQUE2QztBQUN2RSxNQUFJLG1CQUFtQix1QkFBdUIsbUJBQW1CLGtCQUFrQjtBQUNqRixVQUFNLE9BQU8sbUJBQW1CLG1CQUFtQixRQUFRLE9BQU87QUFDbEUsUUFBSSxDQUFDLENBQUMsUUFBUSxVQUFVLFVBQVUsRUFBRSxTQUFTLElBQUksRUFBRyxRQUFPO0FBQzNELFdBQU87QUFBQSxNQUNMO0FBQUEsTUFDQSxTQUFTLE1BQU0sUUFBUTtBQUFBLE1BQ3ZCLFNBQVMsQ0FBQyxVQUFVO0FBQ2xCLGdCQUFRLFFBQVE7QUFDaEIsZ0JBQVEsTUFBTTtBQUNkLFlBQUk7QUFDRixrQkFBUSxrQkFBa0IsTUFBTSxRQUFRLE1BQU0sTUFBTTtBQUFBLFFBQ3RELFFBQVE7QUFBQSxRQUFDO0FBQ1QsZ0JBQVEsY0FBYyxJQUFJLFdBQVcsU0FBUyxFQUFFLFNBQVMsTUFBTSxXQUFXLGNBQWMsTUFBTSxNQUFNLENBQUMsQ0FBQztBQUFBLE1BQ3hHO0FBQUEsTUFDQSxPQUFPLE1BQU07QUFDWCxnQkFBUSxRQUFRO0FBQ2hCLGdCQUFRLGNBQWMsSUFBSSxXQUFXLFNBQVMsRUFBRSxTQUFTLE1BQU0sV0FBVyx3QkFBd0IsQ0FBQyxDQUFDO0FBQUEsTUFDdEc7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFFBQU0sV0FBVyxRQUFRLG9CQUNyQixVQUNBLFFBQVEsUUFBcUIsNENBQTRDO0FBQzdFLE1BQUksQ0FBQyxTQUFVLFFBQU87QUFDdEIsU0FBTztBQUFBLElBQ0wsU0FBUztBQUFBLElBQ1QsU0FBUyxNQUFNLFNBQVMsYUFBYSxTQUFTLGVBQWU7QUFBQSxJQUM3RCxTQUFTLENBQUMsVUFBVTtBQUNsQixlQUFTLGNBQWM7QUFDdkIsZUFBUyxNQUFNO0FBQ2Ysc0JBQWdCLFFBQVE7QUFDeEIsZUFBUyxjQUFjLElBQUksV0FBVyxTQUFTLEVBQUUsU0FBUyxNQUFNLFdBQVcsY0FBYyxNQUFNLE1BQU0sQ0FBQyxDQUFDO0FBQUEsSUFDekc7QUFBQSxJQUNBLE9BQU8sTUFBTTtBQUNYLGVBQVMsY0FBYztBQUN2QixlQUFTLGNBQWMsSUFBSSxXQUFXLFNBQVMsRUFBRSxTQUFTLE1BQU0sV0FBVyx3QkFBd0IsQ0FBQyxDQUFDO0FBQUEsSUFDdkc7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxTQUFTLGdCQUFnQixTQUE0QjtBQUNuRCxRQUFNLFlBQVksT0FBTyxhQUFhO0FBQ3RDLE1BQUksQ0FBQyxVQUFXO0FBQ2hCLFFBQU0sUUFBUSxTQUFTLFlBQVk7QUFDbkMsUUFBTSxtQkFBbUIsT0FBTztBQUNoQyxRQUFNLFNBQVMsS0FBSztBQUNwQixZQUFVLGdCQUFnQjtBQUMxQixZQUFVLFNBQVMsS0FBSztBQUMxQjtBQUVBLFNBQVMsZUFBOEI7QUFDckMsUUFBTSxhQUF1QixDQUFDLFNBQVMsVUFBVSxTQUFTLE1BQU0sU0FBUyxJQUFJO0FBQzdFLE1BQUk7QUFDRixVQUFNLE1BQU0sSUFBSSxJQUFJLFNBQVMsSUFBSTtBQUNqQyxVQUFNLGVBQWUsSUFBSSxhQUFhLElBQUksY0FBYztBQUN4RCxRQUFJLGFBQWMsWUFBVyxLQUFLLFlBQVk7QUFBQSxFQUNoRCxRQUFRO0FBQUEsRUFBQztBQUNULGFBQVcsS0FBSyxHQUFHLDZCQUE2QixRQUFRLEtBQUssQ0FBQztBQUM5RCxhQUFXLEtBQUssR0FBRywyQkFBMkIsQ0FBQztBQUUvQyxhQUFXLGFBQWEsWUFBWTtBQUNsQyxVQUFNLFdBQVcsa0JBQWtCLFNBQVM7QUFDNUMsUUFBSSxTQUFVLFFBQU87QUFBQSxFQUN2QjtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsa0JBQWtCLE9BQThCO0FBQ3ZELFFBQU0sVUFBVSxXQUFXLEtBQUssRUFBRSxLQUFLO0FBQ3ZDLFFBQU0sYUFBYSxRQUFRLE1BQU0sc0JBQXNCO0FBQ3ZELE1BQUksYUFBYSxDQUFDLEdBQUc7QUFDbkIsVUFBTSxZQUFZLHVCQUF1QixXQUFXLENBQUMsQ0FBQztBQUN0RCxRQUFJLFVBQVcsUUFBTztBQUFBLEVBQ3hCO0FBRUEsUUFBTSxhQUFhLFFBQVEsTUFBTSx1RkFBdUY7QUFDeEgsTUFBSSxhQUFhLENBQUMsRUFBRyxRQUFPLFdBQVcsQ0FBQztBQUV4QyxTQUFPO0FBQ1Q7QUFFQSxTQUFTLHVCQUF1QixPQUE4QjtBQUM1RCxRQUFNLFVBQVUsV0FBVyxLQUFLLEVBQUUsS0FBSztBQUN2QyxRQUFNLFFBQVEsUUFBUSxNQUFNLHlFQUF5RTtBQUNyRyxTQUFPLFFBQVEsQ0FBQyxLQUFLO0FBQ3ZCO0FBRUEsU0FBUyw2QkFBdUM7QUFDOUMsUUFBTSxZQUFZO0FBQUEsSUFDaEI7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0EsUUFBTSxhQUF1QixDQUFDO0FBQzlCLGFBQVcsWUFBWSxXQUFXO0FBQ2hDLGVBQVcsV0FBVyxNQUFNLEtBQUssU0FBUyxpQkFBOEIsUUFBUSxDQUFDLEdBQUc7QUFDbEYsWUFBTSxRQUFRLFFBQVEsYUFBYSxtQ0FBbUM7QUFDdEUsVUFBSSxNQUFPLFlBQVcsS0FBSyxLQUFLO0FBQUEsSUFDbEM7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxXQUFXLE9BQXVCO0FBQ3pDLE1BQUk7QUFDRixXQUFPLG1CQUFtQixLQUFLO0FBQUEsRUFDakMsUUFBUTtBQUNOLFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFFQSxTQUFTLDZCQUE2QixPQUFnQixRQUFRLEdBQUcsT0FBTyxvQkFBSSxJQUFhLEdBQWE7QUFDcEcsTUFBSSxRQUFRLEtBQUssVUFBVSxRQUFRLFVBQVUsVUFBYSxLQUFLLElBQUksS0FBSyxFQUFHLFFBQU8sQ0FBQztBQUNuRixNQUFJLE9BQU8sVUFBVSxTQUFVLFFBQU8sa0JBQWtCLEtBQUssSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDO0FBQzVFLE1BQUksT0FBTyxVQUFVLFNBQVUsUUFBTyxDQUFDO0FBQ3ZDLE9BQUssSUFBSSxLQUFLO0FBRWQsUUFBTSxhQUF1QixDQUFDO0FBQzlCLGFBQVcsU0FBUyxPQUFPLE9BQU8sS0FBZ0MsR0FBRztBQUNuRSxlQUFXLEtBQUssR0FBRyw2QkFBNkIsT0FBTyxRQUFRLEdBQUcsSUFBSSxDQUFDO0FBQUEsRUFDekU7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGdCQUFnQixRQUE0QjtBQUNuRCxVQUFRLFFBQVE7QUFBQSxJQUNkLEtBQUs7QUFDSCxhQUFPO0FBQUEsSUFDVCxLQUFLO0FBQ0gsYUFBTztBQUFBLElBQ1QsS0FBSztBQUNILGFBQU87QUFBQSxJQUNULEtBQUs7QUFDSCxhQUFPO0FBQUEsRUFDWDtBQUNGO0FBRUEsU0FBUyxrQkFBa0IsT0FBd0I7QUFDakQsUUFBTSxVQUFVLGVBQWUsS0FBSztBQUNwQyxNQUFJLDZCQUE2QixLQUFLLE9BQU8sR0FBRztBQUM5QyxXQUFPO0FBQUEsRUFDVDtBQUNBLE1BQUksNEJBQTRCLEtBQUssT0FBTyxHQUFHO0FBQzdDLFdBQU87QUFBQSxFQUNUO0FBQ0EsTUFBSSxxRkFBcUYsS0FBSyxPQUFPLEdBQUc7QUFDdEcsV0FBTztBQUFBLEVBQ1Q7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGVBQWUsU0FBeUI7QUFDL0MsTUFBSSxDQUFDLE9BQU8sU0FBUyxPQUFPLEtBQUssV0FBVyxFQUFHLFFBQU87QUFDdEQsUUFBTSxVQUFVLEtBQUssTUFBTSxVQUFVLEVBQUU7QUFDdkMsUUFBTSxtQkFBbUIsS0FBSyxNQUFNLFVBQVUsRUFBRTtBQUNoRCxNQUFJLFdBQVcsRUFBRyxRQUFPLEdBQUcsZ0JBQWdCO0FBQzVDLFFBQU0sUUFBUSxLQUFLLE1BQU0sVUFBVSxFQUFFO0FBQ3JDLFFBQU0sbUJBQW1CLFVBQVU7QUFDbkMsTUFBSSxTQUFTLEVBQUcsUUFBTyxHQUFHLE9BQU8sS0FBSyxnQkFBZ0I7QUFDdEQsU0FBTyxHQUFHLEtBQUssS0FBSyxnQkFBZ0I7QUFDdEM7QUFFQSxTQUFTLGFBQWEsT0FBdUI7QUFDM0MsU0FBTyxPQUFPLFNBQVMsS0FBSyxJQUFJLEtBQUssTUFBTSxLQUFLLEVBQUUsZUFBZSxJQUFJO0FBQ3ZFO0FBRUEsU0FBUyxTQUFTLE9BQWUsV0FBMkI7QUFDMUQsU0FBTyxNQUFNLFVBQVUsWUFBWSxRQUFRLEdBQUcsTUFBTSxNQUFNLEdBQUcsWUFBWSxDQUFDLENBQUM7QUFDN0U7QUFFQSxTQUFTLGVBQWUsT0FBd0I7QUFDOUMsU0FBTyxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxLQUFLO0FBQzlEO0FBRUEsU0FBUyxhQUFhLE9BQXFDO0FBQ3pELFNBQU9GLFVBQVMsS0FBSyxLQUNuQixPQUFPLE1BQU0sYUFBYSxZQUMxQixPQUFPLE1BQU0sY0FBYyxZQUMzQixPQUFPLE1BQU0sV0FBVztBQUM1QjtBQUVBLFNBQVNBLFVBQVMsT0FBa0Q7QUFDbEUsU0FBTyxVQUFVLFFBQVEsT0FBTyxVQUFVLFlBQVksQ0FBQyxNQUFNLFFBQVEsS0FBSztBQUM1RTs7O0FDcDhCQSxJQUFBSSxtQkFBNEI7QUFRNUIsSUFBTSx1QkFDSjtBQUNGLElBQU0seUJBQ0o7QUFDRixJQUFNLHdCQUF3QjtBQUM5QixJQUFNLGVBQWU7QUFDckIsSUFBTSxhQUFhO0FBQ25CLElBQU0sV0FBVztBQUNqQixJQUFNLHNCQUFzQjtBQUM1QixJQUFNLGdCQUFnQjtBQUN0QixJQUFNLGlCQUFpQjtBQUN2QixJQUFNLDZCQUE2QjtBQUNuQyxJQUFNLG9CQUFvQjtBQUMxQixJQUFNLG9CQUFvQjtBQXFDMUIsSUFBTUMsU0FBeUI7QUFBQSxFQUM3QixVQUFVO0FBQUEsRUFDVixjQUFjO0FBQUEsRUFDZCxVQUFVO0FBQUEsRUFDVixPQUFPO0FBQUEsRUFDUCxhQUFhLG9CQUFJLElBQUk7QUFBQSxFQUNyQixjQUFjLG9CQUFJLElBQUk7QUFDeEI7QUFFTyxTQUFTLGtCQUF3QjtBQUN0QyxNQUFJQSxPQUFNLFNBQVU7QUFFcEIsRUFBQUMsZUFBYztBQUVkLFFBQU0sV0FBVyxJQUFJLGlCQUFpQixDQUFDLGNBQWM7QUFDbkQsUUFBSSxVQUFVLEtBQUsscUJBQXFCLEdBQUc7QUFDekMsc0JBQWdCLFVBQVU7QUFBQSxJQUM1QjtBQUFBLEVBQ0YsQ0FBQztBQUNELFdBQVMsUUFBUSxTQUFTLGlCQUFpQjtBQUFBLElBQ3pDLFdBQVc7QUFBQSxJQUNYLFNBQVM7QUFBQSxJQUNULFlBQVk7QUFBQSxJQUNaLGlCQUFpQjtBQUFBLE1BQ2Y7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsRUFDRixDQUFDO0FBQ0QsRUFBQUQsT0FBTSxXQUFXO0FBQ2pCLEVBQUFBLE9BQU0sV0FBVyxZQUFZLE1BQU0sZ0JBQWdCLFVBQVUsR0FBRyxJQUFNO0FBQ3RFLFNBQU8saUJBQWlCLFNBQVMsYUFBYTtBQUM5QyxrQkFBZ0IsTUFBTTtBQUN4QjtBQUVBLFNBQVMsZ0JBQXNCO0FBQzdCLGtCQUFnQixPQUFPO0FBQ3pCO0FBRUEsU0FBUyxzQkFBc0IsVUFBbUM7QUFDaEUsTUFBSSxTQUFTLFNBQVMsY0FBYztBQUNsQyxVQUFNLFNBQVMsU0FBUztBQUN4QixXQUFPLGtCQUFrQixZQUN2QixPQUFPLFFBQVEsb0JBQW9CLEtBQ25DLE9BQU8sUUFBUSxzQkFBc0IsS0FDckMsT0FBTyxhQUFhLHlDQUF5QztBQUFBLEVBRWpFO0FBQ0EsYUFBVyxRQUFRLE1BQU0sS0FBSyxTQUFTLFVBQVUsR0FBRztBQUNsRCxRQUFJLDJCQUEyQixJQUFJLEVBQUcsUUFBTztBQUFBLEVBQy9DO0FBQ0EsYUFBVyxRQUFRLE1BQU0sS0FBSyxTQUFTLFlBQVksR0FBRztBQUNwRCxRQUFJLDJCQUEyQixJQUFJLEVBQUcsUUFBTztBQUFBLEVBQy9DO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUywyQkFBMkIsTUFBcUI7QUFDdkQsTUFBSSxFQUFFLGdCQUFnQixTQUFVLFFBQU87QUFDdkMsU0FBTyxLQUFLLFFBQVEsb0JBQW9CLEtBQUssUUFBUSxLQUFLLGNBQWMsb0JBQW9CLENBQUM7QUFDL0Y7QUFFQSxTQUFTLGdCQUFnQixTQUF1QjtBQUM5QyxNQUFJQSxPQUFNLGFBQWMsY0FBYUEsT0FBTSxZQUFZO0FBQ3ZELEVBQUFBLE9BQU0sZUFBZSxXQUFXLE1BQU07QUFDcEMsSUFBQUEsT0FBTSxlQUFlO0FBQ3JCLFNBQUssUUFBUTtBQUFBLEVBQ2YsR0FBRyxtQkFBbUI7QUFDeEI7QUFFQSxlQUFlLFVBQXlCO0FBQ3RDLFFBQU0sUUFBUSxFQUFFQSxPQUFNO0FBQ3RCLFFBQU0sV0FBVyxtQkFBbUI7QUFDcEMsTUFBSSxTQUFTLFdBQVcsR0FBRztBQUN6Qix1QkFBbUI7QUFDbkI7QUFBQSxFQUNGO0FBRUEsUUFBTSxhQUFhLHFCQUFxQixRQUFRO0FBQ2hELFFBQU0saUJBQ0gsYUFBYSxTQUFTLEtBQUssQ0FBQyxZQUFZLFFBQVEsU0FBUyxVQUFVLElBQUksU0FDeEUsU0FBUyxLQUFLLENBQUMsWUFBWSxRQUFRLElBQUksYUFBYSwyQ0FBMkMsTUFBTSxPQUFPLEtBQzVHLFNBQVMsQ0FBQztBQUVaLFFBQU0sZ0JBQWdCLHdCQUF3QixVQUFVLGFBQWE7QUFDckUsUUFBTSxnQkFBZ0IsTUFBTSxRQUFRO0FBQUEsSUFDbEMsY0FBYyxJQUFJLE9BQU8sWUFBWTtBQUNuQyxZQUFNRSxVQUFTLE1BQU0sVUFBVSxRQUFRLElBQUk7QUFDM0MsYUFBTyxFQUFFLFNBQVMsUUFBQUEsUUFBTztBQUFBLElBQzNCLENBQUM7QUFBQSxFQUNIO0FBQ0EsTUFBSSxVQUFVRixPQUFNLE1BQU87QUFDM0IsYUFBVyxFQUFFLFNBQVMsUUFBQUUsUUFBTyxLQUFLLGVBQWU7QUFDL0MsdUJBQW1CLFNBQVNBLE9BQU07QUFBQSxFQUNwQztBQUVBLFFBQU0saUJBQ0osY0FBYyxLQUFLLENBQUMsRUFBRSxTQUFTLFFBQUFBLFFBQU8sTUFBTSxRQUFRLFNBQVMsZUFBZSxRQUFRLGFBQWFBLE9BQU0sQ0FBQyxHQUNwRyxXQUNKLGNBQWMsS0FBSyxDQUFDLEVBQUUsUUFBQUEsUUFBTyxNQUFNLGFBQWFBLE9BQU0sQ0FBQyxHQUFHLFdBQzFEO0FBRUYsTUFBSSxDQUFDLGdCQUFnQjtBQUNuQix1QkFBbUI7QUFDbkI7QUFBQSxFQUNGO0FBRUEsUUFBTSxDQUFDLFFBQVEsT0FBTyxJQUFJLE1BQU0sUUFBUSxJQUFJO0FBQUEsSUFDMUMsVUFBVSxlQUFlLElBQUk7QUFBQSxJQUM3QixXQUFXLGVBQWUsSUFBSTtBQUFBLEVBQ2hDLENBQUM7QUFDRCxNQUFJLFVBQVVGLE9BQU0sTUFBTztBQUMzQixxQkFBbUIsZ0JBQWdCLFFBQVEsT0FBTztBQUNwRDtBQUVBLFNBQVMscUJBQW1DO0FBQzFDLFFBQU0sT0FBTyxvQkFBSSxJQUFZO0FBQzdCLFFBQU0sT0FBcUIsQ0FBQztBQUM1QixhQUFXLE9BQU8sTUFBTSxLQUFLLFNBQVMsaUJBQThCLG9CQUFvQixDQUFDLEdBQUc7QUFDMUYsVUFBTSxPQUFPLElBQUksYUFBYSxvQ0FBb0MsR0FBRyxLQUFLO0FBQzFFLFFBQUksQ0FBQyxRQUFRLEtBQUssSUFBSSxJQUFJLEVBQUc7QUFDN0IsU0FBSyxJQUFJLElBQUk7QUFDYixTQUFLLEtBQUs7QUFBQSxNQUNSO0FBQUEsTUFDQTtBQUFBLE1BQ0EsT0FBTyxJQUFJLGFBQWEsdUNBQXVDLEdBQUcsS0FBSyxLQUFLLFNBQVMsSUFBSTtBQUFBLE1BQ3pGLE9BQU8saUJBQWlCLEdBQUc7QUFBQSxJQUM3QixDQUFDO0FBQUEsRUFDSDtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsaUJBQWlCLEtBQXNDO0FBQzlELE1BQUksVUFBOEIsSUFBSTtBQUN0QyxTQUFPLFdBQVcsWUFBWSxTQUFTLE1BQU07QUFDM0MsUUFBSSxRQUFRLGFBQWEsTUFBTSxNQUFNLGNBQWMsUUFBUSxhQUFhLFNBQVMsSUFBSSxlQUFlLEVBQUUsR0FBRztBQUN2RyxhQUFPO0FBQUEsSUFDVDtBQUNBLFFBQUksUUFBUSxjQUFjLG9CQUFvQixNQUFNLE9BQU8sUUFBUSxjQUFjLHFCQUFxQixHQUFHO0FBQ3ZHLGFBQU87QUFBQSxJQUNUO0FBQ0EsY0FBVSxRQUFRO0FBQUEsRUFDcEI7QUFDQSxTQUFPLElBQUk7QUFDYjtBQUVBLFNBQVMscUJBQXFCLFVBQXVDO0FBQ25FLFFBQU0sZUFBZSxTQUFTLGNBQTJCLHNCQUFzQjtBQUMvRSxRQUFNLGNBQWMsY0FBYyxRQUFxQixxQkFBcUI7QUFDNUUsUUFBTSxXQUFXLGFBQWEsYUFBYSx5Q0FBeUMsR0FBRyxLQUFLO0FBQzVGLE1BQUksU0FBVSxRQUFPO0FBRXJCLFFBQU0sV0FBVyxTQUFTO0FBQUEsSUFDeEIsQ0FBQyxZQUFZLFFBQVEsSUFBSSxhQUFhLDJDQUEyQyxNQUFNO0FBQUEsRUFDekY7QUFDQSxTQUFPLFVBQVUsUUFBUTtBQUMzQjtBQUVBLFNBQVMsd0JBQXdCLFVBQXdCLGVBQXFEO0FBQzVHLFFBQU0sVUFBVSxTQUFTLE9BQU8sQ0FBQyxZQUFZO0FBQzNDLFVBQU0sT0FBTyxRQUFRLElBQUksc0JBQXNCO0FBQy9DLFdBQU8sS0FBSyxRQUFRLEtBQUssS0FBSyxTQUFTLEtBQUssS0FBSyxVQUFVLEtBQUssS0FBSyxPQUFPLE9BQU87QUFBQSxFQUNyRixDQUFDO0FBQ0QsUUFBTSxVQUFVLGdCQUNaLENBQUMsZUFBZSxHQUFHLFFBQVEsT0FBTyxDQUFDLFlBQVksUUFBUSxTQUFTLGNBQWMsSUFBSSxDQUFDLElBQ25GO0FBQ0osU0FBTyxRQUFRLE1BQU0sR0FBRywwQkFBMEI7QUFDcEQ7QUFFQSxlQUFlLFVBQVUsTUFBeUM7QUFDaEUsUUFBTSxNQUFNLEtBQUssSUFBSTtBQUNyQixRQUFNLFNBQVNBLE9BQU0sWUFBWSxJQUFJLElBQUk7QUFDekMsTUFBSSxRQUFRLFNBQVMsTUFBTSxPQUFPLFdBQVcsY0FBZSxRQUFPLE9BQU87QUFDMUUsTUFBSSxRQUFRLFFBQVMsUUFBTyxPQUFPO0FBRW5DLFFBQU0sUUFBMEIsVUFBVTtBQUFBLElBQ3hDLE9BQU87QUFBQSxJQUNQLE9BQU87QUFBQSxJQUNQLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxFQUNYO0FBQ0EsUUFBTSxVQUFVLDZCQUNiLE9BQU8sc0JBQXNCLElBQUksRUFDakMsS0FBSyxDQUFDLFdBQVc7QUFDaEIsVUFBTSxRQUFRO0FBQ2QsVUFBTSxRQUFRO0FBQ2QsVUFBTSxXQUFXLEtBQUssSUFBSTtBQUMxQixXQUFPLE1BQU07QUFBQSxFQUNmLENBQUMsRUFDQSxNQUFNLENBQUMsVUFBbUI7QUFDekIsVUFBTSxRQUFRLGlCQUFpQixRQUFRLE1BQU0sVUFBVSxPQUFPLEtBQUs7QUFDbkUsVUFBTSxXQUFXLEtBQUssSUFBSTtBQUMxQixXQUFPO0FBQUEsRUFDVCxDQUFDLEVBQ0EsUUFBUSxNQUFNO0FBQ2IsVUFBTSxVQUFVO0FBQUEsRUFDbEIsQ0FBQztBQUNILEVBQUFBLE9BQU0sWUFBWSxJQUFJLE1BQU0sS0FBSztBQUNqQyxTQUFPLE1BQU07QUFDZjtBQUVBLGVBQWUsV0FBVyxNQUEwQztBQUNsRSxRQUFNLE1BQU0sS0FBSyxJQUFJO0FBQ3JCLFFBQU0sU0FBU0EsT0FBTSxhQUFhLElBQUksSUFBSTtBQUMxQyxNQUFJLFFBQVEsU0FBUyxNQUFNLE9BQU8sV0FBVyxlQUFnQixRQUFPLE9BQU87QUFDM0UsTUFBSSxRQUFRLFFBQVMsUUFBTyxPQUFPO0FBRW5DLFFBQU0sUUFBMkIsVUFBVTtBQUFBLElBQ3pDLE9BQU87QUFBQSxJQUNQLE9BQU87QUFBQSxJQUNQLFVBQVU7QUFBQSxJQUNWLFNBQVM7QUFBQSxFQUNYO0FBQ0EsUUFBTSxVQUFVLFFBQVEsSUFBSTtBQUFBLElBQzFCLDZCQUFZLE9BQU8sNEJBQTRCLElBQUk7QUFBQSxJQUNuRCw2QkFBWSxPQUFPLHlCQUF5QixJQUFJO0FBQUEsRUFDbEQsQ0FBQyxFQUNFLEtBQUssQ0FBQyxDQUFDLE1BQU0sU0FBUyxNQUFNO0FBQzNCLFVBQU0sUUFBUSxFQUFFLE1BQU0sVUFBVTtBQUNoQyxVQUFNLFFBQVE7QUFDZCxVQUFNLFdBQVcsS0FBSyxJQUFJO0FBQzFCLFdBQU8sTUFBTTtBQUFBLEVBQ2YsQ0FBQyxFQUNBLE1BQU0sQ0FBQyxVQUFtQjtBQUN6QixVQUFNLFFBQVEsaUJBQWlCLFFBQVEsTUFBTSxVQUFVLE9BQU8sS0FBSztBQUNuRSxVQUFNLFdBQVcsS0FBSyxJQUFJO0FBQzFCLFdBQU87QUFBQSxFQUNULENBQUMsRUFDQSxRQUFRLE1BQU07QUFDYixVQUFNLFVBQVU7QUFBQSxFQUNsQixDQUFDO0FBQ0gsRUFBQUEsT0FBTSxhQUFhLElBQUksTUFBTSxLQUFLO0FBQ2xDLFNBQU8sTUFBTTtBQUNmO0FBRUEsU0FBUyxtQkFBbUIsU0FBcUIsUUFBZ0M7QUFDL0UsTUFBSSxDQUFDLGFBQWEsTUFBTSxHQUFHO0FBQ3pCLFlBQVEsSUFBSSxjQUFjLElBQUksVUFBVSxHQUFHLEdBQUcsT0FBTztBQUNyRDtBQUFBLEVBQ0Y7QUFFQSxRQUFNLFFBQVEsWUFBWSxRQUFRLEdBQUc7QUFDckMsUUFBTSxRQUFRLFdBQVcsT0FBTyxPQUFPO0FBQ3ZDLFFBQU0sWUFBWSxlQUFlLE9BQU8sT0FBTztBQUMvQyxRQUFNLFNBQVMsWUFBWSxNQUFNO0FBQ2pDLFFBQU0sT0FBTyxVQUFVLE1BQU07QUFDN0IsUUFBTSxVQUFVLE9BQU8sMkJBQTJCLFFBQVEsQ0FBQztBQUMzRCxRQUFNLFVBQVUsT0FBTyw4QkFBOEIsWUFBWSxDQUFDO0FBQ2xFLFFBQU0sUUFBUTtBQUFBLElBQ1osR0FBRyxRQUFRLEtBQUssS0FBSyxNQUFNO0FBQUEsSUFDM0IsVUFBVSxJQUFJLFVBQVUsR0FBRyxLQUFLO0FBQUEsSUFDaEMsWUFBWSxJQUFJLEdBQUcsU0FBUyxZQUFZLE9BQU8sU0FBUyxDQUFDLEtBQUs7QUFBQSxJQUM5RCxLQUFLO0FBQUEsRUFDUCxFQUFFLE9BQU8sT0FBTyxFQUFFLEtBQUssSUFBSTtBQUMzQixRQUFNLGNBQWMsQ0FBQyxRQUFRLFFBQVEsSUFBSSxPQUFPLEtBQUssSUFBSSxJQUFJLEtBQUssS0FBSyxFQUFFLE9BQU8sT0FBTyxFQUFFLEtBQUssR0FBRztBQUNuRztBQUVBLFNBQVMsWUFBWSxLQUErQjtBQUNsRCxRQUFNLFdBQVcsSUFBSSxjQUEyQixJQUFJLFVBQVUsR0FBRztBQUNqRSxNQUFJLFNBQVUsUUFBTztBQUVyQixRQUFNLFFBQVEsU0FBUyxjQUFjLE1BQU07QUFDM0MsUUFBTSxhQUFhLFlBQVksRUFBRTtBQUNqQyxRQUFNLFlBQVk7QUFDbEIsTUFBSSxZQUFZLEtBQUs7QUFDckIsU0FBTztBQUNUO0FBRUEsU0FBUyxtQkFBbUIsU0FBcUIsUUFBMEIsU0FBa0M7QUFDM0csTUFBSSxDQUFDLGFBQWEsTUFBTSxHQUFHO0FBQ3pCLHVCQUFtQjtBQUNuQjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLE9BQU8sUUFBUSxTQUFTLFFBQVEsSUFBSTtBQUMxQyxNQUFJLENBQUMsS0FBTTtBQUVYLFFBQU0sUUFBUSxtQkFBbUIsTUFBTSxRQUFRLEdBQUc7QUFDbEQsUUFBTSxLQUFLO0FBRVgsUUFBTSxRQUFRLFdBQVcsT0FBTyxPQUFPO0FBQ3ZDLFFBQU0sU0FBUyxZQUFZLE9BQU8sT0FBTztBQUN6QyxRQUFNLFNBQVMsWUFBWSxNQUFNO0FBQ2pDLFFBQU0sT0FBTyxVQUFVLE1BQU07QUFDN0IsUUFBTSxPQUFPLFNBQVMsUUFBUTtBQUM5QixRQUFNLFlBQVksU0FBUyxhQUFhLENBQUM7QUFFekMsUUFBTSxTQUFTLEdBQUcsT0FBTyw0QkFBNEI7QUFDckQsUUFBTSxRQUFRLEdBQUcsT0FBTywyQkFBMkI7QUFDbkQsUUFBTSxPQUFPLE9BQU8sUUFBUSxLQUFLLENBQUM7QUFDbEMsUUFBTSxPQUFPLE9BQU8sVUFBVSxNQUFNLENBQUM7QUFDckMsTUFBSSxLQUFLLE1BQU8sT0FBTSxPQUFPLE9BQU8sUUFBUSxLQUFLLEtBQUssQ0FBQztBQUN2RCxRQUFNLFlBQVksT0FBTyxRQUFRLFVBQVUsSUFBSSxVQUFVLEdBQUcsS0FBSyxVQUFVO0FBQzNFLFlBQVUsWUFBWSw2QkFBNkIsVUFBVSxJQUFJLGFBQWEsVUFBVTtBQUN4RixTQUFPLE9BQU8sT0FBTyxTQUFTO0FBQzlCLFFBQU0sT0FBTyxNQUFNO0FBRW5CLFFBQU0sVUFBVSxHQUFHLE9BQU8sNkJBQTZCO0FBQ3ZELFVBQVE7QUFBQSxJQUNOLE9BQU8sVUFBVSxPQUFPLE1BQU07QUFBQSxJQUM5QixPQUFPLFlBQVksT0FBTyxRQUFRO0FBQUEsSUFDbEMsT0FBTyxhQUFhLE9BQU8sU0FBUztBQUFBLElBQ3BDLE9BQU8sYUFBYSxPQUFPLFNBQVM7QUFBQSxFQUN0QztBQUNBLFFBQU0sT0FBTyxPQUFPO0FBRXBCLE1BQUksTUFBTTtBQUNSLFVBQU0sV0FBVyxHQUFHLE9BQU8sMEJBQTBCO0FBQ3JELGFBQVM7QUFBQSxNQUNQLE9BQU8sUUFBUSxHQUFHLEtBQUssU0FBUyxRQUFRLE9BQU8sS0FBSyxTQUFTLENBQUMsRUFBRTtBQUFBLE1BQ2hFLE9BQU8sUUFBUSxJQUFJLEtBQUssVUFBVSxFQUFFO0FBQUEsTUFDcEMsT0FBTyxRQUFRLElBQUksS0FBSyxTQUFTLEVBQUU7QUFBQSxNQUNuQyxHQUFJLEtBQUssWUFBWSxDQUFDLE9BQU8sUUFBUSxXQUFXLENBQUMsSUFBSSxDQUFDO0FBQUEsSUFDeEQ7QUFDQSxVQUFNLE9BQU8sUUFBUTtBQUFBLEVBQ3ZCO0FBRUEsUUFBTSxVQUFVLE9BQU8sUUFBUSxPQUFPLENBQUMsVUFBVSxNQUFNLFNBQVMsU0FBUyxFQUFFLE1BQU0sR0FBRyxpQkFBaUI7QUFDckcsTUFBSSxRQUFRLFNBQVMsR0FBRztBQUN0QixVQUFNLE9BQU8sR0FBRyxPQUFPLDJCQUEyQjtBQUNsRCxlQUFXLFNBQVMsU0FBUztBQUMzQixZQUFNLE1BQU0sR0FBRyxPQUFPLHNCQUFzQjtBQUM1QyxVQUFJLE9BQU8sT0FBTyxRQUFRLFdBQVcsS0FBSyxDQUFDLEdBQUcsT0FBTyxRQUFRLFVBQVUsS0FBSyxDQUFDLENBQUM7QUFDOUUsV0FBSyxPQUFPLEdBQUc7QUFBQSxJQUNqQjtBQUNBLFFBQUksT0FBTyxRQUFRLFNBQVMsUUFBUSxRQUFRO0FBQzFDLFlBQU0sT0FBTyxPQUFPLE9BQU8sSUFBSSxPQUFPLFFBQVEsU0FBUyxRQUFRLE1BQU0sT0FBTztBQUM1RSxXQUFLLFlBQVk7QUFDakIsV0FBSyxPQUFPLElBQUk7QUFBQSxJQUNsQjtBQUNBLFVBQU0sT0FBTyxJQUFJO0FBQUEsRUFDbkI7QUFFQSxNQUFJLFVBQVUsU0FBUyxHQUFHO0FBQ3hCLFVBQU0sZUFBZSxHQUFHLE9BQU8sdUJBQXVCO0FBQ3RELFVBQU0sUUFBUSxPQUFPLE9BQU8sR0FBRyxVQUFVLE1BQU0sWUFBWTtBQUMzRCxVQUFNLFlBQVk7QUFDbEIsaUJBQWEsT0FBTyxLQUFLO0FBQ3pCLGVBQVcsWUFBWSxVQUFVLE1BQU0sR0FBRyxpQkFBaUIsR0FBRztBQUM1RCxZQUFNLE1BQU0sR0FBRyxPQUFPLDBCQUEwQjtBQUNoRCxVQUFJO0FBQUEsUUFDRixPQUFPLFFBQVEsU0FBUyxVQUFVLFNBQVMsU0FBUyxJQUFJLEtBQUssVUFBVTtBQUFBLFFBQ3ZFLE9BQU8sUUFBUSxTQUFTLFNBQVMsSUFBSSxDQUFDO0FBQUEsTUFDeEM7QUFDQSxtQkFBYSxPQUFPLEdBQUc7QUFBQSxJQUN6QjtBQUNBLFVBQU0sT0FBTyxZQUFZO0FBQUEsRUFDM0I7QUFFQSxRQUFNLFFBQVEsT0FBTyxXQUFXLE9BQU8sV0FBV0EsT0FBTSxZQUFZLElBQUksUUFBUSxJQUFJLEdBQUcsU0FBU0EsT0FBTSxhQUFhLElBQUksUUFBUSxJQUFJLEdBQUc7QUFDdEksTUFBSSxPQUFPO0FBQ1QsVUFBTSxVQUFVLE9BQU8sT0FBTyxLQUFLO0FBQ25DLFlBQVEsWUFBWTtBQUNwQixVQUFNLE9BQU8sT0FBTztBQUFBLEVBQ3RCO0FBQ0Y7QUFFQSxTQUFTLGFBQWEsUUFBK0M7QUFDbkUsU0FBTyxRQUFRLFFBQVEsV0FBVyxTQUFTLE9BQU8sV0FBVyxnQkFBZ0I7QUFDL0U7QUFFQSxTQUFTLG1CQUFtQixNQUFtQixLQUErQjtBQUM1RSxNQUFJLFFBQVEsU0FBUyxjQUEyQixJQUFJLFlBQVksR0FBRztBQUNuRSxNQUFJLENBQUMsT0FBTztBQUNWLFlBQVEsU0FBUyxjQUFjLFNBQVM7QUFDeEMsVUFBTSxhQUFhLGNBQWMsRUFBRTtBQUNuQyxVQUFNLFlBQVk7QUFBQSxFQUNwQjtBQUVBLE1BQUksTUFBTSxrQkFBa0IsTUFBTTtBQUNoQyxVQUFNLE9BQU87QUFDYixTQUFLLGFBQWEsT0FBTyxJQUFJLGtCQUFrQjtBQUFBLEVBQ2pELFdBQVcsTUFBTSwyQkFBMkIsS0FBSztBQUMvQyxTQUFLLGFBQWEsT0FBTyxJQUFJLGtCQUFrQjtBQUFBLEVBQ2pEO0FBRUEsU0FBTztBQUNUO0FBRUEsU0FBUyxxQkFBMkI7QUFDbEMsV0FBUyxjQUFjLElBQUksWUFBWSxHQUFHLEdBQUcsT0FBTztBQUN0RDtBQUVBLFNBQVMsWUFBWSxTQUtuQjtBQUNBLE1BQUksU0FBUztBQUNiLE1BQUksV0FBVztBQUNmLE1BQUksWUFBWTtBQUNoQixNQUFJLFlBQVk7QUFDaEIsYUFBVyxTQUFTLFNBQVM7QUFDM0IsWUFBUSxNQUFNLE1BQU07QUFBQSxNQUNsQixLQUFLO0FBQUEsTUFDTCxLQUFLO0FBQ0gsWUFBSSxNQUFNLFVBQVUsSUFBSztBQUN6QixZQUFJLE1BQU0sYUFBYSxJQUFLO0FBQzVCO0FBQUEsTUFDRixLQUFLO0FBQ0g7QUFDQTtBQUFBLE1BQ0YsS0FBSztBQUNIO0FBQ0E7QUFBQSxNQUNGLEtBQUs7QUFDSDtBQUFBLElBQ0o7QUFBQSxFQUNGO0FBQ0EsU0FBTyxFQUFFLFFBQVEsVUFBVSxXQUFXLFVBQVU7QUFDbEQ7QUFFQSxTQUFTLFdBQVcsU0FBbUM7QUFDckQsU0FBTyxRQUFRLE9BQU8sQ0FBQyxVQUFVLE1BQU0sU0FBUyxTQUFTLEVBQUU7QUFDN0Q7QUFFQSxTQUFTLGVBQWUsU0FBbUM7QUFDekQsU0FBTyxRQUFRLE9BQU8sQ0FBQyxVQUFVLE1BQU0sU0FBUyxVQUFVLEVBQUU7QUFDOUQ7QUFFQSxTQUFTLFlBQVksUUFBMkI7QUFDOUMsU0FDRSxPQUFPLE9BQU8sUUFDZCxPQUFPLFdBQVcsY0FDbEIsU0FBUyxPQUFPLE9BQU8sR0FBRyxLQUMxQixTQUFTLE9BQU8sV0FBVyxPQUFPLEtBQ2xDO0FBRUo7QUFFQSxTQUFTLFVBQVUsUUFBcUQ7QUFDdEUsUUFBTSxRQUFRLE9BQU8sT0FBTyxTQUFTO0FBQ3JDLFFBQU0sU0FBUyxPQUFPLE9BQU8sVUFBVTtBQUN2QyxRQUFNLFFBQVEsQ0FBQyxRQUFRLElBQUksSUFBSSxLQUFLLEtBQUssSUFBSSxTQUFTLElBQUksSUFBSSxNQUFNLEtBQUssRUFBRSxFQUN4RSxPQUFPLE9BQU8sRUFDZCxLQUFLLEdBQUc7QUFDWCxRQUFNLFFBQVE7QUFBQSxJQUNaLFFBQVEsSUFBSSxHQUFHLEtBQUssV0FBVztBQUFBLElBQy9CLFNBQVMsSUFBSSxHQUFHLE1BQU0sWUFBWTtBQUFBLElBQ2xDLE9BQU8sT0FBTyxXQUFXLFlBQVksT0FBTyxPQUFPLFFBQVEsS0FBSztBQUFBLEVBQ2xFLEVBQUUsT0FBTyxPQUFPLEVBQUUsS0FBSyxJQUFJO0FBQzNCLFNBQU8sRUFBRSxPQUFPLE1BQU07QUFDeEI7QUFFQSxTQUFTLFdBQVcsT0FBK0I7QUFDakQsVUFBUSxNQUFNLE1BQU07QUFBQSxJQUNsQixLQUFLO0FBQ0gsYUFBTyxHQUFHLE1BQU0sS0FBSyxHQUFHLE1BQU0sUUFBUSxHQUFHLFdBQVcsS0FBSyxFQUFFO0FBQUEsSUFDN0QsS0FBSztBQUNILGFBQU87QUFBQSxJQUNULEtBQUs7QUFDSCxhQUFPO0FBQUEsSUFDVCxLQUFLO0FBQ0gsYUFBTztBQUFBLElBQ1QsS0FBSztBQUNILGFBQU87QUFBQSxFQUNYO0FBQ0Y7QUFFQSxTQUFTLFVBQVUsT0FBK0I7QUFDaEQsTUFBSSxNQUFNLFNBQVMsU0FBVSxRQUFPLEdBQUcsTUFBTSxZQUFZLE9BQU8sTUFBTSxJQUFJO0FBQzFFLFNBQU8sTUFBTTtBQUNmO0FBRUEsU0FBUyxPQUFPLE9BQWUsT0FBNEI7QUFDekQsUUFBTSxPQUFPLEdBQUcsT0FBTyxvQkFBb0I7QUFDM0MsT0FBSyxPQUFPLE9BQU8sUUFBUSxPQUFPLEtBQUssQ0FBQyxHQUFHLE9BQU8sUUFBUSxLQUFLLENBQUM7QUFDaEUsU0FBTztBQUNUO0FBRUEsU0FBUyxTQUFTLEtBQStDO0FBQy9ELFNBQU8sTUFBTSxJQUFJLE1BQU0sR0FBRyxDQUFDLElBQUk7QUFDakM7QUFFQSxTQUFTLFNBQVMsTUFBc0I7QUFDdEMsUUFBTSxVQUFVLEtBQUssUUFBUSxRQUFRLEVBQUU7QUFDdkMsUUFBTSxNQUFNLFFBQVEsWUFBWSxHQUFHO0FBQ25DLFNBQU8sT0FBTyxJQUFJLFFBQVEsTUFBTSxNQUFNLENBQUMsSUFBSTtBQUM3QztBQUVBLFNBQVMsT0FBTyxPQUF1QjtBQUNyQyxTQUFPLFVBQVUsSUFBSSxLQUFLO0FBQzVCO0FBRUEsU0FBUyxNQUFNLE1BQXlCO0FBQ3RDLFNBQU8sS0FBSyxXQUFZLE1BQUssV0FBVyxPQUFPO0FBQ2pEO0FBRUEsU0FBUyxHQUFHLEtBQXdCLFdBQWdDO0FBQ2xFLFFBQU0sT0FBTyxTQUFTLGNBQWMsR0FBRztBQUN2QyxPQUFLLFlBQVk7QUFDakIsU0FBTztBQUNUO0FBRUEsU0FBUyxPQUFPLEtBQWdDLE1BQTJCO0FBQ3pFLFFBQU0sT0FBTyxTQUFTLGNBQWMsR0FBRztBQUN2QyxPQUFLLGNBQWM7QUFDbkIsU0FBTztBQUNUO0FBRUEsU0FBU0MsaUJBQXNCO0FBQzdCLE1BQUksU0FBUyxlQUFlLFFBQVEsRUFBRztBQUN2QyxRQUFNLFFBQVEsU0FBUyxjQUFjLE9BQU87QUFDNUMsUUFBTSxLQUFLO0FBQ1gsUUFBTSxjQUFjO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUErSXBCLFdBQVMsS0FBSyxZQUFZLEtBQUs7QUFDakM7OztBUDVxQkEsU0FBUyxRQUFRLE9BQWUsT0FBdUI7QUFDckQsUUFBTSxNQUFNLDRCQUE0QixLQUFLLEdBQzNDLFVBQVUsU0FBWSxLQUFLLE1BQU1FLGVBQWMsS0FBSyxDQUN0RDtBQUNBLE1BQUk7QUFDRixZQUFRLE1BQU0sR0FBRztBQUFBLEVBQ25CLFFBQVE7QUFBQSxFQUFDO0FBQ1QsTUFBSTtBQUNGLGlDQUFZLEtBQUssdUJBQXVCLFFBQVEsR0FBRztBQUFBLEVBQ3JELFFBQVE7QUFBQSxFQUFDO0FBQ1g7QUFDQSxTQUFTQSxlQUFjLEdBQW9CO0FBQ3pDLE1BQUk7QUFDRixXQUFPLE9BQU8sTUFBTSxXQUFXLElBQUksS0FBSyxVQUFVLENBQUM7QUFBQSxFQUNyRCxRQUFRO0FBQ04sV0FBTyxPQUFPLENBQUM7QUFBQSxFQUNqQjtBQUNGO0FBRUEsUUFBUSxpQkFBaUIsRUFBRSxLQUFLLFNBQVMsS0FBSyxDQUFDO0FBRy9DLElBQUk7QUFDRixtQkFBaUI7QUFDakIsVUFBUSxzQkFBc0I7QUFDaEMsU0FBUyxHQUFHO0FBQ1YsVUFBUSxxQkFBcUIsT0FBTyxDQUFDLENBQUM7QUFDeEM7QUFFQSxJQUFJO0FBQ0YsbUJBQWlCLE9BQU87QUFDMUIsU0FBUyxHQUFHO0FBQ1YsVUFBUSx1QkFBdUIsT0FBTyxDQUFDLENBQUM7QUFDMUM7QUFFQSxlQUFlLE1BQU07QUFDbkIsTUFBSSxTQUFTLGVBQWUsV0FBVztBQUNyQyxhQUFTLGlCQUFpQixvQkFBb0IsTUFBTSxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDcEUsT0FBTztBQUNMLFNBQUs7QUFBQSxFQUNQO0FBQ0YsQ0FBQztBQUVELGVBQWUsT0FBTztBQUNwQixVQUFRLGNBQWMsRUFBRSxZQUFZLFNBQVMsV0FBVyxDQUFDO0FBQ3pELE1BQUk7QUFDRiwwQkFBc0I7QUFDdEIsWUFBUSwyQkFBMkI7QUFDbkMsb0JBQWdCO0FBQ2hCLFlBQVEscUJBQXFCO0FBQzdCLFVBQU0sZUFBZTtBQUNyQixZQUFRLG9CQUFvQjtBQUM1QixVQUFNLGFBQWE7QUFDbkIsWUFBUSxpQkFBaUI7QUFDekIsb0JBQWdCO0FBQ2hCLFlBQVEsZUFBZTtBQUFBLEVBQ3pCLFNBQVMsR0FBRztBQUNWLFlBQVEsZUFBZSxPQUFRLEdBQWEsU0FBUyxDQUFDLENBQUM7QUFDdkQsWUFBUSxNQUFNLHlDQUF5QyxDQUFDO0FBQUEsRUFDMUQ7QUFDRjtBQUlBLElBQUksWUFBa0M7QUFDdEMsU0FBUyxrQkFBd0I7QUFDL0IsK0JBQVksR0FBRywwQkFBMEIsTUFBTTtBQUM3QyxRQUFJLFVBQVc7QUFDZixpQkFBYSxZQUFZO0FBQ3ZCLFVBQUk7QUFDRixnQkFBUSxLQUFLLHVDQUF1QztBQUNwRCwwQkFBa0I7QUFDbEIsY0FBTSxlQUFlO0FBQ3JCLGNBQU0sYUFBYTtBQUFBLE1BQ3JCLFNBQVMsR0FBRztBQUNWLGdCQUFRLE1BQU0sdUNBQXVDLENBQUM7QUFBQSxNQUN4RCxVQUFFO0FBQ0Esb0JBQVk7QUFBQSxNQUNkO0FBQUEsSUFDRixHQUFHO0FBQUEsRUFDTCxDQUFDO0FBQ0g7IiwKICAibmFtZXMiOiBbImltcG9ydF9lbGVjdHJvbiIsICJyb290IiwgImNhcmQiLCAiZWwiLCAiaW1wb3J0X2VsZWN0cm9uIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImVsIiwgImltcG9ydF9lbGVjdHJvbiIsICJyb290IiwgImltcG9ydF9lbGVjdHJvbiIsICJpc1JlY29yZCIsICJyZXNwb25zZSIsICJlbCIsICJidXR0b24iLCAiaW1wb3J0X2VsZWN0cm9uIiwgInN0YXRlIiwgImluc3RhbGxTdHlsZXMiLCAic3RhdHVzIiwgInNhZmVTdHJpbmdpZnkiXQp9Cg==
