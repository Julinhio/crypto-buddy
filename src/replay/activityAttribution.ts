import 'dotenv/config';
import path from 'node:path';
import { getSupabaseClient } from '../persistence/supabase.js';
import { config } from '../config/index.js';
import { Decimal } from '../money.js';
import { computeMovements } from '../execution/movements.js';
import { clampAllocation } from '../risk/clamp.js';
import { restateIntentReference } from '../decision/intentReference.js';
import { resolveEffectiveTarget, resolveIntentAllocation } from '../decision/effectiveTarget.js';
import type { DecideResult } from '../decision/decide.js';
import type { CycleProvenance, BandFact, MovementOrigin } from '../decision/provenance.js';
import { prepareActivityNotification, formatActivity } from '../alerting/activity.js';
import type { LedgerEntry } from '../persistence/executions.js';
import type { VirtualPortfolio } from '../portfolio/derive.js';
import { writeArtefact } from '../provenance/artefacts.js';
import { bookOf, pricesOf, universeOf, journaledClampOf, type StoredContext } from './storedCycle.js';

/**
 * WHO MOVED EACH LINE — the activity notification replayed on past cycles.
 *
 * The acceptance proof of PR 2 of the guard/band incident. For each cycle it rebuilds, from
 * the journals alone, the SAME `CycleProvenance` structure `decide()` assembles in production
 * and hands it to the SAME `prepareActivityNotification` / `formatActivity` the beat sends —
 * so what is printed here is the exact Telegram text the cycle would have produced under the
 * new layout. No reimplementation of the attribution exists in this file.
 *
 * ── WHERE EACH FACT COMES FROM, and what is recomputed ────────────────────────────────
 *
 *   - the raw target, the summary and the gate's cause: the `decisions` row;
 *   - the intention and applied references: the previous `decided` row, resolved by the
 *     production resolvers and restated in the cycle's universe by the production
 *     restatement — exactly `loadReferenceAllocations` + `restateIntentReference`;
 *   - the clamped target: `exposure_band_corrections.clamped_weight_percent`, the value the
 *     guard saw (never re-clamped under today's caps when the journal has it);
 *   - the book and the prices: the cycle's own `market_context`, as the model saw them;
 *   - the model's OWN plan: RECOMPUTED — `computeMovements` on the clamped target against
 *     that book, under today's fee and floor (unchanged since the journal began). It is the
 *     one input production has in hand and never journals, and it is named as recomputed;
 *   - the band's facts: `exposure_band_observations` (direction, bound, label, consolidation)
 *     and the per-line journal (points, origin, base, corrected) — only when the row says the
 *     correction was APPLIED (`mode = application`, no `pilot_hold`);
 *   - the stop exits: `transition_observations` with `gate = stop_exit`, the held quantity
 *     from the book;
 *   - what booked: the executed intents of the ledger.
 *
 * Read-only: nothing is written to the database, nothing is sent to Telegram, no cycle runs.
 * Run with `npm run replay:activity-attribution [id,id,...]`; exits non-zero if a criterion
 * fails.
 */

/** The cycles the brief names, and the controls that bracket them. */
const WITNESSES = [2051, 2112, 2139, 2141] as const;
const CONTROLS = {
  /** A cycle entirely decided by the model under the armed pilot (BNB 15 → 10, band 0). */
  fullyModel: 2105,
  /** A decided hold with nothing booked: must produce NO notification. */
  nothingBooked: 2135,
  /** Descriptive extras, printed and counted, asserted only on what the journals prove. */
  extras: [1839, 1951, 2115, 2125, 2132],
} as const;
const OUT_DIR = path.join(process.cwd(), 'out', 'activity-attribution');

type Supabase = NonNullable<ReturnType<typeof getSupabaseClient>>;

interface DecisionRead {
  id: number;
  created_at: string;
  status: string;
  target_allocation: Record<string, number> | null;
  intent_allocation: Record<string, number> | null;
  applied_allocation: Record<string, number> | null;
  applied_divergence_cause: string | null;
  clamp_reason: string | null;
  notification_summary: string | null;
  market_context: StoredContext;
}

