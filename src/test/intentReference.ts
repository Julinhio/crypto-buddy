import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config, type AppConfig } from '../config/index.js';
import { Decimal } from '../money.js';
import { allocationSum, releaseToReserve } from '../allocation.js';
import {
  buildIntentAllocation,
  restateIntentReference,
} from '../decision/intentReference.js';
import { checkCoherence, type CoherenceRule } from '../decision/coherence.js';
import { applyGate, zeroOutStopped } from '../transition/apply.js';
import type { Movement } from '../execution/movements.js';
import type { VectorJudgement } from '../transition/vector.js';

/**
 * THE INTENTION PIPELINE — run with `npm test` (tsx). No framework, no network.
 *
 * The coherence guard's rule 1 is an INTENTION question, and this file covers the two
 * pieces that answer it: the restatement pipeline that puts a stored intention into this
 * cycle's frame, and the builder that decides what gets persisted as the intention in the
 * first place.
 *
 * `src/test/coherence.ts` proves the RULES. This proves the OPERANDS they are fed — which
 * is where the defect this PR closes actually lived.
 */

let passed = 0;
const ok = (label: string, condition: boolean, extra = ''): void => {
  assert.ok(condition, `${label}${extra ? ` — ${extra}` : ''}`);
  console.log(`  ok: ${label}`);
  passed += 1;
};

const RESERVE = 'USDT';
const UNIVERSE = ['BTC', 'ETH', 'BNB', 'XRP', 'USDT'];
const SHRUNK = ['BTC', 'ETH', 'BNB', 'USDT'];

/** The shipped config with some caps replaced. Never mutates the real one. */
const withCaps = (perAsset: Record<string, number>, minCashPercent?: number): AppConfig => ({
  ...config,
  execution: {
    ...config.execution,
    caps: {
      ...config.execution.caps,
      perAsset: { ...config.execution.caps.perAsset, ...perAsset },
      minCashPercent: minCashPercent ?? config.execution.caps.minCashPercent,
    },
  },
});

const restate = (
  reference: Record<string, number>,
  universe: readonly string[] = UNIVERSE,
  policy: AppConfig = config,
) => restateIntentReference({ reference, universe, reserveAsset: RESERVE, policy });

/* ── The shared arithmetic primitive ──────────────────────────────────────────── */

console.log('\n§1 — releaseToReserve: the weight moves, the sum does not');
{
  const before = { BTC: 25, ETH: 20, BNB: 12, XRP: 8, USDT: 35 };
  const after = releaseToReserve(before, ['XRP'], RESERVE);
  ok('the released key is gone', !('XRP' in after.allocation));
  ok('its weight landed in the reserve', after.allocation[RESERVE] === 43);
  ok('the total is preserved', allocationSum(after.allocation) === allocationSum(before));
  ok('and the input was not mutated', before.XRP === 8);

  // A weight is MOVED, never copied. Crediting cash while keeping the key was the shape
  // that let a ghost line take its own cap surplus in the clamp and rescale the reference
  // differently from the candidate.
  ok('freed and released report what actually moved', after.freed === 8 && after.released.join() === 'XRP');

  // Nothing to move is a no-op, and an absent key is not invented at zero: widening an
  // allocation with keys nobody asked for is how a ghost gets created in the first place.
  const nothing = releaseToReserve(before, ['DOGE'], RESERVE);
  ok('an absent key frees nothing and adds no entry', nothing.freed === 0 && !('DOGE' in nothing.allocation));
  const zeroWeight = releaseToReserve({ ...before, XRP: 0 }, ['XRP'], RESERVE);
  ok('a zero-weight key frees nothing', zeroWeight.freed === 0);
  // The reserve cannot release into itself — the weight would be removed and added back.
  const selfRelease = releaseToReserve(before, [RESERVE], RESERVE);
  ok('releasing the reserve into itself is a no-op', selfRelease.freed === 0 && selfRelease.allocation[RESERVE] === 35);
}

console.log('\n§2 — the two wrappers keep their own disposition');
{
  const base = { BTC: 25, ETH: 20, BNB: 12, XRP: 8, USDT: 35 };
  // The STOP keeps the key: the line still exists in the universe, it is merely empty.
  const stopped = zeroOutStopped(base, new Set(['XRP']), RESERVE);
  ok('zeroOutStopped keeps the key at zero', stopped.XRP === 0 && stopped[RESERVE] === 43);
  // The UNIVERSE removes it: the key is no longer legal, whatever its weight.
  const shrunk = restate(base, SHRUNK);
  ok('the restatement removes the key entirely', shrunk.ok && !('XRP' in shrunk.value.intent));
  ok(
    'and both preserve the total',
    allocationSum(stopped) === 100 && shrunk.ok && Math.abs(shrunk.value.sum - 100) < 1e-9,
  );
}

