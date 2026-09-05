import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, tradableBaseAssets } from '../config/index.js';
import type { Decimal } from '../money.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { parseRegimeJournal, regimePointFromJournal } from '../market/regimeJournal.js';
import type { TransitionGate } from '../transition/gate.js';
import { observeBand, checkBarIntegrity, type BandObservationInsert } from '../exposure/observe.js';
import { correctToBand, type CorrectionOutcome } from '../exposure/correct.js';
import { bookOf as portfolioOf, pricesOf, type StoredContext } from './storedCycle.js';

/**
 * THE HISTORICAL BITE — the mandatory checkpoint of the pilot's first brick.
 *
 * It answers ONE question, on the real v5 history, without producing a single order:
 *
 *   > If band A had been in force, how often would it have intervened, in which direction,
 *   > by how much, in which context — and how often could it not have?
 *
 * It is a VERIFICATION THAT THE INTERVENTION MATCHES THE ANNOUNCED MECHANISM. It does not
 * select the policy on its historical performance. No return figure is produced here, and
 * none would be admissible: the protocol says so, and the code obeys by never computing one.
 *
 * ── WHY THIS IS AN UPPER BOUND, NOT A FORECAST ─────────────────────────────────────────
 *
 * Every cycle is judged where the bot ACTUALLY stood at that moment — a one-step
 * counterfactual, re-anchored on the real book at each wake-up, never chained. That is the
 * only honest way to read a history in which nothing ever corrected: the book kept falling
 * back below the floor because no correction had lifted it.
 *
 * In the pilot it will not behave that way. The first correction moves the target into the
 * band, the model re-emits a proposal in the same proportions, and the corrected target
 * lands in the same place — so the following cycles need little or nothing. The frequency
 * measured here is therefore a CEILING on the steady-state intervention rate, and it is
 * labelled as one everywhere it is printed. Anyone quoting it as "the band will correct N%
 * of cycles" is quoting it wrong.
 *
 * ── TWO POPULATIONS, DELIBERATELY NOT MERGED ───────────────────────────────────────────
 *
 * The transition layer only started journaling on 08/08, a fortnight into v5. Cycles before
 * it have no per-asset gate, so the FEASIBILITY question — what would the freezes have
 * allowed — simply has no answer for them. Feeding them into the same rate would report the
 * whole pre-08/08 stretch as "nothing was feasible", which is an artefact of the journal and
 * not a fact about the market. So the bite (direction and amplitude) is measured over every
 * cycle, and the feasibility over the cycles that carry a transition read, with both
 * denominators printed.
 *
 * Read-only and side-effect free: it reads `decisions` and `transition_observations`, writes
 * nothing to the database, and places nothing anywhere.
 *
 * Run with `npm run replay:band-bite`. Exits non-zero if any criterion fails.
 */

const OUT_DIR = path.join(process.cwd(), 'out', 'exposure-band-bite');
const HOURS_PER_BAR = 4;

interface DecisionRead {
  id: number;
  created_at: string;
  status: string;
  regime: unknown;
  market_context: unknown;
  target_allocation: unknown;
  applied_allocation: unknown;
  applied_divergence_cause: unknown;
}

interface GateRead {
  decision_id: number;
  asset: string;
  gate: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An allocation as persisted, or null when the column held nothing usable. */
function allocationOf(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const [asset, weight] of Object.entries(raw)) {
    if (typeof weight === 'number' && Number.isFinite(weight)) out[asset] = weight;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** The book that cycle was shown: its exposure, its equity, its reserve. */
function bookOf(ctx: unknown): { exposurePercent: number | null; equity: number; reserveAsset: string } {
  const portfolio = isRecord(ctx) && isRecord(ctx.account) ? ctx.account.portfolio : null;
  if (!isRecord(portfolio)) return { exposurePercent: null, equity: 0, reserveAsset: 'USDT' };
  const deployed = portfolio.deployedPercent;
  const equity = portfolio.equity;
  const reserve = portfolio.reserveAsset;
  return {
    exposurePercent: typeof deployed === 'number' && Number.isFinite(deployed) ? deployed : null,
    equity: typeof equity === 'number' && Number.isFinite(equity) ? equity : 0,
    reserveAsset: typeof reserve === 'string' && reserve !== '' ? reserve : 'USDT',
  };
}

const KNOWN_GATES: ReadonlySet<string> = new Set<TransitionGate>([
  'stop_exit',
  'risk_off_reduction',
  'frozen',
  'actionable',
  'no_regime',
]);

async function loadDecisions(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
): Promise<DecisionRead[]> {
  const PAGE = 500;
  const rows: DecisionRead[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('decisions')
      .select(
        'id, created_at, status, regime, market_context, target_allocation, applied_allocation, ' +
          'applied_divergence_cause',
      )
      .eq('prompt_version', 'v5')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`band bite: could not read decisions (${error.message}).`);
    const page = (data ?? []) as unknown as DecisionRead[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

async function loadGates(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
): Promise<Map<number, Map<string, TransitionGate>>> {
  const PAGE = 1000;
  const byDecision = new Map<number, Map<string, TransitionGate>>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('transition_observations')
      .select('decision_id, asset, gate')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`band bite: could not read transition_observations (${error.message}).`);
    const page = (data ?? []) as unknown as GateRead[];
    for (const row of page) {
      // AN UNKNOWN GATE IS REFUSED, never defaulted. The ladder's five labels are the whole
      // vocabulary of the freeze contract; a sixth one appearing here would mean the layer
      // and this replay have drifted, and quietly treating it as `actionable` would publish a
      // feasibility the freeze never granted.
      if (!KNOWN_GATES.has(row.gate)) {
        throw new Error(
          `band bite: transition_observations carries gate "${row.gate}" on decision ` +
            `${row.decision_id} (${row.asset}) — not one of the ladder's five labels. Refusing ` +
            'to guess what the correction would have been allowed to do.',
        );
      }
      const bucket = byDecision.get(row.decision_id) ?? new Map<string, TransitionGate>();
      bucket.set(row.asset, row.gate as TransitionGate);
      byDecision.set(row.decision_id, bucket);
    }
    if (page.length < PAGE) break;
  }
  return byDecision;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index]!.toFixed(2));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('band bite: Supabase is not configured.');

