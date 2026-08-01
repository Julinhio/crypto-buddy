import { config, tradableBaseAssets, STRATEGY_VERSION, COHERENCE_GUARD } from '../config/index.js';
import { dec } from '../money.js';
import { buildMarketContext, type MarketContext } from '../context/build.js';
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
import {
  loadReferenceTarget,
  recordGuardEvent,
  type GuardEventInsert,
} from '../persistence/decisionGuard.js';
import { sendTelegram } from '../alerting/telegram.js';
import { buildSystemPrompt, buildUserPrompt, marketStateFromRegime, PROMPT_VERSION } from './prompt.js';
import { buildSystemPromptV5, buildUserPromptV5, PROMPT_V5_VERSION } from './promptV5.js';
import { assertAnthropicConfigured, resolveModel, runDecision, type LlmResult } from './llm.js';
import { getGitSha } from './gitSha.js';

export interface DecideResult {
  status: DecisionRow['status'];
  persisted: boolean;
  decisionId: number | null;
  row: DecisionRow;
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

  const context = await buildMarketContext();

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
    loadReferenceTarget(supabase),
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
  // The AI sees the virtual book, not the testnet balances.
  const decisionContext = toDecisionContext(context, portfolio, STRATEGY_VERSION, stateRead.states);

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
    // thing being avoided.
    return emptyResult('skipped', persisted, id, row, portfolio);
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
    return emptyResult('skipped', persisted, id, row, portfolio);
  }

  const presentSymbols = context.market.tradable.map((pair) => pair.symbol);
  const assets = allocatableUniverse(presentSymbols, config);
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
  const systemPrompt = v5 ? buildSystemPromptV5() : buildSystemPrompt();
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] LLM call failed (${message}) — recording status=error; no decision.`);
    const row = makeRow(decisionContext, context.regime, gitSha, {
      status: 'error',
      model: resolveModel(),
      raw_response: message,
      latency_ms: latencyMs,
    });
    const { persisted, id } = await insertDecision(supabase, row);
    await flushGuardEvents(id);
    await persistLifecycle(portfolio, []);
    return emptyResult('error', persisted, id, row, portfolio);
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
    // After persistLifecycle, so anything it queued is written too. It cannot queue a
    // refusal here (it is called with no notes), but the ordering is the same on every
    // path so nobody has to remember which one is the exception.
    await flushGuardEvents(id);
    // Best-effort by contract: sendTelegram never throws and never blocks the cycle.
    await sendTelegram(alert);
    return emptyResult(status, persisted, id, row, portfolio);
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
    return emptyResult('parse_failed', persisted, id, row, portfolio);
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
          targetAllocation: decision.targetAllocation,
          referenceTarget: referenceRead.target,
          movements,
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
          event_type: 'guard_failed_after_retry',
          attempt: 1,
          rules: firstRules,
          assets: firstAssets,
          detail,
        },
        `⚠️ Cycle en échec — garde de cohérence, sans relance\n\n${detail}\n\nAucun ordre passé.`,
      );
    }

    // ── THE SINGLE RETRY ───────────────────────────────────────────────────────
    try {
      llm = await callModel({
        rejectedResponse: llm.rawResponse,
        instruction: buildRetryPrompt(first),
      });
      addAttempt(llm);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] the guard's retry call failed (${message}) — no decision.`);
      return failCycle(
        'error',
        llm,
        {
          event_type: 'guard_failed_after_retry',
          attempt: 2,
          rules: firstRules,
          assets: [],
          detail: `retry call failed: ${message}`,
        },
        `⚠️ Cycle en échec — la relance du garde n'a pas abouti (${message}). Aucun ordre passé.`,
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
  const { clamp, movements } = evaluated;

  const row = makeRow(decisionContext, context.regime, gitSha, {
    status: 'decided',
    target_allocation: v.targetAllocation,
    applied_allocation: clamp.applied,
    clamped: clamp.clamped,
    clamp_reason: clamp.reason,
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
  // Attached to the decision they were about — including a rejection that the retry then
  // corrected, which is precisely the case worth being able to count later.
  await flushGuardEvents(id);

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
    const targetReserve = portfolio.equity.times(clamp.applied[reserveStable] ?? 0).div(100);
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
    portfolio,
    portfolioAfter,
    clamp,
    movements,
    execution,
  };
}

function emptyResult(
  status: DecisionRow['status'],
  persisted: boolean,
  id: number | null,
  row: DecisionRow,
  portfolio: VirtualPortfolio | null,
): DecideResult {
  return {
    status,
    persisted,
    decisionId: id,
    row,
    portfolio,
    portfolioAfter: null,
    clamp: null,
    movements: [],
    execution: null,
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
    applied_allocation: over.applied_allocation ?? null,
    clamped: over.clamped ?? null,
    clamp_reason: over.clamp_reason ?? null,
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
