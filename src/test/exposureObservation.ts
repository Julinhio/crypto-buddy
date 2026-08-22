import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { toRegimeJournal, type AssetRegime, type RegimeJournal } from '../market/regime.js';
import { prepareTape } from '../calibration/exposure/tape.js';
import { ARMS } from '../calibration/exposure/arms.js';
import { bandFor, projectOntoBand, readContext } from '../calibration/exposure/controller.js';
import { canonicalJson } from '../provenance/artefacts.js';
import { contextOf, controllerUniverse, regimePointFromJournal } from '../observation/exposure/context.js';
import { allocationView, buildCycles, defaultBuildOptions } from '../observation/exposure/cycles.js';
import { buildBars, buildIntrabar } from '../observation/exposure/bars.js';
import { buildStopFacts } from '../observation/exposure/stops.js';
import { buildSnapshot, instantsAtOrAfter } from '../observation/exposure/snapshot.js';
import { parseWindow, WindowError, type ObservationWindow } from '../observation/exposure/window.js';
import type { DecisionRowRead, ExecutionRowRead, ObservationRowRead, RawWindow } from '../observation/exposure/read.js';

/**
 * THE PROOFS OF THE EXPOSURE OBSERVER.
 *
 * No network, no database, no LLM, no clock of its own. The live journal is replaced by
 * fixtures; the one place real data is used is the calibration bundle, and only to prove that
 * a journaled regime rehydrates into exactly the reading production's own controller produces.
 *
 * Ordered by what they defend. The three that matter most are the ones this brick would fail
 * silently: dropping the cycles the model never answered, counting one stop episode as twenty
 * rows, and letting a band leak into a path the protocol says must stay band-agnostic.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

const ROOT = process.cwd();
const UNIVERSE = controllerUniverse();
const OPTIONS = defaultBuildOptions(UNIVERSE);

// ── fixtures ─────────────────────────────────────────────────────────────────────────

function journalOf(
  barAt: string,
  regimes: Record<string, AssetRegime>,
  opts: { riskOff?: boolean; medianH4Rsi?: number | null } = {},
): RegimeJournal {
  const riskOff = opts.riskOff ?? false;
  const assets: RegimeJournal['assets'] = {};
  for (const [asset, regime] of Object.entries(regimes)) {
    assets[asset] = {
      effective: riskOff ? 'risk_off' : regime,
      regime,
      raw: regime,
      pendingRegime: null,
      pendingBars: 0,
      bearish: false,
      // The controller never reads the signals; a plausible shape is enough to rehydrate.
      signals: { close: 100 } as RegimeJournal['assets'][string]['signals'],
    };
  }
  return {
    version: 'r1',
    barAt,
    global: {
      riskOff,
      raw: riskOff,
      breadthPercent: 0,
      medianH4Rsi: opts.medianH4Rsi ?? 50,
      assetsPresent: Object.keys(regimes).length,
      assetsExpected: Object.keys(regimes).length,
      pendingBars: 0,
    },
    assets,
  };
}

const ALL_RANGE: Record<string, AssetRegime> = { BTC: 'range', ETH: 'range', BNB: 'range', XRP: 'range' };
const ALL_UP: Record<string, AssetRegime> = {
  BTC: 'trend_up',
  ETH: 'trend_up',
  BNB: 'trend_up',
  XRP: 'trend_up',
};

interface DecisionFixture {
  id: number;
  at: string;
  status?: string;
  barAt?: string;
  regimes?: Record<string, AssetRegime>;
  deployed?: number | null;
  positions?: Array<{ asset: string; qty: number }>;
  target?: Record<string, number> | null;
  applied?: Record<string, number> | null;
}

function decisionRow(f: DecisionFixture): DecisionRowRead {
  const status = f.status ?? 'decided';
  return {
    id: f.id,
    created_at: f.at,
    status,
    skip_reason: null,
    prompt_version: 'v5',
    model: 'test-model',
    git_sha: null,
    action_type: status === 'decided' ? 'hold' : null,
    confidence: status === 'decided' ? 'medium' : null,
    clamped: status === 'decided' ? false : null,
    clamp_reason: null,
    applied_divergence_cause: null,
    target_allocation: f.target === undefined ? { BTC: 10, ETH: 5, BNB: 0, XRP: 0, USDT: 85 } : f.target,
    applied_allocation: f.applied === undefined ? (f.target === undefined ? { BTC: 10, ETH: 5, BNB: 0, XRP: 0, USDT: 85 } : f.target) : f.applied,
    intent_allocation: null,
    regime: f.barAt == null ? null : journalOf(f.barAt, f.regimes ?? ALL_RANGE),
    market_context: {
      generatedAt: f.at,
      account: {
        portfolio: {
          deployedPercent: f.deployed === undefined ? 15 : f.deployed,
          equity: 1000,
          cash: 850,
          reserveAsset: 'USDT',
          positions: (f.positions ?? []).map((p) => ({
            asset: p.asset,
            qty: p.qty,
            price: 100,
            weightPercent: 10,
            priceStale: false,
          })),
        },
      },
    },
  };
}

let observationId = 0;
interface VerdictFixture {
  decisionId: number;
  asset: string;
  barAt: string | null;
  gate?: string;
  wouldFire?: boolean;
  armed?: boolean;
  drawdown?: number | null;
  /** When the verdict was WRITTEN — the column that makes a straddling cutoff visible. */
  writtenAt?: string;
}

