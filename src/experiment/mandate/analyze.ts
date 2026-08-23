import { EXPERIMENT_CONTEXTS, type ContextSpec } from './reconstruct.js';
import { MANDATE_IDS, type MandateId } from './variants.js';
import { localThreshold, mad, median, range, type CallRecord } from './records.js';

/**
 * THE PREREGISTERED READING (brief §5 and §6), coded BEFORE the variant data
 * existed and not adjusted after. Every criterion below is the brief's, restated
 * as arithmetic:
 *
 *   gate 2      |median(C) − historical| > threshold on any context → the whole
 *               experiment is invalid (the runner stops before the variants).
 *   threshold   max(5 points, range of C's accepted responses) — per context.
 *   effect      (favorable contexts) median(V) − median(C) ≥ threshold, AND the
 *               shift is not reproduced by P, AND a majority of V's accepted
 *               responses sit above median(C), AND V does not fail more primaries
 *               than C on that context.
 *   placebo     |median(P) − median(C)| ≥ threshold on a context → F and O are
 *               not causally interpretable there.
 *   placebo     P must be shown to have been READ: if it moves neither the
 *   activity    exposure nor the confidence distribution, the placebo gate tested
 *               nothing and the report must say so.
 *   1494        a variant whose median degrades the reduction by ≥ threshold is
 *               eliminated; anomalies trigger +3 reps (runner), and the reading
 *               uses the extended median. A majority of zero-line openings after
 *               extension eliminates the variant.
 *   dead cycles a variant with MORE invalid/refused primaries than C in total is
 *               eliminated — no dead cycle is an acceptable price.
 */

const FAVOURABLE_CONTEXTS = [1297, 1433, 1368];
const NEGATIVE_CONTROL = 1494;
const VARIANTS: readonly MandateId[] = ['P', 'F', 'O'];

export interface CellStats {
  mandate: MandateId;
  contextId: number;
  calls: number;
  accepted: number;
  invalid: number;
  guardRefused: number;
  orderViolations: number;
  transportReplays: number;
  exposures: number[];
  median: number | null;
  mad: number | null;
  range: number | null;
  confidence: Record<string, number>;
  zeroLineOpenings: number;
  extended: boolean;
}

export interface Gate2Result {
  contextId: number;
  role: string;
  historical: number;
  medianC: number | null;
  madC: number | null;
  rangeC: number | null;
  threshold: number | null;
  gap: number | null;
  acceptedC: number;
  ok: boolean;
  detail: string;
}

export interface EffectReading {
  mandate: MandateId;
  contextId: number;
  effectSize: number | null;
  threshold: number;
  clearsThreshold: boolean;
  reproducedByPlacebo: boolean;
  majorityAbove: boolean;
  validityHolds: boolean;
  isEffect: boolean;
}

export interface NegativeControlReading {
  mandate: MandateId;
  degradation: number | null;
  threshold: number;
  eliminatedOnMedian: boolean;
  zeroLineOpenings: number;
  acceptedResponses: number;
  eliminatedOnZeroLines: boolean;
}

export interface Analysis {
  cells: CellStats[];
  gate2: Gate2Result[];
  gate2ok: boolean;
  thresholds: Record<number, number>;
  placeboMovedExposure: Record<number, boolean>;
  placeboMovedConfidence: Record<number, boolean>;
  placeboInert: boolean;
  effects: EffectReading[];
  negativeControl: NegativeControlReading[];
  deadCycles: Array<{ mandate: MandateId; failedPrimaries: number; eliminated: boolean }>;
  confidenceByMandate: Record<MandateId, Record<string, number>>;
}

