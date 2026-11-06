import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalJson,
  currentDepsLockSha,
  currentGitCommit,
  currentSourceTreeSha,
  isCommittedAtHead,
  sha256Of,
  writeArtefact,
  type WrittenFile,
} from '../../provenance/artefacts.js';
import { REGIME_VERSION } from '../../market/regime.js';
import { CORE_PIN, SOL_PIN } from '../exposure/bundle.js';
import { benchConfigSha256, buildBenchConfig, type BenchConfig } from '../exposure/config.js';
import { runWindow, type RunResult } from '../exposure/engine.js';
import { dailyLogReturns } from '../exposure/metrics.js';
import { T100, TC44, TC44_TARGET_PERCENT } from '../exposure/policy.js';
import { BOOTSTRAP_DRAWS, BOOTSTRAP_SEED, politisWhite } from '../exposure/stats.js';
import { firstPrefixDivergence, prepareExitDevelopmentTape, type Tape } from '../exposure/tape.js';
import { EXIT_CONTINUOUS, EXIT_DEVELOPMENT, EXIT_SEALED, SEAL_INSTANT_MS, type Window } from '../exposure/windows.js';
import { buildDailyTable, crashEpisodes, developmentStart, type CrashEpisode, type DailyTable } from './daily.js';
import { computeExitMetrics, type ExitMetrics } from './metrics.js';
import { CRASH_THRESHOLD_PERCENT, EXIT_PARAMETERS, REBUY_EXPOSURE_PERCENT, SELECTION_RULES } from './parameters.js';
import { CANDIDATES, makeExitRule, type CandidateName } from './rules.js';
import { selectCandidate } from './selection.js';
import {
  loadSealedFreeze,
  openSealedWindow,
  sealedFreezeDigest,
  SEALED_FINGERPRINT_FILE,
  SEALED_FREEZE_FILE,
  SEALED_OPENING_RECORD,
  SEALED_OUT_DIR,
  SEALED_PROTOCOL_FILE,
  type SealedFreeze,
  type SealedOpening,
} from './opening.js';
import {
  dailyPrefixDivergence,
  loadSealedFingerprint,
  measureSealedWindow,
  prepareExitContinuousTape,
  trajectoryPrefixDivergence,
  type DrawdownSpan,
  type SealedMeasurement,
} from './sealed.js';

/**
 * THE EXIT EXPERIMENT — protocol `docs/PROTOCOLE-SORTIE-v0.3.md`. Two commands, in this order:
 *
 *   npm run bench:exit:freeze   writes `out/bench-exit/freeze.json`: the protocol's identity, the
 *                               parameters, the policies, the selection rule, the bootstrap method,
 *                               the computed start date and the crash episodes — and NOT ONE
 *                               replay. Committed before anything is measured: that commit is the
 *                               freeze, and its SHA precedes every result.
 *
 *   npm run bench:exit:dev      refuses unless that freeze is committed at HEAD and the code, the
 *                               lockfile and the protocol are the ones it signed; recomputes the
 *                               start date and the episodes and refuses if they moved; then replays
 *                               E0, E1, TC44 and S1-S5 on the development window, publishes every
 *                               measure of §10 and applies §11 as written.
 *
 * Neither reads the sealed window: their tape ends physically before 2024-07-01. A2: v0.3 selected
 * no candidate, so v0.3 opens nothing.
 *
 * Protocol `docs/PROTOCOLE-SORTIE-v0.4.md` adds two more (see below): `sealed-freeze`, then `sealed`,
 * the single opening of the sealed window for S4, through the token of `opening.ts`.
 */

export const EXIT_OUT_DIR = path.join('out', 'bench-exit');
export const EXIT_FREEZE_FILE = path.join(EXIT_OUT_DIR, 'freeze.json');
export const EXIT_DEV_DIR = path.join(EXIT_OUT_DIR, 'development');
export const EXIT_PROTOCOL_FILE = path.join('docs', 'PROTOCOLE-SORTIE-v0.3.md');

const iso = (t: number): string => new Date(t).toISOString();
const round = (x: number, dp = 6): number => (Number.isFinite(x) ? Number(x.toFixed(dp)) : x);

