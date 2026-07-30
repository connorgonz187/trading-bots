/**
 * Bot E — multi-day swing runner (PAPER). Run every 30 min during RTH.
 *
 * THE HYPOTHESIS THIS BOT EXISTS TO TEST
 *   The ORB bots close everything at 15:50. The claim is that they are cutting
 *   trades before the move finishes, and that holding a day or more would turn
 *   some of those scratches into 4–7% winners. Bot E holds for up to
 *   SWING_MAX_HOLD_DAYS, risking 1–2% to make 4–7%.
 *
 *   That claim is NOT yet evidence. `mfe-study.js` measures it directly against
 *   the ORB bots' own historical entries, and `swing-bt.js` backtests these
 *   exact rules. Run both before believing this bot deserves capital — building
 *   on an unmeasured premise is how Bot D happened (README, "Current state").
 *
 * HOW IT DIFFERS FROM stockbot.js, mechanically
 *   - Exits rest GTC as an OCO pair, not a DAY bracket. A DAY bracket expires at
 *     the close and would leave an overnight position naked through exactly the
 *     gap it needs protection from.
 *   - There is NO end-of-day flatten and NO stranded-position sweep. An open
 *     position at 16:00 is the strategy working, not a failure. This is why Bot
 *     E MUST have its own Alpaca account: sharing one with B or C would let
 *     their stranded sweep close Bot E's positions at the next open.
 *   - Entries are decided once a day, late in the session, off DAILY bars. The
 *     ~15-minute delay on the free IEX feed is a much smaller handicap here than
 *     it is for a 5-minute breakout (POSTMORTEM-BOT-A.md §6).
 *   - A position is never held without a resting stop. If the OCO fails to
 *     place after an entry fills, the entry is closed immediately.
 *
 * FLAGS
 *   --dry-run     evaluate and print signals, place nothing
 *   --check-auth  prove the keys work and the account is the one you think
 */
import "dotenv/config";
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "fs";
import {
  getClock, getAccount, getPositions, getAsset, closePosition,
  getOrders, getOrder, cancelOrder, placeMarket, placeOco, replaceOrder,
  getOrderByClientId, coid, isDuplicateOrder, ORDER_DEAD,
  dailyBarsMulti,
} from "./alpaca.js";
import {
  CFG, WARMUP, entrySignal, exitLevels, ratchetStop, bestSince, regimeOf, regimeDevPct,
  indicators, atr, roundCents,
} from "./swing-strategy.js";
import { sendSms } from "./notify.js";

const DRY = process.argv.includes("--dry-run");
const RISK_USD = parseFloat(process.env.SWING_RISK_USD || "100");
const MAX_NOTIONAL = parseFloat(process.env.SWING_MAX_NOTIONAL || "10000");
const MAX_POSITIONS = parseInt(process.env.SWING_MAX_POSITIONS || "5", 10);
const MAX_PER_SECTOR = parseInt(process.env.SWING_MAX_PER_SECTOR || "2", 10);
const MAX_OPEN_RISK = parseFloat(process.env.SWING_MAX_OPEN_RISK_USD || "500");
const REGIME_SYM = process.env.SWING_REGIME_SYMBOL || "SPY";
const ENTRY_START = parseInt(process.env.SWING_ENTRY_START || "940", 10); // 15:40 ET
const ENTRY_END = parseInt(process.env.SWING_ENTRY_END || "955", 10); // 15:55 ET
const WATCHLIST = process.env.SWING_WATCHLIST || "swing-watchlist.csv";
const WATCHLIST_MAX_AGE = parseInt(process.env.SWING_WATCHLIST_MAX_AGE_DAYS || "5", 10);
const TRADELOG = process.env.SWING_TRADELOG || "swing-trades.csv";
const STATE = process.env.SWING_STATE || "swing-state.json";
const TAG = process.env.BOT_TAG || "E";

