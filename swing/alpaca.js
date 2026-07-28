/**
 * Alpaca helpers for Bot E (PAPER). Same retry policy and failure taxonomy as
 * `bot b/alpaca.js` — deliberately a sibling copy rather than a shared import,
 * because every bot folder in this repo is self-contained and can be run or
 * moved on its own.
 *
 * What is NEW here, and why:
 *   - `placeOco()`   — the exit pair for a HELD position, time_in_force GTC.
 *                      The ORB bots use bracket + DAY because they flatten at
 *                      15:50. A swing position lives for days, so the stop and
 *                      target must survive the close; a DAY bracket would
 *                      expire overnight and leave the position naked exactly
 *                      when the gap risk shows up.
 *   - `replaceOrder()` — PATCH a resting leg so the breakeven ratchet can raise
 *                      the stop without a cancel/replace window where the
 *                      position is unprotected.
 *   - `dailyBars()`  — 1Day bars; this strategy never looks at 5-minute data.
 *   - `getActivities()` — FILL records, the only trustworthy P/L source in this
 *                      repo (see POSTMORTEM-BOT-A.md §1).
 */
import "dotenv/config";

const BASE = process.env.APCA_BASE_URL || "https://paper-api.alpaca.markets";
const DATA = process.env.APCA_DATA_URL || "https://data.alpaca.markets";
const H = {
  "APCA-API-KEY-ID": process.env.APCA_API_KEY_ID,
  "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
};

const RETRIES = parseInt(process.env.APCA_RETRIES || "3", 10);
const RETRY_MS = parseInt(process.env.APCA_RETRY_MS || "800", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AlpacaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "AlpacaError";
    this.status = status;
    this.body = body;
  }
}

async function api(base, path, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt) await sleep(RETRY_MS * attempt);
    let res;
    try {
      res = await fetch(base + path, {
        headers: { ...H, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        ...opts,
      });
    } catch (e) {
      lastErr = new AlpacaError(`Alpaca ${path} network: ${e.message}`, 0, null);
      continue; // network blips are transient — retry
    }
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = { raw: text };
    }
    if (res.ok) return j;
    const err = new AlpacaError(`Alpaca ${path} ${res.status}: ${text.slice(0, 200)}`, res.status, j);
    if (res.status !== 429 && res.status < 500) throw err; // a broker decision, not a blip
    lastErr = err;
  }
  throw lastErr;
}

// ── account / positions ──
export const getClock = () => api(BASE, "/v2/clock");
export const getAccount = () => api(BASE, "/v2/account");
export const getPositions = () => api(BASE, "/v2/positions");
export const getAsset = (symbol) => api(BASE, `/v2/assets/${symbol}`);
export const closePosition = (symbol) =>
  api(BASE, `/v2/positions/${symbol}`, { method: "DELETE" });

