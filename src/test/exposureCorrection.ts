import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { Decimal, dec } from '../money.js';
import type { PriceLookup, VirtualPortfolio } from '../portfolio/derive.js';
import { planMovements } from '../execution/movements.js';
import type { TransitionGate } from '../transition/gate.js';
import { assessBand, type AssessBandInput } from '../exposure/band.js';
import { correctToBand, type CorrectInput, type CorrectionOutcome } from '../exposure/correct.js';
import { toCorrectionRows } from '../persistence/exposureBandCorrections.js';

/**
 * THE PROOFS OF THE BAND CORRECTION — brick 2 of the constrained-exposure pilot.
 *
 * No network, no database, no LLM, no clock. Everything is a fixture.
 *
 * Brick 1 proved WHETHER the band bites and by how much. This proves WHICH LINE absorbs it,
 * which is where §3.5, §3.6 and the precedence contract actually live.
 *
 * ── THE CASES THAT MUST PASS COUNT AS MUCH AS THE ONES THAT MUST BLOCK ─────────────────
 *
 * A correction that bit on every cycle would turn the pilot into a permanent forced
 * intervention, and this project has already had a failure of that family. So the untouched
 * cases — a target inside its band, a line the correction has no reason to move, a model leg
 * the correction must not disturb — are proven as deliberately as the blocked ones.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

const ROOT = process.cwd();
const RESERVE = 'USDT';
const CAPS: Record<string, number> = { BTC: 35, ETH: 35, BNB: 20, XRP: 15 };
const capOf = (asset: string): number => CAPS[asset] ?? 15;

// ── fixtures ─────────────────────────────────────────────────────────────────────────

/** Every price is 100, so a point of equity is a point of price — the arithmetic stays legible. */
const priceOf: PriceLookup = (asset) => (asset === RESERVE ? dec(1) : dec(100));

/**
 * A book holding `weights` percent of `equity` on each line, the rest in cash.
 *
 * The book matters as much as the target here: `computeMovements` sizes every leg as
 * `target − book`, so a correction's leg is only as big as the DISTANCE it has to travel.
 */
function bookOf(weights: Record<string, number>, equity = 1000): VirtualPortfolio {
  const positions = Object.entries(weights).map(([asset, weightPercent]) => {
    const value = (equity * weightPercent) / 100;
    return {
      asset,
      qty: dec(value / 100),
      avgCost: dec(100),
      price: dec(100),
      priceStale: false,
      value: dec(value),
      unrealizedPnl: dec(0),
      weightPercent: dec(weightPercent),
    };
  });
  const deployed = Object.values(weights).reduce((a, b) => a + b, 0);
  return {
    reserveAsset: RESERVE,
    startingCapital: dec(equity),
    cash: dec((equity * (100 - deployed)) / 100),
    positions,
    equity: dec(equity),
    deployedPercent: dec(deployed),
    realizedPnl: dec(0),
    unrealizedPnl: dec(0),
    totalPnl: dec(0),
  };
}

function gates(map: Record<string, TransitionGate>): Map<string, TransitionGate> {
  return new Map(Object.entries(map));
}

