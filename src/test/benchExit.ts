import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchCandle } from '../bench/exposure/bundle.js';
import { buildBenchConfig } from '../bench/exposure/config.js';
import { runWindow, type ExitRule, type HoldingView, type RunResult } from '../bench/exposure/engine.js';
import { computeRunMetrics } from '../bench/exposure/metrics.js';
import { T100, type Policy } from '../bench/exposure/policy.js';
import { mulberry32 } from '../bench/exposure/stats.js';
import { buildTape, prepareCalibrationTape, type Tape } from '../bench/exposure/tape.js';
import { ClosedWindowError, DEVELOPMENT, EXIT_DEVELOPMENT, SEAL_INSTANT_MS, assertMeasurable } from '../bench/exposure/windows.js';
import { buildDailyTable, crashEpisodes, developmentStart, lastRowAtOrBefore, type DailyRow, type DailyTable } from '../bench/exit/daily.js';
import { episodeReadings, computeExitMetrics } from '../bench/exit/metrics.js';
import { EXIT_PARAMETERS, SELECTION_RULES } from '../bench/exit/parameters.js';
import { hysteresisStates, makeExitRule } from '../bench/exit/rules.js';
import { selectCandidate, type SelectionInput } from '../bench/exit/selection.js';
import type { AssetRegime, RegimePoint } from '../market/regime.js';
import type { StickyPoint } from '../market/transition.js';

/**
 * THE PROOFS OF THE EXIT EXPERIMENT (protocol `docs/PROTOCOLE-SORTIE-v0.3.md`), on SYNTHETIC data
 * only, written before the freeze and before any measured replay. The one real-data check
 * reproduces a figure v1.3 already published (T100 without stop, development 2021-2022): it tests
 * that the new engine path is the old one, and reveals nothing about the exit window.
 *
 * Nothing here replays a policy on the exit development window, the internal verification as
 * such, or the sealed window.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;
const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const ASSETS = ['BNB', 'BTC', 'ETH', 'XRP'];
const T0 = Date.parse('2030-01-01T00:00:00Z');

/** A daily table whose rows are WRITTEN, not computed. */
function writtenTable(rows: Array<Partial<DailyRow> & { closeMs: number }>): DailyTable {
  const full: DailyRow[] = rows.map((r) => ({
    closeMs: r.closeMs,
    close: r.close ?? Object.fromEntries(ASSETS.map((a) => [a, 100])),
    sma50: r.sma50 ?? Object.fromEntries(ASSETS.map((a) => [a, 100])),
    sma200: r.sma200 ?? Object.fromEntries(ASSETS.map((a) => [a, 100])),
    index: r.index ?? 100,
    indexSma200: r.indexSma200 === undefined ? 100 : r.indexSma200,
  }));
  return { assets: ASSETS, weights: { BTC: 0.325, ETH: 0.325, BNB: 0.2, XRP: 0.15 }, rows: full, rowByClose: new Map(full.map((r, i) => [r.closeMs, i])) };
}
const same = (v: number): Record<string, number> => Object.fromEntries(ASSETS.map((a) => [a, v]));
const flatHoldings = (): Record<string, HoldingView> => Object.fromEntries(ASSETS.map((a) => [a, { held: false, entryAtMs: null }]));

// ── PROOF 1 — the window ─────────────────────────────────────────────────────────────
console.log('Proof 1 — the exit development window, and only it:');
{
  assertMeasurable(EXIT_DEVELOPMENT);
  ok('the exit development window [2020-10-01, 2024-07-01) is measurable', EXIT_DEVELOPMENT.fromMs === Date.parse('2020-10-01T00:00:00Z') && EXIT_DEVELOPMENT.toMs === SEAL_INSTANT_MS);
  assert.throws(() => assertMeasurable({ name: 'exit-development', fromMs: EXIT_DEVELOPMENT.fromMs, toMs: SEAL_INSTANT_MS + H4 }), ClosedWindowError);
  ok('an "exit-development" window reaching past the seal is refused', true);
  assert.throws(() => assertMeasurable({ name: 'exit-development', fromMs: EXIT_DEVELOPMENT.fromMs - DAY, toMs: SEAL_INSTANT_MS }), ClosedWindowError);
  ok('an "exit-development" window starting before the computed date is refused', true);
}

