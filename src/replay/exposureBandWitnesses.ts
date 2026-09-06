import 'dotenv/config';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config, tradableBaseAssets } from '../config/index.js';
import { dec } from '../money.js';
import { getSupabaseClient } from '../persistence/supabase.js';
import { parseRegimeJournal, regimePointFromJournal } from '../market/regimeJournal.js';
import { readContext, type ControllerReading } from '../calibration/exposure/controller.js';
import type { TransitionGate } from '../transition/gate.js';
import { assessBand, bandOf } from '../exposure/band.js';
import { correctToBand } from '../exposure/correct.js';
import {
  equalWeightUnderCaps,
  openBook,
  valueBook,
  stepWitness,
  witnessRow,
  type WitnessBook,
  type WitnessRow,
} from '../exposure/witness.js';
import { canonicalJson, sha256Of, writeArtefact } from '../provenance/artefacts.js';
import { bookOf as portfolioOf, pricesOf, type StoredContext } from './storedCycle.js';

/**
 * THE WITNESSES, REPLAYED — brick 3 of the constrained-exposure pilot.
 *
 * Offline and read-only. It reads `decisions`, `transition_observations` and
 * `equity_snapshots`, writes nothing to the database, and places nothing anywhere. The choice
 * of an offline reconstruction over an online one was the second framing answer of this
 * chantier: the data needed to rebuild both witnesses is already journaled, and an online
 * writer would add a failure mode inside the trading cycle for something that is not a
 * decision. What this run must therefore prove, per §6, is exactly that — that every input is
 * durably there, and that the reconstruction is reproducible.
 *
 * ── THREE CHAINED BOOKS, AND ONLY TWO OF THEM ARE WITNESSES ────────────────────────────
 *
 *   E   reproduces the bot's REAL total exposure, equally weighted under the per-asset caps
 *       with the excess redistributed (arbitrated: the exposure is the priority, equal
 *       weighting comes second).
 *   P   stays at the CURRENT BAND'S FLOOR, same weighting rule. It publishes its theoretical
 *       target, its attainable exposure and its gap to the floor, so nobody compares a
 *       constrained bot to a witness assumed perfect.
 *   B̂   the CORRECTED BOT. Not a witness: it is the bot itself under the band correction, and
 *       it exists to answer C7 — what the redistribution would really send, cycle after cycle,
 *       instead of one step at a time from a book that had never been corrected.
 *
 * E and P bear their own execution plumbing and NOT the bot's freezes; B̂ bears both, because
 * the corrector's rule is that the code never creates an order on a frozen line.
 *
 * ── WHAT B̂ ASSUMES, SAID OUT LOUD ──────────────────────────────────────────────────────
 *
 * B̂ replays the model's HISTORICAL answers against a book the model never saw. It therefore
 * measures the MECHANICAL CONSEQUENCE OF THE CORRECTION UNDER FROZEN HISTORICAL DECISIONS.
 *
 * It is NOT a simulation of how the model would have reacted, and it is NOT a bound of any
 * kind on performance — neither high nor low. Anyone reading B̂ as "what the pilot will do" is
 * reading it wrong, and the artefact says so in its own contract block.
 *
 * ── AND WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────
 *
 * No return, no drawdown, no bot-versus-witness delta. §7 keeps intermediate readings
 * descriptive, and the pilot's clock starts when `application` is armed — not now. C8, "does
 * the model use or fight the imposed exposure", gets its reader built and its data kept, and
 * NO figure: the question asks what the model does when it sees a corrected position, and in
 * observation mode it never saw one.
 *
 * Run with `npm run replay:band-witnesses`. Exits non-zero if any criterion fails.
 */

const OUT_DIR = path.join(process.cwd(), 'out', 'exposure-band-witnesses');

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

interface SnapshotRead {
  decision_id: number;
  equity_usd: number;
  positions: unknown;
}

const KNOWN_GATES: ReadonlySet<string> = new Set<TransitionGate>([
  'stop_exit',
  'risk_off_reduction',
  'frozen',
  'actionable',
  'no_regime',
]);

const results: Array<{ id: string; passed: boolean }> = [];

