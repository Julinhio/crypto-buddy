import 'dotenv/config';
import { config } from '../config/index.js';
import { stickyAt } from '../market/transition.js';
import { ZERO } from '../money.js';
import { evaluateTransition, judgeOrder, type TransitionVerdict } from '../transition/gate.js';
import { judgeVector, type JudgedLeg } from '../transition/vector.js';
import { loadTransitionTape } from './transitionSetup.js';
import { fmtBar, loadObservationWindow } from './window.js';

/**
 * ATOMICITY, MEASURED OVER THE RECORDED CORPUS — how much does refusing the vector whole
 * actually cost, on the history the bot really has?
 *
 * The rule says: outside the deterministic exits, one forbidden strategic leg refuses them
 * all. Stated that way it sounds expensive — a single frozen asset could veto an entire
 * cycle's strategy. Whether it IS expensive is a question about this tape, not about the
 * rule, and this harness answers it by replaying every sovereign order through the real
 * `judgeVector`.
 *
 * ── What it must show, and why that is a real test ──────────────────────────────
 *
 * The measurement that led to atomicity found four cycles carrying several forbidden legs
 * — and in each of them EVERY leg was already forbidden. No cycle in the recorded history
 * mixes a cleared leg with a refused one. So the rule must cancel NOTHING extra: the
 * counts stay 26 allowed / 16 forbidden, and `cancelled_atomic` is zero.
 *
 * That is a strong check precisely because it is easy to fail in both directions. A rule
 * that cancelled the deterministic exits, or that let `superseded` and `unjudged` count as
 * triggers, would move those numbers immediately. And if the numbers DO move, one of two
 * things is wrong — the implementation, or the measurement atomicity was chosen on. Either
 * is worth stopping for.
 *
 * ── It calls production, it does not imitate it ─────────────────────────────────
 *
 * Every verdict comes from the real `evaluateTransition`, `judgeOrder` and `judgeVector`,
 * over the same tape the layer proof and the risk_off counterfactual read.
 *
 * ── The population: what BOOKED ─────────────────────────────────────────────────
 *
 * The legs replayed here are the sovereign bookings, because that is the only per-leg
 * record the journal holds for the past. The LIVE layer judges the computed movements
 * instead — the vector before execution, which is what the gate will act on when it
 * blocks. The two coincide except where a movement was thinned by a venue filter or a
 * failed booking, so this harness measures a lower bound on the vectors the live journal
 * will show. Stated rather than smoothed over.
 *
 * READ-ONLY, side-effect free, bounded to a window captured at the start of the run.
 * Run with `npx tsx src/replay/atomicVector.ts`. Exits non-zero on a failed check.
 */

interface Check {
  id: string;
  title: string;
  passed: boolean;
  detail: string[];
}

const checks: Check[] = [];

