import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { BandPolicy } from './controller.js';
import {
  ARMS,
  BASELINE_TARGET_PERCENT,
  equalWeightBuyAndHold,
  runPolicy,
  searchConstantWitness,
  validateArms,
  type SharedTape,
  type WindowBounds,
  type WitnessSelection,
} from './arms.js';
import { CALIBRATION_WINDOW, prepareTape } from './tape.js';
import { excessVsWitness, type Metrics } from './metrics.js';
import { buildManifest, writeArtefact, type WrittenFile } from './outputs.js';

/**
 * THE CALIBRATION RUN — the selection, on the calibration window ONLY.
 *
 * The order is fixed by the protocol and is not a matter of taste. Each step narrows what
 * the next one is allowed to look at, which is the only thing standing between this and a
 * search over every combination until one looks good:
 *
 *   1. test A, B, C — symmetric gate, no RSI;
 *   2. select the eligible arm;
 *   3. test the RSI on THAT arm only;
 *   4. freeze RSI in or out, definitively;
 *   5. test the freeze asymmetry on THAT configuration only;
 *   6. if it passes, pre-register BOTH variants for the single out-of-sample opening;
 *   7. compute and freeze the constant witness of EVERY validable configuration.
 *
 * The criteria below were written before any result was looked at. Nothing here is tuned
 * after the fact — and if no arm qualifies, the harness says so and delivers no band. That
 * negative outcome is pre-written and acceptable.
 */

/** Eligibility, all three cumulative, on the calibration window. */
export const MAX_DRAWDOWN_LIMIT_PERCENT = 35;
export const MIN_EXCESS_CAGR_POINTS = 1;
/** Two arms within this much net return are separated by realised exposure, not by return. */
export const TIE_BREAK_RETURN_POINTS = 1;

export interface ArmReport {
  name: string;
  bands: BandPolicy;
  metrics: Metrics;
  witness: WitnessSelection;
  witnessMetrics: Metrics;
  excessCagrPercent: number;
  /** True when the witness landed inside the pre-registered exposure tolerance. */
  witnessIsSound: boolean;
  eligibility: {
    drawdownOk: boolean;
    beatsBaseline: boolean;
    excessOk: boolean;
    eligible: boolean;
    reasons: string[];
  };
}

/** Runs one arm plus its own searched, frozen witness. */
export function evaluateArm(
  shared: SharedTape,
  window: WindowBounds,
  name: string,
  bands: BandPolicy,
  baseline: Metrics,
): ArmReport {
  const { metrics } = runPolicy(shared, { kind: 'band', bands }, window);

  // The witness is matched to THIS arm's realised mean exposure — never to its nominal band,
  // which the gate, the stops and the movement floor all conspire to miss.
  const witness = searchConstantWitness(shared, window, metrics.meanExposurePercent);
  const { metrics: witnessMetrics } = runPolicy(
    shared,
    { kind: 'constant', targetPercent: witness.targetPercent },
    window,
  );
  const excess = excessVsWitness(metrics, witnessMetrics);

  const drawdownOk = metrics.maxDrawdownPercent <= MAX_DRAWDOWN_LIMIT_PERCENT;
  const beatsBaseline = metrics.netReturnPercent > baseline.netReturnPercent;
  const excessOk = excess.excessCagrPercent >= MIN_EXCESS_CAGR_POINTS;

  const reasons: string[] = [];
  if (!drawdownOk) {
    reasons.push(
      `max drawdown ${metrics.maxDrawdownPercent.toFixed(2)}% exceeds ${MAX_DRAWDOWN_LIMIT_PERCENT}%`,
    );
  }
  if (!beatsBaseline) {
    reasons.push(
      `net return ${metrics.netReturnPercent.toFixed(2)}% does not beat the deterministic ` +
        `20% baseline (${baseline.netReturnPercent.toFixed(2)}%)`,
    );
  }
  if (!excessOk) {
    reasons.push(
      `excess CAGR vs constant witness ${excess.excessCagrPercent.toFixed(2)}pt is below ` +
        `${MIN_EXCESS_CAGR_POINTS}pt`,
    );
  }
  // An unsound witness cannot SUPPORT an excess claim, so it cannot support eligibility
  // either — the excess condition is one of the three, and it would rest on nothing.
  if (!excess.witnessIsSound) {
    reasons.push(
      `witness is imperfect: realised exposure mismatch ${excess.exposureMismatchPoints.toFixed(3)}pt ` +
        'exceeds the pre-registered 0.25pt tolerance — no excess-of-CAGR claim may rest on it',
    );
  }

  return {
    name,
    bands,
    metrics,
    witness,
    witnessMetrics,
    excessCagrPercent: excess.excessCagrPercent,
    witnessIsSound: excess.witnessIsSound,
    eligibility: {
      drawdownOk,
      beatsBaseline,
      excessOk,
      eligible: drawdownOk && beatsBaseline && excessOk && excess.witnessIsSound,
      reasons,
    },
  };
}

