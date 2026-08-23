import assert from 'node:assert/strict';
import { config } from '../config/index.js';
import { buildSystemPromptV5 } from '../decision/promptV5.js';
import { buildMandates, proveVariantProperty, MANDATE_IDS, type MandateId } from '../experiment/mandate/variants.js';
import { analyze, evaluateGate2 } from '../experiment/mandate/analyze.js';
import {
  EXPERIMENT_REPS,
  localThreshold,
  mad,
  median,
  planMainCalls,
  range,
  type CallRecord,
} from '../experiment/mandate/records.js';

/**
 * Invariants of the MANDATE-FRAMING EXPERIMENT harness — run with `npm test` (tsx,
 * no framework, no network, no database).
 *
 * What is pinned here, and why it is worth pinning OFFLINE:
 *
 *   1. the four mandates: the control IS the production prompt, each variant's
 *      addition matches the brief's frozen text, and the hard constraint ("differs
 *      by its addition and nothing else") is proved, not promised;
 *   2. the interleaving: C first as the validity phase, then P/F/O with no variant
 *      ever running as a block — the property that keeps a provider drift from
 *      masquerading as a variant effect;
 *   3. the preregistered reading: gate 2, the local threshold, the placebo gate,
 *      the negative control and the dead-cycle elimination, each exercised on
 *      synthetic records whose right answer is known by construction.
 *
 * The live halves (reconstruction fidelity, the historical replay) are gate 1's
 * job inside the runner — they need the real database and belong there.
 */

let passed = 0;

// ── 1. The four mandates ─────────────────────────────────────────────────────────

{
  const mandates = buildMandates();
  assert.equal(
    mandates.C.prompt,
    buildSystemPromptV5(config, 'enforce'),
    'the control is the production prompt (enforce), byte-identical',
  );

  const proofs = proveVariantProperty(mandates);
  for (const proof of proofs) {
    assert.ok(proof.ok, `variant ${proof.id}: ${proof.detail}`);
  }

  const shas = new Set(MANDATE_IDS.map((id) => mandates[id].sha256));
  assert.equal(shas.size, 4, 'the four mandates are four distinct prompts');

  // The additions are the BRIEF's texts, frozen — compared space-normalized so the
  // line wrapping stays a formatting choice, never a content one.
  const flat = (id: Exclude<MandateId, 'C'>): string =>
    mandates[id].insertion!.lines.join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(
    flat('P'),
    'Confidence is a portfolio-level judgment. Choose it explicitly from the strength of the evidence, rather than letting it emerge accidentally from the number of signals.',
    'P carries exactly the brief\'s placebo text',
  );
  assert.equal(
    flat('F'),
    'The 30% cash floor is a safety limit, not a recommended allocation or a cash target.',
    'F carries exactly the brief\'s floor clarification',
  );
  assert.equal(
    flat('O'),
    'Total deployed exposure is a portfolio-level decision, not merely the sum of per-asset decisions. Make that choice explicitly and intentionally.',
    'O carries exactly the brief\'s ownership text',
  );
  passed += 1;
}

// ── 2. The interleaving plan ─────────────────────────────────────────────────────

