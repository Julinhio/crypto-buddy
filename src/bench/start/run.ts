import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeExitRule } from '../exit/rules.js';
import { sliceRun } from '../exit/sealed.js';
import { runWindow } from '../exposure/engine.js';
import { T100 } from '../exposure/policy.js';
import { EXIT_SEALED } from '../exposure/windows.js';
import { loadStudyData, refreshLive, type StudyData } from './data.js';
import { writeReportAssets, type PilotSeries } from './report.js';
import {
  aboveMeanAt,
  continuousSeedAt,
  distribution,
  firstCloseOf,
  HORIZON_KEYS,
  holdSeries,
  ORIGIN_MS,
  readAll,
  runContinuous,
  runStart,
  seriesOf,
  type ContinuousTrajectory,
  type Distribution,
  type HorizonKey,
  type Readings,
  type Series,
} from './study.js';
import { START_VARIANTS, type SeedLines, type StartVariant } from './variants.js';

/**
 * THE START-CONDITIONS STUDY OF S4 — `npm run bench:start`.
 *
 * Does S4's result depend on the day it is started, and on how? Five ways of starting it
 * (`variants.ts`), from one start a week between 2020-10-01 and the end of the data, each measured
 * at 3, 6 and 12 months and to the end of the data, beside the basket kept without doing anything.
 * A second, daily grid re-reads the 12-month horizon to check that the weekly one hides no worse
 * case between two of its dates.
 *
 * OFFLINE AND DESCRIPTIVE. It reads the candles committed in the repository and writes files
 * under `out/bench-start/` and `docs/img/demarrage-s4/`. No database, no production state, no
 * order. Every candle here has already been seen by S4's development or validation: nothing this
 * prints is a new validation, and no parameter is searched.
 *
 *   npm run bench:start                    the whole study, on the committed candles
 *   npm run bench:start -- --jobs 4        number of parallel processes (default: the cores, 8 at most)
 *   npm run bench:start -- --report-only   redraw the charts and tables from the committed results
 *   npm run bench:start -- --refresh       first re-download the public candles since 2026-05-20
 *                                          up to the last closed 4h bar (the only network access)
 */

const DAY_MS = 86_400_000;
const H4_MS = 4 * 3_600_000;
const OUT_DIR = path.join('out', 'bench-start');
const SHARD_DIR = path.join(OUT_DIR, '.shards');

/** One start a week: see `gridOf`. */
export const WEEKLY_STEP_DAYS = 7;
/** The instant production's S4 pilot really started from: its orders filled at 12:15 UTC on 06/11/2026. */
export const PILOT_START_MS = Date.parse('2026-11-06T08:00:00Z');
/**
 * What production's pilot really did from that start, read on 14/11/2026 (PR #54): 1 034,45 $ at
 * its first trading cycle, 961,00 $ once BTC and BNB were sold. Constants of record, not inputs.
 */
export const PILOT_OBSERVED = Object.freeze({ startEquityUsd: 1034.45, equityUsd: 961.0, returnPercent: -7.1, readAt: '2026-11-14T04:05:00Z' });

export type Grid = 'weekly' | 'daily' | 'pilot';
export type Column = StartVariant | 'hold';
export const COLUMNS: readonly Column[] = Object.freeze([...START_VARIANTS, 'hold']);

export interface StartRow {
  grid: Grid;
  start: string;
  /** Assets closing above their 50-day mean at the start (0 to 4). */
  aboveMean: number;
  /** Lines the continuous trajectory holds in the market at the start (0 to 4). */
  continuousIn: number;
  /** Lines the transition gate does not let trade on the start bar (0 to 4): their first buy waits. */
  gatedAtStart: number;
  readings: Record<Column, Readings>;
  /** Weekly grid: the continuous trajectory itself from that date, rebased — B's cross-check. */
  slice: Readings | null;
}

interface Task { grid: Grid; startMs: number }

/**
 * THE GRIDS. Weekly: one start every 7 days from the trajectory's origin, every start run to the
 * end of the data. The horizons are 13 to 52 weeks long, so two starts a week apart share nearly
 * all of their path: a finer step multiplies the cost and barely adds information — except for the
 * WORST case, which can sit between two weekly dates. That is what the daily grid is for: every
 * day, 12-month horizon only.
 */
