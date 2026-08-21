import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
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
import type { BarRecord } from './engine.js';
import {
  buildManifest,
  currentGitCommit,
  currentSourceTreeSha,
  writeArtefact,
  type WrittenFile,
} from './outputs.js';
import { freezeWitness, judgeAsymmetry, judgeRsi } from './select.js';
import { decisionsDigest, type SelectionFile, type ValidableConfiguration } from './validate.js';
import type { FreezeMode } from './engine.js';

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
  /**
   * The per-bar trajectories, kept so the RAW artefact can be written without replaying
   * anything. A negative outcome is still an experiment to audit — arguably more so, since
   * the only way to disagree with "no band is deliverable" is to look at what produced it.
   *
   * CALIBRATION ONLY. Nothing here ever touches the out-of-sample window.
   */
  bars: BarRecord[];
  witnessBars: BarRecord[];
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
  const { metrics, result } = runPolicy(shared, { kind: 'band', bands }, window);

  // The witness is matched to THIS arm's realised mean exposure — never to its nominal band,
  // which the gate, the stops and the movement floor all conspire to miss.
  const witness = searchConstantWitness(shared, window, metrics.meanExposurePercent);
  const { metrics: witnessMetrics, result: witnessResult } = runPolicy(
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
    bars: result.bars,
    witnessBars: witnessResult.bars,
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
  baselineBars: BarRecord[];
  selected: ArmReport | null;
  equalWeight: { openingEquity: number; closingEquity: number; netReturnPercent: number };
}

/**
 * THE REGRESSION GUARD — steps 1 and 2 must reproduce a previous run EXACTLY.
 *
 * The RSI brake and the freeze variant were added to the engine AFTER the first A/B/C run.
 * Neither is supposed to touch a bare band replay: the brake only applies when a policy asks
 * for it, and the freeze defaults to production's symmetric gate. "Supposed to" is not a
 * proof, and a leak would be invisible — it would simply move the numbers a little, and the
 * band selection would then rest on a different experiment than the one that was reported.
 *
 * So the arms are compared to a pinned reference, on EXACT equality. The replay is fully
 * deterministic on frozen data, so bit-identical is the correct bar; anything looser would
 * be tolerating exactly the drift this exists to catch.
 *
 * A divergence ABORTS before step 3. Testing the RSI on top of an engine that no longer
 * reproduces its own baseline would be building on sand.
 */
export interface ArmReference {
  baseline: { net: number; cagr: number; maxdd: number; expo: number };
  equalWeightNet: number;
  arms: Record<string, {
    net: number; cagr: number; maxdd: number; expo: number;
    witnessTarget: number; witnessRealised: number; excess: number; eligible: boolean;
  }>;
  selected: string | null;
}

export function checkAgainstReference(
  outcome: CalibrationOutcome,
  reference: ArmReference,
): string[] {
  const diffs: string[] = [];
  const cmp = (label: string, got: unknown, want: unknown): void => {
    if (got !== want) diffs.push(`${label}: got ${String(got)}, reference ${String(want)}`);
  };

  cmp('baseline.net', outcome.baseline.netReturnPercent, reference.baseline.net);
  cmp('baseline.cagr', outcome.baseline.cagrPercent, reference.baseline.cagr);
  cmp('baseline.maxdd', outcome.baseline.maxDrawdownPercent, reference.baseline.maxdd);
  cmp('baseline.expo', outcome.baseline.meanExposurePercent, reference.baseline.expo);
  cmp('equalWeight.net', outcome.equalWeight.netReturnPercent, reference.equalWeightNet);

  for (const report of outcome.reports) {
    const want = reference.arms[report.name];
    if (!want) {
      diffs.push(`arm ${report.name}: absent from the reference`);
      continue;
    }
    cmp(`${report.name}.net`, report.metrics.netReturnPercent, want.net);
    cmp(`${report.name}.cagr`, report.metrics.cagrPercent, want.cagr);
    cmp(`${report.name}.maxdd`, report.metrics.maxDrawdownPercent, want.maxdd);
    cmp(`${report.name}.expo`, report.metrics.meanExposurePercent, want.expo);
    cmp(`${report.name}.witnessTarget`, report.witness.targetPercent, want.witnessTarget);
    cmp(`${report.name}.witnessRealised`, report.witness.realisedMeanExposurePercent, want.witnessRealised);
    cmp(`${report.name}.excess`, report.excessCagrPercent, want.excess);
    cmp(`${report.name}.eligible`, report.eligibility.eligible, want.eligible);
  }
  cmp('selectedArm', outcome.selected?.name ?? null, reference.selected);
  return diffs;
}

