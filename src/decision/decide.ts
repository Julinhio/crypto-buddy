import { config } from '../config/index.js';
import { buildMarketContext, type MarketContext } from '../context/build.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import {
  insertDecision,
  loadRecentDecisions,
  type DecisionRow,
} from '../persistence/decisions.js';
import { allocatableUniverse, reserveStables, validateDecision } from './schema.js';
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from './prompt.js';
import { assertAnthropicConfigured, resolveModel, runDecision, type LlmResult } from './llm.js';
import { getGitSha } from './gitSha.js';

export interface DecideResult {
  status: DecisionRow['status'];
  persisted: boolean;
  row: DecisionRow;
}

/**
 * One wake-up of the bot: read the market, ask the AI for a target allocation,
 * validate it, and journal the outcome. Decide-and-log only — no orders.
 *
 * Four terminal statuses:
 *   - 'decided'      valid response → full row stored
 *   - 'skipped'      empty context (no tradable data) → LLM never called
 *   - 'parse_failed' the model responded, but the output is invalid
 *   - 'error'        the LLM call itself failed (API down, rate-limited, …)
 *
 * A missing ANTHROPIC_API_KEY is NOT a status — it's a config error that exits
 * hard (non-zero), so it's caught up front before any work.
 */
export async function decide(): Promise<DecideResult> {
  assertAnthropicConfigured();

  const supabase = getSupabaseClient();
  const gitSha = getGitSha();

  const context = await buildMarketContext();

  // Edge case 1 — empty context: no tradable pair returned usable data. Never
  // let the AI decide on zero data. Skip without calling the LLM. (Reference
  // pairs alone can't be allocated to, so they don't count.)
  if (context.market.tradable.length === 0) {
    const skipReason =
      'no tradable pairs returned usable market data — refusing to decide on an empty universe';
    console.error(`[CRITICAL] Wake-up skipped: ${skipReason}. The LLM was not called.`);
    const row = makeRow(context, gitSha, { status: 'skipped', skip_reason: skipReason });
    const persisted = await insertDecision(supabase, row);
    return { status: 'skipped', persisted, row };
  }

  // Allocatable universe is derived from the pairs PRESENT this cycle (plus the
  // reserve stable), not from config — so a pair the data engine dropped is
  // never offered to the model.
  const presentSymbols = context.market.tradable.map((pair) => pair.symbol);
  const assets = allocatableUniverse(presentSymbols, config);
  const reserveStable = reserveStables(config)[0] ?? 'USDT';

  const recentDecisions = await loadRecentDecisions(
    supabase,
    config.decision.recentDecisionsToLoad,
  );

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    allocationAssets: assets,
    reserveStable,
    context,
    recentDecisions,
  });

  // Edge case 2 — the LLM call itself fails (network, rate limit, 5xx, auth).
  // Record status='error' (distinct from parse_failed: the model never answered).
  const llmStart = Date.now();
  let llm: LlmResult;
  try {
    llm = await runDecision({ systemPrompt, userPrompt, assets });
  } catch (err) {
    const latencyMs = Date.now() - llmStart;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[ERROR] LLM call failed (${message}) — recording status=error; no decision made.`,
    );
    const row = makeRow(context, gitSha, {
      status: 'error',
      model: resolveModel(),
      raw_response: message, // closest available trace for an error row
      latency_ms: latencyMs,
    });
    const persisted = await insertDecision(supabase, row);
    return { status: 'error', persisted, row };
  }

  // Edge case 3 — invalid response: didn't parse, or violated the schema /
  // business rules. Store the raw response (always captured) + a clear error.
  const validation = llm.parsed
    ? validateDecision(llm.parsed, assets, config)
    : ({
        ok: false,
        error: llm.parseError ?? `no usable output (stop_reason=${llm.stopReason ?? 'unknown'})`,
      } as const);

  if (!validation.ok) {
    console.error(
      `[ERROR] parse_failed: ${validation.error}. Raw response stored for debugging; no decision made.`,
    );
    const row = makeRow(context, gitSha, {
      status: 'parse_failed',
      model: llm.model,
      raw_response: llm.rawResponse,
      latency_ms: llm.latencyMs,
      input_tokens: llm.inputTokens,
      output_tokens: llm.outputTokens,
    });
    const persisted = await insertDecision(supabase, row);
    return { status: 'parse_failed', persisted, row };
  }

  const v = validation.value;
  const row = makeRow(context, gitSha, {
    status: 'decided',
    target_allocation: v.targetAllocation,
    action_type: v.actionType,
    what_changed: v.whatChanged,
    confidence: v.confidence,
    market_state: v.marketState,
    reasoning: v.reasoning,
    requested_delay_minutes: v.requestedDelayMinutes,
    applied_delay_minutes: v.appliedDelayMinutes,
    model: llm.model,
    raw_response: llm.rawResponse,
    latency_ms: llm.latencyMs,
    input_tokens: llm.inputTokens,
    output_tokens: llm.outputTokens,
  });
  const persisted = await insertDecision(supabase, row);
  return { status: 'decided', persisted, row };
}

/** Builds a full row, defaulting every decision field to null. */
function makeRow(
  context: MarketContext,
  gitSha: string | null,
  over: Partial<DecisionRow> & { status: DecisionRow['status'] },
): DecisionRow {
  return {
    status: over.status,
    skip_reason: over.skip_reason ?? null,
    target_allocation: over.target_allocation ?? null,
    action_type: over.action_type ?? null,
    what_changed: over.what_changed ?? null,
    confidence: over.confidence ?? null,
    market_state: over.market_state ?? null,
    reasoning: over.reasoning ?? null,
    requested_delay_minutes: over.requested_delay_minutes ?? null,
    applied_delay_minutes: over.applied_delay_minutes ?? null,
    market_context: context,
    model: over.model ?? null,
    prompt_version: PROMPT_VERSION,
    git_sha: gitSha,
    raw_response: over.raw_response ?? null,
    latency_ms: over.latency_ms ?? null,
    input_tokens: over.input_tokens ?? null,
    output_tokens: over.output_tokens ?? null,
  };
}
