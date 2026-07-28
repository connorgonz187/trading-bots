# Bot E — what the data says about the premise

**Premise under test:** *the ORB bots exit too low; held a day or more, those
trades would have been 4–7% gains. Cap losses at 1–2% and take gains at 4–7%.*

**Measured 2026-07-28**, before Bot E has traded a single share. Reproduce with:

```powershell
cd swing
node mfe-study.js      # tests the premise against the ORB bots' own entries
node swing-bt.js 1095  # tests Bot E's own rules over 3 years of daily bars
```

---

## 1. The premise is half right — and the half that fails is the important half

`mfe-study.js` took all **313 ENTRY rows** from Bot A, B and C (2026-06-05 →
2026-07-27), and asked how far each name actually travelled from that entry
price, using split-adjusted daily bars.

| Horizon | Median max favourable move | Reached +4% | +5% | +7% | **Median max adverse move** |
|---|---:|---:|---:|---:|---:|
| 1 day | +3.74% | 46.5% | 39.4% | 21.5% | **−4.92%** |
| 2 days | +4.54% | 53.9% | 46.5% | 33.7% | **−6.09%** |
| 3 days | +5.13% | 59.6% | 51.5% | 37.7% | **−7.19%** |
| 5 days | +6.94% | 69.0% | 62.3% | 49.5% | **−8.70%** |
| 10 days | +8.00% | 71.0% | 65.7% | 53.9% | **−9.96%** |

For contrast, the median move from entry to that same day's close — roughly what
the 15:50 flatten captures — was **−0.09%**.

So the first half of the premise holds: **62% of ORB entries did reach +5%
within five days**, and half reached +7%. The moves are real and the ORB bots
are indeed leaving them on the table.

The second half is where it collapses. Look at the last column. The same names
that ran +6.94% in your favour also ran **−8.70% against you**, at the median.
That is not a directional edge being cut short — it is volatility, and it points
both ways.

## 2. Which came first, the target or the stop?

Applying the proposed rules (−2% stop, +5% target, ≤10-day hold) to those 313
entries:

| Exit | n | share | avg |
|---|---:|---:|---:|
| stop | 289 | 97.3% | −2.05% |
| target | 6 | 2.0% | +5.02% |
| time-stop | 2 | 0.7% | +2.76% |

**Win rate 2.7%. Profit factor 0.06. Expectancy −1.88% per trade.**

62.3% of these entries eventually reached +5% — but only **2.0%** got there
before touching a 2% stop. A 2% stop on a name with a median 5-day drawdown of
−8.70% is not a stop; it is a near-certainty.

## 3. No stop width rescues those entries

The obvious response is "widen the stop." It does not work:

| Stop | Target | Win rate | Profit factor | Expectancy |
|---:|---:|---:|---:|---:|
| 2% | 5% | 2.7% | 0.06 | −1.88% |
| 3% | 5% | 15.5% | 0.29 | −1.83% |
| 4% | 5% | 28.3% | 0.45 | −1.65% |
| 5% | 5% | 36.7% | 0.54 | −1.50% |
| 6% | 7% | 38.4% | 0.57 | −1.60% |
| 8% | 5% | 50.2% | 0.67 | −1.24% |

Profit factor climbs from 0.06 toward 0.67 and never reaches 1.0. Widening the
stop only loses more slowly. **The ORB entries have no directional edge to
harvest at any holding period** — which is the same conclusion
POSTMORTEM-BOT-A.md reached intraday, now confirmed on a multi-day horizon.

> The premise "we are exiting too low" is therefore **not** the explanation for
> the ORB bots' losses. Exiting later would have lost more, not less.

## 4. Bot E's own entry rule is a separate question — and lands flat

Bot E does not use ORB entries. It uses an RSI(2) pullback inside an uptrend, on
a universe explicitly gated so that a 2% stop is at least 0.8× the name's daily
ATR. Over **3 years, 77 liquid symbols, 224 trades**:

| | |
|---|---:|
| Win rate | 37.9% (break-even needs 37.5%) |
| Profit factor | **1.02** |
| Expectancy | +0.012R (+0.02%/trade) |
| Avg win / loss | +3.52% / −2.10% |
| Target fill rate | **16.5%** |
| Avg hold | 5.7 trading days |

Variants across the brief's whole range:

| Stop | Target | Sides | Trades | PF | Expectancy | Target fill |
|---:|---:|---|---:|---:|---:|---:|
| 2.0% | 5.0% | both | 224 | 1.02 | +0.012R | 16.5% |
| 2.0% | 4.0% | both | 224 | 1.07 | +0.047R | 26.8% |
| 2.0% | 7.0% | both | 223 | 1.02 | +0.014R | 7.6% |
| 1.5% | 4.0% | both | 125 | 1.03 | +0.018R | 20.0% |
| 2.0% | 5.0% | long only | 188 | 1.06 | +0.035R | 14.9% |

**Every variant lands at PF ≈ 1.0.** The spread from 1.02 to 1.07 is noise at
n≈220; treating "2%/4%" as the winner would be curve-fitting, and this repo has
already deleted one bot for that mistake. By year the expectancy is +0.01R
(2023), −0.27R (2024), +0.28R (2025), −0.06R (2026) — it does not persist.

The short sleeve is the weak one: PF 0.86 over 36 trades against the long
sleeve's 1.06 over 188. That is the *opposite* of what the ORB bots found
intraday, and at n=36 it is not worth acting on either way.

The one unambiguous improvement over Bot A: **the target actually fills.** Bot A
hit its 2R target on 2.5% of trades. Bot E hits +5% on 16.5% and +4% on 26.8%.
The exit is reachable. There is just no edge behind it.

## 5. The 1–2% loss cap does not survive overnight

A stop order does not cap a gap — it becomes a market order at the open.

- **12.5%** of backtested trades gapped through the stop, averaging **−2.82%**
- 10 trades lost more than 2.5%; the worst was **−9.86%**
- On the ORB entries the gap rate was 4.0%, averaging −3.26%

Roughly **one trade in eight breaks the stated loss cap**. Any expectancy
arithmetic that assumes "losses are 2%" is overstating the edge. This is
structural to holding overnight and cannot be tuned away; it can only be
reduced by avoiding earnings dates and by sizing for the gap rather than the
stop.

## 6. What to do with this

1. **Do not fund Bot E on the strength of the premise.** The premise failed its
   own test. Bot E is a fresh, unrelated hypothesis that happens to be flat.
2. **Run it on paper anyway if you want the swing question answered** — it is
   built, guarded and instrumented, and PF 1.02 in backtest is a far better
   starting point than Bot A's 0.56 was. Expect roughly one trade a week.
3. **The R-distribution is the kill signal, not the P&L** (post-mortem lesson
   2). If live target fill rate drops below ~10%, stop.
4. **Reconcile against broker fills before quoting any live number.** The local
   CSV is a convenience file; the dashboard's *Net (broker)* is the truth.
5. If you want a *better* use of this machinery: the MFE table in §1 says these
   volatile names swing ±8% over five days in both directions. That is an
   options-selling or mean-reversion observation, not a momentum one. The ORB
   universe may be worth trading — just not directionally.

---

*Method notes: entries come from the local CSVs but nothing here uses their P/L
column or pairs entries to exits — only (date, symbol, side, entry price), each
sanity-checked against that day's bar range; 16 of 313 rows were dropped on that
check. Backtest caveats: survivorship-biased universe, no portfolio caps,
same-bar ties scored as stop-before-target, entry at the close, 5bps each way.*