/** The provenance gate of v1.3: nothing written unless the tree is clean outside `out/bench-exit`. */
function dirtyOutside(rootDir: string): string[] {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', '.', `:!${EXIT_OUT_DIR.split(path.sep).join('/')}`], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

function protocolBlobSha(rootDir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', `HEAD:${EXIT_PROTOCOL_FILE.split(path.sep).join('/')}`], { cwd: rootDir, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** The policies, as the freeze names them. */
export const POLICY_DEFINITIONS: Record<string, string> = {
  E0: 'reference: constant 100 % target, no stop at all (T100 of v1.3 with the peak stop disabled); gate blind to the global risk_off',
  E1: 'reference: the current mechanism, exactly T100 of v1.3 — 10 % peak stop armed in transition, line barred until a confirmed trend_up or reversal_up; gate blind to the global risk_off',
  TC44: `reference: constant ${TC44_TARGET_PERCENT} % target, the rules of protocol v1.3 (stop, re-entry, gate seeing the global risk_off)`,
  S1: 'candidate: an asset is held while its daily close is strictly above its 200-day mean, out otherwise',
  S2: 'candidate: S1 with hysteresis — out under 97 % of the 200-day mean, back in only above 103 %',
  S3: 'candidate: out at a daily close <= 80 % of the highest daily close since the entry was filled; back in when the daily close re-crosses above its 50-day mean',
  S4: 'candidate: S3, with at least 10 days out of the market before any rebuy',
  S5: 'candidate: the synthetic basket index (32.5/32.5/20/15, rebalanced daily, close-to-close) with S2 hysteresis on its 200-day mean — all four assets out or in together',
};

function auditOfData(tape: Tape, table: DailyTable): { start: ReturnType<typeof developmentStart>; episodes: CrashEpisode[] } {
  const start = developmentStart(tape, table, SEAL_INSTANT_MS);
  if (start.startMs !== EXIT_DEVELOPMENT.fromMs) {
    throw new Error(`exit run refused: the computed start is ${iso(start.startMs)}, the pinned window starts ${iso(EXIT_DEVELOPMENT.fromMs)}`);
  }
  return { start, episodes: crashEpisodes(table, start.startMs, SEAL_INSTANT_MS) };
}

const shapeEpisodes = (episodes: readonly CrashEpisode[]) =>
  episodes.map((e, i) => ({
    episode: i + 1,
    start: iso(e.startMs),
    peak_index: round(e.peakIndex),
    crossed: iso(e.crossedMs),
    trough: iso(e.troughMs),
    trough_index: round(e.troughIndex),
    depth_percent: round(e.depthPercent),
    end: iso(e.endMs),
    recovered: e.recovered,
  }));

// ── THE FREEZE ───────────────────────────────────────────────────────────────────────────

export interface ExitFreeze {
  schema_version: 1;
  kind: 'bench-exit-freeze';
  protocol: { file: string; git_blob_sha: string };
  source_tree_sha: string;
  deps_lock_sha: string;
  bench_config_sha256: string;
  bundles: Array<{ bundle_id: string; bundle_sha256: string }>;
  development_window: { from: string; to_exclusive: string; days: number; requirements: Array<{ name: string; first: string }> };
  crash_episodes: ReturnType<typeof shapeEpisodes>;
  crash_threshold_percent: number;
  rebuy_exposure_percent: number;
  parameters: typeof EXIT_PARAMETERS;
  policies: Record<string, string>;
  selection: typeof SELECTION_RULES & { text: string[] };
  bootstrap_method: Record<string, unknown>;
  verdict_rules_for_a_later_sealed_validation: string[];
  decisions_sha256: string;
}

function freezeDigest(body: Omit<ExitFreeze, 'decisions_sha256'>): string {
  return sha256Of(canonicalJson(body));
}

export function writeExitFreeze(rootDir = process.cwd()): WrittenFile {
  const dirty = dirtyOutside(rootDir);
  if (dirty.length > 0) throw new Error(`exit freeze refused: the working tree is not clean outside ${EXIT_OUT_DIR} (${dirty.slice(0, 5).join('; ')})`);
  const protocolSha = protocolBlobSha(rootDir);
  const sourceTree = currentSourceTreeSha();
  const depsLock = currentDepsLockSha();
  if (!protocolSha || !sourceTree || !depsLock) throw new Error('exit freeze refused: git cannot name the protocol, the source tree or the lockfile');

  const cfg = buildBenchConfig();
  const tape = prepareExitDevelopmentTape(rootDir);
  const table = buildDailyTable(tape, cfg.basket);
  const { start, episodes } = auditOfData(tape, table);

  const body: Omit<ExitFreeze, 'decisions_sha256'> = {
    schema_version: 1,
    kind: 'bench-exit-freeze',
    protocol: { file: EXIT_PROTOCOL_FILE.split(path.sep).join('/'), git_blob_sha: protocolSha },
    source_tree_sha: sourceTree,
    deps_lock_sha: depsLock,
    bench_config_sha256: benchConfigSha256(cfg),
    bundles: [
      { bundle_id: CORE_PIN.bundleId, bundle_sha256: CORE_PIN.bundleSha256 },
      { bundle_id: SOL_PIN.bundleId, bundle_sha256: SOL_PIN.bundleSha256 },
    ],
    development_window: {
      from: iso(EXIT_DEVELOPMENT.fromMs),
      to_exclusive: iso(EXIT_DEVELOPMENT.toMs),
      days: (EXIT_DEVELOPMENT.toMs - EXIT_DEVELOPMENT.fromMs) / 86_400_000,
      requirements: start.requirements.map((r) => ({ name: r.name, first: iso(r.firstMs!) })),
    },
    crash_episodes: shapeEpisodes(episodes),
    crash_threshold_percent: CRASH_THRESHOLD_PERCENT,
    rebuy_exposure_percent: REBUY_EXPOSURE_PERCENT,
    parameters: EXIT_PARAMETERS,
    policies: POLICY_DEFINITIONS,
    selection: {
      ...SELECTION_RULES,
      text: [
        'eliminated: continuous drawdown above 50 % (on 4h close equity, from the trajectory high)',
        'eliminated: fees plus slippage, cumulated in dollars over the window, above half of E1\'s',
        'among the rest, the best annualised net return; a candidate strictly less than 3 annualised points behind the best is preferred if simpler, in the order S1, S5, S2, S3, S4',
        'none left: nothing goes to validation, no sealed opening, no production change; neither the thresholds nor the 50 % limit change after the results; any new attempt is a new pre-registered experiment (A2)',
      ],
    },
    bootstrap_method: {
      series: 'daily log-return difference, candidate minus comparator, on the development window',
      comparators: ['E0', 'E1', 'TC44'],
      block_length: 'Politis-White mean block length per comparison, computed on the development window by the development run and published there; frozen with the candidate before any opening of the sealed window',
      method: 'stationary bootstrap (Politis and Romano), circular, geometric blocks',
      draws: BOOTSTRAP_DRAWS,
      seed: BOOTSTRAP_SEED,
      one_sided_level: 0.95,
      lower_bound: '5th percentile of the bootstrap means',
      computed_only_if: 'a candidate is selected by §11',
    },
    verdict_rules_for_a_later_sealed_validation: [
      'admissibility first: continuous drawdown <= 50 % for the candidate and each comparator; a non-admissible comparator is published but does not enter the verdict',
      'preuve forte: candidate admissible, at least 5 annualised net points ahead of the best admissible comparator, bootstrap lower bound positive against it',
      'avantage pratique: candidate admissible, at least 5 points ahead of the best admissible comparator, interval including zero',
      'viable sans comparateur admissible: candidate admissible, no admissible comparator',
      'non retenue: candidate not admissible, or less than 5 points ahead of the best admissible comparator',
    ],
  };
  const freeze: ExitFreeze = { ...body, decisions_sha256: freezeDigest(body) };
  return writeArtefact(path.resolve(rootDir, EXIT_OUT_DIR), path.basename(EXIT_FREEZE_FILE), freeze);
}

export function loadExitFreeze(rootDir: string): ExitFreeze {
  const freeze = JSON.parse(readFileSync(path.resolve(rootDir, EXIT_FREEZE_FILE), 'utf8')) as ExitFreeze;
  if (freeze.kind !== 'bench-exit-freeze' || freeze.schema_version !== 1) throw new Error('exit run refused: not an exit freeze');
  const { decisions_sha256: declared, ...body } = freeze;
  if (freezeDigest(body) !== declared) throw new Error('exit run refused: the freeze was edited after it was signed');
  return freeze;
}

// ── THE DEVELOPMENT RUN ──────────────────────────────────────────────────────────────────

interface PolicyRun {
  name: string;
  run: RunResult;
  metrics: ExitMetrics;
}

function replay(tape: Tape, cfg: BenchConfig, table: DailyTable, episodes: readonly CrashEpisode[]): PolicyRun[] {
  const specs: Array<{ name: string; go: () => RunResult }> = [
    { name: 'E0', go: () => runWindow({ tape, cfg, policy: T100, window: EXIT_DEVELOPMENT, exitRule: makeExitRule('E0', table) }) },
    { name: 'E1', go: () => runWindow({ tape, cfg, policy: T100, window: EXIT_DEVELOPMENT }) },
    { name: 'TC44', go: () => runWindow({ tape, cfg, policy: TC44, window: EXIT_DEVELOPMENT }) },
    ...CANDIDATES.map((name) => ({ name, go: () => runWindow({ tape, cfg, policy: T100, window: EXIT_DEVELOPMENT, exitRule: makeExitRule(name, table) }) })),
  ];
  return specs.map(({ name, go }) => {
    const run = go();
    return { name, run, metrics: computeExitMetrics(run, tape.barMs, episodes) };
  });
}

function shapeMetrics(name: string, m: ExitMetrics): Record<string, unknown> {
  const b = m.base;
  return {
    policy: name,
    definition: POLICY_DEFINITIONS[name],
    bars: b.bars,
    opening_equity: round(b.openingEquity),
    closing_equity: round(b.closingEquity),
    net_return_percent: round(b.netReturnPercent),
    annualised_return_percent: round(b.annualisedReturnPercent),
    max_drawdown_percent: round(b.maxDrawdownPercent),
    time_under_high_percent: round(b.timeUnderHighPercent),
    longest_under_high_days: round(b.longestUnderHighDays),
    fees_usd: round(b.feesPaid),
    slippage_usd: round(b.slippageCost),
    friction_usd: round(m.frictionUsd),
    friction_percent_of_opening: round(b.frictionPercentOfOpening),
    traded_notional_usd: round(b.tradedNotional),
    turnover: round(b.turnover),
    turnover_by_cause: Object.fromEntries(Object.entries(b.turnoverByCause).map(([k, v]) => [k, round(v)])),
    exits: m.exits,
    exit_events: m.exitEvents,
    rule_entries: m.ruleEntries,
    mean_cash_percent: round(m.meanCashPercent),
    fully_out_time_percent: round(m.fullyOutTimePercent),
    rule_out_time_percent: Object.fromEntries(Object.entries(m.ruleOutTimePercent).map(([k, v]) => [k, round(v)])),
    a1_residual_bars_after_exit: m.residualBarsAfterExit,
    a1_max_residual_weight_percent: round(m.maxResidualWeightPercent),
    exposure: {
      mean: round(b.exposure.mean),
      median: round(b.exposure.median),
      q1: round(b.exposure.q1),
      q3: round(b.exposure.q3),
      p90: round(b.exposure.p90),
      time_in_zone_percent: Object.fromEntries(Object.entries(b.exposure.timeInZonePercent).map(([k, v]) => [k, round(v)])),
    },
    capacity_shortfall_bars: b.barsWithCapacityShortfall,
    over_exposure_bars: b.barsWithOverExposure,
    suppressed_legs: b.suppressedLegs,
    pending_not_executed: b.pendingNotExecuted,
    by_calendar_year: b.bySubperiod.map((p) => ({
      year: p.period,
      bars: p.bars,
      return_percent: round(p.returnPercent),
      max_continuous_drawdown_percent: round(p.maxDrawdownPercent),
      mean_exposure_percent: round(p.meanExposurePercent),
      fees_usd: round(p.fees),
      slippage_usd: round(p.slippageCost),
      stop_exits: p.stopExits,
    })),
    by_episode: m.episodes.map((e) => ({
      episode: e.episode,
      start: iso(e.startMs),
      end: iso(e.endMs),
      trough: iso(e.troughMs),
      return_percent: round(e.returnPercent),
      drawdown_within_percent: round(e.drawdownWithinPercent),
      worst_continuous_drawdown_percent: round(e.continuousDrawdownPercent),
      rebuy_delay_days: e.rebuyDelayDays == null ? 'non revenu' : round(e.rebuyDelayDays, 4),
      rebuy_at: e.rebuyAtMs == null ? null : iso(e.rebuyAtMs),
    })),
  };
}

export function runExitDevelopment(rootDir = process.cwd()): { files: WrittenFile[]; summary: Record<string, unknown> } {
  const dirty = dirtyOutside(rootDir);
  if (dirty.length > 0) throw new Error(`exit run refused: the working tree is not clean outside ${EXIT_OUT_DIR} (${dirty.slice(0, 5).join('; ')})`);

  // ── THE FREEZE GATE: committed, intact, and signing THIS code, lockfile and protocol ─────
  const freeze = loadExitFreeze(rootDir);
  if (isCommittedAtHead(path.resolve(rootDir, EXIT_FREEZE_FILE)) !== true) throw new Error('exit run refused: the freeze is not committed at HEAD');
  if (currentSourceTreeSha() !== freeze.source_tree_sha) throw new Error('exit run refused: src/ differs from the tree the freeze signed');
  if (currentDepsLockSha() !== freeze.deps_lock_sha) throw new Error('exit run refused: package-lock.json differs from the one the freeze signed');
  if (protocolBlobSha(rootDir) !== freeze.protocol.git_blob_sha) throw new Error('exit run refused: the protocol differs from the one the freeze signed');

  const cfg = buildBenchConfig();
  if (benchConfigSha256(cfg) !== freeze.bench_config_sha256) throw new Error('exit run refused: the bench configuration moved');
  const tape = prepareExitDevelopmentTape(rootDir);
  const table = buildDailyTable(tape, cfg.basket);
  const { episodes } = auditOfData(tape, table);
  if (JSON.stringify(shapeEpisodes(episodes)) !== JSON.stringify(freeze.crash_episodes)) throw new Error('exit run refused: the crash episodes differ from the frozen ones');

  const runs = replay(tape, cfg, table, episodes);
  const byName = Object.fromEntries(runs.map((r) => [r.name, r]));
  const e1 = byName.E1!.metrics;
  const selection = selectCandidate(
    CANDIDATES.map((name) => ({
      name,
      maxDrawdownPercent: byName[name]!.metrics.base.maxDrawdownPercent,
      frictionUsd: byName[name]!.metrics.frictionUsd,
      annualisedReturnPercent: byName[name]!.metrics.base.annualisedReturnPercent,
    })),
    e1.frictionUsd,
  );

  // ── §15.13: the block lengths, computed here only if a candidate is selected ─────────────
  let blockLengths: Array<Record<string, unknown>> | null = null;
  if (selection.selected) {
    const candidate = dailyLogReturns(byName[selection.selected]!.run, tape.barMs).logReturns;
    blockLengths = ['E0', 'E1', 'TC44'].map((comparator) => {
      const other = dailyLogReturns(byName[comparator]!.run, tape.barMs).logReturns;
      if (other.length !== candidate.length) throw new Error('exit run: daily series of different lengths');
      const pw = politisWhite(candidate.map((x, i) => x - other[i]!));
      return {
        comparison: `${selection.selected} - ${comparator}`,
        development_days: candidate.length,
        block_length: round(pw.blockLength),
        cutoff_lag: pw.cutoffLag,
        bandwidth: pw.bandwidth,
        status: 'computed on the development; to be frozen with the candidate before any opening of the sealed window',
      };
    });
  }

  const summary: Record<string, unknown> = {
    kind: 'bench-exit-development',
    protocol: freeze.protocol,
    freeze_decisions_sha256: freeze.decisions_sha256,
    window: { from: iso(EXIT_DEVELOPMENT.fromMs), to_exclusive: iso(EXIT_DEVELOPMENT.toMs), days: freeze.development_window.days },
    note: 'development only, already consumed (§6): learning and sub-period reading, never independent proof. The sealed window was not read.',
    crash_episodes: freeze.crash_episodes,
    policies: runs.map((r) => shapeMetrics(r.name, r.metrics)),
    selection: {
      rule: freeze.selection.text,
      e1_friction_usd: round(selection.e1FrictionUsd),
      friction_ceiling_usd: round(SELECTION_RULES.maxFrictionShareOfE1 * selection.e1FrictionUsd),
      lines: selection.lines.map((l) => ({
        candidate: l.name,
        max_drawdown_percent: round(l.maxDrawdownPercent),
        drawdown_ok: l.drawdownOk,
        friction_usd: round(l.frictionUsd),
        friction_share_of_e1: round(l.frictionShareOfE1),
        friction_ok: l.frictionOk,
        annualised_return_percent: round(l.annualisedReturnPercent),
        retained: l.retained,
        gap_to_best_points: l.gapToBestPoints == null ? null : round(l.gapToBestPoints),
      })),
      best: selection.best,
      within_margin: selection.withinMargin,
      selected: selection.selected,
      reason: selection.reason,
      consequence: selection.selected
        ? `${selection.selected} may be frozen, with its block lengths, for a single sealed validation — not opened in this cycle`
        : 'A2: no sealed opening, no production change, no threshold change; a new attempt is a new pre-registered experiment',
    },
    comparators_admissibility_on_development: Object.fromEntries(
      ['E0', 'E1', 'TC44'].map((n) => [n, { max_drawdown_percent: round(byName[n]!.metrics.base.maxDrawdownPercent), admissible: byName[n]!.metrics.base.maxDrawdownPercent <= 50 }]),
    ),
    block_lengths: blockLengths,
  };

  const outDir = path.resolve(rootDir, EXIT_DEV_DIR);
  const files: WrittenFile[] = [writeArtefact(outDir, 'summary.json', summary)];
  const manifest = {
    schema_version: 1,
    kind: 'bench-exit-development',
    crypto_buddy_commit: currentGitCommit(),
    crypto_buddy_tree_clean_outside_artefacts: true,
    crypto_buddy_src_tree_sha: currentSourceTreeSha(),
    crypto_buddy_deps_lock_sha: currentDepsLockSha(),
    freeze_file: EXIT_FREEZE_FILE.split(path.sep).join('/'),
    freeze_decisions_sha256: freeze.decisions_sha256,
    regime_version: REGIME_VERSION,
    bench_config_sha256: benchConfigSha256(cfg),
    bundles: freeze.bundles,
    tape_truncated_at: iso(SEAL_INSTANT_MS),
    outputs: files,
  };
  files.push(writeArtefact(outDir, 'manifest.json', manifest));
  return { files, summary };
}

// ── PROTOCOL v0.4 — THE SEALED VALIDATION OF S4 ──────────────────────────────────────────
//
//   npm run bench:exit:sealed-freeze   writes `out/bench-exit/sealed-freeze.json`: the v0.4 protocol's
//                                      identity, S4, the comparators, the verdict, the §16 measures,
//                                      the sealed fingerprint, and the Politis-White block lengths
//                                      computed on the development alone — nothing sealed is read.
//                                      Committed and PUSHED before the opening.
//
//   npm run bench:exit:sealed -- <dir> opens the sealed window ONCE (`opening.ts`), from <dir>, and
//                                      publishes `out/bench-exit/sealed/`. A second call refuses.

export const SEALED_CANDIDATE = 'S4' as const;
export const SEALED_COMPARATORS = ['E1', 'E0', 'TC44'] as const;
export const SEALED_REBASE_USD = 1000;

/** The four replays of v0.4 on any tape and window — the same specs at the freeze, the opening and in the rehearsal. */
export function sealedPolicyRuns(
  tape: Tape,
  cfg: BenchConfig,
  table: DailyTable,
  window: Window,
  gate: { sealedOpening?: SealedOpening; unsafeSyntheticWindow?: boolean } = {},
): Record<string, RunResult> {
  const base = { tape, cfg, window, ...gate };
  return {
    S4: runWindow({ ...base, policy: T100, exitRule: makeExitRule('S4', table) }),
    E0: runWindow({ ...base, policy: T100, exitRule: makeExitRule('E0', table) }),
    E1: runWindow({ ...base, policy: T100 }),
    TC44: runWindow({ ...base, policy: TC44 }),
  };
}

/** Politis-White on the development, candidate minus each comparator (§15.13, frozen by v0.4). */
export function developmentBlockLengths(dev: Record<string, RunResult>, barMs: number): Array<{ comparison: string; comparator: string; development_days: number; block_length: number; cutoff_lag: number | null; bandwidth: number }> {
  const candidate = dailyLogReturns(dev[SEALED_CANDIDATE]!, barMs).logReturns;
  return SEALED_COMPARATORS.map((comparator) => {
    const other = dailyLogReturns(dev[comparator]!, barMs).logReturns;
    if (other.length !== candidate.length) throw new Error('sealed freeze: daily series of different lengths');
    const pw = politisWhite(candidate.map((x, i) => x - other[i]!));
    return { comparison: `${SEALED_CANDIDATE} - ${comparator}`, comparator, development_days: candidate.length, block_length: pw.blockLength, cutoff_lag: pw.cutoffLag, bandwidth: pw.bandwidth };
  });
}

function gitOut(rootDir: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function writeSealedFreeze(rootDir = process.cwd()): WrittenFile {
  const dirty = dirtyOutside(rootDir);
  if (dirty.length > 0) throw new Error(`sealed freeze refused: the working tree is not clean outside ${EXIT_OUT_DIR} (${dirty.slice(0, 5).join('; ')})`);
  const protocolSha = gitOut(rootDir, ['rev-parse', `HEAD:${SEALED_PROTOCOL_FILE.split(path.sep).join('/')}`]);
  const fingerprintSha = gitOut(rootDir, ['rev-parse', `HEAD:${SEALED_FINGERPRINT_FILE.split(path.sep).join('/')}`]);
  const sourceTree = currentSourceTreeSha();
  const depsLock = currentDepsLockSha();
  if (!protocolSha || !fingerprintSha || !sourceTree || !depsLock) throw new Error('sealed freeze refused: git cannot name the protocol, the fingerprint, the source tree or the lockfile');

  // The v0.3 freeze it continues: intact, and its episodes still the data's.
  const previous = loadExitFreeze(rootDir);
  const previousCommit = gitOut(rootDir, ['log', '-1', '--format=%H', '--', EXIT_FREEZE_FILE.split(path.sep).join('/')]);
  const cfg = buildBenchConfig();
  const tape = prepareExitDevelopmentTape(rootDir);
  const table = buildDailyTable(tape, cfg.basket);
  const { episodes } = auditOfData(tape, table);
  if (JSON.stringify(shapeEpisodes(episodes)) !== JSON.stringify(previous.crash_episodes)) throw new Error('sealed freeze refused: the development episodes differ from the v0.3 freeze');

  // The development replays: they must reproduce the published v0.3 run, then give the block lengths.
  const dev = sealedPolicyRuns(tape, cfg, table, EXIT_DEVELOPMENT);
  const published = JSON.parse(readFileSync(path.resolve(rootDir, EXIT_DEV_DIR, 'summary.json'), 'utf8')) as { policies: Array<{ policy: string; closing_equity: number }> };
  const closing: Record<string, number> = {};
  for (const [name, run] of Object.entries(dev)) {
    const value = round(run.bars[run.bars.length - 1]!.equity);
    const pub = published.policies.find((p) => p.policy === name)?.closing_equity;
    if (pub !== value) throw new Error(`sealed freeze refused: ${name} closes the development at ${value}, v0.3 published ${pub}`);
    closing[name] = value;
  }
  const fingerprint = loadSealedFingerprint(rootDir);

  const body: Omit<SealedFreeze, 'decisions_sha256'> & Record<string, unknown> = {
    schema_version: 1,
    kind: 'bench-exit-sealed-freeze',
    protocol: { file: SEALED_PROTOCOL_FILE.split(path.sep).join('/'), git_blob_sha: protocolSha },
    source_tree_sha: sourceTree,
    deps_lock_sha: depsLock,
    bench_config_sha256: benchConfigSha256(cfg),
    bundles: [
      { bundle_id: CORE_PIN.bundleId, bundle_sha256: CORE_PIN.bundleSha256 },
      { bundle_id: SOL_PIN.bundleId, bundle_sha256: SOL_PIN.bundleSha256 },
    ],
    sealed_fingerprint: {
      file: SEALED_FINGERPRINT_FILE.split(path.sep).join('/'),
      git_blob_sha: fingerprintSha,
      bundle_id: fingerprint.bundle_id,
      bundle_sha256: fingerprint.bundle_sha256,
      manifest_sha256: fingerprint.manifest_sha256,
    },
    previous_freeze: { file: EXIT_FREEZE_FILE.split(path.sep).join('/'), commit: previousCommit, decisions_sha256: previous.decisions_sha256 },
    mandate: [
      'decision of Julien, 31/10/2026: the main criterion is the net return',
      'the continuous drawdown is published and eliminates nothing; ruin alone is unacceptable',
      'a new experiment in the sense of protocol v1.3 and of v0.3 A2 — not a readjustment of v0.3 after reading',
    ],
    candidate: { name: SEALED_CANDIDATE, chosen_by: 'Julien, 31/10/2026', definition: POLICY_DEFINITIONS[SEALED_CANDIDATE]!, parameters: EXIT_PARAMETERS },
    comparators: Object.fromEntries(SEALED_COMPARATORS.map((c) => [c, POLICY_DEFINITIONS[c]!])),
    continuous_trajectory: { from: iso(EXIT_CONTINUOUS.fromMs), to_exclusive: iso(EXIT_CONTINUOUS.toMs) },
    sealed_window: { from: iso(EXIT_SEALED.fromMs), to_exclusive: iso(EXIT_SEALED.toMs), days: (EXIT_SEALED.toMs - EXIT_SEALED.fromMs) / 86_400_000 },
    verdict: {
      comparator: 'E1',
      rule: [
        '"Go pilote testnet" if S4 ends the sealed window with a net return strictly positive AND strictly above E1\'s',
        'otherwise "Non retenue"',
        'E0 and TC44 are published for information and do not enter the verdict; nor does the bootstrap',
        'nothing changes after the results are read: no parameter, comparator or verdict; no second replay',
      ],
    },
    measures: [
      'one continuous replay per policy from 2020-10-01 to 2026-06-01: state, trailing highs, equity high and pending order cross 2024-07-01 as lived',
      'the window [2024-07-01, 2026-06-01) is the slice of bars opened in it, every dollar rebased so that the 4h close equity at 2024-07-01T00:00 is 1 000 $',
      'net return = closing equity / 1 000 - 1; annualised over 700 days of 365.25-day years',
      'continuous drawdown: the worst, over the window\'s 4h closes, measured from the high of the WHOLE trajectory (v1.3 point 9), with the close of that high, of the trough and of the recovery; the drawdown from the window\'s own high is published beside it for information',
      'fees and slippage in dollars of the rebased trajectory; turnover = traded notional / mean equity of the window; exits, time in cash, exposure: as in v0.3 §10 and §15, on the window\'s bars',
      'calendar years 2024 (from 07-01), 2025, 2026 (to 06-01): return from the equity carried in, continuous drawdown',
      'crash episodes: the §9 rule on the synthetic index over the closes of [2020-10-01, 2026-06-01]; the episodes still open after 2024-07-01 are published with each policy\'s readings and rebuy delay (§15.8), read on the continuous trajectory; the trough is flagged in or before the window',
    ],
    bootstrap: {
      series: 'daily log-return difference, S4 minus comparator, on the sealed window (day ends at 00:00 UTC, the first from the rebased opening)',
      method: 'stationary bootstrap (Politis and Romano), circular, geometric blocks',
      draws: BOOTSTRAP_DRAWS,
      seed: BOOTSTRAP_SEED,
      one_sided_level: 0.95,
      lower_bound: '5th percentile of the bootstrap means',
      published: 'for information only: S4 against E1 first, then E0 and TC44',
      block_lengths: developmentBlockLengths(dev, tape.barMs).map((b) => ({ ...b, block_length: round(b.block_length) })),
    },
    development_reference: {
      window: { from: iso(EXIT_DEVELOPMENT.fromMs), to_exclusive: iso(EXIT_DEVELOPMENT.toMs) },
      crash_episodes: previous.crash_episodes,
      closing_equity: closing,
    },
    opening_procedure: [
      'refused unless the v0.4 freeze is committed at HEAD, intact, signing this src, lockfile, protocol and fingerprint, the tree clean, and HEAD contained in the remote branch',
      'refused if out/bench-exit/sealed/opening.json exists on disk or in any commit: one opening, ever',
      'the opening record is written (exclusive create) BEFORE any sealed byte is read; the token it issues is the only key to the sealed tape and to the continuous window',
      'the sealed manifest is checked byte for byte against the committed manifest_sha256, its bundle_sha256 recomputed, each file hashed, each row re-judged to 2026-06-01',
      'the one overlapping 4h bar (2024-06-30T20:00) must be identical in both parts',
      'prefix tests before any measure: regime and sticky timelines, the daily table, and each policy\'s continuous trajectory against its development replay, bar for bar; the development closing equities must be the frozen ones',
      'any refusal after the record is written is published as a failure: the window stays burnt',
    ],
  };
  const freeze: SealedFreeze = { ...body, decisions_sha256: sealedFreezeDigest(body) };
  return writeArtefact(path.resolve(rootDir, EXIT_OUT_DIR), path.basename(SEALED_FREEZE_FILE), freeze);
}

interface FrozenBlocks {
  bundles: Array<{ bundle_id: string; bundle_sha256: string }>;
  bootstrap: { block_lengths: Array<{ comparator: string; block_length: number }> };
  development_reference: { closing_equity: Record<string, number>; crash_episodes: ExitFreeze['crash_episodes'] };
}

/** The checks the opening applies between the record and the first measure. Throws the first divergence. */
export function sealedPrefixChecks(params: {
  devTape: Tape;
  fullTape: Tape;
  devTable: DailyTable;
  fullTable: DailyTable;
  dev: Record<string, RunResult>;
  continuous: Record<string, RunResult>;
  splitMs: number;
  frozenClosing?: Record<string, number>;
}): string[] {
  const passed: string[] = [];
  const fail = (why: string): never => {
    throw new Error(`sealed prefix test failed: ${why}`);
  };
  const regime = firstPrefixDivergence(params.devTape, params.fullTape);
  if (regime) fail(regime);
  passed.push('regime and sticky timelines: the full timeline cut at the split is the truncated one, bar for bar');
  const daily = dailyPrefixDivergence(params.devTable, params.fullTable);
  if (daily) fail(daily);
  passed.push('daily table: identical rows up to the split');
  for (const name of Object.keys(params.dev)) {
    const div = trajectoryPrefixDivergence(params.dev[name]!, params.continuous[name]!, params.splitMs);
    if (div) fail(div);
    if (params.frozenClosing) {
      const value = round(params.dev[name]!.bars[params.dev[name]!.bars.length - 1]!.equity);
      if (value !== params.frozenClosing[name]) fail(`${name} closes the development at ${value}, frozen ${params.frozenClosing[name]}`);
    }
  }
  passed.push(`trajectories: ${Object.keys(params.dev).join(', ')} identical to their development replay up to the split${params.frozenClosing ? ', closing equities as frozen' : ''}`);
  return passed;
}

/** The summary of the sealed window, from a measurement. Pure: the rehearsal shapes its own with it. */
export function shapeSealedSummary(m: SealedMeasurement, barMs: number): Record<string, unknown> {
  const span = (d: DrawdownSpan) => ({
    max_drawdown_percent: round(d.maxDrawdownPercent),
    peak_close: iso(d.peakCloseMs),
    trough_close: iso(d.troughCloseMs),
    recovered_close: d.recoveredCloseMs == null ? 'non retrouvé' : iso(d.recoveredCloseMs),
  });
  return {
    window: { from: iso(m.window.fromMs), to_exclusive: iso(m.window.toMs), days: (m.window.toMs - m.window.fromMs) / 86_400_000, rebased_to_usd: m.rebaseTo },
    crash_episodes_open_after_the_split: m.episodes.map((e) => ({
      start: iso(e.startMs),
      crossed: iso(e.crossedMs),
      trough: iso(e.troughMs),
      trough_in_window: e.troughInWindow,
      depth_percent: round(e.depthPercent),
      end: iso(e.endMs),
      recovered: e.recovered,
    })),
    policies: m.policies.map((p) => ({
      ...shapeMetrics(p.name, p.metrics),
      continuous_drawdown: span(p.drawdown),
      drawdown_from_window_high: span(p.drawdownFromWindowHigh),
    })),
    bootstrap_for_information: m.bootstrap.map((b) => ({
      comparison: b.comparison,
      days: b.days,
      mean_daily_log_difference: round(b.meanDailyLogDifference, 9),
      frozen_block_length: b.blockLength,
      lower_bound_95_one_sided: round(b.lowerBound95, 9),
      draws: b.draws,
      seed: b.seed,
    })),
    verdict: {
      rule: '"Go pilote testnet" if S4 net return > 0 AND > E1 net return on the sealed window; otherwise "Non retenue"',
      s4_net_return_percent: round(m.verdict.candidateNetReturnPercent),
      e1_net_return_percent: round(m.verdict.e1NetReturnPercent),
      positive: m.verdict.positive,
      ahead_of_e1: m.verdict.aheadOfE1,
      verdict: m.verdict.verdict,
    },
  };
}

export function runSealedValidation(sealedDir: string, rootDir = process.cwd()): { files: WrittenFile[]; summary: Record<string, unknown> } {
  // ── Everything that needs no sealed byte is checked BEFORE the record is written ──────────
  const freeze = loadSealedFreeze(rootDir) as unknown as SealedFreeze & FrozenBlocks;
  const cfg = buildBenchConfig();
  if (benchConfigSha256(cfg) !== freeze.bench_config_sha256) throw new Error('sealed opening refused: the bench configuration moved');
  const blockLengths = Object.fromEntries(freeze.bootstrap.block_lengths.map((b) => [b.comparator, b.block_length]));
  const outDir = path.resolve(rootDir, SEALED_OUT_DIR);

  // ── THE OPENING: from here on the window counts as opened, whatever happens ──────────────
  const opening = openSealedWindow(rootDir);
  try {
    const fullTape = prepareExitContinuousTape(rootDir, sealedDir, opening);
    const devTape = prepareExitDevelopmentTape(rootDir);
    const fullTable = buildDailyTable(fullTape, cfg.basket);
    const devTable = buildDailyTable(devTape, cfg.basket);
    const start = developmentStart(fullTape, fullTable, SEAL_INSTANT_MS);
    if (start.startMs !== EXIT_DEVELOPMENT.fromMs) throw new Error(`sealed prefix test failed: the start computed on the full data is ${iso(start.startMs)}`);
    if (JSON.stringify(shapeEpisodes(crashEpisodes(fullTable, start.startMs, SEAL_INSTANT_MS))) !== JSON.stringify(freeze.development_reference.crash_episodes)) {
      throw new Error('sealed prefix test failed: the development episodes read on the full data differ from the frozen ones');
    }
    const continuous = sealedPolicyRuns(fullTape, cfg, fullTable, EXIT_CONTINUOUS, { sealedOpening: opening });
    const dev = sealedPolicyRuns(devTape, cfg, devTable, EXIT_DEVELOPMENT);
    const checks = sealedPrefixChecks({ devTape, fullTape, devTable, fullTable, dev, continuous, splitMs: SEAL_INSTANT_MS, frozenClosing: freeze.development_reference.closing_equity });
    checks.unshift('start date and development episodes: unchanged on the full data');

    const measurement = measureSealedWindow({
      continuous,
      candidate: SEALED_CANDIDATE,
      comparators: SEALED_COMPARATORS,
      verdictComparator: 'E1',
      barMs: fullTape.barMs,
      table: fullTable,
      startMs: EXIT_DEVELOPMENT.fromMs,
      window: EXIT_SEALED,
      rebaseTo: SEALED_REBASE_USD,
      blockLengths,
    });
    const summary: Record<string, unknown> = {
      kind: 'bench-exit-sealed',
      protocol: freeze.protocol,
      freeze_decisions_sha256: freeze.decisions_sha256,
      opening: opening.evidence,
      note: 'the single opening of the sealed window, for S4 alone; E0 and TC44 and the bootstrap are informative',
      prefix_tests: checks,
      ...shapeSealedSummary(measurement, fullTape.barMs),
    };
    const files: WrittenFile[] = [writeArtefact(outDir, 'summary.json', summary)];
    files.push(writeArtefact(outDir, 'manifest.json', {
      schema_version: 1,
      kind: 'bench-exit-sealed',
      crypto_buddy_commit: currentGitCommit(),
      crypto_buddy_src_tree_sha: currentSourceTreeSha(),
      crypto_buddy_deps_lock_sha: currentDepsLockSha(),
      freeze_file: SEALED_FREEZE_FILE.split(path.sep).join('/'),
      freeze_decisions_sha256: freeze.decisions_sha256,
      opening_record: SEALED_OPENING_RECORD.split(path.sep).join('/'),
      regime_version: REGIME_VERSION,
      bench_config_sha256: benchConfigSha256(cfg),
      bundles: [...freeze.bundles, freeze.sealed_fingerprint],
      tape_ends_at: iso(fullTape.nowMs),
      outputs: files,
    }));
    return { files, summary };
  } catch (err) {
    writeArtefact(outDir, 'failure.json', {
      kind: 'bench-exit-sealed-failure',
      opening: opening.evidence,
      error: err instanceof Error ? err.message : String(err),
      note: 'the window was opened and stays burnt: no second opening',
    });
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  const started = Date.now();
  if (command === 'freeze') {
    const f = writeExitFreeze();
    console.log(`${path.join(EXIT_OUT_DIR, f.file)}  ${f.sha256}  ${f.bytes} bytes`);
  } else if (command === 'dev') {
    const { files } = runExitDevelopment();
    for (const f of files) console.log(`${path.join(EXIT_DEV_DIR, f.file)}  ${f.sha256}  ${f.bytes} bytes`);
  } else if (command === 'sealed-freeze') {
    const f = writeSealedFreeze();
    console.log(`${SEALED_FREEZE_FILE}  ${f.sha256}  ${f.bytes} bytes`);
  } else if (command === 'sealed') {
    const dir = process.argv[3];
    if (!dir) throw new Error('usage: tsx src/bench/exit/run.ts sealed <sealed part directory>');
    const { files, summary } = runSealedValidation(dir);
    for (const f of files) console.log(`${path.join(SEALED_OUT_DIR, f.file)}  ${f.sha256}  ${f.bytes} bytes`);
    console.log(JSON.stringify((summary as { verdict: unknown }).verdict));
  } else {
    throw new Error('usage: tsx src/bench/exit/run.ts freeze|dev|sealed-freeze|sealed <dir>');
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
