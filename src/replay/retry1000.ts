import 'dotenv/config';
import { config, STRATEGY_VERSION } from '../config/index.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import type { DecisionSummary } from '../persistence/decisions.js';
import type { DecisionContext } from '../decision/context.js';
import { buildSystemPromptV5, buildUserPromptV5 } from '../decision/promptV5.js';
import { assertAnthropicConfigured, runDecision } from '../decision/llm.js';
import { outputOrderViolation } from '../decision/schema.js';
import { buildRetryPrompt } from '../decision/coherence.js';
import { decodeResponse, judge, loadCorpus, replayInOrder, universeOf } from './storedCycle.js';

/**
 * THE RECOVERY PROOF — brief §5.2.
 *
 * Rejecting a bad cycle is the easy half. The half that decides whether this guard is
 * safe to ship is what happens NEXT: does the retry produce a VALID response, or a
 * second failure? A cycle that fails twice is zero trading, and this bot already carries
 * one failure mode of that family since PR #20 — a second one would not be a fix.
 *
 * Cycle 1000 is the hard case on purpose. Its only fault is a thesis written for a line
 * that is not moving. There is nothing to "correct" in its allocation: the correct
 * answer is to DROP THE NOTE and return the same clean hold. If the retry prompt does
 * not name that as a legitimate way out, the model tries to justify the note instead and
 * the cycle dies on the second attempt — which is exactly the failure this script exists
 * to rule out before deployment rather than after.
 *
 * This makes ONE real LLM call. It is deliberately not part of `npm test`.
 *
 * Run with `npm run replay:retry-1000` (or `-- <decisionId>` for another cycle).
 */

const TARGET_ID = Number(process.argv[2] ?? 1000);

