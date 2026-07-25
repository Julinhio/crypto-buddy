import assert from 'node:assert/strict';
import { config, validateRegimeConfig, type RegimeConfig, type RegimeThresholds } from '../config/index.js';
import { fetchTacticalSeries } from '../context/build.js';
import type { Candle } from '../market/klines.js';
import {
  Hysteresis,
  classifyRaw,
  effectiveRegime,
  regimeTimeline,
  toRegimeJournal,
  type AssetRegime,
  type AssetSeries,
  type AssetSignals,
  type RegimeOptions,
} from '../market/regime.js';

/**
 * Regime invariants — run with `npm test` (tsx). No framework, just asserts.
 *
 * The replay harness proves the classifier says sensible things about the REAL 47
 * days; these tests prove the properties that must hold whatever the market does:
 * the classification cascade, the hysteresis contract, the priority of the risk_off
 * override, and — the one that is easy to break silently — CAUSALITY: no bar may
 * ever read a daily candle that had not closed yet.
 */

const th = config.regime.thresholds;
let passed = 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const H4_MS = 4 * 60 * 60 * 1000;

/** A signals object that classifies as `range`, to be perturbed per case. */
const neutral = (over: Partial<AssetSignals> = {}): AssetSignals => ({
  close: 100,
  sma50: 100,
  sma200: 100,
  ema21Daily: 100,
  rsi14Daily: 50,
  rangeHigh: 120,
  rangeLow: 80,
  rangePosition: 0.5,
  ema21H4: 100,
  rsi14H4: 50,
  h4RangeHigh: 110,
  h4RangeLow: 90,
  h4RangePosition: 0.5,
  ...over,
});

{
  // The cascade produces each of the five labels, and `range` is the honest fallback.
  assert.equal(classifyRaw(neutral(), th), 'range', 'a directionless bar is a range');

  assert.equal(
    classifyRaw(neutral({ close: 115, sma50: 100, ema21Daily: 108, rangePosition: 0.9, h4RangePosition: 0.9, ema21H4: 112, rsi14H4: 52 }), th),
    'trend_up',
    'confirmed up-structure, high in the range, no 4h flip → trend_up',
  );
  assert.equal(
    classifyRaw(neutral({ close: 85, sma50: 100, ema21Daily: 92, rangePosition: 0.1, h4RangePosition: 0.1, ema21H4: 87, rsi14H4: 48 }), th),
    'trend_down',
    'confirmed down-structure, low in the range → trend_down',
  );
  assert.equal(
    classifyRaw(neutral({ close: 115, sma50: 100, ema21Daily: 108, rangePosition: 0.9, ema21H4: 118, rsi14H4: 35 }), th),
    'reversal_down',
    'an uptrend whose 4h momentum turns down → reversal_down, NOT trend_up',
  );
  assert.equal(
    classifyRaw(neutral({ close: 88, sma50: 100, ema21Daily: 95, rangePosition: 0.25, ema21H4: 85, rsi14H4: 62 }), th),
    'reversal_up',
    'a downtrend whose 4h momentum turns up → reversal_up',
  );
  console.log('  ok: the cascade produces all five directional labels');
  passed += 1;
}

{
  // REGRESSION GUARD, found by the replay on real candles. The structure test used to
  // be the SMA50's SLOPE, and a 50-day mean recovering from a drawdown keeps a
  // negative slope for weeks: ETH's whole +25% advance came back as `range` and the
  // trend playbook could never have engaged. The structure is the fast/slow
  // relationship, so a still-falling SMA50 must NOT block a confirmed uptrend.
  const recovering = neutral({
    close: 1876, sma50: 1752, ema21Daily: 1755, rangePosition: 0.95, h4RangePosition: 0.92, ema21H4: 1817, rsi14H4: 54,
  });
  assert.equal(
    classifyRaw(recovering, th),
    'trend_up',
    'price and EMA21 above a still-falling SMA50, high in the range → trend_up',
  );
  // And the symmetric case: price back under a still-rising SMA50 is a real downtrend.
  const rolling = neutral({
    close: 1600, sma50: 1750, ema21Daily: 1700, rangePosition: 0.08, h4RangePosition: 0.05, ema21H4: 1650, rsi14H4: 47,
  });
  assert.equal(classifyRaw(rolling, th), 'trend_down', 'the symmetric down case holds too');
  console.log('  ok: a lagging SMA50 slope no longer masks a confirmed trend');
  passed += 1;
}

