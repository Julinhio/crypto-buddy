import { createHash } from 'node:crypto';
import { config as productionConfig } from '../../config/index.js';

/**
 * THE EXPERIMENT'S OWN CONFIGURATION — frozen, self-describing, and deliberately NOT the
 * production configuration.
 *
 * ═══ THE CASH FLOOR IS ABSENT BY CONSTRUCTION ═══
 *
 * Production runs with `caps.minCashPercent = 30`. The protocol says the experiment has NO
 * cash floor. Those two facts have to be kept apart by something stronger than discipline,
 * because the failure is silent: a 30 % floor would cap every arm's realised exposure at
 * 70 %, which would quietly amputate arm C's constructive band (85–100 %) and make its
 * result mean nothing — while every number still looked plausible.
 *
 * So the floor is not set to zero here. It is not representable. `ExperimentConfig` has no
 * field for it, this module never reads `caps.minCashPercent`, and the harness never calls
 * `clampAllocation` (production's risk wrapper, which is where that floor lives). A test
 * greps the whole harness for the identifier and fails if it ever appears. You cannot
 * forget to zero a number that has nowhere to go.
 *
 * What IS taken from production, on purpose, because the experiment must not invent its
 * own market rules: the per-asset caps, the movement floor, and the peak-stop threshold.
 * They are read once, here, and frozen.
 */

/** Per-leg costs. Pinned by the protocol; no BNB fee discount is assumed. */
export const FEE_PERCENT_PER_LEG = 0.1;
export const SLIPPAGE_PERCENT_PER_LEG = 0.05;

export interface ExperimentConfig {
  /** Per-asset caps, in percent of equity. Straight from production, unchanged. */
  readonly caps: Readonly<Record<string, number>>;
  /** The deterministic basket, derived from `caps`. Never hand-entered. */
  readonly basket: Readonly<Record<string, number>>;
  /** The tradable universe, in a stable order so every output is reproducible. */
  readonly assets: readonly string[];
  /** Minimum movement, in percent of equity. Production's plumbing floor. */
  readonly minMovementPercent: number;
  /** Percent below the peak at which the deterministic stop fires. Production's. */
  readonly peakStopPercent: number;
  readonly feePercentPerLeg: number;
  readonly slippagePercentPerLeg: number;
  // NO cash floor. See the header — its absence is the guarantee.
}

/**
 * THE DETERMINISTIC BASKET — computed from the caps, never written down.
 *
 *   weight[asset] = cap[asset] / Σ caps
 *
 * With BTC 35, ETH 35, BNB 20, XRP 15 (Σ = 105) that gives 33.333 / 33.333 / 19.048 /
 * 14.286 %. Deriving it rather than pinning it is what keeps the experiment honest the day
 * a cap moves: a hard-coded basket would keep allocating to yesterday's caps while the
 * feasible interval used today's, and the two would disagree without saying so.
 *
 * The weights sum to 100 % by construction. `basketSumPercent` below exists so a test can
 * assert that rather than trust it.
 */
export function deterministicBasket(caps: Readonly<Record<string, number>>): Record<string, number> {
  const entries = Object.entries(caps);
  if (entries.length === 0) throw new Error('experiment config: the cap table is empty');
  let total = 0;
  for (const [asset, cap] of entries) {
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new Error(`experiment config: cap for ${asset} must be a positive finite number (got ${cap})`);
    }
    total += cap;
  }
  const basket: Record<string, number> = {};
  for (const [asset, cap] of entries) basket[asset] = (cap / total) * 100;
  return basket;
}

/** The basket's total, for the invariant test. Exact-sum arithmetic is not assumed. */
export function basketSumPercent(basket: Readonly<Record<string, number>>): number {
  return Object.values(basket).reduce((sum, weight) => sum + weight, 0);
}

/** Tolerance for the basket-sums-to-100 invariant — floating point, not policy. */
export const BASKET_SUM_TOLERANCE = 1e-9;

/**
 * Builds the frozen experiment configuration.
 *
 * Every new surface is bounded HERE, loudly, at construction — the lesson of PR #34's last
 * two findings. A configuration that is wrong must refuse to start, not produce a plausible
 * trajectory nobody can audit.
 */
export function buildExperimentConfig(
  caps: Readonly<Record<string, number>> = productionConfig.execution.caps.perAsset,
  minMovementPercent: number = productionConfig.execution.minMovementPercent,
  peakStopPercent: number = productionConfig.transition.peakStopPercent,
  feePercentPerLeg: number = FEE_PERCENT_PER_LEG,
  slippagePercentPerLeg: number = SLIPPAGE_PERCENT_PER_LEG,
): ExperimentConfig {
  const problems: string[] = [];

  const assets = Object.keys(caps).slice().sort();
  if (assets.length === 0) problems.push('caps must name at least one asset');
  for (const asset of assets) {
    const cap = caps[asset]!;
    if (!(Number.isFinite(cap) && cap > 0 && cap <= 100)) {
      problems.push(`caps.${asset} must be in (0, 100] (got ${cap})`);
    }
  }
  if (!(Number.isFinite(minMovementPercent) && minMovementPercent > 0 && minMovementPercent < 100)) {
    problems.push(`minMovementPercent must be in (0, 100) (got ${minMovementPercent})`);
  }
  if (!(Number.isFinite(peakStopPercent) && peakStopPercent > 0 && peakStopPercent < 100)) {
    problems.push(`peakStopPercent must be in (0, 100) (got ${peakStopPercent})`);
  }
  for (const [label, value] of [
    ['feePercentPerLeg', feePercentPerLeg],
    ['slippagePercentPerLeg', slippagePercentPerLeg],
  ] as const) {
    if (!(Number.isFinite(value) && value >= 0 && value < 100)) {
      problems.push(`${label} must be in [0, 100) (got ${value})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid experiment config: ${problems.join('; ')}`);
  }

  const basket = deterministicBasket(caps);
  const sum = basketSumPercent(basket);
  if (Math.abs(sum - 100) > BASKET_SUM_TOLERANCE) {
    throw new Error(`Invalid experiment config: the basket sums to ${sum}, not 100`);
  }

  return Object.freeze({
    caps: Object.freeze({ ...caps }),
    basket: Object.freeze(basket),
    assets: Object.freeze(assets),
    minMovementPercent,
    peakStopPercent,
    feePercentPerLeg,
    slippagePercentPerLeg,
  });
}

/**
 * The configuration's own digest, for the manifest.
 *
 * Canonical by construction: the assets are sorted and every field is written in a fixed
 * order, so the same configuration always yields the same hash regardless of how the object
 * was assembled. This is what lets a reader tell, a year later, whether two output folders
 * were produced under the same rules.
 */
export function experimentConfigSha256(cfg: ExperimentConfig): string {
  const canonical = {
    assets: [...cfg.assets],
    caps: Object.fromEntries([...cfg.assets].map((a) => [a, cfg.caps[a]])),
    basket: Object.fromEntries([...cfg.assets].map((a) => [a, cfg.basket[a]])),
    minMovementPercent: cfg.minMovementPercent,
    peakStopPercent: cfg.peakStopPercent,
    feePercentPerLeg: cfg.feePercentPerLeg,
    slippagePercentPerLeg: cfg.slippagePercentPerLeg,
    cashFloor: 'none',
  };
  return createHash('sha256').update(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8').digest('hex');
}
