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
 * Runs ONE cycle under the SAME hard timeout the beat uses (maxCycleSeconds, strictly
 * below lockTtl), then prints it and writes the best-effort snapshot. Reuses the
 * scheduler's runCycleWithTimeout unchanged (additive). On a TIMEOUT the underlying
 * decide() keeps running in the background (the orphan); `settled` stays false then
 * (the closure's finally has not run) — which is how main() knows NOT to release the
 * lock. The closure captures the full DecideResult (the wrapper reduces it away) so we
 * can still print it on the success path.
 */
async function runCycle(): Promise<CycleRun> {
  // Hold the captured result + a settled flag. settled is set in the closure's finally,
  // so it is true once decide() RETURNS or THROWS (no orphan) and false while it is
  // still in flight (the timeout case). The object also survives the wrapper's reduction
  // and TS's narrowing (a `let` mutated only inside the closure narrows back to null).
  const cycle: { result: DecideResult | null; settled: boolean } = { result: null, settled: false };
  const outcome = await runCycleWithTimeout(async () => {
    try {
      const result = await decide();
      cycle.result = result;
      return result;
    } finally {
      cycle.settled = true;
    }
  }, config.scheduler.maxCycleSeconds * 1000);

  const result = cycle.result;
  if (!result) {
    console.error(`[decide] cycle did not complete cleanly — ${outcome.detail}`);
    return { exitCode: 1, settled: cycle.settled };
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
 * TTL via a watchdog. If a cycle or a reset holds the lock, refuse cleanly. On a clean
 * finish it releases the lock; on a TIMEOUT it exits KEEPING the lock — never freeing
 * it while a background orphan might still write — and lets it expire at its TTL.
 */
async function main(): Promise<number> {
  const supabase = getSupabaseClient();

  // No Supabase (local dev, decide-only): nothing is shared, no lock to take — run
  // unguarded (still under the timeout). loadLedger → [], capital → env bootstrap.
  if (!supabase) {
    return (await runCycle()).exitCode;
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
      // letting a reset/beat claim and write concurrently (the very race this PR
      // closes). Exit KEEPING the lock: process.exit kills the orphan, and the lock
      // expires on its own at its TTL. The bot stays blocked until then — a rare,
      // abnormal case where a temporary block beats a corruption race.
      console.warn(
        '[decide] cycle timed out — KEEPING the run-lock (a background orphan may still ' +
          'write); it expires at its TTL and the scheduler resumes then.',
      );
    }
    clearTimeout(watchdog);
  }
}

main()
  .then((code) => {
    // Force a clean exit — like beat.ts. A timed-out cycle keeps running in the
    // background (a promise race can't cancel it); exiting now kills that orphan BEFORE
    // the lock's TTL, so a reset/beat can never reclaim a lock whose manual cycle is
    // still alive. On a clean finish the lock was already released above; on a timeout
    // it is deliberately KEPT (never freed while the orphan lives) and expires on its
    // own. Any partial work is covered by PR B's booking-first replay safety.
    process.exit(code);
  })
  .catch((err: unknown) => {
    console.error('Decision cycle failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
