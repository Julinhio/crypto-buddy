import { buildIntentAllocation } from './intentReference.js';

/**
 * WHICH COLUMN ANSWERS WHICH QUESTION — the three allocations of a decision row.
 *
 *   `target_allocation`   what the MODEL proposed, raw. Immutable audit trail, and never
 *                         read by an operational path.
 *   `intent_allocation`   the model's INTENTION as the guard must reread it (migration
 *                         0027). Equal to the proposal except that a deterministic peak
 *                         stop zeroes the line it emptied — see `resolveIntentAllocation`.
 *   `applied_allocation`  what the DETERMINISTIC chain retained — the risk clamp and the
 *                         transition gate. This is the effective target.
 *
 * Two resolvers, because the two questions are genuinely different: "what was this cycle
 * pursuing" is answered by the applied column, "what did the model last mean" by the
 * intent one. Collapsing them into one reader is the defect this PR removes.
 *
 * Today they are identical on all 1079 decided rows: the clamp has never fired, and no
 * decided row is missing `applied_allocation`. That is precisely why this resolver lands
 * NOW rather than with the PR that makes the transition gate block. On that day the two
 * columns diverge for the first time, and a refactor done then could not be told apart
 * from the gate's own effect. Done here, it is provably inert — every consumer reads the
 * same value it read before, byte for byte.
 *
 * ── Why a function and not a `??` ────────────────────────────────────────────────
 *
 * The fallback to the proposal exists for one case only: a row written before
 * `applied_allocation` existed. Spelling it `applied ?? target` at each call site makes
 * that exception invisible and, worse, uniform — every reader silently accepts a raw
 * proposal as if the chain had endorsed it. Here the fallback is a NAMED OUTCOME the
 * caller receives and can log, count or refuse.
 *
 * On the current corpus the fallback is unreachable: every `decided` row has an applied
 * allocation, and the three operational readers all filter on `status = 'decided'`, so a
 * `guard_failed` row — which `failCycle` writes with a target and no applied, because the
 * guard REFUSED that proposal — can never be resolved by any of them. The branch is a
 * contract, not a live path, and it should stay that way.
 */

/**
 * The shape every consumer has in hand, whether from a DB row or a rebuilt one.
 *
 * Both fields are `unknown` on purpose: they come from `jsonb` columns, so they are
 * unvalidated until someone looks. This resolver IS that someone — making it the single
 * validation boundary means no caller has to remember to check, and none of them can
 * check differently.
 */
export interface TargetColumns {
  target_allocation?: unknown;
  applied_allocation?: unknown;
  /**
   * Migration 0027 — the model INTENTION, as the guard must reread it. NULL on every row
   * written before that migration; the fallback to the raw proposal is a NAMED outcome,
   * see `resolveIntentAllocation`.
   */
  intent_allocation?: unknown;
  /**
   * Migration 0026 — set only when the TRANSITION GATE refused the cycle's vector, which is
   * the one cause that makes `applied_allocation` describe a different cycle entirely. Read
   * when `intent_allocation` is missing, to tell a peak stop apart from a refusal; see
   * `resolveIntentAllocation`. `clamped` is deliberately absent: it is portfolio-wide, and a
   * per-line question must not be answered with a portfolio-wide flag.
   */
  applied_divergence_cause?: unknown;
}

export type EffectiveTargetSource =
  /** The normal case: the chain's own retained target. */
  | 'applied'
  /** A legacy row with no applied allocation — the proposal stands in. */
  | 'proposal-fallback'
  /** Neither column carries an allocation: a skipped, errored or unparseable cycle. */
  | 'none';

export interface EffectiveTarget {
  /** The allocation to act on, or null when the row carries none. */
  allocation: Record<string, number> | null;
  /**
   * WHICH column answered. Returned rather than hidden so a caller can tell "the chain
   * retained this" from "we fell back to what the model asked for" — two facts that look
   * identical today and will not once the gate blocks.
   */
  source: EffectiveTargetSource;
  /** True when the chain's target differs from the raw proposal. Always false today. */
  differsFromProposal: boolean;
}

/** Structural equality on an allocation map, key order independent. */
function sameAllocation(
  a: Record<string, number> | null | undefined,
  b: Record<string, number> | null | undefined,
): boolean {
  if (a == null || b == null) return a == b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
}

/**
 * The single definition. Every operational reader goes through it, so production and the
 * replay cannot drift apart the day the two columns stop agreeing.
 */
export function resolveEffectiveTarget(row: TargetColumns): EffectiveTarget {
  const applied = usableAllocation(row.applied_allocation);
  const proposal = usableAllocation(row.target_allocation);

  if (applied != null) {
    return {
      allocation: applied,
      source: 'applied',
      differsFromProposal: proposal != null && !sameAllocation(applied, proposal),
    };
  }
  if (proposal != null) {
    return { allocation: proposal, source: 'proposal-fallback', differsFromProposal: false };
  }
  return { allocation: null, source: 'none', differsFromProposal: false };
}

