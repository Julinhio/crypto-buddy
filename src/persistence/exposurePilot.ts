import type { SupabaseClient } from '@supabase/supabase-js';
import { runBoundedWrite } from './boundedWrite.js';
import type { PilotIdentity, PilotStatus, PilotWrite } from '../exposure/pilot.js';

/**
 * THE PILOT'S IDENTITY, READ AND WRITTEN — the one durable thing the trading path depends on.
 *
 * Every other observational writer in this codebase is best-effort by design: it may miss, and
 * the cycle carries on. This one is different in kind, because the correction is not allowed to
 * touch an order unless its identity is known and its high-water mark is recorded. So a miss
 * here does not degrade a journal — it DISARMS THE CORRECTION for the cycle, which is exactly
 * the arbitrated posture: "if the mandatory read or write of the identity, the peak or the
 * circuit breaker fails, the correction does not apply in that cycle. The normal bot continues
 * and the failure is journaled."
 *
 * Both paths are therefore BOUNDED by the same deadline mechanism as the rest. A Supabase
 * request that never settles must not burn the cycle budget and let the watchdog force-exit
 * after the orders were placed — the failure mode `boundedWrite.ts` exists to remove.
 */

const TABLE = 'exposure_pilot';

/** The same 5 seconds the other bounded writers use. A trading cycle cannot wait longer. */
export const PILOT_DEADLINE_MS = 5000;

const COLUMNS =
  'id, contract_sha256, contract_version, band_version, status, activated_at, ' +
  'activated_decision_id, opening_equity_usd, peak_equity_usd, alert_drawdown_at, ' +
  'last_seen_decision_id';

interface PilotRow {
  id: number;
  contract_sha256: string;
  contract_version: string;
  band_version: string;
  status: string;
  activated_at: string;
  activated_decision_id: number | null;
  opening_equity_usd: string | number;
  peak_equity_usd: string | number;
  alert_drawdown_at: string | null;
  last_seen_decision_id: number | null;
}

/**
 * "No pilot yet" and "the read failed" are NOT the same answer, and folding them would be the
 * worst bug this brick could ship: an unreadable identity would look like an empty table, and
 * the next cycle would ACTIVATE a second pilot over the top of a running one.
 *
 * The database refuses that with its singleton index. This type refuses it one level earlier.
 */
export type PilotRead =
  | { ok: true; identity: PilotIdentity | null }
  | { ok: false; reason: string };

const KNOWN_STATUS: ReadonlySet<string> = new Set<PilotStatus>([
  'active',
  'stopped_drawdown',
  'invalidated_contract',
]);

