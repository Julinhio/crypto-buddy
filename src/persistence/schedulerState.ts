import type { SupabaseClient } from '@supabase/supabase-js';
import type { RunOutcome } from '../scheduler/policy.js';

/** The singleton scheduler state (camelCased; timestamps as ISO strings). */
export interface BotState {
  nextCheckAt: string | null;
  runToken: string | null;
  lockedUntil: string | null;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  floorDelayStreak: number;
  alertSent: boolean;
}

/** What `claim_due_run` returns on a successful (atomic) claim. */
export interface ClaimResult {
  runId: number;
  prevNextCheckAt: string | null;
  dbNow: string;
  consecutiveFailures: number;
  floorDelayStreak: number;
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
    alertSent: Boolean(row.alert_sent ?? false),
  };
}

/**
 * Records liveness on EVERY beat (last_heartbeat_at = DB now()) and returns the
 * current state so the caller can decide — using DB time — whether to attempt a
 * claim. Returns null if Supabase is unavailable or the call fails.
 */
export async function recordHeartbeat(supabase: SupabaseClient): Promise<BotState | null> {
  try {
    const { data, error } = await supabase.rpc('record_heartbeat');
    if (error) throw new Error(error.message);
    if (data == null) return null;
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    return row ? toBotState(row) : null;
  } catch (err) {
    console.warn(`[warn] record_heartbeat failed (${err instanceof Error ? err.message : String(err)}).`);
    return null;
  }
}

/**
 * The ATOMIC claim. Returns a ClaimResult only if THIS beat won the run-lock
 * (atomically, in the DB); returns null when not due, already locked, or on error
 * — in every "null" case the caller simply no-ops, which is always safe.
 */
export async function claimDueRun(
  supabase: SupabaseClient,
  runToken: string,
  lockTtlSeconds: number,
): Promise<ClaimResult | null> {
  try {
    const { data, error } = await supabase.rpc('claim_due_run', {
      p_run_token: runToken,
      p_lock_ttl_seconds: lockTtlSeconds,
    });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!row) return null; // not due / locked
    return {
      runId: Number(row.run_id),
      prevNextCheckAt: (row.prev_next_check_at as string | null) ?? null,
      dbNow: String(row.db_now),
      consecutiveFailures: Number(row.consecutive_failures ?? 0),
      floorDelayStreak: Number(row.floor_delay_streak ?? 0),
    };
  } catch (err) {
    console.warn(`[warn] claim_due_run failed (${err instanceof Error ? err.message : String(err)}) — treating as not claimed.`);
    return null;
  }
}

/**
 * Reschedules + releases the lock + marks the run done, in ONE DB transaction.
 * Returns false when we lost the lock (the fencing token didn't match: our run
 * was reclaimed because it overran) — the caller logs it and does NOT retry, since
 * the reclaiming run now owns rescheduling. Returns false on error too; the lock
 * then simply expires and a later beat takes over.
 */
export async function finishRun(supabase: SupabaseClient, p: FinishRunParams): Promise<boolean> {
  try {
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
    });
    if (error) throw new Error(error.message);
    return data === true;
  } catch (err) {
    console.error(`[error] finish_run failed (${err instanceof Error ? err.message : String(err)}) — lock will expire and a later beat will take over.`);
    return false;
  }
}