  const universe = tradableBaseAssets(config);
  const [decisions, gatesByDecision] = await Promise.all([loadDecisions(supabase), loadGates(supabase)]);

  console.log('='.repeat(96));
  console.log('MORSURE HISTORIQUE — bande A contre l\'historique v5 réel, aucun ordre produit');
  console.log(
    `Politique ${config.exposureBand.version} : défensif [${config.exposureBand.defensive.lowPercent}, ` +
      `${config.exposureBand.defensive.highPercent}] · neutre [${config.exposureBand.neutral.lowPercent}, ` +
      `${config.exposureBand.neutral.highPercent}] · constructif [${config.exposureBand.constructive.lowPercent}, ` +
      `${config.exposureBand.constructive.highPercent}]`,
  );
  console.log(`Corpus : ${decisions.length} cycles v5 (toutes statuts), ids ${decisions[0]?.id} → ${decisions[decisions.length - 1]?.id}.`);
  console.log('='.repeat(96));

  // ── Build one observation per cycle, through the SAME function the live cycle uses ────
  const rows: BandObservationInsert[] = [];
  const statuses: Record<string, number> = {};
  const malformed: Array<{ id: number; detail: string }> = [];
  const cyclesWithGates: number[] = [];
  /**
   * CYCLES WHOSE `applied_allocation` IS NOT THE PRE-GATE TARGET.
   *
   * The live observer assesses `clamp.applied` — the risk-clamped proposal, before the
   * transition gate has spoken. `applied_allocation` normally holds exactly that. It does NOT
   * on a cycle the gate REFUSED under `enforce`: clause 3 of `applyGate` stores the PREVIOUS
   * effective vector there instead, so the column describes last cycle's target.
   *
   * Feeding that to the assessment would report the wrong exposure, the wrong direction and
   * the wrong amplitude for those cycles — silently. And the pre-gate target is not
   * recoverable from the journal: re-running `clampAllocation` would apply TODAY's caps to a
   * historical proposal, which is a guess that happens to be right only while the caps have
   * not moved.
   *
   * So they are EXCLUDED and COUNTED, and C0 fails if there are any. Zero today — the corpus
   * ran entirely under `TRANSITION_MODE=observe` and no row carries a divergence cause — but
   * arming the gate is a planned step, and the day it happens this tool must stop rather than
   * publish a bite over a corpus it can no longer read correctly.
   */
  const postGateOnly: number[] = [];
  /** The redistribution, per cycle — keyed by decision so later criteria can walk it in order. */
  const corrections = new Map<number, CorrectionOutcome>();
  /**
   * THE VALUATION FRAME of each assessed cycle: its equity and its prices.
   *
   * A weight is only comparable to another weight measured against the same equity and the
   * same prices. C8 compares a holding created at one wake-up with a target proposed at the
   * next, and those are two different frames — so the frame travels with the cycle.
   */
  const frames = new Map<number, { equity: number; priceOf: (asset: string) => Decimal | null }>();

