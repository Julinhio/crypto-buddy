import { Decimal, ZERO, dec } from '../money.js';
import type { PositionView, PriceLookup, VirtualPortfolio } from '../portfolio/derive.js';
import { planMovements, type Movement, type SuppressedLeg } from '../execution/movements.js';
import { waterfill } from './correct.js';

/**
 * THE WITNESSES — brick 3 of the constrained-exposure pilot.
 *
 * A witness is a CHAINED paper book: it opens once with an equity, and from then on every
 * cycle values it at that cycle's real prices, aims at its own target, and books what the
 * plumbing actually lets it book. Nothing here reads, writes, or places anything; the module
 * is pure and total, and its chain is deterministic — same inputs, same books, byte for byte.
 *
 *   §3.7  Témoin E   reproduces the bot's REAL total exposure at each interval, split equally
 *                    across the four assets.
 *         Témoin P   stays at the CURRENT BAND'S FLOOR, split equally.
 *
 *   Bot − E measures selection at identical exposure.
 *   E − P   measures the value of the exposure timing inside the band.
 *   Bot − P measures the two together.
 *
 * ── WHAT THE WITNESSES BEAR, AND WHAT THEY DO NOT ──────────────────────────────────────
 *
 * ARBITRATED. They bear their OWN execution plumbing — fees, the 2% movement floor, dust, a
 * missing price, an unfunded buy — applied to their OWN book, through the very same
 * `planMovements` the executor uses. A witness that ignored the floor would be a benchmark no
 * portfolio could ever have held.
 *
 * They do NOT bear the bot's transition gates, stops, or freezes. Those states belong to the
 * bot's own positions: a `stop_exit` fires on the bot's entry price, a `frozen` marks a
 * transition on the bot's line. A witness never took that entry. Applying them would make the
 * comparator depend on the very trajectory it exists to evaluate — and, today, would make the
 * witnesses MORE constrained than the bot they benchmark, since `TRANSITION_MODE=observe`
 * blocks none of the bot's real orders. This separation holds even if the gate is later armed
 * in `enforce`; it is a statement about whose book a freeze describes, not about a mode.
 *
 * The one book here that DOES inherit the gates is `B̂`, the corrected bot — and it is not a
 * witness. It is the bot itself under the correction, so the corrector's rule applies to it in
 * full: the code never creates an order on a line the transition layer declares frozen.
 */

/** Six decimals, the same rounding the corrector publishes its weights with. */
const DP = 1e6;
const EPS = 1e-9;
const round = (value: number): number => Math.round(value * DP) / DP;

// ── THE BOOK ──────────────────────────────────────────────────────────────────────────

/**
 * A chained paper book: quantities and cash, and nothing else.
 *
 * Deliberately NOT a `VirtualPortfolio`. That type carries derived values — equity, weights,
 * unrealised P&L — which are only true at one set of prices; storing them across cycles is how
 * a chain starts marking yesterday's book at yesterday's prices. The book holds only what a
 * book really holds, and every derived number is recomputed from the cycle's own prices.
 */
export interface WitnessBook {
  readonly reserveAsset: string;
  readonly startingCapital: Decimal;
  readonly cash: Decimal;
  readonly qty: ReadonlyMap<string, Decimal>;
}

/** A witness opens fully in cash: it has taken no position anyone has to justify. */
export function openBook(reserveAsset: string, equity: Decimal): WitnessBook {
  return { reserveAsset, startingCapital: equity, cash: equity, qty: new Map() };
}

/**
 * The book valued at ONE cycle's prices — or an honest refusal.
 *
 * A held line with no price cannot be valued, and a fabricated valuation would propagate into
 * the equity, the weights, the movement floor and every figure downstream. So the whole cycle
 * is refused for that witness rather than half-computed: it holds, and the gap is journaled.
 *
 * An asset the book does NOT hold needs no price to be valued — only to be bought — so its
 * absence is left to `planMovements`, which already declines that leg as `no_price`.
 */
export type WitnessValuation =
  | { ok: true; portfolio: VirtualPortfolio; equity: number; exposurePercent: number }
  | { ok: false; reason: 'no_price'; assets: string[] };

