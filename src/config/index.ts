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
  /**
   * HARD wall-clock bound on ONE LLM attempt, in seconds. The coherence guard adds a
   * second call inside the same cycle, so a blocked network call must not be able to
   * eat the 300s budget on its own. Enforced in the decision layer (a race against a
   * timer) rather than left to the SDK's timeout × retries arithmetic, which multiplies.
   */
  attemptTimeoutSeconds: number;
  /**
   * Seconds kept in reserve, after the last attempt, for what still has to happen:
   * journaling the decision, sizing and placing the orders, and writing the lifecycle
   * state. The second attempt is only started if it fits inside the budget WITH this
   * reserve still intact — otherwise the cycle fails cleanly before the watchdog kills it.
   */
  retryReserveSeconds: number;
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
  /**
   * PLUMBING FLOOR (mandate V2 §5): the minimum size of a movement, as a percent of
   * EQUITY. Anything smaller is discarded before it can reach the executor.
   *
   * This is a hard code-side rule, not a strategic norm — the strategic one ("at least
   * 2% of capital AND at least 25% of the position touched") is stated to the model and
   * arrives with the v5 prompt. They cannot contradict each other: the strategic norm
   * is strictly the more demanding of the two.
   *
   * Sized against the observed damage: 3128 of 3143 intents over 47 days were rejected
   * for being too small — 2324 under Binance's $5 min-notional and 804 with a quantity
   * snapped to zero at the lot step. At ~$1000 of equity this floor is ~$20: four times
   * the min-notional, and far above the coarsest lot step of the four assets (< $1), so
   * it structurally closes BOTH families rather than the larger one only.
   */
  minMovementPercent: number;
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

/**
 * Daily Telegram summary (the once-a-day overview). The bot runs in UTC, but "9h"
 * and the header date are in JULIEN's local time, so the timezone is configurable
 * via DAILY_SUMMARY_TZ (he may change country). Validated at startup (a bad IANA
 * zone fails loud, not silently at 9h).
 */
export interface DailySummaryConfig {
  /** IANA timezone for "9h" and the header date, e.g. 'Europe/Paris' (env DAILY_SUMMARY_TZ). */
  timezone: string;
  /** Send once per local day at/after this local hour [0, 23]. */
  sendAtHourLocal: number;
}

/**
 * Thresholds of the CODE-side market-regime classifier (mandate V2 §1). Every number
 * the classification depends on lives here — nothing is hardcoded in the calculator —
 * so a threshold can be re-tuned against the replay harness without touching logic.
 */
export interface RegimeThresholds {
  /** Consecutive 4h bars a candidate label must hold before it replaces the active one. */
  confirmations: number;
  /** Closed daily bars defining the STRUCTURAL range (mandate §1: distance to the month's extremes). */
  rangeWindowDays: number;
  /** Closed 4h bars defining the TACTICAL range (mandate §2: position in the recent 4h range). */
  h4RangeBars: number;
  /** 4h RSI at or above which 4h momentum counts as UP. */
  h4RsiUp: number;
  /** 4h RSI at or below which 4h momentum counts as DOWN. */
  h4RsiDown: number;
  /** Range position at or above which the asset is "high in its range" (0..1). */
  highRangePosition: number;
  /** Range position at or below which the asset is "low in its range" (0..1). */
  lowRangePosition: number;
  /**
   * TACTICAL range position at or below which a DOWN move counts as already paid —
   * `pullbackConsumed`. A reversal_down whose drop has already happened is an
   * accumulation zone, not a profit-take.
   */
  pullbackConsumedPosition: number;
  /**
   * TACTICAL range position at or above which an UP move counts as already paid —
   * `bounceConsumed`. The mirror: a reversal_up whose bounce has already happened is
   * not something to chase.
   */
  bounceConsumedPosition: number;
  /** Daily RSI below which an asset counts as bearish for the risk_off breadth. */
  bearishDailyRsi: number;
  /** Percent of the universe that must be bearish for the risk_off override to arm. */
  riskOffBreadthPercent: number;
  /** Median 4h RSI across the universe below which the risk_off override may fire. */
  riskOffMedianH4Rsi: number;
}

/**
 * Regime layer (V2 PR 1). The 4h horizon is the TACTICAL timeframe (mandate §2): waking
 * Sonnet every 2h on almost exclusively daily indicators could only produce repetition —
 * BTC's daily RSI moves 0.2 point between two wake-ups.
 */