function record(id: string, title: string, passed: boolean, detail: string[]): void {
  results.push({ id, passed });
  console.log('');
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const line of detail) console.log(`      ${line}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function allocationOf(raw: unknown): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, number> = {};
  for (const [asset, weight] of Object.entries(raw)) {
    if (typeof weight === 'number' && Number.isFinite(weight)) out[asset] = weight;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * THE BOT'S REAL EXPOSURE AFTER THE CYCLE — E's target, and the one number E may not guess.
 *
 * Read from `equity_snapshots`, which is written after the cycle's fills, rather than from the
 * `market_context` the cycle was SHOWN: that one is the book BEFORE the cycle traded, and E is
 * defined on what the bot ends up holding. Both are known at the same instant, so neither uses
 * information from the future.
 *
 * Exposure is the SUM of the non-reserve values over equity, never `100 − cash`: the two agree
 * whenever the book is complete, and when they disagree it is the sum that is honest.
 */
function botExposureOf(snapshot: SnapshotRead | undefined): number | null {
  if (snapshot == null || !Number.isFinite(snapshot.equity_usd) || snapshot.equity_usd <= 0) return null;
  if (!Array.isArray(snapshot.positions)) return null;
  let deployed = 0;
  for (const entry of snapshot.positions) {
    if (!isRecord(entry)) return null;
    const value = entry.value_usd;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    deployed += value;
  }
  return Math.round((deployed / snapshot.equity_usd) * 100 * 1e6) / 1e6;
}

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
      .eq('status', 'decided')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`band witnesses: could not read decisions (${error.message}).`);
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
    if (error) throw new Error(`band witnesses: could not read transition_observations (${error.message}).`);
    const page = (data ?? []) as unknown as GateRead[];
    for (const row of page) {
      if (!KNOWN_GATES.has(row.gate)) {
        throw new Error(
          `band witnesses: transition_observations carries gate "${row.gate}" on decision ` +
            `${row.decision_id} (${row.asset}) — not one of the ladder's five labels.`,
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

async function loadSnapshots(
  supabase: NonNullable<ReturnType<typeof getSupabaseClient>>,
): Promise<Map<number, SnapshotRead>> {
  const PAGE = 1000;
  const byDecision = new Map<number, SnapshotRead>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('equity_snapshots')
      .select('decision_id, equity_usd, positions')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`band witnesses: could not read equity_snapshots (${error.message}).`);
    const page = (data ?? []) as unknown as SnapshotRead[];
    for (const row of page) if (row.decision_id != null) byDecision.set(row.decision_id, row);
    if (page.length < PAGE) break;
  }
  return byDecision;
}

// ── The chain ─────────────────────────────────────────────────────────────────────────

/** Why a cycle could not be reconstructed. Every skipped cycle carries one — none is silent. */
type CycleGap = 'no_context' | 'no_gates' | 'no_snapshot' | 'no_target' | 'no_prices' | 'post_gate_only';

interface ChainRow {
  decision_id: number;
  created_at: string;
  state: string;
  band_low_percent: number;
  band_high_percent: number;
  bot_exposure_percent: number;
  E: WitnessRow & { equity: number; fees: number; sent: number; suppressed: number };
  P: WitnessRow & { equity: number; fees: number; sent: number; suppressed: number };
  /** B̂ — the corrected bot. Not a witness; see the header. */
  B: {
    equity: number;
    fees: number;
    target_exposure_percent: number;
    corrected_exposure_percent: number;
    realised_exposure_percent: number;
    unrealisable_points: number;
    label: string;
    sent: number;
    suppressed: number;
    /** What the redistribution actually sends, by provenance — this is C7. */
    sent_by_origin: Record<string, number>;
    suppressed_by_reason: Record<string, number>;
    frozen_lines: number;
    /**
     * Legs on a frozen line that the CORRECTION created or resized. Must be zero: the code
     * never creates an order on a line the transition layer froze, whatever `TRANSITION_MODE`
     * says. W4 fails on a single one.
     */
    correction_legs_on_frozen: number;
    /**
     * Legs on a frozen line the MODEL itself asked for, which the correction left untouched.
     * Not a violation and not zero: arbitrated in brick 2, the freeze binds the movements the
     * band creates and only those — it does not arm the gate and does not touch the model's
     * raw vector. With the gate in `observe` the model may trade a frozen line, and the bot
     * really does send these.
     */
    model_legs_on_frozen: number;
    /** Points by which the BOOK sits outside the band after the cycle. Zero when inside. */
    band_gap_points: number;
  };
}

