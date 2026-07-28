/**
 * The current bot strategy as a pluggable module: mean-reversion —
 * buy an RSI(3) dip inside a VWAP/EMA uptrend; exit on stop/target or bearish flip.
 *
 * `make(params)` builds a parameterised variant so sweep.js can tune it.
 * Note: VWAP is intraday (resets at UTC midnight), so this only makes sense on
 * intraday timeframes (1m–1H); on 6H/1D the "session" is ~1 candle and degenerate.
 */
import { computeIndicators, biasOf } from "../strategy.js";

export function make(params = {}) {
  const { rsiEntry = 30, slPct = 0.3, tpPct = 0.6, maxDist = 1.5 } = params;
  return {
    name: `meanrev rsi<${rsiEntry} sl${slPct} tp${tpPct} d${maxDist}`,
    warmup: 60,
    shouldEnter(window) {
      const { price, ema8, vwap, rsi3 } = computeIndicators(window);
      if (vwap == null || rsi3 == null) return false;
      if (biasOf(price, ema8, vwap) !== "bullish") return false;
      const dist = Math.abs((price - vwap) / vwap) * 100;
      return rsi3 < rsiEntry && dist < maxDist;
    },
    exitLevels(entry) {
      return {
        stopLoss: entry * (1 - slPct / 100),
        takeProfit: entry * (1 + tpPct / 100),
      };
    },
    shouldExit(window) {
      const { price, ema8, vwap } = computeIndicators(window);
      if (vwap == null) return false;
      return biasOf(price, ema8, vwap) === "bearish";
    },
  };
}

// Default export = the live config, so `node bt.js strategies/meanrev.js` works.
const def = make();
export const name = def.name;
export const warmup = def.warmup;
export const shouldEnter = def.shouldEnter;
export const exitLevels = def.exitLevels;
export const shouldExit = def.shouldExit;
