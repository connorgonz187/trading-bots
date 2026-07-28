# Bot B — ORB long **+** short, ATR trailing exit

Alpaca paper account `PA3ZJ1EX28BW`. **See the [top-level README](../README.md)**
for how the strategy works, the safeguards, and how to run everything — this
file only covers what makes Bot B different.

## What's different

Bot B and Bot C run **byte-identical code**. Only `.env` differs:

| Flag | Bot B | Bot C |
|---|---|---|
| `ORB_LONGS` | **true** | false |
| `ORB_SHORTS` | true | true |
| `ORB_TRAILING` | **true** (ATR trail) | false (fixed 2R) |
| `ORB_TRAIL_ATR_MULT` | 2 | — |
| `ORB_TRAIL_MIN_PCT` | 1 | — |

Everything else — scan filters, risk caps, regime gate, sizing — is identical,
so the comparison stays clean.

> If you edit `stockbot.js`, `alpaca.js`, `scan.js`, `strategy.js`, `notify.js`
> or `flatten.js`, **copy it to `bot c/` too.** They must stay identical or the
> B-vs-C comparison means nothing.

## Result so far

2026-06-05 → 07-27, from broker fill records: **−$52.84** over 150 trades,
38.0% win rate, PF 0.96.

The internally-split figures are the most useful thing this account has
produced, because both sleeves are perfectly matched on data, timing and regime:

| Sleeve | Trades | Win rate | PF | Net |
|---|---:|---:|---:|---:|
| long | 79 | 31.6% | 0.67 | −$270.21 |
| short | 71 | 45.1% | 1.31 | +$217.37 |

That split is the main evidence behind retiring Bot A — see
[POSTMORTEM-BOT-A.md](../POSTMORTEM-BOT-A.md).

## Run it

```powershell
node scan.js        # pre-market -> watchlist.csv
node stockbot.js    # one intraday cycle
node flatten.js     # manual: cancel orders + close everything (RTH only)
```
