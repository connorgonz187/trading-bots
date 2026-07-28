/**
 * Alpaca trading + data helpers (PAPER). Used by scan.js and stockbot.js.
 * Everything points at the paper endpoint, so nothing here can touch real money.
 */
import "dotenv/config";

const BASE = process.env.APCA_BASE_URL || "https://paper-api.alpaca.markets";
const DATA = process.env.APCA_DATA_URL || "https://data.alpaca.markets";
const H = {
  "APCA-API-KEY-ID": process.env.APCA_API_KEY_ID,
  "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
};

// Transient-failure policy. A bare `fetch()` rejection ("fetch failed" — DNS
// blip, dropped Wi-Fi, TLS reset) used to kill the whole 5-min cycle: the throw
// escaped main() and the run exited before placing or reconciling anything.
// Over Jun–Jul 2026 that cost 213 cycles per account (~8% of the session).
// So: retry network errors, 429s and 5xx with backoff. 4xx (other than 429) is
// a real rejection — a bad order, a non-shortable asset — and must NOT retry.
const RETRIES = parseInt(process.env.APCA_RETRIES || "3", 10);
const RETRY_MS = parseInt(process.env.APCA_RETRY_MS || "800", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Marks an HTTP error so callers can inspect the status without regex-matching
// the message (the shortability gate needs to tell a 422 from a network drop).
class AlpacaError extends Error {
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
    if (attempt) await sleep(RETRY_MS * attempt); // linear backoff: 0.8s, 1.6s, 2.4s
    let res;
    try {
      res = await fetch(base + path, {
        headers: { ...H, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000), // never let a hung socket stall the cycle
        ...opts,
      });
    } catch (e) {
      // Network-layer failure — always worth retrying.
      lastErr = new AlpacaError(`Alpaca ${path} network: ${e.message}`, 0, null);
      continue;
    }
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      j = { raw: text };
    }
    if (res.ok) return j;

    const err = new AlpacaError(
      `Alpaca ${path} ${res.status}: ${text.slice(0, 200)}`,
      res.status,
      j,
    );
    // 429 / 5xx are transient; every other 4xx is a decision by the broker.
    if (res.status !== 429 && res.status < 500) throw err;
    lastErr = err;
  }
  throw lastErr;
}

export { AlpacaError };

// ── Cross-instance duplicate guard ──────────────────────────────────────────
// On 2026-07-28 two copies of this bot ran against the same account (the
// desktop had been given the scheduled tasks while the laptop's were still
// enabled). Each computed the same signal, each sized it off the same equity,
// and each sent its own order ~1s apart: every position opened at 2x size and
// the day's realised loss doubled (B -$162.74, C -$286.68 against a ~-$220
// combined intent). Nothing local can prevent this — the other machine has its
// own state file, its own log, and OneDrive is last-writer-wins on both.
//
// The BROKER is the only shared point of truth, and Alpaca enforces uniqueness
// on client_order_id (verified: a repeat returns HTTP 422 code 42210000
// "client_order_id must be unique"). So derive that id from the trade's
// IDENTITY — bot, session date, symbol, leg — instead of letting Alpaca assign
// a random one. Two instances reaching the same decision produce the same id,
// and the second submission is rejected by the broker rather than filled.
//
// This is a safety net, not a licence to double-run: it stops duplicate ENTRIES
// but the twin still burns API calls and still fights over flatten.
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

// ── Trading ──
export const getClock = () => api(BASE, "/v2/clock");
export const getAccount = () => api(BASE, "/v2/account");
export const getPositions = () => api(BASE, "/v2/positions");
export async function closePosition(symbol) {
  return api(BASE, `/v2/positions/${symbol}`, { method: "DELETE" });
}
export const placeOrder = (body) =>
  api(BASE, "/v2/orders", { method: "POST", body: JSON.stringify(body) });
export const getOrders = (query = "") => api(BASE, `/v2/orders${query}`);
export const getOrder = (id) => api(BASE, `/v2/orders/${id}`);
// Look an order up by the id WE chose. Used to tell the two meanings of a
// duplicate-id rejection apart: a live twin order (another instance beat us to
// it) vs. our own earlier attempt that the broker rejected (safe to re-send
// under a fresh id).
export const getOrderByClientId = (cid) =>
  api(BASE, `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(cid)}`);
// An order id that is dead at the broker holds no shares and blocks nothing.
export const ORDER_DEAD = /^(rejected|canceled|cancelled|expired|done_for_day|replaced|suspended)$/i;
// Asset metadata — `shortable`/`tradable` tell us up front whether a short will
// be accepted, so we can skip hard-to-borrow names instead of eating a 422.
export const getAsset = (symbol) => api(BASE, `/v2/assets/${symbol}`);
export const cancelAllOrders = () =>
  api(BASE, "/v2/orders", { method: "DELETE" });

// Bracket order: market buy that, once filled, leaves a resting take-profit
// (limit) + stop-loss (stop) pair at the broker — they fill INTRABAR, so no
// 5-min polling slippage on exits.
export const placeBracketBuy = ({ symbol, qty, takeProfit, stopLoss, clientOrderId }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side: "buy",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: takeProfit.toFixed(2) },
    stop_loss: { stop_price: stopLoss.toFixed(2) },
    ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
  });

// Mirror of the above for a SHORT: market sell opens the short, the resting
// take-profit (limit BELOW entry) + stop-loss (stop ABOVE entry) close it.
export const placeBracketSell = ({ symbol, qty, takeProfit, stopLoss, clientOrderId }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side: "sell",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: takeProfit.toFixed(2) },
    stop_loss: { stop_price: stopLoss.toFixed(2) },
    ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
  });

// Plain market order (used as the entry leg in trailing mode).
export const placeMarket = ({ symbol, qty, side, clientOrderId }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side,
    type: "market",
    time_in_force: "day",
    ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
  });

// Native broker-side trailing stop — ratchets with the price, fills intrabar.
// trailPrice is the $ distance the stop trails behind the best price.
export const placeTrailingStop = ({ symbol, qty, side, trailPrice, clientOrderId }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side,
    type: "trailing_stop",
    time_in_force: "day",
    trail_price: trailPrice.toFixed(2),
    ...(clientOrderId ? { client_order_id: clientOrderId } : {}),
  });

// ── Screeners (for the scanner) ──
export const mostActives = (top = 25) =>
  api(DATA, `/v1beta1/screener/stocks/most-actives?top=${top}`);
export const movers = (top = 25) =>
  api(DATA, `/v1beta1/screener/stocks/movers?top=${top}`);
export const snapshots = (symbols) =>
  api(DATA, `/v2/stocks/snapshots?symbols=${symbols.join(",")}&feed=iex`);

// ── Recent intraday bars (NOTE: free feed is ~15 min delayed) ──
export async function recentBars(symbol, timeframe = "5Min", startISO) {
  const start = startISO || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const j = await api(
    DATA,
    `/v2/stocks/${symbol}/bars?timeframe=${timeframe}&start=${start}&limit=1000&feed=iex&adjustment=raw`,
  );
  return (j.bars || []).map((b) => ({
    time: new Date(b.t).getTime(),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
}
