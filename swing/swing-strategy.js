/**
 * Bot E — swing continuation. SHARED pure logic.
 *
 * Imported by swingbot.js (live), swing-scan.js (universe), swing-bt.js
 * (backtest) and mfe-study.js, so every one of them measures the same rules.
 * No I/O, no clock reads — everything is a function of the bars you pass in.
 *
 * ── Why this shape ───────────────────────────────────────────────────────────
 * The brief: cap losses at 1–2%, let winners reach 4–7%. That is a ~2.5:1
 * reward:risk, which breaks even at a 28.6% win rate instead of the 50.8% Bot A
 * needed. The arithmetic is friendlier — but only if the stop is wide enough to
 * survive normal noise, and that is the whole design problem here:
 *
 *   A 2% stop on a name whose ATR is 5% is not a stop, it is a coin flip.
 *
 * So the stop percentage is NOT tuned in isolation. `passesUniverseGate()`
 * refuses any symbol whose ATR(14) as a % of price is large relative to the
 * stop (SWING_MIN_STOP_ATR, default 0.8 → the stop must be at least 0.8×ATR).
 * With the default 2% stop that admits names up to 2.5% daily ATR. This is the
 * single most important knob in the file: it deliberately steers the universe
 * AWAY from the 3%+ daily-range movers that scan.js feeds the ORB bots, which
 * POSTMORTEM-BOT-A.md found were whipsaw-prone.
 *
 * The entry is a PULLBACK, not a breakout, for the same reason. A tight stop
 * needs an entry near a swing low, where the invalidation level is close by. A
 * 2% stop under a 20-day-high breakout is an arbitrary line in open air and
 * gets shaken out; a 2% stop under an oversold bounce inside an uptrend sits
 * below a level the market just defended. (`SWING_TRIGGER=breakout` is
 * available for comparison, and expected to do worse on a tight stop.)
 *
 * ── Known limitation, stated once, honestly ──────────────────────────────────
 * Holding overnight means gap risk, and a stop order does not cap a gap: it
 * becomes a market order at the open and fills wherever the tape is. So the
 * "losses are 1–2%" claim is true of stops that fill intraday and FALSE of gap
 * days. Expect a tail of −4% to −8% losers. `swing-bt.js` reports gap-through
 * fills separately rather than pretending the stop always held — check that
 * number before believing the loss-cap works.
 */

const num = (v, d) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const flag = (v, d) =>
  v == null || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v));

