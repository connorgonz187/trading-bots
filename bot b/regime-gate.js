/**
 * Day-level direction gate: turns the pre-market stance in regime.json into the
 * two booleans stockbot.js actually trades on.
 *
 * Lives in its own module for one reason: stockbot.js calls main() at import
 * time, so anything defined inside it cannot be unit-tested without placing
 * orders. See selftest-regime.js.
 *
 * The contract, in one line: this can only ever NARROW what ORB_LONGS /
 * ORB_SHORTS already permit. It never enables a direction the account's env
 * flags disabled — the same "smaller of the two wins" rule the notional caps
 * use. A "long_only" day does not turn short-only account C into a long bot; C
 * stands down for the day.
 *
 * It also fails OPEN. A missing, malformed or stale file returns "both", so a
 * scheduler hiccup at 8:55 leaves the bots on their static flags instead of
 * silently halting the account. The failure mode we want is "traded as it
 * always did", not "quietly traded nothing".
 */

import { readFileSync } from "fs";

export const STANCES = ["both", "long_only", "short_only", "flat"];

// stance -> [allowLong, allowShort]
const MAP = {
  both: [true, true],
  long_only: [true, false],
  short_only: [false, true],
  flat: [false, false],
};

/**
 * @param {string} today  today's ET date as YYYY-MM-DD (from stockbot's et())
 * @param {object} opts   { enabled, file, read } — `read` is injectable for tests
 * @returns {{allowLong:boolean, allowShort:boolean, label:string, stale:boolean}}
 */
export function loadDayStance(today, { enabled = true, file = "../regime.json", read } = {}) {
  const open = (label, stale = false) => ({ allowLong: true, allowShort: true, label, stale });

  if (!enabled) return open("off");

  let raw;
  try {
    raw = (read || ((f) => readFileSync(f, "utf8")))(file);
  } catch {
    return open("no-file (env flags only)");
  }

  let r;
  try {
    r = JSON.parse(raw);
  } catch {
    return open("unreadable (env flags only)");
  }

  // Yesterday's stance must never govern today's session. A war that mattered on
  // Monday is not evidence about Wednesday, and a scheduler that failed to run
  // should degrade to "no opinion", not to "last opinion".
  if (!r || r.date !== today) {
    return open(`STALE ${r?.date ?? "?"} (env flags only)`, true);
  }

  const pair = MAP[r.stance];
  if (!pair) return open(`unknown stance "${r.stance}" (env flags only)`);

  const label = `${r.stance} via ${r.source || "?"}${r.why ? ` — ${r.why}` : ""}`;
  return { allowLong: pair[0], allowShort: pair[1], label, stale: false };
}
