# Post-mortem — 2026-07-28

Worst session on record for B and C: **−$449.42 combined**, broker-verified.

| | Account | Realized today | Closes | Win rate |
|---|---|---|---|---|
| Bot B | PA3ZJ1EX28BW | −$162.74 | 37 | 38% |
| Bot C | PA3ZMXLQJZXX | −$286.68 | 14 | **0%** |
| Bot E | PA3RN0YU53QN | $0.00 | 0 | — no signal |

Reconstructed from `/v2/account/activities/FILL` with a signed-quantity position
walk and reconciled against `equity − last_equity` on both accounts; the two
agree exactly. The local CSVs do **not** — see cause 5.

There are five causes, and they are independent. Fixing only the one everybody
noticed (the duplicate orders) would still have left a losing day.

---

## 1. Every bet but one was bearish, and the tape went up

Eleven positions were opened across both accounts. Classified by ECONOMIC
direction — long an inverse ETF is a bearish bet — **ten were bearish**:

```
B: SKHY short, NVD long*, NOK short, DRAM short, INTC short, SOXS long*   (6 bearish)
   BMNR long                                                              (1 bullish)
C: SKHY short, NOK short, DRAM short, INTC short                          (4 bearish)
                                                          * inverse ETF
```

The tape:

```
SPY   739.16 -> 740.79   +0.22%   (closed near the day high of 742.75)
NVDA  194.95 -> 197.05   +1.08%
QQQ   676.04 -> 675.40   -0.10%
```

**The one bullish bet — BMNR — was the only clear winner** (+1.45% realized,
+2.03% had it been held to the close). Every bearish bet lost or scratched.

This was *not* the regime filter's doing. Zero regime vetoes fired on either
account today; the filter did not reject a single setup. The bearish skew came
from the watchlist itself — SOXS, SOXL, SKHY, BMNR, NVD, NOK, DRAM, INTC are
high-beta semis and junk, and they broke *down* out of their opening ranges
while SPY drifted *up*. The bots faithfully traded what broke.

## 2. It was a false-breakout day — the setups reversed on contact

Maximum favourable excursion, entry to exit:

| Trade | MFE | MAE | Result |
|---|---|---|---|
| B NVD long | **0.00%** | −1.11% | −1.11% |
| B SOXS long | **0.00%** | −4.58% | −4.06% |
| B SKHY short | 0.63% | −4.11% | −2.52% |
| C SKHY short | 0.71% | −4.02% | −0.25% |
| C NOK short | 0.81% | −3.63% | −3.00% |
| B NOK short | 0.92% | −0.98% | −0.58% |
| B DRAM short | 1.26% | −2.31% | −1.86% |
| C DRAM short | 1.35% | −4.25% | −3.60% |
| B INTC short | 2.06% | −0.92% | +0.27% |
| C INTC short | 2.72% | −3.34% | −2.92% |
| B BMNR long | 3.83% | −0.17% | +1.45% |

**Eight of eleven trades never got 1.5% in favour. Two never went favourable by
a single tick.** That is the signature of a mean-reverting session, which is
precisely the regime an opening-range breakout cannot survive: ORB pays for the
occasional trend day out of a stream of small losses, and today produced no
trend day at all. SPY's entire range was 0.92%.

The clearest single example is SOXS. SOXL fell as low as 101.62 from a 113.16
open, so its inverse spiked; the bot bought SOXS at 65.49 at 10:35 — above the
opening-range high, i.e. chasing a move that had already happened. SOXL then
recovered to close at 109.50 and SOXS never ticked up again. MFE 0.00%.

## 3. Bot C's 2R target was unreachable by construction

C runs a fixed 2R target with the stop at the opposite end of the opening range.
On these names the opening range is enormous, so a 2R target is a multi-day
move while the stop is one bad hour:

| C trade | Entry | Stop (OR high) | Risk | 2R target needs | Best it managed |
|---|---|---|---|---|---|
| SKHY | 129.25 | 136.45 | 5.57% | **−11.14%** | 0.71% |
| NOK | 8.67 | 9.05 | 4.38% | **−8.77%** | 0.81% |
| DRAM | 46.72 | 48.39 | 3.57% | **−7.15%** | 1.35% |
| INTC | 85.42 | 87.91 | 2.91% | **−5.83%** | 2.72% |

