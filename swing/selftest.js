/**
 * Offline self-test for swing-strategy.js. No network, no keys, no orders.
 *
 *   node selftest.js
 *
 * These are the assertions that would have caught real bugs during development:
 * an RSI that never reaches its extremes, a ratchet that can loosen a stop, an
 * ATR gate that lets a 5%-ATR name through a 2% stop, a short whose levels are
 * mirrored the wrong way. Run it after touching the strategy module.
 */
import {
  CFG, sma, atr, rsi, indicators, passesUniverseGate, entrySignal,
  exitLevels, ratchetStop, bestSince, regimeOf, WARMUP,
} from "./swing-strategy.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Build a synthetic daily series: a steady uptrend with a controllable
// pullback at the end, so the entry trigger can be driven deterministically.
function series({ n = 120, start = 100, drift = 0.004, wiggle = 0.004, tail = [] }) {
  const bars = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const open = px;
    const close = px * (1 + drift + (i % 2 ? wiggle : -wiggle));
    bars.push({
      time: Date.UTC(2024, 0, 1) + i * 86400e3,
      open, close,
      high: Math.max(open, close) * 1.003,
      low: Math.min(open, close) * 0.997,
      volume: 5e6,
    });
    px = close;
  }
  for (const t of tail) {
    const open = px;
    const close = px * (1 + t);
    bars.push({
      time: Date.UTC(2024, 0, 1) + bars.length * 86400e3,
      open, close,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      volume: 5e6,
    });
    px = close;
  }
  return bars;
}

console.log("\nindicators");
ok("sma of 1..10 over 10 = 5.5", near(sma([1,2,3,4,5,6,7,8,9,10], 10), 5.5));
ok("sma returns null when short", sma([1, 2], 10) === null);
{
  const up = [1,2,3,4,5,6,7,8,9,10].map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));
  ok("rsi = 100 on a pure uptrend", near(rsi(up.map((b) => b.close), 2), 100));
  ok("rsi = 0 on a pure downtrend", near(rsi(up.map((b) => b.close).reverse(), 2), 0));
  ok("atr of a flat series is 1 (gap-to-gap)", atr(up, 5) > 0);
}
{
  // ATR must count the overnight gap, not just the intraday range — the whole
  // reason a swing bot cares about it.
  const gappy = Array.from({ length: 20 }, (_, i) => {
    const base = 100 + i * 5; // +5 gap every day
    return { time: i, open: base, high: base + 0.1, low: base - 0.1, close: base, volume: 1 };
  });
  ok("atr counts overnight gaps", atr(gappy, 14) > 4, `got ${atr(gappy, 14)}`);
}

console.log("\nexit levels");
{
  const l = exitLevels("long", 100);
  ok("long stop is below entry", l.stop < 100 && near(l.stop, 100 * (1 - CFG.stopPct)));
  ok("long target is above entry", l.target > 100 && near(l.target, 100 * (1 + CFG.targetPct)));
  const s = exitLevels("short", 100);
  ok("short stop is ABOVE entry", s.stop > 100);
  ok("short target is BELOW entry", s.target < 100);
  ok("reward:risk matches the brief", near(CFG.targetPct / CFG.stopPct, CFG.targetPct / CFG.stopPct) && CFG.targetPct / CFG.stopPct >= 2);
}

console.log("\nratchet");
{
  const e = 100;
  const l0 = exitLevels("long", e);
  ok("no ratchet before the breakeven trigger",
     near(ratchetStop("long", e, l0.stop, e * (1 + CFG.beAtPct / 2), 1), l0.stop));
  const r1 = ratchetStop("long", e, l0.stop, e * (1 + CFG.beAtPct), 1);
  ok("ratchets to breakeven once triggered", r1 >= e, `got ${r1}`);
  ok("ratchet never loosens a stop",
     ratchetStop("long", e, r1, e * (1 + CFG.beAtPct), 1) >= r1);
  ok("ratchet cannot pass the target", ratchetStop("long", e, l0.stop, e * 100, 1) < l0.target);
  // short mirror
  const s0 = exitLevels("short", e);
  const rs = ratchetStop("short", e, s0.stop, e * (1 - CFG.beAtPct), 1);
  ok("short ratchet moves DOWN to breakeven", rs <= e && rs < s0.stop, `got ${rs}`);
  ok("short ratchet never loosens",
     ratchetStop("short", e, rs, e * (1 - CFG.beAtPct), 1) <= rs);
}

