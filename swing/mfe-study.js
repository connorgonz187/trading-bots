/**
 * The premise test.
 *
 * The claim behind Bot E is: "the ORB bots exit too low — held a day or more,
 * those same trades would have been 4–7% winners." This script measures that
 * claim directly, against the ORB bots' OWN historical entries, by asking each
 * entry a simple question: from where you got in, how far did the name actually
 * travel over the next N days, and would a −2% / +5% swing rule have won?
 *
 *   node mfe-study.js                          # bot b + bot c + archived bot A
 *   node mfe-study.js "../bot b/stock-trades.csv"
 *
 * WHY THIS EXISTS SEPARATELY FROM THE BACKTEST
 *   swing-bt.js tests Bot E's own entry rule. This tests the *hypothesis that
 *   motivated it*. They can disagree, and if they do that is the most useful
 *   thing you will learn: the swing rule could work on names the ORB entries
 *   never touch, or the ORB entries could have huge follow-through that a
 *   different entry filter would capture better.
 *
 * MEASUREMENT NOTE — read this before quoting a number
 *   Entry rows are taken from the local CSV. Per POSTMORTEM-BOT-A.md the CSV is
 *   NOT trustworthy for P/L, because pairing entries to exits across days is
 *   what broke. This script never pairs anything and never computes the bots'
 *   realised P/L. It uses only (date, symbol, side, entry price) — fields
 *   written once at fill time, each verifiable against a bar — and everything
 *   downstream comes from market data. That is why its numbers are safe when
 *   the CSV's P/L column is not.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import { dailyBarsMulti } from "./alpaca.js";
import { CFG } from "./swing-strategy.js";

const HORIZONS = [1, 2, 3, 5, 10];
const LOGS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DEFAULT_LOGS = [
  "../bot b/stock-trades.csv",
  "../bot c/stock-trades.csv",
  "../archive/bot-a-orb/stock-trades.csv",
];

function readEntries(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const head = lines[0].split(",").map((s) => s.trim());
  const idx = (n) => head.findIndex((h) => h.toLowerCase().startsWith(n));
  const iDate = idx("date"), iSym = idx("symbol"), iSide = idx("side"),
        iAct = idx("action"), iPx = idx("price");
  const out = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (c.length <= iPx) continue;
    if ((c[iAct] || "").trim().toUpperCase() !== "ENTRY") continue;
    const price = Number(c[iPx]);
    const side = (c[iSide] || "long").trim().toLowerCase();
    if (!Number.isFinite(price) || price <= 0) continue;
    out.push({ src: path, date: c[iDate].trim(), sym: c[iSym].trim().toUpperCase(), side, entry: price });
  }
  return out;
}

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

/** Walk forward applying Bot E's exit rules. Returns {net, reason, gapped}. */
function applySwingRules(side, entry, fwd) {
  const long = side === "long";
  let stop = long ? entry * (1 - CFG.stopPct) : entry * (1 + CFG.stopPct);
  const tgt = long ? entry * (1 + CFG.targetPct) : entry * (1 - CFG.targetPct);
  let best = entry;
  for (let i = 0; i < Math.min(fwd.length, CFG.maxHoldDays); i++) {
    const b = fwd[i];
    // i=0 is the entry day: we are already in, so no opening gap to model.
    if (i > 0) {
      if ((long && b.open <= stop) || (!long && b.open >= stop))
        return { net: (long ? b.open - entry : entry - b.open) / entry, reason: "stop", gapped: true };
      if ((long && b.open >= tgt) || (!long && b.open <= tgt))
        return { net: (long ? b.open - entry : entry - b.open) / entry, reason: "target", gapped: true };
    }
    if ((long && b.low <= stop) || (!long && b.high >= stop))
      return { net: (long ? stop - entry : entry - stop) / entry, reason: long ? (stop >= entry ? "be-stop" : "stop") : (stop <= entry ? "be-stop" : "stop"), gapped: false };
    if ((long && b.high >= tgt) || (!long && b.low <= tgt))
      return { net: (long ? tgt - entry : entry - tgt) / entry, reason: "target", gapped: false };
    best = long ? Math.max(best, b.close) : Math.min(best, b.close);
    const moved = long ? (best - entry) / entry : (entry - best) / entry;
    if (CFG.beEnabled && moved >= CFG.beAtPct) {
      const be = long ? entry * (1 + CFG.beOffsetPct) : entry * (1 - CFG.beOffsetPct);
      stop = long ? Math.max(stop, be) : Math.min(stop, be);
    }
  }
  const last = fwd[Math.min(fwd.length, CFG.maxHoldDays) - 1];
  if (!last) return null;
  return { net: (long ? last.close - entry : entry - last.close) / entry, reason: "time-stop", gapped: false };
}

