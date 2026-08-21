/**
 * HARD DEADLINE on an OBSERVATIONAL write — the shared mechanism, in one place.
 *
 * A try/catch does not make a write best-effort — it only handles the ones that FINISH. A
 * request Supabase accepts but never settles would hang the `await` inside `decide()`,
 * burn the cycle budget, and let `armCycleWatchdog` force-exit the process at
 * `maxCycleSeconds + grace` — potentially after the decision was journaled and the orders
 * were placed. The cycle would then be recorded as a failure and the scheduler would back
 * off, which means a purely observational layer would have changed operational behaviour.
 *
 * That is the defect the PR #26 review found, and it now has two consumers: the transition
 * observations (PR #26) and the market-data incidents (this PR). Both run on paths where
 * a stall is expensive, and the logic below — race a signal-aborted query against an
 * independent timer, fold BOTH settle paths into a value so a late rejection can never
 * surface as an unhandled rejection — is subtle enough that a second copy would drift.
 * `cycleGuard.ts` states the rule this file follows: a copy-paste of concurrency-critical
 * code is how the two halves silently diverge.
 *
 * Extracted VERBATIM from `saveTransitionObservations`; that function now calls it, so the
 * two consumers are provably the same mechanism rather than two similar ones.
 */

/** The shape postgrest-js resolves to — only the error channel matters here. */
export interface WriteResult {
  error: { message: string } | null;
}

/**
 * Runs `build(signal)` under a hard deadline. THROWS on any failure — a rejected query, a
 * PostgREST error, or a query that never settles — so the caller keeps ownership of how a
 * miss is logged. Returns normally only when the write actually landed.
 *
 * `build` receives the abort signal so the query can be constructed with `.abortSignal()`:
 * that is the CLEAN cancellation (postgrest-js aborts the underlying fetch and the promise
 * rejects). The timer below is the BACKSTOP, because the guarantee must not depend on the
 * client honouring the signal.
 */
export async function runBoundedWrite(
  build: (signal: AbortSignal) => PromiseLike<WriteResult>,
  deadlineMs: number,
): Promise<void> {
  const result = await runBoundedQuery(build, deadlineMs);
  if (result?.error) throw new Error(result.error.message);
}

/**
 * The same hard deadline, for a query whose VALUE is wanted — the read counterpart of
 * `runBoundedWrite`, which is now a thin wrapper over it.
 *
 * Generalized rather than copied, on this file's own rule: the race below (signal-aborted
 * query against an independent timer, both settle paths folded into a value so a late
 * rejection can never surface as an unhandled rejection) is exactly the subtle logic a
 * second copy would drift from. One mechanism, two shapes.
 *
 * THROWS on a rejection or on a query that never settles; PostgREST's own `{ error }`
 * channel is left to the caller, because a read that comes back empty is often a legitimate
 * answer rather than a failure. Callers that only want a best-effort value catch and return
 * null.
 */
export async function runBoundedQuery<T>(
  build: (signal: AbortSignal) => PromiseLike<T>,
  deadlineMs: number,
): Promise<T> {
  const query = build(AbortSignal.timeout(deadlineMs));

  // Rejection is folded into the VALUE rather than caught away: a bare
  // `.catch(() => undefined)` would make a failed write indistinguishable from a
  // successful one and quietly report every error as a success. Handling both settle paths
  // here also means a late rejection from a query the race abandoned can never surface as
  // an unhandled rejection mid-cycle.
  type Outcome =
    | { kind: 'settled'; result: T }
    | { kind: 'failed'; error: unknown }
    | { kind: 'timeout' };

  const settled: Promise<Outcome> = Promise.resolve(query).then(
    (result) => ({ kind: 'settled', result }),
    (error: unknown) => ({ kind: 'failed', error }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    // Deliberately NOT unref'd: this timer is the only thing that can resolve the race
    // when the query never settles, and an unref'd one lets Node exit the moment the hung
    // await is all that is left — turning "return on the deadline" into "the process
    // quietly ends". It is cleared in `finally`, so on the fast path it holds the loop for
    // microseconds and on the slow path for at most the deadline.
    timer = setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs);
  });

  try {
    const outcome = await Promise.race([settled, deadline]);
    if (outcome.kind === 'timeout') {
      // "query", not "write": this races reads as well now, and a read that timed out
      // logging "write did not settle" would send the next reader to the wrong table.
      // Nothing asserts this string — it is a log line, checked before rewording it.
      throw new Error(`query did not settle within ${deadlineMs}ms — abandoned`);
    }
    if (outcome.kind === 'failed') throw outcome.error;
    return outcome.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
