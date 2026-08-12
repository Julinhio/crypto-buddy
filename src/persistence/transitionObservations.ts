import type { SupabaseClient } from '@supabase/supabase-js';
import { runBoundedWrite } from './boundedWrite.js';
import { toNumericString } from '../money.js';
import type { OrderVerdict, TransitionVerdict } from '../transition/gate.js';
import type { JudgedLeg, VectorJudgement } from '../transition/vector.js';

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

  /**
   * The MODEL'S VECTOR — the movement computed on this asset before execution, and the
   * population the blocking gate will act on. Kept apart from `order_*`, which stays what
   * actually booked: the two coincide on nearly every cycle and diverge exactly where it
   * matters (a venue filter, a failed booking), and a column whose meaning changes
   * halfway through a series is worse than a missing one.
   */
  leg_side: 'buy' | 'sell' | null;
  leg_notional: string | null;
  leg_verdict: JudgedLeg['verdict'] | null;
  leg_reason: string | null;

  /** Cycle-level, repeated on every row of the cycle. Null when no vector was computed. */
  atomic_refusal: boolean | null;
  atomic_trigger_asset: string | null;
}

/**
 * Shapes one verdict into its row.
 *
 * `order` is what BOOKED on this asset (null on the vast majority of rows). `vector` is
 * this cycle's judged vector — passed on every cycle that computed one, including the
 * empty vectors of the skip paths, since "examined and nothing refused" and "not examined"
 * are different facts and only the second one deserves a null.
 */
export function toObservationRow(
  decisionId: number,
  verdict: TransitionVerdict,
  order: TransitionOrderJudgement | null,
  vector: VectorJudgement | null,
): TransitionObservationInsert {
  const leg = vector?.legs.find((l) => l.asset === verdict.asset) ?? null;
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

    leg_side: leg?.side ?? null,
    leg_notional: leg == null ? null : toNumericString(leg.notional),
    leg_verdict: leg?.verdict ?? null,
    leg_reason: leg?.reason ?? null,

    // Repeated on every row of the cycle so "was this cycle's vector refused" is one
    // column read, not a join back onto the cycle's other rows.
    atomic_refusal: vector == null ? null : vector.refused,
    atomic_trigger_asset: vector?.trigger?.asset ?? null,
  };
}

/**
 * HARD DEADLINE on the observational write.
 *
 * The MECHANISM now lives in `runBoundedWrite` (persistence/boundedWrite.ts), shared with
 * the market-data incident writer, and its reasoning is documented there in full: a
 * try/catch only handles the writes that FINISH, so a request Supabase accepts and never
 * settles would burn the cycle budget and let the watchdog force-exit — a purely
 * observational layer changing operational behaviour, which is exactly what this brick
 * promises it cannot do.
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
    await runBoundedWrite(
      (signal) =>
        supabase
          .from(TABLE)
          .upsert(rows, { onConflict: 'decision_id,asset' })
          // The clean cancellation: postgrest-js aborts the underlying fetch and the
          // promise rejects, which the catch below turns into a logged, non-fatal miss.
          .abortSignal(signal),
      WRITE_DEADLINE_MS,
    );
    return true;
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
