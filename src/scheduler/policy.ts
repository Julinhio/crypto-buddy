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
  },
): number {
  switch (outcome) {
    case 'decided': {
      const d = opts.appliedDelayMinutes ?? opts.minDelayMinutes;
      return Math.min(opts.maxDelayMinutes, Math.max(opts.minDelayMinutes, d));
    }
    case 'skip':
      return opts.softSkipDelayMinutes;
    case 'error':
      return backoffMinutes(opts.failuresAfter, opts.minDelayMinutes, opts.maxDelayMinutes);
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
