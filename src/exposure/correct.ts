import { Decimal, ZERO } from '../money.js';
import type { PriceLookup, VirtualPortfolio } from '../portfolio/derive.js';
import { planMovements, type Movement, type SuppressedLeg } from '../execution/movements.js';
import type { BandAssessment, BandCorrectionLabel, BandLineView } from './band.js';

/**
 * THE BAND CORRECTION — §3.5 and §3.6, and nothing else.
 *
 * `band.ts` says WHETHER the target is outside its band and by how much. This file says WHICH
 * LINE absorbs the difference. Keeping them apart is what lets the checkpoint's bite be read
 * without the redistribution existing, and what lets the redistribution be tested without a
 * market.
 *
 * PURE and DETERMINISTIC: no I/O, no clock, no model, no randomness. Same inputs, same output,
 * byte for byte — which is what lets the live cycle and a replay run the same function and be
 * compared line for line.
 *
 * ── THE PRECEDENCE CONTRACT, AND WHERE EACH CLAUSE LIVES ───────────────────────────────
 *
 *  1. safety exits and risk_off always win        → the caller runs the gate AFTER this
 *  2. the transition gate wins over BOTH bounds   → `mayIncrease` / `mayDecrease`, here
 *  3. the shortfall moves to actionable lines     → the two passes below
 *  4. what cannot be reached is journaled         → `unrealisablePoints`, never silently held
 *  5. the coherence guard judges the RAW proposal → the caller runs this after the guard
 *  6. a refused proposal is not repaired          → the caller never reaches this on a refusal
 *  7. the correction does not re-enter the guard  → the caller never re-judges its output
 *
 * Clauses 1, 5, 6 and 7 are properties of the CALL SITE, not of this function, and they are
 * proven there. Clauses 2, 3 and 4 are this file's, and they are proven here.
 *
 * ── THE ONE RULE THAT IS NOT OBVIOUS ───────────────────────────────────────────────────
 *
 * §3.5.5: a distribution into small legs that leaves the bound unreachable, when one
 * executable leg could have reached it, must CONSOLIDATE rather than fabricate movements the
 * 2% floor will delete. That is not a refinement — without it the correction can write a
 * perfectly reasonable-looking target that moves nothing at all, and the journal would show a
 * correction that never happened. See `redistributeToFloor`.
 */

/** Where a line's weight came from, per §3.5.4 and the arbitration on the journal. */
export type LineOrigin =
  /** The model's own weight, untouched by the band. */
  | 'modele'
  /**
   * The band lifted or trimmed a line the model had already put weight on — its conviction
   * was scaled, not invented.
   */
  | 'correction_de_bande'
  /**
   * §3.5.4. The band put weight on a line the model gave nothing to, because the proportional
   * pass could not reach the floor on its own. It expresses NO conviction of the model's, and
   * it is labelled apart precisely so nobody can later read it as one.
   */
  | 'allocation_de_secours';

/** Why a line could not absorb what the band asked of it. `aucune` when nothing stopped it. */
export type LineCause =
  | 'aucune'
  /** The transition layer froze it: the code may not create an order on this line. */
  | 'gel'
  /** It reached its per-asset cap. */
  | 'plafond_individuel'
  /** The resulting leg is under the 2% plumbing floor and will never be sent. */
  | 'seuil_de_mouvement'
  /** No live price, or no capacity at all. Named rather than folded into the others. */
  | 'autre_impossibilite';

