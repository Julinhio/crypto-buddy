import type { AssetRegime, RegimePoint } from '../market/regime.js';

/**
 * THE STICKY TRANSITION — a candidate rule, implemented here to be MEASURED, never to
 * be executed. Nothing in `src/decision/`, `src/execution/` or `src/market/regime.ts`
 * imports this file, and nothing should until the measurement says it is worth it.
 *
 * The defect it answers is precise. The regime shown to the model is smoothed over
 * three confirmation bars; `pullbackConsumed` / `bounceConsumed` are computed on the
 * CURRENT bar with no smoothing at all. During a regime transition the model therefore
 * receives a label describing a PAST state glued to flags describing the PRESENT, and
 * the v5 mandate tells it to read that pair as an instruction. Twelve of the twenty-odd
 * orders of the 1-8 August week were placed on exactly that mismatch, ten of them sells,
 * while BTC / ETH / BNB were climbing.
 *
 * The rule, stated exactly as the brief specifies it:
 *
 *   1. the moment the RAW regime leaves the active one, the asset stops being actionable;
 *   2. ANY change of the raw regime — including a return to the old one — resets the
 *      counter to 1;
 *   3. after three identical raw bars that regime becomes active AND actionable FROM
 *      that third bar, not three bars later;
 *   4. a reappearance of the old regime for fewer than three consecutive bars never
 *      reopens actionability.
 *
 * Point 4 is what makes the criterion CAUSAL, and it is the whole reason the rule is
 * expressed as a run length rather than as "was this flicker followed by a return".
 * Deciding bar `t`'s actionability from bar `t+1` would be measuring a system that
 * cannot exist: at the moment it must act, the bot does not have the next candle.
 *
 * ── The four points collapse to one invariant ──────────────────────────────────
 *
 * Read together, 1-4 say nothing more than: an asset is actionable exactly when its
 * raw regime has been the SAME for `confirmations` consecutive bars, the current bar
 * included. Point 1 is the run breaking; point 2 is the run restarting at 1; point 3
 * is the run reaching 3; point 4 is a two-bar run still being a run shorter than 3.
 * One counter, read one way, and by construction it only ever looks backwards.
 *
 * ── The rule does NOT relabel anything ────────────────────────────────────────
 *
 * The active regime this walk produces is bar-for-bar identical to the one production's
 * `Hysteresis` produces — proven on real candles by the harness (criterion T0) and on
 * hand-built series by `src/test/stickyTransition.ts`. The two counters differ only in
 * their treatment of a bar where raw equals the active label (production resets the
 * candidate streak to 0, this one starts a run of the active label), and that
 * difference can never promote a label that was not already active.
 *
 * So the sticky transition adds an ACTIONABILITY GATE and nothing else. It cannot move
 * a regime, cannot invent one, and cannot change what the model is shown. That
 * separation is deliberate: a measurement whose gate also relabelled the tape would be
 * measuring two changes at once and could not attribute the result to either.
 */

/** One asset at one 4h bar, under the sticky rule. */
export interface StickyPoint {
  timestamp: number;
  /** The regime confirmed by three identical raw bars — equal to production's. */
  active: AssetRegime;
  /** The unsmoothed label at this bar (the input the rule reads). */
  raw: AssetRegime;
  /** Consecutive bars, this one included, on which `raw` has been unchanged. */
  runLength: number;
  /** `runLength >= confirmations` — the asset may be traded on this bar. */
  actionable: boolean;
  /**
   * True while the raw regime is mid-transition and the asset is therefore not
   * actionable. Exactly `!actionable`, named because "frozen" is what the report
   * measures and reading `!actionable` at every call site invites a slip.
   */
  frozen: boolean;
}

/**
 * Walks one asset's RAW series and returns its sticky state, bar by bar.
 *
 * `raws` must be in ascending bar order and gap-free — it comes from
 * `regimeTimeline`, whose grid is the intersection of every asset's closed 4h bars, so
 * "consecutive" means the same thing here as it does in production.
 *
 * The first bar starts a run of length 1, which makes the opening bars of any series
 * frozen until the first confirmation. That is a warm-up artefact, not a property of
 * the rule: callers replay ~60 days of bars before the measured window precisely so no
 * measurement ever sees it (asserted by the harness).
 */
export function stickyTimeline(
  raws: Array<{ timestamp: number; raw: AssetRegime }>,
  confirmations: number,
): StickyPoint[] {
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    throw new Error(`stickyTimeline: confirmations must be an integer >= 1 (got ${confirmations}).`);
  }

  const out: StickyPoint[] = [];
  let previousRaw: AssetRegime | null = null;
  let runLength = 0;
  // Before the first confirmation there is no confirmed regime. The first raw label
  // seeds it, exactly as production's `Hysteresis` is constructed with the first raw
  // reading — otherwise the two walks would start from different states and the
  // equivalence claim above would be an artefact of the seed.
  let active: AssetRegime | null = null;

  for (const bar of raws) {
    runLength = bar.raw === previousRaw ? runLength + 1 : 1;
    previousRaw = bar.raw;
    active ??= bar.raw;
    if (runLength >= confirmations) active = bar.raw;

    const actionable = runLength >= confirmations;
    out.push({
      timestamp: bar.timestamp,
      active,
      raw: bar.raw,
      runLength,
      actionable,
      frozen: !actionable,
    });
  }

  return out;
}

/** The sticky state of every asset in a replayed timeline, keyed by asset. */
export function stickyTimelines(
  points: RegimePoint[],
  confirmations: number,
): Record<string, StickyPoint[]> {
  const assets = points.length > 0 ? Object.keys(points[0]!.assets) : [];
  const out: Record<string, StickyPoint[]> = {};
  for (const asset of assets) {
    const raws = points
      .filter((p) => p.assets[asset] != null)
      .map((p) => ({ timestamp: p.timestamp, raw: p.assets[asset]!.raw }));
    out[asset] = stickyTimeline(raws, confirmations);
  }
  return out;
}

/** One uninterrupted stretch of frozen bars. */
export interface FreezeRun {
  asset: string;
  /** Bar the freeze started on (the first non-actionable bar). */
  fromMs: number;
  /** Bar the freeze ended on (the LAST non-actionable bar, not the bar that thawed it). */
  toMs: number;
  bars: number;
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
      hours: (bars * barMs) / 3_600_000,
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

/**
 * The sticky state a cycle waking at `atMs` would have read: the last bar that had
 * already CLOSED by then. This is production's own rule — `regimeTimeline` admits a bar
 * only once `timestamp + barMs <= nowMs` — restated here so a cycle is never matched to
 * a bar that was still forming when it ran. Null when no bar had closed yet.
 */
export function stickyAt(timeline: StickyPoint[], atMs: number, barMs: number): StickyPoint | null {
  let found: StickyPoint | null = null;
  for (const point of timeline) {
    if (point.timestamp + barMs > atMs) break;
    found = point;
  }
  return found;
}

/** The sticky state at one EXACT bar — used when a cycle journaled the bar it read. */
export function stickyAtBar(timeline: StickyPoint[], timestamp: number): StickyPoint | null {
  return timeline.find((p) => p.timestamp === timestamp) ?? null;
}
