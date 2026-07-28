/**
 * Pre-market regime determination — decides which DIRECTION the ORB bots are
 * allowed to trade today, and writes it to `regime.json` for them to read.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bots' direction has always been a static per-account env flag (ORB_LONGS /
 * ORB_SHORTS): B is long+short forever, C is short-only forever. That ignores
 * the tape. The two-month forward test's most useful signal was that B's SHORT
 * sleeve made +$217 (PF 1.31) while its LONG sleeve lost $270 (PF 0.67) on the
 * same data, timing and regime — i.e. side selection mattered more than the
 * entry rule did. This gives that selection a daily input instead of a constant.
 *
 * It is deliberately SEPARATE from the intraday SPY-vs-VWAP gate in stockbot.js.
 * That one asks "is the tape with me right now"; this one asks "what kind of day
 * is this" before the open. Both apply — see "How the bots consume it" below.
 *
 * WHAT IT READS (all via Alpaca, all headless — no TradingView, no browser)
 *   - /v1beta1/news        headlines from the last REGIME_NEWS_HOURS (default 18)
 *   - SPY  daily bars      trend: last close vs its 20-day SMA
 *   - VIXY daily bars      volatility: last close vs its 10-day SMA
 *   - USO  daily bars      energy shock: 5-day change (a geopolitical tell)
 *
 * HOW IT SCORES
 *   score = news + trend + vol + oil, each component logged separately so a bad
 *   call can be attributed rather than guessed at.
 *     score >= +REGIME_THRESHOLD  -> long_only
 *     score <= -REGIME_THRESHOLD  -> short_only
 *     otherwise                   -> both
 *   Auto mode NEVER emits "flat". Standing the bots down entirely is a real
 *   decision with no validated threshold behind it, so it is override-only.
 *
 * !! NOT VALIDATED !!
 * The weights and keyword lists below are a starting hypothesis, not a measured
 * edge. Nothing here has been backtested — this repo deleted a whole bot (D) for
 * being built on numbers nobody checked. Every run appends its full input vector
 * to regime-history.csv precisely so this CAN be measured later against the
 * bots' fills. Until it has been, treat the output as a prior, not an answer.
 *
 * USAGE
 *   node regime.js                     compute + write regime.json (the 8:55 task)
 *   node regime.js --dry               compute + print, write nothing
 *   node regime.js --show              print the current regime.json
 *   node regime.js --set short_only --why "..."      override (see skill)
 *   node regime.js --set both --why "..." --by connor
 *
 * HOW THE BOTS CONSUME IT
 * stockbot.js reads regime.json each cycle and can only ever NARROW what the env
 * flags already permit — same rule as the notional caps, where the smaller of
 * the two wins. A stance of "long_only" cannot switch Bot C into taking longs;
 * it just means Bot C stands down that day. The file is ignored unless its date
 * is today's ET date, so a stale file fails back to plain env behaviour.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Config (env-tunable; defaults are the ones the scheduled task uses) ──
const ENV_FILE = process.env.REGIME_ENV_FILE || join(HERE, "bot b", ".env");
const OUT_FILE = process.env.REGIME_FILE || join(HERE, "regime.json");
const HISTORY = process.env.REGIME_HISTORY || join(HERE, "regime-history.csv");
const NEWS_HOURS = parseFloat(process.env.REGIME_NEWS_HOURS || "18");
const NEWS_MAX = parseInt(process.env.REGIME_NEWS_MAX || "200", 10);
const THRESHOLD = parseFloat(process.env.REGIME_THRESHOLD || "2");

const STANCES = ["both", "long_only", "short_only", "flat"];

// ── .env parsing (no dotenv dependency — this script must run from repo root,
// where there is no node_modules, and it reads a bot folder's existing keys
// rather than introducing a third copy of the same credentials) ──
function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const fileEnv = loadEnvFile(ENV_FILE);
const cfg = (k, d) => process.env[k] || fileEnv[k] || d;

const DATA = cfg("APCA_DATA_URL", "https://data.alpaca.markets");
const KEY = cfg("APCA_API_KEY_ID");
const SECRET = cfg("APCA_API_SECRET_KEY");

// ── ET calendar date, matching stockbot.js's notion of "today" ──
const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
export function etDate(ms = Date.now()) {
  const p = Object.fromEntries(etFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function etStamp(ms = Date.now()) {
  const p = Object.fromEntries(etFmt.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ET`;
}

// ── Alpaca fetch with the same retry posture as alpaca.js: a transient network
// blip must not decide the day's direction by omission. ──
async function api(path, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(DATA + path, {
        headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 200));
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// ── Keyword lexicon ────────────────────────────────────────────────────────
// Geopolitical/systemic terms carry weight 2; ordinary market-tone terms carry
// 1. A headline is counted ONCE per side, at the highest weight it matched, so
// one breathless article can't outvote the rest of the tape by stacking synonyms.
const RISK_OFF = [
  // geopolitical / systemic (weight 2)
  [2, /\b(war|warfare|missile|airstrike|air strike|strikes? on|attack(s|ed|ing)?|invasion|invade[sd]?|escalat\w*|retaliat\w*|sanction\w*|embargo|blockade|nuclear|hostilities|troops|militar(y|ies)|drone strike|terror\w*)\b/i],
  // macro / market stress (weight 1)
  [1, /\b(sell-?off|plunge[sd]?|plummet\w*|crash\w*|tumble[sd]?|slump\w*|rout|correction|bear market|recession|default\w*|shutdown|downgrade[sd]?|tariff\w*|hawkish|contagion|liquidity crisis|credit crunch|layoffs?)\b/i],
  // energy shock phrased as a rise (a rising-oil headline is risk-OFF for equities)
  [2, /\b(oil|crude|brent|wti|energy prices?)\b[^.]{0,40}\b(surge[sd]?|spike[sd]?|soar\w*|jump\w*|rally\w*|climb\w*|high\w*)\b/i],
];
const RISK_ON = [
  // de-escalation (weight 2)
  [2, /\b(cease-?fire|truce|de-?escalat\w*|peace (deal|talks|plan|agreement)|diplomac\w*|armistice|withdraw(al|s|n)?|pause in hostilities|talks resume\w*|agreement reached|deal reached|resolution)\b/i],
  // macro / market relief (weight 1)
  [1, /\b(rally\w*|record high|rebound\w*|recover\w*|dovish|rate cut\w*|cools?|eas(e|es|ed|ing)|optimis\w*|relief|upgrade[sd]?|stimulus|soft landing)\b/i],
];

function scoreHeadline(text) {
  let off = 0;
  let on = 0;
  for (const [w, re] of RISK_OFF) if (re.test(text)) off = Math.max(off, w);
  for (const [w, re] of RISK_ON) if (re.test(text)) on = Math.max(on, w);
  return { off, on };
}

// ── Macro filter ───────────────────────────────────────────────────────────
// Alpaca's news feed is Benzinga, and Benzinga is ~95% single-name earnings and
// analyst actions. Scoring it raw produces garbage: the first live run counted
// "Whistleblower Retaliation Case" as a weight-2 geopolitical hit (retaliat*),
// "Corning's 15% Crash" as market stress, and "UBS Upgrades Medtronic" as
// relief. None of those say anything about the day's regime.
//
// So a headline only votes if it is plausibly MACRO: no ticker at all (wire
// copy), a broad basket (>= 5 tickers), or an index/macro instrument. Analyst
// and earnings boilerplate is dropped outright even when it clears that bar,
// because "Raises FY2026 Guidance" is a company event wearing macro words.
const MACRO_SYMS = new Set([
  "SPY", "QQQ", "DIA", "IWM", "VOO", "IVV", "VTI", "SPX", "NDX",
  "VIXY", "VXX", "UVXY", "USO", "BNO", "GLD", "SLV", "TLT", "IEF", "UUP", "XLE",
]);
const BOILERPLATE =
  /\b(upgrade[sd]?|downgrade[sd]?|maintains?|reiterate[sd]?|initiate[sd]? coverage|price target|analyst|Q[1-4]\s|EPS|guidance|dividend|stock of the day|insider|13[FDG]|offering|IPO|earnings call)\b/i;

function isMacro(n) {
  if (BOILERPLATE.test(n.headline || "")) return false;
  const syms = n.symbols || [];
  if (syms.length === 0) return true;
  if (syms.length >= 5) return true;
  return syms.some((s) => MACRO_SYMS.has(s));
}

// ── Inputs ─────────────────────────────────────────────────────────────────
async function fetchNews() {
  const start = new Date(Date.now() - NEWS_HOURS * 3600 * 1000).toISOString();
  const items = [];
  let pageToken = null;
  do {
    const q = new URLSearchParams({ start, limit: "50", sort: "desc" });
    if (pageToken) q.set("page_token", pageToken);
    const j = await api(`/v1beta1/news?${q}`);
    items.push(...(j.news || []));
    pageToken = j.next_page_token || null;
  } while (pageToken && items.length < NEWS_MAX);
  return items.slice(0, NEWS_MAX);
}

async function dailyCloses(symbol, days) {
  // Ask for generous calendar coverage — `days` is trading days, and holidays,
  // weekends and the free feed's coverage gaps all eat into a naive window.
  const start = new Date(Date.now() - (days + 20) * 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const j = await api(
    `/v2/stocks/${symbol}/bars?timeframe=1Day&start=${start}&limit=1000&feed=iex&adjustment=all`,
  );
  return (j.bars || []).map((b) => b.c);
}

const sma = (arr, n) => {
  if (arr.length < n) return null;
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
};
const pctChange = (arr, n) => {
  if (arr.length < n + 1) return null;
  const then = arr[arr.length - 1 - n];
  const now = arr[arr.length - 1];
  return then ? ((now - then) / then) * 100 : null;
};

// ── Scoring ────────────────────────────────────────────────────────────────
export async function computeRegime() {
  const notes = [];

  // News component: net weighted risk tone over the window, damped by /3 and
  // clamped to ±3 so a noisy news day can move the call but never own it alone.
  let news = { score: 0, off: 0, on: 0, total: 0, macro: 0, topOff: [], topOn: [] };
  try {
    const items = await fetchNews();
    const macro = items.filter(isMacro);
    let off = 0;
    let on = 0;
    for (const n of macro) {
      // Score the headline only. Summaries drag in unrelated boilerplate and
      // triple the false-match rate for no gain in signal.
      const s = scoreHeadline(n.headline || "");
      if (s.off > s.on) {
        off += s.off;
        if (news.topOff.length < 5) news.topOff.push(n.headline);
      } else if (s.on > s.off) {
        on += s.on;
        if (news.topOn.length < 5) news.topOn.push(n.headline);
      }
    }
    const raw = off - on;
    news = { ...news, off, on, total: items.length, macro: macro.length, score: Math.max(-3, Math.min(3, -raw / 2)) };
    // NOTE the sign: raw is risk-OFF minus risk-ON, so a positive raw is bearish
    // and must push the score NEGATIVE (toward short_only).
  } catch (e) {
    notes.push(`news unavailable (${e.message}) — component 0`);
  }

  // Trend component: SPY above its 20-day SMA is the single most durable
  // long/short discriminator available for free, so it gets the largest fixed weight.
  let trend = { score: 0, last: null, sma20: null };
  try {
    const spy = await dailyCloses("SPY", 20);
    const s20 = sma(spy, 20);
    const last = spy[spy.length - 1];
    if (s20 && last) trend = { score: last >= s20 ? 1.5 : -1.5, last, sma20: s20 };
    else notes.push("SPY trend unavailable — component 0");
  } catch (e) {
    notes.push(`SPY trend failed (${e.message}) — component 0`);
  }

  // Volatility component: VIXY as a tradable proxy for VIX (Alpaca serves no
  // index quotes). A spike is asymmetric — it argues for shorts far more
  // strongly than a calm tape argues for longs, so the weights are asymmetric too.
  let vol = { score: 0, last: null, sma10: null, pct: null };
  try {
    const vixy = await dailyCloses("VIXY", 10);
    const s10 = sma(vixy, 10);
    const last = vixy[vixy.length - 1];
    if (s10 && last) {
      const pct = ((last - s10) / s10) * 100;
      vol = { score: pct > 10 ? -1.5 : pct < -10 ? 0.5 : 0, last, sma10: s10, pct };
    } else notes.push("VIXY unavailable — component 0");
  } catch (e) {
    notes.push(`VIXY failed (${e.message}) — component 0`);
  }

  // Energy component: a fast oil move is the cleanest market-side confirmation
  // that a Middle East headline is actually being priced rather than just written.
  let oil = { score: 0, pct5d: null };
  try {
    const uso = await dailyCloses("USO", 6);
    const p = pctChange(uso, 5);
    if (p !== null) oil = { score: p > 5 ? -1 : p < -5 ? 0.5 : 0, pct5d: p };
    else notes.push("USO unavailable — component 0");
  } catch (e) {
    notes.push(`USO failed (${e.message}) — component 0`);
  }

  const score = news.score + trend.score + vol.score + oil.score;
  const stance = score >= THRESHOLD ? "long_only" : score <= -THRESHOLD ? "short_only" : "both";

  return {
    date: etDate(),
    stance,
    source: "auto",
    score: Number(score.toFixed(2)),
    threshold: THRESHOLD,
    components: {
      news: Number(news.score.toFixed(2)),
      trend: trend.score,
      vol: vol.score,
      oil: oil.score,
    },
    inputs: {
      news: { headlines: news.total, macroHeadlines: news.macro, riskOffWeight: news.off, riskOnWeight: news.on, sampleOff: news.topOff, sampleOn: news.topOn },
      spy: { last: trend.last, sma20: trend.sma20 },
      vixy: { last: vol.last, sma10: vol.sma10, pctVsSma: vol.pct === null ? null : Number(vol.pct.toFixed(2)) },
      uso: { pct5d: oil.pct5d === null ? null : Number(oil.pct5d.toFixed(2)) },
    },
    notes,
    computedAt: etStamp(),
  };
}

// ── Persistence ────────────────────────────────────────────────────────────
function readRegime() {
  if (!existsSync(OUT_FILE)) return null;
  try {
    return JSON.parse(readFileSync(OUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeRegime(obj) {
  writeFileSync(OUT_FILE, JSON.stringify(obj, null, 2) + "\n");
}

// One row per run, so the stance and every input behind it can be replayed
// against the bots' actual fills later. This is the whole point of the file:
// without it the heuristic above can never be judged, only believed.
function appendHistory(r) {
  const head = "date,computedAt,stance,source,score,news,trend,vol,oil,headlines,macroHeadlines,riskOff,riskOn,spyLast,spySma20,vixyPctVsSma,usoPct5d,why\n";
  if (!existsSync(HISTORY)) appendFileSync(HISTORY, head);
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const i = r.inputs || {};
  appendFileSync(
    HISTORY,
    [
      // For an override row this is when the DECISION was made, not when the
      // auto block it inherited was computed — otherwise the audit trail says a
      // human intervened before they actually did.
      r.date, q(r.overriddenAt || r.computedAt), r.stance, r.source, r.score,
      r.components?.news, r.components?.trend, r.components?.vol, r.components?.oil,
      i.news?.headlines, i.news?.macroHeadlines, i.news?.riskOffWeight, i.news?.riskOnWeight,
      i.spy?.last?.toFixed?.(2) ?? "", i.spy?.sma20?.toFixed?.(2) ?? "",
      i.vixy?.pctVsSma ?? "", i.uso?.pct5d ?? "", q(r.why || ""),
    ].join(",") + "\n",
  );
}

// Telegram, inlined rather than imported: notify.js lives inside "bot b", whose
// path contains a space, and importing across it from the repo root is fragile
// on Windows. Failure here must never affect the stance that was already written.
async function notify(text) {
  const token = cfg("TELEGRAM_BOT_TOKEN");
  const chat = cfg("TELEGRAM_CHAT_ID");
  if (!token || !chat) return;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: `[Regime] ${text}`, disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
  } catch {
    /* best effort */
  } finally {
    clearTimeout(t);
  }
}