{
  // Reversals are tested BEFORE trends on purpose: the whole point of the V2 is that a
  // trend rolling over can say so. If trends were tested first, the top-of-trend turn —
  // the profit-taking signal — would be unreachable.
  const rollingOver = neutral({
    close: 118, sma50: 100, ema21Daily: 110, rangePosition: 0.95, ema21H4: 120, rsi14H4: 40,
  });
  assert.equal(classifyRaw(rollingOver, th), 'reversal_down', 'a top-of-trend turn is reachable');

  // And a trend with hot 4h momentum stays a trend — the reversal_up guard requires the
  // structure NOT to have confirmed, so a strong uptrend is not mislabelled a reversal.
  const stillTrending = neutral({
    close: 118, sma50: 100, ema21Daily: 110, rangePosition: 0.95, h4RangePosition: 0.9, ema21H4: 110, rsi14H4: 70,
  });
  assert.equal(classifyRaw(stillTrending, th), 'trend_up', 'a hot uptrend is not a reversal_up');
  console.log('  ok: reversals win over trends, but a confirmed trend is not mislabelled');
  passed += 1;
}

{
  // A trend needs BOTH horizons to agree on position. The mandate splits the read in
  // two (§1 structure on the daily, §2 timing on the 4h), and a trend is precisely
  // where they say the same thing. Either horizon alone would over-label: pushing the
  // top of a 7-day range while stuck mid-month is a bounce inside a range, and sitting
  // high on the month while fading on the 4h has stopped trending.
  const monthlyOnly = neutral({
    close: 115, sma50: 100, ema21Daily: 108, rangePosition: 0.9, h4RangePosition: 0.3, ema21H4: 112, rsi14H4: 52,
  });
  assert.equal(classifyRaw(monthlyOnly, th), 'range', 'high on the month but mid-4h is not a trend_up');

  const tacticalOnly = neutral({
    close: 115, sma50: 100, ema21Daily: 108, rangePosition: 0.45, h4RangePosition: 0.95, ema21H4: 112, rsi14H4: 52,
  });
  assert.equal(classifyRaw(tacticalOnly, th), 'range', 'topping a 7-day range mid-month is not a trend_up');

  const downMonthlyOnly = neutral({
    close: 85, sma50: 100, ema21Daily: 92, rangePosition: 0.1, h4RangePosition: 0.7, ema21H4: 87, rsi14H4: 48,
  });
  assert.equal(classifyRaw(downMonthlyOnly, th), 'range', 'the symmetric down case needs both horizons too');
  console.log('  ok: a trend requires the daily and 4h range positions to agree');
  passed += 1;
}

{
  // Missing data never invents a direction.
  for (const missing of ['sma50', 'ema21Daily', 'rangePosition', 'h4RangePosition', 'ema21H4', 'rsi14H4'] as const) {
    const signals = neutral({ close: 200, [missing]: null });
    assert.equal(classifyRaw(signals, th), 'range', `a null ${missing} degrades to range`);
  }
  console.log('  ok: incomplete signals degrade to range, never to a guessed direction');
  passed += 1;
}

{
  // The RSI dead band is real: 45 < rsi < 55 is neither up nor down momentum, whatever
  // the price does relative to EMA21. Without it, a bar one tick either side of the
  // midline would flip the regime.
  const above = neutral({ close: 110, ema21H4: 100, rsi14H4: 50, sma50: 100, ema21Daily: 100, rangePosition: 0.5 });
  const below = neutral({ close: 90, ema21H4: 100, rsi14H4: 50, sma50: 100, ema21Daily: 100, rangePosition: 0.5 });
  assert.equal(classifyRaw(above, th), 'range', 'RSI in the dead band above EMA21 → no up momentum');
  assert.equal(classifyRaw(below, th), 'range', 'RSI in the dead band below EMA21 → no down momentum');
  console.log('  ok: the 4h RSI dead band blocks momentum readings around the midline');
  passed += 1;
}