export function gridOf(data: StudyData): Task[] {
  const tasks: Task[] = [];
  const last = data.asOfMs - DAY_MS; // a start needs at least the bar it decides on and the one it fills on
  for (let t = ORIGIN_MS; t <= last; t += WEEKLY_STEP_DAYS * DAY_MS) tasks.push({ grid: 'weekly', startMs: t });
  for (let t = ORIGIN_MS; t + 365 * DAY_MS <= data.asOfMs; t += DAY_MS) tasks.push({ grid: 'daily', startMs: t });
  if (PILOT_START_MS + 2 * H4_MS <= data.asOfMs) tasks.push({ grid: 'pilot', startMs: PILOT_START_MS });
  return tasks;
}

/** The gate depends on the market alone, so the continuous run's bar at the start instant carries it. */
function gatedAt(continuous: ContinuousTrajectory, startMs: number): number {
  const bar = continuous.run.bars.find((b) => b.t === startMs);
  if (!bar) throw new Error(`start study: no bar at ${new Date(startMs).toISOString()}`);
  return Object.values(bar.gates).filter((g) => g !== 'actionable').length;
}

function sliceSeries(continuous: ContinuousTrajectory, startMs: number, startingCash: number): Series | null {
  const bars = continuous.run.bars;
  const first = bars.findIndex((b) => b.t >= startMs);
  if (first <= 0) return null;
  const k = startingCash / bars[first - 1]!.equity;
  const tail = bars.slice(first);
  return { t: tail.map((b) => b.t), equity: tail.map((b) => b.equity * k), exposurePercent: tail.map((b) => b.exposurePercent) };
}

export function measureStart(data: StudyData, continuous: ContinuousTrajectory, task: Task): StartRow {
  const { grid, startMs } = task;
  const toMs = grid === 'daily' ? startMs + 365 * DAY_MS : data.asOfMs;
  const keys: readonly HorizonKey[] = grid === 'daily' ? ['365'] : HORIZON_KEYS;
  const cash = data.cfg.startingCashUsd;
  const readings = {} as Record<Column, Readings>;
  for (const variant of START_VARIANTS) {
    readings[variant] = readAll(seriesOf(runStart(data, variant, startMs, toMs, continuous).run), startMs, data.asOfMs, cash, keys);
  }
  readings.hold = readAll(holdSeries(data, startMs, toMs), startMs, data.asOfMs, cash, keys);
  const slice = grid === 'daily' ? null : sliceSeries(continuous, startMs, cash);
  const seed = continuousSeedAt(continuous, startMs, data.tape.barMs);
  return {
    grid,
    start: new Date(startMs).toISOString(),
    aboveMean: aboveMeanAt(data, startMs),
    continuousIn: seed ? data.cfg.assets.filter((a) => seed[a]!.status === 'in').length : data.cfg.assets.length,
    gatedAtStart: gatedAt(continuous, startMs),
    readings,
    slice: slice ? readAll(slice, startMs, data.asOfMs, cash, keys) : null,
  };
}

// ── fidelity ─────────────────────────────────────────────────────────────────────────────

const lineKey = (lines: Readonly<SeedLines>, assets: readonly string[]): string =>
  JSON.stringify(assets.map((a) => [a, lines[a]!.status, lines[a]!.high, lines[a]!.exitAtMs, lines[a]!.armed]));

export interface Fidelity {
  /** The seeded rule, seeded like the bench, gives the bench's own S4 run — every bar. */
  seededEqualsNative: boolean;
  /** S4's published sealed capital, reproduced on the continuous trajectory. */
  sealedCapital: number;
  /** A B start at the pilot's instant holds the lines production was seeded with on 06/11. */
  pilotSeedEqualsProduction: boolean | null;
  /** When a trajectory started later holds, for good, the lines of the one started in 2020. */
  originConvergence: Array<{ origin: string; convergedAt: string | null; monthsAfterOrigin: number | null }>;
}

const LATER_ORIGINS = ['2021-01-01', '2021-07-01', '2022-01-01', '2022-07-01', '2023-01-01', '2024-01-01', '2025-01-01', '2026-01-01'];

