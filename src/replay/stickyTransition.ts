import type { AssetRegime } from '../market/regime.js';
import type { StickyPoint } from '../market/transition.js';

/** Bars missing from an otherwise regular grid — reported, never silently smoothed over. */
export function gridGaps(timeline: StickyPoint[], barMs: number): number {
  let gaps = 0;
  for (let i = 1; i < timeline.length; i += 1) {
    if (timeline[i]!.timestamp - timeline[i - 1]!.timestamp !== barMs) gaps += 1;
  }
  return gaps;
}

/** One uninterrupted stretch of frozen bars. */
export interface FreezeRun {
  asset: string;
  /** Bar the freeze started on (the first non-actionable bar). */
  fromMs: number;
  /** Bar the freeze ended on (the LAST non-actionable bar, not the bar that thawed it). */
  toMs: number;
  /** Bars OBSERVED as frozen. Below `hours / (barMs/h)` when the grid had a hole. */
  bars: number;
  /**
   * Wall-clock span of the freeze, derived from the timestamps rather than from
   * `bars × barMs`. The two agree on a gap-free grid; where a bar is missing, the bar
   * count understates how long the position was actually unactionable — and "how long
   * can a line be frozen" is the question bloc A exists to answer, so it is measured in
   * elapsed time, not in observations.
   */
  hours: number;
  /** The regime that was active when the freeze began. */
  leftRegime: AssetRegime;
  /** The regime confirmed at the end of it — equal to `leftRegime` on an aborted return. */
  enteredRegime: AssetRegime;
  /** Distinct raw labels seen during the freeze — how much the tape flickered. */
  rawLabelsSeen: number;
  /**
   * True when the freeze RESOLVED back into the regime it left. This is the case point 4
   * exists for: the tape wobbled, the old regime came back, and the asset was frozen
   * throughout instead of being handed a stale label paired with live flags.
   *
   * Always false on an `openEnded` run, and that is not a detail. An unterminated freeze
   * whose last bars happen to print the old label has NOT reconfirmed it — the run is
   * still one or two bars short, which is exactly the state point 4 refuses to treat as
   * a return. Reading the raw label of a bar that never confirmed would inflate the
   * aborted-return count, and that count is the headline statistic of bloc A.
   */
  abortedReturn: boolean;
  /** Still frozen at the last bar of the measured window — the duration is a LOWER bound. */
  openEnded: boolean;
}

/** True when this run began before `fromMs` — i.e. it was already running at the boundary. */
export function startedBefore(run: FreezeRun, fromMs: number): boolean {
  return run.fromMs < fromMs;
}

/**
 * Extracts the freeze runs of one asset. A run that is still open at the end of the
 * series is reported with `openEnded: true` rather than silently closed: its true
 * duration is unknown, and rounding it down would flatter the rule in exactly the
 * statistic (max freeze duration) the brief asks us to bound.
 */
export function freezeRuns(asset: string, timeline: StickyPoint[], barMs: number): FreezeRun[] {
  const runs: FreezeRun[] = [];
  let start = -1;
  let labels = new Set<AssetRegime>();

  const close = (endIndex: number, openEnded: boolean): void => {
    const first = timeline[start]!;
    const last = timeline[endIndex]!;
    // The regime in force when the freeze began: the confirmed label of the bar BEFORE
    // it, or — when the freeze opens the series — the first bar's own active label.
    const leftRegime = start > 0 ? timeline[start - 1]!.active : first.active;
    const bars = endIndex - start + 1;
    runs.push({
      asset,
      fromMs: first.timestamp,
      toMs: last.timestamp,
      bars,
      hours: (last.timestamp + barMs - first.timestamp) / 3_600_000,
      leftRegime,
      // On an open-ended run this is the last RAW label seen, which by definition has
      // not been confirmed — hence the `openEnded` flag beside it, and hence
      // `abortedReturn` being false regardless of what that label happens to be.
      enteredRegime: last.raw,
      rawLabelsSeen: labels.size,
      abortedReturn: !openEnded && last.raw === leftRegime,
      openEnded,
    });
  };

  for (let i = 0; i < timeline.length; i += 1) {
    const point = timeline[i]!;
    if (point.frozen) {
      if (start < 0) {
        start = i;
        labels = new Set();
      }
      labels.add(point.raw);
      continue;
    }
    if (start >= 0) {
      close(i - 1, false);
      start = -1;
    }
  }
  if (start >= 0) close(timeline.length - 1, true);

  return runs;
}
