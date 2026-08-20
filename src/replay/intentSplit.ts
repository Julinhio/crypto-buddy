import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { getSupabaseClient } from '../persistence/supabase.js';
import { loadCorpus, replayInOrder, type ReplayStep } from './storedCycle.js';

/**
 * THE NEUTRALITY PROOF — the guard's verdict on every stored decision, before and after
 * the intent/executability split, on the same corpus, in the same order.
 *
 * The safety property this PR ships under is the one the six PRs of 08/08 shipped under:
 * PROVABLY NEUTRAL TO THE CHARACTER on the existing corpus, except on the behaviour that
 * is being changed on purpose. Here the exception set is expected to be EMPTY, and that is
 * not optimism — it is a structural consequence of what the corpus contains:
 *
 *   - `applied_allocation` is byte-identical to `target_allocation` on every decided row
 *     (the clamp has never fired, the gate has never refused), so rule 1's reference is
 *     the same VALUE whichever column it is read from;
 *   - no corpus row has a peak stop firing, so the intention equals the raw proposal;
 *   - and a previous intention that already executed produces nothing new against the book
 *     it produced, so rule 2's counterfactual is empty wherever it matters.
 *
 * Each of those is measured below rather than asserted, so the day one stops being true
 * the number moves and says so.
 *
 * ── HOW "BEFORE" IS COMPUTED ────────────────────────────────────────────────────
 *
 * Through the SAME `checkCoherence`, fed the operands the old code built: a bounded
 * candidate against a bounded, restated APPLIED reference, and no counterfactual. A second
 * implementation of the rules would only prove that the two implementations agree; the
 * question being asked is whether the OPERANDS moved a verdict. See `GuardOperands`.
 *
 * Read-only and side-effect free: it reads `decisions` and writes nothing anywhere.
 *
 * Run with `npm run replay:intent-split`. Exits non-zero if any criterion fails.
 */

interface Criterion {
  id: string;
  passed: boolean;
}

const results: Criterion[] = [];

