import type { SupabaseClient } from '@supabase/supabase-js';
import type { HttpErrorTrace } from '../exchanges/errorCapture.js';
import {
  saveMarketDataIncident,
  INCIDENT_WRITE_DEADLINE_MS,
  type MarketFailure,
} from '../persistence/marketDataIncidents.js';
import { probeAlternateEndpoint, PROBE_TIMEOUT_MS, type ProbeResult } from './probe.js';

/**
 * THE FAILURE PATH'S OBSERVABILITY, IN ONE PLACE — probe once, journal once, return
 * NOTHING.
 *
 * ── WHY THE RETURN TYPE IS `void`, AND WHY THAT IS THE PROOF ────────────────────────
 *
 * The brief's hardest constraint is that the diagnostic probe can never feed a decision,
 * an allocation, a price or a regime — and that this be demonstrated by the code, not
 * asserted in a comment. So the demonstration is the SIGNATURE: this function is the ONLY
 * caller of `probeAlternateEndpoint`, and it returns `Promise<void>`. There is no value
 * for `decide()` to read, so there is no path — not a careless one, not a future one —
 * by which a probe result could reach `clampAllocation`, `computeMovements`,
 * `toDecisionContext` or `executeMovements`. TypeScript enforces it on every future edit,
 * which a convention would not.
 *
 * This is the same technique `observeTransition` uses in decide.ts for the same reason,
 * and it is deliberate reuse: the codebase already trusts "returns void, no caller reads
 * it" as its way of making a component structurally incapable of influencing a trade.
 *
 * ── WHY IT IS BOUNDED TWICE ─────────────────────────────────────────────────────────
 *
 * This runs INSIDE the cycle, on the failure path. The PR #26 review found exactly this
 * hazard — an unbounded observational write able to reach the watchdog after the orders
 * had gone out — and it would be absurd to reintroduce it through the trace that
 * documents an outage. So:
 *
 *   - the probe is bounded by its own AbortSignal AND by an outer race here. Two
 *     independent bounds, because a bound that can be defeated by the thing it bounds
 *     (a fetch implementation that ignores signals) is not a bound;
 *   - the write is bounded by `runBoundedWrite` (abort signal + independent timer);
 *   - the whole function is wrapped so it cannot throw, whatever happens inside.
 *
 * Worst case is therefore PROBE_TIMEOUT_MS + INCIDENT_WRITE_DEADLINE_MS = 10s, asserted
 * against the cycle budget at startup by `validateOutageBudget` (config/index.ts) so the
 * relation is checked rather than assumed.
 *
 * ── ONCE PER CYCLE, NOT PER MARKET ──────────────────────────────────────────────────
 *
 * Called from `decide()`'s TERMINAL paths behind a once-flag, exactly like
 * `observeTransition`. Five markets failing together (the 09/08 signature) produce ONE
 * probe and ONE row, not five.
 *
 * Terminal rather than "right after the read", which is where it started: the 10s bound
 * would otherwise land BEFORE the coherence guard's time-budget gate on a partial-failure
 * cycle, and a cycle within 10s of that boundary would lose a retry it used to get. From
 * the tail it cannot reach the gate at all. The blind path ends immediately, so the probe
 * there still fires about a second after the failure — which is the case its timing is
 * for.
 */

/** The ceiling this function is allowed to add to a cycle. Asserted against the budget. */
export const OUTAGE_OBSERVABILITY_BUDGET_MS = PROBE_TIMEOUT_MS + INCIDENT_WRITE_DEADLINE_MS;

export interface OutageInput {
  supabase: SupabaseClient | null;
  /** Null when the cycle has no decision row yet — the incident is written regardless. */
  decisionId: number | null;
  runToken: string | null;
  /** True when NO tradable market returned usable data — the 09/08 signature. */
  blind: boolean;
  /** Every configured pair the cycle tried to read (tradable + reference). */
  marketsAttempted: number;
  /**
   * How many were actually LOST — the brief's "nombre de marchés affectés". Counts only
   * the failures that dropped their pair, so a contained 4h hiccup never inflates it.
   */
  marketsFailed: number;
  failures: MarketFailure[];
  httpTraces: HttpErrorTrace[];
  /** Traces dropped at the capture cap; kept so the row never overstates completeness. */
  tracesDropped: number;
}

/** Test seams. Production passes none of these. */
export interface OutageDeps {
  probe?: () => Promise<ProbeResult>;
  probeTimeoutMs?: number;
  writeDeadlineMs?: number;
}

