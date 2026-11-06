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
  // RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
  // tape, which carried the sealed window. It is reproducible from history at c10adb9.

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

// RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
// tape, which carried the sealed window. It is reproducible from history at c10adb9.

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

// RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
// tape, which carried the sealed window. It is reproducible from history at c10adb9.

// RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
// tape, which carried the sealed window. It is reproducible from history at c10adb9.

// RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
// tape, which carried the sealed window. It is reproducible from history at c10adb9.

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

// RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
// tape, which carried the sealed window. It is reproducible from history at c10adb9.

// RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
// tape, which carried the sealed window. It is reproducible from history at c10adb9.

// RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
// tape, which carried the sealed window. It is reproducible from history at c10adb9.

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

// RETIRED with the v1 bundle (bench v1.3): this proof replayed the PR #36 engine on the v1
// tape, which carried the sealed window. It is reproducible from history at c10adb9.
}

console.log(`\n${passed} exposure-calibration checks passed.`);
