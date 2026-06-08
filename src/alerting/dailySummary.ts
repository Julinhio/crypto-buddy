/**
 * The DAILY Telegram summary — a once-a-day overview (capital, variation, allocation,
 * activity), even on days without a trade. Distinct from the anomaly alerts and the
 * event-driven activity notification (PR #16): this one is TIME-triggered.
 *
 * Trigger: the beat runs every 5 min, so the "once per local day" idempotence lives
 * in the DB. On each beat, if it is past the send-hour in Julien's local timezone AND
 * `claim_daily_summary(localDate)` wins (an atomic conditional UPDATE on the bot_state
 * date mark — exactly one beat per day wins), we gather and send. So a bot that was
 * down at 9h still sends at the first beat after, and twenty beats after 9h send once.
 *
 * Same posture as the rest of observability: built from EXISTING sources (equity
 * snapshots, bot_state, scheduler_runs, executions), sent best-effort OUTSIDE the
 * fenced cycle (this whole path is wrapped so it NEVER throws into the beat), with
 * bounded reads + the Telegram timeout. Variation is measured at the PORTFOLIO level,
 * never per trade.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { sendTelegram } from './telegram.js';
import { formatAllocation, orderedAllocation, type AllocationSlice } from './allocation.js';

const READ_TIMEOUT_MS = 5_000; // bound each read so a hung query can't stall the beat
const DAY_MS = 24 * 60 * 60 * 1000;

interface Variation {
  usd: number;
  /** Null when the base is unavailable/zero — rendered as "—". */
  pct: number | null;
}

export interface DailySummary {
  /** Local header date, e.g. "8 juin". */
  dateLabel: string;
  currentUsd: number;
  /** vs ~24h ago. Null → "—" (no 24h reference yet — first bilan after a start/reset). */
  change24h: Variation | null;
  /** vs bot_state.starting_capital_usd. Null → "—" (capital not set). */
  changeSinceStart: Variation | null;
  /** Resulting allocation — positions biggest-first, cash last (allocation.ts). */
  allocation: AllocationSlice[];
  wakeups: number;
  trades: number;
}

/** Local date key (YYYY-MM-DD), local hour [0-23], and the French header label, in `tz`. */
export function localNow(now: Date, tz: string): { dateKey: string; hour: number; label: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    label: new Intl.DateTimeFormat('fr-FR', { timeZone: tz, day: 'numeric', month: 'long' }).format(now),
  };
}

/** Portfolio-level Δ vs a base; null when the base is unavailable (clean "—" fallback). */
export function variation(current: number, base: number | null | undefined): Variation | null {
  if (base == null || !Number.isFinite(base)) return null;
  const usd = current - base;
  return { usd, pct: base !== 0 ? (usd / base) * 100 : null };
}

function fmtVariation(v: Variation | null): string {
  if (!v) return '—';
  const sign = v.usd >= 0 ? '+' : '-';
  const pct = v.pct == null ? '' : ` (${v.pct >= 0 ? '+' : '-'}${Math.abs(v.pct).toFixed(2)}%)`;
  return `${sign}${Math.abs(v.usd).toFixed(2)}$${pct}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`;

/** The daily-summary Telegram text — PURE, matching the validated mockup. */
export function formatDailySummary(s: DailySummary): string {
  return [
    `📊 Bilan du jour · ${s.dateLabel}`,
    '',
    `Capital : ${Math.round(s.currentUsd)}$`,
    `Sur 24h : ${fmtVariation(s.change24h)}`,
    `Depuis le début : ${fmtVariation(s.changeSinceStart)}`,
    '',
    `Alloc : ${formatAllocation(s.allocation)}`,
    `Activité : ${plural(s.wakeups, 'réveil')}, ${plural(s.trades, 'trade')}`,
  ].join('\n');
}

function warn(what: string, err: unknown): void {
  console.warn(`[warn] daily summary: could not read ${what} (${err instanceof Error ? err.message : String(err)}) — best-effort.`);
}

type SnapRow = {
  equity_usd: number;
  cash_usd: number;
  reserve_asset: string;
  positions: Array<{ asset?: string; value_usd?: number | string }> | null;
};

async function readLatestSnapshot(sb: SupabaseClient): Promise<SnapRow | null> {
  try {
    const { data, error } = await sb
      .from('equity_snapshots')
      .select('equity_usd, cash_usd, reserve_asset, positions')
      .order('id', { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as SnapRow | null) ?? null;
  } catch (err) { warn('latest snapshot', err); return null; }
}

async function readEquity24hAgo(sb: SupabaseClient, sinceIso: string): Promise<number | null> {
  try {
    const { data, error } = await sb
      .from('equity_snapshots')
      .select('equity_usd')
      .lte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? Number(data.equity_usd) : null;
  } catch (err) { warn('24h-ago snapshot', err); return null; }
}

async function readStartingCapital(sb: SupabaseClient): Promise<number | null> {
  try {
    const { data, error } = await sb
      .from('bot_state')
      .select('starting_capital_usd')
      .eq('id', 1)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(error.message);
    const n = data?.starting_capital_usd == null ? NaN : Number(data.starting_capital_usd);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) { warn('starting capital', err); return null; }
}

async function countWakeups(sb: SupabaseClient, sinceIso: string): Promise<number> {
  try {
    const { count, error } = await sb
      .from('scheduler_runs')
      .select('id', { count: 'exact', head: true })
      .gt('started_at', sinceIso)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error) throw new Error(error.message);
    return count ?? 0;
  } catch (err) { warn('wake-up count', err); return 0; }
}

async function countTrades(sb: SupabaseClient, sinceIso: string): Promise<number> {
  try {
    const { count, error } = await sb
      .from('executions')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'intent')
      .eq('validation_status', 'executed')
      .gt('created_at', sinceIso)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error) throw new Error(error.message);
    return count ?? 0;
  } catch (err) { warn('trade count', err); return 0; }
}

