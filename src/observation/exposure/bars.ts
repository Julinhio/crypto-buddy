import { Decimal } from '../../money.js';
import type { ControllerContext } from './context.js';
import { isDecided, type CycleObservation } from './cycles.js';

/**
 * THE 4H BAR IS THE UNIT OF EVERY MARKET STATISTIC, and the cycle is the unit of everything
 * else.
 *
 * The bot wakes up three to seven times inside one 4h bar. The market context it reads is
 * computed on the CLOSED bar, so those wake-ups share one and the same regime, one and the
 * same breadth, one and the same `risk_off`. Counting them as independent observations would
 * weight a bar by how often the scheduler happened to fire during it — a bar with seven
 * wake-ups would carry seven times the evidence of a bar with three, for a reason that has
 * nothing to do with the market.
 *
 * So anything said about the CONTEXT is said per bar. Anything said about the BOOK or about
 * the MODEL keeps the cycle grain, because those two genuinely move between two wake-ups of
 * the same bar — and that movement, at constant market information, is one of the things this
 * snapshot exists to expose.
 */

const POINT_DP = 6;

export interface Extremes {
  first: number | null;
  last: number | null;
  min: number | null;
  max: number | null;
}

function extremesOf(values: ReadonlyArray<number | null>): Extremes {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return { first: null, last: null, min: null, max: null };
  return {
    first: present[0]!,
    last: present[present.length - 1]!,
    min: present.reduce((a, b) => (b < a ? b : a)),
    max: present.reduce((a, b) => (b > a ? b : a)),
  };
}

export interface BarSynthesis {
  /** Null for the bucket holding cycles that journaled no bar at all. */
  bar_key: string | null;
  cycles: number;
  decision_ids: number[];
  statuses: Record<string, number>;
  decided_cycles: number;
  /**
   * The bar's controller context. When `context_stable` is false this is the FIRST cycle's
   * reading and `context_unstable_fields` names what moved — the per-cycle rows are then the
   * only honest source.
   */
  context: ControllerContext | null;
  context_stable: boolean;
  context_variants: number;
  context_unstable_fields: string[];
  cycles_without_context: number;
  /** The real book, across the bar's wake-ups. Cycle grain, summarised. */
  book_exposure_percent: Extremes;
  /** What the model PROPOSED, over the bar's decided cycles. */
  raw_target_exposure_percent: Extremes;
  /** What the chain RETAINED, over the same cycles. */
  applied_target_exposure_percent: Extremes;
  /**
   * The distinct gate labels seen on each asset during the bar — a SET, not a count, so a bar
   * with seven wake-ups cannot outweigh one with three.
   */
  gate_labels_by_asset: Record<string, string[]>;
  stop_armed_assets: string[];
  stop_would_fire_assets: string[];
  movements_booked: number;
  movements_booked_notional_quote: number;
  atomic_refusal_cycles: number;
}

/**
 * THE WHOLE PUBLISHED CONTEXT, not a chosen handful of its fields.
 *
 * A fingerprint over the aggregates alone — state, counts, net breadth — treats two wake-ups as
 * identical whenever their differences cancel: BTC up with ETH down, then the reverse, produce
 * the same tallies and the same state. It would also miss `medianH4Rsi` and `assetsPresent`
 * moving inside a bar, which is exactly what a partial market-data outage does — and those two
 * are the inputs a later variant is judged on. A field that hides the drift it exists to expose
 * is worse than no field.
 *
 * So the fingerprint is the published object itself, and the instability report names its
 * top-level fields. Every context comes from the same construction site in `contextOf`, so the
 * key order is fixed and `JSON.stringify` is a stable comparison rather than a lucky one.
 */
function contextFingerprint(context: ControllerContext): string {
  return JSON.stringify(context);
}

function unstableFields(contexts: readonly ControllerContext[]): string[] {
  const keys = new Set<string>();
  for (const context of contexts) for (const key of Object.keys(context)) keys.add(key);
  const moved: string[] = [];
  for (const key of [...keys].sort()) {
    const distinct = new Set(contexts.map((c) => JSON.stringify((c as unknown as Record<string, unknown>)[key])));
    if (distinct.size > 1) moved.push(key);
  }
  return moved;
}

/** Cycle order inside the window: wall clock first, identity as the tie-break. */
export function cycleOrder(a: CycleObservation, b: CycleObservation): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.decision_id - b.decision_id;
}

