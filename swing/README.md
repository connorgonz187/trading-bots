# Bot E — swing (multi-day hold)

Risks **2%** to make **5%**, holds up to **10 trading days**. Built to test the
idea that the ORB bots exit too early.

> **Read [FINDINGS.md](FINDINGS.md) first.** The premise was measured before
> this bot was wired up, and it did **not** survive: 62% of ORB entries did
> reach +5% within five days, but only 2% got there before touching a 2% stop,
> because those names' median 5-day drawdown is −8.7%. Bot E's own entry rule
> backtests at profit factor **1.02** over 224 trades — flat, not profitable.
> Nothing here is proven; it is an instrumented experiment.

---

## Requires its own Alpaca paper account

Not optional. Bots B and C run a **stranded-position sweep** that closes
anything still open at the first cycle of a new session — it exists because one
missed flatten cost −$355.67. Point Bot E at their account and that sweep will
quietly kill every swing at the next open.

```powershell
cd swing
npm install
Copy-Item .env.example .env      # then fill in a THIRD paper account's keys
node swingbot.js --check-auth    # prove it is the account you think it is
```

## How it works

| | |
|---|---|
| **Universe** | `swing-scan.js`, pre-market → `swing-watchlist.csv` |
| **Entry** | RSI(2) ≤ 15 pullback inside an uptrend, then a close above the prior bar's high. Decided once a day, 15:40–15:55 ET, off **daily** bars |
| **Stop** | −2% from the actual fill, resting **GTC** at the broker |
| **Target** | +5%, the other leg of a GTC **OCO** |
| **Breakeven** | after a close +3% in your favour, the stop is raised to entry+0.1% — the trade can no longer lose |
| **Time stop** | market-close after 10 trading days |
| **Regime** | longs only above SPY's SMA50, shorts only below — so only one sleeve is ever live, and the two are cleanly comparable inside one account |
| **Caps** | 5 positions, 2 per sector, $500 total open risk, $100 risk per trade |

### The one design decision that matters

A 2% stop on a name whose daily ATR is 5% is not a stop, it is a coin flip. So
the universe gate refuses any symbol where the stop is not at least **0.8× the
daily ATR** (`SWING_MIN_STOP_ATR`). With a 2% stop that admits names up to 2.5%
ATR — which deliberately steers away from the 3%+ movers `scan.js` feeds the ORB
bots, the universe the post-mortem found whipsaw-prone.

`SWING_STOP_PCT` and `SWING_MIN_STOP_ATR` are coupled. Tighten the stop without
loosening the gate and the scanner will return nothing — which is the honest
answer, not a bug.

### Why exits rest GTC

The ORB bots use a DAY bracket because they flatten at 15:50. A DAY bracket on a
position held overnight expires at the close and leaves it naked through exactly
the gap it needs protection from. Bot E arms a GTC OCO after the entry fills,
and **if the OCO cannot be armed it closes the entry immediately** — an
unprotected overnight position is worse than no trade.

There is no EOD flatten and no stranded-position sweep here. An open position at
16:00 is the strategy working.

## Commands

```powershell
node swing-scan.js              # build today's universe
node swing-scan.js --explain    # ...and why each name was rejected
node swingbot.js                # one cycle: reconcile, ratchet, maybe enter
node swingbot.js --dry-run      # print signals, place nothing
node swingbot.js --check-auth   # account, equity, open positions
node flatten.js                 # emergency: close everything (RTH only)

node selftest.js                # 37 offline assertions on the strategy module
node swing-bt.js 1095           # backtest 3 years
node mfe-study.js               # re-test the premise against the ORB entries
```

`swing-bt.js` caches bars under `data/` so parameter sweeps are fast; delete the
folder to force a refetch.

## Scheduling

`setup-laptop.ps1` registers both tasks:

| Task | When |
|---|---|
| `Swing-Scan-E` | weekdays 9:00 AM ET |
| `Swing-Bot-E` | weekdays, every 30 min from 9:45 AM for 6h15m |

Every run reconciles and ratchets; only runs inside 15:40–15:55 ET open new
positions. Missing a run is safe — the stop and target are resting at the
broker, not in this process.

## Reading the results

`swing-trades.csv` is a convenience log. **Broker fills are the truth.** The
dashboard shows *Net (broker)* — equity minus starting capital — next to
*Realized (log)*; when they disagree, the log is wrong. See the repo README's
"Measurement" section, and never quote a number you have not reconciled.

Watch the **target fill rate** before the P&L. Backtest says 16.5%; Bot A died
at 2.5%. If live drops below ~10%, the target is out of reach and no amount of
tuning downstream will fix it.

**This is not financial advice.** Paper only. Nothing here is proven profitable.
