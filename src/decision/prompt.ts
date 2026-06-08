import { config } from '../config/index.js';
import type { DecisionContext } from './context.js';
import type { DecisionSummary } from '../persistence/decisions.js';

/**
 * Bump this whenever the mandate below changes, so decisions stay traceable to
 * the exact instructions that produced them. v2 adds the portfolio book + the
 * hard allocation caps; v3 expands the universe to 4 assets (BTC/ETH/BNB/XRP) and
 * states the per-asset caps explicitly.
 */
export const PROMPT_VERSION = 'v3';

/**
 * Frozen system prompt = the mandate + temperament + hard caps. Kept byte-stable
 * (the caps come from config, which doesn't change between runs) so it can be
 * prompt-cached; all volatile data goes in the user message.
 */
export function buildSystemPrompt(): string {
  const { caps } = config.execution;
  return [
    'You are the decision engine of an autonomous crypto-portfolio bot trading on',
    'Binance (spot, testnet). You PROPOSE a target allocation; deterministic code',
    'DISPOSES — it bounds your allocation to hard risk caps, sizes and (later)',
    'places the orders. You never place orders yourself.',
    '',
    'Your book is a SOVEREIGN virtual portfolio valued at real market prices,',
    'NOT the testnet account balance (which is inflated and resets monthly). The',
    'user message shows your real book: cash, positions with average cost, equity,',
    'deployed %, and realized/unrealized P&L. Allocate as percentages of equity.',
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
    '5. Stay consistent with past decisions — no yo-yo flip-flopping. The more volatile',
    '   names carry tighter caps; size them smaller and de-risk them quicker.',
    '',
    'Hard per-asset caps the code enforces — INDEPENDENT limits (they need NOT sum to 100;',
    'the real collective guard is the cash floor below). Propose WITHIN them — if you exceed',
    'one, the code trims the excess to the cap and moves it to CASH (never to another coin):',
    ...Object.entries(caps.perAsset).map(([asset, cap]) => `- at most ${cap}% of equity in ${asset};`),
    `- at least ${caps.minCashPercent}% kept in the reserve stable (cash) at all times — sacred;`,
    `  this bounds total deployed capital to at most ${100 - caps.minCashPercent}%.`,
    '',
    'The user message gives you: the assets you may allocate to, the current market',
    'context, your virtual portfolio, and your recent past decisions.',
    '',
    'Respond with a SINGLE JSON object and nothing else (no markdown, no commentary):',
    '- target_allocation: an object whose keys are EXACTLY the allowed assets you are',
    '  given (tradable base assets + the reserve stable). Values are percentages of',
    '  equity that sum to 100; each is >= 0. Assets shown as "reference"/watchlist in',
    '  the context are situational awareness ONLY — never allocate to them.',
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

  const summary: Record<string, unknown> = {
    at: d.created_at,
    action_type: d.action_type,
    // What you PROPOSED that cycle (your raw target). This is your decision — NOT
    // necessarily what your book holds now; your real current book is in the
    // context above.
    proposed_allocation: d.target_allocation,
  };

  // If the risk wrapper trimmed your proposal to a cap, surface the bounded
  // TARGET it aimed for, plus the reason. This is the execution INPUT, not an
  // allocation you necessarily reached — a movement may not book (min-notional
  // crumb, symbol rules unavailable, a failed write) — so it is deliberately NOT
  // labelled "applied"/"held". The takeaway: proposing past a cap is futile; the
  // code trims the excess to the cap every time.
  if (d.clamped) {
    summary.risk_bounded_target = d.applied_allocation ?? d.target_allocation;
    summary.clamped = true;
    summary.clamp_reason = d.clamp_reason ?? null;
  }

  summary.confidence = d.confidence;
  summary.market_state = d.market_state;
  summary.what_changed = d.what_changed;
  // Truncate to keep the prompt bounded; full reasoning lives in the DB.
  summary.reasoning = reasoning.length > 800 ? `${reasoning.slice(0, 800)}…` : reasoning;

  return summary;
}

/** Per-run user message carrying all volatile data (kept out of the cached system prompt). */
export function buildUserPrompt(params: {
  allocationAssets: string[];
  reserveStable: string;
  context: DecisionContext;
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
    'Current context — market read + your virtual portfolio (JSON):',
    JSON.stringify(context),
    '',
    'Recent decisions (most recent first):',
    history,
    '',
    'Decide now. Respond with the JSON object only.',
  ].join('\n');
}
