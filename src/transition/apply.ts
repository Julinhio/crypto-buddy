import type { Movement } from '../execution/movements.js';
import type { VectorJudgement } from './vector.js';

/**
 * WHAT THE GATE DOES WITH WHAT IT COMPUTED — the one file where observe and enforce differ.
 *
 * `gate.ts` decides per asset. `vector.ts` decides per cycle. Neither of them acts: both
 * are pure verdicts, and they are byte-identical in both modes. THIS file is the whole
 * behavioural delta of the switch, deliberately isolated into a pure function so that
 * "what changes when we arm the gate" is one reviewable page rather than a diff scattered
 * across `decide()`.
 *
 * Keeping it pure also means the 11/08 replay drives the SAME code the live cycle does. A
 * counterfactual computed by a re-implementation would only prove that the
 * re-implementation agrees with itself.
 *
 * ── THE RULE, as arbitrated ─────────────────────────────────────────────────────────
 *
 * In `observe`: everything passes. The movement list comes out exactly as it went in, and
 * the applied target is the clamped one — today's behaviour, unchanged.
 *
 * In `enforce`, on a REFUSED vector:
 *
 *   1. deterministic exits still execute. `stop_exit` produces its full exit and a
 *      confirmed `risk_off` produces its reductions — on any asset, frozen or unreadable.
 *      The one thing a transition must never block is the book getting SMALLER;
 *   2. every strategic leg is dropped. Not the forbidden ones — all of them. A vector is a
 *      portfolio target, and executing a subset of it produces a book nobody decided on;
 *   3. the applied target REVERTS TO THE PREVIOUS ONE. Not the refused proposal.
 *   4. and NO drift rebalancing is generated toward it.
 *
 * Points 3 and 4 are the subtle pair, and they are why this returns an allocation rather
 * than just a movement list.
 *
 * On 3: `applied_allocation` is what the coherence guard reads back as its reference. Store
 * the refused proposal there and the next cycle is compared against a target the book never
 * pursued — the guard would then reject an honest hold for "moving" a target that only ever
 * existed as a refusal. Store the previous vector and the reference stays exactly where the
 * book actually is. The row stays `decided`: the INTENTION advanced (`target_allocation`
 * records what the model asked for), the APPLIED did not. That is precisely why the two
 * columns exist.
 *
 * On 4: reverting the target must not become a reason to trade. Prices move between
 * cycles, so re-applying yesterday's percentages would generate fresh movements to
 * re-hit them — the gate would block the model's decision and then place its own orders
 * to correct drift. That is why nothing is recomputed from `previousApplied`: the
 * strategic legs are DROPPED, never replaced.
 */

export interface GateOutcome {
  /** The movements that may actually execute. */
  movements: Movement[];
  /**
   * Model legs OVERTAKEN by a code-generated stop exit — not refused, superseded.
   *
   * Kept apart from `droppedLegs` because they are a different fact and must not pollute
   * the refused-intention ledger: the model's order on that line was not blocked by a
   * transition, it was made moot by the code exiting the whole line.
   */
  supersededLegs: Movement[];
  /**
   * The allocation to store in `applied_allocation` — the effective target this cycle
   * pursued. The clamped proposal normally; the PREVIOUS applied vector on a refusal.
   */
  appliedAllocation: Record<string, number>;
  /** Did the gate suppress this cycle's strategic vector? */
  refused: boolean;
  /**
   * Strategic legs dropped by the refusal (both directly forbidden and swept up by
   * atomicity). Empty unless `refused`. Journalled, and fed to the refused-intention
   * instrumentation — never re-derived by a caller.
   */
  droppedLegs: Movement[];
  /** Human-readable, for the cycle log and the decision row. Empty when nothing changed. */
  reason: string;
}

/**
 * Applies the vector judgement to the cycle's movements.
 *
 * PURE and TOTAL: same inputs, same output, never throws. `previousApplied` is the last
 * accepted applied vector (the coherence guard's reference); when it is null — a bot with
 * no decided history yet — the clamped proposal stands in, because reverting to "nothing"
 * would mean storing a null target and losing the reference entirely.
 */
