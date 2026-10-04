// Port of PolymarketAnalyzer from polymarket_gui.py. Keep the two in sync:
// same API calls, same filters, same log lines (so exports match the desktop app).
(function () {
  "use strict";

  const D = window.PM_DATA;
  const BASE_URL = "https://data-api.polymarket.com";
  const SPORTS_URL = "https://gamma-api.polymarket.com/sports";
  const DATE_RE = /\d{4}-\d{2}-\d{2}/;
  const SPORT_LABELS = new Set(D.SPORT_LABELS);
  const CONCURRENCY = 4;   // traders checked in parallel (desktop app is sequential)

  // "Sports" matches every sport's keywords, as in the desktop app
  const CATEGORIES = D.CATEGORIES.map((c) => ({ label: c.label, keywords: c.keywords.slice() }));
  const sports = CATEGORIES.find((c) => c.label === "Sports");
  sports.keywords = [...new Set([
    ...sports.keywords,
    ...CATEGORIES.filter((c) => SPORT_LABELS.has(c.label)).flatMap((c) => c.keywords),
  ])].sort();

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRe = (words) => new RegExp("\\b(?:" + words.map(escapeRe).join("|") + ")\\b", "g");

  // ── formatting (mirrors Python format specs) ──────────────────────────────
  const num = (v) => Number(v) || 0;
  const grouped = (n, d) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const rule = (ch, n) => ch.repeat(n);

  function pick(obj, ...keys) {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return obj[k];
    return undefined;
  }

  class Analyzer {
    constructor(params, { emit, onProgress, onTraders, onMarkets }) {
      this.params = params;
      this.emitFn = emit;
      this.onProgress = onProgress || (() => {});
      this.onTraders = onTraders || (() => {});
      this.onMarkets = onMarkets || (() => {});
      this.stopped = false;
      this.controller = new AbortController();
    }

    stop() {
      this.stopped = true;
      this.controller.abort();
    }

    emit(msg = "", tag = null) {
      this.emitFn(String(msg), tag);
    }

    async apiGet(endpoint, params, emit = this.emit.bind(this)) {
      if (this.stopped) return null;
      const url = new URL(BASE_URL + endpoint);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
      for (let attempt = 0; ; attempt++) {
        let r;
        try {
          r = await fetch(url, { signal: this.controller.signal });
        } catch (e) {
          if (this.stopped) return null;
          emit(`  [E002] ${D.ERROR_CODES.E002}: ${e.message}`, "error");
          return null;
        }
        if (r.status === 429 && attempt < 3) {
          await this.sleep(1000 * (attempt + 1));
          if (this.stopped) return null;
          continue;
        }
        if (r.status !== 200) {
          emit(`  [E003] ${D.ERROR_CODES.E003} — HTTP ${r.status}`, "error");
          return null;
        }
        try {
          return await r.json();
        } catch (e) {
          if (this.stopped) return null;
          emit(`  [E004] ${D.ERROR_CODES.E004}`, "error");
          return null;
        }
      }
    }

    sleep(ms) {
      return new Promise((res) => setTimeout(res, ms));
    }

    async getLeagueMap() {
      const leagues = { ...D.LEAGUE_CATEGORY_OVERRIDES };
      let data;
      try {
        data = await (await fetch(SPORTS_URL)).json();
      } catch (e) {
        this.emit("  Could not load league list — using built-in leagues only.", "warn");
        return leagues;
      }
      for (const league of Array.isArray(data) ? data : []) {
        const code = (league.sport || "").toLowerCase();
        if (!code || code in leagues) continue;
        const tags = (league.tags || "").split(",");
        const tag = tags.find((t) => t in D.SPORT_TAG_CATEGORIES);
        leagues[code] = tag ? D.SPORT_TAG_CATEGORIES[tag] : null;
      }
      return leagues;
    }

    async getLeaderboard() {
      this.emit("  Getting monthly leaderboard...", "info");
      const target = this.params.leaderboard_limit;
      const pageSize = 50;   // API hard cap per request
      const all = [];
      let offset = 0;
      while (all.length < target) {
        if (this.stopped) break;
        const fetchN = Math.min(pageSize, target - all.length);
        let data = await this.apiGet("/v1/leaderboard", { timePeriod: "MONTH", limit: fetchN, offset });
        if (data === null) {
          if (this.stopped) break;
          throw new Error(`[E006] ${D.ERROR_CODES.E006}`);
        }
        if (data && !Array.isArray(data) && typeof data === "object") {
          if ("data" in data) data = data.data;
          else throw new Error(`[E004] ${D.ERROR_CODES.E004}`);
        }
        if (!Array.isArray(data)) throw new Error(`[E004] ${D.ERROR_CODES.E004}`);
        if (!data.length) break;
        all.push(...data);
        if (data.length < fetchN) break;   // ran out of entries on the server
        offset += data.length;
      }
      this.emit(`  Retrieved ${all.length} leaderboard entries.`, "info");
      return all;
    }

    async getUserVolume(wallet, startTs, endTs, emit) {
      const data = await this.apiGet("/v2/user-volume", { user: wallet, start: startTs, end: endTs }, emit);
      if (data === null) return null;
      if (data && typeof data === "object" && !Array.isArray(data) && "data" in data) return data.data;
      return data;
    }

    async getPositions(wallet, emit) {
      const positions = [];
      let cursor = null;
      let page = 1;
      while (true) {
        if (this.stopped) break;
        const params = { user: wallet, limit: 500 };
        if (cursor) params.cursor = cursor;
        const data = await this.apiGet("/v2/positions", params, emit);
        if (data === null) break;
        let pagePositions, nextCursor;
        if (Array.isArray(data)) {
          pagePositions = data;
          nextCursor = null;
        } else if (data && typeof data === "object") {
          pagePositions = data.data || [];
          const pagination = data.pagination || {};
          nextCursor = pagination.next_cursor || data.next_cursor || data.nextCursor;
          if (pagination.has_more === false) nextCursor = null;
        } else {
          break;
        }
        if (!Array.isArray(pagePositions)) break;
        // "open" includes resolved markets the trader hasn't redeemed yet — skip those
        const live = pagePositions.filter(
          (p) => !p.redeemable && String(p.status || "").toUpperCase() !== "REDEEMABLE"
        );
        positions.push(...live);
        emit(`      Page ${page}: ${live.length} live positions`, "dim");
        if (!nextCursor || nextCursor === cursor) break;
        // API sorts by current value (desc): once a page reaches dust, the rest is dust too
        const last = pagePositions.length ? pagePositions[pagePositions.length - 1] : {};
        const lastValue = num(pick(last, "current_value", "currentValue"));
        if (lastValue < D.MIN_POSITION_VALUE) {
          emit(`      Skipping remaining positions worth under $${D.MIN_POSITION_VALUE.toFixed(0)}`, "dim");
          break;
        }
        cursor = nextCursor;
        page += 1;
      }
      return positions;
    }

    async checkTrader(trader, i, total, ctx, emit) {
      const wallet = trader.proxyWallet || trader.wallet || trader.address;
      const username = trader.userName || trader.username || trader.name || trader.pseudonym || wallet;
      const idx = `[${String(i).padStart(3)}/${total}]`;
      if (!wallet) {
        emit(`  ${idx} (no wallet) — skipping`, "dim");
        return null;
      }
      const pnl = num(trader.pnl);

      const activity = await this.getUserVolume(wallet, ctx.startTs, ctx.endTs, emit);
      if (this.stopped) return null;
      if (!activity || (typeof activity === "object" && !Object.keys(activity).length)) {
        emit(`  ${idx} ${username} — no activity data`, "dim");
        return null;
      }
      const tradeCount = Math.trunc(num(activity.trade_count));
      const tradesPerDay = tradeCount / ctx.daysElapsed;
      const line = `  ${idx} ${String(username).padEnd(28)} ` +
        `${grouped(tradeCount, 0).padStart(6)}  ${tradesPerDay.toFixed(1).padStart(6)}/day  `;

      if (tradesPerDay < this.params.min_trades_per_day) {
        emit(line + "FAIL", "fail");
        return null;
      }
      emit(line + "PASS", "pass");
      emit("      Checking positions...", "dim");

      const rawPositions = await this.getPositions(wallet, emit);
      if (this.stopped) return null;
      const posCount = rawPositions.length;
      if (posCount < this.params.min_active_positions) {
        emit(`      ${posCount} active positions — FAIL (needs ≥ ${this.params.min_active_positions})`, "fail");
        return null;
      }
      emit(`      ${posCount} active positions — PASS`, "pass");
      return {
        username, wallet, pnl,
        trade_count: tradeCount,
        trades_per_day: tradesPerDay,
        active_positions: posCount,
        raw_positions: rawPositions,
      };
    }

    async findQualifyingTraders(leaderboard) {
      const p = this.params;
      this.emit("");
      this.emit(rule("=", 62), "header");
      this.emit("  FILTERING MONTHLY LEADERBOARD", "header");
      this.emit(rule("=", 62), "header");

      const endTs = Math.floor(Date.now() / 1000);
      const startTs = endTs - p.days_lookback * 86400;
      const ctx = { startTs, endTs, daysElapsed: (endTs - startTs) / 86400 };

      this.emit(`\n  Activity window:  last ${p.days_lookback} days`);
      this.emit("  Requirements:");
      this.emit(`    ≥ ${p.min_trades_per_day} avg trades/day`);
      this.emit(`    ≥ ${p.min_active_positions} active positions`);
      this.emit(`    Top ${p.top_n} by monthly P&L`);
      this.emit("");

      const total = Math.min(leaderboard.length, p.leaderboard_limit);
      const traders = leaderboard.slice(0, total);
      const candidates = [];

      // Run traders in parallel but print each trader's lines in leaderboard order
      const buffers = new Array(total);
      const done = new Array(total).fill(false);
      let flushed = 0, next = 0, checked = 0;
      const flush = () => {
        while (flushed < total && done[flushed]) {
          for (const [m, t] of buffers[flushed]) this.emit(m, t);
          buffers[flushed] = null;
          flushed++;
        }
      };

      const worker = async () => {
        while (!this.stopped && next < total) {
          const i = next++;
          const lines = (buffers[i] = []);
          const result = await this.checkTrader(traders[i], i + 1, total, ctx, (m = "", t = null) => lines.push([String(m), t]));
          if (this.stopped) return;
          if (result) candidates.push(result);
          done[i] = true;
          checked++;
          flush();
          this.onProgress({ checked, total, qualifying: candidates.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

      if (this.stopped) {
        // print whatever finished in order before the stop
        for (let i = flushed; i < total; i++) if (done[i]) for (const [m, t] of buffers[i]) this.emit(m, t);
        this.emit(`\n  [E007] ${D.ERROR_CODES.E007}`, "warn");
      }

      candidates.sort((a, b) => b.pnl - a.pnl);
      return candidates.slice(0, p.top_n);
    }

    static normalizePosition(position, trader) {
      const oi = position.outcomeIndex !== undefined && position.outcomeIndex !== null
        ? position.outcomeIndex : position.outcome_index;
      return {
        username: trader.username,
        wallet: trader.wallet,
        monthly_pnl: trader.pnl || 0,
        conditionId: position.conditionId || position.condition_id || "",
        title: position.title || position.market || position.question || "",
        slug: (position.event_slug || position.eventSlug || position.slug || "").toLowerCase(),
        outcome: position.outcome || position.outcomeName || "",
        outcomeIndex: oi === undefined ? null : oi,
        size: num(pick(position, "size", "current_size")),
        avgPrice: num(pick(position, "avgPrice", "avg_price")),
        currentValue: num(pick(position, "currentValue", "current_value")),
        cashPnl: num(pick(position, "cashPnl", "total_pnl")),
      };
    }

    static outcomeKey(p) {
      return p.outcomeIndex !== null ? String(p.outcomeIndex) : p.outcome.toLowerCase().trim();
    }

    findSharedMarkets(topTraders) {
      const markets = new Map();
      for (const trader of topTraders) {
        for (const raw of trader.raw_positions) {
          const pos = Analyzer.normalizePosition(raw, trader);
          if (!pos.conditionId) continue;
          if (!markets.has(pos.conditionId)) markets.set(pos.conditionId, []);
          markets.get(pos.conditionId).push(pos);
        }
      }

      const categories = this.params.categories;
      const keywords = this.params.category_keywords.map((k) => k.toLowerCase());
      const kwRe = keywords.length ? wordRe(keywords) : null;
      const leagueMap = this.leagueMap;
      // longest league codes first so "atp-doubles" wins over "atp"
      const leagueCodes = Object.keys(leagueMap).sort((a, b) => b.length - a.length);
      const categoryRes = CATEGORIES
        .filter((c) => c.keywords.length && c.label !== "Sports")
        .map((c) => [c.label, wordRe(c.keywords)]);

      const marketLeague = (positions) => {
        const slug = (positions.find((p) => p.slug) || {}).slug || "";
        const league = leagueCodes.find((c) => slug.startsWith(c + "-"));
        // 2-letter codes collide with US states (sc-07-house...): require a game date
        if (league && league.length <= 2 && !DATE_RE.test(slug)) return null;
        return league === undefined ? null : league;
      };
      const marketTitle = (positions) => ((positions.find((p) => p.title) || {}).title || "").toLowerCase();
      const bestCategories = (title) => {
        // shared team names ("cardinals", "giants") hit several sports, so
        // keep only the categories with the most distinct keyword hits
        const scores = categoryRes.map(([label, rx]) => [label, new Set(title.match(rx) || []).size]);
        const top = Math.max(0, ...scores.map(([, n]) => n));
        return scores.filter(([, n]) => n && n === top).map(([label]) => label);
      };
      const matchesCategory = (positions) => {
        const league = marketLeague(positions);
        if (league !== null) {
          // game market from a known league: classify by league only
          return categories.has("Sports") || categories.has(leagueMap[league]);
        }
        const title = marketTitle(positions);
        const best = bestCategories(title);
        if (best.some((l) => categories.has(l))) return true;
        if (categories.has("Sports")) {
          kwRe && (kwRe.lastIndex = 0);
          return best.some((l) => SPORT_LABELS.has(l)) || Boolean(kwRe && kwRe.test(title));
        }
        return false;
      };
      const categoryLabel = (positions) => {
        const league = marketLeague(positions);
        if (league !== null) return leagueMap[league] || "Sports";
        const found = bestCategories(marketTitle(positions));
        // prefer a category the user filtered on
        return found.find((l) => categories.has(l)) || found[0] || null;
      };

      const shared = [];
      for (const [conditionId, positions] of markets) {
        const byWallet = new Map();
        for (const p of positions) byWallet.set(p.wallet, p);
        if (byWallet.size < 2) continue;
        const list = [...byWallet.values()];

        if (this.params.same_outcome_only && new Set(list.map(Analyzer.outcomeKey)).size !== 1) continue;
        if (categories.size && !matchesCategory(list)) continue;

        shared.push({ conditionId, positions: list, category: categoryLabel(list) });
      }
      shared.sort((a, b) => b.positions.length - a.positions.length);
      return shared;
    }

    async run() {
      const p = this.params;
      try {
        this.emit("");
        this.emit(rule("=", 62), "header");
        this.emit("  POLYMARKET POSITION OVERLAP ANALYZER", "header");
        this.emit(rule("=", 62), "header");
        this.emit(`\n  ${D.DISCLAIMER}`, "warn");
        this.emit("");
        this.emit("  Parameters");
        this.emit(`  ${rule("─", 48)}`, "dim");
        this.emit(`  Leaderboard size:   ${p.leaderboard_limit}`);
        this.emit(`  Min trades/day:     ${p.min_trades_per_day}`);
        this.emit(`  Activity window:    ${p.days_lookback} days`);
        this.emit(`  Min positions:      ${p.min_active_positions}`);
        this.emit(`  Traders analyzed:   ${p.top_n}`);
        this.emit(`  Overlap filter:     ${p.same_outcome_only ? "Same outcome only" : "All shared markets"}`);
        this.emit(`  Category filter:    ${p.categories.size ? [...p.categories].sort().join(", ") : "All markets"}`);
        this.emit("");

        const leaderboard = await this.getLeaderboard();
        const topTraders = await this.findQualifyingTraders(leaderboard);

        this.leagueMap = await this.getLeagueMap();

        if (!topTraders.length) {
          this.emit(`\n  [E005] ${D.ERROR_CODES.E005}`, "error");
          return;
        }

        this.emit("");
        this.emit(rule("=", 62), "header");
        this.emit("  QUALIFYING TRADERS", "header");
        this.emit(rule("=", 62), "header");
        this.emit("");
        topTraders.forEach((t, i) => {
          this.emit(
            `  ${String(i + 1).padStart(2)}.  ${String(t.username).padEnd(28)} ` +
            `P&L: $${grouped(t.pnl, 2).padStart(14)}   ` +
            `${t.trades_per_day.toFixed(1).padStart(5)}/day   ` +
            `${t.active_positions} positions`
          );
        });
        this.onTraders(topTraders);

        const shared = this.findSharedMarkets(topTraders);
        this.onMarkets(shared);

        this.emit("");
        this.emit(rule("=", 62), "header");
        this.emit("  CURRENT POSITION OVERLAPS", "header");
        this.emit(rule("=", 62), "header");
        this.emit(`\n  Found ${shared.length} overlapping markets.`);

        if (!shared.length) {
          this.emit("  No overlapping positions found.", "dim");
          return;
        }

        shared.forEach((market, n) => {
          const positions = market.positions;
          const title = (positions.find((x) => x.title) || {}).title || "Unknown market";
          const sameDir = new Set(positions.map(Analyzer.outcomeKey)).size === 1;

          this.emit("");
          this.emit("  " + rule("─", 58), "separator");
          const category = market.category ? `  —  ${market.category.toUpperCase()}` : "";
          this.emit(`  #${n + 1}  —  ${positions.length} TRADERS${category}`, "market_header");
          this.emit("  " + rule("─", 58), "separator");
          this.emit(`  ${title}`, "market_title");
          this.emit(`  Condition ID: ${market.conditionId}`, "dim");
          if (sameDir) this.emit("  POSITION RELATIONSHIP: SAME OUTCOME", "pass");
          else this.emit("  POSITION RELATIONSHIP: OPPOSING OUTCOMES", "warn");
          this.emit("");

          for (const x of positions) {
            this.emit(`    ${x.username}   (Monthly P&L: $${grouped(x.monthly_pnl, 2)})`, "trader_name");
            this.emit(`        Outcome:        ${x.outcome}`);
            this.emit(`        Position size:  ${grouped(x.size, 2).padStart(12)}`);
            this.emit(`        Current value:  $${grouped(x.currentValue, 2).padStart(11)}`);
            this.emit(`        Average price:  ${x.avgPrice.toFixed(4)}`);
            this.emit(`        Cash P&L:       $${grouped(x.cashPnl, 2).padStart(11)}`);
            this.emit("");
          }
        });

        this.emit(rule("=", 62), "header");
        this.emit("  ANALYSIS COMPLETE", "header");
        this.emit(rule("=", 62), "header");
        this.emit(`\n  Traders examined:     ${p.leaderboard_limit}`);
        this.emit(`  Qualifying traders:   ${topTraders.length}`);
        this.emit(`  Overlapping markets:  ${shared.length}`);
        this.emit("");
      } catch (e) {
        this.emit(`\n  ERROR: ${e.message}`, "error");
        if (e.stack) this.emit(e.stack, "error");
      }
    }
  }

  Analyzer.CATEGORIES = CATEGORIES;
  Analyzer.sameDirection = (positions) => new Set(positions.map(Analyzer.outcomeKey)).size === 1;
  window.Analyzer = Analyzer;
})();
