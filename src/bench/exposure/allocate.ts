import { waterfill } from '../../exposure/correct.js';
import type { TransitionGate } from '../../transition/gate.js';

/**
 * FROM A TOTAL TARGET TO PER-LINE WEIGHTS — protocol v1.3, point 7, and nothing else.
 *
 *   1. a stopped line goes to 0; its share is REDISTRIBUTED;
 *   2. a line the policy excludes (RPA, bearish confirmed) goes to 0; its share stays in CASH
 *      (arbitrated 17/10: the exit is a policy decision, not a constraint);
 *   3. a frozen line, a line with no regime, a line with no price keeps its CURRENT weight
 *      (fail-closed, as production's `capabilityOf`);
 *   4. those fixed weights CONSUME the budget, an overweight one included, which compresses
 *      the free lines. A negative budget sends the free lines to 0 and the residual
 *      over-exposure is published, never hidden;
 *   5. the remaining budget is poured by production's own `waterfill`, in proportion to the
 *      basket, each line up to its cap — or up to its current weight if it may only fall;
 *   6. what finds no room stays in cash, journaled `capacite_insuffisante`.
 *
 * The plumbing floor is NOT applied here. It is applied where production applies it, in
 * `planMovements`, on the leg actually sized at execution — see `execute.ts`. A leg it drops
 * is `reliquat_inexecutable` and is never redistributed a second time.
 */

/** What the bench may do with one line on one bar. */
export type LineState =
  /** `actionable`: either way, up to the cap. */
  | 'free'
  /** `risk_off_reduction`: down only. */
  | 'reduce_only'
  /** `frozen`, `no_regime`, or no price: stays exactly where it is. */
  | 'fixed'
  /** `stop_exit` this bar, or barred from re-entry after a stop: to 0, share redistributed. */
  | 'stopped'
  /** Excluded by the policy (RPA): to 0, share kept in cash. */
  | 'excluded';

export type FixedCause = 'frozen' | 'no_regime' | 'no_price';

export interface AllocLine {
  asset: string;
  /** Weight held, in percent of equity, at the decision's prices. */
  currentPercent: number;
  state: LineState;
  /** Why a `fixed` line is fixed. */
  fixedCause?: FixedCause;
}

/** One line's outcome, journaled per bar. */
export interface AllocatedLine {
  asset: string;
  state: LineState;
  fixedCause: FixedCause | null;
  /** `basket × policy target` — what the line would get if nothing were constrained. */
  nominalPercent: number;
  /** The weight the allocation aims at. For a fixed line: its current weight (a HOLD). */
  targetPercent: number;
  /** True when the line must not trade at all at execution (fixed). */
  hold: boolean;
}

export interface Allocation {
  /** The policy's total exposure target, before any line constraint. */
  policyTargetPercent: number;
  /** `policyTarget × (1 − Σ basket of excluded lines)` — the excluded share is cash by rule. */
  effectiveTargetPercent: number;
  /** Σ weights the fixed lines hold. */
  fixedPercent: number;
  /** `effective − fixed`, before the waterfill. Negative = an imposed overweight. */
  budgetPercent: number;
  /** `max(0, −budget)`: exposure above the effective target that no sale could remove. */
  overExposurePercent: number;
  /** Budget the waterfill could not place: `capacite_insuffisante`. */
  capacityShortfallPercent: number;
  /** Σ of the per-line targets. */
  plannedExposurePercent: number;
  lines: AllocatedLine[];
}

const EPS = 1e-9;

/** Production's gate verdict → the bench's line state, before the bench's own overlays. */
export function stateFromGate(gate: TransitionGate): { state: LineState; fixedCause?: FixedCause } {
  switch (gate) {
    case 'stop_exit':
      return { state: 'stopped' };
    case 'risk_off_reduction':
      return { state: 'reduce_only' };
    case 'frozen':
      return { state: 'fixed', fixedCause: 'frozen' };
    // FAIL-CLOSED, as production's `capabilityOf` and `applyGate`. The PR #36 bench let this
    // line be sold (`NO_REGIME_MAY_REDUCE`); the audit of 17/10 aligned it on production.
    case 'no_regime':
      return { state: 'fixed', fixedCause: 'no_regime' };
    case 'actionable':
      return { state: 'free' };
  }
}

export function allocate(input: {
  policyTargetPercent: number;
  basket: Readonly<Record<string, number>>;
  caps: Readonly<Record<string, number>>;
  lines: readonly AllocLine[];
}): Allocation {
  const { policyTargetPercent, basket, caps, lines } = input;
  if (!(policyTargetPercent >= 0 && policyTargetPercent <= 100)) {
    throw new Error(`bench allocate: policy target ${policyTargetPercent} is outside [0, 100]`);
  }
  const basketSum = lines.reduce((s, l) => s + (basket[l.asset] ?? 0), 0);
  if (Math.abs(basketSum - 100) > 1e-9) {
    throw new Error(`bench allocate: the basket over the lines sums to ${basketSum}, not 100`);
  }

  const nominal = (asset: string): number => (policyTargetPercent * (basket[asset] ?? 0)) / 100;

  // 2. The excluded share is cash by rule — it leaves the target, it is not a constraint.
  const excludedBasket = lines
    .filter((l) => l.state === 'excluded')
    .reduce((s, l) => s + (basket[l.asset] ?? 0), 0);
  const effectiveTargetPercent = (policyTargetPercent * (100 - excludedBasket)) / 100;

  // 3-4. Fixed lines consume the budget at their current weight, whatever it is.
  const fixedPercent = lines.filter((l) => l.state === 'fixed').reduce((s, l) => s + l.currentPercent, 0);
  const budgetPercent = effectiveTargetPercent - fixedPercent;

  const given = new Map<string, number>();
  let capacityShortfallPercent = 0;
  if (budgetPercent > EPS) {
    // 5. The waterfill, on the lines that may still receive weight.
    const candidates = lines
      .filter((l) => l.state === 'free' || l.state === 'reduce_only')
      .map((l) => ({
        asset: l.asset,
        share: basket[l.asset] ?? 0,
        headroom: l.state === 'free' ? Math.max(caps[l.asset] ?? 0, 0) : l.currentPercent,
      }));
    const poured = waterfill(budgetPercent, candidates);
    for (const [asset, points] of poured) given.set(asset, points);
    const placed = [...poured.values()].reduce((s, v) => s + v, 0);
    // 6.
    capacityShortfallPercent = Math.max(0, budgetPercent - placed);
  }

  const out: AllocatedLine[] = lines.map((l) => {
    const base = { asset: l.asset, state: l.state, fixedCause: l.fixedCause ?? null, nominalPercent: nominal(l.asset) };
    switch (l.state) {
      case 'fixed':
        return { ...base, targetPercent: l.currentPercent, hold: true };
      case 'stopped':
      case 'excluded':
        return { ...base, targetPercent: 0, hold: false };
      case 'free':
      case 'reduce_only':
        // A negative or zero budget sends them to zero (4); otherwise the waterfill decides.
        return { ...base, targetPercent: given.get(l.asset) ?? 0, hold: false };
    }
  });

  const plannedExposurePercent = out.reduce((s, l) => s + l.targetPercent, 0);
  return {
    policyTargetPercent,
    effectiveTargetPercent,
    fixedPercent,
    budgetPercent,
    overExposurePercent: Math.max(0, -budgetPercent),
    capacityShortfallPercent,
    plannedExposurePercent,
    lines: out,
  };
}
