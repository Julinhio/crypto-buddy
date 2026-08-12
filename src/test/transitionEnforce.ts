import assert from 'node:assert/strict';
import { config, resolveTransitionMode } from '../config/index.js';
import { dec, ZERO } from '../money.js';
import { applyGate } from '../transition/apply.js';
import { judgeVector } from '../transition/vector.js';
import { evaluateTransition, type TransitionVerdict } from '../transition/gate.js';
import { checkCoherence } from '../decision/coherence.js';
import { formatAlert, formatArmedStopNotFired } from '../alerting/messages.js';
import { toActionableRegimeView, toDecisionContext } from '../decision/context.js';
import { buildSystemPromptV5 } from '../decision/promptV5.js';
import { classifyOutcome, priceMovePercent } from '../persistence/refusedIntentions.js';
import type { Movement } from '../execution/movements.js';
import type { StickyPoint } from '../market/transition.js';

/**
 * Offline proof of the ENFORCE switch (no network, no DB, no LLM).
 *
 * The brief's proofs 3, 4 and 5 live here, plus the consequence it asks to be frozen so
 * nobody mistakes it for a bug later: a model re-emitting the SAME target while the asset
 * is still frozen has not moved its intention, so the guard's rule 1 accepts it.
 */

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ok: ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A sticky point, spelled out so the fixtures read as the states they represent. */
function stickyPoint(over: Partial<StickyPoint> & { frozen: boolean }): StickyPoint {
  return {
    timestamp: 1_700_000_000_000,
    active: 'range',
    raw: over.frozen ? 'trend_up' : 'range',
    actionable: !over.frozen,
    runLength: 2,
    labelRun: 2,
    pendingBars: over.frozen ? 2 : 0,
    ...over,
  } as StickyPoint;
}

function verdictFor(asset: string, opts: { frozen: boolean; riskOff?: boolean }): TransitionVerdict {
  return evaluateTransition({
    asset,
    sticky: stickyPoint({ frozen: opts.frozen }),
    riskOffConfirmed: opts.riskOff ?? false,
    qty: dec('1'),
    price: dec('100'),
    priceStale: false,
    peakPriceSinceEntry: dec('100'),
    stopThresholdPercent: config.transition.peakStopPercent,
  });
}