  for (const decision of decisions) {
    statuses[decision.status] = (statuses[decision.status] ?? 0) + 1;

    let point = null;
    try {
      const journal = parseRegimeJournal(decision.regime);
      point = journal == null ? null : regimePointFromJournal(journal);
    } catch (err) {
      // A PRESENT but malformed journal is a drift between what the bot writes and what this
      // reads. It is named and it fails the run, never degraded to "no context" — that would
      // hide the very defect it should be shouting about.
      malformed.push({ id: decision.id, detail: err instanceof Error ? err.message : String(err) });
      continue;
    }

    if (decision.applied_divergence_cause != null) {
      postGateOnly.push(decision.id);
      continue;
    }

    const book = bookOf(decision.market_context);
    const gates = gatesByDecision.get(decision.id) ?? new Map<string, TransitionGate>();
    if (gates.size > 0) cyclesWithGates.push(decision.id);

    const observation = observeBand({
        decisionId: decision.id,
        mode: 'observation',
        policyVersion: config.exposureBand.version,
        policy: config.exposureBand,
        regimePoint: point,
        universe,
        // The RISK-CLAMPED target, which is what the correction will act on. It has never
        // diverged from the proposal on this corpus — `clamped` is false on all 884 rows —
        // but the column is the fact and the recomputation would be a guess.
        targetAllocation: allocationOf(decision.applied_allocation),
        rawAllocation: allocationOf(decision.target_allocation),
        bookExposurePercent: book.exposurePercent,
        reserveAsset: book.reserveAsset,
        gateByAsset: gates,
        capOf: (asset) => config.execution.caps.perAsset[asset] ?? config.execution.caps.defaultPerAsset,
        maxDeployablePercent: 100 - config.execution.caps.minCashPercent,
        equityQuote: book.equity,
        movementFloorQuote: (book.equity * config.execution.minMovementPercent) / 100,
      // The corpus ran entirely under TRANSITION_MODE=observe — zero rows carry an
      // `applied_divergence_cause`, so no peak stop ever generated an exit. A stopped line
      // therefore kept its weight, and that is what the replay reproduces.
      stoppedWeightSurvives: true,
    });

    /**
     * THE REDISTRIBUTION, on the same cycle — which settles brick 1's open caveat.
     *
     * Brick 1 could only say whether the correction's TOTAL cleared one movement floor, and
     * had to label that "necessary, not sufficient": split across four lines, a total worth
     * two and a half floors still yields four sub-floor legs and nothing sent. Only the
     * redistribution knows, and it exists now.
     *
     * The book comes from `storedCycle.ts` — production's own reconstruction, shared with the
     * coherence replay. A second one built here would eventually disagree with it about the
     * very quantity every leg is sized against.
     */
    let correction: CorrectionOutcome | null = null;
    if (observation.assessment != null) {
      const ctx = decision.market_context as StoredContext;
      correction = correctToBand({
        assessment: observation.assessment,
        clampedAllocation: allocationOf(decision.applied_allocation)!,
        rawAllocation: allocationOf(decision.target_allocation),
        reserveAsset: book.reserveAsset,
        portfolio: portfolioOf(ctx),
        priceOf: pricesOf(ctx),
        feePercent: config.execution.feePercent,
        minMovementPercent: config.execution.minMovementPercent,
      });
      observation.row.corrected_exposure_percent = correction.correctedExposurePercent;
      observation.row.realised_exposure_percent = correction.realisedExposurePercent;
      observation.row.realised_gap_points = correction.unrealisablePoints;
      observation.row.consolidated = correction.consolidated;
      observation.row.consolidation_rounds = correction.consolidationRounds;
      observation.row.consolidation_attempts = correction.consolidationAttempts;
      observation.row.planned_movements = correction.movements.length;
      observation.row.suppressed_movements = correction.suppressed.length;
      observation.row.label = correction.label;
      corrections.set(decision.id, correction);
      frames.set(decision.id, { equity: book.equity, priceOf: pricesOf(ctx) });
    }
    rows.push(observation.row);
  }

  // ── C0 — the corpus is what we think it is ────────────────────────────────────────
  {
    const withRegime = rows.filter((r) => r.bar_at != null).length;
    const ok =
      malformed.length === 0 && postGateOnly.length === 0 && rows.length === decisions.length;
    record('C0', 'le corpus est exploitable et aucun journal de régime n\'est corrompu', ok, [
      `${decisions.length} cycles v5 · ${Object.entries(statuses).map(([s, n]) => `${s}=${n}`).join(' · ')}.`,
      `${withRegime} portent un régime · ${rows.length - withRegime} n'en portent aucun (compté à part, jamais neutre).`,
      `${cyclesWithGates.length} portent une lecture de transition (la couche n'a démarré que le 08/08).`,
      malformed.length === 0
        ? 'Aucun journal de régime malformé.'
        : `MALFORMÉS : ${malformed.map((m) => `#${m.id} (${m.detail})`).join(' | ')}`,
      postGateOnly.length === 0
        ? "Aucun cycle ne porte d'applied_divergence_cause : sur tout le corpus, " +
          "applied_allocation EST la cible pré-porte que l'observateur vivant évalue."
        : `EXCLUS — ${postGateOnly.length} cycle(s) refusés par la porte ` +
          `(${postGateOnly.join(', ')}) : leur applied_allocation porte le vecteur du cycle ` +
          "PRÉCÉDENT, pas la cible pré-porte. La cible réelle n'est pas récupérable (rejouer le " +
          "clamp appliquerait les plafonds D'AUJOURD'HUI à une proposition historique), donc ils " +
          "sont écartés et ce critère ÉCHOUE : mieux vaut pas de morsure qu'une morsure sur un " +
          'corpus mal lu.',
    ]);
  }

