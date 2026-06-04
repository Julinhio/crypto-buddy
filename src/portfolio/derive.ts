import { Decimal, ZERO } from '../money.js';
import type { LedgerEntry } from '../persistence/executions.js';

/** Resolves the current market price of an asset (Decimal), or null if unknown. */
export type PriceLookup = (asset: string) => Decimal | null;

export interface PositionView {
  asset: string;
  qty: Decimal;
  avgCost: Decimal;
  /** Price used for valuation — the live price, or avgCost if no live price. */
  price: Decimal;
  /** True when we fell back to avgCost because no live price was available. */
  priceStale: boolean;
  value: Decimal;
  unrealizedPnl: Decimal;
  weightPercent: Decimal;
}

export interface VirtualPortfolio {
  reserveAsset: string;
  startingCapital: Decimal;
  /** Free cash, held in the reserve stable. */
  cash: Decimal;
  positions: PositionView[];
  equity: Decimal;
  deployedPercent: Decimal;
  realizedPnl: Decimal;
  unrealizedPnl: Decimal;
  totalPnl: Decimal;
}

// Quantities below this are treated as a fully-closed position (float-free, but
// guards against a tiny residual after a round-trip).
const DUST = new Decimal('1e-12');

interface Lot {
  qty: Decimal;
  avgCost: Decimal;
}

/**
 * Derives the whole virtual portfolio by replaying the execution journal in
 * chronological order — the ONLY source of truth.
 *
 * Weighted-average cost: a buy raises qty and blends avgCost with the buy price
 * (fees excluded from cost basis); a sell lowers qty and leaves avgCost
 * untouched. Cash moves by the (fee-inclusive) quote delta of each fill.
 *
 * P&L:
 *   - unrealized = Σ qty · (price − avgCost)
 *   - total      = equity − startingCapital
 *   - realized   = total − unrealized
 * Deriving realized as (total − unrealized) makes every fee — buy and sell —
 * fall out automatically as a realized cost, with no double-counting.
 */
export function derivePortfolio(
  ledger: LedgerEntry[],
  params: { startingCapital: Decimal; reserveAsset: string; priceOf: PriceLookup },
): VirtualPortfolio {
  const { startingCapital, reserveAsset, priceOf } = params;

  let cash = startingCapital;
  const lots = new Map<string, Lot>();

  for (const entry of ledger) {
    const base = entry.symbol.split('/')[0] ?? entry.symbol;
    const lot = lots.get(base) ?? { qty: ZERO, avgCost: ZERO };

    if (entry.baseDelta.gt(0)) {
      // Buy: blend the average cost with this fill's price.
      const newQty = lot.qty.plus(entry.baseDelta);
      lot.avgCost = lot.qty
        .times(lot.avgCost)
        .plus(entry.baseDelta.times(entry.valuationPrice))
        .div(newQty);
      lot.qty = newQty;
    } else {
      // Sell: reduce qty, keep avgCost.
      lot.qty = lot.qty.plus(entry.baseDelta);
      if (lot.qty.lt(DUST.neg())) {
        // A spot position can NEVER be genuinely negative. If the journal
        // produces one, that's a real accounting bug upstream we want to SEE,
        // not silence — so log it loudly, then clamp to 0 so derivation survives.
        console.error(
          `[CRITICAL] ${base}: replaying the journal produced a NEGATIVE position ` +
            `(qty ${lot.qty.toString()}). Spot positions can't go negative — this signals ` +
            `a journal/accounting bug upstream. Clamping to 0; investigate.`,
        );
        lot.qty = ZERO;
        lot.avgCost = ZERO;
      } else if (lot.qty.lte(DUST)) {
        // Fully closed (within dust) → reset, silently (this is normal).
        lot.qty = ZERO;
        lot.avgCost = ZERO;
      }
    }

    lots.set(base, lot);
    cash = cash.plus(entry.quoteDelta);
  }

  // Value the open positions at current prices (or avgCost if a price is missing).
  let deployedValue = ZERO;
  let unrealizedPnl = ZERO;
  const priced: Array<Omit<PositionView, 'weightPercent'>> = [];

  for (const [asset, lot] of lots) {
    if (lot.qty.lte(DUST)) continue;
    const live = priceOf(asset);
    const priceStale = live == null;
    const price = live ?? lot.avgCost;
    const value = lot.qty.times(price);
    const unrealized = lot.qty.times(price.minus(lot.avgCost));
    deployedValue = deployedValue.plus(value);
    unrealizedPnl = unrealizedPnl.plus(unrealized);
    priced.push({
      asset,
      qty: lot.qty,
      avgCost: lot.avgCost,
      price,
      priceStale,
      value,
      unrealizedPnl: unrealized,
    });
  }

  const equity = cash.plus(deployedValue);
  const deployedPercent = equity.gt(0) ? deployedValue.div(equity).times(100) : ZERO;
  const totalPnl = equity.minus(startingCapital);
  const realizedPnl = totalPnl.minus(unrealizedPnl);

  const positions: PositionView[] = priced
    .map((p) => ({
      ...p,
      weightPercent: equity.gt(0) ? p.value.div(equity).times(100) : ZERO,
    }))
    .sort((a, b) => b.value.comparedTo(a.value));

  return {
    reserveAsset,
    startingCapital,
    cash,
    positions,
    equity,
    deployedPercent,
    realizedPnl,
    unrealizedPnl,
    totalPnl,
  };
}
