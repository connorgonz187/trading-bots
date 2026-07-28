/**
 * Trend-following moving-average crossover (long-only spot).
 *
 * HYPOTHESIS: in a trending market you make money by holding the trend and
 * sitting out chop. Go long when a fast EMA is above a slow EMA; stay long
 * until the fast EMA crosses back below the slow EMA. No take-profit (let
 * winners run), no tight stop (the trend-flip IS the exit). This yields FEW
 * trades (single digits/year on 1D) with the occasional very large winner —
 * the only way to beat a 1.2% round-trip fee.
 *
 * Signals are computed on CLOSED candles (the still-forming last bar is
 * excluded) so they don't flicker intrabar.
 *
 * IMPORTANT: the engine passes a window capped at 160 bars (LOOKBACK), so the
 * slow EMA must stay well under that. EMA30/100 fits with room to seed.
 *
 * Tunable via env so the runner can sweep without edits:
 *   MA_FAST (default 30), MA_SLOW (default 100)
 *
 * RESULT (BTC-USD, 0.6%/side): genuinely robust on 1D (NET +117%, PF ~6,
 * positive in both halves of history); marginally positive on 6H (NET +8%,
 * PF 1.36, but the edge sits in the first half and is roughly break-even
 * recently). Lower timeframes (1H) get chopped to death — trend following
 * needs the higher timeframe. Treat 1D as the real edge.
 */
import { calcEMA } from "../strategy.js";

const FAST = parseInt(process.env.MA_FAST || "30", 10);
const SLOW = parseInt(process.env.MA_SLOW || "100", 10);

export const name = `trend-ma EMA${FAST}/${SLOW}`;
// Seed the slow EMA with a healthy run-up; engine caps the window at 160 anyway.
export const warmup = Math.min(SLOW + 50, 155);

// Trend up = fast EMA above slow EMA, on CLOSED candles only.
function trendUp(window) {
  const closes = window.map((c) => c.close).slice(0, -1); // drop forming bar
  if (closes.length < SLOW + 1) return false;
  return calcEMA(closes, FAST) > calcEMA(closes, SLOW);
}

export function shouldEnter(window) {
  return trendUp(window);
}

// No bracket: let winners run, exit purely on the trend flip below.
export function exitLevels() {
  return null;
}

// Exit when the fast EMA crosses back below the slow EMA.
export function shouldExit(window) {
  return !trendUp(window);
}
