import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { config, type AppConfig } from '../config/index.js';
import { clampAllocation } from '../risk/clamp.js';
import { restateIntentReference } from '../decision/intentReference.js';
import { checkCoherence, type CoherenceRule } from '../decision/coherence.js';

/**
 * THE POLICY-CHANGE COUNTERFACTUAL — what a cap moving costs the bot, before and after.
 *
 * The corpus cannot answer this. `applied_allocation` has never diverged from
 * `target_allocation` in 1332 decided rows, so no stored cycle has ever crossed a policy
 * change; the neutrality replay proves the split moves nothing on history precisely
 * BECAUSE history contains none of the conditions it addresses. This file supplies the
 * conditions and measures the difference, offline and without a network.
 *
 * Two directions, and they are not symmetric:
 *
 *   TIGHTENED  closed by PR #28 by clamping the reference. It must STAY closed — a
 *              regression here is an INTERLOCK, not a bad verdict: every hold rejected, no
 *              `decided` row written, the reference never advancing, and the risk-mandated
 *              reduction never executing.
 *   RELAXED    left open on purpose at the time, and the reason this PR exists. A
 *              reference bounded at the old ceiling never recovers the weight a raised
 *              ceiling would now allow, so the model's unchanged ask reads as a moved
 *              target and the first attempt is rejected. Not a deadlock — the retry
 *              catches it — which is exactly why it was survivable and easy to leave. The
 *              cost is one extra LLM call PER CYCLE, for as long as the model keeps asking.
 *
 * ── WHAT IS SIMULATED, AND WHAT IS NOT ──────────────────────────────────────────
 *
 * The model is reduced to the only two behaviours the retry contract needs: it keeps
 * asking for the allocation it wants, and when the guard rejects it, it takes option 2 of
 * the retry prompt — "re-emit the reference target UNCHANGED, with action_type hold".
 * That is the cheapest honest model of a correction, and it is the one that makes the cost
 * measurable: whichever value the guard PRINTS as the reference is what comes back.
 *
 * The rules themselves are not simulated at all — this drives the real `checkCoherence`
 * and the real `clampAllocation`, with the two operand sets exactly as production and the
 * pre-PR code build them.
 *
 * Run with `npm run replay:policy-change`. Exits non-zero if any criterion fails.
 */

const RESERVE = 'USDT';
const UNIVERSE = ['BTC', 'ETH', 'BNB', 'XRP', 'USDT'];
/** What the model wants, and keeps wanting. Cash sits on the floor, so nothing rescales. */
const ASK = { BTC: 40, ETH: 18, BNB: 12, XRP: 0, USDT: 30 };
const CYCLES = 10;

const withCaps = (perAsset: Record<string, number>): AppConfig => ({
  ...config,
  execution: {
    ...config.execution,
    caps: { ...config.execution.caps, perAsset: { ...config.execution.caps.perAsset, ...perAsset } },
  },
});

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

interface RunOutcome {
  /** LLM calls consumed across the run — one per cycle, plus one per rejected first attempt. */
  calls: number;
  /** Cycles whose first attempt was rejected. */
  rejectedFirstAttempts: number[];
  /** Cycles that were still incoherent after the retry — a dead cycle, zero trading. */
  deadCycles: number[];
  /** The weight the chain ended up pursuing on the line the policy moved. */
  finalBtc: number;
  rules: CoherenceRule[];
}

/**
 * Walks `CYCLES` wake-ups under one policy, with one operand set.
 *
 * `split` is production after this PR: raw intention against raw intention, and the
 * reference the chain carries forward is the model's intention. `legacy` is the pre-PR
 * guard: bounded candidate against a bounded reference, and the reference carried forward
 * is the applied allocation.
 */
function run(policy: AppConfig, operands: 'split' | 'legacy'): RunOutcome {
  // The chain starts where a bot running under the OLD policy left it: the model had been
  // asking for 40, the old 35 cap applied 35. Both references are seeded from that cycle,
  // each from the column it reads.
  const oldPolicy = withCaps({ BTC: 35 });
  const seededApplied = clampAllocation(ASK, RESERVE, oldPolicy).applied;
  let reference: Record<string, number> = operands === 'split' ? { ...ASK } : seededApplied;

  let calls = 0;
  const rejectedFirstAttempts: number[] = [];
  const deadCycles: number[] = [];
  const rules: CoherenceRule[] = [];

  const judge = (emitted: Record<string, number>) => {
    const restated = restateIntentReference({
      reference,
      universe: UNIVERSE,
      reserveAsset: RESERVE,
      policy,
    });
    if (!restated.ok) throw new Error(`the seeded reference is not restatable: ${restated.reason}`);
    return checkCoherence({
      strategy: 'v5',
      actionType: 'hold',
      // The operand split, in one line. `legacy` compared two BOUNDED values; `split`
      // compares two raw intentions.
      intentTarget: operands === 'split' ? emitted : clampAllocation(emitted, RESERVE, policy).applied,
      intentReference: operands === 'split' ? restated.value.intent : restated.value.bounded,
      movements: [],
      previousIntentMovements: [],
      reserveAsset: RESERVE,
      notes: [],
      assetsWithStoredThesis: new Set<string>(),
    });
  };

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    calls += 1;
    let emitted: Record<string, number> = { ...ASK };
    let verdict = judge(emitted);

    if (!verdict.ok) {
      rejectedFirstAttempts.push(cycle);
      rules.push(...verdict.violations.map((v) => v.rule));
      // OPTION 2 OF THE RETRY PROMPT: re-emit the reference unchanged. Whatever the guard
      // printed as the reference is what comes back — which is the whole point. Under
      // `legacy` that value is the BOUNDED one, so the correction silently costs the model
      // the weight it had been asking for.
      calls += 1;
      const restated = restateIntentReference({
        reference,
        universe: UNIVERSE,
        reserveAsset: RESERVE,
        policy,
      });
      if (!restated.ok) throw new Error(restated.reason);
      emitted = operands === 'split' ? restated.value.intent : restated.value.bounded;
      verdict = judge(emitted);
      if (!verdict.ok) deadCycles.push(cycle);
    }

    // What production writes, and reads back next cycle: the INTENTION for the split
    // guard, the APPLIED allocation for the legacy one.
    if (verdict.ok) {
      reference =
        operands === 'split' ? { ...emitted } : clampAllocation(emitted, RESERVE, policy).applied;
    }
  }

  return {
    calls,
    rejectedFirstAttempts,
    deadCycles,
    finalBtc: clampAllocation(reference, RESERVE, policy).applied.BTC ?? 0,
    rules: [...new Set(rules)],
  };
}

