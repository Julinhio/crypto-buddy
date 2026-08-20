import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { config, type AppConfig } from '../config/index.js';
import { dec, ZERO } from '../money.js';
import type { PriceLookup, VirtualPortfolio } from '../portfolio/derive.js';
import { computeMovements } from '../execution/movements.js';
import { clampAllocation } from '../risk/clamp.js';
import { restateIntentReference } from '../decision/intentReference.js';
import { checkCoherence, type CoherenceRule } from '../decision/coherence.js';
import type { PositionNote } from '../decision/schema.js';

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
 *              catches it — which is exactly why it was survivable and easy to leave.
 *
 * ── WHAT IS SIMULATED, AND WHAT IS NOT ──────────────────────────────────────────
 *
 * A REAL BOOK, and that is the correction the review caught. An earlier version of this
 * file handed the guard an empty movement list, which silently assumed a book already
 * sitting on its target. True in the steady state, and FALSE on the very cycle a cap
 * moves — the book is still at the old bounded allocation, so the new one produces a
 * genuine leg. Assuming it away hid a retry production really does pay, and made the
 * headline number one call per cycle too good.
 *
 * So the book is carried explicitly: it starts at the allocation the old policy applied,
 * every accepted cycle moves it to what the chain retained, and the movements the guard
 * judges come from the real `computeMovements`, 2% floor included. Prices are held still
 * on purpose — drift is a different phenomenon and would only add noise to a measurement
 * about caps.
 *
 * THE MODEL is reduced to the three behaviours the retry contract needs, and no more:
 *
 *   1. it keeps asking for the allocation it wants, as a `hold`, with no notes — because
 *      from where it sits nothing changed;
 *   2. rejected on rule 1 or 2, it takes option 2 of the retry prompt: re-emit the
 *      reference UNCHANGED. Whichever value the guard PRINTS as the reference is what
 *      comes back, which is what makes the cost measurable;
 *   3. rejected on rule 4, it takes option 1: keep the move, and give the moving lines
 *      their `position_notes` entry.
 *
 * The rules themselves are not simulated at all — this drives the real `checkCoherence`,
 * the real `clampAllocation` and the real `computeMovements`, with the two operand sets
 * exactly as production and the pre-PR code build them.
 *
 * Run with `npm run replay:policy-change`. Exits non-zero if any criterion fails.
 */

const RESERVE = 'USDT';
const UNIVERSE = ['BTC', 'ETH', 'BNB', 'XRP', 'USDT'];
/** What the model wants, and keeps wanting. Cash sits on the floor, so nothing rescales. */
const ASK = { BTC: 40, ETH: 18, BNB: 12, XRP: 0, USDT: 30 };
const CYCLES = 10;
const EQUITY = 1000;
/** Held still: this measures a cap moving, not the market. */
const PRICES: Record<string, number> = { BTC: 60000, ETH: 3000, BNB: 600, XRP: 0.5, USDT: 1 };

const priceOf: PriceLookup = (asset) => (PRICES[asset] != null ? dec(PRICES[asset]!) : null);

const withCaps = (perAsset: Record<string, number>): AppConfig => ({
  ...config,
  execution: {
    ...config.execution,
    caps: { ...config.execution.caps, perAsset: { ...config.execution.caps.perAsset, ...perAsset } },
  },
});

/** A book holding exactly `allocation` at `EQUITY`, valued at the frozen prices. */
function bookAt(allocation: Record<string, number>): VirtualPortfolio {
  const equity = dec(EQUITY);
  const positions = Object.entries(allocation)
    .filter(([asset]) => asset !== RESERVE)
    .map(([asset, percent]) => {
      const value = equity.times(percent).div(100);
      const price = dec(PRICES[asset] ?? 1);
      return {
        asset,
        qty: price.gt(0) ? value.div(price) : ZERO,
        avgCost: price,
        price,
        priceStale: false,
        value,
        unrealizedPnl: ZERO,
        weightPercent: dec(percent),
      };
    });
  const cash = equity.times(allocation[RESERVE] ?? 0).div(100);
  return {
    reserveAsset: RESERVE,
    startingCapital: equity,
    cash,
    equity,
    deployedPercent: equity.minus(cash).div(equity).times(100),
    realizedPnl: ZERO,
    unrealizedPnl: ZERO,
    totalPnl: ZERO,
    positions,
  };
}

const weightOf = (book: VirtualPortfolio, asset: string): number => {
  const position = book.positions.find((p) => p.asset === asset);
  return position ? Number(position.weightPercent.toFixed(2)) : 0;
};