function movement(asset: string, side: 'buy' | 'sell', notional: string): Movement {
  return {
    symbol: `${asset}/USDT`,
    asset,
    side,
    qty: dec('1'),
    price: dec('100'),
    notional: dec(notional),
    fee: ZERO,
    fullExit: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§1 — THE SWITCH');
{
  ok('unset resolves to observe — absence means safe', resolveTransitionMode(undefined) === 'observe');
  ok('blank resolves to observe', resolveTransitionMode('   ') === 'observe');
  ok('observe and enforce are accepted', resolveTransitionMode('observe') === 'observe' && resolveTransitionMode('enforce') === 'enforce');
  for (const bad of ['ENFORCE', 'Enforce', 'on', 'true', '1', 'blocking']) {
    let threw = false;
    try { resolveTransitionMode(bad); } catch { threw = true; }
    ok(`"${bad}" FAILS the boot rather than silently observing`, threw);
  }
  // Surrounding whitespace is TRIMMED and accepted — the same convention as
  // STRATEGY_VERSION and COHERENCE_GUARD, whose matching is exact *after* trimming.
  // Asserted rather than assumed, so a future tightening here is a deliberate divergence
  // from the two siblings rather than an accident.
  ok('surrounding whitespace is trimmed, exactly like the sibling switches',
    resolveTransitionMode('  enforce  ') === 'enforce');
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§2 — OBSERVE CHANGES NOTHING (proof 1, and proof 5 by construction)');
{
  const movements = [movement('BTC', 'buy', '100'), movement('ETH', 'sell', '80')];
  const judgement = judgeVector(
    movements.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional })),
    new Map([
      ['BTC', verdictFor('BTC', { frozen: true })],
      ['ETH', verdictFor('ETH', { frozen: false })],
    ]),
  );
  ok('the judgement itself DOES refuse — the fixture is not vacuous', judgement.refused);

  const clamped = { BTC: 10, ETH: 15, USDT: 75 };
  const previous = { BTC: 5, ETH: 20, USDT: 75 };
  const observed = applyGate({ mode: 'observe', movements, judgement, stopExits: [], clampedAllocation: clamped, previousApplied: previous });

  ok('observe keeps EVERY movement, refused judgement or not',
    observed.movements.length === 2 && observed.movements === movements);
  ok('observe applies the CLAMPED target, exactly as today',
    JSON.stringify(observed.appliedAllocation) === JSON.stringify(clamped));
  ok('observe reports no refusal, so nothing downstream branches', observed.refused === false);
  ok('observe drops no leg', observed.droppedLegs.length === 0);

  // Proof 5: flipping back is a pure function of the mode, on the same inputs.
  const enforced = applyGate({ mode: 'enforce', movements, judgement, stopExits: [], clampedAllocation: clamped, previousApplied: previous });
  const backToObserve = applyGate({ mode: 'observe', movements, judgement, stopExits: [], clampedAllocation: clamped, previousApplied: previous });
  ok('enforce and observe genuinely differ on the same inputs', enforced.refused !== backToObserve.refused);
  ok('returning to observe restores the exact previous outcome, byte for byte',
    JSON.stringify(backToObserve) === JSON.stringify(observed));
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§3 — ENFORCE: applied_allocation KEEPS THE PREVIOUS VECTOR (proof 3.1)');
{
  const movements = [movement('BTC', 'buy', '100'), movement('ETH', 'sell', '80')];
  const judgement = judgeVector(
    movements.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional })),
    new Map([
      ['BTC', verdictFor('BTC', { frozen: true })],
      ['ETH', verdictFor('ETH', { frozen: false })],
    ]),
  );
  const clamped = { BTC: 10, ETH: 15, USDT: 75 };
  const previous = { BTC: 5, ETH: 20, USDT: 75 };
  const out = applyGate({ mode: 'enforce', movements, judgement, stopExits: [], clampedAllocation: clamped, previousApplied: previous });

  ok('the cycle is refused', out.refused);
  ok('applied_allocation is the PREVIOUS vector, not the refused proposal',
    JSON.stringify(out.appliedAllocation) === JSON.stringify(previous));
  ok('and it is NOT the clamped proposal',
    JSON.stringify(out.appliedAllocation) !== JSON.stringify(clamped));

  // Proof 3.3 — no drift rebalancing. The strategic legs are DROPPED, never replaced by
  // movements toward the reverted target. If the gate emitted its own orders to re-hit
  // yesterday's percentages, it would block the model and then trade on its own account.
  ok('NO movement survives — the legs are dropped, not replaced', out.movements.length === 0);
  ok('both strategic legs are reported as dropped', out.droppedLegs.length === 2);

  // The fallback: a bot with no decided history has no previous vector to revert to.
  const cold = applyGate({ mode: 'enforce', movements, judgement, stopExits: [], clampedAllocation: clamped, previousApplied: null });
  ok('with no history at all, the clamped proposal stands in rather than storing null',
    JSON.stringify(cold.appliedAllocation) === JSON.stringify(clamped));
  ok('and the refusal is still reported, so the fallback cannot mask it', cold.refused);
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§4 — CONSECUTIVE REFUSALS DO NOT DRIFT THE REFERENCE (proof 3.2)');
{
  const clamped = [
    { BTC: 10, ETH: 15, USDT: 75 },
    { BTC: 12, ETH: 18, USDT: 70 },
    { BTC: 3, ETH: 9, USDT: 88 },
  ];
  const original: Record<string, number> = { BTC: 5, ETH: 20, USDT: 75 };
  let reference: Record<string, number> = original;

  // Five consecutive refused cycles, each proposing something different. The reference is
  // fed back exactly as production does it: this cycle's applied becomes the next one's
  // `previousApplied`, which is what `loadReferenceTarget` will read.
  for (let i = 0; i < 5; i += 1) {
    const movements = [movement('BTC', 'buy', '100')];
    const judgement = judgeVector(
      movements.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional })),
      new Map([['BTC', verdictFor('BTC', { frozen: true })]]),
    );
    const out = applyGate({
      mode: 'enforce',
      movements,
      judgement, stopExits: [],
      clampedAllocation: clamped[i % clamped.length]!,
      previousApplied: reference,
    });
    reference = out.appliedAllocation;
  }

  ok('after 5 consecutive refusals the reference is EXACTLY the original',
    JSON.stringify(reference) === JSON.stringify(original),
    JSON.stringify(reference));
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§5 — DETERMINISTIC EXITS SURVIVE A REFUSAL');
{
  // BTC frozen and refused; ETH under a CONFIRMED risk_off, selling. The reduction is the
  // one thing a transition must never block, and it must not be swept up by atomicity.
  const movements = [movement('BTC', 'buy', '100'), movement('ETH', 'sell', '80')];
  const judgement = judgeVector(
    movements.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional })),
    new Map([
      ['BTC', verdictFor('BTC', { frozen: true, riskOff: true })],
      ['ETH', verdictFor('ETH', { frozen: true, riskOff: true })],
    ]),
  );
  const out = applyGate({
    mode: 'enforce',
    movements,
    judgement, stopExits: [],
    clampedAllocation: { BTC: 10, ETH: 15, USDT: 75 },
    previousApplied: { BTC: 5, ETH: 20, USDT: 75 },
  });
  ok('the risk_off REDUCTION still executes despite the refusal',
    out.movements.length === 1 && out.movements[0]?.asset === 'ETH' && out.movements[0]?.side === 'sell');
  ok('the increase on the frozen asset is dropped',
    out.droppedLegs.length === 1 && out.droppedLegs[0]?.asset === 'BTC');
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§5b — THE PEAK STOP EXITS EVEN WHEN THE MODEL SAID NOTHING');
// The P1 the review found. `applyGate` can only filter the list it is handed, so a stop
// firing on a line the model did not mention used to produce NO exit at all — the ladder's
// first rung promising a full exit and delivering nothing, on the line that needed it most.
// The exits are now an INPUT, generated by the code from the held quantity.
{
  const stopExit: Movement = { ...movement('BNB', 'sell', '200'), fullExit: true };

  // (a) the model proposed NOTHING on BNB, and nothing at all this cycle.
  const noLegs = judgeVector([], new Map([['BNB', verdictFor('BNB', { frozen: true })]]));
  const alone = applyGate({
    mode: 'enforce', movements: [], judgement: noLegs, stopExits: [stopExit],
    clampedAllocation: { BNB: 10, USDT: 90 }, previousApplied: { BNB: 10, USDT: 90 },
  });
  ok('the stop exit fires with no model leg whatsoever',
    alone.movements.length === 1 && alone.movements[0]?.asset === 'BNB' && alone.movements[0]?.fullExit === true);

  // (b) the model proposed a BUY on the stopping asset. Before the fix `isDeterministic`
  //     called it deterministic (it is side-blind for `stop_exit`) and it would have
  //     EXECUTED while the line was supposed to be liquidating.
  const buy = movement('BNB', 'buy', '80');
  const withBuy = judgeVector(
    [{ asset: 'BNB', side: 'buy', notional: buy.notional }],
    new Map([['BNB', verdictFor('BNB', { frozen: true })]]),
  );
  const overtaken = applyGate({
    mode: 'enforce', movements: [buy], judgement: withBuy, stopExits: [stopExit],
    clampedAllocation: { BNB: 10, USDT: 90 }, previousApplied: { BNB: 10, USDT: 90 },
  });
  ok('a model BUY on a stopping asset does NOT execute',
    !overtaken.movements.some((m) => m.side === 'buy'));
  ok('the stop exit executes in its place',
    overtaken.movements.length === 1 && overtaken.movements[0]?.side === 'sell');
  ok('and the overtaken leg is reported as SUPERSEDED, not as a refused intention',
    overtaken.supersededLegs.length === 1 && overtaken.droppedLegs.length === 0);

  // (c) OBSERVE must not gain the exit — the stop has never placed an order there.
  const observed = applyGate({
    mode: 'observe', movements: [buy], judgement: withBuy, stopExits: [stopExit],
    clampedAllocation: { BNB: 10, USDT: 90 }, previousApplied: { BNB: 10, USDT: 90 },
  });
  ok('OBSERVE generates no exit and keeps the model leg — the switch still changes nothing',
    observed.movements.length === 1 && observed.movements[0]?.side === 'buy');
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§5c — AN ASSET WITH NO REGIME FAILS CLOSED IN ENFORCE');
// A leg on an asset with no usable 4h bar gets `no_regime` / `unjudged`. `judgeVector`
// refuses to let that trigger an atomic refusal — right for the journal, but carried into
// enforcement it would execute a strategic leg precisely when the layer has no regime to
// validate it against, while the payload already told the model `actionable: false`.
{
  const noRegime = evaluateTransition({
    asset: 'XRP', sticky: null, riskOffConfirmed: false,
    qty: dec('1'), price: dec('100'), priceStale: false,
    peakPriceSinceEntry: dec('100'), stopThresholdPercent: config.transition.peakStopPercent,
  });
  ok('the gate really does say no_regime on a missing bar', noRegime.gate === 'no_regime');

  const legs = [movement('XRP', 'buy', '90')];
  const judgement = judgeVector(
    legs.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional })),
    new Map([['XRP', noRegime]]),
  );
  ok('judgeVector does NOT refuse it — the journal must not invent a refusal',
    judgement.refused === false);
  ok('and the leg is unjudged, not forbidden', judgement.legs[0]?.ownVerdict === 'unjudged');

  const enforced = applyGate({
    mode: 'enforce', movements: legs, judgement, stopExits: [],
    clampedAllocation: { XRP: 10, USDT: 90 }, previousApplied: { XRP: 5, USDT: 95 },
  });
  ok('but ENFORCE fails CLOSED: the leg does not execute',
    enforced.refused && enforced.movements.length === 0);
  ok('and the reason names the missing regime rather than a generic refusal',
    enforced.reason.includes('NO regime') && enforced.reason.includes('XRP'));

  const observed = applyGate({
    mode: 'observe', movements: legs, judgement, stopExits: [],
    clampedAllocation: { XRP: 10, USDT: 90 }, previousApplied: { XRP: 5, USDT: 95 },
  });
  ok('OBSERVE is untouched — the leg still passes, exactly as today',
    observed.refused === false && observed.movements.length === 1);

  // Rung 2 still lifts the silence: a confirmed risk_off reduces a regime-less line.
  const riskOff = evaluateTransition({
    asset: 'XRP', sticky: null, riskOffConfirmed: true,
    qty: dec('1'), price: dec('100'), priceStale: false,
    peakPriceSinceEntry: dec('100'), stopThresholdPercent: config.transition.peakStopPercent,
  });
  const sell = [movement('XRP', 'sell', '90')];
  const reduction = applyGate({
    mode: 'enforce', movements: sell, stopExits: [],
    judgement: judgeVector(
      sell.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional })),
      new Map([['XRP', riskOff]]),
    ),
    clampedAllocation: { XRP: 5, USDT: 95 }, previousApplied: { XRP: 10, USDT: 90 },
  });
  ok('a risk_off REDUCTION on a regime-less line still executes — rung 2 lifts the silence',
    reduction.movements.length === 1 && reduction.movements[0]?.side === 'sell');
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§6 — THE PAYLOAD (proof 4): asserted on the KEYS, not claimed');
{
  const regime = {
    version: 'r1',
    barAt: '2026-08-11T12:00:00Z',
    global: { riskOff: false, raw: true, breadthPercent: 40, medianH4Rsi: 52, assetsPresent: 5, assetsExpected: 5, pendingBars: 2 },
    assets: {
      BTC: {
        effective: 'range', regime: 'range', raw: 'trend_up', pendingRegime: 'trend_up',
        pendingBars: 2, bearish: false,
        signals: { close: 100, rsi14H4: 60, ema21H4: 98, h4RangePosition: 0.8, pullbackConsumed: false, bounceConsumed: true },
      },
      ETH: {
        effective: 'trend_up', regime: 'trend_up', raw: 'trend_up', pendingRegime: null,
        pendingBars: 0, bearish: false,
        signals: { close: 50, rsi14H4: 58, ema21H4: 49, h4RangePosition: 0.6, pullbackConsumed: false, bounceConsumed: false },
      },
    },
  } as never;

  const view = toActionableRegimeView(regime, new Map([['BTC', false], ['ETH', true]]));
  const json = JSON.stringify(view);

  ok('`raw` is NOT reachable anywhere in the payload', !json.includes('"raw"'));
  ok('`pendingRegime` is NOT reachable anywhere in the payload', !json.includes('pendingRegime'));
  ok('`pendingBars` (the candidate streak) is gone too', !json.includes('pendingBars'));
  ok('the global posture keeps only the CONFIRMED override',
    view.global.riskOff === false && !Object.keys(view.global).includes('raw'));

  ok('`actionable` is explicit per asset',
    view.assets.BTC?.actionable === false && view.assets.ETH?.actionable === true);
  ok('the CONFIRMED regime is still shown on a frozen asset', view.assets.BTC?.regime === 'range');

  const btcSignals = Object.keys(view.assets.BTC?.signals ?? {});
  const ethSignals = Object.keys(view.assets.ETH?.signals ?? {});
  ok('tactical FLAGS are withheld on a non-actionable asset',
    !btcSignals.includes('pullbackConsumed') && !btcSignals.includes('bounceConsumed'));
  ok('but the raw 4h MEASUREMENTS are kept — the model must see what it cannot act on',
    btcSignals.includes('rsi14H4') && btcSignals.includes('h4RangePosition'));
  ok('an actionable asset keeps its tactical flags',
    ethSignals.includes('pullbackConsumed') && ethSignals.includes('bounceConsumed'));

  // An asset the layer produced no verdict for defaults to NOT actionable.
  const unknown = toActionableRegimeView(regime, new Map());
  ok('an asset with no verdict defaults to actionable=false, never true',
    unknown.assets.BTC?.actionable === false && unknown.assets.ETH?.actionable === false);
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§7 — THE PAYLOAD IS GATED: observe is byte-identical to today (proof 5)');
{
  const market = {
    generatedAt: 'T', source: { marketData: 'binance-public-mainnet', account: 'binance-testnet' },
    market: { tradable: [], reference: [] },
    regime: {
      version: 'r1', barAt: 'B',
      global: { riskOff: false, raw: true, breadthPercent: 0, medianH4Rsi: null, assetsPresent: 0, assetsExpected: 5, pendingBars: 0 },
      assets: { BTC: { effective: 'range', regime: 'range', raw: 'trend_up', pendingRegime: 'trend_up', pendingBars: 2, bearish: false, signals: { close: 1, pullbackConsumed: true } } },
    },
    transition: null, account: { balances: [] },
    dataHealth: { blind: false, attempted: 5, lost: 0, failures: [], httpTraces: [], tracesDropped: 0 },
  } as never;
  const portfolio = {
    reserveAsset: 'USDT', startingCapital: dec('500'), cash: dec('500'), equity: dec('500'),
    deployedPercent: ZERO, realizedPnl: ZERO, unrealizedPnl: ZERO, totalPnl: ZERO, positions: [],
  } as never;

  const observed = toDecisionContext(market, portfolio, 'v5', new Map(), { mode: 'observe', actionableByAsset: new Map() });
  const enforced = toDecisionContext(market, portfolio, 'v5', new Map(), { mode: 'enforce', actionableByAsset: new Map([['BTC', false]]) });

  ok('in OBSERVE the model still sees `raw` — today\'s payload, untouched',
    JSON.stringify(observed.regime).includes('"raw"'));
  ok('in ENFORCE it does not', !JSON.stringify(enforced.regime).includes('"raw"'));
  // The default argument is what keeps every existing caller — printers, tests, replay —
  // producing exactly the payload they produced before this PR.
  const byDefault = toDecisionContext(market, portfolio, 'v5', new Map());
  ok('and the DEFAULT (no gate argument) is observe, so no existing caller shifted',
    JSON.stringify(byDefault) === JSON.stringify(observed));

  const sysObserve = buildSystemPromptV5(config, 'observe');
  const sysEnforce = buildSystemPromptV5(config, 'enforce');
  ok('the system prompt is byte-identical in observe (the cache is preserved)',
    sysObserve === buildSystemPromptV5(config));
  ok('and gains the actionability mandate only in enforce',
    !sysObserve.includes('actionable: false') && sysEnforce.includes('actionable: false'));
  ok('the enforce mandate states the atomic cost of a blocked line',
    sysEnforce.includes('EVERY strategic leg'));
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§8 — THE GUARD ACCEPTS A RE-EMITTED TARGET WHILE STILL FROZEN');
// The consequence the brief asks to be frozen in a test so nobody reads it as a bug later.
// On a refused cycle `applied_allocation` keeps the PREVIOUS vector. If the model then
// re-emits the SAME target next cycle while the asset is still frozen, its intention has
// not moved — so rule 1 ("a hold must not move the target") must ACCEPT.
{
  const reference = { BTC: 5, ETH: 20, USDT: 75 };
  const verdict = checkCoherence({
    strategy: 'v5',
    actionType: 'hold',
    effectiveTarget: { ...reference },
    referenceTarget: reference,
    riskPolicy: config,
    movements: [],
    reserveAsset: 'USDT',
    notes: [],
    assetsWithStoredThesis: new Set<string>(),
  });
  ok('re-emitting the unchanged target on a hold is ACCEPTED by rule 1 — not a bug',
    verdict.ok, JSON.stringify(verdict.violations));

  // And the mirror, so the test is not vacuous: a hold that DOES move the target is still
  // rejected, exactly as before this PR.
  const moved = checkCoherence({
    strategy: 'v5',
    actionType: 'hold',
    effectiveTarget: { BTC: 12, ETH: 20, USDT: 68 },
    referenceTarget: reference,
    riskPolicy: config,
    movements: [],
    reserveAsset: 'USDT',
    notes: [],
    assetsWithStoredThesis: new Set<string>(),
  });
  ok('a hold that genuinely moves the target is still rejected', !moved.ok);
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§9 — THE REFUSED-INTENTION CLASSIFICATION (item 5)');
{
  ok('same side re-proposed → repeated (the gate only DELAYED the trade)',
    classifyOutcome('sell', { asset: 'ETH', side: 'sell', targetPercent: 5, price: '100' }) === 'repeated');
  ok('opposite side → inverted (the gate removed half a round trip — the 11/08 case)',
    classifyOutcome('sell', { asset: 'ETH', side: 'buy', targetPercent: 20, price: '100' }) === 'inverted');
  ok('nothing proposed → abandoned (the intention was noise)',
    classifyOutcome('sell', { asset: 'ETH', side: null, targetPercent: 15, price: '100' }) === 'abandoned');
  ok('never resolved → unresolved, never silently counted as a win for either side',
    classifyOutcome('sell', null) === 'unresolved');

  ok('price move is signed and relative', Math.abs((priceMovePercent('100', '110') ?? 0) - 10) < 1e-9);
  ok('a missing price yields null rather than a fabricated 0',
    priceMovePercent(null, '110') === null && priceMovePercent('100', null) === null);
  ok('a non-positive base price yields null rather than dividing by zero',
    priceMovePercent('0', '110') === null);
}

// ─────────────────────────────────────────────────────────────────────────────────────
console.log('\n§10 — THE ARMED-STOP-NOT-FIRED ALERT');
// The gap the review found and this PR makes VISIBLE rather than closes: the stop's exit
// is synthesized after the model call, the parse and the guard, so a cycle failing at any
// of those returns without generating it. Closing it means executing on paths that place
// nothing today and have no `decided` row to anchor a booking to — its own PR.
{
  const msg = formatArmedStopNotFired({ assets: ['BNB', 'ETH'], status: 'guard_failed', timestamp: 'T' });
  ok('the message names the assets whose stop was armed', msg.includes('BNB, ETH'));
  ok('and the status that prevented it', msg.includes('guard_failed'));
  // The wording must not read as "an order failed": nothing was placed and nothing lost.
  ok('it states plainly that NO order was placed', msg.includes("AUCUN ordre n'a été passé"));
  ok('and that the stop fires on the next successful cycle', msg.includes('prochain cycle réussi'));
  ok('it is a distinct message, not a mutation of the degraded alert',
    !msg.includes('DÉGRADÉ') && msg.includes('STOP DE PIC NON DÉCLENCHÉ'));

  // The three existing alert wordings must be untouched by this addition.
  ok('the market-data alert wording is untouched',
    formatAlert({ trigger: 'market_data', value: 3, timestamp: 'T' }).includes('DONNÉES DE MARCHÉ INDISPONIBLES'));
  ok('the degraded alert wording is untouched',
    formatAlert({ trigger: 'degraded', value: 3, timestamp: 'T' }).includes('DÉGRADÉ'));
  ok('the overheating alert wording is untouched',
    formatAlert({ trigger: 'overheating', value: 10, timestamp: 'T' }).includes('EMBALLEMENT'));
}

console.log(`\n${passed} passed, ${failed} failed — transition gate enforce (offline).`);
assert.equal(failed, 0, `${failed} check(s) failed`);
