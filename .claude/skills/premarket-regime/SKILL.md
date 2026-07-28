---
name: premarket-regime
description: Decide today's trading direction (both / long_only / short_only / flat) for the ORB bots from overnight news and market context, and write it to regime.json. Use pre-market, between the 8:55 auto run and the 9:30 open.
---

# Pre-market regime call

You are deciding **which direction the ORB bots may trade today** and writing that
decision where they will read it. Bot B and Bot C both read `regime.json` at every
5-minute cycle.

Repo root: `C:\Users\sticx\OneDrive\Documents\Trading\bot`. Run every command from there.

## What you can and cannot do

You can only ever **narrow** what each account's env flags already allow. Setting
`long_only` does not turn short-only Bot C into a long bot — it stands Bot C down
for the day. Setting `flat` stands both bots down. Existing positions are still
managed and still flatten at 15:50 regardless of what you write.

Stances: `both`, `long_only`, `short_only`, `flat`.

## Step 1 — read the automated call first

```powershell
node regime.js --show
```

If that shows a stale date or nothing, the 8:55 scheduled task did not run. Compute
it yourself before going further:

```powershell
node regime.js --dry
```

Read the whole thing — the `components` block tells you *which* input drove the
score, and `inputs.news.sampleOff` / `sampleOn` show the actual headlines it matched.
Do not skip to the stance.

## Step 2 — gather what the script cannot see

The script matches keywords against Alpaca's Benzinga feed. It has no idea what a
headline *means*, cannot weigh a scheduled event, and cannot read a chart. Fill
exactly those gaps:

- **WebSearch** overnight macro and geopolitical news. Look for: escalation or
  de-escalation in an active conflict, central bank decisions, scheduled data
  releases (CPI, NFP, FOMC), tariffs, and anything that moved overnight futures.
- **Check whether a market-moving event lands TODAY.** An FOMC decision at 14:00
  is a reason to be cautious that no keyword scan will ever surface.
- **TradingView (optional).** If TradingView Desktop is running, `tv_health_check`
  succeeds and you can read SPY / QQQ / VIXY / USO for chart context. If it is not
  running, **skip it — do not launch it and do not block on it.** The decision must
  be makeable headless.

## Step 3 — decide, with a bias toward not intervening

**Default to accepting the automated stance.** Override only when you can name a
specific thing the script provably missed. Good reasons:

- A major de-escalation or escalation broke overnight that the keyword scan scored
  backwards or missed entirely.
- The score sits just inside a threshold and the news context clearly contradicts it.
- A scheduled event today (FOMC, CPI) makes directional conviction unwise → consider
  `both` rather than a one-sided stance.

Bad reasons — do not override for these:

- A general feeling about the market.
- Yesterday's price action, which the trend component already captured.
- One dramatic headline. The script already counts headlines; you are there to
  judge meaning, not to re-count.

Be aware of your own failure mode here: a war in the headlines does **not** mean
"short". On 2026-07-27 the US–Iran conflict was the top story and the tape rallied
on a pause in hostilities. Trade the reaction, not the event.

## Step 4 — write it

Only if you are overriding:

```powershell
node regime.js --set short_only --why "Iran strikes resumed overnight, Brent +6%, ES futures -1.4%"
```

`--why` is required and lands in `regime-history.csv` next to the inputs, so a bad
call can be audited later. Write a reason a stranger could evaluate — name the
evidence, not the conclusion.

If you are accepting the automated call, **write nothing.** The file is already correct.

## Step 5 — report

Tell the user, in a few lines:

- the stance now in force, and whether it is auto or your override
- the score and which component drove it
- what you found that the script could not see
- if you overrode: what specifically changed your mind

## Important

This heuristic has **not been validated against the bots' fills.** Every run appends
its inputs to `regime-history.csv` so it can be measured later. Until it has been,
say so when you report — present the stance as a prior, not a prediction, and never
imply the system knows the day will go a particular way.