async function main(): Promise<void> {
  if (!Number.isInteger(TARGET_ID)) throw new Error(`not a decision id: ${process.argv[2]}`);
  assertAnthropicConfigured();
  if (STRATEGY_VERSION !== 'v5') {
    throw new Error(
      `this proof reconstructs a v5 cycle, but STRATEGY_VERSION resolves to "${STRATEGY_VERSION}". ` +
        'Set STRATEGY_VERSION=v5 for this run.',
    );
  }

  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('replay: Supabase is not configured.');

  // Replay everything up to the target so the reference target is the one the guard
  // would really have had — the last ACCEPTED target, not the previous cycle's.
  const cycles = await loadCorpus(supabase, { maxId: TARGET_ID });
  const steps = replayInOrder(cycles);
  const step = steps.at(-1);
  if (!step || step.cycle.id !== TARGET_ID) throw new Error(`decision #${TARGET_ID} is not in the v5 corpus.`);
  if (step.verdict.kind !== 'rejected') {
    throw new Error(
      `decision #${TARGET_ID} is not rejected by the guard (verdict: ${step.verdict.kind}) — ` +
        'there is nothing to recover from.',
    );
  }

  const { cycle, referenceTarget } = step;
  const violations = step.verdict.violations;
  const ctx = cycle.market_context;
  const assets = universeOf(ctx);
  const reserveStable = ctx.account.portfolio.reserveAsset;

  // The memory that cycle was given: the last decision that actually moved the book
  // BEFORE it. Same shape as `loadLastSignificantDecision`, bounded in time so the
  // reconstruction is the prompt of that moment and not of today.
  const { data: significantRows, error: significantError } = await supabase
    .from('decisions')
    .select(
      'created_at, action_type, target_allocation, applied_allocation, clamped, clamp_reason, ' +
        'confidence, market_state, what_changed, reasoning, executions!inner(id)',
    )
    .eq('status', 'decided')
    .eq('executions.event_type', 'intent')
    .eq('executions.validation_status', 'executed')
    .lt('created_at', cycle.created_at)
    .order('created_at', { ascending: false })
    .limit(1);
  if (significantError) throw new Error(`could not read the last significant decision (${significantError.message}).`);
  const significantRow = (significantRows ?? [])[0] as (DecisionSummary & { executions?: unknown }) | undefined;
  const lastSignificant = significantRow
    ? ((({ executions: _drop, ...rest }) => rest as DecisionSummary)(significantRow))
    : null;

  console.log('='.repeat(96));
  console.log(`RECOVERY PROOF — cycle #${cycle.id} (${cycle.created_at.slice(0, 16)}) through the single retry`);
  console.log('='.repeat(96));
  console.log('');
  console.log('Rejected on:');
  for (const v of violations) console.log(`  [${v.rule}] ${v.detail}`);
  console.log('');
  console.log(`Reference target the guard compared against: ${JSON.stringify(referenceTarget)}`);
  console.log('');

  const systemPrompt = buildSystemPromptV5();
  const userPrompt = buildUserPromptV5({
    allocationAssets: assets,
    reserveStable,
    // The stored market_context IS the DecisionContext the model was served.
    context: ctx as unknown as DecisionContext,
    lastSignificant,
  });

  console.log('Relaunching once, with the rejected response replayed and the valid ways out named…');
  const started = Date.now();
  const llm = await runDecision({
    systemPrompt,
    userPrompt,
    assets,
    strategy: 'v5',
    retry: { rejectedResponse: cycle.raw_response, instruction: buildRetryPrompt(violations) },
  });
  const elapsed = (Date.now() - started) / 1000;
  console.log(
    `  → ${elapsed.toFixed(2)}s, ${llm.outputTokens ?? '?'} output tokens, model ${llm.model}.`,
  );
  console.log('');

  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

  // 1. The retry has to honour the reordered contract too.
  const orderProblem = outputOrderViolation(llm.rawResponse);
  checks.push({
    label: 'the corrected response reasons BEFORE it decides',
    ok: orderProblem === null,
    detail: orderProblem ?? 'reasoning precedes target_allocation in the raw response.',
  });

  // 2. It has to be a usable decision at all.
  const decoded = decodeResponse(llm.rawResponse, assets);
  checks.push({
    label: 'the corrected response parses and validates',
    ok: decoded.ok,
    detail: decoded.ok ? 'schema + business rules both satisfied.' : decoded.reason,
  });

  // 3. And it has to pass the guard that rejected its predecessor.
  let verdictDetail = 'not evaluated (the response was unusable).';
  let verdictOk = false;
  if (decoded.ok) {
    const verdict = judge(decoded.decision, ctx, referenceTarget);
    verdictOk = verdict.ok;
    verdictDetail = verdict.ok
      ? `accepted. action_type=${decoded.decision.actionType}, target=${JSON.stringify(decoded.decision.targetAllocation)}, ` +
        `position_notes=[${decoded.decision.positionNotes.map((n) => n.asset).join(', ') || 'empty'}]`
      : `STILL rejected: ${verdict.violations.map((v) => `[${v.rule}] ${v.detail}`).join(' | ')}`;
  }
  checks.push({
    label: 'the corrected response passes the coherence guard',
    ok: verdictOk,
    detail: verdictDetail,
  });

  for (const check of checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`);
    console.log(`      ${check.detail}`);
  }

  console.log('');
  console.log('Corrected response:');
  console.log(llm.rawResponse.slice(0, 2400));
  console.log('');

  const budget = config.decision.attemptTimeoutSeconds;
  console.log('-'.repeat(96));
  console.log(
    `Retry latency ${elapsed.toFixed(2)}s against the ${budget}s per-attempt bound ` +
      `(${((elapsed / budget) * 100).toFixed(0)}% of it).`,
  );
  const allOk = checks.every((c) => c.ok);
  console.log(
    allOk
      ? `RECOVERED. Cycle #${cycle.id} produces a valid decision on its single retry — the rejection ` +
        'costs one extra LLM call, not a dead cycle.'
      : `NOT RECOVERED. Cycle #${cycle.id} still fails after the retry — the retry prompt is not doing ` +
        'its job and shipping this guard would trade a lost trade for a lost cycle.',
  );
  console.log('-'.repeat(96));
  if (!allOk) process.exitCode = 1;
}

await main();