Not one target was within reach of a single session. The best favourable move
all day was less than half the *smallest* target distance. C could only ever
stop out, time out, or scratch — and it went 0-for-14.

This is Bot A's fatal number resurfacing in a new place. The swing backtester
already warns about it explicitly: *"Bot A's fatal number was 2.5%. Below ~15%
here and the target is out of reach too."*

## 4. The trailing stop beat the fixed target on the same trades

B and C are an A/B on exit method and traded four of the same symbols today,
entering within cents of each other. B trails (2×ATR, 1% floor); C holds a fixed
2R target with a stop at the OR high:

| Symbol | B (trailing) | C (fixed 2R) | Trailing advantage |
|---|---|---|---|
| INTC | **+0.27%** | −2.92% | +3.19 pts |
| NOK | −0.58% | −3.00% | +2.42 pts |
| DRAM | −1.86% | −3.60% | +1.74 pts |
| SKHY | −2.52% | −0.25% | −2.27 pts |
| **average** | **−1.17%** | **−2.44%** | **+1.27 pts** |

The trailing stop was better on three of four and roughly halved the average
loss. It converted INTC from a full stop-out into a small win. That is the whole
point of the A/B, and on a chop day it answered clearly: **get out fast.**
C's only relative win was SKHY, where it survived to the EOD flatten near its
entry rather than being trailed out mid-move.

## 5. The duplicate-order bug also disabled the daily loss cap

Two machines ran the schedule against the same accounts (desktop tasks
registered while the laptop's were still enabled). Every order was sent twice
~1s apart under different random `client_order_id`s, so **every position opened
at 2× size**. That alone doubled the day: at intended size the loss was about
−$225.

The second-order effect is worse. `ORB_MAX_DAILY_LOSS=150` halts new entries
once realized P/L drops below −$150 — but each instance only ever saw *its own
half*, in its own state file:

| | Bot thought | Account actually was | Cap engaged? |
|---|---|---|---|
| Bot B | −$84.56 | −$162.74 | no |
| Bot C | −$139.32 | −$286.68 | no |

**Neither bot's circuit breaker fired.** C sat $10.68 from its halt threshold
while the account was nearly twice past the point where trading was supposed to
stop. The safety control was silently scaled out of usefulness by the same bug
that caused the damage.

The two instances also raced each other on the close, producing
`position not found` 404s and false `PAPER S FLATTEN FAILED` alerts on an
account that was already flat.

---

## Actions

Ordered by expected value, not by how interesting they are.

1. **Disable the laptop's `ORB-*` and `Swing-*` scheduled tasks.** Nothing else
   matters until only one machine trades these accounts. Branch
   `fix/dup-order-guard-and-regime` adds a broker-side guard (deterministic
   `client_order_id`; Alpaca rejects the twin with 422 / 42210000) but that is a
   safety net, not the fix.
2. **Make the daily loss cap read the broker, not local state.** It should be
   computed from `equity − last_equity`, which is true regardless of how many
   instances are running or how many partial fills occurred.
3. **Reconsider C's fixed 2R target.** On a 15-minute opening range in these
   names it is not a target, it is a number that can never be hit. Either size
   the target off ATR rather than off the range, or adopt B's trailing exit.
4. **Cut the inverse ETFs.** Across all 34 sessions they are 67 trades for
   −$203.07 at PF 0.46 — 38% of B+C's total loss from 9% of the trades. Today
   they contributed NVD (−1.11%, MFE 0.00%) and SOXS (−4.06%, MFE 0.00%).
5. **Consider a chop filter.** ORB has no concept of "the market is not
   trending today" beyond the SPY/VWAP sign test, which fired on nothing today.
   An opening-range height or ATR-expansion condition would have stood down.

## What was NOT the cause

- **The regime filter.** Zero vetoes fired today. It selected nothing.
- **Bot C being short-only.** That is `ORB_LONGS=false`, a deliberate A/B
  setting, not a malfunction — though it is why C had no access to the day's
  one winning direction.
- **Bot E.** It ran every cycle, evaluated all 23 watchlist names in its entry
  window, and correctly found no qualifying setup. It ended the day flat at
  $100,000.00 and lost nothing.
