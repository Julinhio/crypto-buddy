import assert from 'node:assert/strict';
import { resolveStrategyVersion, type StrategyVersion } from '../config/index.js';
import { buildDecisionSchema, validateDecision, type DecisionOutput } from '../decision/schema.js';
import { buildSystemPrompt, marketStateFromRegime } from '../decision/prompt.js';
import { buildSystemPromptV5 } from '../decision/promptV5.js';
import { mayWriteThesis } from '../portfolio/lifecycle.js';
import type { RegimeJournal } from '../market/regime.js';

/**
 * STRATEGY_VERSION invariants — run with `npm test` (tsx).
 *
 * The safety property is one sentence: ABSENCE MEANS SAFE. There is nothing to set to
 * stay on v4, so the new trading behaviour cannot be reached by omission, by a lost
 * environment, or by a platform that forgets its variables. What has to be proven is
 * the whole class of values, not a few sampled cases — a fallback that silently
 * absorbs a typo would defeat the entire design.
 */

let passed = 0;

{
  // THE CLASS, exhaustively: absent → v4, "v4" → v4, "v5" → v5, anything else present
  // → loud failure. The fourth row is the one that matters; the first three are only
  // interesting because the fourth exists.
  assert.equal(resolveStrategyVersion(undefined), 'v4', 'ABSENT resolves to v4 — nothing to set to stay safe');
  assert.equal(resolveStrategyVersion('v4'), 'v4', '"v4" resolves to v4');
  assert.equal(resolveStrategyVersion('v5'), 'v5', '"v5" resolves to v5 — the explicit opt-in');

  // Blank is absence, not a value: an empty env var is how a platform represents unset.
  assert.equal(resolveStrategyVersion(''), 'v4', 'empty resolves to v4');
  assert.equal(resolveStrategyVersion('   '), 'v4', 'whitespace-only resolves to v4');
  // Surrounding whitespace is a transport artefact, not intent.
  assert.equal(resolveStrategyVersion(' v5 '), 'v5', 'a padded value is trimmed, not rejected');

  // EVERY other present value fails loudly. `V5` is deliberately in this list: someone
  // typing it INTENDED v5, and quietly running v4 would leave the operator believing
  // the new strategy is live while the old one trades — the worst of both worlds.
  for (const bad of ['V5', 'V4', 'v6', 'v', '5', 'v5.0', 'latest', 'true', '0', 'v4,v5', 'null', 'undefined']) {
    assert.throws(
      () => resolveStrategyVersion(bad),
      /Invalid STRATEGY_VERSION/,
      `"${bad}" must fail loudly rather than fall back`,
    );
  }
  console.log('  ok: STRATEGY_VERSION — absent=v4, v4=v4, v5=v5, anything else fails loudly');
  passed += 1;
}

{
  // The two strategies do not share an output contract, and neither can satisfy the
  // other's. Under v4 the model DECLARES the market state; under v5 that has moved to
  // the code, and a model still declaring it is a stale prompt paired with the new
  // strategy — which must be caught, not accepted.
  const assets = ['BTC', 'USDT'];
  const base = {
    target_allocation: { BTC: 30, USDT: 70 },
    action_type: 'hold' as const,
    what_changed: 'nothing material',
    confidence: 'medium' as const,
    reasoning: 'holding',
    notification_summary: 'rien de neuf',
    next_delay_minutes: 60,
  };

  const v4Ok = validateDecision({ ...base, market_state: 'range' } as DecisionOutput, assets, undefined, 'v4');
  assert.equal(v4Ok.ok, true, 'v4 accepts a declared market_state');
  assert.equal(v4Ok.ok && v4Ok.value.marketState, 'range');

  const v4Missing = validateDecision(base as DecisionOutput, assets, undefined, 'v4');
  assert.equal(v4Missing.ok, false, 'v4 rejects a missing market_state');

  const v5Ok = validateDecision({ ...base, position_notes: [] } as DecisionOutput, assets, undefined, 'v5');
  assert.equal(v5Ok.ok, true, 'v5 accepts a decision with no market_state');
  assert.equal(v5Ok.ok && v5Ok.value.marketState, null, 'and leaves it null for the code to fill');

  const v5Declared = validateDecision(
    { ...base, market_state: 'range', position_notes: [] } as DecisionOutput,
    assets, undefined, 'v5',
  );
  assert.equal(v5Declared.ok, false, 'v5 REJECTS a declared market_state — the regime is the code\'s');
  console.log('  ok: the v4 and v5 output contracts cannot be satisfied by each other');
  passed += 1;
}