  // ── C1 — THE PER-BAR CONTEXT INTEGRITY CHECK, on the real history ─────────────────
  //
  // The closure protocol makes the FIRST cycle of a bar the unit of analysis. That is only
  // sound if the other wake-ups of the same bar agree with it: a first cycle masking a
  // disagreement would let the pilot count a bar in one family while the bot spent most of
  // it in the other. This is the check the protocol requires to fail loudly, and it does.
  {
    const findings = checkBarIntegrity(rows);
    const bars = new Set(rows.filter((r) => r.bar_at != null).map((r) => r.bar_at)).size;
    record('C1', 'deux cycles d\'une même bougie 4h portent le même contexte', findings.length === 0, [
      `${bars} bougies · ${rows.filter((r) => r.context_fingerprint != null).length} cycles avec contexte.`,
      findings.length === 0
        ? 'Aucune bougie instable. Le premier cycle d\'une bougie peut servir d\'unité d\'analyse.'
        : `INSTABLES : ${findings
            .map((f) => `${f.barAt} (cycles ${f.decisionIds.join(', ')} — ${f.fingerprints.length} variantes)`)
            .join(' | ')}`,
    ]);
  }

  // ── The bar-level population: one observation per bar, the FIRST cycle ────────────
  const byBar = new Map<string, BandObservationInsert[]>();
  for (const row of rows) {
    if (row.bar_at == null) continue;
    const bucket = byBar.get(row.bar_at) ?? [];
    bucket.push(row);
    byBar.set(row.bar_at, bucket);
  }
  const barKeys = [...byBar.keys()].sort();
  const firstPerBar = barKeys.map((key) => byBar.get(key)!.sort((a, b) => a.decision_id - b.decision_id)[0]!);

  // ── C2 — COVERAGE: the two families, and the defensive count published apart ──────
  {
    const counts: Record<string, number> = { constructive: 0, neutral: 0, defensive: 0 };
    let withoutContext = 0;
    for (const row of firstPerBar) {
      if (row.state == null) withoutContext += 1;
      else counts[row.state] = (counts[row.state] ?? 0) + 1;
    }
    const nonConstructive = counts.neutral! + counts.defensive!;
    record('C2', 'la couverture de contexte, par bougie, familles publiées séparément', true, [
      `${barKeys.length} bougies 4h · constructive=${counts.constructive} · non_constructive=${nonConstructive} ` +
        `(neutral=${counts.neutral}, defensive=${counts.defensive}).`,
      `${withoutContext} bougie(s) sans contexte exploitable — comptée(s) à part, jamais neutre.`,
      counts.defensive === 0
        ? 'AUCUN contexte défensif sur tout l\'historique v5 : risk_off n\'a jamais été confirmé depuis le ' +
          '25/07. Le barreau [0, 20] est une limite de couverture à rapporter, pas une raison de bouger la bande.'
        : `Le barreau défensif a été exercé sur ${counts.defensive} bougie(s).`,
      'Rappel : le protocole de fermeture demande 84 bougies valides dans CHACUNE des deux familles.',
    ]);
  }

  // ── C3 — THE BITE ITSELF: how often, which way, by how much ───────────────────────
  const assessed = rows.filter((r) => r.label != null);
  {
    const byState = new Map<string, BandObservationInsert[]>();
    for (const row of assessed) {
      const bucket = byState.get(row.state!) ?? [];
      bucket.push(row);
      byState.set(row.state!, bucket);
    }

    const detail: string[] = [
      `Population : ${assessed.length} cycles portant à la fois un contexte et une cible retenue ` +
        `(sur ${rows.length} cycles v5).`,
      'BORNE HAUTE, PAS UNE PRÉVISION : contrefactuel à un pas ré-ancré sur le livre réel à chaque ' +
        'réveil, sur une histoire où rien n\'a jamais corrigé. En pilote, la première correction met ' +
        'la cible dans la bande et les cycles suivants ne corrigent presque plus.',
      '',
    ];
    for (const state of ['constructive', 'neutral', 'defensive'] as const) {
      const inState = byState.get(state) ?? [];
      if (inState.length === 0) {
        detail.push(`${state.padEnd(13)} — aucun cycle.`);
        continue;
      }
      const up = inState.filter((r) => r.direction === 'up');
      const down = inState.filter((r) => r.direction === 'down');
      const inside = inState.filter((r) => r.direction === 'none');
      const upPoints = up.map((r) => r.required_points!);
      const downPoints = down.map((r) => r.required_points!);
      detail.push(
        `${state.padEnd(13)} — ${inState.length} cycles · ↑plancher ${up.length} · ↓plafond ${down.length} · ` +
          `dans la bande ${inside.length}`,
      );
      if (up.length > 0) {
        detail.push(
          `                 amplitude ↑ : moyenne ${mean(upPoints)} pt · médiane ${percentile(upPoints, 50)} · ` +
            `p90 ${percentile(upPoints, 90)} · max ${percentile(upPoints, 100)}`,
        );
      }
      if (down.length > 0) {
        detail.push(
          `                 amplitude ↓ : moyenne ${mean(downPoints)} pt · médiane ${percentile(downPoints, 50)} · ` +
            `p90 ${percentile(downPoints, 90)} · max ${percentile(downPoints, 100)}`,
        );
      }
    }
    const corrected = assessed.filter((r) => r.direction !== 'none').length;
    detail.push('');
    detail.push(
      `TOTAL : ${corrected} / ${assessed.length} cycles auraient reçu une correction ` +
        `(${((corrected / Math.max(assessed.length, 1)) * 100).toFixed(1)} %).`,
    );
    const constructiveCeiling = (byState.get('constructive') ?? []).filter((r) => r.direction === 'down').length;
    detail.push(
      `Le plafond constructif (${config.exposureBand.constructive.highPercent} %) est STRUCTURELLEMENT ` +
        `redondant avec le plancher de cash de ${config.execution.caps.minCashPercent} % : l'exposition ne ` +
        `peut de toute façon pas dépasser ${100 - config.execution.caps.minCashPercent} %. ` +
        `${constructiveCeiling} correction(s) vers ce plafond — lire zéro ici ne prouve rien sur la politique.`,
    );
    record('C3', 'la morsure : fréquence, sens et amplitude, par contexte', true, detail);
  }

