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
import { prepareExitDevelopmentTape, type Tape } from '../exposure/tape.js';
import { EXIT_DEVELOPMENT, SEAL_INSTANT_MS } from '../exposure/windows.js';
import { buildDailyTable, crashEpisodes, developmentStart, type CrashEpisode, type DailyTable } from './daily.js';
import { computeExitMetrics, type ExitMetrics } from './metrics.js';
import { CRASH_THRESHOLD_PERCENT, EXIT_PARAMETERS, REBUY_EXPOSURE_PERCENT, SELECTION_RULES } from './parameters.js';
import { CANDIDATES, makeExitRule, type CandidateName } from './rules.js';
import { selectCandidate } from './selection.js';

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
 * Nothing here reads the sealed window: the tape ends physically before 2024-07-01, and there is
 * no command that opens it. A2: with no candidate selected, there is nothing to open.
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  const started = Date.now();
  if (command === 'freeze') {
    const f = writeExitFreeze();
    console.log(`${path.join(EXIT_OUT_DIR, f.file)}  ${f.sha256}  ${f.bytes} bytes`);
  } else if (command === 'dev') {
    const { files } = runExitDevelopment();
    for (const f of files) console.log(`${path.join(EXIT_DEV_DIR, f.file)}  ${f.sha256}  ${f.bytes} bytes`);
  } else {
    throw new Error('usage: tsx src/bench/exit/run.ts freeze|dev');
  }
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
