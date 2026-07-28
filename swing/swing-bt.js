/**
 * Bot E backtest. Replays DAILY bars through the exact rules in
 * swing-strategy.js — the same module swingbot.js trades — so this measures the
 * strategy, not a re-implementation of it.
 *
 *   node swing-bt.js                 # default universe, 730 days
 *   node swing-bt.js 1095            # 3 years
 *   node swing-bt.js 730 AAPL,MSFT   # specific names
 *
 * WHAT IT IS HONEST ABOUT
 *   1. Gap-through fills. A stop is not a guarantee. If the next session opens
 *      past the stop, this fills at the OPEN, not the stop price, and counts the
 *      trade in the "gapped" bucket. That bucket is the direct test of "losses
 *      are 1–2%" — if it is large, the loss cap is fiction.
 *   2. Same-bar ambiguity. When one daily bar touches BOTH the stop and the
 *      target, there is no way to know which came first, so it is scored as the
 *      STOP. That biases the result down, deliberately.
 *   3. Signal-bar entry. The live bot enters near 15:40, this fills at the
 *      session close, plus SWING_BT_SLIPPAGE_BPS of cost each way.
 *   4. No portfolio caps. Position/sector limits are NOT applied — this measures
 *      the signal's edge, not the allocator. Peak concurrency is reported so you
 *      can see how much the live caps would have truncated.
 *   5. Survivorship. The universe is today's liquid names, so it inherits
 *      survivorship bias. Treat the level as optimistic; the SHAPE of the
 *      R-distribution is the part worth trusting.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dailyBarsMulti } from "./alpaca.js";
import {
  CFG, WARMUP, entrySignal, exitLevels, ratchetStop, bestSince, sma, atr, indicators, regimeOf,
} from "./swing-strategy.js";

const DAYS = parseInt(process.argv[2] || "730", 10);
const SLIP = parseFloat(process.env.SWING_BT_SLIPPAGE_BPS || "5") / 10000;
const REGIME_SYM = process.env.SWING_REGIME_SYMBOL || "SPY";
const DEFAULT_UNIVERSE = [
  "AAPL","MSFT","GOOGL","AMZN","META","NVDA","AVGO","AMD","CRM","ADBE","ORCL","CSCO",
  "QCOM","TXN","INTC","MU","AMAT","LRCX","NOW","PANW","JPM","BAC","WFC","GS","MS","C",
  "SCHW","BLK","AXP","V","MA","UNH","JNJ","LLY","ABBV","MRK","PFE","TMO","ABT","CAT",
  "DE","HON","GE","BA","UNP","LMT","RTX","WMT","COST","HD","LOW","MCD","NKE","SBUX",
  "PG","KO","PEP","XOM","CVX","COP","SLB","DIS","NFLX","TSLA","UBER","LIN","T",
  "SPY","QQQ","IWM","DIA","XLK","XLF","XLE","XLV","XLI","SMH",
];
const UNIVERSE = (process.argv[3] || process.env.SWING_UNIVERSE || DEFAULT_UNIVERSE.join(","))
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * Walk one symbol's bars. Returns closed trades.
 * `regimeByDay` maps YYYY-MM-DD -> "bull" | "bear".
 */
