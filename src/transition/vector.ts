import type { Decimal } from '../money.js';
import { judgeOrder, type OrderVerdict, type TransitionVerdict } from './gate.js';

/**
 * ATOMICITY — a portfolio target is refused whole, or not at all.
 *
 * `gate.ts` answers a question about ONE asset: may this leg trade, given what the
 * transition says about that asset. This file answers the question the gate cannot,
 * because it is not about an asset at all: what happens to the OTHER legs when one of
 * them is refused.
 *
 * The model does not emit a list of orders. It emits a single allocation vector, and the
 * legs are what the code derives from the distance between that vector and the book. Drop
 * one leg and keep the others and you have not executed a smaller version of the model's
 * decision — you have executed a decision nobody took. Suppressing the sell that funded a
 * buy leaves the buy funded from the reserve; suppressing the buy leaves the proceeds in
 * cash. Either way the resulting book is one neither the model nor the gate asked for, and
 * it is the gate that would have manufactured it.
 *
 * ── OBSERVE MODE ────────────────────────────────────────────────────────────────
 *
 * Nothing here suppresses anything. `judgeVector` is a pure function whose result is
 * journaled and discarded; every leg it calls cancelled has already executed by the time
 * it runs. It exists now, ahead of the switch, so that the day the gate starts blocking it
 * does so with a provenance column that has been filled and verified rather than one that
 * gets its first row the day it matters.
 *
 * ── THE CONTRACT, as arbitrated ─────────────────────────────────────────────────
 *
 *  1. DETERMINISTIC EXITS ARE EVALUATED FIRST AND ARE EXEMPT. `stop_exit` produces its
 *     full exit, and a confirmed `risk_off` produces its reductions, on any asset — frozen
 *     or with no usable individual regime at all. These are the code's own de-risking
 *     actions, not the model's strategy, and the one thing a transition must never be able
 *     to block is the book getting smaller. They are exempt from atomicity, and they do not
 *     trigger it.
 *  2. OUTSIDE THOSE, ONE REFUSED STRATEGIC LEG REFUSES THEM ALL. Not "the forbidden ones",
 *     not "the ones on frozen assets" — all of them, for the cycle.
 *  3. NO DRIFT REBALANCING IS GENERATED DURING THAT REFUSAL. The cycle keeps the last
 *     accepted applied vector. Nothing to compute in observe mode (nothing is suppressed,
 *     so nothing needs replacing), and it is stated here because it is the clause with a
 *     consequence outside this file: a blocking implementation has to keep the previous
 *     vector in `applied_allocation` too, or the gate would revert the book to a target it
 *     never pursued. Since PR #34 that column is no longer the coherence guard's rule-1
 *     reference — the guard reads `intent_allocation`, and a refusal deliberately leaves
 *     the model's intention where the model put it.
 *  4. AN ALL-ALLOWED VECTOR PASSES NORMALLY. Atomicity adds nothing when nothing is
 *     refused — it is not a second opinion on legs the gate already cleared.
 */

/** One leg of the cycle's vector: a movement on one asset, in one direction. */
export interface VectorLeg {
  asset: string;
  side: 'buy' | 'sell';
  /** Notional in quote. Carried for the journal only — the rule never reads it. */
  notional: Decimal;
}

/**
 * What the layer would have done with one leg.
 *
 * `cancelled_atomic` is the whole reason this file exists. Without it a leg refused
 * because its OWN asset is frozen and a leg refused because a DIFFERENT asset was frozen
 * collapse into the same "refused", and no amount of re-reading the journal afterwards can
 * pull them apart — the second one's asset looks perfectly tradable in its own row.
 */
export type LegVerdict = OrderVerdict | 'cancelled_atomic';

export interface JudgedLeg extends VectorLeg {
  /** After the vector pass — the operative verdict, the one the journal stores. */
  verdict: LegVerdict;
  reason: string;
  /** Before the vector pass: what the gate said about this leg's own asset, alone. */
  ownVerdict: OrderVerdict;
  /** A deterministic exit: exempt from atomicity, and unable to trigger it. */
  deterministic: boolean;
}

export interface VectorJudgement {
  legs: JudgedLeg[];
  /** The cycle's strategic legs are refused as a block. */
  refused: boolean;
  /** The leg whose own refusal caused it. Null when the vector is not refused. */
  trigger: { asset: string; side: 'buy' | 'sell' } | null;
  /** Every strategic leg forbidden on its own account, in the tie-break order. */
  triggers: { asset: string; side: 'buy' | 'sell' }[];
  reason: string;
}

