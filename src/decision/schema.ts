import { z } from 'zod';
import { config, type AppConfig, type StrategyVersion } from '../config/index.js';

// Enumerations — single source of truth (the TS unions are derived from these).
const actionTypeSchema = z.enum(['hold', 'rebalance', 'de_risk', 'rotate']);
const confidenceSchema = z.enum(['low', 'medium', 'high']);
const marketStateSchema = z.enum(['trend', 'range', 'high_vol', 'risk_off']);

export type ActionType = z.infer<typeof actionTypeSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type MarketState = z.infer<typeof marketStateSchema>;

/**
 * One position's thesis, as WRITTEN BY THE MODEL (v5 only).
 *
 * An ARRAY of these rather than an object keyed by asset, on purpose: omitting an
 * asset has to be the easy, natural way to say "keep its thesis untouched", which is
 * the normal case on a hold. An object with optional keys makes silence ambiguous.
 */
export interface PositionNote {
  asset: string;
  thesis: string;
  invalidation: string;
  /** True to deliberately REPLACE an existing thesis without a trade on that line. */
  replace: boolean;
}

export interface DecisionOutput {
  target_allocation: Record<string, number>;
  action_type: ActionType;
  what_changed: string;
  confidence: Confidence;
  /**
   * v4 ONLY. Under v5 the regime is computed by the code and the model does not
   * declare it — the column is filled from the code's own read instead.
   */
  market_state?: MarketState;
  reasoning: string;
  /** v5 ONLY: theses the model is establishing, moving on, or replacing this cycle. */
  position_notes?: PositionNote[];
  /** A SHORT, phone-friendly one-liner for the activity notification (the "why"). */
  notification_summary: string;
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
export function buildDecisionSchema(assets: string[], strategy: StrategyVersion = 'v4') {
  const allocationShape: Record<string, z.ZodNumber> = {};
  // Per-asset bounds (0..100). zodOutputFormat strips the keywords the API can't
  // enforce and validates them client-side, so these are belt-and-suspenders;
  // the cross-field sum-to-100 rule stays in validateDecision (the real guard).
  for (const asset of assets) allocationShape[asset] = z.number().min(0).max(100);

  const common = {
    target_allocation: z.strictObject(allocationShape),
    action_type: actionTypeSchema,
    what_changed: z.string().min(1),
    confidence: confidenceSchema,
    reasoning: z.string().min(1),
    notification_summary: z.string().min(1),
    next_delay_minutes: z.number(),
  };

  // The two shapes differ by exactly what changed hands: v4 has the model DECLARE the
  // market state; v5 takes that away (the code computes the regime) and gives it the
  // thesis instead. Keeping them as two strict objects means a v4 response cannot
  // quietly satisfy the v5 contract, or the reverse.
  if (strategy === 'v5') {
    return z.strictObject({
      ...common,
      position_notes: z.array(
        z.strictObject({
          asset: z.string().min(1),
          thesis: z.string().min(1),
          invalidation: z.string().min(1),
          replace: z.boolean(),
        }),
      ),
    });
  }

  return z.strictObject({ ...common, market_state: marketStateSchema });
}

export interface ValidatedDecision {
  targetAllocation: Record<string, number>;
  actionType: ActionType;
  whatChanged: string;
  confidence: Confidence;
  /** v4: what the model declared. v5: null — the caller fills it from the code's regime. */
  marketState: MarketState | null;
  reasoning: string;
  /** v5: the theses the model wants written. Empty under v4. */
  positionNotes: PositionNote[];
  notificationSummary: string;
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
  strategy: StrategyVersion = 'v4',
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

  const notificationSummary = (parsed.notification_summary ?? '').trim();
  if (!notificationSummary) return { ok: false, error: 'notification_summary is empty' };

  // The regime changed hands in v5: the model declares it under v4 and must NOT under
  // v5. Checked both ways so a stale prompt cannot silently pair with the new strategy.
  const marketState = parsed.market_state ?? null;
  if (strategy === 'v4' && marketState == null) {
    return { ok: false, error: 'market_state is missing (required under v4)' };
  }
  if (strategy === 'v5' && marketState != null) {
    return {
      ok: false,
      error: `market_state was declared ("${marketState}") but under v5 the regime is the code's, not the model's`,
    };
  }

  // Theses may only be written for assets the model can actually allocate to, and
  // never for the reserve stable — cash has no thesis.
  const reserves = new Set(reserveStables(cfg));
  const positionNotes: PositionNote[] = [];
  for (const note of parsed.position_notes ?? []) {
    if (strategy !== 'v5') {
      return { ok: false, error: 'position_notes was returned but is v5-only' };
    }
    if (!allowed.has(note.asset) || reserves.has(note.asset)) {
      return { ok: false, error: `position_notes references "${note.asset}", which is not a tradable position` };
    }
    const thesis = (note.thesis ?? '').trim();
    const invalidation = (note.invalidation ?? '').trim();
    if (!thesis || !invalidation) {
      return { ok: false, error: `position_notes["${note.asset}"] has an empty thesis or invalidation` };
    }
    positionNotes.push({ asset: note.asset, thesis, invalidation, replace: note.replace === true });
  }

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
      marketState,
      reasoning,
      positionNotes,
      notificationSummary,
      requestedDelayMinutes: requested,
      appliedDelayMinutes: applied,
    },
  };
}
