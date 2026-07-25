import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, fromNumeric } from '../money.js';
import type { PositionState } from '../portfolio/lifecycle.js';

const TABLE = 'position_state';

/**
 * Persistence for the per-position lifecycle state (migration 0017).
 *
 * The mandate's rule — "c'est stocké et écrit à chaque cycle, jamais reconstruit à
 * l'exécution" — makes this table the source of truth for the entry date and the
 * peak. Everything here therefore reads and writes it verbatim; the only place that
 * ever derives these values from the journal is the ONE-TIME backfill, which is a
 * separate script for exactly that reason.
 *
 * Money is Decimal in memory and exact `numeric` strings on the wire, like the
 * execution ledger — never float.
 */

interface PositionStateRow {
  asset: string;
  entry_date: string | null;
  peak_price_since_entry: string | null;
  last_significant_move_at: string | null;
  last_significant_move_side: 'buy' | 'sell' | null;
  last_significant_move_notional: string | null;
  qty: string;
  thesis: string | null;
  invalidation: string | null;
  thesis_updated_at: string | null;
}

function toState(row: PositionStateRow): PositionState {
  return {
    asset: row.asset,
    entryDate: row.entry_date,
    // Deliberately NOT fromNumeric: that maps null to ZERO, and a zero peak is a
    // different (and impossible) claim from "no peak yet".
    peakPriceSinceEntry: row.peak_price_since_entry == null ? null : new Decimal(row.peak_price_since_entry),
    lastSignificantMoveAt: row.last_significant_move_at,
    lastSignificantMoveSide: row.last_significant_move_side,
    lastSignificantMoveNotional:
      row.last_significant_move_notional == null ? null : new Decimal(row.last_significant_move_notional),
    qty: fromNumeric(row.qty),
    thesis: row.thesis,
    invalidation: row.invalidation,
    thesisUpdatedAt: row.thesis_updated_at,
  };
}

function toRow(state: PositionState, now: string): PositionStateRow & { updated_at: string } {
  return {
    asset: state.asset,
    entry_date: state.entryDate,
    peak_price_since_entry: state.peakPriceSinceEntry?.toString() ?? null,
    last_significant_move_at: state.lastSignificantMoveAt,
    last_significant_move_side: state.lastSignificantMoveSide,
    last_significant_move_notional: state.lastSignificantMoveNotional?.toString() ?? null,
    qty: state.qty.toString(),
    thesis: state.thesis,
    invalidation: state.invalidation,
    thesis_updated_at: state.thesisUpdatedAt,
    updated_at: now,
  };
}

/**
 * Every stored state, keyed by asset. Returns an EMPTY map when persistence is not
 * configured or unreachable — same posture as the rest of the persistence layer:
 * Supabase is never a single point of failure. The cost of an empty read is that a
 * held position looks like a fresh entry for one cycle, which the caller logs.
 */
export async function loadPositionStates(
  supabase: SupabaseClient | null,
): Promise<Map<string, PositionState>> {
  const states = new Map<string, PositionState>();
  if (!supabase) return states;
  try {
    const { data, error } = await supabase.from(TABLE).select('*');
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as PositionStateRow[]) states.set(row.asset, toState(row));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[warn] could not load position state (${msg}) — this cycle proceeds without it.`);
  }
  return states;
}

/**
 * Writes the states for this cycle, one upsert keyed by asset.
 *
 * A failure here is LOUD but not fatal. Losing a write costs at most one cycle of
 * peak sampling (the next cycle re-ratchets from the stored value), which is a
 * degradation, not a corruption. Failing the whole cycle over it would be worse: the
 * bot would stop trading because a bookkeeping write blipped.
 */
export async function savePositionStates(
  supabase: SupabaseClient | null,
  states: PositionState[],
  now: string,
): Promise<boolean> {
  if (!supabase || states.length === 0) return false;
  try {
    const { error } = await supabase
      .from(TABLE)
      .upsert(states.map((s) => toRow(s, now)), { onConflict: 'asset' });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[error] could not write position state (${msg}) — entry dates and peaks are one cycle stale; ` +
        'the next cycle re-ratchets from the stored values.',
    );
    return false;
  }
}
