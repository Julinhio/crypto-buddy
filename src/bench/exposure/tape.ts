import { regimeTimeline, type AssetSeries, type RegimePoint } from '../../market/regime.js';
import { stickyTimelines, type StickyPoint } from '../../market/transition.js';
import { timeframeMs } from '../../market/klines.js';
import { config as productionConfig } from '../../config/index.js';
import { CORE_PIN, SOL_PIN, loadCertifiedPart, type BenchCandle } from './bundle.js';
import { DEVELOPMENT, SEAL_INSTANT_MS, VerificationOpening } from './windows.js';

/**
 * THE SHARED TAPE — computed once from the certified calibration parts, read by every policy.
 *
 * Everything market-shaped comes from PRODUCTION: `regimeTimeline`, `stickyTimelines`, the
 * thresholds, the bar size. The bench adapts data to them and never reimplements them.
 *
 * ── FIVE ASSETS IN THE REGIME, FOUR IN THE BOOK ───────────────────────────────────────
 *
 * Production computes the risk_off breadth over the tradable pairs AND the reference pairs
 * (`context/build.ts`: `universeSize = tradablePairs + referencePairs`), so "80 %" means four
 * bearish out of five. The PR #36 bench loaded four assets, which made it four out of four —
 * a rule production never ran. This tape loads SOL and asserts the universe IS production's,
 * by name, so the day a reference pair is added the bench refuses to start rather than drift.
 *
 * ── `nowMs` IS THE SEAL ───────────────────────────────────────────────────────────────
 *
 * The calibration parts end before 2024-07-01, so every bar they carry has closed by then.
 * The timeline is built up to that instant and not one millisecond further: there is nothing
 * beyond it to build on, and the prefix property (see `buildTape`) is what will tie this
 * timeline to the one computed at the opening of the validation window.
 */

export interface AssetTape {
  asset: string;
  h4: BenchCandle[];
  daily: BenchCandle[];
  sticky: StickyPoint[];
  stickyByTs: Map<number, StickyPoint>;
  indexByTs: Map<number, number>;
}

export interface Tape {
  /** The regime universe, production's: tradable + reference. */
  regimeAssets: readonly string[];
  /** The book's universe: the tradable assets, sorted. */
  tradable: readonly string[];
  points: RegimePoint[];
  tapes: Record<string, AssetTape>;
  barMs: number;
  nowMs: number;
}

export function baseOf(symbol: string): string {
  return symbol.replace(/\/?USDT$/, '');
}

/** Production's regime universe and book universe, read from the live configuration. */
export function productionUniverses(): { regime: string[]; tradable: string[] } {
  const tradable = productionConfig.tradablePairs.map(baseOf).sort();
  const reference = productionConfig.referencePairs.map(baseOf);
  return { regime: [...tradable, ...reference].sort(), tradable };
}

/**
 * PURE: candles in, tape out. No file, no clock — which is what lets the prefix test feed it a
 * synthetic universe twice (whole and truncated) and compare the two timelines bar for bar.
 */
export function buildTape(
  universe: Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }>,
  tradable: readonly string[],
  nowMs: number,
): Tape {
  const regimeAssets = Object.keys(universe).sort();
  for (const asset of tradable) {
    if (!universe[asset]) throw new Error(`bench tape: tradable asset ${asset} has no data`);
  }
  const barMs = timeframeMs(productionConfig.regime.timeframe);
  const series: Record<string, AssetSeries> = {};
  for (const asset of regimeAssets) series[asset] = { daily: universe[asset]!.daily, h4: universe[asset]!.h4 };

  const points = regimeTimeline(series, productionConfig.regime.thresholds, {
    nowMs,
    barMs,
    universeSize: regimeAssets.length,
  });
  const sticky = stickyTimelines(points, productionConfig.regime.thresholds.confirmations, barMs);

  const tapes: Record<string, AssetTape> = {};
  for (const asset of regimeAssets) {
    const assetSticky = sticky[asset] ?? [];
    tapes[asset] = {
      asset,
      h4: universe[asset]!.h4,
      daily: universe[asset]!.daily,
      sticky: assetSticky,
      stickyByTs: new Map(assetSticky.map((p) => [p.timestamp, p])),
      indexByTs: new Map(universe[asset]!.h4.map((c, i) => [c.timestamp, i])),
    };
  }
  return { regimeAssets, tradable: [...tradable].sort(), points, tapes, barMs, nowMs };
}