// ── PROOF 2 — the daily table and the synthetic index ────────────────────────────────
console.log('\nProof 2 — the daily closes, their means and the index of S5:');
{
  const rand = mulberry32(7);
  const universe: Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }> = {};
  const series: Record<string, number[]> = {};
  for (const a of ASSETS) {
    series[a] = [];
    let p = 100;
    const daily: BenchCandle[] = [];
    for (let d = 0; d < 260; d += 1) {
      p *= 1 + (rand() - 0.5) * 0.06;
      series[a]!.push(p);
      daily.push({ timestamp: T0 + d * DAY, open: p, high: p, low: p, close: p, volume: 1, quoteVolume: 1, trades: 1, takerBuyQuote: 0.5 });
    }
    universe[a] = { daily, h4: [] };
  }
  const tape = { tradable: ASSETS, tapes: Object.fromEntries(ASSETS.map((a) => [a, { daily: universe[a]!.daily }])) } as unknown as Tape;
  const table = buildDailyTable(tape, { BTC: 32.5, ETH: 32.5, BNB: 20, XRP: 15 });
  ok('rows are keyed by the CLOSE instant, one day after the open', table.rows[0]!.closeMs === T0 + DAY && table.rows.length === 260);
  const k = 230;
  const mean = (a: string, len: number): number => series[a]!.slice(k - len + 1, k + 1).reduce((s, v) => s + v, 0) / len;
  ok('the 200- and 50-day means include the close they are read at', near(table.rows[k]!.sma200.BTC!, mean('BTC', 200)) && near(table.rows[k]!.sma50.XRP!, mean('XRP', 50)));
  ok('no mean before enough closes', table.rows[198]!.sma200.BTC === null && table.rows[199]!.sma200.BTC !== null && table.rows[48]!.sma50.ETH === null);
  const growth = 0.325 * series.BTC![k]! / series.BTC![k - 1]! + 0.325 * series.ETH![k]! / series.ETH![k - 1]! + 0.2 * series.BNB![k]! / series.BNB![k - 1]! + 0.15 * series.XRP![k]! / series.XRP![k - 1]!;
  ok('the index is rebalanced daily from close-to-close returns', near(table.rows[k]!.index, table.rows[k - 1]!.index * growth, 1e-9) && table.rows[0]!.index === 100);
  ok('a close is known at its instant, not before', lastRowAtOrBefore(table, T0 + 5 * DAY)!.closeMs === T0 + 5 * DAY && lastRowAtOrBefore(table, T0 + 5 * DAY - 1)!.closeMs === T0 + 4 * DAY);

  const holed = { tradable: ASSETS, tapes: Object.fromEntries(ASSETS.map((a) => [a, { daily: a === 'XRP' ? universe[a]!.daily.filter((_, i) => i !== 100) : universe[a]!.daily }])) } as unknown as Tape;
  assert.throws(() => buildDailyTable(holed, { BTC: 32.5, ETH: 32.5, BNB: 20, XRP: 15 }));
  ok('a missing daily close is refused, never bridged', true);
}