{
  const contexts = [1297, 1433, 1368, 1494];
  const plan = planMainCalls(contexts);
  assert.equal(plan.length, 80, '4 mandates × 4 contexts × 5 reps = 80 planned calls');
  assert.deepEqual(
    plan.map((p) => p.orderIndex),
    [...plan.keys()],
    'orderIndex is dense and strictly increasing',
  );

  const control = plan.filter((p) => p.phase === 'control');
  assert.equal(control.length, 20, 'the control phase is 20 calls');
  assert.ok(
    control.every((p) => p.mandate === 'C'),
    'the control phase carries only C',
  );
  assert.equal(
    Math.max(...control.map((p) => p.orderIndex)),
    19,
    'every control call precedes every variant call — C runs first, as gate 2 requires',
  );
  // Interleaved by context, not context-blocked: the first four control calls
  // cover the four contexts.
  assert.deepEqual(
    control.slice(0, 4).map((p) => p.contextId),
    contexts,
    'the control phase interleaves the four contexts',
  );

  // Every cell holds exactly EXPERIMENT_REPS calls.
  for (const mandate of MANDATE_IDS) {
    for (const ctx of contexts) {
      const n = plan.filter((p) => p.mandate === mandate && p.contextId === ctx).length;
      assert.equal(n, EXPERIMENT_REPS, `cell ${mandate}×${ctx} holds ${EXPERIMENT_REPS} calls`);
    }
  }

  // NO VARIANT BLOCKS: within one (round, context), the three variant calls are
  // three DISTINCT mandates — the latin-square property.
  const variants = plan.filter((p) => p.phase === 'variants');
  for (let rep = 1; rep <= EXPERIMENT_REPS; rep += 1) {
    for (const ctx of contexts) {
      const triple = variants.filter((p) => p.rep === rep && p.contextId === ctx).map((p) => p.mandate);
      assert.deepEqual([...triple].sort(), ['F', 'O', 'P'], `round ${rep} × ${ctx} runs P, F and O once each`);
    }
  }
  // And the rotation actually rotates: the same context does not open every round
  // with the same variant.
  const opening = new Set(
    Array.from({ length: EXPERIMENT_REPS }, (_, i) =>
      variants.find((p) => p.rep === i + 1 && p.contextId === contexts[0])!.mandate,
    ),
  );
  assert.ok(opening.size > 1, 'the latin square rotates which variant opens a context across rounds');
  passed += 1;
}

// ── 3. The preregistered arithmetic ──────────────────────────────────────────────

{
  assert.equal(median([20, 22, 21]), 21, 'odd median');
  assert.equal(median([20, 22]), 21, 'even median');
  assert.equal(range([10, 30, 20]), 20, 'range = max − min');
  assert.equal(mad([10, 10, 10]), 0, 'MAD of a constant series is 0');
  assert.equal(localThreshold([20, 20, 20, 20, 20]), 5, 'the local threshold never drops below 5 points');
  assert.equal(localThreshold([10, 30, 20, 20, 20]), 20, 'a dispersed control widens its own threshold');
  passed += 1;
}

// ── 4. The reading, on synthetic records whose right answer is known ────────────

const HISTORICAL: Record<number, number> = { 1297: 20, 1433: 22, 1368: 48, 1494: 10 };

function mkCall(
  mandate: MandateId,
  contextId: number,
  rep: number,
  exposure: number | null,
  over: Partial<CallRecord> = {},
): CallRecord {
  return {
    key: `${mandate}_${contextId}_r${rep}`,
    orderIndex: 0,
    phase: mandate === 'C' ? 'control' : 'variants',
    mandate,
    contextId,
    rep,
    startedAt: '2026-08-23T12:00:00.000Z',
    finishedAt: '2026-08-23T12:00:20.000Z',
    requestedModel: 'claude-sonnet-4-6',
    returnedModel: 'claude-sonnet-4-6',
    latencyMs: 20_000,
    inputTokens: 9000,
    outputTokens: 900,
    stopReason: 'end_turn',
    transportReplays: [],
    outcome: exposure == null ? 'invalid' : 'accepted',
    orderViolation: null,
    invalidReason: exposure == null ? 'synthetic invalid' : null,
    guardRules: [],
    requestedExposure: exposure,
    appliedExposure: exposure,
    clamped: false,
    actionType: 'rebalance',
    confidence: 'medium',
    openedZeroLines: [],
    movements: [],
    rawFile: 'none',
    ...over,
  };
}

function fill(calls: CallRecord[], mandate: MandateId, ctx: number, exposures: number[], over: Partial<CallRecord> = {}): void {
  exposures.forEach((e, i) => calls.push(mkCall(mandate, ctx, i + 1, e, over)));
}

{
  // Gate 2 passes on a faithful control, fails on a drifted one.
  const faithful: CallRecord[] = [];
  for (const [ctx, hist] of Object.entries(HISTORICAL)) fill(faithful, 'C', Number(ctx), [hist, hist, hist + 1, hist - 1, hist]);
  assert.ok(
    evaluateGate2(faithful).every((g) => g.ok),
    'gate 2 passes when the control reproduces the historical answers',
  );

  const drifted = faithful.filter((c) => c.contextId !== 1297);
  fill(drifted, 'C', 1297, [30, 31, 29, 30, 30]); // médiane 30 vs historique 20, étendue 2 → seuil 5
  const g1297 = evaluateGate2(drifted).find((g) => g.contextId === 1297)!;
  assert.ok(!g1297.ok, 'gate 2 fires when the control drifts past the local threshold');

  const starved = faithful.filter((c) => !(c.contextId === 1297 && c.rep >= 3));
  const s1297 = evaluateGate2(starved.map((c) => (c.contextId === 1297 && c.rep <= 2 ? c : c)))
    .find((g) => g.contextId === 1297)!;
  assert.ok(!s1297.ok, 'gate 2 fires when fewer than 3 control responses are usable');
  passed += 1;
}

