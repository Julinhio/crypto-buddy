import 'dotenv/config';
import { runHeartbeat } from './scheduler/heartbeat.js';

// One scheduler beat. The external cron (Railway, every 5 min — wired later) calls
// this; it claims and runs a decision cycle only when it's actually due, and is a
// cheap no-op otherwise.
async function main(): Promise<void> {
  await runHeartbeat();
}

main().catch((err: unknown) => {
  console.error('Heartbeat failed:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
