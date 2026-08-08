import 'dotenv/config';
import { config } from '../config/index.js';
import { stickyAt } from '../market/transition.js';
import { ZERO } from '../money.js';
import { evaluateTransition, judgeOrder, type TransitionVerdict } from '../transition/gate.js';
import { loadTransitionTape } from './transitionSetup.js';
import { fmtBar, loadObservationWindow } from './window.js';

/**
 * RISK_OFF COUNTERFACTUAL — exercising the one rung of the ladder the tape never has.
 *
 * The transition gate has four rungs. Three are worn smooth by the real data: `stop_exit`,
 * `frozen` and `actionable` fire constantly. The fourth, `risk_off_reduction`, has NEVER
 * been observed — over the whole 61-day window not one order was placed while a global
 * `risk_off` was confirmed, and the layer proof says so in as many words.
 *
 * That rung carries the heaviest responsibility on the ladder. It is the one guaranteeing
 * that an individual freeze cannot trap exposure in a market that is broadly breaking. On
 * the day the gate starts blocking, it gets that power on the strength of a branch nothing
 * has ever run.
 *
 * So this harness runs it, without waiting for a crash: it replays the recorded history
 * with `riskOffConfirmed` FORCED TRUE on every cycle where at least one asset is frozen,
 * and checks what the ladder then does.
 *
 * ── It calls production, it does not imitate it ─────────────────────────────────
 *
 * Every verdict below comes from the real `evaluateTransition` and the real `judgeOrder`,
 * on the same tape the layer proof reads (`loadTransitionTape`). Nothing about the ladder
 * is reimplemented here — the single injected value is the boolean. If this scenario ever
 * disagrees with production, that is a defect worth seeing, not a difference someone
 * transcribed by hand.
 *
 * ── What it is NOT ──────────────────────────────────────────────────────────────
 *
 * Not a claim about what the bot would have earned. Forcing the override changes what the
 * gate PERMITS; it says nothing about what the model would have decided, and no order is
 * re-run. The counts below are about the ladder, not about performance.
 *
 * READ-ONLY, side-effect free, bounded to a window captured at the start of the run.
 * Run with `npx tsx src/replay/riskOffCounterfactual.ts`. Exits non-zero on a failed
 * invariant.
 */

interface Check {
  id: string;
  title: string;
  passed: boolean;
  /** No real asset-cycle exercises it — reported as such, never as a pass. */
  vacuous: boolean;
  detail: string[];
}

const checks: Check[] = [];

