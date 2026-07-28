# Trading bots — paper forward-test

Two live **paper-trading** experiments plus a backtesting toolkit and a local
read-only dashboard. Nothing here has ever placed a live order, and the live
paths are latched off by design.

> **Status: PAPER.** Alpaca points at `paper-api.alpaca.markets`. See
> [Going live](#going-live).

---

## Layout

| Folder | What it is |
|---|---|
| `bot b/` | Alpaca ORB — long **+** short, ATR trailing exit (`PA3ZJ1EX28BW`) |
| `bot c/` | Alpaca ORB — short-only, fixed 2R bracket (`PA3ZMXLQJZXX`) |
| `backtest/` | Offline strategy research — engine, strategies, candle cache |
| `dashboard/` | Local read-only monitor (`node dashboard/server.js` → :4000) |
| `archive/bot-a-orb/` | Retired Bot A (long-only ORB) — code and full trade history |
| `archive/crypto-donchian/` | Retired Coinbase donchian bot — code and decision log |

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
| ~~Crypto~~ | Donchian 55/20 daily | 0 | — | — | $0.00 |

**Bot A was retired 2026-07-28** — see [POSTMORTEM-BOT-A.md](POSTMORTEM-BOT-A.md).
Short summary: it needed a 50.8% win rate to break even and delivered 36.1%,
because the 2R target filled on 2.5% of trades while the stop filled on 39.2%.

**Bot D was deleted**, not launched. It was designed as a "short + trailing"
synthesis, but it never traded (placeholder API keys) and the comparison that
justified it came from a P&L pairing bug, not from the market.

**The crypto bot was retired 2026-07-28** — see
[archive/crypto-donchian/](archive/crypto-donchian/). It took zero trades in 48
daily decisions. That was *correct* behaviour rather than a fault — donchian
55/20 is meant to trade rarely and BTC never broke its 55-day high — but two
months that generate no sample also generate no information, so the route was
dropped rather than tuned. The backtesting toolkit it shared a folder with
survives at `backtest/`.

**B vs C is genuinely open.** Both are within $55 of flat. Bot B's internal
split is the most useful signal so far — long sleeve −$270 (PF 0.67) vs short
sleeve +$217 (PF 1.31), perfectly matched on data, timing and regime.

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
2. `npm install` inside `bot b` and `bot c` (and `backtest` if you'll use it).
3. Copy `.env.example` → `.env` in each folder and fill it in. Every variable the
   code reads is documented there. `.env` is gitignored.
4. Set the machine timezone to **US Eastern** — scheduled tasks fire in local
   time and 9:30 AM must equal the open.
5. Register the scheduled tasks from an **elevated** PowerShell:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\setup-laptop.ps1
   ```
   This registers 5 tasks (scan + bot for B and C on weekdays, plus the
   keep-awake guardian) and removes the retired Bot A, Bot D and crypto tasks.

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

- **Concentration cap** — no single position may be worth more than
  `STOCK_MAX_NOTIONAL_PCT` (default **7**) percent of account **equity**, read
  live from Alpaca each cycle. Equity, not `buying_power`: the paper accounts
  carry 4× margin, so sizing off buying power would let "7%" mean 28% of what
  the account actually owns. This binds together with the fixed
  `STOCK_MAX_NOTIONAL` and **the smaller of the two wins**, so it can only ever
  tighten sizing. At ~$100k equity the fixed $2,000 cap is the binding one; the
  percentage takes over below ~$28.6k. It fails **closed** — if the account
  can't be read, the cycle takes no new entries (exits and the EOD flatten still
  run).
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

## Backtesting

```powershell
cd backtest
node bt.js strategies/orb.js 5m 60             # default SYMBOL=SPY
node bt.js strategies/trend-ma.js 1D 365 365   # out-of-sample window
node sweep.js                                  # parameter grid
```

See [backtest/README.md](backtest/README.md). Before trusting any result, read
`backtest/strategies/_validation.md` — every sub-window in it rests on 0–5
trades, and it was all measured on crypto at crypto fees.

---

## Going live

Deliberately disabled. Repoint `APCA_BASE_URL` only after the paper test
convinces you — on the evidence so far, it should not.

**This is not financial advice.** Nothing here is proven profitable. Both
surviving strategies are flat-to-negative; the other two were retired, one for
losing money and one for producing no evidence at all.