export function checkFidelity(data: StudyData, continuous: ContinuousTrajectory, rootDir = process.cwd()): Fidelity {
  const native = runWindow({ tape: data.tape, cfg: data.cfg, policy: T100, window: { name: 'exit-continuous', fromMs: ORIGIN_MS, toMs: data.asOfMs }, exitRule: makeExitRule('S4', data.table), unsafeSyntheticWindow: true });
  const seededEqualsNative = JSON.stringify(native.bars) === JSON.stringify(continuous.run.bars);
  const sealedBars = { ...continuous.run, bars: continuous.run.bars.filter((b) => b.t < data.sealedEndMs) };
  const sealedCapital = Math.round(sliceRun(sealedBars, EXIT_SEALED, 1000).bars.at(-1)!.equity * 100) / 100;

  let pilotSeedEqualsProduction: boolean | null = null;
  if (PILOT_START_MS + 2 * H4_MS <= data.asOfMs) {
    const recon = JSON.parse(readFileSync(path.resolve(rootDir, 'out', 's4', 'reconstruction.json'), 'utf8')) as { lines: Array<{ asset: string; status: 'in' | 'out'; entryAtMs: number | null; high: number | null; exitAtMs: number | null; armed: boolean }> };
    // One bar is enough: the start reads the close of 06/11 00:00 on it, as the reconstruction had.
    const { rule } = runStart(data, 'B', PILOT_START_MS, PILOT_START_MS + H4_MS, continuous);
    pilotSeedEqualsProduction = recon.lines.every((l) => {
      const mine = rule.lines[l.asset]!;
      return mine.status === l.status && mine.high === l.high && mine.exitAtMs === l.exitAtMs && mine.armed === l.armed && (l.status === 'out' || mine.entryAtMs === l.entryAtMs);
    });
  }

  const reference = continuous.linesAfter;
  const closes = [...reference.keys()].sort((a, b) => a - b);
  const originConvergence = LATER_ORIGINS.filter((o) => Date.parse(`${o}T00:00:00Z`) + 30 * DAY_MS < data.asOfMs).map((origin) => {
    const originMs = Date.parse(`${origin}T00:00:00Z`);
    const later = runContinuous(data, originMs).linesAfter;
    let convergedAt: number | null = null;
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      const c = closes[i]!;
      const mine = later.get(c);
      if (!mine || lineKey(mine, data.cfg.assets) !== lineKey(reference.get(c)!, data.cfg.assets)) break;
      convergedAt = c;
    }
    return {
      origin,
      convergedAt: convergedAt == null ? null : new Date(convergedAt).toISOString().slice(0, 10),
      monthsAfterOrigin: convergedAt == null ? null : Math.round(((convergedAt - originMs) / DAY_MS / 30.44) * 10) / 10,
    };
  });
  return { seededEqualsNative, sealedCapital, pilotSeedEqualsProduction, originConvergence };
}

// ── aggregation ──────────────────────────────────────────────────────────────────────────

export interface ColumnStats {
  return: Distribution;
  maxDrawdown: Distribution;
  timeInMarketMean: number;
}

export interface GapStats extends Distribution {
  /** Share of the starts where the variant ends above the reference, in percent. */
  winsPercent: number;
  /** Share where the two end within 0,05 point of each other — the same result. */
  tiesPercent: number;
  lossesPercent: number;
}

/** Under this gap, in points of return, two starts are read as having done the same. */
export const TIE_POINTS = 0.05;

export interface HorizonStats {
  starts: number;
  columns: Partial<Record<Column, ColumnStats>>;
  /** `gaps[reference][variant]`: the variant's return minus the reference's, same start. */
  gaps: Record<string, Partial<Record<Column, GapStats>>>;
}

const day = (iso: string): string => iso.slice(0, 10);

export function statsOf(rows: readonly StartRow[], key: HorizonKey): HorizonStats {
  const withAll = rows.filter((r) => COLUMNS.every((c) => r.readings[c][key] != null));
  const columns: HorizonStats['columns'] = {};
  for (const c of COLUMNS) {
    const ret = distribution(withAll.map((r) => ({ value: r.readings[c][key]!.returnPercent, at: day(r.start) })));
    const dd = distribution(withAll.map((r) => ({ value: r.readings[c][key]!.maxDrawdownPercent, at: day(r.start) })));
    if (!ret || !dd) continue;
    columns[c] = { return: ret, maxDrawdown: dd, timeInMarketMean: withAll.reduce((s, r) => s + r.readings[c][key]!.timeInMarketPercent, 0) / withAll.length };
  }
  const gaps: HorizonStats['gaps'] = {};
  for (const reference of ['A', 'B', 'hold'] as const) {
    gaps[reference] = {};
    for (const c of COLUMNS) {
      if (c === reference) continue;
      const diffs = withAll.map((r) => ({ value: r.readings[c][key]!.returnPercent - r.readings[reference][key]!.returnPercent, at: day(r.start) }));
      const d = distribution(diffs);
      const share = (test: (v: number) => boolean): number => (diffs.filter((x) => test(x.value)).length / diffs.length) * 100;
      if (d) gaps[reference]![c] = { ...d, winsPercent: share((v) => v >= TIE_POINTS), tiesPercent: share((v) => Math.abs(v) < TIE_POINTS), lossesPercent: share((v) => v <= -TIE_POINTS) };
    }
  }
  return { starts: withAll.length, columns, gaps };
}

