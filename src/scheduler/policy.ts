/**
 * The scheduler's DECISION LOGIC, as pure functions: no DB, no network, no clock
 * of their own (times come in as epoch-ms, computed against the DATABASE's now()).
 * This is what the test suite exercises directly.
 *
 * The ATOMICITY of the claim is NOT here — it's a property of the single
 * conditional UPDATE in `claim_due_run` (migration 0006). `canClaim` only MIRRORS
 * that WHERE clause, for the no-op logging path and for tests. The real
 * concurrency guarantee is proven live (two parallel beats), never offline.
 */

import type { LlmFailureClass } from '../decision/llmFailure.js';

/** The decide() status the cycle returned (DecisionRow['status']). */
export type CycleStatus = 'decided' | 'skipped' | 'parse_failed' | 'error' | 'guard_failed';

/** The scheduler's coarse outcome class — drives rescheduling and counters. */
export type RunOutcome = 'decided' | 'skip' | 'error';

/** Is the next cycle due? (null next_check = first run ever → due immediately.) */
export function isDue(nextCheckAtMs: number | null, nowMs: number): boolean {
  return nextCheckAtMs == null || nextCheckAtMs <= nowMs;
}

/** Is a run-lock currently held and unexpired? */
export function isLockLive(lockedUntilMs: number | null, nowMs: number): boolean {
  return lockedUntilMs != null && lockedUntilMs > nowMs;
}

/**
 * Whether a beat MAY claim: due AND no live lock. Mirrors `claim_due_run`'s WHERE.
 * Authoritative atomicity still lives in the DB UPDATE — this is the cheap
 * pre-check (skip the claim RPC when obviously not due) and the tested predicate.
 */
export function canClaim(
  state: { nextCheckAtMs: number | null; lockedUntilMs: number | null },
  nowMs: number,
): boolean {
  return isDue(state.nextCheckAtMs, nowMs) && !isLockLive(state.lockedUntilMs, nowMs);
}

/**
 * How many fixed beats were missed (e.g. the bot was down). Observability only —
 * we run ONE fresh cycle on the current market, never replaying the missed beats.
 */
export function missedBeats(
  prevNextCheckAtMs: number | null,
  dbNowMs: number,
  beatIntervalMinutes: number,
): number {
  if (prevNextCheckAtMs == null) return 0;
  const overdueMs = dbNowMs - prevNextCheckAtMs;
  if (overdueMs <= 0) return 0;
  return Math.floor(overdueMs / (beatIntervalMinutes * 60_000));
}

/** Map a decide() status onto the scheduler's coarse outcome. */
export function classifyOutcome(status: CycleStatus): RunOutcome {
  if (status === 'decided') return 'decided';
  if (status === 'skipped') return 'skip';
  // parse_failed / error / guard_failed / a thrown cycle: no usable decision → back off.
  //
  // `guard_failed` deliberately lands here rather than in `skip`. A skip means the run
  // mechanics worked and there was simply nothing to decide on; a decision refused twice
  // for incoherence is a cycle that produced no trading, and it should back off and feed
  // the consecutive-failure counter like any other hard failure — so a guard that starts
  // rejecting everything raises the "degraded" alert at three in a row instead of quietly
  // holding the bot flat.
  return 'error';
}

/**
 * Consecutive-failure counter that drives backoff. Only a HARD error increments;
 * both a clean decision and a soft skip reset it (the run mechanics worked).
 */
export function nextConsecutiveFailures(prev: number, outcome: RunOutcome): number {
  return outcome === 'error' ? prev + 1 : 0;
}

/** Capped exponential backoff: minDelay · 2^(failures−1), clamped to maxDelay. */
export function backoffMinutes(failures: number, minDelayMinutes: number, maxDelayMinutes: number): number {
  if (failures <= 1) return minDelayMinutes;
  const raw = minDelayMinutes * 2 ** Math.min(failures - 1, 20);
  return Math.min(maxDelayMinutes, raw);
}

/**
 * The next-check delay, in minutes — ALWAYS produced, whatever the outcome, so the
 * bot never goes dark on the logic side:
 *   - decided → the LLM's already-bounded delay (clamped again for safety);
 *   - skip    → a modest fixed retry;
 *   - error   → capped exponential backoff driven by the post-increment count.
 */
