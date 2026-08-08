import assert from 'node:assert/strict';
import type { Candle } from '../market/klines.js';
import { Hysteresis, type AssetRegime } from '../market/regime.js';
import { closeAt, closedBy, lowestBetween } from '../replay/peakStop.js';
import { stickyAt, stickyTimeline } from '../market/transition.js';
import { freezeRuns } from '../replay/stickyTransition.js';

/**
 * Invariants of the STICKY TRANSITION rule — run with `npm test` (tsx). No framework.
 *
 * The harness measures what the rule COSTS on the real tape; these tests prove it is
 * the rule the brief specifies, whatever the tape does. Four properties carry the
 * whole thing, and each maps to one numbered point of the contract:
 *
 *   1. raw leaving the active regime freezes the asset;
 *   2. any change of raw — a return to the old label included — resets the counter to 1;
 *   3. the third identical raw bar confirms AND unfreezes, on that bar, not later;
 *   4. a short reappearance of the old regime never reopens actionability.
 *
 * Plus the two that make the measurement trustworthy at all: CAUSALITY (a bar's verdict
 * cannot move when a later bar is appended) and LABEL EQUIVALENCE (the rule gates, it
 * does not relabel — the confirmed regime matches production's `Hysteresis` bar for bar).
 */

const H4_MS = 4 * 60 * 60 * 1000;
const CONFIRMATIONS = 3;
let passed = 0;

/** Turns a shorthand series into the bar-stamped input the rule reads. */
function bars(raws: AssetRegime[]): Array<{ timestamp: number; raw: AssetRegime }> {
  return raws.map((raw, i) => ({ timestamp: i * H4_MS, raw }));
}

const U: AssetRegime = 'trend_up';
const R: AssetRegime = 'range';
const D: AssetRegime = 'trend_down';

{
  // Point 1 — the moment raw leaves the active regime, the asset stops being actionable.
  // Bars 0-2 confirm trend_up (actionable from bar 2); bar 3 prints `range` and freezes it.
  const t = stickyTimeline(bars([U, U, U, R]), CONFIRMATIONS, H4_MS);
  assert.deepEqual(
    t.map((p) => p.actionable),
    [false, false, true, false],
    'the third identical bar unfreezes; the first divergent bar re-freezes immediately',
  );
  assert.equal(t[3]!.active, U, 'the active regime does NOT follow the single divergent bar');
  assert.equal(t[3]!.runLength, 1, 'a divergent bar starts a run of 1');
  console.log('  ok: point 1 — raw leaving the active regime freezes the asset at once');
  passed += 1;
}

{
  // Point 2 — ANY change of raw resets the counter to 1, INCLUDING a return to the old
  // label. This is the case a naive "count bars since the active regime changed" gets
  // wrong: the two `range` bars are not allowed to keep their credit across the
  // trend_up that interrupts them.
  const t = stickyTimeline(bars([U, U, U, R, R, U, R, R, R]), CONFIRMATIONS, H4_MS);
  assert.deepEqual(
    t.map((p) => p.runLength),
    [1, 2, 3, 1, 2, 1, 1, 2, 3],
    'the interrupting trend_up resets the range run to 1 — the two earlier range bars expire',
  );
  assert.deepEqual(
    t.map((p) => p.actionable),
    [false, false, true, false, false, false, false, false, true],
    'nothing is actionable between the two confirmations',
  );
  assert.equal(t[8]!.active, R, 'range is confirmed only by its own three consecutive bars');
  console.log('  ok: point 2 — any change of raw resets the counter to 1');
  passed += 1;
}

{
  // Point 3 — confirmation happens ON the third bar, not three bars after it. Getting
  // this wrong would double the freeze and quietly make the whole rule look far more
  // expensive than it is.
  const t = stickyTimeline(bars([U, U, U, R, R, R, R]), CONFIRMATIONS, H4_MS);
  assert.equal(t[5]!.actionable, true, 'the third consecutive range bar is itself actionable');
  assert.equal(t[5]!.active, R, 'and it is the bar on which range becomes the active regime');
  assert.equal(t[4]!.actionable, false, 'the bar before it is still frozen');
  console.log('  ok: point 3 — the third identical bar confirms and unfreezes, on that bar');
  passed += 1;
}

