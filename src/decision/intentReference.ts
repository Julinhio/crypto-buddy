import type { AppConfig } from '../config/index.js';
import { clampAllocation } from '../risk/clamp.js';
import { allocationSum, releaseToReserve } from '../allocation.js';
import { zeroOutStopped } from '../transition/apply.js';

/**
 * THE UNIVERSE RESTATEMENT PIPELINE — the single entry point for "what did the model last
 * intend, expressed in the frame of this cycle".
 *
 * The coherence guard asks two questions, and they had been reading one operand:
 *
 *   rule 1  did the model CHANGE ITS MIND?    an INTENTION question
 *   rule 2  can that change REACH THE BOOK?   an EXECUTABILITY question
 *
 * This module produces rule 1's operand, and it produces rule 2's basis from the same
 * value, in one place, in one order. Two callers normalising separately is precisely how
 * the operands drift apart again — the failure this PR exists to remove.
 *
 * ── THE ORDER, AND WHY EACH STEP SITS WHERE IT DOES ─────────────────────────────────
 *
 *   1. RESTATE INTO THE CURRENT UNIVERSE. This cycle's allocatable universe comes from
 *      the pairs that actually returned data, so an asset can vanish between two
 *      wake-ups. Its key is then illegal in the candidate, and comparing over the union
 *      would read the absence as the model changing its mind.
 *
 *   2. TRANSFER THE ORPHANED WEIGHT TO THE RESERVE. The schema still requires the
 *      remaining allocations to sum to 100, so a line that was at 8% leaves 8 points the
 *      model MUST reassign. The neutral place is cash. Compared naively, the reserve then
 *      looks like it moved by 8 points, rule 1 rejects a genuine hold, and the retry
 *      cannot fix it either — re-emitting the old target is impossible, its key is now
 *      forbidden. Every cycle would die for as long as the feed stayed down.
 *
 *      The orphaned key is DROPPED, not merely credited. Keeping it while also adding its
 *      weight to cash leaves an allocation summing past 100, and the ghost would then take
 *      its own cap surplus in step 4 and inflate the `coinTotal` the cash-floor pass scales
 *      by — giving the reference a different scaling from the candidate.
 *
 *      What this deliberately does NOT absolve: a model that reassigns that weight into
 *      another COIN has made a real allocation choice. The coin still reads as moved, and
 *      a `hold` claiming otherwise is still rejected.
 *
 *   3. VERIFY THE SUM, before anything is built on it. Two different checks, because they
 *      catch two different bugs — see `SUM CHECKS` below.
 *
 *   4. AND ONLY THEN CLAMP — into `bounded`, which is rule 2's basis and NOT rule 1's.
 *      This is the whole point of the split. The clamp is lossy in a direction nobody
 *      noticed until it mattered: a stored allocation bounded by the caps of its day does
 *      not recover the weight a RELAXED policy would now allow. Raise BTC's ceiling from
 *      35 to 40 and a reference bounded at 35 is compared to a candidate the clamp now
 *      lets through at 40 — the model's unchanged 40% ask reads as a moved target, the
 *      first attempt is rejected, and the retry pays for it EVERY cycle for as long as the
 *      model keeps asking. (The symmetric case, a TIGHTENED policy, was closed by PR #28
 *      by clamping the reference; leaving rule 1 unclamped closes both at once, because
 *      raw-against-raw is invariant to the policy by construction.)
 *
 * ── SUM CHECKS ──────────────────────────────────────────────────────────────────────
 *
 * CONSERVATION is an assertion about THIS code: moving a weight from a key to the reserve
 * cannot change the total, so any drift beyond float noise means the pipeline itself is
 * wrong. Checked at 1e-6.
 *
 * CALIBRATION is an assertion about THE STORED DATA: the intention was emitted under a
 * schema that validates the sum to 100 within `allocationTolerancePercent`, so a stored
 * value outside that band was never a legal allocation. Checked at the SAME tolerance the
 * emission was checked at, deliberately — 1e-6 here would reject the legitimate 99.7% the
 * schema accepts, and would do it silently, by rejecting every subsequent hold.
 *
 * A failure of either is reported, never coerced. A mangled reference does not fail loudly
 * on its own: it quietly rejects every hold from then on, which is the single worst
 * failure this guard can have.
 */

