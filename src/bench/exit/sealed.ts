import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BundleVerificationError, sha256Hex, type BundleManifest } from '../../calibration/exposure/bundle.js';
import { loadCertifiedPartUpTo, type BenchCandle, type CertifiedPart } from '../exposure/bundle.js';
import type { RunResult } from '../exposure/engine.js';
import { dailyLogReturns } from '../exposure/metrics.js';
import { BOOTSTRAP_DRAWS, BOOTSTRAP_SEED, stationaryBootstrap } from '../exposure/stats.js';
import { assertProductionUniverse, buildTape, calibrationUniverse, productionUniverses, universeOfParts, type Tape } from '../exposure/tape.js';
import { EXIT_SEALED, SEAL_INSTANT_MS, VALIDATION, type Window } from '../exposure/windows.js';
import { crashEpisodes, type CrashEpisode, type DailyTable } from './daily.js';
import { computeExitMetrics, episodeReadings, type ExitMetrics } from './metrics.js';
import { isGenuineSealedOpening, SEALED_FINGERPRINT_FILE, type SealedOpening } from './opening.js';

/**
 * THE SEALED VALIDATION OF THE EXIT EXPERIMENT — protocol `docs/PROTOCOLE-SORTIE-v0.4.md`, §16.
 *
 * Everything between the single opening (`opening.ts`) and the published numbers:
 *
 *   1. the sealed part, certified against the fingerprint committed in the repository since the
 *      bundle was produced — the manifest's own bytes, its `bundle_sha256` recomputed, every file
 *      hashed, every row re-judged (the calibration's certification, `loadCertifiedPartUpTo`);
 *   2. the full universe, calibration then sealed, the one overlapping 4h bar checked identical;
 *   3. THREE PREFIX TESTS before anything is measured: the regime timeline and the sticky
 *      timelines (`firstPrefixDivergence`, protocol v1.3 point 3), the daily table the rules read,
 *      and each policy's trajectory — the continuous replay, cut at 2024-07-01, must be the
 *      development replay bar for bar, field for field. Any divergence refuses the measurement;
 *   4. the window, read as a SLICE of the continuous trajectory and rebased to 1 000 $ at the
 *      4h close of 2024-07-01T00:00 (§16), the verdict of §12 as written, and the bootstrap
 *      published for information.
 *
 * Only `prepareExitContinuousTape` touches the real sealed directory, and it requires the token.
 * The pure pieces take their inputs as arguments: the tests exercise them on synthetic data, and
 * the rehearsal on the consumed calibration, before the opening.
 */

const DAY_MS = 86_400_000;

// ── 1. THE SEALED PART, CERTIFIED AGAINST THE COMMITTED FINGERPRINT ──────────────────────

export interface SealedFingerprint {
  schema_version: 1;
  kind: 'sealed-bundle-fingerprint';
  bundle_id: string;
  fetch_start: string;
  evaluation_start: string;
  as_of_exclusive: string;
  acquisition_config_sha256: string;
  producer_source_sha256: string;
  bundle_sha256: string;
  manifest_sha256: string;
  files: Array<{ file: string; sha256: string }>;
}

export function loadSealedFingerprint(rootDir: string): SealedFingerprint {
  const fp = JSON.parse(readFileSync(path.resolve(rootDir, SEALED_FINGERPRINT_FILE), 'utf8')) as SealedFingerprint;
  if (fp.kind !== 'sealed-bundle-fingerprint' || fp.schema_version !== 1) throw new Error('sealed: not a sealed-bundle fingerprint');
  return fp;
}

/**
 * Certifies a sealed part in `dir` against `fingerprint`. The manifest is compared BYTE FOR BYTE
 * (its SHA-256) before it is parsed; then its claims must be the fingerprint's; then the
 * calibration's certification runs on it unchanged, up to the fingerprint's horizon.
 */
export function certifySealedPart(fingerprint: SealedFingerprint, dir: string): CertifiedPart {
  const manifestBytes = readFileSync(path.join(dir, 'manifest.json'));
  const manifestSha = sha256Hex(manifestBytes);
  if (manifestSha !== fingerprint.manifest_sha256) {
    throw new BundleVerificationError(`sealed manifest digest is ${manifestSha}, the committed fingerprint pins ${fingerprint.manifest_sha256}`);
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as BundleManifest;
  for (const field of ['bundle_id', 'fetch_start', 'evaluation_start', 'as_of_exclusive', 'acquisition_config_sha256', 'producer_source_sha256', 'bundle_sha256'] as const) {
    if (manifest[field] !== fingerprint[field]) throw new BundleVerificationError(`sealed manifest ${field} is ${manifest[field]}, the fingerprint says ${fingerprint[field]}`);
  }
  const declared = manifest.series.map((s) => `${s.file}:${s.sha256}`).sort();
  const pinned = fingerprint.files.map((f) => `${f.file}:${f.sha256}`).sort();
  if (declared.join(',') !== pinned.join(',')) throw new BundleVerificationError('sealed manifest files differ from the fingerprint');
  const horizonMs = Date.parse(fingerprint.as_of_exclusive);
  return loadCertifiedPartUpTo(
    {
      dir: path.resolve(dir),
      bundleId: fingerprint.bundle_id,
      bundleSha256: fingerprint.bundle_sha256,
      series: manifest.series.map((s) => `${s.symbol}:${s.timeframe}`),
    },
    '/',
    horizonMs,
  );
}

// ── 2. THE FULL UNIVERSE ─────────────────────────────────────────────────────────────────

type Universe = Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }>;