const ALL_ACTIONABLE = gates({ BTC: 'actionable', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' });

/** Builds the assessment + the correction for one scenario, through the real functions. */
function correct(opts: {
  state: 'defensive' | 'neutral' | 'constructive';
  target: Record<string, number>;
  book?: Record<string, number>;
  gates?: Map<string, TransitionGate>;
  equity?: number;
  raw?: Record<string, number> | null;
}): CorrectionOutcome {
  const equity = opts.equity ?? 1000;
  const portfolio = bookOf(opts.book ?? {}, equity);
  const gateByAsset = opts.gates ?? ALL_ACTIONABLE;
  const target = { ...opts.target };
  const exposure = Object.entries(target)
    .filter(([a]) => a !== RESERVE)
    .reduce((sum, [, w]) => sum + w, 0);
  target[RESERVE] = 100 - exposure;

  const assessInput: AssessBandInput = {
    policyVersion: config.exposureBand.version,
    policy: config.exposureBand,
    state: opts.state,
    targetAllocation: target,
    rawAllocation: opts.raw ?? null,
    bookExposurePercent: portfolio.deployedPercent.toNumber(),
    reserveAsset: RESERVE,
    gateByAsset,
    capOf,
    maxDeployablePercent: 100 - config.execution.caps.minCashPercent,
    equityQuote: equity,
    movementFloorQuote: (equity * config.execution.minMovementPercent) / 100,
    stoppedWeightSurvives: true,
  };
  const assessment = assessBand(assessInput);

  const input: CorrectInput = {
    assessment,
    clampedAllocation: target,
    rawAllocation: opts.raw ?? null,
    reserveAsset: RESERVE,
    portfolio,
    priceOf,
    feePercent: config.execution.feePercent,
    minMovementPercent: config.execution.minMovementPercent,
  };
  return correctToBand(input);
}

function weightOf(outcome: CorrectionOutcome, asset: string): number {
  return outcome.lines.find((l) => l.asset === asset)?.correctedWeightPercent ?? 0;
}
function lineOf(outcome: CorrectionOutcome, asset: string) {
  return outcome.lines.find((l) => l.asset === asset)!;
}
/**
 * Percentage comparison, to 1e-5 of a point.
 *
 * Weights are published rounded to six decimals per line, so a sum over three or four lines
 * carries up to a few units in the sixth — an equal split of 20 points over three lines is
 * exactly that case. On a $1000 book, 1e-5 of a point is a hundredth of a cent, which is
 * immaterial by several orders of magnitude; the allocation's own consistency (it sums to
 * exactly 100) is asserted separately in Proof 10 and is the property that actually matters.
 */
function near(a: number, b: number, tol = 1e-5): boolean {
  return Math.abs(a - b) <= tol;
}

/**
 * The same comparison, widened by what the plan's own fee costs in exposure points.
 *
 * Any number computed from what the book would REALLY hold carries the fee: the buy budget is
 * divided by (1 + fee) and every leg's fee comes off equity. Asserting those to the sixth
 * decimal would be asserting that trading is free. `feeDragPoints` publishes the amount, so
 * the tolerance is a number the outcome itself declares rather than one chosen here.
 */
function nearNetOfFee(actual: number, expected: number, outcome: CorrectionOutcome): boolean {
  return Math.abs(actual - expected) <= outcome.feeDragPoints + 1e-5;
}

// ── PROOF 1 — the cases that must pass ──────────────────────────────────────────────
console.log('Proof 1 — a target inside its band is not touched, and neither are its lines:');
{
  const inside = correct({
    state: 'constructive',
    target: { BTC: 30, ETH: 20, BNB: 0, XRP: 0 },
    book: { BTC: 30, ETH: 20 },
  });
  ok('the label is aucune_correction', inside.label === 'aucune_correction');
  ok('no line moved', inside.lines.every((l) => l.correctionPoints === 0));
  ok('every line keeps the model as its origin', inside.lines.every((l) => l.origin === 'modele'));
  ok('the corrected exposure IS the target', inside.correctedExposurePercent === 50);
  ok('nothing is unrealisable', inside.unrealisablePoints === 0);
  ok('and no consolidation was attempted', !inside.consolidated && inside.consolidationRounds === 0);

  // A NEUTRAL target the model is already holding: the quiet cycle, which must produce no
  // movement at all. If the band generated turnover here it would be paying fees to stand
  // still, on the majority of cycles.
  const quiet = correct({
    state: 'neutral',
    target: { BTC: 20, ETH: 10, BNB: 0, XRP: 0 },
    book: { BTC: 20, ETH: 10 },
  });
  ok('a neutral target the book already holds generates NO movement', quiet.movements.length === 0);
  // Nothing is REFUSED either. The lines whose target already equals their book are recorded
  // as `dust` — there was nothing to do, and saying so is what makes the suppression
  // accounting exhaustive rather than merely mostly-populated.
  ok(
    'and nothing is refused by the floor or by a missing price',
    quiet.suppressed.every((leg) => leg.reason === 'dust'),
  );
}

// ── PROOF 2 — §3.5.1, proportional to the model's own convictions ──────────────────
console.log('\nProof 2 — §3.5.1: the deficit goes first to the model\'s positive targets, pro rata:');
{
  // Constructive floor 45, target 20 → deficit 25, shared 15:5.
  const out = correct({
    state: 'constructive',
    target: { BTC: 15, ETH: 5, BNB: 0, XRP: 0 },
    book: { BTC: 15, ETH: 5 },
  });
  ok('the floor is reached exactly', near(out.correctedExposurePercent, 45));
  ok('BTC takes three quarters of the deficit (15/20)', near(weightOf(out, 'BTC'), 33.75));
  ok('ETH takes one quarter (5/20)', near(weightOf(out, 'ETH'), 11.25));
  ok('the lines the model left at zero stay at zero', weightOf(out, 'BNB') === 0 && weightOf(out, 'XRP') === 0);
  ok('both moved lines are labelled correction_de_bande', lineOf(out, 'BTC').origin === 'correction_de_bande' && lineOf(out, 'ETH').origin === 'correction_de_bande');
  ok('NO line is labelled allocation_de_secours — the model\'s conviction sufficed', out.lines.every((l) => l.origin !== 'allocation_de_secours'));
  ok('the label is hausse_vers_plancher', out.label === 'hausse_vers_plancher');
  // THE BOOK LANDS JUST UNDER THE FLOOR, AND THAT IS NOT A SHORTFALL.
  //
  // Moving costs money and the cost lands on the exposure itself: the buy budget is divided by
  // (1 + fee), so a 25-point correction delivers about 24.99 of them. A projection of least
  // change cannot ask for more than the bound to pay for its own execution, so a residual no
  // larger than the fee is the price of the move — not a band that could not be reached.
  ok('nothing is journaled as unrealisable', out.unrealisablePoints === 0);
  ok('the label stays a clean correction', out.label === 'hausse_vers_plancher');
  ok('but the BOOK lands a shade under the floor', out.realisedExposurePercent < 45);
  ok(
    'and the whole shortfall is the fee, to the point',
    45 - out.realisedExposurePercent <= out.feeDragPoints + 1e-9,
  );
  ok('which is published rather than absorbed', out.feeDragPoints > 0);
}

// ── PROOF 3 — §3.5.2, caps bound the pass and the excess is re-poured ─────────────
console.log('\nProof 3 — §3.5.2: a cap clips a line and its excess goes to the others, not away:');
{
  // 18:2 pro rata of 25 would give BTC +22.5 → 40.5, above its 35 cap. It is clipped at 35
  // (+17), and the 5.5 it could not take is re-poured on ETH.
  const out = correct({
    state: 'constructive',
    target: { BTC: 18, ETH: 2, BNB: 0, XRP: 0 },
    book: { BTC: 18, ETH: 2 },
  });
  ok('BTC stops exactly at its 35 cap', near(weightOf(out, 'BTC'), 35));
  ok('ETH absorbs both its share and the clipped excess', near(weightOf(out, 'ETH'), 10));
  ok('the floor is still reached — the excess was re-poured, not dropped', near(out.correctedExposurePercent, 45));
  ok('BTC names the cap as its cause', lineOf(out, 'BTC').cause === 'plafond_individuel');
  ok('ETH has nothing stopping it', lineOf(out, 'ETH').cause === 'aucune');
}

// ── PROOF 4 — §3.5.3 and §3.5.4, the equal-weight rescue ──────────────────────────
console.log('\nProof 4 — §3.5.3/4: what conviction cannot supply is split equally, and labelled:');
{
  // BTC alone, at 20, capped at 35 → pass 1 can only add 15. The remaining 10 goes equally to
  // the three lines the model gave nothing to.
  const out = correct({
    state: 'constructive',
    target: { BTC: 20, ETH: 0, BNB: 0, XRP: 0 },
    book: { BTC: 20 },
  });
  ok('BTC is lifted to its cap by the proportional pass', near(weightOf(out, 'BTC'), 35));
  ok('the remaining 10 points are split equally, 3.33 each', near(weightOf(out, 'ETH'), 10 / 3) && near(weightOf(out, 'BNB'), 10 / 3) && near(weightOf(out, 'XRP'), 10 / 3));
  ok('the floor is reached', near(out.correctedExposurePercent, 45));
  ok('BTC keeps correction_de_bande — its weight started from the model\'s conviction', lineOf(out, 'BTC').origin === 'correction_de_bande');
  for (const asset of ['ETH', 'BNB', 'XRP']) {
    ok(
      `${asset} is labelled allocation_de_secours — the model expressed nothing there`,
      lineOf(out, asset).origin === 'allocation_de_secours',
    );
  }
}

// ── PROOF 5 — the precedence contract, clause by clause ───────────────────────────
console.log('\nProof 5 — §3.4: the transition gate wins over BOTH bounds:');
{
  // (a) A FROZEN LINE IS NEITHER RAISED...
  const frozenUp = correct({
    state: 'constructive',
    target: { BTC: 10, ETH: 10, BNB: 0, XRP: 0 },
    book: { BTC: 10, ETH: 10 },
    gates: gates({ BTC: 'frozen', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' }),
  });
  ok('[gel — hausse] the frozen line is left exactly where the model put it', weightOf(frozenUp, 'BTC') === 10);
  ok('its cause names the freeze', lineOf(frozenUp, 'BTC').cause === 'gel');
  ok('the deficit went to the actionable lines instead', weightOf(frozenUp, 'ETH') > 10);
  ok('and the floor is still reached', near(frozenUp.correctedExposurePercent, 45));

  // (b) ...NOR REDUCED.
  const frozenDown = correct({
    state: 'neutral',
    target: { BTC: 35, ETH: 25, BNB: 0, XRP: 0 },
    book: { BTC: 35, ETH: 25 },
    gates: gates({ BTC: 'frozen', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' }),
  });
  ok('[gel — baisse] the frozen line keeps its 35 even above the ceiling', weightOf(frozenDown, 'BTC') === 35);
  ok('the reducible line absorbs the whole reduction', near(weightOf(frozenDown, 'ETH'), 10));
  ok('the ceiling is reached', near(frozenDown.correctedExposurePercent, 45));

  // (c) RISK_OFF LIFTS THE FREEZE FOR REDUCTIONS ONLY — the one direction a transition must
  // never be able to block is the book getting smaller.
  const riskOff = correct({
    state: 'defensive',
    target: { BTC: 25, ETH: 15, BNB: 0, XRP: 0 },
    book: { BTC: 25, ETH: 15 },
    gates: gates({ BTC: 'risk_off_reduction', ETH: 'risk_off_reduction', BNB: 'risk_off_reduction', XRP: 'risk_off_reduction' }),
  });
  ok('[risk_off] the defensive ceiling of 20 is reached', near(riskOff.correctedExposurePercent, 20));
  ok('both lines are scaled down proportionally (25:15 of 20)', near(weightOf(riskOff, 'BTC'), 12.5) && near(weightOf(riskOff, 'ETH'), 7.5));
  ok('nothing is unrealisable', riskOff.unrealisablePoints === 0);

  // (d) A CONFIRMED RISK_OFF MAY NOT BUY. If the band ever asked for an increase there, the
  // capability map refuses it — an increase under a global de-risk is the one thing the
  // ladder's rung 2 explicitly does not licence.
  const riskOffUp = correct({
    state: 'constructive',
    target: { BTC: 10, ETH: 10, BNB: 0, XRP: 0 },
    book: { BTC: 10, ETH: 10 },
    gates: gates({ BTC: 'risk_off_reduction', ETH: 'risk_off_reduction', BNB: 'risk_off_reduction', XRP: 'risk_off_reduction' }),
  });
  ok('[risk_off — hausse] no line may be raised', riskOffUp.lines.every((l) => l.correctionPoints <= 0));
  ok('so the whole 25 points are journaled as out of reach', near(riskOffUp.unrealisablePoints, 25));
  ok('and the cycle is labelled irrealisable rather than silently corrected', riskOffUp.label === 'bande_partiellement_irrealisable');

  // (e) `no_regime` FAILS CLOSED — absence of a reading is not permission.
  const noRegime = correct({
    state: 'constructive',
    target: { BTC: 10, ETH: 10, BNB: 0, XRP: 0 },
    book: { BTC: 10, ETH: 10 },
    gates: gates({ BTC: 'no_regime', ETH: 'no_regime', BNB: 'no_regime', XRP: 'no_regime' }),
  });
  ok('[no_regime] nothing is touched', noRegime.lines.every((l) => l.correctionPoints === 0));
  ok('and the shortfall is the whole deficit', near(noRegime.unrealisablePoints, 25));
}

// ── PROOF 6 — §3.4.4 and §3.5.6, the shortfall is executed and journaled ─────────
console.log('\nProof 6 — §3.4.4: the maximum feasible runs, the gap is journaled, no freeze is lifted:');
{
  // Only XRP (cap 15) may rise, from 0. The floor of 45 needs 25 points and 15 exist.
  const out = correct({
    state: 'constructive',
    target: { BTC: 10, ETH: 10, BNB: 0, XRP: 0 },
    book: { BTC: 10, ETH: 10 },
    gates: gates({ BTC: 'frozen', ETH: 'frozen', BNB: 'frozen', XRP: 'actionable' }),
  });
  ok('XRP is taken to its cap — the maximum feasible really runs', near(weightOf(out, 'XRP'), 15));
  ok('the frozen lines are untouched', weightOf(out, 'BTC') === 10 && weightOf(out, 'ETH') === 10);
  ok('the corrected exposure is 35, not 45', near(out.correctedExposurePercent, 35));
  ok('the 10-point gap is journaled', nearNetOfFee(out.unrealisablePoints, 10, out));
  ok('and the label says so', out.label === 'bande_partiellement_irrealisable');

  // §3.6.3 — the frozen lines exceed the ceiling on their own. Every authorised reduction
  // still runs, all the way to zero, and the residue is journaled.
  const overCeiling = correct({
    state: 'neutral',
    target: { BTC: 35, ETH: 20, BNB: 5, XRP: 0 },
    book: { BTC: 35, ETH: 20, BNB: 5 },
    gates: gates({ BTC: 'frozen', ETH: 'frozen', BNB: 'actionable', XRP: 'actionable' }),
  });
  ok('[lignes gelées au-dessus du plafond] the reducible line goes to ZERO, not part-way', weightOf(overCeiling, 'BNB') === 0);
  ok('the frozen 55 stands', near(overCeiling.correctedExposurePercent, 55));
  ok('the 10-point overshoot is journaled', nearNetOfFee(overCeiling.unrealisablePoints, 10, overCeiling));
  ok('labelled irrealisable', overCeiling.label === 'bande_partiellement_irrealisable');
}

// ── PROOF 7 — §3.5.5, the consolidation ─────────────────────────────────────────
console.log('\nProof 7 — §3.5.5: a distribution the 2% floor would delete is consolidated instead:');
{
  // Equity 1000 → the floor is 20 quote = 2 points. The book already holds the model's target,
  // so the ONLY legs are the correction's own. A 3-point deficit spread over three lines gives
  // legs of 10.6, 10.6 and 8.8 quote — all deleted. Concentrated on one, it is 30 quote.
  const out = correct({
    state: 'neutral',
    target: { BTC: 6, ETH: 6, BNB: 5, XRP: 0 },
    book: { BTC: 6, ETH: 6, BNB: 5 },
  });
  ok('the target reaches the floor', near(out.correctedExposurePercent, 20));
  ok('consolidation fired', out.consolidated);
  ok('and it landed on ONE line rather than three', out.lines.filter((l) => l.correctionPoints > 0).length === 1);
  ok('it kept the highest-conviction line, BTC', lineOf(out, 'BTC').correctionPoints > 0);
  ok('that line clears the floor', out.movements.length === 1 && out.movements[0]!.notional.gt(dec(20)));
  ok('so the book really reaches the floor, net of the fee it paid to get there', nearNetOfFee(out.realisedExposurePercent, 20, out));
  ok('with nothing left unrealisable', out.unrealisablePoints === 0);

  // THE PROOF THAT THIS IS NOT COSMETIC: without consolidation the same deficit spread over
  // three lines produces three sub-floor legs and moves NOTHING. Run the plan by hand on the
  // naive allocation to show the failure the rule exists to prevent.
  const naive = planMovements(
    bookOf({ BTC: 6, ETH: 6, BNB: 5 }),
    { BTC: 6 + 18 / 17, ETH: 6 + 18 / 17, BNB: 5 + 15 / 17, USDT: 80 },
    priceOf,
    config.execution.feePercent,
    config.execution.minMovementPercent,
  );
  ok('the naive spread sends NO movement at all', naive.movements.length === 0);
  ok('and the floor deletes all three legs', naive.suppressed.length === 3 && naive.suppressed.every((s) => s.reason === 'movement_floor'));
  ok('which is exactly the "target that moves nothing" §3.5.5 forbids', naive.movements.length === 0 && out.movements.length > 0);

  // ── THE LIMIT OF THE RULE, AND IT IS A REAL MECHANICAL ONE ────────────────────────
  //
  // A deficit worth about ONE movement floor cannot be saved by any amount of concentrating:
  // the buy budget is split then divided by (1 + fee), so a leg sized at exactly 2 points of a
  // 1000 book arrives at 19.98 against a floor of 20.00. Every narrowing is tried, none helps,
  // and the honest outcome is a 2-point gap rather than a target that pretends to move.
  const atTheFloor = correct({
    state: 'neutral',
    target: { BTC: 6, ETH: 6, BNB: 6, XRP: 0 },
    book: { BTC: 6, ETH: 6, BNB: 6 },
  });
  ok('a deficit of exactly one floor: the target still reaches the bound', near(atTheFloor.correctedExposurePercent, 20));
  // Four candidates, not three: XRP sits at zero weight and is still eligible for the rescue
  // pass, so it is one of the lines the narrowing sheds first.
  ok('every narrowing was evaluated', atTheFloor.consolidationAttempts === 4);
  ok('none of them helped, so none is claimed', !atTheFloor.consolidated);
  ok('no movement is sent', atTheFloor.movements.length === 0);
  ok('and the 2-point gap is journaled rather than hidden', near(atTheFloor.unrealisablePoints, 2) && near(atTheFloor.realisedExposurePercent, 18));
  ok('with no fee to blame — nothing moved at all', atTheFloor.feeDragPoints === 0);
  ok('the label reports it', atTheFloor.label === 'bande_partiellement_irrealisable');

  // NARROWING SHEDS THE RESCUE LINES FIRST. The model's convictions are the last thing given
  // up, so consolidation costs as little of its expressed preference as possible.
  const keepsConviction = correct({
    state: 'neutral',
    target: { BTC: 17, ETH: 0, BNB: 0, XRP: 0 },
    book: { BTC: 17 },
  });
  ok('a 3-point deficit on a single conviction line lands on that line', near(weightOf(keepsConviction, 'BTC'), 20));
  ok('no rescue line was needed', keepsConviction.lines.every((l) => l.origin !== 'allocation_de_secours'));
}

// ── PROOF 8 — §3.3, the four facts are separable ────────────────────────────────
console.log('\nProof 8 — §3.3: the target and what the book really holds are different numbers:');
{
  // A 1-point deficit that no consolidation can save: one point of a 1000 book is 10 quote,
  // half the floor. The target reaches the bound; the book does not.
  const out = correct({
    state: 'neutral',
    target: { BTC: 19, ETH: 0, BNB: 0, XRP: 0 },
    book: { BTC: 19 },
  });
  ok('FACT 3 — the corrected target reaches the floor', near(out.correctedExposurePercent, 20));
  ok('FACT 4 — the book does NOT: the leg is under the floor', near(out.realisedExposurePercent, 19));
  ok('the two are published separately, never collapsed', out.correctedExposurePercent !== out.realisedExposurePercent);
  ok('the shortfall is measured on the BOOK, not on the target', nearNetOfFee(out.unrealisablePoints, 1, out));
  // The floor-deleted leg is picked out by its REASON, not by its position in the list: the
  // lines that had nothing to do are recorded too, as `dust`, so the list is no longer a
  // singleton and an index would be reading whichever line happened to sort first.
  const deleted = out.suppressed.filter((leg) => leg.reason === 'movement_floor');
  ok('the deleted leg stays visible', deleted.length === 1 && deleted[0]!.asset === 'BTC');
  ok('and it names the floor as its reason', deleted[0]!.reason === 'movement_floor');
  ok('the line names the plumbing as its cause', lineOf(out, 'BTC').cause === 'seuil_de_mouvement');
  ok('while the label reports the band as partially unrealisable', out.label === 'bande_partiellement_irrealisable');

  // FACT 1 travels untouched: the raw proposal is carried, never used as an operand.
  const withRaw = correct({
    state: 'constructive',
    target: { BTC: 15, ETH: 5, BNB: 0, XRP: 0 },
    book: { BTC: 15, ETH: 5 },
    raw: { BTC: 15, ETH: 5, BNB: 0, XRP: 0, USDT: 80 },
  });
  ok('FACT 1 — every line carries the model\'s raw weight', lineOf(withRaw, 'BTC').rawWeightPercent === 15);
  ok('FACT 2 — and the signed points the band added', near(lineOf(withRaw, 'BTC').correctionPoints, 18.75));
  ok('facts 1 + 2 reconstruct fact 3 exactly', near(lineOf(withRaw, 'BTC').clampedWeightPercent + lineOf(withRaw, 'BTC').correctionPoints, lineOf(withRaw, 'BTC').correctedWeightPercent));
}

// ── PROOF 9 — the correction never disturbs what the model itself asked ─────────
console.log('\nProof 9 — the correction adds to the model\'s legs, it does not replace them:');
{
  // The model wants to buy ETH (book 0, target 10). The band lifts the whole vector. The ETH
  // leg must still be there, bigger — never suppressed by the correction's arrival.
  const out = correct({
    state: 'constructive',
    target: { BTC: 10, ETH: 10, BNB: 0, XRP: 0 },
    book: { BTC: 20, ETH: 0 },
  });
  const eth = out.movements.find((m) => m.asset === 'ETH');
  ok('the model\'s ETH buy survives the correction', eth != null && eth.side === 'buy');
  ok('and it is BIGGER than the 10 points the model asked for', eth!.notional.gt(dec(100)));

  // A SELL the model asked for is not turned into a buy by a floor correction: the band moves
  // the total, and a line the model wants smaller than the book stays a sell unless the
  // correction genuinely lifts it past the book.
  const trim = correct({
    state: 'neutral',
    target: { BTC: 30, ETH: 5, BNB: 0, XRP: 0 },
    book: { BTC: 30, ETH: 20 },
  });
  ok('a target inside the band leaves the model\'s trim alone', trim.label === 'aucune_correction');
  const ethTrim = trim.movements.find((m) => m.asset === 'ETH');
  ok('and the ETH sell is exactly what the model asked for', ethTrim != null && ethTrim.side === 'sell' && ethTrim.notional.eq(dec(150)));
}

// ── PROOF 10 — the allocation stays an allocation ──────────────────────────────
console.log('\nProof 10 — the corrected allocation is still a well-formed one:');
{
  const cases: Array<[string, CorrectionOutcome]> = [
    ['inside the band', correct({ state: 'constructive', target: { BTC: 30, ETH: 20 }, book: { BTC: 30, ETH: 20 } })],
    ['lifted to the floor', correct({ state: 'constructive', target: { BTC: 15, ETH: 5 }, book: { BTC: 15, ETH: 5 } })],
    ['rescued', correct({ state: 'constructive', target: { BTC: 20 }, book: { BTC: 20 } })],
    ['trimmed to the ceiling', correct({ state: 'neutral', target: { BTC: 35, ETH: 25 }, book: { BTC: 35, ETH: 25 } })],
    ['partly frozen', correct({ state: 'constructive', target: { BTC: 10, ETH: 10 }, book: { BTC: 10, ETH: 10 }, gates: gates({ BTC: 'frozen', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' }) })],
  ];
  for (const [label, outcome] of cases) {
    const sum = Object.values(outcome.correctedAllocation).reduce((a, b) => a + b, 0);
    ok(`${label}: the allocation still sums to 100`, near(sum, 100, 1e-6));
    ok(`${label}: no weight is negative`, Object.values(outcome.correctedAllocation).every((w) => w >= -1e-9));
    ok(
      `${label}: no line exceeds its cap`,
      outcome.lines.every((l) => l.correctedWeightPercent <= l.capPercent + 1e-9),
    );
    ok(
      `${label}: the reserve never falls under the ${config.execution.caps.minCashPercent}% floor`,
      outcome.correctedAllocation[RESERVE]! >= config.execution.caps.minCashPercent - 1e-6,
    );
  }
}

// ── PROOF 11 — pure, total, deterministic ─────────────────────────────────────
console.log('\nProof 11 — nothing here can fail a trading cycle:');
{
  const twice = [
    correct({ state: 'constructive', target: { BTC: 15, ETH: 5 }, book: { BTC: 15, ETH: 5 } }),
    correct({ state: 'constructive', target: { BTC: 15, ETH: 5 }, book: { BTC: 15, ETH: 5 } }),
  ];
  ok('the correction is deterministic', JSON.stringify(twice[0]) === JSON.stringify(twice[1]));

  // Degenerate inputs are answers, not crashes.
  const allCash = correct({ state: 'neutral', target: {}, book: {} });
  ok('an all-cash target with an empty book is answered, not thrown', allCash.label !== undefined);
  ok('and the rescue lines supply the floor', near(allCash.correctedExposurePercent, 20));

  const noLines = correct({
    state: 'constructive',
    target: { BTC: 10, ETH: 10 },
    book: { BTC: 10, ETH: 10 },
    gates: new Map(),
  });
  ok('no verdict at all means nothing may move', noLines.lines.every((l) => l.correctionPoints === 0));
  ok('and the whole deficit is journaled', near(noLines.unrealisablePoints, 25));

  // THE MODULE GRAPH: pure means pure. Neither the corrector nor the band may reach a query.
  const graph = moduleGraph(path.join(ROOT, 'src/exposure/correct.ts'));
  const writers = [...graph].filter((file) =>
    /\.(insert|upsert|update|delete|rpc)\s*\(|\.from\('/.test(readFileSync(file, 'utf8')),
  );
  ok(
    `the corrector's graph can build no query at all (${writers.map((f) => path.basename(f)).join(', ') || 'none'})`,
    writers.length === 0,
  );
}

// ── PROOF 12 — the floor rule exists exactly once ─────────────────────────────
console.log('\nProof 12 — the correction applies the executor\'s own floor, not a copy of it:');
{
  const movements = readFileSync(path.join(ROOT, 'src/execution/movements.ts'), 'utf8');
  ok(
    'computeMovements is a thin wrapper over planMovements',
    /export function computeMovements\([\s\S]{0,400}?return planMovements\(/.test(movements),
  );
  ok(
    'the floor predicate is named in exactly one place',
    [...movements.matchAll(/export function isBelowFloor/g)].length === 1,
  );
  const corrector = readFileSync(path.join(ROOT, 'src/exposure/correct.ts'), 'utf8');
  ok(
    'and the corrector never re-implements it — it calls planMovements',
    corrector.includes('planMovements(') && !/isBelowFloor|minMovementPercent\s*\)\s*\/\s*100/.test(corrector.replace(/minMovementPercent: input\.minMovementPercent|minMovementPercent: number/g, '')),
  );
}

// ── PROOF 13 — brick 2 does not touch the order path ──────────────────────────
//
// The correction exists, it is computed on every cycle, and NOTHING sends it. That is the
// whole safety claim of this brick, and it is structural rather than promised: `correctToBand`
// is called from inside the observation closure, which runs after the orders are placed and
// returns void. Moving it up to the risk clamp — where it will eventually have to live — is
// the last brick's job, and it should be one reviewable diff rather than something that has
// quietly already happened.
console.log('\nProof 13 — the correction is computed and nothing sends it:');
{
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8');

  // (a) EXACTLY ONE CALL SITE, and it is inside the observation closure.
  const calls = [...decide.matchAll(/correctToBand\(\{/g)];
  ok('correctToBand is called exactly once in decide()', calls.length === 1);
  const closureStart = decide.indexOf('const observeExposureBand');
  const closureEnd = decide.indexOf('// The AI sees the virtual book');
  ok(
    'and that call sits inside the observation closure',
    calls[0]!.index! > closureStart && calls[0]!.index! < closureEnd,
  );

  // (b) THE ORDER PATH STILL READS THE GUARD'S OWN MOVEMENTS. If the correction ever reached
  // the executor it would have to pass through here, and this is the line that would change.
  ok(
    'the executed vector still comes from the guard-evaluated movements',
    /const \{ clamp, movements: proposedMovements \} = evaluated;/.test(decide),
  );
  ok(
    'and the gate is still judged on those, not on a corrected vector',
    /judgeVector\(\s*proposedMovements\.map/.test(decide),
  );
  ok(
    'no corrected allocation is ever handed to computeMovements',
    !/computeMovements\([^)]*correct/i.test(decide),
  );
  ok(
    'nor to applyGate',
    !/applyGate\(\{[\s\S]{0,600}?correct/i.test(decide),
  );

  // (c) THE CORRECTION RUNS AFTER EXECUTION. Same tier as every other observational write.
  ok(
    'the single call site is after executeMovements in the file',
    decide.indexOf('await executeMovements(') < decide.lastIndexOf('await observeExposureBand({'),
  );
}

// ── PROOF 14 — the rows satisfy what the database will check ─────────────────
//
// The writer is best-effort by design: a row the constraints reject fails silently, forever,
// with only a log line. The two constraints that encode the journal's meaning — the facts must
// reconcile, and an untouched line must carry the model's origin — are therefore asserted here
// too, offline, on every scenario the other proofs build.
console.log('\nProof 14 — every row satisfies the constraints the migration declares:');
{
  const scenarios: Array<[string, CorrectionOutcome]> = [
    ['untouched', correct({ state: 'constructive', target: { BTC: 30, ETH: 20 }, book: { BTC: 30, ETH: 20 } })],
    ['lifted', correct({ state: 'constructive', target: { BTC: 15, ETH: 5 }, book: { BTC: 15, ETH: 5 } })],
    ['rescued', correct({ state: 'constructive', target: { BTC: 20 }, book: { BTC: 20 } })],
    ['trimmed', correct({ state: 'neutral', target: { BTC: 35, ETH: 25 }, book: { BTC: 35, ETH: 25 } })],
    ['consolidated', correct({ state: 'neutral', target: { BTC: 6, ETH: 6, BNB: 5 }, book: { BTC: 6, ETH: 6, BNB: 5 } })],
    ['frozen', correct({ state: 'constructive', target: { BTC: 10, ETH: 10 }, book: { BTC: 10, ETH: 10 }, gates: gates({ BTC: 'frozen', ETH: 'frozen', BNB: 'actionable', XRP: 'actionable' }) })],
  ];

  for (const [label, outcome] of scenarios) {
    const rows = toCorrectionRows({
      decisionId: 1,
      correction: outcome,
      gateByAsset: ALL_ACTIONABLE,
      bookedLedger: [],
      portfolioAfter: null,
    });
    ok(`${label}: one row per line`, rows.length === outcome.lines.length);
    ok(
      `${label}: facts 2 and 3 reconcile (the migration's CHECK)`,
      rows.every((r) => Math.abs(r.clamped_weight_percent + r.correction_points - r.corrected_weight_percent) < 1e-6),
    );
    ok(
      `${label}: an untouched line carries the model's origin, and only it (the migration's CHECK)`,
      rows.every((r) => (r.correction_points === 0) === (r.origin === 'modele')),
    );
    ok(
      `${label}: every origin and cause is one the constraint allows`,
      rows.every(
        (r) =>
          ['modele', 'correction_de_bande', 'allocation_de_secours'].includes(r.origin) &&
          ['aucune', 'gel', 'plafond_individuel', 'seuil_de_mouvement', 'autre_impossibilite'].includes(r.cause),
      ),
    );
  }

  // FACT 4 comes from the REAL cycle, and is null when there was none — never a fabricated
  // zero, which would be indistinguishable from a line that really went flat.
  const outcome = correct({ state: 'constructive', target: { BTC: 15, ETH: 5 }, book: { BTC: 15, ETH: 5 } });
  const noExecution = toCorrectionRows({
    decisionId: 1,
    correction: outcome,
    gateByAsset: ALL_ACTIONABLE,
    bookedLedger: [],
    portfolioAfter: null,
  });
  ok('with no execution, fact 4 is null rather than zero', noExecution.every((r) => r.post_cycle_weight_percent === null && r.booked_side === null));

  const withExecution = toCorrectionRows({
    decisionId: 1,
    correction: outcome,
    gateByAsset: ALL_ACTIONABLE,
    bookedLedger: [],
    portfolioAfter: bookOf({ BTC: 12 }),
  });
  ok('with a post-trade book, a line it does not mention is a real zero', withExecution.find((r) => r.asset === 'ETH')?.post_cycle_weight_percent === 0);
  ok('and one it does mention carries its weight', withExecution.find((r) => r.asset === 'BTC')?.post_cycle_weight_percent === 12);
}

// ── PROOF 15 — the three defects the first review round found ────────────────
//
// Each was unreachable while `TRANSITION_MODE=observe`, and each became reachable the moment
// the gate is armed — which is a planned step. They are grouped here so the regression is one
// block rather than three scattered assertions.
console.log('\nProof 15 — the three enforce-mode defects, and their fixes:');
{
  // (a) A STOPPED LINE MUST STILL RECONCILE.
  //
  // Under `enforce`, `applyGate` takes a peak-stopped line to zero, so the correction sizes
  // itself against that zero while the model's clamped weight is still 20. Publishing the
  // clamped weight as the base produced (20, +0, 0) — which violates the migration's CHECK,
  // and because the rows go up as ONE batch, that single line silently destroyed the whole
  // cycle's correction journal.
  const equity = 1000;
  const portfolio = bookOf({ BTC: 20, ETH: 10 }, equity);
  const target = { BTC: 20, ETH: 10, BNB: 0, XRP: 0, USDT: 70 };
  const stopped = gates({ BTC: 'stop_exit', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' });
  const assessment = assessBand({
    policyVersion: 'A',
    policy: config.exposureBand,
    state: 'constructive',
    targetAllocation: target,
    rawAllocation: null,
    bookExposurePercent: 30,
    reserveAsset: RESERVE,
    gateByAsset: stopped,
    capOf,
    maxDeployablePercent: 70,
    equityQuote: equity,
    movementFloorQuote: (equity * config.execution.minMovementPercent) / 100,
    // ENFORCE: the stop is about to flatten BTC, so the chain will pursue 0 there.
    stoppedWeightSurvives: false,
  });
  const outcome = correctToBand({
    assessment,
    clampedAllocation: target,
    rawAllocation: null,
    reserveAsset: RESERVE,
    portfolio,
    priceOf,
    feePercent: config.execution.feePercent,
    minMovementPercent: config.execution.minMovementPercent,
  });
  const btc = outcome.lines.find((l) => l.asset === 'BTC')!;
  ok('[stop_exit] the clamped weight is still the model\'s 20', btc.clampedWeightPercent === 20);
  ok('but the correction started from the 0 the stop imposes', btc.baseWeightPercent === 0);
  ok('and the two are published apart, never collapsed', btc.clampedWeightPercent !== btc.baseWeightPercent);

  const rows = toCorrectionRows({
    decisionId: 1,
    correction: outcome,
    gateByAsset: stopped,
    bookedLedger: [],
    portfolioAfter: null,
  });
  ok(
    'every row satisfies the migration CHECK, on the BASE',
    rows.every((r) => Math.abs(r.base_weight_percent + r.correction_points - r.corrected_weight_percent) < 1e-6),
  );
  ok(
    'and the same rows would have FAILED it on the clamped weight — the defect, restated',
    rows.some((r) => Math.abs(r.clamped_weight_percent + r.correction_points - r.corrected_weight_percent) >= 1e-6),
  );

  // (b) THE PLAN IS PRE-GATE, AND THAT IS THE CONTRACT — not an omission.
  //
  // A previous round filtered these legs by the correction's own capability map. That map
  // answers "what may the correction create", and the gate's rule for a leg is a different
  // question: `judgeOrder` EXEMPTS deterministic exits, so a stop-exit line's full-exit sell
  // always executes while both its capabilities read false. The filter dropped exactly that
  // leg — after `computeMovements` had sized the buys from the cash it was going to raise.
  //
  // One gate, in one place. `decide()` runs `judgeVector` then `applyGate` on whatever vector
  // it is about to execute; the correction records the gate's verdict per line and applies
  // none of it.
  const stopSell = outcome.movements.find((m) => m.asset === 'BTC');
  ok(
    '[stop_exit] the full-exit sell is IN the plan, not filtered away',
    stopSell != null && stopSell.side === 'sell',
  );
  ok(
    'and it is the whole line — the stop takes it to zero',
    stopSell != null && stopSell.notional.eq(dec(200)),
  );
  const correctSrc = readFileSync(path.join(ROOT, 'src/exposure/correct.ts'), 'utf8');
  // CALLS, not mentions: the header explains at length why the gate is not modelled here, and
  // an assertion that forbade the words would forbid the explanation.
  ok(
    'the corrector never calls a gate function',
    !/\b(judgeOrder|judgeVector|applyGate|isDeterministic)\s*\(/.test(correctSrc),
  );
  ok(
    'and imports nothing from the transition layer at all',
    !/from '\.\.\/transition\//.test(correctSrc),
  );
  ok(
    'and it takes no flag telling it what the gate would do',
    !/gateEnforces/.test(correctSrc),
  );
  const decideSrc = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8');
  ok(
    'while decide() still runs the real gate on the vector it executes',
    /judgeVector\(\s*proposedMovements\.map/.test(decideSrc) && /applyGate\(\{/.test(decideSrc),
  );

  // (c) THE REALISED EXPOSURE IS REPLAYED FROM THE NOTIONALS, not assumed from the target.
  //
  // A buy is sized from the cash budget and then divided by (1 + fee), and every leg's fee
  // comes off equity — so "this line moved" never means "this line reached its target".
  const lifted = correct({
    state: 'constructive',
    target: { BTC: 15, ETH: 5, BNB: 0, XRP: 0 },
    book: { BTC: 15, ETH: 5 },
  });
  ok('[frais] the corrected TARGET is exactly the floor', near(lifted.correctedExposurePercent, 45));
  ok('the realised book is strictly under it', lifted.realisedExposurePercent < 45);
  ok(
    'by exactly what the plan pays in fees, to the point',
    45 - lifted.realisedExposurePercent <= lifted.feeDragPoints + 1e-9,
  );
  ok('and the fee is published, not absorbed into the gap', lifted.feeDragPoints > 0);
  ok(
    'so no shortfall is claimed for a cost the projection cannot avoid',
    lifted.unrealisablePoints === 0 && lifted.label === 'hausse_vers_plancher',
  );
}

// ── PROOF 16 — the two defects the second review round found ─────────────────
console.log('\nProof 16 — a quiet cycle can still fail, and a lifted target is not a position:');
{
  // (a) "THE BAND ASKED FOR NOTHING" IS NOT "THE BOOK ENDED UP INSIDE THE BAND".
  //
  // A neutral 20% target is comfortably in [20, 45]. Held against a 19% book it produces a
  // one-point buy — $10 on a $1000 book — which the $20 floor deletes. The cycle ends holding
  // 19%, outside the band, and reporting a zero gap would hide exactly the plumbing failures
  // this pilot exists to count.
  const quietFailure = correct({
    state: 'neutral',
    target: { BTC: 20, ETH: 0, BNB: 0, XRP: 0 },
    book: { BTC: 19 },
  });
  ok('[cible dans la bande] the band asks for no correction', quietFailure.direction === 'none');
  ok('no line is touched', quietFailure.lines.every((l) => l.correctionPoints === 0));
  ok('the one-point buy is deleted by the floor', quietFailure.movements.length === 0);
  ok('so the book stays at 19%, outside the band', near(quietFailure.realisedExposurePercent, 19));
  ok('the gap is MEASURED, not assumed to be zero', near(quietFailure.unrealisablePoints, 1));
  ok(
    'and the label says the band was not reached',
    quietFailure.label === 'bande_partiellement_irrealisable',
  );

  // The ordinary quiet cycle must still be quiet: a book already inside the band, with no
  // correction due, reports nothing at all. If this flipped, every calm cycle would be a
  // failure and the label would stop meaning anything.
  const genuinelyQuiet = correct({
    state: 'neutral',
    target: { BTC: 25, ETH: 0, BNB: 0, XRP: 0 },
    book: { BTC: 25 },
  });
  ok('a book inside the band with nothing to do reports no gap', genuinelyQuiet.unrealisablePoints === 0);
  ok('and keeps the quiet label', genuinelyQuiet.label === 'aucune_correction');

  // (b) A LIFTED TARGET IS NOT A CREATED POSITION.
  //
  // The counter "how often would the model undo a position the corrector created" is
  // meaningless on a position that was never created. Membership has to be a HOLDINGS
  // difference between two executable plans, not a target delta.
  const inertLift = correct({
    state: 'neutral',
    target: { BTC: 19, ETH: 0, BNB: 0, XRP: 0 },
    book: { BTC: 19 },
  });
  const btcInert = lineOf(inertLift, 'BTC');
  ok('[lift inerte] the target IS lifted', btcInert.correctionPoints > 0);
  ok('but the leg is under the floor and nothing is sent', inertLift.movements.length === 0);
  ok('so the correction moves no holding, and says so', !btcInert.correctionMovesHolding);

  const realLift = correct({
    state: 'constructive',
    target: { BTC: 15, ETH: 5, BNB: 0, XRP: 0 },
    book: { BTC: 15, ETH: 5 },
  });
  ok('[lift réel] a 25-point correction does send legs', realLift.movements.length > 0);
  ok(
    'and every line it lifted reports a real holding change',
    realLift.lines.filter((l) => l.correctionPoints > 0).every((l) => l.correctionMovesHolding),
  );
  ok(
    'while the lines it left alone report none',
    realLift.lines.filter((l) => l.correctionPoints === 0).every((l) => !l.correctionMovesHolding),
  );
}

// ── PROOF 17 — a created position is smaller than the one asked for ──────────
//
// A PER-CYCLE FACT, and it stays for that reason. What a line would really hold after this
// cycle's plan is not what the plan asked for: the buy is sized from the cash budget and then
// divided by (1 + fee), and every leg's fee comes off equity. Any later reading of an imposed
// position — brick 3's witnesses first among them — has to start from the position created,
// never from the one requested.
console.log('\nProof 17 — a created position is smaller than the one asked for:');
{
  // (a) THE REALISED WEIGHT, PER LINE. The buy is sized from the cash budget and divided by
  // (1 + fee), so the position created is under the position asked for. Anything reasoning
  // about "did the model keep the imposed position" must compare against this, or a following
  // target sitting between the two reads as an undo while it is in fact maintaining it.
  const lifted = correct({
    state: 'constructive',
    target: { BTC: 15, ETH: 5, BNB: 0, XRP: 0 },
    book: { BTC: 15, ETH: 5 },
  });
  const btc = lineOf(lifted, 'BTC');
  ok('[poids réalisé] the corrected target is 33.75', near(btc.correctedWeightPercent, 33.75));
  ok('but the position really created is smaller', btc.realisedWeightPercent < btc.correctedWeightPercent);
  ok(
    'and the difference is the fee, not a rounding artefact',
    btc.correctedWeightPercent - btc.realisedWeightPercent <= lifted.feeDragPoints + 1e-5,
  );
  ok(
    'a line the correction never touched reports the book it keeps',
    near(lineOf(lifted, 'BNB').realisedWeightPercent, 0),
  );
  // The sum of the per-line realised weights IS the realised exposure — one arithmetic, two
  // granularities, so a reader can never find them disagreeing.
  const sum = lifted.lines.reduce((total, l) => total + l.realisedWeightPercent, 0);
  ok('the per-line realised weights sum to the realised exposure', near(sum, lifted.realisedExposurePercent));

}

// ── PROOF 19 — the last three findings ───────────────────────────────────────
console.log('\nProof 19 — an outcome may not contradict itself, and a cause may not be borrowed:');
{
  // (a) THE IN-BAND PATH RETURNS THE PLAN'S ALLOCATION, not the clamped input.
  //
  // Under `enforce` a peak-stopped line is already flat in the base weights — the chain will
  // pursue zero there whatever the model asked — so the plan builds an allocation with the line
  // at zero. Returning the clamped input instead handed back a vector still carrying the
  // stopped weight, contradicting the same outcome's movements, lines and exposure.
  const equity = 1000;
  const portfolio = bookOf({ BTC: 20, ETH: 35, BNB: 20 }, equity);
  const target = { BTC: 20, ETH: 35, BNB: 20, XRP: 0, USDT: 25 };
  const stopped = gates({ BTC: 'stop_exit', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' });
  const assessment = assessBand({
    policyVersion: 'A',
    policy: config.exposureBand,
    state: 'constructive',
    targetAllocation: target,
    rawAllocation: null,
    bookExposurePercent: 75,
    reserveAsset: RESERVE,
    gateByAsset: stopped,
    capOf,
    maxDeployablePercent: 70,
    equityQuote: equity,
    movementFloorQuote: (equity * config.execution.minMovementPercent) / 100,
    // ENFORCE: the stop is about to flatten BTC.
    stoppedWeightSurvives: false,
  });
  const out = correctToBand({
    assessment,
    clampedAllocation: target,
    rawAllocation: null,
    reserveAsset: RESERVE,
    portfolio,
    priceOf,
    feePercent: config.execution.feePercent,
    minMovementPercent: config.execution.minMovementPercent,
  });

  ok('[cible dans la bande + stop] the remaining 55% is inside [45, 70]', out.direction === 'none');
  ok(
    'the stopped line is FLAT in the returned allocation',
    out.correctedAllocation.BTC === 0,
  );
  ok(
    'and the allocation agrees with the exposure the outcome publishes',
    near(
      Object.entries(out.correctedAllocation)
        .filter(([a]) => a !== RESERVE)
        .reduce((sum, [, w]) => sum + w, 0),
      out.correctedExposurePercent,
    ),
  );
  ok(
    'it still sums to 100 — the stopped weight went to the reserve',
    near(Object.values(out.correctedAllocation).reduce((a, b) => a + b, 0), 100),
  );
  ok(
    'and the exit is in the movements, not contradicted by the allocation',
    out.movements.some((m) => m.asset === 'BTC' && m.side === 'sell'),
  );

  // (c) A SUPPRESSED LEG IS ATTRIBUTED TO ITS OWN REASON.
  //
  // `planMovements` suppresses for the 2% floor, for a MISSING PRICE, or for dust. Reporting
  // the total as "deleted by the floor" would publish a partial market-data outage as damage
  // done by a threshold — and send whoever reads it to fix the wrong thing.
  const noPricePlan = planMovements(
    bookOf({ BTC: 20 }, equity),
    { BTC: 40, ETH: 10, USDT: 50 },
    // ETH has no price this cycle: the leg cannot be sized at all.
    (asset) => (asset === 'ETH' ? null : asset === RESERVE ? dec(1) : dec(100)),
    config.execution.feePercent,
    config.execution.minMovementPercent,
  );
  ok(
    'a missing price is recorded as its own reason',
    noPricePlan.suppressed.some((leg) => leg.asset === 'ETH' && leg.reason === 'no_price'),
  );
  ok(
    'never as a movement-floor deletion',
    !noPricePlan.suppressed.some((leg) => leg.asset === 'ETH' && leg.reason === 'movement_floor'),
  );
  // The DISTINCTION belongs to the execution journal and stays, whatever any report does with
  // it: `suppressed_reason` is a per-cycle fact, and without it a later reader cannot tell a
  // partial market-data outage from damage done by a threshold.
  ok(
    'the journal carries the reason per line, not a single "suppressed" flag',
    /suppressed_reason: dropped\?\.reason \?\? null,/.test(
      readFileSync(path.join(ROOT, 'src/persistence/exposureBandCorrections.ts'), 'utf8'),
    ),
  );
}

// ── PROOF 20 — the suppression accounting is exhaustive ──────────────────────
//
// `dust` sat in the result type, in the journal's constraint and in the band's report while
// both early exits in `planMovements` returned without appending — so the category could never
// be produced, and the accounting was incomplete while every consumer believed it exhaustive.
console.log('');
console.log('Proof 20 — every suppressed leg says why, including the ones worth nothing:');
{
  const nothingToDo = planMovements(
    bookOf({ BTC: 20, ETH: 10 }),
    { BTC: 20, ETH: 10, USDT: 70 },
    priceOf,
    config.execution.feePercent,
    config.execution.minMovementPercent,
  );
  ok('[poussière] a target the book already holds sends nothing', nothingToDo.movements.length === 0);
  ok(
    'and each untouched line is recorded as dust rather than passed over',
    nothingToDo.suppressed.length === 2 && nothingToDo.suppressed.every((leg) => leg.reason === 'dust'),
  );
  const movements = readFileSync(path.join(ROOT, 'src/execution/movements.ts'), 'utf8');
  ok(
    'both dust branches append before they continue',
    [...movements.matchAll(/reason: 'dust',/g)].length === 2,
  );
  ok(
    'and no dust branch returns silently any more',
    !/lt\(DUST_NOTIONAL\)\) continue;/.test(movements),
  );
}

// ── PROOF 21 — two attributions that were saying the wrong thing ─────────────
console.log('\nProof 21 — a cause is only claimed by whoever actually caused it:');
{
  // (a) DUST IS NOT A BLOCKAGE BY THE 2% FLOOR.
  //
  // The band lifts a 10% target to the 20% floor while the book ALREADY holds 20%. The
  // correction is fully realised — it prevented a sell that would otherwise have executed —
  // and the resulting zero-notional leg is recorded as `dust`. Reading that as
  // `seuil_de_mouvement` said the plumbing stopped a correction that in fact succeeded, and
  // contradicted the same outcome's own label and its zero gap.
  const alreadyThere = correct({
    state: 'neutral',
    target: { BTC: 10, ETH: 0, BNB: 0, XRP: 0 },
    book: { BTC: 20 },
  });
  const btc = lineOf(alreadyThere, 'BTC');
  ok('[poussière] the band lifts the target to the floor', near(btc.correctedWeightPercent, 20));
  ok('the book already holds it, so nothing needs to move', alreadyThere.movements.length === 0);
  ok('and the correction is fully realised', near(alreadyThere.realisedExposurePercent, 20) && alreadyThere.unrealisablePoints === 0);
  ok('the label says so', alreadyThere.label === 'hausse_vers_plancher');
  ok('the line claims NO cause — nothing blocked it', btc.cause === 'aucune');
  ok(
    'while the dust entry is still journaled on its own',
    alreadyThere.suppressed.some((leg) => leg.asset === 'BTC' && leg.reason === 'dust'),
  );

  // The two causes that ARE blockages keep theirs, so the fix did not simply mute the branch.
  const belowFloor = correct({
    state: 'neutral',
    target: { BTC: 19, ETH: 0, BNB: 0, XRP: 0 },
    book: { BTC: 19 },
  });
  ok(
    'a leg the 2% floor really deletes still names the threshold',
    lineOf(belowFloor, 'BTC').cause === 'seuil_de_mouvement',
  );
  ok(
    'and it is a movement_floor suppression, not a dust one',
    belowFloor.suppressed.some((leg) => leg.asset === 'BTC' && leg.reason === 'movement_floor'),
  );

  // (b) THE REPLAY DOES NOT REDISTRIBUTE WHERE FEASIBILITY IS UNKNOWABLE.
  //
  // `feasibility_known` is the field that says "nobody can answer this". Running the
  // redistribution anyway made every line fail closed for want of a verdict, and the outcome
  // then asserted a fabricated gap and overwrote the deliberately non-committal label — into
  // `bite.json`, which is what brick 3 will reconstruct from.
  const replay = readFileSync(path.join(ROOT, 'src/replay/exposureBandBite.ts'), 'utf8');
  ok(
    'the replay guards the redistribution on the feasibility flag',
    /if \(observation\.assessment != null && observation\.assessment\.feasibility\.known\) \{/.test(replay),
  );
  ok(
    'and there is exactly one call to correctToBand behind it',
    [...replay.matchAll(/correctToBand\(\{/g)].length === 1,
  );

  // The assessment really does report the flag as false when no verdict exists — the condition
  // above is only worth anything if the flag it reads is the one that means it.
  const noVerdicts = assessBand({
    policyVersion: 'A',
    policy: config.exposureBand,
    state: 'constructive',
    targetAllocation: { BTC: 10, ETH: 10, BNB: 0, XRP: 0, USDT: 80 },
    rawAllocation: null,
    bookExposurePercent: 20,
    reserveAsset: RESERVE,
    gateByAsset: new Map(),
    capOf,
    maxDeployablePercent: 70,
    equityQuote: 1000,
    movementFloorQuote: 20,
    stoppedWeightSurvives: true,
  });
  ok('an assessment with no verdict reports its feasibility unknown', noVerdicts.feasibility.known === false);
  ok(
    'and every feasibility number is null rather than a fabricated zero',
    noVerdicts.feasibility.attainableExposurePercent === null &&
      noVerdicts.feasibility.unrealisablePoints === null,
  );
}

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * The transitive RUNTIME module graph — `import type` edges are erased, deliberately.
 *
 * The band's own proof (`exposureBand.ts`) follows every edge, because there the question is
 * "could the calibration harness be reached", and over-reporting reachability is the safe
 * direction. Here the question is the opposite one — "can this graph touch the database" — and
 * over-reporting produces a FALSE POSITIVE: `movements.ts` imports `ExecutionInsert` from
 * `persistence/executions.ts` with `import type`, which TypeScript erases entirely, so no
 * query builder is ever loaded. Counting that edge would fail a proof about behaviour on the
 * strength of a type annotation.
 */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // `import type { … } from '…'` is erased at compile time; every other form emits a real
    // import of the module, even when some of its named bindings are types.
    const runtime = source.replace(/^import\s+type\s[\s\S]*?from\s+'[^']+';/gm, '');
    for (const match of runtime.matchAll(/from\s+'(\.[^']+)'/g)) {
      queue.push(path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

console.log(`\nAll ${passed} exposure-correction proofs passed.`);
