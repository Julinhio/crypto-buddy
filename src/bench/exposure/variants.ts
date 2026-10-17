import type { BenchConfig } from './config.js';
import type { ComponentName, ComponentVector } from './components.js';
import { runWindow, type RunResult } from './engine.js';
import { computeRunMetrics, type RunMetrics } from './metrics.js';
import { scorePolicy } from './policy.js';
import { compositeScore, fitNormalisation, linearTarget, stepTarget, topDecileMedianExposure, type Normalisation } from './score.js';
import type { Tape } from './tape.js';
import type { Window } from './windows.js';

/**
 * THE SIX SCORE VARIANTS, PRE-REGISTERED — report of step 1, section 5, validated on 17/10.
 *
 * Written here before any of them was run, and run only under the re-entry rule of the 17/10
 * amendment. Nothing in this file may change after the first run: not a set, not a transform,
 * not the threshold grid, not the selection rule.
 *
 *   sets        A = trend_sma200;  B = A + breadth_net;  C = B + taker_buy_7d.
 *               The score is the SIMPLE MEAN of the components' z-scores, each z-score with a
 *               mean and a standard deviation learned on the development window.
 *   transforms  linear: z = −1 → 0 %, z = +1 → 100 %, clamped;
 *               steps:  z < −0.5 → 0 %, −0.5 ≤ z < 0.5 → 50 %, z ≥ 0.5 → 100 %.
 *   risk_off    not forced to 0 %: it stays an input of the gate (rung 2), not of the score.
 *   threshold   on total exposure, one of {5, 10, 20} points, chosen PER VARIANT on the
 *               development window: the one with the highest annualised net return; a tie goes
 *               to the smallest threshold (it is then inert — the step transform only moves in
 *               jumps of 50 points, so every threshold of the grid lets each jump through).
 *   selection   among the six, each with its threshold, the highest annualised net return on
 *               development among those with a maximum drawdown ≤ 50 % AND a median realised
 *               exposure ≥ 80 % in their top conviction decile. A tie goes to the earlier
 *               variant in the list below. None eligible: nothing goes to the verification.
 *
 * THE CONVICTION DECILE (protocol point 8). The score read at the close of bar t is paired with
 * the exposure REALISED at the close of bar t+1 — the exposure that score's order produced —
 * never with the exposure of bar t, which the score had no chance to move.
 */

export const SCORE_SETS: Readonly<Record<'A' | 'B' | 'C', readonly ComponentName[]>> = Object.freeze({
  A: Object.freeze(['trend_sma200'] as ComponentName[]),
  B: Object.freeze(['trend_sma200', 'breadth_net'] as ComponentName[]),
  C: Object.freeze(['trend_sma200', 'breadth_net', 'taker_buy_7d'] as ComponentName[]),
});

export type TransformName = 'linear' | 'steps';

export const TRANSFORMS: Readonly<Record<TransformName, (score: number) => number>> = Object.freeze({
  linear: linearTarget(-1, 1),
  steps: stepTarget(
    [
      { atLeast: -0.5, targetPercent: 50 },
      { atLeast: 0.5, targetPercent: 100 },
    ],
    0,
  ),
});

export const THRESHOLD_GRID_POINTS = Object.freeze([5, 10, 20]);
export const MAX_DRAWDOWN_LIMIT_PERCENT = 50;
export const TOP_DECILE_MIN_MEDIAN_EXPOSURE_PERCENT = 80;

export interface VariantSpec {
  name: string;
  set: 'A' | 'B' | 'C';
  transform: TransformName;
}

/** The six, in their pre-registered order — the tie-break order. */
export const VARIANTS: readonly VariantSpec[] = Object.freeze(
  (['A', 'B', 'C'] as const).flatMap((set) =>
    (['linear', 'steps'] as const).map((transform) => ({ name: `SCORE-${set}-${transform}`, set, transform })),
  ),
);

export interface ThresholdTrial {
  thresholdPoints: number;
  annualisedReturnPercent: number;
  maxDrawdownPercent: number;
}

export interface VariantOutcome {
  spec: VariantSpec;
  normalisations: Normalisation[];
  trials: ThresholdTrial[];
  chosenThresholdPoints: number;
  metrics: RunMetrics;
  topDecile: { threshold: number; bars: number; medianExposurePercent: number } | null;
  /** Bars with no score (warm-up of a component): the last target is kept. */
  barsWithoutScore: number;
  eligible: boolean;
  ineligibleBecause: string[];
}

export interface SelectionOutcome {
  variants: VariantOutcome[];
  selected: string | null;
  rule: string;
}