/**
 * Calibration then sealed, per asset and timeframe. A sealed candle opened before `splitMs` is the
 * producer's warm-up overlap: it must exist in the calibration and be identical there, field for
 * field, and the calibration's copy is kept. Every other sealed candle must open at or after the
 * split, strictly after the calibration's last one.
 */
export function mergeUniverses(calibration: Universe, sealed: Universe, splitMs: number): Universe {
  const a = Object.keys(calibration).sort().join(',');
  const b = Object.keys(sealed).sort().join(',');
  if (a !== b) throw new Error(`sealed merge: the calibration carries [${a}], the sealed part [${b}]`);
  const out: Universe = {};
  for (const asset of Object.keys(calibration)) {
    out[asset] = { daily: [], h4: [] };
    for (const tf of ['daily', 'h4'] as const) {
      const before = calibration[asset]![tf];
      const byTs = new Map(before.map((c) => [c.timestamp, c]));
      const after: BenchCandle[] = [];
      for (const c of sealed[asset]![tf]) {
        if (c.timestamp < splitMs) {
          const twin = byTs.get(c.timestamp);
          if (!twin) throw new Error(`sealed merge: ${asset} ${tf} overlap candle ${new Date(c.timestamp).toISOString()} is not in the calibration`);
          if (JSON.stringify(twin) !== JSON.stringify(c)) throw new Error(`sealed merge: ${asset} ${tf} overlap candle ${new Date(c.timestamp).toISOString()} differs from the calibration's`);
          continue;
        }
        after.push(c);
      }
      const last = before[before.length - 1];
      if (last && after.length > 0 && after[0]!.timestamp <= last.timestamp) throw new Error(`sealed merge: ${asset} ${tf} is not ordered across the split`);
      out[asset]![tf] = [...before, ...after];
    }
  }
  return out;
}

/**
 * THE CONTINUOUS TAPE — calibration and sealed, built to the end of the sealed window. The only
 * function that reads the real sealed directory, and only with a genuine sealed opening.
 */
export function prepareExitContinuousTape(rootDir: string, sealedDir: string, opening: SealedOpening): Tape {
  if (!isGenuineSealedOpening(opening)) throw new Error('sealed tape refused: no genuine sealed opening');
  const fingerprint = loadSealedFingerprint(rootDir);
  const endMs = Date.parse(fingerprint.as_of_exclusive);
  if (endMs !== VALIDATION.toMs) throw new Error('sealed tape refused: the fingerprint\'s horizon is not the end of the validation window');
  const sealedPart = certifySealedPart(fingerprint, sealedDir);
  const merged = mergeUniverses(calibrationUniverse(rootDir, SEAL_INSTANT_MS), universeOfParts([sealedPart], endMs), SEAL_INSTANT_MS);
  assertProductionUniverse(merged);
  return buildTape(merged, productionUniverses().tradable, endMs);
}

// ── 3. THE PREFIX TESTS ──────────────────────────────────────────────────────────────────

/** The daily table on the truncated data must be the prefix of the one on the full data. */
export function dailyPrefixDivergence(truncated: DailyTable, full: DailyTable): string | null {
  const last = truncated.rows[truncated.rows.length - 1];
  if (!last) return 'the truncated daily table is empty';
  const prefix = full.rows.filter((r) => r.closeMs <= last.closeMs);
  if (prefix.length !== truncated.rows.length) return `daily rows: truncated ${truncated.rows.length}, full prefix ${prefix.length}`;
  for (let i = 0; i < prefix.length; i += 1) {
    if (JSON.stringify(prefix[i]) !== JSON.stringify(truncated.rows[i])) return `daily row ${new Date(prefix[i]!.closeMs).toISOString()} differs`;
  }
  return null;
}

