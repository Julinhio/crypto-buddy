import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BandPolicy } from './controller.js';
import { runPolicy, type SharedTape, type WindowBounds } from './arms.js';
import { CALIBRATION_WINDOW, VALIDATION_WINDOW, prepareTape } from './tape.js';
import { excessVsWitness, type Metrics } from './metrics.js';
import { buildManifest, sha256Of, writeArtefact, type WrittenFile } from './outputs.js';
import type { EngineState } from './engine.js';

/**
 * THE SEALED WINDOW — a SEPARATE command, and it refuses to run without a frozen selection.
 *
 * This is the only mechanism standing between an honest out-of-sample test and an expensive
 * way of fitting twice. It cannot be a flag on the calibration command, because a flag can
 * be passed on a whim after a disappointing calibration; it has to be a second binary that
 * demands, as input, a decision that was written down and committed BEFORE the window was
 * opened.
 *
 * Once opened, the window is BURNT. No recalibration on it. If the retained configuration
 * fails, there is no falling back to a variant that was already eliminated — that would make
 * the elimination retroactively conditional on the out-of-sample result, which is exactly the
 * thing being guarded against.
 */

export class SealBrokenError extends Error {
  constructor(message: string) {
    super(`sealed window refused: ${message}`);
    this.name = 'SealBrokenError';
  }
}

/** One configuration that was pre-registered as validable, with its own frozen witness. */
export interface ValidableConfiguration {
  name: string;
  bands: BandPolicy;
  /** Present or absent — frozen at step 4, never revisited. */
  rsi: boolean;
  /** Symmetric gate, or sell-only freeze. */
  freeze: 'symmetric' | 'asymmetric';
  /** THIS configuration's own witness, searched on calibration and frozen before opening. */
  witnessTargetPercent: number;
  /** The realised mean-exposure mismatch obtained on calibration. Never recomputed. */
  witnessMismatchPoints: number;
}

export interface SelectionFile {
  schema_version: number;
  /** The bundle the selection was made on — a different bundle invalidates it. */
  bundle_sha256: string;
  /** The commit the calibration ran from. */
  crypto_buddy_commit: string | null;
  selected_arm: string;
  rsi_retained: boolean;
  asymmetry_admissible: boolean;
  configurations: ValidableConfiguration[];
  /** Digest of the decisions above, so a post-hoc edit is detectable. */
  decisions_sha256: string;
}

/** Validation limits, pre-registered. */
export const VALIDATION_MAX_DRAWDOWN_PERCENT = 45;

/**
 * The digest of the DECISIONS, not of the whole file.
 *
 * Hashing the file would include its own digest field and be impossible; hashing only the
 * decisions means a later edit to any of them — a swapped arm, a nudged witness target — no
 * longer matches, while harmless metadata can still be added.
 */
