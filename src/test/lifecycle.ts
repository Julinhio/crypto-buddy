import assert from 'node:assert/strict';
import { dec, ZERO, type Decimal } from '../money.js';
import { nextPositionState, nextPositionStates, type PositionState } from '../portfolio/lifecycle.js';
import { backfillOne } from '../portfolio/backfill.js';
import { derivePortfolio, type PriceLookup } from '../portfolio/derive.js';
import { loadLedger, type LedgerEntry } from '../persistence/executions.js';
import { loadPositionStates } from '../persistence/positionState.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Position lifecycle invariants — run with `npm test` (tsx). No framework, just asserts.
 *
 * Two things are being protected here, and both are named explicitly in the mandate
 * because both are easy to get wrong in a way nothing else would catch:
 *
 *  - the peak is a PRICE, ratcheting up, reset ONLY by a full exit. A trailing stop
 *    wired to anything else fires on a drawdown that never happened;
 *  - a position's life starts at its LAST zero → positive transition. A line sold off
 *    and bought back must not inherit the previous life's peak.
 *
 * The backfill gets the same scrutiny as the live path even though it runs once —
 * precisely BECAUSE it runs once. A live bug gets corrected by the next cycle; a
 * backfill bug is baked into the state forever.
 */

let passed = 0;
const T0 = '2026-06-08T10:30:00.000Z';
const T1 = '2026-06-20T10:30:00.000Z';
const T2 = '2026-07-01T10:30:00.000Z';
const T3 = '2026-07-20T10:30:00.000Z';

const open = (over: Partial<PositionState> = {}): PositionState => ({
  asset: 'ETH',
  entryDate: T0,
  peakPriceSinceEntry: dec(1900),
  lastSignificantMoveAt: T0,
  lastSignificantMoveSide: 'buy',
  lastSignificantMoveNotional: dec(200),
  qty: dec(1),
  thesis: 'accumulating the reclaim of the 50d',
  invalidation: 'a daily close back under 1600',
  thesisUpdatedAt: T0,
  ...over,
});

{
  // The peak RATCHETS: it follows a new high and ignores everything below it.
  const higher = nextPositionState({
    asset: 'ETH', previous: open(), qty: dec(1), price: dec(1950), booked: null, now: T1,
  });
  assert.equal(higher.peakPriceSinceEntry?.toString(), '1950', 'a new high raises the peak');

  const lower = nextPositionState({
    asset: 'ETH', previous: open(), qty: dec(1), price: dec(1500), booked: null, now: T1,
  });
  assert.equal(lower.peakPriceSinceEntry?.toString(), '1900', 'a lower price never lowers the peak');
  assert.equal(lower.entryDate, T0, 'and the entry date is untouched');
  console.log('  ok: the peak ratchets up on price and never retreats');
  passed += 1;
}

{
  // A REINFORCEMENT and a PARTIAL TRIM both leave the peak, the entry and the thesis
  // alone. The trim is the dangerous one: the position's VALUATION halves, and a peak
  // wired to a valuation would read that as a 50% drawdown and fire a trailing exit.
  const reinforced = nextPositionState({
    asset: 'ETH', previous: open(), qty: dec(1.5), price: dec(1700),
    booked: { side: 'buy', notional: dec(850) }, now: T1,
  });
  assert.equal(reinforced.peakPriceSinceEntry?.toString(), '1900', 'a reinforcement does not reset the peak');
  assert.equal(reinforced.entryDate, T0, 'nor the entry date — the life did not restart');
  assert.equal(reinforced.thesis, open().thesis, 'nor the thesis');

  const trimmed = nextPositionState({
    asset: 'ETH', previous: open(), qty: dec('0.5'), price: dec(1700),
    booked: { side: 'sell', notional: dec(850) }, now: T1,
  });
  assert.equal(trimmed.peakPriceSinceEntry?.toString(), '1900', 'a 50% trim does not reset the peak');
  assert.equal(trimmed.entryDate, T0, 'nor the entry date');
  assert.equal(trimmed.thesis, open().thesis, 'a partial trim does not invalidate the thesis');
  assert.equal(trimmed.lastSignificantMoveSide, 'sell', 'but the move is recorded');
  assert.equal(trimmed.lastSignificantMoveAt, T1);
  console.log('  ok: a reinforcement and a partial trim leave peak, entry and thesis intact');
  passed += 1;
}

