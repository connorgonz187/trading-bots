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
// Asset metadata — `shortable`/`tradable` tell us up front whether a short will
// be accepted, so we can skip hard-to-borrow names instead of eating a 422.
export const getAsset = (symbol) => api(BASE, `/v2/assets/${symbol}`);
export const cancelAllOrders = () =>
  api(BASE, "/v2/orders", { method: "DELETE" });

// Bracket order: market buy that, once filled, leaves a resting take-profit
// (limit) + stop-loss (stop) pair at the broker — they fill INTRABAR, so no
// 5-min polling slippage on exits.
export const placeBracketBuy = ({ symbol, qty, takeProfit, stopLoss }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side: "buy",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: takeProfit.toFixed(2) },
    stop_loss: { stop_price: stopLoss.toFixed(2) },
  });

// Mirror of the above for a SHORT: market sell opens the short, the resting
// take-profit (limit BELOW entry) + stop-loss (stop ABOVE entry) close it.
export const placeBracketSell = ({ symbol, qty, takeProfit, stopLoss }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side: "sell",
    type: "market",
    time_in_force: "day",
    order_class: "bracket",
    take_profit: { limit_price: takeProfit.toFixed(2) },
    stop_loss: { stop_price: stopLoss.toFixed(2) },
  });

// Plain market order (used as the entry leg in trailing mode).
export const placeMarket = ({ symbol, qty, side }) =>
  placeOrder({ symbol, qty: String(qty), side, type: "market", time_in_force: "day" });

// Native broker-side trailing stop — ratchets with the price, fills intrabar.
// trailPrice is the $ distance the stop trails behind the best price.
export const placeTrailingStop = ({ symbol, qty, side, trailPrice }) =>
  placeOrder({
    symbol,
    qty: String(qty),
    side,
    type: "trailing_stop",
    time_in_force: "day",
    trail_price: trailPrice.toFixed(2),
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
