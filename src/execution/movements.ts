import { Decimal, ONE, ZERO } from '../money.js';
import type { VirtualPortfolio, PriceLookup } from '../portfolio/derive.js';
import type { ExecutionInsert } from '../persistence/executions.js';

export interface Movement {
  symbol: string; // trading pair, e.g. 'BTC/USDT'
  asset: string; // base asset, e.g. 'BTC'
  side: 'buy' | 'sell';
  qty: Decimal;
  price: Decimal;
  notional: Decimal; // |target − current| in quote (USDT)
  fee: Decimal;
}

// Below this notional there's effectively nothing to do — skip the movement.
// This is just float/dust noise, NOT the exchange's min-notional filter (PR B).
const DUST_NOTIONAL = new Decimal('0.01');

interface Leg {
  asset: string;
  price: Decimal;
  grossDelta: Decimal; // |target − current| in quote (USDT)
}

/**
 * Computes the movements that would take the virtual portfolio from its current
 * state to the bounded allocation, sized on the virtual book (equity at real
 * prices). Pure calculation — nothing is placed.
 *
 * Fees are absorbed by the COIN (deployed) side, never the sacred cash reserve,
 * so the cash floor holds after the fills for ANY rebalance and ANY config.
 * Two passes make this robust without special cases:
 *
 *   1. SELLS — sell exactly down to the target (notional = current − target).
 *      Since target ≥ 0, this is always ≤ what we hold, so we never over-sell
 *      (no impossible fill, no negative position). The fee comes out of proceeds.
 *   2. BUYS — deploy only the cash that sits ABOVE the target reserve
 *      (buyBudget = cash-after-sells − targetReserve), split across the buys.
 *      That budget already nets out every sell fee, so all fees land on the coin
 *      side and cash ends at exactly its target %: cash% = appliedReserve% ·
 *      (equity_before / equity_after) ≥ appliedReserve% ≥ floor.
 */
export function computeMovements(
  portfolio: VirtualPortfolio,
  appliedAllocation: Record<string, number>,
  priceOf: PriceLookup,
  feePercent: number,
): Movement[] {
  const equity = portfolio.equity;
  const reserve = portfolio.reserveAsset;
  const feeRate = new Decimal(feePercent).div(100);

  const currentValue = new Map<string, Decimal>();
  for (const p of portfolio.positions) currentValue.set(p.asset, p.value);

  // Split the coins into sells and buys (the reserve/cash is never traded).
  const sells: Leg[] = [];
  const buys: Leg[] = [];
  for (const [asset, pct] of Object.entries(appliedAllocation)) {
    if (asset === reserve) continue;

    const targetValue = equity.times(pct).div(100);
    const current = currentValue.get(asset) ?? ZERO;
    const deltaValue = targetValue.minus(current);
    if (deltaValue.abs().lt(DUST_NOTIONAL)) continue;

    const price = priceOf(asset);
    if (price == null || price.lte(0)) {
      console.warn(`[warn] no live price for ${asset} — cannot size its movement this cycle, skipping.`);
      continue;
    }
    (deltaValue.gt(0) ? buys : sells).push({ asset, price, grossDelta: deltaValue.abs() });
  }

  const movements: Movement[] = [];

  // Pass 1 — sells to target (≤ holdings by construction; fee from proceeds).
  let cashFromSells = ZERO;
  for (const s of sells) {
    const notional = s.grossDelta; // coin value to remove
    const fee = notional.times(feeRate);
    cashFromSells = cashFromSells.plus(notional.minus(fee));
    movements.push({
      symbol: `${s.asset}/${reserve}`,
      asset: s.asset,
      side: 'sell',
      qty: notional.div(s.price),
      price: s.price,
      notional,
      fee,
    });
  }

  // Pass 2 — buys deploy the cash above the target reserve (absorbs all fees).
  const targetReserve = equity.times(appliedAllocation[reserve] ?? 0).div(100);
  const buyBudget = Decimal.max(portfolio.cash.plus(cashFromSells).minus(targetReserve), ZERO);
  const totalBuyGross = buys.reduce((sum, b) => sum.plus(b.grossDelta), ZERO);

  if (totalBuyGross.gt(0) && buyBudget.gt(0)) {
    for (const b of buys) {
      const cashOutlay = buyBudget.times(b.grossDelta).div(totalBuyGross); // share incl. fee
      if (cashOutlay.lt(DUST_NOTIONAL)) continue;
      const notional = cashOutlay.div(ONE.plus(feeRate)); // coin value bought
      const fee = notional.times(feeRate);
      movements.push({
        symbol: `${b.asset}/${reserve}`,
        asset: b.asset,
        side: 'buy',
        qty: notional.div(b.price),
        price: b.price,
        notional,
        fee,
      });
    }
  }

  return movements;
}

/**
 * Turns this cycle's movements into MODELED-fill journal rows (paper trading):
 * the wanted qty, fully filled at the real price, with the modeled fee. No
 * exchange order is placed — the exchange_* columns stay null until PR B.
 */
export function toModeledFills(
  movements: Movement[],
  decisionId: number,
  priceSource: string,
): ExecutionInsert[] {
  return movements.map((m) => {
    const isBuy = m.side === 'buy';
    return {
      decision_id: decisionId,
      symbol: m.symbol,
      side: m.side,
      requested_qty: m.qty,
      rounded_qty: m.qty, // no exchange step rounding in PR A
      executed_qty: m.qty, // modeled full fill
      valuation_price: m.price,
      price_source: priceSource,
      fee: m.fee,
      // Ledger effect: buy removes (notional + fee) cash and adds qty; sell adds
      // (notional − fee) cash and removes qty.
      ledger_base_delta: isBuy ? m.qty : m.qty.neg(),
      ledger_quote_delta: isBuy ? m.notional.plus(m.fee).neg() : m.notional.minus(m.fee),
      validation_status: 'executed',
      validation_reason: 'modeled fill (paper trading; no exchange order placed)',
      exchange_order_id: null,
      exchange_status: null,
      exchange_error_code: null,
      raw_response: null,
    };
  });
}
