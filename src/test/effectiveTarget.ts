import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveEffectiveTarget } from '../decision/effectiveTarget.js';
import { loadReferenceTarget } from '../persistence/decisionGuard.js';

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
  // THE GUARD'S REFERENCE now resolves through the same function. Stubbed at the client so
  // the wiring is tested, not just the pure resolver: the whole risk of this PR is a path
  // that still reads the raw column.
  const rowWith = (row: Record<string, unknown>): SupabaseClient =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({ order: () => ({ limit: async () => ({ data: [row], error: null }) }) }),
        }),
      }),
    }) as unknown as SupabaseClient;

  const applied = await loadReferenceTarget(
    rowWith({ target_allocation: PROPOSAL, applied_allocation: APPLIED }),
  );
  assert.equal(applied.ok, true);
  assert.deepEqual(
    applied.target,
    APPLIED,
    'the guard compares against what the chain retained, not what the model asked for',
  );

  const legacy = await loadReferenceTarget(rowWith({ target_allocation: PROPOSAL, applied_allocation: null }));
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.target, PROPOSAL, 'a legacy row still yields a reference');

  // A row whose columns are both unusable is a read the guard must refuse, not paper over.
  const mangled = await loadReferenceTarget(rowWith({ target_allocation: {}, applied_allocation: null }));
  assert.equal(mangled.ok, false, 'an unusable reference fails the read rather than returning nonsense');
  assert.equal(mangled.target, null);

  // No row at all is genuinely "the first decision on record", which is not a failure.
  const empty = {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
    }),
  } as unknown as SupabaseClient;
  const first = await loadReferenceTarget(empty);
  assert.equal(first.ok, true);
  assert.equal(first.target, null);
  console.log('  ok: the coherence guard reads its reference through the resolver');
  passed += 1;
}

console.log(`\n${passed} effective-target invariant checks passed.`);
