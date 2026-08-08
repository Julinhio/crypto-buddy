import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config, validateTransitionConfig } from '../config/index.js';
import type { Candle } from '../market/klines.js';
import { regimeTimeline, resolveRegimes, toRegimeJournal, type AssetSeries } from '../market/regime.js';
import { stickyTimeline, type StickyPoint } from '../market/transition.js';
import { ZERO, dec } from '../money.js';
import {
  saveTransitionObservations,
  toObservationRow,
} from '../persistence/transitionObservations.js';
import { toDecisionContext } from '../decision/context.js';
import { expectsObservation, missingObservationBatches } from '../replay/transitionCycles.js';
import { evaluateTransition, judgeOrder, type TransitionInputs } from '../transition/gate.js';

/**
 * Invariants of the TRANSITION LAYER — run with `npm test` (tsx). No framework.
 *
 * `src/test/stickyTransition.ts` proves the RULE (the four contract points, causality,
 * label equivalence). This file proves the LAYER built on top of it: the priority ladder,
 * the peak stop's refusal to invent its own inputs, the order verdicts — and the two
 * properties that make observe mode observe-only, namely that the model's payload is
 * untouched and that the journal writer cannot fail a cycle.
 *
 * The end-to-end equivalence with the measurement runs against the live database and
 * lives in `npm run replay:transition-layer`, not here.
 */

const H4_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
let passed = 0;

/** A sticky state, defaulted to "comfortably actionable" and perturbed per case. */
function sticky(over: Partial<StickyPoint> = {}): StickyPoint {
  return {
    timestamp: 100 * H4_MS,
    active: 'trend_up',
    raw: 'trend_up',
    runLength: 9,
    labelRun: 9,
    actionable: true,
    frozen: false,
    ...over,
  };
}

const FROZEN = sticky({ raw: 'range', runLength: 2, labelRun: 2, actionable: false, frozen: true });

/** Inputs for a held, priced line, defaulted to "nothing special happening". */
function inputs(over: Partial<TransitionInputs> = {}): TransitionInputs {
  return {
    asset: 'BTC',
    sticky: sticky(),
    riskOffConfirmed: false,
    qty: dec(1),
    price: dec(100),
    priceStale: false,
    peakPriceSinceEntry: dec(100),
    stopThresholdPercent: 10,
    ...over,
  };
}

{
  // THE LADDER, in its fixed order. Each rung is proven to beat the one below it by
  // setting up a case that would satisfy BOTH and checking which one wins — a test that
  // merely exercised each rung in isolation would pass on any ordering.
  const stopAndFrozenAndRiskOff = inputs({
    sticky: FROZEN,
    riskOffConfirmed: true,
    price: dec(85),
    peakPriceSinceEntry: dec(100),
  });
  assert.equal(evaluateTransition(stopAndFrozenAndRiskOff).gate, 'stop_exit', '1 beats 2 and 3');

  const frozenAndRiskOff = inputs({ sticky: FROZEN, riskOffConfirmed: true, price: dec(95) });
  assert.equal(evaluateTransition(frozenAndRiskOff).gate, 'risk_off_reduction', '2 beats 3');

  const frozenOnly = inputs({ sticky: FROZEN, riskOffConfirmed: false, price: dec(95) });
  assert.equal(evaluateTransition(frozenOnly).gate, 'frozen', '3 applies when 1 and 2 do not');

  assert.equal(evaluateTransition(inputs()).gate, 'actionable', '4 is the fallback');

  // risk_off does NOT downgrade an asset that is actionable anyway: rung 2 exists to lift
  // an individual freeze, not to restrict a line the gate is happy with.
  assert.equal(
    evaluateTransition(inputs({ riskOffConfirmed: true })).gate,
    'actionable',
    'a confirmed risk_off on an actionable asset leaves the normal playbook in charge',
  );
  console.log('  ok: the priority ladder resolves in the fixed order, rung by rung');
  passed += 1;
}