/** How much the result moves when the start is shifted by one step of its grid. */
export interface NeighbourStats { pairs: number; medianAbsPoints: number; p90AbsPoints: number; maxAbsPoints: number; maxAt: string }

export function neighbourStats(rows: readonly StartRow[], key: HorizonKey): Partial<Record<Column, NeighbourStats>> {
  const out: Partial<Record<Column, NeighbourStats>> = {};
  for (const c of COLUMNS) {
    const moves: Array<{ value: number; at: string }> = [];
    for (let i = 1; i < rows.length; i += 1) {
      const [a, b] = [rows[i - 1]!.readings[c][key], rows[i]!.readings[c][key]];
      if (a && b) moves.push({ value: Math.abs(b.returnPercent - a.returnPercent), at: day(rows[i]!.start) });
    }
    const d = distribution(moves);
    if (d) out[c] = { pairs: d.n, medianAbsPoints: d.median, p90AbsPoints: d.p90, maxAbsPoints: d.max, maxAt: d.maxAt! };
  }
  return out;
}

export interface Summary {
  kind: 's4-start-conditions-study';
  descriptive_only: string;
  asOf: string;
  sources: Record<string, unknown>;
  grids: Record<'weekly' | 'daily', { from: string; to: string; starts: number; stepDays: number; horizons: string[] }>;
  fidelity: Fidelity;
  weekly: Record<HorizonKey, HorizonStats>;
  /** The weekly readings at 3 and 12 months, split by the market the start walked into. */
  weeklyByMarket: Record<'91' | '365', Record<string, HorizonStats>>;
  /** Share of the weekly starts where the gate holds at least one line back on the start bar. */
  gatedStartsPercent: number;
  /** 12-month result: how far it moves when the start is shifted by a week, and by a day. */
  neighbours: { weekly: Partial<Record<Column, NeighbourStats>>; daily: Partial<Record<Column, NeighbourStats>> };
  weeklyByYear: Record<string, HorizonStats>;
  daily365: HorizonStats;
  /** B against the continuous trajectory itself, rebased: the largest gap, in points of return. */
  bVersusSlice: Partial<Record<HorizonKey, { starts: number; maxAbsGapPoints: number; meanGapPoints: number }>>;
  pilot: null | {
    start: string;
    days: number;
    readings: Record<Column, { equityUsd: number; returnPercent: number; maxDrawdownPercent: number; timeInMarketPercent: number }>;
    /** Each variant's capital at the 4h close production's own figure was read on (14/11 04:00 UTC). */
    equityAtProductionReading: Record<Column, number> | null;
    productionObserved: typeof PILOT_OBSERVED;
  };
}

const MARKET_GROUPS: ReadonlyArray<{ name: string; test: (n: number) => boolean }> = [
  { name: '0 ou 1 actif au-dessus de sa moyenne 50 j', test: (n) => n <= 1 },
  { name: '2 actifs au-dessus', test: (n) => n === 2 },
  { name: '3 ou 4 actifs au-dessus', test: (n) => n >= 3 },
];

