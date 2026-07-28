# Trading Bot Performance Report
**Period:** 2026-06-05 → 2026-06-08 (paper)  ·  **Generated:** 2026-06-08

## TL;DR
All three stock bots **lost money**, and almost all of the damage came on a single
session — **Monday 2026-06-08**, a violent semiconductor reversal/whipsaw day. The
strategy (Opening-Range Breakout) did roughly what ORB does on a choppy, gap-driven
reversal day: it got chopped up. The crypto bot correctly did nothing.

| Bot | Config | Trades | Wins | Net P/L | Verdict |
|-----|--------|:------:|:----:|--------:|---------|
| **A** | Long-only, fixed 2R target | 9 (2 days) | 2 | **−$22.57** | Least bad. Only bot with a green day (6/5 +$47). |
| **B** | Long **+** short, trailing stop | 7 (1 day) | 2 (+1 BE) | **−$79.33** | Trailing cut winners to breakeven; shorts still lost. |
| **C** | Short-only, fixed 2R target | 4 (1 day) | 0 | **−$146.32** | Worst. Shorted names already down 11–30% → squeezed. |
| Crypto (A only) | Donchian 55/20 daily | 0 | – | $0.00 | Working as designed — no breakout, no trade. |

> ⚠️ The bots have **1–2 sessions of data.** Nothing here is a verdict on edge — it's
> one bad-tape day. Treat this as "did the machinery behave correctly," not "is the
> strategy profitable."

---

## 1. The experiment design (this part is good)
You're running one strategy file (`stockbot.js`) three ways via env flags, on three
separate Alpaca paper accounts, off the **same watchlist**:

- **A** isolates the **long** edge (`ORB_LONGS=true`, fixed 2R target).
- **C** isolates the **short** edge (`ORB_LONGS=false, ORB_SHORTS=true`, fixed 2R).
- **B** runs **both directions + a trailing stop** (the "let winners run" variant).

That's a clean way to separate "is the long side working / the short side working /
does trailing beat a fixed target." The design is sound. The problem is the sample
size and a few bugs that pollute the measurement (below).

---

## 2. What actually happened, trade by trade

### The market on 6/8 (this is the whole story)
The pre-market scanner picked the **most extended names on the board** — exactly the
ones that had already made huge moves:

| Symbol | Prior move | What it is |
|--------|-----------:|------------|
| SOXL | −30.7% | 3× semis (long) |
| SOXS | +31.5% | 3× semis (inverse) |
| MRVL | −16.8% | Semiconductor |
| INTC | −11.5% | Semiconductor |
| TSLL | −13.3% | 2× Tesla |
| BITO/IBIT | −5% | Bitcoin proxies |

Notice these aren't 7 independent bets — they're **two concentrated bets** (semis and
crypto-beta) levered 3–4×. When semis whipsawed, four positions lost *together*.

And the names were **post-crash and mean-reverting**, not trending. ORB assumes a
breakout *continues*; on exhausted, reversing names the break fails and you get
stopped. That's the dominant cause of every red number in this report.

### Bot A — long-only (−$22.57)
- **6/5 (+$46.95):** SOXS long, target hit **+$82.62** (one clean trending move).
  MRVL long stopped −$35.67. *This is what a working day looks like.*
- **6/8 (−$69.52):** Went **long all 7 names** into a down tape. 1 winner (TSLL
  +$58), everything else stopped or bled to the close. Buying breakouts on a
  risk-off reversal day = fighting the tape.

### Bot B — long + short + trailing (−$79.33)
- Winners: TSLL +$57, IBIT +$1. BITO trailed out at **exactly breakeven ($0.00)**.
- Losers: SOXL short −$41, SOXS long −$45, MRVL short −$19, INTC short −$34.
- **The trailing stop hurt here.** On low-priced names the trail distance = the OR
  range, which was tiny (BITO $0.07, IBIT $0.25), so it strangled trades almost
  instantly and never let anything run — while doing nothing to save the shorts.

### Bot C — short-only (−$146.32, worst)
- **0 wins / 4.** SOXL −$43 (stop), MRVL −$40 (stop), INTC −$49 (stop), SOXS −$14.
- It **shorted names already down 11–30%** — i.e. it sold the bottom and got
  squeezed on the bounce. Every stop sat *above* entry and every one got hit.

