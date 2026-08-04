/**
 * Bot E universe builder. Runs pre-market; writes swing-watchlist.csv.
 * It chooses WHAT to watch. It does not trade.
 *
 * This is deliberately NOT the ORB scanner. `scan.js` hunts the day's biggest
 * movers (range ≥3%, top gainers/losers) because an intraday breakout needs
 * violence to clear costs inside one session. A swing entry with a 2% stop
 * needs the opposite: names quiet enough that 2% is outside the daily noise but
 * liquid enough to fill without paying the stop back in spread.
 *
 * So the universe is a fixed core of liquid, institutionally-traded names, plus
 * whatever the most-actives screener turns up, and EVERY candidate must clear
 * `passesUniverseGate()` in swing-strategy.js — the same gate the backtest
 * applies, so the forward test and the backtest see the same universe rules.
 *
 *   node swing-scan.js            # write today's watchlist
 *   node swing-scan.js --explain  # also print why each name was rejected
 */
import "dotenv/config";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { getClock, mostActives, dailyBarsMulti } from "./alpaca.js";
import { CFG, WARMUP, passesUniverseGate, indicators } from "./swing-strategy.js";

const FILE = process.env.SWING_WATCHLIST || "swing-watchlist.csv";
const TOP = parseInt(process.env.SWING_TOP || "25", 10);
const EXPLAIN = process.argv.includes("--explain");

// Core universe: large, liquid, continuously traded. Kept as a literal (not a
// screener result) so the backtest and the live bot can run over an identical
// symbol set — a universe that drifts daily makes the two incomparable.
const CORE = (process.env.SWING_UNIVERSE ||
  [
    // mega/large-cap tech
    "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "AVGO", "AMD", "CRM", "ADBE",
    "ORCL", "CSCO", "QCOM", "TXN", "INTC", "MU", "AMAT", "LRCX", "NOW", "PANW",
    // financials
    "JPM", "BAC", "WFC", "GS", "MS", "C", "SCHW", "BLK", "AXP", "V", "MA",
    // health / staples / industrials
    "UNH", "JNJ", "LLY", "ABBV", "MRK", "PFE", "TMO", "ABT", "CAT", "DE",
    "HON", "GE", "BA", "UNP", "LMT", "RTX",
    // consumer / energy / other
    "WMT", "COST", "HD", "LOW", "MCD", "NKE", "SBUX", "PG", "KO", "PEP",
    "XOM", "CVX", "COP", "SLB", "DIS", "NFLX", "TSLA", "UBER", "LIN", "T",
    // broad ETFs — the calmest things that still trend
    "SPY", "QQQ", "IWM", "DIA", "XLK", "XLF", "XLE", "XLV", "XLI", "SMH",
  ].join(",")
)
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

// Cold-wake network gate — see the note in bot b/scan.js. Bot E's scanner needs
// this too: most-actives is already optional here, but dailyBarsMulti is not, so
// a network that is not up yet still kills the run (it did on 2026-08-04).
const NET_WAIT_MS = Number(process.env.SCAN_NET_WAIT_MS || 8 * 60 * 1000);
const NET_PROBE_MS = Number(process.env.SCAN_NET_PROBE_MS || 10 * 1000);

async function waitForNetwork() {
  const deadline = Date.now() + NET_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      await getClock();
      if (attempt > 1) console.log(`  network up after ${attempt} probes.`);
      return;
    } catch (e) {
      if (Date.now() + NET_PROBE_MS >= deadline) {
        throw new Error(
          `network still down after ${Math.round(NET_WAIT_MS / 1000)}s: ${e.message}`,
        );
      }
      console.log(`  waiting for network (probe ${attempt}: ${e.message})`);
      await new Promise((r) => setTimeout(r, NET_PROBE_MS));
    }
  }
}

