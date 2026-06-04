import type { Exchange, OHLCV } from 'ccxt';
import type { Timeframe } from '../config/index.js';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchCandles(
  exchange: Exchange,
  symbol: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Candle[]> {
  const raw = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  return raw.map((row: OHLCV) => {
    const [ts, open, high, low, close, volume] = row as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    return { timestamp: ts, open, high, low, close, volume };
  });
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