// ── PROOF 3 — the crash episodes of §9 ───────────────────────────────────────────────
console.log('\nProof 3 — crash episodes on a written index:');
{
  const levels = [100, 120, 110, 90, 84, 70, 100, 119, 121, 150, 140, 100, 80, 90];
  const table = writtenTable(levels.map((index, i) => ({ closeMs: T0 + i * DAY, index })));
  const eps = crashEpisodes(table, T0, T0 + (levels.length - 1) * DAY);
  ok('two episodes', eps.length === 2);
  const [a, b] = eps;
  ok('the first starts at the last high (120), crosses at 84, troughs at 70, ends when 120 is regained (121)',
    a!.startMs === T0 + DAY && a!.crossedMs === T0 + 4 * DAY && a!.troughMs === T0 + 5 * DAY && a!.endMs === T0 + 8 * DAY && a!.recovered && near(a!.depthPercent, (1 - 70 / 120) * 100));
  ok('a 29 % dip from 150 is not an episode until 30 % is crossed; the second never recovers',
    b!.startMs === T0 + 9 * DAY && b!.crossedMs === T0 + 11 * DAY && b!.troughMs === T0 + 12 * DAY && !b!.recovered && b!.endMs === T0 + 13 * DAY);
  ok('the rolling high starts at the window start: an earlier high does not count', crashEpisodes(table, T0 + 5 * DAY, T0 + 13 * DAY).length === 1);
}

// ── PROOF 4 — the start of the development window, computed ──────────────────────────
console.log('\nProof 4 — the development start is the binding requirement, computed:');
{
  const synth = (seed: number, fromMs: number, toMs: number, stepMs: number): BenchCandle[] => {
    const rand = mulberry32(seed);
    const out: BenchCandle[] = [];
    let p = 100;
    for (let t = fromMs; t + stepMs <= toMs; t += stepMs) {
      const open = p;
      p *= 1 + (rand() - 0.5) * 0.03;
      out.push({ timestamp: t, open, high: Math.max(open, p) * 1.004, low: Math.min(open, p) * 0.996, close: p, volume: 1, quoteVolume: 1, trades: 1, takerBuyQuote: 0.5 });
    }
    return out;
  };
  const F0 = Date.parse('2030-01-01T00:00:00Z');
  const end = F0 + 300 * DAY;
  const universe: Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }> = {};
  ASSETS.forEach((a, i) => (universe[a] = { daily: synth(10 + i, F0, end, DAY), h4: synth(20 + i, F0, end, H4) }));
  // SOL starts 160 days later: its 50th daily close is F0 + 210 d, after the others' 200-day means (F0 + 200 d).
  universe.SOL = { daily: synth(30, F0 + 160 * DAY, end, DAY), h4: synth(31, F0 + 160 * DAY, end, H4) };
  const tape = buildTape(universe, ASSETS, end);
  const table = buildDailyTable(tape, { BTC: 32.5, ETH: 32.5, BNB: 20, XRP: 15 });
  const { startMs, requirements } = developmentStart(tape, table, end);
  const req = Object.fromEntries(requirements.map((r) => [r.name, r.firstMs]));
  ok('the 200-day means are first available at F0 + 200 d, the 50-day ones at F0 + 50 d', req.sma200 === F0 + 200 * DAY && req.index_sma200 === F0 + 200 * DAY && req.sma50 === F0 + 50 * DAY);
  ok('the regime is complete only once SOL has 50 daily closes: F0 + 210 d — and that binds', req.regime === F0 + 210 * DAY && startMs === F0 + 210 * DAY);
}