export interface CorrectedLine {
  asset: string;
  /** FACT 1, per line — the model's raw weight, before the risk clamp. */
  rawWeightPercent: number | null;
  /** The model's weight after the risk clamp — what it asked for, bounded. */
  clampedWeightPercent: number;
  /**
   * THE WEIGHT THE CORRECTION ACTUALLY STARTED FROM, and it is not always the clamped one.
   *
   * On a peak-stopped line under `enforce`, `applyGate` is about to take the line to zero, so
   * the chain will pursue 0 whatever the model asked. The correction sizes itself against that
   * zero — and `correctionPoints` is therefore measured from HERE, not from the clamped
   * weight.
   *
   * The distinction is not cosmetic. Publishing the clamped weight while computing the delta
   * from this one produced rows like (clamped 20, correction 0, corrected 0), which violate the
   * migration's `base + correction = corrected` CHECK — and because the rows are upserted as
   * one batch, a single such line would have silently destroyed the whole cycle's correction
   * journal. Two columns, one arithmetic.
   */
  baseWeightPercent: number;
  /** FACT 2, per line — signed points the band added or removed. */
  correctionPoints: number;
  /** FACT 3, per line — the weight handed to the execution engine. */
  correctedWeightPercent: number;
  origin: LineOrigin;
  cause: LineCause;
  capPercent: number;
  mayIncrease: boolean;
  mayDecrease: boolean;
  /** The line's weight in the BOOK before the cycle — where it stays if its leg is dropped. */
  bookWeightPercent: number;
  /**
   * DID THE CORRECTION ACTUALLY CHANGE WHAT THIS LINE WOULD HOLD?
   *
   * `correctionPoints > 0` only proves the TARGET was lifted. It does not prove a single unit
   * of anything moves: lifting a neutral target from 19 to 20 on a $1000 book produces a $10
   * leg that the $20 floor deletes, and the line finishes exactly where it started.
   *
   * The difference matters wherever the correction's effect is counted. "How often would the
   * model undo a position the corrector created" is meaningless on a position that was never
   * created — those rows would inflate the denominator and drag every published rate toward
   * whatever the inert cases happen to look like.
   *
   * So this compares the holdings of two EXECUTABLE plans, the corrected one and the
   * uncorrected one, rather than their targets.
   */
  correctionMovesHolding: boolean;
  /**
   * What this line would REALLY hold after the plan, in percent of the post-trade equity.
   *
   * Not `correctedWeightPercent`: a buy is sized from the cash budget and then divided by
   * (1 + fee), and every leg's fee comes off equity, so the position created is smaller than
   * the position asked for. Anything that reasons about the imposed position — "did the model
   * keep it, or undo it" — has to compare against THIS, or a following target sitting between
   * the two counts as an undo while it is in fact maintaining the position.
   */
  realisedWeightPercent: number;
}

export interface CorrectionOutcome {
  /** The vector-level label, exactly the four the protocol fixes. */
  label: BandCorrectionLabel;
  direction: 'none' | 'up' | 'down';
  /** FACT 3, at the vector level — the allocation the engine would receive. */
  correctedAllocation: Record<string, number>;
  /** Σ of the corrected non-reserve weights. */
  correctedExposurePercent: number;
  /**
   * What the book would ACTUALLY hold after this cycle, once the 2% floor has deleted the
   * legs it deletes: the corrected weight where the leg survives, the BOOK's weight where it
   * does not. This is the number the band is really judged on, and it is not the target.
   */
  realisedExposurePercent: number;
  /**
   * Points still outside the band after the maximum feasible correction. §3.4.4 / §3.5.6.
   *
   * NET OF THE FEE. Moving costs money, and the cost lands on the exposure itself: a buy is
   * sized from the cash budget and then divided by `(1 + fee)`, so a correction that asks for
   * 25 points delivers about 24.985 of them. The protocol's projection is "the smallest move
   * that satisfies the constraint" — it cannot ask for more than the constraint to pay for its
   * own execution, so a residual no larger than `feeDragPoints` is the price of the move, not
   * a band that could not be reached.
   *
   * Without that subtraction EVERY upward correction would be labelled
   * `bande_partiellement_irrealisable` over a hundredth of a point, and the label would stop
   * meaning "something blocked this" — which is the only thing it is for.
   */
  unrealisablePoints: number;
  /** The fee this plan would pay, in points of equity. The tolerance above, made explicit. */
  feeDragPoints: number;
  /**
   * Did §3.5.5 actually CHANGE the outcome — is the retained plan a narrowed one?
   *
   * False when narrowing was tried and helped nothing, which is a real and distinct state:
   * a deficit worth about one movement floor cannot be saved by concentrating it, because a
   * BUY leg sized at exactly the floor comes out just under it once the fee is taken from the
   * budget (`notional = cashOutlay / (1 + fee)`). `consolidationAttempts` is what separates
   * "nothing needed doing" from "everything was tried and nothing worked".
   */
  consolidated: boolean;
  /** How many lines the retained plan gave up, relative to the widest distribution. */
  consolidationRounds: number;
  /** How many narrowings were evaluated. Published so a silent early exit would be visible. */
  consolidationAttempts: number;
  lines: CorrectedLine[];
  /**
   * The legs the corrected target would produce — BEFORE THE TRANSITION GATE.
   *
   * ── WHY THIS FUNCTION DOES NOT GATE, AND THAT IS THE FIX RATHER THAN THE GAP ──────────
   *
   * A previous round tried to filter these by the same `mayIncrease`/`mayDecrease` map the
   * correction obeys, so that a leg the gate would refuse was not counted as sent. That was
   * wrong in a way worth recording, because it is the shape every partial re-implementation
   * of the gate takes:
   *
   *   - the map is about what the CORRECTION may create, and the gate's rule for a leg is a
   *     different question — `judgeOrder` exempts DETERMINISTIC exits, so a `stop_exit` line's
   *     full-exit sell is always executed while both its capabilities read false. The filter
   *     therefore dropped the one leg that certainly leaves;
   *   - and it dropped it AFTER `computeMovements` had already sized the buys from the cash
   *     that exit was going to produce. The counterfactual then held buys funded by a sale it
   *     had just deleted.
   *
   * The gate is one thing, in one place: `judgeVector` then `applyGate`, run by `decide()` on
   * whatever vector it is about to execute — including this one, the day the correction feeds
   * the engine. Modelling a second, weaker copy of it here to predict its own input is how the
   * two silently diverge.
   *
   * So this is the plan as the EXECUTOR would receive it, and the gate's verdict on it is
   * recorded per line (`gate`) rather than applied. Under `TRANSITION_MODE=observe` — the mode
   * production has always run — the gate refuses nothing and the two coincide exactly.
   */
  movements: Movement[];
  /** §3.3 and §3.6.4 — the legs the floor deleted stay visible. */
  suppressed: SuppressedLeg[];
}

