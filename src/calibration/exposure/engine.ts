import { Decimal } from '../../money.js';
import type { RegimePoint } from '../../market/regime.js';
import type { StickyPoint } from '../../market/transition.js';
import { evaluateTransition } from '../../transition/gate.js';
import { stickyAtBar } from '../../market/transition.js';
import type { Candle } from '../../market/klines.js';
import type { ExperimentConfig } from './config.js';
import { readContext, type BandPolicy, type ContextState } from './controller.js';
import { allocate, type LineConstraint, type LineDeviation } from './allocate.js';

/**
 * THE REPLAY ENGINE — deterministic, offline, and deliberately modest about what it proves.
 *
 * READ `README.md` IN THIS FOLDER BEFORE READING A RESULT. The model is not in this
 * experiment. What runs here is a context controller applied to a PROXY allocator, where
 * production applies a constraint on top of a model. The question this engine answers is
 * whether the controller improves return-per-unit-risk against a comparable constant
 * exposure, under that proxy — not whether the bot has an edge.
 *
 * ═══ THE TWO RULES THAT KEEP IT HONEST ═══
 *
 * NO LOOK-AHEAD. The signal is computed on the CLOSE of bar `i`; the order executes at the
 * OPEN of bar `i+1`. Those are the same instant on the clock and two different prices, and
 * that difference is the whole point: at the moment the bot learns bar `i`'s close, that
 * close is no longer a price it can trade at. Filling on it is the most comfortable lie a
 * backtest can tell itself.
 *
 * NO INVENTED BARS. The 4h series carries the Binance outage of 19/02/2020 as a hole. "Next
 * bar" is therefore the next bar IN THE SERIES, not `t + 4h`. A signal with no following bar
 * at all — the end of the bundle — produces no order and is counted as
 * `pending_not_executed`, never filled on a substitute close.
 */

/** One asset's tactical series plus the sticky timeline production computed for it. */
export interface AssetTape {
  h4: Candle[];
  sticky: StickyPoint[];
  /** Index of each bar timestamp, so a lookup is O(1) rather than a scan per bar. */
  indexByTimestamp: Map<number, number>;
}

export interface EngineInput {
  cfg: ExperimentConfig;
  /** The regime timeline production computed, warmed from `fetchStart`. */
  points: RegimePoint[];
  tapes: Record<string, AssetTape>;
  barMs: number;
  /** The exposure policy: a band per context state, or a constant target. */
  policy: ExposurePolicy;
  /** Inclusive lower bound of the evaluation window (ms). */
  fromMs: number;
  /** EXCLUSIVE upper bound (ms). */
  toMs: number;
  /** Where to resume from. Absent = the closed initial conditions (1000$ cash, flat). */
  resume?: EngineState;
}

/**
 * How the individual freeze behaves.
 *
 *   'symmetric'  — production's gate, unchanged: a frozen line moves in neither direction.
 *   'asymmetric' — the freeze applies to SELLS ONLY: a frozen line may be reinforced but not
 *                  reduced.
 *
 * The deterministic stop and the reduction under a confirmed `risk_off` are IDENTICAL in
 * both, which is what makes the comparison a test of the freeze rather than of the ladder:
 * both variants keep every deterministic exit exactly as production has it.
 */
export type FreezeMode = 'symmetric' | 'asymmetric';

/**
 * Either a context-driven band (an arm) or a flat target (a constant witness / the
 * deterministic 20 % baseline). Both travel through the SAME allocation sequence, the same
 * gate, the same stops and the same movement floor — which is what makes the difference
 * between them attributable to the controller rather than to the plumbing.
 */
export type ExposurePolicy =
  | { kind: 'band'; bands: BandPolicy; rsiBrake?: boolean; freeze?: FreezeMode }
  /**
   * The constant-exposure control.
   *
   * It deliberately carries NO RSI brake, whatever the arm it is paired with: the brake is
   * part of the CONTROLLER under test, and putting the treatment into the control is exactly
   * what a control exists to avoid.
   *
   * It DOES carry the freeze mode, and that is the same reasoning read the other way. The
   * freeze is MECHANICS, not treatment — the witness must share the gate, the stops, the
   * movement floor and the costs with the arm it is matched to. Pairing an asymmetric
   * configuration with a symmetric witness would let a second difference into a comparison
   * built to isolate one.
   */
  | { kind: 'constant'; targetPercent: number; freeze?: FreezeMode };

