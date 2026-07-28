# Trading bots — paper forward-test

Two live **paper-trading** experiments, a third funded but not yet scheduled,
plus a backtesting toolkit and a local read-only dashboard. Nothing here has ever
placed a live order, and the live paths are latched off by design.

> **Status: PAPER.** Alpaca points at `paper-api.alpaca.markets`. See
> [Going live](#going-live).

---

## Layout

| Folder | What it is |
|---|---|
| `bot b/` | Alpaca ORB — long **+** short, ATR trailing exit (`PA3ZJ1EX28BW`) |
| `bot c/` | Alpaca ORB — short-only, fixed 2R bracket (`PA3ZMXLQJZXX`) |
| `swing/` | **Bot E** — multi-day swing, 2% stop / 5% target, holds overnight (`PA3RN0YU53QN`) |
| `regime.js` | Pre-market **direction call** — writes `regime.json`, read by B and C |
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
| E | Swing 2%/5%, multi-day | 0 | — | — | $0.00 (funded, not yet scheduled) |

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

**Bot E (`swing/`) has its own paper account (`PA3RN0YU53QN`, $100k) but has not
traded yet** — its scheduled tasks still need registering. It was written to test
the idea that the ORB bots exit too low: that holding a day or more would have
turned scratches into 4–7% gains. That idea was measured *before* the bot was
wired up and it **failed**: 62% of the ORB bots' own entries did reach +5% within
five days, but only 2% got there before touching a 2% stop, because the same
names' median five-day drawdown is −8.7%. Widening the stop to 8% still only
reaches profit factor 0.67. Bot E's own (different) entry rule backtests at PF
1.02 over 224 trades — flat. Full write-up and reproduction commands in
[swing/FINDINGS.md](swing/FINDINGS.md).

It is funded anyway because a flat backtest is still worth a forward test, and
because the swing question deserves its own answer rather than an inherited one.
That is the intended use of this repo's tooling: measure a premise before it
becomes a funded account, which is the one thing Bot D failed to do.

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
2. `npm install` inside `bot b`, `bot c` and `swing` (and `backtest` if you'll use it).
3. Copy `.env.example` → `.env` in each folder and fill it in. Every variable the
   code reads is documented there. `.env` is gitignored.
4. Set the machine timezone to **US Eastern** — scheduled tasks fire in local
   time and 9:30 AM must equal the open.
5. Register the scheduled tasks from an **elevated** PowerShell:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\setup-laptop.ps1
   ```
   This registers 7 tasks (scan + bot for B, C and E on weekdays, plus the
   keep-awake guardian) and removes the retired Bot A, Bot D and crypto tasks.
   Bot E's two tasks are skipped automatically if `swing/.env` has no keys yet.

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
- **Daily direction stance** — `regime.json`, written pre-market by `regime.js`.
  See [Direction](#direction--the-daily-regime-call) below. Disable per account
  with `ORB_NEWS_REGIME=false`.
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

## Direction — the daily regime call

Until now each account's direction was a constant: B long+short forever, C
short-only forever. That ignores the tape, and the forward test's clearest
signal was that side selection mattered more than the entry rule — B's short
sleeve made +$217 (PF 1.31) while its long sleeve lost $270 (PF 0.67) on
identical data, timing and regime.

`regime.js` runs at **8:55** (task `ORB-Regime`, one shared task — the stance is
a property of the market, not of an account, so B and C must read the same file
or their comparison stops meaning anything). It writes `regime.json`:

```json
{ "date": "2026-07-28", "stance": "short_only", "source": "auto", "score": -3,
  "components": { "news": -2, "trend": -1.5, "vol": 0, "oil": 0.5 } }
```

Stances are `both`, `long_only`, `short_only`, `flat`. Four inputs, all from
Alpaca, all headless:

| Component | Input | Weight |
|---|---|---|
| `news` | risk-off vs risk-on keyword tone across macro headlines (18h) | ±3 |
| `trend` | SPY close vs its 20-day SMA | ±1.5 |
| `vol` | VIXY vs its 10-day SMA (>+10% = risk-off) | −1.5 / +0.5 |
| `oil` | USO 5-day change (>+5% = risk-off) | −1 / +0.5 |

`score ≥ +2 → long_only`, `≤ −2 → short_only`, else `both`. Auto mode never
emits `flat`; standing the bots down entirely has no validated threshold behind
it, so it is override-only.

**The news filter is the load-bearing part.** Alpaca's feed is Benzinga, ~95%
single-name earnings and analyst actions. Scoring it raw was garbage — the first
live run read "Whistleblower Retaliation Case" as a geopolitical hit and "UBS
Upgrades Medtronic" as relief. Only headlines with no ticker, five or more
tickers, or an index/macro ticker vote, and analyst/earnings boilerplate is
dropped outright. That cut a 200-headline sample to the 20 that were actually
macro.

Two rules the bots enforce on top:

- **It can only narrow, never widen** — the same "smaller of the two wins" rule
  as the notional caps. `long_only` cannot make short-only account C take a
  long; C just stands down that day. Note that this *does* change what C tests:
  it is no longer short-every-day. Set `ORB_NEWS_REGIME=false` on C to keep the
  original clean comparison running.
- **It fails open** — a missing, malformed or stale file (date ≠ today, ET)
  leaves the env flags untouched. A scheduler hiccup at 8:55 must not silently
  stand an account down. `node selftest-regime.js` in either bot folder covers
  all of this; 29 assertions, no network.

### Overriding it

`regime.js` scores keywords; it cannot read meaning, weigh a scheduled FOMC, or
notice that a war headline is about a *ceasefire*. The `/premarket-regime` skill
(`.claude/skills/premarket-regime/`) has Claude read the auto call, search
overnight macro news, optionally glance at TradingView, and either accept it or
override:

```powershell
node regime.js --show      # what's in force now
node regime.js --dry       # recompute, print, write nothing
node regime.js --set short_only --why "Iran strikes resumed, Brent +6%, ES -1.4%"
```

`--why` is mandatory and lands in the history file next to the inputs.

### It has not been validated

The weights and keyword lists are a hypothesis, not a measured edge. **Nothing
here has been backtested against the bots' fills** — which is exactly how Bot D
happened. Every run appends its full input vector to `regime-history.csv` so the
question can be settled with evidence later:

```
date,computedAt,stance,source,score,news,trend,vol,oil,headlines,macroHeadlines,...
```

Once there are enough rows, join them to the fill records and ask whether
`short_only` days actually paid better than `both` days. Until then the stance
is a prior, not a prediction.

---

## The swing bot (Bot E)

Everything above describes intraday bots that are flat by 15:50. Bot E is the
opposite experiment: one decision a day off **daily** bars, a −2% stop and a +5%
target resting **GTC** at the broker, held up to 10 trading days.

Two consequences worth knowing before running it:

- **It runs on its own paper account** (`PA3RN0YU53QN`). This is not optional:
  B and C sweep any position still open at the first cycle of a new session, so
  sharing an account with them would close Bot E's swings at the next open,
  silently.
- **A stop does not cap a gap.** 13% of backtested trades gapped through the
  stop (worst −9.9%), so the "losses are 1–2%" claim holds intraday and fails
  overnight. Size for the gap, not the stop.

The universe gate is the load-bearing part: it refuses any symbol where the stop
is not at least 0.8× the name's daily ATR, which is what keeps a 2% stop from
being noise. See [swing/README.md](swing/README.md) and
[swing/FINDINGS.md](swing/FINDINGS.md).

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
