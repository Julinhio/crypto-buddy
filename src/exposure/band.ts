import type { Band, BandPolicy, ContextState } from '../calibration/exposure/controller.js';
import type { TransitionGate } from '../transition/gate.js';

/**
 * THE EXPOSURE BAND — the arithmetic of the pilot, and nothing else.
 *
 * PURE: no I/O, no clock, no config lookup, no model. Every input is passed in, exactly as
 * `transition/gate.ts` is, and for the same reason: the live cycle and the historical replay
 * must run the SAME function over the SAME inputs, or the checkpoint would be measuring a
 * re-implementation agreeing with itself.
 *
 * ── WHAT THIS BRICK DOES, AND WHAT IT DELIBERATELY DOES NOT ────────────────────────────
 *
 * It ASSESSES. Given the context state, the band, the target the chain retained and what the
 * transition layer says about each line, it answers three questions:
 *
 *   1. is the target inside the band, below its floor, or above its ceiling;
 *   2. by how many points would it have to move;
 *   3. how much of that move is even POSSIBLE, once the freezes and the per-asset caps have
 *      had their say.
 *
 * It does NOT redistribute. The per-asset arithmetic of §3.5 and §3.6 — proportional to the
 * model's positive targets, then the equal-weight fallback, then the sub-floor consolidation —
 * is brick 2. Keeping them apart is what makes the checkpoint honest: the bite can be
 * published, read and argued with before a single line of correction exists, which is the
 * whole point of stopping here.
 *
 * ── THE THIRD QUESTION IS NOT A DETAIL ─────────────────────────────────────────────────
 *
 * Arbitrated: the code may not create a buy or a sell on a line the transition layer calls
 * frozen, REGARDLESS of `TRANSITION_MODE`. That constraint binds the correction's own
 * movements only — it does not turn the gate into `enforce` and it does not touch the model's
 * raw vector. The consequence is measured, not assumed: on the v5 history the floor is
 * unreachable on roughly one cycle in ten, and on some cycles no line is actionable at all.
 * A band that quietly gave up on those would report a policy nobody ran.
 */

/** The vector-level label, exactly the four the protocol fixes. */
export type BandCorrectionLabel =
  | 'aucune_correction'
  | 'hausse_vers_plancher'
  | 'baisse_vers_plafond'
  | 'bande_partiellement_irrealisable';

/** Which way the band would push the target, before feasibility is considered. */
export type BandDirection = 'none' | 'up' | 'down';

/**
 * WHAT THE CODE MAY DO TO ONE LINE, derived from the transition layer's own ladder.
 *
 * This is a translation of `judgeOrder`, not a second opinion on it, and the mapping is
 * deliberately stricter than what the model is allowed today:
 *
 *   `actionable`          the layer cleared the line — the correction may move it either way;
 *   `risk_off_reduction`  the override lifts the freeze FOR REDUCTIONS ONLY, so the
 *                         correction may sell and may not buy. Exactly `judgeOrder`'s rule;
 *   `frozen`              a transition is in progress — no code-generated order, either way;
 *   `no_regime`           the layer has nothing to judge on. It FAILS CLOSED here, mirroring
 *                         `applyGate`'s treatment of an unjudged strategic leg: absence of a
 *                         reading is not permission, least of all for an order the code
 *                         invents rather than one the model asked for;
 *   `stop_exit`           the line is being taken to zero. The correction neither adds to it
 *                         nor sells it — the stop owns that line for the cycle.
 */
export interface LineCapability {
  mayIncrease: boolean;
  mayDecrease: boolean;
}

export function capabilityOf(gate: TransitionGate): LineCapability {
  switch (gate) {
    case 'actionable':
      return { mayIncrease: true, mayDecrease: true };
    case 'risk_off_reduction':
      return { mayIncrease: false, mayDecrease: true };
    case 'frozen':
    case 'no_regime':
    case 'stop_exit':
      return { mayIncrease: false, mayDecrease: false };
  }
}

/** One line, as the assessment sees it. Published per asset so a verdict is never inferred. */
export interface BandLineView {
  asset: string;
  /**
   * The weight the CHAIN will pursue on this line, in percent of equity.
   *
   * Equal to the clamped target's weight, except on a `stop_exit` line under `enforce`, where
   * `applyGate` is about to put the line flat: counting the model's weight there would size
   * the band against exposure the cycle is in the middle of liquidating.
   */
  weightPercent: number;
  /** The clamped target's own weight, before the stop is accounted for. */
  targetWeightPercent: number;
  /** The layer's verdict for this line this cycle. Null when the layer produced none. */
  gate: TransitionGate | null;
  mayIncrease: boolean;
  mayDecrease: boolean;
  /** The per-asset cap that bounds any increase on this line. */
  capPercent: number;
}

