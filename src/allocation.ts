/**
 * ALLOCATION ARITHMETIC — the one geste three callers share.
 *
 * An allocation is a percentage map that must keep summing to the same total. Three
 * places in the codebase need to take a line's weight OUT of that map and put it into the
 * reserve, and each of them arrived at the same four lines of arithmetic independently:
 *
 *   - `zeroOutStopped`             a peak stop emptied the line, so its weight is cash now;
 *   - `referenceInCurrentUniverse` the asset's feed dropped, so its key cannot be carried;
 *   - `buildIntentAllocation`      the same stop, applied to the model's intention.
 *
 * Factored at the THIRD consumer rather than the second, which is one later than the
 * project's own rule — the two existing copies had already drifted in a way that only
 * shows up here: one returns the input object untouched on a no-op and the other returns a
 * copy, one skips a non-finite weight and the other cannot meet one. Reconciling them
 * meant deciding which behaviours were load-bearing, which is exactly the audit the
 * factoring exists to force.
 *
 * WHAT LIVES HERE IS ONLY THE ARITHMETIC: read the weights, add them to the reserve, keep
 * the sum. What does NOT live here is the DISPOSITION of the released key — whether it is
 * zeroed (the stop: the line still exists, it is simply empty) or removed (the universe:
 * the key is no longer legal). That decision is the meaning of each caller and belongs in
 * each caller. A shared helper with a `zero | drop` flag would have been the same code
 * with the distinction hidden inside a boolean, which is a false abstraction, not a
 * factoring.
 */

export interface ReleaseResult {
  /**
   * The allocation with every released key REMOVED and their combined weight added to the
   * reserve. A caller that wants the key kept at zero writes it back itself.
   */
  allocation: Record<string, number>;
  /** The total weight taken out of the released keys. */
  freed: number;
  /** The released keys that actually carried a usable, non-zero weight. */
  released: string[];
}

/**
 * Moves the weight of `candidates` into the reserve, preserving the sum.
 *
 * A candidate is only released if it carries a FINITE, NON-ZERO weight. Absent keys, zero
 * keys and mangled ones are left exactly as they are: there is no weight to move, and
 * inventing a `0` entry for an absent key would silently widen the allocation. This is
 * `zeroOutStopped`'s original guard, kept because it is the correct one — the stop set is
 * built from the code's own exits and can legitimately name a line the allocation never
 * mentioned.
 *
 * Pure and total. `candidates` may name the reserve itself, which is a no-op by
 * construction: the weight would be removed and immediately added back, so it is skipped
 * outright rather than left to cancel out through two roundings.
 */
export function releaseToReserve(
  allocation: Record<string, number>,
  candidates: Iterable<string>,
  reserveAsset: string,
): ReleaseResult {
  const next = { ...allocation };
  const released: string[] = [];
  let freed = 0;

  for (const asset of candidates) {
    if (asset === reserveAsset) continue;
    const weight = next[asset];
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight === 0) continue;
    freed += weight;
    released.push(asset);
    delete next[asset];
  }

  if (freed !== 0) next[reserveAsset] = (next[reserveAsset] ?? 0) + freed;
  return { allocation: next, freed, released };
}

/** The total of an allocation. Its own function so the sum check and the tests agree. */
export function allocationSum(allocation: Record<string, number>): number {
  return Object.values(allocation).reduce((total, value) => total + value, 0);
}
