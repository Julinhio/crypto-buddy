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

/**
 * Computes the movements that would take the virtual portfolio from its current
 * state to the bounded allocation, sized on the virtual book (equity at real
 * prices). Pure calculation — nothing is placed.
 *
 * Target value per asset = appliedAllocation% × equity. The delta vs the current
 * position value becomes a buy (delta > 0) or sell (delta < 0). The reserve
 * stable (cash) is the residual of all the coin moves and is never traded.
 */
export function computeMovements(
  portfolio: VirtualPortfolio,
  appliedAllocation: Record<string, number>,
  priceOf: PriceLookup,
  feePercent: number,
): Movement[] {
  const equity = portfolio.equity;
  const currentValue = new Map<string, Decimal>();
  for (const p of portfolio.positions) currentValue.set(p.asset, p.value);

  const feeRate = new Decimal(feePercent).div(100);
  const movements: Movement[] = [];

  for (const [asset, pct] of Object.entries(appliedAllocation)) {
    if (asset === portfolio.reserveAsset) continue; // cash is the residual

    const targetValue = equity.times(pct).div(100);
    const current = currentValue.get(asset) ?? ZERO;
    const deltaValue = targetValue.minus(current);
    if (deltaValue.abs().lt(DUST_NOTIONAL)) continue;

    const price = priceOf(asset);
    if (price == null || price.lte(0)) {
      console.warn(`[warn] no live price for ${asset} — cannot size its movement this cycle, skipping.`);
      continue;
    }

    const isBuy = deltaValue.gt(0);
    const grossDelta = deltaValue.abs();
    // Fees come out of the COIN side, never the sacred cash reserve. Sizing a
    // buy net of fees makes its cash outlay (notional + fee) equal the intended
    // move, so the cash floor still holds after fees — the coin just lands a
    // hair under its target. A sell removes exactly the over-target coin value;
    // its fee reduces the cash it returns (cash only rises, so the floor is safe).
    const notional = isBuy ? grossDelta.div(ONE.plus(feeRate)) : grossDelta;
    const fee = notional.times(feeRate);
    movements.push({
      symbol: `${asset}/${portfolio.reserveAsset}`,
      asset,
      side: isBuy ? 'buy' : 'sell',
      qty: notional.div(price),
      price,
      notional,
      fee,
    });
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
