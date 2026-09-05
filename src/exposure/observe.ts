import { readContext, type BandPolicy, type ControllerReading } from '../calibration/exposure/controller.js';
import type { RegimePoint } from '../market/regime.js';
import type { TransitionGate } from '../transition/gate.js';
import { assessBand, type BandAssessment } from './band.js';

/**
 * ONE CYCLE, ONE OBSERVATION ROW — pure, total, and incapable of failing a wake-up.
 *
 * `band.ts` does the arithmetic. This file does the two things that stand between a cycle
 * and that arithmetic: reading the context through production's own `readContext`, and
 * deciding what to record when one of the inputs is simply not there.
 *
 * ── A CYCLE NEVER DROPS OUT OF THE POPULATION ──────────────────────────────────────────
 *
 * A wake-up that failed still passed through a 4h bar, and that bar still had a context. The
 * closure protocol counts bars, not successes, so a row is produced for EVERY cycle that got
 * far enough to have a decision id — with null targets where there was no target, and a named
 * reason where there was no context. A population that quietly kept only the cycles that
 * worked would flatter every rate computed on it, and would make "how often does the model
 * fail to answer" unreadable in the very journal built to read the model.
 *
 * ── AN ABSENT CONTEXT IS NEVER A NEUTRAL ONE ───────────────────────────────────────────
 *
 * `no_regime_journaled` and `unclassifiable_regime` are recorded as themselves. Folding
 * either into `neutral` would put bars the bot could not read into the family whose count
 * decides when the pilot closes — inflating the non-constructive side with absence.
 */

/** Why a cycle carries no band assessment. Null when it carries one. */
export type BandObservationGap =
  /** The cycle journaled no regime — no usable 4h series, or no closed bar in common. */
  | 'no_regime'
  /**
   * `readContext` refused a regime label its table does not classify. It THROWS on purpose:
   * a new regime silently counted as neutral would move every boundary for months. Caught
   * here so the refusal becomes a recorded fact instead of a dead trading cycle.
   */
  | 'unclassifiable_regime'
  /** The cycle produced no target: skipped, errored, unparseable, or refused by the guard. */
  | 'no_target';

/**
 * The row, exactly as it lands in `exposure_band_observations`.
 *
 * Snake_case because it is a database row and nothing else — no consumer in the codebase
 * reads this shape as a domain object, and a camelCase mirror would be one more place for the
 * two spellings to drift.
 */
export interface BandObservationInsert {
  decision_id: number;
  mode: string;
  policy_version: string;

  /** The 4h bar the context was computed on. Null when there was no regime. */
  bar_at: string | null;
  state: ControllerReading['state'] | null;
  risk_off: boolean | null;
  net_breadth: number | null;
  bullish: number | null;
  bearish: number | null;
  neutral: number | null;
  unavailable: number | null;
  /**
   * A stable digest of everything that determines the state, for the per-bar integrity check.
   *
   * The WHOLE reading, not a chosen handful of its fields: two opposite drifts inside one bar
   * cancel in the aggregates (BTC up with ETH down, then the reverse) and would pass a
   * fingerprint built on counts alone. Same reasoning as the observer's `contextFingerprint`.
   */
  context_fingerprint: string | null;
  universe: string[];

  band_low_percent: number | null;
  band_high_percent: number | null;

  raw_exposure_percent: number | null;
  target_exposure_percent: number | null;
  target_sum_percent: number | null;
  book_exposure_percent: number | null;
  stopped_weight_percent: number | null;

  direction: string | null;
  required_exposure_percent: number | null;
  required_points: number | null;
  attainable_exposure_percent: number | null;
  unrealisable_points: number | null;
  label: string | null;

  /**
   * FALSE when the transition layer produced no verdict at all for this cycle — see
   * `BandFeasibility.known`. Every feasibility column below is then null, and the label keeps
   * to the direction rather than asserting the freezes blocked a correction nobody recorded.
   */
  feasibility_known: boolean | null;
  increasable_assets: string[];
  decreasable_assets: string[];
  unjudged_assets: string[];
  reserved_up_percent: number | null;
  reserved_down_percent: number | null;
  max_reachable_percent: number | null;
  min_reachable_percent: number | null;

