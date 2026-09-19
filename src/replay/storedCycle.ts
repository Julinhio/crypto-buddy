import { config } from '../config/index.js';
import { Decimal, dec } from '../money.js';
import type { PriceLookup, VirtualPortfolio } from '../portfolio/derive.js';
import { computeMovements, type Movement } from '../execution/movements.js';
import { clampAllocation } from '../risk/clamp.js';
import {
  buildDecisionSchema,
  validateDecision,
  type DecisionOutput,
  type ValidatedDecision,
} from '../decision/schema.js';
import { checkCoherence, sameTarget, type CoherenceViolation } from '../decision/coherence.js';
import { restateIntentReference } from '../decision/intentReference.js';
import {
  resolveEffectiveTarget,
  resolveIntentAllocation,
} from '../decision/effectiveTarget.js';
import { allocationsAgree, journaledClampedAllocation } from '../exposure/counterfactual.js';

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
  /**
   * THE CLAMPED PROPOSAL AS PRODUCTION'S GUARD SAW IT — `exposure_band_corrections`, embedded
   * (one row per universe asset, since brick 2 of the pilot). The guard judges the movements
   * of the RISK-BOUNDED proposal against the book, and since the pilot is armed the row's
   * `applied_allocation` is no longer that value: it is the allocation the band corrected
   * AFTER the guard had passed. Judging on it replayed the band's own legs as the model's and
   * reported seventeen accepted cycles as `moved_line_without_note` — the same misreading the
   * witnesses replay had to fix for B̂. Empty on every row predating the journal.
   */
  exposure_band_corrections?: Array<{ asset: string; clamped_weight_percent: string | number }> | null;
  /**
   * Did this cycle BOOK an executed intent — production's own definition of a significant
   * decision (`loadLastSignificantDecision`: an inner join on an executed intent). It is
   * what moves the memory the model is shown, and therefore the shown applied target the
   * guard lets a hold keep. Filled by `loadCorpus`; absent means "not known", not "no".
   */
  significant?: boolean;
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
 *   `applied`  the last EFFECTIVE target — what the book pursued. The LEGACY operand mode
 *              compares against it (bounded); the split guard reads it as the SECOND target
 *              a hold may keep (PR #48), restated like the intention. On the corpus before
 *              the band the two are equal on every row, so nothing there can move.
 */
export interface ReplayReferences {
  intent: Record<string, number> | null;
  applied: Record<string, number> | null;
  /**
   * The applied allocation the model was SHOWN — the effective target of the last
   * SIGNIFICANT decision before the cycle, the one the prompt's memory block quotes. The
   * second applied target rule 1 lets a hold keep (PR #48). Null when unknown, and null on
   * the corpus chain before the band, where it could only equal the applied one anyway.
   */
  shownApplied?: Record<string, number> | null;
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

/**
 * WHERE THE GUARD'S MOVEMENT TARGET CAME FROM, so a caller can print it next to a verdict.
 *
 *   journal_clamped              the journaled clamp of the proposal — production's exact input
 *                                to the corrector, and to the guard before it (brick 2 onwards)
 *   stored_applied               the row's applied allocation, equal to the recomputed clamp:
 *                                nothing downstream reshaped the proposal, the row is the fact
 *   clamp_recomputed             no stored applied at all — a fresh response (retry proof)
 *   clamp_recomputed_diverges    the stored applied is NOT the clamped proposal and no journal
 *                                says what the clamp was: something downstream of the guard
 *                                reshaped the target (a band correction with its journal row
 *                                missing, a gate revert, a stop). The guard never judged that
 *                                value, so the clamp is recomputed under today's caps — named,
 *                                because a cap change since would make it a guess.
 */
export type GuardTargetSource =
  | 'journal_clamped'
  | 'stored_applied'
  | 'clamp_recomputed'
  | 'clamp_recomputed_diverges';

export interface JudgeResult {
  ok: boolean;
  violations: CoherenceViolation[];
  /**
   * What production wrote as `applied_allocation` — the value the NEXT cycle reads back as
   * its applied reference. The stored one when the row has it (since the pilot it is the
   * band-corrected allocation, and that is precisely what the chain reads); the recomputed
   * clamp otherwise.
   */
  appliedAllocation: Record<string, number>;
  /** The target the guard's movements were computed from, and where it came from. */
  guardTarget: Record<string, number>;
  guardTargetSource: GuardTargetSource;
  /** The movements the guard judged — the guard target against the book, 2% floor applied. */
  guardMovements: Movement[];
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
  /**
   * The journaled clamp of the proposal (`exposure_band_corrections.clamped_weight_percent`,
   * reserve reconstructed), when the row carries one. It is the value production's guard
   * computed its movements from, and it takes precedence over everything else — see
   * `GuardTargetSource`.
   */
  journaledClamp: Record<string, number> | null = null,
): JudgeResult {
  const book = bookOf(ctx);
  const reserveAsset = book.reserveAsset;
  const universe = universeOf(ctx);
  const clamp = clampAllocation(decision.targetAllocation, reserveAsset, config);
  // The resolver doubles as the validator — an unusable stored value falls back to the clamp
  // rather than poisoning the judgement.
  const stored = resolveEffectiveTarget({ applied_allocation: storedApplied });
  const storedAgreesWithClamp =
    stored.source === 'applied' &&
    allocationsAgree(stored.allocation!, clamp.applied, universe.filter((a) => a !== reserveAsset), reserveAsset).agree;
  // THE GUARD'S TARGET — the clamped PROPOSAL, which is what `evaluate()` in decide() hands
  // to computeMovements. The journal says exactly what that was; failing a journal, the
  // row's applied allocation is that value only when nothing downstream reshaped it (the
  // row is the fact, the recomputation a guess that a cap change could falsify); failing
  // both, the clamp is recomputed and the divergence is named.
  const guardTargetSource: GuardTargetSource = journaledClamp
    ? 'journal_clamped'
    : stored.source !== 'applied'
      ? 'clamp_recomputed'
      : storedAgreesWithClamp
        ? 'stored_applied'
        : 'clamp_recomputed_diverges';
  const effective = clampAllocation(
    journaledClamp ?? (guardTargetSource === 'stored_applied' ? stored.allocation! : clamp.applied),
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
  // THE APPLIED TARGETS a hold may keep — the reference row's applied allocation and the
  // one the model was shown, each restated through the same pipeline and deduplicated,
  // exactly as `decide()` derives them. Production reads them; the legacy guard never had
  // them. A value absent or not restatable is simply not offered, as in production.
  const appliedReferences: Record<string, number>[] = [];
  if (operands === 'split') {
    for (const candidate of [references.applied, references.shownApplied ?? null]) {
      if (candidate == null) continue;
      const restatedApplied = restateIntentReference({ reference: candidate, universe, reserveAsset, policy: config });
      if (!restatedApplied.ok) continue;
      if (!appliedReferences.some((known) => sameTarget(known, restatedApplied.value.intent))) appliedReferences.push(restatedApplied.value.intent);
    }
  }
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
    appliedReferences,
    movements,
    previousIntentMovements,
    reserveAsset,
    notes: decision.positionNotes,
    assetsWithStoredThesis: thesesOf(ctx),
  });
  return {
    ...verdict,
    // What the next cycle reads back: the row's own applied allocation when it has one.
    appliedAllocation: stored.source === 'applied' ? stored.allocation! : effective,
    guardTarget: effective,
    guardTargetSource,
    guardMovements: movements,
    previousIntentMovements: previousIntentMovements.length,
  };
}

/**
 * The clamped proposal the corrections journal recorded for a cycle, as an allocation —
 * reserve included — or null when the row carries no complete journal. Read through the
 * witnesses' own builder so the two replays cannot disagree about what the journal says.
 */
export function journaledClampOf(cycle: StoredCycle): Record<string, number> | null {
  const rows = cycle.exposure_band_corrections;
  if (rows == null || rows.length === 0) return null;
  const ctx = cycle.market_context;
  const reserveAsset = ctx.account.portfolio.reserveAsset;
  const universe = universeOf(ctx).filter((asset) => asset !== reserveAsset);
  const lines = rows.map((row) => ({ asset: row.asset, clampedWeightPercent: Number(row.clamped_weight_percent) }));
  return journaledClampedAllocation(lines, universe, reserveAsset);
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
    journaledClampOf(cycle),
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
  let references: ReplayReferences = { intent: null, applied: null, shownApplied: null };
  const steps: ReplayStep[] = [];
  for (const cycle of cycles) {
    const judgedAgainst = references;
    const verdict = replayCycle(cycle, judgedAgainst, operands);
    steps.push({ cycle, verdict, references: judgedAgainst });
    if (verdict.kind === 'accepted') {
      references = {
        intent: verdict.intentAllocation,
        applied: verdict.appliedAllocation,
        // The memory the NEXT cycle is shown moves only on a SIGNIFICANT cycle — one that
        // booked an executed intent — exactly like `loadLastSignificantDecision`.
        shownApplied: cycle.significant ? verdict.appliedAllocation : (judgedAgainst.shownApplied ?? null),
      };
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
          'applied_allocation, applied_divergence_cause, ' +
          // The clamped proposal the corrector received — embedded through the FK, one row per
          // universe asset since brick 2, empty before. See StoredCycle.exposure_band_corrections.
          'exposure_band_corrections(asset, clamped_weight_percent)',
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
  // SIGNIFICANCE, from the ledger: the decisions that booked an executed intent. One paged
  // query over the ledger's ids rather than an embed per row — the ledger is small, the
  // contexts are not.
  const significant = new Set<number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('executions')
      .select('decision_id')
      .eq('event_type', 'intent')
      .eq('validation_status', 'executed')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`replay: could not read the ledger's decision ids (${error.message}).`);
    const page = (data ?? []) as Array<{ decision_id: number | null }>;
    for (const row of page) if (row.decision_id != null) significant.add(row.decision_id);
    if (page.length < PAGE) break;
  }
  for (const cycle of cycles) cycle.significant = significant.has(cycle.id);
  return cycles;
}