import { Exchange, ExchangeError, NetworkError } from 'ccxt';
import { Decimal, ONE, ZERO } from '../money.js';
import { loadSymbolRules, snapPrice, type SymbolRules } from './symbolRules.js';

export type OrderOutcome = 'filled' | 'partial' | 'unfilled' | 'rejected' | 'error';

/**
 * The normalized result of one testnet order attempt — the raw material for the
 * `execution` trace row (states 2-3-4). It NEVER feeds the sovereign ledger.
 */
export interface OrderResult {
  outcome: OrderOutcome;
  orderId: string | null;
  status: string | null; // raw exchange/ccxt status
  submittedQty: Decimal | null; // state 2 — what we actually sent
  submittedPrice: Decimal | null; // the marketable LIMIT price sent
  timeInForce: string; // always 'IOC' here
  executedQty: Decimal; // state 4 — real testnet fill (0 if none)
  avgPrice: Decimal | null; // testnet avg fill price (trace only)
  errorCode: string | null;
  raw: unknown; // ccxt order info or error detail, for the journal
}

const TIF = 'IOC';
// How far past the touch we price the marketable limit, to cross the spread
// without leaning on PERCENT_PRICE_BY_SIDE (10 bps — well within Binance's band).
const CROSS_BUFFER = new Decimal('0.001');
const DUST = new Decimal('1e-12');

function extractErrorCode(message: string): string | null {
  const m = message.match(/"code":\s*(-?\d+)/);
  return m?.[1] ?? null;
}

function bestOf(side: 'bid' | 'ask', book: { bids: number[][]; asks: number[][] }): Decimal | null {
  const levels = side === 'bid' ? book.bids : book.asks;
  const top = levels?.[0]?.[0];
  return typeof top === 'number' && Number.isFinite(top) && top > 0 ? new Decimal(top) : null;
}

/**
 * Prices a LIMIT that crosses the TESTNET spread so an IOC fills immediately,
 * clamped inside the symbol's PERCENT_PRICE_BY_SIDE band (referenced to the
 * testnet mid) so the testnet can't reject the price itself. Returns null when
 * the book gives us nothing to price against.
 */
export function marketableLimitPrice(
  side: 'buy' | 'sell',
  book: { bids: number[][]; asks: number[][] },
  lastPrice: Decimal | null,
  rules: SymbolRules,
): Decimal | null {
  const bid = bestOf('bid', book);
  const ask = bestOf('ask', book);
  const ref = bid && ask ? bid.plus(ask).div(2) : lastPrice;

  if (side === 'buy') {
    const base = ask ?? lastPrice ?? ref;
    if (!base) return null;
    let raw = base.times(ONE.plus(CROSS_BUFFER));
    if (rules.bidMultiplierUp && ref) {
      raw = Decimal.min(raw, ref.times(rules.bidMultiplierUp));
    }
    const snapped = snapPrice(raw, rules, 'floor');
    return snapped.gt(0) ? snapped : raw; // never return 0 if the tick floored it away
  }

  const base = bid ?? lastPrice ?? ref;
  if (!base) return null;
  let raw = base.times(ONE.minus(CROSS_BUFFER));
  if (rules.askMultiplierDown && ref) {
    raw = Decimal.max(raw, ref.times(rules.askMultiplierDown));
  }
  return snapPrice(raw, rules, 'ceil');
}

function classifyFill(executed: Decimal, submitted: Decimal): OrderOutcome {
  if (executed.gte(submitted.minus(DUST)) && executed.gt(0)) return 'filled';
  if (executed.gt(DUST)) return 'partial';
  return 'unfilled';
}

/**
 * Places ONE marketable LIMIT IOC on the testnet for an already lot-snapped
 * quantity. The qty comes from the sovereign world (we never recompute it from
 * testnet prices); only the PRICE is derived from the testnet book, purely to
 * obtain an immediate execution trace.
 *
 * Resilient by contract: any failure is captured as an OrderResult (outcome
 * 'rejected' for an exchange refusal, 'error' for a technical failure), never
 * thrown — because the sovereign intent is already booked and a testnet hiccup
 * must not corrupt the run.
 */
export async function placeMarketableIoc(
  testnet: Exchange,
  symbol: string,
  side: 'buy' | 'sell',
  snappedQty: Decimal,
  clientOrderId: string,
): Promise<OrderResult> {
  const base: Omit<OrderResult, 'outcome' | 'raw'> = {
    orderId: null,
    status: null,
    submittedQty: null,
    submittedPrice: null,
    timeInForce: TIF,
    executedQty: ZERO,
    avgPrice: null,
    errorCode: null,
  };

  try {
    // Testnet rules govern what we may SUBMIT there (tick + price band), distinct
    // from the mainnet rules that govern accounting.
    const rules = await loadSymbolRules(testnet, symbol);

    let lastPrice: Decimal | null = null;
    let book: { bids: number[][]; asks: number[][] } = { bids: [], asks: [] };
    try {
      const ob = await testnet.fetchOrderBook(symbol, 5);
      book = { bids: (ob.bids as number[][]) ?? [], asks: (ob.asks as number[][]) ?? [] };
    } catch {
      // Fall back to the ticker's last price below.
    }
    try {
      const ticker = await testnet.fetchTicker(symbol);
      if (typeof ticker.last === 'number' && Number.isFinite(ticker.last)) {
        lastPrice = new Decimal(ticker.last);
      }
    } catch {
      // last stays null; marketableLimitPrice handles the missing-price case.
    }

    const price = marketableLimitPrice(side, book, lastPrice, rules);
    if (!price || price.lte(0)) {
      return {
        ...base,
        outcome: 'error',
        raw: { message: 'could not derive a marketable price from the testnet book/ticker' },
      };
    }

    const submittedQty = new Decimal(testnet.amountToPrecision(symbol, snappedQty.toString()));
    const submittedPrice = new Decimal(testnet.priceToPrecision(symbol, price.toString()));

    const order = await testnet.createOrder(symbol, 'limit', side, submittedQty.toNumber(), submittedPrice.toNumber(), {
      timeInForce: TIF,
      // The exchange-side half of the idempotency: ccxt maps `clientOrderId` to
      // Binance's `newClientOrderId`, so a RESEND of the same movement's order is
      // deduped at Binance too. Best-effort (Binance's dedup window doesn't cover an
      // already-closed IOC) — the reliable guarantee is the booking gate upstream,
      // which never even attempts a second order for an already-booked movement.
      clientOrderId,
    });

    const filled =
      typeof order.filled === 'number' && Number.isFinite(order.filled)
        ? new Decimal(order.filled)
        : ZERO;
    const avg =
      typeof order.average === 'number' && Number.isFinite(order.average)
        ? new Decimal(order.average)
        : null;

    return {
      ...base,
      orderId: order.id != null ? String(order.id) : null,
      status: order.status != null ? String(order.status) : null,
      submittedQty,
      submittedPrice,
      executedQty: filled,
      avgPrice: avg,
      outcome: classifyFill(filled, submittedQty),
      raw: order.info ?? order,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // An exchange refusal (filter, notional, lot…) is an OPERATIONAL artifact of
    // the testnet — it never corrects the sovereign booking. A NetworkError is a
    // technical failure. Both are traced, neither touches the ledger.
    const outcome: OrderOutcome =
      err instanceof ExchangeError && !(err instanceof NetworkError) ? 'rejected' : 'error';
    return {
      ...base,
      outcome,
      errorCode: extractErrorCode(message),
      raw: { message, code: extractErrorCode(message) },
    };
  }
}
