# 1D Strategy Stress-Test (BTC/ETH/SOL spot, long-only)

> **Historical — crypto trading was retired 2026-07-28** (see
> `../../archive/crypto-donchian/`). This file is kept because it is the evidence
> behind that decision and because `trend-ma`, `donchian`, `htf-rsi`, `pullback`
> and `meanrev` still live here for stock backtests. Every number below was
> measured on **crypto** at a 0.6%/side fee. Do not carry these conclusions over
> to equities unchanged — stocks are ~commission-free, so the fee-sensitivity
> section in particular does not transfer. Re-run with `SYMBOL=SPY` before
> trusting any of these strategies on stocks.

Engine note: returns are ADDITIVE per-trade % on fixed $100 notional (not compounded).
NET already includes fees. Data: BTC 1D 2020-09 to 2026-06; backtests use most-recent 1500 bars (~from 2022-04).

## 1. Full history (BTC 1D, 0.6%/side)
| strat    | trades | win%  | NET    | PF   | maxDD($/100) |
|----------|--------|-------|--------|------|--------------|
| trend-ma | 7      | 57.1  | +127.7 | 5.26 | -15.5        |
| donchian | 12     | 41.7  | +36.1  | 1.71 | -27.1        |
| htf-rsi  | 11     | 72.7  | +57.0  | 3.64 | -7.2         |

## 2. Recent 700d vs older 800d (the decisive temporal split)
| strat    | recent700 NET (trades) | older800 NET (trades) |
|----------|------------------------|-----------------------|
| trend-ma | **-4.5%** (4)          | +105.0% (2, avgBars 237) |
| donchian | +12.2% (6)             | +23.9% (6)            |
| htf-rsi  | +8.1% (5)              | +48.9% (6, PF 7.79)   |

=> trend-ma's entire lifetime edge is ONE multi-month hold in the older window;
   it is NEGATIVE in the most recent ~2 years. donchian and htf-rsi are positive
   in BOTH halves, but both have thinner recent edges.

## 3. Disjoint 500d windows (skip 0 / 500 / 1000) BTC
| strat    | skip0   | skip500 | skip1000 |
|----------|---------|---------|----------|
| trend-ma | -7.6%   | +14.8%  | +15.4%(1 trade) |
| donchian | -23.1%  | +21.9%  | -9.8%    |
| htf-rsi  | +7.2%   | +15.9%  | +41.1%   |

=> htf-rsi positive in all three; trend-ma & donchian each have a clearly
   negative window. Most-recent window (skip0) negative for trend-ma & donchian.

## 4. Bull-market dependence / bear behavior
- trend-ma takes ZERO trades through the 2022 bear (EMA30<EMA100 keeps it flat) -> by
  design it sits out downtrends; it does not LOSE in bears, it just harvests bull legs.
- htf-rsi also blocked by its price>SMA100 filter in bears -> same protective behavior.
- Consequence: all returns are bull-leg-harvested. Edge = "ride uptrends without
  bleeding out in chop." None has demonstrated standalone profit in a sustained downtrend.

## 5. Fee sensitivity (BTC full, NET)
| strat    | 0.25% | 0.6%  | 1.0%  |
|----------|-------|-------|-------|
| trend-ma | 132.6 | 127.7 | 122.1 |
| donchian | 44.5  | 36.1  | 26.5  |
| htf-rsi  | 64.7  | 57.0  | 48.2  |
=> All robust to 1%/side (low trade counts; fees are not the risk here).

## 6. Cross-asset, 1D full, 0.6% (does the edge generalize off BTC?)
| strat    | ETH NET (PF) | SOL NET (PF)  |
|----------|--------------|---------------|
| trend-ma | +77.7 (3.84) | +392.5 (4.81, 22%win) |
| donchian | +91.4 (2.67) | +200.8 (3.00) |
| htf-rsi  | +32.6 (2.13) | **-44.1 (0.44)**  |
=> trend-ma & donchian generalize to ETH & SOL. htf-rsi BLOWS UP on SOL
   (-44%, maxDD -$79/100, 15% win, avg 4 bars = stops repeatedly run over).
   The dip-buy is fragile in very-high-vol assets.

## Trade-count honesty
EVERY 365d/500d sub-window rests on 0-5 trades — individually meaningless.
Even full-history counts are 7-13. All conclusions are low-N; treat as directional,
not statistically firm. trend-ma in particular is 7 trades with the result driven
by a single position.

## Verdict
- trend-ma: best headline number but it is ONE trade + negative recently. Reject as
  primary (overfit to a single 2023-24 trend).
- htf-rsi: best/most consistent on BTC across eras and lowest DD, but fails cross-asset
  (SOL) -> not robust as a general rule; BTC/ETH-only at best.
- donchian: weakest headline, but the ONLY strategy that is positive in BOTH BTC halves
  AND generalizes to ETH and SOL, with no catastrophic window. Most ROBUST, least
  impressive. If deploying one, deploy donchian on 1D, small size, BTC (+ optionally ETH).
- Honest answer: none clears a high bar on N. If forced: donchian (most robust);
  otherwise paper-trade.
