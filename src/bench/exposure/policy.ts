import type { AssetRegime, RegimePoint } from '../../market/regime.js';
import type { StickyPoint } from '../../market/transition.js';

/**
 * THE POLICIES OF PROTOCOL v1.3, point 6 — each one a total target and, for RPA, a set of
 * lines it takes out. Nothing else differs between them: the gate, the stops, the re-entry
 * rule, the allocation and the execution are the engine's, shared.
 *
 *   T100    100 %, always. The gate sees `riskOffConfirmed = false`: the risk_off does not
 *           exist for the witness (the only effect is that a frozen line under risk_off stays
 *           frozen instead of becoming sellable).
 *   R100/0  100 %, 0 % on a CONFIRMED global risk_off.
 *   RPA     100 %. An asset goes out when its regime is CONFIRMED bearish and the exit is
 *           REMEMBERED: it stays out through `range` and through any further bearish label, and
 *           comes back only on a confirmed `trend_up` or `reversal_up` (amendment of 17/10, after
 *           step 1, before any SCORE run). Never during a transition. 0 % on a confirmed global
 *           risk_off, back to 100 % when it ends. The share of an asset out stays in CASH.
 *   SCORE   a code-computed conviction turned into an exact target in [0, 100]. Its variants
 *           are pre-registered later; this module only carries the contract.
 */

/** Bearish, as production's controller counts it — and as arbitrated on 17/10. */
export const BEARISH_REGIMES: ReadonlySet<AssetRegime> = new Set<AssetRegime>(['trend_down', 'reversal_down']);

/** Confirmed and actionable: the sticky walk has three identical observed bars of it. */
export function confirmedBearish(sticky: StickyPoint | null): boolean {
  return sticky != null && sticky.actionable && BEARISH_REGIMES.has(sticky.active);
}

/** Bullish, the only labels that end a post-stop bar or a remembered RPA exit (17/10). */
export const BULLISH_REGIMES: ReadonlySet<AssetRegime> = new Set<AssetRegime>(['trend_up', 'reversal_up']);

/**
 * Confirmed and actionable `trend_up` or `reversal_up` — the ONLY state that releases a line
 * barred after a stop and an asset RPA took out.
 *
 * Step 1 released on any confirmed non-bearish regime, `range` included, and that is what made
 * the stop and its re-entry about 90 % of T100's turnover: a line stopped in a transition was
 * bought back as soon as `range` confirmed, and stopped again at the next transition. Frozen
 * after step 1, before any SCORE run and before the internal verification was opened.
 */
export function confirmedBullish(sticky: StickyPoint | null): boolean {
  return sticky != null && sticky.actionable && BULLISH_REGIMES.has(sticky.active);
}

export interface PolicyInput {
  point: RegimePoint;
  /** The assets this policy took out and still remembers as out (RPA). Engine state. */
  excludedBefore: ReadonlySet<string>;
  /** Sticky state per TRADABLE asset at this bar. */
  sticky: Readonly<Record<string, StickyPoint | null>>;
  /** For SCORE: the components at this bar, already causal. Absent for the simple rules. */
  score?: number | null;
}

export interface PolicyDecision {
  /** Total exposure target, in [0, 100]. */
  totalTargetPercent: number;
  /**
   * Lines the policy takes out (to 0, share to cash), and the memory the engine carries to the
   * next bar. Empty except for RPA.
   */
  excluded: ReadonlySet<string>;
}

export interface Policy {
  readonly name: string;
  /** Whether the gate is told about the confirmed risk_off. False ONLY for T100. */
  readonly gateSeesRiskOff: boolean;
  /**
   * The rebalancing threshold on TOTAL exposure, in points (protocol v1.3, point 7). A new
   * total target replaces the last applied one only when it moves by at least this much.
   * Distinct from the 2 % per-line plumbing floor, which production applies at execution.
   * Zero for the simple rules: their target only ever takes 0 or 100.
   */
  readonly rebalanceThresholdPoints: number;
  decide(input: PolicyInput): PolicyDecision;
}

const NONE: ReadonlySet<string> = new Set();

export const T100: Policy = Object.freeze({
  name: 'T100',
  gateSeesRiskOff: false,
  rebalanceThresholdPoints: 0,
  decide: (): PolicyDecision => ({ totalTargetPercent: 100, excluded: NONE }),
});

