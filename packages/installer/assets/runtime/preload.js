"use strict";

// src/preload/index.ts
var import_electron5 = require("electron");

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
  for (const el of Array.from(all)) {
    const t = (el.textContent ?? "").trim();
    if (t.length > 30) continue;
    if (KNOWN.some((k) => t === k)) matches.push(el);
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
function describe(el) {
  return {
    tag: el.tagName,
    cls: el.className.slice(0, 120),
    id: el.id || void 0,
    children: el.children.length,
    rect: (() => {
      const r = el.getBoundingClientRect();
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
          const el = document.querySelector(sel);
          if (el) {
            obs.disconnect();
            resolve(el);
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
    fs: rendererFs(id, paths)
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
  const el = ensureRoot();
  if (hideTimer) clearTimeout(hideTimer);
  el.innerHTML = "";
  el.className = `codexpp-goal-panel${options.error ? " is-error" : ""}${panelState.collapsed ? " is-collapsed" : ""}`;
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
      hideTimer = setTimeout(() => hidePanel(), 8e3);
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
    el.appendChild(actions);
  }
  el.style.display = "block";
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

// src/preload/index.ts
function fileLog(stage, extra) {
  const msg = `[codex-plusplus preload] ${stage}${extra === void 0 ? "" : " " + safeStringify2(extra)}`;
  try {
    console.error(msg);
  } catch {
  }
  try {
    import_electron5.ipcRenderer.send("codexpp:preload-log", "info", msg);
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
  import_electron5.ipcRenderer.on("codexpp:tweaks-changed", () => {
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL21hbmFnZXIudHMiLCAiLi4vc3JjL3ByZWxvYWQvYXBwLXNlcnZlci1icmlkZ2UudHMiLCAiLi4vc3JjL3ByZWxvYWQvZ29hbC1mZWF0dXJlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlbmRlcmVyIHByZWxvYWQgZW50cnkuIFJ1bnMgaW4gYW4gaXNvbGF0ZWQgd29ybGQgYmVmb3JlIENvZGV4J3MgcGFnZSBKUy5cbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAgIDEuIEluc3RhbGwgYSBSZWFjdCBEZXZUb29scy1zaGFwZWQgZ2xvYmFsIGhvb2sgdG8gY2FwdHVyZSB0aGUgcmVuZGVyZXJcbiAqICAgICAgcmVmZXJlbmNlIHdoZW4gUmVhY3QgbW91bnRzLiBXZSB1c2UgdGhpcyBmb3IgZmliZXIgd2Fsa2luZy5cbiAqICAgMi4gQWZ0ZXIgRE9NQ29udGVudExvYWRlZCwga2ljayBvZmYgc2V0dGluZ3MtaW5qZWN0aW9uIGxvZ2ljLlxuICogICAzLiBEaXNjb3ZlciByZW5kZXJlci1zY29wZWQgdHdlYWtzICh2aWEgSVBDIHRvIG1haW4pIGFuZCBzdGFydCB0aGVtLlxuICogICA0LiBMaXN0ZW4gZm9yIGBjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkYCBmcm9tIG1haW4gKGZpbGVzeXN0ZW0gd2F0Y2hlcikgYW5kXG4gKiAgICAgIGhvdC1yZWxvYWQgdHdlYWtzIHdpdGhvdXQgZHJvcHBpbmcgdGhlIHBhZ2UuXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IGluc3RhbGxSZWFjdEhvb2sgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgeyBzdGFydFNldHRpbmdzSW5qZWN0b3IgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgc3RhcnRUd2Vha0hvc3QsIHRlYXJkb3duVHdlYWtIb3N0IH0gZnJvbSBcIi4vdHdlYWstaG9zdFwiO1xuaW1wb3J0IHsgbW91bnRNYW5hZ2VyIH0gZnJvbSBcIi4vbWFuYWdlclwiO1xuaW1wb3J0IHsgc3RhcnRHb2FsRmVhdHVyZSB9IGZyb20gXCIuL2dvYWwtZmVhdHVyZVwiO1xuXG4vLyBGaWxlLWxvZyBwcmVsb2FkIHByb2dyZXNzIHNvIHdlIGNhbiBkaWFnbm9zZSB3aXRob3V0IERldlRvb2xzLiBCZXN0LWVmZm9ydDpcbi8vIGZhaWx1cmVzIGhlcmUgbXVzdCBuZXZlciB0aHJvdyBiZWNhdXNlIHdlJ2QgdGFrZSB0aGUgcGFnZSBkb3duIHdpdGggdXMuXG4vL1xuLy8gQ29kZXgncyByZW5kZXJlciBpcyBzYW5kYm94ZWQgKHNhbmRib3g6IHRydWUpLCBzbyBgcmVxdWlyZShcIm5vZGU6ZnNcIilgIGlzXG4vLyB1bmF2YWlsYWJsZS4gV2UgZm9yd2FyZCBsb2cgbGluZXMgdG8gbWFpbiB2aWEgSVBDOyBtYWluIHdyaXRlcyB0aGUgZmlsZS5cbmZ1bmN0aW9uIGZpbGVMb2coc3RhZ2U6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKTogdm9pZCB7XG4gIGNvbnN0IG1zZyA9IGBbY29kZXgtcGx1c3BsdXMgcHJlbG9hZF0gJHtzdGFnZX0ke1xuICAgIGV4dHJhID09PSB1bmRlZmluZWQgPyBcIlwiIDogXCIgXCIgKyBzYWZlU3RyaW5naWZ5KGV4dHJhKVxuICB9YDtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLCBcImluZm9cIiwgbXNnKTtcbiAgfSBjYXRjaCB7fVxufVxuZnVuY3Rpb24gc2FmZVN0cmluZ2lmeSh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyB2IDogSlNPTi5zdHJpbmdpZnkodik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBTdHJpbmcodik7XG4gIH1cbn1cblxuZmlsZUxvZyhcInByZWxvYWQgZW50cnlcIiwgeyB1cmw6IGxvY2F0aW9uLmhyZWYgfSk7XG5cbi8vIFJlYWN0IGhvb2sgbXVzdCBiZSBpbnN0YWxsZWQgKmJlZm9yZSogQ29kZXgncyBidW5kbGUgcnVucy5cbnRyeSB7XG4gIGluc3RhbGxSZWFjdEhvb2soKTtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgaW5zdGFsbGVkXCIpO1xufSBjYXRjaCAoZSkge1xuICBmaWxlTG9nKFwicmVhY3QgaG9vayBGQUlMRURcIiwgU3RyaW5nKGUpKTtcbn1cblxudHJ5IHtcbiAgc3RhcnRHb2FsRmVhdHVyZShmaWxlTG9nKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcImdvYWwgZmVhdHVyZSBGQUlMRURcIiwgU3RyaW5nKGUpKTtcbn1cblxucXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICBpZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gXCJsb2FkaW5nXCIpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBib290LCB7IG9uY2U6IHRydWUgfSk7XG4gIH0gZWxzZSB7XG4gICAgYm9vdCgpO1xuICB9XG59KTtcblxuYXN5bmMgZnVuY3Rpb24gYm9vdCgpIHtcbiAgZmlsZUxvZyhcImJvb3Qgc3RhcnRcIiwgeyByZWFkeVN0YXRlOiBkb2N1bWVudC5yZWFkeVN0YXRlIH0pO1xuICB0cnkge1xuICAgIHN0YXJ0U2V0dGluZ3NJbmplY3RvcigpO1xuICAgIGZpbGVMb2coXCJzZXR0aW5ncyBpbmplY3RvciBzdGFydGVkXCIpO1xuICAgIGF3YWl0IHN0YXJ0VHdlYWtIb3N0KCk7XG4gICAgZmlsZUxvZyhcInR3ZWFrIGhvc3Qgc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBtb3VudE1hbmFnZXIoKTtcbiAgICBmaWxlTG9nKFwibWFuYWdlciBtb3VudGVkXCIpO1xuICAgIHN1YnNjcmliZVJlbG9hZCgpO1xuICAgIGZpbGVMb2coXCJib290IGNvbXBsZXRlXCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZmlsZUxvZyhcImJvb3QgRkFJTEVEXCIsIFN0cmluZygoZSBhcyBFcnJvcik/LnN0YWNrID8/IGUpKTtcbiAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSBwcmVsb2FkIGJvb3QgZmFpbGVkOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBIb3QgcmVsb2FkOiBnYXRlZCBiZWhpbmQgYSBzbWFsbCBpbi1mbGlnaHQgbG9jayBzbyBhIGZsdXJyeSBvZiBmcyBldmVudHNcbi8vIGRvZXNuJ3QgcmVlbnRyYW50bHkgdGVhciBkb3duIHRoZSBob3N0IG1pZC1sb2FkLlxubGV0IHJlbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuZnVuY3Rpb24gc3Vic2NyaWJlUmVsb2FkKCk6IHZvaWQge1xuICBpcGNSZW5kZXJlci5vbihcImNvZGV4cHA6dHdlYWtzLWNoYW5nZWRcIiwgKCkgPT4ge1xuICAgIGlmIChyZWxvYWRpbmcpIHJldHVybjtcbiAgICByZWxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5pbmZvKFwiW2NvZGV4LXBsdXNwbHVzXSBob3QtcmVsb2FkaW5nIHR3ZWFrc1wiKTtcbiAgICAgICAgdGVhcmRvd25Ud2Vha0hvc3QoKTtcbiAgICAgICAgYXdhaXQgc3RhcnRUd2Vha0hvc3QoKTtcbiAgICAgICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbY29kZXgtcGx1c3BsdXNdIGhvdCByZWxvYWQgZmFpbGVkOlwiLCBlKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHJlbG9hZGluZyA9IG51bGw7XG4gICAgICB9XG4gICAgfSkoKTtcbiAgfSk7XG59XG4iLCAiLyoqXG4gKiBJbnN0YWxsIGEgbWluaW1hbCBfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18uIFJlYWN0IGNhbGxzXG4gKiBgaG9vay5pbmplY3QocmVuZGVyZXJJbnRlcm5hbHMpYCBkdXJpbmcgYGNyZWF0ZVJvb3RgL2BoeWRyYXRlUm9vdGAuIFRoZVxuICogXCJpbnRlcm5hbHNcIiBvYmplY3QgZXhwb3NlcyBmaW5kRmliZXJCeUhvc3RJbnN0YW5jZSwgd2hpY2ggbGV0cyB1cyB0dXJuIGFcbiAqIERPTSBub2RlIGludG8gYSBSZWFjdCBmaWJlciBcdTIwMTQgbmVjZXNzYXJ5IGZvciBvdXIgU2V0dGluZ3MgaW5qZWN0b3IuXG4gKlxuICogV2UgZG9uJ3Qgd2FudCB0byBicmVhayByZWFsIFJlYWN0IERldlRvb2xzIGlmIHRoZSB1c2VyIG9wZW5zIGl0OyB3ZSBpbnN0YWxsXG4gKiBvbmx5IGlmIG5vIGhvb2sgZXhpc3RzIHlldCwgYW5kIHdlIGZvcndhcmQgY2FsbHMgdG8gYSBkb3duc3RyZWFtIGhvb2sgaWZcbiAqIG9uZSBpcyBsYXRlciBhc3NpZ25lZC5cbiAqL1xuZGVjbGFyZSBnbG9iYWwge1xuICBpbnRlcmZhY2UgV2luZG93IHtcbiAgICBfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18/OiBSZWFjdERldnRvb2xzSG9vaztcbiAgICBfX2NvZGV4cHBfXz86IHtcbiAgICAgIGhvb2s6IFJlYWN0RGV2dG9vbHNIb29rO1xuICAgICAgcmVuZGVyZXJzOiBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz47XG4gICAgfTtcbiAgfVxufVxuXG5pbnRlcmZhY2UgUmVuZGVyZXJJbnRlcm5hbHMge1xuICBmaW5kRmliZXJCeUhvc3RJbnN0YW5jZT86IChuOiBOb2RlKSA9PiB1bmtub3duO1xuICB2ZXJzaW9uPzogc3RyaW5nO1xuICBidW5kbGVUeXBlPzogbnVtYmVyO1xuICByZW5kZXJlclBhY2thZ2VOYW1lPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUmVhY3REZXZ0b29sc0hvb2sge1xuICBzdXBwb3J0c0ZpYmVyOiB0cnVlO1xuICByZW5kZXJlcnM6IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPjtcbiAgb24oZXZlbnQ6IHN0cmluZywgZm46ICguLi5hOiB1bmtub3duW10pID0+IHZvaWQpOiB2b2lkO1xuICBvZmYoZXZlbnQ6IHN0cmluZywgZm46ICguLi5hOiB1bmtub3duW10pID0+IHZvaWQpOiB2b2lkO1xuICBlbWl0KGV2ZW50OiBzdHJpbmcsIC4uLmE6IHVua25vd25bXSk6IHZvaWQ7XG4gIGluamVjdChyZW5kZXJlcjogUmVuZGVyZXJJbnRlcm5hbHMpOiBudW1iZXI7XG4gIG9uU2NoZWR1bGVGaWJlclJvb3Q/KCk6IHZvaWQ7XG4gIG9uQ29tbWl0RmliZXJSb290PygpOiB2b2lkO1xuICBvbkNvbW1pdEZpYmVyVW5tb3VudD8oKTogdm9pZDtcbiAgY2hlY2tEQ0U/KCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsUmVhY3RIb29rKCk6IHZvaWQge1xuICBpZiAod2luZG93Ll9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXykgcmV0dXJuO1xuICBjb25zdCByZW5kZXJlcnMgPSBuZXcgTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+KCk7XG4gIGxldCBuZXh0SWQgPSAxO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgTWFwPHN0cmluZywgU2V0PCguLi5hOiB1bmtub3duW10pID0+IHZvaWQ+PigpO1xuXG4gIGNvbnN0IGhvb2s6IFJlYWN0RGV2dG9vbHNIb29rID0ge1xuICAgIHN1cHBvcnRzRmliZXI6IHRydWUsXG4gICAgcmVuZGVyZXJzLFxuICAgIGluamVjdChyZW5kZXJlcikge1xuICAgICAgY29uc3QgaWQgPSBuZXh0SWQrKztcbiAgICAgIHJlbmRlcmVycy5zZXQoaWQsIHJlbmRlcmVyKTtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICBjb25zb2xlLmRlYnVnKFxuICAgICAgICBcIltjb2RleC1wbHVzcGx1c10gUmVhY3QgcmVuZGVyZXIgYXR0YWNoZWQ6XCIsXG4gICAgICAgIHJlbmRlcmVyLnJlbmRlcmVyUGFja2FnZU5hbWUsXG4gICAgICAgIHJlbmRlcmVyLnZlcnNpb24sXG4gICAgICApO1xuICAgICAgcmV0dXJuIGlkO1xuICAgIH0sXG4gICAgb24oZXZlbnQsIGZuKSB7XG4gICAgICBsZXQgcyA9IGxpc3RlbmVycy5nZXQoZXZlbnQpO1xuICAgICAgaWYgKCFzKSBsaXN0ZW5lcnMuc2V0KGV2ZW50LCAocyA9IG5ldyBTZXQoKSkpO1xuICAgICAgcy5hZGQoZm4pO1xuICAgIH0sXG4gICAgb2ZmKGV2ZW50LCBmbikge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmRlbGV0ZShmbik7XG4gICAgfSxcbiAgICBlbWl0KGV2ZW50LCAuLi5hcmdzKSB7XG4gICAgICBsaXN0ZW5lcnMuZ2V0KGV2ZW50KT8uZm9yRWFjaCgoZm4pID0+IGZuKC4uLmFyZ3MpKTtcbiAgICB9LFxuICAgIG9uQ29tbWl0RmliZXJSb290KCkge30sXG4gICAgb25Db21taXRGaWJlclVubW91bnQoKSB7fSxcbiAgICBvblNjaGVkdWxlRmliZXJSb290KCkge30sXG4gICAgY2hlY2tEQ0UoKSB7fSxcbiAgfTtcblxuICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCBcIl9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfX1wiLCB7XG4gICAgY29uZmlndXJhYmxlOiB0cnVlLFxuICAgIGVudW1lcmFibGU6IGZhbHNlLFxuICAgIHdyaXRhYmxlOiB0cnVlLCAvLyBhbGxvdyByZWFsIERldlRvb2xzIHRvIG92ZXJ3cml0ZSBpZiB1c2VyIGluc3RhbGxzIGl0XG4gICAgdmFsdWU6IGhvb2ssXG4gIH0pO1xuXG4gIHdpbmRvdy5fX2NvZGV4cHBfXyA9IHsgaG9vaywgcmVuZGVyZXJzIH07XG59XG5cbi8qKiBSZXNvbHZlIHRoZSBSZWFjdCBmaWJlciBmb3IgYSBET00gbm9kZSwgaWYgYW55IHJlbmRlcmVyIGhhcyBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gZmliZXJGb3JOb2RlKG5vZGU6IE5vZGUpOiB1bmtub3duIHwgbnVsbCB7XG4gIGNvbnN0IHJlbmRlcmVycyA9IHdpbmRvdy5fX2NvZGV4cHBfXz8ucmVuZGVyZXJzO1xuICBpZiAocmVuZGVyZXJzKSB7XG4gICAgZm9yIChjb25zdCByIG9mIHJlbmRlcmVycy52YWx1ZXMoKSkge1xuICAgICAgY29uc3QgZiA9IHIuZmluZEZpYmVyQnlIb3N0SW5zdGFuY2U/Lihub2RlKTtcbiAgICAgIGlmIChmKSByZXR1cm4gZjtcbiAgICB9XG4gIH1cbiAgLy8gRmFsbGJhY2s6IHJlYWQgdGhlIFJlYWN0IGludGVybmFsIHByb3BlcnR5IGRpcmVjdGx5IGZyb20gdGhlIERPTSBub2RlLlxuICAvLyBSZWFjdCBzdG9yZXMgZmliZXJzIGFzIGEgcHJvcGVydHkgd2hvc2Uga2V5IHN0YXJ0cyB3aXRoIFwiX19yZWFjdEZpYmVyXCIuXG4gIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhub2RlKSkge1xuICAgIGlmIChrLnN0YXJ0c1dpdGgoXCJfX3JlYWN0RmliZXJcIikpIHJldHVybiAobm9kZSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrXTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cbiIsICIvKipcbiAqIFNldHRpbmdzIGluamVjdG9yIGZvciBDb2RleCdzIFNldHRpbmdzIHBhZ2UuXG4gKlxuICogQ29kZXgncyBzZXR0aW5ncyBpcyBhIHJvdXRlZCBwYWdlIChVUkwgc3RheXMgYXQgYC9pbmRleC5odG1sP2hvc3RJZD1sb2NhbGApXG4gKiBOT1QgYSBtb2RhbCBkaWFsb2cuIFRoZSBzaWRlYmFyIGxpdmVzIGluc2lkZSBhIGA8ZGl2IGNsYXNzPVwiZmxleCBmbGV4LWNvbFxuICogZ2FwLTEgZ2FwLTBcIj5gIHdyYXBwZXIgdGhhdCBob2xkcyBvbmUgb3IgbW9yZSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC1weFwiPmAgZ3JvdXBzIG9mIGJ1dHRvbnMuIFRoZXJlIGFyZSBubyBzdGFibGUgYHJvbGVgIC8gYGFyaWEtbGFiZWxgIC9cbiAqIGBkYXRhLXRlc3RpZGAgaG9va3Mgb24gdGhlIHNoZWxsIHNvIHdlIGlkZW50aWZ5IHRoZSBzaWRlYmFyIGJ5IHRleHQtY29udGVudFxuICogbWF0Y2ggYWdhaW5zdCBrbm93biBpdGVtIGxhYmVscyAoR2VuZXJhbCwgQXBwZWFyYW5jZSwgQ29uZmlndXJhdGlvbiwgXHUyMDI2KS5cbiAqXG4gKiBMYXlvdXQgd2UgaW5qZWN0OlxuICpcbiAqICAgR0VORVJBTCAgICAgICAgICAgICAgICAgICAgICAgKHVwcGVyY2FzZSBncm91cCBsYWJlbClcbiAqICAgW0NvZGV4J3MgZXhpc3RpbmcgaXRlbXMgZ3JvdXBdXG4gKiAgIENPREVYKysgICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFx1MjREOCBDb25maWdcbiAqICAgXHUyNjMwIFR3ZWFrc1xuICpcbiAqIENsaWNraW5nIENvbmZpZyAvIFR3ZWFrcyBoaWRlcyBDb2RleCdzIGNvbnRlbnQgcGFuZWwgY2hpbGRyZW4gYW5kIHJlbmRlcnNcbiAqIG91ciBvd24gYG1haW4tc3VyZmFjZWAgcGFuZWwgaW4gdGhlaXIgcGxhY2UuIENsaWNraW5nIGFueSBvZiBDb2RleCdzXG4gKiBzaWRlYmFyIGl0ZW1zIHJlc3RvcmVzIHRoZSBvcmlnaW5hbCB2aWV3LlxuICovXG5cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgdHlwZSB7XG4gIFNldHRpbmdzU2VjdGlvbixcbiAgU2V0dGluZ3NQYWdlLFxuICBTZXR0aW5nc0hhbmRsZSxcbiAgVHdlYWtNYW5pZmVzdCxcbn0gZnJvbSBcIkBjb2RleC1wbHVzcGx1cy9zZGtcIjtcblxuLy8gTWlycm9ycyB0aGUgcnVudGltZSdzIG1haW4tc2lkZSBMaXN0ZWRUd2VhayBzaGFwZSAoa2VwdCBpbiBzeW5jIG1hbnVhbGx5KS5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHVwZGF0ZTogVHdlYWtVcGRhdGVDaGVjayB8IG51bGw7XG59XG5cbmludGVyZmFjZSBUd2Vha1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIHJlcG86IHN0cmluZztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQ29kZXhQbHVzUGx1c0NvbmZpZyB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgYXV0b1VwZGF0ZTogYm9vbGVhbjtcbiAgdXBkYXRlQ2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayB8IG51bGw7XG59XG5cbmludGVyZmFjZSBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZU5vdGVzOiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQ29kZXhDZHBTdGF0dXMge1xuICBlbmFibGVkOiBib29sZWFuO1xuICBhY3RpdmU6IGJvb2xlYW47XG4gIGNvbmZpZ3VyZWRQb3J0OiBudW1iZXI7XG4gIGFjdGl2ZVBvcnQ6IG51bWJlciB8IG51bGw7XG4gIHJlc3RhcnRSZXF1aXJlZDogYm9vbGVhbjtcbiAgc291cmNlOiBcImFyZ3ZcIiB8IFwiZW52XCIgfCBcImNvbmZpZ1wiIHwgXCJvZmZcIjtcbiAganNvbkxpc3RVcmw6IHN0cmluZyB8IG51bGw7XG4gIGpzb25WZXJzaW9uVXJsOiBzdHJpbmcgfCBudWxsO1xuICBsYXVuY2hDb21tYW5kOiBzdHJpbmc7XG4gIGFwcFJvb3Q6IHN0cmluZyB8IG51bGw7XG59XG5cbmludGVyZmFjZSBXYXRjaGVySGVhbHRoIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgd2F0Y2hlcjogc3RyaW5nO1xuICBjaGVja3M6IFdhdGNoZXJIZWFsdGhDaGVja1tdO1xufVxuXG5pbnRlcmZhY2UgV2F0Y2hlckhlYWx0aENoZWNrIHtcbiAgbmFtZTogc3RyaW5nO1xuICBzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiO1xuICBkZXRhaWw6IHN0cmluZztcbn1cblxuLyoqXG4gKiBBIHR3ZWFrLXJlZ2lzdGVyZWQgcGFnZS4gV2UgY2FycnkgdGhlIG93bmluZyB0d2VhaydzIG1hbmlmZXN0IHNvIHdlIGNhblxuICogcmVzb2x2ZSByZWxhdGl2ZSBpY29uVXJscyBhbmQgc2hvdyBhdXRob3JzaGlwIGluIHRoZSBwYWdlIGhlYWRlci5cbiAqL1xuaW50ZXJmYWNlIFJlZ2lzdGVyZWRQYWdlIHtcbiAgLyoqIEZ1bGx5LXF1YWxpZmllZCBpZDogYDx0d2Vha0lkPjo8cGFnZUlkPmAuICovXG4gIGlkOiBzdHJpbmc7XG4gIHR3ZWFrSWQ6IHN0cmluZztcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIHBhZ2U6IFNldHRpbmdzUGFnZTtcbiAgLyoqIFBlci1wYWdlIERPTSB0ZWFyZG93biByZXR1cm5lZCBieSBgcGFnZS5yZW5kZXJgLCBpZiBhbnkuICovXG4gIHRlYXJkb3duPzogKCgpID0+IHZvaWQpIHwgbnVsbDtcbiAgLyoqIFRoZSBpbmplY3RlZCBzaWRlYmFyIGJ1dHRvbiAoc28gd2UgY2FuIHVwZGF0ZSBpdHMgYWN0aXZlIHN0YXRlKS4gKi9cbiAgbmF2QnV0dG9uPzogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xufVxuXG4vKiogV2hhdCBwYWdlIGlzIGN1cnJlbnRseSBzZWxlY3RlZCBpbiBvdXIgaW5qZWN0ZWQgbmF2LiAqL1xudHlwZSBBY3RpdmVQYWdlID1cbiAgfCB7IGtpbmQ6IFwiY29uZmlnXCIgfVxuICB8IHsga2luZDogXCJ0d2Vha3NcIiB9XG4gIHwgeyBraW5kOiBcInJlZ2lzdGVyZWRcIjsgaWQ6IHN0cmluZyB9O1xuXG5pbnRlcmZhY2UgSW5qZWN0b3JTdGF0ZSB7XG4gIHNlY3Rpb25zOiBNYXA8c3RyaW5nLCBTZXR0aW5nc1NlY3Rpb24+O1xuICBwYWdlczogTWFwPHN0cmluZywgUmVnaXN0ZXJlZFBhZ2U+O1xuICBsaXN0ZWRUd2Vha3M6IExpc3RlZFR3ZWFrW107XG4gIC8qKiBPdXRlciB3cmFwcGVyIHRoYXQgaG9sZHMgQ29kZXgncyBpdGVtcyBncm91cCArIG91ciBpbmplY3RlZCBncm91cHMuICovXG4gIG91dGVyV3JhcHBlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiR2VuZXJhbFwiIGxhYmVsIGZvciBDb2RleCdzIG5hdGl2ZSBzZXR0aW5ncyBncm91cC4gKi9cbiAgbmF0aXZlTmF2SGVhZGVyOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIC8qKiBPdXIgXCJDb2RleCsrXCIgbmF2IGdyb3VwIChDb25maWcvVHdlYWtzKS4gKi9cbiAgbmF2R3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgbmF2QnV0dG9uczogeyBjb25maWc6IEhUTUxCdXR0b25FbGVtZW50OyB0d2Vha3M6IEhUTUxCdXR0b25FbGVtZW50IH0gfCBudWxsO1xuICAvKiogT3VyIFwiVHdlYWtzXCIgbmF2IGdyb3VwIChwZXItdHdlYWsgcGFnZXMpLiBDcmVhdGVkIGxhemlseS4gKi9cbiAgcGFnZXNHcm91cDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBwYWdlc0dyb3VwS2V5OiBzdHJpbmcgfCBudWxsO1xuICBwYW5lbEhvc3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgb2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCBudWxsO1xuICBmaW5nZXJwcmludDogc3RyaW5nIHwgbnVsbDtcbiAgc2lkZWJhckR1bXBlZDogYm9vbGVhbjtcbiAgYWN0aXZlUGFnZTogQWN0aXZlUGFnZSB8IG51bGw7XG4gIHNpZGViYXJSb290OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHNpZGViYXJSZXN0b3JlSGFuZGxlcjogKChlOiBFdmVudCkgPT4gdm9pZCkgfCBudWxsO1xuICBzZXR0aW5nc1N1cmZhY2VWaXNpYmxlOiBib29sZWFuO1xuICBzZXR0aW5nc1N1cmZhY2VIaWRlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbDtcbn1cblxuY29uc3Qgc3RhdGU6IEluamVjdG9yU3RhdGUgPSB7XG4gIHNlY3Rpb25zOiBuZXcgTWFwKCksXG4gIHBhZ2VzOiBuZXcgTWFwKCksXG4gIGxpc3RlZFR3ZWFrczogW10sXG4gIG91dGVyV3JhcHBlcjogbnVsbCxcbiAgbmF0aXZlTmF2SGVhZGVyOiBudWxsLFxuICBuYXZHcm91cDogbnVsbCxcbiAgbmF2QnV0dG9uczogbnVsbCxcbiAgcGFnZXNHcm91cDogbnVsbCxcbiAgcGFnZXNHcm91cEtleTogbnVsbCxcbiAgcGFuZWxIb3N0OiBudWxsLFxuICBvYnNlcnZlcjogbnVsbCxcbiAgZmluZ2VycHJpbnQ6IG51bGwsXG4gIHNpZGViYXJEdW1wZWQ6IGZhbHNlLFxuICBhY3RpdmVQYWdlOiBudWxsLFxuICBzaWRlYmFyUm9vdDogbnVsbCxcbiAgc2lkZWJhclJlc3RvcmVIYW5kbGVyOiBudWxsLFxuICBzZXR0aW5nc1N1cmZhY2VWaXNpYmxlOiBmYWxzZSxcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBudWxsLFxufTtcblxuZnVuY3Rpb24gcGxvZyhtc2c6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKTogdm9pZCB7XG4gIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgXCJjb2RleHBwOnByZWxvYWQtbG9nXCIsXG4gICAgXCJpbmZvXCIsXG4gICAgYFtzZXR0aW5ncy1pbmplY3Rvcl0gJHttc2d9JHtleHRyYSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IFwiIFwiICsgc2FmZVN0cmluZ2lmeShleHRyYSl9YCxcbiAgKTtcbn1cbmZ1bmN0aW9uIHNhZmVTdHJpbmdpZnkodjogdW5rbm93bik6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gU3RyaW5nKHYpO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBwdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRTZXR0aW5nc0luamVjdG9yKCk6IHZvaWQge1xuICBpZiAoc3RhdGUub2JzZXJ2ZXIpIHJldHVybjtcblxuICBjb25zdCBvYnMgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgdHJ5SW5qZWN0KCk7XG4gICAgbWF5YmVEdW1wRG9tKCk7XG4gIH0pO1xuICBvYnMub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICBzdGF0ZS5vYnNlcnZlciA9IG9icztcblxuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvcHN0YXRlXCIsIG9uTmF2KTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJoYXNoY2hhbmdlXCIsIG9uTmF2KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uRG9jdW1lbnRDbGljaywgdHJ1ZSk7XG4gIGZvciAoY29uc3QgbSBvZiBbXCJwdXNoU3RhdGVcIiwgXCJyZXBsYWNlU3RhdGVcIl0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBvcmlnID0gaGlzdG9yeVttXTtcbiAgICBoaXN0b3J5W21dID0gZnVuY3Rpb24gKHRoaXM6IEhpc3RvcnksIC4uLmFyZ3M6IFBhcmFtZXRlcnM8dHlwZW9mIG9yaWc+KSB7XG4gICAgICBjb25zdCByID0gb3JpZy5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudChgY29kZXhwcC0ke219YCkpO1xuICAgICAgcmV0dXJuIHI7XG4gICAgfSBhcyB0eXBlb2Ygb3JpZztcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihgY29kZXhwcC0ke219YCwgb25OYXYpO1xuICB9XG5cbiAgdHJ5SW5qZWN0KCk7XG4gIG1heWJlRHVtcERvbSgpO1xuICBsZXQgdGlja3MgPSAwO1xuICBjb25zdCBpbnRlcnZhbCA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICB0aWNrcysrO1xuICAgIHRyeUluamVjdCgpO1xuICAgIG1heWJlRHVtcERvbSgpO1xuICAgIGlmICh0aWNrcyA+IDYwKSBjbGVhckludGVydmFsKGludGVydmFsKTtcbiAgfSwgNTAwKTtcbn1cblxuZnVuY3Rpb24gb25OYXYoKTogdm9pZCB7XG4gIHN0YXRlLmZpbmdlcnByaW50ID0gbnVsbDtcbiAgdHJ5SW5qZWN0KCk7XG4gIG1heWJlRHVtcERvbSgpO1xufVxuXG5mdW5jdGlvbiBvbkRvY3VtZW50Q2xpY2soZTogTW91c2VFdmVudCk6IHZvaWQge1xuICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgPyBlLnRhcmdldCA6IG51bGw7XG4gIGNvbnN0IGNvbnRyb2wgPSB0YXJnZXQ/LmNsb3Nlc3QoXCJbcm9sZT0nbGluayddLGJ1dHRvbixhXCIpO1xuICBpZiAoIShjb250cm9sIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpKSByZXR1cm47XG4gIGlmIChjb21wYWN0U2V0dGluZ3NUZXh0KGNvbnRyb2wudGV4dENvbnRlbnQgfHwgXCJcIikgIT09IFwiQmFjayB0byBhcHBcIikgcmV0dXJuO1xuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKGZhbHNlLCBcImJhY2stdG8tYXBwXCIpO1xuICB9LCAwKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU2VjdGlvbihzZWN0aW9uOiBTZXR0aW5nc1NlY3Rpb24pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIHN0YXRlLnNlY3Rpb25zLnNldChzZWN0aW9uLmlkLCBzZWN0aW9uKTtcbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHJlcmVuZGVyKCk7XG4gIHJldHVybiB7XG4gICAgdW5yZWdpc3RlcjogKCkgPT4ge1xuICAgICAgc3RhdGUuc2VjdGlvbnMuZGVsZXRlKHNlY3Rpb24uaWQpO1xuICAgICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHJlcmVuZGVyKCk7XG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU2VjdGlvbnMoKTogdm9pZCB7XG4gIHN0YXRlLnNlY3Rpb25zLmNsZWFyKCk7XG4gIC8vIERyb3AgcmVnaXN0ZXJlZCBwYWdlcyB0b28gXHUyMDE0IHRoZXkncmUgb3duZWQgYnkgdHdlYWtzIHRoYXQganVzdCBnb3RcbiAgLy8gdG9ybiBkb3duIGJ5IHRoZSBob3N0LiBSdW4gYW55IHRlYXJkb3ducyBiZWZvcmUgZm9yZ2V0dGluZyB0aGVtLlxuICBmb3IgKGNvbnN0IHAgb2Ygc3RhdGUucGFnZXMudmFsdWVzKCkpIHtcbiAgICB0cnkge1xuICAgICAgcC50ZWFyZG93bj8uKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcGxvZyhcInBhZ2UgdGVhcmRvd24gZmFpbGVkXCIsIHsgaWQ6IHAuaWQsIGVycjogU3RyaW5nKGUpIH0pO1xuICAgIH1cbiAgfVxuICBzdGF0ZS5wYWdlcy5jbGVhcigpO1xuICBzeW5jUGFnZXNHcm91cCgpO1xuICAvLyBJZiB3ZSB3ZXJlIG9uIGEgcmVnaXN0ZXJlZCBwYWdlIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cywgZmFsbCBiYWNrIHRvXG4gIC8vIHJlc3RvcmluZyBDb2RleCdzIHZpZXcuXG4gIGlmIChcbiAgICBzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJlxuICAgICFzdGF0ZS5wYWdlcy5oYXMoc3RhdGUuYWN0aXZlUGFnZS5pZClcbiAgKSB7XG4gICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICB9IGVsc2UgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHtcbiAgICByZXJlbmRlcigpO1xuICB9XG59XG5cbi8qKlxuICogUmVnaXN0ZXIgYSB0d2Vhay1vd25lZCBzZXR0aW5ncyBwYWdlLiBUaGUgcnVudGltZSBpbmplY3RzIGEgc2lkZWJhciBlbnRyeVxuICogdW5kZXIgYSBcIlRXRUFLU1wiIGdyb3VwIGhlYWRlciAod2hpY2ggYXBwZWFycyBvbmx5IHdoZW4gYXQgbGVhc3Qgb25lIHBhZ2VcbiAqIGlzIHJlZ2lzdGVyZWQpIGFuZCByb3V0ZXMgY2xpY2tzIHRvIHRoZSBwYWdlJ3MgYHJlbmRlcihyb290KWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclBhZ2UoXG4gIHR3ZWFrSWQ6IHN0cmluZyxcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3QsXG4gIHBhZ2U6IFNldHRpbmdzUGFnZSxcbik6IFNldHRpbmdzSGFuZGxlIHtcbiAgY29uc3QgaWQgPSBwYWdlLmlkOyAvLyBhbHJlYWR5IG5hbWVzcGFjZWQgYnkgdHdlYWstaG9zdCBhcyBgJHt0d2Vha0lkfToke3BhZ2UuaWR9YFxuICBjb25zdCBlbnRyeTogUmVnaXN0ZXJlZFBhZ2UgPSB7IGlkLCB0d2Vha0lkLCBtYW5pZmVzdCwgcGFnZSB9O1xuICBzdGF0ZS5wYWdlcy5zZXQoaWQsIGVudHJ5KTtcbiAgcGxvZyhcInJlZ2lzdGVyUGFnZVwiLCB7IGlkLCB0aXRsZTogcGFnZS50aXRsZSwgdHdlYWtJZCB9KTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gSWYgdGhlIHVzZXIgd2FzIGFscmVhZHkgb24gdGhpcyBwYWdlIChob3QgcmVsb2FkKSwgcmUtbW91bnQgaXRzIGJvZHkuXG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBzdGF0ZS5hY3RpdmVQYWdlLmlkID09PSBpZCkge1xuICAgIHJlcmVuZGVyKCk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB1bnJlZ2lzdGVyOiAoKSA9PiB7XG4gICAgICBjb25zdCBlID0gc3RhdGUucGFnZXMuZ2V0KGlkKTtcbiAgICAgIGlmICghZSkgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZS50ZWFyZG93bj8uKCk7XG4gICAgICB9IGNhdGNoIHt9XG4gICAgICBzdGF0ZS5wYWdlcy5kZWxldGUoaWQpO1xuICAgICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBzdGF0ZS5hY3RpdmVQYWdlLmlkID09PSBpZCkge1xuICAgICAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gICAgICB9XG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIENhbGxlZCBieSB0aGUgdHdlYWsgaG9zdCBhZnRlciBmZXRjaGluZyB0aGUgdHdlYWsgbGlzdCBmcm9tIG1haW4uICovXG5leHBvcnQgZnVuY3Rpb24gc2V0TGlzdGVkVHdlYWtzKGxpc3Q6IExpc3RlZFR3ZWFrW10pOiB2b2lkIHtcbiAgc3RhdGUubGlzdGVkVHdlYWtzID0gbGlzdDtcbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHJlcmVuZGVyKCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBpbmplY3Rpb24gXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHRyeUluamVjdCgpOiB2b2lkIHtcbiAgY29uc3QgaXRlbXNHcm91cCA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICBpZiAoIWl0ZW1zR3JvdXApIHtcbiAgICBzY2hlZHVsZVNldHRpbmdzU3VyZmFjZUhpZGRlbigpO1xuICAgIHBsb2coXCJzaWRlYmFyIG5vdCBmb3VuZFwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpO1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gIH1cbiAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh0cnVlLCBcInNpZGViYXItZm91bmRcIik7XG4gIC8vIENvZGV4J3MgaXRlbXMgZ3JvdXAgbGl2ZXMgaW5zaWRlIGFuIG91dGVyIHdyYXBwZXIgdGhhdCdzIGFscmVhZHkgc3R5bGVkXG4gIC8vIHRvIGhvbGQgbXVsdGlwbGUgZ3JvdXBzIChgZmxleCBmbGV4LWNvbCBnYXAtMSBnYXAtMGApLiBXZSBpbmplY3Qgb3VyXG4gIC8vIGdyb3VwIGFzIGEgc2libGluZyBzbyB0aGUgbmF0dXJhbCBnYXAtMSBhY3RzIGFzIG91ciB2aXN1YWwgc2VwYXJhdG9yLlxuICBjb25zdCBvdXRlciA9IGl0ZW1zR3JvdXAucGFyZW50RWxlbWVudCA/PyBpdGVtc0dyb3VwO1xuICBzdGF0ZS5zaWRlYmFyUm9vdCA9IG91dGVyO1xuICBzeW5jTmF0aXZlU2V0dGluZ3NIZWFkZXIoaXRlbXNHcm91cCwgb3V0ZXIpO1xuXG4gIGlmIChzdGF0ZS5uYXZHcm91cCAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5uYXZHcm91cCkpIHtcbiAgICBzeW5jUGFnZXNHcm91cCgpO1xuICAgIC8vIENvZGV4IHJlLXJlbmRlcnMgaXRzIG5hdGl2ZSBzaWRlYmFyIGJ1dHRvbnMgb24gaXRzIG93biBzdGF0ZSBjaGFuZ2VzLlxuICAgIC8vIElmIG9uZSBvZiBvdXIgcGFnZXMgaXMgYWN0aXZlLCByZS1zdHJpcCBDb2RleCdzIGFjdGl2ZSBzdHlsaW5nIHNvXG4gICAgLy8gR2VuZXJhbCBkb2Vzbid0IHJlYXBwZWFyIGFzIHNlbGVjdGVkLlxuICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlICE9PSBudWxsKSBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU2lkZWJhciB3YXMgZWl0aGVyIGZyZXNobHkgbW91bnRlZCAoU2V0dGluZ3MganVzdCBvcGVuZWQpIG9yIHJlLW1vdW50ZWRcbiAgLy8gKGNsb3NlZCBhbmQgcmUtb3BlbmVkLCBvciBuYXZpZ2F0ZWQgYXdheSBhbmQgYmFjaykuIEluIGFsbCBvZiB0aG9zZVxuICAvLyBjYXNlcyBDb2RleCByZXNldHMgdG8gaXRzIGRlZmF1bHQgcGFnZSAoR2VuZXJhbCksIGJ1dCBvdXIgaW4tbWVtb3J5XG4gIC8vIGBhY3RpdmVQYWdlYCBtYXkgc3RpbGwgcmVmZXJlbmNlIHRoZSBsYXN0IHR3ZWFrL3BhZ2UgdGhlIHVzZXIgaGFkIG9wZW5cbiAgLy8gXHUyMDE0IHdoaWNoIHdvdWxkIGNhdXNlIHRoYXQgbmF2IGJ1dHRvbiB0byByZW5kZXIgd2l0aCB0aGUgYWN0aXZlIHN0eWxpbmdcbiAgLy8gZXZlbiB0aG91Z2ggQ29kZXggaXMgc2hvd2luZyBHZW5lcmFsLiBDbGVhciBpdCBzbyBgc3luY1BhZ2VzR3JvdXBgIC9cbiAgLy8gYHNldE5hdkFjdGl2ZWAgc3RhcnQgZnJvbSBhIG5ldXRyYWwgc3RhdGUuIFRoZSBwYW5lbEhvc3QgcmVmZXJlbmNlIGlzXG4gIC8vIGFsc28gc3RhbGUgKGl0cyBET00gd2FzIGRpc2NhcmRlZCB3aXRoIHRoZSBwcmV2aW91cyBjb250ZW50IGFyZWEpLlxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCB8fCBzdGF0ZS5wYW5lbEhvc3QgIT09IG51bGwpIHtcbiAgICBwbG9nKFwic2lkZWJhciByZS1tb3VudCBkZXRlY3RlZDsgY2xlYXJpbmcgc3RhbGUgYWN0aXZlIHN0YXRlXCIsIHtcbiAgICAgIHByZXZBY3RpdmU6IHN0YXRlLmFjdGl2ZVBhZ2UsXG4gICAgfSk7XG4gICAgc3RhdGUuYWN0aXZlUGFnZSA9IG51bGw7XG4gICAgc3RhdGUucGFuZWxIb3N0ID0gbnVsbDtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBHcm91cCBjb250YWluZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGdyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZ3JvdXAuZGF0YXNldC5jb2RleHBwID0gXCJuYXYtZ3JvdXBcIjtcbiAgZ3JvdXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1weFwiO1xuXG4gIGdyb3VwLmFwcGVuZENoaWxkKHNpZGViYXJHcm91cEhlYWRlcihcIkNvZGV4KytcIiwgXCJwdC0zXCIpKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgVHdvIHNpZGViYXIgaXRlbXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGNvbmZpZ0J0biA9IG1ha2VTaWRlYmFySXRlbShcIkNvbmZpZ1wiLCBjb25maWdJY29uU3ZnKCkpO1xuICBjb25zdCB0d2Vha3NCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJUd2Vha3NcIiwgdHdlYWtzSWNvblN2ZygpKTtcblxuICBjb25maWdCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJjb25maWdcIiB9KTtcbiAgfSk7XG4gIHR3ZWFrc0J0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInR3ZWFrc1wiIH0pO1xuICB9KTtcblxuICBncm91cC5hcHBlbmRDaGlsZChjb25maWdCdG4pO1xuICBncm91cC5hcHBlbmRDaGlsZCh0d2Vha3NCdG4pO1xuICBvdXRlci5hcHBlbmRDaGlsZChncm91cCk7XG5cbiAgc3RhdGUubmF2R3JvdXAgPSBncm91cDtcbiAgc3RhdGUubmF2QnV0dG9ucyA9IHsgY29uZmlnOiBjb25maWdCdG4sIHR3ZWFrczogdHdlYWtzQnRuIH07XG4gIHBsb2coXCJuYXYgZ3JvdXAgaW5qZWN0ZWRcIiwgeyBvdXRlclRhZzogb3V0ZXIudGFnTmFtZSB9KTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbn1cblxuZnVuY3Rpb24gc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXA6IEhUTUxFbGVtZW50LCBvdXRlcjogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm5hdGl2ZU5hdkhlYWRlciAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5uYXRpdmVOYXZIZWFkZXIpKSByZXR1cm47XG4gIGlmIChvdXRlciA9PT0gaXRlbXNHcm91cCkgcmV0dXJuO1xuXG4gIGNvbnN0IGhlYWRlciA9IHNpZGViYXJHcm91cEhlYWRlcihcIkdlbmVyYWxcIik7XG4gIGhlYWRlci5kYXRhc2V0LmNvZGV4cHAgPSBcIm5hdGl2ZS1uYXYtaGVhZGVyXCI7XG4gIG91dGVyLmluc2VydEJlZm9yZShoZWFkZXIsIGl0ZW1zR3JvdXApO1xuICBzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgPSBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIHNpZGViYXJHcm91cEhlYWRlcih0ZXh0OiBzdHJpbmcsIHRvcFBhZGRpbmcgPSBcInB0LTJcIik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9XG4gICAgYHB4LXJvdy14ICR7dG9wUGFkZGluZ30gcGItMSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bSB1cHBlcmNhc2UgdHJhY2tpbmctd2lkZXIgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIHNlbGVjdC1ub25lYDtcbiAgaGVhZGVyLnRleHRDb250ZW50ID0gdGV4dDtcbiAgcmV0dXJuIGhlYWRlcjtcbn1cblxuZnVuY3Rpb24gc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTogdm9pZCB7XG4gIGlmICghc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSB8fCBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHJldHVybjtcbiAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gbnVsbDtcbiAgICBpZiAoZmluZFNpZGViYXJJdGVtc0dyb3VwKCkpIHJldHVybjtcbiAgICBpZiAoaXNTZXR0aW5nc1RleHRWaXNpYmxlKCkpIHJldHVybjtcbiAgICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKGZhbHNlLCBcInNpZGViYXItbm90LWZvdW5kXCIpO1xuICB9LCAxNTAwKTtcbn1cblxuZnVuY3Rpb24gaXNTZXR0aW5nc1RleHRWaXNpYmxlKCk6IGJvb2xlYW4ge1xuICBjb25zdCB0ZXh0ID0gY29tcGFjdFNldHRpbmdzVGV4dChkb2N1bWVudC5ib2R5Py50ZXh0Q29udGVudCB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gKFxuICAgIHRleHQuaW5jbHVkZXMoXCJiYWNrIHRvIGFwcFwiKSAmJlxuICAgIHRleHQuaW5jbHVkZXMoXCJnZW5lcmFsXCIpICYmXG4gICAgdGV4dC5pbmNsdWRlcyhcImFwcGVhcmFuY2VcIikgJiZcbiAgICAodGV4dC5pbmNsdWRlcyhcImNvbmZpZ3VyYXRpb25cIikgfHwgdGV4dC5pbmNsdWRlcyhcImRlZmF1bHQgcGVybWlzc2lvbnNcIikpXG4gICk7XG59XG5cbmZ1bmN0aW9uIGNvbXBhY3RTZXR0aW5nc1RleHQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcodmFsdWUgfHwgXCJcIikucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xufVxuXG5mdW5jdGlvbiBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKHZpc2libGU6IGJvb2xlYW4sIHJlYXNvbjogc3RyaW5nKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID09PSB2aXNpYmxlKSByZXR1cm47XG4gIHN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgPSB2aXNpYmxlO1xuICB0cnkge1xuICAgICh3aW5kb3cgYXMgV2luZG93ICYgeyBfX2NvZGV4cHBTZXR0aW5nc1N1cmZhY2VWaXNpYmxlPzogYm9vbGVhbiB9KS5fX2NvZGV4cHBTZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC5jb2RleHBwU2V0dGluZ3NTdXJmYWNlID0gdmlzaWJsZSA/IFwidHJ1ZVwiIDogXCJmYWxzZVwiO1xuICAgIHdpbmRvdy5kaXNwYXRjaEV2ZW50KFxuICAgICAgbmV3IEN1c3RvbUV2ZW50KFwiY29kZXhwcDpzZXR0aW5ncy1zdXJmYWNlXCIsIHtcbiAgICAgICAgZGV0YWlsOiB7IHZpc2libGUsIHJlYXNvbiB9LFxuICAgICAgfSksXG4gICAgKTtcbiAgfSBjYXRjaCB7fVxuICBwbG9nKFwic2V0dGluZ3Mgc3VyZmFjZVwiLCB7IHZpc2libGUsIHJlYXNvbiwgdXJsOiBsb2NhdGlvbi5ocmVmIH0pO1xufVxuXG4vKipcbiAqIFJlbmRlciAob3IgcmUtcmVuZGVyKSB0aGUgc2Vjb25kIHNpZGViYXIgZ3JvdXAgb2YgcGVyLXR3ZWFrIHBhZ2VzLiBUaGVcbiAqIGdyb3VwIGlzIGNyZWF0ZWQgbGF6aWx5IGFuZCByZW1vdmVkIHdoZW4gdGhlIGxhc3QgcGFnZSB1bnJlZ2lzdGVycywgc29cbiAqIHVzZXJzIHdpdGggbm8gcGFnZS1yZWdpc3RlcmluZyB0d2Vha3MgbmV2ZXIgc2VlIGFuIGVtcHR5IFwiVHdlYWtzXCIgaGVhZGVyLlxuICovXG5mdW5jdGlvbiBzeW5jUGFnZXNHcm91cCgpOiB2b2lkIHtcbiAgY29uc3Qgb3V0ZXIgPSBzdGF0ZS5zaWRlYmFyUm9vdDtcbiAgaWYgKCFvdXRlcikgcmV0dXJuO1xuICBjb25zdCBwYWdlcyA9IFsuLi5zdGF0ZS5wYWdlcy52YWx1ZXMoKV07XG5cbiAgLy8gQnVpbGQgYSBkZXRlcm1pbmlzdGljIGZpbmdlcnByaW50IG9mIHRoZSBkZXNpcmVkIGdyb3VwIHN0YXRlLiBJZiB0aGVcbiAgLy8gY3VycmVudCBET00gZ3JvdXAgYWxyZWFkeSBtYXRjaGVzLCB0aGlzIGlzIGEgbm8tb3AgXHUyMDE0IGNyaXRpY2FsLCBiZWNhdXNlXG4gIC8vIHN5bmNQYWdlc0dyb3VwIGlzIGNhbGxlZCBvbiBldmVyeSBNdXRhdGlvbk9ic2VydmVyIHRpY2sgYW5kIGFueSBET01cbiAgLy8gd3JpdGUgd291bGQgcmUtdHJpZ2dlciB0aGF0IG9ic2VydmVyIChpbmZpbml0ZSBsb29wLCBhcHAgZnJlZXplKS5cbiAgY29uc3QgZGVzaXJlZEtleSA9IHBhZ2VzLmxlbmd0aCA9PT0gMFxuICAgID8gXCJFTVBUWVwiXG4gICAgOiBwYWdlcy5tYXAoKHApID0+IGAke3AuaWR9fCR7cC5wYWdlLnRpdGxlfXwke3AucGFnZS5pY29uU3ZnID8/IFwiXCJ9YCkuam9pbihcIlxcblwiKTtcbiAgY29uc3QgZ3JvdXBBdHRhY2hlZCA9ICEhc3RhdGUucGFnZXNHcm91cCAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5wYWdlc0dyb3VwKTtcbiAgaWYgKHN0YXRlLnBhZ2VzR3JvdXBLZXkgPT09IGRlc2lyZWRLZXkgJiYgKHBhZ2VzLmxlbmd0aCA9PT0gMCA/ICFncm91cEF0dGFjaGVkIDogZ3JvdXBBdHRhY2hlZCkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXApIHtcbiAgICAgIHN0YXRlLnBhZ2VzR3JvdXAucmVtb3ZlKCk7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwID0gbnVsbDtcbiAgICB9XG4gICAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSBwLm5hdkJ1dHRvbiA9IG51bGw7XG4gICAgc3RhdGUucGFnZXNHcm91cEtleSA9IGRlc2lyZWRLZXk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbGV0IGdyb3VwID0gc3RhdGUucGFnZXNHcm91cDtcbiAgaWYgKCFncm91cCB8fCAhb3V0ZXIuY29udGFpbnMoZ3JvdXApKSB7XG4gICAgZ3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGdyb3VwLmRhdGFzZXQuY29kZXhwcCA9IFwicGFnZXMtZ3JvdXBcIjtcbiAgICBncm91cC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLXB4XCI7XG4gICAgZ3JvdXAuYXBwZW5kQ2hpbGQoc2lkZWJhckdyb3VwSGVhZGVyKFwiVHdlYWtzXCIsIFwicHQtM1wiKSk7XG4gICAgb3V0ZXIuYXBwZW5kQ2hpbGQoZ3JvdXApO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBncm91cDtcbiAgfSBlbHNlIHtcbiAgICAvLyBTdHJpcCBwcmlvciBidXR0b25zIChrZWVwIHRoZSBoZWFkZXIgYXQgaW5kZXggMCkuXG4gICAgd2hpbGUgKGdyb3VwLmNoaWxkcmVuLmxlbmd0aCA+IDEpIGdyb3VwLnJlbW92ZUNoaWxkKGdyb3VwLmxhc3RDaGlsZCEpO1xuICB9XG5cbiAgZm9yIChjb25zdCBwIG9mIHBhZ2VzKSB7XG4gICAgY29uc3QgaWNvbiA9IHAucGFnZS5pY29uU3ZnID8/IGRlZmF1bHRQYWdlSWNvblN2ZygpO1xuICAgIGNvbnN0IGJ0biA9IG1ha2VTaWRlYmFySXRlbShwLnBhZ2UudGl0bGUsIGljb24pO1xuICAgIGJ0bi5kYXRhc2V0LmNvZGV4cHAgPSBgbmF2LXBhZ2UtJHtwLmlkfWA7XG4gICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiLCBpZDogcC5pZCB9KTtcbiAgICB9KTtcbiAgICBwLm5hdkJ1dHRvbiA9IGJ0bjtcbiAgICBncm91cC5hcHBlbmRDaGlsZChidG4pO1xuICB9XG4gIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBkZXNpcmVkS2V5O1xuICBwbG9nKFwicGFnZXMgZ3JvdXAgc3luY2VkXCIsIHtcbiAgICBjb3VudDogcGFnZXMubGVuZ3RoLFxuICAgIGlkczogcGFnZXMubWFwKChwKSA9PiBwLmlkKSxcbiAgfSk7XG4gIC8vIFJlZmxlY3QgY3VycmVudCBhY3RpdmUgc3RhdGUgYWNyb3NzIHRoZSByZWJ1aWx0IGJ1dHRvbnMuXG4gIHNldE5hdkFjdGl2ZShzdGF0ZS5hY3RpdmVQYWdlKTtcbn1cblxuZnVuY3Rpb24gbWFrZVNpZGViYXJJdGVtKGxhYmVsOiBzdHJpbmcsIGljb25Tdmc6IHN0cmluZyk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgLy8gQ2xhc3Mgc3RyaW5nIGNvcGllZCB2ZXJiYXRpbSBmcm9tIENvZGV4J3Mgc2lkZWJhciBidXR0b25zIChHZW5lcmFsIGV0YykuXG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmRhdGFzZXQuY29kZXhwcCA9IGBuYXYtJHtsYWJlbC50b0xvd2VyQ2FzZSgpfWA7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIGxhYmVsKTtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJmb2N1cy12aXNpYmxlOm91dGxpbmUtdG9rZW4tYm9yZGVyIHJlbGF0aXZlIHB4LXJvdy14IHB5LXJvdy15IGN1cnNvci1pbnRlcmFjdGlvbiBzaHJpbmstMCBpdGVtcy1jZW50ZXIgb3ZlcmZsb3ctaGlkZGVuIHJvdW5kZWQtbGcgdGV4dC1sZWZ0IHRleHQtc20gZm9jdXMtdmlzaWJsZTpvdXRsaW5lIGZvY3VzLXZpc2libGU6b3V0bGluZS0yIGZvY3VzLXZpc2libGU6b3V0bGluZS1vZmZzZXQtMiBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS01MCBnYXAtMiBmbGV4IHctZnVsbCBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZm9udC1ub3JtYWxcIjtcblxuICBjb25zdCBpbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIHRleHQtYmFzZSBnYXAtMiBmbGV4LTEgdGV4dC10b2tlbi1mb3JlZ3JvdW5kXCI7XG4gIGlubmVyLmlubmVySFRNTCA9IGAke2ljb25Tdmd9PHNwYW4gY2xhc3M9XCJ0cnVuY2F0ZVwiPiR7bGFiZWx9PC9zcGFuPmA7XG4gIGJ0bi5hcHBlbmRDaGlsZChpbm5lcik7XG4gIHJldHVybiBidG47XG59XG5cbi8qKiBJbnRlcm5hbCBrZXkgZm9yIHRoZSBidWlsdC1pbiBuYXYgYnV0dG9ucy4gKi9cbnR5cGUgQnVpbHRpblBhZ2UgPSBcImNvbmZpZ1wiIHwgXCJ0d2Vha3NcIjtcblxuZnVuY3Rpb24gc2V0TmF2QWN0aXZlKGFjdGl2ZTogQWN0aXZlUGFnZSB8IG51bGwpOiB2b2lkIHtcbiAgLy8gQnVpbHQtaW4gKENvbmZpZy9Ud2Vha3MpIGJ1dHRvbnMuXG4gIGlmIChzdGF0ZS5uYXZCdXR0b25zKSB7XG4gICAgY29uc3QgYnVpbHRpbjogQnVpbHRpblBhZ2UgfCBudWxsID1cbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJjb25maWdcIiA/IFwiY29uZmlnXCIgOlxuICAgICAgYWN0aXZlPy5raW5kID09PSBcInR3ZWFrc1wiID8gXCJ0d2Vha3NcIiA6IG51bGw7XG4gICAgZm9yIChjb25zdCBba2V5LCBidG5dIG9mIE9iamVjdC5lbnRyaWVzKHN0YXRlLm5hdkJ1dHRvbnMpIGFzIFtCdWlsdGluUGFnZSwgSFRNTEJ1dHRvbkVsZW1lbnRdW10pIHtcbiAgICAgIGFwcGx5TmF2QWN0aXZlKGJ0biwga2V5ID09PSBidWlsdGluKTtcbiAgICB9XG4gIH1cbiAgLy8gUGVyLXBhZ2UgcmVnaXN0ZXJlZCBidXR0b25zLlxuICBmb3IgKGNvbnN0IHAgb2Ygc3RhdGUucGFnZXMudmFsdWVzKCkpIHtcbiAgICBpZiAoIXAubmF2QnV0dG9uKSBjb250aW51ZTtcbiAgICBjb25zdCBpc0FjdGl2ZSA9IGFjdGl2ZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgYWN0aXZlLmlkID09PSBwLmlkO1xuICAgIGFwcGx5TmF2QWN0aXZlKHAubmF2QnV0dG9uLCBpc0FjdGl2ZSk7XG4gIH1cbiAgLy8gQ29kZXgncyBvd24gc2lkZWJhciBidXR0b25zIChHZW5lcmFsLCBBcHBlYXJhbmNlLCBldGMpLiBXaGVuIG9uZSBvZlxuICAvLyBvdXIgcGFnZXMgaXMgYWN0aXZlLCBDb2RleCBzdGlsbCBoYXMgYXJpYS1jdXJyZW50PVwicGFnZVwiIGFuZCB0aGVcbiAgLy8gYWN0aXZlLWJnIGNsYXNzIG9uIHdoaWNoZXZlciBpdGVtIGl0IGNvbnNpZGVyZWQgdGhlIHJvdXRlIFx1MjAxNCB0eXBpY2FsbHlcbiAgLy8gR2VuZXJhbC4gVGhhdCBtYWtlcyBib3RoIGJ1dHRvbnMgbG9vayBzZWxlY3RlZC4gU3RyaXAgQ29kZXgncyBhY3RpdmVcbiAgLy8gc3R5bGluZyB3aGlsZSBvbmUgb2Ygb3VycyBpcyBhY3RpdmU7IHJlc3RvcmUgaXQgd2hlbiBub25lIGlzLlxuICBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUoYWN0aXZlICE9PSBudWxsKTtcbn1cblxuLyoqXG4gKiBNdXRlIENvZGV4J3Mgb3duIGFjdGl2ZS1zdGF0ZSBzdHlsaW5nIG9uIGl0cyBzaWRlYmFyIGJ1dHRvbnMuIFdlIGRvbid0XG4gKiB0b3VjaCBDb2RleCdzIFJlYWN0IHN0YXRlIFx1MjAxNCB3aGVuIHRoZSB1c2VyIGNsaWNrcyBhIG5hdGl2ZSBpdGVtLCBDb2RleFxuICogcmUtcmVuZGVycyB0aGUgYnV0dG9ucyBhbmQgcmUtYXBwbGllcyBpdHMgb3duIGNvcnJlY3Qgc3RhdGUsIHRoZW4gb3VyXG4gKiBzaWRlYmFyLWNsaWNrIGxpc3RlbmVyIGZpcmVzIGByZXN0b3JlQ29kZXhWaWV3YCAod2hpY2ggY2FsbHMgYmFjayBpbnRvXG4gKiBgc2V0TmF2QWN0aXZlKG51bGwpYCBhbmQgbGV0cyBDb2RleCdzIHN0eWxpbmcgc3RhbmQpLlxuICpcbiAqIGBtdXRlPXRydWVgICBcdTIxOTIgc3RyaXAgYXJpYS1jdXJyZW50IGFuZCBzd2FwIGFjdGl2ZSBiZyBcdTIxOTIgaG92ZXIgYmdcbiAqIGBtdXRlPWZhbHNlYCBcdTIxOTIgbm8tb3AgKENvZGV4J3Mgb3duIHJlLXJlbmRlciBhbHJlYWR5IHJlc3RvcmVkIHRoaW5ncylcbiAqL1xuZnVuY3Rpb24gc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKG11dGU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgaWYgKCFtdXRlKSByZXR1cm47XG4gIGNvbnN0IHJvb3QgPSBzdGF0ZS5zaWRlYmFyUm9vdDtcbiAgaWYgKCFyb290KSByZXR1cm47XG4gIGNvbnN0IGJ1dHRvbnMgPSBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIikpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBidXR0b25zKSB7XG4gICAgLy8gU2tpcCBvdXIgb3duIGJ1dHRvbnMuXG4gICAgaWYgKGJ0bi5kYXRhc2V0LmNvZGV4cHApIGNvbnRpbnVlO1xuICAgIGlmIChidG4uZ2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpID09PSBcInBhZ2VcIikge1xuICAgICAgYnRuLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKTtcbiAgICB9XG4gICAgaWYgKGJ0bi5jbGFzc0xpc3QuY29udGFpbnMoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIikpIHtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5TmF2QWN0aXZlKGJ0bjogSFRNTEJ1dHRvbkVsZW1lbnQsIGFjdGl2ZTogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBpbm5lciA9IGJ0bi5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChhY3RpdmUpIHtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIsIFwiZm9udC1ub3JtYWxcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LmFkZChcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIiwgXCJwYWdlXCIpO1xuICAgICAgaWYgKGlubmVyKSB7XG4gICAgICAgIGlubmVyLmNsYXNzTGlzdC5yZW1vdmUoXCJ0ZXh0LXRva2VuLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyLmNsYXNzTGlzdC5hZGQoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lclxuICAgICAgICAgIC5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpXG4gICAgICAgICAgPy5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24taWNvbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBidG4uY2xhc3NMaXN0LmFkZChcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiLCBcImZvbnQtbm9ybWFsXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpO1xuICAgICAgaWYgKGlubmVyKSB7XG4gICAgICAgIGlubmVyLmNsYXNzTGlzdC5hZGQoXCJ0ZXh0LXRva2VuLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyLmNsYXNzTGlzdC5yZW1vdmUoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lclxuICAgICAgICAgIC5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpXG4gICAgICAgICAgPy5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24taWNvbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgfVxuICAgIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGFjdGl2YXRpb24gXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGFjdGl2YXRlUGFnZShwYWdlOiBBY3RpdmVQYWdlKTogdm9pZCB7XG4gIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgaWYgKCFjb250ZW50KSB7XG4gICAgcGxvZyhcImFjdGl2YXRlOiBjb250ZW50IGFyZWEgbm90IGZvdW5kXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBzdGF0ZS5hY3RpdmVQYWdlID0gcGFnZTtcbiAgcGxvZyhcImFjdGl2YXRlXCIsIHsgcGFnZSB9KTtcblxuICAvLyBIaWRlIENvZGV4J3MgY29udGVudCBjaGlsZHJlbiwgc2hvdyBvdXJzLlxuICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20oY29udGVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHAgPT09IFwidHdlYWtzLXBhbmVsXCIpIGNvbnRpbnVlO1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW4gPT09IHVuZGVmaW5lZCkge1xuICAgICAgY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuID0gY2hpbGQuc3R5bGUuZGlzcGxheSB8fCBcIlwiO1xuICAgIH1cbiAgICBjaGlsZC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIH1cbiAgbGV0IHBhbmVsID0gY29udGVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignW2RhdGEtY29kZXhwcD1cInR3ZWFrcy1wYW5lbFwiXScpO1xuICBpZiAoIXBhbmVsKSB7XG4gICAgcGFuZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHBhbmVsLmRhdGFzZXQuY29kZXhwcCA9IFwidHdlYWtzLXBhbmVsXCI7XG4gICAgcGFuZWwuc3R5bGUuY3NzVGV4dCA9IFwid2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvdmVyZmxvdzphdXRvO1wiO1xuICAgIGNvbnRlbnQuYXBwZW5kQ2hpbGQocGFuZWwpO1xuICB9XG4gIHBhbmVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gIHN0YXRlLnBhbmVsSG9zdCA9IHBhbmVsO1xuICByZXJlbmRlcigpO1xuICBzZXROYXZBY3RpdmUocGFnZSk7XG4gIC8vIHJlc3RvcmUgQ29kZXgncyB2aWV3LiBSZS1yZWdpc3RlciBpZiBuZWVkZWQuXG4gIGNvbnN0IHNpZGViYXIgPSBzdGF0ZS5zaWRlYmFyUm9vdDtcbiAgaWYgKHNpZGViYXIpIHtcbiAgICBpZiAoc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyKSB7XG4gICAgICBzaWRlYmFyLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIsIHRydWUpO1xuICAgIH1cbiAgICBjb25zdCBoYW5kbGVyID0gKGU6IEV2ZW50KSA9PiB7XG4gICAgICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgICBpZiAoIXRhcmdldCkgcmV0dXJuO1xuICAgICAgaWYgKHN0YXRlLm5hdkdyb3VwPy5jb250YWlucyh0YXJnZXQpKSByZXR1cm47IC8vIG91ciBidXR0b25zXG4gICAgICBpZiAoc3RhdGUucGFnZXNHcm91cD8uY29udGFpbnModGFyZ2V0KSkgcmV0dXJuOyAvLyBvdXIgcGFnZSBidXR0b25zXG4gICAgICBpZiAodGFyZ2V0LmNsb3Nlc3QoXCJbZGF0YS1jb2RleHBwLXNldHRpbmdzLXNlYXJjaF1cIikpIHJldHVybjtcbiAgICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgICB9O1xuICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciA9IGhhbmRsZXI7XG4gICAgc2lkZWJhci5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgaGFuZGxlciwgdHJ1ZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzdG9yZUNvZGV4VmlldygpOiB2b2lkIHtcbiAgcGxvZyhcInJlc3RvcmUgY29kZXggdmlld1wiKTtcbiAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICBpZiAoIWNvbnRlbnQpIHJldHVybjtcbiAgaWYgKHN0YXRlLnBhbmVsSG9zdCkgc3RhdGUucGFuZWxIb3N0LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQgPT09IHN0YXRlLnBhbmVsSG9zdCkgY29udGludWU7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjaGlsZC5zdHlsZS5kaXNwbGF5ID0gY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuO1xuICAgICAgZGVsZXRlIGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbjtcbiAgICB9XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IG51bGw7XG4gIHNldE5hdkFjdGl2ZShudWxsKTtcbiAgaWYgKHN0YXRlLnNpZGViYXJSb290ICYmIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgIHN0YXRlLnNpZGViYXJSb290LnJlbW92ZUV2ZW50TGlzdGVuZXIoXG4gICAgICBcImNsaWNrXCIsXG4gICAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIsXG4gICAgICB0cnVlLFxuICAgICk7XG4gICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyID0gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXJlbmRlcigpOiB2b2lkIHtcbiAgaWYgKCFzdGF0ZS5hY3RpdmVQYWdlKSByZXR1cm47XG4gIGNvbnN0IGhvc3QgPSBzdGF0ZS5wYW5lbEhvc3Q7XG4gIGlmICghaG9zdCkgcmV0dXJuO1xuICBob3N0LmlubmVySFRNTCA9IFwiXCI7XG5cbiAgY29uc3QgYXAgPSBzdGF0ZS5hY3RpdmVQYWdlO1xuICBpZiAoYXAua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIpIHtcbiAgICBjb25zdCBlbnRyeSA9IHN0YXRlLnBhZ2VzLmdldChhcC5pZCk7XG4gICAgaWYgKCFlbnRyeSkge1xuICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCByb290ID0gcGFuZWxTaGVsbChlbnRyeS5wYWdlLnRpdGxlLCBlbnRyeS5wYWdlLmRlc2NyaXB0aW9uKTtcbiAgICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICAgIHRyeSB7XG4gICAgICAvLyBUZWFyIGRvd24gYW55IHByaW9yIHJlbmRlciBiZWZvcmUgcmUtcmVuZGVyaW5nIChob3QgcmVsb2FkKS5cbiAgICAgIHRyeSB7IGVudHJ5LnRlYXJkb3duPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgZW50cnkudGVhcmRvd24gPSBudWxsO1xuICAgICAgY29uc3QgcmV0ID0gZW50cnkucGFnZS5yZW5kZXIocm9vdC5zZWN0aW9uc1dyYXApO1xuICAgICAgaWYgKHR5cGVvZiByZXQgPT09IFwiZnVuY3Rpb25cIikgZW50cnkudGVhcmRvd24gPSByZXQ7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc3QgZXJyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGVyci5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tY2hhcnRzLXJlZCB0ZXh0LXNtXCI7XG4gICAgICBlcnIudGV4dENvbnRlbnQgPSBgRXJyb3IgcmVuZGVyaW5nIHBhZ2U6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICAgIHJvb3Quc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKGVycik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpdGxlID0gYXAua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwiVHdlYWtzXCIgOiBcIkNvbmZpZ1wiO1xuICBjb25zdCBzdWJ0aXRsZSA9IGFwLmtpbmQgPT09IFwidHdlYWtzXCJcbiAgICA/IFwiTWFuYWdlIHlvdXIgaW5zdGFsbGVkIENvZGV4KysgdHdlYWtzLlwiXG4gICAgOiBcIkNoZWNraW5nIGluc3RhbGxlZCBDb2RleCsrIHZlcnNpb24uXCI7XG4gIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKHRpdGxlLCBzdWJ0aXRsZSk7XG4gIGhvc3QuYXBwZW5kQ2hpbGQocm9vdC5vdXRlcik7XG4gIGlmIChhcC5raW5kID09PSBcInR3ZWFrc1wiKSByZW5kZXJUd2Vha3NQYWdlKHJvb3Quc2VjdGlvbnNXcmFwKTtcbiAgZWxzZSByZW5kZXJDb25maWdQYWdlKHJvb3Quc2VjdGlvbnNXcmFwLCByb290LnN1YnRpdGxlKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIHBhZ2VzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiByZW5kZXJDb25maWdQYWdlKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsIHN1YnRpdGxlPzogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkNvZGV4KysgVXBkYXRlc1wiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjb25zdCBsb2FkaW5nID0gcm93U2ltcGxlKFwiTG9hZGluZyB1cGRhdGUgc2V0dGluZ3NcIiwgXCJDaGVja2luZyBjdXJyZW50IENvZGV4KysgY29uZmlndXJhdGlvbi5cIik7XG4gIGNhcmQuYXBwZW5kQ2hpbGQobG9hZGluZyk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcImNvZGV4cHA6Z2V0LWNvbmZpZ1wiKVxuICAgIC50aGVuKChjb25maWcpID0+IHtcbiAgICAgIGlmIChzdWJ0aXRsZSkge1xuICAgICAgICBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IGBZb3UgaGF2ZSBDb2RleCsrICR7KGNvbmZpZyBhcyBDb2RleFBsdXNQbHVzQ29uZmlnKS52ZXJzaW9ufSBpbnN0YWxsZWQuYDtcbiAgICAgIH1cbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkLCBjb25maWcgYXMgQ29kZXhQbHVzUGx1c0NvbmZpZyk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGlmIChzdWJ0aXRsZSkgc3VidGl0bGUudGV4dENvbnRlbnQgPSBcIkNvdWxkIG5vdCBsb2FkIGluc3RhbGxlZCBDb2RleCsrIHZlcnNpb24uXCI7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGxvYWQgdXBkYXRlIHNldHRpbmdzXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pO1xuXG4gIGNvbnN0IHdhdGNoZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgd2F0Y2hlci5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgd2F0Y2hlci5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJBdXRvLVJlcGFpciBXYXRjaGVyXCIpKTtcbiAgY29uc3Qgd2F0Y2hlckNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICB3YXRjaGVyQ2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB3YXRjaGVyXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gIHdhdGNoZXIuYXBwZW5kQ2hpbGQod2F0Y2hlckNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQod2F0Y2hlcik7XG4gIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKHdhdGNoZXJDYXJkKTtcblxuICBjb25zdCBjZHAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgY2RwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjZHAuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiRGV2ZWxvcGVyIC8gQ0RQXCIpKTtcbiAgY29uc3QgY2RwQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNkcENhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgQ0RQXCIsIFwiUmVhZGluZyBDaHJvbWUgRGV2VG9vbHMgUHJvdG9jb2wgc3RhdHVzLlwiKSk7XG4gIGNkcC5hcHBlbmRDaGlsZChjZHBDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKGNkcCk7XG4gIHJlbmRlckNkcENhcmQoY2RwQ2FyZCk7XG5cbiAgY29uc3QgbWFpbnRlbmFuY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgbWFpbnRlbmFuY2UuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIk1haW50ZW5hbmNlXCIpKTtcbiAgY29uc3QgbWFpbnRlbmFuY2VDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgbWFpbnRlbmFuY2VDYXJkLmFwcGVuZENoaWxkKHVuaW5zdGFsbFJvdygpKTtcbiAgbWFpbnRlbmFuY2VDYXJkLmFwcGVuZENoaWxkKHJlcG9ydEJ1Z1JvdygpKTtcbiAgbWFpbnRlbmFuY2UuYXBwZW5kQ2hpbGQobWFpbnRlbmFuY2VDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkOiBIVE1MRWxlbWVudCwgY29uZmlnOiBDb2RleFBsdXNQbHVzQ29uZmlnKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoYXV0b1VwZGF0ZVJvdyhjb25maWcpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnLnVwZGF0ZUNoZWNrKSk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hlY2spIGNhcmQuYXBwZW5kQ2hpbGQocmVsZWFzZU5vdGVzUm93KGNvbmZpZy51cGRhdGVDaGVjaykpO1xufVxuXG5mdW5jdGlvbiBhdXRvVXBkYXRlUm93KGNvbmZpZzogQ29kZXhQbHVzUGx1c0NvbmZpZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJBdXRvbWF0aWNhbGx5IHJlZnJlc2ggQ29kZXgrK1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgSW5zdGFsbGVkIHZlcnNpb24gdiR7Y29uZmlnLnZlcnNpb259LiBUaGUgd2F0Y2hlciBjYW4gcmVmcmVzaCB0aGUgQ29kZXgrKyBydW50aW1lIGFmdGVyIHlvdSByZXJ1biB0aGUgR2l0SHViIGluc3RhbGxlci5gO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICByb3cuYXBwZW5kQ2hpbGQoXG4gICAgc3dpdGNoQ29udHJvbChjb25maWcuYXV0b1VwZGF0ZSwgYXN5bmMgKG5leHQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6c2V0LWF1dG8tdXBkYXRlXCIsIG5leHQpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXNSb3coY2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayB8IG51bGwpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGNoZWNrPy51cGRhdGVBdmFpbGFibGUgPyBcIkNvZGV4KysgdXBkYXRlIGF2YWlsYWJsZVwiIDogXCJDb2RleCsrIGlzIHVwIHRvIGRhdGVcIjtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gdXBkYXRlU3VtbWFyeShjaGVjayk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBpZiAoY2hlY2s/LnJlbGVhc2VVcmwpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlJlbGVhc2UgTm90ZXNcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCBjaGVjay5yZWxlYXNlVXJsKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgTm93XCIsICgpID0+IHtcbiAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCIwLjY1XCI7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJjb2RleHBwOmNoZWNrLWNvZGV4cHAtdXBkYXRlXCIsIHRydWUpXG4gICAgICAgIC50aGVuKChuZXh0KSA9PiB7XG4gICAgICAgICAgY29uc3QgY2FyZCA9IHJvdy5wYXJlbnRFbGVtZW50O1xuICAgICAgICAgIGlmICghY2FyZCkgcmV0dXJuO1xuICAgICAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnZXQtY29uZmlnXCIpLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgICAgICAgcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkLCB7XG4gICAgICAgICAgICAgIC4uLihjb25maWcgYXMgQ29kZXhQbHVzUGx1c0NvbmZpZyksXG4gICAgICAgICAgICAgIHVwZGF0ZUNoZWNrOiBuZXh0IGFzIENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJDb2RleCsrIHVwZGF0ZSBjaGVjayBmYWlsZWRcIiwgU3RyaW5nKGUpKSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCJcIjtcbiAgICAgICAgfSk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVsZWFzZU5vdGVzUm93KGNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTIgcC0zXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJMYXRlc3QgcmVsZWFzZSBub3Rlc1wiO1xuICByb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5jbGFzc05hbWUgPVxuICAgIFwibWF4LWgtNjAgb3ZlcmZsb3ctYXV0byByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJvZHkuYXBwZW5kQ2hpbGQocmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24oY2hlY2sucmVsZWFzZU5vdGVzPy50cmltKCkgfHwgY2hlY2suZXJyb3IgfHwgXCJObyByZWxlYXNlIG5vdGVzIGF2YWlsYWJsZS5cIikpO1xuICByb3cuYXBwZW5kQ2hpbGQoYm9keSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNkcENhcmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC1jZHAtc3RhdHVzXCIpXG4gICAgLnRoZW4oKHN0YXR1cykgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJDZHBTdGF0dXMoY2FyZCwgc3RhdHVzIGFzIENvZGV4Q2RwU3RhdHVzKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCByZWFkIENEUCBzdGF0dXNcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNkcFN0YXR1cyhjYXJkOiBIVE1MRWxlbWVudCwgc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IHZvaWQge1xuICBjYXJkLmFwcGVuZENoaWxkKGNkcFRvZ2dsZVJvdyhjYXJkLCBzdGF0dXMpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjZHBQb3J0Um93KGNhcmQsIHN0YXR1cykpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNkcEVuZHBvaW50Um93KHN0YXR1cykpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNkcExhdW5jaFJvdyhzdGF0dXMpKTtcbiAgaWYgKHN0YXR1cy5yZXN0YXJ0UmVxdWlyZWQpIHtcbiAgICBjYXJkLmFwcGVuZENoaWxkKFxuICAgICAgcm93U2ltcGxlKFxuICAgICAgICBcIlJlc3RhcnQgcmVxdWlyZWRcIixcbiAgICAgICAgc3RhdHVzLmVuYWJsZWRcbiAgICAgICAgICA/IFwiQ0RQIHdpbGwgdXNlIHRoZSBzYXZlZCBwb3J0IGFmdGVyIENvZGV4IHJlc3RhcnRzLlwiXG4gICAgICAgICAgOiBcIkNEUCBpcyBzdGlsbCBhY3RpdmUgZm9yIHRoaXMgcHJvY2VzcyBhbmQgd2lsbCB0dXJuIG9mZiBhZnRlciBDb2RleCByZXN0YXJ0cy5cIixcbiAgICAgICksXG4gICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjZHBUb2dnbGVSb3coY2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcblxuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1zdGFydCBnYXAtM1wiO1xuICBsZWZ0LmFwcGVuZENoaWxkKGNkcFN0YXR1c0JhZGdlKHN0YXR1cykpO1xuXG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiQ2hyb21lIERldlRvb2xzIFByb3RvY29sXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGNkcFN0YXR1c1N1bW1hcnkoc3RhdHVzKTtcbiAgc3RhY2suYXBwZW5kKHRpdGxlLCBkZXNjKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICByb3cuYXBwZW5kQ2hpbGQoXG4gICAgc3dpdGNoQ29udHJvbChzdGF0dXMuZW5hYmxlZCwgYXN5bmMgKGVuYWJsZWQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6c2V0LWNkcC1jb25maWdcIiwge1xuICAgICAgICBlbmFibGVkLFxuICAgICAgICBwb3J0OiBzdGF0dXMuY29uZmlndXJlZFBvcnQsXG4gICAgICB9KTtcbiAgICAgIHJlZnJlc2hDZHBDYXJkKGNhcmQpO1xuICAgIH0pLFxuICApO1xuXG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNkcFBvcnRSb3coY2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIlJlbW90ZSBkZWJ1Z2dpbmcgcG9ydFwiLFxuICAgIHN0YXR1cy5hY3RpdmVQb3J0XG4gICAgICA/IGBDdXJyZW50IHByb2Nlc3MgaXMgbGlzdGVuaW5nIG9uICR7c3RhdHVzLmFjdGl2ZVBvcnR9LmBcbiAgICAgIDogYFNhdmVkIHBvcnQgaXMgJHtzdGF0dXMuY29uZmlndXJlZFBvcnR9LmAsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbnB1dFwiKTtcbiAgaW5wdXQudHlwZSA9IFwibnVtYmVyXCI7XG4gIGlucHV0Lm1pbiA9IFwiMVwiO1xuICBpbnB1dC5tYXggPSBcIjY1NTM1XCI7XG4gIGlucHV0LnN0ZXAgPSBcIjFcIjtcbiAgaW5wdXQudmFsdWUgPSBTdHJpbmcoc3RhdHVzLmNvbmZpZ3VyZWRQb3J0KTtcbiAgaW5wdXQuY2xhc3NOYW1lID1cbiAgICBcImgtOCB3LTI0IHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdHJhbnNwYXJlbnQgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGZvY3VzOm91dGxpbmUtbm9uZSBmb2N1czpyaW5nLTIgZm9jdXM6cmluZy10b2tlbi1mb2N1cy1ib3JkZXJcIjtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChpbnB1dCk7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIlNhdmVcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgcG9ydCA9IE51bWJlcihpbnB1dC52YWx1ZSk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJjb2RleHBwOnNldC1jZHAtY29uZmlnXCIsIHtcbiAgICAgICAgICBlbmFibGVkOiBzdGF0dXMuZW5hYmxlZCxcbiAgICAgICAgICBwb3J0OiBOdW1iZXIuaXNJbnRlZ2VyKHBvcnQpID8gcG9ydCA6IHN0YXR1cy5jb25maWd1cmVkUG9ydCxcbiAgICAgICAgfSlcbiAgICAgICAgLnRoZW4oKCkgPT4gcmVmcmVzaENkcENhcmQoY2FyZCkpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcIkNEUCBwb3J0IHNhdmUgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjZHBFbmRwb2ludFJvdyhzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgc3RhdHVzLmFjdGl2ZSA/IFwiTG9jYWwgQ0RQIGVuZHBvaW50c1wiIDogXCJMb2NhbCBDRFAgZW5kcG9pbnRzXCIsXG4gICAgc3RhdHVzLmFjdGl2ZSAmJiBzdGF0dXMuanNvbkxpc3RVcmxcbiAgICAgID8gYCR7c3RhdHVzLmpzb25MaXN0VXJsfWBcbiAgICAgIDogXCJOb3QgZXhwb3NlZCBieSB0aGUgY3VycmVudCBDb2RleCBwcm9jZXNzLlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgY29uc3Qgb3BlblRhcmdldHMgPSBjb21wYWN0QnV0dG9uKFwiT3BlbiBUYXJnZXRzXCIsICgpID0+IHtcbiAgICBpZiAoIXN0YXR1cy5qc29uTGlzdFVybCkgcmV0dXJuO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWNkcC11cmxcIiwgc3RhdHVzLmpzb25MaXN0VXJsKTtcbiAgfSk7XG4gIG9wZW5UYXJnZXRzLmRpc2FibGVkID0gIXN0YXR1cy5qc29uTGlzdFVybDtcbiAgY29uc3QgY29weVRhcmdldHMgPSBjb21wYWN0QnV0dG9uKFwiQ29weSBVUkxcIiwgKCkgPT4ge1xuICAgIGlmICghc3RhdHVzLmpzb25MaXN0VXJsKSByZXR1cm47XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvcHktdGV4dFwiLCBzdGF0dXMuanNvbkxpc3RVcmwpO1xuICB9KTtcbiAgY29weVRhcmdldHMuZGlzYWJsZWQgPSAhc3RhdHVzLmpzb25MaXN0VXJsO1xuICBjb25zdCBvcGVuVmVyc2lvbiA9IGNvbXBhY3RCdXR0b24oXCJWZXJzaW9uXCIsICgpID0+IHtcbiAgICBpZiAoIXN0YXR1cy5qc29uVmVyc2lvblVybCkgcmV0dXJuO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWNkcC11cmxcIiwgc3RhdHVzLmpzb25WZXJzaW9uVXJsKTtcbiAgfSk7XG4gIG9wZW5WZXJzaW9uLmRpc2FibGVkID0gIXN0YXR1cy5qc29uVmVyc2lvblVybDtcbiAgYWN0aW9uPy5hcHBlbmQob3BlblRhcmdldHMsIGNvcHlUYXJnZXRzLCBvcGVuVmVyc2lvbik7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNkcExhdW5jaFJvdyhzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJMYXVuY2ggY29tbWFuZFwiLFxuICAgIHN0YXR1cy5hcHBSb290ID8gc3RhdHVzLmFwcFJvb3QgOiBcIkNvZGV4IGFwcCBwYXRoIHdhcyBub3QgZm91bmQgaW4gaW5zdGFsbGVyIHN0YXRlLlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBDb21tYW5kXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb3B5LXRleHRcIiwgc3RhdHVzLmxhdW5jaENvbW1hbmQpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZWZyZXNoQ2RwQ2FyZChjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyBDRFBcIiwgXCJSZWFkaW5nIENocm9tZSBEZXZUb29scyBQcm90b2NvbCBzdGF0dXMuXCIpKTtcbiAgcmVuZGVyQ2RwQ2FyZChjYXJkKTtcbn1cblxuZnVuY3Rpb24gY2RwU3RhdHVzQmFkZ2Uoc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgaWYgKHN0YXR1cy5hY3RpdmUpIHJldHVybiBzdGF0dXNCYWRnZShzdGF0dXMucmVzdGFydFJlcXVpcmVkID8gXCJ3YXJuXCIgOiBcIm9rXCIsIFwiQWN0aXZlXCIpO1xuICBpZiAoc3RhdHVzLnJlc3RhcnRSZXF1aXJlZCkgcmV0dXJuIHN0YXR1c0JhZGdlKFwid2FyblwiLCBcIlJlc3RhcnRcIik7XG4gIHJldHVybiBzdGF0dXNCYWRnZShzdGF0dXMuZW5hYmxlZCA/IFwid2FyblwiIDogXCJ3YXJuXCIsIHN0YXR1cy5lbmFibGVkID8gXCJTYXZlZFwiIDogXCJPZmZcIik7XG59XG5cbmZ1bmN0aW9uIGNkcFN0YXR1c1N1bW1hcnkoc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IHN0cmluZyB7XG4gIGlmIChzdGF0dXMuYWN0aXZlUG9ydCkge1xuICAgIGNvbnN0IHNvdXJjZSA9IHN0YXR1cy5zb3VyY2UgPT09IFwiYXJndlwiID8gXCJsYXVuY2ggYXJnXCIgOiBzdGF0dXMuc291cmNlO1xuICAgIHJldHVybiBgQWN0aXZlIG9uIDEyNy4wLjAuMToke3N0YXR1cy5hY3RpdmVQb3J0fSBmcm9tICR7c291cmNlfS5gO1xuICB9XG4gIGlmIChzdGF0dXMuZW5hYmxlZCkge1xuICAgIHJldHVybiBgRW5hYmxlZCBmb3IgbmV4dCBsYXVuY2ggb24gMTI3LjAuMC4xOiR7c3RhdHVzLmNvbmZpZ3VyZWRQb3J0fS5gO1xuICB9XG4gIHJldHVybiBcIkRpc2FibGVkIGZvciBDb2RleCBsYXVuY2hlcyBtYW5hZ2VkIGJ5IENvZGV4KysuXCI7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJlbGVhc2VOb3Rlc01hcmtkb3duKG1hcmtkb3duOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb290LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjb25zdCBsaW5lcyA9IG1hcmtkb3duLnJlcGxhY2UoL1xcclxcbj8vZywgXCJcXG5cIikuc3BsaXQoXCJcXG5cIik7XG4gIGxldCBwYXJhZ3JhcGg6IHN0cmluZ1tdID0gW107XG4gIGxldCBsaXN0OiBIVE1MT0xpc3RFbGVtZW50IHwgSFRNTFVMaXN0RWxlbWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgY29kZUxpbmVzOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IGZsdXNoUGFyYWdyYXBoID0gKCkgPT4ge1xuICAgIGlmIChwYXJhZ3JhcGgubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwXCIpO1xuICAgIHAuY2xhc3NOYW1lID0gXCJtLTAgbGVhZGluZy01XCI7XG4gICAgYXBwZW5kSW5saW5lTWFya2Rvd24ocCwgcGFyYWdyYXBoLmpvaW4oXCIgXCIpLnRyaW0oKSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwKTtcbiAgICBwYXJhZ3JhcGggPSBbXTtcbiAgfTtcbiAgY29uc3QgZmx1c2hMaXN0ID0gKCkgPT4ge1xuICAgIGlmICghbGlzdCkgcmV0dXJuO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQobGlzdCk7XG4gICAgbGlzdCA9IG51bGw7XG4gIH07XG4gIGNvbnN0IGZsdXNoQ29kZSA9ICgpID0+IHtcbiAgICBpZiAoIWNvZGVMaW5lcykgcmV0dXJuO1xuICAgIGNvbnN0IHByZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwcmVcIik7XG4gICAgcHJlLmNsYXNzTmFtZSA9XG4gICAgICBcIm0tMCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIGNvbnN0IGNvZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY29kZVwiKTtcbiAgICBjb2RlLnRleHRDb250ZW50ID0gY29kZUxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgcHJlLmFwcGVuZENoaWxkKGNvZGUpO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQocHJlKTtcbiAgICBjb2RlTGluZXMgPSBudWxsO1xuICB9O1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmIChsaW5lLnRyaW0oKS5zdGFydHNXaXRoKFwiYGBgXCIpKSB7XG4gICAgICBpZiAoY29kZUxpbmVzKSBmbHVzaENvZGUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgY29kZUxpbmVzID0gW107XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNvZGVMaW5lcykge1xuICAgICAgY29kZUxpbmVzLnB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG4gICAgaWYgKCF0cmltbWVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkaW5nID0gL14oI3sxLDN9KVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAoaGVhZGluZykge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoaGVhZGluZ1sxXS5sZW5ndGggPT09IDEgPyBcImgzXCIgOiBcImg0XCIpO1xuICAgICAgaC5jbGFzc05hbWUgPSBcIm0tMCB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihoLCBoZWFkaW5nWzJdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoaCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB1bm9yZGVyZWQgPSAvXlstKl1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgY29uc3Qgb3JkZXJlZCA9IC9eXFxkK1suKV1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHVub3JkZXJlZCB8fCBvcmRlcmVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgY29uc3Qgd2FudE9yZGVyZWQgPSBCb29sZWFuKG9yZGVyZWQpO1xuICAgICAgaWYgKCFsaXN0IHx8ICh3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiT0xcIikgfHwgKCF3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiVUxcIikpIHtcbiAgICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICAgIGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHdhbnRPcmRlcmVkID8gXCJvbFwiIDogXCJ1bFwiKTtcbiAgICAgICAgbGlzdC5jbGFzc05hbWUgPSB3YW50T3JkZXJlZFxuICAgICAgICAgID8gXCJtLTAgbGlzdC1kZWNpbWFsIHNwYWNlLXktMSBwbC01IGxlYWRpbmctNVwiXG4gICAgICAgICAgOiBcIm0tMCBsaXN0LWRpc2Mgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCI7XG4gICAgICB9XG4gICAgICBjb25zdCBsaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGxpLCAodW5vcmRlcmVkID8/IG9yZGVyZWQpPy5bMV0gPz8gXCJcIik7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGxpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHF1b3RlID0gL14+XFxzPyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChxdW90ZSkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgYmxvY2txdW90ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJibG9ja3F1b3RlXCIpO1xuICAgICAgYmxvY2txdW90ZS5jbGFzc05hbWUgPSBcIm0tMCBib3JkZXItbC0yIGJvcmRlci10b2tlbi1ib3JkZXIgcGwtMyBsZWFkaW5nLTVcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGJsb2NrcXVvdGUsIHF1b3RlWzFdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoYmxvY2txdW90ZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBwYXJhZ3JhcGgucHVzaCh0cmltbWVkKTtcbiAgfVxuXG4gIGZsdXNoUGFyYWdyYXBoKCk7XG4gIGZsdXNoTGlzdCgpO1xuICBmbHVzaENvZGUoKTtcbiAgcmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZElubGluZU1hcmtkb3duKHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBwYXR0ZXJuID0gLyhgKFteYF0rKWB8XFxbKFteXFxdXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCl8XFwqXFwqKFteKl0rKVxcKlxcKnxcXCooW14qXSspXFwqKS9nO1xuICBsZXQgbGFzdEluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZXh0Lm1hdGNoQWxsKHBhdHRlcm4pKSB7XG4gICAgaWYgKG1hdGNoLmluZGV4ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCwgbWF0Y2guaW5kZXgpKTtcbiAgICBpZiAobWF0Y2hbMl0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgICAgY29kZS5jbGFzc05hbWUgPVxuICAgICAgICBcInJvdW5kZWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBweC0xIHB5LTAuNSB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBjb2RlLnRleHRDb250ZW50ID0gbWF0Y2hbMl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFszXSAhPT0gdW5kZWZpbmVkICYmIG1hdGNoWzRdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICAgIGEuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSB1bmRlcmxpbmUgdW5kZXJsaW5lLW9mZnNldC0yXCI7XG4gICAgICBhLmhyZWYgPSBtYXRjaFs0XTtcbiAgICAgIGEudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICAgIGEucmVsID0gXCJub29wZW5lciBub3JlZmVycmVyXCI7XG4gICAgICBhLnRleHRDb250ZW50ID0gbWF0Y2hbM107XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoYSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs1XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBzdHJvbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3Ryb25nXCIpO1xuICAgICAgc3Ryb25nLmNsYXNzTmFtZSA9IFwiZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIHN0cm9uZy50ZXh0Q29udGVudCA9IG1hdGNoWzVdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKHN0cm9uZyk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs2XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJlbVwiKTtcbiAgICAgIGVtLnRleHRDb250ZW50ID0gbWF0Y2hbNl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoZW0pO1xuICAgIH1cbiAgICBsYXN0SW5kZXggPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgfVxuICBhcHBlbmRUZXh0KHBhcmVudCwgdGV4dC5zbGljZShsYXN0SW5kZXgpKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kVGV4dChwYXJlbnQ6IEhUTUxFbGVtZW50LCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHRleHQpIHBhcmVudC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnZXQtd2F0Y2hlci1oZWFsdGhcIilcbiAgICAudGhlbigoaGVhbHRoKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwgaGVhbHRoIGFzIFdhdGNoZXJIZWFsdGgpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGNoZWNrIHdhdGNoZXJcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZDogSFRNTEVsZW1lbnQsIGhlYWx0aDogV2F0Y2hlckhlYWx0aCk6IHZvaWQge1xuICBjYXJkLmFwcGVuZENoaWxkKHdhdGNoZXJTdW1tYXJ5Um93KGhlYWx0aCkpO1xuICBmb3IgKGNvbnN0IGNoZWNrIG9mIGhlYWx0aC5jaGVja3MpIHtcbiAgICBpZiAoY2hlY2suc3RhdHVzID09PSBcIm9rXCIpIGNvbnRpbnVlO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQod2F0Y2hlckNoZWNrUm93KGNoZWNrKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gd2F0Y2hlclN1bW1hcnlSb3coaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhdHVzQmFkZ2UoaGVhbHRoLnN0YXR1cywgaGVhbHRoLndhdGNoZXIpKTtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gaGVhbHRoLnRpdGxlO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgJHtoZWFsdGguc3VtbWFyeX0gQ2hlY2tlZCAke25ldyBEYXRlKGhlYWx0aC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCl9LmA7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgY29uc3QgYWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgYWN0aW9uLmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDaGVjayBOb3dcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY2FyZCA9IHJvdy5wYXJlbnRFbGVtZW50O1xuICAgICAgaWYgKCFjYXJkKSByZXR1cm47XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgd2F0Y2hlclwiLCBcIlZlcmlmeWluZyB0aGUgdXBkYXRlciByZXBhaXIgc2VydmljZS5cIikpO1xuICAgICAgcmVuZGVyV2F0Y2hlckhlYWx0aENhcmQoY2FyZCk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb24pO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiB3YXRjaGVyQ2hlY2tSb3coY2hlY2s6IFdhdGNoZXJIZWFsdGhDaGVjayk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gcm93U2ltcGxlKGNoZWNrLm5hbWUsIGNoZWNrLmRldGFpbCk7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGVmdCkgbGVmdC5wcmVwZW5kKHN0YXR1c0JhZGdlKGNoZWNrLnN0YXR1cykpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBzdGF0dXNCYWRnZShzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiLCBsYWJlbD86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29uc3QgdG9uZSA9XG4gICAgc3RhdHVzID09PSBcIm9rXCJcbiAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLWdyZWVuIHRleHQtdG9rZW4tY2hhcnRzLWdyZWVuXCJcbiAgICAgIDogc3RhdHVzID09PSBcIndhcm5cIlxuICAgICAgICA/IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy15ZWxsb3cgdGV4dC10b2tlbi1jaGFydHMteWVsbG93XCJcbiAgICAgICAgOiBcImJvcmRlci10b2tlbi1jaGFydHMtcmVkIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICBiYWRnZS5jbGFzc05hbWUgPSBgaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCBib3JkZXIgcHgtMiBweS0wLjUgdGV4dC14cyBmb250LW1lZGl1bSAke3RvbmV9YDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBsYWJlbCB8fCAoc3RhdHVzID09PSBcIm9rXCIgPyBcIk9LXCIgOiBzdGF0dXMgPT09IFwid2FyblwiID8gXCJSZXZpZXdcIiA6IFwiRXJyb3JcIik7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlU3VtbWFyeShjaGVjazogQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmICghY2hlY2spIHJldHVybiBcIk5vIHVwZGF0ZSBjaGVjayBoYXMgcnVuIHlldC5cIjtcbiAgY29uc3QgbGF0ZXN0ID0gY2hlY2subGF0ZXN0VmVyc2lvbiA/IGBMYXRlc3QgdiR7Y2hlY2subGF0ZXN0VmVyc2lvbn0uIGAgOiBcIlwiO1xuICBjb25zdCBjaGVja2VkID0gYENoZWNrZWQgJHtuZXcgRGF0ZShjaGVjay5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCl9LmA7XG4gIGlmIChjaGVjay5lcnJvcikgcmV0dXJuIGAke2xhdGVzdH0ke2NoZWNrZWR9ICR7Y2hlY2suZXJyb3J9YDtcbiAgcmV0dXJuIGAke2xhdGVzdH0ke2NoZWNrZWR9YDtcbn1cblxuZnVuY3Rpb24gdW5pbnN0YWxsUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiVW5pbnN0YWxsIENvZGV4KytcIixcbiAgICBcIkNvcGllcyB0aGUgdW5pbnN0YWxsIGNvbW1hbmQuIFJ1biBpdCBmcm9tIGEgdGVybWluYWwgYWZ0ZXIgcXVpdHRpbmcgQ29kZXguXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDb3B5IENvbW1hbmRcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpjb3B5LXRleHRcIiwgXCJub2RlIH4vLmNvZGV4LXBsdXNwbHVzL3NvdXJjZS9wYWNrYWdlcy9pbnN0YWxsZXIvZGlzdC9jbGkuanMgdW5pbnN0YWxsXCIpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNvcHkgdW5pbnN0YWxsIGNvbW1hbmQgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZXBvcnRCdWdSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJSZXBvcnQgYSBidWdcIixcbiAgICBcIk9wZW4gYSBHaXRIdWIgaXNzdWUgd2l0aCBydW50aW1lLCBpbnN0YWxsZXIsIG9yIHR3ZWFrLW1hbmFnZXIgZGV0YWlscy5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIk9wZW4gSXNzdWVcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgdGl0bGUgPSBlbmNvZGVVUklDb21wb25lbnQoXCJbQnVnXTogXCIpO1xuICAgICAgY29uc3QgYm9keSA9IGVuY29kZVVSSUNvbXBvbmVudChcbiAgICAgICAgW1xuICAgICAgICAgIFwiIyMgV2hhdCBoYXBwZW5lZD9cIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgU3RlcHMgdG8gcmVwcm9kdWNlXCIsXG4gICAgICAgICAgXCIxLiBcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgRW52aXJvbm1lbnRcIixcbiAgICAgICAgICBcIi0gQ29kZXgrKyB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gQ29kZXggYXBwIHZlcnNpb246IFwiLFxuICAgICAgICAgIFwiLSBPUzogXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIExvZ3NcIixcbiAgICAgICAgICBcIkF0dGFjaCByZWxldmFudCBsaW5lcyBmcm9tIHRoZSBDb2RleCsrIGxvZyBkaXJlY3RvcnkuXCIsXG4gICAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgICk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIixcbiAgICAgICAgYGh0dHBzOi8vZ2l0aHViLmNvbS9hZ3VzdGlmL2NvZGV4LXBsdXNwbHVzL2lzc3Vlcy9uZXc/dGl0bGU9JHt0aXRsZX0mYm9keT0ke2JvZHl9YCxcbiAgICAgICk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGFjdGlvblJvdyh0aXRsZVRleHQ6IHN0cmluZywgZGVzY3JpcHRpb246IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gdGl0bGVUZXh0O1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuZGF0YXNldC5jb2RleHBwUm93QWN0aW9ucyA9IFwidHJ1ZVwiO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZW5kZXJUd2Vha3NQYWdlKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgb3BlbkJ0biA9IG9wZW5JblBsYWNlQnV0dG9uKFwiT3BlbiBUd2Vha3MgRm9sZGVyXCIsICgpID0+IHtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6cmV2ZWFsXCIsIHR3ZWFrc1BhdGgoKSk7XG4gIH0pO1xuICBjb25zdCByZWxvYWRCdG4gPSBvcGVuSW5QbGFjZUJ1dHRvbihcIkZvcmNlIFJlbG9hZFwiLCAoKSA9PiB7XG4gICAgLy8gRnVsbCBwYWdlIHJlZnJlc2ggXHUyMDE0IHNhbWUgYXMgRGV2VG9vbHMgQ21kLVIgLyBvdXIgQ0RQIFBhZ2UucmVsb2FkLlxuICAgIC8vIE1haW4gcmUtZGlzY292ZXJzIHR3ZWFrcyBmaXJzdCBzbyB0aGUgbmV3IHJlbmRlcmVyIGNvbWVzIHVwIHdpdGggYVxuICAgIC8vIGZyZXNoIHR3ZWFrIHNldDsgdGhlbiBsb2NhdGlvbi5yZWxvYWQgcmVzdGFydHMgdGhlIHJlbmRlcmVyIHNvIHRoZVxuICAgIC8vIHByZWxvYWQgcmUtaW5pdGlhbGl6ZXMgYWdhaW5zdCBpdC5cbiAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAuaW52b2tlKFwiY29kZXhwcDpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJmb3JjZSByZWxvYWQgKG1haW4pIGZhaWxlZFwiLCBTdHJpbmcoZSkpKVxuICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICBsb2NhdGlvbi5yZWxvYWQoKTtcbiAgICAgIH0pO1xuICB9KTtcbiAgLy8gRHJvcCB0aGUgZGlhZ29uYWwtYXJyb3cgaWNvbiBmcm9tIHRoZSByZWxvYWQgYnV0dG9uIFx1MjAxNCBpdCBpbXBsaWVzIFwib3BlblxuICAvLyBvdXQgb2YgYXBwXCIgd2hpY2ggZG9lc24ndCBmaXQuIFJlcGxhY2UgaXRzIHRyYWlsaW5nIHN2ZyB3aXRoIGEgcmVmcmVzaC5cbiAgY29uc3QgcmVsb2FkU3ZnID0gcmVsb2FkQnRuLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIik7XG4gIGlmIChyZWxvYWRTdmcpIHtcbiAgICByZWxvYWRTdmcub3V0ZXJIVE1MID1cbiAgICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tMnhzXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgICBgPHBhdGggZD1cIk00IDEwYTYgNiAwIDAgMSAxMC4yNC00LjI0TDE2IDcuNU0xNiA0djMuNWgtMy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgICAgYDxwYXRoIGQ9XCJNMTYgMTBhNiA2IDAgMCAxLTEwLjI0IDQuMjRMNCAxMi41TTQgMTZ2LTMuNWgzLjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgICBgPC9zdmc+YDtcbiAgfVxuXG4gIGNvbnN0IHRyYWlsaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdHJhaWxpbmcuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICB0cmFpbGluZy5hcHBlbmRDaGlsZChyZWxvYWRCdG4pO1xuICB0cmFpbGluZy5hcHBlbmRDaGlsZChvcGVuQnRuKTtcblxuICBpZiAoc3RhdGUubGlzdGVkVHdlYWtzLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiSW5zdGFsbGVkIFR3ZWFrc1wiLCB0cmFpbGluZykpO1xuICAgIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoXG4gICAgICByb3dTaW1wbGUoXG4gICAgICAgIFwiTm8gdHdlYWtzIGluc3RhbGxlZFwiLFxuICAgICAgICBgRHJvcCBhIHR3ZWFrIGZvbGRlciBpbnRvICR7dHdlYWtzUGF0aCgpfSBhbmQgcmVsb2FkLmAsXG4gICAgICApLFxuICAgICk7XG4gICAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gR3JvdXAgcmVnaXN0ZXJlZCBTZXR0aW5nc1NlY3Rpb25zIGJ5IHR3ZWFrIGlkIChwcmVmaXggc3BsaXQgYXQgXCI6XCIpLlxuICBjb25zdCBzZWN0aW9uc0J5VHdlYWsgPSBuZXcgTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uW10+KCk7XG4gIGZvciAoY29uc3QgcyBvZiBzdGF0ZS5zZWN0aW9ucy52YWx1ZXMoKSkge1xuICAgIGNvbnN0IHR3ZWFrSWQgPSBzLmlkLnNwbGl0KFwiOlwiKVswXTtcbiAgICBpZiAoIXNlY3Rpb25zQnlUd2Vhay5oYXModHdlYWtJZCkpIHNlY3Rpb25zQnlUd2Vhay5zZXQodHdlYWtJZCwgW10pO1xuICAgIHNlY3Rpb25zQnlUd2Vhay5nZXQodHdlYWtJZCkhLnB1c2gocyk7XG4gIH1cblxuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHdyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiSW5zdGFsbGVkIFR3ZWFrc1wiLCB0cmFpbGluZykpO1xuXG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBmb3IgKGNvbnN0IHQgb2Ygc3RhdGUubGlzdGVkVHdlYWtzKSB7XG4gICAgY2FyZC5hcHBlbmRDaGlsZCh0d2Vha1Jvdyh0LCBzZWN0aW9uc0J5VHdlYWsuZ2V0KHQubWFuaWZlc3QuaWQpID8/IFtdKSk7XG4gIH1cbiAgd3JhcC5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHdyYXApO1xufVxuXG5mdW5jdGlvbiB0d2Vha1Jvdyh0OiBMaXN0ZWRUd2Vhaywgc2VjdGlvbnM6IFNldHRpbmdzU2VjdGlvbltdKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBtID0gdC5tYW5pZmVzdDtcblxuICAvLyBPdXRlciBjZWxsIHdyYXBzIHRoZSBoZWFkZXIgcm93ICsgKG9wdGlvbmFsKSBuZXN0ZWQgc2VjdGlvbnMgc28gdGhlXG4gIC8vIHBhcmVudCBjYXJkJ3MgZGl2aWRlciBzdGF5cyBiZXR3ZWVuICp0d2Vha3MqLCBub3QgYmV0d2VlbiBoZWFkZXIgYW5kXG4gIC8vIGJvZHkgb2YgdGhlIHNhbWUgdHdlYWsuXG4gIGNvbnN0IGNlbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjZWxsLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbFwiO1xuICBpZiAoIXQuZW5hYmxlZCkgY2VsbC5zdHlsZS5vcGFjaXR5ID0gXCIwLjdcIjtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcblxuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcblxuICAvLyBcdTI1MDBcdTI1MDAgQXZhdGFyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBhdmF0YXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhdmF0YXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgb3ZlcmZsb3ctaGlkZGVuIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgYXZhdGFyLnN0eWxlLndpZHRoID0gXCI1NnB4XCI7XG4gIGF2YXRhci5zdHlsZS5oZWlnaHQgPSBcIjU2cHhcIjtcbiAgYXZhdGFyLnN0eWxlLmJhY2tncm91bmRDb2xvciA9IFwidmFyKC0tY29sb3ItdG9rZW4tYmctZm9nLCB0cmFuc3BhcmVudClcIjtcbiAgaWYgKG0uaWNvblVybCkge1xuICAgIGNvbnN0IGltZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbWdcIik7XG4gICAgaW1nLmFsdCA9IFwiXCI7XG4gICAgaW1nLmNsYXNzTmFtZSA9IFwic2l6ZS1mdWxsIG9iamVjdC1jb250YWluXCI7XG4gICAgLy8gSW5pdGlhbDogc2hvdyBmYWxsYmFjayBpbml0aWFsIGluIGNhc2UgdGhlIGljb24gZmFpbHMgdG8gbG9hZC5cbiAgICBjb25zdCBpbml0aWFsID0gKG0ubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICAgIGNvbnN0IGZhbGxiYWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgZmFsbGJhY2suY2xhc3NOYW1lID0gXCJ0ZXh0LXhsIGZvbnQtbWVkaXVtXCI7XG4gICAgZmFsbGJhY2sudGV4dENvbnRlbnQgPSBpbml0aWFsO1xuICAgIGF2YXRhci5hcHBlbmRDaGlsZChmYWxsYmFjayk7XG4gICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICBpbWcuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgKCkgPT4ge1xuICAgICAgZmFsbGJhY2sucmVtb3ZlKCk7XG4gICAgICBpbWcuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgfSk7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICBpbWcucmVtb3ZlKCk7XG4gICAgfSk7XG4gICAgdm9pZCByZXNvbHZlSWNvblVybChtLmljb25VcmwsIHQuZGlyKS50aGVuKCh1cmwpID0+IHtcbiAgICAgIGlmICh1cmwpIGltZy5zcmMgPSB1cmw7XG4gICAgICBlbHNlIGltZy5yZW1vdmUoKTtcbiAgICB9KTtcbiAgICBhdmF0YXIuYXBwZW5kQ2hpbGQoaW1nKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBpbml0aWFsID0gKG0ubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICAgIGNvbnN0IHNwYW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBzcGFuLmNsYXNzTmFtZSA9IFwidGV4dC14bCBmb250LW1lZGl1bVwiO1xuICAgIHNwYW4udGV4dENvbnRlbnQgPSBpbml0aWFsO1xuICAgIGF2YXRhci5hcHBlbmRDaGlsZChzcGFuKTtcbiAgfVxuICBsZWZ0LmFwcGVuZENoaWxkKGF2YXRhcik7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRleHQgc3RhY2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTAuNVwiO1xuXG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmFtZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBuYW1lLnRleHRDb250ZW50ID0gbS5uYW1lO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZChuYW1lKTtcbiAgaWYgKG0udmVyc2lvbikge1xuICAgIGNvbnN0IHZlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHZlci5jbGFzc05hbWUgPVxuICAgICAgXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQteHMgZm9udC1ub3JtYWwgdGFidWxhci1udW1zXCI7XG4gICAgdmVyLnRleHRDb250ZW50ID0gYHYke20udmVyc2lvbn1gO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHZlcik7XG4gIH1cbiAgaWYgKHQudXBkYXRlPy51cGRhdGVBdmFpbGFibGUpIHtcbiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIGJhZGdlLmNsYXNzTmFtZSA9XG4gICAgICBcInJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wLjUgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICBiYWRnZS50ZXh0Q29udGVudCA9IFwiVXBkYXRlIEF2YWlsYWJsZVwiO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKGJhZGdlKTtcbiAgfVxuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZVJvdyk7XG5cbiAgaWYgKG0uZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgICBkZXNjLnRleHRDb250ZW50ID0gbS5kZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgfVxuXG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtZXRhLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGNvbnN0IGF1dGhvckVsID0gcmVuZGVyQXV0aG9yKG0uYXV0aG9yKTtcbiAgaWYgKGF1dGhvckVsKSBtZXRhLmFwcGVuZENoaWxkKGF1dGhvckVsKTtcbiAgaWYgKG0uZ2l0aHViUmVwbykge1xuICAgIGlmIChtZXRhLmNoaWxkcmVuLmxlbmd0aCA+IDApIG1ldGEuYXBwZW5kQ2hpbGQoZG90KCkpO1xuICAgIGNvbnN0IHJlcG8gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIHJlcG8udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgcmVwby5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gICAgcmVwby50ZXh0Q29udGVudCA9IG0uZ2l0aHViUmVwbztcbiAgICByZXBvLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsIGBodHRwczovL2dpdGh1Yi5jb20vJHttLmdpdGh1YlJlcG99YCk7XG4gICAgfSk7XG4gICAgbWV0YS5hcHBlbmRDaGlsZChyZXBvKTtcbiAgfVxuICBpZiAobS5ob21lcGFnZSkge1xuICAgIGlmIChtZXRhLmNoaWxkcmVuLmxlbmd0aCA+IDApIG1ldGEuYXBwZW5kQ2hpbGQoZG90KCkpO1xuICAgIGNvbnN0IGxpbmsgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICBsaW5rLmhyZWYgPSBtLmhvbWVwYWdlO1xuICAgIGxpbmsudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICBsaW5rLnJlbCA9IFwibm9yZWZlcnJlclwiO1xuICAgIGxpbmsuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCB0ZXh0LXRva2VuLXRleHQtbGluay1mb3JlZ3JvdW5kIGhvdmVyOnVuZGVybGluZVwiO1xuICAgIGxpbmsudGV4dENvbnRlbnQgPSBcIkhvbWVwYWdlXCI7XG4gICAgbWV0YS5hcHBlbmRDaGlsZChsaW5rKTtcbiAgfVxuICBpZiAobWV0YS5jaGlsZHJlbi5sZW5ndGggPiAwKSBzdGFjay5hcHBlbmRDaGlsZChtZXRhKTtcblxuICAvLyBUYWdzIHJvdyAoaWYgYW55KSBcdTIwMTQgc21hbGwgcGlsbCBjaGlwcyBiZWxvdyB0aGUgbWV0YSBsaW5lLlxuICBpZiAobS50YWdzICYmIG0udGFncy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgdGFnc1JvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgdGFnc1Jvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBnYXAtMSBwdC0wLjVcIjtcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBtLnRhZ3MpIHtcbiAgICAgIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIHBpbGwuY2xhc3NOYW1lID1cbiAgICAgICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQtWzExcHhdIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICAgIHBpbGwudGV4dENvbnRlbnQgPSB0YWc7XG4gICAgICB0YWdzUm93LmFwcGVuZENoaWxkKHBpbGwpO1xuICAgIH1cbiAgICBzdGFjay5hcHBlbmRDaGlsZCh0YWdzUm93KTtcbiAgfVxuXG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRvZ2dsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByaWdodC5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yIHB0LTAuNVwiO1xuICBpZiAodC51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSAmJiB0LnVwZGF0ZS5yZWxlYXNlVXJsKSB7XG4gICAgcmlnaHQuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiUmV2aWV3IFJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCB0LnVwZGF0ZSEucmVsZWFzZVVybCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIHJpZ2h0LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2wodC5lbmFibGVkLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpzZXQtdHdlYWstZW5hYmxlZFwiLCBtLmlkLCBuZXh0KTtcbiAgICAgIC8vIFRoZSBtYWluIHByb2Nlc3MgYnJvYWRjYXN0cyBhIHJlbG9hZCB3aGljaCB3aWxsIHJlLWZldGNoIHRoZSBsaXN0XG4gICAgICAvLyBhbmQgcmUtcmVuZGVyLiBXZSBkb24ndCBvcHRpbWlzdGljYWxseSB0b2dnbGUgdG8gYXZvaWQgZHJpZnQuXG4gICAgfSksXG4gICk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChyaWdodCk7XG5cbiAgY2VsbC5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIC8vIElmIHRoZSB0d2VhayBpcyBlbmFibGVkIGFuZCByZWdpc3RlcmVkIHNldHRpbmdzIHNlY3Rpb25zLCByZW5kZXIgdGhvc2VcbiAgLy8gYm9kaWVzIGFzIG5lc3RlZCByb3dzIGJlbmVhdGggdGhlIGhlYWRlciBpbnNpZGUgdGhlIHNhbWUgY2VsbC5cbiAgaWYgKHQuZW5hYmxlZCAmJiBzZWN0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgbmVzdGVkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBuZXN0ZWQuY2xhc3NOYW1lID1cbiAgICAgIFwiZmxleCBmbGV4LWNvbCBkaXZpZGUteS1bMC41cHhdIGRpdmlkZS10b2tlbi1ib3JkZXIgYm9yZGVyLXQtWzAuNXB4XSBib3JkZXItdG9rZW4tYm9yZGVyXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNlY3Rpb25zKSB7XG4gICAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJvZHkuY2xhc3NOYW1lID0gXCJwLTNcIjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHMucmVuZGVyKGJvZHkpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBib2R5LnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyB0d2VhayBzZWN0aW9uOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICB9XG4gICAgICBuZXN0ZWQuYXBwZW5kQ2hpbGQoYm9keSk7XG4gICAgfVxuICAgIGNlbGwuYXBwZW5kQ2hpbGQobmVzdGVkKTtcbiAgfVxuXG4gIHJldHVybiBjZWxsO1xufVxuXG5mdW5jdGlvbiByZW5kZXJBdXRob3IoYXV0aG9yOiBUd2Vha01hbmlmZXN0W1wiYXV0aG9yXCJdKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgaWYgKCFhdXRob3IpIHJldHVybiBudWxsO1xuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTFcIjtcbiAgaWYgKHR5cGVvZiBhdXRob3IgPT09IFwic3RyaW5nXCIpIHtcbiAgICB3cmFwLnRleHRDb250ZW50ID0gYGJ5ICR7YXV0aG9yfWA7XG4gICAgcmV0dXJuIHdyYXA7XG4gIH1cbiAgd3JhcC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShcImJ5IFwiKSk7XG4gIGlmIChhdXRob3IudXJsKSB7XG4gICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICAgIGEuaHJlZiA9IGF1dGhvci51cmw7XG4gICAgYS50YXJnZXQgPSBcIl9ibGFua1wiO1xuICAgIGEucmVsID0gXCJub3JlZmVycmVyXCI7XG4gICAgYS5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gICAgYS50ZXh0Q29udGVudCA9IGF1dGhvci5uYW1lO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoYSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgc3BhbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHNwYW4udGV4dENvbnRlbnQgPSBhdXRob3IubmFtZTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKHNwYW4pO1xuICB9XG4gIHJldHVybiB3cmFwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgY29tcG9uZW50cyBcdTI1MDBcdTI1MDBcblxuLyoqIFRoZSBmdWxsIHBhbmVsIHNoZWxsICh0b29sYmFyICsgc2Nyb2xsICsgaGVhZGluZyArIHNlY3Rpb25zIHdyYXApLiAqL1xuZnVuY3Rpb24gcGFuZWxTaGVsbChcbiAgdGl0bGU6IHN0cmluZyxcbiAgc3VidGl0bGU/OiBzdHJpbmcsXG4pOiB7IG91dGVyOiBIVE1MRWxlbWVudDsgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudDsgc3VidGl0bGU/OiBIVE1MRWxlbWVudCB9IHtcbiAgY29uc3Qgb3V0ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdXRlci5jbGFzc05hbWUgPSBcIm1haW4tc3VyZmFjZSBmbGV4IGgtZnVsbCBtaW4taC0wIGZsZXgtY29sXCI7XG5cbiAgY29uc3QgdG9vbGJhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvb2xiYXIuY2xhc3NOYW1lID1cbiAgICBcImRyYWdnYWJsZSBmbGV4IGl0ZW1zLWNlbnRlciBweC1wYW5lbCBlbGVjdHJvbjpoLXRvb2xiYXIgZXh0ZW5zaW9uOmgtdG9vbGJhci1zbVwiO1xuICBvdXRlci5hcHBlbmRDaGlsZCh0b29sYmFyKTtcblxuICBjb25zdCBzY3JvbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzY3JvbGwuY2xhc3NOYW1lID0gXCJmbGV4LTEgb3ZlcmZsb3cteS1hdXRvIHAtcGFuZWxcIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQoc2Nyb2xsKTtcblxuICBjb25zdCBpbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9XG4gICAgXCJteC1hdXRvIGZsZXggdy1mdWxsIGZsZXgtY29sIG1heC13LTJ4bCBlbGVjdHJvbjptaW4tdy1bY2FsYygzMjBweCp2YXIoLS1jb2RleC13aW5kb3ctem9vbSkpXVwiO1xuICBzY3JvbGwuYXBwZW5kQ2hpbGQoaW5uZXIpO1xuXG4gIGNvbnN0IGhlYWRlcldyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJXcmFwLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zIHBiLXBhbmVsXCI7XG4gIGNvbnN0IGhlYWRlcklubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVySW5uZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0xLjUgcGItcGFuZWxcIjtcbiAgY29uc3QgaGVhZGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRpbmcuY2xhc3NOYW1lID0gXCJlbGVjdHJvbjpoZWFkaW5nLWxnIGhlYWRpbmctYmFzZSB0cnVuY2F0ZVwiO1xuICBoZWFkaW5nLnRleHRDb250ZW50ID0gdGl0bGU7XG4gIGhlYWRlcklubmVyLmFwcGVuZENoaWxkKGhlYWRpbmcpO1xuICBsZXQgc3VidGl0bGVFbGVtZW50OiBIVE1MRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgaWYgKHN1YnRpdGxlKSB7XG4gICAgY29uc3Qgc3ViID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBzdWIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQtc21cIjtcbiAgICBzdWIudGV4dENvbnRlbnQgPSBzdWJ0aXRsZTtcbiAgICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZChzdWIpO1xuICAgIHN1YnRpdGxlRWxlbWVudCA9IHN1YjtcbiAgfVxuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlcklubmVyKTtcbiAgaW5uZXIuYXBwZW5kQ2hpbGQoaGVhZGVyV3JhcCk7XG5cbiAgY29uc3Qgc2VjdGlvbnNXcmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2VjdGlvbnNXcmFwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtW3ZhcigtLXBhZGRpbmctcGFuZWwpXVwiO1xuICBpbm5lci5hcHBlbmRDaGlsZChzZWN0aW9uc1dyYXApO1xuXG4gIHJldHVybiB7IG91dGVyLCBzZWN0aW9uc1dyYXAsIHN1YnRpdGxlOiBzdWJ0aXRsZUVsZW1lbnQgfTtcbn1cblxuZnVuY3Rpb24gc2VjdGlvblRpdGxlKHRleHQ6IHN0cmluZywgdHJhaWxpbmc/OiBIVE1MRWxlbWVudCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLXRvb2xiYXIgaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiBweC0wIHB5LTBcIjtcbiAgY29uc3QgdGl0bGVJbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlSW5uZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0LmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0aXRsZUlubmVyLmFwcGVuZENoaWxkKHQpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh0aXRsZUlubmVyKTtcbiAgaWYgKHRyYWlsaW5nKSB7XG4gICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJpZ2h0LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgICByaWdodC5hcHBlbmRDaGlsZCh0cmFpbGluZyk7XG4gICAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQocmlnaHQpO1xuICB9XG4gIHJldHVybiB0aXRsZVJvdztcbn1cblxuLyoqXG4gKiBDb2RleCdzIFwiT3BlbiBjb25maWcudG9tbFwiLXN0eWxlIHRyYWlsaW5nIGJ1dHRvbjogZ2hvc3QgYm9yZGVyLCBtdXRlZFxuICogbGFiZWwsIHRvcC1yaWdodCBkaWFnb25hbCBhcnJvdyBpY29uLiBNYXJrdXAgbWlycm9ycyBDb25maWd1cmF0aW9uIHBhbmVsLlxuICovXG5mdW5jdGlvbiBvcGVuSW5QbGFjZUJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIGJvcmRlciB3aGl0ZXNwYWNlLW5vd3JhcCBmb2N1czpvdXRsaW5lLW5vbmUgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDAgcm91bmRlZC1sZyB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGF0YS1bc3RhdGU9b3Blbl06YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGJvcmRlci10cmFuc3BhcmVudCBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciBweC0yIHB5LTAgdGV4dC1iYXNlIGxlYWRpbmctWzE4cHhdXCI7XG4gIGJ0bi5pbm5lckhUTUwgPVxuICAgIGAke2xhYmVsfWAgK1xuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tMnhzXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTQuMzM0OSAxMy4zMzAxVjYuNjA2NDVMNS40NzA2NSAxNS40NzA3QzUuMjEwOTUgMTUuNzMwNCA0Ljc4ODk1IDE1LjczMDQgNC41MjkyNSAxNS40NzA3QzQuMjY5NTUgMTUuMjExIDQuMjY5NTUgMTQuNzg5IDQuNTI5MjUgMTQuNTI5M0wxMy4zOTM1IDUuNjY1MDRINi42NjAxMUM2LjI5Mjg0IDUuNjY1MDQgNS45OTUwNyA1LjM2NzI3IDUuOTk1MDcgNUM1Ljk5NTA3IDQuNjMyNzMgNi4yOTI4NCA0LjMzNDk2IDYuNjYwMTEgNC4zMzQ5NkgxNC45OTk5TDE1LjEzMzcgNC4zNDg2M0MxNS40MzY5IDQuNDEwNTcgMTUuNjY1IDQuNjc4NTcgMTUuNjY1IDVWMTMuMzMwMUMxNS42NjQ5IDEzLjY5NzMgMTUuMzY3MiAxMy45OTUxIDE0Ljk5OTkgMTMuOTk1MUMxNC42MzI3IDEzLjk5NTEgMTQuMzM1IDEzLjY5NzMgMTQuMzM0OSAxMy4zMzAxWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIj48L3BhdGg+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0QnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uQ2xpY2s6ICgpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBweC0yIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnkgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIjtcbiAgYnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiByb3VuZGVkQ2FyZCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIGZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIHJvdW5kZWQtbGcgYm9yZGVyXCI7XG4gIGNhcmQuc2V0QXR0cmlidXRlKFxuICAgIFwic3R5bGVcIixcbiAgICBcImJhY2tncm91bmQtY29sb3I6IHZhcigtLWNvbG9yLWJhY2tncm91bmQtcGFuZWwsIHZhcigtLWNvbG9yLXRva2VuLWJnLWZvZykpO1wiLFxuICApO1xuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gcm93U2ltcGxlKHRpdGxlOiBzdHJpbmcgfCB1bmRlZmluZWQsIGRlc2NyaXB0aW9uPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciBnYXAtM1wiO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGlmICh0aXRsZSkge1xuICAgIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHQuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICB0LnRleHRDb250ZW50ID0gdGl0bGU7XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQodCk7XG4gIH1cbiAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZC5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gICAgZC50ZXh0Q29udGVudCA9IGRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGQpO1xuICB9XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIHJldHVybiByb3c7XG59XG5cbi8qKlxuICogQ29kZXgtc3R5bGVkIHRvZ2dsZSBzd2l0Y2guIE1hcmt1cCBtaXJyb3JzIHRoZSBHZW5lcmFsID4gUGVybWlzc2lvbnMgcm93XG4gKiBzd2l0Y2ggd2UgY2FwdHVyZWQ6IG91dGVyIGJ1dHRvbiAocm9sZT1zd2l0Y2gpLCBpbm5lciBwaWxsLCBzbGlkaW5nIGtub2IuXG4gKi9cbmZ1bmN0aW9uIHN3aXRjaENvbnRyb2woXG4gIGluaXRpYWw6IGJvb2xlYW4sXG4gIG9uQ2hhbmdlOiAobmV4dDogYm9vbGVhbikgPT4gdm9pZCB8IFByb21pc2U8dm9pZD4sXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJzd2l0Y2hcIik7XG5cbiAgY29uc3QgcGlsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCBrbm9iID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGtub2IuY2xhc3NOYW1lID1cbiAgICBcInJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLVtjb2xvcjp2YXIoLS1ncmF5LTApXSBiZy1bY29sb3I6dmFyKC0tZ3JheS0wKV0gc2hhZG93LXNtIHRyYW5zaXRpb24tdHJhbnNmb3JtIGR1cmF0aW9uLTIwMCBlYXNlLW91dCBoLTQgdy00XCI7XG4gIHBpbGwuYXBwZW5kQ2hpbGQoa25vYik7XG5cbiAgY29uc3QgYXBwbHkgPSAob246IGJvb2xlYW4pOiB2b2lkID0+IHtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jaGVja2VkXCIsIFN0cmluZyhvbikpO1xuICAgIGJ0bi5kYXRhc2V0LnN0YXRlID0gb24gPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCI7XG4gICAgYnRuLmNsYXNzTmFtZSA9XG4gICAgICBcImlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXIgZm9jdXMtdmlzaWJsZTpyb3VuZGVkLWZ1bGwgY3Vyc29yLWludGVyYWN0aW9uXCI7XG4gICAgcGlsbC5jbGFzc05hbWUgPSBgcmVsYXRpdmUgaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCB0cmFuc2l0aW9uLWNvbG9ycyBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC01IHctOCAke1xuICAgICAgb24gPyBcImJnLXRva2VuLWNoYXJ0cy1ibHVlXCIgOiBcImJnLXRva2VuLWZvcmVncm91bmQvMjBcIlxuICAgIH1gO1xuICAgIHBpbGwuZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGtub2IuZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGtub2Iuc3R5bGUudHJhbnNmb3JtID0gb24gPyBcInRyYW5zbGF0ZVgoMTRweClcIiA6IFwidHJhbnNsYXRlWCgycHgpXCI7XG4gIH07XG4gIGFwcGx5KGluaXRpYWwpO1xuXG4gIGJ0bi5hcHBlbmRDaGlsZChwaWxsKTtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGNvbnN0IG5leHQgPSBidG4uZ2V0QXR0cmlidXRlKFwiYXJpYS1jaGVja2VkXCIpICE9PSBcInRydWVcIjtcbiAgICBhcHBseShuZXh0KTtcbiAgICBidG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBvbkNoYW5nZShuZXh0KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgYnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gZG90KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBzLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIHMudGV4dENvbnRlbnQgPSBcIlx1MDBCN1wiO1xuICByZXR1cm4gcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGljb25zIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjb25maWdJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNsaWRlcnMgLyBzZXR0aW5ncyBnbHlwaC4gMjB4MjAgY3VycmVudENvbG9yLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTMgNWg5TTE1IDVoMk0zIDEwaDJNOCAxMGg5TTMgMTVoMTFNMTcgMTVoMFwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxM1wiIGN5PVwiNVwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiNlwiIGN5PVwiMTBcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjE1XCIgY3k9XCIxNVwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc0ljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gU3BhcmtsZXMgLyBcIisrXCIgZ2x5cGggZm9yIHR3ZWFrcy5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0xMCAyLjUgTDExLjQgOC42IEwxNy41IDEwIEwxMS40IDExLjQgTDEwIDE3LjUgTDguNiAxMS40IEwyLjUgMTAgTDguNiA4LjYgWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTUuNSAzIEwxNiA1IEwxOCA1LjUgTDE2IDYgTDE1LjUgOCBMMTUgNiBMMTMgNS41IEwxNSA1IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIgb3BhY2l0eT1cIjAuN1wiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0UGFnZUljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gRG9jdW1lbnQvcGFnZSBnbHlwaCBmb3IgdHdlYWstcmVnaXN0ZXJlZCBwYWdlcyB3aXRob3V0IHRoZWlyIG93biBpY29uLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTUgM2g3bDMgM3YxMWExIDEgMCAwIDEtMSAxSDVhMSAxIDAgMCAxLTEtMVY0YTEgMSAwIDAgMSAxLTFaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTIgM3YzYTEgMSAwIDAgMCAxIDFoMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcgMTFoNk03IDE0aDRcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVJY29uVXJsKFxuICB1cmw6IHN0cmluZyxcbiAgdHdlYWtEaXI6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoL14oaHR0cHM/OnxkYXRhOikvLnRlc3QodXJsKSkgcmV0dXJuIHVybDtcbiAgLy8gUmVsYXRpdmUgcGF0aCBcdTIxOTIgYXNrIG1haW4gdG8gcmVhZCB0aGUgZmlsZSBhbmQgcmV0dXJuIGEgZGF0YTogVVJMLlxuICAvLyBSZW5kZXJlciBpcyBzYW5kYm94ZWQgc28gZmlsZTovLyB3b24ndCBsb2FkIGRpcmVjdGx5LlxuICBjb25zdCByZWwgPSB1cmwuc3RhcnRzV2l0aChcIi4vXCIpID8gdXJsLnNsaWNlKDIpIDogdXJsO1xuICB0cnkge1xuICAgIHJldHVybiAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJjb2RleHBwOnJlYWQtdHdlYWstYXNzZXRcIixcbiAgICAgIHR3ZWFrRGlyLFxuICAgICAgcmVsLFxuICAgICkpIGFzIHN0cmluZztcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJpY29uIGxvYWQgZmFpbGVkXCIsIHsgdXJsLCB0d2Vha0RpciwgZXJyOiBTdHJpbmcoZSkgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIERPTSBoZXVyaXN0aWNzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgLy8gQW5jaG9yIHN0cmF0ZWd5IGZpcnN0ICh3b3VsZCBiZSBpZGVhbCBpZiBDb2RleCBzd2l0Y2hlcyB0byA8YT4pLlxuICBjb25zdCBsaW5rcyA9IEFycmF5LmZyb20oXG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQW5jaG9yRWxlbWVudD4oXCJhW2hyZWYqPScvc2V0dGluZ3MvJ11cIiksXG4gICk7XG4gIGlmIChsaW5rcy5sZW5ndGggPj0gMikge1xuICAgIGxldCBub2RlOiBIVE1MRWxlbWVudCB8IG51bGwgPSBsaW5rc1swXS5wYXJlbnRFbGVtZW50O1xuICAgIHdoaWxlIChub2RlKSB7XG4gICAgICBjb25zdCBpbnNpZGUgPSBub2RlLnF1ZXJ5U2VsZWN0b3JBbGwoXCJhW2hyZWYqPScvc2V0dGluZ3MvJ11cIik7XG4gICAgICBpZiAoaW5zaWRlLmxlbmd0aCA+PSBNYXRoLm1heCgyLCBsaW5rcy5sZW5ndGggLSAxKSkgcmV0dXJuIG5vZGU7XG4gICAgICBub2RlID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICAgIH1cbiAgfVxuXG4gIC8vIFRleHQtY29udGVudCBtYXRjaCBhZ2FpbnN0IENvZGV4J3Mga25vd24gc2lkZWJhciBsYWJlbHMuXG4gIGNvbnN0IEtOT1dOID0gW1xuICAgIFwiR2VuZXJhbFwiLFxuICAgIFwiQXBwZWFyYW5jZVwiLFxuICAgIFwiQ29uZmlndXJhdGlvblwiLFxuICAgIFwiUGVyc29uYWxpemF0aW9uXCIsXG4gICAgXCJNQ1Agc2VydmVyc1wiLFxuICAgIFwiTUNQIFNlcnZlcnNcIixcbiAgICBcIkdpdFwiLFxuICAgIFwiRW52aXJvbm1lbnRzXCIsXG4gIF07XG4gIGNvbnN0IG1hdGNoZXM6IEhUTUxFbGVtZW50W10gPSBbXTtcbiAgY29uc3QgYWxsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXG4gICAgXCJidXR0b24sIGEsIFtyb2xlPSdidXR0b24nXSwgbGksIGRpdlwiLFxuICApO1xuICBmb3IgKGNvbnN0IGVsIG9mIEFycmF5LmZyb20oYWxsKSkge1xuICAgIGNvbnN0IHQgPSAoZWwudGV4dENvbnRlbnQgPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICh0Lmxlbmd0aCA+IDMwKSBjb250aW51ZTtcbiAgICBpZiAoS05PV04uc29tZSgoaykgPT4gdCA9PT0gaykpIG1hdGNoZXMucHVzaChlbCk7XG4gICAgaWYgKG1hdGNoZXMubGVuZ3RoID4gNTApIGJyZWFrO1xuICB9XG4gIGlmIChtYXRjaGVzLmxlbmd0aCA+PSAyKSB7XG4gICAgbGV0IG5vZGU6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG1hdGNoZXNbMF0ucGFyZW50RWxlbWVudDtcbiAgICB3aGlsZSAobm9kZSkge1xuICAgICAgbGV0IGNvdW50ID0gMDtcbiAgICAgIGZvciAoY29uc3QgbSBvZiBtYXRjaGVzKSBpZiAobm9kZS5jb250YWlucyhtKSkgY291bnQrKztcbiAgICAgIGlmIChjb3VudCA+PSBNYXRoLm1pbigzLCBtYXRjaGVzLmxlbmd0aCkpIHJldHVybiBub2RlO1xuICAgICAgbm9kZSA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGZpbmRDb250ZW50QXJlYSgpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gIGlmICghc2lkZWJhcikgcmV0dXJuIG51bGw7XG4gIGxldCBwYXJlbnQgPSBzaWRlYmFyLnBhcmVudEVsZW1lbnQ7XG4gIHdoaWxlIChwYXJlbnQpIHtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20ocGFyZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBpZiAoY2hpbGQgPT09IHNpZGViYXIgfHwgY2hpbGQuY29udGFpbnMoc2lkZWJhcikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgciA9IGNoaWxkLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgaWYgKHIud2lkdGggPiAzMDAgJiYgci5oZWlnaHQgPiAyMDApIHJldHVybiBjaGlsZDtcbiAgICB9XG4gICAgcGFyZW50ID0gcGFyZW50LnBhcmVudEVsZW1lbnQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG1heWJlRHVtcERvbSgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gICAgaWYgKHNpZGViYXIgJiYgIXN0YXRlLnNpZGViYXJEdW1wZWQpIHtcbiAgICAgIHN0YXRlLnNpZGViYXJEdW1wZWQgPSB0cnVlO1xuICAgICAgY29uc3Qgc2JSb290ID0gc2lkZWJhci5wYXJlbnRFbGVtZW50ID8/IHNpZGViYXI7XG4gICAgICBwbG9nKGBjb2RleCBzaWRlYmFyIEhUTUxgLCBzYlJvb3Qub3V0ZXJIVE1MLnNsaWNlKDAsIDMyMDAwKSk7XG4gICAgfVxuICAgIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgICBpZiAoIWNvbnRlbnQpIHtcbiAgICAgIGlmIChzdGF0ZS5maW5nZXJwcmludCAhPT0gbG9jYXRpb24uaHJlZikge1xuICAgICAgICBzdGF0ZS5maW5nZXJwcmludCA9IGxvY2F0aW9uLmhyZWY7XG4gICAgICAgIHBsb2coXCJkb20gcHJvYmUgKG5vIGNvbnRlbnQpXCIsIHtcbiAgICAgICAgICB1cmw6IGxvY2F0aW9uLmhyZWYsXG4gICAgICAgICAgc2lkZWJhcjogc2lkZWJhciA/IGRlc2NyaWJlKHNpZGViYXIpIDogbnVsbCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGxldCBwYW5lbDogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20oY29udGVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgaWYgKGNoaWxkLmRhdGFzZXQuY29kZXhwcCA9PT0gXCJ0d2Vha3MtcGFuZWxcIikgY29udGludWU7XG4gICAgICBpZiAoY2hpbGQuc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIpIGNvbnRpbnVlO1xuICAgICAgcGFuZWwgPSBjaGlsZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjb25zdCBhY3RpdmVOYXYgPSBzaWRlYmFyXG4gICAgICA/IEFycmF5LmZyb20oc2lkZWJhci5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcImJ1dHRvbiwgYVwiKSkuZmluZChcbiAgICAgICAgICAoYikgPT5cbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpID09PSBcInBhZ2VcIiB8fFxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFjdGl2ZVwiKSA9PT0gXCJ0cnVlXCIgfHxcbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiKSA9PT0gXCJ0cnVlXCIgfHxcbiAgICAgICAgICAgIGIuY2xhc3NMaXN0LmNvbnRhaW5zKFwiYWN0aXZlXCIpLFxuICAgICAgICApXG4gICAgICA6IG51bGw7XG4gICAgY29uc3QgaGVhZGluZyA9IHBhbmVsPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcbiAgICAgIFwiaDEsIGgyLCBoMywgW2NsYXNzKj0naGVhZGluZyddXCIsXG4gICAgKTtcbiAgICBjb25zdCBmaW5nZXJwcmludCA9IGAke2FjdGl2ZU5hdj8udGV4dENvbnRlbnQgPz8gXCJcIn18JHtoZWFkaW5nPy50ZXh0Q29udGVudCA/PyBcIlwifXwke3BhbmVsPy5jaGlsZHJlbi5sZW5ndGggPz8gMH1gO1xuICAgIGlmIChzdGF0ZS5maW5nZXJwcmludCA9PT0gZmluZ2VycHJpbnQpIHJldHVybjtcbiAgICBzdGF0ZS5maW5nZXJwcmludCA9IGZpbmdlcnByaW50O1xuICAgIHBsb2coXCJkb20gcHJvYmVcIiwge1xuICAgICAgdXJsOiBsb2NhdGlvbi5ocmVmLFxuICAgICAgYWN0aXZlTmF2OiBhY3RpdmVOYXY/LnRleHRDb250ZW50Py50cmltKCkgPz8gbnVsbCxcbiAgICAgIGhlYWRpbmc6IGhlYWRpbmc/LnRleHRDb250ZW50Py50cmltKCkgPz8gbnVsbCxcbiAgICAgIGNvbnRlbnQ6IGRlc2NyaWJlKGNvbnRlbnQpLFxuICAgIH0pO1xuICAgIGlmIChwYW5lbCkge1xuICAgICAgY29uc3QgaHRtbCA9IHBhbmVsLm91dGVySFRNTDtcbiAgICAgIHBsb2coXG4gICAgICAgIGBjb2RleCBwYW5lbCBIVE1MICgke2FjdGl2ZU5hdj8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBcIj9cIn0pYCxcbiAgICAgICAgaHRtbC5zbGljZSgwLCAzMjAwMCksXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJkb20gcHJvYmUgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZGVzY3JpYmUoZWw6IEhUTUxFbGVtZW50KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4ge1xuICAgIHRhZzogZWwudGFnTmFtZSxcbiAgICBjbHM6IGVsLmNsYXNzTmFtZS5zbGljZSgwLCAxMjApLFxuICAgIGlkOiBlbC5pZCB8fCB1bmRlZmluZWQsXG4gICAgY2hpbGRyZW46IGVsLmNoaWxkcmVuLmxlbmd0aCxcbiAgICByZWN0OiAoKCkgPT4ge1xuICAgICAgY29uc3QgciA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgcmV0dXJuIHsgdzogTWF0aC5yb3VuZChyLndpZHRoKSwgaDogTWF0aC5yb3VuZChyLmhlaWdodCkgfTtcbiAgICB9KSgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha3NQYXRoKCk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19jb2RleHBwX3R3ZWFrc19kaXJfXz86IHN0cmluZyB9KS5fX2NvZGV4cHBfdHdlYWtzX2Rpcl9fID8/XG4gICAgXCI8dXNlciBkaXI+L3R3ZWFrc1wiXG4gICk7XG59XG4iLCAiLyoqXG4gKiBSZW5kZXJlci1zaWRlIHR3ZWFrIGhvc3QuIFdlOlxuICogICAxLiBBc2sgbWFpbiBmb3IgdGhlIHR3ZWFrIGxpc3QgKHdpdGggcmVzb2x2ZWQgZW50cnkgcGF0aCkuXG4gKiAgIDIuIEZvciBlYWNoIHJlbmRlcmVyLXNjb3BlZCAob3IgXCJib3RoXCIpIHR3ZWFrLCBmZXRjaCBpdHMgc291cmNlIHZpYSBJUENcbiAqICAgICAgYW5kIGV4ZWN1dGUgaXQgYXMgYSBDb21tb25KUy1zaGFwZWQgZnVuY3Rpb24uXG4gKiAgIDMuIFByb3ZpZGUgaXQgdGhlIHJlbmRlcmVyIGhhbGYgb2YgdGhlIEFQSS5cbiAqXG4gKiBDb2RleCBydW5zIHRoZSByZW5kZXJlciB3aXRoIHNhbmRib3g6IHRydWUsIHNvIE5vZGUncyBgcmVxdWlyZSgpYCBpc1xuICogcmVzdHJpY3RlZCB0byBhIHRpbnkgd2hpdGVsaXN0IChlbGVjdHJvbiArIGEgZmV3IHBvbHlmaWxscykuIFRoYXQgbWVhbnMgd2VcbiAqIGNhbm5vdCBgcmVxdWlyZSgpYCBhcmJpdHJhcnkgdHdlYWsgZmlsZXMgZnJvbSBkaXNrLiBJbnN0ZWFkIHdlIHB1bGwgdGhlXG4gKiBzb3VyY2Ugc3RyaW5nIGZyb20gbWFpbiBhbmQgZXZhbHVhdGUgaXQgd2l0aCBgbmV3IEZ1bmN0aW9uYCBpbnNpZGUgdGhlXG4gKiBwcmVsb2FkIGNvbnRleHQuIFR3ZWFrIGF1dGhvcnMgd2hvIG5lZWQgbnBtIGRlcHMgbXVzdCBidW5kbGUgdGhlbSBpbi5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJTZWN0aW9uLCByZWdpc3RlclBhZ2UsIGNsZWFyU2VjdGlvbnMsIHNldExpc3RlZFR3ZWFrcyB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5pbXBvcnQgeyBmaWJlckZvck5vZGUgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgdHlwZSB7XG4gIFR3ZWFrTWFuaWZlc3QsXG4gIFR3ZWFrQXBpLFxuICBSZWFjdEZpYmVyTm9kZSxcbiAgVHdlYWssXG59IGZyb20gXCJAY29kZXgtcGx1c3BsdXMvc2RrXCI7XG5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHVwZGF0ZToge1xuICAgIGNoZWNrZWRBdDogc3RyaW5nO1xuICAgIHJlcG86IHN0cmluZztcbiAgICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICAgIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gICAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gICAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFVzZXJQYXRocyB7XG4gIHVzZXJSb290OiBzdHJpbmc7XG4gIHJ1bnRpbWVEaXI6IHN0cmluZztcbiAgdHdlYWtzRGlyOiBzdHJpbmc7XG4gIGxvZ0Rpcjogc3RyaW5nO1xufVxuXG5jb25zdCBsb2FkZWQgPSBuZXcgTWFwPHN0cmluZywgeyBzdG9wPzogKCkgPT4gdm9pZCB9PigpO1xubGV0IGNhY2hlZFBhdGhzOiBVc2VyUGF0aHMgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0VHdlYWtIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0d2Vha3MgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpsaXN0LXR3ZWFrc1wiKSkgYXMgTGlzdGVkVHdlYWtbXTtcbiAgY29uc3QgcGF0aHMgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp1c2VyLXBhdGhzXCIpKSBhcyBVc2VyUGF0aHM7XG4gIGNhY2hlZFBhdGhzID0gcGF0aHM7XG4gIC8vIFB1c2ggdGhlIGxpc3QgdG8gdGhlIHNldHRpbmdzIGluamVjdG9yIHNvIHRoZSBUd2Vha3MgcGFnZSBjYW4gcmVuZGVyXG4gIC8vIGNhcmRzIGV2ZW4gYmVmb3JlIGFueSB0d2VhaydzIHN0YXJ0KCkgcnVucyAoYW5kIGZvciBkaXNhYmxlZCB0d2Vha3NcbiAgLy8gdGhhdCB3ZSBuZXZlciBsb2FkKS5cbiAgc2V0TGlzdGVkVHdlYWtzKHR3ZWFrcyk7XG4gIC8vIFN0YXNoIGZvciB0aGUgc2V0dGluZ3MgaW5qZWN0b3IncyBlbXB0eS1zdGF0ZSBtZXNzYWdlLlxuICAod2luZG93IGFzIHVua25vd24gYXMgeyBfX2NvZGV4cHBfdHdlYWtzX2Rpcl9fPzogc3RyaW5nIH0pLl9fY29kZXhwcF90d2Vha3NfZGlyX18gPVxuICAgIHBhdGhzLnR3ZWFrc0RpcjtcblxuICBmb3IgKGNvbnN0IHQgb2YgdHdlYWtzKSB7XG4gICAgaWYgKHQubWFuaWZlc3Quc2NvcGUgPT09IFwibWFpblwiKSBjb250aW51ZTtcbiAgICBpZiAoIXQuZW50cnlFeGlzdHMpIGNvbnRpbnVlO1xuICAgIGlmICghdC5lbmFibGVkKSBjb250aW51ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgbG9hZFR3ZWFrKHQsIHBhdGhzKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSB0d2VhayBsb2FkIGZhaWxlZDpcIiwgdC5tYW5pZmVzdC5pZCwgZSk7XG4gICAgfVxuICB9XG5cbiAgY29uc29sZS5pbmZvKFxuICAgIGBbY29kZXgtcGx1c3BsdXNdIHJlbmRlcmVyIGhvc3QgbG9hZGVkICR7bG9hZGVkLnNpemV9IHR3ZWFrKHMpOmAsXG4gICAgWy4uLmxvYWRlZC5rZXlzKCldLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwiLFxuICApO1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGByZW5kZXJlciBob3N0IGxvYWRlZCAke2xvYWRlZC5zaXplfSB0d2VhayhzKTogJHtbLi4ubG9hZGVkLmtleXMoKV0uam9pbihcIiwgXCIpIHx8IFwiKG5vbmUpXCJ9YCxcbiAgKTtcbn1cblxuLyoqXG4gKiBTdG9wIGV2ZXJ5IHJlbmRlcmVyLXNjb3BlIHR3ZWFrIHNvIGEgc3Vic2VxdWVudCBgc3RhcnRUd2Vha0hvc3QoKWAgd2lsbFxuICogcmUtZXZhbHVhdGUgZnJlc2ggc291cmNlLiBNb2R1bGUgY2FjaGUgaXNuJ3QgcmVsZXZhbnQgc2luY2Ugd2UgZXZhbFxuICogc291cmNlIHN0cmluZ3MgZGlyZWN0bHkgXHUyMDE0IGVhY2ggbG9hZCBjcmVhdGVzIGEgZnJlc2ggc2NvcGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0ZWFyZG93blR3ZWFrSG9zdCgpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBbaWQsIHRdIG9mIGxvYWRlZCkge1xuICAgIHRyeSB7XG4gICAgICB0LnN0b3A/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihcIltjb2RleC1wbHVzcGx1c10gdHdlYWsgc3RvcCBmYWlsZWQ6XCIsIGlkLCBlKTtcbiAgICB9XG4gIH1cbiAgbG9hZGVkLmNsZWFyKCk7XG4gIGNsZWFyU2VjdGlvbnMoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFR3ZWFrKHQ6IExpc3RlZFR3ZWFrLCBwYXRoczogVXNlclBhdGhzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNvdXJjZSA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgXCJjb2RleHBwOnJlYWQtdHdlYWstc291cmNlXCIsXG4gICAgdC5lbnRyeSxcbiAgKSkgYXMgc3RyaW5nO1xuXG4gIC8vIEV2YWx1YXRlIGFzIENKUy1zaGFwZWQ6IHByb3ZpZGUgbW9kdWxlL2V4cG9ydHMvYXBpLiBUd2VhayBjb2RlIG1heSB1c2VcbiAgLy8gYG1vZHVsZS5leHBvcnRzID0geyBzdGFydCwgc3RvcCB9YCBvciBgZXhwb3J0cy5zdGFydCA9IC4uLmAgb3IgcHVyZSBFU01cbiAgLy8gZGVmYXVsdCBleHBvcnQgc2hhcGUgKHdlIGFjY2VwdCBib3RoKS5cbiAgY29uc3QgbW9kdWxlID0geyBleHBvcnRzOiB7fSBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWsgfTtcbiAgY29uc3QgZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzO1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWltcGxpZWQtZXZhbCwgbm8tbmV3LWZ1bmNcbiAgY29uc3QgZm4gPSBuZXcgRnVuY3Rpb24oXG4gICAgXCJtb2R1bGVcIixcbiAgICBcImV4cG9ydHNcIixcbiAgICBcImNvbnNvbGVcIixcbiAgICBgJHtzb3VyY2V9XFxuLy8jIHNvdXJjZVVSTD1jb2RleHBwLXR3ZWFrOi8vJHtlbmNvZGVVUklDb21wb25lbnQodC5tYW5pZmVzdC5pZCl9LyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQuZW50cnkpfWAsXG4gICk7XG4gIGZuKG1vZHVsZSwgZXhwb3J0cywgY29uc29sZSk7XG4gIGNvbnN0IG1vZCA9IG1vZHVsZS5leHBvcnRzIGFzIHsgZGVmYXVsdD86IFR3ZWFrIH0gJiBUd2VhaztcbiAgY29uc3QgdHdlYWs6IFR3ZWFrID0gKG1vZCBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9KS5kZWZhdWx0ID8/IChtb2QgYXMgVHdlYWspO1xuICBpZiAodHlwZW9mIHR3ZWFrPy5zdGFydCAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGB0d2VhayAke3QubWFuaWZlc3QuaWR9IGhhcyBubyBzdGFydCgpYCk7XG4gIH1cbiAgY29uc3QgYXBpID0gbWFrZVJlbmRlcmVyQXBpKHQubWFuaWZlc3QsIHBhdGhzKTtcbiAgYXdhaXQgdHdlYWsuc3RhcnQoYXBpKTtcbiAgbG9hZGVkLnNldCh0Lm1hbmlmZXN0LmlkLCB7IHN0b3A6IHR3ZWFrLnN0b3A/LmJpbmQodHdlYWspIH0pO1xufVxuXG5mdW5jdGlvbiBtYWtlUmVuZGVyZXJBcGkobWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3QsIHBhdGhzOiBVc2VyUGF0aHMpOiBUd2Vha0FwaSB7XG4gIGNvbnN0IGlkID0gbWFuaWZlc3QuaWQ7XG4gIGNvbnN0IGxvZyA9IChsZXZlbDogXCJkZWJ1Z1wiIHwgXCJpbmZvXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiwgLi4uYTogdW5rbm93bltdKSA9PiB7XG4gICAgY29uc3QgY29uc29sZUZuID1cbiAgICAgIGxldmVsID09PSBcImRlYnVnXCIgPyBjb25zb2xlLmRlYnVnXG4gICAgICA6IGxldmVsID09PSBcIndhcm5cIiA/IGNvbnNvbGUud2FyblxuICAgICAgOiBsZXZlbCA9PT0gXCJlcnJvclwiID8gY29uc29sZS5lcnJvclxuICAgICAgOiBjb25zb2xlLmxvZztcbiAgICBjb25zb2xlRm4oYFtjb2RleC1wbHVzcGx1c11bJHtpZH1dYCwgLi4uYSk7XG4gICAgLy8gQWxzbyBtaXJyb3IgdG8gbWFpbidzIGxvZyBmaWxlIHNvIHdlIGNhbiBkaWFnbm9zZSB0d2VhayBiZWhhdmlvclxuICAgIC8vIHdpdGhvdXQgYXR0YWNoaW5nIERldlRvb2xzLiBTdHJpbmdpZnkgZWFjaCBhcmcgZGVmZW5zaXZlbHkuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcnRzID0gYS5tYXAoKHYpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2ID09PSBcInN0cmluZ1wiKSByZXR1cm4gdjtcbiAgICAgICAgaWYgKHYgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIGAke3YubmFtZX06ICR7di5tZXNzYWdlfWA7XG4gICAgICAgIHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSh2KTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcodik7IH1cbiAgICAgIH0pO1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICAgICAgXCJjb2RleHBwOnByZWxvYWQtbG9nXCIsXG4gICAgICAgIGxldmVsLFxuICAgICAgICBgW3R3ZWFrICR7aWR9XSAke3BhcnRzLmpvaW4oXCIgXCIpfWAsXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc3dhbGxvdyBcdTIwMTQgbmV2ZXIgbGV0IGxvZ2dpbmcgYnJlYWsgYSB0d2VhayAqL1xuICAgIH1cbiAgfTtcblxuICByZXR1cm4ge1xuICAgIG1hbmlmZXN0LFxuICAgIHByb2Nlc3M6IFwicmVuZGVyZXJcIixcbiAgICBsb2c6IHtcbiAgICAgIGRlYnVnOiAoLi4uYSkgPT4gbG9nKFwiZGVidWdcIiwgLi4uYSksXG4gICAgICBpbmZvOiAoLi4uYSkgPT4gbG9nKFwiaW5mb1wiLCAuLi5hKSxcbiAgICAgIHdhcm46ICguLi5hKSA9PiBsb2coXCJ3YXJuXCIsIC4uLmEpLFxuICAgICAgZXJyb3I6ICguLi5hKSA9PiBsb2coXCJlcnJvclwiLCAuLi5hKSxcbiAgICB9LFxuICAgIHN0b3JhZ2U6IHJlbmRlcmVyU3RvcmFnZShpZCksXG4gICAgc2V0dGluZ3M6IHtcbiAgICAgIHJlZ2lzdGVyOiAocykgPT4gcmVnaXN0ZXJTZWN0aW9uKHsgLi4ucywgaWQ6IGAke2lkfToke3MuaWR9YCB9KSxcbiAgICAgIHJlZ2lzdGVyUGFnZTogKHApID0+XG4gICAgICAgIHJlZ2lzdGVyUGFnZShpZCwgbWFuaWZlc3QsIHsgLi4ucCwgaWQ6IGAke2lkfToke3AuaWR9YCB9KSxcbiAgICB9LFxuICAgIHJlYWN0OiB7XG4gICAgICBnZXRGaWJlcjogKG4pID0+IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGwsXG4gICAgICBmaW5kT3duZXJCeU5hbWU6IChuLCBuYW1lKSA9PiB7XG4gICAgICAgIGxldCBmID0gZmliZXJGb3JOb2RlKG4pIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbDtcbiAgICAgICAgd2hpbGUgKGYpIHtcbiAgICAgICAgICBjb25zdCB0ID0gZi50eXBlIGFzIHsgZGlzcGxheU5hbWU/OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB8IG51bGw7XG4gICAgICAgICAgaWYgKHQgJiYgKHQuZGlzcGxheU5hbWUgPT09IG5hbWUgfHwgdC5uYW1lID09PSBuYW1lKSkgcmV0dXJuIGY7XG4gICAgICAgICAgZiA9IGYucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfSxcbiAgICAgIHdhaXRGb3JFbGVtZW50OiAoc2VsLCB0aW1lb3V0TXMgPSA1MDAwKSA9PlxuICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7XG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSByZXR1cm4gcmVzb2x2ZShleGlzdGluZyk7XG4gICAgICAgICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgdGltZW91dE1zO1xuICAgICAgICAgIGNvbnN0IG9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgICAgaWYgKGVsKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlc29sdmUoZWwpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChEYXRlLm5vdygpID4gZGVhZGxpbmUpIHtcbiAgICAgICAgICAgICAgb2JzLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgdGltZW91dCB3YWl0aW5nIGZvciAke3NlbH1gKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgICAgICAgfSksXG4gICAgfSxcbiAgICBpcGM6IHtcbiAgICAgIG9uOiAoYywgaCkgPT4ge1xuICAgICAgICBjb25zdCB3cmFwcGVkID0gKF9lOiB1bmtub3duLCAuLi5hcmdzOiB1bmtub3duW10pID0+IGgoLi4uYXJncyk7XG4gICAgICAgIGlwY1JlbmRlcmVyLm9uKGBjb2RleHBwOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGBjb2RleHBwOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgIH0sXG4gICAgICBzZW5kOiAoYywgLi4uYXJncykgPT4gaXBjUmVuZGVyZXIuc2VuZChgY29kZXhwcDoke2lkfToke2N9YCwgLi4uYXJncyksXG4gICAgICBpbnZva2U6IDxUPihjOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKGBjb2RleHBwOiR7aWR9OiR7Y31gLCAuLi5hcmdzKSBhcyBQcm9taXNlPFQ+LFxuICAgIH0sXG4gICAgZnM6IHJlbmRlcmVyRnMoaWQsIHBhdGhzKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJTdG9yYWdlKGlkOiBzdHJpbmcpIHtcbiAgY29uc3Qga2V5ID0gYGNvZGV4cHA6c3RvcmFnZToke2lkfWA7XG4gIGNvbnN0IHJlYWQgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpID8/IFwie31cIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICB9O1xuICBjb25zdCB3cml0ZSA9ICh2OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT5cbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHYpKTtcbiAgcmV0dXJuIHtcbiAgICBnZXQ6IDxUPihrOiBzdHJpbmcsIGQ/OiBUKSA9PiAoayBpbiByZWFkKCkgPyAocmVhZCgpW2tdIGFzIFQpIDogKGQgYXMgVCkpLFxuICAgIHNldDogKGs6IHN0cmluZywgdjogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbyA9IHJlYWQoKTtcbiAgICAgIG9ba10gPSB2O1xuICAgICAgd3JpdGUobyk7XG4gICAgfSxcbiAgICBkZWxldGU6IChrOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IG8gPSByZWFkKCk7XG4gICAgICBkZWxldGUgb1trXTtcbiAgICAgIHdyaXRlKG8pO1xuICAgIH0sXG4gICAgYWxsOiAoKSA9PiByZWFkKCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyRnMoaWQ6IHN0cmluZywgX3BhdGhzOiBVc2VyUGF0aHMpIHtcbiAgLy8gU2FuZGJveGVkIHJlbmRlcmVyIGNhbid0IHVzZSBOb2RlIGZzIGRpcmVjdGx5IFx1MjAxNCBwcm94eSB0aHJvdWdoIG1haW4gSVBDLlxuICByZXR1cm4ge1xuICAgIGRhdGFEaXI6IGA8cmVtb3RlPi90d2Vhay1kYXRhLyR7aWR9YCxcbiAgICByZWFkOiAocDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcInJlYWRcIiwgaWQsIHApIGFzIFByb21pc2U8c3RyaW5nPixcbiAgICB3cml0ZTogKHA6IHN0cmluZywgYzogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcIndyaXRlXCIsIGlkLCBwLCBjKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGV4aXN0czogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dHdlYWstZnNcIiwgXCJleGlzdHNcIiwgaWQsIHApIGFzIFByb21pc2U8Ym9vbGVhbj4sXG4gIH07XG59XG4iLCAiLyoqXG4gKiBCdWlsdC1pbiBcIlR3ZWFrIE1hbmFnZXJcIiBcdTIwMTQgYXV0by1pbmplY3RlZCBieSB0aGUgcnVudGltZSwgbm90IGEgdXNlciB0d2Vhay5cbiAqIExpc3RzIGRpc2NvdmVyZWQgdHdlYWtzIHdpdGggZW5hYmxlIHRvZ2dsZXMsIG9wZW5zIHRoZSB0d2Vha3MgZGlyLCBsaW5rc1xuICogdG8gbG9ncyBhbmQgY29uZmlnLiBMaXZlcyBpbiB0aGUgcmVuZGVyZXIuXG4gKlxuICogVGhpcyBpcyBpbnZva2VkIGZyb20gcHJlbG9hZC9pbmRleC50cyBBRlRFUiB1c2VyIHR3ZWFrcyBhcmUgbG9hZGVkIHNvIGl0XG4gKiBjYW4gc2hvdyB1cC10by1kYXRlIHN0YXR1cy5cbiAqL1xuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtb3VudE1hbmFnZXIoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmxpc3QtdHdlYWtzXCIpKSBhcyBBcnJheTx7XG4gICAgbWFuaWZlc3Q6IHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nIH07XG4gICAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIH0+O1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnVzZXItcGF0aHNcIikpIGFzIHtcbiAgICB1c2VyUm9vdDogc3RyaW5nO1xuICAgIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICAgIGxvZ0Rpcjogc3RyaW5nO1xuICB9O1xuXG4gIHJlZ2lzdGVyU2VjdGlvbih7XG4gICAgaWQ6IFwiY29kZXgtcGx1c3BsdXM6bWFuYWdlclwiLFxuICAgIHRpdGxlOiBcIlR3ZWFrIE1hbmFnZXJcIixcbiAgICBkZXNjcmlwdGlvbjogYCR7dHdlYWtzLmxlbmd0aH0gdHdlYWsocykgaW5zdGFsbGVkLiBVc2VyIGRpcjogJHtwYXRocy51c2VyUm9vdH1gLFxuICAgIHJlbmRlcihyb290KSB7XG4gICAgICByb290LnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweDtcIjtcblxuICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBhY3Rpb25zLnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO1wiO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiB0d2Vha3MgZm9sZGVyXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMudHdlYWtzRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiBsb2dzXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMubG9nRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiUmVsb2FkIHdpbmRvd1wiLCAoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSksXG4gICAgICApO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAgICAgaWYgKHR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICAgICAgZW1wdHkuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEzcHggc3lzdGVtLXVpO21hcmdpbjo4cHggMDtcIjtcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPVxuICAgICAgICAgIFwiTm8gdXNlciB0d2Vha3MgeWV0LiBEcm9wIGEgZm9sZGVyIHdpdGggbWFuaWZlc3QuanNvbiArIGluZGV4LmpzIGludG8gdGhlIHR3ZWFrcyBkaXIsIHRoZW4gcmVsb2FkLlwiO1xuICAgICAgICByb290LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInVsXCIpO1xuICAgICAgbGlzdC5zdHlsZS5jc3NUZXh0ID0gXCJsaXN0LXN0eWxlOm5vbmU7bWFyZ2luOjA7cGFkZGluZzowO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjZweDtcIjtcbiAgICAgIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICAgIGxpLnN0eWxlLmNzc1RleHQgPVxuICAgICAgICAgIFwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjhweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMyYTJhMmEpO2JvcmRlci1yYWRpdXM6NnB4O1wiO1xuICAgICAgICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgbGVmdC5pbm5lckhUTUwgPSBgXG4gICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQ6NjAwIDEzcHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QubmFtZSl9IDxzcGFuIHN0eWxlPVwiY29sb3I6Izg4ODtmb250LXdlaWdodDo0MDA7XCI+diR7ZXNjYXBlKHQubWFuaWZlc3QudmVyc2lvbil9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5kZXNjcmlwdGlvbiA/PyB0Lm1hbmlmZXN0LmlkKX08L2Rpdj5cbiAgICAgICAgYDtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICByaWdodC5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI7XG4gICAgICAgIHJpZ2h0LnRleHRDb250ZW50ID0gdC5lbnRyeUV4aXN0cyA/IFwibG9hZGVkXCIgOiBcIm1pc3NpbmcgZW50cnlcIjtcbiAgICAgICAgbGkuYXBwZW5kKGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgbGlzdC5hcHBlbmQobGkpO1xuICAgICAgfVxuICAgICAgcm9vdC5hcHBlbmQobGlzdCk7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbmNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBiLnN0eWxlLmNzc1RleHQgPVxuICAgIFwicGFkZGluZzo2cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMzMzKTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOmluaGVyaXQ7Zm9udDoxMnB4IHN5c3RlbS11aTtjdXJzb3I6cG9pbnRlcjtcIjtcbiAgYi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25jbGljayk7XG4gIHJldHVybiBiO1xufVxuXG5mdW5jdGlvbiBlc2NhcGUoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+XG4gICAgYyA9PT0gXCImXCJcbiAgICAgID8gXCImYW1wO1wiXG4gICAgICA6IGMgPT09IFwiPFwiXG4gICAgICAgID8gXCImbHQ7XCJcbiAgICAgICAgOiBjID09PSBcIj5cIlxuICAgICAgICAgID8gXCImZ3Q7XCJcbiAgICAgICAgICA6IGMgPT09ICdcIidcbiAgICAgICAgICAgID8gXCImcXVvdDtcIlxuICAgICAgICAgICAgOiBcIiYjMzk7XCIsXG4gICk7XG59XG4iLCAiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcblxuY29uc3QgQ09ERVhfTUVTU0FHRV9GUk9NX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mcm9tLXZpZXdcIjtcbmNvbnN0IENPREVYX01FU1NBR0VfRk9SX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mb3Itdmlld1wiO1xuY29uc3QgREVGQVVMVF9SRVFVRVNUX1RJTUVPVVRfTVMgPSAxMl8wMDA7XG5cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgZWxlY3Ryb25CcmlkZ2U/OiB7XG4gICAgICBzZW5kTWVzc2FnZUZyb21WaWV3PyhtZXNzYWdlOiB1bmtub3duKTogUHJvbWlzZTx2b2lkPjtcbiAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwU2VydmVyUmVxdWVzdE9wdGlvbnMge1xuICBob3N0SWQ/OiBzdHJpbmc7XG4gIHRpbWVvdXRNcz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBTZXJ2ZXJOb3RpZmljYXRpb24ge1xuICBtZXRob2Q6IHN0cmluZztcbiAgcGFyYW1zOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ1JlcXVlc3Qge1xuICBpZDogc3RyaW5nO1xuICByZXNvbHZlKHZhbHVlOiB1bmtub3duKTogdm9pZDtcbiAgcmVqZWN0KGVycm9yOiBFcnJvcik6IHZvaWQ7XG4gIHRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+O1xufVxuXG5sZXQgbmV4dFJlcXVlc3RJZCA9IDE7XG5jb25zdCBwZW5kaW5nUmVxdWVzdHMgPSBuZXcgTWFwPHN0cmluZywgUGVuZGluZ1JlcXVlc3Q+KCk7XG5jb25zdCBub3RpZmljYXRpb25MaXN0ZW5lcnMgPSBuZXcgU2V0PChub3RpZmljYXRpb246IEFwcFNlcnZlck5vdGlmaWNhdGlvbikgPT4gdm9pZD4oKTtcbmxldCBzdWJzY3JpYmVkID0gZmFsc2U7XG5cbmV4cG9ydCBmdW5jdGlvbiByZXF1ZXN0QXBwU2VydmVyPFQ+KFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGFyYW1zOiB1bmtub3duLFxuICBvcHRpb25zOiBBcHBTZXJ2ZXJSZXF1ZXN0T3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxUPiB7XG4gIGVuc3VyZVN1YnNjcmliZWQoKTtcbiAgY29uc3QgaWQgPSBgY29kZXhwcC0ke0RhdGUubm93KCl9LSR7bmV4dFJlcXVlc3RJZCsrfWA7XG4gIGNvbnN0IGhvc3RJZCA9IG9wdGlvbnMuaG9zdElkID8/IHJlYWRIb3N0SWQoKTtcbiAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0TXMgPz8gREVGQVVMVF9SRVFVRVNUX1RJTUVPVVRfTVM7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlPFQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgICAgIHJlamVjdChuZXcgRXJyb3IoYFRpbWVkIG91dCB3YWl0aW5nIGZvciBhcHAtc2VydmVyIHJlc3BvbnNlIHRvICR7bWV0aG9kfWApKTtcbiAgICB9LCB0aW1lb3V0TXMpO1xuXG4gICAgcGVuZGluZ1JlcXVlc3RzLnNldChpZCwge1xuICAgICAgaWQsXG4gICAgICByZXNvbHZlOiAodmFsdWUpID0+IHJlc29sdmUodmFsdWUgYXMgVCksXG4gICAgICByZWplY3QsXG4gICAgICB0aW1lb3V0LFxuICAgIH0pO1xuXG4gICAgY29uc3QgbWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6IFwibWNwLXJlcXVlc3RcIixcbiAgICAgIGhvc3RJZCxcbiAgICAgIHJlcXVlc3Q6IHsgaWQsIG1ldGhvZCwgcGFyYW1zIH0sXG4gICAgfTtcblxuICAgIHNlbmRNZXNzYWdlRnJvbVZpZXcobWVzc2FnZSkudGhlbigocmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAhPT0gdW5kZWZpbmVkKSBoYW5kbGVJbmNvbWluZ01lc3NhZ2UocmVzcG9uc2UpO1xuICAgIH0pLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgY29uc3QgcGVuZGluZyA9IHBlbmRpbmdSZXF1ZXN0cy5nZXQoaWQpO1xuICAgICAgaWYgKCFwZW5kaW5nKSByZXR1cm47XG4gICAgICBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lb3V0KTtcbiAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoaWQpO1xuICAgICAgcGVuZGluZy5yZWplY3QodG9FcnJvcihlcnJvcikpO1xuICAgIH0pO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9uQXBwU2VydmVyTm90aWZpY2F0aW9uKFxuICBsaXN0ZW5lcjogKG5vdGlmaWNhdGlvbjogQXBwU2VydmVyTm90aWZpY2F0aW9uKSA9PiB2b2lkLFxuKTogKCkgPT4gdm9pZCB7XG4gIGVuc3VyZVN1YnNjcmliZWQoKTtcbiAgbm90aWZpY2F0aW9uTGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gIHJldHVybiAoKSA9PiBub3RpZmljYXRpb25MaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWRIb3N0SWQoKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuICAgIGNvbnN0IGhvc3RJZCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiaG9zdElkXCIpPy50cmltKCk7XG4gICAgcmV0dXJuIGhvc3RJZCB8fCBcImxvY2FsXCI7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcImxvY2FsXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW5zdXJlU3Vic2NyaWJlZCgpOiB2b2lkIHtcbiAgaWYgKHN1YnNjcmliZWQpIHJldHVybjtcbiAgc3Vic2NyaWJlZCA9IHRydWU7XG4gIGlwY1JlbmRlcmVyLm9uKENPREVYX01FU1NBR0VfRk9SX1ZJRVcsIChfZXZlbnQsIG1lc3NhZ2UpID0+IHtcbiAgICBoYW5kbGVJbmNvbWluZ01lc3NhZ2UobWVzc2FnZSk7XG4gIH0pO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgKGV2ZW50KSA9PiB7XG4gICAgaGFuZGxlSW5jb21pbmdNZXNzYWdlKGV2ZW50LmRhdGEpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlSW5jb21pbmdNZXNzYWdlKG1lc3NhZ2U6IHVua25vd24pOiB2b2lkIHtcbiAgY29uc3Qgbm90aWZpY2F0aW9uID0gZXh0cmFjdE5vdGlmaWNhdGlvbihtZXNzYWdlKTtcbiAgaWYgKG5vdGlmaWNhdGlvbikge1xuICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2Ygbm90aWZpY2F0aW9uTGlzdGVuZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBsaXN0ZW5lcihub3RpZmljYXRpb24pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGlzb2xhdGUgbGlzdGVuZXIgZmFpbHVyZXMgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCByZXNwb25zZSA9IGV4dHJhY3RSZXNwb25zZShtZXNzYWdlKTtcbiAgaWYgKCFyZXNwb25zZSkgcmV0dXJuO1xuICBjb25zdCBwZW5kaW5nID0gcGVuZGluZ1JlcXVlc3RzLmdldChyZXNwb25zZS5pZCk7XG4gIGlmICghcGVuZGluZykgcmV0dXJuO1xuXG4gIGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVvdXQpO1xuICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKHJlc3BvbnNlLmlkKTtcbiAgaWYgKHJlc3BvbnNlLmVycm9yKSB7XG4gICAgcGVuZGluZy5yZWplY3QocmVzcG9uc2UuZXJyb3IpO1xuICAgIHJldHVybjtcbiAgfVxuICBwZW5kaW5nLnJlc29sdmUocmVzcG9uc2UucmVzdWx0KTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFJlc3BvbnNlKG1lc3NhZ2U6IHVua25vd24pOiB7IGlkOiBzdHJpbmc7IHJlc3VsdD86IHVua25vd247IGVycm9yPzogRXJyb3IgfSB8IG51bGwge1xuICBpZiAoIWlzUmVjb3JkKG1lc3NhZ2UpKSByZXR1cm4gbnVsbDtcblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1yZXNwb25zZVwiICYmIGlzUmVjb3JkKG1lc3NhZ2UucmVzcG9uc2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UucmVzcG9uc2UpO1xuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3AtcmVzcG9uc2VcIiAmJiBpc1JlY29yZChtZXNzYWdlLm1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UubWVzc2FnZSk7XG4gIH1cblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1lcnJvclwiICYmIHR5cGVvZiBtZXNzYWdlLmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHsgaWQ6IG1lc3NhZ2UuaWQsIGVycm9yOiBuZXcgRXJyb3IocmVhZEVycm9yTWVzc2FnZShtZXNzYWdlLmVycm9yKSA/PyBcIkFwcC1zZXJ2ZXIgcmVxdWVzdCBmYWlsZWRcIikgfTtcbiAgfVxuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwicmVzcG9uc2VcIiAmJiB0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIiAmJiAoXCJyZXN1bHRcIiBpbiBtZXNzYWdlIHx8IFwiZXJyb3JcIiBpbiBtZXNzYWdlKSkge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlKTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZXNwb25zZUZyb21FbnZlbG9wZShlbnZlbG9wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB7IGlkOiBzdHJpbmc7IHJlc3VsdD86IHVua25vd247IGVycm9yPzogRXJyb3IgfSB8IG51bGwge1xuICBjb25zdCBpZCA9IHR5cGVvZiBlbnZlbG9wZS5pZCA9PT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgZW52ZWxvcGUuaWQgPT09IFwibnVtYmVyXCJcbiAgICA/IFN0cmluZyhlbnZlbG9wZS5pZClcbiAgICA6IG51bGw7XG4gIGlmICghaWQpIHJldHVybiBudWxsO1xuXG4gIGlmIChcImVycm9yXCIgaW4gZW52ZWxvcGUpIHtcbiAgICByZXR1cm4geyBpZCwgZXJyb3I6IG5ldyBFcnJvcihyZWFkRXJyb3JNZXNzYWdlKGVudmVsb3BlLmVycm9yKSA/PyBcIkFwcC1zZXJ2ZXIgcmVxdWVzdCBmYWlsZWRcIikgfTtcbiAgfVxuXG4gIHJldHVybiB7IGlkLCByZXN1bHQ6IGVudmVsb3BlLnJlc3VsdCB9O1xufVxuXG5mdW5jdGlvbiBleHRyYWN0Tm90aWZpY2F0aW9uKG1lc3NhZ2U6IHVua25vd24pOiBBcHBTZXJ2ZXJOb3RpZmljYXRpb24gfCBudWxsIHtcbiAgaWYgKCFpc1JlY29yZChtZXNzYWdlKSkgcmV0dXJuIG51bGw7XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5yZXF1ZXN0KSkge1xuICAgIGNvbnN0IG1ldGhvZCA9IG1lc3NhZ2UucmVxdWVzdC5tZXRob2Q7XG4gICAgaWYgKHR5cGVvZiBtZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7IG1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnJlcXVlc3QucGFyYW1zIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5tZXNzYWdlKSkge1xuICAgIGNvbnN0IG1ldGhvZCA9IG1lc3NhZ2UubWVzc2FnZS5tZXRob2Q7XG4gICAgaWYgKHR5cGVvZiBtZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7IG1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLm1lc3NhZ2UucGFyYW1zIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgdHlwZW9mIG1lc3NhZ2UubWV0aG9kID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHsgbWV0aG9kOiBtZXNzYWdlLm1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnBhcmFtcyB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBtZXNzYWdlLm1ldGhvZCA9PT0gXCJzdHJpbmdcIiAmJiAhKFwiaWRcIiBpbiBtZXNzYWdlKSkge1xuICAgIHJldHVybiB7IG1ldGhvZDogbWVzc2FnZS5tZXRob2QsIHBhcmFtczogbWVzc2FnZS5wYXJhbXMgfTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZWFkRXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgaWYgKHR5cGVvZiBlcnJvciA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGVycm9yO1xuICBpZiAoaXNSZWNvcmQoZXJyb3IpKSB7XG4gICAgaWYgKHR5cGVvZiBlcnJvci5tZXNzYWdlID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgICBpZiAodHlwZW9mIGVycm9yLmVycm9yID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3IuZXJyb3I7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHNlbmRNZXNzYWdlRnJvbVZpZXcobWVzc2FnZTogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xuICBjb25zdCBicmlkZ2VTZW5kZXIgPSB3aW5kb3cuZWxlY3Ryb25CcmlkZ2U/LnNlbmRNZXNzYWdlRnJvbVZpZXc7XG4gIGlmICh0eXBlb2YgYnJpZGdlU2VuZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICByZXR1cm4gYnJpZGdlU2VuZGVyLmNhbGwod2luZG93LmVsZWN0cm9uQnJpZGdlLCBtZXNzYWdlKS50aGVuKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cbiAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShDT0RFWF9NRVNTQUdFX0ZST01fVklFVywgbWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIHRvRXJyb3IoZXJyb3I6IHVua25vd24pOiBFcnJvciB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSk7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4gdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTtcbn1cbiIsICJpbXBvcnQgeyBvbkFwcFNlcnZlck5vdGlmaWNhdGlvbiwgcmVhZEhvc3RJZCwgcmVxdWVzdEFwcFNlcnZlciB9IGZyb20gXCIuL2FwcC1zZXJ2ZXItYnJpZGdlXCI7XG5cbnR5cGUgR29hbFN0YXR1cyA9IFwiYWN0aXZlXCIgfCBcInBhdXNlZFwiIHwgXCJidWRnZXRMaW1pdGVkXCIgfCBcImNvbXBsZXRlXCI7XG5cbmludGVyZmFjZSBUaHJlYWRHb2FsIHtcbiAgdGhyZWFkSWQ6IHN0cmluZztcbiAgb2JqZWN0aXZlOiBzdHJpbmc7XG4gIHN0YXR1czogR29hbFN0YXR1cztcbiAgdG9rZW5CdWRnZXQ6IG51bWJlciB8IG51bGw7XG4gIHRva2Vuc1VzZWQ6IG51bWJlcjtcbiAgdGltZVVzZWRTZWNvbmRzOiBudW1iZXI7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICB1cGRhdGVkQXQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEdvYWxVaUFjdGlvbiB7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGtpbmQ/OiBcInByaW1hcnlcIiB8IFwiZGFuZ2VyXCI7XG4gIHJ1bigpOiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIEdvYWxQYW5lbE9wdGlvbnMge1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXRhaWw6IHN0cmluZztcbiAgZm9vdGVyPzogc3RyaW5nO1xuICBhY3Rpb25zOiBHb2FsVWlBY3Rpb25bXTtcbiAgcGVyc2lzdGVudDogYm9vbGVhbjtcbiAgZXJyb3I/OiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgR29hbFBhbmVsU3RhdGUge1xuICBjb2xsYXBzZWQ6IGJvb2xlYW47XG4gIHg6IG51bWJlciB8IG51bGw7XG4gIHk6IG51bWJlciB8IG51bGw7XG59XG5cbmludGVyZmFjZSBHb2FsUGFuZWxEcmFnIHtcbiAgcG9pbnRlcklkOiBudW1iZXI7XG4gIG9mZnNldFg6IG51bWJlcjtcbiAgb2Zmc2V0WTogbnVtYmVyO1xuICB3aWR0aDogbnVtYmVyO1xuICBoZWlnaHQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEVkaXRhYmxlVGFyZ2V0IHtcbiAgZWxlbWVudDogSFRNTEVsZW1lbnQ7XG4gIGdldFRleHQoKTogc3RyaW5nO1xuICBzZXRUZXh0KHZhbHVlOiBzdHJpbmcpOiB2b2lkO1xuICBjbGVhcigpOiB2b2lkO1xufVxuXG5sZXQgc3RhcnRlZCA9IGZhbHNlO1xubGV0IHJvb3Q6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgc3VnZ2VzdGlvblJvb3Q6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgY3VycmVudEdvYWw6IFRocmVhZEdvYWwgfCBudWxsID0gbnVsbDtcbmxldCBoaWRlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5sZXQgbGFzdFRocmVhZElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbmxldCBsYXN0UGFuZWxPcHRpb25zOiBHb2FsUGFuZWxPcHRpb25zIHwgbnVsbCA9IG51bGw7XG5sZXQgcGFuZWxEcmFnOiBHb2FsUGFuZWxEcmFnIHwgbnVsbCA9IG51bGw7XG5cbmNvbnN0IEdPQUxfUEFORUxfU1RBVEVfS0VZID0gXCJjb2RleHBwOmdvYWwtcGFuZWwtc3RhdGVcIjtcbmxldCBwYW5lbFN0YXRlOiBHb2FsUGFuZWxTdGF0ZSA9IHJlYWRHb2FsUGFuZWxTdGF0ZSgpO1xuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRHb2FsRmVhdHVyZShsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQgPSAoKSA9PiB7fSk6IHZvaWQge1xuICBpZiAoc3RhcnRlZCkgcmV0dXJuO1xuICBzdGFydGVkID0gdHJ1ZTtcbiAgaW5zdGFsbFN0eWxlcygpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZXZlbnQpID0+IHtcbiAgICB2b2lkIGhhbmRsZUtleWRvd24oZXZlbnQsIGxvZyk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKGV2ZW50KSA9PiB7XG4gICAgdXBkYXRlR29hbFN1Z2dlc3Rpb24oZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50KSk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNpblwiLCAoZXZlbnQpID0+IHtcbiAgICB1cGRhdGVHb2FsU3VnZ2VzdGlvbihmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpKTtcbiAgfSwgdHJ1ZSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICBpZiAoc3VnZ2VzdGlvblJvb3Q/LmNvbnRhaW5zKGV2ZW50LnRhcmdldCBhcyBOb2RlKSkgcmV0dXJuO1xuICAgIHVwZGF0ZUdvYWxTdWdnZXN0aW9uKGZpbmRFZGl0YWJsZVRhcmdldChldmVudCkpO1xuICB9LCB0cnVlKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJyZXNpemVcIiwgKCkgPT4ge1xuICAgIGlmICghcm9vdD8uaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQocm9vdCk7XG4gICAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbiAgfSk7XG4gIG9uQXBwU2VydmVyTm90aWZpY2F0aW9uKChub3RpZmljYXRpb24pID0+IHtcbiAgICBpZiAobm90aWZpY2F0aW9uLm1ldGhvZCA9PT0gXCJ0aHJlYWQvZ29hbC91cGRhdGVkXCIgJiYgaXNSZWNvcmQobm90aWZpY2F0aW9uLnBhcmFtcykpIHtcbiAgICAgIGNvbnN0IGdvYWwgPSBub3RpZmljYXRpb24ucGFyYW1zLmdvYWw7XG4gICAgICBpZiAoaXNUaHJlYWRHb2FsKGdvYWwpKSB7XG4gICAgICAgIGlmIChnb2FsLnRocmVhZElkICE9PSByZWFkVGhyZWFkSWQoKSkgcmV0dXJuO1xuICAgICAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobm90aWZpY2F0aW9uLm1ldGhvZCA9PT0gXCJ0aHJlYWQvZ29hbC9jbGVhcmVkXCIgJiYgaXNSZWNvcmQobm90aWZpY2F0aW9uLnBhcmFtcykpIHtcbiAgICAgIGNvbnN0IHRocmVhZElkID0gbm90aWZpY2F0aW9uLnBhcmFtcy50aHJlYWRJZDtcbiAgICAgIGlmICh0eXBlb2YgdGhyZWFkSWQgPT09IFwic3RyaW5nXCIgJiYgdGhyZWFkSWQgPT09IHJlYWRUaHJlYWRJZCgpKSB7XG4gICAgICAgIGN1cnJlbnRHb2FsID0gbnVsbDtcbiAgICAgICAgcmVuZGVyTm90aWNlKFwiR29hbCBjbGVhcmVkXCIsIFwiVGhpcyB0aHJlYWQgbm8gbG9uZ2VyIGhhcyBhbiBhY3RpdmUgZ29hbC5cIik7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvcHN0YXRlXCIsICgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSk7XG4gIGNvbnN0IHJlZnJlc2hUaW1lciA9IHNldEludGVydmFsKCgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSwgMl81MDApO1xuICBjb25zdCB1bnJlZiA9IChyZWZyZXNoVGltZXIgYXMgdW5rbm93biBhcyB7IHVucmVmPzogKCkgPT4gdm9pZCB9KS51bnJlZjtcbiAgaWYgKHR5cGVvZiB1bnJlZiA9PT0gXCJmdW5jdGlvblwiKSB1bnJlZi5jYWxsKHJlZnJlc2hUaW1lcik7XG4gIHF1ZXVlTWljcm90YXNrKCgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSk7XG4gIGxvZyhcImdvYWwgZmVhdHVyZSBzdGFydGVkXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVLZXlkb3duKGV2ZW50OiBLZXlib2FyZEV2ZW50LCBsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGV2ZW50LmlzQ29tcG9zaW5nKSByZXR1cm47XG5cbiAgY29uc3QgZWRpdGFibGUgPSBmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpO1xuICBpZiAoIWVkaXRhYmxlKSByZXR1cm47XG5cbiAgaWYgKGV2ZW50LmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgIGhpZGVHb2FsU3VnZ2VzdGlvbigpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgoZXZlbnQua2V5ID09PSBcIlRhYlwiIHx8IGV2ZW50LmtleSA9PT0gXCJFbnRlclwiKSAmJiAhZXZlbnQuc2hpZnRLZXkgJiYgIWV2ZW50LmFsdEtleSAmJiAhZXZlbnQuY3RybEtleSAmJiAhZXZlbnQubWV0YUtleSkge1xuICAgIGNvbnN0IHN1Z2dlc3Rpb24gPSBwYXJzZUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLmdldFRleHQoKSk7XG4gICAgaWYgKHN1Z2dlc3Rpb24gJiYgZWRpdGFibGUuZ2V0VGV4dCgpLnRyaW0oKSAhPT0gXCIvZ29hbFwiKSB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIGlmIChldmVudC5rZXkgIT09IFwiRW50ZXJcIiB8fCBldmVudC5zaGlmdEtleSB8fCBldmVudC5hbHRLZXkgfHwgZXZlbnQuY3RybEtleSB8fCBldmVudC5tZXRhS2V5KSByZXR1cm47XG5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VHb2FsQ29tbWFuZChlZGl0YWJsZS5nZXRUZXh0KCkpO1xuICBpZiAoIXBhcnNlZCkgcmV0dXJuO1xuXG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICBldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgZWRpdGFibGUuY2xlYXIoKTtcbiAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBydW5Hb2FsQ29tbWFuZChwYXJzZWQuYXJncywgbG9nKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBsb2coXCJnb2FsIGNvbW1hbmQgZmFpbGVkXCIsIHN0cmluZ2lmeUVycm9yKGVycm9yKSk7XG4gICAgcmVuZGVyRXJyb3IoXCJHb2FsIGNvbW1hbmQgZmFpbGVkXCIsIGZyaWVuZGx5R29hbEVycm9yKGVycm9yKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcGFyc2VHb2FsQ29tbWFuZCh0ZXh0OiBzdHJpbmcpOiB7IGFyZ3M6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gdGV4dC50cmltKCkubWF0Y2goL15cXC9nb2FsKD86XFxzKyhbXFxzXFxTXSopKT8kLyk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhcmdzOiAobWF0Y2hbMV0gPz8gXCJcIikudHJpbSgpIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlR29hbFN1Z2dlc3Rpb24odGV4dDogc3RyaW5nKTogeyBxdWVyeTogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSB0ZXh0LnRyaW0oKS5tYXRjaCgvXlxcLyhbYS16XSopJC9pKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHF1ZXJ5ID0gbWF0Y2hbMV0/LnRvTG93ZXJDYXNlKCkgPz8gXCJcIjtcbiAgcmV0dXJuIFwiZ29hbFwiLnN0YXJ0c1dpdGgocXVlcnkpID8geyBxdWVyeSB9IDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuR29hbENvbW1hbmQoYXJnczogc3RyaW5nLCBsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKTtcbiAgaWYgKCF0aHJlYWRJZCkge1xuICAgIHJlbmRlckVycm9yKFwiTm8gYWN0aXZlIHRocmVhZFwiLCBcIk9wZW4gYSBsb2NhbCB0aHJlYWQgYmVmb3JlIHVzaW5nIC9nb2FsLlwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgaG9zdElkID0gcmVhZEhvc3RJZCgpO1xuICBjb25zdCBsb3dlciA9IGFyZ3MudG9Mb3dlckNhc2UoKTtcblxuICBpZiAoIWFyZ3MpIHtcbiAgICBjb25zdCBnb2FsID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgaG9zdElkKTtcbiAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgaWYgKGdvYWwpIHtcbiAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICByZW5kZXJOb3RpY2UoXCJObyBnb2FsIHNldFwiLCBcIlVzZSAvZ29hbCA8b2JqZWN0aXZlPiB0byBzZXQgb25lIGZvciB0aGlzIHRocmVhZC5cIik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChsb3dlciA9PT0gXCJjbGVhclwiKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgY2xlYXJlZDogYm9vbGVhbiB9PihcbiAgICAgIFwidGhyZWFkL2dvYWwvY2xlYXJcIixcbiAgICAgIHsgdGhyZWFkSWQgfSxcbiAgICAgIHsgaG9zdElkIH0sXG4gICAgKTtcbiAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgcmVuZGVyTm90aWNlKHJlc3BvbnNlLmNsZWFyZWQgPyBcIkdvYWwgY2xlYXJlZFwiIDogXCJObyBnb2FsIHNldFwiLCBcIlVzZSAvZ29hbCA8b2JqZWN0aXZlPiB0byBzZXQgYSBuZXcgZ29hbC5cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGxvd2VyID09PSBcInBhdXNlXCIgfHwgbG93ZXIgPT09IFwicmVzdW1lXCIgfHwgbG93ZXIgPT09IFwiY29tcGxldGVcIikge1xuICAgIGNvbnN0IHN0YXR1czogR29hbFN0YXR1cyA9IGxvd2VyID09PSBcInBhdXNlXCIgPyBcInBhdXNlZFwiIDogbG93ZXIgPT09IFwicmVzdW1lXCIgPyBcImFjdGl2ZVwiIDogXCJjb21wbGV0ZVwiO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgICBcInRocmVhZC9nb2FsL3NldFwiLFxuICAgICAgeyB0aHJlYWRJZCwgc3RhdHVzIH0sXG4gICAgICB7IGhvc3RJZCB9LFxuICAgICk7XG4gICAgY3VycmVudEdvYWwgPSByZXNwb25zZS5nb2FsO1xuICAgIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgaG9zdElkKTtcbiAgaWYgKGV4aXN0aW5nICYmIGV4aXN0aW5nLm9iamVjdGl2ZSAhPT0gYXJncykge1xuICAgIGNvbnN0IHJlcGxhY2UgPSBhd2FpdCBjb25maXJtUmVwbGFjZUdvYWwoZXhpc3RpbmcsIGFyZ3MpO1xuICAgIGlmICghcmVwbGFjZSkge1xuICAgICAgY3VycmVudEdvYWwgPSBleGlzdGluZztcbiAgICAgIHJlbmRlckdvYWwoZXhpc3RpbmcsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvc2V0XCIsXG4gICAgeyB0aHJlYWRJZCwgb2JqZWN0aXZlOiBhcmdzLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICB7IGhvc3RJZCB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IHJlc3BvbnNlLmdvYWw7XG4gIGxvZyhcImdvYWwgc2V0XCIsIHsgdGhyZWFkSWQgfSk7XG4gIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRHb2FsKHRocmVhZElkOiBzdHJpbmcsIGhvc3RJZDogc3RyaW5nKTogUHJvbWlzZTxUaHJlYWRHb2FsIHwgbnVsbD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIHwgbnVsbCB9PihcbiAgICBcInRocmVhZC9nb2FsL2dldFwiLFxuICAgIHsgdGhyZWFkSWQgfSxcbiAgICB7IGhvc3RJZCB9LFxuICApO1xuICByZXR1cm4gcmVzcG9uc2UuZ29hbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaEdvYWxGb3JSb3V0ZShsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKTtcbiAgaWYgKCF0aHJlYWRJZCkge1xuICAgIGlmIChsYXN0VGhyZWFkSWQgIT09IG51bGwpIHtcbiAgICAgIGxhc3RUaHJlYWRJZCA9IG51bGw7XG4gICAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgICBoaWRlUGFuZWwoKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aHJlYWRJZCA9PT0gbGFzdFRocmVhZElkKSByZXR1cm47XG4gIGxhc3RUaHJlYWRJZCA9IHRocmVhZElkO1xuICB0cnkge1xuICAgIGNvbnN0IGdvYWwgPSBhd2FpdCBnZXRHb2FsKHRocmVhZElkLCByZWFkSG9zdElkKCkpO1xuICAgIGN1cnJlbnRHb2FsID0gZ29hbDtcbiAgICBpZiAoZ29hbCkge1xuICAgICAgcmVuZGVyR29hbChnb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGhpZGVQYW5lbCgpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBPbGQgYXBwLXNlcnZlciBidWlsZHMgZG8gbm90IGtub3cgdGhyZWFkL2dvYWwvKi4gS2VlcCB0aGUgVUkgcXVpZXQgdW50aWxcbiAgICAvLyB0aGUgdXNlciBleHBsaWNpdGx5IHR5cGVzIC9nb2FsLCB0aGVuIHNob3cgdGhlIGFjdGlvbmFibGUgZXJyb3IuXG4gICAgbG9nKFwiZ29hbCByb3V0ZSByZWZyZXNoIHNraXBwZWRcIiwgc3RyaW5naWZ5RXJyb3IoZXJyb3IpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb25maXJtUmVwbGFjZUdvYWwoZXhpc3Rpbmc6IFRocmVhZEdvYWwsIG5leHRPYmplY3RpdmU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICByZW5kZXJQYW5lbCh7XG4gICAgICB0aXRsZTogXCJSZXBsYWNlIGN1cnJlbnQgZ29hbD9cIixcbiAgICAgIGRldGFpbDogdHJ1bmNhdGUoZXhpc3Rpbmcub2JqZWN0aXZlLCAxODApLFxuICAgICAgZm9vdGVyOiBgTmV3OiAke3RydW5jYXRlKG5leHRPYmplY3RpdmUsIDE4MCl9YCxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGxhYmVsOiBcIlJlcGxhY2VcIixcbiAgICAgICAgICBraW5kOiBcInByaW1hcnlcIixcbiAgICAgICAgICBydW46ICgpID0+IHJlc29sdmUodHJ1ZSksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBsYWJlbDogXCJDYW5jZWxcIixcbiAgICAgICAgICBydW46ICgpID0+IHJlc29sdmUoZmFsc2UpLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHBlcnNpc3RlbnQ6IHRydWUsXG4gICAgfSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJHb2FsKGdvYWw6IFRocmVhZEdvYWwsIG9wdGlvbnM6IHsgdHJhbnNpZW50OiBib29sZWFuIH0pOiB2b2lkIHtcbiAgY29uc3Qgc3RhdHVzID0gZ29hbFN0YXR1c0xhYmVsKGdvYWwuc3RhdHVzKTtcbiAgY29uc3QgYnVkZ2V0ID0gZ29hbC50b2tlbkJ1ZGdldCA9PSBudWxsXG4gICAgPyBgJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbnNVc2VkKX0gdG9rZW5zYFxuICAgIDogYCR7Zm9ybWF0TnVtYmVyKGdvYWwudG9rZW5zVXNlZCl9IC8gJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbkJ1ZGdldCl9IHRva2Vuc2A7XG4gIHJlbmRlclBhbmVsKHtcbiAgICB0aXRsZTogYEdvYWwgJHtzdGF0dXN9YCxcbiAgICBkZXRhaWw6IGdvYWwub2JqZWN0aXZlLFxuICAgIGZvb3RlcjogYCR7YnVkZ2V0fSAtICR7Zm9ybWF0RHVyYXRpb24oZ29hbC50aW1lVXNlZFNlY29uZHMpfWAsXG4gICAgYWN0aW9uczogW1xuICAgICAgZ29hbC5zdGF0dXMgPT09IFwicGF1c2VkXCJcbiAgICAgICAgPyB7IGxhYmVsOiBcIlJlc3VtZVwiLCBraW5kOiBcInByaW1hcnlcIiwgcnVuOiAoKSA9PiB1cGRhdGVHb2FsU3RhdHVzKFwiYWN0aXZlXCIpIH1cbiAgICAgICAgOiB7IGxhYmVsOiBcIlBhdXNlXCIsIHJ1bjogKCkgPT4gdXBkYXRlR29hbFN0YXR1cyhcInBhdXNlZFwiKSB9LFxuICAgICAgeyBsYWJlbDogXCJDb21wbGV0ZVwiLCBydW46ICgpID0+IHVwZGF0ZUdvYWxTdGF0dXMoXCJjb21wbGV0ZVwiKSB9LFxuICAgICAgeyBsYWJlbDogXCJDbGVhclwiLCBraW5kOiBcImRhbmdlclwiLCBydW46ICgpID0+IGNsZWFyQ3VycmVudEdvYWwoKSB9LFxuICAgIF0sXG4gICAgcGVyc2lzdGVudDogIW9wdGlvbnMudHJhbnNpZW50LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyTm90aWNlKHRpdGxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogdm9pZCB7XG4gIHJlbmRlclBhbmVsKHsgdGl0bGUsIGRldGFpbCwgYWN0aW9uczogW10sIHBlcnNpc3RlbnQ6IGZhbHNlIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFcnJvcih0aXRsZTogc3RyaW5nLCBkZXRhaWw6IHN0cmluZyk6IHZvaWQge1xuICByZW5kZXJQYW5lbCh7IHRpdGxlLCBkZXRhaWwsIGFjdGlvbnM6IFtdLCBwZXJzaXN0ZW50OiBmYWxzZSwgZXJyb3I6IHRydWUgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclBhbmVsKG9wdGlvbnM6IEdvYWxQYW5lbE9wdGlvbnMpOiB2b2lkIHtcbiAgbGFzdFBhbmVsT3B0aW9ucyA9IG9wdGlvbnM7XG4gIGNvbnN0IGVsID0gZW5zdXJlUm9vdCgpO1xuICBpZiAoaGlkZVRpbWVyKSBjbGVhclRpbWVvdXQoaGlkZVRpbWVyKTtcbiAgZWwuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWwuY2xhc3NOYW1lID0gYGNvZGV4cHAtZ29hbC1wYW5lbCR7b3B0aW9ucy5lcnJvciA/IFwiIGlzLWVycm9yXCIgOiBcIlwifSR7cGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIiBpcy1jb2xsYXBzZWRcIiA6IFwiXCJ9YDtcbiAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihlbCk7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWhlYWRlclwiO1xuICBoZWFkZXIuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIHN0YXJ0R29hbFBhbmVsRHJhZyk7XG4gIGhlYWRlci5hZGRFdmVudExpc3RlbmVyKFwiZGJsY2xpY2tcIiwgcmVzZXRHb2FsUGFuZWxQb3NpdGlvbik7XG5cbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC10aXRsZVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IG9wdGlvbnMudGl0bGU7XG5cbiAgY29uc3QgY29udHJvbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb250cm9scy5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1jb250cm9sc1wiO1xuXG4gIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29sbGFwc2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaWNvblwiO1xuICBjb2xsYXBzZS50eXBlID0gXCJidXR0b25cIjtcbiAgY29sbGFwc2UudGV4dENvbnRlbnQgPSBwYW5lbFN0YXRlLmNvbGxhcHNlZCA/IFwiK1wiIDogXCItXCI7XG4gIGNvbGxhcHNlLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgcGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIkV4cGFuZCBnb2FsIHBhbmVsXCIgOiBcIkNvbGxhcHNlIGdvYWwgcGFuZWxcIik7XG4gIGNvbGxhcHNlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgcGFuZWxTdGF0ZSA9IHsgLi4ucGFuZWxTdGF0ZSwgY29sbGFwc2VkOiAhcGFuZWxTdGF0ZS5jb2xsYXBzZWQgfTtcbiAgICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbiAgICBpZiAobGFzdFBhbmVsT3B0aW9ucykgcmVuZGVyUGFuZWwobGFzdFBhbmVsT3B0aW9ucyk7XG4gIH0pO1xuXG4gIGNvbnN0IGNsb3NlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY2xvc2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaWNvblwiO1xuICBjbG9zZS50eXBlID0gXCJidXR0b25cIjtcbiAgY2xvc2UudGV4dENvbnRlbnQgPSBcInhcIjtcbiAgY2xvc2Uuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIkNsb3NlIGdvYWwgcGFuZWxcIik7XG4gIGNsb3NlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBoaWRlUGFuZWwoKSk7XG4gIGNvbnRyb2xzLmFwcGVuZChjb2xsYXBzZSwgY2xvc2UpO1xuICBoZWFkZXIuYXBwZW5kKHRpdGxlLCBjb250cm9scyk7XG4gIGVsLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgaWYgKHBhbmVsU3RhdGUuY29sbGFwc2VkKSB7XG4gICAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICBpZiAoIW9wdGlvbnMucGVyc2lzdGVudCkge1xuICAgICAgaGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBoaWRlUGFuZWwoKSwgOF8wMDApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBkZXRhaWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXRhaWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtZGV0YWlsXCI7XG4gIGRldGFpbC50ZXh0Q29udGVudCA9IG9wdGlvbnMuZGV0YWlsO1xuXG4gIGVsLmFwcGVuZENoaWxkKGRldGFpbCk7XG5cbiAgaWYgKG9wdGlvbnMuZm9vdGVyKSB7XG4gICAgY29uc3QgZm9vdGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBmb290ZXIuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtZm9vdGVyXCI7XG4gICAgZm9vdGVyLnRleHRDb250ZW50ID0gb3B0aW9ucy5mb290ZXI7XG4gICAgZWwuYXBwZW5kQ2hpbGQoZm9vdGVyKTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLmFjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtYWN0aW9uc1wiO1xuICAgIGZvciAoY29uc3QgYWN0aW9uIG9mIG9wdGlvbnMuYWN0aW9ucykge1xuICAgICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGFjdGlvbi5sYWJlbDtcbiAgICAgIGJ1dHRvbi5jbGFzc05hbWUgPSBgY29kZXhwcC1nb2FsLWFjdGlvbiAke2FjdGlvbi5raW5kID8/IFwiXCJ9YDtcbiAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgICBQcm9taXNlLnJlc29sdmUoYWN0aW9uLnJ1bigpKS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICByZW5kZXJFcnJvcihcIkdvYWwgYWN0aW9uIGZhaWxlZFwiLCBmcmllbmRseUdvYWxFcnJvcihlcnJvcikpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgIH1cbiAgICBlbC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgfVxuXG4gIGVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gIGlmICghb3B0aW9ucy5wZXJzaXN0ZW50KSB7XG4gICAgaGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBoaWRlUGFuZWwoKSwgOF8wMDApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZUdvYWxTdGF0dXMoc3RhdHVzOiBHb2FsU3RhdHVzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCkgPz8gY3VycmVudEdvYWw/LnRocmVhZElkO1xuICBpZiAoIXRocmVhZElkKSByZXR1cm47XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgXCJ0aHJlYWQvZ29hbC9zZXRcIixcbiAgICB7IHRocmVhZElkLCBzdGF0dXMgfSxcbiAgICB7IGhvc3RJZDogcmVhZEhvc3RJZCgpIH0sXG4gICk7XG4gIGN1cnJlbnRHb2FsID0gcmVzcG9uc2UuZ29hbDtcbiAgcmVuZGVyR29hbChyZXNwb25zZS5nb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNsZWFyQ3VycmVudEdvYWwoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCkgPz8gY3VycmVudEdvYWw/LnRocmVhZElkO1xuICBpZiAoIXRocmVhZElkKSByZXR1cm47XG4gIGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBjbGVhcmVkOiBib29sZWFuIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvY2xlYXJcIixcbiAgICB7IHRocmVhZElkIH0sXG4gICAgeyBob3N0SWQ6IHJlYWRIb3N0SWQoKSB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IG51bGw7XG4gIHJlbmRlck5vdGljZShcIkdvYWwgY2xlYXJlZFwiLCBcIlRoaXMgdGhyZWFkIG5vIGxvbmdlciBoYXMgYW4gYWN0aXZlIGdvYWwuXCIpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVSb290KCk6IEhUTUxEaXZFbGVtZW50IHtcbiAgaWYgKHJvb3Q/LmlzQ29ubmVjdGVkKSByZXR1cm4gcm9vdDtcbiAgcm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvb3QuaWQgPSBcImNvZGV4cHAtZ29hbC1yb290XCI7XG4gIHJvb3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5ib2R5IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKHBhcmVudCkgcGFyZW50LmFwcGVuZENoaWxkKHJvb3QpO1xuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gaGlkZVBhbmVsKCk6IHZvaWQge1xuICBpZiAoaGlkZVRpbWVyKSB7XG4gICAgY2xlYXJUaW1lb3V0KGhpZGVUaW1lcik7XG4gICAgaGlkZVRpbWVyID0gbnVsbDtcbiAgfVxuICBpZiAocm9vdCkgcm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0R29hbFBhbmVsRHJhZyhldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChldmVudC5idXR0b24gIT09IDApIHJldHVybjtcbiAgaWYgKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgJiYgZXZlbnQudGFyZ2V0LmNsb3Nlc3QoXCJidXR0b25cIikpIHJldHVybjtcbiAgaWYgKCFyb290KSByZXR1cm47XG4gIGNvbnN0IHJlY3QgPSByb290LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBwYW5lbERyYWcgPSB7XG4gICAgcG9pbnRlcklkOiBldmVudC5wb2ludGVySWQsXG4gICAgb2Zmc2V0WDogZXZlbnQuY2xpZW50WCAtIHJlY3QubGVmdCxcbiAgICBvZmZzZXRZOiBldmVudC5jbGllbnRZIC0gcmVjdC50b3AsXG4gICAgd2lkdGg6IHJlY3Qud2lkdGgsXG4gICAgaGVpZ2h0OiByZWN0LmhlaWdodCxcbiAgfTtcbiAgcm9vdC5jbGFzc0xpc3QuYWRkKFwiaXMtZHJhZ2dpbmdcIik7XG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgbW92ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxEcmFnKTtcbn1cblxuZnVuY3Rpb24gbW92ZUdvYWxQYW5lbChldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmICghcGFuZWxEcmFnIHx8IGV2ZW50LnBvaW50ZXJJZCAhPT0gcGFuZWxEcmFnLnBvaW50ZXJJZCB8fCAhcm9vdCkgcmV0dXJuO1xuICBwYW5lbFN0YXRlID0ge1xuICAgIC4uLnBhbmVsU3RhdGUsXG4gICAgeDogY2xhbXAoZXZlbnQuY2xpZW50WCAtIHBhbmVsRHJhZy5vZmZzZXRYLCA4LCB3aW5kb3cuaW5uZXJXaWR0aCAtIHBhbmVsRHJhZy53aWR0aCAtIDgpLFxuICAgIHk6IGNsYW1wKGV2ZW50LmNsaWVudFkgLSBwYW5lbERyYWcub2Zmc2V0WSwgOCwgd2luZG93LmlubmVySGVpZ2h0IC0gcGFuZWxEcmFnLmhlaWdodCAtIDgpLFxuICB9O1xuICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xufVxuXG5mdW5jdGlvbiBzdG9wR29hbFBhbmVsRHJhZyhldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbERyYWcgJiYgZXZlbnQucG9pbnRlcklkICE9PSBwYW5lbERyYWcucG9pbnRlcklkKSByZXR1cm47XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgbW92ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxEcmFnKTtcbiAgaWYgKHJvb3QpIHJvb3QuY2xhc3NMaXN0LnJlbW92ZShcImlzLWRyYWdnaW5nXCIpO1xuICBwYW5lbERyYWcgPSBudWxsO1xuICBpZiAocm9vdCkgY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KHJvb3QpO1xuICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbn1cblxuZnVuY3Rpb24gcmVzZXRHb2FsUGFuZWxQb3NpdGlvbihldmVudDogTW91c2VFdmVudCk6IHZvaWQge1xuICBpZiAoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCAmJiBldmVudC50YXJnZXQuY2xvc2VzdChcImJ1dHRvblwiKSkgcmV0dXJuO1xuICBwYW5lbFN0YXRlID0geyAuLi5wYW5lbFN0YXRlLCB4OiBudWxsLCB5OiBudWxsIH07XG4gIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xuICBpZiAocm9vdCkgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkge1xuICAgIGVsZW1lbnQuc3R5bGUubGVmdCA9IFwiYXV0b1wiO1xuICAgIGVsZW1lbnQuc3R5bGUudG9wID0gXCJhdXRvXCI7XG4gICAgZWxlbWVudC5zdHlsZS5yaWdodCA9IFwiMThweFwiO1xuICAgIGVsZW1lbnQuc3R5bGUuYm90dG9tID0gXCI3NnB4XCI7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChlbGVtZW50KTtcbiAgZWxlbWVudC5zdHlsZS5yaWdodCA9IFwiYXV0b1wiO1xuICBlbGVtZW50LnN0eWxlLmJvdHRvbSA9IFwiYXV0b1wiO1xuICBlbGVtZW50LnN0eWxlLmxlZnQgPSBgJHtwYW5lbFN0YXRlLnh9cHhgO1xuICBlbGVtZW50LnN0eWxlLnRvcCA9IGAke3BhbmVsU3RhdGUueX1weGA7XG59XG5cbmZ1bmN0aW9uIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgcGFuZWxTdGF0ZSA9IHtcbiAgICAuLi5wYW5lbFN0YXRlLFxuICAgIHg6IGNsYW1wKHBhbmVsU3RhdGUueCwgOCwgd2luZG93LmlubmVyV2lkdGggLSByZWN0LndpZHRoIC0gOCksXG4gICAgeTogY2xhbXAocGFuZWxTdGF0ZS55LCA4LCB3aW5kb3cuaW5uZXJIZWlnaHQgLSByZWN0LmhlaWdodCAtIDgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZWFkR29hbFBhbmVsU3RhdGUoKTogR29hbFBhbmVsU3RhdGUge1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oR09BTF9QQU5FTF9TVEFURV9LRVkpID8/IFwie31cIikgYXMgUGFydGlhbDxHb2FsUGFuZWxTdGF0ZT47XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbGxhcHNlZDogcGFyc2VkLmNvbGxhcHNlZCA9PT0gdHJ1ZSxcbiAgICAgIHg6IHR5cGVvZiBwYXJzZWQueCA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkLngpID8gcGFyc2VkLnggOiBudWxsLFxuICAgICAgeTogdHlwZW9mIHBhcnNlZC55ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShwYXJzZWQueSkgPyBwYXJzZWQueSA6IG51bGwsXG4gICAgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgY29sbGFwc2VkOiBmYWxzZSwgeDogbnVsbCwgeTogbnVsbCB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVHb2FsUGFuZWxTdGF0ZSgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShHT0FMX1BBTkVMX1NUQVRFX0tFWSwgSlNPTi5zdHJpbmdpZnkocGFuZWxTdGF0ZSkpO1xuICB9IGNhdGNoIHt9XG59XG5cbmZ1bmN0aW9uIGNsYW1wKHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChtYXggPCBtaW4pIHJldHVybiBtaW47XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heCh2YWx1ZSwgbWluKSwgbWF4KTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlU3VnZ2VzdGlvblJvb3QoKTogSFRNTERpdkVsZW1lbnQgfCBudWxsIHtcbiAgaWYgKHN1Z2dlc3Rpb25Sb290Py5pc0Nvbm5lY3RlZCkgcmV0dXJuIHN1Z2dlc3Rpb25Sb290O1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5ib2R5IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKCFwYXJlbnQpIHJldHVybiBudWxsO1xuICBzdWdnZXN0aW9uUm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN1Z2dlc3Rpb25Sb290LmlkID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1yb290XCI7XG4gIHN1Z2dlc3Rpb25Sb290LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgcGFyZW50LmFwcGVuZENoaWxkKHN1Z2dlc3Rpb25Sb290KTtcbiAgcmV0dXJuIHN1Z2dlc3Rpb25Sb290O1xufVxuXG5mdW5jdGlvbiB1cGRhdGVHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQgfCBudWxsKTogdm9pZCB7XG4gIGlmICghZWRpdGFibGUpIHtcbiAgICBoaWRlR29hbFN1Z2dlc3Rpb24oKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc3VnZ2VzdGlvbiA9IHBhcnNlR29hbFN1Z2dlc3Rpb24oZWRpdGFibGUuZ2V0VGV4dCgpKTtcbiAgaWYgKCFzdWdnZXN0aW9uKSB7XG4gICAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJlbmRlckdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLCBzdWdnZXN0aW9uLnF1ZXJ5KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyR29hbFN1Z2dlc3Rpb24oZWRpdGFibGU6IEVkaXRhYmxlVGFyZ2V0LCBxdWVyeTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGVsID0gZW5zdXJlU3VnZ2VzdGlvblJvb3QoKTtcbiAgaWYgKCFlbCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gZWRpdGFibGUuZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbig0MjAsIE1hdGgubWF4KDI4MCwgcmVjdC53aWR0aCB8fCAzMjApKTtcbiAgY29uc3QgbGVmdCA9IE1hdGgubWF4KDEyLCBNYXRoLm1pbihyZWN0LmxlZnQsIHdpbmRvdy5pbm5lcldpZHRoIC0gd2lkdGggLSAxMikpO1xuICBjb25zdCB0b3AgPSBNYXRoLm1heCgxMiwgcmVjdC50b3AgLSA2Nik7XG5cbiAgZWwuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvblwiO1xuICBlbC5zdHlsZS5sZWZ0ID0gYCR7bGVmdH1weGA7XG4gIGVsLnN0eWxlLnRvcCA9IGAke3RvcH1weGA7XG4gIGVsLnN0eWxlLndpZHRoID0gYCR7d2lkdGh9cHhgO1xuXG4gIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBpdGVtLnR5cGUgPSBcImJ1dHRvblwiO1xuICBpdGVtLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbVwiO1xuICBpdGVtLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJHb2FsIGNvbW1hbmRcIik7XG4gIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlZG93blwiLCAoZXZlbnQpID0+IHtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGUpO1xuICB9KTtcblxuICBjb25zdCBjb21tYW5kID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbW1hbmQuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1jb21tYW5kXCI7XG4gIGNvbW1hbmQudGV4dENvbnRlbnQgPSBcIi9nb2FsXCI7XG4gIGlmIChxdWVyeSkge1xuICAgIGNvbW1hbmQuZGF0YXNldC5xdWVyeSA9IHF1ZXJ5O1xuICB9XG5cbiAgY29uc3QgZGV0YWlsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGRldGFpbC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWRldGFpbFwiO1xuICBkZXRhaWwudGV4dENvbnRlbnQgPSBcIlNldCwgdmlldywgcGF1c2UsIHJlc3VtZSwgY29tcGxldGUsIG9yIGNsZWFyIHRoaXMgdGhyZWFkIGdvYWxcIjtcblxuICBpdGVtLmFwcGVuZChjb21tYW5kLCBkZXRhaWwpO1xuICBlbC5hcHBlbmRDaGlsZChpdGVtKTtcbiAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQpOiB2b2lkIHtcbiAgZWRpdGFibGUuc2V0VGV4dChcIi9nb2FsIFwiKTtcbiAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG59XG5cbmZ1bmN0aW9uIGhpZGVHb2FsU3VnZ2VzdGlvbigpOiB2b2lkIHtcbiAgaWYgKHN1Z2dlc3Rpb25Sb290KSBzdWdnZXN0aW9uUm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxTdHlsZXMoKTogdm9pZCB7XG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNvZGV4cHAtZ29hbC1zdHlsZVwiKSkgcmV0dXJuO1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5oZWFkIHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKCFwYXJlbnQpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCAoKSA9PiBpbnN0YWxsU3R5bGVzKCksIHsgb25jZTogdHJ1ZSB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcbiAgc3R5bGUuaWQgPSBcImNvZGV4cHAtZ29hbC1zdHlsZVwiO1xuICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiNjb2RleHBwLWdvYWwtcm9vdCB7XG4gIHBvc2l0aW9uOiBmaXhlZDtcbiAgcmlnaHQ6IDE4cHg7XG4gIGJvdHRvbTogNzZweDtcbiAgei1pbmRleDogMjE0NzQ4MzY0NztcbiAgd2lkdGg6IG1pbig0MjBweCwgY2FsYygxMDB2dyAtIDM2cHgpKTtcbiAgZm9udDogMTNweC8xLjQgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBcIlNlZ29lIFVJXCIsIHNhbnMtc2VyaWY7XG4gIGNvbG9yOiB2YXIoLS10ZXh0LXByaW1hcnksICNmNWY3ZmIpO1xufVxuI2NvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLXJvb3Qge1xuICBwb3NpdGlvbjogZml4ZWQ7XG4gIHotaW5kZXg6IDIxNDc0ODM2NDc7XG4gIGZvbnQ6IDEzcHgvMS4zNSAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIFwiU2Vnb2UgVUlcIiwgc2Fucy1zZXJpZjtcbiAgY29sb3I6IHZhcigtLXRleHQtcHJpbWFyeSwgI2Y1ZjdmYik7XG59XG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24ge1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xuICBib3JkZXItcmFkaXVzOiA4cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjQsIDI3LCAzMywgMC45OCk7XG4gIGJveC1zaGFkb3c6IDAgMTZweCA0NnB4IHJnYmEoMCwwLDAsMC4zMik7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIGJhY2tkcm9wLWZpbHRlcjogYmx1cigxNHB4KTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1pdGVtIHtcbiAgd2lkdGg6IDEwMCU7XG4gIGJvcmRlcjogMDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBkaXNwbGF5OiBncmlkO1xuICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IGF1dG8gMWZyO1xuICBnYXA6IDEycHg7XG4gIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gIHBhZGRpbmc6IDEwcHggMTJweDtcbiAgdGV4dC1hbGlnbjogbGVmdDtcbiAgY3Vyc29yOiBwb2ludGVyO1xufVxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWl0ZW06aG92ZXIsXG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbTpmb2N1cy12aXNpYmxlIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjA5KTtcbiAgb3V0bGluZTogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1jb21tYW5kIHtcbiAgZm9udC1mYW1pbHk6IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIFwiU0YgTW9ub1wiLCBNZW5sbywgbW9ub3NwYWNlO1xuICBmb250LXdlaWdodDogNjUwO1xuICBjb2xvcjogIzlmYzVmZjtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1kZXRhaWwge1xuICBtaW4td2lkdGg6IDA7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjcyKTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwge1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTYpO1xuICBib3JkZXItcmFkaXVzOiA4cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjYsIDI5LCAzNSwgMC45Nik7XG4gIGJveC1zaGFkb3c6IDAgMThweCA2MHB4IHJnYmEoMCwwLDAsMC4zNCk7XG4gIHBhZGRpbmc6IDEycHg7XG4gIGJhY2tkcm9wLWZpbHRlcjogYmx1cigxNHB4KTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtZHJhZ2dpbmcge1xuICBjdXJzb3I6IGdyYWJiaW5nO1xuICB1c2VyLXNlbGVjdDogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtY29sbGFwc2VkIHtcbiAgd2lkdGg6IG1pbigzMjBweCwgY2FsYygxMDB2dyAtIDM2cHgpKTtcbiAgcGFkZGluZzogMTBweCAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbC5pcy1lcnJvciB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsIDEyMiwgMTIyLCAwLjU1KTtcbn1cbi5jb2RleHBwLWdvYWwtaGVhZGVyIHtcbiAgZGlzcGxheTogZmxleDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuICBnYXA6IDEycHg7XG4gIGZvbnQtd2VpZ2h0OiA2NTA7XG4gIGN1cnNvcjogZ3JhYjtcbiAgdXNlci1zZWxlY3Q6IG5vbmU7XG59XG4uY29kZXhwcC1nb2FsLXRpdGxlIHtcbiAgbWluLXdpZHRoOiAwO1xuICBvdmVyZmxvdzogaGlkZGVuO1xuICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbn1cbi5jb2RleHBwLWdvYWwtY29udHJvbHMge1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LXNocmluazogMDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgZ2FwOiA0cHg7XG59XG4uY29kZXhwcC1nb2FsLWljb24ge1xuICB3aWR0aDogMjRweDtcbiAgaGVpZ2h0OiAyNHB4O1xuICBib3JkZXI6IDA7XG4gIGJvcmRlci1yYWRpdXM6IDZweDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBjdXJzb3I6IHBvaW50ZXI7XG4gIGxpbmUtaGVpZ2h0OiAxO1xufVxuLmNvZGV4cHAtZ29hbC1pY29uOmhvdmVyIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjEpO1xufVxuLmNvZGV4cHAtZ29hbC1kZXRhaWwge1xuICBtYXJnaW4tdG9wOiA4cHg7XG4gIG1heC1oZWlnaHQ6IDk2cHg7XG4gIG92ZXJmbG93OiBhdXRvO1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjkpO1xuICB3b3JkLWJyZWFrOiBicmVhay13b3JkO1xufVxuLmNvZGV4cHAtZ29hbC1mb290ZXIge1xuICBtYXJnaW4tdG9wOiA4cHg7XG4gIGNvbG9yOiByZ2JhKDI0NSwyNDcsMjUxLDAuNjIpO1xuICBmb250LXNpemU6IDEycHg7XG59XG4uY29kZXhwcC1nb2FsLWFjdGlvbnMge1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LXdyYXA6IHdyYXA7XG4gIGdhcDogOHB4O1xuICBtYXJnaW4tdG9wOiAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24ge1xuICBtaW4taGVpZ2h0OiAyOHB4O1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xuICBib3JkZXItcmFkaXVzOiA3cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4wOCk7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBwYWRkaW5nOiA0cHggMTBweDtcbiAgY3Vyc29yOiBwb2ludGVyO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb246aG92ZXIge1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24ucHJpbWFyeSB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgxMjUsIDE4MCwgMjU1LCAwLjU1KTtcbiAgYmFja2dyb3VuZDogcmdiYSg3NCwgMTIxLCAyMTYsIDAuNDIpO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24uZGFuZ2VyIHtcbiAgYm9yZGVyLWNvbG9yOiByZ2JhKDI1NSwgMTIyLCAxMjIsIDAuNDgpO1xufVxuYDtcbiAgcGFyZW50LmFwcGVuZENoaWxkKHN0eWxlKTtcbn1cblxuZnVuY3Rpb24gZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50OiBFdmVudCk6IEVkaXRhYmxlVGFyZ2V0IHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSB0eXBlb2YgZXZlbnQuY29tcG9zZWRQYXRoID09PSBcImZ1bmN0aW9uXCIgPyBldmVudC5jb21wb3NlZFBhdGgoKSA6IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGF0aCkge1xuICAgIGlmICghKGl0ZW0gaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGVkaXRhYmxlID0gZWRpdGFibGVGb3JFbGVtZW50KGl0ZW0pO1xuICAgIGlmIChlZGl0YWJsZSkgcmV0dXJuIGVkaXRhYmxlO1xuICB9XG4gIHJldHVybiBldmVudC50YXJnZXQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IGVkaXRhYmxlRm9yRWxlbWVudChldmVudC50YXJnZXQpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gZWRpdGFibGVGb3JFbGVtZW50KGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogRWRpdGFibGVUYXJnZXQgfCBudWxsIHtcbiAgaWYgKGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MVGV4dEFyZWFFbGVtZW50IHx8IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50KSB7XG4gICAgY29uc3QgdHlwZSA9IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50ID8gZWxlbWVudC50eXBlIDogXCJ0ZXh0YXJlYVwiO1xuICAgIGlmICghW1widGV4dFwiLCBcInNlYXJjaFwiLCBcInRleHRhcmVhXCJdLmluY2x1ZGVzKHR5cGUpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgZWxlbWVudCxcbiAgICAgIGdldFRleHQ6ICgpID0+IGVsZW1lbnQudmFsdWUsXG4gICAgICBzZXRUZXh0OiAodmFsdWUpID0+IHtcbiAgICAgICAgZWxlbWVudC52YWx1ZSA9IHZhbHVlO1xuICAgICAgICBlbGVtZW50LmZvY3VzKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZWxlbWVudC5zZXRTZWxlY3Rpb25SYW5nZSh2YWx1ZS5sZW5ndGgsIHZhbHVlLmxlbmd0aCk7XG4gICAgICAgIH0gY2F0Y2gge31cbiAgICAgICAgZWxlbWVudC5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiaW5zZXJ0VGV4dFwiLCBkYXRhOiB2YWx1ZSB9KSk7XG4gICAgICB9LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgZWxlbWVudC52YWx1ZSA9IFwiXCI7XG4gICAgICAgIGVsZW1lbnQuZGlzcGF0Y2hFdmVudChuZXcgSW5wdXRFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSwgaW5wdXRUeXBlOiBcImRlbGV0ZUNvbnRlbnRCYWNrd2FyZFwiIH0pKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGVkaXRhYmxlID0gZWxlbWVudC5pc0NvbnRlbnRFZGl0YWJsZVxuICAgID8gZWxlbWVudFxuICAgIDogZWxlbWVudC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0sIFtyb2xlPVwidGV4dGJveFwiXScpO1xuICBpZiAoIWVkaXRhYmxlKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICBlbGVtZW50OiBlZGl0YWJsZSxcbiAgICBnZXRUZXh0OiAoKSA9PiBlZGl0YWJsZS5pbm5lclRleHQgfHwgZWRpdGFibGUudGV4dENvbnRlbnQgfHwgXCJcIixcbiAgICBzZXRUZXh0OiAodmFsdWUpID0+IHtcbiAgICAgIGVkaXRhYmxlLnRleHRDb250ZW50ID0gdmFsdWU7XG4gICAgICBlZGl0YWJsZS5mb2N1cygpO1xuICAgICAgcGxhY2VDYXJldEF0RW5kKGVkaXRhYmxlKTtcbiAgICAgIGVkaXRhYmxlLmRpc3BhdGNoRXZlbnQobmV3IElucHV0RXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUsIGlucHV0VHlwZTogXCJpbnNlcnRUZXh0XCIsIGRhdGE6IHZhbHVlIH0pKTtcbiAgICB9LFxuICAgIGNsZWFyOiAoKSA9PiB7XG4gICAgICBlZGl0YWJsZS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBlZGl0YWJsZS5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiZGVsZXRlQ29udGVudEJhY2t3YXJkXCIgfSkpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHBsYWNlQ2FyZXRBdEVuZChlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBzZWxlY3Rpb24gPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7XG4gIGlmICghc2VsZWN0aW9uKSByZXR1cm47XG4gIGNvbnN0IHJhbmdlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTtcbiAgcmFuZ2Uuc2VsZWN0Tm9kZUNvbnRlbnRzKGVsZW1lbnQpO1xuICByYW5nZS5jb2xsYXBzZShmYWxzZSk7XG4gIHNlbGVjdGlvbi5yZW1vdmVBbGxSYW5nZXMoKTtcbiAgc2VsZWN0aW9uLmFkZFJhbmdlKHJhbmdlKTtcbn1cblxuZnVuY3Rpb24gcmVhZFRocmVhZElkKCk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtsb2NhdGlvbi5wYXRobmFtZSwgbG9jYXRpb24uaGFzaCwgbG9jYXRpb24uaHJlZl07XG4gIHRyeSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcbiAgICBjb25zdCBpbml0aWFsUm91dGUgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImluaXRpYWxSb3V0ZVwiKTtcbiAgICBpZiAoaW5pdGlhbFJvdXRlKSBjYW5kaWRhdGVzLnB1c2goaW5pdGlhbFJvdXRlKTtcbiAgfSBjYXRjaCB7fVxuICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyhoaXN0b3J5LnN0YXRlKSk7XG4gIGNhbmRpZGF0ZXMucHVzaCguLi5jb2xsZWN0RG9tVGhyZWFkQ2FuZGlkYXRlcygpKTtcblxuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgdGhyZWFkSWQgPSBub3JtYWxpemVUaHJlYWRJZChjYW5kaWRhdGUpO1xuICAgIGlmICh0aHJlYWRJZCkgcmV0dXJuIHRocmVhZElkO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUaHJlYWRJZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGRlY29kZWQgPSBzYWZlRGVjb2RlKHZhbHVlKS50cmltKCk7XG4gIGNvbnN0IHJvdXRlTWF0Y2ggPSBkZWNvZGVkLm1hdGNoKC9cXC9sb2NhbFxcLyhbXi8/I1xcc10rKS8pO1xuICBpZiAocm91dGVNYXRjaD8uWzFdKSB7XG4gICAgY29uc3QgZnJvbVJvdXRlID0gbm9ybWFsaXplVGhyZWFkSWRUb2tlbihyb3V0ZU1hdGNoWzFdKTtcbiAgICBpZiAoZnJvbVJvdXRlKSByZXR1cm4gZnJvbVJvdXRlO1xuICB9XG5cbiAgY29uc3QgdG9rZW5NYXRjaCA9IGRlY29kZWQubWF0Y2goL1xcYig/OlthLXpdW1xcdy4tXSo6KSooWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9KVxcYi9pKTtcbiAgaWYgKHRva2VuTWF0Y2g/LlsxXSkgcmV0dXJuIHRva2VuTWF0Y2hbMV07XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVRocmVhZElkVG9rZW4odmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBkZWNvZGVkID0gc2FmZURlY29kZSh2YWx1ZSkudHJpbSgpO1xuICBjb25zdCBtYXRjaCA9IGRlY29kZWQubWF0Y2goLyg/Ol58OikoWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9KSQvaSk7XG4gIHJldHVybiBtYXRjaD8uWzFdID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3REb21UaHJlYWRDYW5kaWRhdGVzKCk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc2VsZWN0b3JzID0gW1xuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLXJvd11bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT1cInRydWVcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtcm93XVthcmlhLWN1cnJlbnQ9XCJwYWdlXCJdW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1pZF0nLFxuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT1cInRydWVcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRdW2FyaWEtY3VycmVudD1cInBhZ2VcIl0nLFxuICBdO1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIHNlbGVjdG9ycykge1xuICAgIGZvciAoY29uc3QgZWxlbWVudCBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KHNlbGVjdG9yKSkpIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRcIik7XG4gICAgICBpZiAodmFsdWUpIGNhbmRpZGF0ZXMucHVzaCh2YWx1ZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBjYW5kaWRhdGVzO1xufVxuXG5mdW5jdGlvbiBzYWZlRGVjb2RlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyh2YWx1ZTogdW5rbm93biwgZGVwdGggPSAwLCBzZWVuID0gbmV3IFNldDx1bmtub3duPigpKTogc3RyaW5nW10ge1xuICBpZiAoZGVwdGggPiA1IHx8IHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQgfHwgc2Vlbi5oYXModmFsdWUpKSByZXR1cm4gW107XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHJldHVybiBub3JtYWxpemVUaHJlYWRJZCh2YWx1ZSkgPyBbdmFsdWVdIDogW107XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBbXTtcbiAgc2Vlbi5hZGQodmFsdWUpO1xuXG4gIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgT2JqZWN0LnZhbHVlcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyhjaGlsZCwgZGVwdGggKyAxLCBzZWVuKSk7XG4gIH1cbiAgcmV0dXJuIGNhbmRpZGF0ZXM7XG59XG5cbmZ1bmN0aW9uIGdvYWxTdGF0dXNMYWJlbChzdGF0dXM6IEdvYWxTdGF0dXMpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHN0YXR1cykge1xuICAgIGNhc2UgXCJhY3RpdmVcIjpcbiAgICAgIHJldHVybiBcImFjdGl2ZVwiO1xuICAgIGNhc2UgXCJwYXVzZWRcIjpcbiAgICAgIHJldHVybiBcInBhdXNlZFwiO1xuICAgIGNhc2UgXCJidWRnZXRMaW1pdGVkXCI6XG4gICAgICByZXR1cm4gXCJsaW1pdGVkIGJ5IGJ1ZGdldFwiO1xuICAgIGNhc2UgXCJjb21wbGV0ZVwiOlxuICAgICAgcmV0dXJuIFwiY29tcGxldGVcIjtcbiAgfVxufVxuXG5mdW5jdGlvbiBmcmllbmRseUdvYWxFcnJvcihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIGNvbnN0IG1lc3NhZ2UgPSBzdHJpbmdpZnlFcnJvcihlcnJvcik7XG4gIGlmICgvZ29hbHMgZmVhdHVyZSBpcyBkaXNhYmxlZC9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGUgYXBwLXNlcnZlciBoYXMgZ29hbCBzdXBwb3J0LCBidXQgW2ZlYXR1cmVzXS5nb2FscyBpcyBkaXNhYmxlZCBpbiB+Ly5jb2RleC9jb25maWcudG9tbC5cIjtcbiAgfVxuICBpZiAoL3JlcXVpcmVzIGV4cGVyaW1lbnRhbEFwaS9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGUgYXBwLXNlcnZlciByZWplY3RlZCB0aHJlYWQvZ29hbC8qIGJlY2F1c2UgdGhlIGFjdGl2ZSBEZXNrdG9wIGNsaWVudCBkaWQgbm90IG5lZ290aWF0ZSBleHBlcmltZW50YWxBcGkuXCI7XG4gIH1cbiAgaWYgKC91bmtub3dufHVuc3VwcG9ydGVkfG5vdCBmb3VuZHxubyBoYW5kbGVyfGludmFsaWQgcmVxdWVzdHxkZXNlcmlhbGl6ZXx0aHJlYWRcXC9nb2FsL2kudGVzdChtZXNzYWdlKSkge1xuICAgIHJldHVybiBcIlRoaXMgQ29kZXguYXBwIGFwcC1zZXJ2ZXIgZG9lcyBub3Qgc3VwcG9ydCB0aHJlYWQvZ29hbC8qIHlldC4gVXBkYXRlIG9yIHJlcGF0Y2ggQ29kZXguYXBwIHdpdGggYSBidWlsZCB0aGF0IGluY2x1ZGVzIHRoZSBnb2FscyBmZWF0dXJlLlwiO1xuICB9XG4gIHJldHVybiBtZXNzYWdlO1xufVxuXG5mdW5jdGlvbiBmb3JtYXREdXJhdGlvbihzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShzZWNvbmRzKSB8fCBzZWNvbmRzIDw9IDApIHJldHVybiBcIjBzXCI7XG4gIGNvbnN0IG1pbnV0ZXMgPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIGNvbnN0IHJlbWFpbmluZ1NlY29uZHMgPSBNYXRoLmZsb29yKHNlY29uZHMgJSA2MCk7XG4gIGlmIChtaW51dGVzIDw9IDApIHJldHVybiBgJHtyZW1haW5pbmdTZWNvbmRzfXNgO1xuICBjb25zdCBob3VycyA9IE1hdGguZmxvb3IobWludXRlcyAvIDYwKTtcbiAgY29uc3QgcmVtYWluaW5nTWludXRlcyA9IG1pbnV0ZXMgJSA2MDtcbiAgaWYgKGhvdXJzIDw9IDApIHJldHVybiBgJHttaW51dGVzfW0gJHtyZW1haW5pbmdTZWNvbmRzfXNgO1xuICByZXR1cm4gYCR7aG91cnN9aCAke3JlbWFpbmluZ01pbnV0ZXN9bWA7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdE51bWJlcih2YWx1ZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBNYXRoLnJvdW5kKHZhbHVlKS50b0xvY2FsZVN0cmluZygpIDogXCIwXCI7XG59XG5cbmZ1bmN0aW9uIHRydW5jYXRlKHZhbHVlOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLmxlbmd0aCA8PSBtYXhMZW5ndGggPyB2YWx1ZSA6IGAke3ZhbHVlLnNsaWNlKDAsIG1heExlbmd0aCAtIDEpfS4uLmA7XG59XG5cbmZ1bmN0aW9uIHN0cmluZ2lmeUVycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuZnVuY3Rpb24gaXNUaHJlYWRHb2FsKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgVGhyZWFkR29hbCB7XG4gIHJldHVybiBpc1JlY29yZCh2YWx1ZSkgJiZcbiAgICB0eXBlb2YgdmFsdWUudGhyZWFkSWQgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgdmFsdWUub2JqZWN0aXZlID09PSBcInN0cmluZ1wiICYmXG4gICAgdHlwZW9mIHZhbHVlLnN0YXR1cyA9PT0gXCJzdHJpbmdcIjtcbn1cblxuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB2YWx1ZSAhPT0gbnVsbCAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBV0EsSUFBQUEsbUJBQTRCOzs7QUM2QnJCLFNBQVMsbUJBQXlCO0FBQ3ZDLE1BQUksT0FBTywrQkFBZ0M7QUFDM0MsUUFBTSxZQUFZLG9CQUFJLElBQStCO0FBQ3JELE1BQUksU0FBUztBQUNiLFFBQU0sWUFBWSxvQkFBSSxJQUE0QztBQUVsRSxRQUFNLE9BQTBCO0FBQUEsSUFDOUIsZUFBZTtBQUFBLElBQ2Y7QUFBQSxJQUNBLE9BQU8sVUFBVTtBQUNmLFlBQU0sS0FBSztBQUNYLGdCQUFVLElBQUksSUFBSSxRQUFRO0FBRTFCLGNBQVE7QUFBQSxRQUNOO0FBQUEsUUFDQSxTQUFTO0FBQUEsUUFDVCxTQUFTO0FBQUEsTUFDWDtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxHQUFHLE9BQU8sSUFBSTtBQUNaLFVBQUksSUFBSSxVQUFVLElBQUksS0FB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QUFDakIsVUFBUSxzQkFBc0I7QUFDaEMsU0FBUyxHQUFHO0FBQ1YsVUFBUSxxQkFBcUIsT0FBTyxDQUFDLENBQUM7QUFDeEM7QUFFQSxJQUFJO0FBQ0YsbUJBQWlCLE9BQU87QUFDMUIsU0FBUyxHQUFHO0FBQ1YsVUFBUSx1QkFBdUIsT0FBTyxDQUFDLENBQUM7QUFDMUM7QUFFQSxlQUFlLE1BQU07QUFDbkIsTUFBSSxTQUFTLGVBQWUsV0FBVztBQUNyQyxhQUFTLGlCQUFpQixvQkFBb0IsTUFBTSxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDcEUsT0FBTztBQUNMLFNBQUs7QUFBQSxFQUNQO0FBQ0YsQ0FBQztBQUVELGVBQWUsT0FBTztBQUNwQixVQUFRLGNBQWMsRUFBRSxZQUFZLFNBQVMsV0FBVyxDQUFDO0FBQ3pELE1BQUk7QUFDRiwwQkFBc0I7QUFDdEIsWUFBUSwyQkFBMkI7QUFDbkMsVUFBTSxlQUFlO0FBQ3JCLFlBQVEsb0JBQW9CO0FBQzVCLFVBQU0sYUFBYTtBQUNuQixZQUFRLGlCQUFpQjtBQUN6QixvQkFBZ0I7QUFDaEIsWUFBUSxlQUFlO0FBQUEsRUFDekIsU0FBUyxHQUFHO0FBQ1YsWUFBUSxlQUFlLE9BQVEsR0FBYSxTQUFTLENBQUMsQ0FBQztBQUN2RCxZQUFRLE1BQU0seUNBQXlDLENBQUM7QUFBQSxFQUMxRDtBQUNGO0FBSUEsSUFBSSxZQUFrQztBQUN0QyxTQUFTLGtCQUF3QjtBQUMvQiwrQkFBWSxHQUFHLDBCQUEwQixNQUFNO0FBQzdDLFFBQUksVUFBVztBQUNmLGlCQUFhLFlBQVk7QUFDdkIsVUFBSTtBQUNGLGdCQUFRLEtBQUssdUNBQXVDO0FBQ3BELDBCQUFrQjtBQUNsQixjQUFNLGVBQWU7QUFDckIsY0FBTSxhQUFhO0FBQUEsTUFDckIsU0FBUyxHQUFHO0FBQ1YsZ0JBQVEsTUFBTSx1Q0FBdUMsQ0FBQztBQUFBLE1BQ3hELFVBQUU7QUFDQSxvQkFBWTtBQUFBLE1BQ2Q7QUFBQSxJQUNGLEdBQUc7QUFBQSxFQUNMLENBQUM7QUFDSDsiLAogICJuYW1lcyI6IFsiaW1wb3J0X2VsZWN0cm9uIiwgInJvb3QiLCAiY2FyZCIsICJpbXBvcnRfZWxlY3Ryb24iLCAibW9kdWxlIiwgImV4cG9ydHMiLCAiaW1wb3J0X2VsZWN0cm9uIiwgInJvb3QiLCAiaW1wb3J0X2VsZWN0cm9uIiwgImlzUmVjb3JkIiwgInJlc3BvbnNlIiwgImJ1dHRvbiIsICJzYWZlU3RyaW5naWZ5Il0KfQo=