export const CFG = {
  // Exits — the brief's numbers.
  stopPct: num(process.env.SWING_STOP_PCT, 2.0) / 100,
  targetPct: num(process.env.SWING_TARGET_PCT, 5.0) / 100,

  // Breakeven ratchet: once price has travelled this far, pull the stop to
  // entry (+ a hair). This is the lever that turns would-be losers into
  // scratches, i.e. the "reduce losses" half of the brief. Set high enough
  // (past halfway to target) that it doesn't strangle the runners the whole
  // experiment is trying to catch.
  beAtPct: num(process.env.SWING_BREAKEVEN_AT_PCT, 3.0) / 100,
  beOffsetPct: num(process.env.SWING_BREAKEVEN_OFFSET_PCT, 0.1) / 100,
  beEnabled: flag(process.env.SWING_BREAKEVEN, true),

  // What counts as "the trade has moved 3%": a daily CLOSE at +3% (default) or
  // any intraday touch. Closes are the conservative choice *for the hypothesis*
  // — a wick to +3% that reverses would otherwise ratchet the stop to breakeven
  // and scratch a trade that might still have reached +5%. Since the point of
  // Bot E is to find out whether these moves continue, don't cut them on a wick.
  // Set SWING_RATCHET_ON=high to protect more aggressively instead.
  ratchetOn: (process.env.SWING_RATCHET_ON || "close").toLowerCase(),

  // Optional ATR trail, only ever applied AFTER breakeven is reached, and it
  // can only raise the stop. Off by default so the forward test measures the
  // stated hypothesis (fixed stop / fixed target) rather than a hybrid.
  trailAtrMult: num(process.env.SWING_TRAIL_ATR_MULT, 0),

  // Dead-money exit. Without it, a position that neither stops nor targets ties
  // up a slot forever and quietly caps how many bets the experiment can run.
  maxHoldDays: parseInt(process.env.SWING_MAX_HOLD_DAYS || "10", 10),

  // Trend / trigger.
  trigger: (process.env.SWING_TRIGGER || "pullback").toLowerCase(),
  fastLen: parseInt(process.env.SWING_FAST_LEN || "20", 10),
  slowLen: parseInt(process.env.SWING_SLOW_LEN || "50", 10),
  rsiLen: parseInt(process.env.SWING_RSI_LEN || "2", 10),
  rsiLongEntry: num(process.env.SWING_RSI_LONG_ENTRY, 15),
  rsiShortEntry: num(process.env.SWING_RSI_SHORT_ENTRY, 85),
  breakoutLen: parseInt(process.env.SWING_BREAKOUT_LEN || "20", 10),

  // Don't chase: refuse an entry more than this far from the fast MA.
  maxExtPct: num(process.env.SWING_MAX_EXT_PCT, 4.0) / 100,

  // Universe gates.
  minStopAtr: num(process.env.SWING_MIN_STOP_ATR, 0.8),
  atrLen: parseInt(process.env.SWING_ATR_LEN || "14", 10),
  minPrice: num(process.env.SWING_MIN_PRICE, 10),
  // High enough to admit SPY, QQQ and COST. A $600 cap looked harmless and was
  // not: it rejected the three calmest, most liquid instruments in the universe,
  // which are precisely the ones a 2% stop survives on. Price only matters here
  // through share granularity, and at ~$5k notional even a $900 name is 5+
  // shares.
  maxPrice: num(process.env.SWING_MAX_PRICE, 1200),
  // NOTE: this is measured on the free IEX feed, which sees only a single
  // venue's share of the tape — roughly a twentieth of consolidated volume. So
  // "$50M" here is NOT $50M of real turnover; it is a relative liquidity rank
  // among names quoted on the same feed. Don't reason about it as a dollar
  // figure, and don't port the number to a consolidated data source unscaled.
  minDollarVol: num(process.env.SWING_MIN_DOLLAR_VOL, 50e6),

  // Sides. Both on by default. Outside the neutral band the regime filter lets
  // only one fire on a given day, which keeps long/short attribution clean
  // inside one account (lesson 4 of the post-mortem — run the sleeves in ONE
  // account). Inside the band both are permitted; they still cannot collide on
  // the same name, because the per-symbol trend test that follows is disjoint.
  longs: flag(process.env.SWING_LONGS, true),
  shorts: flag(process.env.SWING_SHORTS, true),
  regime: flag(process.env.SWING_REGIME, true),
  regimeLen: parseInt(process.env.SWING_REGIME_LEN || "50", 10),
  // Half-width of the NEUTRAL zone around the regime MA, in percent.
  //
  // The filter existed to stop us buying into a falling market. Written as a
  // bare sign test it does much more than that: it hands the entire long sleeve
  // an off-switch the moment the index ticks a hair below its own average. On
  // 2026-07-28 SPY closed 0.54% under its SMA50 — inside a single day's ATR —
  // so every long was blocked, while only 3 of the 23 watchlist names were
  // themselves in downtrends (the index dipped; its constituents had not). The
  // short sleeve therefore had almost nothing to fire on either, and the day
  // was a structurally guaranteed zero-trade day rather than a considered pass.
  //
  // Inside the band the regime is "neutral", which lifts the veto on LONGS
  // only (see the asymmetry note in entrySignal — shorts still need a
  // decisively bear tape).
  //
  // DEFAULT 0, i.e. OFF, and that default is a measurement, not an oversight.
  // The zero-trade day is a real pathology, but backtesting the cure over 3
  // years says it costs more than it saves: the extra longs a band admits are
  // taken when SPY is under its own SMA50, and they are worse than the average
  // long — which is the filter doing its job, not failing at it.
  //
  //   band(asym)  n    win    PF    exp
  //   0           224  37.9%  1.02  +0.012R   <- shipped default
  //   0.5         225  37.8%  1.02  +0.010R
  //   1.0         224  37.5%  1.00  +0.000R
  //   1.5         225  36.9%  0.97  -0.020R
  //   2.0         220  38.6%  1.10  +0.063R   <- noise, not signal: +0.08R
  //                                              swing on 5 fewer trades than
  //                                              1.5. Do not chase it.
  //
  // Kept as a knob because the pathology is worth being able to switch off in a
  // hurry, and because the measurement should be re-runnable. If you enable it,
  // re-run `node swing-bt.js 1095` first and put the numbers in this table.
  regimeBandPct: num(process.env.SWING_REGIME_BAND_PCT, 0) / 100,
};

