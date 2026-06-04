import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let warnedNotConfigured = false;

/**
 * Returns a server-side Supabase client, or `null` when persistence is not
 * configured. A null client is a supported state, not an error: every caller
 * must fall back to its non-cached behavior so Supabase is never a single
 * point of failure (see the brick's resilience requirement).
 *
 * Uses the SERVICE ROLE key on purpose — this is a backend. The service key
 * bypasses RLS and must stay server-side only; it is read from the
 * environment and never committed.
 */
export function createSupabaseClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    if (!warnedNotConfigured) {
      console.warn(
        '[warn] Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — ' +
          'ATH/ATL cache disabled, computing from the long series each run.',
      );
      warnedNotConfigured = true;
    }
    return null;
  }

  return createClient(url, serviceKey, {
    // No user sessions on a backend: don't persist or refresh auth.
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
