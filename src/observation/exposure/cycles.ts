import { config } from '../../config/index.js';
import { Decimal, ZERO, fromNumeric } from '../../money.js';
import { reserveStables } from '../../decision/schema.js';
import { canonicalInstant } from './instants.js';
import { contextOf, type ContextResult, type ControllerContext } from './context.js';
import type { DecisionRowRead, ExecutionRowRead, ObservationRowRead, RawWindow } from './read.js';

/**
 * ONE ROW PER REAL CYCLE — the fine grain of this snapshot, and the population it promises
 * not to thin.
 *
 * Every decision row inside the window becomes exactly one `CycleObservation`, whatever its
 * status. A cycle the model never answered has no target and says so with nulls; it does not
 * disappear. That is not politeness towards failed cycles: a population that quietly drops
 * them would make "how often does the model produce nothing" unanswerable from the very file
 * built to answer questions about the model's behaviour, and would flatter every rate
 * computed on the survivors.
 *
 * Nothing here is chained. Each cycle carries the book AS IT WAS BEFORE ITS OWN DECISION, and
 * that is the only anchor: no proxy portfolio is maintained across cycles, no target is
 * carried forward, no state accumulates. A one-step observation, re-anchored on the real
 * book every time.
 */

/** Percentages are rounded on write so two runs cannot differ in the last float bit. */
const PERCENT_DP = 6;
const QTY_DP = 12;

function round(value: Decimal, dp: number): number {
  return Number(value.toFixed(dp));
}

/**
 * A finite number, or null — and NOTHING is coerced into one.
 *
 * `Number(x)` is generous in ways a journal reader must not be: `true` becomes 1, `false` and
 * `''` become 0, `[5]` becomes 5. A legacy or hand-edited weight of `true` would then be
 * published as a perfectly plausible 1 % allocation, and `allocations_are_fully_readable` would
 * stay green over it — the exact failure those checks exist to make impossible. Only a real
 * number, or a non-empty string that is one, is accepted; PostgREST renders `numeric` as either.
 */
function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export interface AllocationView {
  /** The allocation exactly as journaled, keys sorted so the object is byte-stable. */
  allocation: Record<string, number>;
  /** Σ of every non-reserve weight — the TOTAL EXPOSURE this allocation describes. */
  exposure_percent: number;
  reserve_percent: number;
  /**
   * Σ of every weight. Recorded rather than assumed: the schema forces 100 on a fresh
   * `decided` row, and a legacy or hand-edited row that does not total 100 must be visible
   * instead of silently rescaling an exposure.
   */
  sum_percent: number;
  /** Allocation keys that are neither the reserve nor part of the controller universe. */
  unknown_assets: string[];
  /**
   * Keys the journal carries whose weight is not a finite number.
   *
   * Named rather than dropped: an unreadable weight removed in silence would leave the exposure
   * and the sum computed from the survivors alone, and a corrupted row would read as a valid,
   * smaller allocation. Any entry here fails `allocations_are_fully_readable`.
   */
  unreadable_assets: string[];
}

export interface BookPosition {
  asset: string;
  /**
   * NULL when the journaled quantity is not a finite number.
   *
   * `fromNumeric` maps a null to ZERO, which is right for money arithmetic and wrong here: it
   * would publish a real, zero-sized position where the book was simply unreadable, and a stop
   * episode would then compute a `pre_trade_qty` and a residual from a quantity nobody wrote.
   */
  qty: number | null;
  price: number | null;
  weight_percent: number | null;
  price_stale: boolean;
}

