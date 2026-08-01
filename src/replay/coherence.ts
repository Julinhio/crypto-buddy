import 'dotenv/config';
import { getSupabaseClient } from '../persistence/supabase.js';
import { outputOrderViolation } from '../decision/schema.js';
import { loadCorpus, replayInOrder } from './storedCycle.js';

/**
 * COHERENCE REPLAY — the acceptance criterion of the P0 output-contract PR.
 *
 * `decisions.raw_response` holds every v5 response production ever produced. That is a
 * free regression corpus, and it is the only honest way to answer the question that
 * decides whether this guard ships: how many REAL cycles would it have killed?
 *
 * The 123 passes matter as much as the 5 rejections. A guard that is too tight turns
 * every awkward response into a dead cycle, and a dead cycle is zero trading — that is
 * the failure mode that gets forgotten, because it looks like caution.
 *
 * WHAT MAKES THIS A REPLAY RATHER THAN A SIMULATION. Every input is the one that cycle
 * actually had: `raw_response` is what the model wrote, `market_context` is the valued
 * book it was shown, and `market_context.positions[].thesis` is the stored thesis state
 * it was shown — so rule 3 is checked against the real lifecycle state of that moment
 * rather than against a reconstruction of it.
 *
 * Read-only and side-effect free: it reads `decisions` and writes nothing anywhere.
 *
 * Run with `npm run replay:coherence`. Exits non-zero if any criterion fails.
 */

/**
 * The 128 cycles of the original analysis: ids 879 → 1006 (25/07 16:15 → 31/07 17:35).
 * Pinned by id rather than by "the first 128 rows", so the assertion keeps meaning the
 * same thing as the corpus keeps growing.
 *
 * The bot did not stop while this was being written. The full corpus is replayed and
 * reported; the ASSERTION is on this window, because that is the window the expected
 * verdict was derived from. Asserting on a corpus that has grown since would mean
 * adjusting the criterion until it fell right, which is the one thing the brief forbids.
 */
