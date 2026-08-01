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

  // ── THE ORDER OF THESE FIELDS IS THE FIX, NOT A STYLE CHOICE ──────────────────
  //
  // A model reasons BY WRITING. The previous contract asked for `target_allocation`
  // and `action_type` first: it posed its numbers, thought afterwards, sometimes
  // changed its mind, and could no longer revisit fields it had already emitted.
  //
  // Cycle 987 (30/07) is the whole argument. Its reasoning, its notification and its
  // new BNB thesis all describe lightening BNB from 12% to 8% with cash to 47%. The
  // fields emitted first say `hold`, BNB 12%, cash 43%. No order was created. The
  // decision was right — BNB sat at 97% of its 4h range, RSI 4h at 75, at the monthly
  // high, and the standing thesis said explicitly to lighten between $580 and $593.
  // It was lost by the output contract, not by the mandate.
  //
  // So: ANALYSIS first, then the decision, then how it is communicated.
  //
  //   1. reasoning            — where the model actually thinks;
  //   2. what_changed         — the justification; still analysis;
  //   3. target_allocation    — the decision, written by a model that has thought;
  //   4. action_type          — and its label, consistent with the target above it;
  //   5. position_notes       — the theses that go WITH the moves (v5) / market_state (v4);
  //   6. confidence           — how sure it is of what it has just decided;
  //   7. notification_summary — the human one-liner, written LAST so it can only
  //                             describe the target that precedes it. On 987 this
  //                             field announced an allègement the target never made;
  //   8. next_delay_minutes.
  //
  // Empirically load-bearing and empirically verified: all 139 v5 production responses
  // emitted their keys in exactly this object's declaration order, so the constrained
  // decoder follows the schema. The Anthropic docs do NOT guarantee that, which is why
  // `outputOrderViolation` below re-checks it on every response rather than trusting it.
  const analysis = {
    reasoning: z.string().min(1),
    what_changed: z.string().min(1),
  };
  const decision = {
    target_allocation: z.strictObject(allocationShape),
    action_type: actionTypeSchema,
  };
  const tail = {
    confidence: confidenceSchema,
    notification_summary: z.string().min(1),
    next_delay_minutes: z.number(),
  };

  // The two shapes differ by exactly what changed hands: v4 has the model DECLARE the
  // market state; v5 takes that away (the code computes the regime) and gives it the
  // thesis instead. Keeping them as two strict objects means a v4 response cannot
  // quietly satisfy the v5 contract, or the reverse.
  if (strategy === 'v5') {
    return z.strictObject({
      ...analysis,
      ...decision,
      position_notes: z.array(
        z.strictObject({
          asset: z.string().min(1),
          thesis: z.string().min(1),
          invalidation: z.string().min(1),
          replace: z.boolean(),
        }),
      ),
      ...tail,
    });
  }

  return z.strictObject({ ...analysis, ...decision, market_state: marketStateSchema, ...tail });
}

/**
 * The fields whose ORDER is load-bearing, earliest first. Exported so the offline test
 * pins the contract against the schema rather than against a copy of it.
 */
export const OUTPUT_ORDER_ANCHORS = ['reasoning', 'target_allocation'] as const;

/**
 * Did the model emit its target BEFORE its reasoning? Read on the RAW TEXT, because
 * that is the only place the order survives — `JSON.parse` returns an object and any
 * ordering information is gone by then (jsonb in Postgres reorders too, which is how
 * this nearly went unnoticed).
 *
 * A violation is SYSTEMIC, not a bad cycle. The key order is deterministic and comes
 * from the schema, so if it ever breaks it breaks every cycle identically — relaunching
 * would burn a second LLM call to reach the same wall. The caller therefore kills the
 * cycle outright, alerts, and does NOT retry.
 *
 * Returns null when the contract holds, or the reason when it does not. A field that is
 * absent entirely is not this function's problem (the schema parse already rejected it),
 * so a missing anchor reads as "no violation to report here".
 */
export function outputOrderViolation(rawResponse: string): string | null {
  const positions = OUTPUT_ORDER_ANCHORS.map((field) => ({
    field,
    at: rawResponse.indexOf(`"${field}"`),
  }));
  if (positions.some((p) => p.at < 0)) return null;
  for (let i = 1; i < positions.length; i += 1) {
    const previous = positions[i - 1]!;
    const current = positions[i]!;
    if (current.at < previous.at) {
      return (
        `the model emitted "${current.field}" (char ${current.at}) BEFORE "${previous.field}" ` +
        `(char ${previous.at}). The output contract puts the reasoning first precisely so the ` +
        'target is written by a model that has already thought — this response was produced the ' +
        'other way round, which is the cycle-987 failure mode.'
      );
    }
  }
  return null;
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
  // One entry per position. Two entries for the same asset are silently collapsed
  // downstream (the lifecycle keys them by asset, so the last one wins), which would
  // persist an arbitrary choice between two conflicting theses. A contradiction is a
  // reason to reject the whole decision, not to pick one at random.
  const seenAssets = new Set<string>();
  for (const note of parsed.position_notes ?? []) {
    if (strategy !== 'v5') {
      return { ok: false, error: 'position_notes was returned but is v5-only' };
    }
    if (!allowed.has(note.asset) || reserves.has(note.asset)) {
      return { ok: false, error: `position_notes references "${note.asset}", which is not a tradable position` };
    }
    if (seenAssets.has(note.asset)) {
      return { ok: false, error: `position_notes contains "${note.asset}" twice — one thesis per position` };
    }
    seenAssets.add(note.asset);
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