/** Starting capital, fixed by the protocol. */
export const STARTING_CASH_USD = 1000;

export interface Position {
  qty: Decimal;
  /** Highest UNIT price seen since the line was opened — drives the deterministic stop. */
  peakPrice: Decimal | null;
}

/** Everything the replay needs to continue where it left off, at the window boundary. */
export interface EngineState {
  cash: Decimal;
  positions: Record<string, Position>;
  /** An order decided on the last bar of a window and executable on the first of the next. */
  pendingTargets: Record<string, number> | null;
  /** Equity at the moment the state was captured, for rebasing. */
  equity: Decimal;
}

export interface BarRecord {
  timestamp: number;
  at: string;
  state: ContextState | 'constant';
  riskOff: boolean;
  netBreadth: number;
  equity: number;
  cash: number;
  exposurePercent: number;
  bandLow: number;
  bandHigh: number;
  projectedPercent: number;
  reachedPercent: number;
  gapPercent: number;
  feasibleLow: number;
  feasibleHigh: number;
  gates: Record<string, string>;
  weights: Record<string, number>;
  tradedNotional: number;
  feesPaid: number;
  deviations: LineDeviation[];
  droppedByFloor: string[];
  droppedAtBandEdge: boolean;
  /** True when the one-way RSI brake capped a requested increase on this bar. */
  rsiBraked: boolean;
  /** The median 4h RSI this bar was judged on. Null only when the brake is not in the run. */
  medianH4Rsi: number | null;
}

export interface EngineResult {
  bars: BarRecord[];
  finalState: EngineState;
  /** Signals that produced no order because the bundle had no following bar. */
  pendingNotExecuted: number;
  /** Equity at the first evaluated bar — the rebasing anchor. */
  openingEquity: number;
}

/**
 * The asymmetry the protocol confirms explicitly: a line with no usable regime may NOT be
 * increased, and the absence of a regime is not on its own a reason to block its REDUCTION.
 * The gate's other constraints keep applying, and the stop and `risk_off` keep their own
 * overrides — this rule adds nothing and removes nothing from them.
 *
 * It matches production's own ladder, which states the invariant in the same direction:
 * "absence of individual information is not a reason to hold". Kept as a named constant so
 * the asymmetry is legible at the call site rather than buried in a switch arm.
 */
export const NO_REGIME_MAY_REDUCE = true;

/** Maps a production gate verdict onto what the allocator may do with the line. */
export function constraintFromGate(
  asset: string,
  gate: string,
  currentPercent: number,
  freeze: FreezeMode = 'symmetric',
): LineConstraint {
  switch (gate) {
    // The stop is exiting the whole line: fully sellable, never buyable.
    case 'stop_exit':
      return {
        asset,
        currentPercent,
        canReduce: true,
        canIncrease: false,
        reason: 'stop_exit',
        // Not merely sellable: SOLD. See LineConstraint.forceExit.
        forceExit: true,
      };
    // A confirmed global risk_off lifts the individual freeze FOR REDUCTIONS ONLY. This is
    // the case that makes the feasible interval direction-dependent: treating the line as
    // immovable would forbid exactly the de-risking the posture exists to force.
    case 'risk_off_reduction':
      return {
        asset,
        currentPercent,
        canReduce: true,
        canIncrease: false,
        reason: 'risk_off_reduce_only',
      };
    case 'frozen':
      // The ONLY line that differs between the two variants. Everything above it — the stop,
      // the risk_off reduction — is untouched, and everything below it never was frozen.
      return {
        asset,
        currentPercent,
        canReduce: false,
        canIncrease: freeze === 'asymmetric',
        reason: 'frozen',
      };
    case 'no_regime':
      return {
        asset,
        currentPercent,
        canReduce: NO_REGIME_MAY_REDUCE,
        canIncrease: false,
        reason: 'no_regime',
      };
    case 'actionable':
      return { asset, currentPercent, canReduce: true, canIncrease: true, reason: 'free' };
    default:
      throw new Error(`exposure engine: unknown gate verdict "${gate}" on ${asset}`);
  }
}