{
  // THE STOP IS ARMED ONLY DURING A TRANSITION, and only on a line that exists. Outside
  // those two conditions it must not even look at the price — the model owns the line.
  const deepUnderwaterButActionable = inputs({ price: dec(50), peakPriceSinceEntry: dec(100) });
  const v = evaluateTransition(deepUnderwaterButActionable);
  assert.equal(v.stopArmed, false, '50% below the peak, but the asset is actionable → not armed');
  assert.equal(v.stopWouldFire, false, 'and therefore it cannot fire');
  assert.equal(v.gate, 'actionable', 'the ladder is unaffected');

  const flat = evaluateTransition(inputs({ sticky: FROZEN, qty: ZERO, price: dec(50) }));
  assert.equal(flat.stopArmed, false, 'a flat line has nothing to stop out of');
  assert.equal(flat.gate, 'frozen', 'it is still frozen — the gate and the stop are separate questions');
  console.log('  ok: the stop arms only mid-transition, on a line actually held');
  passed += 1;
}

{
  // NO ORDER ON A MISSING OR STALE INPUT, and never a substitute value. This is the branch
  // that must refuse to be helpful: a stop that invents its own input fires on nothing.
  const stale = evaluateTransition(
    inputs({ sticky: FROZEN, priceStale: true, price: dec(50), peakPriceSinceEntry: dec(100) }),
  );
  assert.equal(stale.stopWouldFire, false, 'a stale price cannot fire the stop');
  assert.equal(stale.drawdownFromPeakPercent, null, 'and produces NO drawdown number at all');
  assert.match(stale.stopAbstainedReason ?? '', /stale/, 'the abstention is recorded, not silent');
  assert.equal(stale.gate, 'frozen', 'the asset stays frozen — abstaining is not permitting');

  const noPrice = evaluateTransition(inputs({ sticky: FROZEN, price: null }));
  assert.equal(noPrice.stopWouldFire, false, 'no live price, no order');
  assert.match(noPrice.stopAbstainedReason ?? '', /no live price/, 'and it says so');

  const noPeak = evaluateTransition(
    inputs({ sticky: FROZEN, price: dec(50), peakPriceSinceEntry: null }),
  );
  assert.equal(noPeak.stopWouldFire, false, 'no peak on record, no order');
  assert.equal(noPeak.drawdownFromPeakPercent, null, 'a drawdown against nothing is not a number');
  assert.match(noPeak.stopAbstainedReason ?? '', /no peak/, 'and it says so');

  // An ARMED abstention is not the same fact as "did not fire": the first is a data
  // problem, the second is a market reading, and the journal keeps them apart.
  assert.equal(stale.stopArmed, true, 'it WAS armed — it just could not look');
  console.log('  ok: a missing or stale input produces no order and no fabricated number');
  passed += 1;
}

{
  // THE THRESHOLD, at its exact boundary and on the right side of it.
  const at = evaluateTransition(
    inputs({ sticky: FROZEN, price: dec(90), peakPriceSinceEntry: dec(100), stopThresholdPercent: 10 }),
  );
  assert.equal(at.drawdownFromPeakPercent, -10, 'exactly 10% below the peak');
  assert.equal(at.stopWouldFire, true, 'the threshold is inclusive — at −10% it fires');

  const justAbove = evaluateTransition(
    inputs({ sticky: FROZEN, price: dec('90.01'), peakPriceSinceEntry: dec(100) }),
  );
  assert.equal(justAbove.stopWouldFire, false, 'a hair less than 10% does not');

  // THE RATCHET. The stored peak is last cycle's; a new high must read as a drawdown of
  // zero, never as a positive one, which is not a thing.
  const newHigh = evaluateTransition(
    inputs({ sticky: FROZEN, price: dec(120), peakPriceSinceEntry: dec(100) }),
  );
  assert.equal(newHigh.drawdownFromPeakPercent, 0, 'a new high is a drawdown of zero');
  assert.equal(newHigh.stopWouldFire, false, 'and obviously does not fire');
  console.log('  ok: the threshold is exact, and a new high never reads as a positive drawdown');
  passed += 1;
}

