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
 * Manual one-shot cycle (`npm run decide`). A manual run is a REAL mutation path — it
 * persists decisions and places orders — so it must be mutually exclusive with the
 * scheduled beat AND with a reset, through the SAME run-lock, AND carry the SAME
 * anti-freeze protection: claim the lock NOW (no "due?" check, like reset_bot), run
 * the cycle under the hard timeout, release, then force-exit. If a cycle or a reset
 * holds the lock, refuse cleanly.
 */
async function main(): Promise<number> {
  const supabase = getSupabaseClient();

  // No Supabase (local dev, decide-only): nothing is shared, no lock to take — run
  // unguarded (still under the timeout). loadLedger → [], capital → env bootstrap.
  if (!supabase) {
    return runCycle();
  }

  const runToken = randomUUID();
  if (!(await claimManualRun(supabase, runToken, config.scheduler.lockTtlSeconds))) {
    console.error(
      '[decide] the bot is mid-cycle (run-lock held) — refusing this manual run. Retry shortly.',
    );
    return 1;
  }

  try {
    return await runCycle();
  } finally {
    // Release even if the cycle threw/timed out. Fenced by the token: if our lock
    // expired and was reclaimed, this is a no-op — we never clobber the new owner.
    if (!(await releaseManualRun(supabase, runToken))) {
      console.warn('[decide] run-lock was already reclaimed (overran lockTtl) before release.');
    }
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
