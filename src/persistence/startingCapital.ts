import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, fromNumeric } from '../money.js';

const TABLE = 'bot_state';

/**
 * Reads the sovereign starting capital from the DB (the bot_state singleton) — the
 * INITIAL CONDITION of the whole virtual-portfolio derivation.
 *
 * The env bootstrap (returning null, so the caller does `?? dec(config...)`) is allowed
 * in EXACTLY two legitimate situations; EVERY other case fails loud (throws), so the
 * book is never derived on a wrong/guessed value and no silent-bootstrap angle is left:
 *
 *   LEGITIMATE → null (env bootstrap):
 *     - No Supabase client. Only the manual `npm run decide` dev path reaches here with
 *       no client; the scheduled path can't, because runHeartbeat already fails loud on
 *       an unconfigured Supabase BEFORE decide() runs. So this can't mask a prod
 *       misconfig — it's a deliberate local-dev affordance (same posture as loadLedger).
 *     - The singleton row is PRESENT but starting_capital_usd is NULL: no capital set
 *       yet, the steady state until the future reset writes one.
 *
 *   ANOMALOUS → throw (fail loud → technical error → backoff):
 *     - The read fails (any error) — we rely on the migration-before-deploy invariant,
 *       so a failure is a genuine fault, not a not-yet-migrated schema.
 *     - The singleton row is ABSENT (`data === null` after a SUCCESSFUL query): a
 *       structural anomaly, NOT a missing value. Treating it as an absence would
 *       silently bootstrap and, via the manual entrypoint that doesn't pre-create the
 *       row, derive/persist/execute on a wrong book.
 *     - The value is present but does not project to a positive, FINITE JS Number
 *       (NaN / ±Infinity / overflow / underflow / zero / negative).
 */
export async function loadStartingCapital(
  supabase: SupabaseClient | null,
): Promise<Decimal | null> {
  if (!supabase) return null; // local/dev with no Supabase → env bootstrap (see above)

  const { data, error } = await supabase
    .from(TABLE)
    .select('starting_capital_usd')
    .eq('id', 1)
    .maybeSingle();

  // (1) Read failure → fail loud. No error-code guessing (migration-before-deploy means
  //     a failure is a genuine fault, not a not-yet-migrated column).
  if (error) {
    throw new Error(
      `could not read starting capital from bot_state (${error.message}) — ` +
        'failing the cycle rather than deriving the portfolio on a stale/guessed value',
    );
  }

  // (2) Singleton row ABSENT → structural anomaly, not a legitimate "no value". Fail
  //     loud rather than silently bootstrap (which the manual entrypoint would derive on).
  if (data == null) {
    throw new Error(
      'bot_state singleton row (id=1) is missing — refusing to bootstrap the starting ' +
        'capital on an absent state row (is migration 0006 applied?).',
    );
  }

  // (3) Row present, no capital set yet → the legitimate env bootstrap.
  const raw = data.starting_capital_usd as string | number | null | undefined;
  if (raw == null || raw === '') return null;

  // (4) Present value → must project to a positive, finite Number (the form
  //     toPortfolioView / the snapshot builder serialize into), else fail loud. This
  //     single condition is exhaustive: it rejects NaN, ±Infinity, overflow (→ Infinity),
  //     underflow (→ 0), zero, and negatives. Present-but-unusable is a fault.
  const capital = fromNumeric(raw);
  const n = capital.toNumber();
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `starting capital in bot_state is not usable (must project to a positive, finite Number): ${capital.toString()}`,
    );
  }
  return capital;
}
