import { Decimal } from '../../money.js';
import type { BandPolicy } from './controller.js';
import { validateBandPolicy } from './controller.js';
import type { ExperimentConfig } from './config.js';
import type { AssetTape, EngineResult, EngineState, ExposurePolicy } from './engine.js';
import { runReplay, STARTING_CASH_USD, type FreezeMode } from './engine.js';
import { computeMetrics, WITNESS_EXPOSURE_TOLERANCE_POINTS, type Metrics } from './metrics.js';
import type { RegimePoint } from '../../market/regime.js';

/**
 * THE ARMS, THE CONTROLS, AND THE WITNESS SEARCH.
 *
 * ═══ WHY EACH ARM NEEDS ITS OWN WITNESS, AND WHY IT MUST BE SEARCHED ═══
 *
 * Comparing an arm to "20 % constant" would compare two things that differ in TWO ways at
 * once: the controller, and the average amount of market risk carried. The second dominates
 * in a rising market, so the comparison would mostly measure beta and call it skill.
 *
 * The fix is a witness carrying the SAME average exposure. But a constant TARGET does not
 * mechanically produce that average: the gate freezes lines, the stop exits them, and the
 * 2 % floor drops small moves — so a 60 % target realises something else. Hence a search:
 * try every target from 0 to 100 in 0.25-point steps, replay the whole calibration for
 * each, and keep the one whose REALISED mean exposure sits closest to the arm's.
 *
 * Ties go to the LOWEST target. A tie means two targets are equally well matched on
 * exposure; picking the lower one makes the witness the more conservative of the two, so the
 * excess it concedes to the arm is the smaller, harder-earned one.
 *
 * If nothing lands inside the pre-registered 0.25-point tolerance, the witness is declared
 * UNSOUND and no excess-of-CAGR claim may rest on it. That verdict is recorded, not hidden.
 */

/** The three bands, exactly as the protocol fixes them. No cash floor, caps unchanged. */
export const ARMS: Readonly<Record<string, BandPolicy>> = Object.freeze({
  A: {
    defensive: { lowPercent: 0, highPercent: 20 },
    neutral: { lowPercent: 20, highPercent: 45 },
    constructive: { lowPercent: 45, highPercent: 70 },
  },
  B: {
    defensive: { lowPercent: 0, highPercent: 25 },
    neutral: { lowPercent: 35, highPercent: 60 },
    constructive: { lowPercent: 65, highPercent: 90 },
  },
  C: {
    defensive: { lowPercent: 0, highPercent: 30 },
    neutral: { lowPercent: 50, highPercent: 75 },
    constructive: { lowPercent: 85, highPercent: 100 },
  },
});

/**
 * The deterministic 20 % baseline.
 *
 * NEVER call this "the current policy". The current policy runs through the model, is not
 * replayable, and nothing here reproduces it. This is a constant-exposure control that
 * happens to sit near where the bot has been idling — a reference point, not a re-enactment.
 */
export const BASELINE_TARGET_PERCENT = 20;

/** Exhaustive grid: 0 → 100 by 0.25. 401 targets, as the protocol specifies. */
export const WITNESS_STEP_PERCENT = 0.25;
export const WITNESS_TARGETS: readonly number[] = Object.freeze(
  Array.from({ length: 401 }, (_, i) => Number((i * WITNESS_STEP_PERCENT).toFixed(2))),
);

/** Everything a replay needs that does not depend on the policy. Computed once, shared. */
export interface SharedTape {
  cfg: ExperimentConfig;
  points: RegimePoint[];
  tapes: Record<string, AssetTape>;
  barMs: number;
}

export interface WindowBounds {
  fromMs: number;
  toMs: number;
}

export interface RunOutcome {
  metrics: Metrics;
  result: EngineResult;
}

export function runPolicy(
  shared: SharedTape,
  policy: ExposurePolicy,
  window: WindowBounds,
  resume?: EngineState,
): RunOutcome {
  const result = runReplay({
    cfg: shared.cfg,
    points: shared.points,
    tapes: shared.tapes,
    barMs: shared.barMs,
    policy,
    fromMs: window.fromMs,
    toMs: window.toMs,
    resume,
  });
  return { metrics: computeMetrics(result, shared.cfg.assets), result };
}

