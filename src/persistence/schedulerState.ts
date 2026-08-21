import type { SupabaseClient } from '@supabase/supabase-js';
import { ALERT_READ_DEADLINE_MS } from '../config/index.js';
import type { RunOutcome } from '../scheduler/policy.js';
import { runBoundedQuery } from './boundedWrite.js';

/** The singleton scheduler state (camelCased; timestamps as ISO strings). */
export interface BotState {
  nextCheckAt: string | null;
  runToken: string | null;
  lockedUntil: string | null;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  floorDelayStreak: number;
  /** Debounce flags (one per trigger) — the pre-cycle snapshot the heartbeat reads. */
  floorAlertSent: boolean;
  failureAlertSent: boolean;
}

/*
 * DELIBERATELY ABSENT from BotState: `consecutive_blind_cycles` and `blind_alert_sent`.
 *
 * They exist on the row (record_heartbeat returns `*`), but exposing them here would
 * re-offer the stale read this PR had to correct. `reset_bot` can land between
 * record_heartbeat and the claim — it zeroes both columns and reschedules to now(), so
 * the claim still succeeds while the snapshot holds pre-reset values, and finish_run
 * would then restore an outage streak the reset had just erased, possibly firing an
 * obsolete alert. They travel with ClaimResult instead, where the run-lock makes them
 * current by construction.
 *
 * The same race still applies to `floorAlertSent` / `failureAlertSent` above, which
 * predate this PR. Not corrected here — that would change the behaviour of existing
 * alerts, which this PR does not do — but reported alongside it.
 */

/** What `claim_due_run` returns on a successful (atomic) claim. */
export interface ClaimResult {
  runId: number;
  prevNextCheckAt: string | null;
  dbNow: string;
  consecutiveFailures: number;
  floorDelayStreak: number;
  /**
   * THE SECOND HEALTH STATE, read UNDER THE CLAIM. Consecutive cycles that saw no
   * tradable market, plus its debounce flag — carried here rather than on BotState so
   * they cannot be read from a pre-claim snapshot that `reset_bot` may have invalidated.
   * Same reason `consecutiveFailures` and `floorDelayStreak` have always come from here.
   */
  consecutiveBlindCycles: number;
  blindAlertSent: boolean;
}

export interface FinishRunParams {
  runToken: string;
  runId: number;
  delayMinutes: number;
  consecutiveFailures: number;
  floorDelayStreak: number;
  succeeded: boolean;
  outcome: RunOutcome;
  decisionId: number | null;
  missedBeats: number;
  detail: string | null;
  /** Debounce flags to persist (computed post-cycle by the pure policy). */
  floorAlertSent: boolean;
  failureAlertSent: boolean;
  /** The second health state's counter + flag (computed post-cycle by the pure policy). */
  consecutiveBlindCycles: number;
  blindAlertSent: boolean;
  /**
   * Did this cycle SEE the market? Three-valued, and only used by the SQL side to stamp
   * `last_market_data_ok_at`: true refreshes it, false and null leave it alone. The
   * counter itself is already computed by the app (a pure, offline-tested function) —
   * this exists because the timestamp must take the DATABASE's now(), exactly like
   * `last_success_at`.
   */
  sawMarketData: boolean | null;
}

function toBotState(row: Record<string, unknown>): BotState {
  return {
    nextCheckAt: (row.next_check_at as string | null) ?? null,
    runToken: (row.run_token as string | null) ?? null,
    lockedUntil: (row.locked_until as string | null) ?? null,
    lastHeartbeatAt: (row.last_heartbeat_at as string | null) ?? null,
    lastSuccessAt: (row.last_success_at as string | null) ?? null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    floorDelayStreak: Number(row.floor_delay_streak ?? 0),
    floorAlertSent: Boolean(row.floor_alert_sent ?? false),
    failureAlertSent: Boolean(row.failure_alert_sent ?? false),
  };
}

/**
 * Records liveness on EVERY beat (last_heartbeat_at = DB now()) and returns the
 * current state so the caller can decide — using DB time — whether to attempt a
 * claim.
 *
 * THROWS on any infra failure (RPC error, missing singleton). For a cron-launched
 * bot, an infra fault must fail the process hard (non-zero exit) so the platform
 * sees it — swallowing it into a null would make an outage look like a normal beat.
 */
