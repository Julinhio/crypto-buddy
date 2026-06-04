import type { MarketContext, PairContext } from './build.js';

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function sectionHeader(label: string): void {
  console.log('');
  console.log(`── ${label} `.padEnd(72, '─'));
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

  const m = p.levels.month;
  const y = p.levels.year;
  const a = p.levels.allTime;
  console.log(
    `   month   high ${fmtPrice(m.high.price)} (${fmtDate(m.high.at)})  ` +
      `low ${fmtPrice(m.low.price)} (${fmtDate(m.low.at)})`,
  );
  console.log(
    `   year    high ${fmtPrice(y.high.price)} (${fmtDate(y.high.at)})  ` +
      `low ${fmtPrice(y.low.price)} (${fmtDate(y.low.at)})`,
  );
  console.log(
    `   ATH/ATL high ${fmtPrice(a.high.price)} (${fmtDate(a.high.at)})  ` +
      `low ${fmtPrice(a.low.price)} (${fmtDate(a.low.at)})   ` +
      `[${a.source.candles} × ${a.source.timeframe}]`,
  );
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
