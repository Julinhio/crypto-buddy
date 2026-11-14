import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeExitRule } from '../bench/exit/rules.js';
import { runWindow } from '../bench/exposure/engine.js';
import { T100 } from '../bench/exposure/policy.js';
import { loadStudyData } from '../bench/start/data.js';
import { tablesMarkdown } from '../bench/start/report.js';
import { checkFidelity, gridOf, measureStart, PILOT_START_MS, statsOf, WEEKLY_STEP_DAYS, type StartRow, type Summary } from '../bench/start/run.js';
import {
  aboveMeanAt,
  continuousSeedAt,
  distribution,
  firstCloseOf,
  holdSeries,
  ORIGIN_MS,
  quantile,
  readHorizon,
  runContinuous,
  runStart,
  seriesOf,
  type Series,
} from '../bench/start/study.js';
import { seedOf, type SeedLines } from '../bench/start/variants.js';

/**
 * THE START-CONDITIONS STUDY — what makes its numbers S4's and not a lookalike's.
 *
 *   1. the harness IS the bench: the seeded rule, seeded like the bench, gives the bench's S4 run
 *      on every bar; it reproduces the published sealed capital; and its B start at the pilot's
 *      instant holds the very lines production was seeded with on 06/11/2026;
 *   2. each variant starts as it is defined (A native, B on the continuous state, B' with its
 *      highs cleared, C1 on the 50-day mean at once, C2 after 10 days);
 *   3. the measures read what they say;
 *   4. the committed results are the ones this code produces on the committed candles.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}
const DAY = 86_400_000;
const H4 = 4 * 3_600_000;
const at = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

const data = loadStudyData();
const continuous = runContinuous(data);
const assets = data.cfg.assets;
const lineKey = (lines: Readonly<SeedLines>): string => JSON.stringify(assets.map((a) => [a, lines[a]!.status, lines[a]!.high, lines[a]!.exitAtMs, lines[a]!.armed]));

console.log('Proof 1 — the harness is the bench:');
{
  const f = checkFidelity(data, continuous);
  ok('the seeded rule, seeded like the bench, gives the bench\'s own S4 run on every 4h bar since 2020-10-01', f.seededEqualsNative);
  ok('the continuous trajectory reproduces S4\'s published sealed capital, 1 101,50 $', f.sealedCapital === 1101.5);
  ok('a B start at the pilot\'s instant holds the lines production was seeded with (out/s4/reconstruction.json)', f.pilotSeedEqualsProduction === true);
  ok('trajectories started later end up holding the 2020 trajectory\'s lines — B does not depend on its origin for ever', f.originConvergence.length >= 6 && f.originConvergence.every((c) => c.convergedAt != null));

  // A from an arbitrary date is the bench started on that date.
  const start = at('2023-05-18');
  const native = runWindow({ tape: data.tape, cfg: data.cfg, policy: T100, window: { name: 'exit-continuous', fromMs: start, toMs: start + 200 * DAY }, exitRule: makeExitRule('S4', data.table), unsafeSyntheticWindow: true });
  ok('variant A from a date is the bench\'s native start on that date, bar for bar', JSON.stringify(runStart(data, 'A', start, start + 200 * DAY, continuous).run.bars) === JSON.stringify(native.bars));
}

console.log('Proof 2 — each variant starts as defined:');
{
  // B walks exactly as the continuous trajectory does, whatever the date.
  for (const iso of ['2022-03-03', '2024-10-10', '2026-02-05']) {
    const start = at(iso);
    const { rule, run } = runStart(data, 'B', start, start + 150 * DAY, continuous);
    const lastClose = firstCloseOf(run.bars.at(-1)!.t, data.tape.barMs);
    ok(`B from ${iso}: 150 days later its lines are the continuous trajectory's (state, high, exit, armed)`, lineKey(rule.lines) === lineKey(continuous.linesAfter.get(lastClose)!));
  }

  // The pilot's date has both kinds of line: three in the market, XRP out.
  const seed = continuousSeedAt(continuous, PILOT_START_MS, data.tape.barMs)!;
  const first = firstCloseOf(PILOT_START_MS, data.tape.barMs);
  const b = seedOf('B', assets, first, seed);
  const bp = seedOf('Bp', assets, first, seed);
  const inLines = assets.filter((a) => seed[a]!.status === 'in');
  const outLines = assets.filter((a) => seed[a]!.status === 'out');
  ok('at the pilot\'s start the continuous trajectory holds lines in AND out of the market', inLines.length > 0 && outLines.length > 0);
  ok('B inherits the entry and the high of every line in the market', inLines.every((a) => b.lines[a]!.high === seed[a]!.high && b.lines[a]!.high != null && b.inherit.includes(a)));
  ok('B\' keeps the same in/out states but clears the entry and the high of a line in — production\'s code from cash', inLines.every((a) => bp.lines[a]!.status === 'in' && bp.lines[a]!.high == null && bp.lines[a]!.entryAtMs == null) && bp.inherit.length === 0);
  ok('B and B\' both keep a line out as it is: its exit date and its arming', outLines.every((a) => JSON.stringify(b.lines[a]) === JSON.stringify(seed[a]) && JSON.stringify(bp.lines[a]) === JSON.stringify(seed[a])));

  // C1: the 50-day mean decides the very first entry. C2: nothing before 10 days.
  for (const iso of ['2021-06-10', '2023-01-12', '2025-03-06']) {
    const start = at(iso);
    const row = data.table.rows[data.table.rowByClose.get(firstCloseOf(start, data.tape.barMs))!]!;
    const c1 = runStart(data, 'C1', start, start + H4, continuous).rule;
    ok(`C1 from ${iso}: after its first close, a line is in exactly when it closes above its 50-day mean (${aboveMeanAt(data, start)} of 4)`,
      assets.every((a) => (c1.lines[a]!.status === 'in') === (row.close[a]! > row.sma50[a]!)));
    const c2 = runStart(data, 'C2', start, start + 30 * DAY, continuous).run;
    ok(`C2 from ${iso}: no exposure at all during its first 10 days`, c2.bars.filter((bar) => bar.t < start + 10 * DAY).every((bar) => bar.exposurePercent === 0));
  }
  const c1Seed = seedOf('C1', assets, at('2023-01-12'), null);
  const c2Seed = seedOf('C2', assets, at('2023-01-12'), null);
  ok('C1 and C2 differ by the exit date alone: 10 days before the first close, or at it', assets.every((a) => c1Seed.lines[a]!.armed && c2Seed.lines[a]!.armed && c2Seed.lines[a]!.exitAtMs! - c1Seed.lines[a]!.exitAtMs! === 10 * DAY));

  // At the trajectory's own origin there is no continuous state yet: B is A.
  ok('at the origin B and B\' are A, by construction', JSON.stringify(runStart(data, 'B', ORIGIN_MS, ORIGIN_MS + 60 * DAY, continuous).run.bars) === JSON.stringify(runStart(data, 'A', ORIGIN_MS, ORIGIN_MS + 60 * DAY, continuous).run.bars));
}

console.log('Proof 3 — the measures:');
{
  const series: Series = { t: [0, H4, 2 * H4, 3 * H4, 4 * H4, 5 * H4], equity: [1000, 1100, 880, 990, 1210, 1200], exposurePercent: [0, 100, 100, 50, 50, 0] };
  const r = readHorizon(series, 0, 'end', 6 * H4, 1000)!;
  ok('return is read on the last 4h close of the horizon', Math.abs(r.returnPercent - 20) < 1e-9);
  ok('the worst fall is measured from the highest equity since the start (1 100 → 880 = 20 %)', Math.abs(r.maxDrawdownPercent - 20) < 1e-9);
  ok('time in market is the mean exposure over the horizon', Math.abs(r.timeInMarketPercent - 50) < 1e-9);
  ok('a horizon the data do not reach has no reading — never a shorter one under the same name', readHorizon(series, 0, '91', 6 * H4, 1000) == null);
  ok('quantiles interpolate', quantile([0, 10, 20, 30], 0.5) === 15 && quantile([5], 0.9) === 5);
  const d = distribution([{ value: 3, at: 'a' }, { value: -7, at: 'b' }, { value: 10, at: 'c' }])!;
  ok('a distribution names the start of its worst and best case', d.min === -7 && d.minAt === 'b' && d.max === 10 && d.maxAt === 'c' && d.median === 3 && d.mean === 2);

  const start = at('2024-02-01');
  const hold = holdSeries(data, start, start + 120 * DAY);
  ok('the kept basket starts in cash, is bought once at the next open, and is never touched again', hold.equity[0] === 1000 && hold.exposurePercent[0] === 0 && hold.exposurePercent.slice(1).every((e) => e > 99.5));
  ok('and its purchase costs the bench\'s fee and slippage (0,15 % of what is bought)', (() => {
    const bar = (a: string, t: number) => data.tape.tapes[a]!.h4[data.tape.tapes[a]!.indexByTs.get(t)!]!;
    const t1 = hold.t[1]!;
    const noCost = assets.reduce((s, a) => s + 1000 * (data.cfg.basket[a]! / 100) * (bar(a, t1).close / bar(a, t1).open), 0);
    const cost = (noCost - hold.equity[1]!) / 1000 * 100;
    return cost > 0.12 && cost < 0.18;
  })());
  ok('the first bar of every variant is the untouched 1 000 $', ['A', 'B', 'Bp', 'C1', 'C2'].every((v) => seriesOf(runStart(data, v as 'A', start, start + DAY, continuous).run).equity[0] === 1000));
}

console.log('Proof 4 — the committed results are this code\'s, on the committed candles:');
{
  const summary = JSON.parse(readFileSync(path.join(process.cwd(), 'out/bench-start/summary.json'), 'utf8')) as Summary;
  const weekly = JSON.parse(readFileSync(path.join(process.cwd(), 'out/bench-start/weekly.json'), 'utf8')) as StartRow[];
  const tasks = gridOf(data);
  ok('the summary was computed on the candles in the repository (same end of data)', summary.asOf === new Date(data.asOfMs).toISOString());
  ok('the weekly grid is one start every 7 days from 2020-10-01, the daily one every day with 12 months ahead',
    WEEKLY_STEP_DAYS === 7 &&
    summary.grids.weekly.starts === tasks.filter((t) => t.grid === 'weekly').length &&
    summary.grids.daily.starts === tasks.filter((t) => t.grid === 'daily').length &&
    summary.grids.weekly.from === '2020-10-01');
  ok('the summary carries the fidelity checks it ran on, all passing', summary.fidelity.seededEqualsNative && summary.fidelity.sealedCapital === 1101.5 && summary.fidelity.pilotSeedEqualsProduction === true);
  // Three starts recomputed now, compared with what is committed — every variant, every horizon.
  const rows = weekly.filter((r) => r.grid === 'weekly');
  for (const i of [5, Math.floor(rows.length / 2), rows.length - 60]) {
    const stored = rows[i]!;
    const again = measureStart(data, continuous, { grid: 'weekly', startMs: Date.parse(stored.start) });
    ok(`the start of ${stored.start.slice(0, 10)} recomputed is the committed row, to the last digit`, JSON.stringify(again) === JSON.stringify(stored));
  }
  ok('and the committed 12-month statistics are those of the committed rows', JSON.stringify(statsOf(rows, '365')) === JSON.stringify(summary.weekly['365']));
  ok('the committed tables are the ones the summary generates — no figure typed by hand',
    readFileSync(path.join(process.cwd(), 'out/bench-start/tables.md'), 'utf8') === tablesMarkdown(summary));
  const pilot = weekly.find((r) => r.grid === 'pilot');
  ok('the pilot\'s own start (06/11/2026 08:00 UTC, filled at 12:00) is measured', pilot != null && summary.pilot != null && summary.pilot.start === new Date(PILOT_START_MS).toISOString());
}

console.log(`\n${passed} start-conditions checks passed.`);
