/**
 * Tradex — local trading dashboard (LOCAL, READ-ONLY).
 *
 * A tiny zero-dependency Node server (Node 18+ has global fetch). It reads each
 * bot's local files AND polls that bot's own Alpaca PAPER account for live
 * equity / positions / orders, then serves an auto-refreshing browser page.
 *
 * It NEVER places, cancels, or modifies an order. Every Alpaca call here is a
 * GET.
 *
 *   node dashboard/server.js          → http://localhost:4000
 *   PORT=4100 node dashboard/server.js
 */
import http from "http";
import { readFileSync, statSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, ".."); // the Trading folder
const PORT = process.env.PORT || 4000;
const ALPACA_BASE =
  process.env.APCA_BASE_URL || "https://paper-api.alpaca.markets";

// ── Which bots exist, and what makes each one different ──────────────────────
// Bot A (ORB long-only) was retired 2026-07-28 — see POSTMORTEM-BOT-A.md. Its
// data lives in archive/bot-a-orb/ and is deliberately NOT shown here: this is a
// live monitor, and a retired strategy's flat account is noise. Bot D was removed
// (it never traded — placeholder keys — and its premise came from the CSV
// pairing bug that realizedForBot() above now fixes). The Coinbase donchian bot
// was retired 2026-07-28 too — archive/crypto-donchian/ — so this dashboard is
// now Alpaca-only.
const BOTS = [
  {
    id: "b",
    label: "Bot B",
    dir: "bot b",
    account: "PA3ZJ1EX28BW",
    flavor: "ORB long + short + trailing",
    defaultSide: null, // mixed — rely on the Side column
    startingEquity: 100000,
  },
  {
    id: "c",
    label: "Bot C",
    dir: "bot c",
    account: "PA3ZMXLQJZXX",
    flavor: "ORB short-only",
    defaultSide: "short",
    startingEquity: 100000,
  },
  {
    id: "e",
    label: "Bot E",
    dir: "swing",
    account: "PA3RN0YU53QN",
    flavor: "Swing 2%/5%, holds days",
    defaultSide: null,
    startingEquity: 100000,
    // Bot E's files are named differently, and it has no EOD flatten — an open
    // position overnight is the strategy, not a stranded-position alarm.
    files: {
      tickLog: "swingbot.log",
      scanLog: "swing-scan.log",
      trades: "swing-trades.csv",
      watchlist: "swing-watchlist.csv",
    },
    holdsOvernight: true,
  },
];

// Default file names (the ORB bots'). Bot E overrides them via `files`.
const filesFor = (bot) => ({
  tickLog: "stockbot.log",
  scanLog: "scan.log",
  trades: "stock-trades.csv",
  watchlist: "watchlist.csv",
  ...(bot.files || {}),
});

// ── helpers ──────────────────────────────────────────────────────────────────
const num = (x) => (x == null || x === "" ? null : Number(x));

function parseEnv(dir) {
  const p = join(ROOT, dir, ".env");
  const env = {};
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq === -1) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    // strip an inline "# comment" and surrounding quotes
    const hash = v.indexOf(" #");
    if (hash !== -1) v = v.slice(0, hash).trim();
    v = v.replace(/^['"]|['"]$/g, "");
    env[k] = v;
  }
  return env;
}

