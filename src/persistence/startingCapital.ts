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
  // Validate the Number PROJECTION (the form toPortfolioView / the snapshot builder
  // serialize the book into) — NOT the Decimal — because that projection is where a
  // bad value does its damage. Project once, then require finite AND strictly positive.
  // This single condition is EXHAUSTIVE for Number projections: it rejects NaN, ±Infinity,
  // overflow (1e400 → Infinity), underflow (1e-400 → 0), zero, and negatives. (Testing
  // positivity on the Decimal would miss underflow: 1e-400 is a positive Decimal but
  // projects to 0.) Postgres `numeric` admits all of these. Present-but-unusable is a
  // fault, exactly like non-positive: fail loud, never a silent fallback — and at the
  // point of use, so the book is protected whatever the value's origin (reset, manual edit).
  const n = capital.toNumber();
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `starting capital in bot_state is not usable (must project to a positive, finite Number): ${capital.toString()}`,
    );
  }
  return capital;
}