function simulate(sym, bars, regimeByDay) {
  const trades = [];
  let pos = null;

  for (let i = WARMUP; i < bars.length; i++) {
    const bar = bars[i];

    if (pos) {
      pos.held += 1;
      const long = pos.side === "long";
      // Record this bar's excursion BEFORE testing the exits. Doing it after
      // silently drops the exit bar, which is usually the most extreme one —
      // reported MFE then came out lower than the target the trade just hit.
      pos.mfe = Math.max(pos.mfe, (long ? bar.high - pos.entry : pos.entry - bar.low) / pos.entry);
      pos.mae = Math.min(pos.mae, (long ? bar.low - pos.entry : pos.entry - bar.high) / pos.entry);
      // Stop as it stands at the OPEN of this bar — the ratchet from prior bars
      // is already applied; today's own action cannot move it retroactively.
      const stop = pos.stop;
      const tgt = pos.target;
      let fill = null, reason = null, gapped = false;

      // Gap through the stop: the resting stop becomes a market order at the
      // open and fills wherever the tape is. This is the loss-cap's blind spot.
      if ((long && bar.open <= stop) || (!long && bar.open >= stop)) {
        fill = bar.open; reason = "stop"; gapped = true;
      } else if ((long && bar.open >= tgt) || (!long && bar.open <= tgt)) {
        fill = bar.open; reason = "target"; gapped = true; // favourable gap
      } else if ((long && bar.low <= stop) || (!long && bar.high >= stop)) {
        fill = stop; reason = "stop"; // stop before target when both are touched
      } else if ((long && bar.high >= tgt) || (!long && bar.low <= tgt)) {
        fill = tgt; reason = "target";
      } else if (pos.held >= CFG.maxHoldDays) {
        fill = bar.close; reason = "time-stop";
      }

      if (fill != null) {
        const gross = long ? (fill - pos.entry) / pos.entry : (pos.entry - fill) / pos.entry;
        const net = gross - 2 * SLIP;
        // A stop fill at or beyond breakeven is a ratcheted scratch, not a loss —
        // worth its own bucket because it is the whole point of the ratchet.
        const label =
          reason === "stop" && (long ? stop >= pos.entry : stop <= pos.entry) ? "be-stop" : reason;
        trades.push({
          sym, side: pos.side, entryDay: dayKey(pos.entryTime), exitDay: dayKey(bar.time),
          net, r: net / CFG.stopPct, reason: label, gapped, held: pos.held,
          mfe: pos.mfe, mae: pos.mae,
        });
        pos = null;
      } else {
        // Survived the bar — ratchet the stop off the now-CLOSED bar.
        pos.barsSince.push(bar);
        const best = bestSince(pos.side, pos.barsSince);
        pos.stop = ratchetStop(pos.side, pos.entry, pos.stop, best, atr(bars.slice(0, i + 1), CFG.atrLen));
        continue;
      }
    }

    if (!pos) {
      const window = bars.slice(0, i + 1);
      const sig = entrySignal(window, regimeByDay[dayKey(bar.time)] ?? null);
      if (sig) {
        const entry = bar.close;
        const lv = exitLevels(sig.side, entry);
        pos = {
          side: sig.side, entry, entryTime: bar.time, stop: lv.stop, target: lv.target,
          held: 0, mfe: 0, mae: 0, barsSince: [bar],
        };
      }
    }
  }
  return trades;
}