export async function readPilotIdentity(supabase: SupabaseClient | null): Promise<PilotRead> {
  if (!supabase) return { ok: false, reason: 'supabase is not configured' };
  let rows: PilotRow[] | null = null;
  try {
    await runBoundedWrite(async (signal) => {
      const res = await supabase.from(TABLE).select(COLUMNS).order('id', { ascending: true }).limit(2).abortSignal(signal);
      rows = res.data as unknown as PilotRow[] | null;
      return { error: res.error };
    }, PILOT_DEADLINE_MS);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const found: PilotRow[] = rows ?? [];
  if (found.length === 0) return { ok: true, identity: null };
  if (found.length > 1) {
    // Unreachable while the singleton index stands. Reported rather than resolved: picking one
    // of two identities is a judgement no code should make about an eight-week experiment.
    return { ok: false, reason: `${found.length} pilot identities exist — refusing to choose` };
  }
  const row = found[0]!;
  if (!KNOWN_STATUS.has(row.status)) {
    return { ok: false, reason: `unknown pilot status "${row.status}"` };
  }
  const opening = Number(row.opening_equity_usd);
  const peak = Number(row.peak_equity_usd);
  if (!Number.isFinite(opening) || !Number.isFinite(peak)) {
    return { ok: false, reason: 'the pilot carries an unusable equity' };
  }
  return {
    ok: true,
    identity: {
      contractSha256: row.contract_sha256,
      contractVersion: row.contract_version,
      status: row.status as PilotStatus,
      activatedAt: row.activated_at,
      activatedDecisionId: row.activated_decision_id,
      openingEquityQuote: opening,
      peakEquityQuote: peak,
      alertDrawdownAt: row.alert_drawdown_at,
      lastSeenDecisionId: row.last_seen_decision_id,
    },
  };
}

export interface PilotWriteContext {
  decisionId: number | null;
  equityQuote: number;
  contractSha256: string;
  contractVersion: string;
  bandVersion: string;
  now: Date;
}

/**
 * Lands one durable change, or reports that it did not.
 *
 * Returns a boolean rather than throwing, because every caller does the same thing with a
 * failure — disarm the correction for this cycle and journal why — and an exception on the
 * trading path is a worse way to say it.
 */
export async function applyPilotWrite(
  supabase: SupabaseClient | null,
  write: PilotWrite,
  ctx: PilotWriteContext,
): Promise<{ ok: boolean; reason: string | null }> {
  if (!supabase) return { ok: false, reason: 'supabase is not configured' };
  const stamp = ctx.now.toISOString();
  try {
    await runBoundedWrite(async (signal) => {
      if (write.kind === 'activation') {
        // THE OFFICIAL INSTANT, spent exactly once. An INSERT, never an upsert: if a row
        // already exists the singleton index refuses this outright, which is the behaviour we
        // want — a second activation must fail loudly, not overwrite the first.
        return supabase
          .from(TABLE)
          .insert({
            contract_sha256: ctx.contractSha256,
            contract_version: ctx.contractVersion,
            band_version: ctx.bandVersion,
            activated_at: stamp,
            activated_decision_id: ctx.decisionId,
            opening_equity_usd: write.openingEquityQuote,
            peak_equity_usd: write.peakEquityQuote,
            peak_decision_id: ctx.decisionId,
            status: 'active',
          })
          .abortSignal(signal);
      }

      const patch: Record<string, unknown> = { updated_at: stamp };
      if (write.kind === 'peak' || write.kind === 'alert_drawdown' || write.kind === 'stop_drawdown') {
        patch.peak_equity_usd = write.peakEquityQuote;
        patch.peak_decision_id = ctx.decisionId;
      }
      if (write.kind === 'alert_drawdown') {
        patch.alert_drawdown_at = stamp;
        patch.alert_drawdown_decision_id = ctx.decisionId;
        patch.alert_drawdown_percent = write.drawdownPercent;
        patch.alert_drawdown_equity_usd = ctx.equityQuote;
      }
      if (write.kind === 'stop_drawdown') {
        patch.status = 'stopped_drawdown';
        patch.stopped_at = stamp;
        patch.stopped_decision_id = ctx.decisionId;
        patch.stopped_drawdown_percent = write.drawdownPercent;
        patch.stopped_equity_usd = ctx.equityQuote;
      }
      if (write.kind === 'interrupt_mode') {
        patch.status = 'interrupted_mode';
        patch.interrupted_at = stamp;
        patch.interrupted_decision_id = ctx.decisionId;
        patch.interrupted_after_decision_id = write.latestDecidedDecisionId;
        patch.interrupted_seen_decision_id = write.lastSeenDecisionId;
      }
      if (write.kind === 'invalidate_contract') {
        patch.status = 'invalidated_contract';
        patch.invalidated_at = stamp;
        patch.invalidated_decision_id = ctx.decisionId;
        patch.invalidated_seen_sha256 = write.seenSha256;
      }
      // Scoped to the ACTIVE row. A pilot already stopped or invalidated must never be moved
      // by a later cycle — the terminal states are terminal.
      return supabase.from(TABLE).update(patch).eq('status', 'active').abortSignal(signal);
    }, PILOT_DEADLINE_MS);
    return { ok: true, reason: null };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Records that the one-shot 40% alert really left. Best-effort: a miss is visible, not fatal. */
export async function markDrawdownAlertDelivered(supabase: SupabaseClient | null): Promise<void> {
  if (!supabase) return;
  try {
    await runBoundedWrite(
      (signal) =>
        supabase
          .from(TABLE)
          .update({ alert_drawdown_delivered: true })
          .not('alert_drawdown_at', 'is', null)
          .abortSignal(signal),
      PILOT_DEADLINE_MS,
    );
  } catch (err) {
    console.warn(`[warn] could not record the pilot drawdown alert as delivered — ${String(err)}`);
  }
}

/** Persists the closure of the MEASUREMENT window. Never touches `status`: the band keeps running. */
export async function closeMeasurementWindow(
  supabase: SupabaseClient | null,
  input: {
    label: string;
    decisionId: number | null;
    constructiveBars: number;
    nonConstructiveBars: number;
    now: Date;
  },
): Promise<void> {
  if (!supabase) return;
  try {
    await runBoundedWrite(
      (signal) =>
        supabase
          .from(TABLE)
          .update({
            window_closed_at: input.now.toISOString(),
            window_closed_decision_id: input.decisionId,
            window_closure_label: input.label,
            window_constructive_bars: input.constructiveBars,
            window_non_constructive_bars: input.nonConstructiveBars,
            updated_at: input.now.toISOString(),
          })
          .is('window_closed_at', null)
          .abortSignal(signal),
      PILOT_DEADLINE_MS,
    );
  } catch (err) {
    console.warn(`[warn] could not close the pilot measurement window — ${String(err)}`);
  }
}

/**
 * THE NEWEST DECIDED CYCLE THE JOURNAL HOLDS.
 *
 * Read before this cycle's own row exists, so it names the PREVIOUS decided cycle. Compared
 * against the pilot's `last_seen_decision_id`, it is what makes an interruption provable: a
 * decided cycle more recent than the one the pilot saw can only exist if the pilot did not run
 * on it. Null on a failed read, which fails closed rather than skipping the check.
 *
 * Only `decided` rows count. A skipped or errored cycle decides nothing, never reaches the
 * pilot's block and moves no order, so its presence is not a hole in anything.
 */
export async function readLatestDecidedDecisionId(
  supabase: SupabaseClient | null,
): Promise<number | null> {
  if (!supabase) return null;
  let latest: number | null = null;
  try {
    await runBoundedWrite(async (signal) => {
      const res = await supabase
        .from('decisions')
        .select('id')
        .eq('status', 'decided')
        .order('id', { ascending: false })
        .limit(1)
        .abortSignal(signal);
      const rows = (res.data ?? []) as Array<{ id: number }>;
      latest = rows[0]?.id ?? null;
      return { error: res.error };
    }, PILOT_DEADLINE_MS);
  } catch {
    return null;
  }
  return latest;
}

/**
 * THE HEARTBEAT. Records that this pilot saw this decided cycle.
 *
 * Written on EVERY cycle the pilot runs on, whether or not the correction applied, because the
 * absence of this mark is exactly what the next cycle reads as an interruption. A write that
 * does not land therefore ends the pilot on the following cycle — conservative on purpose: a
 * cycle the pilot cannot prove it saw is a cycle whose peak it cannot vouch for.
 */
export async function markPilotSawDecision(
  supabase: SupabaseClient | null,
  decisionId: number,
): Promise<void> {
  if (!supabase) return;
  try {
    await runBoundedWrite(
      (signal) =>
        supabase
          .from(TABLE)
          .update({ last_seen_decision_id: decisionId })
          .eq('status', 'active')
          .abortSignal(signal),
      PILOT_DEADLINE_MS,
    );
  } catch (err) {
    console.warn(`[warn] the pilot could not record the cycle it saw — ${String(err)}`);
  }
}

/**
 * Fills in the decision the activation happened on.
 *
 * The identity is written BEFORE the decision row exists — that row has to carry the corrected
 * target, so it cannot come first — which leaves the pointer null for the length of one cycle.
 * The INSTANT is durable from the start and is what the window is defined on; this is a
 * convenience for the replay, so it is best-effort and it only ever fills a hole.
 */
export async function backfillActivationDecision(
  supabase: SupabaseClient | null,
  decisionId: number,
): Promise<void> {
  if (!supabase) return;
  try {
    await runBoundedWrite(
      (signal) =>
        supabase
          .from(TABLE)
          .update({ activated_decision_id: decisionId, peak_decision_id: decisionId, last_seen_decision_id: decisionId })
          .is('activated_decision_id', null)
          .abortSignal(signal),
      PILOT_DEADLINE_MS,
    );
  } catch (err) {
    console.warn(`[warn] could not backfill the pilot's activation decision — ${String(err)}`);
  }
}
