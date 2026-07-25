import { Decimal, ZERO } from '../money.js';
import type { LedgerEntry } from '../persistence/executions.js';
import type { PriceLookup, VirtualPortfolio } from './derive.js';

/**
 * POSITION LIFECYCLE — the state each position carries between cycles.
 *
 * The mandate is unambiguous that this is STATE, not a derivation: "c'est stocké et
 * écrit à chaque cycle, jamais reconstruit à l'exécution". Reconstructing at read time
 * is what was paid for in June with the V2 snapshots, and it is not repeated here.
 *
 * This module is the PURE half: given what the state was, what the book holds now and
 * what booked this cycle, it says what the state becomes. No I/O, so every rule below
 * is directly testable — and the rules are the load-bearing part, not the SQL.
 *
 * STRICT OWNERSHIP. The code owns `entryDate`, `peakPriceSinceEntry` and
 * `lastSignificantMove`; the model owns `thesis` and `invalidation`. This function
 * never touches the model's fields except to CLEAR them on a full exit — a thesis
 * about a position that no longer exists is not a thesis.
 */

/** Quantities at or below this count as flat (mirrors derive.ts's dust handling). */
const DUST = new Decimal('1e-12');

export interface PositionState {
  asset: string;
  /** Most recent zero → positive transition. Null while flat. */
  entryDate: string | null;
  /** Highest UNIT PRICE since entryDate. Null while flat, or until a price is seen. */
  peakPriceSinceEntry: Decimal | null;
  lastSignificantMoveAt: string | null;
  lastSignificantMoveSide: 'buy' | 'sell' | null;
  lastSignificantMoveNotional: Decimal | null;
  /** Quantity at the last write — how the NEXT cycle detects a transition. */
  qty: Decimal;
  thesis: string | null;
  invalidation: string | null;
  thesisUpdatedAt: string | null;
}

export interface LifecycleInputs {
  asset: string;
  /** The state as last written, or null when the asset has never had one. */
  previous: PositionState | null;
  /** Quantity held AFTER this cycle's bookings. */
  qty: Decimal;
  /** Live unit price, or null when unavailable (never fall back to avgCost here). */
  price: Decimal | null;
  /** What booked on this asset this cycle, if anything. */
  booked: { side: 'buy' | 'sell'; notional: Decimal } | null;
  /** This cycle's timestamp, ISO. */
  now: string;
}

const flat = (qty: Decimal): boolean => qty.lte(DUST);

/**
 * The state after this cycle. Four cases, and the interesting ones are the two that
 * the mandate spells out because they are easy to get wrong:
 *
 *  - a REINFORCEMENT or a PARTIAL TRIM leaves the peak and the entry date alone. The
 *    peak is a price, so a trim cannot lower it, and the position's life did not
 *    restart. The thesis survives too — a partial trim does not invalidate it.
 *  - a FULL EXIT ends the life: entry, peak and thesis are cleared TOGETHER, so a
 *    later re-entry cannot inherit anything from the previous life.
 */
export function nextPositionState(input: LifecycleInputs): PositionState {
  const { asset, previous, qty, price, booked, now } = input;

  const move = booked
    ? { at: now, side: booked.side, notional: booked.notional }
    : {
        at: previous?.lastSignificantMoveAt ?? null,
        side: previous?.lastSignificantMoveSide ?? null,
        notional: previous?.lastSignificantMoveNotional ?? null,
      };

  // 1. Flat now — the line's life is over. Entry, peak and thesis go together: a
  //    thesis about a position that no longer exists is not a thesis, and a peak kept
  //    across a re-entry is the "previous life" bug the mandate names explicitly.
  if (flat(qty)) {
    return {
      asset,
      entryDate: null,
      peakPriceSinceEntry: null,
      lastSignificantMoveAt: move.at,
      lastSignificantMoveSide: move.side,
      lastSignificantMoveNotional: move.notional,
      qty: ZERO,
      thesis: null,
      invalidation: null,
      thesisUpdatedAt: null,
    };
  }

  const wasFlat = previous == null || flat(previous.qty);

  // 2. Zero → positive: a NEW life. Entry is now, and the peak starts at today's
  //    price rather than at anything the asset did before.
  if (wasFlat) {
    return {
      asset,
      entryDate: now,
      peakPriceSinceEntry: price,
      lastSignificantMoveAt: move.at,
      lastSignificantMoveSide: move.side,
      lastSignificantMoveNotional: move.notional,
      qty,
      thesis: null,
      invalidation: null,
      thesisUpdatedAt: null,
    };
  }

  // 3. Still open — the peak only ever ratchets UP, and only on a real price. A stale
  //    price must not touch it: falling back to avgCost (as the valuation path does)
  //    would silently rewrite the high-water mark with a cost basis.
  const peak =
    price == null
      ? previous.peakPriceSinceEntry
      : previous.peakPriceSinceEntry == null
        ? price
        : Decimal.max(previous.peakPriceSinceEntry, price);

  return {
    asset,
    entryDate: previous.entryDate ?? now,
    peakPriceSinceEntry: peak,
    lastSignificantMoveAt: move.at,
    lastSignificantMoveSide: move.side,
    lastSignificantMoveNotional: move.notional,
    qty,
    thesis: previous.thesis,
    invalidation: previous.invalidation,
    thesisUpdatedAt: previous.thesisUpdatedAt,
  };
}

/**
 * The states for the WHOLE tradable universe after this cycle.
 *
 * Runs over the configured assets rather than over the held positions, so a line that
 * just went to zero still gets its row updated to "flat" — a position that disappears
 * from the book must not leave a stale entry date and peak behind, which is precisely
 * how a re-entry would inherit a previous life.
 *
 * `booked` is aggregated per asset from THIS cycle's ledger entries: the movement that
 * actually moved the book, not the one that was merely wanted. Since PR 2's 2% floor,
 * every booked movement is significant by construction, so "last booked" and "last
 * significant move" are the same thing — no second threshold to keep in sync.
 */
export function nextPositionStates(params: {
  assets: string[];
  previous: Map<string, PositionState>;
  portfolio: VirtualPortfolio;
  priceOf: PriceLookup;
  bookedLedger: LedgerEntry[];
  now: string;
}): PositionState[] {
  const { assets, previous, portfolio, priceOf, bookedLedger, now } = params;

  const heldQty = new Map<string, Decimal>();
  for (const p of portfolio.positions) heldQty.set(p.asset, p.qty);

  // Net what booked per asset this cycle. A cycle books at most one movement per
  // (asset, side), but netting is the honest way to collapse them either way.
  const booked = new Map<string, { side: 'buy' | 'sell'; notional: Decimal }>();
  for (const entry of bookedLedger) {
    const asset = entry.symbol.split('/')[0];
    if (!asset) continue;
    const notional = entry.baseDelta.abs().times(entry.valuationPrice);
    const side: 'buy' | 'sell' = entry.baseDelta.gt(0) ? 'buy' : 'sell';
    const prior = booked.get(asset);
    booked.set(
      asset,
      prior && prior.side === side ? { side, notional: prior.notional.plus(notional) } : { side, notional },
    );
  }

  return assets.map((asset) =>
    nextPositionState({
      asset,
      previous: previous.get(asset) ?? null,
      qty: heldQty.get(asset) ?? ZERO,
      price: priceOf(asset),
      booked: booked.get(asset) ?? null,
      now,
    }),
  );
}