{
  // Hysteresis: a candidate must hold `confirmations` CONSECUTIVE bars, and any bar
  // that reverts to the active value resets the count from scratch.
  const h = new Hysteresis<AssetRegime>('range', 3);
  assert.equal(h.push('trend_up').value, 'range', '1 bar of disagreement does not flip');
  assert.equal(h.push('trend_up').value, 'range', '2 bars do not flip');
  assert.equal(h.push('trend_up').value, 'trend_up', 'the 3rd consecutive bar flips it');

  const reset = new Hysteresis<AssetRegime>('range', 3);
  reset.push('trend_up');
  reset.push('trend_up');
  assert.equal(reset.push('range').value, 'range', 'reverting to the active value is a no-op');
  assert.equal(reset.push('trend_up').value, 'range', 'the streak restarted from zero');
  assert.equal(reset.push('trend_up').value, 'range', 'still only 2 consecutive');
  assert.equal(reset.push('trend_up').value, 'trend_up', 'and flips on the 3rd');

  // A candidate replaced by a DIFFERENT candidate also restarts the count.
  const swap = new Hysteresis<AssetRegime>('range', 3);
  swap.push('trend_up');
  swap.push('trend_up');
  assert.equal(swap.push('trend_down').value, 'range', 'a new candidate does not inherit the streak');
  assert.equal(swap.push('trend_down').value, 'range', '2 consecutive of the new candidate');
  assert.equal(swap.push('trend_down').value, 'trend_down', 'flips on its own 3rd bar');
  console.log('  ok: hysteresis requires N consecutive bars and resets on any revert or swap');
  passed += 1;
}

{
  // The override is a PRIORITY, not a sixth label: it replaces what the system acts on
  // while leaving each asset's own directional regime intact underneath.
  const point = {
    timestamp: 0,
    at: '1970-01-01T00:00:00.000Z',
    global: {
      riskOff: true, raw: true, breadthPercent: 100, medianH4Rsi: 20,
      assetsPresent: 2, assetsExpected: 2, pendingBars: 0,
    },
    assets: {
      BTC: { regime: 'trend_up' as AssetRegime, raw: 'trend_up' as AssetRegime, pendingBars: 0, pendingRegime: null, bearish: false, signals: neutral() },
      ETH: { regime: 'range' as AssetRegime, raw: 'range' as AssetRegime, pendingBars: 0, pendingRegime: null, bearish: true, signals: neutral() },
    },
  };
  assert.equal(effectiveRegime(point, 'BTC'), 'risk_off', 'risk_off overrides a per-asset trend_up');
  assert.equal(effectiveRegime(point, 'ETH'), 'risk_off', 'risk_off overrides every asset at once');
  assert.equal(point.assets.BTC.regime, 'trend_up', 'the asset keeps its own regime underneath');
  assert.equal(effectiveRegime(point, 'DOGE'), null, 'an unknown asset has no regime, not a default one');

  const calm = { ...point, global: { ...point.global, riskOff: false } };
  assert.equal(effectiveRegime(calm, 'BTC'), 'trend_up', 'with the override off, the asset regime is what counts');

  const journal = toRegimeJournal(point);
  assert.equal(journal.assets.BTC?.effective, 'risk_off', 'the journal records the effective regime');
  assert.equal(journal.assets.BTC?.regime, 'trend_up', 'and the overridden one, so the audit sees both');
  console.log('  ok: risk_off overrides every per-asset regime without erasing it');
  passed += 1;
}

/**
 * Regime options for a synthetic universe: a clock far past every bar (so nothing is
 * treated as still forming, unless a case says otherwise) and a denominator equal to
 * the universe under test.
 */
const opts = (universe: Record<string, AssetSeries>, nowMs = Number.MAX_SAFE_INTEGER): RegimeOptions => ({
  nowMs,
  barMs: H4_MS,
  universeSize: Object.keys(universe).length,
});