/**
 * Races `work` against a deadline, resolving to `fallback` if the deadline wins. The
 * abandoned promise's rejection is swallowed so it cannot surface as an unhandled
 * rejection after we have moved on.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    // Not unref'd, for the reason spelled out in boundedWrite.ts: it is the only thing
    // that can resolve the race when `work` never settles.
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The probe result used when the probe itself blew its deadline — an honest "unknown". */
function probeTimedOut(ms: number): ProbeResult {
  return {
    reachable: false,
    httpStatus: null,
    latencyMs: ms,
    error: `probe did not settle within ${ms}ms — abandoned`,
  };
}

/**
 * Picks the row's summary fields from the raw detail.
 *
 * The summary is what gets filtered on at 3 a.m.; `failures` / `http_traces` keep
 * everything. "Dominant" means most frequent, ties broken by first occurrence — with five
 * markets failing identically (the 09/08 shape) that is simply the one class they share.
 */
export function summarise(
  failures: MarketFailure[],
  traces: HttpErrorTrace[],
): { errorClass: string | null; httpStatus: number | null; endpoint: string | null; retryAfter: string | null } {
  const counts = new Map<string, number>();
  for (const f of failures) counts.set(f.errorClass, (counts.get(f.errorClass) ?? 0) + 1);
  let errorClass: string | null = null;
  let best = 0;
  for (const [cls, n] of counts) {
    if (n > best) {
      best = n;
      errorClass = cls;
    }
  }

  // The HTTP hook is authoritative when it saw a response; the message-parsed values on
  // the failures are the fallback for transport-level errors, where no response existed.
  const trace = traces[0] ?? null;
  const parsed = failures.find((f) => f.httpStatus != null) ?? null;

  return {
    errorClass,
    httpStatus: trace?.httpStatus ?? parsed?.httpStatus ?? null,
    endpoint: trace?.endpoint ?? parsed?.endpoint ?? failures[0]?.endpoint ?? null,
    retryAfter: traces.find((t) => t.retryAfter != null)?.retryAfter ?? null,
  };
}

/**
 * Probes once and journals once. NEVER throws, NEVER exceeds its budget, RETURNS NOTHING.
 *
 * Called only when at least one market read failed. A cycle where everything worked never
 * reaches here and pays nothing.
 */
export async function recordMarketDataOutage(input: OutageInput, deps: OutageDeps = {}): Promise<void> {
  try {
    const probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    const probeFn = deps.probe ?? (() => probeAlternateEndpoint());

    const summary = summarise(input.failures, input.httpTraces);

    console.error(
      `[market-data] ${input.blind ? 'BLIND CYCLE' : 'partial market-data loss'} — ` +
        `${input.marketsFailed}/${input.marketsAttempted} market(s) lost, ` +
        `${input.failures.length} failed read(s) ` +
        `(class=${summary.errorClass ?? 'unknown'}, http=${summary.httpStatus ?? 'n/a'}, ` +
        `endpoint=${summary.endpoint ?? 'n/a'}, retry_after=${summary.retryAfter ?? 'n/a'}). ` +
        'Probing the alternate public endpoint once, then journaling.',
    );

    // THE PROBE. Bounded twice (see the header). Its result goes into the row below and
    // nowhere else.
    const probe = await withDeadline(probeFn(), probeTimeoutMs, probeTimedOut(probeTimeoutMs));
    console.log(
      `[market-data] probe → reachable=${probe.reachable} http=${probe.httpStatus ?? 'n/a'} ` +
        `latency=${probe.latencyMs}ms${probe.error ? ` error=${probe.error}` : ''}. ` +
        'Diagnostic only — this result feeds nothing.',
    );

    await saveMarketDataIncident(
      input.supabase,
      {
        decision_id: input.decisionId,
        run_token: input.runToken,
        blind: input.blind,
        markets_attempted: input.marketsAttempted,
        markets_failed: input.marketsFailed,
        error_class: summary.errorClass,
        http_status: summary.httpStatus,
        endpoint: summary.endpoint,
        retry_after: summary.retryAfter,
        failures: input.failures,
        http_traces:
          input.tracesDropped > 0
            ? { traces: input.httpTraces, dropped: input.tracesDropped }
            : input.httpTraces,
        probe_attempted: true,
        probe_reachable: probe.reachable,
        probe_http_status: probe.httpStatus,
        probe_latency_ms: probe.latencyMs,
        probe_error: probe.error,
      },
      deps.writeDeadlineMs ?? INCIDENT_WRITE_DEADLINE_MS,
    );
  } catch (err) {
    // The last line of defence. `saveMarketDataIncident` already swallows its own
    // failures, so reaching here means something unexpected broke in the summarising or
    // logging above — which must still not cost the cycle. The whole component is
    // observability; its failure is never the bot's problem.
    console.error(
      '[market-data] the outage observability itself failed ' +
        `(${err instanceof Error ? (err.stack ?? err.message) : String(err)}) — cycle unaffected.`,
    );
  }
}
