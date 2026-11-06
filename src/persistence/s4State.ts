import type { SupabaseClient } from '@supabase/supabase-js';
import type { S4CloseEvent, S4Line, S4MoveReason, S4PendingExecution } from '../s4/core.js';

/**
 * THE S4 PILOT'S PERSISTENT STATE (migration 0040). Every read is bounded and every failure is
 * reported as a failure, never as "empty": an S4 cycle that cannot read its state places no
 * order — an empty state would read as "nothing held, everything in", and that is a trade.
 */

const QUERY_TIMEOUT_MS = 10_000;
const signal = (): AbortSignal => AbortSignal.timeout(QUERY_TIMEOUT_MS);

export interface S4Pilot {
  label: string;
  startedAtMs: number | null;
  startDecisionId: number | null;
  ordersEnabled: boolean;
  lastCloseMs: number;
  pending: S4PendingExecution | null;
  blockedCloseAlertedMs: number | null;
}

export type S4StateRead =
  | { ok: true; pilot: S4Pilot; lines: S4Line[] }
  | { ok: false; reason: string };

const ms = (v: unknown): number | null => (v == null ? null : Date.parse(String(v)));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const isoOrNull = (v: number | null): string | null => (v == null ? null : new Date(v).toISOString());

export async function readS4State(supabase: SupabaseClient, assets: readonly string[]): Promise<S4StateRead> {
  try {
    const [pilotRes, linesRes] = await Promise.all([
      supabase.from('s4_pilot').select('*').eq('id', 1).abortSignal(signal()).maybeSingle(),
      supabase.from('s4_line_state').select('*').abortSignal(signal()),
    ]);
    if (pilotRes.error) return { ok: false, reason: `s4_pilot : ${pilotRes.error.message}` };
    if (linesRes.error) return { ok: false, reason: `s4_line_state : ${linesRes.error.message}` };
    const p = pilotRes.data as Record<string, unknown> | null;
    if (!p) return { ok: false, reason: 'aucun pilote S4 (s4_pilot vide) — état non initialisé' };
    const rows = (linesRes.data ?? []) as Array<Record<string, unknown>>;
    const byAsset = new Map(rows.map((r) => [String(r.asset), r]));
    const missing = assets.filter((a) => !byAsset.has(a));
    if (missing.length > 0) return { ok: false, reason: `état S4 absent pour ${missing.join(', ')}` };
    const extra = rows.map((r) => String(r.asset)).filter((a) => !assets.includes(a));
    if (extra.length > 0) return { ok: false, reason: `état S4 pour des actifs hors univers : ${extra.join(', ')}` };
    const lines: S4Line[] = assets.map((asset) => {
      const r = byAsset.get(asset)!;
      return {
        asset,
        status: r.status === 'out' ? 'out' : 'in',
        entryAtMs: ms(r.entry_at),
        high: num(r.high),
        exitAtMs: ms(r.exit_at),
        armed: r.armed === true,
        entryPrice: num(r.entry_price),
        lastMoveReason: (r.last_move_reason as S4MoveReason | null) ?? null,
        lastMoveAtMs: ms(r.last_move_at),
      };
    });
    return {
      ok: true,
      pilot: {
        label: String(p.label),
        startedAtMs: ms(p.started_at),
        startDecisionId: num(p.start_decision_id),
        ordersEnabled: p.orders_enabled === true,
        lastCloseMs: ms(p.last_close_at)!,
        pending: (p.pending_execution as S4PendingExecution | null) ?? null,
        blockedCloseAlertedMs: ms(p.blocked_close_alerted),
      },
      lines,
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function lineRow(l: S4Line, daysOut: number | null): Record<string, unknown> {
  return {
    asset: l.asset,
    status: l.status,
    entry_at: isoOrNull(l.entryAtMs),
    entry_price: l.entryPrice,
    high: l.high,
    exit_at: isoOrNull(l.exitAtMs),
    days_out: daysOut,
    armed: l.armed,
    last_move_reason: l.lastMoveReason,
    last_move_at: isoOrNull(l.lastMoveAtMs),
  };
}

/**
 * Consumes the closes: lines, journal and last close in one transaction, conditioned on the
 * last close this cycle read. `false` = someone else consumed them (or the condition failed):
 * the caller must place no order.
 */
export async function commitCloses(
  supabase: SupabaseClient,
  params: { expectedLastCloseMs: number; newLastCloseMs: number; lines: S4Line[]; daysOut: Record<string, number | null>; events: S4CloseEvent[]; gitSha: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { data, error } = await supabase
      .rpc('s4_commit_closes', {
        p_expected_last_close: new Date(params.expectedLastCloseMs).toISOString(),
        p_new_last_close: new Date(params.newLastCloseMs).toISOString(),
        p_lines: params.lines.map((l) => lineRow(l, params.daysOut[l.asset] ?? null)),
        p_journal: params.events.map((e) => ({
          close_at: new Date(e.closeMs).toISOString(),
          asset: e.asset,
          event: e.kind,
          close: e.close,
          sma50: e.sma50,
          status_before: e.statusBefore,
          status_after: e.statusAfter,
          high_before: e.highBefore,
          high_after: e.highAfter,
          threshold_price: e.thresholdPrice,
          armed_after: e.armedAfter,
          days_out: e.daysOut,
        })),
        p_git_sha: params.gitSha,
      })
      .abortSignal(signal());
    if (error) return { ok: false, reason: error.message };
    if (data !== true) return { ok: false, reason: 'la dernière clôture a changé depuis la lecture (déjà consommée)' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Writes lines outside a close (entries after fills, repairs). Returns whether it landed. */
export async function saveLines(supabase: SupabaseClient, lines: S4Line[], daysOut: Record<string, number | null>): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('s4_line_state')
      .upsert(lines.map((l) => ({ ...lineRow(l, daysOut[l.asset] ?? null), updated_at: new Date().toISOString() })), { onConflict: 'asset' })
      .abortSignal(signal());
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[s4] line state write failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export async function setPending(supabase: SupabaseClient, pending: S4PendingExecution | null): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('s4_pilot')
      .update({ pending_execution: pending, updated_at: new Date().toISOString() })
      .eq('id', 1)
      .abortSignal(signal());
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error(`[s4] pending execution write failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** The pilot's identity, written once by its first cycle (`started_at is null` guards it). */
export async function markPilotStarted(
  supabase: SupabaseClient,
  params: { decisionId: number; gitSha: string | null; startingEquityUsd: number; atMs: number },
): Promise<void> {
  try {
    const { error } = await supabase
      .from('s4_pilot')
      .update({
        started_at: new Date(params.atMs).toISOString(),
        start_decision_id: params.decisionId,
        start_git_sha: params.gitSha,
        starting_equity_usd: params.startingEquityUsd,
        updated_at: new Date().toISOString(),
      })
      .eq('id', 1)
      .is('started_at', null)
      .abortSignal(signal());
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`[s4] pilot identity write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function markBlockedCloseAlerted(supabase: SupabaseClient, closeMs: number): Promise<void> {
  try {
    await supabase
      .from('s4_pilot')
      .update({ blocked_close_alerted: new Date(closeMs).toISOString() })
      .eq('id', 1)
      .abortSignal(signal());
  } catch {
    // Debounce only: a lost write means the alert may repeat once, nothing more.
  }
}

/** Links the journal rows of the closes this cycle decided to its decision row (best-effort). */
export async function linkCloseDecisions(supabase: SupabaseClient, closesMs: number[], decisionId: number): Promise<void> {
  if (closesMs.length === 0) return;
  try {
    await supabase
      .from('s4_close_decisions')
      .update({ decision_id: decisionId })
      .in('close_at', closesMs.map((c) => new Date(c).toISOString()))
      .is('decision_id', null)
      .abortSignal(signal());
  } catch {
    // The journal row stands on its own (close, asset, git SHA); the link is a convenience.
  }
}