interface CorrectionRead {
  asset: string;
  clamped_weight_percent: string | number;
  base_weight_percent: string | number;
  correction_points: string | number;
  corrected_weight_percent: string | number;
  origin: BandFact['lines'][number]['origin'];
  cause: BandFact['lines'][number]['cause'];
}

interface ObservationRead {
  mode: string;
  pilot_hold: string | null;
  direction: BandFact['direction'] | null;
  label: BandFact['label'] | null;
  required_exposure_percent: string | number | null;
  target_exposure_percent: string | number | null;
  corrected_exposure_percent: string | number | null;
  unrealisable_points: string | number | null;
  consolidated: boolean | null;
}

interface TransitionRead {
  asset: string;
  gate: string;
  drawdown_from_peak_percent: string | number | null;
  stop_threshold_percent: string | number;
  leg_side: 'buy' | 'sell' | null;
  leg_notional: string | number | null;
  leg_verdict: string | null;
}

interface IntentRead {
  symbol: string;
  side: 'buy' | 'sell';
  valuation_price: string | number;
  ledger_base_delta: string | number;
  ledger_quote_delta: string | number;
}

const DECISION_COLUMNS =
  'id, created_at, status, target_allocation, intent_allocation, applied_allocation, applied_divergence_cause, clamp_reason, notification_summary, market_context';

async function loadDecision(supabase: Supabase, id: number): Promise<DecisionRead | null> {
  const { data, error } = await supabase.from('decisions').select(DECISION_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(`attribution replay: could not read decision ${id} (${error.message}).`);
  return (data as DecisionRead | null) ?? null;
}

async function loadPreviousDecided(supabase: Supabase, id: number): Promise<DecisionRead | null> {
  const { data, error } = await supabase
    .from('decisions')
    .select(DECISION_COLUMNS)
    .lt('id', id)
    .eq('status', 'decided')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`attribution replay: could not read the reference before ${id} (${error.message}).`);
  return (data as DecisionRead | null) ?? null;
}

async function loadCorrections(supabase: Supabase, id: number): Promise<CorrectionRead[]> {
  const { data, error } = await supabase
    .from('exposure_band_corrections')
    .select('asset, clamped_weight_percent, base_weight_percent, correction_points, corrected_weight_percent, origin, cause')
    .eq('decision_id', id)
    .order('asset');
  if (error) throw new Error(`attribution replay: could not read the corrections of ${id} (${error.message}).`);
  return (data ?? []) as CorrectionRead[];
}

async function loadObservation(supabase: Supabase, id: number): Promise<ObservationRead | null> {
  const { data, error } = await supabase
    .from('exposure_band_observations')
    .select('mode, pilot_hold, direction, label, required_exposure_percent, target_exposure_percent, corrected_exposure_percent, unrealisable_points, consolidated')
    .eq('decision_id', id)
    .maybeSingle();
  if (error) throw new Error(`attribution replay: could not read the band observation of ${id} (${error.message}).`);
  return (data as ObservationRead | null) ?? null;
}

async function loadTransition(supabase: Supabase, id: number): Promise<TransitionRead[]> {
  const { data, error } = await supabase
    .from('transition_observations')
    .select('asset, gate, drawdown_from_peak_percent, stop_threshold_percent, leg_side, leg_notional, leg_verdict')
    .eq('decision_id', id)
    .order('asset');
  if (error) throw new Error(`attribution replay: could not read the transition verdicts of ${id} (${error.message}).`);
  return (data ?? []) as TransitionRead[];
}

