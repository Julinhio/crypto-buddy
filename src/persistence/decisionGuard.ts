import type { SupabaseClient } from '@supabase/supabase-js';
import type { CoherenceRule } from '../decision/coherence.js';

const DECISIONS_TABLE = 'decisions';
const EVENTS_TABLE = 'decision_guard_events';

/**
 * THE REFERENCE TARGET, and where it necessarily comes from.
 *
 * The bot runs under Railway Cron Schedule: every wake-up is a FRESH PROCESS. There is
 * no module state, no cache, no memory of any kind between two cycles — so "the last
 * accepted target" can only be a database read, performed at the start of each cycle.
 * Anything held in a module-level variable would be `null` on every single wake-up and
 * would quietly disable rules 1 and 2 while looking like it worked.
 *
 * "Accepted" is derived from the STATUS rather than from a join against the guard's own
 * event log, and that is the load-bearing choice: a cycle the guard rejects is journaled
 * as `guard_failed`, never as `decided`. So "the last accepted target" is exactly "the
 * target_allocation of the most recent `decided` row", and the rule that a rejected
 * cycle establishes no reference becomes a property of the schema rather than a join
 * someone can forget.
 *
 * ── THE BOOTSTRAP CASE, STATED EXPLICITLY ────────────────────────────────────────
 *
 * The 139 v5 decisions already on record carry no guard verdict — the guard did not
 * exist when they were written. So on the first cycle after deployment, "the last target
 * the guard accepted" has no literal answer, and leaving that to an implicit default is
 * how a one-cycle hole gets shipped.
 *
 * The value retained is the `target_allocation` of the most recent `decided` row,
 * treating the whole pre-guard history as accepted. It is not a convenient fiction: that
 * row IS what the book is currently pursuing — it was persisted, it was handed to the
 * executor, and cycles 907 and 935 actually traded against targets established this way.
 * The alternative (no reference on the first cycle) would leave rule 1 unenforced for
 * exactly one wake-up, which is precisely the wake-up that follows a deploy made because
 * of a lost trade.
 *
 * The known cost, bounded and self-healing: if the deploy lands right after one of the
 * defective cycles (a 946-style target at BNB 11%), the reference starts one point off.
 * The next genuine hold at 12% is then rejected once, the retry re-emits the reference,
 * and the chain converges. One rejected cycle, no order lost, no manual intervention.
 *
 * `ok: false` means the READ ITSELF failed and is deliberately not collapsed into
 * `target: null` — "there is no previous decision" and "we could not find out" are
 * different facts, and only the first one is safe to run the guard on.
 */
export interface ReferenceTargetRead {
  ok: boolean;
  /** The last accepted target, or null when no decision has ever been recorded. */
  target: Record<string, number> | null;
}

export async function loadReferenceTarget(
  supabase: SupabaseClient | null,
): Promise<ReferenceTargetRead> {
  // No persistence configured is a local/dev run, not a failure: there is no history to
  // read, which is honestly "no reference yet".
  if (!supabase) return { ok: true, target: null };

  try {
    const { data, error } = await supabase
      .from(DECISIONS_TABLE)
      .select('target_allocation')
      .eq('status', 'decided')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);

    const row = (data ?? [])[0] as { target_allocation: unknown } | undefined;
    if (!row) return { ok: true, target: null }; // genuinely the first decision on record

    const target = row.target_allocation;
    if (target == null || typeof target !== 'object' || Array.isArray(target)) {
      // A `decided` row is CHECK-constrained to have a target_allocation, so this means
      // the column holds something the guard cannot compare. Refusing is safer than
      // coercing: a mangled reference would silently reject every subsequent hold.
      console.error(
        `[CRITICAL] the last decided row has an unusable target_allocation (${JSON.stringify(target)}) — ` +
          'the coherence guard has no reference to compare against.',
      );
      return { ok: false, target: null };
    }

    const numeric: Record<string, number> = {};
    for (const [asset, value] of Object.entries(target as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        console.error(
          `[CRITICAL] the last decided row's target_allocation["${asset}"] is not a finite number ` +
            `(${JSON.stringify(value)}) — the coherence guard has no usable reference.`,
        );
        return { ok: false, target: null };
      }
      numeric[asset] = value;
    }
    return { ok: true, target: numeric };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[CRITICAL] could not read the reference target (${msg}).`);
    return { ok: false, target: null };
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
