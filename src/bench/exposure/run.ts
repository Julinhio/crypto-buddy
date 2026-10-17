import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  currentDepsLockSha,
  currentGitCommit,
  currentSourceTreeSha,
  gitIsDirty,
  writeArtefact,
  type WrittenFile,
} from '../../provenance/artefacts.js';
import { REGIME_VERSION } from '../../market/regime.js';
import { benchConfigSha256, buildBenchConfig } from './config.js';
import { CORE_PIN, SOL_PIN } from './bundle.js';
import { prepareCalibrationTape } from './tape.js';
import { R100_0, RPA, T100 } from './policy.js';
import { runWindow } from './engine.js';
import { computeRunMetrics, dailyLogReturns } from './metrics.js';
import { COMPONENT_DEFINITIONS, COMPONENT_NAMES, computeComponents } from './components.js';
import { runPredictiveStudy } from './predictive.js';
import { fitNormalisation } from './score.js';
import { DEVELOPMENT, VERIFICATION, VALIDATION } from './windows.js';

/**
 * STEP 1 OF BENCH v1.3 — the development window, and nothing else.
 *
 *   npm run bench:exposure:step1
 *
 * Builds the tape TRUNCATED at the end of the development window (no computation at all on
 * the internal verification), runs T100, R100/0 and RPA from 1 000 $ of cash, runs the
 * exploratory prerequisite on every calculable component, and writes canonical artefacts to
 * `out/bench-exposure/step1/`. No network, no database, no LLM, no clock in the artefacts.
 */

export const OUT_DIR = path.join('out', 'bench-exposure', 'step1');

const round = (x: number, dp = 6): number => (Number.isFinite(x) ? Number(x.toFixed(dp)) : x);

export function runStep1(rootDir = process.cwd()): { files: WrittenFile[]; summary: unknown } {
  const cfg = buildBenchConfig();
  const tape = prepareCalibrationTape(rootDir, DEVELOPMENT.toMs);

  const policies = [T100, R100_0, RPA];
  const runs = policies.map((policy) => runWindow({ tape, cfg, policy, window: DEVELOPMENT }));
  const metrics = runs.map((r) => computeRunMetrics(r, tape.barMs));
  const daily = Object.fromEntries(runs.map((r) => [r.policy, dailyLogReturns(r, tape.barMs)]));
  // DIAGNOSTIC, outside the protocol: the same three rules with the peak stop switched off, to
  // measure what the stop and its arbitrated re-entry cost. Development only, never a candidate.
  const withoutStop = policies.map((policy) =>
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

  const summary = {
    kind: 'bench-exposure-step1',
    protocol: 'docs/PROTOCOLE-EXPOSITION-v1.3.md',
    window: { from: new Date(DEVELOPMENT.fromMs).toISOString(), to_exclusive: new Date(DEVELOPMENT.toMs).toISOString() },
    note:
      'descriptive only — no admissibility, no verdict, no bootstrap between policies at this step. ' +
      'The internal verification and the validation were not computed on.',
    policies: metrics.map((m) => ({ ...((m) => ({
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
    }))(m), daily_observations: daily[m.policy]!.logReturns.length })),
    diagnostic_without_stop: {
      note: 'OUTSIDE THE PROTOCOL — the same rules with the peak stop never firing (and so no re-entry bar). Measures the cost of the stop; never a candidate.',
      policies: withoutStop.map((m) => ({
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
  const manifest = {
    schema_version: 1,
    kind: 'bench-exposure-step1',
    bundles: [
      { bundle_id: CORE_PIN.bundleId, bundle_sha256: CORE_PIN.bundleSha256 },
      { bundle_id: SOL_PIN.bundleId, bundle_sha256: SOL_PIN.bundleSha256 },
    ],
    tape_truncated_at: new Date(DEVELOPMENT.toMs).toISOString(),
    crypto_buddy_commit: currentGitCommit(),
    crypto_buddy_tree_dirty: gitIsDirty(),
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
  const { files } = runStep1();
  for (const f of files) console.log(`${f.file}  ${f.sha256}  ${f.bytes} bytes`);
  console.log(`step 1 done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
