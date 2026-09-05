import type { SupabaseClient } from '@supabase/supabase-js';
import { Decimal, toNumericString, ZERO } from '../money.js';
import { runBoundedWrite } from './boundedWrite.js';
import type { LedgerEntry } from './executions.js';
import type { VirtualPortfolio } from '../portfolio/derive.js';
import type { TransitionGate } from '../transition/gate.js';
import type { CorrectionOutcome, LineCause, LineOrigin } from '../exposure/correct.js';

const TABLE = 'exposure_band_corrections';

/**
 * THE FOUR-FACT JOURNAL — one row per (cycle, asset).
 *
 * BEST-EFFORT BY CONTRACT, like every other observational writer in this codebase: it never
 * throws and never fails a cycle. The band must be incapable of changing what the bot does,
 * and a writer that could reject a cycle would be exactly that.
 *
 * Not swallowed either. A lost batch is a real, non-self-healing loss of the evidence the
 * pilot will be read on, so the payload is dumped where it is at least recoverable.
 */

export interface BandCorrectionInsert {
  decision_id: number;
  asset: string;

  raw_weight_percent: number | null;
  clamped_weight_percent: number;
  /**
   * The weight the correction started from — see `CorrectedLine.baseWeightPercent`.
   *
   * It is the one the migration's reconciliation CHECK is written on, because it is the one
   * `correction_points` was measured from. Writing the clamped weight there instead broke
   * every stop-exit cycle's whole batch, silently.
   */
  base_weight_percent: number;
  correction_points: number;
  origin: LineOrigin;
  cause: LineCause;
  corrected_weight_percent: number;

  book_weight_percent: number;
  cap_percent: number;
  gate: TransitionGate | null;
  may_increase: boolean;
  may_decrease: boolean;

  planned_side: 'buy' | 'sell' | null;
  planned_notional_quote: string | null;
  suppressed_reason: string | null;
  suppressed_notional_quote: string | null;

  booked_side: 'buy' | 'sell' | null;
  booked_notional_quote: string | null;
  post_cycle_weight_percent: number | null;
}

export interface ToCorrectionRowsInput {
  decisionId: number;
  correction: CorrectionOutcome;
  gateByAsset: ReadonlyMap<string, TransitionGate>;
  /**
   * FACT 4 — what the cycle REALLY booked. The bot's own movements, not the correction's.
   *
   * In `observation` the two are different by construction: the bot executes its uncorrected
   * target while the correction is only computed. That gap is the measurement, so the two
   * must never be written into the same columns.
   */
  bookedLedger: readonly LedgerEntry[];
  /** The book AFTER this cycle's bookings. Null on a cycle that booked nothing. */
  portfolioAfter: VirtualPortfolio | null;
}

/**
 * Projects one cycle's correction onto its rows. PURE — no I/O, no clock.
 *
 * Separated from the write so the shape can be asserted offline, on fixtures, without a
 * database. The writer below does nothing but send what this returns.
 */
export function toCorrectionRows(input: ToCorrectionRowsInput): BandCorrectionInsert[] {
  const { correction, gateByAsset, bookedLedger, portfolioAfter } = input;

  const plannedByAsset = new Map(correction.movements.map((m) => [m.asset, m]));
  const suppressedByAsset = new Map(correction.suppressed.map((s) => [s.asset, s]));

  // What actually booked on each asset, netted — the same aggregation `observeTransition`
  // does, so "the order this cycle placed" means one thing in both journals.
  const booked = new Map<string, { side: 'buy' | 'sell'; notional: Decimal }>();
  for (const entry of bookedLedger) {
    const asset = entry.symbol.split('/')[0];
    if (!asset) continue;
    const notional = entry.baseDelta.abs().times(entry.valuationPrice);
    const side: 'buy' | 'sell' = entry.baseDelta.gt(0) ? 'buy' : 'sell';
    const prior = booked.get(asset);
    booked.set(
      asset,
      prior && prior.side === side ? { side, notional: prior.notional.plus(notional) } : { side, notional },
    );
  }

  const afterWeights = new Map<string, Decimal>();
  for (const position of portfolioAfter?.positions ?? []) {
    afterWeights.set(position.asset, position.weightPercent);
  }

  return correction.lines.map((line) => {
    const planned = plannedByAsset.get(line.asset) ?? null;
    const dropped = suppressedByAsset.get(line.asset) ?? null;
    const order = booked.get(line.asset) ?? null;
    // A line the post-trade book does not mention is FLAT, not unknown: `derivePortfolio`
    // drops a position once its quantity falls to dust, and that is a real zero. But only when
    // there IS a post-trade book — without one the field stays null rather than claiming the
    // line went flat.
    const after = portfolioAfter == null ? null : (afterWeights.get(line.asset) ?? ZERO);

    return {
      decision_id: input.decisionId,
      asset: line.asset,
      raw_weight_percent: line.rawWeightPercent,
      clamped_weight_percent: line.clampedWeightPercent,
      base_weight_percent: line.baseWeightPercent,
      correction_points: line.correctionPoints,
      origin: line.origin,
      cause: line.cause,
      corrected_weight_percent: line.correctedWeightPercent,
      book_weight_percent: line.bookWeightPercent,
      cap_percent: line.capPercent,
      gate: gateByAsset.get(line.asset) ?? null,
      may_increase: line.mayIncrease,
      may_decrease: line.mayDecrease,
      planned_side: planned?.side ?? null,
      // Money goes to `numeric` as a full-precision string, never as an IEEE-754 float.
      planned_notional_quote: planned == null ? null : toNumericString(planned.notional),
      suppressed_reason: dropped?.reason ?? null,
      suppressed_notional_quote: dropped == null ? null : toNumericString(dropped.notional),
      booked_side: order?.side ?? null,
      booked_notional_quote: order == null ? null : toNumericString(order.notional),
      post_cycle_weight_percent: after == null ? null : Number(after.toFixed(6)),
    };
  });
}

/**
 * HARD DEADLINE on the observational write — the shared mechanism, documented in full in
 * `boundedWrite.ts`: a try/catch only handles the writes that FINISH, so a request Supabase
 * accepts and never settles would burn the cycle budget and let the watchdog force-exit.
 *
 * 5s, the same as the transition observations, for a batch of the same size (four rows).
 */
const WRITE_DEADLINE_MS = 5_000;

/**
 * Writes this cycle's correction rows, one per tradable asset.
 *
 * UPSERT on (decision_id, asset) rather than insert: a retried or duplicated call must not
 * fail on the unique constraint and lose the whole batch over a row that was already correct.
 */
export async function saveBandCorrections(
  supabase: SupabaseClient | null,
  rows: BandCorrectionInsert[],
): Promise<boolean> {
  if (rows.length === 0) return true;
  if (!supabase) {
    console.warn(`[warn] Supabase not configured — ${rows.length} band correction(s) NOT journaled.`);
    return false;
  }
  try {
    await runBoundedWrite(
      (signal) => supabase.from(TABLE).upsert(rows, { onConflict: 'decision_id,asset' }).abortSignal(signal),
      WRITE_DEADLINE_MS,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[CRITICAL] ${rows.length} band correction(s) for decision ${rows[0]!.decision_id} were NOT ` +
        `journaled (${msg}) — the payload follows so it is at least recoverable from the logs.`,
    );
    console.error(JSON.stringify(rows));
    return false;
  }
}