/** Groups the cycles by their 4h bar, keeping the null-bar bucket visible at the end. */
export function groupByBar(cycles: readonly CycleObservation[]): Array<{ key: string | null; cycles: CycleObservation[] }> {
  const buckets = new Map<string, CycleObservation[]>();
  const orphans: CycleObservation[] = [];
  for (const cycle of [...cycles].sort(cycleOrder)) {
    if (cycle.bar.key == null) {
      orphans.push(cycle);
      continue;
    }
    const list = buckets.get(cycle.bar.key);
    if (list) list.push(cycle);
    else buckets.set(cycle.bar.key, [cycle]);
  }
  const groups = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, list]) => ({ key: key as string | null, cycles: list }));
  if (orphans.length > 0) groups.push({ key: null, cycles: orphans });
  return groups;
}

export function buildBars(cycles: readonly CycleObservation[]): BarSynthesis[] {
  return groupByBar(cycles).map(({ key, cycles: inBar }) => {
    const statuses: Record<string, number> = {};
    for (const cycle of inBar) statuses[cycle.status] = (statuses[cycle.status] ?? 0) + 1;

    const contexts = inBar.map((c) => c.context).filter((c): c is ControllerContext => c != null);
    const variants = new Set(contexts.map(contextFingerprint));
    const decided = inBar.filter(isDecided);

    const gateLabels: Record<string, Set<string>> = {};
    const armed = new Set<string>();
    const wouldFire = new Set<string>();
    let atomicRefusals = 0;
    for (const cycle of inBar) {
      if (cycle.transition.atomic_refusal === true) atomicRefusals += 1;
      for (const verdict of cycle.transition.verdicts) {
        (gateLabels[verdict.asset] ??= new Set()).add(verdict.gate);
        if (verdict.stop.armed) armed.add(verdict.asset);
        if (verdict.stop.would_fire) wouldFire.add(verdict.asset);
      }
    }

    let bookedCount = 0;
    let bookedNotional = new Decimal(0);
    for (const cycle of inBar) {
      for (const movement of cycle.movements) {
        if (!movement.booked) continue;
        bookedCount += 1;
        if (movement.booked_notional_quote != null) {
          bookedNotional = bookedNotional.plus(movement.booked_notional_quote);
        }
      }
    }

    return {
      bar_key: key,
      cycles: inBar.length,
      decision_ids: inBar.map((c) => c.decision_id),
      statuses,
      decided_cycles: decided.length,
      context: contexts[0] ?? null,
      context_stable: variants.size <= 1,
      context_variants: variants.size,
      context_unstable_fields: variants.size > 1 ? unstableFields(contexts) : [],
      cycles_without_context: inBar.length - contexts.length,
      book_exposure_percent: extremesOf(inBar.map((c) => c.book.exposure_percent)),
      raw_target_exposure_percent: extremesOf(decided.map((c) => c.model_decision.raw_target?.exposure_percent ?? null)),
      applied_target_exposure_percent: extremesOf(
        decided.map((c) => c.model_decision.applied_target?.exposure_percent ?? null),
      ),
      gate_labels_by_asset: Object.fromEntries(
        Object.keys(gateLabels)
          .sort()
          .map((asset) => [asset, [...gateLabels[asset]!].sort()]),
      ),
      stop_armed_assets: [...armed].sort(),
      stop_would_fire_assets: [...wouldFire].sort(),
      movements_booked: bookedCount,
      movements_booked_notional_quote: Number(bookedNotional.toFixed(POINT_DP)),
      atomic_refusal_cycles: atomicRefusals,
    };
  });
}

export interface IntrabarChange {
  from_decision_id: number;
  to_decision_id: number;
  /** Model exposure delta between two consecutive DECIDED cycles of the same bar, in points. */
  raw_exposure_delta_points: number | null;
  applied_exposure_delta_points: number | null;
  /** Per-asset weight moves in the RAW proposal — the change of mind itself. */
  assets_changed: Array<{ asset: string; from: number | null; to: number | null }>;
  /** Cycles between the two that produced no target at all. Never silently bridged. */
  skipped_decision_ids: number[];
}

