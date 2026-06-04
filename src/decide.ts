import 'dotenv/config';
import { decide } from './decision/decide.js';
import { printDecision } from './decision/print.js';
import { printEconomics } from './execution/print.js';

async function main(): Promise<void> {
  const result = await decide();
  printDecision(result);
  printEconomics(result);
}

main().catch((err: unknown) => {
  console.error('Decision cycle failed:');
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