// Minimal CSV parser that respects "quoted, fields".
function parseCsv(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "") continue;
    const cells = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inQ) {
        if (ch === '"' && raw[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

function readCsvObjects(path) {
  if (!existsSync(path)) return [];
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function fileAge(path) {
  try {
    const ms = Date.now() - statSync(path).mtimeMs;
    return { mtime: statSync(path).mtimeMs, ageMin: ms / 60000 };
  } catch {
    return null;
  }
}

// today's date in US/Eastern as YYYY-MM-DD (the bots log in ET)
function etDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    if (!res.ok)
      throw new Error(`${res.status}: ${String(text).slice(0, 160)}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

// ── per-bot Alpaca (live, read-only) ─────────────────────────────────────────
// A stub that keeps the shape the frontend expects, so a bot whose keys are
// missing renders as "n/a" instead of throwing on undefined arrays.
const NO_ALPACA = (why) => ({
  ok: false, error: why, equity: null, lastEquity: null, cash: null,
  buyingPower: null, status: null, dayPL: null, dayPLpct: null,
  history: null, monthPL: null, positions: [], orders: [],
});

async function alpacaForBot(env) {
  const id = env.APCA_API_KEY_ID;
  const secret = env.APCA_API_SECRET_KEY;
  if (!id || !secret) return NO_ALPACA("no API keys in .env");
  const base = env.APCA_BASE_URL || ALPACA_BASE;
  const H = {
    "APCA-API-KEY-ID": id,
    "APCA-API-SECRET-KEY": secret,
    "Content-Type": "application/json",
  };
  try {
    const startET = `${etDate()}T00:00:00-04:00`;
    const [account, positions, orders, hist] = await Promise.all([
      fetchJson(`${base}/v2/account`, { headers: H }),
      fetchJson(`${base}/v2/positions`, { headers: H }),
      fetchJson(
        `${base}/v2/orders?status=all&after=${encodeURIComponent(
          startET,
        )}&limit=50&direction=desc`,
        { headers: H },
      ).catch(() => []),
      fetchJson(
        `${base}/v2/account/portfolio/history?period=1M&timeframe=1D`,
        { headers: H },
      ).catch(() => null),
    ]);

    // Equity curve — drop leading zero buckets (days before the account funded).
    let history = null;
    if (hist && Array.isArray(hist.equity)) {
      const pts = [];
      for (let i = 0; i < hist.equity.length; i++) {
        const v = num(hist.equity[i]);
        if (v && v > 0) pts.push({ t: hist.timestamp[i] * 1000, equity: v });
      }
      if (pts.length) history = pts;
    }
    const equity = num(account.equity);
    const lastEquity = num(account.last_equity);
    return {
      ok: true,
      live: !(env.PAPER_TRADING === "true") ? false : true, // informational
      equity,
      lastEquity,
      cash: num(account.cash),
      buyingPower: num(account.buying_power),
      status: account.status,
      dayPL: equity != null && lastEquity != null ? equity - lastEquity : null,
      dayPLpct:
        equity != null && lastEquity
          ? ((equity - lastEquity) / lastEquity) * 100
          : null,
      history,
      monthPL:
        history && history.length
          ? history[history.length - 1].equity - history[0].equity
          : null,
      positions: (positions || []).map((p) => ({
        symbol: p.symbol,
        side: p.side,
        qty: num(p.qty),
        avgEntry: num(p.avg_entry_price),
        current: num(p.current_price),
        marketValue: num(p.market_value),
        unrealizedPL: num(p.unrealized_pl),
        unrealizedPLpct: num(p.unrealized_plpc) * 100,
      })),
      orders: (Array.isArray(orders) ? orders : []).map((o) => ({
        symbol: o.symbol,
        side: o.side,
        qty: num(o.qty),
        type: o.type,
        status: o.status,
        filledAvg: num(o.filled_avg_price),
        submittedAt: o.submitted_at,
        filledAt: o.filled_at,
      })),
    };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Pair ENTRY→EXIT rows in stock-trades.csv into closed round-trips and tally
// realized P&L + win rate.
//
// This matches WITHIN A SYMBOL-DAY, by quantity. The previous version walked a
// per-symbol FIFO queue across the whole file and shifted one whole entry per
// EXIT row, booking P&L on the *entry* quantity — so a 7-share partial exit
// against a 118-share entry was priced as if all 118 shares left at the partial
// price, and every later exit then paired against the wrong entry. The error
// compounded down the file and was made worse by SOXS's ~10:1 reverse split in
// July (a $5.61 entry matched against a $51 exit). On the Jun–Jul data that
// produced -$3,403 for account B, whose broker-verified result was -$52.84.
//
// Matching per symbol-day instead is both correct for an intraday bot (it takes
// at most one entry per symbol per day) and immune to split-adjusted price
// jumps. Entries that never fully closed are reported as `unclosed` rather than
// silently absorbed — an unclosed entry is a flatten failure worth surfacing.
function realizedForBot(rows, defaultSide) {
  const byDay = new Map(); // "date|symbol" -> aggregated entry/exit legs
  for (const r of rows) {
    const sym = r.Symbol;
    if (!sym || !r.Date) continue;
    const key = `${r.Date}|${sym}`;
    let g = byDay.get(key);
    if (!g) {
      g = { date: r.Date, symbol: sym, side: defaultSide || "long",
            entryQty: 0, entryNotional: 0, exitQty: 0, exitNotional: 0, reason: "" };
      byDay.set(key, g);
    }
    const qty = Math.abs(num(r.Qty) || 0);
    const price = num(r.Price);
    if (price == null || !qty) continue;
    if ((r.Action || "").toUpperCase() === "ENTRY") {
      g.entryQty += qty;
      g.entryNotional += price * qty;
      if (r.Side) g.side = r.Side.toLowerCase();
    } else {
      g.exitQty += qty;
      g.exitNotional += price * qty;
      g.reason = r.Reason || g.reason;
    }
  }

  const closed = [];
  let unclosed = 0;
  for (const g of byDay.values()) {
    if (!g.entryQty || !g.exitQty) {
      if (g.entryQty) unclosed++; // entered, never logged an exit
      continue;
    }
    const entry = g.entryNotional / g.entryQty;
    const exit = g.exitNotional / g.exitQty;
    const qty = Math.min(g.entryQty, g.exitQty); // never book more than was opened
    const dir = g.side === "short" ? -1 : 1;
    if (g.exitQty < g.entryQty) unclosed++; // partial — flag it, still book the closed part
    closed.push({
      symbol: g.symbol, side: g.side, qty, entry, exit,
      reason: g.reason, date: g.date, pnl: (exit - entry) * dir * qty,
    });
  }
  closed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl < 0).length;
  const pnl = closed.reduce((s, t) => s + t.pnl, 0);
  return {
    count: closed.length,
    wins,
    losses,
    pnl,
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    open: unclosed,
    recent: closed.slice(-6).reverse(),
  };
}

// Bot E holds for days, so its exits land on a DIFFERENT date than its entries
// and realizedForBot()'s symbol-day matching would report every single trade as
// unclosed. Pair by EPISODE instead: an entry opens a position for that symbol,
// later exits draw it down, and the round-trip is booked when the quantity
// returns to zero.
//
// This is only safe because Bot E takes at most one open position per symbol at
// a time (swingbot.js refuses a second), so there is no ambiguity about which
// entry an exit belongs to — the failure mode that made cross-day FIFO pairing
// so wrong for the ORB bots. The remaining hazard is a corporate action inside
// the hold, so an exit priced more than 50% away from its entry is refused
// rather than booked: that is exactly the SOXS reverse-split shape that once
// turned a -$53 account into a reported -$3,403.
function realizedForSwing(rows) {
  const openBySym = new Map();
  const closed = [];
  let unclosed = 0;
  let suspicious = 0;

  for (const r of rows) {
    const sym = r.Symbol;
    const qty = Math.abs(num(r.Qty) || 0);
    const price = num(r.Price);
    if (!sym || !r.Date || price == null || !qty) continue;

    if ((r.Action || "").toUpperCase() === "ENTRY") {
      const g = openBySym.get(sym) || {
        symbol: sym, side: (r.Side || "long").toLowerCase(), date: r.Date,
        qty: 0, notional: 0, exitQty: 0, exitNotional: 0, reason: "",
      };
      g.qty += qty;
      g.notional += price * qty;
      if (r.Side) g.side = r.Side.toLowerCase();
      openBySym.set(sym, g);
      continue;
    }

    const g = openBySym.get(sym);
    if (!g) continue; // an exit with no matching open episode — not ours to book
    const entry = g.notional / g.qty;
    if (price > entry * 1.5 || price < entry * 0.5) {
      suspicious++;
      openBySym.delete(sym);
      continue;
    }
    const take = Math.min(qty, g.qty - g.exitQty);
    g.exitQty += take;
    g.exitNotional += price * take;
    g.reason = r.Reason || g.reason;
    if (g.exitQty >= g.qty - 1e-9) {
      const exit = g.exitNotional / g.exitQty;
      const dir = g.side === "short" ? -1 : 1;
      closed.push({
        symbol: sym, side: g.side, qty: g.qty, entry, exit,
        reason: g.reason, date: r.Date, pnl: (exit - entry) * dir * g.qty,
      });
      openBySym.delete(sym);
    }
  }
  unclosed = openBySym.size + suspicious;

  closed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl < 0).length;
  return {
    count: closed.length,
    wins,
    losses,
    pnl: closed.reduce((s, t) => s + t.pnl, 0),
    winRate: closed.length ? (wins / closed.length) * 100 : null,
    open: unclosed,
    recent: closed.slice(-6).reverse(),
  };
}

// Guard against the legacy 9-column header (no Side) sitting on top of newer
// 10-column rows: every field shifts left and Qty ends up holding ENTRY/EXIT.
// Detect that shape (Action holds a side) and un-shift the row.
function fixShiftedTradeRow(r) {
  const a = (r.Action || "").toLowerCase();
  if (a !== "long" && a !== "short") return r;
  return {
    ...r,
    Side: r.Action,
    Action: r.Qty,
    Qty: r.Price,
    Price: r.Notional,
    Notional: r.Reason,
    Reason: r.OrderID,
    OrderID: "", // 10th cell has no header under the legacy layout — dropped
  };
}

// ── per-bot local files ──────────────────────────────────────────────────────
function localForBot(bot) {
  const d = join(ROOT, bot.dir);
  const today = etDate();
  const f = filesFor(bot);

  // health: freshness of the stock-bot tick and the pre-market scan
  const stockLog = fileAge(join(d, f.tickLog));
  const scanLog = fileAge(join(d, f.scanLog));

  // today's stock trades + all-time realized P&L / win rate
  const stockTrades = readCsvObjects(join(d, f.trades)).map(
    fixShiftedTradeRow,
  );
  const stockToday = stockTrades.filter((r) => r.Date === today);
  const realized = bot.holdsOvernight
    ? realizedForSwing(stockTrades)
    : realizedForBot(stockTrades, bot.defaultSide);

  // watchlist — keep only the most recent date present
  const wl = readCsvObjects(join(d, f.watchlist)).filter(
    (r) => r.Symbol && r.Symbol.trim(),
  );
  let watchlist = [];
  if (wl.length) {
    const dates = wl.map((r) => r.Date).filter(Boolean);
    const latest = dates.sort().slice(-1)[0];
    watchlist = wl.filter((r) => r.Date === latest);
  }

  return {
    health: {
      stockTickAgeMin: stockLog?.ageMin ?? null,
      scanAgeMin: scanLog?.ageMin ?? null,
    },
    stockToday,
    realized,
    stockTradesRecent: stockTrades.slice(-8).reverse(),
    watchlist,
  };
}

// ── aggregate everything ─────────────────────────────────────────────────────
let stateCache = { ts: 0, data: null };
async function buildState() {
  if (Date.now() - stateCache.ts < 7000 && stateCache.data)
    return stateCache.data;

  let clock = null;
  // any bot's keys will do for the shared market clock
  const env0 = parseEnv(BOTS[0].dir);
  if (env0.APCA_API_KEY_ID) {
    clock = await fetchJson(`${ALPACA_BASE}/v2/clock`, {
      headers: {
        "APCA-API-KEY-ID": env0.APCA_API_KEY_ID,
        "APCA-API-SECRET-KEY": env0.APCA_API_SECRET_KEY,
      },
    }).catch(() => null);
  }

  const bots = await Promise.all(
    BOTS.map(async (bot) => {
      const env = parseEnv(bot.dir);
      const alpaca = await alpacaForBot(env);
      // The one number that cannot drift: broker equity minus what the account
      // started with. `realized` below is reconstructed from our own CSV and is
      // only as good as the trade log (a missed flatten leaves an entry unpaired
      // and the trade-level figure diverges). Prefer this for "how are we doing";
      // use `realized` for per-trade texture.
      const netSinceStart =
        bot.startingEquity && alpaca.ok && alpaca.equity != null
          ? alpaca.equity - bot.startingEquity
          : null;
      return {
        ...bot,
        paper: env.PAPER_TRADING === "true",
        alpaca,
        netSinceStart,
        ...localForBot(bot),
      };
    }),
  );

  // combined roll-up across the accounts
  const eq = bots.filter((b) => b.alpaca.ok && b.alpaca.equity != null);
  const combined = {
    equity: eq.reduce((s, b) => s + b.alpaca.equity, 0),
    dayPL: eq.reduce((s, b) => s + (b.alpaca.dayPL || 0), 0),
    openPositions: bots.reduce(
      (s, b) => s + (b.alpaca.ok ? b.alpaca.positions.length : 0),
      0,
    ),
    accountsReporting: eq.length,
    accountsTotal: bots.length,
  };
  combined.dayPLpct =
    combined.equity - combined.dayPL > 0
      ? (combined.dayPL / (combined.equity - combined.dayPL)) * 100
      : null;

  // combined equity curve: sum the per-account daily equity by timestamp
  const byTs = new Map();
  for (const b of bots) {
    if (!b.alpaca.ok || !b.alpaca.history) continue;
    for (const p of b.alpaca.history)
      byTs.set(p.t, (byTs.get(p.t) || 0) + p.equity);
  }
  combined.history = [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, equity]) => ({ t, equity }));

  const data = {
    generatedAt: new Date().toISOString(),
    clock: clock
      ? {
          isOpen: clock.is_open,
          nextOpen: clock.next_open,
          nextClose: clock.next_close,
        }
      : null,
    combined,
    bots,
  };
  stateCache = { ts: Date.now(), data };
  return data;
}

// ── http server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url === "/index.html") {
      const html = readFileSync(join(__dirname, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (req.url.startsWith("/api/state")) {
      const data = await buildState();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify(data));
    }
    res.writeHead(404).end("not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(
      `\n  Dashboard already running on port ${PORT} — open http://localhost:${PORT}\n`,
    );
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log(`\n  Tradex → http://localhost:${PORT}\n`);
  console.log(`  Read-only. Polls ${BOTS.length} Alpaca paper accounts + local files.`);
  console.log("  Ctrl+C to stop.\n");
});
