import 'dotenv/config';
import { config } from '../config/index.js';
import { publicMainnetClient } from '../exchanges/binance.js';
import type { Candle } from '../market/klines.js';
import { timeframeMs } from '../market/klines.js';
import { regimeTimeline, type AssetRegime, type RegimePoint } from '../market/regime.js';
import { Decimal, dec } from '../money.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { tradableBaseAssets } from '../config/index.js';
import { fetchCandlesSince } from './klines.js';
import { PEAK_STOP_THRESHOLDS, closeAt, runPeakStop, type StopEpisode, type StopRun } from './peakStop.js';
import {
  freezeRuns,
  gridGaps,
  startedBefore,
  stickyAt,
  stickyTimelines,
  type FreezeRun,
  type StickyPoint,
} from './stickyTransition.js';
import { loadCycleStream, replayPeaks, type Booking, type Cycle } from './transitionCycles.js';
import { fmtBar, loadObservationWindow, pct, replayRegimeOptions, withinWindow } from './window.js';

/**
 * TRANSITION CONTRACT — the measurement harness for the sticky-transition rule and the
 * peak stop that has to come with it.
 *
 * MEASUREMENT ONLY. Nothing here is wired into a decision, and nothing in
 * `src/decision/`, `src/execution/` or `src/market/regime.ts` imports any of it. The bot
 * is running while this executes, and Supabase is read strictly read-only.
 *
 * The defect being measured was established before this harness existed and is not
 * re-litigated here — but the code was checked against it, and it holds. `signalsAt`
 * computes `pullbackConsumed` / `bounceConsumed` from the CURRENT bar's tactical range
 * position, with no smoothing; the regime handed to the model is the one that survived
 * three confirmation bars. During a transition the model is therefore shown a label
 * describing a past state next to two flags describing the present, and the v5 playbook
 * (`promptV5.ts`) instructs it to read that pair as an instruction — "reversal_down +
 * pullbackConsumed FALSE → LIGHTEN". Cycle 1163's own journal is the clean specimen:
 * BNB shown `range` while raw was `trend_up` two bars from confirmation, and the model
 * wrote "régime passé de trend_up à range" — reading a stale label as fresh news — then
 * sold two points of the line into a rising market.
 *
 * One nuance the diagnosis does not mention and the code does: `raw` and `pendingRegime`
 * ARE present in the JSON the model receives, since the whole `RegimeJournal` is
 * serialised into the context. The mandate never names them, never explains them and
 * never tells the model what to do with them. That is not a mitigation — an undocumented
 * field in a payload the model is told not to argue with is closer to a trap than to a
 * warning — but it is a fact, and a reader of this report should have it.
 *
 * Run with `npm run replay:transition`. Exits non-zero if a VALIDATION fails; the three
 * measurement blocs never fail, they report.
 */

const HOUR_MS = 3_600_000;
const barMs = timeframeMs(config.regime.timeframe);
const confirmations = config.regime.thresholds.confirmations;

/* ── Reporting plumbing ───────────────────────────────────────────────────── */

interface Validation {
  id: string;
  title: string;
  passed: boolean;
  detail: string[];
}

const validations: Validation[] = [];

function validate(id: string, title: string, passed: boolean, detail: string[]): void {
  validations.push({ id, title, passed, detail });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

function section(title: string): void {
  console.log('');
  console.log('═'.repeat(100));
  console.log(title);
  console.log('═'.repeat(100));
}

function subsection(title: string): void {
  console.log('');
  console.log(`─ ${title} `.padEnd(100, '─'));
}

const n1 = (v: number): string => v.toFixed(1);
const n2 = (v: number): string => v.toFixed(2);
const usd = (v: Decimal): string => `${v.gte(0) ? '+' : '−'}$${v.abs().toFixed(2)}`;

/** Quantiles of a numeric sample, nearest-rank. Empty sample → null. */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? null;
}

/* ── Bloc A — what the freeze costs ───────────────────────────────────────── */

interface FreezeStats {
  asset: string;
  bars: number;
  frozenBars: number;
  freezePercent: number;
  runs: FreezeRun[];
  longestBars: number;
  longestHours: number;
  longestOpenEnded: boolean;
  abortedReturns: number;
  /** Runs that were already frozen when the window opened — measured whole, not truncated. */
  startedBeforeWindow: number;
}

/**
 * Bloc A's two statistics come from two different views, and mixing them up censors the
 * data at the window's left edge.
 *
 * The freeze RATE is a property of the observation window, so it is counted on the bars
 * inside it. But a freeze that was already running when the window opened is a real
 * episode with a real duration, and slicing first would make its first retained bar look
 * like its start — reporting a truncated length as exact, and feeding it to the median,
 * the tail and the maximum. That is the same defect as an open-ended run at the other
 * edge, which the module already refuses to close silently.
 *
 * So DURATIONS are extracted from the full walk (warm-up included, where the true start
 * lives) and then filtered to the runs that overlap the window. Nothing is censored, and
 * `startedBeforeWindow` marks the ones that reach back past the opening bar.
 */
function blocA(
  sticky: Record<string, StickyPoint[]>,
  stickyAnalysed: Record<string, StickyPoint[]>,
  assets: string[],
  window: { fromMs: number; toMs: number },
): FreezeStats[] {
  const stats: FreezeStats[] = [];
  for (const asset of assets) {
    const timeline = sticky[asset] ?? [];
    const runs = freezeRuns(asset, stickyAnalysed[asset] ?? [], barMs).filter(
      (r) => r.toMs + barMs >= window.fromMs && r.fromMs + barMs <= window.toMs,
    );
    const frozenBars = timeline.filter((p) => p.frozen).length;
    // Longest by ELAPSED TIME, not by observation count: across a hole in the grid the
    // two disagree, and the question bloc A answers is how long a line can stay frozen.
    const longest = runs.reduce<FreezeRun | null>((best, r) => (best == null || r.hours > best.hours ? r : best), null);
    stats.push({
      asset,
      bars: timeline.length,
      frozenBars,
      freezePercent: timeline.length === 0 ? 0 : (frozenBars / timeline.length) * 100,
      runs,
      longestBars: longest?.bars ?? 0,
      longestHours: longest?.hours ?? 0,
      longestOpenEnded: longest?.openEnded ?? false,
      abortedReturns: runs.filter((r) => r.abortedReturn).length,
      startedBeforeWindow: runs.filter((r) => startedBefore(r, window.fromMs)).length,
    });
  }
  return stats;
}

