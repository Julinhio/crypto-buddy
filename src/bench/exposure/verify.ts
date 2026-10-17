import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { currentDepsLockSha, currentGitCommit, currentSourceTreeSha, writeArtefact, type WrittenFile } from '../../provenance/artefacts.js';
import { REGIME_VERSION } from '../../market/regime.js';
import { benchConfigSha256, buildBenchConfig } from './config.js';
import { prepareCalibrationTape } from './tape.js';
import { R100_0, RPA, T100, constantPolicy, scorePolicy, type Policy } from './policy.js';
import { runWindow, type RunResult } from './engine.js';
import { computeRunMetrics, dailyLogReturns, type RunMetrics } from './metrics.js';
import { computeComponents } from './components.js';
import { stationaryBootstrap } from './stats.js';
import { topDecileOfRun } from './variants.js';
import { FREEZE_FILE, loadFreeze, type CandidateFreeze } from './freeze.js';
import { openVerification, type VerificationOpening } from './opening.js';
import { compositeScore, linearTarget, type Normalisation } from './score.js';
import type { ComponentVector } from './components.js';
import { CALIBRATION, DEVELOPMENT, SEAL_INSTANT_MS, VERIFICATION } from './windows.js';

/**
 * THE INTERNAL VERIFICATION — opened once, on the committed freeze, and filtered without adjustment.
 *
 *   npm run bench:exposure:verify
 *
 * Refuses unless `openVerification` accepts the freeze (committed at HEAD, digest intact, clean
 * tree, same source tree). Then, in a CONTINUOUS trajectory over the whole calibration — the
 * development run from 1 000 $, resumed into the verification with its state, pending order and
 * high carried — it replays the candidate, TC44, T100, R100/0 and RPA, checks that the
 * development half reproduces the frozen reference to the cent, applies the frozen
 * qualification filters, and writes `out/bench-exposure/verification/`. The sealed validation
 * window is not touched: the tape stops at 2024-07-01, and the bundle holds nothing beyond.
 */

export const VERIFICATION_OUT_DIR = path.join('out', 'bench-exposure', 'verification');

/** The candidate's score at each bar, from the FROZEN normalisations — never refitted. */
export function frozenCandidateScore(
  freeze: CandidateFreeze,
  components: Map<number, ComponentVector>,
): (t: number) => number | null {
  const terms = freeze.candidate.normalisations.map((n) => ({
    normalisation: { component: n.component, mean: n.mean, sd: n.sd, learnedOn: 'development', n: n.n } as Normalisation,
    weight: 1 / freeze.candidate.normalisations.length,
  }));
  return (t) => {
    const v = components.get(t);
    return v ? compositeScore(v, terms) : null;
  };
}

export function frozenCandidateTransform(freeze: CandidateFreeze): (score: number) => number {
  return linearTarget(freeze.candidate.transform.zAtZeroPercent, freeze.candidate.transform.zAtHundredPercent);
}

export interface Qualification {
  f1: { pass: boolean; candidateMaxDrawdownOnCalibration: number; limit: number };
  f2: {
    pass: boolean;
    calibration: { medianExposurePercent: number | null; bars: number | null; pass: boolean };
    verification: { medianExposurePercent: number | null; bars: number | null; pass: boolean };
    limit: number;
  };
  f3: { tc44Admissible: boolean; tc44MaxDrawdownOnCalibration: number; limit: number };
  f4: {
    applies: boolean;
    candidateAnnualisedOnVerification: number;
    tc44AnnualisedOnVerification: number;
    advantagePoints: number;
    required: number;
    pass: boolean | null;
  };
  candidateQualifies: boolean;
  maximumVerdictInValidation: string;
  reason: string;
}

