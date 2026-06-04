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

function rangeHighLow(candles: Candle[]): RangeLevels {
  if (candles.length === 0) {
    throw new Error('Cannot compute high/low on empty candle series');
  }
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

export function yearLevels(primary: Candle[]): RangeLevels {
  return rangeHighLow(sliceLastDays(primary, 365));
}

export function monthLevels(primary: Candle[]): RangeLevels {
  return rangeHighLow(sliceLastDays(primary, 30));
}

/**
 * ATH / ATL across the longest series we can fetch.
 *
 * Isolated on purpose: when the persistence layer lands, this is the function
 * we'll seed once and then maintain incrementally (compare live high/low to
 * the cached value at each wake-up) instead of re-fetching the full long
 * series every run.
 */
export function allTimeLevels(longTerm: Candle[]): RangeLevels {
  return rangeHighLow(longTerm);
}
