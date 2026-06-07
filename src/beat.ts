import 'dotenv/config';
import { runHeartbeat } from './scheduler/heartbeat.js';
import { formatAlert } from './alerting/messages.js';
import { sendTelegram } from './alerting/telegram.js';
import { pingHealthchecks } from './alerting/healthchecks.js';
import { writeEquitySnapshot } from './persistence/equitySnapshots.js';
import { getSupabaseClient } from './persistence/supabase.js';

// One scheduler beat. The external cron (Railway, every 5 min — wired later) calls
// this; it claims and runs a decision cycle only when it's actually due, and is a
// cheap no-op otherwise.
//
// All best-effort side-effects live here, in one auditable place, AFTER the beat's
// real work: each (Telegram, the equity snapshot, Healthchecks) self-guards and
// never throws, so none can fail the beat. Crucially the equity snapshot is WRITTEN
// here — OUTSIDE the timed decision cycle — so a slow/hung write can never lose the
// cycle's timeout race nor flip an already-committed cycle to an error.
async function main(): Promise<void> {
  const result = await runHeartbeat();

  // Internal alerts that crossed their threshold this beat (debounced upstream).
  for (const alert of result.alerts ?? []) {
    await sendTelegram(formatAlert(alert));
  }

  // Equity photo — observability, fully decoupled from the cycle's verdict. The
  // cycle only PREPARED it (pure); the write happens here, off the critical path,
  // and is a no-op when the wake-up warranted none. Placed before the dead-man ping
  // so that ping stays the genuine last signal; its own bounded abort timeout keeps
  // a hung write from delaying the beat.
  await writeEquitySnapshot(getSupabaseClient(), result.equitySnapshot ?? null);

  // Dead-man's-switch — LAST, and only on a clean beat. A thrown infra fault never
  // reaches here (it lands in .catch → non-zero exit), so the missing ping is
  // exactly the silence Healthchecks is configured to detect.
  await pingHealthchecks();
}

main()
  .then(() => {
    // Force a clean exit. A cycle that hit the hard timeout keeps running in the
    // background (a promise race can't cancel it); since this is a one-shot cron
    // process whose lock is already released, exit now so no orphaned work lingers
    // or acts after the beat. All DB writes — including the best-effort snapshot
    // above — are awaited before we get here, so nothing important is in flight.
    process.exit(0);
  })
  .catch((err: unknown) => {
    // An infra/config fault (thrown by the state wrappers / unconfigured Supabase)
    // exits non-zero so the platform detects the outage.
    console.error('Heartbeat failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
