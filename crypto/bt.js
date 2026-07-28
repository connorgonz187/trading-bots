/**
 * Run one strategy module against cached/historical data.
 *   node bt.js strategies/meanrev.js 1H 120
 *   node bt.js strategies/myidea.js 6H 365
 *   node bt.js strategies/myidea.js 1D 365 365   # out-of-sample: 365d ending 365d ago
 *
 * args: <strategyFile> <timeframe> <days> [skipRecentDays]
 *   skipRecentDays lets you backtest an earlier window for out-of-sample checks.
 */
import { loadCandles, runBacktest } from "./engine.js";
import { loadStockCandles } from "./alpaca-data.js";

const stratFile = process.argv[2] || "strategies/meanrev.js";
const tf = process.argv[3] || process.env.TIMEFRAME || "1H";
const days = Number(process.argv[4] || "120");
const skipRecent = Number(process.argv[5] || "0");
const symbol = process.env.SYMBOL || "BTC-USD";
// Stocks (e.g. SPY) have no dash; crypto pairs do (BTC-USD). Stocks are
// commission-free, so default the backtest fee to ~0 (just slippage).
const isStock = !symbol.includes("-");
const feePct = Number(
  process.env.BACKTEST_FEE_PCT || (isStock ? "0.02" : "0.6"),
);

const mod = await import("./" + stratFile.replace(/^\.?\//, ""));
const strat = mod.default || mod;
let candles = isStock
  ? await loadStockCandles(symbol, tf, days + skipRecent)
  : await loadCandles(symbol, tf, days + skipRecent);
// Slice to the requested window [end-days, end], where end is skipRecent days ago.
const msDay = 86400000;
const endTime = candles[candles.length - 1].time - skipRecent * msDay;
const startTime = endTime - days * msDay;
candles = candles.filter((c) => c.time >= startTime && c.time <= endTime);
const span =
  (candles[candles.length - 1].time - candles[0].time) / 86400000;
const m = runBacktest(candles, strat, { feePct });

console.log(`\n${strat.name || stratFile}`);
console.log(`${symbol} ${tf}, ${candles.length} candles (~${span.toFixed(0)}d), fee ${feePct}%/side`);
console.log(
  `trades=${m.trades} win=${(m.winRate * 100).toFixed(1)}% ` +
    `NET=${m.netTotalPct.toFixed(1)}% gross=${m.grossTotalPct.toFixed(1)}% ` +
    `PF=${m.profitFactor.toFixed(2)} maxDD=$${m.maxDD.toFixed(2)} avgBars=${m.avgBars.toFixed(1)}`,
);