function cellOf(calls: CallRecord[], mandate: MandateId, contextId: number): CellStats {
  const cell = calls.filter((c) => c.mandate === mandate && c.contextId === contextId);
  const accepted = cell.filter((c) => c.outcome === 'accepted');
  const exposures = accepted
    .map((c) => c.requestedExposure)
    .filter((e): e is number => e != null);
  const confidence: Record<string, number> = {};
  for (const c of accepted) {
    if (c.confidence) confidence[c.confidence] = (confidence[c.confidence] ?? 0) + 1;
  }
  return {
    mandate,
    contextId,
    calls: cell.length,
    accepted: accepted.length,
    invalid: cell.filter((c) => c.outcome === 'invalid').length,
    guardRefused: cell.filter((c) => c.outcome === 'guard_refused').length,
    orderViolations: cell.filter((c) => c.outcome === 'order_violation').length,
    transportReplays: cell.reduce((n, c) => n + c.transportReplays.length, 0),
    exposures,
    median: exposures.length > 0 ? median(exposures) : null,
    mad: exposures.length > 0 ? mad(exposures) : null,
    range: exposures.length > 0 ? range(exposures) : null,
    confidence,
    zeroLineOpenings: accepted.filter((c) => c.openedZeroLines.length > 0).length,
    extended: cell.some((c) => c.phase === 'extension'),
  };
}

/** Gate 2 alone — the runner consults it between the control phase and the variants. */
export function evaluateGate2(calls: CallRecord[], specs: ContextSpec[] = EXPERIMENT_CONTEXTS): Gate2Result[] {
  return specs.map((spec) => {
    const cell = cellOf(calls, 'C', spec.decisionId);
    if (cell.exposures.length < 3) {
      return {
        contextId: spec.decisionId,
        role: spec.role,
        historical: spec.historicalRequestedExposure,
        medianC: cell.median,
        madC: cell.mad,
        rangeC: cell.range,
        threshold: null,
        gap: null,
        acceptedC: cell.accepted,
        ok: false,
        detail: `only ${cell.exposures.length} accepted control responses — no validity basis`,
      };
    }
    const threshold = localThreshold(cell.exposures);
    const gap = Math.abs((cell.median ?? NaN) - spec.historicalRequestedExposure);
    const ok = gap <= threshold;
    return {
      contextId: spec.decisionId,
      role: spec.role,
      historical: spec.historicalRequestedExposure,
      medianC: cell.median,
      madC: cell.mad,
      rangeC: cell.range,
      threshold,
      gap,
      acceptedC: cell.accepted,
      ok,
      detail: ok
        ? `|${cell.median} − ${spec.historicalRequestedExposure}| = ${gap.toFixed(2)} ≤ ${threshold.toFixed(2)}`
        : `|${cell.median} − ${spec.historicalRequestedExposure}| = ${gap.toFixed(2)} > ${threshold.toFixed(2)} — the harness does not reproduce production`,
    };
  });
}

/** Confidence shift criterion, preregistered: some category differs by ≥ 2 responses. */
function confidenceShifted(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (Math.abs((a[k] ?? 0) - (b[k] ?? 0)) >= 2) return true;
  }
  return false;
}

