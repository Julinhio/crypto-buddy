import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, fromNumeric } from '../money.js';

const TABLE = 'bot_state';

/**
 * Reads the sovereign starting capital from the DB (the bot_state singleton) — the
 * INITIAL CONDITION of the whole virtual-portfolio derivation. Returns an exact
 * Decimal (parsed from the `numeric` column via fromNumeric), or `null` when the
 * value is absent or unusable:
 *   - Supabase not configured / unreachable,
 *   - the column not migrated yet (pre-migration deploy window),
 *   - a NULL value (a brand-new / vierge base),
 *   - a non-positive value (corrupt — would break P&L).
 *
 * The caller falls back to the env-var bootstrap on null, so this read is NEVER a
 * single point of failure and the deploy order is forgiving (same posture as
 * loadLedger / loadRecentDecisions). The DB is the source of truth once a value is
 * present; the value is unchanged from the env bootstrap (migration 0009 seeds the
 * exact same number), so the derived portfolio is identical either way.
 */
export async function loadStartingCapital(
  supabase: SupabaseClient | null,
): Promise<Decimal | null> {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('starting_capital_usd')
      .eq('id', 1)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const raw = data?.starting_capital_usd as string | number | null | undefined;
    if (raw == null || raw === '') return null; // NULL column → vierge base → env bootstrap

    const capital = fromNumeric(raw);
    // A non-positive starting capital is corrupt; refuse it and let the caller use
    // the env bootstrap rather than derive the whole book from a bad initial value.
    return capital.gt(0) ? capital : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] could not read starting capital from bot_state (${msg}) — using the env bootstrap.`,
    );
    return null;
  }
}
