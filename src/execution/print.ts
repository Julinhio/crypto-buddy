import { Decimal, fmtPct, fmtQty, fmtUsd } from '../money.js';
import { config } from '../config/index.js';
import type { DecideResult } from '../decision/decide.js';
import type { ExecutionLine } from './execute.js';

function section(label: string): void {
  console.log('');
  console.log(`── ${label} `.padEnd(72, '─'));
}

function fmtAllocation(alloc: Record<string, number> | null): string {
  if (!alloc) return 'n/a';
  return Object.entries(alloc)
    .map(([asset, pct]) => `${asset} ${Math.round(pct * 10) / 10}%`)
    .join('  ');
}

const SKIP_LABEL: Record<Exclude<ExecutionLine['verdict'], 'ok'>, string> = {
  crumb: 'skip·crumb',
  block: 'skip·block',
  rules_error: 'skip·rules',
  not_booked: 'skip·not-booked',
};

/** The testnet half of the line (states 2-3-4) for a booked movement. */
function fmtTestnet(line: ExecutionLine): string {
  const o = line.order;
  if (!o) return 'testnet: not attempted';
  const sub =
    o.submittedQty != null && o.submittedPrice != null
      ? `submitted ${fmtQty(o.submittedQty)} @ ${fmtUsd(o.submittedPrice)} ${o.timeInForce}`
      : 'submitted n/a';
  const id = o.orderId ? ` #${o.orderId}` : '';
  switch (o.outcome) {
    case 'filled':
      return `testnet: FILLED ${fmtQty(o.executedQty)}${o.avgPrice ? ` @ ${fmtUsd(o.avgPrice)}` : ''} (${sub}${id})`;
    case 'partial':
      return `testnet: PARTIAL ${fmtQty(o.executedQty)} filled (${sub}${id})`;
    case 'unfilled':
      return `testnet: unfilled (${sub}${id})`;
    case 'rejected':
      return `testnet: REJECTED${o.errorCode ? ` code=${o.errorCode}` : ''} (${sub})`;
    case 'error':
      return `testnet: error${o.errorCode ? ` code=${o.errorCode}` : ''}`;
  }
}

/** Prints the economic side of a cycle: virtual book, risk wrapper, real execution. */
export function printEconomics(result: DecideResult): void {
  const { portfolio, clamp, movements, row } = result;
  if (!portfolio) return; // skipped cycle — nothing economic to show

  section('Virtual portfolio (sovereign, valued at real prices)');
  console.log(`   starting capital  ${fmtUsd(portfolio.startingCapital)}`);
  console.log(`   cash              ${fmtUsd(portfolio.cash)} ${portfolio.reserveAsset}`);
  console.log(`   equity            ${fmtUsd(portfolio.equity)}`);
  console.log(`   deployed          ${fmtPct(portfolio.deployedPercent)}`);
  console.log(
    `   P&L               realized ${fmtUsd(portfolio.realizedPnl)}  ` +
      `unrealized ${fmtUsd(portfolio.unrealizedPnl)}  total ${fmtUsd(portfolio.totalPnl)}`,
  );
  if (portfolio.positions.length === 0) {
    console.log('   positions         (none — 100% cash)');
  } else {
    for (const p of portfolio.positions) {
      console.log(
        `   • ${p.asset.padEnd(5)} ${fmtQty(p.qty)} @avg ${fmtUsd(p.avgCost)}  ` +
          `now ${fmtUsd(p.price)}${p.priceStale ? ' (stale)' : ''}  ` +
          `value ${fmtUsd(p.value)} (${fmtPct(p.weightPercent)})  uPnL ${fmtUsd(p.unrealizedPnl)}`,
      );
    }
  }

  // The book is shown for every status; the risk wrapper + execution only exist
  // for a decided cycle (skip / error / parse_failed have no allocation).
  if (result.status !== 'decided') return;

  if (clamp) {
    section(clamp.clamped ? 'Risk wrapper: CLAMPED' : 'Risk wrapper: within caps');
    if (clamp.clamped) console.log(`   ${clamp.reason}`);
    console.log(`   proposed  ${fmtAllocation(row.target_allocation)}`);
    console.log(`   applied   ${fmtAllocation(row.applied_allocation)}`);
  }

  section('Real testnet execution (sovereign booking + testnet probe)');
  const execution = result.execution;
  if (!execution) {
    console.log('   (not executed — decision was not persisted; portfolio unchanged)');
    return;
  }
  if (movements.length === 0 || execution.lines.length === 0) {
    console.log('   (none — already at the target allocation)');
    return;
  }

  const feeRate = new Decimal(config.execution.feePercent).div(100);
  for (const [i, line] of execution.lines.entries()) {
    const m = movements[i];
    const price = m?.price ?? line.snappedQty; // movements are 1:1 with lines
    const asset = line.symbol.split('/')[0] ?? line.symbol;

    if (!line.booked) {
      console.log(
        `   [${SKIP_LABEL[line.verdict as Exclude<ExecutionLine['verdict'], 'ok'>]}] ` +
          `${line.side.toUpperCase()} ${fmtQty(line.wantedQty)} ${asset} — ${line.reason ?? 'skipped'}`,
      );
      continue;
    }

    const notional = line.snappedQty.times(price);
    const fee = notional.times(feeRate);
    console.log(
      `   ${line.side.toUpperCase().padEnd(4)} ${fmtQty(line.snappedQty)} ${asset} @ ${fmtUsd(price)}  ` +
        `(${fmtUsd(notional)} ${portfolio.reserveAsset}, fee ${fmtUsd(fee)}) → booked`,
    );
    console.log(`        ${fmtTestnet(line)}`);
  }

  console.log('');
  console.log(
    `   summary: ${execution.booked} booked, ${execution.skipped} skipped · ` +
      `testnet: ${execution.filled} filled, ${execution.partial} partial, ` +
      `${execution.unfilled} unfilled, ${execution.rejected} rejected, ${execution.errored} error`,
  );
}
