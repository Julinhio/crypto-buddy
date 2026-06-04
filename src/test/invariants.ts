import assert from 'node:assert/strict';
import { dec } from '../money.js';
import { derivePortfolio, type PriceLookup } from '../portfolio/derive.js';
import type { LedgerEntry } from '../persistence/executions.js';
import { computeMovements, toModeledFills } from '../execution/movements.js';
import { clampAllocation } from '../risk/clamp.js';
import { config } from '../config/index.js';

/**
 * Money invariant test — run with `npm test` (tsx). No framework, just asserts.
 *
 * The load-bearing invariant: after replaying this cycle's MODELED fills, the
 * cash % of equity must stay at or above the sacred floor for ANY rebalance —
 * buy, sell, or mixed. Fees on either side are absorbed by the coin side, never
 * the reserve. (The mixed sell+buy case is the one that slipped past the
 * earlier buy-only fix.)
 */

const priceOf: PriceLookup = (asset) =>
  asset === 'BTC' ? dec(50000) : asset === 'ETH' ? dec(3000) : asset === 'USDT' ? dec(1) : null;

const CAPITAL = dec(config.execution.startingCapitalUsd);
const FLOOR = config.execution.caps.minCashPercent;
const FEE = config.execution.feePercent;

const entry = (symbol: string, base: number, quote: number, price: number): LedgerEntry => ({
  symbol,
  side: base > 0 ? 'buy' : 'sell',
  valuationPrice: dec(price),
  baseDelta: dec(base),
  quoteDelta: dec(quote),
});

let passed = 0;

function cashFloorHolds(label: string, initial: LedgerEntry[], target: Record<string, number>): void {
  const before = derivePortfolio(initial, { startingCapital: CAPITAL, reserveAsset: 'USDT', priceOf });
  const clamp = clampAllocation(target, 'USDT', config);
  const movements = computeMovements(before, clamp.applied, priceOf, FEE);

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
  const after = derivePortfolio(replayed, { startingCapital: CAPITAL, reserveAsset: 'USDT', priceOf });

  const cashPct = after.equity.gt(0) ? after.cash.div(after.equity).times(100) : dec(0);
  assert.ok(
    cashPct.toNumber() >= FLOOR - 1e-9,
    `${label}: cash ${cashPct.toFixed(4)}% must be >= ${FLOOR}% floor after fills (got ${cashPct.toFixed(4)}%)`,
  );
  console.log(`  ok: ${label} — cash ${cashPct.toFixed(4)}% >= ${FLOOR}%`);
  passed += 1;
}

// A book that is 70% of capital in BTC, 30% cash (clean setup — no setup fee).
const capital = config.execution.startingCapitalUsd;
const book70BTC: LedgerEntry[] = [
  entry('BTC/USDT', (capital * 0.7) / 50000, -(capital * 0.7), 50000),
];

console.log('Cash-floor invariant — cash % >= floor after replaying modeled fills:');
cashFloorHolds('pure buy from 100% cash', [], { BTC: 35, ETH: 35, USDT: 30 });
cashFloorHolds('mixed sell+buy at the floor (the regression)', book70BTC, { BTC: 35, ETH: 35, USDT: 30 });
cashFloorHolds('over-cap proposal, clamped + mixed', book70BTC, { BTC: 50, ETH: 50, USDT: 0 });
cashFloorHolds('de-risk most of the book to cash', book70BTC, { BTC: 10, ETH: 0, USDT: 90 });

console.log(`\n${passed} cash-floor invariant checks passed.`);
