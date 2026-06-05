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
export type CycleStatus = 'decided' | 'skipped' | 'parse_failed' | 'error';

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
  // parse_failed / error / a thrown cycle: no usable decision → back off.
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