{
  // Point 4 — a reappearance of the old regime for fewer than three consecutive bars
  // never reopens actionability. Two `trend_up` bars in the middle of a transition are
  // a flicker, not a return, and the asset stays frozen across them.
  const t = stickyTimeline(bars([U, U, U, R, U, U, R, R, R]), CONFIRMATIONS, H4_MS);
  assert.deepEqual(
    t.slice(3).map((p) => p.actionable),
    [false, false, false, false, false, true],
    'the two-bar trend_up flicker does not reopen actionability',
  );
  assert.equal(t[5]!.active, U, 'the active label is unchanged throughout the flicker');
  assert.equal(t[5]!.frozen, true, 'and the asset is frozen on it anyway — that is the point');

  // The mirror: a THREE-bar reappearance is a genuine return and does reopen it.
  const returned = stickyTimeline(bars([U, U, U, R, U, U, U, R]), CONFIRMATIONS, H4_MS);
  assert.equal(returned[6]!.actionable, true, 'three consecutive old-regime bars are a real return');
  assert.equal(returned[6]!.active, U, 'and the regime is trend_up again');
  console.log('  ok: point 4 — a short reappearance never reopens actionability; a three-bar one does');
  passed += 1;
}

{
  // CAUSALITY. The verdict for bar `t` is a function of bars 0..t only. Proven by
  // construction rather than by inspection: replay every prefix of a jagged series and
  // check the last point of each prefix equals the same point in the full walk. If any
  // look-ahead existed — "was this flicker followed by a return" — this test fails.
  const series = bars([U, R, U, U, R, R, D, D, D, R, D, D, U, U, U, R, U, R, R, R]);
  const full = stickyTimeline(series, CONFIRMATIONS, H4_MS);
  for (let n = 1; n <= series.length; n += 1) {
    const prefix = stickyTimeline(series.slice(0, n), CONFIRMATIONS, H4_MS);
    assert.deepEqual(
      prefix[n - 1],
      full[n - 1],
      `bar ${n - 1} decided differently when the future was unknown — the rule is not causal`,
    );
  }
  console.log(`  ok: causality — all ${series.length} bars decide identically on every prefix`);
  passed += 1;
}

{
  // LABEL EQUIVALENCE — the claim the whole measurement rests on: the sticky walk
  // GATES, it does not relabel. If the confirmed regime ever diverged from production's
  // `Hysteresis`, the harness would be measuring a different tape and could not
  // attribute any of its numbers to the actionability gate alone.
  //
  // Checked on an exhaustive enumeration rather than on a sample: every series of 10
  // bars over a 3-label alphabet is 59 049 walks, which runs in well under a second and
  // leaves no corner uncovered.
  const alphabet: AssetRegime[] = [U, R, D];
  const LENGTH = 10;
  let walks = 0;
  const series = new Array<AssetRegime>(LENGTH);

  const walk = (i: number): void => {
    if (i === LENGTH) {
      const sticky = stickyTimeline(bars(series), CONFIRMATIONS, H4_MS);
      const hysteresis = new Hysteresis<AssetRegime>(series[0]!, CONFIRMATIONS);
      for (let k = 0; k < LENGTH; k += 1) {
        const production = hysteresis.push(series[k]!);
        assert.equal(
          sticky[k]!.active,
          production.value,
          `relabelled at bar ${k} of [${series.join(',')}]: sticky ${sticky[k]!.active} vs production ${production.value}`,
        );
      }
      walks += 1;
      return;
    }
    for (const label of alphabet) {
      series[i] = label;
      walk(i + 1);
    }
  };
  walk(0);

  assert.equal(walks, alphabet.length ** LENGTH, 'the enumeration must be exhaustive');
  console.log(`  ok: label equivalence — ${walks.toLocaleString('en-US')} exhaustive walks, zero relabelling`);
  passed += 1;
}

