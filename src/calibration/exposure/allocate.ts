import type { ExperimentConfig } from './config.js';
import type { Band } from './controller.js';
import { applyRsiBrake, projectOntoBand } from './controller.js';

/**
 * FROM A BAND TO AN ALLOCATION — the seven steps, in order, with no exception.
 *
 * Two mechanisms in this file are routinely confused, and keeping them apart is most of the
 * reason it exists:
 *
 *   THE FEASIBLE INTERVAL is an AGGREGATE bound. It says what total exposure the book could
 *   reach at all, given which lines the gate will let us touch.
 *
 *   NON-REDISTRIBUTION is a PER-LINE rule. A line that cannot reach its nominal target does
 *   not hand its shortfall to another line.
 *
 * Satisfying the first does NOT imply hitting the target, because the second can strand
 * capacity on lines that are individually blocked. They are computed separately, they fail
 * separately, and they are journaled separately. A harness that merged them would report a
 * feasible target it never reached and call the difference noise.
 */

/** What the gate says we may do with one line, after the deterministic overrides. */
export interface LineConstraint {
  asset: string;
  /** Current weight, in percent of equity. */
  currentPercent: number;
  /** May this line be REDUCED on this bar? */
  canReduce: boolean;
  /** May this line be INCREASED on this bar? */
  canIncrease: boolean;
  /** Why it is blocked, when it is — for the per-cause journal. */
  reason: 'free' | 'frozen' | 'stop_exit' | 'risk_off_reduce_only' | 'no_regime';
  /**
   * THE DETERMINISTIC STOP FIRED: this line must go to ZERO, exempt from the movement floor.
   *
   * "Permitted to reduce" is NOT what production's stop means, and the difference is not
   * academic. `computeStopExits` synthesizes a sell of the WHOLE quantity with
   * `fullExit: true`, and `isBelowFloor(notional, floor, fullExit)` returns
   * `!fullExit && notional.lt(floor)` — so a full exit is explicitly exempt from the 2 %
   * plumbing floor.
   *
   * A harness that only PERMITTED a reduction would let the basket decide the target: a
   * stopped line sitting BELOW its nominal weight would be held untouched (the move reads as
   * an increase, which the stop forbids), one above would be trimmed only back to nominal,
   * and a small trim would be dropped by the floor. The stop would then fire and do nothing.
   */
  forceExit?: boolean;
}

/** The aggregate interval, recomputed per direction of travel. */
export interface FeasibleInterval {
  lowPercent: number;
  highPercent: number;
}

/**
 * THE FEASIBLE INTERVAL — the total exposure the book could reach at all.
 *
 * BOTH BOUNDS ARE TOTALS, summed per line:
 *
 *   low  = Σ minimum reachable = Σ (may be sold ? 0 : the weight it is stuck at)
 *   high = Σ maximum reachable = Σ (leaving ? 0 : may be bought ? max(cap, current) : current)
 *
 * The ceiling used to be written as a HEADROOM — `floor + Σ (cap − current)` — and that was
 * the defect two published rounds rested on. It measures how much MORE could be bought and
 * adds it to a floor that deliberately excludes every reducible line, so a held weight landed
 * in neither term: an all-actionable book at 70 % came out with a ceiling of 35 %, "do
 * nothing" was declared infeasible, and half the book was sold on a bar where nothing should
 * have moved. Staying put is always reachable; a ceiling has to say so.
 *
 * Each bound is direction-aware, and that is load-bearing rather than tidy. `risk_off` is the
 * case: it forbids increases while explicitly ALLOWING reductions, so its lines pin no floor
 * (they may be sold) and lift no ceiling (they may not be bought) — while still contributing
 * the weight they already hold, because the posture forbids buying, it does not force selling.
 */
