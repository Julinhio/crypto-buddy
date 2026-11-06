import { Decimal, ZERO } from '../../money.js';
import { evaluateTransition, type TransitionGate } from '../../transition/gate.js';
import type { StickyPoint } from '../../market/transition.js';
import type { BenchConfig } from './config.js';
import type { Tape } from './tape.js';
import { allocate, stateFromGate, type AllocLine, type Allocation } from './allocate.js';
import { applyRebalanceThreshold, confirmedBullish, type Policy } from './policy.js';
import { executeAllocation } from './execute.js';
import { assertMeasurable, type Window } from './windows.js';
import type { VerificationOpening } from './opening.js';

/**
 * THE v1.3 REPLAY ENGINE — one walk over the 4h grid, the same for every policy.
 *
 * The two PR #36 rules are kept, unchanged:
 *
 *   NO LOOK-AHEAD. The decision reads the CLOSE of bar `i`; its orders fill at the OPEN of the
 *   next bar of the grid. Same instant on the clock, two different prices.
 *
 *   NO INVENTED BARS. "Next bar" is the next bar of the grid, never `t + 4h`.
 *
 * And the frontier rule of protocol v1.3, point 4: an order decided on the last bar of a
 * window is NOT executed on the first bar of the next window — that open belongs to the next
 * window. It is counted `pending_not_executed` and crosses the frontier in the state.
 *
 * ── THE RE-ENTRY RULE (every architecture; amended 17/10 after step 1) ────────────────
 *
 * Production's stop contract ends with "no automatic re-entry, the model decides". There is
 * no model here, so the bench needs the rule the model used to be: after a stop exit the line
 * is BARRED — target 0, its share redistributed like any stopped line — through `range`,
 * `trend_down` and `reversal_down`, and released ONLY on a confirmed `trend_up` or
 * `reversal_up`. Never during a transition: a frozen line cannot be bought anyway.
 *
 * RPA's exits are remembered the same way, in `policyExcluded` (see `policy.ts`).
 *
 * ── THE DRAWDOWN ──────────────────────────────────────────────────────────────────────
 *
 * Continuous from the high of the WHOLE trajectory, on 4h close equity (arbitrated 17/10).
 * The high is part of the state and crosses frontiers with it: a window resumed at −30 % does
 * not get to start its drawdown at zero.
 */

export interface Position {
  qty: Decimal;
  /** Highest UNIT price since entry — the stop's memory. Never a valuation. */
  peakPrice: Decimal | null;
}

export type LineIntent = { hold: true } | { hold: false; percent: number };

export interface PendingOrder {
  decidedAtMs: number;
  cause: TradeCause;
  intents: Record<string, LineIntent>;
  /** Lines the stop is taking out with this order: barred once the exit fills. */
  stopExits: string[];
}

export interface EngineState {
  cash: Decimal;
  positions: Record<string, Position>;
  /** Lines barred from re-entry after a stop. Sorted, for a reproducible state. */
  barred: string[];
  /** Assets the policy took out and remembers as out (RPA). Sorted. */
  policyExcluded: string[];
  pending: PendingOrder | null;
  /** The last total target the policy applied, for the rebalancing threshold. */
  lastTotalTarget: number | null;
  /** Highest 4h close equity of the whole trajectory. */
  equityHigh: number;
}

export interface BarRecord {
  t: number;
  equity: number;
  cash: number;
  exposurePercent: number;
  drawdownPercent: number;
  riskOff: boolean;
  policyTargetPercent: number;
  effectiveTargetPercent: number;
  plannedExposurePercent: number;
  capacityShortfallPercent: number;
  overExposurePercent: number;
  weights: Record<string, number>;
  gates: Record<string, TransitionGate>;
  states: Record<string, string>;
  /** Execution that happened at THIS bar's open (the previous bar's decision). */
  tradedNotional: number;
  fees: number;
  slippageCost: number;
  suppressed: Record<string, number>;
  stopExitsDecided: string[];
  barred: string[];
  /** The policy's remembered exclusions after this bar's decision (RPA). */
  policyExcluded: string[];
  /** Why the order executed at THIS bar's open was decided (see `metrics.ts`). Null when none. */
  executedCause: TradeCause | null;
}

