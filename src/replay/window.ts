import 'dotenv/config';
import { config } from '../config/index.js';
import { publicMainnetClient } from '../exchanges/binance.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { timeframeMs } from '../market/klines.js';
import type { AssetSeries, RegimeOptions } from '../market/regime.js';
import { fetchCandlesSince } from './klines.js';

/**
 * Shared plumbing of the REPLAY harness: what window to replay, and the candles to
 * replay it on. Introduced with the regime (PR 1) and reused by the movement-sizing
 * replay (PR 2) — the mandate makes the replay an ACCEPTANCE CRITERION, not a final
 * brick, so it must be a real, reusable tool rather than a throwaway script.
 *
 * Two hard rules this file exists to honor:
 *
 *  - READ-ONLY on the live database. The harness reads `decisions` to learn WHICH
 *    window the bot actually observed; it never writes a row anywhere. The living
 *    tables are the V2's comparison baseline.
 *  - NO SIDE EFFECTS. Public mainnet candles only — no testnet order, no Telegram,
 *    no Healthchecks ping.
 */

const DAY_MS = timeframeMs('1d');

/**
 * The non-market inputs of the regime, resolved the SAME way production resolves
 * them. Shared by every replay so a harness can never accidentally hand the
 * calculator a looser universe or a different clock than the live bot does.
 */
export function replayRegimeOptions(nowMs: number = Date.now()): RegimeOptions {
  return {
    nowMs,
    barMs: timeframeMs(config.regime.timeframe),
    universeSize: config.tradablePairs.length + config.referencePairs.length,
  };
}

export interface ReplayWindow {
  fromMs: number;
  toMs: number;
  /** Rows behind the window, for the report header. */
  decisions: number;
  days: number;
}

/**
 * The window the bot actually observed, read from `decisions`. Taken from the data
 * rather than hardcoded so the harness stays honest as the observation grows: the
 * "47 days" of the mandate is a fact about the table on a given day, not a constant.
 */
export async function loadObservationWindow(): Promise<ReplayWindow> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error(
      'replay: Supabase is not configured — the harness reads (read-only) the observation ' +
        'window from `decisions`. Set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  const [first, last, count] = await Promise.all([
    supabase.from('decisions').select('created_at').order('created_at', { ascending: true }).limit(1).single(),
    supabase.from('decisions').select('created_at').order('created_at', { ascending: false }).limit(1).single(),
    supabase.from('decisions').select('*', { count: 'exact', head: true }),
  ]);
  if (first.error || last.error) {
    throw new Error(`replay: could not read the observation window (${first.error?.message ?? last.error?.message}).`);
  }
  const fromMs = Date.parse(first.data!.created_at as string);
  const toMs = Date.parse(last.data!.created_at as string);
  return {
    fromMs,
    toMs,
    decisions: count.count ?? 0,
    days: Math.round((toMs - fromMs) / DAY_MS),
  };
}

/**
 * Daily + 4h candles for the whole universe, with enough history BEFORE the window
 * for every indicator and for the hysteresis to have converged.
 *
 *  - daily: SMA200 needs 200 closed days, plus the slope lookback → 260 days of
 *    warm-up, so the very first replayed bar already has every daily signal.
 *  - 4h: production only ever holds `config.regime.limit` bars; the harness loads
 *    60 extra days so the hysteresis walk is deep into steady state at the window's
 *    first bar. That equivalence is not assumed — `regime.ts`'s replay asserts the
 *    last point matches a production-sized slice exactly.
 */
export async function loadUniverseSeries(window: ReplayWindow): Promise<Record<string, AssetSeries>> {
  const client = publicMainnetClient();
  const pairs = [...config.tradablePairs, ...config.referencePairs];
  const dailyFrom = window.fromMs - 260 * DAY_MS;
  const h4From = window.fromMs - 60 * DAY_MS;

  const universe: Record<string, AssetSeries> = {};
  for (const symbol of pairs) {
    const base = symbol.split('/')[0];
    if (!base) continue;
    const [daily, h4] = await Promise.all([
      fetchCandlesSince(client, symbol, config.primaryTimeframe, dailyFrom),
      fetchCandlesSince(client, symbol, config.regime.timeframe, h4From),
    ]);
    universe[base] = { daily, h4 };
    console.log(
      `[replay] ${symbol}: ${daily.length} × ${config.primaryTimeframe}, ` +
        `${h4.length} × ${config.regime.timeframe} (from ${new Date(h4[0]?.timestamp ?? h4From).toISOString().slice(0, 10)}).`,
    );
  }
  return universe;
}

/**
 * Restricts a bar-indexed series to the observation window, on CLOSE time.
 *
 * Filtering on a bar's opening timestamp alone would admit the bar that opened before
 * the last decision but closed after it: the historical fetch now holds that bar's
 * completed OHLC, so the replay would consume candles the bot had not observed when
 * the window ended — a small look-ahead, but the harness's whole credibility rests on
 * there being none, and C5 would end up validating a bar production never saw.
 *
 * Single helper so every criterion shares one definition of "inside the window".
 */
export function withinWindow<T extends { timestamp: number }>(
  points: T[],
  window: ReplayWindow,
  barMs: number,
): T[] {
  return points.filter((p) => p.timestamp >= window.fromMs && p.timestamp + barMs <= window.toMs);
}

/** `2026-07-25 04:00` — compact, unambiguous, sortable. Seconds add nothing on 4h bars. */
export function fmtBar(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

export function pct(value: number, digits = 1): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}