{
  // The full reading on a crafted corpus:
  //   O carries a real +10 effect on 1297 · F moves by only +2 (below threshold) ·
  //   P stays at the control on every context → placebo clean, O's effect retained.
  const calls: CallRecord[] = [];
  for (const [ctx, hist] of Object.entries(HISTORICAL)) {
    fill(calls, 'C', Number(ctx), [hist, hist, hist + 1, hist - 1, hist]);
    fill(calls, 'P', Number(ctx), [hist, hist, hist, hist + 1, hist]);
  }
  fill(calls, 'O', 1297, [30, 31, 29, 30, 32]);
  fill(calls, 'F', 1297, [22, 21, 20, 23, 22]);
  for (const ctx of [1433, 1368]) {
    fill(calls, 'O', ctx, Array(5).fill(HISTORICAL[ctx]!) as number[]);
    fill(calls, 'F', ctx, Array(5).fill(HISTORICAL[ctx]!) as number[]);
  }
  fill(calls, 'O', 1494, [10, 10, 11, 10, 10]);
  fill(calls, 'F', 1494, [10, 10, 10, 9, 10]);

  const a = analyze(calls);
  assert.ok(a.gate2ok, 'synthetic corpus passes gate 2');

  const o1297 = a.effects.find((e) => e.mandate === 'O' && e.contextId === 1297)!;
  assert.ok(o1297.isEffect, 'a +10 shift, unreproduced by P, majority above, valid → an effect');
  const f1297 = a.effects.find((e) => e.mandate === 'F' && e.contextId === 1297)!;
  assert.ok(!f1297.isEffect, 'a +2 shift stays below the 5-point threshold → no effect');
  // The brief's §6.2 addendum: a placebo that moves NEITHER the exposure NOR the
  // confidence has not been shown to be read — it is a FAILED placebo and the
  // report must say so, rather than concluding "a salient instruction has no effect".
  assert.ok(a.placeboInert, 'a placebo moving neither exposure nor confidence is flagged inert (failed placebo)');
  passed += 1;
}

{
  // THE PLACEBO GATE: when P itself shifts past the threshold, O's identical shift
  // is no longer causally interpretable.
  const calls: CallRecord[] = [];
  for (const [ctx, hist] of Object.entries(HISTORICAL)) {
    fill(calls, 'C', Number(ctx), [hist, hist, hist, hist + 1, hist]);
    const shifted = Number(ctx) === 1297 ? 10 : 0;
    fill(calls, 'P', Number(ctx), Array(5).fill(hist + shifted) as number[]);
    fill(calls, 'O', Number(ctx), Array(5).fill(hist + shifted) as number[]);
    fill(calls, 'F', Number(ctx), Array(5).fill(hist) as number[]);
  }
  const a = analyze(calls);
  assert.ok(a.placeboMovedExposure[1297], 'P\'s own shift past the threshold is detected');
  const o1297 = a.effects.find((e) => e.mandate === 'O' && e.contextId === 1297)!;
  assert.ok(o1297.clearsThreshold && o1297.reproducedByPlacebo && !o1297.isEffect,
    'an effect reproduced by the placebo is not retained');
  passed += 1;
}

