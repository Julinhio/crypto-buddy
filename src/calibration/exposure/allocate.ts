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
}

/** The aggregate interval, recomputed per direction of travel. */
export interface FeasibleInterval {
  lowPercent: number;
  highPercent: number;
}

/**
 * THE FEASIBLE INTERVAL, for ONE direction of travel.
 *
 *   low  = Σ weights of the lines we may not REDUCE   (the floor we are stuck above)
 *   high = min(100, that floor + Σ caps of the lines we may INCREASE)
 *
 * Recomputed per direction, and that is load-bearing rather than tidy. `risk_off` is exactly
 * the case: it freezes increases while explicitly ALLOWING reductions. Treating a line as
 * immovable in both directions — the obvious reading of "frozen" — would make the harness
 * refuse to sell precisely when the production posture demands selling, and the defensive
 * band would then be unreachable by construction.
 *
 * `direction` is the move the caller is trying to make. A line only pins the floor if it
 * cannot be reduced; it only lifts the ceiling if it can be increased.
 */
export function feasibleInterval(
  lines: readonly LineConstraint[],
  caps: Readonly<Record<string, number>>,
): FeasibleInterval {
  let floor = 0;
  let headroom = 0;
  for (const line of lines) {
    if (!line.canReduce) floor += line.currentPercent;
    if (line.canIncrease) {
      const cap = caps[line.asset] ?? 0;
      // A line already above its cap contributes no headroom; it cannot be bought further.
      headroom += Math.max(0, cap - line.currentPercent);
    }
  }
  return { lowPercent: floor, highPercent: Math.min(100, floor + headroom) };
}

export function projectOntoFeasible(targetPercent: number, interval: FeasibleInterval): number {
  if (targetPercent < interval.lowPercent) return interval.lowPercent;
  if (targetPercent > interval.highPercent) return interval.highPercent;
  return targetPercent;
}

/** Why a line failed to reach its nominal target. Both signs use the same vocabulary. */
export type DeviationCause = 'frozen' | 'cap' | 'floor';

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
  const projectedPercent = projectOntoFeasible(bandTargetPercent, interval);

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
