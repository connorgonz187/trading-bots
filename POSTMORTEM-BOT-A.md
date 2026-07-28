# Post-mortem — Bot A (ORB long-only)

**Ran:** 2026-06-05 → 2026-07-27 · 29 sessions · Alpaca paper `PA3845CWKSIX`
**Retired:** 2026-07-28
**Result:** **−$752.19** (−0.75% of a $100,000 account) over 83 positions

Code and data archived in `archive/bot-a-orb/`. This document is the reason it
was shut off, and what the next strategy should inherit from it.

---

## 1. The number, and how it was verified

Every figure here comes from **Alpaca's own fill records**
(`/v2/account/activities/FILL`), reconstructed into positions — not from
`stock-trades.csv`. That matters: the trade log and the dashboard disagreed with
the broker by a wide margin, because both paired entries to exits FIFO across
the whole file (see `dashboard/server.js:realizedForBot`, now fixed). Fill
reconstruction reconciles with account equity to within the CAT/TAF fees:

| Source | Net |
|---|---:|
| Reconstructed from broker fills | −$752.19 |
| Account equity − $100,000 start | −$753.69 |
| *(difference = regulatory fees)* | $1.50 |

**Lesson zero: never tune on a number you haven't reconciled against the
broker.** Bot D was designed on the unreconciled figures and its entire premise
evaporated once they were checked.

---

## 2. Headline statistics

| Metric | Value |
|---|---:|
| Positions | 83 |
| Win / Loss / Breakeven | 30 / 52 / 1 |
| Win rate | 36.1% |
| Profit factor | 0.56 |
| Expectancy | **−$9.06 / trade** |
| Average win | $31.79 |
| Average loss | −$32.81 |
| Win/loss ratio | **0.97** |
| Best / worst | +$103.55 / −$53.90 |
| Max drawdown | 0.94% |

### The arithmetic that killed it

A 0.97 win/loss ratio needs a **50.8% win rate** to break even. Bot A hit
**36.1%**. That gap — about 15 points — is the entire loss. Nothing about
position sizing, the watchlist, or the risk caps could close it; the shape of
the trade distribution was wrong.

---

## 3. Root cause: the 2R target was unreachable

Measuring every trade in R (where 1R = the distance from entry to the OR-low
stop) shows why the win rate could never get there:

```
  -99R..-1.5R  n=  1  #
 -1.5R..  -1R  n= 16  ##########
   -1R..-0.5R  n= 20  #############
 -0.5R..   0R  n= 15  #########
    0R.. 0.5R  n= 16  ##########
  0.5R..   1R  n=  8  #####
    1R.. 1.5R  n=  1  #
  1.5R..   2R  n=  2  #
```

- Reached the **+2R target: 2 of 79 trades (2.5%)**
- Hit the **−1R stop: 31 of 79 (39.2%)**
- **Mean −0.30R, median −0.42R**

The strategy was configured to risk 1R to make 2R, but the market only delivered
2R about once every forty trades. Meanwhile the stop was hit sixteen times as
often. The distribution has almost no right tail — the biggest winner in two
months was +$103.55, barely 2R on a $50-risk trade.

Confirmed by the exit mix:

| Exit reason | n | Win rate | P/L |
|---|---:|---:|---:|
| stop | 32 | **0%** | −$1,363.35 |
| timeout / other | 28 | 43% | +$125.29 |
| eod-flatten | 17 | 59% | +$103.00 |
| **target** | **4** | 75% | +$155.55 |

The target leg — the entire profit engine — fired four times in twenty-nine
sessions. Everything else was a stop-out or a position that drifted sideways
until the clock closed it.

---

## 4. It was the long side, not this bot's configuration

The obvious objection is that Bot A was just badly tuned. It wasn't. Bot B ran
**both directions with a completely different exit** (ATR trailing stop) on a
separate account over the same sessions and the same watchlist:

| Sleeve | Trades | Win rate | Profit factor | Net |
|---|---:|---:|---:|---:|
| Bot B — long | 79 | 31.6% | 0.67 | **−$270.21** |
| Bot B — short | 71 | 45.1% | 1.31 | **+$217.37** |

Same code, same period, same names, same regime filter — the long sleeve loses
and the short sleeve doesn't. Two independent accounts, two different exit
mechanisms, one conclusion: **ORB long entries on this universe had no edge.**

That also rules out "it was a bad tape." A bear-leaning market that punished
longs rewarded shorts in the same instrument set.

---

## 5. Things that were *not* the cause

Worth recording, because they were the intuitive suspects:

- **The risk controls worked.** The regime filter vetoed 126 entries, sector
  caps fired 24 times, and max drawdown stayed under 1%. The guardrails did
  their job — they limited the damage of a losing strategy, which is exactly
  what they are for. They cannot manufacture an edge.
- **Time of day didn't hide a winner.** Every entry hour was negative:
  09:xx −$591 (n=38), 10:xx −$273 (n=37), 11:xx −$115 (n=6). There was no
  profitable window being diluted by a bad one.
- **Position sizing was not the problem.** Average win and average loss were
  within $1 of each other, so risk was being applied evenly. The problem was
  the *frequency* of wins, not their size.
- **The single big loss story doesn't apply here.** Unlike Bot C — whose entire
  net was one stranded overnight short (−$355.67) — Bot A's worst trade was
  −$53.90. It bled out evenly across 52 losers. There was nothing to fix.

---

## 6. Honest caveats

- **83 trades is still low N.** At a 36% win rate the 95% confidence interval on
  the true win rate is roughly 26–47%. The retirement decision rests on the
  R-distribution and the independent Bot B corroboration, not on the P&L alone.
- **The data feed is a real handicap.** Free Alpaca data is ~15 minutes delayed,
  so every entry signal was acting on stale prices while the broker-side stops
  and targets executed in real time. That asymmetry systematically hurts entries
  and cannot be tuned away. A paid feed might change the result — but that is a
  new experiment, not a defence of this one.
- **"ORB longs never work" is too strong.** The supportable claim is narrower:
  *ORB long entries, on a volatility-screened mover universe, with a fixed 2R
  target, on 15-minute-delayed data, lost money over 29 sessions, and the
  R-distribution shows the target was the binding constraint.*

---

## 7. What to carry forward

1. **Reconcile against the broker before drawing any conclusion.** Fill records
   are truth; the local CSV is a convenience. This one habit would have
   prevented Bot D from ever being built.
2. **Check the R-distribution before tuning anything else.** If the target
   fills 2.5% of the time, no amount of filtering, sizing, or scheduling will
   save the strategy. Plot it early — it is a faster kill signal than P&L.
3. **Set the target from the observed distribution, not from a round number.**
   2R was chosen by convention. The data suggests these names offered roughly
   0.5–1R of follow-through; a 1R target with the same stop would have been a
   materially different (and testable) strategy.
4. **Run the A/B sleeves inside one account where possible.** The
   long-vs-short comparison that actually settled this came from Bot B's
   internal split, because it was perfectly matched on data, timing and regime.
   Separate accounts added noise that took two months to see through.
5. **Guardrails are damage control, not edge.** They performed flawlessly and
   the strategy still lost. Never read "the risk controls are working" as
   evidence the strategy is working.

---

## 8. What replaced it

Nothing, deliberately. Bots B and C continue the short-side question that this
experiment surfaced, with the accounting bugs fixed. Both are effectively flat
(−$55 and −$38 over the same window) — that question is genuinely open, and it
now has a trustworthy measurement stack behind it.

Bot D, the "short + trailing synthesis," was **deleted rather than launched**:
it had never traded, and the comparison that justified it came from the pairing
bug rather than from anything the market did.
