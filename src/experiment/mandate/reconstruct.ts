import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../../config/index.js';
import { dec, type Decimal } from '../../money.js';
import { derivePortfolio, type PriceLookup, type VirtualPortfolio } from '../../portfolio/derive.js';
import type { LedgerEntry } from '../../persistence/executions.js';
import { loadStartingCapital } from '../../persistence/startingCapital.js';
import {
  buildPriceLookup,
  toPortfolioView,
  type DecisionContext,
} from '../../decision/context.js';
import type { MarketContext } from '../../context/build.js';
import { allocatableUniverse, reserveStables } from '../../decision/schema.js';
import { buildUserPromptV5 } from '../../decision/promptV5.js';
import { clampAllocation } from '../../risk/clamp.js';
import { computeMovements, type Movement } from '../../execution/movements.js';
import { restateIntentReference } from '../../decision/intentReference.js';
import type { DecisionSummary } from '../../persistence/decisions.js';
import {
  loadDecisionRow,
  loadGuardReferenceBefore,
  loadLastSignificantBefore,
  loadLedgerBefore,
  type StoredDecisionRow,
} from './read.js';
import { judgeResponse, type PipelineInputs } from './pipeline.js';
import { sha256 } from './variants.js';

/**
 * RECONSTRUCTION of one historical cycle from what is PERSISTED — and gate 1.
 *
 * The rules of the brief, restated as code:
 *   - the context is the PERSISTED `market_context` of the cycle, verbatim;
 *   - the memory (last significant decision) and the guard reference are rebuilt
 *     with the PRODUCTION queries bounded strictly BEFORE the cycle (read.ts);
 *   - `position_state` is NEVER read: the thesis set the guard needs comes from the
 *     persisted context's own `positions` array, which production derived from the
 *     state as it stood BEFORE the cycle — the only surviving snapshot of it;
 *   - every divergence between the reconstruction and the persisted cycle is a
 *     STOP, not a warning.
 *
 * KNOWN LIMIT, stated rather than hidden: `market_context` is a jsonb column, and
 * jsonb does not preserve key order. The reconstructed user prompt embeds the same
 * keys and values production embedded, in the column's (deterministic) order rather
 * than the original serialization order, which no store retained. Whether that
 * matters to the model is precisely what gate 2 measures: the control C must
 * reproduce the historical answer within the local threshold, or the experiment
 * stops.
 */

export interface ContextSpec {
  decisionId: number;
  role: string;
  /** 100 − stored target[reserve], from the brief — pinned, then re-verified against the row. */
  historicalRequestedExposure: number;
  /** The memory row the production query must find (pinned from a read-only probe, 23/08). */
  expectedLastSignificantId: number;
  /** The guard-reference row the production query must find (same probe). */
  expectedGuardReferenceId: number;
}

export const EXPERIMENT_CONTEXTS: ContextSpec[] = [
  { decisionId: 1297, role: 'opportunité forte', historicalRequestedExposure: 20, expectedLastSignificantId: 1283, expectedGuardReferenceId: 1296 },
  { decisionId: 1433, role: 'opportunité étroite sur BNB', historicalRequestedExposure: 22, expectedLastSignificantId: 1399, expectedGuardReferenceId: 1432 },
  { decisionId: 1368, role: 'favorable, déjà fortement exposé', historicalRequestedExposure: 48, expectedLastSignificantId: 1367, expectedGuardReferenceId: 1367 },
  { decisionId: 1494, role: 'contrôle négatif, suracheté', historicalRequestedExposure: 10, expectedLastSignificantId: 1443, expectedGuardReferenceId: 1493 },
];

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReconstructedCycle {
  spec: ContextSpec;
  row: StoredDecisionRow;
  context: DecisionContext;
  inputs: PipelineInputs;
  lastSignificant: (DecisionSummary & { id: number }) | null;
  guardReferenceId: number | null;
  userPrompt: string;
  fingerprints: {
    storedContextSha256: string;
    memorySha256: string | null;
    userPromptSha256: string;
  };
  gate1: { ok: boolean; checks: GateCheck[] };
}

