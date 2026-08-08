import assert from 'node:assert/strict';
import type { StickyPoint } from '../market/transition.js';
import { dec, ZERO } from '../money.js';
import { toObservationRow } from '../persistence/transitionObservations.js';
import { evaluateTransition, type TransitionInputs, type TransitionVerdict } from '../transition/gate.js';
import { judgeVector, type VectorLeg } from '../transition/vector.js';

/**
 * Invariants of ATOMICITY and PROVENANCE — run with `npm test` (tsx). No framework.
 *
 * `transitionLayer.ts` proves the per-asset ladder. This file proves the vector pass built
 * on top of it: that one refused strategic leg refuses them all, that the deterministic
 * exits are exempt from that and cannot trigger it, and — the point of the whole exercise —
 * that a leg refused because of its OWN asset and a leg refused because of a NEIGHBOUR
 * leave different marks in the journal.
 *
 * The measurement over the real corpus lives in `npm run replay:atomic-vector`.
 */

const H4_MS = 4 * 60 * 60 * 1000;
let passed = 0;

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

function verdict(asset: string, over: Partial<TransitionInputs> = {}): TransitionVerdict {
  return evaluateTransition({
    asset,
    sticky: sticky(),
    riskOffConfirmed: false,
    qty: dec(1),
    price: dec(100),
    priceStale: false,
    peakPriceSinceEntry: dec(100),
    stopThresholdPercent: 10,
    ...over,
  });
}

function book(...verdicts: TransitionVerdict[]): Map<string, TransitionVerdict> {
  return new Map(verdicts.map((v) => [v.asset, v]));
}

function leg(asset: string, side: 'buy' | 'sell', notional = 100): VectorLeg {
  return { asset, side, notional: dec(notional) };
}

/** The judged leg for one asset, or a failure — every assertion below reads one. */
function at(judgement: ReturnType<typeof judgeVector>, asset: string) {
  const found = judgement.legs.find((l) => l.asset === asset);
  assert.ok(found, `expected a leg on ${asset}`);
  return found;
}

{
  // THE CENTRAL CASE, and the one the provenance column exists for: a vector with one
  // frozen leg and one perfectly actionable leg. Both are refused — and the journal has to
  // say WHY each one was, because on its own row the second asset looks entirely tradable.
  const v = judgeVector(
    [leg('BTC', 'sell'), leg('ETH', 'buy')],
    book(verdict('BTC', { sticky: FROZEN }), verdict('ETH')),
  );

  assert.equal(v.refused, true, 'one forbidden strategic leg refuses the vector');
  assert.equal(at(v, 'BTC').verdict, 'forbidden', 'the frozen leg is refused on its own account');
  assert.equal(at(v, 'ETH').verdict, 'cancelled_atomic', 'the actionable leg goes down with it');
  assert.equal(at(v, 'ETH').ownVerdict, 'allowed', 'and its own asset had cleared it — that is the whole point');
  assert.equal(v.trigger?.asset, 'BTC', 'the cycle records which leg brought the vector down');
  assert.match(at(v, 'ETH').reason, /BTC sell/, 'the cancelled leg names the leg that cancelled it');
  assert.match(at(v, 'ETH').reason, /whole or not at all/, 'and says why that follows');

  // The two refusals must not collapse into one another. This is the assertion that would
  // have failed under a single "refused" value, which is the state of the world this PR
  // exists to leave behind.
  assert.notEqual(
    at(v, 'BTC').verdict,
    at(v, 'ETH').verdict,
    'directly forbidden and cancelled-by-atomicity are distinguishable in the journal',
  );
  console.log('  ok: a forbidden leg takes the vector down, and the two refusals stay distinct');
  passed += 1;
}