export interface BandFeasibility {
  /**
   * FALSE when the transition layer produced no verdict at all for this cycle.
   *
   * Live, this cannot happen: `decide()` computes a verdict per tradable asset before the
   * model is even called. It happens in the HISTORICAL REPLAY, over the fortnight of v5 that
   * predates the transition layer — and there, "every line is unjudged" is a fact about the
   * journal, not about the market.
   *
   * Without this flag those cycles would carry `bande_partiellement_irrealisable`, which
   * ASSERTS something nobody can know: that the freezes blocked the correction. They did not;
   * we simply have no record of what they said. So the feasibility numbers are nulled out
   * rather than computed on an empty verdict set, and the label keeps to the direction.
   */
  known: boolean;
  /** Lines the correction may buy. */
  increasableAssets: string[];
  /** Lines the correction may sell. */
  decreasableAssets: string[];
  /**
   * Weight the correction cannot lift off the floor with, because those lines may not rise.
   * The starting point of any upward move.
   */
  reservedUpPercent: number | null;
  /**
   * Weight the correction cannot shed, because those lines may not fall. The floor under any
   * downward move — clause 3 of §3.6, stated as a number rather than as a special case.
   */
  reservedDownPercent: number | null;
  /** Highest total exposure the correction could reach: reserved + every cap it may use. */
  maxReachablePercent: number | null;
  /** Lowest total exposure it could reach: what it may not sell. */
  minReachablePercent: number | null;
  /**
   * Where the correction would actually land — the band bound, pulled back to what is
   * reachable. Equals `targetExposurePercent` when no correction is due.
   */
  attainableExposurePercent: number | null;
  /**
   * Points still outside the band after the maximum feasible correction. Zero when the band
   * is fully reachable; strictly positive is the §3.4.4 case, and it is journaled rather than
   * waited out.
   */
  unrealisablePoints: number | null;
  /** Assets carrying weight that the layer produced no verdict for. Fails closed, and named. */
  unjudgedAssets: string[];
}

export interface BandAssessment {
  policyVersion: string;
  state: ContextState;
  band: Band;
  /** Σ of the non-reserve weights of the chain's target — never `100 − reserve`. */
  targetExposurePercent: number;
  /** The same sum on the model's RAW proposal, before the risk clamp. */
  rawExposurePercent: number | null;
  /** The book's exposure BEFORE this cycle's decision. Null when the book was not journaled. */
  bookExposurePercent: number | null;
  /** The allocation's own total. Published beside the exposure — see `exposureOf`. */
  targetSumPercent: number;
  /** Weight sitting on lines a peak stop is exiting this cycle. Zero on nearly every cycle. */
  stoppedWeightPercent: number;
  direction: BandDirection;
  /** The band bound the target would be moved to. Null when it is already inside. */
  requiredExposurePercent: number | null;
  /** |required − target|, in points. Zero when no correction is due. */
  requiredPoints: number;
  feasibility: BandFeasibility;
  label: BandCorrectionLabel;
  /** The feasible move in quote currency, at this cycle's equity. Null when feasibility is unknown. */
  attainableNotionalQuote: number | null;
  /** The per-leg plumbing floor this cycle, in quote — `movementFloor(equity, 2%)`. */
  movementFloorQuote: number;
  /**
   * Whether the feasible move is at least one plumbing floor.
   *
   * NECESSARY, NOT SUFFICIENT, and the distinction has to survive into the report. A total
   * below one floor can produce no leg at all, so `false` here means the correction is
   * certainly inert. `true` does not mean it will trade: split across four lines, a move
   * worth 2.5 floors still yields four sub-floor legs and nothing sent. Which of the two it
   * is depends on the redistribution, and the redistribution is brick 2.
   */
  clearsMovementFloor: boolean | null;
  lines: BandLineView[];
}

const POINT_DP = 6;

function round(value: number): number {
  return Number(value.toFixed(POINT_DP));
}

/**
 * THE EXPOSURE OF AN ALLOCATION: the sum of its non-reserve weights.
 *
 * Never `100 − reserve`. The two coincide as soon as the allocation totals 100 — which the
 * output schema imposes on every fresh line, and which all 884 v5 rows satisfy — and when
 * they diverge it is the SUM that is honest: subtracting from a hundred that does not exist
 * fabricates exposure. The total is published alongside so the divergence, if it ever
 * appears, is visible rather than absorbed.
 */