export interface WitnessSelection {
  /** The constant target retained, in percent. */
  targetPercent: number;
  /** Realised mean exposure of that target over the calibration window. */
  realisedMeanExposurePercent: number;
  /** |witness realised − arm realised|, in points. */
  mismatchPoints: number;
  /** False when no target reached the pre-registered tolerance. */
  isSound: boolean;
  /** How many targets were evaluated — published so a silent cap would be visible. */
  targetsEvaluated: number;
}

/**
 * THE EXHAUSTIVE SEARCH. No early exit, no bisection, no sampling.
 *
 * A monotonic assumption would be tempting — more target, more realised exposure — and it is
 * not safe: the stop and the freeze make the mapping lumpy, and a bisection could settle in
 * a local pocket. The protocol allows an optimisation only after it has been proven, on at
 * least one arm, to return EXACTLY the exhaustive answer. Until then this stays brute force,
 * and `targetsEvaluated` is published so a silent truncation could never pass for coverage.
 */
export function searchConstantWitness(
  shared: SharedTape,
  window: WindowBounds,
  armMeanExposurePercent: number,
  /**
   * The gate variant the arm ran under. The witness MUST share it: the freeze is mechanics,
   * and a symmetric witness paired with an asymmetric arm would introduce a second difference
   * into a comparison whose whole job is to isolate one.
   */
  freeze: FreezeMode = 'symmetric',
): WitnessSelection {
  let best: { target: number; realised: number; mismatch: number } | null = null;

  for (const target of WITNESS_TARGETS) {
    const { metrics } = runPolicy(shared, { kind: 'constant', targetPercent: target, freeze }, window);
    const realised = metrics.meanExposurePercent;
    const mismatch = Math.abs(realised - armMeanExposurePercent);
    // Strictly-better keeps the FIRST target on a tie, and the grid ascends — so a tie
    // resolves to the lowest target without a special case.
    if (best == null || mismatch < best.mismatch) {
      best = { target, realised, mismatch };
    }
  }

  if (best == null) throw new Error('witness search: the target grid was empty');
  return {
    targetPercent: best.target,
    realisedMeanExposurePercent: best.realised,
    mismatchPoints: best.mismatch,
    isSound: best.mismatch <= WITNESS_EXPOSURE_TOLERANCE_POINTS,
    targetsEvaluated: WITNESS_TARGETS.length,
  };
}

/**
 * THE EQUAL-WEIGHT REPÈRE — 25 % per asset, bought once, never rebalanced.
 *
 * An EXTERNAL reference only. It does NOT respect the bot's per-asset caps (BTC 35 / ETH 35
 * / BNB 20 / XRP 15), so it is allowed an allocation the bot could never hold. That sentence
 * must accompany its number everywhere it is quoted, or it reads as a like-for-like
 * comparison that the caps alone make impossible.
 *
 * Bought at the first EXECUTABLE price after the evaluation window opens — the open of the
 * bar following the first evaluated bar, the same t+1 rule as everything else — with the
 * same fee and slippage.
 */
/** One bar of the equal-weight reference: fixed quantities, marked at the bar's close. */
export interface EqualWeightBar {
  timestamp: number;
  at: string;
  equity: number;
  /** Weight per asset, in percent — they DRIFT, since nothing is ever rebalanced. */
  weights: Record<string, number>;
}

