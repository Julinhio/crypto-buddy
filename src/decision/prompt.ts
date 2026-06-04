import type { MarketContext } from '../context/build.js';
import type { DecisionSummary } from '../persistence/decisions.js';

/**
 * Bump this whenever the mandate below changes, so decisions stay traceable to
 * the exact instructions that produced them.
 */
export const PROMPT_VERSION = 'v1';

/**
 * Frozen system prompt = the mandate + temperament. Kept byte-stable (no dates,
 * no per-run data) so it can be prompt-cached; all volatile data goes in the
 * user message. See buildUserPrompt.
 */
export function buildSystemPrompt(): string {
  return [
    'You are the decision engine of an autonomous crypto-portfolio bot trading on',
    'Binance (spot, testnet). You PROPOSE a target allocation; deterministic code',
    'DISPOSES — it places any orders and enforces hard risk guardrails. You never',
    'place orders yourself, and you never see or move real funds here.',
    '',
    'Temperament: balanced and disciplined. Protect capital first. Act rarely, but well.',
    '',
    'Operating principles, in priority order:',
    '1. Doing nothing is the default. Never trade without a concrete reason backed by',
    '   the data in the context. If nothing material changed since the last decision,',
    '   choose "hold" and keep the current allocation.',
    '2. Enter and exit in steps. No all-in or all-out moves; adjust gradually.',
    '3. Reference levels are your compass: accumulate toward lows (year low, ATL),',
    '   lighten toward highs (year high, ATH).',
    '4. A trade must be worth the cost of fees and spread. Ignore moves too small to matter.',
    '5. Stay consistent with past decisions — no yo-yo flip-flopping. Keep small caps on',
    '   a shorter leash: smaller sizing and quicker to de-risk.',
    '',
    'The user message gives you: the assets you may allocate to, the current market',
    'context, and your recent past decisions.',
    '',
    'Respond with a SINGLE JSON object and nothing else (no markdown, no commentary):',
    '- target_allocation: an object whose keys are EXACTLY the allowed assets you are',
    '  given (tradable base assets + the reserve stable). Values are percentages that',
    '  sum to 100; each is >= 0. Assets shown as "reference"/watchlist in the context',
    '  are situational awareness ONLY — never allocate to them.',
    '- action_type: one of "hold", "rebalance", "de_risk", "rotate".',
    '- what_changed: a short note on what changed since the last decision that justifies',
    '  acting (or not). On the very first cycle (no past decisions), say so plainly.',
    '- confidence: one of "low", "medium", "high".',
    '- market_state: one of "trend", "range", "high_vol", "risk_off".',
    '- reasoning: your full rationale, written for a human. Concise but complete. Non-empty.',
    '- next_delay_minutes: how many minutes until you want to be woken again. The code',
    '  clamps this to [15, 240], so pick a sensible cadence in that range.',
  ].join('\n');
}

function summarizeDecision(d: DecisionSummary): Record<string, unknown> {
  const reasoning = (d.reasoning ?? '').trim();
  return {
    at: d.created_at,
    action_type: d.action_type,
    target_allocation: d.target_allocation,
    confidence: d.confidence,
    market_state: d.market_state,
    what_changed: d.what_changed,
    // Truncate to keep the prompt bounded; full reasoning lives in the DB.
    reasoning: reasoning.length > 800 ? `${reasoning.slice(0, 800)}…` : reasoning,
  };
}

/** Per-run user message carrying all volatile data (kept out of the cached system prompt). */
export function buildUserPrompt(params: {
  allocationAssets: string[];
  reserveStable: string;
  context: MarketContext;
  recentDecisions: DecisionSummary[];
}): string {
  const { allocationAssets, reserveStable, context, recentDecisions } = params;

  const history =
    recentDecisions.length > 0
      ? JSON.stringify(recentDecisions.map(summarizeDecision), null, 2)
      : 'None — this is the first cycle.';

  return [
    `Allowed allocation assets (allocate ONLY to these; percentages must sum to 100): ${allocationAssets.join(', ')}.`,
    `The reserve stable is ${reserveStable}.`,
    '',
    'Current market context (JSON):',
    JSON.stringify(context),
    '',
    'Recent decisions (most recent first):',
    history,
    '',
    'Decide now. Respond with the JSON object only.',
  ].join('\n');
}