export interface IntrabarBar {
  bar_key: string;
  cycles: number;
  decision_ids: number[];
  statuses: string[];
  /** The three paths, in cycle order. Null where a cycle produced no target. */
  book_exposure_path: Array<number | null>;
  raw_target_exposure_path: Array<number | null>;
  applied_target_exposure_path: Array<number | null>;
  changes: IntrabarChange[];
  /** At least one asset weight moved between two wake-ups of the SAME bar. */
  changed_mind: boolean;
  /** Widest gap between two raw targets inside the bar, in exposure points. */
  raw_exposure_swing_points: number | null;
}

/**
 * The weights a change of mind may be measured between — DECIDED cycles only.
 *
 * A `guard_failed` row carries the refused proposal for the post-mortem (see `isDecided`).
 * Reading it here would turn a response the chain threw away into a change of mind the model
 * never got to have — and would put it in the paths and the swings besides.
 */
function weightsOf(cycle: CycleObservation): Record<string, number> | null {
  return isDecided(cycle) ? (cycle.model_decision.raw_target?.allocation ?? null) : null;
}

/**
 * THE CHANGES OF MIND, AT CONSTANT MARKET INFORMATION.
 *
 * Every bar with two or more wake-ups appears here, INCLUDING the ones where nothing moved.
 * Publishing only the bars that changed would give a numerator with no denominator, and
 * "the model reconsiders inside a bar" would read as a rate nobody could compute.
 *
 * Changes are measured between consecutive DECIDED cycles. A failed wake-up in between is not
 * a change of mind — it is an absence of answer — so it is listed as skipped rather than
 * bridged silently or treated as a move to zero.
 */
export function buildIntrabar(cycles: readonly CycleObservation[]): IntrabarBar[] {
  const out: IntrabarBar[] = [];
  for (const { key, cycles: inBar } of groupByBar(cycles)) {
    if (key == null || inBar.length < 2) continue;

    const changes: IntrabarChange[] = [];
    let previous: CycleObservation | null = null;
    let pending: number[] = [];
    for (const cycle of inBar) {
      const weights = weightsOf(cycle);
      if (weights == null) {
        pending.push(cycle.decision_id);
        continue;
      }
      if (previous != null) {
        const before = weightsOf(previous)!;
        const assets = [...new Set([...Object.keys(before), ...Object.keys(weights)])].sort();
        const moved = assets
          .map((asset) => ({ asset, from: before[asset] ?? null, to: weights[asset] ?? null }))
          .filter((entry) => entry.from !== entry.to);
        const rawFrom = previous.model_decision.raw_target?.exposure_percent ?? null;
        const rawTo = cycle.model_decision.raw_target?.exposure_percent ?? null;
        const appliedFrom = previous.model_decision.applied_target?.exposure_percent ?? null;
        const appliedTo = cycle.model_decision.applied_target?.exposure_percent ?? null;
        changes.push({
          from_decision_id: previous.decision_id,
          to_decision_id: cycle.decision_id,
          raw_exposure_delta_points:
            rawFrom == null || rawTo == null ? null : Number(new Decimal(rawTo).minus(rawFrom).toFixed(POINT_DP)),
          applied_exposure_delta_points:
            appliedFrom == null || appliedTo == null
              ? null
              : Number(new Decimal(appliedTo).minus(appliedFrom).toFixed(POINT_DP)),
          assets_changed: moved,
          skipped_decision_ids: pending,
        });
      }
      previous = cycle;
      pending = [];
    }

    const rawPath = inBar.map((c) => (isDecided(c) ? (c.model_decision.raw_target?.exposure_percent ?? null) : null));
    const present = rawPath.filter((v): v is number => v != null);
    out.push({
      bar_key: key,
      cycles: inBar.length,
      decision_ids: inBar.map((c) => c.decision_id),
      statuses: inBar.map((c) => c.status),
      book_exposure_path: inBar.map((c) => c.book.exposure_percent),
      raw_target_exposure_path: rawPath,
      applied_target_exposure_path: inBar.map((c) =>
        isDecided(c) ? (c.model_decision.applied_target?.exposure_percent ?? null) : null,
      ),
      changes,
      changed_mind: changes.some((change) => change.assets_changed.length > 0),
      raw_exposure_swing_points:
        present.length < 2
          ? null
          : Number(
              new Decimal(present.reduce((a, b) => (b > a ? b : a)))
                .minus(present.reduce((a, b) => (b < a ? b : a)))
                .toFixed(POINT_DP),
            ),
    });
  }
  return out;
}
