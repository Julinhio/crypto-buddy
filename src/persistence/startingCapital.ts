import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, fromNumeric } from '../money.js';

const TABLE = 'bot_state';

/**
 * Distinguishes "the schema isn't in place yet" from a real read failure.
 *
 * A SELECT of a not-yet-migrated column (or table) fails with a Postgres SQLSTATE
 * that PostgREST passes through in `error.code`:
 *   - 42703 undefined_column  — the column hasn't been added yet (the deploy window
 *                               where the code ships before migration 0009);
 *   - 42P01 undefined_table   — bot_state itself isn't there (defensive).
 * Both mean the value is OBJECTIVELY ABSENT → the caller may bootstrap on the env.
 *
 * EVERYTHING ELSE (network error, timeout, connection failure, permission, any other
 * SQLSTATE, or a non-PostgREST throw) is a REAL read failure: we must NOT fall back,
 * because a value might exist but be momentarily unreadable, and silently deriving on
 * the env bootstrap would be wrong after a divergent reset. The conservative default
 * is therefore "real failure" — only these two known codes are treated as absence.
 */
export function isSchemaNotMigrated(error: { code?: string | null } | null | undefined): boolean {
  const code = error?.code;
  return code === '42703' || code === '42P01';
}

/**
 * Reads the sovereign starting capital from the DB (the bot_state singleton) — the
 * INITIAL CONDITION of the whole virtual-portfolio derivation. Three outcomes:
 *
 *   1. A value is present  → return it (exact Decimal). The DB is the source of truth.
 *   2. OBJECTIVE absence    → return null, so the caller bootstraps on the env var:
 *        - Supabase not configured,
 *        - the column/table not migrated yet (isSchemaNotMigrated),
 *        - the value is NULL (no capital set yet — a vierge base, the steady state
 *          until the future reset writes one).
 *   3. A REAL read failure  → THROW. DB unreachable, timeout, any non-absence error,
 *        or a present-but-corrupt (non-positive) value. We do NOT fall back: a value
 *        might exist but be unreadable, and deriving the whole book on a possibly
 *        stale env value (after a divergent reset) could drive a wrong trade. The
 *        cycle then treats this as the infra failure it is — runCycleWithTimeout
 *        records a technical error and backs off, like the other reads the bot
 *        depends on (recordHeartbeat). We never derive on a stale/unknown value.
 *
 * Net: the env fallback fires ONLY on objective absence, never when a real value may
 * exist but be momentarily illegible.
 */
export async function loadStartingCapital(
  supabase: SupabaseClient | null,
): Promise<Decimal | null> {
  if (!supabase) return null; // not configured → bootstrap on env (objective absence)

  const { data, error } = await supabase
    .from(TABLE)
    .select('starting_capital_usd')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    if (isSchemaNotMigrated(error)) return null; // not migrated yet → env bootstrap
    // A genuine read failure with the schema in place — fail loud, do NOT fall back.
    throw new Error(
      `could not read starting capital from bot_state (${error.message}) — ` +
        'failing the cycle rather than deriving the portfolio on a possibly-stale value',
    );
  }

  const raw = data?.starting_capital_usd as string | number | null | undefined;
  if (raw == null || raw === '') return null; // NULL column → no value set → env bootstrap

  const capital = fromNumeric(raw);
  if (!capital.gt(0)) {
    // A present-but-non-positive value is corrupt data (the CHECK constraint should
    // make this impossible). Fail loud rather than mask it with the env bootstrap or
    // derive the book on a bad initial condition.
    throw new Error(`starting capital in bot_state is non-positive (${capital.toString()})`);
  }
  return capital;
}