/** A policy's continuous trajectory, cut at `splitMs`, must be its development replay, bar for bar. */
export function trajectoryPrefixDivergence(development: RunResult, continuous: RunResult, splitMs: number): string | null {
  const prefix = continuous.bars.filter((b) => b.t < splitMs);
  if (prefix.length !== development.bars.length) return `${development.policy}: bars, development ${development.bars.length}, continuous prefix ${prefix.length}`;
  if (development.openingEquity !== continuous.openingEquity) return `${development.policy}: opening equity differs`;
  for (let i = 0; i < prefix.length; i += 1) {
    if (JSON.stringify(prefix[i]) !== JSON.stringify(development.bars[i])) return `${development.policy}: bar ${new Date(prefix[i]!.t).toISOString()} differs`;
  }
  return null;
}

// ── 4. THE WINDOW, READ ON THE CONTINUOUS TRAJECTORY ─────────────────────────────────────

/**
 * The bars of `window` cut out of a continuous run, every dollar rebased so that the equity at the
 * last 4h close BEFORE the window (the close at `window.fromMs`) is `rebaseTo`. Percentages —
 * exposure, weights, the continuous drawdown from the whole trajectory's high — are untouched.
 */
export function sliceRun(run: RunResult, window: Window, rebaseTo: number): RunResult {
  const before = run.bars.filter((b) => b.t < window.fromMs);
  const anchor = before[before.length - 1];
  if (!anchor) throw new Error(`sealed slice: ${run.policy} has no bar before ${new Date(window.fromMs).toISOString()}`);
  const k = rebaseTo / anchor.equity;
  const bars = run.bars
    .filter((b) => b.t >= window.fromMs && b.t < window.toMs)
    .map((b) => ({ ...b, equity: b.equity * k, cash: b.cash * k, tradedNotional: b.tradedNotional * k, fees: b.fees * k, slippageCost: b.slippageCost * k }));
  if (bars.length === 0) throw new Error(`sealed slice: ${run.policy} has no bar in the window`);
  return { ...run, window, bars, openingEquity: rebaseTo };
}

export interface DrawdownSpan {
  maxDrawdownPercent: number;
  /** The 4h close of the high the worst drawdown is measured from (possibly before the window). */
  peakCloseMs: number;
  troughCloseMs: number;
  /** The first 4h close back at that high, or null if never before the end of the data. */
  recoveredCloseMs: number | null;
}

/**
 * The worst CONTINUOUS drawdown (from the whole trajectory's high) observed on the bars of
 * `[fromMs, toMs)`, with its dates. `ownHigh` reads it instead from the high of the window itself,
 * starting at its opening equity — published for information only.
 */
export function drawdownSpan(run: RunResult, fromMs: number, toMs: number, barMs: number, ownHigh = false): DrawdownSpan {
  const closeOf = (t: number): number => t + barMs;
  if (ownHigh) {
    // The window's own high starts at its opening equity, the 4h close at `fromMs`.
    const bars = sliceRun(run, { name: 'exit-sealed', fromMs, toMs }, 1).bars;
    let high = 1;
    let highAt = fromMs;
    let worst = 0;
    let peakAt = fromMs;
    let peakEquity = 1;
    let troughAt = fromMs;
    for (const b of bars) {
      if (b.equity >= high) {
        high = b.equity;
        highAt = closeOf(b.t);
      }
      const dd = ((high - b.equity) / high) * 100;
      if (dd > worst) {
        worst = dd;
        peakAt = highAt;
        peakEquity = high;
        troughAt = closeOf(b.t);
      }
    }
    const back = bars.find((b) => closeOf(b.t) > troughAt && b.equity >= peakEquity);
    return { maxDrawdownPercent: worst, peakCloseMs: peakAt, troughCloseMs: troughAt, recoveredCloseMs: worst > 0 && back ? closeOf(back.t) : null };
  }
  const inside = run.bars.filter((b) => b.t >= fromMs && b.t < toMs);
  let worstBar = inside[0]!;
  for (const b of inside) if (b.drawdownPercent > worstBar.drawdownPercent) worstBar = b;
  const all = run.bars;
  const worstIdx = all.indexOf(worstBar);
  let peakIdx = -1;
  for (let i = worstIdx; i >= 0; i -= 1) {
    if (all[i]!.drawdownPercent <= 0) {
      peakIdx = i;
      break;
    }
  }
  let recovered: number | null = null;
  for (let i = worstIdx + 1; i < all.length; i += 1) {
    if (all[i]!.drawdownPercent <= 0) {
      recovered = closeOf(all[i]!.t);
      break;
    }
  }
  return {
    maxDrawdownPercent: worstBar.drawdownPercent,
    peakCloseMs: peakIdx >= 0 ? closeOf(all[peakIdx]!.t) : run.window.fromMs,
    troughCloseMs: closeOf(worstBar.t),
    recoveredCloseMs: worstBar.drawdownPercent > 0 ? recovered : null,
  };
}

