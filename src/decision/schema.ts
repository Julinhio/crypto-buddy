import { z } from 'zod';
import { config, type AppConfig } from '../config/index.js';

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
 * The reserve stable(s): the quote asset(s) of the configured tradable pairs
 * (USDT here). Always allocatable — it's the cash we hold and trade against.
 */
export function reserveStables(cfg: AppConfig = config): string[] {
  const quotes: string[] = [];
  const seen = new Set<string>();
  for (const pair of cfg.tradablePairs) {
    const quote = pair.split('/')[1];
    if (quote && !seen.has(quote)) {
      seen.add(quote);
      quotes.push(quote);
    }
  }
  return quotes;
}

/**
 * The assets the AI may allocate to THIS cycle: the base assets of the tradable
 * pairs that ACTUALLY returned data (their symbols), plus the reserve stable.
 *
 * Derived from the live context, never from config alone: a pair the data
 * engine dropped this cycle (no price/indicators) must not be offered to the
 * model — otherwise it could allocate to an asset we know nothing about, and
 * we'd journal a `decided` on incomplete data. Same spirit as the skip rule.
 * Reference / watchlist assets are excluded by construction (only tradable
 * symbols are passed in).
 */
export function allocatableUniverse(
  presentTradableSymbols: string[],
  cfg: AppConfig = config,
): string[] {
  const assets: string[] = [];
  const seen = new Set<string>();
  for (const symbol of presentTradableSymbols) {
    const base = symbol.split('/')[0];
    if (base && !seen.has(base)) {
      seen.add(base);
      assets.push(base);
    }
  }
  for (const stable of reserveStables(cfg)) {
    if (!seen.has(stable)) {
      seen.add(stable);
      assets.push(stable);
    }
  }
  return assets;
}

/**
 * Builds the structured-output schema, with the allocation keys fixed to EXACTLY
 * this cycle's allowed assets.
 *
 * Both objects are STRICT (`z.strictObject`): a client-side `safeParse` REJECTS
 * any unknown key. This is the real guard against the model allocating to a
 * non-tradable asset — a plain `z.object()` would silently STRIP unknown keys,
 * so an extra "SOL" would vanish before `validateDecision` could see it (and if
 * the remaining keys summed to 100 we'd wrongly journal `decided`).
 * `zodOutputFormat` also emits `additionalProperties:false` to the API, but we
 * have never verified the API actually enforces it (no real run yet) — so the
 * rejection lives in code, per our "code disposes, never trust the model/API to
 * self-constrain" principle. Numeric bounds and the sum rule are checked in
 * validateDecision() below.
 */
export function buildDecisionSchema(assets: string[]) {
  const allocationShape: Record<string, z.ZodNumber> = {};
  // Per-asset bounds (0..100). zodOutputFormat strips the keywords the API can't
  // enforce and validates them client-side, so these are belt-and-suspenders;
  // the cross-field sum-to-100 rule stays in validateDecision (the real guard).
  for (const asset of assets) allocationShape[asset] = z.number().min(0).max(100);

  return z.strictObject({
    target_allocation: z.strictObject(allocationShape),
    action_type: actionTypeSchema,
    what_changed: z.string().min(1),
    confidence: confidenceSchema,
    market_state: marketStateSchema,
    reasoning: z.string().min(1),
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