const EPS = 1e-9;

/**
 * Key-order-independent serialization, for the projection comparison ONLY. jsonb
 * reorders object keys, so a byte comparison of two stringifications would fail on
 * order while every value matches — the one difference the store is allowed to have.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value != null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * THE BOOK, REBUILT AT FULL PRECISION — from the ledger, exactly as production does.
 *
 * The obvious shortcut is to rehydrate `market_context.account.portfolio`, and it is
 * subtly wrong: that view is `toPortfolioView`'s projection, with money rounded to two
 * decimals and quantities to eight, whereas production handed `computeMovements` the
 * raw `derivePortfolio` output. Rehydrating it cannot recover what the projection
 * dropped, so a leg sitting within a rounding error of the 2% plumbing floor could
 * exist for production and not for the harness — and the floor decides whether a
 * movement exists at all, which the coherence guard's rules 2 and 4 then read.
 *
 * A round-trip check on the rounded values does NOT close that: it proves rounding is
 * idempotent, not that the precision came back. So the book is replayed from the same
 * source production replays it from — the booked sovereign intents — and the check
 * becomes a PROJECTION check: the full-precision book must project onto the persisted
 * view exactly. That is a statement about the reconstruction, not about rounding.
 *
 * Measured on this corpus before the change: the closest any leg came to the floor was
 * $2.08 against a maximum rounding error of $0.005 (416×), and re-judging all 80 stored
 * responses against both books produced identical outcomes, guard verdicts, legs and
 * zero-line openings — only notionals moved, in the third decimal. The defect was
 * therefore latent here; it is closed structurally rather than argued about.
 */
function rebuildPortfolioFromLedger(params: {
  ledger: LedgerEntry[];
  startingCapital: Decimal;
  reserveAsset: string;
  priceOf: PriceLookup;
}): VirtualPortfolio {
  return derivePortfolio(params.ledger, {
    startingCapital: params.startingCapital,
    reserveAsset: params.reserveAsset,
    priceOf: params.priceOf,
  });
}

function sameAllocation(
  a: Record<string, number> | null | undefined,
  b: Record<string, number> | null | undefined,
  eps = EPS,
): boolean {
  if (a == null || b == null) return a == b;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (Math.abs((a[key] ?? 0) - (b[key] ?? 0)) > eps) return false;
  }
  return true;
}

const fmtAlloc = (a: Record<string, number> | null | undefined): string =>
  a == null ? 'null' : JSON.stringify(a);