// ── PROOF 5 — the rules, one by one, on written closes ───────────────────────────────
console.log('\nProof 5 — the candidate rules:');
{
  const outAfter = (rule: ExitRule, closeMs: number, holdings = flatHoldings()): string[] => {
    rule.onDailyClose({ closeMs, holdings });
    return [...rule.out].sort();
  };

  // S1 — strictly above the 200-day mean, or out.
  const s1 = makeExitRule('S1', writtenTable([{ closeMs: T0, close: { BTC: 101, ETH: 100, BNB: 99, XRP: 150 } }]));
  ok('S1: in strictly above the 200-day mean, out at or below it', outAfter(s1, T0).join(',') === 'BNB,ETH');

  // S2 / S5 hysteresis, from a first state that is S1's.
  const closes = [99, 101, 98, 96.9, 102, 103.1, 97.5];
  const walk = hysteresisStates(writtenTable(closes.map((c, i) => ({ closeMs: T0 + i * DAY, index: c }))).rows, (r) => ({ close: r.index, mean: 100 }));
  ok('hysteresis: first state is S1\'s (99 → out); 101 and 102 do not re-enter; 103.1 does; 98 and 97.5 do not exit; 96.9 does',
    [...walk.values()].join(',') === 'false,false,false,false,false,true,true');
  const walk2 = hysteresisStates(writtenTable([101, 98, 96.9, 102].map((c, i) => ({ closeMs: T0 + i * DAY, index: c }))).rows, (r) => ({ close: r.index, mean: 100 }));
  ok('hysteresis: starting in, 98 holds, 96.9 exits, 102 stays out', [...walk2.values()].join(',') === 'true,true,false,false');
  const s5 = makeExitRule('S5', writtenTable([{ closeMs: T0, index: 101, indexSma200: 100 }, { closeMs: T0 + DAY, index: 96, indexSma200: 100 }]));
  ok('S5: the four assets go out together on the index', outAfter(s5, T0).length === 0 && outAfter(s5, T0 + DAY).join(',') === 'BNB,BTC,ETH,XRP');
  const s2 = makeExitRule('S2', writtenTable([
    { closeMs: T0, close: { BTC: 101, ETH: 101, BNB: 101, XRP: 101 } },
    { closeMs: T0 + DAY, close: { BTC: 98, ETH: 96, BNB: 101, XRP: 101 } },
  ]));
  ok('S2: per asset — BTC at 98 % stays in, ETH at 96 % goes out', outAfter(s2, T0).length === 0 && outAfter(s2, T0 + DAY).join(',') === 'ETH');

  // S3 / S4 — the trailing high since the FILL, then a RE-crossing of the 50-day mean.
  const btc = [100, 100, 120, 97, 96, 95, 85, 91, 91, 91, 91, 91, 91, 91, 91, 80, 75];
  const mean50 = [90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 60, 60];
  const rows = btc.map((c, i) => ({ closeMs: T0 + i * DAY, close: { ...same(100), BTC: c }, sma50: { ...same(50), BTC: mean50[i]! } }));
  const play = (name: 'S3' | 'S4'): Array<{ day: number; out: boolean }> => {
    const rule = makeExitRule(name, writtenTable(rows));
    let entry: number | null = T0; // filled at the open of day 0, the instant of its first close
    const log: Array<{ day: number; out: boolean }> = [];
    btc.forEach((_, d) => {
      const closeMs = T0 + d * DAY;
      const holdings = flatHoldings();
      holdings.BTC = entry == null ? { held: false, entryAtMs: null } : { held: true, entryAtMs: entry };
      for (const a of ['ETH', 'BNB', 'XRP']) holdings[a] = { held: true, entryAtMs: T0 };
      rule.onDailyClose({ closeMs, holdings });
      const out = rule.out.has('BTC');
      if (out) entry = null;
      else if (entry == null) entry = closeMs; // the rebuy fills at the next open, the instant of this close
      log.push({ day: d, out });
    });
    return log;
  };
  const s3 = play('S3');
  const outDays = (log: Array<{ day: number; out: boolean }>): number[] => log.filter((l) => l.out).map((l) => l.day);
  ok('S3: the close at the fill instant is not an observation (day 0); the high is 120; 97 holds (> 96); 96 exits (≤ 80 % of 120)', !s3[3]!.out && s3[4]!.out);
  ok('S3: still above its 50-day mean when it exits, it does NOT buy back at 95 — a re-crossing needs a dip first', s3[5]!.out);
  ok('S3: the dip to 85 arms it, 91 > 90 buys it back the next close', s3[6]!.out && !s3[7]!.out && outDays(s3).join(',') === '4,5,6');
  ok('S3: the trailing high resets at the rebuy — 80 then 75 is −18 % at most from 91, not −37 % from the old 120', !s3[15]!.out && !s3[16]!.out);
  const s4 = play('S4');
  ok('S4: the same signal at day 7 waits; the rebuy comes at day 14, ten days after the exit', outDays(s4).join(',') === '4,5,6,7,8,9,10,11,12,13' && !s4[14]!.out);
  const rule = makeExitRule('S3', writtenTable(rows));
  rule.onDailyClose({ closeMs: T0 + 2 * DAY, holdings: flatHoldings() });
  rule.onDailyClose({ closeMs: T0 + 4 * DAY, holdings: flatHoldings() });
  ok('S3: a line the rule holds in but that is not held is never stopped', rule.out.size === 0);
  ok('E0 never exits', makeExitRule('E0', writtenTable(rows)).out.size === 0);
  ok('the parameters are the protocol\'s, as written (A3)',
    EXIT_PARAMETERS.longMeanDays === 200 && EXIT_PARAMETERS.shortMeanDays === 50 && EXIT_PARAMETERS.hysteresisExitRatio === 0.97 &&
    EXIT_PARAMETERS.hysteresisEntryRatio === 1.03 && EXIT_PARAMETERS.trailingStopPercent === 20 && EXIT_PARAMETERS.minDaysOut === 10);
}

