import { z } from 'zod';
import { config, tradableAssets, type AppConfig } from '../config/index.js';

// Enumerations — single source of truth (the TS unions are derived from these).
const actionTypeSchema = z.enum(['hold', 'rebalance', 'de_risk', 'rotate']);
const confidenceSchema = z.enum(['low', 'medium', 'high']);
const marketStateSchema = z.enum(['trend', 'range', 'high_vol', 'risk_off']);

export type ActionType = z.infer<typeof actionTypeSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type MarketState = z.infer<typeof marketStateSchema>;

export interface DecisionOutput {
  target_allocation: Record<string, number>;
  action_type: ActionType;
  what_changed: string;
  confidence: Confidence;
  market_state: MarketState;
  reasoning: string;
  next_delay_minutes: number;
}

/**
 * The only assets the AI may allocate to: tradable base assets + the reserve
 * quote (USDT). Derived from config so it always matches the tradable pairs;
 * reference / watchlist assets (SOL, BNB…) are excluded by construction.
 */
export function allocationAssets(cfg: AppConfig = config): string[] {
  return [...tradableAssets(cfg)];
}

/**
 * Builds the structured-output schema. `target_allocation`'s keys are fixed to
 * EXACTLY the allowed assets (z.object is strict → additionalProperties:false in
 * the emitted JSON schema), so the model cannot invent a key — reference assets
 * can't appear at the API boundary. Numeric/sum rules are not expressible in
 * JSON schema and are enforced by validateDecision() below.
 */
export function buildDecisionSchema(assets: string[]) {
  const allocationShape: Record<string, z.ZodNumber> = {};
  for (const asset of assets) allocationShape[asset] = z.number();

  return z.object({
    target_allocation: z.object(allocationShape),
    action_type: actionTypeSchema,
    what_changed: z.string(),
    confidence: confidenceSchema,
    market_state: marketStateSchema,
    reasoning: z.string(),
    next_delay_minutes: z.number(),
  });
}

export interface ValidatedDecision {
  targetAllocation: Record<string, number>;
  actionType: ActionType;
  whatChanged: string;
  confidence: Confidence;
  marketState: MarketState;
  reasoning: string;
  requestedDelayMinutes: number;
  appliedDelayMinutes: number;
}

export type ValidationResult =
  | { ok: true; value: ValidatedDecision }
  | { ok: false; error: string };

/**
 * Validates the business rules the schema can't express, and clamps the delay.
 * Keys must be exactly the allowed assets, each value finite and >= 0, and the
 * sum within tolerance of 100. `what_changed` and `reasoning` must be non-empty.
 */
export function validateDecision(
  parsed: DecisionOutput,
  assets: string[],
  cfg: AppConfig = config,
): ValidationResult {
  const allocation = parsed.target_allocation ?? {};
  const allowed = new Set(assets);

  for (const key of Object.keys(allocation)) {
    if (!allowed.has(key)) {
      return { ok: false, error: `allocation contains non-tradable key "${key}"` };
    }
  }

  let sum = 0;
  const targetAllocation: Record<string, number> = {};
  for (const asset of assets) {
    const value = allocation[asset];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `allocation["${asset}"] is missing or not a finite number` };
    }
    if (value < 0) {
      return { ok: false, error: `allocation["${asset}"] is negative (${value})` };
    }
    targetAllocation[asset] = value;
    sum += value;
  }

  const tolerance = cfg.decision.allocationTolerancePercent;
  if (Math.abs(sum - 100) > tolerance) {
    return {
      ok: false,
      error: `allocation sums to ${sum.toFixed(2)}, expected 100 (±${tolerance})`,
    };
  }

  const whatChanged = (parsed.what_changed ?? '').trim();
  if (!whatChanged) return { ok: false, error: 'what_changed is empty' };

  const reasoning = (parsed.reasoning ?? '').trim();
  if (!reasoning) return { ok: false, error: 'reasoning is empty' };

  const requested = parsed.next_delay_minutes;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return { ok: false, error: 'next_delay_minutes is not a finite number' };
  }
  const applied = Math.round(
    Math.min(cfg.decision.maxDelayMinutes, Math.max(cfg.decision.minDelayMinutes, requested)),
  );

  return {
    ok: true,
    value: {
      targetAllocation,
      actionType: parsed.action_type,
      whatChanged,
      confidence: parsed.confidence,
      marketState: parsed.market_state,
      reasoning,
      requestedDelayMinutes: requested,
      appliedDelayMinutes: applied,
    },
  };
}
