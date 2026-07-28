/**
 * Intraday ORB paper-runner. Invoke every few minutes during market hours.
 *
 * DEFAULT (account A): long-only. On a break above the first ORB_MINUTES range
 * it places a BRACKET buy on Alpaca — stop (OR low) + target (entry + R*risk)
 * rest at the broker and fill intrabar, so no 5-min polling slippage on exits.
 *
 * FLAGS (account B / strategy #4):
 *   ORB_SHORTS=true    also short a break BELOW the OR low (mirror bracket).
 *   ORB_TRAILING=true  exit with a native broker TRAILING stop instead of a
 *                      fixed R target — let winners run. trail distance is
 *                      ATR-based (ORB_TRAIL_ATR_MULT × ATR) with a price-%
 *                      floor (ORB_TRAIL_MIN_PCT) so cheap names aren't strangled;
 *                      override with a fixed ORB_TRAIL_PRICE.
 *
 * RISK CONTROLS (all env-tunable, on by default):
 *   ORB_REGIME=true       only take longs when SPY≥VWAP, shorts when SPY≤VWAP.
 *   ORB_MAX_POSITIONS     cap concurrent open positions (default 4).
 *   ORB_MAX_PER_SECTOR    cap positions in one correlated cluster (default 2).
 *   ORB_MAX_DAILY_LOSS    halt new entries once realized P/L ≤ −this (default 150).
 *   STOCK_MAX_NOTIONAL_PCT  hard ceiling on one position's value as a % of account
 *                         equity (default 7). Binds together with the fixed
 *                         STOCK_MAX_NOTIONAL — the SMALLER of the two wins. 0 = off.
 *   STOCK_MIN_RISK_FRAC   skip a trade if the notional cap shrinks its risk below
 *                         this fraction of STOCK_RISK_USD (keeps risk comparable).
 *
 * Isolation (so the accounts can share one codebase, no drift):
 *   APCA_* keys, STOCK_STATE, STOCK_TRADELOG all come from the loaded env file.
 *   Run account B with DOTENV_CONFIG_PATH=.env.b (the launcher sets it). Bars are
 *   pulled through a SHARED cache (SHARED_BAR_CACHE) so all accounts in a given
 *   5-min cycle see the SAME data and their signals are comparable, not noise.
 *
 * Position size is RISK-BASED: shares so (entry - stop) * shares ~= RISK_USD,
 * capped at the smaller of MAX_NOTIONAL (fixed $) and MAX_NOTIONAL_PCT of live
 * account equity. One entry per symbol per day. Flatten before the close.
 *
 * Caveat: free Alpaca data is ~15 min delayed, so ENTRY signals lag; exits are
 * broker-side so they're precise. Paper account only. (Paper shorting ignores
 * real-world borrow availability — live would be harder.)
 *
 * FAILURE HANDLING (added 2026-07-28 after auditing the Jun–Jul forward test):
 *   - Stranded positions. An EOD flatten that doesn't confirm now ALERTS, and
 *     the next session's first cycle sweeps the position closed instead of
 *     waiting until 15:50. One missed flatten (SMCI, held 06-16 -> 06-22) cost
 *     -$355.67, larger than account C's entire two-month result.
 *   - Short refusals. A 4xx "cannot be sold short" is latched into state, so a
 *     doomed order is attempted once a day, not once every 5 minutes (SQQQ was
 *     re-rejected 99x on C, 69x on B). Account-level blocks latch for the day.
 *   - Network drops. alpaca.js retries transient failures; a "fetch failed" used
 *     to kill the entire cycle (213 lost cycles per account, ~8% of the session).
 */
import "dotenv/config";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
} from "fs";
import {
  getClock,
  getAccount,
  getPositions,
  getOrders,
  getOrder,
  cancelAllOrders,
  closePosition,
  placeBracketBuy,
  placeBracketSell,
  placeMarket,
  placeTrailingStop,
  recentBars,
  getAsset,
} from "./alpaca.js";
import { sessionVWAP } from "./strategy.js";
import { sendSms } from "./notify.js";

