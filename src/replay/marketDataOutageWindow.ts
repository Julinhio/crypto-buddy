/**
 * THE 09/08 OUTAGE, FROZEN.
 *
 * Captured read-only from `scheduler_runs ⟕ decisions` at the start of the PR's work
 * (window 2026-08-09 03:00Z → 2026-08-10 05:00Z, which brackets the incident's
 * 03:55 → 03:30 on both sides). The bot RUNS AND WRITES while this PR is developed, so
 * the alert proof cannot re-query live: the same query tomorrow returns a different
 * table and the proof would silently stop being about this incident.
 *
 * `blind` is derived from the ONE fact the database kept about those cycles — the
 * skip_reason string `no tradable pairs returned usable market data`. That poverty is
 * the defect this PR fixes; here it is also the only signal available to reconstruct
 * the sequence, which is why the window is frozen rather than re-derived.
 *
 * The query that produced it:
 *
 *   select r.id, r.started_at,
 *          extract(epoch from (r.finished_at - r.started_at)) as duration_s,
 *          r.outcome, d.status, d.skip_reason
 *     from public.scheduler_runs r
 *     left join public.decisions d on d.id = r.decision_id
 *    where r.started_at >= '2026-08-09 03:00:00+00'
 *      and r.started_at <= '2026-08-10 05:00:00+00'
 *    order by r.started_at;
 */

export interface WindowCycle {
  /** scheduler_runs.id — so a line here can be traced back to the real row. */
  runId: number;
  /** started_at, UTC. */
  at: string;
  /** finished_at − started_at, seconds. */
  durationSeconds: number;
  /** The scheduler's coarse outcome as it was recorded on the day. */
  outcome: 'decided' | 'skip' | 'error';
  /**
   * Did this cycle see the market? Derived from the skipped row's `skip_reason`
   * being the empty-universe one — the only trace the outage left.
   */
  blind: boolean;
}

/** The window's bounds, as captured. */
export const WINDOW = {
  fromIso: '2026-08-09T03:00:00Z',
  toIso: '2026-08-10T05:00:00Z',
  /** The incident proper, as stated in the brief. */
  incidentFromIso: '2026-08-09T03:55:31Z',
  incidentToIso: '2026-08-10T03:30:28Z',
} as const;

const B = true;
const S = false;

