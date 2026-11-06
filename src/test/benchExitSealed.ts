import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeBundleSha256, sha256Hex, type BundleManifest } from '../calibration/exposure/bundle.js';
import type { BenchCandle } from '../bench/exposure/bundle.js';
import { buildBenchConfig } from '../bench/exposure/config.js';
import { runWindow, type RunResult } from '../bench/exposure/engine.js';
import { T100 } from '../bench/exposure/policy.js';
import { buildTape, calibrationUniverse, firstPrefixDivergence, prepareExitDevelopmentTape, productionUniverses, universeOfParts } from '../bench/exposure/tape.js';
import { ClosedWindowError, EXIT_CONTINUOUS, EXIT_DEVELOPMENT, EXIT_SEALED, SEAL_INSTANT_MS, VALIDATION, assertMeasurable, type Window } from '../bench/exposure/windows.js';
import { buildDailyTable } from '../bench/exit/daily.js';
import {
  checkSealedOpeningConditions,
  isGenuineSealedOpening,
  sealedFreezeDigest,
  type SealedFreeze,
  type SealedOpeningEnv,
} from '../bench/exit/opening.js';
import { developmentBlockLengths, sealedPolicyRuns, sealedPrefixChecks, shapeSealedSummary } from '../bench/exit/run.js';
import {
  certifySealedPart,
  dailyPrefixDivergence,
  drawdownSpan,
  loadSealedFingerprint,
  measureSealedWindow,
  mergeUniverses,
  sealedVerdict,
  sliceRun,
  trajectoryPrefixDivergence,
  type SealedFingerprint,
} from '../bench/exit/sealed.js';