/** PURE: the frozen filters, applied to the numbers. Tested on synthetic inputs. */
export function applyQualification(
  rules: CandidateFreeze['qualification_rules'],
  inputs: {
    candidateMaxDrawdownOnCalibration: number;
    decileCalibration: { medianExposurePercent: number; bars: number } | null;
    decileVerification: { medianExposurePercent: number; bars: number } | null;
    tc44MaxDrawdownOnCalibration: number;
    candidateAnnualisedOnVerification: number;
    tc44AnnualisedOnVerification: number;
  },
): Qualification {
  const ddLimit = rules.candidate_max_drawdown_percent_on_calibration;
  const decileLimit = rules.candidate_top_decile_min_median_exposure_percent;
  const f1pass = inputs.candidateMaxDrawdownOnCalibration <= ddLimit;
  const dc = inputs.decileCalibration;
  const dv = inputs.decileVerification;
  const calPass = dc != null && dc.medianExposurePercent >= decileLimit;
  const verPass = dv != null && dv.medianExposurePercent >= decileLimit;
  const tc44Admissible = inputs.tc44MaxDrawdownOnCalibration <= ddLimit;
  const advantage = inputs.candidateAnnualisedOnVerification - inputs.tc44AnnualisedOnVerification;
  const required = rules.tc44_admissible_min_annualised_advantage_points_on_verification;
  const f4pass = tc44Admissible ? advantage >= required : null;

  const failures: string[] = [];
  if (!f1pass) failures.push('F1 (drawdown on calibration)');
  if (!calPass) failures.push('F2 (top decile on calibration)');
  if (!verPass) failures.push('F2 (top decile on verification)');
  if (f4pass === false) failures.push('F4 (advantage over TC44 on verification)');
  const qualifies = failures.length === 0;

  return {
    f1: { pass: f1pass, candidateMaxDrawdownOnCalibration: inputs.candidateMaxDrawdownOnCalibration, limit: ddLimit },
    f2: {
      pass: calPass && verPass,
      calibration: { medianExposurePercent: dc?.medianExposurePercent ?? null, bars: dc?.bars ?? null, pass: calPass },
      verification: { medianExposurePercent: dv?.medianExposurePercent ?? null, bars: dv?.bars ?? null, pass: verPass },
      limit: decileLimit,
    },
    f3: { tc44Admissible, tc44MaxDrawdownOnCalibration: inputs.tc44MaxDrawdownOnCalibration, limit: ddLimit },
    f4: {
      applies: tc44Admissible,
      candidateAnnualisedOnVerification: inputs.candidateAnnualisedOnVerification,
      tc44AnnualisedOnVerification: inputs.tc44AnnualisedOnVerification,
      advantagePoints: advantage,
      required,
      pass: f4pass,
    },
    candidateQualifies: qualifies,
    maximumVerdictInValidation: !qualifies
      ? 'none: the candidate does not go to validation'
      : tc44Admissible
        ? 'any verdict of point 10, against TC44 as the admissible comparator'
        : 'viable sans comparateur admissible',
    reason: qualifies
      ? tc44Admissible
        ? 'F1, F2 and F4 pass'
        : 'F1 and F2 pass; TC44 is not admissible, so its comparison is descriptive (F4bis)'
      : `fails ${failures.join(', ')}`,
  };
}

interface Trajectory {
  development: RunResult;
  verification: RunResult;
  calibration: RunResult;
}

function continuous(params: {
  tape: ReturnType<typeof prepareCalibrationTape>;
  cfg: ReturnType<typeof buildBenchConfig>;
  policy: Policy;
  opening: VerificationOpening;
  scoreAt?: (t: number) => number | null;
}): Trajectory {
  const { tape, cfg, policy, opening, scoreAt } = params;
  const development = runWindow({ tape, cfg, policy, window: DEVELOPMENT, scoreAt });
  const verification = runWindow({ tape, cfg, policy, window: VERIFICATION, scoreAt, resume: development.finalState, opening });
  const calibration: RunResult = {
    policy: policy.name,
    window: CALIBRATION,
    bars: [...development.bars, ...verification.bars],
    openingEquity: development.openingEquity,
    finalState: verification.finalState,
    pendingNotExecuted: verification.pendingNotExecuted,
  };
  return { development, verification, calibration };
}