{
  // Freeze runs: boundaries, and the honesty of an unterminated one. The series ends
  // mid-transition, so the last run's duration is a LOWER bound and must say so —
  // closing it silently would understate the very statistic (longest freeze) the
  // measurement exists to bound.
  const t = stickyTimeline(bars([U, U, U, R, R, U, R, R]), CONFIRMATIONS, H4_MS);
  const runs = freezeRuns('BTC', t, H4_MS);

  assert.equal(runs.length, 2, 'the warm-up freeze and the trailing one');
  assert.equal(runs[0]!.bars, 2, 'bars 0-1, before trend_up is first confirmed');
  assert.equal(runs[0]!.openEnded, false, 'it was resolved by bar 2');

  const trailing = runs[1]!;
  assert.equal(trailing.fromMs, 3 * H4_MS, 'the freeze starts on the first non-actionable bar');
  assert.equal(trailing.toMs, 7 * H4_MS, 'and ends on the LAST one, not on the bar that thawed it');
  assert.equal(trailing.bars, 5, 'bars 3-7');
  assert.equal(trailing.hours, 20, 'five 4h bars is 20 hours');
  assert.equal(trailing.openEnded, true, 'still frozen at the last bar — the duration is a lower bound');
  assert.equal(trailing.leftRegime, U, 'it left trend_up');
  assert.equal(trailing.enteredRegime, R, 'and had not settled back into it');
  assert.equal(trailing.abortedReturn, false, 'so it is not an aborted return');
  assert.equal(trailing.rawLabelsSeen, 2, 'range and trend_up printed during it');

  // An ABORTED RETURN: the tape wobbles into `range` and settles back on trend_up. The
  // asset was frozen throughout, which is exactly the episode point 4 exists for.
  const aborted = freezeRuns('BTC', stickyTimeline(bars([U, U, U, R, R, U, U, U]), CONFIRMATIONS, H4_MS), H4_MS);
  const wobble = aborted[aborted.length - 1]!;
  assert.equal(wobble.abortedReturn, true, 'the freeze resolved back into the regime it left');
  assert.equal(wobble.enteredRegime, U, 'trend_up was re-confirmed, not replaced');
  assert.equal(wobble.bars, 4, 'bars 3-6: two range bars plus the first two of the return');
  console.log('  ok: freeze runs — boundaries, open-ended honesty, aborted returns');
  passed += 1;
}

{
  // An UNTERMINATED freeze is never an aborted return, whatever its last raw bar says.
  // The series ends with two `trend_up` bars after leaving trend_up — a flicker back that
  // has NOT reconfirmed, since it is one bar short. Reading its raw label as a return
  // would inflate the aborted-return count, which is bloc A's headline statistic.
  const runs = freezeRuns('BTC', stickyTimeline(bars([U, U, U, R, R, U, U]), CONFIRMATIONS, H4_MS), H4_MS);
  const trailing = runs[runs.length - 1]!;
  assert.equal(trailing.openEnded, true, 'the run is still frozen at the last bar');
  assert.equal(trailing.enteredRegime, U, 'its last raw bar does print the regime it left');
  assert.equal(trailing.abortedReturn, false, 'but an unconfirmed flicker back is not a return');

  // One more bar confirms it, and only then is it an aborted return.
  const confirmed = freezeRuns('BTC', stickyTimeline(bars([U, U, U, R, R, U, U, U]), CONFIRMATIONS, H4_MS), H4_MS);
  const resolved = confirmed[confirmed.length - 1]!;
  assert.equal(resolved.openEnded, false, 'the third trend_up bar closes the freeze');
  assert.equal(resolved.abortedReturn, true, 'and NOW it is an aborted return');
  console.log('  ok: an unterminated freeze is never counted as an aborted return');
  passed += 1;
}

{
  // A cycle reads the last bar that had CLOSED by its wall clock — production's own
  // rule. A cycle running one millisecond into a bar must read the PREVIOUS one.
  const t = stickyTimeline(bars([U, U, U, R]), CONFIRMATIONS, H4_MS);
  assert.equal(stickyAt(t, 0, H4_MS), null, 'at the very first open, no bar has closed yet');
  assert.equal(stickyAt(t, H4_MS, H4_MS)!.timestamp, 0, 'bar 0 becomes readable exactly when it closes');
  assert.equal(
    stickyAt(t, 3 * H4_MS + 1, H4_MS)!.timestamp,
    2 * H4_MS,
    'a cycle 1ms into bar 3 reads bar 2 — the forming bar is never read',
  );
  assert.equal(stickyAt(t, 3 * H4_MS + 1, H4_MS)!.actionable, true, 'and bar 2 was actionable');
  console.log('  ok: a cycle only ever reads a bar that had already closed');
  passed += 1;
}