{
  // A NONSENSICAL THRESHOLD IS REFUSED. At 0 the stop fires on every frozen bar of every
  // held line — a full liquidation at the first transition; at 100 it can never fire. In
  // OBSERVE mode neither would surface as a failure, just as a journal full of confident
  // nonsense, which is why it is rejected at the call rather than left to the reader.
  for (const bad of [0, -1, 100, 101, Number.NaN]) {
    assert.throws(
      () => evaluateTransition(inputs({ stopThresholdPercent: bad })),
      /stopThresholdPercent must be in \(0, 100\)/,
      `threshold ${bad} must be refused`,
    );
  }
  assert.throws(() => validateTransitionConfig({ peakStopPercent: 0 }), /peakStopPercent/);
  assert.doesNotThrow(() => validateTransitionConfig(config.transition), 'the shipped config is valid');
  assert.equal(config.transition.peakStopPercent, 10, 'the calibrated threshold is 10% (RAPPORT §5)');
  console.log('  ok: an unusable stop threshold fails loudly, at the call and at startup');
  passed += 1;
}

{
  // ORDER VERDICTS. The asymmetry on rung 2 is the load-bearing part: a confirmed
  // risk_off lifts the freeze for REDUCTIONS, and only for those.
  const frozen = evaluateTransition(inputs({ sticky: FROZEN, price: dec(95) }));
  assert.equal(judgeOrder(frozen, 'sell').verdict, 'forbidden', 'a frozen sell is refused');
  assert.equal(judgeOrder(frozen, 'buy').verdict, 'forbidden', 'so is a frozen buy');

  const riskOff = evaluateTransition(inputs({ sticky: FROZEN, riskOffConfirmed: true, price: dec(95) }));
  assert.equal(judgeOrder(riskOff, 'sell').verdict, 'allowed', 'de-risking survives the freeze');
  assert.equal(judgeOrder(riskOff, 'buy').verdict, 'forbidden', 'adding exposure does not');

  const open = evaluateTransition(inputs());
  assert.equal(judgeOrder(open, 'buy').verdict, 'allowed', 'an actionable asset trades normally');
  assert.equal(judgeOrder(open, 'sell').verdict, 'allowed', 'in both directions');

  // `superseded` is deliberately neither allowed nor forbidden: on a stop_exit cycle the
  // code would be selling the whole line anyway, so the model's order is moot. Folding it
  // into either bucket would corrupt the counts the observation exists to produce.
  const stopping = evaluateTransition(
    inputs({ sticky: FROZEN, price: dec(80), peakPriceSinceEntry: dec(100) }),
  );
  assert.equal(stopping.gate, 'stop_exit');
  assert.equal(judgeOrder(stopping, 'sell').verdict, 'superseded', 'a sell agrees with the exit');
  assert.equal(judgeOrder(stopping, 'buy').verdict, 'superseded', 'a buy is overtaken by it');

  // No bar closed → the layer abstains rather than defaulting either way.
  const blind = evaluateTransition(inputs({ sticky: null }));
  assert.equal(blind.gate, 'no_regime');
  assert.equal(blind.actionable, false, 'not actionable...');
  assert.equal(judgeOrder(blind, 'buy').verdict, 'unjudged', '...but not "forbidden" either');
  console.log('  ok: order verdicts, including the risk_off asymmetry and the two non-verdicts');
  passed += 1;
}

{
  // PURITY. The gate is called by the live cycle AND by the proof harness, and the whole
  // equivalence claim rests on those being the same function over the same inputs. So it
  // must not read a clock, a config or a database — same inputs, same output, always.
  const twice = [evaluateTransition(inputs({ sticky: FROZEN })), evaluateTransition(inputs({ sticky: FROZEN }))];
  assert.deepEqual(twice[0], twice[1], 'two identical calls produce identical verdicts');

  // And it must not mutate what it is given.
  const given = inputs({ sticky: FROZEN });
  const snapshot = JSON.stringify({ ...given, qty: given.qty.toString(), price: given.price?.toString() });
  evaluateTransition(given);
  assert.equal(
    JSON.stringify({ ...given, qty: given.qty.toString(), price: given.price?.toString() }),
    snapshot,
    'the inputs are left untouched',
  );
  console.log('  ok: the gate is pure — same inputs, same verdict, no mutation');
  passed += 1;
}

