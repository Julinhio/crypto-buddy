import type { ComponentName, ComponentVector } from './components.js';
import { quantile } from './metrics.js';
import { DEVELOPMENT, type Window } from './windows.js';

/**
 * THE SCORE TOOLING — no variant here, only the machinery a pre-registered variant will use.
 *
 *   normalise   z-score each component with a mean and a standard deviation LEARNED ON THE
 *               DEVELOPMENT WINDOW and frozen (protocol v1.3, point 4). `fitNormalisation`
 *               refuses any other window, so a variant cannot be re-normalised on the
 *               verification by mistake;
 *   combine     a weighted sum of z-scores, the weights part of the variant ("poids simples");
 *   transform   score → EXACT target in [0, 100]: either a clamped line between two score
 *               levels, or a step table. No band, no midpoint: the target is the number;
 *   check       protocol point 8: the median realised exposure in the top conviction decile.
 */

export interface Normalisation {
  component: ComponentName;
  mean: number;
  sd: number;
  /** The window it was learned on — always the development window. */
  learnedOn: string;
  n: number;
}

export function fitNormalisation(
  component: ComponentName,
  samples: ReadonlyArray<{ t: number; v: ComponentVector }>,
  window: Window,
): Normalisation {
  if (window.name !== DEVELOPMENT.name || window.fromMs !== DEVELOPMENT.fromMs || window.toMs !== DEVELOPMENT.toMs) {
    throw new Error(`fitNormalisation: normalisations are learned on the development window only, not "${window.name}"`);
  }
  const xs = samples
    .filter((s) => s.t >= window.fromMs && s.t < window.toMs)
    .map((s) => s.v[component])
    .filter((x): x is number => x != null && Number.isFinite(x));
  if (xs.length < 30) throw new Error(`fitNormalisation: ${component} has ${xs.length} development observations`);
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length - 1));
  if (!(sd > 0)) throw new Error(`fitNormalisation: ${component} does not vary on the development window`);
  return { component, mean, sd, learnedOn: window.name, n: xs.length };
}

/** Σ weight · z, or null when any weighted component is missing at this bar. */
export function compositeScore(
  v: ComponentVector,
  terms: ReadonlyArray<{ normalisation: Normalisation; weight: number }>,
): number | null {
  let s = 0;
  for (const { normalisation, weight } of terms) {
    const x = v[normalisation.component];
    if (x == null || !Number.isFinite(x)) return null;
    s += weight * ((x - normalisation.mean) / normalisation.sd);
  }
  return s;
}

/** Clamped linear map: `low` → 0 %, `high` → 100 %. */
export function linearTarget(low: number, high: number): (score: number) => number {
  if (!(high > low)) throw new Error('linearTarget: high must exceed low');
  return (score) => Math.min(100, Math.max(0, ((score - low) / (high - low)) * 100));
}

/** Step table: the target of the highest threshold the score reaches; below all, `floor`. */
export function stepTarget(
  steps: ReadonlyArray<{ atLeast: number; targetPercent: number }>,
  floorPercent: number,
): (score: number) => number {
  const sorted = [...steps].sort((a, b) => a.atLeast - b.atLeast);
  for (const s of [...sorted.map((x) => x.targetPercent), floorPercent]) {
    if (!(s >= 0 && s <= 100)) throw new Error('stepTarget: targets must lie in [0, 100]');
  }
  return (score) => {
    let target = floorPercent;
    for (const s of sorted) if (score >= s.atLeast) target = s.targetPercent;
    return target;
  };
}

/**
 * Protocol point 8: the median realised exposure over the bars whose score is in the top
 * decile of the window's scores. The decile is the window's own (each evaluated window).
 */
export function topDecileMedianExposure(
  rows: ReadonlyArray<{ score: number | null; exposurePercent: number }>,
): { threshold: number; bars: number; medianExposurePercent: number } | null {
  const scored = rows.filter((r): r is { score: number; exposurePercent: number } => r.score != null && Number.isFinite(r.score));
  if (scored.length < 10) return null;
  const threshold = quantile(scored.map((r) => r.score), 0.9);
  const top = scored.filter((r) => r.score >= threshold);
  return { threshold, bars: top.length, medianExposurePercent: quantile(top.map((r) => r.exposurePercent), 0.5) };
}