const OR_MIN = parseInt(process.env.ORB_MINUTES || "15", 10);
const R = parseFloat(process.env.ORB_R || "2");
const RISK_USD = parseFloat(process.env.STOCK_RISK_USD || "50");
const MAX_NOTIONAL = parseFloat(process.env.STOCK_MAX_NOTIONAL || "2000");
// Equity-relative ceiling on a single position's value. The fixed MAX_NOTIONAL
// above doesn't scale — on a drawn-down account $2,000 can be a third of the
// book, on a grown one it's a rounding error. This caps any one trade at a fixed
// SHARE of the account, so concentration stays constant as equity moves.
const MAX_NOTIONAL_PCT = parseFloat(process.env.STOCK_MAX_NOTIONAL_PCT || "7") / 100;
const SHORTS = /^(1|true|yes|on)$/i.test(process.env.ORB_SHORTS || "");
const TRAILING = /^(1|true|yes|on)$/i.test(process.env.ORB_TRAILING || "");
const LONGS = !/^(0|false|no|off)$/i.test(process.env.ORB_LONGS || "true"); // default on

// ── Risk controls (on by default; tune or disable via env) ──
const REGIME = !/^(0|false|no|off)$/i.test(process.env.ORB_REGIME || "true");
const REGIME_SYM = process.env.ORB_REGIME_SYMBOL || "SPY";
const MAX_POSITIONS = parseInt(process.env.ORB_MAX_POSITIONS || "4", 10);
const MAX_PER_SECTOR = parseInt(process.env.ORB_MAX_PER_SECTOR || "2", 10);
const MAX_DAILY_LOSS = parseFloat(process.env.ORB_MAX_DAILY_LOSS || "150");
const MIN_RISK_FRAC = parseFloat(process.env.STOCK_MIN_RISK_FRAC || "0.5");
const TRAIL_ATR_MULT = parseFloat(process.env.ORB_TRAIL_ATR_MULT || "2");
const TRAIL_MIN_PCT = parseFloat(process.env.ORB_TRAIL_MIN_PCT || "1") / 100;

const OPEN = 570; // 9:30 ET
const LAST_ENTRY = parseInt(process.env.ORB_LAST_ENTRY || "690", 10); // 11:30 ET
const FLATTEN = 950; // 15:50 ET — leaves the 15:50 + 15:55 cycles to confirm closes before the bell
const WATCHLIST = "watchlist.csv";
const TRADELOG = process.env.STOCK_TRADELOG || "stock-trades.csv";
const STATE = process.env.STOCK_STATE || "stock-state.json";
const SHARED_CACHE = process.env.SHARED_BAR_CACHE || "../.bar-cache";
const TAG = `${LONGS ? "L" : ""}${SHORTS ? "S" : ""}${TRAILING ? "T" : ""}` || "?"; // log/SMS prefix

// Correlated clusters — so MAX_PER_SECTOR stops the bot from opening what looks
// like N independent trades but is really one levered bet (e.g. SOXL+MRVL+INTC
// are all "semis"). Unknown symbols map to themselves (no false grouping).
const SECTOR = {
  SOXL: "semis", SOXS: "semis", SMH: "semis", NVDA: "semis", AMD: "semis",
  MRVL: "semis", INTC: "semis", MU: "semis", TSM: "semis", AVGO: "semis",
  QCOM: "semis", ARM: "semis", NVDL: "semis", NVD: "semis",
  BITO: "crypto", IBIT: "crypto", GBTC: "crypto", MSTR: "crypto", COIN: "crypto",
  ETHA: "crypto", BITX: "crypto", MARA: "crypto", RIOT: "crypto",
  TSLL: "tsla", TSLA: "tsla", TSLQ: "tsla", TSLS: "tsla",
  SPY: "index", QQQ: "index", IWM: "index", DIA: "index", TQQQ: "index", SQQQ: "index",
};
const sectorOf = (s) => SECTOR[s] || s;