function observationRow(f: VerdictFixture): ObservationRowRead {
  observationId += 1;
  const wouldFire = f.wouldFire ?? false;
  return {
    id: observationId,
    decision_id: f.decisionId,
    created_at: f.writtenAt ?? '2026-08-12T00:00:30.000Z',
    asset: f.asset,
    bar_at: f.barAt,
    actionable: !wouldFire,
    confirmed_regime: 'range',
    raw_regime: 'range',
    run_length: 3,
    label_run: 3,
    risk_off: false,
    stop_armed: f.armed ?? wouldFire,
    stop_would_fire: wouldFire,
    stop_threshold_percent: 10,
    peak_price: wouldFire ? 120 : null,
    price: 100,
    drawdown_from_peak_percent: f.drawdown ?? (wouldFire ? -16.7 : null),
    stop_abstained_reason: null,
    gate: f.gate ?? (wouldFire ? 'stop_exit' : 'actionable'),
    gate_reason: 'fixture',
    order_side: null,
    order_notional: null,
    order_verdict: null,
    order_reason: null,
    leg_side: null,
    leg_notional: null,
    leg_verdict: null,
    leg_reason: null,
    atomic_refusal: false,
    atomic_trigger_asset: null,
  };
}

let executionId = 0;
function intentRow(
  decisionId: number,
  symbol: string,
  side: 'buy' | 'sell',
  qty: number,
  price = 100,
  createdAt = '2026-08-12T00:00:30.000Z',
): ExecutionRowRead {
  executionId += 1;
  return {
    id: executionId,
    decision_id: decisionId,
    created_at: createdAt,
    symbol,
    side,
    event_type: 'intent',
    validation_status: 'executed',
    validation_reason: 'fixture',
    requested_qty: qty,
    executed_qty: null,
    valuation_price: price,
    fee: 0,
    ledger_base_delta: side === 'buy' ? qty : -qty,
    ledger_quote_delta: side === 'buy' ? -qty * price : qty * price,
    execution_outcome: null,
    exchange_avg_price: null,
    intent_execution_id: null,
  };
}

function windowOf(from: string, to: string): ObservationWindow {
  return { fromMs: Date.parse(from), toMs: Date.parse(to), from, toExclusive: to };
}

// ── PROOF 1 — the journal rehydrates into production's own reading ───────────────────
console.log('Proof 1 — a journaled regime rehydrates into exactly the reading the controller produces:');
{
  const { shared } = prepareTape(ROOT);
  const assets = [...shared.cfg.assets];
  // Spread across the whole timeline rather than the first N bars: the interesting points are
  // the ones where hysteresis has flipped a label and where an asset is missing.
  const step = Math.max(1, Math.floor(shared.points.length / 400));
  let compared = 0;
  let identical = 0;
  for (let i = 0; i < shared.points.length; i += step) {
    const point = shared.points[i]!;
    const rehydrated = regimePointFromJournal(toRegimeJournal(point));
    const before = readContext(point, assets);
    const after = readContext(rehydrated, assets);
    compared += 1;
    if (JSON.stringify(before) === JSON.stringify(after)) identical += 1;
  }
  ok(`${compared} bars journaled and rehydrated`, compared > 100);
  ok('every rehydrated reading is identical to the original', identical === compared);

  // The bar identity survives the round trip too — it is the key every statistic groups by.
  const sample = shared.points[Math.floor(shared.points.length / 2)]!;
  const back = regimePointFromJournal(toRegimeJournal(sample));
  ok('the 4h bar timestamp round-trips exactly', back.timestamp === sample.timestamp && back.at === sample.at);
}