export function summarize(data: StudyData, rows: readonly StartRow[], fidelity: Fidelity, pilotSeries: PilotSeries | null = null): Summary {
  const weekly = rows.filter((r) => r.grid === 'weekly');
  const daily = rows.filter((r) => r.grid === 'daily');
  const pilotRow = rows.find((r) => r.grid === 'pilot') ?? null;
  const span = (g: readonly StartRow[], stepDays: number, horizons: string[]) => ({ from: day(g[0]!.start), to: day(g.at(-1)!.start), starts: g.length, stepDays, horizons });
  const bVersusSlice: Summary['bVersusSlice'] = {};
  for (const key of HORIZON_KEYS) {
    const gaps = weekly.filter((r) => r.slice?.[key] && r.readings.B[key]).map((r) => r.readings.B[key]!.returnPercent - r.slice![key]!.returnPercent);
    if (gaps.length > 0) bVersusSlice[key] = { starts: gaps.length, maxAbsGapPoints: Math.max(...gaps.map(Math.abs)), meanGapPoints: gaps.reduce((s, g) => s + g, 0) / gaps.length };
  }
  const years = [...new Set(weekly.map((r) => r.start.slice(0, 4)))].sort();
  return {
    kind: 's4-start-conditions-study',
    descriptive_only: 'Every candle read here was already seen by S4\'s development or validation. These are descriptions of what the frozen rule did from each start, not a new validation, and no parameter was searched.',
    asOf: new Date(data.asOfMs).toISOString(),
    sources: data.sources,
    grids: {
      weekly: span(weekly, WEEKLY_STEP_DAYS, ['91', '182', '365', 'end']),
      daily: span(daily, 1, ['365']),
    },
    fidelity,
    weekly: Object.fromEntries(HORIZON_KEYS.map((k) => [k, statsOf(weekly, k)])) as Record<HorizonKey, HorizonStats>,
    weeklyByMarket: {
      '91': Object.fromEntries(MARKET_GROUPS.map((g) => [g.name, statsOf(weekly.filter((r) => g.test(r.aboveMean)), '91')])),
      '365': Object.fromEntries(MARKET_GROUPS.map((g) => [g.name, statsOf(weekly.filter((r) => g.test(r.aboveMean)), '365')])),
    },
    gatedStartsPercent: (weekly.filter((r) => r.gatedAtStart > 0).length / weekly.length) * 100,
    neighbours: { weekly: neighbourStats(weekly, '365'), daily: neighbourStats(daily, '365') },
    weeklyByYear: Object.fromEntries(years.map((y) => [y, statsOf(weekly.filter((r) => r.start.startsWith(y)), '365')])),
    daily365: statsOf(daily, '365'),
    bVersusSlice,
    pilot: pilotRow && pilotRow.readings.A.end
      ? {
          start: pilotRow.start,
          days: Math.round(pilotRow.readings.A.end.days * 100) / 100,
          readings: Object.fromEntries(COLUMNS.map((c) => {
            const r = pilotRow.readings[c].end!;
            return [c, { equityUsd: Math.round((1 + r.returnPercent / 100) * data.cfg.startingCashUsd * 100) / 100, returnPercent: r.returnPercent, maxDrawdownPercent: r.maxDrawdownPercent, timeInMarketPercent: r.timeInMarketPercent }];
          })) as NonNullable<Summary['pilot']>['readings'],
          equityAtProductionReading: (() => {
            const i = pilotSeries ? pilotSeries.t.indexOf(Math.floor(Date.parse(PILOT_OBSERVED.readAt) / H4_MS) * H4_MS) : -1;
            return pilotSeries && i >= 0 ? (Object.fromEntries(COLUMNS.map((c) => [c, Math.round(pilotSeries.equity[c][i]! * 100) / 100])) as Record<Column, number>) : null;
          })(),
          productionObserved: PILOT_OBSERVED,
        }
      : null,
  };
}

/** The pilot's start bar by bar, every variant: the report's last chart. */
export function pilotSeriesOf(data: StudyData, continuous: ContinuousTrajectory): PilotSeries | null {
  if (!(PILOT_START_MS + 2 * H4_MS <= data.asOfMs)) return null;
  const equity = {} as PilotSeries['equity'];
  let t: number[] = [];
  for (const variant of START_VARIANTS) {
    const series = seriesOf(runStart(data, variant, PILOT_START_MS, data.asOfMs, continuous).run);
    equity[variant] = series.equity;
    t = series.t;
  }
  equity.hold = holdSeries(data, PILOT_START_MS, data.asOfMs).equity;
  // Each value is the equity at the CLOSE of its 4h bar: dated there.
  return { start: new Date(PILOT_START_MS).toISOString(), t: t.map((ms) => ms + H4_MS), equity };
}

// ── the run ──────────────────────────────────────────────────────────────────────────────

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function runShard(index: number, count: number): void {
  const data = loadStudyData();
  const continuous = runContinuous(data);
  const mine = gridOf(data).filter((_, i) => i % count === index);
  const rows: StartRow[] = [];
  mine.forEach((task, i) => {
    rows.push(measureStart(data, continuous, task));
    if ((i + 1) % 100 === 0) process.stderr.write(`  [${index + 1}/${count}] ${i + 1}/${mine.length} starts\n`);
  });
  mkdirSync(SHARD_DIR, { recursive: true });
  writeFileSync(path.join(SHARD_DIR, `${index}.json`), JSON.stringify(rows));
}

