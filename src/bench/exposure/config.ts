import { createHash } from 'node:crypto';
import { config as productionConfig } from '../../config/index.js';

/**
 * THE BENCH'S FROZEN CONFIGURATION — protocol v1.3, point 7.
 *
 * Taken from production and asserted rather than copied: the per-asset caps, the plumbing
 * floor and the peak-stop threshold. Pinned by the protocol: the basket 32.5 / 32.5 / 20 / 15,
 * which REPLACES PR #36's cap-proportional basket (33.333 / 33.333 / 19.048 / 14.286).
 * Pinned by PR #36 and kept: 0.1 % fee and 0.05 % slippage per leg, 1 000 $ of starting cash.
 *
 * There is no cash floor here and no field for one (protocol v1.3, point 2), exactly as in the
 * PR #36 harness: the bench never calls `clampAllocation`, where production's floor lives.
 */

export const BASKET: Readonly<Record<string, number>> = Object.freeze({ BTC: 32.5, ETH: 32.5, BNB: 20, XRP: 15 });
export const EXPECTED_CAPS: Readonly<Record<string, number>> = Object.freeze({ BTC: 35, ETH: 35, BNB: 20, XRP: 15 });

export const FEE_PERCENT_PER_LEG = 0.1;
export const SLIPPAGE_PERCENT_PER_LEG = 0.05;
export const STARTING_CASH_USD = 1000;
export const RESERVE_ASSET = 'USDT';

export interface BenchConfig {
  readonly assets: readonly string[];
  readonly basket: Readonly<Record<string, number>>;
  readonly caps: Readonly<Record<string, number>>;
  readonly minMovementPercent: number;
  readonly peakStopPercent: number;
  readonly feePercentPerLeg: number;
  readonly slippagePercentPerLeg: number;
  readonly startingCashUsd: number;
  readonly reserveAsset: string;
}

/**
 * Builds and BOUNDS the configuration, loudly. Production's caps must be the protocol's: if
 * someone moves a cap in production, the bench refuses to run on a basket the protocol did
 * not choose for those caps, instead of quietly measuring a different contract.
 */
export function buildBenchConfig(): BenchConfig {
  const caps = productionConfig.execution.caps.perAsset;
  const assets = Object.keys(BASKET).sort();
  const problems: string[] = [];
  if (Object.keys(caps).sort().join(',') !== assets.join(',')) {
    problems.push(`production caps cover [${Object.keys(caps).sort().join(', ')}], the basket [${assets.join(', ')}]`);
  }
  for (const asset of assets) {
    if (caps[asset] !== EXPECTED_CAPS[asset]) problems.push(`cap ${asset} is ${caps[asset]}, the protocol fixes ${EXPECTED_CAPS[asset]}`);
    if (!((BASKET[asset] ?? 0) <= (caps[asset] ?? 0))) problems.push(`basket ${asset} exceeds its cap`);
  }
  const sum = assets.reduce((s, a) => s + (BASKET[a] ?? 0), 0);
  if (Math.abs(sum - 100) > 1e-12) problems.push(`the basket sums to ${sum}`);
  if (productionConfig.execution.minMovementPercent !== 2) problems.push('the plumbing floor is not 2 %');
  if (productionConfig.transition.peakStopPercent !== 10) problems.push('the peak stop is not 10 %');
  if (problems.length > 0) throw new Error(`Invalid bench config: ${problems.join('; ')}`);

  return Object.freeze({
    assets: Object.freeze(assets),
    basket: BASKET,
    caps: Object.freeze({ ...EXPECTED_CAPS }),
    minMovementPercent: productionConfig.execution.minMovementPercent,
    peakStopPercent: productionConfig.transition.peakStopPercent,
    feePercentPerLeg: FEE_PERCENT_PER_LEG,
    slippagePercentPerLeg: SLIPPAGE_PERCENT_PER_LEG,
    startingCashUsd: STARTING_CASH_USD,
    reserveAsset: RESERVE_ASSET,
  });
}

/** Canonical digest of the configuration AND of the rules it implies, for the manifest. */
export function benchConfigSha256(cfg: BenchConfig): string {
  const canonical = {
    protocol: 'PROTOCOLE-EXPOSITION-v1.3',
    assets: [...cfg.assets],
    basket: Object.fromEntries(cfg.assets.map((a) => [a, cfg.basket[a]])),
    caps: Object.fromEntries(cfg.assets.map((a) => [a, cfg.caps[a]])),
    minMovementPercent: cfg.minMovementPercent,
    peakStopPercent: cfg.peakStopPercent,
    feePercentPerLeg: cfg.feePercentPerLeg,
    slippagePercentPerLeg: cfg.slippagePercentPerLeg,
    startingCashUsd: cfg.startingCashUsd,
    rules: {
      cashFloor: 'none',
      fixedLines: 'frozen, no_regime and unpriced lines keep their current weight and consume the budget',
      stoppedLines: 'to zero, share redistributed by waterfill under caps',
      reentry: 'barred after a stop until a neutral or bullish regime is confirmed (bearish = trend_down, reversal_down)',
      rpaExcluded: 'to zero, share kept in cash',
      execution: 'production planMovements at the next 4h open, sells then pro-rata buys, constant slippage',
      drawdown: 'continuous from the trajectory high, on 4h close equity',
    },
  };
  return createHash('sha256').update(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8').digest('hex');
}
