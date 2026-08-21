import type { BarRecord, EngineResult } from './engine.js';
import type { DeviationCause } from './allocate.js';

/**
 * THE METRICS — what the protocol asks to be published, and nothing derived on the sly.
 *
 * Two habits are enforced here rather than left to the caller:
 *
 * THE EXCESS IS NAMED IN FULL. It is `excess CAGR vs constant witness`, never "alpha". It
 * is not a regression alpha and it is not the bot's edge: the witness runs the SAME gate,
 * the SAME stops and the SAME movement floor, so the difference isolates the CONTROLLER
 * and nothing else. That sentence travels with the number everywhere it is printed.
 *
 * THE GAP IS SIGNED AND KEPT SIGNED. Under-exposure and over-exposure are both imposed and
 * both real; summing their absolute values would hide the direction that matters. They are
 * accumulated separately, per asset and per cause.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;

export interface GapBucket {
  /** Sum of NEGATIVE deviations, in percentage-points·bars. Imposed under-exposure. */
  underPercentPoints: number;
  /** Sum of POSITIVE deviations. Imposed over-exposure — the half usually forgotten. */
  overPercentPoints: number;
  /** How many bars each side was non-zero. */
  underBars: number;
  overBars: number;
}

export interface Metrics {
  bars: number;
  fromMs: number;
  toMs: number;
  openingEquity: number;
  closingEquity: number;
  /** Net of every fee and every slippage leg. */
  netReturnPercent: number;
  cagrPercent: number;
  maxDrawdownPercent: number;
  /** Cumulative days spent below a previous equity high. */
  timeUnderWaterDays: number;
  /** The single longest such stretch, in days. */
  longestUnderWaterDays: number;
  meanExposurePercent: number;
  medianExposurePercent: number;
  /** Traded notional as a multiple of mean equity. */
  turnoverRatio: number;
  tradedNotional: number;
  feesPaid: number;
  /** Bars where at least one move was dropped by the 2 % floor. */
  droppedByFloorBars: number;
  /** …of which the book was sitting on a band edge — the floor, not the policy, decided. */
  droppedAtBandEdgeBars: number;
  /** Signed gap `reached − projected`, split by sign. */
  gapTotal: GapBucket;
  /** The same, per asset. */
  gapByAsset: Record<string, GapBucket>;
  /** The same, per cause. `frozen` is the cost of the freeze. */
  gapByCause: Record<DeviationCause, GapBucket>;
  pendingNotExecuted: number;
  /** Bars spent in each context state — context for every other number here. */
  stateBars: Record<string, number>;
}

function emptyBucket(): GapBucket {
  return { underPercentPoints: 0, overPercentPoints: 0, underBars: 0, overBars: 0 };
}

