import type { SupabaseClient } from '@supabase/supabase-js';
import {
  config,
  tradableAssets,
  type PairKind,
} from '../config/index.js';
import { publicMainnetClient, testnetAccountClient } from '../exchanges/binance.js';
import { fetchCandles, fetchSpotPrice } from '../market/klines.js';
import { computeIndicators, type IndicatorSnapshot } from '../market/indicators.js';
import { monthLevels, yearLevels, type RangeLevels } from '../market/levels.js';
import {
  resolveRegimes,
  toRegimeJournal,
  type AssetSeries,
  type RegimeJournal,
} from '../market/regime.js';
import { fetchRelevantBalances, type AssetBalance } from '../account/balances.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import {
  resolveAllTimeLevels,
  type AllTimeLevels,
} from '../persistence/athAtlCache.js';

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
    // Served from the Supabase cache (or a long-series fallback). See
    // src/persistence/athAtlCache.ts.
    allTime: AllTimeLevels | null;
  };
}

export interface MarketContext {
  generatedAt: string;
  source: {
    marketData: 'binance-public-mainnet';
    account: 'binance-testnet';
  };
  /**
   * The CODE's market regime, per asset, plus the global risk_off posture — computed
   * from the daily structure and the 4h tactical horizon (mandate V2 §1-2). It is a
   * FACT handed to the system, never something the model declares.
   *
   * SHADOW MODE (PR 1): it is journaled on every cycle but deliberately kept OUT of
   * `DecisionContext` — the model does not see it, so the bot's decision behavior is
   * byte-for-byte what it was. It becomes an input to the mandate only with the v5
   * prompt, behind `STRATEGY_VERSION`.
   *
   * Null when no asset returned both series (never a reason to fail a cycle).
   */
  regime: RegimeJournal | null;
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

/** A built pair: what the context exposes, plus the raw series the regime needs. */
interface BuiltPair {
  context: PairContext;
  /** Null when the 4h series came back empty — the pair then sits out of the regime. */
  series: AssetSeries | null;
}

/**
 * Builds the context for one pair, or returns `null` when the pair has no
 * usable data so the caller can drop it. A pair with an empty primary series
 * has nothing worth keeping (no price-derived indicators or levels), so we
 * skip it and warn rather than emit a shell of nulls.
 */
async function buildPairContext(
  publicClient: ReturnType<typeof publicMainnetClient>,
  supabase: SupabaseClient | null,
  symbol: string,
  kind: PairKind,
): Promise<BuiltPair | null> {
  // The long weekly series is NOT fetched here anymore. It is pulled lazily by
  // the cache (only on seed / re-seed / fallback) via the thunk below, so a
  // normal cached run touches only the spot price and the daily series.
  //
  // The 4h series is the TACTICAL horizon (mandate §2): the daily read barely moves
  // between two wake-ups, so it alone can only produce repetition. It is fetched
  // alongside the daily one, and an empty 4h series costs the pair its regime — never
  // the whole cycle.
  const [price, primaryCandles, h4Candles] = await Promise.all([
    fetchSpotPrice(publicClient, symbol),
    fetchCandles(
      publicClient,
      symbol,
      config.primaryTimeframe,
      config.primaryLimit,
    ),
    fetchCandles(publicClient, symbol, config.regime.timeframe, config.regime.limit),
  ]);

  if (primaryCandles.length === 0) {
    console.warn(
      `[warn] ${symbol} (${kind}): primary candle series is empty — skipping pair.`,
    );
    return null;
  }

  if (h4Candles.length === 0) {
    console.warn(
      `[warn] ${symbol} (${kind}): ${config.regime.timeframe} series is empty — the pair is excluded from the regime read.`,
    );
  }

  const allTime = await resolveAllTimeLevels({
    supabase,
    symbol,
    livePrice: price,
    primaryCandles,
    longTermTimeframe: config.longTermTimeframe,
    fetchLongTerm: () =>
      fetchCandles(
        publicClient,
        symbol,
        config.longTermTimeframe,
        config.longTermLimit,
      ),
    cache: config.cache,
  });

  return {
    context: {
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
        allTime,
      },
    },
    series: h4Candles.length > 0 ? { daily: primaryCandles, h4: h4Candles } : null,
  };
}

/**
 * Wraps buildPairContext so a single pair throwing (network error, bad
 * symbol, missing ticker…) cannot bring down the entire run — it is logged
 * and dropped, and the other pairs still produce context.
 */
async function safeBuildPair(
  publicClient: ReturnType<typeof publicMainnetClient>,
  supabase: SupabaseClient | null,
  symbol: string,
  kind: PairKind,
): Promise<BuiltPair | null> {
  try {
    return await buildPairContext(publicClient, supabase, symbol, kind);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] ${symbol} (${kind}): failed to read market data (${msg}) — skipping pair.`,
    );
    return null;
  }
}

/**
 * The regime read for this cycle — best-effort by design. A regime the bot cannot
 * compute must degrade to "no regime journaled", never to a failed cycle: in shadow
 * mode nothing downstream depends on it, and even later a missing regime is
 * information, not a crash.
 *
 * The universe spans TRADABLE **and** REFERENCE pairs on purpose. Per-asset regimes
 * are only read for the tradable ones, but the risk_off breadth is a market-wide
 * measure — SOL belongs in the breadth even though the bot never allocates to it.
 */
function readRegime(pairs: BuiltPair[]): RegimeJournal | null {
  const universe: Record<string, AssetSeries> = {};
  for (const p of pairs) {
    const base = p.context.symbol.split('/')[0];
    if (base && p.series) universe[base] = p.series;
  }
  if (Object.keys(universe).length === 0) {
    console.warn('[warn] no pair had a usable 4h series — no regime computed this cycle.');
    return null;
  }
  try {
    const point = resolveRegimes(universe, config.regime.thresholds);
    if (!point) {
      console.warn('[warn] the pairs share no common 4h bar — no regime computed this cycle.');
      return null;
    }
    return toRegimeJournal(point);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[warn] regime computation failed (${msg}) — no regime journaled this cycle.`);
    return null;
  }
}

export async function buildMarketContext(): Promise<MarketContext> {
  const publicClient = publicMainnetClient();
  const accountClient = testnetAccountClient();
  const supabase = getSupabaseClient();

  const [tradableRaw, referenceRaw, balances] = await Promise.all([
    Promise.all(
      config.tradablePairs.map((symbol) =>
        safeBuildPair(publicClient, supabase, symbol, 'tradable'),
      ),
    ),
    Promise.all(
      config.referencePairs.map((symbol) =>
        safeBuildPair(publicClient, supabase, symbol, 'reference'),
      ),
    ),
    fetchRelevantBalances(accountClient, tradableAssets(config)),
  ]);

  const isPair = (p: BuiltPair | null): p is BuiltPair => p !== null;
  const tradable = tradableRaw.filter(isPair);
  const reference = referenceRaw.filter(isPair);

  return {
    generatedAt: new Date().toISOString(),
    source: {
      marketData: 'binance-public-mainnet',
      account: 'binance-testnet',
    },
    regime: readRegime([...tradable, ...reference]),
    market: {
      tradable: tradable.map((p) => p.context),
      reference: reference.map((p) => p.context),
    },
    account: { balances },
  };
}