{
  // AN ALL-ALLOWED VECTOR PASSES UNTOUCHED. Atomicity is not a second opinion on legs the
  // gate already cleared — without this, the rule could quietly refuse everything and every
  // other test here would still pass.
  const v = judgeVector(
    [leg('BTC', 'sell'), leg('ETH', 'buy'), leg('SOL', 'buy')],
    book(verdict('BTC'), verdict('ETH'), verdict('SOL')),
  );
  assert.equal(v.refused, false);
  assert.equal(v.trigger, null, 'nothing triggered it, so nothing is named');
  assert.deepEqual(
    v.legs.map((l) => l.verdict),
    ['allowed', 'allowed', 'allowed'],
    'every leg keeps the verdict its own asset gave it',
  );
  assert.match(v.reason, /all 3 strategic leg\(s\) cleared/);

  // And an empty vector — the skip paths and every cycle that decides to hold — is a fact,
  // not a refusal.
  const empty = judgeVector([], book(verdict('BTC', { sticky: FROZEN })));
  assert.equal(empty.refused, false, 'a cycle that moves nothing refuses nothing');
  assert.equal(empty.legs.length, 0);
  console.log('  ok: a cleared vector and an empty one both pass, unmarked');
  passed += 1;
}

{
  // CLAUSE 1 — THE DETERMINISTIC EXITS ARE EXEMPT, AND CANNOT TRIGGER.
  //
  // The peak stop is the code taking a line out, not the model adding exposure. It must
  // survive a vector refused around it, and it must not be the thing that refuses it.
  const stopping = verdict('BTC', { sticky: FROZEN, price: dec(80), peakPriceSinceEntry: dec(100) });
  assert.equal(stopping.gate, 'stop_exit', 'fixture check: the stop really is firing');

  const v = judgeVector(
    [leg('BTC', 'sell'), leg('ETH', 'buy'), leg('SOL', 'buy')],
    book(stopping, verdict('ETH', { sticky: FROZEN }), verdict('SOL')),
  );
  assert.equal(at(v, 'BTC').verdict, 'superseded', 'the stopped leg is exempt from the refusal');
  assert.equal(at(v, 'BTC').deterministic, true);
  assert.equal(at(v, 'ETH').verdict, 'forbidden', 'the frozen leg triggers');
  assert.equal(at(v, 'SOL').verdict, 'cancelled_atomic', 'and sweeps the actionable one up');
  assert.equal(v.trigger?.asset, 'ETH', 'the stop is NOT the trigger — it never competes for that');

  // A stop firing ALONE cannot refuse anything, even though its own leg verdict is neither
  // `allowed` nor `forbidden`. Folding `superseded` into "refused" would have made every
  // stop episode cancel the whole cycle's strategy.
  const alone = judgeVector([leg('BTC', 'sell'), leg('ETH', 'buy')], book(stopping, verdict('ETH')));
  assert.equal(alone.refused, false, 'a firing stop does not bring the vector down');
  assert.equal(at(alone, 'ETH').verdict, 'allowed', 'the other legs carry on');
  console.log('  ok: the peak stop is exempt from atomicity and never triggers it');
  passed += 1;
}

{
  // CLAUSE 1, SECOND HALF — a REDUCTION under a confirmed global risk_off is a
  // deterministic exit too, and the asymmetry with the increase is load-bearing.
  const riskOffFrozen = verdict('BTC', { sticky: FROZEN, riskOffConfirmed: true });
  assert.equal(riskOffFrozen.gate, 'risk_off_reduction');

  const v = judgeVector(
    [leg('BTC', 'sell'), leg('ETH', 'buy')],
    book(riskOffFrozen, verdict('ETH', { sticky: FROZEN, riskOffConfirmed: true })),
  );
  assert.equal(at(v, 'BTC').verdict, 'allowed', 'de-risking survives a vector refused around it');
  assert.equal(at(v, 'BTC').deterministic, true, 'because it is classed as a deterministic exit');
  assert.equal(at(v, 'ETH').verdict, 'forbidden', 'the increase is refused on its own account');
  assert.equal(v.trigger?.asset, 'ETH', 'and it is the trigger — an increase is strategic like any other');

  // The same override on an asset with NO usable regime: the edge closed in this PR. It is
  // a reduction, so it is exempt, and it stays allowed while the vector goes down.
  const blindUnderRiskOff = verdict('XRP', { sticky: null, riskOffConfirmed: true });
  assert.equal(blindUnderRiskOff.gate, 'risk_off_reduction', 'no individual reading, but a global one');
  const w = judgeVector(
    [leg('XRP', 'sell'), leg('ETH', 'buy')],
    book(blindUnderRiskOff, verdict('ETH', { sticky: FROZEN })),
  );
  assert.equal(at(w, 'XRP').verdict, 'allowed', 'the unreadable line can still be reduced');
  assert.equal(at(w, 'ETH').verdict, 'forbidden');
  console.log('  ok: a risk_off reduction is exempt — including on a line with no regime — its buy is not');
  passed += 1;
}

