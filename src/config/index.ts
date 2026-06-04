/**
 * Central configuration for the market data engine.
 * Adding a pair = one line below. Indicator periods and timeframes live here
 * so the core code never needs to be touched to tweak them.
 */

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w' | '1M';

/**
 * Two families of pairs, kept strictly separate:
 *   - 'tradable'  : the bot may take positions on these (under risk
 *                   guardrails, later). Their base assets are balance-tracked.
 *   - 'reference' : watchlist for market context only. Priced and analyzed,
 *                   but NEVER traded, NEVER allocated, NO balance tracked.
 */
export type PairKind = 'tradable' | 'reference';

export interface IndicatorConfig {
  rsiPeriod: number;
  smaPeriods: number[];
  emaPeriods: number[];
}

/**
 * ATH/ATL cache tuning. The two windows are deliberately aligned:
 *
 *   - between re-seeds, the cache is maintained from the live price + the
 *     extremes of the last `maintenanceLookbackCandles` daily candles, which
 *     catches any intraday spike from the recent past (the daily candle
 *     records the day's true high/low even if price reverted since);
 *   - if an entry is older than `stalenessDays`, we re-seed it fully from the
 *     long series. A downtime longer than the lookback therefore triggers a
 *     re-seed that recomputes everything, so no extreme can be lost for good.
 */
export interface CacheConfig {
  stalenessDays: number;
  maintenanceLookbackCandles: number;
}

/**
 * Decision layer (brick 3) tuning. The allocation universe itself is NOT here —
 * it is derived from `tradableAssets()` (tradable base assets + the reserve
 * quote, i.e. USDT), so the assets the AI may allocate to always stay in sync
 * with the tradable pairs above.
 */
export interface DecisionConfig {
  /** Default model when ANTHROPIC_MODEL is unset. Haiku for cheap plumbing tests. */
  defaultModel: string;
  maxTokens: number;
  /** How many recent `decided` rows to feed back for coherence / anti yo-yo. */
  recentDecisionsToLoad: number;
  /** Delay bounds the code clamps the AI's requested next-wake to. */
  minDelayMinutes: number;
  maxDelayMinutes: number;
  /** Allowed deviation from 100 when validating the allocation sum. */
  allocationTolerancePercent: number;
}

/**
 * Risk classes for tradable coins. Caps are configured per class, so adding a
 * coin only means tagging its class — large caps get more rope, small caps a
 * shorter leash. Anything not listed in `coinClass` defaults to 'small'.
 */
export type CoinClass = 'big' | 'small';

/**
 * Execution layer (brick 4) tuning — the economic brain.
 *
 * The bot manages its OWN virtual portfolio valued at real market prices,
 * seeded with `startingCapitalUsd` — deliberately decoupled from the inflated,
 * monthly-reset testnet balances, which are not an economic source of truth.
 */
export interface ExecutionConfig {
  /** Sovereign starting capital in USD (env STARTING_CAPITAL_USD). */
  startingCapitalUsd: number;
  /** Modeled fee per movement, in percent of notional (env FEE_PERCENT). */
  feePercent: number;
  /** Allocation caps the risk wrapper enforces (percent of equity). */
  caps: {
    /** Max % of equity per coin, by risk class. */
    byClass: Record<CoinClass, number>;
    /** Minimum % of equity kept in the reserve stable — sacred capital protection. */
    minCashPercent: number;
  };
  /** Coin → risk class. Unlisted coins default to 'small'. */
  coinClass: Record<string, CoinClass>;
}

export interface AppConfig {
  tradablePairs: string[];
  referencePairs: string[];
  primaryTimeframe: Timeframe;
  primaryLimit: number;
  longTermTimeframe: Timeframe;
  longTermLimit: number;
  indicators: IndicatorConfig;
  cache: CacheConfig;
  decision: DecisionConfig;
  execution: ExecutionConfig;
}

/** Reads a numeric env var, falling back to `fallback` when unset/blank/non-finite. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config: AppConfig = {
  // Pairs the bot may take positions on (subject to risk guardrails, later).
  // Add a tradable pair by appending one line — small caps go here too.
  tradablePairs: ['BTC/USDT', 'ETH/USDT'],

  // Reference-only watchlist: priced and analyzed for market context,
  // never traded, never allocated, no balance tracked.
  referencePairs: ['SOL/USDT', 'BNB/USDT'],

  primaryTimeframe: '1d',
  primaryLimit: 500,

  longTermTimeframe: '1w',
  longTermLimit: 1000,

  indicators: {
    rsiPeriod: 14,
    smaPeriods: [50, 200],
    emaPeriods: [21],
  },

  cache: {
    // Re-seed an entry from the long series once it gets this old (safety net).
    stalenessDays: 30,
    // Recent daily candles scanned to catch intraday extremes between runs.
    maintenanceLookbackCandles: 30,
  },

  decision: {
    // Cheap model for validating the plumbing; switch to 'claude-sonnet-4-6'
    // for real decision quality via the ANTHROPIC_MODEL env var.
    defaultModel: 'claude-haiku-4-5',
    maxTokens: 4096,
    recentDecisionsToLoad: 5,
    minDelayMinutes: 15,
    maxDelayMinutes: 240,
    allocationTolerancePercent: 0.5,
  },

  execution: {
    startingCapitalUsd: envNumber('STARTING_CAPITAL_USD', 500),
    feePercent: envNumber('FEE_PERCENT', 0.1),
    caps: {
      // Revised caps (Julien): big coins get 35%, small caps a shorter 15%,
      // and at least 30% stays in cash — the real capital protection. With only
      // BTC+ETH today (35+35=70) the 30% floor is already implied; the small-cap
      // cap is dormant until a small cap is added.
      byClass: { big: 35, small: 15 },
      minCashPercent: 30,
    },
    coinClass: { BTC: 'big', ETH: 'big' },
  },
};

/** Risk class for a coin (defaults to 'small' — shorter leash — when unlisted). */
export function coinClassOf(asset: string, cfg: AppConfig = config): CoinClass {
  return cfg.execution.coinClass[asset] ?? 'small';
}

/**
 * Assets worth tracking in balances: every side of every tradable pair,
 * which naturally includes the quote currency (e.g. USDT). Reference pairs
 * contribute nothing — we never hold or allocate them.
 *
 * This is the allowlist that filters out the hundreds of unrelated assets
 * the testnet seeds into every account.
 */
export function tradableAssets(cfg: AppConfig = config): Set<string> {
  const assets = new Set<string>();
  for (const pair of cfg.tradablePairs) {
    const [base, quote] = pair.split('/');
    if (base) assets.add(base);
    if (quote) assets.add(quote);
  }
  return assets;
}