/**
 * THE PROOFS OF THE SEALED VALIDATION (protocol `docs/PROTOCOLE-SORTIE-v0.4.md`, §16), written and
 * run BEFORE the freeze and before the single opening. Synthetic data, and one REHEARSAL on the
 * consumed calibration: the whole opening pipeline — a sealed-shaped bundle written from real
 * candles, certified against its own fingerprint, merged, prefix-tested, replayed continuously,
 * sliced, measured, shaped — with 2023-01-01 playing the seal and 2024-07-01 the end. Everything it
 * reads was consumed by v0.3; nothing here reads the sealed window.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ok: ${label}`);
}
const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) <= tol;
const H4 = 4 * 3_600_000;
const DAY = 86_400_000;
const T0 = Date.parse('2030-01-01T00:00:00Z');

// ── PROOF 1 — the window gate and the token ──────────────────────────────────────────
console.log('Proof 1 — the continuous window opens only on a genuine sealed opening:');
{
  assert.throws(() => assertMeasurable(EXIT_CONTINUOUS), ClosedWindowError);
  ok('"exit-continuous" without a token is refused', true);
  const lookAlike = { evidence: { openedAt: 'x', freezeCommit: 'x', freezeDecisionsSha256: 'x', head: 'x', remoteBranch: 'x', remoteHead: 'x', sourceTreeSha: 'x', depsLockSha: 'x' } };
  assert.throws(() => assertMeasurable(EXIT_CONTINUOUS, undefined, lookAlike), ClosedWindowError);
  ok('a structural look-alike of the token is refused', !isGenuineSealedOpening(lookAlike));
  assert.throws(() => assertMeasurable(EXIT_SEALED), ClosedWindowError);
  ok('"exit-sealed" is a slice, never a run\'s own window', true);
  ok('the continuous window runs from the exit development\'s start to the end of the validation', EXIT_CONTINUOUS.fromMs === EXIT_DEVELOPMENT.fromMs && EXIT_CONTINUOUS.toMs === VALIDATION.toMs);
  ok('the sealed slice is [2024-07-01, 2026-06-01), 700 days', EXIT_SEALED.fromMs === SEAL_INSTANT_MS && (EXIT_SEALED.toMs - EXIT_SEALED.fromMs) / DAY === 700);
  const sealedModule = await import('../bench/exit/opening.js');
  ok('exit/opening.ts exports no class', Object.values(sealedModule).every((v) => typeof v !== 'function' || !/^class\b/.test(Function.prototype.toString.call(v))));
  const writers: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && /ISSUED_SEALED\.add\(/.test(readFileSync(p, 'utf8'))) writers.push(p);
    }
  };
  walk(path.join(process.cwd(), 'src', 'bench'));
  ok('only exit/opening.ts ever adds to the registry of sealed openings', writers.length === 1 && writers[0]!.endsWith(path.join('bench', 'exit', 'opening.ts')));

  const freezeBody = {
    schema_version: 1 as const,
    kind: 'bench-exit-sealed-freeze' as const,
    protocol: { file: 'p', git_blob_sha: 'P' },
    source_tree_sha: 'S',
    deps_lock_sha: 'L',
    bench_config_sha256: 'C',
    sealed_fingerprint: { file: 'f', git_blob_sha: 'F', bundle_id: 'b', bundle_sha256: 'B', manifest_sha256: 'M' },
  };
  const freeze: SealedFreeze = { ...freezeBody, decisions_sha256: sealedFreezeDigest(freezeBody) };
  const clean: SealedOpeningEnv = {
    freezeCommitted: true, dirtyPaths: [], sourceTreeSha: 'S', depsLockSha: 'L', protocolBlobSha: 'P', fingerprintBlobSha: 'F',
    freezeCommit: 'c', head: 'h', branch: 'feat/x', remoteHead: 'h', headIsPublic: true, recordOnDisk: false, recordCommits: [],
  };
  checkSealedOpeningConditions(freeze, clean);
  ok('every condition met: the opening may proceed', true);
  const refusals: Array<[string, Partial<SealedOpeningEnv>, RegExp]> = [
    ['a record already on disk', { recordOnDisk: true }, /already opened once/],
    ['a record in the history', { recordCommits: ['abc'] }, /in the history/],
    ['a freeze not committed', { freezeCommitted: false }, /not committed/],
    ['a dirty tree', { dirtyPaths: ['M src/x.ts'] }, /not clean/],
    ['another src tree', { sourceTreeSha: 'X' }, /src\//],
    ['another lockfile', { depsLockSha: 'X' }, /package-lock/],
    ['another protocol', { protocolBlobSha: 'X' }, /protocol/],
    ['another fingerprint', { fingerprintBlobSha: 'X' }, /fingerprint/],
    ['no remote branch', { remoteHead: null }, /push the freeze/],
    ['HEAD not pushed', { headIsPublic: false }, /push the freeze/],
  ];
  for (const [label, patch, re] of refusals) {
    assert.throws(() => checkSealedOpeningConditions(freeze, { ...clean, ...patch }), re);
    ok(`refused: ${label}`, true);
  }
}

// ── PROOF 2 — the sealed part, certified against a fingerprint ───────────────────────
type RawRow = { t: number; o: number; h: number; l: number; c: number; v: number; closeTime: number; qv: number; trades: number; takerBuyBase: number; takerBuyQuote: number };

/** Writes a producer-shaped bundle of `series` into `dir`, and returns its fingerprint. */
function writeSealedBundle(dir: string, bundleId: string, fetchStart: number, asOf: number, series: Record<string, BenchCandle[]>): SealedFingerprint {
  mkdirSync(path.join(dir, 'raw'), { recursive: true });
  const entries = Object.entries(series).map(([key, candles]) => {
    const [symbol, timeframe] = key.split(':') as [string, string];
    const step = timeframe === '1d' ? DAY : H4;
    const rows: RawRow[] = candles.map((c) => ({ t: c.timestamp, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, closeTime: c.timestamp + step - 1, qv: c.quoteVolume, trades: c.trades, takerBuyBase: 0, takerBuyQuote: c.takerBuyQuote }));
    const gaps: Array<{ afterOpenTime: string; beforeOpenTime: string; missingBars: number }> = [];
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i]!.t - rows[i - 1]!.t > step) gaps.push({ afterOpenTime: new Date(rows[i - 1]!.t).toISOString(), beforeOpenTime: new Date(rows[i]!.t).toISOString(), missingBars: (rows[i]!.t - rows[i - 1]!.t) / step - 1 });
    }
    const file = `raw/${symbol}-${timeframe}.json`;
    const text = JSON.stringify(rows);
    writeFileSync(path.join(dir, file), text);
    const first = rows[0]!.t;
    const last = rows[rows.length - 1]!.t;
    return {
      symbol, timeframe, file, rows: rows.length,
      first_open_time: new Date(first).toISOString(), first_close_time: new Date(first + step - 1).toISOString(),
      last_open_time: new Date(last).toISOString(), last_close_time: new Date(last + step - 1).toISOString(),
      duplicate_open_times_returned_by_source: 0, duplicates_ok: true, strictly_ordered: true, gap_count: gaps.length, gaps,
      discarded_by_admissibility: 0, sha256: sha256Hex(Buffer.from(text)),
    };
  });
  const manifest = {
    schema_version: 1, bundle_id: bundleId, source: 'https://data-api.binance.vision', producer_repository: 'x',
    fetch_start: new Date(fetchStart).toISOString(), evaluation_start: new Date(fetchStart + H4).toISOString(), as_of_exclusive: new Date(asOf).toISOString(),
    acquisition_config_sha256: 'a'.repeat(64), producer_source_sha256: 'b'.repeat(64), producer_source_files: [],
    generation_git_commit: null, generation_git_commit_authority: 'x', series: entries, bundle_sha256: '',
  } as unknown as BundleManifest;
  manifest.bundle_sha256 = computeBundleSha256(manifest);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(path.join(dir, 'manifest.json'), bytes);
  return {
    schema_version: 1, kind: 'sealed-bundle-fingerprint', bundle_id: bundleId,
    fetch_start: manifest.fetch_start, evaluation_start: manifest.evaluation_start, as_of_exclusive: manifest.as_of_exclusive,
    acquisition_config_sha256: manifest.acquisition_config_sha256, producer_source_sha256: manifest.producer_source_sha256,
    bundle_sha256: manifest.bundle_sha256, manifest_sha256: sha256Hex(Buffer.from(bytes)),
    files: entries.map((e) => ({ file: e.file, sha256: e.sha256 })),
  };
}

