# Backtesting toolkit

Offline strategy research for the ORB bots. Nothing here trades, schedules, or
touches a live account — it reads historical bars and prints statistics.

This folder used to be `crypto/`. When the Coinbase bot was retired on
2026-07-28 (see [`../archive/crypto-donchian/`](../archive/crypto-donchian/))
the toolkit stayed, because it backtests stocks too. Defaults are now
stock-first.

## Usage

```powershell
node bt.js strategies/orb.js 5m 60          # default SYMBOL=SPY
$env:SYMBOL='NVDA'; node bt.js strategies/trend-ma.js 1D 365
node bt.js strategies/trend-ma.js 1D 365 365   # out-of-sample: 365d ending 365d ago
node sweep.js 1H 120                        # parameter grid for meanrev
```

`SYMBOL` picks the instrument. A symbol **without** a dash (`SPY`, `NVDA`) is a
stock and routes to Alpaca data at a ~0.02% fee assumption; one **with** a dash
(`BTC-USD`) routes to Coinbase's public candle API at 0.6%. That second path is
legacy — kept only so the cached crypto series in `data/` still load.

The `skipRecentDays` argument is the useful one: it backtests an *earlier*
window so you can check a result out-of-sample instead of re-reading the same
data that produced it.

## Files

| | |
|---|---|
| `engine.js` | Backtest engine — intrabar stop/target fills, pluggable strategy interface (`shouldEnter` / `exitLevels` / `shouldExit`), on-disk candle cache |
| `bt.js` | Run one strategy over one symbol/timeframe |
| `sweep.js` | Parameter grid over `strategies/meanrev.js`, ranked by NET |
| `strategy.js` | Shared indicator helpers (EMA / RSI / VWAP) |
| `alpaca-data.js` | Stock bar fetch (the `.env` Alpaca keys here are **data-only**, not trading) |
| `strategies/` | donchian, orb, trend-ma, trend-plus, htf-rsi, pullback, meanrev |
| `data/` | Cached candles, gitignored |

## Read this before trusting a result

[`strategies/_validation.md`](strategies/_validation.md) is the stress-test
record. Short version: every conclusion in it rests on 7–13 trades, was measured
on **crypto** at crypto fees, and the best headline number (`trend-ma`) comes
almost entirely from a single multi-month position and is negative in the most
recent two years.

The wider lesson from this project is in
[`../POSTMORTEM-BOT-A.md`](../POSTMORTEM-BOT-A.md): a backtest that looks good
on a handful of trades tells you very little, and the forward test is what
actually settles it. Bot A's ORB backtested acceptably and lost $752 live.
