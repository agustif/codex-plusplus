/**
 * Bennett's UI Improvements
 *
 * A bag of small, individually-toggleable UI tweaks for Codex. Settings
 * live on a dedicated sidebar entry under the "Tweaks" group.
 *
 * Features
 * --------
 *  • hide-upgrade-prompts  Hides the sidebar "Upgrade" pill and the
 *                          top-bar "Get Plus" button. Pure DOM filter,
 *                          fully reversible.
 *  • show-usage-in-sidebar (experimental) Renders a single usage box where
 *                          the upgrade pill was. Click toggles between
 *                          5h and Weekly; hover replaces content with
 *                          "Resets: HH:MM". Red when <15% remaining.
 *                          Sources data from the expanded rate-limits
 *                          breakdown opened from the account menu.
 *  • square-sidebar        Flatten the rounded seam between sidebar and
 *                          main content panel.
 *  • match-sidebar-width   Force the settings page sidebar to match the
 *                          main UI sidebar's width, eliminating the
 *                          layout jump when opening/closing Settings.
 *  • sidebar-action-grid   Render the four main sidebar actions as a 2x2
 *                          grid of filled buttons.
 *  • sidebar-render-monitor  Log sidebar mutation/commit activity for
 *                            diagnosing excessive re-renders.
 *
 * Authoring notes
 * ---------------
 *  • Renderer-only; no Node deps.
 *  • Each feature returns a `dispose()` so toggling off is clean.
 *  • Match-by-text-content for resilience: Codex's main shell has no
 *    stable testids/aria-labels for these widgets.
 */

/** @type {import("@codex-plusplus/sdk").Tweak} */
module.exports = {
  start(api) {
    const state = {
      api,
      features: new Map(/* id -> { dispose } */),
      defaults: {
        "hide-upgrade-prompts": true,
        "show-usage-in-sidebar": false,
        "square-sidebar": false,
        "match-sidebar-width": true,
        "sidebar-action-grid": true,
        "sidebar-render-monitor": false,
      },
    };
    this._state = state;

    // ── settings page ──────────────────────────────────────────────────
    // We require `registerPage`. The older `register()` API would render
    // these toggles as a *nested section* inside Codex++'s built-in
    // "Tweaks" page — that's misleading, since this tweak is supposed to
    // own its own sidebar entry. If the runtime is too old we just log
    // and skip the UI; the features themselves still activate below.
    if (typeof api.settings?.registerPage !== "function") {
      api.log.warn(
        "registerPage unavailable — Codex++ runtime is too old. " +
          "Restart Codex to pick up the latest preload. Settings UI not mounted.",
      );
    } else {
      this._pageHandle = api.settings.registerPage({
        id: "main",
        title: "UI Improvements",
        description: "Bennett's small quality-of-life tweaks.",
        iconSvg:
          '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true">' +
          '<path d="M4 6h12M4 10h8M4 14h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '<circle cx="14" cy="10" r="1.6" fill="currentColor"/>' +
          "</svg>",
        render: (root) => renderSettings(root, state),
      });
    }

    // ── activate features per stored prefs ─────────────────────────────
    for (const id of Object.keys(state.defaults)) {
      const enabled = readFlag(api, id, state.defaults[id]);
      if (enabled) activateFeature(state, id);
    }
  },

  stop() {
    const s = this._state;
    if (!s) return;
    for (const [, f] of s.features) {
      try {
        f.dispose?.();
      } catch (e) {
        s.api.log.warn("dispose failed", e);
      }
    }
    s.features.clear();
    this._pageHandle?.unregister();
  },
};

// ─────────────────────────────────────────────────────────── settings UI ──

/**
 * Render the dedicated page. Mirrors Codex's standard form: one
 * `flex flex-col gap-2` section per group, rounded card with rows.
 */
function renderSettings(root, state) {
  const features = [
    {
      id: "hide-upgrade-prompts",
      title: "Hide upgrade prompts",
      description:
        'Hide the "Upgrade" pill in the app sidebar and the "Get Plus" button in the top bar.',
    },
    {
      id: "show-usage-in-sidebar",
      title: "Show usage in sidebar (experimental)",
      description:
        "Render 5-hour and weekly rate limits where the upgrade button was. Open the rate-limits breakdown (account menu → Rate limits) at least once to seed the values.",
    },
    {
      id: "square-sidebar",
      title: "Square sidebar corners",
      description:
        "Remove the rounded inner corners on the main content panel so it sits flush against the sidebar.",
    },
    {
      id: "match-sidebar-width",
      title: "Match settings sidebar width",
      description:
        "Stop the layout jump when opening Settings: the settings sidebar (fixed at 300px) is forced to match the main UI sidebar's current width.",
    },
    {
      id: "sidebar-action-grid",
      title: "Sidebar action grid",
      description:
        "Render New chat, Search, Plugins, and Automations as a compact 2x2 grid of filled buttons.",
    },
    {
      id: "sidebar-render-monitor",
      title: "Sidebar render monitor",
      description:
        "Log sidebar DOM mutation bursts and React commit counts to preload.log while diagnosing sidebar re-renders.",
    },
  ];

  const section = el("section", "flex flex-col gap-2");
  section.appendChild(sectionTitle("Features"));

  const card = roundedCard();
  for (const f of features) {
    card.appendChild(featureRow(state, f));
  }
  section.appendChild(card);
  root.appendChild(section);
}

/**
 * Heuristic sidebar finder. Codex's left rail is typically a flex column
 * pinned to x=0 with substantial height. We rank candidates by:
 *   • bounding-rect.left near 0
 *   • height > 60% of viewport
 *   • narrow-ish width (< 360px) for collapsed/expanded sidebars
 *   • presence of `nav` or aria-label="Primary"
 * and pick the best. Returns the chosen element + a few selector hints.
 *
 * Currently unused — kept around for ad-hoc DOM debugging during tweak
 * development. Wire it up to a temporary button if needed.
 */
