import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Process-level memoization: the client (or the supported `null` state) is
// resolved once and reused across runs/callers, instead of instantiating a new
// client every time. `initialized` distinguishes "not resolved yet" from a
// legitimately resolved `null`.
let initialized = false;
let cachedClient: SupabaseClient | null = null;

/**
 * Returns the shared server-side Supabase client, or `null` when persistence
 * is not configured. A null client is a supported state, not an error: every
 * caller must fall back to its non-cached behavior so Supabase is never a
 * single point of failure (see the brick's resilience requirement).
 *
 * Uses the SERVICE ROLE key on purpose — this is a backend. The service key
 * bypasses RLS and must stay server-side only; it is read from the
 * environment and never committed.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (initialized) return cachedClient;
  initialized = true;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.warn(
      '[warn] Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing) — ' +
        'ATH/ATL cache disabled, computing from the long series each run.',
    );
    cachedClient = null;
    return cachedClient;
  }

  cachedClient = createClient(url, serviceKey, {
    // No user sessions on a backend: don't persist or refresh auth.
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}
