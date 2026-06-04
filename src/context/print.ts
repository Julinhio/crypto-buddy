import type { MarketContext, PairContext } from './build.js';
import type { RangeLevels } from '../market/levels.js';

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function fmtDate(iso: string | null | undefined): string {
  if (iso == null) return 'n/a';
  return iso.slice(0, 10);
}

function sectionHeader(label: string): void {
  console.log('');
  console.log(`── ${label} `.padEnd(72, '─'));
}

function levelLine(label: string, range: RangeLevels | null, suffix = ''): string {
  const tag = label.padEnd(8, ' ');
  if (!range) return `   ${tag}n/a`;
  return (
    `   ${tag}high ${fmtPrice(range.high.price)} (${fmtDate(range.high.at)})  ` +
    `low ${fmtPrice(range.low.price)} (${fmtDate(range.low.at)})${suffix}`
  );
}

function printPair(p: PairContext): void {
  console.log('');
  console.log(`▸ ${p.symbol}`);
  console.log(`   price          ${fmtPrice(p.price)}`);
  console.log(`   primary series ${p.primary.candles} × ${p.primary.timeframe}`);

  const rsi = p.indicators.rsi;
  console.log(`   RSI(${rsi.period})         ${fmtNum(rsi.value)}`);

  for (const [period, value] of Object.entries(p.indicators.sma)) {
    console.log(`   SMA(${period.padStart(3, ' ')})        ${fmtPrice(value)}`);
  }
  for (const [period, value] of Object.entries(p.indicators.ema)) {
    console.log(`   EMA(${period.padStart(3, ' ')})        ${fmtPrice(value)}`);
  }

  const a = p.levels.allTime;
  const allTimeSuffix = a
    ? `   [${a.source.candles} × ${a.source.timeframe} · ${a.source.origin}]`
    : '';
  console.log(levelLine('month', p.levels.month));
  console.log(levelLine('year', p.levels.year));
  console.log(levelLine('ATH/ATL', a, allTimeSuffix));
}

export function printMarketContext(ctx: MarketContext): void {
  console.log('='.repeat(72));
  console.log(`Market context  —  ${ctx.generatedAt}`);
  console.log(
    `Source: market=${ctx.source.marketData}  |  account=${ctx.source.account}`,
  );
  console.log('='.repeat(72));

  sectionHeader('Tradable (bot may allocate)');
  for (const p of ctx.market.tradable) printPair(p);

  sectionHeader('Reference (watchlist — context only, never traded)');
  for (const p of ctx.market.reference) printPair(p);

  sectionHeader('Account balances (testnet — tradable assets only)');
  if (ctx.account.balances.length === 0) {
    console.log('   (no relevant balances)');
  } else {
    for (const b of ctx.account.balances) {
      console.log(
        `   ${b.asset.padEnd(6, ' ')} total ${fmtNum(b.total, 8)}  ` +
          `free ${fmtNum(b.free, 8)}  used ${fmtNum(b.used, 8)}`,
      );
    }
  }

  console.log('');
  console.log('─ Raw JSON '.padEnd(72, '─'));
  console.log(JSON.stringify(ctx, null, 2));
}
