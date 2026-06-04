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
    month: RangeLevels | null;
    year: RangeLevels | null;
    allTime: (RangeLevels & { source: { timeframe: string; candles: number } }) | null;
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
   * Pairs that returned no usable data are dropped (see buildPairContext).
   */
  market: {
    tradable: PairContext[];
    reference: PairContext[];
  };
  account: {
    balances: AssetBalance[];
  };
}

/**
 * Builds the context for one pair, or returns `null` when the pair has no
 * usable data so the caller can drop it. A pair with an empty primary series
 * has nothing worth keeping (no price-derived indicators or levels), so we
 * skip it and warn rather than emit a shell of nulls.
 */
async function buildPairContext(
  publicClient: ReturnType<typeof publicMainnetClient>,
  symbol: string,
  kind: PairKind,
): Promise<PairContext | null> {
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

  if (primaryCandles.length === 0) {
    console.warn(
      `[warn] ${symbol} (${kind}): primary candle series is empty — skipping pair.`,
    );
    return null;
  }

  const at = allTimeLevels(longTermCandles);
  if (!at) {
    console.warn(
      `[warn] ${symbol} (${kind}): long-term series is empty — ATH/ATL unavailable.`,
    );
  }

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
      allTime: at
        ? {
            ...at,
            source: {
              timeframe: config.longTermTimeframe,
              candles: longTermCandles.length,
            },
          }
        : null,
    },
  };
}

/**
 * Wraps buildPairContext so a single pair throwing (network error, bad
 * symbol, missing ticker…) cannot bring down the entire run — it is logged
 * and dropped, and the other pairs still produce context.
 */
async function safeBuildPair(
  publicClient: ReturnType<typeof publicMainnetClient>,
  symbol: string,
  kind: PairKind,
): Promise<PairContext | null> {
  try {
    return await buildPairContext(publicClient, symbol, kind);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] ${symbol} (${kind}): failed to read market data (${msg}) — skipping pair.`,
    );
    return null;
  }
}

export async function buildMarketContext(): Promise<MarketContext> {
  const publicClient = publicMainnetClient();
  const accountClient = testnetAccountClient();

  const [tradableRaw, referenceRaw, balances] = await Promise.all([
    Promise.all(
      config.tradablePairs.map((symbol) =>
        safeBuildPair(publicClient, symbol, 'tradable'),
      ),
    ),
    Promise.all(
      config.referencePairs.map((symbol) =>
        safeBuildPair(publicClient, symbol, 'reference'),
      ),
    ),
    fetchRelevantBalances(accountClient, tradableAssets(config)),
  ]);

  const isPair = (p: PairContext | null): p is PairContext => p !== null;

  return {
    generatedAt: new Date().toISOString(),
    source: {
      marketData: 'binance-public-mainnet',
      account: 'binance-testnet',
    },
    market: {
      tradable: tradableRaw.filter(isPair),
      reference: referenceRaw.filter(isPair),
    },
    account: { balances },
  };
}
