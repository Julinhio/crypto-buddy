import type { AssetRegime } from '../market/regime.js';
import type { StickyPoint } from '../market/transition.js';
import { Decimal } from '../money.js';

/**
 * THE TRANSITION LAYER — what the bot WOULD do, computed every cycle, blocking nothing.
 *
 * OBSERVE MODE, and it is the whole point of this brick. The layer runs, decides, and
 * journals its verdict; the model's allocation is applied exactly as it was before, even
 * on the cycles this file says it would have refused. Nothing here creates an order and
 * nothing here prevents one. The switch to blocking is a separate PR, taken on the
 * evidence this one produces.
 *
 * Why it exists, in one paragraph. The bot sells into rallies: over the first week of
 * August its cash went from 47% to 77% while BTC, ETH and BNB rose. The cause is
 * measured, not suspected — the regime shown to the model is smoothed over three
 * confirmation bars while `pullbackConsumed` / `bounceConsumed` are computed on the
 * current bar, so during a transition the model reads a label describing the past next to
 * flags describing the present, and the v5 playbook tells it to treat that pair as an
 * instruction. 12 of the 24 orders of that week were placed in exactly that state, 10 of
 * them sells. See `docs/RAPPORT-CONTRAT-TRANSITION.md`.
 *
 * ── This file is PURE ────────────────────────────────────────────────────────────
 *
 * No I/O, no clock, no config lookup: every input is passed in. That is what lets the
 * live cycle and the replay harness run the SAME function over the SAME inputs and be
 * compared bar for bar — the acceptance criterion of this PR. A gate that read its own
 * threshold from a module import would already be two functions.
 */

/** Quantities at or below this count as flat (mirrors derive.ts / lifecycle.ts). */
const DUST = new Decimal('1e-12');

/**
 * The priority ladder, highest first. Exactly the order the brief fixes, and the order
 * the journal reports:
 *
 *  1. `stop_exit`          — the peak stop fired: full exit of the line.
 *  2. `risk_off_reduction` — a CONFIRMED global risk_off lifts the individual freeze, but
 *                            for REDUCTIONS only. De-risking the book is the one thing a
 *                            transition must never be able to block: the freeze exists to
 *                            stop the model acting on a stale label, not to trap exposure
 *                            in a market that is broadly breaking.
 *  3. `frozen`             — individual transition: no strategic order.
 *  4. `actionable`         — normal playbook, the model decides.
 *
 * `no_regime` is the honest fifth outcome, NOT a rung: no 4h bar had closed for this
 * asset, so the layer has nothing to judge on and says so instead of defaulting to either
 * permissive or restrictive.
 *
 * It used to be evaluated first, which made it a rung in everything but name — and the
 * worst-placed one, above `risk_off_reduction`. A line the layer could not judge was
 * therefore untouchable even under a confirmed global risk_off, which inverts the one
 * guarantee the ladder is built around: reducing must always stay possible. Absence of
 * individual information is not a reason to hold. It is now evaluated after the
 * deterministic exits, so a confirmed override reduces a line whether the asset is frozen
 * or simply unreadable.
 */
export type TransitionGate =
  | 'stop_exit'
  | 'risk_off_reduction'
  | 'frozen'
  | 'actionable'
  | 'no_regime';

/** What the layer would have done with an order the model actually produced. */
export type OrderVerdict =
  | 'allowed'
  /** The rung would have refused it. */
  | 'forbidden'
  /** The stop was exiting the whole line anyway — the model's order is moot, not refused. */
  | 'superseded'
  /** No regime to judge on. Counted apart from both, never folded into either. */
  | 'unjudged';

export interface TransitionInputs {
  asset: string;
  /** The sticky state at the bar this cycle read, or null when none had closed. */
  sticky: StickyPoint | null;
  /** The global risk_off posture AFTER hysteresis — the confirmed one, never the raw. */
  riskOffConfirmed: boolean;
  /** Quantity held. A flat line has nothing to stop out of. */
  qty: Decimal;
  /** Live unit price, or null when the cycle had none. */
  price: Decimal | null;
  /** True when the book had to value this line off its cost basis. */
  priceStale: boolean;
  /** `position_state.peak_price_since_entry` — a UNIT PRICE, never a valuation. */
  peakPriceSinceEntry: Decimal | null;
  /** Percent below the peak at which the stop fires. Configuration, never the model's. */
  stopThresholdPercent: number;
}