{
  // A FULL EXIT ends the life. Entry, peak and thesis are cleared TOGETHER — leaving
  // any one of them behind is how the next entry inherits a previous life.
  const exited = nextPositionState({
    asset: 'ETH', previous: open(), qty: ZERO, price: dec(1700),
    booked: { side: 'sell', notional: dec(1700) }, now: T2,
  });
  assert.equal(exited.entryDate, null, 'a full exit clears the entry date');
  assert.equal(exited.peakPriceSinceEntry, null, 'and the peak');
  assert.equal(exited.thesis, null, 'and the thesis — it describes a position that no longer exists');
  assert.equal(exited.invalidation, null);
  assert.equal(exited.qty.toString(), '0');
  assert.equal(exited.lastSignificantMoveAt, T2, 'the exit itself stays in the history');

  // And the RE-ENTRY starts clean: the new peak is today's price, not the old high.
  const reentered = nextPositionState({
    asset: 'ETH', previous: exited, qty: dec(1), price: dec(1650),
    booked: { side: 'buy', notional: dec(1650) }, now: T3,
  });
  assert.equal(reentered.entryDate, T3, 'the re-entry sets a NEW entry date');
  assert.equal(reentered.peakPriceSinceEntry?.toString(), '1650', 'and a NEW peak — no previous life inherited');
  console.log('  ok: a full exit ends the life; a re-entry inherits nothing from it');
  passed += 1;
}

{
  // A missing price must NOT touch the peak. The valuation path falls back to avgCost
  // when a price is stale; doing that here would silently overwrite a high-water mark
  // with a cost basis.
  const stale = nextPositionState({
    asset: 'ETH', previous: open(), qty: dec(1), price: null, booked: null, now: T1,
  });
  assert.equal(stale.peakPriceSinceEntry?.toString(), '1900', 'a stale price leaves the peak alone');

  // A brand-new position with no price yet has no peak — not a zero, which would be a
  // different and impossible claim.
  const priceless = nextPositionState({
    asset: 'ETH', previous: null, qty: dec(1), price: null, booked: null, now: T1,
  });
  assert.equal(priceless.peakPriceSinceEntry, null, 'no price yet means no peak, never zero');
  assert.equal(priceless.entryDate, T1);
  console.log('  ok: a stale price never rewrites the peak');
  passed += 1;
}

{
  // The universe-level pass covers EVERY configured asset, including one that just
  // went flat — otherwise a closed line keeps a stale entry date and peak on its row.
  const prices: PriceLookup = (a) =>
    a === 'BTC' ? dec(64000) : a === 'ETH' ? dec(1850) : a === 'USDT' ? dec(1) : null;
  const ledger: LedgerEntry[] = [
    { symbol: 'BTC/USDT', side: 'buy', valuationPrice: dec(63000), baseDelta: dec('0.004'), quoteDelta: dec(-252) },
  ];
  const book = derivePortfolio(ledger, { startingCapital: dec(1000), reserveAsset: 'USDT', priceOf: prices });
  const previous = new Map<string, PositionState>([
    ['ETH', open({ asset: 'ETH', qty: dec(1) })], // held last cycle, gone now
  ]);
  const states = nextPositionStates({
    assets: ['BTC', 'ETH'],
    previous,
    portfolio: book,
    priceOf: prices,
    bookedLedger: ledger,
    now: T2,
  });
  const byAsset = new Map(states.map((s) => [s.asset, s]));
  assert.equal(states.length, 2, 'every configured asset gets a row, held or not');
  assert.equal(byAsset.get('BTC')?.entryDate, T2, 'the new BTC line records its entry');
  assert.equal(byAsset.get('BTC')?.lastSignificantMoveSide, 'buy', 'and the booking that created it');
  assert.equal(byAsset.get('ETH')?.entryDate, null, 'the vanished ETH line is reset, not left stale');
  assert.equal(byAsset.get('ETH')?.peakPriceSinceEntry, null);
  console.log('  ok: every configured asset is written, including one that just went flat');
  passed += 1;
}

/* ── The one-time backfill ─────────────────────────────────────────────────── */

const fill = (at: string, asset: string, baseDelta: string, price: string) => ({
  at, asset, baseDelta: dec(baseDelta), price: dec(price),
});
const seen = (at: string, price: string) => ({ at, price: dec(price) });
/** A flat $1000 book, so the 2% floor sits at $20 throughout these cases. */
const flatEquity = (): Decimal => dec(1000);
const backfill = (
  asset: string,
  fills: Parameters<typeof backfillOne>[0]['fills'],
  observed: Parameters<typeof backfillOne>[0]['observed'],
  equityAt: (at: string) => Decimal | null = flatEquity,
) => backfillOne({ asset, fills, observed, equityAt, minMovementPercent: 2 });

