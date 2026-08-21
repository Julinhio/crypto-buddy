import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BUNDLE_DIR,
  EXPECTED_BUNDLE_SHA256,
  computeBundleSha256,
  isAdmissibleCandle,
  loadVerifiedBundle,
  BundleVerificationError,
} from '../calibration/exposure/bundle.js';
import {
  basketSumPercent,
  buildExperimentConfig,
  deterministicBasket,
  experimentConfigSha256,
} from '../calibration/exposure/config.js';
import { allocate, feasibleInterval, projectOntoFeasible, type LineConstraint } from '../calibration/exposure/allocate.js';
import { constraintFromGate, runReplay, type AssetTape } from '../calibration/exposure/engine.js';
import { prepareTape, CALIBRATION_WINDOW, VALIDATION_WINDOW } from '../calibration/exposure/tape.js';
import { applyRsiBrake, MissingMedianRsiError } from '../calibration/exposure/controller.js';
import { ARMS, equalWeightBuyAndHold, runPolicy } from '../calibration/exposure/arms.js';
import { checkAgainstReference, type ArmReference, type CalibrationOutcome } from '../calibration/exposure/calibrate.js';
import { excessVsWitness, type Metrics } from '../calibration/exposure/metrics.js';
import {
  buildManifest,
  canonicalJson,
  currentDepsLockSha,
  currentSourceTreeSha,
  sha256Of,
} from '../calibration/exposure/outputs.js';
import {
  SealBrokenError,
  VALIDATION_MAX_DRAWDOWN_PERCENT,
  decisionsDigest,
  loadSelection,
  validateConfiguration,
} from '../calibration/exposure/validate.js';

/**
 * THE TWELVE PROOFS of the exposure-calibration harness.
 *
 * Ordered by what they defend, not by convenience. The ones that matter most are the ones a
 * backtest fails silently: filling on the close that produced the signal, restarting the
 * out-of-sample window in cash, and letting a cash floor from production quietly amputate an
 * arm's band.
 *
 * No network, no database, no LLM, no clock of its own.
 */

let passed = 0;
function ok(label: string, cond: boolean): void {
  assert.ok(cond, label);
  console.log(`  ok: ${label}`);
  passed += 1;
}

const ROOT = process.cwd();

// ── PROOF 3 — THE BASKET ─────────────────────────────────────────────────────────────
console.log('Proof 3 — the deterministic basket follows the caps and always totals 100 %:');
{
  const cfg = buildExperimentConfig();
  ok('the shipped caps give the protocol basket',
    cfg.basket.BTC!.toFixed(3) === '33.333' &&
    cfg.basket.ETH!.toFixed(3) === '33.333' &&
    cfg.basket.BNB!.toFixed(3) === '19.048' &&
    cfg.basket.XRP!.toFixed(3) === '14.286');
  ok('…and sums to 100', Math.abs(basketSumPercent(cfg.basket) - 100) < 1e-9);

  // The property, not the instance: move a cap, the weights MUST follow, and the total
  // must stay 100. A hard-coded basket passes the first assertion above and fails here.
  const variants: Array<Record<string, number>> = [
    { BTC: 35, ETH: 35, BNB: 20, XRP: 15 },
    { BTC: 70, ETH: 10, BNB: 10, XRP: 10 },
    { BTC: 1, ETH: 1, BNB: 1, XRP: 97 },
    { BTC: 25, ETH: 25, BNB: 25, XRP: 25 },
    { BTC: 40, ETH: 30, BNB: 20 },
  ];
  let allFollow = true;
  for (const caps of variants) {
    const basket = deterministicBasket(caps);
    if (Math.abs(basketSumPercent(basket) - 100) > 1e-9) allFollow = false;
    const total = Object.values(caps).reduce((s, c) => s + c, 0);
    for (const [asset, cap] of Object.entries(caps)) {
      if (Math.abs(basket[asset]! - (cap / total) * 100) > 1e-9) allFollow = false;
    }
  }
  ok('across five cap tables the weights track the caps and still total 100', allFollow);
  // Equal caps must give equal weights — the case a "clever" formula gets wrong.
  const equal = deterministicBasket({ BTC: 25, ETH: 25, BNB: 25, XRP: 25 });
  ok('equal caps give equal weights (25 each)', Object.values(equal).every((w) => Math.abs(w - 25) < 1e-9));
}

// ── PROOF 4 — IMPOSED OVER-EXPOSURE ──────────────────────────────────────────────────
console.log('\nProof 4 — a frozen overweight imposes OVER-exposure, and it is journaled:');
{
  const cfg = buildExperimentConfig();
  const lines: LineConstraint[] = [
    { asset: 'BTC', currentPercent: 30, canReduce: false, canIncrease: false, reason: 'frozen' },
    { asset: 'ETH', currentPercent: 0, canReduce: true, canIncrease: true, reason: 'free' },
    { asset: 'BNB', currentPercent: 0, canReduce: true, canIncrease: true, reason: 'free' },
    { asset: 'XRP', currentPercent: 0, canReduce: true, canIncrease: true, reason: 'free' },
  ];
  const r = allocate({ cfg, lines, currentExposurePercent: 30, band: { lowPercent: 40, highPercent: 40 } });
  ok('BTC keeps its 30 % — it cannot be sold', Math.abs(r.targets.BTC! - 30) < 1e-9);
  ok('the projected target is still 40 %', Math.abs(r.projectedPercent - 40) < 1e-9);
  ok('the book OVERSHOOTS to 56.67 %', Math.abs(r.reachedPercent - 56.666666666666664) < 1e-6);
  ok('the gap is POSITIVE — imposed over-exposure, not a shortfall', r.gapPercent > 16 && r.gapPercent < 17);
  const frozen = r.deviations.find((d) => d.asset === 'BTC' && d.cause === 'frozen');
  ok('it is journaled per asset AND per cause, with its sign', frozen != null && frozen.signedPercent > 16);
  // And the other half of the rule: nothing was redistributed to compensate.
  ok('no shortfall was redistributed — the others sit exactly on their nominal targets',
    Math.abs(r.targets.ETH! - (40 * cfg.basket.ETH!) / 100) < 1e-9);
}

// ── PROOF 5 — THE FEASIBLE INTERVAL AND ITS OVERRIDES, BOTH DIRECTIONS ───────────────
console.log('\nProof 5 — overrides apply BEFORE classification, and the interval is per-direction:');
{
  const cfg = buildExperimentConfig();
  const at = (p: number) => p;

  // A stop makes the line ENTIRELY sellable, and never buyable.
  const stop = constraintFromGate('BTC', 'stop_exit', at(30));
  ok('stop_exit: reducible', stop.canReduce === true);
  ok('stop_exit: NOT increasable', stop.canIncrease === false);

  // risk_off lifts the individual freeze FOR REDUCTIONS ONLY.
  const riskOff = constraintFromGate('BTC', 'risk_off_reduction', at(30));
  ok('risk_off_reduction: reducible DESPITE the freeze', riskOff.canReduce === true);
  ok('risk_off_reduction: NOT increasable', riskOff.canIncrease === false);

  // A line with no usable regime: the asymmetry Julien confirmed.
  const noRegime = constraintFromGate('BTC', 'no_regime', at(30));
  ok('no_regime: increase REFUSED', noRegime.canIncrease === false);
  ok('no_regime: reduction ALLOWED — absence of information is not a reason to hold', noRegime.canReduce === true);

  const frozen = constraintFromGate('BTC', 'frozen', at(30));
  ok('frozen: neither direction', frozen.canReduce === false && frozen.canIncrease === false);
  const free = constraintFromGate('BTC', 'actionable', at(30));
  ok('actionable: both directions', free.canReduce === true && free.canIncrease === true);
  assert.throws(() => constraintFromGate('BTC', 'invented_gate', 0));
  console.log('  ok: an unknown gate verdict FAILS the run rather than defaulting');
  passed += 1;

  // THE INTERVAL IS RECOMPUTED FOR THE DIRECTION OF TRAVEL. A risk_off line must NOT pin
  // the floor: it is precisely the line the posture wants sold.
  const underRiskOff: LineConstraint[] = [
    { asset: 'BTC', currentPercent: 30, canReduce: true, canIncrease: false, reason: 'risk_off_reduce_only' },
    { asset: 'ETH', currentPercent: 20, canReduce: true, canIncrease: false, reason: 'risk_off_reduce_only' },
  ];
  const riskOffInterval = feasibleInterval(underRiskOff, cfg.caps);
  ok('under risk_off the floor is 0 — every line may be reduced', riskOffInterval.lowPercent === 0);
  // CORRECTED. This used to assert a ceiling of 0, which encoded the headroom bug: it meant
  // "the book must be liquidated", when risk_off only says nothing may be BOUGHT. The book
  // may stay exactly where it is — 30 + 20 = 50.
  ok('…and the ceiling is the 50 % already held — risk_off forbids buying, it does not force selling',
    riskOffInterval.highPercent === 50);

  const frozenLines: LineConstraint[] = [
    { asset: 'BTC', currentPercent: 30, canReduce: false, canIncrease: false, reason: 'frozen' },
    { asset: 'ETH', currentPercent: 0, canReduce: true, canIncrease: true, reason: 'free' },
  ];
  const frozenInterval = feasibleInterval(frozenLines, cfg.caps);
  ok('a frozen line pins the FLOOR at its weight', frozenInterval.lowPercent === 30);
  ok('…and the ceiling is its own weight plus the actionable line’s cap', frozenInterval.highPercent === 30 + 35);

  // A no_regime line pins no floor (it may be reduced) and cannot rise above where it is.
  const noRegimeLines: LineConstraint[] = [
    { asset: 'BTC', currentPercent: 30, canReduce: true, canIncrease: false, reason: 'no_regime' },
  ];
  const nr = feasibleInterval(noRegimeLines, cfg.caps);
  ok('no_regime pins no floor, and caps the ceiling at its current weight',
    nr.lowPercent === 0 && nr.highPercent === 30);

  // CORRECTED. A line above its cap cannot be bought further — but it is still HELD, so it
  // contributes its current weight to the ceiling. Asserting 0 here said the book could not
  // stay where it already was.
  const overCap: LineConstraint[] = [
    { asset: 'XRP', currentPercent: 50, canReduce: true, canIncrease: true, reason: 'free' },
  ];
  ok('a line above its cap contributes its CURRENT weight, not zero',
    feasibleInterval(overCap, cfg.caps).highPercent === 50);
}