{
  // THE NEGATIVE CONTROL and the DEAD CYCLES.
  const calls: CallRecord[] = [];
  for (const [ctx, hist] of Object.entries(HISTORICAL)) {
    fill(calls, 'C', Number(ctx), [hist, hist, hist, hist + 1, hist]);
    fill(calls, 'P', Number(ctx), Array(5).fill(hist) as number[], { confidence: 'high' });
    fill(calls, 'F', Number(ctx), Array(5).fill(hist) as number[]);
  }
  // O degrades the 1494 reduction by +8 (≥ threshold 5) and opens a zero line 3/5 times.
  for (const ctx of [1297, 1433, 1368]) fill(calls, 'O', ctx, Array(5).fill(HISTORICAL[ctx]!) as number[]);
  fill(calls, 'O', 1494, [18, 18, 17, 19, 18], { openedZeroLines: ['XRP'] });
  calls.filter((c) => c.mandate === 'O' && c.contextId === 1494 && c.rep >= 4).forEach((c) => {
    c.openedZeroLines = [];
  });
  // And F loses one primary to the guard where C lost none.
  const fFail = calls.find((c) => c.mandate === 'F' && c.contextId === 1433 && c.rep === 5)!;
  fFail.outcome = 'guard_refused';
  fFail.guardRules = ['hold_moved_target'];

  const a = analyze(calls);
  const oNeg = a.negativeControl.find((n) => n.mandate === 'O')!;
  assert.ok(oNeg.eliminatedOnMedian, 'a variant degrading the 1494 reduction past the threshold is eliminated');
  assert.ok(oNeg.eliminatedOnZeroLines, 'a majority of zero-line openings eliminates the variant');
  const fDead = a.deadCycles.find((d) => d.mandate === 'F')!;
  assert.ok(fDead.eliminated, 'one more failed primary than the control eliminates the variant');
  const pDead = a.deadCycles.find((d) => d.mandate === 'P')!;
  assert.ok(!pDead.eliminated, 'a variant with no extra failed primary survives the dead-cycle rule');
  assert.ok(a.placeboMovedConfidence[1297], 'a placebo shifting the confidence distribution is detected as ACTIVE');
  passed += 1;
}

{
  // THE MAJORITY IS TAKEN OVER THE ACCEPTED RESPONSES — a failed primary carries no
  // direction, and it is already counted by the validity condition and the dead-cycle
  // rule. 3 accepted (2 above the control median) + 2 failed must read as a majority.
  const calls: CallRecord[] = [];
  for (const [ctx, hist] of Object.entries(HISTORICAL)) {
    fill(calls, 'C', Number(ctx), [hist, hist, hist, hist + 1, hist]);
    fill(calls, 'P', Number(ctx), Array(5).fill(hist) as number[]);
    fill(calls, 'F', Number(ctx), Array(5).fill(hist) as number[]);
    if (Number(ctx) !== 1297) fill(calls, 'O', Number(ctx), Array(5).fill(hist) as number[]);
  }
  fill(calls, 'O', 1297, [32, 31, 20]);
  calls.push(mkCall('O', 1297, 4, null), mkCall('O', 1297, 5, null));
  // The control fails twice too, so the validity condition is not what decides.
  for (const rep of [4, 5]) {
    const c = calls.find((x) => x.mandate === 'C' && x.contextId === 1297 && x.rep === rep)!;
    c.outcome = 'invalid';
    c.requestedExposure = null;
    c.invalidReason = 'synthetic invalid';
  }
  const a = analyze(calls);
  const o1297 = a.effects.find((e) => e.mandate === 'O' && e.contextId === 1297)!;
  assert.ok(o1297.majorityAbove, '2 of 3 ACCEPTED responses above the control median is a majority — failed primaries are not counted against it');
  assert.ok(o1297.validityHolds, 'equal failure counts keep the validity condition true');
  passed += 1;
}

{
  // CONFIDENCE IS COMPARED AS PROPORTIONS: an extended P cell (8 responses) with the
  // SAME distribution shape as C (5 responses) is not a shift, even though every raw
  // count differs by 3.
  const calls: CallRecord[] = [];
  for (const [ctx, hist] of Object.entries(HISTORICAL)) {
    fill(calls, 'C', Number(ctx), [hist, hist, hist, hist + 1, hist]);
    fill(calls, 'F', Number(ctx), Array(5).fill(hist) as number[]);
    fill(calls, 'O', Number(ctx), Array(5).fill(hist) as number[]);
    const pCount = Number(ctx) === 1494 ? 8 : 5;
    fill(calls, 'P', Number(ctx), Array(pCount).fill(hist) as number[]);
  }
  const a = analyze(calls);
  assert.ok(
    !a.placeboMovedConfidence[1494],
    'a larger cell with the same all-medium distribution is not read as a confidence shift',
  );
  passed += 1;
}

console.log(`mandate experiment invariants: ${passed} block(s) passed`);
