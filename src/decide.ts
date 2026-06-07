import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { config } from './config/index.js';
import { decide } from './decision/decide.js';
import { printDecision } from './decision/print.js';
import { printEconomics } from './execution/print.js';
import { getSupabaseClient } from './persistence/supabase.js';
import { claimManualRun, releaseManualRun } from './persistence/schedulerState.js';
import { prepareEquitySnapshot, writeEquitySnapshot } from './persistence/equitySnapshots.js';

/** One decision cycle: decide, print, and the best-effort equity snapshot. */
async function runCycle(): Promise<void> {
  const result = await decide();
  printDecision(result);
  printEconomics(result);
  await writeEquitySnapshot(
    getSupabaseClient(),
    prepareEquitySnapshot(result.status, result.decisionId, result.portfolio),
  );
}

/**
 * Manual one-shot cycle (`npm run decide`). A manual run is a REAL mutation path — it
 * persists decisions and places orders — so it must be mutually exclusive with the
 * scheduled beat AND with a reset, through the SAME run-lock. Without it, a manual run
 * could read the old ledger, a reset could claim the apparently-free lock and purge,
 * and the manual run would then write onto the purged base — the back door of the
 * reset/cycle race. So: claim the lock NOW (no "due?" check, like reset_bot), run, and
 * release; if a cycle or a reset already holds it, refuse cleanly.
 */
async function main(): Promise<void> {
  const supabase = getSupabaseClient();

  // No Supabase configured (local dev, decide-only): nothing is shared, no lock to
  // take and nothing else can write — run unguarded, consistent with the bot's
  // "Supabase optional" posture (loadLedger → [], capital → env bootstrap).
  if (!supabase) {
    await runCycle();
    return;
  }

  const runToken = randomUUID();
  if (!(await claimManualRun(supabase, runToken, config.scheduler.lockTtlSeconds))) {
    console.error(
      '[decide] the bot is mid-cycle (run-lock held) — refusing this manual run. Retry shortly.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    await runCycle();
  } finally {
    // Release even if the cycle threw. Fenced by the token: if our lock expired and
    // was reclaimed (overran lockTtl), this is a no-op — we never clobber the new owner.
    if (!(await releaseManualRun(supabase, runToken))) {
      console.warn('[decide] run-lock was already reclaimed (overran lockTtl) before release.');
    }
  }
}

main().catch((err: unknown) => {
  console.error('Decision cycle failed:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