function main(): void {
  console.log('='.repeat(96));
  console.log('POLICY-CHANGE REPLAY — what a moved cap costs, with the old operands and the new');
  console.log(
    `${CYCLES} consecutive wake-ups, the model asking for BTC ${ASK.BTC}% every time, ` +
      'seeded from a chain that ran under a 35% ceiling.',
  );
  console.log('='.repeat(96));

  const relaxed = withCaps({ BTC: 40 });
  const tightened = withCaps({ BTC: 30 });

  // P1 — THE RELAXED CASE, which is the defect this PR closes.
  {
    const legacy = run(relaxed, 'legacy');
    const split = run(relaxed, 'split');
    const ok =
      legacy.rejectedFirstAttempts.length === CYCLES &&
      split.rejectedFirstAttempts.length === 0 &&
      split.calls === CYCLES &&
      legacy.calls === 2 * CYCLES;
    record('P1', 'a RELAXED cap no longer costs a retry — and used to cost one every cycle', ok, [
      `BEFORE: ${legacy.calls} LLM calls over ${CYCLES} cycles · ` +
        `${legacy.rejectedFirstAttempts.length} first attempts rejected ` +
        `(${legacy.rules.join(', ') || 'none'}) · ${legacy.deadCycles.length} dead cycles.`,
      `AFTER:  ${split.calls} LLM calls over ${CYCLES} cycles · ` +
        `${split.rejectedFirstAttempts.length} first attempts rejected · ` +
        `${split.deadCycles.length} dead cycles.`,
      `Saved: ${legacy.calls - split.calls} calls over ${CYCLES} cycles — exactly one per cycle, ` +
        'for as long as the model keeps asking for the weight the new ceiling allows.',
      `And the chain now pursues BTC ${split.finalBtc}% instead of ${legacy.finalBtc}%: the retry ` +
        'did not merely cost a call, it talked the model down to the OLD ceiling every time.',
    ]);
  }

  // P2 — THE TIGHTENED CASE, PR #28's closure. A regression here is an interlock.
  {
    const legacy = run(tightened, 'legacy');
    const split = run(tightened, 'split');
    const ok =
      split.rejectedFirstAttempts.length === 0 &&
      split.deadCycles.length === 0 &&
      legacy.deadCycles.length === 0 &&
      split.finalBtc === 30;
    record('P2', 'a TIGHTENED cap still deadlocks nothing — PR #28 stays closed', ok, [
      `AFTER:  ${split.calls} LLM calls · ${split.rejectedFirstAttempts.length} rejected first ` +
        `attempts · ${split.deadCycles.length} dead cycles.`,
      `BEFORE: ${legacy.calls} LLM calls · ${legacy.rejectedFirstAttempts.length} rejected first ` +
        `attempts · ${legacy.deadCycles.length} dead cycles (PR #28 had already closed this side).`,
      `The chain applies BTC ${split.finalBtc}%, which is the new ceiling — the risk-mandated ` +
        'reduction executes, which is the whole point of tightening a cap.',
      'Note the asymmetry the split removes: #28 closed this direction by CLAMPING the ' +
        'reference, which is what made the relaxed direction lossy. Comparing two unclamped ' +
        'intentions closes both at once, structurally.',
    ]);
  }

  // P3 — AND NOTHING MOVES WHEN NOTHING MOVES. The same walk under the shipped policy must
  // cost exactly one call per cycle in both operand sets, or the numbers above are measuring
  // the harness rather than the change.
  {
    const stable = withCaps({ BTC: 35 });
    const legacy = run(stable, 'legacy');
    const split = run(stable, 'split');
    const ok = legacy.calls === CYCLES && split.calls === CYCLES;
    record('P3', 'with the policy holding still, both operand sets cost the same', ok, [
      `BEFORE: ${legacy.calls} calls · AFTER: ${split.calls} calls · ${CYCLES} cycles.`,
      'The control. A difference here would mean the relaxed-case saving above comes from the ' +
        'harness, not from the operands.',
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
  main();
}
