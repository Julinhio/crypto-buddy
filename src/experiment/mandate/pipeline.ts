import { config } from '../../config/index.js';
import type { PriceLookup, VirtualPortfolio } from '../../portfolio/derive.js';
import { clampAllocation, type ClampResult } from '../../risk/clamp.js';
import { computeMovements, type Movement } from '../../execution/movements.js';
import {
  buildDecisionSchema,
  outputOrderViolation,
  validateDecision,
  type ValidatedDecision,
} from '../../decision/schema.js';
import { checkCoherence, type CoherenceVerdict } from '../../decision/coherence.js';
import { toNumericString } from '../../money.js';

/**
 * THE JUDGEMENT PIPELINE — exactly production's chain, on one PRIMARY response.
 *
 * Order contract → JSON parse → schema → business validation → risk clamp →
 * movements → coherence guard. Same functions, same config, same inputs as
 * `decide()`. What it deliberately does NOT do (brief §3.4): the guard's single
 * relaunch. The experiment evaluates the primary response; a refused or invalid
 * primary counts as such and is never replaced.
 */

export interface MovementSummary {
  asset: string;
  side: 'buy' | 'sell';
  notional: string;
  fullExit: boolean;
}

export type CallOutcome = 'accepted' | 'order_violation' | 'invalid' | 'guard_refused';

export interface CallJudgement {
  outcome: CallOutcome;
  orderViolation: string | null;
  /** Parse or business-validation failure (the two are one category: unusable primary). */
  invalidReason: string | null;
  decision: ValidatedDecision | null;
  clamp: ClampResult | null;
  movements: MovementSummary[];
  guard: CoherenceVerdict | null;
  /** 100 − target[reserve]: the RAW ask, the experiment's measurand. */
  requestedExposure: number | null;
  /** 100 − clamp.applied[reserve]: what the chain would have retained. */
  appliedExposure: number | null;
  /** Lines at zero in the book that this response opens (any weight > 0). */
  openedZeroLines: string[];
}

export interface PipelineInputs {
  portfolio: VirtualPortfolio;
  priceOf: PriceLookup;
  assets: string[];
  reserveStable: string;
  intentReference: Record<string, number> | null;
  previousIntentMovements: Movement[];
  assetsWithStoredThesis: Set<string>;
}

const summarize = (movements: Movement[]): MovementSummary[] =>
  movements.map((m) => ({
    asset: m.asset,
    side: m.side,
    notional: toNumericString(m.notional),
    fullExit: m.fullExit,
  }));

export function judgeResponse(rawResponse: string, inputs: PipelineInputs): CallJudgement {
  const empty: Omit<CallJudgement, 'outcome'> = {
    orderViolation: null,
    invalidReason: null,
    decision: null,
    clamp: null,
    movements: [],
    guard: null,
    requestedExposure: null,
    appliedExposure: null,
    openedZeroLines: [],
  };

  // 1. The output-order contract, read on the raw text — jsonb and JSON.parse both
  //    destroy the order, so this is the only place it can be checked (schema.ts).
  const orderProblem = outputOrderViolation(rawResponse);
  if (orderProblem) {
    return { ...empty, outcome: 'order_violation', orderViolation: orderProblem };
  }

  // 2. Parse + schema — the same schema instance production builds for this universe.
  const schema = buildDecisionSchema(inputs.assets, 'v5');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch (err) {
    return {
      ...empty,
      outcome: 'invalid',
      invalidReason: `response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const schemaResult = schema.safeParse(parsed);
  if (!schemaResult.success) {
    const reason = schemaResult.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ...empty, outcome: 'invalid', invalidReason: reason };
  }

  // 3. Business validation.
  const validation = validateDecision(schemaResult.data, inputs.assets, config, 'v5');
  if (!validation.ok) {
    return { ...empty, outcome: 'invalid', invalidReason: validation.error };
  }
  const decision = validation.value;

  // 4. Clamp + movements — the exact `evaluate` closure of decide().
  const clamp = clampAllocation(decision.targetAllocation, inputs.reserveStable, config);
  const movements = computeMovements(
    inputs.portfolio,
    clamp.applied,
    inputs.priceOf,
    config.execution.feePercent,
    config.execution.minMovementPercent,
  );

  // 5. The coherence guard, on the primary response only.
  const guard = checkCoherence({
    strategy: 'v5',
    actionType: decision.actionType,
    intentTarget: decision.targetAllocation,
    intentReference: inputs.intentReference,
    movements,
    previousIntentMovements: inputs.previousIntentMovements,
    reserveAsset: inputs.reserveStable,
    notes: decision.positionNotes,
    assetsWithStoredThesis: inputs.assetsWithStoredThesis,
  });

  const requestedExposure = 100 - (decision.targetAllocation[inputs.reserveStable] ?? 0);
  const appliedExposure = 100 - (clamp.applied[inputs.reserveStable] ?? 0);

  const heldWeights = new Map(inputs.portfolio.positions.map((p) => [p.asset, p.weightPercent]));
  const openedZeroLines = inputs.assets
    .filter((asset) => asset !== inputs.reserveStable)
    .filter((asset) => {
      const held = heldWeights.get(asset);
      const flat = held == null || held.lte(0);
      return flat && (decision.targetAllocation[asset] ?? 0) > 0;
    });

  return {
    outcome: guard.ok ? 'accepted' : 'guard_refused',
    orderViolation: null,
    invalidReason: null,
    decision,
    clamp,
    movements: summarize(movements),
    guard,
    requestedExposure,
    appliedExposure,
    openedZeroLines,
  };
}
