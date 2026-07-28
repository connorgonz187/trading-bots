# Trading bots — paper forward-test

Two live **paper-trading** experiments plus a backtesting toolkit and a local
read-only dashboard. Nothing here has ever placed a live order, and the live
paths are latched off by design.

> **Status: PAPER.** Alpaca points at `paper-api.alpaca.markets`; the Coinbase
> live path requires `COINBASE_LIVE_CONFIRM` and is blank. See
> [Going live](#going-live).

---

## Layout

| Folder | What it is |
|---|---|
| `bot b/` | Alpaca ORB — long **+** short, ATR trailing exit (`PA3ZJ1EX28BW`) |
| `bot c/` | Alpaca ORB — short-only, fixed 2R bracket (`PA3ZMXLQJZXX`) |
| `crypto/` | Coinbase Advanced donchian 55/20 daily + the backtesting toolkit |
| `dashboard/` | Local read-only monitor (`node dashboard/server.js` → :4000) |
| `archive/bot-a-orb/` | Retired Bot A (long-only ORB) — code and full trade history |

`bot b` and `bot c` are **runtime clones of identical code**. Only `.env`
differs. If you edit shared logic (`stockbot.js`, `alpaca.js`, `scan.js`,
`strategy.js`, `notify.js`, `flatten.js`), copy it to the other folder — they
must stay byte-identical or the comparison is meaningless.

---

## Current state of the experiment

Two months of forward testing, 2026-06-05 → 2026-07-27, all figures
reconstructed from **Alpaca fill records** and reconciled against account equity:

| Bot | Strategy | Trades | Win rate | PF | Net |
|---|---|---:|---:|---:|---:|
| ~~A~~ | ORB long-only, fixed 2R | 83 | 36.1% | 0.56 | **−$752.19** |
| B | ORB long+short, ATR trail | 150 | 38.0% | 0.96 | −$52.84 |
| C | ORB short-only, fixed 2R | 80 | 55.0% | 0.98 | −$36.42 |
| Crypto | Donchian 55/20 daily | 0 | — | — | $0.00 |

**Bot A was retired 2026-07-28** — see [POSTMORTEM-BOT-A.md](POSTMORTEM-BOT-A.md).
Short summary: it needed a 50.8% win rate to break even and delivered 36.1%,
because the 2R target filled on 2.5% of trades while the stop filled on 39.2%.

**Bot D was deleted**, not launched. It was designed as a "short + trailing"
synthesis, but it never traded (placeholder API keys) and the comparison that
justified it came from a P&L pairing bug, not from the market.

**B vs C is genuinely open.** Both are within $55 of flat. Bot B's internal
split is the most useful signal so far — long sleeve −$270 (PF 0.67) vs short
sleeve +$217 (PF 1.31), perfectly matched on data, timing and regime.

The crypto bot has taken zero trades in 48 daily decisions. That is correct
behaviour — donchian 55/20 is meant to trade rarely, and BTC never broke its
55-day high in the window.

---

## Measurement — read this before tuning anything

`stock-trades.csv` is a convenience log, not the source of truth. **Broker fill
records are.** The local log drifts whenever an entry doesn't log a matching
exit (a flatten that didn't confirm), and pairing entries to exits across days
produces wildly wrong numbers — SOXS's ~10:1 reverse split in July once turned a
−$53 account into a reported −$3,403.

The dashboard now shows both: **Net (broker)** — equity minus starting capital,
exact and self-healing — alongside **Realized (log)** with a count of unpaired
entries. When they disagree, trust the broker figure and investigate the gap.

To reconcile by hand:

```powershell
# per-account net, straight from Alpaca
node dashboard/server.js     # then open http://localhost:4000
```

---

## Setup

1. **Node 18+** at `C:\Program Files\nodejs\` (the `run-*.cmd` launchers hardcode it).
2. `npm install` inside `bot b`, `bot c`, and `crypto`.
3. Copy `.env.example` → `.env` in each folder and fill it in. Every variable the
   code reads is documented there. `.env` is gitignored.
4. Set the machine timezone to **US Eastern** — scheduled tasks fire in local
   time and 9:30 AM must equal the open.
5. Register the scheduled tasks from an **elevated** PowerShell:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\setup-laptop.ps1
   ```
   This registers 6 tasks (crypto daily at noon; scan + bot for B and C on
   weekdays) and removes the retired Bot A / Bot D tasks.

Full machine-migration notes are in [MIGRATION.md](MIGRATION.md).

---

## The stock bot

`scan.js` (pre-market, 9:00) screens the universe — price $5–500, volume >1M,
range ≥3%, skipping names that already made a >15% prior move — and writes the
top 8 to `watchlist.csv`. It chooses what to watch; it does not trade.

`stockbot.js` (every 5 min, 9:30–16:00) builds the first 15 minutes as the
opening range, and on a break places a **bracket order** — market entry with a
resting stop at the far side of the range and a target at `entry ± R×range`.
Alpaca holds both legs server-side so they fill intrabar. Position size is
`STOCK_RISK_USD / (entry − stop)`, capped by `STOCK_MAX_NOTIONAL`.

Safeguards, all env-tunable and on by default:

- **Regime filter** — longs only when SPY ≥ session VWAP, shorts only when ≤.
  Inverse ETFs are evaluated on economic direction, not order side.
- **Correlation caps** — `ORB_MAX_PER_SECTOR` stops SOXL + MRVL + INTC counting
  as three bets when they are one semis bet, and blocks opening a position that
  economically opposes what is already held in that cluster.
- **Daily loss kill-switch** — halts new entries at `ORB_MAX_DAILY_LOSS`.
- **Shared bar cache** — every account reads one snapshot per 5-min cycle, so
  B and C see identical data and their signals are comparable.
- **Stranded-position sweep** — anything still open at the first cycle of a new
  session is closed immediately, and a failed flatten alerts rather than
  silently deferring. One missed flatten (SMCI, held over a weekend) cost
  −$355.67, which was larger than account C's entire two-month result.
- **Short-refusal latching** — a broker "cannot be sold short" is cached for the
  day instead of being retried every 5 minutes (SQQQ was re-rejected 99 times in
  one account before this).

---

## The crypto bot

`crypto/bot.js` pulls daily candles from Coinbase, runs the strategy named by
`STRATEGY` (default `strategies/donchian.js`), and tracks the one position it
opened in `position.json`. It **only ever sells what it itself bought.**

```powershell
cd crypto
node bot.js --check-auth     # read-only; proves keys + IP allowlist
node bot.js                  # one decision cycle (paper)
node bot.js --tax-summary    # totals from trades.csv
```

Donchian: enter when the daily close breaks the highest high of the prior 55
days; exit below the prior 20-day low or an ATR(20)×3 stop.

### Backtesting

```powershell
cd crypto
node bt.js 90 BTC-USD 1D     # pluggable engine: days, symbol, timeframe
node bt.js 60 SPY 5Min       # stock symbols auto-route to Alpaca data
node sweep.js                # parameter sweep
```

`strategies/_validation.md` is the honest write-up of what the backtests found —
including that every sub-window rests on 0–5 trades and none of it clears a high
bar on sample size. Donchian is the default because it was the most *robust*,
not the most impressive.

---

## Going live

Deliberately disabled. Before changing anything: pass `--check-auth`, watch
paper for weeks, then test on a tiny sub-account.

- **Crypto:** requires `PAPER_TRADING=false` **and**
  `COINBASE_LIVE_CONFIRM=I_UNDERSTAND`. The bracket order field semantics follow
  Coinbase's docs but are **unverified against a live fill**.
- **Stocks:** repoint `APCA_BASE_URL` only after the paper test convinces you.
  On the evidence so far, it should not.

**This is not financial advice.** Nothing here is proven profitable. Two of
three strategies are flat-to-negative and the third was retired for losing money.