// ── PROOF 2 — the historical bands, used ONLY as a test vector ───────────────────────
console.log('Proof 2 — the historical bands prove the offline path reproduces the pure functions:');
{
  const { shared } = prepareTape(ROOT);
  const assets = [...shared.cfg.assets];
  const step = Math.max(1, Math.floor(shared.points.length / 200));
  let checked = 0;
  let agreed = 0;
  for (let i = 0; i < shared.points.length; i += step) {
    const point = shared.points[i]!;
    const rehydrated = regimePointFromJournal(toRegimeJournal(point));
    for (const policy of Object.values(ARMS)) {
      for (const exposure of [0, 17.5, 40, 72.5, 100]) {
        const live = projectOntoBand(exposure, bandFor(policy, readContext(point, assets).state));
        const offline = projectOntoBand(exposure, bandFor(policy, readContext(rehydrated, assets).state));
        checked += 1;
        if (live === offline) agreed += 1;
      }
    }
  }
  ok(`${checked} band projections compared across the three arms`, checked > 1000);
  ok('the offline computation reproduces every one of them', agreed === checked);
}

// ── PROOF 3 — no band, and no write, anywhere in the observer's module graph ─────────
console.log('Proof 3 — the observer imports no band and writes nothing:');
{
  const graph = moduleGraph(path.join(ROOT, 'src/observation/exposure/observe.ts'));
  ok(`the observer's transitive module graph is ${graph.size} file(s)`, graph.size > 5);

  const armsFile = path.resolve(ROOT, 'src/calibration/exposure/arms.ts');
  ok('arms.ts is NOT reachable from the observer', !graph.has(armsFile));

  // `arms.ts` is the ONLY place an exposure band exists as a VALUE, so keeping it out of the
  // graph is the whole proof. The band FUNCTIONS live in `controller.ts`, which the observer
  // does import — for `readContext`, which knows nothing about bands — so the second check is
  // on call sites rather than on the file: the observer may never invoke one.
  const bandCalls = /\bARMS\b|\bbandFor\s*\(|\bprojectOntoBand\s*\(|\bapplyRsiBrake\s*\(/;
  const callers = sourceFiles(path.join(ROOT, 'src/observation')).filter((file) =>
    bandCalls.test(readFileSync(file, 'utf8')),
  );
  ok(
    `the observer never calls a band function (${callers.map((f) => path.basename(f)).join(', ') || 'none'})`,
    callers.length === 0,
  );

  // A write can only be reached through a query builder, and a query builder can only start at
  // `.from('<table>')`. So the tight check is not "does any file say `.update(`" — `createHash`
  // says exactly that — but "can any file in the graph build a query at all". Exactly one can.
  const buildsQuery = /\.from\('/;
  const queryFiles = [...graph].filter((file) => buildsQuery.test(readFileSync(file, 'utf8')));
  ok(
    `exactly one file in the whole graph can build a query (${queryFiles.map((f) => path.basename(f)).join(', ')})`,
    queryFiles.length === 1 && path.basename(queryFiles[0]!) === 'read.ts',
  );

  const writeCalls = /\.(insert|upsert|delete|rpc)\s*\(/;
  const observerFiles = sourceFiles(path.join(ROOT, 'src/observation'));
  const writers = observerFiles.filter((file) => writeCalls.test(readFileSync(file, 'utf8')));
  ok(
    `and no file in the observer names a write method (${writers.map((f) => path.basename(f)).join(', ') || 'none'})`,
    writers.length === 0,
  );
}

// ── PROOF 4 — no production path reads the observer ──────────────────────────────────
console.log('Proof 4 — nothing outside the observer imports it or reads its output:');
{
  const all = sourceFiles(path.join(ROOT, 'src'));
  const allowed = new Set([
    path.resolve(ROOT, 'src/test/exposureObservation.ts'),
    ...sourceFiles(path.join(ROOT, 'src/observation')),
  ]);
  const importers = all
    .filter((file) => !allowed.has(file))
    .filter((file) => /observation\/exposure/.test(readFileSync(file, 'utf8')));
  ok(
    `no file outside the observer imports it (${importers.map((f) => path.relative(ROOT, f)).join(', ') || 'none'})`,
    importers.length === 0,
  );

  const readers = all
    .filter((file) => !allowed.has(file))
    .filter((file) => /out\/exposure-observation/.test(readFileSync(file, 'utf8')));
  ok(
    `no file outside the observer reads its artefacts (${readers.map((f) => path.relative(ROOT, f)).join(', ') || 'none'})`,
    readers.length === 0,
  );
}

// ── PROOF 5 — the population is never thinned ────────────────────────────────────────
console.log('Proof 5 — a cycle without a valid model response stays in the population:');
{
  const raw: RawWindow = {
    decisions: [
      decisionRow({ id: 1, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z' }),
      decisionRow({ id: 2, at: '2026-08-12T01:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', status: 'error', target: null, applied: null }),
      decisionRow({ id: 3, at: '2026-08-12T02:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', status: 'parse_failed', target: null, applied: null }),
      decisionRow({ id: 4, at: '2026-08-12T03:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', status: 'skipped', target: null, applied: null, deployed: null }),
    ],
    observations: [],
    executions: [],
  };
  const cycles = buildCycles(raw, OPTIONS);
  ok('every decision row produced exactly one cycle', cycles.length === 4);
  ok('the failed cycles are present', cycles.filter((c) => c.status !== 'decided').length === 3);
  ok(
    'and they carry no target rather than a fabricated zero',
    cycles
      .filter((c) => c.status !== 'decided')
      .every((c) => c.model_decision.raw_target === null && c.model_decision.applied_target === null),
  );
  ok('while keeping their bar key', cycles.every((c) => c.bar.key === '2026-08-12T00:00:00.000Z'));
  ok('and their context', cycles.every((c) => c.context?.state === 'neutral'));
  ok(
    'a cycle whose book was not journaled reports a null exposure, not a zero',
    cycles[3]!.book.exposure_percent === null,
  );
}

// ── PROOF 6 — exposure is the sum of the non-reserve weights ─────────────────────────
console.log('Proof 6 — the exposure is Σ non-reserve, and a malformed total stays visible:');
{
  const view = allocationView({ BTC: 20, ETH: 10, USDT: 70 }, UNIVERSE, OPTIONS.reserves)!;
  ok('exposure is the sum of the coins', view.exposure_percent === 30);
  ok('the reserve is reported apart', view.reserve_percent === 70);
  ok('and the total is published', view.sum_percent === 100);

  // 100 − reserve would read 30 here too, and would be wrong: the row does not total 100.
  const broken = allocationView({ BTC: 20, USDT: 70 }, UNIVERSE, OPTIONS.reserves)!;
  ok('an allocation that does not total 100 reports its real sum', broken.sum_percent === 90);
  ok('and its exposure is the coins, not 100 − reserve', broken.exposure_percent === 20);

  const foreign = allocationView({ BTC: 20, DOGE: 5, USDT: 75 }, UNIVERSE, OPTIONS.reserves)!;
  ok('an asset outside the universe still counts as exposure', foreign.exposure_percent === 25);
  ok('and is named', foreign.unknown_assets.join(',') === 'DOGE');
  ok('a missing allocation is null, never an empty one', allocationView(null, UNIVERSE, OPTIONS.reserves) === null);
}

// ── PROOF 7 — the bar synthesis does not over-weight multiple wake-ups ───────────────
console.log('Proof 7 — a bar counts once, however many times the bot woke up inside it:');
{
  const raw: RawWindow = {
    decisions: [
      ...[10, 20, 30, 40, 50].map((m, i) =>
        decisionRow({
          id: 100 + i,
          at: `2026-08-12T00:${String(m).padStart(2, '0')}:00.000Z`,
          barAt: '2026-08-12T00:00:00.000Z',
          regimes: ALL_RANGE,
        }),
      ),
      decisionRow({ id: 200, at: '2026-08-12T04:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z', regimes: ALL_UP }),
    ],
    observations: [],
    executions: [],
  };
  const cycles = buildCycles(raw, OPTIONS);
  const bars = buildBars(cycles);
  ok('six cycles collapse into two bars', cycles.length === 6 && bars.length === 2);
  ok('the five wake-ups of the first bar are one bar row', bars[0]!.cycles === 5);

  const perBar = bars.map((bar) => bar.context!.state);
  ok('the per-bar state tally is 1 neutral / 1 constructive', perBar.join(',') === 'neutral,constructive');

  // The defect this exists to prevent: counting cycles would make it 5 neutral / 1 constructive.
  const perCycle = cycles.filter((c) => c.context!.state === 'neutral').length;
  ok('counting cycles would have said 5 neutral — which is why bars are the unit', perCycle === 5);
  ok('every cycle is accounted for in exactly one bar', bars.reduce((sum, b) => sum + b.cycles, 0) === cycles.length);
  ok('and the context is stable inside each bar', bars.every((bar) => bar.context_stable));
}

// ── PROOF 8 — intrabar changes of mind are visible, and so are their absences ────────
console.log('Proof 8 — the model changing its mind at constant market information:');
{
  const raw: RawWindow = {
    decisions: [
      decisionRow({ id: 300, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', target: { BTC: 15, ETH: 0, BNB: 0, XRP: 0, USDT: 85 }, deployed: 15 }),
      decisionRow({ id: 301, at: '2026-08-12T01:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', status: 'error', target: null, applied: null, deployed: 15 }),
      decisionRow({ id: 302, at: '2026-08-12T02:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', target: { BTC: 25, ETH: 0, BNB: 0, XRP: 0, USDT: 75 }, deployed: 15 }),
      decisionRow({ id: 400, at: '2026-08-12T04:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z', target: { BTC: 25, ETH: 0, BNB: 0, XRP: 0, USDT: 75 }, deployed: 25 }),
      decisionRow({ id: 401, at: '2026-08-12T05:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z', target: { BTC: 25, ETH: 0, BNB: 0, XRP: 0, USDT: 75 }, deployed: 25 }),
    ],
    observations: [],
    executions: [],
  };
  const intrabar = buildIntrabar(buildCycles(raw, OPTIONS));
  ok('both multi-wake-up bars appear', intrabar.length === 2);

  const moved = intrabar[0]!;
  ok('the bar where the model moved is flagged', moved.changed_mind);
  ok('its raw exposure swing is 10 points', moved.raw_exposure_swing_points === 10);
  ok('the change is measured between the two DECIDED cycles', moved.changes.length === 1 && moved.changes[0]!.from_decision_id === 300 && moved.changes[0]!.to_decision_id === 302);
  ok('the failed wake-up in between is listed, not bridged silently', moved.changes[0]!.skipped_decision_ids.join(',') === '301');
  ok('the moved asset is named with both weights', moved.changes[0]!.assets_changed.some((a) => a.asset === 'BTC' && a.from === 15 && a.to === 25));
  ok('the failed cycle contributes a null to the path, not a zero', moved.raw_target_exposure_path[1] === null);

  const still = intrabar[1]!;
  ok('the bar where nothing moved is published too — the denominator', !still.changed_mind && still.changes.length === 1);
  ok('with a zero swing rather than an absence', still.raw_exposure_swing_points === 0);
}

// ── PROOF 9 — stop episodes are counted as episodes, never as rows ───────────────────
console.log('Proof 9 — a stop that stays fired for twenty wake-ups is ONE episode:');
{
  const at = (h: number) => `2026-08-12T${String(h).padStart(2, '0')}:10:00.000Z`;
  const bar = (h: number) => `2026-08-12T${String(h - (h % 4)).padStart(2, '0')}:00:00.000Z`;
  const decisions: DecisionRowRead[] = [];
  const observations: ObservationRowRead[] = [];
  // BTC fires on cycles 0..3, heals on 4, then a cycle with NO verdict, then fires again.
  const firing = new Set([0, 1, 2, 3, 6]);
  for (let i = 0; i < 8; i += 1) {
    decisions.push(
      decisionRow({
        id: 500 + i,
        at: at(i),
        barAt: bar(i),
        status: i === 2 ? 'error' : 'decided',
        target: i === 2 ? null : undefined,
        applied: i === 2 ? null : undefined,
        positions: [{ asset: 'BTC', qty: 0.01 }],
      }),
    );
    if (i === 5) continue; // the cycle that produced no verdict at all
    for (const asset of UNIVERSE) {
      observations.push(
        observationRow({ decisionId: 500 + i, asset, barAt: bar(i), wouldFire: asset === 'BTC' && firing.has(i) }),
      );
    }
  }
  const facts = buildStopFacts(buildCycles({ decisions, observations, executions: [] }, OPTIONS));
  ok('five fired verdicts', facts.would_fire_verdicts === 5);
  ok('become two episodes, not five', facts.episodes.length === 2);
  ok('the first spans the four consecutive wake-ups', facts.episodes[0]!.cycles === 4 && facts.episodes[0]!.decision_ids.join(',') === '500,501,502,503');
  ok('every fired verdict belongs to exactly one episode', facts.episodes.reduce((s, e) => s + e.cycles, 0) === facts.would_fire_verdicts);
  ok('a failed wake-up inside the episode keeps its status', facts.episodes[0]!.statuses.includes('error'));
  ok('nothing booked, so the episode says so', facts.episodes[0]!.outcome === 'no_exit_booked' && facts.episodes[0]!.outcome_reason.startsWith('no_sell_booked'));
  ok('no re-entry was observed', facts.episodes[0]!.re_entry === null);
  ok('and the honest denominator travels with it', facts.episodes[0]!.cycles_after_episode_in_window === 4);
  ok('armed and not fired is counted apart', facts.armed_not_fired_verdicts === facts.armed_verdicts - facts.would_fire_verdicts);
}

// ── PROOF 10 — an exit that booked, and a re-entry that is a REAL order ──────────────
console.log('Proof 10 — a booked exit, a real re-entry, and no proxy anywhere:');
{
  const decisions = [
    decisionRow({ id: 600, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', positions: [{ asset: 'BTC', qty: 0.01 }] }),
    decisionRow({ id: 601, at: '2026-08-12T04:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z', positions: [] }),
    decisionRow({ id: 602, at: '2026-08-12T08:10:00.000Z', barAt: '2026-08-12T08:00:00.000Z', positions: [] }),
  ];
  const observations = UNIVERSE.flatMap((asset) => [
    observationRow({ decisionId: 600, asset, barAt: '2026-08-12T00:00:00.000Z', wouldFire: asset === 'BTC' }),
    observationRow({ decisionId: 601, asset, barAt: '2026-08-12T04:00:00.000Z' }),
    observationRow({ decisionId: 602, asset, barAt: '2026-08-12T08:00:00.000Z' }),
  ]);
  const executions = [
    intentRow(600, 'BTC/USDT', 'sell', 0.01),
    intentRow(602, 'BTC/USDT', 'buy', 0.004),
  ];
  const facts = buildStopFacts(buildCycles({ decisions, observations, executions }, OPTIONS));
  const episode = facts.episodes[0]!;
  ok('the episode reports the booked exit', episode.outcome === 'exit_booked' && episode.exit?.decision_id === 600);
  ok('with the quantities that let a reader judge the exit', episode.exit?.pre_trade_qty === 0.01 && episode.exit?.residual_qty === 0);
  ok('the re-entry is the first booked BUY after the episode', episode.re_entry?.decision_id === 602);
  ok('and it is a real order, not a mechanical one', episode.re_entry?.gross_notional_quote === 0.4);
}

// ── PROOF 11 — the window refuses everything ambiguous ───────────────────────────────
console.log('Proof 11 — the cutoff is explicit, settled, and never defaulted:');
{
  const now = Date.parse('2026-08-22T12:00:00.000Z');
  assert.throws(() => parseWindow([], now), WindowError);
  assert.throws(() => parseWindow(['--from', '2026-08-12T00:00:00Z'], now), WindowError);
  ok('both bounds are required', true);

  assert.throws(() => parseWindow(['--from', 'yesterday', '--cutoff', '2026-08-20T00:00:00Z'], now), WindowError);
  ok('an unparsable bound is refused', true);

  assert.throws(
    () => parseWindow(['--from', '2026-08-20T00:00:00Z', '--cutoff', '2026-08-12T00:00:00Z'], now),
    WindowError,
  );
  ok('an inverted window is refused', true);

  assert.throws(
    () => parseWindow(['--from', '2026-08-12T00:00:00Z', '--cutoff', '2026-08-22T11:59:00Z'], now),
    WindowError,
  );
  ok('a cutoff too recent to be settled is refused — a cycle may still be writing', true);

  assert.throws(
    () => parseWindow(['--from', '2026-08-12T00:00:00', '--cutoff', '2026-08-20T00:00:00Z'], now),
    WindowError,
  );
  ok('a bound with no timezone is refused — it would be read in the host timezone', true);

  const w = parseWindow(['--from', '2026-08-12T00:00:00Z', '--cutoff', '2026-08-22T00:00:00Z'], now);
  ok('a settled window parses', w.from === '2026-08-12T00:00:00.000Z' && w.toExclusive === '2026-08-22T00:00:00.000Z');

  const offset = parseWindow(['--from', '2026-08-12T07:00:00+07:00', '--cutoff', '2026-08-20T00:00:00Z'], now);
  ok('an explicit offset is accepted, and normalised to UTC', offset.from === '2026-08-12T00:00:00.000Z');
}

// ── PROOF 12 — nothing in the payload reaches past the cutoff ────────────────────────
console.log('Proof 12 — the cutoff scan catches a field nobody thought about:');
{
  const cutoff = Date.parse('2026-08-22T00:00:00.000Z');
  ok('a clean payload is clean', instantsAtOrAfter({ a: ['2026-08-21T23:59:59.000Z'] }, cutoff).length === 0);
  ok(
    'a planted future instant is caught wherever it hides',
    instantsAtOrAfter({ deep: { nested: [{ when: '2026-08-23T00:00:00.000Z' }] } }, cutoff).length === 1,
  );
  ok('the cutoff itself counts as past it', instantsAtOrAfter({ when: '2026-08-22T00:00:00.000Z' }, cutoff).length === 1);
  ok(
    'but the window declaration is not the payload',
    instantsAtOrAfter({ window: { to_exclusive: '2026-08-22T00:00:00.000Z' } }, cutoff).length === 0,
  );
}

// ── PROOF 13 — the same window produces the same bytes ───────────────────────────────
console.log('Proof 13 — determinism, on the artefact rather than on the intention:');
{
  const raw: RawWindow = {
    decisions: [
      decisionRow({ id: 700, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z' }),
      decisionRow({ id: 701, at: '2026-08-12T01:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', regimes: ALL_UP }),
    ],
    observations: UNIVERSE.flatMap((asset) => [
      observationRow({ decisionId: 700, asset, barAt: '2026-08-12T00:00:00.000Z' }),
      observationRow({ decisionId: 701, asset, barAt: '2026-08-12T00:00:00.000Z' }),
    ]),
    executions: [intentRow(701, 'BTC/USDT', 'buy', 0.001)],
  };
  const window = windowOf('2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z');
  const first = buildSnapshot(raw, window, UNIVERSE);
  // Shuffled input, same window: the snapshot orders by identity, so the bytes must not move.
  const shuffled: RawWindow = {
    decisions: [...raw.decisions].reverse(),
    observations: [...raw.observations].reverse(),
    executions: [...raw.executions].reverse(),
  };
  const second = buildSnapshot(shuffled, window, UNIVERSE);
  ok('two builds of the same window are byte-identical', canonicalJson(first.cycles) === canonicalJson(second.cycles));
  ok('…and so are their summaries', canonicalJson(first.summary) === canonicalJson(second.summary));
  ok('every check passes on a well-formed window', first.summary.checks.every((c) => c.ok));
  ok('the contract travels inside the artefact', first.summary.contract.not_measured.includes('drawdown'));

  // The band-agnosticism of the ARTEFACT, not only of the code: no field of the published
  // snapshot describes a band, an arm or an exposure target. The `contract` block is skipped —
  // it is the DECLARATION that there is no band, and it has to be able to say the word.
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'contract') continue;
        keys.add(key);
        walk(entry);
      }
    }
  };
  walk(first.cycles);
  walk(first.summary);
  const bandish = [...keys].filter((key) => /(^|_)(band|bands|arm|arms)(_|$)/.test(key));
  ok(
    `no key in either artefact is band-shaped (${bandish.join(', ') || 'none'})`,
    bandish.length === 0,
  );
  ok(
    'the context is unstable inside that bar, and the summary says so rather than hiding it',
    first.summary.bars[0]!.context_stable === false && first.summary.bars[0]!.context_unstable_fields.includes('state'),
  );
}

// ── PROOF 14 — a malformed regime fails loudly; an absent one does not ───────────────
console.log('Proof 14 — an absent regime is a fact, a malformed one is a defect:');
{
  const absent = contextOf(null, UNIVERSE);
  ok('an absent regime is reported as such', !absent.ok && absent.reason === 'no_regime_journaled');

  const malformed = contextOf({ version: 'r1', barAt: '2026-08-12T00:00:00.000Z', global: { riskOff: false }, assets: { BTC: { regime: 'sideways', raw: 'range', signals: {} } } }, UNIVERSE);
  ok('an unknown regime label is a malformed journal, not a missing one', !malformed.ok && malformed.reason === 'malformed_regime_journal');

  // A string `barAt` nobody can parse used to escape the guard and abort the whole run, taking
  // the failed check that reports it down with the snapshot.
  const badBar = contextOf(
    { version: 'r1', barAt: 'the-eleventh-of-never', global: { riskOff: false }, assets: {} },
    UNIVERSE,
  );
  ok('an unparsable barAt is a malformed journal, not a crash', !badBar.ok && badBar.reason === 'malformed_regime_journal');

  const partial = contextOf(journalOf('2026-08-12T00:00:00.000Z', { BTC: 'trend_up', ETH: 'trend_up' }), UNIVERSE);
  ok('a universe asset with no point is counted unavailable, never guessed', partial.ok && partial.context.unavailable === 2);
  ok('and the breadth denominator stays the configured universe', partial.ok && partial.context.net_breadth === 0.5);

  const withReference = contextOf(
    journalOf('2026-08-12T00:00:00.000Z', { ...ALL_RANGE, SOL: 'trend_up' }),
    UNIVERSE,
  );
  ok(
    'an asset the journal carries but the controller cannot allocate to is named apart',
    withReference.ok && withReference.context.journal_only_assets.join(',') === 'SOL',
  );
  ok(
    'and it does not enter the breadth',
    withReference.ok && withReference.context.net_breadth === 0 && withReference.context.state === 'neutral',
  );
}

// ── PROOF 15 — the checks fail when the population is wrong ──────────────────────────
console.log('Proof 15 — the integrity checks are falsifiable:');
{
  const window = windowOf('2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z');
  const outside = buildSnapshot(
    {
      decisions: [decisionRow({ id: 800, at: '2026-08-14T00:10:00.000Z', barAt: '2026-08-14T00:00:00.000Z' })],
      observations: [],
      executions: [],
    },
    window,
    UNIVERSE,
  );
  const named = (snapshot: typeof outside, name: string) => snapshot.summary.checks.find((c) => c.name === name)!;
  ok('a cycle outside the window fails the window check', !named(outside, 'window_is_half_open').ok);
  ok('and its future instants fail the cutoff scan', !named(outside, 'no_instant_at_or_after_the_cutoff').ok);

  const noBar = buildSnapshot(
    { decisions: [decisionRow({ id: 801, at: '2026-08-12T00:10:00.000Z' })], observations: [], executions: [] },
    window,
    UNIVERSE,
  );
  ok('a cycle with no bar fails the bar check', !named(noBar, 'every_cycle_keeps_its_bar').ok);

  const partialVerdicts = buildSnapshot(
    {
      decisions: [decisionRow({ id: 802, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z' })],
      observations: [observationRow({ decisionId: 802, asset: 'BTC', barAt: '2026-08-12T00:00:00.000Z' })],
      executions: [],
    },
    window,
    UNIVERSE,
  );
  ok('a partial verdict set fails its check', !named(partialVerdicts, 'transition_verdicts_are_complete_or_absent').ok);

  const disagreeing = buildSnapshot(
    {
      decisions: [decisionRow({ id: 803, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z' })],
      observations: UNIVERSE.map((asset) => observationRow({ decisionId: 803, asset, barAt: '2026-08-11T20:00:00.000Z' })),
      executions: [],
    },
    window,
    UNIVERSE,
  );
  ok('two writers naming different bars fail the cross-check', !named(disagreeing, 'bar_key_agrees_across_writers').ok);

  const incomplete = buildSnapshot(
    {
      decisions: [decisionRow({ id: 804, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z', applied: null })],
      observations: [],
      executions: [],
    },
    window,
    UNIVERSE,
  );
  ok('a decided cycle missing an exposure fails its check', !named(incomplete, 'decided_cycles_carry_both_exposures').ok);

  // THE STRADDLING CYCLE. The decision lands 10 s before the cutoff; its verdicts and its
  // movement are written after it, because a wake-up is not atomic. Fetched by `decision_id`,
  // those post-cutoff facts would otherwise ride in with nothing able to see them.
  const straddle = buildSnapshot(
    {
      decisions: [decisionRow({ id: 805, at: '2026-08-12T23:59:50.000Z', barAt: '2026-08-12T20:00:00.000Z' })],
      observations: UNIVERSE.map((asset) =>
        observationRow({
          decisionId: 805,
          asset,
          barAt: '2026-08-12T20:00:00.000Z',
          writtenAt: '2026-08-13T00:00:05.000Z',
        }),
      ),
      executions: [intentRow(805, 'BTC/USDT', 'buy', 0.001, 100, '2026-08-13T00:00:02.000Z')],
    },
    window,
    UNIVERSE,
  );
  ok(
    'a cycle straddling the cutoff fails its own check',
    !named(straddle, 'every_cycle_settled_before_the_cutoff').ok,
  );
  ok('and the generic scan sees it too, now that the write instants are published', !named(straddle, 'no_instant_at_or_after_the_cutoff').ok);
  ok(
    'the cycle is kept WHOLE rather than amputated — a truncated one would read as booking nothing',
    straddle.cycles.cycles[0]!.transition.verdicts.length === UNIVERSE.length &&
      straddle.cycles.cycles[0]!.movements.length === 1,
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────────────

/** Every `.ts` file under a directory, resolved and sorted. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.resolve(path.join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * The TRANSITIVE module graph of an entry point, following relative imports only.
 *
 * A text grep over the observer's own files would prove nothing about what those files import:
 * a band could arrive two hops away, through a module that merely looked neutral. Following the
 * edges is the only version of "no band in the extraction path" that survives a refactor.
 */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const specifier = match[1]!;
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
      queue.push(resolved);
    }
  }
  return seen;
}

console.log(`\nAll ${passed} exposure-observation proofs passed.`);
