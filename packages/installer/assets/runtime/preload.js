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
        `https://github.com/b-nnett/codex-plusplus/issues/new?title=${title}&body=${body}`
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL21hbmFnZXIudHMiLCAiLi4vc3JjL3ByZWxvYWQvYXBwLXNlcnZlci1icmlkZ2UudHMiLCAiLi4vc3JjL3ByZWxvYWQvZ29hbC1mZWF0dXJlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlbmRlcmVyIHByZWxvYWQgZW50cnkuIFJ1bnMgaW4gYW4gaXNvbGF0ZWQgd29ybGQgYmVmb3JlIENvZGV4J3MgcGFnZSBKUy5cbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAgIDEuIEluc3RhbGwgYSBSZWFjdCBEZXZUb29scy1zaGFwZWQgZ2xvYmFsIGhvb2sgdG8gY2FwdHVyZSB0aGUgcmVuZGVyZXJcbiAqICAgICAgcmVmZXJlbmNlIHdoZW4gUmVhY3QgbW91bnRzLiBXZSB1c2UgdGhpcyBmb3IgZmliZXIgd2Fsa2luZy5cbiAqICAgMi4gQWZ0ZXIgRE9NQ29udGVudExvYWRlZCwga2ljayBvZmYgc2V0dGluZ3MtaW5qZWN0aW9uIGxvZ2ljLlxuICogICAzLiBEaXNjb3ZlciByZW5kZXJlci1zY29wZWQgdHdlYWtzICh2aWEgSVBDIHRvIG1haW4pIGFuZCBzdGFydCB0aGVtLlxuICogICA0LiBMaXN0ZW4gZm9yIGBjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkYCBmcm9tIG1haW4gKGZpbGVzeXN0ZW0gd2F0Y2hlcikgYW5kXG4gKiAgICAgIGhvdC1yZWxvYWQgdHdlYWtzIHdpdGhvdXQgZHJvcHBpbmcgdGhlIHBhZ2UuXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IGluc3RhbGxSZWFjdEhvb2sgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgeyBzdGFydFNldHRpbmdzSW5qZWN0b3IgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgc3RhcnRUd2Vha0hvc3QsIHRlYXJkb3duVHdlYWtIb3N0IH0gZnJvbSBcIi4vdHdlYWstaG9zdFwiO1xuaW1wb3J0IHsgbW91bnRNYW5hZ2VyIH0gZnJvbSBcIi4vbWFuYWdlclwiO1xuaW1wb3J0IHsgc3RhcnRHb2FsRmVhdHVyZSB9IGZyb20gXCIuL2dvYWwtZmVhdHVyZVwiO1xuXG4vLyBGaWxlLWxvZyBwcmVsb2FkIHByb2dyZXNzIHNvIHdlIGNhbiBkaWFnbm9zZSB3aXRob3V0IERldlRvb2xzLiBCZXN0LWVmZm9ydDpcbi8vIGZhaWx1cmVzIGhlcmUgbXVzdCBuZXZlciB0aHJvdyBiZWNhdXNlIHdlJ2QgdGFrZSB0aGUgcGFnZSBkb3duIHdpdGggdXMuXG4vL1xuLy8gQ29kZXgncyByZW5kZXJlciBpcyBzYW5kYm94ZWQgKHNhbmRib3g6IHRydWUpLCBzbyBgcmVxdWlyZShcIm5vZGU6ZnNcIilgIGlzXG4vLyB1bmF2YWlsYWJsZS4gV2UgZm9yd2FyZCBsb2cgbGluZXMgdG8gbWFpbiB2aWEgSVBDOyBtYWluIHdyaXRlcyB0aGUgZmlsZS5cbmZ1bmN0aW9uIGZpbGVMb2coc3RhZ2U6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKTogdm9pZCB7XG4gIGNvbnN0IG1zZyA9IGBbY29kZXgtcGx1c3BsdXMgcHJlbG9hZF0gJHtzdGFnZX0ke1xuICAgIGV4dHJhID09PSB1bmRlZmluZWQgPyBcIlwiIDogXCIgXCIgKyBzYWZlU3RyaW5naWZ5KGV4dHJhKVxuICB9YDtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLCBcImluZm9cIiwgbXNnKTtcbiAgfSBjYXRjaCB7fVxufVxuZnVuY3Rpb24gc2FmZVN0cmluZ2lmeSh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyB2IDogSlNPTi5zdHJpbmdpZnkodik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBTdHJpbmcodik7XG4gIH1cbn1cblxuZmlsZUxvZyhcInByZWxvYWQgZW50cnlcIiwgeyB1cmw6IGxvY2F0aW9uLmhyZWYgfSk7XG5cbi8vIFJlYWN0IGhvb2sgbXVzdCBiZSBpbnN0YWxsZWQgKmJlZm9yZSogQ29kZXgncyBidW5kbGUgcnVucy5cbnRyeSB7XG4gIGluc3RhbGxSZWFjdEhvb2soKTtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgaW5zdGFsbGVkXCIpO1xufSBjYXRjaCAoZSkge1xuICBmaWxlTG9nKFwicmVhY3QgaG9vayBGQUlMRURcIiwgU3RyaW5nKGUpKTtcbn1cblxudHJ5IHtcbiAgc3RhcnRHb2FsRmVhdHVyZShmaWxlTG9nKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcImdvYWwgZmVhdHVyZSBGQUlMRURcIiwgU3RyaW5nKGUpKTtcbn1cblxucXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICBpZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gXCJsb2FkaW5nXCIpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBib290LCB7IG9uY2U6IHRydWUgfSk7XG4gIH0gZWxzZSB7XG4gICAgYm9vdCgpO1xuICB9XG59KTtcblxuYXN5bmMgZnVuY3Rpb24gYm9vdCgpIHtcbiAgZmlsZUxvZyhcImJvb3Qgc3RhcnRcIiwgeyByZWFkeVN0YXRlOiBkb2N1bWVudC5yZWFkeVN0YXRlIH0pO1xuICB0cnkge1xuICAgIHN0YXJ0U2V0dGluZ3NJbmplY3RvcigpO1xuICAgIGZpbGVMb2coXCJzZXR0aW5ncyBpbmplY3RvciBzdGFydGVkXCIpO1xuICAgIGF3YWl0IHN0YXJ0VHdlYWtIb3N0KCk7XG4gICAgZmlsZUxvZyhcInR3ZWFrIGhvc3Qgc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBtb3VudE1hbmFnZXIoKTtcbiAgICBmaWxlTG9nKFwibWFuYWdlciBtb3VudGVkXCIpO1xuICAgIHN1YnNjcmliZVJlbG9hZCgpO1xuICAgIGZpbGVMb2coXCJib290IGNvbXBsZXRlXCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZmlsZUxvZyhcImJvb3QgRkFJTEVEXCIsIFN0cmluZygoZSBhcyBFcnJvcik/LnN0YWNrID8/IGUpKTtcbiAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSBwcmVsb2FkIGJvb3QgZmFpbGVkOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBIb3QgcmVsb2FkOiBnYXRlZCBiZWhpbmQgYSBzbWFsbCBpbi1mbGlnaHQgbG9jayBzbyBhIGZsdXJyeSBvZiBmcyBldmVudHNcbi8vIGRvZXNuJ3QgcmVlbnRyYW50bHkgdGVhciBkb3duIHRoZSBob3N0IG1pZC1sb2FkLlxubGV0IHJlbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuZnVuY3Rpb24gc3Vic2NyaWJlUmVsb2FkKCk6IHZvaWQge1xuICBpcGNSZW5kZXJlci5vbihcImNvZGV4cHA6dHdlYWtzLWNoYW5nZWRcIiwgKCkgPT4ge1xuICAgIGlmIChyZWxvYWRpbmcpIHJldHVybjtcbiAgICByZWxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5pbmZvKFwiW2NvZGV4LXBsdXNwbHVzXSBob3QtcmVsb2FkaW5nIHR3ZWFrc1wiKTtcbiAgICAgICAgdGVhcmRvd25Ud2Vha0hvc3QoKTtcbiAgICAgICAgYXdhaXQgc3RhcnRUd2Vha0hvc3QoKTtcbiAgICAgICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbY29kZXgtcGx1c3BsdXNdIGhvdCByZWxvYWQgZmFpbGVkOlwiLCBlKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHJlbG9hZGluZyA9IG51bGw7XG4gICAgICB9XG4gICAgfSkoKTtcbiAgfSk7XG59XG4iLCAiLyoqXG4gKiBJbnN0YWxsIGEgbWluaW1hbCBfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18uIFJlYWN0IGNhbGxzXG4gKiBgaG9vay5pbmplY3QocmVuZGVyZXJJbnRlcm5hbHMpYCBkdXJpbmcgYGNyZWF0ZVJvb3RgL2BoeWRyYXRlUm9vdGAuIFRoZVxuICogXCJpbnRlcm5hbHNcIiBvYmplY3QgZXhwb3NlcyBmaW5kRmliZXJCeUhvc3RJbnN0YW5jZSwgd2hpY2ggbGV0cyB1cyB0dXJuIGFcbiAqIERPTSBub2RlIGludG8gYSBSZWFjdCBmaWJlciBcdTIwMTQgbmVjZXNzYXJ5IGZvciBvdXIgU2V0dGluZ3MgaW5qZWN0b3IuXG4gKlxuICogV2UgZG9uJ3Qgd2FudCB0byBicmVhayByZWFsIFJlYWN0IERldlRvb2xzIGlmIHRoZSB1c2VyIG9wZW5zIGl0OyB3ZSBpbnN0YWxsXG4gKiBvbmx5IGlmIG5vIGhvb2sgZXhpc3RzIHlldCwgYW5kIHdlIGZvcndhcmQgY2FsbHMgdG8gYSBkb3duc3RyZWFtIGhvb2sgaWZcbiAqIG9uZSBpcyBsYXRlciBhc3NpZ25lZC5cbiAqL1xuZGVjbGFyZSBnbG9iYWwge1xuICBpbnRlcmZhY2UgV2luZG93IHtcbiAgICBfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18/OiBSZWFjdERldnRvb2xzSG9vaztcbiAgICBfX2NvZGV4cHBfXz86IHtcbiAgICAgIGhvb2s6IFJlYWN0RGV2dG9vbHNIb29rO1xuICAgICAgcmVuZGVyZXJzOiBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz47XG4gICAgfTtcbiAgfVxufVxuXG5pbnRlcmZhY2UgUmVuZGVyZXJJbnRlcm5hbHMge1xuICBmaW5kRmliZXJCeUhvc3RJbnN0YW5jZT86IChuOiBOb2RlKSA9PiB1bmtub3duO1xuICB2ZXJzaW9uPzogc3RyaW5nO1xuICBidW5kbGVUeXBlPzogbnVtYmVyO1xuICByZW5kZXJlclBhY2thZ2VOYW1lPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgUmVhY3REZXZ0b29sc0hvb2sge1xuICBzdXBwb3J0c0ZpYmVyOiB0cnVlO1xuICByZW5kZXJlcnM6IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPjtcbiAgb24oZXZlbnQ6IHN0cmluZywgZm46ICguLi5hOiB1bmtub3duW10pID0+IHZvaWQpOiB2b2lkO1xuICBvZmYoZXZlbnQ6IHN0cmluZywgZm46ICguLi5hOiB1bmtub3duW10pID0+IHZvaWQpOiB2b2lkO1xuICBlbWl0KGV2ZW50OiBzdHJpbmcsIC4uLmE6IHVua25vd25bXSk6IHZvaWQ7XG4gIGluamVjdChyZW5kZXJlcjogUmVuZGVyZXJJbnRlcm5hbHMpOiBudW1iZXI7XG4gIG9uU2NoZWR1bGVGaWJlclJvb3Q/KCk6IHZvaWQ7XG4gIG9uQ29tbWl0RmliZXJSb290PygpOiB2b2lkO1xuICBvbkNvbW1pdEZpYmVyVW5tb3VudD8oKTogdm9pZDtcbiAgY2hlY2tEQ0U/KCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbnN0YWxsUmVhY3RIb29rKCk6IHZvaWQge1xuICBpZiAod2luZG93Ll9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXykgcmV0dXJuO1xuICBjb25zdCByZW5kZXJlcnMgPSBuZXcgTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+KCk7XG4gIGxldCBuZXh0SWQgPSAxO1xuICBjb25zdCBsaXN0ZW5lcnMgPSBuZXcgTWFwPHN0cmluZywgU2V0PCguLi5hOiB1bmtub3duW10pID0+IHZvaWQ+PigpO1xuXG4gIGNvbnN0IGhvb2s6IFJlYWN0RGV2dG9vbHNIb29rID0ge1xuICAgIHN1cHBvcnRzRmliZXI6IHRydWUsXG4gICAgcmVuZGVyZXJzLFxuICAgIGluamVjdChyZW5kZXJlcikge1xuICAgICAgY29uc3QgaWQgPSBuZXh0SWQrKztcbiAgICAgIHJlbmRlcmVycy5zZXQoaWQsIHJlbmRlcmVyKTtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICBjb25zb2xlLmRlYnVnKFxuICAgICAgICBcIltjb2RleC1wbHVzcGx1c10gUmVhY3QgcmVuZGVyZXIgYXR0YWNoZWQ6XCIsXG4gICAgICAgIHJlbmRlcmVyLnJlbmRlcmVyUGFja2FnZU5hbWUsXG4gICAgICAgIHJlbmRlcmVyLnZlcnNpb24sXG4gICAgICApO1xuICAgICAgcmV0dXJuIGlkO1xuICAgIH0sXG4gICAgb24oZXZlbnQsIGZuKSB7XG4gICAgICBsZXQgcyA9IGxpc3RlbmVycy5nZXQoZXZlbnQpO1xuICAgICAgaWYgKCFzKSBsaXN0ZW5lcnMuc2V0KGV2ZW50LCAocyA9IG5ldyBTZXQoKSkpO1xuICAgICAgcy5hZGQoZm4pO1xuICAgIH0sXG4gICAgb2ZmKGV2ZW50LCBmbikge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmRlbGV0ZShmbik7XG4gICAgfSxcbiAgICBlbWl0KGV2ZW50LCAuLi5hcmdzKSB7XG4gICAgICBsaXN0ZW5lcnMuZ2V0KGV2ZW50KT8uZm9yRWFjaCgoZm4pID0+IGZuKC4uLmFyZ3MpKTtcbiAgICB9LFxuICAgIG9uQ29tbWl0RmliZXJSb290KCkge30sXG4gICAgb25Db21taXRGaWJlclVubW91bnQoKSB7fSxcbiAgICBvblNjaGVkdWxlRmliZXJSb290KCkge30sXG4gICAgY2hlY2tEQ0UoKSB7fSxcbiAgfTtcblxuICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCBcIl9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfX1wiLCB7XG4gICAgY29uZmlndXJhYmxlOiB0cnVlLFxuICAgIGVudW1lcmFibGU6IGZhbHNlLFxuICAgIHdyaXRhYmxlOiB0cnVlLCAvLyBhbGxvdyByZWFsIERldlRvb2xzIHRvIG92ZXJ3cml0ZSBpZiB1c2VyIGluc3RhbGxzIGl0XG4gICAgdmFsdWU6IGhvb2ssXG4gIH0pO1xuXG4gIHdpbmRvdy5fX2NvZGV4cHBfXyA9IHsgaG9vaywgcmVuZGVyZXJzIH07XG59XG5cbi8qKiBSZXNvbHZlIHRoZSBSZWFjdCBmaWJlciBmb3IgYSBET00gbm9kZSwgaWYgYW55IHJlbmRlcmVyIGhhcyBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gZmliZXJGb3JOb2RlKG5vZGU6IE5vZGUpOiB1bmtub3duIHwgbnVsbCB7XG4gIGNvbnN0IHJlbmRlcmVycyA9IHdpbmRvdy5fX2NvZGV4cHBfXz8ucmVuZGVyZXJzO1xuICBpZiAocmVuZGVyZXJzKSB7XG4gICAgZm9yIChjb25zdCByIG9mIHJlbmRlcmVycy52YWx1ZXMoKSkge1xuICAgICAgY29uc3QgZiA9IHIuZmluZEZpYmVyQnlIb3N0SW5zdGFuY2U/Lihub2RlKTtcbiAgICAgIGlmIChmKSByZXR1cm4gZjtcbiAgICB9XG4gIH1cbiAgLy8gRmFsbGJhY2s6IHJlYWQgdGhlIFJlYWN0IGludGVybmFsIHByb3BlcnR5IGRpcmVjdGx5IGZyb20gdGhlIERPTSBub2RlLlxuICAvLyBSZWFjdCBzdG9yZXMgZmliZXJzIGFzIGEgcHJvcGVydHkgd2hvc2Uga2V5IHN0YXJ0cyB3aXRoIFwiX19yZWFjdEZpYmVyXCIuXG4gIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhub2RlKSkge1xuICAgIGlmIChrLnN0YXJ0c1dpdGgoXCJfX3JlYWN0RmliZXJcIikpIHJldHVybiAobm9kZSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrXTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cbiIsICIvKipcbiAqIFNldHRpbmdzIGluamVjdG9yIGZvciBDb2RleCdzIFNldHRpbmdzIHBhZ2UuXG4gKlxuICogQ29kZXgncyBzZXR0aW5ncyBpcyBhIHJvdXRlZCBwYWdlIChVUkwgc3RheXMgYXQgYC9pbmRleC5odG1sP2hvc3RJZD1sb2NhbGApXG4gKiBOT1QgYSBtb2RhbCBkaWFsb2cuIFRoZSBzaWRlYmFyIGxpdmVzIGluc2lkZSBhIGA8ZGl2IGNsYXNzPVwiZmxleCBmbGV4LWNvbFxuICogZ2FwLTEgZ2FwLTBcIj5gIHdyYXBwZXIgdGhhdCBob2xkcyBvbmUgb3IgbW9yZSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC1weFwiPmAgZ3JvdXBzIG9mIGJ1dHRvbnMuIFRoZXJlIGFyZSBubyBzdGFibGUgYHJvbGVgIC8gYGFyaWEtbGFiZWxgIC9cbiAqIGBkYXRhLXRlc3RpZGAgaG9va3Mgb24gdGhlIHNoZWxsIHNvIHdlIGlkZW50aWZ5IHRoZSBzaWRlYmFyIGJ5IHRleHQtY29udGVudFxuICogbWF0Y2ggYWdhaW5zdCBrbm93biBpdGVtIGxhYmVscyAoR2VuZXJhbCwgQXBwZWFyYW5jZSwgQ29uZmlndXJhdGlvbiwgXHUyMDI2KS5cbiAqXG4gKiBMYXlvdXQgd2UgaW5qZWN0OlxuICpcbiAqICAgR0VORVJBTCAgICAgICAgICAgICAgICAgICAgICAgKHVwcGVyY2FzZSBncm91cCBsYWJlbClcbiAqICAgW0NvZGV4J3MgZXhpc3RpbmcgaXRlbXMgZ3JvdXBdXG4gKiAgIENPREVYKysgICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFx1MjREOCBDb25maWdcbiAqICAgXHUyNjMwIFR3ZWFrc1xuICpcbiAqIENsaWNraW5nIENvbmZpZyAvIFR3ZWFrcyBoaWRlcyBDb2RleCdzIGNvbnRlbnQgcGFuZWwgY2hpbGRyZW4gYW5kIHJlbmRlcnNcbiAqIG91ciBvd24gYG1haW4tc3VyZmFjZWAgcGFuZWwgaW4gdGhlaXIgcGxhY2UuIENsaWNraW5nIGFueSBvZiBDb2RleCdzXG4gKiBzaWRlYmFyIGl0ZW1zIHJlc3RvcmVzIHRoZSBvcmlnaW5hbCB2aWV3LlxuICovXG5cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgdHlwZSB7XG4gIFNldHRpbmdzU2VjdGlvbixcbiAgU2V0dGluZ3NQYWdlLFxuICBTZXR0aW5nc0hhbmRsZSxcbiAgVHdlYWtNYW5pZmVzdCxcbn0gZnJvbSBcIkBjb2RleC1wbHVzcGx1cy9zZGtcIjtcblxuLy8gTWlycm9ycyB0aGUgcnVudGltZSdzIG1haW4tc2lkZSBMaXN0ZWRUd2VhayBzaGFwZSAoa2VwdCBpbiBzeW5jIG1hbnVhbGx5KS5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHVwZGF0ZTogVHdlYWtVcGRhdGVDaGVjayB8IG51bGw7XG59XG5cbmludGVyZmFjZSBUd2Vha1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIHJlcG86IHN0cmluZztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQ29kZXhQbHVzUGx1c0NvbmZpZyB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgYXV0b1VwZGF0ZTogYm9vbGVhbjtcbiAgdXBkYXRlQ2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayB8IG51bGw7XG59XG5cbmludGVyZmFjZSBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZU5vdGVzOiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgV2F0Y2hlckhlYWx0aCB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHdhdGNoZXI6IHN0cmluZztcbiAgY2hlY2tzOiBXYXRjaGVySGVhbHRoQ2hlY2tbXTtcbn1cblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGhDaGVjayB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbi8qKlxuICogQSB0d2Vhay1yZWdpc3RlcmVkIHBhZ2UuIFdlIGNhcnJ5IHRoZSBvd25pbmcgdHdlYWsncyBtYW5pZmVzdCBzbyB3ZSBjYW5cbiAqIHJlc29sdmUgcmVsYXRpdmUgaWNvblVybHMgYW5kIHNob3cgYXV0aG9yc2hpcCBpbiB0aGUgcGFnZSBoZWFkZXIuXG4gKi9cbmludGVyZmFjZSBSZWdpc3RlcmVkUGFnZSB7XG4gIC8qKiBGdWxseS1xdWFsaWZpZWQgaWQ6IGA8dHdlYWtJZD46PHBhZ2VJZD5gLiAqL1xuICBpZDogc3RyaW5nO1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBwYWdlOiBTZXR0aW5nc1BhZ2U7XG4gIC8qKiBQZXItcGFnZSBET00gdGVhcmRvd24gcmV0dXJuZWQgYnkgYHBhZ2UucmVuZGVyYCwgaWYgYW55LiAqL1xuICB0ZWFyZG93bj86ICgoKSA9PiB2b2lkKSB8IG51bGw7XG4gIC8qKiBUaGUgaW5qZWN0ZWQgc2lkZWJhciBidXR0b24gKHNvIHdlIGNhbiB1cGRhdGUgaXRzIGFjdGl2ZSBzdGF0ZSkuICovXG4gIG5hdkJ1dHRvbj86IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbn1cblxuLyoqIFdoYXQgcGFnZSBpcyBjdXJyZW50bHkgc2VsZWN0ZWQgaW4gb3VyIGluamVjdGVkIG5hdi4gKi9cbnR5cGUgQWN0aXZlUGFnZSA9XG4gIHwgeyBraW5kOiBcImNvbmZpZ1wiIH1cbiAgfCB7IGtpbmQ6IFwidHdlYWtzXCIgfVxuICB8IHsga2luZDogXCJyZWdpc3RlcmVkXCI7IGlkOiBzdHJpbmcgfTtcblxuaW50ZXJmYWNlIEluamVjdG9yU3RhdGUge1xuICBzZWN0aW9uczogTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uPjtcbiAgcGFnZXM6IE1hcDxzdHJpbmcsIFJlZ2lzdGVyZWRQYWdlPjtcbiAgbGlzdGVkVHdlYWtzOiBMaXN0ZWRUd2Vha1tdO1xuICAvKiogT3V0ZXIgd3JhcHBlciB0aGF0IGhvbGRzIENvZGV4J3MgaXRlbXMgZ3JvdXAgKyBvdXIgaW5qZWN0ZWQgZ3JvdXBzLiAqL1xuICBvdXRlcldyYXBwZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIkdlbmVyYWxcIiBsYWJlbCBmb3IgQ29kZXgncyBuYXRpdmUgc2V0dGluZ3MgZ3JvdXAuICovXG4gIG5hdGl2ZU5hdkhlYWRlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiQ29kZXgrK1wiIG5hdiBncm91cCAoQ29uZmlnL1R3ZWFrcykuICovXG4gIG5hdkdyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG5hdkJ1dHRvbnM6IHsgY29uZmlnOiBIVE1MQnV0dG9uRWxlbWVudDsgdHdlYWtzOiBIVE1MQnV0dG9uRWxlbWVudCB9IHwgbnVsbDtcbiAgLyoqIE91ciBcIlR3ZWFrc1wiIG5hdiBncm91cCAocGVyLXR3ZWFrIHBhZ2VzKS4gQ3JlYXRlZCBsYXppbHkuICovXG4gIHBhZ2VzR3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcGFnZXNHcm91cEtleTogc3RyaW5nIHwgbnVsbDtcbiAgcGFuZWxIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbDtcbiAgZmluZ2VycHJpbnQ6IHN0cmluZyB8IG51bGw7XG4gIHNpZGViYXJEdW1wZWQ6IGJvb2xlYW47XG4gIGFjdGl2ZVBhZ2U6IEFjdGl2ZVBhZ2UgfCBudWxsO1xuICBzaWRlYmFyUm9vdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBzaWRlYmFyUmVzdG9yZUhhbmRsZXI6ICgoZTogRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogYm9vbGVhbjtcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG59XG5cbmNvbnN0IHN0YXRlOiBJbmplY3RvclN0YXRlID0ge1xuICBzZWN0aW9uczogbmV3IE1hcCgpLFxuICBwYWdlczogbmV3IE1hcCgpLFxuICBsaXN0ZWRUd2Vha3M6IFtdLFxuICBvdXRlcldyYXBwZXI6IG51bGwsXG4gIG5hdGl2ZU5hdkhlYWRlcjogbnVsbCxcbiAgbmF2R3JvdXA6IG51bGwsXG4gIG5hdkJ1dHRvbnM6IG51bGwsXG4gIHBhZ2VzR3JvdXA6IG51bGwsXG4gIHBhZ2VzR3JvdXBLZXk6IG51bGwsXG4gIHBhbmVsSG9zdDogbnVsbCxcbiAgb2JzZXJ2ZXI6IG51bGwsXG4gIGZpbmdlcnByaW50OiBudWxsLFxuICBzaWRlYmFyRHVtcGVkOiBmYWxzZSxcbiAgYWN0aXZlUGFnZTogbnVsbCxcbiAgc2lkZWJhclJvb3Q6IG51bGwsXG4gIHNpZGViYXJSZXN0b3JlSGFuZGxlcjogbnVsbCxcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogZmFsc2UsXG4gIHNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcjogbnVsbCxcbn07XG5cbmZ1bmN0aW9uIHBsb2cobXNnOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGBbc2V0dGluZ3MtaW5qZWN0b3JdICR7bXNnfSR7ZXh0cmEgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiBcIiBcIiArIHNhZmVTdHJpbmdpZnkoZXh0cmEpfWAsXG4gICk7XG59XG5mdW5jdGlvbiBzYWZlU3RyaW5naWZ5KHY6IHVua25vd24pOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IHYgOiBKU09OLnN0cmluZ2lmeSh2KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFN0cmluZyh2KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgcHVibGljIEFQSSBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0U2V0dGluZ3NJbmplY3RvcigpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm9ic2VydmVyKSByZXR1cm47XG5cbiAgY29uc3Qgb2JzID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIHRyeUluamVjdCgpO1xuICAgIG1heWJlRHVtcERvbSgpO1xuICB9KTtcbiAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgc3RhdGUub2JzZXJ2ZXIgPSBvYnM7XG5cbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCBvbk5hdik7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiaGFzaGNoYW5nZVwiLCBvbk5hdik7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkRvY3VtZW50Q2xpY2ssIHRydWUpO1xuICBmb3IgKGNvbnN0IG0gb2YgW1wicHVzaFN0YXRlXCIsIFwicmVwbGFjZVN0YXRlXCJdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgb3JpZyA9IGhpc3RvcnlbbV07XG4gICAgaGlzdG9yeVttXSA9IGZ1bmN0aW9uICh0aGlzOiBIaXN0b3J5LCAuLi5hcmdzOiBQYXJhbWV0ZXJzPHR5cGVvZiBvcmlnPikge1xuICAgICAgY29uc3QgciA9IG9yaWcuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoYGNvZGV4cHAtJHttfWApKTtcbiAgICAgIHJldHVybiByO1xuICAgIH0gYXMgdHlwZW9mIG9yaWc7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoYGNvZGV4cHAtJHttfWAsIG9uTmF2KTtcbiAgfVxuXG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbiAgbGV0IHRpY2tzID0gMDtcbiAgY29uc3QgaW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgdGlja3MrKztcbiAgICB0cnlJbmplY3QoKTtcbiAgICBtYXliZUR1bXBEb20oKTtcbiAgICBpZiAodGlja3MgPiA2MCkgY2xlYXJJbnRlcnZhbChpbnRlcnZhbCk7XG4gIH0sIDUwMCk7XG59XG5cbmZ1bmN0aW9uIG9uTmF2KCk6IHZvaWQge1xuICBzdGF0ZS5maW5nZXJwcmludCA9IG51bGw7XG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbn1cblxuZnVuY3Rpb24gb25Eb2N1bWVudENsaWNrKGU6IE1vdXNlRXZlbnQpOiB2b2lkIHtcbiAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50ID8gZS50YXJnZXQgOiBudWxsO1xuICBjb25zdCBjb250cm9sID0gdGFyZ2V0Py5jbG9zZXN0KFwiW3JvbGU9J2xpbmsnXSxidXR0b24sYVwiKTtcbiAgaWYgKCEoY29udHJvbCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSkgcmV0dXJuO1xuICBpZiAoY29tcGFjdFNldHRpbmdzVGV4dChjb250cm9sLnRleHRDb250ZW50IHx8IFwiXCIpICE9PSBcIkJhY2sgdG8gYXBwXCIpIHJldHVybjtcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJiYWNrLXRvLWFwcFwiKTtcbiAgfSwgMCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNlY3Rpb24oc2VjdGlvbjogU2V0dGluZ3NTZWN0aW9uKTogU2V0dGluZ3NIYW5kbGUge1xuICBzdGF0ZS5zZWN0aW9ucy5zZXQoc2VjdGlvbi5pZCwgc2VjdGlvbik7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICByZXR1cm4ge1xuICAgIHVucmVnaXN0ZXI6ICgpID0+IHtcbiAgICAgIHN0YXRlLnNlY3Rpb25zLmRlbGV0ZShzZWN0aW9uLmlkKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclNlY3Rpb25zKCk6IHZvaWQge1xuICBzdGF0ZS5zZWN0aW9ucy5jbGVhcigpO1xuICAvLyBEcm9wIHJlZ2lzdGVyZWQgcGFnZXMgdG9vIFx1MjAxNCB0aGV5J3JlIG93bmVkIGJ5IHR3ZWFrcyB0aGF0IGp1c3QgZ290XG4gIC8vIHRvcm4gZG93biBieSB0aGUgaG9zdC4gUnVuIGFueSB0ZWFyZG93bnMgYmVmb3JlIGZvcmdldHRpbmcgdGhlbS5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHAudGVhcmRvd24/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBsb2coXCJwYWdlIHRlYXJkb3duIGZhaWxlZFwiLCB7IGlkOiBwLmlkLCBlcnI6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cbiAgc3RhdGUucGFnZXMuY2xlYXIoKTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gSWYgd2Ugd2VyZSBvbiBhIHJlZ2lzdGVyZWQgcGFnZSB0aGF0IG5vIGxvbmdlciBleGlzdHMsIGZhbGwgYmFjayB0b1xuICAvLyByZXN0b3JpbmcgQ29kZXgncyB2aWV3LlxuICBpZiAoXG4gICAgc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiZcbiAgICAhc3RhdGUucGFnZXMuaGFzKHN0YXRlLmFjdGl2ZVBhZ2UuaWQpXG4gICkge1xuICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIGEgdHdlYWstb3duZWQgc2V0dGluZ3MgcGFnZS4gVGhlIHJ1bnRpbWUgaW5qZWN0cyBhIHNpZGViYXIgZW50cnlcbiAqIHVuZGVyIGEgXCJUV0VBS1NcIiBncm91cCBoZWFkZXIgKHdoaWNoIGFwcGVhcnMgb25seSB3aGVuIGF0IGxlYXN0IG9uZSBwYWdlXG4gKiBpcyByZWdpc3RlcmVkKSBhbmQgcm91dGVzIGNsaWNrcyB0byB0aGUgcGFnZSdzIGByZW5kZXIocm9vdClgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJQYWdlKFxuICB0d2Vha0lkOiBzdHJpbmcsXG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LFxuICBwYWdlOiBTZXR0aW5nc1BhZ2UsXG4pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIGNvbnN0IGlkID0gcGFnZS5pZDsgLy8gYWxyZWFkeSBuYW1lc3BhY2VkIGJ5IHR3ZWFrLWhvc3QgYXMgYCR7dHdlYWtJZH06JHtwYWdlLmlkfWBcbiAgY29uc3QgZW50cnk6IFJlZ2lzdGVyZWRQYWdlID0geyBpZCwgdHdlYWtJZCwgbWFuaWZlc3QsIHBhZ2UgfTtcbiAgc3RhdGUucGFnZXMuc2V0KGlkLCBlbnRyeSk7XG4gIHBsb2coXCJyZWdpc3RlclBhZ2VcIiwgeyBpZCwgdGl0bGU6IHBhZ2UudGl0bGUsIHR3ZWFrSWQgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIC8vIElmIHRoZSB1c2VyIHdhcyBhbHJlYWR5IG9uIHRoaXMgcGFnZSAoaG90IHJlbG9hZCksIHJlLW1vdW50IGl0cyBib2R5LlxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHtcbiAgICByZXJlbmRlcigpO1xuICB9XG4gIHJldHVybiB7XG4gICAgdW5yZWdpc3RlcjogKCkgPT4ge1xuICAgICAgY29uc3QgZSA9IHN0YXRlLnBhZ2VzLmdldChpZCk7XG4gICAgICBpZiAoIWUpIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGUudGVhcmRvd24/LigpO1xuICAgICAgfSBjYXRjaCB7fVxuICAgICAgc3RhdGUucGFnZXMuZGVsZXRlKGlkKTtcbiAgICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHtcbiAgICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgICAgfVxuICAgIH0sXG4gIH07XG59XG5cbi8qKiBDYWxsZWQgYnkgdGhlIHR3ZWFrIGhvc3QgYWZ0ZXIgZmV0Y2hpbmcgdGhlIHR3ZWFrIGxpc3QgZnJvbSBtYWluLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldExpc3RlZFR3ZWFrcyhsaXN0OiBMaXN0ZWRUd2Vha1tdKTogdm9pZCB7XG4gIHN0YXRlLmxpc3RlZFR3ZWFrcyA9IGxpc3Q7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgaW5qZWN0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0cnlJbmplY3QoKTogdm9pZCB7XG4gIGNvbnN0IGl0ZW1zR3JvdXAgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgaWYgKCFpdGVtc0dyb3VwKSB7XG4gICAgc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTtcbiAgICBwbG9nKFwic2lkZWJhciBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHtcbiAgICBjbGVhclRpbWVvdXQoc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKTtcbiAgICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBudWxsO1xuICB9XG4gIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUodHJ1ZSwgXCJzaWRlYmFyLWZvdW5kXCIpO1xuICAvLyBDb2RleCdzIGl0ZW1zIGdyb3VwIGxpdmVzIGluc2lkZSBhbiBvdXRlciB3cmFwcGVyIHRoYXQncyBhbHJlYWR5IHN0eWxlZFxuICAvLyB0byBob2xkIG11bHRpcGxlIGdyb3VwcyAoYGZsZXggZmxleC1jb2wgZ2FwLTEgZ2FwLTBgKS4gV2UgaW5qZWN0IG91clxuICAvLyBncm91cCBhcyBhIHNpYmxpbmcgc28gdGhlIG5hdHVyYWwgZ2FwLTEgYWN0cyBhcyBvdXIgdmlzdWFsIHNlcGFyYXRvci5cbiAgY29uc3Qgb3V0ZXIgPSBpdGVtc0dyb3VwLnBhcmVudEVsZW1lbnQgPz8gaXRlbXNHcm91cDtcbiAgc3RhdGUuc2lkZWJhclJvb3QgPSBvdXRlcjtcbiAgc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXAsIG91dGVyKTtcblxuICBpZiAoc3RhdGUubmF2R3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF2R3JvdXApKSB7XG4gICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAvLyBDb2RleCByZS1yZW5kZXJzIGl0cyBuYXRpdmUgc2lkZWJhciBidXR0b25zIG9uIGl0cyBvd24gc3RhdGUgY2hhbmdlcy5cbiAgICAvLyBJZiBvbmUgb2Ygb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgcmUtc3RyaXAgQ29kZXgncyBhY3RpdmUgc3R5bGluZyBzb1xuICAgIC8vIEdlbmVyYWwgZG9lc24ndCByZWFwcGVhciBhcyBzZWxlY3RlZC5cbiAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCkgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpZGViYXIgd2FzIGVpdGhlciBmcmVzaGx5IG1vdW50ZWQgKFNldHRpbmdzIGp1c3Qgb3BlbmVkKSBvciByZS1tb3VudGVkXG4gIC8vIChjbG9zZWQgYW5kIHJlLW9wZW5lZCwgb3IgbmF2aWdhdGVkIGF3YXkgYW5kIGJhY2spLiBJbiBhbGwgb2YgdGhvc2VcbiAgLy8gY2FzZXMgQ29kZXggcmVzZXRzIHRvIGl0cyBkZWZhdWx0IHBhZ2UgKEdlbmVyYWwpLCBidXQgb3VyIGluLW1lbW9yeVxuICAvLyBgYWN0aXZlUGFnZWAgbWF5IHN0aWxsIHJlZmVyZW5jZSB0aGUgbGFzdCB0d2Vhay9wYWdlIHRoZSB1c2VyIGhhZCBvcGVuXG4gIC8vIFx1MjAxNCB3aGljaCB3b3VsZCBjYXVzZSB0aGF0IG5hdiBidXR0b24gdG8gcmVuZGVyIHdpdGggdGhlIGFjdGl2ZSBzdHlsaW5nXG4gIC8vIGV2ZW4gdGhvdWdoIENvZGV4IGlzIHNob3dpbmcgR2VuZXJhbC4gQ2xlYXIgaXQgc28gYHN5bmNQYWdlc0dyb3VwYCAvXG4gIC8vIGBzZXROYXZBY3RpdmVgIHN0YXJ0IGZyb20gYSBuZXV0cmFsIHN0YXRlLiBUaGUgcGFuZWxIb3N0IHJlZmVyZW5jZSBpc1xuICAvLyBhbHNvIHN0YWxlIChpdHMgRE9NIHdhcyBkaXNjYXJkZWQgd2l0aCB0aGUgcHJldmlvdXMgY29udGVudCBhcmVhKS5cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwgfHwgc3RhdGUucGFuZWxIb3N0ICE9PSBudWxsKSB7XG4gICAgcGxvZyhcInNpZGViYXIgcmUtbW91bnQgZGV0ZWN0ZWQ7IGNsZWFyaW5nIHN0YWxlIGFjdGl2ZSBzdGF0ZVwiLCB7XG4gICAgICBwcmV2QWN0aXZlOiBzdGF0ZS5hY3RpdmVQYWdlLFxuICAgIH0pO1xuICAgIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICAgIHN0YXRlLnBhbmVsSG9zdCA9IG51bGw7XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgR3JvdXAgY29udGFpbmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGdyb3VwLmRhdGFzZXQuY29kZXhwcCA9IFwibmF2LWdyb3VwXCI7XG4gIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcblxuICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJDb2RleCsrXCIsIFwicHQtM1wiKSk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFR3byBzaWRlYmFyIGl0ZW1zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBjb25maWdCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJDb25maWdcIiwgY29uZmlnSWNvblN2ZygpKTtcbiAgY29uc3QgdHdlYWtzQnRuID0gbWFrZVNpZGViYXJJdGVtKFwiVHdlYWtzXCIsIHR3ZWFrc0ljb25TdmcoKSk7XG5cbiAgY29uZmlnQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwiY29uZmlnXCIgfSk7XG4gIH0pO1xuICB0d2Vha3NCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJ0d2Vha3NcIiB9KTtcbiAgfSk7XG5cbiAgZ3JvdXAuYXBwZW5kQ2hpbGQoY29uZmlnQnRuKTtcbiAgZ3JvdXAuYXBwZW5kQ2hpbGQodHdlYWtzQnRuKTtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQoZ3JvdXApO1xuXG4gIHN0YXRlLm5hdkdyb3VwID0gZ3JvdXA7XG4gIHN0YXRlLm5hdkJ1dHRvbnMgPSB7IGNvbmZpZzogY29uZmlnQnRuLCB0d2Vha3M6IHR3ZWFrc0J0biB9O1xuICBwbG9nKFwibmF2IGdyb3VwIGluamVjdGVkXCIsIHsgb3V0ZXJUYWc6IG91dGVyLnRhZ05hbWUgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG59XG5cbmZ1bmN0aW9uIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwOiBIVE1MRWxlbWVudCwgb3V0ZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF0aXZlTmF2SGVhZGVyKSkgcmV0dXJuO1xuICBpZiAob3V0ZXIgPT09IGl0ZW1zR3JvdXApIHJldHVybjtcblxuICBjb25zdCBoZWFkZXIgPSBzaWRlYmFyR3JvdXBIZWFkZXIoXCJHZW5lcmFsXCIpO1xuICBoZWFkZXIuZGF0YXNldC5jb2RleHBwID0gXCJuYXRpdmUtbmF2LWhlYWRlclwiO1xuICBvdXRlci5pbnNlcnRCZWZvcmUoaGVhZGVyLCBpdGVtc0dyb3VwKTtcbiAgc3RhdGUubmF0aXZlTmF2SGVhZGVyID0gaGVhZGVyO1xufVxuXG5mdW5jdGlvbiBzaWRlYmFyR3JvdXBIZWFkZXIodGV4dDogc3RyaW5nLCB0b3BQYWRkaW5nID0gXCJwdC0yXCIpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPVxuICAgIGBweC1yb3cteCAke3RvcFBhZGRpbmd9IHBiLTEgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdXBwZXJjYXNlIHRyYWNraW5nLXdpZGVyIHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZCBzZWxlY3Qtbm9uZWA7XG4gIGhlYWRlci50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk6IHZvaWQge1xuICBpZiAoIXN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgfHwgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKSByZXR1cm47XG4gIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gICAgaWYgKGZpbmRTaWRlYmFySXRlbXNHcm91cCgpKSByZXR1cm47XG4gICAgaWYgKGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpKSByZXR1cm47XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJzaWRlYmFyLW5vdC1mb3VuZFwiKTtcbiAgfSwgMTUwMCk7XG59XG5cbmZ1bmN0aW9uIGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpOiBib29sZWFuIHtcbiAgY29uc3QgdGV4dCA9IGNvbXBhY3RTZXR0aW5nc1RleHQoZG9jdW1lbnQuYm9keT8udGV4dENvbnRlbnQgfHwgXCJcIikudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIChcbiAgICB0ZXh0LmluY2x1ZGVzKFwiYmFjayB0byBhcHBcIikgJiZcbiAgICB0ZXh0LmluY2x1ZGVzKFwiZ2VuZXJhbFwiKSAmJlxuICAgIHRleHQuaW5jbHVkZXMoXCJhcHBlYXJhbmNlXCIpICYmXG4gICAgKHRleHQuaW5jbHVkZXMoXCJjb25maWd1cmF0aW9uXCIpIHx8IHRleHQuaW5jbHVkZXMoXCJkZWZhdWx0IHBlcm1pc3Npb25zXCIpKVxuICApO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0U2V0dGluZ3NUZXh0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh2aXNpYmxlOiBib29sZWFuLCByZWFzb246IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9PT0gdmlzaWJsZSkgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgdHJ5IHtcbiAgICAod2luZG93IGFzIFdpbmRvdyAmIHsgX19jb2RleHBwU2V0dGluZ3NTdXJmYWNlVmlzaWJsZT86IGJvb2xlYW4gfSkuX19jb2RleHBwU2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9IHZpc2libGU7XG4gICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQuY29kZXhwcFNldHRpbmdzU3VyZmFjZSA9IHZpc2libGUgPyBcInRydWVcIiA6IFwiZmFsc2VcIjtcbiAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChcbiAgICAgIG5ldyBDdXN0b21FdmVudChcImNvZGV4cHA6c2V0dGluZ3Mtc3VyZmFjZVwiLCB7XG4gICAgICAgIGRldGFpbDogeyB2aXNpYmxlLCByZWFzb24gfSxcbiAgICAgIH0pLFxuICAgICk7XG4gIH0gY2F0Y2gge31cbiAgcGxvZyhcInNldHRpbmdzIHN1cmZhY2VcIiwgeyB2aXNpYmxlLCByZWFzb24sIHVybDogbG9jYXRpb24uaHJlZiB9KTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgKG9yIHJlLXJlbmRlcikgdGhlIHNlY29uZCBzaWRlYmFyIGdyb3VwIG9mIHBlci10d2VhayBwYWdlcy4gVGhlXG4gKiBncm91cCBpcyBjcmVhdGVkIGxhemlseSBhbmQgcmVtb3ZlZCB3aGVuIHRoZSBsYXN0IHBhZ2UgdW5yZWdpc3RlcnMsIHNvXG4gKiB1c2VycyB3aXRoIG5vIHBhZ2UtcmVnaXN0ZXJpbmcgdHdlYWtzIG5ldmVyIHNlZSBhbiBlbXB0eSBcIlR3ZWFrc1wiIGhlYWRlci5cbiAqL1xuZnVuY3Rpb24gc3luY1BhZ2VzR3JvdXAoKTogdm9pZCB7XG4gIGNvbnN0IG91dGVyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghb3V0ZXIpIHJldHVybjtcbiAgY29uc3QgcGFnZXMgPSBbLi4uc3RhdGUucGFnZXMudmFsdWVzKCldO1xuXG4gIC8vIEJ1aWxkIGEgZGV0ZXJtaW5pc3RpYyBmaW5nZXJwcmludCBvZiB0aGUgZGVzaXJlZCBncm91cCBzdGF0ZS4gSWYgdGhlXG4gIC8vIGN1cnJlbnQgRE9NIGdyb3VwIGFscmVhZHkgbWF0Y2hlcywgdGhpcyBpcyBhIG5vLW9wIFx1MjAxNCBjcml0aWNhbCwgYmVjYXVzZVxuICAvLyBzeW5jUGFnZXNHcm91cCBpcyBjYWxsZWQgb24gZXZlcnkgTXV0YXRpb25PYnNlcnZlciB0aWNrIGFuZCBhbnkgRE9NXG4gIC8vIHdyaXRlIHdvdWxkIHJlLXRyaWdnZXIgdGhhdCBvYnNlcnZlciAoaW5maW5pdGUgbG9vcCwgYXBwIGZyZWV6ZSkuXG4gIGNvbnN0IGRlc2lyZWRLZXkgPSBwYWdlcy5sZW5ndGggPT09IDBcbiAgICA/IFwiRU1QVFlcIlxuICAgIDogcGFnZXMubWFwKChwKSA9PiBgJHtwLmlkfXwke3AucGFnZS50aXRsZX18JHtwLnBhZ2UuaWNvblN2ZyA/PyBcIlwifWApLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IGdyb3VwQXR0YWNoZWQgPSAhIXN0YXRlLnBhZ2VzR3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUucGFnZXNHcm91cCk7XG4gIGlmIChzdGF0ZS5wYWdlc0dyb3VwS2V5ID09PSBkZXNpcmVkS2V5ICYmIChwYWdlcy5sZW5ndGggPT09IDAgPyAhZ3JvdXBBdHRhY2hlZCA6IGdyb3VwQXR0YWNoZWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwKSB7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwLnJlbW92ZSgpO1xuICAgICAgc3RhdGUucGFnZXNHcm91cCA9IG51bGw7XG4gICAgfVxuICAgIGZvciAoY29uc3QgcCBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkgcC5uYXZCdXR0b24gPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBkZXNpcmVkS2V5O1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxldCBncm91cCA9IHN0YXRlLnBhZ2VzR3JvdXA7XG4gIGlmICghZ3JvdXAgfHwgIW91dGVyLmNvbnRhaW5zKGdyb3VwKSkge1xuICAgIGdyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBncm91cC5kYXRhc2V0LmNvZGV4cHAgPSBcInBhZ2VzLWdyb3VwXCI7XG4gICAgZ3JvdXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1weFwiO1xuICAgIGdyb3VwLmFwcGVuZENoaWxkKHNpZGViYXJHcm91cEhlYWRlcihcIlR3ZWFrc1wiLCBcInB0LTNcIikpO1xuICAgIG91dGVyLmFwcGVuZENoaWxkKGdyb3VwKTtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwID0gZ3JvdXA7XG4gIH0gZWxzZSB7XG4gICAgLy8gU3RyaXAgcHJpb3IgYnV0dG9ucyAoa2VlcCB0aGUgaGVhZGVyIGF0IGluZGV4IDApLlxuICAgIHdoaWxlIChncm91cC5jaGlsZHJlbi5sZW5ndGggPiAxKSBncm91cC5yZW1vdmVDaGlsZChncm91cC5sYXN0Q2hpbGQhKTtcbiAgfVxuXG4gIGZvciAoY29uc3QgcCBvZiBwYWdlcykge1xuICAgIGNvbnN0IGljb24gPSBwLnBhZ2UuaWNvblN2ZyA/PyBkZWZhdWx0UGFnZUljb25TdmcoKTtcbiAgICBjb25zdCBidG4gPSBtYWtlU2lkZWJhckl0ZW0ocC5wYWdlLnRpdGxlLCBpY29uKTtcbiAgICBidG4uZGF0YXNldC5jb2RleHBwID0gYG5hdi1wYWdlLSR7cC5pZH1gO1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IHAuaWQgfSk7XG4gICAgfSk7XG4gICAgcC5uYXZCdXR0b24gPSBidG47XG4gICAgZ3JvdXAuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgfVxuICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gZGVzaXJlZEtleTtcbiAgcGxvZyhcInBhZ2VzIGdyb3VwIHN5bmNlZFwiLCB7XG4gICAgY291bnQ6IHBhZ2VzLmxlbmd0aCxcbiAgICBpZHM6IHBhZ2VzLm1hcCgocCkgPT4gcC5pZCksXG4gIH0pO1xuICAvLyBSZWZsZWN0IGN1cnJlbnQgYWN0aXZlIHN0YXRlIGFjcm9zcyB0aGUgcmVidWlsdCBidXR0b25zLlxuICBzZXROYXZBY3RpdmUoc3RhdGUuYWN0aXZlUGFnZSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VTaWRlYmFySXRlbShsYWJlbDogc3RyaW5nLCBpY29uU3ZnOiBzdHJpbmcpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIC8vIENsYXNzIHN0cmluZyBjb3BpZWQgdmVyYmF0aW0gZnJvbSBDb2RleCdzIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCBldGMpLlxuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5kYXRhc2V0LmNvZGV4cHAgPSBgbmF2LSR7bGFiZWwudG9Mb3dlckNhc2UoKX1gO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiZm9jdXMtdmlzaWJsZTpvdXRsaW5lLXRva2VuLWJvcmRlciByZWxhdGl2ZSBweC1yb3cteCBweS1yb3cteSBjdXJzb3ItaW50ZXJhY3Rpb24gc2hyaW5rLTAgaXRlbXMtY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIHRleHQtbGVmdCB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZSBmb2N1cy12aXNpYmxlOm91dGxpbmUtMiBmb2N1cy12aXNpYmxlOm91dGxpbmUtb2Zmc2V0LTIgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNTAgZ2FwLTIgZmxleCB3LWZ1bGwgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvbnQtbm9ybWFsXCI7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBpbm5lci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciB0ZXh0LWJhc2UgZ2FwLTIgZmxleC0xIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICBpbm5lci5pbm5lckhUTUwgPSBgJHtpY29uU3ZnfTxzcGFuIGNsYXNzPVwidHJ1bmNhdGVcIj4ke2xhYmVsfTwvc3Bhbj5gO1xuICBidG4uYXBwZW5kQ2hpbGQoaW5uZXIpO1xuICByZXR1cm4gYnRuO1xufVxuXG4vKiogSW50ZXJuYWwga2V5IGZvciB0aGUgYnVpbHQtaW4gbmF2IGJ1dHRvbnMuICovXG50eXBlIEJ1aWx0aW5QYWdlID0gXCJjb25maWdcIiB8IFwidHdlYWtzXCI7XG5cbmZ1bmN0aW9uIHNldE5hdkFjdGl2ZShhY3RpdmU6IEFjdGl2ZVBhZ2UgfCBudWxsKTogdm9pZCB7XG4gIC8vIEJ1aWx0LWluIChDb25maWcvVHdlYWtzKSBidXR0b25zLlxuICBpZiAoc3RhdGUubmF2QnV0dG9ucykge1xuICAgIGNvbnN0IGJ1aWx0aW46IEJ1aWx0aW5QYWdlIHwgbnVsbCA9XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwiY29uZmlnXCIgPyBcImNvbmZpZ1wiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwidHdlYWtzXCIgOiBudWxsO1xuICAgIGZvciAoY29uc3QgW2tleSwgYnRuXSBvZiBPYmplY3QuZW50cmllcyhzdGF0ZS5uYXZCdXR0b25zKSBhcyBbQnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50XVtdKSB7XG4gICAgICBhcHBseU5hdkFjdGl2ZShidG4sIGtleSA9PT0gYnVpbHRpbik7XG4gICAgfVxuICB9XG4gIC8vIFBlci1wYWdlIHJlZ2lzdGVyZWQgYnV0dG9ucy5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgaWYgKCFwLm5hdkJ1dHRvbikgY29udGludWU7XG4gICAgY29uc3QgaXNBY3RpdmUgPSBhY3RpdmU/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIGFjdGl2ZS5pZCA9PT0gcC5pZDtcbiAgICBhcHBseU5hdkFjdGl2ZShwLm5hdkJ1dHRvbiwgaXNBY3RpdmUpO1xuICB9XG4gIC8vIENvZGV4J3Mgb3duIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCwgQXBwZWFyYW5jZSwgZXRjKS4gV2hlbiBvbmUgb2ZcbiAgLy8gb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgQ29kZXggc3RpbGwgaGFzIGFyaWEtY3VycmVudD1cInBhZ2VcIiBhbmQgdGhlXG4gIC8vIGFjdGl2ZS1iZyBjbGFzcyBvbiB3aGljaGV2ZXIgaXRlbSBpdCBjb25zaWRlcmVkIHRoZSByb3V0ZSBcdTIwMTQgdHlwaWNhbGx5XG4gIC8vIEdlbmVyYWwuIFRoYXQgbWFrZXMgYm90aCBidXR0b25zIGxvb2sgc2VsZWN0ZWQuIFN0cmlwIENvZGV4J3MgYWN0aXZlXG4gIC8vIHN0eWxpbmcgd2hpbGUgb25lIG9mIG91cnMgaXMgYWN0aXZlOyByZXN0b3JlIGl0IHdoZW4gbm9uZSBpcy5cbiAgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKGFjdGl2ZSAhPT0gbnVsbCk7XG59XG5cbi8qKlxuICogTXV0ZSBDb2RleCdzIG93biBhY3RpdmUtc3RhdGUgc3R5bGluZyBvbiBpdHMgc2lkZWJhciBidXR0b25zLiBXZSBkb24ndFxuICogdG91Y2ggQ29kZXgncyBSZWFjdCBzdGF0ZSBcdTIwMTQgd2hlbiB0aGUgdXNlciBjbGlja3MgYSBuYXRpdmUgaXRlbSwgQ29kZXhcbiAqIHJlLXJlbmRlcnMgdGhlIGJ1dHRvbnMgYW5kIHJlLWFwcGxpZXMgaXRzIG93biBjb3JyZWN0IHN0YXRlLCB0aGVuIG91clxuICogc2lkZWJhci1jbGljayBsaXN0ZW5lciBmaXJlcyBgcmVzdG9yZUNvZGV4Vmlld2AgKHdoaWNoIGNhbGxzIGJhY2sgaW50b1xuICogYHNldE5hdkFjdGl2ZShudWxsKWAgYW5kIGxldHMgQ29kZXgncyBzdHlsaW5nIHN0YW5kKS5cbiAqXG4gKiBgbXV0ZT10cnVlYCAgXHUyMTkyIHN0cmlwIGFyaWEtY3VycmVudCBhbmQgc3dhcCBhY3RpdmUgYmcgXHUyMTkyIGhvdmVyIGJnXG4gKiBgbXV0ZT1mYWxzZWAgXHUyMTkyIG5vLW9wIChDb2RleCdzIG93biByZS1yZW5kZXIgYWxyZWFkeSByZXN0b3JlZCB0aGluZ3MpXG4gKi9cbmZ1bmN0aW9uIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShtdXRlOiBib29sZWFuKTogdm9pZCB7XG4gIGlmICghbXV0ZSkgcmV0dXJuO1xuICBjb25zdCByb290ID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghcm9vdCkgcmV0dXJuO1xuICBjb25zdCBidXR0b25zID0gQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpKTtcbiAgZm9yIChjb25zdCBidG4gb2YgYnV0dG9ucykge1xuICAgIC8vIFNraXAgb3VyIG93biBidXR0b25zLlxuICAgIGlmIChidG4uZGF0YXNldC5jb2RleHBwKSBjb250aW51ZTtcbiAgICBpZiAoYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIpIHtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgfVxuICAgIGlmIChidG4uY2xhc3NMaXN0LmNvbnRhaW5zKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseU5hdkFjdGl2ZShidG46IEhUTUxCdXR0b25FbGVtZW50LCBhY3RpdmU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgaW5uZXIgPSBidG4uZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoYWN0aXZlKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiLCBcImZvbnQtbm9ybWFsXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIsIFwicGFnZVwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBhY3RpdmF0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBhY3RpdmF0ZVBhZ2UocGFnZTogQWN0aXZlUGFnZSk6IHZvaWQge1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkge1xuICAgIHBsb2coXCJhY3RpdmF0ZTogY29udGVudCBhcmVhIG5vdCBmb3VuZFwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IHBhZ2U7XG4gIHBsb2coXCJhY3RpdmF0ZVwiLCB7IHBhZ2UgfSk7XG5cbiAgLy8gSGlkZSBDb2RleCdzIGNvbnRlbnQgY2hpbGRyZW4sIHNob3cgb3Vycy5cbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwID09PSBcInR3ZWFrcy1wYW5lbFwiKSBjb250aW51ZTtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbiA9IGNoaWxkLnN0eWxlLmRpc3BsYXkgfHwgXCJcIjtcbiAgICB9XG4gICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICB9XG4gIGxldCBwYW5lbCA9IGNvbnRlbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLWNvZGV4cHA9XCJ0d2Vha3MtcGFuZWxcIl0nKTtcbiAgaWYgKCFwYW5lbCkge1xuICAgIHBhbmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBwYW5lbC5kYXRhc2V0LmNvZGV4cHAgPSBcInR3ZWFrcy1wYW5lbFwiO1xuICAgIHBhbmVsLnN0eWxlLmNzc1RleHQgPSBcIndpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3ZlcmZsb3c6YXV0bztcIjtcbiAgICBjb250ZW50LmFwcGVuZENoaWxkKHBhbmVsKTtcbiAgfVxuICBwYW5lbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICBzdGF0ZS5wYW5lbEhvc3QgPSBwYW5lbDtcbiAgcmVyZW5kZXIoKTtcbiAgc2V0TmF2QWN0aXZlKHBhZ2UpO1xuICAvLyByZXN0b3JlIENvZGV4J3Mgdmlldy4gUmUtcmVnaXN0ZXIgaWYgbmVlZGVkLlxuICBjb25zdCBzaWRlYmFyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmIChzaWRlYmFyKSB7XG4gICAgaWYgKHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgICAgc2lkZWJhci5yZW1vdmVFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLCB0cnVlKTtcbiAgICB9XG4gICAgY29uc3QgaGFuZGxlciA9IChlOiBFdmVudCkgPT4ge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICAgIGlmIChzdGF0ZS5uYXZHcm91cD8uY29udGFpbnModGFyZ2V0KSkgcmV0dXJuOyAvLyBvdXIgYnV0dG9uc1xuICAgICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIHBhZ2UgYnV0dG9uc1xuICAgICAgaWYgKHRhcmdldC5jbG9zZXN0KFwiW2RhdGEtY29kZXhwcC1zZXR0aW5ncy1zZWFyY2hdXCIpKSByZXR1cm47XG4gICAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gICAgfTtcbiAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIgPSBoYW5kbGVyO1xuICAgIHNpZGViYXIuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZXIsIHRydWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc3RvcmVDb2RleFZpZXcoKTogdm9pZCB7XG4gIHBsb2coXCJyZXN0b3JlIGNvZGV4IHZpZXdcIik7XG4gIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm47XG4gIGlmIChzdGF0ZS5wYW5lbEhvc3QpIHN0YXRlLnBhbmVsSG9zdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkID09PSBzdGF0ZS5wYW5lbEhvc3QpIGNvbnRpbnVlO1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbjtcbiAgICAgIGRlbGV0ZSBjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW47XG4gICAgfVxuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICBzZXROYXZBY3RpdmUobnVsbCk7XG4gIGlmIChzdGF0ZS5zaWRlYmFyUm9vdCAmJiBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdC5yZW1vdmVFdmVudExpc3RlbmVyKFxuICAgICAgXCJjbGlja1wiLFxuICAgICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciA9IG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVyZW5kZXIoKTogdm9pZCB7XG4gIGlmICghc3RhdGUuYWN0aXZlUGFnZSkgcmV0dXJuO1xuICBjb25zdCBob3N0ID0gc3RhdGUucGFuZWxIb3N0O1xuICBpZiAoIWhvc3QpIHJldHVybjtcbiAgaG9zdC5pbm5lckhUTUwgPSBcIlwiO1xuXG4gIGNvbnN0IGFwID0gc3RhdGUuYWN0aXZlUGFnZTtcbiAgaWYgKGFwLmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgY29uc3QgZW50cnkgPSBzdGF0ZS5wYWdlcy5nZXQoYXAuaWQpO1xuICAgIGlmICghZW50cnkpIHtcbiAgICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3Qgcm9vdCA9IHBhbmVsU2hlbGwoZW50cnkucGFnZS50aXRsZSwgZW50cnkucGFnZS5kZXNjcmlwdGlvbik7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChyb290Lm91dGVyKTtcbiAgICB0cnkge1xuICAgICAgLy8gVGVhciBkb3duIGFueSBwcmlvciByZW5kZXIgYmVmb3JlIHJlLXJlbmRlcmluZyAoaG90IHJlbG9hZCkuXG4gICAgICB0cnkgeyBlbnRyeS50ZWFyZG93bj8uKCk7IH0gY2F0Y2gge31cbiAgICAgIGVudHJ5LnRlYXJkb3duID0gbnVsbDtcbiAgICAgIGNvbnN0IHJldCA9IGVudHJ5LnBhZ2UucmVuZGVyKHJvb3Quc2VjdGlvbnNXcmFwKTtcbiAgICAgIGlmICh0eXBlb2YgcmV0ID09PSBcImZ1bmN0aW9uXCIpIGVudHJ5LnRlYXJkb3duID0gcmV0O1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IGVyciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBlcnIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWNoYXJ0cy1yZWQgdGV4dC1zbVwiO1xuICAgICAgZXJyLnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyBwYWdlOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICByb290LnNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChlcnIpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0aXRsZSA9IGFwLmtpbmQgPT09IFwidHdlYWtzXCIgPyBcIlR3ZWFrc1wiIDogXCJDb25maWdcIjtcbiAgY29uc3Qgc3VidGl0bGUgPSBhcC5raW5kID09PSBcInR3ZWFrc1wiXG4gICAgPyBcIk1hbmFnZSB5b3VyIGluc3RhbGxlZCBDb2RleCsrIHR3ZWFrcy5cIlxuICAgIDogXCJDaGVja2luZyBpbnN0YWxsZWQgQ29kZXgrKyB2ZXJzaW9uLlwiO1xuICBjb25zdCByb290ID0gcGFuZWxTaGVsbCh0aXRsZSwgc3VidGl0bGUpO1xuICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICBpZiAoYXAua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVuZGVyVHdlYWtzUGFnZShyb290LnNlY3Rpb25zV3JhcCk7XG4gIGVsc2UgcmVuZGVyQ29uZmlnUGFnZShyb290LnNlY3Rpb25zV3JhcCwgcm9vdC5zdWJ0aXRsZSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBwYWdlcyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gcmVuZGVyQ29uZmlnUGFnZShzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LCBzdWJ0aXRsZT86IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJDb2RleCsrIFVwZGF0ZXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY29uc3QgbG9hZGluZyA9IHJvd1NpbXBsZShcIkxvYWRpbmcgdXBkYXRlIHNldHRpbmdzXCIsIFwiQ2hlY2tpbmcgY3VycmVudCBDb2RleCsrIGNvbmZpZ3VyYXRpb24uXCIpO1xuICBjYXJkLmFwcGVuZENoaWxkKGxvYWRpbmcpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC1jb25maWdcIilcbiAgICAudGhlbigoY29uZmlnKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHtcbiAgICAgICAgc3VidGl0bGUudGV4dENvbnRlbnQgPSBgWW91IGhhdmUgQ29kZXgrKyAkeyhjb25maWcgYXMgQ29kZXhQbHVzUGx1c0NvbmZpZykudmVyc2lvbn0gaW5zdGFsbGVkLmA7XG4gICAgICB9XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlckNvZGV4UGx1c1BsdXNDb25maWcoY2FyZCwgY29uZmlnIGFzIENvZGV4UGx1c1BsdXNDb25maWcpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHN1YnRpdGxlLnRleHRDb250ZW50ID0gXCJDb3VsZCBub3QgbG9hZCBpbnN0YWxsZWQgQ29kZXgrKyB2ZXJzaW9uLlwiO1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCBsb2FkIHVwZGF0ZSBzZXR0aW5nc1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcblxuICBjb25zdCB3YXRjaGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdhdGNoZXIuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHdhdGNoZXIuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiQXV0by1SZXBhaXIgV2F0Y2hlclwiKSk7XG4gIGNvbnN0IHdhdGNoZXJDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgd2F0Y2hlckNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgd2F0Y2hlclwiLCBcIlZlcmlmeWluZyB0aGUgdXBkYXRlciByZXBhaXIgc2VydmljZS5cIikpO1xuICB3YXRjaGVyLmFwcGVuZENoaWxkKHdhdGNoZXJDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHdhdGNoZXIpO1xuICByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZCh3YXRjaGVyQ2FyZCk7XG5cbiAgY29uc3QgbWFpbnRlbmFuY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgbWFpbnRlbmFuY2UuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIk1haW50ZW5hbmNlXCIpKTtcbiAgY29uc3QgbWFpbnRlbmFuY2VDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgbWFpbnRlbmFuY2VDYXJkLmFwcGVuZENoaWxkKHVuaW5zdGFsbFJvdygpKTtcbiAgbWFpbnRlbmFuY2VDYXJkLmFwcGVuZENoaWxkKHJlcG9ydEJ1Z1JvdygpKTtcbiAgbWFpbnRlbmFuY2UuYXBwZW5kQ2hpbGQobWFpbnRlbmFuY2VDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkOiBIVE1MRWxlbWVudCwgY29uZmlnOiBDb2RleFBsdXNQbHVzQ29uZmlnKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoYXV0b1VwZGF0ZVJvdyhjb25maWcpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnLnVwZGF0ZUNoZWNrKSk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hlY2spIGNhcmQuYXBwZW5kQ2hpbGQocmVsZWFzZU5vdGVzUm93KGNvbmZpZy51cGRhdGVDaGVjaykpO1xufVxuXG5mdW5jdGlvbiBhdXRvVXBkYXRlUm93KGNvbmZpZzogQ29kZXhQbHVzUGx1c0NvbmZpZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJBdXRvbWF0aWNhbGx5IHJlZnJlc2ggQ29kZXgrK1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgSW5zdGFsbGVkIHZlcnNpb24gdiR7Y29uZmlnLnZlcnNpb259LiBUaGUgd2F0Y2hlciBjYW4gcmVmcmVzaCB0aGUgQ29kZXgrKyBydW50aW1lIGFmdGVyIHlvdSByZXJ1biB0aGUgR2l0SHViIGluc3RhbGxlci5gO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICByb3cuYXBwZW5kQ2hpbGQoXG4gICAgc3dpdGNoQ29udHJvbChjb25maWcuYXV0b1VwZGF0ZSwgYXN5bmMgKG5leHQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6c2V0LWF1dG8tdXBkYXRlXCIsIG5leHQpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXNSb3coY2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayB8IG51bGwpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGNoZWNrPy51cGRhdGVBdmFpbGFibGUgPyBcIkNvZGV4KysgdXBkYXRlIGF2YWlsYWJsZVwiIDogXCJDb2RleCsrIGlzIHVwIHRvIGRhdGVcIjtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gdXBkYXRlU3VtbWFyeShjaGVjayk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBpZiAoY2hlY2s/LnJlbGVhc2VVcmwpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlJlbGVhc2UgTm90ZXNcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCBjaGVjay5yZWxlYXNlVXJsKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgTm93XCIsICgpID0+IHtcbiAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCIwLjY1XCI7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJjb2RleHBwOmNoZWNrLWNvZGV4cHAtdXBkYXRlXCIsIHRydWUpXG4gICAgICAgIC50aGVuKChuZXh0KSA9PiB7XG4gICAgICAgICAgY29uc3QgY2FyZCA9IHJvdy5wYXJlbnRFbGVtZW50O1xuICAgICAgICAgIGlmICghY2FyZCkgcmV0dXJuO1xuICAgICAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnZXQtY29uZmlnXCIpLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgICAgICAgcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkLCB7XG4gICAgICAgICAgICAgIC4uLihjb25maWcgYXMgQ29kZXhQbHVzUGx1c0NvbmZpZyksXG4gICAgICAgICAgICAgIHVwZGF0ZUNoZWNrOiBuZXh0IGFzIENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJDb2RleCsrIHVwZGF0ZSBjaGVjayBmYWlsZWRcIiwgU3RyaW5nKGUpKSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCJcIjtcbiAgICAgICAgfSk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVsZWFzZU5vdGVzUm93KGNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTIgcC0zXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJMYXRlc3QgcmVsZWFzZSBub3Rlc1wiO1xuICByb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5jbGFzc05hbWUgPVxuICAgIFwibWF4LWgtNjAgb3ZlcmZsb3ctYXV0byByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJvZHkuYXBwZW5kQ2hpbGQocmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24oY2hlY2sucmVsZWFzZU5vdGVzPy50cmltKCkgfHwgY2hlY2suZXJyb3IgfHwgXCJObyByZWxlYXNlIG5vdGVzIGF2YWlsYWJsZS5cIikpO1xuICByb3cuYXBwZW5kQ2hpbGQoYm9keSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJlbGVhc2VOb3Rlc01hcmtkb3duKG1hcmtkb3duOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb290LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjb25zdCBsaW5lcyA9IG1hcmtkb3duLnJlcGxhY2UoL1xcclxcbj8vZywgXCJcXG5cIikuc3BsaXQoXCJcXG5cIik7XG4gIGxldCBwYXJhZ3JhcGg6IHN0cmluZ1tdID0gW107XG4gIGxldCBsaXN0OiBIVE1MT0xpc3RFbGVtZW50IHwgSFRNTFVMaXN0RWxlbWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgY29kZUxpbmVzOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IGZsdXNoUGFyYWdyYXBoID0gKCkgPT4ge1xuICAgIGlmIChwYXJhZ3JhcGgubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwXCIpO1xuICAgIHAuY2xhc3NOYW1lID0gXCJtLTAgbGVhZGluZy01XCI7XG4gICAgYXBwZW5kSW5saW5lTWFya2Rvd24ocCwgcGFyYWdyYXBoLmpvaW4oXCIgXCIpLnRyaW0oKSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwKTtcbiAgICBwYXJhZ3JhcGggPSBbXTtcbiAgfTtcbiAgY29uc3QgZmx1c2hMaXN0ID0gKCkgPT4ge1xuICAgIGlmICghbGlzdCkgcmV0dXJuO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQobGlzdCk7XG4gICAgbGlzdCA9IG51bGw7XG4gIH07XG4gIGNvbnN0IGZsdXNoQ29kZSA9ICgpID0+IHtcbiAgICBpZiAoIWNvZGVMaW5lcykgcmV0dXJuO1xuICAgIGNvbnN0IHByZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwcmVcIik7XG4gICAgcHJlLmNsYXNzTmFtZSA9XG4gICAgICBcIm0tMCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIGNvbnN0IGNvZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY29kZVwiKTtcbiAgICBjb2RlLnRleHRDb250ZW50ID0gY29kZUxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgcHJlLmFwcGVuZENoaWxkKGNvZGUpO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQocHJlKTtcbiAgICBjb2RlTGluZXMgPSBudWxsO1xuICB9O1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmIChsaW5lLnRyaW0oKS5zdGFydHNXaXRoKFwiYGBgXCIpKSB7XG4gICAgICBpZiAoY29kZUxpbmVzKSBmbHVzaENvZGUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgY29kZUxpbmVzID0gW107XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNvZGVMaW5lcykge1xuICAgICAgY29kZUxpbmVzLnB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG4gICAgaWYgKCF0cmltbWVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkaW5nID0gL14oI3sxLDN9KVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAoaGVhZGluZykge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoaGVhZGluZ1sxXS5sZW5ndGggPT09IDEgPyBcImgzXCIgOiBcImg0XCIpO1xuICAgICAgaC5jbGFzc05hbWUgPSBcIm0tMCB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihoLCBoZWFkaW5nWzJdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoaCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB1bm9yZGVyZWQgPSAvXlstKl1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgY29uc3Qgb3JkZXJlZCA9IC9eXFxkK1suKV1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHVub3JkZXJlZCB8fCBvcmRlcmVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgY29uc3Qgd2FudE9yZGVyZWQgPSBCb29sZWFuKG9yZGVyZWQpO1xuICAgICAgaWYgKCFsaXN0IHx8ICh3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiT0xcIikgfHwgKCF3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiVUxcIikpIHtcbiAgICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICAgIGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHdhbnRPcmRlcmVkID8gXCJvbFwiIDogXCJ1bFwiKTtcbiAgICAgICAgbGlzdC5jbGFzc05hbWUgPSB3YW50T3JkZXJlZFxuICAgICAgICAgID8gXCJtLTAgbGlzdC1kZWNpbWFsIHNwYWNlLXktMSBwbC01IGxlYWRpbmctNVwiXG4gICAgICAgICAgOiBcIm0tMCBsaXN0LWRpc2Mgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCI7XG4gICAgICB9XG4gICAgICBjb25zdCBsaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGxpLCAodW5vcmRlcmVkID8/IG9yZGVyZWQpPy5bMV0gPz8gXCJcIik7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGxpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHF1b3RlID0gL14+XFxzPyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChxdW90ZSkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgYmxvY2txdW90ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJibG9ja3F1b3RlXCIpO1xuICAgICAgYmxvY2txdW90ZS5jbGFzc05hbWUgPSBcIm0tMCBib3JkZXItbC0yIGJvcmRlci10b2tlbi1ib3JkZXIgcGwtMyBsZWFkaW5nLTVcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGJsb2NrcXVvdGUsIHF1b3RlWzFdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoYmxvY2txdW90ZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBwYXJhZ3JhcGgucHVzaCh0cmltbWVkKTtcbiAgfVxuXG4gIGZsdXNoUGFyYWdyYXBoKCk7XG4gIGZsdXNoTGlzdCgpO1xuICBmbHVzaENvZGUoKTtcbiAgcmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZElubGluZU1hcmtkb3duKHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBwYXR0ZXJuID0gLyhgKFteYF0rKWB8XFxbKFteXFxdXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCl8XFwqXFwqKFteKl0rKVxcKlxcKnxcXCooW14qXSspXFwqKS9nO1xuICBsZXQgbGFzdEluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZXh0Lm1hdGNoQWxsKHBhdHRlcm4pKSB7XG4gICAgaWYgKG1hdGNoLmluZGV4ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCwgbWF0Y2guaW5kZXgpKTtcbiAgICBpZiAobWF0Y2hbMl0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgICAgY29kZS5jbGFzc05hbWUgPVxuICAgICAgICBcInJvdW5kZWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBweC0xIHB5LTAuNSB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBjb2RlLnRleHRDb250ZW50ID0gbWF0Y2hbMl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFszXSAhPT0gdW5kZWZpbmVkICYmIG1hdGNoWzRdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICAgIGEuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSB1bmRlcmxpbmUgdW5kZXJsaW5lLW9mZnNldC0yXCI7XG4gICAgICBhLmhyZWYgPSBtYXRjaFs0XTtcbiAgICAgIGEudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICAgIGEucmVsID0gXCJub29wZW5lciBub3JlZmVycmVyXCI7XG4gICAgICBhLnRleHRDb250ZW50ID0gbWF0Y2hbM107XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoYSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs1XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBzdHJvbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3Ryb25nXCIpO1xuICAgICAgc3Ryb25nLmNsYXNzTmFtZSA9IFwiZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIHN0cm9uZy50ZXh0Q29udGVudCA9IG1hdGNoWzVdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKHN0cm9uZyk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs2XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJlbVwiKTtcbiAgICAgIGVtLnRleHRDb250ZW50ID0gbWF0Y2hbNl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoZW0pO1xuICAgIH1cbiAgICBsYXN0SW5kZXggPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgfVxuICBhcHBlbmRUZXh0KHBhcmVudCwgdGV4dC5zbGljZShsYXN0SW5kZXgpKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kVGV4dChwYXJlbnQ6IEhUTUxFbGVtZW50LCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHRleHQpIHBhcmVudC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnZXQtd2F0Y2hlci1oZWFsdGhcIilcbiAgICAudGhlbigoaGVhbHRoKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwgaGVhbHRoIGFzIFdhdGNoZXJIZWFsdGgpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGNoZWNrIHdhdGNoZXJcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZDogSFRNTEVsZW1lbnQsIGhlYWx0aDogV2F0Y2hlckhlYWx0aCk6IHZvaWQge1xuICBjYXJkLmFwcGVuZENoaWxkKHdhdGNoZXJTdW1tYXJ5Um93KGhlYWx0aCkpO1xuICBmb3IgKGNvbnN0IGNoZWNrIG9mIGhlYWx0aC5jaGVja3MpIHtcbiAgICBpZiAoY2hlY2suc3RhdHVzID09PSBcIm9rXCIpIGNvbnRpbnVlO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQod2F0Y2hlckNoZWNrUm93KGNoZWNrKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gd2F0Y2hlclN1bW1hcnlSb3coaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhdHVzQmFkZ2UoaGVhbHRoLnN0YXR1cywgaGVhbHRoLndhdGNoZXIpKTtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gaGVhbHRoLnRpdGxlO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgJHtoZWFsdGguc3VtbWFyeX0gQ2hlY2tlZCAke25ldyBEYXRlKGhlYWx0aC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCl9LmA7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgY29uc3QgYWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgYWN0aW9uLmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDaGVjayBOb3dcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY2FyZCA9IHJvdy5wYXJlbnRFbGVtZW50O1xuICAgICAgaWYgKCFjYXJkKSByZXR1cm47XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgd2F0Y2hlclwiLCBcIlZlcmlmeWluZyB0aGUgdXBkYXRlciByZXBhaXIgc2VydmljZS5cIikpO1xuICAgICAgcmVuZGVyV2F0Y2hlckhlYWx0aENhcmQoY2FyZCk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb24pO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiB3YXRjaGVyQ2hlY2tSb3coY2hlY2s6IFdhdGNoZXJIZWFsdGhDaGVjayk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gcm93U2ltcGxlKGNoZWNrLm5hbWUsIGNoZWNrLmRldGFpbCk7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGVmdCkgbGVmdC5wcmVwZW5kKHN0YXR1c0JhZGdlKGNoZWNrLnN0YXR1cykpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBzdGF0dXNCYWRnZShzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiLCBsYWJlbD86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29uc3QgdG9uZSA9XG4gICAgc3RhdHVzID09PSBcIm9rXCJcbiAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLWdyZWVuIHRleHQtdG9rZW4tY2hhcnRzLWdyZWVuXCJcbiAgICAgIDogc3RhdHVzID09PSBcIndhcm5cIlxuICAgICAgICA/IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy15ZWxsb3cgdGV4dC10b2tlbi1jaGFydHMteWVsbG93XCJcbiAgICAgICAgOiBcImJvcmRlci10b2tlbi1jaGFydHMtcmVkIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICBiYWRnZS5jbGFzc05hbWUgPSBgaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCBib3JkZXIgcHgtMiBweS0wLjUgdGV4dC14cyBmb250LW1lZGl1bSAke3RvbmV9YDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBsYWJlbCB8fCAoc3RhdHVzID09PSBcIm9rXCIgPyBcIk9LXCIgOiBzdGF0dXMgPT09IFwid2FyblwiID8gXCJSZXZpZXdcIiA6IFwiRXJyb3JcIik7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdXBkYXRlU3VtbWFyeShjaGVjazogQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmICghY2hlY2spIHJldHVybiBcIk5vIHVwZGF0ZSBjaGVjayBoYXMgcnVuIHlldC5cIjtcbiAgY29uc3QgbGF0ZXN0ID0gY2hlY2subGF0ZXN0VmVyc2lvbiA/IGBMYXRlc3QgdiR7Y2hlY2subGF0ZXN0VmVyc2lvbn0uIGAgOiBcIlwiO1xuICBjb25zdCBjaGVja2VkID0gYENoZWNrZWQgJHtuZXcgRGF0ZShjaGVjay5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCl9LmA7XG4gIGlmIChjaGVjay5lcnJvcikgcmV0dXJuIGAke2xhdGVzdH0ke2NoZWNrZWR9ICR7Y2hlY2suZXJyb3J9YDtcbiAgcmV0dXJuIGAke2xhdGVzdH0ke2NoZWNrZWR9YDtcbn1cblxuZnVuY3Rpb24gdW5pbnN0YWxsUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiVW5pbnN0YWxsIENvZGV4KytcIixcbiAgICBcIkNvcGllcyB0aGUgdW5pbnN0YWxsIGNvbW1hbmQuIFJ1biBpdCBmcm9tIGEgdGVybWluYWwgYWZ0ZXIgcXVpdHRpbmcgQ29kZXguXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDb3B5IENvbW1hbmRcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpjb3B5LXRleHRcIiwgXCJub2RlIH4vLmNvZGV4LXBsdXNwbHVzL3NvdXJjZS9wYWNrYWdlcy9pbnN0YWxsZXIvZGlzdC9jbGkuanMgdW5pbnN0YWxsXCIpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNvcHkgdW5pbnN0YWxsIGNvbW1hbmQgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZXBvcnRCdWdSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJSZXBvcnQgYSBidWdcIixcbiAgICBcIk9wZW4gYSBHaXRIdWIgaXNzdWUgd2l0aCBydW50aW1lLCBpbnN0YWxsZXIsIG9yIHR3ZWFrLW1hbmFnZXIgZGV0YWlscy5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIk9wZW4gSXNzdWVcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgdGl0bGUgPSBlbmNvZGVVUklDb21wb25lbnQoXCJbQnVnXTogXCIpO1xuICAgICAgY29uc3QgYm9keSA9IGVuY29kZVVSSUNvbXBvbmVudChcbiAgICAgICAgW1xuICAgICAgICAgIFwiIyMgV2hhdCBoYXBwZW5lZD9cIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgU3RlcHMgdG8gcmVwcm9kdWNlXCIsXG4gICAgICAgICAgXCIxLiBcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgRW52aXJvbm1lbnRcIixcbiAgICAgICAgICBcIi0gQ29kZXgrKyB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gQ29kZXggYXBwIHZlcnNpb246IFwiLFxuICAgICAgICAgIFwiLSBPUzogXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIExvZ3NcIixcbiAgICAgICAgICBcIkF0dGFjaCByZWxldmFudCBsaW5lcyBmcm9tIHRoZSBDb2RleCsrIGxvZyBkaXJlY3RvcnkuXCIsXG4gICAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgICk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIixcbiAgICAgICAgYGh0dHBzOi8vZ2l0aHViLmNvbS9iLW5uZXR0L2NvZGV4LXBsdXNwbHVzL2lzc3Vlcy9uZXc/dGl0bGU9JHt0aXRsZX0mYm9keT0ke2JvZHl9YCxcbiAgICAgICk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGFjdGlvblJvdyh0aXRsZVRleHQ6IHN0cmluZywgZGVzY3JpcHRpb246IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gdGl0bGVUZXh0O1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuZGF0YXNldC5jb2RleHBwUm93QWN0aW9ucyA9IFwidHJ1ZVwiO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZW5kZXJUd2Vha3NQYWdlKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgb3BlbkJ0biA9IG9wZW5JblBsYWNlQnV0dG9uKFwiT3BlbiBUd2Vha3MgRm9sZGVyXCIsICgpID0+IHtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6cmV2ZWFsXCIsIHR3ZWFrc1BhdGgoKSk7XG4gIH0pO1xuICBjb25zdCByZWxvYWRCdG4gPSBvcGVuSW5QbGFjZUJ1dHRvbihcIkZvcmNlIFJlbG9hZFwiLCAoKSA9PiB7XG4gICAgLy8gRnVsbCBwYWdlIHJlZnJlc2ggXHUyMDE0IHNhbWUgYXMgRGV2VG9vbHMgQ21kLVIgLyBvdXIgQ0RQIFBhZ2UucmVsb2FkLlxuICAgIC8vIE1haW4gcmUtZGlzY292ZXJzIHR3ZWFrcyBmaXJzdCBzbyB0aGUgbmV3IHJlbmRlcmVyIGNvbWVzIHVwIHdpdGggYVxuICAgIC8vIGZyZXNoIHR3ZWFrIHNldDsgdGhlbiBsb2NhdGlvbi5yZWxvYWQgcmVzdGFydHMgdGhlIHJlbmRlcmVyIHNvIHRoZVxuICAgIC8vIHByZWxvYWQgcmUtaW5pdGlhbGl6ZXMgYWdhaW5zdCBpdC5cbiAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAuaW52b2tlKFwiY29kZXhwcDpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJmb3JjZSByZWxvYWQgKG1haW4pIGZhaWxlZFwiLCBTdHJpbmcoZSkpKVxuICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICBsb2NhdGlvbi5yZWxvYWQoKTtcbiAgICAgIH0pO1xuICB9KTtcbiAgLy8gRHJvcCB0aGUgZGlhZ29uYWwtYXJyb3cgaWNvbiBmcm9tIHRoZSByZWxvYWQgYnV0dG9uIFx1MjAxNCBpdCBpbXBsaWVzIFwib3BlblxuICAvLyBvdXQgb2YgYXBwXCIgd2hpY2ggZG9lc24ndCBmaXQuIFJlcGxhY2UgaXRzIHRyYWlsaW5nIHN2ZyB3aXRoIGEgcmVmcmVzaC5cbiAgY29uc3QgcmVsb2FkU3ZnID0gcmVsb2FkQnRuLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIik7XG4gIGlmIChyZWxvYWRTdmcpIHtcbiAgICByZWxvYWRTdmcub3V0ZXJIVE1MID1cbiAgICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tMnhzXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgICBgPHBhdGggZD1cIk00IDEwYTYgNiAwIDAgMSAxMC4yNC00LjI0TDE2IDcuNU0xNiA0djMuNWgtMy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgICAgYDxwYXRoIGQ9XCJNMTYgMTBhNiA2IDAgMCAxLTEwLjI0IDQuMjRMNCAxMi41TTQgMTZ2LTMuNWgzLjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgICBgPC9zdmc+YDtcbiAgfVxuXG4gIGNvbnN0IHRyYWlsaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdHJhaWxpbmcuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICB0cmFpbGluZy5hcHBlbmRDaGlsZChyZWxvYWRCdG4pO1xuICB0cmFpbGluZy5hcHBlbmRDaGlsZChvcGVuQnRuKTtcblxuICBpZiAoc3RhdGUubGlzdGVkVHdlYWtzLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiSW5zdGFsbGVkIFR3ZWFrc1wiLCB0cmFpbGluZykpO1xuICAgIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoXG4gICAgICByb3dTaW1wbGUoXG4gICAgICAgIFwiTm8gdHdlYWtzIGluc3RhbGxlZFwiLFxuICAgICAgICBgRHJvcCBhIHR3ZWFrIGZvbGRlciBpbnRvICR7dHdlYWtzUGF0aCgpfSBhbmQgcmVsb2FkLmAsXG4gICAgICApLFxuICAgICk7XG4gICAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gR3JvdXAgcmVnaXN0ZXJlZCBTZXR0aW5nc1NlY3Rpb25zIGJ5IHR3ZWFrIGlkIChwcmVmaXggc3BsaXQgYXQgXCI6XCIpLlxuICBjb25zdCBzZWN0aW9uc0J5VHdlYWsgPSBuZXcgTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uW10+KCk7XG4gIGZvciAoY29uc3QgcyBvZiBzdGF0ZS5zZWN0aW9ucy52YWx1ZXMoKSkge1xuICAgIGNvbnN0IHR3ZWFrSWQgPSBzLmlkLnNwbGl0KFwiOlwiKVswXTtcbiAgICBpZiAoIXNlY3Rpb25zQnlUd2Vhay5oYXModHdlYWtJZCkpIHNlY3Rpb25zQnlUd2Vhay5zZXQodHdlYWtJZCwgW10pO1xuICAgIHNlY3Rpb25zQnlUd2Vhay5nZXQodHdlYWtJZCkhLnB1c2gocyk7XG4gIH1cblxuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHdyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiSW5zdGFsbGVkIFR3ZWFrc1wiLCB0cmFpbGluZykpO1xuXG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBmb3IgKGNvbnN0IHQgb2Ygc3RhdGUubGlzdGVkVHdlYWtzKSB7XG4gICAgY2FyZC5hcHBlbmRDaGlsZCh0d2Vha1Jvdyh0LCBzZWN0aW9uc0J5VHdlYWsuZ2V0KHQubWFuaWZlc3QuaWQpID8/IFtdKSk7XG4gIH1cbiAgd3JhcC5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHdyYXApO1xufVxuXG5mdW5jdGlvbiB0d2Vha1Jvdyh0OiBMaXN0ZWRUd2Vhaywgc2VjdGlvbnM6IFNldHRpbmdzU2VjdGlvbltdKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBtID0gdC5tYW5pZmVzdDtcblxuICAvLyBPdXRlciBjZWxsIHdyYXBzIHRoZSBoZWFkZXIgcm93ICsgKG9wdGlvbmFsKSBuZXN0ZWQgc2VjdGlvbnMgc28gdGhlXG4gIC8vIHBhcmVudCBjYXJkJ3MgZGl2aWRlciBzdGF5cyBiZXR3ZWVuICp0d2Vha3MqLCBub3QgYmV0d2VlbiBoZWFkZXIgYW5kXG4gIC8vIGJvZHkgb2YgdGhlIHNhbWUgdHdlYWsuXG4gIGNvbnN0IGNlbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjZWxsLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbFwiO1xuICBpZiAoIXQuZW5hYmxlZCkgY2VsbC5zdHlsZS5vcGFjaXR5ID0gXCIwLjdcIjtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcblxuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcblxuICAvLyBcdTI1MDBcdTI1MDAgQXZhdGFyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBhdmF0YXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhdmF0YXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgb3ZlcmZsb3ctaGlkZGVuIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgYXZhdGFyLnN0eWxlLndpZHRoID0gXCI1NnB4XCI7XG4gIGF2YXRhci5zdHlsZS5oZWlnaHQgPSBcIjU2cHhcIjtcbiAgYXZhdGFyLnN0eWxlLmJhY2tncm91bmRDb2xvciA9IFwidmFyKC0tY29sb3ItdG9rZW4tYmctZm9nLCB0cmFuc3BhcmVudClcIjtcbiAgaWYgKG0uaWNvblVybCkge1xuICAgIGNvbnN0IGltZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbWdcIik7XG4gICAgaW1nLmFsdCA9IFwiXCI7XG4gICAgaW1nLmNsYXNzTmFtZSA9IFwic2l6ZS1mdWxsIG9iamVjdC1jb250YWluXCI7XG4gICAgLy8gSW5pdGlhbDogc2hvdyBmYWxsYmFjayBpbml0aWFsIGluIGNhc2UgdGhlIGljb24gZmFpbHMgdG8gbG9hZC5cbiAgICBjb25zdCBpbml0aWFsID0gKG0ubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICAgIGNvbnN0IGZhbGxiYWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgZmFsbGJhY2suY2xhc3NOYW1lID0gXCJ0ZXh0LXhsIGZvbnQtbWVkaXVtXCI7XG4gICAgZmFsbGJhY2sudGV4dENvbnRlbnQgPSBpbml0aWFsO1xuICAgIGF2YXRhci5hcHBlbmRDaGlsZChmYWxsYmFjayk7XG4gICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICBpbWcuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgKCkgPT4ge1xuICAgICAgZmFsbGJhY2sucmVtb3ZlKCk7XG4gICAgICBpbWcuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgfSk7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICBpbWcucmVtb3ZlKCk7XG4gICAgfSk7XG4gICAgdm9pZCByZXNvbHZlSWNvblVybChtLmljb25VcmwsIHQuZGlyKS50aGVuKCh1cmwpID0+IHtcbiAgICAgIGlmICh1cmwpIGltZy5zcmMgPSB1cmw7XG4gICAgICBlbHNlIGltZy5yZW1vdmUoKTtcbiAgICB9KTtcbiAgICBhdmF0YXIuYXBwZW5kQ2hpbGQoaW1nKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBpbml0aWFsID0gKG0ubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICAgIGNvbnN0IHNwYW4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBzcGFuLmNsYXNzTmFtZSA9IFwidGV4dC14bCBmb250LW1lZGl1bVwiO1xuICAgIHNwYW4udGV4dENvbnRlbnQgPSBpbml0aWFsO1xuICAgIGF2YXRhci5hcHBlbmRDaGlsZChzcGFuKTtcbiAgfVxuICBsZWZ0LmFwcGVuZENoaWxkKGF2YXRhcik7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRleHQgc3RhY2sgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTAuNVwiO1xuXG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmFtZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBuYW1lLnRleHRDb250ZW50ID0gbS5uYW1lO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZChuYW1lKTtcbiAgaWYgKG0udmVyc2lvbikge1xuICAgIGNvbnN0IHZlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHZlci5jbGFzc05hbWUgPVxuICAgICAgXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQteHMgZm9udC1ub3JtYWwgdGFidWxhci1udW1zXCI7XG4gICAgdmVyLnRleHRDb250ZW50ID0gYHYke20udmVyc2lvbn1gO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHZlcik7XG4gIH1cbiAgaWYgKHQudXBkYXRlPy51cGRhdGVBdmFpbGFibGUpIHtcbiAgICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIGJhZGdlLmNsYXNzTmFtZSA9XG4gICAgICBcInJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wLjUgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICBiYWRnZS50ZXh0Q29udGVudCA9IFwiVXBkYXRlIEF2YWlsYWJsZVwiO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKGJhZGdlKTtcbiAgfVxuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZVJvdyk7XG5cbiAgaWYgKG0uZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgICBkZXNjLnRleHRDb250ZW50ID0gbS5kZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgfVxuXG4gIGNvbnN0IG1ldGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtZXRhLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGNvbnN0IGF1dGhvckVsID0gcmVuZGVyQXV0aG9yKG0uYXV0aG9yKTtcbiAgaWYgKGF1dGhvckVsKSBtZXRhLmFwcGVuZENoaWxkKGF1dGhvckVsKTtcbiAgaWYgKG0uZ2l0aHViUmVwbykge1xuICAgIGlmIChtZXRhLmNoaWxkcmVuLmxlbmd0aCA+IDApIG1ldGEuYXBwZW5kQ2hpbGQoZG90KCkpO1xuICAgIGNvbnN0IHJlcG8gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIHJlcG8udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgcmVwby5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gICAgcmVwby50ZXh0Q29udGVudCA9IG0uZ2l0aHViUmVwbztcbiAgICByZXBvLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsIGBodHRwczovL2dpdGh1Yi5jb20vJHttLmdpdGh1YlJlcG99YCk7XG4gICAgfSk7XG4gICAgbWV0YS5hcHBlbmRDaGlsZChyZXBvKTtcbiAgfVxuICBpZiAobS5ob21lcGFnZSkge1xuICAgIGlmIChtZXRhLmNoaWxkcmVuLmxlbmd0aCA+IDApIG1ldGEuYXBwZW5kQ2hpbGQoZG90KCkpO1xuICAgIGNvbnN0IGxpbmsgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICBsaW5rLmhyZWYgPSBtLmhvbWVwYWdlO1xuICAgIGxpbmsudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICBsaW5rLnJlbCA9IFwibm9yZWZlcnJlclwiO1xuICAgIGxpbmsuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCB0ZXh0LXRva2VuLXRleHQtbGluay1mb3JlZ3JvdW5kIGhvdmVyOnVuZGVybGluZVwiO1xuICAgIGxpbmsudGV4dENvbnRlbnQgPSBcIkhvbWVwYWdlXCI7XG4gICAgbWV0YS5hcHBlbmRDaGlsZChsaW5rKTtcbiAgfVxuICBpZiAobWV0YS5jaGlsZHJlbi5sZW5ndGggPiAwKSBzdGFjay5hcHBlbmRDaGlsZChtZXRhKTtcblxuICAvLyBUYWdzIHJvdyAoaWYgYW55KSBcdTIwMTQgc21hbGwgcGlsbCBjaGlwcyBiZWxvdyB0aGUgbWV0YSBsaW5lLlxuICBpZiAobS50YWdzICYmIG0udGFncy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgdGFnc1JvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgdGFnc1Jvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBnYXAtMSBwdC0wLjVcIjtcbiAgICBmb3IgKGNvbnN0IHRhZyBvZiBtLnRhZ3MpIHtcbiAgICAgIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIHBpbGwuY2xhc3NOYW1lID1cbiAgICAgICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQtWzExcHhdIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICAgIHBpbGwudGV4dENvbnRlbnQgPSB0YWc7XG4gICAgICB0YWdzUm93LmFwcGVuZENoaWxkKHBpbGwpO1xuICAgIH1cbiAgICBzdGFjay5hcHBlbmRDaGlsZCh0YWdzUm93KTtcbiAgfVxuXG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFRvZ2dsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByaWdodC5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yIHB0LTAuNVwiO1xuICBpZiAodC51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSAmJiB0LnVwZGF0ZS5yZWxlYXNlVXJsKSB7XG4gICAgcmlnaHQuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiUmV2aWV3IFJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCB0LnVwZGF0ZSEucmVsZWFzZVVybCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIHJpZ2h0LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2wodC5lbmFibGVkLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpzZXQtdHdlYWstZW5hYmxlZFwiLCBtLmlkLCBuZXh0KTtcbiAgICAgIC8vIFRoZSBtYWluIHByb2Nlc3MgYnJvYWRjYXN0cyBhIHJlbG9hZCB3aGljaCB3aWxsIHJlLWZldGNoIHRoZSBsaXN0XG4gICAgICAvLyBhbmQgcmUtcmVuZGVyLiBXZSBkb24ndCBvcHRpbWlzdGljYWxseSB0b2dnbGUgdG8gYXZvaWQgZHJpZnQuXG4gICAgfSksXG4gICk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChyaWdodCk7XG5cbiAgY2VsbC5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIC8vIElmIHRoZSB0d2VhayBpcyBlbmFibGVkIGFuZCByZWdpc3RlcmVkIHNldHRpbmdzIHNlY3Rpb25zLCByZW5kZXIgdGhvc2VcbiAgLy8gYm9kaWVzIGFzIG5lc3RlZCByb3dzIGJlbmVhdGggdGhlIGhlYWRlciBpbnNpZGUgdGhlIHNhbWUgY2VsbC5cbiAgaWYgKHQuZW5hYmxlZCAmJiBzZWN0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgbmVzdGVkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBuZXN0ZWQuY2xhc3NOYW1lID1cbiAgICAgIFwiZmxleCBmbGV4LWNvbCBkaXZpZGUteS1bMC41cHhdIGRpdmlkZS10b2tlbi1ib3JkZXIgYm9yZGVyLXQtWzAuNXB4XSBib3JkZXItdG9rZW4tYm9yZGVyXCI7XG4gICAgZm9yIChjb25zdCBzIG9mIHNlY3Rpb25zKSB7XG4gICAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJvZHkuY2xhc3NOYW1lID0gXCJwLTNcIjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHMucmVuZGVyKGJvZHkpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBib2R5LnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyB0d2VhayBzZWN0aW9uOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICB9XG4gICAgICBuZXN0ZWQuYXBwZW5kQ2hpbGQoYm9keSk7XG4gICAgfVxuICAgIGNlbGwuYXBwZW5kQ2hpbGQobmVzdGVkKTtcbiAgfVxuXG4gIHJldHVybiBjZWxsO1xufVxuXG5mdW5jdGlvbiByZW5kZXJBdXRob3IoYXV0aG9yOiBUd2Vha01hbmlmZXN0W1wiYXV0aG9yXCJdKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgaWYgKCFhdXRob3IpIHJldHVybiBudWxsO1xuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTFcIjtcbiAgaWYgKHR5cGVvZiBhdXRob3IgPT09IFwic3RyaW5nXCIpIHtcbiAgICB3cmFwLnRleHRDb250ZW50ID0gYGJ5ICR7YXV0aG9yfWA7XG4gICAgcmV0dXJuIHdyYXA7XG4gIH1cbiAgd3JhcC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZShcImJ5IFwiKSk7XG4gIGlmIChhdXRob3IudXJsKSB7XG4gICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICAgIGEuaHJlZiA9IGF1dGhvci51cmw7XG4gICAgYS50YXJnZXQgPSBcIl9ibGFua1wiO1xuICAgIGEucmVsID0gXCJub3JlZmVycmVyXCI7XG4gICAgYS5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gICAgYS50ZXh0Q29udGVudCA9IGF1dGhvci5uYW1lO1xuICAgIHdyYXAuYXBwZW5kQ2hpbGQoYSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3Qgc3BhbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHNwYW4udGV4dENvbnRlbnQgPSBhdXRob3IubmFtZTtcbiAgICB3cmFwLmFwcGVuZENoaWxkKHNwYW4pO1xuICB9XG4gIHJldHVybiB3cmFwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgY29tcG9uZW50cyBcdTI1MDBcdTI1MDBcblxuLyoqIFRoZSBmdWxsIHBhbmVsIHNoZWxsICh0b29sYmFyICsgc2Nyb2xsICsgaGVhZGluZyArIHNlY3Rpb25zIHdyYXApLiAqL1xuZnVuY3Rpb24gcGFuZWxTaGVsbChcbiAgdGl0bGU6IHN0cmluZyxcbiAgc3VidGl0bGU/OiBzdHJpbmcsXG4pOiB7IG91dGVyOiBIVE1MRWxlbWVudDsgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudDsgc3VidGl0bGU/OiBIVE1MRWxlbWVudCB9IHtcbiAgY29uc3Qgb3V0ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdXRlci5jbGFzc05hbWUgPSBcIm1haW4tc3VyZmFjZSBmbGV4IGgtZnVsbCBtaW4taC0wIGZsZXgtY29sXCI7XG5cbiAgY29uc3QgdG9vbGJhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvb2xiYXIuY2xhc3NOYW1lID1cbiAgICBcImRyYWdnYWJsZSBmbGV4IGl0ZW1zLWNlbnRlciBweC1wYW5lbCBlbGVjdHJvbjpoLXRvb2xiYXIgZXh0ZW5zaW9uOmgtdG9vbGJhci1zbVwiO1xuICBvdXRlci5hcHBlbmRDaGlsZCh0b29sYmFyKTtcblxuICBjb25zdCBzY3JvbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzY3JvbGwuY2xhc3NOYW1lID0gXCJmbGV4LTEgb3ZlcmZsb3cteS1hdXRvIHAtcGFuZWxcIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQoc2Nyb2xsKTtcblxuICBjb25zdCBpbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9XG4gICAgXCJteC1hdXRvIGZsZXggdy1mdWxsIGZsZXgtY29sIG1heC13LTJ4bCBlbGVjdHJvbjptaW4tdy1bY2FsYygzMjBweCp2YXIoLS1jb2RleC13aW5kb3ctem9vbSkpXVwiO1xuICBzY3JvbGwuYXBwZW5kQ2hpbGQoaW5uZXIpO1xuXG4gIGNvbnN0IGhlYWRlcldyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJXcmFwLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zIHBiLXBhbmVsXCI7XG4gIGNvbnN0IGhlYWRlcklubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVySW5uZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0xLjUgcGItcGFuZWxcIjtcbiAgY29uc3QgaGVhZGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRpbmcuY2xhc3NOYW1lID0gXCJlbGVjdHJvbjpoZWFkaW5nLWxnIGhlYWRpbmctYmFzZSB0cnVuY2F0ZVwiO1xuICBoZWFkaW5nLnRleHRDb250ZW50ID0gdGl0bGU7XG4gIGhlYWRlcklubmVyLmFwcGVuZENoaWxkKGhlYWRpbmcpO1xuICBsZXQgc3VidGl0bGVFbGVtZW50OiBIVE1MRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgaWYgKHN1YnRpdGxlKSB7XG4gICAgY29uc3Qgc3ViID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBzdWIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQtc21cIjtcbiAgICBzdWIudGV4dENvbnRlbnQgPSBzdWJ0aXRsZTtcbiAgICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZChzdWIpO1xuICAgIHN1YnRpdGxlRWxlbWVudCA9IHN1YjtcbiAgfVxuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlcklubmVyKTtcbiAgaW5uZXIuYXBwZW5kQ2hpbGQoaGVhZGVyV3JhcCk7XG5cbiAgY29uc3Qgc2VjdGlvbnNXcmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2VjdGlvbnNXcmFwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtW3ZhcigtLXBhZGRpbmctcGFuZWwpXVwiO1xuICBpbm5lci5hcHBlbmRDaGlsZChzZWN0aW9uc1dyYXApO1xuXG4gIHJldHVybiB7IG91dGVyLCBzZWN0aW9uc1dyYXAsIHN1YnRpdGxlOiBzdWJ0aXRsZUVsZW1lbnQgfTtcbn1cblxuZnVuY3Rpb24gc2VjdGlvblRpdGxlKHRleHQ6IHN0cmluZywgdHJhaWxpbmc/OiBIVE1MRWxlbWVudCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLXRvb2xiYXIgaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiBweC0wIHB5LTBcIjtcbiAgY29uc3QgdGl0bGVJbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlSW5uZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0LmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0aXRsZUlubmVyLmFwcGVuZENoaWxkKHQpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh0aXRsZUlubmVyKTtcbiAgaWYgKHRyYWlsaW5nKSB7XG4gICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJpZ2h0LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgICByaWdodC5hcHBlbmRDaGlsZCh0cmFpbGluZyk7XG4gICAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQocmlnaHQpO1xuICB9XG4gIHJldHVybiB0aXRsZVJvdztcbn1cblxuLyoqXG4gKiBDb2RleCdzIFwiT3BlbiBjb25maWcudG9tbFwiLXN0eWxlIHRyYWlsaW5nIGJ1dHRvbjogZ2hvc3QgYm9yZGVyLCBtdXRlZFxuICogbGFiZWwsIHRvcC1yaWdodCBkaWFnb25hbCBhcnJvdyBpY29uLiBNYXJrdXAgbWlycm9ycyBDb25maWd1cmF0aW9uIHBhbmVsLlxuICovXG5mdW5jdGlvbiBvcGVuSW5QbGFjZUJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIGJvcmRlciB3aGl0ZXNwYWNlLW5vd3JhcCBmb2N1czpvdXRsaW5lLW5vbmUgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDAgcm91bmRlZC1sZyB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGF0YS1bc3RhdGU9b3Blbl06YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGJvcmRlci10cmFuc3BhcmVudCBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciBweC0yIHB5LTAgdGV4dC1iYXNlIGxlYWRpbmctWzE4cHhdXCI7XG4gIGJ0bi5pbm5lckhUTUwgPVxuICAgIGAke2xhYmVsfWAgK1xuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tMnhzXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTQuMzM0OSAxMy4zMzAxVjYuNjA2NDVMNS40NzA2NSAxNS40NzA3QzUuMjEwOTUgMTUuNzMwNCA0Ljc4ODk1IDE1LjczMDQgNC41MjkyNSAxNS40NzA3QzQuMjY5NTUgMTUuMjExIDQuMjY5NTUgMTQuNzg5IDQuNTI5MjUgMTQuNTI5M0wxMy4zOTM1IDUuNjY1MDRINi42NjAxMUM2LjI5Mjg0IDUuNjY1MDQgNS45OTUwNyA1LjM2NzI3IDUuOTk1MDcgNUM1Ljk5NTA3IDQuNjMyNzMgNi4yOTI4NCA0LjMzNDk2IDYuNjYwMTEgNC4zMzQ5NkgxNC45OTk5TDE1LjEzMzcgNC4zNDg2M0MxNS40MzY5IDQuNDEwNTcgMTUuNjY1IDQuNjc4NTcgMTUuNjY1IDVWMTMuMzMwMUMxNS42NjQ5IDEzLjY5NzMgMTUuMzY3MiAxMy45OTUxIDE0Ljk5OTkgMTMuOTk1MUMxNC42MzI3IDEzLjk5NTEgMTQuMzM1IDEzLjY5NzMgMTQuMzM0OSAxMy4zMzAxWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIj48L3BhdGg+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0QnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uQ2xpY2s6ICgpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBweC0yIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnkgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIjtcbiAgYnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiByb3VuZGVkQ2FyZCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIGZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIHJvdW5kZWQtbGcgYm9yZGVyXCI7XG4gIGNhcmQuc2V0QXR0cmlidXRlKFxuICAgIFwic3R5bGVcIixcbiAgICBcImJhY2tncm91bmQtY29sb3I6IHZhcigtLWNvbG9yLWJhY2tncm91bmQtcGFuZWwsIHZhcigtLWNvbG9yLXRva2VuLWJnLWZvZykpO1wiLFxuICApO1xuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gcm93U2ltcGxlKHRpdGxlOiBzdHJpbmcgfCB1bmRlZmluZWQsIGRlc2NyaXB0aW9uPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciBnYXAtM1wiO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGlmICh0aXRsZSkge1xuICAgIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHQuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICB0LnRleHRDb250ZW50ID0gdGl0bGU7XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQodCk7XG4gIH1cbiAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZC5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gICAgZC50ZXh0Q29udGVudCA9IGRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGQpO1xuICB9XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIHJldHVybiByb3c7XG59XG5cbi8qKlxuICogQ29kZXgtc3R5bGVkIHRvZ2dsZSBzd2l0Y2guIE1hcmt1cCBtaXJyb3JzIHRoZSBHZW5lcmFsID4gUGVybWlzc2lvbnMgcm93XG4gKiBzd2l0Y2ggd2UgY2FwdHVyZWQ6IG91dGVyIGJ1dHRvbiAocm9sZT1zd2l0Y2gpLCBpbm5lciBwaWxsLCBzbGlkaW5nIGtub2IuXG4gKi9cbmZ1bmN0aW9uIHN3aXRjaENvbnRyb2woXG4gIGluaXRpYWw6IGJvb2xlYW4sXG4gIG9uQ2hhbmdlOiAobmV4dDogYm9vbGVhbikgPT4gdm9pZCB8IFByb21pc2U8dm9pZD4sXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJzd2l0Y2hcIik7XG5cbiAgY29uc3QgcGlsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCBrbm9iID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGtub2IuY2xhc3NOYW1lID1cbiAgICBcInJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLVtjb2xvcjp2YXIoLS1ncmF5LTApXSBiZy1bY29sb3I6dmFyKC0tZ3JheS0wKV0gc2hhZG93LXNtIHRyYW5zaXRpb24tdHJhbnNmb3JtIGR1cmF0aW9uLTIwMCBlYXNlLW91dCBoLTQgdy00XCI7XG4gIHBpbGwuYXBwZW5kQ2hpbGQoa25vYik7XG5cbiAgY29uc3QgYXBwbHkgPSAob246IGJvb2xlYW4pOiB2b2lkID0+IHtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jaGVja2VkXCIsIFN0cmluZyhvbikpO1xuICAgIGJ0bi5kYXRhc2V0LnN0YXRlID0gb24gPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCI7XG4gICAgYnRuLmNsYXNzTmFtZSA9XG4gICAgICBcImlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXIgZm9jdXMtdmlzaWJsZTpyb3VuZGVkLWZ1bGwgY3Vyc29yLWludGVyYWN0aW9uXCI7XG4gICAgcGlsbC5jbGFzc05hbWUgPSBgcmVsYXRpdmUgaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCB0cmFuc2l0aW9uLWNvbG9ycyBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC01IHctOCAke1xuICAgICAgb24gPyBcImJnLXRva2VuLWNoYXJ0cy1ibHVlXCIgOiBcImJnLXRva2VuLWZvcmVncm91bmQvMjBcIlxuICAgIH1gO1xuICAgIHBpbGwuZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGtub2IuZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGtub2Iuc3R5bGUudHJhbnNmb3JtID0gb24gPyBcInRyYW5zbGF0ZVgoMTRweClcIiA6IFwidHJhbnNsYXRlWCgycHgpXCI7XG4gIH07XG4gIGFwcGx5KGluaXRpYWwpO1xuXG4gIGJ0bi5hcHBlbmRDaGlsZChwaWxsKTtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGNvbnN0IG5leHQgPSBidG4uZ2V0QXR0cmlidXRlKFwiYXJpYS1jaGVja2VkXCIpICE9PSBcInRydWVcIjtcbiAgICBhcHBseShuZXh0KTtcbiAgICBidG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBvbkNoYW5nZShuZXh0KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgYnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gZG90KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBzLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIHMudGV4dENvbnRlbnQgPSBcIlx1MDBCN1wiO1xuICByZXR1cm4gcztcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGljb25zIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjb25maWdJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNsaWRlcnMgLyBzZXR0aW5ncyBnbHlwaC4gMjB4MjAgY3VycmVudENvbG9yLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTMgNWg5TTE1IDVoMk0zIDEwaDJNOCAxMGg5TTMgMTVoMTFNMTcgMTVoMFwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxM1wiIGN5PVwiNVwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiNlwiIGN5PVwiMTBcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjE1XCIgY3k9XCIxNVwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc0ljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gU3BhcmtsZXMgLyBcIisrXCIgZ2x5cGggZm9yIHR3ZWFrcy5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0xMCAyLjUgTDExLjQgOC42IEwxNy41IDEwIEwxMS40IDExLjQgTDEwIDE3LjUgTDguNiAxMS40IEwyLjUgMTAgTDguNiA4LjYgWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTUuNSAzIEwxNiA1IEwxOCA1LjUgTDE2IDYgTDE1LjUgOCBMMTUgNiBMMTMgNS41IEwxNSA1IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIgb3BhY2l0eT1cIjAuN1wiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0UGFnZUljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gRG9jdW1lbnQvcGFnZSBnbHlwaCBmb3IgdHdlYWstcmVnaXN0ZXJlZCBwYWdlcyB3aXRob3V0IHRoZWlyIG93biBpY29uLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTUgM2g3bDMgM3YxMWExIDEgMCAwIDEtMSAxSDVhMSAxIDAgMCAxLTEtMVY0YTEgMSAwIDAgMSAxLTFaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTIgM3YzYTEgMSAwIDAgMCAxIDFoMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcgMTFoNk03IDE0aDRcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVJY29uVXJsKFxuICB1cmw6IHN0cmluZyxcbiAgdHdlYWtEaXI6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoL14oaHR0cHM/OnxkYXRhOikvLnRlc3QodXJsKSkgcmV0dXJuIHVybDtcbiAgLy8gUmVsYXRpdmUgcGF0aCBcdTIxOTIgYXNrIG1haW4gdG8gcmVhZCB0aGUgZmlsZSBhbmQgcmV0dXJuIGEgZGF0YTogVVJMLlxuICAvLyBSZW5kZXJlciBpcyBzYW5kYm94ZWQgc28gZmlsZTovLyB3b24ndCBsb2FkIGRpcmVjdGx5LlxuICBjb25zdCByZWwgPSB1cmwuc3RhcnRzV2l0aChcIi4vXCIpID8gdXJsLnNsaWNlKDIpIDogdXJsO1xuICB0cnkge1xuICAgIHJldHVybiAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJjb2RleHBwOnJlYWQtdHdlYWstYXNzZXRcIixcbiAgICAgIHR3ZWFrRGlyLFxuICAgICAgcmVsLFxuICAgICkpIGFzIHN0cmluZztcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJpY29uIGxvYWQgZmFpbGVkXCIsIHsgdXJsLCB0d2Vha0RpciwgZXJyOiBTdHJpbmcoZSkgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIERPTSBoZXVyaXN0aWNzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgLy8gQW5jaG9yIHN0cmF0ZWd5IGZpcnN0ICh3b3VsZCBiZSBpZGVhbCBpZiBDb2RleCBzd2l0Y2hlcyB0byA8YT4pLlxuICBjb25zdCBsaW5rcyA9IEFycmF5LmZyb20oXG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MQW5jaG9yRWxlbWVudD4oXCJhW2hyZWYqPScvc2V0dGluZ3MvJ11cIiksXG4gICk7XG4gIGlmIChsaW5rcy5sZW5ndGggPj0gMikge1xuICAgIGxldCBub2RlOiBIVE1MRWxlbWVudCB8IG51bGwgPSBsaW5rc1swXS5wYXJlbnRFbGVtZW50O1xuICAgIHdoaWxlIChub2RlKSB7XG4gICAgICBjb25zdCBpbnNpZGUgPSBub2RlLnF1ZXJ5U2VsZWN0b3JBbGwoXCJhW2hyZWYqPScvc2V0dGluZ3MvJ11cIik7XG4gICAgICBpZiAoaW5zaWRlLmxlbmd0aCA+PSBNYXRoLm1heCgyLCBsaW5rcy5sZW5ndGggLSAxKSkgcmV0dXJuIG5vZGU7XG4gICAgICBub2RlID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICAgIH1cbiAgfVxuXG4gIC8vIFRleHQtY29udGVudCBtYXRjaCBhZ2FpbnN0IENvZGV4J3Mga25vd24gc2lkZWJhciBsYWJlbHMuXG4gIGNvbnN0IEtOT1dOID0gW1xuICAgIFwiR2VuZXJhbFwiLFxuICAgIFwiQXBwZWFyYW5jZVwiLFxuICAgIFwiQ29uZmlndXJhdGlvblwiLFxuICAgIFwiUGVyc29uYWxpemF0aW9uXCIsXG4gICAgXCJNQ1Agc2VydmVyc1wiLFxuICAgIFwiTUNQIFNlcnZlcnNcIixcbiAgICBcIkdpdFwiLFxuICAgIFwiRW52aXJvbm1lbnRzXCIsXG4gIF07XG4gIGNvbnN0IG1hdGNoZXM6IEhUTUxFbGVtZW50W10gPSBbXTtcbiAgY29uc3QgYWxsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXG4gICAgXCJidXR0b24sIGEsIFtyb2xlPSdidXR0b24nXSwgbGksIGRpdlwiLFxuICApO1xuICBmb3IgKGNvbnN0IGVsIG9mIEFycmF5LmZyb20oYWxsKSkge1xuICAgIGNvbnN0IHQgPSAoZWwudGV4dENvbnRlbnQgPz8gXCJcIikudHJpbSgpO1xuICAgIGlmICh0Lmxlbmd0aCA+IDMwKSBjb250aW51ZTtcbiAgICBpZiAoS05PV04uc29tZSgoaykgPT4gdCA9PT0gaykpIG1hdGNoZXMucHVzaChlbCk7XG4gICAgaWYgKG1hdGNoZXMubGVuZ3RoID4gNTApIGJyZWFrO1xuICB9XG4gIGlmIChtYXRjaGVzLmxlbmd0aCA+PSAyKSB7XG4gICAgbGV0IG5vZGU6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG1hdGNoZXNbMF0ucGFyZW50RWxlbWVudDtcbiAgICB3aGlsZSAobm9kZSkge1xuICAgICAgbGV0IGNvdW50ID0gMDtcbiAgICAgIGZvciAoY29uc3QgbSBvZiBtYXRjaGVzKSBpZiAobm9kZS5jb250YWlucyhtKSkgY291bnQrKztcbiAgICAgIGlmIChjb3VudCA+PSBNYXRoLm1pbigzLCBtYXRjaGVzLmxlbmd0aCkpIHJldHVybiBub2RlO1xuICAgICAgbm9kZSA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGZpbmRDb250ZW50QXJlYSgpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gIGlmICghc2lkZWJhcikgcmV0dXJuIG51bGw7XG4gIGxldCBwYXJlbnQgPSBzaWRlYmFyLnBhcmVudEVsZW1lbnQ7XG4gIHdoaWxlIChwYXJlbnQpIHtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20ocGFyZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBpZiAoY2hpbGQgPT09IHNpZGViYXIgfHwgY2hpbGQuY29udGFpbnMoc2lkZWJhcikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgciA9IGNoaWxkLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgaWYgKHIud2lkdGggPiAzMDAgJiYgci5oZWlnaHQgPiAyMDApIHJldHVybiBjaGlsZDtcbiAgICB9XG4gICAgcGFyZW50ID0gcGFyZW50LnBhcmVudEVsZW1lbnQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG1heWJlRHVtcERvbSgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gICAgaWYgKHNpZGViYXIgJiYgIXN0YXRlLnNpZGViYXJEdW1wZWQpIHtcbiAgICAgIHN0YXRlLnNpZGViYXJEdW1wZWQgPSB0cnVlO1xuICAgICAgY29uc3Qgc2JSb290ID0gc2lkZWJhci5wYXJlbnRFbGVtZW50ID8/IHNpZGViYXI7XG4gICAgICBwbG9nKGBjb2RleCBzaWRlYmFyIEhUTUxgLCBzYlJvb3Qub3V0ZXJIVE1MLnNsaWNlKDAsIDMyMDAwKSk7XG4gICAgfVxuICAgIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgICBpZiAoIWNvbnRlbnQpIHtcbiAgICAgIGlmIChzdGF0ZS5maW5nZXJwcmludCAhPT0gbG9jYXRpb24uaHJlZikge1xuICAgICAgICBzdGF0ZS5maW5nZXJwcmludCA9IGxvY2F0aW9uLmhyZWY7XG4gICAgICAgIHBsb2coXCJkb20gcHJvYmUgKG5vIGNvbnRlbnQpXCIsIHtcbiAgICAgICAgICB1cmw6IGxvY2F0aW9uLmhyZWYsXG4gICAgICAgICAgc2lkZWJhcjogc2lkZWJhciA/IGRlc2NyaWJlKHNpZGViYXIpIDogbnVsbCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGxldCBwYW5lbDogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20oY29udGVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgaWYgKGNoaWxkLmRhdGFzZXQuY29kZXhwcCA9PT0gXCJ0d2Vha3MtcGFuZWxcIikgY29udGludWU7XG4gICAgICBpZiAoY2hpbGQuc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIpIGNvbnRpbnVlO1xuICAgICAgcGFuZWwgPSBjaGlsZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjb25zdCBhY3RpdmVOYXYgPSBzaWRlYmFyXG4gICAgICA/IEFycmF5LmZyb20oc2lkZWJhci5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcImJ1dHRvbiwgYVwiKSkuZmluZChcbiAgICAgICAgICAoYikgPT5cbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpID09PSBcInBhZ2VcIiB8fFxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFjdGl2ZVwiKSA9PT0gXCJ0cnVlXCIgfHxcbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiKSA9PT0gXCJ0cnVlXCIgfHxcbiAgICAgICAgICAgIGIuY2xhc3NMaXN0LmNvbnRhaW5zKFwiYWN0aXZlXCIpLFxuICAgICAgICApXG4gICAgICA6IG51bGw7XG4gICAgY29uc3QgaGVhZGluZyA9IHBhbmVsPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcbiAgICAgIFwiaDEsIGgyLCBoMywgW2NsYXNzKj0naGVhZGluZyddXCIsXG4gICAgKTtcbiAgICBjb25zdCBmaW5nZXJwcmludCA9IGAke2FjdGl2ZU5hdj8udGV4dENvbnRlbnQgPz8gXCJcIn18JHtoZWFkaW5nPy50ZXh0Q29udGVudCA/PyBcIlwifXwke3BhbmVsPy5jaGlsZHJlbi5sZW5ndGggPz8gMH1gO1xuICAgIGlmIChzdGF0ZS5maW5nZXJwcmludCA9PT0gZmluZ2VycHJpbnQpIHJldHVybjtcbiAgICBzdGF0ZS5maW5nZXJwcmludCA9IGZpbmdlcnByaW50O1xuICAgIHBsb2coXCJkb20gcHJvYmVcIiwge1xuICAgICAgdXJsOiBsb2NhdGlvbi5ocmVmLFxuICAgICAgYWN0aXZlTmF2OiBhY3RpdmVOYXY/LnRleHRDb250ZW50Py50cmltKCkgPz8gbnVsbCxcbiAgICAgIGhlYWRpbmc6IGhlYWRpbmc/LnRleHRDb250ZW50Py50cmltKCkgPz8gbnVsbCxcbiAgICAgIGNvbnRlbnQ6IGRlc2NyaWJlKGNvbnRlbnQpLFxuICAgIH0pO1xuICAgIGlmIChwYW5lbCkge1xuICAgICAgY29uc3QgaHRtbCA9IHBhbmVsLm91dGVySFRNTDtcbiAgICAgIHBsb2coXG4gICAgICAgIGBjb2RleCBwYW5lbCBIVE1MICgke2FjdGl2ZU5hdj8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBcIj9cIn0pYCxcbiAgICAgICAgaHRtbC5zbGljZSgwLCAzMjAwMCksXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJkb20gcHJvYmUgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZGVzY3JpYmUoZWw6IEhUTUxFbGVtZW50KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4ge1xuICAgIHRhZzogZWwudGFnTmFtZSxcbiAgICBjbHM6IGVsLmNsYXNzTmFtZS5zbGljZSgwLCAxMjApLFxuICAgIGlkOiBlbC5pZCB8fCB1bmRlZmluZWQsXG4gICAgY2hpbGRyZW46IGVsLmNoaWxkcmVuLmxlbmd0aCxcbiAgICByZWN0OiAoKCkgPT4ge1xuICAgICAgY29uc3QgciA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgcmV0dXJuIHsgdzogTWF0aC5yb3VuZChyLndpZHRoKSwgaDogTWF0aC5yb3VuZChyLmhlaWdodCkgfTtcbiAgICB9KSgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha3NQYXRoKCk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19jb2RleHBwX3R3ZWFrc19kaXJfXz86IHN0cmluZyB9KS5fX2NvZGV4cHBfdHdlYWtzX2Rpcl9fID8/XG4gICAgXCI8dXNlciBkaXI+L3R3ZWFrc1wiXG4gICk7XG59XG4iLCAiLyoqXG4gKiBSZW5kZXJlci1zaWRlIHR3ZWFrIGhvc3QuIFdlOlxuICogICAxLiBBc2sgbWFpbiBmb3IgdGhlIHR3ZWFrIGxpc3QgKHdpdGggcmVzb2x2ZWQgZW50cnkgcGF0aCkuXG4gKiAgIDIuIEZvciBlYWNoIHJlbmRlcmVyLXNjb3BlZCAob3IgXCJib3RoXCIpIHR3ZWFrLCBmZXRjaCBpdHMgc291cmNlIHZpYSBJUENcbiAqICAgICAgYW5kIGV4ZWN1dGUgaXQgYXMgYSBDb21tb25KUy1zaGFwZWQgZnVuY3Rpb24uXG4gKiAgIDMuIFByb3ZpZGUgaXQgdGhlIHJlbmRlcmVyIGhhbGYgb2YgdGhlIEFQSS5cbiAqXG4gKiBDb2RleCBydW5zIHRoZSByZW5kZXJlciB3aXRoIHNhbmRib3g6IHRydWUsIHNvIE5vZGUncyBgcmVxdWlyZSgpYCBpc1xuICogcmVzdHJpY3RlZCB0byBhIHRpbnkgd2hpdGVsaXN0IChlbGVjdHJvbiArIGEgZmV3IHBvbHlmaWxscykuIFRoYXQgbWVhbnMgd2VcbiAqIGNhbm5vdCBgcmVxdWlyZSgpYCBhcmJpdHJhcnkgdHdlYWsgZmlsZXMgZnJvbSBkaXNrLiBJbnN0ZWFkIHdlIHB1bGwgdGhlXG4gKiBzb3VyY2Ugc3RyaW5nIGZyb20gbWFpbiBhbmQgZXZhbHVhdGUgaXQgd2l0aCBgbmV3IEZ1bmN0aW9uYCBpbnNpZGUgdGhlXG4gKiBwcmVsb2FkIGNvbnRleHQuIFR3ZWFrIGF1dGhvcnMgd2hvIG5lZWQgbnBtIGRlcHMgbXVzdCBidW5kbGUgdGhlbSBpbi5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJTZWN0aW9uLCByZWdpc3RlclBhZ2UsIGNsZWFyU2VjdGlvbnMsIHNldExpc3RlZFR3ZWFrcyB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5pbXBvcnQgeyBmaWJlckZvck5vZGUgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgdHlwZSB7XG4gIFR3ZWFrTWFuaWZlc3QsXG4gIFR3ZWFrQXBpLFxuICBSZWFjdEZpYmVyTm9kZSxcbiAgVHdlYWssXG59IGZyb20gXCJAY29kZXgtcGx1c3BsdXMvc2RrXCI7XG5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHVwZGF0ZToge1xuICAgIGNoZWNrZWRBdDogc3RyaW5nO1xuICAgIHJlcG86IHN0cmluZztcbiAgICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICAgIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gICAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gICAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFVzZXJQYXRocyB7XG4gIHVzZXJSb290OiBzdHJpbmc7XG4gIHJ1bnRpbWVEaXI6IHN0cmluZztcbiAgdHdlYWtzRGlyOiBzdHJpbmc7XG4gIGxvZ0Rpcjogc3RyaW5nO1xufVxuXG5jb25zdCBsb2FkZWQgPSBuZXcgTWFwPHN0cmluZywgeyBzdG9wPzogKCkgPT4gdm9pZCB9PigpO1xubGV0IGNhY2hlZFBhdGhzOiBVc2VyUGF0aHMgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0VHdlYWtIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0d2Vha3MgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpsaXN0LXR3ZWFrc1wiKSkgYXMgTGlzdGVkVHdlYWtbXTtcbiAgY29uc3QgcGF0aHMgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp1c2VyLXBhdGhzXCIpKSBhcyBVc2VyUGF0aHM7XG4gIGNhY2hlZFBhdGhzID0gcGF0aHM7XG4gIC8vIFB1c2ggdGhlIGxpc3QgdG8gdGhlIHNldHRpbmdzIGluamVjdG9yIHNvIHRoZSBUd2Vha3MgcGFnZSBjYW4gcmVuZGVyXG4gIC8vIGNhcmRzIGV2ZW4gYmVmb3JlIGFueSB0d2VhaydzIHN0YXJ0KCkgcnVucyAoYW5kIGZvciBkaXNhYmxlZCB0d2Vha3NcbiAgLy8gdGhhdCB3ZSBuZXZlciBsb2FkKS5cbiAgc2V0TGlzdGVkVHdlYWtzKHR3ZWFrcyk7XG4gIC8vIFN0YXNoIGZvciB0aGUgc2V0dGluZ3MgaW5qZWN0b3IncyBlbXB0eS1zdGF0ZSBtZXNzYWdlLlxuICAod2luZG93IGFzIHVua25vd24gYXMgeyBfX2NvZGV4cHBfdHdlYWtzX2Rpcl9fPzogc3RyaW5nIH0pLl9fY29kZXhwcF90d2Vha3NfZGlyX18gPVxuICAgIHBhdGhzLnR3ZWFrc0RpcjtcblxuICBmb3IgKGNvbnN0IHQgb2YgdHdlYWtzKSB7XG4gICAgaWYgKHQubWFuaWZlc3Quc2NvcGUgPT09IFwibWFpblwiKSBjb250aW51ZTtcbiAgICBpZiAoIXQuZW50cnlFeGlzdHMpIGNvbnRpbnVlO1xuICAgIGlmICghdC5lbmFibGVkKSBjb250aW51ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgbG9hZFR3ZWFrKHQsIHBhdGhzKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSB0d2VhayBsb2FkIGZhaWxlZDpcIiwgdC5tYW5pZmVzdC5pZCwgZSk7XG4gICAgfVxuICB9XG5cbiAgY29uc29sZS5pbmZvKFxuICAgIGBbY29kZXgtcGx1c3BsdXNdIHJlbmRlcmVyIGhvc3QgbG9hZGVkICR7bG9hZGVkLnNpemV9IHR3ZWFrKHMpOmAsXG4gICAgWy4uLmxvYWRlZC5rZXlzKCldLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwiLFxuICApO1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGByZW5kZXJlciBob3N0IGxvYWRlZCAke2xvYWRlZC5zaXplfSB0d2VhayhzKTogJHtbLi4ubG9hZGVkLmtleXMoKV0uam9pbihcIiwgXCIpIHx8IFwiKG5vbmUpXCJ9YCxcbiAgKTtcbn1cblxuLyoqXG4gKiBTdG9wIGV2ZXJ5IHJlbmRlcmVyLXNjb3BlIHR3ZWFrIHNvIGEgc3Vic2VxdWVudCBgc3RhcnRUd2Vha0hvc3QoKWAgd2lsbFxuICogcmUtZXZhbHVhdGUgZnJlc2ggc291cmNlLiBNb2R1bGUgY2FjaGUgaXNuJ3QgcmVsZXZhbnQgc2luY2Ugd2UgZXZhbFxuICogc291cmNlIHN0cmluZ3MgZGlyZWN0bHkgXHUyMDE0IGVhY2ggbG9hZCBjcmVhdGVzIGEgZnJlc2ggc2NvcGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0ZWFyZG93blR3ZWFrSG9zdCgpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBbaWQsIHRdIG9mIGxvYWRlZCkge1xuICAgIHRyeSB7XG4gICAgICB0LnN0b3A/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihcIltjb2RleC1wbHVzcGx1c10gdHdlYWsgc3RvcCBmYWlsZWQ6XCIsIGlkLCBlKTtcbiAgICB9XG4gIH1cbiAgbG9hZGVkLmNsZWFyKCk7XG4gIGNsZWFyU2VjdGlvbnMoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFR3ZWFrKHQ6IExpc3RlZFR3ZWFrLCBwYXRoczogVXNlclBhdGhzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNvdXJjZSA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgXCJjb2RleHBwOnJlYWQtdHdlYWstc291cmNlXCIsXG4gICAgdC5lbnRyeSxcbiAgKSkgYXMgc3RyaW5nO1xuXG4gIC8vIEV2YWx1YXRlIGFzIENKUy1zaGFwZWQ6IHByb3ZpZGUgbW9kdWxlL2V4cG9ydHMvYXBpLiBUd2VhayBjb2RlIG1heSB1c2VcbiAgLy8gYG1vZHVsZS5leHBvcnRzID0geyBzdGFydCwgc3RvcCB9YCBvciBgZXhwb3J0cy5zdGFydCA9IC4uLmAgb3IgcHVyZSBFU01cbiAgLy8gZGVmYXVsdCBleHBvcnQgc2hhcGUgKHdlIGFjY2VwdCBib3RoKS5cbiAgY29uc3QgbW9kdWxlID0geyBleHBvcnRzOiB7fSBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWsgfTtcbiAgY29uc3QgZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzO1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWltcGxpZWQtZXZhbCwgbm8tbmV3LWZ1bmNcbiAgY29uc3QgZm4gPSBuZXcgRnVuY3Rpb24oXG4gICAgXCJtb2R1bGVcIixcbiAgICBcImV4cG9ydHNcIixcbiAgICBcImNvbnNvbGVcIixcbiAgICBgJHtzb3VyY2V9XFxuLy8jIHNvdXJjZVVSTD1jb2RleHBwLXR3ZWFrOi8vJHtlbmNvZGVVUklDb21wb25lbnQodC5tYW5pZmVzdC5pZCl9LyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQuZW50cnkpfWAsXG4gICk7XG4gIGZuKG1vZHVsZSwgZXhwb3J0cywgY29uc29sZSk7XG4gIGNvbnN0IG1vZCA9IG1vZHVsZS5leHBvcnRzIGFzIHsgZGVmYXVsdD86IFR3ZWFrIH0gJiBUd2VhaztcbiAgY29uc3QgdHdlYWs6IFR3ZWFrID0gKG1vZCBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9KS5kZWZhdWx0ID8/IChtb2QgYXMgVHdlYWspO1xuICBpZiAodHlwZW9mIHR3ZWFrPy5zdGFydCAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGB0d2VhayAke3QubWFuaWZlc3QuaWR9IGhhcyBubyBzdGFydCgpYCk7XG4gIH1cbiAgY29uc3QgYXBpID0gbWFrZVJlbmRlcmVyQXBpKHQubWFuaWZlc3QsIHBhdGhzKTtcbiAgYXdhaXQgdHdlYWsuc3RhcnQoYXBpKTtcbiAgbG9hZGVkLnNldCh0Lm1hbmlmZXN0LmlkLCB7IHN0b3A6IHR3ZWFrLnN0b3A/LmJpbmQodHdlYWspIH0pO1xufVxuXG5mdW5jdGlvbiBtYWtlUmVuZGVyZXJBcGkobWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3QsIHBhdGhzOiBVc2VyUGF0aHMpOiBUd2Vha0FwaSB7XG4gIGNvbnN0IGlkID0gbWFuaWZlc3QuaWQ7XG4gIGNvbnN0IGxvZyA9IChsZXZlbDogXCJkZWJ1Z1wiIHwgXCJpbmZvXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiwgLi4uYTogdW5rbm93bltdKSA9PiB7XG4gICAgY29uc3QgY29uc29sZUZuID1cbiAgICAgIGxldmVsID09PSBcImRlYnVnXCIgPyBjb25zb2xlLmRlYnVnXG4gICAgICA6IGxldmVsID09PSBcIndhcm5cIiA/IGNvbnNvbGUud2FyblxuICAgICAgOiBsZXZlbCA9PT0gXCJlcnJvclwiID8gY29uc29sZS5lcnJvclxuICAgICAgOiBjb25zb2xlLmxvZztcbiAgICBjb25zb2xlRm4oYFtjb2RleC1wbHVzcGx1c11bJHtpZH1dYCwgLi4uYSk7XG4gICAgLy8gQWxzbyBtaXJyb3IgdG8gbWFpbidzIGxvZyBmaWxlIHNvIHdlIGNhbiBkaWFnbm9zZSB0d2VhayBiZWhhdmlvclxuICAgIC8vIHdpdGhvdXQgYXR0YWNoaW5nIERldlRvb2xzLiBTdHJpbmdpZnkgZWFjaCBhcmcgZGVmZW5zaXZlbHkuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcnRzID0gYS5tYXAoKHYpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2ID09PSBcInN0cmluZ1wiKSByZXR1cm4gdjtcbiAgICAgICAgaWYgKHYgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIGAke3YubmFtZX06ICR7di5tZXNzYWdlfWA7XG4gICAgICAgIHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSh2KTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcodik7IH1cbiAgICAgIH0pO1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICAgICAgXCJjb2RleHBwOnByZWxvYWQtbG9nXCIsXG4gICAgICAgIGxldmVsLFxuICAgICAgICBgW3R3ZWFrICR7aWR9XSAke3BhcnRzLmpvaW4oXCIgXCIpfWAsXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc3dhbGxvdyBcdTIwMTQgbmV2ZXIgbGV0IGxvZ2dpbmcgYnJlYWsgYSB0d2VhayAqL1xuICAgIH1cbiAgfTtcblxuICByZXR1cm4ge1xuICAgIG1hbmlmZXN0LFxuICAgIHByb2Nlc3M6IFwicmVuZGVyZXJcIixcbiAgICBsb2c6IHtcbiAgICAgIGRlYnVnOiAoLi4uYSkgPT4gbG9nKFwiZGVidWdcIiwgLi4uYSksXG4gICAgICBpbmZvOiAoLi4uYSkgPT4gbG9nKFwiaW5mb1wiLCAuLi5hKSxcbiAgICAgIHdhcm46ICguLi5hKSA9PiBsb2coXCJ3YXJuXCIsIC4uLmEpLFxuICAgICAgZXJyb3I6ICguLi5hKSA9PiBsb2coXCJlcnJvclwiLCAuLi5hKSxcbiAgICB9LFxuICAgIHN0b3JhZ2U6IHJlbmRlcmVyU3RvcmFnZShpZCksXG4gICAgc2V0dGluZ3M6IHtcbiAgICAgIHJlZ2lzdGVyOiAocykgPT4gcmVnaXN0ZXJTZWN0aW9uKHsgLi4ucywgaWQ6IGAke2lkfToke3MuaWR9YCB9KSxcbiAgICAgIHJlZ2lzdGVyUGFnZTogKHApID0+XG4gICAgICAgIHJlZ2lzdGVyUGFnZShpZCwgbWFuaWZlc3QsIHsgLi4ucCwgaWQ6IGAke2lkfToke3AuaWR9YCB9KSxcbiAgICB9LFxuICAgIHJlYWN0OiB7XG4gICAgICBnZXRGaWJlcjogKG4pID0+IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGwsXG4gICAgICBmaW5kT3duZXJCeU5hbWU6IChuLCBuYW1lKSA9PiB7XG4gICAgICAgIGxldCBmID0gZmliZXJGb3JOb2RlKG4pIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbDtcbiAgICAgICAgd2hpbGUgKGYpIHtcbiAgICAgICAgICBjb25zdCB0ID0gZi50eXBlIGFzIHsgZGlzcGxheU5hbWU/OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB8IG51bGw7XG4gICAgICAgICAgaWYgKHQgJiYgKHQuZGlzcGxheU5hbWUgPT09IG5hbWUgfHwgdC5uYW1lID09PSBuYW1lKSkgcmV0dXJuIGY7XG4gICAgICAgICAgZiA9IGYucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfSxcbiAgICAgIHdhaXRGb3JFbGVtZW50OiAoc2VsLCB0aW1lb3V0TXMgPSA1MDAwKSA9PlxuICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7XG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSByZXR1cm4gcmVzb2x2ZShleGlzdGluZyk7XG4gICAgICAgICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgdGltZW91dE1zO1xuICAgICAgICAgIGNvbnN0IG9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgICAgaWYgKGVsKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlc29sdmUoZWwpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChEYXRlLm5vdygpID4gZGVhZGxpbmUpIHtcbiAgICAgICAgICAgICAgb2JzLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgdGltZW91dCB3YWl0aW5nIGZvciAke3NlbH1gKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgICAgICAgfSksXG4gICAgfSxcbiAgICBpcGM6IHtcbiAgICAgIG9uOiAoYywgaCkgPT4ge1xuICAgICAgICBjb25zdCB3cmFwcGVkID0gKF9lOiB1bmtub3duLCAuLi5hcmdzOiB1bmtub3duW10pID0+IGgoLi4uYXJncyk7XG4gICAgICAgIGlwY1JlbmRlcmVyLm9uKGBjb2RleHBwOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGBjb2RleHBwOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgIH0sXG4gICAgICBzZW5kOiAoYywgLi4uYXJncykgPT4gaXBjUmVuZGVyZXIuc2VuZChgY29kZXhwcDoke2lkfToke2N9YCwgLi4uYXJncyksXG4gICAgICBpbnZva2U6IDxUPihjOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKGBjb2RleHBwOiR7aWR9OiR7Y31gLCAuLi5hcmdzKSBhcyBQcm9taXNlPFQ+LFxuICAgIH0sXG4gICAgZnM6IHJlbmRlcmVyRnMoaWQsIHBhdGhzKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJTdG9yYWdlKGlkOiBzdHJpbmcpIHtcbiAgY29uc3Qga2V5ID0gYGNvZGV4cHA6c3RvcmFnZToke2lkfWA7XG4gIGNvbnN0IHJlYWQgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpID8/IFwie31cIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICB9O1xuICBjb25zdCB3cml0ZSA9ICh2OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT5cbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHYpKTtcbiAgcmV0dXJuIHtcbiAgICBnZXQ6IDxUPihrOiBzdHJpbmcsIGQ/OiBUKSA9PiAoayBpbiByZWFkKCkgPyAocmVhZCgpW2tdIGFzIFQpIDogKGQgYXMgVCkpLFxuICAgIHNldDogKGs6IHN0cmluZywgdjogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbyA9IHJlYWQoKTtcbiAgICAgIG9ba10gPSB2O1xuICAgICAgd3JpdGUobyk7XG4gICAgfSxcbiAgICBkZWxldGU6IChrOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IG8gPSByZWFkKCk7XG4gICAgICBkZWxldGUgb1trXTtcbiAgICAgIHdyaXRlKG8pO1xuICAgIH0sXG4gICAgYWxsOiAoKSA9PiByZWFkKCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyRnMoaWQ6IHN0cmluZywgX3BhdGhzOiBVc2VyUGF0aHMpIHtcbiAgLy8gU2FuZGJveGVkIHJlbmRlcmVyIGNhbid0IHVzZSBOb2RlIGZzIGRpcmVjdGx5IFx1MjAxNCBwcm94eSB0aHJvdWdoIG1haW4gSVBDLlxuICByZXR1cm4ge1xuICAgIGRhdGFEaXI6IGA8cmVtb3RlPi90d2Vhay1kYXRhLyR7aWR9YCxcbiAgICByZWFkOiAocDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcInJlYWRcIiwgaWQsIHApIGFzIFByb21pc2U8c3RyaW5nPixcbiAgICB3cml0ZTogKHA6IHN0cmluZywgYzogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcIndyaXRlXCIsIGlkLCBwLCBjKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGV4aXN0czogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dHdlYWstZnNcIiwgXCJleGlzdHNcIiwgaWQsIHApIGFzIFByb21pc2U8Ym9vbGVhbj4sXG4gIH07XG59XG4iLCAiLyoqXG4gKiBCdWlsdC1pbiBcIlR3ZWFrIE1hbmFnZXJcIiBcdTIwMTQgYXV0by1pbmplY3RlZCBieSB0aGUgcnVudGltZSwgbm90IGEgdXNlciB0d2Vhay5cbiAqIExpc3RzIGRpc2NvdmVyZWQgdHdlYWtzIHdpdGggZW5hYmxlIHRvZ2dsZXMsIG9wZW5zIHRoZSB0d2Vha3MgZGlyLCBsaW5rc1xuICogdG8gbG9ncyBhbmQgY29uZmlnLiBMaXZlcyBpbiB0aGUgcmVuZGVyZXIuXG4gKlxuICogVGhpcyBpcyBpbnZva2VkIGZyb20gcHJlbG9hZC9pbmRleC50cyBBRlRFUiB1c2VyIHR3ZWFrcyBhcmUgbG9hZGVkIHNvIGl0XG4gKiBjYW4gc2hvdyB1cC10by1kYXRlIHN0YXR1cy5cbiAqL1xuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtb3VudE1hbmFnZXIoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmxpc3QtdHdlYWtzXCIpKSBhcyBBcnJheTx7XG4gICAgbWFuaWZlc3Q6IHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nIH07XG4gICAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIH0+O1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnVzZXItcGF0aHNcIikpIGFzIHtcbiAgICB1c2VyUm9vdDogc3RyaW5nO1xuICAgIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICAgIGxvZ0Rpcjogc3RyaW5nO1xuICB9O1xuXG4gIHJlZ2lzdGVyU2VjdGlvbih7XG4gICAgaWQ6IFwiY29kZXgtcGx1c3BsdXM6bWFuYWdlclwiLFxuICAgIHRpdGxlOiBcIlR3ZWFrIE1hbmFnZXJcIixcbiAgICBkZXNjcmlwdGlvbjogYCR7dHdlYWtzLmxlbmd0aH0gdHdlYWsocykgaW5zdGFsbGVkLiBVc2VyIGRpcjogJHtwYXRocy51c2VyUm9vdH1gLFxuICAgIHJlbmRlcihyb290KSB7XG4gICAgICByb290LnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweDtcIjtcblxuICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBhY3Rpb25zLnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO1wiO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiB0d2Vha3MgZm9sZGVyXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMudHdlYWtzRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiBsb2dzXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMubG9nRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiUmVsb2FkIHdpbmRvd1wiLCAoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSksXG4gICAgICApO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAgICAgaWYgKHR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICAgICAgZW1wdHkuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEzcHggc3lzdGVtLXVpO21hcmdpbjo4cHggMDtcIjtcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPVxuICAgICAgICAgIFwiTm8gdXNlciB0d2Vha3MgeWV0LiBEcm9wIGEgZm9sZGVyIHdpdGggbWFuaWZlc3QuanNvbiArIGluZGV4LmpzIGludG8gdGhlIHR3ZWFrcyBkaXIsIHRoZW4gcmVsb2FkLlwiO1xuICAgICAgICByb290LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInVsXCIpO1xuICAgICAgbGlzdC5zdHlsZS5jc3NUZXh0ID0gXCJsaXN0LXN0eWxlOm5vbmU7bWFyZ2luOjA7cGFkZGluZzowO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjZweDtcIjtcbiAgICAgIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICAgIGxpLnN0eWxlLmNzc1RleHQgPVxuICAgICAgICAgIFwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjhweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMyYTJhMmEpO2JvcmRlci1yYWRpdXM6NnB4O1wiO1xuICAgICAgICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgbGVmdC5pbm5lckhUTUwgPSBgXG4gICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQ6NjAwIDEzcHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QubmFtZSl9IDxzcGFuIHN0eWxlPVwiY29sb3I6Izg4ODtmb250LXdlaWdodDo0MDA7XCI+diR7ZXNjYXBlKHQubWFuaWZlc3QudmVyc2lvbil9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5kZXNjcmlwdGlvbiA/PyB0Lm1hbmlmZXN0LmlkKX08L2Rpdj5cbiAgICAgICAgYDtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICByaWdodC5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI7XG4gICAgICAgIHJpZ2h0LnRleHRDb250ZW50ID0gdC5lbnRyeUV4aXN0cyA/IFwibG9hZGVkXCIgOiBcIm1pc3NpbmcgZW50cnlcIjtcbiAgICAgICAgbGkuYXBwZW5kKGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgbGlzdC5hcHBlbmQobGkpO1xuICAgICAgfVxuICAgICAgcm9vdC5hcHBlbmQobGlzdCk7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbmNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBiLnN0eWxlLmNzc1RleHQgPVxuICAgIFwicGFkZGluZzo2cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMzMzKTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOmluaGVyaXQ7Zm9udDoxMnB4IHN5c3RlbS11aTtjdXJzb3I6cG9pbnRlcjtcIjtcbiAgYi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25jbGljayk7XG4gIHJldHVybiBiO1xufVxuXG5mdW5jdGlvbiBlc2NhcGUoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+XG4gICAgYyA9PT0gXCImXCJcbiAgICAgID8gXCImYW1wO1wiXG4gICAgICA6IGMgPT09IFwiPFwiXG4gICAgICAgID8gXCImbHQ7XCJcbiAgICAgICAgOiBjID09PSBcIj5cIlxuICAgICAgICAgID8gXCImZ3Q7XCJcbiAgICAgICAgICA6IGMgPT09ICdcIidcbiAgICAgICAgICAgID8gXCImcXVvdDtcIlxuICAgICAgICAgICAgOiBcIiYjMzk7XCIsXG4gICk7XG59XG4iLCAiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcblxuY29uc3QgQ09ERVhfTUVTU0FHRV9GUk9NX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mcm9tLXZpZXdcIjtcbmNvbnN0IENPREVYX01FU1NBR0VfRk9SX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mb3Itdmlld1wiO1xuY29uc3QgREVGQVVMVF9SRVFVRVNUX1RJTUVPVVRfTVMgPSAxMl8wMDA7XG5cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgZWxlY3Ryb25CcmlkZ2U/OiB7XG4gICAgICBzZW5kTWVzc2FnZUZyb21WaWV3PyhtZXNzYWdlOiB1bmtub3duKTogUHJvbWlzZTx2b2lkPjtcbiAgICB9O1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwU2VydmVyUmVxdWVzdE9wdGlvbnMge1xuICBob3N0SWQ/OiBzdHJpbmc7XG4gIHRpbWVvdXRNcz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBTZXJ2ZXJOb3RpZmljYXRpb24ge1xuICBtZXRob2Q6IHN0cmluZztcbiAgcGFyYW1zOiB1bmtub3duO1xufVxuXG5pbnRlcmZhY2UgUGVuZGluZ1JlcXVlc3Qge1xuICBpZDogc3RyaW5nO1xuICByZXNvbHZlKHZhbHVlOiB1bmtub3duKTogdm9pZDtcbiAgcmVqZWN0KGVycm9yOiBFcnJvcik6IHZvaWQ7XG4gIHRpbWVvdXQ6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+O1xufVxuXG5sZXQgbmV4dFJlcXVlc3RJZCA9IDE7XG5jb25zdCBwZW5kaW5nUmVxdWVzdHMgPSBuZXcgTWFwPHN0cmluZywgUGVuZGluZ1JlcXVlc3Q+KCk7XG5jb25zdCBub3RpZmljYXRpb25MaXN0ZW5lcnMgPSBuZXcgU2V0PChub3RpZmljYXRpb246IEFwcFNlcnZlck5vdGlmaWNhdGlvbikgPT4gdm9pZD4oKTtcbmxldCBzdWJzY3JpYmVkID0gZmFsc2U7XG5cbmV4cG9ydCBmdW5jdGlvbiByZXF1ZXN0QXBwU2VydmVyPFQ+KFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGFyYW1zOiB1bmtub3duLFxuICBvcHRpb25zOiBBcHBTZXJ2ZXJSZXF1ZXN0T3B0aW9ucyA9IHt9LFxuKTogUHJvbWlzZTxUPiB7XG4gIGVuc3VyZVN1YnNjcmliZWQoKTtcbiAgY29uc3QgaWQgPSBgY29kZXhwcC0ke0RhdGUubm93KCl9LSR7bmV4dFJlcXVlc3RJZCsrfWA7XG4gIGNvbnN0IGhvc3RJZCA9IG9wdGlvbnMuaG9zdElkID8/IHJlYWRIb3N0SWQoKTtcbiAgY29uc3QgdGltZW91dE1zID0gb3B0aW9ucy50aW1lb3V0TXMgPz8gREVGQVVMVF9SRVFVRVNUX1RJTUVPVVRfTVM7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlPFQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCB0aW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKGlkKTtcbiAgICAgIHJlamVjdChuZXcgRXJyb3IoYFRpbWVkIG91dCB3YWl0aW5nIGZvciBhcHAtc2VydmVyIHJlc3BvbnNlIHRvICR7bWV0aG9kfWApKTtcbiAgICB9LCB0aW1lb3V0TXMpO1xuXG4gICAgcGVuZGluZ1JlcXVlc3RzLnNldChpZCwge1xuICAgICAgaWQsXG4gICAgICByZXNvbHZlOiAodmFsdWUpID0+IHJlc29sdmUodmFsdWUgYXMgVCksXG4gICAgICByZWplY3QsXG4gICAgICB0aW1lb3V0LFxuICAgIH0pO1xuXG4gICAgY29uc3QgbWVzc2FnZSA9IHtcbiAgICAgIHR5cGU6IFwibWNwLXJlcXVlc3RcIixcbiAgICAgIGhvc3RJZCxcbiAgICAgIHJlcXVlc3Q6IHsgaWQsIG1ldGhvZCwgcGFyYW1zIH0sXG4gICAgfTtcblxuICAgIHNlbmRNZXNzYWdlRnJvbVZpZXcobWVzc2FnZSkudGhlbigocmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChyZXNwb25zZSAhPT0gdW5kZWZpbmVkKSBoYW5kbGVJbmNvbWluZ01lc3NhZ2UocmVzcG9uc2UpO1xuICAgIH0pLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgY29uc3QgcGVuZGluZyA9IHBlbmRpbmdSZXF1ZXN0cy5nZXQoaWQpO1xuICAgICAgaWYgKCFwZW5kaW5nKSByZXR1cm47XG4gICAgICBjbGVhclRpbWVvdXQocGVuZGluZy50aW1lb3V0KTtcbiAgICAgIHBlbmRpbmdSZXF1ZXN0cy5kZWxldGUoaWQpO1xuICAgICAgcGVuZGluZy5yZWplY3QodG9FcnJvcihlcnJvcikpO1xuICAgIH0pO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG9uQXBwU2VydmVyTm90aWZpY2F0aW9uKFxuICBsaXN0ZW5lcjogKG5vdGlmaWNhdGlvbjogQXBwU2VydmVyTm90aWZpY2F0aW9uKSA9PiB2b2lkLFxuKTogKCkgPT4gdm9pZCB7XG4gIGVuc3VyZVN1YnNjcmliZWQoKTtcbiAgbm90aWZpY2F0aW9uTGlzdGVuZXJzLmFkZChsaXN0ZW5lcik7XG4gIHJldHVybiAoKSA9PiBub3RpZmljYXRpb25MaXN0ZW5lcnMuZGVsZXRlKGxpc3RlbmVyKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlYWRIb3N0SWQoKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKGxvY2F0aW9uLmhyZWYpO1xuICAgIGNvbnN0IGhvc3RJZCA9IHVybC5zZWFyY2hQYXJhbXMuZ2V0KFwiaG9zdElkXCIpPy50cmltKCk7XG4gICAgcmV0dXJuIGhvc3RJZCB8fCBcImxvY2FsXCI7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBcImxvY2FsXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZW5zdXJlU3Vic2NyaWJlZCgpOiB2b2lkIHtcbiAgaWYgKHN1YnNjcmliZWQpIHJldHVybjtcbiAgc3Vic2NyaWJlZCA9IHRydWU7XG4gIGlwY1JlbmRlcmVyLm9uKENPREVYX01FU1NBR0VfRk9SX1ZJRVcsIChfZXZlbnQsIG1lc3NhZ2UpID0+IHtcbiAgICBoYW5kbGVJbmNvbWluZ01lc3NhZ2UobWVzc2FnZSk7XG4gIH0pO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgKGV2ZW50KSA9PiB7XG4gICAgaGFuZGxlSW5jb21pbmdNZXNzYWdlKGV2ZW50LmRhdGEpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlSW5jb21pbmdNZXNzYWdlKG1lc3NhZ2U6IHVua25vd24pOiB2b2lkIHtcbiAgY29uc3Qgbm90aWZpY2F0aW9uID0gZXh0cmFjdE5vdGlmaWNhdGlvbihtZXNzYWdlKTtcbiAgaWYgKG5vdGlmaWNhdGlvbikge1xuICAgIGZvciAoY29uc3QgbGlzdGVuZXIgb2Ygbm90aWZpY2F0aW9uTGlzdGVuZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICBsaXN0ZW5lcihub3RpZmljYXRpb24pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGlzb2xhdGUgbGlzdGVuZXIgZmFpbHVyZXMgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBjb25zdCByZXNwb25zZSA9IGV4dHJhY3RSZXNwb25zZShtZXNzYWdlKTtcbiAgaWYgKCFyZXNwb25zZSkgcmV0dXJuO1xuICBjb25zdCBwZW5kaW5nID0gcGVuZGluZ1JlcXVlc3RzLmdldChyZXNwb25zZS5pZCk7XG4gIGlmICghcGVuZGluZykgcmV0dXJuO1xuXG4gIGNsZWFyVGltZW91dChwZW5kaW5nLnRpbWVvdXQpO1xuICBwZW5kaW5nUmVxdWVzdHMuZGVsZXRlKHJlc3BvbnNlLmlkKTtcbiAgaWYgKHJlc3BvbnNlLmVycm9yKSB7XG4gICAgcGVuZGluZy5yZWplY3QocmVzcG9uc2UuZXJyb3IpO1xuICAgIHJldHVybjtcbiAgfVxuICBwZW5kaW5nLnJlc29sdmUocmVzcG9uc2UucmVzdWx0KTtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFJlc3BvbnNlKG1lc3NhZ2U6IHVua25vd24pOiB7IGlkOiBzdHJpbmc7IHJlc3VsdD86IHVua25vd247IGVycm9yPzogRXJyb3IgfSB8IG51bGwge1xuICBpZiAoIWlzUmVjb3JkKG1lc3NhZ2UpKSByZXR1cm4gbnVsbDtcblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1yZXNwb25zZVwiICYmIGlzUmVjb3JkKG1lc3NhZ2UucmVzcG9uc2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UucmVzcG9uc2UpO1xuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3AtcmVzcG9uc2VcIiAmJiBpc1JlY29yZChtZXNzYWdlLm1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIHJlc3BvbnNlRnJvbUVudmVsb3BlKG1lc3NhZ2UubWVzc2FnZSk7XG4gIH1cblxuICBpZiAobWVzc2FnZS50eXBlID09PSBcIm1jcC1lcnJvclwiICYmIHR5cGVvZiBtZXNzYWdlLmlkID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHsgaWQ6IG1lc3NhZ2UuaWQsIGVycm9yOiBuZXcgRXJyb3IocmVhZEVycm9yTWVzc2FnZShtZXNzYWdlLmVycm9yKSA/PyBcIkFwcC1zZXJ2ZXIgcmVxdWVzdCBmYWlsZWRcIikgfTtcbiAgfVxuXG4gIGlmIChtZXNzYWdlLnR5cGUgPT09IFwicmVzcG9uc2VcIiAmJiB0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIikge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlKTtcbiAgfVxuXG4gIGlmICh0eXBlb2YgbWVzc2FnZS5pZCA9PT0gXCJzdHJpbmdcIiAmJiAoXCJyZXN1bHRcIiBpbiBtZXNzYWdlIHx8IFwiZXJyb3JcIiBpbiBtZXNzYWdlKSkge1xuICAgIHJldHVybiByZXNwb25zZUZyb21FbnZlbG9wZShtZXNzYWdlKTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZXNwb25zZUZyb21FbnZlbG9wZShlbnZlbG9wZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiB7IGlkOiBzdHJpbmc7IHJlc3VsdD86IHVua25vd247IGVycm9yPzogRXJyb3IgfSB8IG51bGwge1xuICBjb25zdCBpZCA9IHR5cGVvZiBlbnZlbG9wZS5pZCA9PT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgZW52ZWxvcGUuaWQgPT09IFwibnVtYmVyXCJcbiAgICA/IFN0cmluZyhlbnZlbG9wZS5pZClcbiAgICA6IG51bGw7XG4gIGlmICghaWQpIHJldHVybiBudWxsO1xuXG4gIGlmIChcImVycm9yXCIgaW4gZW52ZWxvcGUpIHtcbiAgICByZXR1cm4geyBpZCwgZXJyb3I6IG5ldyBFcnJvcihyZWFkRXJyb3JNZXNzYWdlKGVudmVsb3BlLmVycm9yKSA/PyBcIkFwcC1zZXJ2ZXIgcmVxdWVzdCBmYWlsZWRcIikgfTtcbiAgfVxuXG4gIHJldHVybiB7IGlkLCByZXN1bHQ6IGVudmVsb3BlLnJlc3VsdCB9O1xufVxuXG5mdW5jdGlvbiBleHRyYWN0Tm90aWZpY2F0aW9uKG1lc3NhZ2U6IHVua25vd24pOiBBcHBTZXJ2ZXJOb3RpZmljYXRpb24gfCBudWxsIHtcbiAgaWYgKCFpc1JlY29yZChtZXNzYWdlKSkgcmV0dXJuIG51bGw7XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5yZXF1ZXN0KSkge1xuICAgIGNvbnN0IG1ldGhvZCA9IG1lc3NhZ2UucmVxdWVzdC5tZXRob2Q7XG4gICAgaWYgKHR5cGVvZiBtZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7IG1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnJlcXVlc3QucGFyYW1zIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgaXNSZWNvcmQobWVzc2FnZS5tZXNzYWdlKSkge1xuICAgIGNvbnN0IG1ldGhvZCA9IG1lc3NhZ2UubWVzc2FnZS5tZXRob2Q7XG4gICAgaWYgKHR5cGVvZiBtZXRob2QgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgIHJldHVybiB7IG1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLm1lc3NhZ2UucGFyYW1zIH07XG4gICAgfVxuICB9XG5cbiAgaWYgKG1lc3NhZ2UudHlwZSA9PT0gXCJtY3Atbm90aWZpY2F0aW9uXCIgJiYgdHlwZW9mIG1lc3NhZ2UubWV0aG9kID09PSBcInN0cmluZ1wiKSB7XG4gICAgcmV0dXJuIHsgbWV0aG9kOiBtZXNzYWdlLm1ldGhvZCwgcGFyYW1zOiBtZXNzYWdlLnBhcmFtcyB9O1xuICB9XG5cbiAgaWYgKHR5cGVvZiBtZXNzYWdlLm1ldGhvZCA9PT0gXCJzdHJpbmdcIiAmJiAhKFwiaWRcIiBpbiBtZXNzYWdlKSkge1xuICAgIHJldHVybiB7IG1ldGhvZDogbWVzc2FnZS5tZXRob2QsIHBhcmFtczogbWVzc2FnZS5wYXJhbXMgfTtcbiAgfVxuXG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiByZWFkRXJyb3JNZXNzYWdlKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgaWYgKHR5cGVvZiBlcnJvciA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGVycm9yO1xuICBpZiAoaXNSZWNvcmQoZXJyb3IpKSB7XG4gICAgaWYgKHR5cGVvZiBlcnJvci5tZXNzYWdlID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3IubWVzc2FnZTtcbiAgICBpZiAodHlwZW9mIGVycm9yLmVycm9yID09PSBcInN0cmluZ1wiKSByZXR1cm4gZXJyb3IuZXJyb3I7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIHNlbmRNZXNzYWdlRnJvbVZpZXcobWVzc2FnZTogdW5rbm93bik6IFByb21pc2U8dW5rbm93bj4ge1xuICBjb25zdCBicmlkZ2VTZW5kZXIgPSB3aW5kb3cuZWxlY3Ryb25CcmlkZ2U/LnNlbmRNZXNzYWdlRnJvbVZpZXc7XG4gIGlmICh0eXBlb2YgYnJpZGdlU2VuZGVyID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICByZXR1cm4gYnJpZGdlU2VuZGVyLmNhbGwod2luZG93LmVsZWN0cm9uQnJpZGdlLCBtZXNzYWdlKS50aGVuKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cbiAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShDT0RFWF9NRVNTQUdFX0ZST01fVklFVywgbWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIHRvRXJyb3IoZXJyb3I6IHVua25vd24pOiBFcnJvciB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSk7XG59XG5cbmZ1bmN0aW9uIGlzUmVjb3JkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4gdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHZhbHVlKTtcbn1cbiIsICJpbXBvcnQgeyBvbkFwcFNlcnZlck5vdGlmaWNhdGlvbiwgcmVhZEhvc3RJZCwgcmVxdWVzdEFwcFNlcnZlciB9IGZyb20gXCIuL2FwcC1zZXJ2ZXItYnJpZGdlXCI7XG5cbnR5cGUgR29hbFN0YXR1cyA9IFwiYWN0aXZlXCIgfCBcInBhdXNlZFwiIHwgXCJidWRnZXRMaW1pdGVkXCIgfCBcImNvbXBsZXRlXCI7XG5cbmludGVyZmFjZSBUaHJlYWRHb2FsIHtcbiAgdGhyZWFkSWQ6IHN0cmluZztcbiAgb2JqZWN0aXZlOiBzdHJpbmc7XG4gIHN0YXR1czogR29hbFN0YXR1cztcbiAgdG9rZW5CdWRnZXQ6IG51bWJlciB8IG51bGw7XG4gIHRva2Vuc1VzZWQ6IG51bWJlcjtcbiAgdGltZVVzZWRTZWNvbmRzOiBudW1iZXI7XG4gIGNyZWF0ZWRBdDogbnVtYmVyO1xuICB1cGRhdGVkQXQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEdvYWxVaUFjdGlvbiB7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGtpbmQ/OiBcInByaW1hcnlcIiB8IFwiZGFuZ2VyXCI7XG4gIHJ1bigpOiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbn1cblxuaW50ZXJmYWNlIEdvYWxQYW5lbE9wdGlvbnMge1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXRhaWw6IHN0cmluZztcbiAgZm9vdGVyPzogc3RyaW5nO1xuICBhY3Rpb25zOiBHb2FsVWlBY3Rpb25bXTtcbiAgcGVyc2lzdGVudDogYm9vbGVhbjtcbiAgZXJyb3I/OiBib29sZWFuO1xufVxuXG5pbnRlcmZhY2UgR29hbFBhbmVsU3RhdGUge1xuICBjb2xsYXBzZWQ6IGJvb2xlYW47XG4gIHg6IG51bWJlciB8IG51bGw7XG4gIHk6IG51bWJlciB8IG51bGw7XG59XG5cbmludGVyZmFjZSBHb2FsUGFuZWxEcmFnIHtcbiAgcG9pbnRlcklkOiBudW1iZXI7XG4gIG9mZnNldFg6IG51bWJlcjtcbiAgb2Zmc2V0WTogbnVtYmVyO1xuICB3aWR0aDogbnVtYmVyO1xuICBoZWlnaHQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIEVkaXRhYmxlVGFyZ2V0IHtcbiAgZWxlbWVudDogSFRNTEVsZW1lbnQ7XG4gIGdldFRleHQoKTogc3RyaW5nO1xuICBzZXRUZXh0KHZhbHVlOiBzdHJpbmcpOiB2b2lkO1xuICBjbGVhcigpOiB2b2lkO1xufVxuXG5sZXQgc3RhcnRlZCA9IGZhbHNlO1xubGV0IHJvb3Q6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgc3VnZ2VzdGlvblJvb3Q6IEhUTUxEaXZFbGVtZW50IHwgbnVsbCA9IG51bGw7XG5sZXQgY3VycmVudEdvYWw6IFRocmVhZEdvYWwgfCBudWxsID0gbnVsbDtcbmxldCBoaWRlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5sZXQgbGFzdFRocmVhZElkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbmxldCBsYXN0UGFuZWxPcHRpb25zOiBHb2FsUGFuZWxPcHRpb25zIHwgbnVsbCA9IG51bGw7XG5sZXQgcGFuZWxEcmFnOiBHb2FsUGFuZWxEcmFnIHwgbnVsbCA9IG51bGw7XG5cbmNvbnN0IEdPQUxfUEFORUxfU1RBVEVfS0VZID0gXCJjb2RleHBwOmdvYWwtcGFuZWwtc3RhdGVcIjtcbmxldCBwYW5lbFN0YXRlOiBHb2FsUGFuZWxTdGF0ZSA9IHJlYWRHb2FsUGFuZWxTdGF0ZSgpO1xuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRHb2FsRmVhdHVyZShsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQgPSAoKSA9PiB7fSk6IHZvaWQge1xuICBpZiAoc3RhcnRlZCkgcmV0dXJuO1xuICBzdGFydGVkID0gdHJ1ZTtcbiAgaW5zdGFsbFN0eWxlcygpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCAoZXZlbnQpID0+IHtcbiAgICB2b2lkIGhhbmRsZUtleWRvd24oZXZlbnQsIGxvZyk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKGV2ZW50KSA9PiB7XG4gICAgdXBkYXRlR29hbFN1Z2dlc3Rpb24oZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50KSk7XG4gIH0sIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiZm9jdXNpblwiLCAoZXZlbnQpID0+IHtcbiAgICB1cGRhdGVHb2FsU3VnZ2VzdGlvbihmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpKTtcbiAgfSwgdHJ1ZSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICBpZiAoc3VnZ2VzdGlvblJvb3Q/LmNvbnRhaW5zKGV2ZW50LnRhcmdldCBhcyBOb2RlKSkgcmV0dXJuO1xuICAgIHVwZGF0ZUdvYWxTdWdnZXN0aW9uKGZpbmRFZGl0YWJsZVRhcmdldChldmVudCkpO1xuICB9LCB0cnVlKTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJyZXNpemVcIiwgKCkgPT4ge1xuICAgIGlmICghcm9vdD8uaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICBjbGFtcEdvYWxQYW5lbFRvVmlld3BvcnQocm9vdCk7XG4gICAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbiAgfSk7XG4gIG9uQXBwU2VydmVyTm90aWZpY2F0aW9uKChub3RpZmljYXRpb24pID0+IHtcbiAgICBpZiAobm90aWZpY2F0aW9uLm1ldGhvZCA9PT0gXCJ0aHJlYWQvZ29hbC91cGRhdGVkXCIgJiYgaXNSZWNvcmQobm90aWZpY2F0aW9uLnBhcmFtcykpIHtcbiAgICAgIGNvbnN0IGdvYWwgPSBub3RpZmljYXRpb24ucGFyYW1zLmdvYWw7XG4gICAgICBpZiAoaXNUaHJlYWRHb2FsKGdvYWwpKSB7XG4gICAgICAgIGlmIChnb2FsLnRocmVhZElkICE9PSByZWFkVGhyZWFkSWQoKSkgcmV0dXJuO1xuICAgICAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobm90aWZpY2F0aW9uLm1ldGhvZCA9PT0gXCJ0aHJlYWQvZ29hbC9jbGVhcmVkXCIgJiYgaXNSZWNvcmQobm90aWZpY2F0aW9uLnBhcmFtcykpIHtcbiAgICAgIGNvbnN0IHRocmVhZElkID0gbm90aWZpY2F0aW9uLnBhcmFtcy50aHJlYWRJZDtcbiAgICAgIGlmICh0eXBlb2YgdGhyZWFkSWQgPT09IFwic3RyaW5nXCIgJiYgdGhyZWFkSWQgPT09IHJlYWRUaHJlYWRJZCgpKSB7XG4gICAgICAgIGN1cnJlbnRHb2FsID0gbnVsbDtcbiAgICAgICAgcmVuZGVyTm90aWNlKFwiR29hbCBjbGVhcmVkXCIsIFwiVGhpcyB0aHJlYWQgbm8gbG9uZ2VyIGhhcyBhbiBhY3RpdmUgZ29hbC5cIik7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvcHN0YXRlXCIsICgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSk7XG4gIGNvbnN0IHJlZnJlc2hUaW1lciA9IHNldEludGVydmFsKCgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSwgMl81MDApO1xuICBjb25zdCB1bnJlZiA9IChyZWZyZXNoVGltZXIgYXMgdW5rbm93biBhcyB7IHVucmVmPzogKCkgPT4gdm9pZCB9KS51bnJlZjtcbiAgaWYgKHR5cGVvZiB1bnJlZiA9PT0gXCJmdW5jdGlvblwiKSB1bnJlZi5jYWxsKHJlZnJlc2hUaW1lcik7XG4gIHF1ZXVlTWljcm90YXNrKCgpID0+IHJlZnJlc2hHb2FsRm9yUm91dGUobG9nKSk7XG4gIGxvZyhcImdvYWwgZmVhdHVyZSBzdGFydGVkXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVLZXlkb3duKGV2ZW50OiBLZXlib2FyZEV2ZW50LCBsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGV2ZW50LmlzQ29tcG9zaW5nKSByZXR1cm47XG5cbiAgY29uc3QgZWRpdGFibGUgPSBmaW5kRWRpdGFibGVUYXJnZXQoZXZlbnQpO1xuICBpZiAoIWVkaXRhYmxlKSByZXR1cm47XG5cbiAgaWYgKGV2ZW50LmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgIGhpZGVHb2FsU3VnZ2VzdGlvbigpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICgoZXZlbnQua2V5ID09PSBcIlRhYlwiIHx8IGV2ZW50LmtleSA9PT0gXCJFbnRlclwiKSAmJiAhZXZlbnQuc2hpZnRLZXkgJiYgIWV2ZW50LmFsdEtleSAmJiAhZXZlbnQuY3RybEtleSAmJiAhZXZlbnQubWV0YUtleSkge1xuICAgIGNvbnN0IHN1Z2dlc3Rpb24gPSBwYXJzZUdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLmdldFRleHQoKSk7XG4gICAgaWYgKHN1Z2dlc3Rpb24gJiYgZWRpdGFibGUuZ2V0VGV4dCgpLnRyaW0oKSAhPT0gXCIvZ29hbFwiKSB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgfVxuXG4gIGlmIChldmVudC5rZXkgIT09IFwiRW50ZXJcIiB8fCBldmVudC5zaGlmdEtleSB8fCBldmVudC5hbHRLZXkgfHwgZXZlbnQuY3RybEtleSB8fCBldmVudC5tZXRhS2V5KSByZXR1cm47XG5cbiAgY29uc3QgcGFyc2VkID0gcGFyc2VHb2FsQ29tbWFuZChlZGl0YWJsZS5nZXRUZXh0KCkpO1xuICBpZiAoIXBhcnNlZCkgcmV0dXJuO1xuXG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICBldmVudC5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgZWRpdGFibGUuY2xlYXIoKTtcbiAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG5cbiAgdHJ5IHtcbiAgICBhd2FpdCBydW5Hb2FsQ29tbWFuZChwYXJzZWQuYXJncywgbG9nKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBsb2coXCJnb2FsIGNvbW1hbmQgZmFpbGVkXCIsIHN0cmluZ2lmeUVycm9yKGVycm9yKSk7XG4gICAgcmVuZGVyRXJyb3IoXCJHb2FsIGNvbW1hbmQgZmFpbGVkXCIsIGZyaWVuZGx5R29hbEVycm9yKGVycm9yKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcGFyc2VHb2FsQ29tbWFuZCh0ZXh0OiBzdHJpbmcpOiB7IGFyZ3M6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gdGV4dC50cmltKCkubWF0Y2goL15cXC9nb2FsKD86XFxzKyhbXFxzXFxTXSopKT8kLyk7XG4gIGlmICghbWF0Y2gpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhcmdzOiAobWF0Y2hbMV0gPz8gXCJcIikudHJpbSgpIH07XG59XG5cbmZ1bmN0aW9uIHBhcnNlR29hbFN1Z2dlc3Rpb24odGV4dDogc3RyaW5nKTogeyBxdWVyeTogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSB0ZXh0LnRyaW0oKS5tYXRjaCgvXlxcLyhbYS16XSopJC9pKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHF1ZXJ5ID0gbWF0Y2hbMV0/LnRvTG93ZXJDYXNlKCkgPz8gXCJcIjtcbiAgcmV0dXJuIFwiZ29hbFwiLnN0YXJ0c1dpdGgocXVlcnkpID8geyBxdWVyeSB9IDogbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuR29hbENvbW1hbmQoYXJnczogc3RyaW5nLCBsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKTtcbiAgaWYgKCF0aHJlYWRJZCkge1xuICAgIHJlbmRlckVycm9yKFwiTm8gYWN0aXZlIHRocmVhZFwiLCBcIk9wZW4gYSBsb2NhbCB0aHJlYWQgYmVmb3JlIHVzaW5nIC9nb2FsLlwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgaG9zdElkID0gcmVhZEhvc3RJZCgpO1xuICBjb25zdCBsb3dlciA9IGFyZ3MudG9Mb3dlckNhc2UoKTtcblxuICBpZiAoIWFyZ3MpIHtcbiAgICBjb25zdCBnb2FsID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgaG9zdElkKTtcbiAgICBjdXJyZW50R29hbCA9IGdvYWw7XG4gICAgaWYgKGdvYWwpIHtcbiAgICAgIHJlbmRlckdvYWwoZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICByZW5kZXJOb3RpY2UoXCJObyBnb2FsIHNldFwiLCBcIlVzZSAvZ29hbCA8b2JqZWN0aXZlPiB0byBzZXQgb25lIGZvciB0aGlzIHRocmVhZC5cIik7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChsb3dlciA9PT0gXCJjbGVhclwiKSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCByZXF1ZXN0QXBwU2VydmVyPHsgY2xlYXJlZDogYm9vbGVhbiB9PihcbiAgICAgIFwidGhyZWFkL2dvYWwvY2xlYXJcIixcbiAgICAgIHsgdGhyZWFkSWQgfSxcbiAgICAgIHsgaG9zdElkIH0sXG4gICAgKTtcbiAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgcmVuZGVyTm90aWNlKHJlc3BvbnNlLmNsZWFyZWQgPyBcIkdvYWwgY2xlYXJlZFwiIDogXCJObyBnb2FsIHNldFwiLCBcIlVzZSAvZ29hbCA8b2JqZWN0aXZlPiB0byBzZXQgYSBuZXcgZ29hbC5cIik7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGxvd2VyID09PSBcInBhdXNlXCIgfHwgbG93ZXIgPT09IFwicmVzdW1lXCIgfHwgbG93ZXIgPT09IFwiY29tcGxldGVcIikge1xuICAgIGNvbnN0IHN0YXR1czogR29hbFN0YXR1cyA9IGxvd2VyID09PSBcInBhdXNlXCIgPyBcInBhdXNlZFwiIDogbG93ZXIgPT09IFwicmVzdW1lXCIgPyBcImFjdGl2ZVwiIDogXCJjb21wbGV0ZVwiO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgICBcInRocmVhZC9nb2FsL3NldFwiLFxuICAgICAgeyB0aHJlYWRJZCwgc3RhdHVzIH0sXG4gICAgICB7IGhvc3RJZCB9LFxuICAgICk7XG4gICAgY3VycmVudEdvYWwgPSByZXNwb25zZS5nb2FsO1xuICAgIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgZ2V0R29hbCh0aHJlYWRJZCwgaG9zdElkKTtcbiAgaWYgKGV4aXN0aW5nICYmIGV4aXN0aW5nLm9iamVjdGl2ZSAhPT0gYXJncykge1xuICAgIGNvbnN0IHJlcGxhY2UgPSBhd2FpdCBjb25maXJtUmVwbGFjZUdvYWwoZXhpc3RpbmcsIGFyZ3MpO1xuICAgIGlmICghcmVwbGFjZSkge1xuICAgICAgY3VycmVudEdvYWwgPSBleGlzdGluZztcbiAgICAgIHJlbmRlckdvYWwoZXhpc3RpbmcsIHsgdHJhbnNpZW50OiBmYWxzZSB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cblxuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvc2V0XCIsXG4gICAgeyB0aHJlYWRJZCwgb2JqZWN0aXZlOiBhcmdzLCBzdGF0dXM6IFwiYWN0aXZlXCIgfSxcbiAgICB7IGhvc3RJZCB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IHJlc3BvbnNlLmdvYWw7XG4gIGxvZyhcImdvYWwgc2V0XCIsIHsgdGhyZWFkSWQgfSk7XG4gIHJlbmRlckdvYWwocmVzcG9uc2UuZ29hbCwgeyB0cmFuc2llbnQ6IGZhbHNlIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBnZXRHb2FsKHRocmVhZElkOiBzdHJpbmcsIGhvc3RJZDogc3RyaW5nKTogUHJvbWlzZTxUaHJlYWRHb2FsIHwgbnVsbD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBnb2FsOiBUaHJlYWRHb2FsIHwgbnVsbCB9PihcbiAgICBcInRocmVhZC9nb2FsL2dldFwiLFxuICAgIHsgdGhyZWFkSWQgfSxcbiAgICB7IGhvc3RJZCB9LFxuICApO1xuICByZXR1cm4gcmVzcG9uc2UuZ29hbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVmcmVzaEdvYWxGb3JSb3V0ZShsb2c6IChzdGFnZTogc3RyaW5nLCBleHRyYT86IHVua25vd24pID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdGhyZWFkSWQgPSByZWFkVGhyZWFkSWQoKTtcbiAgaWYgKCF0aHJlYWRJZCkge1xuICAgIGlmIChsYXN0VGhyZWFkSWQgIT09IG51bGwpIHtcbiAgICAgIGxhc3RUaHJlYWRJZCA9IG51bGw7XG4gICAgICBjdXJyZW50R29hbCA9IG51bGw7XG4gICAgICBoaWRlUGFuZWwoKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICh0aHJlYWRJZCA9PT0gbGFzdFRocmVhZElkKSByZXR1cm47XG4gIGxhc3RUaHJlYWRJZCA9IHRocmVhZElkO1xuICB0cnkge1xuICAgIGNvbnN0IGdvYWwgPSBhd2FpdCBnZXRHb2FsKHRocmVhZElkLCByZWFkSG9zdElkKCkpO1xuICAgIGN1cnJlbnRHb2FsID0gZ29hbDtcbiAgICBpZiAoZ29hbCkge1xuICAgICAgcmVuZGVyR29hbChnb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGhpZGVQYW5lbCgpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAvLyBPbGQgYXBwLXNlcnZlciBidWlsZHMgZG8gbm90IGtub3cgdGhyZWFkL2dvYWwvKi4gS2VlcCB0aGUgVUkgcXVpZXQgdW50aWxcbiAgICAvLyB0aGUgdXNlciBleHBsaWNpdGx5IHR5cGVzIC9nb2FsLCB0aGVuIHNob3cgdGhlIGFjdGlvbmFibGUgZXJyb3IuXG4gICAgbG9nKFwiZ29hbCByb3V0ZSByZWZyZXNoIHNraXBwZWRcIiwgc3RyaW5naWZ5RXJyb3IoZXJyb3IpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb25maXJtUmVwbGFjZUdvYWwoZXhpc3Rpbmc6IFRocmVhZEdvYWwsIG5leHRPYmplY3RpdmU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICByZW5kZXJQYW5lbCh7XG4gICAgICB0aXRsZTogXCJSZXBsYWNlIGN1cnJlbnQgZ29hbD9cIixcbiAgICAgIGRldGFpbDogdHJ1bmNhdGUoZXhpc3Rpbmcub2JqZWN0aXZlLCAxODApLFxuICAgICAgZm9vdGVyOiBgTmV3OiAke3RydW5jYXRlKG5leHRPYmplY3RpdmUsIDE4MCl9YCxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGxhYmVsOiBcIlJlcGxhY2VcIixcbiAgICAgICAgICBraW5kOiBcInByaW1hcnlcIixcbiAgICAgICAgICBydW46ICgpID0+IHJlc29sdmUodHJ1ZSksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBsYWJlbDogXCJDYW5jZWxcIixcbiAgICAgICAgICBydW46ICgpID0+IHJlc29sdmUoZmFsc2UpLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHBlcnNpc3RlbnQ6IHRydWUsXG4gICAgfSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJHb2FsKGdvYWw6IFRocmVhZEdvYWwsIG9wdGlvbnM6IHsgdHJhbnNpZW50OiBib29sZWFuIH0pOiB2b2lkIHtcbiAgY29uc3Qgc3RhdHVzID0gZ29hbFN0YXR1c0xhYmVsKGdvYWwuc3RhdHVzKTtcbiAgY29uc3QgYnVkZ2V0ID0gZ29hbC50b2tlbkJ1ZGdldCA9PSBudWxsXG4gICAgPyBgJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbnNVc2VkKX0gdG9rZW5zYFxuICAgIDogYCR7Zm9ybWF0TnVtYmVyKGdvYWwudG9rZW5zVXNlZCl9IC8gJHtmb3JtYXROdW1iZXIoZ29hbC50b2tlbkJ1ZGdldCl9IHRva2Vuc2A7XG4gIHJlbmRlclBhbmVsKHtcbiAgICB0aXRsZTogYEdvYWwgJHtzdGF0dXN9YCxcbiAgICBkZXRhaWw6IGdvYWwub2JqZWN0aXZlLFxuICAgIGZvb3RlcjogYCR7YnVkZ2V0fSAtICR7Zm9ybWF0RHVyYXRpb24oZ29hbC50aW1lVXNlZFNlY29uZHMpfWAsXG4gICAgYWN0aW9uczogW1xuICAgICAgZ29hbC5zdGF0dXMgPT09IFwicGF1c2VkXCJcbiAgICAgICAgPyB7IGxhYmVsOiBcIlJlc3VtZVwiLCBraW5kOiBcInByaW1hcnlcIiwgcnVuOiAoKSA9PiB1cGRhdGVHb2FsU3RhdHVzKFwiYWN0aXZlXCIpIH1cbiAgICAgICAgOiB7IGxhYmVsOiBcIlBhdXNlXCIsIHJ1bjogKCkgPT4gdXBkYXRlR29hbFN0YXR1cyhcInBhdXNlZFwiKSB9LFxuICAgICAgeyBsYWJlbDogXCJDb21wbGV0ZVwiLCBydW46ICgpID0+IHVwZGF0ZUdvYWxTdGF0dXMoXCJjb21wbGV0ZVwiKSB9LFxuICAgICAgeyBsYWJlbDogXCJDbGVhclwiLCBraW5kOiBcImRhbmdlclwiLCBydW46ICgpID0+IGNsZWFyQ3VycmVudEdvYWwoKSB9LFxuICAgIF0sXG4gICAgcGVyc2lzdGVudDogIW9wdGlvbnMudHJhbnNpZW50LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyTm90aWNlKHRpdGxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogdm9pZCB7XG4gIHJlbmRlclBhbmVsKHsgdGl0bGUsIGRldGFpbCwgYWN0aW9uczogW10sIHBlcnNpc3RlbnQ6IGZhbHNlIH0pO1xufVxuXG5mdW5jdGlvbiByZW5kZXJFcnJvcih0aXRsZTogc3RyaW5nLCBkZXRhaWw6IHN0cmluZyk6IHZvaWQge1xuICByZW5kZXJQYW5lbCh7IHRpdGxlLCBkZXRhaWwsIGFjdGlvbnM6IFtdLCBwZXJzaXN0ZW50OiBmYWxzZSwgZXJyb3I6IHRydWUgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclBhbmVsKG9wdGlvbnM6IEdvYWxQYW5lbE9wdGlvbnMpOiB2b2lkIHtcbiAgbGFzdFBhbmVsT3B0aW9ucyA9IG9wdGlvbnM7XG4gIGNvbnN0IGVsID0gZW5zdXJlUm9vdCgpO1xuICBpZiAoaGlkZVRpbWVyKSBjbGVhclRpbWVvdXQoaGlkZVRpbWVyKTtcbiAgZWwuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWwuY2xhc3NOYW1lID0gYGNvZGV4cHAtZ29hbC1wYW5lbCR7b3B0aW9ucy5lcnJvciA/IFwiIGlzLWVycm9yXCIgOiBcIlwifSR7cGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIiBpcy1jb2xsYXBzZWRcIiA6IFwiXCJ9YDtcbiAgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihlbCk7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLWhlYWRlclwiO1xuICBoZWFkZXIuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIHN0YXJ0R29hbFBhbmVsRHJhZyk7XG4gIGhlYWRlci5hZGRFdmVudExpc3RlbmVyKFwiZGJsY2xpY2tcIiwgcmVzZXRHb2FsUGFuZWxQb3NpdGlvbik7XG5cbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC10aXRsZVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IG9wdGlvbnMudGl0bGU7XG5cbiAgY29uc3QgY29udHJvbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb250cm9scy5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1jb250cm9sc1wiO1xuXG4gIGNvbnN0IGNvbGxhcHNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29sbGFwc2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaWNvblwiO1xuICBjb2xsYXBzZS50eXBlID0gXCJidXR0b25cIjtcbiAgY29sbGFwc2UudGV4dENvbnRlbnQgPSBwYW5lbFN0YXRlLmNvbGxhcHNlZCA/IFwiK1wiIDogXCItXCI7XG4gIGNvbGxhcHNlLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgcGFuZWxTdGF0ZS5jb2xsYXBzZWQgPyBcIkV4cGFuZCBnb2FsIHBhbmVsXCIgOiBcIkNvbGxhcHNlIGdvYWwgcGFuZWxcIik7XG4gIGNvbGxhcHNlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgcGFuZWxTdGF0ZSA9IHsgLi4ucGFuZWxTdGF0ZSwgY29sbGFwc2VkOiAhcGFuZWxTdGF0ZS5jb2xsYXBzZWQgfTtcbiAgICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbiAgICBpZiAobGFzdFBhbmVsT3B0aW9ucykgcmVuZGVyUGFuZWwobGFzdFBhbmVsT3B0aW9ucyk7XG4gIH0pO1xuXG4gIGNvbnN0IGNsb3NlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY2xvc2UuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtaWNvblwiO1xuICBjbG9zZS50eXBlID0gXCJidXR0b25cIjtcbiAgY2xvc2UudGV4dENvbnRlbnQgPSBcInhcIjtcbiAgY2xvc2Uuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIkNsb3NlIGdvYWwgcGFuZWxcIik7XG4gIGNsb3NlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBoaWRlUGFuZWwoKSk7XG4gIGNvbnRyb2xzLmFwcGVuZChjb2xsYXBzZSwgY2xvc2UpO1xuICBoZWFkZXIuYXBwZW5kKHRpdGxlLCBjb250cm9scyk7XG4gIGVsLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgaWYgKHBhbmVsU3RhdGUuY29sbGFwc2VkKSB7XG4gICAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICBpZiAoIW9wdGlvbnMucGVyc2lzdGVudCkge1xuICAgICAgaGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBoaWRlUGFuZWwoKSwgOF8wMDApO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBkZXRhaWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXRhaWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtZGV0YWlsXCI7XG4gIGRldGFpbC50ZXh0Q29udGVudCA9IG9wdGlvbnMuZGV0YWlsO1xuXG4gIGVsLmFwcGVuZENoaWxkKGRldGFpbCk7XG5cbiAgaWYgKG9wdGlvbnMuZm9vdGVyKSB7XG4gICAgY29uc3QgZm9vdGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBmb290ZXIuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtZm9vdGVyXCI7XG4gICAgZm9vdGVyLnRleHRDb250ZW50ID0gb3B0aW9ucy5mb290ZXI7XG4gICAgZWwuYXBwZW5kQ2hpbGQoZm9vdGVyKTtcbiAgfVxuXG4gIGlmIChvcHRpb25zLmFjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtYWN0aW9uc1wiO1xuICAgIGZvciAoY29uc3QgYWN0aW9uIG9mIG9wdGlvbnMuYWN0aW9ucykge1xuICAgICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGFjdGlvbi5sYWJlbDtcbiAgICAgIGJ1dHRvbi5jbGFzc05hbWUgPSBgY29kZXhwcC1nb2FsLWFjdGlvbiAke2FjdGlvbi5raW5kID8/IFwiXCJ9YDtcbiAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgICBQcm9taXNlLnJlc29sdmUoYWN0aW9uLnJ1bigpKS5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICByZW5kZXJFcnJvcihcIkdvYWwgYWN0aW9uIGZhaWxlZFwiLCBmcmllbmRseUdvYWxFcnJvcihlcnJvcikpO1xuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgIH1cbiAgICBlbC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgfVxuXG4gIGVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gIGlmICghb3B0aW9ucy5wZXJzaXN0ZW50KSB7XG4gICAgaGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBoaWRlUGFuZWwoKSwgOF8wMDApO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHVwZGF0ZUdvYWxTdGF0dXMoc3RhdHVzOiBHb2FsU3RhdHVzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCkgPz8gY3VycmVudEdvYWw/LnRocmVhZElkO1xuICBpZiAoIXRocmVhZElkKSByZXR1cm47XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcmVxdWVzdEFwcFNlcnZlcjx7IGdvYWw6IFRocmVhZEdvYWwgfT4oXG4gICAgXCJ0aHJlYWQvZ29hbC9zZXRcIixcbiAgICB7IHRocmVhZElkLCBzdGF0dXMgfSxcbiAgICB7IGhvc3RJZDogcmVhZEhvc3RJZCgpIH0sXG4gICk7XG4gIGN1cnJlbnRHb2FsID0gcmVzcG9uc2UuZ29hbDtcbiAgcmVuZGVyR29hbChyZXNwb25zZS5nb2FsLCB7IHRyYW5zaWVudDogZmFsc2UgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNsZWFyQ3VycmVudEdvYWwoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHRocmVhZElkID0gcmVhZFRocmVhZElkKCkgPz8gY3VycmVudEdvYWw/LnRocmVhZElkO1xuICBpZiAoIXRocmVhZElkKSByZXR1cm47XG4gIGF3YWl0IHJlcXVlc3RBcHBTZXJ2ZXI8eyBjbGVhcmVkOiBib29sZWFuIH0+KFxuICAgIFwidGhyZWFkL2dvYWwvY2xlYXJcIixcbiAgICB7IHRocmVhZElkIH0sXG4gICAgeyBob3N0SWQ6IHJlYWRIb3N0SWQoKSB9LFxuICApO1xuICBjdXJyZW50R29hbCA9IG51bGw7XG4gIHJlbmRlck5vdGljZShcIkdvYWwgY2xlYXJlZFwiLCBcIlRoaXMgdGhyZWFkIG5vIGxvbmdlciBoYXMgYW4gYWN0aXZlIGdvYWwuXCIpO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVSb290KCk6IEhUTUxEaXZFbGVtZW50IHtcbiAgaWYgKHJvb3Q/LmlzQ29ubmVjdGVkKSByZXR1cm4gcm9vdDtcbiAgcm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvb3QuaWQgPSBcImNvZGV4cHAtZ29hbC1yb290XCI7XG4gIHJvb3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5ib2R5IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKHBhcmVudCkgcGFyZW50LmFwcGVuZENoaWxkKHJvb3QpO1xuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gaGlkZVBhbmVsKCk6IHZvaWQge1xuICBpZiAoaGlkZVRpbWVyKSB7XG4gICAgY2xlYXJUaW1lb3V0KGhpZGVUaW1lcik7XG4gICAgaGlkZVRpbWVyID0gbnVsbDtcbiAgfVxuICBpZiAocm9vdCkgcm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbmZ1bmN0aW9uIHN0YXJ0R29hbFBhbmVsRHJhZyhldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChldmVudC5idXR0b24gIT09IDApIHJldHVybjtcbiAgaWYgKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgJiYgZXZlbnQudGFyZ2V0LmNsb3Nlc3QoXCJidXR0b25cIikpIHJldHVybjtcbiAgaWYgKCFyb290KSByZXR1cm47XG4gIGNvbnN0IHJlY3QgPSByb290LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBwYW5lbERyYWcgPSB7XG4gICAgcG9pbnRlcklkOiBldmVudC5wb2ludGVySWQsXG4gICAgb2Zmc2V0WDogZXZlbnQuY2xpZW50WCAtIHJlY3QubGVmdCxcbiAgICBvZmZzZXRZOiBldmVudC5jbGllbnRZIC0gcmVjdC50b3AsXG4gICAgd2lkdGg6IHJlY3Qud2lkdGgsXG4gICAgaGVpZ2h0OiByZWN0LmhlaWdodCxcbiAgfTtcbiAgcm9vdC5jbGFzc0xpc3QuYWRkKFwiaXMtZHJhZ2dpbmdcIik7XG4gIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgbW92ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxEcmFnKTtcbn1cblxuZnVuY3Rpb24gbW92ZUdvYWxQYW5lbChldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmICghcGFuZWxEcmFnIHx8IGV2ZW50LnBvaW50ZXJJZCAhPT0gcGFuZWxEcmFnLnBvaW50ZXJJZCB8fCAhcm9vdCkgcmV0dXJuO1xuICBwYW5lbFN0YXRlID0ge1xuICAgIC4uLnBhbmVsU3RhdGUsXG4gICAgeDogY2xhbXAoZXZlbnQuY2xpZW50WCAtIHBhbmVsRHJhZy5vZmZzZXRYLCA4LCB3aW5kb3cuaW5uZXJXaWR0aCAtIHBhbmVsRHJhZy53aWR0aCAtIDgpLFxuICAgIHk6IGNsYW1wKGV2ZW50LmNsaWVudFkgLSBwYW5lbERyYWcub2Zmc2V0WSwgOCwgd2luZG93LmlubmVySGVpZ2h0IC0gcGFuZWxEcmFnLmhlaWdodCAtIDgpLFxuICB9O1xuICBhcHBseUdvYWxQYW5lbFBvc2l0aW9uKHJvb3QpO1xufVxuXG5mdW5jdGlvbiBzdG9wR29hbFBhbmVsRHJhZyhldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCB7XG4gIGlmIChwYW5lbERyYWcgJiYgZXZlbnQucG9pbnRlcklkICE9PSBwYW5lbERyYWcucG9pbnRlcklkKSByZXR1cm47XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcm1vdmVcIiwgbW92ZUdvYWxQYW5lbCk7XG4gIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcnVwXCIsIHN0b3BHb2FsUGFuZWxEcmFnKTtcbiAgaWYgKHJvb3QpIHJvb3QuY2xhc3NMaXN0LnJlbW92ZShcImlzLWRyYWdnaW5nXCIpO1xuICBwYW5lbERyYWcgPSBudWxsO1xuICBpZiAocm9vdCkgY2xhbXBHb2FsUGFuZWxUb1ZpZXdwb3J0KHJvb3QpO1xuICBzYXZlR29hbFBhbmVsU3RhdGUoKTtcbn1cblxuZnVuY3Rpb24gcmVzZXRHb2FsUGFuZWxQb3NpdGlvbihldmVudDogTW91c2VFdmVudCk6IHZvaWQge1xuICBpZiAoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCAmJiBldmVudC50YXJnZXQuY2xvc2VzdChcImJ1dHRvblwiKSkgcmV0dXJuO1xuICBwYW5lbFN0YXRlID0geyAuLi5wYW5lbFN0YXRlLCB4OiBudWxsLCB5OiBudWxsIH07XG4gIHNhdmVHb2FsUGFuZWxTdGF0ZSgpO1xuICBpZiAocm9vdCkgYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihyb290KTtcbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsUGFuZWxQb3NpdGlvbihlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkge1xuICAgIGVsZW1lbnQuc3R5bGUubGVmdCA9IFwiYXV0b1wiO1xuICAgIGVsZW1lbnQuc3R5bGUudG9wID0gXCJhdXRvXCI7XG4gICAgZWxlbWVudC5zdHlsZS5yaWdodCA9IFwiMThweFwiO1xuICAgIGVsZW1lbnQuc3R5bGUuYm90dG9tID0gXCI3NnB4XCI7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChlbGVtZW50KTtcbiAgZWxlbWVudC5zdHlsZS5yaWdodCA9IFwiYXV0b1wiO1xuICBlbGVtZW50LnN0eWxlLmJvdHRvbSA9IFwiYXV0b1wiO1xuICBlbGVtZW50LnN0eWxlLmxlZnQgPSBgJHtwYW5lbFN0YXRlLnh9cHhgO1xuICBlbGVtZW50LnN0eWxlLnRvcCA9IGAke3BhbmVsU3RhdGUueX1weGA7XG59XG5cbmZ1bmN0aW9uIGNsYW1wR29hbFBhbmVsVG9WaWV3cG9ydChlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAocGFuZWxTdGF0ZS54ID09PSBudWxsIHx8IHBhbmVsU3RhdGUueSA9PT0gbnVsbCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgcGFuZWxTdGF0ZSA9IHtcbiAgICAuLi5wYW5lbFN0YXRlLFxuICAgIHg6IGNsYW1wKHBhbmVsU3RhdGUueCwgOCwgd2luZG93LmlubmVyV2lkdGggLSByZWN0LndpZHRoIC0gOCksXG4gICAgeTogY2xhbXAocGFuZWxTdGF0ZS55LCA4LCB3aW5kb3cuaW5uZXJIZWlnaHQgLSByZWN0LmhlaWdodCAtIDgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZWFkR29hbFBhbmVsU3RhdGUoKTogR29hbFBhbmVsU3RhdGUge1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oR09BTF9QQU5FTF9TVEFURV9LRVkpID8/IFwie31cIikgYXMgUGFydGlhbDxHb2FsUGFuZWxTdGF0ZT47XG4gICAgcmV0dXJuIHtcbiAgICAgIGNvbGxhcHNlZDogcGFyc2VkLmNvbGxhcHNlZCA9PT0gdHJ1ZSxcbiAgICAgIHg6IHR5cGVvZiBwYXJzZWQueCA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkLngpID8gcGFyc2VkLnggOiBudWxsLFxuICAgICAgeTogdHlwZW9mIHBhcnNlZC55ID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShwYXJzZWQueSkgPyBwYXJzZWQueSA6IG51bGwsXG4gICAgfTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHsgY29sbGFwc2VkOiBmYWxzZSwgeDogbnVsbCwgeTogbnVsbCB9O1xuICB9XG59XG5cbmZ1bmN0aW9uIHNhdmVHb2FsUGFuZWxTdGF0ZSgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShHT0FMX1BBTkVMX1NUQVRFX0tFWSwgSlNPTi5zdHJpbmdpZnkocGFuZWxTdGF0ZSkpO1xuICB9IGNhdGNoIHt9XG59XG5cbmZ1bmN0aW9uIGNsYW1wKHZhbHVlOiBudW1iZXIsIG1pbjogbnVtYmVyLCBtYXg6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChtYXggPCBtaW4pIHJldHVybiBtaW47XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heCh2YWx1ZSwgbWluKSwgbWF4KTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlU3VnZ2VzdGlvblJvb3QoKTogSFRNTERpdkVsZW1lbnQgfCBudWxsIHtcbiAgaWYgKHN1Z2dlc3Rpb25Sb290Py5pc0Nvbm5lY3RlZCkgcmV0dXJuIHN1Z2dlc3Rpb25Sb290O1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5ib2R5IHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKCFwYXJlbnQpIHJldHVybiBudWxsO1xuICBzdWdnZXN0aW9uUm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN1Z2dlc3Rpb25Sb290LmlkID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1yb290XCI7XG4gIHN1Z2dlc3Rpb25Sb290LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgcGFyZW50LmFwcGVuZENoaWxkKHN1Z2dlc3Rpb25Sb290KTtcbiAgcmV0dXJuIHN1Z2dlc3Rpb25Sb290O1xufVxuXG5mdW5jdGlvbiB1cGRhdGVHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQgfCBudWxsKTogdm9pZCB7XG4gIGlmICghZWRpdGFibGUpIHtcbiAgICBoaWRlR29hbFN1Z2dlc3Rpb24oKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc3VnZ2VzdGlvbiA9IHBhcnNlR29hbFN1Z2dlc3Rpb24oZWRpdGFibGUuZ2V0VGV4dCgpKTtcbiAgaWYgKCFzdWdnZXN0aW9uKSB7XG4gICAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJlbmRlckdvYWxTdWdnZXN0aW9uKGVkaXRhYmxlLCBzdWdnZXN0aW9uLnF1ZXJ5KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyR29hbFN1Z2dlc3Rpb24oZWRpdGFibGU6IEVkaXRhYmxlVGFyZ2V0LCBxdWVyeTogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGVsID0gZW5zdXJlU3VnZ2VzdGlvblJvb3QoKTtcbiAgaWYgKCFlbCkgcmV0dXJuO1xuICBjb25zdCByZWN0ID0gZWRpdGFibGUuZWxlbWVudC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbig0MjAsIE1hdGgubWF4KDI4MCwgcmVjdC53aWR0aCB8fCAzMjApKTtcbiAgY29uc3QgbGVmdCA9IE1hdGgubWF4KDEyLCBNYXRoLm1pbihyZWN0LmxlZnQsIHdpbmRvdy5pbm5lcldpZHRoIC0gd2lkdGggLSAxMikpO1xuICBjb25zdCB0b3AgPSBNYXRoLm1heCgxMiwgcmVjdC50b3AgLSA2Nik7XG5cbiAgZWwuaW5uZXJIVE1MID0gXCJcIjtcbiAgZWwuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvblwiO1xuICBlbC5zdHlsZS5sZWZ0ID0gYCR7bGVmdH1weGA7XG4gIGVsLnN0eWxlLnRvcCA9IGAke3RvcH1weGA7XG4gIGVsLnN0eWxlLndpZHRoID0gYCR7d2lkdGh9cHhgO1xuXG4gIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBpdGVtLnR5cGUgPSBcImJ1dHRvblwiO1xuICBpdGVtLmNsYXNzTmFtZSA9IFwiY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbVwiO1xuICBpdGVtLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJHb2FsIGNvbW1hbmRcIik7XG4gIGl0ZW0uYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlZG93blwiLCAoZXZlbnQpID0+IHtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFwcGx5R29hbFN1Z2dlc3Rpb24oZWRpdGFibGUpO1xuICB9KTtcblxuICBjb25zdCBjb21tYW5kID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbW1hbmQuY2xhc3NOYW1lID0gXCJjb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1jb21tYW5kXCI7XG4gIGNvbW1hbmQudGV4dENvbnRlbnQgPSBcIi9nb2FsXCI7XG4gIGlmIChxdWVyeSkge1xuICAgIGNvbW1hbmQuZGF0YXNldC5xdWVyeSA9IHF1ZXJ5O1xuICB9XG5cbiAgY29uc3QgZGV0YWlsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGRldGFpbC5jbGFzc05hbWUgPSBcImNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWRldGFpbFwiO1xuICBkZXRhaWwudGV4dENvbnRlbnQgPSBcIlNldCwgdmlldywgcGF1c2UsIHJlc3VtZSwgY29tcGxldGUsIG9yIGNsZWFyIHRoaXMgdGhyZWFkIGdvYWxcIjtcblxuICBpdGVtLmFwcGVuZChjb21tYW5kLCBkZXRhaWwpO1xuICBlbC5hcHBlbmRDaGlsZChpdGVtKTtcbiAgZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbn1cblxuZnVuY3Rpb24gYXBwbHlHb2FsU3VnZ2VzdGlvbihlZGl0YWJsZTogRWRpdGFibGVUYXJnZXQpOiB2b2lkIHtcbiAgZWRpdGFibGUuc2V0VGV4dChcIi9nb2FsIFwiKTtcbiAgaGlkZUdvYWxTdWdnZXN0aW9uKCk7XG59XG5cbmZ1bmN0aW9uIGhpZGVHb2FsU3VnZ2VzdGlvbigpOiB2b2lkIHtcbiAgaWYgKHN1Z2dlc3Rpb25Sb290KSBzdWdnZXN0aW9uUm9vdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxTdHlsZXMoKTogdm9pZCB7XG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImNvZGV4cHAtZ29hbC1zdHlsZVwiKSkgcmV0dXJuO1xuICBjb25zdCBwYXJlbnQgPSBkb2N1bWVudC5oZWFkIHx8IGRvY3VtZW50LmRvY3VtZW50RWxlbWVudDtcbiAgaWYgKCFwYXJlbnQpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCAoKSA9PiBpbnN0YWxsU3R5bGVzKCksIHsgb25jZTogdHJ1ZSB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzdHlsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHlsZVwiKTtcbiAgc3R5bGUuaWQgPSBcImNvZGV4cHAtZ29hbC1zdHlsZVwiO1xuICBzdHlsZS50ZXh0Q29udGVudCA9IGBcbiNjb2RleHBwLWdvYWwtcm9vdCB7XG4gIHBvc2l0aW9uOiBmaXhlZDtcbiAgcmlnaHQ6IDE4cHg7XG4gIGJvdHRvbTogNzZweDtcbiAgei1pbmRleDogMjE0NzQ4MzY0NztcbiAgd2lkdGg6IG1pbig0MjBweCwgY2FsYygxMDB2dyAtIDM2cHgpKTtcbiAgZm9udDogMTNweC8xLjQgLWFwcGxlLXN5c3RlbSwgQmxpbmtNYWNTeXN0ZW1Gb250LCBcIlNlZ29lIFVJXCIsIHNhbnMtc2VyaWY7XG4gIGNvbG9yOiB2YXIoLS10ZXh0LXByaW1hcnksICNmNWY3ZmIpO1xufVxuI2NvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLXJvb3Qge1xuICBwb3NpdGlvbjogZml4ZWQ7XG4gIHotaW5kZXg6IDIxNDc0ODM2NDc7XG4gIGZvbnQ6IDEzcHgvMS4zNSAtYXBwbGUtc3lzdGVtLCBCbGlua01hY1N5c3RlbUZvbnQsIFwiU2Vnb2UgVUlcIiwgc2Fucy1zZXJpZjtcbiAgY29sb3I6IHZhcigtLXRleHQtcHJpbWFyeSwgI2Y1ZjdmYik7XG59XG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24ge1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xuICBib3JkZXItcmFkaXVzOiA4cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjQsIDI3LCAzMywgMC45OCk7XG4gIGJveC1zaGFkb3c6IDAgMTZweCA0NnB4IHJnYmEoMCwwLDAsMC4zMik7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIGJhY2tkcm9wLWZpbHRlcjogYmx1cigxNHB4KTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1pdGVtIHtcbiAgd2lkdGg6IDEwMCU7XG4gIGJvcmRlcjogMDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBkaXNwbGF5OiBncmlkO1xuICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IGF1dG8gMWZyO1xuICBnYXA6IDEycHg7XG4gIGFsaWduLWl0ZW1zOiBjZW50ZXI7XG4gIHBhZGRpbmc6IDEwcHggMTJweDtcbiAgdGV4dC1hbGlnbjogbGVmdDtcbiAgY3Vyc29yOiBwb2ludGVyO1xufVxuLmNvZGV4cHAtZ29hbC1zdWdnZXN0aW9uLWl0ZW06aG92ZXIsXG4uY29kZXhwcC1nb2FsLXN1Z2dlc3Rpb24taXRlbTpmb2N1cy12aXNpYmxlIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjA5KTtcbiAgb3V0bGluZTogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1jb21tYW5kIHtcbiAgZm9udC1mYW1pbHk6IHVpLW1vbm9zcGFjZSwgU0ZNb25vLVJlZ3VsYXIsIFwiU0YgTW9ub1wiLCBNZW5sbywgbW9ub3NwYWNlO1xuICBmb250LXdlaWdodDogNjUwO1xuICBjb2xvcjogIzlmYzVmZjtcbn1cbi5jb2RleHBwLWdvYWwtc3VnZ2VzdGlvbi1kZXRhaWwge1xuICBtaW4td2lkdGg6IDA7XG4gIG92ZXJmbG93OiBoaWRkZW47XG4gIHRleHQtb3ZlcmZsb3c6IGVsbGlwc2lzO1xuICB3aGl0ZS1zcGFjZTogbm93cmFwO1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjcyKTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwge1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTYpO1xuICBib3JkZXItcmFkaXVzOiA4cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjYsIDI5LCAzNSwgMC45Nik7XG4gIGJveC1zaGFkb3c6IDAgMThweCA2MHB4IHJnYmEoMCwwLDAsMC4zNCk7XG4gIHBhZGRpbmc6IDEycHg7XG4gIGJhY2tkcm9wLWZpbHRlcjogYmx1cigxNHB4KTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtZHJhZ2dpbmcge1xuICBjdXJzb3I6IGdyYWJiaW5nO1xuICB1c2VyLXNlbGVjdDogbm9uZTtcbn1cbi5jb2RleHBwLWdvYWwtcGFuZWwuaXMtY29sbGFwc2VkIHtcbiAgd2lkdGg6IG1pbigzMjBweCwgY2FsYygxMDB2dyAtIDM2cHgpKTtcbiAgcGFkZGluZzogMTBweCAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1wYW5lbC5pcy1lcnJvciB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgyNTUsIDEyMiwgMTIyLCAwLjU1KTtcbn1cbi5jb2RleHBwLWdvYWwtaGVhZGVyIHtcbiAgZGlzcGxheTogZmxleDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAganVzdGlmeS1jb250ZW50OiBzcGFjZS1iZXR3ZWVuO1xuICBnYXA6IDEycHg7XG4gIGZvbnQtd2VpZ2h0OiA2NTA7XG4gIGN1cnNvcjogZ3JhYjtcbiAgdXNlci1zZWxlY3Q6IG5vbmU7XG59XG4uY29kZXhwcC1nb2FsLXRpdGxlIHtcbiAgbWluLXdpZHRoOiAwO1xuICBvdmVyZmxvdzogaGlkZGVuO1xuICB0ZXh0LW92ZXJmbG93OiBlbGxpcHNpcztcbiAgd2hpdGUtc3BhY2U6IG5vd3JhcDtcbn1cbi5jb2RleHBwLWdvYWwtY29udHJvbHMge1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LXNocmluazogMDtcbiAgYWxpZ24taXRlbXM6IGNlbnRlcjtcbiAgZ2FwOiA0cHg7XG59XG4uY29kZXhwcC1nb2FsLWljb24ge1xuICB3aWR0aDogMjRweDtcbiAgaGVpZ2h0OiAyNHB4O1xuICBib3JkZXI6IDA7XG4gIGJvcmRlci1yYWRpdXM6IDZweDtcbiAgYmFja2dyb3VuZDogdHJhbnNwYXJlbnQ7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBjdXJzb3I6IHBvaW50ZXI7XG4gIGxpbmUtaGVpZ2h0OiAxO1xufVxuLmNvZGV4cHAtZ29hbC1pY29uOmhvdmVyIHtcbiAgYmFja2dyb3VuZDogcmdiYSgyNTUsMjU1LDI1NSwwLjEpO1xufVxuLmNvZGV4cHAtZ29hbC1kZXRhaWwge1xuICBtYXJnaW4tdG9wOiA4cHg7XG4gIG1heC1oZWlnaHQ6IDk2cHg7XG4gIG92ZXJmbG93OiBhdXRvO1xuICBjb2xvcjogcmdiYSgyNDUsMjQ3LDI1MSwwLjkpO1xuICB3b3JkLWJyZWFrOiBicmVhay13b3JkO1xufVxuLmNvZGV4cHAtZ29hbC1mb290ZXIge1xuICBtYXJnaW4tdG9wOiA4cHg7XG4gIGNvbG9yOiByZ2JhKDI0NSwyNDcsMjUxLDAuNjIpO1xuICBmb250LXNpemU6IDEycHg7XG59XG4uY29kZXhwcC1nb2FsLWFjdGlvbnMge1xuICBkaXNwbGF5OiBmbGV4O1xuICBmbGV4LXdyYXA6IHdyYXA7XG4gIGdhcDogOHB4O1xuICBtYXJnaW4tdG9wOiAxMnB4O1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24ge1xuICBtaW4taGVpZ2h0OiAyOHB4O1xuICBib3JkZXI6IDFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xuICBib3JkZXItcmFkaXVzOiA3cHg7XG4gIGJhY2tncm91bmQ6IHJnYmEoMjU1LDI1NSwyNTUsMC4wOCk7XG4gIGNvbG9yOiBpbmhlcml0O1xuICBwYWRkaW5nOiA0cHggMTBweDtcbiAgY3Vyc29yOiBwb2ludGVyO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb246aG92ZXIge1xuICBiYWNrZ3JvdW5kOiByZ2JhKDI1NSwyNTUsMjU1LDAuMTQpO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24ucHJpbWFyeSB7XG4gIGJvcmRlci1jb2xvcjogcmdiYSgxMjUsIDE4MCwgMjU1LCAwLjU1KTtcbiAgYmFja2dyb3VuZDogcmdiYSg3NCwgMTIxLCAyMTYsIDAuNDIpO1xufVxuLmNvZGV4cHAtZ29hbC1hY3Rpb24uZGFuZ2VyIHtcbiAgYm9yZGVyLWNvbG9yOiByZ2JhKDI1NSwgMTIyLCAxMjIsIDAuNDgpO1xufVxuYDtcbiAgcGFyZW50LmFwcGVuZENoaWxkKHN0eWxlKTtcbn1cblxuZnVuY3Rpb24gZmluZEVkaXRhYmxlVGFyZ2V0KGV2ZW50OiBFdmVudCk6IEVkaXRhYmxlVGFyZ2V0IHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSB0eXBlb2YgZXZlbnQuY29tcG9zZWRQYXRoID09PSBcImZ1bmN0aW9uXCIgPyBldmVudC5jb21wb3NlZFBhdGgoKSA6IFtdO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgcGF0aCkge1xuICAgIGlmICghKGl0ZW0gaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGVkaXRhYmxlID0gZWRpdGFibGVGb3JFbGVtZW50KGl0ZW0pO1xuICAgIGlmIChlZGl0YWJsZSkgcmV0dXJuIGVkaXRhYmxlO1xuICB9XG4gIHJldHVybiBldmVudC50YXJnZXQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IGVkaXRhYmxlRm9yRWxlbWVudChldmVudC50YXJnZXQpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gZWRpdGFibGVGb3JFbGVtZW50KGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogRWRpdGFibGVUYXJnZXQgfCBudWxsIHtcbiAgaWYgKGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MVGV4dEFyZWFFbGVtZW50IHx8IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50KSB7XG4gICAgY29uc3QgdHlwZSA9IGVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MSW5wdXRFbGVtZW50ID8gZWxlbWVudC50eXBlIDogXCJ0ZXh0YXJlYVwiO1xuICAgIGlmICghW1widGV4dFwiLCBcInNlYXJjaFwiLCBcInRleHRhcmVhXCJdLmluY2x1ZGVzKHR5cGUpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4ge1xuICAgICAgZWxlbWVudCxcbiAgICAgIGdldFRleHQ6ICgpID0+IGVsZW1lbnQudmFsdWUsXG4gICAgICBzZXRUZXh0OiAodmFsdWUpID0+IHtcbiAgICAgICAgZWxlbWVudC52YWx1ZSA9IHZhbHVlO1xuICAgICAgICBlbGVtZW50LmZvY3VzKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgZWxlbWVudC5zZXRTZWxlY3Rpb25SYW5nZSh2YWx1ZS5sZW5ndGgsIHZhbHVlLmxlbmd0aCk7XG4gICAgICAgIH0gY2F0Y2gge31cbiAgICAgICAgZWxlbWVudC5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiaW5zZXJ0VGV4dFwiLCBkYXRhOiB2YWx1ZSB9KSk7XG4gICAgICB9LFxuICAgICAgY2xlYXI6ICgpID0+IHtcbiAgICAgICAgZWxlbWVudC52YWx1ZSA9IFwiXCI7XG4gICAgICAgIGVsZW1lbnQuZGlzcGF0Y2hFdmVudChuZXcgSW5wdXRFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSwgaW5wdXRUeXBlOiBcImRlbGV0ZUNvbnRlbnRCYWNrd2FyZFwiIH0pKTtcbiAgICAgIH0sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGVkaXRhYmxlID0gZWxlbWVudC5pc0NvbnRlbnRFZGl0YWJsZVxuICAgID8gZWxlbWVudFxuICAgIDogZWxlbWVudC5jbG9zZXN0PEhUTUxFbGVtZW50PignW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0sIFtyb2xlPVwidGV4dGJveFwiXScpO1xuICBpZiAoIWVkaXRhYmxlKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICBlbGVtZW50OiBlZGl0YWJsZSxcbiAgICBnZXRUZXh0OiAoKSA9PiBlZGl0YWJsZS5pbm5lclRleHQgfHwgZWRpdGFibGUudGV4dENvbnRlbnQgfHwgXCJcIixcbiAgICBzZXRUZXh0OiAodmFsdWUpID0+IHtcbiAgICAgIGVkaXRhYmxlLnRleHRDb250ZW50ID0gdmFsdWU7XG4gICAgICBlZGl0YWJsZS5mb2N1cygpO1xuICAgICAgcGxhY2VDYXJldEF0RW5kKGVkaXRhYmxlKTtcbiAgICAgIGVkaXRhYmxlLmRpc3BhdGNoRXZlbnQobmV3IElucHV0RXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUsIGlucHV0VHlwZTogXCJpbnNlcnRUZXh0XCIsIGRhdGE6IHZhbHVlIH0pKTtcbiAgICB9LFxuICAgIGNsZWFyOiAoKSA9PiB7XG4gICAgICBlZGl0YWJsZS50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBlZGl0YWJsZS5kaXNwYXRjaEV2ZW50KG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiZGVsZXRlQ29udGVudEJhY2t3YXJkXCIgfSkpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHBsYWNlQ2FyZXRBdEVuZChlbGVtZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBzZWxlY3Rpb24gPSB3aW5kb3cuZ2V0U2VsZWN0aW9uKCk7XG4gIGlmICghc2VsZWN0aW9uKSByZXR1cm47XG4gIGNvbnN0IHJhbmdlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTtcbiAgcmFuZ2Uuc2VsZWN0Tm9kZUNvbnRlbnRzKGVsZW1lbnQpO1xuICByYW5nZS5jb2xsYXBzZShmYWxzZSk7XG4gIHNlbGVjdGlvbi5yZW1vdmVBbGxSYW5nZXMoKTtcbiAgc2VsZWN0aW9uLmFkZFJhbmdlKHJhbmdlKTtcbn1cblxuZnVuY3Rpb24gcmVhZFRocmVhZElkKCk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtsb2NhdGlvbi5wYXRobmFtZSwgbG9jYXRpb24uaGFzaCwgbG9jYXRpb24uaHJlZl07XG4gIHRyeSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChsb2NhdGlvbi5ocmVmKTtcbiAgICBjb25zdCBpbml0aWFsUm91dGUgPSB1cmwuc2VhcmNoUGFyYW1zLmdldChcImluaXRpYWxSb3V0ZVwiKTtcbiAgICBpZiAoaW5pdGlhbFJvdXRlKSBjYW5kaWRhdGVzLnB1c2goaW5pdGlhbFJvdXRlKTtcbiAgfSBjYXRjaCB7fVxuICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyhoaXN0b3J5LnN0YXRlKSk7XG4gIGNhbmRpZGF0ZXMucHVzaCguLi5jb2xsZWN0RG9tVGhyZWFkQ2FuZGlkYXRlcygpKTtcblxuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgdGhyZWFkSWQgPSBub3JtYWxpemVUaHJlYWRJZChjYW5kaWRhdGUpO1xuICAgIGlmICh0aHJlYWRJZCkgcmV0dXJuIHRocmVhZElkO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUaHJlYWRJZCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGRlY29kZWQgPSBzYWZlRGVjb2RlKHZhbHVlKS50cmltKCk7XG4gIGNvbnN0IHJvdXRlTWF0Y2ggPSBkZWNvZGVkLm1hdGNoKC9cXC9sb2NhbFxcLyhbXi8/I1xcc10rKS8pO1xuICBpZiAocm91dGVNYXRjaD8uWzFdKSB7XG4gICAgY29uc3QgZnJvbVJvdXRlID0gbm9ybWFsaXplVGhyZWFkSWRUb2tlbihyb3V0ZU1hdGNoWzFdKTtcbiAgICBpZiAoZnJvbVJvdXRlKSByZXR1cm4gZnJvbVJvdXRlO1xuICB9XG5cbiAgY29uc3QgdG9rZW5NYXRjaCA9IGRlY29kZWQubWF0Y2goL1xcYig/OlthLXpdW1xcdy4tXSo6KSooWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9KVxcYi9pKTtcbiAgaWYgKHRva2VuTWF0Y2g/LlsxXSkgcmV0dXJuIHRva2VuTWF0Y2hbMV07XG5cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVRocmVhZElkVG9rZW4odmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBkZWNvZGVkID0gc2FmZURlY29kZSh2YWx1ZSkudHJpbSgpO1xuICBjb25zdCBtYXRjaCA9IGRlY29kZWQubWF0Y2goLyg/Ol58OikoWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9KSQvaSk7XG4gIHJldHVybiBtYXRjaD8uWzFdID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGNvbGxlY3REb21UaHJlYWRDYW5kaWRhdGVzKCk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc2VsZWN0b3JzID0gW1xuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLXJvd11bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT1cInRydWVcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtcm93XVthcmlhLWN1cnJlbnQ9XCJwYWdlXCJdW2RhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXRocmVhZC1pZF0nLFxuICAgICdbZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWFjdGl2ZT1cInRydWVcIl1bZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItdGhyZWFkLWlkXScsXG4gICAgJ1tkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRdW2FyaWEtY3VycmVudD1cInBhZ2VcIl0nLFxuICBdO1xuICBjb25zdCBjYW5kaWRhdGVzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIHNlbGVjdG9ycykge1xuICAgIGZvciAoY29uc3QgZWxlbWVudCBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KHNlbGVjdG9yKSkpIHtcbiAgICAgIGNvbnN0IHZhbHVlID0gZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci10aHJlYWQtaWRcIik7XG4gICAgICBpZiAodmFsdWUpIGNhbmRpZGF0ZXMucHVzaCh2YWx1ZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBjYW5kaWRhdGVzO1xufVxuXG5mdW5jdGlvbiBzYWZlRGVjb2RlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiBkZWNvZGVVUklDb21wb25lbnQodmFsdWUpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyh2YWx1ZTogdW5rbm93biwgZGVwdGggPSAwLCBzZWVuID0gbmV3IFNldDx1bmtub3duPigpKTogc3RyaW5nW10ge1xuICBpZiAoZGVwdGggPiA1IHx8IHZhbHVlID09PSBudWxsIHx8IHZhbHVlID09PSB1bmRlZmluZWQgfHwgc2Vlbi5oYXModmFsdWUpKSByZXR1cm4gW107XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIpIHJldHVybiBub3JtYWxpemVUaHJlYWRJZCh2YWx1ZSkgPyBbdmFsdWVdIDogW107XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBbXTtcbiAgc2Vlbi5hZGQodmFsdWUpO1xuXG4gIGNvbnN0IGNhbmRpZGF0ZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgT2JqZWN0LnZhbHVlcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICBjYW5kaWRhdGVzLnB1c2goLi4uY29sbGVjdFRocmVhZFJvdXRlQ2FuZGlkYXRlcyhjaGlsZCwgZGVwdGggKyAxLCBzZWVuKSk7XG4gIH1cbiAgcmV0dXJuIGNhbmRpZGF0ZXM7XG59XG5cbmZ1bmN0aW9uIGdvYWxTdGF0dXNMYWJlbChzdGF0dXM6IEdvYWxTdGF0dXMpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHN0YXR1cykge1xuICAgIGNhc2UgXCJhY3RpdmVcIjpcbiAgICAgIHJldHVybiBcImFjdGl2ZVwiO1xuICAgIGNhc2UgXCJwYXVzZWRcIjpcbiAgICAgIHJldHVybiBcInBhdXNlZFwiO1xuICAgIGNhc2UgXCJidWRnZXRMaW1pdGVkXCI6XG4gICAgICByZXR1cm4gXCJsaW1pdGVkIGJ5IGJ1ZGdldFwiO1xuICAgIGNhc2UgXCJjb21wbGV0ZVwiOlxuICAgICAgcmV0dXJuIFwiY29tcGxldGVcIjtcbiAgfVxufVxuXG5mdW5jdGlvbiBmcmllbmRseUdvYWxFcnJvcihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIGNvbnN0IG1lc3NhZ2UgPSBzdHJpbmdpZnlFcnJvcihlcnJvcik7XG4gIGlmICgvZ29hbHMgZmVhdHVyZSBpcyBkaXNhYmxlZC9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGUgYXBwLXNlcnZlciBoYXMgZ29hbCBzdXBwb3J0LCBidXQgW2ZlYXR1cmVzXS5nb2FscyBpcyBkaXNhYmxlZCBpbiB+Ly5jb2RleC9jb25maWcudG9tbC5cIjtcbiAgfVxuICBpZiAoL3JlcXVpcmVzIGV4cGVyaW1lbnRhbEFwaS9pLnRlc3QobWVzc2FnZSkpIHtcbiAgICByZXR1cm4gXCJUaGUgYXBwLXNlcnZlciByZWplY3RlZCB0aHJlYWQvZ29hbC8qIGJlY2F1c2UgdGhlIGFjdGl2ZSBEZXNrdG9wIGNsaWVudCBkaWQgbm90IG5lZ290aWF0ZSBleHBlcmltZW50YWxBcGkuXCI7XG4gIH1cbiAgaWYgKC91bmtub3dufHVuc3VwcG9ydGVkfG5vdCBmb3VuZHxubyBoYW5kbGVyfGludmFsaWQgcmVxdWVzdHxkZXNlcmlhbGl6ZXx0aHJlYWRcXC9nb2FsL2kudGVzdChtZXNzYWdlKSkge1xuICAgIHJldHVybiBcIlRoaXMgQ29kZXguYXBwIGFwcC1zZXJ2ZXIgZG9lcyBub3Qgc3VwcG9ydCB0aHJlYWQvZ29hbC8qIHlldC4gVXBkYXRlIG9yIHJlcGF0Y2ggQ29kZXguYXBwIHdpdGggYSBidWlsZCB0aGF0IGluY2x1ZGVzIHRoZSBnb2FscyBmZWF0dXJlLlwiO1xuICB9XG4gIHJldHVybiBtZXNzYWdlO1xufVxuXG5mdW5jdGlvbiBmb3JtYXREdXJhdGlvbihzZWNvbmRzOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAoIU51bWJlci5pc0Zpbml0ZShzZWNvbmRzKSB8fCBzZWNvbmRzIDw9IDApIHJldHVybiBcIjBzXCI7XG4gIGNvbnN0IG1pbnV0ZXMgPSBNYXRoLmZsb29yKHNlY29uZHMgLyA2MCk7XG4gIGNvbnN0IHJlbWFpbmluZ1NlY29uZHMgPSBNYXRoLmZsb29yKHNlY29uZHMgJSA2MCk7XG4gIGlmIChtaW51dGVzIDw9IDApIHJldHVybiBgJHtyZW1haW5pbmdTZWNvbmRzfXNgO1xuICBjb25zdCBob3VycyA9IE1hdGguZmxvb3IobWludXRlcyAvIDYwKTtcbiAgY29uc3QgcmVtYWluaW5nTWludXRlcyA9IG1pbnV0ZXMgJSA2MDtcbiAgaWYgKGhvdXJzIDw9IDApIHJldHVybiBgJHttaW51dGVzfW0gJHtyZW1haW5pbmdTZWNvbmRzfXNgO1xuICByZXR1cm4gYCR7aG91cnN9aCAke3JlbWFpbmluZ01pbnV0ZXN9bWA7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdE51bWJlcih2YWx1ZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZSh2YWx1ZSkgPyBNYXRoLnJvdW5kKHZhbHVlKS50b0xvY2FsZVN0cmluZygpIDogXCIwXCI7XG59XG5cbmZ1bmN0aW9uIHRydW5jYXRlKHZhbHVlOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLmxlbmd0aCA8PSBtYXhMZW5ndGggPyB2YWx1ZSA6IGAke3ZhbHVlLnNsaWNlKDAsIG1heExlbmd0aCAtIDEpfS4uLmA7XG59XG5cbmZ1bmN0aW9uIHN0cmluZ2lmeUVycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbn1cblxuZnVuY3Rpb24gaXNUaHJlYWRHb2FsKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgVGhyZWFkR29hbCB7XG4gIHJldHVybiBpc1JlY29yZCh2YWx1ZSkgJiZcbiAgICB0eXBlb2YgdmFsdWUudGhyZWFkSWQgPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgdmFsdWUub2JqZWN0aXZlID09PSBcInN0cmluZ1wiICYmXG4gICAgdHlwZW9mIHZhbHVlLnN0YXR1cyA9PT0gXCJzdHJpbmdcIjtcbn1cblxuZnVuY3Rpb24gaXNSZWNvcmQodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB2YWx1ZSAhPT0gbnVsbCAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBV0EsSUFBQUEsbUJBQTRCOzs7QUM2QnJCLFNBQVMsbUJBQXlCO0FBQ3ZDLE1BQUksT0FBTywrQkFBZ0M7QUFDM0MsUUFBTSxZQUFZLG9CQUFJLElBQStCO0FBQ3JELE1BQUksU0FBUztBQUNiLFFBQU0sWUFBWSxvQkFBSSxJQUE0QztBQUVsRSxRQUFNLE9BQTBCO0FBQUEsSUFDOUIsZUFBZTtBQUFBLElBQ2Y7QUFBQSxJQUNBLE9BQU8sVUFBVTtBQUNmLFlBQU0sS0FBSztBQUNYLGdCQUFVLElBQUksSUFBSSxRQUFRO0FBRTFCLGNBQVE7QUFBQSxRQUNOO0FBQUEsUUFDQSxTQUFTO0FBQUEsUUFDVCxTQUFTO0FBQUEsTUFDWDtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxHQUFHLE9BQU8sSUFBSTtBQUNaLFVBQUksSUFBSSxVQUFVLElBQUksS0FBSztBQUMzQixVQUFJLENBQUMsRUFBRyxXQUFVLElBQUksT0FBUSxJQUFJLG9CQUFJLElBQUksQ0FBRTtBQUM1QyxRQUFFLElBQUksRUFBRTtBQUFBLElBQ1Y7QUFBQSxJQUNBLElBQUksT0FBTyxJQUFJO0FBQ2IsZ0JBQVUsSUFBSSxLQUFLLEdBQUcsT0FBTyxFQUFFO0FBQUEsSUFDakM7QUFBQSxJQUNBLEtBQUssVUFBVSxNQUFNO0FBQ25CLGdCQUFVLElBQUksS0FBSyxHQUFHLFFBQVEsQ0FBQyxPQUFPLEdBQUcsR0FBRyxJQUFJLENBQUM7QUFBQSxJQUNuRDtBQUFBLElBQ0Esb0JBQW9CO0FBQUEsSUFBQztBQUFBLElBQ3JCLHVCQUF1QjtBQUFBLElBQUM7QUFBQSxJQUN4QixzQkFBc0I7QUFBQSxJQUFDO0FBQUEsSUFDdkIsV0FBVztBQUFBLElBQUM7QUFBQSxFQUNkO0FBRUEsU0FBTyxlQUFlLFFBQVEsa0NBQWtDO0FBQUEsSUFDOUQsY0FBYztBQUFBLElBQ2QsWUFBWTtBQUFBLElBQ1osVUFBVTtBQUFBO0FBQUEsSUFDVixPQUFPO0FBQUEsRUFDVCxDQUFDO0FBRUQsU0FBTyxjQUFjLEVBQUUsTUFBTSxVQUFVO0FBQ3pDO0FBR08sU0FBUyxhQUFhLE1BQTRCO0FBQ3ZELFFBQU0sWUFBWSxPQUFPLGFBQWE7QUFDdEMsTUFBSSxXQUFXO0FBQ2IsZUFBVyxLQUFLLFVBQVUsT0FBTyxHQUFHO0FBQ2xDLFlBQU0sSUFBSSxFQUFFLDBCQUEwQixJQUFJO0FBQzFDLFVBQUksRUFBRyxRQUFPO0FBQUEsSUFDaEI7QUFBQSxFQUNGO0FBR0EsYUFBVyxLQUFLLE9BQU8sS0FBSyxJQUFJLEdBQUc7QUFDakMsUUFBSSxFQUFFLFdBQVcsY0FBYyxFQUFHLFFBQVEsS0FBNEMsQ0FBQztBQUFBLEVBQ3pGO0FBQ0EsU0FBTztBQUNUOzs7QUMvRUEsc0JBQTRCO0FBMkc1QixJQUFNLFFBQXVCO0FBQUEsRUFDM0IsVUFBVSxvQkFBSSxJQUFJO0FBQUEsRUFDbEIsT0FBTyxvQkFBSSxJQUFJO0FBQUEsRUFDZixjQUFjLENBQUM7QUFBQSxFQUNmLGNBQWM7QUFBQSxFQUNkLGlCQUFpQjtBQUFBLEVBQ2pCLFVBQVU7QUFBQSxFQUNWLFlBQVk7QUFBQSxFQUNaLFlBQVk7QUFBQSxFQUNaLGVBQWU7QUFBQSxFQUNmLFdBQVc7QUFBQSxFQUNYLFVBQVU7QUFBQSxFQUNWLGFBQWE7QUFBQSxFQUNiLGVBQWU7QUFBQSxFQUNmLFlBQVk7QUFBQSxFQUNaLGFBQWE7QUFBQSxFQUNiLHVCQUF1QjtBQUFBLEVBQ3ZCLHdCQUF3QjtBQUFBLEVBQ3hCLDBCQUEwQjtBQUM1QjtBQUVBLFNBQVMsS0FBSyxLQUFhLE9BQXVCO0FBQ2hELDhCQUFZO0FBQUEsSUFDVjtBQUFBLElBQ0E7QUFBQSxJQUNBLHVCQUF1QixHQUFHLEdBQUcsVUFBVSxTQUFZLEtBQUssTUFBTSxjQUFjLEtBQUssQ0FBQztBQUFBLEVBQ3BGO0FBQ0Y7QUFDQSxTQUFTLGNBQWMsR0FBb0I7QUFDekMsTUFBSTtBQUNGLFdBQU8sT0FBTyxNQUFNLFdBQVcsSUFBSSxLQUFLLFVBQVUsQ0FBQztBQUFBLEVBQ3JELFFBQVE7QUFDTixXQUFPLE9BQU8sQ0FBQztBQUFBLEVBQ2pCO0FBQ0Y7QUFJTyxTQUFTLHdCQUE4QjtBQUM1QyxNQUFJLE1BQU0sU0FBVTtBQUVwQixRQUFNLE1BQU0sSUFBSSxpQkFBaUIsTUFBTTtBQUNyQyxjQUFVO0FBQ1YsaUJBQWE7QUFBQSxFQUNmLENBQUM7QUFDRCxNQUFJLFFBQVEsU0FBUyxpQkFBaUIsRUFBRSxXQUFXLE1BQU0sU0FBUyxLQUFLLENBQUM7QUFDeEUsUUFBTSxXQUFXO0FBRWpCLFNBQU8saUJBQWlCLFlBQVksS0FBSztBQUN6QyxTQUFPLGlCQUFpQixjQUFjLEtBQUs7QUFDM0MsV0FBUyxpQkFBaUIsU0FBUyxpQkFBaUIsSUFBSTtBQUN4RCxhQUFXLEtBQUssQ0FBQyxhQUFhLGNBQWMsR0FBWTtBQUN0RCxVQUFNLE9BQU8sUUFBUSxDQUFDO0FBQ3RCLFlBQVEsQ0FBQyxJQUFJLFlBQTRCLE1BQStCO0FBQ3RFLFlBQU0sSUFBSSxLQUFLLE1BQU0sTUFBTSxJQUFJO0FBQy9CLGFBQU8sY0FBYyxJQUFJLE1BQU0sV0FBVyxDQUFDLEVBQUUsQ0FBQztBQUM5QyxhQUFPO0FBQUEsSUFDVDtBQUNBLFdBQU8saUJBQWlCLFdBQVcsQ0FBQyxJQUFJLEtBQUs7QUFBQSxFQUMvQztBQUVBLFlBQVU7QUFDVixlQUFhO0FBQ2IsTUFBSSxRQUFRO0FBQ1osUUFBTSxXQUFXLFlBQVksTUFBTTtBQUNqQztBQUNBLGNBQVU7QUFDVixpQkFBYTtBQUNiLFFBQUksUUFBUSxHQUFJLGVBQWMsUUFBUTtBQUFBLEVBQ3hDLEdBQUcsR0FBRztBQUNSO0FBRUEsU0FBUyxRQUFjO0FBQ3JCLFFBQU0sY0FBYztBQUNwQixZQUFVO0FBQ1YsZUFBYTtBQUNmO0FBRUEsU0FBUyxnQkFBZ0IsR0FBcUI7QUFDNUMsUUFBTSxTQUFTLEVBQUUsa0JBQWtCLFVBQVUsRUFBRSxTQUFTO0FBQ3hELFFBQU0sVUFBVSxRQUFRLFFBQVEsd0JBQXdCO0FBQ3hELE1BQUksRUFBRSxtQkFBbUIsYUFBYztBQUN2QyxNQUFJLG9CQUFvQixRQUFRLGVBQWUsRUFBRSxNQUFNLGNBQWU7QUFDdEUsYUFBVyxNQUFNO0FBQ2YsOEJBQTBCLE9BQU8sYUFBYTtBQUFBLEVBQ2hELEdBQUcsQ0FBQztBQUNOO0FBRU8sU0FBUyxnQkFBZ0IsU0FBMEM7QUFDeEUsUUFBTSxTQUFTLElBQUksUUFBUSxJQUFJLE9BQU87QUFDdEMsTUFBSSxNQUFNLFlBQVksU0FBUyxTQUFVLFVBQVM7QUFDbEQsU0FBTztBQUFBLElBQ0wsWUFBWSxNQUFNO0FBQ2hCLFlBQU0sU0FBUyxPQUFPLFFBQVEsRUFBRTtBQUNoQyxVQUFJLE1BQU0sWUFBWSxTQUFTLFNBQVUsVUFBUztBQUFBLElBQ3BEO0FBQUEsRUFDRjtBQUNGO0FBRU8sU0FBUyxnQkFBc0I7QUFDcEMsUUFBTSxTQUFTLE1BQU07QUFHckIsYUFBVyxLQUFLLE1BQU0sTUFBTSxPQUFPLEdBQUc7QUFDcEMsUUFBSTtBQUNGLFFBQUUsV0FBVztBQUFBLElBQ2YsU0FBUyxHQUFHO0FBQ1YsV0FBSyx3QkFBd0IsRUFBRSxJQUFJLEVBQUUsSUFBSSxLQUFLLE9BQU8sQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUMzRDtBQUFBLEVBQ0Y7QUFDQSxRQUFNLE1BQU0sTUFBTTtBQUNsQixpQkFBZTtBQUdmLE1BQ0UsTUFBTSxZQUFZLFNBQVMsZ0JBQzNCLENBQUMsTUFBTSxNQUFNLElBQUksTUFBTSxXQUFXLEVBQUUsR0FDcEM7QUFDQSxxQkFBaUI7QUFBQSxFQUNuQixXQUFXLE1BQU0sWUFBWSxTQUFTLFVBQVU7QUFDOUMsYUFBUztBQUFBLEVBQ1g7QUFDRjtBQU9PLFNBQVMsYUFDZCxTQUNBLFVBQ0EsTUFDZ0I7QUFDaEIsUUFBTSxLQUFLLEtBQUs7QUFDaEIsUUFBTSxRQUF3QixFQUFFLElBQUksU0FBUyxVQUFVLEtBQUs7QUFDNUQsUUFBTSxNQUFNLElBQUksSUFBSSxLQUFLO0FBQ3pCLE9BQUssZ0JBQWdCLEVBQUUsSUFBSSxPQUFPLEtBQUssT0FBTyxRQUFRLENBQUM7QUFDdkQsaUJBQWU7QUFFZixNQUFJLE1BQU0sWUFBWSxTQUFTLGdCQUFnQixNQUFNLFdBQVcsT0FBTyxJQUFJO0FBQ3pFLGFBQVM7QUFBQSxFQUNYO0FBQ0EsU0FBTztBQUFBLElBQ0wsWUFBWSxNQUFNO0FBQ2hCLFlBQU0sSUFBSSxNQUFNLE1BQU0sSUFBSSxFQUFFO0FBQzVCLFVBQUksQ0FBQyxFQUFHO0FBQ1IsVUFBSTtBQUNGLFVBQUUsV0FBVztBQUFBLE1BQ2YsUUFBUTtBQUFBLE1BQUM7QUFDVCxZQUFNLE1BQU0sT0FBTyxFQUFFO0FBQ3JCLHFCQUFlO0FBQ2YsVUFBSSxNQUFNLFlBQVksU0FBUyxnQkFBZ0IsTUFBTSxXQUFXLE9BQU8sSUFBSTtBQUN6RSx5QkFBaUI7QUFBQSxNQUNuQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0Y7QUFHTyxTQUFTLGdCQUFnQixNQUEyQjtBQUN6RCxRQUFNLGVBQWU7QUFDckIsTUFBSSxNQUFNLFlBQVksU0FBUyxTQUFVLFVBQVM7QUFDcEQ7QUFJQSxTQUFTLFlBQWtCO0FBQ3pCLFFBQU0sYUFBYSxzQkFBc0I7QUFDekMsTUFBSSxDQUFDLFlBQVk7QUFDZixrQ0FBOEI7QUFDOUIsU0FBSyxtQkFBbUI7QUFDeEI7QUFBQSxFQUNGO0FBQ0EsTUFBSSxNQUFNLDBCQUEwQjtBQUNsQyxpQkFBYSxNQUFNLHdCQUF3QjtBQUMzQyxVQUFNLDJCQUEyQjtBQUFBLEVBQ25DO0FBQ0EsNEJBQTBCLE1BQU0sZUFBZTtBQUkvQyxRQUFNLFFBQVEsV0FBVyxpQkFBaUI7QUFDMUMsUUFBTSxjQUFjO0FBQ3BCLDJCQUF5QixZQUFZLEtBQUs7QUFFMUMsTUFBSSxNQUFNLFlBQVksTUFBTSxTQUFTLE1BQU0sUUFBUSxHQUFHO0FBQ3BELG1CQUFlO0FBSWYsUUFBSSxNQUFNLGVBQWUsS0FBTSwwQkFBeUIsSUFBSTtBQUM1RDtBQUFBLEVBQ0Y7QUFVQSxNQUFJLE1BQU0sZUFBZSxRQUFRLE1BQU0sY0FBYyxNQUFNO0FBQ3pELFNBQUssMERBQTBEO0FBQUEsTUFDN0QsWUFBWSxNQUFNO0FBQUEsSUFDcEIsQ0FBQztBQUNELFVBQU0sYUFBYTtBQUNuQixVQUFNLFlBQVk7QUFBQSxFQUNwQjtBQUdBLFFBQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUMxQyxRQUFNLFFBQVEsVUFBVTtBQUN4QixRQUFNLFlBQVk7QUFFbEIsUUFBTSxZQUFZLG1CQUFtQixXQUFXLE1BQU0sQ0FBQztBQUd2RCxRQUFNLFlBQVksZ0JBQWdCLFVBQVUsY0FBYyxDQUFDO0FBQzNELFFBQU0sWUFBWSxnQkFBZ0IsVUFBVSxjQUFjLENBQUM7QUFFM0QsWUFBVSxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDekMsTUFBRSxlQUFlO0FBQ2pCLE1BQUUsZ0JBQWdCO0FBQ2xCLGlCQUFhLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFBQSxFQUNqQyxDQUFDO0FBQ0QsWUFBVSxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDekMsTUFBRSxlQUFlO0FBQ2pCLE1BQUUsZ0JBQWdCO0FBQ2xCLGlCQUFhLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFBQSxFQUNqQyxDQUFDO0FBRUQsUUFBTSxZQUFZLFNBQVM7QUFDM0IsUUFBTSxZQUFZLFNBQVM7QUFDM0IsUUFBTSxZQUFZLEtBQUs7QUFFdkIsUUFBTSxXQUFXO0FBQ2pCLFFBQU0sYUFBYSxFQUFFLFFBQVEsV0FBVyxRQUFRLFVBQVU7QUFDMUQsT0FBSyxzQkFBc0IsRUFBRSxVQUFVLE1BQU0sUUFBUSxDQUFDO0FBQ3RELGlCQUFlO0FBQ2pCO0FBRUEsU0FBUyx5QkFBeUIsWUFBeUIsT0FBMEI7QUFDbkYsTUFBSSxNQUFNLG1CQUFtQixNQUFNLFNBQVMsTUFBTSxlQUFlLEVBQUc7QUFDcEUsTUFBSSxVQUFVLFdBQVk7QUFFMUIsUUFBTSxTQUFTLG1CQUFtQixTQUFTO0FBQzNDLFNBQU8sUUFBUSxVQUFVO0FBQ3pCLFFBQU0sYUFBYSxRQUFRLFVBQVU7QUFDckMsUUFBTSxrQkFBa0I7QUFDMUI7QUFFQSxTQUFTLG1CQUFtQixNQUFjLGFBQWEsUUFBcUI7QUFDMUUsUUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFNBQU8sWUFDTCxZQUFZLFVBQVU7QUFDeEIsU0FBTyxjQUFjO0FBQ3JCLFNBQU87QUFDVDtBQUVBLFNBQVMsZ0NBQXNDO0FBQzdDLE1BQUksQ0FBQyxNQUFNLDBCQUEwQixNQUFNLHlCQUEwQjtBQUNyRSxRQUFNLDJCQUEyQixXQUFXLE1BQU07QUFDaEQsVUFBTSwyQkFBMkI7QUFDakMsUUFBSSxzQkFBc0IsRUFBRztBQUM3QixRQUFJLHNCQUFzQixFQUFHO0FBQzdCLDhCQUEwQixPQUFPLG1CQUFtQjtBQUFBLEVBQ3RELEdBQUcsSUFBSTtBQUNUO0FBRUEsU0FBUyx3QkFBaUM7QUFDeEMsUUFBTSxPQUFPLG9CQUFvQixTQUFTLE1BQU0sZUFBZSxFQUFFLEVBQUUsWUFBWTtBQUMvRSxTQUNFLEtBQUssU0FBUyxhQUFhLEtBQzNCLEtBQUssU0FBUyxTQUFTLEtBQ3ZCLEtBQUssU0FBUyxZQUFZLE1BQ3pCLEtBQUssU0FBUyxlQUFlLEtBQUssS0FBSyxTQUFTLHFCQUFxQjtBQUUxRTtBQUVBLFNBQVMsb0JBQW9CLE9BQXVCO0FBQ2xELFNBQU8sT0FBTyxTQUFTLEVBQUUsRUFBRSxRQUFRLFFBQVEsR0FBRyxFQUFFLEtBQUs7QUFDdkQ7QUFFQSxTQUFTLDBCQUEwQixTQUFrQixRQUFzQjtBQUN6RSxNQUFJLE1BQU0sMkJBQTJCLFFBQVM7QUFDOUMsUUFBTSx5QkFBeUI7QUFDL0IsTUFBSTtBQUNGLElBQUMsT0FBa0Usa0NBQWtDO0FBQ3JHLGFBQVMsZ0JBQWdCLFFBQVEseUJBQXlCLFVBQVUsU0FBUztBQUM3RSxXQUFPO0FBQUEsTUFDTCxJQUFJLFlBQVksNEJBQTRCO0FBQUEsUUFDMUMsUUFBUSxFQUFFLFNBQVMsT0FBTztBQUFBLE1BQzVCLENBQUM7QUFBQSxJQUNIO0FBQUEsRUFDRixRQUFRO0FBQUEsRUFBQztBQUNULE9BQUssb0JBQW9CLEVBQUUsU0FBUyxRQUFRLEtBQUssU0FBUyxLQUFLLENBQUM7QUFDbEU7QUFPQSxTQUFTLGlCQUF1QjtBQUM5QixRQUFNLFFBQVEsTUFBTTtBQUNwQixNQUFJLENBQUMsTUFBTztBQUNaLFFBQU0sUUFBUSxDQUFDLEdBQUcsTUFBTSxNQUFNLE9BQU8sQ0FBQztBQU10QyxRQUFNLGFBQWEsTUFBTSxXQUFXLElBQ2hDLFVBQ0EsTUFBTSxJQUFJLENBQUMsTUFBTSxHQUFHLEVBQUUsRUFBRSxJQUFJLEVBQUUsS0FBSyxLQUFLLElBQUksRUFBRSxLQUFLLFdBQVcsRUFBRSxFQUFFLEVBQUUsS0FBSyxJQUFJO0FBQ2pGLFFBQU0sZ0JBQWdCLENBQUMsQ0FBQyxNQUFNLGNBQWMsTUFBTSxTQUFTLE1BQU0sVUFBVTtBQUMzRSxNQUFJLE1BQU0sa0JBQWtCLGVBQWUsTUFBTSxXQUFXLElBQUksQ0FBQyxnQkFBZ0IsZ0JBQWdCO0FBQy9GO0FBQUEsRUFDRjtBQUVBLE1BQUksTUFBTSxXQUFXLEdBQUc7QUFDdEIsUUFBSSxNQUFNLFlBQVk7QUFDcEIsWUFBTSxXQUFXLE9BQU87QUFDeEIsWUFBTSxhQUFhO0FBQUEsSUFDckI7QUFDQSxlQUFXLEtBQUssTUFBTSxNQUFNLE9BQU8sRUFBRyxHQUFFLFlBQVk7QUFDcEQsVUFBTSxnQkFBZ0I7QUFDdEI7QUFBQSxFQUNGO0FBRUEsTUFBSSxRQUFRLE1BQU07QUFDbEIsTUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLFNBQVMsS0FBSyxHQUFHO0FBQ3BDLFlBQVEsU0FBUyxjQUFjLEtBQUs7QUFDcEMsVUFBTSxRQUFRLFVBQVU7QUFDeEIsVUFBTSxZQUFZO0FBQ2xCLFVBQU0sWUFBWSxtQkFBbUIsVUFBVSxNQUFNLENBQUM7QUFDdEQsVUFBTSxZQUFZLEtBQUs7QUFDdkIsVUFBTSxhQUFhO0FBQUEsRUFDckIsT0FBTztBQUVMLFdBQU8sTUFBTSxTQUFTLFNBQVMsRUFBRyxPQUFNLFlBQVksTUFBTSxTQUFVO0FBQUEsRUFDdEU7QUFFQSxhQUFXLEtBQUssT0FBTztBQUNyQixVQUFNLE9BQU8sRUFBRSxLQUFLLFdBQVcsbUJBQW1CO0FBQ2xELFVBQU0sTUFBTSxnQkFBZ0IsRUFBRSxLQUFLLE9BQU8sSUFBSTtBQUM5QyxRQUFJLFFBQVEsVUFBVSxZQUFZLEVBQUUsRUFBRTtBQUN0QyxRQUFJLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUNuQyxRQUFFLGVBQWU7QUFDakIsUUFBRSxnQkFBZ0I7QUFDbEIsbUJBQWEsRUFBRSxNQUFNLGNBQWMsSUFBSSxFQUFFLEdBQUcsQ0FBQztBQUFBLElBQy9DLENBQUM7QUFDRCxNQUFFLFlBQVk7QUFDZCxVQUFNLFlBQVksR0FBRztBQUFBLEVBQ3ZCO0FBQ0EsUUFBTSxnQkFBZ0I7QUFDdEIsT0FBSyxzQkFBc0I7QUFBQSxJQUN6QixPQUFPLE1BQU07QUFBQSxJQUNiLEtBQUssTUFBTSxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUU7QUFBQSxFQUM1QixDQUFDO0FBRUQsZUFBYSxNQUFNLFVBQVU7QUFDL0I7QUFFQSxTQUFTLGdCQUFnQixPQUFlLFNBQW9DO0FBRTFFLFFBQU0sTUFBTSxTQUFTLGNBQWMsUUFBUTtBQUMzQyxNQUFJLE9BQU87QUFDWCxNQUFJLFFBQVEsVUFBVSxPQUFPLE1BQU0sWUFBWSxDQUFDO0FBQ2hELE1BQUksYUFBYSxjQUFjLEtBQUs7QUFDcEMsTUFBSSxZQUNGO0FBRUYsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFDSjtBQUNGLFFBQU0sWUFBWSxHQUFHLE9BQU8sMEJBQTBCLEtBQUs7QUFDM0QsTUFBSSxZQUFZLEtBQUs7QUFDckIsU0FBTztBQUNUO0FBS0EsU0FBUyxhQUFhLFFBQWlDO0FBRXJELE1BQUksTUFBTSxZQUFZO0FBQ3BCLFVBQU0sVUFDSixRQUFRLFNBQVMsV0FBVyxXQUM1QixRQUFRLFNBQVMsV0FBVyxXQUFXO0FBQ3pDLGVBQVcsQ0FBQyxLQUFLLEdBQUcsS0FBSyxPQUFPLFFBQVEsTUFBTSxVQUFVLEdBQXlDO0FBQy9GLHFCQUFlLEtBQUssUUFBUSxPQUFPO0FBQUEsSUFDckM7QUFBQSxFQUNGO0FBRUEsYUFBVyxLQUFLLE1BQU0sTUFBTSxPQUFPLEdBQUc7QUFDcEMsUUFBSSxDQUFDLEVBQUUsVUFBVztBQUNsQixVQUFNLFdBQVcsUUFBUSxTQUFTLGdCQUFnQixPQUFPLE9BQU8sRUFBRTtBQUNsRSxtQkFBZSxFQUFFLFdBQVcsUUFBUTtBQUFBLEVBQ3RDO0FBTUEsMkJBQXlCLFdBQVcsSUFBSTtBQUMxQztBQVlBLFNBQVMseUJBQXlCLE1BQXFCO0FBQ3JELE1BQUksQ0FBQyxLQUFNO0FBQ1gsUUFBTUMsUUFBTyxNQUFNO0FBQ25CLE1BQUksQ0FBQ0EsTUFBTTtBQUNYLFFBQU0sVUFBVSxNQUFNLEtBQUtBLE1BQUssaUJBQW9DLFFBQVEsQ0FBQztBQUM3RSxhQUFXLE9BQU8sU0FBUztBQUV6QixRQUFJLElBQUksUUFBUSxRQUFTO0FBQ3pCLFFBQUksSUFBSSxhQUFhLGNBQWMsTUFBTSxRQUFRO0FBQy9DLFVBQUksZ0JBQWdCLGNBQWM7QUFBQSxJQUNwQztBQUNBLFFBQUksSUFBSSxVQUFVLFNBQVMsZ0NBQWdDLEdBQUc7QUFDNUQsVUFBSSxVQUFVLE9BQU8sZ0NBQWdDO0FBQ3JELFVBQUksVUFBVSxJQUFJLHNDQUFzQztBQUFBLElBQzFEO0FBQUEsRUFDRjtBQUNGO0FBRUEsU0FBUyxlQUFlLEtBQXdCLFFBQXVCO0FBQ3JFLFFBQU0sUUFBUSxJQUFJO0FBQ2xCLE1BQUksUUFBUTtBQUNSLFFBQUksVUFBVSxPQUFPLHdDQUF3QyxhQUFhO0FBQzFFLFFBQUksVUFBVSxJQUFJLGdDQUFnQztBQUNsRCxRQUFJLGFBQWEsZ0JBQWdCLE1BQU07QUFDdkMsUUFBSSxPQUFPO0FBQ1QsWUFBTSxVQUFVLE9BQU8sdUJBQXVCO0FBQzlDLFlBQU0sVUFBVSxJQUFJLDZDQUE2QztBQUNqRSxZQUNHLGNBQWMsS0FBSyxHQUNsQixVQUFVLElBQUksa0RBQWtEO0FBQUEsSUFDdEU7QUFBQSxFQUNGLE9BQU87QUFDTCxRQUFJLFVBQVUsSUFBSSx3Q0FBd0MsYUFBYTtBQUN2RSxRQUFJLFVBQVUsT0FBTyxnQ0FBZ0M7QUFDckQsUUFBSSxnQkFBZ0IsY0FBYztBQUNsQyxRQUFJLE9BQU87QUFDVCxZQUFNLFVBQVUsSUFBSSx1QkFBdUI7QUFDM0MsWUFBTSxVQUFVLE9BQU8sNkNBQTZDO0FBQ3BFLFlBQ0csY0FBYyxLQUFLLEdBQ2xCLFVBQVUsT0FBTyxrREFBa0Q7QUFBQSxJQUN6RTtBQUFBLEVBQ0Y7QUFDSjtBQUlBLFNBQVMsYUFBYSxNQUF3QjtBQUM1QyxRQUFNLFVBQVUsZ0JBQWdCO0FBQ2hDLE1BQUksQ0FBQyxTQUFTO0FBQ1osU0FBSyxrQ0FBa0M7QUFDdkM7QUFBQSxFQUNGO0FBQ0EsUUFBTSxhQUFhO0FBQ25CLE9BQUssWUFBWSxFQUFFLEtBQUssQ0FBQztBQUd6QixhQUFXLFNBQVMsTUFBTSxLQUFLLFFBQVEsUUFBUSxHQUFvQjtBQUNqRSxRQUFJLE1BQU0sUUFBUSxZQUFZLGVBQWdCO0FBQzlDLFFBQUksTUFBTSxRQUFRLGtCQUFrQixRQUFXO0FBQzdDLFlBQU0sUUFBUSxnQkFBZ0IsTUFBTSxNQUFNLFdBQVc7QUFBQSxJQUN2RDtBQUNBLFVBQU0sTUFBTSxVQUFVO0FBQUEsRUFDeEI7QUFDQSxNQUFJLFFBQVEsUUFBUSxjQUEyQiwrQkFBK0I7QUFDOUUsTUFBSSxDQUFDLE9BQU87QUFDVixZQUFRLFNBQVMsY0FBYyxLQUFLO0FBQ3BDLFVBQU0sUUFBUSxVQUFVO0FBQ3hCLFVBQU0sTUFBTSxVQUFVO0FBQ3RCLFlBQVEsWUFBWSxLQUFLO0FBQUEsRUFDM0I7QUFDQSxRQUFNLE1BQU0sVUFBVTtBQUN0QixRQUFNLFlBQVk7QUFDbEIsV0FBUztBQUNULGVBQWEsSUFBSTtBQUVqQixRQUFNLFVBQVUsTUFBTTtBQUN0QixNQUFJLFNBQVM7QUFDWCxRQUFJLE1BQU0sdUJBQXVCO0FBQy9CLGNBQVEsb0JBQW9CLFNBQVMsTUFBTSx1QkFBdUIsSUFBSTtBQUFBLElBQ3hFO0FBQ0EsVUFBTSxVQUFVLENBQUMsTUFBYTtBQUM1QixZQUFNLFNBQVMsRUFBRTtBQUNqQixVQUFJLENBQUMsT0FBUTtBQUNiLFVBQUksTUFBTSxVQUFVLFNBQVMsTUFBTSxFQUFHO0FBQ3RDLFVBQUksTUFBTSxZQUFZLFNBQVMsTUFBTSxFQUFHO0FBQ3hDLFVBQUksT0FBTyxRQUFRLGdDQUFnQyxFQUFHO0FBQ3RELHVCQUFpQjtBQUFBLElBQ25CO0FBQ0EsVUFBTSx3QkFBd0I7QUFDOUIsWUFBUSxpQkFBaUIsU0FBUyxTQUFTLElBQUk7QUFBQSxFQUNqRDtBQUNGO0FBRUEsU0FBUyxtQkFBeUI7QUFDaEMsT0FBSyxvQkFBb0I7QUFDekIsUUFBTSxVQUFVLGdCQUFnQjtBQUNoQyxNQUFJLENBQUMsUUFBUztBQUNkLE1BQUksTUFBTSxVQUFXLE9BQU0sVUFBVSxNQUFNLFVBQVU7QUFDckQsYUFBVyxTQUFTLE1BQU0sS0FBSyxRQUFRLFFBQVEsR0FBb0I7QUFDakUsUUFBSSxVQUFVLE1BQU0sVUFBVztBQUMvQixRQUFJLE1BQU0sUUFBUSxrQkFBa0IsUUFBVztBQUM3QyxZQUFNLE1BQU0sVUFBVSxNQUFNLFFBQVE7QUFDcEMsYUFBTyxNQUFNLFFBQVE7QUFBQSxJQUN2QjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLGFBQWE7QUFDbkIsZUFBYSxJQUFJO0FBQ2pCLE1BQUksTUFBTSxlQUFlLE1BQU0sdUJBQXVCO0FBQ3BELFVBQU0sWUFBWTtBQUFBLE1BQ2hCO0FBQUEsTUFDQSxNQUFNO0FBQUEsTUFDTjtBQUFBLElBQ0Y7QUFDQSxVQUFNLHdCQUF3QjtBQUFBLEVBQ2hDO0FBQ0Y7QUFFQSxTQUFTLFdBQWlCO0FBQ3hCLE1BQUksQ0FBQyxNQUFNLFdBQVk7QUFDdkIsUUFBTSxPQUFPLE1BQU07QUFDbkIsTUFBSSxDQUFDLEtBQU07QUFDWCxPQUFLLFlBQVk7QUFFakIsUUFBTSxLQUFLLE1BQU07QUFDakIsTUFBSSxHQUFHLFNBQVMsY0FBYztBQUM1QixVQUFNLFFBQVEsTUFBTSxNQUFNLElBQUksR0FBRyxFQUFFO0FBQ25DLFFBQUksQ0FBQyxPQUFPO0FBQ1YsdUJBQWlCO0FBQ2pCO0FBQUEsSUFDRjtBQUNBLFVBQU1BLFFBQU8sV0FBVyxNQUFNLEtBQUssT0FBTyxNQUFNLEtBQUssV0FBVztBQUNoRSxTQUFLLFlBQVlBLE1BQUssS0FBSztBQUMzQixRQUFJO0FBRUYsVUFBSTtBQUFFLGNBQU0sV0FBVztBQUFBLE1BQUcsUUFBUTtBQUFBLE1BQUM7QUFDbkMsWUFBTSxXQUFXO0FBQ2pCLFlBQU0sTUFBTSxNQUFNLEtBQUssT0FBT0EsTUFBSyxZQUFZO0FBQy9DLFVBQUksT0FBTyxRQUFRLFdBQVksT0FBTSxXQUFXO0FBQUEsSUFDbEQsU0FBUyxHQUFHO0FBQ1YsWUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLFVBQUksWUFBWTtBQUNoQixVQUFJLGNBQWMseUJBQTBCLEVBQVksT0FBTztBQUMvRCxNQUFBQSxNQUFLLGFBQWEsWUFBWSxHQUFHO0FBQUEsSUFDbkM7QUFDQTtBQUFBLEVBQ0Y7QUFFQSxRQUFNLFFBQVEsR0FBRyxTQUFTLFdBQVcsV0FBVztBQUNoRCxRQUFNLFdBQVcsR0FBRyxTQUFTLFdBQ3pCLDBDQUNBO0FBQ0osUUFBTUEsUUFBTyxXQUFXLE9BQU8sUUFBUTtBQUN2QyxPQUFLLFlBQVlBLE1BQUssS0FBSztBQUMzQixNQUFJLEdBQUcsU0FBUyxTQUFVLGtCQUFpQkEsTUFBSyxZQUFZO0FBQUEsTUFDdkQsa0JBQWlCQSxNQUFLLGNBQWNBLE1BQUssUUFBUTtBQUN4RDtBQUlBLFNBQVMsaUJBQWlCLGNBQTJCLFVBQThCO0FBQ2pGLFFBQU0sVUFBVSxTQUFTLGNBQWMsU0FBUztBQUNoRCxVQUFRLFlBQVk7QUFDcEIsVUFBUSxZQUFZLGFBQWEsaUJBQWlCLENBQUM7QUFDbkQsUUFBTSxPQUFPLFlBQVk7QUFDekIsUUFBTSxVQUFVLFVBQVUsMkJBQTJCLHlDQUF5QztBQUM5RixPQUFLLFlBQVksT0FBTztBQUN4QixVQUFRLFlBQVksSUFBSTtBQUN4QixlQUFhLFlBQVksT0FBTztBQUVoQyxPQUFLLDRCQUNGLE9BQU8sb0JBQW9CLEVBQzNCLEtBQUssQ0FBQyxXQUFXO0FBQ2hCLFFBQUksVUFBVTtBQUNaLGVBQVMsY0FBYyxvQkFBcUIsT0FBK0IsT0FBTztBQUFBLElBQ3BGO0FBQ0EsU0FBSyxjQUFjO0FBQ25CLDhCQUEwQixNQUFNLE1BQTZCO0FBQUEsRUFDL0QsQ0FBQyxFQUNBLE1BQU0sQ0FBQyxNQUFNO0FBQ1osUUFBSSxTQUFVLFVBQVMsY0FBYztBQUNyQyxTQUFLLGNBQWM7QUFDbkIsU0FBSyxZQUFZLFVBQVUsa0NBQWtDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFBQSxFQUN6RSxDQUFDO0FBRUgsUUFBTSxVQUFVLFNBQVMsY0FBYyxTQUFTO0FBQ2hELFVBQVEsWUFBWTtBQUNwQixVQUFRLFlBQVksYUFBYSxxQkFBcUIsQ0FBQztBQUN2RCxRQUFNLGNBQWMsWUFBWTtBQUNoQyxjQUFZLFlBQVksVUFBVSxvQkFBb0IsdUNBQXVDLENBQUM7QUFDOUYsVUFBUSxZQUFZLFdBQVc7QUFDL0IsZUFBYSxZQUFZLE9BQU87QUFDaEMsMEJBQXdCLFdBQVc7QUFFbkMsUUFBTSxjQUFjLFNBQVMsY0FBYyxTQUFTO0FBQ3BELGNBQVksWUFBWTtBQUN4QixjQUFZLFlBQVksYUFBYSxhQUFhLENBQUM7QUFDbkQsUUFBTSxrQkFBa0IsWUFBWTtBQUNwQyxrQkFBZ0IsWUFBWSxhQUFhLENBQUM7QUFDMUMsa0JBQWdCLFlBQVksYUFBYSxDQUFDO0FBQzFDLGNBQVksWUFBWSxlQUFlO0FBQ3ZDLGVBQWEsWUFBWSxXQUFXO0FBQ3RDO0FBRUEsU0FBUywwQkFBMEIsTUFBbUIsUUFBbUM7QUFDdkYsT0FBSyxZQUFZLGNBQWMsTUFBTSxDQUFDO0FBQ3RDLE9BQUssWUFBWSxtQkFBbUIsT0FBTyxXQUFXLENBQUM7QUFDdkQsTUFBSSxPQUFPLFlBQWEsTUFBSyxZQUFZLGdCQUFnQixPQUFPLFdBQVcsQ0FBQztBQUM5RTtBQUVBLFNBQVMsY0FBYyxRQUEwQztBQUMvRCxRQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsTUFBSSxZQUFZO0FBQ2hCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWM7QUFDcEIsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFBWTtBQUNqQixPQUFLLGNBQWMsc0JBQXNCLE9BQU8sT0FBTztBQUN2RCxPQUFLLFlBQVksS0FBSztBQUN0QixPQUFLLFlBQVksSUFBSTtBQUNyQixNQUFJLFlBQVksSUFBSTtBQUNwQixNQUFJO0FBQUEsSUFDRixjQUFjLE9BQU8sWUFBWSxPQUFPLFNBQVM7QUFDL0MsWUFBTSw0QkFBWSxPQUFPLDJCQUEyQixJQUFJO0FBQUEsSUFDMUQsQ0FBQztBQUFBLEVBQ0g7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLG1CQUFtQixPQUFxRDtBQUMvRSxRQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsTUFBSSxZQUFZO0FBQ2hCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWMsT0FBTyxrQkFBa0IsNkJBQTZCO0FBQzFFLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxjQUFjLGNBQWMsS0FBSztBQUN0QyxPQUFLLFlBQVksS0FBSztBQUN0QixPQUFLLFlBQVksSUFBSTtBQUNyQixNQUFJLFlBQVksSUFBSTtBQUVwQixRQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUs7QUFDNUMsVUFBUSxZQUFZO0FBQ3BCLE1BQUksT0FBTyxZQUFZO0FBQ3JCLFlBQVE7QUFBQSxNQUNOLGNBQWMsaUJBQWlCLE1BQU07QUFDbkMsYUFBSyw0QkFBWSxPQUFPLHlCQUF5QixNQUFNLFVBQVU7QUFBQSxNQUNuRSxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFDQSxVQUFRO0FBQUEsSUFDTixjQUFjLGFBQWEsTUFBTTtBQUMvQixVQUFJLE1BQU0sVUFBVTtBQUNwQixXQUFLLDRCQUNGLE9BQU8sZ0NBQWdDLElBQUksRUFDM0MsS0FBSyxDQUFDLFNBQVM7QUFDZCxjQUFNLE9BQU8sSUFBSTtBQUNqQixZQUFJLENBQUMsS0FBTTtBQUNYLGFBQUssY0FBYztBQUNuQixhQUFLLDRCQUFZLE9BQU8sb0JBQW9CLEVBQUUsS0FBSyxDQUFDLFdBQVc7QUFDN0Qsb0NBQTBCLE1BQU07QUFBQSxZQUM5QixHQUFJO0FBQUEsWUFDSixhQUFhO0FBQUEsVUFDZixDQUFDO0FBQUEsUUFDSCxDQUFDO0FBQUEsTUFDSCxDQUFDLEVBQ0EsTUFBTSxDQUFDLE1BQU0sS0FBSywrQkFBK0IsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUMzRCxRQUFRLE1BQU07QUFDYixZQUFJLE1BQU0sVUFBVTtBQUFBLE1BQ3RCLENBQUM7QUFBQSxJQUNMLENBQUM7QUFBQSxFQUNIO0FBQ0EsTUFBSSxZQUFZLE9BQU87QUFDdkIsU0FBTztBQUNUO0FBRUEsU0FBUyxnQkFBZ0IsT0FBOEM7QUFDckUsUUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLE1BQUksWUFBWTtBQUNoQixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUFZO0FBQ2xCLFFBQU0sY0FBYztBQUNwQixNQUFJLFlBQVksS0FBSztBQUNyQixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUNIO0FBQ0YsT0FBSyxZQUFZLDJCQUEyQixNQUFNLGNBQWMsS0FBSyxLQUFLLE1BQU0sU0FBUyw2QkFBNkIsQ0FBQztBQUN2SCxNQUFJLFlBQVksSUFBSTtBQUNwQixTQUFPO0FBQ1Q7QUFFQSxTQUFTLDJCQUEyQixVQUErQjtBQUNqRSxRQUFNQSxRQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLEVBQUFBLE1BQUssWUFBWTtBQUNqQixRQUFNLFFBQVEsU0FBUyxRQUFRLFVBQVUsSUFBSSxFQUFFLE1BQU0sSUFBSTtBQUN6RCxNQUFJLFlBQXNCLENBQUM7QUFDM0IsTUFBSSxPQUFtRDtBQUN2RCxNQUFJLFlBQTZCO0FBRWpDLFFBQU0saUJBQWlCLE1BQU07QUFDM0IsUUFBSSxVQUFVLFdBQVcsRUFBRztBQUM1QixVQUFNLElBQUksU0FBUyxjQUFjLEdBQUc7QUFDcEMsTUFBRSxZQUFZO0FBQ2QseUJBQXFCLEdBQUcsVUFBVSxLQUFLLEdBQUcsRUFBRSxLQUFLLENBQUM7QUFDbEQsSUFBQUEsTUFBSyxZQUFZLENBQUM7QUFDbEIsZ0JBQVksQ0FBQztBQUFBLEVBQ2Y7QUFDQSxRQUFNLFlBQVksTUFBTTtBQUN0QixRQUFJLENBQUMsS0FBTTtBQUNYLElBQUFBLE1BQUssWUFBWSxJQUFJO0FBQ3JCLFdBQU87QUFBQSxFQUNUO0FBQ0EsUUFBTSxZQUFZLE1BQU07QUFDdEIsUUFBSSxDQUFDLFVBQVc7QUFDaEIsVUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLFFBQUksWUFDRjtBQUNGLFVBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxTQUFLLGNBQWMsVUFBVSxLQUFLLElBQUk7QUFDdEMsUUFBSSxZQUFZLElBQUk7QUFDcEIsSUFBQUEsTUFBSyxZQUFZLEdBQUc7QUFDcEIsZ0JBQVk7QUFBQSxFQUNkO0FBRUEsYUFBVyxRQUFRLE9BQU87QUFDeEIsUUFBSSxLQUFLLEtBQUssRUFBRSxXQUFXLEtBQUssR0FBRztBQUNqQyxVQUFJLFVBQVcsV0FBVTtBQUFBLFdBQ3BCO0FBQ0gsdUJBQWU7QUFDZixrQkFBVTtBQUNWLG9CQUFZLENBQUM7QUFBQSxNQUNmO0FBQ0E7QUFBQSxJQUNGO0FBQ0EsUUFBSSxXQUFXO0FBQ2IsZ0JBQVUsS0FBSyxJQUFJO0FBQ25CO0FBQUEsSUFDRjtBQUVBLFVBQU0sVUFBVSxLQUFLLEtBQUs7QUFDMUIsUUFBSSxDQUFDLFNBQVM7QUFDWixxQkFBZTtBQUNmLGdCQUFVO0FBQ1Y7QUFBQSxJQUNGO0FBRUEsVUFBTSxVQUFVLG9CQUFvQixLQUFLLE9BQU87QUFDaEQsUUFBSSxTQUFTO0FBQ1gscUJBQWU7QUFDZixnQkFBVTtBQUNWLFlBQU0sSUFBSSxTQUFTLGNBQWMsUUFBUSxDQUFDLEVBQUUsV0FBVyxJQUFJLE9BQU8sSUFBSTtBQUN0RSxRQUFFLFlBQVk7QUFDZCwyQkFBcUIsR0FBRyxRQUFRLENBQUMsQ0FBQztBQUNsQyxNQUFBQSxNQUFLLFlBQVksQ0FBQztBQUNsQjtBQUFBLElBQ0Y7QUFFQSxVQUFNLFlBQVksZ0JBQWdCLEtBQUssT0FBTztBQUM5QyxVQUFNLFVBQVUsbUJBQW1CLEtBQUssT0FBTztBQUMvQyxRQUFJLGFBQWEsU0FBUztBQUN4QixxQkFBZTtBQUNmLFlBQU0sY0FBYyxRQUFRLE9BQU87QUFDbkMsVUFBSSxDQUFDLFFBQVMsZUFBZSxLQUFLLFlBQVksUUFBVSxDQUFDLGVBQWUsS0FBSyxZQUFZLE1BQU87QUFDOUYsa0JBQVU7QUFDVixlQUFPLFNBQVMsY0FBYyxjQUFjLE9BQU8sSUFBSTtBQUN2RCxhQUFLLFlBQVksY0FDYiw4Q0FDQTtBQUFBLE1BQ047QUFDQSxZQUFNLEtBQUssU0FBUyxjQUFjLElBQUk7QUFDdEMsMkJBQXFCLEtBQUssYUFBYSxXQUFXLENBQUMsS0FBSyxFQUFFO0FBQzFELFdBQUssWUFBWSxFQUFFO0FBQ25CO0FBQUEsSUFDRjtBQUVBLFVBQU0sUUFBUSxhQUFhLEtBQUssT0FBTztBQUN2QyxRQUFJLE9BQU87QUFDVCxxQkFBZTtBQUNmLGdCQUFVO0FBQ1YsWUFBTSxhQUFhLFNBQVMsY0FBYyxZQUFZO0FBQ3RELGlCQUFXLFlBQVk7QUFDdkIsMkJBQXFCLFlBQVksTUFBTSxDQUFDLENBQUM7QUFDekMsTUFBQUEsTUFBSyxZQUFZLFVBQVU7QUFDM0I7QUFBQSxJQUNGO0FBRUEsY0FBVSxLQUFLLE9BQU87QUFBQSxFQUN4QjtBQUVBLGlCQUFlO0FBQ2YsWUFBVTtBQUNWLFlBQVU7QUFDVixTQUFPQTtBQUNUO0FBRUEsU0FBUyxxQkFBcUIsUUFBcUIsTUFBb0I7QUFDckUsUUFBTSxVQUFVO0FBQ2hCLE1BQUksWUFBWTtBQUNoQixhQUFXLFNBQVMsS0FBSyxTQUFTLE9BQU8sR0FBRztBQUMxQyxRQUFJLE1BQU0sVUFBVSxPQUFXO0FBQy9CLGVBQVcsUUFBUSxLQUFLLE1BQU0sV0FBVyxNQUFNLEtBQUssQ0FBQztBQUNyRCxRQUFJLE1BQU0sQ0FBQyxNQUFNLFFBQVc7QUFDMUIsWUFBTSxPQUFPLFNBQVMsY0FBYyxNQUFNO0FBQzFDLFdBQUssWUFDSDtBQUNGLFdBQUssY0FBYyxNQUFNLENBQUM7QUFDMUIsYUFBTyxZQUFZLElBQUk7QUFBQSxJQUN6QixXQUFXLE1BQU0sQ0FBQyxNQUFNLFVBQWEsTUFBTSxDQUFDLE1BQU0sUUFBVztBQUMzRCxZQUFNLElBQUksU0FBUyxjQUFjLEdBQUc7QUFDcEMsUUFBRSxZQUFZO0FBQ2QsUUFBRSxPQUFPLE1BQU0sQ0FBQztBQUNoQixRQUFFLFNBQVM7QUFDWCxRQUFFLE1BQU07QUFDUixRQUFFLGNBQWMsTUFBTSxDQUFDO0FBQ3ZCLGFBQU8sWUFBWSxDQUFDO0FBQUEsSUFDdEIsV0FBVyxNQUFNLENBQUMsTUFBTSxRQUFXO0FBQ2pDLFlBQU0sU0FBUyxTQUFTLGNBQWMsUUFBUTtBQUM5QyxhQUFPLFlBQVk7QUFDbkIsYUFBTyxjQUFjLE1BQU0sQ0FBQztBQUM1QixhQUFPLFlBQVksTUFBTTtBQUFBLElBQzNCLFdBQVcsTUFBTSxDQUFDLE1BQU0sUUFBVztBQUNqQyxZQUFNLEtBQUssU0FBUyxjQUFjLElBQUk7QUFDdEMsU0FBRyxjQUFjLE1BQU0sQ0FBQztBQUN4QixhQUFPLFlBQVksRUFBRTtBQUFBLElBQ3ZCO0FBQ0EsZ0JBQVksTUFBTSxRQUFRLE1BQU0sQ0FBQyxFQUFFO0FBQUEsRUFDckM7QUFDQSxhQUFXLFFBQVEsS0FBSyxNQUFNLFNBQVMsQ0FBQztBQUMxQztBQUVBLFNBQVMsV0FBVyxRQUFxQixNQUFvQjtBQUMzRCxNQUFJLEtBQU0sUUFBTyxZQUFZLFNBQVMsZUFBZSxJQUFJLENBQUM7QUFDNUQ7QUFFQSxTQUFTLHdCQUF3QixNQUF5QjtBQUN4RCxPQUFLLDRCQUNGLE9BQU8sNEJBQTRCLEVBQ25DLEtBQUssQ0FBQyxXQUFXO0FBQ2hCLFNBQUssY0FBYztBQUNuQix3QkFBb0IsTUFBTSxNQUF1QjtBQUFBLEVBQ25ELENBQUMsRUFDQSxNQUFNLENBQUMsTUFBTTtBQUNaLFNBQUssY0FBYztBQUNuQixTQUFLLFlBQVksVUFBVSwyQkFBMkIsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUFBLEVBQ2xFLENBQUM7QUFDTDtBQUVBLFNBQVMsb0JBQW9CLE1BQW1CLFFBQTZCO0FBQzNFLE9BQUssWUFBWSxrQkFBa0IsTUFBTSxDQUFDO0FBQzFDLGFBQVcsU0FBUyxPQUFPLFFBQVE7QUFDakMsUUFBSSxNQUFNLFdBQVcsS0FBTTtBQUMzQixTQUFLLFlBQVksZ0JBQWdCLEtBQUssQ0FBQztBQUFBLEVBQ3pDO0FBQ0Y7QUFFQSxTQUFTLGtCQUFrQixRQUFvQztBQUM3RCxRQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsTUFBSSxZQUFZO0FBQ2hCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxZQUFZLFlBQVksT0FBTyxRQUFRLE9BQU8sT0FBTyxDQUFDO0FBQzNELFFBQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUMxQyxRQUFNLFlBQVk7QUFDbEIsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWMsT0FBTztBQUMzQixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLE9BQUssY0FBYyxHQUFHLE9BQU8sT0FBTyxZQUFZLElBQUksS0FBSyxPQUFPLFNBQVMsRUFBRSxlQUFlLENBQUM7QUFDM0YsUUFBTSxZQUFZLEtBQUs7QUFDdkIsUUFBTSxZQUFZLElBQUk7QUFDdEIsT0FBSyxZQUFZLEtBQUs7QUFDdEIsTUFBSSxZQUFZLElBQUk7QUFFcEIsUUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFNBQU8sWUFBWTtBQUNuQixTQUFPO0FBQUEsSUFDTCxjQUFjLGFBQWEsTUFBTTtBQUMvQixZQUFNLE9BQU8sSUFBSTtBQUNqQixVQUFJLENBQUMsS0FBTTtBQUNYLFdBQUssY0FBYztBQUNuQixXQUFLLFlBQVksVUFBVSxvQkFBb0IsdUNBQXVDLENBQUM7QUFDdkYsOEJBQXdCLElBQUk7QUFBQSxJQUM5QixDQUFDO0FBQUEsRUFDSDtBQUNBLE1BQUksWUFBWSxNQUFNO0FBQ3RCLFNBQU87QUFDVDtBQUVBLFNBQVMsZ0JBQWdCLE9BQXdDO0FBQy9ELFFBQU0sTUFBTSxVQUFVLE1BQU0sTUFBTSxNQUFNLE1BQU07QUFDOUMsUUFBTSxPQUFPLElBQUk7QUFDakIsTUFBSSxLQUFNLE1BQUssUUFBUSxZQUFZLE1BQU0sTUFBTSxDQUFDO0FBQ2hELFNBQU87QUFDVDtBQUVBLFNBQVMsWUFBWSxRQUFpQyxPQUE2QjtBQUNqRixRQUFNLFFBQVEsU0FBUyxjQUFjLE1BQU07QUFDM0MsUUFBTSxPQUNKLFdBQVcsT0FDUCxzREFDQSxXQUFXLFNBQ1Qsd0RBQ0E7QUFDUixRQUFNLFlBQVkseUZBQXlGLElBQUk7QUFDL0csUUFBTSxjQUFjLFVBQVUsV0FBVyxPQUFPLE9BQU8sV0FBVyxTQUFTLFdBQVc7QUFDdEYsU0FBTztBQUNUO0FBRUEsU0FBUyxjQUFjLE9BQWdEO0FBQ3JFLE1BQUksQ0FBQyxNQUFPLFFBQU87QUFDbkIsUUFBTSxTQUFTLE1BQU0sZ0JBQWdCLFdBQVcsTUFBTSxhQUFhLE9BQU87QUFDMUUsUUFBTSxVQUFVLFdBQVcsSUFBSSxLQUFLLE1BQU0sU0FBUyxFQUFFLGVBQWUsQ0FBQztBQUNyRSxNQUFJLE1BQU0sTUFBTyxRQUFPLEdBQUcsTUFBTSxHQUFHLE9BQU8sSUFBSSxNQUFNLEtBQUs7QUFDMUQsU0FBTyxHQUFHLE1BQU0sR0FBRyxPQUFPO0FBQzVCO0FBRUEsU0FBUyxlQUE0QjtBQUNuQyxRQUFNLE1BQU07QUFBQSxJQUNWO0FBQUEsSUFDQTtBQUFBLEVBQ0Y7QUFDQSxRQUFNLFNBQVMsSUFBSSxjQUEyQiw0QkFBNEI7QUFDMUUsVUFBUTtBQUFBLElBQ04sY0FBYyxnQkFBZ0IsTUFBTTtBQUNsQyxXQUFLLDRCQUNGLE9BQU8scUJBQXFCLHdFQUF3RSxFQUNwRyxNQUFNLENBQUMsTUFBTSxLQUFLLGlDQUFpQyxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBQUEsSUFDbEUsQ0FBQztBQUFBLEVBQ0g7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGVBQTRCO0FBQ25DLFFBQU0sTUFBTTtBQUFBLElBQ1Y7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUNBLFFBQU0sU0FBUyxJQUFJLGNBQTJCLDRCQUE0QjtBQUMxRSxVQUFRO0FBQUEsSUFDTixjQUFjLGNBQWMsTUFBTTtBQUNoQyxZQUFNLFFBQVEsbUJBQW1CLFNBQVM7QUFDMUMsWUFBTSxPQUFPO0FBQUEsUUFDWDtBQUFBLFVBQ0U7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFVBQ0E7QUFBQSxVQUNBO0FBQUEsVUFDQTtBQUFBLFFBQ0YsRUFBRSxLQUFLLElBQUk7QUFBQSxNQUNiO0FBQ0EsV0FBSyw0QkFBWTtBQUFBLFFBQ2Y7QUFBQSxRQUNBLDhEQUE4RCxLQUFLLFNBQVMsSUFBSTtBQUFBLE1BQ2xGO0FBQUEsSUFDRixDQUFDO0FBQUEsRUFDSDtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsVUFBVSxXQUFtQixhQUFrQztBQUN0RSxRQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsTUFBSSxZQUFZO0FBQ2hCLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQVk7QUFDakIsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWM7QUFDcEIsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFBWTtBQUNqQixPQUFLLGNBQWM7QUFDbkIsT0FBSyxZQUFZLEtBQUs7QUFDdEIsT0FBSyxZQUFZLElBQUk7QUFDckIsTUFBSSxZQUFZLElBQUk7QUFDcEIsUUFBTSxVQUFVLFNBQVMsY0FBYyxLQUFLO0FBQzVDLFVBQVEsUUFBUSxvQkFBb0I7QUFDcEMsVUFBUSxZQUFZO0FBQ3BCLE1BQUksWUFBWSxPQUFPO0FBQ3ZCLFNBQU87QUFDVDtBQUVBLFNBQVMsaUJBQWlCLGNBQWlDO0FBQ3pELFFBQU0sVUFBVSxrQkFBa0Isc0JBQXNCLE1BQU07QUFDNUQsU0FBSyw0QkFBWSxPQUFPLGtCQUFrQixXQUFXLENBQUM7QUFBQSxFQUN4RCxDQUFDO0FBQ0QsUUFBTSxZQUFZLGtCQUFrQixnQkFBZ0IsTUFBTTtBQUt4RCxTQUFLLDRCQUNGLE9BQU8sdUJBQXVCLEVBQzlCLE1BQU0sQ0FBQyxNQUFNLEtBQUssOEJBQThCLE9BQU8sQ0FBQyxDQUFDLENBQUMsRUFDMUQsUUFBUSxNQUFNO0FBQ2IsZUFBUyxPQUFPO0FBQUEsSUFDbEIsQ0FBQztBQUFBLEVBQ0wsQ0FBQztBQUdELFFBQU0sWUFBWSxVQUFVLGNBQWMsS0FBSztBQUMvQyxNQUFJLFdBQVc7QUFDYixjQUFVLFlBQ1I7QUFBQSxFQUlKO0FBRUEsUUFBTSxXQUFXLFNBQVMsY0FBYyxLQUFLO0FBQzdDLFdBQVMsWUFBWTtBQUNyQixXQUFTLFlBQVksU0FBUztBQUM5QixXQUFTLFlBQVksT0FBTztBQUU1QixNQUFJLE1BQU0sYUFBYSxXQUFXLEdBQUc7QUFDbkMsVUFBTSxVQUFVLFNBQVMsY0FBYyxTQUFTO0FBQ2hELFlBQVEsWUFBWTtBQUNwQixZQUFRLFlBQVksYUFBYSxvQkFBb0IsUUFBUSxDQUFDO0FBQzlELFVBQU1DLFFBQU8sWUFBWTtBQUN6QixJQUFBQSxNQUFLO0FBQUEsTUFDSDtBQUFBLFFBQ0U7QUFBQSxRQUNBLDRCQUE0QixXQUFXLENBQUM7QUFBQSxNQUMxQztBQUFBLElBQ0Y7QUFDQSxZQUFRLFlBQVlBLEtBQUk7QUFDeEIsaUJBQWEsWUFBWSxPQUFPO0FBQ2hDO0FBQUEsRUFDRjtBQUdBLFFBQU0sa0JBQWtCLG9CQUFJLElBQStCO0FBQzNELGFBQVcsS0FBSyxNQUFNLFNBQVMsT0FBTyxHQUFHO0FBQ3ZDLFVBQU0sVUFBVSxFQUFFLEdBQUcsTUFBTSxHQUFHLEVBQUUsQ0FBQztBQUNqQyxRQUFJLENBQUMsZ0JBQWdCLElBQUksT0FBTyxFQUFHLGlCQUFnQixJQUFJLFNBQVMsQ0FBQyxDQUFDO0FBQ2xFLG9CQUFnQixJQUFJLE9BQU8sRUFBRyxLQUFLLENBQUM7QUFBQSxFQUN0QztBQUVBLFFBQU0sT0FBTyxTQUFTLGNBQWMsU0FBUztBQUM3QyxPQUFLLFlBQVk7QUFDakIsT0FBSyxZQUFZLGFBQWEsb0JBQW9CLFFBQVEsQ0FBQztBQUUzRCxRQUFNLE9BQU8sWUFBWTtBQUN6QixhQUFXLEtBQUssTUFBTSxjQUFjO0FBQ2xDLFNBQUssWUFBWSxTQUFTLEdBQUcsZ0JBQWdCLElBQUksRUFBRSxTQUFTLEVBQUUsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUFBLEVBQ3hFO0FBQ0EsT0FBSyxZQUFZLElBQUk7QUFDckIsZUFBYSxZQUFZLElBQUk7QUFDL0I7QUFFQSxTQUFTLFNBQVMsR0FBZ0IsVUFBMEM7QUFDMUUsUUFBTSxJQUFJLEVBQUU7QUFLWixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLE1BQUksQ0FBQyxFQUFFLFFBQVMsTUFBSyxNQUFNLFVBQVU7QUFFckMsUUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFNBQU8sWUFBWTtBQUVuQixRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBR2pCLFFBQU0sU0FBUyxTQUFTLGNBQWMsS0FBSztBQUMzQyxTQUFPLFlBQ0w7QUFDRixTQUFPLE1BQU0sUUFBUTtBQUNyQixTQUFPLE1BQU0sU0FBUztBQUN0QixTQUFPLE1BQU0sa0JBQWtCO0FBQy9CLE1BQUksRUFBRSxTQUFTO0FBQ2IsVUFBTSxNQUFNLFNBQVMsY0FBYyxLQUFLO0FBQ3hDLFFBQUksTUFBTTtBQUNWLFFBQUksWUFBWTtBQUVoQixVQUFNLFdBQVcsRUFBRSxPQUFPLENBQUMsS0FBSyxLQUFLLFlBQVk7QUFDakQsVUFBTSxXQUFXLFNBQVMsY0FBYyxNQUFNO0FBQzlDLGFBQVMsWUFBWTtBQUNyQixhQUFTLGNBQWM7QUFDdkIsV0FBTyxZQUFZLFFBQVE7QUFDM0IsUUFBSSxNQUFNLFVBQVU7QUFDcEIsUUFBSSxpQkFBaUIsUUFBUSxNQUFNO0FBQ2pDLGVBQVMsT0FBTztBQUNoQixVQUFJLE1BQU0sVUFBVTtBQUFBLElBQ3RCLENBQUM7QUFDRCxRQUFJLGlCQUFpQixTQUFTLE1BQU07QUFDbEMsVUFBSSxPQUFPO0FBQUEsSUFDYixDQUFDO0FBQ0QsU0FBSyxlQUFlLEVBQUUsU0FBUyxFQUFFLEdBQUcsRUFBRSxLQUFLLENBQUMsUUFBUTtBQUNsRCxVQUFJLElBQUssS0FBSSxNQUFNO0FBQUEsVUFDZCxLQUFJLE9BQU87QUFBQSxJQUNsQixDQUFDO0FBQ0QsV0FBTyxZQUFZLEdBQUc7QUFBQSxFQUN4QixPQUFPO0FBQ0wsVUFBTSxXQUFXLEVBQUUsT0FBTyxDQUFDLEtBQUssS0FBSyxZQUFZO0FBQ2pELFVBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxTQUFLLFlBQVk7QUFDakIsU0FBSyxjQUFjO0FBQ25CLFdBQU8sWUFBWSxJQUFJO0FBQUEsRUFDekI7QUFDQSxPQUFLLFlBQVksTUFBTTtBQUd2QixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUFZO0FBRWxCLFFBQU0sV0FBVyxTQUFTLGNBQWMsS0FBSztBQUM3QyxXQUFTLFlBQVk7QUFDckIsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFBWTtBQUNqQixPQUFLLGNBQWMsRUFBRTtBQUNyQixXQUFTLFlBQVksSUFBSTtBQUN6QixNQUFJLEVBQUUsU0FBUztBQUNiLFVBQU0sTUFBTSxTQUFTLGNBQWMsTUFBTTtBQUN6QyxRQUFJLFlBQ0Y7QUFDRixRQUFJLGNBQWMsSUFBSSxFQUFFLE9BQU87QUFDL0IsYUFBUyxZQUFZLEdBQUc7QUFBQSxFQUMxQjtBQUNBLE1BQUksRUFBRSxRQUFRLGlCQUFpQjtBQUM3QixVQUFNLFFBQVEsU0FBUyxjQUFjLE1BQU07QUFDM0MsVUFBTSxZQUNKO0FBQ0YsVUFBTSxjQUFjO0FBQ3BCLGFBQVMsWUFBWSxLQUFLO0FBQUEsRUFDNUI7QUFDQSxRQUFNLFlBQVksUUFBUTtBQUUxQixNQUFJLEVBQUUsYUFBYTtBQUNqQixVQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsU0FBSyxZQUFZO0FBQ2pCLFNBQUssY0FBYyxFQUFFO0FBQ3JCLFVBQU0sWUFBWSxJQUFJO0FBQUEsRUFDeEI7QUFFQSxRQUFNLE9BQU8sU0FBUyxjQUFjLEtBQUs7QUFDekMsT0FBSyxZQUFZO0FBQ2pCLFFBQU0sV0FBVyxhQUFhLEVBQUUsTUFBTTtBQUN0QyxNQUFJLFNBQVUsTUFBSyxZQUFZLFFBQVE7QUFDdkMsTUFBSSxFQUFFLFlBQVk7QUFDaEIsUUFBSSxLQUFLLFNBQVMsU0FBUyxFQUFHLE1BQUssWUFBWSxJQUFJLENBQUM7QUFDcEQsVUFBTSxPQUFPLFNBQVMsY0FBYyxRQUFRO0FBQzVDLFNBQUssT0FBTztBQUNaLFNBQUssWUFBWTtBQUNqQixTQUFLLGNBQWMsRUFBRTtBQUNyQixTQUFLLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUNwQyxRQUFFLGVBQWU7QUFDakIsUUFBRSxnQkFBZ0I7QUFDbEIsV0FBSyw0QkFBWSxPQUFPLHlCQUF5QixzQkFBc0IsRUFBRSxVQUFVLEVBQUU7QUFBQSxJQUN2RixDQUFDO0FBQ0QsU0FBSyxZQUFZLElBQUk7QUFBQSxFQUN2QjtBQUNBLE1BQUksRUFBRSxVQUFVO0FBQ2QsUUFBSSxLQUFLLFNBQVMsU0FBUyxFQUFHLE1BQUssWUFBWSxJQUFJLENBQUM7QUFDcEQsVUFBTSxPQUFPLFNBQVMsY0FBYyxHQUFHO0FBQ3ZDLFNBQUssT0FBTyxFQUFFO0FBQ2QsU0FBSyxTQUFTO0FBQ2QsU0FBSyxNQUFNO0FBQ1gsU0FBSyxZQUFZO0FBQ2pCLFNBQUssY0FBYztBQUNuQixTQUFLLFlBQVksSUFBSTtBQUFBLEVBQ3ZCO0FBQ0EsTUFBSSxLQUFLLFNBQVMsU0FBUyxFQUFHLE9BQU0sWUFBWSxJQUFJO0FBR3BELE1BQUksRUFBRSxRQUFRLEVBQUUsS0FBSyxTQUFTLEdBQUc7QUFDL0IsVUFBTSxVQUFVLFNBQVMsY0FBYyxLQUFLO0FBQzVDLFlBQVEsWUFBWTtBQUNwQixlQUFXLE9BQU8sRUFBRSxNQUFNO0FBQ3hCLFlBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxXQUFLLFlBQ0g7QUFDRixXQUFLLGNBQWM7QUFDbkIsY0FBUSxZQUFZLElBQUk7QUFBQSxJQUMxQjtBQUNBLFVBQU0sWUFBWSxPQUFPO0FBQUEsRUFDM0I7QUFFQSxPQUFLLFlBQVksS0FBSztBQUN0QixTQUFPLFlBQVksSUFBSTtBQUd2QixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUFZO0FBQ2xCLE1BQUksRUFBRSxRQUFRLG1CQUFtQixFQUFFLE9BQU8sWUFBWTtBQUNwRCxVQUFNO0FBQUEsTUFDSixjQUFjLGtCQUFrQixNQUFNO0FBQ3BDLGFBQUssNEJBQVksT0FBTyx5QkFBeUIsRUFBRSxPQUFRLFVBQVU7QUFBQSxNQUN2RSxDQUFDO0FBQUEsSUFDSDtBQUFBLEVBQ0Y7QUFDQSxRQUFNO0FBQUEsSUFDSixjQUFjLEVBQUUsU0FBUyxPQUFPLFNBQVM7QUFDdkMsWUFBTSw0QkFBWSxPQUFPLDZCQUE2QixFQUFFLElBQUksSUFBSTtBQUFBLElBR2xFLENBQUM7QUFBQSxFQUNIO0FBQ0EsU0FBTyxZQUFZLEtBQUs7QUFFeEIsT0FBSyxZQUFZLE1BQU07QUFJdkIsTUFBSSxFQUFFLFdBQVcsU0FBUyxTQUFTLEdBQUc7QUFDcEMsVUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFdBQU8sWUFDTDtBQUNGLGVBQVcsS0FBSyxVQUFVO0FBQ3hCLFlBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxXQUFLLFlBQVk7QUFDakIsVUFBSTtBQUNGLFVBQUUsT0FBTyxJQUFJO0FBQUEsTUFDZixTQUFTLEdBQUc7QUFDVixhQUFLLGNBQWMsa0NBQW1DLEVBQVksT0FBTztBQUFBLE1BQzNFO0FBQ0EsYUFBTyxZQUFZLElBQUk7QUFBQSxJQUN6QjtBQUNBLFNBQUssWUFBWSxNQUFNO0FBQUEsRUFDekI7QUFFQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGFBQWEsUUFBcUQ7QUFDekUsTUFBSSxDQUFDLE9BQVEsUUFBTztBQUNwQixRQUFNLE9BQU8sU0FBUyxjQUFjLE1BQU07QUFDMUMsT0FBSyxZQUFZO0FBQ2pCLE1BQUksT0FBTyxXQUFXLFVBQVU7QUFDOUIsU0FBSyxjQUFjLE1BQU0sTUFBTTtBQUMvQixXQUFPO0FBQUEsRUFDVDtBQUNBLE9BQUssWUFBWSxTQUFTLGVBQWUsS0FBSyxDQUFDO0FBQy9DLE1BQUksT0FBTyxLQUFLO0FBQ2QsVUFBTSxJQUFJLFNBQVMsY0FBYyxHQUFHO0FBQ3BDLE1BQUUsT0FBTyxPQUFPO0FBQ2hCLE1BQUUsU0FBUztBQUNYLE1BQUUsTUFBTTtBQUNSLE1BQUUsWUFBWTtBQUNkLE1BQUUsY0FBYyxPQUFPO0FBQ3ZCLFNBQUssWUFBWSxDQUFDO0FBQUEsRUFDcEIsT0FBTztBQUNMLFVBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxTQUFLLGNBQWMsT0FBTztBQUMxQixTQUFLLFlBQVksSUFBSTtBQUFBLEVBQ3ZCO0FBQ0EsU0FBTztBQUNUO0FBS0EsU0FBUyxXQUNQLE9BQ0EsVUFDMkU7QUFDM0UsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUVsQixRQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUs7QUFDNUMsVUFBUSxZQUNOO0FBQ0YsUUFBTSxZQUFZLE9BQU87QUFFekIsUUFBTSxTQUFTLFNBQVMsY0FBYyxLQUFLO0FBQzNDLFNBQU8sWUFBWTtBQUNuQixRQUFNLFlBQVksTUFBTTtBQUV4QixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUNKO0FBQ0YsU0FBTyxZQUFZLEtBQUs7QUFFeEIsUUFBTSxhQUFhLFNBQVMsY0FBYyxLQUFLO0FBQy9DLGFBQVcsWUFBWTtBQUN2QixRQUFNLGNBQWMsU0FBUyxjQUFjLEtBQUs7QUFDaEQsY0FBWSxZQUFZO0FBQ3hCLFFBQU0sVUFBVSxTQUFTLGNBQWMsS0FBSztBQUM1QyxVQUFRLFlBQVk7QUFDcEIsVUFBUSxjQUFjO0FBQ3RCLGNBQVksWUFBWSxPQUFPO0FBQy9CLE1BQUk7QUFDSixNQUFJLFVBQVU7QUFDWixVQUFNLE1BQU0sU0FBUyxjQUFjLEtBQUs7QUFDeEMsUUFBSSxZQUFZO0FBQ2hCLFFBQUksY0FBYztBQUNsQixnQkFBWSxZQUFZLEdBQUc7QUFDM0Isc0JBQWtCO0FBQUEsRUFDcEI7QUFDQSxhQUFXLFlBQVksV0FBVztBQUNsQyxRQUFNLFlBQVksVUFBVTtBQUU1QixRQUFNLGVBQWUsU0FBUyxjQUFjLEtBQUs7QUFDakQsZUFBYSxZQUFZO0FBQ3pCLFFBQU0sWUFBWSxZQUFZO0FBRTlCLFNBQU8sRUFBRSxPQUFPLGNBQWMsVUFBVSxnQkFBZ0I7QUFDMUQ7QUFFQSxTQUFTLGFBQWEsTUFBYyxVQUFxQztBQUN2RSxRQUFNLFdBQVcsU0FBUyxjQUFjLEtBQUs7QUFDN0MsV0FBUyxZQUNQO0FBQ0YsUUFBTSxhQUFhLFNBQVMsY0FBYyxLQUFLO0FBQy9DLGFBQVcsWUFBWTtBQUN2QixRQUFNLElBQUksU0FBUyxjQUFjLEtBQUs7QUFDdEMsSUFBRSxZQUFZO0FBQ2QsSUFBRSxjQUFjO0FBQ2hCLGFBQVcsWUFBWSxDQUFDO0FBQ3hCLFdBQVMsWUFBWSxVQUFVO0FBQy9CLE1BQUksVUFBVTtBQUNaLFVBQU0sUUFBUSxTQUFTLGNBQWMsS0FBSztBQUMxQyxVQUFNLFlBQVk7QUFDbEIsVUFBTSxZQUFZLFFBQVE7QUFDMUIsYUFBUyxZQUFZLEtBQUs7QUFBQSxFQUM1QjtBQUNBLFNBQU87QUFDVDtBQU1BLFNBQVMsa0JBQWtCLE9BQWUsU0FBd0M7QUFDaEYsUUFBTSxNQUFNLFNBQVMsY0FBYyxRQUFRO0FBQzNDLE1BQUksT0FBTztBQUNYLE1BQUksWUFDRjtBQUNGLE1BQUksWUFDRixHQUFHLEtBQUs7QUFJVixNQUFJLGlCQUFpQixTQUFTLENBQUMsTUFBTTtBQUNuQyxNQUFFLGVBQWU7QUFDakIsTUFBRSxnQkFBZ0I7QUFDbEIsWUFBUTtBQUFBLEVBQ1YsQ0FBQztBQUNELFNBQU87QUFDVDtBQUVBLFNBQVMsY0FBYyxPQUFlLFNBQXdDO0FBQzVFLFFBQU0sTUFBTSxTQUFTLGNBQWMsUUFBUTtBQUMzQyxNQUFJLE9BQU87QUFDWCxNQUFJLFlBQ0Y7QUFDRixNQUFJLGNBQWM7QUFDbEIsTUFBSSxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDbkMsTUFBRSxlQUFlO0FBQ2pCLE1BQUUsZ0JBQWdCO0FBQ2xCLFlBQVE7QUFBQSxFQUNWLENBQUM7QUFDRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGNBQTJCO0FBQ2xDLFFBQU0sT0FBTyxTQUFTLGNBQWMsS0FBSztBQUN6QyxPQUFLLFlBQ0g7QUFDRixPQUFLO0FBQUEsSUFDSDtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0EsU0FBTztBQUNUO0FBRUEsU0FBUyxVQUFVLE9BQTJCLGFBQW1DO0FBQy9FLFFBQU0sTUFBTSxTQUFTLGNBQWMsS0FBSztBQUN4QyxNQUFJLFlBQVk7QUFDaEIsUUFBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLE9BQUssWUFBWTtBQUNqQixRQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsUUFBTSxZQUFZO0FBQ2xCLE1BQUksT0FBTztBQUNULFVBQU0sSUFBSSxTQUFTLGNBQWMsS0FBSztBQUN0QyxNQUFFLFlBQVk7QUFDZCxNQUFFLGNBQWM7QUFDaEIsVUFBTSxZQUFZLENBQUM7QUFBQSxFQUNyQjtBQUNBLE1BQUksYUFBYTtBQUNmLFVBQU0sSUFBSSxTQUFTLGNBQWMsS0FBSztBQUN0QyxNQUFFLFlBQVk7QUFDZCxNQUFFLGNBQWM7QUFDaEIsVUFBTSxZQUFZLENBQUM7QUFBQSxFQUNyQjtBQUNBLE9BQUssWUFBWSxLQUFLO0FBQ3RCLE1BQUksWUFBWSxJQUFJO0FBQ3BCLFNBQU87QUFDVDtBQU1BLFNBQVMsY0FDUCxTQUNBLFVBQ21CO0FBQ25CLFFBQU0sTUFBTSxTQUFTLGNBQWMsUUFBUTtBQUMzQyxNQUFJLE9BQU87QUFDWCxNQUFJLGFBQWEsUUFBUSxRQUFRO0FBRWpDLFFBQU0sT0FBTyxTQUFTLGNBQWMsTUFBTTtBQUMxQyxRQUFNLE9BQU8sU0FBUyxjQUFjLE1BQU07QUFDMUMsT0FBSyxZQUNIO0FBQ0YsT0FBSyxZQUFZLElBQUk7QUFFckIsUUFBTSxRQUFRLENBQUMsT0FBc0I7QUFDbkMsUUFBSSxhQUFhLGdCQUFnQixPQUFPLEVBQUUsQ0FBQztBQUMzQyxRQUFJLFFBQVEsUUFBUSxLQUFLLFlBQVk7QUFDckMsUUFBSSxZQUNGO0FBQ0YsU0FBSyxZQUFZLDJHQUNmLEtBQUsseUJBQXlCLHdCQUNoQztBQUNBLFNBQUssUUFBUSxRQUFRLEtBQUssWUFBWTtBQUN0QyxTQUFLLFFBQVEsUUFBUSxLQUFLLFlBQVk7QUFDdEMsU0FBSyxNQUFNLFlBQVksS0FBSyxxQkFBcUI7QUFBQSxFQUNuRDtBQUNBLFFBQU0sT0FBTztBQUViLE1BQUksWUFBWSxJQUFJO0FBQ3BCLE1BQUksaUJBQWlCLFNBQVMsT0FBTyxNQUFNO0FBQ3pDLE1BQUUsZUFBZTtBQUNqQixNQUFFLGdCQUFnQjtBQUNsQixVQUFNLE9BQU8sSUFBSSxhQUFhLGNBQWMsTUFBTTtBQUNsRCxVQUFNLElBQUk7QUFDVixRQUFJLFdBQVc7QUFDZixRQUFJO0FBQ0YsWUFBTSxTQUFTLElBQUk7QUFBQSxJQUNyQixVQUFFO0FBQ0EsVUFBSSxXQUFXO0FBQUEsSUFDakI7QUFBQSxFQUNGLENBQUM7QUFDRCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLE1BQW1CO0FBQzFCLFFBQU0sSUFBSSxTQUFTLGNBQWMsTUFBTTtBQUN2QyxJQUFFLFlBQVk7QUFDZCxJQUFFLGNBQWM7QUFDaEIsU0FBTztBQUNUO0FBSUEsU0FBUyxnQkFBd0I7QUFFL0IsU0FDRTtBQU9KO0FBRUEsU0FBUyxnQkFBd0I7QUFFL0IsU0FDRTtBQUtKO0FBRUEsU0FBUyxxQkFBNkI7QUFFcEMsU0FDRTtBQU1KO0FBRUEsZUFBZSxlQUNiLEtBQ0EsVUFDd0I7QUFDeEIsTUFBSSxtQkFBbUIsS0FBSyxHQUFHLEVBQUcsUUFBTztBQUd6QyxRQUFNLE1BQU0sSUFBSSxXQUFXLElBQUksSUFBSSxJQUFJLE1BQU0sQ0FBQyxJQUFJO0FBQ2xELE1BQUk7QUFDRixXQUFRLE1BQU0sNEJBQVk7QUFBQSxNQUN4QjtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLEVBQ0YsU0FBUyxHQUFHO0FBQ1YsU0FBSyxvQkFBb0IsRUFBRSxLQUFLLFVBQVUsS0FBSyxPQUFPLENBQUMsRUFBRSxDQUFDO0FBQzFELFdBQU87QUFBQSxFQUNUO0FBQ0Y7QUFJQSxTQUFTLHdCQUE0QztBQUVuRCxRQUFNLFFBQVEsTUFBTTtBQUFBLElBQ2xCLFNBQVMsaUJBQW9DLHVCQUF1QjtBQUFBLEVBQ3RFO0FBQ0EsTUFBSSxNQUFNLFVBQVUsR0FBRztBQUNyQixRQUFJLE9BQTJCLE1BQU0sQ0FBQyxFQUFFO0FBQ3hDLFdBQU8sTUFBTTtBQUNYLFlBQU0sU0FBUyxLQUFLLGlCQUFpQix1QkFBdUI7QUFDNUQsVUFBSSxPQUFPLFVBQVUsS0FBSyxJQUFJLEdBQUcsTUFBTSxTQUFTLENBQUMsRUFBRyxRQUFPO0FBQzNELGFBQU8sS0FBSztBQUFBLElBQ2Q7QUFBQSxFQUNGO0FBR0EsUUFBTSxRQUFRO0FBQUEsSUFDWjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxFQUNGO0FBQ0EsUUFBTSxVQUF5QixDQUFDO0FBQ2hDLFFBQU0sTUFBTSxTQUFTO0FBQUEsSUFDbkI7QUFBQSxFQUNGO0FBQ0EsYUFBVyxNQUFNLE1BQU0sS0FBSyxHQUFHLEdBQUc7QUFDaEMsVUFBTSxLQUFLLEdBQUcsZUFBZSxJQUFJLEtBQUs7QUFDdEMsUUFBSSxFQUFFLFNBQVMsR0FBSTtBQUNuQixRQUFJLE1BQU0sS0FBSyxDQUFDLE1BQU0sTUFBTSxDQUFDLEVBQUcsU0FBUSxLQUFLLEVBQUU7QUFDL0MsUUFBSSxRQUFRLFNBQVMsR0FBSTtBQUFBLEVBQzNCO0FBQ0EsTUFBSSxRQUFRLFVBQVUsR0FBRztBQUN2QixRQUFJLE9BQTJCLFFBQVEsQ0FBQyxFQUFFO0FBQzFDLFdBQU8sTUFBTTtBQUNYLFVBQUksUUFBUTtBQUNaLGlCQUFXLEtBQUssUUFBUyxLQUFJLEtBQUssU0FBUyxDQUFDLEVBQUc7QUFDL0MsVUFBSSxTQUFTLEtBQUssSUFBSSxHQUFHLFFBQVEsTUFBTSxFQUFHLFFBQU87QUFDakQsYUFBTyxLQUFLO0FBQUEsSUFDZDtBQUFBLEVBQ0Y7QUFDQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGtCQUFzQztBQUM3QyxRQUFNLFVBQVUsc0JBQXNCO0FBQ3RDLE1BQUksQ0FBQyxRQUFTLFFBQU87QUFDckIsTUFBSSxTQUFTLFFBQVE7QUFDckIsU0FBTyxRQUFRO0FBQ2IsZUFBVyxTQUFTLE1BQU0sS0FBSyxPQUFPLFFBQVEsR0FBb0I7QUFDaEUsVUFBSSxVQUFVLFdBQVcsTUFBTSxTQUFTLE9BQU8sRUFBRztBQUNsRCxZQUFNLElBQUksTUFBTSxzQkFBc0I7QUFDdEMsVUFBSSxFQUFFLFFBQVEsT0FBTyxFQUFFLFNBQVMsSUFBSyxRQUFPO0FBQUEsSUFDOUM7QUFDQSxhQUFTLE9BQU87QUFBQSxFQUNsQjtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsZUFBcUI7QUFDNUIsTUFBSTtBQUNGLFVBQU0sVUFBVSxzQkFBc0I7QUFDdEMsUUFBSSxXQUFXLENBQUMsTUFBTSxlQUFlO0FBQ25DLFlBQU0sZ0JBQWdCO0FBQ3RCLFlBQU0sU0FBUyxRQUFRLGlCQUFpQjtBQUN4QyxXQUFLLHNCQUFzQixPQUFPLFVBQVUsTUFBTSxHQUFHLElBQUssQ0FBQztBQUFBLElBQzdEO0FBQ0EsVUFBTSxVQUFVLGdCQUFnQjtBQUNoQyxRQUFJLENBQUMsU0FBUztBQUNaLFVBQUksTUFBTSxnQkFBZ0IsU0FBUyxNQUFNO0FBQ3ZDLGNBQU0sY0FBYyxTQUFTO0FBQzdCLGFBQUssMEJBQTBCO0FBQUEsVUFDN0IsS0FBSyxTQUFTO0FBQUEsVUFDZCxTQUFTLFVBQVUsU0FBUyxPQUFPLElBQUk7QUFBQSxRQUN6QyxDQUFDO0FBQUEsTUFDSDtBQUNBO0FBQUEsSUFDRjtBQUNBLFFBQUksUUFBNEI7QUFDaEMsZUFBVyxTQUFTLE1BQU0sS0FBSyxRQUFRLFFBQVEsR0FBb0I7QUFDakUsVUFBSSxNQUFNLFFBQVEsWUFBWSxlQUFnQjtBQUM5QyxVQUFJLE1BQU0sTUFBTSxZQUFZLE9BQVE7QUFDcEMsY0FBUTtBQUNSO0FBQUEsSUFDRjtBQUNBLFVBQU0sWUFBWSxVQUNkLE1BQU0sS0FBSyxRQUFRLGlCQUE4QixXQUFXLENBQUMsRUFBRTtBQUFBLE1BQzdELENBQUMsTUFDQyxFQUFFLGFBQWEsY0FBYyxNQUFNLFVBQ25DLEVBQUUsYUFBYSxhQUFhLE1BQU0sVUFDbEMsRUFBRSxhQUFhLGVBQWUsTUFBTSxVQUNwQyxFQUFFLFVBQVUsU0FBUyxRQUFRO0FBQUEsSUFDakMsSUFDQTtBQUNKLFVBQU0sVUFBVSxPQUFPO0FBQUEsTUFDckI7QUFBQSxJQUNGO0FBQ0EsVUFBTSxjQUFjLEdBQUcsV0FBVyxlQUFlLEVBQUUsSUFBSSxTQUFTLGVBQWUsRUFBRSxJQUFJLE9BQU8sU0FBUyxVQUFVLENBQUM7QUFDaEgsUUFBSSxNQUFNLGdCQUFnQixZQUFhO0FBQ3ZDLFVBQU0sY0FBYztBQUNwQixTQUFLLGFBQWE7QUFBQSxNQUNoQixLQUFLLFNBQVM7QUFBQSxNQUNkLFdBQVcsV0FBVyxhQUFhLEtBQUssS0FBSztBQUFBLE1BQzdDLFNBQVMsU0FBUyxhQUFhLEtBQUssS0FBSztBQUFBLE1BQ3pDLFNBQVMsU0FBUyxPQUFPO0FBQUEsSUFDM0IsQ0FBQztBQUNELFFBQUksT0FBTztBQUNULFlBQU0sT0FBTyxNQUFNO0FBQ25CO0FBQUEsUUFDRSxxQkFBcUIsV0FBVyxhQUFhLEtBQUssS0FBSyxHQUFHO0FBQUEsUUFDMUQsS0FBSyxNQUFNLEdBQUcsSUFBSztBQUFBLE1BQ3JCO0FBQUEsSUFDRjtBQUFBLEVBQ0YsU0FBUyxHQUFHO0FBQ1YsU0FBSyxvQkFBb0IsT0FBTyxDQUFDLENBQUM7QUFBQSxFQUNwQztBQUNGO0FBRUEsU0FBUyxTQUFTLElBQTBDO0FBQzFELFNBQU87QUFBQSxJQUNMLEtBQUssR0FBRztBQUFBLElBQ1IsS0FBSyxHQUFHLFVBQVUsTUFBTSxHQUFHLEdBQUc7QUFBQSxJQUM5QixJQUFJLEdBQUcsTUFBTTtBQUFBLElBQ2IsVUFBVSxHQUFHLFNBQVM7QUFBQSxJQUN0QixPQUFPLE1BQU07QUFDWCxZQUFNLElBQUksR0FBRyxzQkFBc0I7QUFDbkMsYUFBTyxFQUFFLEdBQUcsS0FBSyxNQUFNLEVBQUUsS0FBSyxHQUFHLEdBQUcsS0FBSyxNQUFNLEVBQUUsTUFBTSxFQUFFO0FBQUEsSUFDM0QsR0FBRztBQUFBLEVBQ0w7QUFDRjtBQUVBLFNBQVMsYUFBcUI7QUFDNUIsU0FDRyxPQUEwRCwwQkFDM0Q7QUFFSjs7O0FDaHdEQSxJQUFBQyxtQkFBNEI7QUFtQzVCLElBQU0sU0FBUyxvQkFBSSxJQUFtQztBQUN0RCxJQUFJLGNBQWdDO0FBRXBDLGVBQXNCLGlCQUFnQztBQUNwRCxRQUFNLFNBQVUsTUFBTSw2QkFBWSxPQUFPLHFCQUFxQjtBQUM5RCxRQUFNLFFBQVMsTUFBTSw2QkFBWSxPQUFPLG9CQUFvQjtBQUM1RCxnQkFBYztBQUlkLGtCQUFnQixNQUFNO0FBRXRCLEVBQUMsT0FBMEQseUJBQ3pELE1BQU07QUFFUixhQUFXLEtBQUssUUFBUTtBQUN0QixRQUFJLEVBQUUsU0FBUyxVQUFVLE9BQVE7QUFDakMsUUFBSSxDQUFDLEVBQUUsWUFBYTtBQUNwQixRQUFJLENBQUMsRUFBRSxRQUFTO0FBQ2hCLFFBQUk7QUFDRixZQUFNLFVBQVUsR0FBRyxLQUFLO0FBQUEsSUFDMUIsU0FBUyxHQUFHO0FBQ1YsY0FBUSxNQUFNLHVDQUF1QyxFQUFFLFNBQVMsSUFBSSxDQUFDO0FBQUEsSUFDdkU7QUFBQSxFQUNGO0FBRUEsVUFBUTtBQUFBLElBQ04seUNBQXlDLE9BQU8sSUFBSTtBQUFBLElBQ3BELENBQUMsR0FBRyxPQUFPLEtBQUssQ0FBQyxFQUFFLEtBQUssSUFBSSxLQUFLO0FBQUEsRUFDbkM7QUFDQSwrQkFBWTtBQUFBLElBQ1Y7QUFBQSxJQUNBO0FBQUEsSUFDQSx3QkFBd0IsT0FBTyxJQUFJLGNBQWMsQ0FBQyxHQUFHLE9BQU8sS0FBSyxDQUFDLEVBQUUsS0FBSyxJQUFJLEtBQUssUUFBUTtBQUFBLEVBQzVGO0FBQ0Y7QUFPTyxTQUFTLG9CQUEwQjtBQUN4QyxhQUFXLENBQUMsSUFBSSxDQUFDLEtBQUssUUFBUTtBQUM1QixRQUFJO0FBQ0YsUUFBRSxPQUFPO0FBQUEsSUFDWCxTQUFTLEdBQUc7QUFDVixjQUFRLEtBQUssdUNBQXVDLElBQUksQ0FBQztBQUFBLElBQzNEO0FBQUEsRUFDRjtBQUNBLFNBQU8sTUFBTTtBQUNiLGdCQUFjO0FBQ2hCO0FBRUEsZUFBZSxVQUFVLEdBQWdCLE9BQWlDO0FBQ3hFLFFBQU0sU0FBVSxNQUFNLDZCQUFZO0FBQUEsSUFDaEM7QUFBQSxJQUNBLEVBQUU7QUFBQSxFQUNKO0FBS0EsUUFBTUMsVUFBUyxFQUFFLFNBQVMsQ0FBQyxFQUFpQztBQUM1RCxRQUFNQyxXQUFVRCxRQUFPO0FBRXZCLFFBQU0sS0FBSyxJQUFJO0FBQUEsSUFDYjtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxHQUFHLE1BQU07QUFBQSxnQ0FBbUMsbUJBQW1CLEVBQUUsU0FBUyxFQUFFLENBQUMsSUFBSSxtQkFBbUIsRUFBRSxLQUFLLENBQUM7QUFBQSxFQUM5RztBQUNBLEtBQUdBLFNBQVFDLFVBQVMsT0FBTztBQUMzQixRQUFNLE1BQU1ELFFBQU87QUFDbkIsUUFBTSxRQUFnQixJQUE0QixXQUFZO0FBQzlELE1BQUksT0FBTyxPQUFPLFVBQVUsWUFBWTtBQUN0QyxVQUFNLElBQUksTUFBTSxTQUFTLEVBQUUsU0FBUyxFQUFFLGlCQUFpQjtBQUFBLEVBQ3pEO0FBQ0EsUUFBTSxNQUFNLGdCQUFnQixFQUFFLFVBQVUsS0FBSztBQUM3QyxRQUFNLE1BQU0sTUFBTSxHQUFHO0FBQ3JCLFNBQU8sSUFBSSxFQUFFLFNBQVMsSUFBSSxFQUFFLE1BQU0sTUFBTSxNQUFNLEtBQUssS0FBSyxFQUFFLENBQUM7QUFDN0Q7QUFFQSxTQUFTLGdCQUFnQixVQUF5QixPQUE0QjtBQUM1RSxRQUFNLEtBQUssU0FBUztBQUNwQixRQUFNLE1BQU0sQ0FBQyxVQUErQyxNQUFpQjtBQUMzRSxVQUFNLFlBQ0osVUFBVSxVQUFVLFFBQVEsUUFDMUIsVUFBVSxTQUFTLFFBQVEsT0FDM0IsVUFBVSxVQUFVLFFBQVEsUUFDNUIsUUFBUTtBQUNaLGNBQVUsb0JBQW9CLEVBQUUsS0FBSyxHQUFHLENBQUM7QUFHekMsUUFBSTtBQUNGLFlBQU0sUUFBUSxFQUFFLElBQUksQ0FBQyxNQUFNO0FBQ3pCLFlBQUksT0FBTyxNQUFNLFNBQVUsUUFBTztBQUNsQyxZQUFJLGFBQWEsTUFBTyxRQUFPLEdBQUcsRUFBRSxJQUFJLEtBQUssRUFBRSxPQUFPO0FBQ3RELFlBQUk7QUFBRSxpQkFBTyxLQUFLLFVBQVUsQ0FBQztBQUFBLFFBQUcsUUFBUTtBQUFFLGlCQUFPLE9BQU8sQ0FBQztBQUFBLFFBQUc7QUFBQSxNQUM5RCxDQUFDO0FBQ0QsbUNBQVk7QUFBQSxRQUNWO0FBQUEsUUFDQTtBQUFBLFFBQ0EsVUFBVSxFQUFFLEtBQUssTUFBTSxLQUFLLEdBQUcsQ0FBQztBQUFBLE1BQ2xDO0FBQUEsSUFDRixRQUFRO0FBQUEsSUFFUjtBQUFBLEVBQ0Y7QUFFQSxTQUFPO0FBQUEsSUFDTDtBQUFBLElBQ0EsU0FBUztBQUFBLElBQ1QsS0FBSztBQUFBLE1BQ0gsT0FBTyxJQUFJLE1BQU0sSUFBSSxTQUFTLEdBQUcsQ0FBQztBQUFBLE1BQ2xDLE1BQU0sSUFBSSxNQUFNLElBQUksUUFBUSxHQUFHLENBQUM7QUFBQSxNQUNoQyxNQUFNLElBQUksTUFBTSxJQUFJLFFBQVEsR0FBRyxDQUFDO0FBQUEsTUFDaEMsT0FBTyxJQUFJLE1BQU0sSUFBSSxTQUFTLEdBQUcsQ0FBQztBQUFBLElBQ3BDO0FBQUEsSUFDQSxTQUFTLGdCQUFnQixFQUFFO0FBQUEsSUFDM0IsVUFBVTtBQUFBLE1BQ1IsVUFBVSxDQUFDLE1BQU0sZ0JBQWdCLEVBQUUsR0FBRyxHQUFHLElBQUksR0FBRyxFQUFFLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQztBQUFBLE1BQzlELGNBQWMsQ0FBQyxNQUNiLGFBQWEsSUFBSSxVQUFVLEVBQUUsR0FBRyxHQUFHLElBQUksR0FBRyxFQUFFLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQztBQUFBLElBQzVEO0FBQUEsSUFDQSxPQUFPO0FBQUEsTUFDTCxVQUFVLENBQUMsTUFBTSxhQUFhLENBQUM7QUFBQSxNQUMvQixpQkFBaUIsQ0FBQyxHQUFHLFNBQVM7QUFDNUIsWUFBSSxJQUFJLGFBQWEsQ0FBQztBQUN0QixlQUFPLEdBQUc7QUFDUixnQkFBTSxJQUFJLEVBQUU7QUFDWixjQUFJLE1BQU0sRUFBRSxnQkFBZ0IsUUFBUSxFQUFFLFNBQVMsTUFBTyxRQUFPO0FBQzdELGNBQUksRUFBRTtBQUFBLFFBQ1I7QUFDQSxlQUFPO0FBQUEsTUFDVDtBQUFBLE1BQ0EsZ0JBQWdCLENBQUMsS0FBSyxZQUFZLFFBQ2hDLElBQUksUUFBUSxDQUFDLFNBQVMsV0FBVztBQUMvQixjQUFNLFdBQVcsU0FBUyxjQUFjLEdBQUc7QUFDM0MsWUFBSSxTQUFVLFFBQU8sUUFBUSxRQUFRO0FBQ3JDLGNBQU0sV0FBVyxLQUFLLElBQUksSUFBSTtBQUM5QixjQUFNLE1BQU0sSUFBSSxpQkFBaUIsTUFBTTtBQUNyQyxnQkFBTSxLQUFLLFNBQVMsY0FBYyxHQUFHO0FBQ3JDLGNBQUksSUFBSTtBQUNOLGdCQUFJLFdBQVc7QUFDZixvQkFBUSxFQUFFO0FBQUEsVUFDWixXQUFXLEtBQUssSUFBSSxJQUFJLFVBQVU7QUFDaEMsZ0JBQUksV0FBVztBQUNmLG1CQUFPLElBQUksTUFBTSx1QkFBdUIsR0FBRyxFQUFFLENBQUM7QUFBQSxVQUNoRDtBQUFBLFFBQ0YsQ0FBQztBQUNELFlBQUksUUFBUSxTQUFTLGlCQUFpQixFQUFFLFdBQVcsTUFBTSxTQUFTLEtBQUssQ0FBQztBQUFBLE1BQzFFLENBQUM7QUFBQSxJQUNMO0FBQUEsSUFDQSxLQUFLO0FBQUEsTUFDSCxJQUFJLENBQUMsR0FBRyxNQUFNO0FBQ1osY0FBTSxVQUFVLENBQUMsT0FBZ0IsU0FBb0IsRUFBRSxHQUFHLElBQUk7QUFDOUQscUNBQVksR0FBRyxXQUFXLEVBQUUsSUFBSSxDQUFDLElBQUksT0FBTztBQUM1QyxlQUFPLE1BQU0sNkJBQVksZUFBZSxXQUFXLEVBQUUsSUFBSSxDQUFDLElBQUksT0FBTztBQUFBLE1BQ3ZFO0FBQUEsTUFDQSxNQUFNLENBQUMsTUFBTSxTQUFTLDZCQUFZLEtBQUssV0FBVyxFQUFFLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSTtBQUFBLE1BQ3BFLFFBQVEsQ0FBSSxNQUFjLFNBQ3hCLDZCQUFZLE9BQU8sV0FBVyxFQUFFLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSTtBQUFBLElBQ3BEO0FBQUEsSUFDQSxJQUFJLFdBQVcsSUFBSSxLQUFLO0FBQUEsRUFDMUI7QUFDRjtBQUVBLFNBQVMsZ0JBQWdCLElBQVk7QUFDbkMsUUFBTSxNQUFNLG1CQUFtQixFQUFFO0FBQ2pDLFFBQU0sT0FBTyxNQUErQjtBQUMxQyxRQUFJO0FBQ0YsYUFBTyxLQUFLLE1BQU0sYUFBYSxRQUFRLEdBQUcsS0FBSyxJQUFJO0FBQUEsSUFDckQsUUFBUTtBQUNOLGFBQU8sQ0FBQztBQUFBLElBQ1Y7QUFBQSxFQUNGO0FBQ0EsUUFBTSxRQUFRLENBQUMsTUFDYixhQUFhLFFBQVEsS0FBSyxLQUFLLFVBQVUsQ0FBQyxDQUFDO0FBQzdDLFNBQU87QUFBQSxJQUNMLEtBQUssQ0FBSSxHQUFXLE1BQVcsS0FBSyxLQUFLLElBQUssS0FBSyxFQUFFLENBQUMsSUFBVztBQUFBLElBQ2pFLEtBQUssQ0FBQyxHQUFXLE1BQWU7QUFDOUIsWUFBTSxJQUFJLEtBQUs7QUFDZixRQUFFLENBQUMsSUFBSTtBQUNQLFlBQU0sQ0FBQztBQUFBLElBQ1Q7QUFBQSxJQUNBLFFBQVEsQ0FBQyxNQUFjO0FBQ3JCLFlBQU0sSUFBSSxLQUFLO0FBQ2YsYUFBTyxFQUFFLENBQUM7QUFDVixZQUFNLENBQUM7QUFBQSxJQUNUO0FBQUEsSUFDQSxLQUFLLE1BQU0sS0FBSztBQUFBLEVBQ2xCO0FBQ0Y7QUFFQSxTQUFTLFdBQVcsSUFBWSxRQUFtQjtBQUVqRCxTQUFPO0FBQUEsSUFDTCxTQUFTLHVCQUF1QixFQUFFO0FBQUEsSUFDbEMsTUFBTSxDQUFDLE1BQ0wsNkJBQVksT0FBTyxvQkFBb0IsUUFBUSxJQUFJLENBQUM7QUFBQSxJQUN0RCxPQUFPLENBQUMsR0FBVyxNQUNqQiw2QkFBWSxPQUFPLG9CQUFvQixTQUFTLElBQUksR0FBRyxDQUFDO0FBQUEsSUFDMUQsUUFBUSxDQUFDLE1BQ1AsNkJBQVksT0FBTyxvQkFBb0IsVUFBVSxJQUFJLENBQUM7QUFBQSxFQUMxRDtBQUNGOzs7QUN2UEEsSUFBQUUsbUJBQTRCO0FBRzVCLGVBQXNCLGVBQThCO0FBQ2xELFFBQU0sU0FBVSxNQUFNLDZCQUFZLE9BQU8scUJBQXFCO0FBSTlELFFBQU0sUUFBUyxNQUFNLDZCQUFZLE9BQU8sb0JBQW9CO0FBTTVELGtCQUFnQjtBQUFBLElBQ2QsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLElBQ1AsYUFBYSxHQUFHLE9BQU8sTUFBTSxrQ0FBa0MsTUFBTSxRQUFRO0FBQUEsSUFDN0UsT0FBT0MsT0FBTTtBQUNYLE1BQUFBLE1BQUssTUFBTSxVQUFVO0FBRXJCLFlBQU0sVUFBVSxTQUFTLGNBQWMsS0FBSztBQUM1QyxjQUFRLE1BQU0sVUFBVTtBQUN4QixjQUFRO0FBQUEsUUFDTjtBQUFBLFVBQU87QUFBQSxVQUFzQixNQUMzQiw2QkFBWSxPQUFPLGtCQUFrQixNQUFNLFNBQVMsRUFBRSxNQUFNLE1BQU07QUFBQSxVQUFDLENBQUM7QUFBQSxRQUN0RTtBQUFBLE1BQ0Y7QUFDQSxjQUFRO0FBQUEsUUFDTjtBQUFBLFVBQU87QUFBQSxVQUFhLE1BQ2xCLDZCQUFZLE9BQU8sa0JBQWtCLE1BQU0sTUFBTSxFQUFFLE1BQU0sTUFBTTtBQUFBLFVBQUMsQ0FBQztBQUFBLFFBQ25FO0FBQUEsTUFDRjtBQUNBLGNBQVE7QUFBQSxRQUNOLE9BQU8saUJBQWlCLE1BQU0sU0FBUyxPQUFPLENBQUM7QUFBQSxNQUNqRDtBQUNBLE1BQUFBLE1BQUssWUFBWSxPQUFPO0FBRXhCLFVBQUksT0FBTyxXQUFXLEdBQUc7QUFDdkIsY0FBTSxRQUFRLFNBQVMsY0FBYyxHQUFHO0FBQ3hDLGNBQU0sTUFBTSxVQUFVO0FBQ3RCLGNBQU0sY0FDSjtBQUNGLFFBQUFBLE1BQUssWUFBWSxLQUFLO0FBQ3RCO0FBQUEsTUFDRjtBQUVBLFlBQU0sT0FBTyxTQUFTLGNBQWMsSUFBSTtBQUN4QyxXQUFLLE1BQU0sVUFBVTtBQUNyQixpQkFBVyxLQUFLLFFBQVE7QUFDdEIsY0FBTSxLQUFLLFNBQVMsY0FBYyxJQUFJO0FBQ3RDLFdBQUcsTUFBTSxVQUNQO0FBQ0YsY0FBTSxPQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ3pDLGFBQUssWUFBWTtBQUFBLGtEQUN5QixPQUFPLEVBQUUsU0FBUyxJQUFJLENBQUMsK0NBQStDLE9BQU8sRUFBRSxTQUFTLE9BQU8sQ0FBQztBQUFBLHlEQUN6RixPQUFPLEVBQUUsU0FBUyxlQUFlLEVBQUUsU0FBUyxFQUFFLENBQUM7QUFBQTtBQUVoRyxjQUFNLFFBQVEsU0FBUyxjQUFjLEtBQUs7QUFDMUMsY0FBTSxNQUFNLFVBQVU7QUFDdEIsY0FBTSxjQUFjLEVBQUUsY0FBYyxXQUFXO0FBQy9DLFdBQUcsT0FBTyxNQUFNLEtBQUs7QUFDckIsYUFBSyxPQUFPLEVBQUU7QUFBQSxNQUNoQjtBQUNBLE1BQUFBLE1BQUssT0FBTyxJQUFJO0FBQUEsSUFDbEI7QUFBQSxFQUNGLENBQUM7QUFDSDtBQUVBLFNBQVMsT0FBTyxPQUFlLFNBQXdDO0FBQ3JFLFFBQU0sSUFBSSxTQUFTLGNBQWMsUUFBUTtBQUN6QyxJQUFFLE9BQU87QUFDVCxJQUFFLGNBQWM7QUFDaEIsSUFBRSxNQUFNLFVBQ047QUFDRixJQUFFLGlCQUFpQixTQUFTLE9BQU87QUFDbkMsU0FBTztBQUNUO0FBRUEsU0FBUyxPQUFPLEdBQW1CO0FBQ2pDLFNBQU8sRUFBRTtBQUFBLElBQVE7QUFBQSxJQUFZLENBQUMsTUFDNUIsTUFBTSxNQUNGLFVBQ0EsTUFBTSxNQUNKLFNBQ0EsTUFBTSxNQUNKLFNBQ0EsTUFBTSxNQUNKLFdBQ0E7QUFBQSxFQUNaO0FBQ0Y7OztBQ25HQSxJQUFBQyxtQkFBNEI7QUFFNUIsSUFBTSwwQkFBMEI7QUFDaEMsSUFBTSx5QkFBeUI7QUFDL0IsSUFBTSw2QkFBNkI7QUEyQm5DLElBQUksZ0JBQWdCO0FBQ3BCLElBQU0sa0JBQWtCLG9CQUFJLElBQTRCO0FBQ3hELElBQU0sd0JBQXdCLG9CQUFJLElBQW1EO0FBQ3JGLElBQUksYUFBYTtBQUVWLFNBQVMsaUJBQ2QsUUFDQSxRQUNBLFVBQW1DLENBQUMsR0FDeEI7QUFDWixtQkFBaUI7QUFDakIsUUFBTSxLQUFLLFdBQVcsS0FBSyxJQUFJLENBQUMsSUFBSSxlQUFlO0FBQ25ELFFBQU0sU0FBUyxRQUFRLFVBQVUsV0FBVztBQUM1QyxRQUFNLFlBQVksUUFBUSxhQUFhO0FBRXZDLFNBQU8sSUFBSSxRQUFXLENBQUMsU0FBUyxXQUFXO0FBQ3pDLFVBQU0sVUFBVSxXQUFXLE1BQU07QUFDL0Isc0JBQWdCLE9BQU8sRUFBRTtBQUN6QixhQUFPLElBQUksTUFBTSxnREFBZ0QsTUFBTSxFQUFFLENBQUM7QUFBQSxJQUM1RSxHQUFHLFNBQVM7QUFFWixvQkFBZ0IsSUFBSSxJQUFJO0FBQUEsTUFDdEI7QUFBQSxNQUNBLFNBQVMsQ0FBQyxVQUFVLFFBQVEsS0FBVTtBQUFBLE1BQ3RDO0FBQUEsTUFDQTtBQUFBLElBQ0YsQ0FBQztBQUVELFVBQU0sVUFBVTtBQUFBLE1BQ2QsTUFBTTtBQUFBLE1BQ047QUFBQSxNQUNBLFNBQVMsRUFBRSxJQUFJLFFBQVEsT0FBTztBQUFBLElBQ2hDO0FBRUEsd0JBQW9CLE9BQU8sRUFBRSxLQUFLLENBQUMsYUFBYTtBQUM5QyxVQUFJLGFBQWEsT0FBVyx1QkFBc0IsUUFBUTtBQUFBLElBQzVELENBQUMsRUFBRSxNQUFNLENBQUMsVUFBVTtBQUNsQixZQUFNLFVBQVUsZ0JBQWdCLElBQUksRUFBRTtBQUN0QyxVQUFJLENBQUMsUUFBUztBQUNkLG1CQUFhLFFBQVEsT0FBTztBQUM1QixzQkFBZ0IsT0FBTyxFQUFFO0FBQ3pCLGNBQVEsT0FBTyxRQUFRLEtBQUssQ0FBQztBQUFBLElBQy9CLENBQUM7QUFBQSxFQUNILENBQUM7QUFDSDtBQUVPLFNBQVMsd0JBQ2QsVUFDWTtBQUNaLG1CQUFpQjtBQUNqQix3QkFBc0IsSUFBSSxRQUFRO0FBQ2xDLFNBQU8sTUFBTSxzQkFBc0IsT0FBTyxRQUFRO0FBQ3BEO0FBRU8sU0FBUyxhQUFxQjtBQUNuQyxNQUFJO0FBQ0YsVUFBTSxNQUFNLElBQUksSUFBSSxTQUFTLElBQUk7QUFDakMsVUFBTSxTQUFTLElBQUksYUFBYSxJQUFJLFFBQVEsR0FBRyxLQUFLO0FBQ3BELFdBQU8sVUFBVTtBQUFBLEVBQ25CLFFBQVE7QUFDTixXQUFPO0FBQUEsRUFDVDtBQUNGO0FBRUEsU0FBUyxtQkFBeUI7QUFDaEMsTUFBSSxXQUFZO0FBQ2hCLGVBQWE7QUFDYiwrQkFBWSxHQUFHLHdCQUF3QixDQUFDLFFBQVEsWUFBWTtBQUMxRCwwQkFBc0IsT0FBTztBQUFBLEVBQy9CLENBQUM7QUFDRCxTQUFPLGlCQUFpQixXQUFXLENBQUMsVUFBVTtBQUM1QywwQkFBc0IsTUFBTSxJQUFJO0FBQUEsRUFDbEMsQ0FBQztBQUNIO0FBRUEsU0FBUyxzQkFBc0IsU0FBd0I7QUFDckQsUUFBTSxlQUFlLG9CQUFvQixPQUFPO0FBQ2hELE1BQUksY0FBYztBQUNoQixlQUFXLFlBQVksdUJBQXVCO0FBQzVDLFVBQUk7QUFDRixpQkFBUyxZQUFZO0FBQUEsTUFDdkIsUUFBUTtBQUFBLE1BRVI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFFBQU0sV0FBVyxnQkFBZ0IsT0FBTztBQUN4QyxNQUFJLENBQUMsU0FBVTtBQUNmLFFBQU0sVUFBVSxnQkFBZ0IsSUFBSSxTQUFTLEVBQUU7QUFDL0MsTUFBSSxDQUFDLFFBQVM7QUFFZCxlQUFhLFFBQVEsT0FBTztBQUM1QixrQkFBZ0IsT0FBTyxTQUFTLEVBQUU7QUFDbEMsTUFBSSxTQUFTLE9BQU87QUFDbEIsWUFBUSxPQUFPLFNBQVMsS0FBSztBQUM3QjtBQUFBLEVBQ0Y7QUFDQSxVQUFRLFFBQVEsU0FBUyxNQUFNO0FBQ2pDO0FBRUEsU0FBUyxnQkFBZ0IsU0FBMEU7QUFDakcsTUFBSSxDQUFDLFNBQVMsT0FBTyxFQUFHLFFBQU87QUFFL0IsTUFBSSxRQUFRLFNBQVMsa0JBQWtCLFNBQVMsUUFBUSxRQUFRLEdBQUc7QUFDakUsV0FBTyxxQkFBcUIsUUFBUSxRQUFRO0FBQUEsRUFDOUM7QUFFQSxNQUFJLFFBQVEsU0FBUyxrQkFBa0IsU0FBUyxRQUFRLE9BQU8sR0FBRztBQUNoRSxXQUFPLHFCQUFxQixRQUFRLE9BQU87QUFBQSxFQUM3QztBQUVBLE1BQUksUUFBUSxTQUFTLGVBQWUsT0FBTyxRQUFRLE9BQU8sVUFBVTtBQUNsRSxXQUFPLEVBQUUsSUFBSSxRQUFRLElBQUksT0FBTyxJQUFJLE1BQU0saUJBQWlCLFFBQVEsS0FBSyxLQUFLLDJCQUEyQixFQUFFO0FBQUEsRUFDNUc7QUFFQSxNQUFJLFFBQVEsU0FBUyxjQUFjLE9BQU8sUUFBUSxPQUFPLFVBQVU7QUFDakUsV0FBTyxxQkFBcUIsT0FBTztBQUFBLEVBQ3JDO0FBRUEsTUFBSSxPQUFPLFFBQVEsT0FBTyxhQUFhLFlBQVksV0FBVyxXQUFXLFVBQVU7QUFDakYsV0FBTyxxQkFBcUIsT0FBTztBQUFBLEVBQ3JDO0FBRUEsU0FBTztBQUNUO0FBRUEsU0FBUyxxQkFBcUIsVUFBMkY7QUFDdkgsUUFBTSxLQUFLLE9BQU8sU0FBUyxPQUFPLFlBQVksT0FBTyxTQUFTLE9BQU8sV0FDakUsT0FBTyxTQUFTLEVBQUUsSUFDbEI7QUFDSixNQUFJLENBQUMsR0FBSSxRQUFPO0FBRWhCLE1BQUksV0FBVyxVQUFVO0FBQ3ZCLFdBQU8sRUFBRSxJQUFJLE9BQU8sSUFBSSxNQUFNLGlCQUFpQixTQUFTLEtBQUssS0FBSywyQkFBMkIsRUFBRTtBQUFBLEVBQ2pHO0FBRUEsU0FBTyxFQUFFLElBQUksUUFBUSxTQUFTLE9BQU87QUFDdkM7QUFFQSxTQUFTLG9CQUFvQixTQUFnRDtBQUMzRSxNQUFJLENBQUMsU0FBUyxPQUFPLEVBQUcsUUFBTztBQUUvQixNQUFJLFFBQVEsU0FBUyxzQkFBc0IsU0FBUyxRQUFRLE9BQU8sR0FBRztBQUNwRSxVQUFNLFNBQVMsUUFBUSxRQUFRO0FBQy9CLFFBQUksT0FBTyxXQUFXLFVBQVU7QUFDOUIsYUFBTyxFQUFFLFFBQVEsUUFBUSxRQUFRLFFBQVEsT0FBTztBQUFBLElBQ2xEO0FBQUEsRUFDRjtBQUVBLE1BQUksUUFBUSxTQUFTLHNCQUFzQixTQUFTLFFBQVEsT0FBTyxHQUFHO0FBQ3BFLFVBQU0sU0FBUyxRQUFRLFFBQVE7QUFDL0IsUUFBSSxPQUFPLFdBQVcsVUFBVTtBQUM5QixhQUFPLEVBQUUsUUFBUSxRQUFRLFFBQVEsUUFBUSxPQUFPO0FBQUEsSUFDbEQ7QUFBQSxFQUNGO0FBRUEsTUFBSSxRQUFRLFNBQVMsc0JBQXNCLE9BQU8sUUFBUSxXQUFXLFVBQVU7QUFDN0UsV0FBTyxFQUFFLFFBQVEsUUFBUSxRQUFRLFFBQVEsUUFBUSxPQUFPO0FBQUEsRUFDMUQ7QUFFQSxNQUFJLE9BQU8sUUFBUSxXQUFXLFlBQVksRUFBRSxRQUFRLFVBQVU7QUFDNUQsV0FBTyxFQUFFLFFBQVEsUUFBUSxRQUFRLFFBQVEsUUFBUSxPQUFPO0FBQUEsRUFDMUQ7QUFFQSxTQUFPO0FBQ1Q7QUFFQSxTQUFTLGlCQUFpQixPQUErQjtBQUN2RCxNQUFJLGlCQUFpQixNQUFPLFFBQU8sTUFBTTtBQUN6QyxNQUFJLE9BQU8sVUFBVSxTQUFVLFFBQU87QUFDdEMsTUFBSSxTQUFTLEtBQUssR0FBRztBQUNuQixRQUFJLE9BQU8sTUFBTSxZQUFZLFNBQVUsUUFBTyxNQUFNO0FBQ3BELFFBQUksT0FBTyxNQUFNLFVBQVUsU0FBVSxRQUFPLE1BQU07QUFBQSxFQUNwRDtBQUNBLFNBQU87QUFDVDtBQUVBLFNBQVMsb0JBQW9CLFNBQW9DO0FBQy9ELFFBQU0sZUFBZSxPQUFPLGdCQUFnQjtBQUM1QyxNQUFJLE9BQU8saUJBQWlCLFlBQVk7QUFDdEMsV0FBTyxhQUFhLEtBQUssT0FBTyxnQkFBZ0IsT0FBTyxFQUFFLEtBQUssTUFBTSxNQUFTO0FBQUEsRUFDL0U7QUFDQSxTQUFPLDZCQUFZLE9BQU8seUJBQXlCLE9BQU87QUFDNUQ7QUFFQSxTQUFTLFFBQVEsT0FBdUI7QUFDdEMsU0FBTyxpQkFBaUIsUUFBUSxRQUFRLElBQUksTUFBTSxPQUFPLEtBQUssQ0FBQztBQUNqRTtBQUVBLFNBQVMsU0FBUyxPQUFrRDtBQUNsRSxTQUFPLFVBQVUsUUFBUSxPQUFPLFVBQVUsWUFBWSxDQUFDLE1BQU0sUUFBUSxLQUFLO0FBQzVFOzs7QUM1S0EsSUFBSSxVQUFVO0FBQ2QsSUFBSSxPQUE4QjtBQUNsQyxJQUFJLGlCQUF3QztBQUM1QyxJQUFJLGNBQWlDO0FBQ3JDLElBQUksWUFBa0Q7QUFDdEQsSUFBSSxlQUE4QjtBQUNsQyxJQUFJLG1CQUE0QztBQUNoRCxJQUFJLFlBQWtDO0FBRXRDLElBQU0sdUJBQXVCO0FBQzdCLElBQUksYUFBNkIsbUJBQW1CO0FBRTdDLFNBQVMsaUJBQWlCLE1BQWdELE1BQU07QUFBQyxHQUFTO0FBQy9GLE1BQUksUUFBUztBQUNiLFlBQVU7QUFDVixnQkFBYztBQUNkLFdBQVMsaUJBQWlCLFdBQVcsQ0FBQyxVQUFVO0FBQzlDLFNBQUssY0FBYyxPQUFPLEdBQUc7QUFBQSxFQUMvQixHQUFHLElBQUk7QUFDUCxXQUFTLGlCQUFpQixTQUFTLENBQUMsVUFBVTtBQUM1Qyx5QkFBcUIsbUJBQW1CLEtBQUssQ0FBQztBQUFBLEVBQ2hELEdBQUcsSUFBSTtBQUNQLFdBQVMsaUJBQWlCLFdBQVcsQ0FBQyxVQUFVO0FBQzlDLHlCQUFxQixtQkFBbUIsS0FBSyxDQUFDO0FBQUEsRUFDaEQsR0FBRyxJQUFJO0FBQ1AsV0FBUyxpQkFBaUIsU0FBUyxDQUFDLFVBQVU7QUFDNUMsUUFBSSxnQkFBZ0IsU0FBUyxNQUFNLE1BQWMsRUFBRztBQUNwRCx5QkFBcUIsbUJBQW1CLEtBQUssQ0FBQztBQUFBLEVBQ2hELEdBQUcsSUFBSTtBQUNQLFNBQU8saUJBQWlCLFVBQVUsTUFBTTtBQUN0QyxRQUFJLENBQUMsTUFBTSxZQUFhO0FBQ3hCLDZCQUF5QixJQUFJO0FBQzdCLDJCQUF1QixJQUFJO0FBQUEsRUFDN0IsQ0FBQztBQUNELDBCQUF3QixDQUFDLGlCQUFpQjtBQUN4QyxRQUFJLGFBQWEsV0FBVyx5QkFBeUJDLFVBQVMsYUFBYSxNQUFNLEdBQUc7QUFDbEYsWUFBTSxPQUFPLGFBQWEsT0FBTztBQUNqQyxVQUFJLGFBQWEsSUFBSSxHQUFHO0FBQ3RCLFlBQUksS0FBSyxhQUFhLGFBQWEsRUFBRztBQUN0QyxzQkFBYztBQUNkLG1CQUFXLE1BQU0sRUFBRSxXQUFXLE1BQU0sQ0FBQztBQUFBLE1BQ3ZDO0FBQ0E7QUFBQSxJQUNGO0FBQ0EsUUFBSSxhQUFhLFdBQVcseUJBQXlCQSxVQUFTLGFBQWEsTUFBTSxHQUFHO0FBQ2xGLFlBQU0sV0FBVyxhQUFhLE9BQU87QUFDckMsVUFBSSxPQUFPLGFBQWEsWUFBWSxhQUFhLGFBQWEsR0FBRztBQUMvRCxzQkFBYztBQUNkLHFCQUFhLGdCQUFnQiwyQ0FBMkM7QUFBQSxNQUMxRTtBQUFBLElBQ0Y7QUFBQSxFQUNGLENBQUM7QUFFRCxTQUFPLGlCQUFpQixZQUFZLE1BQU0sb0JBQW9CLEdBQUcsQ0FBQztBQUNsRSxRQUFNLGVBQWUsWUFBWSxNQUFNLG9CQUFvQixHQUFHLEdBQUcsSUFBSztBQUN0RSxRQUFNLFFBQVMsYUFBbUQ7QUFDbEUsTUFBSSxPQUFPLFVBQVUsV0FBWSxPQUFNLEtBQUssWUFBWTtBQUN4RCxpQkFBZSxNQUFNLG9CQUFvQixHQUFHLENBQUM7QUFDN0MsTUFBSSxzQkFBc0I7QUFDNUI7QUFFQSxlQUFlLGNBQWMsT0FBc0IsS0FBOEQ7QUFDL0csTUFBSSxNQUFNLFlBQWE7QUFFdkIsUUFBTSxXQUFXLG1CQUFtQixLQUFLO0FBQ3pDLE1BQUksQ0FBQyxTQUFVO0FBRWYsTUFBSSxNQUFNLFFBQVEsVUFBVTtBQUMxQix1QkFBbUI7QUFDbkI7QUFBQSxFQUNGO0FBRUEsT0FBSyxNQUFNLFFBQVEsU0FBUyxNQUFNLFFBQVEsWUFBWSxDQUFDLE1BQU0sWUFBWSxDQUFDLE1BQU0sVUFBVSxDQUFDLE1BQU0sV0FBVyxDQUFDLE1BQU0sU0FBUztBQUMxSCxVQUFNLGFBQWEsb0JBQW9CLFNBQVMsUUFBUSxDQUFDO0FBQ3pELFFBQUksY0FBYyxTQUFTLFFBQVEsRUFBRSxLQUFLLE1BQU0sU0FBUztBQUN2RCxZQUFNLGVBQWU7QUFDckIsWUFBTSxnQkFBZ0I7QUFDdEIsWUFBTSx5QkFBeUI7QUFDL0IsMEJBQW9CLFFBQVE7QUFDNUI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLE1BQUksTUFBTSxRQUFRLFdBQVcsTUFBTSxZQUFZLE1BQU0sVUFBVSxNQUFNLFdBQVcsTUFBTSxRQUFTO0FBRS9GLFFBQU0sU0FBUyxpQkFBaUIsU0FBUyxRQUFRLENBQUM7QUFDbEQsTUFBSSxDQUFDLE9BQVE7QUFFYixRQUFNLGVBQWU7QUFDckIsUUFBTSxnQkFBZ0I7QUFDdEIsUUFBTSx5QkFBeUI7QUFDL0IsV0FBUyxNQUFNO0FBQ2YscUJBQW1CO0FBRW5CLE1BQUk7QUFDRixVQUFNLGVBQWUsT0FBTyxNQUFNLEdBQUc7QUFBQSxFQUN2QyxTQUFTLE9BQU87QUFDZCxRQUFJLHVCQUF1QixlQUFlLEtBQUssQ0FBQztBQUNoRCxnQkFBWSx1QkFBdUIsa0JBQWtCLEtBQUssQ0FBQztBQUFBLEVBQzdEO0FBQ0Y7QUFFQSxTQUFTLGlCQUFpQixNQUF1QztBQUMvRCxRQUFNLFFBQVEsS0FBSyxLQUFLLEVBQUUsTUFBTSwyQkFBMkI7QUFDM0QsTUFBSSxDQUFDLE1BQU8sUUFBTztBQUNuQixTQUFPLEVBQUUsT0FBTyxNQUFNLENBQUMsS0FBSyxJQUFJLEtBQUssRUFBRTtBQUN6QztBQUVBLFNBQVMsb0JBQW9CLE1BQXdDO0FBQ25FLFFBQU0sUUFBUSxLQUFLLEtBQUssRUFBRSxNQUFNLGVBQWU7QUFDL0MsTUFBSSxDQUFDLE1BQU8sUUFBTztBQUNuQixRQUFNLFFBQVEsTUFBTSxDQUFDLEdBQUcsWUFBWSxLQUFLO0FBQ3pDLFNBQU8sT0FBTyxXQUFXLEtBQUssSUFBSSxFQUFFLE1BQU0sSUFBSTtBQUNoRDtBQUVBLGVBQWUsZUFBZSxNQUFjLEtBQThEO0FBQ3hHLFFBQU0sV0FBVyxhQUFhO0FBQzlCLE1BQUksQ0FBQyxVQUFVO0FBQ2IsZ0JBQVksb0JBQW9CLHlDQUF5QztBQUN6RTtBQUFBLEVBQ0Y7QUFDQSxRQUFNLFNBQVMsV0FBVztBQUMxQixRQUFNLFFBQVEsS0FBSyxZQUFZO0FBRS9CLE1BQUksQ0FBQyxNQUFNO0FBQ1QsVUFBTSxPQUFPLE1BQU0sUUFBUSxVQUFVLE1BQU07QUFDM0Msa0JBQWM7QUFDZCxRQUFJLE1BQU07QUFDUixpQkFBVyxNQUFNLEVBQUUsV0FBVyxNQUFNLENBQUM7QUFBQSxJQUN2QyxPQUFPO0FBQ0wsbUJBQWEsZUFBZSxtREFBbUQ7QUFBQSxJQUNqRjtBQUNBO0FBQUEsRUFDRjtBQUVBLE1BQUksVUFBVSxTQUFTO0FBQ3JCLFVBQU1DLFlBQVcsTUFBTTtBQUFBLE1BQ3JCO0FBQUEsTUFDQSxFQUFFLFNBQVM7QUFBQSxNQUNYLEVBQUUsT0FBTztBQUFBLElBQ1g7QUFDQSxrQkFBYztBQUNkLGlCQUFhQSxVQUFTLFVBQVUsaUJBQWlCLGVBQWUsMENBQTBDO0FBQzFHO0FBQUEsRUFDRjtBQUVBLE1BQUksVUFBVSxXQUFXLFVBQVUsWUFBWSxVQUFVLFlBQVk7QUFDbkUsVUFBTSxTQUFxQixVQUFVLFVBQVUsV0FBVyxVQUFVLFdBQVcsV0FBVztBQUMxRixVQUFNQSxZQUFXLE1BQU07QUFBQSxNQUNyQjtBQUFBLE1BQ0EsRUFBRSxVQUFVLE9BQU87QUFBQSxNQUNuQixFQUFFLE9BQU87QUFBQSxJQUNYO0FBQ0Esa0JBQWNBLFVBQVM7QUFDdkIsZUFBV0EsVUFBUyxNQUFNLEVBQUUsV0FBVyxNQUFNLENBQUM7QUFDOUM7QUFBQSxFQUNGO0FBRUEsUUFBTSxXQUFXLE1BQU0sUUFBUSxVQUFVLE1BQU07QUFDL0MsTUFBSSxZQUFZLFNBQVMsY0FBYyxNQUFNO0FBQzNDLFVBQU0sVUFBVSxNQUFNLG1CQUFtQixVQUFVLElBQUk7QUFDdkQsUUFBSSxDQUFDLFNBQVM7QUFDWixvQkFBYztBQUNkLGlCQUFXLFVBQVUsRUFBRSxXQUFXLE1BQU0sQ0FBQztBQUN6QztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBRUEsUUFBTSxXQUFXLE1BQU07QUFBQSxJQUNyQjtBQUFBLElBQ0EsRUFBRSxVQUFVLFdBQVcsTUFBTSxRQUFRLFNBQVM7QUFBQSxJQUM5QyxFQUFFLE9BQU87QUFBQSxFQUNYO0FBQ0EsZ0JBQWMsU0FBUztBQUN2QixNQUFJLFlBQVksRUFBRSxTQUFTLENBQUM7QUFDNUIsYUFBVyxTQUFTLE1BQU0sRUFBRSxXQUFXLE1BQU0sQ0FBQztBQUNoRDtBQUVBLGVBQWUsUUFBUSxVQUFrQixRQUE0QztBQUNuRixRQUFNLFdBQVcsTUFBTTtBQUFBLElBQ3JCO0FBQUEsSUFDQSxFQUFFLFNBQVM7QUFBQSxJQUNYLEVBQUUsT0FBTztBQUFBLEVBQ1g7QUFDQSxTQUFPLFNBQVM7QUFDbEI7QUFFQSxlQUFlLG9CQUFvQixLQUE4RDtBQUMvRixRQUFNLFdBQVcsYUFBYTtBQUM5QixNQUFJLENBQUMsVUFBVTtBQUNiLFFBQUksaUJBQWlCLE1BQU07QUFDekIscUJBQWU7QUFDZixvQkFBYztBQUNkLGdCQUFVO0FBQUEsSUFDWjtBQUNBO0FBQUEsRUFDRjtBQUNBLE1BQUksYUFBYSxhQUFjO0FBQy9CLGlCQUFlO0FBQ2YsTUFBSTtBQUNGLFVBQU0sT0FBTyxNQUFNLFFBQVEsVUFBVSxXQUFXLENBQUM7QUFDakQsa0JBQWM7QUFDZCxRQUFJLE1BQU07QUFDUixpQkFBVyxNQUFNLEVBQUUsV0FBVyxNQUFNLENBQUM7QUFBQSxJQUN2QyxPQUFPO0FBQ0wsZ0JBQVU7QUFBQSxJQUNaO0FBQUEsRUFDRixTQUFTLE9BQU87QUFHZCxRQUFJLDhCQUE4QixlQUFlLEtBQUssQ0FBQztBQUFBLEVBQ3pEO0FBQ0Y7QUFFQSxTQUFTLG1CQUFtQixVQUFzQixlQUF5QztBQUN6RixTQUFPLElBQUksUUFBUSxDQUFDLFlBQVk7QUFDOUIsZ0JBQVk7QUFBQSxNQUNWLE9BQU87QUFBQSxNQUNQLFFBQVEsU0FBUyxTQUFTLFdBQVcsR0FBRztBQUFBLE1BQ3hDLFFBQVEsUUFBUSxTQUFTLGVBQWUsR0FBRyxDQUFDO0FBQUEsTUFDNUMsU0FBUztBQUFBLFFBQ1A7QUFBQSxVQUNFLE9BQU87QUFBQSxVQUNQLE1BQU07QUFBQSxVQUNOLEtBQUssTUFBTSxRQUFRLElBQUk7QUFBQSxRQUN6QjtBQUFBLFFBQ0E7QUFBQSxVQUNFLE9BQU87QUFBQSxVQUNQLEtBQUssTUFBTSxRQUFRLEtBQUs7QUFBQSxRQUMxQjtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFlBQVk7QUFBQSxJQUNkLENBQUM7QUFBQSxFQUNILENBQUM7QUFDSDtBQUVBLFNBQVMsV0FBVyxNQUFrQixTQUF1QztBQUMzRSxRQUFNLFNBQVMsZ0JBQWdCLEtBQUssTUFBTTtBQUMxQyxRQUFNLFNBQVMsS0FBSyxlQUFlLE9BQy9CLEdBQUcsYUFBYSxLQUFLLFVBQVUsQ0FBQyxZQUNoQyxHQUFHLGFBQWEsS0FBSyxVQUFVLENBQUMsTUFBTSxhQUFhLEtBQUssV0FBVyxDQUFDO0FBQ3hFLGNBQVk7QUFBQSxJQUNWLE9BQU8sUUFBUSxNQUFNO0FBQUEsSUFDckIsUUFBUSxLQUFLO0FBQUEsSUFDYixRQUFRLEdBQUcsTUFBTSxNQUFNLGVBQWUsS0FBSyxlQUFlLENBQUM7QUFBQSxJQUMzRCxTQUFTO0FBQUEsTUFDUCxLQUFLLFdBQVcsV0FDWixFQUFFLE9BQU8sVUFBVSxNQUFNLFdBQVcsS0FBSyxNQUFNLGlCQUFpQixRQUFRLEVBQUUsSUFDMUUsRUFBRSxPQUFPLFNBQVMsS0FBSyxNQUFNLGlCQUFpQixRQUFRLEVBQUU7QUFBQSxNQUM1RCxFQUFFLE9BQU8sWUFBWSxLQUFLLE1BQU0saUJBQWlCLFVBQVUsRUFBRTtBQUFBLE1BQzdELEVBQUUsT0FBTyxTQUFTLE1BQU0sVUFBVSxLQUFLLE1BQU0saUJBQWlCLEVBQUU7QUFBQSxJQUNsRTtBQUFBLElBQ0EsWUFBWSxDQUFDLFFBQVE7QUFBQSxFQUN2QixDQUFDO0FBQ0g7QUFFQSxTQUFTLGFBQWEsT0FBZSxRQUFzQjtBQUN6RCxjQUFZLEVBQUUsT0FBTyxRQUFRLFNBQVMsQ0FBQyxHQUFHLFlBQVksTUFBTSxDQUFDO0FBQy9EO0FBRUEsU0FBUyxZQUFZLE9BQWUsUUFBc0I7QUFDeEQsY0FBWSxFQUFFLE9BQU8sUUFBUSxTQUFTLENBQUMsR0FBRyxZQUFZLE9BQU8sT0FBTyxLQUFLLENBQUM7QUFDNUU7QUFFQSxTQUFTLFlBQVksU0FBaUM7QUFDcEQscUJBQW1CO0FBQ25CLFFBQU0sS0FBSyxXQUFXO0FBQ3RCLE1BQUksVUFBVyxjQUFhLFNBQVM7QUFDckMsS0FBRyxZQUFZO0FBQ2YsS0FBRyxZQUFZLHFCQUFxQixRQUFRLFFBQVEsY0FBYyxFQUFFLEdBQUcsV0FBVyxZQUFZLGtCQUFrQixFQUFFO0FBQ2xILHlCQUF1QixFQUFFO0FBRXpCLFFBQU0sU0FBUyxTQUFTLGNBQWMsS0FBSztBQUMzQyxTQUFPLFlBQVk7QUFDbkIsU0FBTyxpQkFBaUIsZUFBZSxrQkFBa0I7QUFDekQsU0FBTyxpQkFBaUIsWUFBWSxzQkFBc0I7QUFFMUQsUUFBTSxRQUFRLFNBQVMsY0FBYyxLQUFLO0FBQzFDLFFBQU0sWUFBWTtBQUNsQixRQUFNLGNBQWMsUUFBUTtBQUU1QixRQUFNLFdBQVcsU0FBUyxjQUFjLEtBQUs7QUFDN0MsV0FBUyxZQUFZO0FBRXJCLFFBQU0sV0FBVyxTQUFTLGNBQWMsUUFBUTtBQUNoRCxXQUFTLFlBQVk7QUFDckIsV0FBUyxPQUFPO0FBQ2hCLFdBQVMsY0FBYyxXQUFXLFlBQVksTUFBTTtBQUNwRCxXQUFTLGFBQWEsY0FBYyxXQUFXLFlBQVksc0JBQXNCLHFCQUFxQjtBQUN0RyxXQUFTLGlCQUFpQixTQUFTLE1BQU07QUFDdkMsaUJBQWEsRUFBRSxHQUFHLFlBQVksV0FBVyxDQUFDLFdBQVcsVUFBVTtBQUMvRCx1QkFBbUI7QUFDbkIsUUFBSSxpQkFBa0IsYUFBWSxnQkFBZ0I7QUFBQSxFQUNwRCxDQUFDO0FBRUQsUUFBTSxRQUFRLFNBQVMsY0FBYyxRQUFRO0FBQzdDLFFBQU0sWUFBWTtBQUNsQixRQUFNLE9BQU87QUFDYixRQUFNLGNBQWM7QUFDcEIsUUFBTSxhQUFhLGNBQWMsa0JBQWtCO0FBQ25ELFFBQU0saUJBQWlCLFNBQVMsTUFBTSxVQUFVLENBQUM7QUFDakQsV0FBUyxPQUFPLFVBQVUsS0FBSztBQUMvQixTQUFPLE9BQU8sT0FBTyxRQUFRO0FBQzdCLEtBQUcsWUFBWSxNQUFNO0FBRXJCLE1BQUksV0FBVyxXQUFXO0FBQ3hCLE9BQUcsTUFBTSxVQUFVO0FBQ25CLFFBQUksQ0FBQyxRQUFRLFlBQVk7QUFDdkIsa0JBQVksV0FBVyxNQUFNLFVBQVUsR0FBRyxHQUFLO0FBQUEsSUFDakQ7QUFDQTtBQUFBLEVBQ0Y7QUFFQSxRQUFNLFNBQVMsU0FBUyxjQUFjLEtBQUs7QUFDM0MsU0FBTyxZQUFZO0FBQ25CLFNBQU8sY0FBYyxRQUFRO0FBRTdCLEtBQUcsWUFBWSxNQUFNO0FBRXJCLE1BQUksUUFBUSxRQUFRO0FBQ2xCLFVBQU0sU0FBUyxTQUFTLGNBQWMsS0FBSztBQUMzQyxXQUFPLFlBQVk7QUFDbkIsV0FBTyxjQUFjLFFBQVE7QUFDN0IsT0FBRyxZQUFZLE1BQU07QUFBQSxFQUN2QjtBQUVBLE1BQUksUUFBUSxRQUFRLFNBQVMsR0FBRztBQUM5QixVQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUs7QUFDNUMsWUFBUSxZQUFZO0FBQ3BCLGVBQVcsVUFBVSxRQUFRLFNBQVM7QUFDcEMsWUFBTUMsVUFBUyxTQUFTLGNBQWMsUUFBUTtBQUM5QyxNQUFBQSxRQUFPLE9BQU87QUFDZCxNQUFBQSxRQUFPLGNBQWMsT0FBTztBQUM1QixNQUFBQSxRQUFPLFlBQVksdUJBQXVCLE9BQU8sUUFBUSxFQUFFO0FBQzNELE1BQUFBLFFBQU8saUJBQWlCLFNBQVMsTUFBTTtBQUNyQyxnQkFBUSxRQUFRLE9BQU8sSUFBSSxDQUFDLEVBQUUsTUFBTSxDQUFDLFVBQVU7QUFDN0Msc0JBQVksc0JBQXNCLGtCQUFrQixLQUFLLENBQUM7QUFBQSxRQUM1RCxDQUFDO0FBQUEsTUFDSCxDQUFDO0FBQ0QsY0FBUSxZQUFZQSxPQUFNO0FBQUEsSUFDNUI7QUFDQSxPQUFHLFlBQVksT0FBTztBQUFBLEVBQ3hCO0FBRUEsS0FBRyxNQUFNLFVBQVU7QUFDbkIsTUFBSSxDQUFDLFFBQVEsWUFBWTtBQUN2QixnQkFBWSxXQUFXLE1BQU0sVUFBVSxHQUFHLEdBQUs7QUFBQSxFQUNqRDtBQUNGO0FBRUEsZUFBZSxpQkFBaUIsUUFBbUM7QUFDakUsUUFBTSxXQUFXLGFBQWEsS0FBSyxhQUFhO0FBQ2hELE1BQUksQ0FBQyxTQUFVO0FBQ2YsUUFBTSxXQUFXLE1BQU07QUFBQSxJQUNyQjtBQUFBLElBQ0EsRUFBRSxVQUFVLE9BQU87QUFBQSxJQUNuQixFQUFFLFFBQVEsV0FBVyxFQUFFO0FBQUEsRUFDekI7QUFDQSxnQkFBYyxTQUFTO0FBQ3ZCLGFBQVcsU0FBUyxNQUFNLEVBQUUsV0FBVyxNQUFNLENBQUM7QUFDaEQ7QUFFQSxlQUFlLG1CQUFrQztBQUMvQyxRQUFNLFdBQVcsYUFBYSxLQUFLLGFBQWE7QUFDaEQsTUFBSSxDQUFDLFNBQVU7QUFDZixRQUFNO0FBQUEsSUFDSjtBQUFBLElBQ0EsRUFBRSxTQUFTO0FBQUEsSUFDWCxFQUFFLFFBQVEsV0FBVyxFQUFFO0FBQUEsRUFDekI7QUFDQSxnQkFBYztBQUNkLGVBQWEsZ0JBQWdCLDJDQUEyQztBQUMxRTtBQUVBLFNBQVMsYUFBNkI7QUFDcEMsTUFBSSxNQUFNLFlBQWEsUUFBTztBQUM5QixTQUFPLFNBQVMsY0FBYyxLQUFLO0FBQ25DLE9BQUssS0FBSztBQUNWLE9BQUssTUFBTSxVQUFVO0FBQ3JCLFFBQU0sU0FBUyxTQUFTLFFBQVEsU0FBUztBQUN6QyxNQUFJLE9BQVEsUUFBTyxZQUFZLElBQUk7QUFDbkMsU0FBTztBQUNUO0FBRUEsU0FBUyxZQUFrQjtBQUN6QixNQUFJLFdBQVc7QUFDYixpQkFBYSxTQUFTO0FBQ3RCLGdCQUFZO0FBQUEsRUFDZDtBQUNBLE1BQUksS0FBTSxNQUFLLE1BQU0sVUFBVTtBQUNqQztBQUVBLFNBQVMsbUJBQW1CLE9BQTJCO0FBQ3JELE1BQUksTUFBTSxXQUFXLEVBQUc7QUFDeEIsTUFBSSxNQUFNLGtCQUFrQixXQUFXLE1BQU0sT0FBTyxRQUFRLFFBQVEsRUFBRztBQUN2RSxNQUFJLENBQUMsS0FBTTtBQUNYLFFBQU0sT0FBTyxLQUFLLHNCQUFzQjtBQUN4QyxjQUFZO0FBQUEsSUFDVixXQUFXLE1BQU07QUFBQSxJQUNqQixTQUFTLE1BQU0sVUFBVSxLQUFLO0FBQUEsSUFDOUIsU0FBUyxNQUFNLFVBQVUsS0FBSztBQUFBLElBQzlCLE9BQU8sS0FBSztBQUFBLElBQ1osUUFBUSxLQUFLO0FBQUEsRUFDZjtBQUNBLE9BQUssVUFBVSxJQUFJLGFBQWE7QUFDaEMsUUFBTSxlQUFlO0FBQ3JCLFNBQU8saUJBQWlCLGVBQWUsYUFBYTtBQUNwRCxTQUFPLGlCQUFpQixhQUFhLGlCQUFpQjtBQUN4RDtBQUVBLFNBQVMsY0FBYyxPQUEyQjtBQUNoRCxNQUFJLENBQUMsYUFBYSxNQUFNLGNBQWMsVUFBVSxhQUFhLENBQUMsS0FBTTtBQUNwRSxlQUFhO0FBQUEsSUFDWCxHQUFHO0FBQUEsSUFDSCxHQUFHLE1BQU0sTUFBTSxVQUFVLFVBQVUsU0FBUyxHQUFHLE9BQU8sYUFBYSxVQUFVLFFBQVEsQ0FBQztBQUFBLElBQ3RGLEdBQUcsTUFBTSxNQUFNLFVBQVUsVUFBVSxTQUFTLEdBQUcsT0FBTyxjQUFjLFVBQVUsU0FBUyxDQUFDO0FBQUEsRUFDMUY7QUFDQSx5QkFBdUIsSUFBSTtBQUM3QjtBQUVBLFNBQVMsa0JBQWtCLE9BQTJCO0FBQ3BELE1BQUksYUFBYSxNQUFNLGNBQWMsVUFBVSxVQUFXO0FBQzFELFNBQU8sb0JBQW9CLGVBQWUsYUFBYTtBQUN2RCxTQUFPLG9CQUFvQixhQUFhLGlCQUFpQjtBQUN6RCxNQUFJLEtBQU0sTUFBSyxVQUFVLE9BQU8sYUFBYTtBQUM3QyxjQUFZO0FBQ1osTUFBSSxLQUFNLDBCQUF5QixJQUFJO0FBQ3ZDLHFCQUFtQjtBQUNyQjtBQUVBLFNBQVMsdUJBQXVCLE9BQXlCO0FBQ3ZELE1BQUksTUFBTSxrQkFBa0IsV0FBVyxNQUFNLE9BQU8sUUFBUSxRQUFRLEVBQUc7QUFDdkUsZUFBYSxFQUFFLEdBQUcsWUFBWSxHQUFHLE1BQU0sR0FBRyxLQUFLO0FBQy9DLHFCQUFtQjtBQUNuQixNQUFJLEtBQU0sd0JBQXVCLElBQUk7QUFDdkM7QUFFQSxTQUFTLHVCQUF1QixTQUE0QjtBQUMxRCxNQUFJLFdBQVcsTUFBTSxRQUFRLFdBQVcsTUFBTSxNQUFNO0FBQ2xELFlBQVEsTUFBTSxPQUFPO0FBQ3JCLFlBQVEsTUFBTSxNQUFNO0FBQ3BCLFlBQVEsTUFBTSxRQUFRO0FBQ3RCLFlBQVEsTUFBTSxTQUFTO0FBQ3ZCO0FBQUEsRUFDRjtBQUNBLDJCQUF5QixPQUFPO0FBQ2hDLFVBQVEsTUFBTSxRQUFRO0FBQ3RCLFVBQVEsTUFBTSxTQUFTO0FBQ3ZCLFVBQVEsTUFBTSxPQUFPLEdBQUcsV0FBVyxDQUFDO0FBQ3BDLFVBQVEsTUFBTSxNQUFNLEdBQUcsV0FBVyxDQUFDO0FBQ3JDO0FBRUEsU0FBUyx5QkFBeUIsU0FBNEI7QUFDNUQsTUFBSSxXQUFXLE1BQU0sUUFBUSxXQUFXLE1BQU0sS0FBTTtBQUNwRCxRQUFNLE9BQU8sUUFBUSxzQkFBc0I7QUFDM0MsZUFBYTtBQUFBLElBQ1gsR0FBRztBQUFBLElBQ0gsR0FBRyxNQUFNLFdBQVcsR0FBRyxHQUFHLE9BQU8sYUFBYSxLQUFLLFFBQVEsQ0FBQztBQUFBLElBQzVELEdBQUcsTUFBTSxXQUFXLEdBQUcsR0FBRyxPQUFPLGNBQWMsS0FBSyxTQUFTLENBQUM7QUFBQSxFQUNoRTtBQUNGO0FBRUEsU0FBUyxxQkFBcUM7QUFDNUMsTUFBSTtBQUNGLFVBQU0sU0FBUyxLQUFLLE1BQU0sYUFBYSxRQUFRLG9CQUFvQixLQUFLLElBQUk7QUFDNUUsV0FBTztBQUFBLE1BQ0wsV0FBVyxPQUFPLGNBQWM7QUFBQSxNQUNoQyxHQUFHLE9BQU8sT0FBTyxNQUFNLFlBQVksT0FBTyxTQUFTLE9BQU8sQ0FBQyxJQUFJLE9BQU8sSUFBSTtBQUFBLE1BQzFFLEdBQUcsT0FBTyxPQUFPLE1BQU0sWUFBWSxPQUFPLFNBQVMsT0FBTyxDQUFDLElBQUksT0FBTyxJQUFJO0FBQUEsSUFDNUU7QUFBQSxFQUNGLFFBQVE7QUFDTixXQUFPLEVBQUUsV0FBVyxPQUFPLEdBQUcsTUFBTSxHQUFHLEtBQUs7QUFBQSxFQUM5QztBQUNGO0FBRUEsU0FBUyxxQkFBMkI7QUFDbEMsTUFBSTtBQUNGLGlCQUFhLFFBQVEsc0JBQXNCLEtBQUssVUFBVSxVQUFVLENBQUM7QUFBQSxFQUN2RSxRQUFRO0FBQUEsRUFBQztBQUNYO0FBRUEsU0FBUyxNQUFNLE9BQWUsS0FBYSxLQUFxQjtBQUM5RCxNQUFJLE1BQU0sSUFBSyxRQUFPO0FBQ3RCLFNBQU8sS0FBSyxJQUFJLEtBQUssSUFBSSxPQUFPLEdBQUcsR0FBRyxHQUFHO0FBQzNDO0FBRUEsU0FBUyx1QkFBOEM7QUFDckQsTUFBSSxnQkFBZ0IsWUFBYSxRQUFPO0FBQ3hDLFFBQU0sU0FBUyxTQUFTLFFBQVEsU0FBUztBQUN6QyxNQUFJLENBQUMsT0FBUSxRQUFPO0FBQ3BCLG1CQUFpQixTQUFTLGNBQWMsS0FBSztBQUM3QyxpQkFBZSxLQUFLO0FBQ3BCLGlCQUFlLE1BQU0sVUFBVTtBQUMvQixTQUFPLFlBQVksY0FBYztBQUNqQyxTQUFPO0FBQ1Q7QUFFQSxTQUFTLHFCQUFxQixVQUF1QztBQUNuRSxNQUFJLENBQUMsVUFBVTtBQUNiLHVCQUFtQjtBQUNuQjtBQUFBLEVBQ0Y7QUFDQSxRQUFNLGFBQWEsb0JBQW9CLFNBQVMsUUFBUSxDQUFDO0FBQ3pELE1BQUksQ0FBQyxZQUFZO0FBQ2YsdUJBQW1CO0FBQ25CO0FBQUEsRUFDRjtBQUNBLHVCQUFxQixVQUFVLFdBQVcsS0FBSztBQUNqRDtBQUVBLFNBQVMscUJBQXFCLFVBQTBCLE9BQXFCO0FBQzNFLFFBQU0sS0FBSyxxQkFBcUI7QUFDaEMsTUFBSSxDQUFDLEdBQUk7QUFDVCxRQUFNLE9BQU8sU0FBUyxRQUFRLHNCQUFzQjtBQUNwRCxRQUFNLFFBQVEsS0FBSyxJQUFJLEtBQUssS0FBSyxJQUFJLEtBQUssS0FBSyxTQUFTLEdBQUcsQ0FBQztBQUM1RCxRQUFNLE9BQU8sS0FBSyxJQUFJLElBQUksS0FBSyxJQUFJLEtBQUssTUFBTSxPQUFPLGFBQWEsUUFBUSxFQUFFLENBQUM7QUFDN0UsUUFBTSxNQUFNLEtBQUssSUFBSSxJQUFJLEtBQUssTUFBTSxFQUFFO0FBRXRDLEtBQUcsWUFBWTtBQUNmLEtBQUcsWUFBWTtBQUNmLEtBQUcsTUFBTSxPQUFPLEdBQUcsSUFBSTtBQUN2QixLQUFHLE1BQU0sTUFBTSxHQUFHLEdBQUc7QUFDckIsS0FBRyxNQUFNLFFBQVEsR0FBRyxLQUFLO0FBRXpCLFFBQU0sT0FBTyxTQUFTLGNBQWMsUUFBUTtBQUM1QyxPQUFLLE9BQU87QUFDWixPQUFLLFlBQVk7QUFDakIsT0FBSyxhQUFhLGNBQWMsY0FBYztBQUM5QyxPQUFLLGlCQUFpQixhQUFhLENBQUMsVUFBVTtBQUM1QyxVQUFNLGVBQWU7QUFDckIsVUFBTSxnQkFBZ0I7QUFDdEIsd0JBQW9CLFFBQVE7QUFBQSxFQUM5QixDQUFDO0FBRUQsUUFBTSxVQUFVLFNBQVMsY0FBYyxNQUFNO0FBQzdDLFVBQVEsWUFBWTtBQUNwQixVQUFRLGNBQWM7QUFDdEIsTUFBSSxPQUFPO0FBQ1QsWUFBUSxRQUFRLFFBQVE7QUFBQSxFQUMxQjtBQUVBLFFBQU0sU0FBUyxTQUFTLGNBQWMsTUFBTTtBQUM1QyxTQUFPLFlBQVk7QUFDbkIsU0FBTyxjQUFjO0FBRXJCLE9BQUssT0FBTyxTQUFTLE1BQU07QUFDM0IsS0FBRyxZQUFZLElBQUk7QUFDbkIsS0FBRyxNQUFNLFVBQVU7QUFDckI7QUFFQSxTQUFTLG9CQUFvQixVQUFnQztBQUMzRCxXQUFTLFFBQVEsUUFBUTtBQUN6QixxQkFBbUI7QUFDckI7QUFFQSxTQUFTLHFCQUEyQjtBQUNsQyxNQUFJLGVBQWdCLGdCQUFlLE1BQU0sVUFBVTtBQUNyRDtBQUVBLFNBQVMsZ0JBQXNCO0FBQzdCLE1BQUksU0FBUyxlQUFlLG9CQUFvQixFQUFHO0FBQ25ELFFBQU0sU0FBUyxTQUFTLFFBQVEsU0FBUztBQUN6QyxNQUFJLENBQUMsUUFBUTtBQUNYLGFBQVMsaUJBQWlCLG9CQUFvQixNQUFNLGNBQWMsR0FBRyxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBQ25GO0FBQUEsRUFDRjtBQUVBLFFBQU0sUUFBUSxTQUFTLGNBQWMsT0FBTztBQUM1QyxRQUFNLEtBQUs7QUFDWCxRQUFNLGNBQWM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFpSnBCLFNBQU8sWUFBWSxLQUFLO0FBQzFCO0FBRUEsU0FBUyxtQkFBbUIsT0FBcUM7QUFDL0QsUUFBTSxPQUFPLE9BQU8s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QUNGLG1CQUFpQjtBQUNqQixVQUFRLHNCQUFzQjtBQUNoQyxTQUFTLEdBQUc7QUFDVixVQUFRLHFCQUFxQixPQUFPLENBQUMsQ0FBQztBQUN4QztBQUVBLElBQUk7QUFDRixtQkFBaUIsT0FBTztBQUMxQixTQUFTLEdBQUc7QUFDVixVQUFRLHVCQUF1QixPQUFPLENBQUMsQ0FBQztBQUMxQztBQUVBLGVBQWUsTUFBTTtBQUNuQixNQUFJLFNBQVMsZUFBZSxXQUFXO0FBQ3JDLGFBQVMsaUJBQWlCLG9CQUFvQixNQUFNLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUNwRSxPQUFPO0FBQ0wsU0FBSztBQUFBLEVBQ1A7QUFDRixDQUFDO0FBRUQsZUFBZSxPQUFPO0FBQ3BCLFVBQVEsY0FBYyxFQUFFLFlBQVksU0FBUyxXQUFXLENBQUM7QUFDekQsTUFBSTtBQUNGLDBCQUFzQjtBQUN0QixZQUFRLDJCQUEyQjtBQUNuQyxVQUFNLGVBQWU7QUFDckIsWUFBUSxvQkFBb0I7QUFDNUIsVUFBTSxhQUFhO0FBQ25CLFlBQVEsaUJBQWlCO0FBQ3pCLG9CQUFnQjtBQUNoQixZQUFRLGVBQWU7QUFBQSxFQUN6QixTQUFTLEdBQUc7QUFDVixZQUFRLGVBQWUsT0FBUSxHQUFhLFNBQVMsQ0FBQyxDQUFDO0FBQ3ZELFlBQVEsTUFBTSx5Q0FBeUMsQ0FBQztBQUFBLEVBQzFEO0FBQ0Y7QUFJQSxJQUFJLFlBQWtDO0FBQ3RDLFNBQVMsa0JBQXdCO0FBQy9CLCtCQUFZLEdBQUcsMEJBQTBCLE1BQU07QUFDN0MsUUFBSSxVQUFXO0FBQ2YsaUJBQWEsWUFBWTtBQUN2QixVQUFJO0FBQ0YsZ0JBQVEsS0FBSyx1Q0FBdUM7QUFDcEQsMEJBQWtCO0FBQ2xCLGNBQU0sZUFBZTtBQUNyQixjQUFNLGFBQWE7QUFBQSxNQUNyQixTQUFTLEdBQUc7QUFDVixnQkFBUSxNQUFNLHVDQUF1QyxDQUFDO0FBQUEsTUFDeEQsVUFBRTtBQUNBLG9CQUFZO0FBQUEsTUFDZDtBQUFBLElBQ0YsR0FBRztBQUFBLEVBQ0wsQ0FBQztBQUNIOyIsCiAgIm5hbWVzIjogWyJpbXBvcnRfZWxlY3Ryb24iLCAicm9vdCIsICJjYXJkIiwgImltcG9ydF9lbGVjdHJvbiIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJpbXBvcnRfZWxlY3Ryb24iLCAicm9vdCIsICJpbXBvcnRfZWxlY3Ryb24iLCAiaXNSZWNvcmQiLCAicmVzcG9uc2UiLCAiYnV0dG9uIiwgInNhZmVTdHJpbmdpZnkiXQp9Cg==