export function runVerification(rootDir = process.cwd()): { files: WrittenFile[]; summary: unknown } {
  const opening = openVerification(rootDir, VERIFICATION_OUT_DIR);
  const freeze = loadFreeze(rootDir);
  if (freeze.decisions_sha256 !== opening.evidence.freezeSha256) throw new Error('verification refused: the freeze changed under the opening');

  const cfg = buildBenchConfig();
  if (benchConfigSha256(cfg) !== freeze.bench_config_sha256) throw new Error('verification refused: the bench configuration moved since the freeze');
  const tape = prepareCalibrationTape(rootDir, SEAL_INSTANT_MS, opening);
  const components = computeComponents(tape, cfg.basket);
  const candidateScoreAt = frozenCandidateScore(freeze, components);
  const candidate = scorePolicy({
    name: freeze.candidate.name,
    toTarget: frozenCandidateTransform(freeze),
    rebalanceThresholdPoints: freeze.candidate.rebalance_threshold_points,
    riskOffForcesZero: freeze.candidate.risk_off_forces_zero,
  });
  const tc44 = constantPolicy('TC44', freeze.comparators.TC44.target_percent);

  const entries: Array<[string, Policy, ((t: number) => number | null) | undefined]> = [
    [freeze.candidate.name, candidate, candidateScoreAt],
    ['TC44', tc44, undefined],
    ['T100', T100, undefined],
    ['R100/0', R100_0, undefined],
    ['RPA', RPA, undefined],
  ];
  const trajectories: Record<string, Trajectory> = {};
  for (const [name, policy, scoreAt] of entries) {
    const tr = continuous({ tape, cfg, policy, opening, scoreAt });
    const ref = freeze.development_reference[name];
    const devClose = computeRunMetrics(tr.development, tape.barMs).closingEquity;
    if (ref == null || Math.abs(devClose - ref.closing_equity) > 1e-6 || tr.development.bars.length !== ref.bars) {
      throw new Error(`verification refused: ${name} on development (${devClose}) does not reproduce the frozen reference (${ref?.closing_equity})`);
    }
    trajectories[name] = tr;
  }

  const m = (name: string, which: keyof Trajectory): RunMetrics => computeRunMetrics(trajectories[name]![which], tape.barMs);
  const c = trajectories[freeze.candidate.name]!;
  const decileCalibration = topDecileOfRun(c.calibration, candidateScoreAt);
  const decileVerification = topDecileOfRun(c.verification, candidateScoreAt);

  const qualification = applyQualification(freeze.qualification_rules, {
    candidateMaxDrawdownOnCalibration: m(freeze.candidate.name, 'calibration').maxDrawdownPercent,
    decileCalibration: decileCalibration && { medianExposurePercent: decileCalibration.medianExposurePercent, bars: decileCalibration.bars },
    decileVerification: decileVerification && { medianExposurePercent: decileVerification.medianExposurePercent, bars: decileVerification.bars },
    tc44MaxDrawdownOnCalibration: m('TC44', 'calibration').maxDrawdownPercent,
    candidateAnnualisedOnVerification: m(freeze.candidate.name, 'verification').annualisedReturnPercent,
    tc44AnnualisedOnVerification: m('TC44', 'verification').annualisedReturnPercent,
  });

  // The intervals, with each comparison's FROZEN block length, on the verification days.
  const candidateDaily = dailyLogReturns(c.verification, tape.barMs).logReturns;
  const intervals = freeze.block_lengths.map((b) => {
    const comp = dailyLogReturns(trajectories[b.comparator]!.verification, tape.barMs).logReturns;
    const diff = candidateDaily.map((x, i) => x - comp[i]!);
    const boot = stationaryBootstrap(diff, { meanBlockLength: b.blockLength, draws: freeze.bootstrap.draws, seed: freeze.bootstrap.seed });
    return {
      comparison: b.comparison,
      decisional_possible: b.decisionalPossible,
      role: b.comparator === 'TC44' ? (qualification.f3.tc44Admissible ? 'published, does not eliminate (F4)' : 'descriptive (TC44 not admissible)') : 'descriptive',
      block_length: b.blockLength,
      days: diff.length,
      mean_daily_log_difference: boot.estimate,
      lower_bound_95: boot.lowerBound95,
      mean_annualised_log_points: boot.estimate * 365 * 100,
      lower_bound_annualised_log_points: boot.lowerBound95 * 365 * 100,
    };
  });

  const summary = {
    kind: 'bench-exposure-verification',
    protocol: freeze.protocol,
    freeze: { file: FREEZE_FILE.split(path.sep).join('/'), decisions_sha256: freeze.decisions_sha256, commit: opening.evidence.freezeCommit },
    windows: {
      development: { from: new Date(DEVELOPMENT.fromMs).toISOString(), to_exclusive: new Date(DEVELOPMENT.toMs).toISOString() },
      verification: { from: new Date(VERIFICATION.fromMs).toISOString(), to_exclusive: new Date(VERIFICATION.toMs).toISOString() },
      calibration: { from: new Date(CALIBRATION.fromMs).toISOString(), to_exclusive: new Date(CALIBRATION.toMs).toISOString() },
    },
    note: 'continuous trajectory over the whole calibration; nothing adjusted after reading; the sealed validation window is not opened',
    policies: Object.fromEntries(
      entries.map(([name]) => [name, { development: m(name, 'development'), verification: m(name, 'verification'), calibration: m(name, 'calibration') }]),
    ),
    candidate_top_decile: { calibration: decileCalibration, verification: decileVerification },
    qualification,
    intervals,
  };

  const outDir = path.resolve(rootDir, VERIFICATION_OUT_DIR);
  const files: WrittenFile[] = [writeArtefact(outDir, 'summary.json', summary)];
  files.push(
    writeArtefact(outDir, 'manifest.json', {
      schema_version: 1,
      kind: 'bench-exposure-verification',
      freeze_commit: opening.evidence.freezeCommit,
      freeze_decisions_sha256: freeze.decisions_sha256,
      crypto_buddy_commit: currentGitCommit(),
      crypto_buddy_tree_clean_outside_artefacts: true,
      crypto_buddy_src_tree_sha: currentSourceTreeSha(),
      crypto_buddy_deps_lock_sha: currentDepsLockSha(),
      regime_version: REGIME_VERSION,
      bench_config_sha256: freeze.bench_config_sha256,
      tape_truncated_at: new Date(SEAL_INSTANT_MS).toISOString(),
      outputs: [...files],
    }),
  );
  return { files, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const started = Date.now();
  const { files } = runVerification();
  for (const f of files) console.log(`${f.file}  ${f.sha256}  ${f.bytes} bytes`);
  console.log(`verification run done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
