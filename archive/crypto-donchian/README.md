# RETIRED — Coinbase donchian crypto bot

**Retired 2026-07-28.** The crypto route is no longer being explored. Nothing in
this folder is scheduled, imported, or shown on the dashboard. It is kept for
reference only.

## What it was

`bot.js` pulled daily candles from Coinbase Advanced, ran the strategy named by
`STRATEGY` (default `strategies/donchian.js`), and tracked the single position it
opened in `position.json`. It only ever sold what it itself bought.

**Donchian 55/20:** enter when the daily close breaks above the highest high of
the prior 55 days; exit below the prior 20-day low or an ATR(20)×3 stop.

## What happened

Nothing — and that was the correct behaviour, which is the point worth keeping.

| | |
|---|---|
| Daily decisions logged | 48 (through 2026-07-27) |
| Entries taken | **0** |
| Realized P/L | $0.00 |
| Live orders ever placed | none (paper-latched throughout) |

BTC never broke its 55-day high during the window, so a 55-day breakout system
correctly sat flat. Zero trades is not evidence the strategy is bad; it is
evidence the *sample is empty*. Two months produced no information about this
edge either way, which — alongside `strategies/_validation.md` already showing
no crypto intraday edge survives fees — is why the route was dropped rather than
tuned. A strategy that cannot generate a testable sample in a reasonable
forward-testing window is a poor thing to spend attention on.

Contrast Bot A, which produced 83 trades in the same window and could therefore
actually be judged and killed on evidence — see `../bot-a-orb/` and
`../../POSTMORTEM-BOT-A.md`.

## What moved, what stayed

The backtesting toolkit that used to share this folder was **not** retired — it
backtests stocks too, and the surviving ORB bots use it. It now lives at
`backtest/` with stock-first defaults.

| Stayed here (retired) | Moved to `backtest/` (live) |
|---|---|
| `bot.js`, `coinbase.js` | `bt.js`, `engine.js`, `sweep.js` |
| `backtest.js` (crypto-only backtester) | `strategy.js`, `alpaca-data.js`, `alpaca.js` |
| `notify.js`, `run-bot.cmd` | `strategies/`, `_validation.md` |
| `trades.csv`, `position.json`, `safety-check-log.json`, `bot.log` | `data/` candle cache |

## Credentials — action still needed

The Coinbase API key at `../../cdp_api_key.json` is **not** deleted (it is
gitignored and never left this machine). Since the bot is retired, **revoke it
in the Coinbase developer portal** rather than leaving a live trading-scoped key
on disk. `--check-auth` was already failing with 401 before retirement, most
likely an IP-allowlist mismatch.

## If you ever restart this

The scheduled task was `ClaudeTradingBot-Paper` (daily, noon); `setup-laptop.ps1`
now actively unregisters it. The live order path was never verified against a
real fill — it required both `PAPER_TRADING=false` and
`COINBASE_LIVE_CONFIRM=I_UNDERSTAND`, and the bracket-order field semantics
follow Coinbase's docs but have never been confirmed by an actual execution.
Treat that code as unproven.
