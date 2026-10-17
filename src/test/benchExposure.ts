import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Decimal } from '../money.js';
import { computeBundleSha256, sha256Hex, type BundleManifest } from '../calibration/exposure/bundle.js';
import { CORE_PIN, SOL_PIN, SealViolationError, loadCertifiedPart, type BenchCandle, type BundlePin } from '../bench/exposure/bundle.js';
import { buildTape, firstPrefixDivergence, prepareCalibrationTape } from '../bench/exposure/tape.js';
import { allocate, type AllocLine } from '../bench/exposure/allocate.js';
import { buildBenchConfig, BASKET } from '../bench/exposure/config.js';
import { executeAllocation } from '../bench/exposure/execute.js';
import { R100_0, RPA, T100, applyRebalanceThreshold, confirmedBullish, scorePolicy, type Policy } from '../bench/exposure/policy.js';
import type { Tape } from '../bench/exposure/tape.js';
import { SCORE_SETS, THRESHOLD_GRID_POINTS, TRANSFORMS, VARIANTS, topDecileOfRun } from '../bench/exposure/variants.js';
import type { StickyPoint } from '../market/transition.js';
import type { AssetRegime, RegimePoint } from '../market/regime.js';
import { runWindow, type RunResult } from '../bench/exposure/engine.js';
import { computeRunMetrics, dailyLogReturns } from '../bench/exposure/metrics.js';
import { COMPONENT_NAMES, computeComponents } from '../bench/exposure/components.js';
import { HORIZONS_DAYS, runPredictiveStudy } from '../bench/exposure/predictive.js';
import { compositeScore, fitNormalisation, linearTarget, stepTarget, topDecileMedianExposure } from '../bench/exposure/score.js';
import { laggedProducts, mulberry32, neweyWest, politisWhite, stationaryBootstrap } from '../bench/exposure/stats.js';
import { ClosedWindowError, DEVELOPMENT, SEAL_INSTANT_MS, VALIDATION, VERIFICATION, assertMeasurable, insideWithEmbargo, type Window } from '../bench/exposure/windows.js';

