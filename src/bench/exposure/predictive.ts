import type { Tape } from './tape.js';
import type { ComponentName, ComponentVector } from './components.js';
import { COMPONENT_NAMES } from './components.js';
import { correlation, neweyWest, type RegressionResult } from './stats.js';
import { assertMeasurable, insideWithEmbargo, type Window } from './windows.js';

/**
 * THE PREREQUISITE — protocol v1.3, point 5. Exploratory, development window only.
 *
 *   sampling   one observation per UTC day: the components at the close of the day's last
 *              4h bar (the bar opened at 20:00, closing at midnight);
 *   target     the log return of the FIXED-WEIGHT basket from the OPEN of the next bar
 *              (00:00) to the open h days later — bought at the basket weights, held, never
 *              rebalanced over the horizon;
 *   horizons   fixed here, before any number was looked at: 1, 7 and 30 days;
 *   errors     Newey-West, lag h − 1 days, the overlap of consecutive horizons;
 *   embargo    an observation enters only if its exit open is strictly before the window's
 *              end — a 30-day return that ends in the verification window is not a
 *              development observation.
 */

export const HORIZONS_DAYS = Object.freeze([1, 7, 30]);
const DAY_MS = 86_400_000;

export interface ComponentStudy {
  component: ComponentName;
  horizonDays: number;
  /** Observations with both a component value and an embargoed forward return. */
  n: number;
  regression: RegressionResult | null;
  /** Slope × sd(x): the return, in log points over the horizon, of a one-sd move. */
  slopePerSd: number | null;
  /** The same regression on each calendar year of the window, for sign stability only. */
  byYear: Array<{ year: number; n: number; slope: number | null; tStat: number | null }>;
}

export interface PredictiveStudy {
  window: string;
  horizonsDays: readonly number[];
  observations: number;
  studies: ComponentStudy[];
  /** Pearson correlation between components, on the days both exist. */
  correlations: Record<string, Record<string, number | null>>;
}

/** Fixed-weight basket log return between two 4h bar OPENS, or null if a bar is missing. */
export function basketForwardReturn(
  tape: Tape,
  basket: Readonly<Record<string, number>>,
  entryOpenMs: number,
  exitOpenMs: number,
): number | null {
  let gross = 0;
  for (const a of tape.tradable) {
    const t = tape.tapes[a]!;
    const i = t.indexByTs.get(entryOpenMs);
    const j = t.indexByTs.get(exitOpenMs);
    if (i == null || j == null) return null;
    gross += ((basket[a] ?? 0) / 100) * (t.h4[j]!.open / t.h4[i]!.open);
  }
  return Math.log(gross);
}

export function runPredictiveStudy(params: {
  tape: Tape;
  basket: Readonly<Record<string, number>>;
  components: Map<number, ComponentVector>;
  window: Window;
}): PredictiveStudy {
  const { tape, basket, components, window } = params;
  assertMeasurable(window);

  // Daily decision points: the last 4h bar of each UTC day, inside the window.
  const days = tape.points
    .map((p) => p.timestamp)
    .filter((t) => (t + tape.barMs) % DAY_MS === 0 && t >= window.fromMs && t < window.toMs);

  const studies: ComponentStudy[] = [];
  for (const h of HORIZONS_DAYS) {
    // (component value, forward return, year) for every embargoed day.
    const rows: Array<{ t: number; y: number; v: ComponentVector }> = [];
    for (const t of days) {
      const entry = t + tape.barMs;
      const exit = entry + h * DAY_MS;
      if (!insideWithEmbargo(window, t, exit)) continue;
      const y = basketForwardReturn(tape, basket, entry, exit);
      const v = components.get(t);
      if (y == null || v == null) continue;
      rows.push({ t, y, v });
    }
    for (const name of COMPONENT_NAMES) {
      const usable = rows.filter((r) => r.v[name] != null && Number.isFinite(r.v[name]!));
      const x = usable.map((r) => r.v[name]!);
      const y = usable.map((r) => r.y);
      const sd = x.length > 1 ? Math.sqrt(x.reduce((s, v) => s + (v - x.reduce((a, b) => a + b, 0) / x.length) ** 2, 0) / (x.length - 1)) : 0;
      const regression = x.length >= 30 && sd > 0 ? neweyWest(x, y, h - 1) : null;
      const byYear: ComponentStudy['byYear'] = [];
      for (const year of [...new Set(usable.map((r) => new Date(r.t).getUTCFullYear()))].sort()) {
        const sub = usable.filter((r) => new Date(r.t).getUTCFullYear() === year);
        const xs = sub.map((r) => r.v[name]!);
        const variance = xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : 0;
        const r = sub.length >= 30 && variance > 0 ? neweyWest(xs, sub.map((s) => s.y), h - 1) : null;
        byYear.push({ year, n: sub.length, slope: r?.slope ?? null, tStat: r?.tStat ?? null });
      }
      studies.push({
        component: name,
        horizonDays: h,
        n: usable.length,
        regression,
        slopePerSd: regression ? regression.slope * sd : null,
        byYear,
      });
    }
  }

  // Correlations between components, on the window's daily points.
  const vectors = days.map((t) => components.get(t)).filter((v): v is ComponentVector => v != null);
  const correlations: PredictiveStudy['correlations'] = {};
  for (const a of COMPONENT_NAMES) {
    correlations[a] = {};
    for (const b of COMPONENT_NAMES) {
      const pairs = vectors.filter((v) => v[a] != null && v[b] != null);
      const xa = pairs.map((v) => v[a]!);
      const xb = pairs.map((v) => v[b]!);
      const varies = (xs: number[]): boolean => xs.length > 2 && Math.max(...xs) > Math.min(...xs);
      correlations[a]![b] = varies(xa) && varies(xb) ? correlation(xa, xb) : null;
    }
  }

  return { window: window.name, horizonsDays: HORIZONS_DAYS, observations: days.length, studies, correlations };
}