export interface BookView {
  /**
   * THE REAL EXPOSURE OF THE BOOK BEFORE THIS DECISION, in percent of equity — the virtual
   * portfolio's `deployedPercent`, as the model was shown it. Null when the cycle journaled
   * no portfolio at all.
   */
  exposure_percent: number | null;
  equity: number | null;
  cash: number | null;
  reserve_asset: string | null;
  positions: BookPosition[];
  /** Positions valued at their average cost because no live price came back. */
  price_stale_assets: string[];
  /** Positions whose journaled quantity is not a finite number. Fails an explicit check. */
  unreadable_qty_assets: string[];
  /**
   * The portfolio carried a `positions` value that is not an array — or none at all.
   *
   * A book nobody can read is not an empty book. Replacing it with `[]` would publish a flat
   * portfolio, leave `unreadable_qty_assets` empty, pass every check, and let a stop episode
   * report a null `pre_trade_qty` for a line that was there and was lost in parsing.
   */
  positions_unreadable: boolean;
  /**
   * Entries the collection carries that could not be identified at all — not an object, or no
   * asset name. COUNTED rather than named, precisely because they cannot be named.
   */
  unreadable_position_entries: number;
  /**
   * Summary fields the portfolio carries that cannot be read: `deployedPercent`, `equity`,
   * `cash`, `reserveAsset`.
   *
   * `exposure_percent` is the field every per-bar extremum rests on, and a corrupted one becomes
   * a clean `null` — indistinguishable, to any later reader, from a cycle that journaled no book
   * at all. That second case is real and legitimate; this one is a defect, and only naming the
   * field keeps them apart.
   */
  unreadable_summary_fields: string[];
}

export interface StopView {
  armed: boolean;
  would_fire: boolean;
  threshold_percent: number | null;
  peak_price: number | null;
  price: number | null;
  drawdown_from_peak_percent: number | null;
  /** Why an ARMED stop did not evaluate. "Did not fire" and "could not look" differ. */
  abstained_reason: string | null;
}

export interface TransitionVerdictView {
  asset: string;
  /**
   * When the verdict was WRITTEN — not the bar it was computed on, and not the wake-up time.
   *
   * Published because a cycle is not atomic: `decide()` inserts the decision, THEN places the
   * orders, THEN journals these verdicts. A cutoff landing between the two would pull a
   * post-cutoff fact into the snapshot, and without this field in the payload the cutoff scan
   * would have nothing to catch it with.
   */
  written_at: string | null;
  bar_at: string | null;
  actionable: boolean;
  gate: string;
  gate_reason: string;
  confirmed_regime: string | null;
  raw_regime: string | null;
  run_length: number;
  label_run: number;
  risk_off: boolean;
  stop: StopView;
  /** The model's VECTOR leg on this asset — what the gate judged, before execution. */
  leg: { side: string | null; notional: number | null; verdict: string | null; reason: string | null } | null;
  /** What actually BOOKED on this asset, and the layer's verdict on it. */
  order: { side: string | null; notional: number | null; verdict: string | null; reason: string | null } | null;
}

export interface MovementFact {
  asset: string;
  symbol: string;
  side: string;
  /** When the sovereign intent was written. Same reason as `written_at` on a verdict. */
  booked_at: string | null;
  /** The sovereign intent was booked into the ledger — the movement really RESERVED. */
  booked: boolean;
  validation_status: string | null;
  validation_reason: string | null;
  requested_qty: number | null;
  ledger_base_delta: number | null;
  ledger_quote_delta: number | null;
  valuation_price: number | null;
  fee: number | null;
  /**
   * |requested_qty x valuation_price| — the movement AS ASKED, before the exchange's step
   * rounding. The meaningful figure on a REJECTED intent, which moved nothing.
   */
  requested_notional_quote: number | null;
  /**
   * |ledger_base_delta x valuation_price| — what actually MOVED THE BOOK, gross of fee. Null
   * when nothing booked.
   *
   * Kept apart from the requested notional because `bookedIntent` stores the UNSNAPPED request
   * in `requested_qty` and moves the ledger by the SNAPPED quantity: on 12/08 a BTC sell asked
   * 0.00079926 and booked 0.00079, so a notional derived from the request overstates the
   * booking by the whole rounding crumb — and that figure is summed per bar and attached to
   * every stop exit and re-entry.
   */
  booked_notional_quote: number | null;
  /** The venue trace: what the exchange did with it. Null when no trace was journaled. */
  venue: {
    traced_at: string | null;
    execution_outcome: string | null;
    executed_qty: number | null;
    exchange_avg_price: number | null;
  } | null;
}