/**
 * THE PROOFS OF BENCH v1.3 (protocol v1.3). Synthetic data wherever the brief asks for it —
 * the seal, the prefix property — and EXTERNAL invariants on the development run wherever a
 * test written from the same understanding as the code would only confirm the code: realised
 * exposure, cash, the re-entry rule read off production's own sticky timeline, the frontier.
 *
 * Nothing here reads the internal verification or the validation window.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;
const ROOT = process.cwd();
const H4 = 4 * 3_600_000;
const DAY = 86_400_000;

// ── synthetic data ───────────────────────────────────────────────────────────────────
function synthSeries(seed: number, fromMs: number, toMs: number, stepMs: number, start: number): BenchCandle[] {
  const rand = mulberry32(seed);
  const out: BenchCandle[] = [];
  let price = start;
  for (let t = fromMs; t + stepMs <= toMs; t += stepMs) {
    const open = price;
    const drift = (rand() - 0.5) * 0.04 + Math.sin(t / (40 * DAY)) * 0.004;
    const close = open * (1 + drift);
    out.push({
      timestamp: t,
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      volume: 100 + rand() * 50,
      quoteVolume: 1000 + rand() * 500,
      trades: 10,
      takerBuyQuote: 500 + rand() * 200,
    });
    price = close;
  }
  return out;
}
function synthUniverse(fromMs: number, toMs: number): Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }> {
  const u: Record<string, { daily: BenchCandle[]; h4: BenchCandle[] }> = {};
  ['BTC', 'ETH', 'BNB', 'XRP', 'SOL'].forEach((a, i) => {
    u[a] = { daily: synthSeries(11 + i, fromMs, toMs, DAY, 100 + i), h4: synthSeries(101 + i, fromMs, toMs, H4, 100 + i) };
  });
  return u;
}

// ── PROOF 1 — the windows, and the gate on them ──────────────────────────────────────
console.log('Proof 1 — only the development window is measurable:');
{
  assertMeasurable(DEVELOPMENT);
  ok('development is measurable', true);
  assert.throws(() => assertMeasurable(VERIFICATION), ClosedWindowError);
  ok('the internal verification is refused', true);
  assert.throws(() => assertMeasurable(VALIDATION), ClosedWindowError);
  ok('the validation is refused', true);
  const forged: Window = { name: 'development', fromMs: DEVELOPMENT.fromMs, toMs: VERIFICATION.toMs };
  assert.throws(() => assertMeasurable(forged), ClosedWindowError);
  ok('a "development" window reaching into the verification is refused', true);
  ok('windows are contiguous and semi-open', DEVELOPMENT.toMs === VERIFICATION.fromMs && VERIFICATION.toMs === SEAL_INSTANT_MS && VALIDATION.fromMs === SEAL_INSTANT_MS);
  ok('embargo: an exit on the first open of the next window is outside', !insideWithEmbargo(DEVELOPMENT, DEVELOPMENT.toMs - DAY, DEVELOPMENT.toMs));
  ok('embargo: an exit one bar earlier is inside', insideWithEmbargo(DEVELOPMENT, DEVELOPMENT.toMs - DAY, DEVELOPMENT.toMs - H4));
}

// ── PROOF 2 — the seal, on synthetic bundles ─────────────────────────────────────────
console.log('\nProof 2 — the calibration path refuses any candle opened from 2024-07-01:');
{
  const sandbox = mkdtempSync(path.join(tmpdir(), 'bench-seal-'));
  const make = (name: string, asOf: string, lastOpen: number): BundlePin => {
    const dir = path.join(sandbox, name);
    mkdirSync(path.join(dir, 'raw'), { recursive: true });
    const first = lastOpen - 9 * H4;
    const rows = Array.from({ length: 10 }, (_, i) => {
      const t = first + i * H4;
      return { t, o: 1, h: 1, l: 1, c: 1, v: 1, closeTime: t + H4 - 1, qv: 1, trades: 1, takerBuyBase: 1, takerBuyQuote: 1 };
    });
    const text = JSON.stringify(rows);
    writeFileSync(path.join(dir, 'raw', 'SOLUSDT-4h.json'), text);
    const manifest = {
      schema_version: 1,
      bundle_id: name,
      source: 'https://data-api.binance.vision',
      producer_repository: 'x',
      fetch_start: new Date(first).toISOString(),
      evaluation_start: new Date(first + H4).toISOString(),
      as_of_exclusive: asOf,
      acquisition_config_sha256: 'a'.repeat(64),
      producer_source_sha256: 'b'.repeat(64),
      producer_source_files: [],
      generation_git_commit: null,
      generation_git_commit_authority: 'x',
      series: [{
        symbol: 'SOLUSDT', timeframe: '4h', file: 'raw/SOLUSDT-4h.json', rows: 10,
        first_open_time: new Date(first).toISOString(), first_close_time: new Date(first + H4 - 1).toISOString(),
        last_open_time: new Date(lastOpen).toISOString(), last_close_time: new Date(lastOpen + H4 - 1).toISOString(),
        duplicate_open_times_returned_by_source: 0, duplicates_ok: true, strictly_ordered: true, gap_count: 0, gaps: [],
        discarded_by_admissibility: 0, sha256: sha256Hex(Buffer.from(text)),
      }],
      bundle_sha256: '',
    } as unknown as BundleManifest;
    manifest.bundle_sha256 = computeBundleSha256(manifest);
    writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, bundleId: name, bundleSha256: manifest.bundle_sha256, series: ['SOLUSDT:4h'] };
  };

  const clean = make('clean', new Date(SEAL_INSTANT_MS).toISOString(), SEAL_INSTANT_MS - H4);
  ok('a bundle ending on the last calibration bar is accepted', loadCertifiedPart(clean, '/').series.get('SOLUSDT:4h')!.length === 10);

  const claimed = make('claims-past', '2026-06-01T00:00:00.000Z', SEAL_INSTANT_MS - H4);
  assert.throws(() => loadCertifiedPart(claimed, '/'), SealViolationError);
  ok('a manifest DECLARING a horizon past the seal is refused before any file is read', true);

  const carrying = make('carries-sealed', new Date(SEAL_INSTANT_MS).toISOString(), SEAL_INSTANT_MS);
  assert.throws(() => loadCertifiedPart(carrying, '/'), SealViolationError);
  ok('a self-consistent bundle CARRYING a candle opened at the seal is refused on the row', true);

  rmSync(sandbox, { recursive: true, force: true });

  const core = loadCertifiedPart(CORE_PIN, ROOT);
  const sol = loadCertifiedPart(SOL_PIN, ROOT);
  const last = [...core.series.values(), ...sol.series.values()].map((s) => s[s.length - 1]!.timestamp);
  ok('the shipped v2 parts certify and end before the seal', last.every((t) => t < SEAL_INSTANT_MS));
  ok('the 19/02/2020 Binance hole is declared and real on the core 4h series',
    !core.series.get('BTCUSDT:4h')!.some((c) => c.timestamp === Date.parse('2020-02-19T12:00:00Z')));
}

// ── PROOF 3 — the prefix property, on synthetic data ────────────────────────────────
console.log('\nProof 3 — the timeline on truncated data is the prefix of the timeline on full data:');
{
  const from = Date.parse('2020-01-01T00:00:00Z');
  const to = Date.parse('2021-03-01T00:00:00Z');
  const cut = Date.parse('2020-12-01T00:00:00Z');
  const full = synthUniverse(from, to);
  const truncated = Object.fromEntries(Object.entries(full).map(([a, s]) => [a, {
    daily: s.daily.filter((c) => c.timestamp + DAY <= cut),
    h4: s.h4.filter((c) => c.timestamp + H4 <= cut),
  }]));
  const tradable = ['BNB', 'BTC', 'ETH', 'XRP'];
  const tFull = buildTape(full, tradable, to);
  const tCut = buildTape(truncated, tradable, cut);
  ok(`${tCut.points.length} synthetic bars, identical regime and sticky timelines`, tCut.points.length > 1000 && firstPrefixDivergence(tCut, tFull) === null);

  // A negative control: the property must be ABLE to fail.
  const altered = Object.fromEntries(Object.entries(truncated).map(([a, s]) => [a, { daily: s.daily, h4: s.h4.map((c) => ({ ...c })) }]));
  const h4 = altered.BTC!.h4;
  for (let i = h4.length - 200; i < h4.length; i += 1) h4[i] = { ...h4[i]!, close: h4[i]!.close * 0.8 };
  ok('a tampered pre-cut candle is detected', firstPrefixDivergence(buildTape(altered, tradable, cut), tFull) !== null);
}

// ── PROOF 4 — the allocator, rule by rule ────────────────────────────────────────────
console.log('\nProof 4 — the allocation of protocol v1.3, point 7:');
{
  const caps = { BTC: 35, ETH: 35, BNB: 20, XRP: 15 };
  const line = (asset: string, state: AllocLine['state'], currentPercent = 0): AllocLine => ({ asset, state, currentPercent, fixedCause: state === 'fixed' ? 'frozen' : undefined });
  const t = (a: ReturnType<typeof allocate>, asset: string): number => a.lines.find((l) => l.asset === asset)!.targetPercent;

  const all = allocate({ policyTargetPercent: 100, basket: BASKET, caps, lines: ['BTC', 'ETH', 'BNB', 'XRP'].map((a) => line(a, 'free')) });
  ok('all free at 100 %: exactly the basket, no shortfall', near(t(all, 'BTC'), 32.5) && near(t(all, 'ETH'), 32.5) && near(t(all, 'BNB'), 20) && near(t(all, 'XRP'), 15) && near(all.capacityShortfallPercent, 0));

  const stopped = allocate({ policyTargetPercent: 100, basket: BASKET, caps, lines: [line('BTC', 'stopped', 30), line('ETH', 'free'), line('BNB', 'free'), line('XRP', 'free')] });
  ok('BTC stopped: ETH rises to its cap (+2.5), the book caps at 70 %, 30 points capacite_insuffisante',
    near(t(stopped, 'BTC'), 0) && near(t(stopped, 'ETH'), 35) && near(t(stopped, 'BNB'), 20) && near(t(stopped, 'XRP'), 15) &&
    near(stopped.plannedExposurePercent, 70) && near(stopped.capacityShortfallPercent, 30));

  const excluded = allocate({ policyTargetPercent: 100, basket: BASKET, caps, lines: [line('BTC', 'excluded', 30), line('ETH', 'free'), line('BNB', 'free'), line('XRP', 'free')] });
  ok('BTC excluded by RPA: its share stays in cash, nothing is redistributed, no shortfall',
    near(t(excluded, 'ETH'), 32.5) && near(excluded.plannedExposurePercent, 67.5) && near(excluded.capacityShortfallPercent, 0));

  const over = allocate({ policyTargetPercent: 100, basket: BASKET, caps, lines: [line('BTC', 'fixed', 40), line('ETH', 'free'), line('BNB', 'free'), line('XRP', 'free')] });
  ok('a frozen overweight (BTC 40) consumes the budget and compresses the free lines pro rata',
    near(t(over, 'BTC'), 40) && near(over.plannedExposurePercent, 100, 1e-6) &&
    near(t(over, 'ETH') / t(over, 'XRP'), 32.5 / 15, 1e-6) && near(t(over, 'ETH'), 60 * 32.5 / 67.5, 1e-6));

  const negative = allocate({ policyTargetPercent: 0, basket: BASKET, caps, lines: [line('BTC', 'fixed', 30), line('ETH', 'free', 30), line('BNB', 'reduce_only', 10), line('XRP', 'free', 5)] });
  ok('a negative budget sends every free line to 0 and publishes the residual over-exposure',
    near(t(negative, 'ETH'), 0) && near(t(negative, 'BNB'), 0) && near(t(negative, 'XRP'), 0) && near(negative.overExposurePercent, 30));

  const reduceOnly = allocate({ policyTargetPercent: 100, basket: BASKET, caps, lines: [line('BTC', 'reduce_only', 10), line('ETH', 'free'), line('BNB', 'free'), line('XRP', 'free')] });
  ok('a reduce-only line never receives more than it holds', t(reduceOnly, 'BTC') <= 10 + 1e-9);
  ok('a fixed line is a HOLD (no order at execution)', over.lines.find((l) => l.asset === 'BTC')!.hold);
}

// ── PROOF 5 — execution through production's planMovements ──────────────────────────
console.log("\nProof 5 — execution is production's pro-rata planner, never alphabetical:");
{
  const cfg = buildBenchConfig();
  const prices = { BTC: new Decimal(30000), ETH: new Decimal(2000), BNB: new Decimal(300), XRP: new Decimal(0.5) };
  const book: Record<string, { qty: Decimal }> = {};
  const { cash, report } = executeAllocation({
    cash: new Decimal(1000), book, prices, targets: { BTC: 32.5, ETH: 32.5, BNB: 20, XRP: 15 },
    reserveAsset: 'USDT', feePercent: cfg.feePercentPerLeg, slippagePercent: cfg.slippagePercentPerLeg, minMovementPercent: cfg.minMovementPercent,
  });
  const values = Object.fromEntries(Object.entries(book).map(([a, l]) => [a, l.qty.times(prices[a as keyof typeof prices]).toNumber()]));
  const ratios = ['BTC', 'ETH', 'BNB', 'XRP'].map((a) => values[a]! / (10 * BASKET[a]!));
  ok('from cash, every line lands at the SAME fraction of its target (no last-in-order shortfall)',
    Math.max(...ratios) - Math.min(...ratios) < 1e-9);
  ok('cash never goes negative, fees are paid', cash.gte(0) && report.fees.gt(0));
  ok('everything is deployed but fees and slippage (< 0.2 %)', cash.toNumber() < 2);

  // A sub-floor leg is dropped and NOT redistributed.
  const book2 = { BTC: { qty: new Decimal(325 / 30000) }, ETH: { qty: new Decimal(325 / 2000) }, BNB: { qty: new Decimal(200 / 300) }, XRP: { qty: new Decimal(140 / 0.5) } };
  const r2 = executeAllocation({
    cash: new Decimal(10), book: book2, prices, targets: { BTC: 32.5, ETH: 32.5, BNB: 20, XRP: 15 },
    reserveAsset: 'USDT', feePercent: 0.1, slippagePercent: 0.05, minMovementPercent: 2,
  });
  ok('a 1 % gap on XRP is under the 2 % floor: dropped as movement_floor, nothing traded', r2.report.suppressed.some((s) => s.asset === 'XRP' && s.reason === 'movement_floor') && r2.report.tradedNotional.eq(0));
}

// ── PROOF 6 — the policies and the rebalancing threshold ─────────────────────────────
console.log('\nProof 6 — policies and the total-exposure threshold:');
{
  ok('T100 never shows the risk_off to the gate', T100.gateSeesRiskOff === false && R100_0.gateSeesRiskOff && RPA.gateSeesRiskOff);
  ok('the threshold holds a small move', applyRebalanceThreshold(55, 50, 10) === 50);
  ok('the threshold lets a large move through', applyRebalanceThreshold(65, 50, 10) === 65);
  ok('0 and 100 are always reachable', applyRebalanceThreshold(100, 95, 10) === 100 && applyRebalanceThreshold(0, 5, 10) === 0);
  ok('no reading keeps the last target, or 0 on the first bar', applyRebalanceThreshold(Number.NaN, 40, 10) === 40 && applyRebalanceThreshold(Number.NaN, null, 10) === 0);
  const sticky = (active: string, actionable: boolean) => ({ timestamp: 0, active, raw: active, runLength: 3, labelRun: 3, actionable, frozen: !actionable }) as never;
  ok('re-entry: only a confirmed trend_up or reversal_up releases', ['trend_up', 'reversal_up'].every((r) => confirmedBullish(sticky(r, true))));
  ok('re-entry: never on range, trend_down or reversal_down, never during a transition',
    ['range', 'trend_down', 'reversal_down'].every((r) => !confirmedBullish(sticky(r, true))) && !confirmedBullish(sticky('trend_up', false)));
  const sp = scorePolicy({ name: 's', toTarget: linearTarget(-1, 1), rebalanceThresholdPoints: 5, riskOffForcesZero: true });
  ok('a SCORE policy maps a score to an exact target', sp.decide({ point: { global: { riskOff: false } } as never, sticky: {}, excludedBefore: new Set(), score: 0 }).totalTargetPercent === 50);
  ok('step targets are exact', stepTarget([{ atLeast: 0, targetPercent: 60 }, { atLeast: 1, targetPercent: 100 }], 0)(0.5) === 60);
}

// ── PROOF 7 — the statistics against closed forms ────────────────────────────────────
console.log('\nProof 7 — Newey-West, Politis-White and the stationary bootstrap:');
{
  const rand = mulberry32(7);
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const n = 4000;
  const x = Array.from({ length: n }, normal);
  const y = x.map((v) => 0.3 * v + normal());
  const r0 = neweyWest(x, y, 0);
  ok('lag 0: the HAC error is the White error, close to OLS on iid data', Math.abs(r0.slopeSe / r0.slopeSeOls - 1) < 0.1 && Math.abs(r0.slope - 0.3) < 0.05);
  // Overlapping 20-step sums: OLS understates the error, Newey-West must not.
  const h = 20;
  const e = Array.from({ length: n + h }, normal);
  const z = Array.from({ length: n + h }, normal);
  const xs = Array.from({ length: n }, (_, i) => z.slice(i, i + h).reduce((s, v) => s + v, 0));
  const ys = Array.from({ length: n }, (_, i) => e.slice(i, i + h).reduce((s, v) => s + v, 0));
  const rOv = neweyWest(xs, ys, h - 1);
  ok('overlapping horizons: Newey-West at lag h−1 is several times the naive OLS error', rOv.slopeSe / rOv.slopeSeOls > 2.5);

  const phi = 0.5;
  const ar: number[] = [];
  let prev = 0;
  for (let i = 0; i < 20000; i += 1) {
    prev = phi * prev + normal();
    ar.push(prev);
  }
  const expected = Math.pow((2 * phi) / (1 - phi * phi), 2 / 3) * Math.pow(20000, 1 / 3);
  const pw = politisWhite(ar);
  ok(`Politis-White on AR(1) φ=0.5: ${pw.blockLength.toFixed(1)} vs closed form ${expected.toFixed(1)} (±25 %)`, Math.abs(pw.blockLength / expected - 1) < 0.25);
  // The autocorrelation is a correlation: 1 at lag 0, bounded by 1 at every lag, on its own
  // observations — including a short, strongly trending series where an endpoint matters.
  const trending = Array.from({ length: 12 }, (_, i) => i * i - 30);
  const tm = trending.reduce((s, v) => s + v, 0) / trending.length;
  const te = trending.map((v) => v - tm);
  ok('lag-0 autocorrelation is exactly 1', near(laggedProducts(te, 0).acorr, 1, 1e-12));
  ok('every lagged autocorrelation lies in [-1, 1]', Array.from({ length: 11 }, (_, i) => laggedProducts(te, i).acorr).every((r) => Math.abs(r) <= 1 + 1e-12));
  const iid = Array.from({ length: 20000 }, normal);
  ok('Politis-White on white noise: a short block', politisWhite(iid).blockLength < 5);
  ok('Politis-White cutoff on white noise is lag 0', politisWhite(iid).cutoffLag === 0);
  // MA(1) with θ = 0.8: ρ(1) ≈ 0.49, every later lag zero — the cutoff is exactly lag 1.
  const shocks = Array.from({ length: 20001 }, normal);
  const ma1 = Array.from({ length: 20000 }, (_, i) => shocks[i + 1]! + 0.8 * shocks[i]!);
  ok('Politis-White cutoff on an MA(1) is lag 1', politisWhite(ma1).cutoffLag === 1);

  const series = Array.from({ length: 2000 }, () => 0.01 + normal() * 0.02);
  const a = stationaryBootstrap(series, { meanBlockLength: 5, draws: 2000, seed: 20261101 });
  const b = stationaryBootstrap(series, { meanBlockLength: 5, draws: 2000, seed: 20261101 });
  const c = stationaryBootstrap(series, { meanBlockLength: 5, draws: 2000, seed: 1 });
  ok('the same seed gives the same draws, another seed others', a.lowerBound95 === b.lowerBound95 && a.lowerBound95 !== c.lowerBound95);
  const se = 0.02 / Math.sqrt(2000);
  ok('on iid data the 95 % lower bound sits ≈ 1.645 standard errors under the mean', Math.abs((a.estimate - a.lowerBound95) / se - 1.645) < 0.25);
}

// ── PROOF 8 — on the development tape: external invariants ───────────────────────────
console.log('\nProof 8 — the development runs obey invariants the code did not write:');
const cfg = buildBenchConfig();
const tape = prepareCalibrationTape(ROOT, DEVELOPMENT.toMs);
{
  ok('the step-1 tape holds nothing at or after 2023-01-01', tape.points.every((p) => p.timestamp + tape.barMs <= DEVELOPMENT.toMs) &&
    Object.values(tape.tapes).every((at) => at.h4.every((c) => c.timestamp + H4 <= DEVELOPMENT.toMs) && at.daily.every((c) => c.timestamp + DAY <= DEVELOPMENT.toMs)));
  ok("the regime universe is production's five assets", tape.regimeAssets.join(',') === 'BNB,BTC,ETH,SOL,XRP');
}
const runs: Record<string, RunResult> = {};
for (const policy of [T100, R100_0, RPA]) runs[policy.name] = runWindow({ tape, cfg, policy, window: DEVELOPMENT });
{
  for (const [name, run] of Object.entries(runs)) {
    ok(`${name}: exposure stays in [0, 100] and cash ≥ 0 on every bar`, run.bars.every((b) => b.exposurePercent >= -1e-9 && b.exposurePercent <= 100 + 1e-6 && b.cash >= 0));
    ok(`${name}: the last decision is carried, never executed on a verification open`, run.bars[run.bars.length - 1]!.t < DEVELOPMENT.toMs && run.pendingNotExecuted <= 1);
  }
  ok('T100: the gate never answers risk_off_reduction', runs.T100!.bars.every((b) => Object.values(b.gates).every((g) => g !== 'risk_off_reduction')));

  // T100 fully free for two bars in a row: the book is fully invested UP TO production's
  // plumbing floor. Each of the four lines may sit just under 2 points below its nominal weight
  // without any leg clearing the floor (the dead band production accepts and measures), so the
  // structural bound is 100 − 4 × 2 = 92 %, not 100 %. A first version of this proof asserted
  // 97 % and failed on 10 bars of 2021-02 and 2022-08: every one was this dead band.
  const t100 = runs.T100!.bars;
  let freeBars = 0;
  let lowFree = 0;
  for (let i = 1; i < t100.length; i += 1) {
    const allFree = (b: (typeof t100)[number]) => Object.values(b.states).every((s) => s === 'free');
    if (allFree(t100[i]!) && allFree(t100[i - 1]!)) {
      freeBars += 1;
      if (t100[i]!.exposurePercent < 100 - 4 * cfg.minMovementPercent) lowFree += 1;
    }
  }
  ok(`T100: on ${freeBars} bars free after a free bar, realised exposure ≥ 92 % on all (${lowFree} under)`, freeBars > 500 && lowFree === 0);

  // R100/0: a confirmed risk_off empties the book on the next bar, every line being reducible.
  const r = runs['R100/0']!.bars;
  let riskOffChecks = 0;
  let riskOffFails = 0;
  for (let i = 1; i < r.length; i += 1) {
    if (r[i - 1]!.riskOff && r[i]!.riskOff && Object.values(r[i - 1]!.states).every((s) => s !== 'fixed')) {
      riskOffChecks += 1;
      if (r[i]!.exposurePercent > 0.5) riskOffFails += 1;
    }
  }
  ok(`R100/0: ${riskOffChecks} risk_off bars after a reducible risk_off bar, the book is flat on all of them`, riskOffFails === 0);

  // RPA: an excluded line is at 0 the bar after.
  const p = runs.RPA!.bars;
  let excl = 0;
  let exclFails = 0;
  for (let i = 1; i < p.length; i += 1) {
    for (const a of cfg.assets) {
      if (p[i - 1]!.states[a] === 'excluded' && p[i]!.states[a] === 'excluded') {
        excl += 1;
        if (p[i]!.weights[a]! > 0.01) exclFails += 1;
      }
    }
  }
  ok(`RPA: ${excl} line-bars excluded after an excluded bar, every one of them at 0`, excl > 0 && exclFails === 0);
  // THE MEMORY, read off production's sticky timeline: an exclusion ends only on a confirmed
  // bullish bar, and it does not end on range.
  let rpaReleases = 0;
  let rpaBadReleases = 0;
  let rpaHeldThroughRange = 0;
  for (let i = 1; i < p.length; i += 1) {
    for (const a of cfg.assets) {
      const was = p[i - 1]!.policyExcluded.includes(a);
      const is = p[i]!.policyExcluded.includes(a);
      const st = tape.tapes[a]!.stickyByTs.get(p[i]!.t) ?? null;
      if (was && !is) {
        rpaReleases += 1;
        if (!confirmedBullish(st)) rpaBadReleases += 1;
      }
      if (was && is && st?.actionable && st.active === 'range') rpaHeldThroughRange += 1;
    }
  }
  ok(`RPA: ${rpaReleases} remembered exits released, each on a confirmed bullish regime; ${rpaHeldThroughRange} line-bars held out through a confirmed range`,
    rpaReleases > 0 && rpaBadReleases === 0 && rpaHeldThroughRange > 0);

  // THE RE-ENTRY RULE, read off production's sticky timeline rather than off the engine.
  for (const [name, run] of Object.entries(runs)) {
    let releases = 0;
    let badReleases = 0;
    let barredHeld = 0;
    for (let i = 1; i < run.bars.length; i += 1) {
      for (const a of cfg.assets) {
        const was = run.bars[i - 1]!.barred.includes(a);
        const is = run.bars[i]!.barred.includes(a);
        const st = tape.tapes[a]!.stickyByTs.get(run.bars[i]!.t) ?? null;
        if (was && !is) {
          releases += 1;
          if (!confirmedBullish(st)) badReleases += 1;
        }
        if (was && is && run.bars[i]!.weights[a]! > 0.01) barredHeld += 1;
      }
    }
    ok(`${name}: ${releases} post-stop releases, each on a confirmed trend_up or reversal_up; a barred line holds nothing`, badReleases === 0 && barredHeld === 0);
  }

  // THE FRONTIER: split the development run in two at 2022-01-01 — the pending order and the
  // high cross the frontier, and the trajectory is identical to the continuous one.
  const mid = Date.parse('2022-01-01T00:00:00Z');
  const first = runWindow({ tape, cfg, policy: RPA, window: { name: 'development', fromMs: DEVELOPMENT.fromMs, toMs: mid }, unsafeSyntheticWindow: true });
  const second = runWindow({ tape, cfg, policy: RPA, window: { name: 'development', fromMs: mid, toMs: DEVELOPMENT.toMs }, resume: first.finalState, unsafeSyntheticWindow: true });
  const joined = [...first.bars, ...second.bars];
  ok('a run split at a frontier reproduces the continuous run bar for bar (equity and drawdown)',
    joined.length === runs.RPA!.bars.length && joined.every((b, i) => b.equity === runs.RPA!.bars[i]!.equity && b.drawdownPercent === runs.RPA!.bars[i]!.drawdownPercent));
  ok('the pending order crossed the frontier', first.pendingNotExecuted === 1 || first.finalState.pending == null);

  // THE SCORE PATH, end to end: a constant score mapped to 100 % with the risk_off exit must be
  // R100/0, bar for bar — same gate, same allocation, same execution.
  const constantScore = scorePolicy({ name: 'score-constant', toTarget: () => 100, rebalanceThresholdPoints: 0, riskOffForcesZero: true });
  const viaScore = runWindow({ tape, cfg, policy: constantScore, window: DEVELOPMENT, scoreAt: () => 1 });
  ok('a constant SCORE at 100 % with the risk_off exit reproduces R100/0 bar for bar',
    viaScore.bars.length === runs['R100/0']!.bars.length && viaScore.bars.every((b, i) => b.equity === runs['R100/0']!.bars[i]!.equity));

  const m = computeRunMetrics(runs.T100!, tape.barMs);
  ok('the sub-periods are the two calendar years and chain back to the whole-window return',
    m.bySubperiod.map((p) => p.period).join(',') === '2021,2022' &&
    near((m.bySubperiod.reduce((g, p) => g * (1 + p.returnPercent / 100), 1) - 1) * 100, m.netReturnPercent, 1e-9) &&
    near(Math.max(...m.bySubperiod.map((p) => p.maxDrawdownPercent)), m.maxDrawdownPercent, 1e-12));
  ok('the turnover attribution adds up to the turnover', near(Object.values(m.turnoverByCause).reduce((s, v) => s + v, 0), m.turnover, 1e-9));
  const noStop = runWindow({ tape, cfg, policy: T100, window: DEVELOPMENT, diagnosticWithoutStop: true });
  ok('the diagnostic without stop never exits by stop and never bars a line',
    noStop.bars.every((b) => b.stopExitsDecided.length === 0 && b.barred.length === 0 && Object.values(b.gates).every((g) => g !== 'stop_exit')));
  const d = dailyLogReturns(runs.T100!, tape.barMs);
  ok('daily log returns compound back to the net return', near(Math.exp(d.logReturns.reduce((s, v) => s + v, 0)) - 1, m.netReturnPercent / 100, 1e-9));
  ok('one daily observation per development day', d.logReturns.length === (DEVELOPMENT.toMs - DEVELOPMENT.fromMs) / DAY);
}

// ── PROOF 9 — the components are causal; the study respects the embargo ──────────────
console.log('\nProof 9 — components causal, prerequisite embargoed, normalisation on development only:');
{
  const cut = Date.parse('2022-01-01T00:00:00Z');
  const short = prepareCalibrationTape(ROOT, cut);
  const a = computeComponents(short, cfg.basket);
  const b = computeComponents(tape, cfg.basket);
  let compared = 0;
  let differ = 0;
  for (const [t, v] of a) {
    compared += 1;
    if (JSON.stringify(v) !== JSON.stringify(b.get(t))) differ += 1;
  }
  ok(`truncating the data changes none of the ${compared} earlier component vectors (no look-ahead)`, compared > 2000 && differ === 0);

  const study = runPredictiveStudy({ tape, basket: cfg.basket, components: b, window: DEVELOPMENT });
  for (const h of HORIZONS_DAYS) {
    const s = study.studies.find((x) => x.horizonDays === h && x.component === 'mom_30d')!;
    const maxN = (DEVELOPMENT.toMs - DEVELOPMENT.fromMs) / DAY - h;
    ok(`horizon ${h} d: at most ${maxN} embargoed observations (got ${s.n})`, s.n <= maxN);
  }
  ok('every candidate component is studied at every horizon', study.studies.length === COMPONENT_NAMES.length * HORIZONS_DAYS.length);
  const samples = [...b.entries()].map(([t, v]) => ({ t, v }));
  assert.throws(() => fitNormalisation('mom_30d', samples, VERIFICATION));
  ok('a normalisation cannot be learned on the verification', true);
  const norm = fitNormalisation('mom_30d', samples, DEVELOPMENT);
  ok('a composite score is a weighted z-score', near(compositeScore(b.get(samples[3000]!.t)!, [{ normalisation: norm, weight: 1 }])!, (samples[3000]!.v.mom_30d! - norm.mean) / norm.sd));
  const dec = topDecileMedianExposure(Array.from({ length: 100 }, (_, i) => ({ score: i, exposurePercent: i })));
  ok('top decile median exposure', dec != null && dec.bars === 10 && near(dec.medianExposurePercent, 94.5));
}

// ── PROOF 10 — the three frozen re-entry paths, on a scripted tape ───────────────────
console.log('\nProof 10 — the three re-entry paths of the 17/10 amendment, on synthetic bars:');
{
  const cfgS = buildBenchConfig();
  const ASSETS = ['BNB', 'BTC', 'ETH', 'XRP'];
  const T0 = Date.parse('2030-01-01T00:00:00Z');
  type Script = Array<{ regime: AssetRegime; frozen: boolean; price: number }>;
  /** A tape whose sticky timeline and prices are WRITTEN, not computed. */
  const scripted = (scripts: Record<string, Script>, riskOff: boolean[]): Tape => {
    const n = riskOff.length;
    const points = Array.from({ length: n }, (_, i) => ({
      timestamp: T0 + i * H4,
      at: new Date(T0 + i * H4).toISOString(),
      global: { riskOff: riskOff[i]!, raw: riskOff[i]!, breadthPercent: 0, medianH4Rsi: 50, assetsPresent: 4, assetsExpected: 4, pendingBars: 0 },
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
  const bars = (n: number, regime: AssetRegime, price: number, frozen = false): Script =>
    Array.from({ length: n }, () => ({ regime, frozen, price }));
  const steady = (n: number): Script => bars(n, 'trend_up', 100);
  const run = (tapeS: Tape, policy: Policy) =>
    runWindow({ tape: tapeS, cfg: cfgS, policy, window: { name: 'development', fromMs: T0, toMs: tapeS.nowMs }, unsafeSyntheticWindow: true });
  const N = 24;

  // (a) THE STOP: BTC bought in trend_up; a transition with a 15 % drop fires the stop; then a
  // long CONFIRMED range — the line must stay barred and empty — then a confirmed trend_up.
  const btc: Script = [...bars(4, 'trend_up', 100), ...bars(2, 'trend_up', 85, true), ...bars(10, 'range', 85), ...bars(N - 16, 'trend_up', 90)];
  const s = run(scripted({ BTC: btc, ETH: steady(N), BNB: steady(N), XRP: steady(N) }, Array(N).fill(false)), T100).bars;
  const stopBar = s.findIndex((b) => b.stopExitsDecided.includes('BTC'));
  ok(`the stop fires on BTC in the transition (bar ${stopBar})`, stopBar === 4);
  ok('BTC is sold to zero on the next open and barred', s[stopBar + 1]!.weights.BTC! < 1e-9 && s[stopBar + 1]!.barred.includes('BTC'));
  ok('through ten bars of CONFIRMED range, BTC stays barred and holds nothing',
    s.slice(6, 16).every((b) => b.barred.includes('BTC') && b.weights.BTC! < 1e-9 && b.states.BTC === 'stopped'));
  // Bought back with ALL the cash there is: after the stop's loss the other lines weigh a little
  // over nominal, each by less than the 2 % floor, so production's planner does not trim them.
  ok('the first confirmed trend_up releases it, and it is bought back on the next open with all the cash',
    !s[16]!.barred.includes('BTC') && s[17]!.weights.BTC! > 25 && s[17]!.cash < 1 && s[17]!.executedCause === 'release_after_stop');

  // (b) RPA: BTC confirmed trend_down → out; then a confirmed range — still out, the exit is
  // remembered; then a confirmed reversal_up — back in.
  const btc2: Script = [...bars(3, 'trend_up', 100), ...bars(4, 'trend_down', 100), ...bars(8, 'range', 100), ...bars(N - 15, 'reversal_up', 100)];
  const r = run(scripted({ BTC: btc2, ETH: steady(N), BNB: steady(N), XRP: steady(N) }, Array(N).fill(false)), RPA).bars;
  ok('RPA holds BTC while trend_up, takes it out on the confirmed trend_down', r[2]!.weights.BTC! > 30 && r[3]!.states.BTC === 'excluded' && r[4]!.weights.BTC! < 1e-9);
  ok('through eight bars of confirmed range the exit is remembered: BTC excluded, at zero, its share in cash',
    r.slice(7, 15).every((b) => b.policyExcluded.includes('BTC') && b.states.BTC === 'excluded' && b.weights.BTC! < 1e-9) &&
    r.slice(8, 15).every((b) => b.exposurePercent < 68.5));
  ok('a confirmed reversal_up brings it back on the next open', !r[15]!.policyExcluded.includes('BTC') && r[16]!.weights.BTC! > 30);

  // (c) R100/0: a confirmed global risk_off empties the book; its end brings it back to 100 %.
  const ro = Array.from({ length: N }, (_, i) => i >= 5 && i < 11);
  const r0 = run(scripted({ BTC: steady(N), ETH: steady(N), BNB: steady(N), XRP: steady(N) }, ro), R100_0).bars;
  ok('R100/0 is invested before the risk_off', r0[4]!.exposurePercent > 99);
  ok('the book is flat through the risk_off', r0.slice(6, 11).every((b) => b.exposurePercent < 1e-6));
  ok('the bar the risk_off ends the target is 100 % again, and the book is back near 100 % on the next open',
    r0[11]!.policyTargetPercent === 100 && r0[12]!.exposurePercent > 99);
}

// ── PROOF 11 — the pre-registered SCORE variants are the validated ones ───────────────
console.log('\nProof 11 — the six SCORE variants, as validated on 17/10:');
{
  ok('six variants, A/B/C × linear/steps, in pre-registered order',
    VARIANTS.map((v) => v.name).join(',') === 'SCORE-A-linear,SCORE-A-steps,SCORE-B-linear,SCORE-B-steps,SCORE-C-linear,SCORE-C-steps');
  ok('the sets are the validated ones', SCORE_SETS.A.join(',') === 'trend_sma200' && SCORE_SETS.B.join(',') === 'trend_sma200,breadth_net' &&
    SCORE_SETS.C.join(',') === 'trend_sma200,breadth_net,taker_buy_7d');
  ok('the threshold grid is {5, 10, 20}', THRESHOLD_GRID_POINTS.join(',') === '5,10,20');
  ok('linear: z = −1 → 0 %, 0 → 50 %, +1 → 100 %, clamped', TRANSFORMS.linear(-1) === 0 && TRANSFORMS.linear(0) === 50 && TRANSFORMS.linear(1) === 100 && TRANSFORMS.linear(3) === 100);
  ok('steps: 0 / 50 / 100 % at z = −0.5 and +0.5', TRANSFORMS.steps(-0.51) === 0 && TRANSFORMS.steps(-0.5) === 50 && TRANSFORMS.steps(0.49) === 50 && TRANSFORMS.steps(0.5) === 100);
  // The conviction decile pairs the score of bar t with the exposure realised at bar t+1.
  const fake = { bars: Array.from({ length: 21 }, (_, i) => ({ t: i, exposurePercent: i === 0 ? 0 : (i - 1) * 5 })) } as unknown as RunResult;
  const dec = topDecileOfRun(fake, (t) => t);
  ok('the conviction decile reads the exposure of the NEXT bar', dec != null && dec.bars === 2 && near(dec.medianExposurePercent, ((18 + 19) / 2) * 5));
}

console.log(`\n${passed} bench-exposure checks passed.`);