/**
 * The calibration tape: both certified parts, production's universe asserted by name.
 *
 * `untilMs` TRUNCATES THE DATA before anything is computed: a candle that has not CLOSED by
 * then never reaches an indicator. Step 1 passes the end of the development
 * window, so nothing at all — not a regime label — is computed on the internal verification,
 * which stays closed until the SCORE variants are frozen. The prefix property guarantees the
 * development bars are identical to those of the full calibration tape.
 */
export function prepareCalibrationTape(rootDir: string, untilMs: number, opening?: VerificationOpening): Tape {
  if (!(untilMs <= SEAL_INSTANT_MS)) throw new Error('bench tape: untilMs is past the seal');
  // Past the development window is the internal verification: the data is not even truncated
  // in, let alone computed on, without the committed freeze.
  if (untilMs > DEVELOPMENT.toMs && !(opening instanceof VerificationOpening)) {
    throw new Error('bench tape: candles past 2023-01-01 belong to the internal verification — refused without a committed freeze');
  }
  const core = loadCertifiedPart(CORE_PIN, rootDir);
  const sol = loadCertifiedPart(SOL_PIN, rootDir);

  const universe: Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }> = {};
  for (const part of [core, sol]) {
    for (const [key, candles] of part.series) {
      const [symbol, timeframe] = key.split(':');
      const asset = baseOf(symbol!);
      universe[asset] ??= { daily: [], h4: [] };
      const stepMs = timeframe === '1d' ? 86_400_000 : 4 * 3_600_000;
      const kept = candles.filter((c) => c.timestamp + stepMs <= untilMs);
      if (timeframe === '1d') universe[asset]!.daily = kept;
      else universe[asset]!.h4 = kept;
    }
  }

  const expected = productionUniverses();
  const loaded = Object.keys(universe).sort();
  if (loaded.join(',') !== expected.regime.join(',')) {
    throw new Error(
      `bench tape: the bundle carries [${loaded.join(', ')}] but production's regime universe is ` +
        `[${expected.regime.join(', ')}] — the risk_off breadth would not be production's`,
    );
  }
  return buildTape(universe, expected.tradable, untilMs);
}

/**
 * THE PREFIX PROPERTY — the timeline on the truncated data equals the prefix of the timeline
 * on the full data, bar for bar, field for field.
 *
 * Returns the first divergence, or null. Exercised now on synthetic data; run for real at the
 * opening of the validation window, on calibration + sealed, before anything is measured.
 */
export function firstPrefixDivergence(truncated: Tape, full: Tape): string | null {
  const prefix = full.points.filter((p) => p.timestamp < truncated.nowMs);
  if (prefix.length !== truncated.points.length) {
    return `bar count: truncated ${truncated.points.length}, full prefix ${prefix.length}`;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    const a = JSON.stringify(truncated.points[i]);
    const b = JSON.stringify(prefix[i]);
    if (a !== b) return `regime point ${new Date(prefix[i]!.timestamp).toISOString()} differs`;
  }
  for (const asset of truncated.regimeAssets) {
    const a = truncated.tapes[asset]!.sticky;
    const b = full.tapes[asset]!.sticky.filter((p) => p.timestamp < truncated.nowMs);
    if (JSON.stringify(a) !== JSON.stringify(b)) return `sticky timeline of ${asset} differs`;
  }
  return null;
}
