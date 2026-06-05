import { Decimal, ONE, ZERO } from '../money.js';
import type { Movement } from './movements.js';
import {
  snapQty,
  validateMovement,
  type MovementVerdict,
  type SymbolRules,
} from './symbolRules.js';

/** A movement resolved to its final exchange-admissible quantity + verdict. */
export interface PlannedMovement {
  movement: Movement;
  /** The lot-snapped quantity we will book/submit (already reconciled for buys). */
  snappedQty: Decimal;
  verdict: MovementVerdict;
}

export interface PlanParams {
  /** Authoritative (mainnet) rules per symbol. Must resolve every movement's symbol. */
  rulesOf: (symbol: string) => SymbolRules;
  /** Free cash before this cycle (the reserve stable). */
  cash: Decimal;
  /** Target reserve value the risk wrapper wants kept in cash (equity × reserve%). */
  targetReserve: Decimal;
  feePercent: number;
}

/**
 * Turns this cycle's movements into a snapped, validated, floor-safe plan — the
 * pure core of execution (no network, no I/O), so the cash-floor guarantee can be
 * exercised directly by tests.
 *
 * Snapping is a DOWNWARD truncation. For a lone buy that's already safe (we deploy
 * less, cash stays higher). The dangerous case is a ROTATE, where a sell funds a
 * buy: a truncated sell raises a little less cash than `computeMovements` assumed,
 * while the buy was sized on the pre-truncation cash — and the two stepSizes are
 * independent, so the buy's own truncation may not cover the gap. The result could
 * dip cash below the sacred reserve by up to one notional step.
 *
 * Fix: size the buys on the cash REALLY available after the snapped sells.
 *
 *   1. Snap every sell down; tally the cash the BOOKABLE sells actually raise
 *      (a crumbed/blocked sell won't be booked, so it raises nothing).
 *   2. availableForBuys = cash + realized sell proceeds − targetReserve.
 *   3. Scale every buy by f = min(1, availableForBuys / plannedBuyOutlay) and then
 *      snap down. Total buy outlay ≤ availableForBuys, so cash ends ≥ targetReserve
 *      (≥ the floor) in every case — rotate included — with `computeMovements` and
 *      the risk wrapper untouched.
 */
export function planMovements(movements: Movement[], params: PlanParams): PlannedMovement[] {
  const { rulesOf, cash, targetReserve, feePercent } = params;
  const feeRate = new Decimal(feePercent).div(100);

  // Pass 1 — snap sells; tally the cash only the BOOKABLE (ok) sells will raise.
  const planned = new Map<Movement, PlannedMovement>();
  let realizedSellProceeds = ZERO;
  for (const m of movements) {
    if (m.side !== 'sell') continue;
    const rules = rulesOf(m.symbol);
    const snappedQty = snapQty(m.qty, rules);
    const verdict = validateMovement(snappedQty, m.price, rules);
    if (verdict.kind === 'ok') {
      realizedSellProceeds = realizedSellProceeds.plus(
        snappedQty.times(m.price).times(ONE.minus(feeRate)),
      );
    }
    planned.set(m, { movement: m, snappedQty, verdict });
  }

  // Pass 2 — size the buys on the cash that's REALLY available post-snap.
  const buys = movements.filter((m) => m.side === 'buy');
  // computeMovements deploys exactly `buyBudget` across the buys, and each buy's
  // notional·(1+fee) is its cash outlay, so this sum equals that pre-snap budget.
  const plannedBuyOutlay = buys.reduce(
    (sum, b) => sum.plus(b.notional.times(ONE.plus(feeRate))),
    ZERO,
  );
  const availableForBuys = Decimal.max(cash.plus(realizedSellProceeds).minus(targetReserve), ZERO);
  const scale =
    plannedBuyOutlay.gt(availableForBuys) && plannedBuyOutlay.gt(0)
      ? availableForBuys.div(plannedBuyOutlay)
      : ONE;

  for (const m of buys) {
    const rules = rulesOf(m.symbol);
    const snappedQty = snapQty(m.qty.times(scale), rules);
    planned.set(m, { movement: m, snappedQty, verdict: validateMovement(snappedQty, m.price, rules) });
  }

  // Preserve the original order (sells first, then buys — cash is raised before
  // it's spent, matching computeMovements and the on-exchange sequence).
  return movements.map((m) => planned.get(m)!);
}