async function loadBooked(supabase: Supabase, id: number): Promise<IntentRead[]> {
  const { data, error } = await supabase
    .from('executions')
    .select('symbol, side, valuation_price, ledger_base_delta, ledger_quote_delta')
    .eq('decision_id', id)
    .eq('event_type', 'intent')
    .eq('validation_status', 'executed')
    .order('id');
  if (error) throw new Error(`attribution replay: could not read the ledger of ${id} (${error.message}).`);
  return (data ?? []) as IntentRead[];
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface Rebuilt {
  id: number;
  createdAt: string;
  provenance: CycleProvenance;
  /** Where the clamped target and the model's own plan came from. */
  sources: { clamped: 'journal' | 'recomputed'; modelPlan: 'recomputed' };
  bookedLedger: LedgerEntry[];
  portfolioAfter: VirtualPortfolio;
  summary: string;
}

/** The book after the cycle's bookings, replayed on the stored book at the same prices. */
function bookAfter(book: VirtualPortfolio, booked: readonly LedgerEntry[]): VirtualPortfolio {
  const positions = book.positions.map((p) => ({ ...p }));
  let cash = book.cash;
  for (const e of booked) {
    const asset = e.symbol.split('/')[0]!;
    cash = cash.plus(e.quoteDelta);
    const existing = positions.find((p) => p.asset === asset);
    if (existing) {
      existing.qty = existing.qty.plus(e.baseDelta);
      existing.value = existing.qty.times(existing.price);
    } else {
      positions.push({ asset, qty: e.baseDelta, avgCost: e.valuationPrice, price: e.valuationPrice, priceStale: false, value: e.baseDelta.times(e.valuationPrice), unrealizedPnl: new Decimal(0), weightPercent: new Decimal(0) });
    }
  }
  const kept = positions.filter((p) => p.qty.gt(new Decimal('1e-12')));
  const equity = kept.reduce((sum, p) => sum.plus(p.value), cash);
  for (const p of kept) p.weightPercent = equity.gt(0) ? p.value.div(equity).times(100) : new Decimal(0);
  return { ...book, cash, positions: kept, equity, deployedPercent: equity.gt(0) ? equity.minus(cash).div(equity).times(100) : new Decimal(0) };
}

async function rebuild(supabase: Supabase, id: number): Promise<Rebuilt | null> {
  const row = await loadDecision(supabase, id);
  if (row == null || row.status !== 'decided' || row.target_allocation == null) return null;
  const [previous, corrections, observation, transition, intents] = await Promise.all([
    loadPreviousDecided(supabase, id),
    loadCorrections(supabase, id),
    loadObservation(supabase, id),
    loadTransition(supabase, id),
    loadBooked(supabase, id),
  ]);

  const ctx = row.market_context;
  const reserve = ctx.account.portfolio.reserveAsset;
  const book = bookOf(ctx);
  const priceOf = pricesOf(ctx);
  const universe = universeOf(ctx);
  const target = row.target_allocation;

  // The clamped target the guard saw — the journal when it exists, today's caps otherwise.
  const journaled = journaledClampOf({
    id: row.id,
    created_at: row.created_at,
    raw_response: '',
    market_context: ctx,
    target_allocation: target,
    applied_allocation: row.applied_allocation,
    exposure_band_corrections: corrections.map((c) => ({ asset: c.asset, clamped_weight_percent: c.clamped_weight_percent })),
  });
  const clamped = journaled ?? clampAllocation(target, reserve, config).applied;

  // The references, resolved and restated exactly as production does.
  const restate = (reference: Record<string, number> | null): Record<string, number> | null => {
    if (reference == null) return null;
    const restated = restateIntentReference({ reference, universe, reserveAsset: reserve, policy: config });
    return restated.ok ? restated.value.intent : null;
  };
  const columns = previous
    ? { target_allocation: previous.target_allocation, applied_allocation: previous.applied_allocation, intent_allocation: previous.intent_allocation, applied_divergence_cause: previous.applied_divergence_cause }
    : null;
  const intentReference = columns ? restate(resolveIntentAllocation(columns, reserve).allocation) : null;
  const appliedReference = columns ? restate(resolveEffectiveTarget(columns).allocation) : null;

  // The model's own plan — recomputed, the one fact production never journals.
  const modelLegs = computeMovements(book, clamped, priceOf, config.execution.feePercent, config.execution.minMovementPercent).map((m) => ({
    asset: m.asset,
    side: m.side,
    notional: m.notional.toNumber(),
  }));

  // The band, only when the journal says the correction reached the orders.
  const bandApplied = observation != null && observation.mode === 'application' && observation.pilot_hold == null && observation.direction != null && corrections.length > 0;
  const band: BandFact | null = bandApplied
    ? {
        direction: observation.direction!,
        label: observation.label ?? 'aucune_correction',
        boundPercent: num(observation.required_exposure_percent),
        targetExposurePercent: num(observation.target_exposure_percent) ?? 0,
        correctedExposurePercent: num(observation.corrected_exposure_percent) ?? num(observation.target_exposure_percent) ?? 0,
        unrealisablePoints: num(observation.unrealisable_points) ?? 0,
        consolidated: observation.consolidated === true,
        lines: corrections.map((c) => ({
          asset: c.asset,
          correctionPoints: num(c.correction_points) ?? 0,
          origin: c.origin,
          cause: c.cause,
          baseWeightPercent: num(c.base_weight_percent) ?? 0,
          correctedWeightPercent: num(c.corrected_weight_percent) ?? 0,
        })),
      }
    : null;

  // The stop exits the code generated: a `stop_exit` gate on a held line.
  const stopExits = transition
    .filter((t) => t.gate === 'stop_exit')
    .flatMap((t) => {
      const held = book.positions.find((p) => p.asset === t.asset);
      if (held == null || !held.qty.gt(0)) return [];
      return [{ asset: t.asset, notional: held.value.toNumber(), drawdownFromPeakPercent: num(t.drawdown_from_peak_percent), thresholdPercent: num(t.stop_threshold_percent) ?? config.transition.peakStopPercent }];
    });

  const gate = {
    refused: row.applied_divergence_cause != null,
    reason: row.applied_divergence_cause ?? '',
    droppedLegs: transition
      .filter((t) => (t.leg_verdict === 'forbidden' || t.leg_verdict === 'cancelled_atomic') && t.leg_side != null)
      .map((t) => ({ asset: t.asset, side: t.leg_side!, notional: num(t.leg_notional) ?? 0 })),
  };

  const bookedLedger: LedgerEntry[] = intents.map((e) => ({
    symbol: e.symbol,
    side: e.side,
    valuationPrice: new Decimal(e.valuation_price),
    baseDelta: new Decimal(e.ledger_base_delta),
    quoteDelta: new Decimal(e.ledger_quote_delta),
  }));

  return {
    id: row.id,
    createdAt: row.created_at,
    provenance: {
      reserveAsset: reserve,
      target,
      clamped,
      clampReason: row.clamp_reason,
      intentReference,
      appliedReference,
      appliedReferenceDivergence: previous?.applied_divergence_cause ?? null,
      modelLegs,
      band,
      stopExits,
      gate,
    },
    sources: { clamped: journaled ? 'journal' : 'recomputed', modelPlan: 'recomputed' },
    bookedLedger,
    portfolioAfter: bookAfter(book, bookedLedger),
    summary: row.notification_summary ?? '',
  };
}

interface Rendered {
  id: number;
  text: string | null;
  origins: Record<string, MovementOrigin>;
  adjustments: Record<string, string[]>;
  revisions: string[];
}

function render(r: Rebuilt): Rendered {
  const result = {
    status: 'decided',
    row: { notification_summary: r.summary },
    execution: { bookedLedger: r.bookedLedger },
    portfolioAfter: r.portfolioAfter,
    provenance: r.provenance,
  } as unknown as DecideResult;
  const notification = prepareActivityNotification(result, r.createdAt);
  if (notification == null) return { id: r.id, text: null, origins: {}, adjustments: {}, revisions: [] };
  return {
    id: r.id,
    text: formatActivity(notification),
    origins: Object.fromEntries(notification.attribution.movements.map((m) => [m.asset, m.origin])),
    adjustments: Object.fromEntries(notification.attribution.movements.map((m) => [m.asset, m.adjustments.map((a) => a.layer)])),
    revisions: notification.attribution.revisions.map((v) => `${v.asset} ${v.fromPercent ?? 'ouvert'} → ${v.toPercent}`),
  };
}

interface Criterion {
  id: string;
  passed: boolean;
}
const results: Criterion[] = [];
function record(id: string, title: string, passed: boolean, detail: string[]): void {
  results.push({ id, passed });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

function printCycle(r: Rebuilt, rendered: Rendered): void {
  console.log('');
  console.log(`──── cycle ${r.id} · ${r.createdAt} ────`);
  console.log(`  sources : clamped=${r.sources.clamped}, model plan=${r.sources.modelPlan}, references=${r.provenance.intentReference ? 'previous decided row' : 'none'}`);
  console.log(`  model plan : ${r.provenance.modelLegs.map((l) => `${l.side} ${l.asset} ~${l.notional.toFixed(0)}$`).join(', ') || '(no leg above the floor)'}`);
  console.log(`  booked     : ${r.bookedLedger.map((e) => `${e.side} ${e.symbol} ${e.quoteDelta.abs().toFixed(2)}$`).join(', ') || '(nothing)'}`);
  if (rendered.text == null) {
    console.log('  notification : NONE (nothing booked)');
    return;
  }
  console.log(`  origins    : ${Object.entries(rendered.origins).map(([a, o]) => `${a}=${o}${(rendered.adjustments[a] ?? []).length ? `[${rendered.adjustments[a]!.join('+')}]` : ''}`).join(', ')}`);
  console.log('  ┌─ notification ─────────────────────────────────────────────');
  for (const line of rendered.text.split('\n')) console.log(`  │ ${line}`);
  console.log('  └────────────────────────────────────────────────────────────');
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('attribution replay: Supabase is not configured.');
  const requested = process.argv[2]?.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) ?? [];
  const ids = requested.length > 0 ? requested : [...WITNESSES, CONTROLS.fullyModel, CONTROLS.nothingBooked, ...CONTROLS.extras];

  console.log('ACTIVITY ATTRIBUTION — the notification each cycle would send under the new layout');
  console.log(`cycles: ${ids.join(', ')}`);

  const rebuilt = new Map<number, Rebuilt>();
  const rendered = new Map<number, Rendered>();
  for (const id of ids) {
    const r = await rebuild(supabase, id);
    if (r == null) {
      console.log(`\n──── cycle ${id}: not a decided cycle, skipped ────`);
      continue;
    }
    const out = render(r);
    rebuilt.set(id, r);
    rendered.set(id, out);
    printCycle(r, out);
  }

  if (requested.length > 0) {
    writeArtefact(OUT_DIR, 'attribution.json', { cycles: [...rebuilt.values()].map((r) => ({ ...r, rendered: rendered.get(r.id) })) });
    return;
  }

  const get = (id: number) => ({ r: rebuilt.get(id), o: rendered.get(id) });

  {
    const { o } = get(2051);
    const text = o?.text ?? '';
    record('A1', '2051 — the XRP sale is the stop\'s, not the model\'s hold', o != null && o.origins['XRP'] === 'stop' && text.includes('Vente ~142$ de XRP — stop de pic (code)') && text.includes('Modèle : maintien, aucune ligne révisée.') && text.includes("remplace l'intention du modèle (XRP 13 %)") && text.includes('Raisonnement du modèle : Maintien') && !text.includes('Pourquoi'), [
      `XRP origin = ${o?.origins['XRP']}`,
      'the model\'s "Maintien de toutes les positions" is labelled as its reasoning, under the stop line',
    ]);
  }
  {
    const { o } = get(2112);
    const text = o?.text ?? '';
    const all = ['BNB', 'ETH', 'XRP'].every((a) => o?.origins[a] === 'bande');
    record('A2', '2112 — the three buys are the band\'s; nothing is attributed to the model', o != null && all && !Object.values(o.origins).includes('modele') && text.includes('Modèle : maintien, aucune ligne révisée.') && text.includes('relevée au plancher 45 %'), [
      `origins = ${JSON.stringify(o?.origins)}`,
    ]);
  }
  {
    const { o } = get(2139);
    const text = o?.text ?? '';
    record('A3', '2139 — the ETH sale is the model\'s revision, resized by the band; BTC and XRP are the band\'s', o != null && o.origins['ETH'] === 'modele' && (o.adjustments['ETH'] ?? []).includes('bande') && o.origins['BTC'] === 'bande' && o.origins['XRP'] === 'bande' && text.includes("Vente ~60$ d'ETH — modèle, montant ajusté par la bande") && text.includes('Modèle : révision ETH 9 → 3 % (son plan initial aurait vendu ~66$ d\'ETH).'), [
      `origins = ${JSON.stringify(o?.origins)}, ETH adjustments = ${JSON.stringify(o?.adjustments['ETH'])}`,
    ]);
  }
  {
    const { o } = get(2141);
    const text = o?.text ?? '';
    record('A4', '2141 — a hold; the band moved its correction from XRP to BTC', o != null && o.origins['BTC'] === 'bande' && o.origins['XRP'] === 'bande_deplacement' && o.revisions.length === 0 && text.includes('Modèle : maintien, aucune ligne révisée.') && text.includes('XRP, porté à 15 % par la correction précédente, revient à la cible du modèle (13 %) — la bande porte désormais ses points sur BTC') && text.includes('relevée au plancher 45 % (consolidation) — BTC +6 pts'), [
      `origins = ${JSON.stringify(o?.origins)}`,
    ]);
  }
  {
    const { o } = get(CONTROLS.fullyModel);
    const text = o?.text ?? '';
    const origins = Object.values(o?.origins ?? {});
    record('A5', `${CONTROLS.fullyModel} — a cycle entirely decided by the model stays the model's`, o != null && origins.length > 0 && origins.every((x) => x === 'modele') && !text.includes('Bande :') && !text.includes('Stop de pic') && text.includes('Modèle : révision'), [
      `origins = ${JSON.stringify(o?.origins)}, revisions = ${JSON.stringify(o?.revisions)}`,
    ]);
  }
  {
    const { r, o } = get(CONTROLS.nothingBooked);
    record('A6', `${CONTROLS.nothingBooked} — a decided cycle with nothing booked sends nothing`, r != null && r.bookedLedger.length === 0 && o?.text == null, [
      `booked = ${r?.bookedLedger.length ?? 'n/a'}, notification = ${o?.text == null ? 'none' : 'PRESENT'}`,
    ]);
  }
  {
    // A resized decision keeps ONE origin and names the layer — never a merged "mixed".
    const eth = get(2139).o;
    const mixedFlattened = eth == null || eth.origins['ETH'] !== 'modele' || (eth.adjustments['ETH'] ?? []).length !== 1;
    const bnb2125 = get(2125).o;
    record('A7', 'a resized or mixed intervention is never flattened into a single fabricated origin', !mixedFlattened && bnb2125 != null && Object.keys(bnb2125.origins).length === 2 && new Set(Object.values(bnb2125.origins)).size >= 1, [
      `2139 ETH = ${eth?.origins['ETH']} + ${JSON.stringify(eth?.adjustments['ETH'])}`,
      `2125 = ${JSON.stringify(bnb2125?.origins)} (ETH: the model's trim resized by the band; BNB: a sub-floor revision the band lifted past the floor)`,
    ]);
  }
  {
    const unattributed = [...WITNESSES, CONTROLS.fullyModel].flatMap((id) => Object.entries(rendered.get(id)?.origins ?? {}).filter(([, o]) => o === 'non_etablie').map(([a]) => `${id}:${a}`));
    const extrasUnattributed = CONTROLS.extras.flatMap((id) => Object.entries(rendered.get(id)?.origins ?? {}).filter(([, o]) => o === 'non_etablie').map(([a]) => `${id}:${a}`));
    record('A8', 'every witness movement has a proven origin; the controls report theirs', unattributed.length === 0, [
      `witnesses non_etablie = ${unattributed.length === 0 ? 'none' : unattributed.join(', ')}`,
      `extras non_etablie = ${extrasUnattributed.length === 0 ? 'none' : extrasUnattributed.join(', ')}`,
    ]);
  }

  const written = writeArtefact(OUT_DIR, 'attribution.json', {
    generatedAt: new Date().toISOString(),
    cycles: [...rebuilt.values()].map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      sources: r.sources,
      provenance: r.provenance,
      booked: r.bookedLedger.map((e) => ({ symbol: e.symbol, side: e.side, usd: e.quoteDelta.abs().toNumber() })),
      rendered: rendered.get(r.id),
    })),
    criteria: results,
  });

  const failed = results.filter((c) => !c.passed);
  console.log('');
  console.log(`artefact: ${path.join(OUT_DIR, written.file)} (sha256 ${written.sha256})`);
  console.log(`${results.length - failed.length}/${results.length} criteria passed${failed.length ? ` — FAILED: ${failed.map((c) => c.id).join(', ')}` : ''}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exitCode = 1;
});