// ── THE RSI BRAKE — one-way, and every clause of it ─────────────────────────────────
console.log('\nThe RSI brake — a one-way brake against buying into an overbought market:');
{
  const cfg = buildExperimentConfig();
  const T = cfg.rsiBrakeThresholdRsi;
  ok('the threshold is 70 and lives in the deterministic config', T === 70);
  // It must be in the digest: two runs differing only by the threshold must not be
  // mistakable for one another.
  const other = buildExperimentConfig(undefined, undefined, undefined, undefined, undefined, 65);
  ok('the threshold changes the config digest', experimentConfigSha256(cfg) !== experimentConfigSha256(other));

  const brake = (bandTarget: number, current: number, rsi: number | null) =>
    applyRsiBrake({ bandTargetPercent: bandTarget, currentExposurePercent: current, medianH4Rsi: rsi, thresholdRsi: T, atMs: 0 });

  // The bound is INCLUSIVE.
  ok('RSI 70 brakes an increase (bound inclusive)', brake(60, 40, 70).braked === true);
  ok('…and caps the target at the CURRENT exposure', brake(60, 40, 70).targetPercent === 40);
  ok('RSI 69.99 does not brake', brake(60, 40, 69.99).braked === false);
  ok('…and leaves the target untouched', brake(60, 40, 69.99).targetPercent === 60);

  // One-way: a decrease or a stable target is never touched, however overbought.
  ok('a DECREASING target passes through at RSI 95', brake(20, 40, 95).targetPercent === 20);
  ok('…and is not reported as braked', brake(20, 40, 95).braked === false);
  ok('a STABLE target passes through at RSI 95', brake(40, 40, 95).targetPercent === 40);
  ok('the brake never triggers a reduction — it can only lower a target to CURRENT',
    brake(100, 40, 99).targetPercent === 40);

  // A low RSI is NOT an opportunity: no symmetric counterpart.
  ok('RSI 5 does not raise anything — the brake has no mirror image', brake(30, 40, 5).targetPercent === 30);

  // A missing median RSI FAILS the RSI replay rather than being silently classified.
  assert.throws(() => brake(60, 40, null), MissingMedianRsiError);
  console.log('  ok: a MISSING median RSI fails the replay instead of reading as "inactive"'); passed += 1;

  // It does not change the context state: same reading with and without the brake.
  const lines: LineConstraint[] = cfg.assets.map((a) => ({
    asset: a, currentPercent: 10, canReduce: true, canIncrease: true, reason: 'free' as const,
  }));
  const band = { lowPercent: 60, highPercent: 90 };
  const withBrake = allocate({
    cfg, lines, currentExposurePercent: 40, band,
    rsiBrake: { medianH4Rsi: 80, thresholdRsi: T, atMs: 0 },
  });
  const without = allocate({ cfg, lines, currentExposurePercent: 40, band });
  ok('with the brake, the requested increase is capped at the current 40 %', withBrake.bandTargetPercent === 40);
  ok('without it, the same bar targets the band floor of 60 %', without.bandTargetPercent === 60);
  ok('the braked bar is flagged as such', withBrake.rsiBraked === true && without.rsiBraked === false);

  // ROTATIONS AT CONSTANT TOTAL ARE NOT BLOCKED. The cap is on the TOTAL, never per line,
  // so a book already at its target still redistributes across the basket.
  const lopsided: LineConstraint[] = [
    { asset: 'BTC', currentPercent: 40, canReduce: true, canIncrease: true, reason: 'free' },
    { asset: 'ETH', currentPercent: 0, canReduce: true, canIncrease: true, reason: 'free' },
    { asset: 'BNB', currentPercent: 0, canReduce: true, canIncrease: true, reason: 'free' },
    { asset: 'XRP', currentPercent: 0, canReduce: true, canIncrease: true, reason: 'free' },
  ];
  const rotation = allocate({
    cfg, lines: lopsided, currentExposurePercent: 40,
    band: { lowPercent: 40, highPercent: 40 },
    rsiBrake: { medianH4Rsi: 95, thresholdRsi: T, atMs: 0 },
  });
  ok('a rotation at constant total exposure is NOT blocked by the brake',
    rotation.targets.ETH! > 0 && rotation.targets.BTC! < 40);
  ok('…and the total stays where it was', Math.abs(rotation.reachedPercent - 40) < 1e-9);

  // risk_off and the stop keep their priority: they act on the LINES, upstream of the brake,
  // and the brake can only ever lower a target — it can never re-open a frozen line.
  const underRiskOff: LineConstraint[] = cfg.assets.map((a) => ({
    asset: a, currentPercent: 15, canReduce: true, canIncrease: false, reason: 'risk_off_reduce_only' as const,
  }));
  const braked = allocate({
    cfg, lines: underRiskOff, currentExposurePercent: 60,
    band: { lowPercent: 0, highPercent: 25 },
    rsiBrake: { medianH4Rsi: 99, thresholdRsi: T, atMs: 0 },
  });
  // CORRECTED. This used to assert a projection of 0 — which only held because the ceiling
  // bug forced liquidation. The property that actually matters is that the REDUCTION happens:
  // the band asks for 25 % against a 60 % book, and the brake does not stand in its way.
  ok('under risk_off the de-risking still happens at RSI 99 — the brake blocks buying, not selling',
    braked.projectedPercent < 60 && braked.projectedPercent === 25);
  ok('…and the brake did not report itself as active on a REDUCTION', braked.rsiBraked === false);
}

// ── THE FREEZE ASYMMETRY ─────────────────────────────────────────────────────────────
console.log('\nThe freeze asymmetry — sell-only freeze, with the deterministic exits untouched:');
{
  const sym = constraintFromGate('BTC', 'frozen', 30, 'symmetric');
  ok('symmetric: a frozen line moves in neither direction', sym.canReduce === false && sym.canIncrease === false);
  const asym = constraintFromGate('BTC', 'frozen', 30, 'asymmetric');
  ok('asymmetric: a frozen line may be REINFORCED', asym.canIncrease === true);
  ok('…but still not REDUCED — the freeze is on sells', asym.canReduce === false);

  // The two deterministic exits must be IDENTICAL in both variants, or the comparison would
  // be testing the ladder rather than the freeze.
  for (const mode of ['symmetric', 'asymmetric'] as const) {
    const stop = constraintFromGate('BTC', 'stop_exit', 30, mode);
    const ro = constraintFromGate('BTC', 'risk_off_reduction', 30, mode);
    ok(`${mode}: the stop still exits fully`, stop.canReduce === true && stop.canIncrease === false);
    ok(`${mode}: risk_off still reduces`, ro.canReduce === true && ro.canIncrease === false);
  }
  // And the asymmetric freeze must LIFT the ceiling, since a frozen line can now be bought.
  const cfgA = buildExperimentConfig();
  const frozenLine: LineConstraint[] = [
    { asset: 'BTC', currentPercent: 10, canReduce: false, canIncrease: true, reason: 'frozen' },
  ];
  ok('an asymmetric freeze lifts the feasible ceiling by the line’s remaining cap',
    feasibleInterval(frozenLine, cfgA.caps).highPercent === 10 + (35 - 10));
}

