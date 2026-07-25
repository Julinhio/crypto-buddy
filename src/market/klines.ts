import type { Exchange } from 'ccxt';
import type { Timeframe } from '../config/index.js';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const MINUTE_MS = 60 * 1000;

const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 4 * 60,
  '1d': 24 * 60,
  '1w': 7 * 24 * 60,
  '1M': 30 * 24 * 60, // nominal — only ever used for spacing, never for calendar math
};

/**
 * How long one candle of `timeframe` lasts, in milliseconds. Single source of the
 * mapping: the regime layer needs it to tell a CLOSED candle from the one still
 * forming, and the replay needs it to page. Two copies of this table would be one
 * copy too many.
 */
export function timeframeMs(timeframe: Timeframe): number {
  return TIMEFRAME_MINUTES[timeframe] * MINUTE_MS;
}

export async function fetchCandles(
  exchange: Exchange,
  symbol: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Candle[]> {
  const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

  const candles: Candle[] = [];
  let dropped = 0;

  for (const row of raw) {
    const [ts, open, high, low, close, volume] = row as (
      | number
      | null
      | undefined
    )[];

    // ccxt can hand back incomplete candles with null fields. Drop those
    // rather than blindly casting null to a number (which would poison every
    // downstream indicator and level). OHLCV is only kept when its core
    // fields are all finite; volume defaults to 0 when missing.
    if (
      !isFiniteNumber(ts) ||
      !isFiniteNumber(open) ||
      !isFiniteNumber(high) ||
      !isFiniteNumber(low) ||
      !isFiniteNumber(close)
    ) {
      dropped++;
      continue;
    }

    candles.push({
      timestamp: ts,
      open,
      high,
      low,
      close,
      volume: isFiniteNumber(volume) ? volume : 0,
    });
  }

  if (dropped > 0) {
    console.warn(
      `[warn] ${symbol} ${timeframe}: dropped ${dropped} incomplete candle(s) with missing fields.`,
    );
  }

  return candles;
}

export async function fetchSpotPrice(
  exchange: Exchange,
  symbol: string,
): Promise<number> {
  const ticker = await exchange.fetchTicker(symbol);
  if (ticker.last == null) {
    throw new Error(`No last price returned for ${symbol}`);
  }
  return ticker.last;
}