export function decisionsDigest(selection: Omit<SelectionFile, 'decisions_sha256'>): string {
  return sha256Of(
    `${JSON.stringify(
      {
        bundle_sha256: selection.bundle_sha256,
        selected_arm: selection.selected_arm,
        rsi_retained: selection.rsi_retained,
        asymmetry_admissible: selection.asymmetry_admissible,
        configurations: selection.configurations,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Loads the frozen selection, or REFUSES. Every failure here is a refusal to open the
 * window, never a warning followed by a run.
 */
export function loadSelection(file: string | undefined, expectedBundleSha256: string): SelectionFile {
  if (!file || file.trim() === '') {
    throw new SealBrokenError(
      'no selection file given. The out-of-sample window may only be opened against a ' +
        'selection that was frozen and committed BEFORE it was opened. Pass its path.',
    );
  }
  let parsed: SelectionFile;
  try {
    parsed = JSON.parse(readFileSync(path.resolve(file), 'utf8')) as SelectionFile;
  } catch (err) {
    throw new SealBrokenError(
      `cannot read the selection file "${file}" (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (parsed.schema_version !== 1) {
    throw new SealBrokenError(`selection schema_version is ${parsed.schema_version}, expected 1`);
  }
  if (!Array.isArray(parsed.configurations) || parsed.configurations.length === 0) {
    throw new SealBrokenError('the selection registers no validable configuration');
  }
  if (parsed.bundle_sha256 !== expectedBundleSha256) {
    throw new SealBrokenError(
      `the selection was made on bundle ${parsed.bundle_sha256}, this run carries ` +
        `${expectedBundleSha256}. A selection is only valid on the data it was made from.`,
    );
  }
  const recomputed = decisionsDigest(parsed);
  if (recomputed !== parsed.decisions_sha256) {
    throw new SealBrokenError(
      `the selection's decisions were edited after it was frozen — declared ` +
        `${parsed.decisions_sha256}, recomputed ${recomputed}`,
    );
  }
  // Every validable configuration must carry its OWN witness. An unpaired witness stops
  // controlling for beta, which is the only reason the comparison means anything.
  for (const cfg of parsed.configurations) {
    if (!Number.isFinite(cfg.witnessTargetPercent)) {
      throw new SealBrokenError(`configuration "${cfg.name}" carries no frozen witness target`);
    }
  }
  return parsed;
}

export interface ValidationVerdict {
  name: string;
  calibrationMetrics: Metrics;
  validationMetrics: Metrics;
  witnessValidationMetrics: Metrics;
  excessCagrPercent: number;
  rejected: boolean;
  reasons: string[];
  /**
   * How often the one-way RSI brake actually fired, per leg.
   *
   * Published because "the brake is on" and "the brake did anything" are different facts: on
   * the calibration window it bit 42 bars out of 7 662, which is why the candidate could not
   * move a CAGR by 1.5 points. A reader judging an out-of-sample result needs the same
   * number, and it is zero by construction on a configuration that froze the RSI out.
   */
  calibrationBrakedBars: number;
  validationBrakedBars: number;
}

/**
 * Replays ONE pre-registered configuration continuously from 2021 to `as_of`, then judges the
 * out-of-sample half.
 *
 * CONTINUITY IS THE POINT. The validation does not restart in cash on 1 July 2024: positions,
 * cash, peaks, stop state and hysteresis all carry across, as does an order decided on the
 * last calibration bar and executable on the first validation bar. Performance is rebased to
 * 100 at the boundary for readability; the economic state is not reset. A validation that
 * started flat would be measuring a different strategy — one that happened to be in cash on
 * that particular morning.
 */
export function validateConfiguration(
  shared: SharedTape,
  cfg: ValidableConfiguration,
  /**
   * The two windows. Defaulted to the real ones; production passes neither.
   *
   * The seam exists so the behavioural proof can exercise THIS function — the one the sealed
   * command actually calls — on two slices of the CALIBRATION window, without spending the
   * single out-of-sample opening to check a wiring question. Testing a copy of the policy
   * construction would prove something about the copy.
   */
  windows: { calibration: WindowBounds; validation: WindowBounds } = {
    calibration: CALIBRATION_WINDOW,
    validation: VALIDATION_WINDOW,
  },
): ValidationVerdict {
  /*
   * THE FROZEN CONFIGURATION IS REPLAYED IN FULL — band, RSI verdict AND freeze variant.
   *
   * Dropping either of the last two would validate a DIFFERENT strategy from the one the
   * selection committed to, and it would do so silently: the run would complete, the numbers
   * would look plausible, and the single out-of-sample opening would have been spent on a
   * configuration nobody chose. `cfg.rsi` and `cfg.freeze` are not decoration; they are two
   * thirds of what step 4 and step 6 froze.
   */
  const policy = {
    kind: 'band' as const,
    bands: cfg.bands,
    rsiBrake: cfg.rsi,
    freeze: cfg.freeze,
  };

  // Calibration leg — run for its ending STATE, which is what the validation resumes from.
  const calibration = runPolicy(shared, policy, windows.calibration);
  const resume: EngineState = calibration.result.finalState;

  const validation = runPolicy(shared, policy, windows.validation, resume);

  // The witness crosses the boundary the same way, from its own calibration state. It shares
  // the FREEZE (mechanics) and never the RSI brake (the treatment under test).
  const witnessPolicy = {
    kind: 'constant' as const,
    targetPercent: cfg.witnessTargetPercent,
    freeze: cfg.freeze,
  };
  const witnessCalibration = runPolicy(shared, witnessPolicy, windows.calibration);
  const witnessValidation = runPolicy(
    shared,
    witnessPolicy,
    windows.validation,
    witnessCalibration.result.finalState,
  );

  const excess = excessVsWitness(validation.metrics, witnessValidation.metrics);
  const reasons: string[] = [];
  if (validation.metrics.netReturnPercent < witnessValidation.metrics.netReturnPercent) {
    reasons.push(
      `net return ${validation.metrics.netReturnPercent.toFixed(2)}% is below its frozen witness ` +
        `(${witnessValidation.metrics.netReturnPercent.toFixed(2)}%)`,
    );
  }
  if (validation.metrics.maxDrawdownPercent > VALIDATION_MAX_DRAWDOWN_PERCENT) {
    reasons.push(
      `max drawdown ${validation.metrics.maxDrawdownPercent.toFixed(2)}% exceeds the ` +
        `${VALIDATION_MAX_DRAWDOWN_PERCENT}% validation limit`,
    );
  }

  return {
    name: cfg.name,
    calibrationMetrics: calibration.metrics,
    validationMetrics: validation.metrics,
    witnessValidationMetrics: witnessValidation.metrics,
    excessCagrPercent: excess.excessCagrPercent,
    rejected: reasons.length > 0,
    reasons,
    calibrationBrakedBars: calibration.result.bars.filter((b) => b.rsiBraked).length,
    validationBrakedBars: validation.result.bars.filter((b) => b.rsiBraked).length,
  };
}

async function main(): Promise<number> {
  const selectionPath = process.argv[2];
  const outDir = path.resolve(process.cwd(), 'out', 'exposure-validation');

  console.log('='.repeat(96));
  console.log('EXPOSURE VALIDATION — the sealed out-of-sample window');
  console.log('Once opened, this window is BURNT. No recalibration on it, no fallback to an');
  console.log('eliminated variant. The model is NOT in this experiment — see the README.');
  console.log('='.repeat(96));

  const { shared, bundle, prepMs } = prepareTape();
  const selection = loadSelection(selectionPath, bundle.manifest.bundle_sha256);
  console.log(`\nselection accepted: arm ${selection.selected_arm}, RSI ` +
    `${selection.rsi_retained ? 'retained' : 'absent'}, asymmetry ` +
    `${selection.asymmetry_admissible ? 'admissible' : 'not admissible'}`);
  console.log(`decisions digest  : ${selection.decisions_sha256}`);

  const t0 = Date.now();
  const verdicts = selection.configurations.map((cfg) => validateConfiguration(shared, cfg));
  const validationMs = Date.now() - t0;

  for (const v of verdicts) {
    console.log(`\n── ${v.name} ${'─'.repeat(80)}`);
    console.log(`  OOS net ${v.validationMetrics.netReturnPercent.toFixed(2)}%  ` +
      `CAGR ${v.validationMetrics.cagrPercent.toFixed(2)}%  ` +
      `maxDD ${v.validationMetrics.maxDrawdownPercent.toFixed(2)}%`);
    console.log(`  frozen witness net ${v.witnessValidationMetrics.netReturnPercent.toFixed(2)}%  ` +
      `excess of CAGR vs constant witness ${v.excessCagrPercent >= 0 ? '+' : ''}${v.excessCagrPercent.toFixed(2)}pt`);
    console.log(`  verdict: ${v.rejected ? `REJECTED — ${v.reasons.join(' | ')}` : 'PASSES'}`);
  }

  const written: WrittenFile[] = [];
  written.push(
    writeArtefact(outDir, 'summary.json', {
      kind: 'sealed-validation',
      metric_name: 'excess of CAGR vs constant witness',
      selection_decisions_sha256: selection.decisions_sha256,
      verdicts: verdicts.map((v) => ({
        name: v.name,
        validation_net_return_percent: v.validationMetrics.netReturnPercent,
        validation_cagr_percent: v.validationMetrics.cagrPercent,
        validation_max_drawdown_percent: v.validationMetrics.maxDrawdownPercent,
        witness_net_return_percent: v.witnessValidationMetrics.netReturnPercent,
        excess_cagr_points: v.excessCagrPercent,
        rejected: v.rejected,
        reasons: v.reasons,
      })),
    }),
  );
  written.push(
    writeArtefact(
      outDir,
      'manifest.json',
      buildManifest({
        kind: 'validation',
        bundle: bundle.manifest,
        cfg: shared.cfg,
        windows: { calibration: CALIBRATION_WINDOW, validation: VALIDATION_WINDOW },
        outputs: written,
        extra: { selection_decisions_sha256: selection.decisions_sha256 },
      }),
    ),
  );

  console.log(`\nartefacts → ${outDir}`);
  return verdicts.every((v) => v.rejected) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
