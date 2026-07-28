# Crypto — Coinbase donchian + backtesting toolkit

Moved out of `bot a/` on 2026-07-28 when Bot A's stock strategy was retired.
This folder is independent of the ORB experiment. **See the
[top-level README](../README.md)** for setup and the wider context.

## The bot

`bot.js` pulls daily candles from Coinbase Advanced, runs the strategy named by
`STRATEGY` (default `strategies/donchian.js`), and tracks the single position it
opened in `position.json`. It **only ever sells what it itself bought** — it will
never touch other holdings.

```powershell
node bot.js --check-auth     # read-only; proves keys + IP allowlist
node bot.js                  # one decision cycle (paper)
node bot.js --tax-summary    # totals from trades.csv
node bot.js --test-sms       # send a test Telegram alert
```

**Donchian 55/20:** enter when the daily close breaks above the highest high of
the prior 55 days; exit below the prior 20-day low or an ATR(20)×3 stop. It is
*meant* to trade rarely — 48 decisions and zero entries through 2026-07-27 is
correct behaviour, not a fault. BTC never broke its 55-day high in the window.

Outputs: `safety-check-log.json` (decision audit trail) and `trades.csv`.

### Credentials

`COINBASE_KEY_FILE` is a path **relative to this folder** (`../cdp_api_key.json`)
so it survives a move between machines. Coinbase enforces an **IP allowlist** —
on a new network, allowlist the egress IP in the Coinbase developer portal or
`--check-auth` returns 401.

## Backtesting

```powershell
node bt.js 90 BTC-USD 1D     # pluggable engine: days, symbol, timeframe [, OOS-skip]
node bt.js 60 SPY 5Min       # stock symbols auto-route to Alpaca data
node sweep.js                # parameter sweep
node backtest.js 90          # the original crypto-only backtester
```

- `engine.js` — backtest engine with intrabar stop/target fills and a pluggable
  strategy interface (`shouldEnter` / `exitLevels` / `shouldExit`)
- `strategies/` — donchian, orb, trend-ma, trend-plus, htf-rsi, pullback, meanrev
- `strategy.js` — shared indicator helpers (EMA / RSI / VWAP)
- `alpaca.js`, `alpaca-data.js` — Alpaca helpers, used here only to fetch stock
  bars for backtests (the `.env` Alpaca keys are for data, not trading)
- `data/` — cached candles, gitignored

**[`strategies/_validation.md`](strategies/_validation.md) is required reading**
before trusting any of it. Short version: no crypto intraday edge survives fees;
a long-only daily trend edge exists but is thin, bull-market-dependent, rests on
7–13 trades, and was negative in the most recent year. Donchian is the default
because it was the most *robust* candidate, not the most impressive one.

## Going live

Requires **both** `PAPER_TRADING=false` and
`COINBASE_LIVE_CONFIRM=I_UNDERSTAND`. The bracket-order field semantics follow
Coinbase's docs but are **unverified against a live fill** — confirm the first
real order in Coinbase → Orders. Start with `MAX_TRADE_SIZE_USD` tiny.
