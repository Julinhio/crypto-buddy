import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { decide } from '../decision/decide.js';
import { recordHeartbeat, claimDueRun, finishRun } from '../persistence/schedulerState.js';
import {
  canClaim,
  classifyOutcome,
  missedBeats,
  nextConsecutiveFailures,
  nextDelayMinutes,
  nextFloorStreak,
  type CycleStatus,
  type RunOutcome,
} from './policy.js';

export interface HeartbeatResult {
  action: 'noop' | 'ran';
  reason: string;
  outcome?: RunOutcome;
  delayMinutes?: number;
  missedBeats?: number;
  lockLost?: boolean;
}

/**
 * ONE beat of the scheduler. The fixed external cron calls this every few minutes;
 * it decides whether it's time to actually run a decision cycle.
 *
 *   1. record liveness (every beat);
 *   2. cheap pre-check (DB time): no-op fast when not due or locked;
 *   3. ATOMIC claim of the run-lock — only the winner proceeds;
 *   4. run the cycle ONCE (no catch-up of missed beats);
 *   5. compute the next state (pure policy) and finalize atomically: reschedule
 *      (ALWAYS, whatever the outcome), release the lock, mark the run done.
 *
 * Reschedule happens LAST, after the work, so a crash mid-cycle never jumps the
 * schedule forward; the expiring lock lets a later beat reclaim a crashed run.
 *
 * Infra/config faults THROW (the wrappers propagate RPC errors, and a missing
 * Supabase client throws here) so the process exits non-zero and the platform
 * detects the outage — the exit code is our first line of monitoring. `supabase`
 * can be injected for tests; production passes nothing and uses getSupabaseClient().
 */
export async function runHeartbeat(
  deps: { supabase?: SupabaseClient | null } = {},
): Promise<HeartbeatResult> {
  const supabase = 'supabase' in deps ? deps.supabase ?? null : getSupabaseClient();
  if (!supabase) {
    // A missing Supabase client is a CONFIGURATION error (same posture as a missing
    // ANTHROPIC_API_KEY) — fail loud, never a quiet code-0 no-op.
    throw new Error('Supabase not configured — the scheduler needs persistent state to claim/lock.');
  }

  // 1. Liveness on every beat — and read the state to decide what to do (DB time).
  //    recordHeartbeat throws on any infra fault (→ non-zero exit), so state is set.
  const state = await recordHeartbeat(supabase);

  // 2. Cheap pre-check against the DATABASE's clock (last_heartbeat_at = now()).
  const nowMs = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : Date.now();
  const nextMs = state.nextCheckAt ? Date.parse(state.nextCheckAt) : null;
  const lockMs = state.lockedUntil ? Date.parse(state.lockedUntil) : null;
  if (!canClaim({ nextCheckAtMs: nextMs, lockedUntilMs: lockMs }, nowMs)) {
    const reason = lockMs != null && lockMs > nowMs ? 'locked' : 'not-due';
    console.log(`[beat] no-op (${reason}) — next_check=${state.nextCheckAt ?? 'now'} locked_until=${state.lockedUntil ?? '—'}.`);
    return { action: 'noop', reason };
  }

  // 3. The atomic claim is authoritative (it re-checks under a row lock, closing
  //    the race between step 2 and now). null → another beat won, or it just locked.
  const runToken = randomUUID();
  const claim = await claimDueRun(supabase, runToken, config.scheduler.lockTtlSeconds);
  if (!claim) {
    console.log('[beat] no-op (claim refused — another beat won it, or it became locked).');
    return { action: 'noop', reason: 'claim-lost' };
  }

  const missed = missedBeats(
    claim.prevNextCheckAt ? Date.parse(claim.prevNextCheckAt) : null,
    Date.parse(claim.dbNow),
    config.scheduler.beatIntervalMinutes,
  );
  console.log(`[beat] claimed run #${claim.runId} (token ${runToken}); missed_beats=${missed}. Running the cycle…`);

  // 4. Run the cycle exactly ONCE on the current market — no replay of missed beats.
  let status: CycleStatus;
  let appliedDelay: number | null = null;
  let decisionId: number | null = null;
  let detail: string;
  try {
    const result = await decide();
    status = result.status;
    appliedDelay = result.row.applied_delay_minutes ?? null;
    decisionId = result.decisionId;
    detail = `status=${status}`;
  } catch (err) {
    // decide() handles its own internal errors; a throw here is an unexpected hard
    // failure → treat as a technical error (backoff).
    status = 'error';
    detail = `cycle threw: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[error] decision cycle threw — recording a hard error. ${detail}`);
  }

  // 5. Pure policy → the next state. Reschedule ALWAYS, whatever the outcome.
  const outcome = classifyOutcome(status);
  const succeeded = outcome === 'decided';
  const failuresAfter = nextConsecutiveFailures(claim.consecutiveFailures, outcome);
  const delayMinutes = nextDelayMinutes(outcome, {
    appliedDelayMinutes: appliedDelay,
    failuresAfter,
    softSkipDelayMinutes: config.scheduler.softSkipDelayMinutes,
    minDelayMinutes: config.decision.minDelayMinutes,
    maxDelayMinutes: config.decision.maxDelayMinutes,
  });
  const floorStreak = nextFloorStreak(claim.floorDelayStreak, outcome, appliedDelay, config.decision.minDelayMinutes);

  const finalized = await finishRun(supabase, {
    runToken,
    runId: claim.runId,
    delayMinutes,
    consecutiveFailures: failuresAfter,
    floorDelayStreak: floorStreak,
    succeeded,
    outcome,
    decisionId,
    missedBeats: missed,
    detail,
  });

  if (!finalized) {
    console.warn(
      `[warn] run #${claim.runId} lost its lock before finalizing (it overran and was reclaimed). ` +
        'The reclaiming run owns rescheduling; the cycle still ran.',
    );
    return { action: 'ran', reason: outcome, outcome, delayMinutes, missedBeats: missed, lockLost: true };
  }

  console.log(
    `[beat] run #${claim.runId} done — outcome=${outcome}, next check in ${delayMinutes} min ` +
      `(consecutive_failures=${failuresAfter}, floor_streak=${floorStreak}).`,
  );
  return { action: 'ran', reason: outcome, outcome, delayMinutes, missedBeats: missed, lockLost: false };
}
