/**
 * trend-plus — a more robust 1D long-only trend follower.
 *
 * CHOSEN DESIGN (defaults below), built on the trend-ma edge (hold the trend,
 * sit out chop) but hardened:
 *   1) ENTRY: EMA(20) > EMA(50) crossover, AND a REGIME FILTER — the last CLOSED
 *      price must be above SMA(100). The regime gate is the single biggest
 *      robustness win: it keeps us flat in bear markets where bare EMA crosses
 *      generate losing whipsaws. The faster 20/50 pair (vs trend-ma's 30/100)
 *      enters trends earlier and re-engages after corrections; SMA(100) — not the
 *      slower SMA(200) — is used because 200 is so laggy it gates out the early
 *      part of post-crash recoveries.
 *   2) EXIT: EMA(20) < EMA(50) cross-down (patient — let winners run). Tighter
 *      trailing exits (Donchian-20 low / close<EMA50) were tested and selectable
 *      via TP_EXIT, but on the 1D they whipsaw out of good trends and lose to the
 *      patient cross-down after fees.
 *   3) DISASTER STOP: a wide ATR(14) stop at entry - 4*ATR. It rarely fires, but
 *      in the choppy/bear windows it measurably softens the worst losers without
 *      clipping the big winners. It is insurance, not a profit-taking mechanism.
 *
 * All signals use CLOSED candles only (drop the still-forming last bar) so they
 * don't flicker intrabar. Every knob is env-overridable for sweeping; the
 * defaults are the chosen params (TP_FAST=20 TP_SLOW=50 TP_REGIME=100
 * TP_EXIT=cross TP_ATR_MULT=4).
 */
import { calcEMA } from "../strategy.js";

const FAST = parseInt(process.env.TP_FAST || "20", 10);
const SLOW = parseInt(process.env.TP_SLOW || "50", 10);
const REGIME = parseInt(process.env.TP_REGIME || "100", 10); // SMA regime period
const DON = parseInt(process.env.TP_DON || "20", 10); // Donchian low lookback (exit variants)
const ATR_N = parseInt(process.env.TP_ATR || "14", 10);
const ATR_MULT = parseFloat(process.env.TP_ATR_MULT || "4"); // disaster stop width (×ATR)

export const name = `trend-plus EMA${FAST}/${SLOW} +SMA${REGIME} regime +ATR${ATR_MULT}stop`;
// warmup must cover the longest lookback (SMA regime). Engine allows up to 300 bars.
export const warmup = REGIME + 30;

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Wilder-ish ATR over the last ATR_N closed bars.
function atr(closed, period) {
  if (closed.length < period + 1) return null;
  let sum = 0;
  for (let i = closed.length - period; i < closed.length; i++) {
    const cur = closed[i];
    const prevClose = closed[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose),
    );
    sum += tr;
  }
  return sum / period;
}

// Closed candles (drop the forming last bar).
function closedBars(window) {
  return window.slice(0, -1);
}

function trendUp(closes) {
  if (closes.length < SLOW + 1) return false;
  return calcEMA(closes, FAST) > calcEMA(closes, SLOW);
}

function regimeOk(closes) {
  const s = sma(closes, REGIME);
  if (s == null) return false;
  return closes[closes.length - 1] > s;
}

// ATR captured at the moment of entry so exitLevels() (called immediately after
// shouldEnter() on the same bar) can place a wide ATR disaster stop. The engine
// fills this stop intrabar via the bar low, capping catastrophic gaps.
let lastEntryAtr = null;

export function shouldEnter(window) {
  const bars = closedBars(window);
  const closes = bars.map((c) => c.close);
  if (closes.length < REGIME + 1) return false;
  const ok = trendUp(closes) && regimeOk(closes);
  if (ok) lastEntryAtr = atr(bars, ATR_N);
  return ok;
}

// Wide ATR disaster stop only; no take-profit (let winners run). Falls back to
// no stop if ATR is unavailable.
export function exitLevels(entryPrice) {
  if (lastEntryAtr == null || !(ATR_MULT > 0)) return null;
  return { stopLoss: entryPrice - ATR_MULT * lastEntryAtr, takeProfit: null };
}

// Exit mode is env-selectable for sweeping:
//   "cross"   : exit on EMA(FAST) < EMA(SLOW)  (slow, patient — like trend-ma)
//   "don"     : exit on close < Donchian-DON low
//   "ema"     : exit on close < EMA(SLOW)
//   "cross+don": exit on either a cross-down OR a Donchian break (whichever first)
const EXIT = process.env.TP_EXIT || "cross";

// Trailing exit folded into shouldExit using the window each bar.
export function shouldExit(window) {
  const bars = closedBars(window);
  const closes = bars.map((c) => c.close);
  if (closes.length < SLOW + 1) return false;

  const lastClose = closes[closes.length - 1];
  const crossDown = calcEMA(closes, FAST) < calcEMA(closes, SLOW);

  // Donchian-DON low: lowest low of the prior DON closed bars (excluding current).
  const prior = bars.slice(bars.length - 1 - DON, bars.length - 1);
  const donLow = prior.length ? Math.min(...prior.map((c) => c.low)) : -Infinity;
  const donBreak = lastClose < donLow;
  const emaBreak = lastClose < calcEMA(closes, SLOW);

  switch (EXIT) {
    case "cross":
      return crossDown;
    case "don":
      return donBreak;
    case "ema":
      return emaBreak;
    case "cross+don":
    default:
      return crossDown || donBreak;
  }
}
