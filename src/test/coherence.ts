import assert from 'node:assert/strict';
import { Decimal } from '../money.js';
import {
  resolveCoherenceGuard,
  validateDecisionTimingConfig,
  config,
  type DecisionConfig,
  type SchedulerConfig,
} from '../config/index.js';
import {
  buildDecisionSchema,
  outputOrderViolation,
  OUTPUT_ORDER_ANCHORS,
} from '../decision/schema.js';
import {
  buildRetryPrompt,
  checkCoherence,
  type CoherenceInput,
  type CoherenceRule,
} from '../decision/coherence.js';
import type { Movement } from '../execution/movements.js';
import type { PositionNote } from '../decision/schema.js';

/**
 * COHERENCE GUARD invariants — run with `npm test` (tsx).
 *
 * The corpus replay (`npm run replay:coherence`) proves the guard's verdict on 139 real
 * production responses. These tests prove the RULES, one at a time, including the shapes
 * the corpus happens not to contain — a corpus can only ever test what actually happened.
 */

let passed = 0;
const ok = (label: string, condition: boolean): void => {
  assert.ok(condition, label);
  console.log(`  ok: ${label}`);
  passed += 1;
};

/* ── Fixtures ─────────────────────────────────────────────────────────────────── */

const REFERENCE = { BTC: 25, ETH: 20, BNB: 12, XRP: 0, USDT: 43 };

const note = (asset: string, replace = false): PositionNote => ({
  asset,
  thesis: 'a thesis',
  invalidation: 'an invalidation',
  replace,
});

const movement = (asset: string, side: 'buy' | 'sell' = 'sell', fullExit = false): Movement => ({
  symbol: `${asset}/USDT`,
  asset,
  side,
  qty: new Decimal(1),
  price: new Decimal(100),
  notional: new Decimal(100),
  fee: new Decimal(0.1),
  fullExit,
});

const input = (over: Partial<CoherenceInput> = {}): CoherenceInput => ({
  strategy: 'v5',
  actionType: 'hold',
  effectiveTarget: { ...REFERENCE },
  referenceTarget: { ...REFERENCE },
  movements: [],
  reserveAsset: 'USDT',
  notes: [],
  assetsWithStoredThesis: new Set<string>(),
  ...over,
});

const rules = (i: CoherenceInput): CoherenceRule[] => checkCoherence(i).violations.map((v) => v.rule);

/* ── The baseline: the ordinary hold, which is 123 of the 128 real cycles ──────── */

{
  const verdict = checkCoherence(input());
  ok('an unchanged hold with no notes and no movements passes', verdict.ok);

  // THE trap the brief names first. The book drifts constantly — BTC is worth 24.46%
  // against a 25% target purely because the price moved — so a guard that compared the
  // target to the VALUATION would reject every hold the bot ever makes.
  ok(
    'the guard never looks at the book valuation, only at the previous target',
    checkCoherence(input({ effectiveTarget: { ...REFERENCE } })).ok,
  );
}

/* ── Rule 1 — a hold cannot move the reference target ─────────────────────────── */