/** The cause of an order, read on the bar that decided it, in priority order. */
export type TradeCause = 'stop_exit' | 'release_after_stop' | 'policy_target_change' | 'line_state_change' | 'drift_or_other';

export interface RunResult {
  policy: string;
  window: Window;
  bars: BarRecord[];
  openingEquity: number;
  finalState: EngineState;
  /** Orders decided on the window's last bar and carried, not executed. 0 or 1. */
  pendingNotExecuted: number;
}

export function freshState(cfg: BenchConfig): EngineState {
  return {
    cash: new Decimal(cfg.startingCashUsd),
    positions: {},
    barred: [],
    policyExcluded: [],
    pending: null,
    lastTotalTarget: null,
    equityHigh: cfg.startingCashUsd,
  };
}

function cloneState(s: EngineState): EngineState {
  return {
    cash: s.cash,
    positions: Object.fromEntries(Object.entries(s.positions).map(([a, p]) => [a, { ...p }])),
    barred: [...s.barred],
    policyExcluded: [...s.policyExcluded],
    pending: s.pending ? { ...s.pending, intents: { ...s.pending.intents }, stopExits: [...s.pending.stopExits] } : null,
    lastTotalTarget: s.lastTotalTarget,
    equityHigh: s.equityHigh,
  };
}