export function nextDelayMinutes(
  outcome: RunOutcome,
  opts: {
    appliedDelayMinutes: number | null;
    failuresAfter: number;
    softSkipDelayMinutes: number;
    minDelayMinutes: number;
    maxDelayMinutes: number;
    /**
     * THE CLASS OF THE **CURRENT** FAILURE — the typed value produced once in the decision
     * layer and relayed here untouched. Null (or absent) means "not a known-transient
     * provider fault", which is every pre-existing caller and every non-LLM failure.
     */
    failureClass?: LlmFailureClass | null;
    /** Ceiling applied to a `retryable_llm_transport` failure. See the config bound. */
    retryableLlmTransportMaxDelayMinutes?: number;
  },
): number {
  switch (outcome) {
    case 'decided': {
      const d = opts.appliedDelayMinutes ?? opts.minDelayMinutes;
      return Math.min(opts.maxDelayMinutes, Math.max(opts.minDelayMinutes, d));
    }
    case 'skip':
      return opts.softSkipDelayMinutes;
    case 'error': {
      const generic = backoffMinutes(opts.failuresAfter, opts.minDelayMinutes, opts.maxDelayMinutes);
      /*
       * THE ONE BEHAVIOURAL CHANGE OF THIS PR, and it is deliberately this small.
       *
       * `consecutive_failures` stays GLOBAL — no per-class counter, no reset on a change of
       * class. What the class decides is the CEILING applied to the delay this failure
       * earns, nothing else. Two consequences, both intended and both pinned by tests:
       *
       *   - four transport failures then a non-transport one → the fifth is the fifth
       *     global failure and takes the full generic 240 min. A provider outage does not
       *     buy a broken bot a shorter leash;
       *   - four non-transport failures then a transport one → the fifth is still capped
       *     at 30 min. A bot that was broken and is now merely waiting on Anthropic should
       *     not inherit four hours of silence from its own past.
       *
       * `min` rather than a replacement: the first failure must still be the 15-minute
       * floor, not 30. On 20/08 that yields 15 / 30 / 30 / 30 instead of 15 / 30 / 60 /
       * 120 — the bot would have retried at 21:37 rather than 23:07.
       */
      const cap = opts.retryableLlmTransportMaxDelayMinutes;
      if (opts.failureClass === 'retryable_llm_transport' && cap != null) {
        return Math.min(generic, cap);
      }
      return generic;
    }
  }
}

/**
 * Overheating counter: how many decided cycles IN A ROW asked for the floor delay.
 * Only a `decided` cycle (which produces an accepted bounded delay) touches it;
 * skip/error leave it untouched. The alerting PR consumes it later.
 */
export function nextFloorStreak(
  prev: number,
  outcome: RunOutcome,
  appliedDelayMinutes: number | null,
  floorMinutes: number,
): number {
  if (outcome !== 'decided') return prev;
  return appliedDelayMinutes != null && appliedDelayMinutes <= floorMinutes ? prev + 1 : 0;
}

/** The debounce verdict for one alert trigger: fire now? and the flag to persist. */
export interface AlertDecision {
  /** Send the alert on THIS beat — true only when crossing UP (not already sent). */
  fire: boolean;
  /** The debounce flag to persist: armed (true) while at/above, re-armed (false) below. */
  sent: boolean;
}

/**
 * Per-trigger alert debounce, as a pure function (this is the load-bearing
 * anti-spam logic, proven offline here and live by the debounce-check script):
 *
 *   - fire ONCE on the crossing: at/above the threshold AND not already sent;
 *   - stay SILENT while it remains at/above (already sent);
 *   - RE-ARM (sent → false) once it drops back below the threshold.
 *
 * Both scheduler counters only ever climb (+1) or reset to 0, so "drops below
 * threshold" coincides with "back to 0" — the brief's wording. The two triggers
 * are evaluated INDEPENDENTLY (one call each) so neither can mask the other.
 */
export function evaluateAlert(value: number, threshold: number, prevSent: boolean): AlertDecision {
  const atOrAbove = value >= threshold;
  return { fire: atOrAbove && !prevSent, sent: atOrAbove };
}

/** The degraded trigger's verdict for one beat: what to send, and the flag to persist. */
export interface DegradedIncident {
  /** Send the DEGRADED alert on this beat — once, on the upward crossing. */
  fire: boolean;
  /** Send the RECOVERED notification on this beat — once, on the first valid decision. */
  recovered: boolean;
  /** The incident flag to persist: armed from the crossing until a recovery closes it. */
  armed: boolean;
}

