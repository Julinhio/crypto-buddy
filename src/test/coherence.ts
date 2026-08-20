import assert from 'node:assert/strict';
import { Decimal } from '../money.js';
import {
  resolveCoherenceGuard,
  validateDecisionTimingConfig,
  config,
  type AppConfig,
  type DecisionConfig,
  type SchedulerConfig,
} from '../config/index.js';
import { clampAllocation } from '../risk/clamp.js';
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
import { restateIntentReference } from '../decision/intentReference.js';
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
  intentTarget: { ...REFERENCE },
  intentReference: { ...REFERENCE },
  movements: [],
  // No standing plan by default: the previous intention already executed, so replaying it
  // against today's book produces nothing. The rule-2 cases that need one pass it in.
  previousIntentMovements: [],
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
    checkCoherence(input({ intentTarget: { ...REFERENCE } })).ok,
  );
}

/* ── Rule 1 — a hold cannot move the reference target ─────────────────────────── */

{
  // The 946 / 948 / 957 shape, one point of BNB.
  const moved = input({
    intentTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
  });
  ok('a hold that moved the target is rejected', rules(moved).includes('hold_moved_target'));

  ok(
    'a NON-hold that moves the target is not rejected by rule 1',
    !rules(input({ actionType: 'rebalance', intentTarget: { ...REFERENCE, BNB: 11, USDT: 44 }, movements: [movement('BNB')], notes: [note('BNB')] })).includes(
      'hold_moved_target',
    ),
  );

  // No reference at all — the very first decision on record. Nothing to have modified.
  ok(
    'a hold with no reference target at all is not rejected (the first decision ever)',
    checkCoherence(input({ intentReference: null, intentTarget: { BTC: 30, USDT: 70 } })).ok,
  );

  // Float noise must not read as intent. A deliberate move is points, not hundredths.
  ok(
    'a re-emitted target with float noise is the same target',
    checkCoherence(input({ intentTarget: { ...REFERENCE, BTC: 25.001 } })).ok,
  );
  ok(
    'half a point IS a change and is caught',
    rules(input({ intentTarget: { ...REFERENCE, BTC: 25.5, USDT: 42.5 } })).includes('hold_moved_target'),
  );

  // THE UNIVERSE-CHANGE FALSE POSITIVE, now proven END TO END — the restatement pipeline
  // feeding the guard, which is the composition production runs.
  //
  // A pair can drop out of the tradable universe between two wake-ups (a dead feed). The
  // target then legitimately omits that key, and comparing over the UNION would read the
  // code's own universe change as the model changing its mind — rejecting every hold for
  // as long as the feed stayed down.
  //
  // The guard itself no longer restates anything: `restateIntentReference` is the single
  // entry point, and passing it a raw reference is now the caller's job. Testing the two
  // together is deliberate — the property that matters is not "the pipeline drops a key",
  // it is "an honest hold survives a dead feed".
  const restated = (
    reference: Record<string, number>,
    universe: readonly string[],
  ): Record<string, number> => {
    const result = restateIntentReference({ reference, universe, reserveAsset: 'USDT', policy: config });
    assert.ok(result.ok, 'the restatement must succeed on a legal allocation');
    return result.ok ? result.value.intent : {};
  };
  const SHRUNK_UNIVERSE = ['BTC', 'ETH', 'BNB', 'USDT'];

  const shrunk = input({
    intentReference: restated(REFERENCE, SHRUNK_UNIVERSE),
    intentTarget: { BTC: 25, ETH: 20, BNB: 12, USDT: 43 }, // XRP (at 0) gone
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
    intentReference: restated(heldReference, SHRUNK_UNIVERSE),
    intentTarget: { BTC: 25, ETH: 20, BNB: 12, USDT: 43 }, // XRP's 8 parked in cash
  });
  ok(
    'a dropped feed whose line held real weight still reads as a hold',
    checkCoherence(feedLost).ok,
  );

  // But reassigning that orphaned weight into a COIN is a real allocation decision, and a
  // `hold` claiming otherwise is still caught. The restatement absolves the forced move to
  // cash, not every redistribution.
  ok(
    'parking the orphaned weight in a coin instead of cash is still a decision',
    rules(
      input({
        intentReference: restated(heldReference, SHRUNK_UNIVERSE),
        intentTarget: { BTC: 33, ETH: 20, BNB: 12, USDT: 35 }, // XRP's 8 → BTC
      }),
    ).includes('hold_moved_target'),
  );
}

