import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { config } from './config/index.js';
import { decide, type DecideResult } from './decision/decide.js';
import { printDecision } from './decision/print.js';
import { printEconomics } from './execution/print.js';
import { runCycleWithTimeout } from './scheduler/heartbeat.js';
import { getSupabaseClient } from './persistence/supabase.js';
import { claimManualRun, releaseManualRun } from './persistence/schedulerState.js';
import { prepareEquitySnapshot, writeEquitySnapshot } from './persistence/equitySnapshots.js';

/**
 * Runs ONE cycle under the SAME hard timeout the beat uses (maxCycleSeconds, strictly
 * below lockTtl), then prints it and writes the best-effort snapshot. Reuses the
 * scheduler's runCycleWithTimeout unchanged (additive). A timed-out cycle keeps
 * running in the background — the force-exit in main() kills it before the lock can
 * expire, so the manual run inherits the beat's anti-freeze guarantee. The closure
 * captures the full DecideResult (which the wrapper reduces away) so we can still
 * print it on the success path; on a timeout/throw the capture stays null.
 * Returns the process exit code (0 = clean cycle, 1 = did not complete).
 */
async function runCycle(): Promise<number> {
  // Hold the result in an object so it survives the wrapper's reduction to a
  // CycleOutcome — and TS's narrowing (a `let` mutated only inside the closure gets
  // narrowed back to null at the use site).
  const cycle: { result: DecideResult | null } = { result: null };
  const outcome = await runCycleWithTimeout(async () => {
    const result = await decide();
    cycle.result = result;
    return result;
  }, config.scheduler.maxCycleSeconds * 1000);

  const result = cycle.result;
  if (!result) {
    console.error(`[decide] cycle did not complete cleanly — ${outcome.detail}`);
    return 1;
  }
  printDecision(result);
  printEconomics(result);
  await writeEquitySnapshot(
    getSupabaseClient(),
    prepareEquitySnapshot(result.status, result.decisionId, result.portfolio),
  );
  return 0;
}

/**
 * Grace added to the cycle budget for the watchdog deadline: enough for a clean
 * release to finish, while keeping the deadline well below lockTtl (config: the
 * cycle budget 300s + 15s ≪ the 600s lock TTL).
 */
const WATCHDOG_GRACE_MS = 15_000;

/**
 * Manual one-shot cycle (`npm run decide`). A manual run is a REAL mutation path — it
 * persists decisions and places orders — so it must be mutually exclusive with the
 * scheduled beat AND with a reset, through the SAME run-lock, AND carry the SAME
 * anti-freeze protection: claim the lock NOW (no "due?" check, like reset_bot), run
 * the cycle under the hard timeout, and GUARANTEE the process exits before the lock's
 * TTL via a watchdog. If a cycle or a reset holds the lock, refuse cleanly.
 */
async function main(): Promise<number> {
  const supabase = getSupabaseClient();

  // No Supabase (local dev, decide-only): nothing is shared, no lock to take — run
  // unguarded (still under the timeout). loadLedger → [], capital → env bootstrap.
  if (!supabase) {
    return runCycle();
  }

  const runToken = randomUUID();

  // WATCHDOG — armed BEFORE the claim. The lock's life begins at the claim's DB commit
  // (it sets locked_until = now() + lockTtl), which can happen even if the claim's HTTP
  // response then stalls past the TTL. Arming only after the claim RETURNS would leave
  // that window unguarded — the process could own (or have owned) the lock with no
  // watchdog running, and start a cycle under an already-expired/reclaimed lock. Since
  // arm-time ≤ claim-commit-time and (maxCycleSeconds + grace) < lockTtl, this absolute
  // deadline provably fires before the lock can expire in EVERY case (the claim
  // included), independent of any await on the claim / cycle / release path. A
  // force-exit placed after an awaited call (round 2/3) is itself defeated when that
  // call hangs — exactly the Supabase stall we tolerate; the watchdog cannot be wedged.
  const watchdog = setTimeout(() => {
    console.error(
      `[decide] watchdog: the run-lock has been (or could be) held past ${config.scheduler.maxCycleSeconds}s+ — ` +
        'a call on the claim/exit path stalled; force-exiting to free the lock before its TTL.',
    );
    process.exit(1);
  }, config.scheduler.maxCycleSeconds * 1000 + WATCHDOG_GRACE_MS);

  let claimed = false;
  try {
    claimed = await claimManualRun(supabase, runToken, config.scheduler.lockTtlSeconds);
    if (!claimed) {
      console.error(
        '[decide] the bot is mid-cycle (run-lock held) — refusing this manual run. Retry shortly.',
      );
      return 1;
    }
    return await runCycle();
  } finally {
    // Release only if we actually claimed (best-effort; if IT hangs, the watchdog —
    // still armed — fires). Fenced by the token: a reclaimed lock makes it a no-op.
    // Then cancel the watchdog: only a completed release lets the clean force-exit run.
    if (claimed && !(await releaseManualRun(supabase, runToken))) {
      console.warn('[decide] run-lock was already reclaimed (overran lockTtl) before release.');
    }
    clearTimeout(watchdog);
  }
}

main()
  .then((code) => {
    // Force a clean exit — exactly like beat.ts. A cycle that hit the hard timeout
    // keeps running in the background (a promise race can't cancel it); exiting now
    // kills that orphan BEFORE the lock TTL can expire, so a reset/beat can never
    // reclaim a lock whose manual cycle is still alive. All important DB writes are
    // awaited above (the lock is already released); any partial work on a timeout is
    // covered by PR B's booking-first replay safety.
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('Decision cycle failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
