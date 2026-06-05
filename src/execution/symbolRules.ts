import type { Exchange } from 'ccxt';
import { Decimal, ZERO } from '../money.js';

/**
 * The order filters that actually gate a movement, read straight from the
 * exchange's `exchangeInfo` (the AUTHORITATIVE source — we don't trust a derived
 * abstraction for the accounting-critical checks). All money/qty in `Decimal`.
 *
 * A value of 0 means "rule disabled" (Binance's own convention: any filter field
 * set to 0 is off), so the snap/validate helpers treat 0 as no-constraint.
 *
 * The PERCENT_PRICE_BY_SIDE multipliers are only needed when we PRICE a
 * marketable order against an exchange's own book (the testnet); they bound how
 * far past the reference price the submitted price may sit. Null when the symbol
 * has no such filter.
 */
export interface SymbolRules {
  symbol: string;
  // LOT_SIZE
  stepSize: Decimal;
  minQty: Decimal;
  maxQty: Decimal; // 0 = no max
  // PRICE_FILTER
  tickSize: Decimal;
  // NOTIONAL / MIN_NOTIONAL — the "actionable threshold" for a LIMIT order
  minNotional: Decimal; // 0 = no min
  // PERCENT_PRICE_BY_SIDE (price band, relative to the reference price)
  bidMultiplierUp: Decimal | null;
  bidMultiplierDown: Decimal | null;
  askMultiplierUp: Decimal | null;
  askMultiplierDown: Decimal | null;
}

type RawFilter = Record<string, unknown>;

function decOr(value: unknown, fallback: Decimal): Decimal {
  if (value == null || value === '') return fallback;
  try {
    const d = new Decimal(value as Decimal.Value);
    return d.isFinite() ? d : fallback;
  } catch {
    return fallback;
  }
}

function decOrNull(value: unknown): Decimal | null {
  if (value == null || value === '') return null;
  try {
    const d = new Decimal(value as Decimal.Value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Loads the authoritative order filters for `symbol` from `client`. Pass the
 * PUBLIC MAINNET client to get the rules that govern our SOVEREIGN validation
 * and accounting; pass the TESTNET client to get the rules that govern what we
 * may SUBMIT there (the price band differs because the testnet price decouples).
 *
 * `loadMarkets()` is idempotent and cached on the ccxt instance, so calling this
 * per symbol is cheap after the first hit.
 */
export async function loadSymbolRules(client: Exchange, symbol: string): Promise<SymbolRules> {
  await client.loadMarkets();
  const market = client.market(symbol);
  const info = (market.info ?? {}) as { filters?: RawFilter[] };
  const filters = info.filters ?? [];
  const byType = (t: string): RawFilter | undefined =>
    filters.find((f) => (f as { filterType?: string }).filterType === t);

  const lot = byType('LOT_SIZE');
  const price = byType('PRICE_FILTER');
  // Modern symbols use NOTIONAL; older ones MIN_NOTIONAL. Both expose minNotional.
  const notional = byType('NOTIONAL') ?? byType('MIN_NOTIONAL');
  const pct = byType('PERCENT_PRICE_BY_SIDE');

  return {
    symbol,
    stepSize: decOr(lot?.stepSize, ZERO),
    minQty: decOr(lot?.minQty, ZERO),
    maxQty: decOr(lot?.maxQty, ZERO),
    tickSize: decOr(price?.tickSize, ZERO),
    minNotional: decOr(notional?.minNotional, ZERO),
    bidMultiplierUp: decOrNull(pct?.bidMultiplierUp),
    bidMultiplierDown: decOrNull(pct?.bidMultiplierDown),
    askMultiplierUp: decOrNull(pct?.askMultiplierUp),
    askMultiplierDown: decOrNull(pct?.askMultiplierDown),
  };
}

/** Snap a quantity DOWN to a whole multiple of stepSize (LOT_SIZE). */
export function snapQty(qty: Decimal, rules: SymbolRules): Decimal {
  if (rules.stepSize.lte(0)) return qty;
  return qty.div(rules.stepSize).floor().times(rules.stepSize);
}

/** Snap a price to a whole multiple of tickSize (PRICE_FILTER), rounding mode chosen. */
export function snapPrice(
  price: Decimal,
  rules: SymbolRules,
  mode: 'floor' | 'ceil' = 'floor',
): Decimal {
  if (rules.tickSize.lte(0)) return price;
  const steps = price.div(rules.tickSize);
  const rounded = mode === 'ceil' ? steps.ceil() : steps.floor();
  return rounded.times(rules.tickSize);
}

export type MovementVerdict =
  | { kind: 'ok' }
  | { kind: 'crumb'; reason: string } // below the actionable threshold — clean no-op
  | { kind: 'block'; reason: string }; // genuinely inadmissible — unexpected

/**
 * Validates a snapped movement against the AUTHORITATIVE (mainnet) filters, using
 * our SOVEREIGN price as the economic reference. This verdict — and ONLY this one
 * — decides whether the sovereign ledger books the movement.
 *
 *   - 'crumb' : too small to be actionable (below min-notional or minQty, or
 *     snapped away to nothing). A clean no-op — skip, don't escalate.
 *   - 'block' : inadmissible for an unexpected reason (qty above maxQty). We
 *     don't book and don't send; the gap stays for the next cycle.
 */
export function validateMovement(
  snappedQty: Decimal,
  sovereignPrice: Decimal,
  rules: SymbolRules,
): MovementVerdict {
  if (snappedQty.lte(0)) {
    return { kind: 'crumb', reason: 'quantity snapped to zero at the lot step' };
  }
  if (rules.minQty.gt(0) && snappedQty.lt(rules.minQty)) {
    return {
      kind: 'crumb',
      reason: `qty ${snappedQty.toString()} < minQty ${rules.minQty.toString()} (LOT_SIZE)`,
    };
  }
  const notional = snappedQty.times(sovereignPrice);
  if (rules.minNotional.gt(0) && notional.lt(rules.minNotional)) {
    return {
      kind: 'crumb',
      reason: `notional ${notional.toFixed(2)} < minNotional ${rules.minNotional.toString()}`,
    };
  }
  if (rules.maxQty.gt(0) && snappedQty.gt(rules.maxQty)) {
    return {
      kind: 'block',
      reason: `qty ${snappedQty.toString()} > maxQty ${rules.maxQty.toString()} (LOT_SIZE)`,
    };
  }
  return { kind: 'ok' };
}
