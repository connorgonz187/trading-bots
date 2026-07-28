/**
 * Backtest engine + data cache. Shared by bt.js, sweep.js, and strategy agents.
 *
 * A "strategy" is a plain object/module with this interface (long-only spot):
 *   name        : string
 *   warmup      : number  (min bars before it may trade)
 *   shouldEnter(window) -> boolean        // decided on the close of window's last bar
 *   exitLevels(entryPrice) -> { stopLoss, takeProfit } | null   // optional bracket
 *   shouldExit(window, position) -> boolean   // extra close rule, on bar close
 *
 * `window` is the candle history up to and including the current bar (most recent
 * last). Strategies should only look at the END of the window.
 */

import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export const GRAN = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1H": 3600,
  "6H": 21600,
  "1D": 86400,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOOKBACK = 300; // candles passed to a strategy each bar (enough for SMA200 + buffer)

export async function fetchHistory(symbol, tf, days) {
  const gran = GRAN[tf] || 3600;
  const need = Math.ceil((days * 86400) / gran) + 350;
  const all = new Map();
  let end = Math.floor(Date.now() / 1000);
  let guard = 0;
  while (all.size < need && guard++ < 400) {
    const start = end - 300 * gran;
    const url =
      `https://api.exchange.coinbase.com/products/${symbol}/candles` +
      `?granularity=${gran}&start=${new Date(start * 1000).toISOString()}` +
      `&end=${new Date(end * 1000).toISOString()}`;
    const res = await fetch(url, { headers: { "User-Agent": "bt" } });
    if (!res.ok) throw new Error(`Coinbase ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    if (!batch.length) break;
    for (const k of batch) all.set(k[0], k);
    end = start;
    await sleep(220);
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

// Load candles from data/ cache if it covers `days`, else fetch + cache.
export async function loadCandles(symbol, tf, days) {
  if (!existsSync("data")) mkdirSync("data");
  const f = `data/${symbol}-${tf}.json`;
  if (existsSync(f)) {
    const c = JSON.parse(readFileSync(f, "utf8"));
    const span = (c[c.length - 1].time - c[0].time) / 86400000;
    if (span >= days - 1) return c;
  }
  const c = await fetchHistory(symbol, tf, days);
  writeFileSync(f, JSON.stringify(c));
  return c;
}

export function runBacktest(candles, strat, opts = {}) {
  const feeFrac = (opts.feePct ?? 0.6) / 100;
  const notional = opts.notional ?? 100;
  const warmup = Math.max(strat.warmup || 50, 50);
  let position = null;
  const trades = [];

  for (let i = warmup; i < candles.length; i++) {
    const window = candles.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
    const c = candles[i];
    if (position) {
      let reason = null;
      let fill = null;
      if (position.stopLoss != null && c.low <= position.stopLoss) {
        reason = "stop-loss";
        fill = position.stopLoss;
      } else if (position.takeProfit != null && c.high >= position.takeProfit) {
        reason = "take-profit";
        fill = position.takeProfit;
      } else if (strat.shouldExit && strat.shouldExit(window, position)) {
        reason = "signal";
        fill = c.close;
      }
      if (reason) {
        const grossPct = (fill - position.entryPrice) / position.entryPrice;
        trades.push({
          grossPct,
          netPct: grossPct - 2 * feeFrac,
          reason,
          bars: i - position.entryIdx,
        });
        position = null;
      }
    } else if (strat.shouldEnter(window)) {
      const lv = strat.exitLevels ? strat.exitLevels(c.close, window) : null;
      position = {
        entryPrice: c.close,
        stopLoss: lv?.stopLoss ?? null,
        takeProfit: lv?.takeProfit ?? null,
        entryIdx: i,
      };
    }
  }
  return metrics(trades, notional);
}

function metrics(trades, notional) {
  const n = trades.length;
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const wins = trades.filter((t) => t.netPct > 0);
  const losses = trades.filter((t) => t.netPct <= 0);
  const netTotal = sum(trades.map((t) => t.netPct));
  const grossTotal = sum(trades.map((t) => t.grossPct));
  const gWin = sum(wins.map((t) => t.netPct));
  const gLoss = -sum(losses.map((t) => t.netPct));
  let eq = 0,
    peak = 0,
    maxDD = 0;
  for (const t of trades) {
    eq += t.netPct * notional;
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq - peak);
  }
  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    netTotalPct: netTotal * 100,
    grossTotalPct: grossTotal * 100,
    netUSD: netTotal * notional,
    profitFactor: gLoss > 0 ? gWin / gLoss : gWin > 0 ? Infinity : 0,
    maxDD,
    avgBars: n ? sum(trades.map((t) => t.bars)) / n : 0,
  };
}