{
  // A HOLE IN THE GRID BREAKS THE RUN. `regimeTimeline` builds its grid from the
  // INTERSECTION of every asset's 4h timestamps, so one asset missing a candle drops
  // that bar for all of them and the series arriving here is not gap-free. Counting
  // across the hole would let readings 8h apart stand as consecutive confirmations and
  // thaw an asset that was never observed for three consecutive bars.
  const withHole: Array<{ timestamp: number; raw: AssetRegime }> = [
    { timestamp: 0 * H4_MS, raw: R },
    { timestamp: 1 * H4_MS, raw: R },
    // the 2 × H4_MS bar is missing — one asset's candle never arrived
    { timestamp: 3 * H4_MS, raw: R },
    { timestamp: 4 * H4_MS, raw: R },
    { timestamp: 5 * H4_MS, raw: R },
  ];
  const t = stickyTimeline(withHole, CONFIRMATIONS, H4_MS);
  assert.deepEqual(
    t.map((p) => p.runLength),
    [1, 2, 1, 2, 3],
    'the missing bar restarts the count instead of being assumed unchanged',
  );
  assert.equal(t[2]!.actionable, false, 'the bar after the hole cannot inherit the run before it');
  assert.equal(t[4]!.actionable, true, 'three genuinely consecutive bars still confirm');

  // ...but the CONFIRMED LABEL must not be held back by the hole. Production's
  // `Hysteresis` counts labels, never timestamps, so it confirms `range` on the third
  // identical reading whatever the grid did. If the gap-aware counter also drove
  // `active`, the two walks would disagree and T0 — "the rule gates, it never
  // relabels" — would be false on any grid with a missing bar.
  assert.deepEqual(
    t.map((p) => p.labelRun),
    [1, 2, 3, 4, 5],
    'the label run ignores the hole, exactly as production does',
  );
  const production = new Hysteresis<AssetRegime>(withHole[0]!.raw, CONFIRMATIONS);
  for (let i = 0; i < withHole.length; i += 1) {
    assert.equal(
      t[i]!.active,
      production.push(withHole[i]!.raw).value,
      `the confirmed label diverged from production at index ${i} — across a hole`,
    );
  }
  assert.equal(t[2]!.frozen, true, 'frozen on the post-hole bar, though the label is confirmed');

  // And a freeze spanning a hole reports ELAPSED time, not observation count: bars 0-3
  // are frozen, which is four bars of wall clock (16h) even though only three were seen.
  const runs = freezeRuns('BTC', t, H4_MS);
  assert.equal(runs[0]!.bars, 4, 'four frozen observations');
  assert.equal(runs[0]!.hours, 20, 'spanning 00:00 to 20:00 — elapsed time, not bars × barMs');
  console.log('  ok: a hole in the grid restarts the run and is counted in elapsed time');
  passed += 1;
}

{
  // The guard on `confirmations`. A zero or fractional value would make the rule a
  // no-op (everything actionable) while still producing plausible-looking output —
  // the worst kind of failure for a measurement harness.
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => stickyTimeline(bars([U]), bad, H4_MS),
      /confirmations must be an integer >= 1/,
      `confirmations=${bad} must be refused`,
    );
  }
  assert.equal(stickyTimeline(bars([U]), 1, H4_MS)[0]!.actionable, true, 'confirmations=1 is a valid no-op');
  console.log('  ok: a nonsensical confirmations count is refused, not silently tolerated');
  passed += 1;
}

{
  // The price lookups the stop calibration reads must go NULL past the end of the
  // series, never fall back to the last close available. A feed that stops short would
  // otherwise answer "what was the price 72h after the exit" with a price from before
  // the exit — a plausible number for the wrong horizon, which is the one failure mode a
  // measurement harness cannot detect in its own output.
  const candles: Candle[] = [0, 1, 2].map((i) => ({
    timestamp: i * H4_MS,
    open: 100,
    high: 110,
    low: 90 - i,
    close: 100 + i,
    volume: 1,
  }));
  const lastClose = 2 * H4_MS + H4_MS; // the series covers up to here

  assert.equal(closeAt(candles, 0, H4_MS), null, 'before the first close, nothing has closed');
  assert.equal(closeAt(candles, H4_MS, H4_MS)!.toNumber(), 100, 'the first candle closes on time');
  assert.equal(closeAt(candles, lastClose, H4_MS)!.toNumber(), 102, 'the last close is reachable exactly');
  assert.equal(closeAt(candles, lastClose + 1, H4_MS), null, 'one ms past the series is already out of range');
  assert.equal(closeAt(candles, lastClose + 72 * 3_600_000, H4_MS), null, 'a 72h horizon past the feed is null');
  assert.equal(closeAt([], H4_MS, H4_MS), null, 'an empty series has no price');

  assert.equal(lowestBetween(candles, 0, lastClose, H4_MS)!.toNumber(), 88, 'the lowest low over the covered span');
  assert.equal(
    lowestBetween(candles, 0, lastClose + 1, H4_MS),
    null,
    'a span the series does not fully cover is null, not a low over the part we happen to have',
  );
  console.log('  ok: the price lookups go null past the series instead of substituting a stale close');
  passed += 1;
}

