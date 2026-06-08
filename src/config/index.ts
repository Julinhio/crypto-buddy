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

/**
 * Scheduler (heartbeat) tuning. A fixed external cron beats the entry point every
 * `beatIntervalMinutes`; the state machine turns that into a variable cadence.
 *
 * The load-bearing safety relation is `lockTtlSeconds > maxCycleSeconds +
 * WATCHDOG_GRACE_SECONDS`: the lease must outlive not just the cycle budget but the
 * WATCHDOG's force-exit deadline (budget + grace). Otherwise a slow-but-alive run's
 * lease could expire — and be reclaimed by a parallel beat — in the window before
 * the watchdog kills the orphan, running a SECOND concurrent cycle (and a second
 * order). The fencing token stops state corruption, not two concurrent executions —
 * so we bound the external calls (see binance.ts / llm.ts timeouts), keep the lease
 * longer than budget + grace, AND force-exit before the lease expires.
 */
export interface SchedulerConfig {
  /** The external cron cadence, in minutes (used for missed-beat accounting). */
  beatIntervalMinutes: number;
  /** Declared worst-case cycle budget. MUST stay above the sum of external timeouts. */
  maxCycleSeconds: number;
  /** Run-lock TTL. MUST exceed maxCycleSeconds + WATCHDOG_GRACE_SECONDS so the
   *  watchdog force-exits the orphan before the lease can expire and be reclaimed. */
  lockTtlSeconds: number;
  /** Reschedule delay after a soft skip (no usable data / nothing actionable). */
  softSkipDelayMinutes: number;
}

/**
 * Alerting (heartbeat safety net) tuning. An emergency net that should almost
 * never fire: ONE Telegram alert when a health counter crosses its threshold, then
 * silence until it re-arms. Thresholds are named here so they're trivial to adjust.
 *
 * The secrets themselves (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / HEALTHCHECKS_PING_URL)
 * are NOT here — like the Supabase/Anthropic keys, they're read from the environment
 * at call time so nothing sensitive lives in committed config.
 */
export interface AlertingConfig {
  /** Overheating: alert once floor_delay_streak reaches this many decided cycles. */
  floorStreakThreshold: number;
  /** Degraded: alert once consecutive_failures reaches this many hard errors. */
  consecutiveFailuresThreshold: number;
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
  scheduler: SchedulerConfig;
  alerting: AlertingConfig;
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

  scheduler: {
    // Railway's native cron beats every 5 min (wired in the deploy PR).
    beatIntervalMinutes: 5,
    // Worst-case cycle budget + run-lock TTL. The external timeouts (binance.ts
    // ~15s/req, llm.ts 60s × 1 retry) keep a real cycle well under the budget; the
    // lock TTL exceeds it (invariant validated below). Both are env-overridable so
    // the watchdog/lock timing can be shrunk for a live proof (and tuned in ops)
    // without a code change — the prod defaults (300 / 600) are unchanged.
    maxCycleSeconds: envNumber('MAX_CYCLE_SECONDS', 300),
    lockTtlSeconds: envNumber('LOCK_TTL_SECONDS', 600),
    // Soft skip → a modest fixed retry; backoff (hard errors) reuses the decision
    // delay bounds (min 15 / max 240).
    softSkipDelayMinutes: 30,
  },

  alerting: {
    // Overheating: 10 decided cycles in a row at the 15-min floor → the AI is
    // hammering the floor. Degraded: 3 hard errors in a row → the bot beats but
    // its cycle keeps failing. Both are easy to retune from here.
    floorStreakThreshold: 10,
    consecutiveFailuresThreshold: 3,
  },
};

/** Risk class for a coin (defaults to 'small' — shorter leash — when unlisted). */
export function coinClassOf(asset: string, cfg: AppConfig = config): CoinClass {
  return cfg.execution.coinClass[asset] ?? 'small';
}

/**
 * Fails fast on an incoherent execution config so the risk wrapper's invariants
 * hold BY CONSTRUCTION. In particular, the cash-floor pass can only produce a
 * negative scale when `minCashPercent >= 100` (since the allocation sums to 100,
 * `coinTotal − deficit = 100 − minCashPercent`); forbidding that here is cleaner
 * than guarding an impossible case at runtime.
 */