function printBlocA(stats: FreezeStats[]): void {
  section('BLOC A — the cost of the freeze');

  const totalBars = stats.reduce((s, a) => s + a.bars, 0);
  const totalFrozen = stats.reduce((s, a) => s + a.frozenBars, 0);
  const allRuns = stats.flatMap((a) => a.runs);
  // Aggregated on ELAPSED HOURS, not on observed bars. The two coincide on a gap-free
  // grid — which this run has — but a hole makes the bar count understate how long the
  // position was actually unactionable, and that is the quantity bloc A is about. Bar
  // counts are still published, next to the hours rather than instead of them.
  const durations = allRuns.map((r) => r.hours).sort((a, b) => a - b);

  subsection('freeze rate');
  console.log(`   ${'asset'.padEnd(8)}${'bars'.padStart(7)}${'frozen'.padStart(9)}${'rate'.padStart(9)}${'runs'.padStart(7)}${'longest'.padStart(20)}${'aborted returns'.padStart(18)}`);
  for (const a of stats) {
    console.log(
      `   ${a.asset.padEnd(8)}${String(a.bars).padStart(7)}${String(a.frozenBars).padStart(9)}` +
        `${(`${n1(a.freezePercent)}%`).padStart(9)}${String(a.runs.length).padStart(7)}` +
        `${`${a.longestBars} bars / ${n1(a.longestHours)}h${a.longestOpenEnded ? ' ≥' : ''}`.padStart(20)}` +
        `${String(a.abortedReturns).padStart(18)}`,
    );
  }
  console.log(
    `   ${'ALL'.padEnd(8)}${String(totalBars).padStart(7)}${String(totalFrozen).padStart(9)}` +
      `${(`${n1((totalFrozen / totalBars) * 100)}%`).padStart(9)}${String(allRuns.length).padStart(7)}` +
      `${`${Math.max(...stats.map((a) => a.longestBars))} bars`.padStart(20)}` +
      `${String(stats.reduce((s, a) => s + a.abortedReturns, 0)).padStart(18)}`,
  );
  console.log('   (≥ marks a run still open at the window\'s last bar — its duration is a lower bound)');
  console.log(
    `   runs already frozen when the window opened: ${stats.reduce((s, a) => s + a.startedBeforeWindow, 0)} ` +
      `— measured whole from the warm-up walk, never truncated at the boundary`,
  );

  subsection('distribution of freeze durations (all assets, in ELAPSED hours)');
  const histogram = new Map<number, { runs: number; barsMin: number; barsMax: number }>();
  for (const r of allRuns) {
    const bucket = histogram.get(r.hours) ?? { runs: 0, barsMin: r.bars, barsMax: r.bars };
    bucket.runs += 1;
    bucket.barsMin = Math.min(bucket.barsMin, r.bars);
    bucket.barsMax = Math.max(bucket.barsMax, r.bars);
    histogram.set(r.hours, bucket);
  }
  for (const [hours, bucket] of [...histogram.entries()].sort((a, b) => a[0] - b[0])) {
    const share = (bucket.runs / durations.length) * 100;
    const observed =
      bucket.barsMin === bucket.barsMax ? `${bucket.barsMin}` : `${bucket.barsMin}-${bucket.barsMax}`;
    console.log(
      `   ${n1(hours).padStart(5)}h  (${observed.padStart(5)} bars observed)  ${String(bucket.runs).padStart(4)} runs  ` +
        `${n1(share).padStart(5)}%  ${'█'.repeat(Math.max(1, Math.round(share / 2)))}`,
    );
  }
  const q = (p: number): string => `${n1(quantile(durations, p) ?? 0)}h`;
  console.log(
    `   n = ${durations.length}  ·  median ${q(0.5)}  ·  p90 ${q(0.9)}  ·  p99 ${q(0.99)}  ` +
      `·  max ${n1(durations[durations.length - 1] ?? 0)}h`,
  );
  console.log(
    '   "bars observed" is the count of 4h readings inside that span. It equals hours / 4 on a gap-free',
    '\n   grid (this run has no holes — see T3); where the two differ, the elapsed figure is the honest one.',
  );

  subsection('aborted returns — the flicker point 4 neutralises');
  const aborted = allRuns.filter((r) => r.abortedReturn);
  console.log(
    `   ${aborted.length} of ${allRuns.length} freezes (${n1((aborted.length / allRuns.length) * 100)}%) resolved back ` +
      `into the regime they left.`,
  );
  console.log(
    '   These are the episodes the rule exists for: the tape wobbled, the old regime came back, and under',
  );
  console.log(
    '   the current code the model was shown a stale label beside live flags throughout. Under the rule the',
  );
  console.log('   asset is simply not actionable until the tape settles.');
  const worstAborted = [...aborted].sort((a, b) => b.bars - a.bars).slice(0, 5);
  for (const r of worstAborted) {
    console.log(
      `     ${r.asset.padEnd(4)} ${fmtBar(r.fromMs)} → ${fmtBar(r.toMs)}  ${String(r.bars).padStart(2)} bars ` +
        `(${n1(r.hours)}h)  left ${r.leftRegime}, ${r.rawLabelsSeen} raw label(s) seen`,
    );
  }
}

/* ── Bloc B — the orders the rule suppresses ──────────────────────────────── */

interface OrderVerdict {
  booking: Booking;
  cycle: Cycle;
  allowed: boolean;
  /** Null when no bar had closed — an order the rule could not even judge. */
  state: StickyPoint | null;
  /** The journaled pair, when this cycle carried a regime. */
  journaledRaw: AssetRegime | null;
  journaledStable: AssetRegime | null;
  diverging: boolean;
  /**
   * For a FORBIDDEN order: hours until the asset became actionable again, i.e. how long
   * the rule DELAYS it. Null when it never did inside the window.
   *
   * This is the number that decides whether the rule is a filter or a muzzle. "Blocked"
   * and "delayed by one bar" are the same word in the verdict column and completely
   * different outcomes for the book, and a suppression count cannot distinguish them.
   */
  delayHours: number | null;
  /**
   * Price move over that delay, signed IN THE ORDER'S FAVOUR: positive means waiting
   * would have got a better price (a higher sell, a lower buy).
   */
  delayImprovementPercent: number | null;
}