function spawnShard(index: number, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, '--shard', `${index}/${count}`], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${index} exited with code ${code}`))));
  });
}

async function main(): Promise<void> {
  const shard = arg('--shard');
  if (shard) {
    const [index, count] = shard.split('/').map(Number);
    runShard(index!, count!);
    return;
  }
  if (process.argv.includes('--report-only')) {
    // Redraws the charts and tables from the committed results, without re-running anything.
    const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(OUT_DIR, file), 'utf8')) as T;
    const written = writeReportAssets(read<Summary>('summary.json'), read<StartRow[]>('weekly.json').filter((r) => r.grid === 'weekly'), read<PilotSeries | null>('pilot.json'));
    console.log(`wrote ${written.join(', ')}`);
    return;
  }
  if (process.argv.includes('--refresh')) {
    const asOfArg = arg('--as-of');
    const asOfMs = asOfArg ? Date.parse(asOfArg) : Math.floor(Date.now() / H4_MS) * H4_MS;
    const manifest = await refreshLive(asOfMs);
    console.log(`live candles refreshed from ${manifest.source}, closed by ${manifest.as_of_exclusive}`);
  }

  const started = Date.now();
  const data = loadStudyData();
  const tasks = gridOf(data);
  console.log(`S4 start-conditions study — data to ${new Date(data.asOfMs).toISOString()}, ${data.tape.points.length} 4h bars`);
  console.log(`  ${tasks.filter((t) => t.grid === 'weekly').length} weekly starts (to the end of the data), ${tasks.filter((t) => t.grid === 'daily').length} daily starts (12 months), 5 variants + the kept basket`);

  const continuous = runContinuous(data);
  const fidelity = checkFidelity(data, continuous);
  console.log(`  fidelity: seeded rule = bench S4 on every bar: ${fidelity.seededEqualsNative}; sealed capital ${fidelity.sealedCapital} $ (published 1101.5); B at the pilot's start = production's seed: ${fidelity.pilotSeedEqualsProduction}`);
  if (!fidelity.seededEqualsNative || fidelity.sealedCapital !== 1101.5 || fidelity.pilotSeedEqualsProduction === false) {
    throw new Error('start study refused: the harness is not the bench, or its B start is not production\'s. Nothing measured.');
  }

  const requested = Number(arg('--jobs') ?? Math.min(8, Math.max(1, os.cpus().length - 1)));
  const jobs = Math.max(1, Math.min(requested, tasks.length));
  rmSync(SHARD_DIR, { recursive: true, force: true });
  console.log(`  running on ${jobs} process(es)…`);
  await Promise.all(Array.from({ length: jobs }, (_, i) => spawnShard(i, jobs)));
  const rows = Array.from({ length: jobs }, (_, i) => JSON.parse(readFileSync(path.join(SHARD_DIR, `${i}.json`), 'utf8')) as StartRow[])
    .flat()
    .sort((a, b) => (a.grid === b.grid ? a.start.localeCompare(b.start) : a.grid.localeCompare(b.grid)));
  rmSync(SHARD_DIR, { recursive: true, force: true });
  if (rows.length !== tasks.length) throw new Error(`start study: ${rows.length} starts measured, ${tasks.length} expected`);

  const pilot = pilotSeriesOf(data, continuous);
  const summary = summarize(data, rows, fidelity, pilot);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  // The weekly rows are the report's graphs; the daily ones are only ever read as aggregates.
  writeFileSync(path.join(OUT_DIR, 'weekly.json'), `${JSON.stringify(rows.filter((r) => r.grid !== 'daily'))}\n`);
  writeFileSync(path.join(OUT_DIR, 'pilot.json'), `${JSON.stringify(pilot)}\n`);
  const written = writeReportAssets(summary, rows.filter((r) => r.grid === 'weekly'), pilot);
  console.log(`\nwrote ${OUT_DIR}/summary.json, ${OUT_DIR}/weekly.json, ${OUT_DIR}/pilot.json${written.map((f) => `, ${f}`).join('')}`);
  console.log(`done in ${Math.round((Date.now() - started) / 1000)} s. Nothing was written outside the repository.`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked.endsWith(path.join('bench', 'start', 'run.ts'))) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
}
