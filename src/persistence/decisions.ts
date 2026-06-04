import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'decisions';

export type DecisionStatus = 'decided' | 'skipped' | 'parse_failed';

/** Compact view of a past `decided` row, fed back to the model for coherence. */
export interface DecisionSummary {
  created_at: string;
  action_type: string;
  target_allocation: unknown;
  confidence: string;
  market_state: string;
  what_changed: string;
  reasoning: string;
}

/** A full row to insert — mirrors the 0002_decisions migration. */
export interface DecisionRow {
  status: DecisionStatus;
  skip_reason: string | null;
  target_allocation: Record<string, number> | null;
  action_type: string | null;
  what_changed: string | null;
  confidence: string | null;
  market_state: string | null;
  reasoning: string | null;
  requested_delay_minutes: number | null;
  applied_delay_minutes: number | null;
  market_context: unknown;
  model: string | null;
  prompt_version: string;
  git_sha: string | null;
  raw_response: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/**
 * Loads the most recent `decided` rows. Returns [] when persistence is not
 * configured or unreachable (treated as a first cycle) — Supabase is never a
 * single point of failure, consistent with the cache layer.
 */
export async function loadRecentDecisions(
  supabase: SupabaseClient | null,
  limit: number,
): Promise<DecisionSummary[]> {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(
        'created_at, action_type, target_allocation, confidence, market_state, what_changed, reasoning',
      )
      .eq('status', 'decided')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []) as DecisionSummary[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] could not load recent decisions (${msg}) — proceeding as if this were the first cycle.`,
    );
    return [];
  }
}

/**
 * Persists one wake-up. Returns whether it was actually written. A missing or
 * failing Supabase does NOT crash the run — the decision is still produced and
 * printed; we just warn loudly that it was not journaled.
 */
export async function insertDecision(
  supabase: SupabaseClient | null,
  row: DecisionRow,
): Promise<boolean> {
  if (!supabase) {
    console.warn(
      '[warn] Supabase not configured — decision NOT journaled (printed to console only).',
    );
    return false;
  }

  try {
    const { error } = await supabase.from(TABLE).insert(row);
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[error] failed to journal decision (${msg}) — the decision was made but NOT persisted.`,
    );
    return false;
  }
}