async function main() {
  await waitForNetwork();
  const cand = new Set(CORE);
  // Most-actives is additive only: it can introduce a liquid name the core list
  // missed, but it cannot bypass the gate.
  if (!/^(0|false|no|off)$/i.test(process.env.SWING_INCLUDE_ACTIVES || "true")) {
    try {
      const ma = await mostActives(40);
      for (const x of ma.most_actives || []) cand.add(x.symbol);
    } catch (e) {
      console.log(`  most-actives unavailable (${e.message}) — core universe only.`);
    }
  }

  const syms = [...cand];
  // Enough calendar days to leave WARMUP *trading* days after weekends/holidays.
  const startISO = new Date(Date.now() - (WARMUP + 40) * 86400e3).toISOString();
  const bars = await dailyBarsMulti(syms, startISO);

  const passed = [];
  const rejected = [];
  for (const sym of syms) {
    const b = bars[sym];
    if (!b || b.length < WARMUP) {
      rejected.push([sym, `only ${b ? b.length : 0} daily bars (need ${WARMUP})`]);
      continue;
    }
    const gate = passesUniverseGate(b);
    if (!gate.ok) {
      rejected.push([sym, gate.why]);
      continue;
    }
    const i = gate.ind;
    passed.push({
      sym,
      price: i.price,
      atrPct: i.atrPct * 100,
      dollarVolM: i.dollarVol / 1e6,
      // How much stop-room the 2% stop actually buys, in units of daily noise.
      // Higher is safer; the gate floor is SWING_MIN_STOP_ATR.
      stopAtr: CFG.stopPct / i.atrPct,
      trend: i.fast > i.slow ? "up" : "down",
    });
  }

  // Prefer the names where the stop sits furthest outside the noise — that is
  // the whole thesis of this bot, so it is the right ranking key.
  passed.sort((a, b) => b.stopAtr - a.stopAtr);
  const final = passed.slice(0, TOP);

  // Rewriting today's rows rather than appending makes a re-run idempotent. A
  // blind append doubles the day's rows whenever the scan runs twice (a manual
  // run, or a task firing after a missed schedule), which reads as a 48-name
  // universe when the scan actually chose 24. Prior dates are left untouched.
  const HEADER = "Date,Symbol,Price,ATR%,AvgDollarVolM,StopATRs,Trend\n";
  const prior = existsSync(FILE)
    ? readFileSync(FILE, "utf8")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .slice(1)
        .filter((l) => l.trim() && !l.startsWith(`${etDate},`))
    : [];
  const rows = final.map(
    (r) =>
      `${etDate},${r.sym},${r.price.toFixed(2)},${r.atrPct.toFixed(2)},${r.dollarVolM.toFixed(0)},${r.stopAtr.toFixed(2)},${r.trend}`,
  );
  writeFileSync(FILE, HEADER + [...prior, ...rows].join("\n") + "\n");

  console.log(
    `\nSwing watchlist ${etDate}: ${final.length} of ${syms.length} candidates passed -> ${FILE}`,
  );
  console.log(
    `  gate: price $${CFG.minPrice}-${CFG.maxPrice}, avg $vol ≥$${(CFG.minDollarVol / 1e6).toFixed(0)}M, ` +
      `ATR ≤ ${((CFG.stopPct / CFG.minStopAtr) * 100).toFixed(2)}% (stop ${(CFG.stopPct * 100).toFixed(1)}% ≥ ${CFG.minStopAtr}×ATR)\n`,
  );
  for (const r of final)
    console.log(
      `  ${r.sym.padEnd(6)} $${r.price.toFixed(2).padStart(8)}  ATR ${r.atrPct.toFixed(2).padStart(5)}%  ` +
        `stop=${r.stopAtr.toFixed(2)}xATR  $vol ${r.dollarVolM.toFixed(0)}M  ${r.trend}`,
    );

  if (!final.length)
    console.log(
      "  Nothing passed. That is a real signal, not a bug: if no liquid name is\n" +
        "  quiet enough for the configured stop, the stop is too tight for this tape.\n" +
        "  Widen SWING_STOP_PCT or lower SWING_MIN_STOP_ATR — deliberately, not reflexively.",
    );

  if (EXPLAIN && rejected.length) {
    console.log(`\nRejected (${rejected.length}):`);
    for (const [s, why] of rejected) console.log(`  ${s.padEnd(6)} ${why}`);
  }
}

main().catch((e) => {
  console.error("swing-scan error:", e.message);
  process.exitCode = 1;
});