export interface TransitionVerdict {
  asset: string;
  /** The 4h bar the verdict was computed on. Null when none had closed. */
  barAtMs: number | null;
  actionable: boolean;
  confirmedRegime: AssetRegime | null;
  rawRegime: AssetRegime | null;
  /** Consecutive OBSERVED bars of the same raw label — the counter the gate reads. */
  runLength: number;
  /** The same count ignoring grid holes — mirrors production's Hysteresis. */
  labelRun: number;
  riskOff: boolean;

  /** The stop was in a position to fire: mid-transition, on a line that is actually held. */
  stopArmed: boolean;
  stopWouldFire: boolean;
  /** Why an armed stop did NOT evaluate. Null when it did, or when it was never armed. */
  stopAbstainedReason: string | null;
  drawdownFromPeakPercent: number | null;
  peakPrice: Decimal | null;
  price: Decimal | null;
  stopThresholdPercent: number;

  gate: TransitionGate;
  gateReason: string;
}

/**
 * THE PEAK STOP, exactly as the brief fixes it and with no latitude anywhere:
 *
 *  - armed ONLY during a transition. Outside one the model owns the line, and a
 *    mechanical stop would be a second brain competing with the first;
 *  - reads ONLY the live price and `peak_price_since_entry`, both owned by the code —
 *    nothing the model produced is an input, so no prompt change can move it;
 *  - the threshold is CONFIGURATION (`config.transition.peakStopPercent`);
 *  - firing means a FULL, SINGLE exit — never a partial reduction repeated each cycle,
 *    which would liquidate the line in slices;
 *  - no automatic re-entry. Once the transition confirms, the model decides;
 *  - price or peak missing or stale → NO ORDER, and never a substitute value. This is the
 *    branch that must refuse to be helpful: a stop that invents its own input fires on
 *    nothing.
 *
 * A STALE PRICE IS NOT A PRICE. `derivePortfolio` falls back to the cost basis to keep
 * valuing a line whose feed is missing; using that fallback here would compute a
 * peak-versus-cost-basis number and call it a drawdown, at exactly the moment the stop
 * might act on it.
 *
 * ── Reading `stopWouldFire` in observe mode ──────────────────────────────────────
 *
 * Nothing exits, so the peak is never reset and the line stays below its threshold: the
 * flag can therefore be true on many CONSECUTIVE cycles for what would be a SINGLE exit
 * in blocking mode. Count episodes (maximal runs of consecutive true), never rows, or the
 * observation will read as hundreds of exits where the contract produces one.
 */
function evaluateStop(input: TransitionInputs): {
  armed: boolean;
  wouldFire: boolean;
  abstainedReason: string | null;
  drawdownPercent: number | null;
} {
  const frozen = input.sticky?.frozen === true;
  const held = input.qty.gt(DUST);
  const armed = frozen && held;

  if (!armed) {
    return { armed: false, wouldFire: false, abstainedReason: null, drawdownPercent: null };
  }
  if (input.priceStale) {
    return { armed, wouldFire: false, abstainedReason: 'price is stale — no order on a cost-basis valuation', drawdownPercent: null };
  }
  if (input.price == null || input.price.lte(0)) {
    return { armed, wouldFire: false, abstainedReason: 'no live price', drawdownPercent: null };
  }
  if (input.peakPriceSinceEntry == null || input.peakPriceSinceEntry.lte(0)) {
    return { armed, wouldFire: false, abstainedReason: 'no peak on record for this line', drawdownPercent: null };
  }

  // The peak the lifecycle is ABOUT to write: the stored high-water mark, ratcheted by
  // this cycle's own price. Same expression as `toDecisionContext`, for the same reason —
  // the ratchet runs at the END of the cycle, so comparing against the stored value alone
  // would report a POSITIVE drawdown on any cycle that made a new high.
  const peak = Decimal.max(input.peakPriceSinceEntry, input.price);
  const drawdownPercent = input.price.minus(peak).div(peak).times(100).toNumber();

  return {
    armed,
    wouldFire: drawdownPercent <= -input.stopThresholdPercent,
    abstainedReason: null,
    drawdownPercent,
  };
}