export interface RestatedIntent {
  /**
   * RULE 1's OPERAND. The intention in this cycle's universe, NEVER clamped — the whole
   * reason this type has two fields.
   */
  intent: Record<string, number>;
  /**
   * RULE 2's BASIS. The same intention bounded by TODAY's policy, ready to be turned into
   * a counterfactual movement plan. Bounded because executability is a question about what
   * the chain would actually pursue, and the chain clamps.
   */
  bounded: Record<string, number>;
  /** Keys the current universe no longer offers. Their weight went to the reserve. */
  droppedAssets: string[];
  /** The restated total, before the clamp. Reported so a caller can log it. */
  sum: number;
}

export type IntentRestatement =
  | { ok: true; value: RestatedIntent }
  | { ok: false; reason: string };

/** Float noise only — this bound asserts our own arithmetic, not the model's. */
const CONSERVATION_EPSILON = 1e-6;

export function restateIntentReference(params: {
  /** The stored intention of the last `decided` cycle, exactly as persisted. */
  reference: Record<string, number>;
  /** This cycle's allocatable keys — the reserve included. */
  universe: readonly string[];
  reserveAsset: string;
  /** The policy IN FORCE THIS CYCLE. Used for step 4 only; step 1-3 are policy-free. */
  policy: AppConfig;
}): IntentRestatement {
  const { reference, universe, reserveAsset, policy } = params;

  const legal = new Set(universe);
  const orphaned = Object.keys(reference).filter((asset) => !legal.has(asset));
  const before = allocationSum(reference);

  // Steps 1 and 2, as one arithmetic move: the shared primitive removes the key and adds
  // its weight to the reserve. A zero-weight orphan carries nothing to transfer, so the
  // primitive leaves it alone and it is removed here — an illegal key must not survive
  // into an operand, whatever its weight.
  const released = releaseToReserve(reference, orphaned, reserveAsset);
  const intent = { ...released.allocation };
  for (const asset of orphaned) delete intent[asset];

  // Step 3.
  const sum = allocationSum(intent);
  if (Math.abs(sum - before) > CONSERVATION_EPSILON) {
    return {
      ok: false,
      reason:
        `restating the intention did not conserve its total: ${before.toFixed(6)} → ${sum.toFixed(6)} ` +
        `(dropped ${orphaned.length ? orphaned.join(', ') : 'nothing'}). This is a bug in the ` +
        'restatement, not bad data.',
    };
  }
  const tolerance = policy.decision.allocationTolerancePercent;
  if (Math.abs(sum - 100) > tolerance) {
    return {
      ok: false,
      reason:
        `the stored intention sums to ${sum.toFixed(2)}, outside the ±${tolerance} the schema ` +
        'accepts — it was never a legal allocation, and comparing against it would reject every ' +
        'subsequent hold in silence.',
    };
  }

  // Step 4 — and only now.
  const bounded = clampAllocation(intent, reserveAsset, policy).applied;

  return { ok: true, value: { intent, bounded, droppedAssets: orphaned, sum } };
}

/**
 * THE INTENTION AS IT MUST BE PERSISTED — `intent_allocation`, migration 0027.
 *
 * The model's raw proposal, with ONE correction: a line the peak stop has just emptied is
 * put flat and its weight transferred to the reserve. Everything else the code does to a
 * proposal is deliberately NOT applied here:
 *
 *   the CLAMP does not touch it. A bounded intention is precisely what made rule 1 lossy
 *   under a relaxed policy;
 *   a GATE REFUSAL does not touch it either. The model's intention genuinely advanced on a
 *   refused cycle — only the book did not. Withdrawing that standing intention next cycle
 *   is a real decision, and rule 2's counterfactual is what lets it through.
 *
 * The stop is the exception because it is the one case where the code makes the model's
 * number describe a position that no longer exists. Left alone, the guard would refuse the
 * honest zero the model emits next cycle, and its rejection message ("re-emit the reference
 * unchanged") would be inviting a re-entry the stop contract explicitly forbids.
 *
 * NOTE WHAT THIS SIGNATURE CANNOT SEE: there is no `refused` parameter, and that is the
 * contract rather than an omission. A stop fires on a refused cycle exactly as it does on
 * an accepted one, so the intention must be flat on that line either way; a function that
 * could not be told about the refusal cannot accidentally start depending on it.
 */
export function buildIntentAllocation(params: {
  /** The model's raw emission, exactly as validated. */
  proposal: Record<string, number>;
  /** The assets the peak stop is taking to zero this cycle. Empty in `observe`. */
  stoppedAssets: Set<string>;
  reserveAsset: string;
}): Record<string, number> {
  return zeroOutStopped(params.proposal, params.stoppedAssets, params.reserveAsset);
}
