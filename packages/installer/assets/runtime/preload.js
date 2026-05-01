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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL21hbmFnZXIudHMiLCAiLi4vc3JjL3ByZWxvYWQvYXBwLXNlcnZlci1icmlkZ2UudHMiLCAiLi4vc3JjL3ByZWxvYWQvZ29hbC1mZWF0dXJlLnRzIiwgIi4uL3NyYy9wcmVsb2FkL2dpdC1zaWRlYmFyLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlbmRlcmVyIHByZWxvYWQgZW50cnkuIFJ1bnMgaW4gYW4gaXNvbGF0ZWQgd29ybGQgYmVmb3JlIENvZGV4J3MgcGFnZSBKUy5cbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAgIDEuIEluc3RhbGwgYSBSZWFjdCBEZXZUb29scy1zaGFwZWQgZ2xvYmFsIGhvb2sgdG8gY2FwdHVyZSB0aGUgcmVuZGVyZXJcbiAqICAgICAgcmVmZXJlbmNlIHdoZW4gUmVhY3QgbW91bnRzLiBXZSB1c2UgdGhpcyBmb3IgZmliZXIgd2Fsa2luZy5cbiAqICAgMi4gQWZ0ZXIgRE9NQ29udGVudExvYWRlZCwga2ljayBvZmYgc2V0dGluZ3MtaW5qZWN0aW9uIGxvZ2ljLlxuICogICAzLiBEaXNjb3ZlciByZW5kZXJlci1zY29wZWQgdHdlYWtzICh2aWEgSVBDIHRvIG1haW4pIGFuZCBzdGFydCB0aGVtLlxuICogICA0LiBMaXN0ZW4gZm9yIGBjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkYCBmcm9tIG1haW4gKGZpbGVzeXN0ZW0gd2F0Y2hlcikgYW5kXG4gKiAgICAgIGhvdC1yZWxvYWQgdHdlYWtzIHdpdGhvdXQgZHJvcHBpbmcgdGhlIHBhZ2UuXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IGluc3RhbGxSZWFjdEhvb2sgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgeyBzdGFydFNldHRpbmdzSW5qZWN0b3IgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgc3RhcnRUd2Vha0hvc3QsIHRlYXJkb3duVHdlYWtIb3N0IH0gZnJvbSBcIi4vdHdlYWstaG9zdFwiO1xuaW1wb3J0IHsgbW91bnRNYW5hZ2VyIH0gZnJvbSBcIi4vbWFuYWdlclwiO1xuaW1wb3J0IHsgc3RhcnRHb2FsRmVhdHVyZSB9IGZyb20gXCIuL2dvYWwtZmVhdHVyZVwiO1xuaW1wb3J0IHsgc3RhcnRHaXRTaWRlYmFyIH0gZnJvbSBcIi4vZ2l0LXNpZGViYXJcIjtcblxuLy8gRmlsZS1sb2cgcHJlbG9hZCBwcm9ncmVzcyBzbyB3ZSBjYW4gZGlhZ25vc2Ugd2l0aG91dCBEZXZUb29scy4gQmVzdC1lZmZvcnQ6XG4vLyBmYWlsdXJlcyBoZXJlIG11c3QgbmV2ZXIgdGhyb3cgYmVjYXVzZSB3ZSdkIHRha2UgdGhlIHBhZ2UgZG93biB3aXRoIHVzLlxuLy9cbi8vIENvZGV4J3MgcmVuZGVyZXIgaXMgc2FuZGJveGVkIChzYW5kYm94OiB0cnVlKSwgc28gYHJlcXVpcmUoXCJub2RlOmZzXCIpYCBpc1xuLy8gdW5hdmFpbGFibGUuIFdlIGZvcndhcmQgbG9nIGxpbmVzIHRvIG1haW4gdmlhIElQQzsgbWFpbiB3cml0ZXMgdGhlIGZpbGUuXG5mdW5jdGlvbiBmaWxlTG9nKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBgW2NvZGV4LXBsdXNwbHVzIHByZWxvYWRdICR7c3RhZ2V9JHtcbiAgICBleHRyYSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IFwiIFwiICsgc2FmZVN0cmluZ2lmeShleHRyYSlcbiAgfWA7XG4gIHRyeSB7XG4gICAgY29uc29sZS5lcnJvcihtc2cpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChcImNvZGV4cHA6cHJlbG9hZC1sb2dcIiwgXCJpbmZvXCIsIG1zZyk7XG4gIH0gY2F0Y2gge31cbn1cbmZ1bmN0aW9uIHNhZmVTdHJpbmdpZnkodjogdW5rbm93bik6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gU3RyaW5nKHYpO1xuICB9XG59XG5cbmZpbGVMb2coXCJwcmVsb2FkIGVudHJ5XCIsIHsgdXJsOiBsb2NhdGlvbi5ocmVmIH0pO1xuXG4vLyBSZWFjdCBob29rIG11c3QgYmUgaW5zdGFsbGVkICpiZWZvcmUqIENvZGV4J3MgYnVuZGxlIHJ1bnMuXG50cnkge1xuICBpbnN0YWxsUmVhY3RIb29rKCk7XG4gIGZpbGVMb2coXCJyZWFjdCBob29rIGluc3RhbGxlZFwiKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnRyeSB7XG4gIHN0YXJ0R29hbEZlYXR1cmUoZmlsZUxvZyk7XG59IGNhdGNoIChlKSB7XG4gIGZpbGVMb2coXCJnb2FsIGZlYXR1cmUgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnF1ZXVlTWljcm90YXNrKCgpID0+IHtcbiAgaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09IFwibG9hZGluZ1wiKSB7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgYm9vdCwgeyBvbmNlOiB0cnVlIH0pO1xuICB9IGVsc2Uge1xuICAgIGJvb3QoKTtcbiAgfVxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7XG4gIGZpbGVMb2coXCJib290IHN0YXJ0XCIsIHsgcmVhZHlTdGF0ZTogZG9jdW1lbnQucmVhZHlTdGF0ZSB9KTtcbiAgdHJ5IHtcbiAgICBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTtcbiAgICBmaWxlTG9nKFwic2V0dGluZ3MgaW5qZWN0b3Igc3RhcnRlZFwiKTtcbiAgICBzdGFydEdpdFNpZGViYXIoKTtcbiAgICBmaWxlTG9nKFwiZ2l0IHNpZGViYXIgc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgIGZpbGVMb2coXCJ0d2VhayBob3N0IHN0YXJ0ZWRcIik7XG4gICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgZmlsZUxvZyhcIm1hbmFnZXIgbW91bnRlZFwiKTtcbiAgICBzdWJzY3JpYmVSZWxvYWQoKTtcbiAgICBmaWxlTG9nKFwiYm9vdCBjb21wbGV0ZVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZpbGVMb2coXCJib290IEZBSUxFRFwiLCBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSk7XG4gICAgY29uc29sZS5lcnJvcihcIltjb2RleC1wbHVzcGx1c10gcHJlbG9hZCBib290IGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gSG90IHJlbG9hZDogZ2F0ZWQgYmVoaW5kIGEgc21hbGwgaW4tZmxpZ2h0IGxvY2sgc28gYSBmbHVycnkgb2YgZnMgZXZlbnRzXG4vLyBkb2Vzbid0IHJlZW50cmFudGx5IHRlYXIgZG93biB0aGUgaG9zdCBtaWQtbG9hZC5cbmxldCByZWxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcbmZ1bmN0aW9uIHN1YnNjcmliZVJlbG9hZCgpOiB2b2lkIHtcbiAgaXBjUmVuZGVyZXIub24oXCJjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBpZiAocmVsb2FkaW5nKSByZXR1cm47XG4gICAgcmVsb2FkaW5nID0gKGFzeW5jICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUuaW5mbyhcIltjb2RleC1wbHVzcGx1c10gaG90LXJlbG9hZGluZyB0d2Vha3NcIik7XG4gICAgICAgIHRlYXJkb3duVHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IHN0YXJ0VHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IG1vdW50TWFuYWdlcigpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWxvYWRpbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gIH0pO1xufVxuIiwgIi8qKlxuICogSW5zdGFsbCBhIG1pbmltYWwgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fLiBSZWFjdCBjYWxsc1xuICogYGhvb2suaW5qZWN0KHJlbmRlcmVySW50ZXJuYWxzKWAgZHVyaW5nIGBjcmVhdGVSb290YC9gaHlkcmF0ZVJvb3RgLiBUaGVcbiAqIFwiaW50ZXJuYWxzXCIgb2JqZWN0IGV4cG9zZXMgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2UsIHdoaWNoIGxldHMgdXMgdHVybiBhXG4gKiBET00gbm9kZSBpbnRvIGEgUmVhY3QgZmliZXIgXHUyMDE0IG5lY2Vzc2FyeSBmb3Igb3VyIFNldHRpbmdzIGluamVjdG9yLlxuICpcbiAqIFdlIGRvbid0IHdhbnQgdG8gYnJlYWsgcmVhbCBSZWFjdCBEZXZUb29scyBpZiB0aGUgdXNlciBvcGVucyBpdDsgd2UgaW5zdGFsbFxuICogb25seSBpZiBubyBob29rIGV4aXN0cyB5ZXQsIGFuZCB3ZSBmb3J3YXJkIGNhbGxzIHRvIGEgZG93bnN0cmVhbSBob29rIGlmXG4gKiBvbmUgaXMgbGF0ZXIgYXNzaWduZWQuXG4gKi9cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fPzogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgX19jb2RleHBwX18/OiB7XG4gICAgICBob29rOiBSZWFjdERldnRvb2xzSG9vaztcbiAgICAgIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICAgIH07XG4gIH1cbn1cblxuaW50ZXJmYWNlIFJlbmRlcmVySW50ZXJuYWxzIHtcbiAgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2U/OiAobjogTm9kZSkgPT4gdW5rbm93bjtcbiAgdmVyc2lvbj86IHN0cmluZztcbiAgYnVuZGxlVHlwZT86IG51bWJlcjtcbiAgcmVuZGVyZXJQYWNrYWdlTmFtZT86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlYWN0RGV2dG9vbHNIb29rIHtcbiAgc3VwcG9ydHNGaWJlcjogdHJ1ZTtcbiAgcmVuZGVyZXJzOiBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz47XG4gIG9uKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgb2ZmKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgZW1pdChldmVudDogc3RyaW5nLCAuLi5hOiB1bmtub3duW10pOiB2b2lkO1xuICBpbmplY3QocmVuZGVyZXI6IFJlbmRlcmVySW50ZXJuYWxzKTogbnVtYmVyO1xuICBvblNjaGVkdWxlRmliZXJSb290PygpOiB2b2lkO1xuICBvbkNvbW1pdEZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclVubW91bnQ/KCk6IHZvaWQ7XG4gIGNoZWNrRENFPygpOiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFJlYWN0SG9vaygpOiB2b2lkIHtcbiAgaWYgKHdpbmRvdy5fX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18pIHJldHVybjtcbiAgY29uc3QgcmVuZGVyZXJzID0gbmV3IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPigpO1xuICBsZXQgbmV4dElkID0gMTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsIFNldDwoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkPj4oKTtcblxuICBjb25zdCBob29rOiBSZWFjdERldnRvb2xzSG9vayA9IHtcbiAgICBzdXBwb3J0c0ZpYmVyOiB0cnVlLFxuICAgIHJlbmRlcmVycyxcbiAgICBpbmplY3QocmVuZGVyZXIpIHtcbiAgICAgIGNvbnN0IGlkID0gbmV4dElkKys7XG4gICAgICByZW5kZXJlcnMuc2V0KGlkLCByZW5kZXJlcik7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS5kZWJ1ZyhcbiAgICAgICAgXCJbY29kZXgtcGx1c3BsdXNdIFJlYWN0IHJlbmRlcmVyIGF0dGFjaGVkOlwiLFxuICAgICAgICByZW5kZXJlci5yZW5kZXJlclBhY2thZ2VOYW1lLFxuICAgICAgICByZW5kZXJlci52ZXJzaW9uLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBpZDtcbiAgICB9LFxuICAgIG9uKGV2ZW50LCBmbikge1xuICAgICAgbGV0IHMgPSBsaXN0ZW5lcnMuZ2V0KGV2ZW50KTtcbiAgICAgIGlmICghcykgbGlzdGVuZXJzLnNldChldmVudCwgKHMgPSBuZXcgU2V0KCkpKTtcbiAgICAgIHMuYWRkKGZuKTtcbiAgICB9LFxuICAgIG9mZihldmVudCwgZm4pIHtcbiAgICAgIGxpc3RlbmVycy5nZXQoZXZlbnQpPy5kZWxldGUoZm4pO1xuICAgIH0sXG4gICAgZW1pdChldmVudCwgLi4uYXJncykge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmZvckVhY2goKGZuKSA9PiBmbiguLi5hcmdzKSk7XG4gICAgfSxcbiAgICBvbkNvbW1pdEZpYmVyUm9vdCgpIHt9LFxuICAgIG9uQ29tbWl0RmliZXJVbm1vdW50KCkge30sXG4gICAgb25TY2hlZHVsZUZpYmVyUm9vdCgpIHt9LFxuICAgIGNoZWNrRENFKCkge30sXG4gIH07XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX19cIiwge1xuICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICB3cml0YWJsZTogdHJ1ZSwgLy8gYWxsb3cgcmVhbCBEZXZUb29scyB0byBvdmVyd3JpdGUgaWYgdXNlciBpbnN0YWxscyBpdFxuICAgIHZhbHVlOiBob29rLFxuICB9KTtcblxuICB3aW5kb3cuX19jb2RleHBwX18gPSB7IGhvb2ssIHJlbmRlcmVycyB9O1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgUmVhY3QgZmliZXIgZm9yIGEgRE9NIG5vZGUsIGlmIGFueSByZW5kZXJlciBoYXMgb25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpYmVyRm9yTm9kZShub2RlOiBOb2RlKTogdW5rbm93biB8IG51bGwge1xuICBjb25zdCByZW5kZXJlcnMgPSB3aW5kb3cuX19jb2RleHBwX18/LnJlbmRlcmVycztcbiAgaWYgKHJlbmRlcmVycykge1xuICAgIGZvciAoY29uc3QgciBvZiByZW5kZXJlcnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGYgPSByLmZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPy4obm9kZSk7XG4gICAgICBpZiAoZikgcmV0dXJuIGY7XG4gICAgfVxuICB9XG4gIC8vIEZhbGxiYWNrOiByZWFkIHRoZSBSZWFjdCBpbnRlcm5hbCBwcm9wZXJ0eSBkaXJlY3RseSBmcm9tIHRoZSBET00gbm9kZS5cbiAgLy8gUmVhY3Qgc3RvcmVzIGZpYmVycyBhcyBhIHByb3BlcnR5IHdob3NlIGtleSBzdGFydHMgd2l0aCBcIl9fcmVhY3RGaWJlclwiLlxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICBpZiAoay5zdGFydHNXaXRoKFwiX19yZWFjdEZpYmVyXCIpKSByZXR1cm4gKG5vZGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba107XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG4iLCAiLyoqXG4gKiBTZXR0aW5ncyBpbmplY3RvciBmb3IgQ29kZXgncyBTZXR0aW5ncyBwYWdlLlxuICpcbiAqIENvZGV4J3Mgc2V0dGluZ3MgaXMgYSByb3V0ZWQgcGFnZSAoVVJMIHN0YXlzIGF0IGAvaW5kZXguaHRtbD9ob3N0SWQ9bG9jYWxgKVxuICogTk9UIGEgbW9kYWwgZGlhbG9nLiBUaGUgc2lkZWJhciBsaXZlcyBpbnNpZGUgYSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC0xIGdhcC0wXCI+YCB3cmFwcGVyIHRoYXQgaG9sZHMgb25lIG9yIG1vcmUgYDxkaXYgY2xhc3M9XCJmbGV4IGZsZXgtY29sXG4gKiBnYXAtcHhcIj5gIGdyb3VwcyBvZiBidXR0b25zLiBUaGVyZSBhcmUgbm8gc3RhYmxlIGByb2xlYCAvIGBhcmlhLWxhYmVsYCAvXG4gKiBgZGF0YS10ZXN0aWRgIGhvb2tzIG9uIHRoZSBzaGVsbCBzbyB3ZSBpZGVudGlmeSB0aGUgc2lkZWJhciBieSB0ZXh0LWNvbnRlbnRcbiAqIG1hdGNoIGFnYWluc3Qga25vd24gaXRlbSBsYWJlbHMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIENvbmZpZ3VyYXRpb24sIFx1MjAyNikuXG4gKlxuICogTGF5b3V0IHdlIGluamVjdDpcbiAqXG4gKiAgIEdFTkVSQUwgICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFtDb2RleCdzIGV4aXN0aW5nIGl0ZW1zIGdyb3VwXVxuICogICBDT0RFWCsrICAgICAgICAgICAgICAgICAgICAgICAodXBwZXJjYXNlIGdyb3VwIGxhYmVsKVxuICogICBcdTI0RDggQ29uZmlnXG4gKiAgIFx1MjYzMCBUd2Vha3NcbiAqXG4gKiBDbGlja2luZyBDb25maWcgLyBUd2Vha3MgaGlkZXMgQ29kZXgncyBjb250ZW50IHBhbmVsIGNoaWxkcmVuIGFuZCByZW5kZXJzXG4gKiBvdXIgb3duIGBtYWluLXN1cmZhY2VgIHBhbmVsIGluIHRoZWlyIHBsYWNlLiBDbGlja2luZyBhbnkgb2YgQ29kZXgnc1xuICogc2lkZWJhciBpdGVtcyByZXN0b3JlcyB0aGUgb3JpZ2luYWwgdmlldy5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHR5cGUge1xuICBTZXR0aW5nc1NlY3Rpb24sXG4gIFNldHRpbmdzUGFnZSxcbiAgU2V0dGluZ3NIYW5kbGUsXG4gIFR3ZWFrTWFuaWZlc3QsXG59IGZyb20gXCJAY29kZXgtcGx1c3BsdXMvc2RrXCI7XG5cbi8vIE1pcnJvcnMgdGhlIHJ1bnRpbWUncyBtYWluLXNpZGUgTGlzdGVkVHdlYWsgc2hhcGUgKGtlcHQgaW4gc3luYyBtYW51YWxseSkuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICB1cGRhdGU6IFR3ZWFrVXBkYXRlQ2hlY2sgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtVcGRhdGVDaGVjayB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICByZXBvOiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdFRhZzogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvZGV4UGx1c1BsdXNDb25maWcge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGF1dG9VcGRhdGU6IGJvb2xlYW47XG4gIHVwZGF0ZUNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VOb3Rlczogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIENvZGV4Q2RwU3RhdHVzIHtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgYWN0aXZlOiBib29sZWFuO1xuICBjb25maWd1cmVkUG9ydDogbnVtYmVyO1xuICBhY3RpdmVQb3J0OiBudW1iZXIgfCBudWxsO1xuICByZXN0YXJ0UmVxdWlyZWQ6IGJvb2xlYW47XG4gIHNvdXJjZTogXCJhcmd2XCIgfCBcImVudlwiIHwgXCJjb25maWdcIiB8IFwib2ZmXCI7XG4gIGpzb25MaXN0VXJsOiBzdHJpbmcgfCBudWxsO1xuICBqc29uVmVyc2lvblVybDogc3RyaW5nIHwgbnVsbDtcbiAgbGF1bmNoQ29tbWFuZDogc3RyaW5nO1xuICBhcHBSb290OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgV2F0Y2hlckhlYWx0aCB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHdhdGNoZXI6IHN0cmluZztcbiAgY2hlY2tzOiBXYXRjaGVySGVhbHRoQ2hlY2tbXTtcbn1cblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGhDaGVjayB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQSB0d2Vhay1yZWdpc3RlcmVkIHBhZ2UuIFdlIGNhcnJ5IHRoZSBvd25pbmcgdHdlYWsncyBtYW5pZmVzdCBzbyB3ZSBjYW5cbiAqIHJlc29sdmUgcmVsYXRpdmUgaWNvblVybHMgYW5kIHNob3cgYXV0aG9yc2hpcCBpbiB0aGUgcGFnZSBoZWFkZXIuXG4gKi9cbmludGVyZmFjZSBSZWdpc3RlcmVkUGFnZSB7XG4gIC8qKiBGdWxseS1xdWFsaWZpZWQgaWQ6IGA8dHdlYWtJZD46PHBhZ2VJZD5gLiAqL1xuICBpZDogc3RyaW5nO1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBwYWdlOiBTZXR0aW5nc1BhZ2U7XG4gIC8qKiBQZXItcGFnZSBET00gdGVhcmRvd24gcmV0dXJuZWQgYnkgYHBhZ2UucmVuZGVyYCwgaWYgYW55LiAqL1xuICB0ZWFyZG93bj86ICgoKSA9PiB2b2lkKSB8IG51bGw7XG4gIC8qKiBUaGUgaW5qZWN0ZWQgc2lkZWJhciBidXR0b24gKHNvIHdlIGNhbiB1cGRhdGUgaXRzIGFjdGl2ZSBzdGF0ZSkuICovXG4gIG5hdkJ1dHRvbj86IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbn1cblxuLyoqIFdoYXQgcGFnZSBpcyBjdXJyZW50bHkgc2VsZWN0ZWQgaW4gb3VyIGluamVjdGVkIG5hdi4gKi9cbnR5cGUgQWN0aXZlUGFnZSA9XG4gIHwgeyBraW5kOiBcImNvbmZpZ1wiIH1cbiAgfCB7IGtpbmQ6IFwidHdlYWtzXCIgfVxuICB8IHsga2luZDogXCJyZWdpc3RlcmVkXCI7IGlkOiBzdHJpbmcgfTtcblxuaW50ZXJmYWNlIEluamVjdG9yU3RhdGUge1xuICBzZWN0aW9uczogTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uPjtcbiAgcGFnZXM6IE1hcDxzdHJpbmcsIFJlZ2lzdGVyZWRQYWdlPjtcbiAgbGlzdGVkVHdlYWtzOiBMaXN0ZWRUd2Vha1tdO1xuICAvKiogT3V0ZXIgd3JhcHBlciB0aGF0IGhvbGRzIENvZGV4J3MgaXRlbXMgZ3JvdXAgKyBvdXIgaW5qZWN0ZWQgZ3JvdXBzLiAqL1xuICBvdXRlcldyYXBwZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIkdlbmVyYWxcIiBsYWJlbCBmb3IgQ29kZXgncyBuYXRpdmUgc2V0dGluZ3MgZ3JvdXAuICovXG4gIG5hdGl2ZU5hdkhlYWRlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiQ29kZXgrK1wiIG5hdiBncm91cCAoQ29uZmlnL1R3ZWFrcykuICovXG4gIG5hdkdyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG5hdkJ1dHRvbnM6IHsgY29uZmlnOiBIVE1MQnV0dG9uRWxlbWVudDsgdHdlYWtzOiBIVE1MQnV0dG9uRWxlbWVudCB9IHwgbnVsbDtcbiAgLyoqIE91ciBcIlR3ZWFrc1wiIG5hdiBncm91cCAocGVyLXR3ZWFrIHBhZ2VzKS4gQ3JlYXRlZCBsYXppbHkuICovXG4gIHBhZ2VzR3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcGFnZXNHcm91cEtleTogc3RyaW5nIHwgbnVsbDtcbiAgcGFuZWxIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbDtcbiAgZmluZ2VycHJpbnQ6IHN0cmluZyB8IG51bGw7XG4gIHNpZGViYXJEdW1wZWQ6IGJvb2xlYW47XG4gIGFjdGl2ZVBhZ2U6IEFjdGl2ZVBhZ2UgfCBudWxsO1xuICBzaWRlYmFyUm9vdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBzaWRlYmFyUmVzdG9yZUhhbmRsZXI6ICgoZTogRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogYm9vbGVhbjtcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG59XG5cbmNvbnN0IHN0YXRlOiBJbmplY3RvclN0YXRlID0ge1xuICBzZWN0aW9uczogbmV3IE1hcCgpLFxuICBwYWdlczogbmV3IE1hcCgpLFxuICBsaXN0ZWRUd2Vha3M6IFtdLFxuICBvdXRlcldyYXBwZXI6IG51bGwsXG4gIG5hdGl2ZU5hdkhlYWRlcjogbnVsbCxcbiAgbmF2R3JvdXA6IG51bGwsXG4gIG5hdkJ1dHRvbnM6IG51bGwsXG4gIHBhZ2VzR3JvdXA6IG51bGwsXG4gIHBhZ2VzR3JvdXBLZXk6IG51bGwsXG4gIHBhbmVsSG9zdDogbnVsbCxcbiAgb2JzZXJ2ZXI6IG51bGwsXG4gIGZpbmdlcnByaW50OiBudWxsLFxuICBzaWRlYmFyRHVtcGVkOiBmYWxzZSxcbiAgYWN0aXZlUGFnZTogbnVsbCxcbiAgc2lkZWJhclJvb3Q6IG51bGwsXG4gIHNpZGViYXJSZXN0b3JlSGFuZGxlcjogbnVsbCxcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogZmFsc2UsXG4gIHNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcjogbnVsbCxcbn07XG5cbmZ1bmN0aW9uIHBsb2cobXNnOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGBbc2V0dGluZ3MtaW5qZWN0b3JdICR7bXNnfSR7ZXh0cmEgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiBcIiBcIiArIHNhZmVTdHJpbmdpZnkoZXh0cmEpfWAsXG4gICk7XG59XG5mdW5jdGlvbiBzYWZlU3RyaW5naWZ5KHY6IHVua25vd24pOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IHYgOiBKU09OLnN0cmluZ2lmeSh2KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFN0cmluZyh2KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgcHVibGljIEFQSSBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0U2V0dGluZ3NJbmplY3RvcigpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm9ic2VydmVyKSByZXR1cm47XG5cbiAgY29uc3Qgb2JzID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIHRyeUluamVjdCgpO1xuICAgIG1heWJlRHVtcERvbSgpO1xuICB9KTtcbiAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgc3RhdGUub2JzZXJ2ZXIgPSBvYnM7XG5cbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCBvbk5hdik7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiaGFzaGNoYW5nZVwiLCBvbk5hdik7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkRvY3VtZW50Q2xpY2ssIHRydWUpO1xuICBmb3IgKGNvbnN0IG0gb2YgW1wicHVzaFN0YXRlXCIsIFwicmVwbGFjZVN0YXRlXCJdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgb3JpZyA9IGhpc3RvcnlbbV07XG4gICAgaGlzdG9yeVttXSA9IGZ1bmN0aW9uICh0aGlzOiBIaXN0b3J5LCAuLi5hcmdzOiBQYXJhbWV0ZXJzPHR5cGVvZiBvcmlnPikge1xuICAgICAgY29uc3QgciA9IG9yaWcuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoYGNvZGV4cHAtJHttfWApKTtcbiAgICAgIHJldHVybiByO1xuICAgIH0gYXMgdHlwZW9mIG9yaWc7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoYGNvZGV4cHAtJHttfWAsIG9uTmF2KTtcbiAgfVxuXG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbiAgbGV0IHRpY2tzID0gMDtcbiAgY29uc3QgaW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgdGlja3MrKztcbiAgICB0cnlJbmplY3QoKTtcbiAgICBtYXliZUR1bXBEb20oKTtcbiAgICBpZiAodGlja3MgPiA2MCkgY2xlYXJJbnRlcnZhbChpbnRlcnZhbCk7XG4gIH0sIDUwMCk7XG59XG5cbmZ1bmN0aW9uIG9uTmF2KCk6IHZvaWQge1xuICBzdGF0ZS5maW5nZXJwcmludCA9IG51bGw7XG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbn1cblxuZnVuY3Rpb24gb25Eb2N1bWVudENsaWNrKGU6IE1vdXNlRXZlbnQpOiB2b2lkIHtcbiAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50ID8gZS50YXJnZXQgOiBudWxsO1xuICBjb25zdCBjb250cm9sID0gdGFyZ2V0Py5jbG9zZXN0KFwiW3JvbGU9J2xpbmsnXSxidXR0b24sYVwiKTtcbiAgaWYgKCEoY29udHJvbCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSkgcmV0dXJuO1xuICBpZiAoY29tcGFjdFNldHRpbmdzVGV4dChjb250cm9sLnRleHRDb250ZW50IHx8IFwiXCIpICE9PSBcIkJhY2sgdG8gYXBwXCIpIHJldHVybjtcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJiYWNrLXRvLWFwcFwiKTtcbiAgfSwgMCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNlY3Rpb24oc2VjdGlvbjogU2V0dGluZ3NTZWN0aW9uKTogU2V0dGluZ3NIYW5kbGUge1xuICBzdGF0ZS5zZWN0aW9ucy5zZXQoc2VjdGlvbi5pZCwgc2VjdGlvbik7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICByZXR1cm4ge1xuICAgIHVucmVnaXN0ZXI6ICgpID0+IHtcbiAgICAgIHN0YXRlLnNlY3Rpb25zLmRlbGV0ZShzZWN0aW9uLmlkKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclNlY3Rpb25zKCk6IHZvaWQge1xuICBzdGF0ZS5zZWN0aW9ucy5jbGVhcigpO1xuICAvLyBEcm9wIHJlZ2lzdGVyZWQgcGFnZXMgdG9vIFx1MjAxNCB0aGV5J3JlIG93bmVkIGJ5IHR3ZWFrcyB0aGF0IGp1c3QgZ290XG4gIC8vIHRvcm4gZG93biBieSB0aGUgaG9zdC4gUnVuIGFueSB0ZWFyZG93bnMgYmVmb3JlIGZvcmdldHRpbmcgdGhlbS5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHAudGVhcmRvd24/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBsb2coXCJwYWdlIHRlYXJkb3duIGZhaWxlZFwiLCB7IGlkOiBwLmlkLCBlcnI6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cbiAgc3RhdGUucGFnZXMuY2xlYXIoKTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gSWYgd2Ugd2VyZSBvbiBhIHJlZ2lzdGVyZWQgcGFnZSB0aGF0IG5vIGxvbmdlciBleGlzdHMsIGZhbGwgYmFjayB0b1xuICAvLyByZXN0b3JpbmcgQ29kZXgncyB2aWV3LlxuICBpZiAoXG4gICAgc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiZcbiAgICAhc3RhdGUucGFnZXMuaGFzKHN0YXRlLmFjdGl2ZVBhZ2UuaWQpXG4gICkge1xuICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIGEgdHdlYWstb3duZWQgc2V0dGluZ3MgcGFnZS4gVGhlIHJ1bnRpbWUgaW5qZWN0cyBhIHNpZGViYXIgZW50cnlcbiAqIHVuZGVyIGEgXCJUV0VBS1NcIiBncm91cCBoZWFkZXIgKHdoaWNoIGFwcGVhcnMgb25seSB3aGVuIGF0IGxlYXN0IG9uZSBwYWdlXG4gKiBpcyByZWdpc3RlcmVkKSBhbmQgcm91dGVzIGNsaWNrcyB0byB0aGUgcGFnZSdzIGByZW5kZXIocm9vdClgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJQYWdlKFxuICB0d2Vha0lkOiBzdHJpbmcsXG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LFxuICBwYWdlOiBTZXR0aW5nc1BhZ2UsXG4pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIGNvbnN0IGlkID0gcGFnZS5pZDsgLy8gYWxyZWFkeSBuYW1lc3BhY2VkIGJ5IHR3ZWFrLWhvc3QgYXMgYCR7dHdlYWtJZH06JHtwYWdlLmlkfWBcbiAgY29uc3QgZW50cnk6IFJlZ2lzdGVyZWRQYWdlID0geyBpZCwgdHdlYWtJZCwgbWFuaWZlc3QsIHBhZ2UgfTtcbiAgc3RhdGUucGFnZXMuc2V0KGlkLCBlbnRyeSk7XG4gIHBsb2coXCJyZWdpc3RlclBhZ2VcIiwgeyBpZCwgdGl0bGU6IHBhZ2UudGl0bGUsIHR3ZWFrSWQgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIC8vIElmIHRoZSB1c2VyIHdhcyBhbHJlYWR5IG9uIHRoaXMgcGFnZSAoaG90IHJlbG9hZCksIHJlLW1vdW50IGl0cyBib2R5LlxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHtcbiAgICByZXJlbmRlcigpO1xuICB9XG4gIHJldHVybiB7XG4gICAgdW5yZWdpc3RlcjogKCkgPT4ge1xuICAgICAgY29uc3QgZSA9IHN0YXRlLnBhZ2VzLmdldChpZCk7XG4gICAgICBpZiAoIWUpIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGUudGVhcmRvd24/LigpO1xuICAgICAgfSBjYXRjaCB7fVxuICAgICAgc3RhdGUucGFnZXMuZGVsZXRlKGlkKTtcbiAgICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHtcbiAgICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgICAgfVxuICAgIH0sXG4gIH07XG59XG5cbi8qKiBDYWxsZWQgYnkgdGhlIHR3ZWFrIGhvc3QgYWZ0ZXIgZmV0Y2hpbmcgdGhlIHR3ZWFrIGxpc3QgZnJvbSBtYWluLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldExpc3RlZFR3ZWFrcyhsaXN0OiBMaXN0ZWRUd2Vha1tdKTogdm9pZCB7XG4gIHN0YXRlLmxpc3RlZFR3ZWFrcyA9IGxpc3Q7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgaW5qZWN0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0cnlJbmplY3QoKTogdm9pZCB7XG4gIGNvbnN0IGl0ZW1zR3JvdXAgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgaWYgKCFpdGVtc0dyb3VwKSB7XG4gICAgc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTtcbiAgICBwbG9nKFwic2lkZWJhciBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHtcbiAgICBjbGVhclRpbWVvdXQoc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKTtcbiAgICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBudWxsO1xuICB9XG4gIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUodHJ1ZSwgXCJzaWRlYmFyLWZvdW5kXCIpO1xuICAvLyBDb2RleCdzIGl0ZW1zIGdyb3VwIGxpdmVzIGluc2lkZSBhbiBvdXRlciB3cmFwcGVyIHRoYXQncyBhbHJlYWR5IHN0eWxlZFxuICAvLyB0byBob2xkIG11bHRpcGxlIGdyb3VwcyAoYGZsZXggZmxleC1jb2wgZ2FwLTEgZ2FwLTBgKS4gV2UgaW5qZWN0IG91clxuICAvLyBncm91cCBhcyBhIHNpYmxpbmcgc28gdGhlIG5hdHVyYWwgZ2FwLTEgYWN0cyBhcyBvdXIgdmlzdWFsIHNlcGFyYXRvci5cbiAgY29uc3Qgb3V0ZXIgPSBpdGVtc0dyb3VwLnBhcmVudEVsZW1lbnQgPz8gaXRlbXNHcm91cDtcbiAgc3RhdGUuc2lkZWJhclJvb3QgPSBvdXRlcjtcbiAgc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXAsIG91dGVyKTtcblxuICBpZiAoc3RhdGUubmF2R3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF2R3JvdXApKSB7XG4gICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAvLyBDb2RleCByZS1yZW5kZXJzIGl0cyBuYXRpdmUgc2lkZWJhciBidXR0b25zIG9uIGl0cyBvd24gc3RhdGUgY2hhbmdlcy5cbiAgICAvLyBJZiBvbmUgb2Ygb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgcmUtc3RyaXAgQ29kZXgncyBhY3RpdmUgc3R5bGluZyBzb1xuICAgIC8vIEdlbmVyYWwgZG9lc24ndCByZWFwcGVhciBhcyBzZWxlY3RlZC5cbiAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCkgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpZGViYXIgd2FzIGVpdGhlciBmcmVzaGx5IG1vdW50ZWQgKFNldHRpbmdzIGp1c3Qgb3BlbmVkKSBvciByZS1tb3VudGVkXG4gIC8vIChjbG9zZWQgYW5kIHJlLW9wZW5lZCwgb3IgbmF2aWdhdGVkIGF3YXkgYW5kIGJhY2spLiBJbiBhbGwgb2YgdGhvc2VcbiAgLy8gY2FzZXMgQ29kZXggcmVzZXRzIHRvIGl0cyBkZWZhdWx0IHBhZ2UgKEdlbmVyYWwpLCBidXQgb3VyIGluLW1lbW9yeVxuICAvLyBgYWN0aXZlUGFnZWAgbWF5IHN0aWxsIHJlZmVyZW5jZSB0aGUgbGFzdCB0d2Vhay9wYWdlIHRoZSB1c2VyIGhhZCBvcGVuXG4gIC8vIFx1MjAxNCB3aGljaCB3b3VsZCBjYXVzZSB0aGF0IG5hdiBidXR0b24gdG8gcmVuZGVyIHdpdGggdGhlIGFjdGl2ZSBzdHlsaW5nXG4gIC8vIGV2ZW4gdGhvdWdoIENvZGV4IGlzIHNob3dpbmcgR2VuZXJhbC4gQ2xlYXIgaXQgc28gYHN5bmNQYWdlc0dyb3VwYCAvXG4gIC8vIGBzZXROYXZBY3RpdmVgIHN0YXJ0IGZyb20gYSBuZXV0cmFsIHN0YXRlLiBUaGUgcGFuZWxIb3N0IHJlZmVyZW5jZSBpc1xuICAvLyBhbHNvIHN0YWxlIChpdHMgRE9NIHdhcyBkaXNjYXJkZWQgd2l0aCB0aGUgcHJldmlvdXMgY29udGVudCBhcmVhKS5cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwgfHwgc3RhdGUucGFuZWxIb3N0ICE9PSBudWxsKSB7XG4gICAgcGxvZyhcInNpZGViYXIgcmUtbW91bnQgZGV0ZWN0ZWQ7IGNsZWFyaW5nIHN0YWxlIGFjdGl2ZSBzdGF0ZVwiLCB7XG4gICAgICBwcmV2QWN0aXZlOiBzdGF0ZS5hY3RpdmVQYWdlLFxuICAgIH0pO1xuICAgIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICAgIHN0YXRlLnBhbmVsSG9zdCA9IG51bGw7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgR3JvdXAgY29udGFpbmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGdyb3VwLmRhdGFzZXQuY29kZXhwcCA9IFwibmF2LWdyb3VwXCI7XG4gIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcblxuICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJDb2RleCsrXCIsIFwicHQtM1wiKSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFR3byBzaWRlYmFyIGl0ZW1zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBjb25maWdCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJDb25maWdcIiwgY29uZmlnSWNvblN2ZygpKTtcbiAgY29uc3QgdHdlYWtzQnRuID0gbWFrZVNpZGViYXJJdGVtKFwiVHdlYWtzXCIsIHR3ZWFrc0ljb25TdmcoKSk7XG5cbiAgY29uZmlnQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwiY29uZmlnXCIgfSk7XG4gIH0pO1xuICB0d2Vha3NCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJ0d2Vha3NcIiB9KTtcbiAgfSk7XG5cbiAgZ3JvdXAuYXBwZW5kQ2hpbGQoY29uZmlnQnRuKTtcbiAgZ3JvdXAuYXBwZW5kQ2hpbGQodHdlYWtzQnRuKTtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQoZ3JvdXApO1xuXG4gIHN0YXRlLm5hdkdyb3VwID0gZ3JvdXA7XG4gIHN0YXRlLm5hdkJ1dHRvbnMgPSB7IGNvbmZpZzogY29uZmlnQnRuLCB0d2Vha3M6IHR3ZWFrc0J0biB9O1xuICBwbG9nKFwibmF2IGdyb3VwIGluamVjdGVkXCIsIHsgb3V0ZXJUYWc6IG91dGVyLnRhZ05hbWUgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwOiBIVE1MRWxlbWVudCwgb3V0ZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF0aXZlTmF2SGVhZGVyKSkgcmV0dXJuO1xuICBpZiAob3V0ZXIgPT09IGl0ZW1zR3JvdXApIHJldHVybjtcblxuICBjb25zdCBoZWFkZXIgPSBzaWRlYmFyR3JvdXBIZWFkZXIoXCJHZW5lcmFsXCIpO1xuICBoZWFkZXIuZGF0YXNldC5jb2RleHBwID0gXCJuYXRpdmUtbmF2LWhlYWRlclwiO1xuICBvdXRlci5pbnNlcnRCZWZvcmUoaGVhZGVyLCBpdGVtc0dyb3VwKTtcbiAgc3RhdGUubmF0aXZlTmF2SGVhZGVyID0gaGVhZGVyO1xufVxuXG5mdW5jdGlvbiBzaWRlYmFyR3JvdXBIZWFkZXIodGV4dDogc3RyaW5nLCB0b3BQYWRkaW5nID0gXCJwdC0yXCIpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPVxuICAgIGBweC1yb3cteCAke3RvcFBhZGRpbmd9IHBiLTEgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdXBwZXJjYXNlIHRyYWNraW5nLXdpZGVyIHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZCBzZWxlY3Qtbm9uZWA7XG4gIGhlYWRlci50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk6IHZvaWQge1xuICBpZiAoIXN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgfHwgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKSByZXR1cm47XG4gIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gICAgaWYgKGZpbmRTaWRlYmFySXRlbXNHcm91cCgpKSByZXR1cm47XG4gICAgaWYgKGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpKSByZXR1cm47XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJzaWRlYmFyLW5vdC1mb3VuZFwiKTtcbiAgfSwgMTUwMCk7XG59XG5cbmZ1bmN0aW9uIGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpOiBib29sZWFuIHtcbiAgY29uc3QgdGV4dCA9IGNvbXBhY3RTZXR0aW5nc1RleHQoZG9jdW1lbnQuYm9keT8udGV4dENvbnRlbnQgfHwgXCJcIikudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIChcbiAgICB0ZXh0LmluY2x1ZGVzKFwiYmFjayB0byBhcHBcIikgJiZcbiAgICB0ZXh0LmluY2x1ZGVzKFwiZ2VuZXJhbFwiKSAmJlxuICAgIHRleHQuaW5jbHVkZXMoXCJhcHBlYXJhbmNlXCIpICYmXG4gICAgKHRleHQuaW5jbHVkZXMoXCJjb25maWd1cmF0aW9uXCIpIHx8IHRleHQuaW5jbHVkZXMoXCJkZWZhdWx0IHBlcm1pc3Npb25zXCIpKVxuICApO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0U2V0dGluZ3NUZXh0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh2aXNpYmxlOiBib29sZWFuLCByZWFzb246IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9PT0gdmlzaWJsZSkgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgdHJ5IHtcbiAgICAod2luZG93IGFzIFdpbmRvdyAmIHsgX19jb2RleHBwU2V0dGluZ3NTdXJmYWNlVmlzaWJsZT86IGJvb2xlYW4gfSkuX19jb2RleHBwU2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9IHZpc2libGU7XG4gICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQuY29kZXhwcFNldHRpbmdzU3VyZmFjZSA9IHZpc2libGUgPyBcInRydWVcIiA6IFwiZmFsc2VcIjtcbiAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChcbiAgICAgIG5ldyBDdXN0b21FdmVudChcImNvZGV4cHA6c2V0dGluZ3Mtc3VyZmFjZVwiLCB7XG4gICAgICAgIGRldGFpbDogeyB2aXNpYmxlLCByZWFzb24gfSxcbiAgICAgIH0pLFxuICAgICk7XG4gIH0gY2F0Y2gge31cbiAgcGxvZyhcInNldHRpbmdzIHN1cmZhY2VcIiwgeyB2aXNpYmxlLCByZWFzb24sIHVybDogbG9jYXRpb24uaHJlZiB9KTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgKG9yIHJlLXJlbmRlcikgdGhlIHNlY29uZCBzaWRlYmFyIGdyb3VwIG9mIHBlci10d2VhayBwYWdlcy4gVGhlXG4gKiBncm91cCBpcyBjcmVhdGVkIGxhemlseSBhbmQgcmVtb3ZlZCB3aGVuIHRoZSBsYXN0IHBhZ2UgdW5yZWdpc3RlcnMsIHNvXG4gKiB1c2VycyB3aXRoIG5vIHBhZ2UtcmVnaXN0ZXJpbmcgdHdlYWtzIG5ldmVyIHNlZSBhbiBlbXB0eSBcIlR3ZWFrc1wiIGhlYWRlci5cbiAqL1xuZnVuY3Rpb24gc3luY1BhZ2VzR3JvdXAoKTogdm9pZCB7XG4gIGNvbnN0IG91dGVyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghb3V0ZXIpIHJldHVybjtcbiAgY29uc3QgcGFnZXMgPSBbLi4uc3RhdGUucGFnZXMudmFsdWVzKCldO1xuXG4gIC8vIEJ1aWxkIGEgZGV0ZXJtaW5pc3RpYyBmaW5nZXJwcmludCBvZiB0aGUgZGVzaXJlZCBncm91cCBzdGF0ZS4gSWYgdGhlXG4gIC8vIGN1cnJlbnQgRE9NIGdyb3VwIGFscmVhZHkgbWF0Y2hlcywgdGhpcyBpcyBhIG5vLW9wIFx1MjAxNCBjcml0aWNhbCwgYmVjYXVzZVxuICAvLyBzeW5jUGFnZXNHcm91cCBpcyBjYWxsZWQgb24gZXZlcnkgTXV0YXRpb25PYnNlcnZlciB0aWNrIGFuZCBhbnkgRE9NXG4gIC8vIHdyaXRlIHdvdWxkIHJlLXRyaWdnZXIgdGhhdCBvYnNlcnZlciAoaW5maW5pdGUgbG9vcCwgYXBwIGZyZWV6ZSkuXG4gIGNvbnN0IGRlc2lyZWRLZXkgPSBwYWdlcy5sZW5ndGggPT09IDBcbiAgICA/IFwiRU1QVFlcIlxuICAgIDogcGFnZXMubWFwKChwKSA9PiBgJHtwLmlkfXwke3AucGFnZS50aXRsZX18JHtwLnBhZ2UuaWNvblN2ZyA/PyBcIlwifWApLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IGdyb3VwQXR0YWNoZWQgPSAhIXN0YXRlLnBhZ2VzR3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUucGFnZXNHcm91cCk7XG4gIGlmIChzdGF0ZS5wYWdlc0dyb3VwS2V5ID09PSBkZXNpcmVkS2V5ICYmIChwYWdlcy5sZW5ndGggPT09IDAgPyAhZ3JvdXBBdHRhY2hlZCA6IGdyb3VwQXR0YWNoZWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwKSB7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwLnJlbW92ZSgpO1xuICAgICAgc3RhdGUucGFnZXNHcm91cCA9IG51bGw7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcCBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkgcC5uYXZCdXR0b24gPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBkZXNpcmVkS2V5O1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxldCBncm91cCA9IHN0YXRlLnBhZ2VzR3JvdXA7XG4gIGlmICghZ3JvdXAgfHwgIW91dGVyLmNvbnRhaW5zKGdyb3VwKSkge1xuICAgIGdyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBncm91cC5kYXRhc2V0LmNvZGV4cHAgPSBcInBhZ2VzLWdyb3VwXCI7XG4gICAgZ3JvdXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1weFwiO1xuICAgIGdyb3VwLmFwcGVuZENoaWxkKHNpZGViYXJHcm91cEhlYWRlcihcIlR3ZWFrc1wiLCBcInB0LTNcIikpO1xuICAgIG91dGVyLmFwcGVuZENoaWxkKGdyb3VwKTtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwID0gZ3JvdXA7XG4gIH0gZWxzZSB7XG4gICAgLy8gU3RyaXAgcHJpb3IgYnV0dG9ucyAoa2VlcCB0aGUgaGVhZGVyIGF0IGluZGV4IDApLlxuICAgIHdoaWxlIChncm91cC5jaGlsZHJlbi5sZW5ndGggPiAxKSBncm91cC5yZW1vdmVDaGlsZChncm91cC5sYXN0Q2hpbGQhKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgcCBvZiBwYWdlcykge1xuICAgIGNvbnN0IGljb24gPSBwLnBhZ2UuaWNvblN2ZyA/PyBkZWZhdWx0UGFnZUljb25TdmcoKTtcbiAgICBjb25zdCBidG4gPSBtYWtlU2lkZWJhckl0ZW0ocC5wYWdlLnRpdGxlLCBpY29uKTtcbiAgICBidG4uZGF0YXNldC5jb2RleHBwID0gYG5hdi1wYWdlLSR7cC5pZH1gO1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IHAuaWQgfSk7XG4gICAgfSk7XG4gICAgcC5uYXZCdXR0b24gPSBidG47XG4gICAgZ3JvdXAuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgfVxuICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gZGVzaXJlZEtleTtcbiAgcGxvZyhcInBhZ2VzIGdyb3VwIHN5bmNlZFwiLCB7XG4gICAgY291bnQ6IHBhZ2VzLmxlbmd0aCxcbiAgICBpZHM6IHBhZ2VzLm1hcCgocCkgPT4gcC5pZCksXG4gIH0pO1xuICAvLyBSZWZsZWN0IGN1cnJlbnQgYWN0aXZlIHN0YXRlIGFjcm9zcyB0aGUgcmVidWlsdCBidXR0b25zLlxuICBzZXROYXZBY3RpdmUoc3RhdGUuYWN0aXZlUGFnZSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VTaWRlYmFySXRlbShsYWJlbDogc3RyaW5nLCBpY29uU3ZnOiBzdHJpbmcpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIC8vIENsYXNzIHN0cmluZyBjb3BpZWQgdmVyYmF0aW0gZnJvbSBDb2RleCdzIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCBldGMpLlxuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5kYXRhc2V0LmNvZGV4cHAgPSBgbmF2LSR7bGFiZWwudG9Mb3dlckNhc2UoKX1gO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiZm9jdXMtdmlzaWJsZTpvdXRsaW5lLXRva2VuLWJvcmRlciByZWxhdGl2ZSBweC1yb3cteCBweS1yb3cteSBjdXJzb3ItaW50ZXJhY3Rpb24gc2hyaW5rLTAgaXRlbXMtY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIHRleHQtbGVmdCB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZSBmb2N1cy12aXNpYmxlOm91dGxpbmUtMiBmb2N1cy12aXNpYmxlOm91dGxpbmUtb2Zmc2V0LTIgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNTAgZ2FwLTIgZmxleCB3LWZ1bGwgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvbnQtbm9ybWFsXCI7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBpbm5lci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciB0ZXh0LWJhc2UgZ2FwLTIgZmxleC0xIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICBpbm5lci5pbm5lckhUTUwgPSBgJHtpY29uU3ZnfTxzcGFuIGNsYXNzPVwidHJ1bmNhdGVcIj4ke2xhYmVsfTwvc3Bhbj5gO1xuICBidG4uYXBwZW5kQ2hpbGQoaW5uZXIpO1xuICByZXR1cm4gYnRuO1xufVxuXG4vKiogSW50ZXJuYWwga2V5IGZvciB0aGUgYnVpbHQtaW4gbmF2IGJ1dHRvbnMuICovXG50eXBlIEJ1aWx0aW5QYWdlID0gXCJjb25maWdcIiB8IFwidHdlYWtzXCI7XG5cbmZ1bmN0aW9uIHNldE5hdkFjdGl2ZShhY3RpdmU6IEFjdGl2ZVBhZ2UgfCBudWxsKTogdm9pZCB7XG4gIC8vIEJ1aWx0LWluIChDb25maWcvVHdlYWtzKSBidXR0b25zLlxuICBpZiAoc3RhdGUubmF2QnV0dG9ucykge1xuICAgIGNvbnN0IGJ1aWx0aW46IEJ1aWx0aW5QYWdlIHwgbnVsbCA9XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwiY29uZmlnXCIgPyBcImNvbmZpZ1wiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwidHdlYWtzXCIgOiBudWxsO1xuICAgIGZvciAoY29uc3QgW2tleSwgYnRuXSBvZiBPYmplY3QuZW50cmllcyhzdGF0ZS5uYXZCdXR0b25zKSBhcyBbQnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50XVtdKSB7XG4gICAgICBhcHBseU5hdkFjdGl2ZShidG4sIGtleSA9PT0gYnVpbHRpbik7XG4gICAgfVxuICB9XG4gIC8vIFBlci1wYWdlIHJlZ2lzdGVyZWQgYnV0dG9ucy5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgaWYgKCFwLm5hdkJ1dHRvbikgY29udGludWU7XG4gICAgY29uc3QgaXNBY3RpdmUgPSBhY3RpdmU/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIGFjdGl2ZS5pZCA9PT0gcC5pZDtcbiAgICBhcHBseU5hdkFjdGl2ZShwLm5hdkJ1dHRvbiwgaXNBY3RpdmUpO1xuICB9XG4gIC8vIENvZGV4J3Mgb3duIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCwgQXBwZWFyYW5jZSwgZXRjKS4gV2hlbiBvbmUgb2ZcbiAgLy8gb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgQ29kZXggc3RpbGwgaGFzIGFyaWEtY3VycmVudD1cInBhZ2VcIiBhbmQgdGhlXG4gIC8vIGFjdGl2ZS1iZyBjbGFzcyBvbiB3aGljaGV2ZXIgaXRlbSBpdCBjb25zaWRlcmVkIHRoZSByb3V0ZSBcdTIwMTQgdHlwaWNhbGx5XG4gIC8vIEdlbmVyYWwuIFRoYXQgbWFrZXMgYm90aCBidXR0b25zIGxvb2sgc2VsZWN0ZWQuIFN0cmlwIENvZGV4J3MgYWN0aXZlXG4gIC8vIHN0eWxpbmcgd2hpbGUgb25lIG9mIG91cnMgaXMgYWN0aXZlOyByZXN0b3JlIGl0IHdoZW4gbm9uZSBpcy5cbiAgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKGFjdGl2ZSAhPT0gbnVsbCk7XG59XG5cbi8qKlxuICogTXV0ZSBDb2RleCdzIG93biBhY3RpdmUtc3RhdGUgc3R5bGluZyBvbiBpdHMgc2lkZWJhciBidXR0b25zLiBXZSBkb24ndFxuICogdG91Y2ggQ29kZXgncyBSZWFjdCBzdGF0ZSBcdTIwMTQgd2hlbiB0aGUgdXNlciBjbGlja3MgYSBuYXRpdmUgaXRlbSwgQ29kZXhcbiAqIHJlLXJlbmRlcnMgdGhlIGJ1dHRvbnMgYW5kIHJlLWFwcGxpZXMgaXRzIG93biBjb3JyZWN0IHN0YXRlLCB0aGVuIG91clxuICogc2lkZWJhci1jbGljayBsaXN0ZW5lciBmaXJlcyBgcmVzdG9yZUNvZGV4Vmlld2AgKHdoaWNoIGNhbGxzIGJhY2sgaW50b1xuICogYHNldE5hdkFjdGl2ZShudWxsKWAgYW5kIGxldHMgQ29kZXgncyBzdHlsaW5nIHN0YW5kKS5cbiAqXG4gKiBgbXV0ZT10cnVlYCAgXHUyMTkyIHN0cmlwIGFyaWEtY3VycmVudCBhbmQgc3dhcCBhY3RpdmUgYmcgXHUyMTkyIGhvdmVyIGJnXG4gKiBgbXV0ZT1mYWxzZWAgXHUyMTkyIG5vLW9wIChDb2RleCdzIG93biByZS1yZW5kZXIgYWxyZWFkeSByZXN0b3JlZCB0aGluZ3MpXG4gKi9cbmZ1bmN0aW9uIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShtdXRlOiBib29sZWFuKTogdm9pZCB7XG4gIGlmICghbXV0ZSkgcmV0dXJuO1xuICBjb25zdCByb290ID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghcm9vdCkgcmV0dXJuO1xuICBjb25zdCBidXR0b25zID0gQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpKTtcbiAgZm9yIChjb25zdCBidG4gb2YgYnV0dG9ucykge1xuICAgIC8vIFNraXAgb3VyIG93biBidXR0b25zLlxuICAgIGlmIChidG4uZGF0YXNldC5jb2RleHBwKSBjb250aW51ZTtcbiAgICBpZiAoYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIpIHtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgfVxuICAgIGlmIChidG4uY2xhc3NMaXN0LmNvbnRhaW5zKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseU5hdkFjdGl2ZShidG46IEhUTUxCdXR0b25FbGVtZW50LCBhY3RpdmU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgaW5uZXIgPSBidG4uZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoYWN0aXZlKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiLCBcImZvbnQtbm9ybWFsXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIsIFwicGFnZVwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBhY3RpdmF0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBhY3RpdmF0ZVBhZ2UocGFnZTogQWN0aXZlUGFnZSk6IHZvaWQge1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkge1xuICAgIHBsb2coXCJhY3RpdmF0ZTogY29udGVudCBhcmVhIG5vdCBmb3VuZFwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IHBhZ2U7XG4gIHBsb2coXCJhY3RpdmF0ZVwiLCB7IHBhZ2UgfSk7XG5cbiAgLy8gSGlkZSBDb2RleCdzIGNvbnRlbnQgY2hpbGRyZW4sIHNob3cgb3Vycy5cbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwID09PSBcInR3ZWFrcy1wYW5lbFwiKSBjb250aW51ZTtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbiA9IGNoaWxkLnN0eWxlLmRpc3BsYXkgfHwgXCJcIjtcbiAgICB9XG4gICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICB9XG4gIGxldCBwYW5lbCA9IGNvbnRlbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLWNvZGV4cHA9XCJ0d2Vha3MtcGFuZWxcIl0nKTtcbiAgaWYgKCFwYW5lbCkge1xuICAgIHBhbmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBwYW5lbC5kYXRhc2V0LmNvZGV4cHAgPSBcInR3ZWFrcy1wYW5lbFwiO1xuICAgIHBhbmVsLnN0eWxlLmNzc1RleHQgPSBcIndpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3ZlcmZsb3c6YXV0bztcIjtcbiAgICBjb250ZW50LmFwcGVuZENoaWxkKHBhbmVsKTtcbiAgfVxuICBwYW5lbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICBzdGF0ZS5wYW5lbEhvc3QgPSBwYW5lbDtcbiAgcmVyZW5kZXIoKTtcbiAgc2V0TmF2QWN0aXZlKHBhZ2UpO1xuICAvLyByZXN0b3JlIENvZGV4J3Mgdmlldy4gUmUtcmVnaXN0ZXIgaWYgbmVlZGVkLlxuICBjb25zdCBzaWRlYmFyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmIChzaWRlYmFyKSB7XG4gICAgaWYgKHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgICAgc2lkZWJhci5yZW1vdmVFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLCB0cnVlKTtcbiAgICB9XG4gICAgY29uc3QgaGFuZGxlciA9IChlOiBFdmVudCkgPT4ge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICAgIGlmIChzdGF0ZS5uYXZHcm91cD8uY29udGFpbnModGFyZ2V0KSkgcmV0dXJuOyAvLyBvdXIgYnV0dG9uc1xuICAgICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIHBhZ2UgYnV0dG9uc1xuICAgICAgaWYgKHRhcmdldC5jbG9zZXN0KFwiW2RhdGEtY29kZXhwcC1zZXR0aW5ncy1zZWFyY2hdXCIpKSByZXR1cm47XG4gICAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gICAgfTtcbiAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIgPSBoYW5kbGVyO1xuICAgIHNpZGViYXIuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZXIsIHRydWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc3RvcmVDb2RleFZpZXcoKTogdm9pZCB7XG4gIHBsb2coXCJyZXN0b3JlIGNvZGV4IHZpZXdcIik7XG4gIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm47XG4gIGlmIChzdGF0ZS5wYW5lbEhvc3QpIHN0YXRlLnBhbmVsSG9zdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkID09PSBzdGF0ZS5wYW5lbEhvc3QpIGNvbnRpbnVlO1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbjtcbiAgICAgIGRlbGV0ZSBjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW47XG4gICAgfVxuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICBzZXROYXZBY3RpdmUobnVsbCk7XG4gIGlmIChzdGF0ZS5zaWRlYmFyUm9vdCAmJiBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdC5yZW1vdmVFdmVudExpc3RlbmVyKFxuICAgICAgXCJjbGlja1wiLFxuICAgICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciA9IG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVyZW5kZXIoKTogdm9pZCB7XG4gIGlmICghc3RhdGUuYWN0aXZlUGFnZSkgcmV0dXJuO1xuICBjb25zdCBob3N0ID0gc3RhdGUucGFuZWxIb3N0O1xuICBpZiAoIWhvc3QpIHJldHVybjtcbiAgaG9zdC5pbm5lckhUTUwgPSBcIlwiO1xuXG4gIGNvbnN0IGFwID0gc3RhdGUuYWN0aXZlUGFnZTtcbiAgaWYgKGFwLmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgY29uc3QgZW50cnkgPSBzdGF0ZS5wYWdlcy5nZXQoYXAuaWQpO1xuICAgIGlmICghZW50cnkpIHtcbiAgICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qgcm9vdCA9IHBhbmVsU2hlbGwoZW50cnkucGFnZS50aXRsZSwgZW50cnkucGFnZS5kZXNjcmlwdGlvbik7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChyb290Lm91dGVyKTtcbiAgICB0cnkge1xuICAgICAgLy8gVGVhciBkb3duIGFueSBwcmlvciByZW5kZXIgYmVmb3JlIHJlLXJlbmRlcmluZyAoaG90IHJlbG9hZCkuXG4gICAgICB0cnkgeyBlbnRyeS50ZWFyZG93bj8uKCk7IH0gY2F0Y2gge31cbiAgICAgIGVudHJ5LnRlYXJkb3duID0gbnVsbDtcbiAgICAgIGNvbnN0IHJldCA9IGVudHJ5LnBhZ2UucmVuZGVyKHJvb3Quc2VjdGlvbnNXcmFwKTtcbiAgICAgIGlmICh0eXBlb2YgcmV0ID09PSBcImZ1bmN0aW9uXCIpIGVudHJ5LnRlYXJkb3duID0gcmV0O1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGVyciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBlcnIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWNoYXJ0cy1yZWQgdGV4dC1zbVwiO1xuICAgICAgZXJyLnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyBwYWdlOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICByb290LnNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChlcnIpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0aXRsZSA9IGFwLmtpbmQgPT09IFwidHdlYWtzXCIgPyBcIlR3ZWFrc1wiIDogXCJDb25maWdcIjtcbiAgY29uc3Qgc3VidGl0bGUgPSBhcC5raW5kID09PSBcInR3ZWFrc1wiXG4gICAgPyBcIk1hbmFnZSB5b3VyIGluc3RhbGxlZCBDb2RleCsrIHR3ZWFrcy5cIlxuICAgIDogXCJDaGVja2luZyBpbnN0YWxsZWQgQ29kZXgrKyB2ZXJzaW9uLlwiO1xuICBjb25zdCByb290ID0gcGFuZWxTaGVsbCh0aXRsZSwgc3VidGl0bGUpO1xuICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICBpZiAoYXAua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVuZGVyVHdlYWtzUGFnZShyb290LnNlY3Rpb25zV3JhcCk7XG4gIGVsc2UgcmVuZGVyQ29uZmlnUGFnZShyb290LnNlY3Rpb25zV3JhcCwgcm9vdC5zdWJ0aXRsZSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBwYWdlcyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcmVuZGVyQ29uZmlnUGFnZShzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LCBzdWJ0aXRsZT86IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJDb2RleCsrIFVwZGF0ZXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY29uc3QgbG9hZGluZyA9IHJvd1NpbXBsZShcIkxvYWRpbmcgdXBkYXRlIHNldHRpbmdzXCIsIFwiQ2hlY2tpbmcgY3VycmVudCBDb2RleCsrIGNvbmZpZ3VyYXRpb24uXCIpO1xuICBjYXJkLmFwcGVuZENoaWxkKGxvYWRpbmcpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC1jb25maWdcIilcbiAgICAudGhlbigoY29uZmlnKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHtcbiAgICAgICAgc3VidGl0bGUudGV4dENvbnRlbnQgPSBgWW91IGhhdmUgQ29kZXgrKyAkeyhjb25maWcgYXMgQ29kZXhQbHVzUGx1c0NvbmZpZykudmVyc2lvbn0gaW5zdGFsbGVkLmA7XG4gICAgICB9XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlckNvZGV4UGx1c1BsdXNDb25maWcoY2FyZCwgY29uZmlnIGFzIENvZGV4UGx1c1BsdXNDb25maWcpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHN1YnRpdGxlLnRleHRDb250ZW50ID0gXCJDb3VsZCBub3QgbG9hZCBpbnN0YWxsZWQgQ29kZXgrKyB2ZXJzaW9uLlwiO1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCBsb2FkIHVwZGF0ZSBzZXR0aW5nc1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcblxuICBjb25zdCB3YXRjaGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdhdGNoZXIuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHdhdGNoZXIuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiQXV0by1SZXBhaXIgV2F0Y2hlclwiKSk7XG4gIGNvbnN0IHdhdGNoZXJDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgd2F0Y2hlckNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgd2F0Y2hlclwiLCBcIlZlcmlmeWluZyB0aGUgdXBkYXRlciByZXBhaXIgc2VydmljZS5cIikpO1xuICB3YXRjaGVyLmFwcGVuZENoaWxkKHdhdGNoZXJDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHdhdGNoZXIpO1xuICByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZCh3YXRjaGVyQ2FyZCk7XG5cbiAgY29uc3QgY2RwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIGNkcC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgY2RwLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkRldmVsb3BlciAvIENEUFwiKSk7XG4gIGNvbnN0IGNkcENhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjZHBDYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIENEUFwiLCBcIlJlYWRpbmcgQ2hyb21lIERldlRvb2xzIFByb3RvY29sIHN0YXR1cy5cIikpO1xuICBjZHAuYXBwZW5kQ2hpbGQoY2RwQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChjZHApO1xuICByZW5kZXJDZHBDYXJkKGNkcENhcmQpO1xuXG4gIGNvbnN0IG1haW50ZW5hbmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIG1haW50ZW5hbmNlLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBtYWludGVuYW5jZS5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJNYWludGVuYW5jZVwiKSk7XG4gIGNvbnN0IG1haW50ZW5hbmNlQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZCh1bmluc3RhbGxSb3coKSk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZChyZXBvcnRCdWdSb3coKSk7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChtYWludGVuYW5jZSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNvZGV4UGx1c1BsdXNDb25maWcoY2FyZDogSFRNTEVsZW1lbnQsIGNvbmZpZzogQ29kZXhQbHVzUGx1c0NvbmZpZyk6IHZvaWQge1xuICBjYXJkLmFwcGVuZENoaWxkKGF1dG9VcGRhdGVSb3coY29uZmlnKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY2hlY2tGb3JVcGRhdGVzUm93KGNvbmZpZy51cGRhdGVDaGVjaykpO1xuICBpZiAoY29uZmlnLnVwZGF0ZUNoZWNrKSBjYXJkLmFwcGVuZENoaWxkKHJlbGVhc2VOb3Rlc1Jvdyhjb25maWcudXBkYXRlQ2hlY2spKTtcbn1cblxuZnVuY3Rpb24gYXV0b1VwZGF0ZVJvdyhjb25maWc6IENvZGV4UGx1c1BsdXNDb25maWcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiQXV0b21hdGljYWxseSByZWZyZXNoIENvZGV4KytcIjtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gYEluc3RhbGxlZCB2ZXJzaW9uIHYke2NvbmZpZy52ZXJzaW9ufS4gVGhlIHdhdGNoZXIgY2FuIHJlZnJlc2ggdGhlIENvZGV4KysgcnVudGltZSBhZnRlciB5b3UgcmVydW4gdGhlIEdpdEh1YiBpbnN0YWxsZXIuYDtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgcm93LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2woY29uZmlnLmF1dG9VcGRhdGUsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnNldC1hdXRvLXVwZGF0ZVwiLCBuZXh0KTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY2hlY2tGb3JVcGRhdGVzUm93KGNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBjaGVjaz8udXBkYXRlQXZhaWxhYmxlID8gXCJDb2RleCsrIHVwZGF0ZSBhdmFpbGFibGVcIiA6IFwiQ29kZXgrKyBpcyB1cCB0byBkYXRlXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IHVwZGF0ZVN1bW1hcnkoY2hlY2spO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgaWYgKGNoZWNrPy5yZWxlYXNlVXJsKSB7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgIGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlIE5vdGVzXCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgY2hlY2sucmVsZWFzZVVybCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiMC42NVwiO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpjaGVjay1jb2RleHBwLXVwZGF0ZVwiLCB0cnVlKVxuICAgICAgICAudGhlbigobmV4dCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGNhcmQgPSByb3cucGFyZW50RWxlbWVudDtcbiAgICAgICAgICBpZiAoIWNhcmQpIHJldHVybjtcbiAgICAgICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2V0LWNvbmZpZ1wiKS50aGVuKChjb25maWcpID0+IHtcbiAgICAgICAgICAgIHJlbmRlckNvZGV4UGx1c1BsdXNDb25maWcoY2FyZCwge1xuICAgICAgICAgICAgICAuLi4oY29uZmlnIGFzIENvZGV4UGx1c1BsdXNDb25maWcpLFxuICAgICAgICAgICAgICB1cGRhdGVDaGVjazogbmV4dCBhcyBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2ssXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiQ29kZXgrKyB1cGRhdGUgY2hlY2sgZmFpbGVkXCIsIFN0cmluZyhlKSkpXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICAgIH0pO1xuICAgIH0pLFxuICApO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbGVhc2VOb3Rlc1JvdyhjaGVjazogQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yIHAtM1wiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiTGF0ZXN0IHJlbGVhc2Ugbm90ZXNcIjtcbiAgcm93LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJvZHkuY2xhc3NOYW1lID1cbiAgICBcIm1heC1oLTYwIG92ZXJmbG93LWF1dG8gcm91bmRlZC1tZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcC0zIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBib2R5LmFwcGVuZENoaWxkKHJlbmRlclJlbGVhc2VOb3Rlc01hcmtkb3duKGNoZWNrLnJlbGVhc2VOb3Rlcz8udHJpbSgpIHx8IGNoZWNrLmVycm9yIHx8IFwiTm8gcmVsZWFzZSBub3RlcyBhdmFpbGFibGUuXCIpKTtcbiAgcm93LmFwcGVuZENoaWxkKGJvZHkpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZW5kZXJDZHBDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnZXQtY2RwLXN0YXR1c1wiKVxuICAgIC50aGVuKChzdGF0dXMpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyQ2RwU3RhdHVzKGNhcmQsIHN0YXR1cyBhcyBDb2RleENkcFN0YXR1cyk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgcmVhZCBDRFAgc3RhdHVzXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDZHBTdGF0dXMoY2FyZDogSFRNTEVsZW1lbnQsIHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiB2b2lkIHtcbiAgY2FyZC5hcHBlbmRDaGlsZChjZHBUb2dnbGVSb3coY2FyZCwgc3RhdHVzKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY2RwUG9ydFJvdyhjYXJkLCBzdGF0dXMpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjZHBFbmRwb2ludFJvdyhzdGF0dXMpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjZHBMYXVuY2hSb3coc3RhdHVzKSk7XG4gIGlmIChzdGF0dXMucmVzdGFydFJlcXVpcmVkKSB7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChcbiAgICAgIHJvd1NpbXBsZShcbiAgICAgICAgXCJSZXN0YXJ0IHJlcXVpcmVkXCIsXG4gICAgICAgIHN0YXR1cy5lbmFibGVkXG4gICAgICAgICAgPyBcIkNEUCB3aWxsIHVzZSB0aGUgc2F2ZWQgcG9ydCBhZnRlciBDb2RleCByZXN0YXJ0cy5cIlxuICAgICAgICAgIDogXCJDRFAgaXMgc3RpbGwgYWN0aXZlIGZvciB0aGlzIHByb2Nlc3MgYW5kIHdpbGwgdHVybiBvZmYgYWZ0ZXIgQ29kZXggcmVzdGFydHMuXCIsXG4gICAgICApLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY2RwVG9nZ2xlUm93KGNhcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChjZHBTdGF0dXNCYWRnZShzdGF0dXMpKTtcblxuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkNocm9tZSBEZXZUb29scyBQcm90b2NvbFwiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBjZHBTdGF0dXNTdW1tYXJ5KHN0YXR1cyk7XG4gIHN0YWNrLmFwcGVuZCh0aXRsZSwgZGVzYyk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgcm93LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2woc3RhdHVzLmVuYWJsZWQsIGFzeW5jIChlbmFibGVkKSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnNldC1jZHAtY29uZmlnXCIsIHtcbiAgICAgICAgZW5hYmxlZCxcbiAgICAgICAgcG9ydDogc3RhdHVzLmNvbmZpZ3VyZWRQb3J0LFxuICAgICAgfSk7XG4gICAgICByZWZyZXNoQ2RwQ2FyZChjYXJkKTtcbiAgICB9KSxcbiAgKTtcblxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjZHBQb3J0Um93KGNhcmQ6IEhUTUxFbGVtZW50LCBzdGF0dXM6IENvZGV4Q2RwU3RhdHVzKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJSZW1vdGUgZGVidWdnaW5nIHBvcnRcIixcbiAgICBzdGF0dXMuYWN0aXZlUG9ydFxuICAgICAgPyBgQ3VycmVudCBwcm9jZXNzIGlzIGxpc3RlbmluZyBvbiAke3N0YXR1cy5hY3RpdmVQb3J0fS5gXG4gICAgICA6IGBTYXZlZCBwb3J0IGlzICR7c3RhdHVzLmNvbmZpZ3VyZWRQb3J0fS5gLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW5wdXRcIik7XG4gIGlucHV0LnR5cGUgPSBcIm51bWJlclwiO1xuICBpbnB1dC5taW4gPSBcIjFcIjtcbiAgaW5wdXQubWF4ID0gXCI2NTUzNVwiO1xuICBpbnB1dC5zdGVwID0gXCIxXCI7XG4gIGlucHV0LnZhbHVlID0gU3RyaW5nKHN0YXR1cy5jb25maWd1cmVkUG9ydCk7XG4gIGlucHV0LmNsYXNzTmFtZSA9XG4gICAgXCJoLTggdy0yNCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRyYW5zcGFyZW50IHB4LTIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1czpvdXRsaW5lLW5vbmUgZm9jdXM6cmluZy0yIGZvY3VzOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCI7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoaW5wdXQpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJTYXZlXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IHBvcnQgPSBOdW1iZXIoaW5wdXQudmFsdWUpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpzZXQtY2RwLWNvbmZpZ1wiLCB7XG4gICAgICAgICAgZW5hYmxlZDogc3RhdHVzLmVuYWJsZWQsXG4gICAgICAgICAgcG9ydDogTnVtYmVyLmlzSW50ZWdlcihwb3J0KSA/IHBvcnQgOiBzdGF0dXMuY29uZmlndXJlZFBvcnQsXG4gICAgICAgIH0pXG4gICAgICAgIC50aGVuKCgpID0+IHJlZnJlc2hDZHBDYXJkKGNhcmQpKVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJDRFAgcG9ydCBzYXZlIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY2RwRW5kcG9pbnRSb3coc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIHN0YXR1cy5hY3RpdmUgPyBcIkxvY2FsIENEUCBlbmRwb2ludHNcIiA6IFwiTG9jYWwgQ0RQIGVuZHBvaW50c1wiLFxuICAgIHN0YXR1cy5hY3RpdmUgJiYgc3RhdHVzLmpzb25MaXN0VXJsXG4gICAgICA/IGAke3N0YXR1cy5qc29uTGlzdFVybH1gXG4gICAgICA6IFwiTm90IGV4cG9zZWQgYnkgdGhlIGN1cnJlbnQgQ29kZXggcHJvY2Vzcy5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGNvbnN0IG9wZW5UYXJnZXRzID0gY29tcGFjdEJ1dHRvbihcIk9wZW4gVGFyZ2V0c1wiLCAoKSA9PiB7XG4gICAgaWYgKCFzdGF0dXMuanNvbkxpc3RVcmwpIHJldHVybjtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1jZHAtdXJsXCIsIHN0YXR1cy5qc29uTGlzdFVybCk7XG4gIH0pO1xuICBvcGVuVGFyZ2V0cy5kaXNhYmxlZCA9ICFzdGF0dXMuanNvbkxpc3RVcmw7XG4gIGNvbnN0IGNvcHlUYXJnZXRzID0gY29tcGFjdEJ1dHRvbihcIkNvcHkgVVJMXCIsICgpID0+IHtcbiAgICBpZiAoIXN0YXR1cy5qc29uTGlzdFVybCkgcmV0dXJuO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb3B5LXRleHRcIiwgc3RhdHVzLmpzb25MaXN0VXJsKTtcbiAgfSk7XG4gIGNvcHlUYXJnZXRzLmRpc2FibGVkID0gIXN0YXR1cy5qc29uTGlzdFVybDtcbiAgY29uc3Qgb3BlblZlcnNpb24gPSBjb21wYWN0QnV0dG9uKFwiVmVyc2lvblwiLCAoKSA9PiB7XG4gICAgaWYgKCFzdGF0dXMuanNvblZlcnNpb25VcmwpIHJldHVybjtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1jZHAtdXJsXCIsIHN0YXR1cy5qc29uVmVyc2lvblVybCk7XG4gIH0pO1xuICBvcGVuVmVyc2lvbi5kaXNhYmxlZCA9ICFzdGF0dXMuanNvblZlcnNpb25Vcmw7XG4gIGFjdGlvbj8uYXBwZW5kKG9wZW5UYXJnZXRzLCBjb3B5VGFyZ2V0cywgb3BlblZlcnNpb24pO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjZHBMYXVuY2hSb3coc3RhdHVzOiBDb2RleENkcFN0YXR1cyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiTGF1bmNoIGNvbW1hbmRcIixcbiAgICBzdGF0dXMuYXBwUm9vdCA/IHN0YXR1cy5hcHBSb290IDogXCJDb2RleCBhcHAgcGF0aCB3YXMgbm90IGZvdW5kIGluIGluc3RhbGxlciBzdGF0ZS5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNvcHkgQ29tbWFuZFwiLCAoKSA9PiB7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29weS10ZXh0XCIsIHN0YXR1cy5sYXVuY2hDb21tYW5kKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVmcmVzaENkcENhcmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgQ0RQXCIsIFwiUmVhZGluZyBDaHJvbWUgRGV2VG9vbHMgUHJvdG9jb2wgc3RhdHVzLlwiKSk7XG4gIHJlbmRlckNkcENhcmQoY2FyZCk7XG59XG5cbmZ1bmN0aW9uIGNkcFN0YXR1c0JhZGdlKHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBIVE1MRWxlbWVudCB7XG4gIGlmIChzdGF0dXMuYWN0aXZlKSByZXR1cm4gc3RhdHVzQmFkZ2Uoc3RhdHVzLnJlc3RhcnRSZXF1aXJlZCA/IFwid2FyblwiIDogXCJva1wiLCBcIkFjdGl2ZVwiKTtcbiAgaWYgKHN0YXR1cy5yZXN0YXJ0UmVxdWlyZWQpIHJldHVybiBzdGF0dXNCYWRnZShcIndhcm5cIiwgXCJSZXN0YXJ0XCIpO1xuICByZXR1cm4gc3RhdHVzQmFkZ2Uoc3RhdHVzLmVuYWJsZWQgPyBcIndhcm5cIiA6IFwid2FyblwiLCBzdGF0dXMuZW5hYmxlZCA/IFwiU2F2ZWRcIiA6IFwiT2ZmXCIpO1xufVxuXG5mdW5jdGlvbiBjZHBTdGF0dXNTdW1tYXJ5KHN0YXR1czogQ29kZXhDZHBTdGF0dXMpOiBzdHJpbmcge1xuICBpZiAoc3RhdHVzLmFjdGl2ZVBvcnQpIHtcbiAgICBjb25zdCBzb3VyY2UgPSBzdGF0dXMuc291cmNlID09PSBcImFyZ3ZcIiA/IFwibGF1bmNoIGFyZ1wiIDogc3RhdHVzLnNvdXJjZTtcbiAgICByZXR1cm4gYEFjdGl2ZSBvbiAxMjcuMC4wLjE6JHtzdGF0dXMuYWN0aXZlUG9ydH0gZnJvbSAke3NvdXJjZX0uYDtcbiAgfVxuICBpZiAoc3RhdHVzLmVuYWJsZWQpIHtcbiAgICByZXR1cm4gYEVuYWJsZWQgZm9yIG5leHQgbGF1bmNoIG9uIDEyNy4wLjAuMToke3N0YXR1cy5jb25maWd1cmVkUG9ydH0uYDtcbiAgfVxuICByZXR1cm4gXCJEaXNhYmxlZCBmb3IgQ29kZXggbGF1bmNoZXMgbWFuYWdlZCBieSBDb2RleCsrLlwiO1xufVxuXG5mdW5jdGlvbiByZW5kZXJSZWxlYXNlTm90ZXNNYXJrZG93bihtYXJrZG93bjogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb290ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm9vdC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgY29uc3QgbGluZXMgPSBtYXJrZG93bi5yZXBsYWNlKC9cXHJcXG4/L2csIFwiXFxuXCIpLnNwbGl0KFwiXFxuXCIpO1xuICBsZXQgcGFyYWdyYXBoOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgbGlzdDogSFRNTE9MaXN0RWxlbWVudCB8IEhUTUxVTGlzdEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGNvZGVMaW5lczogc3RyaW5nW10gfCBudWxsID0gbnVsbDtcblxuICBjb25zdCBmbHVzaFBhcmFncmFwaCA9ICgpID0+IHtcbiAgICBpZiAocGFyYWdyYXBoLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IHAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICBwLmNsYXNzTmFtZSA9IFwibS0wIGxlYWRpbmctNVwiO1xuICAgIGFwcGVuZElubGluZU1hcmtkb3duKHAsIHBhcmFncmFwaC5qb2luKFwiIFwiKS50cmltKCkpO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQocCk7XG4gICAgcGFyYWdyYXBoID0gW107XG4gIH07XG4gIGNvbnN0IGZsdXNoTGlzdCA9ICgpID0+IHtcbiAgICBpZiAoIWxpc3QpIHJldHVybjtcbiAgICByb290LmFwcGVuZENoaWxkKGxpc3QpO1xuICAgIGxpc3QgPSBudWxsO1xuICB9O1xuICBjb25zdCBmbHVzaENvZGUgPSAoKSA9PiB7XG4gICAgaWYgKCFjb2RlTGluZXMpIHJldHVybjtcbiAgICBjb25zdCBwcmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicHJlXCIpO1xuICAgIHByZS5jbGFzc05hbWUgPVxuICAgICAgXCJtLTAgb3ZlcmZsb3ctYXV0byByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvMTAgcC0yIHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICBjb25zdCBjb2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImNvZGVcIik7XG4gICAgY29kZS50ZXh0Q29udGVudCA9IGNvZGVMaW5lcy5qb2luKFwiXFxuXCIpO1xuICAgIHByZS5hcHBlbmRDaGlsZChjb2RlKTtcbiAgICByb290LmFwcGVuZENoaWxkKHByZSk7XG4gICAgY29kZUxpbmVzID0gbnVsbDtcbiAgfTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBpZiAobGluZS50cmltKCkuc3RhcnRzV2l0aChcImBgYFwiKSkge1xuICAgICAgaWYgKGNvZGVMaW5lcykgZmx1c2hDb2RlKCk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICAgIGNvZGVMaW5lcyA9IFtdO1xuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjb2RlTGluZXMpIHtcbiAgICAgIGNvZGVMaW5lcy5wdXNoKGxpbmUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgdHJpbW1lZCA9IGxpbmUudHJpbSgpO1xuICAgIGlmICghdHJpbW1lZCkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgaGVhZGluZyA9IC9eKCN7MSwzfSlcXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKGhlYWRpbmcpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBmbHVzaExpc3QoKTtcbiAgICAgIGNvbnN0IGggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KGhlYWRpbmdbMV0ubGVuZ3RoID09PSAxID8gXCJoM1wiIDogXCJoNFwiKTtcbiAgICAgIGguY2xhc3NOYW1lID0gXCJtLTAgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgICAgYXBwZW5kSW5saW5lTWFya2Rvd24oaCwgaGVhZGluZ1syXSk7XG4gICAgICByb290LmFwcGVuZENoaWxkKGgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgdW5vcmRlcmVkID0gL15bLSpdXFxzKyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGNvbnN0IG9yZGVyZWQgPSAvXlxcZCtbLildXFxzKyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmICh1bm9yZGVyZWQgfHwgb3JkZXJlZCkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGNvbnN0IHdhbnRPcmRlcmVkID0gQm9vbGVhbihvcmRlcmVkKTtcbiAgICAgIGlmICghbGlzdCB8fCAod2FudE9yZGVyZWQgJiYgbGlzdC50YWdOYW1lICE9PSBcIk9MXCIpIHx8ICghd2FudE9yZGVyZWQgJiYgbGlzdC50YWdOYW1lICE9PSBcIlVMXCIpKSB7XG4gICAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgICBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCh3YW50T3JkZXJlZCA/IFwib2xcIiA6IFwidWxcIik7XG4gICAgICAgIGxpc3QuY2xhc3NOYW1lID0gd2FudE9yZGVyZWRcbiAgICAgICAgICA/IFwibS0wIGxpc3QtZGVjaW1hbCBzcGFjZS15LTEgcGwtNSBsZWFkaW5nLTVcIlxuICAgICAgICAgIDogXCJtLTAgbGlzdC1kaXNjIHNwYWNlLXktMSBwbC01IGxlYWRpbmctNVwiO1xuICAgICAgfVxuICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihsaSwgKHVub3JkZXJlZCA/PyBvcmRlcmVkKT8uWzFdID8/IFwiXCIpO1xuICAgICAgbGlzdC5hcHBlbmRDaGlsZChsaSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBxdW90ZSA9IC9ePlxccz8oLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAocXVvdGUpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBmbHVzaExpc3QoKTtcbiAgICAgIGNvbnN0IGJsb2NrcXVvdGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYmxvY2txdW90ZVwiKTtcbiAgICAgIGJsb2NrcXVvdGUuY2xhc3NOYW1lID0gXCJtLTAgYm9yZGVyLWwtMiBib3JkZXItdG9rZW4tYm9yZGVyIHBsLTMgbGVhZGluZy01XCI7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihibG9ja3F1b3RlLCBxdW90ZVsxXSk7XG4gICAgICByb290LmFwcGVuZENoaWxkKGJsb2NrcXVvdGUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgcGFyYWdyYXBoLnB1c2godHJpbW1lZCk7XG4gIH1cblxuICBmbHVzaFBhcmFncmFwaCgpO1xuICBmbHVzaExpc3QoKTtcbiAgZmx1c2hDb2RlKCk7XG4gIHJldHVybiByb290O1xufVxuXG5mdW5jdGlvbiBhcHBlbmRJbmxpbmVNYXJrZG93bihwYXJlbnQ6IEhUTUxFbGVtZW50LCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgcGF0dGVybiA9IC8oYChbXmBdKylgfFxcWyhbXlxcXV0rKVxcXVxcKChodHRwcz86XFwvXFwvW15cXHMpXSspXFwpfFxcKlxcKihbXipdKylcXCpcXCp8XFwqKFteKl0rKVxcKikvZztcbiAgbGV0IGxhc3RJbmRleCA9IDA7XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgdGV4dC5tYXRjaEFsbChwYXR0ZXJuKSkge1xuICAgIGlmIChtYXRjaC5pbmRleCA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBhcHBlbmRUZXh0KHBhcmVudCwgdGV4dC5zbGljZShsYXN0SW5kZXgsIG1hdGNoLmluZGV4KSk7XG4gICAgaWYgKG1hdGNoWzJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGNvZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY29kZVwiKTtcbiAgICAgIGNvZGUuY2xhc3NOYW1lID1cbiAgICAgICAgXCJyb3VuZGVkIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvMTAgcHgtMSBweS0wLjUgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgICAgY29kZS50ZXh0Q29udGVudCA9IG1hdGNoWzJdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKGNvZGUpO1xuICAgIH0gZWxzZSBpZiAobWF0Y2hbM10gIT09IHVuZGVmaW5lZCAmJiBtYXRjaFs0XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gICAgICBhLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXByaW1hcnkgdW5kZXJsaW5lIHVuZGVybGluZS1vZmZzZXQtMlwiO1xuICAgICAgYS5ocmVmID0gbWF0Y2hbNF07XG4gICAgICBhLnRhcmdldCA9IFwiX2JsYW5rXCI7XG4gICAgICBhLnJlbCA9IFwibm9vcGVuZXIgbm9yZWZlcnJlclwiO1xuICAgICAgYS50ZXh0Q29udGVudCA9IG1hdGNoWzNdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKGEpO1xuICAgIH0gZWxzZSBpZiAobWF0Y2hbNV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3Qgc3Ryb25nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN0cm9uZ1wiKTtcbiAgICAgIHN0cm9uZy5jbGFzc05hbWUgPSBcImZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBzdHJvbmcudGV4dENvbnRlbnQgPSBtYXRjaFs1XTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChzdHJvbmcpO1xuICAgIH0gZWxzZSBpZiAobWF0Y2hbNl0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZW1cIik7XG4gICAgICBlbS50ZXh0Q29udGVudCA9IG1hdGNoWzZdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKGVtKTtcbiAgICB9XG4gICAgbGFzdEluZGV4ID0gbWF0Y2guaW5kZXggKyBtYXRjaFswXS5sZW5ndGg7XG4gIH1cbiAgYXBwZW5kVGV4dChwYXJlbnQsIHRleHQuc2xpY2UobGFzdEluZGV4KSk7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZFRleHQocGFyZW50OiBIVE1MRWxlbWVudCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICh0ZXh0KSBwYXJlbnQuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUodGV4dCkpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZChjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcImNvZGV4cHA6Z2V0LXdhdGNoZXItaGVhbHRoXCIpXG4gICAgLnRoZW4oKGhlYWx0aCkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIGhlYWx0aCBhcyBXYXRjaGVySGVhbHRoKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCBjaGVjayB3YXRjaGVyXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQ6IEhUTUxFbGVtZW50LCBoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiB2b2lkIHtcbiAgY2FyZC5hcHBlbmRDaGlsZCh3YXRjaGVyU3VtbWFyeVJvdyhoZWFsdGgpKTtcbiAgZm9yIChjb25zdCBjaGVjayBvZiBoZWFsdGguY2hlY2tzKSB7XG4gICAgaWYgKGNoZWNrLnN0YXR1cyA9PT0gXCJva1wiKSBjb250aW51ZTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHdhdGNoZXJDaGVja1JvdyhjaGVjaykpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHdhdGNoZXJTdW1tYXJ5Um93KGhlYWx0aDogV2F0Y2hlckhlYWx0aCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1zdGFydCBnYXAtM1wiO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKGhlYWx0aC5zdGF0dXMsIGhlYWx0aC53YXRjaGVyKSk7XG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGhlYWx0aC50aXRsZTtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gYCR7aGVhbHRoLnN1bW1hcnl9IENoZWNrZWQgJHtuZXcgRGF0ZShoZWFsdGguY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpfS5gO1xuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKGRlc2MpO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGFjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGFjdGlvbi5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgTm93XCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNhcmQgPSByb3cucGFyZW50RWxlbWVudDtcbiAgICAgIGlmICghY2FyZCkgcmV0dXJuO1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIHdhdGNoZXJcIiwgXCJWZXJpZnlpbmcgdGhlIHVwZGF0ZXIgcmVwYWlyIHNlcnZpY2UuXCIpKTtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQpO1xuICAgIH0pLFxuICApO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9uKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gd2F0Y2hlckNoZWNrUm93KGNoZWNrOiBXYXRjaGVySGVhbHRoQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IHJvd1NpbXBsZShjaGVjay5uYW1lLCBjaGVjay5kZXRhaWwpO1xuICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGxlZnQpIGxlZnQucHJlcGVuZChzdGF0dXNCYWRnZShjaGVjay5zdGF0dXMpKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gc3RhdHVzQmFkZ2Uoc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiwgbGFiZWw/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbnN0IHRvbmUgPVxuICAgIHN0YXR1cyA9PT0gXCJva1wiXG4gICAgICA/IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1ncmVlbiB0ZXh0LXRva2VuLWNoYXJ0cy1ncmVlblwiXG4gICAgICA6IHN0YXR1cyA9PT0gXCJ3YXJuXCJcbiAgICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMteWVsbG93IHRleHQtdG9rZW4tY2hhcnRzLXllbGxvd1wiXG4gICAgICAgIDogXCJib3JkZXItdG9rZW4tY2hhcnRzLXJlZCB0ZXh0LXRva2VuLWNoYXJ0cy1yZWRcIjtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gYGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgYm9yZGVyIHB4LTIgcHktMC41IHRleHQteHMgZm9udC1tZWRpdW0gJHt0b25lfWA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gbGFiZWwgfHwgKHN0YXR1cyA9PT0gXCJva1wiID8gXCJPS1wiIDogc3RhdHVzID09PSBcIndhcm5cIiA/IFwiUmV2aWV3XCIgOiBcIkVycm9yXCIpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVN1bW1hcnkoY2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoIWNoZWNrKSByZXR1cm4gXCJObyB1cGRhdGUgY2hlY2sgaGFzIHJ1biB5ZXQuXCI7XG4gIGNvbnN0IGxhdGVzdCA9IGNoZWNrLmxhdGVzdFZlcnNpb24gPyBgTGF0ZXN0IHYke2NoZWNrLmxhdGVzdFZlcnNpb259LiBgIDogXCJcIjtcbiAgY29uc3QgY2hlY2tlZCA9IGBDaGVja2VkICR7bmV3IERhdGUoY2hlY2suY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpfS5gO1xuICBpZiAoY2hlY2suZXJyb3IpIHJldHVybiBgJHtsYXRlc3R9JHtjaGVja2VkfSAke2NoZWNrLmVycm9yfWA7XG4gIHJldHVybiBgJHtsYXRlc3R9JHtjaGVja2VkfWA7XG59XG5cbmZ1bmN0aW9uIHVuaW5zdGFsbFJvdygpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIlVuaW5zdGFsbCBDb2RleCsrXCIsXG4gICAgXCJDb3BpZXMgdGhlIHVuaW5zdGFsbCBjb21tYW5kLiBSdW4gaXQgZnJvbSBhIHRlcm1pbmFsIGFmdGVyIHF1aXR0aW5nIENvZGV4LlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBDb21tYW5kXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcImNvZGV4cHA6Y29weS10ZXh0XCIsIFwibm9kZSB+Ly5jb2RleC1wbHVzcGx1cy9zb3VyY2UvcGFja2FnZXMvaW5zdGFsbGVyL2Rpc3QvY2xpLmpzIHVuaW5zdGFsbFwiKVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJjb3B5IHVuaW5zdGFsbCBjb21tYW5kIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVwb3J0QnVnUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiUmVwb3J0IGEgYnVnXCIsXG4gICAgXCJPcGVuIGEgR2l0SHViIGlzc3VlIHdpdGggcnVudGltZSwgaW5zdGFsbGVyLCBvciB0d2Vhay1tYW5hZ2VyIGRldGFpbHMuXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJPcGVuIElzc3VlXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IHRpdGxlID0gZW5jb2RlVVJJQ29tcG9uZW50KFwiW0J1Z106IFwiKTtcbiAgICAgIGNvbnN0IGJvZHkgPSBlbmNvZGVVUklDb21wb25lbnQoXG4gICAgICAgIFtcbiAgICAgICAgICBcIiMjIFdoYXQgaGFwcGVuZWQ/XCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIFN0ZXBzIHRvIHJlcHJvZHVjZVwiLFxuICAgICAgICAgIFwiMS4gXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIEVudmlyb25tZW50XCIsXG4gICAgICAgICAgXCItIENvZGV4KysgdmVyc2lvbjogXCIsXG4gICAgICAgICAgXCItIENvZGV4IGFwcCB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gT1M6IFwiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBMb2dzXCIsXG4gICAgICAgICAgXCJBdHRhY2ggcmVsZXZhbnQgbGluZXMgZnJvbSB0aGUgQ29kZXgrKyBsb2cgZGlyZWN0b3J5LlwiLFxuICAgICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICApO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgIFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsXG4gICAgICAgIGBodHRwczovL2dpdGh1Yi5jb20vYWd1c3RpZi9jb2RleC1wbHVzcGx1cy9pc3N1ZXMvbmV3P3RpdGxlPSR7dGl0bGV9JmJvZHk9JHtib2R5fWAsXG4gICAgICApO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBhY3Rpb25Sb3codGl0bGVUZXh0OiBzdHJpbmcsIGRlc2NyaXB0aW9uOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IHRpdGxlVGV4dDtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmRhdGFzZXQuY29kZXhwcFJvd0FjdGlvbnMgPSBcInRydWVcIjtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtzUGFnZShzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IG9wZW5CdG4gPSBvcGVuSW5QbGFjZUJ1dHRvbihcIk9wZW4gVHdlYWtzIEZvbGRlclwiLCAoKSA9PiB7XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnJldmVhbFwiLCB0d2Vha3NQYXRoKCkpO1xuICB9KTtcbiAgY29uc3QgcmVsb2FkQnRuID0gb3BlbkluUGxhY2VCdXR0b24oXCJGb3JjZSBSZWxvYWRcIiwgKCkgPT4ge1xuICAgIC8vIEZ1bGwgcGFnZSByZWZyZXNoIFx1MjAxNCBzYW1lIGFzIERldlRvb2xzIENtZC1SIC8gb3VyIENEUCBQYWdlLnJlbG9hZC5cbiAgICAvLyBNYWluIHJlLWRpc2NvdmVycyB0d2Vha3MgZmlyc3Qgc28gdGhlIG5ldyByZW5kZXJlciBjb21lcyB1cCB3aXRoIGFcbiAgICAvLyBmcmVzaCB0d2VhayBzZXQ7IHRoZW4gbG9jYXRpb24ucmVsb2FkIHJlc3RhcnRzIHRoZSByZW5kZXJlciBzbyB0aGVcbiAgICAvLyBwcmVsb2FkIHJlLWluaXRpYWxpemVzIGFnYWluc3QgaXQuXG4gICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgLmludm9rZShcImNvZGV4cHA6cmVsb2FkLXR3ZWFrc1wiKVxuICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiZm9yY2UgcmVsb2FkIChtYWluKSBmYWlsZWRcIiwgU3RyaW5nKGUpKSlcbiAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgbG9jYXRpb24ucmVsb2FkKCk7XG4gICAgICB9KTtcbiAgfSk7XG4gIC8vIERyb3AgdGhlIGRpYWdvbmFsLWFycm93IGljb24gZnJvbSB0aGUgcmVsb2FkIGJ1dHRvbiBcdTIwMTQgaXQgaW1wbGllcyBcIm9wZW5cbiAgLy8gb3V0IG9mIGFwcFwiIHdoaWNoIGRvZXNuJ3QgZml0LiBSZXBsYWNlIGl0cyB0cmFpbGluZyBzdmcgd2l0aCBhIHJlZnJlc2guXG4gIGNvbnN0IHJlbG9hZFN2ZyA9IHJlbG9hZEJ0bi5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpO1xuICBpZiAocmVsb2FkU3ZnKSB7XG4gICAgcmVsb2FkU3ZnLm91dGVySFRNTCA9XG4gICAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLTJ4c1wiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgICAgYDxwYXRoIGQ9XCJNNCAxMGE2IDYgMCAwIDEgMTAuMjQtNC4yNEwxNiA3LjVNMTYgNHYzLjVoLTMuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICAgIGA8cGF0aCBkPVwiTTE2IDEwYTYgNiAwIDAgMS0xMC4yNCA0LjI0TDQgMTIuNU00IDE2di0zLjVoMy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgICAgYDwvc3ZnPmA7XG4gIH1cblxuICBjb25zdCB0cmFpbGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRyYWlsaW5nLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgdHJhaWxpbmcuYXBwZW5kQ2hpbGQocmVsb2FkQnRuKTtcbiAgdHJhaWxpbmcuYXBwZW5kQ2hpbGQob3BlbkJ0bik7XG5cbiAgaWYgKHN0YXRlLmxpc3RlZFR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gICAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkluc3RhbGxlZCBUd2Vha3NcIiwgdHJhaWxpbmcpKTtcbiAgICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKFxuICAgICAgcm93U2ltcGxlKFxuICAgICAgICBcIk5vIHR3ZWFrcyBpbnN0YWxsZWRcIixcbiAgICAgICAgYERyb3AgYSB0d2VhayBmb2xkZXIgaW50byAke3R3ZWFrc1BhdGgoKX0gYW5kIHJlbG9hZC5gLFxuICAgICAgKSxcbiAgICApO1xuICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gICAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEdyb3VwIHJlZ2lzdGVyZWQgU2V0dGluZ3NTZWN0aW9ucyBieSB0d2VhayBpZCAocHJlZml4IHNwbGl0IGF0IFwiOlwiKS5cbiAgY29uc3Qgc2VjdGlvbnNCeVR3ZWFrID0gbmV3IE1hcDxzdHJpbmcsIFNldHRpbmdzU2VjdGlvbltdPigpO1xuICBmb3IgKGNvbnN0IHMgb2Ygc3RhdGUuc2VjdGlvbnMudmFsdWVzKCkpIHtcbiAgICBjb25zdCB0d2Vha0lkID0gcy5pZC5zcGxpdChcIjpcIilbMF07XG4gICAgaWYgKCFzZWN0aW9uc0J5VHdlYWsuaGFzKHR3ZWFrSWQpKSBzZWN0aW9uc0J5VHdlYWsuc2V0KHR3ZWFrSWQsIFtdKTtcbiAgICBzZWN0aW9uc0J5VHdlYWsuZ2V0KHR3ZWFrSWQpIS5wdXNoKHMpO1xuICB9XG5cbiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICB3cmFwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICB3cmFwLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkluc3RhbGxlZCBUd2Vha3NcIiwgdHJhaWxpbmcpKTtcblxuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgZm9yIChjb25zdCB0IG9mIHN0YXRlLmxpc3RlZFR3ZWFrcykge1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQodHdlYWtSb3codCwgc2VjdGlvbnNCeVR3ZWFrLmdldCh0Lm1hbmlmZXN0LmlkKSA/PyBbXSkpO1xuICB9XG4gIHdyYXAuYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZCh3cmFwKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtSb3codDogTGlzdGVkVHdlYWssIHNlY3Rpb25zOiBTZXR0aW5nc1NlY3Rpb25bXSk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgbSA9IHQubWFuaWZlc3Q7XG5cbiAgLy8gT3V0ZXIgY2VsbCB3cmFwcyB0aGUgaGVhZGVyIHJvdyArIChvcHRpb25hbCkgbmVzdGVkIHNlY3Rpb25zIHNvIHRoZVxuICAvLyBwYXJlbnQgY2FyZCdzIGRpdmlkZXIgc3RheXMgYmV0d2VlbiAqdHdlYWtzKiwgbm90IGJldHdlZW4gaGVhZGVyIGFuZFxuICAvLyBib2R5IG9mIHRoZSBzYW1lIHR3ZWFrLlxuICBjb25zdCBjZWxsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2VsbC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2xcIjtcbiAgaWYgKCF0LmVuYWJsZWQpIGNlbGwuc3R5bGUub3BhY2l0eSA9IFwiMC43XCI7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1zdGFydCBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEF2YXRhciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgYXZhdGFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYXZhdGFyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIG92ZXJmbG93LWhpZGRlbiB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGF2YXRhci5zdHlsZS53aWR0aCA9IFwiNTZweFwiO1xuICBhdmF0YXIuc3R5bGUuaGVpZ2h0ID0gXCI1NnB4XCI7XG4gIGF2YXRhci5zdHlsZS5iYWNrZ3JvdW5kQ29sb3IgPSBcInZhcigtLWNvbG9yLXRva2VuLWJnLWZvZywgdHJhbnNwYXJlbnQpXCI7XG4gIGlmIChtLmljb25VcmwpIHtcbiAgICBjb25zdCBpbWcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW1nXCIpO1xuICAgIGltZy5hbHQgPSBcIlwiO1xuICAgIGltZy5jbGFzc05hbWUgPSBcInNpemUtZnVsbCBvYmplY3QtY29udGFpblwiO1xuICAgIC8vIEluaXRpYWw6IHNob3cgZmFsbGJhY2sgaW5pdGlhbCBpbiBjYXNlIHRoZSBpY29uIGZhaWxzIHRvIGxvYWQuXG4gICAgY29uc3QgaW5pdGlhbCA9IChtLm5hbWU/LlswXSA/PyBcIj9cIikudG9VcHBlckNhc2UoKTtcbiAgICBjb25zdCBmYWxsYmFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIGZhbGxiYWNrLmNsYXNzTmFtZSA9IFwidGV4dC14bCBmb250LW1lZGl1bVwiO1xuICAgIGZhbGxiYWNrLnRleHRDb250ZW50ID0gaW5pdGlhbDtcbiAgICBhdmF0YXIuYXBwZW5kQ2hpbGQoZmFsbGJhY2spO1xuICAgIGltZy5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJsb2FkXCIsICgpID0+IHtcbiAgICAgIGZhbGxiYWNrLnJlbW92ZSgpO1xuICAgICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuICAgIH0pO1xuICAgIGltZy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKCkgPT4ge1xuICAgICAgaW1nLnJlbW92ZSgpO1xuICAgIH0pO1xuICAgIHZvaWQgcmVzb2x2ZUljb25VcmwobS5pY29uVXJsLCB0LmRpcikudGhlbigodXJsKSA9PiB7XG4gICAgICBpZiAodXJsKSBpbWcuc3JjID0gdXJsO1xuICAgICAgZWxzZSBpbWcucmVtb3ZlKCk7XG4gICAgfSk7XG4gICAgYXZhdGFyLmFwcGVuZENoaWxkKGltZyk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgaW5pdGlhbCA9IChtLm5hbWU/LlswXSA/PyBcIj9cIikudG9VcHBlckNhc2UoKTtcbiAgICBjb25zdCBzcGFuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgc3Bhbi5jbGFzc05hbWUgPSBcInRleHQteGwgZm9udC1tZWRpdW1cIjtcbiAgICBzcGFuLnRleHRDb250ZW50ID0gaW5pdGlhbDtcbiAgICBhdmF0YXIuYXBwZW5kQ2hpbGQoc3Bhbik7XG4gIH1cbiAgbGVmdC5hcHBlbmRDaGlsZChhdmF0YXIpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBUZXh0IHN0YWNrIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0wLjVcIjtcblxuICBjb25zdCB0aXRsZVJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlUm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5hbWUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgbmFtZS50ZXh0Q29udGVudCA9IG0ubmFtZTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQobmFtZSk7XG4gIGlmIChtLnZlcnNpb24pIHtcbiAgICBjb25zdCB2ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICB2ZXIuY2xhc3NOYW1lID1cbiAgICAgIFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSB0ZXh0LXhzIGZvbnQtbm9ybWFsIHRhYnVsYXItbnVtc1wiO1xuICAgIHZlci50ZXh0Q29udGVudCA9IGB2JHttLnZlcnNpb259YDtcbiAgICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXIpO1xuICB9XG4gIGlmICh0LnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlKSB7XG4gICAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBiYWRnZS5jbGFzc05hbWUgPVxuICAgICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQtWzExcHhdIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgYmFkZ2UudGV4dENvbnRlbnQgPSBcIlVwZGF0ZSBBdmFpbGFibGVcIjtcbiAgICB0aXRsZVJvdy5hcHBlbmRDaGlsZChiYWRnZSk7XG4gIH1cbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGVSb3cpO1xuXG4gIGlmIChtLmRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gICAgZGVzYy50ZXh0Q29udGVudCA9IG0uZGVzY3JpcHRpb247XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIH1cblxuICBjb25zdCBtZXRhID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbWV0YS5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBjb25zdCBhdXRob3JFbCA9IHJlbmRlckF1dGhvcihtLmF1dGhvcik7XG4gIGlmIChhdXRob3JFbCkgbWV0YS5hcHBlbmRDaGlsZChhdXRob3JFbCk7XG4gIGlmIChtLmdpdGh1YlJlcG8pIHtcbiAgICBpZiAobWV0YS5jaGlsZHJlbi5sZW5ndGggPiAwKSBtZXRhLmFwcGVuZENoaWxkKGRvdCgpKTtcbiAgICBjb25zdCByZXBvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICByZXBvLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIHJlcG8uY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCB0ZXh0LXRva2VuLXRleHQtbGluay1mb3JlZ3JvdW5kIGhvdmVyOnVuZGVybGluZVwiO1xuICAgIHJlcG8udGV4dENvbnRlbnQgPSBtLmdpdGh1YlJlcG87XG4gICAgcmVwby5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCBgaHR0cHM6Ly9naXRodWIuY29tLyR7bS5naXRodWJSZXBvfWApO1xuICAgIH0pO1xuICAgIG1ldGEuYXBwZW5kQ2hpbGQocmVwbyk7XG4gIH1cbiAgaWYgKG0uaG9tZXBhZ2UpIHtcbiAgICBpZiAobWV0YS5jaGlsZHJlbi5sZW5ndGggPiAwKSBtZXRhLmFwcGVuZENoaWxkKGRvdCgpKTtcbiAgICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gICAgbGluay5ocmVmID0gbS5ob21lcGFnZTtcbiAgICBsaW5rLnRhcmdldCA9IFwiX2JsYW5rXCI7XG4gICAgbGluay5yZWwgPSBcIm5vcmVmZXJyZXJcIjtcbiAgICBsaW5rLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggdGV4dC10b2tlbi10ZXh0LWxpbmstZm9yZWdyb3VuZCBob3Zlcjp1bmRlcmxpbmVcIjtcbiAgICBsaW5rLnRleHRDb250ZW50ID0gXCJIb21lcGFnZVwiO1xuICAgIG1ldGEuYXBwZW5kQ2hpbGQobGluayk7XG4gIH1cbiAgaWYgKG1ldGEuY2hpbGRyZW4ubGVuZ3RoID4gMCkgc3RhY2suYXBwZW5kQ2hpbGQobWV0YSk7XG5cbiAgLy8gVGFncyByb3cgKGlmIGFueSkgXHUyMDE0IHNtYWxsIHBpbGwgY2hpcHMgYmVsb3cgdGhlIG1ldGEgbGluZS5cbiAgaWYgKG0udGFncyAmJiBtLnRhZ3MubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHRhZ3NSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHRhZ3NSb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIgZ2FwLTEgcHQtMC41XCI7XG4gICAgZm9yIChjb25zdCB0YWcgb2YgbS50YWdzKSB7XG4gICAgICBjb25zdCBwaWxsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBwaWxsLmNsYXNzTmFtZSA9XG4gICAgICAgIFwicm91bmRlZC1mdWxsIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gICAgICBwaWxsLnRleHRDb250ZW50ID0gdGFnO1xuICAgICAgdGFnc1Jvdy5hcHBlbmRDaGlsZChwaWxsKTtcbiAgICB9XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQodGFnc1Jvdyk7XG4gIH1cblxuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBUb2dnbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcmlnaHQuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMiBwdC0wLjVcIjtcbiAgaWYgKHQudXBkYXRlPy51cGRhdGVBdmFpbGFibGUgJiYgdC51cGRhdGUucmVsZWFzZVVybCkge1xuICAgIHJpZ2h0LmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlJldmlldyBSZWxlYXNlXCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgdC51cGRhdGUhLnJlbGVhc2VVcmwpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICByaWdodC5hcHBlbmRDaGlsZChcbiAgICBzd2l0Y2hDb250cm9sKHQuZW5hYmxlZCwgYXN5bmMgKG5leHQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6c2V0LXR3ZWFrLWVuYWJsZWRcIiwgbS5pZCwgbmV4dCk7XG4gICAgICAvLyBUaGUgbWFpbiBwcm9jZXNzIGJyb2FkY2FzdHMgYSByZWxvYWQgd2hpY2ggd2lsbCByZS1mZXRjaCB0aGUgbGlzdFxuICAgICAgLy8gYW5kIHJlLXJlbmRlci4gV2UgZG9uJ3Qgb3B0aW1pc3RpY2FsbHkgdG9nZ2xlIHRvIGF2b2lkIGRyaWZ0LlxuICAgIH0pLFxuICApO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQocmlnaHQpO1xuXG4gIGNlbGwuYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICAvLyBJZiB0aGUgdHdlYWsgaXMgZW5hYmxlZCBhbmQgcmVnaXN0ZXJlZCBzZXR0aW5ncyBzZWN0aW9ucywgcmVuZGVyIHRob3NlXG4gIC8vIGJvZGllcyBhcyBuZXN0ZWQgcm93cyBiZW5lYXRoIHRoZSBoZWFkZXIgaW5zaWRlIHRoZSBzYW1lIGNlbGwuXG4gIGlmICh0LmVuYWJsZWQgJiYgc2VjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG5lc3RlZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgbmVzdGVkLmNsYXNzTmFtZSA9XG4gICAgICBcImZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIGJvcmRlci10LVswLjVweF0gYm9yZGVyLXRva2VuLWJvcmRlclwiO1xuICAgIGZvciAoY29uc3QgcyBvZiBzZWN0aW9ucykge1xuICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib2R5LmNsYXNzTmFtZSA9IFwicC0zXCI7XG4gICAgICB0cnkge1xuICAgICAgICBzLnJlbmRlcihib2R5KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgYm9keS50ZXh0Q29udGVudCA9IGBFcnJvciByZW5kZXJpbmcgdHdlYWsgc2VjdGlvbjogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gO1xuICAgICAgfVxuICAgICAgbmVzdGVkLmFwcGVuZENoaWxkKGJvZHkpO1xuICAgIH1cbiAgICBjZWxsLmFwcGVuZENoaWxkKG5lc3RlZCk7XG4gIH1cblxuICByZXR1cm4gY2VsbDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQXV0aG9yKGF1dGhvcjogVHdlYWtNYW5pZmVzdFtcImF1dGhvclwiXSk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGlmICghYXV0aG9yKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICB3cmFwLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIGdhcC0xXCI7XG4gIGlmICh0eXBlb2YgYXV0aG9yID09PSBcInN0cmluZ1wiKSB7XG4gICAgd3JhcC50ZXh0Q29udGVudCA9IGBieSAke2F1dGhvcn1gO1xuICAgIHJldHVybiB3cmFwO1xuICB9XG4gIHdyYXAuYXBwZW5kQ2hpbGQoZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoXCJieSBcIikpO1xuICBpZiAoYXV0aG9yLnVybCkge1xuICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICBhLmhyZWYgPSBhdXRob3IudXJsO1xuICAgIGEudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICBhLnJlbCA9IFwibm9yZWZlcnJlclwiO1xuICAgIGEuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCB0ZXh0LXRva2VuLXRleHQtbGluay1mb3JlZ3JvdW5kIGhvdmVyOnVuZGVybGluZVwiO1xuICAgIGEudGV4dENvbnRlbnQgPSBhdXRob3IubmFtZTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKGEpO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IHNwYW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBzcGFuLnRleHRDb250ZW50ID0gYXV0aG9yLm5hbWU7XG4gICAgd3JhcC5hcHBlbmRDaGlsZChzcGFuKTtcbiAgfVxuICByZXR1cm4gd3JhcDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGNvbXBvbmVudHMgXHUyNTAwXHUyNTAwXG5cbi8qKiBUaGUgZnVsbCBwYW5lbCBzaGVsbCAodG9vbGJhciArIHNjcm9sbCArIGhlYWRpbmcgKyBzZWN0aW9ucyB3cmFwKS4gKi9cbmZ1bmN0aW9uIHBhbmVsU2hlbGwoXG4gIHRpdGxlOiBzdHJpbmcsXG4gIHN1YnRpdGxlPzogc3RyaW5nLFxuKTogeyBvdXRlcjogSFRNTEVsZW1lbnQ7IHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQ7IHN1YnRpdGxlPzogSFRNTEVsZW1lbnQgfSB7XG4gIGNvbnN0IG91dGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3V0ZXIuY2xhc3NOYW1lID0gXCJtYWluLXN1cmZhY2UgZmxleCBoLWZ1bGwgbWluLWgtMCBmbGV4LWNvbFwiO1xuXG4gIGNvbnN0IHRvb2xiYXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b29sYmFyLmNsYXNzTmFtZSA9XG4gICAgXCJkcmFnZ2FibGUgZmxleCBpdGVtcy1jZW50ZXIgcHgtcGFuZWwgZWxlY3Ryb246aC10b29sYmFyIGV4dGVuc2lvbjpoLXRvb2xiYXItc21cIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQodG9vbGJhcik7XG5cbiAgY29uc3Qgc2Nyb2xsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2Nyb2xsLmNsYXNzTmFtZSA9IFwiZmxleC0xIG92ZXJmbG93LXktYXV0byBwLXBhbmVsXCI7XG4gIG91dGVyLmFwcGVuZENoaWxkKHNjcm9sbCk7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBpbm5lci5jbGFzc05hbWUgPVxuICAgIFwibXgtYXV0byBmbGV4IHctZnVsbCBmbGV4LWNvbCBtYXgtdy0yeGwgZWxlY3Ryb246bWluLXctW2NhbGMoMzIwcHgqdmFyKC0tY29kZXgtd2luZG93LXpvb20pKV1cIjtcbiAgc2Nyb2xsLmFwcGVuZENoaWxkKGlubmVyKTtcblxuICBjb25zdCBoZWFkZXJXcmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyV3JhcC5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMyBwYi1wYW5lbFwiO1xuICBjb25zdCBoZWFkZXJJbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlcklubmVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMS41IHBiLXBhbmVsXCI7XG4gIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkaW5nLmNsYXNzTmFtZSA9IFwiZWxlY3Ryb246aGVhZGluZy1sZyBoZWFkaW5nLWJhc2UgdHJ1bmNhdGVcIjtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlO1xuICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZChoZWFkaW5nKTtcbiAgbGV0IHN1YnRpdGxlRWxlbWVudDogSFRNTEVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gIGlmIChzdWJ0aXRsZSkge1xuICAgIGNvbnN0IHN1YiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgc3ViLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSB0ZXh0LXNtXCI7XG4gICAgc3ViLnRleHRDb250ZW50ID0gc3VidGl0bGU7XG4gICAgaGVhZGVySW5uZXIuYXBwZW5kQ2hpbGQoc3ViKTtcbiAgICBzdWJ0aXRsZUVsZW1lbnQgPSBzdWI7XG4gIH1cbiAgaGVhZGVyV3JhcC5hcHBlbmRDaGlsZChoZWFkZXJJbm5lcik7XG4gIGlubmVyLmFwcGVuZENoaWxkKGhlYWRlcldyYXApO1xuXG4gIGNvbnN0IHNlY3Rpb25zV3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHNlY3Rpb25zV3JhcC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLVt2YXIoLS1wYWRkaW5nLXBhbmVsKV1cIjtcbiAgaW5uZXIuYXBwZW5kQ2hpbGQoc2VjdGlvbnNXcmFwKTtcblxuICByZXR1cm4geyBvdXRlciwgc2VjdGlvbnNXcmFwLCBzdWJ0aXRsZTogc3VidGl0bGVFbGVtZW50IH07XG59XG5cbmZ1bmN0aW9uIHNlY3Rpb25UaXRsZSh0ZXh0OiBzdHJpbmcsIHRyYWlsaW5nPzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC10b29sYmFyIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTIgcHgtMCBweS0wXCI7XG4gIGNvbnN0IHRpdGxlSW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZUlubmVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdC5jbGFzc05hbWUgPSBcInRleHQtYmFzZSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdGl0bGVJbm5lci5hcHBlbmRDaGlsZCh0KTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGVJbm5lcik7XG4gIGlmICh0cmFpbGluZykge1xuICAgIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByaWdodC5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gICAgcmlnaHQuYXBwZW5kQ2hpbGQodHJhaWxpbmcpO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHJpZ2h0KTtcbiAgfVxuICByZXR1cm4gdGl0bGVSb3c7XG59XG5cbi8qKlxuICogQ29kZXgncyBcIk9wZW4gY29uZmlnLnRvbWxcIi1zdHlsZSB0cmFpbGluZyBidXR0b246IGdob3N0IGJvcmRlciwgbXV0ZWRcbiAqIGxhYmVsLCB0b3AtcmlnaHQgZGlhZ29uYWwgYXJyb3cgaWNvbi4gTWFya3VwIG1pcnJvcnMgQ29uZmlndXJhdGlvbiBwYW5lbC5cbiAqL1xuZnVuY3Rpb24gb3BlbkluUGxhY2VCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBib3JkZXIgd2hpdGVzcGFjZS1ub3dyYXAgZm9jdXM6b3V0bGluZS1ub25lIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwIHJvdW5kZWQtbGcgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRhdGEtW3N0YXRlPW9wZW5dOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBib3JkZXItdHJhbnNwYXJlbnQgaC10b2tlbi1idXR0b24tY29tcG9zZXIgcHgtMiBweS0wIHRleHQtYmFzZSBsZWFkaW5nLVsxOHB4XVwiO1xuICBidG4uaW5uZXJIVE1MID1cbiAgICBgJHtsYWJlbH1gICtcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLTJ4c1wiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE0LjMzNDkgMTMuMzMwMVY2LjYwNjQ1TDUuNDcwNjUgMTUuNDcwN0M1LjIxMDk1IDE1LjczMDQgNC43ODg5NSAxNS43MzA0IDQuNTI5MjUgMTUuNDcwN0M0LjI2OTU1IDE1LjIxMSA0LjI2OTU1IDE0Ljc4OSA0LjUyOTI1IDE0LjUyOTNMMTMuMzkzNSA1LjY2NTA0SDYuNjYwMTFDNi4yOTI4NCA1LjY2NTA0IDUuOTk1MDcgNS4zNjcyNyA1Ljk5NTA3IDVDNS45OTUwNyA0LjYzMjczIDYuMjkyODQgNC4zMzQ5NiA2LjY2MDExIDQuMzM0OTZIMTQuOTk5OUwxNS4xMzM3IDQuMzQ4NjNDMTUuNDM2OSA0LjQxMDU3IDE1LjY2NSA0LjY3ODU3IDE1LjY2NSA1VjEzLjMzMDFDMTUuNjY0OSAxMy42OTczIDE1LjM2NzIgMTMuOTk1MSAxNC45OTk5IDEzLjk5NTFDMTQuNjMyNyAxMy45OTUxIDE0LjMzNSAxMy42OTczIDE0LjMzNDkgMTMuMzMwMVpcIiBmaWxsPVwiY3VycmVudENvbG9yXCI+PC9wYXRoPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gY29tcGFjdEJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGlubGluZS1mbGV4IGgtOCBpdGVtcy1jZW50ZXIgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcm91bmRlZENhcmQoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciByb3VuZGVkLWxnIGJvcmRlclwiO1xuICBjYXJkLnNldEF0dHJpYnV0ZShcbiAgICBcInN0eWxlXCIsXG4gICAgXCJiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1jb2xvci1iYWNrZ3JvdW5kLXBhbmVsLCB2YXIoLS1jb2xvci10b2tlbi1iZy1mb2cpKTtcIixcbiAgKTtcbiAgcmV0dXJuIGNhcmQ7XG59XG5cbmZ1bmN0aW9uIHJvd1NpbXBsZSh0aXRsZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTNcIjtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBpZiAodGl0bGUpIHtcbiAgICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICB0LmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgdC50ZXh0Q29udGVudCA9IHRpdGxlO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKHQpO1xuICB9XG4gIGlmIChkZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGQuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICAgIGQudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkKTtcbiAgfVxuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICByZXR1cm4gcm93O1xufVxuXG4vKipcbiAqIENvZGV4LXN0eWxlZCB0b2dnbGUgc3dpdGNoLiBNYXJrdXAgbWlycm9ycyB0aGUgR2VuZXJhbCA+IFBlcm1pc3Npb25zIHJvd1xuICogc3dpdGNoIHdlIGNhcHR1cmVkOiBvdXRlciBidXR0b24gKHJvbGU9c3dpdGNoKSwgaW5uZXIgcGlsbCwgc2xpZGluZyBrbm9iLlxuICovXG5mdW5jdGlvbiBzd2l0Y2hDb250cm9sKFxuICBpbml0aWFsOiBib29sZWFuLFxuICBvbkNoYW5nZTogKG5leHQ6IGJvb2xlYW4pID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+LFxuKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3dpdGNoXCIpO1xuXG4gIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29uc3Qga25vYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBrbm9iLmNsYXNzTmFtZSA9XG4gICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci1bY29sb3I6dmFyKC0tZ3JheS0wKV0gYmctW2NvbG9yOnZhcigtLWdyYXktMCldIHNoYWRvdy1zbSB0cmFuc2l0aW9uLXRyYW5zZm9ybSBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC00IHctNFwiO1xuICBwaWxsLmFwcGVuZENoaWxkKGtub2IpO1xuXG4gIGNvbnN0IGFwcGx5ID0gKG9uOiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiLCBTdHJpbmcob24pKTtcbiAgICBidG4uZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGJ0bi5jbGFzc05hbWUgPVxuICAgICAgXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyIGZvY3VzLXZpc2libGU6cm91bmRlZC1mdWxsIGN1cnNvci1pbnRlcmFjdGlvblwiO1xuICAgIHBpbGwuY2xhc3NOYW1lID0gYHJlbGF0aXZlIGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgdHJhbnNpdGlvbi1jb2xvcnMgZHVyYXRpb24tMjAwIGVhc2Utb3V0IGgtNSB3LTggJHtcbiAgICAgIG9uID8gXCJiZy10b2tlbi1jaGFydHMtYmx1ZVwiIDogXCJiZy10b2tlbi1mb3JlZ3JvdW5kLzIwXCJcbiAgICB9YDtcbiAgICBwaWxsLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLnN0eWxlLnRyYW5zZm9ybSA9IG9uID8gXCJ0cmFuc2xhdGVYKDE0cHgpXCIgOiBcInRyYW5zbGF0ZVgoMnB4KVwiO1xuICB9O1xuICBhcHBseShpbml0aWFsKTtcblxuICBidG4uYXBwZW5kQ2hpbGQocGlsbCk7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBjb25zdCBuZXh0ID0gYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiKSAhPT0gXCJ0cnVlXCI7XG4gICAgYXBwbHkobmV4dCk7XG4gICAgYnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgb25DaGFuZ2UobmV4dCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIGRvdCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgcy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiO1xuICBzLnRleHRDb250ZW50ID0gXCJcdTAwQjdcIjtcbiAgcmV0dXJuIHM7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBpY29ucyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY29uZmlnSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBTbGlkZXJzIC8gc2V0dGluZ3MgZ2x5cGguIDIweDIwIGN1cnJlbnRDb2xvci5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0zIDVoOU0xNSA1aDJNMyAxMGgyTTggMTBoOU0zIDE1aDExTTE3IDE1aDBcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiMTNcIiBjeT1cIjVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjZcIiBjeT1cIjEwXCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxNVwiIGN5PVwiMTVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiB0d2Vha3NJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNwYXJrbGVzIC8gXCIrK1wiIGdseXBoIGZvciB0d2Vha3MuXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTAgMi41IEwxMS40IDguNiBMMTcuNSAxMCBMMTEuNCAxMS40IEwxMCAxNy41IEw4LjYgMTEuNCBMMi41IDEwIEw4LjYgOC42IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE1LjUgMyBMMTYgNSBMMTggNS41IEwxNiA2IEwxNS41IDggTDE1IDYgTDEzIDUuNSBMMTUgNSBaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiIG9wYWNpdHk9XCIwLjdcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gZGVmYXVsdFBhZ2VJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIERvY3VtZW50L3BhZ2UgZ2x5cGggZm9yIHR3ZWFrLXJlZ2lzdGVyZWQgcGFnZXMgd2l0aG91dCB0aGVpciBvd24gaWNvbi5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk01IDNoN2wzIDN2MTFhMSAxIDAgMCAxLTEgMUg1YTEgMSAwIDAgMS0xLTFWNGExIDEgMCAwIDEgMS0xWlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTEyIDN2M2ExIDEgMCAwIDAgMSAxaDJcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk03IDExaDZNNyAxNGg0XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlSWNvblVybChcbiAgdXJsOiBzdHJpbmcsXG4gIHR3ZWFrRGlyOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKC9eKGh0dHBzPzp8ZGF0YTopLy50ZXN0KHVybCkpIHJldHVybiB1cmw7XG4gIC8vIFJlbGF0aXZlIHBhdGggXHUyMTkyIGFzayBtYWluIHRvIHJlYWQgdGhlIGZpbGUgYW5kIHJldHVybiBhIGRhdGE6IFVSTC5cbiAgLy8gUmVuZGVyZXIgaXMgc2FuZGJveGVkIHNvIGZpbGU6Ly8gd29uJ3QgbG9hZCBkaXJlY3RseS5cbiAgY29uc3QgcmVsID0gdXJsLnN0YXJ0c1dpdGgoXCIuL1wiKSA/IHVybC5zbGljZSgyKSA6IHVybDtcbiAgdHJ5IHtcbiAgICByZXR1cm4gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgIFwiY29kZXhwcDpyZWFkLXR3ZWFrLWFzc2V0XCIsXG4gICAgICB0d2Vha0RpcixcbiAgICAgIHJlbCxcbiAgICApKSBhcyBzdHJpbmc7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwbG9nKFwiaWNvbiBsb2FkIGZhaWxlZFwiLCB7IHVybCwgdHdlYWtEaXIsIGVycjogU3RyaW5nKGUpIH0pO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBET00gaGV1cmlzdGljcyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIC8vIEFuY2hvciBzdHJhdGVneSBmaXJzdCAod291bGQgYmUgaWRlYWwgaWYgQ29kZXggc3dpdGNoZXMgdG8gPGE+KS5cbiAgY29uc3QgbGlua3MgPSBBcnJheS5mcm9tKFxuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEFuY2hvckVsZW1lbnQ+KFwiYVtocmVmKj0nL3NldHRpbmdzLyddXCIpLFxuICApO1xuICBpZiAobGlua3MubGVuZ3RoID49IDIpIHtcbiAgICBsZXQgbm9kZTogSFRNTEVsZW1lbnQgfCBudWxsID0gbGlua3NbMF0ucGFyZW50RWxlbWVudDtcbiAgICB3aGlsZSAobm9kZSkge1xuICAgICAgY29uc3QgaW5zaWRlID0gbm9kZS5xdWVyeVNlbGVjdG9yQWxsKFwiYVtocmVmKj0nL3NldHRpbmdzLyddXCIpO1xuICAgICAgaWYgKGluc2lkZS5sZW5ndGggPj0gTWF0aC5tYXgoMiwgbGlua3MubGVuZ3RoIC0gMSkpIHJldHVybiBub2RlO1xuICAgICAgbm9kZSA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgICB9XG4gIH1cblxuICAvLyBUZXh0LWNvbnRlbnQgbWF0Y2ggYWdhaW5zdCBDb2RleCdzIGtub3duIHNpZGViYXIgbGFiZWxzLlxuICBjb25zdCBLTk9XTiA9IFtcbiAgICBcIkdlbmVyYWxcIixcbiAgICBcIkFwcGVhcmFuY2VcIixcbiAgICBcIkNvbmZpZ3VyYXRpb25cIixcbiAgICBcIlBlcnNvbmFsaXphdGlvblwiLFxuICAgIFwiTUNQIHNlcnZlcnNcIixcbiAgICBcIk1DUCBTZXJ2ZXJzXCIsXG4gICAgXCJHaXRcIixcbiAgICBcIkVudmlyb25tZW50c1wiLFxuICBdO1xuICBjb25zdCBtYXRjaGVzOiBIVE1MRWxlbWVudFtdID0gW107XG4gIGNvbnN0IGFsbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFxuICAgIFwiYnV0dG9uLCBhLCBbcm9sZT0nYnV0dG9uJ10sIGxpLCBkaXZcIixcbiAgKTtcbiAgZm9yIChjb25zdCBlbCBvZiBBcnJheS5mcm9tKGFsbCkpIHtcbiAgICBjb25zdCB0ID0gKGVsLnRleHRDb250ZW50ID8/IFwiXCIpLnRyaW0oKTtcbiAgICBpZiAodC5sZW5ndGggPiAzMCkgY29udGludWU7XG4gICAgaWYgKEtOT1dOLnNvbWUoKGspID0+IHQgPT09IGspKSBtYXRjaGVzLnB1c2goZWwpO1xuICAgIGlmIChtYXRjaGVzLmxlbmd0aCA+IDUwKSBicmVhaztcbiAgfVxuICBpZiAobWF0Y2hlcy5sZW5ndGggPj0gMikge1xuICAgIGxldCBub2RlOiBIVE1MRWxlbWVudCB8IG51bGwgPSBtYXRjaGVzWzBdLnBhcmVudEVsZW1lbnQ7XG4gICAgd2hpbGUgKG5vZGUpIHtcbiAgICAgIGxldCBjb3VudCA9IDA7XG4gICAgICBmb3IgKGNvbnN0IG0gb2YgbWF0Y2hlcykgaWYgKG5vZGUuY29udGFpbnMobSkpIGNvdW50Kys7XG4gICAgICBpZiAoY291bnQgPj0gTWF0aC5taW4oMywgbWF0Y2hlcy5sZW5ndGgpKSByZXR1cm4gbm9kZTtcbiAgICAgIG5vZGUgPSBub2RlLnBhcmVudEVsZW1lbnQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBmaW5kQ29udGVudEFyZWEoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICBpZiAoIXNpZGViYXIpIHJldHVybiBudWxsO1xuICBsZXQgcGFyZW50ID0gc2lkZWJhci5wYXJlbnRFbGVtZW50O1xuICB3aGlsZSAocGFyZW50KSB7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKHBhcmVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgaWYgKGNoaWxkID09PSBzaWRlYmFyIHx8IGNoaWxkLmNvbnRhaW5zKHNpZGViYXIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHIgPSBjaGlsZC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIGlmIChyLndpZHRoID4gMzAwICYmIHIuaGVpZ2h0ID4gMjAwKSByZXR1cm4gY2hpbGQ7XG4gICAgfVxuICAgIHBhcmVudCA9IHBhcmVudC5wYXJlbnRFbGVtZW50O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBtYXliZUR1bXBEb20oKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICAgIGlmIChzaWRlYmFyICYmICFzdGF0ZS5zaWRlYmFyRHVtcGVkKSB7XG4gICAgICBzdGF0ZS5zaWRlYmFyRHVtcGVkID0gdHJ1ZTtcbiAgICAgIGNvbnN0IHNiUm9vdCA9IHNpZGViYXIucGFyZW50RWxlbWVudCA/PyBzaWRlYmFyO1xuICAgICAgcGxvZyhgY29kZXggc2lkZWJhciBIVE1MYCwgc2JSb290Lm91dGVySFRNTC5zbGljZSgwLCAzMjAwMCkpO1xuICAgIH1cbiAgICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gICAgaWYgKCFjb250ZW50KSB7XG4gICAgICBpZiAoc3RhdGUuZmluZ2VycHJpbnQgIT09IGxvY2F0aW9uLmhyZWYpIHtcbiAgICAgICAgc3RhdGUuZmluZ2VycHJpbnQgPSBsb2NhdGlvbi5ocmVmO1xuICAgICAgICBwbG9nKFwiZG9tIHByb2JlIChubyBjb250ZW50KVwiLCB7XG4gICAgICAgICAgdXJsOiBsb2NhdGlvbi5ocmVmLFxuICAgICAgICAgIHNpZGViYXI6IHNpZGViYXIgPyBkZXNjcmliZShzaWRlYmFyKSA6IG51bGwsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgcGFuZWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHAgPT09IFwidHdlYWtzLXBhbmVsXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNoaWxkLnN0eWxlLmRpc3BsYXkgPT09IFwibm9uZVwiKSBjb250aW51ZTtcbiAgICAgIHBhbmVsID0gY2hpbGQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY29uc3QgYWN0aXZlTmF2ID0gc2lkZWJhclxuICAgICAgPyBBcnJheS5mcm9tKHNpZGViYXIucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJidXR0b24sIGFcIikpLmZpbmQoXG4gICAgICAgICAgKGIpID0+XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIgfHxcbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiZGF0YS1hY3RpdmVcIikgPT09IFwidHJ1ZVwiIHx8XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImFyaWEtc2VsZWN0ZWRcIikgPT09IFwidHJ1ZVwiIHx8XG4gICAgICAgICAgICBiLmNsYXNzTGlzdC5jb250YWlucyhcImFjdGl2ZVwiKSxcbiAgICAgICAgKVxuICAgICAgOiBudWxsO1xuICAgIGNvbnN0IGhlYWRpbmcgPSBwYW5lbD8ucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXG4gICAgICBcImgxLCBoMiwgaDMsIFtjbGFzcyo9J2hlYWRpbmcnXVwiLFxuICAgICk7XG4gICAgY29uc3QgZmluZ2VycHJpbnQgPSBgJHthY3RpdmVOYXY/LnRleHRDb250ZW50ID8/IFwiXCJ9fCR7aGVhZGluZz8udGV4dENvbnRlbnQgPz8gXCJcIn18JHtwYW5lbD8uY2hpbGRyZW4ubGVuZ3RoID8/IDB9YDtcbiAgICBpZiAoc3RhdGUuZmluZ2VycHJpbnQgPT09IGZpbmdlcnByaW50KSByZXR1cm47XG4gICAgc3RhdGUuZmluZ2VycHJpbnQgPSBmaW5nZXJwcmludDtcbiAgICBwbG9nKFwiZG9tIHByb2JlXCIsIHtcbiAgICAgIHVybDogbG9jYXRpb24uaHJlZixcbiAgICAgIGFjdGl2ZU5hdjogYWN0aXZlTmF2Py50ZXh0Q29udGVudD8udHJpbSgpID8/IG51bGwsXG4gICAgICBoZWFkaW5nOiBoZWFkaW5nPy50ZXh0Q29udGVudD8udHJpbSgpID8/IG51bGwsXG4gICAgICBjb250ZW50OiBkZXNjcmliZShjb250ZW50KSxcbiAgICB9KTtcbiAgICBpZiAocGFuZWwpIHtcbiAgICAgIGNvbnN0IGh0bWwgPSBwYW5lbC5vdXRlckhUTUw7XG4gICAgICBwbG9nKFxuICAgICAgICBgY29kZXggcGFuZWwgSFRNTCAoJHthY3RpdmVOYXY/LnRleHRDb250ZW50Py50cmltKCkgPz8gXCI/XCJ9KWAsXG4gICAgICAgIGh0bWwuc2xpY2UoMCwgMzIwMDApLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwbG9nKFwiZG9tIHByb2JlIGZhaWxlZFwiLCBTdHJpbmcoZSkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGRlc2NyaWJlKGVsOiBIVE1MRWxlbWVudCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHtcbiAgICB0YWc6IGVsLnRhZ05hbWUsXG4gICAgY2xzOiBlbC5jbGFzc05hbWUuc2xpY2UoMCwgMTIwKSxcbiAgICBpZDogZWwuaWQgfHwgdW5kZWZpbmVkLFxuICAgIGNoaWxkcmVuOiBlbC5jaGlsZHJlbi5sZW5ndGgsXG4gICAgcmVjdDogKCgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIHJldHVybiB7IHc6IE1hdGgucm91bmQoci53aWR0aCksIGg6IE1hdGgucm91bmQoci5oZWlnaHQpIH07XG4gICAgfSkoKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtzUGF0aCgpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fY29kZXhwcF90d2Vha3NfZGlyX18/OiBzdHJpbmcgfSkuX19jb2RleHBwX3R3ZWFrc19kaXJfXyA/P1xuICAgIFwiPHVzZXIgZGlyPi90d2Vha3NcIlxuICApO1xufVxuIiwgIi8qKlxuICogUmVuZGVyZXItc2lkZSB0d2VhayBob3N0LiBXZTpcbiAqICAgMS4gQXNrIG1haW4gZm9yIHRoZSB0d2VhayBsaXN0ICh3aXRoIHJlc29sdmVkIGVudHJ5IHBhdGgpLlxuICogICAyLiBGb3IgZWFjaCByZW5kZXJlci1zY29wZWQgKG9yIFwiYm90aFwiKSB0d2VhaywgZmV0Y2ggaXRzIHNvdXJjZSB2aWEgSVBDXG4gKiAgICAgIGFuZCBleGVjdXRlIGl0IGFzIGEgQ29tbW9uSlMtc2hhcGVkIGZ1bmN0aW9uLlxuICogICAzLiBQcm92aWRlIGl0IHRoZSByZW5kZXJlciBoYWxmIG9mIHRoZSBBUEkuXG4gKlxuICogQ29kZXggcnVucyB0aGUgcmVuZGVyZXIgd2l0aCBzYW5kYm94OiB0cnVlLCBzbyBOb2RlJ3MgYHJlcXVpcmUoKWAgaXNcbiAqIHJlc3RyaWN0ZWQgdG8gYSB0aW55IHdoaXRlbGlzdCAoZWxlY3Ryb24gKyBhIGZldyBwb2x5ZmlsbHMpLiBUaGF0IG1lYW5zIHdlXG4gKiBjYW5ub3QgYHJlcXVpcmUoKWAgYXJiaXRyYXJ5IHR3ZWFrIGZpbGVzIGZyb20gZGlzay4gSW5zdGVhZCB3ZSBwdWxsIHRoZVxuICogc291cmNlIHN0cmluZyBmcm9tIG1haW4gYW5kIGV2YWx1YXRlIGl0IHdpdGggYG5ldyBGdW5jdGlvbmAgaW5zaWRlIHRoZVxuICogcHJlbG9hZCBjb250ZXh0LiBUd2VhayBhdXRob3JzIHdobyBuZWVkIG5wbSBkZXBzIG11c3QgYnVuZGxlIHRoZW0gaW4uXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiwgcmVnaXN0ZXJQYWdlLCBjbGVhclNlY3Rpb25zLCBzZXRMaXN0ZWRUd2Vha3MgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgZmliZXJGb3JOb2RlIH0gZnJvbSBcIi4vcmVhY3QtaG9va1wiO1xuaW1wb3J0IHR5cGUge1xuICBUd2Vha01hbmlmZXN0LFxuICBUd2Vha0FwaSxcbiAgUmVhY3RGaWJlck5vZGUsXG4gIFR3ZWFrLFxufSBmcm9tIFwiQGNvZGV4LXBsdXNwbHVzL3Nka1wiO1xuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICB1cGRhdGU6IHtcbiAgICBjaGVja2VkQXQ6IHN0cmluZztcbiAgICByZXBvOiBzdHJpbmc7XG4gICAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgICBsYXRlc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICAgIGxhdGVzdFRhZzogc3RyaW5nIHwgbnVsbDtcbiAgICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICAgIHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgfSB8IG51bGw7XG59XG5cbmludGVyZmFjZSBVc2VyUGF0aHMge1xuICB1c2VyUm9vdDogc3RyaW5nO1xuICBydW50aW1lRGlyOiBzdHJpbmc7XG4gIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICBsb2dEaXI6IHN0cmluZztcbn1cblxuY29uc3QgbG9hZGVkID0gbmV3IE1hcDxzdHJpbmcsIHsgc3RvcD86ICgpID0+IHZvaWQgfT4oKTtcbmxldCBjYWNoZWRQYXRoczogVXNlclBhdGhzIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydFR3ZWFrSG9zdCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHdlYWtzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6bGlzdC10d2Vha3NcIikpIGFzIExpc3RlZFR3ZWFrW107XG4gIGNvbnN0IHBhdGhzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dXNlci1wYXRoc1wiKSkgYXMgVXNlclBhdGhzO1xuICBjYWNoZWRQYXRocyA9IHBhdGhzO1xuICAvLyBQdXNoIHRoZSBsaXN0IHRvIHRoZSBzZXR0aW5ncyBpbmplY3RvciBzbyB0aGUgVHdlYWtzIHBhZ2UgY2FuIHJlbmRlclxuICAvLyBjYXJkcyBldmVuIGJlZm9yZSBhbnkgdHdlYWsncyBzdGFydCgpIHJ1bnMgKGFuZCBmb3IgZGlzYWJsZWQgdHdlYWtzXG4gIC8vIHRoYXQgd2UgbmV2ZXIgbG9hZCkuXG4gIHNldExpc3RlZFR3ZWFrcyh0d2Vha3MpO1xuICAvLyBTdGFzaCBmb3IgdGhlIHNldHRpbmdzIGluamVjdG9yJ3MgZW1wdHktc3RhdGUgbWVzc2FnZS5cbiAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19jb2RleHBwX3R3ZWFrc19kaXJfXz86IHN0cmluZyB9KS5fX2NvZGV4cHBfdHdlYWtzX2Rpcl9fID1cbiAgICBwYXRocy50d2Vha3NEaXI7XG5cbiAgZm9yIChjb25zdCB0IG9mIHR3ZWFrcykge1xuICAgIGlmICh0Lm1hbmlmZXN0LnNjb3BlID09PSBcIm1haW5cIikgY29udGludWU7XG4gICAgaWYgKCF0LmVudHJ5RXhpc3RzKSBjb250aW51ZTtcbiAgICBpZiAoIXQuZW5hYmxlZCkgY29udGludWU7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGxvYWRUd2Vhayh0LCBwYXRocyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihcIltjb2RleC1wbHVzcGx1c10gdHdlYWsgbG9hZCBmYWlsZWQ6XCIsIHQubWFuaWZlc3QuaWQsIGUpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnNvbGUuaW5mbyhcbiAgICBgW2NvZGV4LXBsdXNwbHVzXSByZW5kZXJlciBob3N0IGxvYWRlZCAke2xvYWRlZC5zaXplfSB0d2VhayhzKTpgLFxuICAgIFsuLi5sb2FkZWQua2V5cygpXS5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIixcbiAgKTtcbiAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICBcImNvZGV4cHA6cHJlbG9hZC1sb2dcIixcbiAgICBcImluZm9cIixcbiAgICBgcmVuZGVyZXIgaG9zdCBsb2FkZWQgJHtsb2FkZWQuc2l6ZX0gdHdlYWsocyk6ICR7Wy4uLmxvYWRlZC5rZXlzKCldLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwifWAsXG4gICk7XG59XG5cbi8qKlxuICogU3RvcCBldmVyeSByZW5kZXJlci1zY29wZSB0d2VhayBzbyBhIHN1YnNlcXVlbnQgYHN0YXJ0VHdlYWtIb3N0KClgIHdpbGxcbiAqIHJlLWV2YWx1YXRlIGZyZXNoIHNvdXJjZS4gTW9kdWxlIGNhY2hlIGlzbid0IHJlbGV2YW50IHNpbmNlIHdlIGV2YWxcbiAqIHNvdXJjZSBzdHJpbmdzIGRpcmVjdGx5IFx1MjAxNCBlYWNoIGxvYWQgY3JlYXRlcyBhIGZyZXNoIHNjb3BlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGVhcmRvd25Ud2Vha0hvc3QoKTogdm9pZCB7XG4gIGZvciAoY29uc3QgW2lkLCB0XSBvZiBsb2FkZWQpIHtcbiAgICB0cnkge1xuICAgICAgdC5zdG9wPy4oKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oXCJbY29kZXgtcGx1c3BsdXNdIHR3ZWFrIHN0b3AgZmFpbGVkOlwiLCBpZCwgZSk7XG4gICAgfVxuICB9XG4gIGxvYWRlZC5jbGVhcigpO1xuICBjbGVhclNlY3Rpb25zKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRUd2Vhayh0OiBMaXN0ZWRUd2VhaywgcGF0aHM6IFVzZXJQYXRocyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzb3VyY2UgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgIFwiY29kZXhwcDpyZWFkLXR3ZWFrLXNvdXJjZVwiLFxuICAgIHQuZW50cnksXG4gICkpIGFzIHN0cmluZztcblxuICAvLyBFdmFsdWF0ZSBhcyBDSlMtc2hhcGVkOiBwcm92aWRlIG1vZHVsZS9leHBvcnRzL2FwaS4gVHdlYWsgY29kZSBtYXkgdXNlXG4gIC8vIGBtb2R1bGUuZXhwb3J0cyA9IHsgc3RhcnQsIHN0b3AgfWAgb3IgYGV4cG9ydHMuc3RhcnQgPSAuLi5gIG9yIHB1cmUgRVNNXG4gIC8vIGRlZmF1bHQgZXhwb3J0IHNoYXBlICh3ZSBhY2NlcHQgYm90aCkuXG4gIGNvbnN0IG1vZHVsZSA9IHsgZXhwb3J0czoge30gYXMgeyBkZWZhdWx0PzogVHdlYWsgfSAmIFR3ZWFrIH07XG4gIGNvbnN0IGV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cztcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1pbXBsaWVkLWV2YWwsIG5vLW5ldy1mdW5jXG4gIGNvbnN0IGZuID0gbmV3IEZ1bmN0aW9uKFxuICAgIFwibW9kdWxlXCIsXG4gICAgXCJleHBvcnRzXCIsXG4gICAgXCJjb25zb2xlXCIsXG4gICAgYCR7c291cmNlfVxcbi8vIyBzb3VyY2VVUkw9Y29kZXhwcC10d2VhazovLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQubWFuaWZlc3QuaWQpfS8ke2VuY29kZVVSSUNvbXBvbmVudCh0LmVudHJ5KX1gLFxuICApO1xuICBmbihtb2R1bGUsIGV4cG9ydHMsIGNvbnNvbGUpO1xuICBjb25zdCBtb2QgPSBtb2R1bGUuZXhwb3J0cyBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWs7XG4gIGNvbnN0IHR3ZWFrOiBUd2VhayA9IChtb2QgYXMgeyBkZWZhdWx0PzogVHdlYWsgfSkuZGVmYXVsdCA/PyAobW9kIGFzIFR3ZWFrKTtcbiAgaWYgKHR5cGVvZiB0d2Vhaz8uc3RhcnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgdHdlYWsgJHt0Lm1hbmlmZXN0LmlkfSBoYXMgbm8gc3RhcnQoKWApO1xuICB9XG4gIGNvbnN0IGFwaSA9IG1ha2VSZW5kZXJlckFwaSh0Lm1hbmlmZXN0LCBwYXRocyk7XG4gIGF3YWl0IHR3ZWFrLnN0YXJ0KGFwaSk7XG4gIGxvYWRlZC5zZXQodC5tYW5pZmVzdC5pZCwgeyBzdG9wOiB0d2Vhay5zdG9wPy5iaW5kKHR3ZWFrKSB9KTtcbn1cblxuZnVuY3Rpb24gbWFrZVJlbmRlcmVyQXBpKG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LCBwYXRoczogVXNlclBhdGhzKTogVHdlYWtBcGkge1xuICBjb25zdCBpZCA9IG1hbmlmZXN0LmlkO1xuICBjb25zdCBsb2cgPSAobGV2ZWw6IFwiZGVidWdcIiB8IFwiaW5mb1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIC4uLmE6IHVua25vd25bXSkgPT4ge1xuICAgIGNvbnN0IGNvbnNvbGVGbiA9XG4gICAgICBsZXZlbCA9PT0gXCJkZWJ1Z1wiID8gY29uc29sZS5kZWJ1Z1xuICAgICAgOiBsZXZlbCA9PT0gXCJ3YXJuXCIgPyBjb25zb2xlLndhcm5cbiAgICAgIDogbGV2ZWwgPT09IFwiZXJyb3JcIiA/IGNvbnNvbGUuZXJyb3JcbiAgICAgIDogY29uc29sZS5sb2c7XG4gICAgY29uc29sZUZuKGBbY29kZXgtcGx1c3BsdXNdWyR7aWR9XWAsIC4uLmEpO1xuICAgIC8vIEFsc28gbWlycm9yIHRvIG1haW4ncyBsb2cgZmlsZSBzbyB3ZSBjYW4gZGlhZ25vc2UgdHdlYWsgYmVoYXZpb3JcbiAgICAvLyB3aXRob3V0IGF0dGFjaGluZyBEZXZUb29scy4gU3RyaW5naWZ5IGVhY2ggYXJnIGRlZmVuc2l2ZWx5LlxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJ0cyA9IGEubWFwKCh2KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHY7XG4gICAgICAgIGlmICh2IGluc3RhbmNlb2YgRXJyb3IpIHJldHVybiBgJHt2Lm5hbWV9OiAke3YubWVzc2FnZX1gO1xuICAgICAgICB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkodik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKHYpOyB9XG4gICAgICB9KTtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgICAgICBsZXZlbCxcbiAgICAgICAgYFt0d2VhayAke2lkfV0gJHtwYXJ0cy5qb2luKFwiIFwiKX1gLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHN3YWxsb3cgXHUyMDE0IG5ldmVyIGxldCBsb2dnaW5nIGJyZWFrIGEgdHdlYWsgKi9cbiAgICB9XG4gIH07XG5cbiAgY29uc3QgZ2l0ID0gbWFuaWZlc3QucGVybWlzc2lvbnM/LmluY2x1ZGVzKFwiZ2l0Lm1ldGFkYXRhXCIpID8gcmVuZGVyZXJHaXQoKSA6IHVuZGVmaW5lZDtcblxuICByZXR1cm4ge1xuICAgIG1hbmlmZXN0LFxuICAgIHByb2Nlc3M6IFwicmVuZGVyZXJcIixcbiAgICBsb2c6IHtcbiAgICAgIGRlYnVnOiAoLi4uYSkgPT4gbG9nKFwiZGVidWdcIiwgLi4uYSksXG4gICAgICBpbmZvOiAoLi4uYSkgPT4gbG9nKFwiaW5mb1wiLCAuLi5hKSxcbiAgICAgIHdhcm46ICguLi5hKSA9PiBsb2coXCJ3YXJuXCIsIC4uLmEpLFxuICAgICAgZXJyb3I6ICguLi5hKSA9PiBsb2coXCJlcnJvclwiLCAuLi5hKSxcbiAgICB9LFxuICAgIHN0b3JhZ2U6IHJlbmRlcmVyU3RvcmFnZShpZCksXG4gICAgc2V0dGluZ3M6IHtcbiAgICAgIHJlZ2lzdGVyOiAocykgPT4gcmVnaXN0ZXJTZWN0aW9uKHsgLi4ucywgaWQ6IGAke2lkfToke3MuaWR9YCB9KSxcbiAgICAgIHJlZ2lzdGVyUGFnZTogKHApID0+XG4gICAgICAgIHJlZ2lzdGVyUGFnZShpZCwgbWFuaWZlc3QsIHsgLi4ucCwgaWQ6IGAke2lkfToke3AuaWR9YCB9KSxcbiAgICB9LFxuICAgIHJlYWN0OiB7XG4gICAgICBnZXRGaWJlcjogKG4pID0+IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGwsXG4gICAgICBmaW5kT3duZXJCeU5hbWU6IChuLCBuYW1lKSA9PiB7XG4gICAgICAgIGxldCBmID0gZmliZXJGb3JOb2RlKG4pIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbDtcbiAgICAgICAgd2hpbGUgKGYpIHtcbiAgICAgICAgICBjb25zdCB0ID0gZi50eXBlIGFzIHsgZGlzcGxheU5hbWU/OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB8IG51bGw7XG4gICAgICAgICAgaWYgKHQgJiYgKHQuZGlzcGxheU5hbWUgPT09IG5hbWUgfHwgdC5uYW1lID09PSBuYW1lKSkgcmV0dXJuIGY7XG4gICAgICAgICAgZiA9IGYucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfSxcbiAgICAgIHdhaXRGb3JFbGVtZW50OiAoc2VsLCB0aW1lb3V0TXMgPSA1MDAwKSA9PlxuICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7XG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSByZXR1cm4gcmVzb2x2ZShleGlzdGluZyk7XG4gICAgICAgICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgdGltZW91dE1zO1xuICAgICAgICAgIGNvbnN0IG9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgICAgaWYgKGVsKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlc29sdmUoZWwpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChEYXRlLm5vdygpID4gZGVhZGxpbmUpIHtcbiAgICAgICAgICAgICAgb2JzLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgdGltZW91dCB3YWl0aW5nIGZvciAke3NlbH1gKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgICAgICAgfSksXG4gICAgfSxcbiAgICBpcGM6IHtcbiAgICAgIG9uOiAoYywgaCkgPT4ge1xuICAgICAgICBjb25zdCB3cmFwcGVkID0gKF9lOiB1bmtub3duLCAuLi5hcmdzOiB1bmtub3duW10pID0+IGgoLi4uYXJncyk7XG4gICAgICAgIGlwY1JlbmRlcmVyLm9uKGBjb2RleHBwOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGBjb2RleHBwOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgIH0sXG4gICAgICBzZW5kOiAoYywgLi4uYXJncykgPT4gaXBjUmVuZGVyZXIuc2VuZChgY29kZXhwcDoke2lkfToke2N9YCwgLi4uYXJncyksXG4gICAgICBpbnZva2U6IDxUPihjOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKGBjb2RleHBwOiR7aWR9OiR7Y31gLCAuLi5hcmdzKSBhcyBQcm9taXNlPFQ+LFxuICAgIH0sXG4gICAgZnM6IHJlbmRlcmVyRnMoaWQsIHBhdGhzKSxcbiAgICAuLi4oZ2l0ID8geyBnaXQgfSA6IHt9KSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJTdG9yYWdlKGlkOiBzdHJpbmcpIHtcbiAgY29uc3Qga2V5ID0gYGNvZGV4cHA6c3RvcmFnZToke2lkfWA7XG4gIGNvbnN0IHJlYWQgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpID8/IFwie31cIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICB9O1xuICBjb25zdCB3cml0ZSA9ICh2OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT5cbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHYpKTtcbiAgcmV0dXJuIHtcbiAgICBnZXQ6IDxUPihrOiBzdHJpbmcsIGQ/OiBUKSA9PiAoayBpbiByZWFkKCkgPyAocmVhZCgpW2tdIGFzIFQpIDogKGQgYXMgVCkpLFxuICAgIHNldDogKGs6IHN0cmluZywgdjogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbyA9IHJlYWQoKTtcbiAgICAgIG9ba10gPSB2O1xuICAgICAgd3JpdGUobyk7XG4gICAgfSxcbiAgICBkZWxldGU6IChrOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IG8gPSByZWFkKCk7XG4gICAgICBkZWxldGUgb1trXTtcbiAgICAgIHdyaXRlKG8pO1xuICAgIH0sXG4gICAgYWxsOiAoKSA9PiByZWFkKCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyRnMoaWQ6IHN0cmluZywgX3BhdGhzOiBVc2VyUGF0aHMpIHtcbiAgLy8gU2FuZGJveGVkIHJlbmRlcmVyIGNhbid0IHVzZSBOb2RlIGZzIGRpcmVjdGx5IFx1MjAxNCBwcm94eSB0aHJvdWdoIG1haW4gSVBDLlxuICByZXR1cm4ge1xuICAgIGRhdGFEaXI6IGA8cmVtb3RlPi90d2Vhay1kYXRhLyR7aWR9YCxcbiAgICByZWFkOiAocDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcInJlYWRcIiwgaWQsIHApIGFzIFByb21pc2U8c3RyaW5nPixcbiAgICB3cml0ZTogKHA6IHN0cmluZywgYzogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcIndyaXRlXCIsIGlkLCBwLCBjKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGV4aXN0czogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dHdlYWstZnNcIiwgXCJleGlzdHNcIiwgaWQsIHApIGFzIFByb21pc2U8Ym9vbGVhbj4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyR2l0KCkge1xuICByZXR1cm4ge1xuICAgIHJlc29sdmVSZXBvc2l0b3J5OiAocGF0aDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnaXQtcmVzb2x2ZS1yZXBvc2l0b3J5XCIsIHBhdGgpLFxuICAgIGdldFN0YXR1czogKHBhdGg6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LXN0YXR1c1wiLCBwYXRoKSxcbiAgICBnZXREaWZmU3VtbWFyeTogKHBhdGg6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LWRpZmYtc3VtbWFyeVwiLCBwYXRoKSxcbiAgICBnZXRXb3JrdHJlZXM6IChwYXRoOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmdpdC13b3JrdHJlZXNcIiwgcGF0aCksXG4gIH07XG59XG4iLCAiLyoqXG4gKiBCdWlsdC1pbiBcIlR3ZWFrIE1hbmFnZXJcIiBcdTIwMTQgYXV0by1pbmplY3RlZCBieSB0aGUgcnVudGltZSwgbm90IGEgdXNlciB0d2Vhay5cbiAqIExpc3RzIGRpc2NvdmVyZWQgdHdlYWtzIHdpdGggZW5hYmxlIHRvZ2dsZXMsIG9wZW5zIHRoZSB0d2Vha3MgZGlyLCBsaW5rc1xuICogdG8gbG9ncyBhbmQgY29uZmlnLiBMaXZlcyBpbiB0aGUgcmVuZGVyZXIuXG4gKlxuICogVGhpcyBpcyBpbnZva2VkIGZyb20gcHJlbG9hZC9pbmRleC50cyBBRlRFUiB1c2VyIHR3ZWFrcyBhcmUgbG9hZGVkIHNvIGl0XG4gKiBjYW4gc2hvdyB1cC10by1kYXRlIHN0YXR1cy5cbiAqL1xuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtb3VudE1hbmFnZXIoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmxpc3QtdHdlYWtzXCIpKSBhcyBBcnJheTx7XG4gICAgbWFuaWZlc3Q6IHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nIH07XG4gICAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIH0+O1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnVzZXItcGF0aHNcIikpIGFzIHtcbiAgICB1c2VyUm9vdDogc3RyaW5nO1xuICAgIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICAgIGxvZ0Rpcjogc3RyaW5nO1xuICB9O1xuXG4gIHJlZ2lzdGVyU2VjdGlvbih7XG4gICAgaWQ6IFwiY29kZXgtcGx1c3BsdXM6bWFuYWdlclwiLFxuICAgIHRpdGxlOiBcIlR3ZWFrIE1hbmFnZXJcIixcbiAgICBkZXNjcmlwdGlvbjogYCR7dHdlYWtzLmxlbmd0aH0gdHdlYWsocykgaW5zdGFsbGVkLiBVc2VyIGRpcjogJHtwYXRocy51c2VyUm9vdH1gLFxuICAgIHJlbmRlcihyb290KSB7XG4gICAgICByb290LnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweDtcIjtcblxuICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBhY3Rpb25zLnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO1wiO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiB0d2Vha3MgZm9sZGVyXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMudHdlYWtzRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiBsb2dzXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMubG9nRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiUmVsb2FkIHdpbmRvd1wiLCAoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSksXG4gICAgICApO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAgICAgaWYgKHR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICAgICAgZW1wdHkuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEzcHggc3lzdGVtLXVpO21hcmdpbjo4cHggMDtcIjtcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPVxuICAgICAgICAgIFwiTm8gdXNlciB0d2Vha3MgeWV0LiBEcm9wIGEgZm9sZGVyIHdpdGggbWFuaWZlc3QuanNvbiArIGluZGV4LmpzIGludG8gdGhlIHR3ZWFrcyBkaXIsIHRoZW4gcmVsb2FkLlwiO1xuICAgICAgICByb290LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInVsXCIpO1xuICAgICAgbGlzdC5zdHlsZS5jc3NUZXh0ID0gXCJsaXN0LXN0eWxlOm5vbmU7bWFyZ2luOjA7cGFkZGluZzowO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjZweDtcIjtcbiAgICAgIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICAgIGxpLnN0eWxlLmNzc1RleHQgPVxuICAgICAgICAgIFwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjhweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMyYTJhMmEpO2JvcmRlci1yYWRpdXM6NnB4O1wiO1xuICAgICAgICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgbGVmdC5pbm5lckhUTUwgPSBgXG4gICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQ6NjAwIDEzcHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QubmFtZSl9IDxzcGFuIHN0eWxlPVwiY29sb3I6Izg4ODtmb250LXdlaWdodDo0MDA7XCI+diR7ZXNjYXBlKHQubWFuaWZlc3QudmVyc2lvbil9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5kZXNjcmlwdGlvbiA/PyB0Lm1hbmlmZXN0LmlkKX08L2Rpdj5cbiAgICAgICAgYDtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICByaWdodC5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI7XG4gICAgICAgIHJpZ2h0LnRleHRDb250ZW50ID0gdC5lbnRyeUV4aXN0cyA/IFwibG9hZGVkXCIgOiBcIm1pc3NpbmcgZW50cnlcIjtcbiAgICAgICAgbGkuYXBwZW5kKGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgbGlzdC5hcHBlbmQobGkpO1xuICAgICAgfVxuICAgICAgcm9vdC5hcHBlbmQobGlzdCk7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbmNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBiLnN0eWxlLmNzc1RleHQgPVxuICAgIFwicGFkZGluZzo2cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMzMzKTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOmluaGVyaXQ7Zm9udDoxMnB4IHN5c3RlbS11aTtjdXJzb3I6cG9pbnRlcjtcIjtcbiAgYi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25jbGljayk7XG4gIHJldHVybiBiO1xufVxuXG5mdW5jdGlvbiBlc2NhcGUoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+XG4gICAgYyA9PT0gXCImXCJcbiAgICAgID8gXCImYW1wO1wiXG4gICAgICA6IGMgPT09IFwiPFwiXG4gICAgICAgID8gXCImbHQ7XCJcbiAgICAgICAgOiBjID09PSBcIj5cIlxuICAgICAgICAgID8gXCImZ3Q7XCJcbiAgICAgICAgICA6IGMgPT09ICdcIidcbiAgICAgICAgICAgID8gXCImcXVvdDtcIlxuICAgICAgICAgICAgOiBcIiYjMzk7XCIsXG4gICk7XG59XG4iLCAiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcblxuY29uc3QgQ09ERVhfTUVTU0FHRV9GUk9NX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mcm9tLXZpZXdcIjtcbmNvbnN0IENPREVYX01FU1NBR0VfRk9SX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mb3Itdmlld1wiO1xuY29uc3QgREVGQVVMVF9SRVFVRVNUX1RJTUVPVVRfTVMgPSAxMl8wMDA7XG5cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgZWxlY3Ryb25CcmlkZ2U/OiB7XG4gICAgICBzZW5kTWVzc2FnZUZyb21WaWV3PyhtZXNzYWdlOiB1bmtub3duKTogUHJvbWlzZTx2b2lkPjtcbiAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwU2VydmVyUmVxdWVzdE9wdGlvbnMge1xuICBob3N0SWQ/OiBzdHJpbmc7XG4gIHRpbWVvdXRNcz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBTZXJ2ZXJOb3RpZmljYXRpb24ge1xuICBtZXRob2Q6IHN0cmluZztcbiAgcGFyYW1zOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ1JlcXVlc3Qge1xuICBpZDogc3RyaW5nO1xuICByZXNvbHZlKHZhbHVlOiB1bmtub3duKTogdm9pZDtcbiAgcmVqZWN0KGVycm9yOiBFcnJvcik6IHZvaWQ7XG4gIHRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+O1xufVxuXG5sZXQgbmV4dFJlcXVlc3RJZCA9IDE7XG5jb25zdCBwZW5kaW5nUmVxdWVzdHMgPSBuZXcgTWFwPHN0cmluZywgUGVuZGluZ1JlcXVlc3Q+KCk7XG5jb25zdCBub3RpZmljYXRpb25MaXN0ZW5lcnMgPSBuZXcgU2V0PChub3RpZmljYXRpb246IEFwcFNlcnZlck5vdGlmaWNhdGlvbikgPT4gdm9pZD4oKTtcbmxldCBzdWJzY3JpYmVkID0gZmFsc2U7XG5cbmV4cG9ydCBmdW5jdGlvbiByZXF1ZXN0QXBwU2VydmVyPFQ+KFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGFyYW1zOiB1bmtub3duLFxuICBvcHRpb25zOiBBcHBTZXJ2ZXJSZXF1ZXN0T3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxUPiB7XG4gIGVuc3VyZVN1YnNjcmliZWQoKTtcbiAgY29uc3QgaWQgPSBgY29kZXhwcC0ke0RhdGUubm93KCl9LSR7bmV4dFJlcXVlc3RJZCsrfWA7XG4gIGNvbnN0IGhvc3RJZCA9IG9wdGlvbnMuaG9zdElkID8/IHJlYWRIb3N0SWQoKTtcbiAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0TXMgPz8gREVGQVVMVF9SRVFVRVNUX1RJTUVPVVRfTVM7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlPFQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgICAgIHJlamVjdChuZXcgRXJyb3IoYFRpbWVkIG91dCB3YWl0aW5nIGZvciBhcHAtc2VydmVyIHJlc3BvbnNlIHRvICR7bWV0aG9kfWApKTtcbiAgICB9LCB0aW1lb3V0TXMpO1xuXG4gICAgcGVuZGluZ1JlcXVlc3RzLnNldChpZCwge1xuICAgICAgaWQsXG4gICAgICByZXNvbHZlOiAodmFsdWUpID0+IHJlc29sdmUodmFsdWUgYXMgVCksXG4gICAgICByZWplY3QsXG4gICAgICB0aW1lb3V0LFxuICAgIH0pO1xuXG4gICAgY29uc3QgbWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6IFwibWNwLXJlcXVlc3RcIixcbiAgICAgIGhvc3RJZCxcbiAgICAgIHJlcXVlc3Q6IHsgaWQsIG1ldGhvZCwgcGFyYW1zIH0sXG4gICAgfTtcblxuICAgIHNlbmRNZXNzYWdlRnJvbVZpZXcobWVzc2FnZSkudGhlbigocmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAhPT0gdW5kZWZpbmVkKSBoYW5kbGVJbmNvbWluZ01lc3NhZ2UocmVzcG9uc2UpO1xuICAgIH0pLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgY29uc3QgcGVuZGluZyA9IHBlbmRpbmdSZXF1ZXN0cy5nZXQoaWQpO1xuICAgICAgaWYgKCFwZW5kaW5nKSByZXR1cm47XG4gICAgICBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lb3V0KTtcbiAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoaWQpO1xuICAgICAgcGVuZGluZy5yZWplY3QodG9FcnJvcihlcnJvcikpO1xuICAgIH0pO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9uQXBwU2VydmVyTm90aWZpY2F0aW9uKFxuICBsaXN0ZW5lcjogKG5vdGlmaWNhdGlvbjogQXBwU2VydmVyTm90aWZpY2F0aW9uKSA9PiB2b2lkLFxuKTogKCkgPT4gdm9pZCB7XG4gIGVuc3VyZVN1YnNjcmliZWQoKTtcbiAgbm90aWZpY2F0aW9uTGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gIHJldHVybiAoKSA9PiBub3RpZmljYXRpb25MaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWRIb3N0SWQoKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuICAgIGNvbnN0IGhvc3RJZCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiaG9zdElkXCIpPy50cmltKCk7XG4gICAgcmV0dXJuIGhvc3RJZCB8fCBcImxvY2FsXCI7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcImxvY2FsXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW5zdXJlU3Vic2NyaWJlZCgpOiB2b2lkIHtcbiAgaWYgKHN1YnNjcmliZWQpIHJldHVybjtcbiAgc3Vic2NyaWJlZCA9IHRydWU7XG4gIGlwY1JlbmRlcmVyLm9uKENPREVYX01FU1NBR0VfRk9SX1ZJRVcsIChfZXZlbnQsIG1lc3NhZ2UpID0+IHtcbiAgICBoYW5kbGVJbmNvbWluZ01lc3NhZ2UobWVzc2FnZSk7XG4gIH0pO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgKGV2ZW50KSA9PiB7XG4gICAgaGFuZGxlSW5jb21pbmdNZXNzYWdlKGV2ZW50LmRhdGEpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlSW5jb21pbmdNZXNzYWdlKG1lc3NhZ2U6IHVua25vd24pOiB2b2lkIHtcbiAgY29uc3Qgbm90aWZpY2F0aW9uID0gZXh0cmFjdE5vdGlmaWNhdGlvbihtZXNzYWdlKTtcbiAgaWYgKG5vdGlmaWNhdGlvbikge1xuICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2Ygbm90aWZpY2F0aW9uTGlzdGVuZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBsaXN0ZW5lcihub3RpZmljYXRpb24pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGlzb2xhdGUgbGlzdGVuZXIgZmFpbHVyZXMgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCByZXNwb25zZSA9IGV4dHJhY3RSZXNwb25zZShtZXNzYWdlKTtcbiAgaWYgKCFyZXNwb25zZSkgcmV0dXJuO1xuICBjb25zdCBwZW5kaW5nID0gcGVuZGluZ1JlcXVlc3RzLmdldChyZXNwb25zZS5pZCk7XG4gIGlmICghcGVuZGluZykgcmV0dXJuO1xuXG4gIGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVvdXQpO1xuICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKHJlc3BvbnNlLmlkKTtcbiAgaWYgKHJlc3BvbnNlLmVycm9yKSB7XG4gICAgcGVuZGluZy5yZWplY3QocmVzcG9uc2UuZXJyb3IpO1xuICAgIHJldHVybjtcbiAgfVxuICBwZW5kaW5nLnJlc29sdmUocmVzcG9uc2UucmVzdWx0KTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFJlc3BvbnNlKG1lc3NhZ2U6IHVua25vd24pOiB7IGlkOiBzdHJpbmc7IHJlc3VsdD86IHVua25vd247IGVycm9yPzogRXJyb3IgfSB8IG51bGwge1xuICBpZiAoIWlzUmVjb3JkKG1lc3NhZ2UpKSByZXR1cm4gbnVsbDtcblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1yZXNwb25zZVwiICYmIGlzUmVjb3JkKG1lc3NhZ2UucmVzcG9uc2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UucmVzcG9uc2UpO1xuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3AtcmVzcG9uc2VcIiAmJiBpc1JlY29yZChtZXNzYWdlLm1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UubWVzc2FnZSk7XG4gIH1cblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1lcnJvclwiICYmIHR5cGVvZiBtZXNzYWdlLmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHsgaWQ6IG1lc3NhZ2UuaWQsIGVycm9yOiBuZXcgRXJyb3IocmVhZEVycm9yTWVzc2FnZShtZXNzYWdlLmVycm9yKSA/PyBcIkFwcC1zZXJ2ZXIgcmVxdWVzdCBmYWlsZWRcIikgfTtcbiAgfVxuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwicmVzcG9uc2VcIiAmJiB0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIiAmJiAoXCJyZXN1bHRcIiBpbiBtZXNzYWdlIHx8IFwiZXJyb3JcIiBpbiBtZXNzYWdlKSkge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlKTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZXNwb25zZUZyb21FbnZlbG9wZShlbnZlbG9wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB7IGlkOiBzdHJpbmc7IHJlc3VsdD86IHVua25vd247IGVycm9yPzogRXJyb3IgfSB8IG51bGwge1xuICBjb25zdCBpZCA9IHR5cGVvZiBlbnZlbG9wZS5pZCA9PT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgZW52ZWxvcGUuaWQgPT09IFwibnVtYmVyXCJcbiAgICA/IFN0cmluZyhlbnZlbG9wZS5pZClcbiAgICA6IG51bGw7XG4gIGlmICghaWQpIHJldHVybiBudWxsO1xuXG4gIGlmIChcImVycm9yXCIgaW4gZW52ZWxvcGUpIHtcbiAgICByZXR1cm4geyBpZCwgZXJyb3I6IG5ldyBFcnJvcihyZWFkRXJyb3JNZXNzYWdlKGVudmVsb3BlLmVycm9yKSA/PyBcIkFwcC1zZXJ2ZXIgcmVxdWVzdCBmYWlsZWRcIikgfTtcbiAgfVxuXG4gIHJldHVybiB7IGlkLCByZXN1bHQ6IGVudmVsb3BlLnJlc3VsdCB9O1xufVxuXG5mdW5jdGlvbiBleHRyYWN0Tm90aWZpY2F0aW9uKG1lc3NhZ2U6IHVua25vd24pOiBBcHBTZXJ2ZXJOb3RpZmljYXRpb24gfCBudWxsIHtcbiAgaWYgKCFpc1JlY29yZChtZXNzYWdlKSkgcmV0dXJuIG51bGw7XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5yZXF1ZXN0KSkge1xuICAgIGNvbnN0IG1ldGhvZCA9IG1lc3NhZ2UucmVxdWVzdC5tZXRob2Q7XG4gICAgaWYgKHR5cGVvZiBtZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7IG1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnJlcXVlc3QucGFyYW1zIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5tZXNzYWdlKSkge1xuICAgIGNvbnN0IG1ldGhvZCA9IG1lc3NhZ2UubWVzc2FnZS5tZXRob2Q7XG4gICAgaWYgKHR5cGVvZiBtZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7IG1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLm1lc3NhZ2UucGFyYW1zIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgdHlwZW9mIG1lc3NhZ2UubWV0aG9kID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHsgbWV0aG9kOiBtZXNzYWdlLm1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnBhcmFtcyB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBtZXNzYWdlLm1ldGhvZCA9PT0gXCJzdHJpbmdcIiAmJiAhKFwiaWRcIiBpbiBtZXNzYWdlKSkge1xuICAgIHJldHVybiB7IG1ldGhvZDogbWVzc2FnZS5tZXRob2QsIHBhcmFtczogbWVzc2FnZS5wYXJhbXMgfTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZWFkRXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgaWYgKHR5cGVvZiBlcnJvciA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGVycm9yO1xuICBpZiAoaXNSZWNvcmQoZXJyb3IpKSB7XG4gICAgaWYgKHR5cGVvZiBlcnJvci5tZXNzYWdlID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgICBpZiAodHlwZW9mIGVycm9yLmVycm9yID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3IuZXJyb3I7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHNlbmRNZXNzYWdlRnJvbVZpZXcobWVzc2FnZTogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xuICBjb25zdCBicmlkZ2VTZW5kZXIgPSB3aW5kb3cuZWxlY3Ryb25CcmlkZ2U/LnNlbmRNZXNzYWdlRnJvbVZpZXc7XG4gIGlmICh0eXBlb2YgYnJpZGdlU2VuZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICByZXR1cm4gYnJpZGdlU2VuZGVyLmNhbGwod2luZG93LmVsZWN0cm9uQnJpZGdlLCBtZXNzYWdlKS50aGVuKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cbiAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShDT0RFWF9NRVNTQUdFX0ZST01fVklFVywgbWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIHRvRXJyb3IoZXJyb3I6IHVua25vd24pOiBFcnJvciB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSk7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4gdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTtcbn1cbiIsICJpbXBvcnQgeyBvbkFwcFNlcnZlck5vdGlmaWNhdGlvbiwgcmVhZEhvc3RJZCwgcmVxdWVzdEFwcFNlcnZlciB9IGZyb20gXCIuL2FwcC1zZXJ2ZXItYnJpZGdlXCI7XG5cbnR5cGUgR29hbFN0YXR1cyA9IFwiYWN0aXZlXCIgfCBcInBhdXNlZFwiIHwgXCJidWRnZXRMaW1pdGVkXCIgfCBcImNvbXBsZXRlXCI7XG5cbmludGVyZmFjZSBUaHJlYWRHb2FsIHtcbiAgdGhyZWFkSWQ6IHN0cmluZztcbiAgb2JqZWN0aXZlOiBzdHJpbmc7XG4gIHN0YXR1czogR29hbFN0YXR1cztcbiAgdG9rZW5CdWRnZXQ6IG51bWJlciB8IG51bGw7XG4gIHRva2Vuc1VzZWQ6IG51bWJlcjtcbiAgdGltZVVzZWRTZWNvbmRzOiBudW1iZXI7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICB1cGRhdGVkQXQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEdvYWxVaUFjdGlvbiB7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGtpbmQ/OiBcInByaW1hcnlcIiB8IFwiZGFuZ2VyXCI7XG4gIHJ1bigpOiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIEdvYWxQYW5lbE9wdGlvbnMge1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXRhaWw6IHN0cmluZztcbiAgZm9vdGVyPzogc3RyaW5nO1xuICBhY3Rpb25zOiBHb2FsVWlBY3Rpb25bXTtcbiAgcGVyc2lzdGVudDogYm9vbGVhbjtcbiAgZXJyb3I/OiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgR29hbFBhbmVsU3RhdGUge1xuICBjb2xsYXBzZWQ6IGJvb2xlYW47XG4gIHg6IG51bWJlciB8IG51bGw7XG4gIHk6IG51bWJlciB8IG51bGw7XG4gIHdpZHRoOiBudW1iZXIgfCBudWxsO1xuICBoZWlnaHQ6IG51bWJlciB8IG51bGw7XG59XG5cbmludGVyZmFjZSBHb2FsUGFuZWxEcmFnIHtcbiAgcG9pbnRlcklkOiBudW1iZXI7XG4gIG9mZnNldFg6IG51bWJlcjtcbiAgb2Zmc2V0WTogbnVtYmVyO1xuICB3aWR0aDogbnVtYmVyO1xuICBoZWlnaHQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEdvYWxQYW5lbFJlc2l6ZSB7XG4gIHBvaW50ZXJJZDogbnVtYmVyO1xuICBzdGFydFg6IG51bWJlcjtcbiAgc3RhcnRZOiBudW1iZXI7XG4gIHdpZHRoOiBudW1iZXI7XG4gIGhlaWdodDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgRWRpdGFibGVUYXJnZXQge1xuICBlbGVtZW50OiBIVE1MRWxlbWVudDtcbiAgZ2V0VGV4dCgpOiBzdHJpbmc7XG4gIHNldFRleHQodmFsdWU6IHN0cmluZyk6IHZvaWQ7XG4gIGNsZWFyKCk6IHZvaWQ7XG59XG5cbmxldCBzdGFydGVkID0gZmFsc2U7XG5sZXQgcm9vdDogSFRNTERpdkVsZW1lbnQgfCBudWxsID0gbnVsbDtcbmxldCBzdWdnZXN0aW9uUm9vdDogSFRNTERpdkVsZW1lbnQgfCBudWxsID0gbnVsbDtcbmxldCBjdXJyZW50R29hbDogVGhyZWFkR29hbCB8IG51bGwgPSBudWxsO1xubGV0IGhpZGVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbmxldCBsYXN0VGhyZWFkSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xubGV0IGxhc3RQYW5lbE9wdGlvbnM6IEdvYWxQYW5lbE9wdGlvbnMgfCBudWxsID0gbnVsbDtcbmxldCBwYW5lbERyYWc6IEdvYWxQYW5lbERyYWcgfCBudWxsID0gbnVsbDtcbmxldCBwYW5lbFJlc2l6ZTogR29hbFBhbmVsUmVzaXplIHwgbnVsbCA9IG51bGw7XG5cbmNvbnN0IEdPQUxfUEFORUxfU1RBVEVfS0VZID0gXCJjb2RleHBwOmdvYWwtcGFuZWwtc3RhdGVcIjtcbmNvbnN0IEdPQUxfUEFORUxfTUlOX1dJRFRIID0gMjgwO1xuY29uc3QgR09BTF9QQU5FTF9NSU5fSEVJR0hUID0gMTYwO1xuY29uc3QgR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU4gPSA4O1xubGV0IHBhbmVsU3RhdGU6IEdvYWxQYW5lbFN0YXRlID0gcmVhZEdvYWxQYW5lbFN0YXRlKCk7XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEdvYWxGZWF0dXJlKGxvZzogKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bikgPT4gdm9pZCA9ICgpID0+IHt9KTogdm9pZCB7XG4gIGlmIChzdGFydGVkKSByZXR1cm47XG4gIHN0YXJ0ZWQgPSB0cnVlO1xuICBpbnN0YWxsU3R5bGVzKCk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIChldmVudCkgPT4ge1xuICAgIHZvaWQgaGFuZGxlS2V5ZG93bihldmVudCwgbG9nKTtcbiAgfSwgdHJ1ZSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoZXZlbnQpID0+IHtcbiAgICB1cGRhdGVHb2FsU3VnZ2VzdGlvbihmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpKTtcbiAgfSwgdHJ1ZSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJmb2N1c2luXCIsIChldmVudCkgPT4ge1xuICAgIHVwZGF0ZUdvYWxTdWdnZXN0aW9uKGZpbmRFZGl0YWJsZVRhcmdldChldmVudCkpO1xuICB9LCB0cnVlKTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChldmVudCkgPT4ge1xuICAgIGlmIChzdWdnZXN0aW9uUm9vdD8uY29udGFpbnMoZXZlbnQudGFyZ2V0IGFzIE5vZGUpKSByZXR1cm47XG4gICAgdXBkYXRlR29hbFN1Z2dlc3Rpb24oZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50KSk7XG4gIH0sIHRydWUpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInJlc2l6ZVwiLCAoKSA9PiB7XG4gICAgaWYgKCFyb290Py5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgIGFwcGx5R29hbFBhbmVsU2l6ZShyb290KTtcbiAgICBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQocm9vdCk7XG4gICAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbiAgfSk7XG4gIG9uQXBwU2VydmVyTm90aWZpY2F0aW9uKChub3RpZmljYXRpb24pID0+IHtcbiAgICBpZiAobm90aWZpY2F0aW9uLm1ldGhvZCA9PT0gXCJ0aHJlYWQvZ29hbC91cGRhdGVkXCIgJiYgaXNSZWNvcmQobm90aWZpY2F0aW9uLnBhcmFtcykpIHtcbiAgICAgIGNvbnN0IGdvYWwgPSBub3RpZmljYXRpb24ucGFyYW1zLmdvYWw7XG4gICAgICBpZiAoaXNUaHJlYWRHb2FsKGdvYWwpKSB7XG4gICAgICAgIGlmIChnb2FsLnRocmVhZElkICE9PSByZWFkVGhyZWFkSWQoKSkgcmV0dXJuO1xuICAgICAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobm90aWZpY2F0aW9uLm1ldGhvZCA9PT0gXCJ0aHJlYWQvZ29hbC9jbGVhcmVkXCIgJiYgaXNSZWNvcmQobm90aWZpY2F0aW9uLnBhcmFtcykpIHtcbiAgICAgIGNvbnN0IHRocmVhZElkID0gbm90aWZpY2F0aW9uLnBhcmFtcy50aHJlYWRJZDtcbiAgICAgIGlmICh0eXBlb2YgdGhyZWFkSWQgPT09IFwic3RyaW5nXCIgJiYgdGhyZWFkSWQgPT09IHJlYWRUaHJlYWRJZCgpKSB7XG4gICAgICAgIGN1cnJlbnRHb2FsID0gbnVsbDtcbiAgICAgICAgcmVuZGVyTm90aWNlKFwiR29hbCBjbGVhcmVkXCIsIFwiVGhpcyB0aHJlYWQgbm8gbG9uZ2VyIGhhcyBhbiBhY3RpdmUgZ29hbC5cIik7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvcHN0YXRlXCIsICgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSk7XG4gIGNvbnN0IHJlZnJlc2hUaW1lciA9IHNldEludGVydmFsKCgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSwgMl81MDApO1xuICBjb25zdCB1bnJlZiA9IChyZWZyZXNoVGltZXIgYXMgdW5rbm93biBhcyB7IHVucmVmPzogKCkgPT4gdm9pZCB9KS51bnJlZjtcbiAgaWYgKHR5cGVvZiB1bnJlZiA9PT0gXCJmdW5jdGlvblwiKSB1bnJlZi5jYWxsKHJlZnJlc2hUaW1lcik7XG4gIHF1ZXVlTWljcm90YXNrKCgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSk7XG4gIGxvZyhcImdvYWwgZmVhdHVyZSBzdGFydGVkXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVLZXlkb3duKGV2ZW50OiBLZXlib2FyZEV2ZW50LCBsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGV2ZW50LmlzQ29tcG9zaW5nKSByZXR1cm47XG5cbiAgY29uc3QgZWRpdGFibGUgPSBmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpO1xuICBpZiAoIWVkaXRhYmxlKSByZXR1cm47XG5cbiAgaWYgKGV2ZW50LmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgIGhpZGVHb2FsU3VnZ2VzdGlvbigpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgoZXZlbnQua2V5ID09PSBcIlRhYlwiIHx8IGV2ZW50LmtleSA9PT0gXCJFbnRlclwiKSAmJiAhZXZlbnQuc2hpZnRLZXkgJiYgIWV2ZW50LmFsdEtleSAmJiAhZXZlbnQuY3RybEtleSAmJiAhZXZlbnQubWV0YUtleSkge1xuICAgIGNvbnN0IHN1Z2dlc3Rpb24gPSBwYXJzZUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLmdldFRleHQoKSk7XG4gICAgaWYgKHN1Z2dlc3Rpb24gJiYgZWRpdGFibGUuZ2V0VGV4dCgpLnRyaW0oKSAhPT0gXCIvZ29hbFwiKSB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIGlmIChldmVudC5rZXkgIT09IFwiRW50ZXJcIiB8fCBldmVudC5zaGlmdEtleSB8fCBldmVudC5hbHRLZXkgfHwgZXZlbnQuY3RybEtleSB8fCBldmVudC5tZXRhS2V5KSByZXR1cm47XG5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VHb2FsQ29tbWFuZChlZGl0YWJsZS5nZXRUZXh0KCkpO1xuICBpZiAoIXBhcnNlZCkgcmV0dXJuO1xuXG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICBldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgZWRpdGFibGUuY2xlYXIoKTtcbiAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBydW5Hb2FsQ29tbWFuZChwYXJzZWQuYXJncywgbG9nKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBsb2coXCJnb2FsIGNvbW1hbmQgZmFpbGVkXCIsIHN0cmluZ2lmeUVycm9yKGVycm9yKSk7XG4gICAgcmVuZGVyRXJyb3IoXCJHb2FsIGNvbW1hbmQgZmFpbGVkXCIsIGZyaWVuZGx5R29hbEVycm9yKGVycm9yKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcGFyc2VHb2FsQ29tbWFuZCh0ZXh0OiBzdHJpbmcpOiB7IGFyZ3M6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gdGV4dC50cmltKCkubWF0Y2goL15cXC9nb2FsKD86XFxzKyhbXFxzXFxTXSopKT8kLyk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhcmdzOiAobWF0Y2hbMV0gPz8gXCJcIikudHJpbSgpIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlR29hbFN1Z2dlc3Rpb24odGV4dDogc3RyaW5nKTogeyBxdWVyeTogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSB0ZXh0LnRyaW0oKS5tYXRjaCgvXlxcLyhbYS16XSopJC9pKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHF1ZXJ5ID0gbWF0Y2hbMV0/LnRvTG93ZXJDYXNlKCkgPz8gXCJcIjtcbiAgcmV0dXJuIFwiZ29hbFwiLnN0YXJ0c1dpdGgocXVlcnkpID8geyBxdWVyeSB9IDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuR29hbENvbW1hbmQoYXJnczogc3RyaW5nLCBsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKTtcbiAgaWYgKCF0aHJlYWRJZCkge1xuICAgIHJlbmRlckVycm9yKFwiTm8gYWN0aXZlIHRocmVhZFwiLCBcIk9wZW4gYSBsb2NhbCB0aHJlYWQgYmVmb3JlIHVzaW5nIC9nb2FsLlwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgaG9zdElkID0gcmVhZEhvc3RJZCgpO1xuICBjb25zdCBsb3dlciA9IGFyZ3MudG9Mb3dlckNhc2UoKTtcblxuICBpZiAoIWFyZ3MpIHtcbiAgICBjb25zdCBnb2FsID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgaG9zdElkKTtcbiAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgaWYgKGdvYWwpIHtcbiAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICByZW5kZXJOb3RpY2UoXCJObyBnb2FsIHNldFwiLCBcIlVzZSAvZ29hbCA8b2JqZWN0aXZlPiB0byBzZXQgb25lIGZvciB0aGlzIHRocmVhZC5cIik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChsb3dlciA9PT0gXCJjbGVhclwiKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgY2xlYXJlZDogYm9vbGVhbiB9PihcbiAgICAgIFwidGhyZWFkL2dvYWwvY2xlYXJcIixcbiAgICAgIHsgdGhyZWFkSWQgfSxcbiAgICAgIHsgaG9zdElkIH0sXG4gICAgKTtcbiAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgcmVuZGVyTm90aWNlKHJlc3BvbnNlLmNsZWFyZWQgPyBcIkdvYWwgY2xlYXJlZFwiIDogXCJObyBnb2FsIHNldFwiLCBcIlVzZSAvZ29hbCA8b2JqZWN0aXZlPiB0byBzZXQgYSBuZXcgZ29hbC5cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGxvd2VyID09PSBcInBhdXNlXCIgfHwgbG93ZXIgPT09IFwicmVzdW1lXCIgfHwgbG93ZXIgPT09IFwiY29tcGxldGVcIikge1xuICAgIGNvbnN0IHN0YXR1czogR29hbFN0YXR1cyA9IGxvd2VyID09PSBcInBhdXNlXCIgPyBcInBhdXNlZFwiIDogbG93ZXIgPT09IFwicmVzdW1lXCIgPyBcImFjdGl2ZVwiIDogXCJjb21wbGV0ZVwiO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgICBcInRocmVhZC9nb2FsL3NldFwiLFxuICAgICAgeyB0aHJlYWRJZCwgc3RhdHVzIH0sXG4gICAgICB7IGhvc3RJZCB9LFxuICAgICk7XG4gICAgY3VycmVudEdvYWwgPSByZXNwb25zZS5nb2FsO1xuICAgIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgaG9zdElkKTtcbiAgaWYgKGV4aXN0aW5nICYmIGV4aXN0aW5nLm9iamVjdGl2ZSAhPT0gYXJncykge1xuICAgIGNvbnN0IHJlcGxhY2UgPSBhd2FpdCBjb25maXJtUmVwbGFjZUdvYWwoZXhpc3RpbmcsIGFyZ3MpO1xuICAgIGlmICghcmVwbGFjZSkge1xuICAgICAgY3VycmVudEdvYWwgPSBleGlzdGluZztcbiAgICAgIHJlbmRlckdvYWwoZXhpc3RpbmcsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvc2V0XCIsXG4gICAgeyB0aHJlYWRJZCwgb2JqZWN0aXZlOiBhcmdzLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICB7IGhvc3RJZCB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IHJlc3BvbnNlLmdvYWw7XG4gIGxvZyhcImdvYWwgc2V0XCIsIHsgdGhyZWFkSWQgfSk7XG4gIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRHb2FsKHRocmVhZElkOiBzdHJpbmcsIGhvc3RJZDogc3RyaW5nKTogUHJvbWlzZTxUaHJlYWRHb2FsIHwgbnVsbD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIHwgbnVsbCB9PihcbiAgICBcInRocmVhZC9nb2FsL2dldFwiLFxuICAgIHsgdGhyZWFkSWQgfSxcbiAgICB7IGhvc3RJZCB9LFxuICApO1xuICByZXR1cm4gcmVzcG9uc2UuZ29hbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaEdvYWxGb3JSb3V0ZShsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKTtcbiAgaWYgKCF0aHJlYWRJZCkge1xuICAgIGlmIChsYXN0VGhyZWFkSWQgIT09IG51bGwpIHtcbiAgICAgIGxhc3RUaHJlYWRJZCA9IG51bGw7XG4gICAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgICBoaWRlUGFuZWwoKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aHJlYWRJZCA9PT0gbGFzdFRocmVhZElkKSByZXR1cm47XG4gIGxhc3RUaHJlYWRJZCA9IHRocmVhZElkO1xuICB0cnkge1xuICAgIGNvbnN0IGdvYWwgPSBhd2FpdCBnZXRHb2FsKHRocmVhZElkLCByZWFkSG9zdElkKCkpO1xuICAgIGN1cnJlbnRHb2FsID0gZ29hbDtcbiAgICBpZiAoZ29hbCkge1xuICAgICAgcmVuZGVyR29hbChnb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGhpZGVQYW5lbCgpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBPbGQgYXBwLXNlcnZlciBidWlsZHMgZG8gbm90IGtub3cgdGhyZWFkL2dvYWwvKi4gS2VlcCB0aGUgVUkgcXVpZXQgdW50aWxcbiAgICAvLyB0aGUgdXNlciBleHBsaWNpdGx5IHR5cGVzIC9nb2FsLCB0aGVuIHNob3cgdGhlIGFjdGlvbmFibGUgZXJyb3IuXG4gICAgbG9nKFwiZ29hbCByb3V0ZSByZWZyZXNoIHNraXBwZWRcIiwgc3RyaW5naWZ5RXJyb3IoZXJyb3IpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb25maXJtUmVwbGFjZUdvYWwoZXhpc3Rpbmc6IFRocmVhZEdvYWwsIG5leHRPYmplY3RpdmU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICByZW5kZXJQYW5lbCh7XG4gICAgICB0aXRsZTogXCJSZXBsYWNlIGN1cnJlbnQgZ29hbD9cIixcbiAgICAgIGRldGFpbDogdHJ1bmNhdGUoZXhpc3Rpbmcub2JqZWN0aXZlLCAxODApLFxuICAgICAgZm9vdGVyOiBgTmV3OiAke3RydW5jYXRlKG5leHRPYmplY3RpdmUsIDE4MCl9YCxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGxhYmVsOiBcIlJlcGxhY2VcIixcbiAgICAgICAgICBraW5kOiBcInByaW1hcnlcIixcbiAgICAgICAgICBydW46ICgpID0+IHJlc29sdmUodHJ1ZSksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBsYWJlbDogXCJDYW5jZWxcIixcbiAgICAgICAgICBydW46ICgpID0+IHJlc29sdmUoZmFsc2UpLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHBlcnNpc3RlbnQ6IHRydWUsXG4gICAgfSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJHb2FsKGdvYWw6IFRocmVhZEdvYWwsIG9wdGlvbnM6IHsgdHJhbnNpZW50OiBib29sZWFuIH0pOiB2b2lkIHtcbiAgY29uc3Qgc3RhdHVzID0gZ29hbFN0YXR1c0xhYmVsKGdvYWwuc3RhdHVzKTtcbiAgY29uc3QgYnVkZ2V0ID0gZ29hbC50b2tlbkJ1ZGdldCA9PSBudWxsXG4gICAgPyBgJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbnNVc2VkKX0gdG9rZW5zYFxuICAgIDogYCR7Zm9ybWF0TnVtYmVyKGdvYWwudG9rZW5zVXNlZCl9IC8gJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbkJ1ZGdldCl9IHRva2Vuc2A7XG4gIHJlbmRlclBhbmVsKHtcbiAgICB0aXRsZTogYEdvYWwgJHtzdGF0dXN9YCxcbiAgICBkZXRhaWw6IGdvYWwub2JqZWN0aXZlLFxuICAgIGZvb3RlcjogYCR7YnVkZ2V0fSAtICR7Zm9ybWF0RHVyYXRpb24oZ29hbC50aW1lVXNlZFNlY29uZHMpfWAsXG4gICAgYWN0aW9uczogW1xuICAgICAgZ29hbC5zdGF0dXMgPT09IFwicGF1c2VkXCJcbiAgICAgICAgPyB7IGxhYmVsOiBcIlJlc3VtZVwiLCBraW5kOiBcInByaW1hcnlcIiwgcnVuOiAoKSA9PiB1cGRhdGVHb2FsU3RhdHVzKFwiYWN0aXZlXCIpIH1cbiAgICAgICAgOiB7IGxhYmVsOiBcIlBhdXNlXCIsIHJ1bjogKCkgPT4gdXBkYXRlR29hbFN0YXR1cyhcInBhdXNlZFwiKSB9LFxuICAgICAgeyBsYWJlbDogXCJDb21wbGV0ZVwiLCBydW46ICgpID0+IHVwZGF0ZUdvYWxTdGF0dXMoXCJjb21wbGV0ZVwiKSB9LFxuICAgICAgeyBsYWJlbDogXCJDbGVhclwiLCBraW5kOiBcImRhbmdlclwiLCBydW46ICgpID0+IGNsZWFyQ3VycmVudEdvYWwoKSB9LFxuICAgIF0sXG4gICAgcGVyc2lzdGVudDogIW9wdGlvbnMudHJhbnNpZW50LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyTm90aWNlKHRpdGxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogdm9pZCB7XG4gIHJlbmRlclBhbmVsKHsgdGl0bGUsIGRldGFpbCwgYWN0aW9uczogW10sIHBlcnNpc3RlbnQ6IGZhbHNlIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFcnJvcih0aXRsZTogc3RyaW5nLCBkZXRhaWw6IHN0cmluZyk6IHZvaWQge1xuICByZW5kZXJQYW5lbCh7IHRpdGxlLCBkZXRhaWwsIGFjdGlvbnM6IFtdLCBwZXJzaXN0ZW50OiBmYWxzZSwgZXJyb3I6IHRydWUgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclBhbmVsKG9wdGlvbnM6IEdvYWxQYW5lbE9wdGlvbnMpOiB2b2lkIHtcbiAgbGFzdFBhbmVsT3B0aW9ucyA9IG9wdGlvbnM7XG4gIGNvbnN0IGVsID0gZW5zdXJlUm9vdCgpO1xuICBpZiAoaGlkZVRpbWVyKSBjbGVhclRpbWVvdXQoaGlkZVRpbWVyKTtcbiAgZWwuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWwuY2xhc3NOYW1lID0gYGNvZGV4cHAtZ29hbC1wYW5lbCR7b3B0aW9ucy5lcnJvciA/IFwiIGlzLWVycm9yXCIgOiBcIlwifSR7cGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIiBpcy1jb2xsYXBzZWRcIiA6IFwiXCJ9YDtcbiAgYXBwbHlHb2FsUGFuZWxTaXplKGVsKTtcbiAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihlbCk7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWhlYWRlclwiO1xuICBoZWFkZXIuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIHN0YXJ0R29hbFBhbmVsRHJhZyk7XG4gIGhlYWRlci5hZGRFdmVudExpc3RlbmVyKFwiZGJsY2xpY2tcIiwgcmVzZXRHb2FsUGFuZWxQb3NpdGlvbik7XG5cbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC10aXRsZVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IG9wdGlvbnMudGl0bGU7XG5cbiAgY29uc3QgY29udHJvbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb250cm9scy5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1jb250cm9sc1wiO1xuXG4gIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29sbGFwc2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaWNvblwiO1xuICBjb2xsYXBzZS50eXBlID0gXCJidXR0b25cIjtcbiAgY29sbGFwc2UudGV4dENvbnRlbnQgPSBwYW5lbFN0YXRlLmNvbGxhcHNlZCA/IFwiK1wiIDogXCItXCI7XG4gIGNvbGxhcHNlLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgcGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIkV4cGFuZCBnb2FsIHBhbmVsXCIgOiBcIkNvbGxhcHNlIGdvYWwgcGFuZWxcIik7XG4gIGNvbGxhcHNlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgcGFuZWxTdGF0ZSA9IHsgLi4ucGFuZWxTdGF0ZSwgY29sbGFwc2VkOiAhcGFuZWxTdGF0ZS5jb2xsYXBzZWQgfTtcbiAgICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbiAgICBpZiAobGFzdFBhbmVsT3B0aW9ucykgcmVuZGVyUGFuZWwobGFzdFBhbmVsT3B0aW9ucyk7XG4gIH0pO1xuXG4gIGNvbnN0IGNsb3NlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY2xvc2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaWNvblwiO1xuICBjbG9zZS50eXBlID0gXCJidXR0b25cIjtcbiAgY2xvc2UudGV4dENvbnRlbnQgPSBcInhcIjtcbiAgY2xvc2Uuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIkNsb3NlIGdvYWwgcGFuZWxcIik7XG4gIGNsb3NlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBoaWRlUGFuZWwoKSk7XG4gIGNvbnRyb2xzLmFwcGVuZChjb2xsYXBzZSwgY2xvc2UpO1xuICBoZWFkZXIuYXBwZW5kKHRpdGxlLCBjb250cm9scyk7XG4gIGVsLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgaWYgKHBhbmVsU3RhdGUuY29sbGFwc2VkKSB7XG4gICAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICBpZiAoIW9wdGlvbnMucGVyc2lzdGVudCkge1xuICAgICAgaGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBoaWRlUGFuZWwoKSwgOF8wMDApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBkZXRhaWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXRhaWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtZGV0YWlsXCI7XG4gIGRldGFpbC50ZXh0Q29udGVudCA9IG9wdGlvbnMuZGV0YWlsO1xuXG4gIGVsLmFwcGVuZENoaWxkKGRldGFpbCk7XG5cbiAgaWYgKG9wdGlvbnMuZm9vdGVyKSB7XG4gICAgY29uc3QgZm9vdGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBmb290ZXIuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtZm9vdGVyXCI7XG4gICAgZm9vdGVyLnRleHRDb250ZW50ID0gb3B0aW9ucy5mb290ZXI7XG4gICAgZWwuYXBwZW5kQ2hpbGQoZm9vdGVyKTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLmFjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtYWN0aW9uc1wiO1xuICAgIGZvciAoY29uc3QgYWN0aW9uIG9mIG9wdGlvbnMuYWN0aW9ucykge1xuICAgICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGFjdGlvbi5sYWJlbDtcbiAgICAgIGJ1dHRvbi5jbGFzc05hbWUgPSBgY29kZXhwcC1nb2FsLWFjdGlvbiAke2FjdGlvbi5raW5kID8/IFwiXCJ9YDtcbiAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgICBQcm9taXNlLnJlc29sdmUoYWN0aW9uLnJ1bigpKS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICByZW5kZXJFcnJvcihcIkdvYWwgYWN0aW9uIGZhaWxlZFwiLCBmcmllbmRseUdvYWxFcnJvcihlcnJvcikpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgIH1cbiAgICBlbC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgfVxuXG4gIGNvbnN0IHJlc2l6ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIHJlc2l6ZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1yZXNpemVcIjtcbiAgcmVzaXplLnR5cGUgPSBcImJ1dHRvblwiO1xuICByZXNpemUuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIlJlc2l6ZSBnb2FsIHBhbmVsXCIpO1xuICByZXNpemUuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIHN0YXJ0R29hbFBhbmVsUmVzaXplKTtcbiAgcmVzaXplLmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIGhhbmRsZUdvYWxQYW5lbFJlc2l6ZUtleWRvd24pO1xuICByZXNpemUuYWRkRXZlbnRMaXN0ZW5lcihcImRibGNsaWNrXCIsIHJlc2V0R29hbFBhbmVsU2l6ZSk7XG4gIGVsLmFwcGVuZENoaWxkKHJlc2l6ZSk7XG5cbiAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgaWYgKCFvcHRpb25zLnBlcnNpc3RlbnQpIHtcbiAgICBoaWRlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGhpZGVQYW5lbCgpLCA4XzAwMCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gdXBkYXRlR29hbFN0YXR1cyhzdGF0dXM6IEdvYWxTdGF0dXMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKSA/PyBjdXJyZW50R29hbD8udGhyZWFkSWQ7XG4gIGlmICghdGhyZWFkSWQpIHJldHVybjtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgZ29hbDogVGhyZWFkR29hbCB9PihcbiAgICBcInRocmVhZC9nb2FsL3NldFwiLFxuICAgIHsgdGhyZWFkSWQsIHN0YXR1cyB9LFxuICAgIHsgaG9zdElkOiByZWFkSG9zdElkKCkgfSxcbiAgKTtcbiAgY3VycmVudEdvYWwgPSByZXNwb25zZS5nb2FsO1xuICByZW5kZXJHb2FsKHJlc3BvbnNlLmdvYWwsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY2xlYXJDdXJyZW50R29hbCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKSA/PyBjdXJyZW50R29hbD8udGhyZWFkSWQ7XG4gIGlmICghdGhyZWFkSWQpIHJldHVybjtcbiAgYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGNsZWFyZWQ6IGJvb2xlYW4gfT4oXG4gICAgXCJ0aHJlYWQvZ29hbC9jbGVhclwiLFxuICAgIHsgdGhyZWFkSWQgfSxcbiAgICB7IGhvc3RJZDogcmVhZEhvc3RJZCgpIH0sXG4gICk7XG4gIGN1cnJlbnRHb2FsID0gbnVsbDtcbiAgcmVuZGVyTm90aWNlKFwiR29hbCBjbGVhcmVkXCIsIFwiVGhpcyB0aHJlYWQgbm8gbG9uZ2VyIGhhcyBhbiBhY3RpdmUgZ29hbC5cIik7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVJvb3QoKTogSFRNTERpdkVsZW1lbnQge1xuICBpZiAocm9vdD8uaXNDb25uZWN0ZWQpIHJldHVybiByb290O1xuICByb290ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm9vdC5pZCA9IFwiY29kZXhwcC1nb2FsLXJvb3RcIjtcbiAgcm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIGNvbnN0IHBhcmVudCA9IGRvY3VtZW50LmJvZHkgfHwgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50O1xuICBpZiAocGFyZW50KSBwYXJlbnQuYXBwZW5kQ2hpbGQocm9vdCk7XG4gIHJldHVybiByb290O1xufVxuXG5mdW5jdGlvbiBoaWRlUGFuZWwoKTogdm9pZCB7XG4gIGlmIChoaWRlVGltZXIpIHtcbiAgICBjbGVhclRpbWVvdXQoaGlkZVRpbWVyKTtcbiAgICBoaWRlVGltZXIgPSBudWxsO1xuICB9XG4gIGlmIChyb290KSByb290LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbn1cblxuZnVuY3Rpb24gc3RhcnRHb2FsUGFuZWxEcmFnKGV2ZW50OiBQb2ludGVyRXZlbnQpOiB2b2lkIHtcbiAgaWYgKGV2ZW50LmJ1dHRvbiAhPT0gMCkgcmV0dXJuO1xuICBpZiAoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCAmJiBldmVudC50YXJnZXQuY2xvc2VzdChcImJ1dHRvblwiKSkgcmV0dXJuO1xuICBpZiAoIXJvb3QpIHJldHVybjtcbiAgY29uc3QgcmVjdCA9IHJvb3QuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIHBhbmVsRHJhZyA9IHtcbiAgICBwb2ludGVySWQ6IGV2ZW50LnBvaW50ZXJJZCxcbiAgICBvZmZzZXRYOiBldmVudC5jbGllbnRYIC0gcmVjdC5sZWZ0LFxuICAgIG9mZnNldFk6IGV2ZW50LmNsaWVudFkgLSByZWN0LnRvcCxcbiAgICB3aWR0aDogcmVjdC53aWR0aCxcbiAgICBoZWlnaHQ6IHJlY3QuaGVpZ2h0LFxuICB9O1xuICByb290LmNsYXNzTGlzdC5hZGQoXCJpcy1kcmFnZ2luZ1wiKTtcbiAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVybW92ZVwiLCBtb3ZlR29hbFBhbmVsKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVydXBcIiwgc3RvcEdvYWxQYW5lbERyYWcpO1xufVxuXG5mdW5jdGlvbiBtb3ZlR29hbFBhbmVsKGV2ZW50OiBQb2ludGVyRXZlbnQpOiB2b2lkIHtcbiAgaWYgKCFwYW5lbERyYWcgfHwgZXZlbnQucG9pbnRlcklkICE9PSBwYW5lbERyYWcucG9pbnRlcklkIHx8ICFyb290KSByZXR1cm47XG4gIHBhbmVsU3RhdGUgPSB7XG4gICAgLi4ucGFuZWxTdGF0ZSxcbiAgICB4OiBjbGFtcChldmVudC5jbGllbnRYIC0gcGFuZWxEcmFnLm9mZnNldFgsIDgsIHdpbmRvdy5pbm5lcldpZHRoIC0gcGFuZWxEcmFnLndpZHRoIC0gOCksXG4gICAgeTogY2xhbXAoZXZlbnQuY2xpZW50WSAtIHBhbmVsRHJhZy5vZmZzZXRZLCA4LCB3aW5kb3cuaW5uZXJIZWlnaHQgLSBwYW5lbERyYWcuaGVpZ2h0IC0gOCksXG4gIH07XG4gIGFwcGx5R29hbFBhbmVsUG9zaXRpb24ocm9vdCk7XG59XG5cbmZ1bmN0aW9uIHN0b3BHb2FsUGFuZWxEcmFnKGV2ZW50OiBQb2ludGVyRXZlbnQpOiB2b2lkIHtcbiAgaWYgKHBhbmVsRHJhZyAmJiBldmVudC5wb2ludGVySWQgIT09IHBhbmVsRHJhZy5wb2ludGVySWQpIHJldHVybjtcbiAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJwb2ludGVybW92ZVwiLCBtb3ZlR29hbFBhbmVsKTtcbiAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJwb2ludGVydXBcIiwgc3RvcEdvYWxQYW5lbERyYWcpO1xuICBpZiAocm9vdCkgcm9vdC5jbGFzc0xpc3QucmVtb3ZlKFwiaXMtZHJhZ2dpbmdcIik7XG4gIHBhbmVsRHJhZyA9IG51bGw7XG4gIGlmIChyb290KSBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQocm9vdCk7XG4gIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xufVxuXG5mdW5jdGlvbiBzdGFydEdvYWxQYW5lbFJlc2l6ZShldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChldmVudC5idXR0b24gIT09IDAgfHwgcGFuZWxTdGF0ZS5jb2xsYXBzZWQpIHJldHVybjtcbiAgaWYgKCFyb290KSByZXR1cm47XG4gIGNvbnN0IHJlY3QgPSByb290LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBlbnN1cmVFeHBsaWNpdEdvYWxQYW5lbEZyYW1lKHJlY3QpO1xuICBwYW5lbFJlc2l6ZSA9IHtcbiAgICBwb2ludGVySWQ6IGV2ZW50LnBvaW50ZXJJZCxcbiAgICBzdGFydFg6IGV2ZW50LmNsaWVudFgsXG4gICAgc3RhcnRZOiBldmVudC5jbGllbnRZLFxuICAgIHdpZHRoOiByZWN0LndpZHRoLFxuICAgIGhlaWdodDogcmVjdC5oZWlnaHQsXG4gIH07XG4gIHJvb3QuY2xhc3NMaXN0LmFkZChcImlzLXJlc2l6aW5nXCIpO1xuICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVybW92ZVwiLCByZXNpemVHb2FsUGFuZWwpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJ1cFwiLCBzdG9wR29hbFBhbmVsUmVzaXplKTtcbn1cblxuZnVuY3Rpb24gcmVzaXplR29hbFBhbmVsKGV2ZW50OiBQb2ludGVyRXZlbnQpOiB2b2lkIHtcbiAgaWYgKCFwYW5lbFJlc2l6ZSB8fCBldmVudC5wb2ludGVySWQgIT09IHBhbmVsUmVzaXplLnBvaW50ZXJJZCB8fCAhcm9vdCkgcmV0dXJuO1xuICBjb25zdCBtYXhXaWR0aCA9IGdvYWxQYW5lbE1heFdpZHRoKCk7XG4gIGNvbnN0IG1heEhlaWdodCA9IGdvYWxQYW5lbE1heEhlaWdodCgpO1xuICBwYW5lbFN0YXRlID0ge1xuICAgIC4uLnBhbmVsU3RhdGUsXG4gICAgd2lkdGg6IGNsYW1wKHBhbmVsUmVzaXplLndpZHRoICsgZXZlbnQuY2xpZW50WCAtIHBhbmVsUmVzaXplLnN0YXJ0WCwgR09BTF9QQU5FTF9NSU5fV0lEVEgsIG1heFdpZHRoKSxcbiAgICBoZWlnaHQ6IGNsYW1wKHBhbmVsUmVzaXplLmhlaWdodCArIGV2ZW50LmNsaWVudFkgLSBwYW5lbFJlc2l6ZS5zdGFydFksIEdPQUxfUEFORUxfTUlOX0hFSUdIVCwgbWF4SGVpZ2h0KSxcbiAgfTtcbiAgYXBwbHlHb2FsUGFuZWxTaXplKHJvb3QpO1xuICBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQocm9vdCk7XG4gIGFwcGx5R29hbFBhbmVsUG9zaXRpb24ocm9vdCk7XG59XG5cbmZ1bmN0aW9uIHN0b3BHb2FsUGFuZWxSZXNpemUoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQge1xuICBpZiAocGFuZWxSZXNpemUgJiYgZXZlbnQucG9pbnRlcklkICE9PSBwYW5lbFJlc2l6ZS5wb2ludGVySWQpIHJldHVybjtcbiAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJwb2ludGVybW92ZVwiLCByZXNpemVHb2FsUGFuZWwpO1xuICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJ1cFwiLCBzdG9wR29hbFBhbmVsUmVzaXplKTtcbiAgaWYgKHJvb3QpIHJvb3QuY2xhc3NMaXN0LnJlbW92ZShcImlzLXJlc2l6aW5nXCIpO1xuICBwYW5lbFJlc2l6ZSA9IG51bGw7XG4gIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVHb2FsUGFuZWxSZXNpemVLZXlkb3duKGV2ZW50OiBLZXlib2FyZEV2ZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbFN0YXRlLmNvbGxhcHNlZCB8fCAhcm9vdCkgcmV0dXJuO1xuICBjb25zdCBkZWx0YSA9IGV2ZW50LnNoaWZ0S2V5ID8gMzIgOiAxMjtcbiAgbGV0IHdpZHRoRGVsdGEgPSAwO1xuICBsZXQgaGVpZ2h0RGVsdGEgPSAwO1xuICBpZiAoZXZlbnQua2V5ID09PSBcIkFycm93TGVmdFwiKSB3aWR0aERlbHRhID0gLWRlbHRhO1xuICBlbHNlIGlmIChldmVudC5rZXkgPT09IFwiQXJyb3dSaWdodFwiKSB3aWR0aERlbHRhID0gZGVsdGE7XG4gIGVsc2UgaWYgKGV2ZW50LmtleSA9PT0gXCJBcnJvd1VwXCIpIGhlaWdodERlbHRhID0gLWRlbHRhO1xuICBlbHNlIGlmIChldmVudC5rZXkgPT09IFwiQXJyb3dEb3duXCIpIGhlaWdodERlbHRhID0gZGVsdGE7XG4gIGVsc2UgcmV0dXJuO1xuXG4gIGNvbnN0IHJlY3QgPSByb290LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBlbnN1cmVFeHBsaWNpdEdvYWxQYW5lbEZyYW1lKHJlY3QpO1xuICBwYW5lbFN0YXRlID0ge1xuICAgIC4uLnBhbmVsU3RhdGUsXG4gICAgd2lkdGg6IGNsYW1wKChwYW5lbFN0YXRlLndpZHRoID8/IHJlY3Qud2lkdGgpICsgd2lkdGhEZWx0YSwgR09BTF9QQU5FTF9NSU5fV0lEVEgsIGdvYWxQYW5lbE1heFdpZHRoKCkpLFxuICAgIGhlaWdodDogY2xhbXAoKHBhbmVsU3RhdGUuaGVpZ2h0ID8/IHJlY3QuaGVpZ2h0KSArIGhlaWdodERlbHRhLCBHT0FMX1BBTkVMX01JTl9IRUlHSFQsIGdvYWxQYW5lbE1heEhlaWdodCgpKSxcbiAgfTtcbiAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gIGFwcGx5R29hbFBhbmVsU2l6ZShyb290KTtcbiAgY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KHJvb3QpO1xuICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xuICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbn1cblxuZnVuY3Rpb24gcmVzZXRHb2FsUGFuZWxTaXplKGV2ZW50OiBNb3VzZUV2ZW50KTogdm9pZCB7XG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICBwYW5lbFN0YXRlID0geyAuLi5wYW5lbFN0YXRlLCB3aWR0aDogbnVsbCwgaGVpZ2h0OiBudWxsIH07XG4gIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xuICBpZiAocm9vdCkge1xuICAgIGFwcGx5R29hbFBhbmVsU2l6ZShyb290KTtcbiAgICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc2V0R29hbFBhbmVsUG9zaXRpb24oZXZlbnQ6IE1vdXNlRXZlbnQpOiB2b2lkIHtcbiAgaWYgKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgJiYgZXZlbnQudGFyZ2V0LmNsb3Nlc3QoXCJidXR0b25cIikpIHJldHVybjtcbiAgcGFuZWxTdGF0ZSA9IHsgLi4ucGFuZWxTdGF0ZSwgeDogbnVsbCwgeTogbnVsbCB9O1xuICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbiAgaWYgKHJvb3QpIGFwcGx5R29hbFBhbmVsUG9zaXRpb24ocm9vdCk7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZUV4cGxpY2l0R29hbFBhbmVsRnJhbWUocmVjdDogRE9NUmVjdCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkge1xuICAgIHBhbmVsU3RhdGUgPSB7IC4uLnBhbmVsU3RhdGUsIHg6IHJlY3QubGVmdCwgeTogcmVjdC50b3AgfTtcbiAgfVxuICBpZiAocGFuZWxTdGF0ZS53aWR0aCA9PT0gbnVsbCB8fCBwYW5lbFN0YXRlLmhlaWdodCA9PT0gbnVsbCkge1xuICAgIHBhbmVsU3RhdGUgPSB7IC4uLnBhbmVsU3RhdGUsIHdpZHRoOiByZWN0LndpZHRoLCBoZWlnaHQ6IHJlY3QuaGVpZ2h0IH07XG4gIH1cbiAgaWYgKHJvb3QpIHtcbiAgICBhcHBseUdvYWxQYW5lbFNpemUocm9vdCk7XG4gICAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseUdvYWxQYW5lbFNpemUoZWxlbWVudDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgaWYgKHBhbmVsU3RhdGUuY29sbGFwc2VkKSB7XG4gICAgZWxlbWVudC5zdHlsZS53aWR0aCA9IFwiXCI7XG4gICAgZWxlbWVudC5zdHlsZS5oZWlnaHQgPSBcIlwiO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChwYW5lbFN0YXRlLndpZHRoID09PSBudWxsKSB7XG4gICAgZWxlbWVudC5zdHlsZS53aWR0aCA9IFwiXCI7XG4gIH0gZWxzZSB7XG4gICAgZWxlbWVudC5zdHlsZS53aWR0aCA9IGAke2NsYW1wKHBhbmVsU3RhdGUud2lkdGgsIEdPQUxfUEFORUxfTUlOX1dJRFRILCBnb2FsUGFuZWxNYXhXaWR0aCgpKX1weGA7XG4gIH1cblxuICBpZiAocGFuZWxTdGF0ZS5oZWlnaHQgPT09IG51bGwpIHtcbiAgICBlbGVtZW50LnN0eWxlLmhlaWdodCA9IFwiXCI7XG4gIH0gZWxzZSB7XG4gICAgZWxlbWVudC5zdHlsZS5oZWlnaHQgPSBgJHtjbGFtcChwYW5lbFN0YXRlLmhlaWdodCwgR09BTF9QQU5FTF9NSU5fSEVJR0hULCBnb2FsUGFuZWxNYXhIZWlnaHQoKSl9cHhgO1xuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5R29hbFBhbmVsUG9zaXRpb24oZWxlbWVudDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgaWYgKHBhbmVsU3RhdGUueCA9PT0gbnVsbCB8fCBwYW5lbFN0YXRlLnkgPT09IG51bGwpIHtcbiAgICBlbGVtZW50LnN0eWxlLmxlZnQgPSBcImF1dG9cIjtcbiAgICBlbGVtZW50LnN0eWxlLnRvcCA9IFwiYXV0b1wiO1xuICAgIGVsZW1lbnQuc3R5bGUucmlnaHQgPSBcIjE4cHhcIjtcbiAgICBlbGVtZW50LnN0eWxlLmJvdHRvbSA9IFwiNzZweFwiO1xuICAgIHJldHVybjtcbiAgfVxuICBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQoZWxlbWVudCk7XG4gIGVsZW1lbnQuc3R5bGUucmlnaHQgPSBcImF1dG9cIjtcbiAgZWxlbWVudC5zdHlsZS5ib3R0b20gPSBcImF1dG9cIjtcbiAgZWxlbWVudC5zdHlsZS5sZWZ0ID0gYCR7cGFuZWxTdGF0ZS54fXB4YDtcbiAgZWxlbWVudC5zdHlsZS50b3AgPSBgJHtwYW5lbFN0YXRlLnl9cHhgO1xufVxuXG5mdW5jdGlvbiBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQoZWxlbWVudDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgaWYgKHBhbmVsU3RhdGUueCA9PT0gbnVsbCB8fCBwYW5lbFN0YXRlLnkgPT09IG51bGwpIHJldHVybjtcbiAgY29uc3QgcmVjdCA9IGVsZW1lbnQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIHBhbmVsU3RhdGUgPSB7XG4gICAgLi4ucGFuZWxTdGF0ZSxcbiAgICB4OiBjbGFtcChwYW5lbFN0YXRlLngsIEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOLCB3aW5kb3cuaW5uZXJXaWR0aCAtIHJlY3Qud2lkdGggLSBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTiksXG4gICAgeTogY2xhbXAocGFuZWxTdGF0ZS55LCBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTiwgd2luZG93LmlubmVySGVpZ2h0IC0gcmVjdC5oZWlnaHQgLSBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTiksXG4gIH07XG59XG5cbmZ1bmN0aW9uIGdvYWxQYW5lbE1heFdpZHRoKCk6IG51bWJlciB7XG4gIGNvbnN0IGxlZnQgPSBwYW5lbFN0YXRlLnggPz8gR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU47XG4gIHJldHVybiBNYXRoLm1heChHT0FMX1BBTkVMX01JTl9XSURUSCwgd2luZG93LmlubmVyV2lkdGggLSBsZWZ0IC0gR09BTF9QQU5FTF9WSUVXUE9SVF9NQVJHSU4pO1xufVxuXG5mdW5jdGlvbiBnb2FsUGFuZWxNYXhIZWlnaHQoKTogbnVtYmVyIHtcbiAgY29uc3QgdG9wID0gcGFuZWxTdGF0ZS55ID8/IEdPQUxfUEFORUxfVklFV1BPUlRfTUFSR0lOO1xuICByZXR1cm4gTWF0aC5tYXgoR09BTF9QQU5FTF9NSU5fSEVJR0hULCB3aW5kb3cuaW5uZXJIZWlnaHQgLSB0b3AgLSBHT0FMX1BBTkVMX1ZJRVdQT1JUX01BUkdJTik7XG59XG5cbmZ1bmN0aW9uIHJlYWRHb2FsUGFuZWxTdGF0ZSgpOiBHb2FsUGFuZWxTdGF0ZSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShHT0FMX1BBTkVMX1NUQVRFX0tFWSkgPz8gXCJ7fVwiKSBhcyBQYXJ0aWFsPEdvYWxQYW5lbFN0YXRlPjtcbiAgICByZXR1cm4ge1xuICAgICAgY29sbGFwc2VkOiBwYXJzZWQuY29sbGFwc2VkID09PSB0cnVlLFxuICAgICAgeDogdHlwZW9mIHBhcnNlZC54ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShwYXJzZWQueCkgPyBwYXJzZWQueCA6IG51bGwsXG4gICAgICB5OiB0eXBlb2YgcGFyc2VkLnkgPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKHBhcnNlZC55KSA/IHBhcnNlZC55IDogbnVsbCxcbiAgICAgIHdpZHRoOiB0eXBlb2YgcGFyc2VkLndpZHRoID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShwYXJzZWQud2lkdGgpID8gcGFyc2VkLndpZHRoIDogbnVsbCxcbiAgICAgIGhlaWdodDogdHlwZW9mIHBhcnNlZC5oZWlnaHQgPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKHBhcnNlZC5oZWlnaHQpID8gcGFyc2VkLmhlaWdodCA6IG51bGwsXG4gICAgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgY29sbGFwc2VkOiBmYWxzZSwgeDogbnVsbCwgeTogbnVsbCwgd2lkdGg6IG51bGwsIGhlaWdodDogbnVsbCB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVHb2FsUGFuZWxTdGF0ZSgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShHT0FMX1BBTkVMX1NUQVRFX0tFWSwgSlNPTi5zdHJpbmdpZnkocGFuZWxTdGF0ZSkpO1xuICB9IGNhdGNoIHt9XG59XG5cbmZ1bmN0aW9uIGNsYW1wKHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChtYXggPCBtaW4pIHJldHVybiBtaW47XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heCh2YWx1ZSwgbWluKSwgbWF4KTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlU3VnZ2VzdGlvblJvb3QoKTogSFRNTERpdkVsZW1lbnQgfCBudWxsIHtcbiAgaWYgKHN1Z2dlc3Rpb25Sb290Py5pc0Nvbm5lY3RlZCkgcmV0dXJuIHN1Z2dlc3Rpb25Sb290O1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5ib2R5IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKCFwYXJlbnQpIHJldHVybiBudWxsO1xuICBzdWdnZXN0aW9uUm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN1Z2dlc3Rpb25Sb290LmlkID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1yb290XCI7XG4gIHN1Z2dlc3Rpb25Sb290LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgcGFyZW50LmFwcGVuZENoaWxkKHN1Z2dlc3Rpb25Sb290KTtcbiAgcmV0dXJuIHN1Z2dlc3Rpb25Sb290O1xufVxuXG5mdW5jdGlvbiB1cGRhdGVHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQgfCBudWxsKTogdm9pZCB7XG4gIGlmICghZWRpdGFibGUpIHtcbiAgICBoaWRlR29hbFN1Z2dlc3Rpb24oKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc3VnZ2VzdGlvbiA9IHBhcnNlR29hbFN1Z2dlc3Rpb24oZWRpdGFibGUuZ2V0VGV4dCgpKTtcbiAgaWYgKCFzdWdnZXN0aW9uKSB7XG4gICAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJlbmRlckdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLCBzdWdnZXN0aW9uLnF1ZXJ5KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyR29hbFN1Z2dlc3Rpb24oZWRpdGFibGU6IEVkaXRhYmxlVGFyZ2V0LCBxdWVyeTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGVsID0gZW5zdXJlU3VnZ2VzdGlvblJvb3QoKTtcbiAgaWYgKCFlbCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gZWRpdGFibGUuZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbig0MjAsIE1hdGgubWF4KDI4MCwgcmVjdC53aWR0aCB8fCAzMjApKTtcbiAgY29uc3QgbGVmdCA9IE1hdGgubWF4KDEyLCBNYXRoLm1pbihyZWN0LmxlZnQsIHdpbmRvdy5pbm5lcldpZHRoIC0gd2lkdGggLSAxMikpO1xuICBjb25zdCB0b3AgPSBNYXRoLm1heCgxMiwgcmVjdC50b3AgLSA2Nik7XG5cbiAgZWwuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvblwiO1xuICBlbC5zdHlsZS5sZWZ0ID0gYCR7bGVmdH1weGA7XG4gIGVsLnN0eWxlLnRvcCA9IGAke3RvcH1weGA7XG4gIGVsLnN0eWxlLndpZHRoID0gYCR7d2lkdGh9cHhgO1xuXG4gIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBpdGVtLnR5cGUgPSBcImJ1dHRvblwiO1xuICBpdGVtLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbVwiO1xuICBpdGVtLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJHb2FsIGNvbW1hbmRcIik7XG4gIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlZG93blwiLCAoZXZlbnQpID0+IHtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGUpO1xuICB9KTtcblxuICBjb25zdCBjb21tYW5kID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbW1hbmQuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1jb21tYW5kXCI7XG4gIGNvbW1hbmQudGV4dENvbnRlbnQgPSBcIi9nb2FsXCI7XG4gIGlmIChxdWVyeSkge1xuICAgIGNvbW1hbmQuZGF0YXNldC5xdWVyeSA9IHF1ZXJ5O1xuICB9XG5cbiAgY29uc3QgZGV0YWlsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGRldGFpbC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWRldGFpbFwiO1xuICBkZXRhaWwudGV4dENvbnRlbnQgPSBcIlNldCwgdmlldywgcGF1c2UsIHJlc3VtZSwgY29tcGxldGUsIG9yIGNsZWFyIHRoaXMgdGhyZWFkIGdvYWxcIjtcblxuICBpdGVtLmFwcGVuZChjb21tYW5kLCBkZXRhaWwpO1xuICBlbC5hcHBlbmRDaGlsZChpdGVtKTtcbiAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQpOiB2b2lkIHtcbiAgZWRpdGFibGUuc2V0VGV4dChcIi9nb2FsIFwiKTtcbiAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG59XG5cbmZ1bmN0aW9uIGhpZGVHb2FsU3VnZ2VzdGlvbigpOiB2b2lkIHtcbiAgaWYgKHN1Z2dlc3Rpb25Sb290KSBzdWdnZXN0aW9uUm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxTdHlsZXMoKTogdm9pZCB7XG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNvZGV4cHAtZ29hbC1zdHlsZVwiKSkgcmV0dXJuO1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5oZWFkIHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKCFwYXJlbnQpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCAoKSA9PiBpbnN0YWxsU3R5bGVzKCksIHsgb25jZTogdHJ1ZSB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcbiAgc3R5bGUuaWQgPSBcImNvZGV4cHAtZ29hbC1zdHlsZVwiO1xuICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiNjb2RleHBwLWdvYWwtcm9vdCB7XG4gIHBvc2l0aW9uOiBmaXhlZDtcbiAgcmlnaHQ6IDE4cHg7XG4gIGJvdHRvbTogNzZweDtcbiAgei1pbmRleDogMjE0NzQ4MzY0NztcbiAgd2lkdGg6IG1pbig0MjBweCwgY2FsYygxMDB2dyAtIDM2cHgpKTtcbiAgbWF4LXdpZHRoOiBjYWxjKDEwMHZ3IC0gMTZweCk7XG4gIG1heC1oZWlnaHQ6IGNhbGMoMTAwdmggLSAxNnB4KTtcbiAgZm9udDogMTNweC8xLjQgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBcIlNlZ29lIFVJXCIsIHNhbnMtc2VyaWY7XG4gIGNvbG9yOiB2YXIoLS10ZXh0LXByaW1hcnksICNmNWY3ZmIpO1xufVxuI2NvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLXJvb3Qge1xuICBwb3NpdGlvbjogZml4ZWQ7XG4gIHotaW5kZXg6IDIxNDc0ODM2NDc7XG4gIGZvbnQ6IDEzcHgvMS4zNSAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIFwiU2Vnb2UgVUlcIiwgc2Fucy1zZXJpZjtcbiAgY29sb3I6IHZhcigtLXRleHQtcHJpbWFyeSwgI2Y1ZjdmYik7XG59XG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24ge1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xuICBib3JkZXItcmFkaXVzOiA4cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjQsIDI3LCAzMywgMC45OCk7XG4gIGJveC1zaGFkb3c6IDAgMTZweCA0NnB4IHJnYmEoMCwwLDAsMC4zMik7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIGJhY2tkcm9wLWZpbHRlcjogYmx1cigxNHB4KTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1pdGVtIHtcbiAgd2lkdGg6IDEwMCU7XG4gIGJvcmRlcjogMDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBkaXNwbGF5OiBncmlkO1xuICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IGF1dG8gMWZyO1xuICBnYXA6IDEycHg7XG4gIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gIHBhZGRpbmc6IDEwcHggMTJweDtcbiAgdGV4dC1hbGlnbjogbGVmdDtcbiAgY3Vyc29yOiBwb2ludGVyO1xufVxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWl0ZW06aG92ZXIsXG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbTpmb2N1cy12aXNpYmxlIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjA5KTtcbiAgb3V0bGluZTogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1jb21tYW5kIHtcbiAgZm9udC1mYW1pbHk6IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIFwiU0YgTW9ub1wiLCBNZW5sbywgbW9ub3NwYWNlO1xuICBmb250LXdlaWdodDogNjUwO1xuICBjb2xvcjogIzlmYzVmZjtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1kZXRhaWwge1xuICBtaW4td2lkdGg6IDA7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjcyKTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwge1xuICBib3gtc2l6aW5nOiBib3JkZXItYm94O1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICBwb3NpdGlvbjogZml4ZWQ7XG4gIGJvcmRlcjogMXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsMC4xNik7XG4gIGJvcmRlci1yYWRpdXM6IDhweDtcbiAgYmFja2dyb3VuZDogcmdiYSgyNiwgMjksIDM1LCAwLjk2KTtcbiAgYm94LXNoYWRvdzogMCAxOHB4IDYwcHggcmdiYSgwLDAsMCwwLjM0KTtcbiAgcGFkZGluZzogMTJweDtcbiAgYmFja2Ryb3AtZmlsdGVyOiBibHVyKDE0cHgpO1xuICBvdmVyZmxvdzogaGlkZGVuO1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbDpub3QoLmlzLWNvbGxhcHNlZCkge1xuICBtaW4td2lkdGg6IDI4MHB4O1xuICBtaW4taGVpZ2h0OiAxNjBweDtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtZHJhZ2dpbmcge1xuICBjdXJzb3I6IGdyYWJiaW5nO1xuICB1c2VyLXNlbGVjdDogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtcmVzaXppbmcge1xuICBjdXJzb3I6IG53c2UtcmVzaXplO1xuICB1c2VyLXNlbGVjdDogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtY29sbGFwc2VkIHtcbiAgd2lkdGg6IG1pbigzMjBweCwgY2FsYygxMDB2dyAtIDM2cHgpKTtcbiAgbWluLWhlaWdodDogMDtcbiAgcGFkZGluZzogMTBweCAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbC5pcy1lcnJvciB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsIDEyMiwgMTIyLCAwLjU1KTtcbn1cbi5jb2RleHBwLWdvYWwtaGVhZGVyIHtcbiAgZGlzcGxheTogZmxleDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuICBnYXA6IDEycHg7XG4gIGZvbnQtd2VpZ2h0OiA2NTA7XG4gIGN1cnNvcjogZ3JhYjtcbiAgdXNlci1zZWxlY3Q6IG5vbmU7XG59XG4uY29kZXhwcC1nb2FsLXRpdGxlIHtcbiAgbWluLXdpZHRoOiAwO1xuICBvdmVyZmxvdzogaGlkZGVuO1xuICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbn1cbi5jb2RleHBwLWdvYWwtY29udHJvbHMge1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LXNocmluazogMDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgZ2FwOiA0cHg7XG59XG4uY29kZXhwcC1nb2FsLWljb24ge1xuICB3aWR0aDogMjRweDtcbiAgaGVpZ2h0OiAyNHB4O1xuICBib3JkZXI6IDA7XG4gIGJvcmRlci1yYWRpdXM6IDZweDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBjdXJzb3I6IHBvaW50ZXI7XG4gIGxpbmUtaGVpZ2h0OiAxO1xufVxuLmNvZGV4cHAtZ29hbC1pY29uOmhvdmVyIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjEpO1xufVxuLmNvZGV4cHAtZ29hbC1kZXRhaWwge1xuICBtYXJnaW4tdG9wOiA4cHg7XG4gIGZsZXg6IDEgMSBhdXRvO1xuICBtaW4taGVpZ2h0OiAwO1xuICBtYXgtaGVpZ2h0OiA5NnB4O1xuICBvdmVyZmxvdzogYXV0bztcbiAgY29sb3I6IHJnYmEoMjQ1LDI0NywyNTEsMC45KTtcbiAgd29yZC1icmVhazogYnJlYWstd29yZDtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWxbc3R5bGUqPVwiaGVpZ2h0XCJdIC5jb2RleHBwLWdvYWwtZGV0YWlsIHtcbiAgbWF4LWhlaWdodDogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtZm9vdGVyIHtcbiAgZmxleDogMCAwIGF1dG87XG4gIG1hcmdpbi10b3A6IDhweDtcbiAgY29sb3I6IHJnYmEoMjQ1LDI0NywyNTEsMC42Mik7XG4gIGZvbnQtc2l6ZTogMTJweDtcbn1cbi5jb2RleHBwLWdvYWwtYWN0aW9ucyB7XG4gIGZsZXg6IDAgMCBhdXRvO1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LXdyYXA6IHdyYXA7XG4gIGdhcDogOHB4O1xuICBtYXJnaW4tdG9wOiAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24ge1xuICBtaW4taGVpZ2h0OiAyOHB4O1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xuICBib3JkZXItcmFkaXVzOiA3cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4wOCk7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBwYWRkaW5nOiA0cHggMTBweDtcbiAgY3Vyc29yOiBwb2ludGVyO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb246aG92ZXIge1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24ucHJpbWFyeSB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgxMjUsIDE4MCwgMjU1LCAwLjU1KTtcbiAgYmFja2dyb3VuZDogcmdiYSg3NCwgMTIxLCAyMTYsIDAuNDIpO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24uZGFuZ2VyIHtcbiAgYm9yZGVyLWNvbG9yOiByZ2JhKDI1NSwgMTIyLCAxMjIsIDAuNDgpO1xufVxuLmNvZGV4cHAtZ29hbC1yZXNpemUge1xuICBwb3NpdGlvbjogYWJzb2x1dGU7XG4gIHJpZ2h0OiAycHg7XG4gIGJvdHRvbTogMnB4O1xuICB3aWR0aDogMThweDtcbiAgaGVpZ2h0OiAxOHB4O1xuICBib3JkZXI6IDA7XG4gIGJvcmRlci1yYWRpdXM6IDRweDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGN1cnNvcjogbndzZS1yZXNpemU7XG4gIG9wYWNpdHk6IDAuNzI7XG59XG4uY29kZXhwcC1nb2FsLXJlc2l6ZTo6YmVmb3JlIHtcbiAgY29udGVudDogXCJcIjtcbiAgcG9zaXRpb246IGFic29sdXRlO1xuICByaWdodDogNHB4O1xuICBib3R0b206IDRweDtcbiAgd2lkdGg6IDhweDtcbiAgaGVpZ2h0OiA4cHg7XG4gIGJvcmRlci1yaWdodDogMXB4IHNvbGlkIHJnYmEoMjQ1LDI0NywyNTEsMC43KTtcbiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkIHJnYmEoMjQ1LDI0NywyNTEsMC43KTtcbn1cbi5jb2RleHBwLWdvYWwtcmVzaXplOmhvdmVyLFxuLmNvZGV4cHAtZ29hbC1yZXNpemU6Zm9jdXMtdmlzaWJsZSB7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4wOCk7XG4gIG9wYWNpdHk6IDE7XG4gIG91dGxpbmU6IG5vbmU7XG59XG5gO1xuICBwYXJlbnQuYXBwZW5kQ2hpbGQoc3R5bGUpO1xufVxuXG5mdW5jdGlvbiBmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQ6IEV2ZW50KTogRWRpdGFibGVUYXJnZXQgfCBudWxsIHtcbiAgY29uc3QgcGF0aCA9IHR5cGVvZiBldmVudC5jb21wb3NlZFBhdGggPT09IFwiZnVuY3Rpb25cIiA/IGV2ZW50LmNvbXBvc2VkUGF0aCgpIDogW107XG4gIGZvciAoY29uc3QgaXRlbSBvZiBwYXRoKSB7XG4gICAgaWYgKCEoaXRlbSBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSkgY29udGludWU7XG4gICAgY29uc3QgZWRpdGFibGUgPSBlZGl0YWJsZUZvckVsZW1lbnQoaXRlbSk7XG4gICAgaWYgKGVkaXRhYmxlKSByZXR1cm4gZWRpdGFibGU7XG4gIH1cbiAgcmV0dXJuIGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50ID8gZWRpdGFibGVGb3JFbGVtZW50KGV2ZW50LnRhcmdldCkgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBlZGl0YWJsZUZvckVsZW1lbnQoZWxlbWVudDogSFRNTEVsZW1lbnQpOiBFZGl0YWJsZVRhcmdldCB8IG51bGwge1xuICBpZiAoZWxlbWVudCBpbnN0YW5jZW9mIEhUTUxUZXh0QXJlYUVsZW1lbnQgfHwgZWxlbWVudCBpbnN0YW5jZW9mIEhUTUxJbnB1dEVsZW1lbnQpIHtcbiAgICBjb25zdCB0eXBlID0gZWxlbWVudCBpbnN0YW5jZW9mIEhUTUxJbnB1dEVsZW1lbnQgPyBlbGVtZW50LnR5cGUgOiBcInRleHRhcmVhXCI7XG4gICAgaWYgKCFbXCJ0ZXh0XCIsIFwic2VhcmNoXCIsIFwidGV4dGFyZWFcIl0uaW5jbHVkZXModHlwZSkpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB7XG4gICAgICBlbGVtZW50LFxuICAgICAgZ2V0VGV4dDogKCkgPT4gZWxlbWVudC52YWx1ZSxcbiAgICAgIHNldFRleHQ6ICh2YWx1ZSkgPT4ge1xuICAgICAgICBlbGVtZW50LnZhbHVlID0gdmFsdWU7XG4gICAgICAgIGVsZW1lbnQuZm9jdXMoKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBlbGVtZW50LnNldFNlbGVjdGlvblJhbmdlKHZhbHVlLmxlbmd0aCwgdmFsdWUubGVuZ3RoKTtcbiAgICAgICAgfSBjYXRjaCB7fVxuICAgICAgICBlbGVtZW50LmRpc3BhdGNoRXZlbnQobmV3IElucHV0RXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUsIGlucHV0VHlwZTogXCJpbnNlcnRUZXh0XCIsIGRhdGE6IHZhbHVlIH0pKTtcbiAgICAgIH0sXG4gICAgICBjbGVhcjogKCkgPT4ge1xuICAgICAgICBlbGVtZW50LnZhbHVlID0gXCJcIjtcbiAgICAgICAgZWxlbWVudC5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiZGVsZXRlQ29udGVudEJhY2t3YXJkXCIgfSkpO1xuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgZWRpdGFibGUgPSBlbGVtZW50LmlzQ29udGVudEVkaXRhYmxlXG4gICAgPyBlbGVtZW50XG4gICAgOiBlbGVtZW50LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KCdbY29udGVudGVkaXRhYmxlPVwidHJ1ZVwiXSwgW3JvbGU9XCJ0ZXh0Ym94XCJdJyk7XG4gIGlmICghZWRpdGFibGUpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIGVsZW1lbnQ6IGVkaXRhYmxlLFxuICAgIGdldFRleHQ6ICgpID0+IGVkaXRhYmxlLmlubmVyVGV4dCB8fCBlZGl0YWJsZS50ZXh0Q29udGVudCB8fCBcIlwiLFxuICAgIHNldFRleHQ6ICh2YWx1ZSkgPT4ge1xuICAgICAgZWRpdGFibGUudGV4dENvbnRlbnQgPSB2YWx1ZTtcbiAgICAgIGVkaXRhYmxlLmZvY3VzKCk7XG4gICAgICBwbGFjZUNhcmV0QXRFbmQoZWRpdGFibGUpO1xuICAgICAgZWRpdGFibGUuZGlzcGF0Y2hFdmVudChuZXcgSW5wdXRFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSwgaW5wdXRUeXBlOiBcImluc2VydFRleHRcIiwgZGF0YTogdmFsdWUgfSkpO1xuICAgIH0sXG4gICAgY2xlYXI6ICgpID0+IHtcbiAgICAgIGVkaXRhYmxlLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGVkaXRhYmxlLmRpc3BhdGNoRXZlbnQobmV3IElucHV0RXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUsIGlucHV0VHlwZTogXCJkZWxldGVDb250ZW50QmFja3dhcmRcIiB9KSk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcGxhY2VDYXJldEF0RW5kKGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHNlbGVjdGlvbiA9IHdpbmRvdy5nZXRTZWxlY3Rpb24oKTtcbiAgaWYgKCFzZWxlY3Rpb24pIHJldHVybjtcbiAgY29uc3QgcmFuZ2UgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpO1xuICByYW5nZS5zZWxlY3ROb2RlQ29udGVudHMoZWxlbWVudCk7XG4gIHJhbmdlLmNvbGxhcHNlKGZhbHNlKTtcbiAgc2VsZWN0aW9uLnJlbW92ZUFsbFJhbmdlcygpO1xuICBzZWxlY3Rpb24uYWRkUmFuZ2UocmFuZ2UpO1xufVxuXG5mdW5jdGlvbiByZWFkVGhyZWFkSWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW2xvY2F0aW9uLnBhdGhuYW1lLCBsb2NhdGlvbi5oYXNoLCBsb2NhdGlvbi5ocmVmXTtcbiAgdHJ5IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuICAgIGNvbnN0IGluaXRpYWxSb3V0ZSA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiaW5pdGlhbFJvdXRlXCIpO1xuICAgIGlmIChpbml0aWFsUm91dGUpIGNhbmRpZGF0ZXMucHVzaChpbml0aWFsUm91dGUpO1xuICB9IGNhdGNoIHt9XG4gIGNhbmRpZGF0ZXMucHVzaCguLi5jb2xsZWN0VGhyZWFkUm91dGVDYW5kaWRhdGVzKGhpc3Rvcnkuc3RhdGUpKTtcbiAgY2FuZGlkYXRlcy5wdXNoKC4uLmNvbGxlY3REb21UaHJlYWRDYW5kaWRhdGVzKCkpO1xuXG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBjb25zdCB0aHJlYWRJZCA9IG5vcm1hbGl6ZVRocmVhZElkKGNhbmRpZGF0ZSk7XG4gICAgaWYgKHRocmVhZElkKSByZXR1cm4gdGhyZWFkSWQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVRocmVhZElkKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgZGVjb2RlZCA9IHNhZmVEZWNvZGUodmFsdWUpLnRyaW0oKTtcbiAgY29uc3Qgcm91dGVNYXRjaCA9IGRlY29kZWQubWF0Y2goL1xcL2xvY2FsXFwvKFteLz8jXFxzXSspLyk7XG4gIGlmIChyb3V0ZU1hdGNoPy5bMV0pIHtcbiAgICBjb25zdCBmcm9tUm91dGUgPSBub3JtYWxpemVUaHJlYWRJZFRva2VuKHJvdXRlTWF0Y2hbMV0pO1xuICAgIGlmIChmcm9tUm91dGUpIHJldHVybiBmcm9tUm91dGU7XG4gIH1cblxuICBjb25zdCB0b2tlbk1hdGNoID0gZGVjb2RlZC5tYXRjaCgvXFxiKD86W2Etel1bXFx3Li1dKjopKihbMC05YS1mXXs4fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXsxMn0pXFxiL2kpO1xuICBpZiAodG9rZW5NYXRjaD8uWzFdKSByZXR1cm4gdG9rZW5NYXRjaFsxXTtcblxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplVGhyZWFkSWRUb2tlbih2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGRlY29kZWQgPSBzYWZlRGVjb2RlKHZhbHVlKS50cmltKCk7XG4gIGNvbnN0IG1hdGNoID0gZGVjb2RlZC5tYXRjaCgvKD86Xnw6KShbMC05YS1mXXs4fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXs0fS1bMC05YS1mXXsxMn0pJC9pKTtcbiAgcmV0dXJuIG1hdGNoPy5bMV0gPz8gbnVsbDtcbn1cblxuZnVuY3Rpb24gY29sbGVjdERvbVRocmVhZENhbmRpZGF0ZXMoKTogc3RyaW5nW10ge1xuICBjb25zdCBzZWxlY3RvcnMgPSBbXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtcm93XVtkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtYWN0aXZlPVwidHJ1ZVwiXVtkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRdJyxcbiAgICAnW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1yb3ddW2FyaWEtY3VycmVudD1cInBhZ2VcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtYWN0aXZlPVwidHJ1ZVwiXVtkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRdJyxcbiAgICAnW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1pZF1bYXJpYS1jdXJyZW50PVwicGFnZVwiXScsXG4gIF07XG4gIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3Qgc2VsZWN0b3Igb2Ygc2VsZWN0b3JzKSB7XG4gICAgZm9yIChjb25zdCBlbGVtZW50IG9mIEFycmF5LmZyb20oZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oc2VsZWN0b3IpKSkge1xuICAgICAgY29uc3QgdmFsdWUgPSBlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1pZFwiKTtcbiAgICAgIGlmICh2YWx1ZSkgY2FuZGlkYXRlcy5wdXNoKHZhbHVlKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNhbmRpZGF0ZXM7XG59XG5cbmZ1bmN0aW9uIHNhZmVEZWNvZGUodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGRlY29kZVVSSUNvbXBvbmVudCh2YWx1ZSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB2YWx1ZTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb2xsZWN0VGhyZWFkUm91dGVDYW5kaWRhdGVzKHZhbHVlOiB1bmtub3duLCBkZXB0aCA9IDAsIHNlZW4gPSBuZXcgU2V0PHVua25vd24+KCkpOiBzdHJpbmdbXSB7XG4gIGlmIChkZXB0aCA+IDUgfHwgdmFsdWUgPT09IG51bGwgfHwgdmFsdWUgPT09IHVuZGVmaW5lZCB8fCBzZWVuLmhhcyh2YWx1ZSkpIHJldHVybiBbXTtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIG5vcm1hbGl6ZVRocmVhZElkKHZhbHVlKSA/IFt2YWx1ZV0gOiBbXTtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIFtdO1xuICBzZWVuLmFkZCh2YWx1ZSk7XG5cbiAgY29uc3QgY2FuZGlkYXRlczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBjaGlsZCBvZiBPYmplY3QudmFsdWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgIGNhbmRpZGF0ZXMucHVzaCguLi5jb2xsZWN0VGhyZWFkUm91dGVDYW5kaWRhdGVzKGNoaWxkLCBkZXB0aCArIDEsIHNlZW4pKTtcbiAgfVxuICByZXR1cm4gY2FuZGlkYXRlcztcbn1cblxuZnVuY3Rpb24gZ29hbFN0YXR1c0xhYmVsKHN0YXR1czogR29hbFN0YXR1cyk6IHN0cmluZyB7XG4gIHN3aXRjaCAoc3RhdHVzKSB7XG4gICAgY2FzZSBcImFjdGl2ZVwiOlxuICAgICAgcmV0dXJuIFwiYWN0aXZlXCI7XG4gICAgY2FzZSBcInBhdXNlZFwiOlxuICAgICAgcmV0dXJuIFwicGF1c2VkXCI7XG4gICAgY2FzZSBcImJ1ZGdldExpbWl0ZWRcIjpcbiAgICAgIHJldHVybiBcImxpbWl0ZWQgYnkgYnVkZ2V0XCI7XG4gICAgY2FzZSBcImNvbXBsZXRlXCI6XG4gICAgICByZXR1cm4gXCJjb21wbGV0ZVwiO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZyaWVuZGx5R29hbEVycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgY29uc3QgbWVzc2FnZSA9IHN0cmluZ2lmeUVycm9yKGVycm9yKTtcbiAgaWYgKC9nb2FscyBmZWF0dXJlIGlzIGRpc2FibGVkL2kudGVzdChtZXNzYWdlKSkge1xuICAgIHJldHVybiBcIlRoZSBhcHAtc2VydmVyIGhhcyBnb2FsIHN1cHBvcnQsIGJ1dCBbZmVhdHVyZXNdLmdvYWxzIGlzIGRpc2FibGVkIGluIH4vLmNvZGV4L2NvbmZpZy50b21sLlwiO1xuICB9XG4gIGlmICgvcmVxdWlyZXMgZXhwZXJpbWVudGFsQXBpL2kudGVzdChtZXNzYWdlKSkge1xuICAgIHJldHVybiBcIlRoZSBhcHAtc2VydmVyIHJlamVjdGVkIHRocmVhZC9nb2FsLyogYmVjYXVzZSB0aGUgYWN0aXZlIERlc2t0b3AgY2xpZW50IGRpZCBub3QgbmVnb3RpYXRlIGV4cGVyaW1lbnRhbEFwaS5cIjtcbiAgfVxuICBpZiAoL3Vua25vd258dW5zdXBwb3J0ZWR8bm90IGZvdW5kfG5vIGhhbmRsZXJ8aW52YWxpZCByZXF1ZXN0fGRlc2VyaWFsaXplfHRocmVhZFxcL2dvYWwvaS50ZXN0KG1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIFwiVGhpcyBDb2RleC5hcHAgYXBwLXNlcnZlciBkb2VzIG5vdCBzdXBwb3J0IHRocmVhZC9nb2FsLyogeWV0LiBVcGRhdGUgb3IgcmVwYXRjaCBDb2RleC5hcHAgd2l0aCBhIGJ1aWxkIHRoYXQgaW5jbHVkZXMgdGhlIGdvYWxzIGZlYXR1cmUuXCI7XG4gIH1cbiAgcmV0dXJuIG1lc3NhZ2U7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdER1cmF0aW9uKHNlY29uZHM6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHNlY29uZHMpIHx8IHNlY29uZHMgPD0gMCkgcmV0dXJuIFwiMHNcIjtcbiAgY29uc3QgbWludXRlcyA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDYwKTtcbiAgY29uc3QgcmVtYWluaW5nU2Vjb25kcyA9IE1hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKTtcbiAgaWYgKG1pbnV0ZXMgPD0gMCkgcmV0dXJuIGAke3JlbWFpbmluZ1NlY29uZHN9c2A7XG4gIGNvbnN0IGhvdXJzID0gTWF0aC5mbG9vcihtaW51dGVzIC8gNjApO1xuICBjb25zdCByZW1haW5pbmdNaW51dGVzID0gbWludXRlcyAlIDYwO1xuICBpZiAoaG91cnMgPD0gMCkgcmV0dXJuIGAke21pbnV0ZXN9bSAke3JlbWFpbmluZ1NlY29uZHN9c2A7XG4gIHJldHVybiBgJHtob3Vyc31oICR7cmVtYWluaW5nTWludXRlc31tYDtcbn1cblxuZnVuY3Rpb24gZm9ybWF0TnVtYmVyKHZhbHVlOiBudW1iZXIpOiBzdHJpbmcge1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IE1hdGgucm91bmQodmFsdWUpLnRvTG9jYWxlU3RyaW5nKCkgOiBcIjBcIjtcbn1cblxuZnVuY3Rpb24gdHJ1bmNhdGUodmFsdWU6IHN0cmluZywgbWF4TGVuZ3RoOiBudW1iZXIpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUubGVuZ3RoIDw9IG1heExlbmd0aCA/IHZhbHVlIDogYCR7dmFsdWUuc2xpY2UoMCwgbWF4TGVuZ3RoIC0gMSl9Li4uYDtcbn1cblxuZnVuY3Rpb24gc3RyaW5naWZ5RXJyb3IoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xufVxuXG5mdW5jdGlvbiBpc1RocmVhZEdvYWwodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBUaHJlYWRHb2FsIHtcbiAgcmV0dXJuIGlzUmVjb3JkKHZhbHVlKSAmJlxuICAgIHR5cGVvZiB2YWx1ZS50aHJlYWRJZCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgIHR5cGVvZiB2YWx1ZS5vYmplY3RpdmUgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgdmFsdWUuc3RhdHVzID09PSBcInN0cmluZ1wiO1xufVxuXG5mdW5jdGlvbiBpc1JlY29yZCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHZhbHVlICE9PSBudWxsICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG4iLCAiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB0eXBlIHtcbiAgR2l0RGlmZlN1bW1hcnksXG4gIEdpdFN0YXR1cyxcbiAgR2l0U3RhdHVzRW50cnksXG4gIEdpdFdvcmt0cmVlLFxufSBmcm9tIFwiQGNvZGV4LXBsdXNwbHVzL3Nka1wiO1xuXG5jb25zdCBQUk9KRUNUX1JPV19TRUxFQ1RPUiA9XG4gIFwiW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3Qtcm93XVtkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWlkXVwiO1xuY29uc3QgQUNUSVZFX1RIUkVBRF9TRUxFQ1RPUiA9XG4gIFwiW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1hY3RpdmU9J3RydWUnXSxbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT10cnVlXVwiO1xuY29uc3QgUFJPSkVDVF9MSVNUX1NFTEVDVE9SID0gXCJbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1saXN0LWlkXVwiO1xuY29uc3QgU1VNTUFSWV9BVFRSID0gXCJkYXRhLWNvZGV4cHAtZ2l0LXN1bW1hcnlcIjtcbmNvbnN0IEJBREdFX0FUVFIgPSBcImRhdGEtY29kZXhwcC1naXQtYmFkZ2VcIjtcbmNvbnN0IFNUWUxFX0lEID0gXCJjb2RleHBwLWdpdC1zaWRlYmFyLXN0eWxlXCI7XG5jb25zdCBSRUZSRVNIX0RFQk9VTkNFX01TID0gMjUwO1xuY29uc3QgU1RBVFVTX1RUTF9NUyA9IDEwXzAwMDtcbmNvbnN0IERFVEFJTFNfVFRMX01TID0gMTVfMDAwO1xuY29uc3QgTUFYX1ZJU0lCTEVfUFJPSkVDVF9CQURHRVMgPSAxNjtcbmNvbnN0IE1BWF9DSEFOR0VEX0ZJTEVTID0gNztcbmNvbnN0IE1BWF9XT1JLVFJFRV9ST1dTID0gMztcblxuaW50ZXJmYWNlIFByb2plY3RSb3cge1xuICByb3c6IEhUTUxFbGVtZW50O1xuICBncm91cDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBwYXRoOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBTdGF0dXNDYWNoZUVudHJ5IHtcbiAgdmFsdWU6IEdpdFN0YXR1cyB8IG51bGw7XG4gIGVycm9yOiBzdHJpbmcgfCBudWxsO1xuICBsb2FkZWRBdDogbnVtYmVyO1xuICBwZW5kaW5nOiBQcm9taXNlPEdpdFN0YXR1cyB8IG51bGw+IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIERldGFpbHNDYWNoZUVudHJ5IHtcbiAgdmFsdWU6IEdpdERldGFpbHMgfCBudWxsO1xuICBlcnJvcjogc3RyaW5nIHwgbnVsbDtcbiAgbG9hZGVkQXQ6IG51bWJlcjtcbiAgcGVuZGluZzogUHJvbWlzZTxHaXREZXRhaWxzIHwgbnVsbD4gfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgR2l0RGV0YWlscyB7XG4gIGRpZmY6IEdpdERpZmZTdW1tYXJ5O1xuICB3b3JrdHJlZXM6IEdpdFdvcmt0cmVlW107XG59XG5cbmludGVyZmFjZSBHaXRTaWRlYmFyU3RhdGUge1xuICBvYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGw7XG4gIHJlZnJlc2hUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsO1xuICBpbnRlcnZhbDogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0SW50ZXJ2YWw+IHwgbnVsbDtcbiAgcnVuSWQ6IG51bWJlcjtcbiAgc3RhdHVzQ2FjaGU6IE1hcDxzdHJpbmcsIFN0YXR1c0NhY2hlRW50cnk+O1xuICBkZXRhaWxzQ2FjaGU6IE1hcDxzdHJpbmcsIERldGFpbHNDYWNoZUVudHJ5Pjtcbn1cblxuY29uc3Qgc3RhdGU6IEdpdFNpZGViYXJTdGF0ZSA9IHtcbiAgb2JzZXJ2ZXI6IG51bGwsXG4gIHJlZnJlc2hUaW1lcjogbnVsbCxcbiAgaW50ZXJ2YWw6IG51bGwsXG4gIHJ1bklkOiAwLFxuICBzdGF0dXNDYWNoZTogbmV3IE1hcCgpLFxuICBkZXRhaWxzQ2FjaGU6IG5ldyBNYXAoKSxcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFydEdpdFNpZGViYXIoKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5vYnNlcnZlcikgcmV0dXJuO1xuXG4gIGluc3RhbGxTdHlsZXMoKTtcblxuICBjb25zdCBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKChtdXRhdGlvbnMpID0+IHtcbiAgICBpZiAobXV0YXRpb25zLnNvbWUoc2hvdWxkUmVhY3RUb011dGF0aW9uKSkge1xuICAgICAgc2NoZWR1bGVSZWZyZXNoKFwibXV0YXRpb25cIik7XG4gICAgfVxuICB9KTtcbiAgb2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHtcbiAgICBjaGlsZExpc3Q6IHRydWUsXG4gICAgc3VidHJlZTogdHJ1ZSxcbiAgICBhdHRyaWJ1dGVzOiB0cnVlLFxuICAgIGF0dHJpYnV0ZUZpbHRlcjogW1xuICAgICAgXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtYWN0aXZlXCIsXG4gICAgICBcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtY29sbGFwc2VkXCIsXG4gICAgICBcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtaWRcIixcbiAgICAgIFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1yb3dcIixcbiAgICBdLFxuICB9KTtcbiAgc3RhdGUub2JzZXJ2ZXIgPSBvYnNlcnZlcjtcbiAgc3RhdGUuaW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiBzY2hlZHVsZVJlZnJlc2goXCJpbnRlcnZhbFwiKSwgMTVfMDAwKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJmb2N1c1wiLCBvbldpbmRvd0ZvY3VzKTtcbiAgc2NoZWR1bGVSZWZyZXNoKFwiYm9vdFwiKTtcbn1cblxuZnVuY3Rpb24gb25XaW5kb3dGb2N1cygpOiB2b2lkIHtcbiAgc2NoZWR1bGVSZWZyZXNoKFwiZm9jdXNcIik7XG59XG5cbmZ1bmN0aW9uIHNob3VsZFJlYWN0VG9NdXRhdGlvbihtdXRhdGlvbjogTXV0YXRpb25SZWNvcmQpOiBib29sZWFuIHtcbiAgaWYgKG11dGF0aW9uLnR5cGUgPT09IFwiYXR0cmlidXRlc1wiKSB7XG4gICAgY29uc3QgdGFyZ2V0ID0gbXV0YXRpb24udGFyZ2V0O1xuICAgIHJldHVybiB0YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50ICYmIChcbiAgICAgIHRhcmdldC5tYXRjaGVzKFBST0pFQ1RfUk9XX1NFTEVDVE9SKSB8fFxuICAgICAgdGFyZ2V0Lm1hdGNoZXMoQUNUSVZFX1RIUkVBRF9TRUxFQ1RPUikgfHxcbiAgICAgIHRhcmdldC5oYXNBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWxpc3QtaWRcIilcbiAgICApO1xuICB9XG4gIGZvciAoY29uc3Qgbm9kZSBvZiBBcnJheS5mcm9tKG11dGF0aW9uLmFkZGVkTm9kZXMpKSB7XG4gICAgaWYgKG5vZGVDb250YWluc1NpZGViYXJQcm9qZWN0KG5vZGUpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICBmb3IgKGNvbnN0IG5vZGUgb2YgQXJyYXkuZnJvbShtdXRhdGlvbi5yZW1vdmVkTm9kZXMpKSB7XG4gICAgaWYgKG5vZGVDb250YWluc1NpZGViYXJQcm9qZWN0KG5vZGUpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIG5vZGVDb250YWluc1NpZGViYXJQcm9qZWN0KG5vZGU6IE5vZGUpOiBib29sZWFuIHtcbiAgaWYgKCEobm9kZSBpbnN0YW5jZW9mIEVsZW1lbnQpKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBub2RlLm1hdGNoZXMoUFJPSkVDVF9ST1dfU0VMRUNUT1IpIHx8IEJvb2xlYW4obm9kZS5xdWVyeVNlbGVjdG9yKFBST0pFQ1RfUk9XX1NFTEVDVE9SKSk7XG59XG5cbmZ1bmN0aW9uIHNjaGVkdWxlUmVmcmVzaChfcmVhc29uOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLnJlZnJlc2hUaW1lcikgY2xlYXJUaW1lb3V0KHN0YXRlLnJlZnJlc2hUaW1lcik7XG4gIHN0YXRlLnJlZnJlc2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN0YXRlLnJlZnJlc2hUaW1lciA9IG51bGw7XG4gICAgdm9pZCByZWZyZXNoKCk7XG4gIH0sIFJFRlJFU0hfREVCT1VOQ0VfTVMpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBydW5JZCA9ICsrc3RhdGUucnVuSWQ7XG4gIGNvbnN0IHByb2plY3RzID0gY29sbGVjdFByb2plY3RSb3dzKCk7XG4gIGlmIChwcm9qZWN0cy5sZW5ndGggPT09IDApIHtcbiAgICByZW1vdmVTdW1tYXJ5UGFuZWwoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBhY3RpdmVQYXRoID0gZ2V0QWN0aXZlUHJvamVjdFBhdGgocHJvamVjdHMpO1xuICBjb25zdCBhY3RpdmVQcm9qZWN0ID1cbiAgICAoYWN0aXZlUGF0aCA/IHByb2plY3RzLmZpbmQoKHByb2plY3QpID0+IHByb2plY3QucGF0aCA9PT0gYWN0aXZlUGF0aCkgOiBudWxsKSA/P1xuICAgIHByb2plY3RzLmZpbmQoKHByb2plY3QpID0+IHByb2plY3Qucm93LmdldEF0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtY29sbGFwc2VkXCIpID09PSBcImZhbHNlXCIpID8/XG4gICAgcHJvamVjdHNbMF07XG5cbiAgY29uc3QgYmFkZ2VQcm9qZWN0cyA9IHByaW9yaXRpemVCYWRnZVByb2plY3RzKHByb2plY3RzLCBhY3RpdmVQcm9qZWN0KTtcbiAgY29uc3QgYmFkZ2VTdGF0dXNlcyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgIGJhZGdlUHJvamVjdHMubWFwKGFzeW5jIChwcm9qZWN0KSA9PiB7XG4gICAgICBjb25zdCBzdGF0dXMgPSBhd2FpdCBnZXRTdGF0dXMocHJvamVjdC5wYXRoKTtcbiAgICAgIHJldHVybiB7IHByb2plY3QsIHN0YXR1cyB9O1xuICAgIH0pLFxuICApO1xuICBpZiAocnVuSWQgIT09IHN0YXRlLnJ1bklkKSByZXR1cm47XG4gIGZvciAoY29uc3QgeyBwcm9qZWN0LCBzdGF0dXMgfSBvZiBiYWRnZVN0YXR1c2VzKSB7XG4gICAgcmVuZGVyUHJvamVjdEJhZGdlKHByb2plY3QsIHN0YXR1cyk7XG4gIH1cblxuICBjb25zdCBzdW1tYXJ5UHJvamVjdCA9XG4gICAgYmFkZ2VTdGF0dXNlcy5maW5kKCh7IHByb2plY3QsIHN0YXR1cyB9KSA9PiBwcm9qZWN0LnBhdGggPT09IGFjdGl2ZVByb2plY3Q/LnBhdGggJiYgaXNVc2FibGVSZXBvKHN0YXR1cykpXG4gICAgICA/LnByb2plY3QgPz9cbiAgICBiYWRnZVN0YXR1c2VzLmZpbmQoKHsgc3RhdHVzIH0pID0+IGlzVXNhYmxlUmVwbyhzdGF0dXMpKT8ucHJvamVjdCA/P1xuICAgIGFjdGl2ZVByb2plY3Q7XG5cbiAgaWYgKCFzdW1tYXJ5UHJvamVjdCkge1xuICAgIHJlbW92ZVN1bW1hcnlQYW5lbCgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IFtzdGF0dXMsIGRldGFpbHNdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgIGdldFN0YXR1cyhzdW1tYXJ5UHJvamVjdC5wYXRoKSxcbiAgICBnZXREZXRhaWxzKHN1bW1hcnlQcm9qZWN0LnBhdGgpLFxuICBdKTtcbiAgaWYgKHJ1bklkICE9PSBzdGF0ZS5ydW5JZCkgcmV0dXJuO1xuICByZW5kZXJTdW1tYXJ5UGFuZWwoc3VtbWFyeVByb2plY3QsIHN0YXR1cywgZGV0YWlscyk7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3RQcm9qZWN0Um93cygpOiBQcm9qZWN0Um93W10ge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHJvd3M6IFByb2plY3RSb3dbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJvdyBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFBST0pFQ1RfUk9XX1NFTEVDVE9SKSkpIHtcbiAgICBjb25zdCBwYXRoID0gcm93LmdldEF0dHJpYnV0ZShcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtaWRcIik/LnRyaW0oKTtcbiAgICBpZiAoIXBhdGggfHwgc2Vlbi5oYXMocGF0aCkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHBhdGgpO1xuICAgIHJvd3MucHVzaCh7XG4gICAgICByb3csXG4gICAgICBwYXRoLFxuICAgICAgbGFiZWw6IHJvdy5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWxhYmVsXCIpPy50cmltKCkgfHwgYmFzZW5hbWUocGF0aCksXG4gICAgICBncm91cDogZmluZFByb2plY3RHcm91cChyb3cpLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiByb3dzO1xufVxuXG5mdW5jdGlvbiBmaW5kUHJvamVjdEdyb3VwKHJvdzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBsZXQgY3VycmVudDogSFRNTEVsZW1lbnQgfCBudWxsID0gcm93LnBhcmVudEVsZW1lbnQ7XG4gIHdoaWxlIChjdXJyZW50ICYmIGN1cnJlbnQgIT09IGRvY3VtZW50LmJvZHkpIHtcbiAgICBpZiAoY3VycmVudC5nZXRBdHRyaWJ1dGUoXCJyb2xlXCIpID09PSBcImxpc3RpdGVtXCIgJiYgY3VycmVudC50ZXh0Q29udGVudD8uaW5jbHVkZXMocm93LnRleHRDb250ZW50ID8/IFwiXCIpKSB7XG4gICAgICByZXR1cm4gY3VycmVudDtcbiAgICB9XG4gICAgaWYgKGN1cnJlbnQucXVlcnlTZWxlY3RvcihQUk9KRUNUX1JPV19TRUxFQ1RPUikgPT09IHJvdyAmJiBjdXJyZW50LnF1ZXJ5U2VsZWN0b3IoUFJPSkVDVF9MSVNUX1NFTEVDVE9SKSkge1xuICAgICAgcmV0dXJuIGN1cnJlbnQ7XG4gICAgfVxuICAgIGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudEVsZW1lbnQ7XG4gIH1cbiAgcmV0dXJuIHJvdy5wYXJlbnRFbGVtZW50O1xufVxuXG5mdW5jdGlvbiBnZXRBY3RpdmVQcm9qZWN0UGF0aChwcm9qZWN0czogUHJvamVjdFJvd1tdKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGFjdGl2ZVRocmVhZCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KEFDVElWRV9USFJFQURfU0VMRUNUT1IpO1xuICBjb25zdCBwcm9qZWN0TGlzdCA9IGFjdGl2ZVRocmVhZD8uY2xvc2VzdDxIVE1MRWxlbWVudD4oUFJPSkVDVF9MSVNUX1NFTEVDVE9SKTtcbiAgY29uc3QgbGlzdFBhdGggPSBwcm9qZWN0TGlzdD8uZ2V0QXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1saXN0LWlkXCIpPy50cmltKCk7XG4gIGlmIChsaXN0UGF0aCkgcmV0dXJuIGxpc3RQYXRoO1xuXG4gIGNvbnN0IGV4cGFuZGVkID0gcHJvamVjdHMuZmluZChcbiAgICAocHJvamVjdCkgPT4gcHJvamVjdC5yb3cuZ2V0QXR0cmlidXRlKFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1jb2xsYXBzZWRcIikgPT09IFwiZmFsc2VcIixcbiAgKTtcbiAgcmV0dXJuIGV4cGFuZGVkPy5wYXRoID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIHByaW9yaXRpemVCYWRnZVByb2plY3RzKHByb2plY3RzOiBQcm9qZWN0Um93W10sIGFjdGl2ZVByb2plY3Q6IFByb2plY3RSb3cgfCB1bmRlZmluZWQpOiBQcm9qZWN0Um93W10ge1xuICBjb25zdCB2aXNpYmxlID0gcHJvamVjdHMuZmlsdGVyKChwcm9qZWN0KSA9PiB7XG4gICAgY29uc3QgcmVjdCA9IHByb2plY3Qucm93LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIHJldHVybiByZWN0LndpZHRoID4gMCAmJiByZWN0LmhlaWdodCA+IDAgJiYgcmVjdC5ib3R0b20gPj0gMCAmJiByZWN0LnRvcCA8PSB3aW5kb3cuaW5uZXJIZWlnaHQ7XG4gIH0pO1xuICBjb25zdCBvcmRlcmVkID0gYWN0aXZlUHJvamVjdFxuICAgID8gW2FjdGl2ZVByb2plY3QsIC4uLnZpc2libGUuZmlsdGVyKChwcm9qZWN0KSA9PiBwcm9qZWN0LnBhdGggIT09IGFjdGl2ZVByb2plY3QucGF0aCldXG4gICAgOiB2aXNpYmxlO1xuICByZXR1cm4gb3JkZXJlZC5zbGljZSgwLCBNQVhfVklTSUJMRV9QUk9KRUNUX0JBREdFUyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldFN0YXR1cyhwYXRoOiBzdHJpbmcpOiBQcm9taXNlPEdpdFN0YXR1cyB8IG51bGw+IHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgY2FjaGVkID0gc3RhdGUuc3RhdHVzQ2FjaGUuZ2V0KHBhdGgpO1xuICBpZiAoY2FjaGVkPy52YWx1ZSAmJiBub3cgLSBjYWNoZWQubG9hZGVkQXQgPCBTVEFUVVNfVFRMX01TKSByZXR1cm4gY2FjaGVkLnZhbHVlO1xuICBpZiAoY2FjaGVkPy5wZW5kaW5nKSByZXR1cm4gY2FjaGVkLnBlbmRpbmc7XG5cbiAgY29uc3QgZW50cnk6IFN0YXR1c0NhY2hlRW50cnkgPSBjYWNoZWQgPz8ge1xuICAgIHZhbHVlOiBudWxsLFxuICAgIGVycm9yOiBudWxsLFxuICAgIGxvYWRlZEF0OiAwLFxuICAgIHBlbmRpbmc6IG51bGwsXG4gIH07XG4gIGVudHJ5LnBlbmRpbmcgPSBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdpdC1zdGF0dXNcIiwgcGF0aClcbiAgICAudGhlbigoc3RhdHVzKSA9PiB7XG4gICAgICBlbnRyeS52YWx1ZSA9IHN0YXR1cyBhcyBHaXRTdGF0dXM7XG4gICAgICBlbnRyeS5lcnJvciA9IG51bGw7XG4gICAgICBlbnRyeS5sb2FkZWRBdCA9IERhdGUubm93KCk7XG4gICAgICByZXR1cm4gZW50cnkudmFsdWU7XG4gICAgfSlcbiAgICAuY2F0Y2goKGVycm9yOiB1bmtub3duKSA9PiB7XG4gICAgICBlbnRyeS5lcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIGVudHJ5LmxvYWRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH0pXG4gICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgZW50cnkucGVuZGluZyA9IG51bGw7XG4gICAgfSk7XG4gIHN0YXRlLnN0YXR1c0NhY2hlLnNldChwYXRoLCBlbnRyeSk7XG4gIHJldHVybiBlbnRyeS5wZW5kaW5nO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXREZXRhaWxzKHBhdGg6IHN0cmluZyk6IFByb21pc2U8R2l0RGV0YWlscyB8IG51bGw+IHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgY2FjaGVkID0gc3RhdGUuZGV0YWlsc0NhY2hlLmdldChwYXRoKTtcbiAgaWYgKGNhY2hlZD8udmFsdWUgJiYgbm93IC0gY2FjaGVkLmxvYWRlZEF0IDwgREVUQUlMU19UVExfTVMpIHJldHVybiBjYWNoZWQudmFsdWU7XG4gIGlmIChjYWNoZWQ/LnBlbmRpbmcpIHJldHVybiBjYWNoZWQucGVuZGluZztcblxuICBjb25zdCBlbnRyeTogRGV0YWlsc0NhY2hlRW50cnkgPSBjYWNoZWQgPz8ge1xuICAgIHZhbHVlOiBudWxsLFxuICAgIGVycm9yOiBudWxsLFxuICAgIGxvYWRlZEF0OiAwLFxuICAgIHBlbmRpbmc6IG51bGwsXG4gIH07XG4gIGVudHJ5LnBlbmRpbmcgPSBQcm9taXNlLmFsbChbXG4gICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnaXQtZGlmZi1zdW1tYXJ5XCIsIHBhdGgpIGFzIFByb21pc2U8R2l0RGlmZlN1bW1hcnk+LFxuICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2l0LXdvcmt0cmVlc1wiLCBwYXRoKSBhcyBQcm9taXNlPEdpdFdvcmt0cmVlW10+LFxuICBdKVxuICAgIC50aGVuKChbZGlmZiwgd29ya3RyZWVzXSkgPT4ge1xuICAgICAgZW50cnkudmFsdWUgPSB7IGRpZmYsIHdvcmt0cmVlcyB9O1xuICAgICAgZW50cnkuZXJyb3IgPSBudWxsO1xuICAgICAgZW50cnkubG9hZGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgcmV0dXJuIGVudHJ5LnZhbHVlO1xuICAgIH0pXG4gICAgLmNhdGNoKChlcnJvcjogdW5rbm93bikgPT4ge1xuICAgICAgZW50cnkuZXJyb3IgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgICBlbnRyeS5sb2FkZWRBdCA9IERhdGUubm93KCk7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGVudHJ5LnBlbmRpbmcgPSBudWxsO1xuICAgIH0pO1xuICBzdGF0ZS5kZXRhaWxzQ2FjaGUuc2V0KHBhdGgsIGVudHJ5KTtcbiAgcmV0dXJuIGVudHJ5LnBlbmRpbmc7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclByb2plY3RCYWRnZShwcm9qZWN0OiBQcm9qZWN0Um93LCBzdGF0dXM6IEdpdFN0YXR1cyB8IG51bGwpOiB2b2lkIHtcbiAgaWYgKCFpc1VzYWJsZVJlcG8oc3RhdHVzKSkge1xuICAgIHByb2plY3Qucm93LnF1ZXJ5U2VsZWN0b3IoYFske0JBREdFX0FUVFJ9XWApPy5yZW1vdmUoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBiYWRnZSA9IGVuc3VyZUJhZGdlKHByb2plY3Qucm93KTtcbiAgY29uc3QgZGlydHkgPSBjb3VudERpcnR5KHN0YXR1cy5lbnRyaWVzKTtcbiAgY29uc3QgY29uZmxpY3RzID0gY291bnRDb25mbGljdHMoc3RhdHVzLmVudHJpZXMpO1xuICBjb25zdCBicmFuY2ggPSBicmFuY2hMYWJlbChzdGF0dXMpO1xuICBjb25zdCBzeW5jID0gc3luY0xhYmVsKHN0YXR1cyk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJjb2RleHBwLWdpdC1iYWRnZS1kaXJ0eVwiLCBkaXJ0eSA+IDApO1xuICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKFwiY29kZXhwcC1naXQtYmFkZ2UtY29uZmxpY3RcIiwgY29uZmxpY3RzID4gMCk7XG4gIGJhZGdlLnRpdGxlID0gW1xuICAgIGAke3Byb2plY3QubGFiZWx9OiAke2JyYW5jaH1gLFxuICAgIGRpcnR5ID09PSAwID8gXCJjbGVhblwiIDogYCR7ZGlydHl9IGNoYW5nZWRgLFxuICAgIGNvbmZsaWN0cyA+IDAgPyBgJHtjb25mbGljdHN9IGNvbmZsaWN0JHtwbHVyYWwoY29uZmxpY3RzKX1gIDogXCJcIixcbiAgICBzeW5jLnRpdGxlLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiLCBcIik7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gW2JyYW5jaCwgZGlydHkgPiAwID8gU3RyaW5nKGRpcnR5KSA6IFwiXCIsIHN5bmMuc2hvcnRdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlQmFkZ2Uocm93OiBIVE1MRWxlbWVudCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgZXhpc3RpbmcgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oYFske0JBREdFX0FUVFJ9XWApO1xuICBpZiAoZXhpc3RpbmcpIHJldHVybiBleGlzdGluZztcblxuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5zZXRBdHRyaWJ1dGUoQkFER0VfQVRUUiwgXCJcIik7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1naXQtcHJvamVjdC1iYWRnZVwiO1xuICByb3cuYXBwZW5kQ2hpbGQoYmFkZ2UpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclN1bW1hcnlQYW5lbChwcm9qZWN0OiBQcm9qZWN0Um93LCBzdGF0dXM6IEdpdFN0YXR1cyB8IG51bGwsIGRldGFpbHM6IEdpdERldGFpbHMgfCBudWxsKTogdm9pZCB7XG4gIGlmICghaXNVc2FibGVSZXBvKHN0YXR1cykpIHtcbiAgICByZW1vdmVTdW1tYXJ5UGFuZWwoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBob3N0ID0gcHJvamVjdC5ncm91cCA/PyBwcm9qZWN0LnJvdy5wYXJlbnRFbGVtZW50O1xuICBpZiAoIWhvc3QpIHJldHVybjtcblxuICBjb25zdCBwYW5lbCA9IGVuc3VyZVN1bW1hcnlQYW5lbChob3N0LCBwcm9qZWN0LnJvdyk7XG4gIGNsZWFyKHBhbmVsKTtcblxuICBjb25zdCBkaXJ0eSA9IGNvdW50RGlydHkoc3RhdHVzLmVudHJpZXMpO1xuICBjb25zdCBjb3VudHMgPSBjb3VudFN0YXR1cyhzdGF0dXMuZW50cmllcyk7XG4gIGNvbnN0IGJyYW5jaCA9IGJyYW5jaExhYmVsKHN0YXR1cyk7XG4gIGNvbnN0IHN5bmMgPSBzeW5jTGFiZWwoc3RhdHVzKTtcbiAgY29uc3QgZGlmZiA9IGRldGFpbHM/LmRpZmYgPz8gbnVsbDtcbiAgY29uc3Qgd29ya3RyZWVzID0gZGV0YWlscz8ud29ya3RyZWVzID8/IFtdO1xuXG4gIGNvbnN0IGhlYWRlciA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtc3VtbWFyeS1oZWFkZXJcIik7XG4gIGNvbnN0IHRpdGxlID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC1zdW1tYXJ5LXRpdGxlXCIpO1xuICB0aXRsZS5hcHBlbmQodGV4dEVsKFwic3BhblwiLCBcIkdpdFwiKSk7XG4gIHRpdGxlLmFwcGVuZCh0ZXh0RWwoXCJzdHJvbmdcIiwgYnJhbmNoKSk7XG4gIGlmIChzeW5jLnNob3J0KSB0aXRsZS5hcHBlbmQodGV4dEVsKFwic3BhblwiLCBzeW5jLnNob3J0KSk7XG4gIGNvbnN0IHN0YXRlQ2hpcCA9IHRleHRFbChcInNwYW5cIiwgZGlydHkgPT09IDAgPyBcImNsZWFuXCIgOiBgJHtkaXJ0eX0gY2hhbmdlZGApO1xuICBzdGF0ZUNoaXAuY2xhc3NOYW1lID0gYGNvZGV4cHAtZ2l0LXN1bW1hcnktc3RhdGUgJHtkaXJ0eSA9PT0gMCA/IFwiaXMtY2xlYW5cIiA6IFwiaXMtZGlydHlcIn1gO1xuICBoZWFkZXIuYXBwZW5kKHRpdGxlLCBzdGF0ZUNoaXApO1xuICBwYW5lbC5hcHBlbmQoaGVhZGVyKTtcblxuICBjb25zdCBtZXRyaWNzID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC1zdW1tYXJ5LW1ldHJpY3NcIik7XG4gIG1ldHJpY3MuYXBwZW5kKFxuICAgIG1ldHJpYyhcInN0YWdlZFwiLCBjb3VudHMuc3RhZ2VkKSxcbiAgICBtZXRyaWMoXCJ1bnN0YWdlZFwiLCBjb3VudHMudW5zdGFnZWQpLFxuICAgIG1ldHJpYyhcInVudHJhY2tlZFwiLCBjb3VudHMudW50cmFja2VkKSxcbiAgICBtZXRyaWMoXCJjb25mbGljdHNcIiwgY291bnRzLmNvbmZsaWN0cyksXG4gICk7XG4gIHBhbmVsLmFwcGVuZChtZXRyaWNzKTtcblxuICBpZiAoZGlmZikge1xuICAgIGNvbnN0IGRpZmZMaW5lID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC1zdW1tYXJ5LWxpbmVcIik7XG4gICAgZGlmZkxpbmUuYXBwZW5kKFxuICAgICAgdGV4dEVsKFwic3BhblwiLCBgJHtkaWZmLmZpbGVDb3VudH0gZmlsZSR7cGx1cmFsKGRpZmYuZmlsZUNvdW50KX1gKSxcbiAgICAgIHRleHRFbChcInNwYW5cIiwgYCske2RpZmYuaW5zZXJ0aW9uc31gKSxcbiAgICAgIHRleHRFbChcInNwYW5cIiwgYC0ke2RpZmYuZGVsZXRpb25zfWApLFxuICAgICAgLi4uKGRpZmYudHJ1bmNhdGVkID8gW3RleHRFbChcInNwYW5cIiwgXCJ0cnVuY2F0ZWRcIildIDogW10pLFxuICAgICk7XG4gICAgcGFuZWwuYXBwZW5kKGRpZmZMaW5lKTtcbiAgfVxuXG4gIGNvbnN0IGNoYW5nZWQgPSBzdGF0dXMuZW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS5raW5kICE9PSBcImlnbm9yZWRcIikuc2xpY2UoMCwgTUFYX0NIQU5HRURfRklMRVMpO1xuICBpZiAoY2hhbmdlZC5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgbGlzdCA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtY2hhbmdlZC1maWxlc1wiKTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGNoYW5nZWQpIHtcbiAgICAgIGNvbnN0IHJvdyA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtZmlsZS1yb3dcIik7XG4gICAgICByb3cuYXBwZW5kKHRleHRFbChcInNwYW5cIiwgZW50cnlMYWJlbChlbnRyeSkpLCB0ZXh0RWwoXCJzcGFuXCIsIGVudHJ5UGF0aChlbnRyeSkpKTtcbiAgICAgIGxpc3QuYXBwZW5kKHJvdyk7XG4gICAgfVxuICAgIGlmIChzdGF0dXMuZW50cmllcy5sZW5ndGggPiBjaGFuZ2VkLmxlbmd0aCkge1xuICAgICAgY29uc3QgbW9yZSA9IHRleHRFbChcImRpdlwiLCBgKyR7c3RhdHVzLmVudHJpZXMubGVuZ3RoIC0gY2hhbmdlZC5sZW5ndGh9IG1vcmVgKTtcbiAgICAgIG1vcmUuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdpdC1tb3JlXCI7XG4gICAgICBsaXN0LmFwcGVuZChtb3JlKTtcbiAgICB9XG4gICAgcGFuZWwuYXBwZW5kKGxpc3QpO1xuICB9XG5cbiAgaWYgKHdvcmt0cmVlcy5sZW5ndGggPiAxKSB7XG4gICAgY29uc3Qgd29ya3RyZWVMaXN0ID0gZWwoXCJkaXZcIiwgXCJjb2RleHBwLWdpdC13b3JrdHJlZXNcIik7XG4gICAgY29uc3QgbGFiZWwgPSB0ZXh0RWwoXCJkaXZcIiwgYCR7d29ya3RyZWVzLmxlbmd0aH0gd29ya3RyZWVzYCk7XG4gICAgbGFiZWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdpdC13b3JrdHJlZXMtbGFiZWxcIjtcbiAgICB3b3JrdHJlZUxpc3QuYXBwZW5kKGxhYmVsKTtcbiAgICBmb3IgKGNvbnN0IHdvcmt0cmVlIG9mIHdvcmt0cmVlcy5zbGljZSgwLCBNQVhfV09SS1RSRUVfUk9XUykpIHtcbiAgICAgIGNvbnN0IHJvdyA9IGVsKFwiZGl2XCIsIFwiY29kZXhwcC1naXQtd29ya3RyZWUtcm93XCIpO1xuICAgICAgcm93LmFwcGVuZChcbiAgICAgICAgdGV4dEVsKFwic3BhblwiLCB3b3JrdHJlZS5icmFuY2ggPz8gc2hvcnRTaGEod29ya3RyZWUuaGVhZCkgPz8gXCJkZXRhY2hlZFwiKSxcbiAgICAgICAgdGV4dEVsKFwic3BhblwiLCBiYXNlbmFtZSh3b3JrdHJlZS5wYXRoKSksXG4gICAgICApO1xuICAgICAgd29ya3RyZWVMaXN0LmFwcGVuZChyb3cpO1xuICAgIH1cbiAgICBwYW5lbC5hcHBlbmQod29ya3RyZWVMaXN0KTtcbiAgfVxuXG4gIGNvbnN0IGlzc3VlID0gc3RhdHVzLnJlcG9zaXRvcnkuZXJyb3I/Lm1lc3NhZ2UgfHwgc3RhdGUuc3RhdHVzQ2FjaGUuZ2V0KHByb2plY3QucGF0aCk/LmVycm9yIHx8IHN0YXRlLmRldGFpbHNDYWNoZS5nZXQocHJvamVjdC5wYXRoKT8uZXJyb3I7XG4gIGlmIChpc3N1ZSkge1xuICAgIGNvbnN0IHdhcm5pbmcgPSB0ZXh0RWwoXCJkaXZcIiwgaXNzdWUpO1xuICAgIHdhcm5pbmcuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdpdC13YXJuaW5nXCI7XG4gICAgcGFuZWwuYXBwZW5kKHdhcm5pbmcpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGlzVXNhYmxlUmVwbyhzdGF0dXM6IEdpdFN0YXR1cyB8IG51bGwpOiBzdGF0dXMgaXMgR2l0U3RhdHVzIHtcbiAgcmV0dXJuIEJvb2xlYW4oc3RhdHVzPy5yZXBvc2l0b3J5LmZvdW5kICYmIHN0YXR1cy5yZXBvc2l0b3J5LmlzSW5zaWRlV29ya1RyZWUpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVTdW1tYXJ5UGFuZWwoaG9zdDogSFRNTEVsZW1lbnQsIHJvdzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGxldCBwYW5lbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KGBbJHtTVU1NQVJZX0FUVFJ9XWApO1xuICBpZiAoIXBhbmVsKSB7XG4gICAgcGFuZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgICBwYW5lbC5zZXRBdHRyaWJ1dGUoU1VNTUFSWV9BVFRSLCBcIlwiKTtcbiAgICBwYW5lbC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ2l0LXN1bW1hcnlcIjtcbiAgfVxuXG4gIGlmIChwYW5lbC5wYXJlbnRFbGVtZW50ICE9PSBob3N0KSB7XG4gICAgcGFuZWwucmVtb3ZlKCk7XG4gICAgaG9zdC5pbnNlcnRCZWZvcmUocGFuZWwsIHJvdy5uZXh0RWxlbWVudFNpYmxpbmcpO1xuICB9IGVsc2UgaWYgKHBhbmVsLnByZXZpb3VzRWxlbWVudFNpYmxpbmcgIT09IHJvdykge1xuICAgIGhvc3QuaW5zZXJ0QmVmb3JlKHBhbmVsLCByb3cubmV4dEVsZW1lbnRTaWJsaW5nKTtcbiAgfVxuXG4gIHJldHVybiBwYW5lbDtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlU3VtbWFyeVBhbmVsKCk6IHZvaWQge1xuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKGBbJHtTVU1NQVJZX0FUVFJ9XWApPy5yZW1vdmUoKTtcbn1cblxuZnVuY3Rpb24gY291bnRTdGF0dXMoZW50cmllczogR2l0U3RhdHVzRW50cnlbXSk6IHtcbiAgc3RhZ2VkOiBudW1iZXI7XG4gIHVuc3RhZ2VkOiBudW1iZXI7XG4gIHVudHJhY2tlZDogbnVtYmVyO1xuICBjb25mbGljdHM6IG51bWJlcjtcbn0ge1xuICBsZXQgc3RhZ2VkID0gMDtcbiAgbGV0IHVuc3RhZ2VkID0gMDtcbiAgbGV0IHVudHJhY2tlZCA9IDA7XG4gIGxldCBjb25mbGljdHMgPSAwO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICBzd2l0Y2ggKGVudHJ5LmtpbmQpIHtcbiAgICAgIGNhc2UgXCJvcmRpbmFyeVwiOlxuICAgICAgY2FzZSBcInJlbmFtZVwiOlxuICAgICAgICBpZiAoZW50cnkuaW5kZXggIT09IFwiLlwiKSBzdGFnZWQrKztcbiAgICAgICAgaWYgKGVudHJ5Lndvcmt0cmVlICE9PSBcIi5cIikgdW5zdGFnZWQrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwidW50cmFja2VkXCI6XG4gICAgICAgIHVudHJhY2tlZCsrO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgXCJ1bm1lcmdlZFwiOlxuICAgICAgICBjb25mbGljdHMrKztcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFwiaWdub3JlZFwiOlxuICAgICAgICBicmVhaztcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgc3RhZ2VkLCB1bnN0YWdlZCwgdW50cmFja2VkLCBjb25mbGljdHMgfTtcbn1cblxuZnVuY3Rpb24gY291bnREaXJ0eShlbnRyaWVzOiBHaXRTdGF0dXNFbnRyeVtdKTogbnVtYmVyIHtcbiAgcmV0dXJuIGVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gZW50cnkua2luZCAhPT0gXCJpZ25vcmVkXCIpLmxlbmd0aDtcbn1cblxuZnVuY3Rpb24gY291bnRDb25mbGljdHMoZW50cmllczogR2l0U3RhdHVzRW50cnlbXSk6IG51bWJlciB7XG4gIHJldHVybiBlbnRyaWVzLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LmtpbmQgPT09IFwidW5tZXJnZWRcIikubGVuZ3RoO1xufVxuXG5mdW5jdGlvbiBicmFuY2hMYWJlbChzdGF0dXM6IEdpdFN0YXR1cyk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgc3RhdHVzLmJyYW5jaC5oZWFkID8/XG4gICAgc3RhdHVzLnJlcG9zaXRvcnkuaGVhZEJyYW5jaCA/P1xuICAgIHNob3J0U2hhKHN0YXR1cy5icmFuY2gub2lkKSA/P1xuICAgIHNob3J0U2hhKHN0YXR1cy5yZXBvc2l0b3J5LmhlYWRTaGEpID8/XG4gICAgXCJkZXRhY2hlZFwiXG4gICk7XG59XG5cbmZ1bmN0aW9uIHN5bmNMYWJlbChzdGF0dXM6IEdpdFN0YXR1cyk6IHsgc2hvcnQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZyB9IHtcbiAgY29uc3QgYWhlYWQgPSBzdGF0dXMuYnJhbmNoLmFoZWFkID8/IDA7XG4gIGNvbnN0IGJlaGluZCA9IHN0YXR1cy5icmFuY2guYmVoaW5kID8/IDA7XG4gIGNvbnN0IHNob3J0ID0gW2FoZWFkID4gMCA/IGBBJHthaGVhZH1gIDogXCJcIiwgYmVoaW5kID4gMCA/IGBCJHtiZWhpbmR9YCA6IFwiXCJdXG4gICAgLmZpbHRlcihCb29sZWFuKVxuICAgIC5qb2luKFwiL1wiKTtcbiAgY29uc3QgdGl0bGUgPSBbXG4gICAgYWhlYWQgPiAwID8gYCR7YWhlYWR9IGFoZWFkYCA6IFwiXCIsXG4gICAgYmVoaW5kID4gMCA/IGAke2JlaGluZH0gYmVoaW5kYCA6IFwiXCIsXG4gICAgc3RhdHVzLmJyYW5jaC51cHN0cmVhbSA/IGB1cHN0cmVhbSAke3N0YXR1cy5icmFuY2gudXBzdHJlYW19YCA6IFwiXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIsIFwiKTtcbiAgcmV0dXJuIHsgc2hvcnQsIHRpdGxlIH07XG59XG5cbmZ1bmN0aW9uIGVudHJ5TGFiZWwoZW50cnk6IEdpdFN0YXR1c0VudHJ5KTogc3RyaW5nIHtcbiAgc3dpdGNoIChlbnRyeS5raW5kKSB7XG4gICAgY2FzZSBcIm9yZGluYXJ5XCI6XG4gICAgICByZXR1cm4gYCR7ZW50cnkuaW5kZXh9JHtlbnRyeS53b3JrdHJlZX1gLnJlcGxhY2VBbGwoXCIuXCIsIFwiXCIpO1xuICAgIGNhc2UgXCJyZW5hbWVcIjpcbiAgICAgIHJldHVybiBcIlJcIjtcbiAgICBjYXNlIFwidW5tZXJnZWRcIjpcbiAgICAgIHJldHVybiBcIlVVXCI7XG4gICAgY2FzZSBcInVudHJhY2tlZFwiOlxuICAgICAgcmV0dXJuIFwiPz9cIjtcbiAgICBjYXNlIFwiaWdub3JlZFwiOlxuICAgICAgcmV0dXJuIFwiISFcIjtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbnRyeVBhdGgoZW50cnk6IEdpdFN0YXR1c0VudHJ5KTogc3RyaW5nIHtcbiAgaWYgKGVudHJ5LmtpbmQgPT09IFwicmVuYW1lXCIpIHJldHVybiBgJHtlbnRyeS5vcmlnaW5hbFBhdGh9IC0+ICR7ZW50cnkucGF0aH1gO1xuICByZXR1cm4gZW50cnkucGF0aDtcbn1cblxuZnVuY3Rpb24gbWV0cmljKGxhYmVsOiBzdHJpbmcsIHZhbHVlOiBudW1iZXIpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGl0ZW0gPSBlbChcImRpdlwiLCBcImNvZGV4cHAtZ2l0LW1ldHJpY1wiKTtcbiAgaXRlbS5hcHBlbmQodGV4dEVsKFwic3BhblwiLCBTdHJpbmcodmFsdWUpKSwgdGV4dEVsKFwic3BhblwiLCBsYWJlbCkpO1xuICByZXR1cm4gaXRlbTtcbn1cblxuZnVuY3Rpb24gc2hvcnRTaGEoc2hhOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBzaGEgPyBzaGEuc2xpY2UoMCwgNykgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBiYXNlbmFtZShwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gcGF0aC5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xuICBjb25zdCBpZHggPSB0cmltbWVkLmxhc3RJbmRleE9mKFwiL1wiKTtcbiAgcmV0dXJuIGlkeCA+PSAwID8gdHJpbW1lZC5zbGljZShpZHggKyAxKSA6IHRyaW1tZWQ7XG59XG5cbmZ1bmN0aW9uIHBsdXJhbChjb3VudDogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNvdW50ID09PSAxID8gXCJcIiA6IFwic1wiO1xufVxuXG5mdW5jdGlvbiBjbGVhcihub2RlOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICB3aGlsZSAobm9kZS5maXJzdENoaWxkKSBub2RlLmZpcnN0Q2hpbGQucmVtb3ZlKCk7XG59XG5cbmZ1bmN0aW9uIGVsKHRhZzogXCJkaXZcIiB8IFwic2VjdGlvblwiLCBjbGFzc05hbWU6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgbm9kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQodGFnKTtcbiAgbm9kZS5jbGFzc05hbWUgPSBjbGFzc05hbWU7XG4gIHJldHVybiBub2RlO1xufVxuXG5mdW5jdGlvbiB0ZXh0RWwodGFnOiBcImRpdlwiIHwgXCJzcGFuXCIgfCBcInN0cm9uZ1wiLCB0ZXh0OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IG5vZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHRhZyk7XG4gIG5vZGUudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByZXR1cm4gbm9kZTtcbn1cblxuZnVuY3Rpb24gaW5zdGFsbFN0eWxlcygpOiB2b2lkIHtcbiAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFNUWUxFX0lEKSkgcmV0dXJuO1xuICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcbiAgc3R5bGUuaWQgPSBTVFlMRV9JRDtcbiAgc3R5bGUudGV4dENvbnRlbnQgPSBgXG4gICAgLmNvZGV4cHAtZ2l0LXByb2plY3QtYmFkZ2Uge1xuICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICAgIGJvcmRlcjogMXB4IHNvbGlkIGNvbG9yLW1peChpbiBzcmdiLCBjdXJyZW50Q29sb3IgMTglLCB0cmFuc3BhcmVudCk7XG4gICAgICBib3JkZXItcmFkaXVzOiA1cHg7XG4gICAgICBjb2xvcjogdmFyKC0tdGV4dC10ZXJ0aWFyeSwgY3VycmVudENvbG9yKTtcbiAgICAgIGRpc3BsYXk6IGlubGluZS1mbGV4O1xuICAgICAgZmxleDogMCAxIGF1dG87XG4gICAgICBmb250OiA1MDAgMTBweC8xLjIgdWktbW9ub3NwYWNlLCBTRk1vbm8tUmVndWxhciwgTWVubG8sIENvbnNvbGFzLCBtb25vc3BhY2U7XG4gICAgICBnYXA6IDNweDtcbiAgICAgIGxldHRlci1zcGFjaW5nOiAwO1xuICAgICAgbWFyZ2luLWxlZnQ6IDZweDtcbiAgICAgIG1heC13aWR0aDogNDglO1xuICAgICAgbWluLXdpZHRoOiAwO1xuICAgICAgb3BhY2l0eTogMC43MjtcbiAgICAgIG92ZXJmbG93OiBoaWRkZW47XG4gICAgICBwYWRkaW5nOiAycHggNHB4O1xuICAgICAgcG9pbnRlci1ldmVudHM6IG5vbmU7XG4gICAgICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgICAgIHdoaXRlLXNwYWNlOiBub3dyYXA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1wcm9qZWN0LWJhZGdlLmNvZGV4cHAtZ2l0LWJhZGdlLWRpcnR5IHtcbiAgICAgIGJvcmRlci1jb2xvcjogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLWNvZGV4cHAtcHJvamVjdC10aW50LCBjdXJyZW50Q29sb3IpIDQyJSwgdHJhbnNwYXJlbnQpO1xuICAgICAgY29sb3I6IHZhcigtLWNvZGV4cHAtcHJvamVjdC10ZXh0LWNvbG9yLCBjdXJyZW50Q29sb3IpO1xuICAgICAgb3BhY2l0eTogMC45NDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXByb2plY3QtYmFkZ2UuY29kZXhwcC1naXQtYmFkZ2UtY29uZmxpY3Qge1xuICAgICAgYm9yZGVyLWNvbG9yOiByZ2JhKDIyMCwgMzgsIDM4LCAwLjY1KTtcbiAgICAgIGNvbG9yOiByZ2IoMjIwLCAzOCwgMzgpO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeSB7XG4gICAgICBib3JkZXItbGVmdDogMnB4IHNvbGlkIHZhcigtLWNvZGV4cHAtcHJvamVjdC10aW50LCBjb2xvci1taXgoaW4gc3JnYiwgY3VycmVudENvbG9yIDQwJSwgdHJhbnNwYXJlbnQpKTtcbiAgICAgIGJveC1zaXppbmc6IGJvcmRlci1ib3g7XG4gICAgICBjb2xvcjogdmFyKC0tdGV4dC1wcmltYXJ5LCBjdXJyZW50Q29sb3IpO1xuICAgICAgZGlzcGxheTogZmxleDtcbiAgICAgIGZsZXgtZGlyZWN0aW9uOiBjb2x1bW47XG4gICAgICBnYXA6IDZweDtcbiAgICAgIG1hcmdpbjogMXB4IDhweCA3cHggMThweDtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICAgIHBhZGRpbmc6IDdweCA4cHggOHB4IDhweDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktaGVhZGVyLFxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LWxpbmUsXG4gICAgLmNvZGV4cHAtZ2l0LWZpbGUtcm93LFxuICAgIC5jb2RleHBwLWdpdC13b3JrdHJlZS1yb3cge1xuICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICBnYXA6IDZweDtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktaGVhZGVyIHtcbiAgICAgIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktdGl0bGUge1xuICAgICAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICBnYXA6IDVweDtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktdGl0bGUgc3BhbjpmaXJzdC1jaGlsZCxcbiAgICAuY29kZXhwcC1naXQtd29ya3RyZWVzLWxhYmVsIHtcbiAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LXRlcnRpYXJ5LCBjdXJyZW50Q29sb3IpO1xuICAgICAgZm9udDogNjAwIDEwcHgvMS4yIHN5c3RlbS11aSwgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBzYW5zLXNlcmlmO1xuICAgICAgb3BhY2l0eTogMC43O1xuICAgICAgdGV4dC10cmFuc2Zvcm06IHVwcGVyY2FzZTtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktdGl0bGUgc3Ryb25nIHtcbiAgICAgIGZvbnQ6IDYwMCAxMnB4LzEuMjUgdWktbW9ub3NwYWNlLCBTRk1vbm8tUmVndWxhciwgTWVubG8sIENvbnNvbGFzLCBtb25vc3BhY2U7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgICBvdmVyZmxvdzogaGlkZGVuO1xuICAgICAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG4gICAgICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtc3VtbWFyeS1zdGF0ZSB7XG4gICAgICBib3JkZXItcmFkaXVzOiA1cHg7XG4gICAgICBmbGV4OiAwIDAgYXV0bztcbiAgICAgIGZvbnQ6IDYwMCAxMHB4LzEuMiBzeXN0ZW0tdWksIC1hcHBsZS1zeXN0ZW0sIEJsaW5rTWFjU3lzdGVtRm9udCwgc2Fucy1zZXJpZjtcbiAgICAgIHBhZGRpbmc6IDJweCA1cHg7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXN0YXRlLmlzLWNsZWFuIHtcbiAgICAgIGJhY2tncm91bmQ6IHJnYmEoMzQsIDE5NywgOTQsIDAuMTIpO1xuICAgICAgY29sb3I6IHJnYigyMiwgMTYzLCA3NCk7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LXN0YXRlLmlzLWRpcnR5IHtcbiAgICAgIGJhY2tncm91bmQ6IHJnYmEoMjQ1LCAxNTgsIDExLCAwLjEyKTtcbiAgICAgIGNvbG9yOiByZ2IoMTgwLCA4MywgOSk7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1zdW1tYXJ5LW1ldHJpY3Mge1xuICAgICAgZGlzcGxheTogZ3JpZDtcbiAgICAgIGdhcDogNHB4O1xuICAgICAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoNCwgbWlubWF4KDAsIDFmcikpO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtbWV0cmljIHtcbiAgICAgIG1pbi13aWR0aDogMDtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LW1ldHJpYyBzcGFuOmZpcnN0LWNoaWxkIHtcbiAgICAgIGRpc3BsYXk6IGJsb2NrO1xuICAgICAgZm9udDogNjAwIDEycHgvMS4xNSB1aS1tb25vc3BhY2UsIFNGTW9uby1SZWd1bGFyLCBNZW5sbywgQ29uc29sYXMsIG1vbm9zcGFjZTtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LW1ldHJpYyBzcGFuOmxhc3QtY2hpbGQsXG4gICAgLmNvZGV4cHAtZ2l0LXN1bW1hcnktbGluZSxcbiAgICAuY29kZXhwcC1naXQtbW9yZSxcbiAgICAuY29kZXhwcC1naXQtd2FybmluZyB7XG4gICAgICBjb2xvcjogdmFyKC0tdGV4dC10ZXJ0aWFyeSwgY3VycmVudENvbG9yKTtcbiAgICAgIGZvbnQ6IDUwMCAxMHB4LzEuMjUgc3lzdGVtLXVpLCAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIHNhbnMtc2VyaWY7XG4gICAgICBvcGFjaXR5OiAwLjc0O1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtY2hhbmdlZC1maWxlcyxcbiAgICAuY29kZXhwcC1naXQtd29ya3RyZWVzIHtcbiAgICAgIGRpc3BsYXk6IGZsZXg7XG4gICAgICBmbGV4LWRpcmVjdGlvbjogY29sdW1uO1xuICAgICAgZ2FwOiAzcHg7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1maWxlLXJvdyxcbiAgICAuY29kZXhwcC1naXQtd29ya3RyZWUtcm93IHtcbiAgICAgIGNvbG9yOiB2YXIoLS10ZXh0LXNlY29uZGFyeSwgY3VycmVudENvbG9yKTtcbiAgICAgIGZvbnQ6IDUwMCAxMXB4LzEuMjUgc3lzdGVtLXVpLCAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIHNhbnMtc2VyaWY7XG4gICAgfVxuICAgIC5jb2RleHBwLWdpdC1maWxlLXJvdyBzcGFuOmZpcnN0LWNoaWxkIHtcbiAgICAgIGNvbG9yOiB2YXIoLS1jb2RleHBwLXByb2plY3QtdGV4dC1jb2xvciwgY3VycmVudENvbG9yKTtcbiAgICAgIGZsZXg6IDAgMCAyNHB4O1xuICAgICAgZm9udDogNjAwIDEwcHgvMS4yIHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIE1lbmxvLCBDb25zb2xhcywgbW9ub3NwYWNlO1xuICAgICAgb3BhY2l0eTogMC44ODtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LWZpbGUtcm93IHNwYW46bGFzdC1jaGlsZCxcbiAgICAuY29kZXhwcC1naXQtd29ya3RyZWUtcm93IHNwYW46bGFzdC1jaGlsZCB7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgICBvdmVyZmxvdzogaGlkZGVuO1xuICAgICAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG4gICAgICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICAgIH1cbiAgICAuY29kZXhwcC1naXQtd29ya3RyZWUtcm93IHtcbiAgICAgIGp1c3RpZnktY29udGVudDogc3BhY2UtYmV0d2VlbjtcbiAgICB9XG4gICAgLmNvZGV4cHAtZ2l0LXdvcmt0cmVlLXJvdyBzcGFuOmZpcnN0LWNoaWxkIHtcbiAgICAgIGZvbnQ6IDUwMCAxMHB4LzEuMjUgdWktbW9ub3NwYWNlLCBTRk1vbm8tUmVndWxhciwgTWVubG8sIENvbnNvbGFzLCBtb25vc3BhY2U7XG4gICAgICBtaW4td2lkdGg6IDA7XG4gICAgICBvdmVyZmxvdzogaGlkZGVuO1xuICAgICAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7XG4gICAgICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICAgIH1cbiAgYDtcbiAgZG9jdW1lbnQuaGVhZC5hcHBlbmRDaGlsZChzdHlsZSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFXQSxJQUFBQSxtQkFBNEI7OztBQzZCckIsU0FBUyxtQkFBeUI7QUFDdkMsTUFBSSxPQUFPLCtCQUFnQztBQUMzQyxRQUFNLFlBQVksb0JBQUksSUFBK0I7QUFDckQsTUFBSSxTQUFTO0FBQ2IsUUFBTSxZQUFZLG9CQUFJLElBQTRDO0FBRWxFLFFBQU0sT0FBMEI7QUFBQSxJQUM5QixlQUFlO0FBQUEsSUFDZjtBQUFBLElBQ0EsT0FBTyxVQUFVO0FBQ2YsWUFBTSxLQUFLO0FBQ1gsZ0JBQVUsSUFBSSxJQUFJLFFBQVE7QUFFMUIsY0FBUTtBQUFBLFFBQ047QUFBQSxRQUNBLFNBQVM7QUFBQSxRQUNULFNBQVM7QUFBQSxNQUNYO0FBQ0EsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLEdBQUcsT0FBTyxJQUFJO0FBQ1osVUFBSSxJQUFJLFVBQVUsSUFBSSxLQUFLO0FBQzNCLFVBQUksQ0FBQyxFQUFHLFdBQVUsSUFBSSxPQUFRLElBQUksb0JBQUksSUFBSSxDQUFFO0FBQzVDLFFBQUUsSUFBSSxFQUFFO0FBQUEsSUFDVjtBQUFBLElBQ0EsSUFBSSxPQUFPLElBQUk7QUFDYixnQkFBVSxJQUFJLEtBQUssR0FBRyxPQUFPLEVBQUU7QUFBQSxJQUNqQztBQUFBLElBQ0EsS0FBSyxVQUFVLE1BQU07QUFDbkIsZ0JBQVUsSUFBSSxLQUFLLEdBQUcsUUFBUSxDQUFDLE9BQU8sR0FBRyxHQUFHLElBQUksQ0FBQztBQUFBLElBQ25EO0FBQUEsSUFDQSxvQkFBb0I7QUFBQSxJQUFDO0FBQUEsSUFDckIsdUJBQXVCO0FBQUEsSUFBQztBQUFBLElBQ3hCLHNCQUFzQjtBQUFBLElBQUM7QUFBQSxJQUN2QixXQUFXO0FBQUEsSUFBQztBQUFBLEVBQ2Q7QUFFQSxTQUFPLGVBQWUsUUFBUSxrQ0FBa0M7QUFBQSxJQUM5RCxjQUFjO0FBQUEsSUFDZCxZQUFZO0FBQUEsSUFDWixVQUFVO0FBQUE7QUFBQSxJQUNWLE9BQU87QUFBQSxFQUNULENBQUM7QUFFRCxTQUFPLGNBQWMsRUFBRSxNQUFNLFVBQVU7QUFDekM7QUFHTyxTQUFTLGFBQWEsTUFBNEI7QUFDdkQsUUFBTSxZQUFZLE9BQU8sYUFBYTtBQUN0QyxNQUFJLFdBQVc7QUFDYixlQUFXLEtBQUssVUFBVSxPQUFPLEdBQUc7QUFDbEMsWUFBTSxJQUFJLEVBQUUsMEJBQTBCLElBQUk7QUFDMUMsVUFBSSxFQUFHLFFBQU87QUFBQSxJQUNoQjtBQUFBLEVBQ0Y7QUFHQSxhQUFXLEtBQUssT0FBTyxLQUFLLElBQUksR0FBRztBQUNqQyxRQUFJLEVBQUUsV0FBVyxjQUFjLEVBQUcsUUFBUSxLQUE0QyxDQUFDO0FBQUEsRUFDekY7QUFDQSxTQUFPO0FBQ1Q7OztBQy9FQSxzQkFBNEI7QUF3SDVCLElBQU0sUUFBdUI7QUFBQSxFQUMzQixVQUFVLG9CQUFJLElBQUk7QUFBQSxFQUNsQixPQUFPLG9CQUFJLElBQUk7QUFBQSxFQUNmLGNBQWMsQ0FBQztBQUFBLEVBQ2YsY0FBYztBQUFBLEVBQ2QsaUJBQWlCO0FBQUEsRUFDakIsVUFBVTtBQUFBLEVBQ1YsWUFBWTtBQUFBLEVBQ1osWUFBWTtBQUFBLEVBQ1osZUFBZTtBQUFBLEVBQ2YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUFBLEVBQ1YsYUFBYTtBQUFBLEVBQ2IsZUFBZTtBQUFBLEVBQ2YsWUFBWTtBQUFBLEVBQ1osYUFBYTtBQUFBLEVBQ2IsdUJBQXVCO0FBQUEsRUFDdkIsd0JBQXdCO0FBQUEsRUFDeEIsMEJBQTBCO0FBQzVCO0FBRUEsU0FBUyxLQUFLLEtBQWEsT0FBdUI7QUFDaEQsOEJBQVk7QUFBQSxJQUNWO0FBQUEsSUFDQTtBQUFBLElBQ0EsdUJBQXVCLEdBQUcsR0FBRyxVQUFVLFNBQVksS0FBSyxNQUFNLGNBQWMsS0FBSyxDQUFDO0FBQUEsRUFDcEY7QUFDRjtBQUNBLFNBQVMsY0FBYyxHQUFvQjtBQUN6QyxNQUFJO0FBQ0YsV0FBTyxPQUFPLE1BQU0sV0FBVyxJQUFJLEtBQUssVUFBVSxDQUFDO0FBQUEsRUFDckQsUUFBUTtBQUNOLFdBQU8sT0FBTyxDQUFDO0FBQUEsRUFDakI7QUFDRjtBQUlPLFNBQVMsd0JBQThCO0FBQzVDLE1BQUksTUFBTSxTQUFVO0FBRXBCLFFBQU0sTUFBTSxJQUFJLGlCQUFpQixNQUFNO0FBQ3JDLGNBQVU7QUFDVixpQkFBYTtBQUFBLEVBQ2YsQ0FBQztBQUNELE1BQUksUUFBUSxTQUFTLGlCQUFpQixFQUFFLFdBQVcsTUFBTSxTQUFTLEtBQUssQ0FBQztBQUN4RSxRQUFNLFdBQVc7QUFFakIsU0FBTyxpQkFBaUIsWUFBWSxLQUFLO0FBQ3pDLFNBQU8saUJBQWlCLGNBQWMsS0FBSztBQUMzQyxXQUFTLGlCQUFpQixTQUFTLGlCQUFpQixJQUFJO0FBQ3hELGFBQVcsS0FBSyxDQUFDLGFBQWEsY0FBYyxHQUFZO0FBQ3RELFVBQU0sT0FBTyxRQUFRLENBQUM7QUFDdEIsWUFBUSxDQUFDLElBQUksWUFBNEIsTUFBK0I7QUFDdEUsWUFBTSxJQUFJLEtBQUssTUFBTSxNQUFNLElBQUk7QUFDL0IsYUFBTyxjQUFjLElBQUksTUFBTSxXQUFXLENBQUMsRUFBRSxDQUFDO0FBQzlDLGFBQU87QUFBQSxJQUNUO0FBQ0EsV0FBTyxpQkFBaUIsV0FBVyxDQUFDLElBQUksS0FBSztBQUFBLEVBQy9DO0FBRUEsWUFBVTtBQUNWLGVBQWE7QUFDYixNQUFJLFFBQVE7QUFDWixRQUFNLFdBQVcsWUFBWSxNQUFNO0FBQ2pDO0FBQ0EsY0FBVTtBQUNWLGlCQUFhO0FBQ2IsUUFBSSxRQUFRLEdBQUksZUFBYyxRQUFRO0FBQUEsRUFDeEMsR0FBRyxHQUFHO0FBQ1I7QUFFQSxTQUFTLFFBQWM7QUFDckIsUUFBTSxjQUFjO0FBQ3BCLFlBQVU7QUFDVixlQUFhO0FBQ2Y7QUFFQSxTQUFTLGdCQUFnQixHQUFxQjtBQUM1QyxRQUFNLFNBQVMsRUFBRSxrQkFBa0IsVUFBVSxFQUFFLFNBQVM7QUFDeEQsUUFBTSxVQUFVLFFBQVEsUUFBUSx3QkFBd0I7QUFDeEQsTUFBSSxFQUFFLG1CQUFtQixhQUFjO0FBQ3ZDLE1BQUksb0JBQW9CLFFBQVEsZUFBZSxFQUFFLE1BQU0sY0FBZTtBQUN0RSxhQUFXLE1BQU07QUFDZiw4QkFBMEIsT0FBTyxhQUFhO0FBQUEsRUFDaEQsR0FBRyxDQUFDO0FBQ047QUFFTyxTQUFTLGdCQUFnQixTQUEwQztBQUN4RSxRQUFNLFNBQVMsSUFBSSxRQUFRLElBQUksT0FBTztBQUN0QyxNQUFJLE1BQU0sWUFBWSxTQUFTLFNBQVUsVUFBUztBQUNsRCxTQUFPO0FBQUEsSUFDTCxZQUFZLE1BQU07QUFDaEIsWUFBTSxTQUFTLE9BQU8sUUFBUSxFQUFFO0FBQ2hDLFVBQUksTUFBTSxZQUFZLFNBQVMsU0FBVSxVQUFTO0FBQUEsSUFDcEQ7QUFBQSxFQUNGO0FBQ0Y7QUFFTyxTQUFTLGdCQUFzQjtBQUNwQyxRQUFNLFNBQVMsTUFBTTtBQUdyQixhQUFXLEtBQUssTUFBTSxNQUFNLE9BQU8sR0FBRztBQUNwQyxRQUFJO0FBQ0YsUUFBRSxXQUFXO0FBQUEsSUFDZixTQUFTLEdBQUc7QUFDVixXQUFLLHdCQUF3QixFQUFFLElBQUksRUFBRSxJQUFJLEtBQUssT0FBTyxDQUFDLEVBQUUsQ0FBQztBQUFBLElBQzNEO0FBQUEsRUFDRjtBQUNBLFFBQU0sTUFBTSxNQUFNO0FBQ2xCLGlCQUFlO0FBR2YsTUFDRSxNQUFNLFlBQVksU0FBUyxnQkFDM0IsQ0FBQyxNQUFNLE1BQU0sSUFBSSxNQUFNLFdBQVcsRUFBRSxHQUNwQztBQUNBLHFCQUFpQjtBQUFBLEVBQ25CLFdBQVcsTUFBTSxZQUFZLFNBQVMsVUFBVTtBQUM5QyxhQUFTO0FBQUEsRUFDWDtBQUNGO0FBT08sU0FBUyxhQUNkLFNBQ0EsVUFDQSxNQUNnQjtBQUNoQixRQUFNLEtBQUssS0FBSztBQUNoQixRQUFNLFFBQXdCLEVBQUUsSUFBSSxTQUFTLFVBQVUsS0FBSztBQUM1RCxRQUFNLE1BQU0sSUFBSSxJQUFJLEtBQUs7QUFDekIsT0FBSyxnQkFBZ0IsRUFBRSxJQUFJLE9BQU8sS0FBSyxPQUFPLFFBQVEsQ0FBQztBQUN2RCxpQkFBZTtBQUVmLE1BQUksTUFBTSxZQUFZLFNBQVMsZ0JBQWdCLE1BQU0sV0FBVyxPQUFPLElBQUk7QUFDekUsYUFBUztBQUFBLEVBQ1g7QUFDQSxTQUFPO0FBQUEsSUFDTCxZQUFZLE1BQU07QUFDaEIsWUFBTSxJQUFJLE1BQU0sTUFBTSxJQUFJLEVBQUU7QUFDNUIsVUFBSSxDQUFDLEVBQUc7QUFDUixVQUFJO0FBQ0YsVUFBRSxXQUFXO0FBQUEsTUFDZixRQUFRO0FBQUEsTUFBQztBQUNULFlBQU0sTUFBTSxPQUFPLEVBQUU7QUFDckIscUJBQWU7QUFDZixVQUFJLE1BQU0sWUFBWSxTQUFTLGdCQUFnQixNQUFNLFdBQVcsT0FBTyxJQUFJO0FBQ3pFLHlCQUFpQjtBQUFBLE1BQ25CO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRjtBQUdPLFNBQVMsZ0JBQWdCLE1BQTJCO0FBQ3pELFFBQU0sZUFBZTtBQUNyQixNQUFJLE1BQU0sWUFBWSxTQUFTLFNBQVUsVUFBUztBQUNwRDtBQUlBLFNBQVMsWUFBa0I7QUFDekIsUUFBTSxhQUFhLHNCQUFzQjtBQUN6QyxNQUFJLENBQUMsWUFBWTtBQUNmLGtDQUE4QjtBQUM5QixTQUFLLG1CQUFtQjtBQUN4QjtBQUFBLEVBQ0Y7QUFDQSxNQUFJLE1BQU0sMEJBQTBCO0FBQ2xDLGlCQUFhLE1BQU0sd0JBQXdCO0FBQzNDLFVBQU0sMkJBQTJCO0FBQUEsRUFDbkM7QUFDQSw0QkFBMEIsTUFBTSxlQUFlO0FBSS9DLFFBQU0sUUFBUSxXQUFXLGlCQUFpQjtBQUMxQyxRQUFNLGNBQWM7QUFDcEIsMkJBQXlCLFlBQVksS0FBSztBQUUxQyxNQUFJLE1BQU0sWUFBWSxNQUFNLFNBQVMsTUFBTSxRQUFRLEdBQUc7QUFDcEQsbUJBQWU7QUFJZixRQUFJLE1BQU0sZUFBZSxLQUFNLDBCQUF5QixJQUFJO0FBQzVEO0FBQUEsRUFDRjtBQVVBLE1BQUksTUFBTSxlQUFlLFFBQVEsTUFBTSxjQUFjLE1BQU07QUFDekQsU0FBSywwREFBMEQ7QUFBQSxNQUM3RCxZQUFZLE1BQU07QUFBQSxJQUNwQixDQUFDO0FBQ0QsVUFBTSxhQUFhO0FBQ25CLFVBQU0sWUFBWTtBQUFBLEVBQ3BCO0FBR0EsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sUUFBUSxVQUFVO0FBQ3hCLFFBQU0sWUFBWTtBQUVsQixRQUFNLFlBQVksbUJBQW1CLFdBQVcsTUFBTSxDQUFDO0FBR3ZELFFBQU0sWUFBWSxnQkFBZ0IsVUFBVSxjQUFjLENBQUM7QUFDM0QsUUFBTSxZQUFZLGdCQUFnQixVQUFVLGNBQWMsQ0FBQztBQUUzRCxZQUFVLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUN6QyxNQUFFLGVBQWU7QUFDakIsTUFBRSxnQkFBZ0I7QUFDbEIsaUJBQWEsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUFBLEVBQ2pDLENBQUM7QUFDRCxZQUFVLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUN6QyxNQUFFLGVBQWU7QUFDakIsTUFBRSxnQkFBZ0I7QUFDbEIsaUJBQWEsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUFBLEVBQ2pDLENBQUM7QUFFRCxRQUFNLFlBQVksU0FBUztBQUMzQixRQUFNLFlBQVksU0FBUztBQUMzQixRQUFNLFlBQVksS0FBSztBQUV2QixRQUFNLFdBQVc7QUFDakIsUUFBTSxhQUFhLEVBQUUsUUFBUSxXQUFXLFFBQVEsVUFBVTtBQUMxRCxPQUFLLHNCQUFzQixFQUFFLFVBQVUsTUFBTSxRQUFRLENBQUM7QUFDdEQsaUJBQWU7QUFDakI7QUFFQSxTQUFTLHlCQUF5QixZQUF5QixPQUEwQjtBQUNuRixNQUFJLE1BQU0sbUJBQW1CLE1BQU0sU0FBUyxNQUFNLGVBQWUsRUFBRztBQUNwRSxNQUFJLFVBQVUsV0FBWTtBQUUxQixRQUFNLFNBQVMsbUJBQW1CLFNBQVM7QUFDM0MsU0FBTyxRQUFRLFVBQVU7QUFDekIsUUFBTSxhQUFhLFFBQVEsVUFBVTtBQUNyQyxRQUFNLGtCQUFrQjtBQUMxQjtBQUVBLFNBQVMsbUJBQW1CLE1BQWMsYUFBYSxRQUFxQjtBQUMxRSxRQUFNLFNBQVMsU0FBUyxjQUFjLEtBQUs7QUFDM0MsU0FBTyxZQUNMLFlBQVksVUFBVTtBQUN4QixTQUFPLGNBQWM7QUFDckIsU0FBTztBQUNUO0FBRUEsU0FBUyxnQ0FBc0M7QUFDN0MsTUFBSSxDQUFDLE1BQU0sMEJBQTBCLE1BQU0seUJBQTBCO0FBQ3JFLFFBQU0sMkJBQTJCLFdBQVcsTUFBTTtBQUNoRCxVQUFNLDJCQUEyQjtBQUNqQyxRQUFJLHNCQUFzQixFQUFHO0FBQzdCLFFBQUksc0JBQXNCLEVBQUc7QUFDN0IsOEJBQTBCLE9BQU8sbUJBQW1CO0FBQUEsRUFDdEQsR0FBRyxJQUFJO0FBQ1Q7QUFFQSxTQUFTLHdCQUFpQztBQUN4QyxRQUFNLE9BQU8sb0JBQW9CLFNBQVMsTUFBTSxlQUFlLEVBQUUsRUFBRSxZQUFZO0FBQy9FLFNBQ0UsS0FBSyxTQUFTLGFBQWEsS0FDM0IsS0FBSyxTQUFTLFNBQVMsS0FDdkIsS0FBSyxTQUFTLFlBQVksTUFDekIsS0FBSyxTQUFTLGVBQWUsS0FBSyxLQUFLLFNBQVMscUJBQXFCO0FBRTFFO0FBRUEsU0FBUyxvQkFBb0IsT0FBdUI7QUFDbEQsU0FBTyxPQUFPLFNBQVMsRUFBRSxFQUFFLFFBQVEsUUFBUSxHQUFHLEVBQUUsS0FBSztBQUN2RDtBQUVBLFNBQVMsMEJBQTBCLFNBQWtCLFFBQXNCO0FBQ3pFLE1BQUksTUFBTSwyQkFBMkIsUUFBUztBQUM5QyxRQUFNLHlCQUF5QjtBQUMvQixNQUFJO0FBQ0YsSUFBQyxPQUFrRSxrQ0FBa0M7QUFDckcsYUFBUyxnQkFBZ0IsUUFBUSx5QkFBeUIsVUFBVSxTQUFTO0FBQzdFLFdBQU87QUFBQSxNQUNMLElBQUksWUFBWSw0QkFBNEI7QUFBQSxRQUMxQyxRQUFRLEVBQUUsU0FBUyxPQUFPO0FBQUEsTUFDNUIsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGLFFBQVE7QUFBQSxFQUFDO0FBQ1QsT0FBSyxvQkFBb0IsRUFBRSxTQUFTLFFBQVEsS0FBSyxTQUFTLEtBQUssQ0FBQztBQUNsRTtBQU9BLFNBQVMsaUJBQXVCO0FBQzlCLFFBQU0sUUFBUSxNQUFNO0FBQ3BCLE1BQUksQ0FBQyxNQUFPO0FBQ1osUUFBTSxRQUFRLENBQUMsR0FBRyxNQUFNLE1BQU0sT0FBTyxDQUFDO0FBTXRDLFFBQU0sYUFBYSxNQUFNLFdBQVcsSUFDaEMsVUFDQSxNQUFNLElBQUksQ0FBQyxNQUFNLEdBQUcsRUFBRSxFQUFFLElBQUksRUFBRSxLQUFLLEtBQUssSUFBSSxFQUFFLEtBQUssV0FBVyxFQUFFLEVBQUUsRUFBRSxLQUFLLElBQUk7QUFDakYsUUFBTSxnQkFBZ0IsQ0FBQyxDQUFDLE1BQU0sY0FBYyxNQUFNLFNBQVMsTUFBTSxVQUFVO0FBQzNFLE1BQUksTUFBTSxrQkFBa0IsZUFBZSxNQUFNLFdBQVcsSUFBSSxDQUFDLGdCQUFnQixnQkFBZ0I7QUFDL0Y7QUFBQSxFQUNGO0FBRUEsTUFBSSxNQUFNLFdBQVcsR0FBRztBQUN0QixRQUFJLE1BQU0sWUFBWTtBQUNwQixZQUFNLFdBQVcsT0FBTztBQUN4QixZQUFNLGFBQWE7QUFBQSxJQUNyQjtBQUNBLGVBQVcsS0FBSyxNQUFNLE1BQU0sT0FBTyxFQUFHLEdBQUUsWUFBWTtBQUNwRCxVQUFNLGdCQUFnQjtBQUN0QjtBQUFBLEVBQ0Y7QUFFQSxNQUFJLFFBQVEsTUFBTTtBQUNsQixNQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sU0FBUyxLQUFLLEdBQUc7QUFDcEMsWUFBUSxTQUFTLGNBQWMsS0FBSztBQUNwQyxVQUFNLFFBQVEsVUFBVTtBQUN4QixVQUFNLFlBQVk7QUFDbEIsVUFBTSxZQUFZLG1CQUFtQixVQUFVLE1BQU0sQ0FBQztBQUN0RCxVQUFNLFlBQVksS0FBSztBQUN2QixVQUFNLGFBQWE7QUFBQSxFQUNyQixPQUFPO0FBRUwsV0FBTyxNQUFNLFNBQVMsU0FBUyxFQUFHLE9BQU0sWUFBWSxNQUFNLFNBQVU7QUFBQSxFQUN0RTtBQUVBLGFBQVcsS0FBSyxPQUFPO0FBQ3JCLFVBQU0sT0FBTyxFQUFFLEtBQUssV0FBVyxtQkFBbUI7QUFDbEQsVUFBTSxNQUFNLGdCQUFnQixFQUFFLEtBQUssT0FBTyxJQUFJO0FBQzlDLFFBQUksUUFBUSxVQUFVLFlBQVksRUFBRSxFQUFFO0FBQ3RDLFFBQUksaUJBQWlCLFNBQVMsQ0FBQyxNQUFNO0FBQ25DLFFBQUUsZUFBZTtBQUNqQixRQUFFLGdCQUFnQjtBQUNsQixtQkFBYSxFQUFFLE1BQU0sY0FBYyxJQUFJLEVBQUUsR0FBRyxDQUFDO0FBQUEsSUFDL0MsQ0FBQztBQUNELE1BQUUsWUFBWTtBQUNkLFVBQU0sWUFBWSxHQUFHO0FBQUEsRUFDdkI7QUFDQSxRQUFNLGdCQUFnQjtBQUN0QixPQUFLLHNCQUFzQjtBQUFBLElBQ3pCLE9BQU8sTUFBTTtBQUFBLElBQ2IsS0FBSyxNQUFNLElBQUksQ0FBQyxNQUFNLEVBQUUsRUFBRTtBQUFBLEVBQzVCLENBQUM7QUFFRCxlQUFhLE1BQU0sVUFBVTtBQUMvQjtBQUVBLFNBQVMsZ0JBQWdCLE9BQWUsU0FBb0M7QUFFMUUsUUFBTSxNQUFNLFNBQVMsY0FBYyxRQUFRO0FBQzNDLE1BQUksT0FBTztBQUNYLE1BQUksUUFBUSxVQUFVLE9BQU8sTUFBTSxZQUFZLENBQUM7QUFDaEQsTUFBSSxhQUFhLGNBQWMsS0FBSztBQUNwQyxNQUFJLFlBQ0Y7QUFFRixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUNKO0FBQ0YsUUFBTSxZQUFZLEdBQUcsT0FBTywwQkFBMEIsS0FBSztBQUMzRCxNQUFJLFlBQVksS0FBSztBQUNyQixTQUFPO0FBQ1Q7QUFLQSxTQUFTLGFBQWEsUUFBaUM7QUFFckQsTUFBSSxNQUFNLFlBQVk7QUFDcEIsVUFBTSxVQUNKLFFBQVEsU0FBUyxXQUFXLFdBQzVCLFFBQVEsU0FBUyxXQUFXLFdBQVc7QUFDekMsZUFBVyxDQUFDLEtBQUssR0FBRyxLQUFLLE9BQU8sUUFBUSxNQUFNLFVBQVUsR0FBeUM7QUFDL0YscUJBQWUsS0FBSyxRQUFRLE9BQU87QUFBQSxJQUNyQztBQUFBLEVBQ0Y7QUFFQSxhQUFXLEtBQUssTUFBTSxNQUFNLE9BQU8sR0FBRztBQUNwQyxRQUFJLENBQUMsRUFBRSxVQUFXO0FBQ2xCLFVBQU0sV0FBVyxRQUFRLFNBQVMsZ0JBQWdCLE9BQU8sT0FBTyxFQUFFO0FBQ2xFLG1CQUFlLEVBQUUsV0FBVyxRQUFRO0FBQUEsRUFDdEM7QUFNQSwyQkFBeUIsV0FBVyxJQUFJO0FBQzFDO0FBWUEsU0FBUyx5QkFBeUIsTUFBcUI7QUFDckQsTUFBSSxDQUFDLEtBQU07QUFDWCxRQUFNQyxRQUFPLE1BQU07QUFDbkIsTUFBSSxDQUFDQSxNQUFNO0FBQ1gsUUFBTSxVQUFVLE1BQU0sS0FBS0EsTUFBSyxpQkFBb0MsUUFBUSxDQUFDO0FBQzdFLGFBQVcsT0FBTyxTQUFTO0FBRXpCLFFBQUksSUFBSSxRQUFRLFFBQVM7QUFDekIsUUFBSSxJQUFJLGFBQWEsY0FBYyxNQUFNLFFBQVE7QUFDL0MsVUFBSSxnQkFBZ0IsY0FBYztBQUFBLElBQ3BDO0FBQ0EsUUFBSSxJQUFJLFVBQVUsU0FBUyxnQ0FBZ0MsR0FBRztBQUM1RCxVQUFJLFVBQVUsT0FBTyxnQ0FBZ0M7QUFDckQsVUFBSSxVQUFVLElBQUksc0NBQXNDO0FBQUEsSUFDMUQ7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxTQUFTLGVBQWUsS0FBd0IsUUFBdUI7QUFDckUsUUFBTSxRQUFRLElBQUk7QUFDbEIsTUFBSSxRQUFRO0FBQ1IsUUFBSSxVQUFVLE9BQU8sd0NBQXdDLGFBQWE7QUFDMUUsUUFBSSxVQUFVLElBQUksZ0NBQWdDO0FBQ2xELFFBQUksYUFBYSxnQkFBZ0IsTUFBTTtBQUN2QyxRQUFJLE9BQU87QUFDVCxZQUFNLFVBQVUsT0FBTyx1QkFBdUI7QUFDOUMsWUFBTSxVQUFVLElBQUksNkNBQTZDO0FBQ2pFLFlBQ0csY0FBYyxLQUFLLEdBQ2xCLFVBQVUsSUFBSSxrREFBa0Q7QUFBQSxJQUN0RTtBQUFBLEVBQ0YsT0FBTztBQUNMLFFBQUksVUFBVSxJQUFJLHdDQUF3QyxhQUFhO0FBQ3ZFLFFBQUksVUFBVSxPQUFPLGdDQUFnQztBQUNyRCxRQUFJLGdCQUFnQixjQUFjO0FBQ2xDLFFBQUksT0FBTztBQUNULFlBQU0sVUFBVSxJQUFJLHVCQUF1QjtBQUMzQyxZQUFNLFVBQVUsT0FBTyw2Q0FBNkM7QUFDcEUsWUFDRyxjQUFjLEtBQUssR0FDbEIsVUFBVSxPQUFPLGtEQUFrRDtBQUFBLElBQ3pFO0FBQUEsRUFDRjtBQUNKO0FBSUEsU0FBUyxhQUFhLE1BQXdCO0FBQzVDLFFBQU0sVUFBVSxnQkFBZ0I7QUFDaEMsTUFBSSxDQUFDLFNBQVM7QUFDWixTQUFLLGtDQUFrQztBQUN2QztBQUFBLEVBQ0Y7QUFDQSxRQUFNLGFBQWE7QUFDbkIsT0FBSyxZQUFZLEVBQUUsS0FBSyxDQUFDO0FBR3pCLGFBQVcsU0FBUyxNQUFNLEtBQUssUUFBUSxRQUFRLEdBQW9CO0FBQ2pFLFFBQUksTUFBTSxRQUFRLFlBQVksZUFBZ0I7QUFDOUMsUUFBSSxNQUFNLFFBQVEsa0JBQWtCLFFBQVc7QUFDN0MsWUFBTSxRQUFRLGdCQUFnQixNQUFNLE1BQU0sV0FBVztBQUFBLElBQ3ZEO0FBQ0EsVUFBTSxNQUFNLFVBQVU7QUFBQSxFQUN4QjtBQUNBLE1BQUksUUFBUSxRQUFRLGNBQTJCLCtCQUErQjtBQUM5RSxNQUFJLENBQUMsT0FBTztBQUNWLFlBQVEsU0FBUyxjQUFjLEtBQUs7QUFDcEMsVUFBTSxRQUFRLFVBQVU7QUFDeEIsVUFBTSxNQUFNLFVBQVU7QUFDdEIsWUFBUSxZQUFZLEtBQUs7QUFBQSxFQUMzQjtBQUNBLFFBQU0sTUFBTSxVQUFVO0FBQ3RCLFFBQU0sWUFBWTtBQUNsQixXQUFTO0FBQ1QsZUFBYSxJQUFJO0FBRWpCLFFBQU0sVUFBVSxNQUFNO0FBQ3RCLE1BQUksU0FBUztBQUNYLFFBQUksTUFBTSx1QkFBdUI7QUFDL0IsY0FBUSxvQkFBb0IsU0FBUyxNQUFNLHVCQUF1QixJQUFJO0FBQUEsSUFDeEU7QUFDQSxVQUFNLFVBQVUsQ0FBQyxNQUFhO0FBQzVCLFlBQU0sU0FBUyxFQUFFO0FBQ2pCLFVBQUksQ0FBQyxPQUFRO0FBQ2IsVUFBSSxNQUFNLFVBQVUsU0FBUyxNQUFNLEVBQUc7QUFDdEMsVUFBSSxNQUFNLFlBQVksU0FBUyxNQUFNLEVBQUc7QUFDeEMsVUFBSSxPQUFPLFFBQVEsZ0NBQWdDLEVBQUc7QUFDdEQsdUJBQWlCO0FBQUEsSUFDbkI7QUFDQSxVQUFNLHdCQUF3QjtBQUM5QixZQUFRLGlCQUFpQixTQUFTLFNBQVMsSUFBSTtBQUFBLEVBQ2pEO0FBQ0Y7QUFFQSxTQUFTLG1CQUF5QjtBQUNoQyxPQUFLLG9CQUFvQjtBQUN6QixRQUFNLFVBQVUsZ0JBQWdCO0FBQ2hDLE1BQUksQ0FBQyxRQUFTO0FBQ2QsTUFBSSxNQUFNLFVBQVcsT0FBTSxVQUFVLE1BQU0sVUFBVTtBQUNyRCxhQUFXLFNBQVMsTUFBTSxLQUFLLFFBQVEsUUFBUSxHQUFvQjtBQUNqRSxRQUFJLFVBQVUsTUFBTSxVQUFXO0FBQy9CLFFBQUksTUFBTSxRQUFRLGtCQUFrQixRQUFXO0FBQzdDLFlBQU0sTUFBTSxVQUFVLE1BQU0sUUFBUTtBQUNwQyxhQUFPLE1BQU0sUUFBUTtBQUFBLElBQ3ZCO0FBQUEsRUFDRjtBQUNBLFFBQU0sYUFBYTtBQUNuQixlQUFhLElBQUk7QUFDakIsTUFBSSxNQUFNLGVBQWUsTUFBTSx1QkFBdUI7QUFDcEQsVUFBTSxZQUFZO0FBQUEsTUFDaEI7QUFBQSxNQUNBLE1BQU07QUFBQSxNQUNOO0FBQUEsSUFDRjtBQUNBLFVBQU0sd0JBQXdCO0FBQUEsRUFDaEM7QUFDRjtBQUVBLFNBQVMsV0FBaUI7QUFDeEIsTUFBSSxDQUFDLE1BQU0sV0FBWTtBQUN2QixRQUFNLE9BQU8sTUFBTTtBQUNuQixNQUFJLENBQUMsS0FBTTtBQUNYLE9BQUssWUFBWTtBQUVqQixRQUFNLEtBQUssTUFBTTtBQUNqQixNQUFJLEdBQUcsU0FBUyxjQUFjO0FBQzVCLFVBQU0sUUFBUSxNQUFNLE1BQU0sSUFBSSxHQUFHLEVBQUU7QUFDbkMsUUFBSSxDQUFDLE9BQU87QUFDVix1QkFBaUI7QUFDakI7QUFBQSxJQUNGO0FBQ0EsVUFBTUEsUUFBTyxXQUFXLE1BQU0sS0FBSyxPQUFPLE1BQU0sS0FBSyxXQUFXO0FBQ2hFLFNBQUssWUFBWUEsTUFBSyxLQUFLO0FBQzNCLFFBQUk7QUFFRixVQUFJO0FBQUUsY0FBTSxXQUFXO0FBQUEsTUFBRyxRQUFRO0FBQUEsTUFBQztBQUNuQyxZQUFNLFdBQVc7QUFDakIsWUFBTSxNQUFNLE1BQU0sS0FBSyxPQUFPQSxNQUFLLFlBQVk7QUFDL0MsVUFBSSxPQUFPLFFBQVEsV0FBWSxPQUFNLFdBQVc7QUFBQSxJQUNsRCxTQUFTLEdBQUc7QUFDVixZQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsVUFBSSxZQUFZO0FBQ2hCLFVBQUksY0FBYyx5QkFBMEIsRUFBWSxPQUFPO0FBQy9ELE1BQUFBLE1BQUssYUFBYSxZQUFZLEdBQUc7QUFBQSxJQUNuQztBQUNBO0FBQUEsRUFDRjtBQUVBLFFBQU0sUUFBUSxHQUFHLFNBQVMsV0FBVyxXQUFXO0FBQ2hELFFBQU0sV0FBVyxHQUFHLFNBQVMsV0FDekIsMENBQ0E7QUFDSixRQUFNQSxRQUFPLFdBQVcsT0FBTyxRQUFRO0FBQ3ZDLE9BQUssWUFBWUEsTUFBSyxLQUFLO0FBQzNCLE1BQUksR0FBRyxTQUFTLFNBQVUsa0JBQWlCQSxNQUFLLFlBQVk7QUFBQSxNQUN2RCxrQkFBaUJBLE1BQUssY0FBY0EsTUFBSyxRQUFRO0FBQ3hEO0FBSUEsU0FBUyxpQkFBaUIsY0FBMkIsVUFBOEI7QUFDakYsUUFBTSxVQUFVLFNBQVMsY0FBYyxTQUFTO0FBQ2hELFVBQVEsWUFBWTtBQUNwQixVQUFRLFlBQVksYUFBYSxpQkFBaUIsQ0FBQztBQUNuRCxRQUFNLE9BQU8sWUFBWTtBQUN6QixRQUFNLFVBQVUsVUFBVSwyQkFBMkIseUNBQXlDO0FBQzlGLE9BQUssWUFBWSxPQUFPO0FBQ3hCLFVBQVEsWUFBWSxJQUFJO0FBQ3hCLGVBQWEsWUFBWSxPQUFPO0FBRWhDLE9BQUssNEJBQ0YsT0FBTyxvQkFBb0IsRUFDM0IsS0FBSyxDQUFDLFdBQVc7QUFDaEIsUUFBSSxVQUFVO0FBQ1osZUFBUyxjQUFjLG9CQUFxQixPQUErQixPQUFPO0FBQUEsSUFDcEY7QUFDQSxTQUFLLGNBQWM7QUFDbkIsOEJBQTBCLE1BQU0sTUFBNkI7QUFBQSxFQUMvRCxDQUFDLEVBQ0EsTUFBTSxDQUFDLE1BQU07QUFDWixRQUFJLFNBQVUsVUFBUyxjQUFjO0FBQ3JDLFNBQUssY0FBYztBQUNuQixTQUFLLFlBQVksVUFBVSxrQ0FBa0MsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUFBLEVBQ3pFLENBQUM7QUFFSCxRQUFNLFVBQVUsU0FBUyxjQUFjLFNBQVM7QUFDaEQsVUFBUSxZQUFZO0FBQ3BCLFVBQVEsWUFBWSxhQUFhLHFCQUFxQixDQUFDO0FBQ3ZELFFBQU0sY0FBYyxZQUFZO0FBQ2hDLGNBQVksWUFBWSxVQUFVLG9CQUFvQix1Q0FBdUMsQ0FBQztBQUM5RixVQUFRLFlBQVksV0FBVztBQUMvQixlQUFhLFlBQVksT0FBTztBQUNoQywwQkFBd0IsV0FBVztBQUVuQyxRQUFNLE1BQU0sU0FBUyxjQUFjLFNBQVM7QUFDNUMsTUFBSSxZQUFZO0FBQ2hCLE1BQUksWUFBWSxhQUFhLGlCQUFpQixDQUFDO0FBQy9DLFFBQU0sVUFBVSxZQUFZO0FBQzVCLFVBQVEsWUFBWSxVQUFVLGdCQUFnQiwwQ0FBMEMsQ0FBQztBQUN6RixNQUFJLFlBQVksT0FBTztBQUN2QixlQUFhLFlBQVksR0FBRztBQUM1QixnQkFBYyxPQUFPO0FBRXJCLFFBQU0sY0FBYyxTQUFTLGNBQWMsU0FBUztBQUNwRCxjQUFZLFlBQVk7QUFDeEIsY0FBWSxZQUFZLGFBQWEsYUFBYSxDQUFDO0FBQ25ELFFBQU0sa0JBQWtCLFlBQVk7QUFDcEMsa0JBQWdCLFlBQVksYUFBYSxDQUFDO0FBQzFDLGtCQUFnQixZQUFZLGFBQWEsQ0FBQztBQUMxQyxjQUFZLFlBQVksZUFBZTtBQUN2QyxlQUFhLFlBQVksV0FBVztBQUN0QztBQUVBLFNBQVMsMEJBQTBCLE1BQW1CLFFBQW1DO0FBQ3ZGLE9BQUssWUFBWSxjQUFjLE1BQU0sQ0FBQztBQUN0QyxPQUFLLFlBQVksbUJBQW1CLE9BQU8sV0FBVyxDQUFDO0FBQ3ZELE1BQUksT0FBTyxZQUFhLE1BQUssWUFBWSxnQkFBZ0IsT0FBTyxXQUFXLENBQUM7QUFDOUU7QUFFQSxTQUFTLGNBQWMsUUFBMEM7QUFDL0QsUUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLE1BQUksWUFBWTtBQUNoQixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLFFBQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUMxQyxRQUFNLFlBQVk7QUFDbEIsUUFBTSxjQUFjO0FBQ3BCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxjQUFjLHNCQUFzQixPQUFPLE9BQU87QUFDdkQsT0FBSyxZQUFZLEtBQUs7QUFDdEIsT0FBSyxZQUFZLElBQUk7QUFDckIsTUFBSSxZQUFZLElBQUk7QUFDcEIsTUFBSTtBQUFBLElBQ0YsY0FBYyxPQUFPLFlBQVksT0FBTyxTQUFTO0FBQy9DLFlBQU0sNEJBQVksT0FBTywyQkFBMkIsSUFBSTtBQUFBLElBQzFELENBQUM7QUFBQSxFQUNIO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxtQkFBbUIsT0FBcUQ7QUFDL0UsUUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLE1BQUksWUFBWTtBQUNoQixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLFFBQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUMxQyxRQUFNLFlBQVk7QUFDbEIsUUFBTSxjQUFjLE9BQU8sa0JBQWtCLDZCQUE2QjtBQUMxRSxRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLE9BQUssY0FBYyxjQUFjLEtBQUs7QUFDdEMsT0FBSyxZQUFZLEtBQUs7QUFDdEIsT0FBSyxZQUFZLElBQUk7QUFDckIsTUFBSSxZQUFZLElBQUk7QUFFcEIsUUFBTSxVQUFVLFNBQVMsY0FBYyxLQUFLO0FBQzVDLFVBQVEsWUFBWTtBQUNwQixNQUFJLE9BQU8sWUFBWTtBQUNyQixZQUFRO0FBQUEsTUFDTixjQUFjLGlCQUFpQixNQUFNO0FBQ25DLGFBQUssNEJBQVksT0FBTyx5QkFBeUIsTUFBTSxVQUFVO0FBQUEsTUFDbkUsQ0FBQztBQUFBLElBQ0g7QUFBQSxFQUNGO0FBQ0EsVUFBUTtBQUFBLElBQ04sY0FBYyxhQUFhLE1BQU07QUFDL0IsVUFBSSxNQUFNLFVBQVU7QUFDcEIsV0FBSyw0QkFDRixPQUFPLGdDQUFnQyxJQUFJLEVBQzNDLEtBQUssQ0FBQyxTQUFTO0FBQ2QsY0FBTSxPQUFPLElBQUk7QUFDakIsWUFBSSxDQUFDLEtBQU07QUFDWCxhQUFLLGNBQWM7QUFDbkIsYUFBSyw0QkFBWSxPQUFPLG9CQUFvQixFQUFFLEtBQUssQ0FBQyxXQUFXO0FBQzdELG9DQUEwQixNQUFNO0FBQUEsWUFDOUIsR0FBSTtBQUFBLFlBQ0osYUFBYTtBQUFBLFVBQ2YsQ0FBQztBQUFBLFFBQ0gsQ0FBQztBQUFBLE1BQ0gsQ0FBQyxFQUNBLE1BQU0sQ0FBQyxNQUFNLEtBQUssK0JBQStCLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFDM0QsUUFBUSxNQUFNO0FBQ2IsWUFBSSxNQUFNLFVBQVU7QUFBQSxNQUN0QixDQUFDO0FBQUEsSUFDTCxDQUFDO0FBQUEsRUFDSDtBQUNBLE1BQUksWUFBWSxPQUFPO0FBQ3ZCLFNBQU87QUFDVDtBQUVBLFNBQVMsZ0JBQWdCLE9BQThDO0FBQ3JFLFFBQU0sTUFBTSxTQUFTLGNBQWMsS0FBSztBQUN4QyxNQUFJLFlBQVk7QUFDaEIsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWM7QUFDcEIsTUFBSSxZQUFZLEtBQUs7QUFDckIsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFDSDtBQUNGLE9BQUssWUFBWSwyQkFBMkIsTUFBTSxjQUFjLEtBQUssS0FBSyxNQUFNLFNBQVMsNkJBQTZCLENBQUM7QUFDdkgsTUFBSSxZQUFZLElBQUk7QUFDcEIsU0FBTztBQUNUO0FBRUEsU0FBUyxjQUFjLE1BQXlCO0FBQzlDLE9BQUssNEJBQ0YsT0FBTyx3QkFBd0IsRUFDL0IsS0FBSyxDQUFDLFdBQVc7QUFDaEIsU0FBSyxjQUFjO0FBQ25CLG9CQUFnQixNQUFNLE1BQXdCO0FBQUEsRUFDaEQsQ0FBQyxFQUNBLE1BQU0sQ0FBQyxNQUFNO0FBQ1osU0FBSyxjQUFjO0FBQ25CLFNBQUssWUFBWSxVQUFVLDZCQUE2QixPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQUEsRUFDcEUsQ0FBQztBQUNMO0FBRUEsU0FBUyxnQkFBZ0IsTUFBbUIsUUFBOEI7QUFDeEUsT0FBSyxZQUFZLGFBQWEsTUFBTSxNQUFNLENBQUM7QUFDM0MsT0FBSyxZQUFZLFdBQVcsTUFBTSxNQUFNLENBQUM7QUFDekMsT0FBSyxZQUFZLGVBQWUsTUFBTSxDQUFDO0FBQ3ZDLE9BQUssWUFBWSxhQUFhLE1BQU0sQ0FBQztBQUNyQyxNQUFJLE9BQU8saUJBQWlCO0FBQzFCLFNBQUs7QUFBQSxNQUNIO0FBQUEsUUFDRTtBQUFBLFFBQ0EsT0FBTyxVQUNILHNEQUNBO0FBQUEsTUFDTjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0Y7QUFFQSxTQUFTLGFBQWEsTUFBbUIsUUFBcUM7QUFDNUUsUUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLE1BQUksWUFBWTtBQUVoQixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLE9BQUssWUFBWSxlQUFlLE1BQU0sQ0FBQztBQUV2QyxRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUFZO0FBQ2xCLFFBQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUMxQyxRQUFNLFlBQVk7QUFDbEIsUUFBTSxjQUFjO0FBQ3BCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxjQUFjLGlCQUFpQixNQUFNO0FBQzFDLFFBQU0sT0FBTyxPQUFPLElBQUk7QUFDeEIsT0FBSyxZQUFZLEtBQUs7QUFDdEIsTUFBSSxZQUFZLElBQUk7QUFFcEIsTUFBSTtBQUFBLElBQ0YsY0FBYyxPQUFPLFNBQVMsT0FBTyxZQUFZO0FBQy9DLFlBQU0sNEJBQVksT0FBTywwQkFBMEI7QUFBQSxRQUNqRDtBQUFBLFFBQ0EsTUFBTSxPQUFPO0FBQUEsTUFDZixDQUFDO0FBQ0QscUJBQWUsSUFBSTtBQUFBLElBQ3JCLENBQUM7QUFBQSxFQUNIO0FBRUEsU0FBTztBQUNUO0FBRUEsU0FBUyxXQUFXLE1BQW1CLFFBQXFDO0FBQzFFLFFBQU0sTUFBTTtBQUFBLElBQ1Y7QUFBQSxJQUNBLE9BQU8sYUFDSCxtQ0FBbUMsT0FBTyxVQUFVLE1BQ3BELGlCQUFpQixPQUFPLGNBQWM7QUFBQSxFQUM1QztBQUNBLFFBQU0sU0FBUyxJQUFJLGNBQTJCLDRCQUE0QjtBQUMxRSxRQUFNLFFBQVEsU0FBUyxjQUFjLE9BQU87QUFDNUMsUUFBTSxPQUFPO0FBQ2IsUUFBTSxNQUFNO0FBQ1osUUFBTSxNQUFNO0FBQ1osUUFBTSxPQUFPO0FBQ2IsUUFBTSxRQUFRLE9BQU8sT0FBTyxjQUFjO0FBQzFDLFFBQU0sWUFDSjtBQUNGLFVBQVEsWUFBWSxLQUFLO0FBQ3pCLFVBQVE7QUFBQSxJQUNOLGNBQWMsUUFBUSxNQUFNO0FBQzFCLFlBQU0sT0FBTyxPQUFPLE1BQU0sS0FBSztBQUMvQixXQUFLLDRCQUNGLE9BQU8sMEJBQTBCO0FBQUEsUUFDaEMsU0FBUyxPQUFPO0FBQUEsUUFDaEIsTUFBTSxPQUFPLFVBQVUsSUFBSSxJQUFJLE9BQU8sT0FBTztBQUFBLE1BQy9DLENBQUMsRUFDQSxLQUFLLE1BQU0sZUFBZSxJQUFJLENBQUMsRUFDL0IsTUFBTSxDQUFDLE1BQU0sS0FBSyx3QkFBd0IsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUFBLElBQ3pELENBQUM7QUFBQSxFQUNIO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxlQUFlLFFBQXFDO0FBQzNELFFBQU0sTUFBTTtBQUFBLElBQ1YsT0FBTyxTQUFTLHdCQUF3QjtBQUFBLElBQ3hDLE9BQU8sVUFBVSxPQUFPLGNBQ3BCLEdBQUcsT0FBTyxXQUFXLEtBQ3JCO0FBQUEsRUFDTjtBQUNBLFFBQU0sU0FBUyxJQUFJLGNBQTJCLDRCQUE0QjtBQUMxRSxRQUFNLGNBQWMsY0FBYyxnQkFBZ0IsTUFBTTtBQUN0RCxRQUFJLENBQUMsT0FBTyxZQUFhO0FBQ3pCLFNBQUssNEJBQVksT0FBTyx3QkFBd0IsT0FBTyxXQUFXO0FBQUEsRUFDcEUsQ0FBQztBQUNELGNBQVksV0FBVyxDQUFDLE9BQU87QUFDL0IsUUFBTSxjQUFjLGNBQWMsWUFBWSxNQUFNO0FBQ2xELFFBQUksQ0FBQyxPQUFPLFlBQWE7QUFDekIsU0FBSyw0QkFBWSxPQUFPLHFCQUFxQixPQUFPLFdBQVc7QUFBQSxFQUNqRSxDQUFDO0FBQ0QsY0FBWSxXQUFXLENBQUMsT0FBTztBQUMvQixRQUFNLGNBQWMsY0FBYyxXQUFXLE1BQU07QUFDakQsUUFBSSxDQUFDLE9BQU8sZUFBZ0I7QUFDNUIsU0FBSyw0QkFBWSxPQUFPLHdCQUF3QixPQUFPLGNBQWM7QUFBQSxFQUN2RSxDQUFDO0FBQ0QsY0FBWSxXQUFXLENBQUMsT0FBTztBQUMvQixVQUFRLE9BQU8sYUFBYSxhQUFhLFdBQVc7QUFDcEQsU0FBTztBQUNUO0FBRUEsU0FBUyxhQUFhLFFBQXFDO0FBQ3pELFFBQU0sTUFBTTtBQUFBLElBQ1Y7QUFBQSxJQUNBLE9BQU8sVUFBVSxPQUFPLFVBQVU7QUFBQSxFQUNwQztBQUNBLFFBQU0sU0FBUyxJQUFJLGNBQTJCLDRCQUE0QjtBQUMxRSxVQUFRO0FBQUEsSUFDTixjQUFjLGdCQUFnQixNQUFNO0FBQ2xDLFdBQUssNEJBQVksT0FBTyxxQkFBcUIsT0FBTyxhQUFhO0FBQUEsSUFDbkUsQ0FBQztBQUFBLEVBQ0g7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGVBQWUsTUFBeUI7QUFDL0MsT0FBSyxjQUFjO0FBQ25CLE9BQUssWUFBWSxVQUFVLGdCQUFnQiwwQ0FBMEMsQ0FBQztBQUN0RixnQkFBYyxJQUFJO0FBQ3BCO0FBRUEsU0FBUyxlQUFlLFFBQXFDO0FBQzNELE1BQUksT0FBTyxPQUFRLFFBQU8sWUFBWSxPQUFPLGtCQUFrQixTQUFTLE1BQU0sUUFBUTtBQUN0RixNQUFJLE9BQU8sZ0JBQWlCLFFBQU8sWUFBWSxRQUFRLFNBQVM7QUFDaEUsU0FBTyxZQUFZLE9BQU8sVUFBVSxTQUFTLFFBQVEsT0FBTyxVQUFVLFVBQVUsS0FBSztBQUN2RjtBQUVBLFNBQVMsaUJBQWlCLFFBQWdDO0FBQ3hELE1BQUksT0FBTyxZQUFZO0FBQ3JCLFVBQU0sU0FBUyxPQUFPLFdBQVcsU0FBUyxlQUFlLE9BQU87QUFDaEUsV0FBTyx1QkFBdUIsT0FBTyxVQUFVLFNBQVMsTUFBTTtBQUFBLEVBQ2hFO0FBQ0EsTUFBSSxPQUFPLFNBQVM7QUFDbEIsV0FBTyx3Q0FBd0MsT0FBTyxjQUFjO0FBQUEsRUFDdEU7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLDJCQUEyQixVQUErQjtBQUNqRSxRQUFNQSxRQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLEVBQUFBLE1BQUssWUFBWTtBQUNqQixRQUFNLFFBQVEsU0FBUyxRQUFRLFVBQVUsSUFBSSxFQUFFLE1BQU0sSUFBSTtBQUN6RCxNQUFJLFlBQXNCLENBQUM7QUFDM0IsTUFBSSxPQUFtRDtBQUN2RCxNQUFJLFlBQTZCO0FBRWpDLFFBQU0saUJBQWlCLE1BQU07QUFDM0IsUUFBSSxVQUFVLFdBQVcsRUFBRztBQUM1QixVQUFNLElBQUksU0FBUyxjQUFjLEdBQUc7QUFDcEMsTUFBRSxZQUFZO0FBQ2QseUJBQXFCLEdBQUcsVUFBVSxLQUFLLEdBQUcsRUFBRSxLQUFLLENBQUM7QUFDbEQsSUFBQUEsTUFBSyxZQUFZLENBQUM7QUFDbEIsZ0JBQVksQ0FBQztBQUFBLEVBQ2Y7QUFDQSxRQUFNLFlBQVksTUFBTTtBQUN0QixRQUFJLENBQUMsS0FBTTtBQUNYLElBQUFBLE1BQUssWUFBWSxJQUFJO0FBQ3JCLFdBQU87QUFBQSxFQUNUO0FBQ0EsUUFBTSxZQUFZLE1BQU07QUFDdEIsUUFBSSxDQUFDLFVBQVc7QUFDaEIsVUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLFFBQUksWUFDRjtBQUNGLFVBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxTQUFLLGNBQWMsVUFBVSxLQUFLLElBQUk7QUFDdEMsUUFBSSxZQUFZLElBQUk7QUFDcEIsSUFBQUEsTUFBSyxZQUFZLEdBQUc7QUFDcEIsZ0JBQVk7QUFBQSxFQUNkO0FBRUEsYUFBVyxRQUFRLE9BQU87QUFDeEIsUUFBSSxLQUFLLEtBQUssRUFBRSxXQUFXLEtBQUssR0FBRztBQUNqQyxVQUFJLFVBQVcsV0FBVTtBQUFBLFdBQ3BCO0FBQ0gsdUJBQWU7QUFDZixrQkFBVTtBQUNWLG9CQUFZLENBQUM7QUFBQSxNQUNmO0FBQ0E7QUFBQSxJQUNGO0FBQ0EsUUFBSSxXQUFXO0FBQ2IsZ0JBQVUsS0FBSyxJQUFJO0FBQ25CO0FBQUEsSUFDRjtBQUVBLFVBQU0sVUFBVSxLQUFLLEtBQUs7QUFDMUIsUUFBSSxDQUFDLFNBQVM7QUFDWixxQkFBZTtBQUNmLGdCQUFVO0FBQ1Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxVQUFVLG9CQUFvQixLQUFLLE9BQU87QUFDaEQsUUFBSSxTQUFTO0FBQ1gscUJBQWU7QUFDZixnQkFBVTtBQUNWLFlBQU0sSUFBSSxTQUFTLGNBQWMsUUFBUSxDQUFDLEVBQUUsV0FBVyxJQUFJLE9BQU8sSUFBSTtBQUN0RSxRQUFFLFlBQVk7QUFDZCwyQkFBcUIsR0FBRyxRQUFRLENBQUMsQ0FBQztBQUNsQyxNQUFBQSxNQUFLLFlBQVksQ0FBQztBQUNsQjtBQUFBLElBQ0Y7QUFFQSxVQUFNLFlBQVksZ0JBQWdCLEtBQUssT0FBTztBQUM5QyxVQUFNLFVBQVUsbUJBQW1CLEtBQUssT0FBTztBQUMvQyxRQUFJLGFBQWEsU0FBUztBQUN4QixxQkFBZTtBQUNmLFlBQU0sY0FBYyxRQUFRLE9BQU87QUFDbkMsVUFBSSxDQUFDLFFBQVMsZUFBZSxLQUFLLFlBQVksUUFBVSxDQUFDLGVBQWUsS0FBSyxZQUFZLE1BQU87QUFDOUYsa0JBQVU7QUFDVixlQUFPLFNBQVMsY0FBYyxjQUFjLE9BQU8sSUFBSTtBQUN2RCxhQUFLLFlBQVksY0FDYiw4Q0FDQTtBQUFBLE1BQ047QUFDQSxZQUFNLEtBQUssU0FBUyxjQUFjLElBQUk7QUFDdEMsMkJBQXFCLEtBQUssYUFBYSxXQUFXLENBQUMsS0FBSyxFQUFFO0FBQzFELFdBQUssWUFBWSxFQUFFO0FBQ25CO0FBQUEsSUFDRjtBQUVBLFVBQU0sUUFBUSxhQUFhLEtBQUssT0FBTztBQUN2QyxRQUFJLE9BQU87QUFDVCxxQkFBZTtBQUNmLGdCQUFVO0FBQ1YsWUFBTSxhQUFhLFNBQVMsY0FBYyxZQUFZO0FBQ3RELGlCQUFXLFlBQVk7QUFDdkIsMkJBQXFCLFlBQVksTUFBTSxDQUFDLENBQUM7QUFDekMsTUFBQUEsTUFBSyxZQUFZLFVBQVU7QUFDM0I7QUFBQSxJQUNGO0FBRUEsY0FBVSxLQUFLLE9BQU87QUFBQSxFQUN4QjtBQUVBLGlCQUFlO0FBQ2YsWUFBVTtBQUNWLFlBQVU7QUFDVixTQUFPQTtBQUNUO0FBRUEsU0FBUyxxQkFBcUIsUUFBcUIsTUFBb0I7QUFDckUsUUFBTSxVQUFVO0FBQ2hCLE1BQUksWUFBWTtBQUNoQixhQUFXLFNBQVMsS0FBSyxTQUFTLE9BQU8sR0FBRztBQUMxQyxRQUFJLE1BQU0sVUFBVSxPQUFXO0FBQy9CLGVBQVcsUUFBUSxLQUFLLE1BQU0sV0FBVyxNQUFNLEtBQUssQ0FBQztBQUNyRCxRQUFJLE1BQU0sQ0FBQyxNQUFNLFFBQVc7QUFDMUIsWUFBTSxPQUFPLFNBQVMsY0FBYyxNQUFNO0FBQzFDLFdBQUssWUFDSDtBQUNGLFdBQUssY0FBYyxNQUFNLENBQUM7QUFDMUIsYUFBTyxZQUFZLElBQUk7QUFBQSxJQUN6QixXQUFXLE1BQU0sQ0FBQyxNQUFNLFVBQWEsTUFBTSxDQUFDLE1BQU0sUUFBVztBQUMzRCxZQUFNLElBQUksU0FBUyxjQUFjLEdBQUc7QUFDcEMsUUFBRSxZQUFZO0FBQ2QsUUFBRSxPQUFPLE1BQU0sQ0FBQztBQUNoQixRQUFFLFNBQVM7QUFDWCxRQUFFLE1BQU07QUFDUixRQUFFLGNBQWMsTUFBTSxDQUFDO0FBQ3ZCLGFBQU8sWUFBWSxDQUFDO0FBQUEsSUFDdEIsV0FBVyxNQUFNLENBQUMsTUFBTSxRQUFXO0FBQ2pDLFlBQU0sU0FBUyxTQUFTLGNBQWMsUUFBUTtBQUM5QyxhQUFPLFlBQVk7QUFDbkIsYUFBTyxjQUFjLE1BQU0sQ0FBQztBQUM1QixhQUFPLFlBQVksTUFBTTtBQUFBLElBQzNCLFdBQVcsTUFBTSxDQUFDLE1BQU0sUUFBVztBQUNqQyxZQUFNLEtBQUssU0FBUyxjQUFjLElBQUk7QUFDdEMsU0FBRyxjQUFjLE1BQU0sQ0FBQztBQUN4QixhQUFPLFlBQVksRUFBRTtBQUFBLElBQ3ZCO0FBQ0EsZ0JBQVksTUFBTSxRQUFRLE1BQU0sQ0FBQyxFQUFFO0FBQUEsRUFDckM7QUFDQSxhQUFXLFFBQVEsS0FBSyxNQUFNLFNBQVMsQ0FBQztBQUMxQztBQUVBLFNBQVMsV0FBVyxRQUFxQixNQUFvQjtBQUMzRCxNQUFJLEtBQU0sUUFBTyxZQUFZLFNBQVMsZUFBZSxJQUFJLENBQUM7QUFDNUQ7QUFFQSxTQUFTLHdCQUF3QixNQUF5QjtBQUN4RCxPQUFLLDRCQUNGLE9BQU8sNEJBQTRCLEVBQ25DLEtBQUssQ0FBQyxXQUFXO0FBQ2hCLFNBQUssY0FBYztBQUNuQix3QkFBb0IsTUFBTSxNQUF1QjtBQUFBLEVBQ25ELENBQUMsRUFDQSxNQUFNLENBQUMsTUFBTTtBQUNaLFNBQUssY0FBYztBQUNuQixTQUFLLFlBQVksVUFBVSwyQkFBMkIsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUFBLEVBQ2xFLENBQUM7QUFDTDtBQUVBLFNBQVMsb0JBQW9CLE1BQW1CLFFBQTZCO0FBQzNFLE9BQUssWUFBWSxrQkFBa0IsTUFBTSxDQUFDO0FBQzFDLGFBQVcsU0FBUyxPQUFPLFFBQVE7QUFDakMsUUFBSSxNQUFNLFdBQVcsS0FBTTtBQUMzQixTQUFLLFlBQVksZ0JBQWdCLEtBQUssQ0FBQztBQUFBLEVBQ3pDO0FBQ0Y7QUFFQSxTQUFTLGtCQUFrQixRQUFvQztBQUM3RCxRQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsTUFBSSxZQUFZO0FBQ2hCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxZQUFZLFlBQVksT0FBTyxRQUFRLE9BQU8sT0FBTyxDQUFDO0FBQzNELFFBQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUMxQyxRQUFNLFlBQVk7QUFDbEIsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWMsT0FBTztBQUMzQixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLE9BQUssY0FBYyxHQUFHLE9BQU8sT0FBTyxZQUFZLElBQUksS0FBSyxPQUFPLFNBQVMsRUFBRSxlQUFlLENBQUM7QUFDM0YsUUFBTSxZQUFZLEtBQUs7QUFDdkIsUUFBTSxZQUFZLElBQUk7QUFDdEIsT0FBSyxZQUFZLEtBQUs7QUFDdEIsTUFBSSxZQUFZLElBQUk7QUFFcEIsUUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFNBQU8sWUFBWTtBQUNuQixTQUFPO0FBQUEsSUFDTCxjQUFjLGFBQWEsTUFBTTtBQUMvQixZQUFNLE9BQU8sSUFBSTtBQUNqQixVQUFJLENBQUMsS0FBTTtBQUNYLFdBQUssY0FBYztBQUNuQixXQUFLLFlBQVksVUFBVSxvQkFBb0IsdUNBQXVDLENBQUM7QUFDdkYsOEJBQXdCLElBQUk7QUFBQSxJQUM5QixDQUFDO0FBQUEsRUFDSDtBQUNBLE1BQUksWUFBWSxNQUFNO0FBQ3RCLFNBQU87QUFDVDtBQUVBLFNBQVMsZ0JBQWdCLE9BQXdDO0FBQy9ELFFBQU0sTUFBTSxVQUFVLE1BQU0sTUFBTSxNQUFNLE1BQU07QUFDOUMsUUFBTSxPQUFPLElBQUk7QUFDakIsTUFBSSxLQUFNLE1BQUssUUFBUSxZQUFZLE1BQU0sTUFBTSxDQUFDO0FBQ2hELFNBQU87QUFDVDtBQUVBLFNBQVMsWUFBWSxRQUFpQyxPQUE2QjtBQUNqRixRQUFNLFFBQVEsU0FBUyxjQUFjLE1BQU07QUFDM0MsUUFBTSxPQUNKLFdBQVcsT0FDUCxzREFDQSxXQUFXLFNBQ1Qsd0RBQ0E7QUFDUixRQUFNLFlBQVkseUZBQXlGLElBQUk7QUFDL0csUUFBTSxjQUFjLFVBQVUsV0FBVyxPQUFPLE9BQU8sV0FBVyxTQUFTLFdBQVc7QUFDdEYsU0FBTztBQUNUO0FBRUEsU0FBUyxjQUFjLE9BQWdEO0FBQ3JFLE1BQUksQ0FBQyxNQUFPLFFBQU87QUFDbkIsUUFBTSxTQUFTLE1BQU0sZ0JBQWdCLFdBQVcsTUFBTSxhQUFhLE9BQU87QUFDMUUsUUFBTSxVQUFVLFdBQVcsSUFBSSxLQUFLLE1BQU0sU0FBUyxFQUFFLGVBQWUsQ0FBQztBQUNyRSxNQUFJLE1BQU0sTUFBTyxRQUFPLEdBQUcsTUFBTSxHQUFHLE9BQU8sSUFBSSxNQUFNLEtBQUs7QUFDMUQsU0FBTyxHQUFHLE1BQU0sR0FBRyxPQUFPO0FBQzVCO0FBRUEsU0FBUyxlQUE0QjtBQUNuQyxRQUFNLE1BQU07QUFBQSxJQUNWO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFDQSxRQUFNLFNBQVMsSUFBSSxjQUEyQiw0QkFBNEI7QUFDMUUsVUFBUTtBQUFBLElBQ04sY0FBYyxnQkFBZ0IsTUFBTTtBQUNsQyxXQUFLLDRCQUNGLE9BQU8scUJBQXFCLHdFQUF3RSxFQUNwRyxNQUFNLENBQUMsTUFBTSxLQUFLLGlDQUFpQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQUEsSUFDbEUsQ0FBQztBQUFBLEVBQ0g7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGVBQTRCO0FBQ25DLFFBQU0sTUFBTTtBQUFBLElBQ1Y7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUNBLFFBQU0sU0FBUyxJQUFJLGNBQTJCLDRCQUE0QjtBQUMxRSxVQUFRO0FBQUEsSUFDTixjQUFjLGNBQWMsTUFBTTtBQUNoQyxZQUFNLFFBQVEsbUJBQW1CLFNBQVM7QUFDMUMsWUFBTSxPQUFPO0FBQUEsUUFDWDtBQUFBLFVBQ0U7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFFBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxNQUNiO0FBQ0EsV0FBSyw0QkFBWTtBQUFBLFFBQ2Y7QUFBQSxRQUNBLDhEQUE4RCxLQUFLLFNBQVMsSUFBSTtBQUFBLE1BQ2xGO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsVUFBVSxXQUFtQixhQUFrQztBQUN0RSxRQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsTUFBSSxZQUFZO0FBQ2hCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWM7QUFDcEIsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFBWTtBQUNqQixPQUFLLGNBQWM7QUFDbkIsT0FBSyxZQUFZLEtBQUs7QUFDdEIsT0FBSyxZQUFZLElBQUk7QUFDckIsTUFBSSxZQUFZLElBQUk7QUFDcEIsUUFBTSxVQUFVLFNBQVMsY0FBYyxLQUFLO0FBQzVDLFVBQVEsUUFBUSxvQkFBb0I7QUFDcEMsVUFBUSxZQUFZO0FBQ3BCLE1BQUksWUFBWSxPQUFPO0FBQ3ZCLFNBQU87QUFDVDtBQUVBLFNBQVMsaUJBQWlCLGNBQWlDO0FBQ3pELFFBQU0sVUFBVSxrQkFBa0Isc0JBQXNCLE1BQU07QUFDNUQsU0FBSyw0QkFBWSxPQUFPLGtCQUFrQixXQUFXLENBQUM7QUFBQSxFQUN4RCxDQUFDO0FBQ0QsUUFBTSxZQUFZLGtCQUFrQixnQkFBZ0IsTUFBTTtBQUt4RCxTQUFLLDRCQUNGLE9BQU8sdUJBQXVCLEVBQzlCLE1BQU0sQ0FBQyxNQUFNLEtBQUssOEJBQThCLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFDMUQsUUFBUSxNQUFNO0FBQ2IsZUFBUyxPQUFPO0FBQUEsSUFDbEIsQ0FBQztBQUFBLEVBQ0wsQ0FBQztBQUdELFFBQU0sWUFBWSxVQUFVLGNBQWMsS0FBSztBQUMvQyxNQUFJLFdBQVc7QUFDYixjQUFVLFlBQ1I7QUFBQSxFQUlKO0FBRUEsUUFBTSxXQUFXLFNBQVMsY0FBYyxLQUFLO0FBQzdDLFdBQVMsWUFBWTtBQUNyQixXQUFTLFlBQVksU0FBUztBQUM5QixXQUFTLFlBQVksT0FBTztBQUU1QixNQUFJLE1BQU0sYUFBYSxXQUFXLEdBQUc7QUFDbkMsVUFBTSxVQUFVLFNBQVMsY0FBYyxTQUFTO0FBQ2hELFlBQVEsWUFBWTtBQUNwQixZQUFRLFlBQVksYUFBYSxvQkFBb0IsUUFBUSxDQUFDO0FBQzlELFVBQU1DLFFBQU8sWUFBWTtBQUN6QixJQUFBQSxNQUFLO0FBQUEsTUFDSDtBQUFBLFFBQ0U7QUFBQSxRQUNBLDRCQUE0QixXQUFXLENBQUM7QUFBQSxNQUMxQztBQUFBLElBQ0Y7QUFDQSxZQUFRLFlBQVlBLEtBQUk7QUFDeEIsaUJBQWEsWUFBWSxPQUFPO0FBQ2hDO0FBQUEsRUFDRjtBQUdBLFFBQU0sa0JBQWtCLG9CQUFJLElBQStCO0FBQzNELGFBQVcsS0FBSyxNQUFNLFNBQVMsT0FBTyxHQUFHO0FBQ3ZDLFVBQU0sVUFBVSxFQUFFLEdBQUcsTUFBTSxHQUFHLEVBQUUsQ0FBQztBQUNqQyxRQUFJLENBQUMsZ0JBQWdCLElBQUksT0FBTyxFQUFHLGlCQUFnQixJQUFJLFNBQVMsQ0FBQyxDQUFDO0FBQ2xFLG9CQUFnQixJQUFJLE9BQU8sRUFBRyxLQUFLLENBQUM7QUFBQSxFQUN0QztBQUVBLFFBQU0sT0FBTyxTQUFTLGNBQWMsU0FBUztBQUM3QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxZQUFZLGFBQWEsb0JBQW9CLFFBQVEsQ0FBQztBQUUzRCxRQUFNLE9BQU8sWUFBWTtBQUN6QixhQUFXLEtBQUssTUFBTSxjQUFjO0FBQ2xDLFNBQUssWUFBWSxTQUFTLEdBQUcsZ0JBQWdCLElBQUksRUFBRSxTQUFTLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUFBLEVBQ3hFO0FBQ0EsT0FBSyxZQUFZLElBQUk7QUFDckIsZUFBYSxZQUFZLElBQUk7QUFDL0I7QUFFQSxTQUFTLFNBQVMsR0FBZ0IsVUFBMEM7QUFDMUUsUUFBTSxJQUFJLEVBQUU7QUFLWixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLE1BQUksQ0FBQyxFQUFFLFFBQVMsTUFBSyxNQUFNLFVBQVU7QUFFckMsUUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFNBQU8sWUFBWTtBQUVuQixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBR2pCLFFBQU0sU0FBUyxTQUFTLGNBQWMsS0FBSztBQUMzQyxTQUFPLFlBQ0w7QUFDRixTQUFPLE1BQU0sUUFBUTtBQUNyQixTQUFPLE1BQU0sU0FBUztBQUN0QixTQUFPLE1BQU0sa0JBQWtCO0FBQy9CLE1BQUksRUFBRSxTQUFTO0FBQ2IsVUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLFFBQUksTUFBTTtBQUNWLFFBQUksWUFBWTtBQUVoQixVQUFNLFdBQVcsRUFBRSxPQUFPLENBQUMsS0FBSyxLQUFLLFlBQVk7QUFDakQsVUFBTSxXQUFXLFNBQVMsY0FBYyxNQUFNO0FBQzlDLGFBQVMsWUFBWTtBQUNyQixhQUFTLGNBQWM7QUFDdkIsV0FBTyxZQUFZLFFBQVE7QUFDM0IsUUFBSSxNQUFNLFVBQVU7QUFDcEIsUUFBSSxpQkFBaUIsUUFBUSxNQUFNO0FBQ2pDLGVBQVMsT0FBTztBQUNoQixVQUFJLE1BQU0sVUFBVTtBQUFBLElBQ3RCLENBQUM7QUFDRCxRQUFJLGlCQUFpQixTQUFTLE1BQU07QUFDbEMsVUFBSSxPQUFPO0FBQUEsSUFDYixDQUFDO0FBQ0QsU0FBSyxlQUFlLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxLQUFLLENBQUMsUUFBUTtBQUNsRCxVQUFJLElBQUssS0FBSSxNQUFNO0FBQUEsVUFDZCxLQUFJLE9BQU87QUFBQSxJQUNsQixDQUFDO0FBQ0QsV0FBTyxZQUFZLEdBQUc7QUFBQSxFQUN4QixPQUFPO0FBQ0wsVUFBTSxXQUFXLEVBQUUsT0FBTyxDQUFDLEtBQUssS0FBSyxZQUFZO0FBQ2pELFVBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxTQUFLLFlBQVk7QUFDakIsU0FBSyxjQUFjO0FBQ25CLFdBQU8sWUFBWSxJQUFJO0FBQUEsRUFDekI7QUFDQSxPQUFLLFlBQVksTUFBTTtBQUd2QixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUFZO0FBRWxCLFFBQU0sV0FBVyxTQUFTLGNBQWMsS0FBSztBQUM3QyxXQUFTLFlBQVk7QUFDckIsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFBWTtBQUNqQixPQUFLLGNBQWMsRUFBRTtBQUNyQixXQUFTLFlBQVksSUFBSTtBQUN6QixNQUFJLEVBQUUsU0FBUztBQUNiLFVBQU0sTUFBTSxTQUFTLGNBQWMsTUFBTTtBQUN6QyxRQUFJLFlBQ0Y7QUFDRixRQUFJLGNBQWMsSUFBSSxFQUFFLE9BQU87QUFDL0IsYUFBUyxZQUFZLEdBQUc7QUFBQSxFQUMxQjtBQUNBLE1BQUksRUFBRSxRQUFRLGlCQUFpQjtBQUM3QixVQUFNLFFBQVEsU0FBUyxjQUFjLE1BQU07QUFDM0MsVUFBTSxZQUNKO0FBQ0YsVUFBTSxjQUFjO0FBQ3BCLGFBQVMsWUFBWSxLQUFLO0FBQUEsRUFDNUI7QUFDQSxRQUFNLFlBQVksUUFBUTtBQUUxQixNQUFJLEVBQUUsYUFBYTtBQUNqQixVQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsU0FBSyxZQUFZO0FBQ2pCLFNBQUssY0FBYyxFQUFFO0FBQ3JCLFVBQU0sWUFBWSxJQUFJO0FBQUEsRUFDeEI7QUFFQSxRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLFFBQU0sV0FBVyxhQUFhLEVBQUUsTUFBTTtBQUN0QyxNQUFJLFNBQVUsTUFBSyxZQUFZLFFBQVE7QUFDdkMsTUFBSSxFQUFFLFlBQVk7QUFDaEIsUUFBSSxLQUFLLFNBQVMsU0FBUyxFQUFHLE1BQUssWUFBWSxJQUFJLENBQUM7QUFDcEQsVUFBTSxPQUFPLFNBQVMsY0FBYyxRQUFRO0FBQzVDLFNBQUssT0FBTztBQUNaLFNBQUssWUFBWTtBQUNqQixTQUFLLGNBQWMsRUFBRTtBQUNyQixTQUFLLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUNwQyxRQUFFLGVBQWU7QUFDakIsUUFBRSxnQkFBZ0I7QUFDbEIsV0FBSyw0QkFBWSxPQUFPLHlCQUF5QixzQkFBc0IsRUFBRSxVQUFVLEVBQUU7QUFBQSxJQUN2RixDQUFDO0FBQ0QsU0FBSyxZQUFZLElBQUk7QUFBQSxFQUN2QjtBQUNBLE1BQUksRUFBRSxVQUFVO0FBQ2QsUUFBSSxLQUFLLFNBQVMsU0FBUyxFQUFHLE1BQUssWUFBWSxJQUFJLENBQUM7QUFDcEQsVUFBTSxPQUFPLFNBQVMsY0FBYyxHQUFHO0FBQ3ZDLFNBQUssT0FBTyxFQUFFO0FBQ2QsU0FBSyxTQUFTO0FBQ2QsU0FBSyxNQUFNO0FBQ1gsU0FBSyxZQUFZO0FBQ2pCLFNBQUssY0FBYztBQUNuQixTQUFLLFlBQVksSUFBSTtBQUFBLEVBQ3ZCO0FBQ0EsTUFBSSxLQUFLLFNBQVMsU0FBUyxFQUFHLE9BQU0sWUFBWSxJQUFJO0FBR3BELE1BQUksRUFBRSxRQUFRLEVBQUUsS0FBSyxTQUFTLEdBQUc7QUFDL0IsVUFBTSxVQUFVLFNBQVMsY0FBYyxLQUFLO0FBQzVDLFlBQVEsWUFBWTtBQUNwQixlQUFXLE9BQU8sRUFBRSxNQUFNO0FBQ3hCLFlBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxXQUFLLFlBQ0g7QUFDRixXQUFLLGNBQWM7QUFDbkIsY0FBUSxZQUFZLElBQUk7QUFBQSxJQUMxQjtBQUNBLFVBQU0sWUFBWSxPQUFPO0FBQUEsRUFDM0I7QUFFQSxPQUFLLFlBQVksS0FBSztBQUN0QixTQUFPLFlBQVksSUFBSTtBQUd2QixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUFZO0FBQ2xCLE1BQUksRUFBRSxRQUFRLG1CQUFtQixFQUFFLE9BQU8sWUFBWTtBQUNwRCxVQUFNO0FBQUEsTUFDSixjQUFjLGtCQUFrQixNQUFNO0FBQ3BDLGFBQUssNEJBQVksT0FBTyx5QkFBeUIsRUFBRSxPQUFRLFVBQVU7QUFBQSxNQUN2RSxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFDQSxRQUFNO0FBQUEsSUFDSixjQUFjLEVBQUUsU0FBUyxPQUFPLFNBQVM7QUFDdkMsWUFBTSw0QkFBWSxPQUFPLDZCQUE2QixFQUFFLElBQUksSUFBSTtBQUFBLElBR2xFLENBQUM7QUFBQSxFQUNIO0FBQ0EsU0FBTyxZQUFZLEtBQUs7QUFFeEIsT0FBSyxZQUFZLE1BQU07QUFJdkIsTUFBSSxFQUFFLFdBQVcsU0FBUyxTQUFTLEdBQUc7QUFDcEMsVUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFdBQU8sWUFDTDtBQUNGLGVBQVcsS0FBSyxVQUFVO0FBQ3hCLFlBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxXQUFLLFlBQVk7QUFDakIsVUFBSTtBQUNGLFVBQUUsT0FBTyxJQUFJO0FBQUEsTUFDZixTQUFTLEdBQUc7QUFDVixhQUFLLGNBQWMsa0NBQW1DLEVBQVksT0FBTztBQUFBLE1BQzNFO0FBQ0EsYUFBTyxZQUFZLElBQUk7QUFBQSxJQUN6QjtBQUNBLFNBQUssWUFBWSxNQUFNO0FBQUEsRUFDekI7QUFFQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGFBQWEsUUFBcUQ7QUFDekUsTUFBSSxDQUFDLE9BQVEsUUFBTztBQUNwQixRQUFNLE9BQU8sU0FBUyxjQUFjLE1BQU07QUFDMUMsT0FBSyxZQUFZO0FBQ2pCLE1BQUksT0FBTyxXQUFXLFVBQVU7QUFDOUIsU0FBSyxjQUFjLE1BQU0sTUFBTTtBQUMvQixXQUFPO0FBQUEsRUFDVDtBQUNBLE9BQUssWUFBWSxTQUFTLGVBQWUsS0FBSyxDQUFDO0FBQy9DLE1BQUksT0FBTyxLQUFLO0FBQ2QsVUFBTSxJQUFJLFNBQVMsY0FBYyxHQUFHO0FBQ3BDLE1BQUUsT0FBTyxPQUFPO0FBQ2hCLE1BQUUsU0FBUztBQUNYLE1BQUUsTUFBTTtBQUNSLE1BQUUsWUFBWTtBQUNkLE1BQUUsY0FBYyxPQUFPO0FBQ3ZCLFNBQUssWUFBWSxDQUFDO0FBQUEsRUFDcEIsT0FBTztBQUNMLFVBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxTQUFLLGNBQWMsT0FBTztBQUMxQixTQUFLLFlBQVksSUFBSTtBQUFBLEVBQ3ZCO0FBQ0EsU0FBTztBQUNUO0FBS0EsU0FBUyxXQUNQLE9BQ0EsVUFDMkU7QUFDM0UsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUVsQixRQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUs7QUFDNUMsVUFBUSxZQUNOO0FBQ0YsUUFBTSxZQUFZLE9BQU87QUFFekIsUUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFNBQU8sWUFBWTtBQUNuQixRQUFNLFlBQVksTUFBTTtBQUV4QixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUNKO0FBQ0YsU0FBTyxZQUFZLEtBQUs7QUFFeEIsUUFBTSxhQUFhLFNBQVMsY0FBYyxLQUFLO0FBQy9DLGFBQVcsWUFBWTtBQUN2QixRQUFNLGNBQWMsU0FBUyxjQUFjLEtBQUs7QUFDaEQsY0FBWSxZQUFZO0FBQ3hCLFFBQU0sVUFBVSxTQUFTLGNBQWMsS0FBSztBQUM1QyxVQUFRLFlBQVk7QUFDcEIsVUFBUSxjQUFjO0FBQ3RCLGNBQVksWUFBWSxPQUFPO0FBQy9CLE1BQUk7QUFDSixNQUFJLFVBQVU7QUFDWixVQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsUUFBSSxZQUFZO0FBQ2hCLFFBQUksY0FBYztBQUNsQixnQkFBWSxZQUFZLEdBQUc7QUFDM0Isc0JBQWtCO0FBQUEsRUFDcEI7QUFDQSxhQUFXLFlBQVksV0FBVztBQUNsQyxRQUFNLFlBQVksVUFBVTtBQUU1QixRQUFNLGVBQWUsU0FBUyxjQUFjLEtBQUs7QUFDakQsZUFBYSxZQUFZO0FBQ3pCLFFBQU0sWUFBWSxZQUFZO0FBRTlCLFNBQU8sRUFBRSxPQUFPLGNBQWMsVUFBVSxnQkFBZ0I7QUFDMUQ7QUFFQSxTQUFTLGFBQWEsTUFBYyxVQUFxQztBQUN2RSxRQUFNLFdBQVcsU0FBUyxjQUFjLEtBQUs7QUFDN0MsV0FBUyxZQUNQO0FBQ0YsUUFBTSxhQUFhLFNBQVMsY0FBYyxLQUFLO0FBQy9DLGFBQVcsWUFBWTtBQUN2QixRQUFNLElBQUksU0FBUyxjQUFjLEtBQUs7QUFDdEMsSUFBRSxZQUFZO0FBQ2QsSUFBRSxjQUFjO0FBQ2hCLGFBQVcsWUFBWSxDQUFDO0FBQ3hCLFdBQVMsWUFBWSxVQUFVO0FBQy9CLE1BQUksVUFBVTtBQUNaLFVBQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUMxQyxVQUFNLFlBQVk7QUFDbEIsVUFBTSxZQUFZLFFBQVE7QUFDMUIsYUFBUyxZQUFZLEtBQUs7QUFBQSxFQUM1QjtBQUNBLFNBQU87QUFDVDtBQU1BLFNBQVMsa0JBQWtCLE9BQWUsU0FBd0M7QUFDaEYsUUFBTSxNQUFNLFNBQVMsY0FBYyxRQUFRO0FBQzNDLE1BQUksT0FBTztBQUNYLE1BQUksWUFDRjtBQUNGLE1BQUksWUFDRixHQUFHLEtBQUs7QUFJVixNQUFJLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUNuQyxNQUFFLGVBQWU7QUFDakIsTUFBRSxnQkFBZ0I7QUFDbEIsWUFBUTtBQUFBLEVBQ1YsQ0FBQztBQUNELFNBQU87QUFDVDtBQUVBLFNBQVMsY0FBYyxPQUFlLFNBQXdDO0FBQzVFLFFBQU0sTUFBTSxTQUFTLGNBQWMsUUFBUTtBQUMzQyxNQUFJLE9BQU87QUFDWCxNQUFJLFlBQ0Y7QUFDRixNQUFJLGNBQWM7QUFDbEIsTUFBSSxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDbkMsTUFBRSxlQUFlO0FBQ2pCLE1BQUUsZ0JBQWdCO0FBQ2xCLFlBQVE7QUFBQSxFQUNWLENBQUM7QUFDRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGNBQTJCO0FBQ2xDLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQ0g7QUFDRixPQUFLO0FBQUEsSUFDSDtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxVQUFVLE9BQTJCLGFBQW1DO0FBQy9FLFFBQU0sTUFBTSxTQUFTLGNBQWMsS0FBSztBQUN4QyxNQUFJLFlBQVk7QUFDaEIsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFBWTtBQUNqQixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUFZO0FBQ2xCLE1BQUksT0FBTztBQUNULFVBQU0sSUFBSSxTQUFTLGNBQWMsS0FBSztBQUN0QyxNQUFFLFlBQVk7QUFDZCxNQUFFLGNBQWM7QUFDaEIsVUFBTSxZQUFZLENBQUM7QUFBQSxFQUNyQjtBQUNBLE1BQUksYUFBYTtBQUNmLFVBQU0sSUFBSSxTQUFTLGNBQWMsS0FBSztBQUN0QyxNQUFFLFlBQVk7QUFDZCxNQUFFLGNBQWM7QUFDaEIsVUFBTSxZQUFZLENBQUM7QUFBQSxFQUNyQjtBQUNBLE9BQUssWUFBWSxLQUFLO0FBQ3RCLE1BQUksWUFBWSxJQUFJO0FBQ3BCLFNBQU87QUFDVDtBQU1BLFNBQVMsY0FDUCxTQUNBLFVBQ21CO0FBQ25CLFFBQU0sTUFBTSxTQUFTLGNBQWMsUUFBUTtBQUMzQyxNQUFJLE9BQU87QUFDWCxNQUFJLGFBQWEsUUFBUSxRQUFRO0FBRWpDLFFBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxRQUFNLE9BQU8sU0FBUyxjQUFjLE1BQU07QUFDMUMsT0FBSyxZQUNIO0FBQ0YsT0FBSyxZQUFZLElBQUk7QUFFckIsUUFBTSxRQUFRLENBQUMsT0FBc0I7QUFDbkMsUUFBSSxhQUFhLGdCQUFnQixPQUFPLEVBQUUsQ0FBQztBQUMzQyxRQUFJLFFBQVEsUUFBUSxLQUFLLFlBQVk7QUFDckMsUUFBSSxZQUNGO0FBQ0YsU0FBSyxZQUFZLDJHQUNmLEtBQUsseUJBQXlCLHdCQUNoQztBQUNBLFNBQUssUUFBUSxRQUFRLEtBQUssWUFBWTtBQUN0QyxTQUFLLFFBQVEsUUFBUSxLQUFLLFlBQVk7QUFDdEMsU0FBSyxNQUFNLFlBQVksS0FBSyxxQkFBcUI7QUFBQSxFQUNuRDtBQUNBLFFBQU0sT0FBTztBQUViLE1BQUksWUFBWSxJQUFJO0FBQ3BCLE1BQUksaUJBQWlCLFNBQVMsT0FBTyxNQUFNO0FBQ3pDLE1BQUUsZUFBZTtBQUNqQixNQUFFLGdCQUFnQjtBQUNsQixVQUFNLE9BQU8sSUFBSSxhQUFhLGNBQWMsTUFBTTtBQUNsRCxVQUFNLElBQUk7QUFDVixRQUFJLFdBQVc7QUFDZixRQUFJO0FBQ0YsWUFBTSxTQUFTLElBQUk7QUFBQSxJQUNyQixVQUFFO0FBQ0EsVUFBSSxXQUFXO0FBQUEsSUFDakI7QUFBQSxFQUNGLENBQUM7QUFDRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLE1BQW1CO0FBQzFCLFFBQU0sSUFBSSxTQUFTLGNBQWMsTUFBTTtBQUN2QyxJQUFFLFlBQVk7QUFDZCxJQUFFLGNBQWM7QUFDaEIsU0FBTztBQUNUO0FBSUEsU0FBUyxnQkFBd0I7QUFFL0IsU0FDRTtBQU9KO0FBRUEsU0FBUyxnQkFBd0I7QUFFL0IsU0FDRTtBQUtKO0FBRUEsU0FBUyxxQkFBNkI7QUFFcEMsU0FDRTtBQU1KO0FBRUEsZUFBZSxlQUNiLEtBQ0EsVUFDd0I7QUFDeEIsTUFBSSxtQkFBbUIsS0FBSyxHQUFHLEVBQUcsUUFBTztBQUd6QyxRQUFNLE1BQU0sSUFBSSxXQUFXLElBQUksSUFBSSxJQUFJLE1BQU0sQ0FBQyxJQUFJO0FBQ2xELE1BQUk7QUFDRixXQUFRLE1BQU0sNEJBQVk7QUFBQSxNQUN4QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLEVBQ0YsU0FBUyxHQUFHO0FBQ1YsU0FBSyxvQkFBb0IsRUFBRSxLQUFLLFVBQVUsS0FBSyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQzFELFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFJQSxTQUFTLHdCQUE0QztBQUVuRCxRQUFNLFFBQVEsTUFBTTtBQUFBLElBQ2xCLFNBQVMsaUJBQW9DLHVCQUF1QjtBQUFBLEVBQ3RFO0FBQ0EsTUFBSSxNQUFNLFVBQVUsR0FBRztBQUNyQixRQUFJLE9BQTJCLE1BQU0sQ0FBQyxFQUFFO0FBQ3hDLFdBQU8sTUFBTTtBQUNYLFlBQU0sU0FBUyxLQUFLLGlCQUFpQix1QkFBdUI7QUFDNUQsVUFBSSxPQUFPLFVBQVUsS0FBSyxJQUFJLEdBQUcsTUFBTSxTQUFTLENBQUMsRUFBRyxRQUFPO0FBQzNELGFBQU8sS0FBSztBQUFBLElBQ2Q7QUFBQSxFQUNGO0FBR0EsUUFBTSxRQUFRO0FBQUEsSUFDWjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0EsUUFBTSxVQUF5QixDQUFDO0FBQ2hDLFFBQU0sTUFBTSxTQUFTO0FBQUEsSUFDbkI7QUFBQSxFQUNGO0FBQ0EsYUFBV0MsT0FBTSxNQUFNLEtBQUssR0FBRyxHQUFHO0FBQ2hDLFVBQU0sS0FBS0EsSUFBRyxlQUFlLElBQUksS0FBSztBQUN0QyxRQUFJLEVBQUUsU0FBUyxHQUFJO0FBQ25CLFFBQUksTUFBTSxLQUFLLENBQUMsTUFBTSxNQUFNLENBQUMsRUFBRyxTQUFRLEtBQUtBLEdBQUU7QUFDL0MsUUFBSSxRQUFRLFNBQVMsR0FBSTtBQUFBLEVBQzNCO0FBQ0EsTUFBSSxRQUFRLFVBQVUsR0FBRztBQUN2QixRQUFJLE9BQTJCLFFBQVEsQ0FBQyxFQUFFO0FBQzFDLFdBQU8sTUFBTTtBQUNYLFVBQUksUUFBUTtBQUNaLGlCQUFXLEtBQUssUUFBUyxLQUFJLEtBQUssU0FBUyxDQUFDLEVBQUc7QUFDL0MsVUFBSSxTQUFTLEtBQUssSUFBSSxHQUFHLFFBQVEsTUFBTSxFQUFHLFFBQU87QUFDakQsYUFBTyxLQUFLO0FBQUEsSUFDZDtBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGtCQUFzQztBQUM3QyxRQUFNLFVBQVUsc0JBQXNCO0FBQ3RDLE1BQUksQ0FBQyxRQUFTLFFBQU87QUFDckIsTUFBSSxTQUFTLFFBQVE7QUFDckIsU0FBTyxRQUFRO0FBQ2IsZUFBVyxTQUFTLE1BQU0sS0FBSyxPQUFPLFFBQVEsR0FBb0I7QUFDaEUsVUFBSSxVQUFVLFdBQVcsTUFBTSxTQUFTLE9BQU8sRUFBRztBQUNsRCxZQUFNLElBQUksTUFBTSxzQkFBc0I7QUFDdEMsVUFBSSxFQUFFLFFBQVEsT0FBTyxFQUFFLFNBQVMsSUFBSyxRQUFPO0FBQUEsSUFDOUM7QUFDQSxhQUFTLE9BQU87QUFBQSxFQUNsQjtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsZUFBcUI7QUFDNUIsTUFBSTtBQUNGLFVBQU0sVUFBVSxzQkFBc0I7QUFDdEMsUUFBSSxXQUFXLENBQUMsTUFBTSxlQUFlO0FBQ25DLFlBQU0sZ0JBQWdCO0FBQ3RCLFlBQU0sU0FBUyxRQUFRLGlCQUFpQjtBQUN4QyxXQUFLLHNCQUFzQixPQUFPLFVBQVUsTUFBTSxHQUFHLElBQUssQ0FBQztBQUFBLElBQzdEO0FBQ0EsVUFBTSxVQUFVLGdCQUFnQjtBQUNoQyxRQUFJLENBQUMsU0FBUztBQUNaLFVBQUksTUFBTSxnQkFBZ0IsU0FBUyxNQUFNO0FBQ3ZDLGNBQU0sY0FBYyxTQUFTO0FBQzdCLGFBQUssMEJBQTBCO0FBQUEsVUFDN0IsS0FBSyxTQUFTO0FBQUEsVUFDZCxTQUFTLFVBQVUsU0FBUyxPQUFPLElBQUk7QUFBQSxRQUN6QyxDQUFDO0FBQUEsTUFDSDtBQUNBO0FBQUEsSUFDRjtBQUNBLFFBQUksUUFBNEI7QUFDaEMsZUFBVyxTQUFTLE1BQU0sS0FBSyxRQUFRLFFBQVEsR0FBb0I7QUFDakUsVUFBSSxNQUFNLFFBQVEsWUFBWSxlQUFnQjtBQUM5QyxVQUFJLE1BQU0sTUFBTSxZQUFZLE9BQVE7QUFDcEMsY0FBUTtBQUNSO0FBQUEsSUFDRjtBQUNBLFVBQU0sWUFBWSxVQUNkLE1BQU0sS0FBSyxRQUFRLGlCQUE4QixXQUFXLENBQUMsRUFBRTtBQUFBLE1BQzdELENBQUMsTUFDQyxFQUFFLGFBQWEsY0FBYyxNQUFNLFVBQ25DLEVBQUUsYUFBYSxhQUFhLE1BQU0sVUFDbEMsRUFBRSxhQUFhLGVBQWUsTUFBTSxVQUNwQyxFQUFFLFVBQVUsU0FBUyxRQUFRO0FBQUEsSUFDakMsSUFDQTtBQUNKLFVBQU0sVUFBVSxPQUFPO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBQ0EsVUFBTSxjQUFjLEdBQUcsV0FBVyxlQUFlLEVBQUUsSUFBSSxTQUFTLGVBQWUsRUFBRSxJQUFJLE9BQU8sU0FBUyxVQUFVLENBQUM7QUFDaEgsUUFBSSxNQUFNLGdCQUFnQixZQUFhO0FBQ3ZDLFVBQU0sY0FBYztBQUNwQixTQUFLLGFBQWE7QUFBQSxNQUNoQixLQUFLLFNBQVM7QUFBQSxNQUNkLFdBQVcsV0FBVyxhQUFhLEtBQUssS0FBSztBQUFBLE1BQzdDLFNBQVMsU0FBUyxhQUFhLEtBQUssS0FBSztBQUFBLE1BQ3pDLFNBQVMsU0FBUyxPQUFPO0FBQUEsSUFDM0IsQ0FBQztBQUNELFFBQUksT0FBTztBQUNULFlBQU0sT0FBTyxNQUFNO0FBQ25CO0FBQUEsUUFDRSxxQkFBcUIsV0FBVyxhQUFhLEtBQUssS0FBSyxHQUFHO0FBQUEsUUFDMUQsS0FBSyxNQUFNLEdBQUcsSUFBSztBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUFBLEVBQ0YsU0FBUyxHQUFHO0FBQ1YsU0FBSyxvQkFBb0IsT0FBTyxDQUFDLENBQUM7QUFBQSxFQUNwQztBQUNGO0FBRUEsU0FBUyxTQUFTQSxLQUEwQztBQUMxRCxTQUFPO0FBQUEsSUFDTCxLQUFLQSxJQUFHO0FBQUEsSUFDUixLQUFLQSxJQUFHLFVBQVUsTUFBTSxHQUFHLEdBQUc7QUFBQSxJQUM5QixJQUFJQSxJQUFHLE1BQU07QUFBQSxJQUNiLFVBQVVBLElBQUcsU0FBUztBQUFBLElBQ3RCLE9BQU8sTUFBTTtBQUNYLFlBQU0sSUFBSUEsSUFBRyxzQkFBc0I7QUFDbkMsYUFBTyxFQUFFLEdBQUcsS0FBSyxNQUFNLEVBQUUsS0FBSyxHQUFHLEdBQUcsS0FBSyxNQUFNLEVBQUUsTUFBTSxFQUFFO0FBQUEsSUFDM0QsR0FBRztBQUFBLEVBQ0w7QUFDRjtBQUVBLFNBQVMsYUFBcUI7QUFDNUIsU0FDRyxPQUEwRCwwQkFDM0Q7QUFFSjs7O0FDcjdEQSxJQUFBQyxtQkFBNEI7QUFtQzVCLElBQU0sU0FBUyxvQkFBSSxJQUFtQztBQUN0RCxJQUFJLGNBQWdDO0FBRXBDLGVBQXNCLGlCQUFnQztBQUNwRCxRQUFNLFNBQVUsTUFBTSw2QkFBWSxPQUFPLHFCQUFxQjtBQUM5RCxRQUFNLFFBQVMsTUFBTSw2QkFBWSxPQUFPLG9CQUFvQjtBQUM1RCxnQkFBYztBQUlkLGtCQUFnQixNQUFNO0FBRXRCLEVBQUMsT0FBMEQseUJBQ3pELE1BQU07QUFFUixhQUFXLEtBQUssUUFBUTtBQUN0QixRQUFJLEVBQUUsU0FBUyxVQUFVLE9BQVE7QUFDakMsUUFBSSxDQUFDLEVBQUUsWUFBYTtBQUNwQixRQUFJLENBQUMsRUFBRSxRQUFTO0FBQ2hCLFFBQUk7QUFDRixZQUFNLFVBQVUsR0FBRyxLQUFLO0FBQUEsSUFDMUIsU0FBUyxHQUFHO0FBQ1YsY0FBUSxNQUFNLHVDQUF1QyxFQUFFLFNBQVMsSUFBSSxDQUFDO0FBQUEsSUFDdkU7QUFBQSxFQUNGO0FBRUEsVUFBUTtBQUFBLElBQ04seUNBQXlDLE9BQU8sSUFBSTtBQUFBLElBQ3BELENBQUMsR0FBRyxPQUFPLEtBQUssQ0FBQyxFQUFFLEtBQUssSUFBSSxLQUFLO0FBQUEsRUFDbkM7QUFDQSwrQkFBWTtBQUFBLElBQ1Y7QUFBQSxJQUNBO0FBQUEsSUFDQSx3QkFBd0IsT0FBTyxJQUFJLGNBQWMsQ0FBQyxHQUFHLE9BQU8sS0FBSyxDQUFDLEVBQUUsS0FBSyxJQUFJLEtBQUssUUFBUTtBQUFBLEVBQzVGO0FBQ0Y7QUFPTyxTQUFTLG9CQUEwQjtBQUN4QyxhQUFXLENBQUMsSUFBSSxDQUFDLEtBQUssUUFBUTtBQUM1QixRQUFJO0FBQ0YsUUFBRSxPQUFPO0FBQUEsSUFDWCxTQUFTLEdBQUc7QUFDVixjQUFRLEtBQUssdUNBQXVDLElBQUksQ0FBQztBQUFBLElBQzNEO0FBQUEsRUFDRjtBQUNBLFNBQU8sTUFBTTtBQUNiLGdCQUFjO0FBQ2hCO0FBRUEsZUFBZSxVQUFVLEdBQWdCLE9BQWlDO0FBQ3hFLFFBQU0sU0FBVSxNQUFNLDZCQUFZO0FBQUEsSUFDaEM7QUFBQSxJQUNBLEVBQUU7QUFBQSxFQUNKO0FBS0EsUUFBTUMsVUFBUyxFQUFFLFNBQVMsQ0FBQyxFQUFpQztBQUM1RCxRQUFNQyxXQUFVRCxRQUFPO0FBRXZCLFFBQU0sS0FBSyxJQUFJO0FBQUEsSUFDYjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxHQUFHLE1BQU07QUFBQSxnQ0FBbUMsbUJBQW1CLEVBQUUsU0FBUyxFQUFFLENBQUMsSUFBSSxtQkFBbUIsRUFBRSxLQUFLLENBQUM7QUFBQSxFQUM5RztBQUNBLEtBQUdBLFNBQVFDLFVBQVMsT0FBTztBQUMzQixRQUFNLE1BQU1ELFFBQU87QUFDbkIsUUFBTSxRQUFnQixJQUE0QixXQUFZO0FBQzlELE1BQUksT0FBTyxPQUFPLFVBQVUsWUFBWTtBQUN0QyxVQUFNLElBQUksTUFBTSxTQUFTLEVBQUUsU0FBUyxFQUFFLGlCQUFpQjtBQUFBLEVBQ3pEO0FBQ0EsUUFBTSxNQUFNLGdCQUFnQixFQUFFLFVBQVUsS0FBSztBQUM3QyxRQUFNLE1BQU0sTUFBTSxHQUFHO0FBQ3JCLFNBQU8sSUFBSSxFQUFFLFNBQVMsSUFBSSxFQUFFLE1BQU0sTUFBTSxNQUFNLEtBQUssS0FBSyxFQUFFLENBQUM7QUFDN0Q7QUFFQSxTQUFTLGdCQUFnQixVQUF5QixPQUE0QjtBQUM1RSxRQUFNLEtBQUssU0FBUztBQUNwQixRQUFNLE1BQU0sQ0FBQyxVQUErQyxNQUFpQjtBQUMzRSxVQUFNLFlBQ0osVUFBVSxVQUFVLFFBQVEsUUFDMUIsVUFBVSxTQUFTLFFBQVEsT0FDM0IsVUFBVSxVQUFVLFFBQVEsUUFDNUIsUUFBUTtBQUNaLGNBQVUsb0JBQW9CLEVBQUUsS0FBSyxHQUFHLENBQUM7QUFHekMsUUFBSTtBQUNGLFlBQU0sUUFBUSxFQUFFLElBQUksQ0FBQyxNQUFNO0FBQ3pCLFlBQUksT0FBTyxNQUFNLFNBQVUsUUFBTztBQUNsQyxZQUFJLGFBQWEsTUFBTyxRQUFPLEdBQUcsRUFBRSxJQUFJLEtBQUssRUFBRSxPQUFPO0FBQ3RELFlBQUk7QUFBRSxpQkFBTyxLQUFLLFVBQVUsQ0FBQztBQUFBLFFBQUcsUUFBUTtBQUFFLGlCQUFPLE9BQU8sQ0FBQztBQUFBLFFBQUc7QUFBQSxNQUM5RCxDQUFDO0FBQ0QsbUNBQVk7QUFBQSxRQUNWO0FBQUEsUUFDQTtBQUFBLFFBQ0EsVUFBVSxFQUFFLEtBQUssTUFBTSxLQUFLLEdBQUcsQ0FBQztBQUFBLE1BQ2xDO0FBQUEsSUFDRixRQUFRO0FBQUEsSUFFUjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLE1BQU0sU0FBUyxhQUFhLFNBQVMsY0FBYyxJQUFJLFlBQVksSUFBSTtBQUU3RSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsU0FBUztBQUFBLElBQ1QsS0FBSztBQUFBLE1BQ0gsT0FBTyxJQUFJLE1BQU0sSUFBSSxTQUFTLEdBQUcsQ0FBQztBQUFBLE1BQ2xDLE1BQU0sSUFBSSxNQUFNLElBQUksUUFBUSxHQUFHLENBQUM7QUFBQSxNQUNoQyxNQUFNLElBQUksTUFBTSxJQUFJLFFBQVEsR0FBRyxDQUFDO0FBQUEsTUFDaEMsT0FBTyxJQUFJLE1BQU0sSUFBSSxTQUFTLEdBQUcsQ0FBQztBQUFBLElBQ3BDO0FBQUEsSUFDQSxTQUFTLGdCQUFnQixFQUFFO0FBQUEsSUFDM0IsVUFBVTtBQUFBLE1BQ1IsVUFBVSxDQUFDLE1BQU0sZ0JBQWdCLEVBQUUsR0FBRyxHQUFHLElBQUksR0FBRyxFQUFFLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQztBQUFBLE1BQzlELGNBQWMsQ0FBQyxNQUNiLGFBQWEsSUFBSSxVQUFVLEVBQUUsR0FBRyxHQUFHLElBQUksR0FBRyxFQUFFLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQztBQUFBLElBQzVEO0FBQUEsSUFDQSxPQUFPO0FBQUEsTUFDTCxVQUFVLENBQUMsTUFBTSxhQUFhLENBQUM7QUFBQSxNQUMvQixpQkFBaUIsQ0FBQyxHQUFHLFNBQVM7QUFDNUIsWUFBSSxJQUFJLGFBQWEsQ0FBQztBQUN0QixlQUFPLEdBQUc7QUFDUixnQkFBTSxJQUFJLEVBQUU7QUFDWixjQUFJLE1BQU0sRUFBRSxnQkFBZ0IsUUFBUSxFQUFFLFNBQVMsTUFBTyxRQUFPO0FBQzdELGNBQUksRUFBRTtBQUFBLFFBQ1I7QUFDQSxlQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsZ0JBQWdCLENBQUMsS0FBSyxZQUFZLFFBQ2hDLElBQUksUUFBUSxDQUFDLFNBQVMsV0FBVztBQUMvQixjQUFNLFdBQVcsU0FBUyxjQUFjLEdBQUc7QUFDM0MsWUFBSSxTQUFVLFFBQU8sUUFBUSxRQUFRO0FBQ3JDLGNBQU0sV0FBVyxLQUFLLElBQUksSUFBSTtBQUM5QixjQUFNLE1BQU0sSUFBSSxpQkFBaUIsTUFBTTtBQUNyQyxnQkFBTUUsTUFBSyxTQUFTLGNBQWMsR0FBRztBQUNyQyxjQUFJQSxLQUFJO0FBQ04sZ0JBQUksV0FBVztBQUNmLG9CQUFRQSxHQUFFO0FBQUEsVUFDWixXQUFXLEtBQUssSUFBSSxJQUFJLFVBQVU7QUFDaEMsZ0JBQUksV0FBVztBQUNmLG1CQUFPLElBQUksTUFBTSx1QkFBdUIsR0FBRyxFQUFFLENBQUM7QUFBQSxVQUNoRDtBQUFBLFFBQ0YsQ0FBQztBQUNELFlBQUksUUFBUSxTQUFTLGlCQUFpQixFQUFFLFdBQVcsTUFBTSxTQUFTLEtBQUssQ0FBQztBQUFBLE1BQzFFLENBQUM7QUFBQSxJQUNMO0FBQUEsSUFDQSxLQUFLO0FBQUEsTUFDSCxJQUFJLENBQUMsR0FBRyxNQUFNO0FBQ1osY0FBTSxVQUFVLENBQUMsT0FBZ0IsU0FBb0IsRUFBRSxHQUFHLElBQUk7QUFDOUQscUNBQVksR0FBRyxXQUFXLEVBQUUsSUFBSSxDQUFDLElBQUksT0FBTztBQUM1QyxlQUFPLE1BQU0sNkJBQVksZUFBZSxXQUFXLEVBQUUsSUFBSSxDQUFDLElBQUksT0FBTztBQUFBLE1BQ3ZFO0FBQUEsTUFDQSxNQUFNLENBQUMsTUFBTSxTQUFTLDZCQUFZLEtBQUssV0FBVyxFQUFFLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSTtBQUFBLE1BQ3BFLFFBQVEsQ0FBSSxNQUFjLFNBQ3hCLDZCQUFZLE9BQU8sV0FBVyxFQUFFLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSTtBQUFBLElBQ3BEO0FBQUEsSUFDQSxJQUFJLFdBQVcsSUFBSSxLQUFLO0FBQUEsSUFDeEIsR0FBSSxNQUFNLEVBQUUsSUFBSSxJQUFJLENBQUM7QUFBQSxFQUN2QjtBQUNGO0FBRUEsU0FBUyxnQkFBZ0IsSUFBWTtBQUNuQyxRQUFNLE1BQU0sbUJBQW1CLEVBQUU7QUFDakMsUUFBTSxPQUFPLE1BQStCO0FBQzFDLFFBQUk7QUFDRixhQUFPLEtBQUssTUFBTSxhQUFhLFFBQVEsR0FBRyxLQUFLLElBQUk7QUFBQSxJQUNyRCxRQUFRO0FBQ04sYUFBTyxDQUFDO0FBQUEsSUFDVjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLFFBQVEsQ0FBQyxNQUNiLGFBQWEsUUFBUSxLQUFLLEtBQUssVUFBVSxDQUFDLENBQUM7QUFDN0MsU0FBTztBQUFBLElBQ0wsS0FBSyxDQUFJLEdBQVcsTUFBVyxLQUFLLEtBQUssSUFBSyxLQUFLLEVBQUUsQ0FBQyxJQUFXO0FBQUEsSUFDakUsS0FBSyxDQUFDLEdBQVcsTUFBZTtBQUM5QixZQUFNLElBQUksS0FBSztBQUNmLFFBQUUsQ0FBQyxJQUFJO0FBQ1AsWUFBTSxDQUFDO0FBQUEsSUFDVDtBQUFBLElBQ0EsUUFBUSxDQUFDLE1BQWM7QUFDckIsWUFBTSxJQUFJLEtBQUs7QUFDZixhQUFPLEVBQUUsQ0FBQztBQUNWLFlBQU0sQ0FBQztBQUFBLElBQ1Q7QUFBQSxJQUNBLEtBQUssTUFBTSxLQUFLO0FBQUEsRUFDbEI7QUFDRjtBQUVBLFNBQVMsV0FBVyxJQUFZLFFBQW1CO0FBRWpELFNBQU87QUFBQSxJQUNMLFNBQVMsdUJBQXVCLEVBQUU7QUFBQSxJQUNsQyxNQUFNLENBQUMsTUFDTCw2QkFBWSxPQUFPLG9CQUFvQixRQUFRLElBQUksQ0FBQztBQUFBLElBQ3RELE9BQU8sQ0FBQyxHQUFXLE1BQ2pCLDZCQUFZLE9BQU8sb0JBQW9CLFNBQVMsSUFBSSxHQUFHLENBQUM7QUFBQSxJQUMxRCxRQUFRLENBQUMsTUFDUCw2QkFBWSxPQUFPLG9CQUFvQixVQUFVLElBQUksQ0FBQztBQUFBLEVBQzFEO0FBQ0Y7QUFFQSxTQUFTLGNBQWM7QUFDckIsU0FBTztBQUFBLElBQ0wsbUJBQW1CLENBQUMsU0FDbEIsNkJBQVksT0FBTyxrQ0FBa0MsSUFBSTtBQUFBLElBQzNELFdBQVcsQ0FBQyxTQUNWLDZCQUFZLE9BQU8sc0JBQXNCLElBQUk7QUFBQSxJQUMvQyxnQkFBZ0IsQ0FBQyxTQUNmLDZCQUFZLE9BQU8sNEJBQTRCLElBQUk7QUFBQSxJQUNyRCxjQUFjLENBQUMsU0FDYiw2QkFBWSxPQUFPLHlCQUF5QixJQUFJO0FBQUEsRUFDcEQ7QUFDRjs7O0FDdlFBLElBQUFDLG1CQUE0QjtBQUc1QixlQUFzQixlQUE4QjtBQUNsRCxRQUFNLFNBQVUsTUFBTSw2QkFBWSxPQUFPLHFCQUFxQjtBQUk5RCxRQUFNLFFBQVMsTUFBTSw2QkFBWSxPQUFPLG9CQUFvQjtBQU01RCxrQkFBZ0I7QUFBQSxJQUNkLElBQUk7QUFBQSxJQUNKLE9BQU87QUFBQSxJQUNQLGFBQWEsR0FBRyxPQUFPLE1BQU0sa0NBQWtDLE1BQU0sUUFBUTtBQUFBLElBQzdFLE9BQU9DLE9BQU07QUFDWCxNQUFBQSxNQUFLLE1BQU0sVUFBVTtBQUVyQixZQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUs7QUFDNUMsY0FBUSxNQUFNLFVBQVU7QUFDeEIsY0FBUTtBQUFBLFFBQ047QUFBQSxVQUFPO0FBQUEsVUFBc0IsTUFDM0IsNkJBQVksT0FBTyxrQkFBa0IsTUFBTSxTQUFTLEVBQUUsTUFBTSxNQUFNO0FBQUEsVUFBQyxDQUFDO0FBQUEsUUFDdEU7QUFBQSxNQUNGO0FBQ0EsY0FBUTtBQUFBLFFBQ047QUFBQSxVQUFPO0FBQUEsVUFBYSxNQUNsQiw2QkFBWSxPQUFPLGtCQUFrQixNQUFNLE1BQU0sRUFBRSxNQUFNLE1BQU07QUFBQSxVQUFDLENBQUM7QUFBQSxRQUNuRTtBQUFBLE1BQ0Y7QUFDQSxjQUFRO0FBQUEsUUFDTixPQUFPLGlCQUFpQixNQUFNLFNBQVMsT0FBTyxDQUFDO0FBQUEsTUFDakQ7QUFDQSxNQUFBQSxNQUFLLFlBQVksT0FBTztBQUV4QixVQUFJLE9BQU8sV0FBVyxHQUFHO0FBQ3ZCLGNBQU0sUUFBUSxTQUFTLGNBQWMsR0FBRztBQUN4QyxjQUFNLE1BQU0sVUFBVTtBQUN0QixjQUFNLGNBQ0o7QUFDRixRQUFBQSxNQUFLLFlBQVksS0FBSztBQUN0QjtBQUFBLE1BQ0Y7QUFFQSxZQUFNLE9BQU8sU0FBUyxjQUFjLElBQUk7QUFDeEMsV0FBSyxNQUFNLFVBQVU7QUFDckIsaUJBQVcsS0FBSyxRQUFRO0FBQ3RCLGNBQU0sS0FBSyxTQUFTLGNBQWMsSUFBSTtBQUN0QyxXQUFHLE1BQU0sVUFDUDtBQUNGLGNBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxhQUFLLFlBQVk7QUFBQSxrREFDeUIsT0FBTyxFQUFFLFNBQVMsSUFBSSxDQUFDLCtDQUErQyxPQUFPLEVBQUUsU0FBUyxPQUFPLENBQUM7QUFBQSx5REFDekYsT0FBTyxFQUFFLFNBQVMsZUFBZSxFQUFFLFNBQVMsRUFBRSxDQUFDO0FBQUE7QUFFaEcsY0FBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLGNBQU0sTUFBTSxVQUFVO0FBQ3RCLGNBQU0sY0FBYyxFQUFFLGNBQWMsV0FBVztBQUMvQyxXQUFHLE9BQU8sTUFBTSxLQUFLO0FBQ3JCLGFBQUssT0FBTyxFQUFFO0FBQUEsTUFDaEI7QUFDQSxNQUFBQSxNQUFLLE9BQU8sSUFBSTtBQUFBLElBQ2xCO0FBQUEsRUFDRixDQUFDO0FBQ0g7QUFFQSxTQUFTLE9BQU8sT0FBZSxTQUF3QztBQUNyRSxRQUFNLElBQUksU0FBUyxjQUFjLFFBQVE7QUFDekMsSUFBRSxPQUFPO0FBQ1QsSUFBRSxjQUFjO0FBQ2hCLElBQUUsTUFBTSxVQUNOO0FBQ0YsSUFBRSxpQkFBaUIsU0FBUyxPQUFPO0FBQ25DLFNBQU87QUFDVDtBQUVBLFNBQVMsT0FBTyxHQUFtQjtBQUNqQyxTQUFPLEVBQUU7QUFBQSxJQUFRO0FBQUEsSUFBWSxDQUFDLE1BQzVCLE1BQU0sTUFDRixVQUNBLE1BQU0sTUFDSixTQUNBLE1BQU0sTUFDSixTQUNBLE1BQU0sTUFDSixXQUNBO0FBQUEsRUFDWjtBQUNGOzs7QUNuR0EsSUFBQUMsbUJBQTRCO0FBRTVCLElBQU0sMEJBQTBCO0FBQ2hDLElBQU0seUJBQXlCO0FBQy9CLElBQU0sNkJBQTZCO0FBMkJuQyxJQUFJLGdCQUFnQjtBQUNwQixJQUFNLGtCQUFrQixvQkFBSSxJQUE0QjtBQUN4RCxJQUFNLHdCQUF3QixvQkFBSSxJQUFtRDtBQUNyRixJQUFJLGFBQWE7QUFFVixTQUFTLGlCQUNkLFFBQ0EsUUFDQSxVQUFtQyxDQUFDLEdBQ3hCO0FBQ1osbUJBQWlCO0FBQ2pCLFFBQU0sS0FBSyxXQUFXLEtBQUssSUFBSSxDQUFDLElBQUksZUFBZTtBQUNuRCxRQUFNLFNBQVMsUUFBUSxVQUFVLFdBQVc7QUFDNUMsUUFBTSxZQUFZLFFBQVEsYUFBYTtBQUV2QyxTQUFPLElBQUksUUFBVyxDQUFDLFNBQVMsV0FBVztBQUN6QyxVQUFNLFVBQVUsV0FBVyxNQUFNO0FBQy9CLHNCQUFnQixPQUFPLEVBQUU7QUFDekIsYUFBTyxJQUFJLE1BQU0sZ0RBQWdELE1BQU0sRUFBRSxDQUFDO0FBQUEsSUFDNUUsR0FBRyxTQUFTO0FBRVosb0JBQWdCLElBQUksSUFBSTtBQUFBLE1BQ3RCO0FBQUEsTUFDQSxTQUFTLENBQUMsVUFBVSxRQUFRLEtBQVU7QUFBQSxNQUN0QztBQUFBLE1BQ0E7QUFBQSxJQUNGLENBQUM7QUFFRCxVQUFNLFVBQVU7QUFBQSxNQUNkLE1BQU07QUFBQSxNQUNOO0FBQUEsTUFDQSxTQUFTLEVBQUUsSUFBSSxRQUFRLE9BQU87QUFBQSxJQUNoQztBQUVBLHdCQUFvQixPQUFPLEVBQUUsS0FBSyxDQUFDLGFBQWE7QUFDOUMsVUFBSSxhQUFhLE9BQVcsdUJBQXNCLFFBQVE7QUFBQSxJQUM1RCxDQUFDLEVBQUUsTUFBTSxDQUFDLFVBQVU7QUFDbEIsWUFBTSxVQUFVLGdCQUFnQixJQUFJLEVBQUU7QUFDdEMsVUFBSSxDQUFDLFFBQVM7QUFDZCxtQkFBYSxRQUFRLE9BQU87QUFDNUIsc0JBQWdCLE9BQU8sRUFBRTtBQUN6QixjQUFRLE9BQU8sUUFBUSxLQUFLLENBQUM7QUFBQSxJQUMvQixDQUFDO0FBQUEsRUFDSCxDQUFDO0FBQ0g7QUFFTyxTQUFTLHdCQUNkLFVBQ1k7QUFDWixtQkFBaUI7QUFDakIsd0JBQXNCLElBQUksUUFBUTtBQUNsQyxTQUFPLE1BQU0sc0JBQXNCLE9BQU8sUUFBUTtBQUNwRDtBQUVPLFNBQVMsYUFBcUI7QUFDbkMsTUFBSTtBQUNGLFVBQU0sTUFBTSxJQUFJLElBQUksU0FBUyxJQUFJO0FBQ2pDLFVBQU0sU0FBUyxJQUFJLGFBQWEsSUFBSSxRQUFRLEdBQUcsS0FBSztBQUNwRCxXQUFPLFVBQVU7QUFBQSxFQUNuQixRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLFNBQVMsbUJBQXlCO0FBQ2hDLE1BQUksV0FBWTtBQUNoQixlQUFhO0FBQ2IsK0JBQVksR0FBRyx3QkFBd0IsQ0FBQyxRQUFRLFlBQVk7QUFDMUQsMEJBQXNCLE9BQU87QUFBQSxFQUMvQixDQUFDO0FBQ0QsU0FBTyxpQkFBaUIsV0FBVyxDQUFDLFVBQVU7QUFDNUMsMEJBQXNCLE1BQU0sSUFBSTtBQUFBLEVBQ2xDLENBQUM7QUFDSDtBQUVBLFNBQVMsc0JBQXNCLFNBQXdCO0FBQ3JELFFBQU0sZUFBZSxvQkFBb0IsT0FBTztBQUNoRCxNQUFJLGNBQWM7QUFDaEIsZUFBVyxZQUFZLHVCQUF1QjtBQUM1QyxVQUFJO0FBQ0YsaUJBQVMsWUFBWTtBQUFBLE1BQ3ZCLFFBQVE7QUFBQSxNQUVSO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLFdBQVcsZ0JBQWdCLE9BQU87QUFDeEMsTUFBSSxDQUFDLFNBQVU7QUFDZixRQUFNLFVBQVUsZ0JBQWdCLElBQUksU0FBUyxFQUFFO0FBQy9DLE1BQUksQ0FBQyxRQUFTO0FBRWQsZUFBYSxRQUFRLE9BQU87QUFDNUIsa0JBQWdCLE9BQU8sU0FBUyxFQUFFO0FBQ2xDLE1BQUksU0FBUyxPQUFPO0FBQ2xCLFlBQVEsT0FBTyxTQUFTLEtBQUs7QUFDN0I7QUFBQSxFQUNGO0FBQ0EsVUFBUSxRQUFRLFNBQVMsTUFBTTtBQUNqQztBQUVBLFNBQVMsZ0JBQWdCLFNBQTBFO0FBQ2pHLE1BQUksQ0FBQyxTQUFTLE9BQU8sRUFBRyxRQUFPO0FBRS9CLE1BQUksUUFBUSxTQUFTLGtCQUFrQixTQUFTLFFBQVEsUUFBUSxHQUFHO0FBQ2pFLFdBQU8scUJBQXFCLFFBQVEsUUFBUTtBQUFBLEVBQzlDO0FBRUEsTUFBSSxRQUFRLFNBQVMsa0JBQWtCLFNBQVMsUUFBUSxPQUFPLEdBQUc7QUFDaEUsV0FBTyxxQkFBcUIsUUFBUSxPQUFPO0FBQUEsRUFDN0M7QUFFQSxNQUFJLFFBQVEsU0FBUyxlQUFlLE9BQU8sUUFBUSxPQUFPLFVBQVU7QUFDbEUsV0FBTyxFQUFFLElBQUksUUFBUSxJQUFJLE9BQU8sSUFBSSxNQUFNLGlCQUFpQixRQUFRLEtBQUssS0FBSywyQkFBMkIsRUFBRTtBQUFBLEVBQzVHO0FBRUEsTUFBSSxRQUFRLFNBQVMsY0FBYyxPQUFPLFFBQVEsT0FBTyxVQUFVO0FBQ2pFLFdBQU8scUJBQXFCLE9BQU87QUFBQSxFQUNyQztBQUVBLE1BQUksT0FBTyxRQUFRLE9BQU8sYUFBYSxZQUFZLFdBQVcsV0FBVyxVQUFVO0FBQ2pGLFdBQU8scUJBQXFCLE9BQU87QUFBQSxFQUNyQztBQUVBLFNBQU87QUFDVDtBQUVBLFNBQVMscUJBQXFCLFVBQTJGO0FBQ3ZILFFBQU0sS0FBSyxPQUFPLFNBQVMsT0FBTyxZQUFZLE9BQU8sU0FBUyxPQUFPLFdBQ2pFLE9BQU8sU0FBUyxFQUFFLElBQ2xCO0FBQ0osTUFBSSxDQUFDLEdBQUksUUFBTztBQUVoQixNQUFJLFdBQVcsVUFBVTtBQUN2QixXQUFPLEVBQUUsSUFBSSxPQUFPLElBQUksTUFBTSxpQkFBaUIsU0FBUyxLQUFLLEtBQUssMkJBQTJCLEVBQUU7QUFBQSxFQUNqRztBQUVBLFNBQU8sRUFBRSxJQUFJLFFBQVEsU0FBUyxPQUFPO0FBQ3ZDO0FBRUEsU0FBUyxvQkFBb0IsU0FBZ0Q7QUFDM0UsTUFBSSxDQUFDLFNBQVMsT0FBTyxFQUFHLFFBQU87QUFFL0IsTUFBSSxRQUFRLFNBQVMsc0JBQXNCLFNBQVMsUUFBUSxPQUFPLEdBQUc7QUFDcEUsVUFBTSxTQUFTLFFBQVEsUUFBUTtBQUMvQixRQUFJLE9BQU8sV0FBVyxVQUFVO0FBQzlCLGFBQU8sRUFBRSxRQUFRLFFBQVEsUUFBUSxRQUFRLE9BQU87QUFBQSxJQUNsRDtBQUFBLEVBQ0Y7QUFFQSxNQUFJLFFBQVEsU0FBUyxzQkFBc0IsU0FBUyxRQUFRLE9BQU8sR0FBRztBQUNwRSxVQUFNLFNBQVMsUUFBUSxRQUFRO0FBQy9CLFFBQUksT0FBTyxXQUFXLFVBQVU7QUFDOUIsYUFBTyxFQUFFLFFBQVEsUUFBUSxRQUFRLFFBQVEsT0FBTztBQUFBLElBQ2xEO0FBQUEsRUFDRjtBQUVBLE1BQUksUUFBUSxTQUFTLHNCQUFzQixPQUFPLFFBQVEsV0FBVyxVQUFVO0FBQzdFLFdBQU8sRUFBRSxRQUFRLFFBQVEsUUFBUSxRQUFRLFFBQVEsT0FBTztBQUFBLEVBQzFEO0FBRUEsTUFBSSxPQUFPLFFBQVEsV0FBVyxZQUFZLEVBQUUsUUFBUSxVQUFVO0FBQzVELFdBQU8sRUFBRSxRQUFRLFFBQVEsUUFBUSxRQUFRLFFBQVEsT0FBTztBQUFBLEVBQzFEO0FBRUEsU0FBTztBQUNUO0FBRUEsU0FBUyxpQkFBaUIsT0FBK0I7QUFDdkQsTUFBSSxpQkFBaUIsTUFBTyxRQUFPLE1BQU07QUFDekMsTUFBSSxPQUFPLFVBQVUsU0FBVSxRQUFPO0FBQ3RDLE1BQUksU0FBUyxLQUFLLEdBQUc7QUFDbkIsUUFBSSxPQUFPLE1BQU0sWUFBWSxTQUFVLFFBQU8sTUFBTTtBQUNwRCxRQUFJLE9BQU8sTUFBTSxVQUFVLFNBQVUsUUFBTyxNQUFNO0FBQUEsRUFDcEQ7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLG9CQUFvQixTQUFvQztBQUMvRCxRQUFNLGVBQWUsT0FBTyxnQkFBZ0I7QUFDNUMsTUFBSSxPQUFPLGlCQUFpQixZQUFZO0FBQ3RDLFdBQU8sYUFBYSxLQUFLLE9BQU8sZ0JBQWdCLE9BQU8sRUFBRSxLQUFLLE1BQU0sTUFBUztBQUFBLEVBQy9FO0FBQ0EsU0FBTyw2QkFBWSxPQUFPLHlCQUF5QixPQUFPO0FBQzVEO0FBRUEsU0FBUyxRQUFRLE9BQXVCO0FBQ3RDLFNBQU8saUJBQWlCLFFBQVEsUUFBUSxJQUFJLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFDakU7QUFFQSxTQUFTLFNBQVMsT0FBa0Q7QUFDbEUsU0FBTyxVQUFVLFFBQVEsT0FBTyxVQUFVLFlBQVksQ0FBQyxNQUFNLFFBQVEsS0FBSztBQUM1RTs7O0FDbEtBLElBQUksVUFBVTtBQUNkLElBQUksT0FBOEI7QUFDbEMsSUFBSSxpQkFBd0M7QUFDNUMsSUFBSSxjQUFpQztBQUNyQyxJQUFJLFlBQWtEO0FBQ3RELElBQUksZUFBOEI7QUFDbEMsSUFBSSxtQkFBNEM7QUFDaEQsSUFBSSxZQUFrQztBQUN0QyxJQUFJLGNBQXNDO0FBRTFDLElBQU0sdUJBQXVCO0FBQzdCLElBQU0sdUJBQXVCO0FBQzdCLElBQU0sd0JBQXdCO0FBQzlCLElBQU0sNkJBQTZCO0FBQ25DLElBQUksYUFBNkIsbUJBQW1CO0FBRTdDLFNBQVMsaUJBQWlCLE1BQWdELE1BQU07QUFBQyxHQUFTO0FBQy9GLE1BQUksUUFBUztBQUNiLFlBQVU7QUFDVixnQkFBYztBQUNkLFdBQVMsaUJBQWlCLFdBQVcsQ0FBQyxVQUFVO0FBQzlDLFNBQUssY0FBYyxPQUFPLEdBQUc7QUFBQSxFQUMvQixHQUFHLElBQUk7QUFDUCxXQUFTLGlCQUFpQixTQUFTLENBQUMsVUFBVTtBQUM1Qyx5QkFBcUIsbUJBQW1CLEtBQUssQ0FBQztBQUFBLEVBQ2hELEdBQUcsSUFBSTtBQUNQLFdBQVMsaUJBQWlCLFdBQVcsQ0FBQyxVQUFVO0FBQzlDLHlCQUFxQixtQkFBbUIsS0FBSyxDQUFDO0FBQUEsRUFDaEQsR0FBRyxJQUFJO0FBQ1AsV0FBUyxpQkFBaUIsU0FBUyxDQUFDLFVBQVU7QUFDNUMsUUFBSSxnQkFBZ0IsU0FBUyxNQUFNLE1BQWMsRUFBRztBQUNwRCx5QkFBcUIsbUJBQW1CLEtBQUssQ0FBQztBQUFBLEVBQ2hELEdBQUcsSUFBSTtBQUNQLFNBQU8saUJBQWlCLFVBQVUsTUFBTTtBQUN0QyxRQUFJLENBQUMsTUFBTSxZQUFhO0FBQ3hCLHVCQUFtQixJQUFJO0FBQ3ZCLDZCQUF5QixJQUFJO0FBQzdCLDJCQUF1QixJQUFJO0FBQUEsRUFDN0IsQ0FBQztBQUNELDBCQUF3QixDQUFDLGlCQUFpQjtBQUN4QyxRQUFJLGFBQWEsV0FBVyx5QkFBeUJDLFVBQVMsYUFBYSxNQUFNLEdBQUc7QUFDbEYsWUFBTSxPQUFPLGFBQWEsT0FBTztBQUNqQyxVQUFJLGFBQWEsSUFBSSxHQUFHO0FBQ3RCLFlBQUksS0FBSyxhQUFhLGFBQWEsRUFBRztBQUN0QyxzQkFBYztBQUNkLG1CQUFXLE1BQU0sRUFBRSxXQUFXLE1BQU0sQ0FBQztBQUFBLE1BQ3ZDO0FBQ0E7QUFBQSxJQUNGO0FBQ0EsUUFBSSxhQUFhLFdBQVcseUJBQXlCQSxVQUFTLGFBQWEsTUFBTSxHQUFHO0FBQ2xGLFlBQU0sV0FBVyxhQUFhLE9BQU87QUFDckMsVUFBSSxPQUFPLGFBQWEsWUFBWSxhQUFhLGFBQWEsR0FBRztBQUMvRCxzQkFBYztBQUNkLHFCQUFhLGdCQUFnQiwyQ0FBMkM7QUFBQSxNQUMxRTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPLGlCQUFpQixZQUFZLE1BQU0sb0JBQW9CLEdBQUcsQ0FBQztBQUNsRSxRQUFNLGVBQWUsWUFBWSxNQUFNLG9CQUFvQixHQUFHLEdBQUcsSUFBSztBQUN0RSxRQUFNLFFBQVMsYUFBbUQ7QUFDbEUsTUFBSSxPQUFPLFVBQVUsV0FBWSxPQUFNLEtBQUssWUFBWTtBQUN4RCxpQkFBZSxNQUFNLG9CQUFvQixHQUFHLENBQUM7QUFDN0MsTUFBSSxzQkFBc0I7QUFDNUI7QUFFQSxlQUFlLGNBQWMsT0FBc0IsS0FBOEQ7QUFDL0csTUFBSSxNQUFNLFlBQWE7QUFFdkIsUUFBTSxXQUFXLG1CQUFtQixLQUFLO0FBQ3pDLE1BQUksQ0FBQyxTQUFVO0FBRWYsTUFBSSxNQUFNLFFBQVEsVUFBVTtBQUMxQix1QkFBbUI7QUFDbkI7QUFBQSxFQUNGO0FBRUEsT0FBSyxNQUFNLFFBQVEsU0FBUyxNQUFNLFFBQVEsWUFBWSxDQUFDLE1BQU0sWUFBWSxDQUFDLE1BQU0sVUFBVSxDQUFDLE1BQU0sV0FBVyxDQUFDLE1BQU0sU0FBUztBQUMxSCxVQUFNLGFBQWEsb0JBQW9CLFNBQVMsUUFBUSxDQUFDO0FBQ3pELFFBQUksY0FBYyxTQUFTLFFBQVEsRUFBRSxLQUFLLE1BQU0sU0FBUztBQUN2RCxZQUFNLGVBQWU7QUFDckIsWUFBTSxnQkFBZ0I7QUFDdEIsWUFBTSx5QkFBeUI7QUFDL0IsMEJBQW9CLFFBQVE7QUFDNUI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLE1BQUksTUFBTSxRQUFRLFdBQVcsTUFBTSxZQUFZLE1BQU0sVUFBVSxNQUFNLFdBQVcsTUFBTSxRQUFTO0FBRS9GLFFBQU0sU0FBUyxpQkFBaUIsU0FBUyxRQUFRLENBQUM7QUFDbEQsTUFBSSxDQUFDLE9BQVE7QUFFYixRQUFNLGVBQWU7QUFDckIsUUFBTSxnQkFBZ0I7QUFDdEIsUUFBTSx5QkFBeUI7QUFDL0IsV0FBUyxNQUFNO0FBQ2YscUJBQW1CO0FBRW5CLE1BQUk7QUFDRixVQUFNLGVBQWUsT0FBTyxNQUFNLEdBQUc7QUFBQSxFQUN2QyxTQUFTLE9BQU87QUFDZCxRQUFJLHVCQUF1QixlQUFlLEtBQUssQ0FBQztBQUNoRCxnQkFBWSx1QkFBdUIsa0JBQWtCLEtBQUssQ0FBQztBQUFBLEVBQzdEO0FBQ0Y7QUFFQSxTQUFTLGlCQUFpQixNQUF1QztBQUMvRCxRQUFNLFFBQVEsS0FBSyxLQUFLLEVBQUUsTUFBTSwyQkFBMkI7QUFDM0QsTUFBSSxDQUFDLE1BQU8sUUFBTztBQUNuQixTQUFPLEVBQUUsT0FBTyxNQUFNLENBQUMsS0FBSyxJQUFJLEtBQUssRUFBRTtBQUN6QztBQUVBLFNBQVMsb0JBQW9CLE1BQXdDO0FBQ25FLFFBQU0sUUFBUSxLQUFLLEtBQUssRUFBRSxNQUFNLGVBQWU7QUFDL0MsTUFBSSxDQUFDLE1BQU8sUUFBTztBQUNuQixRQUFNLFFBQVEsTUFBTSxDQUFDLEdBQUcsWUFBWSxLQUFLO0FBQ3pDLFNBQU8sT0FBTyxXQUFXLEtBQUssSUFBSSxFQUFFLE1BQU0sSUFBSTtBQUNoRDtBQUVBLGVBQWUsZUFBZSxNQUFjLEtBQThEO0FBQ3hHLFFBQU0sV0FBVyxhQUFhO0FBQzlCLE1BQUksQ0FBQyxVQUFVO0FBQ2IsZ0JBQVksb0JBQW9CLHlDQUF5QztBQUN6RTtBQUFBLEVBQ0Y7QUFDQSxRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFFBQVEsS0FBSyxZQUFZO0FBRS9CLE1BQUksQ0FBQyxNQUFNO0FBQ1QsVUFBTSxPQUFPLE1BQU0sUUFBUSxVQUFVLE1BQU07QUFDM0Msa0JBQWM7QUFDZCxRQUFJLE1BQU07QUFDUixpQkFBVyxNQUFNLEVBQUUsV0FBVyxNQUFNLENBQUM7QUFBQSxJQUN2QyxPQUFPO0FBQ0wsbUJBQWEsZUFBZSxtREFBbUQ7QUFBQSxJQUNqRjtBQUNBO0FBQUEsRUFDRjtBQUVBLE1BQUksVUFBVSxTQUFTO0FBQ3JCLFVBQU1DLFlBQVcsTUFBTTtBQUFBLE1BQ3JCO0FBQUEsTUFDQSxFQUFFLFNBQVM7QUFBQSxNQUNYLEVBQUUsT0FBTztBQUFBLElBQ1g7QUFDQSxrQkFBYztBQUNkLGlCQUFhQSxVQUFTLFVBQVUsaUJBQWlCLGVBQWUsMENBQTBDO0FBQzFHO0FBQUEsRUFDRjtBQUVBLE1BQUksVUFBVSxXQUFXLFVBQVUsWUFBWSxVQUFVLFlBQVk7QUFDbkUsVUFBTSxTQUFxQixVQUFVLFVBQVUsV0FBVyxVQUFVLFdBQVcsV0FBVztBQUMxRixVQUFNQSxZQUFXLE1BQU07QUFBQSxNQUNyQjtBQUFBLE1BQ0EsRUFBRSxVQUFVLE9BQU87QUFBQSxNQUNuQixFQUFFLE9BQU87QUFBQSxJQUNYO0FBQ0Esa0JBQWNBLFVBQVM7QUFDdkIsZUFBV0EsVUFBUyxNQUFNLEVBQUUsV0FBVyxNQUFNLENBQUM7QUFDOUM7QUFBQSxFQUNGO0FBRUEsUUFBTSxXQUFXLE1BQU0sUUFBUSxVQUFVLE1BQU07QUFDL0MsTUFBSSxZQUFZLFNBQVMsY0FBYyxNQUFNO0FBQzNDLFVBQU0sVUFBVSxNQUFNLG1CQUFtQixVQUFVLElBQUk7QUFDdkQsUUFBSSxDQUFDLFNBQVM7QUFDWixvQkFBYztBQUNkLGlCQUFXLFVBQVUsRUFBRSxXQUFXLE1BQU0sQ0FBQztBQUN6QztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsUUFBTSxXQUFXLE1BQU07QUFBQSxJQUNyQjtBQUFBLElBQ0EsRUFBRSxVQUFVLFdBQVcsTUFBTSxRQUFRLFNBQVM7QUFBQSxJQUM5QyxFQUFFLE9BQU87QUFBQSxFQUNYO0FBQ0EsZ0JBQWMsU0FBUztBQUN2QixNQUFJLFlBQVksRUFBRSxTQUFTLENBQUM7QUFDNUIsYUFBVyxTQUFTLE1BQU0sRUFBRSxXQUFXLE1BQU0sQ0FBQztBQUNoRDtBQUVBLGVBQWUsUUFBUSxVQUFrQixRQUE0QztBQUNuRixRQUFNLFdBQVcsTUFBTTtBQUFBLElBQ3JCO0FBQUEsSUFDQSxFQUFFLFNBQVM7QUFBQSxJQUNYLEVBQUUsT0FBTztBQUFBLEVBQ1g7QUFDQSxTQUFPLFNBQVM7QUFDbEI7QUFFQSxlQUFlLG9CQUFvQixLQUE4RDtBQUMvRixRQUFNLFdBQVcsYUFBYTtBQUM5QixNQUFJLENBQUMsVUFBVTtBQUNiLFFBQUksaUJBQWlCLE1BQU07QUFDekIscUJBQWU7QUFDZixvQkFBYztBQUNkLGdCQUFVO0FBQUEsSUFDWjtBQUNBO0FBQUEsRUFDRjtBQUNBLE1BQUksYUFBYSxhQUFjO0FBQy9CLGlCQUFlO0FBQ2YsTUFBSTtBQUNGLFVBQU0sT0FBTyxNQUFNLFFBQVEsVUFBVSxXQUFXLENBQUM7QUFDakQsa0JBQWM7QUFDZCxRQUFJLE1BQU07QUFDUixpQkFBVyxNQUFNLEVBQUUsV0FBVyxNQUFNLENBQUM7QUFBQSxJQUN2QyxPQUFPO0FBQ0wsZ0JBQVU7QUFBQSxJQUNaO0FBQUEsRUFDRixTQUFTLE9BQU87QUFHZCxRQUFJLDhCQUE4QixlQUFlLEtBQUssQ0FBQztBQUFBLEVBQ3pEO0FBQ0Y7QUFFQSxTQUFTLG1CQUFtQixVQUFzQixlQUF5QztBQUN6RixTQUFPLElBQUksUUFBUSxDQUFDLFlBQVk7QUFDOUIsZ0JBQVk7QUFBQSxNQUNWLE9BQU87QUFBQSxNQUNQLFFBQVEsU0FBUyxTQUFTLFdBQVcsR0FBRztBQUFBLE1BQ3hDLFFBQVEsUUFBUSxTQUFTLGVBQWUsR0FBRyxDQUFDO0FBQUEsTUFDNUMsU0FBUztBQUFBLFFBQ1A7QUFBQSxVQUNFLE9BQU87QUFBQSxVQUNQLE1BQU07QUFBQSxVQUNOLEtBQUssTUFBTSxRQUFRLElBQUk7QUFBQSxRQUN6QjtBQUFBLFFBQ0E7QUFBQSxVQUNFLE9BQU87QUFBQSxVQUNQLEtBQUssTUFBTSxRQUFRLEtBQUs7QUFBQSxRQUMxQjtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFlBQVk7QUFBQSxJQUNkLENBQUM7QUFBQSxFQUNILENBQUM7QUFDSDtBQUVBLFNBQVMsV0FBVyxNQUFrQixTQUF1QztBQUMzRSxRQUFNLFNBQVMsZ0JBQWdCLEtBQUssTUFBTTtBQUMxQyxRQUFNLFNBQVMsS0FBSyxlQUFlLE9BQy9CLEdBQUcsYUFBYSxLQUFLLFVBQVUsQ0FBQyxZQUNoQyxHQUFHLGFBQWEsS0FBSyxVQUFVLENBQUMsTUFBTSxhQUFhLEtBQUssV0FBVyxDQUFDO0FBQ3hFLGNBQVk7QUFBQSxJQUNWLE9BQU8sUUFBUSxNQUFNO0FBQUEsSUFDckIsUUFBUSxLQUFLO0FBQUEsSUFDYixRQUFRLEdBQUcsTUFBTSxNQUFNLGVBQWUsS0FBSyxlQUFlLENBQUM7QUFBQSxJQUMzRCxTQUFTO0FBQUEsTUFDUCxLQUFLLFdBQVcsV0FDWixFQUFFLE9BQU8sVUFBVSxNQUFNLFdBQVcsS0FBSyxNQUFNLGlCQUFpQixRQUFRLEVBQUUsSUFDMUUsRUFBRSxPQUFPLFNBQVMsS0FBSyxNQUFNLGlCQUFpQixRQUFRLEVBQUU7QUFBQSxNQUM1RCxFQUFFLE9BQU8sWUFBWSxLQUFLLE1BQU0saUJBQWlCLFVBQVUsRUFBRTtBQUFBLE1BQzdELEVBQUUsT0FBTyxTQUFTLE1BQU0sVUFBVSxLQUFLLE1BQU0saUJBQWlCLEVBQUU7QUFBQSxJQUNsRTtBQUFBLElBQ0EsWUFBWSxDQUFDLFFBQVE7QUFBQSxFQUN2QixDQUFDO0FBQ0g7QUFFQSxTQUFTLGFBQWEsT0FBZSxRQUFzQjtBQUN6RCxjQUFZLEVBQUUsT0FBTyxRQUFRLFNBQVMsQ0FBQyxHQUFHLFlBQVksTUFBTSxDQUFDO0FBQy9EO0FBRUEsU0FBUyxZQUFZLE9BQWUsUUFBc0I7QUFDeEQsY0FBWSxFQUFFLE9BQU8sUUFBUSxTQUFTLENBQUMsR0FBRyxZQUFZLE9BQU8sT0FBTyxLQUFLLENBQUM7QUFDNUU7QUFFQSxTQUFTLFlBQVksU0FBaUM7QUFDcEQscUJBQW1CO0FBQ25CLFFBQU1DLE1BQUssV0FBVztBQUN0QixNQUFJLFVBQVcsY0FBYSxTQUFTO0FBQ3JDLEVBQUFBLElBQUcsWUFBWTtBQUNmLEVBQUFBLElBQUcsWUFBWSxxQkFBcUIsUUFBUSxRQUFRLGNBQWMsRUFBRSxHQUFHLFdBQVcsWUFBWSxrQkFBa0IsRUFBRTtBQUNsSCxxQkFBbUJBLEdBQUU7QUFDckIseUJBQXVCQSxHQUFFO0FBRXpCLFFBQU0sU0FBUyxTQUFTLGNBQWMsS0FBSztBQUMzQyxTQUFPLFlBQVk7QUFDbkIsU0FBTyxpQkFBaUIsZUFBZSxrQkFBa0I7QUFDekQsU0FBTyxpQkFBaUIsWUFBWSxzQkFBc0I7QUFFMUQsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWMsUUFBUTtBQUU1QixRQUFNLFdBQVcsU0FBUyxjQUFjLEtBQUs7QUFDN0MsV0FBUyxZQUFZO0FBRXJCLFFBQU0sV0FBVyxTQUFTLGNBQWMsUUFBUTtBQUNoRCxXQUFTLFlBQVk7QUFDckIsV0FBUyxPQUFPO0FBQ2hCLFdBQVMsY0FBYyxXQUFXLFlBQVksTUFBTTtBQUNwRCxXQUFTLGFBQWEsY0FBYyxXQUFXLFlBQVksc0JBQXNCLHFCQUFxQjtBQUN0RyxXQUFTLGlCQUFpQixTQUFTLE1BQU07QUFDdkMsaUJBQWEsRUFBRSxHQUFHLFlBQVksV0FBVyxDQUFDLFdBQVcsVUFBVTtBQUMvRCx1QkFBbUI7QUFDbkIsUUFBSSxpQkFBa0IsYUFBWSxnQkFBZ0I7QUFBQSxFQUNwRCxDQUFDO0FBRUQsUUFBTSxRQUFRLFNBQVMsY0FBYyxRQUFRO0FBQzdDLFFBQU0sWUFBWTtBQUNsQixRQUFNLE9BQU87QUFDYixRQUFNLGNBQWM7QUFDcEIsUUFBTSxhQUFhLGNBQWMsa0JBQWtCO0FBQ25ELFFBQU0saUJBQWlCLFNBQVMsTUFBTSxVQUFVLENBQUM7QUFDakQsV0FBUyxPQUFPLFVBQVUsS0FBSztBQUMvQixTQUFPLE9BQU8sT0FBTyxRQUFRO0FBQzdCLEVBQUFBLElBQUcsWUFBWSxNQUFNO0FBRXJCLE1BQUksV0FBVyxXQUFXO0FBQ3hCLElBQUFBLElBQUcsTUFBTSxVQUFVO0FBQ25CLFFBQUksQ0FBQyxRQUFRLFlBQVk7QUFDdkIsa0JBQVksV0FBVyxNQUFNLFVBQVUsR0FBRyxHQUFLO0FBQUEsSUFDakQ7QUFDQTtBQUFBLEVBQ0Y7QUFFQSxRQUFNLFNBQVMsU0FBUyxjQUFjLEtBQUs7QUFDM0MsU0FBTyxZQUFZO0FBQ25CLFNBQU8sY0FBYyxRQUFRO0FBRTdCLEVBQUFBLElBQUcsWUFBWSxNQUFNO0FBRXJCLE1BQUksUUFBUSxRQUFRO0FBQ2xCLFVBQU0sU0FBUyxTQUFTLGNBQWMsS0FBSztBQUMzQyxXQUFPLFlBQVk7QUFDbkIsV0FBTyxjQUFjLFFBQVE7QUFDN0IsSUFBQUEsSUFBRyxZQUFZLE1BQU07QUFBQSxFQUN2QjtBQUVBLE1BQUksUUFBUSxRQUFRLFNBQVMsR0FBRztBQUM5QixVQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUs7QUFDNUMsWUFBUSxZQUFZO0FBQ3BCLGVBQVcsVUFBVSxRQUFRLFNBQVM7QUFDcEMsWUFBTUMsVUFBUyxTQUFTLGNBQWMsUUFBUTtBQUM5QyxNQUFBQSxRQUFPLE9BQU87QUFDZCxNQUFBQSxRQUFPLGNBQWMsT0FBTztBQUM1QixNQUFBQSxRQUFPLFlBQVksdUJBQXVCLE9BQU8sUUFBUSxFQUFFO0FBQzNELE1BQUFBLFFBQU8saUJBQWlCLFNBQVMsTUFBTTtBQUNyQyxnQkFBUSxRQUFRLE9BQU8sSUFBSSxDQUFDLEVBQUUsTUFBTSxDQUFDLFVBQVU7QUFDN0Msc0JBQVksc0JBQXNCLGtCQUFrQixLQUFLLENBQUM7QUFBQSxRQUM1RCxDQUFDO0FBQUEsTUFDSCxDQUFDO0FBQ0QsY0FBUSxZQUFZQSxPQUFNO0FBQUEsSUFDNUI7QUFDQSxJQUFBRCxJQUFHLFlBQVksT0FBTztBQUFBLEVBQ3hCO0FBRUEsUUFBTSxTQUFTLFNBQVMsY0FBYyxRQUFRO0FBQzlDLFNBQU8sWUFBWTtBQUNuQixTQUFPLE9BQU87QUFDZCxTQUFPLGFBQWEsY0FBYyxtQkFBbUI7QUFDckQsU0FBTyxpQkFBaUIsZUFBZSxvQkFBb0I7QUFDM0QsU0FBTyxpQkFBaUIsV0FBVyw0QkFBNEI7QUFDL0QsU0FBTyxpQkFBaUIsWUFBWSxrQkFBa0I7QUFDdEQsRUFBQUEsSUFBRyxZQUFZLE1BQU07QUFFckIsRUFBQUEsSUFBRyxNQUFNLFVBQVU7QUFDbkIsTUFBSSxDQUFDLFFBQVEsWUFBWTtBQUN2QixnQkFBWSxXQUFXLE1BQU0sVUFBVSxHQUFHLEdBQUs7QUFBQSxFQUNqRDtBQUNGO0FBRUEsZUFBZSxpQkFBaUIsUUFBbUM7QUFDakUsUUFBTSxXQUFXLGFBQWEsS0FBSyxhQUFhO0FBQ2hELE1BQUksQ0FBQyxTQUFVO0FBQ2YsUUFBTSxXQUFXLE1BQU07QUFBQSxJQUNyQjtBQUFBLElBQ0EsRUFBRSxVQUFVLE9BQU87QUFBQSxJQUNuQixFQUFFLFFBQVEsV0FBVyxFQUFFO0FBQUEsRUFDekI7QUFDQSxnQkFBYyxTQUFTO0FBQ3ZCLGFBQVcsU0FBUyxNQUFNLEVBQUUsV0FBVyxNQUFNLENBQUM7QUFDaEQ7QUFFQSxlQUFlLG1CQUFrQztBQUMvQyxRQUFNLFdBQVcsYUFBYSxLQUFLLGFBQWE7QUFDaEQsTUFBSSxDQUFDLFNBQVU7QUFDZixRQUFNO0FBQUEsSUFDSjtBQUFBLElBQ0EsRUFBRSxTQUFTO0FBQUEsSUFDWCxFQUFFLFFBQVEsV0FBVyxFQUFFO0FBQUEsRUFDekI7QUFDQSxnQkFBYztBQUNkLGVBQWEsZ0JBQWdCLDJDQUEyQztBQUMxRTtBQUVBLFNBQVMsYUFBNkI7QUFDcEMsTUFBSSxNQUFNLFlBQWEsUUFBTztBQUM5QixTQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ25DLE9BQUssS0FBSztBQUNWLE9BQUssTUFBTSxVQUFVO0FBQ3JCLFFBQU0sU0FBUyxTQUFTLFFBQVEsU0FBUztBQUN6QyxNQUFJLE9BQVEsUUFBTyxZQUFZLElBQUk7QUFDbkMsU0FBTztBQUNUO0FBRUEsU0FBUyxZQUFrQjtBQUN6QixNQUFJLFdBQVc7QUFDYixpQkFBYSxTQUFTO0FBQ3RCLGdCQUFZO0FBQUEsRUFDZDtBQUNBLE1BQUksS0FBTSxNQUFLLE1BQU0sVUFBVTtBQUNqQztBQUVBLFNBQVMsbUJBQW1CLE9BQTJCO0FBQ3JELE1BQUksTUFBTSxXQUFXLEVBQUc7QUFDeEIsTUFBSSxNQUFNLGtCQUFrQixXQUFXLE1BQU0sT0FBTyxRQUFRLFFBQVEsRUFBRztBQUN2RSxNQUFJLENBQUMsS0FBTTtBQUNYLFFBQU0sT0FBTyxLQUFLLHNCQUFzQjtBQUN4QyxjQUFZO0FBQUEsSUFDVixXQUFXLE1BQU07QUFBQSxJQUNqQixTQUFTLE1BQU0sVUFBVSxLQUFLO0FBQUEsSUFDOUIsU0FBUyxNQUFNLFVBQVUsS0FBSztBQUFBLElBQzlCLE9BQU8sS0FBSztBQUFBLElBQ1osUUFBUSxLQUFLO0FBQUEsRUFDZjtBQUNBLE9BQUssVUFBVSxJQUFJLGFBQWE7QUFDaEMsUUFBTSxlQUFlO0FBQ3JCLFNBQU8saUJBQWlCLGVBQWUsYUFBYTtBQUNwRCxTQUFPLGlCQUFpQixhQUFhLGlCQUFpQjtBQUN4RDtBQUVBLFNBQVMsY0FBYyxPQUEyQjtBQUNoRCxNQUFJLENBQUMsYUFBYSxNQUFNLGNBQWMsVUFBVSxhQUFhLENBQUMsS0FBTTtBQUNwRSxlQUFhO0FBQUEsSUFDWCxHQUFHO0FBQUEsSUFDSCxHQUFHLE1BQU0sTUFBTSxVQUFVLFVBQVUsU0FBUyxHQUFHLE9BQU8sYUFBYSxVQUFVLFFBQVEsQ0FBQztBQUFBLElBQ3RGLEdBQUcsTUFBTSxNQUFNLFVBQVUsVUFBVSxTQUFTLEdBQUcsT0FBTyxjQUFjLFVBQVUsU0FBUyxDQUFDO0FBQUEsRUFDMUY7QUFDQSx5QkFBdUIsSUFBSTtBQUM3QjtBQUVBLFNBQVMsa0JBQWtCLE9BQTJCO0FBQ3BELE1BQUksYUFBYSxNQUFNLGNBQWMsVUFBVSxVQUFXO0FBQzFELFNBQU8sb0JBQW9CLGVBQWUsYUFBYTtBQUN2RCxTQUFPLG9CQUFvQixhQUFhLGlCQUFpQjtBQUN6RCxNQUFJLEtBQU0sTUFBSyxVQUFVLE9BQU8sYUFBYTtBQUM3QyxjQUFZO0FBQ1osTUFBSSxLQUFNLDBCQUF5QixJQUFJO0FBQ3ZDLHFCQUFtQjtBQUNyQjtBQUVBLFNBQVMscUJBQXFCLE9BQTJCO0FBQ3ZELE1BQUksTUFBTSxXQUFXLEtBQUssV0FBVyxVQUFXO0FBQ2hELE1BQUksQ0FBQyxLQUFNO0FBQ1gsUUFBTSxPQUFPLEtBQUssc0JBQXNCO0FBQ3hDLCtCQUE2QixJQUFJO0FBQ2pDLGdCQUFjO0FBQUEsSUFDWixXQUFXLE1BQU07QUFBQSxJQUNqQixRQUFRLE1BQU07QUFBQSxJQUNkLFFBQVEsTUFBTTtBQUFBLElBQ2QsT0FBTyxLQUFLO0FBQUEsSUFDWixRQUFRLEtBQUs7QUFBQSxFQUNmO0FBQ0EsT0FBSyxVQUFVLElBQUksYUFBYTtBQUNoQyxRQUFNLGVBQWU7QUFDckIsUUFBTSxnQkFBZ0I7QUFDdEIsU0FBTyxpQkFBaUIsZUFBZSxlQUFlO0FBQ3RELFNBQU8saUJBQWlCLGFBQWEsbUJBQW1CO0FBQzFEO0FBRUEsU0FBUyxnQkFBZ0IsT0FBMkI7QUFDbEQsTUFBSSxDQUFDLGVBQWUsTUFBTSxjQUFjLFlBQVksYUFBYSxDQUFDLEtBQU07QUFDeEUsUUFBTSxXQUFXLGtCQUFrQjtBQUNuQyxRQUFNLFlBQVksbUJBQW1CO0FBQ3JDLGVBQWE7QUFBQSxJQUNYLEdBQUc7QUFBQSxJQUNILE9BQU8sTUFBTSxZQUFZLFFBQVEsTUFBTSxVQUFVLFlBQVksUUFBUSxzQkFBc0IsUUFBUTtBQUFBLElBQ25HLFFBQVEsTUFBTSxZQUFZLFNBQVMsTUFBTSxVQUFVLFlBQVksUUFBUSx1QkFBdUIsU0FBUztBQUFBLEVBQ3pHO0FBQ0EscUJBQW1CLElBQUk7QUFDdkIsMkJBQXlCLElBQUk7QUFDN0IseUJBQXVCLElBQUk7QUFDN0I7QUFFQSxTQUFTLG9CQUFvQixPQUEyQjtBQUN0RCxNQUFJLGVBQWUsTUFBTSxjQUFjLFlBQVksVUFBVztBQUM5RCxTQUFPLG9CQUFvQixlQUFlLGVBQWU7QUFDekQsU0FBTyxvQkFBb0IsYUFBYSxtQkFBbUI7QUFDM0QsTUFBSSxLQUFNLE1BQUssVUFBVSxPQUFPLGFBQWE7QUFDN0MsZ0JBQWM7QUFDZCxxQkFBbUI7QUFDckI7QUFFQSxTQUFTLDZCQUE2QixPQUE0QjtBQUNoRSxNQUFJLFdBQVcsYUFBYSxDQUFDLEtBQU07QUFDbkMsUUFBTSxRQUFRLE1BQU0sV0FBVyxLQUFLO0FBQ3BDLE1BQUksYUFBYTtBQUNqQixNQUFJLGNBQWM7QUFDbEIsTUFBSSxNQUFNLFFBQVEsWUFBYSxjQUFhLENBQUM7QUFBQSxXQUNwQyxNQUFNLFFBQVEsYUFBYyxjQUFhO0FBQUEsV0FDekMsTUFBTSxRQUFRLFVBQVcsZUFBYyxDQUFDO0FBQUEsV0FDeEMsTUFBTSxRQUFRLFlBQWEsZUFBYztBQUFBLE1BQzdDO0FBRUwsUUFBTSxPQUFPLEtBQUssc0JBQXNCO0FBQ3hDLCtCQUE2QixJQUFJO0FBQ2pDLGVBQWE7QUFBQSxJQUNYLEdBQUc7QUFBQSxJQUNILE9BQU8sT0FBTyxXQUFXLFNBQVMsS0FBSyxTQUFTLFlBQVksc0JBQXNCLGtCQUFrQixDQUFDO0FBQUEsSUFDckcsUUFBUSxPQUFPLFdBQVcsVUFBVSxLQUFLLFVBQVUsYUFBYSx1QkFBdUIsbUJBQW1CLENBQUM7QUFBQSxFQUM3RztBQUNBLFFBQU0sZUFBZTtBQUNyQixRQUFNLGdCQUFnQjtBQUN0QixxQkFBbUIsSUFBSTtBQUN2QiwyQkFBeUIsSUFBSTtBQUM3Qix5QkFBdUIsSUFBSTtBQUMzQixxQkFBbUI7QUFDckI7QUFFQSxTQUFTLG1CQUFtQixPQUF5QjtBQUNuRCxRQUFNLGVBQWU7QUFDckIsUUFBTSxnQkFBZ0I7QUFDdEIsZUFBYSxFQUFFLEdBQUcsWUFBWSxPQUFPLE1BQU0sUUFBUSxLQUFLO0FBQ3hELHFCQUFtQjtBQUNuQixNQUFJLE1BQU07QUFDUix1QkFBbUIsSUFBSTtBQUN2QiwyQkFBdUIsSUFBSTtBQUFBLEVBQzdCO0FBQ0Y7QUFFQSxTQUFTLHVCQUF1QixPQUF5QjtBQUN2RCxNQUFJLE1BQU0sa0JBQWtCLFdBQVcsTUFBTSxPQUFPLFFBQVEsUUFBUSxFQUFHO0FBQ3ZFLGVBQWEsRUFBRSxHQUFHLFlBQVksR0FBRyxNQUFNLEdBQUcsS0FBSztBQUMvQyxxQkFBbUI7QUFDbkIsTUFBSSxLQUFNLHdCQUF1QixJQUFJO0FBQ3ZDO0FBRUEsU0FBUyw2QkFBNkIsTUFBcUI7QUFDekQsTUFBSSxXQUFXLE1BQU0sUUFBUSxXQUFXLE1BQU0sTUFBTTtBQUNsRCxpQkFBYSxFQUFFLEdBQUcsWUFBWSxHQUFHLEtBQUssTUFBTSxHQUFHLEtBQUssSUFBSTtBQUFBLEVBQzFEO0FBQ0EsTUFBSSxXQUFXLFVBQVUsUUFBUSxXQUFXLFdBQVcsTUFBTTtBQUMzRCxpQkFBYSxFQUFFLEdBQUcsWUFBWSxPQUFPLEtBQUssT0FBTyxRQUFRLEtBQUssT0FBTztBQUFBLEVBQ3ZFO0FBQ0EsTUFBSSxNQUFNO0FBQ1IsdUJBQW1CLElBQUk7QUFDdkIsMkJBQXVCLElBQUk7QUFBQSxFQUM3QjtBQUNGO0FBRUEsU0FBUyxtQkFBbUIsU0FBNEI7QUFDdEQsTUFBSSxXQUFXLFdBQVc7QUFDeEIsWUFBUSxNQUFNLFFBQVE7QUFDdEIsWUFBUSxNQUFNLFNBQVM7QUFDdkI7QUFBQSxFQUNGO0FBRUEsTUFBSSxXQUFXLFVBQVUsTUFBTTtBQUM3QixZQUFRLE1BQU0sUUFBUTtBQUFBLEVBQ3hCLE9BQU87QUFDTCxZQUFRLE1BQU0sUUFBUSxHQUFHLE1BQU0sV0FBVyxPQUFPLHNCQUFzQixrQkFBa0IsQ0FBQyxDQUFDO0FBQUEsRUFDN0Y7QUFFQSxNQUFJLFdBQVcsV0FBVyxNQUFNO0FBQzlCLFlBQVEsTUFBTSxTQUFTO0FBQUEsRUFDekIsT0FBTztBQUNMLFlBQVEsTUFBTSxTQUFTLEdBQUcsTUFBTSxXQUFXLFFBQVEsdUJBQXVCLG1CQUFtQixDQUFDLENBQUM7QUFBQSxFQUNqRztBQUNGO0FBRUEsU0FBUyx1QkFBdUIsU0FBNEI7QUFDMUQsTUFBSSxXQUFXLE1BQU0sUUFBUSxXQUFXLE1BQU0sTUFBTTtBQUNsRCxZQUFRLE1BQU0sT0FBTztBQUNyQixZQUFRLE1BQU0sTUFBTTtBQUNwQixZQUFRLE1BQU0sUUFBUTtBQUN0QixZQUFRLE1BQU0sU0FBUztBQUN2QjtBQUFBLEVBQ0Y7QUFDQSwyQkFBeUIsT0FBTztBQUNoQyxVQUFRLE1BQU0sUUFBUTtBQUN0QixVQUFRLE1BQU0sU0FBUztBQUN2QixVQUFRLE1BQU0sT0FBTyxHQUFHLFdBQVcsQ0FBQztBQUNwQyxVQUFRLE1BQU0sTUFBTSxHQUFHLFdBQVcsQ0FBQztBQUNyQztBQUVBLFNBQVMseUJBQXlCLFNBQTRCO0FBQzVELE1BQUksV0FBVyxNQUFNLFFBQVEsV0FBVyxNQUFNLEtBQU07QUFDcEQsUUFBTSxPQUFPLFFBQVEsc0JBQXNCO0FBQzNDLGVBQWE7QUFBQSxJQUNYLEdBQUc7QUFBQSxJQUNILEdBQUcsTUFBTSxXQUFXLEdBQUcsNEJBQTRCLE9BQU8sYUFBYSxLQUFLLFFBQVEsMEJBQTBCO0FBQUEsSUFDOUcsR0FBRyxNQUFNLFdBQVcsR0FBRyw0QkFBNEIsT0FBTyxjQUFjLEtBQUssU0FBUywwQkFBMEI7QUFBQSxFQUNsSDtBQUNGO0FBRUEsU0FBUyxvQkFBNEI7QUFDbkMsUUFBTSxPQUFPLFdBQVcsS0FBSztBQUM3QixTQUFPLEtBQUssSUFBSSxzQkFBc0IsT0FBTyxhQUFhLE9BQU8sMEJBQTBCO0FBQzdGO0FBRUEsU0FBUyxxQkFBNkI7QUFDcEMsUUFBTSxNQUFNLFdBQVcsS0FBSztBQUM1QixTQUFPLEtBQUssSUFBSSx1QkFBdUIsT0FBTyxjQUFjLE1BQU0sMEJBQTBCO0FBQzlGO0FBRUEsU0FBUyxxQkFBcUM7QUFDNUMsTUFBSTtBQUNGLFVBQU0sU0FBUyxLQUFLLE1BQU0sYUFBYSxRQUFRLG9CQUFvQixLQUFLLElBQUk7QUFDNUUsV0FBTztBQUFBLE1BQ0wsV0FBVyxPQUFPLGNBQWM7QUFBQSxNQUNoQyxHQUFHLE9BQU8sT0FBTyxNQUFNLFlBQVksT0FBTyxTQUFTLE9BQU8sQ0FBQyxJQUFJLE9BQU8sSUFBSTtBQUFBLE1BQzFFLEdBQUcsT0FBTyxPQUFPLE1BQU0sWUFBWSxPQUFPLFNBQVMsT0FBTyxDQUFDLElBQUksT0FBTyxJQUFJO0FBQUEsTUFDMUUsT0FBTyxPQUFPLE9BQU8sVUFBVSxZQUFZLE9BQU8sU0FBUyxPQUFPLEtBQUssSUFBSSxPQUFPLFFBQVE7QUFBQSxNQUMxRixRQUFRLE9BQU8sT0FBTyxXQUFXLFlBQVksT0FBTyxTQUFTLE9BQU8sTUFBTSxJQUFJLE9BQU8sU0FBUztBQUFBLElBQ2hHO0FBQUEsRUFDRixRQUFRO0FBQ04sV0FBTyxFQUFFLFdBQVcsT0FBTyxHQUFHLE1BQU0sR0FBRyxNQUFNLE9BQU8sTUFBTSxRQUFRLEtBQUs7QUFBQSxFQUN6RTtBQUNGO0FBRUEsU0FBUyxxQkFBMkI7QUFDbEMsTUFBSTtBQUNGLGlCQUFhLFFBQVEsc0JBQXNCLEtBQUssVUFBVSxVQUFVLENBQUM7QUFBQSxFQUN2RSxRQUFRO0FBQUEsRUFBQztBQUNYO0FBRUEsU0FBUyxNQUFNLE9BQWUsS0FBYSxLQUFxQjtBQUM5RCxNQUFJLE1BQU0sSUFBSyxRQUFPO0FBQ3RCLFNBQU8sS0FBSyxJQUFJLEtBQUssSUFBSSxPQUFPLEdBQUcsR0FBRyxHQUFHO0FBQzNDO0FBRUEsU0FBUyx1QkFBOEM7QUFDckQsTUFBSSxnQkFBZ0IsWUFBYSxRQUFPO0FBQ3hDLFFBQU0sU0FBUyxTQUFTLFFBQVEsU0FBUztBQUN6QyxNQUFJLENBQUMsT0FBUSxRQUFPO0FBQ3BCLG1CQUFpQixTQUFTLGNBQWMsS0FBSztBQUM3QyxpQkFBZSxLQUFLO0FBQ3BCLGlCQUFlLE1BQU0sVUFBVTtBQUMvQixTQUFPLFlBQVksY0FBYztBQUNqQyxTQUFPO0FBQ1Q7QUFFQSxTQUFTLHFCQUFxQixVQUF1QztBQUNuRSxNQUFJLENBQUMsVUFBVTtBQUNiLHVCQUFtQjtBQUNuQjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLGFBQWEsb0JBQW9CLFNBQVMsUUFBUSxDQUFDO0FBQ3pELE1BQUksQ0FBQyxZQUFZO0FBQ2YsdUJBQW1CO0FBQ25CO0FBQUEsRUFDRjtBQUNBLHVCQUFxQixVQUFVLFdBQVcsS0FBSztBQUNqRDtBQUVBLFNBQVMscUJBQXFCLFVBQTBCLE9BQXFCO0FBQzNFLFFBQU1BLE1BQUsscUJBQXFCO0FBQ2hDLE1BQUksQ0FBQ0EsSUFBSTtBQUNULFFBQU0sT0FBTyxTQUFTLFFBQVEsc0JBQXNCO0FBQ3BELFFBQU0sUUFBUSxLQUFLLElBQUksS0FBSyxLQUFLLElBQUksS0FBSyxLQUFLLFNBQVMsR0FBRyxDQUFDO0FBQzVELFFBQU0sT0FBTyxLQUFLLElBQUksSUFBSSxLQUFLLElBQUksS0FBSyxNQUFNLE9BQU8sYUFBYSxRQUFRLEVBQUUsQ0FBQztBQUM3RSxRQUFNLE1BQU0sS0FBSyxJQUFJLElBQUksS0FBSyxNQUFNLEVBQUU7QUFFdEMsRUFBQUEsSUFBRyxZQUFZO0FBQ2YsRUFBQUEsSUFBRyxZQUFZO0FBQ2YsRUFBQUEsSUFBRyxNQUFNLE9BQU8sR0FBRyxJQUFJO0FBQ3ZCLEVBQUFBLElBQUcsTUFBTSxNQUFNLEdBQUcsR0FBRztBQUNyQixFQUFBQSxJQUFHLE1BQU0sUUFBUSxHQUFHLEtBQUs7QUFFekIsUUFBTSxPQUFPLFNBQVMsY0FBYyxRQUFRO0FBQzVDLE9BQUssT0FBTztBQUNaLE9BQUssWUFBWTtBQUNqQixPQUFLLGFBQWEsY0FBYyxjQUFjO0FBQzlDLE9BQUssaUJBQWlCLGFBQWEsQ0FBQyxVQUFVO0FBQzVDLFVBQU0sZUFBZTtBQUNyQixVQUFNLGdCQUFnQjtBQUN0Qix3QkFBb0IsUUFBUTtBQUFBLEVBQzlCLENBQUM7QUFFRCxRQUFNLFVBQVUsU0FBUyxjQUFjLE1BQU07QUFDN0MsVUFBUSxZQUFZO0FBQ3BCLFVBQVEsY0FBYztBQUN0QixNQUFJLE9BQU87QUFDVCxZQUFRLFFBQVEsUUFBUTtBQUFBLEVBQzFCO0FBRUEsUUFBTSxTQUFTLFNBQVMsY0FBYyxNQUFNO0FBQzVDLFNBQU8sWUFBWTtBQUNuQixTQUFPLGNBQWM7QUFFckIsT0FBSyxPQUFPLFNBQVMsTUFBTTtBQUMzQixFQUFBQSxJQUFHLFlBQVksSUFBSTtBQUNuQixFQUFBQSxJQUFHLE1BQU0sVUFBVTtBQUNyQjtBQUVBLFNBQVMsb0JBQW9CLFVBQWdDO0FBQzNELFdBQVMsUUFBUSxRQUFRO0FBQ3pCLHFCQUFtQjtBQUNyQjtBQUVBLFNBQVMscUJBQTJCO0FBQ2xDLE1BQUksZUFBZ0IsZ0JBQWUsTUFBTSxVQUFVO0FBQ3JEO0FBRUEsU0FBUyxnQkFBc0I7QUFDN0IsTUFBSSxTQUFTLGVBQWUsb0JBQW9CLEVBQUc7QUFDbkQsUUFBTSxTQUFTLFNBQVMsUUFBUSxTQUFTO0FBQ3pDLE1BQUksQ0FBQyxRQUFRO0FBQ1gsYUFBUyxpQkFBaUIsb0JBQW9CLE1BQU0sY0FBYyxHQUFHLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFDbkY7QUFBQSxFQUNGO0FBRUEsUUFBTSxRQUFRLFNBQVMsY0FBYyxPQUFPO0FBQzVDLFFBQU0sS0FBSztBQUNYLFFBQU0sY0FBYztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQW9NcEIsU0FBTyxZQUFZLEtBQUs7QUFDMUI7QUFFQSxTQUFTLG1CQUFtQixPQUFxQztBQUMvRCxRQUFNLE9BQU8sT0FBTyxNQUFNLGlCQUFpQixhQUFhLE1BQU0sYUFBYSxJQUFJLENBQUM7QUFDaEYsYUFBVyxRQUFRLE1BQU07QUFDdkIsUUFBSSxFQUFFLGdCQUFnQixhQUFjO0FBQ3BDLFVBQU0sV0FBVyxtQkFBbUIsSUFBSTtBQUN4QyxRQUFJLFNBQVUsUUFBTztBQUFBLEVBQ3ZCO0FBQ0EsU0FBTyxNQUFNLGtCQUFrQixjQUFjLG1CQUFtQixNQUFNLE1BQU0sSUFBSTtBQUNsRjtBQUVBLFNBQVMsbUJBQW1CLFNBQTZDO0FBQ3ZFLE1BQUksbUJBQW1CLHVCQUF1QixtQkFBbUIsa0JBQWtCO0FBQ2pGLFVBQU0sT0FBTyxtQkFBbUIsbUJBQW1CLFFBQVEsT0FBTztBQUNsRSxRQUFJLENBQUMsQ0FBQyxRQUFRLFVBQVUsVUFBVSxFQUFFLFNBQVMsSUFBSSxFQUFHLFFBQU87QUFDM0QsV0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFNBQVMsTUFBTSxRQUFRO0FBQUEsTUFDdkIsU0FBUyxDQUFDLFVBQVU7QUFDbEIsZ0JBQVEsUUFBUTtBQUNoQixnQkFBUSxNQUFNO0FBQ2QsWUFBSTtBQUNGLGtCQUFRLGtCQUFrQixNQUFNLFFBQVEsTUFBTSxNQUFNO0FBQUEsUUFDdEQsUUFBUTtBQUFBLFFBQUM7QUFDVCxnQkFBUSxjQUFjLElBQUksV0FBVyxTQUFTLEVBQUUsU0FBUyxNQUFNLFdBQVcsY0FBYyxNQUFNLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDeEc7QUFBQSxNQUNBLE9BQU8sTUFBTTtBQUNYLGdCQUFRLFFBQVE7QUFDaEIsZ0JBQVEsY0FBYyxJQUFJLFdBQVcsU0FBUyxFQUFFLFNBQVMsTUFBTSxXQUFXLHdCQUF3QixDQUFDLENBQUM7QUFBQSxNQUN0RztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsUUFBTSxXQUFXLFFBQVEsb0JBQ3JCLFVBQ0EsUUFBUSxRQUFxQiw0Q0FBNEM7QUFDN0UsTUFBSSxDQUFDLFNBQVUsUUFBTztBQUN0QixTQUFPO0FBQUEsSUFDTCxTQUFTO0FBQUEsSUFDVCxTQUFTLE1BQU0sU0FBUyxhQUFhLFNBQVMsZUFBZTtBQUFBLElBQzdELFNBQVMsQ0FBQyxVQUFVO0FBQ2xCLGVBQVMsY0FBYztBQUN2QixlQUFTLE1BQU07QUFDZixzQkFBZ0IsUUFBUTtBQUN4QixlQUFTLGNBQWMsSUFBSSxXQUFXLFNBQVMsRUFBRSxTQUFTLE1BQU0sV0FBVyxjQUFjLE1BQU0sTUFBTSxDQUFDLENBQUM7QUFBQSxJQUN6RztBQUFBLElBQ0EsT0FBTyxNQUFNO0FBQ1gsZUFBUyxjQUFjO0FBQ3ZCLGVBQVMsY0FBYyxJQUFJLFdBQVcsU0FBUyxFQUFFLFNBQVMsTUFBTSxXQUFXLHdCQUF3QixDQUFDLENBQUM7QUFBQSxJQUN2RztBQUFBLEVBQ0Y7QUFDRjtBQUVBLFNBQVMsZ0JBQWdCLFNBQTRCO0FBQ25ELFFBQU0sWUFBWSxPQUFPLGFBQWE7QUFDdEMsTUFBSSxDQUFDLFVBQVc7QUFDaEIsUUFBTSxRQUFRLFNBQVMsWUFBWTtBQUNuQyxRQUFNLG1CQUFtQixPQUFPO0FBQ2hDLFFBQU0sU0FBUyxLQUFLO0FBQ3BCLFlBQVUsZ0JBQWdCO0FBQzFCLFlBQVUsU0FBUyxLQUFLO0FBQzFCO0FBRUEsU0FBUyxlQUE4QjtBQUNyQyxRQUFNLGFBQXVCLENBQUMsU0FBUyxVQUFVLFNBQVMsTUFBTSxTQUFTLElBQUk7QUFDN0UsTUFBSTtBQUNGLFVBQU0sTUFBTSxJQUFJLElBQUksU0FBUyxJQUFJO0FBQ2pDLFVBQU0sZUFBZSxJQUFJLGFBQWEsSUFBSSxjQUFjO0FBQ3hELFFBQUksYUFBYyxZQUFXLEtBQUssWUFBWTtBQUFBLEVBQ2hELFFBQVE7QUFBQSxFQUFDO0FBQ1QsYUFBVyxLQUFLLEdBQUcsNkJBQTZCLFFBQVEsS0FBSyxDQUFDO0FBQzlELGFBQVcsS0FBSyxHQUFHLDJCQUEyQixDQUFDO0FBRS9DLGFBQVcsYUFBYSxZQUFZO0FBQ2xDLFVBQU0sV0FBVyxrQkFBa0IsU0FBUztBQUM1QyxRQUFJLFNBQVUsUUFBTztBQUFBLEVBQ3ZCO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxrQkFBa0IsT0FBOEI7QUFDdkQsUUFBTSxVQUFVLFdBQVcsS0FBSyxFQUFFLEtBQUs7QUFDdkMsUUFBTSxhQUFhLFFBQVEsTUFBTSxzQkFBc0I7QUFDdkQsTUFBSSxhQUFhLENBQUMsR0FBRztBQUNuQixVQUFNLFlBQVksdUJBQXVCLFdBQVcsQ0FBQyxDQUFDO0FBQ3RELFFBQUksVUFBVyxRQUFPO0FBQUEsRUFDeEI7QUFFQSxRQUFNLGFBQWEsUUFBUSxNQUFNLHVGQUF1RjtBQUN4SCxNQUFJLGFBQWEsQ0FBQyxFQUFHLFFBQU8sV0FBVyxDQUFDO0FBRXhDLFNBQU87QUFDVDtBQUVBLFNBQVMsdUJBQXVCLE9BQThCO0FBQzVELFFBQU0sVUFBVSxXQUFXLEtBQUssRUFBRSxLQUFLO0FBQ3ZDLFFBQU0sUUFBUSxRQUFRLE1BQU0seUVBQXlFO0FBQ3JHLFNBQU8sUUFBUSxDQUFDLEtBQUs7QUFDdkI7QUFFQSxTQUFTLDZCQUF1QztBQUM5QyxRQUFNLFlBQVk7QUFBQSxJQUNoQjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFDQSxRQUFNLGFBQXVCLENBQUM7QUFDOUIsYUFBVyxZQUFZLFdBQVc7QUFDaEMsZUFBVyxXQUFXLE1BQU0sS0FBSyxTQUFTLGlCQUE4QixRQUFRLENBQUMsR0FBRztBQUNsRixZQUFNLFFBQVEsUUFBUSxhQUFhLG1DQUFtQztBQUN0RSxVQUFJLE1BQU8sWUFBVyxLQUFLLEtBQUs7QUFBQSxJQUNsQztBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLFdBQVcsT0FBdUI7QUFDekMsTUFBSTtBQUNGLFdBQU8sbUJBQW1CLEtBQUs7QUFBQSxFQUNqQyxRQUFRO0FBQ04sV0FBTztBQUFBLEVBQ1Q7QUFDRjtBQUVBLFNBQVMsNkJBQTZCLE9BQWdCLFFBQVEsR0FBRyxPQUFPLG9CQUFJLElBQWEsR0FBYTtBQUNwRyxNQUFJLFFBQVEsS0FBSyxVQUFVLFFBQVEsVUFBVSxVQUFhLEtBQUssSUFBSSxLQUFLLEVBQUcsUUFBTyxDQUFDO0FBQ25GLE1BQUksT0FBTyxVQUFVLFNBQVUsUUFBTyxrQkFBa0IsS0FBSyxJQUFJLENBQUMsS0FBSyxJQUFJLENBQUM7QUFDNUUsTUFBSSxPQUFPLFVBQVUsU0FBVSxRQUFPLENBQUM7QUFDdkMsT0FBSyxJQUFJLEtBQUs7QUFFZCxRQUFNLGFBQXVCLENBQUM7QUFDOUIsYUFBVyxTQUFTLE9BQU8sT0FBTyxLQUFnQyxHQUFHO0FBQ25FLGVBQVcsS0FBSyxHQUFHLDZCQUE2QixPQUFPLFFBQVEsR0FBRyxJQUFJLENBQUM7QUFBQSxFQUN6RTtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsZ0JBQWdCLFFBQTRCO0FBQ25ELFVBQVEsUUFBUTtBQUFBLElBQ2QsS0FBSztBQUNILGFBQU87QUFBQSxJQUNULEtBQUs7QUFDSCxhQUFPO0FBQUEsSUFDVCxLQUFLO0FBQ0gsYUFBTztBQUFBLElBQ1QsS0FBSztBQUNILGFBQU87QUFBQSxFQUNYO0FBQ0Y7QUFFQSxTQUFTLGtCQUFrQixPQUF3QjtBQUNqRCxRQUFNLFVBQVUsZUFBZSxLQUFLO0FBQ3BDLE1BQUksNkJBQTZCLEtBQUssT0FBTyxHQUFHO0FBQzlDLFdBQU87QUFBQSxFQUNUO0FBQ0EsTUFBSSw0QkFBNEIsS0FBSyxPQUFPLEdBQUc7QUFDN0MsV0FBTztBQUFBLEVBQ1Q7QUFDQSxNQUFJLHFGQUFxRixLQUFLLE9BQU8sR0FBRztBQUN0RyxXQUFPO0FBQUEsRUFDVDtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsZUFBZSxTQUF5QjtBQUMvQyxNQUFJLENBQUMsT0FBTyxTQUFTLE9BQU8sS0FBSyxXQUFXLEVBQUcsUUFBTztBQUN0RCxRQUFNLFVBQVUsS0FBSyxNQUFNLFVBQVUsRUFBRTtBQUN2QyxRQUFNLG1CQUFtQixLQUFLLE1BQU0sVUFBVSxFQUFFO0FBQ2hELE1BQUksV0FBVyxFQUFHLFFBQU8sR0FBRyxnQkFBZ0I7QUFDNUMsUUFBTSxRQUFRLEtBQUssTUFBTSxVQUFVLEVBQUU7QUFDckMsUUFBTSxtQkFBbUIsVUFBVTtBQUNuQyxNQUFJLFNBQVMsRUFBRyxRQUFPLEdBQUcsT0FBTyxLQUFLLGdCQUFnQjtBQUN0RCxTQUFPLEdBQUcsS0FBSyxLQUFLLGdCQUFnQjtBQUN0QztBQUVBLFNBQVMsYUFBYSxPQUF1QjtBQUMzQyxTQUFPLE9BQU8sU0FBUyxLQUFLLElBQUksS0FBSyxNQUFNLEtBQUssRUFBRSxlQUFlLElBQUk7QUFDdkU7QUFFQSxTQUFTLFNBQVMsT0FBZSxXQUEyQjtBQUMxRCxTQUFPLE1BQU0sVUFBVSxZQUFZLFFBQVEsR0FBRyxNQUFNLE1BQU0sR0FBRyxZQUFZLENBQUMsQ0FBQztBQUM3RTtBQUVBLFNBQVMsZUFBZSxPQUF3QjtBQUM5QyxTQUFPLGlCQUFpQixRQUFRLE1BQU0sVUFBVSxPQUFPLEtBQUs7QUFDOUQ7QUFFQSxTQUFTLGFBQWEsT0FBcUM7QUFDekQsU0FBT0YsVUFBUyxLQUFLLEtBQ25CLE9BQU8sTUFBTSxhQUFhLFlBQzFCLE9BQU8sTUFBTSxjQUFjLFlBQzNCLE9BQU8sTUFBTSxXQUFXO0FBQzVCO0FBRUEsU0FBU0EsVUFBUyxPQUFrRDtBQUNsRSxTQUFPLFVBQVUsUUFBUSxPQUFPLFVBQVUsWUFBWSxDQUFDLE1BQU0sUUFBUSxLQUFLO0FBQzVFOzs7QUM1b0NBLElBQUFJLG1CQUE0QjtBQVE1QixJQUFNLHVCQUNKO0FBQ0YsSUFBTSx5QkFDSjtBQUNGLElBQU0sd0JBQXdCO0FBQzlCLElBQU0sZUFBZTtBQUNyQixJQUFNLGFBQWE7QUFDbkIsSUFBTSxXQUFXO0FBQ2pCLElBQU0sc0JBQXNCO0FBQzVCLElBQU0sZ0JBQWdCO0FBQ3RCLElBQU0saUJBQWlCO0FBQ3ZCLElBQU0sNkJBQTZCO0FBQ25DLElBQU0sb0JBQW9CO0FBQzFCLElBQU0sb0JBQW9CO0FBcUMxQixJQUFNQyxTQUF5QjtBQUFBLEVBQzdCLFVBQVU7QUFBQSxFQUNWLGNBQWM7QUFBQSxFQUNkLFVBQVU7QUFBQSxFQUNWLE9BQU87QUFBQSxFQUNQLGFBQWEsb0JBQUksSUFBSTtBQUFBLEVBQ3JCLGNBQWMsb0JBQUksSUFBSTtBQUN4QjtBQUVPLFNBQVMsa0JBQXdCO0FBQ3RDLE1BQUlBLE9BQU0sU0FBVTtBQUVwQixFQUFBQyxlQUFjO0FBRWQsUUFBTSxXQUFXLElBQUksaUJBQWlCLENBQUMsY0FBYztBQUNuRCxRQUFJLFVBQVUsS0FBSyxxQkFBcUIsR0FBRztBQUN6QyxzQkFBZ0IsVUFBVTtBQUFBLElBQzVCO0FBQUEsRUFDRixDQUFDO0FBQ0QsV0FBUyxRQUFRLFNBQVMsaUJBQWlCO0FBQUEsSUFDekMsV0FBVztBQUFBLElBQ1gsU0FBUztBQUFBLElBQ1QsWUFBWTtBQUFBLElBQ1osaUJBQWlCO0FBQUEsTUFDZjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFDRCxFQUFBRCxPQUFNLFdBQVc7QUFDakIsRUFBQUEsT0FBTSxXQUFXLFlBQVksTUFBTSxnQkFBZ0IsVUFBVSxHQUFHLElBQU07QUFDdEUsU0FBTyxpQkFBaUIsU0FBUyxhQUFhO0FBQzlDLGtCQUFnQixNQUFNO0FBQ3hCO0FBRUEsU0FBUyxnQkFBc0I7QUFDN0Isa0JBQWdCLE9BQU87QUFDekI7QUFFQSxTQUFTLHNCQUFzQixVQUFtQztBQUNoRSxNQUFJLFNBQVMsU0FBUyxjQUFjO0FBQ2xDLFVBQU0sU0FBUyxTQUFTO0FBQ3hCLFdBQU8sa0JBQWtCLFlBQ3ZCLE9BQU8sUUFBUSxvQkFBb0IsS0FDbkMsT0FBTyxRQUFRLHNCQUFzQixLQUNyQyxPQUFPLGFBQWEseUNBQXlDO0FBQUEsRUFFakU7QUFDQSxhQUFXLFFBQVEsTUFBTSxLQUFLLFNBQVMsVUFBVSxHQUFHO0FBQ2xELFFBQUksMkJBQTJCLElBQUksRUFBRyxRQUFPO0FBQUEsRUFDL0M7QUFDQSxhQUFXLFFBQVEsTUFBTSxLQUFLLFNBQVMsWUFBWSxHQUFHO0FBQ3BELFFBQUksMkJBQTJCLElBQUksRUFBRyxRQUFPO0FBQUEsRUFDL0M7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLDJCQUEyQixNQUFxQjtBQUN2RCxNQUFJLEVBQUUsZ0JBQWdCLFNBQVUsUUFBTztBQUN2QyxTQUFPLEtBQUssUUFBUSxvQkFBb0IsS0FBSyxRQUFRLEtBQUssY0FBYyxvQkFBb0IsQ0FBQztBQUMvRjtBQUVBLFNBQVMsZ0JBQWdCLFNBQXVCO0FBQzlDLE1BQUlBLE9BQU0sYUFBYyxjQUFhQSxPQUFNLFlBQVk7QUFDdkQsRUFBQUEsT0FBTSxlQUFlLFdBQVcsTUFBTTtBQUNwQyxJQUFBQSxPQUFNLGVBQWU7QUFDckIsU0FBSyxRQUFRO0FBQUEsRUFDZixHQUFHLG1CQUFtQjtBQUN4QjtBQUVBLGVBQWUsVUFBeUI7QUFDdEMsUUFBTSxRQUFRLEVBQUVBLE9BQU07QUFDdEIsUUFBTSxXQUFXLG1CQUFtQjtBQUNwQyxNQUFJLFNBQVMsV0FBVyxHQUFHO0FBQ3pCLHVCQUFtQjtBQUNuQjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLGFBQWEscUJBQXFCLFFBQVE7QUFDaEQsUUFBTSxpQkFDSCxhQUFhLFNBQVMsS0FBSyxDQUFDLFlBQVksUUFBUSxTQUFTLFVBQVUsSUFBSSxTQUN4RSxTQUFTLEtBQUssQ0FBQyxZQUFZLFFBQVEsSUFBSSxhQUFhLDJDQUEyQyxNQUFNLE9BQU8sS0FDNUcsU0FBUyxDQUFDO0FBRVosUUFBTSxnQkFBZ0Isd0JBQXdCLFVBQVUsYUFBYTtBQUNyRSxRQUFNLGdCQUFnQixNQUFNLFFBQVE7QUFBQSxJQUNsQyxjQUFjLElBQUksT0FBTyxZQUFZO0FBQ25DLFlBQU1FLFVBQVMsTUFBTSxVQUFVLFFBQVEsSUFBSTtBQUMzQyxhQUFPLEVBQUUsU0FBUyxRQUFBQSxRQUFPO0FBQUEsSUFDM0IsQ0FBQztBQUFBLEVBQ0g7QUFDQSxNQUFJLFVBQVVGLE9BQU0sTUFBTztBQUMzQixhQUFXLEVBQUUsU0FBUyxRQUFBRSxRQUFPLEtBQUssZUFBZTtBQUMvQyx1QkFBbUIsU0FBU0EsT0FBTTtBQUFBLEVBQ3BDO0FBRUEsUUFBTSxpQkFDSixjQUFjLEtBQUssQ0FBQyxFQUFFLFNBQVMsUUFBQUEsUUFBTyxNQUFNLFFBQVEsU0FBUyxlQUFlLFFBQVEsYUFBYUEsT0FBTSxDQUFDLEdBQ3BHLFdBQ0osY0FBYyxLQUFLLENBQUMsRUFBRSxRQUFBQSxRQUFPLE1BQU0sYUFBYUEsT0FBTSxDQUFDLEdBQUcsV0FDMUQ7QUFFRixNQUFJLENBQUMsZ0JBQWdCO0FBQ25CLHVCQUFtQjtBQUNuQjtBQUFBLEVBQ0Y7QUFFQSxRQUFNLENBQUMsUUFBUSxPQUFPLElBQUksTUFBTSxRQUFRLElBQUk7QUFBQSxJQUMxQyxVQUFVLGVBQWUsSUFBSTtBQUFBLElBQzdCLFdBQVcsZUFBZSxJQUFJO0FBQUEsRUFDaEMsQ0FBQztBQUNELE1BQUksVUFBVUYsT0FBTSxNQUFPO0FBQzNCLHFCQUFtQixnQkFBZ0IsUUFBUSxPQUFPO0FBQ3BEO0FBRUEsU0FBUyxxQkFBbUM7QUFDMUMsUUFBTSxPQUFPLG9CQUFJLElBQVk7QUFDN0IsUUFBTSxPQUFxQixDQUFDO0FBQzVCLGFBQVcsT0FBTyxNQUFNLEtBQUssU0FBUyxpQkFBOEIsb0JBQW9CLENBQUMsR0FBRztBQUMxRixVQUFNLE9BQU8sSUFBSSxhQUFhLG9DQUFvQyxHQUFHLEtBQUs7QUFDMUUsUUFBSSxDQUFDLFFBQVEsS0FBSyxJQUFJLElBQUksRUFBRztBQUM3QixTQUFLLElBQUksSUFBSTtBQUNiLFNBQUssS0FBSztBQUFBLE1BQ1I7QUFBQSxNQUNBO0FBQUEsTUFDQSxPQUFPLElBQUksYUFBYSx1Q0FBdUMsR0FBRyxLQUFLLEtBQUssU0FBUyxJQUFJO0FBQUEsTUFDekYsT0FBTyxpQkFBaUIsR0FBRztBQUFBLElBQzdCLENBQUM7QUFBQSxFQUNIO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxpQkFBaUIsS0FBc0M7QUFDOUQsTUFBSSxVQUE4QixJQUFJO0FBQ3RDLFNBQU8sV0FBVyxZQUFZLFNBQVMsTUFBTTtBQUMzQyxRQUFJLFFBQVEsYUFBYSxNQUFNLE1BQU0sY0FBYyxRQUFRLGFBQWEsU0FBUyxJQUFJLGVBQWUsRUFBRSxHQUFHO0FBQ3ZHLGFBQU87QUFBQSxJQUNUO0FBQ0EsUUFBSSxRQUFRLGNBQWMsb0JBQW9CLE1BQU0sT0FBTyxRQUFRLGNBQWMscUJBQXFCLEdBQUc7QUFDdkcsYUFBTztBQUFBLElBQ1Q7QUFDQSxjQUFVLFFBQVE7QUFBQSxFQUNwQjtBQUNBLFNBQU8sSUFBSTtBQUNiO0FBRUEsU0FBUyxxQkFBcUIsVUFBdUM7QUFDbkUsUUFBTSxlQUFlLFNBQVMsY0FBMkIsc0JBQXNCO0FBQy9FLFFBQU0sY0FBYyxjQUFjLFFBQXFCLHFCQUFxQjtBQUM1RSxRQUFNLFdBQVcsYUFBYSxhQUFhLHlDQUF5QyxHQUFHLEtBQUs7QUFDNUYsTUFBSSxTQUFVLFFBQU87QUFFckIsUUFBTSxXQUFXLFNBQVM7QUFBQSxJQUN4QixDQUFDLFlBQVksUUFBUSxJQUFJLGFBQWEsMkNBQTJDLE1BQU07QUFBQSxFQUN6RjtBQUNBLFNBQU8sVUFBVSxRQUFRO0FBQzNCO0FBRUEsU0FBUyx3QkFBd0IsVUFBd0IsZUFBcUQ7QUFDNUcsUUFBTSxVQUFVLFNBQVMsT0FBTyxDQUFDLFlBQVk7QUFDM0MsVUFBTSxPQUFPLFFBQVEsSUFBSSxzQkFBc0I7QUFDL0MsV0FBTyxLQUFLLFFBQVEsS0FBSyxLQUFLLFNBQVMsS0FBSyxLQUFLLFVBQVUsS0FBSyxLQUFLLE9BQU8sT0FBTztBQUFBLEVBQ3JGLENBQUM7QUFDRCxRQUFNLFVBQVUsZ0JBQ1osQ0FBQyxlQUFlLEdBQUcsUUFBUSxPQUFPLENBQUMsWUFBWSxRQUFRLFNBQVMsY0FBYyxJQUFJLENBQUMsSUFDbkY7QUFDSixTQUFPLFFBQVEsTUFBTSxHQUFHLDBCQUEwQjtBQUNwRDtBQUVBLGVBQWUsVUFBVSxNQUF5QztBQUNoRSxRQUFNLE1BQU0sS0FBSyxJQUFJO0FBQ3JCLFFBQU0sU0FBU0EsT0FBTSxZQUFZLElBQUksSUFBSTtBQUN6QyxNQUFJLFFBQVEsU0FBUyxNQUFNLE9BQU8sV0FBVyxjQUFlLFFBQU8sT0FBTztBQUMxRSxNQUFJLFFBQVEsUUFBUyxRQUFPLE9BQU87QUFFbkMsUUFBTSxRQUEwQixVQUFVO0FBQUEsSUFDeEMsT0FBTztBQUFBLElBQ1AsT0FBTztBQUFBLElBQ1AsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLEVBQ1g7QUFDQSxRQUFNLFVBQVUsNkJBQ2IsT0FBTyxzQkFBc0IsSUFBSSxFQUNqQyxLQUFLLENBQUMsV0FBVztBQUNoQixVQUFNLFFBQVE7QUFDZCxVQUFNLFFBQVE7QUFDZCxVQUFNLFdBQVcsS0FBSyxJQUFJO0FBQzFCLFdBQU8sTUFBTTtBQUFBLEVBQ2YsQ0FBQyxFQUNBLE1BQU0sQ0FBQyxVQUFtQjtBQUN6QixVQUFNLFFBQVEsaUJBQWlCLFFBQVEsTUFBTSxVQUFVLE9BQU8sS0FBSztBQUNuRSxVQUFNLFdBQVcsS0FBSyxJQUFJO0FBQzFCLFdBQU87QUFBQSxFQUNULENBQUMsRUFDQSxRQUFRLE1BQU07QUFDYixVQUFNLFVBQVU7QUFBQSxFQUNsQixDQUFDO0FBQ0gsRUFBQUEsT0FBTSxZQUFZLElBQUksTUFBTSxLQUFLO0FBQ2pDLFNBQU8sTUFBTTtBQUNmO0FBRUEsZUFBZSxXQUFXLE1BQTBDO0FBQ2xFLFFBQU0sTUFBTSxLQUFLLElBQUk7QUFDckIsUUFBTSxTQUFTQSxPQUFNLGFBQWEsSUFBSSxJQUFJO0FBQzFDLE1BQUksUUFBUSxTQUFTLE1BQU0sT0FBTyxXQUFXLGVBQWdCLFFBQU8sT0FBTztBQUMzRSxNQUFJLFFBQVEsUUFBUyxRQUFPLE9BQU87QUFFbkMsUUFBTSxRQUEyQixVQUFVO0FBQUEsSUFDekMsT0FBTztBQUFBLElBQ1AsT0FBTztBQUFBLElBQ1AsVUFBVTtBQUFBLElBQ1YsU0FBUztBQUFBLEVBQ1g7QUFDQSxRQUFNLFVBQVUsUUFBUSxJQUFJO0FBQUEsSUFDMUIsNkJBQVksT0FBTyw0QkFBNEIsSUFBSTtBQUFBLElBQ25ELDZCQUFZLE9BQU8seUJBQXlCLElBQUk7QUFBQSxFQUNsRCxDQUFDLEVBQ0UsS0FBSyxDQUFDLENBQUMsTUFBTSxTQUFTLE1BQU07QUFDM0IsVUFBTSxRQUFRLEVBQUUsTUFBTSxVQUFVO0FBQ2hDLFVBQU0sUUFBUTtBQUNkLFVBQU0sV0FBVyxLQUFLLElBQUk7QUFDMUIsV0FBTyxNQUFNO0FBQUEsRUFDZixDQUFDLEVBQ0EsTUFBTSxDQUFDLFVBQW1CO0FBQ3pCLFVBQU0sUUFBUSxpQkFBaUIsUUFBUSxNQUFNLFVBQVUsT0FBTyxLQUFLO0FBQ25FLFVBQU0sV0FBVyxLQUFLLElBQUk7QUFDMUIsV0FBTztBQUFBLEVBQ1QsQ0FBQyxFQUNBLFFBQVEsTUFBTTtBQUNiLFVBQU0sVUFBVTtBQUFBLEVBQ2xCLENBQUM7QUFDSCxFQUFBQSxPQUFNLGFBQWEsSUFBSSxNQUFNLEtBQUs7QUFDbEMsU0FBTyxNQUFNO0FBQ2Y7QUFFQSxTQUFTLG1CQUFtQixTQUFxQixRQUFnQztBQUMvRSxNQUFJLENBQUMsYUFBYSxNQUFNLEdBQUc7QUFDekIsWUFBUSxJQUFJLGNBQWMsSUFBSSxVQUFVLEdBQUcsR0FBRyxPQUFPO0FBQ3JEO0FBQUEsRUFDRjtBQUVBLFFBQU0sUUFBUSxZQUFZLFFBQVEsR0FBRztBQUNyQyxRQUFNLFFBQVEsV0FBVyxPQUFPLE9BQU87QUFDdkMsUUFBTSxZQUFZLGVBQWUsT0FBTyxPQUFPO0FBQy9DLFFBQU0sU0FBUyxZQUFZLE1BQU07QUFDakMsUUFBTSxPQUFPLFVBQVUsTUFBTTtBQUM3QixRQUFNLFVBQVUsT0FBTywyQkFBMkIsUUFBUSxDQUFDO0FBQzNELFFBQU0sVUFBVSxPQUFPLDhCQUE4QixZQUFZLENBQUM7QUFDbEUsUUFBTSxRQUFRO0FBQUEsSUFDWixHQUFHLFFBQVEsS0FBSyxLQUFLLE1BQU07QUFBQSxJQUMzQixVQUFVLElBQUksVUFBVSxHQUFHLEtBQUs7QUFBQSxJQUNoQyxZQUFZLElBQUksR0FBRyxTQUFTLFlBQVksT0FBTyxTQUFTLENBQUMsS0FBSztBQUFBLElBQzlELEtBQUs7QUFBQSxFQUNQLEVBQUUsT0FBTyxPQUFPLEVBQUUsS0FBSyxJQUFJO0FBQzNCLFFBQU0sY0FBYyxDQUFDLFFBQVEsUUFBUSxJQUFJLE9BQU8sS0FBSyxJQUFJLElBQUksS0FBSyxLQUFLLEVBQUUsT0FBTyxPQUFPLEVBQUUsS0FBSyxHQUFHO0FBQ25HO0FBRUEsU0FBUyxZQUFZLEtBQStCO0FBQ2xELFFBQU0sV0FBVyxJQUFJLGNBQTJCLElBQUksVUFBVSxHQUFHO0FBQ2pFLE1BQUksU0FBVSxRQUFPO0FBRXJCLFFBQU0sUUFBUSxTQUFTLGNBQWMsTUFBTTtBQUMzQyxRQUFNLGFBQWEsWUFBWSxFQUFFO0FBQ2pDLFFBQU0sWUFBWTtBQUNsQixNQUFJLFlBQVksS0FBSztBQUNyQixTQUFPO0FBQ1Q7QUFFQSxTQUFTLG1CQUFtQixTQUFxQixRQUEwQixTQUFrQztBQUMzRyxNQUFJLENBQUMsYUFBYSxNQUFNLEdBQUc7QUFDekIsdUJBQW1CO0FBQ25CO0FBQUEsRUFDRjtBQUVBLFFBQU0sT0FBTyxRQUFRLFNBQVMsUUFBUSxJQUFJO0FBQzFDLE1BQUksQ0FBQyxLQUFNO0FBRVgsUUFBTSxRQUFRLG1CQUFtQixNQUFNLFFBQVEsR0FBRztBQUNsRCxRQUFNLEtBQUs7QUFFWCxRQUFNLFFBQVEsV0FBVyxPQUFPLE9BQU87QUFDdkMsUUFBTSxTQUFTLFlBQVksT0FBTyxPQUFPO0FBQ3pDLFFBQU0sU0FBUyxZQUFZLE1BQU07QUFDakMsUUFBTSxPQUFPLFVBQVUsTUFBTTtBQUM3QixRQUFNLE9BQU8sU0FBUyxRQUFRO0FBQzlCLFFBQU0sWUFBWSxTQUFTLGFBQWEsQ0FBQztBQUV6QyxRQUFNLFNBQVMsR0FBRyxPQUFPLDRCQUE0QjtBQUNyRCxRQUFNLFFBQVEsR0FBRyxPQUFPLDJCQUEyQjtBQUNuRCxRQUFNLE9BQU8sT0FBTyxRQUFRLEtBQUssQ0FBQztBQUNsQyxRQUFNLE9BQU8sT0FBTyxVQUFVLE1BQU0sQ0FBQztBQUNyQyxNQUFJLEtBQUssTUFBTyxPQUFNLE9BQU8sT0FBTyxRQUFRLEtBQUssS0FBSyxDQUFDO0FBQ3ZELFFBQU0sWUFBWSxPQUFPLFFBQVEsVUFBVSxJQUFJLFVBQVUsR0FBRyxLQUFLLFVBQVU7QUFDM0UsWUFBVSxZQUFZLDZCQUE2QixVQUFVLElBQUksYUFBYSxVQUFVO0FBQ3hGLFNBQU8sT0FBTyxPQUFPLFNBQVM7QUFDOUIsUUFBTSxPQUFPLE1BQU07QUFFbkIsUUFBTSxVQUFVLEdBQUcsT0FBTyw2QkFBNkI7QUFDdkQsVUFBUTtBQUFBLElBQ04sT0FBTyxVQUFVLE9BQU8sTUFBTTtBQUFBLElBQzlCLE9BQU8sWUFBWSxPQUFPLFFBQVE7QUFBQSxJQUNsQyxPQUFPLGFBQWEsT0FBTyxTQUFTO0FBQUEsSUFDcEMsT0FBTyxhQUFhLE9BQU8sU0FBUztBQUFBLEVBQ3RDO0FBQ0EsUUFBTSxPQUFPLE9BQU87QUFFcEIsTUFBSSxNQUFNO0FBQ1IsVUFBTSxXQUFXLEdBQUcsT0FBTywwQkFBMEI7QUFDckQsYUFBUztBQUFBLE1BQ1AsT0FBTyxRQUFRLEdBQUcsS0FBSyxTQUFTLFFBQVEsT0FBTyxLQUFLLFNBQVMsQ0FBQyxFQUFFO0FBQUEsTUFDaEUsT0FBTyxRQUFRLElBQUksS0FBSyxVQUFVLEVBQUU7QUFBQSxNQUNwQyxPQUFPLFFBQVEsSUFBSSxLQUFLLFNBQVMsRUFBRTtBQUFBLE1BQ25DLEdBQUksS0FBSyxZQUFZLENBQUMsT0FBTyxRQUFRLFdBQVcsQ0FBQyxJQUFJLENBQUM7QUFBQSxJQUN4RDtBQUNBLFVBQU0sT0FBTyxRQUFRO0FBQUEsRUFDdkI7QUFFQSxRQUFNLFVBQVUsT0FBTyxRQUFRLE9BQU8sQ0FBQyxVQUFVLE1BQU0sU0FBUyxTQUFTLEVBQUUsTUFBTSxHQUFHLGlCQUFpQjtBQUNyRyxNQUFJLFFBQVEsU0FBUyxHQUFHO0FBQ3RCLFVBQU0sT0FBTyxHQUFHLE9BQU8sMkJBQTJCO0FBQ2xELGVBQVcsU0FBUyxTQUFTO0FBQzNCLFlBQU0sTUFBTSxHQUFHLE9BQU8sc0JBQXNCO0FBQzVDLFVBQUksT0FBTyxPQUFPLFFBQVEsV0FBVyxLQUFLLENBQUMsR0FBRyxPQUFPLFFBQVEsVUFBVSxLQUFLLENBQUMsQ0FBQztBQUM5RSxXQUFLLE9BQU8sR0FBRztBQUFBLElBQ2pCO0FBQ0EsUUFBSSxPQUFPLFFBQVEsU0FBUyxRQUFRLFFBQVE7QUFDMUMsWUFBTSxPQUFPLE9BQU8sT0FBTyxJQUFJLE9BQU8sUUFBUSxTQUFTLFFBQVEsTUFBTSxPQUFPO0FBQzVFLFdBQUssWUFBWTtBQUNqQixXQUFLLE9BQU8sSUFBSTtBQUFBLElBQ2xCO0FBQ0EsVUFBTSxPQUFPLElBQUk7QUFBQSxFQUNuQjtBQUVBLE1BQUksVUFBVSxTQUFTLEdBQUc7QUFDeEIsVUFBTSxlQUFlLEdBQUcsT0FBTyx1QkFBdUI7QUFDdEQsVUFBTSxRQUFRLE9BQU8sT0FBTyxHQUFHLFVBQVUsTUFBTSxZQUFZO0FBQzNELFVBQU0sWUFBWTtBQUNsQixpQkFBYSxPQUFPLEtBQUs7QUFDekIsZUFBVyxZQUFZLFVBQVUsTUFBTSxHQUFHLGlCQUFpQixHQUFHO0FBQzVELFlBQU0sTUFBTSxHQUFHLE9BQU8sMEJBQTBCO0FBQ2hELFVBQUk7QUFBQSxRQUNGLE9BQU8sUUFBUSxTQUFTLFVBQVUsU0FBUyxTQUFTLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDdkUsT0FBTyxRQUFRLFNBQVMsU0FBUyxJQUFJLENBQUM7QUFBQSxNQUN4QztBQUNBLG1CQUFhLE9BQU8sR0FBRztBQUFBLElBQ3pCO0FBQ0EsVUFBTSxPQUFPLFlBQVk7QUFBQSxFQUMzQjtBQUVBLFFBQU0sUUFBUSxPQUFPLFdBQVcsT0FBTyxXQUFXQSxPQUFNLFlBQVksSUFBSSxRQUFRLElBQUksR0FBRyxTQUFTQSxPQUFNLGFBQWEsSUFBSSxRQUFRLElBQUksR0FBRztBQUN0SSxNQUFJLE9BQU87QUFDVCxVQUFNLFVBQVUsT0FBTyxPQUFPLEtBQUs7QUFDbkMsWUFBUSxZQUFZO0FBQ3BCLFVBQU0sT0FBTyxPQUFPO0FBQUEsRUFDdEI7QUFDRjtBQUVBLFNBQVMsYUFBYSxRQUErQztBQUNuRSxTQUFPLFFBQVEsUUFBUSxXQUFXLFNBQVMsT0FBTyxXQUFXLGdCQUFnQjtBQUMvRTtBQUVBLFNBQVMsbUJBQW1CLE1BQW1CLEtBQStCO0FBQzVFLE1BQUksUUFBUSxTQUFTLGNBQTJCLElBQUksWUFBWSxHQUFHO0FBQ25FLE1BQUksQ0FBQyxPQUFPO0FBQ1YsWUFBUSxTQUFTLGNBQWMsU0FBUztBQUN4QyxVQUFNLGFBQWEsY0FBYyxFQUFFO0FBQ25DLFVBQU0sWUFBWTtBQUFBLEVBQ3BCO0FBRUEsTUFBSSxNQUFNLGtCQUFrQixNQUFNO0FBQ2hDLFVBQU0sT0FBTztBQUNiLFNBQUssYUFBYSxPQUFPLElBQUksa0JBQWtCO0FBQUEsRUFDakQsV0FBVyxNQUFNLDJCQUEyQixLQUFLO0FBQy9DLFNBQUssYUFBYSxPQUFPLElBQUksa0JBQWtCO0FBQUEsRUFDakQ7QUFFQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLHFCQUEyQjtBQUNsQyxXQUFTLGNBQWMsSUFBSSxZQUFZLEdBQUcsR0FBRyxPQUFPO0FBQ3REO0FBRUEsU0FBUyxZQUFZLFNBS25CO0FBQ0EsTUFBSSxTQUFTO0FBQ2IsTUFBSSxXQUFXO0FBQ2YsTUFBSSxZQUFZO0FBQ2hCLE1BQUksWUFBWTtBQUNoQixhQUFXLFNBQVMsU0FBUztBQUMzQixZQUFRLE1BQU0sTUFBTTtBQUFBLE1BQ2xCLEtBQUs7QUFBQSxNQUNMLEtBQUs7QUFDSCxZQUFJLE1BQU0sVUFBVSxJQUFLO0FBQ3pCLFlBQUksTUFBTSxhQUFhLElBQUs7QUFDNUI7QUFBQSxNQUNGLEtBQUs7QUFDSDtBQUNBO0FBQUEsTUFDRixLQUFLO0FBQ0g7QUFDQTtBQUFBLE1BQ0YsS0FBSztBQUNIO0FBQUEsSUFDSjtBQUFBLEVBQ0Y7QUFDQSxTQUFPLEVBQUUsUUFBUSxVQUFVLFdBQVcsVUFBVTtBQUNsRDtBQUVBLFNBQVMsV0FBVyxTQUFtQztBQUNyRCxTQUFPLFFBQVEsT0FBTyxDQUFDLFVBQVUsTUFBTSxTQUFTLFNBQVMsRUFBRTtBQUM3RDtBQUVBLFNBQVMsZUFBZSxTQUFtQztBQUN6RCxTQUFPLFFBQVEsT0FBTyxDQUFDLFVBQVUsTUFBTSxTQUFTLFVBQVUsRUFBRTtBQUM5RDtBQUVBLFNBQVMsWUFBWSxRQUEyQjtBQUM5QyxTQUNFLE9BQU8sT0FBTyxRQUNkLE9BQU8sV0FBVyxjQUNsQixTQUFTLE9BQU8sT0FBTyxHQUFHLEtBQzFCLFNBQVMsT0FBTyxXQUFXLE9BQU8sS0FDbEM7QUFFSjtBQUVBLFNBQVMsVUFBVSxRQUFxRDtBQUN0RSxRQUFNLFFBQVEsT0FBTyxPQUFPLFNBQVM7QUFDckMsUUFBTSxTQUFTLE9BQU8sT0FBTyxVQUFVO0FBQ3ZDLFFBQU0sUUFBUSxDQUFDLFFBQVEsSUFBSSxJQUFJLEtBQUssS0FBSyxJQUFJLFNBQVMsSUFBSSxJQUFJLE1BQU0sS0FBSyxFQUFFLEVBQ3hFLE9BQU8sT0FBTyxFQUNkLEtBQUssR0FBRztBQUNYLFFBQU0sUUFBUTtBQUFBLElBQ1osUUFBUSxJQUFJLEdBQUcsS0FBSyxXQUFXO0FBQUEsSUFDL0IsU0FBUyxJQUFJLEdBQUcsTUFBTSxZQUFZO0FBQUEsSUFDbEMsT0FBTyxPQUFPLFdBQVcsWUFBWSxPQUFPLE9BQU8sUUFBUSxLQUFLO0FBQUEsRUFDbEUsRUFBRSxPQUFPLE9BQU8sRUFBRSxLQUFLLElBQUk7QUFDM0IsU0FBTyxFQUFFLE9BQU8sTUFBTTtBQUN4QjtBQUVBLFNBQVMsV0FBVyxPQUErQjtBQUNqRCxVQUFRLE1BQU0sTUFBTTtBQUFBLElBQ2xCLEtBQUs7QUFDSCxhQUFPLEdBQUcsTUFBTSxLQUFLLEdBQUcsTUFBTSxRQUFRLEdBQUcsV0FBVyxLQUFLLEVBQUU7QUFBQSxJQUM3RCxLQUFLO0FBQ0gsYUFBTztBQUFBLElBQ1QsS0FBSztBQUNILGFBQU87QUFBQSxJQUNULEtBQUs7QUFDSCxhQUFPO0FBQUEsSUFDVCxLQUFLO0FBQ0gsYUFBTztBQUFBLEVBQ1g7QUFDRjtBQUVBLFNBQVMsVUFBVSxPQUErQjtBQUNoRCxNQUFJLE1BQU0sU0FBUyxTQUFVLFFBQU8sR0FBRyxNQUFNLFlBQVksT0FBTyxNQUFNLElBQUk7QUFDMUUsU0FBTyxNQUFNO0FBQ2Y7QUFFQSxTQUFTLE9BQU8sT0FBZSxPQUE0QjtBQUN6RCxRQUFNLE9BQU8sR0FBRyxPQUFPLG9CQUFvQjtBQUMzQyxPQUFLLE9BQU8sT0FBTyxRQUFRLE9BQU8sS0FBSyxDQUFDLEdBQUcsT0FBTyxRQUFRLEtBQUssQ0FBQztBQUNoRSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLFNBQVMsS0FBK0M7QUFDL0QsU0FBTyxNQUFNLElBQUksTUFBTSxHQUFHLENBQUMsSUFBSTtBQUNqQztBQUVBLFNBQVMsU0FBUyxNQUFzQjtBQUN0QyxRQUFNLFVBQVUsS0FBSyxRQUFRLFFBQVEsRUFBRTtBQUN2QyxRQUFNLE1BQU0sUUFBUSxZQUFZLEdBQUc7QUFDbkMsU0FBTyxPQUFPLElBQUksUUFBUSxNQUFNLE1BQU0sQ0FBQyxJQUFJO0FBQzdDO0FBRUEsU0FBUyxPQUFPLE9BQXVCO0FBQ3JDLFNBQU8sVUFBVSxJQUFJLEtBQUs7QUFDNUI7QUFFQSxTQUFTLE1BQU0sTUFBeUI7QUFDdEMsU0FBTyxLQUFLLFdBQVksTUFBSyxXQUFXLE9BQU87QUFDakQ7QUFFQSxTQUFTLEdBQUcsS0FBd0IsV0FBZ0M7QUFDbEUsUUFBTSxPQUFPLFNBQVMsY0FBYyxHQUFHO0FBQ3ZDLE9BQUssWUFBWTtBQUNqQixTQUFPO0FBQ1Q7QUFFQSxTQUFTLE9BQU8sS0FBZ0MsTUFBMkI7QUFDekUsUUFBTSxPQUFPLFNBQVMsY0FBYyxHQUFHO0FBQ3ZDLE9BQUssY0FBYztBQUNuQixTQUFPO0FBQ1Q7QUFFQSxTQUFTQyxpQkFBc0I7QUFDN0IsTUFBSSxTQUFTLGVBQWUsUUFBUSxFQUFHO0FBQ3ZDLFFBQU0sUUFBUSxTQUFTLGNBQWMsT0FBTztBQUM1QyxRQUFNLEtBQUs7QUFDWCxRQUFNLGNBQWM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQStJcEIsV0FBUyxLQUFLLFlBQVksS0FBSztBQUNqQzs7O0FQNXFCQSxTQUFTLFFBQVEsT0FBZSxPQUF1QjtBQUNyRCxRQUFNLE1BQU0sNEJBQTRCLEtBQUssR0FDM0MsVUFBVSxTQUFZLEtBQUssTUFBTUUsZUFBYyxLQUFLLENBQ3REO0FBQ0EsTUFBSTtBQUNGLFlBQVEsTUFBTSxHQUFHO0FBQUEsRUFDbkIsUUFBUTtBQUFBLEVBQUM7QUFDVCxNQUFJO0FBQ0YsaUNBQVksS0FBSyx1QkFBdUIsUUFBUSxHQUFHO0FBQUEsRUFDckQsUUFBUTtBQUFBLEVBQUM7QUFDWDtBQUNBLFNBQVNBLGVBQWMsR0FBb0I7QUFDekMsTUFBSTtBQUNGLFdBQU8sT0FBTyxNQUFNLFdBQVcsSUFBSSxLQUFLLFVBQVUsQ0FBQztBQUFBLEVBQ3JELFFBQVE7QUFDTixXQUFPLE9BQU8sQ0FBQztBQUFBLEVBQ2pCO0FBQ0Y7QUFFQSxRQUFRLGlCQUFpQixFQUFFLEtBQUssU0FBUyxLQUFLLENBQUM7QUFHL0MsSUFBSTtBQUNGLG1CQUFpQjtBQUNqQixVQUFRLHNCQUFzQjtBQUNoQyxTQUFTLEdBQUc7QUFDVixVQUFRLHFCQUFxQixPQUFPLENBQUMsQ0FBQztBQUN4QztBQUVBLElBQUk7QUFDRixtQkFBaUIsT0FBTztBQUMxQixTQUFTLEdBQUc7QUFDVixVQUFRLHVCQUF1QixPQUFPLENBQUMsQ0FBQztBQUMxQztBQUVBLGVBQWUsTUFBTTtBQUNuQixNQUFJLFNBQVMsZUFBZSxXQUFXO0FBQ3JDLGFBQVMsaUJBQWlCLG9CQUFvQixNQUFNLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUNwRSxPQUFPO0FBQ0wsU0FBSztBQUFBLEVBQ1A7QUFDRixDQUFDO0FBRUQsZUFBZSxPQUFPO0FBQ3BCLFVBQVEsY0FBYyxFQUFFLFlBQVksU0FBUyxXQUFXLENBQUM7QUFDekQsTUFBSTtBQUNGLDBCQUFzQjtBQUN0QixZQUFRLDJCQUEyQjtBQUNuQyxvQkFBZ0I7QUFDaEIsWUFBUSxxQkFBcUI7QUFDN0IsVUFBTSxlQUFlO0FBQ3JCLFlBQVEsb0JBQW9CO0FBQzVCLFVBQU0sYUFBYTtBQUNuQixZQUFRLGlCQUFpQjtBQUN6QixvQkFBZ0I7QUFDaEIsWUFBUSxlQUFlO0FBQUEsRUFDekIsU0FBUyxHQUFHO0FBQ1YsWUFBUSxlQUFlLE9BQVEsR0FBYSxTQUFTLENBQUMsQ0FBQztBQUN2RCxZQUFRLE1BQU0seUNBQXlDLENBQUM7QUFBQSxFQUMxRDtBQUNGO0FBSUEsSUFBSSxZQUFrQztBQUN0QyxTQUFTLGtCQUF3QjtBQUMvQiwrQkFBWSxHQUFHLDBCQUEwQixNQUFNO0FBQzdDLFFBQUksVUFBVztBQUNmLGlCQUFhLFlBQVk7QUFDdkIsVUFBSTtBQUNGLGdCQUFRLEtBQUssdUNBQXVDO0FBQ3BELDBCQUFrQjtBQUNsQixjQUFNLGVBQWU7QUFDckIsY0FBTSxhQUFhO0FBQUEsTUFDckIsU0FBUyxHQUFHO0FBQ1YsZ0JBQVEsTUFBTSx1Q0FBdUMsQ0FBQztBQUFBLE1BQ3hELFVBQUU7QUFDQSxvQkFBWTtBQUFBLE1BQ2Q7QUFBQSxJQUNGLEdBQUc7QUFBQSxFQUNMLENBQUM7QUFDSDsiLAogICJuYW1lcyI6IFsiaW1wb3J0X2VsZWN0cm9uIiwgInJvb3QiLCAiY2FyZCIsICJlbCIsICJpbXBvcnRfZWxlY3Ryb24iLCAibW9kdWxlIiwgImV4cG9ydHMiLCAiZWwiLCAiaW1wb3J0X2VsZWN0cm9uIiwgInJvb3QiLCAiaW1wb3J0X2VsZWN0cm9uIiwgImlzUmVjb3JkIiwgInJlc3BvbnNlIiwgImVsIiwgImJ1dHRvbiIsICJpbXBvcnRfZWxlY3Ryb24iLCAic3RhdGUiLCAiaW5zdGFsbFN0eWxlcyIsICJzdGF0dXMiLCAic2FmZVN0cmluZ2lmeSJdCn0K