function report(trades) {
  const n = trades.length;
  if (!n) {
    console.log("\nNo trades. Either the gate rejected the whole universe or the trigger never fired.");
    console.log("Check `node swing-scan.js --explain` — an empty universe is the usual cause.");
    return;
  }
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const gw = sum(wins.map((t) => t.net));
  const gl = -sum(losses.map((t) => t.net));
  const pf = gl > 0 ? gw / gl : Infinity;
  const wr = wins.length / n;
  const expR = sum(trades.map((t) => t.r)) / n;
  const avgW = wins.length ? sum(wins.map((t) => t.net)) / wins.length : 0;
  const avgL = losses.length ? sum(losses.map((t) => t.net)) / losses.length : 0;
  const wl = avgL !== 0 ? Math.abs(avgW / avgL) : Infinity;
  const beWr = Number.isFinite(wl) ? 1 / (1 + wl) : 0;

  console.log(`\n${"═".repeat(74)}`);
  console.log(`Bot E backtest — stop ${(CFG.stopPct * 100).toFixed(1)}%  target ${(CFG.targetPct * 100).toFixed(1)}%  ` +
              `hold ≤${CFG.maxHoldDays}d  trigger ${CFG.trigger}  BE@${(CFG.beAtPct * 100).toFixed(1)}%`);
  console.log("═".repeat(74));
  console.log(`Trades            ${n}`);
  console.log(`Win rate          ${(wr * 100).toFixed(1)}%   (break-even needs ${(beWr * 100).toFixed(1)}%)`);
  console.log(`Profit factor     ${pf.toFixed(2)}`);
  console.log(`Expectancy        ${expR >= 0 ? "+" : ""}${expR.toFixed(3)}R  (${(sum(trades.map((t) => t.net)) / n * 100).toFixed(2)}% per trade)`);
  console.log(`Avg win / loss    +${(avgW * 100).toFixed(2)}% / ${(avgL * 100).toFixed(2)}%   ratio ${wl.toFixed(2)}`);
  console.log(`Avg hold          ${(sum(trades.map((t) => t.held)) / n).toFixed(1)} trading days`);

  // Lesson 2 of POSTMORTEM-BOT-A.md: if the target almost never fills, nothing
  // downstream can save the strategy. Print it prominently.
  const hitTarget = trades.filter((t) => t.reason === "target").length;
  console.log(`\nTarget fill rate  ${((hitTarget / n) * 100).toFixed(1)}%  (${hitTarget}/${n})`);
  console.log("  Bot A's fatal number was 2.5%. Below ~15% here and the 4–7% target is out of reach too.");

  console.log("\nExit mix");
  const byReason = {};
  for (const t of trades) (byReason[t.reason] ||= []).push(t);
  for (const [r, ts] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
    const w = ts.filter((t) => t.net > 0).length;
    console.log(`  ${r.padEnd(12)} n=${String(ts.length).padStart(4)}  win ${((w / ts.length) * 100).toFixed(0).padStart(3)}%  ` +
                `avg ${(sum(ts.map((t) => t.net)) / ts.length * 100 >= 0 ? "+" : "")}${(sum(ts.map((t) => t.net)) / ts.length * 100).toFixed(2)}%`);
  }

  // The claim under test: "losses are 1–2%".
  const stopLosses = trades.filter((t) => t.net <= 0);
  const gapped = trades.filter((t) => t.gapped && t.net <= 0);
  const worse = trades.filter((t) => t.net < -CFG.stopPct * 1.25);
  console.log("\nDoes the loss cap hold?");
  console.log(`  Losing trades          ${stopLosses.length}`);
  console.log(`  Gapped through stop    ${gapped.length} (${((gapped.length / Math.max(n, 1)) * 100).toFixed(1)}% of all trades)` +
              (gapped.length ? `, avg ${(sum(gapped.map((t) => t.net)) / gapped.length * 100).toFixed(2)}%` : ""));
  console.log(`  Losses worse than ${(CFG.stopPct * 125).toFixed(1)}%  ${worse.length}` +
              (worse.length ? `, worst ${(Math.min(...worse.map((t) => t.net)) * 100).toFixed(2)}%` : ""));
  console.log(`  ${gapped.length / Math.max(n, 1) > 0.05
      ? "!! Overnight gaps are breaking the stop often enough to matter — the 1–2% loss cap is NOT holding."
      : "Gap leakage is small; the stated loss cap is broadly intact."}`);

  console.log("\nR-distribution");
  const buckets = [[-99, -2], [-2, -1.5], [-1.5, -1], [-1, -0.5], [-0.5, 0], [0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, 99]];
  const maxCnt = Math.max(...buckets.map(([lo, hi]) => trades.filter((t) => t.r >= lo && t.r < hi).length), 1);
  for (const [lo, hi] of buckets) {
    const c = trades.filter((t) => t.r >= lo && t.r < hi).length;
    const lbl = `${String(lo).padStart(5)}R..${String(hi).padStart(5)}R`;
    console.log(`  ${lbl} n=${String(c).padStart(4)} ${"#".repeat(Math.round((c / maxCnt) * 40))}`);
  }

  // How far did trades actually travel? This is the swing hypothesis restated:
  // if MFE rarely reaches 4%, no exit rule can harvest 4–7%.
  const mfes = trades.map((t) => t.mfe).sort((a, b) => a - b);
  const q = (p) => mfes[Math.min(mfes.length - 1, Math.floor(p * mfes.length))] * 100;
  console.log("\nMax favourable excursion (how far the trade ever got, in its favour)");
  console.log(`  median ${q(0.5).toFixed(2)}%   75th ${q(0.75).toFixed(2)}%   90th ${q(0.9).toFixed(2)}%   max ${(mfes[mfes.length - 1] * 100).toFixed(2)}%`);
  for (const lvl of [2, 3, 4, 5, 7]) {
    const c = trades.filter((t) => t.mfe >= lvl / 100).length;
    console.log(`  reached +${lvl}%:  ${((c / n) * 100).toFixed(1)}%  (${c}/${n})`);
  }

  const bySide = { long: trades.filter((t) => t.side === "long"), short: trades.filter((t) => t.side === "short") };
  console.log("\nBy sleeve");
  for (const [s, ts] of Object.entries(bySide)) {
    if (!ts.length) { console.log(`  ${s.padEnd(6)} no trades`); continue; }
    const w = ts.filter((t) => t.net > 0);
    const l = -sum(ts.filter((t) => t.net <= 0).map((t) => t.net));
    console.log(`  ${s.padEnd(6)} n=${String(ts.length).padStart(4)}  win ${((w.length / ts.length) * 100).toFixed(1)}%  ` +
                `PF ${(l > 0 ? sum(w.map((t) => t.net)) / l : Infinity).toFixed(2)}  ` +
                `exp ${(sum(ts.map((t) => t.r)) / ts.length).toFixed(3)}R`);
  }

  const byYear = {};
  for (const t of trades) (byYear[t.exitDay.slice(0, 4)] ||= []).push(t);
  console.log("\nBy year (a strategy that only works in one year does not work)");
  for (const y of Object.keys(byYear).sort())
    console.log(`  ${y}  n=${String(byYear[y].length).padStart(4)}  exp ${(sum(byYear[y].map((t) => t.r)) / byYear[y].length).toFixed(3)}R`);

  console.log(`\n${"─".repeat(74)}`);
  console.log("Caveats: survivorship-biased universe, no portfolio caps, same-bar");
  console.log("stop-before-target, entry at the close. This is a screen, not a promise.");
  console.log("─".repeat(74));
}