/**
 * Picks among the eligible arms: best net return, and when two sit within a point of each
 * other, the one carrying the LOWER realised exposure.
 *
 * The tie-break is not cosmetic. Two arms that returned the same thing did not take the same
 * risk to get it, and the objective here is return UNDER A RISK CONSTRAINT — so the cheaper
 * one in exposure terms is the better answer, not a coin toss.
 */
export function selectArm(reports: readonly ArmReport[]): ArmReport | null {
  const eligible = reports.filter((r) => r.eligibility.eligible);
  if (eligible.length === 0) return null;
  const best = [...eligible].sort((a, b) => b.metrics.netReturnPercent - a.metrics.netReturnPercent)[0]!;
  const contenders = eligible.filter(
    (r) => Math.abs(r.metrics.netReturnPercent - best.metrics.netReturnPercent) < TIE_BREAK_RETURN_POINTS,
  );
  if (contenders.length <= 1) return best;
  return [...contenders].sort(
    (a, b) => a.metrics.meanExposurePercent - b.metrics.meanExposurePercent,
  )[0]!;
}

function summarizeMetrics(m: Metrics): Record<string, unknown> {
  return {
    bars: m.bars,
    opening_equity: m.openingEquity,
    closing_equity: m.closingEquity,
    net_return_percent: m.netReturnPercent,
    cagr_percent: m.cagrPercent,
    max_drawdown_percent: m.maxDrawdownPercent,
    time_under_water_days: m.timeUnderWaterDays,
    longest_under_water_days: m.longestUnderWaterDays,
    mean_exposure_percent_realised: m.meanExposurePercent,
    median_exposure_percent_realised: m.medianExposurePercent,
    turnover_ratio: m.turnoverRatio,
    traded_notional: m.tradedNotional,
    fees_paid: m.feesPaid,
    dropped_by_floor_bars: m.droppedByFloorBars,
    dropped_at_band_edge_bars: m.droppedAtBandEdgeBars,
    gap_total: m.gapTotal,
    gap_by_asset: m.gapByAsset,
    // `frozen` here IS the cost of the freeze, in percentage-points·bars, both signs kept.
    gap_by_cause: m.gapByCause,
    pending_not_executed: m.pendingNotExecuted,
    state_bars: m.stateBars,
  };
}

export interface CalibrationOutcome {
  reports: ArmReport[];
  baseline: Metrics;
  selected: ArmReport | null;
  equalWeight: { openingEquity: number; closingEquity: number; netReturnPercent: number };
}

/** Steps 1 and 2 of the protocol: the three arms, then the selection. */
export function runArmSelection(shared: SharedTape, window: WindowBounds): CalibrationOutcome {
  validateArms();
  const { metrics: baseline } = runPolicy(
    shared,
    { kind: 'constant', targetPercent: BASELINE_TARGET_PERCENT },
    window,
  );
  const reports = Object.entries(ARMS).map(([name, bands]) =>
    evaluateArm(shared, window, name, bands, baseline),
  );
  return {
    reports,
    baseline,
    selected: selectArm(reports),
    equalWeight: equalWeightBuyAndHold(shared, window),
  };
}

