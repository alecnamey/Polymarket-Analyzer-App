// UI for the web version — mirrors PolymarketGUI in polymarket_gui.py.
(function () {
  "use strict";

  const D = window.PM_DATA;
  const RELEASES_API = "https://api.github.com/repos/alecnamey/Polymarket-Analyzer-App/releases/latest";
  const RELEASES_URL = "https://github.com/alecnamey/Polymarket-Analyzer-App/releases/latest";
  const CHIP_ROWS = [
    ["All", "Politics", "Weather", "Crypto", "Tech", "Culture", "Economy", "Sports"],
    ["Football", "Soccer", "Basketball", "Baseball", "Tennis", "Cricket", "Golf",
     "eSports", "Hockey", "Boxing", "MMA"],
  ];
  const STORE_KEY = "pm-settings";

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  };
  const money = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fixed2 = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── state ────────────────────────────────────────────────────────────────
  const state = {
    sameOutcome: false,
    categories: new Set(["All"]),
    values: Object.fromEntries(D.PARAM_ORDER.map((k) => [k, String(D.PARAM_LIMITS[k][2])])),
    errors: new Set(),
    analyzer: null,
    logLines: [],
    tabTouched: false,
  };

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (!s) return;
      if (typeof s.sameOutcome === "boolean") state.sameOutcome = s.sameOutcome;
      if (Array.isArray(s.categories) && s.categories.length) state.categories = new Set(s.categories);
      if (s.values) for (const k of D.PARAM_ORDER) if (typeof s.values[k] === "string") state.values[k] = s.values[k];
    } catch (e) {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        sameOutcome: state.sameOutcome,
        categories: [...state.categories],
        values: state.values,
      }));
    } catch (e) {}
  }

  // ── header / footer ──────────────────────────────────────────────────────
  function buildChrome() {
    $("disclaimer").textContent = D.DISCLAIMER;
    const footer = $("footer");
    for (const [text, url] of D.LINKS) {
      if (url === "https://github.com") continue;
      footer.append(el("a", { href: url, target: "_blank", rel: "noopener", text }));
    }
    footer.append(el("a", { href: RELEASES_URL, target: "_blank", rel: "noopener", text: "Download desktop app" }));

    $("theme-toggle").addEventListener("click", () => {
      const root = document.documentElement;
      const current = root.dataset.theme ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      root.dataset.theme = current === "dark" ? "light" : "dark";
      try { localStorage.setItem("pm-theme", root.dataset.theme); } catch (e) {}
    });

    fetch(RELEASES_API)
      .then((r) => (r.ok ? r.json() : null))
      .then((rel) => {
        if (rel && rel.tag_name) $("latest-version").textContent = rel.tag_name;
      })
      .catch(() => {});

    const guide = $("guide");
    $("help-btn").addEventListener("click", () => guide.showModal());
    $("guide-close").addEventListener("click", () => guide.close());
    guide.addEventListener("click", (e) => { if (e.target === guide) guide.close(); });
  }

  // ── overlap filter ───────────────────────────────────────────────────────
  function renderOverlap() {
    for (const b of document.querySelectorAll(".seg")) {
      const on = (b.dataset.mode === "same") === state.sameOutcome;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
    }
  }

  // ── parameters ───────────────────────────────────────────────────────────
  function buildParams() {
    const wrap = $("params");
    for (const key of D.PARAM_ORDER) {
      const [lo, hi, , , unit] = D.PARAM_LIMITS[key];
      const id = "p-" + key;
      const input = el("input", {
        id, type: "number", inputmode: "numeric", min: lo, max: hi, step: 1,
      });
      input.value = state.values[key];
      const err = el("span", { class: "err" });
      input.addEventListener("input", () => {
        state.values[key] = input.value.trim();
        validate(key, input, err);
        gateRun();
        saveSettings();
      });
      wrap.append(el("div", { class: "param" },
        el("label", { for: id, text: D.PARAM_LABELS[key] }),
        el("div", { class: "input-wrap" }, input, unit ? el("span", { class: "unit", text: unit }) : null),
        err,
      ));
      validate(key, input, err);
    }
  }

  function validate(key, input, err) {
    const [lo, hi] = D.PARAM_LIMITS[key];
    const raw = state.values[key];
    let msg = "";
    if (raw === "") msg = "Required";
    else if (!Number.isFinite(Number(raw))) msg = "Enter a number";
    else if (Number(raw) < lo || Number(raw) > hi) msg = `Must be ${lo}–${hi}`;
    err.textContent = msg;
    input.classList.toggle("invalid", Boolean(msg));
    input.setAttribute("aria-invalid", Boolean(msg));
    if (msg) state.errors.add(key); else state.errors.delete(key);
  }

  // ── categories ───────────────────────────────────────────────────────────
  function buildChips() {
    const rows = [$("chips-general"), $("chips-sports")];
    CHIP_ROWS.forEach((labels, r) => {
      for (const label of labels) {
        const b = el("button", { type: "button", class: "chip", "data-label": label, text: label });
        b.addEventListener("click", () => toggleChip(label));
        rows[r].append(b);
      }
    });
    renderChips();
  }

  function toggleChip(label) {
    const cats = state.categories;
    if (label === "All") {
      state.categories = new Set(["All"]);
    } else {
      cats.delete("All");
      if (cats.has(label)) {
        cats.delete(label);
        if (!cats.size) cats.add("All");
      } else {
        cats.add(label);
      }
    }
    renderChips();
    saveSettings();
  }

  function renderChips() {
    for (const b of document.querySelectorAll(".chip")) {
      const on = state.categories.has(b.dataset.label);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
    }
  }

  function activeKeywords() {
    if (state.categories.has("All")) return [];
    return window.Analyzer.CATEGORIES
      .filter((c) => state.categories.has(c.label))
      .flatMap((c) => c.keywords);
  }

  // ── tabs ─────────────────────────────────────────────────────────────────
  function showTab(name) {
    for (const t of document.querySelectorAll(".tab")) {
      const on = t.dataset.tab === name;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on);
    }
    $("tab-results").hidden = name !== "results";
    $("tab-log").hidden = name !== "log";
  }

  // ── log ──────────────────────────────────────────────────────────────────
  let pending = [];
  let flushQueued = false;

  function emit(msg, tag) {
    state.logLines.push(msg);
    pending.push([msg, tag]);
    if (!flushQueued) {
      flushQueued = true;
      requestAnimationFrame(flushLog);
    }
  }

  function flushLog() {
    flushQueued = false;
    const log = $("log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const [msg, tag] of pending) {
      frag.append(tag ? el("span", { class: tag, text: msg + "\n" }) : msg + "\n");
    }
    pending = [];
    log.append(frag);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  // ── results ──────────────────────────────────────────────────────────────
  const profileUrl = (wallet) => `https://polymarket.com/profile/${wallet}`;
  // unnamed accounts show as "0x<40 hex>-<timestamp>": shorten for display
  const displayName = (name) => {
    const m = /^(0x[0-9a-f]{40})(-\d+)?$/i.exec(String(name));
    return m ? `${m[1].slice(0, 6)}…${m[1].slice(-4)}` : String(name);
  };
  const traderLink = (name, wallet) =>
    el("a", { class: "trader-link", href: profileUrl(wallet), target: "_blank", rel: "noopener", title: String(name), text: displayName(name) });
  const PAGE_SIZE = 50;

  function renderTraders(traders) {
    const table = $("traders-table");
    table.replaceChildren(
      el("thead", {}, el("tr", {},
        el("th", { class: "num", text: "#" }),
        el("th", { text: "Trader" }),
        el("th", { class: "num", text: "Monthly P&L" }),
        el("th", { class: "num", text: "Trades / day" }),
        el("th", { class: "num", text: "Open positions" }),
      )),
      el("tbody", {}, ...traders.map((t, i) => el("tr", {},
        el("td", { class: "num dim", text: String(i + 1) }),
        el("td", {}, traderLink(t.username, t.wallet)),
        el("td", { class: "num " + (t.pnl >= 0 ? "pos" : "neg"), text: money(t.pnl) }),
        el("td", { class: "num", text: t.trades_per_day.toFixed(1) }),
        el("td", { class: "num", text: String(t.active_positions) }),
      ))),
    );
    $("traders-section").hidden = false;
    $("results-empty").hidden = true;
  }

  function renderMarkets(markets) {
    const box = $("markets");
    box.replaceChildren();
    $("markets-heading").textContent = markets.length
      ? `Overlapping markets (${markets.length})`
      : "Overlapping markets";
    $("results-count").textContent = String(markets.length);

    if (!markets.length) {
      box.append(el("p", { class: "dim", text: "No overlapping positions found with these filters." }));
    }

    let shown = 0;
    const more = el("button", { class: "btn more", type: "button" });
    const showMore = () => {
      const end = Math.min(shown + PAGE_SIZE, markets.length);
      for (let n = shown; n < end; n++) box.insertBefore(marketCard(markets[n], n), more);
      shown = end;
      more.textContent = `Show more (${markets.length - shown} remaining)`;
      more.hidden = shown >= markets.length;
    };
    more.addEventListener("click", showMore);
    box.append(more);
    showMore();
    $("markets-section").hidden = false;
    $("results-empty").hidden = true;
  }

  function marketCard(m, n) {
    const positions = m.positions;
    const titlePos = positions.find((p) => p.title) || {};
    const slugPos = positions.find((p) => p.slug);
    const title = titlePos.title || "Unknown market";
    const same = window.Analyzer.sameDirection(positions);

    const titleNode = slugPos
      ? el("a", { class: "market-title", href: `https://polymarket.com/event/${slugPos.slug}`, target: "_blank", rel: "noopener", text: title })
      : el("div", { class: "market-title", text: title });

    return el("article", { class: "market" },
      el("div", { class: "market-head" },
        el("div", { class: "market-meta" },
          el("span", { text: `#${n + 1}` }),
          el("span", { text: `${positions.length} traders` }),
          m.category ? el("span", { class: "badge cat", text: m.category }) : null,
          el("span", { class: "badge " + (same ? "same" : "opposing"), text: same ? "Same outcome" : "Opposing outcomes" }),
        ),
        titleNode,
        el("div", { class: "cid dim", text: m.conditionId }),
      ),
      el("div", { class: "table-wrap" }, el("table", {},
        el("thead", {}, el("tr", {},
          el("th", { text: "Trader" }),
          el("th", { text: "Outcome" }),
          el("th", { class: "num", text: "Size" }),
          el("th", { class: "num", text: "Value" }),
          el("th", { class: "num", text: "Avg price" }),
          el("th", { class: "num", text: "Cash P&L" }),
          el("th", { class: "num", text: "Monthly P&L" }),
        )),
        el("tbody", {}, ...positions.map((p) => el("tr", {},
          el("td", {}, traderLink(p.username, p.wallet)),
          el("td", { text: p.outcome }),
          el("td", { class: "num", text: fixed2(p.size) }),
          el("td", { class: "num", text: money(p.currentValue) }),
          el("td", { class: "num", text: p.avgPrice.toFixed(4) }),
          el("td", { class: "num " + (p.cashPnl >= 0 ? "pos" : "neg"), text: money(p.cashPnl) }),
          el("td", { class: "num dim", text: money(p.monthly_pnl) }),
        ))),
      )),
    );
  }

  function clearOutput() {
    state.logLines = [];
    pending = [];
    $("log").replaceChildren();
    $("traders-table").replaceChildren();
    $("markets").replaceChildren();
    $("traders-section").hidden = true;
    $("markets-section").hidden = true;
    $("results-empty").hidden = false;
    $("results-count").textContent = "";
  }

  // ── status ───────────────────────────────────────────────────────────────
  function setStatus(text, detail = "") {
    $("status-bar").hidden = false;
    $("status-text").textContent = text;
    $("status-detail").textContent = detail;
  }

  function setProgress(fraction) {
    const bar = document.querySelector(".progress");
    bar.classList.toggle("indeterminate", fraction === null);
    $("progress-fill").style.width = fraction === null ? "" : `${Math.round(fraction * 100)}%`;
  }

  // ── actions ──────────────────────────────────────────────────────────────
  function gateRun() {
    $("run-btn").disabled = Boolean(state.analyzer) || state.errors.size > 0;
  }

  async function startAnalysis() {
    if (state.analyzer || state.errors.size) return;
    const v = (k) => Math.trunc(Number(state.values[k]));
    const params = {
      leaderboard_limit: v("leaderboard_limit"),
      min_trades_per_day: v("min_trades_per_day"),
      days_lookback: v("days_lookback"),
      min_active_positions: v("min_active_positions"),
      top_n: v("top_n"),
      same_outcome_only: state.sameOutcome,
      category_keywords: activeKeywords(),
      categories: state.categories.has("All") ? new Set() : new Set(state.categories),
    };

    clearOutput();
    state.tabTouched = false;
    showTab("log");
    setStatus("Fetching leaderboard…");
    setProgress(null);

    const analyzer = new window.Analyzer(params, {
      emit,
      onProgress: ({ checked, total, qualifying }) => {
        setProgress(checked / total);
        setStatus(`Checking traders… ${checked} / ${total}`, `${qualifying} qualifying`);
      },
      onTraders: renderTraders,
      onMarkets: renderMarkets,
    });
    state.analyzer = analyzer;
    gateRun();
    $("stop-btn").disabled = false;

    await analyzer.run();

    state.analyzer = null;
    gateRun();
    $("stop-btn").disabled = true;
    setProgress(1);
    const found = $("results-count").textContent;
    if (analyzer.stopped) setStatus("Analysis stopped.", found ? `${found} overlapping markets` : "");
    else setStatus("Analysis complete.", found ? `${found} overlapping markets` : "");
    if (!state.tabTouched && !$("traders-section").hidden) showTab("results");
  }

  function stopAnalysis() {
    if (!state.analyzer) return;
    state.analyzer.stop();
    $("stop-btn").disabled = true;
    setStatus("Stopping…");
  }

  function exportResults() {
    const content = state.logLines.join("\n");
    if (!content.trim()) {
      setStatus("Nothing to export — run the analysis first.");
      return;
    }
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const a = el("a", { href: url, download: `polymarket_analysis_${ts}.txt` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── init ─────────────────────────────────────────────────────────────────
  loadSettings();
  buildChrome();
  buildParams();
  buildChips();
  renderOverlap();
  showTab("results");
  gateRun();

  for (const b of document.querySelectorAll(".seg")) {
    b.addEventListener("click", () => {
      state.sameOutcome = b.dataset.mode === "same";
      renderOverlap();
      saveSettings();
    });
  }
  for (const t of document.querySelectorAll(".tab")) {
    t.addEventListener("click", () => {
      state.tabTouched = true;
      showTab(t.dataset.tab);
    });
  }
  $("run-btn").addEventListener("click", startAnalysis);
  $("stop-btn").addEventListener("click", stopAnalysis);
  $("clear-btn").addEventListener("click", () => {
    if (state.analyzer) return;
    clearOutput();
    $("status-bar").hidden = true;
  });
  $("export-btn").addEventListener("click", exportResults);
})();