function describe(r) {
  const c = r.components || {};
  return (
    `${r.date} stance=${r.stance} (${r.source}) score=${r.score}\n` +
    `  news ${c.news}  trend ${c.trend}  vol ${c.vol}  oil ${c.oil}  [threshold ±${r.threshold}]\n` +
    (r.why ? `  why: ${r.why}\n` : "") +
    (r.notes?.length ? `  notes: ${r.notes.join("; ")}\n` : "")
  );
}

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return null;
  const a = argv[i];
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "";
};
const has = (name) => argv.includes(`--${name}`);

async function main() {
  if (!KEY || !SECRET) {
    console.error(`No Alpaca keys. Looked in ${ENV_FILE} (override with REGIME_ENV_FILE).`);
    process.exit(1);
  }

  if (has("show")) {
    const r = readRegime();
    if (!r) return console.log("no regime.json yet");
    console.log(describe(r));
    console.log(JSON.stringify(r.inputs, null, 2));
    return;
  }

  // Override path. Preserves the auto block it replaces, so the history keeps a
  // record of what the script thought before a human/Claude disagreed with it.
  const set = flag("set");
  if (set !== null) {
    if (!STANCES.includes(set)) {
      console.error(`--set must be one of: ${STANCES.join(", ")}`);
      process.exit(1);
    }
    const why = flag("why") || "";
    if (!why) {
      console.error('--set requires --why "reason" (the reason is written to regime-history.csv)');
      process.exit(1);
    }
    const prev = readRegime();
    const stale = !prev || prev.date !== etDate();
    const out = {
      ...(stale ? {} : prev),
      date: etDate(),
      stance: set,
      source: flag("by") || "claude",
      why,
      overriddenAt: etStamp(),
      auto: stale ? null : { stance: prev.stance, score: prev.score, components: prev.components },
    };
    writeRegime(out);
    appendHistory(out);
    console.log(describe(out));
    if (!has("quiet")) await notify(`${out.date} OVERRIDE -> ${set} (${out.source}): ${why}`);
    return;
  }

  const r = await computeRegime();
  console.log(describe(r));
  if (has("dry")) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  writeRegime(r);
  appendHistory(r);
  if (!has("quiet")) {
    const c = r.components;
    await notify(
      `${r.date} stance=${r.stance} score=${r.score} (news ${c.news}, trend ${c.trend}, vol ${c.vol}, oil ${c.oil})`,
    );
  }
}

// Only run the CLI when invoked directly — stockbot.js imports etDate from here.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("regime failed:", e.message);
    process.exit(1);
  });
}