/* ── The restatement pipeline ─────────────────────────────────────────────────── */

console.log('\n§3 — restateIntentReference: universe, then sum, then clamp — in that order');
{
  const reference = { BTC: 25, ETH: 20, BNB: 12, XRP: 8, USDT: 35 };
  const result = restate(reference, SHRUNK);
  assert.ok(result.ok);
  if (result.ok) {
    ok('the vanished key is dropped', !('XRP' in result.value.intent));
    ok('its weight went to the reserve', result.value.intent[RESERVE] === 43);
    ok('and it is reported, not silently absorbed', result.value.droppedAssets.join() === 'XRP');
  }

  // An unchanged universe is a strict no-op on the intention.
  const untouched = restate(reference);
  assert.ok(untouched.ok);
  if (untouched.ok) {
    assert.deepEqual(untouched.value.intent, reference, 'nothing moves when nothing vanished');
    ok('an unchanged universe leaves the intention byte-identical', true);
  }

  // A zero-weight orphan is removed too. It carries nothing to transfer, so the primitive
  // leaves it alone — but an illegal key must not survive into an operand at any weight.
  const zeroOrphan = restate({ BTC: 25, ETH: 20, BNB: 12, XRP: 0, USDT: 43 }, SHRUNK);
  ok('a zero-weight orphan is dropped as well', zeroOrphan.ok && !('XRP' in zeroOrphan.value.intent));
}

console.log('\n§4 — THE INTENTION IS NEVER CLAMPED, and `bounded` is the only thing that is');
{
  // This is the defect, stated as an assertion. A cap that RELAXES cannot give back weight
  // a bounded reference already lost, so the reference must never have been bounded.
  const relaxed = withCaps({ BTC: 40 });
  const reference = { BTC: 40, ETH: 18, BNB: 12, XRP: 0, USDT: 30 };

  const underTightPolicy = restate(reference, UNIVERSE, withCaps({ BTC: 30 }));
  assert.ok(underTightPolicy.ok);
  if (underTightPolicy.ok) {
    ok('rule 1s operand keeps the full 40% under a TIGHTENED cap', underTightPolicy.value.intent.BTC === 40);
    ok('while rule 2s basis is bounded to 30', underTightPolicy.value.bounded.BTC === 30);
  }

  const underRelaxedPolicy = restate(reference, UNIVERSE, relaxed);
  assert.ok(underRelaxedPolicy.ok);
  if (underRelaxedPolicy.ok) {
    ok('and the same operand is unchanged under a RELAXED cap', underRelaxedPolicy.value.intent.BTC === 40);
    ok('while its basis now reaches the full 40', underRelaxedPolicy.value.bounded.BTC === 40);
  }

  // THE PROPERTY THAT MAKES RULE 1 SOUND: the intention is invariant to the policy. Two
  // opposite cap changes, one identical operand.
  assert.deepEqual(
    underTightPolicy.ok ? underTightPolicy.value.intent : null,
    underRelaxedPolicy.ok ? underRelaxedPolicy.value.intent : null,
    'the intention operand does not depend on the caps',
  );
  ok('the intention operand is invariant to the risk policy, in both directions', true);
}

console.log('\n§5 — the sum is verified BEFORE anything is built on it');
{
  // CALIBRATION is checked at the tolerance the SCHEMA validated the emission with. A
  // stricter bound here would reject the legitimate 99.7% the schema accepts — and would do
  // it silently, by rejecting every subsequent hold from then on.
  const tolerance = config.decision.allocationTolerancePercent;
  const slightlyOff = restate({ BTC: 25, ETH: 20, BNB: 12, XRP: 0, USDT: 43 - tolerance / 2 });
  ok('a total inside the schema tolerance is accepted', slightlyOff.ok);

  const wayOff = restate({ BTC: 25, ETH: 20, BNB: 12, XRP: 0, USDT: 20 });
  ok('a total the schema would never have accepted is REFUSED', !wayOff.ok);
  ok(
    'and the refusal says what it saw rather than coercing',
    !wayOff.ok && wayOff.reason.includes('sums to') && wayOff.reason.includes('77'),
  );

  // The refusal is a REPORT, not a throw: production turns it into a skipped cycle, which
  // is the same posture as a failed reference read. A guard running on a reference it
  // cannot trust does not fail loudly — it quietly rejects every hold.
  ok('a refused restatement never throws', typeof wayOff === 'object');
}

/* ── What gets PERSISTED as the intention ─────────────────────────────────────── */

