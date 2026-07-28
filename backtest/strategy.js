/**
 * Shared strategy logic — imported by BOTH bot.js (live) and backtest.js, so the
 * backtest measures EXACTLY what the bot trades. Pure functions, no I/O.
 *
 * Tunable knobs (env-overridable) so the backtester can sweep them without code
 * edits:
 *   STOP_LOSS_PCT, TAKE_PROFIT_PCT  — exit distances (percent)
 *   RSI_ENTRY                       — RSI(3) pullback threshold for a long
 *   MAX_VWAP_DIST_PCT               — max distance from VWAP to still enter
 */

export const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || "0.3") / 100;
export const TAKE_PROFIT_PCT =
  parseFloat(process.env.TAKE_PROFIT_PCT || "0.6") / 100;
export const RSI_ENTRY = parseFloat(process.env.RSI_ENTRY || "30");
export const MAX_VWAP_DIST_PCT = parseFloat(process.env.MAX_VWAP_DIST_PCT || "1.5");

export function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP over the session since UTC-midnight of the LAST candle's day. Deriving
// "today" from the last candle (not the wall clock) makes this work identically
// live and in a backtest replaying historical windows.
export function sessionVWAP(candles) {
  const last = candles[candles.length - 1];
  if (!last) return null;
  const midnight = new Date(last.time);
  midnight.setUTCHours(0, 0, 0, 0);
  const session = candles.filter((c) => c.time >= midnight.getTime());
  if (session.length === 0) return null;
  const cumTPV = session.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = session.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

export function biasOf(price, ema8, vwap) {
  if (price > vwap && price > ema8) return "bullish";
  if (price < vwap && price < ema8) return "bearish";
  return "neutral";
}

// Indicators for a window of candles (oldest→newest). price = the last (still
// forming) candle's close; EMA/RSI use CLOSED candles only so signals don't
// flicker intrabar.
export function computeIndicators(candles) {
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const closed = closes.slice(0, -1);
  return {
    price,
    ema8: calcEMA(closed, 8),
    vwap: sessionVWAP(candles),
    rsi3: calcRSI(closed, 3),
  };
}

// LONG entry: bullish bias + RSI(3) pullback + not overextended from VWAP.
// (This is the single source of truth; bot.js's runSafetyCheck prints the same
//  conditions for the console and must stay in sync with this.)
export function entrySignal(price, ema8, vwap, rsi3) {
  if (biasOf(price, ema8, vwap) !== "bullish") return false;
  const dist = Math.abs((price - vwap) / vwap) * 100;
  return rsi3 < RSI_ENTRY && dist < MAX_VWAP_DIST_PCT;
}

export function calcExitLevels(side, entryPrice) {
  const long = side === "buy" || side === "long";
  return long
    ? {
        stopLoss: entryPrice * (1 - STOP_LOSS_PCT),
        takeProfit: entryPrice * (1 + TAKE_PROFIT_PCT),
      }
    : {
        stopLoss: entryPrice * (1 + STOP_LOSS_PCT),
        takeProfit: entryPrice * (1 - TAKE_PROFIT_PCT),
      };
}

// Exit a held long on (in priority order): stop-loss, take-profit, or a bearish
// bias flip. `price` is the close; for a backtest you can pass the intrabar
// low/high to model stop/target fills (see backtest.js).
export function exitDecision(position, price, bias) {
  if (position.stopLoss != null && price <= position.stopLoss)
    return { exit: true, reason: "stop-loss" };
  if (position.takeProfit != null && price >= position.takeProfit)
    return { exit: true, reason: "take-profit" };
  if (bias === "bearish") return { exit: true, reason: "bias-flip" };
  return { exit: false, reason: null };
}
