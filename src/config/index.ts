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
    /**
     * Max % of equity PER ASSET — INDEPENDENT caps, deliberately NOT summing to
     * 100. They only stop over-concentration on the more volatile names (the
     * tighter the cap, the shorter the leash); the real COLLECTIVE guard is
     * `minCashPercent`, which bounds total deployed capital. A tradable asset
     * without an explicit cap falls back to `defaultPerAsset`.
     */
    perAsset: Record<string, number>;
    /** Cap for a tradable asset not listed in `perAsset` — the tightest leash. */
    defaultPerAsset: number;
    /** Minimum % of equity kept in the reserve stable — the sacred collective guard. */
    minCashPercent: number;
  };
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

// Sane bounds (seconds) for an env-overridable scheduler DURATION: a positive
// integer up to a day. Generous for ops, far within PostgreSQL's int4, and enough
// to reject typos/garbage. The cross-relation lockTtl > maxCycle + grace is a
// SEPARATE check in validateSchedulerConfig.
const SCHED_SECONDS_MIN = 1;
const SCHED_SECONDS_MAX = 86_400;

/**
 * Reads a SCHEDULER duration override (seconds) from the environment, FAIL-LOUD on
 * anything the SQL layer or the watchdog can't honor. Unset/blank → the default (an
 * absent override, not an error). A SET value MUST be an integer in
 * [SCHED_SECONDS_MIN, SCHED_SECONDS_MAX]: the scheduler RPCs (claim_due_run /
 * claim_manual_run) declare these params as SQL `integer` seconds, so a fractional,
 * non-numeric (NaN), zero, negative, or out-of-range override would be rejected by
 * PostgREST at claim time (or overflow int4) and silently break every cycle at
 * RUNTIME. We close the whole class at STARTUP instead — like the capital reader,
 * the condition is exhaustive, not patched case by case. Exported for the offline test.
 */
export function schedulerSecondsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < SCHED_SECONDS_MIN || n > SCHED_SECONDS_MAX) {
    throw new Error(
      `Invalid scheduler override ${name}="${raw}": must be a positive INTEGER number of seconds ` +
        `in [${SCHED_SECONDS_MIN}, ${SCHED_SECONDS_MAX}]. The scheduler RPCs take SQL integer seconds, ` +
        `so a fractional / non-numeric / zero / negative / out-of-range value would break every claim ` +
        `at runtime — failing loud at startup instead. Unset ${name} to use the default (${fallback}).`,
    );
  }
  return n;
}

export const config: AppConfig = {
  // Pairs the bot may take positions on (subject to the risk caps). Add a tradable
  // pair by appending one line AND giving it a cap in execution.caps.perAsset.
  // Universe (4 assets): BTC + ETH (the core), BNB (promoted from watchlist), XRP
  // (a lower-BTC-correlation, payments-narrative name). All four verified TRADING
  // on the Binance testnet (status + LOT_SIZE/PRICE_FILTER/NOTIONAL filters), since
  // the bot decides on mainnet but EXECUTES on testnet.
  tradablePairs: ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'XRP/USDT'],

  // Reference-only watchlist: priced and analyzed for market context,
  // never traded, never allocated, no balance tracked.
  referencePairs: ['SOL/USDT'],

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
      // Per-asset caps (Julien's explicit guard-rail — do not change without asking).
      // INDEPENDENT limits, deliberately NOT summing to 100: BTC/ETH are the core
      // (35), BNB a notch tighter (20), XRP the shortest leash (15). The real
      // COLLECTIVE guard is the 30% cash floor below, which bounds total deployed
      // capital to 70% — so 35+35+20+15=105 of cap headroom never deploys past 70%.
      // Any surplus a proposal puts above a cap is trimmed back to CASH (never to
      // another coin), as before.
      perAsset: { BTC: 35, ETH: 35, BNB: 20, XRP: 15 },
      // A tradable asset added without its own cap falls back here — the tightest
      // leash, so a forgotten cap is safe (never looser than the smallest).
      defaultPerAsset: 15,
      minCashPercent: 30,
    },
  },

  scheduler: {
    // Railway's native cron beats every 5 min (wired in the deploy PR).
    beatIntervalMinutes: 5,
    // Worst-case cycle budget + run-lock TTL. The external timeouts (binance.ts
    // ~15s/req, llm.ts 60s × 1 retry) keep a real cycle well under the budget; the
    // lock TTL exceeds it (invariant validated below). Both are env-overridable so
    // the watchdog/lock timing can be shrunk for a live proof (and tuned in ops)
    // without a code change — the prod defaults (300 / 600) are unchanged. Each
    // override is validated as a positive INTEGER of seconds in a sane range
    // (schedulerSecondsEnv): the SQL RPCs take integer seconds, so a fractional /
    // garbage value fails loud at startup instead of breaking a claim at runtime.
    maxCycleSeconds: schedulerSecondsEnv('MAX_CYCLE_SECONDS', 300),
    lockTtlSeconds: schedulerSecondsEnv('LOCK_TTL_SECONDS', 600),
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
  if (!(caps.defaultPerAsset >= 0 && caps.defaultPerAsset <= 100)) {
    problems.push(`caps.defaultPerAsset must be in [0, 100] (got ${caps.defaultPerAsset})`);
  }
  for (const [asset, cap] of Object.entries(caps.perAsset)) {
    if (!(cap >= 0 && cap <= 100)) {
      problems.push(`caps.perAsset.${asset} must be in [0, 100] (got ${cap})`);
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
