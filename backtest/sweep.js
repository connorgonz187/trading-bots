/**
 * Parameter sweep of the mean-reversion strategy across a grid, ranked by NET
 * return. Uses cached data (one fetch). Usage: node sweep.js [tf] [days]
 */
import { loadCandles, runBacktest } from "./engine.js";
import { loadStockCandles } from "./alpaca-data.js";
import { make } from "./strategies/meanrev.js";

const tf = process.argv[2] || "1H";
const days = Number(process.argv[3] || "120");
const symbol = process.env.SYMBOL || "SPY";
// Same routing rule as bt.js: dashless symbols are stocks (Alpaca, ~free),
// dashed ones are pairs (Coinbase public candles, legacy).
const isStock = !symbol.includes("-");
const feePct = Number(
  process.env.BACKTEST_FEE_PCT || (isStock ? "0.02" : "0.6"),
);

const RSI = [15, 20, 25, 30];
const SL = [0.3, 0.6, 1.0];
const TP = [0.6, 1.2, 2.0];
const DIST = [1.0, 2.0, 5.0];

const candles = isStock
  ? await loadStockCandles(symbol, tf, days)
  : await loadCandles(symbol, tf, days);
const span = (candles[candles.length - 1].time - candles[0].time) / 86400000;
console.log(
  `\nSweep meanrev — ${symbol} ${tf}, ${candles.length} candles (~${span.toFixed(0)}d), fee ${feePct}%/side\n`,
);

const rows = [];
for (const rsiEntry of RSI)
  for (const slPct of SL)
    for (const tpPct of TP)
      for (const maxDist of DIST) {
        const strat = make({ rsiEntry, slPct, tpPct, maxDist });
        const m = runBacktest(candles, strat, { feePct });
        if (m.trades >= 5) rows.push({ rsiEntry, slPct, tpPct, maxDist, ...m });
      }

rows.sort((a, b) => b.netTotalPct - a.netTotalPct);
console.log("Top 12 by NET return:");
console.log("rsi  sl   tp   dist | trades win%  NET%   gross% PF");
for (const r of rows.slice(0, 12)) {
  console.log(
    `${String(r.rsiEntry).padEnd(4)} ${String(r.slPct).padEnd(4)} ${String(r.tpPct).padEnd(4)} ${String(r.maxDist).padEnd(4)} | ` +
      `${String(r.trades).padEnd(6)} ${(r.winRate * 100).toFixed(0).padEnd(5)} ${r.netTotalPct.toFixed(1).padEnd(6)} ${r.grossTotalPct.toFixed(1).padEnd(6)} ${r.profitFactor.toFixed(2)}`,
  );
}
const best = rows[0];
console.log(
  best && best.netTotalPct > 0
    ? `\nBest net config is positive — but verify out-of-sample before trusting.`
    : `\nNo positive-net config found — the mean-reversion entry has no edge that survives fees.`,
);