  // ── C4 — FEASIBILITY: what the freezes and the caps actually allow ────────────────
  //
  // Arbitrated: the code may not create an order on a line the transition layer calls frozen,
  // whatever TRANSITION_MODE says. This measures the price of that rule, and it is not a
  // rounding error.
  {
    // THE ROW SAYS SO ITSELF. Filtering on `gatesByDecision` here would be a second, parallel
    // definition of "did this cycle have verdicts", and the day the two disagreed the report
    // would describe a population the rows do not belong to. `feasibility_known` is written by
    // the same function the live cycle uses.
    const withGates = assessed.filter((r) => r.feasibility_known === true);
    const corrections = withGates.filter((r) => r.direction !== 'none');
    const partial = corrections.filter((r) => r.label === 'bande_partiellement_irrealisable');
    const totallyBlocked = corrections.filter((r) => r.unrealisable_points === r.required_points);
    const noActionable = withGates.filter((r) => r.increasable_assets.length === 0);
    // TWO DIFFERENT REASONS a correction produces nothing, deliberately not merged. A
    // correction blocked by the freezes had nothing feasible to send; one under the movement
    // floor was feasible and too small to be worth sending. Reporting them as one number
    // would let the plumbing take the blame for the freeze contract, or the reverse.
    const inertByBlock = corrections.filter((r) => r.unrealisable_points === r.required_points);
    const inertByFloor = corrections.filter(
      (r) => r.clears_movement_floor === false && r.unrealisable_points !== r.required_points,
    );
    const shortfalls = partial.map((r) => r.unrealisable_points!);

    const detail: string[] = [
      `Population : ${withGates.length} cycles portant une lecture de transition ` +
        `(sur ${assessed.length} évalués — la couche n'a démarré que le 08/08, et un cycle sans ` +
        'verdict ne peut pas répondre à cette question).',
      `Sur ${corrections.length} corrections dues : ${partial.length} ` +
        `(${((partial.length / Math.max(corrections.length, 1)) * 100).toFixed(1)} %) sont ` +
        `PARTIELLEMENT IRRÉALISABLES et ${totallyBlocked.length} le sont totalement.`,
      shortfalls.length > 0
        ? `Écart journalisé : moyenne ${mean(shortfalls)} pt · médiane ${percentile(shortfalls, 50)} · ` +
          `max ${percentile(shortfalls, 100)}.`
        : 'Aucun écart : chaque correction due était intégralement atteignable.',
      `${noActionable.length} cycle(s) n'ont AUCUNE ligne que la correction pourrait augmenter.`,
      `Corrections certainement inertes : ${inertByBlock.length} parce que les gels ne laissaient ` +
        `rien de faisable, ${inertByFloor.length} parce que le mouvement restait sous le seuil de ` +
        `${config.execution.minMovementPercent} %. Deux causes distinctes, jamais additionnées — ` +
        'sinon la plomberie porterait le chapeau du contrat de gel, ou l\'inverse.',
      'Au-dessus du seuil, rien n\'est acquis : répartie en jambes, une correction peut encore être ' +
        'entièrement supprimée. Cela se tranche à la brique 2, pas ici.',
      '',
      'Ce n\'est pas un cas limite : le chemin « maximum faisable exécuté, écart journalisé » du contrat ' +
        'de préséance est un chemin ordinaire, pas une branche défensive.',
    ];
    record('C4', 'la faisabilité : ce que les gels et les plafonds laissent réellement atteindre', true, detail);
  }

  // ── C5 — CONTEXT CHANGES, and where the corrections sit relative to them ──────────
  {
    const changes: Array<{ at: string; from: string; to: string }> = [];
    let previous: string | null = null;
    const barState = new Map<string, string | null>();
    for (const row of firstPerBar) {
      barState.set(row.bar_at!, row.state);
      if (row.state == null) continue;
      if (previous != null && previous !== row.state) {
        changes.push({ at: row.bar_at!, from: previous, to: row.state });
      }
      previous = row.state;
    }

    // A correction on the FIRST bar after a change is the band reacting to the change; one
    // later is the band holding a position the model keeps refusing to take. The two are
    // different behaviours and the checkpoint has to be able to tell them apart.
    const changeBars = new Set(changes.map((c) => c.at));
    const correctedBars = new Set(
      firstPerBar.filter((r) => r.direction != null && r.direction !== 'none').map((r) => r.bar_at!),
    );
    const onChange = [...correctedBars].filter((b) => changeBars.has(b)).length;

    record('C5', 'les changements de contexte concernés', true, [
      `${changes.length} changement(s) d'état de contexte sur ${barKeys.length} bougies.`,
      changes.length === 0
        ? 'Aucun.'
        : `Transitions : ${[...new Set(changes.map((c) => `${c.from}→${c.to}`))]
            .map((k) => `${k} ×${changes.filter((c) => `${c.from}→${c.to}` === k).length}`)
            .join(' · ')}.`,
      `${correctedBars.size} bougie(s) auraient reçu une correction, dont ${onChange} sur la bougie même ` +
        'du changement de contexte — le reste est la bande tenant une position que le modèle continue de ' +
        'ne pas prendre, ce qui est le comportement que le pilote existe pour observer.',
    ]);
  }

