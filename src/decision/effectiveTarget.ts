/**
 * THE EFFECTIVE TARGET — one answer to "what allocation was this cycle actually pursuing".
 *
 * Two columns coexist on `decisions` and they mean different things:
 *
 *   `target_allocation`   what the MODEL proposed, raw. Kept for the audit trail, and
 *                         never read by an operational path.
 *   `applied_allocation`  what the DETERMINISTIC chain retained — the risk clamp today,
 *                         the transition gate tomorrow. This is the effective target.
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