{
  // The 946 / 948 / 957 shape, one point of BNB.
  const moved = input({
    effectiveTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
  });
  ok('a hold that moved the target is rejected', rules(moved).includes('hold_moved_target'));

  ok(
    'a NON-hold that moves the target is not rejected by rule 1',
    !rules(input({ actionType: 'rebalance', effectiveTarget: { ...REFERENCE, BNB: 11, USDT: 44 }, movements: [movement('BNB')], notes: [note('BNB')] })).includes(
      'hold_moved_target',
    ),
  );

  // No reference at all — the very first decision on record. Nothing to have modified.
  ok(
    'a hold with no reference target at all is not rejected (the first decision ever)',
    checkCoherence(input({ referenceTarget: null, effectiveTarget: { BTC: 30, USDT: 70 } })).ok,
  );

  // Float noise must not read as intent. A deliberate move is points, not hundredths.
  ok(
    'a re-emitted target with float noise is the same target',
    checkCoherence(input({ effectiveTarget: { ...REFERENCE, BTC: 25.001 } })).ok,
  );
  ok(
    'half a point IS a change and is caught',
    rules(input({ effectiveTarget: { ...REFERENCE, BTC: 25.5, USDT: 42.5 } })).includes('hold_moved_target'),
  );

  // THE UNIVERSE-CHANGE FALSE POSITIVE. A pair can drop out of the tradable universe
  // between two wake-ups (a dead feed). The target then legitimately omits that key, and
  // comparing over the UNION would read the code's own universe change as the model
  // changing its mind — rejecting every hold for as long as the feed stayed down.
  const shrunk = input({
    effectiveTarget: { BTC: 25, ETH: 20, BNB: 12, USDT: 43 }, // XRP (at 0) gone
  });
  ok('an asset leaving the universe is not the model changing its mind', checkCoherence(shrunk).ok);

  // AND THE HARDER HALF OF THE SAME EVENT, which the case above does not exercise because
  // XRP sat at 0. When the vanished asset carried REAL weight, the schema still requires
  // the remaining allocations to sum to 100, so those points MUST be reassigned — and the
  // neutral place is cash. Compared naively, the reserve then looks like it moved by the
  // whole orphaned weight, every genuine hold is rejected, and the retry cannot fix it
  // either: re-emitting the old target is impossible, its key is now forbidden. The bot
  // would die on every cycle for as long as the feed stayed down.
  const heldReference = { BTC: 25, ETH: 20, BNB: 12, XRP: 8, USDT: 35 };
  const feedLost = input({
    referenceTarget: heldReference,
    effectiveTarget: { BTC: 25, ETH: 20, BNB: 12, USDT: 43 }, // XRP's 8 parked in cash
  });
  ok(
    'a dropped feed whose line held real weight still reads as a hold',
    checkCoherence(feedLost).ok,
  );

  // But reassigning that orphaned weight into a COIN is a real allocation decision, and a
  // `hold` claiming otherwise is still caught. The normalisation absolves the forced move
  // to cash, not every redistribution.
  ok(
    'parking the orphaned weight in a coin instead of cash is still a decision',
    rules(
      input({
        referenceTarget: heldReference,
        effectiveTarget: { BTC: 33, ETH: 20, BNB: 12, USDT: 35 }, // XRP's 8 → BTC
      }),
    ).includes('hold_moved_target'),
  );
}

/* ── Rule 2 — a moved target that cannot trade is invalid ─────────────────────── */

{
  // 946 again, from the other angle: the target moved AND no order can come of it.
  const inexecutable = input({
    actionType: 'rebalance',
    effectiveTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
    movements: [],
    notes: [],
  });
  ok(
    'a moved target producing no movement is rejected even when it is not a hold',
    rules(inexecutable).includes('target_not_executable'),
  );

  ok(
    'a moved target that DOES produce a movement passes rule 2',
    !rules(
      input({
        actionType: 'rebalance',
        effectiveTarget: { ...REFERENCE, BNB: 8, USDT: 47 },
        movements: [movement('BNB')],
        notes: [note('BNB')],
      }),
    ).includes('target_not_executable'),
  );

  // THE SECOND FALSE POSITIVE, and the reason rule 2 is conditioned on the target having
  // moved. A de_risk that re-emits the same target while the book has drifted three
  // points DOES produce a real order. Judging executability on the target-to-target delta
  // alone would reject it.
  ok(
    'an unchanged target that still produces a drift order is not "inexecutable"',
    checkCoherence(
      input({ actionType: 'de_risk', movements: [movement('BTC')], notes: [note('BTC')] }),
    ).ok,
  );

  // ASKED PER MOVED ASSET, NOT PORTFOLIO-WIDE. "Is there any movement at all" is a
  // different question and the wrong one: the book drifts on its own, so an UNCHANGED
  // BTC target can produce a drift order while the one-point BNB change the model
  // actually intended produces nothing. Answering "yes, something moved" would accept
  // the decision, trade only BTC, and silently discard the intent.
  const unrelated = input({
    actionType: 'rebalance',
    effectiveTarget: { ...REFERENCE, BNB: 11, USDT: 44 }, // one point — under the floor
    movements: [movement('BTC', 'buy')], // BTC drifted; BTC's target did NOT move
    notes: [note('BTC')],
    assetsWithStoredThesis: new Set(['BTC']),
  });
  ok(
    'an unrelated drift order does not make a sub-floor target change executable',
    rules(unrelated).includes('target_not_executable'),
  );

  // THE RESERVE TRAP, which is why this is not simply "every moved asset must trade".
  // Cash moves on EVERY trade — it is the other side of every leg — and is never traded
  // directly (computeMovements skips it outright). Requiring a movement for it would
  // reject every legitimate rebalance the bot ever makes.
  const realTrim = input({
    actionType: 'de_risk',
    effectiveTarget: { ...REFERENCE, BNB: 8, USDT: 47 }, // BNB -4, USDT +4
    movements: [movement('BNB')], // only BNB trades; USDT never does
    notes: [note('BNB')],
    assetsWithStoredThesis: new Set(['BNB']),
  });
  ok('the reserve moving without its own order is not an incoherence', checkCoherence(realTrim).ok);

  // "At least one" moved coin must trade, not "all of them". A 6-point BNB trim with a
  // 1-point ETH nibble alongside DOES execute the decision; the sub-floor ETH leg is the
  // documented, measured residual of the 2% floor, not an incoherence.
  const withResidual = input({
    actionType: 'de_risk',
    effectiveTarget: { ...REFERENCE, BNB: 6, ETH: 19, USDT: 50 },
    movements: [movement('BNB')], // ETH's one point stays under the floor
    notes: [note('BNB')],
    assetsWithStoredThesis: new Set(['BNB']),
  });
  ok('a sub-floor residual alongside a real move is not an incoherence', checkCoherence(withResidual).ok);
}