  // ── C6 — DWELL: the time the portfolio would have spent at each level ─────────────
  //
  // Per BAR, never per cycle: the bot wakes three to seven times inside one 4h bar, and
  // counting cycles would weight a bar by how often the scheduler happened to fire. And per
  // bar it is a re-anchored one-step measure, not a trajectory — nothing here is chained.
  {
    const buckets: Array<{ label: string; test: (v: number) => boolean }> = [
      { label: '[0, 20)', test: (v) => v < 20 },
      { label: '[20, 45)', test: (v) => v >= 20 && v < 45 },
      { label: '[45, 70]', test: (v) => v >= 45 && v <= 70 },
      { label: '> 70', test: (v) => v > 70 },
    ];
    const tally = (values: number[]): string =>
      buckets
        .map((b) => {
          const n = values.filter(b.test).length;
          return `${b.label} ${n} bougies (${(n * HOURS_PER_BAR).toFixed(0)} h)`;
        })
        .join(' · ');

    // THE SAME BARS ON BOTH LINES, or the comparison is not one. Only the bars whose first
    // cycle carries BOTH readings qualify: a bar with no transition verdict has a real target
    // and no feasible one, and averaging 240 observed values against 158 banded ones would
    // put a difference of populations where a reader expects a difference of policies.
    const paired = firstPerBar.filter(
      (r) => r.target_exposure_percent != null && r.attainable_exposure_percent != null,
    );
    const observedBars = paired.map((r) => r.target_exposure_percent!);
    const bandedBars = paired.map((r) => r.attainable_exposure_percent!);
    const barsWithoutFeasibility = firstPerBar.filter(
      (r) => r.target_exposure_percent != null && r.attainable_exposure_percent == null,
    ).length;

    record('C6', 'le temps que le portefeuille aurait passé à chaque niveau', true, [
      `Population : ${paired.length} bougies portant les DEUX lectures. ${barsWithoutFeasibility} ` +
        'bougie(s) ont une cible réelle mais aucune faisabilité (avant le 08/08) et sont exclues ' +
        'des deux lignes — sinon l\'écart mesurerait une différence de population.',
      `Cible RÉELLEMENT retenue    : ${tally(observedBars)}`,
      `Cible SOUS BANDE (faisable) : ${tally(bandedBars)}`,
      `Moyenne : réelle ${mean(observedBars)} % · sous bande ${mean(bandedBars)} % ` +
        `(+${(mean(bandedBars)! - mean(observedBars)!).toFixed(2)} pt).`,
      'Par BOUGIE, jamais par cycle : le bot se réveille 3 à 7 fois dans une même bougie 4h et les ' +
        'compter séparément pondérerait une bougie par la fréquence du scheduler.',
      'Mesure ré-ancrée à un pas, PAS une trajectoire : rien n\'est chaîné d\'une bougie à la suivante, ' +
        'donc aucun rendement ni aucun drawdown ne peut en être tiré — et aucun n\'est calculé ici.',
    ]);
  }