{
  // THE RULE THAT MATTERS: history starts at the LAST zero → positive transition. A
  // line bought, sold off, then bought back must not inherit the first life's peak.
  // The real table cannot exercise this (no line has ever been closed), so it is
  // proven here — a backfill bug is baked in forever, there is no next cycle to fix it.
  const fills = [
    fill(T0, 'XRP', '100', '1.00'),   // life 1 opens
    fill(T1, 'XRP', '-100', '1.28'),  // life 1 closes at a high
    fill(T2, 'XRP', '80', '1.05'),    // life 2 opens, LOWER
  ];
  const observed = [
    seen(T0, '1.00'),
    seen(T1, '1.2856'), // the high of the PREVIOUS life
    seen(T2, '1.05'),
    seen(T3, '1.12'),   // the high of the CURRENT life
  ];
  const state = backfill('XRP', fills, observed);
  assert.equal(state.entryDate, T2, 'the entry is the LAST transition, not the first');
  assert.equal(state.peakPriceSinceEntry?.toString(), '1.12', 'the peak ignores the previous life entirely');
  assert.equal(state.qty.toString(), '80');
  assert.equal(state.lastSignificantMoveSide, 'buy');
  console.log('  ok: the backfill starts at the LAST entry — no peak inherited from a previous life');
  passed += 1;
}

{
  // A line that is flat today gets no life and no peak, whatever it did before.
  const fills = [fill(T0, 'XRP', '100', '1.00'), fill(T1, 'XRP', '-100', '1.28')];
  const state = backfill('XRP', fills, [seen(T0, '1.00'), seen(T1, '1.2856')]);
  assert.equal(state.entryDate, null, 'a closed line has no entry date');
  assert.equal(state.peakPriceSinceEntry, null, 'and no peak to inherit');
  assert.equal(state.qty.toString(), '0');
  assert.equal(state.lastSignificantMoveSide, 'sell', 'its last move is still history');

  // An asset the bot never touched is simply flat.
  const untouched = backfill('SOL', fills, []);
  assert.equal(untouched.entryDate, null);
  assert.equal(untouched.lastSignificantMoveAt, null, 'never traded means no move on record');
  console.log('  ok: a closed or never-held line backfills to flat, with nothing to inherit');
  passed += 1;
}

{
  // The peak comes from BOTH sources the bot really observed — the spot prices in
  // market_context and the valuation price of each fill. Sampling the backfill from
  // one and the live ratchet from the other would make the peak jump on switch day.
  const fills = [fill(T0, 'ETH', '1', '1665'), fill(T2, 'ETH', '-0.1', '1947.33')];
  const observed = [seen(T0, '1665'), seen(T1, '1800')];
  const state = backfill('ETH', fills, observed);
  assert.equal(
    state.peakPriceSinceEntry?.toString(),
    '1947.33',
    "a fill's valuation price counts toward the peak, not only the context snapshots",
  );
  console.log('  ok: the peak is sampled from every price the bot actually saw');
  passed += 1;
}

{
  // `last_significant_move` must be filtered by the V2 SIGNIFICANCE rule, not simply
  // taken as "the last fill". The history predates the 2% floor and is mostly $5-7
  // dribbles; copying the latest of those in would hand the v5 model "sell of 5.06 on
  // 22/07" as though it were a decision — re-injecting the noise PR 2 deleted.
  const fills = [
    fill(T0, 'ETH', '0.12', '1665'),   // $199.80 on a $1000 book — significant
    fill(T1, 'ETH', '0.004', '1687'),  //   $6.75 — a dribble
    fill(T2, 'ETH', '-0.003', '1794'), //   $5.38 — a dribble
  ];
  const state = backfill('ETH', fills, [seen(T0, '1665'), seen(T3, '1948')]);
  assert.equal(state.lastSignificantMoveAt, T0, 'the last SIGNIFICANT move, not the last fill');
  assert.equal(state.lastSignificantMoveSide, 'buy');
  assert.equal(state.lastSignificantMoveNotional?.toFixed(2), '199.80');
  // It coinciding with the entry is the honest answer, not a defect: nothing
  // significant has happened to this line since it was opened.
  assert.equal(state.entryDate, T0, 'which here coincides with the entry — 47 days of immobility, in data');
  assert.equal(state.qty.toString(), '0.121', 'the quantity still reflects EVERY fill, dribbles included');

  // A line whose only fills are dribbles has NO significant move on record.
  const onlyDribbles = backfill('BNB', [fill(T0, 'BNB', '0.01', '543')], [seen(T0, '543')]);
  assert.equal(onlyDribbles.lastSignificantMoveAt, null, 'no qualifying move means none is claimed');
  assert.equal(onlyDribbles.lastSignificantMoveSide, null);

  // The threshold follows the equity in force at the time, not a constant: the same
  // $199.80 buy is NOT significant on a $20,000 book.
  const rich = backfill('ETH', fills, [seen(T0, '1665')], () => dec(20000));
  assert.equal(rich.lastSignificantMoveAt, null, 'significance is measured against the equity of the day');

  // And an unverifiable move (no equity recorded yet) is not claimed as significant.
  const unknown = backfill('ETH', fills, [seen(T0, '1665')], () => null);
  assert.equal(unknown.lastSignificantMoveAt, null, 'no equity to judge against means no claim');
  console.log('  ok: the backfill records the last SIGNIFICANT move, judged against the equity of the day');
  passed += 1;
}

