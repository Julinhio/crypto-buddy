import type { SupabaseClient } from '@supabase/supabase-js';
import type { CoherenceRule } from '../decision/coherence.js';
import {
  resolveEffectiveTarget,
  resolveIntentAllocation,
  type TargetColumns,
} from '../decision/effectiveTarget.js';

const DECISIONS_TABLE = 'decisions';
const EVENTS_TABLE = 'decision_guard_events';

/**
 * THE TWO REFERENCES A CYCLE READS BACK, and why one row now answers two questions.
 *
 * The bot runs under Railway Cron Schedule: every wake-up is a FRESH PROCESS. There is
 * no module state, no cache, no memory of any kind between two cycles — so "the last
 * accepted X" can only be a database read, performed at the start of each cycle. Anything
 * held in a module-level variable would be `null` on every single wake-up and would
 * quietly disable rules 1 and 2 while looking like it worked.
 *
 * "Accepted" is derived from the STATUS rather than from a join against the guard's own
 * event log, and that is the load-bearing choice: a cycle the guard rejects is journaled
 * as `guard_failed`, never as `decided`. So "the last accepted value" is exactly "the
 * value of the most recent `decided` row", and the rule that a rejected cycle establishes
 * no reference becomes a property of the schema rather than a join someone can forget.
 *
 * ── THE TWO VALUES ──────────────────────────────────────────────────────────────
 *
 *   `intent`   the last INTENTION — resolved from `intent_allocation`, falling back to the
 *              raw proposal on rows predating migration 0027. This is the coherence
 *              guard's rule-1 reference, and the ONLY thing it is: an intention question
 *              needs an intention operand, unbounded by any policy.
 *   `applied`  the last EFFECTIVE target — resolved from `applied_allocation`. What the
 *              chain retained and the book pursued. Read by the transition gate, which
 *              reverts to it on a refusal, and by the refused-leg journal, which reports
 *              the leg against the target the book was actually at.
 *
 * ONE ROW, TWO COLUMNS, ONE READ. Splitting this into two queries would let the two
 * references come from two different rows the day a cycle lands between them — the guard
 * comparing against one decision while the gate reverts to another.
 *
 * ── THE BOOTSTRAP CASE, STATED EXPLICITLY ────────────────────────────────────────
 *
 * The v5 decisions already on record carry no guard verdict — the guard did not exist when
 * most of them were written. So "the last value the guard accepted" has no literal answer
 * on the first cycle after a deployment, and leaving that to an implicit default is how a
 * one-cycle hole gets shipped. The whole pre-guard history is treated as accepted: those
 * rows ARE what the book has been pursuing, they were persisted and handed to the
 * executor, and cycles 907 and 935 actually traded against targets established that way.
 * The alternative (no reference on the first cycle) would leave rule 1 unenforced for
 * exactly one wake-up — precisely the wake-up that follows a deploy made because of a
 * lost trade.
 *
 * `ok: false` means the READ ITSELF failed and is deliberately not collapsed into two
 * nulls — "there is no previous decision" and "we could not find out" are different facts,
 * and only the first one is safe to run the guard on.
 */
export interface ReferenceAllocationsRead {
  ok: boolean;
  /** The last accepted INTENTION, or null when no decision has ever been recorded. */
  intent: Record<string, number> | null;
  /** The last accepted EFFECTIVE target, or null when no decision has ever been recorded. */
  applied: Record<string, number> | null;
}