  // ── C7 — THE REDISTRIBUTION: what the correction would actually SEND ─────────────
  //
  // This is the question brick 1 could not answer and had to label "necessary, not
  // sufficient". A correction whose total clears one movement floor can still be deleted
  // entirely once it is split into legs, and only §3.5's redistribution knows which.
  {
    // ON THE DIRECTION, NOT ON THE LABEL — the same predicate C4 uses.
    //
    // Since the band started measuring the gap on in-band targets too, a cycle where the band
    // corrected NOTHING can carry `bande_partiellement_irrealisable`: the model's own
    // target-to-book move fell under the floor and left the book outside the band. That is a
    // real fact and it belongs in the journal — but it is not a band correction, and counting
    // it here would put ordinary model movements in "what the correction would send". Those
    // rows also carry a null `unrealisable_points` (the assessment computes none when no
    // correction is due), which the subtraction below would read as zero and charge the whole
    // gap to the plumbing.
    const withCorrection = rows
      .filter((r) => r.direction != null && r.direction !== 'none')
      .map((r) => ({ row: r, correction: corrections.get(r.decision_id)! }))
      .filter((entry) => entry.correction != null);

    // ONE POPULATION FOR THE WHOLE CRITERION: the corrections whose feasibility is knowable.
    //
    // On the fortnight of v5 that predates the transition layer there are no per-asset
    // verdicts, so `correctToBand` sees every line as frozen and moves nothing. That is an
    // artefact of the journal, not a fact about the redistribution — and folding those cycles
    // into "N corrections produce no movement" would blame the 2% floor for a missing column.
    const comparable = withCorrection.filter((e) => e.row.feasibility_known === true);
    const excluded = withCorrection.length - comparable.length;

    const moves = comparable.filter((e) => e.correction.movements.length > 0);
    const inert = comparable.filter((e) => e.correction.movements.length === 0);
    const consolidated = comparable.filter((e) => e.correction.consolidated);
    const rescued = comparable.filter((e) =>
      e.correction.lines.some((l) => l.origin === 'allocation_de_secours'),
    );
    const legs = comparable.reduce((sum, e) => sum + e.correction.movements.length, 0);
    const suppressedLegs = comparable.reduce((sum, e) => sum + e.correction.suppressed.length, 0);

    // THE TWO GAPS. `unrealisable_points` counts only the freezes and the caps; the
    // correction's own counts the plumbing too. Their difference is the movement floor's share,
    // and it is only derivable because the two are never merged into one column.
    const freezeGap = comparable.map((e) => e.row.unrealisable_points!);
    const realisedGap = comparable.map((e) => e.correction.unrealisablePoints);
    const plumbingShare = comparable
      .map((e) => e.correction.unrealisablePoints - e.row.unrealisable_points!)
      .filter((v) => v > 0.000001);

    record('C7', 'la répartition : ce que la correction enverrait réellement', true, [
      `Population : ${comparable.length} corrections portant une lecture de transition. ` +
        `${excluded} exclue(s) — sans verdict par actif, le correcteur ne peut rien bouger, et ` +
        'compter ça comme une correction inerte imputerait au seuil de 2 % une colonne manquante.',
      `${moves.length} produisent au moins un mouvement ` +
        `(${((moves.length / Math.max(comparable.length, 1)) * 100).toFixed(1)} %), ` +
        `${inert.length} n'en produisent AUCUN une fois le seuil passé.`,
      `${legs} jambes envoyées, ${suppressedLegs} effacées par le seuil.`,
      `Consolidation (§3.5.5) : elle change le résultat sur ${consolidated.length} cycle(s).`,
      `Allocation de secours (§3.5.4) : ${rescued.length} cycle(s) posent du poids sur une ligne où le ` +
        'modèle n\'avait RIEN dit — sa conviction ne suffisait pas à atteindre le plancher.',
      '',
      'Décomposition de l\'écart :',
      `  écart dû aux GELS et PLAFONDS  : moyenne ${mean(freezeGap)} pt`,
      `  écart après la PLOMBERIE aussi : moyenne ${mean(realisedGap)} pt`,
      `  ${plumbingShare.length} cycle(s) où le seuil de mouvement AGGRAVE l'écart, de ` +
        `${mean(plumbingShare)} pt en moyenne.`,
      '',
      'C\'est la réponse à la réserve de la brique 1 : « au-dessus du seuil » ne garantissait rien, ' +
        'et voici ce que la répartition en fait réellement.',
    ]);
  }

  // ── C8 — LE MODÈLE UTILISE-T-IL L'EXPOSITION IMPOSÉE, OU LUTTE-T-IL CONTRE ? ─────
  //
  // Demandé explicitement. CONTREFACTUEL, et il faut le dire fort : sur cet historique rien
  // n'a jamais été corrigé, donc le modèle n'a jamais VU une position que le correcteur aurait
  // créée. Ce que ce compteur mesure, c'est « si elle avait existé, le modèle aurait-il demandé
  // de la défaire », lu sur ce qu'il a réellement proposé au réveil suivant.
  //
  // Trois lectures, parce qu'une seule serait trompeuse. « Le modèle demande moins que la
  // position imposée » est presque automatique — il ré-émet sa propre préférence. Ce qui
  // distingue l'indifférence de la lutte, c'est qu'il descende PLUS BAS qu'il n'était descendu
  // lui-même, et ce qui distingue l'adoption, c'est qu'il monte au niveau imposé.
  {
    const ordered = [...corrections.entries()].sort((a, b) => a[0] - b[0]);
    let undoRequested = 0;
    let undoIntensified = 0;
    let adopted = 0;
    let observedPairs = 0;

    let unrevaluable = 0;
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const [currentId, current] = ordered[i]!;
      const [nextId, next] = ordered[i + 1]!;
      const nextRaw = new Map(next.lines.map((l) => [l.asset, l.rawWeightPercent ?? l.clampedWeightPercent]));
      const here = frames.get(currentId);
      const there = frames.get(nextId);
      for (const line of current.lines) {
        // Only lines the corrector actually LIFTED — a trim or an untouched line is not a
        // position the correction created.
        if (line.correctionPoints <= 0) continue;
        // AND ONLY WHERE IT ACTUALLY CREATED SOMETHING. A lifted target is not a position: on
        // a $1000 book, raising a neutral target from 19 to 20 produces a $10 leg the $20 floor
        // deletes, and the line finishes exactly where it started. Counting the next 19%
        // proposal as "the model undoing an imposed position" would be counting the undoing of
        // a position that never existed — and those inert rows would inflate the denominator
        // and drag all three published rates toward whatever they happen to look like.
        //
        // `correctionMovesHolding` compares the holdings of two EXECUTABLE plans, corrected
        // and uncorrected, rather than their targets.
        if (!line.correctionMovesHolding) continue;
        const raw = nextRaw.get(line.asset);
        if (raw == null) continue;

        // ── ONE FRAME, OR NO COMPARISON ────────────────────────────────────────────────
        //
        // `realisedWeightPercent` is the imposed holding as a percentage of the equity at THIS
        // wake-up, valued at THIS wake-up's prices. `raw` is a percentage at the NEXT one.
        // Comparing them directly inverts the verdict whenever the asset moves: a 20% imposed
        // holding that appreciates to 25% would read as "adopted" against a next target of 24%,
        // which is in fact a trim.
        //
        // So the holding is carried as a QUANTITY and revalued in the next cycle's frame. The
        // equity used there is the REAL bot's, not a corrected bot's — the same one-step
        // re-anchoring the whole replay rests on, and the same approximation PR #37's snapshot
        // documents. A cycle whose frame cannot be read is COUNTED APART rather than compared
        // in a frame nobody can vouch for.
        const priceHere = here?.priceOf(line.asset) ?? null;
        const priceThere = there?.priceOf(line.asset) ?? null;
        if (
          here == null ||
          there == null ||
          priceHere == null ||
          priceThere == null ||
          !priceHere.gt(0) ||
          !(there.equity > 0)
        ) {
          unrevaluable += 1;
          continue;
        }
        // The quantity the correction would have created, then what it is worth next time.
        const postEquityHere = here.equity * (1 - current.feeDragPoints / 100);
        const valueHere = (line.realisedWeightPercent / 100) * postEquityHere;
        const quantity = valueHere / priceHere.toNumber();
        const imposedThere = ((quantity * priceThere.toNumber()) / there.equity) * 100;

        observedPairs += 1;
        if (raw >= imposedThere - 0.000001) adopted += 1;
        else {
          undoRequested += 1;
          if (raw < line.baseWeightPercent - 0.000001) undoIntensified += 1;
        }
      }
    }

