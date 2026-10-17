import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  currentDepsLockSha,
  currentGitCommit,
  currentSourceTreeSha,
  writeArtefact,
  type WrittenFile,
} from '../../provenance/artefacts.js';
import { REGIME_VERSION } from '../../market/regime.js';
import { benchConfigSha256, buildBenchConfig } from './config.js';
import { CORE_PIN, SOL_PIN } from './bundle.js';
import { prepareCalibrationTape } from './tape.js';
import { R100_0, RPA, T100, TC44, TC44_TARGET_PERCENT, scorePolicy } from './policy.js';
import { runWindow } from './engine.js';
import { computeRunMetrics, dailyLogReturns, type RunMetrics } from './metrics.js';
import { COMPONENT_DEFINITIONS, COMPONENT_NAMES, computeComponents } from './components.js';
import { runPredictiveStudy } from './predictive.js';
import { fitNormalisation } from './score.js';
import { SCORE_SETS, THRESHOLD_GRID_POINTS, TRANSFORMS, runScoreVariants, scoreSeries } from './variants.js';
import { politisWhite, BOOTSTRAP_DRAWS, BOOTSTRAP_SEED } from './stats.js';
import { sha256Of, canonicalJson } from '../../provenance/artefacts.js';
import { FREEZE_FILE, freezeDigest, type BlockLengthEntry, type CandidateFreeze } from './freeze.js';
import { DEVELOPMENT, VERIFICATION, VALIDATION } from './windows.js';

/**
 * THE DEVELOPMENT RUN OF BENCH v1.3 — the development window, and nothing else.
 *
 *   npm run bench:exposure:dev
 *
 * Builds the tape TRUNCATED at the end of the development window (no computation at all on
 * the internal verification), runs T100, R100/0 and RPA from 1 000 $ of cash under the
 * re-entry rule of the 17/10 amendment, the diagnostic without stop, the exploratory
 * prerequisite, the six pre-registered SCORE variants and their selection rule, and writes
 * canonical artefacts to `out/bench-exposure/development/`.
 *
 * Step 1 (`122601f`) ran the same rules with the former re-entry (released on `range`); its
 * artefacts live in that commit's history and are not reproduced by this code.
 */

export const OUT_DIR = path.join('out', 'bench-exposure', 'development');

const round = (x: number, dp = 6): number => (Number.isFinite(x) ? Number(x.toFixed(dp)) : x);

/**
 * THE PROVENANCE GATE. The manifest names the commit and the source tree that produced the
 * figures; that claim is only worth something if nothing else was on disk. So the run refuses
 * to write unless the working tree is clean OUTSIDE its own artefact directory (Codex, PR #50,
 * round 2). The flow is: commit the code, run, commit the artefacts — `HEAD:src` is the same
 * at both.
 */