console.log('\n§6 — buildIntentAllocation: the stop, and only the stop');
{
  const proposal = { BTC: 25, ETH: 20, BNB: 12, XRP: 8, USDT: 35 };

  const ordinary = buildIntentAllocation({
    proposal,
    stoppedAssets: new Set<string>(),
    reserveAsset: RESERVE,
  });
  assert.deepEqual(ordinary, proposal, 'with no stop, the intention IS the raw proposal');
  ok('no stop: the intention is the raw proposal, untouched', true);

  const stopped = buildIntentAllocation({
    proposal,
    stoppedAssets: new Set(['XRP']),
    reserveAsset: RESERVE,
  });
  ok('a stopped line is flat in the intention', stopped.XRP === 0);
  ok('and its weight is in the reserve, where the proceeds went', stopped[RESERVE] === 43);
  ok('the total still sums to 100', allocationSum(stopped) === 100);
  ok('the other lines are untouched', stopped.BTC === 25 && stopped.ETH === 20 && stopped.BNB === 12);
}

/* ── THE TWO STOP CASES, end to end through the real gate ─────────────────────── */

const movement = (asset: string, side: 'buy' | 'sell' = 'sell', fullExit = false): Movement => ({
  symbol: `${asset}/${RESERVE}`,
  asset,
  side,
  qty: new Decimal(1),
  price: new Decimal(100),
  notional: new Decimal(100),
  fee: new Decimal(0.1),
  fullExit,
});

const judgement = (refused: boolean): VectorJudgement => ({
  refused,
  reason: refused ? 'ETH is frozen' : '',
  trigger: refused ? { asset: 'ETH', side: 'buy' } : null,
  triggers: refused ? [{ asset: 'ETH', side: 'buy' }] : [],
  legs: [
    {
      asset: 'ETH',
      side: 'buy',
      notional: new Decimal(100),
      deterministic: false,
      ownVerdict: refused ? 'forbidden' : 'allowed',
      verdict: refused ? 'forbidden' : 'allowed',
      reason: refused ? 'ETH is frozen' : '',
    },
  ],
});

console.log('\n§7 — A STOP ON AN ACCEPTED CYCLE: the next reference carries zero');
{
  const proposal = { BTC: 25, ETH: 20, BNB: 12, XRP: 8, USDT: 35 };
  const stopExits = [movement('XRP', 'sell', true)];
  const outcome = applyGate({
    mode: 'enforce',
    movements: [movement('ETH', 'buy')],
    judgement: judgement(false),
    stopExits,
    clampedAllocation: { ...proposal },
    previousApplied: { BTC: 25, ETH: 15, BNB: 12, XRP: 8, USDT: 40 },
    reserveAsset: RESERVE,
  });
  ok('the cycle is NOT refused — a stop can fire on a perfectly good vector', !outcome.refused);
  ok('the applied target puts the stopped line flat', outcome.appliedAllocation.XRP === 0);

  const intent = buildIntentAllocation({
    proposal,
    stoppedAssets: new Set(stopExits.map((m) => m.asset)),
    reserveAsset: RESERVE,
  });
  ok('and so does the INTENTION the next cycle will read back', intent.XRP === 0);

  // THE POINT OF ALL OF IT: next cycle the model honestly emits 0 on a line it no longer
  // holds, and rule 1 must not call that a change of mind. Without the zeroing the guard
  // would refuse an honest hold — and its rejection message would be telling the model to
  // re-emit a POSITIVE weight on a stopped line, which is the automatic re-entry the stop
  // contract explicitly forbids.
  const restated = restate(intent);
  assert.ok(restated.ok);
  const nextCycle = checkCoherence({
    strategy: 'v5',
    actionType: 'hold',
    intentTarget: { BTC: 25, ETH: 20, BNB: 12, XRP: 0, USDT: 43 },
    intentReference: restated.ok ? restated.value.intent : null,
    movements: [],
    previousIntentMovements: [],
    reserveAsset: RESERVE,
    notes: [],
    assetsWithStoredThesis: new Set<string>(),
  });
  ok('the honest zero next cycle is ACCEPTED as a hold', nextCycle.ok, JSON.stringify(nextCycle.violations));

  // The mirror, so the assertion above is not vacuous: had the raw proposal been persisted
  // as the intention, the very same honest hold would be rejected.
  const withoutZeroing = checkCoherence({
    strategy: 'v5',
    actionType: 'hold',
    intentTarget: { BTC: 25, ETH: 20, BNB: 12, XRP: 0, USDT: 43 },
    intentReference: proposal,
    movements: [],
    previousIntentMovements: [],
    reserveAsset: RESERVE,
    notes: [],
    assetsWithStoredThesis: new Set<string>(),
  });
  const fired: CoherenceRule[] = withoutZeroing.violations.map((v) => v.rule);
  ok('and WITHOUT the zeroing the identical cycle is rejected', fired.includes('hold_moved_target'));
}