/** The score at each bar of the tape for one set, from development-learned normalisations. */
export function scoreSeries(
  components: Map<number, ComponentVector>,
  set: readonly ComponentName[],
  window: Window,
): { normalisations: Normalisation[]; scoreAt: (t: number) => number | null } {
  const samples = [...components.entries()].map(([t, v]) => ({ t, v }));
  const normalisations = set.map((name) => fitNormalisation(name, samples, window));
  const terms = normalisations.map((normalisation) => ({ normalisation, weight: 1 / set.length }));
  return { normalisations, scoreAt: (t) => {
    const v = components.get(t);
    return v ? compositeScore(v, terms) : null;
  } };
}

/** The conviction-decile check: score at bar t against exposure realised at bar t+1. */
export function topDecileOfRun(run: RunResult, scoreAt: (t: number) => number | null): VariantOutcome['topDecile'] {
  const rows: Array<{ score: number | null; exposurePercent: number }> = [];
  for (let i = 0; i + 1 < run.bars.length; i += 1) {
    rows.push({ score: scoreAt(run.bars[i]!.t), exposurePercent: run.bars[i + 1]!.exposurePercent });
  }
  return topDecileMedianExposure(rows);
}

export function runScoreVariants(params: {
  tape: Tape;
  cfg: BenchConfig;
  components: Map<number, ComponentVector>;
  window: Window;
}): SelectionOutcome {
  const { tape, cfg, components, window } = params;
  const outcomes: VariantOutcome[] = [];

  for (const spec of VARIANTS) {
    const { normalisations, scoreAt } = scoreSeries(components, SCORE_SETS[spec.set], window);
    const runAt = (thresholdPoints: number): RunResult =>
      runWindow({
        tape,
        cfg,
        window,
        scoreAt,
        policy: scorePolicy({
          name: spec.name,
          toTarget: TRANSFORMS[spec.transform],
          rebalanceThresholdPoints: thresholdPoints,
          riskOffForcesZero: false,
        }),
      });

    const runs = THRESHOLD_GRID_POINTS.map((th) => ({ th, run: runAt(th) }));
    const trials: ThresholdTrial[] = runs.map(({ th, run }) => {
      const m = computeRunMetrics(run, tape.barMs);
      return { thresholdPoints: th, annualisedReturnPercent: m.annualisedReturnPercent, maxDrawdownPercent: m.maxDrawdownPercent };
    });
    // Highest annualised net return; a tie goes to the smallest threshold (grid order).
    let best = 0;
    for (let i = 1; i < trials.length; i += 1) {
      if (trials[i]!.annualisedReturnPercent > trials[best]!.annualisedReturnPercent) best = i;
    }
    const chosen = runs[best]!;
    const metrics = computeRunMetrics(chosen.run, tape.barMs);
    const topDecile = topDecileOfRun(chosen.run, scoreAt);
    const barsWithoutScore = chosen.run.bars.filter((b) => scoreAt(b.t) == null).length;

    const ineligibleBecause: string[] = [];
    if (!(metrics.maxDrawdownPercent <= MAX_DRAWDOWN_LIMIT_PERCENT)) {
      ineligibleBecause.push(`maximum drawdown ${metrics.maxDrawdownPercent.toFixed(2)} % > ${MAX_DRAWDOWN_LIMIT_PERCENT} %`);
    }
    if (topDecile == null || !(topDecile.medianExposurePercent >= TOP_DECILE_MIN_MEDIAN_EXPOSURE_PERCENT)) {
      ineligibleBecause.push(
        `median exposure in the top conviction decile ${topDecile ? topDecile.medianExposurePercent.toFixed(2) : 'n/a'} % < ${TOP_DECILE_MIN_MEDIAN_EXPOSURE_PERCENT} %`,
      );
    }
    outcomes.push({
      spec,
      normalisations,
      trials,
      chosenThresholdPoints: chosen.th,
      metrics,
      topDecile,
      barsWithoutScore,
      eligible: ineligibleBecause.length === 0,
      ineligibleBecause,
    });
  }

  let selected: VariantOutcome | null = null;
  for (const o of outcomes) {
    if (!o.eligible) continue;
    if (selected == null || o.metrics.annualisedReturnPercent > selected.metrics.annualisedReturnPercent) selected = o;
  }
  return {
    variants: outcomes,
    selected: selected?.spec.name ?? null,
    rule:
      'highest annualised net return on development among the variants with max drawdown <= 50 % and median ' +
      'realised exposure >= 80 % in their top conviction decile; tie -> earlier variant; none -> nothing goes to verification',
  };
}
