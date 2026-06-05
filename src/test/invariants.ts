import assert from 'node:assert/strict';
import { dec } from '../money.js';
import { derivePortfolio, type PriceLookup } from '../portfolio/derive.js';
import type { LedgerEntry } from '../persistence/executions.js';
import {
  computeMovements,
  bookedIntent,
  rejectedIntent,
  executionTrace,
  type Movement,
} from '../execution/movements.js';
import { snapQty, validateMovement, type SymbolRules } from '../execution/symbolRules.js';
import type { OrderResult } from '../execution/testnetOrder.js';
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

  // PR B books the SNAPPED qty; with identity rules (no exchange step) the booked
  // intent is numerically identical to PR A's modeled fill, so the load-bearing
  // cash-floor invariant carries over unchanged.
  const replayed: LedgerEntry[] = [
    ...initial,
    ...movements
      .map((m) => bookedIntent(m, m.qty, 1, 'test', cfg.execution.feePercent))
      .map((f) => ({
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
passed += 1;

// --- PR B: the four-state plumbing (pure checks, no network) ---
console.log('\nPR B — validation, snapping, and the two-event journal:');

const rules = (over: Partial<SymbolRules> = {}): SymbolRules => ({
  symbol: 'BTC/USDT',
  stepSize: dec('0.001'),
  minQty: dec('0.001'),
  maxQty: dec(0), // 0 = no max
  tickSize: dec('0.01'),
  minNotional: dec(5),
  bidMultiplierUp: null,
  bidMultiplierDown: null,
  askMultiplierUp: null,
  askMultiplierDown: null,
  ...over,
});

// snapQty truncates to the lot step; stepSize 0 disables snapping.
assert.equal(snapQty(dec('0.0127'), rules()).toString(), '0.012', 'snapQty truncates to stepSize');
assert.equal(snapQty(dec('0.0127'), rules({ stepSize: dec(0) })).toString(), '0.0127', 'stepSize 0 = no snap');
console.log('  ok: snapQty truncates to the lot step (and is a no-op when disabled)');
passed += 1;

// validateMovement: the verdict that alone gates booking.
assert.equal(
  validateMovement(dec('0.00009'), dec(50000), rules({ minQty: dec(0) })).kind,
  'crumb',
  'below min-notional → crumb', // 0.00009 * 50000 = 4.5 < 5
);
assert.equal(
  validateMovement(dec('0.001'), dec(50000), rules({ minQty: dec(0) })).kind,
  'ok',
  'above min-notional → ok', // 0.001 * 50000 = 50 ≥ 5
);
assert.equal(
  validateMovement(snapQty(dec('0.0005'), rules()), dec(50000), rules()).kind,
  'crumb',
  'snapped to zero → crumb',
);
assert.equal(
  validateMovement(dec('0.001'), dec(50000), rules({ minQty: dec(0), minNotional: dec(0), maxQty: dec('0.0005') })).kind,
  'block',
  'above maxQty → block',
);
console.log('  ok: validateMovement flags crumbs (min-notional / minQty / snapped-to-zero) and blocks (maxQty)');
passed += 1;

// Two-event journal: only a booked intent moves the book. A rejected intent and
// an execution trace carry ZERO ledger delta AND are excluded by loadLedger's
// filter (validation_status != 'executed' / event_type = 'execution').
const buy: Movement = {
  symbol: 'BTC/USDT', asset: 'BTC', side: 'buy',
  qty: dec('0.001'), price: dec(50000), notional: dec(50), fee: dec('0.05'),
};
const booked = bookedIntent(buy, dec('0.001'), 1, 'mainnet', 0.1);
assert.equal(booked.event_type, 'intent');
assert.equal(booked.validation_status, 'executed');
assert.equal(booked.ledger_base_delta.toString(), '0.001', 'booked buy adds the base qty');
assert.equal(booked.ledger_quote_delta.toString(), '-50.05', 'booked buy removes notional + fee'); // 50 + 50*0.001

const rej = rejectedIntent(buy, dec('0.001'), 1, 'mainnet', 'rejected', 'below min-notional');
assert.equal(rej.event_type, 'intent');
assert.notEqual(rej.validation_status, 'executed', 'a crumb is NOT booked');
assert.ok(rej.ledger_base_delta.isZero() && rej.ledger_quote_delta.isZero(), 'a crumb leaves the book intact');

const fakeOrder: OrderResult = {
  outcome: 'filled', orderId: '42', status: 'closed',
  submittedQty: dec('0.001'), submittedPrice: dec(50050), timeInForce: 'IOC',
  executedQty: dec('0.001'), avgPrice: dec(50050), errorCode: null, raw: {},
};
const trace = executionTrace(buy, dec('0.001'), 99, 1, fakeOrder);
assert.equal(trace.event_type, 'execution', 'a trace is an execution row');
assert.equal(trace.intent_execution_id, 99, 'a trace links back to its intent');
assert.equal(trace.validation_status, null, 'a trace has no sovereign validation_status');
assert.ok(trace.ledger_base_delta.isZero() && trace.ledger_quote_delta.isZero(), 'a testnet trace NEVER moves the book');
console.log('  ok: only a booked intent moves the book — crumbs and testnet traces carry zero ledger delta');
passed += 1;

console.log(`\n${passed} invariant checks passed.`);
