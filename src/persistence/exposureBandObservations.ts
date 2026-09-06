import type { SupabaseClient } from '@supabase/supabase-js';
import { runBoundedWrite } from './boundedWrite.js';
import type { BandObservationInsert } from '../exposure/observe.js';

const TABLE = 'exposure_band_observations';

/**
 * Journaling the exposure band's observation — the whole output of `observation` mode.
 *
 * BEST-EFFORT BY CONTRACT. It never throws and never fails a cycle. That is not politeness,
 * it is the safety property of this brick: the band must be incapable of changing what the
 * bot does, and a writer that could reject a cycle would be exactly that — a purely
 * observational component with the power to stop a trade. A failed write costs the
 * observation and nothing else.
 *
 * Not swallowed either. A lost row is a real, non-self-healing loss of the evidence the
 * checkpoint will be read on, so the payload is dumped to the logs where it is at least
 * recoverable. Same posture as `saveTransitionObservations`, `recordGuardEvent` and
 * `savePositionStates`.
 */

/**
 * HARD DEADLINE on the observational write — the mechanism lives in `runBoundedWrite`, and
 * its reasoning is documented there in full: a try/catch only handles the writes that FINISH,
 * so a request Supabase accepts and never settles would burn the cycle budget and let the
 * watchdog force-exit.
 *
 * 5s, the same as the transition observations, for a strictly smaller write: one row per
 * cycle against their four.
 */
const WRITE_DEADLINE_MS = 5_000;

/**
 * Writes this cycle's band observation — exactly one row per cycle.
 *
 * UPSERT on `decision_id` rather than insert, for the same reason the transition
 * observations upsert: a retried or duplicated call must not fail on the unique constraint
 * and lose a row that was already correct.
 *
 * Returns whether the write landed, for the caller's log — never for control flow.
 */
const COVERAGE_DEADLINE_MS = 5000;

export async function saveBandObservation(
  supabase: SupabaseClient | null,
  row: BandObservationInsert,
): Promise<boolean> {
  if (!supabase) {
    console.warn('[warn] Supabase not configured — the exposure band observation was NOT journaled.');
    return false;
  }
  try {
    await runBoundedWrite(
      (signal) =>
        supabase
          .from(TABLE)
          .upsert(row, { onConflict: 'decision_id' })
          // The clean cancellation: postgrest-js aborts the underlying fetch and the promise
          // rejects, which the catch below turns into a logged, non-fatal miss.
          .abortSignal(signal),
      WRITE_DEADLINE_MS,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[CRITICAL] the exposure band observation for decision ${row.decision_id} was NOT journaled ` +
        `(${msg}) — the payload follows so it is at least recoverable from the logs.`,
    );
    console.error(JSON.stringify(row));
    return false;
  }
}

/**
 * THE COVERAGE, counted the way §7 counts it: one observation per 4h bar, the FIRST cycle that
 * used it, and absent or unclassifiable data in neither family.
 *
 * Read here rather than derived on the trading path: it is a measurement question, it only
 * matters once the window is old enough to close, and it must never be able to weigh on an
 * order. Best-effort by construction — a miss simply means the window is evaluated again next
 * cycle.
 */
export async function readWindowCoverage(
  supabase: SupabaseClient | null,
  activatedAt: string,
): Promise<{ constructiveBars: number; nonConstructiveBars: number } | null> {
  if (!supabase) return null;
  type CoverageRow = { bar_at: string | null; state: string | null; decision_id: number };
  let rows: CoverageRow[] = [];
  try {
    await runBoundedWrite(async (signal) => {
      const res = await supabase
        .from('exposure_band_observations')
        .select('bar_at, state, decision_id')
        .gte('created_at', activatedAt)
        .not('bar_at', 'is', null)
        .not('state', 'is', null)
        .order('decision_id', { ascending: true })
        .limit(20000)
        .abortSignal(signal);
      rows = (res.data ?? []) as unknown as CoverageRow[];
      return { error: res.error };
    }, COVERAGE_DEADLINE_MS);
  } catch {
    return null;
  }

  const firstOfBar = new Map<string, string>();
  for (const row of rows) {
    if (row.bar_at == null || row.state == null) continue;
    // FIRST wins — the rows arrive in decision order, and §7 makes the first cycle of a bar
    // the unit of analysis. A later cycle of the same bar may not overwrite it.
    if (!firstOfBar.has(row.bar_at)) firstOfBar.set(row.bar_at, row.state);
  }
  let constructiveBars = 0;
  let nonConstructiveBars = 0;
  for (const state of firstOfBar.values()) {
    if (state === 'constructive') constructiveBars += 1;
    else if (state === 'neutral' || state === 'defensive') nonConstructiveBars += 1;
  }
  return { constructiveBars, nonConstructiveBars };
}
