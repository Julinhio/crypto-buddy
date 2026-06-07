import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { decide, type DecideResult } from '../decision/decide.js';
import { recordHeartbeat, claimDueRun, finishRun } from '../persistence/schedulerState.js';
import { prepareEquitySnapshot, type EquitySnapshotInsert } from '../persistence/equitySnapshots.js';
import {
  canClaim,
  classifyOutcome,
  evaluateAlert,
  missedBeats,
  nextConsecutiveFailures,
  nextDelayMinutes,
  nextFloorStreak,
  type CycleStatus,
  type RunOutcome,
} from './policy.js';
import type { AlertPayload } from '../alerting/messages.js';

export interface HeartbeatResult {
  action: 'noop' | 'ran';
  reason: string;
  outcome?: RunOutcome;
  delayMinutes?: number;
  missedBeats?: number;
  lockLost?: boolean;
  /**
   * Internal alerts that crossed their threshold on THIS beat (debounced — at most
   * one per trigger). The caller (beat.ts) sends them best-effort; the debounce
   * flags are already persisted by finishRun, so a failed send is never retried.
   */
  alerts?: AlertPayload[];
  /**
   * Best-effort equity photo for THIS beat's cycle, to be WRITTEN by beat.ts after
   * the beat's real work — outside the timed cycle, same tier as Telegram/Healthchecks.
   * Absent on a no-op beat (no cycle ran); null when the wake-up warranted none.
   */
  equitySnapshot?: EquitySnapshotInsert | null;
}

/** The cycle's result, normalized — a timeout or a throw both become a technical error. */
export interface CycleOutcome {
  status: CycleStatus;
  appliedDelayMinutes: number | null;
  decisionId: number | null;
  detail: string;
  /**
   * The equity photo to write best-effort AFTER the verdict is sealed. PREPARED
   * here (pure, no I/O — safe inside the timed wrapper) but WRITTEN outside it, so
   * the stall-capable write can never lose the timeout race. Null when the wake-up
   * warrants none (skipped) or the cycle didn't return a valued book (timeout/throw).
   */
  equitySnapshot: EquitySnapshotInsert | null;
}

/**
 * Runs the cycle under a HARD timeout (= maxCycleSeconds). This is the catch-all
 * that bounds the cycle no matter what happens inside decide() — beyond the
 * per-call ccxt/Anthropic timeouts — so the run-lock provably cannot expire while
 * a cycle is still alive (with lockTtl > maxCycleSeconds), closing the door on a
 * parallel beat reclaiming and double-executing.
 *
 * Caveat handled by the caller: a promise-race timeout does NOT cancel the
 * underlying work — decide() keeps running in the background. A timeout (or a
 * throw) is recorded as a technical error (→ backoff), and `beat.ts` force-exits
 * the one-shot process so no orphaned cycle can act after the lock is released.
 * Any partial work is already covered by PR B's booking-first replay safety.
 */
