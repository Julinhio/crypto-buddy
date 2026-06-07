import 'dotenv/config';
import { decide } from './decision/decide.js';
import { printDecision } from './decision/print.js';
import { printEconomics } from './execution/print.js';
import { getSupabaseClient } from './persistence/supabase.js';
import { prepareEquitySnapshot, writeEquitySnapshot } from './persistence/equitySnapshots.js';

async function main(): Promise<void> {
  const result = await decide();
  printDecision(result);
  printEconomics(result);

  // Equity photo — best-effort observability, written AFTER the cycle (there is no
  // timed race on this manual path, but the snapshot stays decoupled from the
  // decision either way, symmetric with the scheduled beat).
  await writeEquitySnapshot(
    getSupabaseClient(),
    prepareEquitySnapshot(result.status, result.decisionId, result.portfolio),
  );
}

main().catch((err: unknown) => {
  console.error('Decision cycle failed:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