/* ── Rule 3 — the mirror of mayWriteThesis ────────────────────────────────────── */

{
  // The 987 / 1000 / 1008 shape: a thesis rewritten on a line that already has one and
  // is not moving.
  const restated = input({
    notes: [note('BNB', true)],
    assetsWithStoredThesis: new Set(['BNB']),
  });
  ok('a thesis restated on an unmoved line that has one is rejected', rules(restated).includes('note_on_unmoved_line'));

  ok(
    'replace: true does not buy the rewrite',
    rules(input({ notes: [note('BNB', true)], assetsWithStoredThesis: new Set(['BNB']) })).includes(
      'note_on_unmoved_line',
    ),
  );

  // THE CYCLE-879 FALSE POSITIVE — the single most expensive one to miss. The first v5
  // cycle opened four theses on four untouched lines, and every one was legitimate
  // because none of those lines had a thesis yet. A rule written as "a note requires the
  // line to move" rejects it, and with it the whole bootstrap of the strategy.
  const firstTheses = input({
    notes: [note('BTC'), note('ETH'), note('BNB'), note('XRP')],
    assetsWithStoredThesis: new Set<string>(),
  });
  ok('four first theses on four untouched lines pass (the cycle-879 shape)', checkCoherence(firstTheses).ok);

  ok(
    'a thesis on a line that DOES move is accepted even when it already has one',
    checkCoherence(
      input({
        actionType: 'rebalance',
        effectiveTarget: { ...REFERENCE, BNB: 8, USDT: 47 },
        movements: [movement('BNB')],
        notes: [note('BNB')],
        assetsWithStoredThesis: new Set(['BNB']),
      }),
    ).ok,
  );
}

/* ── Rule 4 — a line that moves must say what it is now betting on ────────────── */

{
  const silent = input({
    actionType: 'rebalance',
    effectiveTarget: { ...REFERENCE, BNB: 8, USDT: 47 },
    movements: [movement('BNB')],
    notes: [],
    assetsWithStoredThesis: new Set(['BNB']),
  });
  ok('a line that moves without its note is rejected', rules(silent).includes('moved_line_without_note'));

  // A FULL EXIT IS EXEMPT, and deliberately so: nextPositionState clears the thesis and
  // its invalidation on a full exit, so demanding a note there demands output the code is
  // contractually about to discard.
  const exit = input({
    actionType: 'rotate',
    effectiveTarget: { ...REFERENCE, XRP: 0 },
    movements: [movement('XRP', 'sell', true)],
    notes: [],
  });
  ok('a full exit needs no note — the code clears the thesis of a closed line anyway', checkCoherence(exit).ok);

  // But a full exit that DOES carry a note is still fine (cycle 935 did exactly that).
  ok(
    'a full exit that supplies a note anyway is accepted',
    checkCoherence({ ...exit, notes: [note('XRP')] }).ok,
  );
}

/* ── v4: the thesis rules must NOT be armed, or the guard is a trading freeze ─── */

