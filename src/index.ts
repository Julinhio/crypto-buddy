import 'dotenv/config';
import { buildMarketContext } from './context/build.js';
import { printMarketContext } from './context/print.js';

async function main(): Promise<void> {
  const ctx = await buildMarketContext();
  printMarketContext(ctx);
}

main().catch((err: unknown) => {
  console.error('Failed to build market context:');
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