export function analyze(calls: CallRecord[], specs: ContextSpec[] = EXPERIMENT_CONTEXTS): Analysis {
  const cells: CellStats[] = [];
  for (const mandate of MANDATE_IDS) {
    for (const spec of specs) cells.push(cellOf(calls, mandate, spec.decisionId));
  }
  const cell = (m: MandateId, ctx: number): CellStats =>
    cells.find((c) => c.mandate === m && c.contextId === ctx)!;

  const gate2 = evaluateGate2(calls, specs);
  const gate2ok = gate2.every((g) => g.ok);

  const thresholds: Record<number, number> = {};
  for (const g of gate2) {
    if (g.threshold != null) thresholds[g.contextId] = g.threshold;
  }

  // Placebo movement, per context.
  const placeboMovedExposure: Record<number, boolean> = {};
  const placeboMovedConfidence: Record<number, boolean> = {};
  for (const spec of specs) {
    const ctx = spec.decisionId;
    const c = cell('C', ctx);
    const p = cell('P', ctx);
    const threshold = thresholds[ctx];
    placeboMovedExposure[ctx] =
      threshold != null && c.median != null && p.median != null
        ? Math.abs(p.median - c.median) >= threshold
        : false;
    placeboMovedConfidence[ctx] = confidenceShifted(c.confidence, p.confidence);
  }
  const placeboInert =
    !Object.values(placeboMovedExposure).some(Boolean) &&
    !Object.values(placeboMovedConfidence).some(Boolean);

  // Favourable-context effects.
  const effects: EffectReading[] = [];
  for (const mandate of VARIANTS) {
    for (const ctx of FAVOURABLE_CONTEXTS) {
      const c = cell('C', ctx);
      const v = cell(mandate, ctx);
      const p = cell('P', ctx);
      const threshold = thresholds[ctx] ?? NaN;
      const effectSize = c.median != null && v.median != null ? v.median - c.median : null;
      const clearsThreshold = effectSize != null && effectSize >= threshold;
      const placeboShift = c.median != null && p.median != null ? p.median - c.median : null;
      // A variant's own effect cannot be "reproduced by itself": for P this flag is
      // read as its own shift clearing the bar, which the placebo gate reports anyway.
      const reproducedByPlacebo =
        mandate !== 'P' && placeboShift != null && placeboShift >= threshold;
      const above = c.median == null ? 0 : v.exposures.filter((e) => e > c.median!).length;
      const majorityAbove = v.exposures.length > 0 && above * 2 > v.calls;
      const failedV = v.invalid + v.guardRefused + v.orderViolations;
      const failedC = c.invalid + c.guardRefused + c.orderViolations;
      const validityHolds = failedV <= failedC;
      effects.push({
        mandate,
        contextId: ctx,
        effectSize,
        threshold,
        clearsThreshold,
        reproducedByPlacebo,
        majorityAbove,
        validityHolds,
        isEffect: clearsThreshold && !reproducedByPlacebo && majorityAbove && validityHolds,
      });
    }
  }

  // Negative control 1494.
  const negativeControl: NegativeControlReading[] = VARIANTS.map((mandate) => {
    const c = cell('C', NEGATIVE_CONTROL);
    const v = cell(mandate, NEGATIVE_CONTROL);
    const threshold = thresholds[NEGATIVE_CONTROL] ?? NaN;
    const degradation = c.median != null && v.median != null ? v.median - c.median : null;
    return {
      mandate,
      degradation,
      threshold,
      eliminatedOnMedian: degradation != null && degradation >= threshold,
      zeroLineOpenings: v.zeroLineOpenings,
      acceptedResponses: v.accepted,
      eliminatedOnZeroLines: v.accepted > 0 && v.zeroLineOpenings * 2 > v.accepted,
    };
  });

  // Dead cycles, totals across the four contexts.
  const failedTotal = (m: MandateId): number =>
    cells
      .filter((c) => c.mandate === m)
      .reduce((n, c) => n + c.invalid + c.guardRefused + c.orderViolations, 0);
  const controlFailed = failedTotal('C');
  const deadCycles = VARIANTS.map((mandate) => ({
    mandate,
    failedPrimaries: failedTotal(mandate),
    eliminated: failedTotal(mandate) > controlFailed,
  }));

  const confidenceByMandate = {} as Record<MandateId, Record<string, number>>;
  for (const mandate of MANDATE_IDS) {
    const merged: Record<string, number> = {};
    for (const c of cells.filter((x) => x.mandate === mandate)) {
      for (const [k, n] of Object.entries(c.confidence)) merged[k] = (merged[k] ?? 0) + n;
    }
    confidenceByMandate[mandate] = merged;
  }

  return {
    cells,
    gate2,
    gate2ok,
    thresholds,
    placeboMovedExposure,
    placeboMovedConfidence,
    placeboInert,
    effects,
    negativeControl,
    deadCycles,
    confidenceByMandate,
  };
}
