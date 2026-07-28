/**
 * Higher-timeframe "buy the dip in a bull market" mean reversion.
 *
 * Hypothesis (distinct from the failed fast RSI(3) scalper on 1H):
 *   On a higher timeframe (1D / 6H), only buy when the LONG-TERM TREND is up
 *   (price > a long SMA) AND a standard RSI(period) is OVERSOLD. Exit when RSI
 *   recovers to neutral/overbought, protected by a wide stop. Few trades/year,
 *   each targeting a move far larger than the 1.2% round-trip fee.
 *
 * IMPORTANT engine constraint: the engine passes only the last LOOKBACK=160
 * candles to the strategy each bar, so a true SMA200 is impossible — the window
 * never holds 200 bars. We use a long SMA that fits (default 100) as the trend
 * filter; warmup is set so the trend SMA is fully formed.
 *
 * Tunables (env-overridable so a sweep needs no code edits):
 *   HTF_RSI_PERIOD   RSI lookback                       (default 14)
 *   HTF_RSI_ENTRY    enter when RSI < this (oversold)   (default 32)
 *   HTF_RSI_EXIT     exit when RSI > this (recovered)   (default 55)
 *   HTF_SMA          long trend SMA length              (default 100)
 *   HTF_STOP_PCT     protective stop width, percent     (default 8)
 *   HTF_TP_PCT       optional take-profit, percent (0=off, default 0)
 */
import { calcRSI } from "../strategy.js";

const P = {
  rsiPeriod: parseInt(process.env.HTF_RSI_PERIOD || "14", 10),
  rsiEntry: parseFloat(process.env.HTF_RSI_ENTRY || "32"),
  rsiExit: parseFloat(process.env.HTF_RSI_EXIT || "60"),
  sma: parseInt(process.env.HTF_SMA || "100", 10),
  stopPct: parseFloat(process.env.HTF_STOP_PCT || "6"),
  tpPct: parseFloat(process.env.HTF_TP_PCT || "0"),
};

function sma(closes, period) {
  if (closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i];
  return s / period;
}

export const name =
  `htf-rsi RSI(${P.rsiPeriod})<${P.rsiEntry} exit>${P.rsiExit} ` +
  `SMA${P.sma} stop${P.stopPct}%` + (P.tpPct > 0 ? ` tp${P.tpPct}%` : "");

// Need the long SMA fully formed (+ a little slack for RSI).
export const warmup = P.sma + P.rsiPeriod + 5;

export function shouldEnter(window) {
  const closes = window.map((c) => c.close);
  const price = closes[closes.length - 1];
  const trend = sma(closes, P.sma);
  const rsi = calcRSI(closes, P.rsiPeriod);
  if (trend == null || rsi == null) return false;
  // Bull-market filter + oversold dip.
  return price > trend && rsi < P.rsiEntry;
}

export function exitLevels(entryPrice) {
  const lv = { stopLoss: entryPrice * (1 - P.stopPct / 100) };
  if (P.tpPct > 0) lv.takeProfit = entryPrice * (1 + P.tpPct / 100);
  return lv;
}

export function shouldExit(window) {
  const closes = window.map((c) => c.close);
  const rsi = calcRSI(closes, P.rsiPeriod);
  if (rsi == null) return false;
  // Exit the dip-buy once momentum has recovered.
  return rsi > P.rsiExit;
}