{
  // AN UNJUDGED LEG. It does not trigger a refusal (there is nothing to refuse it on), but
  // it is a strategic leg, so a refused vector takes it with the rest — letting it through
  // alone would manufacture exactly the exposure atomicity exists to prevent.
  //
  // Its `gate` stays `no_regime` in the same row, which is how "cancelled while actionable"
  // and "cancelled while unreadable" stay apart without a sixth provenance value.
  const blind = verdict('XRP', { sticky: null });
  assert.equal(blind.gate, 'no_regime');

  const alone = judgeVector([leg('XRP', 'buy'), leg('ETH', 'buy')], book(blind, verdict('ETH')));
  assert.equal(alone.refused, false, 'an unjudged leg is not a refusal');
  assert.equal(at(alone, 'XRP').verdict, 'unjudged', 'and it keeps saying so');

  const swept = judgeVector([leg('XRP', 'buy'), leg('ETH', 'buy')], book(blind, verdict('ETH', { sticky: FROZEN })));
  assert.equal(at(swept, 'XRP').verdict, 'cancelled_atomic', 'but a refused vector takes it along');
  assert.equal(at(swept, 'XRP').ownVerdict, 'unjudged', 'while the row still records what was known');
  console.log('  ok: an unjudged leg never triggers a refusal, and never escapes one');
  passed += 1;
}

{
  // THE TRIGGER IS A FACT, NOT AN ARTEFACT OF ITERATION ORDER. Two forbidden legs, fed in
  // both orders, must name the same one — otherwise "which leg brought the vector down"
  // means nothing across two cycles that saw the same market.
  const verdicts = book(
    verdict('BTC', { sticky: FROZEN }),
    verdict('ETH', { sticky: FROZEN }),
    verdict('SOL'),
  );
  const forwards = judgeVector([leg('BTC', 'sell'), leg('ETH', 'buy'), leg('SOL', 'buy')], verdicts);
  const backwards = judgeVector([leg('SOL', 'buy'), leg('ETH', 'buy'), leg('BTC', 'sell')], verdicts);

  assert.equal(forwards.trigger?.asset, 'BTC');
  assert.deepEqual(backwards.trigger, forwards.trigger, 'the same vector names the same trigger');
  // And the trigger is not the WHOLE story — every forbidden leg is listed, so a cycle
  // where three assets were frozen does not read as one.
  assert.deepEqual(
    forwards.triggers.map((t) => t.asset),
    ['BTC', 'ETH'],
    'all the forbidden legs are reported, in the tie-break order',
  );
  assert.deepEqual(backwards.triggers, forwards.triggers);
  console.log('  ok: the trigger is deterministic, and the other refusals are not hidden behind it');
  passed += 1;
}

{
  // TOTALITY. `judgeVector` is called from the observation closure inside `decide()`, whose
  // entire safety property is that it cannot fail a cycle — it runs AFTER the orders are
  // placed. So a leg on an asset the layer never judged must be recorded as a fault, not
  // raised as one. And it must not be able to invent a refusal: an unjudged leg never
  // triggers.
  let v!: ReturnType<typeof judgeVector>;
  assert.doesNotThrow(() => {
    v = judgeVector([leg('DOGE', 'buy'), leg('ETH', 'buy')], book(verdict('ETH')));
  }, 'a leg outside the judged universe must not throw inside the observation closure');
  assert.equal(at(v, 'DOGE').verdict, 'unjudged');
  assert.match(at(v, 'DOGE').reason, /wiring fault/, 'and it is labelled as a fault, not a market reading');
  assert.equal(v.refused, false, 'a missing verdict cannot fabricate an atomic refusal');
  assert.equal(at(v, 'ETH').verdict, 'allowed', 'and the legs it could judge are unaffected');

  // PURITY, same contract as the gate: the live cycle and the replay harness run this over
  // the same inputs and are compared, so it must not carry state between calls.
  const legs = [leg('BTC', 'sell'), leg('ETH', 'buy')];
  const verdicts = book(verdict('BTC', { sticky: FROZEN }), verdict('ETH'));
  assert.deepEqual(judgeVector(legs, verdicts), judgeVector(legs, verdicts), 'same inputs, same judgement');
  assert.deepEqual(legs, [leg('BTC', 'sell'), leg('ETH', 'buy')], 'and the inputs are left untouched');
  console.log('  ok: judgeVector is total and pure — it cannot throw and it cannot invent a refusal');
  passed += 1;
}

