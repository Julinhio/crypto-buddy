import type { Candle } from './klines.js';

export interface PriceLevel {
  price: number;
  at: string;
}

export interface RangeLevels {
  high: PriceLevel;
  low: PriceLevel;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Highest high / lowest low across a candle series, with the date of each
 * extreme.
 *
 * Returns `null` on an empty series instead of throwing, so a pair with
 * missing data degrades gracefully rather than taking down the whole loop.
 * The caller knows the symbol, so it owns the warning log.
 *
 * Exported because the ATH/ATL cache reuses it to derive the recent-candle
 * extremes used to maintain the cached value between runs.
 */
export function extremesOf(candles: Candle[]): RangeLevels | null {
  if (candles.length === 0) return null;
  let high = candles[0]!;
  let low = candles[0]!;
  for (const c of candles) {
    if (c.high > high.high) high = c;
    if (c.low < low.low) low = c;
  }
  return {
    high: { price: high.high, at: new Date(high.timestamp).toISOString() },
    low: { price: low.low, at: new Date(low.timestamp).toISOString() },
  };
}

function sliceLastDays(candles: Candle[], days: number): Candle[] {
  if (candles.length === 0) return [];
  const last = candles[candles.length - 1]!;
  const cutoff = last.timestamp - days * DAY_MS;
  return candles.filter((c) => c.timestamp >= cutoff);
}

export function yearLevels(primary: Candle[]): RangeLevels | null {
  return extremesOf(sliceLastDays(primary, 365));
}

export function monthLevels(primary: Candle[]): RangeLevels | null {
  return extremesOf(sliceLastDays(primary, 30));
}

/**
 * ATH / ATL across the longest series we can fetch. Returns `null` if the
 * series is empty (e.g. the long-term fetch came back empty).
 *
 * Isolated on purpose: when the persistence layer lands, this is the function
 * we'll seed once and then maintain incrementally (compare live high/low to
 * the cached value at each wake-up) instead of re-fetching the full long
 * series every run.
 */
export function allTimeLevels(longTerm: Candle[]): RangeLevels | null {
  return extremesOf(longTerm);
}
