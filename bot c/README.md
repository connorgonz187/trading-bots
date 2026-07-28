# Bot C — ORB short-only, fixed 2R bracket

Alpaca paper account `PA3ZMXLQJZXX`. **See the [top-level README](../README.md)**
for how the strategy works, the safeguards, and how to run everything — this
file only covers what makes Bot C different.

## What's different

Bot C and Bot B run **byte-identical code**. Only `.env` differs:

| Flag | Bot C | Bot B |
|---|---|---|
| `ORB_LONGS` | **false** | true |
| `ORB_SHORTS` | true | true |
| `ORB_TRAILING` | **false** (fixed 2R) | true (ATR trail) |

Everything else — scan filters, risk caps, regime gate, sizing — is identical,
so the comparison stays clean.

> If you edit `stockbot.js`, `alpaca.js`, `scan.js`, `strategy.js`, `notify.js`
> or `flatten.js`, **copy it to `bot b/` too.** They must stay identical or the
> B-vs-C comparison means nothing.

## Result so far

2026-06-05 → 07-27, from broker fill records: **−$36.42** over 80 trades,
55.0% win rate, PF 0.98. Highest win rate of the three accounts.

**Read that number carefully.** The entire net loss is one trade: an SMCI short
opened 06-16 that a failed EOD flatten left open until 06-22, across a weekend,
for **−$355.67**. Every other trade in the account nets **+$319**, and the worst
intentional loss was −$53.

That single failure is what motivated the stranded-position sweep and the
flatten alerting now in `stockbot.js`. It is also a good reminder that a 55% win
rate with a 0.80 win/loss ratio is not automatically profitable — Bot C's
average loss ($41.37) exceeds its average win ($33.02).

## Run it

```powershell
node scan.js        # pre-market -> watchlist.csv
node stockbot.js    # one intraday cycle
node flatten.js     # manual: cancel orders + close everything (RTH only)
```