// eslint-disable-next-line no-unused-vars
async function dumpSidebar(api) {
  const candidates = [];
  const all = document.querySelectorAll(
    'aside, nav, [role="navigation"], [data-testid*="sidebar" i], div',
  );
  const vh = window.innerHeight;
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.left > 8) continue;
    if (r.height < vh * 0.6) continue;
    if (r.width < 40 || r.width > 420) continue;
    let score = 0;
    if (el.tagName === "ASIDE" || el.tagName === "NAV") score += 5;
    if (el.getAttribute("role") === "navigation") score += 3;
    if (el.querySelector("nav")) score += 1;
    if (/sidebar/i.test(el.getAttribute("data-testid") || "")) score += 4;
    if (/rounded/.test(el.className || "")) score += 2;
    score += Math.max(0, 200 - r.width) / 100; // prefer narrower
    candidates.push({ el, score, rect: r });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];
  if (!top) return { ok: false, reason: "no candidate" };

  const html = top.el.outerHTML;
  const summary = candidates.slice(0, 5).map((c) => ({
    tag: c.el.tagName.toLowerCase(),
    classes: c.el.className,
    rect: {
      x: Math.round(c.rect.left),
      y: Math.round(c.rect.top),
      w: Math.round(c.rect.width),
      h: Math.round(c.rect.height),
    },
    score: c.score,
  }));

  const payload =
    `<!-- top candidates (best first) -->\n` +
    summary.map((s) => "<!-- " + JSON.stringify(s) + " -->").join("\n") +
    `\n\n<!-- chosen element outerHTML -->\n` +
    html;

  let wrotePath = null;
  try {
    if (typeof api.fs?.write === "function") {
      await api.fs.write("sidebar-dump.html", payload);
      wrotePath = "sidebar-dump.html (in tweak data dir)";
    }
  } catch (e) {
    api.log.warn("fs.write failed", e);
  }

  let copied = false;
  try {
    await navigator.clipboard.writeText(payload);
    copied = true;
  } catch (e) {
    api.log.warn("clipboard write failed", e);
  }

  return { ok: true, copied, wrotePath, summary };
}

function featureRow(state, f) {
  const row = el("div", "flex items-center justify-between gap-4 p-3");

  const left = el("div", "flex min-w-0 flex-col gap-1");
  const label = el("div", "min-w-0 text-sm text-token-text-primary");
  label.textContent = f.title;
  left.appendChild(label);
  if (f.description) {
    const desc = el("div", "text-token-text-secondary min-w-0 text-sm");
    desc.textContent = f.description;
    left.appendChild(desc);
  }
  row.appendChild(left);

  const initial = readFlag(state.api, f.id, state.defaults[f.id]);
  const sw = switchControl(initial, async (next) => {
    writeFlag(state.api, f.id, next);
    if (next) activateFeature(state, f.id);
    else deactivateFeature(state, f.id);
  });
  row.appendChild(sw);
  return row;
}

// ─────────────────────────────────────────────────────────── feature reg ──

function activateFeature(state, id) {
  if (state.features.has(id)) return;
  const fn = FEATURES[id];
  if (!fn) {
    state.api.log.warn("unknown feature", id);
    return;
  }
  try {
    const dispose = fn(state.api);
    state.features.set(id, { dispose });
    state.api.log.info("activated", id);
  } catch (e) {
    state.api.log.error("activate failed", id, e);
  }
}

function deactivateFeature(state, id) {
  const f = state.features.get(id);
  if (!f) return;
  try {
    f.dispose?.();
  } finally {
    state.features.delete(id);
    state.api.log.info("deactivated", id);
  }
}

// ─────────────────────────────────────────────────────────────── features ──