// ── PROOF 6 — the engine with a rule, on a scripted tape ─────────────────────────────
console.log('\nProof 6 — the engine: the rule replaces the stop, its exit beats the freeze, its rebuy obeys it:');
{
  const cfg = buildBenchConfig();
  type Script = Array<{ regime: AssetRegime; frozen: boolean; price: number }>;
  const scripted = (scripts: Record<string, Script>): Tape => {
    const n = scripts.BTC!.length;
    const points = Array.from({ length: n }, (_, i) => ({
      timestamp: T0 + i * H4,
      at: new Date(T0 + i * H4).toISOString(),
      global: { riskOff: false, raw: false, breadthPercent: 0, medianH4Rsi: 50, assetsPresent: 4, assetsExpected: 4, pendingBars: 0 },
      assets: {},
    })) as unknown as RegimePoint[];
    const tapes: Tape['tapes'] = {};
    for (const a of ASSETS) {
      const s = scripts[a]!;
      const h4: BenchCandle[] = s.map((b, i) => ({ timestamp: T0 + i * H4, open: b.price, high: b.price, low: b.price, close: b.price, volume: 1, quoteVolume: 1, trades: 1, takerBuyQuote: 0.5 }));
      const sticky: StickyPoint[] = s.map((b, i) => ({ timestamp: T0 + i * H4, active: b.regime, raw: b.regime, runLength: b.frozen ? 1 : 3, labelRun: 3, actionable: !b.frozen, frozen: b.frozen }));
      tapes[a] = { asset: a, h4, daily: [], sticky, stickyByTs: new Map(sticky.map((x) => [x.timestamp, x])), indexByTs: new Map(h4.map((c, i) => [c.timestamp, i])) };
    }
    return { regimeAssets: ASSETS, tradable: ASSETS, points, tapes, barMs: H4, nowMs: T0 + n * H4 };
  };
  const bars = (n: number, price: number, frozen = false): Script => Array.from({ length: n }, () => ({ regime: 'trend_up' as AssetRegime, frozen, price }));
  /** A rule whose out-set per daily close is WRITTEN. */
  const writtenRule = (outByClose: Record<number, string[]>): ExitRule & { calls: number[] } => {
    const r = {
      name: 'written',
      out: new Set<string>() as ReadonlySet<string>,
      calls: [] as number[],
      onDailyClose({ closeMs }: { closeMs: number }) {
        r.calls.push(closeMs);
        if (outByClose[closeMs]) r.out = new Set(outByClose[closeMs]);
      },
    };
    return r;
  };
  const run = (tape: Tape, policy: Policy, exitRule?: ExitRule, diagnosticWithoutStop = false): RunResult =>
    runWindow({ tape, cfg, policy, window: { name: 'development', fromMs: T0, toMs: tape.nowMs }, unsafeSyntheticWindow: true, exitRule, diagnosticWithoutStop });
  const N = 30; // five days of 4h bars

  // (a) Timing and the share in cash. BTC out at the close of day 1 (T0 + 1 d), read on bar 5.
  const steady = (): Record<string, Script> => Object.fromEntries(ASSETS.map((a) => [a, bars(N, 100)]));
  const ra = writtenRule({ [T0 + DAY]: ['BTC'] });
  const a = run(scripted(steady()), T100, ra).bars;
  ok('the rule is read once per daily close, starting with the close at the window\'s first bar', ra.calls.slice(0, 3).join(',') === [T0, T0 + DAY, T0 + 2 * DAY].join(','));
  ok('the exit is decided on the bar whose close is the daily close, and on no earlier bar',
    a.findIndex((b) => b.ruleExitsDecided.includes('BTC')) === 5 && a[5]!.states.BTC === 'excluded' && a[5]!.weights.BTC! > 30);
  ok('it fills at the next open, the instant of that close: BTC weighs nothing at the next close', a[6]!.weights.BTC! < 1e-9 && a[6]!.executedCause === 'rule_exit');
  // 67.5 % plus the hair the sale's fees took off the equity the other lines are weighed against.
  ok('its share stays in cash, never redistributed (S1-S4)', a.slice(6).every((b) => b.exposurePercent < 67.6 && b.weights.ETH! < 32.6 && b.cash > 320));

  // (b) The exit beats a freeze: BTC frozen from bar 3 to bar 12, the rule exits it at day 1.
  const sb = steady();
  sb.BTC = [...bars(3, 100), ...bars(10, 100, true), ...bars(N - 13, 100)];
  const b = run(scripted(sb), T100, writtenRule({ [T0 + DAY]: ['BTC'] })).bars;
  ok('a frozen line the rule takes out is sold at the next open anyway (§5)', b[5]!.gates.BTC === 'frozen' && b[5]!.states.BTC === 'excluded' && b[6]!.weights.BTC! < 1e-9);

  // (c) The rebuy obeys the gate: BTC back in at day 2 (bar 11) but frozen until bar 15.
  const sc = steady();
  sc.BTC = [...bars(11, 100), ...bars(5, 100, true), ...bars(N - 16, 100)];
  const c = run(scripted(sc), T100, writtenRule({ [T0 + DAY]: ['BTC'], [T0 + 2 * DAY]: [] })).bars;
  ok('the rebuy is decided at the close of day 2', c[11]!.ruleEntriesDecided.includes('BTC'));
  ok('a frozen line is not bought while the freeze lasts', c.slice(11, 16).every((x) => x.weights.BTC! < 1e-9 && x.states.BTC === 'fixed'));
  ok('the first actionable bar (16) decides the purchase, which fills at the next open', c[16]!.states.BTC === 'free' && c[16]!.weights.BTC! < 1e-9 && c[17]!.weights.BTC! > 25);

  // (d) The peak stop never fires with a rule; E0 is "T100 without any stop", bar for bar.
  const sd = steady();
  sd.BTC = [...bars(4, 100), ...bars(3, 85, true), ...bars(N - 7, 85)];
  const tapeD = scripted(sd);
  const withStop = run(tapeD, T100).bars;
  const e0 = run(tapeD, T100, makeExitRule('E0', writtenTable(Array.from({ length: 6 }, (_, i) => ({ closeMs: T0 + i * DAY }))))).bars;
  const diag = run(tapeD, T100, undefined, true).bars;
  ok('without a rule, the v1.3 stop fires on the 15 % drop in transition', withStop.some((x) => x.stopExitsDecided.includes('BTC')));
  ok('with a rule, the stop never fires and BTC is kept', e0.every((x) => x.stopExitsDecided.length === 0) && e0[N - 1]!.weights.BTC! > 25);
  ok('E0 equals T100 with the stop disabled, bar for bar', e0.length === diag.length && e0.every((x, i) => x.equity === diag[i]!.equity && JSON.stringify(x.weights) === JSON.stringify(diag[i]!.weights)));

  // (d') The rule's starting state is not an exit: XRP out from the very first read is never bought.
  const startOut = run(scripted(steady()), T100, writtenRule({ [T0]: ['XRP'] }));
  ok('an asset out at the first read is never bought, and no exit is counted for it',
    startOut.bars.every((x) => x.weights.XRP! < 1e-9 && x.ruleExitsDecided.length === 0) && computeExitMetrics(startOut, H4, []).exits === 0);

  // (e) A1 on the run: no residue once the exit has filled.
  const tableE = writtenTable(Array.from({ length: 6 }, (_, i) => ({ closeMs: T0 + i * DAY })));
  const resA = run(scripted(steady()), T100, writtenRule({ [T0 + DAY]: ['BTC'] }));
  const m = computeExitMetrics(resA, H4, crashEpisodes(tableE, T0, T0 + 5 * DAY));
  ok('A1: zero residual bar after the exit filled; one exit, counted once', m.residualBarsAfterExit === 0 && m.exits === 1 && m.exitEvents === 1);
}

