import type { SupabaseClient } from '@supabase/supabase-js';
import type { Candle } from '../market/klines.js';
import {
  allTimeLevels,
  extremesOf,
  type PriceLevel,
  type RangeLevels,
} from '../market/levels.js';
import type { CacheConfig } from '../config/index.js';

const TABLE = 'ath_atl_cache';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How the returned ATH/ATL was produced this run:
 *   - 'seed'     : no cache entry yet → fetched the long series, computed, stored
 *   - 'reseed'   : entry was stale → re-fetched the long series and refreshed it
 *   - 'cache'    : read from cache, unchanged
 *   - 'bumped'   : read from cache, then pushed by a new live/daily extreme
 *   - 'fallback' : Supabase unavailable → computed from the long series, not stored
 */
export type AllTimeOrigin = 'seed' | 'reseed' | 'cache' | 'bumped' | 'fallback';

export interface AllTimeLevels extends RangeLevels {
  source: {
    timeframe: string;
    candles: number;
    origin: AllTimeOrigin;
  };
}

interface CacheRow {
  symbol: string;
  ath_price: number;
  ath_at: string;
  atl_price: number;
  atl_at: string;
  source_timeframe: string;
  source_candles: number;
  seeded_at: string;
  updated_at: string;
  last_update_source: string;
}

export interface ResolveAllTimeParams {
  /** Server-side client, or null when persistence is not configured. */
  supabase: SupabaseClient | null;
  symbol: string;
  /** Current spot price, already fetched for the context this run. */
  livePrice: number;
  /** Primary (daily) candles, already fetched — reused to catch intraday extremes. */
  primaryCandles: Candle[];
  /** Timeframe label of the long seed series (e.g. '1w'). */
  longTermTimeframe: string;
  /** Lazy fetch of the long historical series — only called on seed/reseed/fallback. */
  fetchLongTerm: () => Promise<Candle[]>;
  cache: CacheConfig;
}

/**
 * Resolves the cached ATH/ATL for a pair, seeding or maintaining as needed.
 *
 * The long series is fetched ONLY on a first-ever seed, a stale re-seed, or a
 * Supabase-unavailable fallback — never on a normal cached run. Any Supabase
 * failure degrades to computing from the long series for this run (a warning
 * is logged) so the cache is an optimization, not a point of failure.
 */
