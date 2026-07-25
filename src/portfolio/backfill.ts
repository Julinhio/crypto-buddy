import { Decimal, ZERO } from '../money.js';
import type { PositionState } from './lifecycle.js';

/**
 * The PURE half of the one-time `position_state` backfill (mandate §9).
 *
 * Split out from the script that runs it so importing this logic — from a test, or
 * from anywhere else — cannot execute a migration. A test that writes to the live
 * database by merely importing a module is exactly the accident this separation
 * prevents.
 *
 * Two rules the mandate makes imperative, because the bot keeps trading while the V2
 * is being built:
 *
 *  1. The peak is computed AT MIGRATION TIME from the history available at that
 *     instant. No value is hardcoded — the illustrative table in the mandate is a
 *     feasibility check, not an input, and it will have moved by the time this runs.
 *  2. The history starts at the LAST zero → positive transition of each position, not
 *     at the beginning of the table. A line sold off and bought back would otherwise
 *     inherit the peak of a previous life.
 */

/** One booked fill from the sovereign journal. */
export interface Fill {
  at: string;
  asset: string;
  baseDelta: Decimal;
  price: Decimal;
}

/** One spot price the bot recorded in a cycle's market context. */
export interface ObservedPrice {
  at: string;
  price: Decimal;
}

const DUST = new Decimal('1e-12');

/**
 * The state of one asset, derived from the history available right now.
 *
 * Pure, so both rules above are testable without a database — which matters more than
 * usual here: this code runs exactly once, and a mistake is not something a later
 * cycle corrects. A live bug gets fixed by the next wake-up; a backfill bug is baked
 * into the state forever.
 */
export function backfillOne(asset: string, fills: Fill[], observed: ObservedPrice[]): PositionState {
  const mine = fills.filter((f) => f.asset === asset);

  // Walk the journal to find the LAST zero → positive transition and the final qty.
  let qty = ZERO;
  let entryDate: string | null = null;
  for (const f of mine) {
    const before = qty;
    qty = qty.plus(f.baseDelta);
    if (before.lte(DUST) && qty.gt(DUST)) entryDate = f.at; // a NEW life starts here
  }

  const last = mine[mine.length - 1];
  const lastMove = last
    ? {
        at: last.at,
        side: (last.baseDelta.gt(0) ? 'buy' : 'sell') as 'buy' | 'sell',
        notional: last.baseDelta.abs().times(last.price),
      }
    : null;

  // Flat today → no life, no peak. Nothing for a future entry to inherit.
  if (qty.lte(DUST) || entryDate == null) {
    return {
      asset,
      entryDate: null,
      peakPriceSinceEntry: null,
      lastSignificantMoveAt: lastMove?.at ?? null,
      lastSignificantMoveSide: lastMove?.side ?? null,
      lastSignificantMoveNotional: lastMove?.notional ?? null,
      qty: ZERO,
      thesis: null,
      invalidation: null,
      thesisUpdatedAt: null,
    };
  }

  // The highest unit price seen SINCE that entry, from both sources the bot really
  // observed: the spot price in each cycle's market context, and the valuation price
  // of each booked fill. Sampling the backfill from one source and the live ratchet
  // from the other would make the peak jump on the day of the switch.
  const since = Date.parse(entryDate);
  let peak: Decimal | null = null;
  const consider = (price: Decimal): void => {
    if (peak == null || price.gt(peak)) peak = price;
  };
  for (const o of observed) if (Date.parse(o.at) >= since) consider(o.price);
  for (const f of mine) if (Date.parse(f.at) >= since) consider(f.price);

  return {
    asset,
    entryDate,
    peakPriceSinceEntry: peak,
    lastSignificantMoveAt: lastMove?.at ?? null,
    lastSignificantMoveSide: lastMove?.side ?? null,
    lastSignificantMoveNotional: lastMove?.notional ?? null,
    qty,
    thesis: null,
    invalidation: null,
    thesisUpdatedAt: null,
  };
}