export interface CycleObservation {
  decision_id: number;
  created_at: string;
  status: string;
  skip_reason: string | null;
  prompt_version: string | null;
  model: string | null;
  git_sha: string | null;
  /** The 4h bar this cycle consumed, and where the key came from. */
  bar: {
    key: string | null;
    source: 'regime_journal' | 'transition_observations' | null;
    /** Do the transition rows agree with the journal on the bar? Null when unanswerable. */
    agrees_with_transition: boolean | null;
  };
  context: ControllerContext | null;
  context_unavailable: { reason: string; detail: string } | null;
  book: BookView;
  model_decision: {
    action_type: string | null;
    confidence: string | null;
    clamped: boolean | null;
    clamp_reason: string | null;
    applied_divergence_cause: string | null;
    /** What the model PROPOSED, raw. Null on any cycle without a valid response. */
    raw_target: AllocationView | null;
    /** What the chain RETAINED — the effective target. Null likewise. */
    applied_target: AllocationView | null;
    /** The guard's rule-1 reference (migration 0027). Null on rows predating it. */
    intent_target: AllocationView | null;
  };
  transition: {
    verdicts: TransitionVerdictView[];
    atomic_refusal: boolean | null;
    atomic_trigger_asset: string | null;
  };
  movements: MovementFact[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A cycle whose decision the chain RETAINED — the only rows a DERIVED view may aggregate.
 *
 * `failCycle` stores the refused proposal in `target_allocation` on a `guard_failed` row, and
 * says why in its own comment: it is "evidence, never an input to a later cycle", and
 * production's own reader filters on the status for exactly that reason. A derived view keyed on
 * "has a target" would therefore inflate the decided count, drag a proposal that never became a
 * decision into the per-bar extrema, turn it into an intrabar change of mind, and stop an
 * episode from ever reporting `all_cycles_failed`.
 *
 * The per-cycle audit record keeps the refused proposal, which is the whole point of storing it.
 */
export function isDecided(cycle: CycleObservation): boolean {
  return cycle.status === 'decided' && cycle.model_decision.raw_target != null;
}

/**
 * Turns a journaled allocation into its exposure reading.
 *
 * The exposure is Σ of the non-reserve weights, NOT `100 − reserve`. The two agree whenever
 * the allocation totals 100, which the output schema enforces on every fresh row — and when
 * they disagree, the sum is the honest one: subtracting from a hundred that was never there
 * invents exposure out of a malformed row.
 */
export function allocationView(
  raw: unknown,
  universe: readonly string[],
  reserves: readonly string[],
): AllocationView | null {
  if (!isRecord(raw)) return null;
  const reserveSet = new Set(reserves);
  const universeSet = new Set(universe);
  const allocation: Record<string, number> = {};
  let exposure = ZERO;
  let reserve = ZERO;
  const unknown: string[] = [];
  const unreadable: string[] = [];
  for (const asset of Object.keys(raw).sort()) {
    const weight = numberOrNull(raw[asset] as number | string | null);
    // A KEY THE JOURNAL CARRIES AND NOBODY CAN READ IS NAMED, NEVER DROPPED.
    //
    // Skipping it silently would compute the exposure and the sum from the survivors alone, so a
    // corrupted row would read as a valid, smaller allocation — and it would still satisfy
    // `decided_cycles_carry_both_exposures`, since the view exists. Naming the key is what turns
    // it into the integrity failure it is (`allocations_are_fully_readable`).
    if (weight == null) {
      unreadable.push(asset);
      continue;
    }
    allocation[asset] = weight;
    if (reserveSet.has(asset)) {
      reserve = reserve.plus(weight);
      continue;
    }
    if (!universeSet.has(asset)) unknown.push(asset);
    exposure = exposure.plus(weight);
  }
  return {
    allocation,
    exposure_percent: round(exposure, PERCENT_DP),
    reserve_percent: round(reserve, PERCENT_DP),
    sum_percent: round(exposure.plus(reserve), PERCENT_DP),
    unknown_assets: unknown,
    unreadable_assets: unreadable,
  };
}

/** Reads the virtual portfolio out of the journaled context — the book BEFORE the decision. */
export function bookView(marketContext: unknown): BookView {
  const empty: BookView = {
    exposure_percent: null,
    equity: null,
    cash: null,
    reserve_asset: null,
    positions: [],
    price_stale_assets: [],
    unreadable_qty_assets: [],
    // Nothing was CLAIMED here: no portfolio was journaled at all, which `exposure_percent: null`
    // already says. That is a different fact from a portfolio whose positions cannot be read.
    positions_unreadable: false,
    unreadable_position_entries: 0,
    unreadable_summary_fields: [],
  };
  if (!isRecord(marketContext)) return empty;
  const account = marketContext.account;
  if (!isRecord(account)) return empty;
  const portfolio = account.portfolio;
  if (!isRecord(portfolio)) return empty;

  const positionsUnreadable = !Array.isArray(portfolio.positions);
  const rawPositions = Array.isArray(portfolio.positions) ? portfolio.positions : [];
  const positions: BookPosition[] = [];
  let unreadableEntries = 0;
  for (const entry of rawPositions) {
    // An entry with no usable asset name cannot be published and cannot be named. It is counted,
    // so that a line lost in parsing never passes for a line the book did not hold.
    if (!isRecord(entry) || typeof entry.asset !== 'string' || entry.asset === '') {
      unreadableEntries += 1;
      continue;
    }
    const qty = numberOrNull(entry.qty as number | string | null);
    positions.push({
      asset: entry.asset,
      // NULL stays null. `fromNumeric` would map it to ZERO, publishing a real zero-sized
      // position where the book was simply unreadable.
      qty: qty == null ? null : round(new Decimal(qty), QTY_DP),
      price: numberOrNull(entry.price as number | string | null),
      weight_percent: numberOrNull(entry.weightPercent as number | string | null),
      price_stale: entry.priceStale === true,
    });
  }
  positions.sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));