/* ── Rule 2 — a moved target that cannot trade is invalid ─────────────────────── */

{
  // 946 again, from the other angle: the target moved AND no order can come of it.
  const inexecutable = input({
    actionType: 'rebalance',
    intentTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
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
        intentTarget: { ...REFERENCE, BNB: 8, USDT: 47 },
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
    intentTarget: { ...REFERENCE, BNB: 11, USDT: 44 }, // one point — under the floor
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
    intentTarget: { ...REFERENCE, BNB: 8, USDT: 47 }, // BNB -4, USDT +4
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
    intentTarget: { ...REFERENCE, BNB: 6, ETH: 19, USDT: 50 },
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
        intentTarget: { ...REFERENCE, BNB: 8, USDT: 47 },
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
    intentTarget: { ...REFERENCE, BNB: 8, USDT: 47 },
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
    intentTarget: { ...REFERENCE, XRP: 0 },
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
    intentTarget: { ...REFERENCE, BNB: 8, USDT: 47 },
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
        intentTarget: { ...REFERENCE, BTC: 31, USDT: 37 },
        movements: [movement('BTC', 'buy')],
      }).ok,
  );

  // But the strategy-agnostic rules stay armed: a hold that moved its target, and a
  // target that cannot produce an order, are incoherent under any mandate.
  ok(
    'v4: rule 1 stays armed',
    rules(input({ strategy: 'v4', intentTarget: { ...REFERENCE, BNB: 11, USDT: 44 } })).includes(
      'hold_moved_target',
    ),
  );
  ok(
    'v4: rule 2 stays armed',
    rules(
      input({
        strategy: 'v4',
        actionType: 'rebalance',
        intentTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
        movements: [],
      }),
    ).includes('target_not_executable'),
  );
}

/* ── Several rules can fire at once, and all of them are reported ─────────────── */