  attainable_notional_quote: number | null;
  movement_floor_quote: number | null;
  clears_movement_floor: boolean | null;

  // ── the CORRECTION's vector-level result (brick 2) ─────────────────────────────
  //
  // Null on a cycle with no assessment, and on one where the band had nothing to correct.
  /** FACT 3 at the vector level — Σ of the corrected non-reserve weights. */
  corrected_exposure_percent: number | null;
  /** FACT 4's counterpart: what the BOOK would hold once the 2% floor has had its say. */
  realised_exposure_percent: number | null;
  /**
   * Points still outside the band once the freezes, the caps AND the plumbing are through.
   *
   * Kept apart from `unrealisable_points`, which counts only the first two. Their difference
   * is exactly the share of the gap the movement floor is responsible for, and one merged
   * column would make that attribution underivable.
   */
  realised_gap_points: number | null;
  consolidated: boolean | null;
  consolidation_rounds: number | null;
  consolidation_attempts: number | null;
  planned_movements: number | null;
  suppressed_movements: number | null;

  /** Per-asset detail: weight, gate, and what the correction would be allowed to do. */
  lines: unknown;

  gap: BandObservationGap | null;
  gap_detail: string | null;
}

export interface ObserveBandInput {
  decisionId: number;
  mode: string;
  policyVersion: string;
  policy: BandPolicy;
  /** Production's own point for this cycle. Null when no regime was computed. */
  regimePoint: RegimePoint | null;
  /** The controller's universe — the allocatable assets, which is the breadth denominator. */
  universe: readonly string[];
  /** The risk-clamped target the chain retained. Null on a cycle that produced none. */
  targetAllocation: Record<string, number> | null;
  rawAllocation: Record<string, number> | null;
  bookExposurePercent: number | null;
  reserveAsset: string;
  gateByAsset: ReadonlyMap<string, TransitionGate>;
  capOf: (asset: string) => number;
  maxDeployablePercent: number;
  equityQuote: number;
  movementFloorQuote: number;
  stoppedWeightSurvives: boolean;
}

/**
 * The fingerprint of a controller reading — the whole reading, in a fixed key order.
 *
 * Built here rather than by `JSON.stringify(reading)` so the order is this file's decision
 * and not the order `readContext` happens to construct its object in. A digest whose bytes
 * depended on a construction site elsewhere would compare unequal the day that site was
 * reordered, and the per-bar integrity check would fail on a refactor.
 */
export function fingerprintOf(reading: ControllerReading, universe: readonly string[]): string {
  return JSON.stringify({
    universe: [...universe].sort(),
    state: reading.state,
    riskOff: reading.riskOff,
    netBreadth: reading.netBreadth,
    bullish: reading.bullish,
    bearish: reading.bearish,
    neutral: reading.neutral,
    unavailable: reading.unavailable,
  });
}

/** The empty row for a cycle with no assessment — every band field null, the gap named. */
function withoutAssessment(
  input: ObserveBandInput,
  reading: ControllerReading | null,
  gap: BandObservationGap,
  detail: string,
): BandObservationInsert {
  return {
    decision_id: input.decisionId,
    mode: input.mode,
    policy_version: input.policyVersion,
    bar_at: input.regimePoint == null ? null : new Date(input.regimePoint.timestamp).toISOString(),
    state: reading?.state ?? null,
    risk_off: reading?.riskOff ?? null,
    net_breadth: reading?.netBreadth ?? null,
    bullish: reading?.bullish ?? null,
    bearish: reading?.bearish ?? null,
    neutral: reading?.neutral ?? null,
    unavailable: reading?.unavailable ?? null,
    context_fingerprint: reading == null ? null : fingerprintOf(reading, input.universe),
    universe: [...input.universe],
    band_low_percent: null,
    band_high_percent: null,
    raw_exposure_percent: null,
    target_exposure_percent: null,
    target_sum_percent: null,
    book_exposure_percent: input.bookExposurePercent,
    stopped_weight_percent: null,
    direction: null,
    required_exposure_percent: null,
    required_points: null,
    attainable_exposure_percent: null,
    unrealisable_points: null,
    label: null,
    feasibility_known: null,
    increasable_assets: [],
    decreasable_assets: [],
    unjudged_assets: [],
    reserved_up_percent: null,
    reserved_down_percent: null,
    max_reachable_percent: null,
    min_reachable_percent: null,
    attainable_notional_quote: null,
    movement_floor_quote: null,
    clears_movement_floor: null,
    corrected_exposure_percent: null,
    realised_exposure_percent: null,
    realised_gap_points: null,
    consolidated: null,
    consolidation_rounds: null,
    consolidation_attempts: null,
    planned_movements: null,
    suppressed_movements: null,
    lines: null,
    gap,
    gap_detail: detail,
  };
}