{
  // A thesis may only be written for a real, tradable position — never for cash, and
  // never for an asset outside this cycle's universe.
  const assets = ['BTC', 'USDT'];
  const base = {
    target_allocation: { BTC: 30, USDT: 70 },
    action_type: 'rebalance' as const,
    what_changed: 'bought BTC',
    confidence: 'high' as const,
    reasoning: 'reclaim',
    notification_summary: 'achat BTC',
    next_delay_minutes: 60,
  };
  const note = (asset: string) => ({ asset, thesis: 't', invalidation: 'i', replace: false });

  const good = validateDecision({ ...base, position_notes: [note('BTC')] } as DecisionOutput, assets, undefined, 'v5');
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.value.positionNotes.length, 1);

  for (const bad of ['USDT', 'SOL']) {
    const r = validateDecision({ ...base, position_notes: [note(bad)] } as DecisionOutput, assets, undefined, 'v5');
    assert.equal(r.ok, false, `a thesis on "${bad}" is refused — it is not a tradable position`);
  }

  const empty = validateDecision(
    { ...base, position_notes: [{ asset: 'BTC', thesis: '  ', invalidation: 'i', replace: false }] } as DecisionOutput,
    assets, undefined, 'v5',
  );
  assert.equal(empty.ok, false, 'an empty thesis is refused rather than stored as noise');

  const v4Notes = validateDecision(
    { ...base, market_state: 'range', position_notes: [note('BTC')] } as DecisionOutput,
    assets, undefined, 'v4',
  );
  assert.equal(v4Notes.ok, false, 'position_notes under v4 is refused — the field is v5-only');
  console.log('  ok: a thesis is only accepted for a tradable position, under v5, non-empty');
  passed += 1;
}

{
  // WHEN a thesis may be rewritten is the code's call, not the model's. The failure
  // being corrected is 787 reformulations of one paragraph, and a model asked every
  // two hours to state its thinking WILL state it every two hours.
  assert.equal(mayWriteThesis({ booked: true, hasStoredThesis: true, replace: false }), true, 'a real move rewrites it');
  assert.equal(mayWriteThesis({ booked: false, hasStoredThesis: false, replace: false }), true, 'a first thesis is written');
  assert.equal(mayWriteThesis({ booked: false, hasStoredThesis: true, replace: true }), true, 'an explicit replacement is honoured');
  assert.equal(
    mayWriteThesis({ booked: false, hasStoredThesis: true, replace: false }),
    false,
    'a hold does NOT rewrite an existing thesis — the whole point',
  );
  console.log('  ok: the thesis persists across a hold, and only the code decides when it may not');
  passed += 1;
}

