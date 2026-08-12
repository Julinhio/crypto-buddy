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
import {
  captureHttpErrors,
  errorClassOf,
  parseCcxtMessage,
  type HttpErrorTrace,
} from '../exchanges/errorCapture.js';
import type { MarketFailure } from '../persistence/marketDataIncidents.js';
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

/**
 * THE SECOND HEALTH STATE, as this cycle measured it.
 *
 * "The scheduler is alive" and "the bot can see the market" are two different questions
 * that used to be one. On 09/08 the first was TRUE for 23 hours — the bot really was
 * waking up, and the dead-man's switch was right to stay green — while the second was
 * false 31 times, and nothing anywhere recorded it.
 *
 * This is the raw material for the second answer. It carries no verdict of its own: the
 * scheduler turns it into a counter, the alert reads the counter, and the incident writer
 * turns the failures into a durable row.
 */
export interface MarketDataHealth {
  /**
   * TRUE when no tradable pair returned usable data — the 09/08 signature, and the exact
   * condition the existing fail-closed already refuses to decide on. Deliberately the
   * SAME predicate as `context.market.tradable.length === 0` rather than a parallel one,
   * so the alert can never disagree with the behaviour it is reporting on.
   */
  blind: boolean;
  /** Every configured pair the cycle tried to read (tradable + reference). */
  attempted: number;
  /** Pairs actually LOST — the brief's "nombre de marchés affectés". */
  lost: number;
  /** Every failed read, including the contained ones that did not drop their pair. */
  failures: MarketFailure[];
  /** HTTP-level detail for the failing responses: status, endpoint, Retry-After. */
  httpTraces: HttpErrorTrace[];
  /** Traces dropped at the capture cap — 0 in any realistic cycle. */
  tracesDropped: number;
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
  /**
   * What the market read cost this cycle — see MarketDataHealth.
   *
   * Kept OUT of `DecisionContext`, like the regime and the transition read before it, and
   * for the sharper of the two reasons: this is pure observability, so the model must not
   * see it and `decisions.market_context` must stay byte-identical. An A/B over the same
   * window proves it did (see the PR's proof).
   */
  dataHealth: MarketDataHealth;
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
  record?: (err: unknown) => void,
): Promise<Candle[]> {
  try {
    return await fetch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] ${label}: tactical series fetch failed (${msg}) — the pair keeps its place in ` +
        'the context and only sits out of the regime read.',
    );
    // Journaled, never acted on: the containment above is unchanged and the pair still
    // keeps its place. `record` is optional so the offline test that proves that
    // containment keeps calling this with two arguments.
    record?.(err);
    return [];
  }
}

/** Enough of a ccxt message to identify the fault; not enough to bloat a JSONB column. */
const MAX_FAILURE_MESSAGE_CHARS = 500;

/**
 * Accumulates this cycle's failed market reads. One instance per `buildMarketContext`
 * call, so its lifetime is the cycle's and there is nothing to reset between runs.
 *
 * Purely additive: nothing here can change what a pair build returns. It is handed down
 * as a callback rather than consulted, so the read path cannot branch on it.
 */
class FailureCollector {
  readonly failures: MarketFailure[] = [];

  record(
    symbol: string,
    kind: PairKind,
    stage: MarketFailure['stage'],
    dropped: boolean,
    err: unknown,
  ): void {
    const message = err instanceof Error ? err.message : String(err);
    // The HTTP hook is the authoritative source for status/endpoint; this parse is the
    // fallback for a transport-level failure, where no response ever existed.
    const parsed = parseCcxtMessage(message);
    this.failures.push({
      symbol,
      kind,
      stage,
      dropped,
      errorClass: errorClassOf(err),
      httpStatus: parsed.httpStatus,
      endpoint: parsed.endpoint,
      message: message.slice(0, MAX_FAILURE_MESSAGE_CHARS),
    });
  }

  /** The no-exception case: ccxt returned an empty OHLCV array and nothing was thrown. */
  recordEmptyPrimary(symbol: string, kind: PairKind): void {
    this.failures.push({
      symbol,
      kind,
      stage: 'primary',
      dropped: true,
      errorClass: 'EmptyPrimarySeries',
      httpStatus: null,
      endpoint: null,
      message:
        'the primary candle series came back empty with no exception — the pair was dropped',
    });
  }

  /** Pairs actually LOST. A contained tactical failure never counts here. */
  get lost(): number {
    return this.failures.filter((f) => f.dropped).length;
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
  collector: FailureCollector,
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
      (err) => collector.record(symbol, kind, 'tactical', false, err),
    ),
  ]);

  if (primaryCandles.length === 0) {
    console.warn(
      `[warn] ${symbol} (${kind}): primary candle series is empty — skipping pair.`,
    );
    // The pair vanishes here WITHOUT any exception having been thrown — ccxt returns an
    // empty array rather than raising. Before this PR that made a whole class of outage
    // invisible: no error to log, no error to journal, just a pair that quietly stopped
    // existing. Recorded explicitly so "no error" never again means "nothing happened".
    collector.recordEmptyPrimary(symbol, kind);
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
  collector: FailureCollector,
): Promise<BuiltPair | null> {
  try {
    return await buildPairContext(publicClient, supabase, symbol, kind, collector);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[warn] ${symbol} (${kind}): failed to read market data (${msg}) — skipping pair.`,
    );
    // THE LINE THIS PR EXISTS FOR. This catch is where the 09/08 outage went to die: it
    // logged the real error — class, HTTP status, endpoint — to a `console.warn` that
    // Railway does not retain, and returned null. Twenty-three hours later all that was
    // left was `status=skipped`. The error now survives the process.
    collector.record(symbol, kind, 'pair', true, err);
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

  // Instrument the PUBLIC client only — it is the one whose failure blinds the bot, and
  // the one this PR is about. The testnet account client is untouched. The wrapper always
  // delegates and swallows its own faults, so it cannot change a single market read; see
  // exchanges/errorCapture.ts.
  const readHttpErrors = captureHttpErrors(publicClient);
  const collector = new FailureCollector();

  const [tradableRaw, referenceRaw, balances] = await Promise.all([
    Promise.all(
      config.tradablePairs.map((symbol) =>
        safeBuildPair(publicClient, supabase, symbol, 'tradable', collector),
      ),
    ),
    Promise.all(
      config.referencePairs.map((symbol) =>
        safeBuildPair(publicClient, supabase, symbol, 'reference', collector),
      ),
    ),
    fetchRelevantBalances(accountClient, tradableAssets(config)),
  ]);

  const isPair = (p: BuiltPair | null): p is BuiltPair => p !== null;
  const tradable = tradableRaw.filter(isPair);
  const reference = referenceRaw.filter(isPair);

  const captured = readHttpErrors();

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
    dataHealth: {
      // THE SAME PREDICATE the fail-closed already uses, read off the same array rather
      // than recomputed from the failure list. A parallel definition could disagree with
      // the behaviour it reports on — e.g. every read "succeeding" while returning junk
      // that the pair builder then drops — and an alert that disagrees with the bot is
      // worse than no alert.
      blind: tradable.length === 0,
      attempted: config.tradablePairs.length + config.referencePairs.length,
      lost: collector.lost,
      failures: collector.failures,
      httpTraces: captured.traces,
      tracesDropped: captured.dropped,
    },
  };
}