function blocB(
  cycles: Cycle[],
  sticky: Record<string, StickyPoint[]>,
  series: Record<string, Candle[]>,
  priceBarMs: number,
): OrderVerdict[] {
  const byId = new Map(cycles.map((c) => [c.id, c]));
  const verdicts: OrderVerdict[] = [];
  for (const cycle of cycles) {
    for (const booking of cycle.bookings) {
      const host = byId.get(booking.decisionId) ?? cycle;
      const timeline = sticky[booking.asset] ?? [];
      const state = stickyAt(timeline, host.generatedAtMs, barMs);
      const journal = host.regime?.get(booking.asset) ?? null;
      const allowed = state?.actionable === true;

      // The first bar AFTER the one this cycle read on which the asset is actionable.
      // The earliest a cycle could act on it is once that bar has closed.
      let delayHours: number | null = null;
      let delayImprovementPercent: number | null = null;
      if (!allowed) {
        const readIndex = state == null ? -1 : timeline.findIndex((p) => p.timestamp === state.timestamp);
        const thaw = timeline.slice(readIndex + 1).find((p) => p.actionable);
        if (thaw != null) {
          const actionableAtMs = thaw.timestamp + barMs;
          delayHours = (actionableAtMs - host.generatedAtMs) / HOUR_MS;
          const later = closeAt(series[booking.asset] ?? [], actionableAtMs, priceBarMs);
          if (later != null && booking.valuationPrice.gt(0)) {
            const move = later.minus(booking.valuationPrice).div(booking.valuationPrice).times(100).toNumber();
            delayImprovementPercent = booking.side === 'sell' ? move : -move;
          }
        }
      }

      verdicts.push({
        booking,
        cycle: host,
        allowed,
        state,
        journaledRaw: journal?.raw ?? null,
        journaledStable: journal?.regime ?? null,
        diverging: journal != null && journal.raw !== journal.regime,
        delayHours,
        delayImprovementPercent,
      });
    }
  }
  return verdicts;
}

function printOrderTable(verdicts: OrderVerdict[]): void {
  console.log(
    `   ${'cycle'.padEnd(6)}${'when'.padEnd(18)}${'asset'.padEnd(6)}${'side'.padEnd(6)}${'notional'.padStart(10)}  ` +
      `${'shown'.padEnd(14)}${'raw'.padEnd(14)}${'run'.padStart(4)}  verdict`,
  );
  for (const v of verdicts) {
    const notional = v.booking.baseDelta.abs().times(v.booking.valuationPrice);
    console.log(
      `   ${String(v.cycle.id).padEnd(6)}${fmtBar(v.cycle.generatedAtMs).padEnd(18)}${v.booking.asset.padEnd(6)}` +
        `${v.booking.side.padEnd(6)}${`$${notional.toFixed(2)}`.padStart(10)}  ` +
        `${(v.journaledStable ?? v.state?.active ?? 'n/a').padEnd(14)}` +
        `${(v.journaledRaw ?? v.state?.raw ?? 'n/a').padEnd(14)}` +
        `${String(v.state?.runLength ?? 0).padStart(4)}  ${v.allowed ? 'ALLOWED' : 'FORBIDDEN'}` +
        `${v.diverging ? '  ·  raw ≠ shown' : ''}`,
    );
  }
}

