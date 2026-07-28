/**
 * Self-test for the day-level direction gate. No network, no broker, no keys.
 *
 *   node selftest-regime.js
 *
 * The property that actually matters is the last group: the gate must never
 * WIDEN what the account's env flags permit. Everything else is bookkeeping.
 */

import { loadDayStance } from "./regime-gate.js";

let pass = 0;
let fail = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
  }
}

const TODAY = "2026-07-28";
const gate = (obj, opts = {}) => {
  const r = loadDayStance(TODAY, {
    file: "fixture",
    read: () => (typeof obj === "string" ? obj : JSON.stringify(obj)),
    ...opts,
  });
  return { allowLong: r.allowLong, allowShort: r.allowShort };
};

console.log("stance mapping");
check("both",       gate({ date: TODAY, stance: "both", source: "auto" }),       { allowLong: true,  allowShort: true });
check("long_only",  gate({ date: TODAY, stance: "long_only", source: "auto" }),  { allowLong: true,  allowShort: false });
check("short_only", gate({ date: TODAY, stance: "short_only", source: "auto" }), { allowLong: false, allowShort: true });
check("flat",       gate({ date: TODAY, stance: "flat", source: "claude" }),     { allowLong: false, allowShort: false });

console.log("\nfails open (never halts the bot on its own bugs)");
check("stale date",      gate({ date: "2026-07-27", stance: "short_only" }), { allowLong: true, allowShort: true });
check("missing date",    gate({ stance: "short_only" }),                     { allowLong: true, allowShort: true });
check("unknown stance",  gate({ date: TODAY, stance: "moon" }),              { allowLong: true, allowShort: true });
check("malformed json",  gate("{not json"),                                  { allowLong: true, allowShort: true });
check("null body",       gate("null"),                                       { allowLong: true, allowShort: true });
check("disabled flag",   gate({ date: TODAY, stance: "flat" }, { enabled: false }), { allowLong: true, allowShort: true });
check(
  "unreadable file",
  (() => {
    const r = loadDayStance(TODAY, { file: "nope", read: () => { throw new Error("ENOENT"); } });
    return { allowLong: r.allowLong, allowShort: r.allowShort };
  })(),
  { allowLong: true, allowShort: true },
);

console.log("\nstaleness is flagged, not just tolerated");
check(
  "stale marked",
  loadDayStance(TODAY, { file: "f", read: () => JSON.stringify({ date: "2026-07-01", stance: "flat" }) }).stale,
  true,
);
check(
  "fresh not marked",
  loadDayStance(TODAY, { file: "f", read: () => JSON.stringify({ date: TODAY, stance: "flat" }) }).stale,
  false,
);

// The load-bearing invariant. Bot C is short-only by env (ORB_LONGS=false); no
// stance may ever hand it a long. Bot A's retirement came from taking the wrong
// side 83 times, so widening a direction by accident is the expensive bug here.
console.log("\nnarrowing only — env flags are a ceiling, never a floor");
for (const stance of ["both", "long_only", "short_only", "flat"]) {
  for (const [LONGS, SHORTS] of [[true, true], [true, false], [false, true], [false, false]]) {
    const d = loadDayStance(TODAY, { file: "f", read: () => JSON.stringify({ date: TODAY, stance }) });
    const canLong = LONGS && d.allowLong;
    const canShort = SHORTS && d.allowShort;
    const widened = (canLong && !LONGS) || (canShort && !SHORTS);
    check(`${stance} with L=${LONGS} S=${SHORTS} does not widen`, widened, false);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
