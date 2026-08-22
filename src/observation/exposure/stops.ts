import { Decimal } from '../../money.js';
import { cycleOrder } from './bars.js';
import type { CycleObservation, MovementFact } from './cycles.js';

/**
 * THE STOP FACTS — preserved now, judged later.
 *
 * This brick records what the deterministic peak stop DID and did not do. It does not measure
 * what it cost: that needs future prices, pre-registered horizons and a censoring rule, and
 * all three belong to the offline chantier that comes next. Nothing here reaches forward in
 * time beyond the cutoff, and nothing here carries a price the cycle did not already carry.
 *
 * ── EPISODES, NEVER ROWS ───────────────────────────────────────────────────────────────
 *
 * Migration 0022 states the trap plainly: while nothing exits, the peak is never reset and a
 * line stays below its threshold, so `stop_would_fire` can be true on many CONSECUTIVE
 * wake-ups for what the contract makes a SINGLE exit. Counting rows would read hundreds of
 * exits where the rule produces one. So the unit here is the EPISODE — a maximal run of
 * consecutive cycles, per asset.
 *
 * A cycle that produced NO verdict for that asset does not continue a run. It breaks it, and
 * the episode says so (`broken_by_missing_verdict`). Bridging the gap would assert continuity
 * across cycles nobody observed; treating the gap as "stopped firing" would assert the
 * opposite. Neither is known, so the break is recorded as what it is.
 *
 * ── EXECUTED, OR ARMED AND NOT EXECUTED ────────────────────────────────────────────────
 *
 * The four states the next audit needs to tell apart:
 *
 *   - a stop whose exit BOOKED         → `exit_booked`, with the quantities to judge it by;
 *   - a stop that fired on a FAILED cycle → `no_exit_booked` / `all_cycles_failed`;
 *   - a stop that fired and booked nothing on a decided cycle → `no_exit_booked` /
 *     `no_sell_booked` — which is what the layer produces whenever it is not enforcing;
 *   - the re-entry, or its absence.
 *
 * ATTRIBUTION IS NOT ASSERTED. Whether a booked sell came from the code's exit or from the
 * model deciding to sell the same line on the same wake-up cannot be read from the journal:
 * the layer's mode is an environment variable and no column records it. The snapshot
 * therefore publishes the movement and the gate that stood beside it, and stops there. What
 * it never does is credit the model with a mechanical re-entry — there is no proxy here to
 * re-enter with, and every re-entry recorded below is a real booked order of a real cycle.
 */

const QTY_DP = 12;

export interface StopEpisodeMovement {
  decision_id: number;
  /**
   * WHEN THE MOVEMENT WAS BOOKED — the sovereign intent's own instant, never the cycle's.
   *
   * A wake-up is not atomic: the decision row is inserted, THEN the orders are placed, THEN the
   * executions are journaled. Timestamping a booking with its cycle's `created_at` would hand
   * the next chantier — whose whole subject is the delay between a stop and its re-entry — an
   * instant that can sit materially earlier than the order it claims to date.
   *
   * NULL when the journal carries no booking instant. The cycle's own time is one `decision_id`
   * away in `cycles.json`, so nothing is lost by refusing to substitute it here — and a
   * substituted instant would be indistinguishable from a measured one.
   */
  booked_at: string | null;
  side: string;
  /** The line's quantity BEFORE the decision, as the cycle's own book recorded it. */
  pre_trade_qty: number | null;
  booked_base_delta: number | null;
  /** `pre_trade_qty − |booked_base_delta|`. Published so "was it a full exit" is arithmetic. */
  residual_qty: number | null;
  gross_notional_quote: number | null;
  gate: string | null;
  order_verdict: string | null;
}