function printBlocB(verdicts: OrderVerdict[], sticky: Record<string, StickyPoint[]>): void {
  section('BLOC B — the orders the rule suppresses, and the ones it keeps');

  const allowed = verdicts.filter((v) => v.allowed);
  const forbidden = verdicts.filter((v) => !v.allowed);
  const count = (list: OrderVerdict[], side: 'buy' | 'sell'): number =>
    list.filter((v) => v.booking.side === side).length;

  subsection('the two counts, side by side');
  console.log(`   real sovereign bookings over the whole history: ${verdicts.length}`);
  console.log(
    `   ALLOWED    ${String(allowed.length).padStart(3)}  (${count(allowed, 'buy')} buy / ${count(allowed, 'sell')} sell)  ` +
      `— ${n1((allowed.length / verdicts.length) * 100)}% of the book`,
  );
  console.log(
    `   FORBIDDEN  ${String(forbidden.length).padStart(3)}  (${count(forbidden, 'buy')} buy / ${count(forbidden, 'sell')} sell)  ` +
      `— ${n1((forbidden.length / verdicts.length) * 100)}%`,
  );
  console.log('');
  console.log('   Both numbers matter equally. A rule tight enough to block every mistake also blocks every');
  console.log('   correct trade, and it produces no visible error while doing it — the bot simply stops acting.');
  console.log('   A suppression count read on its own cannot tell those two outcomes apart.');

  subsection('what "forbidden" actually costs — the rule DELAYS, it does not cancel');
  const delayed = forbidden.filter((v) => v.delayHours != null);
  const never = forbidden.length - delayed.length;
  const delays = delayed.map((v) => v.delayHours!).sort((a, b) => a - b);
  const improvements = forbidden
    .map((v) => v.delayImprovementPercent)
    .filter((v): v is number => v != null);
  const better = improvements.filter((v) => v > 0).length;
  console.log(
    `   of the ${forbidden.length} forbidden orders, ${delayed.length} become actionable later in the window ` +
      `and ${never} never do.`,
  );
  console.log(
    `   delay until actionable: median ${n1(quantile(delays, 0.5) ?? 0)}h  ·  p90 ${n1(quantile(delays, 0.9) ?? 0)}h  ` +
      `·  max ${n1(delays[delays.length - 1] ?? 0)}h  (one 4h bar is the floor)`,
  );
  const meanOf = (values: number[]): string =>
    values.length === 0 ? 'n/a' : `${n1(values.reduce((s, v) => s + v, 0) / values.length)}%`;
  const bySide = (side: 'buy' | 'sell'): number[] =>
    forbidden
      .filter((v) => v.booking.side === side)
      .map((v) => v.delayImprovementPercent)
      .filter((x): x is number => x != null);
  console.log(
    `   price move over that delay, signed in the order's favour (positive = sells higher / buys lower):`,
  );
  console.log(
    `     all ${meanOf(improvements)} mean, ${better}/${improvements.length} improved  ·  ` +
      `sells ${meanOf(bySide('sell'))}  ·  buys ${meanOf(bySide('buy'))}`,
  );
  console.log('');
  console.log('   Read this narrowly. It prices ONE counterfactual — the SAME order, issued a bar or two later —');
  console.log('   and it is an upper bound on the execution cost of the delay, nothing more. It is not the');
  console.log('   benefit of the rule, and it cannot be: the point of freezing the asset is that the model would');
  console.log('   next see a label and flags that agree, and might not issue the order at all. Only re-running');
  console.log('   the model could say, and this harness does not re-run the model.');

  subsection('every real order, judged');
  printOrderTable(verdicts);

  // The week the brief is about. Stated as an explicit half-open interval so the count
  // is reproducible: the 24 orders of "the 1-8 August week" are those strictly before
  // 8 August, and cycle 1163 (08/08 08:41) is the 25th, called out separately as C6.
  const fromMs = Date.parse('2026-08-01T00:00:00.000Z');
  const toMs = Date.parse('2026-08-08T00:00:00.000Z');
  const week = verdicts.filter((v) => v.cycle.generatedAtMs >= fromMs && v.cycle.generatedAtMs < toMs);
  const weekInclusive = verdicts.filter((v) => v.cycle.generatedAtMs >= fromMs);

  subsection('the 1-8 August window');
  console.log(`   [2026-08-01, 2026-08-08)          ${week.length} orders  ` +
    `(${count(week.filter((v) => !v.allowed), 'buy')} buy / ${count(week.filter((v) => !v.allowed), 'sell')} sell forbidden)`);
  console.log(`   [2026-08-01, end of window]       ${weekInclusive.length} orders — the extra one is cycle 1163`);
  const weekDiverging = week.filter((v) => v.diverging);
  const weekDivergingInclusive = weekInclusive.filter((v) => v.diverging);
  console.log(
    `   orders placed while raw ≠ shown:  ${weekDiverging.length} in the half-open week, ` +
      `${weekDivergingInclusive.length} including 1163  ` +
      `(${count(weekDivergingInclusive, 'sell')} sells, ${count(weekDivergingInclusive, 'buy')} buys)`,
  );
  const divergingForbidden = weekDivergingInclusive.filter((v) => !v.allowed).length;
  console.log(
    `   of those, forbidden by the rule:  ${divergingForbidden}/${weekDivergingInclusive.length}` +
      `${divergingForbidden === weekDivergingInclusive.length ? '  — all of them' : '  — NOT all of them'}`,
  );

  subsection('the reference cases');
  const c1163 = verdicts.filter((v) => v.cycle.id === 1163);
  const c1061 = verdicts.filter((v) => v.cycle.id === 1061);
  const sixSells = verdicts.filter(
    (v) => [1035, 1054, 1067].includes(v.cycle.id) && ['BTC', 'ETH'].includes(v.booking.asset),
  );
  console.log('   C6 — cycle 1163, BNB sold on a `range` label while raw was already trend_up:');
  printOrderTable(c1163);
  console.log('');
  console.log('   the six BTC/ETH sells of cycles 1035, 1054 and 1067:');
  printOrderTable(sixSells);
  console.log(`   → ${sixSells.filter((v) => !v.allowed).length}/6 forbidden`);
  console.log('');
  console.log('   cycle 1061 — the healthy buys, raw and shown in agreement, at the bottom of the 4h range:');
  printOrderTable(c1061);
  const kept = c1061.filter((v) => v.allowed).length;
  console.log(`   → ${kept}/${c1061.length} still allowed`);
  if (kept < c1061.length) {
    console.log('');
    console.log('   ⚠ THIS CONTRADICTS THE BRIEF, which states these are good decisions that must pass.');
    console.log('     They are not blocked by a raw/shown divergence — BTC and ETH agree on reversal_down at');
    console.log('     that bar. They are blocked by POINT 4: the raw label had left reversal_down and come');
    console.log('     back, and a reappearance shorter than three bars never reopens actionability. The trace');
    console.log('     below is the evidence; the two requirements are incompatible on this tape.');
    console.log('');
    for (const asset of ['BTC', 'ETH']) {
      printRawTrace(sticky, asset, c1061[0]?.cycle.generatedAtMs ?? 0, 8, 4);
      console.log('');
    }
  }
}

/**
 * The raw series around one cycle, bar by bar, so a verdict can be audited rather than
 * trusted. Printed for the cases the brief names, because a claim that a rule blocks a
 * specific order is only useful if the reader can see the counter that blocked it.
 */
function printRawTrace(
  sticky: Record<string, StickyPoint[]>,
  asset: string,
  centreMs: number,
  before: number,
  after: number,
): void {
  const timeline = sticky[asset] ?? [];
  const centre = timeline.findIndex((p) => p.timestamp + barMs > centreMs);
  const from = Math.max(0, (centre < 0 ? timeline.length : centre) - before);
  const to = Math.min(timeline.length, (centre < 0 ? timeline.length : centre) + after);
  console.log(`   ${asset} raw series around ${fmtBar(centreMs)}:`);
  for (let i = from; i < to; i += 1) {
    const p = timeline[i]!;
    const marker = i === centre - 1 ? '  ← the bar the cycle read' : '';
    console.log(
      `     ${fmtBar(p.timestamp)}  raw ${p.raw.padEnd(14)} active ${p.active.padEnd(14)} ` +
        `run ${String(p.runLength).padStart(2)}  ${p.frozen ? 'FROZEN' : 'actionable'}${marker}`,
    );
  }
}

/* ── Bloc C — calibrating the peak stop ───────────────────────────────────── */

function summarise(run: StopRun): {
  triggers: number;
  resolved: StopEpisode[];
  netTotal: Decimal;
  fees: Decimal;
  avoidedMean: number | null;
  rebound24Mean: number | null;
  rebound72Mean: number | null;
  hoursOutMax: number | null;
  hoursOutMean: number | null;
  exposureForgone: Decimal;
  realOrdersStranded: number;
} {
  const resolved = run.episodes.filter((e) => e.netEffect != null);
  const mean = (values: Array<number | null>): number | null => {
    const ok = values.filter((v): v is number => v != null);
    return ok.length === 0 ? null : ok.reduce((s, v) => s + v, 0) / ok.length;
  };
  return {
    triggers: run.episodes.length,
    resolved,
    netTotal: resolved.reduce((s, e) => s.plus(e.netEffect!), new Decimal(0)),
    fees: run.episodes.reduce((s, e) => s.plus(e.feesPaid), new Decimal(0)),
    avoidedMean: mean(run.episodes.map((e) => e.extraDrawdownAvoidedPercent)),
    rebound24Mean: mean(run.episodes.map((e) => e.rebound24hPercent)),
    rebound72Mean: mean(run.episodes.map((e) => e.rebound72hPercent)),
    hoursOutMax: run.episodes.reduce<number | null>(
      (m, e) => (e.hoursOut == null ? m : m == null || e.hoursOut > m ? e.hoursOut : m),
      null,
    ),
    hoursOutMean: mean(run.episodes.map((e) => e.hoursOut)),
    exposureForgone: run.episodes.reduce((s, e) => s.plus(e.exposureForgone), new Decimal(0)),
    realOrdersStranded: run.episodes.reduce((s, e) => s + e.realOrdersDuringOut, 0),
  };
}