export async function resolveAllTimeLevels(
  p: ResolveAllTimeParams,
): Promise<AllTimeLevels | null> {
  if (!p.supabase) {
    // Not configured: the startup warning already fired once. Old behavior.
    return computeFromLongSeries(p, 'fallback');
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  try {
    const { data, error } = await p.supabase
      .from(TABLE)
      .select('*')
      .eq('symbol', p.symbol)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const row = data as CacheRow | null;

    // First pass / new pair → seed and store.
    // NB: `return await` (not bare `return`) so a rejection from the write —
    // e.g. Supabase going unreachable mid-seed — is caught by THIS try/catch
    // and falls back to long-series computation, instead of escaping to
    // safeBuildPair and dropping the whole pair.
    if (!row) {
      return await seed(p, nowIso, 'seed');
    }

    // Safety re-seed: a stale entry is refreshed fully from the long series.
    const seededMs = Date.parse(row.seeded_at);
    const ageMs = nowMs - seededMs;
    if (Number.isFinite(seededMs) && ageMs > p.cache.stalenessDays * DAY_MS) {
      console.warn(
        `[warn] ${p.symbol}: ATH/ATL cache older than ${p.cache.stalenessDays}d — re-seeding from the long series.`,
      );
      return await seed(p, nowIso, 'reseed');
    }

    // Normal path: maintain from data already in hand, no long-series fetch.
    return await maintain(p, row, nowIso);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] ${p.symbol}: Supabase ATH/ATL cache unavailable (${msg}) — computing from the long series for this run.`,
    );
    return computeFromLongSeries(p, 'fallback');
  }
}

/** Old brick-1 behavior: pull the long series and compute, without storing. */
async function computeFromLongSeries(
  p: ResolveAllTimeParams,
  origin: AllTimeOrigin,
): Promise<AllTimeLevels | null> {
  const longTerm = await p.fetchLongTerm();
  const levels = allTimeLevels(longTerm);
  if (!levels) {
    console.warn(
      `[warn] ${p.symbol}: long-term series is empty — ATH/ATL unavailable.`,
    );
    return null;
  }
  return withSource(levels, p.longTermTimeframe, longTerm.length, origin);
}

/** Seed (or re-seed) the cache from the long series and persist it. */
async function seed(
  p: ResolveAllTimeParams,
  nowIso: string,
  origin: 'seed' | 'reseed',
): Promise<AllTimeLevels | null> {
  const longTerm = await p.fetchLongTerm();
  const levels = allTimeLevels(longTerm);
  if (!levels) {
    console.warn(
      `[warn] ${p.symbol}: long-term series is empty — cannot seed ATH/ATL cache.`,
    );
    return null;
  }

  const row: CacheRow = {
    symbol: p.symbol,
    ath_price: levels.high.price,
    ath_at: levels.high.at,
    atl_price: levels.low.price,
    atl_at: levels.low.at,
    source_timeframe: p.longTermTimeframe,
    source_candles: longTerm.length,
    seeded_at: nowIso,
    updated_at: nowIso,
    last_update_source: origin,
  };

  const { error } = await p.supabase!.from(TABLE).upsert(row, {
    onConflict: 'symbol',
  });
  if (error) {
    // We already have valid levels in hand — use them for this run rather than
    // re-fetching, and surface the write failure.
    console.warn(
      `[warn] ${p.symbol}: failed to write ATH/ATL cache (${error.message}) — using freshly computed levels for this run.`,
    );
    return withSource(levels, p.longTermTimeframe, longTerm.length, 'fallback');
  }

  return withSource(levels, p.longTermTimeframe, longTerm.length, origin);
}

/**
 * Maintain a present cache entry without touching the long series: push the
 * cached ATH/ATL only if the live price or a recent daily candle prints a new
 * extreme. The daily candles (already fetched) record each day's true intraday
 * high/low, so a spike that reverted between two runs is still captured.
 */
async function maintain(
  p: ResolveAllTimeParams,
  row: CacheRow,
  nowIso: string,
): Promise<AllTimeLevels> {
  const recent = p.primaryCandles.slice(-p.cache.maintenanceLookbackCandles);
  const dailyExtremes = extremesOf(recent);

  const live: PriceLevel = { price: p.livePrice, at: nowIso };

  const highCandidates: PriceLevel[] = [
    { price: row.ath_price, at: row.ath_at },
    live,
  ];
  const lowCandidates: PriceLevel[] = [
    { price: row.atl_price, at: row.atl_at },
    live,
  ];
  if (dailyExtremes) {
    highCandidates.push(dailyExtremes.high);
    lowCandidates.push(dailyExtremes.low);
  }

  const newHigh = highCandidates.reduce((a, b) => (b.price > a.price ? b : a));
  const newLow = lowCandidates.reduce((a, b) => (b.price < a.price ? b : a));

  const highChanged = newHigh.price > row.ath_price;
  const lowChanged = newLow.price < row.atl_price;

  const levels: RangeLevels = { high: newHigh, low: newLow };

  if (!highChanged && !lowChanged) {
    return withSource(levels, row.source_timeframe, row.source_candles, 'cache');
  }

  // Tag which signal moved the value (live price vs a past daily candle).
  const movedByLive =
    (highChanged && newHigh.at === nowIso) || (lowChanged && newLow.at === nowIso);
  const lastUpdateSource = movedByLive ? 'live' : 'daily';

  const { error } = await p.supabase!
    .from(TABLE)
    .update({
      ath_price: newHigh.price,
      ath_at: newHigh.at,
      atl_price: newLow.price,
      atl_at: newLow.at,
      updated_at: nowIso,
      last_update_source: lastUpdateSource,
    })
    .eq('symbol', p.symbol);

  if (error) {
    console.warn(
      `[warn] ${p.symbol}: failed to update ATH/ATL cache (${error.message}) — value still used for this run.`,
    );
  }

  return withSource(levels, row.source_timeframe, row.source_candles, 'bumped');
}

function withSource(
  levels: RangeLevels,
  timeframe: string,
  candles: number,
  origin: AllTimeOrigin,
): AllTimeLevels {
  return {
    high: levels.high,
    low: levels.low,
    source: { timeframe, candles, origin },
  };
}