  const exposure = numberOrNull(portfolio.deployedPercent as number | string | null);
  const equity = numberOrNull(portfolio.equity as number | string | null);
  const cash = numberOrNull(portfolio.cash as number | string | null);
  const reserveAsset = typeof portfolio.reserveAsset === 'string' ? portfolio.reserveAsset : null;

  // The portfolio EXISTS, so each of these was claimed. A null here is therefore a defect, not
  // the "no book journaled" fact the empty view above carries.
  const unreadableSummary: string[] = [];
  if (exposure == null) unreadableSummary.push('deployedPercent');
  if (equity == null) unreadableSummary.push('equity');
  if (cash == null) unreadableSummary.push('cash');
  if (reserveAsset == null) unreadableSummary.push('reserveAsset');

  return {
    exposure_percent: exposure,
    equity,
    cash,
    reserve_asset: reserveAsset,
    positions,
    price_stale_assets: positions.filter((p) => p.price_stale).map((p) => p.asset),
    unreadable_qty_assets: positions.filter((p) => p.qty == null).map((p) => p.asset),
    positions_unreadable: positionsUnreadable,
    unreadable_position_entries: unreadableEntries,
    unreadable_summary_fields: unreadableSummary,
  };
}

function verdictView(row: ObservationRowRead): TransitionVerdictView {
  const hasLeg = row.leg_verdict != null || row.leg_side != null;
  const hasOrder = row.order_verdict != null || row.order_side != null;
  return {
    asset: row.asset,
    written_at: canonicalInstant(row.created_at),
    bar_at: canonicalInstant(row.bar_at),
    actionable: row.actionable,
    gate: row.gate,
    gate_reason: row.gate_reason,
    confirmed_regime: row.confirmed_regime,
    raw_regime: row.raw_regime,
    run_length: row.run_length,
    label_run: row.label_run,
    risk_off: row.risk_off,
    stop: {
      armed: row.stop_armed,
      would_fire: row.stop_would_fire,
      threshold_percent: numberOrNull(row.stop_threshold_percent),
      peak_price: numberOrNull(row.peak_price),
      price: numberOrNull(row.price),
      drawdown_from_peak_percent: numberOrNull(row.drawdown_from_peak_percent),
      abstained_reason: row.stop_abstained_reason,
    },
    leg: hasLeg
      ? {
          side: row.leg_side,
          notional: numberOrNull(row.leg_notional),
          verdict: row.leg_verdict,
          reason: row.leg_reason,
        }
      : null,
    order: hasOrder
      ? {
          side: row.order_side,
          notional: numberOrNull(row.order_notional),
          verdict: row.order_verdict,
          reason: row.order_reason,
        }
      : null,
  };
}

