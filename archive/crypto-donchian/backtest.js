/**
 * Backtester — replays the SAME strategy the bot trades (imported from
 * strategy.js) over historical Coinbase candles and reports the results.
 *
 * Usage:
 *   node backtest.js                # default: 90 days, timeframe from .env
 *   node backtest.js 180            # 180 days
 *   node backtest.js 180 BTC-USD 1H # days, symbol, timeframe
 *
 * Honesty notes:
 *  - Stops/targets are filled INTRABAR using each candle's high/low (a resting
 *    stop fills when price trades through it, not only at the close).
 *  - Results are shown GROSS (raw edge) and NET (after fees), because for a
 *    small-target scalp, fees usually decide whether there's any edge at all.
 *  - Past performance != future results. This is a sanity check, not a promise.
 */

import "dotenv/config";
import {
  computeIndicators,
  biasOf,
  entrySignal,
  calcExitLevels,
} from "./strategy.js";

const GRANULARITY = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1H": 3600,
  "6H": 21600,
  "1D": 86400,
};

const days = parseFloat(process.argv[2] || "90");
const SYMBOL = process.argv[3] || process.env.SYMBOL || "BTC-USD";
const TF = process.argv[4] || process.env.TIMEFRAME || "1H";
const gran = GRANULARITY[TF] || 3600;

const NOTIONAL = 100; // fixed $ per trade, so results read as a clean per-trade edge
const FEE_PCT = parseFloat(process.env.BACKTEST_FEE_PCT || "0.6"); // Coinbase Advanced taker ~0.6% (conservative)
const WINDOW = 300; // candles per evaluation (mirrors what the live bot fetches)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHistory(product, granSec, candlesNeeded) {
  const all = new Map();
  let end = Math.floor(Date.now() / 1000);
  let guard = 0;
  while (all.size < candlesNeeded && guard < 200) {
    guard++;
    const start = end - WINDOW * granSec;
    const url =
      `https://api.exchange.coinbase.com/products/${product}/candles` +
      `?granularity=${granSec}` +
      `&start=${new Date(start * 1000).toISOString()}` +
      `&end=${new Date(end * 1000).toISOString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "backtest" } });
    if (!res.ok) throw new Error(`Coinbase ${res.status}: ${await res.text()}`);
    const batch = await res.json(); // newest-first [t, low, high, open, close, vol]
    if (!batch.length) break;
    for (const k of batch) all.set(k[0], k);
    end = start;
    await sleep(250); // be gentle with the public rate limit
  }
  return [...all.values()]
    .sort((a, b) => a[0] - b[0])
    .map((k) => ({
      time: k[0] * 1000,
      low: k[1],
      high: k[2],
      open: k[3],
      close: k[4],
      volume: k[5],
    }));
}

function pct(n) {
  return `${(n * 100).toFixed(2)}%`;
}

async function main() {
  const candlesNeeded = Math.ceil((days * 86400) / gran) + WINDOW;
  console.log(
    `\nBacktest: ${SYMBOL} ${TF}, ~${days} days (fee ${FEE_PCT}%/side, $${NOTIONAL}/trade)\nFetching history...`,
  );
  const candles = await fetchHistory(SYMBOL, gran, candlesNeeded);
  if (candles.length < WINDOW + 10) {
    console.log(`Not enough data (${candles.length} candles). Try fewer days.`);
    return;
  }
  const from = new Date(candles[0].time).toISOString().slice(0, 10);
  const to = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);
  console.log(`Got ${candles.length} candles (${from} → ${to}). Simulating...\n`);

  let position = null;
  const trades = [];
  const feeFrac = FEE_PCT / 100;

  for (let i = WINDOW; i < candles.length; i++) {
    const window = candles.slice(i - WINDOW + 1, i + 1);
    const { price, ema8, vwap, rsi3 } = computeIndicators(window);
    if (vwap == null || rsi3 == null) continue;
    const bias = biasOf(price, ema8, vwap);
    const c = candles[i];

    if (position) {
      // Intrabar exit: stop/target fill when price trades through them; a bias
      // flip is judged on the close.
      let reason = null;
      let fill = null;
      if (c.low <= position.stopLoss) {
        reason = "stop-loss";
        fill = position.stopLoss;
      } else if (c.high >= position.takeProfit) {
        reason = "take-profit";
        fill = position.takeProfit;
      } else if (bias === "bearish") {
        reason = "bias-flip";
        fill = price;
      }
      if (reason) {
        const grossPct = (fill - position.entryPrice) / position.entryPrice;
        const netPct = grossPct - 2 * feeFrac;
        trades.push({
          entry: position.entryPrice,
          exit: fill,
          grossPct,
          netPct,
          reason,
          bars: i - position.entryIdx,
        });
        position = null;
      }
    } else if (entrySignal(price, ema8, vwap, rsi3)) {
      const { stopLoss, takeProfit } = calcExitLevels("long", price);
      position = { entryPrice: price, stopLoss, takeProfit, entryIdx: i };
    }
  }

  if (!trades.length) {
    console.log(
      "No trades triggered in this period. The entry (RSI(3)<30 in an uptrend) is rare — try more days or a lower timeframe.\n",
    );
    return;
  }

  // ── Metrics ──
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const grossTotal = sum(trades.map((t) => t.grossPct));
  const netTotal = sum(trades.map((t) => t.netPct));
  const grossWin = sum(wins.map((t) => t.netPct));
  const grossLoss = -sum(losses.map((t) => t.netPct));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  // Max drawdown on the running net $ curve (fixed notional per trade).
  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.netPct * NOTIONAL;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }

  const byReason = trades.reduce((m, t) => {
    m[t.reason] = (m[t.reason] || 0) + 1;
    return m;
  }, {});
  const avgBars = sum(trades.map((t) => t.bars)) / trades.length;

  const line = "─".repeat(56);
  console.log(line);
  console.log(`  RESULTS — ${SYMBOL} ${TF}, ${from} → ${to}`);
  console.log(line);
  console.log(`  Trades              : ${trades.length}`);
  console.log(
    `  Win rate (net)      : ${pct(wins.length / trades.length)} (${wins.length}W / ${losses.length}L)`,
  );
  console.log(`  Net total return    : ${pct(netTotal)}  ($${(netTotal * NOTIONAL).toFixed(2)} on $${NOTIONAL}/trade)`);
  console.log(`  Gross (no fees)     : ${pct(grossTotal)}  ← raw edge before costs`);
  console.log(`  Fee drag            : ${pct(grossTotal - netTotal)}  (${FEE_PCT}% x2 x ${trades.length})`);
  console.log(
    `  Avg win / avg loss  : ${wins.length ? pct(grossWin / wins.length) : "—"} / ${losses.length ? pct(-grossLoss / losses.length) : "—"}`,
  );
  console.log(`  Profit factor (net) : ${profitFactor.toFixed(2)}`);
  console.log(`  Max drawdown        : $${maxDD.toFixed(2)}`);
  console.log(`  Avg hold            : ${avgBars.toFixed(1)} bars`);
  console.log(
    `  Exit reasons        : ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  );
  console.log(line);
  const verdict =
    netTotal > 0 && profitFactor > 1.2
      ? "Positive net edge in this window — still validate on other periods before trusting it."
      : "No reliable net edge here — fees and/or the entry are eating the strategy.";
  console.log(`  ${verdict}`);
  console.log(line + "\n");
}

main().catch((e) => {
  console.error("Backtest error:", e.message);
  process.exitCode = 1;
});
