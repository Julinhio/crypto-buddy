import { Decimal, ONE, ZERO } from '../money.js';
import type { VirtualPortfolio, PriceLookup } from '../portfolio/derive.js';
import type { ExecutionInsert } from '../persistence/executions.js';
import type { OrderResult } from './testnetOrder.js';

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

// Shared empty testnet-trace fields for an intent row (states 2-4 live on the
// separate execution row, written after the exchange responds).
const NO_TRACE = {
  submitted_qty: null,
  submitted_price: null,
  time_in_force: null,
  exchange_avg_price: null,
  execution_outcome: null,
  exchange_order_id: null,
  exchange_status: null,
  exchange_error_code: null,
  raw_response: null,
} as const;

/**
 * The SOVEREIGN booking row (event_type='intent', state 1 = "wanted") for a
 * movement that passed the real (mainnet) validation. The book is mutated by the
 * SNAPPED quantity at the SOVEREIGN price with the MODELED fee — the testnet
 * never enters here. Written BEFORE the exchange call so the intention is durable.
 *
 * notional/fee are recomputed from the snapped qty (not the pre-snap movement)
 * so the booked qty, value and fee stay internally consistent. Snapping only ever
 * trims the qty down, so the cash-floor guarantee from sizing holds a fortiori.
 */
export function bookedIntent(
  m: Movement,
  snappedQty: Decimal,
  decisionId: number,
  priceSource: string,
  feePercent: number,
): ExecutionInsert {
  const isBuy = m.side === 'buy';
  const notional = snappedQty.times(m.price);
  const fee = notional.times(new Decimal(feePercent).div(100));
  return {
    decision_id: decisionId,
    event_type: 'intent',
    intent_execution_id: null,
    symbol: m.symbol,
    side: m.side,
    requested_qty: m.qty,
    rounded_qty: snappedQty,
    executed_qty: snappedQty, // the sovereign booked qty — the book moves by this
    valuation_price: m.price,
    price_source: priceSource,
    fee,
    // Ledger effect: buy removes (notional + fee) cash and adds qty; sell adds
    // (notional − fee) cash and removes qty.
    ledger_base_delta: isBuy ? snappedQty : snappedQty.neg(),
    ledger_quote_delta: isBuy ? notional.plus(fee).neg() : notional.minus(fee),
    validation_status: 'executed',
    validation_reason: 'sovereign booking — passed the real (mainnet) order filters',
    ...NO_TRACE,
  };
}

/**
 * A NON-booked intent row: the movement was inadmissible against the real
 * filters, so the ledger is left intact (deltas = 0) and no order is sent.
 *   - status='rejected' → a crumb (below the actionable threshold): a clean no-op.
 *   - status='failed'   → an unexpected block (e.g. qty above maxQty).
 * Journaling it keeps "what the AI wanted but we couldn't do" in the audit trail.
 */
export function rejectedIntent(
  m: Movement,
  snappedQty: Decimal,
  decisionId: number,
  priceSource: string,
  status: 'rejected' | 'failed',
  reason: string,
): ExecutionInsert {
  return {
    decision_id: decisionId,
    event_type: 'intent',
    intent_execution_id: null,
    symbol: m.symbol,
    side: m.side,
    requested_qty: m.qty,
    rounded_qty: snappedQty,
    executed_qty: ZERO, // nothing booked
    valuation_price: m.price,
    price_source: priceSource,
    fee: ZERO,
    ledger_base_delta: ZERO, // the book is NOT touched
    ledger_quote_delta: ZERO,
    validation_status: status,
    validation_reason: reason,
    ...NO_TRACE,
  };
}

/**
 * The TESTNET trace row (event_type='execution', states 2-3-4 = submitted /
 * accepted / executed) for a booked intent. It NEVER affects the ledger
 * (ledger_* = 0) — the partial/zero/rejected testnet result is information only.
 * Links back to its intent via intent_execution_id. Written AFTER the exchange
 * responds.
 */
export function executionTrace(
  m: Movement,
  snappedQty: Decimal,
  intentId: number,
  decisionId: number,
  result: OrderResult,
): ExecutionInsert {
  return {
    decision_id: decisionId,
    event_type: 'execution',
    intent_execution_id: intentId,
    symbol: m.symbol,
    side: m.side,
    requested_qty: m.qty, // the sovereign qty (NOT NULL column); context for the trace
    rounded_qty: snappedQty,
    executed_qty: result.executedQty, // the REAL testnet fill
    valuation_price: m.price, // carry the sovereign price (NOT NULL; the testnet price is bogus)
    price_source: 'binance-testnet-order',
    fee: ZERO, // the modeled fee lives on the intent; the testnet fee is not booked
    ledger_base_delta: ZERO, // a trace NEVER moves the book
    ledger_quote_delta: ZERO,
    validation_status: null, // execution rows use execution_outcome, not validation_status
    validation_reason: null,
    submitted_qty: result.submittedQty,
    submitted_price: result.submittedPrice,
    time_in_force: result.timeInForce,
    exchange_avg_price: result.avgPrice,
    execution_outcome: result.outcome,
    exchange_order_id: result.orderId,
    exchange_status: result.status,
    exchange_error_code: result.errorCode,
    raw_response: result.raw,
  };
}
