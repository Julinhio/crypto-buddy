import type { Exchange } from 'ccxt';
import type { Timeframe } from '../config/index.js';
import { timeframeMs, type Candle } from '../market/klines.js';

/**
 * Historical candle loading for the REPLAY harness only.
 *
 * The production path (`fetchCandles`) asks for "the last N candles" — which is all a
 * live cycle ever needs. A replay needs a WINDOW that starts in the past and may be
 * longer than the exchange's 1000-candle page, so it pages forward from a `since`
 * timestamp instead.
 *
 * Deliberately kept out of src/market/: nothing in the live bot may depend on it, and
 * the separation makes it obvious that the harness reads the same public mainnet data
 * the bot reads, through the same ccxt client, with no privileged access.
 */

const PAGE_LIMIT = 1000;

/**
 * Fetches every candle from `since` (inclusive) onwards, paging until the exchange
 * stops advancing. Guards against the two classic paging bugs: a page that repeats
 * its first candle (infinite loop) and duplicate timestamps across page boundaries.
 */
export async function fetchCandlesSince(
  exchange: Exchange,
  symbol: string,
  timeframe: Timeframe,
  since: number,
): Promise<Candle[]> {
  const stepMs = timeframeMs(timeframe);
  const byTimestamp = new Map<number, Candle>();
  let cursor = since;

  for (;;) {
    const raw = await exchange.fetchOHLCV(symbol, timeframe, cursor, PAGE_LIMIT);
    if (raw.length === 0) break;

    let maxTs = cursor;
    for (const row of raw) {
      const [ts, open, high, low, close, volume] = row as Array<number | null | undefined>;
      if (
        typeof ts !== 'number' ||
        typeof open !== 'number' ||
        typeof high !== 'number' ||
        typeof low !== 'number' ||
        typeof close !== 'number'
      ) {
        continue;
      }
      byTimestamp.set(ts, {
        timestamp: ts,
        open,
        high,
        low,
        close,
        volume: typeof volume === 'number' ? volume : 0,
      });
      if (ts > maxTs) maxTs = ts;
    }

    // No forward progress → the exchange has nothing more; stop rather than loop.
    if (maxTs <= cursor) break;
    cursor = maxTs + stepMs;
  }

  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** The last N candles ending at or before `at` — the exact slice a live cycle would hold. */
export function sliceEndingAt(candles: Candle[], at: number, limit: number): Candle[] {
  const upTo = candles.filter((c) => c.timestamp <= at);
  return upTo.slice(Math.max(0, upTo.length - limit));
}