// ── PROOF 7 — the per-episode readings and the rebuy delay ───────────────────────────
console.log('\nProof 7 — episode readings and the rebuy delay of §10:');
{
  // 12 days of 4h bars; equity and exposure WRITTEN.
  const n = 72;
  const equity = Array.from({ length: n }, (_, i) => (i < 12 ? 1000 : i < 30 ? 1000 - (i - 11) * 20 : 640 + (i - 29) * 5));
  const exposure = Array.from({ length: n }, (_, i) => (i < 20 ? 97 : i < 50 ? 10 : 85));
  let high = 0;
  const fake = {
    policy: 'X',
    openingEquity: 1000,
    pendingNotExecuted: 0,
    window: { name: 'development', fromMs: T0, toMs: T0 + n * H4 },
    bars: equity.map((e, i) => {
      high = Math.max(high, e);
      return { t: T0 + i * H4, equity: e, exposurePercent: exposure[i]!, drawdownPercent: ((high - e) / high) * 100 };
    }),
  } as unknown as RunResult;
  const episode = { startMs: T0 + 2 * DAY, peakIndex: 100, crossedMs: T0 + 4 * DAY, troughMs: T0 + 5 * DAY, troughIndex: 60, depthPercent: 40, endMs: T0 + 11 * DAY, recovered: false };
  const [r] = episodeReadings(fake, H4, [episode]);
  ok('the episode runs from the close at its start to the close at its end', r!.startEquity === equity[11] && r!.endEquity === equity[65]);
  ok('its drawdown is read from the policy\'s own high since the start', near(r!.drawdownWithinPercent, (1 - 640 / 1000) * 100));
  ok('the rebuy delay counts from the index trough to the first 4h close at >= 80 % exposure', r!.rebuyAtMs === T0 + 51 * H4 && near(r!.rebuyDelayDays!, (51 * H4 - 5 * DAY) / DAY));
  const never = episodeReadings({ ...fake, bars: fake.bars.map((x) => ({ ...x, exposurePercent: 50 })) } as RunResult, H4, [episode]);
  ok('never back at 80 %: "non revenu" (null)', never[0]!.rebuyDelayDays === null);
}

