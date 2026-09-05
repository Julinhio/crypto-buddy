import {
  config,
  tradableBaseAssets,
  STRATEGY_VERSION,
  COHERENCE_GUARD,
  TRANSITION_MODE,
  EXPOSURE_BAND_MODE,
} from '../config/index.js';
import { Decimal, ZERO, dec, toNumericString } from '../money.js';
import { evaluateTransition, judgeOrder, type TransitionVerdict } from '../transition/gate.js';
import { judgeVector } from '../transition/vector.js';
import { applyGate } from '../transition/apply.js';
import {
  bumpFrozenEpisodes,
  openRefusedEpisodes,
  resolveRefusedEpisodes,
} from '../persistence/refusedIntentions.js';
import {
  saveTransitionObservations,
  toObservationRow,
} from '../persistence/transitionObservations.js';
import { observeBand } from '../exposure/observe.js';
import { saveBandObservation } from '../persistence/exposureBandObservations.js';
import { buildMarketContext, marketHealthOf, type MarketContext } from '../context/build.js';
import { recordMarketDataOutage } from '../market/outage.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import {
  insertDecision,
  loadLastSignificantDecision,
  loadRecentDecisions,
  type DecisionRow,
} from '../persistence/decisions.js';
import { loadLedger, type LedgerEntry } from '../persistence/executions.js';
import { loadStartingCapital } from '../persistence/startingCapital.js';
import { derivePortfolio, type VirtualPortfolio } from '../portfolio/derive.js';
import {
  buildPriceLookup,
  toDecisionContext,
  type DecisionContext,
} from './context.js';
import { clampAllocation, type ClampResult } from '../risk/clamp.js';
import { computeMovements, movementFloor, type Movement } from '../execution/movements.js';
import { mayWriteThesis, nextPositionStates } from '../portfolio/lifecycle.js';
import type { PositionNote } from './schema.js';
import { loadPositionStates, savePositionStates } from '../persistence/positionState.js';
import {
  executeMovements,
  emptyExecutionSummary,
  type ExecutionSummary,
} from '../execution/execute.js';
import { publicMainnetClient, testnetAccountClient } from '../exchanges/binance.js';
import {
  allocatableUniverse,
  outputOrderViolation,
  reserveStables,
  validateDecision,
  type ValidatedDecision,
} from './schema.js';
import { buildRetryPrompt, checkCoherence, type CoherenceViolation } from './coherence.js';
import { buildIntentAllocation, restateIntentReference } from './intentReference.js';
import {
  loadReferenceAllocations,
  recordGuardEvent,
  type GuardEventInsert,
} from '../persistence/decisionGuard.js';
import { formatArmedStopNotFired } from '../alerting/messages.js';
import { sendTelegram } from '../alerting/telegram.js';
import { buildSystemPrompt, buildUserPrompt, marketStateFromRegime, PROMPT_VERSION } from './prompt.js';
import { buildSystemPromptV5, buildUserPromptV5, PROMPT_V5_VERSION } from './promptV5.js';
import { assertAnthropicConfigured, resolveModel, runDecision, type LlmResult } from './llm.js';
import {
  classifyLlmFailure,
  serializeLlmFailure,
  type LlmFailureClassification,
} from './llmFailure.js';
import { getGitSha } from './gitSha.js';

/**
 * Whether this cycle could SEE THE MARKET — the second health state, as a value the
 * scheduler can act on.
 *
 * `unknown` is not modelled here on purpose: reaching a `DecideResult` at all means
 * `buildMarketContext` returned, so the answer is always known. The unknown case belongs
 * one level up, where a cycle can time out or throw before ever reading the market —
 * see CycleOutcome.marketData.
 */
export type SeenMarket = 'blind' | 'sighted';

export interface DecideResult {
  status: DecisionRow['status'];
  persisted: boolean;
  decisionId: number | null;
  row: DecisionRow;
  /**
   * Did this cycle see the market? Drives `bot_state.consecutive_blind_cycles` and the
   * "données de marché indisponibles" alert. Reported on EVERY path — including the ones
   * that fail for reasons of their own — because the market read either worked or it
   * didn't, independently of what happened after it.
   */
  marketData: SeenMarket;
  /** The virtual book the AI saw (null only when the cycle was skipped). */
  portfolio: VirtualPortfolio | null;
  /**
   * The book AFTER this cycle's bookings (the "résultante"): the pre-trade ledger
   * replayed with the booked intents, valued at the SAME prices. Equals `portfolio`
   * when nothing booked. Null on a non-decided cycle. Powers the activity
   * notification's resulting allocation + total — re-derived in-memory, no re-read.
   */
  portfolioAfter: VirtualPortfolio | null;
  /** The risk-wrapper result (only on a decided cycle). */
  clamp: ClampResult | null;
  /** Movements computed to reach the bounded allocation. */
  movements: Movement[];
  /** The real testnet execution outcome (null on a non-decided / unpersisted cycle). */
  execution: ExecutionSummary | null;
  /**
   * THE TYPED CAUSE OF AN LLM CALL FAILURE, when that is what ended the cycle.
   *
   * Non-null ONLY on the two paths where a call to Anthropic threw (the first call, and
   * the coherence guard's single relaunch). Null everywhere else — including on a
   * `parse_failed` or a `guard_failed`, which are model-output problems, not transport
   * ones, and must keep the generic backoff.
   *
   * This is the value the scheduler reads to pick its delay. It travels as a STRUCTURE,
   * never as text: nothing downstream may re-derive a class from `raw_response`, from
   * `detail`, or from a message. One classification, one source, two consumers (the
   * journal and the backoff).
   */
  llmFailure: LlmFailureClassification | null;
}

/**
 * One wake-up of the economic brain (PR B — real testnet execution):
 *   1. read the market, derive the VIRTUAL portfolio from the execution journal
 *   2. show that portfolio (not the testnet basket) to the AI, get a target
 *   3. bound it to the risk caps (surplus → cash), journal the decision
 *   4. compute the movements to reach it, then for each: validate against the
 *      REAL (mainnet) filters, book the sovereign intent, place a real testnet
 *      LIMIT IOC order, and journal its result as a trace.
 * The portfolio still evolves from OUR booking at real prices — the testnet fill
 * (partial / zero / rejected) is traced but never touches the sovereign ledger.
 */
