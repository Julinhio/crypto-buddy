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
 * snapshots, bot_state, s4_pilot, scheduler_runs, executions), sent best-effort OUTSIDE the
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
  /** Null when the base is zero — the $ delta is still shown, without a %. */
  pct: number | null;
}

/**
 * WHY A LINE HAS NO NUMBER — said on the line, never a bare dash (chantier du 14/11/2026).
 *
 * On 09/11 "Sur 24h" showed "—". Nothing was missing: the read of the reference photo had timed
 * out (5 s), and a failed read printed exactly like "no reference yet". The two are now distinct
 * values all the way to the text:
 *   - 'absent'      : the read worked and there is nothing to compare with (first bilan, a gap);
 *   - 'read_failed' : the read failed, twice (`readTwice`). The number exists; we do not have it.
 */
export type Gap = 'absent' | 'read_failed';

export interface DailySummary {
  /** Local header date, e.g. "8 juin". */
  dateLabel: string;
  currentUsd: number;
  /**
   * Local time of the photo `currentUsd` comes from, e.g. "05h05". The bilan reads the LATEST
   * photo, and S4 takes one per 4h cycle: at 9h the capital shown is up to four hours old, so the
   * line says when it was valued. Null when the photo's time is unreadable.
   */
  valuedAtLabel: string | null;
  /** vs the photo ~24h before. */
  change24h: Variation | Gap;
  /**
   * THE PILOT'S OWN LINE: vs `s4_pilot.starting_equity_usd`, the book's value when the pilot's
   * first cycle traded. Null while no pilot has started — the line is then absent.
   */
  pilot: { sinceLabel: string; change: Variation } | 'read_failed' | null;
  /** vs `bot_state.starting_capital_usd` — the historical base, named on the line with its amount. */
  history: { baseUsd: number; change: Variation } | Gap;
  /** Resulting allocation — positions biggest-first, cash last (allocation.ts). */
  allocation: AllocationSlice[];
  /** Null when the count could not be read: "0" would be a statement. */
  wakeups: number | null;
  trades: number | null;
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

/** Portfolio-level Δ vs a base; null when there is no usable base to compare with. */
export function variation(current: number, base: number | null | undefined): Variation | null {
  if (base == null || !Number.isFinite(base) || !Number.isFinite(current)) return null;
  const usd = current - base;
  return { usd, pct: base !== 0 ? (usd / base) * 100 : null };
}

/**
 * The 24h reference equity, or null if the closest snapshot is too OLD to honestly
 * label "Sur 24h". The query returns the closest snapshot at-or-before the 24h mark;
 * after a multi-day outage or a gap in snapshot writes that "closest" point can be days
 * old, which would mislabel a multi-day change as 24h. We accept a reference only within
 * `maxAgeMs` of now (24h + one max cadence gap — see gather); beyond that it falls back
 * to "no reference", as on the first bilan. Pure → unit-tested.
 */
export function freshReference(
  ref: { equityUsd: number; createdAtMs: number } | null,
  nowMs: number,
  maxAgeMs: number,
): number | null {
  if (!ref || !Number.isFinite(ref.createdAtMs)) return null;
  return nowMs - ref.createdAtMs <= maxAgeMs ? ref.equityUsd : null;
}

function fmtVariation(v: Variation): string {
  const sign = v.usd >= 0 ? '+' : '-';
  const pct = v.pct == null ? '' : ` (${v.pct >= 0 ? '+' : '-'}${Math.abs(v.pct).toFixed(2)}%)`;
  return `${sign}${Math.abs(v.usd).toFixed(2)}$${pct}`;
}

const READ_FAILED = 'indisponible (lecture en échec)';
const plural = (n: number, word: string): string => `${n} ${word}${n > 1 ? 's' : ''}`;

/** The daily-summary Telegram text — PURE. Every line without a number says why. */
export function formatDailySummary(s: DailySummary): string {
  const change24h =
    s.change24h === 'read_failed' ? READ_FAILED
    : s.change24h === 'absent' ? '— (pas de photo de référence à 24h)'
    : fmtVariation(s.change24h);
  const history =
    s.history === 'read_failed' ? `Historique : ${READ_FAILED}`
    : s.history === 'absent' ? 'Historique : — (capital de départ non renseigné)'
    : `Historique (base ${Math.round(s.history.baseUsd)}$) : ${fmtVariation(s.history.change)}`;
  const pilot =
    s.pilot == null ? null
    : s.pilot === 'read_failed' ? `Pilote S4 : ${READ_FAILED}`
    : `Pilote S4 (depuis le ${s.pilot.sinceLabel}) : ${fmtVariation(s.pilot.change)}`;
  const activity =
    s.wakeups == null || s.trades == null
      ? `Activité : ${READ_FAILED}`
      : `Activité : ${plural(s.wakeups, 'réveil')}, ${plural(s.trades, 'trade')}`;
  return [
    `📊 Bilan du jour · ${s.dateLabel}`,
    '',
    `Capital : ${Math.round(s.currentUsd)}$${s.valuedAtLabel ? ` (valorisé à ${s.valuedAtLabel})` : ''}`,
    `Sur 24h : ${change24h}`,
    ...(pilot ? [pilot] : []),
    history,
    '',
    `Alloc : ${formatAllocation(s.allocation)}`,
    activity,
  ].join('\n');
}

function warn(what: string, err: unknown): void {
  console.warn(`[warn] daily summary: could not read ${what} (${err instanceof Error ? err.message : String(err)}) — best-effort.`);
}

/** A read's outcome. A failure is a VALUE, kept apart from "nothing there" up to the text. */
export type Read<T> = { ok: true; value: T } | { ok: false };

/**
 * Runs a read, and once more if it failed. The reads here are single indexed lookups: one that
 * times out is a transient (09/11: one of five parallel reads, alone, hit its 5 s bound), and a
 * second attempt is cheaper than a hole in the day's only summary. Two failures are reported as
 * a failure — never as an empty answer.
 */
export async function readTwice<T>(what: string, fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      warn(what, err);
      return { ok: false };
    }
  }
}

