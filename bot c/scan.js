/**
 * Pre-market scanner. Picks the day's day-trading UNIVERSE (liquid, mid-priced,
 * volatile movers) and writes it to watchlist.csv. It chooses WHAT to watch —
 * it does NOT trade. The intraday runner (stockbot.js) applies the actual ORB
 * rules to these names during market hours.
 *
 * Filters keep it sane: price $5-$500 (no penny pumps / no ultra-high), volume
 * over ~1M (liquid enough to fill without huge slippage).
 */
import "dotenv/config";
import { existsSync, writeFileSync, appendFileSync } from "fs";
import { getClock, mostActives, movers, snapshots } from "./alpaca.js";

const MIN_PRICE = Number(process.env.SCAN_MIN_PRICE || "5");
const MAX_PRICE = Number(process.env.SCAN_MAX_PRICE || "500");
const MIN_VOL = Number(process.env.SCAN_MIN_VOLUME || "1000000");
// Daily range must be at least this % — ORB needs room to clear costs + hit target.
const MIN_VOLATILITY = Number(process.env.SCAN_MIN_VOLATILITY || "3");
// Skip names that already made a huge prior-session move — they're exhausted and
// prone to mean-revert, which is exactly where ORB breakouts whipsaw. 0 = off.
const MAX_PRIOR_MOVE = Number(process.env.SCAN_MAX_PRIOR_MOVE || "15");
const TOP = Number(process.env.SCAN_TOP || "8");
const FILE = "watchlist.csv";

const etDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
}).format(new Date());

// Selection metrics come from a "reference bar". Normally that's today's dailyBar
// (at the 9:00 pre-market trigger it still holds the prior full session). But if the
// scanner is run AFTER the open (e.g. PC booted late), dailyBar is a partial intraday
// bar with tiny volume/range that fails every gate — so fall back to prevDailyBar (the
// prior full session), which is exactly what the on-time run would have selected on.
const refBar = (s) =>
  s && s.dailyBar && s.dailyBar.v >= MIN_VOL
    ? s.dailyBar
    : (s && s.prevDailyBar) || (s && s.dailyBar) || null;
const rangePct = (b) => (b ? ((b.h - b.l) / b.o) * 100 : 0);
const sessionMove = (b) => (b ? ((b.c - b.o) / b.o) * 100 : 0);

// Cold-wake network gate. The 9:00 trigger is -StartWhenAvailable, so on a
// machine that slept overnight Task Scheduler fires it the moment it catches up
// — often before Wi-Fi/DNS are back. alpaca.js already retries every call, but
// its budget is ~5s (3 tries, linear 0.8s) and deliberately so: a live 5-min
// trading cycle must never stall on a hung socket. A pre-market scanner has ~30
// minutes of slack before the open, so it can afford to wait properly.
// On 2026-08-04 all three scanners exited 1 on "fetch failed" at 09:01:33 (every
// task fired at once on wake) and both ORB bots sat watchlist-less all session.
// Costs nothing when the network is already up: the first probe just succeeds.
const NET_WAIT_MS = Number(process.env.SCAN_NET_WAIT_MS || 8 * 60 * 1000);
const NET_PROBE_MS = Number(process.env.SCAN_NET_PROBE_MS || 10 * 1000);

async function waitForNetwork() {
  const deadline = Date.now() + NET_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      await getClock();
      if (attempt > 1) console.log(`  network up after ${attempt} probes.`);
      return;
    } catch (e) {
      if (Date.now() + NET_PROBE_MS >= deadline) {
        throw new Error(
          `network still down after ${Math.round(NET_WAIT_MS / 1000)}s: ${e.message}`,
        );
      }
      console.log(`  waiting for network (probe ${attempt}: ${e.message})`);
      await new Promise((r) => setTimeout(r, NET_PROBE_MS));
    }
  }
}

async function main() {
  await waitForNetwork();
  const [ma, mv] = await Promise.all([mostActives(40), movers(40)]);
  const cand = new Set();
  for (const x of ma.most_actives || []) cand.add(x.symbol);
  for (const x of mv.gainers || []) cand.add(x.symbol);
  for (const x of mv.losers || []) cand.add(x.symbol);

  const syms = [...cand].slice(0, 100);
  if (!syms.length) {
    console.log("Scanner: no candidates returned.");
    return;
  }
  const snaps = await snapshots(syms);

  const rows = [];
  for (const [sym, s] of Object.entries(snaps)) {
    if (!s || !s.dailyBar) continue;
    const ref = refBar(s);
    if (!ref) continue;
    const price = s.dailyBar.c; // latest print
    const v = ref.v; // full-session volume (ignores today's partial bar pre-open/late start)
    if (price < MIN_PRICE || price > MAX_PRICE) continue; // mid-priced only
    if (v < MIN_VOL) continue; // liquid only
    const volty = rangePct(ref);
    if (volty < MIN_VOLATILITY) continue; // must actually move
    // Prior move: close-to-close when today's full bar is the reference, else the
    // reference session's own open→close.
    const ch =
      ref === s.dailyBar && s.prevDailyBar
        ? ((s.dailyBar.c - s.prevDailyBar.c) / s.prevDailyBar.c) * 100
        : sessionMove(ref);
    if (MAX_PRIOR_MOVE > 0 && Math.abs(ch) > MAX_PRIOR_MOVE) continue; // skip exhausted movers
    rows.push({ sym, price, v, volty, ch });
  }
  if (!rows.length) {
    console.log("Scanner: no symbols passed the price/volume filters.");
    return;
  }

  // Pick top names per category, dedup, cap at TOP.
  const pick = new Map();
  const addTop = (arr, cat, key, n = 3) =>
    [...arr]
      .sort((a, b) => Math.abs(b[key]) - Math.abs(a[key]))
      .slice(0, n)
      .forEach((r) => {
        if (!pick.has(r.sym)) pick.set(r.sym, { ...r, cat });
      });

  addTop(rows, "High Volatility", "volty", 3);
  addTop(rows, "Big Mover %", "ch", 3);
  addTop(rows, "Most Active", "v", 2);
  addTop(rows.filter((r) => r.price >= 20 && r.price <= 100), "Mid-Priced", "v", 2);

  const final = [...pick.values()].slice(0, TOP);

  if (!existsSync(FILE)) {
    writeFileSync(FILE, "Date,Symbol,Category,Price,PctChange,Volatility%,Volume\n");
  }
  for (const r of final) {
    appendFileSync(
      FILE,
      `${etDate},${r.sym},${r.cat},${r.price.toFixed(2)},${r.ch.toFixed(2)},${r.volty.toFixed(2)},${r.v}\n`,
    );
  }
  console.log(`\nWatchlist for ${etDate} (${final.length} names) -> ${FILE}\n`);
  for (const r of final)
    console.log(
      `  ${r.sym.padEnd(6)} ${r.cat.padEnd(16)} $${r.price.toFixed(2).padStart(8)}  ${r.ch >= 0 ? "+" : ""}${r.ch.toFixed(1)}%  vol±${r.volty.toFixed(1)}%`,
    );
}

main().catch((e) => {
  console.error("Scanner error:", e.message);
  process.exitCode = 1;
});