function check(id: string, title: string, passed: boolean, detail: string[]): void {
  checks.push({ id, title, passed, detail });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

function section(title: string): void {
  console.log('');
  console.log('═'.repeat(100));
  console.log(title);
  console.log('═'.repeat(100));
}

/** One cycle's vector, judged. */
interface JudgedCycle {
  id: number;
  atMs: number;
  legs: JudgedLeg[];
  refused: boolean;
  trigger: string | null;
}

async function main(): Promise<number> {
  const window = await loadObservationWindow();
  console.log('═'.repeat(100));
  console.log('ATOMIC VECTOR REFUSAL — what refusing the vector whole would have cancelled');
  console.log('═'.repeat(100));
  console.log(
    `Observation window: ${fmtBar(window.fromMs)} → ${fmtBar(window.toMs)}  ` +
      `(${window.days} days, ${window.decisions} decisions)`,
  );
  console.log('Legs = the sovereign bookings (the only per-leg record the journal holds for the past).');
  console.log('Verdicts come from the production evaluateTransition / judgeOrder / judgeVector. READ-ONLY.');

  const { sticky, cycles, bookings, snapshots, tradable, barMs, arrivedDuringTheRun } =
    await loadTransitionTape(window, '[atomic]');

  /* ── Replay: every cycle's vector, judged ─────────────────────────────────── */
  const judged: JudgedCycle[] = [];

  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i]!;
    const prior = i > 0 ? snapshots[i - 1]!.states : new Map();

    const verdicts = new Map<string, TransitionVerdict>(
      tradable.map((asset) => {
        const view = cycle.assets.get(asset);
        return [
          asset,
          evaluateTransition({
            asset,
            sticky: stickyAt(sticky[asset] ?? [], cycle.generatedAtMs, barMs),
            riskOffConfirmed: cycle.riskOff ?? false,
            qty: view?.qtyBefore ?? ZERO,
            price: view?.price ?? null,
            priceStale: view?.priceStale ?? false,
            peakPriceSinceEntry: prior.get(asset)?.peakPriceSinceEntry ?? null,
            stopThresholdPercent: config.transition.peakStopPercent,
          }),
        ] as const;
      }),
    );

    const vector = judgeVector(
      cycle.bookings.map((b) => ({
        asset: b.asset,
        side: b.side,
        notional: b.baseDelta.abs().times(b.valuationPrice),
      })),
      verdicts,
    );
    judged.push({
      id: cycle.id,
      atMs: cycle.generatedAtMs,
      legs: vector.legs,
      refused: vector.refused,
      trigger: vector.trigger?.asset ?? null,
    });
  }

  const legs = judged.flatMap((c) => c.legs);
  const count = (v: JudgedLeg['verdict']): number => legs.filter((l) => l.verdict === v).length;
  const ownCount = (v: string): number => legs.filter((l) => l.ownVerdict === v).length;

  /* ── The checks ───────────────────────────────────────────────────────────── */
  section('CHECKS — the rule, against the corpus it was chosen on');

  // ── A1. The per-leg counts do not move ────────────────────────────────────────
  //
  // The measurement's own numbers, recomputed from the same walk rather than quoted from a
  // document. The mirror is the OWN-verdict count: if atomicity had upgraded anything, the
  // two columns would disagree, and printing only one of them would hide it.
  check(
    'A1',
    'atomicity cancels nothing extra on this corpus',
    count('allowed') === ownCount('allowed') &&
      count('forbidden') === ownCount('forbidden') &&
      count('cancelled_atomic') === 0 &&
      legs.length === bookings.length,
    [
      `${legs.length} sovereign legs judged (journal holds ${bookings.length})`,
      `after the vector pass:  allowed ${count('allowed')} · forbidden ${count('forbidden')} · ` +
        `cancelled_atomic ${count('cancelled_atomic')} · superseded ${count('superseded')} · ` +
        `unjudged ${count('unjudged')}`,
      `before it (own asset):  allowed ${ownCount('allowed')} · forbidden ${ownCount('forbidden')} · ` +
        `superseded ${ownCount('superseded')} · unjudged ${ownCount('unjudged')}`,
      // The two columns above are the actual assertion: atomicity is proven inert by the
      // BEFORE/AFTER pair, recomputed on this run, not by matching a number in a document.
      // The reconciliation below is a note, and it has to be read as one — the observation
      // window is the whole history and only ever grows, so the report's totals are a
      // snapshot that the live bot moves without anyone touching the code.
      `RAPPORT §3 measured 42 legs, 26 allowed / 16 forbidden. This run sees ${legs.length} legs, ` +
        `${count('allowed')} allowed / ${count('forbidden')} forbidden` +
        (legs.length === 42
          ? '.'
          : ` — ${legs.length - 42} sovereign order(s) landed since the report was written. The ` +
            'FORBIDDEN count is what atomicity was chosen on, and A2 re-derives its premise below.'),
    ],
  );

  // ── A2. And that is a property of the tape, not luck ──────────────────────────
  //
  // A1 could be green for the boring reason that the rule never fires. This is the fact
  // that makes it green: no cycle in the recorded history mixes a cleared strategic leg
  // with a refused one, so there is never anything for atomicity to cancel.
  const mixed = judged.filter(
    (c) =>
      c.legs.some((l) => !l.deterministic && l.ownVerdict === 'forbidden') &&
      c.legs.some((l) => !l.deterministic && l.ownVerdict !== 'forbidden'),
  );
  const multiForbidden = judged.filter(
    (c) => c.legs.filter((l) => !l.deterministic && l.ownVerdict === 'forbidden').length > 1,
  );
  check('A2', 'no historical cycle mixes a cleared strategic leg with a refused one', mixed.length === 0, [
    `${judged.filter((c) => c.refused).length} cycle(s) carry at least one forbidden strategic leg`,
    `${multiForbidden.length} of them carry more than one: ${multiForbidden.map((c) => `#${c.id}`).join(', ') || '(none)'}`,
    mixed.length === 0
      ? 'and in every one of them EVERY strategic leg is already forbidden — which is exactly why A1 ' +
        'reports zero cancellations, and would stop being true the day it changes'
      : `MIXED: ${mixed.map((c) => `#${c.id}`).join(', ')} — atomicity now has real work to do, and the ` +
        'measurement that chose it needs re-reading',
  ]);

  // ── A3. The deterministic exits are exempt, and cannot trigger ────────────────
  const stopLegs = legs.filter((l) => l.deterministic);
  const cancelledDeterministic = stopLegs.filter((l) => l.verdict === 'cancelled_atomic');
  const triggeredByDeterministic = judged.filter(
    (c) => c.refused && c.legs.find((l) => l.asset === c.trigger)?.deterministic === true,
  );
  check(
    'A3',
    'a deterministic exit is never cancelled by atomicity and never triggers it',
    cancelledDeterministic.length === 0 && triggeredByDeterministic.length === 0,
    [
      `${stopLegs.length} deterministic leg(s) on this tape (peak stop, or a reduction under a ` +
        'confirmed risk_off)',
      `cancelled by atomicity: ${cancelledDeterministic.length} · named as trigger: ${triggeredByDeterministic.length}`,
      stopLegs.length === 0
        ? 'NOT EXERCISED by this tape — no booking ever landed on a stopping or risk_off asset. The ' +
          'property is proven synthetically in src/test/transitionVector.ts instead.'
        : 'the code de-risking is never held hostage to the model\'s strategy being refused.',
    ],
  );

  // ── A4. Every refused cycle names its trigger ─────────────────────────────────
  //
  // The provenance is only worth a column if it is always there when it matters: a refusal
  // that names no leg is unreadable six weeks later, which is the entire failure mode this
  // PR exists to prevent.
  const refused = judged.filter((c) => c.refused);
  const namedTrigger = refused.filter((c) => c.trigger != null && c.legs.some((l) => l.asset === c.trigger));
  const unrefusedNamed = judged.filter((c) => !c.refused && c.trigger != null);
  check(
    'A4',
    'every refused vector names a trigger that is one of its own legs',
    namedTrigger.length === refused.length && unrefusedNamed.length === 0,
    [
      `${refused.length} refused cycle(s), ${namedTrigger.length} of them naming a leg of their own vector`,
      `${unrefusedNamed.length} cycle(s) name a trigger without being refused (must be 0)`,
    ],
  );

  /* ── The measurement ──────────────────────────────────────────────────────── */
  section('MEASUREMENT — the refused cycles, leg by leg');

  console.log('');
  console.log(
    `   ${'cycle'.padEnd(7)}${'when'.padEnd(18)}${'asset'.padEnd(6)}${'side'.padEnd(6)}` +
      `${'own verdict'.padEnd(14)}${'after vector'.padEnd(18)}notional`,
  );
  for (const cycle of refused) {
    for (const leg of [...cycle.legs].sort((a, b) => a.asset.localeCompare(b.asset))) {
      const flag = leg.asset === cycle.trigger ? ' ← trigger' : '';
      console.log(
        `   ${String(cycle.id).padEnd(7)}${fmtBar(cycle.atMs).padEnd(18)}${leg.asset.padEnd(6)}` +
          `${leg.side.padEnd(6)}${leg.ownVerdict.padEnd(14)}${leg.verdict.padEnd(18)}` +
          `$${leg.notional.toFixed(2)}${flag}`,
      );
    }
  }
  if (refused.length === 0) console.log('   (none)');

  const cancelledNotional = legs
    .filter((l) => l.verdict === 'cancelled_atomic')
    .reduce((sum, l) => sum.plus(l.notional), ZERO);
  console.log('');
  console.log(
    `   exposure cancelled by atomicity alone: $${cancelledNotional.toFixed(2)} across ` +
      `${count('cancelled_atomic')} leg(s) — the marginal cost of refusing the vector whole ` +
      'rather than leg by leg.',
  );

  /* ── The live population, for contrast ───────────────────────────────────── */
  section('WHAT THE LIVE JOURNAL WILL SHOW INSTEAD');

  console.log('');
  console.log('   This harness judges what BOOKED, the only per-leg record the past holds. The live layer');
  console.log('   judges the COMPUTED MOVEMENTS — the vector before execution, which is the population the');
  console.log('   gate acts on when it blocks. They differ exactly where a movement was thinned by a venue');
  console.log('   filter or a failed booking, so the figures above are a LOWER BOUND on what');
  console.log('   `leg_verdict` will report from now on. Compare them with:');
  console.log('');
  console.log("     select decision_id, asset, gate, leg_side, leg_verdict, atomic_trigger_asset");
  console.log('     from transition_observations where leg_verdict is not null order by created_at desc;');

  const failed = checks.filter((c) => !c.passed);
  console.log('');
  console.log('═'.repeat(100));
  console.log(
    `${checks.length - failed.length}/${checks.length} checks passed` +
      (failed.length > 0 ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}` : ''),
  );
  console.log(
    `Window bounded at capture; ${arrivedDuringTheRun} row(s) written by the live bot during the run were excluded.`,
  );
  console.log('═'.repeat(100));
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('atomic vector replay failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