// Inverse / short-exposure ETFs: a LONG in these is economically a SHORT on the
// underlying (and vice versa), so the regime filter and the per-sector direction
// guard must use the ECONOMIC direction, not the order side. Long-vol products
// (VXX etc.) behave the same way vs the SPY tape. Not exhaustive — extend as the
// scanner surfaces new ones.
const INVERSE = new Set([
  "SQQQ", "SOXS", "SPXS", "SPXU", "SDOW", "SH", "PSQ", "DOG", "RWM", "TZA",
  "SRTY", "FAZ", "LABD", "WEBS", "TSLQ", "TSLS", "TSLZ", "NVD", "NVDD",
  "MSTZ", "SMST", "BITI", "ETHD", "SARK", "UVXY", "VIXY", "VXX", "UVIX",
]);
// +1 if the position gains when its underlying/sector rises, -1 if it gains on
// a fall. side: "long"/"short" order side.
const econDir = (sym, side) =>
  (side === "long" ? 1 : -1) * (INVERSE.has(sym) ? -1 : 1);

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
function et(ts) {
  const p = {};
  for (const x of etFmt.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function loadState() {
  if (!existsSync(STATE)) return { date: null, entered: {}, exited: {}, realizedPnl: 0 };
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return { date: null, entered: {}, exited: {}, realizedPnl: 0 };
  }
}
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

function logTrade(cols) {
  if (!existsSync(TRADELOG))
    writeFileSync(TRADELOG, "Date,Time(ET),Symbol,Side,Action,Qty,Price,Notional,Reason,OrderID\n");
  appendFileSync(TRADELOG, cols.join(",") + "\n");
}

function readWatchlist(today) {
  if (!existsSync(WATCHLIST)) return [];
  const syms = readFileSync(WATCHLIST, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.split(","))
    .filter((c) => c[0] === today)
    .map((c) => c[1]);
  return [...new Set(syms)]; // dedupe in case the scanner ran more than once today
}

// Average True Range over `n` of the supplied bars — used to size the trailing
// stop so it scales with the name's real volatility, not the raw OR width.
function atr(bars, n = 14) {
  if (!bars || bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-n);
  if (!slice.length) return null;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Map a closed exit order to a reason from its ACTUAL type — never infer from
// price (a slipped stop fill that lands a hair past the level used to be logged
// as a "target", turning losses into fake wins).
function reasonFromFill(o, entry) {
  if (!o) return entry.trail ? "trail-stop" : "exit";
  const t = (o.type || o.order_type || "").toLowerCase();
  if (t === "limit") return "target";
  if (t === "trailing_stop") return "trail-stop";
  if (t.includes("stop")) return "stop";
  return entry.trail ? "trail-stop" : "exit";
}

// Shared, cross-account bar cache keyed by the 5-min cycle, so every account
// running in the same cycle reads identical data (market data is account-blind).
// Write to a temp file + rename so a concurrent reader never sees a partial file.
async function sharedBars(sym, tf, startISO, bucketKey) {
  const f = `${SHARED_CACHE}/${sym}-${tf}-${bucketKey}.json`;
  if (existsSync(f)) {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      /* fall through to a fresh fetch */
    }
  }
  const bars = await recentBars(sym, tf, startISO);
  try {
    if (!existsSync(SHARED_CACHE)) mkdirSync(SHARED_CACHE, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(bars));
    renameSync(tmp, f);
  } catch {
    /* caching is best-effort; the bars are still returned */
  }
  return bars;
}

async function main() {
  const now = et(Date.now());
  const clock = await getClock();
  console.log(
    `[${now.date} ${hhmm(now.min)} ET] ${TAG} market ${clock.is_open ? "OPEN" : "closed"} | shorts=${SHORTS} trailing=${TRAILING} regime=${REGIME}`,
  );

  let state = loadState();
  // Did the previous run happen in an EARLIER session? If so, anything still open
  // at the broker is a STRANDED position — a prior EOD flatten failed to close it,
  // and yesterday's state (including its entry record) is about to be wiped.
  const priorDate = state.date;
  const newSession = !!(priorDate && priorDate !== now.date);
  if (state.date !== now.date) state = { date: now.date, entered: {}, exited: {}, realizedPnl: 0 };
  state.entered ||= {}; // tolerate older/partial state files
  state.exited ||= {};
  state.realizedPnl ||= 0;
  state.shortable ||= {}; // per-day cache of which symbols Alpaca will let us short
  state.shortBlocked ||= false; // account-level "not allowed to short" latch (per day)

  const startISO = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const bucketKey = `${now.date}-${Math.floor(now.min / 5)}`; // one cache slot per 5-min cycle

  let positions = await getPositions();
  const posMap = Object.fromEntries(positions.map((p) => [p.symbol, p]));

  // ── Detect broker-filled exits (full OR partial) on names we entered ──
  const afterISO = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const enteredSyms = Object.keys(state.entered);
  const needLookup = enteredSyms.some((s) => {
    if (state.exited[s]) return false;
    const held = posMap[s] ? Math.abs(Number(posMap[s].qty)) : 0;
    const expected = state.entered[s].qty - (state.entered[s].exitedQty || 0);
    return held < expected - 1e-9;
  });
  const closedOrders = needLookup
    ? await getOrders(`?status=closed&after=${afterISO}&limit=100&direction=desc`)
    : [];
  for (const sym of enteredSyms) {
    if (state.exited[sym]) continue;
    const e = state.entered[sym];
    const isShort = e.side === "short";
    const exitSide = isShort ? "buy" : "sell";
    const held = posMap[sym] ? Math.abs(Number(posMap[sym].qty)) : 0;
    const expected = e.qty - (e.exitedQty || 0);
    if (held >= expected - 1e-9) continue; // nothing new closed since last check

    // Reconcile against the actual exit-side fills (handles partial fills).
    const fills = closedOrders.filter(
      (o) => o.symbol === sym && o.side === exitSide && o.status === "filled" && Math.abs(+o.filled_qty) > 0,
    );
    const totalOut = fills.reduce((s, o) => s + Math.abs(+o.filled_qty), 0);
    const vw = totalOut > 0
      ? fills.reduce((s, o) => s + +o.filled_avg_price * Math.abs(+o.filled_qty), 0) / totalOut
      : null;
    const closedQty = expected - held; // shares that left the book since last run
    const exitPx = vw ?? e.entry; // best available; entry → P/L 0 if no fill record
    const reason = reasonFromFill(fills[0], e) + (held > 1e-9 ? "-partial" : "");
    const pnl = isShort ? (e.entry - exitPx) * closedQty : (exitPx - e.entry) * closedQty;

    e.exitedQty = (e.exitedQty || 0) + closedQty;
    if (held <= 1e-9) state.exited[sym] = true;
    state.realizedPnl += pnl;
    logTrade([now.date, hhmm(now.min), sym, e.side, "EXIT", closedQty, exitPx.toFixed(2), "", reason, ""]);
    console.log(`  EXIT ${sym} (${e.side}/${reason}) ${closedQty}sh @ ${exitPx.toFixed(2)} P/L $${pnl.toFixed(2)} | day $${state.realizedPnl.toFixed(2)}`);
    await sendSms(`PAPER ${TAG} EXIT ${sym} ${reason} @ $${exitPx.toFixed(2)} P/L $${pnl.toFixed(2)}`);
  }

  // ── End-of-day flatten: cancel resting orders, WAIT for them to clear, close ──
  // The bracket legs (stop + target) keep the shares held_for_orders, so a
  // closePosition fired right after cancelAllOrders() 403s — the cancels haven't
  // settled yet. So we poll until no open orders remain before closing, and
  // closePositionConfirmed() re-cancels + retries if a stray hold lingers.
  // Verify the close order actually FILLS before logging / marking exited — a
  // market close fired after the bell doesn't fill until the next session, and
  // logging it anyway produces phantom exits while the position quietly lingers.
  if (now.min >= FLATTEN) {
    const stuck = await flattenAll(positions, state, now, "eod-flatten");
    if (stuck.length) {
      // An unflattened position is the most expensive failure this bot has. A
      // stranded SMCI short (2026-06-16 -> 06-22, held over a weekend because the
      // close never confirmed and nothing escalated) lost $355.67 — more than
      // account C's entire two-month net. It must never pass silently again:
      // alert now, and the next session's stranded sweep closes it at the open.
      const msg = `PAPER ${TAG} FLATTEN FAILED — still open: ${stuck.join(", ")}. Will auto-close at next open; or run "node flatten.js" during RTH.`;
      console.log(`  !! ${msg}`);
      await sendSms(msg);
    }
    saveState(state);
    return;
  }

  if (!clock.is_open) {
    console.log("  market closed — nothing to do.");
    saveState(state);
    return;
  }

  // ── Stranded-position sweep ──
  // Anything still open on the FIRST cycle of a new session means a previous EOD
  // flatten never completed. The old code only re-tried at 15:50, so a miss sat
  // on the book for a whole extra day (or across a weekend, which is how the
  // SMCI short turned into a -$356 loss). Close it on the first cycle that can
  // actually fill, before considering any new entries.
  if (newSession && positions.length) {
    console.log(`  STRANDED from ${priorDate}: ${positions.map((p) => `${p.symbol}(${p.qty})`).join(", ")} — closing now.`);
    const stuck = await flattenAll(positions, state, now, "stranded-flatten");
    if (stuck.length) {
      const msg = `PAPER ${TAG} STILL STRANDED after retry: ${stuck.join(", ")} — manual "node flatten.js" needed.`;
      console.log(`  !! ${msg}`);
      await sendSms(msg);
    }
    for (const p of positions) if (!stuck.includes(p.symbol)) delete posMap[p.symbol];
    positions = positions.filter((p) => stuck.includes(p.symbol)); // keep caps honest
  }

  const watchlist = readWatchlist(now.date);
  if (!watchlist.length) {
    console.log("  no watchlist for today — run scan.js pre-market.");
    saveState(state); // this path used to drop state — losing any exit detected
    return;           // above, and any P/L booked by the stranded sweep.
  }
  console.log(`  watchlist: ${watchlist.join(", ")}`);

  // ── Look for new ORB entries ──
  if (now.min < OPEN + OR_MIN || now.min > LAST_ENTRY) {
    saveState(state);
    return; // outside the entry window (before OR done / after last-entry cutoff)
  }

  // Daily loss kill-switch — stop opening risk once we're down MAX_DAILY_LOSS.
  if (state.realizedPnl <= -MAX_DAILY_LOSS) {
    console.log(`  daily loss limit hit (realized $${state.realizedPnl.toFixed(2)} ≤ −$${MAX_DAILY_LOSS}) — no new entries.`);
    saveState(state);
    return;
  }

  // ── Per-trade notional ceiling ──
  // Two caps bind and the SMALLER wins: the fixed STOCK_MAX_NOTIONAL and
  // STOCK_MAX_NOTIONAL_PCT of live account equity. Equity (cash + market value of
  // open positions) is the honest denominator — NOT buying_power, which is
  // margin-inflated and would let 7% of "tradeable" mean a multiple of what the
  // account actually owns.
  //
  // Fetched once per cycle, and only here: this is the only branch that can open
  // a position, so a closed market / empty watchlist costs no extra API call.
  //
  // Fails CLOSED. If the account can't be read (alpaca.js has already retried),
  // we do not know the denominator, so we don't guess and we don't fall back to
  // the fixed cap alone — no new entries this cycle. Exits, reconciliation and
  // the EOD flatten all ran above and are unaffected.
  let notionalCap = MAX_NOTIONAL;
  if (MAX_NOTIONAL_PCT > 0) {
    let equity = null;
    try {
      const acct = await getAccount();
      equity = Number(acct.equity ?? acct.portfolio_value ?? acct.last_equity);
    } catch (e) {
      console.log(`  account lookup failed (${e.message}) — can't size vs equity, no new entries.`);
      saveState(state);
      return;
    }
    if (!Number.isFinite(equity) || equity <= 0) {
      console.log(`  account equity unusable (${equity}) — no new entries.`);
      saveState(state);
      return;
    }
    state.equity = equity; // recorded for the trade log / postmortems
    const pctCap = MAX_NOTIONAL_PCT * equity;
    notionalCap = Math.min(MAX_NOTIONAL, pctCap);
    console.log(
      `  equity $${equity.toFixed(2)} | cap $${notionalCap.toFixed(2)} = min(fixed $${MAX_NOTIONAL.toFixed(0)}, ${(MAX_NOTIONAL_PCT * 100).toFixed(1)}% = $${pctCap.toFixed(2)})`,
    );
  }

  // Market regime — only trade WITH the tape (longs need SPY≥VWAP, shorts ≤VWAP).
  let regime = null;
  if (REGIME) {
    try {
      const spy = await sharedBars(REGIME_SYM, "5Min", startISO, bucketKey);
      const vwap = sessionVWAP(spy);
      const px = spy.length ? spy[spy.length - 1].close : null;
      if (vwap && px) regime = px >= vwap ? "bull" : "bear";
      console.log(`  regime ${REGIME_SYM} ${px ? px.toFixed(2) : "?"} vs VWAP ${vwap ? vwap.toFixed(2) : "?"} -> ${regime || "unknown"}`);
    } catch (e) {
      console.log(`  regime check failed (${e.message}) — not filtering`);
    }
  }

  // Current exposure for the position/sector caps (positions = today's holds).
  // secDir tracks each sector's ECONOMIC direction so we never pair a position
  // with its own hedge (e.g. long SOXL + long SOXS = a self-cancelling decay
  // pair that the plain count cap would happily allow).
  let live = positions.length;
  const secCnt = {};
  const secDir = {};
  for (const p of positions) {
    const s = sectorOf(p.symbol);
    secCnt[s] = (secCnt[s] || 0) + 1;
    secDir[s] ||= econDir(p.symbol, Number(p.qty) < 0 ? "short" : "long");
  }

  for (const sym of watchlist) {
    if (state.entered[sym] || posMap[sym]) continue; // one trade per symbol per day
    if (live >= MAX_POSITIONS) {
      console.log(`  max positions (${MAX_POSITIONS}) reached — no more entries.`);
      break;
    }
    const sec = sectorOf(sym);
    if ((secCnt[sec] || 0) >= MAX_PER_SECTOR) {
      console.log(`  ${sym}: sector "${sec}" at cap (${MAX_PER_SECTOR}) — skip.`);
      continue;
    }
    try {
      const bars = await sharedBars(sym, "5Min", startISO, bucketKey);
      const orBars = bars.filter((b) => {
        const e = et(b.time);
        return e.date === now.date && e.min >= OPEN && e.min < OPEN + OR_MIN;
      });
      if (!orBars.length || !bars.length) continue;
      const orHigh = Math.max(...orBars.map((b) => b.high));
      const orLow = Math.min(...orBars.map((b) => b.low));
      const price = bars[bars.length - 1].close;

      // Direction: long on break above OR high, short on break below OR low —
      // but only if its ECONOMIC direction agrees with the market regime. For an
      // inverse ETF the order side is flipped vs the tape (long SQQQ is a bet on
      // a falling market), so the regime gate checks econDir, not the order side.
      const inv = INVERSE.has(sym);
      const okLong = inv ? regime !== "bull" : regime !== "bear";
      const okShort = inv ? regime !== "bear" : regime !== "bull";
      let side = null;
      let stop = null;
      if (LONGS && price > orHigh && okLong) {
        side = "long";
        stop = orLow;
      } else if (SHORTS && price < orLow && okShort) {
        side = "short";
        stop = orHigh;
      }
      if (!side) {
        if (LONGS && price > orHigh && !okLong)
          console.log(`  ${sym}: long break vetoed by ${regime} regime${inv ? " (inverse ETF)" : ""}`);
        if (SHORTS && price < orLow && !okShort)
          console.log(`  ${sym}: short break vetoed by ${regime} regime${inv ? " (inverse ETF)" : ""}`);
        continue;
      }

      // Never open a position that economically opposes what we already hold in
      // this sector — that's a hedged decay pair, not a second independent bet.
      const econ = econDir(sym, side);
      if (secDir[sec] && secDir[sec] !== econ) {
        console.log(`  ${sym}: ${side} opposes held ${sec} exposure (econ ${secDir[sec] > 0 ? "long" : "short"}) — skip.`);
        continue;
      }

      // Shortability gate: Alpaca rejects shorts on hard-to-borrow names with a
      // 422, and we'd otherwise re-attempt (and re-fail) the same order every
      // 5-min cycle. Check the asset's shortable flag once per symbol per day
      // (cached in state) so we skip silently after the first lookup.
      if (side === "short") {
        if (state.shortBlocked) {
          console.log(`  ${sym}: account-level short block active today — skip.`);
          continue;
        }
        if (state.shortable[sym] === undefined) {
          try {
            const a = await getAsset(sym);
            state.shortable[sym] = !!(a.shortable && a.tradable);
          } catch {
            state.shortable[sym] = false; // unknown → don't keep hammering a doomed order
          }
        }
        if (!state.shortable[sym]) {
          console.log(`  ${sym}: not shortable — skip.`);
          continue;
        }
      }

      const riskPerShare = Math.abs(price - stop);
      if (riskPerShare <= 0) continue;
      let qty = Math.floor(RISK_USD / riskPerShare);
      if (qty < 1) qty = 1;
      // Hard notional ceiling. Note the floor: if even ONE share is worth more
      // than the cap this lands on 0 and the trade is skipped outright — the cap
      // is never rounded up to "at least one share".
      if (qty * price > notionalCap) qty = Math.floor(notionalCap / price);
      if (qty < 1) {
        console.log(`  ${sym}: 1sh @ $${price.toFixed(2)} exceeds the $${notionalCap.toFixed(0)} notional cap — skip.`);
        continue;
      }

      // If the notional cap shrank risk well below target, the trade isn't a fair
      // representative of the strategy (its P/L is dwarfed) — skip for comparability.
      const dollarRisk = riskPerShare * qty;
      if (dollarRisk < RISK_USD * MIN_RISK_FRAC) {
        console.log(`  ${sym}: notional cap shrinks risk to $${dollarRisk.toFixed(0)} (< ${(MIN_RISK_FRAC * 100).toFixed(0)}% of $${RISK_USD}) — skip.`);
        continue;
      }

      let entry = price;
      let target = null;
      let orderId = "";
      let tgtStr;

      if (TRAILING) {
        // Plain entry, then a native trailing stop that rides the move. Trail
        // distance scales with ATR and has a price-% floor (no penny trails).
        const entrySide = side === "long" ? "buy" : "sell";
        const exitSide = side === "long" ? "sell" : "buy";
        const eo = await placeMarket({ symbol: sym, qty, side: entrySide });
        const filled = await waitFill(eo.id);
        const fqty = Math.floor(Math.abs(+filled.filled_qty)) || qty;
        entry = +filled.filled_avg_price || price;
        qty = fqty;
        const atrVal = atr(bars, 14);
        const trail = Number(process.env.ORB_TRAIL_PRICE) || Math.max(
          atrVal ? TRAIL_ATR_MULT * atrVal : riskPerShare,
          TRAIL_MIN_PCT * entry,
        );
        await placeTrailingStop({ symbol: sym, qty, side: exitSide, trailPrice: trail });
        state.entered[sym] = { side, qty, entry, stop, risk: dollarRisk, trail: true, exitedQty: 0 };
        tgtStr = `trail${trail.toFixed(2)}`;
      } else {
        target = side === "long" ? entry + R * riskPerShare : entry - R * riskPerShare;
        const place = side === "long" ? placeBracketBuy : placeBracketSell;
        const order = await place({ symbol: sym, qty, takeProfit: target, stopLoss: stop });
        orderId = order.id;
        // Record the ACTUAL fill, not the signal price — P/L is computed from
        // state.entered.entry, and on a thin feed the two can differ enough to
        // distort the scorecard. The bracket legs stay where they were placed.
        const filled = await waitFill(order.id).catch(() => null);
        if (filled && +filled.filled_avg_price) {
          entry = +filled.filled_avg_price;
          qty = Math.floor(Math.abs(+filled.filled_qty)) || qty;
        }
        state.entered[sym] = { side, qty, entry, stop, target, risk: dollarRisk, exitedQty: 0 };
        tgtStr = `tgt${target.toFixed(2)}`;
      }

      live++;
      secCnt[sec] = (secCnt[sec] || 0) + 1;
      secDir[sec] ||= econ;
      logTrade([
        now.date, hhmm(now.min), sym, side, "ENTRY", qty, entry.toFixed(2),
        (qty * entry).toFixed(2), `ORB ${side} stop${stop.toFixed(2)} ${tgtStr}`,
        orderId,
      ]);
      console.log(
        `  ENTER ${side} ${sym} ${qty}sh @ ${entry.toFixed(2)} | stop ${stop.toFixed(2)} ${tgtStr} | risk $${dollarRisk.toFixed(0)} | sec ${sec}`,
      );
      await sendSms(
        `PAPER ${TAG} ${side.toUpperCase()} ${sym} ${qty} @ $${entry.toFixed(2)} stop $${stop.toFixed(2)} ${tgtStr}`,
      );
    } catch (e) {
      // Some shorts are only refused at ORDER time: the asset's `shortable` flag
      // says yes but there's no borrow ("cannot be sold short"), or the whole
      // account is blocked ("account is not allowed to short"). Neither is
      // retryable — but the old code just logged and moved on, so the identical
      // doomed order was re-sent every 5 minutes, all day, every day (SQQQ alone:
      // 99 rejected attempts on account C, 69 on B). Latch the refusal instead.
      const msg = e.message || String(e);
      if (/cannot be sold short|not easy to borrow|no shares? available|htb/i.test(msg)) {
        state.shortable[sym] = false;
        console.log(`  ${sym}: broker refused the short (no borrow) — cached as unshortable for today.`);
      } else if (/account is not allowed to short/i.test(msg)) {
        state.shortBlocked = true;
        console.log(`  !! account-level short block hit — suppressing all short attempts for the rest of today.`);
      } else {
        console.log(`  ${sym}: ${msg}`);
      }
    }
  }
  saveState(state);
}

// Close every open position, logging and alerting honestly. Shared by the EOD
// flatten and the start-of-session stranded sweep. Returns the symbols that
// could NOT be confirmed closed, so the caller can escalate rather than assume.
async function flattenAll(positions, state, now, reason) {
  const stuck = [];
  if (!positions.length) return stuck;
  await cancelAllOrders().catch(() => {});
  await waitOrdersCleared(); // block until held_for_orders shares are released
  for (const p of positions) {
    try {
      const filled = await closePositionConfirmed(p.symbol);
      if (!filled || filled.status !== "filled") {
        // No phantom row, no exited flag — an unconfirmed close is NOT an exit.
        console.log(`  ${reason} ${p.symbol}: close not confirmed (status ${filled ? filled.status : "no-order"}).`);
        stuck.push(p.symbol);
        continue;
      }
      const e = state.entered[p.symbol];
      const exitPx = +filled.filled_avg_price || Number(p.current_price);
      const qty = Math.floor(Math.abs(+filled.filled_qty)) || Math.abs(Number(p.qty));
      const side = Number(p.qty) < 0 ? "short" : "long";
      // A stranded position's entry record died with yesterday's state, so fall
      // back to the broker's own unrealized P/L rather than logging a fake zero.
      const pnl = e
        ? (e.side === "short" ? (e.entry - exitPx) * qty : (exitPx - e.entry) * qty)
        : Number(p.unrealized_pl || 0);
      if (e) e.exitedQty = (e.exitedQty || 0) + qty;
      state.exited[p.symbol] = true;
      state.realizedPnl += pnl;
      logTrade([now.date, hhmm(now.min), p.symbol, side, "EXIT", qty, exitPx.toFixed(2), "", reason, ""]);
      console.log(`  ${reason} ${p.symbol} ${qty}sh @ ${exitPx.toFixed(2)} P/L $${pnl.toFixed(2)} | day $${state.realizedPnl.toFixed(2)}`);
      await sendSms(`PAPER ${TAG} EXIT ${p.symbol} ${reason} @ $${exitPx.toFixed(2)} P/L $${pnl.toFixed(2)}`);
    } catch (err) {
      console.log(`  ${reason} ${p.symbol} failed: ${err.message}`);
      stuck.push(p.symbol);
    }
  }
  return stuck;
}

// Poll an order until it fills (paper market orders fill ~instantly).
async function waitFill(id, tries = 6, ms = 600) {
  let o;
  for (let i = 0; i < tries; i++) {
    o = await getOrder(id);
    if (o.status === "filled") return o;
    if (["canceled", "rejected", "expired"].includes(o.status))
      throw new Error(`entry ${o.status}`);
    await new Promise((r) => setTimeout(r, ms));
  }
  return o; // best effort — caller falls back to signal price/qty
}

// After cancelAllOrders(), the broker keeps reporting the orders as open for a
// beat and the shares stay held_for_orders. Poll until there are no open orders
// left (or we exhaust tries) so the following closePosition won't 403.
async function waitOrdersCleared(tries = 10, ms = 500) {
  for (let i = 0; i < tries; i++) {
    const open = await getOrders("?status=open").catch(() => null);
    if (Array.isArray(open) && open.length === 0) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

// Close a position, tolerating the held_for_orders race: if the broker still
// hasn't freed the shares, re-cancel, wait, and retry. Returns the FILLED close
// order, or null if it never confirmed (caller then leaves it for the next run).
async function closePositionConfirmed(symbol, tries = 6, ms = 700) {
  for (let i = 0; i < tries; i++) {
    try {
      const order = await closePosition(symbol);
      const filled = order && order.id ? await waitFill(order.id).catch(() => null) : null;
      if (filled && filled.status === "filled") return filled;
    } catch (e) {
      // 403 / held_for_orders means a resting order still locks the shares —
      // clear them and retry. Anything else is a real error: surface it.
      if (!/40310000|held_for_orders|\b403\b/.test(e.message)) throw e;
      await cancelAllOrders().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, ms));
  }
  return null;
}

main().catch((e) => {
  console.error("stockbot error:", e.message);
  process.exitCode = 1;
});