{
  // THE MODEL'S PAYLOAD IS UNCHANGED, and this is the condition for the observation to be
  // worth anything. Production now walks the whole regime TIMELINE (it needs the run
  // length, which the journaled fields cannot give it) where it used to call
  // `resolveRegimes`. If those two ever produced different last points, the regime shown
  // to the model — and the `regime` column — would have moved in the same PR that measures
  // the gate, and nothing observed could be attributed to either.
  const daily: Candle[] = [];
  for (let i = 0; i < 260; i += 1) {
    const close = 100 + Math.sin(i / 7) * 12 + i * 0.05;
    daily.push({ timestamp: i * DAY_MS, open: close, high: close + 1, low: close - 1, close, volume: 0 });
  }
  const h4: Candle[] = [];
  for (let i = 0; i < 260 * 6; i += 1) {
    const close = 100 + Math.sin(i / 11) * 9 + i * 0.008;
    h4.push({ timestamp: i * H4_MS, open: close, high: close + 1, low: close - 1, close, volume: 0 });
  }
  const universe: Record<string, AssetSeries> = { BTC: { daily, h4 }, ETH: { daily, h4 } };
  const opts = { nowMs: 260 * DAY_MS, barMs: H4_MS, universeSize: 2 };

  const viaResolve = resolveRegimes(universe, config.regime.thresholds, opts);
  const timeline = regimeTimeline(universe, config.regime.thresholds, opts);
  const viaTimeline = timeline[timeline.length - 1] ?? null;
  assert.notEqual(viaResolve, null, 'the fixture must actually produce a regime');
  assert.deepEqual(
    toRegimeJournal(viaTimeline!),
    toRegimeJournal(viaResolve!),
    'the journal built from the timeline\'s last point is identical to resolveRegimes\'',
  );
  console.log('  ok: reading the timeline\'s last point leaves the journaled regime byte-identical');
  passed += 1;
}

{
  // THE ROW SHAPING. Money reaches a `numeric` column as a full-precision string, never as
  // an IEEE-754 float — the project's rule everywhere else, and it matters here because
  // the peak and the price are what a later analysis will recompute drawdowns from.
  const verdict = evaluateTransition(
    inputs({ sticky: FROZEN, price: dec('0.123456789012345'), peakPriceSinceEntry: dec('0.2') }),
  );
  const row = toObservationRow(42, verdict, {
    side: 'sell',
    notional: '12.34',
    ...judgeOrder(verdict, 'sell'),
  });
  assert.equal(row.decision_id, 42);
  assert.equal(row.asset, 'BTC');
  assert.equal(typeof row.price, 'string', 'the price is a string, not a float');
  assert.equal(row.price, '0.123456789012345', 'at full precision, unrounded');
  assert.equal(row.peak_price, '0.2');
  assert.equal(row.bar_at, new Date(100 * H4_MS).toISOString(), 'the bar, not the wake-up time');
  assert.equal(row.gate, 'stop_exit');
  assert.equal(row.order_verdict, 'superseded');
  assert.equal(row.run_length, 2);

  // A cycle with no order on this asset — the common case — leaves the order columns null
  // rather than defaulting them to something a query would have to filter out.
  const quiet = toObservationRow(42, evaluateTransition(inputs()), null);
  assert.equal(quiet.order_side, null);
  assert.equal(quiet.order_verdict, null);
  assert.equal(quiet.order_notional, null);
  console.log('  ok: the observation row keeps money exact and says nothing it was not told');
  passed += 1;
}

