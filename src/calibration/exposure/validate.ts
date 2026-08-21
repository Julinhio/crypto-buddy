import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BandPolicy } from './controller.js';
import { runPolicy, type SharedTape, type WindowBounds } from './arms.js';
import { CALIBRATION_WINDOW, VALIDATION_WINDOW, prepareTape } from './tape.js';
import { excessVsWitness, WITNESS_EXPOSURE_TOLERANCE_POINTS, type Metrics } from './metrics.js';
import {
  buildManifest,
  currentDepsLockSha,
  currentSourceTreeSha,
  gitIsDirty,
  isCommittedAtHead,
  sha256Of,
  writeArtefact,
  type WrittenFile,
} from './outputs.js';
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
  /** The commit the calibration ran from — provenance, not the identity that is checked. */
  crypto_buddy_commit: string | null;
  /**
   * THE IDENTITY OF THE ENGINE THAT CALIBRATED. `git rev-parse HEAD:src`.
   *
   * Checked at validation, and part of the decisions digest. Without it the sealed window
   * could be opened after the replay mechanics had changed: the bundle would still match and
   * the digest would still verify, and the out-of-sample comparison would be measuring one
   * engine against bands and witnesses calibrated by another.
   */
  source_tree_sha: string | null;
  /**
   * THE RUNTIME DEPENDENCIES' identity — `package-lock.json` at HEAD.
   *
   * `src` is what we write; the lockfile is what we RUN. `technicalindicators` produces the
   * regime timeline and `decimal.js` produces every number in the replay, and neither lives
   * under `src/`. A dependency bump committed on its own leaves the source identity untouched
   * and `gitIsDirty()` false, which would let the sealed window open under different numerics.
   */
  deps_lock_sha: string | null;
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
        source_tree_sha: selection.source_tree_sha,
        deps_lock_sha: selection.deps_lock_sha,
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
export function loadSelection(
  file: string | undefined,
  expectedBundleSha256: string,
  /**
   * The git facts this check rests on. Defaulted to the real ones; the sealed command passes
   * nothing.
   *
   * Injectable so the REFUSALS below are provable rather than accidental — a test that could
   * only run on a clean checkout would silently stop asserting anything the moment a developer
   * had an edit in flight, which is precisely when a seal matters.
   */
  env: {
    sourceTreeSha: string | null;
    depsLockSha: string | null;
    dirty: boolean | null;
    committed: boolean | null;
  } = {
    sourceTreeSha: currentSourceTreeSha(),
    depsLockSha: currentDepsLockSha(),
    dirty: gitIsDirty(),
    committed: file ? isCommittedAtHead(file) : null,
  },
): SelectionFile {
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
  /*
   * THE SOURCE TREE MUST STILL BE THE ONE THAT CALIBRATED.
   *
   * Compared on `src/`'s tree hash rather than on the commit: the selection is produced at
   * one commit and committed at the next, and an artefact-only commit must not invalidate it.
   * The tree hash is insensitive to that and sensitive to every engine change — which is
   * exactly the line to draw.
   *
   * A DIRTY source is refused too. `rev-parse` reads the committed tree, so uncommitted
   * engine edits would slip past a tree comparison while genuinely changing what runs.
   */
  /*
   * THE SELECTION MUST BE COMMITTED, with exactly this content.
   *
   * The decisions digest is SELF-COMPUTABLE: it proves the file was not edited after being
   * written, and nothing at all about when it was written. An operator could look at the
   * calibration results, regenerate or hand-write a selection, and hand it straight to
   * validation — digest valid, bundle matching, seal defeated.
   *
   * `gitIsDirty()` cannot cover this either: it deliberately ignores `out/`, which is
   * exactly where the selection is written. So the temporal seal rests on git having the
   * file, at HEAD, byte for byte.
   */
  if (env.committed !== true) {
    throw new SealBrokenError(
      `the selection file "${file}" is not committed at HEAD with this exact content ` +
        `(${env.committed === null ? 'git could not say' : 'it differs, or is untracked'}). ` +
        'A decisions digest the file computes about itself proves it was not edited AFTER ' +
        'freezing; only the commit proves it was frozen BEFORE the window was opened.',
    );
  }

  const currentTree = env.sourceTreeSha;
  if (parsed.source_tree_sha == null || currentTree == null) {
    throw new SealBrokenError(
      'the selection carries no source-tree identity, or git cannot report the current one. ' +
        'The sealed window may only be opened by the engine that calibrated it.',
    );
  }
  if (parsed.source_tree_sha !== currentTree) {
    throw new SealBrokenError(
      `the selection was calibrated by source tree ${parsed.source_tree_sha}, this run carries ` +
        `${currentTree}. The replay mechanics changed since the bands and witnesses were fixed, ` +
        'so the out-of-sample comparison would no longer be between comparable things.',
    );
  }
  // The RUNTIME half of the same identity, checked separately from the source so a reader
  // sees WHICH one moved — "the engine changed" and "the arithmetic library changed" call for
  // different investigations.
  if (parsed.deps_lock_sha == null || env.depsLockSha == null) {
    throw new SealBrokenError(
      'the selection carries no runtime-dependency identity, or git cannot report the current ' +
        'one. The sealed window may only be opened under the dependencies that calibrated it.',
    );
  }
  if (parsed.deps_lock_sha !== env.depsLockSha) {
    throw new SealBrokenError(
      `the selection was calibrated under package-lock ${parsed.deps_lock_sha}, this run carries ` +
        `${env.depsLockSha}. technicalindicators computes the regimes and decimal.js the ` +
        'arithmetic — a different lockfile is a different engine.',
    );
  }

  if (env.dirty !== false) {
    throw new SealBrokenError(
      'the source tree has uncommitted changes (or git could not say). The recorded tree hash ' +
        'reads the COMMITTED source, so a dirty tree would pass the check while running ' +
        'different code.',
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
    /*
     * AN IMPERFECT WITNESS CANNOT SUPPORT A PASS.
     *
     * The protocol is explicit: if no constant target lands inside the pre-registered
     * tolerance, the witness is declared imperfect and cannot support any excess-of-CAGR
     * claim. The out-of-sample verdict IS such a claim — it compares this configuration's net
     * return to that witness's.
     *
     * Checking only that the target is a finite number let an unmatched witness through, and
     * validation would then have reported a pass against a control the protocol had already
     * disqualified. The three arms are sound today; a retained RSI or asymmetric variant is
     * re-searched at step 7 and carries no such guarantee.
     */
    if (!Number.isFinite(cfg.witnessMismatchPoints)) {
      throw new SealBrokenError(
        `configuration "${cfg.name}" records no witness exposure mismatch — soundness cannot be judged`,
      );
    }
    if (cfg.witnessMismatchPoints > WITNESS_EXPOSURE_TOLERANCE_POINTS) {
      throw new SealBrokenError(
        `configuration "${cfg.name}" was frozen against an IMPERFECT witness: realised exposure ` +
          `mismatch ${cfg.witnessMismatchPoints.toFixed(3)}pt exceeds the pre-registered ` +
          `${WITNESS_EXPOSURE_TOLERANCE_POINTS}pt tolerance. The protocol forbids an ` +
          'excess-of-CAGR claim resting on it, and the out-of-sample verdict is such a claim.',
      );
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
  /**
   * THE WITNESS'S EXPOSURE MATCH **IN THE OUT-OF-SAMPLE WINDOW**.
   *
   * The frozen constant target was matched to the arm on CALIBRATION, to 0.06 point. That
   * says nothing about the window it was frozen for: both realised exposures are
   * path-dependent — the gate, the stops and the movement floor all act differently on a
   * different market — so the pair can drift apart out-of-sample without anyone touching it.
   *
   * The target itself is NEVER recomputed on the future mean; the protocol forbids it and
   * that is the whole point of freezing. What is computed here is the FACT of the drift, so
   * a reader can see whether the control was still a control.
   */
  oosWitnessMismatchPoints: number;
  /** False when the pair drifted past the pre-registered 0.25-point tolerance out-of-sample. */
  oosWitnessIsSound: boolean;
  /**
   * Whether the out-of-sample excess of CAGR may be QUOTED as a claim.
   *
   * False when the witness drifted out of tolerance in this window: the protocol says an
   * imperfect witness "ne peut soutenir aucune affirmation d'excès de CAGR", and an excess
   * measured against a control that is no longer exposure-matched is precisely such an
   * affirmation. The number is still published — hiding it would be worse — but it is
   * published with this flag beside it.
   */
  excessIsSupported: boolean;
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

  /*
   * THE DRIFT IS RECORDED, NOT ACTED ON AS A REJECTION.
   *
   * The protocol's validation rejection list is CLOSED and holds two criteria: net return
   * below the frozen witness, and max drawdown above the limit. Adding a third here would be
   * expanding a protocol that was handed over closed.
   *
   * But it also says an imperfect witness cannot support an excess-of-CAGR claim — and out of
   * tolerance, out-of-sample, that is exactly what this witness is. The two statements pull in
   * different directions on the same fact, and settling that is a methodological call, not an
   * implementation one. So this records the drift and marks the excess unsupported, without
   * inventing a rejection criterion. See the PR for the open question.
   */
  return {
    name: cfg.name,
    oosWitnessMismatchPoints: excess.exposureMismatchPoints,
    oosWitnessIsSound: excess.witnessIsSound,
    excessIsSupported: excess.witnessIsSound,
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

/**
 * THE ASYMMETRY'S THIRD CONDITION, which only the sealed window can judge.
 *
 * Calibration answers the first two (CAGR at least +1 pt, drawdown degraded by less than
 * 2 pt). The third is out-of-sample and cumulative with them: the asymmetric variant's net
 * return must be AT LEAST the symmetric one's.
 *
 * Judging each configuration only against its own witness would let an asymmetric variant
 * be reported as passing while it underperformed the symmetric run it was supposed to beat —
 * the two are pre-registered as a PAIR, and the pair is the comparison.
 */
export function enforceAsymmetryPairing(
  verdicts: ValidationVerdict[],
  configurations: readonly ValidableConfiguration[],
): void {
  const byName = new Map(configurations.map((c) => [c.name, c]));
  const symmetric = verdicts.find((v) => byName.get(v.name)?.freeze === 'symmetric');
  const asymmetric = verdicts.find((v) => byName.get(v.name)?.freeze === 'asymmetric');
  // Nothing to pair when only one variant was registered — the common case.
  if (!symmetric || !asymmetric) return;

  const asymNet = asymmetric.validationMetrics.netReturnPercent;
  const symNet = symmetric.validationMetrics.netReturnPercent;
  if (asymNet < symNet) {
    asymmetric.rejected = true;
    asymmetric.reasons.push(
      `out-of-sample net return ${asymNet.toFixed(2)}% is below the symmetric variant's ` +
        `${symNet.toFixed(2)}% — the asymmetry's third pre-registered condition, judged only here`,
    );
  }
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
  // The pair check runs AFTER every verdict exists: it compares two of them.
  enforceAsymmetryPairing(verdicts, selection.configurations);
  const validationMs = Date.now() - t0;

  for (const v of verdicts) {
    console.log(`\n── ${v.name} ${'─'.repeat(80)}`);
    console.log(`  OOS net ${v.validationMetrics.netReturnPercent.toFixed(2)}%  ` +
      `CAGR ${v.validationMetrics.cagrPercent.toFixed(2)}%  ` +
      `maxDD ${v.validationMetrics.maxDrawdownPercent.toFixed(2)}%`);
    console.log(`  frozen witness net ${v.witnessValidationMetrics.netReturnPercent.toFixed(2)}%`);
    console.log(
      `  OOS witness exposure mismatch ${v.oosWitnessMismatchPoints.toFixed(3)}pt ` +
        `(${v.oosWitnessIsSound ? 'still matched' : 'DRIFTED out of tolerance'})`,
    );
    console.log(
      v.excessIsSupported
        ? `  excess of CAGR vs constant witness ${v.excessCagrPercent >= 0 ? '+' : ''}${v.excessCagrPercent.toFixed(2)}pt`
        : `  excess of CAGR: ${v.excessCagrPercent >= 0 ? '+' : ''}${v.excessCagrPercent.toFixed(2)}pt — ` +
          'NOT SUPPORTED: the witness drifted out of exposure tolerance in this window, so this ' +
          'number may not be quoted as an excess-of-CAGR claim',
    );
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
        oos_witness_mismatch_points: v.oosWitnessMismatchPoints,
        oos_witness_is_sound: v.oosWitnessIsSound,
        excess_is_supported: v.excessIsSupported,
        excess_caveat: v.excessIsSupported
          ? null
          : 'the witness drifted out of the pre-registered exposure tolerance in this window; this excess may not be quoted as a claim',
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