/** Builds `count` daily candles of constant close, then `overrides` applied by index. */
function dailySeries(count: number, close: number, overrides: Record<number, number> = {}): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    const c = overrides[i] ?? close;
    out.push({ timestamp: i * DAY_MS, open: c, high: c, low: c, close: c, volume: 0 });
  }
  return out;
}

/** 4h candles covering `days` days at constant close, six bars a day. */
function h4Series(days: number, close: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < days * 6; i += 1) {
    out.push({ timestamp: i * H4_MS, open: close, high: close, low: close, close, volume: 0 });
  }
  return out;
}

{
  // CAUSALITY — the property that keeps the replay honest. The classifier must never
  // read a daily candle that has not closed yet: in production the last daily candle is
  // the still-forming day, and if it were used, the replay (where that candle is
  // complete) would silently see the future.
  //
  // Setup: 80 flat days, then a violent final day. Every 4h bar of that final day must
  // still read the FLAT SMA50 — the spike may only be visible from the next day on.
  const days = 80;
  const daily = dailySeries(days, 100, { [days - 1]: 1000 });
  const h4 = h4Series(days, 100);
  const universe: Record<string, AssetSeries> = { X: { daily, h4 } };
  const timeline = regimeTimeline(universe, th, opts(universe));

  const lastDayStart = (days - 1) * DAY_MS;
  const barsOfLastDay = timeline.filter((p) => p.timestamp >= lastDayStart);
  assert.ok(barsOfLastDay.length > 0, 'the final day produced bars');
  for (const p of barsOfLastDay) {
    assert.equal(
      p.assets.X!.signals.sma50,
      100,
      'a bar inside the forming day must not see that day close — no look-ahead',
    );
  }
  console.log('  ok: the classifier is causal — the forming daily candle is never read');
  passed += 1;
}

{
  // Bars are the INTERSECTION of the assets' 4h timestamps: comparing assets at
  // different instants would make the risk_off breadth meaningless.
  const long = { daily: dailySeries(60, 100), h4: h4Series(60, 100) };
  const short: AssetSeries = { daily: dailySeries(60, 100), h4: h4Series(60, 100).slice(0, 100) };
  const pair = { A: long, B: short };
  const timeline = regimeTimeline(pair, th, opts(pair));
  assert.equal(timeline.length, 100, 'the timeline is bounded by the shortest 4h series');
  for (const p of timeline) {
    assert.ok(p.assets.A && p.assets.B, 'every point carries every asset');
  }
  assert.deepEqual(regimeTimeline({}, th, opts({})), [], 'an empty universe yields an empty timeline');
  console.log('  ok: the timeline is the intersection of the assets 4h bars');
  passed += 1;
}

{
  // The STILL-FORMING 4h candle must never enter the grid. ccxt returns it as the last
  // element; its close, RSI and EMA mutate between two wake-ups inside the same bar, so
  // including it would make the regime depend on WHEN in the bar we looked, and would
  // let that mutating bar spend one of the three confirmations — flipping a stabilized
  // regime up to four hours early.
  const days = 40;
  const universe: Record<string, AssetSeries> = { X: { daily: dailySeries(days, 100), h4: h4Series(days, 100) } };
  const bars = universe.X!.h4;
  const lastBar = bars[bars.length - 1]!;

  // A clock one millisecond before the last bar closes → that bar is still forming.
  const forming = regimeTimeline(universe, th, opts(universe, lastBar.timestamp + H4_MS - 1));
  const closed = regimeTimeline(universe, th, opts(universe, lastBar.timestamp + H4_MS));
  assert.equal(closed.length, forming.length + 1, 'the forming bar joins the grid exactly when it closes');
  assert.equal(
    forming[forming.length - 1]!.timestamp,
    bars[bars.length - 2]!.timestamp,
    'mid-bar, the regime is anchored on the last CLOSED bar',
  );

  // And the answer must not drift while the bar is forming: two different clocks
  // inside the same open bar produce the same regime.
  const early = regimeTimeline(universe, th, opts(universe, lastBar.timestamp + 1));
  assert.equal(early.length, forming.length, 'the grid is identical anywhere inside the open bar');
  console.log('  ok: the still-forming 4h candle never enters the grid');
  passed += 1;
}

