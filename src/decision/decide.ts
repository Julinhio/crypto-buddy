import { config, tradableBaseAssets, STRATEGY_VERSION } from '../config/index.js';
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
import { allocatableUniverse, reserveStables, validateDecision } from './schema.js';
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

  const supabase = getSupabaseClient();
  const gitSha = getGitSha();

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
  const stateRead = await loadPositionStates(supabase);

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
      console.log(
        `[thesis] ignored ${refused.length} proposed thesis/theses on unmoved lines (${refused.join(', ')}) — ` +
          'a thesis is only recorded when the line moves, or when it has none yet.',
      );
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
  if (!ledgerRead.ok || !stateRead.ok) {
    const which = !ledgerRead.ok ? 'the execution journal' : 'the stored position state';
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
  const llmStart = Date.now();
  let llm: LlmResult;
  try {
    llm = await runDecision({ systemPrompt, userPrompt, assets, strategy: STRATEGY_VERSION });
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
    await persistLifecycle(portfolio, []);
    return emptyResult('error', persisted, id, row, portfolio);
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
      latency_ms: llm.latencyMs,
      input_tokens: llm.inputTokens,
      output_tokens: llm.outputTokens,
    });
    const { persisted, id } = await insertDecision(supabase, row);
    await persistLifecycle(portfolio, []);
    return emptyResult('parse_failed', persisted, id, row, portfolio);
  }

  // Decided — bound to the caps, journal the decision, compute + journal movements.
  const v = validation.value;
  const clamp = clampAllocation(v.targetAllocation, reserveStable, config);

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
    latency_ms: llm.latencyMs,
    input_tokens: llm.inputTokens,
    output_tokens: llm.outputTokens,
  });
  const { persisted, id } = await insertDecision(supabase, row);

  // The movements to reach the bounded allocation, sized on the book at real prices.
  const movements = computeMovements(
    portfolio,
    clamp.applied,
    priceOf,
    config.execution.feePercent,
    config.execution.minMovementPercent,
  );

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