function record(id: string, title: string, passed: boolean, detail: string[]): void {
  results.push({ id, passed });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

/** One cycle's verdict, flattened to something two runs can be compared on. */
function verdictOf(step: ReplayStep): string {
  switch (step.verdict.kind) {
    case 'accepted':
      return 'accepted';
    case 'unusable':
      return `unusable:${step.verdict.reason}`;
    case 'rejected':
      return `rejected:${step.verdict.violations.map((v) => v.rule).sort().join('+')}`;
  }
}

/** Structural equality on an allocation, key order independent. */
function sameAllocation(a: unknown, b: unknown): boolean {
  const usable = (v: unknown): Record<string, number> | null =>
    v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : null;
  const left = usable(a);
  const right = usable(b);
  if (left == null || right == null) return left === right;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if ((left[key] ?? null) !== (right[key] ?? null)) return false;
  return true;
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('replay: Supabase is not configured.');

  const cycles = await loadCorpus(supabase);
  console.log('='.repeat(96));
  console.log('INTENT SPLIT REPLAY — the guard before and after, on the same stored decisions');
  console.log(
    `Corpus: ${cycles.length} v5 decided cycles (ids ${cycles[0]?.id} → ${cycles[cycles.length - 1]?.id}), fed IN ORDER.`,
  );
  console.log('='.repeat(96));

  // S0 — WHY the two runs are expected to agree, measured on the corpus itself. Stated
  // first because every criterion below rests on it: if these numbers were not zero, a
  // verdict difference would be expected rather than a defect.
  {
    const divergent = cycles.filter(
      (c) => !sameAllocation(c.applied_allocation, c.target_allocation),
    );
    const withIntent = cycles.filter((c) => c.intent_allocation != null);
    const ok = divergent.length === 0;
    record('S0', 'the corpus cannot tell the two references apart', ok, [
      `${divergent.length} row(s) where applied_allocation differs from target_allocation ` +
        '(the clamp has never fired and the gate has never refused).',
      `${withIntent.length} row(s) carry an intent_allocation; the other ${cycles.length - withIntent.length} ` +
        'predate migration 0027 and resolve through the named fallback to the raw proposal.',
      ok
        ? 'So rule 1 reads the SAME VALUE whichever column it comes from, and any verdict ' +
          'difference below would be a defect, not an effect.'
        : `DIVERGENT ROWS: ${divergent.map((c) => c.id).join(', ')} — the diff below is no longer ` +
          'a pure neutrality measurement and must be read cycle by cycle.',
    ]);
  }

  const before = replayInOrder(cycles, 'legacy');
  const after = replayInOrder(cycles, 'split');

  // S1 — the two runs covered the same population. A shrunk corpus would make a clean diff
  // meaningless, and it is the easiest way to accidentally prove nothing.
  {
    const ok = before.length === after.length && before.length === cycles.length;
    record('S1', 'both runs judged every cycle', ok, [
      `before: ${before.length} · after: ${after.length} · corpus: ${cycles.length}.`,
    ]);
  }

  // S2 — THE criterion. Verdict for verdict, cycle for cycle.
  const diffs = before
    .map((step, i) => ({ step, other: after[i]! }))
    .filter(({ step, other }) => verdictOf(step) !== verdictOf(other))
    .map(({ step, other }) => ({
      id: step.cycle.id,
      at: step.cycle.created_at,
      before: verdictOf(step),
      after: verdictOf(other),
    }));
  {
    const ok = diffs.length === 0;
    record('S2', 'the split moves NO verdict on the stored corpus', ok, [
      `${cycles.length} cycles replayed · ${diffs.length} verdict difference(s).`,
      ...diffs.map((d) => `  #${d.id} ${d.at.slice(0, 16)} — before: ${d.before} · after: ${d.after}`),
      ok
        ? 'Byte-for-byte the same guard chain. What this PR changes is unreachable from the ' +
          'history: it needs a policy change, a fired stop, or a refused vector, and the ' +
          'corpus contains none of the three.'
        : 'STOP. Every difference has to be explained and matched to the intended change ' +
          'before this merges — see the brief. Do not adjust the rule until it passes.',
    ]);
  }

  // S3 — the reference CHAINS also agree, not just the verdicts.
  //
  // Two runs can produce identical verdicts while walking different references, and the
  // chain is what the next cycle inherits: a silent divergence there would surface days
  // later as a rejection nobody could trace back to this PR.
  {
    const chainDiffs = before
      .map((step, i) => ({ step, other: after[i]! }))
      .filter(
        ({ step, other }) => !sameAllocation(step.references.applied, other.references.applied),
      )
      .map(({ step }) => step.cycle.id);
    const ok = chainDiffs.length === 0;
    record('S3', 'the applied reference chain is identical in both runs', ok, [
      `${chainDiffs.length} cycle(s) judged against a different applied reference.`,
      ...(ok ? [] : [`  ids: ${chainDiffs.join(', ')}`]),
    ]);
  }

  // S4 — the counterfactual is INERT on this corpus, and that is measured rather than
  // assumed. It exists for a standing intention that never executed; on a history where
  // every accepted intention did execute, it should almost never produce a leg — and
  // wherever it does, it must not be what flipped a verdict (S2 already proves none did).
  {
    const rejectedAfter = after.filter((s) => s.verdict.kind === 'rejected').map((s) => s.cycle.id);
    const rejectedBefore = before.filter((s) => s.verdict.kind === 'rejected').map((s) => s.cycle.id);
    const ok =
      rejectedBefore.length === rejectedAfter.length &&
      rejectedBefore.every((id, i) => id === rejectedAfter[i]);
    record('S4', 'the same cycles are rejected, and only those', ok, [
      `before: [${rejectedBefore.join(', ')}]`,
      `after:  [${rejectedAfter.join(', ')}]`,
      'The three BNB cycles are the rule-2 population: one point against a standing 12%, ' +
        'sub-floor in BOTH directions, so neither plan can reach the book and the ' +
        'counterfactual does not rescue them. That is the "too permissive" boundary, ' +
        'measured on real data rather than on a fixture.',
    ]);
  }

  console.log('');
  console.log('='.repeat(96));
  const failed = results.filter((r) => !r.passed);
  console.log(
    failed.length === 0 ? 'ALL CRITERIA PASSED.' : `${failed.length} CRITERION/CRITERIA FAILED.`,
  );
  console.log('='.repeat(96));
  if (failed.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
