import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveEffectiveTarget, resolveIntentAllocation } from '../decision/effectiveTarget.js';
import { loadReferenceAllocations } from '../persistence/decisionGuard.js';

/**
 * Invariants of the EFFECTIVE TARGET resolver — run with `npm test` (tsx). No framework.
 *
 * Two columns coexist on `decisions`: the model's raw proposal and what the deterministic
 * chain retained. They are identical on all 1079 decided rows today, which is exactly why
 * the resolver lands now — every consumer reads the same value it read before, so the
 * refactor is provably inert. These tests pin the behaviour that will matter LATER, on the
 * day the transition gate makes the two columns diverge and nothing on the corpus can
 * demonstrate it any more.
 */

let passed = 0;

const PROPOSAL = { BTC: 30, ETH: 20, USDT: 50 };
const APPLIED = { BTC: 25, ETH: 20, USDT: 55 };

{
  // THE NORMAL BRANCH: the chain's own target wins, and the source says so.
  const both = resolveEffectiveTarget({ target_allocation: PROPOSAL, applied_allocation: APPLIED });
  assert.deepEqual(both.allocation, APPLIED, 'the applied allocation is the effective target');
  assert.equal(both.source, 'applied');
  assert.equal(both.differsFromProposal, true, 'and here it differs from what was proposed');

  // TODAY'S CASE: the two agree, so the resolver is a no-op on every historical row.
  const agreeing = resolveEffectiveTarget({ target_allocation: PROPOSAL, applied_allocation: { ...PROPOSAL } });
  assert.deepEqual(agreeing.allocation, PROPOSAL);
  assert.equal(agreeing.source, 'applied', 'still resolved from the applied column, not the proposal');
  assert.equal(agreeing.differsFromProposal, false);

  // Key order is not meaning.
  const reordered = resolveEffectiveTarget({
    target_allocation: { USDT: 50, BTC: 30, ETH: 20 },
    applied_allocation: PROPOSAL,
  });
  assert.equal(reordered.differsFromProposal, false, 'a reordered object is the same allocation');
  console.log('  ok: the applied allocation is the effective target, and divergence is reported');
  passed += 1;
}

{
  // THE FALLBACK BRANCH, and the point of the whole exercise: it is VISIBLE. A `??` at the
  // call site returns the same allocation while saying nothing, so every reader silently
  // accepts a raw proposal as though the chain had endorsed it.
  const legacy = resolveEffectiveTarget({ target_allocation: PROPOSAL, applied_allocation: null });
  assert.deepEqual(legacy.allocation, PROPOSAL, 'the proposal stands in when there is no applied');
  assert.equal(legacy.source, 'proposal-fallback', 'and the caller is TOLD that it did');
  assert.notEqual(legacy.source, 'applied', 'the fallback is never dressed up as the normal case');
  // Undefined and null are the same absence — a row selected without the column, and a
  // column that is null, must not resolve differently.
  assert.equal(
    resolveEffectiveTarget({ target_allocation: PROPOSAL }).source,
    'proposal-fallback',
    'an absent column is an absent value',
  );
  console.log('  ok: the fallback to the proposal is a named outcome, not a silent one');
  passed += 1;
}

{
  // NEITHER COLUMN: a skipped, errored or unparseable cycle has no target at all. Null is
  // the honest answer — not an empty object, which a caller would happily treat as "a
  // target allocating nothing to everything".
  const none = resolveEffectiveTarget({ target_allocation: null, applied_allocation: null });
  assert.equal(none.allocation, null);
  assert.equal(none.source, 'none');
  assert.equal(none.differsFromProposal, false);
  assert.equal(resolveEffectiveTarget({}).source, 'none', 'a row with neither column resolves to none');
  console.log('  ok: a cycle with no target resolves to null, never to an empty allocation');
  passed += 1;
}

{
  // UNUSABLE VALUES ARE REFUSED, NOT COERCED. This is where a mangled column does its
  // damage quietly: the guard would not fail loudly on a bad reference, it would reject
  // every subsequent hold for "moving" away from nonsense.
  const unusable = [
    { applied_allocation: 'not an object' },
    { applied_allocation: [1, 2, 3] },
    { applied_allocation: {} },
    { applied_allocation: { BTC: 'thirty' } },
    { applied_allocation: { BTC: Number.NaN } },
    { applied_allocation: { BTC: Number.POSITIVE_INFINITY } },
  ];
  for (const row of unusable) {
    assert.equal(
      resolveEffectiveTarget(row).source,
      'none',
      `${JSON.stringify(row.applied_allocation)} must not resolve to an allocation`,
    );
    // ...and an unusable APPLIED must fall through to a usable proposal rather than
    // poisoning the whole read.
    assert.deepEqual(
      resolveEffectiveTarget({ ...row, target_allocation: PROPOSAL }).allocation,
      PROPOSAL,
      'a usable proposal still answers when the applied column is mangled',
    );
  }
  console.log('  ok: a mangled allocation is refused rather than coerced into a target');
  passed += 1;
}