export function valueBook(book: WitnessBook, priceOf: PriceLookup): WitnessValuation {
  const positions: PositionView[] = [];
  const unpriced: string[] = [];
  let deployed = ZERO;

  for (const [asset, qty] of [...book.qty].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (qty.lte(0)) continue;
    const price = priceOf(asset);
    if (price == null || price.lte(0)) {
      unpriced.push(asset);
      continue;
    }
    const value = qty.times(price);
    deployed = deployed.plus(value);
    positions.push({
      asset,
      qty,
      // A witness has no entry story: it is a mechanical benchmark, not a thesis. Its cost
      // basis is its current price, so its unrealised P&L is zero by construction and no
      // reader can mistake one for a trading record.
      avgCost: price,
      price,
      priceStale: false,
      value,
      unrealizedPnl: ZERO,
      weightPercent: ZERO,
    });
  }
  if (unpriced.length > 0) return { ok: false, reason: 'no_price', assets: unpriced };

  const equity = book.cash.plus(deployed);
  const exposure = equity.lte(0) ? ZERO : deployed.div(equity).times(100);
  for (const position of positions) {
    position.weightPercent = equity.lte(0) ? ZERO : position.value.div(equity).times(100);
  }
  return {
    ok: true,
    equity: equity.toNumber(),
    exposurePercent: round(exposure.toNumber()),
    portfolio: {
      reserveAsset: book.reserveAsset,
      startingCapital: book.startingCapital,
      cash: book.cash,
      positions,
      equity,
      deployedPercent: exposure,
      // A witness books no realised P&L of its own: every figure it publishes is read off its
      // equity, and inventing a split would invite a P&L reading this brick does not produce.
      realizedPnl: ZERO,
      unrealizedPnl: ZERO,
      totalPnl: ZERO,
    },
  };
}

// ── THE TARGET: EQUAL WEIGHT UNDER CAPS, EXCESS REDISTRIBUTED ─────────────────────────

/**
 * What a witness aims at: the same exposure, split equally, then made feasible.
 *
 * ARBITRATED, and the arbitration is the interesting part. §3.7 says "split equally across the
 * four assets"; the per-asset caps say XRP may not exceed 15. Equal weight at 66% exposure
 * wants 16.5 on every line, so the two cannot both hold — and above 60% exposure they never
 * can. The contract's PRIORITY is the exposure: "Bot − E measures selection AT IDENTICAL
 * EXPOSURE" is only true if E really holds the bot's exposure. Equal weight comes second.
 *
 * So: split equally, clip whatever a cap refuses, and REDISTRIBUTE the excess onto the lines
 * that still have room — the same water-filling the band's own redistribution uses, imported
 * rather than rewritten. No surplus goes back to cash while the caps can still hold the
 * exposure; only what no cap can take is reported as unplaceable, and that is journaled rather
 * than absorbed.
 *
 * On the current caps (35/35/20/15 = 105 of headroom against 70 of deployable equity) the
 * unplaceable branch cannot be reached. It is computed anyway: a cap change would reach it,
 * and a silent assumption is exactly what this pilot journals instead of trusting.
 */
export interface EqualWeightPlan {
  /** The allocation, reserve included, summing to 100. */
  allocation: Record<string, number>;
  targetExposurePercent: number;
  /** What the caps actually let the witness hold. */
  placedExposurePercent: number;
  /** The lines pinned at their cap. */
  clipped: string[];
  /** Points the equal split had to move off a capped line onto another. */
  redistributedPoints: number;
  /** Points no cap could take — the only ones that fall back to cash. */
  unplaceablePoints: number;
}

export function equalWeightUnderCaps(
  targetExposurePercent: number,
  assets: readonly string[],
  capOf: (asset: string) => number,
  reserveAsset: string,
): EqualWeightPlan {
  const universe = [...assets].filter((a) => a !== reserveAsset).sort();
  const target = Math.max(0, round(targetExposurePercent));
  const allocation: Record<string, number> = {};

  if (universe.length === 0 || target <= EPS) {
    for (const asset of universe) allocation[asset] = 0;
    allocation[reserveAsset] = 100;
    return {
      allocation,
      targetExposurePercent: target,
      placedExposurePercent: 0,
      clipped: [],
      redistributedPoints: 0,
      unplaceablePoints: target,
    };
  }

  // Every line has the SAME share — that is what "equally" means — and its own headroom.
  const given = waterfill(
    target,
    universe.map((asset) => ({ asset, share: 1, headroom: Math.max(0, capOf(asset)) })),
  );

  const equalShare = target / universe.length;
  let placedExact = 0;
  let rounded = 0;
  let excessOffCaps = 0;
  const clipped: string[] = [];
  for (const asset of universe) {
    const exact = given.get(asset) ?? 0;
    const weight = round(exact);
    allocation[asset] = weight;
    placedExact += exact;
    rounded += weight;
    if (weight + EPS < equalShare) excessOffCaps += equalShare - weight;
    if (Math.abs(weight - Math.max(0, capOf(asset))) <= 1e-6) clipped.push(asset);
  }
  // MEASURED ON THE EXACT SPLIT, not on the rounded weights. Rounding four lines to six
  // decimals loses up to a millionth of a point, and charging that to "no cap could take it"
  // would report an unplaceable remainder on a distribution that placed everything.
  const unplaceable = placedExact + EPS >= target ? 0 : round(target - placedExact);
  // The reserve closes the allocation on the ROUNDED weights, so the vector sums to exactly
  // 100 — `planMovements` sizes the buy budget against this line, and a vector that missed by
  // a millionth would hand it a budget nobody asked for.
  allocation[reserveAsset] = round(100 - rounded);
  const placed = round(placedExact);

  return {
    allocation,
    targetExposurePercent: target,
    placedExposurePercent: placed,
    clipped,
    redistributedPoints: round(Math.max(0, excessOffCaps - unplaceable)),
    unplaceablePoints: unplaceable,
  };
}