function emptyState(): EngineState {
  return {
    cash: new Decimal(STARTING_CASH_USD),
    positions: {},
    pendingTargets: null,
    equity: new Decimal(STARTING_CASH_USD),
  };
}

/** Price of `asset` at bar index `i`, or null when the series has no such bar. */
function closeAt(tape: AssetTape, i: number): Decimal | null {
  const candle = tape.h4[i];
  return candle ? new Decimal(candle.close) : null;
}

function openAt(tape: AssetTape, i: number): Decimal | null {
  const candle = tape.h4[i];
  return candle ? new Decimal(candle.open) : null;
}

/**
 * Runs one replay over `[fromMs, toMs)`.
 *
 * The regime timeline and the sticky timelines are computed ONCE by the caller and shared
 * across every arm and every witness target — they are the expensive part (indicators over
 * 14 543 bars) and they do not depend on the policy. Only the walk below is per-policy,
 * which is what makes an exhaustive 401-target search affordable.
 */
export function runReplay(input: EngineInput): EngineResult {
  const { cfg, points, tapes, barMs, policy, fromMs, toMs } = input;
  const state: EngineState = input.resume
    ? {
        cash: input.resume.cash,
        positions: Object.fromEntries(
          Object.entries(input.resume.positions).map(([a, p]) => [a, { ...p }]),
        ),
        pendingTargets: input.resume.pendingTargets,
        equity: input.resume.equity,
      }
    : emptyState();

  const bars: BarRecord[] = [];
  let pendingNotExecuted = 0;
  let openingEquity: number | null = null;

  for (const point of points) {
    const t = point.timestamp;
    if (t < fromMs || t >= toMs) continue;

    // ── Prices at this bar's CLOSE — what the bot knows when it decides ───────────────
    const closes: Record<string, Decimal> = {};
    const indices: Record<string, number> = {};
    let usable = true;
    for (const asset of cfg.assets) {
      const tape = tapes[asset];
      const i = tape?.indexByTimestamp.get(t);
      if (tape == null || i == null) {
        usable = false;
        break;
      }
      const close = closeAt(tape, i);
      if (close == null) {
        usable = false;
        break;
      }
      closes[asset] = close;
      indices[asset] = i;
    }
    // A bar where any asset is missing is skipped whole. The controller's denominator is the
    // configured universe, so a partial bar would silently rescale it — the same trap
    // production's `assetsExpected` avoids.
    if (!usable) continue;

    // ── EXECUTE the order decided on the PREVIOUS bar, at THIS bar's OPEN ─────────────
    let tradedNotional = new Decimal(0);
    let feesPaid = new Decimal(0);
    if (state.pendingTargets) {
      const fills = executeTargets(state, state.pendingTargets, cfg, tapes, indices);
      tradedNotional = fills.traded;
      feesPaid = fills.fees;
      state.pendingTargets = null;
    }

    // ── Mark the book, and ratchet each line's peak (the stop's memory) ───────────────
    let deployed = new Decimal(0);
    for (const asset of cfg.assets) {
      const pos = state.positions[asset];
      if (!pos || pos.qty.lte(0)) continue;
      const price = closes[asset]!;
      deployed = deployed.plus(pos.qty.times(price));
      pos.peakPrice = pos.peakPrice == null || price.gt(pos.peakPrice) ? price : pos.peakPrice;
    }
    const equity = state.cash.plus(deployed);
    state.equity = equity;
    // THE REBASING ANCHOR.
    //
    // On a RESUMED run it is the equity carried across the boundary — not this first bar's
    // close. Anchoring after the bar would silently exclude the boundary order's fees and
    // slippage AND the whole first candle's P&L from the net return, the CAGR and the
    // drawdown measured against boundary capital. A window is not allowed to start by
    // forgetting its own first move.
    //
    // On a fresh run there is nothing to carry, and marking a flat book gives exactly the
    // starting cash, so the two readings coincide.
    if (openingEquity == null) {
      openingEquity = input.resume ? input.resume.equity.toNumber() : equity.toNumber();
    }

    const exposurePercent = equity.gt(0) ? deployed.div(equity).times(100).toNumber() : 0;

    // ── The gate, per asset, from PRODUCTION's own evaluator ─────────────────────────
    const lines: LineConstraint[] = [];
    const gates: Record<string, string> = {};
    const weights: Record<string, number> = {};
    for (const asset of cfg.assets) {
      const pos = state.positions[asset];
      const qty = pos?.qty ?? new Decimal(0);
      const price = closes[asset]!;
      const currentPercent = equity.gt(0) ? qty.times(price).div(equity).times(100).toNumber() : 0;
      weights[asset] = currentPercent;

      const verdict = evaluateTransition({
        asset,
        sticky: stickyAtBar(tapes[asset]!.sticky, t),
        riskOffConfirmed: point.global.riskOff,
        qty,
        price,
        priceStale: false,
        peakPriceSinceEntry: pos?.peakPrice ?? null,
        stopThresholdPercent: cfg.peakStopPercent,
      });
      gates[asset] = verdict.gate;
      lines.push(
        constraintFromGate(
          asset,
          verdict.gate,
          currentPercent,
          policy.freeze ?? 'symmetric',
        ),
      );
    }

    // ── The controller, then the allocation ──────────────────────────────────────────
    const reading =
      policy.kind === 'band'
        ? readContext(point, cfg.assets)
        : { state: 'neutral' as ContextState, riskOff: point.global.riskOff, netBreadth: 0, bullish: 0, bearish: 0, neutral: 0, unavailable: 0 };

    const band =
      policy.kind === 'band'
        ? policy.bands[reading.state]
        : { lowPercent: policy.targetPercent, highPercent: policy.targetPercent };

    // The brake rides on the RSI variant only. Passing `undefined` says "not part of this
    // run"; passing a null median says "this run needs it and the bar has none", which is a
    // failure rather than an inactive brake. See applyRsiBrake / MissingMedianRsiError.
    const rsiBrake =
      policy.kind === 'band' && policy.rsiBrake === true
        ? {
            medianH4Rsi: point.global.medianH4Rsi,
            thresholdRsi: cfg.rsiBrakeThresholdRsi,
            atMs: t,
          }
        : undefined;

    const result = allocate({ cfg, lines, currentExposurePercent: exposurePercent, band, rsiBrake });

    // ── Schedule for the NEXT bar's open. Never fill on the close we just read. ───────
    const hasNextBar = cfg.assets.every((asset) => tapes[asset]!.h4[indices[asset]! + 1] != null);
    const changed = cfg.assets.some(
      (asset) => Math.abs((result.targets[asset] ?? 0) - (weights[asset] ?? 0)) > 0,
    );
    if (changed) {
      if (hasNextBar) state.pendingTargets = result.targets;
      else pendingNotExecuted += 1;
    }

    bars.push({
      timestamp: t,
      at: new Date(t).toISOString(),
      state: policy.kind === 'band' ? reading.state : 'constant',
      riskOff: reading.riskOff,
      netBreadth: reading.netBreadth,
      equity: equity.toNumber(),
      cash: state.cash.toNumber(),
      exposurePercent,
      bandLow: band.lowPercent,
      bandHigh: band.highPercent,
      projectedPercent: result.projectedPercent,
      reachedPercent: result.reachedPercent,
      gapPercent: result.gapPercent,
      feasibleLow: result.interval.lowPercent,
      feasibleHigh: result.interval.highPercent,
      gates,
      weights,
      tradedNotional: tradedNotional.toNumber(),
      feesPaid: feesPaid.toNumber(),
      deviations: result.deviations,
      droppedByFloor: result.droppedByFloor,
      droppedAtBandEdge: result.droppedAtBandEdge,
      rsiBraked: result.rsiBraked,
      medianH4Rsi: rsiBrake ? point.global.medianH4Rsi : null,
    });
  }

  return {
    bars,
    finalState: state,
    pendingNotExecuted,
    openingEquity: openingEquity ?? STARTING_CASH_USD,
  };
}

