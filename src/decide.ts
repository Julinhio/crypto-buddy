import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { config } from './config/index.js';
import { printDecision } from './decision/print.js';
import { printEconomics } from './execution/print.js';
import { armCycleWatchdog, runGuardedCycle } from './scheduler/cycleGuard.js';
import { getSupabaseClient } from './persistence/supabase.js';
import { claimManualRun, releaseManualRun } from './persistence/schedulerState.js';
import { prepareEquitySnapshot, writeEquitySnapshot } from './persistence/equitySnapshots.js';

/**
 * Outcome of a manual cycle: the process exit code, and whether decide() SETTLED —
 * i.e. returned OR threw, leaving no background orphan — vs timed out, where the
 * underlying decide() keeps running after the wrapper returns. The run-lock may be
 * released ONLY when settled; never while an orphan might still write.
 */
interface CycleRun {
  exitCode: number;
  settled: boolean;
}

/**
 * Runs ONE cycle under the shared hard timeout + settled-detection (runGuardedCycle,
 * the SAME guard the beat uses), then prints it and writes the best-effort snapshot.
 * On a TIMEOUT the underlying decide() keeps running in the background (the orphan)
 * and `settled` stays false — which is how main() knows NOT to release the lock.
 */
async function runCycle(): Promise<CycleRun> {
  const { result, settled, outcome } = await runGuardedCycle();
  if (!result) {
    console.error(`[decide] cycle did not complete cleanly — ${outcome.detail}`);
    return { exitCode: 1, settled };
  }
  printDecision(result);
  printEconomics(result);
  await writeEquitySnapshot(
    getSupabaseClient(),
    prepareEquitySnapshot(result.status, result.decisionId, result.portfolio),
  );
  return { exitCode: 0, settled: true };
}

/**
 * Manual one-shot cycle (`npm run decide`). A manual run is a REAL mutation path — it
 * persists decisions and places orders — so it must be mutually exclusive with the
 * scheduled beat AND with a reset, through the SAME run-lock, AND carry the SAME
 * anti-freeze protection (now shared with the beat in cycleGuard): arm the watchdog,
 * claim the lock NOW (no "due?" check, like reset_bot), run the cycle under the hard
 * timeout, and GUARANTEE the process exits before the lock's TTL. If a cycle or a
 * reset holds the lock, refuse cleanly. On a clean finish it releases the lock; on a
 * TIMEOUT it exits KEEPING the lock — never freeing it while a background orphan
 * might still write — and lets it expire at its TTL (recovery via the expired lease).
 */
async function main(): Promise<number> {
  const supabase = getSupabaseClient();

  // No Supabase (local dev, decide-only): nothing is shared, no lock to take — run
  // unguarded (still under the timeout). loadLedger → [], capital → env bootstrap.
  if (!supabase) {
    return (await runCycle()).exitCode;
  }

  const runToken = randomUUID();

  // Arm the shared anti-freeze watchdog BEFORE the claim — the lock's life begins at
  // the claim's DB commit, which can happen even if the claim's HTTP response then
  // stalls past the TTL. The absolute deadline (maxCycleSeconds + grace < lockTtl)
  // provably fires before the lock can expire, independent of any await on the
  // claim / cycle / release path. See armCycleWatchdog.
  const disarmWatchdog = armCycleWatchdog('decide');

  let claimed = false;
  let settled = false; // decide() returned/threw (no orphan) → safe to release the lock
  try {
    claimed = await claimManualRun(supabase, runToken, config.scheduler.lockTtlSeconds);
    if (!claimed) {
      console.error(
        '[decide] the bot is mid-cycle (run-lock held) — refusing this manual run. Retry shortly.',
      );
      return 1;
    }
    const run = await runCycle();
    settled = run.settled;
    return run.exitCode;
  } finally {
    if (claimed && settled) {
      // The cycle SETTLED (success or error) — no background orphan — so release the
      // lock (best-effort; if IT hangs, the watchdog still force-exits). A stalled
      // release is harmless here: there is no orphan to race against.
      if (!(await releaseManualRun(supabase, runToken))) {
        console.warn('[decide] run-lock was already reclaimed (overran lockTtl) before release.');
      }
    } else if (claimed) {
      // TIMEOUT: decide() may still be writing in the background. Do NOT release —
      // freeing the lock now would mark it AVAILABLE while the orphan still writes,
      // letting a reset/beat claim and write concurrently (the very race this closes).
      // Exit KEEPING the lock: process.exit kills the orphan, and the lock expires on
      // its own at its TTL. The bot stays blocked until then — a rare, abnormal case
      // where a temporary block beats a corruption race.
      console.warn(
        '[decide] cycle timed out — KEEPING the run-lock (a background orphan may still ' +
          'write); it expires at its TTL and the scheduler resumes then.',
      );
    }
    disarmWatchdog();
  }
}

main()
  .then((code) => {
    // Force a clean exit — like beat.ts. A timed-out cycle keeps running in the
    // background (a promise race can't cancel it); exiting now kills that orphan BEFORE
    // the lock's TTL, so a reset/beat can never reclaim a lock whose manual cycle is
    // still alive. On a clean finish the lock was already released above; on a timeout
    // it is deliberately KEPT (never freed while the orphan lives) and expires on its
    // own. Any partial work is covered by booking-first replay + the idempotency key (PR #13).
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('Decision cycle failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