interface ChainResult {
  rows: ChainRow[];
  gaps: Record<string, number[]>;
  window: { fromId: number | null; toId: number | null; cycles: number };
}

interface Cycle {
  decision: DecisionRead;
  reading: ControllerReading;
  gates: Map<string, TransitionGate>;
  botExposurePercent: number;
  clamped: Record<string, number>;
  raw: Record<string, number> | null;
  context: StoredContext;
}

/**
 * Runs the three books through the window, IN ORDER.
 *
 * Deterministic by construction: no clock, no randomness, no I/O. Called twice by W1 and the
 * two results compared byte for byte — a chain that could not reproduce itself would make
 * every figure below unfalsifiable.
 */
function runChain(cycles: Cycle[], universe: string[], reserveAsset: string, openingEquity: number): ChainRow[] {
  const capOf = (asset: string): number =>
    config.execution.caps.perAsset[asset] ?? config.execution.caps.defaultPerAsset;
  const fee = config.execution.feePercent;
  const floorPercent = config.execution.minMovementPercent;

  let bookE: WitnessBook = openBook(reserveAsset, dec(openingEquity));
  let bookP: WitnessBook = openBook(reserveAsset, dec(openingEquity));
  let bookB: WitnessBook = openBook(reserveAsset, dec(openingEquity));
  const rows: ChainRow[] = [];

  for (const cycle of cycles) {
    const priceOf = pricesOf(cycle.context);
    const band = bandOf(config.exposureBand, cycle.reading.state);

    // ── E — the bot's own exposure, equally weighted under the caps ──────────────────
    const planE = equalWeightUnderCaps(cycle.botExposurePercent, universe, capOf, reserveAsset);
    const stepE = stepWitness({
      book: bookE,
      allocation: planE.allocation,
      priceOf,
      feePercent: fee,
      minMovementPercent: floorPercent,
      logTag: ':E',
    });

    // ── P — the floor of the band this cycle is actually in ──────────────────────────
    const planP = equalWeightUnderCaps(band.lowPercent, universe, capOf, reserveAsset);
    const stepP = stepWitness({
      book: bookP,
      allocation: planP.allocation,
      priceOf,
      feePercent: fee,
      minMovementPercent: floorPercent,
      logTag: ':P',
    });

    // ── B̂ — the corrected bot, judged against ITS OWN book ──────────────────────────
    //
    // The correction has to be sized on the book B̂ really holds, not on the bot's: that is the
    // whole difference between a chained counterfactual and the one-step re-anchoring brick 2
    // could only do. So the assessment's exposure, equity and movement floor all come from
    // here.
    const valuedB = valueBook(bookB, priceOf);
    // A held line with no price stops every book on this cycle; the caller has already
    // filtered those out, so these are narrowings rather than branches.
    if ('gap' in stepE || 'gap' in stepP || !valuedB.ok) continue;

    const equityB = valuedB.equity;
    const exposureB = valuedB.exposurePercent;
    const assessment = assessBand({
      policyVersion: config.exposureBand.version,
      policy: config.exposureBand,
      state: cycle.reading.state,
      targetAllocation: cycle.clamped,
      rawAllocation: cycle.raw,
      bookExposurePercent: exposureB,
      reserveAsset,
      gateByAsset: cycle.gates,
      capOf,
      maxDeployablePercent: 100 - config.execution.caps.minCashPercent,
      equityQuote: equityB,
      movementFloorQuote: (equityB * floorPercent) / 100,
      stoppedWeightSurvives: true,
    });
    const correction = correctToBand({
      assessment,
      clampedAllocation: cycle.clamped,
      rawAllocation: cycle.raw,
      reserveAsset,
      portfolio: valuedB.portfolio,
      priceOf,
      feePercent: fee,
      minMovementPercent: floorPercent,
    });
    const stepB = stepWitness({
      book: bookB,
      allocation: correction.correctedAllocation,
      priceOf,
      feePercent: fee,
      minMovementPercent: floorPercent,
      logTag: ':B',
    });
    if ('gap' in stepB) continue;

    // C7 — what the redistribution SENDS, by provenance. The origin is what makes the answer
    // readable later: a leg the model asked for and a leg the band invented are not the same
    // position, and only the journal can tell them apart.
    // THE FREEZE CONTRACT, checked rather than asserted. The corrector may never create an
    // order on a line the transition layer declared frozen — whatever `TRANSITION_MODE` says —
    // and a criterion that only claimed it in prose would prove nothing.
    const frozen = new Set(
      correction.lines.filter((line) => !line.mayIncrease && !line.mayDecrease).map((line) => line.asset),
    );
    const movedByBand = new Map(correction.lines.map((line) => [line.asset, line.correctionPoints !== 0]));
    const originOf = new Map(correction.lines.map((line) => [line.asset, line.origin]));
    const sentByOrigin: Record<string, number> = {};
    for (const movement of stepB.movements) {
      const origin = originOf.get(movement.asset) ?? 'modele';
      sentByOrigin[origin] = (sentByOrigin[origin] ?? 0) + 1;
    }
    const suppressedByReason: Record<string, number> = {};
    for (const leg of stepB.suppressed) {
      suppressedByReason[leg.reason] = (suppressedByReason[leg.reason] ?? 0) + 1;
    }

    rows.push({
      decision_id: cycle.decision.id,
      created_at: cycle.decision.created_at,
      state: cycle.reading.state,
      band_low_percent: band.lowPercent,
      band_high_percent: band.highPercent,
      bot_exposure_percent: cycle.botExposurePercent,
      E: {
        ...witnessRow(planE, stepE),
        equity: stepE.equityAfter,
        fees: stepE.feesQuote,
        sent: stepE.movements.length,
        suppressed: stepE.suppressed.length,
      },
      P: {
        ...witnessRow(planP, stepP),
        equity: stepP.equityAfter,
        fees: stepP.feesQuote,
        sent: stepP.movements.length,
        suppressed: stepP.suppressed.length,
      },
      B: {
        equity: stepB.equityAfter,
        fees: stepB.feesQuote,
        target_exposure_percent: assessment.targetExposurePercent,
        corrected_exposure_percent: correction.correctedExposurePercent,
        realised_exposure_percent: stepB.exposureAfterPercent,
        unrealisable_points: correction.unrealisablePoints,
        label: correction.label,
        sent: stepB.movements.length,
        suppressed: stepB.suppressed.length,
        sent_by_origin: sentByOrigin,
        suppressed_by_reason: suppressedByReason,
        frozen_lines: frozen.size,
      correction_legs_on_frozen: stepB.movements.filter(
        (m) => frozen.has(m.asset) && (movedByBand.get(m.asset) ?? false),
      ).length,
      model_legs_on_frozen: stepB.movements.filter(
        (m) => frozen.has(m.asset) && !(movedByBand.get(m.asset) ?? false),
      ).length,
      band_gap_points: outsideBandPoints(stepB.exposureAfterPercent, band),
      },
    });

    bookE = stepE.book;
    bookP = stepP.book;
    bookB = stepB.book;
  }

  return rows;
}

