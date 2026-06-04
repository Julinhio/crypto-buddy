import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, fromNumeric } from '../money.js';

const TABLE = 'executions';

export type ExecutionSide = 'buy' | 'sell';
export type ValidationStatus = 'executed' | 'rejected' | 'failed';

/**
 * A row ready to insert. Money fields are Decimal in memory and serialized to
 * exact `numeric` strings at insert time (never float).
 */
export interface ExecutionInsert {
  decision_id: number;
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
  validation_status: ValidationStatus;
  validation_reason: string | null;
  exchange_order_id: string | null;
  exchange_status: string | null;
  exchange_error_code: string | null;
  raw_response: unknown | null;
}

/** The slice of an execution the portfolio derivation needs, parsed to Decimal. */
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

/**
 * Loads the full execution journal in chronological order — the source of truth
 * the portfolio is replayed from. Returns [] when Supabase is unavailable
 * (portfolio falls back to 100% starting cash), consistent with the cache layer.
 */
export async function loadLedger(supabase: SupabaseClient | null): Promise<LedgerEntry[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('symbol, side, valuation_price, ledger_base_delta, ledger_quote_delta')
      .eq('validation_status', 'executed')
      // Replay in insertion order via the monotonic bigint id, NOT created_at —
      // two fills from the same cycle can share a timestamp, and replay order
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
 * Appends modeled-fill rows for this cycle's movements. Returns how many were
 * written. A missing/failing Supabase does NOT crash the run — the movements
 * were still computed and logged; we just warn they weren't journaled (so the
 * virtual portfolio won't evolve next cycle).
 */
export async function insertExecutions(
  supabase: SupabaseClient | null,
  rows: ExecutionInsert[],
): Promise<number> {
  if (rows.length === 0) return 0;
  if (!supabase) {
    console.warn(
      '[warn] Supabase not configured — modeled fills NOT journaled (portfolio will not evolve).',
    );
    return 0;
  }

  const payload = rows.map((r) => ({
    decision_id: r.decision_id,
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
    exchange_order_id: r.exchange_order_id,
    exchange_status: r.exchange_status,
    exchange_error_code: r.exchange_error_code,
    raw_response: r.raw_response,
  }));

  try {
    const { error } = await supabase.from(TABLE).insert(payload);
    if (error) throw new Error(error.message);
    return rows.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[error] failed to journal ${rows.length} modeled fill(s) (${msg}) — movements computed but NOT persisted.`,
    );
    return 0;
  }
}