{
  // THE PROVENANCE REACHES THE ROW, which is the only form of it that survives the process.
  // Proof 4 of the brief, end to end: a fabricated vector with one frozen leg and one
  // actionable leg produces two rows that a query can tell apart.
  const btc = verdict('BTC', { sticky: FROZEN });
  const eth = verdict('ETH');
  const vector = judgeVector([leg('BTC', 'sell', 250), leg('ETH', 'buy', 250)], book(btc, eth));

  const btcRow = toObservationRow(7, btc, null, vector);
  const ethRow = toObservationRow(7, eth, null, vector);

  assert.equal(btcRow.leg_verdict, 'forbidden');
  assert.equal(ethRow.leg_verdict, 'cancelled_atomic');
  assert.equal(ethRow.gate, 'actionable', 'and its own gate still says the asset was tradable');
  assert.equal(btcRow.leg_side, 'sell');
  assert.equal(ethRow.leg_side, 'buy');
  assert.equal(typeof ethRow.leg_notional, 'string', 'money reaches `numeric` as a string, not a float');
  assert.equal(ethRow.leg_notional, '250');

  // The cycle-level fact is on BOTH rows, so "was this vector refused" is one column read.
  assert.equal(btcRow.atomic_refusal, true);
  assert.equal(ethRow.atomic_refusal, true);
  assert.equal(ethRow.atomic_trigger_asset, 'BTC', 'including on the row that was only collateral');

  // An asset with no leg this cycle still carries the cycle-level fact, and no leg columns.
  const sol = verdict('SOL');
  const solRow = toObservationRow(7, sol, null, vector);
  assert.equal(solRow.leg_verdict, null, 'no leg, no leg verdict');
  assert.equal(solRow.leg_notional, null);
  assert.equal(solRow.atomic_refusal, true, 'but the cycle was refused, and every row says so');

  // A cleared vector writes `false`, never null — the distinction the migration protects.
  const clear = judgeVector([leg('ETH', 'buy')], book(eth));
  assert.equal(toObservationRow(8, eth, null, clear).atomic_refusal, false);
  assert.equal(toObservationRow(8, eth, null, clear).atomic_trigger_asset, null);
  console.log('  ok: the provenance and the cycle-level refusal both reach the row');
  passed += 1;
}

{
  // THE LEG IS THE VECTOR, NOT THE FILL. `order_*` keeps meaning "what booked" and
  // `leg_*` means "what the model asked for" — they are populated from different inputs
  // and must not be conflated, because the blocking gate will act on the second.
  const frozen = verdict('BTC', { sticky: FROZEN, qty: ZERO });
  const vector = judgeVector([leg('BTC', 'buy', 500)], book(frozen));
  const row = toObservationRow(9, frozen, { side: 'sell', notional: '10', verdict: 'forbidden', reason: 'x' }, vector);

  assert.equal(row.order_side, 'sell', 'the booked order is what booked');
  assert.equal(row.order_notional, '10');
  assert.equal(row.leg_side, 'buy', 'the leg is what the vector asked for');
  assert.equal(row.leg_notional, '500');
  console.log('  ok: the leg columns and the order columns stay two separate populations');
  passed += 1;
}

console.log(`\n${passed} transition-vector invariant checks passed.`);