{
  // THE INTENT RESOLVER — the third column, and the one the coherence guard now reads.
  //
  // `intent_allocation` is the model's proposal with any peak-stopped line put flat. It is
  // NOT the applied target: a gate refusal leaves the intention where the model put it, and
  // that asymmetry is the whole point of having a third column rather than reusing one of
  // the other two.
  const INTENT = { BTC: 30, ETH: 0, USDT: 70 }; // ETH stopped out; its 20 went to cash

  const stopped = resolveIntentAllocation({
    target_allocation: PROPOSAL,
    intent_allocation: INTENT,
    applied_allocation: APPLIED,
  });
  assert.deepEqual(stopped.allocation, INTENT, 'the intention is read from its own column');
  assert.equal(stopped.source, 'intent');
  assert.equal(stopped.differsFromProposal, true, 'and a fired stop is reported as a divergence');

  // The ordinary cycle: no stop, so the intention IS the proposal.
  const ordinary = resolveIntentAllocation({
    target_allocation: PROPOSAL,
    intent_allocation: { ...PROPOSAL },
    applied_allocation: APPLIED,
  });
  assert.deepEqual(ordinary.allocation, PROPOSAL);
  assert.equal(ordinary.source, 'intent', 'still resolved from its own column, not from the proposal');
  assert.equal(ordinary.differsFromProposal, false);

  // THE FALLBACK: a row written before migration 0027. Falling back to the raw proposal is
  // exactly right there — the stop had never fired on any corpus row — and it is a NAMED
  // outcome so a caller can log it, count it, or refuse it.
  const legacy = resolveIntentAllocation({ target_allocation: PROPOSAL, applied_allocation: APPLIED });
  assert.deepEqual(legacy.allocation, PROPOSAL, 'a pre-0027 row still yields an intention');
  assert.equal(legacy.source, 'intent-fallback');

  // AND THE TRAP IT MUST NOT FALL INTO: the fallback is to the PROPOSAL, never to the
  // applied target. Falling back to `applied` would silently restore the very defect this
  // PR removes — an intention question answered with a policy-bounded operand.
  assert.notDeepEqual(legacy.allocation, APPLIED, 'the intent fallback never reaches for applied');

  // A mangled column is refused rather than coerced, same posture as the effective target.
  const mangled = resolveIntentAllocation({ target_allocation: null, intent_allocation: {} });
  assert.equal(mangled.allocation, null);
  assert.equal(mangled.source, 'none');
  console.log('  ok: the intention resolves from its own column, and falls back to the proposal');
  passed += 1;
}

{
  // THE TWO REFERENCES now come from ONE read of ONE row. Stubbed at the client so the
  // wiring is tested, not just the pure resolvers: the whole risk of this PR is a path that
  // still reads the wrong column.
  const rowWith = (row: Record<string, unknown>): SupabaseClient =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({ order: () => ({ limit: async () => ({ data: [row], error: null }) }) }),
        }),
      }),
    }) as unknown as SupabaseClient;

  const INTENT = { BTC: 30, ETH: 0, USDT: 70 };
  const both = await loadReferenceAllocations(
    rowWith({ target_allocation: PROPOSAL, intent_allocation: INTENT, applied_allocation: APPLIED }),
  );
  assert.equal(both.ok, true);
  assert.deepEqual(both.intent, INTENT, 'rule 1 compares against what the model last MEANT');
  assert.deepEqual(both.applied, APPLIED, 'the gate reverts to what the book last PURSUED');
  assert.notDeepEqual(both.intent, both.applied, 'and the two are genuinely different values');

  const legacy = await loadReferenceAllocations(
    rowWith({ target_allocation: PROPOSAL, applied_allocation: null }),
  );
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.intent, PROPOSAL, 'a pre-0027 row still yields an intention reference');
  assert.deepEqual(legacy.applied, PROPOSAL, 'and a pre-0004 row still yields an applied one');

  // A row whose columns are all unusable is a read the guard must refuse, not paper over.
  const mangled = await loadReferenceAllocations(
    rowWith({ target_allocation: {}, intent_allocation: null, applied_allocation: null }),
  );
  assert.equal(mangled.ok, false, 'an unusable reference fails the read rather than returning nonsense');
  assert.equal(mangled.intent, null);
  assert.equal(mangled.applied, null);

  // No row at all is genuinely "the first decision on record", which is not a failure.
  const empty = {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
    }),
  } as unknown as SupabaseClient;
  const first = await loadReferenceAllocations(empty);
  assert.equal(first.ok, true);
  assert.equal(first.intent, null);
  assert.equal(first.applied, null);
  console.log('  ok: one read of one row answers both references, through the two resolvers');
  passed += 1;
}

console.log(`\n${passed} effective-target invariant checks passed.`);