function validateExecutionConfig(cfg: ExecutionConfig): void {
  const { startingCapitalUsd, feePercent, caps } = cfg;
  const problems: string[] = [];
  if (!(startingCapitalUsd > 0)) {
    problems.push(`startingCapitalUsd must be > 0 (got ${startingCapitalUsd})`);
  }
  if (!(feePercent >= 0 && feePercent < 100)) {
    problems.push(`feePercent must be in [0, 100) (got ${feePercent})`);
  }
  if (!(caps.minCashPercent > 0 && caps.minCashPercent < 100)) {
    problems.push(`caps.minCashPercent must be in (0, 100) (got ${caps.minCashPercent})`);
  }
  for (const [cls, cap] of Object.entries(caps.byClass)) {
    if (!(cap >= 0 && cap <= 100)) {
      problems.push(`caps.byClass.${cls} must be in [0, 100] (got ${cap})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid execution config: ${problems.join('; ')}`);
  }
}

validateExecutionConfig(config.execution);

/**
 * Grace added to the cycle budget for the watchdog's force-exit deadline (see
 * armCycleWatchdog in scheduler/cycleGuard.ts, which imports this). It is the SINGLE
 * source of the grace so the timer and the invariant below can never drift: the
 * watchdog fires at maxCycleSeconds + this, and the lease TTL must exceed that.
 */
export const WATCHDOG_GRACE_SECONDS = 15;

/**
 * Fails fast on an unsafe scheduler config. The critical invariant is
 * `lockTtlSeconds > maxCycleSeconds + WATCHDOG_GRACE_SECONDS`: the watchdog only
 * force-exits the process (killing the timed-out orphan) at budget + grace, so if
 * the lease expired any earlier a parallel beat could reclaim it and run a second
 * concurrent cycle — and place a second order — while the orphan is still alive.
 * Checking merely `> maxCycleSeconds` would leave that grace-wide window open (now
 * reachable via the MAX_CYCLE_SECONDS / LOCK_TTL_SECONDS env overrides). Exported
 * for the offline test.
 */
export function validateSchedulerConfig(cfg: SchedulerConfig): void {
  const problems: string[] = [];
  if (!(cfg.beatIntervalMinutes > 0)) {
    problems.push(`beatIntervalMinutes must be > 0 (got ${cfg.beatIntervalMinutes})`);
  }
  if (!(cfg.maxCycleSeconds > 0)) {
    problems.push(`maxCycleSeconds must be > 0 (got ${cfg.maxCycleSeconds})`);
  }
  if (!(cfg.lockTtlSeconds > cfg.maxCycleSeconds + WATCHDOG_GRACE_SECONDS)) {
    problems.push(
      `lockTtlSeconds (${cfg.lockTtlSeconds}) must exceed maxCycleSeconds + the watchdog grace ` +
        `(${cfg.maxCycleSeconds} + ${WATCHDOG_GRACE_SECONDS} = ${cfg.maxCycleSeconds + WATCHDOG_GRACE_SECONDS}) ` +
        `so the watchdog force-exits the orphan BEFORE the lease can expire and be reclaimed`,
    );
  }
  if (!(cfg.softSkipDelayMinutes > 0)) {
    problems.push(`softSkipDelayMinutes must be > 0 (got ${cfg.softSkipDelayMinutes})`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid scheduler config: ${problems.join('; ')}`);
  }
}

validateSchedulerConfig(config.scheduler);

/**
 * Fails fast on a nonsensical alerting config. Thresholds must be >= 1, otherwise a
 * counter would be "at or above" from its very first tick and the alert would fire
 * (or be permanently suppressed) without any real crossing.
 */
function validateAlertingConfig(cfg: AlertingConfig): void {
  const problems: string[] = [];
  if (!(Number.isInteger(cfg.floorStreakThreshold) && cfg.floorStreakThreshold >= 1)) {
    problems.push(`floorStreakThreshold must be an integer >= 1 (got ${cfg.floorStreakThreshold})`);
  }
  if (!(Number.isInteger(cfg.consecutiveFailuresThreshold) && cfg.consecutiveFailuresThreshold >= 1)) {
    problems.push(`consecutiveFailuresThreshold must be an integer >= 1 (got ${cfg.consecutiveFailuresThreshold})`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid alerting config: ${problems.join('; ')}`);
  }
}

validateAlertingConfig(config.alerting);

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