// ── THE DETERMINISTIC STOP IS AN EXIT, NOT A PERMISSION ──────────────────────────────
//
// Codex P1. Production's `computeStopExits` sells the WHOLE quantity with `fullExit: true`,
// and `isBelowFloor(n, floor, fullExit) = !fullExit && n < floor` exempts it from the 2 %
// plumbing floor. A harness that merely PERMITTED a reduction would let the basket set the
// target — and a stopped line below its nominal weight would then be held untouched.
console.log('\nThe deterministic stop performs a FULL, floor-exempt exit:');
{
  const cfg = buildExperimentConfig();
  const others = ['ETH', 'BNB', 'XRP'].map((asset) => ({
    asset, currentPercent: 10, canReduce: true, canIncrease: true, reason: 'free' as const,
  }));

  // THE CASE THAT EXPOSED THE DEFECT: the stopped line sits BELOW its nominal weight, so the
  // move reads as an increase — which the stop forbids — and the line would be held at 5 %.
  const below = allocate({
    cfg,
    lines: [
      { asset: 'BTC', currentPercent: 5, canReduce: true, canIncrease: false, reason: 'stop_exit', forceExit: true },
      ...others,
    ],
    currentExposurePercent: 35,
    band: { lowPercent: 60, highPercent: 60 },
  });
  ok('a stopped line BELOW its nominal target is exited to ZERO, not held', below.targets.BTC === 0);

  // Above nominal: exited entirely, not merely trimmed back to the basket weight.
  const above = allocate({
    cfg,
    lines: [
      { asset: 'BTC', currentPercent: 40, canReduce: true, canIncrease: false, reason: 'stop_exit', forceExit: true },
      ...others,
    ],
    currentExposurePercent: 70,
    band: { lowPercent: 60, highPercent: 60 },
  });
  ok('a stopped line ABOVE its nominal target is exited to ZERO, not trimmed to nominal',
    above.targets.BTC === 0);

  // Floor-exempt: a 0.5 % line is far under the 2 % floor and must still be exited.
  const tiny = allocate({
    cfg,
    lines: [
      { asset: 'BTC', currentPercent: 0.5, canReduce: true, canIncrease: false, reason: 'stop_exit', forceExit: true },
      ...others,
    ],
    currentExposurePercent: 30.5,
    band: { lowPercent: 30, highPercent: 30 },
  });
  ok(`a 0.5 % stopped line is exited despite the ${cfg.minMovementPercent} % movement floor`,
    tiny.targets.BTC === 0 && !tiny.droppedByFloor.includes('BTC'));

  // The shortfall is journaled under its OWN cause and never redistributed.
  const dev = below.deviations.find((d) => d.asset === 'BTC');
  ok('the exit is journaled under the cause "stop", not "frozen"', dev?.cause === 'stop');
  ok('…with a NEGATIVE sign — imposed under-exposure', (dev?.signedPercent ?? 0) < 0);
  ok('…and nothing was redistributed to the other lines',
    Math.abs(below.targets.ETH! - (below.projectedPercent * cfg.basket.ETH!) / 100) < 1e-9);

  // And the wiring: the production verdict really produces a forced exit.
  ok('the gate verdict stop_exit maps to forceExit', constraintFromGate('BTC', 'stop_exit', 10).forceExit === true);
  for (const gate of ['frozen', 'risk_off_reduction', 'no_regime', 'actionable']) {
    if (constraintFromGate('BTC', gate, 10).forceExit) {
      ok(`${gate} must NOT force an exit`, false);
    }
  }
  ok('no other gate verdict forces an exit', true);
}