{
  // THE WRITER CANNOT FAIL A CYCLE. This is the safety property of observe mode: a purely
  // observational component must never acquire the power to stop a trade. It is asserted
  // on the two ways it can go wrong — the client rejecting, and the client throwing.
  const rows = [toObservationRow(1, evaluateTransition(inputs()), null)];

  const rejecting = {
    from: () => ({
      upsert: () => ({ abortSignal: async () => ({ error: { message: 'permission denied' } }) }),
    }),
  } as unknown as SupabaseClient;
  assert.equal(await saveTransitionObservations(rejecting, rows), false, 'a rejected write returns false');

  const throwing = {
    from: () => ({
      upsert: () => ({
        abortSignal: async () => {
          throw new Error('connection reset');
        },
      }),
    }),
  } as unknown as SupabaseClient;
  assert.equal(await saveTransitionObservations(throwing, rows), false, 'a thrown write returns false');

  // And a client that blows up before the query is even built — a shape change in
  // supabase-js, a missing table helper — must be caught too, not escape into the cycle.
  const broken = {
    from: () => {
      throw new Error('client is not what we think it is');
    },
  } as unknown as SupabaseClient;
  assert.equal(await saveTransitionObservations(broken, rows), false, 'a broken client returns false');

  // No Supabase at all is a local run, not a failure to propagate.
  assert.equal(await saveTransitionObservations(null, rows), false, 'no client, no throw');
  // And an empty batch is a no-op success rather than a pointless round trip.
  assert.equal(await saveTransitionObservations(null, []), true, 'nothing to write is not a failure');

  const accepting = {
    from: () => ({ upsert: () => ({ abortSignal: async () => ({ error: null }) }) }),
  } as unknown as SupabaseClient;
  assert.equal(await saveTransitionObservations(accepting, rows), true, 'the happy path still reports true');
  console.log('  ok: the observation writer never throws — it cannot fail a cycle');
  passed += 1;
}

{
  // A WRITE THAT NEVER SETTLES MUST NOT HANG THE CYCLE, and this is the property a
  // try/catch cannot provide — it only handles the writes that finish. An accepted but
  // never-resolving request would burn the cycle budget and let the watchdog force-exit
  // the process AFTER the orders were placed, turning a successful cycle into a recorded
  // failure. A purely observational layer changing operational behaviour is precisely
  // what this brick promises it cannot do.
  const hanging = {
    from: () => ({
      upsert: () => ({
        // Never settles, and ignores the abort signal — so the guarantee is tested on the
        // backstop rather than on the client's good behaviour.
        abortSignal: () => new Promise(() => {}),
      }),
    }),
  } as unknown as SupabaseClient;

  const rows = [toObservationRow(1, evaluateTransition(inputs()), null)];
  const started = Date.now();
  const landed = await saveTransitionObservations(hanging, rows);
  const elapsed = Date.now() - started;

  assert.equal(landed, false, 'a write that never settles is reported as a miss');
  assert.ok(
    elapsed < 30_000,
    `the writer must return on its own deadline, not hang the cycle (took ${elapsed}ms)`,
  );
  console.log(`  ok: a hung write returns on its deadline (${elapsed}ms) instead of burning the cycle`);
  passed += 1;
}

{
  // A LOST BATCH MUST NOT LOOK LIKE A PRE-DEPLOYMENT CYCLE.
  //
  // `decide()` has two `skipped` paths and only ONE of them returns before the observation
  // closure. Exempting on the status alone waived both — so a write lost on the
  // empty-context path (which DOES call `observeTransition`) was indistinguishable from
  // the lifecycle-read path's deliberate abstention, and P1d stayed green through it. The
  // writer's 5s deadline makes that loss more likely, not less, which is exactly why the
  // exemption has to be granted on the REASON.
  const EDGE_0 =
    "the execution journal could not be read — refusing to trade on a book and a lifecycle " +
    'we cannot record the outcome of.';
  const EDGE_1 =
    'no tradable pairs returned usable market data — refusing to decide on an empty universe';

  assert.equal(
    expectsObservation({ status: 'skipped', skipReason: EDGE_0 }),
    false,
    'edge case 0 returns before the closure — no observation is correct',
  );
  assert.equal(
    expectsObservation({ status: 'skipped', skipReason: EDGE_1 }),
    true,
    'edge case 1 calls the closure — an observation IS expected',
  );
  assert.equal(
    expectsObservation({ status: 'decided', skipReason: null }),
    true,
    'every non-skipped path reaches the closure',
  );
  // Fail-closed: an unrecognised skip reason is EXPECTED to have written, so it turns the
  // check red and gets looked at rather than being waved through.
  assert.equal(
    expectsObservation({ status: 'skipped', skipReason: 'some future skip nobody has written yet' }),
    true,
    'an unknown skip reason is not silently exempted',
  );

  // And the property P1d actually reads: the empty-context skip, post-cutoff, with no row
  // written, must be REPORTED — that is the case that used to pass unnoticed.
  const cycles = [
    { id: 10, status: 'decided', skipReason: null }, // pre-cutoff, no rows: fine
    { id: 20, status: 'decided', skipReason: null }, // the cutoff itself, observed
    { id: 21, status: 'skipped', skipReason: EDGE_0 }, // exempt: returns before the closure
    { id: 22, status: 'skipped', skipReason: EDGE_1 }, // NOT exempt, and wrote nothing
    { id: 23, status: 'decided', skipReason: null }, // wrote nothing either
    { id: 24, status: 'error', skipReason: null }, // observed
  ];
  const lost = missingObservationBatches({
    cycles,
    observedCycleIds: new Set([20, 24]),
    cutoff: 20,
  });

  assert.deepEqual(
    lost.map((c) => c.id),
    [22, 23],
    'the empty-context skip and the silent decided cycle are both reported as lost batches',
  );
  assert.equal(
    lost.some((c) => c.id === 21),
    false,
    'the lifecycle-read skip is not counted as a loss',
  );
  assert.equal(
    lost.some((c) => c.id === 10),
    false,
    'cycles before the deployment cutoff are not counted either',
  );
  console.log('  ok: a batch lost on the empty-context skip is reported, not waived as pre-deployment');
  passed += 1;
}