const noteFor = (asset: string): PositionNote => ({
  asset,
  thesis: 'the ceiling moved and the line follows it',
  invalidation: 'the thesis stops holding',
  replace: true,
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
  /** Cycles still incoherent after the single retry — a dead cycle, zero trading. */
  deadCycles: number[];
  /** The weight the BOOK ends up holding on the line the policy moved. */
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
  // asking for 40, the old 35 ceiling applied 35, and the BOOK is sitting on that 35.
  const oldPolicy = withCaps({ BTC: 35 });
  const seededApplied = clampAllocation(ASK, RESERVE, oldPolicy).applied;
  let reference: Record<string, number> = operands === 'split' ? { ...ASK } : seededApplied;
  let book = bookAt(seededApplied);
  // A bot that has been running carries a thesis on every line it holds. That matters for
  // rule 3: it is what makes a note on an UNMOVED line a violation rather than a first
  // thesis, so the model cannot dodge rule 4 by noting everything.
  const assetsWithStoredThesis = new Set(['BTC', 'ETH', 'BNB']);

  let calls = 0;
  const rejectedFirstAttempts: number[] = [];
  const deadCycles: number[] = [];
  const rules: CoherenceRule[] = [];

  const judge = (emitted: Record<string, number>, notes: PositionNote[]) => {
    const restated = restateIntentReference({
      reference,
      universe: UNIVERSE,
      reserveAsset: RESERVE,
      policy,
    });
    if (!restated.ok) throw new Error(`the seeded reference is not restatable: ${restated.reason}`);
    const applied = clampAllocation(emitted, RESERVE, policy).applied;
    const movements = computeMovements(
      book,
      applied,
      priceOf,
      policy.execution.feePercent,
      policy.execution.minMovementPercent,
    );
    // The counterfactual, from the same book — exactly as `decide()` derives it, before the
    // gate. Under `legacy` it did not exist, so the disjunction collapses to the new plan.
    const previousIntentMovements =
      operands === 'split'
        ? computeMovements(
            book,
            restated.value.bounded,
            priceOf,
            policy.execution.feePercent,
            policy.execution.minMovementPercent,
          )
        : [];
    const verdict = checkCoherence({
      strategy: 'v5',
      actionType: 'hold',
      // The operand split, in one line. `legacy` compared two BOUNDED values; `split`
      // compares two raw intentions.
      intentTarget: operands === 'split' ? emitted : applied,
      intentReference: operands === 'split' ? restated.value.intent : restated.value.bounded,
      movements,
      previousIntentMovements,
      reserveAsset: RESERVE,
      notes,
      assetsWithStoredThesis,
    });
    return { verdict, applied, movements };
  };

  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    calls += 1;
    let emitted: Record<string, number> = { ...ASK };
    let notes: PositionNote[] = [];
    let attempt = judge(emitted, notes);

    if (!attempt.verdict.ok) {
      rejectedFirstAttempts.push(cycle);
      const fired = attempt.verdict.violations.map((v) => v.rule);
      rules.push(...fired);
      calls += 1;

      if (fired.includes('hold_moved_target') || fired.includes('target_not_executable')) {
        // OPTION 2: re-emit the reference unchanged. Whatever the guard printed as the
        // reference is what comes back — which is the whole point. Under `legacy` that
        // value is the BOUNDED one, so the correction silently costs the model the weight
        // it had been asking for.
        const restated = restateIntentReference({
          reference,
          universe: UNIVERSE,
          reserveAsset: RESERVE,
          policy,
        });
        if (!restated.ok) throw new Error(restated.reason);
        emitted = operands === 'split' ? restated.value.intent : restated.value.bounded;
        notes = [];
      } else {
        // OPTION 1: keep the move and give the moving lines their note. This is the branch
        // a moved ceiling reaches under the split operands — the INTENTION did not change,
        // but the newly permitted weight moves the BOOK, and a line that trades has to say
        // what it is now betting on.
        emitted = { ...ASK };
        notes = attempt.movements.filter((m) => !m.fullExit).map((m) => noteFor(m.asset));
      }
      attempt = judge(emitted, notes);
      if (!attempt.verdict.ok) deadCycles.push(cycle);
    }

    if (attempt.verdict.ok) {
      // What production writes and reads back next cycle: the INTENTION for the split
      // guard, the APPLIED allocation for the legacy one. And the book follows the chain.
      reference = operands === 'split' ? { ...emitted } : attempt.applied;
      book = bookAt(attempt.applied);
    }
  }

  return {
    calls,
    rejectedFirstAttempts,
    deadCycles,
    finalBtc: weightOf(book, 'BTC'),
    rules: [...new Set(rules)],
  };
}