async function main(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('band witnesses: Supabase is not configured.');

  const universe = tradableBaseAssets(config);
  const [decisions, gatesByDecision, snapshots] = await Promise.all([
    loadDecisions(supabase),
    loadGates(supabase),
    loadSnapshots(supabase),
  ]);

  console.log('='.repeat(96));
  console.log("LES DEUX TÉMOINS — rejeu hors ligne, lecture seule, aucun ordre produit");
  console.log(
    `Politique ${config.exposureBand.version} · frais ${config.execution.feePercent}% · ` +
      `seuil ${config.execution.minMovementPercent}% · plafonds ` +
      Object.entries(config.execution.caps.perAsset)
        .map(([a, c]) => `${a} ${c}`)
        .join(' / '),
  );
  console.log('='.repeat(96));

  // ── Build the window: every cycle whose inputs are ALL journaled ──────────────────
  const gaps: Record<string, number[]> = {};
  const noteGap = (gap: CycleGap, id: number): void => {
    (gaps[gap] ??= []).push(id);
  };
  const cycles: Cycle[] = [];

  for (const decision of decisions) {
    if (decision.applied_divergence_cause != null) {
      noteGap('post_gate_only', decision.id);
      continue;
    }
    let reading: ControllerReading | null = null;
    try {
      const journal = parseRegimeJournal(decision.regime);
      const point = journal == null ? null : regimePointFromJournal(journal);
      reading = point == null ? null : readContext(point, universe);
    } catch {
      reading = null;
    }
    if (reading == null) {
      noteGap('no_context', decision.id);
      continue;
    }
    const gates = gatesByDecision.get(decision.id);
    if (gates == null || gates.size === 0) {
      noteGap('no_gates', decision.id);
      continue;
    }
    const botExposure = botExposureOf(snapshots.get(decision.id));
    if (botExposure == null) {
      noteGap('no_snapshot', decision.id);
      continue;
    }
    const clamped = allocationOf(decision.applied_allocation);
    if (clamped == null) {
      noteGap('no_target', decision.id);
      continue;
    }
    const context = decision.market_context as StoredContext;
    const priceOf = pricesOf(context);
    if (universe.some((asset) => priceOf(asset) == null)) {
      noteGap('no_prices', decision.id);
      continue;
    }
    cycles.push({
      decision,
      reading,
      gates,
      botExposurePercent: botExposure,
      clamped,
      raw: allocationOf(decision.target_allocation),
      context,
    });
  }

  if (cycles.length === 0) throw new Error('band witnesses: no cycle carries every required input.');

  // The books open with the bot's own equity at the first cycle of the window, so the three
  // start on the same footing. The pilot's real opening instant belongs to brick 4 — this one
  // is a parameter of the dry run and is printed as such.
  const openingEquity = portfolioOf(cycles[0]!.context).equity.toNumber();
  const rows = runChain(cycles, universe, portfolioOf(cycles[0]!.context).reserveAsset, openingEquity);

  console.log('');
  console.log(
    `Fenêtre : ${rows.length} cycles reconstruits, ids ${rows[0]?.decision_id} → ` +
      `${rows[rows.length - 1]?.decision_id}, ouverture à ${openingEquity.toFixed(2)}.`,
  );

  // ── W0 — every cycle is either reconstructed or carries a NAMED gap ───────────────
  {
    const accounted = rows.length + Object.values(gaps).reduce((sum, ids) => sum + ids.length, 0);
    record('W0', 'toutes les entrées des témoins sont durablement journalisées', accounted === decisions.length, [
      `${decisions.length} cycles v5 décidés · ${rows.length} reconstruits · ` +
        `${accounted - rows.length} écartés, chacun avec une raison nommée.`,
      ...Object.entries(gaps).map(([gap, ids]) => `  ${gap} : ${ids.length} cycle(s)`),
      'Rien n’est écarté en silence : un cycle sans raison ferait échouer ce critère.',
      'Les entrées lues : prix du cycle, snapshot d’équité post-cycle, journal de régime,',
      'verdicts de porte par actif, cible bornée. Toutes déjà écrites par le cycle vivant —',
      'aucune écriture nouvelle n’a été ajoutée au chemin de trading pour les témoins.',
    ]);
  }

  // ── W1 — the reconstruction reproduces itself, byte for byte ──────────────────────
  {
    const again = runChain(cycles, universe, portfolioOf(cycles[0]!.context).reserveAsset, openingEquity);
    const first = sha256Of(canonicalJson(rows));
    const second = sha256Of(canonicalJson(again));
    record('W1', 'le rejeu est reproductible — même entrées, mêmes livres', first === second, [
      `empreinte du premier passage : ${first}`,
      `empreinte du second           : ${second}`,
      'La méthode hors ligne a été choisie parce qu’elle est reconstructible ; une chaîne qui',
      'ne se reproduit pas rendrait chacun de ses chiffres infalsifiable.',
    ]);
  }

  // ── W2 — E really carries the bot's exposure ──────────────────────────────────────
  {
    const targetErrors = rows.map((r) => Math.abs(r.E.targetExposurePercent - r.bot_exposure_percent));
    const realisedErrors = rows.map((r) => Math.abs(r.E.realisedExposurePercent - r.bot_exposure_percent));
    const worstTarget = Math.max(...targetErrors);
    const clippedCycles = rows.filter((r) => r.E.clipped.length > 0);
    const redistributed = clippedCycles.map((r) => r.E.redistributedPoints);
    record('W2', 'le témoin E vise exactement l’exposition réelle du bot', worstTarget <= 1e-6, [
      `écart maximal entre la cible de E et l’exposition du bot : ${worstTarget.toFixed(9)} point`,
      `écart RÉALISÉ moyen : ${mean(realisedErrors)?.toFixed(2)} point · maximum ` +
        `${Math.max(...realisedErrors).toFixed(2)} — c’est la plomberie, pas la définition :`,
      'le seuil de 2 % et les frais sont les mêmes pour E que pour le bot, par construction.',
      `plafonds atteints sur ${clippedCycles.length} cycle(s)` +
        (clippedCycles.length === 0
          ? ' — la redistribution n’a jamais eu à jouer sur cette fenêtre.'
          : ` · points redistribués en moyenne : ${mean(redistributed)?.toFixed(2)}` +
            ` · lignes écrêtées : ${[...new Set(clippedCycles.flatMap((r) => r.E.clipped))].join(', ')}`),
      'Aucun surplus ne repart en cash tant que les plafonds peuvent tenir l’exposition :',
      `points inplaçables sur toute la fenêtre : ${rows.reduce((s, r) => s + r.E.unplaceablePoints, 0).toFixed(2)}.`,
    ]);
  }

  // ── W3 — P publishes the three numbers §3.7 requires of it ────────────────────────
  {
    const complete = rows.every(
      (r) =>
        Number.isFinite(r.P.targetExposurePercent) &&
        Number.isFinite(r.P.attainableExposurePercent) &&
        Number.isFinite(r.P.gapPoints),
    );
    const byState = new Map<string, { cycles: number; gaps: number[] }>();
    for (const row of rows) {
      const bucket = byState.get(row.state) ?? { cycles: 0, gaps: [] };
      bucket.cycles += 1;
      bucket.gaps.push(row.P.gapPoints);
      byState.set(row.state, bucket);
    }
    record('W3', 'le témoin P publie sa cible, son atteignable et son écart au plancher', complete, [
      'Sans ces trois nombres nous comparerions un bot contraint à un témoin supposé parfait.',
      ...[...byState.entries()].map(
        ([state, b]) =>
          `  ${state.padEnd(13)} ${String(b.cycles).padStart(4)} cycle(s) · plancher visé ` +
          `${rows.find((r) => r.state === state)!.P.targetExposurePercent.toFixed(2)}` +
          ` · écart réalisé moyen ${mean(b.gaps)?.toFixed(2)} point`,
      ),
      `P n’atteint pas exactement son plancher sur ${rows.filter((r) => Math.abs(r.P.gapPoints) > 0.01).length} cycle(s)` +
        ' — le seuil de mouvement et les frais, les mêmes que ceux du bot.',
    ]);
  }

  // ── W4 — the witnesses bear the plumbing, never the bot's freezes ─────────────────
  {
    const frozenCycles = rows.filter((r) => r.B.frozen_lines > 0);
    const violations = rows.filter((r) => r.B.correction_legs_on_frozen > 0);
    const modelLegs = rows.reduce((sum, r) => sum + r.B.model_legs_on_frozen, 0);
    record('W4', 'les gels : portés par B̂ parce qu’il EST le bot, jamais par les témoins', violations.length === 0, [
      'Arbitré : un gel, un stop ou une transition décrit une position DU BOT. Un témoin ne l’a',
      'pas prise. Les lui appliquer rendrait le comparateur dépendant de la trajectoire qu’il',
      'existe pour évaluer — et, aujourd’hui, plus contraint que le bot lui-même, dont la porte',
      'est en `observe` et ne bloque aucun ordre réel.',
      `B̂, qui EST le bot corrigé, en hérite : ${frozenCycles.length} cycle(s) sur ${rows.length} portent au moins`,
      `une ligne gelée, et la CORRECTION y a créé ${rows.reduce((s2, r) => s2 + r.B.correction_legs_on_frozen, 0)} ordre(s).`,
      'Vérifié jambe par jambe, pas affirmé : chaque mouvement envoyé est confronté aux verdicts',
      'de porte du cycle ET à la correction de sa ligne, et ce critère échoue sur un seul.',
      '',
      `En revanche ${modelLegs} jambe(s) touchent une ligne gelée parce que LE MODÈLE les a demandées et`,
      'que la correction ne les a pas touchées. Ce n’est pas une violation : la contrainte de gel',
      'porte sur les mouvements que la bande crée, et sur eux seuls — elle n’arme pas la porte et',
      'ne touche pas au vecteur brut du modèle. Le bot réel envoie déjà ces jambes.',
      'La séparation reste valable si la porte passe un jour en `enforce` : elle dit de quel',
      'livre un gel parle, pas dans quel mode il est lu.',
    ]);
  }

  // ── W5 — C7, reconstructed in the chained machinery ───────────────────────────────
  {
    const sent = rows.reduce((sum, r) => sum + r.B.sent, 0);
    const movingCycles = rows.filter((r) => r.B.sent > 0).length;
    const byOrigin: Record<string, number> = {};
    const byReason: Record<string, number> = {};
    for (const row of rows) {
      for (const [origin, count] of Object.entries(row.B.sent_by_origin)) {
        byOrigin[origin] = (byOrigin[origin] ?? 0) + count;
      }
      for (const [reason, count] of Object.entries(row.B.suppressed_by_reason)) {
        byReason[reason] = (byReason[reason] ?? 0) + count;
      }
    }
    const outsideTarget = rows.filter((r) => r.B.label !== 'aucune_correction').length;
    const botGaps = rows.map((r) => outsideBandPoints(r.bot_exposure_percent, {
      lowPercent: r.band_low_percent,
      highPercent: r.band_high_percent,
    }));
    const bGaps = rows.map((r) => r.B.band_gap_points);
    const unrealisable = rows.map((r) => r.B.unrealisable_points).filter((p) => p > 0);
    const fmt = (bins: Record<string, number>): string =>
      Object.entries(bins).map(([k, n]) => `${k} ${n}`).join(' · ');
    record('W5', 'C7 — ce que la répartition envoie réellement, en chaîne', true, [
      'HYPOTHÈSE AFFICHÉE : B̂ rejoue les réponses HISTORIQUES du modèle contre un livre que le',
      'modèle n’a jamais vu. Il mesure la conséquence MÉCANIQUE de la correction sous décisions',
      'historiques figées. Ce n’est ni une simulation de la réaction future du modèle, ni une',
      'borne — ni haute ni basse — de performance.',
      '',
      `La cible du modèle sort de la bande sur ${outsideTarget} cycle(s) sur ${rows.length}. Mais une fois le`,
      `livre déjà corrigé, seuls ${movingCycles} cycle(s) ont quelque chose à envoyer — ${sent} jambe(s) au total.`,
      'C’est la mesure que la brique 1 annonçait sans pouvoir la produire : sa fréquence était',
      'une BORNE HAUTE ré-ancrée, parce que le livre y retombait sous le plancher à chaque',
      'réveil. En chaîne, le livre garde ses propres corrections.',
      '',
      `  jambes par origine : ${Object.entries(byOrigin).map(([o, n]) => `${o} ${n}`).join(' · ') || 'aucune'}`,
      `  supprimées         : ${Object.entries(byReason).map(([o, n]) => `${o} ${n}`).join(' · ') || 'aucune'}`,
      '',
      'ÉCART À LA BANDE du livre après le cycle — le même barème pour les deux :',
      `  bot réel : ${fmt(bandBins(botGaps))}`,
      `  B̂       : ${fmt(bandBins(bGaps))}`,
      'Les cycles « moins de 0,1 pt » sont la traînée de frais publiée par la brique 2, pas un',
      'échec de la bande : un budget d’achat divisé par (1 + frais) arrive un cheveu trop court.',
      `Points hors d’atteinte quand il y en a : ${unrealisable.length} cycle(s), médiane ` +
        `${median(unrealisable)?.toFixed(2)} pt, maximum ${Math.max(...unrealisable).toFixed(2)} pt, ` +
        `dont ${unrealisable.filter((p) => p > 1).length} au-dessus du point.`,
    ]);
  }

  // ── W6 — C8 gets its reader and NO verdict ────────────────────────────────────────
  {
    const created = rows.reduce(
      (sum, r) => sum + (r.B.sent_by_origin['allocation_de_secours'] ?? 0) + (r.B.sent_by_origin['correction_de_bande'] ?? 0),
      0,
    );
    record('W6', 'C8 — le lecteur existe, le verdict n’est pas rendu', true, [
      'La question est : le modèle UTILISE-t-il l’exposition imposée, ou la combat-il ? Elle',
      'porte sur ce que le modèle fait quand il VOIT une position que le correcteur a créée.',
      'En mode observation il n’en a jamais vu une seule. Aucun contrefactuel chaîné ne répare',
      'cela : il ferait répondre les mots réels du modèle à une question qu’on ne lui a jamais',
      'posée. Un chiffre affaibli publié ici serait lu comme la réponse.',
      `Les données sont conservées : ${created} jambe(s) créée(s) par la correction dans cette`,
      'fenêtre, chacune avec son origine, son `correction_moves_holding` et son poids réalisé.',
      'Le lecteur (`readAdoption`) distingue adoption, indifférence et lutte — trois lectures,',
      'parce qu’un modèle qui redemande sa propre préférence n’est pas un modèle qui lutte.',
      'C8 commence le jour où `application` expose réellement le modèle aux positions corrigées.',
    ]);
  }

  // ── The artefact ─────────────────────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const written = writeArtefact(OUT_DIR, 'witnesses.json', {
    policy: config.exposureBand,
    caps: config.execution.caps,
    execution: { feePercent: config.execution.feePercent, minMovementPercent: config.execution.minMovementPercent },
    window: {
      cycles: rows.length,
      from_id: rows[0]?.decision_id ?? null,
      to_id: rows[rows.length - 1]?.decision_id ?? null,
      opening_equity: openingEquity,
      gaps: Object.fromEntries(Object.entries(gaps).map(([gap, ids]) => [gap, ids.length])),
    },
    contract: {
      not_measured: [
        'aucun rendement, aucun drawdown, aucun écart bot-témoin : la fenêtre du pilote commence au passage en `application`',
        'B̂ mesure la conséquence mécanique de la correction sous décisions historiques figées — pas la réaction du modèle, pas une borne de performance',
        'C8 ne reçoit aucun verdict pendant l’observation',
      ],
      witnesses_bear: ['frais', 'seuil de mouvement', 'poussière', 'prix absent', 'budget insuffisant'],
      witnesses_do_not_bear: ['gels', 'stops', 'transitions du livre du bot'],
    },
    rows,
  });
  console.log('');
  console.log(`Artefact : ${written.file}  ${written.sha256}  ${written.bytes} octets`);

  const failed = results.filter((r) => !r.passed);
  console.log('');
  console.log('='.repeat(96));
  console.log(
    failed.length === 0
      ? `Tous les ${results.length} critères passent.`
      : `${failed.length} critère(s) en échec : ${failed.map((r) => r.id).join(', ')}`,
  );
  console.log('='.repeat(96));
  if (failed.length > 0) process.exitCode = 1;
}