// ── PROOF 8 — the selection of §11 ───────────────────────────────────────────────────
console.log('\nProof 8 — the pre-registered selection:');
{
  const base = (name: SelectionInput['name'], dd: number, friction: number, ann: number): SelectionInput => ({ name, maxDrawdownPercent: dd, frictionUsd: friction, annualisedReturnPercent: ann });
  const e1 = 200;
  const r1 = selectCandidate([base('S1', 45, 90, 30), base('S2', 40, 80, 32.5), base('S3', 49, 99, 40), base('S4', 51, 50, 60), base('S5', 30, 101, 70)], e1);
  ok('above 50 % drawdown is out (S4), above half of E1\'s frictions is out (S5, 101 > 100)', !r1.lines.find((l) => l.name === 'S4')!.retained && !r1.lines.find((l) => l.name === 'S5')!.retained);
  ok('exactly 50 % drawdown and exactly half the frictions are kept', selectCandidate([base('S1', 50, 100, 1), base('S2', 60, 1, 1), base('S3', 60, 1, 1), base('S4', 60, 1, 1), base('S5', 60, 1, 1)], e1).selected === 'S1');
  ok('the best is S3 (40); S2 is 7.5 behind, S1 10 behind: S3 is selected', r1.best === 'S3' && r1.selected === 'S3');
  const r2 = selectCandidate([base('S1', 45, 90, 37.1), base('S2', 40, 80, 39), base('S3', 49, 99, 40), base('S4', 49, 50, 38), base('S5', 30, 99, 37.5)], e1);
  ok('within 3 points the simplest wins, in the order S1, S5, S2, S3, S4', r2.best === 'S3' && r2.withinMargin.join(',') === 'S1,S5,S2,S3,S4' && r2.selected === 'S1');
  const r3 = selectCandidate([base('S1', 45, 90, 37), base('S2', 40, 80, 39), base('S3', 49, 99, 40), base('S4', 49, 50, 38), base('S5', 30, 99, 37.5)], e1);
  ok('exactly 3 points behind is not "less than 3": S1 (37) drops, S5 (37.5) is the simplest left', r3.selected === 'S5' && !r3.withinMargin.includes('S1'));
  const none = selectCandidate([base('S1', 55, 90, 37), base('S2', 51, 80, 39), base('S3', 49, 120, 40), base('S4', 70, 50, 38), base('S5', 30, 150, 37.5)], e1);
  ok('none left: no selection, and the reason names each elimination (A2)', none.selected === null && /S3: frictions/.test(none.reason) && /S1: drawdown/.test(none.reason));
  ok('the rules are the protocol\'s', SELECTION_RULES.maxDrawdownPercent === 50 && SELECTION_RULES.maxFrictionShareOfE1 === 0.5 && SELECTION_RULES.simplicityMarginPoints === 3);
}