/**
 * A deterministic exit — clause 1 of the contract.
 *
 * Both cases are the code de-risking, never the model adding: `stop_exit` is a mechanical
 * full exit computed from the peak and the live price, and a `risk_off_reduction` SELL is
 * the rung that guarantees an individual freeze cannot trap exposure while the market is
 * broadly breaking. A BUY on a `risk_off_reduction` asset is not one of these — it is an
 * increase, the gate forbids it on its own account, and it is strategic like any other.
 */
function isDeterministic(verdict: TransitionVerdict, side: 'buy' | 'sell'): boolean {
  if (verdict.gate === 'stop_exit') return true;
  return verdict.gate === 'risk_off_reduction' && side === 'sell';
}

/** Stable ordering, so "which leg triggered it" is a fact and not an artefact of iteration. */
function byAssetThenSide(
  a: { asset: string; side: string },
  b: { asset: string; side: string },
): number {
  return a.asset === b.asset ? a.side.localeCompare(b.side) : a.asset.localeCompare(b.asset);
}

/**
 * Judges a whole cycle's vector. PURE: same legs and same verdicts, same judgement.
 *
 * TOTAL BY DESIGN — it never throws. It is called from the observation closure inside
 * `decide()`, which runs after the orders are placed and whose entire safety property is
 * that it cannot fail a cycle. A leg on an asset the layer produced no verdict for is a
 * wiring fault, so it is recorded as one (`unjudged`, with a reason that names it) rather
 * than raised: an unjudged leg cannot trigger a refusal, so the fault can make the journal
 * incomplete but never make it invent an atomic refusal that did not happen.
 */
export function judgeVector(
  legs: VectorLeg[],
  verdicts: Map<string, TransitionVerdict>,
): VectorJudgement {
  const assessed = legs.map((leg) => {
    const verdict = verdicts.get(leg.asset);
    if (verdict == null) {
      return {
        ...leg,
        ownVerdict: 'unjudged' as OrderVerdict,
        reason:
          `the layer produced no verdict for ${leg.asset} — this leg is outside the observed ` +
          'universe and could not be judged (wiring fault, not a market reading)',
        deterministic: false,
      };
    }
    const own = judgeOrder(verdict, leg.side);
    return {
      ...leg,
      ownVerdict: own.verdict,
      reason: own.reason,
      deterministic: isDeterministic(verdict, leg.side),
    };
  });

  // THE TRIGGERS: strategic legs the gate refuses on their own account. Deterministic
  // exits are filtered out first — clause 1 — so a stop firing on one asset can never be
  // the thing that cancels the model's decision on the others.
  const triggers = assessed
    .filter((leg) => !leg.deterministic && leg.ownVerdict === 'forbidden')
    .sort(byAssetThenSide);
  const refused = triggers.length > 0;
  const trigger = triggers[0] ?? null;

  const judged: JudgedLeg[] = assessed.map((leg) => {
    // Clause 1: exempt, and it keeps the verdict it earned on its own asset —
    // `superseded` for a leg the stop overtakes, `allowed` for a reduction under a
    // confirmed override.
    if (leg.deterministic) return { ...leg, verdict: leg.ownVerdict };
    // Its own asset refuses it. The direct refusal is the more specific fact and it wins:
    // recording it as cancelled-by-atomicity would hide that this leg is one of the
    // reasons the vector went down.
    if (leg.ownVerdict === 'forbidden') return { ...leg, verdict: 'forbidden' };
    if (!refused) return { ...leg, verdict: leg.ownVerdict };
    // Everything else the refusal sweeps up — legs the gate had cleared, and legs it could
    // not judge. The row keeps `gate` alongside, so "cancelled while its own asset was
    // actionable" and "cancelled while its own asset had no regime" stay distinguishable
    // without a second provenance value.
    return {
      ...leg,
      verdict: 'cancelled_atomic',
      reason:
        `cancelled with the vector: the ${trigger!.asset} ${trigger!.side} leg of the same cycle ` +
        'is forbidden, and a portfolio target is refused whole or not at all',
    };
  });

  const strategic = judged.filter((leg) => !leg.deterministic);
  return {
    legs: judged,
    refused,
    trigger: trigger == null ? null : { asset: trigger.asset, side: trigger.side },
    triggers: triggers.map((t) => ({ asset: t.asset, side: t.side })),
    reason: refused
      ? `${triggers.length} of ${strategic.length} strategic leg(s) forbidden ` +
        `(${triggers.map((t) => `${t.asset} ${t.side}`).join(', ')}) — the whole strategic vector is ` +
        `refused; ${judged.length - strategic.length} deterministic exit(s) are exempt`
      : strategic.length === 0
        ? `no strategic leg this cycle (${judged.length} leg(s), all deterministic exits)`
        : `all ${strategic.length} strategic leg(s) cleared — the vector passes`,
  };
}
