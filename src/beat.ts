import 'dotenv/config';
import { runHeartbeat } from './scheduler/heartbeat.js';
import { formatAlert } from './alerting/messages.js';
import { sendTelegram } from './alerting/telegram.js';
import { pingHealthchecks } from './alerting/healthchecks.js';

// One scheduler beat. The external cron (Railway, every 5 min — wired later) calls
// this; it claims and runs a decision cycle only when it's actually due, and is a
// cheap no-op otherwise.
//
// All EXTERNAL best-effort calls live here, in one auditable place, AFTER the beat's
// real work: each (Telegram, Healthchecks) self-guards and never throws, so neither
// an alert nor the dead-man's-switch ping can ever fail the beat.
async function main(): Promise<void> {
  const result = await runHeartbeat();

  // Internal alerts that crossed their threshold this beat (debounced upstream).
  for (const alert of result.alerts ?? []) {
    await sendTelegram(formatAlert(alert));
  }

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
    // or acts after the beat. All DB writes are awaited inside runHeartbeat, so
    // nothing important is in flight.
    process.exit(0);
  })
  .catch((err: unknown) => {
    // An infra/config fault (thrown by the state wrappers / unconfigured Supabase)
    // exits non-zero so the platform detects the outage.
    console.error('Heartbeat failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
