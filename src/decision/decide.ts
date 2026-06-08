import { config } from '../config/index.js';
import { dec } from '../money.js';
import { buildMarketContext, type MarketContext } from '../context/build.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import {
  insertDecision,
  loadRecentDecisions,
  type DecisionRow,
} from '../persistence/decisions.js';
import { loadLedger } from '../persistence/executions.js';
import { loadStartingCapital } from '../persistence/startingCapital.js';
import { derivePortfolio, type VirtualPortfolio } from '../portfolio/derive.js';
import {
  buildPriceLookup,
  toDecisionContext,
  type DecisionContext,
} from './context.js';
import { clampAllocation, type ClampResult } from '../risk/clamp.js';
import { computeMovements, type Movement } from '../execution/movements.js';
import {
  executeMovements,
  emptyExecutionSummary,
  type ExecutionSummary,
} from '../execution/execute.js';
import { publicMainnetClient, testnetAccountClient } from '../exchanges/binance.js';
import { allocatableUniverse, reserveStables, validateDecision } from './schema.js';
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from './prompt.js';
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
  const ledger = await loadLedger(supabase);
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
  // The AI sees the virtual book, not the testnet balances.
  const decisionContext = toDecisionContext(context, portfolio);

  // Edge case 1 — empty context: no tradable pair returned usable data. Never
  // let the AI decide on zero data.
  if (context.market.tradable.length === 0) {
    const skipReason =
      'no tradable pairs returned usable market data — refusing to decide on an empty universe';
    console.error(`[CRITICAL] Wake-up skipped: ${skipReason}. The LLM was not called.`);
    const row = makeRow(decisionContext, gitSha, { status: 'skipped', skip_reason: skipReason });
    const { persisted, id } = await insertDecision(supabase, row);
    return emptyResult('skipped', persisted, id, row, portfolio);
  }

  const presentSymbols = context.market.tradable.map((pair) => pair.symbol);
  const assets = allocatableUniverse(presentSymbols, config);
  const recentDecisions = await loadRecentDecisions(
    supabase,
    config.decision.recentDecisionsToLoad,
  );
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    allocationAssets: assets,
    reserveStable,
    context: decisionContext,
    recentDecisions,
  });

  // Edge case 2 — the LLM call itself fails.
  const llmStart = Date.now();
  let llm: LlmResult;
  try {
    llm = await runDecision({ systemPrompt, userPrompt, assets });
  } catch (err) {
    const latencyMs = Date.now() - llmStart;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] LLM call failed (${message}) — recording status=error; no decision.`);
    const row = makeRow(decisionContext, gitSha, {
      status: 'error',
      model: resolveModel(),
      raw_response: message,
      latency_ms: latencyMs,
    });
    const { persisted, id } = await insertDecision(supabase, row);
    return emptyResult('error', persisted, id, row, portfolio);
  }

  // Edge case 3 — invalid response.
  const validation = llm.parsed
    ? validateDecision(llm.parsed, assets, config)
    : ({
        ok: false,
        error: llm.parseError ?? `no usable output (stop_reason=${llm.stopReason ?? 'unknown'})`,
      } as const);

  if (!validation.ok) {
    console.error(`[ERROR] parse_failed: ${validation.error}. Raw response stored; no decision.`);
    const row = makeRow(decisionContext, gitSha, {
      status: 'parse_failed',
      model: llm.model,
      raw_response: llm.rawResponse,
      latency_ms: llm.latencyMs,
      input_tokens: llm.inputTokens,
      output_tokens: llm.outputTokens,
    });
    const { persisted, id } = await insertDecision(supabase, row);
    return emptyResult('parse_failed', persisted, id, row, portfolio);
  }

  // Decided — bound to the caps, journal the decision, compute + journal movements.
  const v = validation.value;
  const clamp = clampAllocation(v.targetAllocation, reserveStable, config);

  const row = makeRow(decisionContext, gitSha, {
    status: 'decided',
    target_allocation: v.targetAllocation,
    applied_allocation: clamp.applied,
    clamped: clamp.clamped,
    clamp_reason: clamp.reason,
    action_type: v.actionType,
    what_changed: v.whatChanged,
    confidence: v.confidence,
    market_state: v.marketState,
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
    model: over.model ?? null,
    prompt_version: PROMPT_VERSION,
    git_sha: gitSha,
    raw_response: over.raw_response ?? null,
    latency_ms: over.latency_ms ?? null,
    input_tokens: over.input_tokens ?? null,
    output_tokens: over.output_tokens ?? null,
  };
}
