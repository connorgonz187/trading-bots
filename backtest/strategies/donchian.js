/**
 * Donchian / Turtle breakout momentum (long-only spot). BUY STRENGTH, not dips.
 *
 * Hypothesis: enter when price closes above the highest high of the prior N bars
 * (a fresh N-bar breakout). Ride the move; exit when price closes below the
 * lowest low of the prior M bars (M < N) OR an ATR-based trailing/initial stop
 * is hit. No fixed take-profit — let breakouts run.
 *
 * Designed to trade INFREQUENTLY (tens of trades/yr) and capture moves far
 * larger than the 1.2% round-trip fee.
 *
 * Channels are computed over the bars BEFORE the current one, so a breakout is a
 * real new high vs. recent history (the current close is not part of its own
 * channel). All knobs are env-overridable for sweeping without code edits:
 *   DON_N      entry channel length (highest-high lookback)   default 55
 *   DON_M      exit channel length  (lowest-low lookback)     default 20
 *   DON_ATR    ATR period                                     default 20
 *   DON_ATRX   initial stop = entry - ATRX*ATR                default 4
 *   DON_TRAIL  1 = trail the ATR stop up on new highs, 0 = fixed  default 0
 */

const N = parseInt(process.env.DON_N || "55", 10); // entry channel
const M = parseInt(process.env.DON_M || "20", 10); // exit channel
const ATR_P = parseInt(process.env.DON_ATR || "20", 10);
const ATR_X = parseFloat(process.env.DON_ATRX || "3");
const TRAIL = (process.env.DON_TRAIL || "0") === "1";

export const name = `donchian N${N} M${M} atr${ATR_X}x${TRAIL ? " trail" : ""}`;
// Need N prior bars for the entry channel plus a margin for ATR/Wilder warmup.
export const warmup = Math.max(N, M, ATR_P) + 5;

// Highest high over the `len` bars ending at index `endExclusive-1` (i.e. the
// bars strictly BEFORE endExclusive). Returns -Infinity if not enough data.
function highestHigh(c, endExclusive, len) {
  const start = endExclusive - len;
  if (start < 0) return -Infinity;
  let h = -Infinity;
  for (let i = start; i < endExclusive; i++) if (c[i].high > h) h = c[i].high;
  return h;
}

function lowestLow(c, endExclusive, len) {
  const start = endExclusive - len;
  if (start < 0) return Infinity;
  let l = Infinity;
  for (let i = start; i < endExclusive; i++) if (c[i].low < l) l = c[i].low;
  return l;
}

// Wilder ATR over the candle window (uses the last ATR_P true ranges).
function calcATR(c, period = ATR_P) {
  if (c.length < period + 1) return null;
  // Seed with simple average of the first `period` TRs, then Wilder-smooth.
  const tr = (i) => {
    const h = c[i].high,
      l = c[i].low,
      pc = c[i - 1].close;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  };
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr(i);
  atr /= period;
  for (let i = period + 1; i < c.length; i++) {
    atr = (atr * (period - 1) + tr(i)) / period;
  }
  return atr;
}

export function shouldEnter(window) {
  const n = window.length;
  if (n < warmup) return false;
  const last = window[n - 1];
  // Highest high of the N bars BEFORE the current bar.
  const channelHigh = highestHigh(window, n - 1, N);
  if (!isFinite(channelHigh)) return false;
  return last.close > channelHigh;
}

export function exitLevels(entryPrice) {
  // Initial ATR stop is set in shouldEnter-time context, but exitLevels only
  // gets entryPrice. We can't see ATR here, so we recompute a conservative
  // percentage-equivalent is wrong; instead we return null and let shouldExit
  // own the exit via the M-bar Donchian + ATR stop computed from the window.
  return null;
}

export function shouldExit(window, position) {
  const n = window.length;
  const last = window[n - 1];

  // ATR stop. Compute ATR on bars up to (not including) the current bar so it's
  // a closed-bar value, consistent with entry.
  const closed = window.slice(0, n - 1);
  const atr = calcATR(closed, ATR_P);

  // Stash the highest close-to-date and a stop on the position object (the
  // engine reuses the same position object across bars).
  if (position._stop == null && atr != null) {
    position._stop = position.entryPrice - ATR_X * atr;
    position._peak = position.entryPrice;
  }
  if (TRAIL && atr != null) {
    if (last.high > (position._peak ?? 0)) position._peak = last.high;
    const trailStop = position._peak - ATR_X * atr;
    if (trailStop > (position._stop ?? -Infinity)) position._stop = trailStop;
  }

  // ATR stop hit on close.
  if (position._stop != null && last.close <= position._stop) return true;

  // Donchian exit: close below the lowest low of the prior M bars.
  const channelLow = lowestLow(window, n - 1, M);
  if (isFinite(channelLow) && last.close < channelLow) return true;

  return false;
}
