import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { DEFAULT_OUT_DIR, parseOutDir, parseWindow, WindowError, type ObservationWindow } from '../observation/exposure/window.js';
import { readWindow, ReadError } from '../observation/exposure/read.js';
import type { DecisionRowRead, ExecutionRowRead, ObservationRowRead, RawWindow } from '../observation/exposure/read.js';
import { canonicalInstant, parseWindowBound, parseZonedInstant } from '../observation/exposure/instants.js';
import type { SupabaseClient } from '@supabase/supabase-js';

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
  medianH4Rsi?: number | null;
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
    regime: f.barAt == null ? null : journalOf(f.barAt, f.regimes ?? ALL_RANGE, { medianH4Rsi: f.medianH4Rsi }),
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
  // `bookedIntent` stores the UNSNAPPED request and moves the ledger by the SNAPPED quantity,
  // so the two are only equal when the request already sat on the exchange's step.
  opts: { bookedQty?: number; rejected?: boolean } = {},
): ExecutionRowRead {
  executionId += 1;
  const rejected = opts.rejected === true;
  const booked = rejected ? 0 : (opts.bookedQty ?? qty);
  return {
    id: executionId,
    decision_id: decisionId,
    created_at: createdAt,
    symbol,
    side,
    event_type: 'intent',
    validation_status: rejected ? 'rejected' : 'executed',
    validation_reason: 'fixture',
    requested_qty: qty,
    executed_qty: null,
    valuation_price: price,
    fee: 0,
    ledger_base_delta: side === 'buy' ? booked : -booked,
    ledger_quote_delta: side === 'buy' ? -booked * price : booked * price,
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

  // `update` is IN the list. It was dropped once because `createHash(...).update(...)` matched —
  // but that call lives in `provenance/`, and this regex is scoped to the observer's own files,
  // which contain no such thing. Leaving it out meant a future `.update(...)` added to the
  // already-authorised `read.ts` would pass both halves of this proof.
  const writeCalls = /\.(insert|upsert|update|delete|rpc)\s*\(/;
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

  // AN UNREADABLE HELD QUANTITY IS NOT A FLAT LINE. `fromNumeric` maps a null to ZERO, which is
  // right for money arithmetic and wrong here: it would publish a real, zero-sized position, and
  // a stop episode would compute its `pre_trade_qty` and its residual from a number nobody wrote.
  const brokenBook = decisionRow({ id: 5, at: '2026-08-12T04:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z' });
  (brokenBook.market_context as { account: { portfolio: { positions: unknown[] } } }).account.portfolio.positions = [
    { asset: 'BTC', qty: 'lots', price: 100, weightPercent: 10, priceStale: false },
    { asset: 'ETH', qty: 0.5, price: 100, weightPercent: 10, priceStale: false },
  ];
  const withBrokenBook = buildSnapshot(
    { decisions: [brokenBook], observations: [], executions: [] },
    windowOf('2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
    UNIVERSE,
  );
  const book = withBrokenBook.cycles.cycles[0]!.book;
  ok('an unreadable quantity stays null rather than becoming a zero position', book.positions[0]!.qty === null);
  ok('it is named', book.unreadable_qty_assets.join(',') === 'BTC');
  ok('the readable one is untouched', book.positions[1]!.qty === 0.5);
  ok(
    'and the snapshot fails its book-readability check',
    !withBrokenBook.summary.checks.find((c) => c.name === 'book_positions_are_readable')!.ok,
  );

  // A COLLECTION NOBODY CAN READ IS NOT AN EMPTY BOOK. Replacing it with `[]` would publish a
  // flat portfolio, leave every "unreadable" list empty, pass the check — and let a stop episode
  // report a null pre-trade quantity for a line that was there and was lost in parsing.
  const bookWith = (positions: unknown): ReturnType<typeof buildSnapshot> => {
    const row = decisionRow({ id: 6, at: '2026-08-12T05:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z' });
    (row.market_context as { account: { portfolio: Record<string, unknown> } }).account.portfolio.positions = positions;
    return buildSnapshot(
      { decisions: [row], observations: [], executions: [] },
      windowOf('2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
      UNIVERSE,
    );
  };
  const readable = (snapshot: ReturnType<typeof buildSnapshot>): boolean =>
    snapshot.summary.checks.find((c) => c.name === 'book_positions_are_readable')!.ok;

  const notACollection = bookWith({ BTC: 0.01 });
  ok('a positions value that is not a collection is flagged', notACollection.cycles.cycles[0]!.book.positions_unreadable);
  ok('…and fails the check rather than reading as a flat book', !readable(notACollection));
  ok('a missing positions value is flagged the same way', bookWith(undefined).cycles.cycles[0]!.book.positions_unreadable);

  const namelessEntries = bookWith(['BTC', { qty: 0.5 }, { asset: '', qty: 1 }, { asset: 'ETH', qty: 0.5 }]);
  ok(
    'entries with no usable asset name are counted, not discarded',
    namelessEntries.cycles.cycles[0]!.book.unreadable_position_entries === 3,
  );
  ok('the identified one is still published', namelessEntries.cycles.cycles[0]!.book.positions.length === 1);
  ok('…and the check fails', !readable(namelessEntries));
  ok('while a well-formed book passes', readable(bookWith([{ asset: 'ETH', qty: 0.5, price: 100, weightPercent: 5, priceStale: false }])));

  // THE SUMMARY, ON THE SAME RULE. `exposure_percent` is what every per-bar extremum rests on,
  // and a corrupted `deployedPercent` reaches the artefact as a clean null — indistinguishable
  // from the cycle above that journaled no book at all, which is legitimate and already visible.
  const summaryWith = (patch: Record<string, unknown>): ReturnType<typeof buildSnapshot> => {
    const row = decisionRow({ id: 7, at: '2026-08-12T06:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z' });
    const portfolio = (row.market_context as { account: { portfolio: Record<string, unknown> } }).account.portfolio;
    Object.assign(portfolio, patch);
    return buildSnapshot(
      { decisions: [row], observations: [], executions: [] },
      windowOf('2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
      UNIVERSE,
    );
  };
  const summaryOk = (snapshot: ReturnType<typeof buildSnapshot>): boolean =>
    snapshot.summary.checks.find((c) => c.name === 'book_summary_is_readable')!.ok;

  const brokenExposure = summaryWith({ deployedPercent: 'lots' });
  ok(
    'a corrupted exposure is named rather than published as a clean null',
    brokenExposure.cycles.cycles[0]!.book.unreadable_summary_fields.join(',') === 'deployedPercent',
  );
  ok('…and it fails the summary check', !summaryOk(brokenExposure));
  ok('a missing equity is caught too', !summaryOk(summaryWith({ equity: undefined })));
  ok('and a missing reserve asset', !summaryOk(summaryWith({ reserveAsset: null })));
  ok('a well-formed summary passes', summaryOk(summaryWith({})));
  ok('a boolean exposure is unreadable, not a 1 %', !summaryOk(summaryWith({ deployedPercent: true })));

  // The distinction the whole fix exists for: a cycle with NO portfolio at all claimed nothing,
  // so it names no unreadable field and passes — its `exposure_percent: null` says it already.
  const noBook = buildSnapshot(
    {
      decisions: [decisionRow({ id: 8, at: '2026-08-12T07:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z', deployed: 15 })],
      observations: [],
      executions: [],
    },
    windowOf('2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
    UNIVERSE,
  );
  const stripped = decisionRow({ id: 9, at: '2026-08-12T07:20:00.000Z', barAt: '2026-08-12T04:00:00.000Z' });
  (stripped.market_context as { account: Record<string, unknown> }).account = {};
  const noPortfolio = buildSnapshot(
    { decisions: [stripped], observations: [], executions: [] },
    windowOf('2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
    UNIVERSE,
  );
  ok('a journaled book passes both checks', summaryOk(noBook) && readable(noBook));
  ok(
    'a cycle that journaled NO book claims nothing, so it names nothing and passes',
    noPortfolio.cycles.cycles[0]!.book.exposure_percent === null &&
      noPortfolio.cycles.cycles[0]!.book.unreadable_summary_fields.length === 0 &&
      summaryOk(noPortfolio),
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

  // An unreadable weight dropped in silence would leave the exposure and the sum computed from
  // the survivors — a corrupted row reading as a valid, smaller allocation.
  const corrupt = allocationView({ BTC: 'twenty', ETH: 10, USDT: 70 }, UNIVERSE, OPTIONS.reserves)!;
  ok('an unreadable weight is named rather than dropped', corrupt.unreadable_assets.join(',') === 'BTC');
  ok('a readable allocation names none', foreign.unreadable_assets.length === 0);

  // NOTHING IS COERCED INTO A NUMBER. `Number(true)` is 1, `Number('')` and `Number(false)` are
  // 0, `Number([5])` is 5 — a hand-edited weight would otherwise be published as a plausible
  // allocation with every check green.
  const coerced = allocationView(
    { BTC: true, ETH: false, BNB: '', XRP: [5], USDT: '70' },
    UNIVERSE,
    OPTIONS.reserves,
  )!;
  ok(
    'booleans, empty strings and arrays are unreadable, never 1 or 0',
    coerced.unreadable_assets.join(',') === 'BNB,BTC,ETH,XRP',
  );
  ok('a numeric string is still a number — PostgREST renders `numeric` as one', coerced.reserve_percent === 70);

  // THE RESERVE IS THE ONE THE CYCLE'S OWN BOOK NAMED. Reading today's quote asset into a
  // historical allocation would treat the cash key of the time as an ordinary coin and add it
  // straight to the exposure — silently, since `unknown_assets` is published and never rejected.
  const legacyQuote = decisionRow({
    id: 20,
    at: '2026-08-12T00:10:00.000Z',
    barAt: '2026-08-12T00:00:00.000Z',
    target: { BTC: 10, ETH: 5, BNB: 0, XRP: 0, BUSD: 85 } as unknown as Record<string, number>,
  });
  (legacyQuote.market_context as { account: { portfolio: Record<string, unknown> } }).account.portfolio.reserveAsset =
    'BUSD';
  const legacyCycle = buildCycles({ decisions: [legacyQuote], observations: [], executions: [] }, OPTIONS)[0]!;
  ok(
    'a retired cash key is read as the reserve its own book named, not as exposure',
    legacyCycle.model_decision.raw_target!.exposure_percent === 15 &&
      legacyCycle.model_decision.raw_target!.reserve_percent === 85,
  );
  ok('and it is not reported as an unknown asset', legacyCycle.model_decision.raw_target!.unknown_assets.length === 0);
  ok(
    'while a book naming the configured reserve is unchanged',
    buildCycles(
      { decisions: [decisionRow({ id: 21, at: '2026-08-12T00:20:00.000Z', barAt: '2026-08-12T00:00:00.000Z' })], observations: [], executions: [] },
      OPTIONS,
    )[0]!.model_decision.raw_target!.exposure_percent === 15,
  );
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

  // THE AGGREGATES ARE NOT THE CONTEXT. These two wake-ups share a bar, a state, a net breadth
  // and every count — one asset's rise cancels another's fall — while describing two different
  // markets. A fingerprint over the tallies alone would publish the first and call the bar
  // stable, hiding the drift the field exists to expose.
  const mirrored = buildBars(
    buildCycles(
      {
        decisions: [
          decisionRow({
            id: 110,
            at: '2026-08-12T08:10:00.000Z',
            barAt: '2026-08-12T08:00:00.000Z',
            regimes: { BTC: 'trend_up', ETH: 'trend_down', BNB: 'range', XRP: 'range' },
          }),
          decisionRow({
            id: 111,
            at: '2026-08-12T09:10:00.000Z',
            barAt: '2026-08-12T08:00:00.000Z',
            regimes: { BTC: 'trend_down', ETH: 'trend_up', BNB: 'range', XRP: 'range' },
          }),
        ],
        observations: [],
        executions: [],
      },
      OPTIONS,
    ),
  )[0]!;
  ok(
    'the aggregates really are identical across the two wake-ups',
    mirrored.context!.state === 'neutral' && mirrored.context!.net_breadth === 0 && mirrored.context!.bullish === 1,
  );
  ok('yet the bar is reported UNSTABLE', !mirrored.context_stable && mirrored.context_variants === 2);
  ok('and the per-asset field is named', mirrored.context_unstable_fields.includes('assets'));

  // The same for the inputs a later variant is judged on: a partial outage moves `medianH4Rsi`
  // and `assetsPresent` inside a bar without touching a single count.
  const rsiDrift = buildBars(
    buildCycles(
      {
        decisions: [
          decisionRow({ id: 120, at: '2026-08-12T12:10:00.000Z', barAt: '2026-08-12T12:00:00.000Z', medianH4Rsi: 46 }),
          decisionRow({ id: 121, at: '2026-08-12T13:10:00.000Z', barAt: '2026-08-12T12:00:00.000Z', medianH4Rsi: 71 }),
        ],
        observations: [],
        executions: [],
      },
      OPTIONS,
    ),
  )[0]!;
  ok(
    'a median RSI moving inside a bar is caught, and the global block is named',
    !rsiDrift.context_stable && rsiDrift.context_unstable_fields.includes('journal_global'),
  );
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

  // A `guard_failed` row CARRIES the refused proposal — `failCycle` stores it for the
  // post-mortem, and says in its own comment that it is never an input to anything. Reading it
  // in a derived view would invent a change of mind the model never got to have.
  const refused = buildCycles(
    {
      decisions: [
        decisionRow({ id: 320, at: '2026-08-12T08:10:00.000Z', barAt: '2026-08-12T08:00:00.000Z', target: { BTC: 15, ETH: 0, BNB: 0, XRP: 0, USDT: 85 } }),
        decisionRow({
          id: 321,
          at: '2026-08-12T09:10:00.000Z',
          barAt: '2026-08-12T08:00:00.000Z',
          status: 'guard_failed',
          target: { BTC: 60, ETH: 0, BNB: 0, XRP: 0, USDT: 40 },
          applied: null,
        }),
      ],
      observations: [],
      executions: [],
    },
    OPTIONS,
  );
  const refusedBar = buildBars(refused)[0]!;
  const refusedIntrabar = buildIntrabar(refused)[0]!;
  ok('the refused proposal is kept in the per-cycle audit record', refused[1]!.model_decision.raw_target?.exposure_percent === 60);
  ok('but it is not a decided cycle', refusedBar.decided_cycles === 1);
  ok('it does not reach the per-bar extrema', refusedBar.raw_target_exposure_percent.max === 15);
  ok('and it is not a change of mind', !refusedIntrabar.changed_mind && refusedIntrabar.changes.length === 0);
  ok('the path shows it as absent, not as a 60 % ask', refusedIntrabar.raw_target_exposure_path[1] === null);
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
  ok(
    'the first episode began at the window edge and is flagged as a possible continuation',
    facts.episodes[0]!.truncated_at_window_start && !facts.episodes[0]!.truncated_at_window_end,
  );
  ok(
    'the second provably began inside the window — the stop was seen not firing before it',
    !facts.episodes[1]!.truncated_at_window_start,
  );

  // THE OTHER EDGE. A run still open at the cutoff has not been seen to end: its duration is a
  // lower bound and its re-entry is necessarily null, so the boundary is published rather than
  // read as an episode that simply never resolved.
  const stillOpen = buildStopFacts(
    buildCycles(
      {
        decisions: [
          decisionRow({ id: 550, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z' }),
          decisionRow({ id: 551, at: '2026-08-12T04:10:00.000Z', barAt: '2026-08-12T04:00:00.000Z' }),
        ],
        observations: UNIVERSE.flatMap((asset) => [
          observationRow({ decisionId: 550, asset, barAt: '2026-08-12T00:00:00.000Z' }),
          observationRow({ decisionId: 551, asset, barAt: '2026-08-12T04:00:00.000Z', wouldFire: asset === 'BTC' }),
        ]),
        executions: [],
      },
      OPTIONS,
    ),
  );
  ok(
    'a run still open at the cutoff is flagged at the end and not at the start',
    stillOpen.episodes[0]!.truncated_at_window_end && !stillOpen.episodes[0]!.truncated_at_window_start,
  );
  ok(
    '…and it carries no re-entry, with a zero denominator saying why',
    stillOpen.episodes[0]!.re_entry === null && stillOpen.episodes[0]!.cycles_after_episode_in_window === 0,
  );
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
  // The bookings land AFTER their decision rows, because a wake-up is not atomic. The gap is
  // exaggerated here so an episode timestamped on the cycle instead of the order is impossible
  // to mistake for a correct one — the next chantier measures exactly this delay.
  const executions = [
    intentRow(600, 'BTC/USDT', 'sell', 0.01, 100, '2026-08-12T00:10:20.000Z'),
    intentRow(602, 'BTC/USDT', 'buy', 0.004, 100, '2026-08-12T08:10:25.000Z'),
  ];
  const facts = buildStopFacts(buildCycles({ decisions, observations, executions }, OPTIONS));
  const episode = facts.episodes[0]!;
  ok('the episode reports the booked exit', episode.outcome === 'exit_booked' && episode.exit?.decision_id === 600);
  ok('with the quantities that let a reader judge the exit', episode.exit?.pre_trade_qty === 0.01 && episode.exit?.residual_qty === 0);
  ok('the exit carries the ORDER instant, not the cycle instant', episode.exit?.booked_at === '2026-08-12T00:10:20.000Z');
  ok('the re-entry is the first booked BUY after the episode', episode.re_entry?.decision_id === 602);
  ok('and it too carries the ORDER instant', episode.re_entry?.booked_at === '2026-08-12T08:10:25.000Z');
  ok('and it is a real order, not a mechanical one', episode.re_entry?.booked_notional_quote === 0.4);
  ok(
    'the episode boundaries stay the WAKE-UP instants, and are named apart',
    episode.from_cycle_at === '2026-08-12T00:10:00.000Z' && episode.to_cycle_at === '2026-08-12T00:10:00.000Z',
  );

  // NO SUBSTITUTION. A journal without a usable booking instant publishes null: the cycle's own
  // time is one decision_id away, and an invented instant is indistinguishable from a measured
  // one to every later reader.
  const unstamped = buildStopFacts(
    buildCycles(
      {
        decisions,
        observations,
        executions: [
          intentRow(600, 'BTC/USDT', 'sell', 0.01, 100, 'not-an-instant'),
          intentRow(602, 'BTC/USDT', 'buy', 0.004, 100, '2026-08-12T08:10:25'),
        ],
      },
      OPTIONS,
    ),
  ).episodes[0]!;
  ok('a booking with no usable instant publishes null rather than the cycle time', unstamped.exit?.booked_at === null);
  ok('and so does a re-entry whose instant carries no timezone', unstamped.re_entry?.booked_at === null);
  ok('while the movement itself is still reported', unstamped.exit?.decision_id === 600 && unstamped.re_entry?.decision_id === 602);

  // THE NOTIONAL COMES FROM THE LEDGER, NOT FROM THE REQUEST. The exchange's step rounding puts
  // the two apart on every booking, and the requested figure overstates what moved the book.
  const rounded = buildCycles(
    {
      decisions: [decisionRow({ id: 600, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z' })],
      observations: [],
      executions: [
        intentRow(600, 'BTC/USDT', 'sell', 0.0007992624952012143, 64019.32, '2026-08-12T00:10:20.000Z', {
          bookedQty: 0.00079,
        }),
        intentRow(600, 'ETH/USDT', 'buy', 0.05, 2000, '2026-08-12T00:10:21.000Z', { rejected: true }),
      ],
    },
    OPTIONS,
  )[0]!;
  const [sell, crumb] = rounded.movements;
  ok('the requested notional is what was asked', sell!.requested_notional_quote === 51.168241);
  ok('the booked notional is what moved the book — 0.6 quote lower here', sell!.booked_notional_quote === 50.575263);
  ok(
    'a rejected intent has a requested notional and NO booked one',
    crumb!.booked === false && crumb!.requested_notional_quote === 100 && crumb!.booked_notional_quote === null,
  );
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

  // `gitIsDirty()` is blind to `out/` on purpose — a run writes its artefacts before stamping
  // the manifest. Outside it, those same writes would make the tree dirty and the manifest
  // would accuse a clean source.
  ok(
    'the output directory defaults to the observer namespace',
    parseOutDir([], ROOT) === path.join(realpathSync(ROOT), 'out', 'exposure-observation'),
  );
  ok(
    'a descendant is accepted, and returned resolved so the write lands where the check looked',
    parseOutDir(['--out', 'out/exposure-observation/run-a'], ROOT) ===
      path.join(realpathSync(ROOT), 'out', 'exposure-observation', 'run-a'),
  );
  ok(
    'a trailing slash is normalised',
    parseOutDir(['--out', 'out/exposure-observation/x/'], ROOT) ===
      path.join(realpathSync(ROOT), 'out', 'exposure-observation', 'x'),
  );

  // `out/exposure-calibration` is the one that would really hurt: it holds two COMMITTED files
  // named `summary.json` and `manifest.json`, which is exactly what this command writes.
  for (const bad of [
    'out/exposure-calibration',
    'out/foo',
    'out',
    'snapshots/run-a',
    '/tmp/run-a',
    'out/exposure-observation/../exposure-calibration',
    'C:\\tmp\\run-a',
  ]) {
    assert.throws(() => parseOutDir(['--out', bad], ROOT), WindowError, `--out=${bad} must be refused`);
  }
  ok('every other destination is refused — another brick\u2019s namespace, the rest of out/, absolutes, escapes', true);
}

// ── PROOF 11b — the confinement is PHYSICAL, not a prefix test on a string ───────────
console.log('Proof 11b — a link cannot carry the artefacts out of the namespace:');
{
  // A lexical prefix check reads the path the operator typed; the filesystem writes to the path
  // the links resolve to. On a repository where `out/exposure-observation` is a link to
  // `out/exposure-calibration`, the DEFAULT invocation would overwrite two committed files —
  // and `gitIsDirty()`, blind to everything under `out/`, would let the replacing manifest
  // report a clean tree while doing it.
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'observation-out-')));
  try {
    mkdirSync(path.join(sandbox, 'out', 'exposure-calibration'), { recursive: true });

    // 1. The namespace directory does not exist yet — the ordinary first run.
    ok(
      'a namespace that does not exist yet is accepted',
      parseOutDir([], sandbox) === path.join(sandbox, 'out', 'exposure-observation'),
    );
    ok(
      '…and so is a descendant of it',
      parseOutDir(['--out', 'out/exposure-observation/run-a'], sandbox) ===
        path.join(sandbox, 'out', 'exposure-observation', 'run-a'),
    );

    // 2. The namespace ROOT is a link out of the namespace.
    linkDir(path.join(sandbox, 'out', 'exposure-calibration'), path.join(sandbox, 'out', 'exposure-observation'));
    assert.throws(() => parseOutDir([], sandbox), WindowError);
    ok('a namespace ROOT that is a link out of the namespace is refused', true);
    assert.throws(() => parseOutDir(['--out', 'out/exposure-observation/run-a'], sandbox), WindowError);
    ok('…and so is every descendant reached through it', true);

    // 3. The root is real again, and a DESCENDANT is the link.
    rmSync(path.join(sandbox, 'out', 'exposure-observation'), { recursive: true, force: true });
    mkdirSync(path.join(sandbox, 'out', 'exposure-observation'), { recursive: true });
    ok('with a real namespace, the default is accepted again', parseOutDir([], sandbox).startsWith(sandbox));
    linkDir(
      path.join(sandbox, 'out', 'exposure-calibration'),
      path.join(sandbox, 'out', 'exposure-observation', 'run-b'),
    );
    assert.throws(() => parseOutDir(['--out', 'out/exposure-observation/run-b'], sandbox), WindowError);
    ok('a DESCENDANT that is a link out of the namespace is refused', true);
    assert.throws(
      () => parseOutDir(['--out', 'out/exposure-observation/run-b/deeper'], sandbox),
      WindowError,
    );
    ok('…including a path that only crosses it on the way down', true);

    // 4. A link that stays INSIDE the namespace is not an escape and must keep working.
    mkdirSync(path.join(sandbox, 'out', 'exposure-observation', 'real'), { recursive: true });
    linkDir(
      path.join(sandbox, 'out', 'exposure-observation', 'real'),
      path.join(sandbox, 'out', 'exposure-observation', 'inside'),
    );
    ok(
      'a link that stays inside the namespace is not an escape',
      parseOutDir(['--out', 'out/exposure-observation/inside'], sandbox) ===
        path.join(sandbox, 'out', 'exposure-observation', 'real'),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
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

  // Worse than unparsable: PARSABLE, and read in the host timezone. Nothing would fail — the
  // same window would simply acquire different bar keys, groupings and artefact bytes under a
  // different TZ, with every check still green.
  const zoneless = contextOf(
    { version: 'r1', barAt: '2026-08-12T00:00:00', global: { riskOff: false }, assets: {} },
    UNIVERSE,
  );
  ok('a barAt with no timezone is refused too', !zoneless.ok && zoneless.reason === 'malformed_regime_journal');

  // EVERY field the cast promises, not only the ones this module reads. A journal missing
  // `effective` would otherwise be accepted, and `JSON.stringify` would simply omit the key
  // from the published context while every check stayed green.
  const complete = journalOf('2026-08-12T00:00:00.000Z', ALL_RANGE);
  for (const field of ['effective', 'regime', 'raw', 'pendingRegime', 'pendingBars', 'bearish', 'signals']) {
    const holed = JSON.parse(JSON.stringify(complete)) as { assets: Record<string, Record<string, unknown>> };
    delete holed.assets.BTC![field];
    const result = contextOf(holed, UNIVERSE);
    assert.ok(!result.ok && result.reason === 'malformed_regime_journal', `a journal missing ${field} must be refused`);
  }
  ok('a journal missing any asset field is refused, field by field', true);

  const wrongType = JSON.parse(JSON.stringify(complete)) as { assets: Record<string, Record<string, unknown>> };
  wrongType.assets.BTC!.bearish = 'no';
  const typed = contextOf(wrongType, UNIVERSE);
  ok('and so is one whose types drifted', !typed.ok && typed.reason === 'malformed_regime_journal');

  // The GLOBAL block, same rule. Its numbers reach the artefact through `numberOrNull`, so a
  // corrupted breadth would be published as a clean `null` — indistinguishable from a bar where
  // it genuinely was not measured.
  for (const field of ['riskOff', 'raw', 'breadthPercent', 'assetsPresent', 'assetsExpected', 'pendingBars']) {
    const holed = JSON.parse(JSON.stringify(complete)) as { global: Record<string, unknown> };
    delete holed.global[field];
    const result = contextOf(holed, UNIVERSE);
    assert.ok(!result.ok && result.reason === 'malformed_regime_journal', `a journal missing global.${field} must be refused`);
  }
  ok('a journal missing any global field is refused, field by field', true);

  const nullRsi = JSON.parse(JSON.stringify(complete)) as { global: Record<string, unknown> };
  nullRsi.global.medianH4Rsi = null;
  ok('but a null median RSI is a fact, not a hole — no asset produced one on that bar', contextOf(nullRsi, UNIVERSE).ok);

  const textRsi = JSON.parse(JSON.stringify(complete)) as { global: Record<string, unknown> };
  textRsi.global.medianH4Rsi = '46.8';
  ok('while any other non-number is still a defect', !contextOf(textRsi, UNIVERSE).ok);

  // The live corpus is the counter-check: on 22/08 the tightening rejected none of the 592
  // journals (2 960 asset entries) the bot has written.
  ok('while the shape production actually writes is accepted', contextOf(complete, UNIVERSE).ok);
  ok('no instant in this module is ever read in the host timezone', parseZonedInstant('2026-08-12T00:00:00') === null);
  ok('an offset is honoured', canonicalInstant('2026-08-12T07:00:00+07:00') === '2026-08-12T00:00:00.000Z');
  ok('and the offset PostgREST renders is honoured', canonicalInstant('2026-08-12T00:00:00+00:00') === '2026-08-12T00:00:00.000Z');

  // A DATE THAT DOES NOT EXIST IS NOT ROLLED FORWARD. `Date.parse` turns 30 February into
  // 2 March without complaint, so a typo would select another population and leave no trace of
  // itself in the artefact — which records only the normalised date.
  for (const impossible of [
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-08-12T24:00:00Z',
    '2026-08-12T00:60:00Z',
    '2026-08-12T00:00:60Z',
  ]) {
    assert.equal(parseZonedInstant(impossible), null, `${impossible} must be refused`);
  }
  ok('an impossible calendar date is refused rather than rolled forward', true);
  ok('a leap day that exists is accepted', parseZonedInstant('2028-02-29T00:00:00Z') != null);
  ok('one that does not is refused', parseZonedInstant('2026-02-29T00:00:00Z') === null);
  ok('and the last day of a 31-day month passes', parseZonedInstant('2026-08-31T23:59:59Z') != null);

  // A BOUND IS STRICTER THAN A JOURNAL INSTANT, because it decides which rows are read.
  // `timestamptz` carries microseconds, and `Date.parse` drops them without a word: the window
  // sent to PostgREST would not be the one that was typed.
  ok('a sub-millisecond bound is refused rather than truncated', parseWindowBound('2026-08-12T00:00:00.123456Z') === null);
  ok('three fractional digits are fine', parseWindowBound('2026-08-12T00:00:00.123Z') === Date.parse('2026-08-12T00:00:00.123Z'));
  ok(
    'while a journal instant keeps the permissive parser — the database renders six digits on every row',
    canonicalInstant('2026-08-22T03:15:49.556954+00:00') === '2026-08-22T03:15:49.556Z',
  );
  assert.throws(
    () =>
      parseWindow(
        ['--from', '2026-08-12T00:00:00.123456Z', '--cutoff', '2026-08-20T00:00:00Z'],
        Date.parse('2026-08-22T12:00:00.000Z'),
      ),
    WindowError,
  );
  ok('and the CLI refuses it', true);

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

  // THE COUNT IS NOT THE SET. A cycle from a previous universe of the same cardinality — one
  // retired asset in, one current asset missing — passes a cardinality test while every gate and
  // stop summary downstream covers the wrong lines.
  const retiredAsset = buildSnapshot(
    {
      decisions: [decisionRow({ id: 806, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z' })],
      observations: [...UNIVERSE.slice(1), 'LTC'].map((asset) =>
        observationRow({ decisionId: 806, asset, barAt: '2026-08-12T00:00:00.000Z' }),
      ),
      executions: [],
    },
    window,
    UNIVERSE,
  );
  ok(
    'a verdict set of the right SIZE but the wrong assets fails too',
    retiredAsset.summary.population.transition_verdicts === UNIVERSE.length &&
      !named(retiredAsset, 'transition_verdicts_are_complete_or_absent').ok,
  );

  const corrupted = buildSnapshot(
    {
      decisions: [
        decisionRow({
          id: 807,
          at: '2026-08-12T00:10:00.000Z',
          barAt: '2026-08-12T00:00:00.000Z',
          target: { BTC: 'twenty', ETH: 10, BNB: 0, XRP: 0, USDT: 70 } as unknown as Record<string, number>,
        }),
      ],
      observations: [],
      executions: [],
    },
    window,
    UNIVERSE,
  );
  ok('an unreadable allocation weight fails its own check', !named(corrupted, 'allocations_are_fully_readable').ok);
  ok(
    '…and it would have passed the exposure check on the survivors alone',
    named(corrupted, 'decided_cycles_carry_both_exposures').ok,
  );

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

// ── PROOF 16 — a journal that moves under the read is refused ────────────────────────
console.log('Proof 16 — a reset landing mid-extraction cannot seal a torn snapshot:');
{
  const window = windowOf('2026-08-12T00:00:00.000Z', '2026-08-13T00:00:00.000Z');
  const decisions = [decisionRow({ id: 900, at: '2026-08-12T00:10:00.000Z', barAt: '2026-08-12T00:00:00.000Z' })];

  const intact = await readWindow(fakeClient([decisions, [], [], [{ id: 900 }]]), window);
  ok('an intact read returns its window', intact.decisions.length === 1);

  // `reset_bot` truncates decisions, verdicts and executions in ONE transaction. Landing
  // between the reads, it leaves decisions in hand whose children are already gone — and the
  // integrity checks would pass, because zero verdicts and zero movements are both legal.
  await assert.rejects(() => readWindow(fakeClient([decisions, [], [], []]), window), ReadError);
  ok('a window emptied under the read is refused, not sealed', true);

  await assert.rejects(
    () => readWindow(fakeClient([decisions, [], [], [{ id: 901 }]]), window),
    ReadError,
  );
  ok('and so is one whose identities changed — a truncate never reproduces an id', true);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────

/**
 * A PostgREST stub: one queued response per query, in call order.
 *
 * The builder is a thenable that ignores every filter, which is exactly right here — this
 * proof is about what `readWindow` does with the ROWS it gets back across three separate
 * requests, not about the filters it sends.
 */
function fakeClient(responses: readonly unknown[][]): SupabaseClient {
  let call = 0;
  const query = (): unknown => {
    const payload = responses[call] ?? [];
    call += 1;
    const builder: Record<string, unknown> = {
      then: (onOk: (value: { data: unknown; error: null }) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: payload, error: null }).then(onOk, onErr),
    };
    for (const method of ['select', 'gte', 'lt', 'lte', 'order', 'range']) {
      builder[method] = () => builder;
    }
    return builder;
  };
  return { from: () => query() } as unknown as SupabaseClient;
}

/**
 * A directory link, portably.
 *
 * Windows refuses a plain directory symlink without elevation but accepts a JUNCTION, which
 * resolves identically under `realpathSync`. The distinction is the platform's, not the
 * observer's: the check it exercises never learns which of the two it followed.
 */
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

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
