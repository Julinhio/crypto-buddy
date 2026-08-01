import type { SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'decisions';

/**
 * `guard_failed` (migration 0019) is a response the coherence guard refused twice: the
 * JSON parsed perfectly, its structured parts contradicted each other. Kept distinct
 * from `parse_failed` for two reasons — it keeps the parse-failure metric honest (it has
 * been at zero since 25/07 and watches something else), and it is what makes "the last
 * accepted target" readable as "the last `decided` row", so a rejected cycle provably
 * establishes no reference for the next one.
 */
export type DecisionStatus = 'decided' | 'skipped' | 'parse_failed' | 'error' | 'guard_failed';

/** Compact view of a past `decided` row, fed back to the model for coherence. */
export interface DecisionSummary {
  created_at: string;
  action_type: string;
  /** What the AI proposed (raw). */
  target_allocation: unknown;
  /** The risk-bounded target (clamp output = execution INPUT), migration 0004.
   *  NOT necessarily the allocation actually held — a movement may not book. Null
   *  on rows predating that migration. */
  applied_allocation: unknown;
  clamped: boolean | null;
  clamp_reason: string | null;
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
  /** Short phone-friendly "why" for the activity notification (migration 0014). */
  notification_summary: string | null;
  requested_delay_minutes: number | null;
  applied_delay_minutes: number | null;
  market_context: unknown;
  /**
   * The CODE's regime read for this cycle (migration 0016) — per-asset regime after
   * hysteresis, raw label, global risk_off posture and their signals. Null when the
   * 4h series was unavailable (a missing regime is journaled as such, never fatal).
   * Shadow mode at PR 1: written, never shown to the model.
   */
  regime: unknown;
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
        'created_at, action_type, target_allocation, applied_allocation, clamped, clamp_reason, confidence, market_state, what_changed, reasoning',
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
 * The most recent decision that ACTUALLY MOVED THE BOOK — the newest `decided` row with
 * at least one BOOKED intent behind it.
 *
 * Significance is derived from the LEDGER, not from `action_type`. That field is a
 * label the model chooses, and on this bot the two disagree constantly: the three most
 * recent cycles that actually booked a trade are all labelled `hold`. Filtering on
 * `action_type != 'hold'` would have excluded every one of them while happily
 * accepting a `rebalance` whose movements were all suppressed by the 2% floor — the
 * memory would then describe decisions that did nothing and omit the ones that did.
 * The booked intent is the fact; the label is an opinion.
 *
 * A dedicated query rather than a filter over `loadRecentDecisions`, too: that loader
 * returns the last 5 rows and only then could a caller filter them, so five ordinary
 * holds would bury the real decision. The bot averaged 785 holds in 47 days, which
 * makes "more than five holds in a row" the normal condition, not an edge case — the
 * v5 memory would have vanished in exactly the steady state it exists for.
 *
 * Returns null when persistence is unreachable or nothing has booked yet; both mean
 * "no memory to offer", which the prompt states plainly.
 */
export async function loadLastSignificantDecision(
  supabase: SupabaseClient | null,
): Promise<DecisionSummary | null> {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select(
        'created_at, action_type, target_allocation, applied_allocation, clamped, clamp_reason, ' +
          'confidence, market_state, what_changed, reasoning, executions!inner(id)',
      )
      .eq('status', 'decided')
      // An INNER join on a booked intent: only a decision the ledger actually recorded
      // a movement for can qualify.
      .eq('executions.event_type', 'intent')
      .eq('executions.validation_status', 'executed')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const row = (data ?? [])[0] as (DecisionSummary & { executions?: unknown }) | undefined;
    if (!row) return null;
    // Drop the join artefact — the prompt gets a decision, not a query result.
    const { executions: _joined, ...summary } = row;
    return summary as DecisionSummary;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[warn] could not load the last significant decision (${msg}) — proceeding without it.`);
    return null;
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