### Crypto — did nothing, correctly
Donchian 55/20 on BTC saw no break of the 55-day high (BTC 60.5k → 63.8k over the
window). 4 runs, 4 "No entry signal." This is the strategy behaving exactly as
designed (it's meant to trade rarely). Not contributing data yet — that's fine.

---

## 3. Bugs that are corrupting the scorecard
These don't just cost money — they make the experiment **unmeasurable** until fixed.

1. **Exit reasons are mislabeled as "target" when they're really stops.**
   `stockbot.js:152-153` infers the reason from price: *"if the fill isn't past the
   stop, it must be the target."* When slippage lands a stop fill a hair on the wrong
   side, a **loss gets logged as a win**:
   - Bot A SOXS: exit $5.63 vs stop $5.62 → logged **"target"**, actually a **−$48.75 loss**.
   - Bot C MRVL: exit $292.14 vs stop $292.18 → logged **"target"**, actually a **−$40 loss**.
   Both flatter the record. **Fix:** read which bracket leg actually filled from the
   Alpaca order, don't infer from price.

2. **Position quantities desync (Bot B).** SOXS entered 118 shares but the EOD flatten
   logged qty **7**; INTC logged **−1**, MRVL **−2**. The flatten logs Alpaca's live
   `p.qty`, which drifts from the tracked entry when a trailing stop partially fills
   (and partial fills aren't detected at all). **Fix:** log realized P/L from fills and
   reconcile against entry qty; detect partial exits.

3. **The bots disagree on direction for the same symbol.** Bot A went **SOXS long**
   @ 6.02 (10:00); Bot C went **SOXS short** @ 5.57 (10:40) — opposite sides of the
   same whipsaw. With ~15-min-delayed bars and independent 5-min polling, each account
   sees a different "latest price" vs the opening range. **So part of the A-vs-C
   difference is noise, not strategy.** You can't cleanly attribute results until the
   accounts trade off the same data snapshot.

4. **Stale watchlist data.** The 6/8 watchlist lists MRVL at **263.46**, but it traded
   **282–294** intraday — the scanner's selection prices are ~1–2 days stale (the 6/8
   rows are byte-identical to the 6/6 rows). Free Alpaca data is 15-min delayed *and*
   the scan is running on cached numbers. README already flags this; it's the
   structural handicap on intraday ORB.

---

## 4. How to improve (ranked by impact)

**Fix the measurement first — otherwise you're tuning on lies:**
1. Fix the exit-reason mislabel (#1 above) — record true win/loss from the filled leg.
2. Fix qty reconciliation + partial-fill detection (#2).
3. Snapshot one data pull per cycle and share it across accounts (#3) so A/B/C are
   comparable.

**Then fix the strategy's biggest leak — it trades the wrong names in the wrong regime:**
4. **Add a regime filter.** Only take longs when SPY/QQQ is above its open/VWAP, only
   shorts when below. On 6/8 the tape was risk-off; Bot A fought it on 6 of 7 names.
5. **Stop trading exhausted names.** Skip any symbol whose prior-session move is, say,
   >15% — that's the single change that would have killed most of Bot C's squeezes and
   the worst of A's longs. ORB wants clean ranges, not post-crash chaos.
6. **Cap correlated exposure.** Max ~2 positions per sector and a daily max-loss
   kill-switch. 6/8 was effectively 2 bets held 7×; one stop-out cascade.

**Then refine exits/sizing:**
7. **Trailing distance is too tight (Bot B).** OR-range trails of $0.07 strangle
   low-priced names. Use an ATR-based or minimum-give-back trail.
8. **Notional cap distorts risk.** Intended risk is $50/trade, but `MAX_NOTIONAL=2000`
   caps tight-stop names down to ~$14–16 of real risk while wide-stop names carry the
   full $50 — a 3× spread, so the P/L columns aren't comparable across trades. Size on
   risk with a separate sanity cap.

**Finally — patience:**
9. **You have 1–2 days of data.** Don't conclude anything. Run the A/B/C harness for a
   few weeks across different tape regimes (trend days *and* chop days) before judging
   long vs short vs trailing. Right now the only honest conclusion is *"ORB gets
   chopped on a high-volatility reversal day"* — which you already knew.

---

## 5. One-line takeaways
- **Bot A** (long-only) is the most coherent and the only one that's shown a green day.
- **Bot C** (short-only) lost most because it shorted into already-crushed, bounce-prone names.
- **Bot B** (trailing) proved the trail is mistuned for cheap tickers more than it proved anything about shorts.
- **The real enemy was the watchlist + regime**, not the direction or the exit style — the scanner handed all three bots a basket of exhausted, correlated, mean-reverting names on a reversal day.