function baseAssetOf(symbol: string): string {
  const base = symbol.split('/')[0];
  return base ?? symbol;
}

/**
 * Pairs each sovereign intent with its venue trace.
 *
 * The intent is the movement the bot RESERVED in its own ledger; the trace is what the
 * exchange did with the order that followed. They are two rows of the same journal (migration
 * 0005) and they answer different questions, so the snapshot keeps both rather than
 * collapsing them into one "executed" flag that would be true for two different reasons.
 */
export function movementsOf(rows: readonly ExecutionRowRead[]): MovementFact[] {
  const intents = rows.filter((row) => row.event_type === 'intent');
  const tracesByIntent = new Map<number, ExecutionRowRead>();
  for (const row of rows) {
    if (row.event_type === 'execution' && row.intent_execution_id != null) {
      tracesByIntent.set(row.intent_execution_id, row);
    }
  }
  return intents
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((intent) => {
      const trace = tracesByIntent.get(intent.id) ?? null;
      const qty = numberOrNull(intent.requested_qty);
      const price = numberOrNull(intent.valuation_price);
      const delta = numberOrNull(intent.ledger_base_delta);
      const booked = intent.validation_status === 'executed';
      return {
        asset: baseAssetOf(intent.symbol),
        symbol: intent.symbol,
        side: intent.side,
        booked_at: canonicalInstant(intent.created_at),
        booked,
        validation_status: intent.validation_status,
        validation_reason: intent.validation_reason,
        requested_qty: qty,
        ledger_base_delta: delta,
        ledger_quote_delta: numberOrNull(intent.ledger_quote_delta),
        valuation_price: price,
        fee: numberOrNull(intent.fee),
        requested_notional_quote:
          qty == null || price == null ? null : round(new Decimal(qty).times(price).abs(), PERCENT_DP),
        // From the LEDGER delta, never the request — the two differ by the exchange's step
        // rounding on every movement that books.
        booked_notional_quote:
          !booked || delta == null || price == null
            ? null
            : round(new Decimal(delta).times(price).abs(), PERCENT_DP),
        venue: trace
          ? {
              traced_at: canonicalInstant(trace.created_at),
              execution_outcome: trace.execution_outcome,
              executed_qty: numberOrNull(trace.executed_qty),
              exchange_avg_price: numberOrNull(trace.exchange_avg_price),
            }
          : null,
      };
    });
}

/**
 * Resolves the cycle's 4h bar, and says where the key came from.
 *
 * The regime journal is authoritative: it is the bar the CONTEXT was computed on, which is
 * the thing every market statistic in this snapshot is aggregated by. The transition rows
 * carry the same bar and are used as a fallback when no regime was journaled — and as a
 * CROSS-CHECK when both exist, because two independent writers agreeing is worth recording
 * and two of them disagreeing is worth shouting about.
 */