/**
 * The raw calibration base: how far below its peak an asset actually went WHILE FROZEN.
 *
 * Printed before the episode results on purpose. The episode table answers "what would
 * this threshold have done", which is a question about dynamics — one exit resets a
 * peak and moves every later trigger. This answers the prior question, "what is there
 * to catch", and it is independent of any threshold, so it is the only part of bloc C
 * that cannot be argued into a different shape by the choice of parameter.
 */
function printDrawdownProfile(
  cycles: Cycle[],
  snapshots: Array<{ states: Map<string, { peakPriceSinceEntry: Decimal | null }> }>,
  sticky: Record<string, StickyPoint[]>,
  assets: string[],
): void {
  subsection('drawdown from the peak observed while FROZEN (the calibration base)');
  console.log(
    `   ${'asset'.padEnd(6)}${'frozen'.padStart(8)}${'worst'.padStart(9)}${'p99'.padStart(8)}${'p95'.padStart(8)}` +
      `${'p90'.padStart(8)}${'median'.padStart(9)}${'≤5%'.padStart(7)}${'≤8%'.padStart(7)}${'≤10%'.padStart(7)}${'≤12%'.padStart(7)}`,
  );

  for (const asset of assets) {
    const timeline = sticky[asset] ?? [];
    const drawdowns: number[] = [];
    for (let i = 0; i < cycles.length; i += 1) {
      const cycle = cycles[i]!;
      const view = cycle.assets.get(asset);
      if (view == null || view.qtyBefore.lte('1e-12') || view.price == null) continue;
      const state = stickyAt(timeline, cycle.generatedAtMs, barMs);
      if (state == null || !state.frozen) continue;
      const stored = i > 0 ? (snapshots[i - 1]!.states.get(asset)?.peakPriceSinceEntry ?? null) : null;
      const peak = stored == null ? view.price : Decimal.max(stored, view.price);
      if (peak.lte(0)) continue;
      drawdowns.push(view.price.minus(peak).div(peak).times(100).toNumber());
    }
    if (drawdowns.length === 0) {
      console.log(`   ${asset.padEnd(6)}${'0'.padStart(8)}   — no frozen asset-cycle with a price and a position`);
      continue;
    }
    // Sorted ascending: the WORST drawdown is the most negative, so it sits first and
    // the tail quantiles are read from the low end.
    const sorted = [...drawdowns].sort((a, b) => a - b);
    const at = (q: number): string => `${n1(quantile(sorted, q) ?? 0)}%`;
    const below = (t: number): number => sorted.filter((d) => d <= -t).length;
    console.log(
      `   ${asset.padEnd(6)}${String(sorted.length).padStart(8)}${`${n1(sorted[0]!)}%`.padStart(9)}` +
        `${at(0.01).padStart(8)}${at(0.05).padStart(8)}${at(0.1).padStart(8)}${at(0.5).padStart(9)}` +
        `${String(below(5)).padStart(7)}${String(below(8)).padStart(7)}${String(below(10)).padStart(7)}${String(below(12)).padStart(7)}`,
    );
  }
  console.log('');
  console.log('   "frozen" counts asset-cycles that were held, priced and non-actionable. The four right-hand');
  console.log('   columns are how many of them sat at or below each candidate threshold — i.e. how much of the');
  console.log('   frozen tape each stop would have been looking at, before any exit reshapes the peak.');
}