function addToBucket(bucket: GapBucket, signed: number): void {
  if (signed < 0) {
    bucket.underPercentPoints += signed;
    bucket.underBars += 1;
  } else if (signed > 0) {
    bucket.overPercentPoints += signed;
    bucket.overBars += 1;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Max drawdown AND the time-under-water pair, in one pass over the equity curve.
 *
 * Time under water is reported two ways because they answer different questions: the
 * cumulative total says how much of the period was spent recovering, the longest stretch
 * says how long a single bad run lasted. A strategy can look calm on one and brutal on the
 * other, and an operator who has to live with it cares about the second.
 */
function drawdown(bars: BarRecord[], openingEquity: number): {
  maxDrawdownPercent: number;
  timeUnderWaterDays: number;
  longestUnderWaterDays: number;
} {
  /*
   * THE PEAK IS SEEDED FROM THE OPENING EQUITY, not from the first recorded bar.
   *
   * On a RESUMED window the two are different: the first bar is measured AFTER the boundary
   * order has been filled and after a full candle has moved. Seeding from that bar would make
   * the drop that produced it invisible — carry 1000 across the boundary, land at 900 on the
   * first bar, and 900 becomes the peak, so a real 10 % drawdown is silently erased.
   *
   * That is not cosmetic here: the out-of-sample gate is a drawdown limit, so the metric that
   * decides a verdict would be the one under-reporting.
   */
  let peak = openingEquity > 0 ? openingEquity : -Infinity;
  let maxDd = 0;
  let underMs = 0;
  let longestMs = 0;
  let currentStartMs: number | null = null;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    const next = bars[i + 1];
    // The bar's own duration, taken from the series rather than assumed: the 19/02/2020
    // hole means consecutive bars are not always 4h apart, and assuming they were would
    // under-count the time spent under water across the outage.
    const spanMs = next ? next.timestamp - bar.timestamp : 0;

    if (bar.equity > peak) peak = bar.equity;
    const dd = peak > 0 ? ((peak - bar.equity) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;

    if (dd > 0) {
      underMs += spanMs;
      if (currentStartMs == null) currentStartMs = bar.timestamp;
      longestMs = Math.max(longestMs, bar.timestamp + spanMs - currentStartMs);
    } else {
      currentStartMs = null;
    }
  }

  return {
    maxDrawdownPercent: maxDd,
    timeUnderWaterDays: underMs / MS_PER_DAY,
    longestUnderWaterDays: longestMs / MS_PER_DAY,
  };
}

export function computeMetrics(result: EngineResult, assets: readonly string[]): Metrics {
  const bars = result.bars;
  if (bars.length === 0) {
    throw new Error('metrics: the replay produced no evaluated bar — the window is empty');
  }

  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  const openingEquity = result.openingEquity;
  const closingEquity = last.equity;

  const netReturnPercent =
    openingEquity > 0 ? ((closingEquity - openingEquity) / openingEquity) * 100 : 0;

  // The span runs to the END of the last bar, not to its open: a period is not one bar
  // shorter than it was just because the final candle is stamped with its opening time.
  const barDurationMs = bars[1] ? bars[1].timestamp - first.timestamp : 0;
  const spanMs = last.timestamp + barDurationMs - first.timestamp;
  const years = spanMs / MS_PER_YEAR;
  const cagrPercent =
    years > 0 && openingEquity > 0
      ? (Math.pow(closingEquity / openingEquity, 1 / years) - 1) * 100
      : 0;

  const exposures = bars.map((b) => b.exposurePercent);
  const meanExposurePercent = exposures.reduce((s, x) => s + x, 0) / exposures.length;

  const tradedNotional = bars.reduce((s, b) => s + b.tradedNotional, 0);
  const feesPaid = bars.reduce((s, b) => s + b.feesPaid, 0);
  const meanEquity = bars.reduce((s, b) => s + b.equity, 0) / bars.length;

  const gapTotal = emptyBucket();
  const gapByAsset: Record<string, GapBucket> = {};
  for (const asset of assets) gapByAsset[asset] = emptyBucket();
  const gapByCause: Record<DeviationCause, GapBucket> = {
    frozen: emptyBucket(),
    cap: emptyBucket(),
    floor: emptyBucket(),
    stop: emptyBucket(),
  };
  const stateBars: Record<string, number> = {};

  let droppedByFloorBars = 0;
  let droppedAtBandEdgeBars = 0;

  for (const bar of bars) {
    stateBars[bar.state] = (stateBars[bar.state] ?? 0) + 1;
    addToBucket(gapTotal, bar.gapPercent);
    if (bar.droppedByFloor.length > 0) droppedByFloorBars += 1;
    if (bar.droppedAtBandEdge) droppedAtBandEdgeBars += 1;
    for (const dev of bar.deviations) {
      addToBucket(gapByAsset[dev.asset] ?? (gapByAsset[dev.asset] = emptyBucket()), dev.signedPercent);
      addToBucket(gapByCause[dev.cause], dev.signedPercent);
    }
  }

  return {
    bars: bars.length,
    fromMs: first.timestamp,
    toMs: last.timestamp,
    openingEquity,
    closingEquity,
    netReturnPercent,
    cagrPercent,
    ...drawdown(bars, openingEquity),
    meanExposurePercent,
    medianExposurePercent: median(exposures),
    turnoverRatio: meanEquity > 0 ? tradedNotional / meanEquity : 0,
    tradedNotional,
    feesPaid,
    droppedByFloorBars,
    droppedAtBandEdgeBars,
    gapTotal,
    gapByAsset,
    gapByCause,
    pendingNotExecuted: result.pendingNotExecuted,
    stateBars,
  };
}

/**
 * The headline comparison, named in full so it cannot be quoted as something it is not.
 *
 * `excessCagrPercent` is in PERCENTAGE POINTS of CAGR, against the arm's OWN frozen constant
 * witness — never against another arm's, and never against the equal-weight repère. The
 * witness has to be re-derived whenever the configuration changes (RSI, asymmetry), because
 * both move realised exposure: an unpaired witness stops controlling for beta, which is the
 * only reason it exists.
 */
export interface ExcessVsWitness {
  armCagrPercent: number;
  witnessCagrPercent: number;
  excessCagrPercent: number;
  armMeanExposurePercent: number;
  witnessMeanExposurePercent: number;
  /** |arm mean − witness mean|. The protocol pre-registers a 0.25-point tolerance. */
  exposureMismatchPoints: number;
  /** False when no target hit the tolerance: the witness cannot support an excess claim. */
  witnessIsSound: boolean;
}

/** Pre-registered before any result was looked at. Not tunable after the fact. */
export const WITNESS_EXPOSURE_TOLERANCE_POINTS = 0.25;

export function excessVsWitness(arm: Metrics, witness: Metrics): ExcessVsWitness {
  const mismatch = Math.abs(arm.meanExposurePercent - witness.meanExposurePercent);
  return {
    armCagrPercent: arm.cagrPercent,
    witnessCagrPercent: witness.cagrPercent,
    excessCagrPercent: arm.cagrPercent - witness.cagrPercent,
    armMeanExposurePercent: arm.meanExposurePercent,
    witnessMeanExposurePercent: witness.meanExposurePercent,
    exposureMismatchPoints: mismatch,
    witnessIsSound: mismatch <= WITNESS_EXPOSURE_TOLERANCE_POINTS,
  };
}