console.log("\nbestSince");
{
  const bars = [
    { high: 105, low: 99, close: 101 },
    { high: 110, low: 100, close: 102 },
    { high: 104, low: 95, close: 103 },
  ];
  ok("close mode ignores the wick", bestSince("long", bars, { ...CFG, ratchetOn: "close" }) === 103);
  ok("high mode uses the wick", bestSince("long", bars, { ...CFG, ratchetOn: "high" }) === 110);
  ok("short close mode takes the min close", bestSince("short", bars, { ...CFG, ratchetOn: "close" }) === 101);
}

console.log("\nuniverse gate (the coupling that makes a tight stop mean something)");
{
  const calm = series({ n: 120, drift: 0.001, wiggle: 0.002 });
  const g1 = passesUniverseGate(calm);
  ok("a calm liquid name passes", g1.ok, g1.why);

  const wild = series({ n: 120, drift: 0.001, wiggle: 0.05 });
  const g2 = passesUniverseGate(wild);
  ok("a 5%-ATR name is REJECTED against a 2% stop", !g2.ok, "it was admitted");
  ok("...and the reason names the ATR", !g2.ok && /ATR/.test(g2.why), g2.why);

  const cheap = series({ n: 120, start: 2, drift: 0.001, wiggle: 0.002 });
  ok("a $2 name is rejected on price", !passesUniverseGate(cheap).ok);

  const thin = series({ n: 120, drift: 0.001, wiggle: 0.002 }).map((b) => ({ ...b, volume: 100 }));
  ok("an illiquid name is rejected on dollar volume", !passesUniverseGate(thin).ok);

  ok("too little history returns not-ok", !passesUniverseGate(series({ n: 10 })).ok);
}

console.log("\nentry signal");
{
  // Uptrend, then two hard down closes (RSI2 -> ~0), then a close above the
  // prior high: exactly the pullback trigger.
  const bars = series({ n: 120, drift: 0.002, wiggle: 0.002, tail: [-0.02, -0.02, 0.03] });
  const sig = entrySignal(bars, "bull");
  ok("pullback trigger fires long in an uptrend", sig && sig.side === "long", JSON.stringify(sig));
  ok("a bear regime vetoes the long", entrySignal(bars, "bear") === null);

  // Same bars without the resumption close: no entry.
  const noResume = series({ n: 120, drift: 0.002, wiggle: 0.002, tail: [-0.02, -0.02, -0.005] });
  ok("no entry without the resumption close", entrySignal(noResume, "bull") === null);

  // A pure uptrend never gets oversold, so it must not fire.
  ok("no entry in an untroubled uptrend", entrySignal(series({ n: 120, drift: 0.004, wiggle: 0.001 }), "bull") === null);
}

console.log("\nregime");
{
  const up = series({ n: 120, drift: 0.003, wiggle: 0.001 });
  ok("rising series is bull", regimeOf(up) === "bull");
  const down = series({ n: 120, drift: -0.003, wiggle: 0.001 });
  ok("falling series is bear", regimeOf(down) === "bear");
  ok("regime is null when disabled", regimeOf(up, { ...CFG, regime: false }) === null);
}

console.log("\nconfig sanity");
ok(`stop ${(CFG.stopPct * 100).toFixed(1)}% is inside the 1-2% brief`, CFG.stopPct >= 0.01 - 1e-9 && CFG.stopPct <= 0.02 + 1e-9);
ok(`target ${(CFG.targetPct * 100).toFixed(1)}% is inside the 4-7% brief`, CFG.targetPct >= 0.04 - 1e-9 && CFG.targetPct <= 0.07 + 1e-9);
ok("breakeven trigger sits below the target", CFG.beAtPct < CFG.targetPct);
ok("warmup covers the slowest lookback", WARMUP > CFG.slowLen);

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} passed, ${fail} failed\n`);
process.exitCode = fail ? 1 : 0;