// ── ONE CYCLE ─────────────────────────────────────────────────────────────────────────

export interface WitnessStepInput {
  book: WitnessBook;
  /** Where the witness wants to be, reserve included. */
  allocation: Record<string, number>;
  priceOf: PriceLookup;
  feePercent: number;
  minMovementPercent: number;
  /** Tags the plan's log lines so a witness's refusals cannot be read as the bot's. */
  logTag: string;
}

export interface WitnessStep {
  /** The book AFTER this cycle. */
  book: WitnessBook;
  equityBefore: number;
  equityAfter: number;
  exposureBeforePercent: number;
  /** What the witness REALLY holds afterwards — never what it aimed at. */
  exposureAfterPercent: number;
  feesQuote: number;
  movements: Movement[];
  suppressed: SuppressedLeg[];
}

/**
 * One cycle of one witness: value, plan, book.
 *
 * The plan comes from `planMovements`, the executor's own function, so the witness meets the
 * identical floor, the identical dust threshold, the identical fee arithmetic and the identical
 * refusal to buy without a budget. A witness with its own movement rules would be a benchmark
 * measured on a plumbing that does not exist.
 */
export function stepWitness(input: WitnessStepInput): WitnessStep | { gap: 'no_price'; assets: string[] } {
  const before = valueBook(input.book, input.priceOf);
  if (!before.ok) return { gap: 'no_price', assets: before.assets };

  const plan = planMovements(
    before.portfolio,
    input.allocation,
    input.priceOf,
    input.feePercent,
    input.minMovementPercent,
    input.logTag,
  );

  const qty = new Map(input.book.qty);
  let cash = input.book.cash;
  let fees = ZERO;
  for (const movement of plan.movements) {
    const held = qty.get(movement.asset) ?? ZERO;
    fees = fees.plus(movement.fee);
    if (movement.side === 'buy') {
      qty.set(movement.asset, held.plus(movement.qty));
      // The coin bought plus its fee — the fee is absorbed by the deployed side, exactly as
      // the executor absorbs it, so the reserve holds after the fills.
      cash = cash.minus(movement.notional.plus(movement.fee));
    } else {
      // A full exit closes the line rather than leaving a rounding crumb behind it.
      const remaining = movement.fullExit ? ZERO : held.minus(movement.qty);
      qty.set(movement.asset, remaining.lt(0) ? ZERO : remaining);
      cash = cash.plus(movement.notional.minus(movement.fee));
    }
  }

  const book: WitnessBook = {
    reserveAsset: input.book.reserveAsset,
    startingCapital: input.book.startingCapital,
    cash,
    qty,
  };
  const after = valueBook(book, input.priceOf);
  return {
    book,
    equityBefore: before.equity,
    equityAfter: after.ok ? after.equity : before.equity,
    exposureBeforePercent: before.exposurePercent,
    exposureAfterPercent: after.ok ? after.exposurePercent : before.exposurePercent,
    feesQuote: round(fees.toNumber()),
    movements: plan.movements,
    suppressed: plan.suppressed,
  };
}

/** The witness's own reading of its cycle — what P is required to publish by §3.7. */
export interface WitnessRow {
  /** What the policy asked for, before any cap or any plumbing. */
  targetExposurePercent: number;
  /** What the caps left reachable. */
  attainableExposurePercent: number;
  /** What the book really holds afterwards. */
  realisedExposurePercent: number;
  /** Realised minus target, signed — P's distance to its floor. */
  gapPoints: number;
  clipped: string[];
  redistributedPoints: number;
  unplaceablePoints: number;
}

export function witnessRow(plan: EqualWeightPlan, step: WitnessStep): WitnessRow {
  return {
    targetExposurePercent: plan.targetExposurePercent,
    attainableExposurePercent: plan.placedExposurePercent,
    realisedExposurePercent: step.exposureAfterPercent,
    gapPoints: round(step.exposureAfterPercent - plan.targetExposurePercent),
    clipped: plan.clipped,
    redistributedPoints: plan.redistributedPoints,
    unplaceablePoints: plan.unplaceablePoints,
  };
}

// ── C8's READER — built now, published only when the pilot arms ───────────────────────