/** Nearest-rank median of a numeric sample. */
function median(values: number[]): number | null {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

function printBlocC(runs: StopRun[], finalEquity: Decimal, cycleCount: number): void {
  console.log('');
  console.log('   The stop is a SHADOW OVERLAY: each trigger is scored on the observed price path, and the');
  console.log('   real tape is never rewritten. Rewriting it would change every book the model was later shown,');
  console.log('   and only re-running the model could say what it would then have decided — which this harness');
  console.log('   refuses to do. The counterfactual therefore has no free parameter: sell the whole line at the');
  console.log('   trigger cycle\'s price, pay the fee, buy it back at the first cycle the asset is actionable');
  console.log('   again, pay the fee a second time. "Net" is the value of that line at the re-entry moment,');
  console.log('   stopped minus held.');
  console.log('');
  console.log(`   fee modelled: ${config.execution.feePercent}% per movement (config.execution.feePercent)`);

  subsection('the four thresholds, side by side');
  console.log(
    `   ${'thr'.padEnd(6)}${'exits'.padStart(6)}${'resolved'.padStart(10)}${'net'.padStart(11)}${'fees'.padStart(9)}` +
      `${'avoided'.padStart(10)}${'reb 24h'.padStart(9)}${'reb 72h'.padStart(9)}${'out max'.padStart(10)}${'out mean'.padStart(10)}${'stranded'.padStart(10)}`,
  );
  for (const run of runs) {
    const s = summarise(run);
    console.log(
      `   ${`${run.threshold}%`.padEnd(6)}${String(s.triggers).padStart(6)}${String(s.resolved.length).padStart(10)}` +
        `${usd(s.netTotal).padStart(11)}${`$${s.fees.toFixed(2)}`.padStart(9)}` +
        `${(s.avoidedMean == null ? 'n/a' : `${n1(s.avoidedMean)}%`).padStart(10)}` +
        `${(s.rebound24Mean == null ? 'n/a' : `${n1(s.rebound24Mean)}%`).padStart(9)}` +
        `${(s.rebound72Mean == null ? 'n/a' : `${n1(s.rebound72Mean)}%`).padStart(9)}` +
        `${(s.hoursOutMax == null ? 'n/a' : `${n1(s.hoursOutMax)}h`).padStart(10)}` +
        `${(s.hoursOutMean == null ? 'n/a' : `${n1(s.hoursOutMean)}h`).padStart(10)}` +
        `${String(s.realOrdersStranded).padStart(10)}`,
    );
  }
  console.log('');
  console.log('   avoided  = mean lowest traded price between exit and re-entry, as % of the exit price');
  console.log('              (more negative = more drawdown the stop stepped out of)');
  console.log('   reb 24h / 72h = mean price 24h / 72h after the exit, as % of the exit price');
  console.log('              (positive = a rebound the stop was not there for)');
  console.log('   net      = Σ (stopped value − held value) at each re-entry, fees included');
  console.log('   stranded = real orders that landed on a line while the shadow held it in cash — the size of');
  console.log('              the divergence between the two worlds, published rather than assumed');
  console.log(`   equity at the last cycle: $${finalEquity.toFixed(2)}  ·  ${cycleCount} cycles replayed`);

  // ── Robustness. The brief is explicit that the threshold to keep is the one that
  // improves the NET RESULT over the whole replay, not the one that best protects a
  // single episode — so the aggregate net is shown next to what survives removing the
  // best episode. A total carried by one lucky exit is not a calibration, it is an
  // anecdote with a percentage sign, and on this tape the concentration is severe.
  subsection('robustness — is the total carried by one episode?');
  console.log(
    `   ${'thr'.padEnd(6)}${'net'.padStart(10)}${'% equity'.padStart(10)}${'best ep.'.padStart(11)}` +
      `${'net w/o best'.padStart(14)}${'median ep.'.padStart(12)}${'win rate'.padStart(10)}`,
  );
  for (const run of runs) {
    const s = summarise(run);
    const nets = s.resolved.map((e) => e.netEffect!);
    const best = nets.reduce<Decimal | null>((m, v) => (m == null || v.gt(m) ? v : m), null);
    const withoutBest = best == null ? s.netTotal : s.netTotal.minus(best);
    const wins = nets.filter((v) => v.gt(0)).length;
    console.log(
      `   ${`${run.threshold}%`.padEnd(6)}${usd(s.netTotal).padStart(10)}` +
        `${`${n2(s.netTotal.div(finalEquity).times(100).toNumber())}%`.padStart(10)}` +
        `${(best == null ? 'n/a' : usd(best)).padStart(11)}${usd(withoutBest).padStart(14)}` +
        `${(nets.length === 0 ? 'n/a' : usd(dec(median(nets.map((v) => v.toNumber())) ?? 0))).padStart(12)}` +
        `${(nets.length === 0 ? 'n/a' : `${wins}/${nets.length}`).padStart(10)}`,
    );
  }

  for (const run of runs) {
    const s = summarise(run);
    subsection(`threshold ${run.threshold}% — every trigger`);
    if (run.episodes.length === 0) {
      console.log('   no trigger over the whole replay.');
    } else {
      console.log(
        `   ${'asset'.padEnd(6)}${'exit cycle'.padEnd(12)}${'when'.padEnd(18)}${'dd'.padStart(8)}` +
          `${'notional'.padStart(10)}${'out'.padStart(9)}${'avoided'.padStart(10)}${'reb24'.padStart(8)}${'reb72'.padStart(8)}${'net'.padStart(10)}`,
      );
      for (const e of run.episodes) {
        console.log(
          `   ${e.asset.padEnd(6)}${String(e.exitCycleId).padEnd(12)}${fmtBar(e.exitAtMs).padEnd(18)}` +
            `${`${n1(e.triggerDrawdownPercent)}%`.padStart(8)}${`$${e.notional.toFixed(2)}`.padStart(10)}` +
            `${(e.hoursOut == null ? '—' : `${n1(e.hoursOut)}h`).padStart(9)}` +
            `${(e.extraDrawdownAvoidedPercent == null ? '—' : `${n1(e.extraDrawdownAvoidedPercent)}%`).padStart(10)}` +
            `${(e.rebound24hPercent == null ? '—' : `${n1(e.rebound24hPercent)}%`).padStart(8)}` +
            `${(e.rebound72hPercent == null ? '—' : `${n1(e.rebound72hPercent)}%`).padStart(8)}` +
            `${(e.netEffect == null ? '—' : usd(e.netEffect)).padStart(10)}`,
        );
        if (e.unresolved != null) console.log(`          unresolved: ${e.unresolved}`);
      }
    }
    console.log(
      `   armed asset-cycles: ${run.armedAssetCycles}  ·  abstentions — no regime ${run.abstentions.noRegime}, ` +
        `no/stale price ${run.abstentions.noPrice}, no peak ${run.abstentions.noPeak}`,
    );
    console.log(
      `   exposure not carried while out: $${s.exposureForgone.toFixed(2)}·cycles  ` +
        `(≈ ${n2(s.exposureForgone.div(finalEquity.times(Math.max(cycleCount, 1))).times(100).toNumber())}% of equity·cycles)`,
    );
  }
}

/* ── Validations ──────────────────────────────────────────────────────────── */

function validateEquivalence(points: RegimePoint[], sticky: Record<string, StickyPoint[]>, assets: string[]): void {
  let compared = 0;
  const mismatches: string[] = [];
  for (const asset of assets) {
    const timeline = sticky[asset] ?? [];
    for (let i = 0; i < points.length; i += 1) {
      const production = points[i]!.assets[asset];
      const s = timeline[i];
      if (production == null || s == null) continue;
      compared += 1;
      if (production.regime !== s.active && mismatches.length < 5) {
        mismatches.push(`${asset} ${fmtBar(points[i]!.timestamp)}: production ${production.regime} vs sticky ${s.active}`);
      }
      if (production.raw !== s.raw && mismatches.length < 5) {
        mismatches.push(`${asset} ${fmtBar(points[i]!.timestamp)}: raw differs`);
      }
    }
  }
  validate('T0', 'the sticky rule GATES, it never relabels', mismatches.length === 0, [
    `${compared} asset-bars compared against production's Hysteresis, on the real tape`,
    mismatches.length === 0
      ? 'the confirmed regime is identical everywhere — the rule adds an actionability gate and nothing else'
      : `mismatches: ${mismatches.join(' | ')}`,
    'the same claim is proven exhaustively on synthetic series by src/test/stickyTransition.ts (59 049 walks)',
  ]);
}

function validateAgainstJournal(cycles: Cycle[], points: RegimePoint[]): void {
  const byBar = new Map(points.map((p) => [p.timestamp, p]));
  let compared = 0;
  let barResolutionChecked = 0;
  const mismatches: string[] = [];

  for (const cycle of cycles) {
    if (cycle.regime == null || cycle.regimeBarAtMs == null) continue;
    const point = byBar.get(cycle.regimeBarAtMs);
    if (point == null) continue;

    // The bar THIS harness resolves for the cycle must be the bar the cycle journaled.
    // Every figure in blocs B and C hangs off that resolution.
    const resolved = points.filter((p) => p.timestamp + barMs <= cycle.generatedAtMs).at(-1);
    if (resolved != null) {
      barResolutionChecked += 1;
      if (resolved.timestamp !== cycle.regimeBarAtMs && mismatches.length < 5) {
        mismatches.push(
          `#${cycle.id}: journaled bar ${fmtBar(cycle.regimeBarAtMs)} but resolved ${fmtBar(resolved.timestamp)}`,
        );
      }
    }

    for (const [asset, journal] of cycle.regime) {
      const replayed = point.assets[asset];
      if (replayed == null) continue;
      compared += 1;
      if (replayed.raw !== journal.raw && mismatches.length < 5) {
        mismatches.push(`#${cycle.id} ${asset} raw: journaled ${journal.raw} vs replayed ${replayed.raw}`);
      }
      if (replayed.regime !== journal.regime && mismatches.length < 5) {
        mismatches.push(`#${cycle.id} ${asset} stabilized: journaled ${journal.regime} vs replayed ${replayed.regime}`);
      }
    }
  }

  validate('T1', 'the replayed regime is the one the bot actually journaled', mismatches.length === 0 && compared > 0, [
    `${compared} asset-cycles compared against decisions.regime, ${barResolutionChecked} bar resolutions checked`,
    mismatches.length === 0
      ? 'raw and stabilized labels agree everywhere, and every cycle resolves to the bar it journaled'
      : `mismatches: ${mismatches.join(' | ')}`,
  ]);
}

function validatePeaks(cycles: Cycle[], snapshots: Array<{ states: Map<string, { peakPriceSinceEntry: Decimal | null }> }>): void {
  let peaks = 0;
  let drawdowns = 0;
  const mismatches: string[] = [];

  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i]!;
    const prior = i > 0 ? snapshots[i - 1]!.states : new Map<string, { peakPriceSinceEntry: Decimal | null }>();
    for (const [asset, view] of cycle.assets) {
      if (view.journaledPeak == null) continue;
      const stored = prior.get(asset)?.peakPriceSinceEntry ?? null;
      const price = view.price;
      // Mirrors toDecisionContext: the view shows the peak the lifecycle is ABOUT to
      // write, i.e. last cycle's stored value ratcheted by this cycle's live price.
      const expected = stored == null ? price : price == null ? stored : Decimal.max(stored, price);
      peaks += 1;
      if (expected == null || !expected.toDecimalPlaces(2).minus(view.journaledPeak).abs().lte('0.005')) {
        if (mismatches.length < 5) {
          mismatches.push(`#${cycle.id} ${asset} peak: journaled ${view.journaledPeak} vs replayed ${expected?.toString() ?? 'null'}`);
        }
        continue;
      }
      if (view.journaledDrawdownPercent != null && price != null && expected.gt(0)) {
        drawdowns += 1;
        const dd = price.minus(expected).div(expected).times(100).toDecimalPlaces(2);
        if (!dd.minus(view.journaledDrawdownPercent).abs().lte('0.02') && mismatches.length < 5) {
          mismatches.push(`#${cycle.id} ${asset} drawdown: journaled ${view.journaledDrawdownPercent} vs replayed ${dd}`);
        }
      }
    }
  }

  validate('T2', 'the replayed peak is the peak the bot actually held', mismatches.length === 0 && peaks > 0, [
    `${peaks} journaled peaks and ${drawdowns} journaled drawdowns compared, from the v5 lifecycle views`,
    mismatches.length === 0
      ? 'every one matches — the stop in bloc C reads the same number the model was shown'
      : `mismatches: ${mismatches.join(' | ')}`,
    'position_state keeps no history (it is overwritten in place), so the peak is replayed through the',
    'unchanged production function and reconciled against the only journaled record of it that exists.',
  ]);
}

