import { config } from '../config/index.js';
import { Decimal, dec } from '../money.js';
import type { PriceLookup, VirtualPortfolio } from '../portfolio/derive.js';
import { computeMovements } from '../execution/movements.js';
import { clampAllocation } from '../risk/clamp.js';
import {
  buildDecisionSchema,
  validateDecision,
  type DecisionOutput,
  type ValidatedDecision,
} from '../decision/schema.js';
import { checkCoherence, type CoherenceViolation } from '../decision/coherence.js';
import { restateIntentReference } from '../decision/intentReference.js';
import {
  resolveEffectiveTarget,
  resolveIntentAllocation,
} from '../decision/effectiveTarget.js';

/**
 * Rebuilding one journaled cycle into the exact inputs the guard would have seen.
 *
 * Shared by the corpus replay (`replay:coherence`) and the single-cycle recovery proof
 * (`replay:retry-1000`) on purpose: if the recovery proof reconstructed its cycle even
 * slightly differently from the corpus replay, it would be proving something about its
 * own reconstruction rather than about the guard. One reconstruction, two consumers.
 */

export interface StoredPosition {
  asset: string;
  qty: number;
  avgCost: number;
  price: number;
  priceStale: boolean;
  value: number;
  unrealizedPnl: number;
  weightPercent: number;
}

/** v5 only — the lifecycle exactly as that cycle saw it, thesis included. */
export interface StoredLifecycle {
  asset: string;
  thesis: string | null;
}

export interface StoredContext {
  market: { tradable: Array<{ symbol: string; price: number }> };
  account: {
    portfolio: {
      reserveAsset: string;
      startingCapital: number;
      cash: number;
      equity: number;
      deployedPercent: number;
      realizedPnl: number;
      unrealizedPnl: number;
      totalPnl: number;
      positions: StoredPosition[];
    };
  };
  positions?: StoredLifecycle[];
}

export interface StoredCycle {
  id: number;
  created_at: string;
  raw_response: string;
  market_context: StoredContext;
  /**
   * The two allocation columns AS PERSISTED, carried so the reference chain can advance on
   * the value production actually wrote rather than on one recomputed here.
   *
   * The distinction is empty today and will not stay that way. Re-running `clampAllocation`
   * applies TODAY's caps to a historical target: change a cap, or let another deterministic
   * gate adjust the target, and the recomputed value stops being what the row holds — every
   * later verdict in the chain would then diverge from the guard chain that actually ran.
   * The row is the fact; the recomputation is a guess that happens to be right for now.
   */
  target_allocation: unknown;
  /** Migration 0027. Null on every corpus row — the resolver falls back to the proposal. */
  intent_allocation?: unknown;
  applied_allocation: unknown;
  /**
   * Set only when the transition gate refused the vector — carried so the replay resolves an
   * intention exactly the way production does, reconstruction branch included. Null on every
   * corpus row.
   */
  applied_divergence_cause?: unknown;
}

/** The virtual book EXACTLY as that cycle saw it. */
export function bookOf(ctx: StoredContext): VirtualPortfolio {
  const p = ctx.account.portfolio;
  return {
    reserveAsset: p.reserveAsset,
    startingCapital: dec(p.startingCapital),
    cash: dec(p.cash),
    equity: dec(p.equity),
    deployedPercent: dec(p.deployedPercent),
    realizedPnl: dec(p.realizedPnl),
    unrealizedPnl: dec(p.unrealizedPnl),
    totalPnl: dec(p.totalPnl),
    positions: p.positions.map((pos) => ({
      asset: pos.asset,
      qty: dec(pos.qty),
      avgCost: dec(pos.avgCost),
      price: dec(pos.price),
      priceStale: pos.priceStale,
      value: dec(pos.value),
      unrealizedPnl: dec(pos.unrealizedPnl),
      weightPercent: dec(pos.weightPercent),
    })),
  };
}