{
  const both = input({
    intentTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
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


/* ── Rule 2, THE TWO CONTRADICTORY TESTS ─────────────────────────────────────
 *
 * Rule 2 has refused exactly once in the bot's entire history (decision 1072, 03/08,
 * recovered on the retry), and the response that was refused is not even replayable —
 * `raw_response` keeps the CORRECTED answer, not the rejected one. So the rule is not
 * validated by measurement, and it never will be at this rate. It holds by its invariant.
 *
 * An invariant that only one test defends is not defended. A single test pins one side of
 * the boundary and says nothing about the other: a rule that accepts EVERYTHING passes the
 * "must accept" test, a rule that refuses everything passes the "must refuse" test. So both
 * sides are pinned here, deliberately as a pair, and each one names the mutation it kills.
 * ──────────────────────────────────────────────────────────────────────────── */

{
  // ── TOO PERMISSIVE — the test that fails if the counterfactual becomes an escape hatch.
  //
  // The 946 shape, replayed under the new rule: BNB moves by one point, and NEITHER plan
  // can touch it — the new target sits one point from the book, the standing intention
  // sits ON the book. One point of a ~$1000 book is ~$10, under the 2% floor, in both
  // directions. Nothing about this decision can reach the book, so it must be refused.
  //
  // This is the case that dies if rule 2 is weakened to "accept whenever a previous plan
  // exists", or to "accept whenever anything at all moves this cycle".
  const voidChange = input({
    actionType: 'rebalance',
    intentTarget: { ...REFERENCE, BNB: 11, USDT: 44 },
    movements: [],
    previousIntentMovements: [],
  });
  ok(
    'too permissive: a change neither plan can execute is still REFUSED',
    rules(voidChange).includes('target_not_executable'),
  );

  // And it stays refused when the cycle trades something ELSE. An unrelated drift order on
  // BTC is not the decision the model just wrote, and counting it would silently discard
  // the BNB intent while reporting success.
  ok(
    'too permissive: an unrelated drift order does not rescue it',
    rules({
      ...voidChange,
      movements: [movement('BTC', 'buy')],
      previousIntentMovements: [movement('BTC', 'buy')],
      notes: [note('BTC')],
      assetsWithStoredThesis: new Set(['BTC']),
    }).includes('target_not_executable'),
  );
}

{
  // ── TOO STRICT — the test that fails if rule 2 keeps judging on the new plan alone.
  //
  // THE CANCELLATION. The standing intention wants BNB at 20% while the book holds 12%;
  // the transition gate refused that vector, so the buy never executed and the intention
  // is still standing. The model now withdraws it and re-emits 12% — the weight the book
  // actually holds. The new plan produces NOTHING on BNB, because 12% is where the line
  // already is.
  //
  // Judged on the new plan alone that reads as void and is refused, which would trap the
  // model inside a plan the gate will not let through: it cannot execute the 20%, and it
  // is not allowed to withdraw it either. Judged in counterfactual it is exactly what it
  // is — a decision that cancels a pending order, which reaches the book as surely as one
  // that places a new one.
  const withdrawal = input({
    actionType: 'rebalance',
    intentReference: { ...REFERENCE, BNB: 20, USDT: 35 },
    intentTarget: { ...REFERENCE }, // back to BNB 12 — where the book already sits
    movements: [], // nothing to do: the book is already at 12%
    previousIntentMovements: [movement('BNB', 'buy')], // ...but the standing plan WOULD have bought
  });
  ok(
    'too strict: withdrawing a standing plan the gate refused is ACCEPTED',
    checkCoherence(withdrawal).ok,
  );

  // The proof that the acceptance comes from the counterfactual and not from somewhere
  // else: drop the standing plan and the very same decision is refused again.
  ok(
    'and without a standing plan to cancel, the identical decision IS refused',
    rules({ ...withdrawal, previousIntentMovements: [] }).includes('target_not_executable'),
  );

  // The counterfactual is read PER LINE, not as a global "something was pending". A
  // standing plan on ETH says nothing about whether the BNB change can reach the book.
  ok(
    'a standing plan on ANOTHER line does not rescue an unexecutable change',
    rules({ ...withdrawal, previousIntentMovements: [movement('ETH', 'buy')] }).includes(
      'target_not_executable',
    ),
  );
}

{
  // ── THE BOUNDARY BETWEEN THE TWO, pinned because the review argued for moving it.
  //
  // Codex proposed restricting the counterfactual to a FULL cancellation back to the book,
  // on the grounds that a partial withdrawal leaves an intention that is itself
  // unexecutable. The case: the book holds BNB at 12%, the standing intention the gate
  // refused wants 15% (an executable 3-point buy), and the model now says 13% — one point
  // above the book, suppressed by the floor.
  //
  // IT IS ACCEPTED, deliberately, and the argument is what rule 2 actually asks. The
  // question is not "is the new intention reachable on its own" — it is "does this line's
  // fate differ because of the decision". It does: without this cycle a 3-point buy fires,
  // with it nothing does. Cancelling an order is reaching the book, and a de-escalation the
  // gate has already blocked is exactly the decision the model must be allowed to make.
  // Demanding a full retreat to the book would refuse it and re-trap the model inside a
  // plan it can neither execute nor withdraw — the failure the "too strict" case above
  // exists to prevent.
  const partialWithdrawal = input({
    actionType: 'rebalance',
    intentReference: { ...REFERENCE, BNB: 15, USDT: 40 },
    intentTarget: { ...REFERENCE, BNB: 13, USDT: 42 }, // one point above the book at 12
    movements: [], // the 1-point buy is under the floor
    previousIntentMovements: [movement('BNB', 'buy')], // the 3-point buy was not
  });
  ok('a PARTIAL withdrawal of a refused plan is accepted too', checkCoherence(partialWithdrawal).ok);

  // AND THE PERMISSIVENESS IS EXACTLY ONE CYCLE WIDE, which is the half of the argument
  // that actually needed evidence. Next cycle the reference is 13 and the book is still 12,
  // so the standing plan is sub-floor as well — both plans are void and the guard bites. The
  // intention cannot be walked away from the book one sub-floor step at a time.
  ok(
    'and the NEXT sub-floor nibble is refused — the intention cannot drift step by step',
    rules(
      input({
        actionType: 'rebalance',
        intentReference: { ...REFERENCE, BNB: 13, USDT: 42 },
        intentTarget: { ...REFERENCE, BNB: 14, USDT: 41 },
        movements: [],
        previousIntentMovements: [], // 13 against a book at 12 is itself under the floor
      }),
    ).includes('target_not_executable'),
  );
}

/* ── RULE 1 IS POLICY-INVARIANT — the defect this PR closes, both directions ───
 *
 * Rule 1 asks whether the model changed its mind. Its two operands are raw, unclamped
 * intentions, so no cap and no cash floor appears anywhere in its verdict. That is not a
 * convenience — it is what makes BOTH failure directions impossible at once:
 *
 *   TIGHTENED  (closed by PR #28, and it must stay closed) a reference bounded at 35 was
 *              compared against a candidate the clamp now holds at 30. Every hold was
 *              rejected, no `decided` row was written, the reference never advanced, and
 *              the risk-mandated reduction never executed. An interlock, not a bad verdict.
 *   RELAXED    (the case this PR closes) a reference bounded at 35 under a ceiling that has
 *              since been raised to 40. The model re-emits its unchanged 40% ask, the guard
 *              reads a moved target, and the first attempt is rejected — every cycle, for
 *              as long as the model keeps asking.
 *
 * The cases below run the guard under synthetic policies built as spreads over the shipped
 * config. They never mutate the real one.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The shipped config with some caps replaced. Never mutates the real one. */
const withCaps = (perAsset: Record<string, number>, minCashPercent?: number): AppConfig => ({
  ...config,
  execution: {
    ...config.execution,
    caps: {
      ...config.execution.caps,
      perAsset: { ...config.execution.caps.perAsset, ...perAsset },
      minCashPercent: minCashPercent ?? config.execution.caps.minCashPercent,
    },
  },
});

{
  // THE RELAXED CASE, reproduced. The model has been asking for BTC 40 all along; the cap
  // was 35, so the chain applied 35. The cap is raised to 40 today.
  const relaxed = withCaps({ BTC: 40 });
  const rawAsk = { BTC: 40, ETH: 18, BNB: 12, XRP: 0, USDT: 30 };

  // What the OLD reference would have been — the applied allocation of that day, bounded
  // at 35. Kept here to state precisely what changed.
  const oldStyleReference = clampAllocation(rawAsk, 'USDT', withCaps({ BTC: 35 })).applied;
  assert.equal(oldStyleReference.BTC, 35, 'the stored applied target was bounded at the old cap');

  const verdict = checkCoherence(
    input({ actionType: 'hold', intentReference: { ...rawAsk }, intentTarget: { ...rawAsk } }),
  );
  ok('relaxed cap: the unchanged 40% ask is a HOLD and is accepted on the first attempt', verdict.ok);
  ok('relaxed cap: no violation at all, so no retry is consumed', verdict.violations.length === 0);

  // And the clamp does now let the weight through, which is the point of raising the cap.
  assert.equal(
    clampAllocation(rawAsk, 'USDT', relaxed).applied.BTC,
    40,
    'the relaxed policy applies the full 40%',
  );

  // THE MIRROR that makes the assertion above non-vacuous: judged the OLD way — bounded
  // reference against bounded candidate — the same cycle is rejected.
  ok(
    'relaxed cap: judged against the old BOUNDED reference, the identical cycle IS rejected',
    rules(
      input({
        actionType: 'hold',
        intentReference: oldStyleReference,
        intentTarget: clampAllocation(rawAsk, 'USDT', relaxed).applied,
      }),
    ).includes('hold_moved_target'),
  );
  passed += 1;
}

{
  // THE TIGHTENED CASE — PR #28's closure, which must not regress. Same operands, cap
  // moved the other way: 35 → 30. Raw against raw, the model has not changed its mind and
  // the hold is accepted, exactly as #28 made it.
  const rawAsk = { BTC: 40, ETH: 18, BNB: 12, XRP: 0, USDT: 30 };
  const tightened = withCaps({ BTC: 30 });

  assert.equal(
    clampAllocation(rawAsk, 'USDT', tightened).applied.BTC,
    30,
    'the tightened policy bounds the same ask to 30',
  );
  ok(
    'tightened cap: the hold is still accepted (PR #28 stays closed)',
    checkCoherence(
      input({ actionType: 'hold', intentReference: { ...rawAsk }, intentTarget: { ...rawAsk } }),
    ).ok,
  );

  // THE CASH FLOOR DOES IT TOO. Raising the sacred reserve rescales every coin, so a
  // reference written under a 30% floor was unreachable under a 50% one — the same
  // interlock through a different door. Raw-against-raw does not notice either.
  const raisedFloor = withCaps({}, 50);
  assert.equal(
    clampAllocation({ ...REFERENCE }, 'USDT', raisedFloor).applied.USDT,
    50,
    'the floor was raised and the coins rescaled',
  );
  ok(
    'raised cash floor: the hold is still accepted',
    checkCoherence(input({ actionType: 'hold' })).ok,
  );
  passed += 1;
}

{
  // THE CHAIN KEEPS ADVANCING. One accepted cycle proves the rejection is gone; it does
  // not prove the reference moves. So the chain is walked: each accepted cycle's INTENTION
  // becomes the next cycle's reference, and all of them must pass — under a policy that
  // changed direction halfway through, which is the scenario neither the tightened nor the
  // relaxed case alone covers.
  const rawAsk = { BTC: 40, ETH: 18, BNB: 12, XRP: 0, USDT: 30 };
  let reference: Record<string, number> = { BTC: 35, ETH: 20, BNB: 12, XRP: 0, USDT: 33 };
  const accepted: boolean[] = [];
  const references: string[] = [];

  for (let cycle = 0; cycle < 4; cycle += 1) {
    const verdict = checkCoherence(
      input({
        // The first cycle genuinely changes its mind (35 → 40), so it is not labelled a
        // hold; from the second on, the model re-emits the same ask and holds.
        actionType: cycle === 0 ? 'rebalance' : 'hold',
        intentReference: reference,
        intentTarget: { ...rawAsk },
        movements: cycle === 0 ? [movement('BTC', 'buy')] : [],
        notes: cycle === 0 ? [note('BTC')] : [],
        assetsWithStoredThesis: new Set(['BTC']),
      }),
    );
    accepted.push(verdict.ok);
    references.push(JSON.stringify(reference));
    // What production does with an accepted cycle: its INTENTION becomes the next
    // reference — never its bounded allocation.
    if (verdict.ok) reference = { ...rawAsk };
  }

  ok('four consecutive cycles across a policy change are all accepted', accepted.every(Boolean));
  ok(
    'and the reference actually ADVANCED off the stale value rather than standing still',
    references[0] !== references[1] && references[1] === references[3],
  );
  passed += 1;
}

{
  // NEUTRAL ON THE CORPUS — the property the replay proof rests on, stated locally.
  //
  // `applied_allocation` is byte-identical to `target_allocation` on all 1332 decided
  // rows (0 clamps, 0 gate refusals as of 20/08), so swapping rule 1's reference from one
  // column to the other cannot move a single historical verdict. That is what makes this
  // change provable rather than argued.
  const alreadyBounded = clampAllocation({ ...REFERENCE }, 'USDT', config);
  assert.equal(alreadyBounded.clamped, false, 'the corpus reference is within the shipped caps');
  assert.deepEqual(
    alreadyBounded.applied,
    { ...REFERENCE },
    'while the clamp never fires, the applied allocation IS the raw intention',
  );
  ok(
    'an unchanged hold is still accepted, exactly as before',
    checkCoherence(input({ actionType: 'hold' })).ok,
  );
  passed += 1;
}

console.log(`\n${passed} coherence-guard checks passed.`);