/* ── Read failures must never become writes ────────────────────────────────── */

/**
 * A minimal chainable Supabase stub. Every query builder method returns itself, and
 * awaiting it yields the configured `{ data, error }` — enough to exercise the two
 * read paths without a network or a database.
 */
function stubClient(result: { data?: unknown; error?: { message: string } }): SupabaseClient {
  const builder: Record<string, unknown> = {};
  const chain = (): unknown => builder;
  for (const method of ['from', 'select', 'eq', 'not', 'order', 'range', 'upsert', 'limit']) {
    builder[method] = chain;
  }
  builder.then = (resolve: (v: unknown) => unknown): unknown =>
    resolve({ data: result.data ?? null, error: result.error ?? null });
  return builder as unknown as SupabaseClient;
}

{
  // A FAILED read must be reported as failed, not as an empty result. This is the
  // whole guard: `[]` and `new Map()` are what a transient blip and a genuinely empty
  // table both produce, and writing lifecycle state from the first would reset every
  // entry date, peak and thesis — irreversibly.
  const brokenState = await loadPositionStates(stubClient({ error: { message: 'connection reset' } }));
  assert.equal(brokenState.ok, false, 'a failed position-state read reports ok=false');
  assert.equal(brokenState.states.size, 0, 'and still degrades to an empty map for the read path');

  const brokenLedger = await loadLedger(stubClient({ error: { message: 'connection reset' } }));
  assert.equal(brokenLedger.ok, false, 'a failed journal read reports ok=false');
  assert.deepEqual(brokenLedger.entries, [], 'and still degrades to an empty journal');

  // A genuinely EMPTY table is a success, and must stay distinguishable from the above.
  const emptyState = await loadPositionStates(stubClient({ data: [] }));
  assert.equal(emptyState.ok, true, 'an empty table is a successful read, not a failure');
  assert.equal(emptyState.states.size, 0);

  const emptyLedger = await loadLedger(stubClient({ data: [] }));
  assert.equal(emptyLedger.ok, true, 'an empty journal is a successful read too');

  // No Supabase at all is a local-dev affordance, not a failure.
  assert.equal((await loadPositionStates(null)).ok, true, 'no client configured is not a read failure');
  assert.equal((await loadLedger(null)).ok, true);
  console.log('  ok: a failed read is reported as failed, never as an empty result');
  passed += 1;
}

{
  // And a successful read decodes faithfully — in particular a NULL peak stays null
  // rather than becoming zero, which would be a different (and impossible) claim.
  const read = await loadPositionStates(
    stubClient({
      data: [
        {
          asset: 'ETH', entry_date: T0, peak_price_since_entry: '1948.37',
          last_significant_move_at: T1, last_significant_move_side: 'sell',
          last_significant_move_notional: '5.06', qty: '0.118',
          thesis: 'holding the trend', invalidation: 'close under 1600', thesis_updated_at: T1,
        },
        {
          asset: 'XRP', entry_date: null, peak_price_since_entry: null,
          last_significant_move_at: null, last_significant_move_side: null,
          last_significant_move_notional: null, qty: '0',
          thesis: null, invalidation: null, thesis_updated_at: null,
        },
      ],
    }),
  );
  assert.equal(read.ok, true);
  assert.equal(read.states.get('ETH')?.peakPriceSinceEntry?.toString(), '1948.37');
  assert.equal(read.states.get('ETH')?.thesis, 'holding the trend');
  assert.equal(read.states.get('XRP')?.peakPriceSinceEntry, null, 'a null peak decodes to null, never to zero');
  assert.equal(read.states.get('XRP')?.qty.toString(), '0');
  console.log('  ok: a stored state decodes faithfully, and a null peak stays null');
  passed += 1;
}

console.log(`\n${passed} lifecycle invariant checks passed.`);
