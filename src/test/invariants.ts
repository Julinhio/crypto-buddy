import assert from 'node:assert/strict';
import { dec } from '../money.js';
import { derivePortfolio, type PriceLookup } from '../portfolio/derive.js';
import type { LedgerEntry } from '../persistence/executions.js';
import { computeMovements, toModeledFills } from '../execution/movements.js';
import { clampAllocation } from '../risk/clamp.js';
import { config, type AppConfig } from '../config/index.js';

/**
 * Money invariant test — run with `npm test` (tsx). No framework, just asserts.
 *
 * The load-bearing invariant: after replaying this cycle's MODELED fills, the
 * cash % of equity stays at or above the sacred floor for ANY rebalance — buy,
 * sell, full exit, or a multi-coin rotation at the floor — and ANY config. Fees
 * on either side are absorbed by the coin side, never the reserve. We also never
 * over-sell (no impossible fill / negative position). These are the regressions
 * the earlier per-side fixes missed; this test is the durable guarantee.
 */

const defaultPrices: PriceLookup = (a) =>
  a === 'BTC' ? dec(50000) : a === 'ETH' ? dec(3000) : a === 'USDT' ? dec(1) : null;

// A 3-coin world (all "big") to exercise rotation-with-redeploy at the floor.
const threeCoinPrices: PriceLookup = (a) =>
  a === 'ALT' ? dec(10) : defaultPrices(a);
const threeCoinConfig: AppConfig = {
  ...config,
  execution: { ...config.execution, coinClass: { BTC: 'big', ETH: 'big', ALT: 'big' } },
};

const CAPITAL = dec(config.execution.startingCapitalUsd);
const entry = (symbol: string, base: number, quote: number, price: number): LedgerEntry => ({
  symbol,
  side: base > 0 ? 'buy' : 'sell',
  valuationPrice: dec(price),
  baseDelta: dec(base),
  quoteDelta: dec(quote),
});

let passed = 0;

function cashFloorHolds(
  label: string,
  initial: LedgerEntry[],
  target: Record<string, number>,
  opts: { cfg?: AppConfig; prices?: PriceLookup } = {},
): void {
  const cfg = opts.cfg ?? config;
  const prices = opts.prices ?? defaultPrices;
  const floor = cfg.execution.caps.minCashPercent;

  const before = derivePortfolio(initial, { startingCapital: CAPITAL, reserveAsset: 'USDT', priceOf: prices });
  const clamp = clampAllocation(target, 'USDT', cfg);
  const movements = computeMovements(before, clamp.applied, prices, cfg.execution.feePercent);

  const replayed: LedgerEntry[] = [
    ...initial,
    ...toModeledFills(movements, 1, 'test').map((f) => ({
      symbol: f.symbol,
      side: f.side,
      valuationPrice: f.valuation_price,
      baseDelta: f.ledger_base_delta,
      quoteDelta: f.ledger_quote_delta,
    })),
  ];
  const after = derivePortfolio(replayed, { startingCapital: CAPITAL, reserveAsset: 'USDT', priceOf: prices });

  const cashPct = after.equity.gt(0) ? after.cash.div(after.equity).times(100) : dec(0);
  assert.ok(
    cashPct.toNumber() >= floor - 1e-9,
    `${label}: cash ${cashPct.toFixed(4)}% must be >= ${floor}% floor after fills (got ${cashPct.toFixed(4)}%)`,
  );
  console.log(`  ok: ${label} — cash ${cashPct.toFixed(4)}% >= ${floor}%`);
  passed += 1;
}

// Capture console.error to prove we never over-sell (no negative-position guard fires).
const errors: string[] = [];
const realError = console.error;
console.error = (...a: unknown[]) => { errors.push(a.join(' ')); };

try {
  const capital = config.execution.startingCapitalUsd;
  // A book that is 70% of capital in BTC, 30% cash (clean setup — no setup fee).
  const book70BTC: LedgerEntry[] = [entry('BTC/USDT', (capital * 0.7) / 50000, -(capital * 0.7), 50000)];

  console.log('Cash-floor invariant — cash % >= floor after replaying modeled fills:');
  cashFloorHolds('pure buy from 100% cash', [], { BTC: 35, ETH: 35, USDT: 30 });
  cashFloorHolds('mixed sell+buy at the floor', book70BTC, { BTC: 35, ETH: 35, USDT: 30 });
  cashFloorHolds('over-cap proposal, clamped + mixed', book70BTC, { BTC: 50, ETH: 50, USDT: 0 });
  cashFloorHolds('de-risk most of the book to cash', book70BTC, { BTC: 10, ETH: 0, USDT: 90 });
  cashFloorHolds('FULL exit of a coin (no over-sell)', book70BTC, { BTC: 0, ETH: 35, USDT: 65 });
  cashFloorHolds('3-coin rotation, full exit + redeploy AT the floor', book70BTC,
    { BTC: 0, ETH: 35, ALT: 35, USDT: 30 }, { cfg: threeCoinConfig, prices: threeCoinPrices });
} finally {
  console.error = realError;
}

const negative = errors.filter((e) => e.includes('NEGATIVE position'));
assert.equal(negative.length, 0, `never over-sell: expected no negative-position logs, got ${negative.length}:\n${negative.join('\n')}`);
console.log('  ok: no over-sell — the negative-position guard never fired');

console.log(`\n${passed + 1} invariant checks passed.`);