/** Steps 1 and 2 of the protocol: the three arms, then the selection. */
export function runArmSelection(shared: SharedTape, window: WindowBounds): CalibrationOutcome {
  validateArms();
  const { metrics: baseline, result: baselineResult } = runPolicy(
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
    baselineBars: baselineResult.bars,
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

  // === THE REGRESSION GUARD, before anything downstream is built on these numbers =====
  const referencePath = process.argv[2];
  if (referencePath) {
    const reference = JSON.parse(readFileSync(path.resolve(referencePath), 'utf8')) as ArmReference;
    const diffs = checkAgainstReference(outcome, reference);
    if (diffs.length > 0) {
      console.error(`\n${'='.repeat(96)}`);
      console.error('REGRESSION — steps 1 and 2 no longer reproduce the reference run.');
      console.error('ABORTING before step 3. The RSI and the asymmetry are not tested on an engine');
      console.error('that cannot reproduce its own baseline.');
      for (const d of diffs) console.error(`  - ${d}`);
      console.error(`${'='.repeat(96)}`);
      return 2;
    }
    console.log(
      `\nregression guard: steps 1-2 reproduce the reference EXACTLY ` +
        `(${outcome.reports.length} arms + baseline + equal-weight reference).`,
    );
  } else {
    console.log('\nregression guard: no reference given - nothing to reproduce against.');
  }

  // === STEPS 3 -> 7, and ONLY if an arm actually qualified ==========================
  //
  // A negative outcome stops here on purpose. Testing the RSI on an arm that failed its own
  // eligibility would be looking for a variant that rescues it, which is precisely the loop
  // the fixed order exists to prevent.
  let rsiVerdict: ReturnType<typeof judgeRsi> | null = null;
  let asymVerdict: ReturnType<typeof judgeAsymmetry> | null = null;
  let selectionFile: SelectionFile | null = null;
  const frozen: Array<{ configuration: ValidableConfiguration; metrics: Metrics; witnessMetrics: Metrics }> = [];
  let stepsMs = 0;

  if (outcome.selected) {
    const selected = outcome.selected;
    const t1 = Date.now();

    // -- STEP 3 - the RSI candidate, on THIS arm only, at identical band --------------
    const withRsi = runPolicy(shared, { kind: 'band', bands: selected.bands, rsiBrake: true }, CALIBRATION_WINDOW);
    rsiVerdict = judgeRsi(selected.metrics, withRsi.metrics);
    const brakedBars = withRsi.result.bars.filter((b) => b.rsiBraked).length;
    console.log(`\n-- STEP 3 - RSI candidate on arm ${selected.name} ` + '-'.repeat(52));
    console.log(`  without RSI : CAGR ${selected.metrics.cagrPercent.toFixed(2)}%  maxDD ${selected.metrics.maxDrawdownPercent.toFixed(2)}%  mean exposure ${selected.metrics.meanExposurePercent.toFixed(2)}%`);
    console.log(`  with RSI    : CAGR ${withRsi.metrics.cagrPercent.toFixed(2)}%  maxDD ${withRsi.metrics.maxDrawdownPercent.toFixed(2)}%  mean exposure ${withRsi.metrics.meanExposurePercent.toFixed(2)}%`);
    console.log(`  braked bars : ${brakedBars} / ${withRsi.result.bars.length}`);
    console.log(`  verdict     : ${rsiVerdict.retained ? 'RETAINED' : 'REJECTED'} - ${rsiVerdict.reason}`);

    // -- STEP 4 - frozen, in or out, and never revisited ------------------------------
    const rsi = rsiVerdict.retained;

    // -- STEP 5 - the asymmetry, on THAT configuration only ---------------------------
    const sym = runPolicy(shared, { kind: 'band', bands: selected.bands, rsiBrake: rsi, freeze: 'symmetric' }, CALIBRATION_WINDOW);
    const asym = runPolicy(shared, { kind: 'band', bands: selected.bands, rsiBrake: rsi, freeze: 'asymmetric' }, CALIBRATION_WINDOW);
    asymVerdict = judgeAsymmetry(sym.metrics, asym.metrics);
    console.log(`\n-- STEP 5 - freeze asymmetry (sell-only) ` + '-'.repeat(52));
    console.log(`  symmetric  : CAGR ${sym.metrics.cagrPercent.toFixed(2)}%  maxDD ${sym.metrics.maxDrawdownPercent.toFixed(2)}%`);
    console.log(`  asymmetric : CAGR ${asym.metrics.cagrPercent.toFixed(2)}%  maxDD ${asym.metrics.maxDrawdownPercent.toFixed(2)}%`);
    console.log(`  verdict    : ${asymVerdict.admissible ? 'ADMISSIBLE to validation' : 'NOT admissible'} - ${asymVerdict.reason}`);

    // -- STEPS 6 & 7 - pre-register the variants, each with its OWN frozen witness -----
    const modes: FreezeMode[] = asymVerdict.admissible ? ['symmetric', 'asymmetric'] : ['symmetric'];
    for (const mode of modes) {
      const name = `${selected.name}-${rsi ? 'rsi' : 'norsi'}-${mode}`;
      // A bare arm's witness was already searched in step 2 on exactly these mechanics; the
      // search is exhaustive and deterministic, so repeating it would burn nine minutes to
      // land on the same target. Any VARIANT gets its own search.
      const reusable = !rsi && mode === 'symmetric';
      if (reusable) {
        console.log(`\n  witness for ${name}: reusing the step-2 search (identical configuration)`);
        frozen.push({
          configuration: {
            name, bands: selected.bands, rsi, freeze: mode,
            witnessTargetPercent: selected.witness.targetPercent,
            witnessMismatchPoints: selected.witness.mismatchPoints,
          },
          metrics: selected.metrics,
          witnessMetrics: selected.witnessMetrics,
        });
      } else {
        console.log(`\n  witness for ${name}: exhaustive search (401 targets)...`);
        frozen.push(freezeWitness(shared, CALIBRATION_WINDOW, name, selected.bands, rsi, mode));
      }
      const last = frozen[frozen.length - 1]!;
      console.log(
        `    constant ${last.configuration.witnessTargetPercent.toFixed(2)}%  mismatch ${last.configuration.witnessMismatchPoints.toFixed(3)}pt  ` +
          `excess ${(last.metrics.cagrPercent - last.witnessMetrics.cagrPercent).toFixed(2)}pt`,
      );
    }
    stepsMs = Date.now() - t1;

    const base = {
      schema_version: 1 as const,
      bundle_sha256: bundle.manifest.bundle_sha256,
      crypto_buddy_commit: currentGitCommit(),
      source_tree_sha: currentSourceTreeSha(),
      selected_arm: selected.name,
      rsi_retained: rsi,
      asymmetry_admissible: asymVerdict.admissible,
      configurations: frozen.map((f) => f.configuration),
    };
    selectionFile = { ...base, decisions_sha256: decisionsDigest(base) };
  }

  const written: WrittenFile[] = [];
  if (selectionFile) {
    // THE FROZEN SELECTION. Committed BEFORE the sealed window may be opened; the validation
    // command refuses to run without it, and refuses it if any decision was edited after.
    written.push(writeArtefact(outDir, 'selection.json', selectionFile));
    console.log(`\nselection frozen -> ${outDir}/selection.json  (digest ${selectionFile.decisions_sha256.slice(0, 16)}...)`);
    console.log('COMMIT IT before opening the sealed window. The validation command will refuse otherwise.');
  }

  /*
   * THE RAW TRAJECTORY — always written, and never more useful than on a negative outcome.
   *
   * "No band is deliverable" is a claim like any other, and the only way to disagree with it
   * is to look at what produced it. So the artefact carries the three arms, the three
   * witnesses they were judged against, and the deterministic baseline — the exact runs
   * behind every number in the summary. Nothing is replayed to build it: these bars are the
   * ones the selection already computed.
   *
   * CALIBRATION ONLY. Every trajectory here comes from CALIBRATION_WINDOW. The sealed window
   * contributes nothing, on a passing run or a failing one.
   */
  written.push(
    writeArtefact(outDir, 'trajectory.json', {
      kind: 'raw-trajectory',
      window: {
        from: new Date(CALIBRATION_WINDOW.fromMs).toISOString(),
        to_exclusive: new Date(CALIBRATION_WINDOW.toMs).toISOString(),
      },
      note: 'calibration only — the sealed out-of-sample window contributes nothing to this file',
      deterministic_baseline: {
        target_percent: BASELINE_TARGET_PERCENT,
        bars: outcome.baselineBars,
      },
      arms: outcome.reports.map((r) => ({
        name: r.name,
        bands: r.bands,
        eligible: r.eligibility.eligible,
        bars: r.bars,
      })),
      witnesses: outcome.reports.map((r) => ({
        arm: r.name,
        constant_target_percent: r.witness.targetPercent,
        bars: r.witnessBars,
      })),
      // Present only when an arm qualified; empty on the pre-written negative outcome.
      validable_configurations: frozen.map((f) => ({
        name: f.configuration.name,
        rsi: f.configuration.rsi,
        freeze: f.configuration.freeze,
        bars: runPolicy(
          shared,
          { kind: 'band', bands: f.configuration.bands, rsiBrake: f.configuration.rsi, freeze: f.configuration.freeze },
          CALIBRATION_WINDOW,
        ).result.bars,
      })),
    }),
  );
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
      step3_rsi: rsiVerdict
        ? {
            retained: rsiVerdict.retained,
            branch_a: rsiVerdict.branchA,
            branch_b: rsiVerdict.branchB,
            cagr_delta_points: rsiVerdict.cagrDeltaPoints,
            drawdown_delta_points: rsiVerdict.drawdownDeltaPoints,
            reason: rsiVerdict.reason,
          }
        : null,
      step5_asymmetry: asymVerdict
        ? {
            admissible: asymVerdict.admissible,
            cagr_delta_points: asymVerdict.cagrDeltaPoints,
            drawdown_delta_points: asymVerdict.drawdownDeltaPoints,
            reason: asymVerdict.reason,
            note: 'the third condition (out-of-sample net return at least equal to the symmetric variant) is judged in the sealed window, never here',
          }
        : null,
      step7_frozen_witnesses: frozen.map((f) => ({
        name: f.configuration.name,
        rsi: f.configuration.rsi,
        freeze: f.configuration.freeze,
        witness_constant_target_percent: f.configuration.witnessTargetPercent,
        witness_mismatch_points: f.configuration.witnessMismatchPoints,
        metrics: summarizeMetrics(f.metrics),
        witness_metrics: summarizeMetrics(f.witnessMetrics),
        excess_cagr_vs_constant_witness_points: f.metrics.cagrPercent - f.witnessMetrics.cagrPercent,
      })),
      limit:
        'the three arms differ on all three states at once; a winning arm does not identify which band carried the result',
      // The nuance travels WITH the number, not only in the README. A reader pulling this
      // file into a notebook a year from now gets the caveat attached to the finding.
      stop_finding_scope:
        'on this window the production peak stop (full, floor-exempt exit) costs return AND worsens drawdown — but what is measured is that stop COMBINED WITH THE PROXY ALLOCATOR AND ITS RE-ENTRIES. The full bot re-enters through the model, which may refuse to buy back what the stop just sold. Nothing here establishes the same cost for the full bot; that needs the production observation mode.',
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
        extra: selectionFile ? { selection_decisions_sha256: selectionFile.decisions_sha256 } : {},
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
