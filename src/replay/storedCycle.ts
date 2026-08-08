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
import { resolveEffectiveTarget } from '../decision/effectiveTarget.js';

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
  applied_allocation: unknown;
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

export type CycleVerdict =
  | {
      kind: 'accepted';
      decision: ValidatedDecision;
      /**
       * What production would have written to `applied_allocation` for this cycle — the
       * risk-clamped target. Carried so the reference chain can be established from the
       * EFFECTIVE target rather than from the raw proposal, exactly as production reads it
       * back. Identical to `decision.targetAllocation` on the whole corpus (the clamp has
       * never fired), which is what makes this change provably inert.
       */
      appliedAllocation: Record<string, number>;
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

/**
 * Runs one decision through the guard with that cycle's real book — bounding it to the
 * caps and sizing the movements exactly as the executor would, 2% floor included.
 */
export function judge(
  decision: ValidatedDecision,
  ctx: StoredContext,
  referenceTarget: Record<string, number> | null,
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
   * raw-versus-applied, one level down. Tighten a cap and a historical hold whose 40% was
   * applied at 35% against a 35% reference gets replayed at 30% and rejected for moving a
   * target it never moved, with its movements resized to match.
   */
  storedApplied?: unknown,
): { ok: boolean; violations: CoherenceViolation[]; appliedAllocation: Record<string, number> } {
  const book = bookOf(ctx);
  const clamp = clampAllocation(decision.targetAllocation, book.reserveAsset, config);
  // The row is the fact; the recomputation is a guess that happens to be right today. The
  // resolver doubles as the validator — an unusable stored value falls back to the clamp
  // rather than poisoning the judgement.
  const stored = resolveEffectiveTarget({ applied_allocation: storedApplied });
  const effective = stored.source === 'applied' ? stored.allocation! : clamp.applied;
  const movements = computeMovements(
    book,
    effective,
    pricesOf(ctx),
    config.execution.feePercent,
    config.execution.minMovementPercent,
  );
  const verdict = checkCoherence({
    // The corpus is v5 by construction (`loadCorpus` filters on prompt_version).
    strategy: 'v5',
    actionType: decision.actionType,
    // The same operand production feeds the guard, and the same one the movements were
    // sized from — so the replay cannot judge on a different basis from the live path.
    effectiveTarget: effective,
    referenceTarget,
    movements,
    reserveAsset: book.reserveAsset,
    notes: decision.positionNotes,
    assetsWithStoredThesis: thesesOf(ctx),
  });
  // Returned rather than discarded: this is the value production would have written to
  // `applied_allocation`, so `replayInOrder` establishes the next reference from it — one
  // resolution point for the whole chain instead of one per caller.
  return { ...verdict, appliedAllocation: effective };
}

/** One journaled cycle, decoded and judged. */
export function replayCycle(
  cycle: StoredCycle,
  referenceTarget: Record<string, number> | null,
): CycleVerdict {
  const assets = universeOf(cycle.market_context);
  const decoded = decodeResponse(cycle.raw_response, assets);
  if (!decoded.ok) return { kind: 'unusable', reason: decoded.reason };

  const verdict = judge(
    decoded.decision,
    cycle.market_context,
    referenceTarget,
    // This IS the response the row recorded, so its persisted applied allocation applies.
    cycle.applied_allocation,
  );
  return verdict.ok
    ? { kind: 'accepted', decision: decoded.decision, appliedAllocation: verdict.appliedAllocation }
    : { kind: 'rejected', decision: decoded.decision, violations: verdict.violations };
}

export interface ReplayStep {
  cycle: StoredCycle;
  verdict: CycleVerdict;
  /** The reference target this cycle was judged against. */
  referenceTarget: Record<string, number> | null;
}

/**
 * Feeds the corpus through the guard IN ORDER.
 *
 * The ordering is load-bearing and is the correction the brief's §4.2 needed: the
 * reference is the last target the guard ACCEPTED, not the previous cycle's target. A
 * rejected cycle books nothing and establishes nothing, so it must not move the
 * reference — which is exactly what production does, where the reference is read from the
 * last `decided` row and a rejected cycle is journaled `guard_failed`.
 *
 * And it is the EFFECTIVE target that carries forward, not the raw proposal — the same
 * definition `loadReferenceTarget` now resolves in production, so the two cannot drift.
 * Production writes `applied_allocation = clamp.applied` and reads that column back; the
 * replay rebuilds the same value from the same clamp and feeds it through the same
 * `resolveEffectiveTarget`. On this corpus the clamp has never fired, so the reference is
 * unchanged cycle for cycle — which is exactly why the change can be made now and proven
 * inert, instead of on the day the transition gate makes the two columns diverge.
 *
 * Read the difference on the real corpus: 946/948/957 propose BNB at 11% against a
 * standing 12% and are rejected; 947/949/958 re-emit 12% and pass. Under "compare to the
 * previous cycle" those three would be rejected too, and the verdict would be 8, not 5.
 */
export function replayInOrder(cycles: StoredCycle[]): ReplayStep[] {
  let reference: Record<string, number> | null = null;
  const steps: ReplayStep[] = [];
  for (const cycle of cycles) {
    const referenceTarget = reference;
    const verdict = replayCycle(cycle, referenceTarget);
    steps.push({ cycle, verdict, referenceTarget });
    // `judge` already resolved this cycle's effective target from the persisted column
    // (falling back to the recomputed clamp only when the row has none), and judged it
    // against that same value. Reading it back here keeps ONE resolution point for the
    // whole chain: the candidate the guard saw and the reference the next cycle gets are
    // the same object, so they cannot drift apart through a second fallback written twice.
    if (verdict.kind === 'accepted') reference = verdict.appliedAllocation;
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
      .select('id, created_at, raw_response, market_context, target_allocation, applied_allocation')
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
