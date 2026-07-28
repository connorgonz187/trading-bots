# Trading Bots — Coinbase (crypto) + Alpaca (stocks)

Two scheduled **paper-trading** bots plus a backtesting toolkit. This started as a
clone of a YouTube "automated crypto bot" repo, but it has been rewritten and
hardened: real exchange auth, honest logging, server-side stops, and strategies
that were actually backtested. Nothing here is proven profitable — it runs in
paper mode to forward-test, not to print money.

> **Status: PAPER.** No live order path has run against a real account. The crypto
> live path is latched off (`COINBASE_LIVE_CONFIRM`); the stock bot uses an Alpaca
> paper account. Read [Going live](#going-live) before changing that.

---

## The two bots

| Bot | Files | Market | Strategy | Schedule (Task Scheduler) |
|-----|-------|--------|----------|---------------------------|
| **Crypto** | `bot.js` | Coinbase Advanced (`BTC-USD`) | Donchian daily breakout (long-only) | `ClaudeTradingBot-Paper` — daily 12:00 PM |
| **Stocks** | `scan.js` + `stockbot.js` | Alpaca (paper) | Opening-Range Breakout (intraday) | `ORB-Scan` 9:00 AM, `ORB-Bot` 9:30 AM every 5 min |

Both run via the `run-*.cmd` launchers (they `cd` into this folder, then call node
with a full path, appending to a `.log`). All tasks are S4U + WakeToRun, so they
run whether or not you're logged in, and can wake the PC from sleep on AC power.

---

## Setup

1. **Node** — `node --version` (needs 18+; this machine has v24).
2. **Install deps** — `npm install`.
3. **Config** — `Copy-Item .env.example .env`, then fill in `.env`. Every variable
   the code reads is documented there. `.env` is gitignored.
   - Crypto: a Coinbase Advanced API key (View + Trade, **withdrawals OFF**, IP
     allowlist ON). Easiest is to point `COINBASE_KEY_FILE` at the downloaded
     `cdp_api_key.json`.
   - Stocks: an Alpaca **paper** API key/secret (`APCA_*`).
   - Optional SMS alerts via Gmail app password + carrier email gateway.

---

## Crypto bot — `bot.js`

Pulls daily candles from Coinbase's public API, runs the strategy module named by
`STRATEGY` (default `strategies/donchian.js`), and decides buy / sell / hold. It
tracks the one position it opened in `position.json` and **only ever sells what it
itself bought** — never your other holdings.

```powershell
node bot.js --check-auth     # read-only: lists balances, proves keys + IP allowlist
node bot.js                  # one decision cycle (paper)
node bot.js --tax-summary    # totals from trades.csv
node bot.js --test-sms       # send a test text
```

**Donchian (default, long-only daily):** enter when the daily close breaks above
the highest high of the prior 55 days; exit when it drops below the prior 20-day
low or hits an ATR(20)×3 stop. Trades rarely — most daily runs do nothing, which
is normal. Swap strategies by pointing `STRATEGY` at any module in `strategies/`
and setting a matching `TIMEFRAME`; knobs are env-overridable.

Outputs: `safety-check-log.json` (decision audit trail) and `trades.csv` (one row
per run, tax-ready).

---

## Stock bot — `scan.js` + `stockbot.js`

A two-stage Alpaca paper pipeline for an intraday Opening-Range Breakout:

1. **`scan.js`** (pre-market) — filters the universe (price $5–500, volume >1M,
   volatility ≥3%) and writes the top ~8 names to `watchlist.csv`.
2. **`stockbot.js`** (during the session, every 5 min) — for each watchlist name,
   builds the opening range (first 15 min), and on a break of the OR high places a
   **bracket buy** (market entry + resting OCO stop at the OR low and target at
   `entry + R×range`). Alpaca enforces the stop/target server-side. Position size
   = `STOCK_RISK_USD / (entry − stop)`, capped at `STOCK_MAX_NOTIONAL`. Cancels
   and flattens at 15:55 ET.

State in `stock-state.json`; trades in `stock-trades.csv`.

**Safeguards (all env-tunable, on by default):**
- **Regime filter** (`ORB_REGIME`) — only takes longs when SPY ≥ its session VWAP,
  shorts when SPY ≤ VWAP, so it trades *with* the tape instead of against it.
- **Exhausted-name filter** (`SCAN_MAX_PRIOR_MOVE`, default 15%) — the scanner drops
  names that already made a huge prior move; ORB whipsaws on post-gap reversals.
- **Correlation + size caps** — `ORB_MAX_POSITIONS` (4), `ORB_MAX_PER_SECTOR` (2, so
  SOXL+MRVL+INTC don't count as 3 trades when they're one semis bet), and
  `ORB_MAX_DAILY_LOSS` ($150) which halts new entries after a bad day.
- **Honest accounting** — exit reasons come from the *filled order type*, not a
  price guess (a slipped stop is logged "stop", never a fake "target"), partial
  fills are reconciled, and running realized P/L is tracked in `stock-state.json`.
- **ATR-based trailing** (`ORB_TRAILING`) — trail = `ORB_TRAIL_ATR_MULT`×ATR with a
  `ORB_TRAIL_MIN_PCT` floor, so cheap tickers aren't strangled by a penny-wide trail.
- **Comparable risk** (`STOCK_MIN_RISK_FRAC`) — skips trades the notional cap would
  shrink below 50% of `STOCK_RISK_USD`, so each fill carries similar risk.
- **Shared data** (`SHARED_BAR_CACHE`) — all accounts read one bar snapshot per
  5-min cycle, so A/B/C signals are comparable instead of per-process noise.

> Caveat: free Alpaca data is ~15 min delayed, which handicaps live signals. The
> ORB edge is real in backtests but thin once realistic slippage is applied — this
> is a paper forward-test to measure real fills, not a validated winner.

---

## Backtesting toolkit

```powershell
node bt.js 90 BTC-USD 1D          # pluggable engine: days, symbol, timeframe [, OOS-skip-days]
node bt.js 60 SPY 5Min            # stock symbols auto-route to Alpaca data
node sweep.js                     # parameter sweep
node backtest.js 90               # original crypto-only backtester
```

- `engine.js` — backtest engine (intrabar stop/target fills) with a pluggable
  strategy interface (`shouldEnter` / `exitLevels` / `shouldExit`).
- `strategies/` — donchian, orb, trend-ma, trend-plus, htf-rsi, pullback, meanrev.
- `strategy.js` — shared indicator helpers (EMA/RSI/VWAP) used by several modules.
- `data/` — cached historical candles (gitignored).

**What the backtests actually found (be honest with yourself):**
- *Crypto:* no intraday edge survives fees. A long-only trend/breakout edge exists
  **only on the daily timeframe**, and it's thin, bull-market-dependent, rests on
  few trades, and was negative in the most recent year. Donchian was the most
  robust candidate, which is why it's the default.
- *Stocks:* ORB shows a real intraday edge (positive even gross) on liquid names,
  but it's slippage-sensitive — broad names go near-breakeven after realistic
  fills. Promising, not proven.

---

## Going live

Live trading is deliberately disabled. Before enabling anything: pass
`--check-auth`, watch paper for several days/weeks, then test on a tiny/sub-account.

- **Crypto:** set `PAPER_TRADING=false` **and** `COINBASE_LIVE_CONFIRM=I_UNDERSTAND`
  (both required). Start with `MAX_TRADE_SIZE_USD` tiny. The bracket order field
  semantics follow Coinbase's docs but are **unverified against a live fill** —
  confirm the first real order in Coinbase → Orders.
- **Stocks:** point `APCA_BASE_URL` at the live endpoint only after the paper
  forward-test convinces you. The bracket flow is already exercised in paper.

**This is not financial advice.** Backtest, paper trade, and never risk more than
you can afford to lose.

---

## File map

| File | Purpose |
|------|---------|
| `bot.js` | Crypto bot — main loop, decision, logging, CLI (`--check-auth`, `--tax-summary`, `--test-sms`) |
| `coinbase.js` | Coinbase Advanced auth (ES256 JWT), read-only accounts, bracket/market orders |
| `scan.js` | Pre-market stock screener → `watchlist.csv` |
| `stockbot.js` | Intraday ORB executor on Alpaca (bracket orders) |
| `alpaca.js` / `alpaca-data.js` | Alpaca trading + historical-data helpers |
| `engine.js` / `bt.js` / `sweep.js` / `backtest.js` | Backtesting |
| `strategy.js` / `strategies/` | Shared indicators + pluggable strategy modules |
| `notify.js` | SMS alerts via email-to-SMS gateway |
| `run-*.cmd` | Task Scheduler launchers (`cd` + node + log) |
| `.env` | Config + secrets (gitignored) |
| `position.json` / `stock-state.json` | Open-position / daily state |
| `safety-check-log.json` / `trades.csv` / `stock-trades.csv` | Audit + tax records |