function main(): void {
  console.log('='.repeat(96));
  console.log('POLICY-CHANGE REPLAY — what a moved cap costs, with the old operands and the new');
  console.log(
    `${CYCLES} consecutive wake-ups, the model asking for BTC ${ASK.BTC}% every time, on a ` +
      `$${EQUITY} book seeded at the allocation a 35% ceiling applied.`,
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
      legacy.finalBtc === 35 &&
      split.rejectedFirstAttempts.length === 1 &&
      split.deadCycles.length === 0 &&
      split.finalBtc === 40 &&
      split.calls < legacy.calls;
    record('P1', 'a RELAXED cap stops costing a retry EVERY cycle, and the weight arrives', ok, [
      `BEFORE: ${legacy.calls} LLM calls over ${CYCLES} cycles · ` +
        `${legacy.rejectedFirstAttempts.length} first attempts rejected ` +
        `(${legacy.rules.join(', ') || 'none'}) · ${legacy.deadCycles.length} dead cycles · ` +
        `book ends at BTC ${legacy.finalBtc}%.`,
      `AFTER:  ${split.calls} LLM calls over ${CYCLES} cycles · ` +
        `${split.rejectedFirstAttempts.length} first attempt rejected, on cycle ` +
        `${split.rejectedFirstAttempts.join(', ') || '—'} (${split.rules.join(', ') || 'none'}) · ` +
        `${split.deadCycles.length} dead cycles · book ends at BTC ${split.finalBtc}%.`,
      `Saved: ${legacy.calls - split.calls} calls over ${CYCLES} cycles.`,
      'THE ONE RETRY THAT REMAINS IS NOT THE DEFECT, and it is why this harness carries a ' +
        'real book. On the cycle the ceiling moves, the intention has not changed but the ' +
        'BOOK does — the newly permitted weight is a real leg — so rule 4 asks the line that ' +
        'trades to say what it is now betting on. The model supplies the note and the trade ' +
        'lands. That is the guard working, once, not the reference being stale every cycle.',
      `AND THE WEIGHT ACTUALLY ARRIVES: the book ends at BTC ${split.finalBtc}% instead of ` +
        `${legacy.finalBtc}%. Before, the retry did not merely cost a call — it talked the ` +
        'model back down to the OLD ceiling every single cycle, so the weight the new ceiling ' +
        'permits never reached the book at all.',
    ]);
  }

  // P2 — THE TIGHTENED CASE, PR #28's closure. A regression here is an interlock.
  {
    const legacy = run(tightened, 'legacy');
    const split = run(tightened, 'split');
    const ok =
      split.deadCycles.length === 0 &&
      legacy.deadCycles.length === 0 &&
      split.finalBtc === 30 &&
      legacy.finalBtc === 30;
    record('P2', 'a TIGHTENED cap still deadlocks nothing — PR #28 stays closed', ok, [
      `AFTER:  ${split.calls} LLM calls · ${split.rejectedFirstAttempts.length} rejected first ` +
        `attempt(s) (${split.rules.join(', ') || 'none'}) · ${split.deadCycles.length} dead cycles · ` +
        `book ends at BTC ${split.finalBtc}%.`,
      `BEFORE: ${legacy.calls} LLM calls · ${legacy.rejectedFirstAttempts.length} rejected first ` +
        `attempt(s) · ${legacy.deadCycles.length} dead cycles · book ends at BTC ${legacy.finalBtc}%.`,
      'The risk-mandated reduction executes in both, which is the whole point of tightening a ' +
        'cap. Here too the single rejection is rule 4, on the cycle the book actually moves.',
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
    const ok =
      legacy.calls === CYCLES &&
      split.calls === CYCLES &&
      legacy.finalBtc === 35 &&
      split.finalBtc === 35;
    record('P3', 'with the policy holding still, both operand sets cost the same', ok, [
      `BEFORE: ${legacy.calls} calls · AFTER: ${split.calls} calls · ${CYCLES} cycles · ` +
        `book steady at BTC ${split.finalBtc}%.`,
      'The control. A difference here would mean the numbers above come from the harness ' +
        'rather than from the operands — and it pins the steady state: a book already on its ' +
        'target produces no movement, so no rule fires at all.',
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