export function dirtyOutsideArtefacts(rootDir: string): string[] {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.', `:!${OUT_DIR.split(path.sep).join('/')}`], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** One shape for every published run, rounded for a byte-stable artefact. */
function shape(m: RunMetrics): Record<string, unknown> {
  return {
    ...m,
    netReturnPercent: round(m.netReturnPercent),
    annualisedReturnPercent: round(m.annualisedReturnPercent),
    maxDrawdownPercent: round(m.maxDrawdownPercent),
    closingEquity: round(m.closingEquity),
    feesPaid: round(m.feesPaid),
    slippageCost: round(m.slippageCost),
    tradedNotional: round(m.tradedNotional),
    turnover: round(m.turnover),
    frictionPercentOfOpening: round(m.frictionPercentOfOpening),
    turnoverByCause: Object.fromEntries(Object.entries(m.turnoverByCause).map(([k, v]) => [k, round(v)])),
    bySubperiod: m.bySubperiod.map((p) => ({
      ...p,
      startEquity: round(p.startEquity),
      endEquity: round(p.endEquity),
      returnPercent: round(p.returnPercent),
      maxDrawdownPercent: round(p.maxDrawdownPercent),
      meanExposurePercent: round(p.meanExposurePercent),
      fees: round(p.fees),
      slippageCost: round(p.slippageCost),
    })),
    timeUnderHighPercent: round(m.timeUnderHighPercent),
    longestUnderHighDays: round(m.longestUnderHighDays),
    exposure: {
      ...m.exposure,
      median: round(m.exposure.median),
      q1: round(m.exposure.q1),
      q3: round(m.exposure.q3),
      p90: round(m.exposure.p90),
      mean: round(m.exposure.mean),
      timeInZonePercent: Object.fromEntries(Object.entries(m.exposure.timeInZonePercent).map(([k, v]) => [k, round(v)])),
    },
  };
}

export function runDevelopment(rootDir = process.cwd()): { files: WrittenFile[]; summary: unknown } {
  const dirty = dirtyOutsideArtefacts(rootDir);
  if (dirty.length > 0) {
    throw new Error(`bench development run refused: the working tree is not clean outside ${OUT_DIR} (${dirty.slice(0, 5).join('; ')})`);
  }
  const cfg = buildBenchConfig();
  const tape = prepareCalibrationTape(rootDir, DEVELOPMENT.toMs);

  const policies = [T100, R100_0, RPA, TC44];
  const runs = policies.map((policy) => runWindow({ tape, cfg, policy, window: DEVELOPMENT }));
  const metrics = runs.map((r) => computeRunMetrics(r, tape.barMs));
  const daily = Object.fromEntries(runs.map((r) => [r.policy, dailyLogReturns(r, tape.barMs)]));
  // DIAGNOSTIC, outside the protocol: the same three rules with the peak stop switched off.
  const withoutStop = [T100, R100_0, RPA].map((policy) =>
    computeRunMetrics(runWindow({ tape, cfg, policy, window: DEVELOPMENT, diagnosticWithoutStop: true }), tape.barMs),
  );

  const components = computeComponents(tape, cfg.basket);
  const study = runPredictiveStudy({ tape, basket: cfg.basket, components, window: DEVELOPMENT });
  const samples = [...components.entries()].map(([t, v]) => ({ t, v }));
  const normalisations = COMPONENT_NAMES.map((name) => {
    try {
      return fitNormalisation(name, samples, DEVELOPMENT);
    } catch (err) {
      return { component: name, error: err instanceof Error ? err.message : String(err) };
    }
  });

  const score = runScoreVariants({ tape, cfg, components, window: DEVELOPMENT });

  // ── THE CANDIDATE, re-run from its own spec, and the block length of each comparison ──
  const CANDIDATE = 'SCORE-C-linear';
  const chosen = score.variants.find((v) => v.spec.name === CANDIDATE);
  if (score.selected !== CANDIDATE || chosen == null || chosen.chosenThresholdPoints !== 20) {
    throw new Error(`freeze refused: the selection gives ${score.selected}, not the arbitrated SCORE-C-linear at 20`);
  }
  const candidateScore = scoreSeries(components, SCORE_SETS.C, DEVELOPMENT);
  const candidateRun = runWindow({
    tape,
    cfg,
    window: DEVELOPMENT,
    scoreAt: candidateScore.scoreAt,
    policy: scorePolicy({ name: CANDIDATE, toTarget: TRANSFORMS.linear, rebalanceThresholdPoints: 20, riskOffForcesZero: false }),
  });
  const candidateMetrics = computeRunMetrics(candidateRun, tape.barMs);
  if (Math.abs(candidateMetrics.annualisedReturnPercent - chosen.metrics.annualisedReturnPercent) > 1e-9) {
    throw new Error('freeze refused: the re-run candidate does not reproduce the selected variant');
  }
  if (Math.abs(Number(candidateMetrics.exposure.mean.toFixed(6)) - TC44_TARGET_PERCENT) > 1e-12) {
    throw new Error(`freeze refused: TC44 is ${TC44_TARGET_PERCENT} but the candidate mean exposure is ${candidateMetrics.exposure.mean}`);
  }
  const candidateDaily = dailyLogReturns(candidateRun, tape.barMs).logReturns;
  const decisional: Record<string, string> = {
    TC44: 'possible: its admissibility is read on the whole calibration',
    T100: 'not possible: its continuous drawdown already exceeds 50 % on development, and it enters a verdict only if it respects the limit itself',
    'R100/0': 'not possible: non admissible (arbitrated on the development drawdown)',
    RPA: 'not possible: non admissible (arbitrated on the development drawdown, no exception)',
  };
  const blockLengths: BlockLengthEntry[] = ['TC44', 'T100', 'R100/0', 'RPA'].map((name) => {
    const comparator = daily[name]!.logReturns;
    if (comparator.length !== candidateDaily.length) throw new Error('freeze refused: daily series of different lengths');
    const diff = candidateDaily.map((x, i) => x - comparator[i]!);
    const pw = politisWhite(diff);
    return {
      comparison: `${CANDIDATE} - ${name}`,
      candidate: CANDIDATE,
      comparator: name,
      decisionalPossible: name === 'TC44',
      why: decisional[name]!,
      developmentDays: diff.length,
      blockLength: pw.blockLength,
      cutoffLag: pw.cutoffLag,
      bandwidth: pw.bandwidth,
    };
  });

  const summary = {
    kind: 'bench-exposure-development',
    protocol: 'docs/PROTOCOLE-EXPOSITION-v1.3.md (with the re-entry amendment of 17/10)',
    window: { from: new Date(DEVELOPMENT.fromMs).toISOString(), to_exclusive: new Date(DEVELOPMENT.toMs).toISOString() },
    note:
      'development only. No bootstrap between policies at this step. The internal verification and the validation ' +
      'were not computed on.',
    policies: metrics.map((m) => ({ ...shape(m), daily_observations: daily[m.policy]!.logReturns.length })),
    diagnostic_without_stop: {
      note: 'OUTSIDE THE PROTOCOL — the same rules with the peak stop never firing. Measures the cost of the stop; never a candidate.',
      policies: withoutStop.map(shape),
    },
    score: {
      sets: SCORE_SETS,
      transforms: Object.keys(TRANSFORMS),
      threshold_grid_points: THRESHOLD_GRID_POINTS,
      risk_off_forces_zero: false,
      selection_rule: score.rule,
      selected: score.selected,
      variants: score.variants.map((v) => ({
        name: v.spec.name,
        set: v.spec.set,
        transform: v.spec.transform,
        normalisations: v.normalisations.map((n) => ({ component: n.component, mean: round(n.mean, 8), sd: round(n.sd, 8), n: n.n })),
        threshold_trials: v.trials.map((t) => ({
          threshold_points: t.thresholdPoints,
          annualised_return_percent: round(t.annualisedReturnPercent),
          max_drawdown_percent: round(t.maxDrawdownPercent),
        })),
        chosen_threshold_points: v.chosenThresholdPoints,
        metrics: shape(v.metrics),
        top_decile: v.topDecile
          ? { score_threshold: round(v.topDecile.threshold, 8), bars: v.topDecile.bars, median_exposure_percent: round(v.topDecile.medianExposurePercent) }
          : null,
        bars_without_score: v.barsWithoutScore,
        eligible: v.eligible,
        ineligible_because: v.ineligibleBecause,
      })),
    },
    prerequisite: {
      horizons_days: study.horizonsDays,
      daily_observations: study.observations,
      definitions: COMPONENT_DEFINITIONS,
      studies: study.studies.map((s) => ({
        component: s.component,
        horizon_days: s.horizonDays,
        n: s.n,
        slope: s.regression ? round(s.regression.slope, 8) : null,
        slope_per_sd: s.slopePerSd != null ? round(s.slopePerSd, 8) : null,
        t_newey_west: s.regression ? round(s.regression.tStat, 4) : null,
        se_newey_west: s.regression ? round(s.regression.slopeSe, 8) : null,
        se_ols: s.regression ? round(s.regression.slopeSeOls, 8) : null,
        correlation: s.regression ? round(s.regression.correlation, 4) : null,
        by_year: s.byYear.map((y) => ({ ...y, slope: y.slope != null ? round(y.slope, 8) : null, tStat: y.tStat != null ? round(y.tStat, 4) : null })),
      })),
      correlations: Object.fromEntries(
        Object.entries(study.correlations).map(([a, row]) => [a, Object.fromEntries(Object.entries(row).map(([b, v]) => [b, v == null ? null : round(v, 4)]))]),
      ),
      normalisations_learned_on_development: normalisations.map((n) =>
        'mean' in n ? { component: n.component, mean: round(n.mean, 8), sd: round(n.sd, 8), n: n.n } : n,
      ),
    },
  };

  const outDir = path.resolve(rootDir, OUT_DIR);
  const files: WrittenFile[] = [writeArtefact(outDir, 'summary.json', summary)];

  // ── THE FREEZE: written here, committed before anything reads the internal verification ──
  const freezeBody: Omit<CandidateFreeze, 'decisions_sha256'> = {
    schema_version: 1,
    kind: 'bench-exposure-candidate-freeze',
    protocol: 'docs/PROTOCOLE-EXPOSITION-v1.3.md, with the amendments of 17/10 (re-entry; TC44 and qualification)',
    source_tree_sha: currentSourceTreeSha(),
    deps_lock_sha: currentDepsLockSha(),
    bench_config_sha256: benchConfigSha256(cfg),
    bundles: [
      { bundle_id: CORE_PIN.bundleId, bundle_sha256: CORE_PIN.bundleSha256 },
      { bundle_id: SOL_PIN.bundleId, bundle_sha256: SOL_PIN.bundleSha256 },
    ],
    development_summary_sha256: sha256Of(canonicalJson(summary)),
    candidate: {
      name: 'SCORE-C-linear',
      components: [...SCORE_SETS.C],
      weights: 'equal (simple mean of z-scores)',
      transform: { kind: 'linear', zAtZeroPercent: -1, zAtHundredPercent: 1 },
      rebalance_threshold_points: 20,
      risk_off_forces_zero: false,
      normalisations: candidateScore.normalisations.map((n) => ({ component: n.component, mean: n.mean, sd: n.sd, n: n.n })),
      development_mean_exposure_percent: candidateMetrics.exposure.mean,
    },
    comparators: {
      TC44: {
        target_percent: TC44_TARGET_PERCENT,
        definition:
          'constant total target; same basket, caps, stops, re-entry rules, freezes, gate (risk_off seen) and execution as the candidate; a realised shortfall is never compensated',
      },
      descriptive: ['T100', 'R100/0', 'RPA'],
    },
    development_reference: Object.fromEntries([
      ...runs.map((r, i) => [r.policy, { closing_equity: metrics[i]!.closingEquity, bars: r.bars.length }]),
      [CANDIDATE, { closing_equity: candidateMetrics.closingEquity, bars: candidateRun.bars.length }],
    ]),
    block_lengths: blockLengths,
    bootstrap: {
      draws: BOOTSTRAP_DRAWS,
      seed: BOOTSTRAP_SEED,
      one_sided_level: 0.95,
      statistic: 'mean of the daily log-return difference candidate - comparator, on the window evaluated',
      method: 'stationary bootstrap (Politis and Romano), circular, geometric blocks of the frozen mean length of that comparison',
      lower_bound: '5th percentile of the bootstrap means',
    },
    qualification_rules: {
      candidate_max_drawdown_percent_on_calibration: 50,
      candidate_top_decile_min_median_exposure_percent: 80,
      candidate_top_decile_windows: ['calibration', 'verification'],
      tc44_admissibility: 'continuous maximum drawdown <= 50 % on the whole calibration [2021-01-01, 2024-07-01)',
      tc44_admissible_min_annualised_advantage_points_on_verification: 5,
      tc44_confidence_interval: 'published, does not eliminate at this stage',
      tc44_not_admissible:
        'the comparison with TC44 is descriptive; the candidate qualifies on its own requirements, with a maximum verdict of "viable sans comparateur admissible" in validation',
      on_failure: 'if the candidate fails any filter, the result is recorded and the bench stops',
      sealed_window: 'not opened in this cycle, whatever the result',
      text: [
        'F1: the candidate continuous maximum drawdown on the whole calibration is <= 50 %',
        'F2: the candidate median realised exposure in its top conviction decile is >= 80 %, on the whole calibration AND separately on the internal verification (score at the close of t, exposure at the close of t+1)',
        'F3: TC44 is admissible if its continuous maximum drawdown on the whole calibration is <= 50 %',
        'F4: if TC44 is admissible, the candidate qualifies only if its annualised net return on the internal verification exceeds TC44 by at least 5 points; the bootstrap interval is published and does not eliminate',
        'F4bis: if TC44 is not admissible, the comparison is descriptive and the candidate qualifies on F1 and F2, with a maximum verdict in validation of "viable sans comparateur admissible"',
      ],
    },
    verdict_rules: [
      'protocol v1.3, point 10: admissibility first; decisional comparisons only between admissible policies; T100 enters a verdict only if it respects 50 % itself',
      'verdicts: preuve forte, avantage pratique, viable sans comparateur admissible, non retenue, as written in the protocol',
      'no adjustment of parameter, rule, variant or comparator after the internal verification is read, whatever the results',
    ],
  };
  const freeze: CandidateFreeze = { ...freezeBody, decisions_sha256: freezeDigest(freezeBody) };
  files.push(writeArtefact(path.resolve(rootDir, path.dirname(FREEZE_FILE)), path.basename(FREEZE_FILE), freeze));
  const manifest = {
    schema_version: 1,
    kind: 'bench-exposure-development',
    bundles: [
      { bundle_id: CORE_PIN.bundleId, bundle_sha256: CORE_PIN.bundleSha256 },
      { bundle_id: SOL_PIN.bundleId, bundle_sha256: SOL_PIN.bundleSha256 },
    ],
    tape_truncated_at: new Date(DEVELOPMENT.toMs).toISOString(),
    crypto_buddy_commit: currentGitCommit(),
    crypto_buddy_tree_clean_outside_artefacts: true,
    crypto_buddy_src_tree_sha: currentSourceTreeSha(),
    crypto_buddy_deps_lock_sha: currentDepsLockSha(),
    regime_version: REGIME_VERSION,
    bench_config_sha256: benchConfigSha256(cfg),
    windows: Object.fromEntries(
      [DEVELOPMENT, VERIFICATION, VALIDATION].map((w) => [
        w.name,
        { from: new Date(w.fromMs).toISOString(), to_exclusive: new Date(w.toMs).toISOString(), status: w === DEVELOPMENT ? 'measured' : 'closed' },
      ]),
    ),
    outputs: files,
  };
  files.push(writeArtefact(outDir, 'manifest.json', manifest));
  return { files, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const started = Date.now();
  const { files } = runDevelopment();
  for (const f of files) console.log(`${f.file}  ${f.sha256}  ${f.bytes} bytes`);
  console.log(`development run done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
