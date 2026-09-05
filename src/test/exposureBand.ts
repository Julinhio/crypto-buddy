import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  config,
  resolveExposureBandMode,
  validateExposureBandConfig,
  type AppConfig,
  type ExposureBandConfig,
} from '../config/index.js';
import { ARMS } from '../calibration/exposure/arms.js';
import { readContext } from '../calibration/exposure/controller.js';
import { toRegimeJournal, type AssetRegime, type RegimePoint } from '../market/regime.js';
import { regimePointFromJournal } from '../market/regimeJournal.js';
import type { TransitionGate } from '../transition/gate.js';
import { assessBand, capabilityOf, exposureOf, type AssessBandInput } from '../exposure/band.js';
import { checkBarIntegrity, observeBand, type BandObservationInsert } from '../exposure/observe.js';

/**
 * THE PROOFS OF THE EXPOSURE BAND — brick 1 of the constrained-exposure pilot.
 *
 * No network, no database, no LLM, no clock. Everything is a fixture.
 *
 * Ordered by what they defend. The three that matter most are the ones this brick would fail
 * SILENTLY: a band that quietly stopped matching the calibrated one, an `off` mode that turned
 * out not to be inert, and a per-bar integrity check that reported instead of failing.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ─────────────────────────────────────────────────────
 *
 * Brick 1 ASSESSES; it does not correct. So the precedence contract is proven at the level
 * this brick reaches — what the correction would be ALLOWED to touch, and what bound it could
 * therefore reach — and not at the level of the per-asset redistribution, which does not exist
 * yet. Each invariant below names which half it is proving, so nobody reads a feasibility
 * proof as a redistribution proof.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

const ROOT = process.cwd();
const UNIVERSE = ['BNB', 'BTC', 'ETH', 'XRP'];
const RESERVE = 'USDT';

// ── fixtures ─────────────────────────────────────────────────────────────────────────

const CAPS: Record<string, number> = { BTC: 35, ETH: 35, BNB: 20, XRP: 15 };
const capOf = (asset: string): number => CAPS[asset] ?? 15;

function gates(map: Record<string, TransitionGate>): Map<string, TransitionGate> {
  return new Map(Object.entries(map));
}

/** Every asset actionable — the ordinary cycle, where the band is unconstrained. */
const ALL_ACTIONABLE = gates({ BTC: 'actionable', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' });

function input(over: Partial<AssessBandInput> = {}): AssessBandInput {
  return {
    policyVersion: 'A',
    policy: config.exposureBand,
    state: 'constructive',
    targetAllocation: { BTC: 10, ETH: 10, BNB: 0, XRP: 0, USDT: 80 },
    rawAllocation: null,
    bookExposurePercent: 20,
    reserveAsset: RESERVE,
    gateByAsset: ALL_ACTIONABLE,
    capOf,
    maxDeployablePercent: 70,
    equityQuote: 1000,
    movementFloorQuote: 20,
    stoppedWeightSurvives: true,
    ...over,
  };
}

function journalOf(
  barAt: string,
  regimes: Record<string, AssetRegime>,
  opts: { riskOff?: boolean } = {},
): RegimePoint {
  const riskOff = opts.riskOff ?? false;
  const assets: RegimePoint['assets'] = {};
  for (const [asset, regime] of Object.entries(regimes)) {
    assets[asset] = {
      regime,
      raw: regime,
      pendingBars: 0,
      pendingRegime: null,
      bearish: false,
      signals: { close: 100 } as RegimePoint['assets'][string]['signals'],
    };
  }
  return {
    timestamp: Date.parse(barAt),
    at: barAt,
    global: {
      riskOff,
      raw: riskOff,
      breadthPercent: 0,
      medianH4Rsi: 50,
      assetsPresent: Object.keys(regimes).length,
      assetsExpected: 4,
      pendingBars: 0,
    },
    assets,
  };
}

const BULL: Record<string, AssetRegime> = { BTC: 'trend_up', ETH: 'trend_up', BNB: 'range', XRP: 'range' };
const FLAT: Record<string, AssetRegime> = { BTC: 'range', ETH: 'range', BNB: 'range', XRP: 'range' };

// ── PROOF 1 — the band IS the calibrated one, not a band that looks like it ──────────
console.log('Proof 1 — the six bounds are numerically identical to ARMS.A:');
{
  const mine = config.exposureBand;
  const theirs = ARMS.A!;
  for (const state of ['defensive', 'neutral', 'constructive'] as const) {
    ok(
      `${state}: [${mine[state].lowPercent}, ${mine[state].highPercent}] equals the harness's arm A`,
      mine[state].lowPercent === theirs[state].lowPercent &&
        mine[state].highPercent === theirs[state].highPercent,
    );
  }
  // The point of the assertion: production configures the band itself rather than importing
  // `arms.ts`, which would drag the whole calibration harness — engine, tape, metrics — into
  // the bot's module graph for four numbers. "Reprises du harnais" therefore has to be a
  // proof, and this is it.
  // `beat.ts` is the bot's real entry point — the one Railway's cron calls, and the only one
  // that reaches `decide()`. `index.ts` merely prints a market context.
  const graph = moduleGraph(path.join(ROOT, 'src/beat.ts'));
  ok(
    'the band IS reachable from the bot\'s entry point',
    graph.has(path.resolve(ROOT, 'src/exposure/band.ts')),
  );
  ok(
    'and arms.ts is NOT — the harness stays out of the bot',
    !graph.has(path.resolve(ROOT, 'src/calibration/exposure/arms.ts')),
  );
  for (const harnessFile of ['engine.ts', 'tape.ts', 'metrics.ts', 'allocate.ts', 'calibrate.ts']) {
    ok(
      `nor is the harness's ${harnessFile}`,
      !graph.has(path.resolve(ROOT, 'src/calibration/exposure', harnessFile)),
    );
  }
  // The ONE harness file production does import, deliberately: `readContext` lives there and
  // is a pure leaf (its only imports are types). Importing it is what makes the context
  // definition shared rather than re-implemented.
  ok(
    'the single exception is controller.ts, where readContext lives',
    graph.has(path.resolve(ROOT, 'src/calibration/exposure/controller.ts')),
  );
}

// ── PROOF 2 — the mode switch, and the value this build refuses ─────────────────────
console.log('\nProof 2 — EXPOSURE_BAND_MODE: absence is safe, and `application` cannot be armed yet:');
{
  ok('unset resolves to off', resolveExposureBandMode(undefined) === 'off');
  ok('empty resolves to off', resolveExposureBandMode('   ') === 'off');
  ok('off resolves to off', resolveExposureBandMode('off') === 'off');
  ok('observation resolves to observation', resolveExposureBandMode('observation') === 'observation');

  // THE ONE THAT MATTERS. The switch from observation to application is the pilot's official
  // start — its equity, its high-water mark and its eight-week clock all begin there, and it
  // can be spent exactly once. The witnesses and the circuit breaker are not in this build,
  // so the value is refused by the BINARY rather than by discipline.
  let applicationError = '';
  try {
    resolveExposureBandMode('application');
  } catch (err) {
    applicationError = err instanceof Error ? err.message : String(err);
  }
  ok('application is REFUSED by this build', applicationError !== '');
  ok(
    'and it says why, rather than reading as a typo',
    applicationError.includes('not a legal value in this build') &&
      applicationError.includes('witnesses') &&
      applicationError.includes('circuit breaker'),
  );

  for (const bad of ['Observation', 'ON', 'true', 'enforce', 'observe']) {
    let threw = false;
    try {
      resolveExposureBandMode(bad);
    } catch {
      threw = true;
    }
    ok(`a present-but-unrecognised value ("${bad}") fails the boot rather than defaulting`, threw);
  }
}

// ── PROOF 3 — the band configuration is bounded at boot ─────────────────────────────
console.log('\nProof 3 — a band that could not behave fails the boot:');
{
  const base = config.exposureBand;
  const bad = (over: Partial<ExposureBandConfig>): string => {
    try {
      validateExposureBandConfig({ ...base, ...over });
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  ok('the shipped band passes', bad({}) === '');
  ok('an inverted band is refused', bad({ neutral: { lowPercent: 50, highPercent: 20 } }).includes('must not exceed'));
  ok('a bound outside [0, 100] is refused', bad({ neutral: { lowPercent: -1, highPercent: 45 } }).includes('must be in [0, 100]'));
  ok('an empty version is refused', bad({ version: '  ' }).includes('non-empty'));

  // THE CHECK ONLY PRODUCTION CAN MAKE. The cash floor bounds total exposure at 70%, so a
  // floor above that could never be reached on ANY cycle — the correction would journal a
  // shortfall forever, and nobody could tell a policy that cannot be satisfied from a market
  // that never allowed it.
  const overDeployable = bad({ constructive: { lowPercent: 80, highPercent: 90 } });
  ok(
    'a floor above what the cash floor allows to be deployed is refused, with the arithmetic named',
    overDeployable.includes('above the 70%') && overDeployable.includes('could never be reached'),
  );

  // And the redundancy that is NOT an error: the constructive ceiling equals the deployable
  // maximum exactly. Structural, published, and deliberately not "fixed".
  ok(
    'the constructive ceiling equals 100 − minCashPercent — a structural redundancy, not a defect',
    base.constructive.highPercent === 100 - config.execution.caps.minCashPercent,
  );
}

// ── PROOF 4 — exposure is the SUM of the non-reserve weights ────────────────────────
console.log('\nProof 4 — exposure is Σ non-reserve, never 100 − reserve:');
{
  const whole = exposureOf({ BTC: 20, ETH: 10, USDT: 70 }, RESERVE);
  ok('on an allocation totalling 100 the two readings coincide', whole.exposurePercent === 30 && whole.sumPercent === 100);

  // A malformed allocation is where they diverge, and the SUM is the honest one: subtracting
  // from a hundred that does not exist fabricates exposure out of a missing key.
  const torn = exposureOf({ BTC: 20, ETH: 10, USDT: 40 }, RESERVE);
  ok('on a torn one the sum is reported, not assumed', torn.exposurePercent === 30 && torn.sumPercent === 70);
  ok('and 100 − reserve would have claimed 60 — which is why it is not used', 100 - 40 !== torn.exposurePercent);

  // `Number(null)` is 0 and would publish a real, zero-weight line, silently shrinking the
  // exposure the band is measured against.
  const mangled = exposureOf({ BTC: 20, ETH: null as unknown as number, USDT: 80 }, RESERVE);
  ok('a non-finite weight is skipped, never coerced to zero', mangled.exposurePercent === 20);
}

// ── PROOF 5 — the freeze contract, line by line ─────────────────────────────────────
console.log('\nProof 5 — the correction may not create an order on a line the layer froze:');
{
  ok('actionable — both ways', capabilityOf('actionable').mayIncrease && capabilityOf('actionable').mayDecrease);
  // Rung 2 of the ladder, mirrored exactly: a confirmed risk_off lifts the freeze FOR
  // REDUCTIONS ONLY. Anything else would let the code buy under a global de-risk.
  ok(
    'risk_off_reduction — reductions only, exactly as judgeOrder rules',
    !capabilityOf('risk_off_reduction').mayIncrease && capabilityOf('risk_off_reduction').mayDecrease,
  );
  ok('frozen — neither', !capabilityOf('frozen').mayIncrease && !capabilityOf('frozen').mayDecrease);
  // FAILS CLOSED, mirroring applyGate's treatment of an unjudged strategic leg. Absence of a
  // reading is not permission — least of all for an order the code invents.
  ok('no_regime — neither: absence of a reading is not permission', !capabilityOf('no_regime').mayIncrease && !capabilityOf('no_regime').mayDecrease);
  ok('stop_exit — neither: the stop owns that line for the cycle', !capabilityOf('stop_exit').mayIncrease && !capabilityOf('stop_exit').mayDecrease);
}

// ── PROOF 6 — the cases that MUST PASS ─────────────────────────────────────────────
//
// This counts as much as the cases that must block. A correction that bit on every cycle
// would turn the pilot into a permanent forced intervention, and this project has already
// had a failure of that family.
console.log('\nProof 6 — a target inside its band is left completely alone:');
{
  const inside = assessBand(input({ targetAllocation: { BTC: 30, ETH: 20, USDT: 50 } }));
  ok('a constructive target at 50% sits inside [45, 70]', inside.targetExposurePercent === 50);
  ok('the direction is none', inside.direction === 'none');
  ok('the label is aucune_correction', inside.label === 'aucune_correction');
  ok('nothing is required', inside.requiredPoints === 0 && inside.requiredExposurePercent === null);
  ok('and the attainable exposure IS the target — the band moved nothing', inside.feasibility.attainableExposurePercent === 50);
  ok('so the move is worth nothing and clears no floor', inside.attainableNotionalQuote === 0 && inside.clearsMovementFloor === false);

  // The boundaries belong to the band: both bounds are inclusive, so a target exactly on one
  // is inside. A strict comparison would generate a correction on the very value the band
  // was just moved to, every cycle, forever.
  for (const [label, weight] of [['the floor', 45], ['the ceiling', 70]] as const) {
    const edge = assessBand(input({ targetAllocation: { BTC: 35, ETH: weight - 35, USDT: 100 - weight } }));
    ok(`a target exactly on ${label} (${weight}%) is inside the band`, edge.direction === 'none');
  }

  // A neutral target at 30 is inside [20, 45] — the ordinary quiet cycle.
  const neutral = assessBand(input({ state: 'neutral', targetAllocation: { BTC: 20, ETH: 10, USDT: 70 } }));
  ok('a neutral target at 30% sits inside [20, 45] and is untouched', neutral.direction === 'none');
}

// ── PROOF 7 — the ordinary corrections, both ways ──────────────────────────────────
console.log('\nProof 7 — the two ordinary corrections:');
{
  const up = assessBand(input({ targetAllocation: { BTC: 10, ETH: 10, USDT: 80 } }));
  ok('a constructive target at 20% is below the 45% floor', up.direction === 'up' && up.requiredExposurePercent === 45);
  ok('25 points are required', up.requiredPoints === 25);
  ok('and they are fully reachable — 4 actionable lines, 105 points of cap', up.label === 'hausse_vers_plancher');
  ok('the correction is worth 25% of a 1000 equity = 250', up.attainableNotionalQuote === 250);
  ok('which clears the 20 floor', up.clearsMovementFloor === true);

  const down = assessBand(
    input({ state: 'neutral', targetAllocation: { BTC: 35, ETH: 25, USDT: 40 } }),
  );
  ok('a neutral target at 60% is above the 45% ceiling', down.direction === 'down' && down.requiredExposurePercent === 45);
  ok('15 points must come off', down.requiredPoints === 15);
  ok('and they can, since both lines are reducible', down.label === 'baisse_vers_plafond');
}

// ── PROOF 8 — the precedence invariants, at the level brick 1 reaches ──────────────
//
// Feasibility, not redistribution: brick 1 answers "what bound could the correction have
// reached", brick 2 answers "which asset gets which point". Each case names its half.
console.log('\nProof 8 — the precedence invariants (feasibility half):');
{
  // (a) UNREACHABLE FLOOR — the actionable lines do not carry enough cap.
  const unreachable = assessBand(
    input({
      targetAllocation: { BTC: 5, ETH: 5, BNB: 0, XRP: 0, USDT: 90 },
      gateByAsset: gates({ BTC: 'frozen', ETH: 'frozen', BNB: 'actionable', XRP: 'actionable' }),
    }),
  );
  // Reserved: BTC 5 + ETH 5 = 10 frozen. Capacity: BNB 20 + XRP 15 = 35. Max = 45… exactly.
  ok('[borne inatteignable] two frozen lines leave max reachable at 45', unreachable.feasibility.maxReachablePercent === 45);
  ok('which happens to be the floor exactly, so nothing is lost', unreachable.label === 'hausse_vers_plancher');

  // Tighten it: freeze BNB too, and the floor genuinely becomes unreachable.
  const trulyUnreachable = assessBand(
    input({
      targetAllocation: { BTC: 5, ETH: 5, BNB: 0, XRP: 0, USDT: 90 },
      gateByAsset: gates({ BTC: 'frozen', ETH: 'frozen', BNB: 'frozen', XRP: 'actionable' }),
    }),
  );
  ok('[borne inatteignable] freezing BNB drops max reachable to 25', trulyUnreachable.feasibility.maxReachablePercent === 25);
  ok('the label says so', trulyUnreachable.label === 'bande_partiellement_irrealisable');
  ok('20 points are journaled as out of reach', trulyUnreachable.feasibility.unrealisablePoints === 20);
  ok('the correction still executes the maximum feasible, it does not give up', trulyUnreachable.feasibility.attainableExposurePercent === 25);
  ok('and it never lifts the freeze to get there', trulyUnreachable.feasibility.increasableAssets.join(',') === 'XRP');

  // (b) A FROZEN ASSET BLOCKS THE REPORT — no actionable line at all.
  const nowhereToGo = assessBand(
    input({
      targetAllocation: { BTC: 10, ETH: 10, BNB: 0, XRP: 0, USDT: 80 },
      gateByAsset: gates({ BTC: 'frozen', ETH: 'frozen', BNB: 'frozen', XRP: 'no_regime' }),
    }),
  );
  ok('[actif gelé bloquant le report] no line may increase', nowhereToGo.feasibility.increasableAssets.length === 0);
  ok('so the target cannot move at all', nowhereToGo.feasibility.attainableExposurePercent === 20);
  ok('the whole 25 points are journaled as out of reach', nowhereToGo.feasibility.unrealisablePoints === 25);
  ok('and the cycle is labelled irrealisable rather than silently corrected', nowhereToGo.label === 'bande_partiellement_irrealisable');

  // (c) FROZEN LINES ALREADY ABOVE THE CEILING — §3.6.3.
  const frozenAboveCeiling = assessBand(
    input({
      state: 'neutral',
      targetAllocation: { BTC: 35, ETH: 20, BNB: 5, XRP: 0, USDT: 40 },
      gateByAsset: gates({ BTC: 'frozen', ETH: 'frozen', BNB: 'actionable', XRP: 'actionable' }),
    }),
  );
  // Frozen BTC 35 + ETH 20 = 55, already above the 45 ceiling on their own.
  ok('[lignes gelées au-dessus du plafond] the irreducible floor is 55', frozenAboveCeiling.feasibility.minReachablePercent === 55);
  ok('every authorised reduction still runs — BNB goes to zero', frozenAboveCeiling.feasibility.attainableExposurePercent === 55);
  ok('and the 10-point overshoot is journaled, not hidden', frozenAboveCeiling.feasibility.unrealisablePoints === 10);
  ok('labelled irrealisable', frozenAboveCeiling.label === 'bande_partiellement_irrealisable');

  // (d) NON-REDUCIBLE EXPOSURE under a confirmed risk_off — rung 2 lifts the freeze for
  // reductions, so exposure that looked trapped becomes reducible. The one direction a
  // transition must never be able to block is the book getting smaller.
  const riskOff = assessBand(
    input({
      state: 'defensive',
      targetAllocation: { BTC: 25, ETH: 15, BNB: 0, XRP: 0, USDT: 60 },
      gateByAsset: gates({ BTC: 'risk_off_reduction', ETH: 'risk_off_reduction', BNB: 'risk_off_reduction', XRP: 'risk_off_reduction' }),
    }),
  );
  ok('[exposition non réductible] a defensive target at 40% is above the 20% ceiling', riskOff.direction === 'down');
  ok('risk_off_reduction keeps every line reducible, so the ceiling IS reachable', riskOff.feasibility.minReachablePercent === 0);
  ok('and the correction is fully feasible', riskOff.label === 'baisse_vers_plafond' && riskOff.feasibility.unrealisablePoints === 0);
  ok('while no line may be increased under a confirmed risk_off', riskOff.feasibility.increasableAssets.length === 0);

  // (e) THE SUB-FLOOR CORRECTION — certainly inert. Whether a larger one survives the split
  // into legs is brick 2's question; this proves only the necessary half.
  const tiny = assessBand(
    input({ state: 'neutral', targetAllocation: { BTC: 19, ETH: 0, USDT: 81 }, equityQuote: 1000, movementFloorQuote: 20 }),
  );
  ok('[reliquat sous le seuil] a 1-point correction on a 1000 book is worth 10', tiny.attainableNotionalQuote === 10);
  ok('below the 20 floor, so it is certainly inert', !tiny.clearsMovementFloor);
  ok('but it is still labelled a correction — the band asked, the plumbing refused', tiny.label === 'hausse_vers_plancher');

  // (f) AN UNJUDGED LINE FAILS CLOSED AND IS NAMED.
  const unjudged = assessBand(
    input({ targetAllocation: { BTC: 10, ETH: 10, SOL: 5, USDT: 75 }, gateByAsset: ALL_ACTIONABLE }),
  );
  ok('[ligne non jugée] an asset with no verdict is named', unjudged.feasibility.unjudgedAssets.join(',') === 'SOL');
  ok('and it may be neither increased nor decreased', !unjudged.feasibility.increasableAssets.includes('SOL'));
  ok('its weight is reserved rather than spent', unjudged.feasibility.reservedUpPercent === 5);

  // (g) A PEAK-STOPPED LINE, under both transition modes.
  const stoppedObserve = assessBand(
    input({
      targetAllocation: { BTC: 20, ETH: 10, USDT: 70 },
      gateByAsset: gates({ BTC: 'stop_exit', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' }),
      stoppedWeightSurvives: true,
    }),
  );
  ok('[ligne stoppée] under observe the stop generates no exit, so the weight stands', stoppedObserve.targetExposurePercent === 30);
  ok('and it is published as stopped weight', stoppedObserve.stoppedWeightPercent === 20);
  const stoppedEnforce = assessBand(
    input({
      targetAllocation: { BTC: 20, ETH: 10, USDT: 70 },
      gateByAsset: gates({ BTC: 'stop_exit', ETH: 'actionable', BNB: 'actionable', XRP: 'actionable' }),
      stoppedWeightSurvives: false,
    }),
  );
  ok('under enforce applyGate is about to flatten it, so the band sizes against 10%', stoppedEnforce.targetExposurePercent === 10);
  ok('sizing against the liquidating line would have understated the correction by 20 points', stoppedEnforce.requiredPoints === 35 && stoppedObserve.requiredPoints === 15);
}

// ── PROOF 9 — the deployable ceiling is inherited, never spent ─────────────────────
console.log('\nProof 9 — the cash floor bounds the correction like everything else:');
{
  const greedy = assessBand(
    input({
      state: 'constructive',
      targetAllocation: { BTC: 10, ETH: 10, BNB: 0, XRP: 0, USDT: 80 },
      maxDeployablePercent: 70,
    }),
  );
  // Capacity alone is 105 points of cap; the deployable ceiling clips it to 70.
  ok('105 points of cap are clipped to the 70% the cash floor allows', greedy.feasibility.maxReachablePercent === 70);
  ok('the floor at 45 is reachable within it', greedy.label === 'hausse_vers_plancher');
}

// ── PROOF 10 — the live point and the rehydrated journal read the same context ─────
//
// The live cycle calls `readContext` on production's own `RegimePoint`; the historical replay
// reaches it through `regimePointFromJournal`. If those two ever disagreed, the checkpoint
// would be measuring a different context than the one the bot will run under.
console.log('\nProof 10 — live and replay read the same context from the same bar:');
{
  for (const [label, point] of [
    ['a bullish bar', journalOf('2026-08-12T00:00:00.000Z', BULL)],
    ['a flat bar', journalOf('2026-08-12T04:00:00.000Z', FLAT)],
    ['a risk_off bar', journalOf('2026-08-12T08:00:00.000Z', BULL, { riskOff: true })],
    ['a partial bar', journalOf('2026-08-12T12:00:00.000Z', { BTC: 'trend_up', ETH: 'trend_down' })],
  ] as const) {
    const live = readContext(point, UNIVERSE);
    const replayed = readContext(regimePointFromJournal(toRegimeJournal(point)), UNIVERSE);
    ok(
      `${label}: the two readings are identical (${live.state})`,
      JSON.stringify(live) === JSON.stringify(replayed),
    );
  }
  // The states the band depends on, reached through the real function rather than asserted.
  ok('a bullish majority reads constructive', readContext(journalOf('2026-08-12T00:00:00.000Z', BULL), UNIVERSE).state === 'constructive');
  ok('a flat market reads neutral', readContext(journalOf('2026-08-12T00:00:00.000Z', FLAT), UNIVERSE).state === 'neutral');
  ok(
    'and a confirmed risk_off reads defensive even under a bullish majority',
    readContext(journalOf('2026-08-12T00:00:00.000Z', BULL, { riskOff: true }), UNIVERSE).state === 'defensive',
  );
}

// ── PROOF 11 — a cycle never drops out of the population ──────────────────────────
console.log('\nProof 11 — a cycle without a context or without a target keeps its row:');
{
  const base = {
    decisionId: 1,
    mode: 'observation',
    policyVersion: 'A',
    policy: config.exposureBand,
    universe: UNIVERSE,
    rawAllocation: null,
    bookExposurePercent: 20,
    reserveAsset: RESERVE,
    gateByAsset: ALL_ACTIONABLE,
    capOf,
    maxDeployablePercent: 70,
    equityQuote: 1000,
    movementFloorQuote: 20,
    stoppedWeightSurvives: true,
  };

  const noRegime = observeBand({ ...base, regimePoint: null, targetAllocation: { BTC: 10, USDT: 90 } });
  ok('a cycle with no regime still produces a row', noRegime.decision_id === 1);
  ok('with the gap named', noRegime.gap === 'no_regime');
  ok('and NO state — absence never becomes neutral', noRegime.state === null);
  ok('nor a fabricated band', noRegime.band_low_percent === null && noRegime.label === null);

  const noTarget = observeBand({
    ...base,
    regimePoint: journalOf('2026-08-12T00:00:00.000Z', BULL),
    targetAllocation: null,
  });
  ok('a cycle with no target keeps its CONTEXT', noTarget.state === 'constructive' && noTarget.bar_at != null);
  ok('which is what lets its bar still be counted for coverage', noTarget.context_fingerprint != null);
  ok('while the gap says why there is no assessment', noTarget.gap === 'no_target' && noTarget.label === null);

  // The database constraint restated as a property of the builder: a row carries an
  // assessment OR a reason, never neither and never both.
  const assessed = observeBand({
    ...base,
    regimePoint: journalOf('2026-08-12T00:00:00.000Z', BULL),
    targetAllocation: { BTC: 10, ETH: 10, USDT: 80 },
  });
  for (const [label, row] of [['no_regime', noRegime], ['no_target', noTarget], ['assessed', assessed]] as const) {
    ok(`${label}: exactly one of (label, gap) is set`, (row.label == null) === (row.gap != null));
  }
  ok('and the assessed row carries the correction', assessed.label === 'hausse_vers_plancher' && assessed.required_points === 25);
}

// ── PROOF 12 — the per-bar integrity check FAILS, it does not report ──────────────
console.log('\nProof 12 — two cycles of one 4h bar disagreeing on the context is a failure:');
{
  const row = (id: number, barAt: string | null, fingerprint: string | null): BandObservationInsert =>
    ({ decision_id: id, bar_at: barAt, context_fingerprint: fingerprint }) as BandObservationInsert;

  const stable = [
    row(1, '2026-08-12T00:00:00.000Z', 'A'),
    row(2, '2026-08-12T00:00:00.000Z', 'A'),
    row(3, '2026-08-12T04:00:00.000Z', 'B'),
  ];
  ok('a stable bar produces no finding', checkBarIntegrity(stable).length === 0);

  // THE FABRICATED CASE the protocol demands. The first cycle of a bar is the unit of
  // analysis; if it could mask a disagreement, the pilot would count a bar in one family
  // while the bot spent most of it in the other.
  const unstable = [
    row(1, '2026-08-12T00:00:00.000Z', 'A'),
    row(2, '2026-08-12T00:00:00.000Z', 'B'),
    row(3, '2026-08-12T04:00:00.000Z', 'C'),
  ];
  const findings = checkBarIntegrity(unstable);
  ok('a bar carrying two contexts IS a finding', findings.length === 1);
  ok('it names the bar', findings[0]!.barAt === '2026-08-12T00:00:00.000Z');
  ok('it names both cycles', findings[0]!.decisionIds.join(',') === '1,2');
  ok('and both variants', findings[0]!.fingerprints.join(',') === 'A,B');

  // A cycle with no context is not a disagreement — it has nothing to disagree with. Counted
  // apart by the caller, never folded in.
  const withHole = [
    row(1, '2026-08-12T00:00:00.000Z', 'A'),
    row(2, '2026-08-12T00:00:00.000Z', null),
    row(3, null, null),
  ];
  ok('a cycle with no fingerprint does not fabricate an instability', checkBarIntegrity(withHole).length === 0);

  // And the fingerprint covers the WHOLE reading: two opposite drifts inside one bar cancel
  // in the aggregates, so a digest built on counts alone would pass this.
  const bar = '2026-08-12T00:00:00.000Z';
  const a = observeBand({
    decisionId: 1, mode: 'observation', policyVersion: 'A', policy: config.exposureBand,
    regimePoint: journalOf(bar, { BTC: 'trend_up', ETH: 'trend_down', BNB: 'range', XRP: 'range' }),
    universe: UNIVERSE, targetAllocation: { BTC: 10, USDT: 90 }, rawAllocation: null,
    bookExposurePercent: 10, reserveAsset: RESERVE, gateByAsset: ALL_ACTIONABLE, capOf,
    maxDeployablePercent: 70, equityQuote: 1000, movementFloorQuote: 20, stoppedWeightSurvives: true,
  });
  const b = observeBand({
    decisionId: 2, mode: 'observation', policyVersion: 'A', policy: config.exposureBand,
    regimePoint: journalOf(bar, { BTC: 'trend_down', ETH: 'trend_up', BNB: 'range', XRP: 'range' }),
    universe: UNIVERSE, targetAllocation: { BTC: 10, USDT: 90 }, rawAllocation: null,
    bookExposurePercent: 10, reserveAsset: RESERVE, gateByAsset: ALL_ACTIONABLE, capOf,
    maxDeployablePercent: 70, equityQuote: 1000, movementFloorQuote: 20, stoppedWeightSurvives: true,
  });
  ok('the two bars read the same state and the same net breadth', a.state === b.state && a.net_breadth === b.net_breadth);
  // NOT a finding, and deliberately so. The fingerprint covers the CONTROLLER'S READING, which
  // is what the protocol calls "the context": a per-asset swap that leaves the reading
  // identical leaves the band identical too, so there is nothing for the pilot to be
  // inconsistent about. Flagging it would fail runs over a difference the band cannot see.
  ok('a per-asset swap that leaves the reading identical is correctly not a finding', checkBarIntegrity([a, b]).length === 0);

  // What the fingerprint MUST catch is a swap that moves the reading — and the realistic case
  // is not a swap at all but a partial market-data loss inside one bar, which changes
  // `unavailable`, hence the breadth numerator, hence potentially the state itself.
  const partial = observeBand({
    decisionId: 3, mode: 'observation', policyVersion: 'A', policy: config.exposureBand,
    regimePoint: journalOf(bar, { BTC: 'trend_up', ETH: 'trend_down', BNB: 'range' }),
    universe: UNIVERSE, targetAllocation: { BTC: 10, USDT: 90 }, rawAllocation: null,
    bookExposurePercent: 10, reserveAsset: RESERVE, gateByAsset: ALL_ACTIONABLE, capOf,
    maxDeployablePercent: 70, equityQuote: 1000, movementFloorQuote: 20, stoppedWeightSurvives: true,
  });
  ok('losing one asset mid-bar changes the reading (unavailable moves)', partial.unavailable === 1 && a.unavailable === 0);
  ok('and THAT is a finding — the bar is not internally consistent', checkBarIntegrity([a, partial]).length === 1);

  // The one that would actually move a family, and therefore the pilot's stop date: a bar
  // whose state is not the same at both wake-ups.
  const flipped = observeBand({
    decisionId: 4, mode: 'observation', policyVersion: 'A', policy: config.exposureBand,
    regimePoint: journalOf(bar, BULL, { riskOff: true }),
    universe: UNIVERSE, targetAllocation: { BTC: 10, USDT: 90 }, rawAllocation: null,
    bookExposurePercent: 10, reserveAsset: RESERVE, gateByAsset: ALL_ACTIONABLE, capOf,
    maxDeployablePercent: 70, equityQuote: 1000, movementFloorQuote: 20, stoppedWeightSurvives: true,
  });
  const constructive = observeBand({
    decisionId: 5, mode: 'observation', policyVersion: 'A', policy: config.exposureBand,
    regimePoint: journalOf(bar, BULL),
    universe: UNIVERSE, targetAllocation: { BTC: 10, USDT: 90 }, rawAllocation: null,
    bookExposurePercent: 10, reserveAsset: RESERVE, gateByAsset: ALL_ACTIONABLE, capOf,
    maxDeployablePercent: 70, equityQuote: 1000, movementFloorQuote: 20, stoppedWeightSurvives: true,
  });
  ok('a bar read defensive at one wake-up and constructive at another', flipped.state === 'defensive' && constructive.state === 'constructive');
  ok('fails the check loudly — the first cycle must not be allowed to mask it', checkBarIntegrity([constructive, flipped]).length === 1);
}

// ── PROOF 13 — `off` is inert, and `observation` cannot reach an order ────────────
console.log('\nProof 13 — the band cannot change what the bot does:');
{
  const decide = readFileSync(path.join(ROOT, 'src/decision/decide.ts'), 'utf8');

  // (a) THE FIRST STATEMENT of the closure is the off-switch. Not "somewhere in it".
  const closure = decide.slice(decide.indexOf('const observeExposureBand'));
  const body = closure.slice(closure.indexOf('): Promise<void> => {'));
  ok(
    'off mode returns before anything is computed or written',
    /^\): Promise<void> => \{\s*(?:\/\/[^\n]*\n\s*)*if \(EXPOSURE_BAND_MODE === 'off'\) return;/.test(body),
  );

  // (b) THE RETURN TYPE is void, so no allocation, movement or order can be derived from it.
  // This is the structural half of "it creates nothing": a caller cannot use what it cannot
  // receive.
  ok('the closure returns void — nothing downstream can read a band decision', body.startsWith('): Promise<void> => {'));

  // (c) NO CALL SITE assigns it. A `const x = await observeExposureBand(...)` would be void,
  // but the grep is the cheap guard against the shape ever changing under someone's feet.
  const callSites = [...decide.matchAll(/^.*observeExposureBand\(.*$/gm)].map((m) => m[0]!.trim());
  ok(`every call site is a bare await (${callSites.length} sites)`, callSites.filter((l) => l.startsWith('await ') || l.startsWith('const observeExposureBand')).length === callSites.length);

  // (d) IT RUNS AFTER THE ORDERS. On the decided path the observation sits after
  // `executeMovements` — the same tier as the transition observation and the equity snapshot
  // — so a stalled insert cannot burn the cycle budget and let the watchdog force-exit.
  ok(
    'on the decided path it runs after executeMovements',
    decide.indexOf('await executeMovements(') < decide.lastIndexOf('await observeExposureBand('),
  );
  ok(
    'and immediately after the transition observation, its neighbour in the same tier',
    decide.lastIndexOf('await observeTransition(') < decide.lastIndexOf('await observeExposureBand('),
  );

  // (e) NO PRODUCTION PATH READS THE BAND'S OUTPUT. The band writes; nothing reads back.
  const production = sourceFiles(path.join(ROOT, 'src')).filter(
    (file) =>
      !file.includes(`${path.sep}test${path.sep}`) &&
      !file.includes(`${path.sep}replay${path.sep}`) &&
      !file.includes(`${path.sep}exposure${path.sep}`) &&
      !file.endsWith(path.join('persistence', 'exposureBandObservations.ts')),
  );
  const readers = production.filter((file) => /exposure_band_observations/.test(readFileSync(file, 'utf8')));
  ok(
    `no production file outside the band reads its table (${readers.map((f) => path.basename(f)).join(', ') || 'none'})`,
    readers.length === 0,
  );

  // (f) THE BAND'S OWN MODULE GRAPH NAMES NO WRITE. `band.ts` and `observe.ts` are pure: the
  // only file allowed to touch the database is the writer, and it is not in their graph.
  const bandGraph = new Set([
    ...moduleGraph(path.join(ROOT, 'src/exposure/band.ts')),
    ...moduleGraph(path.join(ROOT, 'src/exposure/observe.ts')),
  ]);
  const writers = [...bandGraph].filter((file) => /\.(insert|upsert|update|delete|rpc)\s*\(|\.from\('/.test(readFileSync(file, 'utf8')));
  ok(
    `the band's own graph can build no query at all (${writers.map((f) => path.basename(f)).join(', ') || 'none'})`,
    writers.length === 0,
  );
}

// ── PROOF 14 — the assessment is pure and total ──────────────────────────────────
console.log('\nProof 14 — nothing here can fail a trading cycle:');
{
  // `readContext` THROWS on a regime its table does not classify — deliberately, so a new
  // label cannot be silently counted as neutral for months. On a live trading path that
  // throw would kill a wake-up, so it is caught and becomes a recorded fact.
  const rogue = journalOf('2026-08-12T00:00:00.000Z', FLAT);
  (rogue.assets.BTC as { regime: string }).regime = 'sideways_ish';
  const row = observeBand({
    decisionId: 1, mode: 'observation', policyVersion: 'A', policy: config.exposureBand,
    regimePoint: rogue, universe: UNIVERSE, targetAllocation: { BTC: 10, USDT: 90 },
    rawAllocation: null, bookExposurePercent: 10, reserveAsset: RESERVE,
    gateByAsset: ALL_ACTIONABLE, capOf, maxDeployablePercent: 70, equityQuote: 1000,
    movementFloorQuote: 20, stoppedWeightSurvives: true,
  });
  ok('an unclassifiable regime does not throw', row.decision_id === 1);
  ok('it is recorded as itself, never as neutral', row.gap === 'unclassifiable_regime' && row.state === null);
  ok('and the refusal keeps its explanation', (row.gap_detail ?? '').includes('sideways_ish'));

  // Determinism: same inputs, same output, twice.
  const twice = [assessBand(input()), assessBand(input())];
  ok('the assessment is deterministic', JSON.stringify(twice[0]) === JSON.stringify(twice[1]));

  // An empty allocation is a legal input with an honest answer, not a crash.
  // AN ALL-CASH TARGET, and the reason the line list is a UNION rather than the allocation's
  // own keys. §3.5.3 allocates the shortfall to "les autres actifs actionnables disposant de
  // capacité" — assets the model gave nothing to are exactly that set. Building the lines from
  // the allocation alone would report the floor as unreachable here, manufacturing a shortfall
  // out of the model's silence.
  const empty = assessBand(input({ state: 'neutral', targetAllocation: { USDT: 100 } }));
  ok('an all-cash target reads 0% exposure', empty.targetExposurePercent === 0);
  ok('and asks for the neutral floor', empty.direction === 'up' && empty.requiredPoints === 20);
  ok(
    'the four actionable lines supply their capacity even at zero weight',
    empty.feasibility.increasableAssets.join(',') === 'BNB,BTC,ETH,XRP',
  );
  ok('so the floor is reachable', empty.feasibility.maxReachablePercent === 70 && empty.label === 'hausse_vers_plancher');

  // FEASIBILITY IS UNKNOWABLE WITHOUT VERDICTS, and saying so is not the same as saying the
  // freezes blocked it. This is the fortnight of v5 that predates the transition layer.
  const noVerdicts = assessBand(input({ gateByAsset: new Map() }));
  ok('with no verdict at all, feasibility is reported unknown', noVerdicts.feasibility.known === false);
  ok('the direction and amplitude are still measured', noVerdicts.direction === 'up' && noVerdicts.requiredPoints === 25);
  ok(
    'but the label does NOT assert the band was unrealisable',
    noVerdicts.label === 'hausse_vers_plancher',
  );
  ok(
    'and every feasibility number is null rather than a fabricated zero',
    noVerdicts.feasibility.maxReachablePercent === null &&
      noVerdicts.feasibility.attainableExposurePercent === null &&
      noVerdicts.feasibility.unrealisablePoints === null &&
      noVerdicts.attainableNotionalQuote === null &&
      noVerdicts.clearsMovementFloor === null,
  );
  ok('a zero there would have read as a measurement — the truth is nothing was measured', true);
}

// ── PROOF 15 — the row and the table agree, column for column ─────────────────────
//
// The writer is best-effort BY DESIGN: it swallows its failures so a stalled insert can never
// kill a trading cycle. That is the right posture and it has a cost — a mistyped column would
// fail every write, forever, and say so only in the logs. The pilot would then run its whole
// window writing nothing, and the first person to notice would be whoever went looking for
// the evidence at the end.
//
// So the shape is checked against the MIGRATION, offline, on every test run.
console.log('\nProof 15 — the insert shape matches the migration, column for column:');
{
  const source = readFileSync(path.join(ROOT, 'src/exposure/observe.ts'), 'utf8');
  const iface = source.slice(
    source.indexOf('export interface BandObservationInsert'),
    source.indexOf('export interface ObserveBandInput'),
  );
  const rowKeys = [...iface.matchAll(/^ {2}([a-z_]+)\??:/gm)].map((m) => m[1]!).sort();

  const migration = readFileSync(
    path.join(ROOT, 'supabase/migrations/0028_exposure_band_observations.sql'),
    'utf8',
  );
  const body = migration.slice(
    migration.indexOf('create table if not exists public.exposure_band_observations ('),
    migration.indexOf('comment on table'),
  );
  // Column declarations only: a line starting with an identifier followed by a type. The
  // constraint lines start with `constraint`, and the generated columns are excluded below.
  const declared = [...body.matchAll(/^ {2}([a-z_]+) +(?!.*\breferences public\.decisions\b)[a-z]/gm)]
    .map((m) => m[1]!)
    .filter((name) => !['id', 'created_at', 'constraint'].includes(name));
  const columns = [...new Set([...declared, 'decision_id'])].sort();

  ok(`the migration declares ${columns.length} writable columns`, columns.length > 30);
  ok(
    `and the insert shape carries exactly the same ${rowKeys.length}`,
    rowKeys.join(',') === columns.join(','),
  );
  const missing = columns.filter((c) => !rowKeys.includes(c));
  const extra = rowKeys.filter((k) => !columns.includes(k));
  ok(`no column is written that the table lacks (${extra.join(', ') || 'none'})`, extra.length === 0);
  ok(`no column is left unwritten (${missing.join(', ') || 'none'})`, missing.length === 0);
}

// ── helpers ─────────────────────────────────────────────────────────────────────────

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.resolve(path.join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * The TRANSITIVE module graph of an entry point, following relative imports only.
 *
 * A text grep over one file proves nothing about what it imports two hops away — which is
 * exactly how the calibration harness could arrive in the bot's graph through a module that
 * merely looked neutral. Following the edges is the only version of "the harness is not in
 * production" that survives a refactor.
 */
function moduleGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      queue.push(path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}

console.log(`\nAll ${passed} exposure-band proofs passed.`);