export const WINDOW_CYCLES: WindowCycle[] = [
  { runId: 1186, at: '2026-08-09T03:55:31Z', durationSeconds: 1.4, outcome: 'skip', blind: B },
  { runId: 1187, at: '2026-08-09T04:30:07Z', durationSeconds: 29.99, outcome: 'decided', blind: S },
  { runId: 1188, at: '2026-08-09T05:35:30Z', durationSeconds: 25.83, outcome: 'decided', blind: S },
  { runId: 1189, at: '2026-08-09T06:40:15Z', durationSeconds: 37.15, outcome: 'decided', blind: S },
  { runId: 1190, at: '2026-08-09T07:45:10Z', durationSeconds: 40.81, outcome: 'decided', blind: S },
  { runId: 1191, at: '2026-08-09T08:50:06Z', durationSeconds: 1.19, outcome: 'skip', blind: B },
  { runId: 1192, at: '2026-08-09T09:20:30Z', durationSeconds: 1.26, outcome: 'skip', blind: B },
  { runId: 1193, at: '2026-08-09T09:55:13Z', durationSeconds: 1.19, outcome: 'skip', blind: B },
  { runId: 1194, at: '2026-08-09T10:30:18Z', durationSeconds: 1.25, outcome: 'skip', blind: B },
  { runId: 1195, at: '2026-08-09T11:00:31Z', durationSeconds: 19.22, outcome: 'decided', blind: S },
  { runId: 1196, at: '2026-08-09T12:05:30Z', durationSeconds: 1.26, outcome: 'skip', blind: B },
  { runId: 1197, at: '2026-08-09T12:40:03Z', durationSeconds: 1.35, outcome: 'skip', blind: B },
  { runId: 1198, at: '2026-08-09T13:10:17Z', durationSeconds: 1.28, outcome: 'skip', blind: B },
  { runId: 1199, at: '2026-08-09T13:45:15Z', durationSeconds: 1.31, outcome: 'skip', blind: B },
  { runId: 1200, at: '2026-08-09T14:15:28Z', durationSeconds: 1.49, outcome: 'skip', blind: B },
  { runId: 1201, at: '2026-08-09T14:50:29Z', durationSeconds: 1.23, outcome: 'skip', blind: B },
  { runId: 1202, at: '2026-08-09T15:25:30Z', durationSeconds: 1.28, outcome: 'skip', blind: B },
  { runId: 1203, at: '2026-08-09T16:00:31Z', durationSeconds: 1.2, outcome: 'skip', blind: B },
  { runId: 1204, at: '2026-08-09T16:35:13Z', durationSeconds: 1.28, outcome: 'skip', blind: B },
  { runId: 1205, at: '2026-08-09T17:05:21Z', durationSeconds: 1.25, outcome: 'skip', blind: B },
  { runId: 1206, at: '2026-08-09T17:35:24Z', durationSeconds: 1.22, outcome: 'skip', blind: B },
  { runId: 1207, at: '2026-08-09T18:10:05Z', durationSeconds: 1.17, outcome: 'skip', blind: B },
  { runId: 1208, at: '2026-08-09T18:40:12Z', durationSeconds: 1.17, outcome: 'skip', blind: B },
  { runId: 1209, at: '2026-08-09T19:15:29Z', durationSeconds: 1.13, outcome: 'skip', blind: B },
  { runId: 1210, at: '2026-08-09T19:50:08Z', durationSeconds: 1.09, outcome: 'skip', blind: B },
  { runId: 1211, at: '2026-08-09T20:20:15Z', durationSeconds: 1.19, outcome: 'skip', blind: B },
  { runId: 1212, at: '2026-08-09T20:50:16Z', durationSeconds: 1.05, outcome: 'skip', blind: B },
  { runId: 1213, at: '2026-08-09T21:25:10Z', durationSeconds: 1.17, outcome: 'skip', blind: B },
  { runId: 1214, at: '2026-08-09T21:55:28Z', durationSeconds: 1.24, outcome: 'skip', blind: B },
  { runId: 1215, at: '2026-08-09T22:30:18Z', durationSeconds: 1.2, outcome: 'skip', blind: B },
  { runId: 1216, at: '2026-08-09T23:05:07Z', durationSeconds: 1.26, outcome: 'skip', blind: B },
  { runId: 1217, at: '2026-08-09T23:35:14Z', durationSeconds: 1.16, outcome: 'skip', blind: B },
  { runId: 1218, at: '2026-08-10T00:10:12Z', durationSeconds: 24.66, outcome: 'decided', blind: S },
  { runId: 1219, at: '2026-08-10T01:15:05Z', durationSeconds: 1.21, outcome: 'skip', blind: B },
  { runId: 1220, at: '2026-08-10T01:50:08Z', durationSeconds: 1.12, outcome: 'skip', blind: B },
  { runId: 1221, at: '2026-08-10T02:20:26Z', durationSeconds: 1.57, outcome: 'skip', blind: B },
  { runId: 1222, at: '2026-08-10T02:55:30Z', durationSeconds: 1.24, outcome: 'skip', blind: B },
  { runId: 1223, at: '2026-08-10T03:30:28Z', durationSeconds: 23.22, outcome: 'decided', blind: S },
  { runId: 1224, at: '2026-08-10T04:35:16Z', durationSeconds: 22.1, outcome: 'decided', blind: S },
];

/**
 * The INCIDENT proper: 03:55 → 03:30, first blind cycle to the recovery that closed it.
 *
 * The frozen table above brackets it on both sides (03:00 → 05:00) so the replay can show
 * a healthy run-up and a healthy tail. The brief's headline figures — 31 blind cycles,
 * 1.24 s versus 28.70 s — are stated over the incident, not over the bracket, so anything
 * comparing against them has to narrow to this range first. (Including the trailing 04:35
 * cycle moves the healthy average to 27.87 s, which is how the difference was noticed.)
 */
export function incidentCycles(cycles: WindowCycle[] = WINDOW_CYCLES): WindowCycle[] {
  const from = Date.parse(WINDOW.incidentFromIso);
  const to = Date.parse(WINDOW.incidentToIso);
  return cycles.filter((c) => {
    const t = Date.parse(c.at);
    return t >= from && t <= to;
  });
}

/** The runs of consecutive blind cycles, in order — the brief's "1, puis 4, puis 22, puis 4". */
export function blindBlocks(cycles: WindowCycle[] = WINDOW_CYCLES): number[] {
  const blocks: number[] = [];
  let run = 0;
  for (const c of cycles) {
    if (c.blind) {
      run++;
    } else if (run > 0) {
      blocks.push(run);
      run = 0;
    }
  }
  if (run > 0) blocks.push(run);
  return blocks;
}
