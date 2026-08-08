import type { AssetRegime, RegimePoint } from './regime.js';

/**
 * THE STICKY TRANSITION — the actionability gate of the transition layer.
 *
 * Measured first, adopted second: every number behind it is in
 * `docs/RAPPORT-CONTRAT-TRANSITION.md` (PR #25). It now runs in production, in
 * OBSERVE MODE — the layer computes its verdict on every cycle and journals it, and
 * blocks nothing. This module is the rule itself and is deliberately free of I/O, so
 * the live path and the replay harness call exactly the same function.
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
  /**
   * The regime confirmed by three identical raw bars — equal to production's, ALWAYS.
   *
   * It is driven by `labelRun`, not by `runLength`, and that separation is the whole
   * point. Production's `Hysteresis` never sees timestamps: it consumes a sequence of
   * labels and confirms on the third identical one, hole or no hole. If the gap-aware
   * counter also drove this field, a hole would stop the sticky walk from confirming a
   * label that production DID confirm — the two would disagree, and the claim this
   * module rests on ("it gates, it never relabels", validated as T0) would simply be
   * false on any grid with a missing bar.
   *
   * So the two questions are answered by two counters: what does production believe the
   * regime is (`labelRun` → `active`), and have we actually observed three consecutive
   * bars of it (`runLength` → `actionable`). A hole makes the second answer no while
   * leaving the first untouched, which is exactly the intended conservatism.
   */
  active: AssetRegime;
  /** The unsmoothed label at this bar (the input the rule reads). */
  raw: AssetRegime;
  /**
   * Consecutive OBSERVED bars, this one included, on which `raw` has been unchanged. A
   * hole in the grid restarts it — this is the counter the actionability gate reads.
   */
  runLength: number;
  /**
   * The same count WITHOUT gap awareness: pure label equality, exactly as production's
   * `Hysteresis` counts. It drives `active` and nothing else.
   *
   * Equal to `runLength` on a gap-free grid, which is why the two were one counter until
   * a hole showed they answer different questions — see the note on `active`.
   */
  labelRun: number;
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
  barMs: number,
): StickyPoint[] {
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    throw new Error(`stickyTimeline: confirmations must be an integer >= 1 (got ${confirmations}).`);
  }
  if (!(barMs > 0)) {
    throw new Error(`stickyTimeline: barMs must be > 0 (got ${barMs}).`);
  }

  const out: StickyPoint[] = [];
  let previousRaw: AssetRegime | null = null;
  let previousTimestamp: number | null = null;
  // Two counters, deliberately. `runLength` is gap-aware and gates actionability;
  // `labelRun` ignores holes and mirrors production's Hysteresis, which decides `active`.
  let runLength = 0;
  let labelRun = 0;
  // Before the first confirmation there is no confirmed regime. The first raw label
  // seeds it, exactly as production's `Hysteresis` is constructed with the first raw
  // reading — otherwise the two walks would start from different states and the
  // equivalence claim above would be an artefact of the seed.
  let active: AssetRegime | null = null;

  for (const bar of raws) {
    // A HOLE IN THE GRID BREAKS THE RUN. `regimeTimeline` builds its grid from the
    // INTERSECTION of every asset's 4h timestamps, so one asset missing a candle removes
    // that bar for all of them — and the series arriving here is then not gap-free,
    // whatever this module would prefer. Counting across a hole would let two readings
    // eight or more hours apart stand as consecutive confirmations, thawing an asset that
    // was never observed for three consecutive bars. "Consecutive" has to mean observed
    // back to back, so an unobserved bar restarts the count rather than being assumed
    // unchanged.
    const contiguous = previousTimestamp != null && bar.timestamp - previousTimestamp === barMs;
    const sameLabel = bar.raw === previousRaw;
    runLength = contiguous && sameLabel ? runLength + 1 : 1;
    // NOT gap-aware, on purpose: production's Hysteresis counts labels, not timestamps,
    // so mirroring it is the only way `active` can stay identical to production's across
    // a hole. See the note on StickyPoint.active.
    labelRun = sameLabel ? labelRun + 1 : 1;
    previousRaw = bar.raw;
    previousTimestamp = bar.timestamp;
    active ??= bar.raw;
    if (labelRun >= confirmations) active = bar.raw;

    const actionable = runLength >= confirmations;
    out.push({
      timestamp: bar.timestamp,
      active,
      raw: bar.raw,
      runLength,
      labelRun,
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
  barMs: number,
): Record<string, StickyPoint[]> {
  const assets = points.length > 0 ? Object.keys(points[0]!.assets) : [];
  const out: Record<string, StickyPoint[]> = {};
  for (const asset of assets) {
    const raws = points
      .filter((p) => p.assets[asset] != null)
      .map((p) => ({ timestamp: p.timestamp, raw: p.assets[asset]!.raw }));
    out[asset] = stickyTimeline(raws, confirmations, barMs);
  }
  return out;
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