export interface RegimeConfig {
  /** The tactical timeframe. */
  timeframe: Timeframe;
  /** 4h candles fetched per pair. Must comfortably exceed the indicator + hysteresis warm-up. */
  limit: number;
  thresholds: RegimeThresholds;
}

/**
 * Transition layer (observe mode). The actionability rule itself has no tuning — it is
 * the regime's own `confirmations`, deliberately NOT duplicated here: a second copy could
 * drift from the hysteresis it must mirror, and the whole claim of the layer is that it
 * gates without ever relabelling.
 *
 * So the only number is the stop's.
 */
export interface TransitionConfig {
  /**
   * Percent below `peak_price_since_entry` at which the peak stop fires DURING a
   * transition. Calibrated at 10% over the 61-day replay — the only threshold of the four
   * tested that keeps the best net result AND survives removing its single best episode,
   * and the deepest one that still triggers on BTC (at 12% it never does: zero frozen
   * asset-cycles reach it). See docs/RAPPORT-CONTRAT-TRANSITION.md §5.
   *
   * Uniform across the four assets for now. The per-asset case is defensible on the
   * drawdown profile (XRP's median frozen drawdown is −13.8%, BTC's −4.5%) but there were
   * five stop episodes in total, so splitting by asset would leave one or two each — no
   * longer a measurement. Revisit when the corpus has doubled.
   *
   * NOT env-overridable: it is a strategy guard-rail like the caps, not an ops knob.
   */
  peakStopPercent: number;
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
  regime: RegimeConfig;
  transition: TransitionConfig;
  decision: DecisionConfig;
  execution: ExecutionConfig;
  scheduler: SchedulerConfig;
  alerting: AlertingConfig;
  dailySummary: DailySummaryConfig;
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

/**
 * Which STRATEGY the bot runs. `v4` is the mandate that produced 785 holds in 47 days;
 * `v5` is the Strategy V2 mandate — regime playbooks, position lifecycle, franker moves.
 */
export type StrategyVersion = 'v4' | 'v5';

/**
 * Resolves `STRATEGY_VERSION`, and FAILS LOUD on anything it does not recognise.
 *
 * The whole safety property is that ABSENCE MEANS SAFE. There is nothing to set on
 * Railway to stay on v4, so the dangerous mode requires an explicit opt-in and can
 * never be reached by omission. If the platform ever loses its environment, the bot
 * comes back on v4 — strictly better than a safety that depends on a variable having
 * been set correctly.
 *
 * A PRESENT but unrecognised value is an error, never a silent fallback: a typo like
 * `V5` or `v5 ` means someone INTENDED to change the strategy, and quietly running the
 * old one would be the worst of both worlds — the operator believes v5 is live while
 * v4 trades. Matching is exact after trimming, so `V5` fails loudly rather than
 * activating the dangerous mode on a guess about what was meant.
 */
export function resolveStrategyVersion(raw: string | undefined = process.env.STRATEGY_VERSION): StrategyVersion {
  if (raw == null || raw.trim() === '') return 'v4';
  const value = raw.trim();
  if (value === 'v4' || value === 'v5') return value;
  throw new Error(
    `Invalid STRATEGY_VERSION="${raw}": expected exactly "v4" or "v5" (case-sensitive), or UNSET for the ` +
      'default "v4". A present-but-unrecognised value is refused rather than defaulted: it means someone ' +
      'intended to change the strategy, and silently running the other one would be worse than not booting.',
  );
}

/**
 * Resolves `COHERENCE_GUARD`, and FAILS LOUD on anything it does not recognise.
 *
 * Same convention as STRATEGY_VERSION, and the same reason: ABSENCE MEANS SAFE. Here
 * the safe mode is the guard ACTIVE, so there is nothing to set on Railway to be
 * protected — the guard can only be switched off by an explicit, correctly-spelled
 * opt-out, and an environment that loses its variables comes back protected.
 *
 * The escape hatch exists for one scenario, stated plainly: the day the guard turns out
 * to be too tight and blocks the bot, Julien must be able to disable it WITHOUT
 * reintroducing the output-contract bug. That is why it covers the guard only — the
 * field reordering in schema.ts is unconditional and has no flag. Turning this off
 * returns the bot to executing whatever the model emits; it does not return it to
 * emitting the target before the reasoning.
 *
 * A PRESENT but unrecognised value is an error, never a silent fallback. `OFF`, `false`
 * and `0` all fail: someone typing them INTENDED to disable the guard, and silently
 * leaving it armed would leave the operator debugging the wrong thing.
 */
export function resolveCoherenceGuard(raw: string | undefined = process.env.COHERENCE_GUARD): boolean {
  if (raw == null || raw.trim() === '') return true;
  const value = raw.trim();
  if (value === 'on') return true;
  if (value === 'off') return false;
  throw new Error(
    `Invalid COHERENCE_GUARD="${raw}": expected exactly "on" or "off" (case-sensitive), or UNSET ` +
      'for the default "on". Absence means the guard is ACTIVE — there is nothing to set to be ' +
      'protected. A present-but-unrecognised value is refused rather than defaulted: it means ' +
      'someone intended to change the guard, and silently running the other mode would be worse ' +
      'than not booting.',
  );
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

  regime: {
    // The tactical horizon. 300 bars ≈ 50 days: far past the EMA21/RSI14 warm-up and
    // long enough for the hysteresis walk to have converged well before the last bar.
    timeframe: '4h',
    limit: 300,
    thresholds: {
      // 3 × 4h = 12h of agreement before a regime flips. Below that we would swap the
      // observed immobility for noise at every candle — the failure mode the mandate
      // explicitly names.
      confirmations: 3,
      rangeWindowDays: 30,
      // 42 × 4h = 7 days. The tactical range has to be short enough to say something
      // the monthly range does not, and long enough not to be a single session.
      h4RangeBars: 42,
      // 55/45 around the RSI midline: a deliberate dead band, so a directionless 4h
      // (RSI 45-55) produces neither an up nor a down momentum reading.
      h4RsiUp: 55,
      h4RsiDown: 45,
      highRangePosition: 0.6,
      lowRangePosition: 0.4,
      // Symmetric around the middle of the TACTICAL range: below 0.30 a drop has been
      // paid, above 0.70 a bounce has. Deliberately tighter than the 0.4/0.6 band used
      // for trend confirmation — "the move already happened" is a stronger claim than
      // "the asset sits low", and it drives whether the model buys or sells.
      pullbackConsumedPosition: 0.3,
      bounceConsumedPosition: 0.7,
      bearishDailyRsi: 45,
      // 80% of the universe (4 of the 5 priced assets) bearish AND a median 4h RSI
      // under 40. Both halves must agree — a broken structure alone is a pullback,
      // not a reason to de-risk the whole book.
      riskOffBreadthPercent: 80,
      riskOffMedianH4Rsi: 40,
    },
  },

  transition: {
    peakStopPercent: 10,
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
    // Measured over the 128 v5 cycles: median 19.83s, p95 29.21s, worst 39.23s. 90s is
    // more than twice the worst case ever observed, so a healthy retry is never cut
    // short — and two of them (180s) still leave 120s of the 300s budget. NOT
    // env-overridable: it is a safety relation asserted against the cycle budget below,
    // not an ops knob.
    attemptTimeoutSeconds: 90,
    // The whole post-decision tail — insert, clamp, movements, real orders, lifecycle
    // write. The worst FULL cycle ever measured is 42.10s, of which the LLM call was
    // 39.23s; the tail has never approached 45s.
    retryReserveSeconds: 45,
  },

  execution: {
    startingCapitalUsd: envNumber('STARTING_CAPITAL_USD', 500),
    feePercent: envNumber('FEE_PERCENT', 0.1),
    // 2% of equity — the mandate's plumbing floor. NOT env-overridable: it is a
    // strategy guard-rail like the caps, not an ops knob.
    minMovementPercent: 2,
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

  dailySummary: {
    // Julien's local timezone for "9h" + the header date. Defaults to Europe/Paris
    // (his apparent zone); override with DAILY_SUMMARY_TZ if he moves country.
    timezone: process.env.DAILY_SUMMARY_TZ?.trim() || 'Europe/Paris',
    sendAtHourLocal: 9,
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
  // A floor at 0 would silently restore the 3128-crumb behavior; at 100 nothing but a
  // full exit could ever move. Both ends are configuration mistakes, not usable modes.
  if (!(cfg.minMovementPercent > 0 && cfg.minMovementPercent < 100)) {
    problems.push(`minMovementPercent must be in (0, 100) (got ${cfg.minMovementPercent})`);
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
 * Fails fast when the decision layer could outlive the cycle budget.
 *
 * The coherence guard puts a SECOND LLM call inside one cycle, so the arithmetic that
 * used to be comfortable has to be asserted rather than assumed:
 *
 *   2 × attemptTimeoutSeconds + retryReserveSeconds  ≤  maxCycleSeconds
 *
 * Both attempts bounded, plus the tail that still has to journal the decision, place the
 * real orders and write the lifecycle state. If that sum ever exceeded the budget, a slow
 * cycle would be killed by the watchdog MID-EXECUTION — after a booking, possibly before
 * its trace — which is the one place this codebase refuses to be sloppy. Asserted at
 * STARTUP, with the env overrides (MAX_CYCLE_SECONDS) in scope, rather than discovered at
 * runtime on the one cycle that needed the retry. Exported for the offline test.
 */
export function validateDecisionTimingConfig(
  decision: DecisionConfig,
  scheduler: SchedulerConfig,
): void {
  const problems: string[] = [];
  if (!(decision.attemptTimeoutSeconds > 0)) {
    problems.push(`attemptTimeoutSeconds must be > 0 (got ${decision.attemptTimeoutSeconds})`);
  }
  if (!(decision.retryReserveSeconds > 0)) {
    problems.push(`retryReserveSeconds must be > 0 (got ${decision.retryReserveSeconds})`);
  }
  const worstCase = 2 * decision.attemptTimeoutSeconds + decision.retryReserveSeconds;
  if (worstCase > scheduler.maxCycleSeconds) {
    problems.push(
      `two bounded LLM attempts plus the post-decision reserve (2 × ${decision.attemptTimeoutSeconds} + ` +
        `${decision.retryReserveSeconds} = ${worstCase}s) must fit inside maxCycleSeconds ` +
        `(${scheduler.maxCycleSeconds}s), else a cycle that needs its retry could be force-exited by ` +
        `the watchdog mid-execution`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`Invalid decision timing config: ${problems.join('; ')}`);
  }
}

validateDecisionTimingConfig(config.decision, config.scheduler);

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
 * Fails fast on a regime config that could not classify honestly. The load-bearing
 * checks are the two DEAD BANDS: `h4RsiDown < h4RsiUp` and `lowRangePosition <
 * highRangePosition`. If either pair crossed, a single bar could read as both "up"
 * and "down" (or as both high and low in its range) and the cascade's first-match
 * ordering would silently decide the regime instead of the data. And `confirmations
 * >= 1`, else the hysteresis is a no-op and every 4h candle flips the regime — the
 * exact failure the mandate forbids. Exported for the offline test.
 */
export function validateRegimeConfig(cfg: RegimeConfig): void {
  const t = cfg.thresholds;
  const problems: string[] = [];
  if (!(Number.isInteger(cfg.limit) && cfg.limit >= 100)) {
    problems.push(`limit must be an integer >= 100 candles (got ${cfg.limit})`);
  }
  if (!(Number.isInteger(t.confirmations) && t.confirmations >= 1)) {
    problems.push(`confirmations must be an integer >= 1, else hysteresis is a no-op (got ${t.confirmations})`);
  }
  if (!(Number.isInteger(t.rangeWindowDays) && t.rangeWindowDays >= 2)) {
    problems.push(`rangeWindowDays must be an integer >= 2 (got ${t.rangeWindowDays})`);
  }
  if (!(Number.isInteger(t.h4RangeBars) && t.h4RangeBars >= 2)) {
    problems.push(`h4RangeBars must be an integer >= 2 (got ${t.h4RangeBars})`);
  }
  if (t.h4RangeBars >= cfg.limit) {
    problems.push(
      `h4RangeBars (${t.h4RangeBars}) must stay below the fetched 4h window (${cfg.limit}), ` +
        `else the tactical range spans the whole series and stops being "recent"`,
    );
  }
  if (!(t.h4RsiDown < t.h4RsiUp)) {
    problems.push(
      `h4RsiDown (${t.h4RsiDown}) must be strictly below h4RsiUp (${t.h4RsiUp}) — a crossed pair ` +
        `would let one bar read as both up and down momentum`,
    );
  }
  if (!(t.lowRangePosition < t.highRangePosition)) {
    problems.push(
      `lowRangePosition (${t.lowRangePosition}) must be strictly below highRangePosition ` +
        `(${t.highRangePosition}) — a crossed pair would make a bar both high and low in its range`,
    );
  }
  if (!(t.pullbackConsumedPosition < t.bounceConsumedPosition)) {
    problems.push(
      `pullbackConsumedPosition (${t.pullbackConsumedPosition}) must be strictly below ` +
        `bounceConsumedPosition (${t.bounceConsumedPosition}) — a crossed pair would let one bar count ` +
        `as both "the drop is paid" and "the bounce is paid", which is the opposite advice twice`,
    );
  }
  for (const [name, value] of [
    ['lowRangePosition', t.lowRangePosition],
    ['highRangePosition', t.highRangePosition],
    ['pullbackConsumedPosition', t.pullbackConsumedPosition],
    ['bounceConsumedPosition', t.bounceConsumedPosition],
  ] as const) {
    if (!(value >= 0 && value <= 1)) problems.push(`${name} must be in [0, 1] (got ${value})`);
  }
  for (const [name, value] of [
    ['h4RsiUp', t.h4RsiUp],
    ['h4RsiDown', t.h4RsiDown],
    ['bearishDailyRsi', t.bearishDailyRsi],
    ['riskOffMedianH4Rsi', t.riskOffMedianH4Rsi],
  ] as const) {
    if (!(value > 0 && value < 100)) problems.push(`${name} must be in (0, 100) (got ${value})`);
  }
  if (!(t.riskOffBreadthPercent > 0 && t.riskOffBreadthPercent <= 100)) {
    problems.push(`riskOffBreadthPercent must be in (0, 100] (got ${t.riskOffBreadthPercent})`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid regime config: ${problems.join('; ')}`);
  }
}

validateRegimeConfig(config.regime);

/**
 * Fails fast on a stop threshold that could not do its job. At 0 (or below) the stop
 * fires on every frozen bar with a held line — a full liquidation of the book at the
 * first transition; at 100 it can never fire at all, which is a stop that exists only on
 * paper. Both are configuration mistakes, not usable modes, and in OBSERVE mode neither
 * would produce a visible failure — just a journal full of confident nonsense. Exported
 * for the offline test.
 */
export function validateTransitionConfig(cfg: TransitionConfig): void {
  if (!(cfg.peakStopPercent > 0 && cfg.peakStopPercent < 100)) {
    throw new Error(
      `Invalid transition config: peakStopPercent must be in (0, 100) (got ${cfg.peakStopPercent})`,
    );
  }
}

validateTransitionConfig(config.transition);

/**
 * The strategy in force for this process, resolved ONCE at startup so a malformed
 * value fails the boot rather than surfacing mid-cycle — and so the whole run cannot
 * change strategy under its own feet.
 */
export const STRATEGY_VERSION: StrategyVersion = resolveStrategyVersion();

/**
 * Whether the coherence guard is armed for this process, resolved ONCE at startup so a
 * malformed value fails the boot rather than surfacing mid-cycle — and so a run cannot
 * disarm its own guard halfway through.
 */
export const COHERENCE_GUARD: boolean = resolveCoherenceGuard();

/**
 * Fails fast on a bad daily-summary config. The timezone is validated by trying to
 * build an Intl formatter in it — an unknown IANA zone throws RangeError, which we
 * catch at STARTUP instead of letting it throw silently inside the 9h best-effort
 * send (where the summary would just never appear). Same exhaustive-at-startup
 * posture as the scheduler env overrides.
 */
function validateDailySummaryConfig(cfg: DailySummaryConfig): void {
  const problems: string[] = [];
  try {
    // Throws RangeError on an unknown zone; a valid zone (incl. 'UTC') is accepted.
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
  } catch {
    problems.push(
      `timezone "${cfg.timezone}" is not a valid IANA zone — set DAILY_SUMMARY_TZ (e.g. "Europe/Paris", "UTC")`,
    );
  }
  if (!(Number.isInteger(cfg.sendAtHourLocal) && cfg.sendAtHourLocal >= 0 && cfg.sendAtHourLocal <= 23)) {
    problems.push(`sendAtHourLocal must be an integer in [0, 23] (got ${cfg.sendAtHourLocal})`);
  }
  if (problems.length > 0) {
    throw new Error(`Invalid daily-summary config: ${problems.join('; ')}`);
  }
}

validateDailySummaryConfig(config.dailySummary);

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

/**
 * The BASE assets of the tradable pairs (the coins the bot may hold), in config
 * order, e.g. [BTC, ETH, BNB, XRP]. The reserve stable (the quote) is excluded —
 * it's the cash side, governed by the cash floor, not a per-asset cap. This is the
 * universe the mandate enumerates for the caps; resolving each via
 * `caps.perAsset[asset] ?? caps.defaultPerAsset` matches exactly what the risk
 * wrapper applies, so the prompt and the clamp can never state different caps.
 */
export function tradableBaseAssets(cfg: AppConfig = config): string[] {
  const bases: string[] = [];
  const seen = new Set<string>();
  for (const pair of cfg.tradablePairs) {
    const base = pair.split('/')[0];
    if (base && !seen.has(base)) {
      seen.add(base);
      bases.push(base);
    }
  }
  return bases;
}
