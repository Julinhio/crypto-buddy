import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import {
  recordHeartbeat,
  claimDueRun,
  countFailedRunsSince,
  finishRun,
  readIncidentState,
} from '../persistence/schedulerState.js';
import type { EquitySnapshotInsert } from '../persistence/equitySnapshots.js';
import { armCycleWatchdog, runGuardedCycle, type GuardedCycle } from './cycleGuard.js';
import {
  canClaim,
  classifyOutcome,
  evaluateAlert,
  evaluateDegradedIncident,
  evaluateRecovery,
  missedBeats,
  nextBlindCycles,
  nextConsecutiveFailures,
  nextDelayMinutes,
  nextFloorStreak,
  type RunOutcome,
} from './policy.js';
import type { AlertPayload } from '../alerting/messages.js';
import { prepareActivityNotification, type ActivityNotification } from '../alerting/activity.js';

export interface HeartbeatResult {
  /**
   * - 'noop'      : not due / locked / claim lost — nothing ran.
   * - 'ran'       : a cycle ran and was finalized (reschedule + release + close).
   * - 'timed-out' : the cycle exceeded its budget (a freeze). The lock is KEPT (not
   *                 released) and NOT rescheduled — recovery is via the expired lease,
   *                 exactly like a crash. beat.ts exits non-zero on this without
   *                 pinging Healthchecks (a frozen beat is not healthy).
   */
  action: 'noop' | 'ran' | 'timed-out';
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
   * Absent on a no-op/timed-out beat (no finalized cycle); null when the wake-up warranted none.
   */
  equitySnapshot?: EquitySnapshotInsert | null;
  /**
   * Best-effort activity notification for THIS beat — SENT by beat.ts best-effort,
   * same tier as the alerts. Non-null ONLY when the cycle actually booked movements
   * (a hold/skip/error → null → nothing sent, no spam).
   */
  activityNotification?: ActivityNotification | null;
}

/**
 * ONE beat of the scheduler. The fixed external cron calls this every few minutes;
 * it decides whether it's time to actually run a decision cycle.
 *
 *   1. record liveness (every beat);
 *   2. cheap pre-check (DB time): no-op fast when not due or locked;
 *   3. ATOMIC claim of the run-lock — only the winner proceeds;
 *   4. run the cycle ONCE (no catch-up) under a hard timeout, with an anti-freeze
 *      WATCHDOG armed before the claim;
 *   5a. SETTLED (returned or threw) → compute the next state (pure policy) and
 *       finalize atomically: reschedule (ALWAYS, whatever the outcome), release the
 *       lock, mark the run done;
 *   5b. TIMED OUT (the cycle froze, an orphan may still be writing) → do NOT
 *       finalize: keep the lock and don't reschedule. The lock expires at its TTL
 *       and a later beat reclaims via the expired lease — exactly a crash's
 *       recovery — while the watchdog guarantees the process exits before then so
 *       the orphan can't place an order once a reclaimer starts. This is the beat
 *       half of the anti-double-trade guard (the order-side complement of the
 *       per-movement idempotency key, PR #13).
 *
 * Reschedule happens LAST, after the work, so a crash mid-cycle never jumps the
 * schedule forward; the expiring lock lets a later beat reclaim a crashed run.
 *
 * Infra/config faults THROW (the wrappers propagate RPC errors, and a missing
 * Supabase client throws here) so the process exits non-zero and the platform
 * detects the outage — the exit code is our first line of monitoring. `supabase`
 * and `runCycle` can be injected for tests; production passes neither.
 */
