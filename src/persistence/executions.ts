import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, fromNumeric } from '../money.js';

const TABLE = 'executions';

export type ExecutionSide = 'buy' | 'sell';
export type ValidationStatus = 'executed' | 'rejected' | 'failed';
export type EventType = 'intent' | 'execution';
export type ExecutionOutcome = 'filled' | 'partial' | 'unfilled' | 'rejected' | 'error';

/**
 * A row ready to insert. Money fields are Decimal in memory and serialized to
 * exact `numeric` strings at insert time (never float).
 *
 * Two event kinds share this shape (see migration 0005):
 *   - event_type='intent'    — the SOVEREIGN booking. validation_status set;
 *     ledger_* carry the book delta (or 0 when not booked: a crumb/block).
 *   - event_type='execution' — the TESTNET trace. validation_status null,
 *     ledger_* = 0 (never touches the book); the testnet fields are populated.
 */
export interface ExecutionInsert {
  decision_id: number;
  event_type: EventType;
  /** On an execution row, the id of the intent it traces; null on an intent row. */
  intent_execution_id: number | null;
  symbol: string;
  side: ExecutionSide;
  requested_qty: Decimal;
  rounded_qty: Decimal | null;
  executed_qty: Decimal | null;
  valuation_price: Decimal;
  price_source: string;
  fee: Decimal;
  ledger_base_delta: Decimal;
  ledger_quote_delta: Decimal;
  /** Sovereign validation outcome — set on intent rows, null on execution rows. */
  validation_status: ValidationStatus | null;
  validation_reason: string | null;
  // Testnet execution trace (states 2-3-4) — populated on execution rows only.
  submitted_qty: Decimal | null;
  submitted_price: Decimal | null;
  time_in_force: string | null;
  exchange_avg_price: Decimal | null;
  execution_outcome: ExecutionOutcome | null;
  exchange_order_id: string | null;
  exchange_status: string | null;
  exchange_error_code: string | null;
  raw_response: unknown | null;
}

/** The slice of a booked intent the portfolio derivation needs, parsed to Decimal. */
export interface LedgerEntry {
  symbol: string;
  side: ExecutionSide;
  valuationPrice: Decimal;
  baseDelta: Decimal;
  quoteDelta: Decimal;
}

function numeric(value: Decimal | null): string | null {
  return value == null ? null : value.toString();
}

function toPayload(r: ExecutionInsert): Record<string, unknown> {
  return {
    decision_id: r.decision_id,
    event_type: r.event_type,
    intent_execution_id: r.intent_execution_id,
    symbol: r.symbol,
    side: r.side,
    requested_qty: r.requested_qty.toString(),
    rounded_qty: numeric(r.rounded_qty),
    executed_qty: numeric(r.executed_qty),
    valuation_price: r.valuation_price.toString(),
    price_source: r.price_source,
    fee: r.fee.toString(),
    ledger_base_delta: r.ledger_base_delta.toString(),
    ledger_quote_delta: r.ledger_quote_delta.toString(),
    validation_status: r.validation_status,
    validation_reason: r.validation_reason,
    submitted_qty: numeric(r.submitted_qty),
    submitted_price: numeric(r.submitted_price),
    time_in_force: r.time_in_force,
    exchange_avg_price: numeric(r.exchange_avg_price),
    execution_outcome: r.execution_outcome,
    exchange_order_id: r.exchange_order_id,
    exchange_status: r.exchange_status,
    exchange_error_code: r.exchange_error_code,
    raw_response: r.raw_response,
  };
}

/**
 * Loads the booked sovereign intents in chronological order — the source of
 * truth the portfolio is replayed from. ONLY event_type='intent' rows that were
 * actually booked (validation_status='executed') move the book; crumbs/blocks
 * (rejected/failed intents) and testnet traces (execution rows) are excluded.
 *
 * Returns [] when Supabase is unavailable (portfolio falls back to 100% starting
 * cash), consistent with the cache layer.
 */
export async function loadLedger(supabase: SupabaseClient | null): Promise<LedgerEntry[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('symbol, side, valuation_price, ledger_base_delta, ledger_quote_delta')
      .eq('event_type', 'intent')
      .eq('validation_status', 'executed')
      // Replay in insertion order via the monotonic bigint id, NOT created_at —
      // two intents from the same cycle can share a timestamp, and replay order
      // must be deterministic.
      .order('id', { ascending: true });
    if (error) throw new Error(error.message);

    return (data ?? []).map((row) => ({
      symbol: String(row.symbol),
      side: row.side as ExecutionSide,
      valuationPrice: fromNumeric(row.valuation_price as string),
      baseDelta: fromNumeric(row.ledger_base_delta as string),
      quoteDelta: fromNumeric(row.ledger_quote_delta as string),
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] could not load the execution journal (${msg}) — deriving portfolio from starting cash only.`,
    );
    return [];
  }
}

/**
 * Appends a SINGLE execution row and returns its new id (needed to link a testnet
 * trace back to its intent). Returns { id: null } when Supabase is unavailable or
 * the insert fails — the caller decides what that means (for an intent, it means
 * we could NOT durably book, so we must not place the order).
 */
export async function insertExecution(
  supabase: SupabaseClient | null,
  row: ExecutionInsert,
): Promise<{ id: number | null }> {
  if (!supabase) return { id: null };
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .insert(toPayload(row))
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    const id = data?.id;
    return { id: typeof id === 'number' ? id : id != null ? Number(id) : null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[error] failed to journal a ${row.event_type} row for ${row.symbol} (${msg}).`,
    );
    return { id: null };
  }
}