export function applyGate(params: {
  mode: 'observe' | 'enforce';
  movements: Movement[];
  judgement: VectorJudgement;
  /**
   * The peak stop's FULL EXITS, synthesized by the caller from the held quantity and the
   * live price — one per asset whose gate is `stop_exit`.
   *
   * They are an INPUT rather than something this function derives, and that is the fix for
   * the defect the review found. `applyGate` can only ever filter the list it is given, so
   * a stop firing on a line the model did not happen to mention produced no exit at all:
   * the ladder promised a full exit and delivered nothing, precisely on the line most in
   * need of one. The stop is the CODE's action; it cannot depend on the model having
   * proposed something to reclassify.
   */
  stopExits: Movement[];
  /** The clamped proposal — what would be applied if nothing were refused. */
  clampedAllocation: Record<string, number>;
  /** The last accepted applied vector, or null when there is no decided history. */
  previousApplied: Record<string, number> | null;
}): GateOutcome {
  const { mode, movements, judgement, stopExits, clampedAllocation, previousApplied } = params;

  // OBSERVE — the layer blocks nothing AND creates nothing. Returned before anything is
  // inspected so the no-op is structural rather than a conclusion the code reaches. In
  // particular the synthesized stop exits are NOT added: the stop has never fired an order
  // in observe mode, and adding one here would make the "switch changes nothing" claim
  // false in the most expensive possible way.
  if (mode === 'observe') {
    return {
      movements,
      supersededLegs: [],
      appliedAllocation: clampedAllocation,
      refused: false,
      droppedLegs: [],
      reason: '',
    };
  }

  // Assets the code is exiting in full. Any model leg on them — buy OR sell — is moot:
  // the whole line is going. Dropping the model's own leg also closes the second half of
  // the reviewed defect, where a BUY on a `stop_exit` asset counted as "deterministic"
  // (isDeterministic is side-blind for that gate) and would have executed while the line
  // was supposed to be liquidating.
  const stopAssets = new Set(stopExits.map((m) => m.asset));
  const superseded = movements.filter((m) => stopAssets.has(m.asset));
  const remaining = movements.filter((m) => !stopAssets.has(m.asset));

  /**
   * UNJUDGED STRATEGIC LEGS FAIL CLOSED — but only under `enforce`, and only here.
   *
   * A leg on an asset with no usable 4h bar gets gate `no_regime` and verdict `unjudged`.
   * `judgeVector` deliberately refuses to let those trigger an atomic refusal, and that is
   * RIGHT for the journal: in observe mode it must never invent a refusal that did not
   * happen. But carried into enforcement it fails OPEN — the strategic leg would execute
   * precisely when the layer has no regime to validate it against, while the payload has
   * already told the model that asset is `actionable: false`. The code would then be
   * trading a line it just instructed the model to leave alone.
   *
   * So the correction lives HERE rather than in `judgeVector`: changing the judgement
   * itself would rewrite what observe mode journals, and the switch would stop being a
   * no-op. Deterministic exits are exempt, as always — a `no_regime` asset under a
   * confirmed risk_off still reduces (rung 2 lifts the silence as well as the freeze).
   */
  const unjudgedStrategic = judgement.legs.filter(
    (leg) => !leg.deterministic && leg.ownVerdict === 'unjudged',
  );
  const refused = judgement.refused || unjudgedStrategic.length > 0;

  if (!refused) {
    return {
      movements: [...stopExits, ...remaining],
      supersededLegs: superseded,
      appliedAllocation: clampedAllocation,
      refused: false,
      droppedLegs: [],
      reason:
        stopExits.length > 0
          ? `${stopExits.length} peak-stop exit(s) generated by the code; the model's vector passes otherwise`
          : '',
    };
  }

  // Refused: of the remaining model legs only the deterministic ones survive — which now
  // means the `risk_off_reduction` SELLS, the reductions a transition must never trap.
  const deterministic = new Set(
    judgement.legs.filter((leg) => leg.deterministic).map((leg) => `${leg.asset}:${leg.side}`),
  );
  const kept: Movement[] = [];
  const dropped: Movement[] = [];
  for (const movement of remaining) {
    if (deterministic.has(`${movement.asset}:${movement.side}`)) kept.push(movement);
    else dropped.push(movement);
  }

  return {
    movements: [...stopExits, ...kept],
    supersededLegs: superseded,
    // Clause 3. The fallback matters only on a bot with no decided history; storing the
    // clamped proposal there is strictly better than storing nothing, and it cannot mask a
    // refusal because `refused` is reported separately.
    appliedAllocation: previousApplied ?? clampedAllocation,
    refused: true,
    droppedLegs: dropped,
    reason:
      `${judgement.reason}${
        unjudgedStrategic.length > 0 && !judgement.refused
          ? ` — but ${unjudgedStrategic.length} strategic leg(s) sit on assets with NO regime ` +
            `(${unjudgedStrategic.map((l) => l.asset).join(', ')}); enforcement fails closed on those`
          : ''
      } — ${dropped.length} strategic leg(s) dropped, ${kept.length} ` +
      `risk_off reduction(s) kept, ${stopExits.length} peak-stop exit(s) generated; ` +
      `applied_allocation holds the previous vector and no drift rebalancing is generated toward it`,
  };
}