const candle = (t: number, price: number): BenchCandle => ({ timestamp: t, open: price, high: price, low: price, close: price, volume: 1, quoteVolume: 1, trades: 1, takerBuyQuote: 0.5 });

console.log('\nProof 2 — the sealed part is certified byte for byte against the committed fingerprint:');
{
  const sandbox = mkdtempSync(path.join(tmpdir(), 'bench-sealed-'));
  const end = T0 + 10 * H4;
  const make = (name: string, extra: BenchCandle[] = []): { dir: string; fp: SealedFingerprint } => {
    const dir = path.join(sandbox, name);
    const fp = writeSealedBundle(dir, 'sealed-test', T0, end, { 'SOLUSDT:4h': [...Array.from({ length: 10 }, (_, i) => candle(T0 + i * H4, 100 + i)), ...extra] });
    return { dir, fp };
  };
  const good = make('good');
  ok('a part matching its fingerprint is certified', certifySealedPart(good.fp, good.dir).series.get('SOLUSDT:4h')!.length === 10);
  ok('the committed fingerprint of the real sealed part is readable and pins its manifest', /^[0-9a-f]{64}$/.test(loadSealedFingerprint(process.cwd()).manifest_sha256));

  const manifestPath = path.join(good.dir, 'manifest.json');
  const original = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, original.replace('"producer_repository": "x"', '"producer_repository": "y"'));
  assert.throws(() => certifySealedPart(good.fp, good.dir), /manifest digest/);
  ok('one byte changed in the manifest is refused before it is parsed', true);
  writeFileSync(manifestPath, original);

  const filePath = path.join(good.dir, 'raw', 'SOLUSDT-4h.json');
  const rows = JSON.parse(readFileSync(filePath, 'utf8')) as RawRow[];
  rows[3]!.c = 999;
  writeFileSync(filePath, JSON.stringify(rows));
  assert.throws(() => certifySealedPart(good.fp, good.dir), /digest/);
  ok('a candle file changed after signing is refused on its digest', true);

  const other = make('other');
  assert.throws(() => certifySealedPart({ ...other.fp, bundle_sha256: 'f'.repeat(64) }, other.dir), /manifest bundle_sha256|bundle_sha256/);
  ok('a fingerprint pinning another bundle_sha256 is refused', true);

  const beyond = make('beyond', [candle(end, 1)]);
  assert.throws(() => certifySealedPart(beyond.fp, beyond.dir), /past its horizon|inadmissible/);
  ok('a self-consistent part carrying a candle at its horizon is refused on the row', true);
  rmSync(sandbox, { recursive: true, force: true });
}