/** Prices as that cycle had them: the reserve is 1, every pair carries its own. */
export function pricesOf(ctx: StoredContext): PriceLookup {
  const reserve = ctx.account.portfolio.reserveAsset;
  const map = new Map<string, Decimal>();
  for (const pair of ctx.market.tradable) {
    const [base, quote] = pair.symbol.split('/');
    if (base && quote === reserve && Number.isFinite(pair.price) && pair.price > 0) {
      map.set(base, dec(pair.price));
    }
  }
  return (asset: string): Decimal | null => (asset === reserve ? dec(1) : (map.get(asset) ?? null));
}

/** The allocatable universe that cycle was offered, derived the same way decide() does. */
export function universeOf(ctx: StoredContext): string[] {
  const reserve = ctx.account.portfolio.reserveAsset;
  const assets: string[] = [];
  const seen = new Set<string>();
  for (const pair of ctx.market.tradable) {
    const base = pair.symbol.split('/')[0];
    if (base && !seen.has(base)) {
      seen.add(base);
      assets.push(base);
    }
  }
  if (!seen.has(reserve)) assets.push(reserve);
  return assets;
}

/**
 * The assets that already carried a thesis, read from that cycle's OWN journaled
 * context rather than reconstructed by replaying the notes forward. This is what makes
 * rule 3 a genuine replay: the guard is checked against the lifecycle state the model
 * was actually shown at that moment.
 */
export function thesesOf(ctx: StoredContext): Set<string> {
  return new Set(
    (ctx.positions ?? []).filter((p) => (p.thesis ?? '').trim() !== '').map((p) => p.asset),
  );
}

/**
 * THE TWO REFERENCES a replayed cycle is judged against, mirroring what production reads
 * back from the last `decided` row.
 *
 *   `intent`   the last INTENTION — the coherence guard's rule-1 operand.
 *   `applied`  the last EFFECTIVE target — what the book pursued. Carried because the
 *              LEGACY operand mode needs it, and because it is what the transition gate
 *              reverts to; the split guard never reads it.
 */
export interface ReplayReferences {
  intent: Record<string, number> | null;
  applied: Record<string, number> | null;
}

/**
 * WHICH OPERANDS the guard is fed — the mechanism that makes "prove it is neutral" a
 * measurement rather than an argument.
 *
 * `split` is production. `legacy` reproduces the PRE-PR guard EXACTLY, using the same
 * `checkCoherence` rather than a second copy of the rules:
 *
 *   rule 1  bounded candidate against a bounded, restated APPLIED reference — which is
 *           literally what the old code computed inside the guard;
 *   rule 2  no counterfactual at all, i.e. an empty previous plan, which collapses the
 *           new disjunction back to "does the new plan trade this line".
 *
 * Reproducing the old behaviour through the new function is deliberate. A second
 * implementation of the rules would only prove that the two implementations agree, and the
 * question being asked is whether the OPERANDS moved a verdict.
 */
export type GuardOperands = 'split' | 'legacy';

export type CycleVerdict =
  | {
      kind: 'accepted';
      decision: ValidatedDecision;
      /**
       * What production would have written to `applied_allocation` for this cycle — the
       * risk-clamped target, or the value the row actually holds. Carried so the applied
       * chain advances on the same value production read back.
       */
      appliedAllocation: Record<string, number>;
      /**
       * What production would have written to `intent_allocation` — the raw proposal, since
       * no replayed cycle can have a peak stop firing (the corpus predates enforcement, and
       * the replay has no stop state to apply). Carried so the intent chain advances the way
       * production advances it.
       */
      intentAllocation: Record<string, number>;
    }
  | { kind: 'rejected'; decision: ValidatedDecision; violations: CoherenceViolation[] }
  | { kind: 'unusable'; reason: string };

