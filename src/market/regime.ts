import { RSI, SMA, EMA } from 'technicalindicators';
import type { Candle } from './klines.js';
import type { RegimeThresholds } from '../config/index.js';

/**
 * MARKET REGIME — computed by the CODE, per tradable asset, never declared by the
 * model (mandate V2 §1). The model previously owned `market_state` and produced two
 * distinct values in 47 days, staying on `risk_off` while ETH climbed 27% off its
 * low. A regime the model asserts is an opinion; a regime the code computes is a
 * fact, and the model then decides INSIDE it.
 *
 * Three properties this module is built around:
 *
 *  1. PURE AND CAUSAL. The regime is a function of the candle series alone — no
 *     cross-cycle state, no DB read. At bar `t` it only ever looks at daily candles
 *     that CLOSED before `t` (the still-forming day is excluded by construction, in
 *     production exactly as in the replay) plus the 4h series up to `t`. So the same
 *     series always yields the same regime, whatever the wake-up cadence, and the
 *     replay reproduces production instead of approximating it.
 *
 *  2. PER ASSET. A single global label would reproduce today's blindness in
 *     deterministic form: over the observed window ETH did +11.4% while BNB did
 *     -5.5%, and one label cannot describe both.
 *
 *  3. HYSTERESIS. A raw label flips on 4h momentum, which is noisy. A candidate must
 *     hold for `confirmations` consecutive 4h bars before it replaces the active
 *     regime — otherwise we would trade immobility for noise.
 *
 * `risk_off` is deliberately NOT one of the per-asset labels: it is a portfolio
 * POSTURE, computed on the breadth of the whole universe, and it OVERRIDES the
 * per-asset regimes when active (see `effectiveRegime`).
 */

/** Bumped whenever the classification changes, so journaled regimes stay traceable. */
export const REGIME_VERSION = 'r1';

/** The five directional states. Structure of price — never a portfolio posture. */
export type AssetRegime = 'range' | 'trend_up' | 'trend_down' | 'reversal_up' | 'reversal_down';

/** What the rest of the system acts on: the per-asset regime, unless risk_off overrides it. */
export type EffectiveRegime = AssetRegime | 'risk_off';