/** The layer's verdict for ONE asset on ONE cycle. Pure: same inputs, same output. */
export function evaluateTransition(input: TransitionInputs): TransitionVerdict {
  if (!(input.stopThresholdPercent > 0 && input.stopThresholdPercent < 100)) {
    throw new Error(
      `evaluateTransition: stopThresholdPercent must be in (0, 100) (got ${input.stopThresholdPercent}). ` +
        'A zero or negative threshold would fire on every frozen bar; 100 could never fire.',
    );
  }

  const stop = evaluateStop(input);
  const sticky = input.sticky;

  const base = {
    asset: input.asset,
    barAtMs: sticky?.timestamp ?? null,
    actionable: sticky?.actionable === true,
    confirmedRegime: sticky?.active ?? null,
    rawRegime: sticky?.raw ?? null,
    runLength: sticky?.runLength ?? 0,
    labelRun: sticky?.labelRun ?? 0,
    riskOff: input.riskOffConfirmed,
    stopArmed: stop.armed,
    stopWouldFire: stop.wouldFire,
    stopAbstainedReason: stop.abstainedReason,
    drawdownFromPeakPercent: stop.drawdownPercent,
    peakPrice: input.peakPriceSinceEntry,
    price: input.price,
    stopThresholdPercent: input.stopThresholdPercent,
  };

  // ── The ladder, in the fixed order ────────────────────────────────────────────
  //
  // The stop is evaluated before the `sticky == null` check rather than after it, and that
  // reordering is INERT rather than a judgement call: `evaluateStop` only arms on
  // `sticky?.frozen === true`, so with no sticky state it cannot fire and the branch below
  // is unreachable in that case. It is written this way so the two deterministic exits sit
  // together, above everything that can abstain.
  if (stop.wouldFire) {
    return {
      ...base,
      gate: 'stop_exit',
      gateReason:
        `peak stop: ${base.drawdownFromPeakPercent!.toFixed(2)}% below the peak during a transition ` +
        `(threshold ${input.stopThresholdPercent}%) — full exit of the line`,
    };
  }
  // Rung 2 lifts the freeze for reductions — and it lifts the SILENCE too. `sticky == null`
  // is not a reason to hold: it is the absence of an individual reading, and a confirmed
  // global risk_off is a reading of the whole market that does not need one.
  if ((sticky == null || sticky.frozen) && input.riskOffConfirmed) {
    return {
      ...base,
      gate: 'risk_off_reduction',
      gateReason:
        sticky == null
          ? 'confirmed global risk_off — reductions stay allowed on an asset with no usable 4h bar; ' +
            'increases do not'
          : 'confirmed global risk_off — reductions stay allowed despite the individual transition; ' +
            'increases do not',
    };
  }
  if (sticky == null) {
    return {
      ...base,
      gate: 'no_regime',
      gateReason: 'no 4h bar had closed for this asset — the layer abstains rather than guessing',
    };
  }
  if (sticky.frozen) {
    return {
      ...base,
      gate: 'frozen',
      gateReason:
        `transition in progress: raw ${sticky.raw} for ${sticky.runLength} bar(s), confirmed regime ` +
        `still ${sticky.active} — no strategic order`,
    };
  }
  return {
    ...base,
    gate: 'actionable',
    gateReason: `${sticky.active} confirmed over ${sticky.runLength} consecutive bars — normal playbook`,
  };
}

/**
 * What the layer WOULD have done with an order the model actually produced.
 *
 * Read as a counterfactual and nothing more: in observe mode the order has already
 * booked by the time this runs, and this verdict changes nothing about it.
 *
 * `superseded` is deliberately not folded into either bucket. On a `stop_exit` cycle the
 * code would already be selling the whole line, so a model sell is not "forbidden" (it
 * agrees with the exit) and a model buy is not simply "refused" (it is overtaken by a
 * larger action). Collapsing that into allowed/forbidden would corrupt the very count the
 * observation exists to produce.
 */
export function judgeOrder(
  verdict: TransitionVerdict,
  side: 'buy' | 'sell',
): { verdict: OrderVerdict; reason: string } {
  switch (verdict.gate) {
    case 'no_regime':
      return { verdict: 'unjudged', reason: verdict.gateReason };
    case 'stop_exit':
      return { verdict: 'superseded', reason: `${verdict.gateReason} — the model's ${side} is moot` };
    case 'risk_off_reduction':
      return side === 'sell'
        ? { verdict: 'allowed', reason: 'reduction under a confirmed global risk_off' }
        : { verdict: 'forbidden', reason: 'increase refused: risk_off lifts the freeze for reductions only' };
    case 'frozen':
      return { verdict: 'forbidden', reason: verdict.gateReason };
    case 'actionable':
      return { verdict: 'allowed', reason: verdict.gateReason };
  }
}