{
  // A thesis is a v5 concept. The v4 schema has no `position_notes` at all, so
  // `validateDecision` can only ever hand back an empty array under v4 — which means an
  // armed rule 4 fires on EVERY non-full-exit movement and the retry cannot satisfy it
  // (adding the field fails the v4 schema). Ordinary buys, partial sells and rebalances
  // would all be refused twice.
  //
  // And v4 is not a dead branch: STRATEGY_VERSION absent resolves to v4 BY DESIGN. That
  // is the posture that makes "an environment that lost its variables comes back safe"
  // true. A guard that cannot be satisfied under v4 would turn that fallback from
  // "trades under the old mandate" into "cannot trade at all".
  const v4Move = input({
    strategy: 'v4',
    actionType: 'rebalance',
    effectiveTarget: { ...REFERENCE, BNB: 8, USDT: 47 },
    movements: [movement('BNB')],
    notes: [], // v4 CANNOT produce notes — the schema has no such field
    assetsWithStoredThesis: new Set(['BNB']),
  });
  ok('v4: a movement with no note is NOT rejected (v4 cannot emit notes at all)', checkCoherence(v4Move).ok);

  ok(
    'v4: a partial trim, a buy and a rebalance all still execute',
    checkCoherence({ ...v4Move, actionType: 'de_risk' }).ok &&
      checkCoherence({
        ...v4Move,
        // A buy: the line whose target moved is the line that trades. (Moving BNB's
        // target while BTC is what trades is a DIFFERENT decision, and rule 2 rejects
        // it under v4 exactly as it does under v5 — that rule is strategy-agnostic.)
        effectiveTarget: { ...REFERENCE, BTC: 31, USDT: 37 },
        movements: [movement('BTC', 'buy')],
      }).ok,
  );

  // But the strategy-agnostic rules stay armed: a hold that moved its target, and a
  // target that cannot produce an order, are incoherent under any mandate.
  ok(
    'v4: rule 1 stays armed',
    rules(input({ strategy: 'v4', effectiveTarget: { ...REFERENCE, BNB: 11, USDT: 44 } })).includes(
      'hold_moved_target',
    ),
  );
  ok(
    'v4: rule 2 stays armed',
    rules(
      input({
        strategy: 'v4',
        actionType: 'rebalance',
        effectiveTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
        movements: [],
      }),
    ).includes('target_not_executable'),
  );
}

/* ── Several rules can fire at once, and all of them are reported ─────────────── */

{
  const both = input({
    effectiveTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
    notes: [note('ETH')],
    assetsWithStoredThesis: new Set(['ETH']),
  });
  const fired = rules(both);
  ok(
    'every violated rule is reported, not just the first',
    fired.includes('hold_moved_target') &&
      fired.includes('target_not_executable') &&
      fired.includes('note_on_unmoved_line'),
  );
}

/* ── The retry message names the ways out — the cycle-1000 survival condition ─── */

{
  const message = buildRetryPrompt(checkCoherence(input({
    notes: [note('BNB', true)],
    assetsWithStoredThesis: new Set(['BNB']),
  })).violations);

  ok('the retry states the rejected rule verbatim', message.includes('note_on_unmoved_line'));
  ok('the retry offers correcting the decision', /CORRECT THE DECISION/.test(message));
  ok('the retry offers a genuine hold', /ABSTAIN/.test(message));
  // THE ONE THAT KEEPS CYCLE 1000 ALIVE. Without it the model tries to justify the note
  // instead of dropping it, and the cycle dies on the second attempt — trading a lost
  // trade for a lost cycle, which is not a fix.
  ok('the retry explicitly allows dropping the note and holding cleanly', /DROP THE NOTE AND HOLD CLEANLY/.test(message));
  ok(
    'and says plainly that dropping the note is a correct answer, not a fallback',
    message.includes('This is a correct'),
  );
}

/* ── The output contract's ORDER, pinned against the schema itself ────────────── */

{
  for (const strategy of ['v4', 'v5'] as const) {
    const shape = buildDecisionSchema(['BTC', 'USDT'], strategy).shape as Record<string, unknown>;
    const keys = Object.keys(shape);
    const reasoningAt = keys.indexOf('reasoning');
    const targetAt = keys.indexOf('target_allocation');
    const actionAt = keys.indexOf('action_type');
    const notifyAt = keys.indexOf('notification_summary');

    ok(`${strategy}: reasoning is declared before target_allocation`, reasoningAt >= 0 && reasoningAt < targetAt);
    ok(`${strategy}: reasoning is declared before action_type`, reasoningAt < actionAt);
    // 987's notification announced an allègement its own target never made. Emitting it
    // after the target is what makes that shape impossible to write.
    ok(`${strategy}: notification_summary comes AFTER the target it describes`, targetAt < notifyAt);
  }
  const v5Keys = Object.keys(buildDecisionSchema(['BTC', 'USDT'], 'v5').shape as Record<string, unknown>);
  ok(
    'v5: position_notes comes after the target they belong to',
    v5Keys.indexOf('target_allocation') < v5Keys.indexOf('position_notes'),
  );
}