export interface StopEpisode {
  asset: string;
  from_decision_id: number;
  to_decision_id: number;
  /**
   * The WAKE-UP instants the episode spans — deliberately the cycles', because an episode is a
   * run of wake-ups and not of orders. Named apart from `booked_at` so the two can never be
   * read as the same kind of time.
   */
  from_cycle_at: string;
  to_cycle_at: string;
  /** Consecutive cycles the stop stayed fired over. The episode, not the row count. */
  cycles: number;
  decision_ids: number[];
  /** Statuses of those cycles — a stop that fires on a failed wake-up is a distinct case. */
  statuses: string[];
  threshold_percent: number | null;
  deepest_drawdown_from_peak_percent: number | null;
  outcome: 'exit_booked' | 'no_exit_booked';
  outcome_reason: string;
  exit: StopEpisodeMovement | null;
  /** The run ended because a cycle produced no verdict for this asset, not because it healed. */
  broken_by_missing_verdict: boolean;
  /**
   * The first BOOKED BUY on this asset in a cycle strictly after the episode. Null when none
   * was observed before the cutoff — which is a result, not a gap, and is never censored.
   *
   * `booked_at` is the ORDER's instant, for the same reason as on the exit above: this is the
   * far end of the stop-to-re-entry delay the next chantier will measure.
   */
  re_entry: { decision_id: number; booked_at: string | null; gross_notional_quote: number | null } | null;
  /**
   * Cycles observed after the episode ended, inside the window. The honest denominator for
   * "no re-entry": with no horizon and no censoring rule — both belong to the next chantier —
   * a null re-entry means nothing without this number beside it.
   */
  cycles_after_episode_in_window: number;
}

export interface StopFacts {
  /** (cycle, asset) verdicts where the stop was armed — the line frozen and held. */
  armed_verdicts: number;
  /** Armed, and the drawdown reached the threshold. */
  would_fire_verdicts: number;
  /** Armed, and the stop could not even look (no live price, a stale one, no peak). */
  abstained_verdicts: number;
  /** Armed and NOT fired — the ordinary case, kept explicit so the ratio is readable. */
  armed_not_fired_verdicts: number;
  armed_assets: string[];
  episodes: StopEpisode[];
}

function verdictFor(cycle: CycleObservation, asset: string) {
  return cycle.transition.verdicts.find((verdict) => verdict.asset === asset) ?? null;
}

function bookedMovement(cycle: CycleObservation, asset: string, side: string): MovementFact | null {
  return cycle.movements.find((m) => m.asset === asset && m.side === side && m.booked) ?? null;
}

function preTradeQty(cycle: CycleObservation, asset: string): number | null {
  return cycle.book.positions.find((p) => p.asset === asset)?.qty ?? null;
}

function round(value: Decimal, dp: number): number {
  return Number(value.toFixed(dp));
}

/** Every asset the window produced a transition verdict for, in a stable order. */
export function observedAssets(cycles: readonly CycleObservation[]): string[] {
  const assets = new Set<string>();
  for (const cycle of cycles) for (const verdict of cycle.transition.verdicts) assets.add(verdict.asset);
  return [...assets].sort();
}

export function buildStopFacts(cycles: readonly CycleObservation[]): StopFacts {
  const ordered = [...cycles].sort(cycleOrder);

  let armed = 0;
  let wouldFire = 0;
  let abstained = 0;
  const armedAssets = new Set<string>();
  for (const cycle of ordered) {
    for (const verdict of cycle.transition.verdicts) {
      if (verdict.stop.armed) {
        armed += 1;
        armedAssets.add(verdict.asset);
      }
      if (verdict.stop.would_fire) wouldFire += 1;
      if (verdict.stop.abstained_reason != null) abstained += 1;
    }
  }

  const episodes: StopEpisode[] = [];
  for (const asset of observedAssets(ordered)) {
    let run: CycleObservation[] = [];

    const close = (endIndex: number, gap: boolean): void => {
      if (run.length === 0) return;
      episodes.push(buildEpisode(asset, run, ordered, endIndex, gap));
      run = [];
    };

    for (let i = 0; i < ordered.length; i += 1) {
      const cycle = ordered[i]!;
      const verdict = verdictFor(cycle, asset);
      if (verdict == null) {
        // No verdict on this asset this cycle: the run cannot continue through what nobody
        // observed, and it did not "stop firing" either. Break, and say which it was.
        close(i, true);
        continue;
      }
      if (verdict.stop.would_fire) {
        run.push(cycle);
        continue;
      }
      close(i, false);
    }
    close(ordered.length, false);
  }

  episodes.sort((a, b) =>
    a.from_decision_id !== b.from_decision_id
      ? a.from_decision_id - b.from_decision_id
      : a.asset < b.asset
        ? -1
        : 1,
  );

  return {
    armed_verdicts: armed,
    would_fire_verdicts: wouldFire,
    abstained_verdicts: abstained,
    armed_not_fired_verdicts: armed - wouldFire,
    armed_assets: [...armedAssets].sort(),
    episodes,
  };
}

