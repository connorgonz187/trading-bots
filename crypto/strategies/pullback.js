/**
 * Trend pullback — "buy the dip in an uptrend, ride the trend leg" (long-only spot).
 *
 * HYPOTHESIS: In a sustained uptrend, brief pullbacks to a rising medium MA are
 * low-risk entries. Buy when price dips to the medium EMA and turns back up, then
 * RIDE the trend until it actually breaks — no tight take-profit. The goal is FEW
 * trades that each capture a multi-percent trend leg, the only way to clear a
 * 1.2% round-trip fee.
 *
 * ENGINE CONSTRAINT: the engine passes a window capped at 160 bars (LOOKBACK), so
 * the trend MA must stay well under that. We use EMA100 as the trend filter (not
 * SMA200) — it fits the window and behaves like a slow-trend proxy.
 *
 * RULES
 *   Trend filter (uptrend):  close > EMA(TREND)  AND  EMA(TREND) rising
 *   Pullback:                within the last PB_LOOKBACK closed bars, low touched
 *                            at/below the medium EMA(MED)  (price came back to the MA)
 *   Turn-up trigger:         last close > previous close   (the dip is bouncing)
 *   Not overextended:        close is within MAX_EXT_ATR * ATR above EMA(MED)
 *                            (don't chase a candle that already ran far past the MA)
 *   Not overbought:          RSI(RSI_LEN) < RSI_MAX
 *
 *   EXIT (ride the trend, no take-profit):
 *     - close < EMA(MED)            -> trend leg over, step aside
 *     - close < EMA(TREND)          -> whole uptrend broke
 *     - disaster stop: close <= entry - ATR_MULT * ATR(at entry-scale)
 *
 * Tunable via env so the runner can sweep without edits:
 *   PB_TREND (100)  PB_MED (20)  PB_LOOKBACK (5)
 *   PB_RSI_LEN (14) PB_RSI_MAX (70)  PB_MAX_EXT_ATR (1.5)
 *   PB_ATR_LEN (14) PB_ATR_MULT (3, 0 disables disaster stop)
 */
import { calcEMA, calcRSI } from "../strategy.js";

const TREND = parseInt(process.env.PB_TREND || "100", 10);
const MED = parseInt(process.env.PB_MED || "20", 10);
const EXIT = parseInt(process.env.PB_EXIT || "50", 10); // ride-the-trend exit MA (slower than MED)
const PB_LOOKBACK = parseInt(process.env.PB_LOOKBACK || "5", 10);
const RSI_LEN = parseInt(process.env.PB_RSI_LEN || "14", 10);
const RSI_MAX = parseFloat(process.env.PB_RSI_MAX || "70");
const MAX_EXT_ATR = parseFloat(process.env.PB_MAX_EXT_ATR || "1.5");
const ATR_LEN = parseInt(process.env.PB_ATR_LEN || "14", 10);
const ATR_MULT = parseFloat(process.env.PB_ATR_MULT || "3"); // 0 disables disaster stop

export const name = `pullback ent<EMA${MED} trend>EMA${TREND} exit<EMA${EXIT} pb${PB_LOOKBACK} ATRx${ATR_MULT}`;
// Need history to seed the trend EMA; engine caps the window at 160 anyway.
export const warmup = Math.min(TREND + 30, 155);

// Wilder ATR over the given candles (all treated as closed bars). We pass a
// window whose last element is the just-closed decision bar.
function calcATR(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high,
      l = candles[i].low,
      pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// All indicators are computed on CLOSED candles only (exclude last forming bar)
// so signals don't flicker intrabar. We evaluate the decision on the most recent
// CLOSED bar (window's last element), treating it as the just-closed candle.
function context(window) {
  const closes = window.map((c) => c.close);
  if (closes.length < TREND + 2) return null;
  const emaTrend = calcEMA(closes, TREND);
  // EMA(TREND) one bar ago, to gauge slope.
  const emaTrendPrev = calcEMA(closes.slice(0, -1), TREND);
  const emaMed = calcEMA(closes, MED);
  const emaExit = calcEMA(closes, EXIT);
  const rsi = calcRSI(closes, RSI_LEN);
  const atr = calcATR(window, ATR_LEN);
  const last = window[window.length - 1];
  const prev = window[window.length - 2];
  return { emaTrend, emaTrendPrev, emaMed, emaExit, rsi, atr, last, prev };
}

export function shouldEnter(window) {
  const x = context(window);
  if (!x) return false;
  const { emaTrend, emaTrendPrev, emaMed, rsi, atr, last, prev } = x;

  // 1) Uptrend: price above trend MA and the trend MA is rising.
  if (!(last.close > emaTrend)) return false;
  if (!(emaTrend > emaTrendPrev)) return false;

  // 2) Pullback: some recent bar dipped its low at/below the medium EMA.
  //    (Price came back to the rising MA.)
  let pulledBack = false;
  const start = Math.max(1, window.length - PB_LOOKBACK);
  for (let i = start; i < window.length; i++) {
    if (window[i].low <= emaMed) {
      pulledBack = true;
      break;
    }
  }
  if (!pulledBack) return false;

  // 3) Turn-up: the dip is bouncing (close > previous close).
  if (!(last.close > prev.close)) return false;

  // 4) Not overbought.
  if (rsi != null && rsi >= RSI_MAX) return false;

  // 5) Not overextended above the medium MA (don't chase a runaway candle).
  if (atr != null && MAX_EXT_ATR > 0) {
    if (last.close - emaMed > MAX_EXT_ATR * atr) return false;
  }

  return true;
}

// No bracket take-profit; the disaster stop is handled in shouldExit using the
// ATR scale at exit-evaluation time (engine only hands us entryPrice here).
export function exitLevels(_entryPrice) {
  return null;
}

export function shouldExit(window, position) {
  const x = context(window);
  if (!x) return false;
  const { emaExit, atr, last } = x;

  // 1) Ride the trend: only step aside when price closes below the SLOWER exit
  //    MA (not the medium entry MA). This lets a leg breathe instead of getting
  //    whipsawed out on the first dip back to the entry MA.
  if (last.close < emaExit) return true;

  // 2) Disaster stop measured from entry, scaled by current ATR.
  if (ATR_MULT > 0 && atr != null) {
    const stop = position.entryPrice - ATR_MULT * atr;
    if (last.close <= stop) return true;
  }
  return false;
}