// Correlated clusters, so MAX_PER_SECTOR stops five semis names counting as five
// independent bets. Same idea as stockbot.js, widened for a large-cap universe.
const SECTOR = {
  NVDA: "semis", AMD: "semis", AVGO: "semis", QCOM: "semis", TXN: "semis",
  INTC: "semis", MU: "semis", AMAT: "semis", LRCX: "semis", SMH: "semis",
  AAPL: "megatech", MSFT: "megatech", GOOGL: "megatech", AMZN: "megatech",
  META: "megatech", NFLX: "megatech", ORCL: "megatech", CRM: "software",
  ADBE: "software", NOW: "software", PANW: "software", CSCO: "software",
  JPM: "banks", BAC: "banks", WFC: "banks", GS: "banks", MS: "banks",
  C: "banks", SCHW: "banks", BLK: "banks", XLF: "banks",
  V: "payments", MA: "payments", AXP: "payments",
  UNH: "health", JNJ: "health", LLY: "health", ABBV: "health", MRK: "health",
  PFE: "health", TMO: "health", ABT: "health", XLV: "health",
  CAT: "industrial", DE: "industrial", HON: "industrial", GE: "industrial",
  BA: "industrial", UNP: "industrial", LMT: "defense", RTX: "defense", XLI: "industrial",
  WMT: "retail", COST: "retail", HD: "retail", LOW: "retail", MCD: "retail",
  NKE: "retail", SBUX: "retail", DIS: "retail",
  PG: "staples", KO: "staples", PEP: "staples",
  XOM: "energy", CVX: "energy", COP: "energy", SLB: "energy", XLE: "energy",
  SPY: "index", QQQ: "index", IWM: "index", DIA: "index", XLK: "megatech",
};
const sectorOf = (s) => SECTOR[s] || s;

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function et(ts) {
  const p = {};
  for (const x of etFmt.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// State survives across sessions by design — unlike the ORB bots, whose state is
// wiped daily. `open` is the book; it is only cleared when a position is
// confirmed closed at the broker.
function loadState() {
  const empty = { open: {}, enteredOn: {}, realizedPnl: 0, closed: 0, wins: 0 };
  if (!existsSync(STATE)) return empty;
  try {
    return { ...empty, ...JSON.parse(readFileSync(STATE, "utf8")) };
  } catch {
    return empty;
  }
}
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

function logTrade(cols) {
  if (!existsSync(TRADELOG))
    writeFileSync(TRADELOG, "Date,Time(ET),Symbol,Side,Action,Qty,Price,Notional,Reason,OrderID\n");
  appendFileSync(TRADELOG, cols.join(",") + "\n");
}

// The universe moves slowly, so an older watchlist is still usable — better than
// skipping a day because the 9:00 scanner missed a run. Anything staler than
// WATCHLIST_MAX_AGE trading-ish days is refused rather than silently trusted.
function readWatchlist(today) {
  if (!existsSync(WATCHLIST)) return { syms: [], date: null };
  const rows = readFileSync(WATCHLIST, "utf8").trim().split("\n").slice(1)
    .map((l) => l.split(",")).filter((c) => c.length > 1);
  if (!rows.length) return { syms: [], date: null };
  const dates = [...new Set(rows.map((c) => c[0]))].sort();
  const latest = dates[dates.length - 1];
  const ageDays = Math.round((Date.parse(today) - Date.parse(latest)) / 86400e3);
  if (!Number.isFinite(ageDays) || ageDays > WATCHLIST_MAX_AGE) return { syms: [], date: latest, stale: true };
  return { syms: [...new Set(rows.filter((c) => c[0] === latest).map((c) => c[1]))], date: latest, ageDays };
}

// A market order that is still `partially_filled` is NOT done, and returning it
// as if it were is how six shares of an 18-share MCD short ended up with no stop
// on 2026-07-29: the caller read filled_qty=12 mid-fill and armed the OCO for 12.
// So keep polling through partial fills, and give it long enough (25 × 600ms =
// 15s) that a thin book has time to complete. A partial can still come back on
// timeout — callers must size protection off the position, not this order.
async function waitFill(id, tries = 25, ms = 600) {
  let o;
  for (let i = 0; i < tries; i++) {
    o = await getOrder(id);
    if (o.status === "filled") return o;
    if (["canceled", "rejected", "expired"].includes(o.status)) throw new Error(`entry ${o.status}`);
    await new Promise((r) => setTimeout(r, ms));
  }
  if (o && o.status === "partially_filled")
    console.log(`     !! order ${id.slice(0, 8)} still partial (${o.filled_qty}/${o.qty}) after ${((tries * ms) / 1000).toFixed(0)}s`);
  return o;
}

/**
 * Shares the broker ACTUALLY holds for a symbol, 0 if none.
 *
 * The bracket has to cover the position, so the position is what it gets sized
 * from — an order's filled_qty is a snapshot that can be stale by the time we
 * read it. Entries only run when the symbol is absent from both state.open and
 * the position map, so whatever is held here came from this entry alone.
 */
async function heldQty(sym) {
  try {
    const p = (await getPositions()).find((x) => x.symbol === sym);
    return p ? Math.floor(Math.abs(Number(p.qty))) : 0;
  } catch {
    return 0;
  }
}

// Open orders for a symbol, with OCO/bracket legs FLATTENED into the list.
// With nested=true Alpaca returns the group as a parent plus a `legs` array, so
// a naive scan for a "stop" order finds nothing and the ratchet silently
// re-arms a second OCO on top of the first.
async function openOrdersFor(sym) {
  const rows = await getOrders(`?status=open&symbols=${sym}&limit=50&nested=true`).catch(() => []);
  const out = [];
  for (const o of Array.isArray(rows) ? rows : []) {
    out.push(o);
    for (const l of o.legs || []) out.push(l);
  }
  return out.filter((o) => o.symbol === sym && !["canceled", "filled", "expired"].includes(o.status));
}

// Flatten the resting legs so a market close won't 403 on held_for_orders.
async function clearOrders(sym) {
  const open = await openOrdersFor(sym);
  for (const o of open) await cancelOrder(o.id).catch(() => {});
  for (let i = 0; i < 8; i++) {
    const still = await openOrdersFor(sym);
    if (!still.length) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function closeConfirmed(sym, tries = 5, ms = 700) {
  for (let i = 0; i < tries; i++) {
    try {
      const o = await closePosition(sym);
      const f = o && o.id ? await waitFill(o.id).catch(() => null) : null;
      if (f && f.status === "filled") return f;
    } catch (e) {
      if (!/40310000|held_for_orders|\b403\b/.test(e.message)) throw e;
      await clearOrders(sym);
    }
    await new Promise((r) => setTimeout(r, ms));
  }
  return null;
}

function bookExit(state, sym, e, qty, exitPx, reason, now) {
  const pnl = e.side === "short" ? (e.entry - exitPx) * qty : (exitPx - e.entry) * qty;
  const pct = ((e.side === "short" ? e.entry - exitPx : exitPx - e.entry) / e.entry) * 100;
  state.realizedPnl += pnl;
  state.closed += 1;
  if (pnl > 0) state.wins += 1;
  logTrade([now.date, hhmm(now.min), sym, e.side, "EXIT", qty, exitPx.toFixed(2), (qty * exitPx).toFixed(2), reason, ""]);
  console.log(`  EXIT ${sym} (${e.side}/${reason}) ${qty}sh @ ${exitPx.toFixed(2)}  ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%  P/L $${pnl.toFixed(2)}`);
  return { pnl, pct };
}

// Never infer the exit reason from the fill price — a stop that slipped past the
// target level would be logged as a "target" and a loss would be booked as a
// win. Read the order TYPE. (stockbot.js learned this the hard way.)
function reasonFromOrder(o) {
  const t = (o?.type || o?.order_type || "").toLowerCase();
  if (t === "limit") return "target";
  if (t.includes("stop")) return "stop";
  if (t === "market") return "manual/time-stop";
  return "exit";
}

async function main() {
  if (process.argv.includes("--check-auth")) return checkAuth();

  const now = et(Date.now());
  const clock = await getClock();
  const state = loadState();
  const positions = await getPositions();
  const posMap = Object.fromEntries(positions.map((p) => [p.symbol, p]));

  console.log(
    `[${now.date} ${hhmm(now.min)} ET] Bot ${TAG} swing | market ${clock.is_open ? "OPEN" : "closed"} | ` +
      `stop ${(CFG.stopPct * 100).toFixed(1)}% target ${(CFG.targetPct * 100).toFixed(1)}% ` +
      `hold≤${CFG.maxHoldDays}d | open ${positions.length}${DRY ? " | DRY-RUN" : ""}`,
  );

  // ── 1. Reconcile: anything we thought we held that the broker no longer shows
  // was closed by a resting leg while we were not looking. That is the normal
  // path for this bot — the OCO does the work overnight and intrabar.
  const afterISO = new Date(Date.now() - 30 * 86400e3).toISOString();
  const trackedGone = Object.keys(state.open).filter((s) => {
    const held = posMap[s] ? Math.abs(Number(posMap[s].qty)) : 0;
    return held < state.open[s].qty - 1e-9;
  });
  if (trackedGone.length) {
    const closed = await getOrders(`?status=closed&after=${afterISO}&limit=200&direction=desc`).catch(() => []);
    for (const sym of trackedGone) {
      const e = state.open[sym];
      const exitSide = e.side === "short" ? "buy" : "sell";
      const held = posMap[sym] ? Math.abs(Number(posMap[sym].qty)) : 0;
      const outstanding = e.qty - held;
      const fills = closed.filter(
        (o) => o.symbol === sym && o.side === exitSide && o.status === "filled" &&
               Math.abs(+o.filled_qty) > 0 && Date.parse(o.filled_at || 0) >= Date.parse(e.entryTime || 0),
      );
      const totalOut = fills.reduce((s, o) => s + Math.abs(+o.filled_qty), 0);
      const vw = totalOut > 0
        ? fills.reduce((s, o) => s + +o.filled_avg_price * Math.abs(+o.filled_qty), 0) / totalOut
        : null;
      // Number(undefined) is NaN, not null — ?? would happily pass it through
      // and every downstream P/L would print as NaN.
      const mark = Number(posMap[sym]?.current_price);
      const exitPx = vw ?? (Number.isFinite(mark) ? mark : e.entry);
      const reason = reasonFromOrder(fills[0]) + (held > 1e-9 ? "-partial" : "");
      const { pnl, pct } = bookExit(state, sym, e, outstanding, exitPx, reason, now);
      if (held > 1e-9) e.qty = held;
      else delete state.open[sym];
      await sendSms(`PAPER ${TAG} EXIT ${sym} ${reason} @ $${exitPx.toFixed(2)} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% P/L $${pnl.toFixed(2)}`);
    }
  }

  // Adopt anything the broker holds that state lost track of, rather than
  // leaving it unmanaged. An untracked position is how a −$356 SMCI happens.
  for (const p of positions) {
    if (state.open[p.symbol]) continue;
    const side = Number(p.qty) < 0 ? "short" : "long";
    const entry = Number(p.avg_entry_price);
    const lv = exitLevels(side, entry);
    state.open[p.symbol] = {
      side, qty: Math.abs(Number(p.qty)), entry, entryDate: now.date,
      entryTime: new Date(Date.now() - 86400e3).toISOString(),
      stop: lv.stop, target: lv.target, adopted: true,
    };
    console.log(`  ADOPTED untracked ${side} ${p.symbol} ${p.qty}sh @ ${entry.toFixed(2)} — will manage from here.`);
  }

  // --dry-run deliberately ignores the market-hours and entry-window guards.
  // This bot makes one decision a day inside a 15-minute window; if you could
  // only inspect its reasoning during that window it would be untestable in
  // practice. Nothing is placed either way, so the only cost is that quotes are
  // stale outside RTH — which the banner says.
  if (!clock.is_open) {
    if (!DRY) {
      console.log("  market closed — reconcile only.");
      saveState(state);
      return summarize(state, positions);
    }
    console.log("  market closed — continuing anyway because --dry-run; prices are last-session's.");
  }

  const openSyms = Object.keys(state.open);
  const wl = readWatchlist(now.date);
  if (wl.stale) console.log(`  !! watchlist is stale (latest ${wl.date}) — no new entries until swing-scan.js runs.`);
  else if (wl.ageDays > 0) console.log(`  watchlist from ${wl.date} (${wl.ageDays}d old, within tolerance).`);

  // One batched bar request covers held names, watchlist and the regime symbol.
  const need = [...new Set([...openSyms, ...wl.syms, REGIME_SYM])];
  const startISO = new Date(Date.now() - (WARMUP + 60) * 86400e3).toISOString();
  const bars = need.length ? await dailyBarsMulti(need, startISO) : {};
  const regime = regimeOf(bars[REGIME_SYM]);
  const regimeDev = regimeDevPct(bars[REGIME_SYM]);
  console.log(
    `  regime ${REGIME_SYM} vs SMA${CFG.regimeLen}` +
      `${regimeDev == null ? "" : ` (${regimeDev >= 0 ? "+" : ""}${regimeDev.toFixed(2)}%, band ±${(CFG.regimeBandPct * 100).toFixed(2)}%)`}` +
      ` -> ${regime || "unknown"}` +
      `${regime === "neutral" ? " (no side vetoed)" : ""}`,
  );

  // ── 2. Manage what is already on: ratchet stops, then time-stop.
  for (const sym of openSyms) {
    const e = state.open[sym];
    if (!posMap[sym]) continue;
    const b = bars[sym] || [];
    // Alpaca stamps a daily bar at 04:00/05:00Z of its own session date, so a
    // floor at midnight UTC of the entry date includes the entry bar and
    // nothing earlier. `since[0]` IS the entry day, hence length-1 = trading
    // days held.
    const since = b.filter((x) => x.time >= Date.parse(`${e.entryDate}T00:00:00Z`));
    if (!since.length) continue;
    const held = since.length - 1;
    const best = bestSince(e.side, since);
    const px = Number(posMap[sym].current_price) || since[since.length - 1].close;
    const pct = ((e.side === "short" ? e.entry - px : px - e.entry) / e.entry) * 100;

    // Time stop first: a dead trade should not get a ratcheted stop and another
    // day of slot occupancy.
    if (held >= CFG.maxHoldDays) {
      console.log(`  ${sym}: ${held}d held ≥ ${CFG.maxHoldDays} — time stop.`);
      if (DRY) continue;
      await clearOrders(sym);
      const f = await closeConfirmed(sym);
      if (f && f.status === "filled") {
        const q = Math.floor(Math.abs(+f.filled_qty)) || e.qty;
        const { pnl, pct: p2 } = bookExit(state, sym, e, q, +f.filled_avg_price, "time-stop", now);
        delete state.open[sym];
        await sendSms(`PAPER ${TAG} EXIT ${sym} time-stop ${p2 >= 0 ? "+" : ""}${p2.toFixed(2)}% P/L $${pnl.toFixed(2)}`);
      } else {
        const msg = `PAPER ${TAG} TIME-STOP FAILED on ${sym} — position still open and now unprotected. Run "node flatten.js".`;
        console.log(`  !! ${msg}`);
        await sendSms(msg);
      }
      continue;
    }

    const want = roundCents(ratchetStop(e.side, e.entry, e.stop, best, atr(b, CFG.atrLen)));
    const improved = e.side === "short" ? want < e.stop - 0.005 : want > e.stop + 0.005;
    console.log(
      `  HOLD ${e.side} ${sym} ${e.qty}sh @ ${e.entry.toFixed(2)} now ${px.toFixed(2)} ` +
        `(${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%) ${held}d | stop ${e.stop.toFixed(2)} tgt ${e.target.toFixed(2)}` +
        (improved ? ` -> raising stop to ${want.toFixed(2)}` : ""),
    );
    if (improved && !DRY) {
      const legs = await openOrdersFor(sym);
      const stopLeg = legs.find((o) => (o.type || "").toLowerCase().includes("stop"));
      if (!stopLeg) {
        console.log(`  !! ${sym}: no resting stop leg found — re-arming the OCO.`);
        await clearOrders(sym);
        if (!(await armOco(sym, e, want))) {
          const m = `PAPER ${TAG} ${sym} has NO resting stop and re-arming failed — position is unprotected.`;
          console.log(`  !! ${m}`);
          await sendSms(m);
        }
      } else {
        // PATCH in place rather than cancel-then-place: a cancel/replace leaves
        // a window with no stop on the book, which on a gappy overnight name is
        // precisely the risk this bot is exposed to.
        try {
          await replaceOrder(stopLeg.id, { stop_price: want.toFixed(2) });
          const atBreakeven = e.side === "long" ? want >= e.entry : want <= e.entry;
          e.stop = want;
          console.log(`     stop moved to ${want.toFixed(2)}${atBreakeven ? " (at/above breakeven — this trade can no longer lose)" : ""}`);
        } catch (err) {
          console.log(`     stop replace failed (${err.message}) — the existing stop stays where it is.`);
        }
      }
    }
  }

  // ── 3. New entries — once a day, late in the session.
  const outsideWindow = now.min < ENTRY_START || now.min > ENTRY_END;
  if (outsideWindow) {
    if (!DRY) {
      console.log(`  outside entry window (${hhmm(ENTRY_START)}–${hhmm(ENTRY_END)} ET) — manage only.`);
      saveState(state);
      return summarize(state, positions);
    }
    console.log(`  outside entry window (${hhmm(ENTRY_START)}–${hhmm(ENTRY_END)} ET) — evaluating anyway for --dry-run.`);
  }
  if (state.enteredOn[now.date] && !DRY) {
    console.log("  already ran entries today.");
    saveState(state);
    return summarize(state, positions);
  }
  if (wl.stale || !wl.syms.length) {
    if (!DRY) saveState(state);
    return summarize(state, positions);
  }

  const acct = await getAccount();
  if (acct.trading_blocked || acct.account_blocked) {
    console.log("  !! account is blocked from trading — no entries.");
    if (!DRY) saveState(state);
    return;
  }

  let live = Object.keys(state.open).length;
  const secCnt = {};
  let openRisk = 0;
  for (const [s, e] of Object.entries(state.open)) {
    secCnt[sectorOf(s)] = (secCnt[sectorOf(s)] || 0) + 1;
    openRisk += Math.abs(e.entry - e.stop) * e.qty;
  }

  const candidates = [];
  for (const sym of wl.syms) {
    if (state.open[sym] || posMap[sym]) continue;
    const b = bars[sym];
    if (!b || b.length < WARMUP) continue;
    const sig = entrySignal(b, regime);
    if (sig) candidates.push({ sym, sig, ind: indicators(b), bars: b });
  }
  console.log(`  ${candidates.length} signal(s) from ${wl.syms.length} watched.`);

  for (const c of candidates) {
    if (live >= MAX_POSITIONS) { console.log(`  max positions (${MAX_POSITIONS}) — stopping.`); break; }
    if (openRisk >= MAX_OPEN_RISK) { console.log(`  open risk $${openRisk.toFixed(0)} ≥ cap $${MAX_OPEN_RISK} — stopping.`); break; }
    const sec = sectorOf(c.sym);
    if ((secCnt[sec] || 0) >= MAX_PER_SECTOR) { console.log(`  ${c.sym}: sector "${sec}" at cap — skip.`); continue; }

    const px = c.ind.price;
    const lv = exitLevels(c.sig.side, px);
    const riskPerShare = Math.abs(px - lv.stop);
    if (riskPerShare <= 0) continue;
    let qty = Math.floor(RISK_USD / riskPerShare);
    if (qty * px > MAX_NOTIONAL) qty = Math.floor(MAX_NOTIONAL / px);
    if (qty < 1) { console.log(`  ${c.sym}: sizes to 0 shares at $${px.toFixed(2)} — skip.`); continue; }
    const dollarRisk = riskPerShare * qty;
    if (qty * px > Number(acct.buying_power || 0)) { console.log(`  ${c.sym}: notional $${(qty * px).toFixed(0)} exceeds buying power — skip.`); continue; }

    if (c.sig.side === "short") {
      try {
        const a = await getAsset(c.sym);
        if (!(a.shortable && a.tradable)) { console.log(`  ${c.sym}: not shortable — skip.`); continue; }
      } catch { console.log(`  ${c.sym}: shortability unknown — skip.`); continue; }
    }

    console.log(
      `  SIGNAL ${c.sig.side} ${c.sym} ${qty}sh @ ~${px.toFixed(2)} | stop ${lv.stop.toFixed(2)} ` +
        `(−${(CFG.stopPct * 100).toFixed(1)}%) target ${lv.target.toFixed(2)} (+${(CFG.targetPct * 100).toFixed(1)}%) | ` +
        `risk $${dollarRisk.toFixed(0)} | ATR ${(c.ind.atrPct * 100).toFixed(2)}% | ${c.sig.reason}`,
    );
    if (DRY) { live++; secCnt[sec] = (secCnt[sec] || 0) + 1; openRisk += dollarRisk; continue; }

    try {
      const entrySide = c.sig.side === "long" ? "buy" : "sell";
      const entryKey = coid("swing", now.date, c.sym, "entry");
      const res = await submitGuarded(placeMarket, { symbol: c.sym, qty, side: entrySide }, entryKey);
      if (res.duplicate) {
        console.log(
          `  !! ${c.sym}: entry already placed under "${entryKey}" — ANOTHER INSTANCE is trading this account. Order suppressed (no double position).`,
        );
        if (!state.dupAlerted) {
          state.dupAlerted = true;
          await sendSms(
            `PAPER ${TAG} !! DUPLICATE BLOCKED (${c.sym}) — a second copy of this bot is trading this account. Orders are being suppressed; disable one scheduler.`,
          );
        }
        continue;
      }
      const eo = res.order;
      const filled = await waitFill(eo.id);
      // Size from the position, not from this order. filled_qty is a snapshot and
      // a late-completing fill leaves the difference resting with no stop — see
      // heldQty(). Fall back to the order only if the position is not visible yet.
      const oq = Math.floor(Math.abs(+filled.filled_qty)) || qty;
      const held = await heldQty(c.sym);
      const fq = held || oq;
      if (held && held !== oq)
        console.log(`     ${c.sym}: order reported ${oq}sh but broker holds ${held}sh — protecting ${held}.`);
      const entry = +filled.filled_avg_price || px;
      // Levels come off the ACTUAL fill, so "2%" means 2% from where we really
      // got in, not from a stale signal price.
      const real = exitLevels(c.sig.side, entry);
      const e = {
        side: c.sig.side, qty: fq, entry, entryDate: now.date, entryTime: new Date().toISOString(),
        stop: roundCents(real.stop), target: roundCents(real.target),
        risk: Math.abs(entry - real.stop) * fq, reason: c.sig.reason,
      };
      const armed = await armOco(c.sym, e, e.stop);
      if (!armed) {
        // Unprotected overnight is the one outcome worse than not trading.
        console.log(`  !! ${c.sym}: could not arm the OCO — closing the entry immediately.`);
        await closeConfirmed(c.sym);
        await sendSms(`PAPER ${TAG} ${c.sym} entry filled but OCO failed — position closed, no trade.`);
        continue;
      }
      state.open[c.sym] = e;
      live++;
      secCnt[sec] = (secCnt[sec] || 0) + 1;
      openRisk += e.risk;
      logTrade([now.date, hhmm(now.min), c.sym, c.sig.side, "ENTRY", fq, entry.toFixed(2), (fq * entry).toFixed(2), `swing ${c.sig.side} stop${e.stop.toFixed(2)} tgt${e.target.toFixed(2)}`, eo.id]);
      console.log(`  ENTER ${c.sig.side} ${c.sym} ${fq}sh @ ${entry.toFixed(2)} | stop ${e.stop.toFixed(2)} tgt ${e.target.toFixed(2)} | risk $${e.risk.toFixed(0)}`);
      await sendSms(`PAPER ${TAG} ${c.sig.side.toUpperCase()} ${c.sym} ${fq} @ $${entry.toFixed(2)} stop $${e.stop.toFixed(2)} tgt $${e.target.toFixed(2)} (hold ≤${CFG.maxHoldDays}d)`);
    } catch (err) {
      const msg = err.message || String(err);
      if (/cannot be sold short|not easy to borrow|no shares? available|htb/i.test(msg))
        console.log(`  ${c.sym}: broker refused the short (no borrow) — skip.`);
      else console.log(`  ${c.sym}: ${msg}`);
    }
  }

  if (!outsideWindow) state.enteredOn[now.date] = true;
  // Keep the entered-days map from growing without bound.
  const days = Object.keys(state.enteredOn).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 30))) delete state.enteredOn[d];
  if (!DRY) saveState(state);
  summarize(state, await getPositions());
}

// Submit an order under an id derived from the trade's IDENTITY rather than a
// random one, so a second instance of this bot cannot open the same position
// twice (the full story is in alpaca.js). Returns `{ order }` on success, or
// `{ duplicate }` when a LIVE order already exists under that id.
//
// The lookup is the load-bearing part: a rejected order still burns its
// client_order_id at the broker, so after a legitimate refusal a plain retry
// would collide with our OWN corpse and stay blocked. Only a live order means
// "someone else has this"; a dead one means "retry under the next suffix".
async function submitGuarded(place, args, key, tries = 3) {
  for (let n = 0; n < tries; n++) {
    const clientOrderId = coid(key, n ? `r${n}` : "");
    try {
      return { order: await place({ ...args, clientOrderId }) };
    } catch (err) {
      if (!isDuplicateOrder(err)) throw err;
      const existing = await getOrderByClientId(clientOrderId).catch(() => null);
      if (!existing || !ORDER_DEAD.test(existing.status || "")) {
        return { duplicate: existing || { client_order_id: clientOrderId } };
      }
      console.log(`     id ${clientOrderId} held by our own ${existing.status} order — retrying under a fresh id.`);
    }
  }
  return { duplicate: { client_order_id: coid(key), exhausted: true } };
}

/**
 * Place the GTC OCO exit pair. Returns true only if it is actually resting.
 *
 * The id carries the STOP price because the breakeven ratchet re-arms this pair
 * with a raised stop — a fixed id would collide with the previous arming and
 * the ratchet would silently stop working. Two instances ratcheting to the same
 * stop still produce the same id, which is exactly the collision we want.
 */
async function armOco(sym, e, stop) {
  const side = e.side === "short" ? "buy" : "sell";
  const px = roundCents(stop);
  try {
    const res = await submitGuarded(
      placeOco,
      { symbol: sym, qty: e.qty, side, takeProfit: roundCents(e.target), stopLoss: px },
      coid("swing", e.entryDate, sym, "oco", px.toFixed(2)),
    );
    // A live OCO already resting under this id means the position IS protected,
    // which is all this function promises. Adopt it rather than reporting failure
    // and closing a perfectly good entry.
    if (res.duplicate) {
      console.log(`     OCO already resting under this id (stop ${px.toFixed(2)}) — adopting it.`);
      if (res.duplicate.id) e.ocoId = res.duplicate.id;
      e.stop = px;
      return Boolean(res.duplicate.id);
    }
    e.ocoId = res.order.id;
    e.stop = px;
    return true;
  } catch (err) {
    console.log(`     OCO placement failed: ${err.message}`);
    return false;
  }
}

function summarize(state, positions) {
  const wr = state.closed ? (state.wins / state.closed) * 100 : 0;
  console.log(
    `  book: ${positions.length} open | closed ${state.closed} (win ${wr.toFixed(0)}%) | realized $${state.realizedPnl.toFixed(2)}`,
  );
  console.log("  (realized here is the local log — reconcile against broker fills before quoting it.)");
}

async function checkAuth() {
  const a = await getAccount();
  const c = await getClock();
  console.log(`account   ${a.account_number}  status ${a.status}`);
  console.log(`equity    $${Number(a.equity).toFixed(2)}   buying power $${Number(a.buying_power).toFixed(2)}`);
  console.log(`blocked   trading=${a.trading_blocked} account=${a.account_blocked} shorting=${!a.shorting_enabled}`);
  console.log(`endpoint  ${process.env.APCA_BASE_URL || "https://paper-api.alpaca.markets"}`);
  console.log(`market    ${c.is_open ? "OPEN" : "closed"} (next open ${c.next_open})`);
  if (!/paper-api/.test(process.env.APCA_BASE_URL || "https://paper-api.alpaca.markets"))
    console.log("!! APCA_BASE_URL is NOT the paper endpoint. Stop and check .env.");
  const positions = await getPositions();
  if (positions.length) {
    console.log(`\nopen positions (${positions.length}):`);
    for (const p of positions)
      console.log(`  ${p.symbol.padEnd(6)} ${String(p.qty).padStart(6)}sh @ ${Number(p.avg_entry_price).toFixed(2)} -> ${Number(p.current_price).toFixed(2)}  P/L $${Number(p.unrealized_pl).toFixed(2)}`);
  }
}

main().catch((e) => {
  console.error("swingbot error:", e.message);
  process.exitCode = 1;
});
