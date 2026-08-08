import type { SupabaseClient } from '@supabase/supabase-js';
import { toNumericString } from '../money.js';
import type { OrderVerdict, TransitionVerdict } from '../transition/gate.js';

const TABLE = 'transition_observations';

/**
 * Journaling the transition layer's verdicts — the whole output of observe mode.
 *
 * BEST-EFFORT BY CONTRACT. It never throws and never fails a cycle. That is not
 * politeness, it is the safety property of this PR: the layer must be incapable of
 * changing what the bot does, and a writer that could reject a cycle would be exactly
 * that — a purely observational component with the power to stop a trade. So a failed
 * write costs the observation and nothing else.
 *
 * Not swallowed either. A lost row is a real, non-self-healing loss of the evidence the
 * blocking decision will be taken on, so the payload is dumped to the logs where it is at
 * least recoverable. Same posture as `recordGuardEvent` and `savePositionStates`.
 */

export interface TransitionOrderJudgement {
  side: 'buy' | 'sell';
  /** Notional at the valuation price, in quote. */
  notional: string;
  verdict: OrderVerdict;
  reason: string;
}

export interface TransitionObservationInsert {
  decision_id: number;
  asset: string;
  bar_at: string | null;
  actionable: boolean;
  confirmed_regime: string | null;
  raw_regime: string | null;
  run_length: number;
  label_run: number;
  risk_off: boolean;
  stop_armed: boolean;
  stop_would_fire: boolean;
  stop_threshold_percent: number;
  peak_price: string | null;
  price: string | null;
  drawdown_from_peak_percent: number | null;
  stop_abstained_reason: string | null;
  gate: TransitionVerdict['gate'];
  gate_reason: string;
  order_side: 'buy' | 'sell' | null;
  order_notional: string | null;
  order_verdict: OrderVerdict | null;
  order_reason: string | null;
}

/** Shapes one verdict (plus the order it judged, if any) into its row. */
export function toObservationRow(
  decisionId: number,
  verdict: TransitionVerdict,
  order: TransitionOrderJudgement | null,
): TransitionObservationInsert {
  return {
    decision_id: decisionId,
    asset: verdict.asset,
    bar_at: verdict.barAtMs == null ? null : new Date(verdict.barAtMs).toISOString(),
    actionable: verdict.actionable,
    confirmed_regime: verdict.confirmedRegime,
    raw_regime: verdict.rawRegime,
    run_length: verdict.runLength,
    label_run: verdict.labelRun,
    risk_off: verdict.riskOff,
    stop_armed: verdict.stopArmed,
    stop_would_fire: verdict.stopWouldFire,
    stop_threshold_percent: verdict.stopThresholdPercent,
    // Money goes to `numeric` as a full-precision string, never as an IEEE-754 float.
    peak_price: verdict.peakPrice == null ? null : toNumericString(verdict.peakPrice),
    price: verdict.price == null ? null : toNumericString(verdict.price),
    drawdown_from_peak_percent: verdict.drawdownFromPeakPercent,
    stop_abstained_reason: verdict.stopAbstainedReason,
    gate: verdict.gate,
    gate_reason: verdict.gateReason,
    order_side: order?.side ?? null,
    order_notional: order?.notional ?? null,
    order_verdict: order?.verdict ?? null,
    order_reason: order?.reason ?? null,
  };
}

/**
 * HARD DEADLINE on the observational write.
 *
 * A try/catch does not make a write best-effort — it only handles the ones that FINISH.
 * A request Supabase accepts but never settles would hang the `await` inside `decide()`,
 * burn the cycle budget, and let `armCycleWatchdog` force-exit the process at
 * `maxCycleSeconds + grace` — potentially after the decision was journaled and the orders
 * were placed. The cycle would then be recorded as a failure and the scheduler would back
 * off, which means a purely observational layer would have changed operational behaviour.
 * That is exactly what this brick promises it cannot do, and it is the same hazard
 * `decide()` already documents when it refuses to await guard events before execution.
 *
 * 5s is generous for a four-row upsert (the whole v5 corpus writes in well under that) and
 * negligible against the 300s cycle budget, so a healthy write is never cut short and an
 * unhealthy one cannot matter.
 */
const WRITE_DEADLINE_MS = 5_000;

/**
 * Writes this cycle's observations, one row per tradable asset.
 *
 * UPSERT on (decision_id, asset) rather than insert: a cycle writes its observations
 * once, but making the write idempotent means a retried or duplicated call cannot fail on
 * the unique constraint and lose the whole batch over a row that was already correct.
 *
 * Returns whether the batch landed, for the caller's log — never for control flow.
 */
export async function saveTransitionObservations(
  supabase: SupabaseClient | null,
  rows: TransitionObservationInsert[],
): Promise<boolean> {
  if (rows.length === 0) return true;
  if (!supabase) {
    console.warn(
      `[warn] Supabase not configured — ${rows.length} transition observation(s) NOT journaled.`,
    );
    return false;
  }
  try {
    const query = supabase
      .from(TABLE)
      .upsert(rows, { onConflict: 'decision_id,asset' })
      // The clean cancellation: postgrest-js aborts the underlying fetch and the promise
      // rejects, which the catch below turns into a logged, non-fatal miss.
      .abortSignal(AbortSignal.timeout(WRITE_DEADLINE_MS));

    // The backstop, because the guarantee must not depend on the client honouring the
    // signal. Rejection is folded into the VALUE rather than caught away: a bare
    // `.catch(() => undefined)` would make a failed write indistinguishable from a
    // successful one and quietly report every error as a success. Handling both settle
    // paths here also means a late rejection from a query the race abandoned can never
    // surface as an unhandled rejection mid-cycle.
    type Outcome =
      | { kind: 'settled'; result: { error: { message: string } | null } }
      | { kind: 'failed'; error: unknown }
      | { kind: 'timeout' };

    const settled: Promise<Outcome> = Promise.resolve(query).then(
      (result) => ({ kind: 'settled', result: result as { error: { message: string } | null } }),
      (error: unknown) => ({ kind: 'failed', error }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Outcome>((resolve) => {
      // Deliberately NOT unref'd: this timer is the only thing that can resolve the race
      // when the query never settles, and an unref'd one lets Node exit the moment the
      // hung await is all that is left — turning "return on the deadline" into "the
      // process quietly ends". It is cleared in `finally`, so on the fast path it holds
      // the loop for microseconds and on the slow path for at most the deadline.
      timer = setTimeout(() => resolve({ kind: 'timeout' }), WRITE_DEADLINE_MS);
    });

    try {
      const outcome = await Promise.race([settled, deadline]);
      if (outcome.kind === 'timeout') {
        throw new Error(`write did not settle within ${WRITE_DEADLINE_MS}ms — abandoned`);
      }
      if (outcome.kind === 'failed') throw outcome.error;
      if (outcome.result?.error) throw new Error(outcome.result.error.message);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[CRITICAL] ${rows.length} transition observation(s) were NOT journaled (${msg}) — ` +
        `payload: ${JSON.stringify(rows)}. The cycle is unaffected (the layer blocks nothing), ` +
        'but this is the evidence base the blocking decision rests on, so it is dumped here.',
    );
    return false;
  }
}
