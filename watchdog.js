/**
 * Dead-man alert for the trading bots.
 *
 * WHY THIS EXISTS
 * ---------------
 * Over 2026-07-29..08-25 the bots covered the opening range on 8 of 20 sessions
 * and ran the 15:55 EOD flatten on far fewer. Four sessions (08-07, 08-13,
 * 08-18, 08-19) never ran during market hours at all — the desktop was asleep
 * and `Allow wake timers` was disabled at the power-plan level, so every task's
 * WakeToRun flag was inert. Nothing alerted. The first anyone knew was a
 * "stranded-flatten" line in the CSV the next morning, after a book left open
 * overnight had cost Bot C $189 on a single gap.
 *
 * The scheduler cannot be trusted to tell you it didn't run — a task that never
 * fires produces no log line, no exit code, and no alert. So something outside
 * the bots has to look for the absence. That is this file.
 *
 * WHAT IT CHECKS
 * --------------
 *   open   (09:40 ET) — did each bot log a cycle at/after 09:30 today?
 *   close  (16:05 ET) — did each bot log a cycle at/after 15:50 today, and is
 *                       the account actually FLAT? An open position after the
 *                       close is the expensive failure, so it alerts loudest.
 *
 * It reads each bot's .env directly and talks to Alpaca and Telegram over plain
 * fetch — no imports from the bot folders. That is deliberate: the watchdog has
 * to keep working when the thing it is watching is broken.
 *
 * Silence is success. It only sends a message when something is wrong, so an
 * alert always means "look at this", never "still fine".
 *
 *   node watchdog.js open
 *   node watchdog.js close
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MODE = (process.argv[2] || "open").toLowerCase();
if (!["open", "close"].includes(MODE)) {
  console.error(`usage: node watchdog.js open|close  (got "${process.argv[2]}")`);
  process.exit(2);
}

// Each bot's log line starts "[YYYY-MM-DD HH:MM ET]" — same format in all three.
const BOTS = [
  { name: "Bot B", dir: "bot b", log: "stockbot.log" },
  { name: "Bot C", dir: "bot c", log: "stockbot.log" },
  { name: "Bot E", dir: "swing", log: "swingbot.log" },
];

// Bot E holds overnight by design, so "flat at the close" is not a failure for
// it — only the ORB bots are swept. Keep this in sync with the account layout.
const FLATTENS_EOD = new Set(["Bot B", "Bot C"]);

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function etNow() {
  const p = {};
  for (const x of etFmt.formatToParts(new Date())) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}

function readEnv(dir) {
  const path = join(ROOT, dir, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].split("#")[0].trim();
  }
  return out;
}

/**
 * Latest cycle this bot logged today, in ET minutes past midnight — or null if
 * it never ran. Reads only the tail: these logs reach 600KB+ over a month.
 */
function lastCycleToday(dir, logName, today) {
  const path = join(ROOT, dir, logName);
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  const tail = buf.subarray(Math.max(0, buf.length - 200_000)).toString("utf8");
  let last = null;
  const re = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}) ET\]/gm;
  for (let m; (m = re.exec(tail)); )
    if (m[1] === today) last = +m[2] * 60 + +m[3];
  return last;
}