export async function recordHeartbeat(supabase: SupabaseClient): Promise<BotState> {
  const { data, error } = await supabase.rpc('record_heartbeat');
  if (error) throw new Error(`record_heartbeat RPC failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error('record_heartbeat returned no bot_state row — is migration 0006 applied?');
  }
  return toBotState(row);
}

/**
 * The ATOMIC claim. THROWS on an infra failure (RPC error) so the beat exits
 * non-zero. Returns null ONLY for the genuine business result: the RPC succeeded
 * but did not claim (not due, or a live lock exists) — that's a safe no-op.
 */
export async function claimDueRun(
  supabase: SupabaseClient,
  runToken: string,
  lockTtlSeconds: number,
): Promise<ClaimResult | null> {
  const { data, error } = await supabase.rpc('claim_due_run', {
    p_run_token: runToken,
    p_lock_ttl_seconds: lockTtlSeconds,
  });
  if (error) throw new Error(`claim_due_run RPC failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return null; // RPC ran, claim refused: not due / locked
  return {
    runId: Number(row.run_id),
    prevNextCheckAt: (row.prev_next_check_at as string | null) ?? null,
    dbNow: String(row.db_now),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    floorDelayStreak: Number(row.floor_delay_streak ?? 0),
    consecutiveBlindCycles: Number(row.consecutive_blind_cycles ?? 0),
    blindAlertSent: Boolean(row.blind_alert_sent ?? false),
  };
}

/**
 * Reschedules + releases the lock + marks the run done, in ONE DB transaction.
 *
 * THROWS on an infra failure (RPC error). That is SAFE for recovery: the lock was
 * already written at claim time, so if the DB dies right after the cycle the
 * process exits non-zero, the lock stays posted with next_check_at in the past,
 * and once the DB is back a later beat reclaims after the lock expires (replay is
 * safe by PR B's booking-first model). We gain a VISIBLE outage, lose no recovery.
 *
 * Returns false ONLY for the genuine fencing result: the RPC ran and returned
 * false because the lock had changed hands (our run overran and was reclaimed) —
 * the reclaiming run now owns rescheduling, so the caller must not retry.
 */
export async function finishRun(supabase: SupabaseClient, p: FinishRunParams): Promise<boolean> {
  const { data, error } = await supabase.rpc('finish_run', {
    p_run_token: p.runToken,
    p_run_id: p.runId,
    p_delay_minutes: p.delayMinutes,
    p_consecutive_failures: p.consecutiveFailures,
    p_floor_delay_streak: p.floorDelayStreak,
    p_succeeded: p.succeeded,
    p_outcome: p.outcome,
    p_decision_id: p.decisionId,
    p_missed_beats: p.missedBeats,
    p_detail: p.detail,
    p_floor_alert_sent: p.floorAlertSent,
    p_failure_alert_sent: p.failureAlertSent,
    p_consecutive_blind_cycles: p.consecutiveBlindCycles,
    p_blind_alert_sent: p.blindAlertSent,
    p_saw_market_data: p.sawMarketData,
  });
  if (error) throw new Error(`finish_run RPC failed: ${error.message}`);
  return data === true;
}

/** The degraded incident's two inputs, read UNDER THE CLAIM rather than from a snapshot. */
export interface IncidentState {
  /** Is a degraded incident currently open? (`bot_state.failure_alert_sent`.) */
  failureAlertSent: boolean;
  /** The previous valid decision — where "time without a decision" starts. */
  lastSuccessAt: string | null;
}

/**
 * RE-READS THE DEGRADED INCIDENT'S STATE ONCE THE RUN-LOCK IS HELD.
 *
 * `record_heartbeat` snapshots `bot_state` at the TOP of the beat, and `reset_bot` can land
 * between that snapshot and our claim: it zeroes `failure_alert_sent`, nulls
 * `last_success_at`, purges `scheduler_runs`, and reschedules to `now()` — so our claim
 * still succeeds while the snapshot holds pre-reset values.
 *
 * That used to be harmless for this flag. `evaluateAlert` recomputed it from the counter
 * every beat, so a stale `true` was overwritten with `false` on the very next beat. Turning
 * the flag into an INCIDENT (`evaluateDegradedIncident`) removes that self-healing: a stale
 * `true` would now STICK, swallowing the degraded alert of the next real incident, and a
 * later decided cycle would fire a phantom recovery quoting a pre-reset outage duration.
 * The fix belongs here rather than in the policy, which is pure and right.
 *
 * Reading under the claim closes it, exactly as `consecutive_blind_cycles` is read from
 * `ClaimResult`: `reset_bot` claims the SAME logical run-lock and holds the `bot_state` ROW
 * lock for its whole transaction (migration 0010), so once we own the claim it provably
 * cannot interleave. Done with a plain select rather than by extending `claim_due_run` —
 * that would need a migration, which this PR does not take.
 *
 * BEST-EFFORT: returns `null` on any failure, and the caller falls back to the snapshot —
 * i.e. to the exact behaviour that shipped before. A read that exists only to keep an alert
 * honest must never be able to fail a cycle that is placing real orders.
 *
 * Only worth calling when the SNAPSHOT SAYS ARMED, because that is the only direction
 * staleness can take: `reset_bot` only ever writes `false`, and the only writer of `true` is
 * `finish_run`, which is fenced to the lock holder — us. A snapshot reading `false` while
 * the row reads `true` is therefore impossible, so the common path pays nothing.
 */
export async function readIncidentState(supabase: SupabaseClient): Promise<IncidentState | null> {
  try {
    const { data, error } = await runBoundedQuery(
      (signal) =>
        supabase
          .from('bot_state')
          .select('failure_alert_sent, last_success_at')
          .eq('id', 1)
          .abortSignal(signal)
          .maybeSingle(),
      ALERT_READ_DEADLINE_MS,
    );
    if (error || !data) {
      console.warn(
        `[warn] could not re-read the incident state under the claim (${error?.message ?? 'no bot_state row'}) — ` +
          'falling back to the pre-cycle snapshot.',
      );
      return null;
    }
    const row = data as Record<string, unknown>;
    return {
      failureAlertSent: Boolean(row.failure_alert_sent ?? false),
      lastSuccessAt: (row.last_success_at as string | null) ?? null,
    };
  } catch (err) {
    console.warn(
      `[warn] could not re-read the incident state under the claim ` +
        `(${err instanceof Error ? err.message : String(err)}) — falling back to the pre-cycle snapshot.`,
    );
    return null;
  }
}

/**
 * WHEN THE RECOVERING RUN ACTUALLY FINISHED, on the DATABASE's clock.
 *
 * `finish_run` stamps `scheduler_runs.finished_at = now()` in the same transaction that
 * releases the lock, so once it has returned true this row holds the exact instant the
 * cycle completed — readable with a plain select, no migration, no new RPC.
 *
 * It replaces an arithmetic estimate (`claim.dbNow` plus a locally measured duration),
 * which was wrong in the one direction that matters: the interval between the database
 * producing `dbNow` and the application receiving the claim response is invisible to any
 * app-side timer, so the estimate always ran EARLY — and an all-clear dated before the
 * decision that justifies it is precisely what the recovery notification must never say.
 * Reading the stamp removes the estimation instead of tightening it.
 *
 * BEST-EFFORT: `null` on any failure, and the caller falls back to the conservative
 * estimate. It exists only to date a Telegram message, on a cycle that has already placed
 * real orders.
 */
export async function readRunFinishedAt(
  supabase: SupabaseClient,
  runId: number,
): Promise<string | null> {
  try {
    const { data, error } = await runBoundedQuery(
      (signal) =>
        supabase
          .from('scheduler_runs')
          .select('finished_at')
          .eq('id', runId)
          .abortSignal(signal)
          .maybeSingle(),
      ALERT_READ_DEADLINE_MS,
    );
    if (error || !data) {
      console.warn(
        `[warn] recovery: could not read finished_at for run #${runId} ` +
          `(${error?.message ?? 'no row'}) — falling back to the estimated completion time.`,
      );
      return null;
    }
    return ((data as Record<string, unknown>).finished_at as string | null) ?? null;
  } catch (err) {
    console.warn(
      `[warn] recovery: could not read finished_at for run #${runId} ` +
        `(${err instanceof Error ? err.message : String(err)}) — falling back to the estimated completion time.`,
    );
    return null;
  }
}

/**
 * HOW MANY CYCLES REALLY FAILED DURING THE INCIDENT THAT JUST ENDED.
 *
 * The recovery message wants one number: failures between the last valid decision and this
 * one. `consecutive_failures` cannot supply it — a `skipped` cycle resets it, so after
 * `error / error / error / skip / error` the counter reads 1 for an incident that cost
 * five wake-ups. Making the counter keep non-consecutive failures would falsify the name
 * and the backoff that reads it. So the number is REBUILT from the append-only history
 * instead, which already holds every run's outcome and needs no migration to be asked.
 *
 * Window: strictly after the PREVIOUS `last_success_at` (the last decided cycle, which is
 * where "without a valid decision" starts) and up to the claim time of the recovering run.
 * Only runs that reached `completed` with the technical outcome `error` are counted — a
 * crashed run left at `running` never produced an outcome, and a `skip` is not a failure.
 *
 * BEST-EFFORT BY CONTRACT, and this is the load-bearing property. It exists solely to put
 * a number in a Telegram message, and it runs on a cycle that has just SUCCEEDED — placing
 * real orders and a sovereign booking behind it. It therefore returns `null` on every
 * failure instead of throwing: an observability read must never turn a valid financial
 * cycle into a failed one. `null` means "unavailable", never "zero", and the message says
 * so rather than printing a number nobody counted.
 */
export async function countFailedRunsSince(
  supabase: SupabaseClient,
  sinceIso: string | null,
  untilIso: string,
): Promise<number | null> {
  try {
    const { count, error } = await runBoundedQuery((signal) => {
      let query = supabase
        .from('scheduler_runs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'completed')
        .eq('outcome', 'error')
        .lte('finished_at', untilIso);
      // No previous success (a fresh install, or a reset) → no lower bound. Counting every
      // error ever recorded is still the honest answer to "since the last valid decision".
      if (sinceIso != null) query = query.gt('finished_at', sinceIso);
      return query.abortSignal(signal);
    }, ALERT_READ_DEADLINE_MS);
    if (error) {
      console.warn(`[warn] recovery: could not rebuild the failure count (${error.message}) — reporting it as unavailable.`);
      return null;
    }
    return typeof count === 'number' ? count : null;
  } catch (err) {
    console.warn(
      `[warn] recovery: could not rebuild the failure count (${err instanceof Error ? err.message : String(err)}) — ` +
        'reporting it as unavailable. The cycle itself is unaffected.',
    );
    return null;
  }
}

/**
 * Claims the run-lock for a MANUAL one-shot cycle (`npm run decide`) — the same
 * atomic compare-and-set as claim_due_run MINUS the "due?" check (a manual run wants
 * to run NOW, like reset_bot). Returns true on a claim, false when a live lock is
 * held (a scheduled cycle or a reset owns it → the manual run must refuse). THROWS on
 * an infra fault (RPC error) so the manual process exits non-zero.
 */
export async function claimManualRun(
  supabase: SupabaseClient,
  runToken: string,
  lockTtlSeconds: number,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_manual_run', {
    p_run_token: runToken,
    p_lock_ttl_seconds: lockTtlSeconds,
  });
  if (error) throw new Error(`claim_manual_run RPC failed: ${error.message}`);
  return data === true;
}

/**
 * Releases a manual run's lock, FENCED by the run_token (like finish_run): true if we
 * still held it, false if it had already been reclaimed (our run overran lockTtl).
 * Leaves next_check_at untouched — a manual run is orthogonal to the scheduler's
 * cadence. THROWS on an infra fault (RPC error).
 */
export async function releaseManualRun(
  supabase: SupabaseClient,
  runToken: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('release_manual_run', {
    p_run_token: runToken,
  });
  if (error) throw new Error(`release_manual_run RPC failed: ${error.message}`);
  return data === true;
}
