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
