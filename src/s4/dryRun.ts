import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { buildBenchConfig } from '../bench/exposure/config.js';
import { buildMarketContext } from '../context/build.js';
import { buildPriceLookup } from '../decision/context.js';
import { computeMovements } from '../execution/movements.js';
import { Decimal, ZERO } from '../money.js';
import { derivePortfolio } from '../portfolio/derive.js';
import { applyDailyCloses, dueCloses, missingClose, plannerAllocation, readDailyTable, s4Allocation, s4Gate } from './core.js';
import { seedLinesOf, type Reconstruction } from './reconstruct.js';

/**
 * A DRY RUN OF ONE S4 CYCLE ON THE LIVE MARKET — no write anywhere, no order.
 *
 * Runs production's own market read (ccxt, mainnet public: prices, 4h regime and its sticky walk,
 * daily candles) and the S4 core on a book given as a file and on the reconstructed state, so the
 * whole decision path is exercised on real production data before the deployment.
 *
 * Supabase is deliberately unset for the market read (the ATH/ATL cache would otherwise be
 * refreshed — a write): the run touches nothing but the public market and the testnet balances.
 *
 * Usage: tsx src/s4/dryRun.ts --book <json> [--as-of-close <ISO midnight>]
 */

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const cfg = buildBenchConfig();
  const recon = JSON.parse(readFileSync(path.join('out', 's4', 'reconstruction.json'), 'utf8')) as Reconstruction;
  const bookFile = arg('--book');
  if (!bookFile) throw new Error('--book <json> is required');
  const b = JSON.parse(readFileSync(bookFile, 'utf8')) as { startingCapital: number; ledger: Array<{ symbol: string; side: 'buy' | 'sell'; valuationPrice: string; baseDelta: string; quoteDelta: string }> };

  const context = await buildMarketContext();
  const nowMs = Date.now();
  const priceOf = buildPriceLookup(context, 'USDT');
  const book = derivePortfolio(
    b.ledger.map((e) => ({ symbol: e.symbol, side: e.side, valuationPrice: new Decimal(e.valuationPrice), baseDelta: new Decimal(e.baseDelta), quoteDelta: new Decimal(e.quoteDelta) })),
    { startingCapital: new Decimal(b.startingCapital), reserveAsset: 'USDT', priceOf },
  );
  console.log(`market read at ${context.generatedAt}: blind=${context.dataHealth.blind}, regime bar ${context.transition ? new Date(context.transition.barAtMs).toISOString() : 'none'}`);
  console.log(`book: equity ${book.equity.toFixed(2)} $, cash ${book.cash.toFixed(2)} $`);

  // The daily closes ccxt hands production, against those the reconstruction read.
  const daily = readDailyTable(context.dailySeries, cfg.assets, cfg.basket, nowMs);
  if (!daily.ok) throw new Error(`daily read failed: ${daily.reason}`);
  const lastClose = daily.table.rows.find((r) => r.closeMs === recon.lastCloseMs);
  for (const l of recon.lines) {
    const same = lastClose != null && lastClose.close[l.asset] === l.close && Math.abs((lastClose.sma50[l.asset] ?? NaN) - l.sma50) < 1e-9;
    console.log(`  ${l.asset}: close ${new Date(recon.lastCloseMs).toISOString().slice(0, 10)} production ${lastClose?.close[l.asset]} / reconstruction ${l.close}, sma50 ${lastClose?.sma50[l.asset]?.toFixed(6)} / ${l.sma50.toFixed(6)} → ${same ? 'identical' : 'DIFFERENT'}`);
  }

  let lines = seedLinesOf(recon);
  const asOfClose = arg('--as-of-close');
  const closes = dueCloses(recon.lastCloseMs, asOfClose ? Date.parse(asOfClose) : nowMs);
  console.log(`due closes after the seed: ${closes.map((c) => new Date(c).toISOString().slice(0, 10)).join(', ') || 'none'}`);
  const held = Object.fromEntries(cfg.assets.map((a) => [a, (book.positions.find((p) => p.asset === a)?.qty ?? ZERO).gt(0)]));
  if (closes.length > 0) {
    const missing = missingClose(daily.table, closes);
    if (missing) console.log(`  → BLOCKED: ${missing}`);
    else {
      const step = applyDailyCloses({ lines, table: daily.table, closes, holdings: Object.fromEntries(lines.map((l) => [l.asset, { held: held[l.asset] === true, entryAtMs: l.entryAtMs }])) });
      for (const e of step.events) console.log(`  ${new Date(e.closeMs).toISOString().slice(0, 10)} ${e.asset}: ${e.kind} (close ${e.close}, sma50 ${e.sma50.toFixed(4)}, threshold ${e.thresholdPrice?.toFixed(4) ?? '—'})`);
      lines = step.lines;
    }
  }
  const gates = Object.fromEntries(cfg.assets.map((a) => {
    const p = book.positions.find((x) => x.asset === a);
    return [a, s4Gate({ asset: a, sticky: context.transition?.perAsset[a] ?? null, qty: p?.qty ?? ZERO, price: priceOf(a), priceStale: p?.priceStale ?? false, stopThresholdPercent: config.transition.peakStopPercent })];
  }));
  const weights = Object.fromEntries(cfg.assets.map((a) => {
    const p = book.positions.find((x) => x.asset === a);
    return [a, p ? p.value.div(book.equity).times(100).toNumber() : 0];
  }));
  const out = new Set(lines.filter((l) => l.status === 'out').map((l) => l.asset));
  const { lines: plan } = s4Allocation({ assets: cfg.assets, basket: cfg.basket, caps: cfg.caps, out, gates, weights, priced: Object.fromEntries(cfg.assets.map((a) => [a, priceOf(a) != null])) });
  for (const l of plan) console.log(`  ${l.asset}: S4 ${out.has(l.asset) ? 'out' : 'in'}, gate ${l.gate} (production regime read, risk_off blind), state ${l.state}, ${l.currentPercent.toFixed(2)} % → ${l.targetPercent.toFixed(2)} %${l.hold ? ' (held)' : ''}`);
  const legs = computeMovements(book, plannerAllocation(plan, 'USDT'), priceOf, config.execution.feePercent, cfg.minMovementPercent);
  for (const m of legs) console.log(`  leg: ${m.side} ${m.asset} ${m.notional.toFixed(2)} $${m.fullExit ? ' (full exit)' : ''}`);
  console.log(`risk_off confirmed by production right now: ${context.regime?.global.riskOff ?? 'n/a'} — S4's gate does not see it, as in the bench.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