export function equalWeightBuyAndHold(shared: SharedTape, window: WindowBounds): {
  openingEquity: number;
  closingEquity: number;
  netReturnPercent: number;
  /**
   * The per-bar trajectory, so this number is auditable like every other published one.
   *
   * It is a witness the protocol names, its result appears in the summary, and a figure that
   * cannot be traced back to a trajectory is a figure a reader has to take on trust. Cheap to
   * produce: the quantities never change, so a bar is one multiplication per asset.
   */
  bars: EqualWeightBar[];
} {
  const { cfg, tapes } = shared;
  const weight = new Decimal(1).div(cfg.assets.length);
  const feeRate = new Decimal(cfg.feePercentPerLeg).div(100);
  const slipRate = new Decimal(cfg.slippagePercentPerLeg).div(100);

  // The first bar inside the window that every asset shares, then its SUCCESSOR's open.
  let entryIndex: Record<string, number> | null = null;
  for (const point of shared.points) {
    if (point.timestamp < window.fromMs || point.timestamp >= window.toMs) continue;
    const idx: Record<string, number> = {};
    let ok = true;
    for (const asset of cfg.assets) {
      const i = tapes[asset]!.indexByTimestamp.get(point.timestamp);
      if (i == null || tapes[asset]!.h4[i + 1] == null) {
        ok = false;
        break;
      }
      idx[asset] = i + 1;
    }
    if (ok) {
      entryIndex = idx;
      break;
    }
  }
  if (!entryIndex) {
    throw new Error('equal-weight repère: no executable entry bar inside the window');
  }

  const cash = new Decimal(STARTING_CASH_USD);
  const qty: Record<string, Decimal> = {};
  for (const asset of cfg.assets) {
    const open = new Decimal(tapes[asset]!.h4[entryIndex[asset]!]!.open);
    const spend = cash.times(weight);
    const net = spend.minus(spend.times(feeRate));
    qty[asset] = net.div(open.times(new Decimal(1).plus(slipRate)));
  }

  // The trajectory, marked bar by bar on the SAME grid every other run uses. Nothing is
  // rebalanced, so the weights drift — which is itself part of what this reference shows.
  const bars: EqualWeightBar[] = [];
  let closing = new Decimal(0);
  // The instant the quantities actually exist: the OPEN of the successor bar. Every bar
  // before it must show CASH, not the future position marked against a past close.
  const entryTimestamp = tapes[cfg.assets[0]!]!.h4[entryIndex[cfg.assets[0]!]!]!.timestamp;
  for (const point of shared.points) {
    if (point.timestamp < window.fromMs || point.timestamp >= window.toMs) continue;

    /*
     * BEFORE THE ENTRY BAR, THE BOOK IS CASH.
     *
     * The quantities are bought at the successor bar's open — the same t+1 rule as every other
     * run — so marking them against an earlier close would show a fully invested portfolio one
     * bar before it exists. The closing return is unaffected, but the audit trajectory would be
     * temporally invalid: it is the one artefact whose job is to let a reader reconstruct what
     * happened, and it would start by showing a position that had not been bought.
     */
    if (point.timestamp < entryTimestamp) {
      bars.push({
        timestamp: point.timestamp,
        at: new Date(point.timestamp).toISOString(),
        equity: STARTING_CASH_USD,
        weights: Object.fromEntries(cfg.assets.map((asset) => [asset, 0])),
      });
      continue;
    }

    let equity = new Decimal(0);
    const value: Record<string, Decimal> = {};
    let complete = true;
    for (const asset of cfg.assets) {
      const i = tapes[asset]!.indexByTimestamp.get(point.timestamp);
      const candle = i == null ? undefined : tapes[asset]!.h4[i];
      if (!candle) {
        complete = false;
        break;
      }
      value[asset] = qty[asset]!.times(new Decimal(candle.close));
      equity = equity.plus(value[asset]!);
    }
    // A bar where any asset is missing is skipped whole, exactly as the engine does.
    if (!complete) continue;
    const weights: Record<string, number> = {};
    for (const asset of cfg.assets) {
      weights[asset] = equity.gt(0) ? value[asset]!.div(equity).times(100).toNumber() : 0;
    }
    bars.push({
      timestamp: point.timestamp,
      at: new Date(point.timestamp).toISOString(),
      equity: equity.toNumber(),
      weights,
    });
    closing = equity;
  }
  if (bars.length === 0) throw new Error('equal-weight repère: no valued bar inside the window');

  const opening = STARTING_CASH_USD;
  return {
    openingEquity: opening,
    closingEquity: closing.toNumber(),
    netReturnPercent: closing.minus(opening).div(opening).times(100).toNumber(),
    bars,
  };
}

/** Bounds every arm at startup, loudly, before a single bar is replayed. */
export function validateArms(): void {
  for (const [name, policy] of Object.entries(ARMS)) validateBandPolicy(name, policy);
  if (WITNESS_TARGETS.length !== 401) {
    throw new Error(`witness grid must hold 401 targets, holds ${WITNESS_TARGETS.length}`);
  }
  const last = WITNESS_TARGETS[WITNESS_TARGETS.length - 1];
  if (WITNESS_TARGETS[0] !== 0 || last !== 100) {
    throw new Error(`witness grid must span [0, 100], spans [${WITNESS_TARGETS[0]}, ${last}]`);
  }
}