// Longest lookback any rule needs, plus room for the RSI seed.
export const WARMUP = Math.max(CFG.slowLen, CFG.regimeLen, CFG.breakoutLen, CFG.atrLen) + 10;

// ── indicators (all take oldest→newest, return the value at the LAST bar) ────

export function sma(vals, n) {
  if (!vals || vals.length < n) return null;
  let s = 0;
  for (let i = vals.length - n; i < vals.length; i++) s += vals[i];
  return s / n;
}

// Wilder's ATR. Uses true range so overnight gaps are counted — which is the
// whole point for a strategy that holds overnight.
export function atr(bars, n = 14) {
  if (!bars || bars.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
  }
  if (trs.length < n) return null;
  let v = trs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < trs.length; i++) v = (v * (n - 1) + trs[i]) / n;
  return v;
}

// Wilder RSI. At n=2 this is the Connors pullback oscillator: it pins near 0
// after two down closes and near 100 after two up closes, which is exactly the
// short-horizon exhaustion this entry wants.
export function rsi(closes, n = 2) {
  if (!closes || closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  let ag = g / n, al = l / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}

/** Everything the entry rules need, computed once from a daily-bar window. */
export function indicators(bars) {
  if (!bars || bars.length < WARMUP) return null;
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const a = atr(bars, CFG.atrLen);
  const priorHigh = Math.max(...bars.slice(-1 - CFG.breakoutLen, -1).map((b) => b.high));
  const priorLow = Math.min(...bars.slice(-1 - CFG.breakoutLen, -1).map((b) => b.low));
  return {
    price: last.close,
    prev,
    fast: sma(closes, CFG.fastLen),
    slow: sma(closes, CFG.slowLen),
    // RSI on CLOSED bars only. Live, the last daily bar is still forming, so
    // seeing its RSI would make the signal flicker all afternoon; the backtest
    // has no such bar and the two would silently diverge.
    rsiPrev: rsi(closes.slice(0, -1), CFG.rsiLen),
    atr: a,
    atrPct: a != null && last.close > 0 ? a / last.close : null,
    priorHigh,
    priorLow,
    dollarVol: sma(bars.slice(-20).map((b) => b.close * b.volume), Math.min(20, bars.length)),
  };
}

/**
 * Liquidity + volatility gate. Returns `{ok:true}` or `{ok:false, why}`.
 *
 * The ATR test is the load-bearing one: it is what makes a 2% stop mean
 * something. Rejecting a name here is a feature, not a missed trade.
 */
export function passesUniverseGate(bars, cfg = CFG) {
  const ind = indicators(bars);
  if (!ind) return { ok: false, why: "not enough history" };
  if (ind.price < cfg.minPrice || ind.price > cfg.maxPrice)
    return { ok: false, why: `price $${ind.price.toFixed(2)} outside $${cfg.minPrice}–$${cfg.maxPrice}` };
  if (!ind.dollarVol || ind.dollarVol < cfg.minDollarVol)
    return { ok: false, why: `avg $vol ${((ind.dollarVol || 0) / 1e6).toFixed(0)}M < ${(cfg.minDollarVol / 1e6).toFixed(0)}M` };
  if (ind.atrPct == null) return { ok: false, why: "no ATR" };
  const maxAtrPct = cfg.stopPct / cfg.minStopAtr;
  if (ind.atrPct > maxAtrPct)
    return {
      ok: false,
      why: `ATR ${(ind.atrPct * 100).toFixed(2)}% > ${(maxAtrPct * 100).toFixed(2)}% — a ${(cfg.stopPct * 100).toFixed(1)}% stop is inside the noise`,
    };
  return { ok: true, ind };
}

/**
 * "bull" | "bear" | "neutral" | null — from the regime symbol's own daily bars.
 *
 * "neutral" means the index is within `regimeBandPct` of its own average, i.e.
 * it is not making a directional statement worth vetoing a trade over. Callers
 * treat it as "no veto": the `regime !== "bear"` / `regime !== "bull"` tests in
 * entrySignal() already read it that way, so both sleeves stay open.
 *
 * `null` still means UNKNOWN (filter disabled, or not enough history) and is
 * likewise not a veto — do not conflate the two when logging.
 */
export function regimeOf(regimeBars, cfg = CFG) {
  if (!cfg.regime) return null;
  const closes = (regimeBars || []).map((b) => b.close);
  const ma = sma(closes, cfg.regimeLen);
  const px = closes[closes.length - 1];
  if (ma == null || px == null) return null;
  const dev = (px - ma) / ma;
  // `> 0` so that a band of 0 is EXACTLY the old sign test, including the
  // px == ma tie (which used to read "bull"). Without it the default would
  // quietly change behaviour on that one edge.
  if (cfg.regimeBandPct > 0 && Math.abs(dev) <= cfg.regimeBandPct) return "neutral";
  return dev >= 0 ? "bull" : "bear";
}

/**
 * Signed % deviation of the regime symbol from its MA. Logging only — but log
 * it, because "bear" alone hides whether the tape was decisively down or a
 * rounding error away from neutral, and that distinction is the whole point of
 * the band.
 */
export function regimeDevPct(regimeBars, cfg = CFG) {
  const closes = (regimeBars || []).map((b) => b.close);
  const ma = sma(closes, cfg.regimeLen);
  const px = closes[closes.length - 1];
  if (ma == null || px == null || !ma) return null;
  return ((px - ma) / ma) * 100;
}

/**
 * Entry decision on the last bar of `bars`. Returns `{side, reason}` or null.
 * `regime` is "bull" | "bear" | null (null = unknown → do not filter).
 */
export function entrySignal(bars, regime, cfg = CFG) {
  const gate = passesUniverseGate(bars, cfg);
  if (!gate.ok) return null;
  const i = gate.ind;
  if (i.fast == null || i.slow == null || i.rsiPrev == null) return null;

  const upTrend = i.price > i.slow && i.fast > i.slow;
  const downTrend = i.price < i.slow && i.fast < i.slow;
  const extLong = (i.price - i.fast) / i.fast;
  const extShort = (i.fast - i.price) / i.fast;

  // The band is deliberately ASYMMETRIC, and the backtest is why.
  //
  // Its job is to stop a hairline index reading from killing the long sleeve —
  // that is the 2026-07-28 failure. It is NOT a licence to short a market that
  // is not actually falling. Opening BOTH sleeves inside the band (the obvious
  // symmetric reading) tested worse over 3 years: it added 18 shorts to a
  // sleeve whose expectancy is negative in every configuration measured, and
  // took the whole strategy from +0.012R to +0.006R per trade.
  //
  //   band  shorts  n    win    PF    exp
  //   0     on      224  37.9%  1.02  +0.012R   <- current default
  //   1.0   on      249  38.2%  1.01  +0.006R   <- symmetric band
  //   1.5   on      258  36.8%  0.94  -0.042R
  //   0     off     188  38.8%  1.06  +0.035R   <- long-only
  //   1.0   off     195  38.5%  1.05  +0.032R
  //
  // The row that matters is the fourth. Dropping the short sleeve entirely
  // roughly TRIPLES expectancy (+0.012R -> +0.035R, PF 1.02 -> 1.06) and is
  // steadier year by year: 3 of 4 years positive instead of 2, and the worst
  // year improves from -0.269R to -0.155R. That is a SWING_SHORTS decision,
  // not a filter one, so it is not made here — but it is the single biggest
  // lever this strategy has, and it is why the band is not worth chasing.
  //
  // `null` (filter off / not enough history) is UNKNOWN and vetoes nothing,
  // which is a different thing from neutral — keep them distinct here.
  if (cfg.longs && upTrend && regime !== "bear" && extLong <= cfg.maxExtPct) {
    const trig =
      cfg.trigger === "breakout"
        ? i.price > i.priorHigh
        : i.rsiPrev <= cfg.rsiLongEntry && i.price > i.prev.high;
    if (trig)
      return {
        side: "long",
        reason:
          cfg.trigger === "breakout"
            ? `close>${cfg.breakoutLen}d high in uptrend`
            : `RSI${cfg.rsiLen} ${i.rsiPrev.toFixed(0)}≤${cfg.rsiLongEntry} then close>prior high, uptrend`,
      };
  }

  if (cfg.shorts && downTrend && regime !== "bull" && regime !== "neutral" && extShort <= cfg.maxExtPct) {
    const trig =
      cfg.trigger === "breakout"
        ? i.price < i.priorLow
        : i.rsiPrev >= cfg.rsiShortEntry && i.price < i.prev.low;
    if (trig)
      return {
        side: "short",
        reason:
          cfg.trigger === "breakout"
            ? `close<${cfg.breakoutLen}d low in downtrend`
            : `RSI${cfg.rsiLen} ${i.rsiPrev.toFixed(0)}≥${cfg.rsiShortEntry} then close<prior low, downtrend`,
      };
  }
  return null;
}

/** Initial bracket levels for a fill at `entry`. */
export function exitLevels(side, entry, cfg = CFG) {
  const long = side === "long" || side === "buy";
  return long
    ? { stop: entry * (1 - cfg.stopPct), target: entry * (1 + cfg.targetPct) }
    : { stop: entry * (1 + cfg.stopPct), target: entry * (1 - cfg.targetPct) };
}

/**
 * The most favourable price seen since entry, per CFG.ratchetOn. Pass the bars
 * from the entry bar onward (oldest→newest).
 */
export function bestSince(side, barsSinceEntry, cfg = CFG) {
  if (!barsSinceEntry || !barsSinceEntry.length) return null;
  const long = side === "long" || side === "buy";
  const pick = cfg.ratchetOn === "high" ? (b) => (long ? b.high : b.low) : (b) => b.close;
  const vals = barsSinceEntry.map(pick);
  return long ? Math.max(...vals) : Math.min(...vals);
}

/**
 * Where the stop SHOULD be now, given how far the trade has run.
 *
 * `best` is the most favourable price seen since entry (see `bestSince`).
 * Returns a stop that is never worse than the current one — a stop that can
 * loosen is not a stop.
 */
export function ratchetStop(side, entry, currentStop, best, atrVal, cfg = CFG) {
  const long = side === "long" || side === "buy";
  let stop = currentStop;
  const moved = long ? (best - entry) / entry : (entry - best) / entry;

  if (cfg.beEnabled && moved >= cfg.beAtPct) {
    const be = long ? entry * (1 + cfg.beOffsetPct) : entry * (1 - cfg.beOffsetPct);
    stop = long ? Math.max(stop, be) : Math.min(stop, be);

    if (cfg.trailAtrMult > 0 && atrVal) {
      const trail = long ? best - cfg.trailAtrMult * atrVal : best + cfg.trailAtrMult * atrVal;
      stop = long ? Math.max(stop, trail) : Math.min(stop, trail);
    }
  }
  // Never let the ratchet push the stop past the target — that would close the
  // trade at the stop leg for a "win" and corrupt the exit-reason mix.
  const tgt = exitLevels(side, entry, cfg).target;
  stop = long ? Math.min(stop, tgt * 0.999) : Math.max(stop, tgt * 1.001);
  return stop;
}

export const roundCents = (x) => Math.round(x * 100) / 100;
