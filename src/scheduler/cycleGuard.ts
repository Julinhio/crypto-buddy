import { config } from '../config/index.js';
import { decide, type DecideResult } from '../decision/decide.js';
import { prepareEquitySnapshot, type EquitySnapshotInsert } from '../persistence/equitySnapshots.js';
import type { CycleStatus } from './policy.js';

/*
 * Shared anti-freeze guard for a REAL mutation cycle — the SAME logic behind the
 * scheduled beat (heartbeat.ts) AND the manual run (decide.ts). Factored here so
 * the two consumers can't drift: a copy-paste of concurrency-critical code is how
 * the two halves silently diverge.
 *
 * Two pieces:
 *   - runCycleWithTimeout / runGuardedCycle: run decide() ONCE under a hard cycle
 *     budget, and report whether it SETTLED (returned OR threw → no orphan) or
 *     timed out (a promise race can't cancel decide(), so on timeout it keeps
 *     running in the background — the "orphan"). `settled` is what tells a caller
 *     whether it may finalize the run-lock (release / reschedule) or must let it
 *     expire (an orphan might still be writing — i.e. placing an order).
 *   - armCycleWatchdog: an absolute, await-independent backstop that force-exits
 *     the process before the lock's TTL, so a stalled call on the
 *     claim/cycle/finalize path can never leave the lock held — or reclaimed —
 *     by a process that is still alive (the orphan that would double-trade).
 */

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
 * throw) is recorded as a technical error (→ backoff), and the entrypoint
 * force-exits the one-shot process so no orphaned cycle can act after the lock is
 * released. Any partial work is already covered by PR B's booking-first replay
 * safety + the per-movement idempotency key (PR #13).
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
    // Essential: clear the timer on the resolve path, else a pending timer would
    // keep the event loop alive long after the cycle finished.
    if (timer) clearTimeout(timer);
  }
}

/** A cycle run plus whether it SETTLED (returned/threw → no orphan) and the full result. */
export interface GuardedCycle {
  outcome: CycleOutcome;
  /** decide() RETURNED or THREW (no background orphan) → safe to finalize the lock. */
  settled: boolean;
  /** The full DecideResult on the success path (for the manual run's printing); null on timeout/throw. */
  result: DecideResult | null;
}

/**
 * Runs ONE cycle under the hard budget, capturing whether it SETTLED. `settled` is
 * set in the closure's `finally`, so it is true once decide() RETURNS or THROWS (no
 * orphan) and false while it is still in flight (the timeout case) — which is how a
 * caller knows it must NOT release/reschedule the lock (an orphan may still write).
 * The cycleFn / timeoutMs seams exist for the offline tests; production passes neither.
 */
export async function runGuardedCycle(
  cycleFn: () => Promise<DecideResult> = decide,
  timeoutMs: number = config.scheduler.maxCycleSeconds * 1000,
): Promise<GuardedCycle> {
  const cycle: { result: DecideResult | null; settled: boolean } = { result: null, settled: false };
  const outcome = await runCycleWithTimeout(async () => {
    try {
      const result = await cycleFn();
      cycle.result = result;
      return result;
    } finally {
      cycle.settled = true;
    }
  }, timeoutMs);
  return { outcome, settled: cycle.settled, result: cycle.result };
}

/**
 * Grace added to the cycle budget for the watchdog deadline: enough for a clean
 * finalize to finish, while keeping the deadline well below lockTtl (prod: cycle
 * budget 300s + 15s ≪ the 600s lock TTL).
 */
const WATCHDOG_GRACE_MS = 15_000;

/**
 * Arms the absolute anti-freeze watchdog for a REAL mutation cycle and returns a
 * disarm fn. It force-exits the process at maxCycleSeconds + grace — BEFORE the
 * run-lock's TTL — INDEPENDENT of any await, so a stalled call on the
 * claim / cycle / finalize path can never leave the lock held (or reclaimed) by a
 * process that's still alive (the orphan that would double-trade).
 *
 * MUST be armed BEFORE the claim: the lock's life begins at the claim's DB commit
 * (it sets locked_until = now() + lockTtl), which can happen even if the claim's
 * HTTP response then stalls past the TTL. Arming only after the claim returns would
 * leave that window unguarded. Since arm-time ≤ claim-commit-time and
 * (maxCycleSeconds + grace) < lockTtl, this absolute deadline provably fires before
 * the lock can expire, in EVERY case, regardless of which await stalls. A
 * force-exit placed after an awaited call is itself defeated when that call hangs —
 * exactly the Supabase stall we tolerate; this timer cannot be wedged.
 */
export function armCycleWatchdog(label: string): () => void {
  const watchdog = setTimeout(() => {
    console.error(
      `[${label}] watchdog: the run-lock has been (or could be) held past ` +
        `${config.scheduler.maxCycleSeconds}s+ — a call on the claim/cycle/finalize path stalled; ` +
        `force-exiting so the lock expires at its TTL and a later beat reclaims via the expired lease.`,
    );
    process.exit(1);
  }, config.scheduler.maxCycleSeconds * 1000 + WATCHDOG_GRACE_MS);
  return () => clearTimeout(watchdog);
}
