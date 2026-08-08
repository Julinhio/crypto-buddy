import type { SupabaseClient } from '@supabase/supabase-js';
import {
  config,
  tradableAssets,
  type PairKind,
} from '../config/index.js';
import { publicMainnetClient, testnetAccountClient } from '../exchanges/binance.js';
import { fetchCandles, fetchSpotPrice, timeframeMs, type Candle } from '../market/klines.js';
import { computeIndicators, type IndicatorSnapshot } from '../market/indicators.js';
import { monthLevels, yearLevels, type RangeLevels } from '../market/levels.js';
import {
  regimeTimeline,
  toRegimeJournal,
  type AssetSeries,
  type RegimeJournal,
} from '../market/regime.js';
import { stickyTimelines, type StickyPoint } from '../market/transition.js';
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

/** The transition layer's read for one cycle: the bar it used, and the state per asset. */
export interface TransitionRead {
  /** The 4h bar every state below was computed on. */
  barAtMs: number;
  /** Sticky state per asset AT that bar. An asset whose walk ended earlier is omitted. */
  perAsset: Record<string, StickyPoint>;
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
   * The TRANSITION LAYER's read for this cycle: per asset, whether its raw regime has
   * held long enough to be actionable (see src/market/transition.ts).
   *
   * Deliberately kept OUT of `DecisionContext`, exactly as the regime was in its own
   * shadow phase — and here the reason is sharper than convention. This PR MEASURES what
   * the gate would do while the model keeps deciding as before; if the payload changed at
   * the same time, nothing observed could be attributed to the gate rather than to the
   * new field. `decisions.market_context` therefore stays byte-identical too, since it
   * stores the DecisionContext and not this.
   *
   * Null under the same conditions as `regime`: no usable 4h series, or no closed bar in
   * common. A missing read is information, never a crash.
   */
  transition: TransitionRead | null;
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
 * Runs the SHADOW tactical fetch with its failure contained: any rejection becomes an
 * empty series, never a thrown error.
 *
 * This containment is load-bearing, not defensive habit. If the 4h fetch rejected
 * inside the pair's `Promise.all`, the whole pair build would reject, `safeBuildPair`
 * would drop the pair, and the pair would vanish from the LLM's context AND from
 * `allocatableUniverse` — a shadow-only feature silently changing what the model may
 * allocate to. Shadow mode has to mean the live path cannot notice the regime layer,
 * including when the regime layer breaks. Exported so that guarantee is testable
 * without a network.
 */
export async function fetchTacticalSeries(
  fetch: () => Promise<Candle[]>,
  label: string,
): Promise<Candle[]> {
  try {
    return await fetch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] ${label}: tactical series fetch failed (${msg}) — the pair keeps its place in ` +
        'the context and only sits out of the regime read.',
    );
    return [];
  }
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
  // between two wake-ups, so it alone can only produce repetition. Its failure is
  // contained by fetchTacticalSeries — see the guarantee documented there.
  const [price, primaryCandles, h4Result] = await Promise.all([
    fetchSpotPrice(publicClient, symbol),
    fetchCandles(
      publicClient,
      symbol,
      config.primaryTimeframe,
      config.primaryLimit,
    ),
    fetchTacticalSeries(
      () => fetchCandles(publicClient, symbol, config.regime.timeframe, config.regime.limit),
      `${symbol} (${kind}) ${config.regime.timeframe}`,
    ),
  ]);

  if (primaryCandles.length === 0) {
    console.warn(
      `[warn] ${symbol} (${kind}): primary candle series is empty — skipping pair.`,
    );
    return null;
  }

  if (h4Result.length === 0) {
    console.warn(
      `[warn] ${symbol} (${kind}): no ${config.regime.timeframe} candles — the pair is excluded from the regime read.`,
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
    series: h4Result.length > 0 ? { daily: primaryCandles, h4: h4Result } : null,
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
function readRegime(pairs: BuiltPair[]): { regime: RegimeJournal | null; transition: TransitionRead | null } {
  const nothing = { regime: null, transition: null };
  const universe: Record<string, AssetSeries> = {};
  for (const p of pairs) {
    const base = p.context.symbol.split('/')[0];
    if (base && p.series) universe[base] = p.series;
  }
  if (Object.keys(universe).length === 0) {
    console.warn('[warn] no pair had a usable 4h series — no regime computed this cycle.');
    return nothing;
  }
  try {
    // The TIMELINE, not just its last point, because the sticky rule needs the run of
    // identical raw labels ending at this bar — and that run is NOT recoverable from the
    // journaled fields. `pendingBars` counts a CANDIDATE's streak and is 0 whenever the
    // raw label equals the active one, so a bar sitting two readings into a confirmed
    // regime and a bar fifty readings into it are indistinguishable there. Cycle 1061 is
    // exactly that case: raw == confirmed == reversal_down, `pendingBars` 0, sticky run 2.
    //
    // `resolveRegimes` is `regimeTimeline` followed by "take the last point", so reading
    // the last point here produces the SAME journal it did — byte for byte, by
    // construction rather than by inspection (asserted in src/test/transitionLayer.ts).
    const timeline = regimeTimeline(universe, config.regime.thresholds, {
      nowMs: Date.now(),
      barMs: timeframeMs(config.regime.timeframe),
      // The CONFIGURED universe, not what loaded — a pair whose series failed must not
      // shrink the risk_off breadth denominator (see RegimeOptions.universeSize).
      universeSize: config.tradablePairs.length + config.referencePairs.length,
    });
    const point = timeline[timeline.length - 1];
    if (!point) {
      console.warn(
        '[warn] the pairs share no CLOSED 4h bar in common — no regime computed this cycle.',
      );
      return nothing;
    }

    const sticky = stickyTimelines(timeline, config.regime.thresholds.confirmations, timeframeMs(config.regime.timeframe));
    const perAsset: Record<string, StickyPoint> = {};
    for (const [asset, walk] of Object.entries(sticky)) {
      const last = walk[walk.length - 1];
      // Only the walk that actually ends on this cycle's bar. An asset whose series stops
      // short would otherwise contribute a stale verdict dated to an older bar.
      if (last && last.timestamp === point.timestamp) perAsset[asset] = last;
    }

    return {
      regime: toRegimeJournal(point),
      transition: { barAtMs: point.timestamp, perAsset },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[warn] regime computation failed (${msg}) — no regime journaled this cycle.`);
    return nothing;
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
    ...readRegime([...tradable, ...reference]),
    market: {
      tradable: tradable.map((p) => p.context),
      reference: reference.map((p) => p.context),
    },
    account: { balances },
  };
}