/** Allocation from a snapshot row: positions biggest-first, cash last (shared convention). */
function snapshotAllocation(snap: SnapRow): AllocationSlice[] {
  const eq = snap.equity_usd;
  const positive = eq > 0;
  const slices: AllocationSlice[] = [];
  for (const p of snap.positions ?? []) {
    const v = Number(p?.value_usd);
    if (!p?.asset || !Number.isFinite(v) || v <= 0) continue;
    const weight = positive ? (v / eq) * 100 : 0;
    if (weight > 0) slices.push({ label: p.asset, weight });
  }
  return orderedAllocation(slices, positive ? (snap.cash_usd / eq) * 100 : 0);
}

/**
 * Gathers the summary from existing sources. Each read is independently guarded (a
 * non-critical failure degrades to "—"/0). Returns null ONLY when there is no current
 * snapshot (no capital to report) — then the day's summary is skipped. The activity
 * counts + the 24h reference use a fixed last-24h window ("environ 24h").
 */
async function gather(sb: SupabaseClient, now: Date, dateLabel: string): Promise<DailySummary | null> {
  const sinceIso = new Date(now.getTime() - DAY_MS).toISOString();
  const [latest, equity24h, startCap, wakeups, trades] = await Promise.all([
    readLatestSnapshot(sb),
    readEquity24hAgo(sb, sinceIso),
    readStartingCapital(sb),
    countWakeups(sb, sinceIso),
    countTrades(sb, sinceIso),
  ]);
  if (!latest) return null;
  const currentUsd = Number(latest.equity_usd);
  return {
    dateLabel,
    currentUsd,
    change24h: variation(currentUsd, equity24h),
    changeSinceStart: variation(currentUsd, startCap),
    allocation: snapshotAllocation(latest),
    wakeups,
    trades,
  };
}

async function claimDailySummary(sb: SupabaseClient, localDate: string): Promise<boolean> {
  // BOUNDED like every other I/O on this path (the reads, the Telegram send): a hung
  // PostgREST that never responds nor errors must not leave this await unsettled and
  // block the beat before its Healthchecks ping. On timeout the abort throws, gets
  // caught upstream (no summary this beat), and the next beat retries — unless the
  // UPDATE had already committed server-side, in which case the day's summary is simply
  // skipped (same best-effort posture as a failed send). Never a block.
  const { data, error } = await sb
    .rpc('claim_daily_summary', { p_local_date: localDate })
    .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
  if (error) throw new Error(`claim_daily_summary RPC failed: ${error.message}`);
  return data === true;
}

/**
 * Sends the daily summary AT MOST once per local day, on the first beat at/after the
 * configured local hour. Best-effort and total: wrapped so it NEVER throws into the
 * beat. Claims BEFORE gathering, so the common post-9h beat does one cheap RPC (which
 * returns false) and stops — only the winning beat reads + sends.
 */
export async function maybeSendDailySummary(sb: SupabaseClient | null, now: Date): Promise<void> {
  if (!sb) return;
  try {
    const { dateKey, hour, label } = localNow(now, config.dailySummary.timezone);
    if (hour < config.dailySummary.sendAtHourLocal) return; // before the send hour, local
    if (!(await claimDailySummary(sb, dateKey))) return; // already sent today (or lost the race)

    const summary = await gather(sb, now, label);
    if (!summary) {
      console.warn('[warn] daily summary claimed but no current equity snapshot — skipped today (best-effort).');
      return;
    }
    await sendTelegram(formatDailySummary(summary));
    console.log(`[daily] summary sent for ${dateKey} (${config.dailySummary.timezone}).`);
  } catch (err) {
    console.warn(
      `[warn] daily summary failed (best-effort, ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