export interface CorrectInput {
  assessment: BandAssessment;
  /** The risk-clamped target the chain retained — the correction's starting point. */
  clampedAllocation: Record<string, number>;
  /** The model's raw proposal, for fact 1. Never an operand of the arithmetic. */
  rawAllocation: Record<string, number> | null;
  reserveAsset: string;
  /** The pre-trade book. The correction is sized against it, exactly as the engine is. */
  portfolio: VirtualPortfolio;
  priceOf: PriceLookup;
  feePercent: number;
  minMovementPercent: number;
}

/** Percentages are not money — the same tolerance the risk wrapper uses, for the same reason. */
const EPS = 1e-9;
const POINT_DP = 6;

function round(value: number): number {
  return Number(value.toFixed(POINT_DP));
}

/**
 * PROPORTIONAL ALLOCATION UNDER CAPS — the water-filling every pass below runs on.
 *
 * Distributing `amount` in proportion to each candidate's `share` is one line until a
 * candidate hits its `headroom`. Clipping it and stopping there would silently under-deliver;
 * clipping it and NOT redistributing its excess would do the same more quietly. So the excess
 * is re-poured over the candidates that still have room, and the round repeats.
 *
 * Terminates: every round either exhausts the amount or removes at least one candidate from
 * the pool, and the pool is finite.
 *
 * A candidate with `share === 0` receives nothing in a proportional pass — that is what makes
 * pass 1 respect "cibles risquées STRICTEMENT POSITIVES" without a special case. The equal
 * pass passes `share = 1` for everyone.
 */
function waterfill(
  amount: number,
  candidates: ReadonlyArray<{ asset: string; share: number; headroom: number }>,
): Map<string, number> {
  const given = new Map<string, number>();
  let remaining = amount;
  let pool = candidates.filter((c) => c.headroom > EPS && c.share > EPS);

  while (remaining > EPS && pool.length > 0) {
    const totalShare = pool.reduce((sum, c) => sum + c.share, 0);
    if (totalShare <= EPS) break;

    const next: typeof pool = [];
    let distributed = 0;
    for (const candidate of pool) {
      const want = (remaining * candidate.share) / totalShare;
      const room = candidate.headroom - (given.get(candidate.asset) ?? 0);
      const give = Math.min(want, room);
      if (give > 0) {
        given.set(candidate.asset, (given.get(candidate.asset) ?? 0) + give);
        distributed += give;
      }
      // Still has room after this round — stays in the pool for the excess.
      if (room - give > EPS) next.push(candidate);
    }
    remaining -= distributed;
    // No progress and no candidate left the pool: the remaining amount cannot be placed.
    if (distributed <= EPS && next.length === pool.length) break;
    pool = next;
  }

  return given;
}

/** The exposure of an allocation: Σ non-reserve. Never `100 − reserve`. See `band.ts`. */
function exposureOf(allocation: Record<string, number>, reserveAsset: string): number {
  let total = 0;
  for (const [asset, weight] of Object.entries(allocation)) {
    if (asset === reserveAsset) continue;
    if (typeof weight === 'number' && Number.isFinite(weight)) total += weight;
  }
  return round(total);
}