/** Parses and validates one journaled response against the (reordered) v5 contract. */
export function decodeResponse(
  rawResponse: string,
  assets: string[],
): { ok: true; decision: ValidatedDecision } | { ok: false; reason: string } {
  let parsed: DecisionOutput;
  try {
    const json: unknown = JSON.parse(rawResponse);
    const result = buildDecisionSchema(assets, 'v5').safeParse(json);
    if (!result.success) {
      return {
        ok: false,
        reason: result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
    }
    parsed = result.data as DecisionOutput;
  } catch (err) {
    return {
      ok: false,
      reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validation = validateDecision(parsed, assets, config, 'v5');
  return validation.ok
    ? { ok: true, decision: validation.value }
    : { ok: false, reason: validation.error };
}

export interface JudgeResult {
  ok: boolean;
  violations: CoherenceViolation[];
  appliedAllocation: Record<string, number>;
  /** The counterfactual plan rule 2 was given, reported so a diff can explain itself. */
  previousIntentMovements: number;
}

/**
 * Runs one decision through the guard with that cycle's real book — bounding it to the
 * caps and sizing the movements exactly as the executor would, 2% floor included.
 */
export function judge(
  decision: ValidatedDecision,
  ctx: StoredContext,
  references: ReplayReferences,
  /**
   * That cycle's PERSISTED `applied_allocation`, when the decision being judged is the one
   * the row actually recorded.
   *
   * Passed by `replayCycle` and deliberately NOT by the retry proof, which judges a freshly
   * generated response: that decision was never persisted, so it has no stored applied
   * allocation and re-clamping is the only honest answer for it.
   *
   * Without it the replay judges the CURRENT cycle against a clamp recomputed with today's
   * caps while comparing it to a reference taken from history — the same asymmetry as
   * raw-versus-applied, one level down.
   */
  storedApplied?: unknown,
  operands: GuardOperands = 'split',
): JudgeResult {
  const book = bookOf(ctx);
  const reserveAsset = book.reserveAsset;
  const universe = universeOf(ctx);
  const clamp = clampAllocation(decision.targetAllocation, reserveAsset, config);
  // The row is the fact; the recomputation is a guess that happens to be right today. The
  // resolver doubles as the validator — an unusable stored value falls back to the clamp
  // rather than poisoning the judgement.
  const stored = resolveEffectiveTarget({ applied_allocation: storedApplied });
  const effective = clampAllocation(
    stored.source === 'applied' ? stored.allocation! : clamp.applied,
    reserveAsset,
    config,
  ).applied;
  const movements = computeMovements(
    book,
    effective,
    pricesOf(ctx),
    config.execution.feePercent,
    config.execution.minMovementPercent,
  );

  // THE RESTATEMENT, through the one production pipeline. Which value goes into it is the
  // whole difference between the two modes — the intention for `split`, the applied target
  // for `legacy`, exactly as the old guard did.
  const source = operands === 'split' ? references.intent : references.applied;
  const restated = source
    ? restateIntentReference({ reference: source, universe, reserveAsset, policy: config })
    : null;
  if (restated && !restated.ok) {
    // Production skips the cycle here. The replay cannot skip — a missing verdict would
    // silently shrink the corpus — so it surfaces the reason as an unusable reference and
    // lets the caller count it.
    throw new Error(`replay: the stored reference cannot be restated — ${restated.reason}`);
  }

  const intentReference = restated?.ok
    ? // `split` compares raw intentions; `legacy` compared the BOUNDED reference against a
      // BOUNDED candidate, which is where the relaxed-policy loss came from.
      operands === 'split'
      ? restated.value.intent
      : restated.value.bounded
    : null;
  const previousIntentMovements =
    operands === 'split' && restated?.ok
      ? computeMovements(
          book,
          restated.value.bounded,
          pricesOf(ctx),
          config.execution.feePercent,
          config.execution.minMovementPercent,
        )
      : [];

  const verdict = checkCoherence({
    // The corpus is v5 by construction (`loadCorpus` filters on prompt_version).
    strategy: 'v5',
    actionType: decision.actionType,
    // Raw under `split` — the same operand production feeds the guard. Bounded under
    // `legacy`, which is what the old code compared.
    intentTarget: operands === 'split' ? decision.targetAllocation : effective,
    intentReference,
    movements,
    previousIntentMovements,
    reserveAsset,
    notes: decision.positionNotes,
    assetsWithStoredThesis: thesesOf(ctx),
  });
  return {
    ...verdict,
    appliedAllocation: effective,
    previousIntentMovements: previousIntentMovements.length,
  };
}

/** One journaled cycle, decoded and judged. */
export function replayCycle(
  cycle: StoredCycle,
  references: ReplayReferences,
  operands: GuardOperands = 'split',
): CycleVerdict {
  const assets = universeOf(cycle.market_context);
  const decoded = decodeResponse(cycle.raw_response, assets);
  if (!decoded.ok) return { kind: 'unusable', reason: decoded.reason };

  const verdict = judge(
    decoded.decision,
    cycle.market_context,
    references,
    // This IS the response the row recorded, so its persisted applied allocation applies.
    cycle.applied_allocation,
    operands,
  );
  if (!verdict.ok) {
    return { kind: 'rejected', decision: decoded.decision, violations: verdict.violations };
  }
  // The intention this cycle would have established. `resolveIntentAllocation` is the same
  // resolver production reads with — including its provenance columns, so a row written
  // without an intention while a peak stop fired is reconstructed here exactly as it would
  // be there. On the corpus that branch is unreachable (the stop has never fired), which is
  // what keeps the chain identical to what production walked.
  const storedIntent = resolveIntentAllocation(
    {
      intent_allocation: cycle.intent_allocation,
      target_allocation: cycle.target_allocation,
      applied_allocation: cycle.applied_allocation,
      applied_divergence_cause: cycle.applied_divergence_cause,
    },
    cycle.market_context.account.portfolio.reserveAsset,
  );
  return {
    kind: 'accepted',
    decision: decoded.decision,
    appliedAllocation: verdict.appliedAllocation,
    intentAllocation: storedIntent.allocation ?? decoded.decision.targetAllocation,
  };
}

export interface ReplayStep {
  cycle: StoredCycle;
  verdict: CycleVerdict;
  /** The references this cycle was judged against. */
  references: ReplayReferences;
}

/**
 * Feeds the corpus through the guard IN ORDER.
 *
 * The ordering is load-bearing: the reference is the last decision the guard ACCEPTED, not
 * the previous cycle's. A rejected cycle books nothing and establishes nothing, so it must
 * not move either reference — which is exactly what production does, where both are read
 * from the last `decided` row and a rejected cycle is journaled `guard_failed`.
 *
 * TWO CHAINS ADVANCE TOGETHER, from the same accepted cycle, because production writes
 * both columns on the same row. The intention chain is the one the guard reads; the applied
 * chain is carried so the `legacy` mode can be replayed against the operand it actually
 * used, which is what makes the before/after diff a measurement.
 *
 * Read the difference the ordering makes on the real corpus: 946/948/957 propose BNB at 11%
 * against a standing 12% and are rejected; 947/949/958 re-emit 12% and pass. Under "compare
 * to the previous cycle" those three would be rejected too, and the verdict would be 8, not 5.
 */
export function replayInOrder(
  cycles: StoredCycle[],
  operands: GuardOperands = 'split',
): ReplayStep[] {
  let references: ReplayReferences = { intent: null, applied: null };
  const steps: ReplayStep[] = [];
  for (const cycle of cycles) {
    const judgedAgainst = references;
    const verdict = replayCycle(cycle, judgedAgainst, operands);
    steps.push({ cycle, verdict, references: judgedAgainst });
    if (verdict.kind === 'accepted') {
      references = { intent: verdict.intentAllocation, applied: verdict.appliedAllocation };
    }
  }
  return steps;
}

/** Reads the whole v5 corpus, paged (PostgREST caps a response at 1000 rows). */
export async function loadCorpus(
  supabase: NonNullable<ReturnType<typeof import('../persistence/supabase.js').getSupabaseClient>>,
  opts: { maxId?: number } = {},
): Promise<StoredCycle[]> {
  const PAGE = 500;
  const cycles: StoredCycle[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from('decisions')
      .select(
        'id, created_at, raw_response, market_context, target_allocation, intent_allocation, ' +
          'applied_allocation, applied_divergence_cause',
      )
      .eq('status', 'decided')
      .eq('prompt_version', 'v5')
      .not('raw_response', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (opts.maxId != null) query = query.lte('id', opts.maxId);
    const { data, error } = await query;
    if (error) throw new Error(`replay: could not read decisions (${error.message}).`);
    const page = (data ?? []) as unknown as StoredCycle[];
    cycles.push(...page);
    if (page.length < PAGE) break;
  }
  return cycles;
}