export function exposureOf(
  allocation: Record<string, number>,
  reserveAsset: string,
): { exposurePercent: number; sumPercent: number } {
  let exposure = 0;
  let sum = 0;
  for (const [asset, weight] of Object.entries(allocation)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight)) continue;
    sum += weight;
    if (asset !== reserveAsset) exposure += weight;
  }
  return { exposurePercent: round(exposure), sumPercent: round(sum) };
}

/** The band for a context state. A thin alias, so call sites read as the protocol does. */
export function bandOf(policy: BandPolicy, state: ContextState): Band {
  return policy[state];
}

export interface AssessBandInput {
  policyVersion: string;
  policy: BandPolicy;
  state: ContextState;
  /** The target the chain retained — the risk-clamped proposal. */
  targetAllocation: Record<string, number>;
  /** The model's raw proposal, for the published comparison. Null on a cycle without one. */
  rawAllocation: Record<string, number> | null;
  /** The book's exposure before the decision, in percent. Null when it was not journaled. */
  bookExposurePercent: number | null;
  reserveAsset: string;
  /** The transition layer's gate per asset, exactly the verdicts the cycle computed. */
  gateByAsset: ReadonlyMap<string, TransitionGate>;
  /** The per-asset cap, resolved the same way the risk wrapper resolves it. */
  capOf: (asset: string) => number;
  /** `100 − caps.minCashPercent` — the ceiling the cash floor already imposes. */
  maxDeployablePercent: number;
  /** This cycle's equity, in quote. Used only to express the move in money. */
  equityQuote: number;
  /** `movementFloor(equity, minMovementPercent)` — passed in, never recomputed here. */
  movementFloorQuote: number;
  /**
   * Does a peak-stopped line keep its weight this cycle?
   *
   * True under `observe`, where the stop generates no exit and the model's weight stands;
   * false under `enforce`, where `applyGate` is about to put the line flat. The band has to
   * know which, because the two produce different exposures for the same target — and
   * guessing would size the correction against a book that is being liquidated underneath it.
   */
  stoppedWeightSurvives: boolean;
}

/**
 * Assesses one cycle against its band. Pure and total: same inputs, same output, never throws.
 *
 * Total on purpose. It is called from an observation path whose entire safety property is
 * that it cannot fail a cycle, so a malformed input becomes a reported fact — an unjudged
 * asset, a non-finite weight skipped — rather than an exception that would take a trading
 * wake-up down with it.
 */