const FEATURES = {
  /**
   * Hide the "Upgrade" / "Get Plus" buttons. We match by visible text
   * across the document, skipping anything inside Codex's settings shell
   * or our own injected panels. Hidden via inline `display:none` so we
   * can restore it cleanly on dispose.
   */
  "hide-upgrade-prompts"(api) {
    // Two matcher tiers:
    //  • EXACT: short pill labels we trust (case-insensitive, exact match).
    //  • CONTAINS: longer phrases that may appear with trailing icons/arrows
    //    or wrapped in extra spans. We substring-match (case-insensitive).
    const EXACT = new Set([
      "upgrade",
      "get plus",
      "get chatgpt plus",
      "upgrade plan",
      "upgrade your plan",
      "upgrade to plus",
    ]);
    const CONTAINS = ["upgrade for higher limits"];
    const hidden = new Set(/* HTMLElement */);

    const isInsideOurShell = (el) => {
      let n = el;
      while (n) {
        if (n instanceof HTMLElement && n.dataset?.codexpp) return true;
        n = n.parentElement;
      }
      return false;
    };

    // Codex sometimes splits the label across icon + text spans, so we use
    // textContent and collapse whitespace.
    const normText = (el) =>
      (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();

    const matches = (text) => {
      if (!text) return false;
      if (EXACT.has(text)) return true;
      for (const c of CONTAINS) if (text.includes(c)) return true;
      return false;
    };

    const scan = () => {
      const candidates = document.querySelectorAll(
        'button, a, [role="button"], [role="menuitem"]',
      );
      for (const el of candidates) {
        if (hidden.has(el)) continue;
        if (isInsideOurShell(el)) continue;
        const t = normText(el);
        if (t.length === 0 || t.length > 80) continue;
        if (!matches(t)) continue;
        const host = el.closest('[class*="rounded"], [class*="badge"]') || el;
        if (!(host instanceof HTMLElement)) continue;
        host.dataset.codexppPrevDisplay = host.style.display || "";
        host.style.display = "none";
        hidden.add(host);
        api.log.info("hid upgrade element", { text: t });
      }
    };

    scan();
    const obs = new MutationObserver(scan);
    obs.observe(document.documentElement, { childList: true, subtree: true });

    return () => {
      obs.disconnect();
      for (const el of hidden) {
        if ("codexppPrevDisplay" in el.dataset) {
          el.style.display = el.dataset.codexppPrevDisplay;
          delete el.dataset.codexppPrevDisplay;
        }
      }
      hidden.clear();
    };
  },

  /**
   * Surface 5h + Weekly rate limits as two boxes in the sidebar slot where
   * the "Upgrade" pill lives. Sources its data from Codex's own rate-limits
   * popover (the Radix `[role="menu"]` opened from the model picker).
   *
   * Strategy
   * --------
   *  1. Watch document for a `[role="menu"]` whose menuitems mention "5h"
   *     and "weekly" — that's the popover.
   *  2. Parse each menuitem's text for a label + percentage / time-left,
   *     storing the latest snapshot to disk (so we can render even when the
   *     popover is closed).
   *  3. Mount two boxes into the sidebar above the (now hidden) Upgrade
   *     pill. Re-mount on sidebar mutations.
   *
   * The popover only updates when opened, so the sidebar boxes show the
   * most-recently-seen values. We log every parse + render so it's easy
   * to debug formats we haven't seen yet.
   */
  "show-usage-in-sidebar"(api) {
    /**
     * Persisted snapshot:
     *   { fiveHour:{label,pct,resetAt} | null,
     *     weekly:  {label,pct,resetAt} | null,
     *     at:number }
     * `pct` is REMAINING (Codex displays remaining %, e.g. "100%").
     * `resetAt` is whatever Codex shows verbatim (typically "HH:MM").
     */
    let snapshot = readSnapshot(api);
    let mounted = null; // HTMLElement currently rendered in the sidebar

    const log = (...a) => api.log.info("[usage]", ...a);

    // ── parsing ────────────────────────────────────────────────────────
    /**
     * Codex's expanded breakdown is a 2-column CSS grid: label in col-1,
     * value in col-2. We locate the grid by its unique class signature,
     * then walk children pairwise.
     *
     * Returns the breakdown grid element, or null.
     */
    const findBreakdownGrid = () => {
      // The full class string is long and may shift; we anchor on the
      // distinctive `grid-cols-[minmax(0,1fr)_auto]` token.
      const grids = document.querySelectorAll(
        'div[class*="grid-cols-[minmax(0,1fr)_auto]"]',
      );
      for (const g of grids) {
        const txt = (g.textContent || "").toLowerCase();
        if (
          (txt.includes("5h") || txt.includes("hourly")) &&
          txt.includes("week")
        )
          return g;
      }
      return null;
    };

    /**
     * Parse a value span (e.g. "100%·16:19") into `{ pct, resetAt }`.
     * Falls back to `null` fields when a piece is missing.
     */
    const parseValue = (span) => {
      const txt = (span.textContent || "").replace(/\s+/g, " ").trim();
      const pctMatch = txt.match(/(\d{1,3})\s*%/);
      const pct = pctMatch ? Math.max(0, Math.min(100, +pctMatch[1])) : null;
      // Prefer the inner [title="HH:MM"] attribute, else regex the text.
      const titled = span.querySelector("[title]");
      let resetAt = titled ? titled.getAttribute("title") : null;
      if (!resetAt) {
        const tMatch = txt.match(/\b(\d{1,2}:\d{2})\b/);
        resetAt = tMatch ? tMatch[1] : null;
      }
      return { pct, resetAt };
    };

    const scanBreakdown = (grid) => {
      const kids = Array.from(grid.children);
      let five = null;
      let week = null;
      // Pair (label, value) — col-1 then col-2 in DOM order.
      for (let i = 0; i + 1 < kids.length; i += 2) {
        const labelTxt = (kids[i].textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const value = parseValue(kids[i + 1]);
        const lower = labelTxt.toLowerCase();
        if (!five && (lower === "5h" || lower.startsWith("hourly"))) {
          five = { label: labelTxt, ...value };
        } else if (!week && lower.startsWith("week")) {
          week = { label: labelTxt, ...value };
        }
      }
      if (!five && !week) return false;
      const next = {
        fiveHour: five || snapshot?.fiveHour || null,
        weekly: week || snapshot?.weekly || null,
        at: Date.now(),
      };
      const changed =
        JSON.stringify(next.fiveHour) !== JSON.stringify(snapshot?.fiveHour) ||
        JSON.stringify(next.weekly) !== JSON.stringify(snapshot?.weekly);
      snapshot = next;
      writeSnapshot(api, snapshot);
      log("parsed snapshot", snapshot);
      if (changed) ensureMounted(true);
      return true;
    };

    // ── sidebar mount ─────────────────────────────────────────────────
    /**
     * Find the sidebar slot for the upgrade pill. The pill itself is
     * hidden by `hide-upgrade-prompts`, so we mount as a sibling that
     * replaces its visual footprint. We anchor on the parent of any
     * button/link with text "Upgrade" (case-insensitive), or fall back
     * to the bottom of the sidebar group.
     *
     * Returns the parent element to mount into, or null if not found.
     */
    const findSidebarSlot = () => {
      // Look for the (now hidden) upgrade pill via its prev-display marker.
      const prev = document.querySelector('[data-codexpp-prev-display]');
      if (prev && prev.parentElement) return prev.parentElement;
      // Fallback: any visible button literally labelled "Upgrade".
      const btns = document.querySelectorAll('button, a');
      for (const b of btns) {
        const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (t === "upgrade") return b.parentElement;
      }
      return null;
    };

    const ensureMounted = (forceRebuild = false) => {
      if (!snapshot || (!snapshot.fiveHour && !snapshot.weekly)) return;
      const slot = findSidebarSlot();
      if (!slot) {
        if (!ensureMounted._warned) {
          log("ensureMounted: no sidebar slot found yet");
          ensureMounted._warned = true;
        }
        return;
      }

      // Defensive: remove any stale boxes left by a previous mount cycle
      // (hot-reload, stop() race, or an older shape of this tweak that
      // used `data-codexpp="usage-boxes"`).
      for (const stale of document.querySelectorAll(
        '[data-codexpp="usage-box"], [data-codexpp="usage-boxes"]',
      )) {
        if (stale !== mounted) stale.remove();
      }

      if (mounted && slot.contains(mounted) && !forceRebuild) {
        mounted._refresh?.(snapshot);
        return;
      }
      if (mounted) mounted.remove();
      mounted = renderUsageBox(api, snapshot);
      mounted.dataset.codexpp = "usage-box";
      slot.appendChild(mounted);
      log("mounted usage box", {
        slotTag: slot.tagName,
        slotClass: slot.className,
      });
    };

    // Initial render from persisted snapshot (so first paint isn't empty
    // even before the user opens the popover).
    ensureMounted(true);

    // ── observers ─────────────────────────────────────────────────────
    // We throttle to one tick per animation frame so a flood of React
    // re-renders can't tank the renderer (Codex mutates the DOM heavily
    // while typing). Coalesces N onMutate() calls into one scan.
    let scheduled = false;
    const onMutate = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const grid = findBreakdownGrid();
        if (grid) scanBreakdown(grid);
        ensureMounted();
      });
    };

    onMutate();
    const obs = new MutationObserver(onMutate);
    obs.observe(document.documentElement, { childList: true, subtree: true });

    log("active", { snapshot });

    return () => {
      obs.disconnect();
      if (mounted) {
        mounted.remove();
        mounted = null;
      }
    };
  },

  /**
   * Square sidebar: the visual "rounded sidebar" is actually the main
   * content panel — `<main class="main-surface ... rounded-s-2xl">` —
   * which has `border-radius: 12.5px 0 0 12.5px` (TL+BL via Tailwind's
   * logical `rounded-s-2xl`). Its rounded left edge curves into the
   * sidebar, making the sidebar's TR+BR corners *appear* rounded.
   * Flattening `.main-surface`'s left side squares the seam.
   */
  "square-sidebar"() {
    const STYLE_ID = "codexpp-square-sidebar";
    document.getElementById(STYLE_ID)?.remove();

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Flatten the main panel's left (logical-start) corners.
         Codex applies these via Tailwind's rounded-s-2xl utility. */
      .main-surface {
        border-start-start-radius: 0 !important;
        border-end-start-radius: 0 !important;
      }
    `;
    document.head.appendChild(style);

    return () => {
      style.remove();
    };
  },

  /**
   * Match settings sidebar width to the main UI sidebar.
   *
   * Codex's main UI sidebar is `<aside class="pointer-events-auto relative
   * flex overflow-hidden">` — JS-controlled, user-resizable, width set via
   * inline `style="width: NNNpx"`. The settings page sidebar is a separate
   * element `<div class="window-fx-sidebar-surface ... w-token-sidebar">`
   * which uses Tailwind class `w-token-sidebar` → `width:
   * var(--spacing-token-sidebar)` ≈ 300px regardless of the main UI's
   * current width. That mismatch causes a visible layout jump every time
   * Settings opens or closes.
   *
   * Strategy: watch the main UI aside via ResizeObserver, persist the
   * latest pixel width to `api.storage`, and apply it to the settings
   * sidebar via an injected stylesheet. We seed from storage on start so
   * the very first paint of the settings page is already correct, before
   * the user has visited the main UI in this session.
   */
  "match-sidebar-width"(api) {
    const STYLE_ID = "codexpp-match-sidebar-width";
    const STORAGE_KEY = "match-sidebar-width:last";
    const ASIDE_SELECTOR =
      "aside.pointer-events-auto.relative.flex.overflow-hidden";
    const SETTINGS_SIDEBAR_SELECTOR =
      ".window-fx-sidebar-surface.w-token-sidebar";

    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);

    function applyWidth(px) {
      // Sanity-clamp; ignore zero/negative/absurd values that could be
      // observed mid-mount or during a transition.
      if (!Number.isFinite(px) || px < 120 || px > 900) return;
      // Override only the settings page sidebar. Main UI's <aside> sets
      // its own inline width — we mustn't touch it. Use !important to win
      // against the `w-token-sidebar` utility.
      style.textContent =
        `${SETTINGS_SIDEBAR_SELECTOR} { width: ${px}px !important; }`;
    }

    // Seed from last-known so the first settings-page paint matches.
    const seeded = Number(api.storage.get(STORAGE_KEY, NaN));
    if (Number.isFinite(seeded)) applyWidth(seeded);

    let resizeObs = null;
    let observed = null;

    function track(aside) {
      if (observed === aside) return;
      if (resizeObs) {
        resizeObs.disconnect();
        resizeObs = null;
      }
      observed = aside;
      if (!aside) return;
      // Pick up the current width immediately, then observe.
      const initial = Math.round(aside.getBoundingClientRect().width);
      if (initial > 0) {
        api.storage.set(STORAGE_KEY, initial);
        applyWidth(initial);
      }
      resizeObs = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const w = Math.round(
          entry.contentRect?.width ?? aside.getBoundingClientRect().width,
        );
        if (w <= 0) return;
        api.storage.set(STORAGE_KEY, w);
        applyWidth(w);
      });
      resizeObs.observe(aside);
    }

    // Settings and main UI are mutually exclusive — when navigating
    // between them, the aside is mounted/unmounted. Watch the body for
    // structural changes and re-bind whenever a new aside appears.
    track(document.querySelector(ASIDE_SELECTOR));
    const mut = new MutationObserver(() => {
      const a = document.querySelector(ASIDE_SELECTOR);
      if (a !== observed) track(a);
    });
    mut.observe(document.body, { childList: true, subtree: true });

    return () => {
      mut.disconnect();
      if (resizeObs) resizeObs.disconnect();
      style.remove();
    };
  },

  /**
   * Render the four primary sidebar actions as a compact 2x2 grid.
   *
   * We keep the native buttons and click handlers intact, hide them, and
   * render proxy buttons that forward clicks to the originals. This avoids
   * inheriting the narrow icon-button constraints Codex applies to the
   * existing action row.
   */
  "sidebar-action-grid"(api) {
    const STYLE_ID = "codexpp-sidebar-action-grid";
    const ATTR = "data-codexpp-sidebar-action-grid";
    const WRAPPER_CLASS = "grid grid-cols-2 gap-2 w-full px-row-x";
    const BUTTON_CLASS =
      "flex min-w-0 flex-col items-start justify-center gap-1 rounded-lg " +
      "border border-token-border bg-token-foreground/5 ps-3.5 pe-3.5 py-3 text-left " +
      "text-sm text-token-text-primary hover:bg-token-foreground/10 " +
      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 " +
      "focus-visible:outline-token-border cursor-interaction";
    const actions = [
      { key: "new chat", label: "New chat" },
      { key: "search", label: "Search" },
      { key: "plugins", label: "Plugins" },
      { key: "automations", label: "Automations" },
    ];

    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      [${ATTR}="group"] {
        width: 100% !important;
        grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        column-gap: var(--spacing-2, 0.5rem) !important;
        row-gap: var(--spacing-2, 0.5rem) !important;
      }

      [${ATTR}="button"] {
        display: flex !important;
        width: 100% !important;
        min-width: 0 !important;
        min-height: calc(var(--spacing-token-button-composer, 2rem) * 2.15) !important;
        color: var(--color-token-text-primary) !important;
        border: 1px solid color-mix(in srgb, currentColor 14%, transparent) !important;
        border-radius: var(--radius-lg, 0.5rem) !important;
        background-color: color-mix(in srgb, currentColor 5%, transparent) !important;
        align-items: flex-start !important;
        justify-content: center !important;
        flex-direction: column !important;
        text-align: left !important;
        gap: var(--spacing-1, 0.25rem) !important;
        overflow: hidden !important;
      }

      [${ATTR}="button"]:hover {
        background-color: color-mix(in srgb, currentColor 9%, transparent) !important;
      }

      [${ATTR}="button"] > * {
        min-width: 0;
      }

      [${ATTR}="button"] svg {
        flex-shrink: 0;
      }

      [${ATTR}="label"] {
        display: block !important;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      [${ATTR}="button"] kbd,
      [${ATTR}="button"] [class*="shortcut" i] {
        display: none !important;
      }

      [${ATTR}="original"] {
        display: none !important;
      }
    `;
    document.head.appendChild(style);

    const marked = new Set();
    let wrapper = null;
    let activeOriginals = [];

    const clearStaleNodes = () => {
      document.querySelectorAll(`[${ATTR}="group"]`).forEach((node) => {
        if (node.dataset.codexppSidebarActionOwned === "true") {
          node.remove();
        }
      });
      document.querySelectorAll(
        `[${ATTR}="original"], [${ATTR}="source"], [${ATTR}="source-original"], [${ATTR}="overlay"]`,
      ).forEach((node) => {
        node.removeAttribute(ATTR);
        if (node.dataset.codexppSidebarActionPrevClass !== undefined) {
          node.className = node.dataset.codexppSidebarActionPrevClass;
          delete node.dataset.codexppSidebarActionPrevClass;
        }
        if (node.dataset.codexppSidebarActionPrevStyle !== undefined) {
          node.style.cssText = node.dataset.codexppSidebarActionPrevStyle;
          delete node.dataset.codexppSidebarActionPrevStyle;
        }
      });
    };

    const cleanupMarks = () => {
      for (const node of marked) {
        node.removeAttribute(ATTR);
        if (node.dataset.codexppSidebarActionPrevClass !== undefined) {
          node.className = node.dataset.codexppSidebarActionPrevClass;
          delete node.dataset.codexppSidebarActionPrevClass;
        }
        if (node.dataset.codexppSidebarActionPrevStyle !== undefined) {
          node.style.cssText = node.dataset.codexppSidebarActionPrevStyle;
          delete node.dataset.codexppSidebarActionPrevStyle;
        }
      }
      marked.clear();
    };

    const removeWrapper = () => {
      wrapper?.remove();
      wrapper = null;
      activeOriginals = [];
    };

    const normalize = (value) =>
      (value || "").replace(/\s+/g, " ").trim().toLowerCase();

    const buttonLabel = (node) =>
      normalize(node.getAttribute("aria-label") || node.textContent || "")
        .replace(/\s*[⌘⇧⌥⌃^].*$/, "")
        .trim();

    const isCompositeActionText = (node) => {
      const text = normalize(node.textContent || "");
      let count = 0;
      for (const action of actions) {
        if (text.includes(action.key)) count += 1;
      }
      return count > 1;
    };

    const findMainSidebar = () => {
      const aside = document.querySelector(
        "aside.pointer-events-auto.relative.flex.overflow-hidden",
      );
      if (aside instanceof HTMLElement) return aside;
      return null;
    };

    const findActionButtons = (options = {}) => {
      const sidebar = findMainSidebar();
      if (!sidebar) return null;
      const candidates = Array.from(sidebar.querySelectorAll("button, a"))
        .filter(
          (node) =>
            node instanceof HTMLElement &&
            node.getAttribute(ATTR) !== "original" &&
            node.getAttribute(ATTR) !== "source-original" &&
            node.getAttribute(ATTR) !== "overlay" &&
            !isCompositeActionText(node),
        );
      const byLabel = new Map();
      for (const node of candidates) {
        const label = buttonLabel(node);
        if (actions.some((action) => action.key === label) && !byLabel.has(label)) {
          byLabel.set(label, node);
        }
      }
      if (actions.some((action) => !byLabel.has(action.key))) return null;
      return actions.map((action) => ({
        ...action,
        original: byLabel.get(action.key),
      }));
    };

    const commonAncestor = (nodes) => {
      if (!nodes.length) return null;
      const chain = [];
      for (let node = nodes[0]; node; node = node.parentElement) {
        chain.push(node);
      }
      return chain.find((node) => nodes.every((target) => node.contains(target)));
    };

    const markNode = (node, value) => {
      if (!marked.has(node)) {
        if (node.dataset.codexppSidebarActionPrevClass === undefined) {
          node.dataset.codexppSidebarActionPrevClass = node.className || "";
        }
        if (node.dataset.codexppSidebarActionPrevStyle === undefined) {
          node.dataset.codexppSidebarActionPrevStyle = node.style.cssText || "";
        }
        marked.add(node);
      }
      if (node.getAttribute(ATTR) !== value) node.setAttribute(ATTR, value);
    };

    const addClasses = (node, classes) => {
      const missing = classes.filter((className) => !node.classList.contains(className));
      if (missing.length) node.classList.add(...missing);
    };

    const setImportantStyle = (node, property, value) => {
      if (node.style.getPropertyValue(property) === value &&
          node.style.getPropertyPriority(property) === "important") {
        return;
      }
      node.style.setProperty(property, value, "important");
    };

    const findFullWidthMount = (sidebar, originals) => {
      const common = commonAncestor(originals);
      if (!(common instanceof HTMLElement)) return sidebar;

      const sidebarWidth = sidebar.getBoundingClientRect().width;
      let mount = common;
      while (
        mount.parentElement &&
        mount.parentElement !== sidebar &&
        mount.getBoundingClientRect().width < sidebarWidth * 0.7
      ) {
        mount = mount.parentElement;
      }
      return mount;
    };

    const createProxyButton = (action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `${BUTTON_CLASS.replace(/\bflex\b/g, "").trim()} relative`;
      btn.setAttribute(ATTR, "button");
      btn.setAttribute("aria-label", action.label);
      btn.style.setProperty("display", "block", "important");
      btn.style.setProperty("width", "100%", "important");
      btn.style.setProperty("text-align", "left", "important");

      const iconWrap = document.createElement("div");
      iconWrap.className = "mb-1 h-5 w-5 text-token-text-secondary";
      iconWrap.style.setProperty("display", "block", "important");
      iconWrap.style.setProperty("width", "1.25rem", "important");
      iconWrap.style.setProperty("height", "1.25rem", "important");

      const icon = action.original.querySelector("svg")?.cloneNode(true);
      if (icon instanceof SVGElement) {
        icon.classList.add("icon-sm", "shrink-0", "text-token-text-secondary");
        icon.setAttribute("aria-hidden", "true");
        icon.removeAttribute("aria-label");
        icon.style.setProperty("display", "block", "important");
        iconWrap.appendChild(icon);
      }

      const text = document.createElement("div");
      text.setAttribute(ATTR, "label");
      text.className = "min-w-0 max-w-full truncate leading-tight";
      text.style.setProperty("display", "block", "important");
      text.style.setProperty("width", "100%", "important");
      text.textContent = action.label;
      btn.append(iconWrap, text);

      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const live = findActionButtons({ includeHiddenSource: true })
          ?.find((candidate) => candidate.key === action.key)
          ?.original;
        activateOriginal(live || action.original);
      });

      return btn;
    };

    const activateOriginal = (original) => {
      if (!(original instanceof HTMLElement)) return;
      original.click();
      original.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
      );
      original.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      original.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, cancelable: true }),
      );
      original.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true }),
      );
      original.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    };

    const sourceHideTarget = (original) => {
      let node = original;
      while (
        node.parentElement &&
        node.parentElement !== wrapper &&
        node.parentElement.childElementCount === 1
      ) {
        node = node.parentElement;
      }
      return node;
    };

    const hideOriginals = (originals) => {
      for (const original of originals) {
        const target = sourceHideTarget(original);
        markNode(target, "source-original");
        target.style.setProperty("display", "none", "important");
      }
    };

    const stackOriginalButtonContent = (button) => {
      for (const node of button.querySelectorAll("kbd")) {
        if (node instanceof HTMLElement) {
          markNode(node, "shortcut");
          setImportantStyle(node, "display", "none");
        }
      }

      const content =
        Array.from(button.children).find(
          (child) =>
            child instanceof HTMLElement &&
            child.querySelector("svg") &&
            normalize(child.textContent || ""),
        ) || button;

      if (content instanceof HTMLElement) {
        if (content !== button) markNode(content, "content");
        setImportantStyle(content, "display", "flex");
        setImportantStyle(content, "flex-direction", "column");
        setImportantStyle(content, "align-items", "flex-start");
        setImportantStyle(content, "justify-content", "center");
        setImportantStyle(content, "gap", "var(--spacing-1, 0.25rem)");
        setImportantStyle(content, "width", "100%");
        setImportantStyle(content, "min-width", "0");
        setImportantStyle(content, "text-align", "left");
      }

      const icon = button.querySelector("svg");
      if (icon instanceof SVGElement) {
        setImportantStyle(icon, "display", "block");
        setImportantStyle(icon, "flex-shrink", "0");
      }
    };

    const apply = () => {
      clearStaleNodes();

      const sidebar = findMainSidebar();
      if (!sidebar) return;

      const actionButtons = findActionButtons();
      if (!actionButtons) return;
      const originals = actionButtons.map((action) => action.original);

      const group = commonAncestor(originals);
      if (!(group instanceof HTMLElement)) return;

      markNode(group, "group");
      addClasses(group, WRAPPER_CLASS.split(/\s+/).filter(Boolean));

      for (const action of actionButtons) {
        const original = action.original;
        markNode(original, "button");
        addClasses(
          original,
          BUTTON_CLASS.replace(/\brelative\b/g, "")
            .split(/\s+/)
            .filter(Boolean),
        );
        setImportantStyle(original, "display", "flex");
        setImportantStyle(
          original,
          "border",
          "1px solid color-mix(in srgb, currentColor 14%, transparent)",
        );
        setImportantStyle(
          original,
          "background-color",
          "color-mix(in srgb, currentColor 5%, transparent)",
        );
        setImportantStyle(original, "flex-direction", "column");
        setImportantStyle(original, "align-items", "flex-start");
        setImportantStyle(original, "justify-content", "center");
        stackOriginalButtonContent(original);
      }
      activeOriginals = originals;
    };

    let scheduled = false;
    const scheduleApply = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        apply();
      });
    };

    clearStaleNodes();
    scheduleApply();
    const obs = new MutationObserver(scheduleApply);
    obs.observe(document.body, { childList: true, subtree: true });

    api.log.info("sidebar action grid active");

    return () => {
      obs.disconnect();
      removeWrapper();
      cleanupMarks();
      style.remove();
    };
  },

  /**
   * Lightweight sidebar render monitor.
   *
   * CDP is ideal for full timeline captures, but Codex does not expose a
   * remote-debugging endpoint by default. This in-renderer monitor gives us
   * a scoped signal: DOM mutation bursts in the sidebar plus app-level React
   * commit counts while the sidebar is mounted.
   */
  "sidebar-render-monitor"(api) {
    const ASIDE_SELECTOR =
      "aside.pointer-events-auto.relative.flex.overflow-hidden";
    const FLUSH_MS = 2_000;
    const log = (...args) => api.log.info("[sidebar-monitor]", ...args);

    let sidebar = null;
    let sidebarObserver = null;
    let commitCount = 0;
    let lastCommitCount = 0;
    let flushTimer = null;
    let scanScheduled = false;
    let stats = freshStats();

    function freshStats() {
      return {
        mutations: 0,
        childList: 0,
        attributes: 0,
        characterData: 0,
        added: 0,
        removed: 0,
        classChanges: 0,
        styleChanges: 0,
        ariaChanges: 0,
      };
    }

    function findSidebar() {
      const node = document.querySelector(ASIDE_SELECTOR);
      return node instanceof HTMLElement ? node : null;
    }

    function attachSidebar(next) {
      if (sidebar === next) return;
      sidebarObserver?.disconnect();
      sidebarObserver = null;
      sidebar = next;
      if (!sidebar) return;

      sidebarObserver = new MutationObserver((records) => {
        for (const record of records) {
          stats.mutations += 1;
          if (record.type === "childList") {
            stats.childList += 1;
            stats.added += record.addedNodes.length;
            stats.removed += record.removedNodes.length;
          } else if (record.type === "attributes") {
            stats.attributes += 1;
            if (record.attributeName === "class") stats.classChanges += 1;
            else if (record.attributeName === "style") stats.styleChanges += 1;
            else if (record.attributeName?.startsWith("aria-")) {
              stats.ariaChanges += 1;
            }
          } else if (record.type === "characterData") {
            stats.characterData += 1;
          }
        }
      });
      sidebarObserver.observe(sidebar, {
        attributes: true,
        attributeFilter: ["class", "style", "aria-current", "aria-expanded", "aria-label"],
        characterData: true,
        childList: true,
        subtree: true,
      });
      log("attached", sidebarSummary(sidebar));
    }

    function sidebarSummary(node) {
      const rect = node.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        buttons: node.querySelectorAll("button, a").length,
        text: compactText(node.textContent || "").slice(0, 120),
      };
    }

    function scheduleScan() {
      if (scanScheduled) return;
      scanScheduled = true;
      requestAnimationFrame(() => {
        scanScheduled = false;
        attachSidebar(findSidebar());
      });
    }

    const documentObserver = new MutationObserver(scheduleScan);
    documentObserver.observe(document.body, { childList: true, subtree: true });
    attachSidebar(findSidebar());

    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const previousOnCommitFiberRoot = hook?.onCommitFiberRoot;
    if (hook && typeof previousOnCommitFiberRoot === "function") {
      hook.onCommitFiberRoot = function (...args) {
        if (findSidebar()) commitCount += 1;
        return previousOnCommitFiberRoot.apply(this, args);
      };
      log("react commit hook attached");
    } else {
      log("react devtools hook unavailable");
    }

    flushTimer = window.setInterval(() => {
      const commits = commitCount - lastCommitCount;
      lastCommitCount = commitCount;
      const hasDomActivity = Object.values(stats).some((value) => value > 0);
      if (hasDomActivity || commits > 0) {
        log("sample", {
          ...stats,
          commits,
          sidebar: sidebar?.isConnected ? sidebarSummary(sidebar) : null,
        });
      }
      stats = freshStats();
    }, FLUSH_MS);

    log("active");

    return () => {
      documentObserver.disconnect();
      sidebarObserver?.disconnect();
      if (flushTimer) window.clearInterval(flushTimer);
      if (
        hook &&
        typeof previousOnCommitFiberRoot === "function" &&
        hook.onCommitFiberRoot !== previousOnCommitFiberRoot
      ) {
        hook.onCommitFiberRoot = previousOnCommitFiberRoot;
      }
      log("stopped");
    };
  },
};

// ─────────────────────────────────────────────────────────────── helpers ──

// ── usage snapshot persistence ────────────────────────────────────────────
// Stored under storage["usage:snapshot"]; survives reloads. Schema:
//   { fiveHour:{kind,pct,raw} | null, weekly:{kind,pct,raw} | null, at:number }
function readSnapshot(api) {
  const v = api.storage.get("usage:snapshot", null);
  if (!v || typeof v !== "object") return null;
  return v;
}
function writeSnapshot(api, snap) {
  api.storage.set("usage:snapshot", snap);
}

/**
 * Render a single rotating usage box. Click toggles between 5h and Weekly;
 * hover replaces the content with "Resets: HH:MM". The currently-selected
 * kind is persisted to storage so it survives reloads.
 *
 * The returned element exposes `_refresh(snapshot)` so callers can update
 * values in place without unmount/remount.
 */
function renderUsageBox(api, snapshot) {
  const ORDER = ["5h", "weekly"]; // toggle order
  let kind = api.storage.get("usage:visible-kind", "5h");
  if (!ORDER.includes(kind)) kind = "5h";

  const btn = document.createElement("button");
  btn.type = "button";
  // Keep alignment consistent with the row that hosted the upgrade pill.
  btn.className =
    "flex items-center justify-between gap-2 rounded-md border border-token-border " +
    "px-2 py-1 text-xs cursor-interaction transition-colors " +
    "hover:bg-token-foreground/10";

  const left = document.createElement("span");
  left.className = "truncate";
  const right = document.createElement("span");
  right.className = "tabular-nums flex items-center gap-1";

  btn.append(left, right);

  /** Pull the entry for `kind` out of the live snapshot. */
  const entryFor = (snap, k) => (k === "5h" ? snap.fiveHour : snap.weekly);

  /** Apply colors + text for the *value* state (i.e. not hover). */
  const applyValueState = (snap) => {
    const entry = entryFor(snap, kind);
    const pct = entry?.pct;
    const remaining = typeof pct === "number" ? pct : null;
    const lowEnergy = typeof remaining === "number" && remaining < 15;

    btn.classList.toggle("bg-token-charts-red/10", lowEnergy);
    btn.classList.toggle("text-token-charts-red", lowEnergy);
    btn.classList.toggle("bg-token-foreground/5", !lowEnergy);
    btn.classList.toggle("text-token-text-primary", !lowEnergy);

    left.textContent = entry?.label || (kind === "5h" ? "5h" : "Weekly");

    right.replaceChildren();
    const pctEl = document.createElement("span");
    pctEl.textContent = remaining == null ? "—" : `${remaining}%`;
    pctEl.className = lowEnergy ? "font-medium" : "text-token-text-secondary";
    right.appendChild(pctEl);
  };

  /** Replace the entire box content with "Resets: HH:MM". */
  const applyHoverState = (snap) => {
    const entry = entryFor(snap, kind);
    left.textContent = "Resets:";
    left.className = "truncate text-token-text-secondary";
    right.replaceChildren();
    const t = document.createElement("span");
    t.className = "tabular-nums";
    t.textContent = entry?.resetAt || "—";
    right.appendChild(t);
  };

  // Bind hover with a snapshot getter so handlers always see the latest.
  let currentSnap = snapshot;
  // While true, the cursor is *inside* the box but the user has clicked
  // since their last mouseleave — we suppress hover state until they
  // physically leave the element so the click's value state is sticky.
  let suppressHover = false;

  btn.addEventListener("mouseenter", () => {
    suppressHover = false;
    applyHoverState(currentSnap);
  });
  btn.addEventListener("mouseleave", () => {
    suppressHover = false;
    left.className = "truncate";
    applyValueState(currentSnap);
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const i = ORDER.indexOf(kind);
    kind = ORDER[(i + 1) % ORDER.length];
    api.storage.set("usage:visible-kind", kind);
    // Per the design: clicking shows the OTHER kind's value, even if the
    // cursor is still over the box.
    suppressHover = true;
    left.className = "truncate";
    applyValueState(currentSnap);
  });

  // Initial paint.
  applyValueState(currentSnap);

  // Allow the parent to push fresh data without remounting us. We honour
  // the click-guard so refreshes don't reintroduce hover state mid-click.
  btn._refresh = (next) => {
    if (next === currentSnap) return;
    currentSnap = next;
    if (btn.matches(":hover") && !suppressHover) applyHoverState(currentSnap);
    else applyValueState(currentSnap);
  };

  return btn;
}

function readFlag(api, id, fallback) {
  const v = api.storage.get(`feature:${id}`, undefined);
  return typeof v === "boolean" ? v : !!fallback;
}
function writeFlag(api, id, on) {
  api.storage.set(`feature:${id}`, !!on);
}

function el(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function sectionTitle(text) {
  const titleRow = el(
    "div",
    "flex h-toolbar items-center justify-between gap-2 px-0 py-0",
  );
  const inner = el("div", "flex min-w-0 flex-1 flex-col gap-1");
  const t = el("div", "text-base font-medium text-token-text-primary");
  t.textContent = text;
  inner.appendChild(t);
  titleRow.appendChild(inner);
  return titleRow;
}

function roundedCard() {
  const card = el(
    "div",
    "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border",
  );
  card.style.backgroundColor =
    "var(--color-background-panel, var(--color-token-bg-fog))";
  return card;
}

/** Codex-native toggle (lifted verbatim from tweaks/AGENTS.md §4). */
function switchControl(initial, onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  const pill = document.createElement("span");
  const knob = document.createElement("span");
  knob.className =
    "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] " +
    "shadow-sm transition-transform duration-200 ease-out h-4 w-4";
  pill.appendChild(knob);
  const apply = (on) => {
    btn.setAttribute("aria-checked", String(on));
    btn.dataset.state = on ? "checked" : "unchecked";
    btn.className =
      "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 " +
      "focus-visible:ring-token-focus-border focus-visible:rounded-full cursor-interaction";
    pill.className =
      "relative inline-flex shrink-0 items-center rounded-full transition-colors " +
      "duration-200 ease-out h-5 w-8 " +
      (on ? "bg-token-charts-blue" : "bg-token-foreground/20");
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
      await onChange?.(next);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