{
  // Coverage is checked at BOTH ends and in the MIDDLE. Guarding only the right end
  // still lets a feed that starts late, or that drops a bar somewhere inside, return a
  // minimum over an unknown subset — the same plausible-partial-window value, reached
  // from a different direction.
  const bar = (i: number, low: number): Candle => ({
    timestamp: i * H4_MS,
    open: 100,
    high: 110,
    low,
    close: 100,
    volume: 1,
  });

  const late = [bar(2, 80), bar(3, 81)];
  assert.equal(
    lowestBetween(late, 0, 4 * H4_MS, H4_MS),
    null,
    'a series that starts after fromMs cannot claim to cover the interval',
  );

  const holed = [bar(0, 90), bar(1, 91), /* bar 2 missing */ bar(3, 70)];
  assert.equal(
    lowestBetween(holed, 0, 4 * H4_MS, H4_MS),
    null,
    'a hole inside the interval is refused, not silently skipped over',
  );

  const whole = [bar(0, 90), bar(1, 91), bar(2, 85), bar(3, 70)];
  assert.equal(lowestBetween(whole, 0, 4 * H4_MS, H4_MS)!.toNumber(), 70, 'a complete interval resolves');

  // The same middle-of-the-series hole must not let `closeAt` answer with a price from
  // the far side of the gap.
  assert.equal(
    closeAt(holed, 3 * H4_MS, H4_MS),
    null,
    'a close requested inside a gap is null, not the last bar before the gap',
  );
  assert.equal(closeAt(whole, 3 * H4_MS, H4_MS)!.toNumber(), 100, 'and resolves when the bar is there');
  console.log('  ok: interval coverage is verified at both ends and through the middle');
  passed += 1;
}

{
  // THE STILL-FORMING CANDLE. `fetchCandlesSince` returns ccxt's last candle even when
  // its interval has not ended, and `closeAt`'s range guard reads that candle's
  // SCHEDULED end as observed coverage. A 24h/72h target landing inside it therefore
  // passes the guard and gets answered with the PRECEDING close — a rebound reported for
  // a horizon the replay never reached.
  const HOUR = 3_600_000;
  const series: Candle[] = [0, 1, 2, 3].map((i) => ({
    timestamp: i * HOUR,
    open: 100,
    high: 110,
    low: 90,
    close: 100 + i,
    volume: 1,
  }));
  // The run's observation cutoff falls INSIDE the last candle: bars 0-2 have closed,
  // bar 3 (03:00-04:00) is still forming.
  const cutoff = 3 * HOUR + 30 * 60_000;
  const target = 3 * HOUR + 45 * 60_000; // inside the forming candle, past the cutoff

  // Unfiltered — the defect. The guard passes because 03:45 < the forming candle's
  // scheduled end of 04:00, and the last CLOSED bar's close is handed back.
  assert.equal(
    closeAt(series, target, HOUR)!.toNumber(),
    102,
    'without the filter, a target inside the forming candle silently resolves to the previous close',
  );

  // Filtered at the captured cutoff — the fix. The series now ends at the last candle
  // that actually closed, so the target is genuinely out of range.
  const closed = closedBy(series, cutoff, HOUR);
  assert.equal(closed.length, 3, 'the still-forming candle is dropped');
  assert.equal(closed[closed.length - 1]!.timestamp, 2 * HOUR, 'the series ends on the last closed bar');
  assert.equal(
    closeAt(closed, target, HOUR),
    null,
    'a horizon the replay had not reached must read as missing, not as a fabricated rebound',
  );

  // A target inside the covered span still resolves normally.
  assert.equal(closeAt(closed, 3 * HOUR, HOUR)!.toNumber(), 102, 'a reachable horizon is unaffected');
  console.log('  ok: the still-forming candle cannot answer a horizon the replay never reached');
  passed += 1;
}

console.log(`\n${passed} sticky-transition invariant checks passed.`);