function buildEpisode(
  asset: string,
  run: readonly CycleObservation[],
  ordered: readonly CycleObservation[],
  endIndex: number,
  brokenByGap: boolean,
): StopEpisode {
  const first = run[0]!;
  const last = run[run.length - 1]!;

  let exit: StopEpisodeMovement | null = null;
  for (const cycle of run) {
    const movement = bookedMovement(cycle, asset, 'sell');
    if (movement == null) continue;
    const qty = preTradeQty(cycle, asset);
    const delta = movement.ledger_base_delta;
    const verdict = verdictFor(cycle, asset);
    exit = {
      decision_id: cycle.decision_id,
      // The MOVEMENT's instant, never the cycle's — see `StopEpisodeMovement.booked_at`.
      booked_at: movement.booked_at,
      side: movement.side,
      pre_trade_qty: qty,
      booked_base_delta: delta,
      residual_qty:
        qty == null || delta == null ? null : round(new Decimal(qty).minus(new Decimal(delta).abs()), QTY_DP),
      gross_notional_quote: movement.gross_notional_quote,
      gate: verdict?.gate ?? null,
      order_verdict: verdict?.order?.verdict ?? null,
    };
    break;
  }

  const after = ordered.slice(endIndex);
  let reEntry: StopEpisode['re_entry'] = null;
  for (const cycle of after) {
    const movement = bookedMovement(cycle, asset, 'buy');
    if (movement == null) continue;
    reEntry = {
      decision_id: cycle.decision_id,
      booked_at: movement.booked_at,
      gross_notional_quote: movement.gross_notional_quote,
    };
    break;
  }

  const decided = run.filter((cycle) => cycle.model_decision.raw_target != null);
  const drawdowns = run
    .map((cycle) => verdictFor(cycle, asset)?.stop.drawdown_from_peak_percent ?? null)
    .filter((value): value is number => value != null);

  return {
    asset,
    from_decision_id: first.decision_id,
    to_decision_id: last.decision_id,
    from_cycle_at: first.created_at,
    to_cycle_at: last.created_at,
    cycles: run.length,
    decision_ids: run.map((cycle) => cycle.decision_id),
    statuses: run.map((cycle) => cycle.status),
    threshold_percent: verdictFor(first, asset)?.stop.threshold_percent ?? null,
    deepest_drawdown_from_peak_percent: drawdowns.length === 0 ? null : Math.min(...drawdowns),
    outcome: exit == null ? 'no_exit_booked' : 'exit_booked',
    outcome_reason:
      exit != null
        ? 'a sell on this asset booked into the sovereign ledger during the episode'
        : decided.length === 0
          ? 'all_cycles_failed: no wake-up of this episode produced a usable decision'
          : 'no_sell_booked: the episode had decided cycles and none of them booked a sell on this asset',
    exit,
    broken_by_missing_verdict: brokenByGap,
    re_entry: reEntry,
    cycles_after_episode_in_window: after.length,
  };
}
