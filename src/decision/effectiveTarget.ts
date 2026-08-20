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
 * ── THE FALLBACK ────────────────────────────────────────────────────────────────────
 *
 * `intent-fallback` means the row predates migration 0027. Falling back to the raw
 * proposal is exactly right for those rows: the stop had never fired on any of them (0
 * gate refusals and 0 applied/target divergences across the 1332 decided rows as of
 * 20/08), so proposal and intention are the same value there — which is what makes this
 * switch provably inert on the corpus. It is a NAMED outcome rather than a `??` for the
 * same reason as above: a caller can log it, count it, or refuse it.
 */
export type IntentSource =
  /** The normal case, from migration 0027 onwards. */
  | 'intent'
  /** A row written before 0027 — the raw proposal stands in. */
  | 'intent-fallback'
  /** Neither column carries an allocation. */
  | 'none';

export interface IntentAllocation {
  allocation: Record<string, number> | null;
  source: IntentSource;
  /** True when the persisted intention differs from the raw proposal — i.e. a stop fired. */
  differsFromProposal: boolean;
}

/** The single definition of "what the model last meant". */
export function resolveIntentAllocation(row: TargetColumns): IntentAllocation {
  const intent = usableAllocation(row.intent_allocation);
  const proposal = usableAllocation(row.target_allocation);

  if (intent != null) {
    return {
      allocation: intent,
      source: 'intent',
      differsFromProposal: proposal != null && !sameAllocation(intent, proposal),
    };
  }
  if (proposal != null) {
    return { allocation: proposal, source: 'intent-fallback', differsFromProposal: false };
  }
  return { allocation: null, source: 'none', differsFromProposal: false };
}
