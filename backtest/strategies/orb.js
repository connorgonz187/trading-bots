/**
 * Opening-Range Breakout (ORB) — long-only INTRADAY day-trading strategy (stocks).
 *
 * Each regular-hours session (9:30-16:00 ET):
 *   - Opening range = the high/low of the first ORB_MINUTES after 9:30.
 *   - ENTRY: the first bar that closes above the OR high (after the OR window).
 *     One trade per day, and not after ORB_LAST_ENTRY.
 *   - EXIT: stop at the OR low; target = entry + ORB_R * (range); or force-flatten
 *     near the close (no overnight holds — this is day trading).
 *
 * Env: ORB_MINUTES (15), ORB_R (2), ORB_LAST_ENTRY (900 = 15:00 ET).
 *
 * NOTE: exits are evaluated on bar CLOSE (not intrabar), so stop fills are
 * approximate — treat results as directional, not precise.
 */

const OR_MIN = parseInt(process.env.ORB_MINUTES || "15", 10);
const R = parseFloat(process.env.ORB_R || "2");
const LAST_ENTRY = parseInt(process.env.ORB_LAST_ENTRY || "900", 10); // 15:00 ET
const OPEN = 570; // 9:30 ET, in minutes from midnight
const CLOSE = 960; // 16:00 ET
const FLATTEN = 955; // 15:55 ET — force exit

export const name = `ORB ${OR_MIN}min R${R}`;
export const warmup = 90; // ~1+ RTH session of 5-min bars

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
function et(ts) {
  const p = {};
  for (const x of etFmt.formatToParts(new Date(ts))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

// Today's opening range from bars in the window sharing the current ET date.
function openingRange(window) {
  const cur = et(window[window.length - 1].time);
  let hi = -Infinity,
    lo = Infinity,
    count = 0;
  for (const b of window) {
    const e = et(b.time);
    if (e.date !== cur.date) continue;
    if (e.min >= OPEN && e.min < OPEN + OR_MIN) {
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
      count++;
    }
  }
  return count ? { hi, lo, date: cur.date } : null;
}

let lastSignalDay = null;

export function shouldEnter(window) {
  const last = window[window.length - 1];
  const e = et(last.time);
  if (e.min < OPEN + OR_MIN || e.min > LAST_ENTRY) return false; // after OR, not too late
  if (lastSignalDay === e.date) return false; // one trade per day
  const or = openingRange(window);
  if (!or || !isFinite(or.hi)) return false;
  if (last.close > or.hi) {
    lastSignalDay = e.date;
    return true;
  }
  return false;
}

// Bracket: stop at the OR low, target a true R-multiple of the risk (entry-stop).
// These are placed as resting broker orders live, and filled INTRABAR in the
// backtest engine via each bar's high/low — so backtest and live match.
export function exitLevels(entryPrice, window) {
  const or = openingRange(window);
  if (!or) return null;
  const risk = entryPrice - or.lo;
  if (risk <= 0) return null;
  return { stopLoss: or.lo, takeProfit: entryPrice + R * risk };
}

// The only exit the strategy itself owns is the end-of-day flatten (no overnight).
export function shouldExit(window) {
  const e = et(window[window.length - 1].time);
  return e.min >= FLATTEN || e.min >= CLOSE;
}
