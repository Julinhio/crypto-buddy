import 'dotenv/config';
import { runHeartbeat } from './scheduler/heartbeat.js';

// One scheduler beat. The external cron (Railway, every 5 min — wired later) calls
// this; it claims and runs a decision cycle only when it's actually due, and is a
// cheap no-op otherwise.
async function main(): Promise<void> {
  await runHeartbeat();
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