async function main() {
  const paths = LOGS.length ? LOGS : DEFAULT_LOGS;
  const entries = paths.flatMap(readEntries);
  if (!entries.length) {
    console.error(`No ENTRY rows found in: ${paths.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const syms = [...new Set(entries.map((e) => e.sym))];
  const dates = entries.map((e) => e.date).sort();
  console.log(`${entries.length} entries, ${syms.length} symbols, ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`Testing: stop ${(CFG.stopPct * 100).toFixed(1)}% / target ${(CFG.targetPct * 100).toFixed(1)}% / hold ≤${CFG.maxHoldDays}d\n`);

  const startISO = new Date(Date.parse(dates[0]) - 5 * 86400e3).toISOString();
  const bars = await dailyBarsMulti(syms, startISO);

  const rows = [];
  let noData = 0;
  for (const e of entries) {
    const b = bars[e.sym];
    if (!b || !b.length) { noData++; continue; }
    const start = b.findIndex((x) => dayKey(x.time) >= e.date);
    if (start < 0) { noData++; continue; }
    const fwd = b.slice(start, start + Math.max(...HORIZONS) + 1);
    if (fwd.length < 2) { noData++; continue; }
    // Sanity: the entry price must sit inside the entry day's range. If it does
    // not, the log row and the bar disagree — a split, a bad print, or a stale
    // row — and silently keeping it is exactly how the SOXS 10:1 split once
    // turned a −$53 account into a reported −$3,403. Drop it and say so.
    const d0 = fwd[0];
    if (e.entry < d0.low * 0.95 || e.entry > d0.high * 1.05) { noData++; continue; }

    const long = e.side === "long";
    const sameDay = (long ? d0.close - e.entry : e.entry - d0.close) / e.entry;
    const exc = {};
    for (const h of HORIZONS) {
      const w = fwd.slice(0, h + 1);
      exc[h] = {
        mfe: Math.max(...w.map((x) => (long ? x.high - e.entry : e.entry - x.low) / e.entry)),
        mae: Math.min(...w.map((x) => (long ? x.low - e.entry : e.entry - x.high) / e.entry)),
      };
    }
    rows.push({ ...e, sameDay, exc, rule: applySwingRules(e.side, e.entry, fwd) });
  }
  if (noData) console.log(`(${noData} entries dropped: no bars, or the logged price is outside the day's range)\n`);
  if (!rows.length) return;

  const n = rows.length;
  const share = (f) => `${((rows.filter(f).length / n) * 100).toFixed(1)}%`;

  console.log("═".repeat(74));
  console.log("1. Was the move actually there?  (max favourable excursion from entry)");
  console.log("═".repeat(74));
  console.log("  horizon    median MFE   reached +4%   +5%   +7%    median MAE");
  for (const h of HORIZONS) {
    const m = rows.map((r) => r.exc[h].mfe).sort((a, b) => a - b);
    const med = m[Math.floor(m.length / 2)];
    const mae = rows.map((r) => r.exc[h].mae).sort((a, b) => a - b);
    const medMae = mae[Math.floor(mae.length / 2)];
    console.log(
      `  ${String(h).padStart(2)} day(s)   ${pct(med).padStart(9)}   ` +
        `${share((r) => r.exc[h].mfe >= 0.04).padStart(9)}  ${share((r) => r.exc[h].mfe >= 0.05).padStart(5)}  ` +
        `${share((r) => r.exc[h].mfe >= 0.07).padStart(5)}    ${pct(medMae).padStart(8)}`,
    );
  }
  const sd = rows.map((r) => r.sameDay).sort((a, b) => a - b);
  console.log(`\n  For contrast, the SAME-DAY close from entry: median ${pct(sd[Math.floor(sd.length / 2)])}`);
  console.log("  (that is roughly what an EOD flatten captures, before the bots' own stops)");

  console.log("\n" + "═".repeat(74));
  console.log("2. Which came first — the target or the stop?");
  console.log("═".repeat(74));
  console.log("  This is the question the MFE table cannot answer. A trade that reaches");
  console.log("  +7% on day 4 is worthless if it touched −2% on day 1 first.\n");
  const ruled = rows.filter((r) => r.rule);
  const byReason = {};
  for (const r of ruled) (byReason[r.rule.reason] ||= []).push(r);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  for (const [k, ts] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length))
    console.log(`  ${k.padEnd(11)} n=${String(ts.length).padStart(4)} (${((ts.length / ruled.length) * 100).toFixed(1)}%)  avg ${pct(sum(ts.map((t) => t.rule.net)) / ts.length)}`);

  const netAvg = sum(ruled.map((r) => r.rule.net)) / ruled.length;
  const w = ruled.filter((r) => r.rule.net > 0);
  const l = ruled.filter((r) => r.rule.net <= 0);
  const pf = l.length ? sum(w.map((r) => r.rule.net)) / -sum(l.map((r) => r.rule.net)) : Infinity;
  const gapped = ruled.filter((r) => r.rule.gapped && r.rule.net <= 0);
  console.log(`\n  Applying Bot E's exit rules to these ORB entries:`);
  console.log(`    win rate    ${((w.length / ruled.length) * 100).toFixed(1)}%   (break-even needs ${((CFG.stopPct / (CFG.stopPct + CFG.targetPct)) * 100).toFixed(1)}%)`);
  console.log(`    profit factor ${pf.toFixed(2)}`);
  console.log(`    expectancy  ${pct(netAvg)} per trade  (${(netAvg / CFG.stopPct).toFixed(3)}R)`);
  console.log(`    gapped through the stop: ${gapped.length} (${((gapped.length / ruled.length) * 100).toFixed(1)}%)` +
              (gapped.length ? `, avg ${pct(sum(gapped.map((r) => r.rule.net)) / gapped.length)}` : ""));

  console.log("\n" + "═".repeat(74));
  console.log("3. Verdict on the premise");
  console.log("═".repeat(74));
  const reach5 = rows.filter((r) => r.exc[5].mfe >= 0.05).length / n;
  const targetFirst = (byReason.target || []).length / Math.max(ruled.length, 1);
  console.log(`  ${(reach5 * 100).toFixed(1)}% of ORB entries eventually reached +5% within 5 days,`);
  console.log(`  but only ${(targetFirst * 100).toFixed(1)}% got there BEFORE hitting a ${(CFG.stopPct * 100).toFixed(1)}% stop.`);
  console.log("");
  if (netAvg > 0 && targetFirst > 0.2)
    console.log("  → The premise survives this test. Holding longer had positive expectancy on\n" +
                "    these entries. Worth forward-testing Bot E.");
  else if (reach5 > 0.35 && netAvg <= 0)
    console.log("  → The move WAS there, but the stop got hit first. The premise is half right:\n" +
                "    holding longer helps only with a wider stop, which contradicts the 1–2%\n" +
                "    loss cap. Try SWING_STOP_PCT=3 and re-run before committing to this design.");
  else
    console.log("  → The premise does NOT survive on these entries. The follow-through is not\n" +
                "    there often enough to pay for the stops. Bot E's own entry rule may still\n" +
                "    work (see swing-bt.js) — but it will not be because ORB exits were early.");
  console.log("\n  Entries come from the local CSV; nothing here is paired or uses the CSV's");
  console.log("  P/L. Excursions are computed from split-adjusted daily bars.");
}

main().catch((e) => {
  console.error("mfe-study error:", e.message);
  process.exitCode = 1;
});