// ── PROOF 3 — the merge ──────────────────────────────────────────────────────────────
console.log('\nProof 3 — calibration then sealed, the overlapping bar checked identical:');
{
  const split = T0 + 5 * H4;
  const cal = { BTC: { daily: [], h4: Array.from({ length: 5 }, (_, i) => candle(T0 + i * H4, 100 + i)) } };
  const sealed = { BTC: { daily: [], h4: Array.from({ length: 6 }, (_, i) => candle(T0 + (4 + i) * H4, 104 + i)) } };
  const merged = mergeUniverses(cal, sealed, split);
  ok('the overlap is dropped, the rest appended, in order', merged.BTC!.h4.length === 10 && merged.BTC!.h4.every((c, i) => c.timestamp === T0 + i * H4));
  const diverging = { BTC: { daily: [], h4: [candle(T0 + 4 * H4, 1), candle(split, 2)] } };
  assert.throws(() => mergeUniverses(cal, diverging, split), /differs from the calibration/);
  ok('an overlap candle that differs from the calibration is refused', true);
  const foreign = { BTC: { daily: [], h4: [candle(T0 - H4, 1), candle(split, 2)] } };
  assert.throws(() => mergeUniverses(cal, foreign, split), /not in the calibration/);
  ok('an overlap candle absent from the calibration is refused', true);
  assert.throws(() => mergeUniverses(cal, { ETH: sealed.BTC }, split), /carries/);
  ok('different assets are refused', true);
}

// ── PROOF 4 — the slice, the drawdown dates, the verdict ─────────────────────────────
console.log('\nProof 4 — the window is a rebased slice of the continuous trajectory:');
{
  // 12 bars; the split at bar 6. Equity written; the trajectory high (1200) is BEFORE the split.
  const equity = [1000, 1100, 1200, 1150, 900, 950, 1000, 800, 1000, 1300, 1250, 1400];
  let high = 0;
  const run = {
    policy: 'X', openingEquity: 1000, pendingNotExecuted: 0, finalState: {} as RunResult['finalState'],
    window: { name: 'development', fromMs: T0, toMs: T0 + 12 * H4 } as Window,
    bars: equity.map((e, i) => {
      high = Math.max(high, e);
      return { t: T0 + i * H4, equity: e, cash: e / 10, tradedNotional: 10, fees: 1, slippageCost: 0.5, exposurePercent: 90, drawdownPercent: ((high - e) / high) * 100, stopExitsDecided: [], ruleExitsDecided: [], ruleEntriesDecided: [], ruleOut: [], weights: {}, suppressed: {}, executedCause: null, capacityShortfallPercent: 0, overExposurePercent: 0 };
    }),
  } as unknown as RunResult;
  const window: Window = { name: 'exit-sealed', fromMs: T0 + 6 * H4, toMs: T0 + 12 * H4 };
  const s = sliceRun(run, window, 1000);
  ok('the slice holds the bars opened in the window', s.bars.length === 6 && s.bars[0]!.t === T0 + 6 * H4);
  ok('rebased: the 4h close before the window (950) becomes 1 000 $', s.openingEquity === 1000 && near(s.bars[0]!.equity, 1000 * 1000 / 950));
  ok('dollars scale with it, percentages do not', near(s.bars[0]!.fees, 1000 / 950) && s.bars[1]!.drawdownPercent === run.bars[7]!.drawdownPercent);
  const dd = drawdownSpan(run, window.fromMs, window.toMs, H4);
  ok('the continuous drawdown is read from the trajectory high, set before the window', near(dd.maxDrawdownPercent, (1 - 800 / 1200) * 100) && dd.peakCloseMs === T0 + 3 * H4 && dd.troughCloseMs === T0 + 8 * H4);
  ok('its recovery is the first close back at the high', dd.recoveredCloseMs === T0 + 10 * H4);
  const own = drawdownSpan(run, window.fromMs, window.toMs, H4, true);
  ok('from the window\'s own high (1000 at bar 6) it is smaller', near(own.maxDrawdownPercent, 20) && own.peakCloseMs === T0 + 7 * H4 && own.troughCloseMs === T0 + 8 * H4 && own.recoveredCloseMs === T0 + 9 * H4);

  ok('verdict: positive and ahead of E1 → Go pilote testnet', sealedVerdict(12, 5).verdict === 'Go pilote testnet');
  ok('verdict: positive but behind E1 → Non retenue', sealedVerdict(12, 15).verdict === 'Non retenue');
  ok('verdict: ahead of E1 but negative → Non retenue', sealedVerdict(-1, -20).verdict === 'Non retenue');
  ok('verdict: exactly E1, or exactly zero, is not enough (strict)', sealedVerdict(5, 5).verdict === 'Non retenue' && sealedVerdict(0, -3).verdict === 'Non retenue');
}

