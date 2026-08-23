import type { MandateId } from './variants.js';
import type { CallOutcome, MovementSummary } from './pipeline.js';

/**
 * The shapes persisted by the runner and read by the analysis — one file so the two
 * cannot drift. Everything here lands in `out/mandate-experiment/` (gitignored):
 * the committed report only ever carries aggregates derived from these.
 */

export type Phase = 'control' | 'variants' | 'extension';

export interface TransportReplay {
  at: string;
  errorType: string;
  failureClass: string | null;
  httpStatus: number | null;
  message: string;
}

export interface CallRecord {
  /** `<mandate>_<contextId>_r<rep>` — the resume key. */
  key: string;
  orderIndex: number;
  phase: Phase;
  mandate: MandateId;
  contextId: number;
  rep: number;
  startedAt: string;
  finishedAt: string;
  requestedModel: string;
  returnedModel: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  /** Transport-family failures replayed before this response landed (brief §3.4). */
  transportReplays: TransportReplay[];
  outcome: CallOutcome;
  orderViolation: string | null;
  invalidReason: string | null;
  guardRules: string[];
  requestedExposure: number | null;
  appliedExposure: number | null;
  clamped: boolean | null;
  actionType: string | null;
  confidence: string | null;
  openedZeroLines: string[];
  movements: MovementSummary[];
  /** Basename of the local raw artefact (full model output, reasoning included). */
  rawFile: string;
}

export interface PlannedCall {
  orderIndex: number;
  phase: Phase;
  mandate: MandateId;
  contextId: number;
  rep: number;
}

/** Repetitions per (context × mandate) cell — 4 × 4 × 5 = 80 calls (brief §3.3). */
export const EXPERIMENT_REPS = 5;

/**
 * The DETERMINISTIC interleaving, planned in full before any call is made and
 * published in the run artefacts (brief §3.3).
 *
 *   Phase A — the control FIRST, as gate 2's validity phase, interleaved by context.
 *   Phase B — P/F/O in a latin-square rotation per (round, context): no variant
 *   ever runs as a block, so a provider drift during the session cannot masquerade
 *   as a variant effect.
 */
export function planMainCalls(contextIds: number[]): PlannedCall[] {
  const plan: PlannedCall[] = [];
  let orderIndex = 0;
  for (let rep = 1; rep <= EXPERIMENT_REPS; rep += 1) {
    for (const contextId of contextIds) {
      plan.push({ orderIndex: orderIndex++, phase: 'control', mandate: 'C', contextId, rep });
    }
  }
  const rotations: MandateId[][] = [
    ['P', 'F', 'O'],
    ['F', 'O', 'P'],
    ['O', 'P', 'F'],
  ];
  for (let rep = 1; rep <= EXPERIMENT_REPS; rep += 1) {
    for (let c = 0; c < contextIds.length; c += 1) {
      for (const mandate of rotations[(rep - 1 + c) % 3]!) {
        plan.push({ orderIndex: orderIndex++, phase: 'variants', mandate, contextId: contextIds[c]!, rep });
      }
    }
  }
  return plan;
}

// ── Small stats, preregistered ─────────────────────────────────────────────────

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Median absolute deviation — the dispersion figure published per cell. */
export function mad(values: number[]): number {
  if (values.length === 0) return NaN;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** max − min. The control's range feeds the local effect threshold. */
export function range(values: number[]): number {
  if (values.length === 0) return NaN;
  return Math.max(...values) - Math.min(...values);
}

/**
 * The LOCAL EFFECT THRESHOLD of a context (brief §5, gate 2): the wider of 5 points
 * and the observed range of the control's accepted responses on that context.
 */
export function localThreshold(controlExposures: number[]): number {
  return Math.max(5, range(controlExposures));
}