/**
 * An allocation is usable only if it is an object of finite numbers.
 *
 * Refusing rather than coercing, and it matters most for the guard: a mangled reference
 * would not fail loudly, it would silently reject every subsequent hold. `{}` counts as
 * unusable too — an empty allocation is not a target, it is a missing one wearing an
 * object's clothes.
 */
function usableAllocation(value: unknown): Record<string, number> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return null;
  const numeric: Record<string, number> = {};
  for (const [asset, amount] of entries) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
    numeric[asset] = amount;
  }
  return numeric;
}

/**
 * THE INTENTION, and why it is not simply `target_allocation`.
 *
 * The coherence guard's rule 1 asks whether the model CHANGED ITS MIND, so its reference
 * has to be the model's last intention — not the bounded target the chain pursued, which
 * carries the caps of its own day and never gives back the weight a RELAXED policy would
 * now allow.
 *
 * The raw proposal is almost that value, and it is wrong in exactly one place: when the
 * peak stop empties a line, the proposal keeps the weight the model asked for on a
 * position that no longer exists. Rereading it would reject the honest zero the model
 * emits next cycle, and the rejection message — "re-emit the reference unchanged" — would
 * invite a re-entry the stop contract explicitly forbids. So the intention is PERSISTED,
 * with the stop already accounted for, rather than inferred from the other two columns.
 *
 * A clamp does not touch it, and a gate refusal ALONE does not touch it: the model's
 * intention did advance on a refused cycle, only the book did not. That asymmetry is the
 * entire reason rule 1 and rule 2 now read different operands.
 *
 * ── WHEN THE COLUMN IS NULL, AND WHY "PRE-0027" IS THE WRONG ANSWER ─────────────────
 *
 * A null `intent_allocation` was first read as "this row predates migration 0027", and
 * falling back to the raw proposal is exactly right for those rows: the stop had never
 * fired on any of them (0 gate refusals and 0 applied/target divergences across the 1332
 * decided rows as of 20/08), so proposal and intention are the same value there.
 *
 * But NULL DOES NOT MEAN "OLD". The migration is additive, so it lands before the binary
 * that writes the column — and it stays in place across a rollback. Any `decided` row
 * written by a binary without this code, at any point after the migration, is null here
 * too. If a peak stop fired on such a cycle, the old binary put the emptied line flat in
 * `applied_allocation` and left the raw proposal carrying its positive weight; a blind
 * fallback would then forget the stop, refuse the model's honest zero next cycle, and
 * invite the re-entry the stop contract forbids. Reading "null" as "historical" is the
 * one assumption this file cannot make, because the project's disaster-recovery posture
 * makes rolling back a supported move rather than an accident.
 *
 * So the fallback RECONSTRUCTS instead of substituting, from the columns such a row does
 * carry. A line was emptied BY THE CODE exactly when the applied target holds zero while
 * the proposal holds weight — and the three things that can put those two columns apart are
 * enumerated rather than guessed at:
 *
 *   the GATE    `applied_divergence_cause` is set. The applied target is then the PREVIOUS
 *               vector, so a zero there means "the book was not in this line", not "the code
 *               just emptied it" — and the model's intention to ENTER it must survive, which
 *               is the whole point of a refusal not touching the intention.
 *   the CLAMP   it cannot produce the zero this predicate looks for — but that is a bound
 *               someone maintains, not a law of arithmetic, and the earlier version of this
 *               comment got it wrong. Both passes have to be argued separately:
 *
 *                 · the PER-ASSET pass trims to the cap, and a cap is a positive weight
 *                   (a cap of exactly zero is the one exception — residual ambiguity 2);
 *                 · the CASH-FLOOR pass scales the coins by `(S − minCashPercent) / coinTotal`,
 *                   where S is the allocation's TOTAL. S is not 100 — it is 100 within the
 *                   tolerance the schema accepts, or within the corruption band for a stored
 *                   intention. So the scale collapses to zero as soon as the floor reaches S,
 *                   and every coin line is written flat. What keeps that unreachable is a
 *                   startup bound: `caps.minCashPercent < 100 − ALLOCATION_CORRUPTION_BAND_PERCENT`,
 *                   asserted in `validateExecutionConfig`. Remove that bound and this
 *                   predicate starts reading a cash-floor squeeze as a peak stop.
 *
 *               `clamped` is DELIBERATELY not consulted, because it would be the wrong
 *               instrument even so: the flag is portfolio-wide, so reading it would let a cap
 *               firing on BTC suppress the recovery of a stop on ETH.
 *   the STOP    no divergence cause, applied at zero, proposal above it. That is a peak-stop
 *               exit, and it is the case being recovered.
 *
 * TWO RESIDUAL AMBIGUITIES, stated rather than hidden. Both are confined to the same narrow
 * window — a row written by a binary without this code, after the migration — and in both
 * the direction of the error was chosen, not stumbled into.
 *
 *   1. A STOP ON A CYCLE THE GATE ALSO REFUSED. The divergence cause is set, the
 *      reconstruction stands aside, and the raw weight survives. Costs one rejected cycle
 *      and one retry, self-healing on the next accepted decision.
 *   2. A PER-ASSET CAP SET TO EXACTLY ZERO — permitted by the config validator (`[0, 100]`),
 *      though no shipped cap is anywhere near it. That clamps a positive ask to zero and is
 *      indistinguishable, on the row alone, from a stop; the caps in force when the row was
 *      written are not recorded anywhere, and consulting TODAY's would be this PR's own
 *      defect all over again. So it reads as a stop, and that is the SAFE direction:
 *      mistaking a retired asset for a stopped one forgets an intention and costs one retry,
 *      while mistaking a stopped one for a retired asset invites a re-entry the stop contract
 *      forbids. A retry against a broken stop is not a close call.
 *
 * Neither can happen once the writing binary carries this code, which is the point of
 * persisting the intention rather than inferring it.
 *
 * Every branch is a NAMED outcome rather than a `??`, for the same reason as the effective
 * target: a caller can log it, count it, or refuse it.
 */