export async function runHeartbeat(
  deps: { supabase?: SupabaseClient | null; runCycle?: () => Promise<GuardedCycle> } = {},
): Promise<HeartbeatResult> {
  const supabase = 'supabase' in deps ? deps.supabase ?? null : getSupabaseClient();
  if (!supabase) {
    // A missing Supabase client is a CONFIGURATION error (same posture as a missing
    // ANTHROPIC_API_KEY) — fail loud, never a quiet code-0 no-op.
    throw new Error('Supabase not configured — the scheduler needs persistent state to claim/lock.');
  }
  const runCycle = deps.runCycle ?? (() => runGuardedCycle());

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

  // Arm the anti-freeze WATCHDOG before the claim — the lock's life begins at the
  // claim's DB commit, so a stall on the claim/cycle/finalize path could otherwise
  // hold (or have reclaimed) the lock with no guard. It force-exits before the TTL,
  // independent of any await. Disarmed on EVERY return path via the finally.
  const disarmWatchdog = armCycleWatchdog('beat');
  try {
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
    //    under the hard timeout, capturing whether it SETTLED (returned/threw → no
    //    orphan) or timed out (an orphan keeps running in the background).
    /*
     * THE CYCLE'S OWN ELAPSED TIME, anchored on the DATABASE's clock.
     *
     * `claim.dbNow` is the claim instant, which PRECEDES the whole cycle — using it as the
     * recovery's completion time would date the all-clear before the decision that caused
     * it existed, and would understate the outage by the cycle's full runtime (93 s on the
     * 20/08 recovery, and up to the 300 s budget on a slow one). The brief measures the
     * outage "until the completion of the new decided cycle", so the completion instant is
     * what it must be.
     *
     * `finish_run` returns only a boolean, so there is no DB completion timestamp to read
     * without a migration. Instead: the DB anchor PLUS a locally measured DURATION. A
     * duration is immune to clock skew between the app and the database, which a bare
     * `Date.now()` would not be — so this stays on the DB's timeline rather than silently
     * mixing two clocks.
     */
    const cycleStartedLocalMs = Date.now();
    const { outcome, settled, result } = await runCycle();
    const cycleElapsedMs = Date.now() - cycleStartedLocalMs;
    const {
      status,
      appliedDelayMinutes: appliedDelay,
      decisionId,
      detail,
      equitySnapshot,
      marketData,
      llmFailure,
    } = outcome;

    // 5b. TIMED OUT → crash behavior. Do NOT finish_run: KEEP the lock and do NOT
    //     reschedule. The lock expires at its TTL and a later beat reclaims via the
    //     expired lease; the orphan (which a promise race can't cancel) may still be
    //     writing, so releasing/rescheduling here would reopen the very window this
    //     closes. beat.ts exits non-zero on this result (no Healthchecks ping — a
    //     frozen beat is not healthy), and the watchdog is the await-independent
    //     backstop that guarantees the exit before the TTL. The scheduler_runs row
    //     is deliberately left 'running' (the crash signature) for audit.
    if (!settled) {
      console.error(
        `[beat] run #${claim.runId} TIMED OUT — KEEPING the run-lock (a background orphan may still write) ` +
          `and NOT rescheduling. The lock expires at its TTL and a later beat reclaims via the expired lease ` +
          `(crash recovery). Forcing a non-zero exit so the orphan dies before then.`,
      );
      return { action: 'timed-out', reason: 'cycle-timeout' };
    }

    if (status === 'error' || status === 'parse_failed' || status === 'guard_failed') {
      console.error(`[error] cycle did not complete cleanly — ${detail}`);
    }

    // Activity notification (best-effort, sent by beat.ts): non-null ONLY when the
    // cycle actually booked movements at the ledger — a hold/skip/error/throw yields
    // null → nothing sent (no spam). Built from the LEDGER fact, never action_type;
    // the claim time dates it, like the alerts.
    const activityNotification = result ? prepareActivityNotification(result, claim.dbNow) : null;

    // 5a. Pure policy → the next state. Reschedule ALWAYS, whatever the outcome.
    const runOutcome = classifyOutcome(status);
    const succeeded = runOutcome === 'decided';
    const failuresAfter = nextConsecutiveFailures(claim.consecutiveFailures, runOutcome);
    const delayMinutes = nextDelayMinutes(runOutcome, {
      appliedDelayMinutes: appliedDelay,
      failuresAfter,
      softSkipDelayMinutes: config.scheduler.softSkipDelayMinutes,
      minDelayMinutes: config.decision.minDelayMinutes,
      maxDelayMinutes: config.decision.maxDelayMinutes,
      // THE TYPED CLASS, straight from the decision layer. Not parsed from `detail`, not
      // re-read from `decisions.raw_response`, not re-classified here — the scheduler is a
      // CONSUMER of the classification, never a second source of it. That is what makes
      // rewording an error message provably unable to move the backoff.
      failureClass: llmFailure?.failureClass ?? null,
      retryableLlmTransportMaxDelayMinutes: config.decision.retryableLlmTransportMaxDelayMinutes,
    });
    const floorStreak = nextFloorStreak(claim.floorDelayStreak, runOutcome, appliedDelay, config.decision.minDelayMinutes);

    // Per-trigger alert debounce (pure). The PREVIOUS flags come from `state` — the
    // record_heartbeat snapshot at the very top of this beat — and only finishRun
    // (us, fencing-guarded) rewrites them, so that snapshot is still current here.
    const floorAlert = evaluateAlert(floorStreak, config.alerting.floorStreakThreshold, state.floorAlertSent);
    // The degraded trigger is now an INCIDENT LIFECYCLE, not a threshold comparison: armed
    // on the crossing, held across `skipped` cycles (which reset the counter without
    // producing a decision), closed only by a real one. `evaluateAlert` still drives the
    // overheating trigger unchanged — its counter only moves on a decided cycle, so it
    // never had this problem. See evaluateDegradedIncident.
    //
    // The two inputs are re-read UNDER THE CLAIM when the snapshot says an incident is
    // open. `reset_bot` can land between `record_heartbeat` and the claim and clear both;
    // with the flag now meaning "an incident is open" rather than "the counter is high",
    // a stale `true` would STICK — swallowing the next real degraded alert and firing a
    // phantom recovery quoting a pre-reset duration. Only that direction is possible
    // (reset only ever writes `false`, and only our own fenced `finish_run` writes `true`),
    // so a healthy beat pays for no extra read. Best-effort: on a failed read we fall back
    // to the snapshot, i.e. to the behaviour that shipped before.
    const incidentState = state.failureAlertSent ? await readIncidentState(supabase) : null;
    const incidentArmedBefore = incidentState?.failureAlertSent ?? state.failureAlertSent;
    const previousSuccessAt = incidentState ? incidentState.lastSuccessAt : state.lastSuccessAt;
    const failureIncident = evaluateDegradedIncident(
      runOutcome,
      failuresAfter,
      config.alerting.consecutiveFailuresThreshold,
      incidentArmedBefore,
    );

    // THE SECOND HEALTH STATE. Same shape as the two above — a counter, one pure debounce
    // evaluation, one flag persisted in the same fenced transaction — because the brief
    // asks for the same anti-spam behaviour and reusing the mechanism is the only way to
    // be sure it behaves identically. 22 consecutive blind cycles must produce ONE
    // message, not 22.
    //
    // The one addition is the DOWNWARD crossing: `market_data` can stay armed for hours,
    // so its recovery is worth announcing. It is evaluated against the SAME pair of values
    // as the upward one, so the two can never both fire on one beat.
    // Both previous values come from `claim`, NOT from the pre-cycle `state` snapshot the
    // two triggers above use. `reset_bot` can land between record_heartbeat and the claim:
    // it zeroes these columns and reschedules to now(), so the claim still succeeds while
    // the snapshot holds pre-reset values — and we would then write back an outage streak
    // the reset had just erased, and possibly fire an obsolete alert. Reading under the
    // claim closes that: once we hold the run-lock, reset_bot (which claims the same lock)
    // cannot interleave.
    const blindAfter = nextBlindCycles(claim.consecutiveBlindCycles, marketData);
    const blindAlert = evaluateAlert(blindAfter, config.alerting.blindCyclesThreshold, claim.blindAlertSent);
    const blindRecovered = evaluateRecovery(
      blindAfter,
      config.alerting.blindCyclesThreshold,
      claim.blindAlertSent,
    );

    const finalized = await finishRun(supabase, {
      runToken,
      runId: claim.runId,
      delayMinutes,
      consecutiveFailures: failuresAfter,
      floorDelayStreak: floorStreak,
      succeeded,
      outcome: runOutcome,
      decisionId,
      missedBeats: missed,
      detail,
      // Intent-first: persist the re-armed/armed flags in the SAME fenced transaction
      // as the counters. A send that later fails just loses that one alert (no spam);
      // a reclaimed run can't write these (fencing) so it won't send below either.
      floorAlertSent: floorAlert.sent,
      // Intent-first for the recovery too: the incident is DISARMED in this same fenced
      // transaction, before any send. A Telegram failure then costs one notification, not
      // a message that repeats on every later beat.
      failureAlertSent: failureIncident.armed,
      consecutiveBlindCycles: blindAfter,
      blindAlertSent: blindAlert.sent,
      // Only a KNOWN answer touches `last_market_data_ok_at`; 'unknown' passes null and
      // the timestamp keeps whatever it had. Mirrors nextBlindCycles' three-way handling.
      sawMarketData: marketData === 'unknown' ? null : marketData === 'sighted',
    });

    if (!finalized) {
      console.warn(
        `[warn] run #${claim.runId} lost its lock before finalizing (it overran and was reclaimed). ` +
          'The reclaiming run owns rescheduling; the cycle still ran.',
      );
      // Do NOT alert on the fencing path: the flags were not persisted (the fenced
      // UPDATE affected 0 rows), so the reclaiming run owns the alert evaluation. The
      // activity notification still reflects what THIS cycle actually booked.
      return { action: 'ran', reason: runOutcome, outcome: runOutcome, delayMinutes, missedBeats: missed, lockLost: true, equitySnapshot, activityNotification };
    }

    // Build the alerts that crossed UP on this beat (at most one per trigger). The DB
    // claim time is the timestamp; the degraded alert carries the last cycle's error.
    const alerts: AlertPayload[] = [];
    if (floorAlert.fire) {
      alerts.push({ trigger: 'overheating', value: floorStreak, timestamp: claim.dbNow });
    }
    if (failureIncident.fire) {
      alerts.push({ trigger: 'degraded', value: failuresAfter, timestamp: claim.dbNow, lastError: detail });
    }
    if (failureIncident.recovered) {
      // THE ONLY PLACE THE HISTORY IS RE-READ, and only once a recovery is genuinely
      // candidate: an incident really was alerted, and this cycle really did decide. Both
      // reads are best-effort and neither can fail the cycle — the orders are already
      // placed and the ledger already booked by the time we get here.
      //
      // `previousSuccessAt` is the PREVIOUS valid decision — the pre-cycle snapshot, or the
      // value re-read under the claim when a reset may have moved it. finish_run has just
      // overwritten the column with THIS run's success, so it is the only remaining witness
      // of where the outage started. Null (never a success, or a reset) → the duration is
      // reported as unknown, never invented.
      //
      // The end of the outage is the CYCLE'S COMPLETION, not the claim: DB anchor plus the
      // locally measured cycle duration. Dating it at `claim.dbNow` would announce the
      // all-clear before the decision that justifies it existed.
      const previousSuccessMs = previousSuccessAt ? Date.parse(previousSuccessAt) : NaN;
      const claimedAtMs = Date.parse(claim.dbNow);
      const recoveredAtMs = Number.isNaN(claimedAtMs) ? NaN : claimedAtMs + cycleElapsedMs;
      const outageMs =
        Number.isNaN(previousSuccessMs) || Number.isNaN(recoveredAtMs)
          ? null
          : recoveredAtMs - previousSuccessMs;
      // The query's upper bound stays `claim.dbNow` — a genuine DB timestamp rather than a
      // derived one, and no run can complete inside the window anyway: we hold the lock,
      // and this run itself is `decided`, not `error`.
      const failureCount = await countFailedRunsSince(supabase, previousSuccessAt, claim.dbNow);
      alerts.push({
        trigger: 'degraded_recovered',
        timestamp: Number.isNaN(recoveredAtMs) ? claim.dbNow : new Date(recoveredAtMs).toISOString(),
        failureCount,
        outageMs,
      });
    }
    if (blindAlert.fire) {
      // `detail` carries the cycle's own status string, which on a blind cycle is
      // `status=skipped` — the very poverty this PR set out to fix. The structured cause
      // (ccxt class / HTTP status / endpoint) lives in `market_data_incidents`, written by
      // the cycle itself; the message points there rather than restating a useless string.
      alerts.push({ trigger: 'market_data', value: blindAfter, timestamp: claim.dbNow, cause: null });
    }
    if (blindRecovered) {
      // Counted and reported SEPARATELY from the alerts in the proof: a recovery is not a
      // problem being announced, and lumping the two would make "3 alerts" ambiguous.
      alerts.push({
        trigger: 'market_data_recovered',
        // The streak that just ENDED — the outage's length, which is the number worth
        // reading here. `blindAfter` is 0 by definition on this path.
        value: claim.consecutiveBlindCycles,
        timestamp: claim.dbNow,
      });
    }
    if (alerts.length > 0) {
      console.warn(`[alert] ${alerts.length} threshold crossing(s) this beat: ${alerts.map((a) => a.trigger).join(', ')}.`);
    }

    console.log(
      `[beat] run #${claim.runId} done — outcome=${runOutcome}, next check in ${delayMinutes} min ` +
        `(consecutive_failures=${failuresAfter}, floor_streak=${floorStreak}, ` +
        `market_data=${marketData}, blind_cycles=${blindAfter}).`,
    );
    return { action: 'ran', reason: runOutcome, outcome: runOutcome, delayMinutes, missedBeats: missed, lockLost: false, alerts, equitySnapshot, activityNotification };
  } finally {
    // Disarm on every path: a settled finalize is done, a timeout hands off to
    // beat.ts's immediate non-zero exit (synchronous — no await to stall), and a
    // claim-refused never held the lock. The watchdog only ever fires if one of the
    // awaits ABOVE stalls past the deadline.
    disarmWatchdog();
  }
}