/* ── The systemic detector ────────────────────────────────────────────────────── */

{
  const correct = '{"reasoning":"...","what_changed":"...","target_allocation":{"BTC":25},"action_type":"hold"}';
  const inverted = '{"target_allocation":{"BTC":25},"action_type":"hold","reasoning":"...","what_changed":"..."}';

  ok('a correctly ordered response reports no violation', outputOrderViolation(correct) === null);
  ok('a response that decided before it reasoned is caught', outputOrderViolation(inverted) !== null);
  // A response missing an anchor is the schema parser's problem, not this check's — it
  // must not manufacture a systemic alert out of an ordinary parse failure.
  ok('a response missing an anchor reports nothing here', outputOrderViolation('{"action_type":"hold"}') === null);
  ok('the anchors are exactly the two load-bearing fields', OUTPUT_ORDER_ANCHORS.join(',') === 'reasoning,target_allocation');
}

/* ── The flag: ABSENCE MEANS SAFE, and safe means ARMED ───────────────────────── */

{
  // The whole safety property in one line: there is nothing to set on Railway to be
  // protected, so the guard cannot be disabled by omission or by a lost environment.
  assert.equal(resolveCoherenceGuard(undefined), true, 'ABSENT resolves to armed');
  assert.equal(resolveCoherenceGuard(''), true, 'empty resolves to armed');
  assert.equal(resolveCoherenceGuard('   '), true, 'whitespace-only resolves to armed');
  assert.equal(resolveCoherenceGuard('on'), true, '"on" arms it');
  assert.equal(resolveCoherenceGuard('off'), false, '"off" is the explicit opt-out');
  assert.equal(resolveCoherenceGuard(' off '), false, 'a padded value is trimmed, not rejected');

  for (const bad of ['OFF', 'ON', 'false', 'true', '0', '1', 'no', 'disabled', 'null', 'v5']) {
    assert.throws(
      () => resolveCoherenceGuard(bad),
      /Invalid COHERENCE_GUARD/,
      `"${bad}" must fail loudly rather than fall back`,
    );
  }
  console.log('  ok: COHERENCE_GUARD — absent=armed, on=armed, off=disarmed, anything else fails loudly');
  passed += 1;
}

/* ── The time budget, asserted the way the running process asserts it ─────────── */

{
  const scheduler = (maxCycleSeconds: number): SchedulerConfig => ({
    ...config.scheduler,
    maxCycleSeconds,
  });
  const decision = (attemptTimeoutSeconds: number, retryReserveSeconds: number): DecisionConfig => ({
    ...config.decision,
    attemptTimeoutSeconds,
    retryReserveSeconds,
  });

  // The shipped values must fit, or the assertion below is theatre.
  validateDecisionTimingConfig(config.decision, config.scheduler);
  ok(
    'the shipped timing fits the cycle budget with room to spare',
    2 * config.decision.attemptTimeoutSeconds + config.decision.retryReserveSeconds <=
      config.scheduler.maxCycleSeconds,
  );

  // Two bounded attempts plus the reserve must fit. A cycle that needed its retry would
  // otherwise be force-exited by the watchdog MID-EXECUTION — after a booking, possibly
  // before its trace.
  assert.throws(
    () => validateDecisionTimingConfig(decision(140, 45), scheduler(300)),
    /must fit inside maxCycleSeconds/,
    'two attempts that overflow the budget must fail the boot',
  );
  assert.throws(
    () => validateDecisionTimingConfig(decision(90, 0), scheduler(300)),
    /retryReserveSeconds must be > 0/,
    'a zero post-decision reserve must fail the boot',
  );
  // And it must react to the MAX_CYCLE_SECONDS override, not just to the default.
  assert.throws(
    () => validateDecisionTimingConfig(decision(90, 45), scheduler(120)),
    /must fit inside maxCycleSeconds/,
    'a shrunk cycle budget must fail the boot too',
  );
  console.log('  ok: the decision timing is asserted against the cycle budget at startup');
  passed += 1;
}

console.log(`\n${passed} coherence-guard checks passed.`);
