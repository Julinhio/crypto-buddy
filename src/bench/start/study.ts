import { Decimal, ZERO } from '../../money.js';
import { runWindow, type RunResult } from '../exposure/engine.js';
import { executeAllocation } from '../exposure/execute.js';
import { T100 } from '../exposure/policy.js';
import type { StudyData } from './data.js';
import { cloneLines, seedOf, SeededTrailingRule, type SeedLines, type StartVariant } from './variants.js';

/**
 * ONE START, MEASURED — the bench's engine, its fees and its slippage, from 1 000 $ of cash at a
 * chosen instant, with S4 seeded as one of the five variants (`variants.ts`).
 *
 * Nothing is tuned here and nothing is selected: every number is a reading of what the frozen
 * rule did from a given start. The window gate of the protocol is lifted (`unsafeSyntheticWindow`)
 * exactly as `s4/reconstruct.ts` lifts it, because a start on an arbitrary date is by construction
 * outside the protocol's windows — which is also why none of this is a validation.
 */

const DAY_MS = 86_400_000;

export const ORIGIN_MS = Date.parse('2020-10-01T00:00:00Z');
/** 3, 6 and 12 months, in days — plus `end`, the end of the data. */
export const HORIZON_DAYS = Object.freeze([91, 182, 365] as const);
export type HorizonKey = '91' | '182' | '365' | 'end';
export const HORIZON_KEYS: readonly HorizonKey[] = Object.freeze(['91', '182', '365', 'end']);

/** The first daily close a start at 4h bar `startMs` reads (the engine's own formula). */
export function firstCloseOf(startMs: number, barMs: number): number {
  return Math.floor((startMs + barMs) / DAY_MS) * DAY_MS;
}

/** The continuous trajectory since `originMs`: the run, and S4's lines after each daily close. */
export interface ContinuousTrajectory {
  originMs: number;
  run: RunResult;
  linesAfter: Map<number, SeedLines>;
}

export function runContinuous(data: StudyData, originMs = ORIGIN_MS, toMs = data.asOfMs): ContinuousTrajectory {
  const linesAfter = new Map<number, SeedLines>();
  const first = firstCloseOf(originMs, data.tape.barMs);
  const rule = new SeededTrailingRule(data.table, seedOf('A', data.cfg.assets, first, null), (closeMs, lines) => linesAfter.set(closeMs, cloneLines(lines)));
  const run = runWindow({ tape: data.tape, cfg: data.cfg, policy: T100, window: { name: 'exit-continuous', fromMs: originMs, toMs }, exitRule: rule, unsafeSyntheticWindow: true });
  return { originMs, run, linesAfter };
}

/**
 * The continuous lines a B or B' start at `startMs` is seeded with: those the trajectory held
 * just before the first close the start reads. At the trajectory's own origin there is no such
 * state yet — B is then A, by construction.
 */
export function continuousSeedAt(continuous: ContinuousTrajectory, startMs: number, barMs: number): SeedLines | null {
  return continuous.linesAfter.get(firstCloseOf(startMs, barMs) - DAY_MS) ?? null;
}

export function runStart(data: StudyData, variant: StartVariant, startMs: number, toMs: number, continuous: ContinuousTrajectory): { run: RunResult; rule: SeededTrailingRule } {
  const firstClose = firstCloseOf(startMs, data.tape.barMs);
  const inherited = variant === 'B' || variant === 'Bp' ? continuousSeedAt(continuous, startMs, data.tape.barMs) : null;
  // No continuous state before the origin's first close: B and B' start as the bench does.
  const seed = (variant === 'B' || variant === 'Bp') && inherited == null ? seedOf('A', data.cfg.assets, firstClose, null) : seedOf(variant, data.cfg.assets, firstClose, inherited);
  const rule = new SeededTrailingRule(data.table, seed);
  const run = runWindow({ tape: data.tape, cfg: data.cfg, policy: T100, window: { name: 'exit-continuous', fromMs: startMs, toMs }, exitRule: rule, unsafeSyntheticWindow: true });
  return { run, rule };
}

/** One series of 4h closes from a start: what every measure below is read from. */
export interface Series {
  t: number[];
  equity: number[];
  exposurePercent: number[];
}

export const seriesOf = (run: RunResult): Series => ({
  t: run.bars.map((b) => b.t),
  equity: run.bars.map((b) => b.equity),
  exposurePercent: run.bars.map((b) => b.exposurePercent),
});

/**
 * THE BASKET KEPT WITHOUT DOING ANYTHING — for information only. Bought once at the weights
 * 32,5 / 32,5 / 20 / 15 at the open that follows the start bar (the bar every variant first fills
 * on), with the bench's fee and slippage, then never touched: no rebalancing, no gate, no exit.
 */
