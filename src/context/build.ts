import { config } from '../config/index.js';
import { publicMainnetClient, testnetAccountClient } from '../exchanges/binance.js';
import { fetchCandles, fetchSpotPrice } from '../market/klines.js';
import { computeIndicators, type IndicatorSnapshot } from '../market/indicators.js';
import {
  allTimeLevels,
  monthLevels,
  yearLevels,
  type RangeLevels,
} from '../market/levels.js';
import { fetchNonZeroBalances, type AssetBalance } from '../account/balances.js';

export interface PairContext {
  symbol: string;
  price: number;
  primary: {
    timeframe: string;
    candles: number;
  };
  indicators: IndicatorSnapshot;
  levels: {
    month: RangeLevels;
    year: RangeLevels;
    allTime: RangeLevels & { source: { timeframe: string; candles: number } };
  };
}

export interface MarketContext {
  generatedAt: string;
  source: {
    marketData: 'binance-public-mainnet';
    account: 'binance-testnet';
  };
  pairs: PairContext[];
  account: {
    balances: AssetBalance[];
  };
}

async function buildPairContext(
  publicClient: ReturnType<typeof publicMainnetClient>,
  symbol: string,
): Promise<PairContext> {
  const [price, primaryCandles, longTermCandles] = await Promise.all([
    fetchSpotPrice(publicClient, symbol),
    fetchCandles(
      publicClient,
      symbol,
      config.primaryTimeframe,
      config.primaryLimit,
    ),
    fetchCandles(
      publicClient,
      symbol,
      config.longTermTimeframe,
      config.longTermLimit,
    ),
  ]);

  return {
    symbol,
    price,
    primary: {
      timeframe: config.primaryTimeframe,
      candles: primaryCandles.length,
    },
    indicators: computeIndicators(primaryCandles, config.indicators),
    levels: {
      month: monthLevels(primaryCandles),
      year: yearLevels(primaryCandles),
      allTime: {
        ...allTimeLevels(longTermCandles),
        source: {
          timeframe: config.longTermTimeframe,
          candles: longTermCandles.length,
        },
      },
    },
  };
}

export async function buildMarketContext(): Promise<MarketContext> {
  const publicClient = publicMainnetClient();
  const accountClient = testnetAccountClient();

  const [pairs, balances] = await Promise.all([
    Promise.all(config.pairs.map((symbol) => buildPairContext(publicClient, symbol))),
    fetchNonZeroBalances(accountClient),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    source: {
      marketData: 'binance-public-mainnet',
      account: 'binance-testnet',
    },
    pairs,
    account: { balances },
  };
}