/**
 * Does the model USE the exposure the corrector imposed, or fight it?
 *
 * THE READER EXISTS. ITS VERDICT DOES NOT — not during observation, by arbitration, and the
 * reason is not caution but arithmetic: the question asks what the model does when it SEES a
 * position the corrector created, and in observation mode it never saw one. No chained
 * counterfactual repairs that; it would be answering, with the model's real words, a question
 * the model was never asked. C8 begins the day `application` puts the corrected positions in
 * front of it, and a weakened figure published now would be read as the answer.
 *
 * THREE READINGS, because one would mislead. "The model asks for less than the imposed
 * position" is nearly automatic — it simply re-emits its own preference, which is what it did
 * before the correction existed. What separates indifference from a FIGHT is that it goes
 * lower than it had itself gone.
 */
export type AdoptionReading = 'adoption' | 'indifference' | 'lutte' | 'sans_objet';

export interface AdoptionInput {
  /** The imposed weight on that line, and what the model had asked for at the same cycle. */
  imposedWeightPercent: number;
  modelWeightPercent: number | null;
  /** What the model asks for on the NEXT cycle. */
  nextModelWeightPercent: number | null;
}

export function readAdoption(input: AdoptionInput): AdoptionReading {
  const { imposedWeightPercent: imposed, modelWeightPercent: own, nextModelWeightPercent: next } = input;
  if (next == null || own == null) return 'sans_objet';
  if (next + EPS >= imposed) return 'adoption';
  if (next + EPS >= own) return 'indifference';
  return 'lutte';
}

// ── CUTTING A CHAIN WHERE ITS DATA STOPS ─────────────────────────────────────────────

/**
 * WHERE a gap falls, which is what decides what it costs.
 *
 * A gap before the first reconstructible item costs nothing: the chain has not started, so
 * there is no book to carry across it. A gap INSIDE the window is different in kind — the
 * books would have to jump an interval in which they might have rebalanced, and continuing
 * would COMPRESS TIME: every later row would carry quantities, cash and fees that never
 * existed. So an internal gap CUTS: the segment closes there and a new one re-anchors at the
 * next complete item. A gap after the last one cuts nothing, because nothing resumes.
 */
export type GapPlacement = 'anterieur_au_debut' | 'interne' | 'terminal';

export interface PlacedGap {
  id: number;
  cause: string;
  placement: GapPlacement;
}

export interface ChainSegment<T> {
  /** 1-based, in order. No figure is ever computed across two segments. */
  id: number;
  items: T[];
  /** The first segment opens because the data starts; the others heal a cut. */
  opening: 'debut_reconstructible' | 'reancrage_apres_trou';
  /** The gap that closed the PREVIOUS segment — null on the first. */
  brokenBy: { id: number; cause: string } | null;
}

export type ChainEntry<T> = { ok: true; id: number; item: T } | { ok: false; id: number; cause: string };

/**
 * Cuts a sequence of classified items into contiguous segments.
 *
 * Pure and total, and separated from the replay on purpose: the corpus happens to carry no
 * internal gap today, so a rule that lived only inside the replay would be a rule nothing ever
 * exercised. Here it is proven on fixtures that DO have holes.
 *
 * A trailing gap is provisionally `terminal` and becomes `interne` the moment another complete
 * item follows it — which is the only way to know, reading forward once.
 */
export function cutIntoSegments<T>(entries: ReadonlyArray<ChainEntry<T>>): {
  segments: Array<ChainSegment<T>>;
  gaps: PlacedGap[];
} {
  const segments: Array<ChainSegment<T>> = [];
  const gaps: PlacedGap[] = [];
  let started = false;
  let pendingBreak: { id: number; cause: string } | null = null;
  let current: ChainSegment<T> | null = null;

  for (const entry of entries) {
    if (!entry.ok) {
      if (!started) {
        gaps.push({ id: entry.id, cause: entry.cause, placement: 'anterieur_au_debut' });
        continue;
      }
      gaps.push({ id: entry.id, cause: entry.cause, placement: 'terminal' });
      if (current != null) {
        segments.push(current);
        current = null;
        // The FIRST gap of a run is the one that broke the chain; the ones behind it are
        // already inside the hole and did not break anything of their own.
        pendingBreak = { id: entry.id, cause: entry.cause };
      }
      continue;
    }
    if (current == null) {
      current = {
        id: segments.length + 1,
        items: [],
        opening: started ? 'reancrage_apres_trou' : 'debut_reconstructible',
        brokenBy: pendingBreak,
      };
      // Everything provisionally terminal that precedes a resumed chain was, in fact, internal.
      for (const gap of gaps) if (gap.placement === 'terminal') gap.placement = 'interne';
      pendingBreak = null;
    }
    current.items.push(entry.item);
    started = true;
  }
  if (current != null) segments.push(current);
  return { segments, gaps };
}