/**
 * Bars on disk, keyed by universe + window. Parameter sweeps re-run the same
 * data dozens of times; without this every run re-downloads 77 symbols and the
 * sweep is bounded by the API instead of by the CPU. Cache is keyed by the day,
 * so it refreshes itself each morning. `data/` is gitignored.
 */
async function loadBars(syms, startISO) {
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
  const key = `data/bars-${DAYS}d-${syms.length}sym-${startISO.slice(0, 10)}-${new Date().toISOString().slice(0, 10)}.json`;
  if (existsSync(key)) {
    try {
      const c = JSON.parse(readFileSync(key, "utf8"));
      console.log(`Using cached bars (${key}). Delete data/ to force a refetch.`);
      return c;
    } catch {
      /* corrupt cache — fall through and refetch */
    }
  }
  console.log(`Fetching ${syms.length} symbols, ${DAYS} days of daily bars…`);
  const bars = await dailyBarsMulti(syms, startISO);
  try {
    writeFileSync(key, JSON.stringify(bars));
  } catch {
    /* caching is best-effort */
  }
  return bars;
}

async function main() {
  const startISO = new Date(Date.now() - (DAYS + WARMUP + 60) * 86400e3).toISOString();
  const bars = await loadBars([...new Set([...UNIVERSE, REGIME_SYM])], startISO);

  const spy = bars[REGIME_SYM] || [];
  const regimeByDay = {};
  if (CFG.regime) {
    // Call the SAME regimeOf() the live bot calls. This loop used to inline its
    // own `close >= sma` copy of the rule, which meant any change to the live
    // filter silently failed to appear in the backtest — the exact divergence
    // the RSI-on-closed-bars note warns about, one function further down.
    for (let i = CFG.regimeLen; i < spy.length; i++) {
      regimeByDay[dayKey(spy[i].time)] = regimeOf(spy.slice(0, i + 1));
    }
  }

  const all = [];
  let skipped = 0;
  for (const sym of UNIVERSE) {
    const b = bars[sym];
    if (!b || b.length < WARMUP + 30) { skipped++; continue; }
    all.push(...simulate(sym, b, regimeByDay));
  }
  if (skipped) console.log(`(${skipped} symbols skipped for insufficient history)`);

  // Peak concurrency — how much the live MAX_POSITIONS cap would have bitten.
  const days = {};
  for (const t of all) {
    for (let d = new Date(t.entryDay); dayKey(d) <= t.exitDay; d.setDate(d.getDate() + 1))
      days[dayKey(d)] = (days[dayKey(d)] || 0) + 1;
  }
  const peak = Math.max(0, ...Object.values(days));
  const avgConc = Object.values(days).length
    ? Object.values(days).reduce((a, b) => a + b, 0) / Object.values(days).length : 0;

  all.sort((a, b) => a.exitDay.localeCompare(b.exitDay));
  report(all);
  console.log(`\nConcurrency: avg ${avgConc.toFixed(1)}, peak ${peak} simultaneous positions.`);
  console.log(`Live caps are SWING_MAX_POSITIONS=${process.env.SWING_MAX_POSITIONS || 5} / sector ${process.env.SWING_MAX_PER_SECTOR || 2}` +
              (peak > (parseInt(process.env.SWING_MAX_POSITIONS || "5", 10)) ? " — the cap WOULD have dropped trades this backtest counted." : "."));
}

main().catch((e) => {
  console.error("swing-bt error:", e.message);
  process.exitCode = 1;
});