export const R100_0: Policy = Object.freeze({
  name: 'R100/0',
  gateSeesRiskOff: true,
  rebalanceThresholdPoints: 0,
  decide: ({ point }: PolicyInput): PolicyDecision => ({
    totalTargetPercent: point.global.riskOff ? 0 : 100,
    excluded: NONE,
  }),
});

export const RPA: Policy = Object.freeze({
  name: 'RPA',
  gateSeesRiskOff: true,
  rebalanceThresholdPoints: 0,
  decide: ({ point, sticky, excludedBefore }: PolicyInput): PolicyDecision => {
    // The memory is updated on EVERY bar, risk_off included: a bearish confirmation seen while
    // the book is flat for the global exit is still an exit the asset must earn its way back from.
    const excluded = new Set<string>();
    for (const [asset, s] of Object.entries(sticky)) {
      const remembered = excludedBefore.has(asset) && !confirmedBullish(s);
      if (remembered || confirmedBearish(s)) excluded.add(asset);
    }
    return { totalTargetPercent: point.global.riskOff ? 0 : 100, excluded };
  },
});

/**
 * A CONSTANT-TARGET witness — TC44 (amendment of 17/10, after the SCORE variants): the target
 * is fixed, the gate sees the risk_off exactly as the candidate's does, and every constraint
 * (caps, stops, re-entry, freezes, execution) is the engine's. A realised exposure under the
 * target is never compensated.
 */
export function constantPolicy(name: string, targetPercent: number): Policy {
  if (!(targetPercent >= 0 && targetPercent <= 100)) throw new Error(`constant policy ${name}: target outside [0, 100]`);
  return Object.freeze({
    name,
    gateSeesRiskOff: true,
    rebalanceThresholdPoints: 0,
    decide: (): PolicyDecision => ({ totalTargetPercent: targetPercent, excluded: NONE }),
  });
}

/** TC44: SCORE-C-linear's mean realised exposure on the development window, fixed to 6 dp. */
export const TC44_TARGET_PERCENT = 44.226403;
export const TC44: Policy = constantPolicy('TC44', TC44_TARGET_PERCENT);

/**
 * A SCORE policy from a score→target transform. The transform and the threshold are the
 * variant; their values are learned on the development window and frozen (see `score.ts`).
 */
export function scorePolicy(params: {
  name: string;
  toTarget: (score: number) => number;
  rebalanceThresholdPoints: number;
  /** Whether a confirmed global risk_off forces 0 %, as in the simple rules. Part of the variant. */
  riskOffForcesZero: boolean;
}): Policy {
  if (!(params.rebalanceThresholdPoints >= 0 && params.rebalanceThresholdPoints <= 100)) {
    throw new Error(`score policy ${params.name}: rebalance threshold must be in [0, 100]`);
  }
  return Object.freeze({
    name: params.name,
    gateSeesRiskOff: true,
    rebalanceThresholdPoints: params.rebalanceThresholdPoints,
    decide: ({ point, score }: PolicyInput): PolicyDecision => {
      if (params.riskOffForcesZero && point.global.riskOff) return { totalTargetPercent: 0, excluded: NONE };
      // No score at this bar (warm-up): no conviction is not a conviction of zero, and it is
      // not a reason to invent one. The engine then keeps the last applied target.
      if (score == null || !Number.isFinite(score)) return { totalTargetPercent: Number.NaN, excluded: NONE };
      const target = params.toTarget(score);
      if (!(target >= 0 && target <= 100)) throw new Error(`score policy ${params.name}: target ${target} outside [0, 100]`);
      return { totalTargetPercent: target, excluded: NONE };
    },
  });
}

/**
 * The rebalancing threshold, applied. Returns the total target the engine must pursue.
 *
 * `NaN` from the policy means "no reading": the last applied target stands, or 0 on the very
 * first bar (a book that has never decided holds nothing).
 */
export function applyRebalanceThreshold(
  proposed: number,
  lastApplied: number | null,
  thresholdPoints: number,
): number {
  if (!Number.isFinite(proposed)) return lastApplied ?? 0;
  if (lastApplied == null) return proposed;
  // The boundaries 0 and 100 are always reachable: a threshold may delay a move, never make
  // "all out" or "all in" impossible to express.
  if (proposed === 0 || proposed === 100) return proposed;
  return Math.abs(proposed - lastApplied) >= thresholdPoints ? proposed : lastApplied;
}