async function alpaca(env, path) {
  const base = (env.APCA_BASE_URL || "https://paper-api.alpaca.markets").replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(base + path, {
      headers: {
        "APCA-API-KEY-ID": env.APCA_API_KEY_ID,
        "APCA-API-SECRET-KEY": env.APCA_API_SECRET_KEY,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Any bot's token reaches the shared chat; all three post to the same one.
async function telegram(text) {
  for (const b of BOTS) {
    const env = readEnv(b.dir);
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) continue;
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (body?.ok) return true;
      console.log(`  telegram via ${b.name}: ${res.status} ${body?.description || "failed"}`);
    } catch (e) {
      console.log(`  telegram via ${b.name}: ${e.message}`);
    }
  }
  console.log("  !! no Telegram route worked — alert not delivered");
  return false;
}

// The market calendar decides whether silence is a fault or a weekend. Ask the
// broker rather than guessing at holidays.
async function isTradingDay(today) {
  for (const b of BOTS) {
    const env = readEnv(b.dir);
    if (!env.APCA_API_KEY_ID) continue;
    try {
      const days = await alpaca(env, `/v2/calendar?start=${today}&end=${today}`);
      return Array.isArray(days) && days.length > 0;
    } catch { /* try the next account's keys */ }
  }
  return null; // no account answered — don't claim a verdict either way
}

/**
 * Is the machine still able to wake itself for a task?
 *
 * setup-laptop.ps1 enables wake timers, yet they were found disabled on
 * 2026-08-04 and again on 2026-08-26 — a Windows update or a power-plan switch
 * reverts them, silently, and every task's WakeToRun flag goes inert. That is a
 * fault you can only see BEFORE it costs a session, so check it rather than
 * waiting to infer it from a day of missing log lines.
 *
 * Returns a fault string, or null when the setting is fine or unreadable.
 */
function wakeTimerFault() {
  try {
    const out = execFileSync("powercfg", ["/query", "SCHEME_CURRENT", "SUB_SLEEP", "RTCWAKE"], {
      encoding: "utf8", timeout: 10_000,
    });
    const ac = /Current AC Power Setting Index:\s*(0x[0-9a-f]+)/i.exec(out);
    if (ac && Number(ac[1]) === 0)
      return "Windows: 'Allow wake timers' is DISABLED on AC — scheduled tasks cannot wake this machine, so a sleeping desktop will miss the whole session. Re-run setup-laptop.ps1 elevated.";
    return null;
  } catch {
    return null; // powercfg unavailable — not worth a false alarm
  }
}

async function main() {
  const now = etNow();
  const trading = await isTradingDay(now.date);
  if (trading === false) {
    console.log(`[watchdog ${MODE}] ${now.date} is not a trading day — nothing to check.`);
    return;
  }
  if (trading === null) console.log("[watchdog] could not reach the calendar — checking anyway.");

  // The cycle must have happened by these times for the session to be intact.
  const deadline = MODE === "open" ? 9 * 60 + 35 : 15 * 60 + 50;
  const label = MODE === "open" ? "09:35" : "15:50";
  const faults = [];

  const wake = wakeTimerFault();
  if (wake) faults.push(wake);
  else console.log("  wake timers: enabled — ok");

  for (const b of BOTS) {
    const last = lastCycleToday(b.dir, b.log, now.date);
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

    if (last === null) faults.push(`${b.name}: NO cycle logged today — the task never ran.`);
    else if (last < deadline) faults.push(`${b.name}: last cycle ${hhmm(last)}, nothing since (expected one past ${label}).`);
    else console.log(`  ${b.name}: last cycle ${hhmm(last)} — ok`);

    // An unflattened book is the failure that actually costs money, so check the
    // broker rather than trusting the log.
    if (MODE === "close" && FLATTENS_EOD.has(b.name)) {
      const env = readEnv(b.dir);
      try {
        const pos = await alpaca(env, "/v2/positions");
        if (pos.length)
          faults.push(`${b.name}: ${pos.length} POSITION(S) STILL OPEN after the close — ${pos.map((p) => `${p.symbol} ${p.qty}`).join(", ")}. Run run-flatten-cleanup.cmd at the next open.`);
        else console.log(`  ${b.name}: flat — ok`);
      } catch (e) {
        faults.push(`${b.name}: could not read positions to confirm the flatten (${e.message}).`);
      }
    }
  }

  if (!faults.length) {
    console.log(`[watchdog ${MODE}] ${now.date} ${hhmmOf(now.min)} — all clear.`);
    return;
  }
  const text = `WATCHDOG (${MODE}) ${now.date}\n\n${faults.join("\n")}`;
  console.log(text);
  await telegram(text);
  process.exitCode = 1; // surfaces in Task Scheduler's Last Run Result too
}

function hhmmOf(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

main().catch(async (e) => {
  console.error("watchdog error:", e.message);
  await telegram(`WATCHDOG (${MODE}) crashed: ${e.message}`);
  process.exitCode = 1;
});