{
  // The risk_off breadth denominator is the CONFIGURED universe, not the assets that
  // happened to load. Otherwise a cycle where two of five series failed would read
  // "3 bearish of 3" as 100% breadth and arm a portfolio-wide de-risk on a partial
  // view of the market.
  const bearish = { daily: dailySeries(60, 100, { 59: 100 }), h4: h4Series(60, 100) };
  const loaded: Record<string, AssetSeries> = { A: bearish, B: bearish, C: bearish };
  const full = regimeTimeline(loaded, th, { nowMs: Number.MAX_SAFE_INTEGER, barMs: H4_MS, universeSize: 5 });
  const point = full[full.length - 1]!;
  assert.equal(point.global.assetsExpected, 5, 'the denominator is the configured universe');
  assert.equal(point.global.assetsPresent, 3, 'and the shortfall is journaled, not hidden');
  assert.ok(
    point.global.breadthPercent <= (3 / 5) * 100 + 1e-9,
    'three assets can never express more than 3/5 of the breadth',
  );
  // A denominator SMALLER than what loaded would be nonsense; the code takes the max.
  const understated = regimeTimeline(loaded, th, { nowMs: Number.MAX_SAFE_INTEGER, barMs: H4_MS, universeSize: 1 });
  assert.equal(
    understated[understated.length - 1]!.global.assetsExpected,
    3,
    'an understated universeSize cannot inflate the breadth above 100%',
  );
  console.log('  ok: the risk_off breadth is measured against the configured universe');
  passed += 1;
}

{
  // The config validator closes the classes that would make the cascade lie, rather
  // than patching one bad value at a time.
  const base: RegimeConfig = config.regime;
  const withThresholds = (over: Partial<RegimeThresholds>): RegimeConfig => ({
    ...base,
    thresholds: { ...base.thresholds, ...over },
  });
  assert.doesNotThrow(() => validateRegimeConfig(base), 'the shipped config is valid');
  assert.throws(
    () => validateRegimeConfig(withThresholds({ h4RsiUp: 40, h4RsiDown: 60 })),
    /h4RsiDown .* must be strictly below h4RsiUp/,
    'a crossed RSI band is rejected — one bar could read as both up and down',
  );
  assert.throws(
    () => validateRegimeConfig(withThresholds({ lowRangePosition: 0.8, highRangePosition: 0.2 })),
    /lowRangePosition .* must be strictly below highRangePosition/,
    'a crossed range band is rejected',
  );
  assert.throws(
    () => validateRegimeConfig(withThresholds({ confirmations: 0 })),
    /confirmations must be an integer >= 1/,
    'confirmations = 0 is rejected — hysteresis would be a no-op',
  );
  assert.throws(
    () => validateRegimeConfig({ ...base, limit: 50 }),
    /limit must be an integer >= 100/,
    'a 4h window too short for the warm-up is rejected',
  );
  console.log('  ok: the regime config validator rejects the whole class of incoherent thresholds');
  passed += 1;
}

{
  // SHADOW MODE is only real if the live path cannot notice the regime layer BREAKING.
  // A rejected tactical fetch must degrade to "no regime for this pair", never bubble
  // up — a thrown error would drop the whole pair, shrinking the LLM's allocatable
  // universe and changing decision behavior from a shadow-only feature.
  const ok = await fetchTacticalSeries(async () => h4Series(2, 100), 'X 4h');
  assert.equal(ok.length, 12, 'a successful fetch is passed through untouched');

  const failed = await fetchTacticalSeries(async () => {
    throw new Error('binance 4h timeout');
  }, 'X 4h');
  assert.deepEqual(failed, [], 'a rejected tactical fetch degrades to an empty series');

  // The pair then simply sits out of the regime: an empty 4h series yields no bars for
  // it, so it cannot corrupt the timeline either.
  const universe: Record<string, AssetSeries> = { X: { daily: dailySeries(40, 100), h4: failed } };
  assert.deepEqual(regimeTimeline(universe, th, opts(universe)), [], 'no 4h series → no regime, no crash');
  console.log('  ok: a broken tactical fetch cannot remove a pair from the live context');
  passed += 1;
}

console.log(`\n${passed} regime invariant checks passed.`);
