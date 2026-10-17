import type { RunResult } from './engine.js';

/**
 * WHAT A RUN PUBLISHES — protocol v1.3, points 8, 9 and 12. Descriptive, no threshold here:
 * admissibility and verdicts are applied by the step that may apply them.
 */

const MS_PER_DAY = 86_400_000;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;

export interface ExposureDistribution {
  median: number;
  q1: number;
  q3: number;
  p90: number;
  /** Share of 4h bars in each zone, in percent. Zones are [0,20) [20,50) [50,80) [80,100]. */
  timeInZonePercent: { '0-20': number; '20-50': number; '50-80': number; '80-100': number };
  mean: number;
}

export interface RunMetrics {
  policy: string;
  window: string;
  bars: number;
  openingEquity: number;
  closingEquity: number;
  netReturnPercent: number;
  annualisedReturnPercent: number;
  /** Continuous from the trajectory high, on 4h close equity. */
  maxDrawdownPercent: number;
  timeUnderHighPercent: number;
  longestUnderHighDays: number;
  feesPaid: number;
  slippageCost: number;
  tradedNotional: number;
  /** Traded notional / mean equity. */
  turnover: number;
  exposure: ExposureDistribution;
  stopExits: number;
  barsWithCapacityShortfall: number;
  barsWithOverExposure: number;
  suppressedLegs: Record<string, number>;
  pendingNotExecuted: number;
  /** Turnover (traded / mean equity) by the cause of the order that traded. */
  turnoverByCause: Record<string, number>;
  /** Fees plus slippage, in percent of the opening equity. */
  frictionPercentOfOpening: number;
}

/** Linear-interpolated quantile on a sorted copy. Deterministic, no library. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function exposureDistribution(exposures: readonly number[]): ExposureDistribution {
  const n = exposures.length || 1;
  const zone = (lo: number, hi: number, inclusiveHi = false): number =>
    (exposures.filter((e) => e >= lo && (inclusiveHi ? e <= hi + 1e-9 : e < hi)).length / n) * 100;
  return {
    median: quantile(exposures, 0.5),
    q1: quantile(exposures, 0.25),
    q3: quantile(exposures, 0.75),
    p90: quantile(exposures, 0.9),
    timeInZonePercent: {
      '0-20': zone(-1e-9, 20),
      '20-50': zone(20, 50),
      '50-80': zone(50, 80),
      '80-100': zone(80, 100, true),
    },
    mean: exposures.reduce((s, e) => s + e, 0) / n,
  };
}

/**
 * Daily log returns from the 4h close equity: the equity at the last bar of each UTC day
 * (the bar whose close is midnight), the first point being the window's opening equity.
 */
export function dailyLogReturns(run: RunResult, barMs: number): { dayEndMs: number[]; logReturns: number[] } {
  const dayEnds = run.bars.filter((b) => (b.t + barMs) % MS_PER_DAY === 0);
  const logReturns: number[] = [];
  let previous = run.openingEquity;
  for (const bar of dayEnds) {
    logReturns.push(Math.log(bar.equity / previous));
    previous = bar.equity;
  }
  return { dayEndMs: dayEnds.map((b) => b.t + barMs), logReturns };
}

export function computeRunMetrics(run: RunResult, barMs: number): RunMetrics {
  const bars = run.bars;
  const closing = bars.length > 0 ? bars[bars.length - 1]!.equity : run.openingEquity;
  const years = (run.window.toMs - run.window.fromMs) / MS_PER_YEAR;
  const netReturn = closing / run.openingEquity - 1;

  let underBars = 0;
  let longest = 0;
  let current = 0;
  for (const b of bars) {
    if (b.drawdownPercent > 1e-12) {
      underBars += 1;
      current += 1;
      longest = Math.max(longest, current);
    } else current = 0;
  }
  const meanEquity = bars.reduce((s, b) => s + b.equity, 0) / (bars.length || 1);
  const traded = bars.reduce((s, b) => s + b.tradedNotional, 0);
  const suppressedLegs: Record<string, number> = {};
  for (const b of bars) for (const [r, n] of Object.entries(b.suppressed)) suppressedLegs[r] = (suppressedLegs[r] ?? 0) + n;

  return {
    policy: run.policy,
    window: run.window.name,
    bars: bars.length,
    openingEquity: run.openingEquity,
    closingEquity: closing,
    netReturnPercent: netReturn * 100,
    annualisedReturnPercent: (Math.pow(1 + netReturn, 1 / years) - 1) * 100,
    maxDrawdownPercent: bars.reduce((m, b) => Math.max(m, b.drawdownPercent), 0),
    timeUnderHighPercent: (underBars / (bars.length || 1)) * 100,
    longestUnderHighDays: (longest * barMs) / MS_PER_DAY,
    feesPaid: bars.reduce((s, b) => s + b.fees, 0),
    slippageCost: bars.reduce((s, b) => s + b.slippageCost, 0),
    tradedNotional: traded,
    turnover: traded / meanEquity,
    exposure: exposureDistribution(bars.map((b) => b.exposurePercent)),
    stopExits: bars.reduce((s, b) => s + b.stopExitsDecided.length, 0),
    barsWithCapacityShortfall: bars.filter((b) => b.capacityShortfallPercent > 1e-9).length,
    barsWithOverExposure: bars.filter((b) => b.overExposurePercent > 1e-9).length,
    suppressedLegs,
    pendingNotExecuted: run.pendingNotExecuted,
    turnoverByCause: (() => {
      const by: Record<string, number> = {};
      for (const b of bars) if (b.tradedNotional > 0) by[b.executedCause ?? 'none'] = (by[b.executedCause ?? 'none'] ?? 0) + b.tradedNotional / meanEquity;
      return by;
    })(),
    frictionPercentOfOpening:
      ((bars.reduce((s, b) => s + b.fees, 0) + bars.reduce((s, b) => s + b.slippageCost, 0)) / run.openingEquity) * 100,
  };
}