function check(id: string, title: string, passed: boolean, detail: string[]): void {
  checks.push({ id, title, passed, vacuous: false, detail });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

/**
 * An invariant the data cannot exercise.
 *
 * An assertion over an empty set passes trivially and proves nothing, so it gets its own
 * verdict rather than a green tick. It does not fail the run either — "the tape contains
 * no such case" is information about the tape, not a defect in the ladder.
 */
function vacuous(id: string, title: string, detail: string[]): void {
  checks.push({ id, title, passed: false, vacuous: true, detail });
  console.log('');
  console.log(`EMPTY ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

function section(title: string): void {
  console.log('');
  console.log('═'.repeat(100));
  console.log(title);
  console.log('═'.repeat(100));
}

/** One asset-cycle, judged twice: as it happened, and under a forced global risk_off. */
interface Pair {
  cycleId: number;
  atMs: number;
  asset: string;
  frozen: boolean;
  /** The line was actually held this cycle — an unheld line has nothing to reduce. */
  held: boolean;
  actual: TransitionVerdict;
  forced: TransitionVerdict;
}

/** Quantities at or below this count as flat (mirrors derive.ts / lifecycle.ts). */
const DUST = '1e-12';

async function main(): Promise<number> {
  const window = await loadObservationWindow();
  console.log('═'.repeat(100));
  console.log('RISK_OFF COUNTERFACTUAL — exercising the rung the real data never fires');
  console.log('═'.repeat(100));
  console.log(
    `Observation window: ${fmtBar(window.fromMs)} → ${fmtBar(window.toMs)}  ` +
      `(${window.days} days, ${window.decisions} decisions)`,
  );
  console.log(
    'Injection: riskOffConfirmed = TRUE on every cycle where at least one asset is frozen. ' +
      'Nothing else is changed.',
  );
  console.log('Verdicts come from the production evaluateTransition / judgeOrder. READ-ONLY.');

  const { sticky, cycles, bookings, snapshots, tradable, barMs, arrivedDuringTheRun } =
    await loadTransitionTape(window, '[counterfactual]');

  /* ── The replay, twice over ───────────────────────────────────────────────── */
  const pairs: Pair[] = [];
  let injectedCycles = 0;

  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i]!;
    const prior = i > 0 ? snapshots[i - 1]!.states : new Map();

    const states = new Map(
      tradable.map((asset) => [asset, stickyAt(sticky[asset] ?? [], cycle.generatedAtMs, barMs)] as const),
    );
    // THE INJECTION CONDITION, stated once: a cycle carrying at least one frozen asset.
    // A cycle where nothing is frozen has no individual freeze for the override to lift,
    // so forcing it there would exercise nothing and dilute every count below.
    const anyFrozen = [...states.values()].some((s) => s?.frozen === true);
    if (anyFrozen) injectedCycles += 1;

    for (const asset of tradable) {
      const state = states.get(asset) ?? null;
      const view = cycle.assets.get(asset);
      const base = {
        asset,
        sticky: state,
        qty: view?.qtyBefore ?? ZERO,
        price: view?.price ?? null,
        priceStale: view?.priceStale ?? false,
        peakPriceSinceEntry: prior.get(asset)?.peakPriceSinceEntry ?? null,
        stopThresholdPercent: config.transition.peakStopPercent,
      };
      pairs.push({
        cycleId: cycle.id,
        atMs: cycle.generatedAtMs,
        asset,
        frozen: state?.frozen === true,
        held: (view?.qtyBefore ?? ZERO).gt(DUST),
        actual: evaluateTransition({ ...base, riskOffConfirmed: cycle.riskOff ?? false }),
        forced: evaluateTransition({ ...base, riskOffConfirmed: anyFrozen ? true : (cycle.riskOff ?? false) }),
      });
    }
  }

  console.log(
    `[counterfactual] ${injectedCycles}/${cycles.length} cycles carry at least one frozen asset ` +
      `and receive the injection; ${pairs.length} asset-cycles judged twice.`,
  );

  /* ── The four invariants ──────────────────────────────────────────────────── */
  section('INVARIANTS — what the rung must do, and must not do');

  // ── 1. The stop keeps priority ────────────────────────────────────────────────
  const wouldStop = pairs.filter((p) => p.actual.gate === 'stop_exit');
  const stopSurvived = wouldStop.filter((p) => p.forced.gate === 'stop_exit');
  if (wouldStop.length === 0) {
    vacuous('I1', 'the stop keeps priority over a confirmed risk_off', [
      'no asset-cycle on this tape would have fired the stop — the invariant is not exercised.',
    ]);
  } else {
    check('I1', 'the stop keeps priority over a confirmed risk_off', stopSurvived.length === wouldStop.length, [
      `${wouldStop.length} asset-cycles would have fired the stop; ${stopSurvived.length} still report stop_exit ` +
        'under a forced override — rung 1 before rung 2.',
      // The mirror: those same asset-cycles ARE frozen, so rung 2 was genuinely competing
      // for them. Without this the invariant could pass because the override never applied.
      `all of them are frozen (rung 2 was in the running): ${wouldStop.every((p) => p.frozen)}`,
    ]);
  }

  // ── 2. Reductions become allowed ──────────────────────────────────────────────
  //
  // The rung's whole purpose. Every frozen asset-cycle that is not being stopped out must,
  // under a confirmed override, allow a SELL.
  const frozenNotStopped = pairs.filter((p) => p.frozen && p.forced.gate !== 'stop_exit');
  const sellsAllowed = frozenNotStopped.filter((p) => judgeOrder(p.forced, 'sell').verdict === 'allowed');
  if (frozenNotStopped.length === 0) {
    vacuous('I2', 'a reduction on a frozen asset is allowed under a confirmed risk_off', [
      'no frozen asset-cycle survives the stop on this tape — the invariant is not exercised.',
    ]);
  } else {
    // The mirror, and it is the one that matters: WITHOUT the injection those very same
    // sells are refused. An invariant that passed both ways would be measuring nothing.
    const refusedWithout = frozenNotStopped.filter((p) => judgeOrder(p.actual, 'sell').verdict === 'forbidden');
    check(
      'I2',
      'a reduction on a frozen asset is allowed under a confirmed risk_off',
      sellsAllowed.length === frozenNotStopped.length && refusedWithout.length === frozenNotStopped.length,
      [
        `${frozenNotStopped.length} frozen asset-cycles not being stopped out`,
        `sells ALLOWED with the override: ${sellsAllowed.length}/${frozenNotStopped.length}`,
        `the same sells REFUSED without it: ${refusedWithout.length}/${frozenNotStopped.length} ` +
          '— the rung is doing the work, not the freeze quietly lifting on its own',
      ],
    );
  }

  // ── 3. Increases stay forbidden ───────────────────────────────────────────────
  const buysRefused = frozenNotStopped.filter((p) => judgeOrder(p.forced, 'buy').verdict === 'forbidden');
  if (frozenNotStopped.length === 0) {
    vacuous('I3', 'an increase on a frozen asset stays forbidden under risk_off', [
      'no frozen asset-cycle survives the stop on this tape — the invariant is not exercised.',
    ]);
  } else {
    check('I3', 'an increase on a frozen asset stays forbidden under risk_off', buysRefused.length === frozenNotStopped.length, [
      `buys REFUSED with the override: ${buysRefused.length}/${frozenNotStopped.length}`,
      'risk_off lifts the freeze to REDUCE, never to add — the asymmetry is the rung, ' +
        `and the sells above (${sellsAllowed.length} allowed) are the other half of it.`,
    ]);
  }

  // ── 4. No label moves ─────────────────────────────────────────────────────────
  //
  // The T0 property, restated for this scenario: the injection changes what the gate
  // PERMITS, never what the classifier SAYS. If a confirmed regime moved, the
  // counterfactual would be measuring two changes at once.
  const labelMoves = pairs.filter(
    (p) =>
      p.actual.confirmedRegime !== p.forced.confirmedRegime ||
      p.actual.rawRegime !== p.forced.rawRegime ||
      p.actual.runLength !== p.forced.runLength ||
      p.actual.actionable !== p.forced.actionable,
  );
  check('I4', 'no regime label, run length or actionability moves under the injection', labelMoves.length === 0, [
    `${pairs.length} asset-cycles compared field by field (confirmed regime, raw regime, run length, actionable)`,
    labelMoves.length === 0
      ? 'not one moved — the injection changes what the ladder PERMITS, never what the classifier says'
      : `moved: ${labelMoves.slice(0, 5).map((p) => `#${p.cycleId} ${p.asset}`).join(', ')}`,
    // The mirror: the GATE did move, on plenty of them. Otherwise "nothing changed" would
    // be true for the boring reason that the injection did nothing at all.
    `meanwhile the gate changed on ${pairs.filter((p) => p.actual.gate !== p.forced.gate).length} of them`,
  ]);

  /* ── The measurement ──────────────────────────────────────────────────────── */
  section('MEASUREMENT — how much the rung would move');

  const changed = pairs.filter((p) => p.actual.gate !== p.forced.gate);
  const byOrigin = new Map<string, Map<string, number>>();
  for (const p of changed) {
    const to = byOrigin.get(p.actual.gate) ?? new Map<string, number>();
    to.set(p.forced.gate, (to.get(p.forced.gate) ?? 0) + 1);
    byOrigin.set(p.actual.gate, to);
  }

  console.log('');
  console.log(`   asset-cycles whose verdict changes under a confirmed risk_off: ${changed.length}/${pairs.length}`);
  for (const [from, tos] of [...byOrigin.entries()].sort()) {
    for (const [to, n] of [...tos.entries()].sort()) {
      console.log(`     ${from.padEnd(20)} → ${to.padEnd(20)} ${String(n).padStart(5)}`);
    }
  }
  if (changed.length === 0) console.log('     (none)');

  /* ── The 16 historically forbidden orders ─────────────────────────────────── */
  const orderRows: string[] = [];
  let forbiddenBefore = 0;
  let freedByOverride = 0;
  let stillForbidden = 0;
  const stillForbiddenReasons = new Map<string, number>();

  const pairAt = new Map(pairs.map((p) => [`${p.cycleId}:${p.asset}`, p] as const));
  for (const cycle of cycles) {
    for (const booking of cycle.bookings) {
      const pair = pairAt.get(`${cycle.id}:${booking.asset}`);
      if (pair == null) continue;
      const before = judgeOrder(pair.actual, booking.side);
      if (before.verdict !== 'forbidden') continue;
      forbiddenBefore += 1;
      const after = judgeOrder(pair.forced, booking.side);
      if (after.verdict === 'allowed') {
        freedByOverride += 1;
        orderRows.push(
          `   ${String(cycle.id).padEnd(6)}${fmtBar(cycle.generatedAtMs).padEnd(18)}${booking.asset.padEnd(6)}` +
            `${booking.side.padEnd(6)}${pair.actual.gate.padEnd(20)}→ ${after.verdict.toUpperCase()}`,
        );
      } else {
        stillForbidden += 1;
        const why = booking.side === 'buy' ? 'a buy — the override never lifts an increase' : after.reason;
        stillForbiddenReasons.set(why, (stillForbiddenReasons.get(why) ?? 0) + 1);
        orderRows.push(
          `   ${String(cycle.id).padEnd(6)}${fmtBar(cycle.generatedAtMs).padEnd(18)}${booking.asset.padEnd(6)}` +
            `${booking.side.padEnd(6)}${pair.actual.gate.padEnd(20)}→ ${after.verdict.toUpperCase()} (${why})`,
        );
      }
    }
  }

  console.log('');
  console.log(`   of the ${forbiddenBefore} real orders the layer forbids today:`);
  console.log(`     ${freedByOverride} would be ALLOWED under a confirmed risk_off (all of them sells, by construction)`);
  console.log(`     ${stillForbidden} stay forbidden`);
  for (const [why, n] of [...stillForbiddenReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`       ${String(n).padStart(3)} × ${why}`);
  }
  if (orderRows.length > 0) {
    console.log('');
    console.log(
      `   ${'cycle'.padEnd(6)}${'when'.padEnd(18)}${'asset'.padEnd(6)}${'side'.padEnd(6)}${'gate today'.padEnd(20)}under risk_off`,
    );
    for (const row of orderRows) console.log(row);
  }

  /* ── The no_regime edge, measured and NOT corrected ───────────────────────── */
  section('THE no_regime EDGE — measured here, corrected in the blocking PR');

  console.log('');
  console.log('   `evaluateTransition` returns `no_regime` BEFORE it looks at risk_off, so an asset with no');
  console.log('   usable 4h bar is untouchable even under a confirmed override — the wrong default for a');
  console.log('   ladder whose whole point is that reducing must always stay possible. Not corrected here.');
  console.log('   What follows is the size of the hole, so the fix can be prioritised on evidence.');

  const noRegime = pairs.filter((p) => p.actual.gate === 'no_regime');
  // The ones that would actually matter: a line that is HELD, where a reduction is a real
  // thing to want. An unheld line has nothing to reduce, so its `no_regime` is inert
  // whatever the ladder does with it.
  const noRegimeHeld = noRegime.filter((p) => p.held);
  const sellsByCycle = new Map<number, Set<string>>();
  for (const cycle of cycles) {
    const sold = new Set(cycle.bookings.filter((b) => b.side === 'sell').map((b) => b.asset));
    if (sold.size > 0) sellsByCycle.set(cycle.id, sold);
  }
  const noRegimeWithOrder = noRegime.filter((p) => sellsByCycle.get(p.cycleId)?.has(p.asset) === true);

  console.log('');
  console.log(`   asset-cycles returning no_regime: ${noRegime.length}/${pairs.length}`);
  console.log(`     of which the line was actually held: ${noRegimeHeld.length}`);
  console.log(`     of which a real SELL was booked that cycle: ${noRegimeWithOrder.length}`);
  console.log('');
  if (noRegime.length === 0) {
    console.log('   The edge is THEORETICAL on this tape: no asset-cycle ever reaches it, so correcting it');
    console.log('   changes nothing that has happened. It stays worth fixing for the shape of the ladder,');
    console.log('   but it does not compete for priority with anything measurable.');
  } else if (noRegimeWithOrder.length === 0) {
    console.log(`   The edge is REACHED (${noRegime.length} asset-cycles) but never coincides with a reduction:`);
    console.log('   no sell was booked on an asset while it was in this state. Real, not yet costly.');
  } else {
    console.log(`   The edge is LIVE: ${noRegimeWithOrder.length} real sell(s) landed on an asset the ladder`);
    console.log('   could not judge. The early return would have blocked a reduction under a confirmed');
    console.log('   override — the correction is a priority, not a tidy-up.');
  }

  const failed = checks.filter((c) => !c.passed && !c.vacuous);
  const empty = checks.filter((c) => c.vacuous);
  console.log('');
  console.log('═'.repeat(100));
  console.log(
    `${checks.length - failed.length - empty.length}/${checks.length} invariants passed` +
      (empty.length > 0 ? `, ${empty.length} not exercised by the tape (${empty.map((e) => e.id).join(', ')})` : '') +
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
    console.error('risk_off counterfactual failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