// ── PROOF 10 — BUNDLE VERIFICATION ───────────────────────────────────────────────────
console.log('\nProof 10 — the bundle gate refuses every kind of tampering:');
{
  const good = loadVerifiedBundle(ROOT);
  ok('the shipped bundle passes', good.manifest.bundle_sha256 === EXPECTED_BUNDLE_SHA256);
  ok('the pin is RECOMPUTED, not just compared', computeBundleSha256(good.manifest) === EXPECTED_BUNDLE_SHA256);

  const sandbox = mkdtempSync(path.join(tmpdir(), 'bundle-tamper-'));
  const copyBundle = (): string => {
    const dir = mkdtempSync(path.join(sandbox, 'case-'));
    cpSync(path.join(ROOT, BUNDLE_DIR), path.join(dir, BUNDLE_DIR), { recursive: true });
    return dir;
  };
  const refuses = (label: string, mutate: (dir: string) => void): void => {
    const dir = copyBundle();
    mutate(dir);
    assert.throws(() => loadVerifiedBundle(dir), BundleVerificationError, label);
    console.log(`  ok: ${label}`);
    passed += 1;
  };

  refuses('a MISSING candle file is refused', (dir) => {
    rmSync(path.join(dir, BUNDLE_DIR, 'raw', 'BTCUSDT-4h.json'));
  });
  refuses('an ALTERED candle file is refused (per-file digest)', (dir) => {
    const file = path.join(dir, BUNDLE_DIR, 'raw', 'BTCUSDT-4h.json');
    const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<{ c: string }>;
    rows[10]!.c = '999999';
    writeFileSync(file, `${JSON.stringify(rows)}\n`, 'utf8');
  });
  refuses('a DIVERGENT bundle_sha256 is refused', (dir) => {
    const file = path.join(dir, BUNDLE_DIR, 'manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    m.bundle_sha256 = 'f'.repeat(64);
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  });
  // THE CASE A STRING COMPARISON MISSES: the manifest edited coherently — a per-file digest
  // changed AND the pin left alone. Only the recomputation catches it.
  refuses('a COHERENTLY edited manifest is refused (the recomputation earns its keep)', (dir) => {
    const file = path.join(dir, BUNDLE_DIR, 'manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8')) as { series: Array<{ sha256: string }> };
    m.series[0]!.sha256 = '0'.repeat(64);
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  });
  refuses('a wrong bundle_id is refused', (dir) => {
    const file = path.join(dir, BUNDLE_DIR, 'manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    m.bundle_id = 'something-else';
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  });
  refuses('a wrong schema_version is refused', (dir) => {
    const file = path.join(dir, BUNDLE_DIR, 'manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    m.schema_version = 2;
    writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  });

  rmSync(sandbox, { recursive: true, force: true });

  // The admissibility rule itself, on its three independent conditions.
  const asOf = Date.parse('2026-08-21T00:00:00Z');
  const fetchStart = Date.parse('2020-01-01T00:00:00Z');
  const H4 = 4 * 60 * 60 * 1000;
  const lastGood = Date.parse('2026-08-20T20:00:00Z');
  ok('the last admissible 4h bar closes just inside the bound',
    isAdmissibleCandle(lastGood, lastGood + H4 - 1, fetchStart, asOf));
  ok('a bar OPENING on the bound is refused', !isAdmissibleCandle(asOf, asOf + H4 - 1, fetchStart, asOf));
  // The condition an "as_of" reading usually drops: the CLOSE.
  ok('a bar opening inside but CLOSING on the bound is refused',
    !isAdmissibleCandle(asOf - H4 + 1, asOf, fetchStart, asOf));
  ok('a bar before fetch_start is refused',
    !isAdmissibleCandle(fetchStart - H4, fetchStart - 1, fetchStart, asOf));
}

// ── PROOFS 6, 7, 8, 1 — THE ENGINE, ON THE REAL TAPE ────────────────────────────────
console.log('\nProofs 6 / 7 / 8 / 1 — execution at t+1, pending, continuity, determinism:');
{
  const { shared } = prepareTape(ROOT);
  const cfg = shared.cfg;

  // ── PROOF 6 — the order NEVER fills on the close that produced the signal ──────────
  //
  // Built as a trap rather than an inspection: a synthetic tape where every bar's close is
  // 100 and every next open is 200. A book that filled on the signal close would buy at 100
  // and mark at 200 — an instant, impossible profit. Filling at t+1's open buys at 200.
  {
    const bars = 40;
    const h4 = Array.from({ length: bars }, (_, i) => ({
      timestamp: Date.parse('2021-01-01T00:00:00Z') + i * shared.barMs,
      open: 200,
      high: 200,
      low: 100,
      close: 100,
      volume: 1,
    }));
    const tapes: Record<string, AssetTape> = {};
    for (const asset of cfg.assets) {
      const idx = new Map<number, number>();
      h4.forEach((c, i) => idx.set(c.timestamp, i));
      tapes[asset] = { h4, sticky: shared.tapes[asset]!.sticky, indexByTimestamp: idx };
    }
    const points = shared.points.filter((p) => idxHas(tapes[cfg.assets[0]!]!, p.timestamp)).slice(0, bars);
    const result = runReplay({
      cfg, points, tapes, barMs: shared.barMs,
      policy: { kind: 'constant', targetPercent: 50 },
      fromMs: -Infinity, toMs: Infinity,
    });
    const traded = result.bars.filter((b) => b.tradedNotional > 0);
    // If any fill happened at 100 while the mark is 100, equity would jump; at 200 it cannot.
    const noFreeLunch = result.bars.every((b) => b.equity <= 1000.000001);
    ok('an order never fills on the close that produced it (no free lunch at 200→100)',
      traded.length > 0 && noFreeLunch);
  }

  // ── PROOF 7 — a signal with no following bar is PENDING, never filled ─────────────
  {
    // A window holding EXACTLY the bundle's last bar. The book is flat, the policy wants
    // 60 %, so the bar genuinely produces a signal — and there is no bar after it to fill
    // on. Widening the window would let the book reach its target earlier and leave the
    // final bar with nothing to do, which would make this proof pass for the wrong reason.
    const tail = shared.points[shared.points.length - 1]!;
    const result = runReplay({
      cfg, points: shared.points, tapes: shared.tapes, barMs: shared.barMs,
      policy: { kind: 'constant', targetPercent: 60 },
      fromMs: tail.timestamp, toMs: Infinity,
    });
    ok('the window really holds only the last bar (else the proof is vacuous)', result.bars.length === 1);
    const lastBar = result.bars[0]!;
    ok('that bar really wants to move (a flat book against a 60 % target)',
      Math.abs(lastBar.reachedPercent - lastBar.exposurePercent) > 0);
    ok('the final signal produces no order and is counted pending_not_executed',
      result.pendingNotExecuted === 1);
    ok('…and nothing was filled on a substitute close', lastBar.tradedNotional === 0);
    ok('…so the book is still flat and still holds its 1000 $',
      Math.abs(result.finalState.cash.toNumber() - 1000) < 1e-9);
  }

  // ── PROOF 8 — the sealed window RESUMES, it does not restart in cash ───────────────
  {
    const calibration = runPolicy(shared, { kind: 'constant', targetPercent: 60 }, CALIBRATION_WINDOW);
    const endState = calibration.result.finalState;
    const heldAssets = cfg.assets.filter((a) => (endState.positions[a]?.qty.toNumber() ?? 0) > 0);
    ok('the calibration leg really ends holding positions (else the test is vacuous)', heldAssets.length > 0);

    const resumed = runPolicy(shared, { kind: 'constant', targetPercent: 60 }, VALIDATION_WINDOW, endState);
    const restarted = runPolicy(shared, { kind: 'constant', targetPercent: 60 }, VALIDATION_WINDOW);

    // The opening equity is NOT asserted equal to the calibration's closing equity, and that
    // is not a looser test — it is the correct one. The two are separated by one bar of
    // price movement plus the fill of any order decided on the last calibration bar, so
    // demanding equality would be demanding that the market stood still across the boundary.
    //
    // What continuity really claims is checked instead: the resumed run starts INVESTED and
    // on the calibration's capital, where a restart starts flat on 1000 $.
    const firstResumed = resumed.result.bars[0]!;
    const firstRestarted = restarted.result.bars[0]!;
    ok('a run that RESTARTED opens at exactly 1000 $ — and flat',
      Math.abs(restarted.result.openingEquity - 1000) < 1e-6 && firstRestarted.exposurePercent === 0);
    ok('the RESUMED run does not open at 1000 $', Math.abs(resumed.result.openingEquity - 1000) > 1);
    ok('…it opens already invested — the positions crossed the boundary', firstResumed.exposurePercent > 0);
    ok('…on the calibration capital, within one bar of price movement',
      Math.abs(resumed.result.openingEquity - endState.equity.toNumber()) / endState.equity.toNumber() < 0.25);
    ok('so resuming and restarting are genuinely different trajectories',
      Math.abs(resumed.metrics.closingEquity - restarted.metrics.closingEquity) > 1e-6);
    // Peaks and stop state travel too — a fresh start would have forgotten every peak.
    const carriedPeaks = heldAssets.filter((a) => resumed.result.finalState.positions[a]?.peakPrice != null);
    ok('peaks (the stop’s memory) cross the boundary with the positions', carriedPeaks.length > 0);
  }

  // ── PROOF 1 — DETERMINISM ────────────────────────────────────────────────────────
  {
    const a = runPolicy(shared, { kind: 'band', bands: {
      defensive: { lowPercent: 0, highPercent: 25 },
      neutral: { lowPercent: 35, highPercent: 60 },
      constructive: { lowPercent: 65, highPercent: 90 },
    } }, CALIBRATION_WINDOW);
    // A SECOND, independent preparation — not a reuse of the same tape, which would only
    // prove the function is pure, not that the pipeline is reproducible from disk.
    const second = prepareTape(ROOT);
    const b = runPolicy(second.shared, { kind: 'band', bands: {
      defensive: { lowPercent: 0, highPercent: 25 },
      neutral: { lowPercent: 35, highPercent: 60 },
      constructive: { lowPercent: 65, highPercent: 90 },
    } }, CALIBRATION_WINDOW);
    ok('two independent runs produce byte-identical trajectories',
      canonicalJson(a.result.bars) === canonicalJson(b.result.bars));
    ok('…and byte-identical metrics', canonicalJson(a.metrics) === canonicalJson(b.metrics));
  }
}

function idxHas(tape: AssetTape, ts: number): boolean {
  return tape.indexByTimestamp.has(ts);
}

// ── PROOF 9 — THE SEAL ───────────────────────────────────────────────────────────────
console.log('\nProof 9 — the validation command refuses to open without a frozen selection:');
{
  const BUNDLE = EXPECTED_BUNDLE_SHA256;
  // The seal binds to the SOURCE TREE, so a synthetic selection has to carry the real one —
  // the proofs below are about the OTHER refusals, not about that check.
  const TREE = currentSourceTreeSha();
  // A CLEAN git environment, injected: these proofs are about the seal's own refusals, and
  // must not depend on whether the developer running them happens to have an edit in flight.
  const LOCK = currentDepsLockSha();
  const CLEAN = {
    sourceTreeSha: TREE,
    depsLockSha: LOCK,
    dirty: false as const,
    committed: true as const,
  };
  assert.throws(() => loadSelection(undefined, BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: NO selection file → refused'); passed += 1;
  assert.throws(() => loadSelection('', BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: an empty path → refused'); passed += 1;
  assert.throws(() => loadSelection('does-not-exist.json', BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: a missing file → refused'); passed += 1;

  const dir = mkdtempSync(path.join(tmpdir(), 'seal-'));
  const base = {
    schema_version: 1 as const,
    bundle_sha256: BUNDLE,
    crypto_buddy_commit: 'deadbeef',
    source_tree_sha: TREE,
    deps_lock_sha: LOCK,
    selected_arm: 'B',
    rsi_retained: false,
    asymmetry_admissible: false,
    configurations: [{
      name: 'B-symmetric',
      bands: {
        defensive: { lowPercent: 0, highPercent: 25 },
        neutral: { lowPercent: 35, highPercent: 60 },
        constructive: { lowPercent: 65, highPercent: 90 },
      },
      rsi: false,
      freeze: 'symmetric' as const,
      witnessTargetPercent: 42.5,
      witnessMismatchPoints: 0.11,
    }],
  };
  const write = (name: string, value: unknown): string => {
    const file = path.join(dir, name);
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return file;
  };

  const valid = write('valid.json', { ...base, decisions_sha256: decisionsDigest(base) });
  const loaded = loadSelection(valid, BUNDLE, CLEAN);
  ok('a properly frozen selection IS accepted', loaded.selected_arm === 'B');

  const tampered = { ...base, selected_arm: 'C' };
  const tamperedFile = write('tampered.json', { ...tampered, decisions_sha256: decisionsDigest(base) });
  assert.throws(() => loadSelection(tamperedFile, BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: a decision edited AFTER freezing → refused'); passed += 1;

  const otherBundle = write('otherbundle.json', {
    ...base, bundle_sha256: 'a'.repeat(64),
    decisions_sha256: decisionsDigest({ ...base, bundle_sha256: 'a'.repeat(64) }),
  });
  assert.throws(() => loadSelection(otherBundle, BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: a selection made on ANOTHER bundle → refused'); passed += 1;

  const noConfigs = { ...base, configurations: [] };
  const noConfigsFile = write('noconfigs.json', { ...noConfigs, decisions_sha256: decisionsDigest(noConfigs) });
  assert.throws(() => loadSelection(noConfigsFile, BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: a selection registering no validable configuration → refused'); passed += 1;

  // THE SOURCE-TREE BINDING (Codex P1). Without it the sealed window could be opened after
  // the replay mechanics had changed: the bundle would still match, the digest would still
  // verify, and the out-of-sample comparison would pit one engine against bands and witnesses
  // calibrated by another.
  const otherTree = { ...base, source_tree_sha: 'b'.repeat(40) };
  const otherTreeFile = write('othertree.json', { ...otherTree, decisions_sha256: decisionsDigest(otherTree) });
  assert.throws(() => loadSelection(otherTreeFile, BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: a selection calibrated by a DIFFERENT source tree → refused'); passed += 1;

  const noTree = { ...base, source_tree_sha: null };
  const noTreeFile = write('notree.json', { ...noTree, decisions_sha256: decisionsDigest(noTree) });
  assert.throws(() => loadSelection(noTreeFile, BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: a selection with NO source-tree identity → refused'); passed += 1;

  // …and the identity is the one an artefact-only commit does not move. That is the whole
  // reason it is the tree of `src/` and not the commit SHA: the selection is produced at one
  // commit and committed at the next.
  ok('the source-tree identity is the tree of src/, insensitive to an artefact-only commit',
    TREE != null && TREE === currentSourceTreeSha());
  ok('…and it is part of the decisions digest, so it cannot be edited afterwards',
    decisionsDigest(base) !== decisionsDigest({ ...base, source_tree_sha: 'c'.repeat(40) }));

  // A DIRTY source is refused too. `rev-parse` reads the COMMITTED tree, so uncommitted
  // engine edits would sail past a tree comparison while genuinely changing what runs.
  assert.throws(
    () => loadSelection(valid, BUNDLE, { ...CLEAN, dirty: true }),
    SealBrokenError,
  );
  console.log('  ok: a DIRTY source tree → refused (rev-parse reads the committed tree)'); passed += 1;
  assert.throws(
    () => loadSelection(valid, BUNDLE, { ...CLEAN, dirty: null }),
    SealBrokenError,
  );
  console.log('  ok: a source tree whose state git cannot report → refused'); passed += 1;
  assert.throws(
    () => loadSelection(valid, BUNDLE, { ...CLEAN, sourceTreeSha: null }),
    SealBrokenError,
  );
  console.log('  ok: no current source-tree identity at all → refused'); passed += 1;

  // THE RUNTIME HALF OF THE IDENTITY. `src` is what we write; the lockfile is what we RUN.
  // `technicalindicators` computes the regimes and `decimal.js` the arithmetic, and neither
  // lives under `src/` — a dependency bump committed alone leaves the source identity intact.
  assert.throws(
    () => loadSelection(valid, BUNDLE, { ...CLEAN, depsLockSha: 'd'.repeat(40) }),
    SealBrokenError,
  );
  console.log('  ok: a DIFFERENT package-lock → refused'); passed += 1;
  assert.throws(
    () => loadSelection(valid, BUNDLE, { ...CLEAN, depsLockSha: null }),
    SealBrokenError,
  );
  console.log('  ok: no runtime-dependency identity → refused'); passed += 1;
  const noLock = { ...base, deps_lock_sha: null };
  const noLockFile = write('nolock.json', { ...noLock, decisions_sha256: decisionsDigest(noLock) });
  assert.throws(() => loadSelection(noLockFile, BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: a selection carrying no lockfile identity → refused'); passed += 1;
  ok('the lockfile identity is part of the decisions digest',
    decisionsDigest(base) !== decisionsDigest({ ...base, deps_lock_sha: 'e'.repeat(40) }));

  // AN IMPERFECT WITNESS CANNOT SUPPORT A PASS. The out-of-sample verdict compares the
  // configuration's net return to that witness's — which is exactly the excess-of-CAGR claim
  // the protocol forbids resting on an unmatched control.
  const unsound = {
    ...base,
    configurations: [{ ...base.configurations[0]!, witnessMismatchPoints: 0.9 }],
  };
  const unsoundFile = write('unsound.json', { ...unsound, decisions_sha256: decisionsDigest(unsound) });
  assert.throws(() => loadSelection(unsoundFile, BUNDLE, CLEAN), /IMPERFECT witness/);
  console.log('  ok: a configuration frozen against an IMPERFECT witness → refused'); passed += 1;

  const noMismatch = {
    ...base,
    configurations: [{ ...base.configurations[0]!, witnessMismatchPoints: Number.NaN }],
  };
  const noMismatchFile = write('nomismatch.json', { ...noMismatch, decisions_sha256: decisionsDigest(noMismatch) });
  assert.throws(() => loadSelection(noMismatchFile, BUNDLE, CLEAN), SealBrokenError);
  console.log('  ok: a configuration recording no mismatch at all → refused'); passed += 1;

  // …and one exactly ON the tolerance is accepted: the protocol says "≤ 0,25", not "< 0,25".
  const onTolerance = {
    ...base,
    configurations: [{ ...base.configurations[0]!, witnessMismatchPoints: 0.25 }],
  };
  const onToleranceFile = write('ontol.json', { ...onTolerance, decisions_sha256: decisionsDigest(onTolerance) });
  ok('a mismatch exactly ON the 0.25pt tolerance is accepted',
    loadSelection(onToleranceFile, BUNDLE, CLEAN).configurations[0]!.witnessMismatchPoints === 0.25);

  rmSync(dir, { recursive: true, force: true });
}

// ── THE REGRESSION GUARD ─────────────────────────────────────────────────────────────
//
// A guard that never fires is indistinguishable from no guard at all, so it is exercised on
// a divergence rather than only on a match.
console.log('\nThe regression guard — steps 1-2 must reproduce a reference EXACTLY:');
{
  const m = (net: number, cagr: number, maxdd: number, expo: number) =>
    ({ netReturnPercent: net, cagrPercent: cagr, maxDrawdownPercent: maxdd, meanExposurePercent: expo }) as Metrics;
  const outcome = {
    baseline: m(64.49, 15.3, 19.35, 19.58),
    equalWeight: { openingEquity: 1000, closingEquity: 6042, netReturnPercent: 504.25 },
    reports: [{
      name: 'A',
      metrics: m(167.24, 32.47, 32.13, 36.81),
      witness: { targetPercent: 37.75, realisedMeanExposurePercent: 36.744, mismatchPoints: 0.065, isSound: true, targetsEvaluated: 401 },
      excessCagrPercent: 6.55,
      eligibility: { eligible: true, drawdownOk: true, beatsBaseline: true, excessOk: true, reasons: [] },
    }],
    selected: { name: 'A' },
  } as unknown as CalibrationOutcome;

  const reference: ArmReference = {
    baseline: { net: 64.49, cagr: 15.3, maxdd: 19.35, expo: 19.58 },
    equalWeightNet: 504.25,
    arms: { A: { net: 167.24, cagr: 32.47, maxdd: 32.13, expo: 36.81, witnessTarget: 37.75, witnessRealised: 36.744, excess: 6.55, eligible: true } },
    selected: 'A',
  };

  ok('an identical run reports zero divergence', checkAgainstReference(outcome, reference).length === 0);

  // Every field is actually compared — a guard that only looked at the headline return would
  // wave through a witness that had moved.
  const perturbations: Array<[string, ArmReference]> = [
    ['net return', { ...reference, arms: { A: { ...reference.arms.A!, net: 167.25 } } }],
    ['CAGR', { ...reference, arms: { A: { ...reference.arms.A!, cagr: 32.48 } } }],
    ['max drawdown', { ...reference, arms: { A: { ...reference.arms.A!, maxdd: 32.14 } } }],
    ['realised exposure', { ...reference, arms: { A: { ...reference.arms.A!, expo: 36.82 } } }],
    ['witness target', { ...reference, arms: { A: { ...reference.arms.A!, witnessTarget: 38 } } }],
    ['witness realised', { ...reference, arms: { A: { ...reference.arms.A!, witnessRealised: 36.75 } } }],
    ['excess', { ...reference, arms: { A: { ...reference.arms.A!, excess: 6.56 } } }],
    ['eligibility', { ...reference, arms: { A: { ...reference.arms.A!, eligible: false } } }],
    ['the baseline', { ...reference, baseline: { ...reference.baseline, net: 64.5 } }],
    ['the equal-weight reference', { ...reference, equalWeightNet: 504.26 }],
    ['the selected arm', { ...reference, selected: 'B' }],
  ];
  let allCaught = true;
  for (const [label, perturbed] of perturbations) {
    if (checkAgainstReference(outcome, perturbed).length === 0) {
      allCaught = false;
      console.log(`      MISSED: ${label}`);
    }
  }
  ok(`a divergence in ANY of the ${perturbations.length} compared fields is caught`, allCaught);
  // Exact equality, not a tolerance: the replay is deterministic on frozen data, so the
  // smallest drift is real drift.
  ok('the comparison is EXACT — a 1e-12 drift still fires',
    checkAgainstReference(outcome, { ...reference, arms: { A: { ...reference.arms.A!, cagr: 32.47 + 1e-12 } } }).length === 1);
  ok('an arm missing from the reference is reported, not ignored',
    checkAgainstReference(outcome, { ...reference, arms: {} }).length > 0);
}

// ── THE SEALED WINDOW REPLAYS THE FROZEN CONFIGURATION, IN FULL ──────────────────────
//
// A defect found by reading the code back: the validation used to replay only `cfg.bands`,
// dropping `cfg.rsi` and `cfg.freeze`. It would have completed, produced plausible numbers,
// and spent the single out-of-sample opening on a configuration nobody selected. Pinned here
// by SOURCE inspection, because the failure is an omission — there is nothing to observe in
// the output of a run whose two extra dimensions happen to be off.
console.log('\nThe sealed window replays the FROZEN configuration, not just its band:');
{
  const { shared } = prepareTape(ROOT);

  // TWO SLICES OF THE CALIBRATION WINDOW. The out-of-sample window is never touched: this is
  // a wiring question, and spending the single OOS opening on it would be absurd.
  //
  // The first slice is chosen to CONTAIN a bar where the median 4h RSI reaches the brake's
  // threshold — otherwise a brake that was correctly wired and a brake that was silently
  // dropped would produce identical numbers, and the proof would pass either way.
  const braking = shared.points.filter(
    (p) =>
      p.timestamp >= CALIBRATION_WINDOW.fromMs &&
      p.timestamp < CALIBRATION_WINDOW.toMs &&
      p.global.medianH4Rsi != null &&
      p.global.medianH4Rsi >= buildExperimentConfig().rsiBrakeThresholdRsi,
  );
  ok(`the calibration window really contains braking bars (${braking.length}) — else the proof is vacuous`,
    braking.length > 0);

  const anchor = braking[Math.floor(braking.length / 2)]!.timestamp;
  const span = 400 * shared.barMs;
  const windows = {
    calibration: { fromMs: anchor - span, toMs: anchor + span },
    validation: { fromMs: anchor + span, toMs: anchor + 2 * span },
  };

  const base = {
    name: 'synthetic',
    bands: ARMS.A!,
    witnessTargetPercent: 37.75,
    witnessMismatchPoints: 0,
  };

  // THE BEHAVIOURAL PROOF. The SAME function the sealed command calls, on a synthetic
  // selection that switches both extra dimensions ON. If either were dropped on the way to
  // the engine, these verdicts would be indistinguishable from the plain one.
  const plain = validateConfiguration(shared, { ...base, rsi: false, freeze: 'symmetric' }, windows);
  const withRsi = validateConfiguration(shared, { ...base, rsi: true, freeze: 'symmetric' }, windows);
  const withAsym = validateConfiguration(shared, { ...base, rsi: false, freeze: 'asymmetric' }, windows);
  const withBoth = validateConfiguration(shared, { ...base, rsi: true, freeze: 'asymmetric' }, windows);

  // 1) THE RSI DIMENSION REALLY REACHES THE REPLAY.
  ok('rsi:false → the brake fires on no bar at all',
    plain.calibrationBrakedBars === 0 && plain.validationBrakedBars === 0);
  ok(`rsi:true → the brake actually fires (${withRsi.calibrationBrakedBars} bars in the first leg)`,
    withRsi.calibrationBrakedBars > 0);
  ok('…and that changes the trajectory, not just a flag',
    withRsi.validationMetrics.closingEquity !== plain.validationMetrics.closingEquity);

  // 2) THE FREEZE DIMENSION REALLY REACHES THE REPLAY.
  ok('freeze:asymmetric → a different trajectory from the symmetric one',
    withAsym.validationMetrics.closingEquity !== plain.validationMetrics.closingEquity);
  ok('…and a different realised exposure — a frozen line can now be reinforced',
    withAsym.validationMetrics.meanExposurePercent !== plain.validationMetrics.meanExposurePercent);

  // 3) BOTH AT ONCE, and distinct from either alone — neither silently overrides the other.
  ok('both dimensions together differ from RSI alone',
    withBoth.validationMetrics.closingEquity !== withRsi.validationMetrics.closingEquity);
  ok('…and from the asymmetry alone',
    withBoth.validationMetrics.closingEquity !== withAsym.validationMetrics.closingEquity);
  ok('…while the brake still fires under the asymmetric gate', withBoth.calibrationBrakedBars > 0);

  // 3b) THE WITNESS'S EXPOSURE MATCH IS RE-MEASURED IN THE VALIDATION WINDOW.
  //
  // The frozen target was matched on CALIBRATION. Both realised exposures are path-dependent,
  // so the pair can drift apart in the window it was frozen FOR — without anyone touching it.
  // The target is never recomputed (the protocol forbids it); the DRIFT is measured, and an
  // excess measured against a drifted control may not be quoted as a claim.
  ok('the verdict reports the OOS witness exposure mismatch',
    Number.isFinite(plain.oosWitnessMismatchPoints));
  ok('…and says whether it is still inside the pre-registered tolerance',
    plain.oosWitnessIsSound === (plain.oosWitnessMismatchPoints <= 0.25));
  ok('…and an excess is supported only when the witness is still matched',
    plain.excessIsSupported === plain.oosWitnessIsSound);
  // A configuration whose frozen target is nowhere near its exposure must be flagged.
  const mismatched = validateConfiguration(
    shared, { ...base, rsi: false, freeze: 'symmetric', witnessTargetPercent: 5 }, windows,
  );
  ok('a badly matched frozen witness drifts out of tolerance OOS', !mismatched.oosWitnessIsSound);
  ok('…and its excess is marked NOT SUPPORTED', mismatched.excessIsSupported === false);
  ok('…while the excess figure is still published rather than hidden',
    Number.isFinite(mismatched.excessCagrPercent));

  // 3c) A DRIFTED WITNESS MAKES THE CONFIGURATION NON-DELIVERABLE, AS "INCONCLUSIVE".
  //
  // Not a failure of the configuration: the control stopped being a control, so the claim the
  // experiment is built on — return AT COMPARABLE EXPOSURE — could not be made. The four
  // properties Julien pinned, each checked on its own.
  {
    // (i) drift STRICTLY ABOVE the tolerance → not deliverable, labelled inconclusive.
    ok('a drifted witness → outcome "inconclusive", not "rejected"', mismatched.outcome === 'inconclusive');
    ok('…and the configuration is NOT deliverable', mismatched.deliverable === false);
    ok('…and it is NOT reported as a performance failure', mismatched.rejected === false);
    ok('…with a reason that says nothing is proven either way',
      mismatched.reasons.some((r) => r.includes('INCONCLUSIVE') && r.includes('not a performance failure')));

    // (ii) the METRICS are still published in full, with the flag beside them.
    ok('the metrics are still published — net return', Number.isFinite(mismatched.validationMetrics.netReturnPercent));
    ok('…max drawdown', Number.isFinite(mismatched.validationMetrics.maxDrawdownPercent));
    ok('…realised exposure', Number.isFinite(mismatched.validationMetrics.meanExposurePercent));
    ok('…and the excess figure itself, flagged unsupported',
      Number.isFinite(mismatched.excessCagrPercent) && mismatched.excessIsSupported === false);
    ok('…with oosWitnessIsSound = false recorded', mismatched.oosWitnessIsSound === false);

    // (iii) EXACTLY at the tolerance the witness stays acceptable. The protocol says "≤".
    //       Checked on the pure predicate, since hitting 0.25000 on a real tape is chance.
    const atTolerance = excessVsWitness(
      { cagrPercent: 10, meanExposurePercent: 40 } as Metrics,
      { cagrPercent: 8, meanExposurePercent: 40.25 } as Metrics,
    );
    ok('a mismatch of exactly 0.25pt is SOUND — the protocol says "≤"', atTolerance.witnessIsSound === true);
    const justOver = excessVsWitness(
      { cagrPercent: 10, meanExposurePercent: 40 } as Metrics,
      { cagrPercent: 8, meanExposurePercent: 40.2500001 } as Metrics,
    );
    ok('…and a hair above it is NOT', justOver.witnessIsSound === false);

    // (iv) THE TWO PRE-REGISTERED CRITERIA ARE UNCHANGED. A well-matched configuration is
    //      judged exactly as before — the drift rule adds nothing to its evaluation.
    // Conditioned on the FACT rather than on an assumption: the synthetic sub-window used for
    // this proof is short, and a frozen target matched on the full calibration has no reason
    // to stay matched on an arbitrary slice of it. Asserting "plain is well matched" would be
    // asserting something about the fixture, not about the rule.
    if (plain.oosWitnessIsSound) {
      ok('a WELL-MATCHED configuration is judged on the two criteria alone',
        plain.outcome === (plain.reasons.length > 0 ? 'rejected' : 'passes'));
    } else {
      ok('this fixture drifted too — the rule applies to it identically',
        plain.outcome === 'inconclusive' || plain.validationMetrics.maxDrawdownPercent > VALIDATION_MAX_DRAWDOWN_PERCENT);
    }
    ok('deliverability is exactly "the outcome passes", never a third state',
      plain.deliverable === (plain.outcome === 'passes') &&
      mismatched.deliverable === (mismatched.outcome === 'passes'));

    // The two criteria themselves, exercised directly on a SOUND witness so the drift rule
    // cannot be what produces the verdict.
    const sound = validateConfiguration(
      shared, { ...base, rsi: false, freeze: 'symmetric' },
      { calibration: windows.calibration, validation: windows.calibration },
    );
    ok('with a sound witness, the outcome is decided by the two criteria alone',
      !sound.oosWitnessIsSound || sound.outcome === (sound.reasons.length > 0 ? 'rejected' : 'passes'));
    ok('…the drawdown limit is still 45 %', VALIDATION_MAX_DRAWDOWN_PERCENT === 45);
    // The drawdown criterion is ABSOLUTE and outranks a drift: it is judgeable whatever the
    // witness does, so a breach stays a genuine rejection rather than being hidden behind
    // "we could not tell".
    ok('a drawdown breach is reported as REJECTED even when the witness drifted',
      mismatched.validationMetrics.maxDrawdownPercent > VALIDATION_MAX_DRAWDOWN_PERCENT
        ? mismatched.outcome === 'rejected'
        : true);
  }

  // 4) THE WITNESS SHARES THE MECHANICS AND NEVER THE TREATMENT.
  //    Same frozen target, so any difference in the witness comes from the gate variant alone.
  ok('the witness follows the FREEZE variant (mechanics held constant)',
    withAsym.witnessValidationMetrics.closingEquity !== plain.witnessValidationMetrics.closingEquity);
  ok('the witness does NOT follow the RSI brake (the treatment stays out of the control)',
    withRsi.witnessValidationMetrics.closingEquity === plain.witnessValidationMetrics.closingEquity);
}

// ── PROOF 1 (artefacts) — THE MANIFEST CARRIES NOTHING THAT CANNOT REPRODUCE ─────────
console.log('\nProof 1 (artefacts) — a manifest that could never be byte-identical is a broken proof:');
{
  const src = readFileSync(path.join(ROOT, 'src', 'calibration', 'exposure', 'outputs.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function buildManifest'));
  ok('the manifest carries no wall-clock timing', !body.includes('timings'));
  // The real check: build it twice and compare bytes.
  const { shared, bundle } = prepareTape(ROOT);
  const mk = () =>
    canonicalJson(
      buildManifest({
        kind: 'calibration',
        bundle: bundle.manifest,
        cfg: shared.cfg,
        windows: { calibration: CALIBRATION_WINDOW },
        outputs: [{ file: 'summary.json', sha256: 'a'.repeat(64), bytes: 10 }],
      }),
    );
  ok('two manifest builds are byte-identical', mk() === mk());
  const parsed = JSON.parse(mk()) as Record<string, unknown>;
  ok('it pins the bundle, the commit, the regime version and the config digest',
    parsed.bundle_sha256 === EXPECTED_BUNDLE_SHA256 &&
    typeof parsed.regime_version === 'string' &&
    typeof parsed.experiment_config_sha256 === 'string' &&
    'crypto_buddy_commit' in parsed);
  ok('it does NOT hash itself', !mk().includes(sha256Of(mk())));
}

// ── EVERY PUBLISHED FIGURE HAS A TRAJECTORY BEHIND IT ────────────────────────────────
//
// The equal-weight reference is a witness the protocol names, and its result is printed in
// the summary. A figure that cannot be traced back to a trajectory is one the reader has to
// take on trust — and that is exactly the kind of gap a negative outcome makes expensive,
// since disagreeing with "no band is deliverable" means auditing what produced it.
console.log('\nEvery published figure is auditable — the equal-weight reference included:');
{
  const { shared } = prepareTape(ROOT);
  const eq = equalWeightBuyAndHold(shared, CALIBRATION_WINDOW);
  ok('the equal-weight reference produces a per-bar trajectory', eq.bars.length > 0);
  // IT STAYS IN CASH UNTIL ITS ENTRY. The quantities are bought at the successor bar's open,
  // so marking them against an earlier close would show a position one bar before it exists —
  // temporally invalid in the one artefact whose job is to let a reader reconstruct events.
  ok('…opening at exactly 1 000 $ in CASH, before the entry bar',
    eq.bars[0]!.equity === 1000 && Object.values(eq.bars[0]!.weights).every((w) => w === 0));
  const firstInvested = eq.bars.findIndex((b) => Object.values(b.weights).some((w) => w > 0));
  ok('…then becoming invested exactly once, on a later bar', firstInvested > 0);
  ok('…and every bar before it is flat cash',
    eq.bars.slice(0, firstInvested).every((b) => b.equity === 1000));
  ok('…on the same grid as every other run', eq.bars.length === runPolicy(
    shared, { kind: 'constant', targetPercent: 0 }, CALIBRATION_WINDOW,
  ).result.bars.length);
  const first = eq.bars[0]!;
  const last = eq.bars[eq.bars.length - 1]!;
  ok('…starting inside the calibration window', first.timestamp >= CALIBRATION_WINDOW.fromMs);
  ok('…and ending strictly before it closes', last.timestamp < CALIBRATION_WINDOW.toMs);
  ok('…never reaching the sealed window', last.timestamp < VALIDATION_WINDOW.fromMs);
  ok('the closing equity of the trajectory IS the published one',
    Math.abs(last.equity - eq.closingEquity) < 1e-9);
  // Nothing is ever rebalanced, so the weights must DRIFT — if they stayed at 25 % the
  // reference would be something else entirely.
  const drifted = Object.values(last.weights).some((w) => Math.abs(w - 25) > 1);
  ok('the weights drift — the reference really is never rebalanced', drifted);
  ok('…while still summing to 100',
    Math.abs(Object.values(last.weights).reduce((s, w) => s + w, 0) - 100) < 1e-6);
}

// ── THE FEASIBLE CEILING IS A TOTAL, NOT A HEADROOM ─────────────────────────────────
//
// Codex P1, and the most damaging of the lot. Summing `cap - current` measures how much MORE
// could be bought, then adds it to a floor that deliberately excludes every reducible line —
// so a held weight ended up in neither term. An all-actionable book at 70 % came out with a
// ceiling of 35 %, "do nothing" was declared infeasible, and half the book was sold on a bar
// where nothing should have moved.
console.log('\nThe feasible ceiling is a TOTAL reachable weight, not a headroom:');
{
  const cfg = buildExperimentConfig();
  const free = (asset: string, currentPercent: number): LineConstraint =>
    ({ asset, currentPercent, canReduce: true, canIncrease: true, reason: 'free' });

  const invested = [free('BTC', 25), free('ETH', 25), free('BNB', 10), free('XRP', 10)];
  const held = invested.reduce((s, l) => s + l.currentPercent, 0);
  const iv = feasibleInterval(invested, cfg.caps);
  ok(`an all-actionable book held at ${held} % is INSIDE its own interval`, held <= iv.highPercent);
  ok('…and "do nothing" survives the projection', projectOntoFeasible(held, iv) === held);
  ok('…the ceiling is the caps total, clamped to 100', iv.highPercent === 100);
  ok('…and the floor is 0 — every line may be sold', iv.lowPercent === 0);

  // Under risk_off nothing may be BOUGHT, but the book may stay where it is. A ceiling of 0
  // would mean "liquidate everything", which is not what the posture says.
  const riskOff = ['BTC', 'ETH', 'BNB', 'XRP'].map((asset) => ({
    asset, currentPercent: 15, canReduce: true, canIncrease: false, reason: 'risk_off_reduce_only' as const,
  }));
  const ro = feasibleInterval(riskOff, cfg.caps);
  ok('under risk_off the floor is 0 — every line may be reduced', ro.lowPercent === 0);
  ok('…and the ceiling is the 60 % already held, NOT 0 — risk_off permits selling, it does not mandate liquidation',
    ro.highPercent === 60);

  // A line above its cap keeps its weight: it cannot be bought further, and the ceiling
  // never sells.
  const overCap = feasibleInterval([free('XRP', 50)], cfg.caps);
  ok('a line above its cap contributes its CURRENT weight, not zero', overCap.highPercent === 50);

  // A forced exit contributes nothing to either bound.
  const stopped = feasibleInterval(
    [{ asset: 'BTC', currentPercent: 30, canReduce: true, canIncrease: false, reason: 'stop_exit', forceExit: true }],
    cfg.caps,
  );
  ok('a stopped line contributes 0 to both bounds — it is leaving', stopped.lowPercent === 0 && stopped.highPercent === 0);

  // A frozen line pins the floor AND caps its own contribution to the ceiling.
  const frozen = feasibleInterval(
    [{ asset: 'BTC', currentPercent: 30, canReduce: false, canIncrease: false, reason: 'frozen' }, free('ETH', 0)],
    cfg.caps,
  );
  ok('a frozen line pins the floor at its weight', frozen.lowPercent === 30);
  ok('…and the ceiling is its weight plus the actionable line’s cap', frozen.highPercent === 30 + 35);
}

// ── THE INVARIANT THAT WOULD HAVE CAUGHT IT ─────────────────────────────────────────
//
// Two published rounds rested on a ceiling that could sit BELOW the book it was describing.
// The cheap invariant that fires on the very first bar: staying put is always reachable, so
// the current exposure must always lie inside its own feasible interval.
console.log('\nThe book always lies inside its own feasible interval:');
{
  const cfg = buildExperimentConfig();
  const free = (asset: string, currentPercent: number): LineConstraint =>
    ({ asset, currentPercent, canReduce: true, canIncrease: true, reason: 'free' });

  // A book that would have tripped the old ceiling: 70 % held, all actionable.
  const invested = [free('BTC', 25), free('ETH', 25), free('BNB', 10), free('XRP', 10)];
  assert.doesNotThrow(() =>
    allocate({ cfg, lines: invested, currentExposurePercent: 70, band: { lowPercent: 45, highPercent: 70 } }),
  );
  console.log('  ok: a 70 % book against a 45–70 band allocates without tripping the invariant');
  passed += 1;

  // And both invariants are ARMED, not decorative.
  //
  // (b) the two views of the book must agree: 30 % of lines against a 70 % scalar.
  const mismatched: LineConstraint[] = [
    { asset: 'BTC', currentPercent: 30, canReduce: true, canIncrease: false, reason: 'no_regime' },
  ];
  assert.throws(
    () => allocate({ cfg, lines: mismatched, currentExposurePercent: 70, band: { lowPercent: 45, highPercent: 70 } }),
    /describe different books/,
  );
  console.log('  ok: per-line weights that disagree with the scalar exposure FAIL the run');
  passed += 1;

  // (a) a forced exit is excluded from BOTH sides — the line is leaving, so it neither
  //     counts against the ceiling nor has to fit under it. This is the case that showed the
  //     first formulation of the invariant was too naive: it fired on a healthy replay.
  const stoppedBook: LineConstraint[] = [
    { asset: 'BTC', currentPercent: 30, canReduce: true, canIncrease: false, reason: 'stop_exit', forceExit: true },
    free('ETH', 28),
  ];
  assert.doesNotThrow(() =>
    allocate({ cfg, lines: stoppedBook, currentExposurePercent: 58, band: { lowPercent: 45, highPercent: 70 } }),
  );
  console.log('  ok: a book holding a line the stop is exiting does NOT trip the invariant');
  passed += 1;

  // The whole calibration window must satisfy it, on every arm — the real regression net.
  const { shared } = prepareTape(ROOT);
  for (const [name, bands] of Object.entries(ARMS)) {
    assert.doesNotThrow(() => runPolicy(shared, { kind: 'band', bands }, CALIBRATION_WINDOW));
    console.log(`  ok: arm ${name} satisfies it on all 7 662 calibration bars`);
    passed += 1;
  }
}

// ── REALISED EXPOSURE MUST TRACK THE BAND ───────────────────────────────────────────
//
// The tell I missed: arm C spent 3 646 bars in a constructive band of 85–100 % and realised a
// mean exposure of 46,6 %. That was not a market fact, it was the ceiling bug — and a glance
// at the ordering would have raised it. Pinned so the next such compression is caught here.
console.log('\nRealised exposure tracks the bands — strictly ordered A < B < C:');
{
  const { shared } = prepareTape(ROOT);
  const realised = Object.entries(ARMS).map(([name, bands]) => ({
    name,
    mean: runPolicy(shared, { kind: 'band', bands }, CALIBRATION_WINDOW).metrics.meanExposurePercent,
  }));
  const [a, b, c] = realised;
  ok(`A ${a!.mean.toFixed(1)} % < B ${b!.mean.toFixed(1)} % < C ${c!.mean.toFixed(1)} %`,
    a!.mean < b!.mean && b!.mean < c!.mean);
  // C's neutral band alone starts at 50 %, and it spends most of its bars at or above neutral.
  // A realised mean far below that means the book is being held down by something other than
  // the policy — which is exactly what the broken ceiling was doing.
  ok('C realises at least its neutral floor of 50 % on average', c!.mean >= 50);
}

// ── THE DRAWDOWN IS SEEDED FROM THE CARRIED EQUITY ──────────────────────────────────
console.log('\nDrawdown on a resumed window starts from the boundary equity:');
{
  const { shared } = prepareTape(ROOT);
  const calibration = runPolicy(shared, { kind: 'constant', targetPercent: 60 }, CALIBRATION_WINDOW);
  const resumed = runPolicy(
    shared, { kind: 'constant', targetPercent: 60 }, VALIDATION_WINDOW, calibration.result.finalState,
  );
  const firstBarEquity = resumed.result.bars[0]!.equity;
  const carried = resumed.result.openingEquity;
  ok('the resumed run really opens on the carried equity, not the first bar',
    Math.abs(carried - firstBarEquity) > 1e-9);
  // If the first bar sits BELOW the carried equity, that drop is a real drawdown and must
  // appear. Seeding the peak from the first bar would erase it.
  if (firstBarEquity < carried) {
    const implied = ((carried - firstBarEquity) / carried) * 100;
    ok(`the boundary drop of ${implied.toFixed(2)}pt is counted, not erased`,
      resumed.metrics.maxDrawdownPercent >= implied - 1e-9);
  } else {
    ok('the first bar sits above the boundary equity — no drop to count on this run', true);
  }
}

// ── PROOF 11 — NO NETWORK, NO DATABASE, NO LLM ───────────────────────────────────────
console.log('\nProof 11 — the harness reaches for no network, no database and no LLM:');
{
  // Static: the harness must not even IMPORT the modules that could reach out.
  const harnessFiles = [
    'bundle.ts', 'config.ts', 'controller.ts', 'allocate.ts', 'engine.ts',
    'metrics.ts', 'arms.ts', 'tape.ts', 'outputs.ts', 'calibrate.ts', 'validate.ts',
  ];
  const forbidden = [
    { needle: 'persistence/supabase', what: 'the Supabase client' },
    { needle: '@supabase/supabase-js', what: 'the Supabase SDK' },
    { needle: '@anthropic-ai/sdk', what: 'the Anthropic SDK' },
    { needle: 'decision/llm', what: 'the LLM call path' },
    { needle: 'exchanges/binance', what: 'the exchange client' },
    { needle: 'ccxt', what: 'ccxt' },
  ];
  const offenders: string[] = [];
  // The cash floor gets the same treatment: it must not be REACHABLE, not merely unused.
  const cashFloorOffenders: string[] = [];
  for (const file of harnessFiles) {
    const text = readFileSync(path.join(ROOT, 'src', 'calibration', 'exposure', file), 'utf8');
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');
    for (const f of forbidden) if (code.includes(f.needle)) offenders.push(`${file} → ${f.what}`);
    if (code.includes('minCashPercent') || code.includes('clampAllocation')) {
      cashFloorOffenders.push(file);
    }
  }
  ok(`no harness file imports the network / DB / LLM path${offenders.length ? ` (${offenders.join(', ')})` : ''}`,
    offenders.length === 0);
  // THE ISOLATION THE PROTOCOL DEMANDS: production runs with minCashPercent = 30, the
  // experiment must have none. It is not set to zero — it is unreachable.
  ok(`the cash floor is not reachable from the harness${cashFloorOffenders.length ? ` (${cashFloorOffenders.join(', ')})` : ''}`,
    cashFloorOffenders.length === 0);

  // Dynamic: trap fetch and run a full replay. A single call fails the proof.
  const g = globalThis as unknown as Record<string, unknown>;
  const realFetch = g.fetch;
  const calls: string[] = [];
  g.fetch = (...a: unknown[]) => { calls.push(String(a[0])); throw new Error('network blocked'); };
  try {
    const { shared } = prepareTape(ROOT);
    runPolicy(shared, { kind: 'constant', targetPercent: 30 }, {
      fromMs: CALIBRATION_WINDOW.fromMs,
      toMs: CALIBRATION_WINDOW.fromMs + 200 * shared.barMs,
    });
  } finally {
    g.fetch = realFetch;
  }
  ok(`a full prepare + replay makes zero network call${calls.length ? ` (${calls.join(', ')})` : ''}`, calls.length === 0);
}

console.log(`\n${passed} exposure-calibration checks passed.`);
