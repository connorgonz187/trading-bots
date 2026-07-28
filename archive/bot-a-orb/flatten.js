/**
 * One-off flatten — cancel all resting orders and close every open position for
 * THIS account, using the same held_for_orders-safe sequence as stockbot.js's
 * EOD flatten (cancel -> wait for cancels to settle -> close with retry).
 *
 * Use it to clear positions stranded by a prior failed flatten. Run it when the
 * market is open (paper market orders only fill during RTH):
 *
 *   cd "bot a"; node flatten.js
 *
 * Paper account only (APCA_BASE_URL is the paper endpoint) — cannot touch real money.
 */
import "dotenv/config";
import { existsSync, writeFileSync, appendFileSync } from "fs";
import {
  getClock,
  getPositions,
  getOrders,
  getOrder,
  cancelAllOrders,
  closePosition,
} from "./alpaca.js";
import { sendSms } from "./notify.js";

const TAG = process.env.BOT_NAME || "bot";
const TRADELOG = process.env.STOCK_TRADELOG || "stock-trades.csv";

// Same tradelog format stockbot.js uses, so manual cleanups are auditable in the
// CSV instead of vanishing (a position cleared here on a later day is never seen
// by stockbot's exit-detection, which only reconciles same-day state).
function logTrade(cols) {
  if (!existsSync(TRADELOG))
    writeFileSync(TRADELOG, "Date,Time(ET),Symbol,Side,Action,Qty,Price,Notional,Reason,OrderID\n");
  appendFileSync(TRADELOG, cols.join(",") + "\n");
}

const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
function etNow() {
  const p = {};
  for (const x of etFmt.formatToParts(new Date())) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

async function waitFill(id, tries = 6, ms = 600) {
  let o;
  for (let i = 0; i < tries; i++) {
    o = await getOrder(id);
    if (o.status === "filled") return o;
    if (["canceled", "rejected", "expired"].includes(o.status)) return o;
    await new Promise((r) => setTimeout(r, ms));
  }
  return o;
}

async function waitOrdersCleared(tries = 10, ms = 500) {
  for (let i = 0; i < tries; i++) {
    const open = await getOrders("?status=open").catch(() => null);
    if (Array.isArray(open) && open.length === 0) return true;
    await new Promise((r) => setTimeout(r, ms));
  }
  return false;
}

async function closePositionConfirmed(symbol, tries = 4, ms = 700) {
  for (let i = 0; i < tries; i++) {
    try {
      const order = await closePosition(symbol);
      const filled = order && order.id ? await waitFill(order.id).catch(() => null) : null;
      if (filled && filled.status === "filled") return filled;
    } catch (e) {
      if (!/40310000|held_for_orders|\b403\b/.test(e.message)) throw e;
      await cancelAllOrders().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, ms));
  }
  return null;
}

async function main() {
  const clock = await getClock();
  if (!clock.is_open) {
    console.log(`[${TAG}] market CLOSED (next open ${clock.next_open}). Market orders won't fill now — run this during regular hours.`);
    return;
  }
  const positions = await getPositions();
  if (!positions.length) {
    console.log(`[${TAG}] no open positions — nothing to flatten.`);
    return;
  }
  console.log(`[${TAG}] flattening ${positions.length}: ${positions.map((p) => `${p.symbol}(${p.qty})`).join(", ")}`);

  await cancelAllOrders().catch(() => {});
  await waitOrdersCleared();

  for (const p of positions) {
    try {
      const filled = await closePositionConfirmed(p.symbol);
      if (!filled || filled.status !== "filled") {
        console.log(`  ${p.symbol}: close not confirmed (status ${filled ? filled.status : "no-order"}) — retry.`);
        continue;
      }
      const px = +filled.filled_avg_price || Number(p.current_price);
      const pnl = Number(p.unrealized_pl || 0);
      const side = Number(p.qty) < 0 ? "short" : "long";
      const qty = Math.abs(Math.floor(+filled.filled_qty)) || Math.abs(Number(p.qty));
      const t = etNow();
      logTrade([t.date, t.time, p.symbol, side, "EXIT", qty, px.toFixed(2), "", "manual-flatten", ""]);
      console.log(`  flattened ${p.symbol} ${filled.filled_qty}sh @ ${px.toFixed(2)} | uP/L was $${pnl.toFixed(2)}`);
      await sendSms(`FLATTEN ${p.symbol} @ $${px.toFixed(2)} (one-off cleanup)`);
    } catch (e) {
      console.log(`  ${p.symbol} flatten failed: ${e.message}`);
    }
  }
  const left = await getPositions();
  console.log(left.length ? `[${TAG}] still open: ${left.map((p) => p.symbol).join(", ")}` : `[${TAG}] all flat ✅`);
}

main().catch((e) => {
  console.error("flatten error:", e.message);
  process.exitCode = 1;
});