async function main(): Promise<number> {
  const outDir = path.resolve(process.cwd(), 'out', 'exposure-calibration');
  console.log('='.repeat(96));
  console.log('EXPOSURE CALIBRATION — arm selection on the calibration window');
  console.log('The model is NOT in this experiment. See src/calibration/exposure/README.md.');
  console.log('='.repeat(96));

  const prepared = prepareTape();
  const { shared, bundle, prepMs } = prepared;
  console.log(`\nbundle certified + regimes + sticky : ${prepMs} ms (shared by every replay)`);
  console.log(`basket (derived from caps): ${shared.cfg.assets
    .map((a) => `${a} ${shared.cfg.basket[a]!.toFixed(3)}%`)
    .join('  ')}`);

  const t0 = Date.now();
  const outcome = runArmSelection(shared, CALIBRATION_WINDOW);
  const selectionMs = Date.now() - t0;

  console.log(`\ndeterministic 20% baseline : net ${outcome.baseline.netReturnPercent.toFixed(2)}%  ` +
    `CAGR ${outcome.baseline.cagrPercent.toFixed(2)}%  maxDD ${outcome.baseline.maxDrawdownPercent.toFixed(2)}%  ` +
    `mean exposure ${outcome.baseline.meanExposurePercent.toFixed(2)}%`);
  console.log(`  (constant-exposure control — NOT a re-enactment of the live policy)`);
  console.log(`\nequal-weight repère (25% each, never rebalanced): net ${outcome.equalWeight.netReturnPercent.toFixed(2)}%`);
  console.log(`  NOTE: it does NOT respect the bot's per-asset caps — external reference only.`);

  for (const r of outcome.reports) {
    console.log(`\n── ARM ${r.name} ${'─'.repeat(80)}`);
    console.log(`  net ${r.metrics.netReturnPercent.toFixed(2)}%  CAGR ${r.metrics.cagrPercent.toFixed(2)}%  ` +
      `maxDD ${r.metrics.maxDrawdownPercent.toFixed(2)}%  mean exposure ${r.metrics.meanExposurePercent.toFixed(2)}%`);
    console.log(`  witness: constant ${r.witness.targetPercent.toFixed(2)}% → realised ` +
      `${r.witness.realisedMeanExposurePercent.toFixed(3)}%  mismatch ${r.witness.mismatchPoints.toFixed(3)}pt  ` +
      `${r.witnessIsSound ? 'SOUND' : 'IMPERFECT'} (${r.witness.targetsEvaluated} targets evaluated)`);
    console.log(`  excess of CAGR vs constant witness: ${r.excessCagrPercent >= 0 ? '+' : ''}${r.excessCagrPercent.toFixed(2)}pt`);
    console.log(`  eligible: ${r.eligibility.eligible ? 'YES' : 'NO'}${r.eligibility.reasons.length ? ` — ${r.eligibility.reasons.join(' | ')}` : ''}`);
  }

  console.log(`\n${'='.repeat(96)}`);
  if (outcome.selected) {
    console.log(`SELECTED ARM: ${outcome.selected.name}`);
  } else {
    console.log('NO ARM IS ELIGIBLE — no band is delivered. This negative outcome was written in advance.');
  }
  console.log('LIMIT: the three arms differ on all three states at once. A winning arm does not');
  console.log('tell us which of its bands carried the result. Assumed, and stated beside the number.');
  console.log('='.repeat(96));

  const written: WrittenFile[] = [];
  written.push(
    writeArtefact(outDir, 'summary.json', {
      kind: 'arm-selection',
      metric_name: 'excess of CAGR vs constant witness',
      metric_note:
        'the witness runs the SAME gate, stops and movement floor, so the difference isolates the band controller alone. Not an alpha, not the full bot edge.',
      deterministic_baseline: summarizeMetrics(outcome.baseline),
      equal_weight_reference: {
        ...outcome.equalWeight,
        note: 'does NOT respect the per-asset caps — external reference only',
      },
      arms: outcome.reports.map((r) => ({
        name: r.name,
        bands: r.bands,
        metrics: summarizeMetrics(r.metrics),
        witness: {
          constant_target_percent: r.witness.targetPercent,
          realised_mean_exposure_percent: r.witness.realisedMeanExposurePercent,
          mismatch_points: r.witness.mismatchPoints,
          is_sound: r.witness.isSound,
          targets_evaluated: r.witness.targetsEvaluated,
          metrics: summarizeMetrics(r.witnessMetrics),
        },
        excess_cagr_vs_constant_witness_points: r.excessCagrPercent,
        eligibility: r.eligibility,
      })),
      selected_arm: outcome.selected?.name ?? null,
      limit:
        'the three arms differ on all three states at once; a winning arm does not identify which band carried the result',
    }),
  );

  written.push(
    writeArtefact(
      outDir,
      'manifest.json',
      buildManifest({
        kind: 'calibration',
        bundle: bundle.manifest,
        cfg: shared.cfg,
        windows: { calibration: CALIBRATION_WINDOW },
        outputs: written,
        timings: { prep_ms: prepMs, arm_selection_ms: selectionMs },
      }),
    ),
  );

  console.log(`\nartefacts → ${outDir}`);
  console.log(`arm selection (3 arms × 401 witness targets + baseline) : ${(selectionMs / 1000).toFixed(1)} s`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