export type IntentSource =
  /** The normal case, from migration 0027 onwards. */
  | 'intent'
  /** No intention column, and nothing in the other two suggests the code emptied a line. */
  | 'intent-fallback'
  /** No intention column, but the applied target shows a peak stop the writer did not record. */
  | 'intent-reconstructed'
  /** Neither column carries an allocation. */
  | 'none';

export interface IntentAllocation {
  allocation: Record<string, number> | null;
  source: IntentSource;
  /** True when the intention differs from the raw proposal — i.e. a stop fired. */
  differsFromProposal: boolean;
  /** The lines a reconstruction put flat. Empty unless `source` is `intent-reconstructed`. */
  stoppedAssets: string[];
}

/**
 * The single definition of "what the model last meant".
 *
 * `reserveAsset` is required rather than defaulted: a reconstruction has to move the
 * emptied line's weight somewhere, and guessing the reserve is how an allocation quietly
 * stops summing to 100.
 */
export function resolveIntentAllocation(
  row: TargetColumns,
  reserveAsset: string,
): IntentAllocation {
  const intent = usableAllocation(row.intent_allocation);
  const proposal = usableAllocation(row.target_allocation);

  if (intent != null) {
    return {
      allocation: intent,
      source: 'intent',
      differsFromProposal: proposal != null && !sameAllocation(intent, proposal),
      stoppedAssets: [],
    };
  }
  if (proposal == null) {
    return { allocation: null, source: 'none', differsFromProposal: false, stoppedAssets: [] };
  }

  const stopped = codeEmptiedLines(row, proposal);
  if (stopped.length === 0) {
    return {
      allocation: proposal,
      source: 'intent-fallback',
      differsFromProposal: false,
      stoppedAssets: [],
    };
  }
  // Rebuilt with the SAME function the writer would have used, so a reconstructed row and
  // a written one cannot disagree about what a stop does to an intention.
  return {
    allocation: buildIntentAllocation({
      proposal,
      stoppedAssets: new Set(stopped),
      reserveAsset,
    }),
    source: 'intent-reconstructed',
    differsFromProposal: true,
    stoppedAssets: stopped,
  };
}

/**
 * The lines the CODE emptied on a row that did not record its intention — see the
 * enumeration above. Returns nothing whenever the row cannot answer the question, which is
 * every row on the historical corpus.
 */
function codeEmptiedLines(row: TargetColumns, proposal: Record<string, number>): string[] {
  // A gate refusal makes `applied_allocation` the PREVIOUS vector, so it says nothing about
  // what THIS cycle emptied — the proposal stands as the intention, which is the contract.
  //
  // The clamp needs no exclusion, and `clamped` would be the wrong instrument for one anyway:
  // the flag is portfolio-wide, so a cap firing on BTC would suppress the recovery of a stop
  // on ETH.
  //
  // NOT because "the clamp cannot produce a zero" — it can, and an earlier version of this
  // comment claimed otherwise. The cash-floor pass writes every coin flat once the floor
  // reaches the allocation's total, which is 100 only within a tolerance. What makes it
  // unreachable is the startup bound on `caps.minCashPercent` — see the enumeration above,
  // and `validateExecutionConfig`. This predicate is only sound while that bound holds.
  if (row.applied_divergence_cause != null) return [];
  const applied = usableAllocation(row.applied_allocation);
  if (applied == null) return [];
  return Object.keys(proposal).filter((asset) => proposal[asset]! > 0 && applied[asset] === 0);
}