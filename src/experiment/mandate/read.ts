import type { SupabaseClient } from '@supabase/supabase-js';
import { fromNumeric } from '../../money.js';
import type { LedgerEntry } from '../../persistence/executions.js';
import type { DecisionSummary } from '../../persistence/decisions.js';
import {
  resolveEffectiveTarget,
  resolveIntentAllocation,
  type TargetColumns,
} from '../../decision/effectiveTarget.js';

/**
 * READ-ONLY loaders for the framing experiment. Every function here issues a SELECT
 * and nothing else — the experiment's whole contract with the database.
 *
 * Two of them are the PRODUCTION queries with one added `created_at <` bound, and
 * that is the point rather than a shortcut: the brief's gate 1 demands the memory be
 * rebuilt "selon le contrat de production". `loadLastSignificantBefore` mirrors
 * `loadLastSignificantDecision` (persistence/decisions.ts) and
 * `loadGuardReferenceBefore` mirrors `loadReferenceAllocations`
 * (persistence/decisionGuard.ts), field for field and filter for filter. If either
 * production query changes shape, these must follow — the historical-replay check in
 * reconstruct.ts is what catches a drift.
 *
 * Unlike production, a failed read here is FATAL. Production degrades gracefully
 * because it must keep trading; an experiment that silently proceeded without its
 * memory would measure the wrong object, which is gate 1's definition of a stop.
 */

export interface StoredDecisionRow extends TargetColumns {
  id: number;
  created_at: string;
  status: string;
  model: string | null;
  prompt_version: string;
  git_sha: string | null;
  action_type: string | null;
  confidence: string | null;
  clamped: boolean | null;
  clamp_reason: string | null;
  market_context: unknown;
  raw_response: string | null;
}

export async function loadDecisionRow(supabase: SupabaseClient, id: number): Promise<StoredDecisionRow> {
  const { data, error } = await supabase
    .from('decisions')
    .select(
      'id, created_at, status, model, prompt_version, git_sha, action_type, confidence, ' +
        'clamped, clamp_reason, target_allocation, applied_allocation, intent_allocation, ' +
        'applied_divergence_cause, market_context, raw_response',
    )
    .eq('id', id)
    .single();
  if (error) throw new Error(`could not load decision ${id}: ${error.message}`);
  return data as unknown as StoredDecisionRow;
}

/**
 * The last SIGNIFICANT decision strictly BEFORE `beforeCreatedAt` — the production
 * memory query (`loadLastSignificantDecision`) with the time bound added. Significance
 * is the ledger's, not the label's: an INNER join on a booked, executed intent.
 */
export async function loadLastSignificantBefore(
  supabase: SupabaseClient,
  beforeCreatedAt: string,
): Promise<(DecisionSummary & { id: number }) | null> {
  const { data, error } = await supabase
    .from('decisions')
    .select(
      'id, created_at, action_type, target_allocation, applied_allocation, clamped, clamp_reason, ' +
        'applied_divergence_cause, confidence, market_state, what_changed, reasoning, ' +
        'executions!inner(id)',
    )
    .eq('status', 'decided')
    .eq('executions.event_type', 'intent')
    .eq('executions.validation_status', 'executed')
    .lt('created_at', beforeCreatedAt)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`could not load the last significant decision before ${beforeCreatedAt}: ${error.message}`);
  const row = (data ?? [])[0] as ((DecisionSummary & { id: number; executions?: unknown }) | undefined);
  if (!row) return null;
  const { executions: _joined, ...summary } = row;
  return summary as DecisionSummary & { id: number };
}

/**
 * The SOVEREIGN LEDGER as it stood strictly BEFORE a cycle — production's
 * `loadLedger` (persistence/executions.ts) with a decision bound added.
 *
 * `decision_id <` rather than a timestamp: decision ids come from a bigserial and
 * are handed out in cycle order, so the bound is exact, and it excludes the target
 * cycle's OWN bookings — which is precisely the book production derived before
 * calling the model. Replay order is the monotonic id, exactly as production does
 * it: two intents from one cycle can share a timestamp, and the replay must be
 * deterministic.
 *
 * This is what lets the harness rebuild the book at FULL PRECISION rather than
 * rehydrating the rounded `PortfolioView` the context persisted (n2 on money, n8 on
 * quantities). See the `book_from_ledger` gate in reconstruct.ts.
 */
export async function loadLedgerBefore(
  supabase: SupabaseClient,
  beforeDecisionId: number,
): Promise<LedgerEntry[]> {
  const { data, error } = await supabase
    .from('executions')
    .select('symbol, side, valuation_price, ledger_base_delta, ledger_quote_delta')
    .eq('event_type', 'intent')
    .eq('validation_status', 'executed')
    .lt('decision_id', beforeDecisionId)
    .order('id', { ascending: true });
  if (error) {
    throw new Error(`could not load the ledger before decision ${beforeDecisionId}: ${error.message}`);
  }
  return (data ?? []).map((row: Record<string, unknown>) => ({
    symbol: String(row.symbol),
    side: row.side as LedgerEntry['side'],
    valuationPrice: fromNumeric(row.valuation_price as string),
    baseDelta: fromNumeric(row.ledger_base_delta as string),
    quoteDelta: fromNumeric(row.ledger_quote_delta as string),
  }));
}

export interface GuardReferenceBefore {
  /** The row the reference came from — published in the reconstruction fingerprints. */
  referenceDecisionId: number | null;
  /** The last accepted INTENTION (resolved as production resolves it), or null when none. */
  intent: Record<string, number> | null;
}

/**
 * The coherence guard's reference strictly BEFORE `beforeCreatedAt` — the production
 * query (`loadReferenceAllocations`) with the time bound added, resolved through the
 * SAME resolvers production uses. The experiment only needs the intention side (rule 1's
 * operand and rule 2's counterfactual basis both derive from it via
 * `restateIntentReference`).
 */
export async function loadGuardReferenceBefore(
  supabase: SupabaseClient,
  beforeCreatedAt: string,
  reserveAsset: string,
): Promise<GuardReferenceBefore> {
  const { data, error } = await supabase
    .from('decisions')
    .select('id, target_allocation, applied_allocation, intent_allocation, applied_divergence_cause')
    .eq('status', 'decided')
    .lt('created_at', beforeCreatedAt)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`could not load the guard reference before ${beforeCreatedAt}: ${error.message}`);
  const row = (data ?? [])[0] as (TargetColumns & { id: number }) | undefined;
  if (!row) return { referenceDecisionId: null, intent: null };

  const effective = resolveEffectiveTarget(row);
  const intent = resolveIntentAllocation(row, reserveAsset);
  if (effective.allocation == null || intent.allocation == null) {
    throw new Error(
      `the guard reference row ${row.id} carries no usable allocation — the experiment cannot ` +
        'rebuild the coherence guard faithfully for this context (gate 1).',
    );
  }
  return { referenceDecisionId: row.id, intent: intent.allocation };
}