{
  // The v5 mandate must have DROPPED the two framings that manufactured the immobility,
  // and must state the new size norm. Asserted on the text because these are the
  // load-bearing sentences of the whole chantier, not incidental wording.
  const v4Text = buildSystemPrompt();
  const v5Text = buildSystemPromptV5();

  assert.ok(v4Text.includes('Doing nothing is the default'), 'v4 still says it — that is the baseline being replaced');
  assert.ok(v4Text.includes('Act rarely, but well'), 'and v4 still says this too');
  assert.ok(!v5Text.includes('Doing nothing is the default'), 'v5 drops "doing nothing is the default"');
  assert.ok(!v5Text.includes('Act rarely, but well'), 'v5 drops "act rarely, but well"');
  assert.ok(v5Text.includes('not the default posture'), 'v5 says instead that it is not the default posture');

  assert.ok(v5Text.includes('25% of the position'), 'v5 states the double size condition');
  assert.ok(v5Text.includes('5 to 10 POINTS'), 'v5 states the mobile tactical target');
  assert.ok(v5Text.includes('FULL EXIT of a position is always allowed'), 'v5 keeps the full-exit exemption');
  assert.ok(v5Text.includes('You do NOT output market_state'), 'v5 takes the regime away from the model');
  assert.ok(v5Text.includes('WITH THE THESIS, not with your last action'), 'anti yo-yo is rebound to the thesis');
  // The risk guard-rails are untouched: both mandates state the same sacred floor.
  assert.ok(v4Text.includes('at least 30% kept in the reserve stable'), 'v4 states the 30% cash floor');
  assert.ok(v5Text.includes('at least 30% kept in the reserve stable'), 'and v5 states exactly the same floor');
  console.log('  ok: v5 removes the immobility framings, keeps the risk floor, and states the new norms');
  passed += 1;
}

{
  // Under v5 the code fills the legacy market_state column from its own regime. Lossy
  // by design — the auditable record is the `regime` column — but never absent, since
  // the column is NOT NULL for a decided row.
  const journal = (riskOff: boolean, labels: string[]): RegimeJournal =>
    ({
      version: 'r1',
      barAt: '2026-07-25T04:00:00.000Z',
      global: { riskOff, raw: riskOff, breadthPercent: 0, medianH4Rsi: 50, assetsPresent: labels.length, assetsExpected: labels.length, pendingBars: 0 },
      assets: Object.fromEntries(labels.map((l, i) => [`A${i}`, { regime: l }])),
    }) as unknown as RegimeJournal;

  assert.equal(marketStateFromRegime(journal(true, ['trend_up'])), 'risk_off', 'the override wins the projection too');
  assert.equal(marketStateFromRegime(journal(false, ['trend_up', 'trend_down', 'range'])), 'trend', 'a trending majority projects to trend');
  assert.equal(marketStateFromRegime(journal(false, ['range', 'range', 'trend_up'])), 'range', 'otherwise range');
  assert.equal(marketStateFromRegime(null), 'range', 'no regime still yields a value — the column is NOT NULL');
  console.log('  ok: v5 fills the legacy market_state column from the code regime, never leaving it null');
  passed += 1;
}

{
  // The structured-output schemas differ, and each rejects the other's extra field.
  const v4Schema = buildDecisionSchema(['BTC', 'USDT'], 'v4');
  const v5Schema = buildDecisionSchema(['BTC', 'USDT'], 'v5');
  const common = {
    target_allocation: { BTC: 30, USDT: 70 },
    action_type: 'hold',
    what_changed: 'x',
    confidence: 'low',
    reasoning: 'y',
    notification_summary: 'z',
    next_delay_minutes: 60,
  };
  assert.equal(v4Schema.safeParse({ ...common, market_state: 'range' }).success, true, 'v4 shape parses under v4');
  assert.equal(v4Schema.safeParse({ ...common, position_notes: [] }).success, false, 'v5 shape is rejected by v4');
  assert.equal(v5Schema.safeParse({ ...common, position_notes: [] }).success, true, 'v5 shape parses under v5');
  assert.equal(v5Schema.safeParse({ ...common, market_state: 'range' }).success, false, 'v4 shape is rejected by v5');
  console.log('  ok: the two structured-output schemas are strict and mutually exclusive');
  passed += 1;
}

const _typecheck: StrategyVersion = 'v4';
void _typecheck;

console.log(`\n${passed} STRATEGY_VERSION checks passed.`);