{
  // THE PAYLOAD THE MODEL RECEIVES IS UNCHANGED — the most direct form of the claim.
  //
  // `MarketContext` gained a `transition` field this PR. `DecisionContext` is what the
  // model is shown AND what `decisions.market_context` stores, so if the new field leaked
  // into it, both the prompt and the stored tape would have moved in the same PR that
  // measures the gate — and nothing observed could be attributed to one rather than the
  // other. Asserted on the KEYS rather than by reading the mapping, so it keeps holding if
  // someone later adds a spread.
  const marketWithTransition = {
    generatedAt: '2026-08-08T00:00:00.000Z',
    source: { marketData: 'binance-public-mainnet', account: 'binance-testnet' },
    regime: null,
    transition: { barAtMs: 100 * H4_MS, perAsset: { BTC: sticky() } },
    market: { tradable: [], reference: [] },
    account: { balances: [] },
  } as unknown as Parameters<typeof toDecisionContext>[0];

  const book = {
    reserveAsset: 'USDT',
    startingCapital: dec(1000),
    cash: dec(1000),
    equity: dec(1000),
    deployedPercent: ZERO,
    realizedPnl: ZERO,
    unrealizedPnl: ZERO,
    totalPnl: ZERO,
    positions: [],
  } as unknown as Parameters<typeof toDecisionContext>[1];

  for (const strategy of ['v4', 'v5'] as const) {
    const shown = toDecisionContext(marketWithTransition, book, strategy, new Map());
    assert.equal(
      Object.hasOwn(shown, 'transition'),
      false,
      `the ${strategy} payload must not carry the transition read`,
    );
    assert.equal(
      JSON.stringify(shown).includes('runLength'),
      false,
      `no part of the sticky state may reach the ${strategy} payload, at any depth`,
    );
  }
  console.log('  ok: the transition read never reaches the model, under v4 or v5');
  passed += 1;
}

{
  // The rule and the layer must not drift apart on the one number they share. The gate
  // reads `sticky.frozen`, and `frozen` comes from the regime's OWN `confirmations` — the
  // layer deliberately holds no second copy of it.
  const walk = stickyTimeline(
    [0, 1, 2].map((i) => ({ timestamp: i * H4_MS, raw: 'range' as const })),
    config.regime.thresholds.confirmations,
    H4_MS,
  );
  const last = walk[walk.length - 1]!;
  assert.equal(
    last.actionable,
    last.runLength >= config.regime.thresholds.confirmations,
    'actionability is exactly the regime\'s own confirmation count — no second threshold',
  );
  assert.equal(evaluateTransition(inputs({ sticky: last })).gate, 'actionable');
  console.log('  ok: the layer holds no second copy of `confirmations`');
  passed += 1;
}

console.log(`\n${passed} transition-layer invariant checks passed.`);