// ── PROOF 5 — the prefix tests detect a divergence ───────────────────────────────────
console.log('\nProof 5 — the prefix tests catch a single changed field:');
{
  const cfg = buildBenchConfig();
  const tape = prepareExitDevelopmentTape(process.cwd());
  const table = buildDailyTable(tape, cfg.basket);
  const cut = Date.parse('2022-01-01T00:00:00Z');
  const truncated = { ...table, rows: table.rows.filter((r) => r.closeMs <= cut) };
  ok('a table and its own prefix agree', dailyPrefixDivergence(truncated, table) === null);
  const tampered = { ...truncated, rows: truncated.rows.map((r, i) => (i === 300 ? { ...r, index: r.index * 1.000001 } : r)) };
  ok('one daily index changed is caught', dailyPrefixDivergence(tampered, table) !== null);
  const runA = runWindow({ tape, cfg, policy: T100, window: { name: 'development', fromMs: EXIT_DEVELOPMENT.fromMs, toMs: cut }, unsafeSyntheticWindow: true });
  const runB = runWindow({ tape, cfg, policy: T100, window: { name: 'development', fromMs: EXIT_DEVELOPMENT.fromMs, toMs: EXIT_DEVELOPMENT.toMs }, unsafeSyntheticWindow: true });
  ok('a shorter replay is the prefix of a longer one, bar for bar', trajectoryPrefixDivergence(runA, runB, cut) === null);
  const bent = { ...runB, bars: runB.bars.map((b, i) => (i === 100 ? { ...b, fees: b.fees + 1e-12 } : b)) };
  ok('one fee changed by 1e-12 on one bar is caught', trajectoryPrefixDivergence(runA, bent, cut) !== null);
}