export function feasibleInterval(
  lines: readonly LineConstraint[],
  caps: Readonly<Record<string, number>>,
): FeasibleInterval {
  let floor = 0;
  let ceiling = 0;
  for (const line of lines) {
    const cap = caps[line.asset] ?? 0;

    // MINIMUM reachable for this line: zero if it may be sold (or must be), otherwise the
    // weight it is stuck at.
    if (!(line.forceExit || line.canReduce)) floor += line.currentPercent;

    // MAXIMUM reachable for this line — a TOTAL, never a headroom.
    //
    // The distinction is the whole bug this replaced. Summing `cap - current` measures how
    // much MORE could be bought and then adds it to a floor that deliberately excludes every
    // reducible line — so an all-actionable book holding 70 % against caps totalling 105 %
    // came out with a ceiling of 35 %. Its own current weight was in neither term. "Do
    // nothing" was then declared infeasible and projected DOWN to 35 %, selling half the book
    // on a bar where nothing should have moved.
    //
    //   forceExit     → 0        the stop takes the line out whatever the band wants
    //   canIncrease   → max(cap, current)   it may be bought to its cap; already above it,
    //                                        it simply stays there (the ceiling never sells)
    //   otherwise     → current  it cannot go higher than where it already is
    if (line.forceExit) continue;
    ceiling += line.canIncrease ? Math.max(cap, line.currentPercent) : line.currentPercent;
  }
  return { lowPercent: floor, highPercent: Math.min(100, ceiling) };
}

export function projectOntoFeasible(targetPercent: number, interval: FeasibleInterval): number {
  if (targetPercent < interval.lowPercent) return interval.lowPercent;
  if (targetPercent > interval.highPercent) return interval.highPercent;
  return targetPercent;
}

/**
 * Why a line missed its nominal target. Both signs use the same vocabulary.
 *
 * `stop` is a FOURTH cause, beyond the three the protocol names (gel, plafond, plancher). A
 * forced exit is none of those, and folding it into "frozen" would mislabel the one event
 * that is supposed to be the most legible in the journal. Named separately so the per-cause
 * ventilation keeps meaning what it says.
 */
export type DeviationCause = 'frozen' | 'cap' | 'floor' | 'stop';

export interface LineDeviation {
  asset: string;
  cause: DeviationCause;
  /** `reached − nominal`, in percentage points. Negative = under, positive = over. */
  signedPercent: number;
}

export interface AllocationResult {
  /** Exposure the band asked for, before feasibility. */
  bandTargetPercent: number;
  /** Exposure after projection onto the feasible interval — what we AIMED at. */
  projectedPercent: number;
  /** Exposure actually reached once every per-line rule applied. */
  reachedPercent: number;
  /** `reached − projected`. Signed, and it really does go both ways. */
  gapPercent: number;
  /** Target weight per asset, in percent of equity. */
  targets: Record<string, number>;
  /** Per-asset, per-cause deviations from the nominal basket target. */
  deviations: LineDeviation[];
  interval: FeasibleInterval;
  /** True when the RSI brake capped a requested increase on this bar. */
  rsiBraked: boolean;
  /** Moves dropped because they were smaller than the movement floor. */
  droppedByFloor: string[];
  /** True when the drop happened while the book sat on a band edge — a calibration smell. */
  droppedAtBandEdge: boolean;
}

/**
 * THE SEVEN STEPS.
 *
 *   1. project current exposure onto the context band (least change, never a midpoint);
 *   2. project that target onto the feasible interval;
 *   3. compute nominal per-asset targets from the fixed basket;
 *   4. hold every frozen line at its CURRENT weight;
 *   5. move every actionable line toward its nominal target, under caps and the floor;
 *   6. never redistribute a shortfall;
 *   7. publish the signed gap `reached − projected`.
 *
 * ═══ THE GAP GOES BOTH WAYS ═══
 *
 * Non-redistribution obviously produces UNDER-exposure. It also produces OVER-exposure, and
 * that half is the one that gets forgotten. Take BTC frozen at 30 % with a 40 % exposure
 * target: its nominal share of 40 % is 13.3 %, it cannot be sold, and if the other three
 * lines walk to their own nominal targets the book lands above 40 % — not because anything
 * misbehaved, but because a frozen overweight cannot be trimmed and the rest were sized as
 * if it could. The harness must publish that as an imposed overshoot, not absorb it.
 */