/** The full row for a cycle that had both a context and a target. */
function withAssessment(
  input: ObserveBandInput,
  reading: ControllerReading,
  assessment: BandAssessment,
): BandObservationInsert {
  return {
    decision_id: input.decisionId,
    mode: input.mode,
    policy_version: input.policyVersion,
    bar_at: new Date(input.regimePoint!.timestamp).toISOString(),
    state: reading.state,
    risk_off: reading.riskOff,
    net_breadth: reading.netBreadth,
    bullish: reading.bullish,
    bearish: reading.bearish,
    neutral: reading.neutral,
    unavailable: reading.unavailable,
    context_fingerprint: fingerprintOf(reading, input.universe),
    universe: [...input.universe],
    band_low_percent: assessment.band.lowPercent,
    band_high_percent: assessment.band.highPercent,
    raw_exposure_percent: assessment.rawExposurePercent,
    target_exposure_percent: assessment.targetExposurePercent,
    target_sum_percent: assessment.targetSumPercent,
    book_exposure_percent: assessment.bookExposurePercent,
    stopped_weight_percent: assessment.stoppedWeightPercent,
    direction: assessment.direction,
    required_exposure_percent: assessment.requiredExposurePercent,
    required_points: assessment.requiredPoints,
    attainable_exposure_percent: assessment.feasibility.attainableExposurePercent,
    unrealisable_points: assessment.feasibility.unrealisablePoints,
    label: assessment.label,
    feasibility_known: assessment.feasibility.known,
    increasable_assets: assessment.feasibility.increasableAssets,
    decreasable_assets: assessment.feasibility.decreasableAssets,
    unjudged_assets: assessment.feasibility.unjudgedAssets,
    reserved_up_percent: assessment.feasibility.reservedUpPercent,
    reserved_down_percent: assessment.feasibility.reservedDownPercent,
    max_reachable_percent: assessment.feasibility.maxReachablePercent,
    min_reachable_percent: assessment.feasibility.minReachablePercent,
    attainable_notional_quote: assessment.attainableNotionalQuote,
    movement_floor_quote: assessment.movementFloorQuote,
    clears_movement_floor: assessment.clearsMovementFloor,
    // Filled by the CALLER once the correction has run — the redistribution is a separate
    // brick, and this file has no business computing it.
    corrected_exposure_percent: null,
    realised_exposure_percent: null,
    realised_gap_points: null,
    consolidated: null,
    consolidation_rounds: null,
    consolidation_attempts: null,
    planned_movements: null,
    suppressed_movements: null,
    lines: assessment.lines,
    gap: null,
    gap_detail: null,
  };
}

/**
 * One cycle's observation: the database row, and the ASSESSMENT it was built from.
 *
 * The assessment travels with the row rather than being reconstructed from it. Rebuilding a
 * typed object out of a persisted row means writing a second constructor for it — one that
 * cannot be type-checked against the first, and that would silently drift the day a field
 * changes shape. The correction needs the real object; it gets the real object.
 */
export interface BandObservation {
  row: BandObservationInsert;
  /** Null exactly when the row carries a `gap` — there was nothing to assess. */
  assessment: BandAssessment | null;
}

