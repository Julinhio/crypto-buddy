import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, tradableBaseAssets } from '../config/index.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { parseRegimeJournal, regimePointFromJournal } from '../market/regimeJournal.js';
import type { TransitionGate } from '../transition/gate.js';
import { observeBand, checkBarIntegrity, type BandObservationInsert } from '../exposure/observe.js';

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
      .select('id, created_at, status, regime, market_context, target_allocation, applied_allocation')
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

    const book = bookOf(decision.market_context);
    const gates = gatesByDecision.get(decision.id) ?? new Map<string, TransitionGate>();
    if (gates.size > 0) cyclesWithGates.push(decision.id);

    rows.push(
      observeBand({
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
      }),
    );
  }

  // ── C0 — the corpus is what we think it is ────────────────────────────────────────
  {
    const withRegime = rows.filter((r) => r.bar_at != null).length;
    const ok = malformed.length === 0 && rows.length === decisions.length;
    record('C0', 'le corpus est exploitable et aucun journal de régime n\'est corrompu', ok, [
      `${decisions.length} cycles v5 · ${Object.entries(statuses).map(([s, n]) => `${s}=${n}`).join(' · ')}.`,
      `${withRegime} portent un régime · ${rows.length - withRegime} n'en portent aucun (compté à part, jamais neutre).`,
      `${cyclesWithGates.length} portent une lecture de transition (la couche n'a démarré que le 08/08).`,
      malformed.length === 0
        ? 'Aucun journal de régime malformé.'
        : `MALFORMÉS : ${malformed.map((m) => `#${m.id} (${m.detail})`).join(' | ')}`,
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