console.log('\n§8 — A STOP ON A CYCLE THE GATE ALSO REFUSED: still zero, and nothing else lost');
{
  // The case the contract calls out explicitly. A refusal reverts the APPLIED target to the
  // previous vector — but the intention is not the applied target, and the stop fires on
  // both branches. So the stopped line must be flat in the intention here too, while every
  // other line keeps the weight the model asked for: the model's intention genuinely
  // advanced, only the book did not.
  const proposal = { BTC: 25, ETH: 20, BNB: 12, XRP: 8, USDT: 35 };
  const previousApplied = { BTC: 25, ETH: 15, BNB: 12, XRP: 8, USDT: 40 };
  const stopExits = [movement('XRP', 'sell', true)];
  const outcome = applyGate({
    mode: 'enforce',
    movements: [movement('ETH', 'buy')],
    judgement: judgement(true),
    stopExits,
    clampedAllocation: { ...proposal },
    previousApplied,
    reserveAsset: RESERVE,
  });
  ok('the vector IS refused', outcome.refused);
  ok('the applied target reverts to the previous vector', outcome.appliedAllocation.ETH === 15);
  ok('with the stopped line flat in it too', outcome.appliedAllocation.XRP === 0);

  const intent = buildIntentAllocation({
    proposal,
    stoppedAssets: new Set(stopExits.map((m) => m.asset)),
    reserveAsset: RESERVE,
  });
  ok('the intention is flat on the stopped line', intent.XRP === 0);
  ok(
    'but keeps the model ASK on every other line — the refusal did not erase it',
    intent.ETH === 20 && intent.BTC === 25 && intent.BNB === 12,
  );
  ok('and it is NOT the applied vector', intent.ETH !== outcome.appliedAllocation.ETH);
  ok('the total is still 100', allocationSum(intent) === 100);

  // The consequence that makes the split worth having: next cycle the model re-emits its
  // refused ask unchanged and that is a genuine hold, because the intention never moved.
  const restated = restate(intent);
  assert.ok(restated.ok);
  const reEmitted = checkCoherence({
    strategy: 'v5',
    actionType: 'hold',
    intentTarget: { ...intent },
    intentReference: restated.ok ? restated.value.intent : null,
    movements: [],
    previousIntentMovements: [],
    reserveAsset: RESERVE,
    notes: [],
    assetsWithStoredThesis: new Set<string>(),
  });
  ok('re-emitting the refused ask next cycle is a genuine HOLD', reEmitted.ok);
}

/* ── The ordering the counterfactual depends on ───────────────────────────────── */

console.log('\n§9 — THE COUNTERFACTUAL IS COMPUTED BEFORE THE GATE');
{
  // Computed AFTER the gate, a frozen asset yields two empty plans — the standing one and
  // the new one both filtered out — and rule 2 refuses a decision for being unexecutable
  // when the only thing making it so is the layer the guard is not marking the homework of.
  //
  // Shown here as a behavioural difference rather than argued: the same decision, judged
  // with the pre-gate plan and with the post-gate one.
  const standingPlan = [movement('ETH', 'buy')];
  const decision = {
    strategy: 'v5' as const,
    actionType: 'rebalance' as const,
    intentTarget: { BTC: 25, ETH: 15, BNB: 12, XRP: 8, USDT: 40 },
    intentReference: { BTC: 25, ETH: 25, BNB: 12, XRP: 8, USDT: 30 },
    movements: [],
    reserveAsset: RESERVE,
    notes: [],
    assetsWithStoredThesis: new Set<string>(),
  };
  const gated = applyGate({
    mode: 'enforce',
    movements: standingPlan,
    judgement: judgement(true),
    stopExits: [],
    clampedAllocation: decision.intentTarget,
    previousApplied: decision.intentReference,
    reserveAsset: RESERVE,
  });
  assert.equal(gated.movements.length, 0, 'the gate drops the frozen leg — that is its job');

  const preGate = checkCoherence({ ...decision, previousIntentMovements: standingPlan });
  const postGate = checkCoherence({ ...decision, previousIntentMovements: gated.movements });
  ok('judged on the PRE-gate plan, withdrawing the frozen intention is accepted', preGate.ok);
  ok(
    'judged on the POST-gate plan, the same decision is wrongly refused',
    postGate.violations.map((v) => v.rule).includes('target_not_executable'),
  );

  // And the ordering is pinned in the source itself, because the behavioural test above
  // cannot see a future refactor that moves the derivation. Cheap, exact, and it fails on
  // the one edit that would reintroduce the defect.
  const decideSource = readFileSync(
    fileURLToPath(new URL('../decision/decide.ts', import.meta.url)),
    'utf8',
  );
  const derivedAt = decideSource.indexOf('const previousIntentMovements');
  const gateAt = decideSource.indexOf('const gateOutcome = applyGate({');
  assert.ok(derivedAt > 0 && gateAt > 0, 'both anchors must exist in decide.ts');
  ok('and decide() derives the counterfactual before it applies the gate', derivedAt < gateAt);
}

console.log(`\n${passed} intention-pipeline checks passed.`);
