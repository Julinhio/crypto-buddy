import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, fromNumeric } from '../money.js';

const TABLE = 'bot_state';

/**
 * Reads the sovereign starting capital from the DB (the bot_state singleton) — the
 * INITIAL CONDITION of the whole virtual-portfolio derivation. THREE outcomes, with
 * NO dependency on any error code:
 *
 *   1. The query SUCCEEDS with a usable (positive) value → return it. The DB is the
 *      source of truth.
 *   2. The query SUCCEEDS but the value is NULL → return null, so the caller
 *      bootstraps on the env var. This is the legitimate steady state until the
 *      future reset writes a capital. (NULL is detected by the query's SUCCESS, not
 *      by sniffing an error code.)
 *   3. The query FAILS, whatever the error → THROW. We never guess. The cycle treats
 *      it as the infra failure it is (runCycleWithTimeout → technical error → backoff),
 *      like the other reads the bot depends on (recordHeartbeat). We never derive the
 *      book on a stale/guessed value.
 *
 * Why no "schema not migrated" branch? We rely on the HARD operational invariant that
 * the migration is ALWAYS applied before the code is deployed (migrations are run by
 * hand in Supabase first). So the column always exists when this runs, and a failure
 * here is a genuine fault — not a missing schema. If the migration were somehow
 * skipped, failing loud is the RIGHT signal (it surfaces the mistake) rather than a
 * silent env bootstrap that would mask it. This also avoids depending on a Postgres
 * SQLSTATE that the PostgREST Data API does not reliably surface.
 */
export async function loadStartingCapital(
  supabase: SupabaseClient | null,
): Promise<Decimal | null> {
  if (!supabase) return null; // not configured (local/dev) → bootstrap on env

  const { data, error } = await supabase
    .from(TABLE)
    .select('starting_capital_usd')
    .eq('id', 1)
    .maybeSingle();

  // Any read failure → fail loud, never fall back. A value might exist but be
  // momentarily unreadable, and deriving on a stale env value (after a divergent
  // reset) could drive a wrong trade. No error-code classification.
  if (error) {
    throw new Error(
      `could not read starting capital from bot_state (${error.message}) — ` +
        'failing the cycle rather than deriving the portfolio on a stale/guessed value',
    );
  }

  const raw = data?.starting_capital_usd as string | number | null | undefined;
  if (raw == null || raw === '') return null; // query OK, no value set → env bootstrap

  const capital = fromNumeric(raw);
  if (!capital.gt(0)) {
    // Present but non-positive = corrupt data (the CHECK constraint should forbid it).
    // Fail loud rather than derive the book on a bad initial condition.
    throw new Error(`starting capital in bot_state is non-positive (${capital.toString()})`);
  }
  return capital;
}
