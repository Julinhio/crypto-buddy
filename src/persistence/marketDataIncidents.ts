import type { SupabaseClient } from '@supabase/supabase-js';
import { INCIDENT_WRITE_DEADLINE_MS } from '../config/index.js';
import { runBoundedWrite } from './boundedWrite.js';

const TABLE = 'market_data_incidents';

/**
 * Journaling a failed market read — the point of this whole PR.
 *
 * On 09/08 the bot went blind for 23 hours and the database kept exactly one fact about
 * it: the string `status=skipped`. No HTTP code, no endpoint, no error class. The detail
 * existed and died in the process logs, which is why the cause is still a hypothesis. A
 * detector whose verdict does not survive the process is not a detector — the same lesson
 * migration 0019 drew from the lost 30/07 trade, and the same one again here.
 *
 * BEST-EFFORT BY CONTRACT, and bounded. It never throws and never fails a cycle: this is
 * observability, and a writer able to reject a cycle would be an observational component
 * with the power to stop a trade. A failed write costs the row and nothing else — but it
 * is logged loudly with its payload, because a lost row is a real, non-self-healing loss
 * of the very evidence this table exists to hold.
 */

/**
 * Where in the pair build the read failed. The three are kept apart because they are
 * genuinely different events, and one of them throws nothing at all:
 *
 *   - `pair`     : the build threw (network, HTTP status, bad symbol) → pair DROPPED;
 *   - `primary`  : the daily series came back EMPTY, with no exception → pair DROPPED.
 *                  This case matters more than it looks: ccxt returns `[]` for an empty
 *                  OHLCV response rather than throwing, so a "no error" outage is
 *                  perfectly possible and would otherwise be journaled as nothing at all;
 *   - `tactical` : the 4h series failed → pair KEPT (its failure is contained on purpose,
 *                  see fetchTacticalSeries), so it never drops a market. Recorded anyway
 *                  because it is an early warning that costs nothing to keep.
 */
export type FailureStage = 'pair' | 'primary' | 'tactical';

/** One market read that failed, as seen from the pair builder. */
export interface MarketFailure {
  symbol: string;
  kind: 'tradable' | 'reference';
  stage: FailureStage;
  /** Did this failure remove the pair from the universe? Only these count as "affected". */
  dropped: boolean;
  /**
   * The ccxt exception class — the single field that separates a block from a timeout.
   * The synthetic `EmptyPrimarySeries` marks the no-exception case above.
   */
  errorClass: string;
  /** Recovered from ccxt's message when the HTTP hook saw nothing (transport failures). */
  httpStatus: number | null;
  endpoint: string | null;
  /** Truncated: enough to identify, not enough to bloat the row. */
  message: string;
}

export interface MarketDataIncidentInsert {
  decision_id: number | null;
  run_token: string | null;
  blind: boolean;
  markets_attempted: number;
  markets_failed: number;
  error_class: string | null;
  http_status: number | null;
  endpoint: string | null;
  retry_after: string | null;
  failures: unknown;
  http_traces: unknown;
  probe_attempted: boolean;
  probe_reachable: boolean | null;
  probe_http_status: number | null;
  probe_latency_ms: number | null;
  probe_error: string | null;
}

/**
 * The same bound and the same reasoning as every other observational write here — see
 * `runBoundedWrite`. Declared in `config/index.ts` next to the cycle budget it is asserted
 * against (`validateOutageBudget`), re-exported here so callers read it from the writer.
 */
export { INCIDENT_WRITE_DEADLINE_MS };

/**
 * Writes one incident row. Returns whether it landed, for the caller's log — never for
 * control flow, and never propagated anywhere a decision could read it.
 */
export async function saveMarketDataIncident(
  supabase: SupabaseClient | null,
  row: MarketDataIncidentInsert,
  deadlineMs: number = INCIDENT_WRITE_DEADLINE_MS,
): Promise<boolean> {
  if (!supabase) {
    console.warn(
      '[warn] Supabase not configured — the market-data incident was NOT journaled. ' +
        `Payload: ${JSON.stringify(row)}`,
    );
    return false;
  }
  try {
    await runBoundedWrite(
      (signal) => supabase.from(TABLE).insert(row).abortSignal(signal),
      deadlineMs,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[CRITICAL] the market-data incident was NOT journaled (${msg}) — payload: ${JSON.stringify(row)}. ` +
        'The cycle is unaffected (this table is written and never read by the bot), but this is ' +
        'precisely the evidence whose absence made the 09/08 outage undiagnosable.',
    );
    return false;
  }
}