    const pct = (n: number): string =>
      `${n} (${((n / Math.max(observedPairs, 1)) * 100).toFixed(1)} %)`;
    record('C8', "le modèle utiliserait-il l'exposition imposée, ou lutterait-il contre", true, [
      'CONTREFACTUEL. Rien n\'a jamais été corrigé sur cet historique, donc le modèle n\'a jamais ' +
        'vu ces positions. Le compteur lit ce qu\'il a RÉELLEMENT proposé au réveil suivant, face ' +
        'à une position que le correcteur aurait créée au précédent.',
      `${observedPairs} paires observées — une ligne dont la correction change RÉELLEMENT ` +
        "l'avoir, et le réveil suivant. Une cible liftée dont la jambe passe sous le seuil ne " +
        'crée aucune position, donc ne peut pas être défaite : elle est écartée du dénominateur.',
      `La position imposée est portée comme une QUANTITÉ et revalorisée aux prix et à l'équité du ` +
        `réveil suivant : un poids d'un cycle et une cible du suivant ne sont pas dans le même ` +
        `cadre, et les comparer inverse le verdict dès que l'actif bouge. ${unrevaluable} paire(s) ` +
        `dont le cadre est illisible sont comptées à part plutôt que comparées.`,
      `ADOPTÉE   — le modèle demande au moins autant que la position imposée : ${pct(adopted)}`,
      `DÉFAITE   — il demande moins : ${pct(undoRequested)}`,
      `  dont LUTTE — il descend plus bas que sa propre cible précédente : ${pct(undoIntensified)}`,
      '',
      'La lecture qui compte est la troisième. « Demander moins que la position imposée » est ' +
        'presque automatique : le modèle ré-émet sa préférence. Descendre plus bas qu\'il n\'était ' +
        'descendu lui-même est en revanche un mouvement actif contre la correction.',
    ]);
  }

  // ── The artefact ─────────────────────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const artefact = path.join(OUT_DIR, 'bite.json');
  writeFileSync(
    artefact,
    `${JSON.stringify(
      {
        policy: config.exposureBand,
        caps: config.execution.caps,
        corpus: { cycles: decisions.length, statuses, bars: barKeys.length },
        contract: {
          not_measured: [
            'aucun rendement, aucun drawdown, aucune performance — ni attendus ni recevables ici',
            'la fréquence mesurée est une BORNE HAUTE ré-ancrée, pas une prévision du pilote',
            'aucune politique n\'est sélectionnée sur ce rejeu',
          ],
        },
        rows,
      },
      null,
      2,
    )}\n`,
  );

  console.log('');
  console.log('='.repeat(96));
  const failed = results.filter((r) => !r.passed);
  console.log(`Artefact : ${path.relative(process.cwd(), artefact)} (non commité)`);
  console.log(
    failed.length === 0
      ? `Tous les ${results.length} critères passent.`
      : `${failed.length} critère(s) en échec : ${failed.map((r) => r.id).join(', ')}`,
  );
  console.log(
    'AUCUN ORDRE, AUCUNE ÉCRITURE EN BASE. Ce rejeu vérifie que l\'intervention correspond au ' +
      'mécanisme annoncé ; il ne sélectionne aucune politique sur sa performance historique.',
  );
  console.log('='.repeat(96));
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