export async function runCycleWithTimeout(
  decideFn: () => Promise<DecideResult>,
  timeoutMs: number,
): Promise<CycleOutcome> {
  const cyclePromise = decideFn();
  // Swallow a LATE rejection from an orphaned (already-timed-out) cycle so it
  // can't surface as an unhandledRejection before the process exits.
  cyclePromise.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const raced = await Promise.race([cyclePromise, timeout]);
    if (raced === 'timeout') {
      return {
        status: 'error',
        appliedDelayMinutes: null,
        decisionId: null,
        detail: `cycle exceeded the ${Math.round(timeoutMs / 1000)}s budget — treated as a technical error (backoff)`,
        // Timed out → decide() never returned a valued book; nothing to photograph.
        equitySnapshot: null,
      };
    }
    return {
      status: raced.status,
      appliedDelayMinutes: raced.row.applied_delay_minutes ?? null,
      decisionId: raced.decisionId,
      detail: `status=${raced.status}`,
      // PURE prepare only (object mapping, no I/O). The WRITE happens outside this
      // raced promise (beat.ts / CLI), so it can never weigh on the verdict above.
      equitySnapshot: prepareEquitySnapshot(raced.status, raced.decisionId, raced.portfolio),
    };
  } catch (err) {
    // Capture the STACK (not just the message) for the post-mortem in scheduler_runs.
    return {
      status: 'error',
      appliedDelayMinutes: null,
      decisionId: null,
      detail: `cycle threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      // Threw before returning a valued book → nothing to photograph.
      equitySnapshot: null,
    };
  } finally {
    // Essential: clear the timer on the resolve path, else a pending 5-min timer
    // would keep the event loop alive long after the cycle finished.
    if (timer) clearTimeout(timer);
  }
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
  //    Guard a NaN parse on the reference time by falling back to the app clock —
  //    this pre-check is only an optimization/log; the SQL claim is the authority
  //    on due-ness, so a slightly-off reference here can never cause a double run.
  const parsedNow = state.lastHeartbeatAt ? Date.parse(state.lastHeartbeatAt) : NaN;
  const nowMs = Number.isNaN(parsedNow) ? Date.now() : parsedNow;
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

  // 4. Run the cycle exactly ONCE on the current market (no replay of missed beats),
  //    under a hard timeout = maxCycleSeconds. A timeout or a throw → technical
  //    error (backoff); beat.ts force-exits afterwards so a timed-out cycle can't
  //    keep running and act after the lock is released.
  const { status, appliedDelayMinutes: appliedDelay, decisionId, detail, equitySnapshot } = await runCycleWithTimeout(
    decide,
    config.scheduler.maxCycleSeconds * 1000,
  );
  if (status === 'error' || status === 'parse_failed') {
    console.error(`[error] cycle did not complete cleanly — ${detail}`);
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

  // Per-trigger alert debounce (pure). The PREVIOUS flags come from `state` — the
  // record_heartbeat snapshot at the very top of this beat — and only finishRun
  // (us, fencing-guarded) rewrites them, so that snapshot is still current here.
  const floorAlert = evaluateAlert(floorStreak, config.alerting.floorStreakThreshold, state.floorAlertSent);
  const failureAlert = evaluateAlert(failuresAfter, config.alerting.consecutiveFailuresThreshold, state.failureAlertSent);

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
    // Intent-first: persist the re-armed/armed flags in the SAME fenced transaction
    // as the counters. A send that later fails just loses that one alert (no spam);
    // a reclaimed run can't write these (fencing) so it won't send below either.
    floorAlertSent: floorAlert.sent,
    failureAlertSent: failureAlert.sent,
  });

  if (!finalized) {
    console.warn(
      `[warn] run #${claim.runId} lost its lock before finalizing (it overran and was reclaimed). ` +
        'The reclaiming run owns rescheduling; the cycle still ran.',
    );
    // Do NOT alert on the fencing path: the flags were not persisted (the fenced
    // UPDATE affected 0 rows), so the reclaiming run owns the alert evaluation.
    return { action: 'ran', reason: outcome, outcome, delayMinutes, missedBeats: missed, lockLost: true, equitySnapshot };
  }

  // Build the alerts that crossed UP on this beat (at most one per trigger). The DB
  // claim time is the timestamp; the degraded alert carries the last cycle's error.
  const alerts: AlertPayload[] = [];
  if (floorAlert.fire) {
    alerts.push({ trigger: 'overheating', value: floorStreak, timestamp: claim.dbNow });
  }
  if (failureAlert.fire) {
    alerts.push({ trigger: 'degraded', value: failuresAfter, timestamp: claim.dbNow, lastError: detail });
  }
  if (alerts.length > 0) {
    console.warn(`[alert] ${alerts.length} threshold crossing(s) this beat: ${alerts.map((a) => a.trigger).join(', ')}.`);
  }

  console.log(
    `[beat] run #${claim.runId} done — outcome=${outcome}, next check in ${delayMinutes} min ` +
      `(consecutive_failures=${failuresAfter}, floor_streak=${floorStreak}).`,
  );
  return { action: 'ran', reason: outcome, outcome, delayMinutes, missedBeats: missed, lockLost: false, alerts, equitySnapshot };
}