export function resolveBar(
  context: ControllerContext | null,
  observations: readonly ObservationRowRead[],
): CycleObservation['bar'] {
  const fromTransition = new Set(
    observations.map((row) => canonicalInstant(row.bar_at)).filter((value): value is string => value != null),
  );
  const transitionKey = fromTransition.size === 1 ? [...fromTransition][0]! : null;

  if (context != null) {
    const agrees = fromTransition.size === 0 ? null : transitionKey === context.bar_at;
    return { key: context.bar_at, source: 'regime_journal', agrees_with_transition: agrees };
  }
  if (transitionKey != null) {
    return { key: transitionKey, source: 'transition_observations', agrees_with_transition: null };
  }
  return { key: null, source: null, agrees_with_transition: null };
}

export interface BuildOptions {
  universe: readonly string[];
  reserves: readonly string[];
}

export function defaultBuildOptions(universe: readonly string[]): BuildOptions {
  return { universe, reserves: reserveStables(config) };
}

/** Builds every cycle of the window, in decision order. */
export function buildCycles(raw: RawWindow, options: BuildOptions): CycleObservation[] {
  const observationsBy = new Map<number, ObservationRowRead[]>();
  for (const row of raw.observations) {
    const list = observationsBy.get(row.decision_id);
    if (list) list.push(row);
    else observationsBy.set(row.decision_id, [row]);
  }
  const executionsBy = new Map<number, ExecutionRowRead[]>();
  for (const row of raw.executions) {
    const list = executionsBy.get(row.decision_id);
    if (list) list.push(row);
    else executionsBy.set(row.decision_id, [row]);
  }

  return raw.decisions
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((decision) => buildCycle(decision, observationsBy.get(decision.id) ?? [], executionsBy.get(decision.id) ?? [], options));
}

export function buildCycle(
  decision: DecisionRowRead,
  observations: readonly ObservationRowRead[],
  executions: readonly ExecutionRowRead[],
  options: BuildOptions,
): CycleObservation {
  const result: ContextResult = contextOf(decision.regime, options.universe);
  const context = result.ok ? result.context : null;
  const sorted = observations
    .slice()
    .sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));

  const book = bookView(decision.market_context);
  /**
   * THE RESERVE THIS CYCLE'S BOOK ACTUALLY NAMED, plus the configured ones.
   *
   * Reading today's quote asset into a historical allocation would treat the cash key of the
   * time as an ordinary coin and add it straight to `exposure_percent` — silently, since
   * `unknown_assets` is published and never rejected. Every cycle journals its own
   * `reserveAsset`; the union keeps a retired cash key and a current one both out of the
   * exposure, and it costs nothing while the two lists agree, which is every cycle so far.
   */
  const reserves =
    book.reserve_asset == null || options.reserves.includes(book.reserve_asset)
      ? options.reserves
      : [...options.reserves, book.reserve_asset].sort();

  const atomic = sorted.find((row) => row.atomic_refusal != null) ?? null;

  return {
    decision_id: decision.id,
    created_at: canonicalInstant(decision.created_at) ?? decision.created_at,
    status: decision.status,
    skip_reason: decision.skip_reason,
    prompt_version: decision.prompt_version,
    model: decision.model,
    git_sha: decision.git_sha,
    bar: resolveBar(context, sorted),
    context,
    context_unavailable: result.ok ? null : { reason: result.reason, detail: result.detail },
    book,
    model_decision: {
      action_type: decision.action_type,
      confidence: decision.confidence,
      clamped: decision.clamped,
      clamp_reason: decision.clamp_reason,
      applied_divergence_cause: decision.applied_divergence_cause,
      raw_target: allocationView(decision.target_allocation, options.universe, reserves),
      applied_target: allocationView(decision.applied_allocation, options.universe, reserves),
      intent_target: allocationView(decision.intent_allocation, options.universe, reserves),
    },
    transition: {
      verdicts: sorted.map(verdictView),
      atomic_refusal: atomic?.atomic_refusal ?? null,
      atomic_trigger_asset: atomic?.atomic_trigger_asset ?? null,
    },
    movements: movementsOf(executions),
  };
}