/**
 * How far OUTSIDE the band a book sits, in points. Zero when it is inside.
 *
 * Reported in bins rather than as a boolean, because a book at 44.97 against a floor of 45 is
 * not "outside the band" in any sense a reader means by it: that is the fee drag brick 2
 * measured and published — a buy budget divided by (1 + fee) lands a hair short. A tolerance
 * of a hundredth of a point would have counted 143 such cycles as failures of the band.
 */
function outsideBandPoints(exposurePercent: number, band: { lowPercent: number; highPercent: number }): number {
  if (exposurePercent < band.lowPercent) return Math.round((band.lowPercent - exposurePercent) * 1e6) / 1e6;
  if (exposurePercent > band.highPercent) return Math.round((exposurePercent - band.highPercent) * 1e6) / 1e6;
  return 0;
}

/** The same bins for every book, so two books can be read side by side. */
function bandBins(gaps: number[]): Record<string, number> {
  const bins: Record<string, number> = {
    'dans la bande': 0,
    'moins de 0,1 pt': 0,
    '0,1 a 1 pt': 0,
    '1 a 5 pt': 0,
    'plus de 5 pt': 0,
  };
  const bump = (key: string): void => {
    bins[key] = (bins[key] ?? 0) + 1;
  };
  for (const gap of gaps) {
    if (gap <= 0) bump('dans la bande');
    else if (gap <= 0.1) bump('moins de 0,1 pt');
    else if (gap <= 1) bump('0,1 a 1 pt');
    else if (gap <= 5) bump('1 a 5 pt');
    else bump('plus de 5 pt');
  }
  return bins;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