// ── PROOF 6 — THE REHEARSAL, on the consumed calibration ─────────────────────────────
console.log('\nProof 6 — rehearsal of the whole opening on consumed data (2023-01-01 plays the seal):');
{
  const ROOT = process.cwd();
  const cfg = buildBenchConfig();
  const split = Date.parse('2023-01-01T00:00:00Z');
  const end = SEAL_INSTANT_MS;
  const fetchStart = split - H4;
  const whole = calibrationUniverse(ROOT, end);
  const series: Record<string, BenchCandle[]> = {};
  for (const [asset, u] of Object.entries(whole)) {
    series[`${asset}USDT:1d`] = u.daily.filter((c) => c.timestamp >= fetchStart && c.timestamp + DAY <= end);
    series[`${asset}USDT:4h`] = u.h4.filter((c) => c.timestamp >= fetchStart);
  }
  const sandbox = mkdtempSync(path.join(tmpdir(), 'bench-rehearsal-'));
  const fp = writeSealedBundle(sandbox, 'rehearsal-sealed', fetchStart, end, series);
  const part = certifySealedPart(fp, sandbox);
  const merged = mergeUniverses(calibrationUniverse(ROOT, split), universeOfParts([part], end), split);
  const { tradable } = productionUniverses();
  const fullTape = buildTape(merged, tradable, end);
  const devTape = buildTape(calibrationUniverse(ROOT, split), tradable, split);
  const reference = prepareExitDevelopmentTape(ROOT);
  ok('the merged tape IS the certified calibration tape, bar for bar', fullTape.points.length === reference.points.length && firstPrefixDivergence(reference, fullTape) === null);

  const fullTable = buildDailyTable(fullTape, cfg.basket);
  const devTable = buildDailyTable(devTape, cfg.basket);
  const continuousWindow: Window = { name: 'exit-continuous', fromMs: EXIT_DEVELOPMENT.fromMs, toMs: end };
  const devWindow: Window = { name: 'exit-development', fromMs: EXIT_DEVELOPMENT.fromMs, toMs: split };
  const continuous = sealedPolicyRuns(fullTape, cfg, fullTable, continuousWindow, { unsafeSyntheticWindow: true });
  const dev = sealedPolicyRuns(devTape, cfg, devTable, devWindow, { unsafeSyntheticWindow: true });
  const checks = sealedPrefixChecks({ devTape, fullTape, devTable, fullTable, dev, continuous, splitMs: split });
  ok(`the three prefix tests pass (${checks.length})`, checks.length === 3);

  const published = JSON.parse(readFileSync(path.join(ROOT, 'out', 'bench-exit', 'development', 'summary.json'), 'utf8')) as {
    policies: Array<{ policy: string; closing_equity: number; by_calendar_year: Array<{ year: string; return_percent: number }> }>;
  };
  for (const name of ['S4', 'E0', 'E1', 'TC44']) {
    const value = Number(continuous[name]!.bars[continuous[name]!.bars.length - 1]!.equity.toFixed(6));
    const pub = published.policies.find((p) => p.policy === name)!.closing_equity;
    ok(`the continuous ${name} on the merged tape closes at v0.3's published ${pub}`, value === pub);
  }

  const blocks = developmentBlockLengths(dev, devTape.barMs);
  ok('Politis-White gives a block length for each comparator', blocks.length === 3 && blocks.every((b) => b.block_length >= 1));
  const m = measureSealedWindow({
    continuous, candidate: 'S4', comparators: ['E1', 'E0', 'TC44'], verdictComparator: 'E1', barMs: fullTape.barMs, table: fullTable,
    startMs: EXIT_DEVELOPMENT.fromMs, window: { name: 'exit-sealed', fromMs: split, toMs: end }, rebaseTo: 1000,
    blockLengths: Object.fromEntries(blocks.map((b) => [b.comparator, b.block_length])),
  });
  const s4 = m.policies.find((p) => p.name === 'S4')!;
  const years = published.policies.find((p) => p.policy === 'S4')!.by_calendar_year;
  const chained = ((1 + years.find((y) => y.year === '2023')!.return_percent / 100) * (1 + years.find((y) => y.year === '2024')!.return_percent / 100) - 1) * 100;
  ok(`the S4 slice's net return (${s4.metrics.base.netReturnPercent.toFixed(4)} %) chains v0.3's 2023 and 2024 returns (${chained.toFixed(4)} %)`, near(s4.metrics.base.netReturnPercent, chained, 1e-4));
  ok('the slice starts from 1 000 $ and its capital is 1 000 × (1 + net)', s4.metrics.base.openingEquity === 1000 && near(s4.metrics.base.closingEquity, 1000 * (1 + s4.metrics.base.netReturnPercent / 100), 1e-6));
  ok('calendar years of the slice: 2023, 2024', s4.metrics.base.bySubperiod.map((p) => p.period).join(',') === '2023,2024');
  ok('the episode still open at the split (from 2021-11) is carried with its readings', m.episodes.length >= 1 && m.episodes[0]!.startMs === Date.parse('2021-11-09T00:00:00Z') && s4.metrics.episodes.length === m.episodes.length);
  ok('the bootstrap is computed against each comparator on the window\'s days', m.bootstrap.length === 3 && m.bootstrap.every((b) => b.days === (end - split) / DAY));
  ok(`a verdict is applied (${m.verdict.verdict})`, m.verdict.verdict === sealedVerdict(s4.metrics.base.netReturnPercent, m.policies.find((p) => p.name === 'E1')!.metrics.base.netReturnPercent).verdict);
  const shaped = shapeSealedSummary(m, fullTape.barMs) as { policies: Array<{ policy: string; closing_equity: number; continuous_drawdown: { peak_close: string } }>; verdict: { verdict: string } };
  ok('the summary shapes every policy with its drawdown dates and the verdict', shaped.policies.length === 4 && shaped.policies.every((p) => typeof p.continuous_drawdown.peak_close === 'string') && shaped.verdict.verdict === m.verdict.verdict);
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed.`);