export async function decide(): Promise<DecideResult> {
  assertAnthropicConfigured();

  // The cycle's own clock. The coherence guard may spend a SECOND LLM call inside this
  // wake-up, and the decision to start it is a time-budget decision — so the budget has
  // to be measured from the moment the cycle really began, not from the first LLM call.
  const cycleStart = Date.now();
  const elapsedSeconds = (): number => (Date.now() - cycleStart) / 1000;

  const supabase = getSupabaseClient();
  const gitSha = getGitSha();

  /**
   * Guard events accumulated during this cycle, flushed once the decision row exists so
   * every one of them can carry its `decision_id`. Deliberately not written as they
   * happen: an event whose decision is unknown is half a trace, and the whole point of
   * this table is that the 30/07 verdict was unattributable.
   */
  const guardEvents: Array<Omit<GuardEventInsert, 'decision_id' | 'run_token'>> = [];
  /**
   * DRAINS the queue, so it is safe — and expected — to call more than once per cycle.
   *
   * `persistLifecycle` runs AFTER the decision row exists and can itself queue a
   * `thesis_write_refused`: a movement the guard accepted may still fail to book (the
   * mainnet filters, or a failed durable booking), and the lifecycle then refuses the
   * note the guard had allowed. With a single flush placed before it, exactly those
   * late events would be dropped — and every refusal would be dropped when the guard is
   * switched off, which is precisely when this detector is the only one left.
   *
   * Draining rather than tracking an index keeps that correct without anyone having to
   * remember the ordering: whatever is in the queue at each call is written, once.
   */
  const flushGuardEvents = async (decisionId: number | null): Promise<void> => {
    const batch = guardEvents.splice(0);
    for (const event of batch) {
      await recordGuardEvent(supabase, { ...event, decision_id: decisionId, run_token: null });
    }
  };

  /**
   * The market read. Its failure is NOT contained — a context that could not be built
   * fails the cycle, exactly as before — but the market health it managed to collect is
   * salvaged on the way out.
   *
   * The case that motivates it: the account balance read rejecting during a broad outage
   * that is also hitting the public endpoints. The context build then threw before any
   * health existed, so the incident was never journaled and the scheduler recorded the
   * market state as `unknown` — losing both the evidence and the blind streak in the one
   * scenario where they matter most. `marketHealthOf` reads what `buildMarketContext`
   * stapled onto the error; the error itself is rethrown untouched.
   */
  let context: MarketContext;
  try {
    context = await buildMarketContext();
  } catch (err) {
    const salvaged = marketHealthOf(err);
    if (salvaged && salvaged.failures.length > 0) {
      console.error(
        '[market-data] the context build failed, but the market read had already collected ' +
          `${salvaged.failures.length} failure(s) — journaling them before the cycle dies.`,
      );
      await recordMarketDataOutage({
        supabase,
        decisionId: null,
        runToken: null,
        blind: salvaged.blind,
        marketsAttempted: salvaged.attempted,
        marketsFailed: salvaged.lost,
        failures: salvaged.failures,
        httpTraces: salvaged.httpTraces,
        tracesDropped: salvaged.tracesDropped,
      });
    }
    // The cycle still fails, with the original error and the original stack.
    throw err;
  }

  /**
   * THE OUTAGE TRACE — one probe, one row, and only when something actually failed.
   *
   * At most ONCE per cycle, enforced by the flag rather than by remembering: it is called
   * from every terminal path, exactly like `observeTransition` and for the same reason —
   * a cycle either had a failed market read or it didn't, whatever it went on to do.
   *
   * ── WHY IT IS NOT CALLED RIGHT AFTER THE READ ──────────────────────────────────────
   *
   * It was, and that was wrong. The probe and the write are bounded at 10s together, and
   * on a PARTIAL failure the cycle carries on to the model — so those 10s landed BEFORE
   * the coherence guard's time-budget gate and were counted in its `remaining`. A cycle
   * sitting within 10s of that boundary would have been retried before this PR and would
   * now die as `guard_failed_no_retry_budget` instead. The startup budget check does not
   * catch it: it bounds the worst case, not the boundary. That is observability changing
   * the bot's decision — the one thing this component must be incapable of.
   *
   * Running from the terminal paths removes the interference entirely: on any path that
   * reaches the model, the trace is written after the decision work is done. On the BLIND
   * path — the 09/08 case, and the one where the probe's timing actually matters — the
   * cycle ends immediately anyway, so the probe still fires about a second after the
   * failure, from the same instance and the same exit IP.
   *
   * `recordMarketDataOutage` returns `void`, which is what makes it structurally incapable
   * of feeding a decision — see the header of market/outage.ts.
   */
  const health = context.dataHealth;
  const marketData: SeenMarket = health.blind ? 'blind' : 'sighted';
  let outageObserved = false;
  const observeMarketDataOutage = async (decisionId: number | null): Promise<void> => {
    if (outageObserved || health.failures.length === 0) return;
    outageObserved = true;
    await recordMarketDataOutage({
      supabase,
      // Now available on most paths, since the decision row is written before we get
      // here. Still nullable: an outage bad enough to break that insert is precisely the
      // case the table has no foreign key for.
      decisionId,
      runToken: null,
      blind: health.blind,
      marketsAttempted: health.attempted,
      marketsFailed: health.lost,
      failures: health.failures,
      httpTraces: health.httpTraces,
      tracesDropped: health.tracesDropped,
    });
  };

  // Derive the virtual portfolio + decision context UP FRONT so EVERY row stores
  // the same market_context shape (the virtual book, not the raw testnet
  // balances) — including a skipped one. With no tradable pairs there are no live
  // prices, so any held position falls back to avgCost (priceStale) — no crash.
  const reserveStable = reserveStables(config)[0] ?? 'USDT';
  const priceOf = buildPriceLookup(context, reserveStable);
  const ledgerRead = await loadLedger(supabase);
  const ledger = ledgerRead.entries;
  // The sovereign starting capital now lives in the DB (bot_state) so the upcoming
  // reset utility can redefine it from the dashboard. Fall back to the env bootstrap
  // when the DB has no value yet (pre-migration / vierge base / unreachable): the
  // derived portfolio is identical because the seed equals the env value.
  const startingCapital =
    (await loadStartingCapital(supabase)) ?? dec(config.execution.startingCapitalUsd);
  const portfolio = derivePortfolio(ledger, {
    startingCapital,
    reserveAsset: reserveStable,
    priceOf,
  });
  // Read the stored lifecycle state UP FRONT — it is an input to this cycle, not an
  // output of it. Loading it here also means the early-return paths below can still
  // ratchet the peak: the price moved whether or not the cycle reached a decision.
  //
  // The reference target rides along: it is the guard's comparison basis and, like the
  // lifecycle, it is an INPUT to this cycle. It must be read from the database on every
  // wake-up — the bot runs one process per cycle under Cron Schedule, so there is no
  // in-memory "last target" to carry, and a module-level cache would read null forever
  // while looking like it worked.
  const [stateRead, referenceRead] = await Promise.all([
    loadPositionStates(supabase),
    loadReferenceAllocations(supabase, reserveStable),
  ]);

  /**
   * Writes the lifecycle state for this cycle. Called on EVERY path that got as far as
   * a valued book — including a skipped, errored or unparseable cycle. The peak is a
   * property of the MARKET, not of whether the model answered: letting a failed wake-up
   * skip the ratchet would quietly lose highs, and the trailing logic built on top of
   * it would then be reading a peak that never happened.
   *
   * Reaching it at all implies both inputs loaded: a cycle whose journal or stored
   * state could not be read is skipped outright above, before the model is called and
   * before anything can book. Both fall back to "empty" on a transient failure, and
   * empty is indistinguishable from "holds nothing" — writing from either would mark
   * every position flat, or brand new, and wipe the entry dates, peaks and theses the
   * table exists to keep.
   */
  const persistLifecycle = async (
    book: VirtualPortfolio,
    bookedLedger: LedgerEntry[],
    notes: PositionNote[] = [],
  ): Promise<void> => {
    const states = nextPositionStates({
      assets: tradableBaseAssets(config),
      previous: stateRead.states,
      portfolio: book,
      priceOf,
      bookedLedger,
      notes,
      now: context.generatedAt,
    });

    // Surface the theses the code REFUSED. They are dropped on purpose — only a line
    // that moved, or one with no thesis yet, may have one written — but a silent drop
    // would hide how often the model tries to restate a thesis it was not asked for.
    // That frequency is the evidence for ever loosening the rule, so it is logged
    // rather than swallowed.
    //
    // Derived from the RULE, not from the written timestamp. A full exit clears the
    // thesis and its stamp by design, so a timestamp comparison would report a note on
    // a line that just sold out as "refused on an unmoved line" — inflating the very
    // metric this exists to measure. Reusing `mayWriteThesis` means the log and the
    // rule cannot drift apart.
    const bookedAssets = new Set(
      bookedLedger.map((e) => e.symbol.split('/')[0]).filter((a): a is string => a != null),
    );
    const refused = notes
      .filter(
        (n) =>
          !mayWriteThesis({
            booked: bookedAssets.has(n.asset),
            hasStoredThesis: (stateRead.states.get(n.asset)?.thesis ?? '').trim() !== '',
          }),
      )
      .map((n) => n.asset);
    if (refused.length > 0) {
      const detail =
        `ignored ${refused.length} proposed thesis/theses on unmoved lines (${refused.join(', ')}) — ` +
        'a thesis is only recorded when the line moves, or when it has none yet.';
      console.log(`[thesis] ${detail}`);
      // THE SECOND DEFECT THIS PR FIXES, and it counts as much as the first. This refusal
      // fired correctly on cycles 987 and 1000 and produced nothing but the console.log
      // above — no counter, no consultable state, no alert. The detector of the lost trade
      // worked on 30/07 and its result evaporated with the process logs.
      //
      // With the guard armed this path should now be nearly unreachable (rule 3 rejects
      // the response before it ever gets here), which is exactly why the trace matters:
      // a line appearing here means the guard let something through, and that is
      // something we want to find out from the database rather than from a hunch.
      guardEvents.push({
        event_type: 'thesis_write_refused',
        attempt: 1,
        rules: [],
        assets: refused,
        detail,
      });
    }

    const written = await savePositionStates(supabase, states, context.generatedAt);
    // Not swallowed. savePositionStates already retried and dumped the payload; the
    // cycle carries on because the trade has happened and failing here would not undo
    // it — but a lost lifecycle write is a real, non-self-healing loss, not staleness.
    if (!written && supabase) {
      console.error('[CRITICAL] this cycle produced no position-state write — see the payload above.');
    }
  };
  /**
   * THE TRANSITION LAYER, IN OBSERVE MODE.
   *
   * Computes what the gate WOULD have done with this cycle — actionability, peak stop,
   * priority ladder — and journals it. It blocks nothing and creates nothing: the return
   * value is `void`, no caller reads it, and the model's allocation is applied exactly as
   * it was before this brick existed.
   *
   * That inertness is structural, not a promise. This closure runs AFTER the movements
   * have been computed, judged by the guard, booked and executed; it receives the ledger
   * they produced as an INPUT. There is no path by which its verdict could reach
   * `clampAllocation`, `computeMovements` or `executeMovements`, and its writer is
   * best-effort by contract, so it cannot fail a cycle either.
   *
   * Called on every path that reached a valued book, mirroring `persistLifecycle` and for
   * the same reason: the gate's state is a reading of the MARKET, and a wake-up that
   * skipped, errored or failed the guard still passed through a transition or did not.
   * Dropping those cycles would leave holes in exactly the series the blocking decision
   * will be read from.
   *
   * The book it judges is the PRE-TRADE one (`portfolio`), never the résultante: the gate
   * is a counterfactual about the decision that was taken, and that decision was taken
   * against the book as it stood at the start of the cycle.
   */
  /**
   * THE LAYER'S VERDICTS FOR THIS CYCLE — computed ONCE, here, before anything reads them.
   *
   * They used to be computed inside the observation closure, which ran after execution.
   * That was correct while the layer only watched. Now that it can BLOCK, three different
   * consumers need them and they must be the same object for all three, or the journal
   * would document a decision other than the one that was applied:
   *
   *   1. the payload — `actionable` per asset, under `enforce` (see toDecisionContext);
   *   2. the gate — `applyGate`, before the movements execute;
   *   3. the journal — `observeTransition`, after.
   *
   * Every input is already in hand at this point: the market read, the pre-trade book, and
   * the stored lifecycle. Nothing here depends on the model's answer, which is exactly why
   * it can be hoisted above the LLM call without changing a single verdict.
   */
  const staleByAsset = new Map(portfolio.positions.map((p) => [p.asset, p.priceStale]));
  const heldByAsset = new Map(portfolio.positions.map((p) => [p.asset, p.qty]));
  const transitionVerdicts: TransitionVerdict[] = tradableBaseAssets(config).map((asset) =>
    evaluateTransition({
      asset,
      sticky: context.transition?.perAsset[asset] ?? null,
      // The CONFIRMED posture, never the raw one: an unconfirmed risk_off must not be
      // able to lift an individual freeze.
      riskOffConfirmed: context.regime?.global.riskOff ?? false,
      qty: heldByAsset.get(asset) ?? ZERO,
      price: priceOf(asset),
      priceStale: staleByAsset.get(asset) ?? false,
      // LAST cycle's stored peak. `evaluateStop` ratchets it with this cycle's price
      // itself, exactly as `toDecisionContext` does for the model.
      peakPriceSinceEntry: stateRead.states.get(asset)?.peakPriceSinceEntry ?? null,
      stopThresholdPercent: config.transition.peakStopPercent,
    }),
  );
  const verdictsByAsset = new Map(transitionVerdicts.map((v) => [v.asset, v]));
  const actionableByAsset = new Map(transitionVerdicts.map((v) => [v.asset, v.actionable]));

  /**
   * THE PEAK STOP'S EXITS, built from the held quantity and the live price.
   *
   * A function rather than a value, computed from inputs that are all already in hand, so
   * the two consumers cannot disagree: the EXECUTION path below generates these, and the
   * FAILURE paths alert on exactly the same set. A separate predicate for the alert would
   * eventually drift from the one that fires, and an alert about a stop that would not have
   * fired is worse than no alert.
   *
   * `fullExit: true` exempts it from the plumbing floor, as the mandate requires. A stale
   * price or a flat line produces NO exit: `evaluateStop` already refuses to fire without a
   * live price, and this refuses to invent a quantity.
   */
  const computeStopExits = (): Movement[] =>
    transitionVerdicts.flatMap((verdict) => {
      if (verdict.gate !== 'stop_exit') return [];
      const qty = heldByAsset.get(verdict.asset) ?? ZERO;
      const price = priceOf(verdict.asset);
      if (!qty.gt(0) || price == null || price.lte(0)) return [];
      return [{
        symbol: `${verdict.asset}/${reserveStable}`,
        asset: verdict.asset,
        side: 'sell' as const,
        qty,
        price,
        notional: qty.times(price),
        fee: qty.times(price).times(config.execution.feePercent).div(100),
        fullExit: true,
      }];
    });

  /**
   * Announces a stop that was ARMED on a cycle that died before it could generate its exit.
   *
   * ALERTS ONLY — it places nothing, and it is deliberately not a repair. Closing the gap
   * means executing on paths that today execute nothing and that have no `decided` row to
   * anchor a sovereign booking to; that is a change of failure semantics, not a gate, and it
   * belongs to its own PR. This makes the gap visible, which is the property it lacked.
   *
   * ENFORCE ONLY, and that is load-bearing rather than a detail: in `observe` the stop has
   * never generated an order at all, so there is no gap to report and a message here would
   * make "flipping the switch changes nothing" false. Best-effort, like every send in this
   * file — `sendTelegram` never throws and never blocks the cycle.
   */
  const alertArmedStopNotFired = async (status: string): Promise<void> => {
    if (TRANSITION_MODE !== 'enforce') return;
    const pending = computeStopExits();
    if (pending.length === 0) return;
    const assets = pending.map((m) => m.asset);
    console.error(
      `[transition] peak stop was ARMED on ${assets.join(', ')} but the cycle ended ${status} ` +
        'before it could be generated — NO order placed; it fires on the next successful cycle.',
    );
    await sendTelegram(
      formatArmedStopNotFired({ assets, status, timestamp: context.generatedAt }),
    );
  };

  const observeTransition = async (
    decisionId: number | null,
    bookedLedger: LedgerEntry[],
    /**
     * The model's VECTOR — the movements computed from the distance between its
     * allocation and the book, BEFORE execution. This is the population the gate will act
     * on the day it blocks, so it is the population the provenance columns rehearse. The
     * skip paths pass an empty vector, which is a fact ("examined, nothing to refuse")
     * rather than an absence.
     */
    vectorLegs: Movement[],
  ): Promise<void> => {
    // No decision row means no foreign key to hang the observation on. Nothing is lost
    // that was not already lost: the cycle itself was not journaled either.
    if (decisionId == null) return;

    // What actually booked on each asset this cycle, netted — the same aggregation the
    // lifecycle does, so "the order this cycle placed" means one thing in both journals.
    const booked = new Map<string, { side: 'buy' | 'sell'; notional: Decimal }>();
    for (const entry of bookedLedger) {
      const asset = entry.symbol.split('/')[0];
      if (!asset) continue;
      const notional = entry.baseDelta.abs().times(entry.valuationPrice);
      const side: 'buy' | 'sell' = entry.baseDelta.gt(0) ? 'buy' : 'sell';
      const prior = booked.get(asset);
      booked.set(
        asset,
        prior && prior.side === side ? { side, notional: prior.notional.plus(notional) } : { side, notional },
      );
    }

    // The verdicts are the HOISTED ones — the very objects the gate and the payload used.
    // Recomputing them here would risk journaling a second opinion that merely looks like
    // the one that was applied.
    const verdicts = transitionVerdicts;

    // ATOMICITY. `judgeVector` is total, so this cannot throw and the closure keeps the
    // property that makes it incapable of failing a cycle — in BOTH modes.
    const vector = judgeVector(
      vectorLegs.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional })),
      verdictsByAsset,
    );
    if (vector.refused) {
      console.log(
        `[transition] vector refused — ${vector.reason} ` +
          `(${TRANSITION_MODE === 'enforce' ? 'ENFORCE: the strategic legs were suppressed' : 'observe mode: nothing blocked'}).`,
      );
    }
    const orphan = vector.legs.filter((l) => l.reason.includes('outside the observed universe'));
    if (orphan.length > 0) {
      console.warn(
        `[warn] ${orphan.length} movement(s) on assets the transition layer produced no verdict for ` +
          `(${orphan.map((l) => l.asset).join(', ')}) — journaled as unjudged; the observation is incomplete.`,
      );
    }

    const rows = verdicts.map((verdict) => {
      const order = booked.get(verdict.asset);
      return toObservationRow(
        decisionId,
        verdict,
        order == null
          ? null
          : { side: order.side, notional: toNumericString(order.notional), ...judgeOrder(verdict, order.side) },
        vector,
      );
    });

    await saveTransitionObservations(supabase, rows);
  };

  /**
   * THE EXPOSURE BAND, IN OBSERVATION MODE.
   *
   * Computes the deterministic context, the band it implies, where the retained target sits
   * relative to that band, and what the freezes and the per-asset caps would actually let a
   * correction reach — then writes one row. It corrects NOTHING and it creates NOTHING: no
   * caller reads its return value, and the target that reaches `computeMovements` is the same
   * object it was before this brick existed.
   *
   * That inertness is STRUCTURAL, not a promise, and it rests on three properties rather than
   * on a comment:
   *
   *   1. the closure returns `void`, so no allocation or movement can be derived from it;
   *   2. it is called from the terminal paths, AFTER the orders have been placed — the same
   *      tier and the same placement as `observeTransition`, the equity snapshot and the
   *      Telegram sends, so a stalled insert cannot weigh on the trading verdict;
   *   3. its writer is best-effort and bounded by contract, so it cannot fail a cycle either.
   *
   * OFF BY DEFAULT. With `EXPOSURE_BAND_MODE` unset the closure returns immediately and not
   * one byte of behaviour changes — including the write, so the table stays empty rather than
   * accumulating rows nobody asked for.
   *
   * ── THE TARGET IT ASSESSES ───────────────────────────────────────────────────────
   *
   * The RISK-CLAMPED proposal, never `gateOutcome.appliedAllocation`. That is precisely where
   * the correction will sit when it becomes real: the coherence guard has already judged the
   * model's raw intention by then (§3.4.5), and the transition gate has not yet had its say
   * (§3.4.2). Assessing the post-gate value would measure the band against a target that, on a
   * refused cycle, is last cycle's vector — a number the band was never meant to constrain.
   */
  const observeExposureBand = async (
    decisionId: number | null,
    /** The clamped target the chain retained. Null on every cycle that produced none. */
    targetAllocation: Record<string, number> | null,
    /** The model's raw proposal, for the published comparison. */
    rawAllocation: Record<string, number> | null,
    /**
     * The book's exposure before the decision — passed in rather than read from `portfolio`,
     * because ONE path must not publish it.
     *
     * When the execution journal cannot be read, `derivePortfolio` returns a 100%-cash book
     * that does not exist. That fallback is safe for the cycle (it refuses to trade on it) and
     * it is NOT safe to journal: a fabricated 0% exposure is indistinguishable, to any later
     * reader, from a book that really was flat. So that path passes null, and every other path
     * passes what it actually measured.
     */
    bookExposurePercent: number | null,
  ): Promise<void> => {
    if (EXPOSURE_BAND_MODE === 'off') return;
    // No decision row means no foreign key to hang the observation on. Nothing is lost that
    // was not already lost: the cycle itself was not journaled either.
    if (decisionId == null) return;

    const row = observeBand({
      decisionId,
      mode: EXPOSURE_BAND_MODE,
      policyVersion: config.exposureBand.version,
      policy: config.exposureBand,
      // PRODUCTION'S OWN POINT, not a rehydration of its own journal. The offline replay
      // reaches the same reading through `regimePointFromJournal`, and the test asserts the
      // two agree — so "live and replay read the same context" is a proof, not a hope.
      regimePoint: context.regimePoint,
      // The allocatable universe IS the breadth denominator, exactly as the controller
      // defines it. Dividing by what happened to load would rescale the signal during a
      // partial outage and push the state across a boundary on thinner evidence.
      universe: tradableBaseAssets(config),
      targetAllocation,
      rawAllocation,
      bookExposurePercent,
      reserveAsset: reserveStable,
      // The HOISTED verdicts — the very objects the payload and the gate used this cycle.
      // Recomputing them would risk journaling a second opinion about the freeze.
      gateByAsset: new Map(transitionVerdicts.map((v) => [v.asset, v.gate])),
      capOf: (asset) => config.execution.caps.perAsset[asset] ?? config.execution.caps.defaultPerAsset,
      maxDeployablePercent: 100 - config.execution.caps.minCashPercent,
      equityQuote: portfolio.equity.toNumber(),
      movementFloorQuote: movementFloor(portfolio.equity, config.execution.minMovementPercent).toNumber(),
      // Under `observe` the stop generates no exit and the model's weight stands; under
      // `enforce` `applyGate` is about to put the line flat. The band must size against the
      // exposure the chain will really pursue, not against a line being liquidated.
      stoppedWeightSurvives: TRANSITION_MODE === 'observe',
    });

    if (row.label != null && row.label !== 'aucune_correction') {
      console.log(
        `[band] ${row.state} [${row.band_low_percent}, ${row.band_high_percent}] — target at ` +
          `${row.target_exposure_percent}%, ${row.label}` +
          (row.unrealisable_points ? ` (${row.unrealisable_points} pt(s) out of reach)` : '') +
          ' — OBSERVATION ONLY, nothing was corrected.',
      );
    }
    await saveBandObservation(supabase, row);
  };

  // The AI sees the virtual book, not the testnet balances.
  const decisionContext = toDecisionContext(context, portfolio, STRATEGY_VERSION, stateRead.states, {
    mode: TRANSITION_MODE,
    actionableByAsset,
  });

  // Edge case 0 — a lifecycle input could not be read. Skip the WHOLE cycle, not just
  // the state write.
  //
  // Skipping only the write is not enough, and the hole is narrow but real: a cycle
  // that fully exits a line leaves the stored row open, and a re-entry before any
  // later cycle writes the flat state would look continuous — inheriting the previous
  // life's entry date, peak and thesis. Trading while unable to record what the trade
  // did to the position is the same mistake as placing an order without a durable
  // booking, which this codebase already refuses to do.
  //
  // It also closes a pre-existing hazard: a failed journal read makes `derivePortfolio`
  // return a 100%-cash book that does not exist, and deciding on it could redeploy
  // capital the bot already holds.
  // The reference target joins the same gate when the guard is armed: without it, rules
  // 1 and 2 silently stop applying, and a cycle that trades with a disarmed guard it
  // still believes is armed is worse than a cycle that does not trade at all. When the
  // guard is OFF the read is irrelevant and its failure changes nothing.
  const referenceUnavailable = COHERENCE_GUARD && !referenceRead.ok;
  if (!ledgerRead.ok || !stateRead.ok || referenceUnavailable) {
    const which = !ledgerRead.ok
      ? 'the execution journal'
      : !stateRead.ok
        ? 'the stored position state'
        : 'the coherence guard\'s reference target';
    const skipReason =
      `${which} could not be read — refusing to trade on a book and a lifecycle we cannot ` +
      'record the outcome of. Nothing is booked and no state is written; the next cycle retries.';
    console.error(`[CRITICAL] Wake-up skipped: ${skipReason} The LLM was not called.`);
    const row = makeRow(decisionContext, context.regime, gitSha, { status: 'skipped', skip_reason: skipReason });
    const { persisted, id } = await insertDecision(supabase, row);
    // Deliberately NO persistLifecycle here: writing from the fallback is the very
    // thing being avoided. The market-data trace is NOT in that category: it records what
    // the exchange did, not what the book looks like, and this cycle may well have been
    // blind on top of failing its lifecycle read.
    //
    // The BAND OBSERVATION is not in that category either, and it is the one place this path
    // differs from its neighbour `observeTransition`. The decision row IS persisted here, so a
    // cycle missing from `exposure_band_observations` would be a hole in the population the
    // closure protocol counts bars from — biasing the denominators of every rate published on
    // it. It is recorded with no target (`gap='no_target'`) and, crucially, with a NULL book
    // exposure: the fallback book is the very thing this branch exists to distrust.
    await observeExposureBand(id, null, null, null);
    await observeMarketDataOutage(id);
    return emptyResult('skipped', persisted, id, row, portfolio, marketData);
  }

  // Edge case 1 — empty context: no tradable pair returned usable data. Never
  // let the AI decide on zero data.
  if (context.market.tradable.length === 0) {
    const skipReason =
      'no tradable pairs returned usable market data — refusing to decide on an empty universe';
    console.error(`[CRITICAL] Wake-up skipped: ${skipReason}. The LLM was not called.`);
    const row = makeRow(decisionContext, context.regime, gitSha, { status: 'skipped', skip_reason: skipReason });
    const { persisted, id } = await insertDecision(supabase, row);
    await persistLifecycle(portfolio, []);
    await observeTransition(id, [], []);
    await observeExposureBand(id, null, null, portfolio.deployedPercent.toNumber());
    await observeMarketDataOutage(id);
    return emptyResult('skipped', persisted, id, row, portfolio, marketData);
  }

  const presentSymbols = context.market.tradable.map((pair) => pair.symbol);
  const assets = allocatableUniverse(presentSymbols, config);

  // ── THE INTENTION REFERENCE, RESTATED — and the counterfactual it feeds ────────
  //
  // Both are derived HERE, before the model is called and long before the transition gate
  // runs. Two reasons, and the second is the load-bearing one:
  //
  //   1. whether the guard has a usable reference is a fact worth knowing before spending
  //      an LLM call, even though it never cancels one — see the degradation below;
  //   2. THE COUNTERFACTUAL MUST BE COMPUTED BEFORE THE GATE. Rule 2 asks whether a
  //      change can reach the book by replaying BOTH intentions against it. Computed
  //      after the gate, a frozen asset yields two empty plans — the old one and the new
  //      one both filtered out — and rule 2 would refuse the decision for being
  //      unexecutable when the only thing making it so is the layer the guard is
  //      explicitly not marking the homework of. `computeMovements` is pure and
  //      gate-blind, so "before" costs nothing.
  //
  // The restatement is the ONE place allowed to put a stored intention into this cycle's
  // frame — see `restateIntentReference`. Nothing downstream re-normalises it, which is
  // what stops the two operands drifting apart again.
  const intentRestatement = referenceRead.intent
    ? restateIntentReference({
        reference: referenceRead.intent,
        universe: assets,
        reserveAsset: reserveStable,
        policy: config,
      })
    : null;
  if (intentRestatement && !intentRestatement.ok) {
    // DEGRADED, NEVER FROZEN — and the distinction from a failed reference READ is the whole
    // point. A read that fails is TRANSIENT: skipping the cycle costs one wake-up and the next
    // one very likely succeeds, so refusing to trade with a guard that only looks armed is the
    // right trade. A restatement that fails is DETERMINISTIC on the same stored row — skipping
    // would repeat forever, and the row that could replace the reference is exactly the row a
    // skipped cycle never writes. The bot would stop trading permanently, without ever calling
    // the model again.
    //
    // So the cycle proceeds with NO reference, which is the bootstrap posture: rules 1 and 2
    // are not evaluated (there is nothing to have moved), rules 3 and 4 stay armed, and the
    // decision this cycle writes becomes a clean reference for the next one. One wake-up of
    // reduced coverage, self-healing, and loud — against a permanent freeze.
    console.error(
      `[CRITICAL] the stored intention reference cannot be restated — ${intentRestatement.reason} ` +
        'This cycle runs WITHOUT a reference: rules 1 and 2 are not evaluated, exactly as on the ' +
        'first decision ever recorded. The decision written this cycle re-establishes it.',
    );
  }
  /** Rule 1's operand: the last intention, in this cycle's universe, NEVER clamped. */
  const intentReference = intentRestatement?.ok ? intentRestatement.value.intent : null;
  /**
   * Rule 2's counterfactual: what the STANDING intention would do to today's book, bounded
   * by today's policy. Empty when there is no reference yet, and — far more often — empty
   * in substance because the standing intention already executed and the book is already
   * where it asked to be.
   */
  const previousIntentMovements = intentRestatement?.ok
    ? computeMovements(
        portfolio,
        intentRestatement.value.bounded,
        priceOf,
        config.execution.feePercent,
        config.execution.minMovementPercent,
      )
    : [];
  if (intentRestatement?.ok && intentRestatement.value.droppedAssets.length > 0) {
    console.warn(
      `[guard] the intention reference lost ${intentRestatement.value.droppedAssets.join(', ')} ` +
        'to a universe change; their weight was transferred to the reserve before comparing.',
    );
  }
  // v4 replays the last five wake-ups; v5 wants the last decision that ACTUALLY DID
  // something. Fetched by its own query, not filtered out of the five: five holds are
  // enough to bury it, and the bot averaged 785 holds in 47 days — so "more than five
  // holds in a row" is the normal condition here, not an edge case. Filtering would
  // have made the v5 memory vanish in exactly the steady state it exists for.
  const [recentDecisions, lastSignificant] = await Promise.all([
    loadRecentDecisions(supabase, config.decision.recentDecisionsToLoad),
    STRATEGY_VERSION === 'v5' ? loadLastSignificantDecision(supabase) : Promise.resolve(null),
  ]);
  // THE STRATEGY SWITCH. v4 is the mandate that produced 785 holds out of 787; v5 is
  // Strategy V2. The absence of STRATEGY_VERSION resolves to v4, so the new behaviour
  // can only be reached by an explicit, correctly-spelled opt-in — never by omission,
  // and never by an environment that lost its variables.
  const v5 = STRATEGY_VERSION === 'v5';
  const systemPrompt = v5 ? buildSystemPromptV5(config, TRANSITION_MODE) : buildSystemPrompt();
  const userPrompt = v5
    ? buildUserPromptV5({
        allocationAssets: assets,
        reserveStable,
        context: decisionContext,
        // The last SIGNIFICANT decision, not the last five wake-ups. v4 fed back five
        // identical holds to a mandate demanding consistency with the past — an anchor
        // that showed the bot its own immobility as if it were evidence.
        lastSignificant,
      })
    : buildUserPrompt({
        allocationAssets: assets,
        reserveStable,
        context: decisionContext,
        recentDecisions,
      });

  // Edge case 2 — the LLM call itself fails.
  const callModel = async (
    retry?: { rejectedResponse: string; instruction: string },
  ): Promise<LlmResult> =>
    runDecision({ systemPrompt, userPrompt, assets, strategy: STRATEGY_VERSION, retry });

  /**
   * LLM cost and latency for the WHOLE cycle, not for the last call.
   *
   * The guard can spend two calls inside one wake-up, and simply overwriting `llm` on
   * the retry would journal only the second one — every recovered cycle would then
   * under-report Anthropic usage and end-to-end latency by roughly half. That is not an
   * abstract accounting concern here: the per-attempt time bound in this very PR was
   * sized from `decisions.latency_ms` over the v5 corpus, so a column that silently
   * stopped counting all the calls would corrupt the next person's calibration of it.
   *
   * `latency_ms` therefore means "time spent in the LLM this cycle". On the 133 cycles
   * that need no retry that is exactly what it meant before.
   */
  const telemetry = { latencyMs: 0, inputTokens: null as number | null, outputTokens: null as number | null };
  const addAttempt = (result: LlmResult): void => {
    telemetry.latencyMs += result.latencyMs;
    // Kept null when the API reported nothing for either attempt — a real zero and an
    // unknown are different facts, and the column is nullable precisely to say so.
    const add = (running: number | null, next: number | null): number | null =>
      running == null && next == null ? null : (running ?? 0) + (next ?? 0);
    telemetry.inputTokens = add(telemetry.inputTokens, result.inputTokens);
    telemetry.outputTokens = add(telemetry.outputTokens, result.outputTokens);
  };

  const llmStart = Date.now();
  let llm: LlmResult;
  try {
    llm = await callModel();
    addAttempt(llm);
  } catch (err) {
    const latencyMs = Date.now() - llmStart;
    // ONE classification, at the only place that holds the real error object. Everything
    // after this — the journal row, the scheduler's delay — reads this structure. Nothing
    // downstream re-inspects the exception, and nothing parses the text we are about to
    // write. `logicalAttempt: 1` is the FIRST call; the guard's relaunch is attempt 2.
    const failure = classifyLlmFailure(err, { logicalAttempt: 1, elapsedMs: latencyMs });
    console.error(
      `[ERROR] LLM call failed (${failure.errorType}${failure.httpStatus != null ? ` ${failure.httpStatus}` : ''}: ` +
        `${failure.message}) — class=${failure.failureClass ?? 'unclassified'}; recording status=error; no decision.`,
    );
    const row = makeRow(decisionContext, context.regime, gitSha, {
      status: 'error',
      model: resolveModel(),
      // The failure JOURNAL, in the same text column that used to hold the bare message —
      // no migration, and strictly more than it held before. On 20/08 this column read
      // `Request was aborted.` four times: no status, no request id, no elapsed time, no
      // way to tell a provider outage from a local bug. A `decided` row's raw_response
      // still means exactly what it always meant; only the failure path changes shape.
      raw_response: serializeLlmFailure(failure),
      latency_ms: latencyMs,
    });
    const { persisted, id } = await insertDecision(supabase, row);
    await flushGuardEvents(id);
    await persistLifecycle(portfolio, []);
    await observeTransition(id, [], []);
    await observeExposureBand(id, null, null, portfolio.deployedPercent.toNumber());
    await observeMarketDataOutage(id);
    // The stop may have been armed on this book. Nothing is placed here — the alert only
    // makes the gap visible. See alertArmedStopNotFired.
    await alertArmedStopNotFired('error');
    return emptyResult('error', persisted, id, row, portfolio, marketData, failure);
  }

  /**
   * Ends the cycle without executing anything: journals the row, attaches the guard
   * events to it, ratchets the lifecycle, and alerts. Shared by the three terminal
   * failure paths below so none of them can forget one of those four steps.
   */
  const failCycle = async (
    status: 'guard_failed' | 'error',
    last: LlmResult,
    event: Omit<GuardEventInsert, 'decision_id' | 'run_token'>,
    alert: string,
    proposal?: ValidatedDecision,
    /**
     * The typed transport cause, on the ONE path here that has one (the guard's relaunch
     * throwing). Every other caller is a model-output failure — a broken output contract,
     * an unusable response, an incoherent one — and passes nothing, which is what keeps
     * those cycles on the generic backoff.
     */
    llmFailure: LlmFailureClassification | null = null,
  ): Promise<DecideResult> => {
    const row = makeRow(decisionContext, context.regime, gitSha, {
      status,
      model: last.model,
      raw_response: last.rawResponse,
      latency_ms: telemetry.latencyMs,
      input_tokens: telemetry.inputTokens,
      output_tokens: telemetry.outputTokens,
      // What it PROPOSED, kept for the post-mortem. A non-`decided` row is never read
      // back as the reference target (that query filters on status), so recording the
      // refused proposal here is evidence, never an input to a later cycle.
      ...(proposal
        ? {
            target_allocation: proposal.targetAllocation,
            action_type: proposal.actionType,
            what_changed: proposal.whatChanged,
            confidence: proposal.confidence,
            reasoning: proposal.reasoning,
            notification_summary: proposal.notificationSummary,
          }
        : {}),
    });
    const { persisted, id } = await insertDecision(supabase, row);
    guardEvents.push(event);
    await persistLifecycle(portfolio, []);
    await observeTransition(id, [], []);
    await observeExposureBand(id, null, null, portfolio.deployedPercent.toNumber());
    await observeMarketDataOutage(id);
    // After persistLifecycle, so anything it queued is written too. It cannot queue a
    // refusal here (it is called with no notes), but the ordering is the same on every
    // path so nobody has to remember which one is the exception.
    await flushGuardEvents(id);
    // Best-effort by contract: sendTelegram never throws and never blocks the cycle.
    await sendTelegram(alert);
    // Sent AFTER the cycle's own alert, so the operator reads why the cycle failed first
    // and the stop notice second — the second only matters in the light of the first.
    await alertArmedStopNotFired(status);
    return emptyResult(status, persisted, id, row, portfolio, marketData, llmFailure);
  };

  // ── The SYSTEMIC check — is the output contract itself still standing? ─────────
  //
  // Deliberately NOT routed through the retry. The key order is deterministic and comes
  // from the schema, so a violation is not a bad cycle: it means the contract broke for
  // every cycle at once (an SDK change, an API change, a schema edit). Relaunching would
  // burn a second call to hit the same wall before dying anyway.
  //
  // So this kills the cycle immediately, with its own alert, worded as a broken system
  // contract rather than one failed wake-up — the two need different reactions from
  // Julien, and an alert that reads like a routine rejection would get the wrong one.
  const orderProblem = outputOrderViolation(llm.rawResponse);
  if (orderProblem) {
    console.error(`[CRITICAL] output contract broken: ${orderProblem} No retry, no execution.`);
    return failCycle(
      'error',
      llm,
      { event_type: 'output_order_violation', attempt: 1, rules: [], assets: [], detail: orderProblem },
      '🚨 CONTRAT DE SORTIE CASSÉ (condition systémique)\n\n' +
        `${orderProblem}\n\n` +
        "L'ordre des champs vient du schéma et est déterministe : si une réponse l'enfreint, " +
        'TOUS les cycles sont touchés à l\'identique, pas seulement celui-ci. Aucune relance ' +
        "n'a été tentée et aucun ordre n'a été passé. Le bot va continuer à échouer à chaque " +
        'réveil jusqu\'à correction — à regarder maintenant, pas demain.',
    );
  }

  // Edge case 3 — invalid response.
  const validation = llm.parsed
    ? validateDecision(llm.parsed, assets, config, STRATEGY_VERSION)
    : ({
        ok: false,
        error: llm.parseError ?? `no usable output (stop_reason=${llm.stopReason ?? 'unknown'})`,
      } as const);

  if (!validation.ok) {
    console.error(`[ERROR] parse_failed: ${validation.error}. Raw response stored; no decision.`);
    const row = makeRow(decisionContext, context.regime, gitSha, {
      status: 'parse_failed',
      model: llm.model,
      raw_response: llm.rawResponse,
      latency_ms: telemetry.latencyMs,
      input_tokens: telemetry.inputTokens,
      output_tokens: telemetry.outputTokens,
    });
    const { persisted, id } = await insertDecision(supabase, row);
    await flushGuardEvents(id);
    await persistLifecycle(portfolio, []);
    await observeTransition(id, [], []);
    await observeExposureBand(id, null, null, portfolio.deployedPercent.toNumber());
    await observeMarketDataOutage(id);
    await alertArmedStopNotFired('parse_failed');
    return emptyResult('parse_failed', persisted, id, row, portfolio, marketData);
  }

  // ── The COHERENCE GUARD ──────────────────────────────────────────────────────
  //
  // Everything the guard needs is derived here, BEFORE any persistence and before any
  // execution (mandate §4.2 rule 5). The bounded target and its movements are pure
  // computations, so running them early costs nothing and buys the guard the only honest
  // answer to "will this target actually produce an order": the one the executor will get.
  const assetsWithStoredThesis = new Set(
    [...stateRead.states.values()]
      .filter((state) => (state.thesis ?? '').trim() !== '')
      .map((state) => state.asset),
  );

  const evaluate = (decision: ValidatedDecision) => {
    const clamp = clampAllocation(decision.targetAllocation, reserveStable, config);
    const movements = computeMovements(
      portfolio,
      clamp.applied,
      priceOf,
      config.execution.feePercent,
      config.execution.minMovementPercent,
    );
    const verdict = COHERENCE_GUARD
      ? checkCoherence({
          // v4 has no `position_notes` at all, so the thesis rules would be unsatisfiable
          // under it — and `STRATEGY_VERSION` absent resolving to v4 is the project's
          // disaster-recovery posture. See CoherenceInput.strategy.
          strategy: STRATEGY_VERSION,
          actionType: decision.actionType,
          // THE RAW EMISSION on both sides of rule 1. `intentReference` is the last
          // intention restated in this cycle's universe and deliberately left unclamped, so
          // feeding it a bounded candidate would put the two operands in different frames
          // again — the exact defect this PR removes, one level down. Raw against raw is
          // invariant to the caps, whichever way they move between two cycles.
          intentTarget: decision.targetAllocation,
          intentReference,
          movements,
          // Rule 2's counterfactual, computed before the gate — see where it is derived.
          previousIntentMovements,
          reserveAsset: reserveStable,
          notes: decision.positionNotes,
          assetsWithStoredThesis,
        })
      : { ok: true, violations: [] as CoherenceViolation[] };
    return { clamp, movements, verdict };
  };

  let v = validation.value;
  let evaluated = evaluate(v);

  if (!evaluated.verdict.ok) {
    const first = evaluated.verdict.violations;
    const firstRules = first.map((x) => x.rule);
    const firstAssets = [...new Set(first.flatMap((x) => x.assets))];
    const firstDetail = first.map((x) => `[${x.rule}] ${x.detail}`).join(' | ');

    console.warn(`[guard] response rejected (${firstRules.join(', ')}) — relaunching once. ${firstDetail}`);
    guardEvents.push({
      event_type: 'guard_rejected_first_attempt',
      attempt: 1,
      rules: firstRules,
      assets: firstAssets,
      detail: firstDetail,
    });

    // THE TIME-BUDGET GATE. One more bounded attempt only if it still fits inside the
    // cycle WITH the post-decision reserve intact. Refusing here is a clean failure a
    // second before the watchdog would have produced a dirty one — possibly mid-booking.
    const remaining = config.scheduler.maxCycleSeconds - elapsedSeconds();
    const needed = config.decision.attemptTimeoutSeconds + config.decision.retryReserveSeconds;
    if (remaining < needed) {
      const detail =
        `no room for the retry: ${remaining.toFixed(1)}s left of the ${config.scheduler.maxCycleSeconds}s ` +
        `budget, ${needed}s needed (one bounded attempt + the post-decision reserve). ` +
        `Rejected on: ${firstRules.join(', ')}.`;
      console.error(`[guard] ${detail} Failing the cycle cleanly instead.`);
      return failCycle(
        'guard_failed',
        llm,
        {
          // NOT `guard_failed_after_retry`: no retry was attempted. Counting it there
          // would inflate "responses still incoherent after the relaunch" with cycles
          // that never got one, and point the operator at the retry prompt when the
          // actual problem is latency.
          event_type: 'guard_failed_no_retry_budget',
          attempt: 1,
          rules: firstRules,
          assets: firstAssets,
          detail,
        },
        `⚠️ Cycle en échec — garde de cohérence, sans relance\n\n${detail}\n\nAucun ordre passé.`,
      );
    }

    // ── THE SINGLE RETRY ───────────────────────────────────────────────────────
    //
    // Timed from OUTSIDE the call, because `addAttempt` only runs when the call returns.
    // A retry that burns its whole 90s deadline and then throws would otherwise
    // contribute nothing to `latency_ms`, and the cycles that lose the most time would
    // be exactly the ones recorded as having spent none.
    //
    // That matters more here than ordinary accounting: the per-attempt bound in this PR
    // was sized from `decisions.latency_ms` over the v5 corpus, so the column has to keep
    // telling the truth about the failure cases it will be re-read on. Tokens are NOT
    // credited on this path — a call that threw reported none, and inventing a zero
    // would be a different lie.
    const retryStart = Date.now();
    try {
      llm = await callModel({
        rejectedResponse: llm.rawResponse,
        instruction: buildRetryPrompt(first),
      });
      addAttempt(llm);
    } catch (err) {
      const retryElapsedMs = Date.now() - retryStart;
      telemetry.latencyMs += retryElapsedMs;
      // Same single classifier, same typed structure — attempt 2 this time. The guard's
      // relaunch is an LLM call like any other, and a provider outage that killed it
      // deserves the same short backoff as one that killed the first call.
      const failure = classifyLlmFailure(err, { logicalAttempt: 2, elapsedMs: retryElapsedMs });
      console.error(
        `[ERROR] the guard's retry call failed (${failure.errorType}: ${failure.message}) — ` +
          `class=${failure.failureClass ?? 'unclassified'}; no decision.`,
      );
      return failCycle(
        'error',
        llm,
        {
          // NOT `guard_failed_after_retry`: the call never landed, so no corrected
          // response exists and there is nothing to judge for coherence. Counting it as a
          // model-coherence failure would send the operator to the retry prompt when the
          // problem is transport or the API.
          event_type: 'guard_retry_call_failed',
          attempt: 2,
          rules: firstRules,
          assets: [],
          // The SAME versioned failure journal as the first-call path, in THIS path's own
          // error-message column. `raw_response` is not available here: on a failed
          // relaunch it holds the first attempt's actual response, which is evidence worth
          // keeping and not an error message to overwrite. So the structured cause goes
          // where the unstructured one already lived.
          detail: serializeLlmFailure(failure),
        },
        `⚠️ Cycle en échec — la relance du garde n'a pas abouti (${failure.errorType}: ${failure.message}). Aucun ordre passé.`,
        undefined,
        failure,
      );
    }

    const retryOrderProblem = outputOrderViolation(llm.rawResponse);
    const retryValidation = retryOrderProblem
      ? ({ ok: false, error: `output contract broken on the retry: ${retryOrderProblem}` } as const)
      : llm.parsed
        ? validateDecision(llm.parsed, assets, config, STRATEGY_VERSION)
        : ({
            ok: false,
            error: llm.parseError ?? `no usable output (stop_reason=${llm.stopReason ?? 'unknown'})`,
          } as const);

    if (!retryValidation.ok) {
      const detail = `the corrected response is itself unusable: ${retryValidation.error}`;
      console.error(`[guard] ${detail}`);
      return failCycle(
        'guard_failed',
        llm,
        {
          event_type: 'guard_failed_after_retry',
          attempt: 2,
          rules: firstRules,
          assets: [],
          detail,
        },
        `⚠️ Cycle en échec — garde de cohérence\n\n${detail}\n\nAucun ordre passé.`,
      );
    }

    const retryDecision = retryValidation.value;
    const retryEvaluated = evaluate(retryDecision);
    if (!retryEvaluated.verdict.ok) {
      const second = retryEvaluated.verdict.violations;
      const detail =
        `still incoherent after the single retry. First attempt: ${firstRules.join(', ')}. ` +
        `Retry: ${second.map((x) => `[${x.rule}] ${x.detail}`).join(' | ')}`;
      console.error(`[guard] ${detail} No order placed.`);
      return failCycle(
        'guard_failed',
        llm,
        {
          event_type: 'guard_failed_after_retry',
          attempt: 2,
          rules: second.map((x) => x.rule),
          assets: [...new Set(second.flatMap((x) => x.assets))],
          detail,
        },
        '⚠️ Cycle en échec — garde de cohérence\n\n' +
          `Réponse refusée deux fois de suite.\n\n${detail}\n\n` +
          'Aucun ordre passé, le cycle est marqué en échec. Le prochain réveil retente normalement.',
        retryDecision,
      );
    }

    // The retry corrected it — this is the outcome the whole relaunch exists for.
    console.log(`[guard] the retry produced a coherent decision (was: ${firstRules.join(', ')}).`);
    guardEvents.push({
      event_type: 'guard_recovered_on_retry',
      attempt: 2,
      rules: firstRules,
      assets: firstAssets,
      detail: `corrected after: ${firstDetail}`,
    });
    v = retryDecision;
    evaluated = retryEvaluated;
  }

  // Decided — bound to the caps, journal the decision, execute the movements.
  const { clamp, movements: proposedMovements } = evaluated;

  /**
   * THE GATE, APPLIED. The one place in the cycle where `observe` and `enforce` diverge.
   *
   * Judged on the movements the model's target PRODUCES, before any of them executes —
   * the same population the observation journals afterwards, from the same verdicts. In
   * `observe` this is a total no-op and `movements === proposedMovements`.
   *
   * The coherence guard has already run and passed by this point, and that ordering is
   * deliberate: the guard judges whether the MODEL was coherent with itself, which is a
   * question about the proposal and not about what the code will let through. Running the
   * gate first would let a transition freeze rewrite the proposal the guard then judged,
   * and the guard would be marking the code's homework instead of the model's.
   */
  const gateJudgement = judgeVector(
    proposedMovements.map((m) => ({ asset: m.asset, side: m.side, notional: m.notional })),
    verdictsByAsset,
  );
  /**
   * THE PEAK STOP'S EXITS, GENERATED BY THE CODE — see `computeStopExits` above, which the
   * failure paths' alert reads too so the two can never disagree about what would fire.
   *
   * Built from the held quantity and the live price, NOT from anything the model proposed:
   * `applyGate` can only filter the list it is handed, so a stop firing on a line the model
   * did not mention would otherwise produce no exit at all.
   */
  const stopExits: Movement[] = TRANSITION_MODE === 'enforce' ? computeStopExits() : [];
  if (stopExits.length > 0) {
    console.warn(
      `[transition] ENFORCE — peak stop firing on ${stopExits.map((m) => m.asset).join(', ')}: ` +
        'full exit generated by the code, independent of the model.',
    );
  }

  const gateOutcome = applyGate({
    mode: TRANSITION_MODE,
    movements: proposedMovements,
    judgement: gateJudgement,
    stopExits,
    clampedAllocation: clamp.applied,
    reserveAsset: reserveStable,
    // The last ACCEPTED applied vector, read at the top of this cycle — what the BOOK was
    // pursuing, which is the only thing a revert may fall back to. Deliberately NOT the
    // guard's rule-1 reference any more: that one is the model's INTENTION, and reverting
    // the book to an intention the chain never retained would store a target nothing ever
    // pursued. The two references are read from the same row for exactly that reason.
    previousApplied: referenceRead.applied,
  });
  const movements = gateOutcome.movements;
  if (gateOutcome.refused) {
    console.warn(`[transition] ENFORCE — ${gateOutcome.reason}`);
  }

  // THE INTENTION AS THE GUARD WILL REREAD IT (migration 0027) — see
  // `buildIntentAllocation` for the full contract of what does and does not touch it.
  //
  // Derived from `stopExits` rather than from anything `applyGate` returned, and placed
  // OUTSIDE the refused/accepted distinction on purpose: the stop fires on both branches,
  // so the intention must be flat on that line either way.
  const intentAllocation = buildIntentAllocation({
    proposal: v.targetAllocation,
    stoppedAssets: new Set(stopExits.map((m) => m.asset)),
    reserveAsset: reserveStable,
  });

  const row = makeRow(decisionContext, context.regime, gitSha, {
    status: 'decided',
    target_allocation: v.targetAllocation,
    // The INTENTION. Written only on a `decided` row, which is exactly right: a cycle the
    // guard refused establishes no reference, so a `guard_failed` row must not carry one.
    intent_allocation: intentAllocation,
    // The EFFECTIVE target. Normally the clamped proposal; on a refused cycle the PREVIOUS
    // applied vector, so what the chain reverts to stays where the book actually is. The
    // row stays `decided`: the intention advanced (column above), the applied did not.
    applied_allocation: gateOutcome.appliedAllocation,
    clamped: clamp.clamped,
    clamp_reason: clamp.reason,
    // Null unless the GATE caused the divergence — `clamped` stays false on that path, so
    // without this column a reader would see two disagreeing allocations and no cause.
    applied_divergence_cause: gateOutcome.refused ? gateOutcome.reason : null,
    action_type: v.actionType,
    what_changed: v.whatChanged,
    confidence: v.confidence,
    // Under v5 the model no longer declares it; the code projects its own regime onto
    // this legacy column (the auditable record is the `regime` column).
    market_state: v.marketState ?? marketStateFromRegime(context.regime),
    reasoning: v.reasoning,
    notification_summary: v.notificationSummary,
    requested_delay_minutes: v.requestedDelayMinutes,
    applied_delay_minutes: v.appliedDelayMinutes,
    model: llm.model,
    raw_response: llm.rawResponse,
    latency_ms: telemetry.latencyMs,
    input_tokens: telemetry.inputTokens,
    output_tokens: telemetry.outputTokens,
  });
  const { persisted, id } = await insertDecision(supabase, row);
  // NO FLUSH HERE, deliberately. `recordGuardEvent` is a best-effort Supabase write with
  // no deadline of its own, and everything below it places real orders. Awaiting optional
  // telemetry ahead of execution would let a stalled observability insert burn the cycle
  // budget until the watchdog force-exits — leaving a persisted `decided` row and a trade
  // that never happened. That is the very failure this PR exists to remove, and it would
  // be absurd to reintroduce it through the trace that documents it.
  //
  // Same tier and same placement rule as the equity snapshot and the Telegram sends: the
  // write happens once the cycle's real work is done. The single flush after
  // persistLifecycle drains everything queued here.

  // Real execution. Each booking needs the decision id as FK and a durable home,
  // so without a persisted decision we place nothing (the book can't evolve).
  let execution: ExecutionSummary | null = null;
  if (id == null) {
    if (movements.length > 0) {
      console.warn(
        '[warn] decision not persisted — movements NOT executed (no order without a durable booking; portfolio will not evolve).',
      );
    }
  } else if (movements.length === 0) {
    execution = emptyExecutionSummary(); // already at target — nothing to do
  } else {
    // The reserve the risk wrapper wants kept in cash — used to size buys on the
    // cash REALLY available after the (down-)snapped sells, so the floor holds.
    // The EFFECTIVE target's reserve, not the proposal's. Identical in `observe` and on
    // any accepted cycle; on a refused one the surviving legs are deterministic exits
    // (sells only), so this cannot size a buy — but reading the effective target keeps the
    // executor and the journal describing the same allocation.
    const targetReserve = portfolio.equity
      .times(gateOutcome.appliedAllocation[reserveStable] ?? 0)
      .div(100);
    execution = await executeMovements(movements, {
      decisionId: id,
      supabase,
      publicClient: publicMainnetClient(),
      testnetClient: testnetAccountClient(),
      priceSource: context.source.marketData,
      feePercent: config.execution.feePercent,
      cash: portfolio.cash,
      targetReserve,
      // Derived from the SAME equity the movements were sized against, so the sizing
      // pass and the executor cannot disagree on where the floor sits this cycle.
      floor: movementFloor(portfolio.equity, config.execution.minMovementPercent),
    });
  }

  // The book AFTER this cycle's bookings — pure, in-memory: replay the pre-trade
  // ledger with the sovereign intents just booked, valued at the SAME prices. No
  // re-read (the booked rows are already in hand), and equal to `portfolio` when
  // nothing booked. This is the "résultante" the activity notification reports.
  const bookedLedger = execution?.bookedLedger ?? [];
  const portfolioAfter =
    bookedLedger.length > 0
      ? derivePortfolio([...ledger, ...bookedLedger], { startingCapital, reserveAsset: reserveStable, priceOf })
      : portfolio;

  // Written from the POST-trade book, so an entry, a reinforcement and a full exit all
  // land in the cycle that caused them.
  await persistLifecycle(portfolioAfter, bookedLedger, v.positionNotes);
  // The layer sees BOTH populations, and they answer different questions. `bookedLedger`
  // is what really happened, and the `order_*` verdicts keep judging exactly that.
  // `movements` is the vector the model asked for, before any venue filter or failed
  // booking could thin it — and that is the population the gate will act on the day it
  // blocks, so it is the one the atomicity provenance rehearses. Runs after every order is
  // placed, and its result is discarded — see the closure's header.
  await observeTransition(id, bookedLedger, proposedMovements);
  // The CLAMPED target — where the correction will sit when it becomes real. See the closure.
  await observeExposureBand(id, clamp.applied, v.targetAllocation, portfolio.deployedPercent.toNumber());

  /**
   * THE REFUSED-INTENTION LEDGER — opened here, resolved here, read by nobody in this file.
   *
   * Same tier and same placement as every other observational write: after the orders, so
   * a stalled insert cannot weigh on the trading verdict, and bounded so it cannot reach
   * the watchdog. Both calls swallow their own failures.
   *
   * `observeTransition` above is deliberately given `proposedMovements`, not the surviving
   * ones: it journals what the model ASKED for and what the layer said about it. Feeding it
   * the post-gate list would erase the refused legs from the very journal that exists to
   * count them.
   */
  //
  // RESOLVE BEFORE OPENING, and the order is load-bearing. An atomically cancelled leg sits
  // on an asset that is itself ACTIONABLE — that is what `cancelled_atomic` means. Opening
  // first would insert its episode and then immediately find it in this same cycle's
  // actionable set, closing it against the very proposal that was just refused: `repeated`,
  // with a delay of zero, contaminating the one metric that is supposed to measure what
  // happens AFTER a refusal. Resolving first means a fresh episode can only ever be closed
  // by a LATER cycle.
  await resolveRefusedEpisodes(
    supabase,
    id,
    new Set([...actionableByAsset].filter(([, ok]) => ok).map(([asset]) => asset)),
    new Map(
      tradableBaseAssets(config).map((asset) => {
        const movement = proposedMovements.find((m) => m.asset === asset) ?? null;
        return [
          asset,
          {
            asset,
            side: movement?.side ?? null,
            targetPercent: v.targetAllocation[asset] ?? null,
            price: priceOf(asset)?.toString() ?? null,
          },
        ];
      }),
    ),
  );

  // Then count this frozen wake-up on every episode still open — driven by the VERDICT,
  // not by whether a leg was dropped. Once the model obeys the prompt and stops proposing
  // on a frozen line, nothing would be dropped and the episode would stop being counted:
  // a ten-cycle freeze would record one. Between resolve and open, so a row inserted below
  // (which already starts at 1) is not counted twice.
  await bumpFrozenEpisodes(
    supabase,
    new Set([...actionableByAsset].filter(([, ok]) => !ok).map(([asset]) => asset)),
  );

  if (gateOutcome.refused && gateOutcome.droppedLegs.length > 0) {
    const legVerdicts = new Map(gateJudgement.legs.map((l) => [`${l.asset}:${l.side}`, l]));
    await openRefusedEpisodes(
      supabase,
      id,
      gateOutcome.droppedLegs.map((m) => {
        const judged = legVerdicts.get(`${m.asset}:${m.side}`);
        return {
          asset: m.asset,
          side: m.side,
          notional: toNumericString(m.notional),
          price: priceOf(m.asset)?.toString() ?? null,
          targetPercent: v.targetAllocation[m.asset] ?? null,
          // The APPLIED reference: a refused leg is reported against the weight the book
          // was actually at, not against what the model had been meaning to reach.
          referencePercent: referenceRead.applied?.[m.asset] ?? null,
          legVerdict: judged?.verdict ?? 'unknown',
          gate: verdictsByAsset.get(m.asset)?.gate ?? 'unknown',
        };
      }),
    );
  }
  // A DECIDED cycle can still have lost a market — a reference pair, or a tactical series.
  // Written here, after every order is placed and after the layer's own observation, so it
  // sits in the same best-effort tier as they do and cannot weigh on the trading verdict.
  await observeMarketDataOutage(id);

  // THE SECOND FLUSH, and it is the one that matters on this path. `persistLifecycle`
  // can queue a `thesis_write_refused` that no earlier flush could have seen: the guard
  // judges on the movements it COMPUTED, the lifecycle on what actually BOOKED, and a
  // movement can pass the first and fail the second (a mainnet filter, a failed durable
  // booking). With the guard switched off, this is the only path those refusals have.
  await flushGuardEvents(id);

  return {
    status: 'decided',
    persisted,
    decisionId: id,
    row,
    marketData,
    portfolio,
    portfolioAfter,
    clamp,
    movements,
    execution,
    // A decided cycle had no LLM call failure by construction — it has a model response.
    llmFailure: null,
  };
}