export function allocate(params: {
  cfg: ExperimentConfig;
  lines: readonly LineConstraint[];
  currentExposurePercent: number;
  band: Band;
  /**
   * Present ONLY on the RSI variant. Absent means the brake is not part of this run at all
   * — not that it evaluated to inactive, which is why it is an optional parameter rather
   * than a boolean flag with a default.
   */
  rsiBrake?: { medianH4Rsi: number | null; thresholdRsi: number; atMs: number };
}): AllocationResult {
  const { cfg, lines, currentExposurePercent, band } = params;

  // ── 1. the band, then the one-way RSI brake if this run carries it ────────────────
  const rawBandTarget = projectOntoBand(currentExposurePercent, band);
  const braked = params.rsiBrake
    ? applyRsiBrake({
        bandTargetPercent: rawBandTarget,
        currentExposurePercent,
        medianH4Rsi: params.rsiBrake.medianH4Rsi,
        thresholdRsi: params.rsiBrake.thresholdRsi,
        atMs: params.rsiBrake.atMs,
      })
    : { targetPercent: rawBandTarget, braked: false };
  const bandTargetPercent = braked.targetPercent;

  // ── 2. the feasible interval, for the direction we are actually travelling ─────────
  const interval = feasibleInterval(lines, cfg.caps);

  /*
   * THE STRUCTURAL INVARIANT, asserted rather than assumed.
   *
   * The feasible FLOOR is the sum of the weights of the lines we may not reduce — a SUBSET of
   * the book we already hold. It therefore cannot exceed the current exposure, ever, and the
   * projection can never push a target UP toward it.
   *
   * That matters most for the RSI brake: when the brake cancels an increase by capping the
   * target at the current exposure, the feasible projection must not be able to recreate a
   * higher one. It may hold the exposure, and it may REDUCE it if another constraint demands
   * that (a ceiling below the current book), but it may never raise it.
   *
   * If this ever fires it is a construction defect in the interval — a line counted in the
   * floor that is not in the book, or an exposure computed on a different basis than the
   * weights — and not a legitimate structural constraint. So it fails loudly here instead of
   * silently producing a purchase the brake had just refused.
   */
  const FLOOR_EPSILON = 1e-9;

  /*
   * TWO INVARIANTS ON THE INTERVAL, both of which the ceiling defect violated.
   *
   * (a) THE BOOK FITS UNDER ITS OWN CEILING — once the lines the stop is taking out are set
   *     aside. "Reachable" includes STAYING PUT, so a ceiling below the weight actually held
   *     is arithmetic, never a market fact. A forced exit is the one exception and it is a
   *     real one: that line is leaving whatever the band wants, so it belongs to neither
   *     side of the comparison.
   *
   *     With the ceiling written as a TOTAL this holds by construction — each line
   *     contributes at least its current weight. That is exactly why it is asserted: it is
   *     free, and it fires on the first bar if anyone ever turns the ceiling back into a
   *     headroom. The old formulation gave a 70 % book a ceiling of 35 %, and the next line
   *     of code turned that into selling half the book.
   *
   * (b) THE TWO VIEWS OF THE BOOK AGREE — the scalar exposure the caller passes and the sum
   *     of the per-line weights it passes alongside it. They are computed from the same
   *     equity in the engine, so a divergence means the two arguments describe different
   *     books, and every bound below would be judging one against the other.
   */
  let heldExcludingForcedExits = 0;
  let heldTotal = 0;
  for (const line of lines) {
    heldTotal += line.currentPercent;
    if (!line.forceExit) heldExcludingForcedExits += line.currentPercent;
  }

  const BOOK_EPSILON = 1e-6;
  if (Math.abs(heldTotal - currentExposurePercent) > BOOK_EPSILON) {
    throw new Error(
      `exposure allocator: the per-line weights sum to ${heldTotal}% but the exposure passed ` +
        `alongside them is ${currentExposurePercent}%. The two describe different books.`,
    );
  }
  if (heldExcludingForcedExits > interval.highPercent + FLOOR_EPSILON) {
    throw new Error(
      `exposure allocator: the book holds ${heldExcludingForcedExits}% outside forced exits, but ` +
        `the feasible ceiling is ${interval.highPercent}%. Staying put is always reachable, so a ` +
        'ceiling below the book is an arithmetic error — refusing to turn it into a sale.',
    );
  }

  if (interval.lowPercent > currentExposurePercent + FLOOR_EPSILON) {
    throw new Error(
      `exposure allocator: the feasible floor (${interval.lowPercent}) exceeds the current ` +
        `exposure (${currentExposurePercent}). The floor sums a SUBSET of the book, so this is ` +
        'impossible unless the interval is built wrong — refusing to continue.',
    );
  }

  const projectedPercent = projectOntoFeasible(bandTargetPercent, interval);

  // The brake's own guarantee, restated where it is observable: a braked bar never ends up
  // aiming higher than the book already sits.
  if (braked.braked && projectedPercent > currentExposurePercent + FLOOR_EPSILON) {
    throw new Error(
      `exposure allocator: the RSI brake capped the target at ${currentExposurePercent}% but the ` +
        `feasible projection raised it to ${projectedPercent}%. A braked bar may hold or reduce ` +
        'exposure, never increase it.',
    );
  }

  // ── 3. nominal targets from the FIXED basket ──────────────────────────────────────
  const nominal: Record<string, number> = {};
  for (const asset of cfg.assets) {
    nominal[asset] = (projectedPercent * (cfg.basket[asset] ?? 0)) / 100;
  }

  const byAsset = new Map(lines.map((l) => [l.asset, l]));
  const targets: Record<string, number> = {};
  const deviations: LineDeviation[] = [];
  const droppedByFloor: string[] = [];

  for (const asset of cfg.assets) {
    const line = byAsset.get(asset);
    const current = line?.currentPercent ?? 0;
    const want = nominal[asset]!;
    const cap = cfg.caps[asset] ?? 0;

    if (!line) {
      // Not in the book and not constrained: treat as a flat, fully actionable line.
      targets[asset] = Math.min(want, cap);
      continue;
    }

    // ── 3b. THE DETERMINISTIC STOP, ahead of every other per-line rule ───────────────
    //
    // Evaluated before the freeze and before the floor because in production it outranks
    // both: it is rung 1 of the gate's ladder, and it is floor-exempt. Its shortfall against
    // the nominal target is journaled under its own cause and is NEVER redistributed.
    if (line.forceExit) {
      targets[asset] = 0;
      if (want > 0) deviations.push({ asset, cause: 'stop', signedPercent: -want });
      continue;
    }

    // ── 4. a line we may not move in the required direction stays EXACTLY where it is ──
    const needsIncrease = want > current;
    const needsReduction = want < current;
    if ((needsIncrease && !line.canIncrease) || (needsReduction && !line.canReduce)) {
      targets[asset] = current;
      if (Math.abs(current - want) > 0) {
        deviations.push({
          asset,
          // `stop_exit` and `risk_off` are overrides that OPEN a direction, so a line
          // blocked here is blocked by the gate itself or by a missing regime.
          cause: 'frozen',
          signedPercent: current - want,
        });
      }
      continue;
    }

    // ── 5. move toward the nominal target, under the cap ──────────────────────────────
    let target = want;
    if (target > cap) {
      target = cap;
      deviations.push({ asset, cause: 'cap', signedPercent: target - want });
    }

    // The movement floor: a move too small to be worth its fees is not made at all. The
    // line then stays where it is, which is itself a deviation and is journaled as one.
    const move = Math.abs(target - current);
    if (move > 0 && move < cfg.minMovementPercent) {
      droppedByFloor.push(asset);
      deviations.push({ asset, cause: 'floor', signedPercent: current - target });
      targets[asset] = current;
      continue;
    }

    targets[asset] = target;
  }

  // ── 6. NO redistribution. Whatever was not reached stays unreached. ────────────────
  // ── 7. publish the signed gap ─────────────────────────────────────────────────────
  const reachedPercent = Object.values(targets).reduce((sum, weight) => sum + weight, 0);

  // A move dropped by the floor while the book sat on a band edge is worth flagging: it is
  // the case where the floor, not the policy, decided the exposure.
  const onEdge =
    Math.abs(currentExposurePercent - band.lowPercent) < cfg.minMovementPercent ||
    Math.abs(currentExposurePercent - band.highPercent) < cfg.minMovementPercent;

  return {
    bandTargetPercent,
    projectedPercent,
    reachedPercent,
    gapPercent: reachedPercent - projectedPercent,
    targets,
    deviations,
    interval,
    rsiBraked: braked.braked,
    droppedByFloor,
    droppedAtBandEdge: droppedByFloor.length > 0 && onEdge,
  };
}
