import type { DecideResult } from './decide.js';

function fmtTokens(n: number | null): string {
  return n == null ? 'n/a' : String(n);
}

export function printDecision(result: DecideResult): void {
  const { row, status, persisted } = result;

  console.log('='.repeat(72));
  console.log(`Decision cycle — status: ${status.toUpperCase()}`);
  console.log(
    `prompt_version=${row.prompt_version}  git_sha=${row.git_sha ?? 'n/a'}  ` +
      `journaled=${persisted ? 'yes' : 'NO'}`,
  );
  if (row.model) {
    console.log(
      `model=${row.model}  latency=${row.latency_ms ?? 'n/a'}ms  ` +
        `tokens in/out=${fmtTokens(row.input_tokens)}/${fmtTokens(row.output_tokens)}`,
    );
  }
  console.log('='.repeat(72));

  if (status === 'skipped') {
    console.log(`Skipped: ${row.skip_reason}`);
    return;
  }

  if (status === 'parse_failed') {
    console.log('The LLM response could not be used (see the error above).');
    console.log('');
    console.log('Raw response:');
    console.log(row.raw_response ?? '(empty)');
    return;
  }

  // decided
  console.log('');
  console.log(`action_type   ${row.action_type}`);
  console.log(`confidence    ${row.confidence}`);
  console.log(`market_state  ${row.market_state}`);
  console.log(
    `next wake     ${row.applied_delay_minutes} min ` +
      `(requested ${row.requested_delay_minutes})`,
  );
  console.log('');
  console.log('target_allocation:');
  for (const [asset, pct] of Object.entries(row.target_allocation ?? {})) {
    console.log(`   ${asset.padEnd(6, ' ')} ${pct}%`);
  }
  console.log('');
  console.log(`what_changed: ${row.what_changed}`);
  console.log('');
  console.log('reasoning:');
  console.log(row.reasoning);
}