// ── PROOF 9 — the new engine path IS the old one on real data (a published v1.3 figure) ─
console.log('\nProof 9 — on the v1.3 development window, the E0 path reproduces v1.3\'s published T100 without stop:');
{
  const cfg = buildBenchConfig();
  const tape = prepareCalibrationTape(process.cwd(), DEVELOPMENT.toMs);
  const table = buildDailyTable(tape, cfg.basket);
  const e0 = computeRunMetrics(runWindow({ tape, cfg, policy: T100, window: DEVELOPMENT, exitRule: makeExitRule('E0', table) }), tape.barMs);
  const t100 = computeRunMetrics(runWindow({ tape, cfg, policy: T100, window: DEVELOPMENT }), tape.barMs);
  const published = JSON.parse(readFileSync(path.join('out', 'bench-exposure', 'development', 'summary.json'), 'utf8')) as {
    policies: Array<{ policy: string; closingEquity: number }>;
    diagnostic_without_stop: { policies: Array<{ policy: string; closingEquity: number }> };
  };
  const pubNoStop = published.diagnostic_without_stop.policies.find((p) => p.policy === 'T100')!.closingEquity;
  const pubT100 = published.policies.find((p) => p.policy === 'T100')!.closingEquity;
  ok(`E0 closes at ${e0.closingEquity.toFixed(6)}, v1.3 published ${pubNoStop}`, near(Number(e0.closingEquity.toFixed(6)), pubNoStop, 1e-9));
  ok(`T100 (= E1) is unchanged by the new hook: ${t100.closingEquity.toFixed(6)} vs ${pubT100}`, near(Number(t100.closingEquity.toFixed(6)), pubT100, 1e-9));
}

console.log(`\n${passed} checks passed.`);