/**
 * Builds one cycle's observation. PURE and TOTAL — it never throws.
 *
 * Totality is the safety property, not a nicety: this runs on a live trading path, and an
 * exception here would turn an observational component into one capable of killing a wake-up.
 * The only thing that can throw underneath is `readContext`, and its throw is DELIBERATE (an
 * unclassified regime must never fall through to a default), so it is caught and recorded
 * rather than suppressed.
 */
export function observeBand(input: ObserveBandInput): BandObservation {
  if (input.regimePoint == null) {
    return {
      row: withoutAssessment(
        input,
        null,
        'no_regime',
        'the cycle computed no regime — no usable 4h series, or no closed bar in common across the pairs',
      ),
      assessment: null,
    };
  }

  let reading: ControllerReading;
  try {
    reading = readContext(input.regimePoint, input.universe);
  } catch (err) {
    return {
      row: withoutAssessment(
        input,
        null,
        'unclassifiable_regime',
        err instanceof Error ? err.message : String(err),
      ),
      assessment: null,
    };
  }

  if (input.targetAllocation == null) {
    return {
      row: withoutAssessment(
        input,
        reading,
        'no_target',
        'the cycle produced no retained target — skipped, errored, unparseable, or refused by the guard',
      ),
      assessment: null,
    };
  }

  const assessment = assessBand({
    policyVersion: input.policyVersion,
    policy: input.policy,
    state: reading.state,
    targetAllocation: input.targetAllocation,
    rawAllocation: input.rawAllocation,
    bookExposurePercent: input.bookExposurePercent,
    reserveAsset: input.reserveAsset,
    gateByAsset: input.gateByAsset,
    capOf: input.capOf,
    maxDeployablePercent: input.maxDeployablePercent,
    equityQuote: input.equityQuote,
    movementFloorQuote: input.movementFloorQuote,
    stoppedWeightSurvives: input.stoppedWeightSurvives,
  });

  return { row: withAssessment(input, reading, assessment), assessment };
}

/**
 * THE PER-BAR INTEGRITY CHECK — and it FAILS, it does not report.
 *
 * The bot wakes three to seven times inside one 4h bar. The context is computed on the CLOSED
 * bar, so those wake-ups must share one state, one breadth, one `risk_off`. The closure
 * protocol makes the FIRST cycle of a bar the unit of analysis; that convention is only sound
 * if the others agree with it. A first cycle that silently masked a disagreement would let the
 * pilot count a bar in one family while the bot spent most of it in the other.
 *
 * Verified on the real v5 history before this was written: 246 bars, 901 cycles carrying a
 * regime, zero unstable bars. So this is not a tolerance — it is an invariant that currently
 * holds, and the run stops if it ever stops holding.
 *
 * Cycles with NO fingerprint (no regime, unclassifiable regime) are not compared: they carry
 * no context to disagree with. They are counted separately by the caller, never as neutral.
 */
export interface BarIntegrityFinding {
  barAt: string;
  decisionIds: number[];
  fingerprints: string[];
}

export function checkBarIntegrity(
  rows: ReadonlyArray<Pick<BandObservationInsert, 'decision_id' | 'bar_at' | 'context_fingerprint'>>,
): BarIntegrityFinding[] {
  const byBar = new Map<string, { ids: number[]; prints: Set<string> }>();
  for (const row of rows) {
    if (row.bar_at == null || row.context_fingerprint == null) continue;
    const bucket = byBar.get(row.bar_at) ?? { ids: [], prints: new Set<string>() };
    bucket.ids.push(row.decision_id);
    bucket.prints.add(row.context_fingerprint);
    byBar.set(row.bar_at, bucket);
  }
  const findings: BarIntegrityFinding[] = [];
  for (const [barAt, bucket] of [...byBar.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (bucket.prints.size <= 1) continue;
    findings.push({
      barAt,
      decisionIds: [...bucket.ids].sort((a, b) => a - b),
      fingerprints: [...bucket.prints].sort(),
    });
  }
  return findings;
}