export async function loadReferenceAllocations(
  supabase: SupabaseClient | null,
  /**
   * The cycle's reserve stable. Needed because a row written WITHOUT an intention column —
   * an old binary running after the additive migration, or a rollback — has to have its
   * intention reconstructed, and a stopped line's weight has to land somewhere. Passed in
   * rather than imported so the resolver stays pure and the caller stays honest about which
   * reserve it means.
   */
  reserveAsset: string,
): Promise<ReferenceAllocationsRead> {
  // No persistence configured is a local/dev run, not a failure: there is no history to
  // read, which is honestly "no reference yet".
  if (!supabase) return { ok: true, intent: null, applied: null };

  try {
    const { data, error } = await supabase
      .from(DECISIONS_TABLE)
      // ALL THREE columns, resolved by the two resolvers. `intent_allocation` answers "what
      // did the model last mean", `applied_allocation` answers "what did the book last
      // pursue", and `target_allocation` is the named fallback for rows written before
      // migration 0027 — never a value either resolver reaches for otherwise.
      .select(
        'target_allocation, applied_allocation, intent_allocation, clamped, applied_divergence_cause',
      )
      .eq('status', 'decided')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);

    const row = (data ?? [])[0] as TargetColumns | undefined;
    if (!row) return { ok: true, intent: null, applied: null }; // genuinely the first decision

    const effective = resolveEffectiveTarget(row);
    const intent = resolveIntentAllocation(row, reserveAsset);
    if (effective.allocation == null || intent.allocation == null) {
      // A `decided` row is CHECK-constrained to have a target_allocation, so reaching here
      // means the columns hold something no resolver can use. Refusing is safer than
      // coercing: a mangled reference would not fail loudly, it would silently reject every
      // subsequent hold.
      console.error(
        '[CRITICAL] the last decided row has no usable allocation ' +
          `(target=${JSON.stringify(row.target_allocation)}, ` +
          `intent=${JSON.stringify(row.intent_allocation)}, ` +
          `applied=${JSON.stringify(row.applied_allocation)}) — ` +
          'the coherence guard has no reference to compare against.',
      );
      return { ok: false, intent: null, applied: null };
    }

    // Both fallbacks are contracts for older rows, and neither should be a live path for
    // long. Worth knowing about now rather than discovering later: `proposal-fallback`
    // means the guard's gate reference predates `applied_allocation`, `intent-fallback`
    // means it predates migration 0027 — expected on every row until the first cycle
    // written after this deploy, and never again after that.
    if (effective.source === 'proposal-fallback') {
      console.warn(
        '[warn] the last decided row carries no applied_allocation — the transition gate is ' +
          'falling back to the raw proposal as its previous vector.',
      );
    }
    if (intent.source === 'intent-fallback') {
      console.warn(
        '[warn] the last decided row carries no intent_allocation — the coherence guard is ' +
          'reading the raw proposal as its intention reference. Expected exactly once after ' +
          'the deploy; recurring means a binary without this code is still writing rows.',
      );
    }
    if (intent.source === 'intent-reconstructed') {
      // Loud, because it means a row was written by a binary that did not know about the
      // column WHILE A PEAK STOP FIRED. The reconstruction is correct; the fact that it was
      // needed says something about the deployment that is worth reading.
      console.warn(
        '[warn] the last decided row carries no intent_allocation but shows a peak-stop exit ' +
          `on ${intent.stoppedAssets.join(', ')} — the intention was RECONSTRUCTED from the ` +
          'applied target. A binary without this code wrote that row; check for a rollback.',
      );
    }
    return { ok: true, intent: intent.allocation, applied: effective.allocation };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CRITICAL] could not read the reference allocations (${msg}).`);
    return { ok: false, intent: null, applied: null };
  }
}

/** The event kinds, mirroring the CHECK on `decision_guard_events.event_type`. */
export type GuardEventType =
  | 'guard_rejected_first_attempt'
  | 'guard_recovered_on_retry'
  /** Relaunched once, and the corrected response was still incoherent. */
  | 'guard_failed_after_retry'
  /**
   * Rejected, and there was not enough cycle budget left to even attempt the retry
   * (migration 0020). Kept out of `failed_after_retry` on purpose: the two are different
   * failures with different reactions. "The model cannot correct itself" sends you to
   * the retry prompt and the rules; "the cycle ran out of time before trying" sends you
   * to the latency and the cycle budget, and the model is not involved at all. A counter
   * that mixed them would send the operator looking in the wrong place.
   */
  | 'guard_failed_no_retry_budget'
  /**
   * The retry was attempted and the CALL itself failed (timeout, 429, network) — there
   * is no corrected response, so there is nothing to judge for coherence (migration
   * 0021). Each of the three retry failures points somewhere different:
   *   after_retry      → the model cannot correct itself  → the retry prompt, the rules
   *   no_retry_budget  → out of time before relaunching   → latency, the cycle budget
   *   retry_call_failed → the relaunch never landed       → transport, the API
   */
  | 'guard_retry_call_failed'
  | 'output_order_violation'
  | 'thesis_write_refused';

export interface GuardEventInsert {
  decision_id: number | null;
  run_token: string | null;
  event_type: GuardEventType;
  attempt: number;
  rules: CoherenceRule[];
  assets: string[];
  detail: string | null;
}

/**
 * Writes one guard event. Best-effort by contract — it NEVER throws and never fails a
 * cycle, because the trade has either already happened or already been refused by the
 * time this runs, and failing here would not undo either.
 *
 * But it is not swallowed either: a lost guard event is a real, non-self-healing loss of
 * exactly the evidence this table was created to stop losing, so it is logged loudly.
 * Same posture as `savePositionStates`.
 */
export async function recordGuardEvent(
  supabase: SupabaseClient | null,
  event: GuardEventInsert,
): Promise<boolean> {
  if (!supabase) {
    console.warn(
      `[warn] Supabase not configured — guard event "${event.event_type}" NOT journaled ` +
        '(printed to console only).',
    );
    return false;
  }
  try {
    const { error } = await supabase.from(EVENTS_TABLE).insert(event);
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[CRITICAL] guard event "${event.event_type}" was NOT journaled (${msg}) — ` +
        `payload: ${JSON.stringify(event)}. This is the exact evidence the 30/07 investigation ` +
        'lacked; it is being dumped here so it is at least recoverable from the logs.',
    );
    return false;
  }
}