export async function reconstructCycle(
  supabase: SupabaseClient,
  spec: ContextSpec,
): Promise<ReconstructedCycle> {
  const checks: GateCheck[] = [];
  const push = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const row = await loadDecisionRow(supabase, spec.decisionId);

  // ── The row itself ────────────────────────────────────────────────────────────
  const rowOk = row.status === 'decided' && row.prompt_version === 'v5' && row.model === 'claude-sonnet-4-6';
  push(
    'row_identity',
    rowOk,
    `status=${row.status}, prompt_version=${row.prompt_version}, model=${row.model} ` +
      '(expected decided / v5 / claude-sonnet-4-6)',
  );

  const context = row.market_context as DecisionContext;
  const topKeys = Object.keys(context ?? {});
  const required = ['generatedAt', 'source', 'market', 'account', 'regime', 'positions'];
  const missing = required.filter((k) => !topKeys.includes(k));
  push(
    'context_shape',
    missing.length === 0,
    missing.length === 0 ? `all required keys present (${required.join(', ')})` : `missing keys: ${missing.join(', ')}`,
  );

  // ── The mode, read from the payload rather than guessed ───────────────────────
  // Only the `enforce` payload carries `actionable` per asset and strips the
  // candidate fields (`raw`, `pendingBars`) — see toActionableRegimeView.
  const regime = (context as { regime?: { assets?: Record<string, Record<string, unknown>>; global?: Record<string, unknown> } }).regime;
  const regimeAssets = Object.values(regime?.assets ?? {});
  const enforceDetected =
    regimeAssets.length > 0 &&
    regimeAssets.every((a) => typeof a.actionable === 'boolean' && !('raw' in a)) &&
    regime?.global != null &&
    !('raw' in regime.global);
  push(
    'enforce_mode_detected',
    enforceDetected,
    enforceDetected
      ? `all ${regimeAssets.length} regime entries carry \`actionable\` and no candidate fields — the cycle ran under TRANSITION_MODE=enforce`
      : 'the persisted regime payload does not match the enforce shape — the mode cannot be established',
  );

  // ── The universe, derived exactly as decide() derives it ──────────────────────
  // Ahead of the book, because the book needs the reserve and the price lookup.
  const reserveStable = reserveStables(config)[0] ?? 'USDT';
  const presentSymbols = context.market.tradable.map((pair) => pair.symbol);
  const assets = allocatableUniverse(presentSymbols, config);
  const storedTarget = row.target_allocation as Record<string, number>;
  const universeMatch =
    JSON.stringify([...assets].sort()) === JSON.stringify(Object.keys(storedTarget).sort());
  push(
    'universe_match',
    universeMatch,
    `derived universe [${assets.join(', ')}] vs stored target keys [${Object.keys(storedTarget).join(', ')}]`,
  );

  // The prices are the context's OWN, at full precision: `market.tradable[].price` is
  // the raw exchange read, never passed through the view's rounding.
  const priceOf: PriceLookup = buildPriceLookup(context as unknown as MarketContext, reserveStable);

  // ── The book, replayed from the ledger at full precision ──────────────────────
  const view = context.account.portfolio;
  const ledger = await loadLedgerBefore(supabase, spec.decisionId);
  const startingCapital =
    (await loadStartingCapital(supabase)) ?? dec(config.execution.startingCapitalUsd);
  const portfolio = rebuildPortfolioFromLedger({
    ledger,
    startingCapital,
    reserveAsset: reserveStable,
    priceOf,
  });
  // THE PROJECTION CHECK — strictly stronger than the round-trip it replaces. It does
  // not ask "do these rounded numbers round the same way again" (which rounding
  // guarantees); it asks whether a book replayed from the booked intents, at full
  // precision, projects onto the view production persisted. Only one book does that.
  const projects = canonical(toPortfolioView(portfolio)) === canonical(view);
  push(
    'book_from_ledger',
    projects,
    projects
      ? `replayed ${ledger.length} booked intent(s) from starting capital ${startingCapital.toString()}: ` +
        'the full-precision book projects onto the persisted view field-for-field'
      : `replaying ${ledger.length} booked intent(s) does NOT reproduce the persisted view — ` +
        `got ${JSON.stringify(toPortfolioView(portfolio))}, stored ${JSON.stringify(view)}`,
  );

  const positionsValue = view.positions.reduce((n, p) => n + p.value, 0);
  const equityGap = Math.abs(view.cash + positionsValue - view.equity);
  push(
    'portfolio_consistency',
    equityGap <= 0.05,
    `cash (${view.cash}) + positions (${positionsValue.toFixed(2)}) vs equity (${view.equity}): gap ${equityGap.toFixed(4)}`,
  );

  // ── The historical answer, re-pinned against the brief ────────────────────────
  const historicalExposure = 100 - (storedTarget[reserveStable] ?? 0);
  push(
    'historical_exposure',
    Math.abs(historicalExposure - spec.historicalRequestedExposure) <= EPS,
    `stored requested exposure ${historicalExposure} vs brief ${spec.historicalRequestedExposure}`,
  );

  // ── The memory and the guard reference, before-the-cycle ──────────────────────
  const lastSignificant = await loadLastSignificantBefore(supabase, row.created_at);
  push(
    'memory_row',
    lastSignificant?.id === spec.expectedLastSignificantId,
    `production memory query found ${lastSignificant?.id ?? 'none'} (expected ${spec.expectedLastSignificantId})`,
  );

  const guardRef = await loadGuardReferenceBefore(supabase, row.created_at, reserveStable);
  push(
    'guard_reference_row',
    guardRef.referenceDecisionId === spec.expectedGuardReferenceId,
    `guard reference query found ${guardRef.referenceDecisionId ?? 'none'} (expected ${spec.expectedGuardReferenceId})`,
  );

  // Restated exactly as decide() restates it — rule 1's operand raw, rule 2's basis bounded.
  let intentReference: Record<string, number> | null = null;
  let previousIntentMovements: Movement[] = [];
  if (guardRef.intent != null) {
    const restated = restateIntentReference({
      reference: guardRef.intent,
      universe: assets,
      reserveAsset: reserveStable,
      policy: config,
    });
    push(
      'guard_reference_restated',
      restated.ok,
      restated.ok
        ? `restated (sum ${restated.value.sum.toFixed(2)}, dropped: ${restated.value.droppedAssets.join(', ') || 'none'})`
        : `restatement failed: ${restated.reason}`,
    );
    if (restated.ok) {
      intentReference = restated.value.intent;
      previousIntentMovements = computeMovements(
        portfolio,
        restated.value.bounded,
        priceOf,
        config.execution.feePercent,
        config.execution.minMovementPercent,
      );
    }
  } else {
    push('guard_reference_restated', false, 'no guard reference intention could be resolved');
  }

  // The thesis set the guard reads — from the PERSISTED context, never position_state.
  const assetsWithStoredThesis = new Set(
    (context.positions ?? [])
      .filter((p) => (p.thesis ?? '').trim() !== '')
      .map((p) => p.asset),
  );

  const inputs: PipelineInputs = {
    portfolio,
    priceOf,
    assets,
    reserveStable,
    intentReference,
    previousIntentMovements,
    assetsWithStoredThesis,
  };

  // ── Clamp replay: the chain retained then what the chain retains now ──────────
  const clampReplay = clampAllocation(storedTarget, reserveStable, config);
  const appliedMatch = sameAllocation(clampReplay.applied, row.applied_allocation as Record<string, number>, 1e-6);
  push(
    'clamp_replay',
    appliedMatch && clampReplay.clamped === (row.clamped ?? false),
    appliedMatch
      ? `replayed clamp reproduces the stored applied allocation (clamped=${clampReplay.clamped})`
      : `replayed clamp diverges: got ${fmtAlloc(clampReplay.applied)}, stored ${fmtAlloc(row.applied_allocation as Record<string, number>)}`,
  );

  // ── THE CONTRACT REPLAY: the harness pipeline on the historical response ──────
  // The strongest gate-1 statement available: the exact raw response production
  // accepted must come out of this pipeline `accepted`, with the same target. Any
  // other outcome means the rebuilt inputs are NOT the inputs production judged
  // with — a divergence of contract, and a stop.
  if (row.raw_response == null) {
    push('historical_replay', false, 'the decided row carries no raw_response to replay');
  } else {
    const replay = judgeResponse(row.raw_response, inputs);
    const targetMatch = sameAllocation(replay.decision?.targetAllocation ?? null, storedTarget, 1e-6);
    const ok = replay.outcome === 'accepted' && targetMatch;
    push(
      'historical_replay',
      ok,
      ok
        ? 'the persisted raw response replays as `accepted` with the stored target — schema, clamp, movements and guard all agree with production'
        : `replay outcome=${replay.outcome} (${replay.invalidReason ?? replay.orderViolation ?? replay.guard?.violations.map((v) => v.rule).join(',') ?? ''}), targetMatch=${targetMatch}`,
    );
  }

  // ── The prompt, and the fingerprints ──────────────────────────────────────────
  const userPrompt = buildUserPromptV5({
    allocationAssets: assets,
    reserveStable,
    context,
    lastSignificant,
  });

  const fingerprints = {
    storedContextSha256: sha256(JSON.stringify(context)),
    memorySha256: lastSignificant == null ? null : sha256(JSON.stringify(lastSignificant)),
    userPromptSha256: sha256(userPrompt),
  };

  return {
    spec,
    row,
    context,
    inputs,
    lastSignificant,
    guardReferenceId: guardRef.referenceDecisionId,
    userPrompt,
    fingerprints,
    gate1: { ok: checks.every((c) => c.ok), checks },
  };
}