// ── cross-instance duplicate guard ──────────────────────────────────────────
// On 2026-07-28 two machines ran the schedule against the same accounts (the
// desktop had been given the tasks while the laptop's were still enabled). The
// ORB bots each sent every order twice, ~1s apart, and opened every position at
// 2x size. Bot E escaped only because it had no signal that day — but its
// scanner DID run twice (two identical blocks in swing-scan.log), so the next
// signal would have doubled too. This bot is the one that holds overnight, so a
// silent 2x here compounds for days rather than being flattened at 15:55.
//
// Nothing local can prevent it: the other machine has its own state file and
// its own log, and OneDrive is last-writer-wins on both. The BROKER is the only
// shared point of truth, and Alpaca enforces uniqueness on client_order_id
// (verified: a repeat returns HTTP 422 code 42210000 "client_order_id must be
// unique"). So derive that id from the trade's IDENTITY — bot, session date,
// symbol, leg — and the twin's submission is rejected instead of filled.
export function coid(...parts) {
  return parts
    .filter((p) => p != null && p !== "")
    .join("-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 128);
}

// True when the broker refused an order because that client_order_id already
// exists — i.e. this exact trade was already placed, almost certainly by
// another instance. Harmless to us; loud, because it means a twin IS running.
export function isDuplicateOrder(e) {
  if (!e) return false;
  const code = e.body && e.body.code;
  if (code === 42210000) return true;
  return e.status === 422 && /client_order_id must be unique/i.test(e.message || "");
}

// An order id that is dead at the broker holds no shares and blocks nothing.
export const ORDER_DEAD = /^(rejected|canceled|cancelled|expired|done_for_day|replaced|suspended)$/i;

// ── orders ──
export const placeOrder = (body) =>
  api(BASE, "/v2/orders", { method: "POST", body: JSON.stringify(body) });
export const getOrders = (query = "") => api(BASE, `/v2/orders${query}`);
export const getOrder = (id) => api(BASE, `/v2/orders/${id}`);
// Look an order up by the id WE chose, to tell a live twin order apart from our
// own earlier attempt that the broker rejected (safe to re-send under a new id).
export const getOrderByClientId = (cid) =>
  api(BASE, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`);
export const cancelOrder = (id) => api(BASE, `/v2/orders/${id}`, { method: "DELETE" });
export const cancelAllOrders = () => api(BASE, "/v2/orders", { method: "DELETE" });

export const placeMarket = ({ symbol, qty, side, clientOrderId }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side,
    type: "market",
    time_in_force: "day",
    ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
  });

/**
 * OCO exit pair over an EXISTING position. One fills, the broker cancels the
 * other, and both rest GTC so they survive overnight — the reason this bot can
 * hold for days without babysitting.
 *
 * `side` is the CLOSING side: "sell" to exit a long, "buy" to cover a short.
 */
export const placeOco = ({ symbol, qty, side, takeProfit, stopLoss, clientOrderId }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side,
    type: "limit",
    time_in_force: "gtc",
    order_class: "oco",
    take_profit: { limit_price: takeProfit.toFixed(2) },
    stop_loss: { stop_price: stopLoss.toFixed(2) },
    ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
  });

/** PATCH a resting leg in place (used to raise the stop). */
export const replaceOrder = (id, body) =>
  api(BASE, `/v2/orders/${id}`, { method: "PATCH", body: JSON.stringify(body) });

// ── market data ──
export const snapshots = (symbols) =>
  api(DATA, `/v2/stocks/snapshots?symbols=${symbols.join(",")}&feed=iex`);
export const mostActives = (top = 25) =>
  api(DATA, `/v1beta1/screener/stocks/most-actives?top=${top}`);

/**
 * Daily bars, oldest→newest. `adjustment=split` so a reverse split does NOT
 * silently turn a $5 entry into a $51 exit — the exact bug that once reported a
 * −$53 account as −$3,403 (see the repo README, "Measurement").
 */
export async function dailyBars(symbol, startISO, endISO) {
  const q = new URLSearchParams({
    timeframe: "1Day",
    start: startISO,
    limit: "10000",
    feed: "iex",
    adjustment: "split",
  });
  if (endISO) q.set("end", endISO);
  const out = [];
  let pageToken = null;
  do {
    if (pageToken) q.set("page_token", pageToken);
    const j = await api(DATA, `/v2/stocks/${symbol}/bars?${q}`);
    for (const b of j.bars || [])
      out.push({ time: new Date(b.t).getTime(), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    pageToken = j.next_page_token || null;
  } while (pageToken);
  return out;
}

/**
 * Daily bars for MANY symbols in one call. The scanner gates ~60 names every
 * morning; one request per name would be 60 round trips against a 200/min free
 * limit, so batch them. Returns `{ SYM: bars[] }`, oldest→newest per symbol.
 */
export async function dailyBarsMulti(symbols, startISO, endISO, chunk = 50) {
  const out = {};
  for (let i = 0; i < symbols.length; i += chunk) {
    const slice = symbols.slice(i, i + chunk);
    const q = new URLSearchParams({
      symbols: slice.join(","),
      timeframe: "1Day",
      start: startISO,
      limit: "10000",
      feed: "iex",
      adjustment: "split",
    });
    if (endISO) q.set("end", endISO);
    let pageToken = null;
    do {
      if (pageToken) q.set("page_token", pageToken);
      const j = await api(DATA, `/v2/stocks/bars?${q}`);
      for (const [sym, bars] of Object.entries(j.bars || {})) {
        out[sym] ||= [];
        for (const b of bars)
          out[sym].push({ time: new Date(b.t).getTime(), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      }
      pageToken = j.next_page_token || null;
    } while (pageToken);
  }
  for (const bars of Object.values(out)) bars.sort((a, b) => a.time - b.time);
  return out;
}

/** Broker FILL activities — the source of truth for any P/L claim. */
export async function getActivities(afterISO, pageSize = 100) {
  const out = [];
  let pageToken = null;
  do {
    const q = new URLSearchParams({ activity_types: "FILL", page_size: String(pageSize) });
    if (afterISO) q.set("after", afterISO);
    if (pageToken) q.set("page_token", pageToken);
    const j = await api(BASE, `/v2/account/activities?${q}`);
    const rows = Array.isArray(j) ? j : [];
    out.push(...rows);
    pageToken = rows.length === pageSize ? rows[rows.length - 1].id : null;
  } while (pageToken);
  return out;
}