export function holdSeries(data: StudyData, startMs: number, toMs: number): Series {
  const { tape, cfg } = data;
  const points = tape.points.filter((p) => p.timestamp >= startMs && p.timestamp < toMs);
  const price = (asset: string, t: number, field: 'open' | 'close'): Decimal => {
    const a = tape.tapes[asset]!;
    return new Decimal(a.h4[a.indexByTs.get(t)!]![field]);
  };
  let cash = new Decimal(cfg.startingCashUsd);
  const book: Record<string, { qty: Decimal }> = {};
  const out: Series = { t: [], equity: [], exposurePercent: [] };
  points.forEach((p, k) => {
    if (k === 1) {
      const prices = Object.fromEntries(cfg.assets.map((a) => [a, price(a, p.timestamp, 'open')]));
      cash = executeAllocation({
        cash, book, prices, targets: cfg.basket, reserveAsset: cfg.reserveAsset,
        feePercent: cfg.feePercentPerLeg, slippagePercent: cfg.slippagePercentPerLeg, minMovementPercent: cfg.minMovementPercent,
      }).cash;
    }
    let deployed = ZERO;
    for (const a of cfg.assets) deployed = deployed.plus((book[a]?.qty ?? ZERO).times(price(a, p.timestamp, 'close')));
    const equity = cash.plus(deployed);
    out.t.push(p.timestamp);
    out.equity.push(equity.toNumber());
    out.exposurePercent.push(equity.gt(0) ? deployed.div(equity).times(100).toNumber() : 0);
  });
  return out;
}

export interface Reading {
  /** Net return over the horizon, fees and slippage included, in percent of the 1 000 $. */
  returnPercent: number;
  /** Worst fall from the highest equity reached since the start (the start itself included). */
  maxDrawdownPercent: number;
  /** Mean share of the equity held in assets over the horizon. */
  timeInMarketPercent: number;
  /** Days actually covered — `end` only differs from one start to the next. */
  days: number;
}

/**
 * Reads one horizon off a series. A fixed horizon exists only if the data reach it: a start too
 * late for 12 months has no 12-month reading, rather than a shorter one under the same name.
 */
export function readHorizon(series: Series, startMs: number, key: HorizonKey, asOfMs: number, startingCash: number): Reading | null {
  const untilMs = key === 'end' ? asOfMs : startMs + Number(key) * DAY_MS;
  if (untilMs > asOfMs) return null;
  let high = startingCash;
  let worst = 0;
  let exposure = 0;
  let n = 0;
  let last = startingCash;
  for (let i = 0; i < series.t.length && series.t[i]! < untilMs; i += 1) {
    const e = series.equity[i]!;
    if (e > high) high = e;
    const dd = high > 0 ? ((high - e) / high) * 100 : 0;
    if (dd > worst) worst = dd;
    exposure += series.exposurePercent[i]!;
    last = e;
    n += 1;
  }
  if (n === 0) return null;
  return {
    returnPercent: (last / startingCash - 1) * 100,
    maxDrawdownPercent: worst,
    timeInMarketPercent: exposure / n,
    days: (untilMs - startMs) / DAY_MS,
  };
}

export type Readings = Partial<Record<HorizonKey, Reading>>;

export function readAll(series: Series, startMs: number, asOfMs: number, startingCash: number, keys: readonly HorizonKey[] = HORIZON_KEYS): Readings {
  const out: Readings = {};
  for (const key of keys) {
    const r = readHorizon(series, startMs, key, asOfMs, startingCash);
    if (r) out[key] = r;
  }
  return out;
}

/** The market the start walks into: how many of the four assets close above their 50-day mean. */
export function aboveMeanAt(data: StudyData, startMs: number): number {
  const row = data.table.rows[data.table.rowByClose.get(firstCloseOf(startMs, data.tape.barMs)) ?? -1];
  if (!row) throw new Error(`start study: no daily close for a start at ${new Date(startMs).toISOString()}`);
  return data.cfg.assets.filter((a) => row.sma50[a] != null && row.close[a]! > row.sma50[a]!).length;
}

// ── aggregation ──────────────────────────────────────────────────────────────────────────

export interface Distribution {
  n: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  min: number;
  minAt: string | null;
  max: number;
  maxAt: string | null;
}

/** Linear-interpolated quantile of a sorted sample. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function distribution(values: ReadonlyArray<{ value: number; at: string }>): Distribution | null {
  if (values.length === 0) return null;
  const sorted = values.map((v) => v.value).sort((a, b) => a - b);
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v.value < min.value) min = v;
    if (v.value > max.value) max = v;
  }
  return {
    n: values.length,
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    median: quantile(sorted, 0.5),
    p10: quantile(sorted, 0.1),
    p90: quantile(sorted, 0.9),
    min: min.value,
    minAt: min.at,
    max: max.value,
    maxAt: max.at,
  };
}
