import { coinClassOf, config, type AppConfig } from '../config/index.js';

export interface ClampResult {
  /** Allocation after bounding to the caps (same keys as the input, sums to ~100). */
  applied: Record<string, number>;
  clamped: boolean;
  reason: string | null;
}

// Percentages aren't money — a tiny tolerance avoids clamping on float noise
// like 35.0000001.
const EPS = 1e-9;

/**
 * The risk wrapper: bound the AI's proposed allocation to the hard caps. Every
 * possible overage is "too much risk", so the safe direction is always the
 * same — trim the excess and send it to CASH (the reserve stable), never to
 * another coin. We don't reject or re-ask the model; the code disposes.
 *
 * Two passes:
 *   1. Per-coin cap by risk class (big/small). Surplus accrues to cash.
 *   2. Cash floor: if cash is still below the minimum, scale the coins down
 *      proportionally until the floor is met (with BTC+ETH today this never
 *      triggers — 35+35 already leaves 30% — but it's correct as coins grow).
 */
export function clampAllocation(
  target: Record<string, number>,
  reserveAsset: string,
  cfg: AppConfig = config,
): ClampResult {
  const { caps } = cfg.execution;
  const reasons: string[] = [];
  const applied: Record<string, number> = {};

  // Pass 1 — per-coin caps; surplus → cash.
  let surplus = 0;
  for (const [asset, pct] of Object.entries(target)) {
    if (asset === reserveAsset) continue;
    const cap = caps.byClass[coinClassOf(asset, cfg)];
    if (pct > cap + EPS) {
      surplus += pct - cap;
      applied[asset] = cap;
      reasons.push(`${asset} ${round(pct)}→${cap}% (${coinClassOf(asset, cfg)}-cap)`);
    } else {
      applied[asset] = pct;
    }
  }
  applied[reserveAsset] = (target[reserveAsset] ?? 0) + surplus;

  // Pass 2 — cash floor.
  if (applied[reserveAsset] < caps.minCashPercent - EPS) {
    const deficit = caps.minCashPercent - applied[reserveAsset];
    const coinTotal = Object.entries(applied)
      .filter(([asset]) => asset !== reserveAsset)
      .reduce((sum, [, pct]) => sum + pct, 0);
    if (coinTotal > 0) {
      // max(_, 0): startup config validation already rules out a negative scale
      // (it needs minCash >= 100), but don't assume the caller pre-validated the
      // allocation — a malformed input could otherwise flip coins negative.
      const scale = Math.max((coinTotal - deficit) / coinTotal, 0);
      for (const [asset, pct] of Object.entries(applied)) {
        if (asset !== reserveAsset) applied[asset] = pct * scale;
      }
    }
    applied[reserveAsset] = caps.minCashPercent;
    reasons.push(`cash floor: trimmed coins to keep ${caps.minCashPercent}% reserve`);
  }

  return {
    applied,
    clamped: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join('; ') : null,
  };
}

function round(pct: number): number {
  return Math.round(pct * 10) / 10;
}