type SnapRow = {
  equity_usd: number;
  cash_usd: number;
  reserve_asset: string;
  positions: Array<{ asset?: string; value_usd?: number | string }> | null;
  created_at: string;
};

const readLatestSnapshot = (sb: SupabaseClient): Promise<Read<SnapRow | null>> =>
  readTwice('latest snapshot', async () => {
    const { data, error } = await sb
      .from('equity_snapshots')
      .select('equity_usd, cash_usd, reserve_asset, positions, created_at')
      .order('id', { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as SnapRow | null) ?? null;
  });

// The closest snapshot AT OR BEFORE the 24h mark — WITH its timestamp, so the caller can reject
// a reference too old to honestly label "Sur 24h" (a gap/outage left no snapshot near the mark;
// freshReference handles that).
const readEquity24hAgo = (sb: SupabaseClient, sinceIso: string): Promise<Read<{ equityUsd: number; createdAtMs: number } | null>> =>
  readTwice('24h-ago snapshot', async () => {
    const { data, error } = await sb
      .from('equity_snapshots')
      .select('equity_usd, created_at')
      .lte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data ? { equityUsd: Number(data.equity_usd), createdAtMs: Date.parse(data.created_at) } : null;
  });

/** Null = read fine, no usable capital set. */
const readStartingCapital = (sb: SupabaseClient): Promise<Read<number | null>> =>
  readTwice('starting capital', async () => {
    const { data, error } = await sb
      .from('bot_state')
      .select('starting_capital_usd')
      .eq('id', 1)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(error.message);
    const n = data?.starting_capital_usd == null ? NaN : Number(data.starting_capital_usd);
    return Number.isFinite(n) && n > 0 ? n : null;
  });

export interface PilotStart {
  startedAtMs: number;
  startingEquityUsd: number;
}

/**
 * The S4 pilot's identity, READ-ONLY: when its first trading cycle ran, and what the book was
 * worth then (`markPilotStarted`). Null = no pilot row, or a pilot that has not started.
 */
const readPilotStart = (sb: SupabaseClient): Promise<Read<PilotStart | null>> =>
  readTwice('S4 pilot start', async () => {
    const { data, error } = await sb
      .from('s4_pilot')
      .select('started_at, starting_equity_usd')
      .eq('id', 1)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS))
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data?.started_at == null || data.starting_equity_usd == null) return null;
    const startedAtMs = Date.parse(String(data.started_at));
    const startingEquityUsd = Number(data.starting_equity_usd);
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(startingEquityUsd)) throw new Error('unreadable s4_pilot identity');
    return { startedAtMs, startingEquityUsd };
  });

const countWakeups = (sb: SupabaseClient, sinceIso: string): Promise<Read<number>> =>
  readTwice('wake-up count', async () => {
    const { count, error } = await sb
      .from('scheduler_runs')
      .select('id', { count: 'exact', head: true })
      .gt('started_at', sinceIso)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error) throw new Error(error.message);
    return count ?? 0;
  });

const countTrades = (sb: SupabaseClient, sinceIso: string): Promise<Read<number>> =>
  readTwice('trade count', async () => {
    const { count, error } = await sb
      .from('executions')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'intent')
      .eq('validation_status', 'executed')
      .gt('created_at', sinceIso)
      .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
    if (error) throw new Error(error.message);
    return count ?? 0;
  });

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