export const ASSET_REGIMES: readonly AssetRegime[] = [
  'range',
  'trend_up',
  'trend_down',
  'reversal_up',
  'reversal_down',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The raw inputs the classifier reads, kept explicit so a journaled regime is auditable. */
export interface AssetSignals {
  /** The 4h close at this bar — the live price in production. */
  close: number;
  sma50: number | null;
  /** Recorded for the human audit trail; the cascade does not read it. */
  sma200: number | null;
  ema21Daily: number | null;
  rsi14Daily: number | null;
  /** Extremes of the last `rangeWindowDays` CLOSED daily candles. */
  rangeHigh: number | null;
  rangeLow: number | null;
  /** Where `close` sits in [rangeLow, rangeHigh], clamped to [0, 1]. */
  rangePosition: number | null;
  ema21H4: number | null;
  rsi14H4: number | null;
}

export interface AssetRegimePoint {
  /** The regime after hysteresis — the one that counts. */
  regime: AssetRegime;
  /** The unsmoothed classification at this bar (kept for auditing the noise). */
  raw: AssetRegime;
  /** 4h bars the CANDIDATE has held so far (0 when the raw label matches the active one). */
  pendingBars: number;
  /** The label waiting for confirmation, or null when raw == active. */
  pendingRegime: AssetRegime | null;
  /** Feeds the risk_off breadth: bearish daily structure AND weak daily momentum. */
  bearish: boolean;
  signals: AssetSignals;
}

export interface GlobalPosture {
  /** The override AFTER hysteresis. When true it supersedes every per-asset regime. */
  riskOff: boolean;
  /** The unsmoothed override at this bar. */
  raw: boolean;
  /** Share of the universe that is bearish, in percent. */
  breadthPercent: number;
  /** Median 4h RSI across the universe — the momentum half of the override. */
  medianH4Rsi: number | null;
  pendingBars: number;
}

export interface RegimePoint {
  timestamp: number;
  at: string;
  global: GlobalPosture;
  assets: Record<string, AssetRegimePoint>;
}

/** One asset's two series. Daily carries the structure, 4h the timing (mandate §2). */
export interface AssetSeries {
  daily: Candle[];
  h4: Candle[];
}

/**
 * The regime the rest of the system acts on: `risk_off` when the global override is
 * active, otherwise the asset's own directional regime. This is the ONLY place the
 * priority rule lives, so "the override wins" cannot drift between call sites.
 */
export function effectiveRegime(point: RegimePoint, asset: string): EffectiveRegime | null {
  const entry = point.assets[asset];
  if (!entry) return null;
  return point.global.riskOff ? 'risk_off' : entry.regime;
}

/** Left-pads an indicator output (shorter than its input) so index i matches candle i. */
function aligned(values: number[], length: number): Array<number | null> {
  const out = new Array<number | null>(length).fill(null);
  const offset = length - values.length;
  if (offset < 0) return out;
  for (let i = 0; i < values.length; i += 1) out[offset + i] = values[i] ?? null;
  return out;
}

interface DailyIndicators {
  sma50: Array<number | null>;
  sma200: Array<number | null>;
  ema21: Array<number | null>;
  rsi14: Array<number | null>;
}

function dailyIndicators(daily: Candle[]): DailyIndicators {
  const closes = daily.map((c) => c.close);
  const n = closes.length;
  return {
    sma50: aligned(SMA.calculate({ values: closes, period: 50 }), n),
    sma200: aligned(SMA.calculate({ values: closes, period: 200 }), n),
    ema21: aligned(EMA.calculate({ values: closes, period: 21 }), n),
    rsi14: aligned(RSI.calculate({ values: closes, period: 14 }), n),
  };
}

interface H4Indicators {
  ema21: Array<number | null>;
  rsi14: Array<number | null>;
}

function h4Indicators(h4: Candle[]): H4Indicators {
  const closes = h4.map((c) => c.close);
  const n = closes.length;
  return {
    ema21: aligned(EMA.calculate({ values: closes, period: 21 }), n),
    rsi14: aligned(RSI.calculate({ values: closes, period: 14 }), n),
  };
}

/**
 * Classifies ONE bar from its signals. Two ideas carry the whole cascade:
 *
 *  - STRUCTURE is the daily fast/slow relationship: an up-structure is price above
 *    the SMA50 **with the EMA21 also above it**. Deliberately NOT the SMA50's slope:
 *    a 50-day mean recovering from a drawdown keeps a negative slope for weeks, so
 *    slope-gating labelled ETH's entire +25% advance a `range` — the trend playbook
 *    would never have engaged. The fast/slow relationship confirms in days, which is
 *    the horizon a daily structure is supposed to have.
 *  - A REVERSAL is 4h momentum running AHEAD of the structure; a TREND is the two
 *    agreeing, confirmed by where price sits in its range.
 *
 * Reversals are therefore tested FIRST: a trend rolling over must be able to say so,
 * and testing `trend_up` first would swallow every top-of-trend turn — precisely the
 * profit-taking signal the V2 exists to produce. `range` is the honest fallback,
 * including when the series is too short (never guess a direction from missing data).
 */
export function classifyRaw(s: AssetSignals, th: RegimeThresholds): AssetRegime {
  const { sma50, ema21Daily, rangePosition, ema21H4, rsi14H4 } = s;
  if (sma50 == null || ema21Daily == null || rangePosition == null || ema21H4 == null || rsi14H4 == null) {
    return 'range';
  }

  const structureUp = s.close > sma50 && ema21Daily > sma50;
  const structureDown = s.close < sma50 && ema21Daily < sma50;
  const h4Up = s.close > ema21H4 && rsi14H4 >= th.h4RsiUp;
  const h4Down = s.close < ema21H4 && rsi14H4 <= th.h4RsiDown;

  // 1-2. Turns — momentum against a structure that has not (yet) confirmed the move.
  if (h4Down && !structureDown) return 'reversal_down';
  if (h4Up && !structureUp) return 'reversal_up';

  // 3-4. Established trends — structure and position in the range agree.
  if (structureUp && rangePosition >= th.highRangePosition) return 'trend_up';
  if (structureDown && rangePosition <= th.lowRangePosition) return 'trend_down';

  return 'range';
}

/** Bearish enough to count toward the risk_off breadth: structure AND momentum, both down. */
function isBearish(s: AssetSignals, th: RegimeThresholds): boolean {
  if (s.sma50 == null || s.ema21Daily == null || s.rsi14Daily == null) return false;
  return s.close < s.sma50 && s.close < s.ema21Daily && s.rsi14Daily < th.bearishDailyRsi;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo != null && hi != null ? (lo + hi) / 2 : null;
}

/**
 * The hysteresis state machine, shared by the per-asset regimes and the risk_off
 * override so the two can never use different smoothing. A value only becomes active
 * after it has been the raw reading for `confirmations` CONSECUTIVE bars; any bar
 * that reverts to the active value resets the pending counter.
 *
 * Deliberately stateless across calls: it always walks the series from the start, so
 * the regime stays a pure function of market data (see the module header).
 */
export class Hysteresis<T> {
  private active: T;
  private candidate: T | null = null;
  private streak = 0;

  constructor(
    initial: T,
    private readonly confirmations: number,
  ) {
    this.active = initial;
  }

  /** Feeds one raw reading and returns the state AFTER it. */
  push(raw: T): { value: T; pending: T | null; pendingBars: number } {
    if (raw === this.active) {
      this.candidate = null;
      this.streak = 0;
    } else if (raw === this.candidate) {
      this.streak += 1;
    } else {
      this.candidate = raw;
      this.streak = 1;
    }
    if (this.candidate !== null && this.streak >= this.confirmations) {
      this.active = this.candidate;
      this.candidate = null;
      this.streak = 0;
    }
    return { value: this.active, pending: this.candidate, pendingBars: this.streak };
  }
}

/**
 * Reads the signals for one asset at 4h bar `barIndex`.
 *
 * `dailyCursor` is the index of the last daily candle that had FULLY CLOSED before
 * this bar's timestamp — the caller advances it monotonically. Using only closed
 * days is what makes the function causal: production (where the last daily candle is
 * the still-forming day) and the replay (where it is complete) read exactly the same
 * inputs, so no look-ahead can sneak into either.
 */
function signalsAt(
  h4: Candle[],
  h4Ind: H4Indicators,
  barIndex: number,
  daily: Candle[],
  dailyInd: DailyIndicators,
  dailyCursor: number,
  th: RegimeThresholds,
): AssetSignals {
  const bar = h4[barIndex]!;
  const close = bar.close;

  let rangeHigh: number | null = null;
  let rangeLow: number | null = null;
  if (dailyCursor >= 0) {
    const from = Math.max(0, dailyCursor - th.rangeWindowDays + 1);
    for (let i = from; i <= dailyCursor; i += 1) {
      const c = daily[i]!;
      if (rangeHigh == null || c.high > rangeHigh) rangeHigh = c.high;
      if (rangeLow == null || c.low < rangeLow) rangeLow = c.low;
    }
  }

  let rangePosition: number | null = null;
  if (rangeHigh != null && rangeLow != null && rangeHigh > rangeLow) {
    rangePosition = Math.min(1, Math.max(0, (close - rangeLow) / (rangeHigh - rangeLow)));
  }

  return {
    close,
    sma50: dailyCursor >= 0 ? dailyInd.sma50[dailyCursor] ?? null : null,
    sma200: dailyCursor >= 0 ? dailyInd.sma200[dailyCursor] ?? null : null,
    ema21Daily: dailyCursor >= 0 ? dailyInd.ema21[dailyCursor] ?? null : null,
    rsi14Daily: dailyCursor >= 0 ? dailyInd.rsi14[dailyCursor] ?? null : null,
    rangeHigh,
    rangeLow,
    rangePosition,
    ema21H4: h4Ind.ema21[barIndex] ?? null,
    rsi14H4: h4Ind.rsi14[barIndex] ?? null,
  };
}

/**
 * The whole regime timeline for a universe of assets, one point per 4h bar.
 *
 * Bars are the INTERSECTION of every asset's 4h timestamps, so each point compares
 * the assets at the same instant — the risk_off breadth would be meaningless
 * otherwise. Production takes the last point (`resolveRegimes`); the replay walks
 * them all. Same code, same numbers.
 */
export function regimeTimeline(
  universe: Record<string, AssetSeries>,
  th: RegimeThresholds,
): RegimePoint[] {
  const assets = Object.keys(universe);
  if (assets.length === 0) return [];

  // Bars every asset has, in ascending order.
  let common: number[] | null = null;
  for (const asset of assets) {
    const stamps = new Set(universe[asset]!.h4.map((c) => c.timestamp));
    common = common == null ? [...stamps] : common.filter((t) => stamps.has(t));
  }
  const grid = (common ?? []).sort((a, b) => a - b);
  if (grid.length === 0) return [];

  // Per-asset precomputation: indicators, a timestamp→index map, and a monotonic
  // cursor over the closed daily candles.
  const prepared = assets.map((asset) => {
    const series = universe[asset]!;
    return {
      asset,
      daily: series.daily,
      dailyInd: dailyIndicators(series.daily),
      h4: series.h4,
      h4Ind: h4Indicators(series.h4),
      h4Index: new Map(series.h4.map((c, i) => [c.timestamp, i])),
      dailyCursor: -1,
      hysteresis: null as Hysteresis<AssetRegime> | null,
    };
  });
  const globalHysteresis = new Hysteresis<boolean>(false, th.confirmations);

  const points: RegimePoint[] = [];
  for (const timestamp of grid) {
    const perAsset: Record<string, AssetRegimePoint> = {};
    const h4Rsis: number[] = [];
    let bearishCount = 0;

    for (const p of prepared) {
      // Advance to the last daily candle that CLOSED at or before this bar.
      while (p.dailyCursor + 1 < p.daily.length && p.daily[p.dailyCursor + 1]!.timestamp + DAY_MS <= timestamp) {
        p.dailyCursor += 1;
      }
      const barIndex = p.h4Index.get(timestamp)!;
      const signals = signalsAt(p.h4, p.h4Ind, barIndex, p.daily, p.dailyInd, p.dailyCursor, th);
      const raw = classifyRaw(signals, th);
      p.hysteresis ??= new Hysteresis<AssetRegime>(raw, th.confirmations);
      const state = p.hysteresis.push(raw);
      const bearish = isBearish(signals, th);
      if (bearish) bearishCount += 1;
      if (signals.rsi14H4 != null) h4Rsis.push(signals.rsi14H4);

      perAsset[p.asset] = {
        regime: state.value,
        raw,
        pendingBars: state.pendingBars,
        pendingRegime: state.pending,
        bearish,
        signals,
      };
    }

    const breadthPercent = (bearishCount / prepared.length) * 100;
    const medianH4Rsi = median(h4Rsis);
    // Both halves must agree: a broadly broken structure AND weak momentum. Either
    // one alone is a normal pullback, not a reason to de-risk the whole book.
    const rawRiskOff =
      breadthPercent >= th.riskOffBreadthPercent &&
      medianH4Rsi != null &&
      medianH4Rsi < th.riskOffMedianH4Rsi;
    const globalState = globalHysteresis.push(rawRiskOff);

    points.push({
      timestamp,
      at: new Date(timestamp).toISOString(),
      global: {
        riskOff: globalState.value,
        raw: rawRiskOff,
        breadthPercent,
        medianH4Rsi,
        pendingBars: globalState.pendingBars,
      },
      assets: perAsset,
    });
  }

  return points;
}

/** The regime NOW: the last point of the timeline, or null when there is no usable data. */
export function resolveRegimes(
  universe: Record<string, AssetSeries>,
  th: RegimeThresholds,
): RegimePoint | null {
  const timeline = regimeTimeline(universe, th);
  return timeline.length > 0 ? timeline[timeline.length - 1] ?? null : null;
}

/**
 * The compact, journal-ready shape written to `decisions.regime`. Deliberately
 * flatter than `RegimePoint`: one line per asset with its effective regime, so a SQL
 * audit needs no JSON gymnastics, plus the signals that produced it.
 */
export interface RegimeJournal {
  version: string;
  /** The 4h bar the regime was computed on (NOT the wake-up time). */
  barAt: string;
  global: GlobalPosture;
  assets: Record<
    string,
    {
      effective: EffectiveRegime;
      regime: AssetRegime;
      raw: AssetRegime;
      pendingRegime: AssetRegime | null;
      pendingBars: number;
      bearish: boolean;
      signals: AssetSignals;
    }
  >;
}

export function toRegimeJournal(point: RegimePoint): RegimeJournal {
  const assets: RegimeJournal['assets'] = {};
  for (const [asset, entry] of Object.entries(point.assets)) {
    assets[asset] = {
      effective: point.global.riskOff ? 'risk_off' : entry.regime,
      regime: entry.regime,
      raw: entry.raw,
      pendingRegime: entry.pendingRegime,
      pendingBars: entry.pendingBars,
      bearish: entry.bearish,
      signals: entry.signals,
    };
  }
  return { version: REGIME_VERSION, barAt: point.at, global: point.global, assets };
}
