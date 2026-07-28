/**
 * Crypto trading bot — Coinbase Advanced.
 *
 * Pulls candles from Coinbase's public API, runs the strategy module named by
 * STRATEGY (default donchian daily breakout), and decides buy / sell / hold.
 * Tracks the one position it opened in position.json — it only ever sells what
 * it itself bought. Paper by default; live orders are latched off in coinbase.js.
 *
 * Run manually:        node bot.js
 * Read-only auth test: node bot.js --check-auth
 * Scheduled:           run-bot.cmd via Windows Task Scheduler (ClaudeTradingBot-Paper)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { makeCoinbaseClient, loadCoinbaseCredsFromFile } from "./coinbase.js";
import { sendSms, smsConfigured } from "./notify.js";
import { pathToFileURL } from "url";

// Load the pluggable strategy module named by the STRATEGY env var (default
// donchian). Modules implement: name, warmup, shouldEnter(window),
// exitLevels(price)?, shouldExit(window, position)?  — same shape backtest.js uses.
async function loadStrategy() {
  const file = process.env.STRATEGY || "strategies/donchian.js";
  const mod = await import("./" + file.replace(/^\.?\//, ""));
  return mod.default && mod.default.shouldEnter ? mod.default : mod;
}

// Coinbase credentials come from either COINBASE_KEY_FILE (the downloaded
// cdp_api_key.json) or the inline COINBASE_API_KEY_NAME/COINBASE_PRIVATE_KEY.
function coinbaseCreds() {
  if (process.env.COINBASE_KEY_FILE) {
    return loadCoinbaseCredsFromFile(process.env.COINBASE_KEY_FILE);
  }
  return {
    apiKeyName: process.env.COINBASE_API_KEY_NAME,
    privateKey: process.env.COINBASE_PRIVATE_KEY,
  };
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  if (!existsSync(".env")) {
    console.log(
      "\nNo .env file found. Copy the template and fill it in:\n" +
        "   Copy-Item .env.example .env   (PowerShell)\n",
    );
    process.exit(0);
  }

  // Coinbase credentials: either the key-file path or the inline name+key.
  const missing = [];
  if (process.env.COINBASE_KEY_FILE) {
    if (!existsSync(process.env.COINBASE_KEY_FILE)) {
      missing.push(`COINBASE_KEY_FILE not found: ${process.env.COINBASE_KEY_FILE}`);
    }
  } else if (
    !process.env.COINBASE_API_KEY_NAME ||
    !process.env.COINBASE_PRIVATE_KEY
  ) {
    missing.push("COINBASE_KEY_FILE, or COINBASE_API_KEY_NAME + COINBASE_PRIVATE_KEY");
  }

  if (missing.length > 0) {
    console.log(`\nMissing Coinbase credentials in .env: ${missing.join(", ")}`);
    console.log("Add them then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\nTrade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTC-USD",
  timeframe: process.env.TIMEFRAME || "1D",
  exchange: "Coinbase",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ─── Market Data (Coinbase Advanced public API — free, no auth) ──────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Pull candles from Coinbase — the venue being traded, so prices match fills.
  const granularityMap = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1H": 3600,
    "6H": 21600,
    "1D": 86400,
  };
  if (!granularityMap[interval]) {
    console.log(
      `Timeframe "${interval}" isn't offered by Coinbase candles ` +
        `(supported: ${Object.keys(granularityMap).join(", ")}). Falling back to 1m.`,
    );
  }
  const granularity = granularityMap[interval] || 60;

  const url = `https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "claude-trading-bot" },
  });
  if (!res.ok) throw new Error(`Coinbase market API error: ${res.status}`);
  const data = await res.json();

  // Coinbase returns rows newest-first as [time(s), low, high, open, close, volume].
  // Take the most recent `limit`, flip to oldest-first, and normalise the shape.
  return data
    .slice(0, limit)
    .reverse()
    .map((k) => ({
      time: k[0] * 1000,
      low: k[1],
      high: k[2],
      open: k[3],
      close: k[4],
      volume: k[5],
    }));
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(
      `Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  // Classify the row by what actually happened this run, not by allPass — an
  // EXIT (sell-to-close) fires on a bearish bias where allPass is false.
  if (logEntry.error) {
    side = (logEntry.side || "").toUpperCase();
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    orderId = "ERROR";
    notes = `Error: ${logEntry.error}`;
  } else if (logEntry.orderPlaced) {
    side = (logEntry.side || "buy").toUpperCase();
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes =
      logEntry.action === "EXIT"
        ? `Exit ${logEntry.exitReason || ""}${logEntry.pnl != null ? ` P/L $${logEntry.pnl.toFixed(2)}` : ""}`.trim()
        : "Entry — conditions met";
  } else if (logEntry.orderId === "STUBBED") {
    mode = "STUBBED";
    orderId = "STUBBED";
    notes = logEntry.note || "Live order stubbed (not sent)";
  } else if (logEntry.action === "HOLD") {
    mode = "HOLD";
    notes = "Holding open position";
  } else {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = logEntry.blockedReason || `Failed: ${failed}`;
  }

  const row = [
    date,
    time,
    CONFIG.exchange,
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  // The CSV is frequently open in Excel (or being synced by OneDrive), which
  // locks it on Windows. Don't let that crash the whole run — the decision is
  // already safely in the JSON audit log either way.
  try {
    if (!existsSync(CSV_FILE)) {
      writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    }
    appendFileSync(CSV_FILE, row + "\n");
    console.log(`Tax record saved → ${CSV_FILE}`);
  } catch (err) {
    if (err.code === "EBUSY" || err.code === "EPERM") {
      console.log(
        `Couldn't write ${CSV_FILE} (likely open in Excel / OneDrive lock). ` +
          `This decision is still recorded in ${LOG_FILE}.`,
      );
    } else {
      throw err;
    }
  }
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Position tracking ───────────────────────────────────────────────────────

// The bot tracks ONLY the position it opened itself, in position.json — so a
// sell-to-exit never touches BTC you hold for other reasons.
const POSITION_FILE = "position.json";

function loadPosition() {
  if (!existsSync(POSITION_FILE)) return null;
  try {
    const p = JSON.parse(readFileSync(POSITION_FILE, "utf8"));
    return p && p.open ? p : null;
  } catch {
    return null;
  }
}

function savePosition(pos) {
  writeFileSync(POSITION_FILE, JSON.stringify(pos, null, 2));
}

function clearPosition() {
  writeFileSync(POSITION_FILE, JSON.stringify({ open: false }, null, 2));
}

// Count only ENTRIES today — exits must never be blocked by the daily cap.
function countTodaysEntries(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced && t.action === "ENTRY",
  ).length;
}

// ─── Order execution (shared by entry + exit) ────────────────────────────────

async function executeOrder({ side, sizeUSD, price, stopLoss, takeProfit, logEntry }) {
  if (CONFIG.paperTrading) {
    console.log(
      `\nPAPER ${side.toUpperCase()} ${CONFIG.symbol} ~$${sizeUSD.toFixed(2)} at market`,
    );
    console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
    logEntry.orderPlaced = true;
    logEntry.orderId = `PAPER-${Date.now()}`;
    return;
  }
  console.log(
    `\nPLACING LIVE ORDER — $${sizeUSD.toFixed(2)} ${side.toUpperCase()} ${CONFIG.symbol}`,
  );
  try {
    const client = makeCoinbaseClient(coinbaseCreds());
    const order = await client.placeOrder(
      CONFIG.symbol,
      side,
      sizeUSD,
      price,
      stopLoss,
      takeProfit,
    );
    if (order.stubbed) {
      console.log(`${order.message}`);
      console.log(
        `   Prepared: ${order.prepared.method} ${order.prepared.path} ${JSON.stringify(order.prepared.body.order_configuration)}`,
      );
      logEntry.orderId = "STUBBED";
      logEntry.note = "Coinbase live order stubbed (not sent)";
    } else {
      logEntry.orderPlaced = true;
      logEntry.orderId =
        order.success_response?.order_id || order.order_id || "unknown";
      console.log(`ORDER PLACED — ${logEntry.orderId}`);
    }
  } catch (err) {
    console.log(`ORDER FAILED — ${err.message}`);
    logEntry.error = err.message;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "PAPER TRADING" : "LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load the configured strategy module (same interface as the backtester).
  const strat = await loadStrategy();
  console.log(`\nStrategy: ${strat.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load decision log + any open position the bot is managing. We always fetch
  // data and evaluate — even at the daily entry cap — so an open position can
  // still be EXITED.
  const log = loadLog();
  const position = loadPosition();

  console.log(
    `\n── Fetching market data from ${CONFIG.exchange} ───────────────────\n`,
  );
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 300);
  // Signals are evaluated on CLOSED candles only — the last candle Coinbase
  // returns is still forming, and a mid-day "breakout" can fully retrace by the
  // close. The backtest (engine.js) that validated the strategy only ever sees
  // closed bars, so live must match or it's trading an untested rule.
  const closed = candles.slice(0, -1);
  if (closed.length < (strat.warmup || 50)) {
    console.log(
      `\nNot enough closed candles (${closed.length}) for ${strat.name} (needs ${strat.warmup}). Exiting.`,
    );
    return;
  }
  const price = candles[candles.length - 1].close; // live-ish price, for execution + hard stop/target checks
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Per-trade notional, capped by what the (paper) portfolio could actually fund.
  const tradeSize = Math.min(CONFIG.maxTradeSizeUSD, CONFIG.portfolioValue);

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    strategy: strat.name,
    price,
    conditions: [],
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
  };

  const baseAsset = CONFIG.symbol.split("-")[0] || "asset";

  if (position) {
    // ── Holding a long → look for an exit (sell-to-close) ──
    logEntry.position = position;
    console.log(
      `Open long: ${position.baseSize} ${baseAsset} from $${position.entryPrice.toFixed(2)}`,
    );

    // Exit on a hard stop/target (if the strategy set one) or the strategy's own
    // exit signal (e.g. donchian's ATR stop + lower-channel break).
    let reason = null;
    if (position.stopLoss != null && price <= position.stopLoss) reason = "stop-loss";
    else if (position.takeProfit != null && price >= position.takeProfit)
      reason = "take-profit";
    else if (strat.shouldExit && strat.shouldExit(closed, position)) reason = "signal";

    if (reason) {
      const exitUSD = position.baseSize * price;
      const pnl = (price - position.entryPrice) * position.baseSize;
      logEntry.action = "EXIT";
      logEntry.exitReason = reason;
      logEntry.side = "sell";
      logEntry.tradeSize = exitUSD;
      logEntry.entryPrice = position.entryPrice;
      logEntry.pnl = pnl;
      console.log(
        `EXIT SIGNAL (${reason}). Selling ${position.baseSize} ${baseAsset} to close.`,
      );
      console.log(
        `   Est. P/L: $${pnl.toFixed(2)} (entry $${position.entryPrice.toFixed(2)} -> $${price.toFixed(2)})`,
      );
      await executeOrder({ side: "sell", sizeUSD: exitUSD, price, logEntry });
      if (logEntry.orderPlaced) {
        clearPosition();
        console.log(`   Position closed.`);
      }
    } else {
      console.log(`HOLDING — no exit signal from ${strat.name} yet.`);
      logEntry.action = "HOLD";
    }
  } else if (countTodaysEntries(log) >= CONFIG.maxTradesPerDay) {
    const n = countTodaysEntries(log);
    console.log(`NO ENTRY — daily entry limit reached (${n}/${CONFIG.maxTradesPerDay}).`);
    logEntry.blockedReason = "Max trades per day reached";
  } else if (strat.shouldEnter(closed)) {
    // ── Flat + strategy says enter → open a long ──
    const lv = strat.exitLevels ? strat.exitLevels(price) : null;
    const stopLoss = lv?.stopLoss ?? null;
    const takeProfit = lv?.takeProfit ?? null;
    logEntry.side = "buy";
    logEntry.action = "ENTRY";
    logEntry.stopLoss = stopLoss;
    logEntry.takeProfit = takeProfit;
    console.log(`ENTRY SIGNAL — ${strat.name}`);
    console.log(
      `   Stop-loss: ${stopLoss ? "$" + stopLoss.toFixed(2) : "strategy-managed"} | ` +
        `Take-profit: ${takeProfit ? "$" + takeProfit.toFixed(2) : "none (ride the trend)"}`,
    );
    await executeOrder({ side: "buy", sizeUSD: tradeSize, price, stopLoss, takeProfit, logEntry });
    if (logEntry.orderPlaced) {
      savePosition({
        open: true,
        side: "long",
        baseSize: Number((tradeSize / price).toFixed(8)),
        entryPrice: price,
        stopLoss,
        takeProfit,
        entryTime: logEntry.timestamp,
      });
      console.log(`   Position opened & tracked in ${POSITION_FILE}.`);
    }
  } else {
    console.log(`NO ENTRY — no signal from ${strat.name}.`);
    logEntry.blockedReason = "No entry signal";
  }

  logEntry.nearMiss = false;

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  // SMS alert — trades + errors only, so no-trade runs stay silent.
  if (logEntry.error) {
    await sendSms(
      `Bot order FAILED: ${CONFIG.symbol} ${(logEntry.side || "").toUpperCase()} — ${logEntry.error}`,
    );
  } else if (logEntry.orderPlaced) {
    const mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    if (logEntry.action === "EXIT") {
      const pnl = logEntry.pnl != null ? ` P/L $${logEntry.pnl.toFixed(2)}` : "";
      await sendSms(
        `${mode} EXIT ${logEntry.exitReason || "(sell)"} ${CONFIG.symbol} ~$${logEntry.tradeSize.toFixed(2)} @ $${logEntry.price.toFixed(2)}${pnl}`,
      );
    } else {
      const sl = logEntry.stopLoss ? ` SL $${logEntry.stopLoss.toFixed(2)}` : "";
      const tp = logEntry.takeProfit ? ` TP $${logEntry.takeProfit.toFixed(2)}` : "";
      await sendSms(
        `${mode} BUY ${CONFIG.symbol} ~$${logEntry.tradeSize.toFixed(2)} @ $${logEntry.price.toFixed(2)}${sl}${tp}`,
      );
    }
  }

  console.log("═══════════════════════════════════════════════════════════\n");
}

// Read-only auth check: node bot.js --check-auth
// Lists Coinbase balances to prove your keys work — cannot trade or withdraw.
async function checkAuth() {
  console.log("\n── Coinbase read-only auth check ─────────────────────────\n");
  const client = makeCoinbaseClient(coinbaseCreds());
  const data = await client.getAccounts();
  const accounts = data.accounts || [];
  console.log(`Auth OK — ${accounts.length} account(s) visible.\n`);
  accounts
    .filter((a) => parseFloat(a.available_balance?.value || 0) > 0)
    .forEach((a) =>
      console.log(
        `   ${a.available_balance.currency.padEnd(6)} ${a.available_balance.value}`,
      ),
    );
  console.log(
    "\n(Read-only — this lists balances only; it cannot place orders or withdraw.)\n",
  );
}

// Only run when invoked directly (node bot.js ...), not when imported by tests.
const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] || "").href;

if (invokedDirectly && process.argv.includes("--test-sms")) {
  if (!smsConfigured()) {
    console.log(
      "\nSMS not configured. Set SMTP_USER, SMTP_PASS and SMS_GATEWAY_ADDRESS in .env.\n",
    );
    process.exitCode = 1;
  } else {
    sendSms("Trading bot SMS test — alerts are working.")
      .then((ok) => {
        if (!ok) process.exitCode = 1;
      })
      .catch(() => {
        process.exitCode = 1;
      });
  }
} else if (invokedDirectly && process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (invokedDirectly && process.argv.includes("--check-auth")) {
  checkAuth().catch((err) => {
    console.error(`\nAuth check failed: ${err.message}\n`);
    // Set exitCode and let Node drain pending sockets — calling process.exit()
    // here races TLS teardown and crashes with a libuv assertion on Windows.
    process.exitCode = 1;
  });
} else if (invokedDirectly) {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exitCode = 1;
  });
}