export function assessBand(input: AssessBandInput): BandAssessment {
  const band = bandOf(input.policy, input.state);
  const {
    targetAllocation,
    reserveAsset,
    gateByAsset,
    capOf,
    stoppedWeightSurvives,
  } = input;

  const lines: BandLineView[] = [];
  const unjudged: string[] = [];
  let stoppedWeight = 0;

  /**
   * THE LINES ARE THE UNION of what the target names and what the layer judged — not the
   * allocation's keys alone.
   *
   * An asset the model left at zero is still a line the correction may buy into: §3.5.3's
   * fallback allocates precisely to "les autres actifs actionnables disposant de capacité",
   * which is that set. Building the list from the allocation alone would silently drop the
   * capacity of any asset the model did not mention, understating what the band can reach and
   * manufacturing shortfalls out of the model's own silence.
   *
   * Today production emits a weight for every allocatable asset, so the union changes nothing
   * live. It is the union anyway, because "the schema happens to guarantee it" is not a reason
   * for the arithmetic to depend on it.
   */
  const lineAssets = [
    ...new Set([...Object.keys(targetAllocation), ...gateByAsset.keys()]),
  ]
    .filter((asset) => asset !== reserveAsset)
    .sort();

  for (const asset of lineAssets) {
    const raw = targetAllocation[asset];
    // A non-finite weight is skipped rather than coerced. `Number(undefined)` is NaN and
    // `Number(null)` is 0, and the second is the dangerous one: it would publish a real,
    // zero-weight line and quietly shrink the exposure the band is measured against.
    const targetWeight = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    const gate = gateByAsset.get(asset) ?? null;
    // FAIL CLOSED on a line the layer never judged. The universe the gate walks and the
    // universe the allocation covers are the same list today; if they ever diverge, the
    // correction must not be the thing that discovers it by trading into the gap.
    const capability = gate == null ? { mayIncrease: false, mayDecrease: false } : capabilityOf(gate);
    if (gate == null && targetWeight !== 0) unjudged.push(asset);

    const stopped = gate === 'stop_exit';
    if (stopped) stoppedWeight += targetWeight;
    const weight = stopped && !stoppedWeightSurvives ? 0 : targetWeight;

    lines.push({
      asset,
      weightPercent: round(weight),
      targetWeightPercent: round(targetWeight),
      gate,
      mayIncrease: capability.mayIncrease,
      mayDecrease: capability.mayDecrease,
      // Never below the weight already held: the risk wrapper has already bounded this line,
      // so a cap under it would mean the two disagree — and the band must not react to that
      // by demanding a reduction the caps never asked for.
      capPercent: round(Math.max(capOf(asset), weight)),
    });
  }

  const targetExposure = round(lines.reduce((sum, line) => sum + line.weightPercent, 0));
  const { sumPercent } = exposureOf(targetAllocation, reserveAsset);

  // ── FEASIBILITY, in two sums ──────────────────────────────────────────────────────
  //
  // Upward: the lines that may not rise keep their weight, and the ones that may rise can go
  // as far as their cap. Bounded by the deployable ceiling, because the cash floor is a
  // constraint the correction inherits rather than one it may spend.
  //
  // Downward: the lines that may not fall keep their weight, and that sum IS the floor under
  // any reduction. When it alone sits above the band's ceiling, §3.6.3 applies — every
  // authorised reduction still runs, and the residue is journaled.
  let reservedUp = 0;
  let capacityUp = 0;
  let reservedDown = 0;
  for (const line of lines) {
    if (line.mayIncrease) capacityUp += line.capPercent;
    else reservedUp += line.weightPercent;
    if (!line.mayDecrease) reservedDown += line.weightPercent;
  }
  const maxReachable = round(Math.min(reservedUp + capacityUp, input.maxDeployablePercent));
  const minReachable = round(reservedDown);

  /**
   * FEASIBILITY IS ONLY KNOWABLE WITH VERDICTS. See `BandFeasibility.known`.
   *
   * With an empty verdict set every line reads as unjudged and every sum collapses to "nothing
   * is possible" — which, on the fortnight of v5 that predates the transition layer, would put
   * `bande_partiellement_irrealisable` on cycles whose freezes nobody recorded. That label
   * asserts the freezes blocked the correction. They may not have; we do not know.
   */
  const known = gateByAsset.size > 0;

  let direction: BandDirection = 'none';
  let required: number | null = null;
  let attainable = targetExposure;
  if (targetExposure < band.lowPercent) {
    direction = 'up';
    required = band.lowPercent;
    // Never below where we already are: an unreachable floor leaves the target where it is
    // rather than dragging it down to a "maximum" computed for the other direction.
    attainable = round(Math.max(Math.min(band.lowPercent, maxReachable), targetExposure));
  } else if (targetExposure > band.highPercent) {
    direction = 'down';
    required = band.highPercent;
    attainable = round(Math.min(Math.max(band.highPercent, minReachable), targetExposure));
  }
  if (!known) attainable = targetExposure;

  const unrealisable = !known || required == null ? null : round(Math.abs(required - attainable));
  const label: BandCorrectionLabel =
    direction === 'none'
      ? 'aucune_correction'
      : unrealisable != null && unrealisable > 0
        ? 'bande_partiellement_irrealisable'
        : direction === 'up'
          ? 'hausse_vers_plancher'
          : 'baisse_vers_plafond';

  const attainableNotional = known
    ? round((Math.abs(attainable - targetExposure) * input.equityQuote) / 100)
    : null;

  return {
    policyVersion: input.policyVersion,
    state: input.state,
    band,
    targetExposurePercent: targetExposure,
    rawExposurePercent:
      input.rawAllocation == null ? null : exposureOf(input.rawAllocation, reserveAsset).exposurePercent,
    bookExposurePercent: input.bookExposurePercent,
    targetSumPercent: sumPercent,
    stoppedWeightPercent: round(stoppedWeight),
    direction,
    requiredExposurePercent: required,
    requiredPoints: required == null ? 0 : round(Math.abs(required - targetExposure)),
    feasibility: {
      known,
      increasableAssets: lines.filter((l) => l.mayIncrease).map((l) => l.asset),
      decreasableAssets: lines.filter((l) => l.mayDecrease).map((l) => l.asset),
      // Nulled rather than zeroed when unknown. A zero here would read as "the correction can
      // reach nothing", which is a measurement; the truth is that nothing was measured.
      reservedUpPercent: known ? round(reservedUp) : null,
      reservedDownPercent: known ? minReachable : null,
      maxReachablePercent: known ? maxReachable : null,
      minReachablePercent: known ? minReachable : null,
      attainableExposurePercent: known ? attainable : null,
      unrealisablePoints: unrealisable,
      unjudgedAssets: unjudged.sort(),
    },
    label,
    attainableNotionalQuote: attainableNotional,
    movementFloorQuote: round(input.movementFloorQuote),
    clearsMovementFloor:
      attainableNotional == null ? null : attainableNotional >= input.movementFloorQuote && attainableNotional > 0,
    lines,
  };
}