function emptyResult(
  status: DecisionRow['status'],
  persisted: boolean,
  id: number | null,
  row: DecisionRow,
  portfolio: VirtualPortfolio | null,
  marketData: SeenMarket,
  /**
   * The typed LLM transport cause, on the two paths that have one. Optional and defaulted
   * to null so the skip / parse_failed / guard_failed call sites keep saying exactly what
   * they said before: no LLM call failed there, and the generic backoff still applies.
   */
  llmFailure: LlmFailureClassification | null = null,
): DecideResult {
  return {
    status,
    persisted,
    decisionId: id,
    row,
    marketData,
    portfolio,
    portfolioAfter: null,
    clamp: null,
    movements: [],
    execution: null,
    llmFailure,
  };
}

/** Builds a full decision row, defaulting every optional field to null. */
function makeRow(
  marketContext: unknown,
  regime: unknown,
  gitSha: string | null,
  over: Partial<DecisionRow> & { status: DecisionRow['status'] },
): DecisionRow {
  return {
    status: over.status,
    skip_reason: over.skip_reason ?? null,
    target_allocation: over.target_allocation ?? null,
    intent_allocation: over.intent_allocation ?? null,
    applied_allocation: over.applied_allocation ?? null,
    clamped: over.clamped ?? null,
    clamp_reason: over.clamp_reason ?? null,
    applied_divergence_cause: over.applied_divergence_cause ?? null,
    action_type: over.action_type ?? null,
    what_changed: over.what_changed ?? null,
    confidence: over.confidence ?? null,
    market_state: over.market_state ?? null,
    reasoning: over.reasoning ?? null,
    notification_summary: over.notification_summary ?? null,
    requested_delay_minutes: over.requested_delay_minutes ?? null,
    applied_delay_minutes: over.applied_delay_minutes ?? null,
    market_context: marketContext,
    // Journaled on EVERY row (decided, skipped, parse_failed, error): the regime is a
    // reading of the market, not of the decision, so a cycle that failed downstream
    // must still leave its regime in the audit trail.
    regime,
    model: over.model ?? null,
    prompt_version: STRATEGY_VERSION === 'v5' ? PROMPT_V5_VERSION : PROMPT_VERSION,
    git_sha: gitSha,
    raw_response: over.raw_response ?? null,
    latency_ms: over.latency_ms ?? null,
    input_tokens: over.input_tokens ?? null,
    output_tokens: over.output_tokens ?? null,
  };
}