const BRIEF_WINDOW = { firstId: 879, lastId: 1006 } as const;
const BRIEF_EXPECTED_REJECTS = [946, 948, 957, 987, 1000];
const BRIEF_EXPECTED_PASSES = 123;
const BRIEF_EXPECTED_CYCLES = 128;

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

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('replay: Supabase is not configured.');

  const cycles = await loadCorpus(supabase);
  const inWindow = cycles.filter((c) => c.id >= BRIEF_WINDOW.firstId && c.id <= BRIEF_WINDOW.lastId);

  console.log('='.repeat(96));
  console.log('COHERENCE REPLAY — the output contract guard, against real production responses');
  console.log(
    `Corpus: ${cycles.length} v5 decided cycles (ids ${cycles[0]?.id} → ${cycles[cycles.length - 1]?.id}), fed IN ORDER.`,
  );
  console.log(
    `Assertion window: ids ${BRIEF_WINDOW.firstId} → ${BRIEF_WINDOW.lastId} ` +
      `(${inWindow.length} cycles) — the 128 the analysis was made on.`,
  );
  console.log('='.repeat(96));

  // C0 — the corpus is what we think it is, checked BEFORE anything is built on it.
  {
    const empty = cycles.filter((c) => !c.raw_response || c.raw_response.trim() === '');
    const missingContext = cycles.filter((c) => !c.market_context?.account?.portfolio);
    const ok =
      empty.length === 0 && missingContext.length === 0 && inWindow.length === BRIEF_EXPECTED_CYCLES;
    record('C0', 'the corpus is exploitable, and the assertion window is the briefed 128', ok, [
      `${cycles.length} v5 decided rows · ${empty.length} with an empty raw_response · ` +
        `${missingContext.length} with an unusable market_context.`,
      `Assertion window holds ${inWindow.length} cycles (expected ${BRIEF_EXPECTED_CYCLES}).`,
      cycles.length > inWindow.length
        ? `NOTE: ${cycles.length - inWindow.length} cycles produced since the analysis ` +
          `(ids ${BRIEF_WINDOW.lastId + 1} → ${cycles[cycles.length - 1]?.id}). Replayed and reported ` +
          'below, deliberately NOT part of the assertion.'
        : 'No cycles produced since the analysis.',
    ]);
  }

  const steps = replayInOrder(cycles);
  const rejected = steps
    .filter((s) => s.verdict.kind === 'rejected')
    .map((s) => ({
      id: s.cycle.id,
      at: s.cycle.created_at,
      rules: s.verdict.kind === 'rejected' ? s.verdict.violations.map((v) => v.rule) : [],
      detail: s.verdict.kind === 'rejected' ? s.verdict.violations.map((v) => v.detail).join(' | ') : '',
    }));
  const unusable = steps
    .filter((s) => s.verdict.kind === 'unusable')
    .map((s) => ({ id: s.cycle.id, reason: s.verdict.kind === 'unusable' ? s.verdict.reason : '' }));
  const accepted = steps.filter((s) => s.verdict.kind === 'accepted').length;

  // C1 — no historical response should be unparseable under the reordered schema.
  {
    const ok = unusable.length === 0;
    record('C1', 'every historical response still validates against the reordered schema', ok, [
      ok
        ? `All ${cycles.length} responses parse and validate. Reordering the schema changed the ORDER ` +
          'of the fields, not the contract: the same responses remain valid.'
        : `${unusable.length} response(s) no longer validate: ` +
          unusable.map((u) => `#${u.id} (${u.reason})`).join('; '),
    ]);
  }

  const windowRejects = rejected.filter(
    (r) => r.id >= BRIEF_WINDOW.firstId && r.id <= BRIEF_WINDOW.lastId,
  );

  // C2 — THE criterion.
  {
    const rejectIds = windowRejects.map((r) => r.id).sort((a, b) => a - b);
    const windowPasses = inWindow.length - windowRejects.length;
    const idsMatch =
      rejectIds.length === BRIEF_EXPECTED_REJECTS.length &&
      rejectIds.every((id, i) => id === BRIEF_EXPECTED_REJECTS[i]);
    const ok = idsMatch && windowPasses === BRIEF_EXPECTED_PASSES;
    record(
      'C2',
      `exactly ${BRIEF_EXPECTED_REJECTS.length} rejects / ${BRIEF_EXPECTED_PASSES} passes on the briefed 128`,
      ok,
      [
        `Rejected: [${rejectIds.join(', ')}]  (expected [${BRIEF_EXPECTED_REJECTS.join(', ')}])`,
        `Passed:   ${windowPasses}  (expected ${BRIEF_EXPECTED_PASSES})`,
        ...windowRejects.map((r) => `  #${r.id} ${r.at.slice(0, 16)} → ${r.rules.join(', ')}`),
      ],
    );
  }

  // C3 — the false-positive test, its own criterion so it cannot be forgotten.
  {
    const unexpected = windowRejects.filter((r) => !BRIEF_EXPECTED_REJECTS.includes(r.id));
    const ok = unexpected.length === 0;
    record('C3', 'no false positive — the guard kills no cycle it was not meant to', ok, [
      ok
        ? `The ${BRIEF_EXPECTED_PASSES} legitimate cycles all pass, including the two shapes designed ` +
          'to trip a naive guard: #879 (four theses opened on four untouched lines, every one legitimate ' +
          'because no line had a thesis yet) and #947 / #949 / #958 (holds re-emitting the reference ' +
          'their rejected predecessor failed to move).'
        : `${unexpected.length} cycle(s) rejected that should have passed: ` +
          unexpected.map((r) => `#${r.id} (${r.rules.join(', ')}: ${r.detail})`).join(' ;; '),
    ]);
  }

  // C4 — the systemic detector actually detects.
  {
    const violating = cycles.filter((c) => outputOrderViolation(c.raw_response) !== null);
    const ok = violating.length === cycles.length;
    record('C4', 'the output-order check fires on 100% of the pre-fix corpus', ok, [
      `${violating.length}/${cycles.length} historical responses emit target_allocation BEFORE reasoning.`,
      ok
        ? 'Which is exactly right: every one was produced under the OLD contract. A detector that stayed ' +
          'silent here would be a detector that never fires. After the fix, a single hit means the ' +
          'contract broke at the system level — no retry, cycle killed, its own alert.'
        : 'Expected every pre-fix response to violate. Some do not, which means the check is not reading ' +
          'what it thinks it is reading.',
    ]);
  }

  // Post-window report — informational, never asserted.
  {
    const after = rejected.filter((r) => r.id > BRIEF_WINDOW.lastId);
    console.log('');
    console.log('-'.repeat(96));
    console.log('SINCE THE ANALYSIS (reported, not asserted)');
    if (after.length === 0) {
      console.log('  No further rejection after the briefed window.');
    } else {
      for (const r of after) {
        console.log(`  #${r.id} ${r.at.slice(0, 16)} → ${r.rules.join(', ')}`);
        console.log(`      ${r.detail}`);
      }
      console.log('');
      console.log(
        '  The defect did not stop when the analysis did. These are the cycles the guard would have ' +
          'caught in the days since.',
      );
    }
    console.log('-'.repeat(96));
  }

  console.log('');
  console.log('='.repeat(96));
  console.log(
    `Whole corpus: ${accepted} accepted, ${rejected.length} rejected, ${unusable.length} unusable.`,
  );
  const failed = results.filter((r) => !r.passed);
  console.log(
    failed.length === 0 ? 'ALL CRITERIA PASSED.' : `${failed.length} CRITERION/CRITERIA FAILED.`,
  );
  console.log('='.repeat(96));
  if (failed.length > 0) process.exitCode = 1;
}

await main();
