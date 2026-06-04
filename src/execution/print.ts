import { fmtPct, fmtQty, fmtUsd } from '../money.js';
import type { DecideResult } from '../decision/decide.js';

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

/** Prints the economic side of a cycle: virtual book, risk wrapper, dry-run movements. */
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

  if (clamp) {
    section(clamp.clamped ? 'Risk wrapper: CLAMPED' : 'Risk wrapper: within caps');
    if (clamp.clamped) console.log(`   ${clamp.reason}`);
    console.log(`   proposed  ${fmtAllocation(row.target_allocation)}`);
    console.log(`   applied   ${fmtAllocation(row.applied_allocation)}`);
  }

  section('Dry-run movements (paper trading — NO Binance order placed)');
  if (movements.length === 0) {
    console.log('   (none — already at the target allocation)');
  } else {
    for (const m of movements) {
      console.log(
        `   ${m.side.toUpperCase().padEnd(4)} ${fmtQty(m.qty)} ${m.asset} @ ${fmtUsd(m.price)}  ` +
          `(${fmtUsd(m.notional)} ${portfolio.reserveAsset}, fee ${fmtUsd(m.fee)})`,
      );
    }
  }
  console.log(`   modeled fills journaled: ${result.executionsWritten}`);
}