function validateWarmUp(
  sticky: Record<string, StickyPoint[]>,
  assets: string[],
  warmUpBars: number,
  postWindowBars: number,
): void {
  // The opening bars of ANY series are frozen by construction (a run of 1 is not a run
  // of 3). If that artefact reached the measured window it would inflate the freeze rate
  // for free. It cannot: the timeline is walked from ~60 days before the window opens.
  const firstThaw = assets.map((asset) => (sticky[asset] ?? []).findIndex((p) => p.actionable));
  const worst = Math.max(...firstThaw);
  const gaps = assets.map((a) => gridGaps(sticky[a] ?? [], barMs));
  validate('T3', 'no warm-up artefact reaches the measured window', worst >= 0 && worst < warmUpBars, [
    `bars replayed before the observation window opens: ${warmUpBars}`,
    `bars that closed AFTER the last decision (excluded from the analysed views): ${postWindowBars}`,
    // A hole in the grid is not an error — `regimeTimeline` intersects the assets' 4h
    // timestamps, so one missing candle removes the bar for everyone. It IS something the
    // reader has to know, because the sticky run restarts across it: a freeze spanning a
    // hole is shorter in observations than in hours, and bloc A reports the hours.
    `holes in the 4h grid, per asset: ${assets.map((a, i) => `${a} ${gaps[i]}`).join(', ')} ` +
      `(a hole restarts the confirmation run; durations are measured in elapsed time)`,
    `first actionable bar per asset: ${assets.map((a, i) => `${a} @${firstThaw[i]}`).join(', ')}`,
    `worst = bar ${worst}, i.e. ${worst < warmUpBars ? 'well inside' : 'OUTSIDE'} the warm-up`,
  ]);
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main(): Promise<number> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    throw new Error(
      'transition replay: Supabase is not configured — the harness reads (read-only) the decisions and ' +
        'executions journals. Set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  const window = await loadObservationWindow();
  console.log('═'.repeat(100));
  console.log('TRANSITION CONTRACT — measurement of the sticky-transition rule and the peak stop');
  console.log('═'.repeat(100));
  console.log(
    `Observation window: ${fmtBar(window.fromMs)} → ${fmtBar(window.toMs)}  (${window.days} days, ${window.decisions} decisions)`,
  );
  console.log(
    `Regime: ${config.regime.timeframe} bars, confirmations=${confirmations} ` +
      `(${confirmations * (barMs / HOUR_MS)}h of agreement before a flip)`,
  );
  console.log(`Stop thresholds under test: ${PEAK_STOP_THRESHOLDS.map((t) => `${t}%`).join(', ')}`);
  console.log('Supabase access: READ-ONLY. No production code path is modified by this harness.');

  // Candles: the same public mainnet series every other replay uses, with enough
  // history before the window for the indicators AND the sticky walk to converge.
  const client = publicMainnetClient();
  const DAY_MS = 24 * HOUR_MS;
  const dailyFrom = window.fromMs - 260 * DAY_MS;
  const h4From = window.fromMs - 60 * DAY_MS;
  const universe: Record<string, { daily: Candle[]; h4: Candle[] }> = {};
  // A SEPARATE 1h series, used only to measure the price path around a stop episode.
  // Episode boundaries are cycle timestamps and never land on bar boundaries, so a bar
  // straddling the exit or the re-entry cannot be counted (its low may have printed
  // outside the episode) — at 4h that discards up to eight hours of an episode that may
  // itself be eleven hours long. At 1h the unresolvable residue is an hour at each end.
  // The REGIME stays on 4h: that is what production computes, and it does not move.
  const priceSeries: Record<string, Candle[]> = {};
  const priceBarMs = timeframeMs('1h');
  for (const symbol of [...config.tradablePairs, ...config.referencePairs]) {
    const base = symbol.split('/')[0];
    if (!base) continue;
    const [daily, h4, h1] = await Promise.all([
      fetchCandlesSince(client, symbol, config.primaryTimeframe, dailyFrom),
      fetchCandlesSince(client, symbol, config.regime.timeframe, h4From),
      fetchCandlesSince(client, symbol, '1h', window.fromMs - DAY_MS),
    ]);
    universe[base] = { daily, h4 };
    priceSeries[base] = h1;
    console.log(
      `[replay] ${symbol}: ${daily.length} × ${config.primaryTimeframe}, ` +
        `${h4.length} × ${config.regime.timeframe}, ${h1.length} × 1h (price path)`,
    );
  }

  const fullTimeline = regimeTimeline(universe, config.regime.thresholds, replayRegimeOptions());
  const points = withinWindow(fullTimeline, window, barMs);
  if (points.length === 0) throw new Error('transition replay: no 4h bar inside the observation window.');

  // The warm-up prefix is what blocs B and C need at the LEFT edge: a cycle is matched to
  // the last bar that CLOSED before it, and the earliest cycles sit before the window's
  // first closed bar. On a window-only view they resolve to nothing and are scored "no
  // regime" — which is how the four opening buys of cycle 85 were briefly, and wrongly,
  // counted as orders the rule could not judge.
  //
  // THREE views of the sticky walk, and the distinctions are load-bearing.
  //
  //  - `stickyWalk` is the whole walk, warm-up included. Only the validations read it.
  //  - `stickyAnalysed` is that walk CAPPED at `window.toMs` but keeping the warm-up
  //    prefix. This is what blocs A, B and C read. The cap matters as much as the
  //    prefix: `fullTimeline` extends past the last decision whenever a newer 4h candle
  //    has closed since — the normal case for any run of this harness after the fact —
  //    and letting those bars through would resolve, with the future, freezes that were
  //    still open at the window's end and thaw orders that never became actionable
  //    inside it. The advertised fixed-window statistics would silently be revised by
  //    observations the bot never had.
  //  - `stickyInWindow` drops the warm-up too, and is used ONLY for the freeze RATE,
  //    which is a property of the observation window and must be counted on its bars.
  //
  // Durations, by contrast, are read off `stickyAnalysed`, so a freeze already running
  // when the window opened is measured whole instead of being truncated at the boundary.
  //
  // The window predicate is applied BY TIMESTAMP, never by counting bars off the front:
  // `fullTimeline.length - points.length` counts pre-window AND post-window bars as
  // warm-up, so slicing that many off would shift the whole window forward.
  const stickyWalk = stickyTimelines(fullTimeline, confirmations, barMs);
  const warmUpBars = fullTimeline.findIndex((p) => p.timestamp + barMs >= window.fromMs);
  const inWindow = new Set(points.map((p) => p.timestamp));
  const stickyAnalysed: Record<string, StickyPoint[]> = {};
  const stickyInWindow: Record<string, StickyPoint[]> = {};
  for (const [asset, timeline] of Object.entries(stickyWalk)) {
    stickyAnalysed[asset] = timeline.filter((p) => p.timestamp + barMs <= window.toMs);
    stickyInWindow[asset] = timeline.filter((p) => inWindow.has(p.timestamp));
  }

  const tradable = tradableBaseAssets(config).filter((a) => stickyAnalysed[a] != null);
  const allAssets = Object.keys(stickyAnalysed);

  // Bounded to the window captured above — the bot is live and keeps committing rows.
  const { cycles, bookings, skippedNoBook, arrivedDuringTheRun } = await loadCycleStream(
    supabase,
    window.toMs,
  );
  const { snapshots } = replayPeaks(cycles);
  console.log(
    `[replay] ${cycles.length} cycles, ${bookings.length} sovereign bookings, ` +
      `${skippedNoBook} row(s) without a valued book (excluded), ` +
      `${arrivedDuringTheRun} row(s) committed by the live bot after the window was captured (excluded).`,
  );

  section('VALIDATIONS — what has to be true before any number below means anything');
  validateEquivalence(points, stickyInWindow, allAssets);
  validateAgainstJournal(cycles, points);
  validatePeaks(cycles, snapshots);
  validateWarmUp(stickyWalk, allAssets, warmUpBars, fullTimeline.length - warmUpBars - points.length);

  printBlocA(blocA(stickyInWindow, stickyAnalysed, allAssets, window));
  printBlocB(blocB(cycles, stickyAnalysed, priceSeries, priceBarMs), stickyAnalysed);
  const runs = PEAK_STOP_THRESHOLDS.map((threshold) =>
    runPeakStop({
      threshold,
      cycles,
      snapshots,
      sticky: stickyAnalysed,
      series: priceSeries,
      assets: tradable,
      barMs,
      priceBarMs,
    }),
  );
  section('BLOC C — calibrating the peak stop');
  printDrawdownProfile(cycles, snapshots, stickyAnalysed, tradable);
  printBlocC(runs, cycles[cycles.length - 1]?.equity ?? dec(0), cycles.length);

  const failed = validations.filter((v) => !v.passed);
  console.log('');
  console.log('═'.repeat(100));
  console.log(
    `${validations.length - failed.length}/${validations.length} validations passed` +
      (failed.length > 0 ? ` — FAILED: ${failed.map((f) => f.id).join(', ')}` : ' — the measurement rests on verified ground.'),
  );
  console.log('═'.repeat(100));
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('Transition contract replay failed:');
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