/** What `gatherDailySummary` read, before it becomes a summary — the seam the offline tests drive. */
export interface DailySummaryInputs {
  dateLabel: string;
  nowMs: number;
  timezone: string;
  /** Max age of the 24h reference (24h + one cadence gap — see gatherDailySummary). */
  maxRefAgeMs: number;
  latest: { equityUsd: number; createdAtMs: number; allocation: AllocationSlice[] };
  ref24h: Read<{ equityUsd: number; createdAtMs: number } | null>;
  startingCapital: Read<number | null>;
  pilot: Read<PilotStart | null>;
  wakeups: Read<number>;
  trades: Read<number>;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** "05h05" and "06/11" in `tz` — the valuation time and the pilot's start, as Julien reads them. */
function localStamp(ms: number, tz: string): { time: string; day: string } | null {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return { time: `${two(Number(get('hour')))}h${two(Number(get('minute')))}`, day: `${get('day')}/${get('month')}` };
}

/** PURE: the summary from what was read. Every failed read stays a failure on its own line. */
export function buildDailySummary(i: DailySummaryInputs): DailySummary {
  const currentUsd = i.latest.equityUsd;
  const pilotLine = (start: PilotStart): DailySummary['pilot'] => {
    const change = variation(currentUsd, start.startingEquityUsd);
    const since = localStamp(start.startedAtMs, i.timezone);
    return change && since ? { sinceLabel: since.day, change } : 'read_failed';
  };
  const base = i.startingCapital.ok ? i.startingCapital.value : null;
  const historyChange = base == null ? null : variation(currentUsd, base);
  return {
    dateLabel: i.dateLabel,
    currentUsd,
    valuedAtLabel: localStamp(i.latest.createdAtMs, i.timezone)?.time ?? null,
    change24h: i.ref24h.ok
      ? (variation(currentUsd, freshReference(i.ref24h.value, i.nowMs, i.maxRefAgeMs)) ?? 'absent')
      : 'read_failed',
    pilot: !i.pilot.ok ? 'read_failed' : i.pilot.value == null ? null : pilotLine(i.pilot.value),
    history: !i.startingCapital.ok ? 'read_failed' : base == null || historyChange == null ? 'absent' : { baseUsd: base, change: historyChange },
    allocation: i.latest.allocation,
    wakeups: i.wakeups.ok ? i.wakeups.value : null,
    trades: i.trades.ok ? i.trades.value : null,
  };
}

/**
 * Gathers the summary from existing sources, READ-ONLY. Each read is independently guarded and
 * tried twice; one that still fails degrades ITS line to "indisponible", by name. Returns null
 * ONLY when there is no current snapshot to report (none yet, or its read failed) — the day's
 * summary is then not sent and the claim is released, so the next beat tries again. The activity
 * counts + the 24h reference use a fixed last-24h window ("environ 24h").
 */
export async function gatherDailySummary(sb: SupabaseClient, now: Date, dateLabel: string): Promise<DailySummary | null> {
  const sinceIso = new Date(now.getTime() - DAY_MS).toISOString();
  const [latest, ref24h, startingCapital, pilot, wakeups, trades] = await Promise.all([
    readLatestSnapshot(sb),
    readEquity24hAgo(sb, sinceIso),
    readStartingCapital(sb),
    readPilotStart(sb),
    countWakeups(sb, sinceIso),
    countTrades(sb, sinceIso),
  ]);
  if (!latest.ok || !latest.value) return null;
  // Reject a 24h reference that is too old to honestly carry the "Sur 24h" label: the
  // closest snapshot before the mark may be days old after an outage/gap. "Near enough"
  // = within 24h + one max CADENCE gap (the bot snapshots once per decided cycle, whose
  // delay is clamped to ≤ maxDelayMinutes; +one beat for jitter). Beyond → no reference.
  const maxRefAgeMs =
    DAY_MS + (config.decision.maxDelayMinutes + config.scheduler.beatIntervalMinutes) * 60_000;
  return buildDailySummary({
    dateLabel,
    nowMs: now.getTime(),
    timezone: config.dailySummary.timezone,
    maxRefAgeMs,
    latest: {
      equityUsd: Number(latest.value.equity_usd),
      createdAtMs: Date.parse(latest.value.created_at),
      allocation: snapshotAllocation(latest.value),
    },
    ref24h,
    startingCapital,
    pilot,
    wakeups,
    trades,
  });
}

// BOUNDED like every other I/O on this path (reads, Telegram send): a hung PostgREST
// must not leave this await unsettled and block the beat before its Healthchecks ping.
//
// ACCEPTED RESIDUAL (best-effort observability, NOT the money path): if PostgreSQL
// COMMITS the claim but the response is lost/delayed past the timeout, this throws
// AFTER the mark was persisted; the outer catch then sends nothing and never releases,
// so today's bilan is MISSED. It self-heals the NEXT day (tomorrow IS DISTINCT FROM
// today's mark → claims → sends). At-most-once delivery would need a lease + durable
// dedup — disproportionate machinery for a daily observability ping; we reserve that
// for the money path (trades, cycle lock). A one-day miss is benign and bounded.
async function claimDailySummary(sb: SupabaseClient, localDate: string): Promise<boolean> {
  const { data, error } = await sb
    .rpc('claim_daily_summary', { p_local_date: localDate })
    .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
  if (error) throw new Error(`claim_daily_summary RPC failed: ${error.message}`);
  return data === true;
}

// Releases a PROVISIONAL claim whose send did not confirm, so the next beat retries.
// Conditional + atomic SQL-side (resets the mark to NULL only if WE still own it). Bounded.
async function releaseDailySummary(sb: SupabaseClient, localDate: string): Promise<void> {
  const { error } = await sb
    .rpc('release_daily_summary', { p_local_date: localDate })
    .abortSignal(AbortSignal.timeout(READ_TIMEOUT_MS));
  if (error) throw new Error(`release_daily_summary RPC failed: ${error.message}`);
}

/** The injectable I/O the orchestration drives — real wiring in maybeSendDailySummary. */
export interface DailySummaryDeps {
  /** Atomic once-per-day claim; true = WE own today's send. */
  claim: (localDate: string) => Promise<boolean>;
  /** Build the summary from existing sources; null = nothing to report (e.g. no snapshot). */
  gather: () => Promise<DailySummary | null>;
  /** Deliver the message; the BOOLEAN is the truth (false = not delivered). */
  send: (text: string) => Promise<boolean>;
  /** Reset a provisional claim so the next beat retries. */
  release: (localDate: string) => Promise<void>;
}

/**
 * The once-per-day orchestration, with the claim PROVISIONAL: the day is consumed ONLY
 * on a confirmed send. Claim is first (the atomic double-send guard — concurrent beats
 * see today's mark and skip); but if the send doesn't confirm (no data, or sendTelegram
 * returns false), we RELEASE the mark so the next beat retries — a daily message must
 * not lose the whole day on a transient Telegram hiccup. Returns the truthful outcome.
 * Pure of config/clock (deps injected) so the release-iff-not-delivered logic is tested.
 */
export async function runDailySummary(
  deps: DailySummaryDeps,
  localDate: string,
): Promise<'sent' | 'retry' | 'skip'> {
  if (!(await deps.claim(localDate))) return 'skip'; // already done today, or a concurrent beat owns it
  const summary = await deps.gather();
  const delivered = summary != null && (await deps.send(formatDailySummary(summary)));
  if (delivered) return 'sent'; // confirmed → the day is COMMITTED (mark kept)
  // ACCEPTED RESIDUAL (best-effort observability, NOT the money path): if Telegram
  // RECEIVED the message but its HTTP response was lost/late (sendTelegram → false on
  // timeout), releasing here makes the next beat re-send → ONE duplicate bilan.
  // Cosmetic. Exactly-once is impossible without durable idempotency; for a daily ping
  // at-least-once is the right trade — a duplicate is benign, a miss self-heals next day.
  await deps.release(localDate); // not delivered → roll the claim back → retry next beat
  return 'retry';
}

/**
 * Sends the daily summary AT MOST once per local day, on the first beat at/after the
 * configured local hour. Best-effort and total: wrapped so it NEVER throws into the
 * beat. Wires the real I/O into runDailySummary; the log reflects the TRUTH (sent only
 * on a confirmed delivery, retry otherwise).
 */
export async function maybeSendDailySummary(sb: SupabaseClient | null, now: Date): Promise<void> {
  if (!sb) return;
  try {
    const { dateKey, hour, label } = localNow(now, config.dailySummary.timezone);
    if (hour < config.dailySummary.sendAtHourLocal) return; // before the send hour, local
    const outcome = await runDailySummary(
      {
        claim: (d) => claimDailySummary(sb, d),
        gather: () => gatherDailySummary(sb, now, label),
        send: sendTelegram,
        release: (d) => releaseDailySummary(sb, d),
      },
      dateKey,
    );
    if (outcome === 'sent') {
      console.log(`[daily] summary sent for ${dateKey} (${config.dailySummary.timezone}).`);
    } else if (outcome === 'retry') {
      console.warn(`[daily] summary not delivered for ${dateKey} — claim released, next beat will retry.`);
    }
    // 'skip' → silent: already committed today, or another beat owns the send.
  } catch (err) {
    console.warn(
      `[warn] daily summary failed (best-effort, ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