export function runWindow(params: {
  tape: Tape;
  cfg: BenchConfig;
  policy: Policy;
  window: Window;
  /** Absent = fresh 1 000 $ cash, flat, no history. */
  resume?: EngineState;
  /** SCORE only: the causal score at each bar's close. */
  scoreAt?: (t: number) => number | null;
  /** Tests only: lifts the window gate for synthetic tapes. Never passed by the runner. */
  unsafeSyntheticWindow?: boolean;
  /** Required for the internal verification. See `windows.ts`. */
  opening?: VerificationOpening;
  /**
   * DIAGNOSTIC ONLY, outside the protocol: the peak stop never fires. A `stop_exit` verdict is
   * replaced by what production's ladder answers without it — `risk_off_reduction` under a
   * risk_off the gate sees, `frozen` otherwise (the stop only arms on a frozen line). Used to
   * measure what the stop and its re-entry cost; never a candidate.
   */
  diagnosticWithoutStop?: boolean;
}): RunResult {
  const { tape, cfg, policy, window } = params;
  if (!params.unsafeSyntheticWindow) assertMeasurable(window, params.opening);
  for (const asset of cfg.assets) {
    if (!tape.tapes[asset]) throw new Error(`bench engine: tape has no ${asset}`);
  }

  const state = params.resume ? cloneState(params.resume) : freshState(cfg);
  const points = tape.points.filter((p) => p.timestamp >= window.fromMs && p.timestamp < window.toMs);
  const bars: BarRecord[] = [];
  let pendingNotExecuted = 0;
  let openingEquity: number | null = null;

  for (let k = 0; k < points.length; k += 1) {
    const point = points[k]!;
    const t = point.timestamp;

    const index: Record<string, number> = {};
    for (const asset of cfg.assets) {
      const i = tape.tapes[asset]!.indexByTs.get(t);
      if (i == null) throw new Error(`bench engine: ${asset} has no bar at ${new Date(t).toISOString()} on the regime grid`);
      index[asset] = i;
    }
    const opens: Record<string, Decimal> = {};
    const closes: Record<string, Decimal> = {};
    for (const asset of cfg.assets) {
      const c = tape.tapes[asset]!.h4[index[asset]!]!;
      opens[asset] = new Decimal(c.open);
      closes[asset] = new Decimal(c.close);
    }

    // The equity a resumed window starts from is the one CARRIED, before the boundary order
    // and before this bar's move — a window may not begin by forgetting its first move.
    if (openingEquity == null) openingEquity = equityAt(state, opens).toNumber();

    // ── EXECUTE the previous bar's decision at THIS bar's open ───────────────────────
    let traded = ZERO;
    let fees = ZERO;
    let slippageCost = ZERO;
    const suppressed: Record<string, number> = {};
    let executedCause: TradeCause | null = null;
    if (state.pending) {
      const order = state.pending;
      executedCause = order.cause;
      state.pending = null;
      const book: Record<string, { qty: Decimal }> = {};
      for (const [a, p] of Object.entries(state.positions)) book[a] = { qty: p.qty };
      const equityOpen = equityAt(state, opens);
      const targets: Record<string, number> = {};
      for (const asset of cfg.assets) {
        const intent = order.intents[asset];
        const held = state.positions[asset]?.qty ?? ZERO;
        const heldPercent = equityOpen.gt(0) ? held.times(opens[asset]!).div(equityOpen).times(100).toNumber() : 0;
        // A HOLD is re-valued at the execution price: the line is not to trade at all.
        targets[asset] = intent == null || intent.hold ? heldPercent : intent.percent;
      }
      const { cash, report } = executeAllocation({
        cash: state.cash,
        book,
        prices: opens,
        targets,
        reserveAsset: cfg.reserveAsset,
        feePercent: cfg.feePercentPerLeg,
        slippagePercent: cfg.slippagePercentPerLeg,
        minMovementPercent: cfg.minMovementPercent,
      });
      state.cash = cash;
      for (const [asset, line] of Object.entries(book)) {
        const pos = state.positions[asset] ?? { qty: ZERO, peakPrice: null };
        pos.qty = line.qty;
        state.positions[asset] = pos;
      }
      for (const asset of report.opened) state.positions[asset]!.peakPrice = opens[asset]!;
      for (const asset of report.closedOut) {
        state.positions[asset]!.peakPrice = null;
        if (order.stopExits.includes(asset) && !state.barred.includes(asset)) state.barred.push(asset);
      }
      state.barred.sort();
      traded = report.tradedNotional;
      fees = report.fees;
      slippageCost = report.slippageCost;
      for (const leg of report.suppressed) suppressed[leg.reason] = (suppressed[leg.reason] ?? 0) + 1;
    }

    // ── MARK at the close; ratchet the stop's unit-price peaks ───────────────────────
    let deployed = ZERO;
    for (const asset of cfg.assets) {
      const pos = state.positions[asset];
      if (!pos || !pos.qty.gt(0)) continue;
      const price = closes[asset]!;
      deployed = deployed.plus(pos.qty.times(price));
      if (pos.peakPrice == null || price.gt(pos.peakPrice)) pos.peakPrice = price;
    }
    const equity = state.cash.plus(deployed);
    const equityNum = equity.toNumber();
    if (equityNum > state.equityHigh) state.equityHigh = equityNum;
    const drawdownPercent = state.equityHigh > 0 ? ((state.equityHigh - equityNum) / state.equityHigh) * 100 : 0;
    const weights: Record<string, number> = {};
    for (const asset of cfg.assets) {
      const qty = state.positions[asset]?.qty ?? ZERO;
      weights[asset] = equity.gt(0) ? qty.times(closes[asset]!).div(equity).times(100).toNumber() : 0;
    }
    const exposurePercent = equity.gt(0) ? deployed.div(equity).times(100).toNumber() : 0;

    // ── THE RE-ENTRY RULE: a barred line is released by a confirmed BULLISH regime only ──
    const sticky: Record<string, StickyPoint | null> = {};
    for (const asset of cfg.assets) sticky[asset] = tape.tapes[asset]!.stickyByTs.get(t) ?? null;
    const barredBefore = state.barred.length;
    state.barred = state.barred.filter((asset) => !confirmedBullish(sticky[asset] ?? null));
    const released = state.barred.length < barredBefore;

    // ── THE GATE: production's own evaluator ─────────────────────────────────────────
    const riskOffSeen = policy.gateSeesRiskOff ? point.global.riskOff : false;
    const gates: Record<string, TransitionGate> = {};
    for (const asset of cfg.assets) {
      const pos = state.positions[asset];
      const verdict = evaluateTransition({
        asset,
        sticky: sticky[asset] ?? null,
        riskOffConfirmed: riskOffSeen,
        qty: pos?.qty ?? ZERO,
        price: closes[asset]!,
        priceStale: false,
        peakPriceSinceEntry: pos?.peakPrice ?? null,
        stopThresholdPercent: cfg.peakStopPercent,
      }).gate;
      gates[asset] = params.diagnosticWithoutStop && verdict === 'stop_exit' ? (riskOffSeen ? 'risk_off_reduction' : 'frozen') : verdict;
    }

    // ── THE POLICY, then the allocation ──────────────────────────────────────────────
    const decision = policy.decide({ point, sticky, excludedBefore: new Set(state.policyExcluded), score: params.scoreAt?.(t) ?? null });
    state.policyExcluded = [...decision.excluded].sort();
    const total = applyRebalanceThreshold(decision.totalTargetPercent, state.lastTotalTarget, policy.rebalanceThresholdPoints);
    state.lastTotalTarget = total;

    const lines: AllocLine[] = cfg.assets.map((asset) => {
      const fromGate = stateFromGate(gates[asset]!);
      let lineState = fromGate.state;
      const movable = lineState === 'free' || lineState === 'reduce_only';
      if (movable && decision.excluded.has(asset)) lineState = 'excluded';
      else if (movable && state.barred.includes(asset)) lineState = 'stopped';
      return { asset, currentPercent: weights[asset]!, state: lineState, fixedCause: fromGate.fixedCause };
    });
    const allocation: Allocation = allocate({ policyTargetPercent: total, basket: cfg.basket, caps: cfg.caps, lines });

    const intents: Record<string, LineIntent> = {};
    let wantsTrade = false;
    for (const line of allocation.lines) {
      intents[line.asset] = line.hold ? { hold: true } : { hold: false, percent: line.targetPercent };
      if (!line.hold && Math.abs(line.targetPercent - (weights[line.asset] ?? 0)) > 1e-9) wantsTrade = true;
    }
    const stopExitsDecided = cfg.assets.filter((a) => gates[a] === 'stop_exit');

    // ── SCHEDULE for the next bar's open — only if that open is in this window ───────
    const previous = bars[bars.length - 1];
    const cause: TradeCause = stopExitsDecided.length > 0
      ? 'stop_exit'
      : released
        ? 'release_after_stop'
        : previous && previous.policyTargetPercent !== allocation.policyTargetPercent
          ? 'policy_target_change'
          : previous && cfg.assets.some((a) => previous.states[a] !== lines.find((l) => l.asset === a)!.state)
            ? 'line_state_change'
            : 'drift_or_other';
    if (wantsTrade) {
      state.pending = { decidedAtMs: t, cause, intents, stopExits: stopExitsDecided };
      if (k + 1 >= points.length) pendingNotExecuted += 1;
    }

    bars.push({
      t,
      equity: equityNum,
      cash: state.cash.toNumber(),
      exposurePercent,
      drawdownPercent,
      riskOff: point.global.riskOff,
      policyTargetPercent: allocation.policyTargetPercent,
      effectiveTargetPercent: allocation.effectiveTargetPercent,
      plannedExposurePercent: allocation.plannedExposurePercent,
      capacityShortfallPercent: allocation.capacityShortfallPercent,
      overExposurePercent: allocation.overExposurePercent,
      weights,
      gates,
      states: Object.fromEntries(lines.map((l) => [l.asset, l.state])),
      tradedNotional: traded.toNumber(),
      fees: fees.toNumber(),
      slippageCost: slippageCost.toNumber(),
      suppressed,
      stopExitsDecided,
      barred: [...state.barred],
      policyExcluded: [...state.policyExcluded],
      executedCause,
    });
  }

  return {
    policy: policy.name,
    window,
    bars,
    openingEquity: openingEquity ?? cfg.startingCashUsd,
    finalState: state,
    pendingNotExecuted,
  };
}

function equityAt(state: EngineState, prices: Readonly<Record<string, Decimal>>): Decimal {
  let e = state.cash;
  for (const [asset, pos] of Object.entries(state.positions)) {
    if (pos.qty.gt(0)) e = e.plus(pos.qty.times(prices[asset]!));
  }
  return e;
}
