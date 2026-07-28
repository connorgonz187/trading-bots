/**
 * Alpaca historical stock bars → same candle shape the backtest engine uses
 * ({time,open,high,low,close,volume}), with disk caching in data/.
 *
 * Free Alpaca data is delayed ~15 min, so we end queries an hour back to avoid
 * "subscription does not permit recent data" errors. Bars are split/dividend
 * adjusted (adjustment=all).
 */
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const DATA = process.env.APCA_DATA_URL || "https://data.alpaca.markets";
const headers = {
  "APCA-API-KEY-ID": process.env.APCA_API_KEY_ID,
  "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
};
const TF = { "1m": "1Min", "5m": "5Min", "15m": "15Min", "1H": "1Hour", "1D": "1Day" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchStockBars(symbol, tf, days, feed = "sip") {
  const timeframe = TF[tf] || "1Day";
  const end = new Date(Date.now() - 60 * 60 * 1000);
  const start = new Date(Date.now() - days * 86400000);
  const out = [];
  let pageToken = null;
  let guard = 0;
  do {
    const u = new URL(`${DATA}/v2/stocks/${symbol}/bars`);
    u.searchParams.set("timeframe", timeframe);
    u.searchParams.set("start", start.toISOString());
    u.searchParams.set("end", end.toISOString());
    u.searchParams.set("limit", "10000");
    u.searchParams.set("feed", feed);
    u.searchParams.set("adjustment", "all");
    if (pageToken) u.searchParams.set("page_token", pageToken);
    const res = await fetch(u, { headers });
    if (!res.ok) throw new Error(`Alpaca data ${res.status}: ${await res.text()}`);
    const j = await res.json();
    for (const b of j.bars || [])
      out.push({
        time: new Date(b.t).getTime(),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      });
    pageToken = j.next_page_token;
    if (pageToken) await sleep(150);
  } while (pageToken && guard++ < 500);
  out.sort((a, b) => a.time - b.time);
  return out;
}

export async function loadStockCandles(symbol, tf, days, feed = "sip") {
  if (!existsSync("data")) mkdirSync("data");
  const f = `data/${symbol}-${tf}.json`;
  if (existsSync(f)) {
    const c = JSON.parse(readFileSync(f, "utf8"));
    if (c.length > 1) {
      const span = (c[c.length - 1].time - c[0].time) / 86400000;
      if (span >= days - 3) return c;
    }
  }
  const c = await fetchStockBars(symbol, tf, days, feed);
  writeFileSync(f, JSON.stringify(c));
  return c;
}