/** The book's weight per line, in percent of equity — where a dropped leg leaves the line. */
function bookWeights(portfolio: VirtualPortfolio): Map<string, number> {
  const weights = new Map<string, number>();
  for (const position of portfolio.positions) {
    weights.set(position.asset, position.weightPercent.toNumber());
  }
  return weights;
}

/**
 * Rebuilds the allocation from the per-line weights, putting the remainder in the reserve.
 *
 * The reserve is DERIVED, never carried over: an allocation that changed its risky weights
 * and kept its old cash line would no longer sum to 100, and every downstream consumer —
 * `computeMovements`' buy budget first among them — reads that sum.
 */
function allocationFrom(
  weights: Map<string, number>,
  reserveAsset: string,
  totalPercent: number,
): Record<string, number> {
  const allocation: Record<string, number> = {};
  let risky = 0;
  for (const [asset, weight] of [...weights.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // The ROUNDED weight is accumulated, not the raw one. Rounding each line and deriving the
    // reserve from the unrounded sum leaves the allocation totalling 100.000001 — harmless
    // arithmetically, and not harmless at all downstream: the sum is what `computeMovements`
    // reads to size its buy budget, what the output schema validates, and what every later
    // reader of the journal will compare against 100. Three lines at a third of a point are
    // enough to produce it, which is an ordinary rescue split.
    const rounded = round(weight);
    allocation[asset] = rounded;
    risky += rounded;
  }
  allocation[reserveAsset] = round(totalPercent - risky);
  return allocation;
}

interface PassResult {
  weights: Map<string, number>;
  origins: Map<string, LineOrigin>;
  /** Points that could not be placed anywhere. */
  shortfall: number;
}

/**
 * §3.5 — THE DEFICIT, TOWARD THE FLOOR.
 *
 *  1. proportionally among the model's strictly positive risky targets that can still rise;
 *  2. caps and freezes respected — they bound `headroom`, so no pass can violate them;
 *  3. the remainder split EQUALLY among the other actionable lines with capacity;
 *  4. that second part carries `allocation_de_secours`, because it expresses no conviction;
 *  5. the 2% floor applies to the RESULT — handled by the caller's consolidation loop;
 *  6. what is left over is journaled.
 *
 * `excluded` is the consolidation loop's lever: an asset whose increment produced a leg the
 * floor deleted is removed from the pool, and its points are re-poured over the rest. That is
 * how a distribution into small legs becomes one executable leg.
 */
function distributeToFloor(
  lines: readonly BandLineView[],
  deficit: number,
  excluded: ReadonlySet<string>,
): PassResult {
  const weights = new Map<string, number>(lines.map((l) => [l.asset, l.weightPercent]));
  const origins = new Map<string, LineOrigin>(lines.map((l) => [l.asset, 'modele' as LineOrigin]));

  const eligible = lines.filter(
    (l) => l.mayIncrease && !excluded.has(l.asset) && l.capPercent - l.weightPercent > EPS,
  );

  // ── PASS 1 — proportional, on the model's own convictions ──────────────────────────
  const proportional = waterfill(
    deficit,
    eligible.map((l) => ({
      asset: l.asset,
      // The model's weight IS the share. A line at zero has no conviction to scale, so it
      // receives nothing here — that is §3.5.1's "strictement positives", expressed as
      // arithmetic rather than as a filter that would have to be kept in step with it.
      share: l.weightPercent,
      headroom: l.capPercent - l.weightPercent,
    })),
  );
  let placed = 0;
  for (const [asset, points] of proportional) {
    weights.set(asset, weights.get(asset)! + points);
    origins.set(asset, 'correction_de_bande');
    placed += points;
  }

  // ── PASS 2 — §3.5.3, equal split over the remaining capacity ───────────────────────
  //
  // "les autres actifs actionnables disposant de capacité" — everything pass 1 could not use,
  // which is exactly the lines the model gave nothing to plus the ones it saturated.
  let shortfall = deficit - placed;
  if (shortfall > EPS) {
    const fallback = waterfill(
      shortfall,
      eligible.map((l) => ({
        asset: l.asset,
        // Equal, so every line with room counts the same — no conviction is being expressed.
        share: 1,
        headroom: l.capPercent - weights.get(l.asset)!,
      })),
    );
    for (const [asset, points] of fallback) {
      weights.set(asset, weights.get(asset)! + points);
      // A line pass 1 already lifted keeps `correction_de_bande`: its weight still started
      // from the model's own conviction. Only a line the model left at zero is a rescue.
      const line = lines.find((l) => l.asset === asset)!;
      origins.set(asset, line.weightPercent > EPS ? 'correction_de_bande' : 'allocation_de_secours');
      shortfall -= points;
    }
  }

  return { weights, origins, shortfall: Math.max(shortfall, 0) };
}

/**
 * §3.6 — THE EXCESS, TOWARD THE CEILING. Symmetric, and just as binding.
 *
 *  1. the non-modifiable exposure of frozen lines is RESERVED FIRST;
 *  2. the budget remaining under the ceiling is split proportionally between the model's
 *     positive targets on the reducible lines;
 *  3. if the frozen lines exceed the ceiling on their own, every still-authorised reduction
 *     runs to the maximum feasible and the residual overshoot is journaled;
 *  4. legs the 2% floor deletes stay visible — the caller journals `suppressed`.
 *
 * No consolidation here, deliberately. §3.5.5 asks for it on the floor side and §3.6 does
 * not, and adding an unrequested rule to a pre-registered protocol is not a favour: it would
 * make the two sides behave differently for reasons nobody arbitrated.
 */
function distributeToCeiling(lines: readonly BandLineView[], ceiling: number): PassResult {
  const weights = new Map<string, number>(lines.map((l) => [l.asset, l.weightPercent]));
  const origins = new Map<string, LineOrigin>(lines.map((l) => [l.asset, 'modele' as LineOrigin]));

  // Clause 1 — what cannot be reduced is spent before anything else is considered.
  const reserved = lines.filter((l) => !l.mayDecrease).reduce((sum, l) => sum + l.weightPercent, 0);
  const budget = ceiling - reserved;

  const reducible = lines.filter((l) => l.mayDecrease && l.weightPercent > EPS);
  const reducibleTotal = reducible.reduce((sum, l) => sum + l.weightPercent, 0);

  if (budget <= EPS) {
    // Clause 3 — the frozen lines alone are at or above the ceiling. Every authorised
    // reduction still runs, all the way to zero, and the overshoot is what it is.
    for (const line of reducible) {
      weights.set(line.asset, 0);
      origins.set(line.asset, 'correction_de_bande');
    }
    return { weights, origins, shortfall: round(Math.max(reserved - ceiling, 0)) };
  }

  if (reducibleTotal <= budget + EPS) {
    // Nothing to do on the reducible side: the total already fits. Reached only when the
    // caller mis-sized the excess, so it is a no-op rather than a case.
    return { weights, origins, shortfall: 0 };
  }

  // Clause 2 — proportional scaling of the model's positive reducible weights.
  const scale = budget / reducibleTotal;
  for (const line of reducible) {
    weights.set(line.asset, line.weightPercent * scale);
    origins.set(line.asset, 'correction_de_bande');
  }
  return { weights, origins, shortfall: 0 };
}

/**
 * Assembles one candidate allocation and asks the REAL engine what it would do with it.
 *
 * `planMovements`, not a re-implementation: the 2% floor, the pro-rata buy budget and the
 * dust threshold are the executor's rules, and a correction that modelled them itself would
 * eventually disagree with the thing that actually sends the orders.
 */
function planFor(
  input: CorrectInput,
  weights: Map<string, number>,
  totalPercent: number,
): { allocation: Record<string, number>; movements: Movement[]; suppressed: SuppressedLeg[] } {
  const allocation = allocationFrom(weights, input.reserveAsset, totalPercent);
  const plan = planMovements(
    input.portfolio,
    allocation,
    input.priceOf,
    input.feePercent,
    input.minMovementPercent,
    // TAGGED, because this plan is a counterfactual: the band evaluates several candidate
    // allocations per cycle and none of them is what the bot sends. Untagged, their `[skip]`
    // lines would be indistinguishable from the real cycle's own refusals in the logs.
    ':band',
  );
  return { allocation, movements: plan.movements, suppressed: plan.suppressed };
}

/**
 * WHAT THE BOOK WOULD REALLY HOLD after a plan — the number the band is judged on.
 *
 * REPLAYED FROM THE MOVEMENTS THEMSELVES, never from the target. The first version of this
 * assumed that any line carrying a surviving leg lands exactly on its corrected weight, and
 * that is false in two ways the review caught:
 *
 *   - a BUY is sized from the cash budget and then divided by `(1 + fee)`, so it lands short
 *     of the requested delta by the fee;
 *   - every leg's fee comes out of equity, so the DENOMINATOR moves too — a plan that traded
 *     nothing but fees would still shift every weight.
 *
 * Assuming the target would have let an upward correction report "floor reached, zero gap"
 * while the planned fills leave the book under it. That is exactly the confusion §3.3 exists
 * to prevent, so the arithmetic is done on the notionals: value in, value out, fees off equity.
 */
/** The fee a plan would pay, in points of equity — the exposure it costs to move. */
function feeDrag(portfolio: VirtualPortfolio, movements: readonly Movement[]): number {
  const equity = portfolio.equity;
  if (!equity.gt(0)) return 0;
  let fees = ZERO;
  for (const movement of movements) fees = fees.plus(movement.fee);
  return round(fees.div(equity).times(100).toNumber());
}

function realisedExposure(
  portfolio: VirtualPortfolio,
  book: Map<string, number>,
  movements: readonly Movement[],
): number {
  const equity = portfolio.equity;
  if (!equity.gt(0)) return round(0);

  const valueOf = new Map<string, Decimal>();
  for (const [asset, weight] of book) valueOf.set(asset, equity.times(weight).div(100));

  let fees = ZERO;
  for (const movement of movements) {
    const current = valueOf.get(movement.asset) ?? ZERO;
    valueOf.set(
      movement.asset,
      movement.side === 'buy' ? current.plus(movement.notional) : current.minus(movement.notional),
    );
    fees = fees.plus(movement.fee);
  }

  // Both legs pay their fee out of equity: a buy spends notional + fee of cash for notional of
  // coin, a sell gives up notional of coin for notional − fee of cash. Either way the book is
  // smaller by the fee afterwards, and the weights are read against THAT equity.
  const after = equity.minus(fees);
  if (!after.gt(0)) return round(0);

  let exposure = ZERO;
  for (const value of valueOf.values()) exposure = exposure.plus(Decimal.max(value, ZERO));
  return round(exposure.div(after).times(100).toNumber());
}

/**
 * Corrects one cycle's clamped target onto its band. PURE and TOTAL — it never throws.
 *
 * Totality is the safety property: this runs on a live trading path, and an exception here
 * would let an observational component kill a wake-up.
 */
export function correctToBand(input: CorrectInput): CorrectionOutcome {
  const { assessment, clampedAllocation, rawAllocation, reserveAsset } = input;
  const lines = assessment.lines;
  const book = bookWeights(input.portfolio);
  const totalPercent = assessment.targetSumPercent;

  const baseWeights = new Map<string, number>(lines.map((l) => [l.asset, l.weightPercent]));
  const capOf = new Map(lines.map((l) => [l.asset, l.capPercent]));

  /**
   * What each line would HOLD under a plan, in quote — the book plus whatever its leg moves.
   *
   * Compared between the corrected plan and the uncorrected one, this is the only honest test
   * of "did the correction change anything here": both are executable plans through the same
   * engine, so the difference is the correction's doing and nothing else's.
   */
  const holdingsUnder = (movements: readonly Movement[]): Map<string, Decimal> => {
    const held = new Map<string, Decimal>();
    for (const line of lines) {
      held.set(line.asset, input.portfolio.equity.times(book.get(line.asset) ?? 0).div(100));
    }
    for (const movement of movements) {
      const current = held.get(movement.asset) ?? ZERO;
      held.set(
        movement.asset,
        movement.side === 'buy' ? current.plus(movement.notional) : current.minus(movement.notional),
      );
    }
    return held;
  };
  // The UNCORRECTED plan, run once: what the cycle would have held with no band at all.
  const uncorrectedHoldings = holdingsUnder(planFor(input, baseWeights, totalPercent).movements);

  const buildLines = (
    weights: Map<string, number>,
    origins: Map<string, LineOrigin>,
    suppressed: readonly SuppressedLeg[],
    movements: readonly Movement[],
  ): CorrectedLine[] => {
    const correctedHoldings = holdingsUnder(movements);
    // The same denominator `realisedExposure` uses: equity net of the fees the plan pays.
    // Reading a weight against the pre-trade equity would put the whole book slightly light.
    const postEquity = movements.reduce((eq, m) => eq.minus(m.fee), input.portfolio.equity);
    const suppressedAssets = new Map(suppressed.map((s) => [s.asset, s]));
    return lines.map((line) => {
      const corrected = round(weights.get(line.asset) ?? line.weightPercent);
      const delta = round(corrected - line.weightPercent);
      const origin = delta === 0 ? 'modele' : (origins.get(line.asset) ?? 'correction_de_bande');
      const dropped = suppressedAssets.get(line.asset);

      // THE CAUSE, most specific first. A frozen line is frozen whatever else is true of it;
      // a line at its cap could not take more whatever the floor says; only then does the
      // plumbing get the blame. Collapsing these would let the 2% floor take the credit for a
      // freeze, which is exactly the attribution the journal exists to keep straight.
      let cause: LineCause = 'aucune';
      if (delta === 0 && !line.mayIncrease && !line.mayDecrease) cause = 'gel';
      else if (delta > 0 && Math.abs(corrected - (capOf.get(line.asset) ?? corrected)) <= EPS) {
        cause = 'plafond_individuel';
      } else if (dropped != null) {
        cause = dropped.reason === 'no_price' ? 'autre_impossibilite' : 'seuil_de_mouvement';
      } else if (delta === 0 && !line.mayIncrease) cause = 'gel';

      return {
        asset: line.asset,
        rawWeightPercent: rawAllocation?.[line.asset] ?? null,
        clampedWeightPercent: line.targetWeightPercent,
        // THE BASE OF THE ARITHMETIC, which is what `delta` was measured from. On a stopped
        // line under `enforce` it is 0 while the clamped weight is whatever the model asked —
        // and publishing only the latter is what broke the migration's CHECK.
        baseWeightPercent: line.weightPercent,
        correctionPoints: delta,
        correctedWeightPercent: corrected,
        origin,
        cause,
        capPercent: line.capPercent,
        mayIncrease: line.mayIncrease,
        mayDecrease: line.mayDecrease,
        bookWeightPercent: round(book.get(line.asset) ?? 0),
        correctionMovesHolding: !(correctedHoldings.get(line.asset) ?? ZERO).eq(
          uncorrectedHoldings.get(line.asset) ?? ZERO,
        ),
        realisedWeightPercent: postEquity.gt(0)
          ? round(
              Decimal.max(correctedHoldings.get(line.asset) ?? ZERO, ZERO)
                .div(postEquity)
                .times(100)
                .toNumber(),
            )
          : 0,
      };
    });
  };

  // ── NO CORRECTION DUE ──────────────────────────────────────────────────────────────
  //
  // "The band asked for nothing" does NOT mean "the book ends up inside the band". A target
  // sitting comfortably in the band can still leave the book outside it: a neutral 20% target
  // held against a 19% book produces a one-point buy, the 2% floor deletes it, and the cycle
  // ends with 19% of exposure and a `aucune_correction` label.
  //
  // Reporting a zero gap there would hide exactly the failures this pilot is measuring — the
  // ones where the plumbing, not the band, is what keeps the book out. So the gap is computed
  // on this path too, against whichever bound the realised book falls outside of.
  if (assessment.direction === 'none') {
    const plan = planFor(input, baseWeights, totalPercent);
    const realised = realisedExposure(input.portfolio, book, plan.movements);
    const drag = feeDrag(input.portfolio, plan.movements);
    const gap = round(
      Math.max(
        assessment.band.lowPercent - realised - drag,
        realised - assessment.band.highPercent - drag,
        0,
      ),
    );
    return {
      label: gap > 0 ? 'bande_partiellement_irrealisable' : 'aucune_correction',
      direction: 'none',
      correctedAllocation: { ...clampedAllocation },
      correctedExposurePercent: assessment.targetExposurePercent,
      realisedExposurePercent: realised,
      // NOT zero by construction any more. The label follows it: a cycle whose book lands
      // outside the band is not a cycle where nothing happened, even when the band asked for
      // nothing — and the four labels have no fifth to describe it.
      unrealisablePoints: gap,
      feeDragPoints: drag,
      consolidated: false,
      consolidationRounds: 0,
      consolidationAttempts: 0,
      lines: buildLines(baseWeights, new Map(), plan.suppressed, plan.movements),
      movements: plan.movements,
      suppressed: plan.suppressed,
    };
  }

  const bound =
    assessment.direction === 'up' ? assessment.band.lowPercent : assessment.band.highPercent;

  // ── THE CEILING — one pass, no consolidation (see `distributeToCeiling`) ───────────
  if (assessment.direction === 'down') {
    const pass = distributeToCeiling(lines, bound);
    const plan = planFor(input, pass.weights, totalPercent);
    const realised = realisedExposure(input.portfolio, book, plan.movements);
    // The overshoot that survives: what the frozen lines force (pass.shortfall) OR what the
    // floor left un-sold. Both are "still above the ceiling", and both are journaled.
    const drag = feeDrag(input.portfolio, plan.movements);
    // The frozen shortfall is structural and owes nothing to the fee; only the realised
    // overshoot gets the tolerance.
    const unrealisable = round(Math.max(pass.shortfall, realised - bound - drag, 0));
    return {
      label: unrealisable > 0 ? 'bande_partiellement_irrealisable' : 'baisse_vers_plafond',
      direction: 'down',
      correctedAllocation: plan.allocation,
      correctedExposurePercent: exposureOf(plan.allocation, reserveAsset),
      realisedExposurePercent: realised,
      unrealisablePoints: unrealisable,
      feeDragPoints: drag,
      consolidated: false,
      consolidationRounds: 0,
      consolidationAttempts: 0,
      lines: buildLines(pass.weights, pass.origins, plan.suppressed, plan.movements),
      movements: plan.movements,
      suppressed: plan.suppressed,
    };
  }

  // ── THE FLOOR — distribute, then §3.5.5's consolidation ───────────────────────────
  //
  // THE SHAPE OF THE SEARCH, and why it is a narrowing rather than a repair.
  //
  // The first attempt spreads the deficit over every eligible line. If the 2% floor then
  // deletes those legs, the correction has written a target that moves nothing — and the
  // remedy is not to patch the losers but to stop using them: each subsequent attempt keeps
  // only the k highest-priority candidates, so the same deficit lands on fewer lines and the
  // surviving legs get bigger. k = 1 is the "une jambe exécutable" case the protocol names.
  //
  // Excluding every dropped line AT ONCE — the obvious first implementation — is wrong for a
  // reason worth recording: when all of them dropped, it empties the pool and the correction
  // collapses to nothing, which is the opposite of consolidating.
  //
  // PRIORITY: the model's own weight, descending, then the asset name. Narrowing therefore
  // sheds the rescue lines (weight zero) before it sheds any line the model actually believed
  // in, so consolidation costs as little of the model's expressed conviction as possible.
  const priority = lines
    .filter((l) => l.mayIncrease && l.capPercent - l.weightPercent > EPS)
    .slice()
    .sort((a, b) =>
      a.weightPercent === b.weightPercent
        ? a.asset.localeCompare(b.asset)
        : b.weightPercent - a.weightPercent,
    )
    .map((l) => l.asset);

  const deficit = bound - assessment.targetExposurePercent;
  let best: { pass: PassResult; plan: ReturnType<typeof planFor>; realised: number } | null = null;
  let rounds = 0;
  let attempts = 0;

  for (let keep = priority.length; keep >= 1; keep -= 1) {
    attempts += 1;
    const excluded = new Set(priority.slice(keep));
    const pass = distributeToFloor(lines, deficit, excluded);
    const plan = planFor(input, pass.weights, totalPercent);
    const realised = realisedExposure(input.portfolio, book, plan.movements);

    // KEEP THE BEST, not the last. Narrowing further can hit a cap and end up worse; taking
    // the last attempt would then publish a correction weaker than one already found. Strict
    // improvement, so the widest — least intrusive — distribution wins a tie.
    if (best == null || realised > best.realised + EPS) {
      best = { pass, plan, realised };
      rounds = priority.length - keep;
    }
    // Net of the fee, for the same reason the gap is: a plan cannot both reach the bound and
    // pay for itself out of the same points, and narrowing further would chase a hundredth of
    // a point it can never recover.
    if (realised >= bound - feeDrag(input.portfolio, plan.movements) - EPS) break;
  }

  // No eligible line at all: the correction is entirely infeasible, and that is a fact rather
  // than a crash. `distributeToFloor` returns the untouched weights, so the shortfall is the
  // whole deficit.
  if (best == null) {
    const pass = distributeToFloor(lines, deficit, new Set(priority));
    const plan = planFor(input, pass.weights, totalPercent);
    best = { pass, plan, realised: realisedExposure(input.portfolio, book, plan.movements) };
  }

  const { pass, plan, realised } = best;
  const drag = feeDrag(input.portfolio, plan.movements);
  const unrealisable = round(Math.max(bound - realised - drag, 0));
  return {
    label: unrealisable > 0 ? 'bande_partiellement_irrealisable' : 'hausse_vers_plancher',
    direction: 'up',
    correctedAllocation: plan.allocation,
    correctedExposurePercent: exposureOf(plan.allocation, reserveAsset),
    realisedExposurePercent: realised,
    unrealisablePoints: unrealisable,
    feeDragPoints: drag,
    consolidated: rounds > 0,
    consolidationRounds: rounds,
    consolidationAttempts: attempts,
    lines: buildLines(pass.weights, pass.origins, plan.suppressed, plan.movements),
    movements: plan.movements,
    suppressed: plan.suppressed,
  };
}
