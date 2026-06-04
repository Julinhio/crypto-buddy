import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'decisions';

export type DecisionStatus = 'decided' | 'skipped' | 'parse_failed' | 'error';

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

/** A full row to insert — mirrors migrations 0002 + 0004. */
export interface DecisionRow {
  status: DecisionStatus;
  skip_reason: string | null;
  target_allocation: Record<string, number> | null;
  // Risk-wrapper result (migration 0004): what the code kept after bounding the
  // AI's proposal to the caps, written in the same cycle.
  applied_allocation: Record<string, number> | null;
  clamped: boolean | null;
  clamp_reason: string | null;
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

export interface InsertDecisionResult {
  persisted: boolean;
  /** The new row's id — needed as the FK for this cycle's executions. */
  id: number | null;
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
 * Persists one wake-up and returns its new id (the FK this cycle's executions
 * reference). A missing or failing Supabase does NOT crash the run — the
 * decision is still produced and printed; we warn that it wasn't journaled, and
 * with no id the cycle skips writing executions (the portfolio won't evolve).
 */
export async function insertDecision(
  supabase: SupabaseClient | null,
  row: DecisionRow,
): Promise<InsertDecisionResult> {
  if (!supabase) {
    console.warn(
      '[warn] Supabase not configured — decision NOT journaled (printed to console only).',
    );
    return { persisted: false, id: null };
  }

  try {
    const { data, error } = await supabase.from(TABLE).insert(row).select('id').single();
    if (error) throw new Error(error.message);
    return { persisted: true, id: (data?.id as number | undefined) ?? null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[error] failed to journal decision (${msg}) — the decision was made but NOT persisted.`,
    );
    return { persisted: false, id: null };
  }
}