export type SealedVerdictName = 'Go pilote testnet' | 'Non retenue';

export interface SealedVerdict {
  verdict: SealedVerdictName;
  candidateNetReturnPercent: number;
  e1NetReturnPercent: number;
  positive: boolean;
  aheadOfE1: boolean;
}

/** §12 of v0.4, as written: positive net return AND a net return above E1's, both strict. */
export function sealedVerdict(candidateNetReturnPercent: number, e1NetReturnPercent: number): SealedVerdict {
  const positive = candidateNetReturnPercent > 0;
  const aheadOfE1 = candidateNetReturnPercent > e1NetReturnPercent;
  return {
    verdict: positive && aheadOfE1 ? 'Go pilote testnet' : 'Non retenue',
    candidateNetReturnPercent,
    e1NetReturnPercent,
    positive,
    aheadOfE1,
  };
}

export interface SealedPolicyReading {
  name: string;
  metrics: ExitMetrics;
  drawdown: DrawdownSpan;
  drawdownFromWindowHigh: DrawdownSpan;
}

export interface SealedBootstrapReading {
  comparison: string;
  days: number;
  meanDailyLogDifference: number;
  blockLength: number;
  lowerBound95: number;
  draws: number;
  seed: number;
}

export interface SealedMeasurement {
  window: Window;
  rebaseTo: number;
  episodes: Array<CrashEpisode & { troughInWindow: boolean }>;
  policies: SealedPolicyReading[];
  bootstrap: SealedBootstrapReading[];
  verdict: SealedVerdict;
}

/**
 * Everything §16 measures on the window, from the continuous runs. Pure: the same function runs in
 * the rehearsal (consumed data, synthetic window) and at the opening.
 */
export function measureSealedWindow(params: {
  continuous: Record<string, RunResult>;
  candidate: string;
  comparators: readonly string[];
  verdictComparator: string;
  barMs: number;
  table: DailyTable;
  startMs: number;
  window: Window;
  rebaseTo: number;
  blockLengths: Record<string, number>;
}): SealedMeasurement {
  const { continuous, barMs, window } = params;
  const episodes = crashEpisodes(params.table, params.startMs, window.toMs)
    .filter((e) => e.endMs > window.fromMs)
    .map((e) => ({ ...e, troughInWindow: e.troughMs > window.fromMs }));
  const names = [params.candidate, ...params.comparators];
  const policies: SealedPolicyReading[] = names.map((name) => {
    const run = continuous[name];
    if (!run) throw new Error(`sealed measure: no continuous run for ${name}`);
    const sliced = sliceRun(run, window, params.rebaseTo);
    return {
      name,
      metrics: { ...computeExitMetrics(sliced, barMs, []), episodes: episodeReadings(run, barMs, episodes) },
      drawdown: drawdownSpan(run, window.fromMs, window.toMs, barMs),
      drawdownFromWindowHigh: drawdownSpan(run, window.fromMs, window.toMs, barMs, true),
    };
  });
  const byName = Object.fromEntries(policies.map((p) => [p.name, p]));
  const candidateSeries = dailyLogReturns(sliceRun(continuous[params.candidate]!, window, params.rebaseTo), barMs).logReturns;
  const bootstrap = params.comparators.map((comparator) => {
    const other = dailyLogReturns(sliceRun(continuous[comparator]!, window, params.rebaseTo), barMs).logReturns;
    if (other.length !== candidateSeries.length) throw new Error('sealed measure: daily series of different lengths');
    const diff = candidateSeries.map((x, i) => x - other[i]!);
    const blockLength = params.blockLengths[comparator];
    if (blockLength == null) throw new Error(`sealed measure: no frozen block length for ${comparator}`);
    const boot = stationaryBootstrap(diff, { meanBlockLength: blockLength, draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED });
    return {
      comparison: `${params.candidate} - ${comparator}`,
      days: diff.length,
      meanDailyLogDifference: boot.estimate,
      blockLength,
      lowerBound95: boot.lowerBound95,
      draws: boot.draws,
      seed: boot.seed,
    };
  });
  return {
    window,
    rebaseTo: params.rebaseTo,
    episodes,
    policies,
    bootstrap,
    verdict: sealedVerdict(byName[params.candidate]!.metrics.base.netReturnPercent, byName[params.verdictComparator]!.metrics.base.netReturnPercent),
  };
}

/** The sealed window's length in days, for the report. */
export const SEALED_WINDOW_DAYS = (EXIT_SEALED.toMs - EXIT_SEALED.fromMs) / DAY_MS;
