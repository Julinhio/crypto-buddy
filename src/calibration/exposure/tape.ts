import { regimeTimeline, type AssetSeries } from '../../market/regime.js';
import { stickyTimelines } from '../../market/transition.js';
import { timeframeMs } from '../../market/klines.js';
import { config as productionConfig } from '../../config/index.js';
import { loadVerifiedBundle, type VerifiedBundle } from './bundle.js';
import { buildExperimentConfig } from './config.js';
import type { AssetTape } from './engine.js';
import type { SharedTape } from './arms.js';

/**
 * THE SHARED PREPARATION — computed ONCE, reused by every arm and every witness target.
 *
 * This is what makes an exhaustive 401-target search affordable. The expensive work is the
 * indicator pass over 14 543 bars (RSI, SMA, EMA, then hysteresis, then the sticky
 * timelines): ~430 ms. It depends only on the DATA, never on the exposure policy, so
 * recomputing it per target would multiply that cost by 401 for no change in its output.
 * A single replay walk is ~1.3 s; the prep is amortised to nothing.
 *
 * WARM-UP IS NOT OPTIONAL AND IT IS NOT A DETAIL. The timeline is built from `fetch_start`
 * (2020-01-01), not from the evaluation window. Hysteresis needs three confirmations before
 * a label means anything, and the risk_off posture needs its own history: starting the
 * timeline at 2021-01-01 would have every asset's regime seeded from nothing and the first
 * weeks of the calibration would be measuring the warm-up rather than the strategy.
 *
 * Everything below comes from PRODUCTION — `regimeTimeline`, `stickyTimelines`, the
 * thresholds, the bar size. The harness adapts data to them; it never reimplements them.
 */

/** Maps `BTCUSDT` → `BTC`. The bundle speaks in pairs, the bot in base assets. */
export function assetOfSymbol(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

export interface PreparedTape {
  shared: SharedTape;
  bundle: VerifiedBundle;
  /** Wall-clock cost of the preparation, published rather than estimated. */
  prepMs: number;
}

/**
 * Loads and certifies the bundle, then builds everything a replay needs.
 *
 * `rootDir` exists for the tests, which point it at deliberately corrupted copies. Production
 * of this harness passes nothing.
 */
export function prepareTape(rootDir = process.cwd()): PreparedTape {
  const startedAt = Date.now();

  const bundle = loadVerifiedBundle(rootDir);
  const cfg = buildExperimentConfig();

  const universe: Record<string, AssetSeries> = {};
  for (const [key, candles] of bundle.series) {
    const [symbol, timeframe] = key.split(':');
    const asset = assetOfSymbol(symbol!);
    universe[asset] ??= { daily: [], h4: [] };
    if (timeframe === '1d') universe[asset]!.daily = candles;
    else universe[asset]!.h4 = candles;
  }

  // The universe the bundle carries and the universe the caps describe must be the same
  // set. A mismatch means the experiment would be sizing assets it has no data for, or
  // reading data for assets it can never allocate to — both silent, both fatal to the
  // basket's meaning, so both fail here rather than downstream.
  const dataAssets = Object.keys(universe).sort();
  const configAssets = [...cfg.assets].sort();
  if (dataAssets.join(',') !== configAssets.join(',')) {
    throw new Error(
      `exposure tape: the bundle carries [${dataAssets.join(', ')}] but the caps describe ` +
        `[${configAssets.join(', ')}] — the basket would not mean what it says`,
    );
  }

  const barMs = timeframeMs(productionConfig.regime.timeframe);
  // `nowMs = as_of_exclusive`: every bar the bundle admits has closed, so the whole timeline
  // is available. Production passes the wall clock here; the replay passes the data horizon,
  // which is the same rule applied to a frozen world.
  const points = regimeTimeline(universe, productionConfig.regime.thresholds, {
    nowMs: bundle.asOfExclusiveMs,
    barMs,
    universeSize: dataAssets.length,
  });
  const sticky = stickyTimelines(points, productionConfig.regime.thresholds.confirmations, barMs);

  const tapes: Record<string, AssetTape> = {};
  for (const asset of cfg.assets) {
    const h4 = universe[asset]!.h4;
    const indexByTimestamp = new Map<number, number>();
    h4.forEach((candle, index) => indexByTimestamp.set(candle.timestamp, index));
    const assetSticky = sticky[asset];
    if (!assetSticky) throw new Error(`exposure tape: no sticky timeline for ${asset}`);
    tapes[asset] = { h4, sticky: assetSticky, indexByTimestamp };
  }

  return {
    shared: { cfg, points, tapes, barMs },
    bundle,
    prepMs: Date.now() - startedAt,
  };
}

/**
 * The two windows, semi-open so no bar can fall inside both.
 *
 * Calibration ends and validation begins at the SAME instant, and the replay crosses that
 * instant without resetting: positions, cash, peaks, stop state and hysteresis all carry
 * over, as does an order decided on the last calibration bar and executable on the first
 * validation bar. Only the PERFORMANCE is rebased to 100 at the boundary, for readability.
 * A validation that restarted in cash would be measuring a different strategy — one that
 * happened to be flat on 1 July 2024.
 */
export const CALIBRATION_WINDOW = Object.freeze({
  fromMs: Date.parse('2021-01-01T00:00:00Z'),
  toMs: Date.parse('2024-07-01T00:00:00Z'),
});

export const VALIDATION_WINDOW = Object.freeze({
  fromMs: Date.parse('2024-07-01T00:00:00Z'),
  toMs: Date.parse('2026-08-21T00:00:00Z'),
});
