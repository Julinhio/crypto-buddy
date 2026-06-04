import {
  config,
  tradableAssets,
  type PairKind,
} from '../config/index.js';
import { publicMainnetClient, testnetAccountClient } from '../exchanges/binance.js';
import { fetchCandles, fetchSpotPrice } from '../market/klines.js';
import { computeIndicators, type IndicatorSnapshot } from '../market/indicators.js';
import {
  allTimeLevels,
  monthLevels,
  yearLevels,
  type RangeLevels,
} from '../market/levels.js';
import { fetchRelevantBalances, type AssetBalance } from '../account/balances.js';

export interface PairContext {
  symbol: string;
  kind: PairKind;
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
  /**
   * Pairs are grouped by family so the boundary is structurally explicit:
   * `reference` pairs feed the LLM's market read but must never be allocated.
   */
  market: {
    tradable: PairContext[];
    reference: PairContext[];
  };
  account: {
    balances: AssetBalance[];
  };
}

async function buildPairContext(
  publicClient: ReturnType<typeof publicMainnetClient>,
  symbol: string,
  kind: PairKind,
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
    kind,
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

  const [tradable, reference, balances] = await Promise.all([
    Promise.all(
      config.tradablePairs.map((symbol) =>
        buildPairContext(publicClient, symbol, 'tradable'),
      ),
    ),
    Promise.all(
      config.referencePairs.map((symbol) =>
        buildPairContext(publicClient, symbol, 'reference'),
      ),
    ),
    fetchRelevantBalances(accountClient, tradableAssets(config)),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    source: {
      marketData: 'binance-public-mainnet',
      account: 'binance-testnet',
    },
    market: { tradable, reference },
    account: { balances },
  };
}
