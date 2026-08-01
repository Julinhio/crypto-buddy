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

  if (status === 'error') {
    console.log('The LLM call failed (technical error — see above). No decision made.');
    console.log('');
    console.log('Error detail:');
    console.log(row.raw_response ?? '(none)');
    return;
  }

  if (status === 'parse_failed') {
    console.log('The LLM response could not be used (see the error above).');
    console.log('');
    console.log('Raw response:');
    console.log(row.raw_response ?? '(empty)');
    return;
  }

  if (status === 'guard_failed') {
    // Deliberately NOT falling through to the "decided" block below. The row carries a
    // target and an action_type — the proposal, kept as evidence — and printing them
    // under the usual headings would read as a decision that was made. It was refused.
    console.log('The response was REFUSED by the coherence guard (see the rules above).');
    console.log('Nothing was executed. The proposal is journaled as evidence only:');
    console.log('');
    console.log(`proposed action_type   ${row.action_type ?? '(none)'}`);
    console.log(`proposed allocation    ${JSON.stringify(row.target_allocation ?? null)}`);
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