/**
 * Fills the scheduled targets at THIS bar's OPEN, applying both per-leg costs.
 *
 * Sells first, then buys — a book cannot spend cash it has not raised yet, and doing buys
 * first would let the replay run a negative balance for an instant and quietly finance
 * itself. Equity is valued at the OPEN, so the weights realised are the weights the order
 * asked for at the price it actually paid.
 */
function executeTargets(
  state: EngineState,
  targets: Record<string, number>,
  cfg: ExperimentConfig,
  tapes: Record<string, AssetTape>,
  indices: Record<string, number>,
): { traded: Decimal; fees: Decimal } {
  const feeRate = new Decimal(cfg.feePercentPerLeg).div(100);
  const slipRate = new Decimal(cfg.slippagePercentPerLeg).div(100);

  const opens: Record<string, Decimal> = {};
  for (const asset of cfg.assets) {
    const open = openAt(tapes[asset]!, indices[asset]!);
    // No open price = nothing executable on this line this bar. Leave it alone rather than
    // reaching for a substitute price.
    if (open == null || open.lte(0)) return { traded: new Decimal(0), fees: new Decimal(0) };
    opens[asset] = open;
  }

  let deployed = new Decimal(0);
  for (const asset of cfg.assets) {
    const pos = state.positions[asset];
    if (pos && pos.qty.gt(0)) deployed = deployed.plus(pos.qty.times(opens[asset]!));
  }
  const equity = state.cash.plus(deployed);
  if (equity.lte(0)) return { traded: new Decimal(0), fees: new Decimal(0) };

  let traded = new Decimal(0);
  let fees = new Decimal(0);

  const desired: Record<string, Decimal> = {};
  for (const asset of cfg.assets) {
    desired[asset] = equity.times(new Decimal(targets[asset] ?? 0)).div(100);
  }

  // ── SELLS ────────────────────────────────────────────────────────────────────────
  for (const asset of cfg.assets) {
    const pos = state.positions[asset];
    if (!pos || pos.qty.lte(0)) continue;
    const price = opens[asset]!;
    const currentValue = pos.qty.times(price);
    const delta = desired[asset]!.minus(currentValue);
    if (delta.gte(0)) continue;

    const sellValue = delta.abs().gt(currentValue) ? currentValue : delta.abs();
    const qtyOut = sellValue.div(price);
    const gross = qtyOut.times(price.times(new Decimal(1).minus(slipRate)));
    const fee = gross.times(feeRate);
    pos.qty = pos.qty.minus(qtyOut);
    state.cash = state.cash.plus(gross.minus(fee));
    traded = traded.plus(sellValue);
    fees = fees.plus(fee);
    // A line closed out forgets its peak: the next entry starts a fresh stop reference.
    if (pos.qty.lte(new Decimal('1e-12'))) {
      pos.qty = new Decimal(0);
      pos.peakPrice = null;
    }
  }

  // ── BUYS ─────────────────────────────────────────────────────────────────────────
  for (const asset of cfg.assets) {
    const price = opens[asset]!;
    const pos = state.positions[asset] ?? { qty: new Decimal(0), peakPrice: null };
    const currentValue = pos.qty.times(price);
    const delta = desired[asset]!.minus(currentValue);
    if (delta.lte(0)) continue;

    const spend = delta.gt(state.cash) ? state.cash : delta;
    if (spend.lte(0)) continue;
    const fee = spend.times(feeRate);
    const net = spend.minus(fee);
    const effectivePrice = price.times(new Decimal(1).plus(slipRate));
    const qtyIn = net.div(effectivePrice);

    pos.qty = pos.qty.plus(qtyIn);
    // Opening from flat seeds the stop's reference at the price actually paid.
    pos.peakPrice = pos.peakPrice == null ? price : pos.peakPrice;
    state.positions[asset] = pos;
    state.cash = state.cash.minus(spend);
    traded = traded.plus(spend);
    fees = fees.plus(fee);
  }

  return { traded, fees };
}