/**
 * THE DEGRADED INCIDENT, as a lifecycle rather than as a threshold comparison.
 *
 * `evaluateAlert` above answers "is this counter at or above its threshold right now?".
 * That is the right question for `overheating`, whose counter only moves on a decided
 * cycle. It is the wrong one for `degraded`, and 20/08 shows why: the alert must close on
 * a REAL RECOVERY — a new valid decision — and `consecutive_failures` is reset to zero by
 * a `skipped` cycle too. Under the old rule, one skip mid-incident silently re-armed the
 * trigger, so a bot that had been failing for hours could go quiet and then alert again as
 * if nothing had preceded it, and no recovery was ever announced because the flag was
 * already down by the time a decision landed.
 *
 * So the flag stops meaning "the counter is above the threshold" and starts meaning "an
 * incident is open". Three inputs, three behaviours:
 *
 *   - error   → arm on the crossing, fire ONCE; stay armed while it continues, even if the
 *               counter dropped below the threshold in between (the `skip → error` case);
 *   - skip    → nothing is sent and the flag is left EXACTLY as it was. A skipped cycle is
 *               not a recovery: no decision was produced, and the mechanics working is not
 *               the same fact as the bot deciding again;
 *   - decided → the only thing that closes an incident. Recovery fires iff one was open,
 *               and the flag comes down.
 *
 * The counter itself is NOT touched — `nextConsecutiveFailures` keeps resetting on a skip,
 * because "consecutive failures" has to keep meaning consecutive failures. That is exactly
 * why the recovery message cannot read its failure count from it, and rebuilds it from
 * `scheduler_runs` instead (see `countFailedRunsSince`).
 *
 * Pure, so the seven sequences in the brief are proven offline rather than in production.
 */
export function evaluateDegradedIncident(
  outcome: RunOutcome,
  failuresAfter: number,
  threshold: number,
  prevArmed: boolean,
): DegradedIncident {
  if (outcome === 'decided') {
    return { fire: false, recovered: prevArmed, armed: false };
  }
  if (outcome === 'skip') {
    return { fire: false, recovered: false, armed: prevArmed };
  }
  const atOrAbove = failuresAfter >= threshold;
  return { fire: atOrAbove && !prevArmed, recovered: false, armed: prevArmed || atOrAbove };
}

/**
 * Consecutive cycles that saw NO tradable market — the second health state's counter.
 *
 * Deliberately NOT folded into `nextConsecutiveFailures`. A blind cycle is classified
 * `skip` by `classifyOutcome` (the run mechanics worked; there was simply nothing to
 * decide on), and `skip` RESETS the failure counter. That is why 31 blind cycles over 23
 * hours left `consecutive_failures` at zero and never armed the degraded alert. Changing
 * that classification would alter the bot's backoff and rescheduling — a behaviour change
 * this PR explicitly does not make. So the blindness gets its own counter instead, and the
 * fail-closed keeps behaving exactly as it did.
 *
 * Three-valued input, three behaviours (see MarketDataState):
 *   - blind   → +1;
 *   - sighted → 0, which is what re-arms the alert;
 *   - unknown → unchanged. A cycle that never looked is neither evidence of an outage nor
 *               evidence of a recovery, and pretending otherwise would make the alert
 *               fire on freezes or go quiet in the middle of a real outage.
 */
export function nextBlindCycles(prev: number, marketData: 'blind' | 'sighted' | 'unknown'): number {
  if (marketData === 'blind') return prev + 1;
  if (marketData === 'sighted') return 0;
  return prev;
}

/**
 * The DOWNWARD crossing of a debounced trigger: was it armed, and has the value now
 * dropped back below the threshold? That is the moment — and the only moment — a
 * "recovered" message is worth sending.
 *
 * Kept as its own function rather than a third field on `AlertDecision` so the two
 * existing triggers (overheating, degraded) are untouched: they have never sent a recovery
 * message and this PR does not start. Only the market-data trigger calls it, which is why
 * the proof counts alerts and recoveries separately.
 */
export function evaluateRecovery(value: number, threshold: number, prevSent: boolean): boolean {
  return prevSent && value < threshold;
}
