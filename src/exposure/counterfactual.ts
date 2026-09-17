import type { CorrectedLine } from './correct.js';
import type { Movement } from '../execution/movements.js';
import type { JournalCorrectionLine, CriterionStatus } from './adoption.js';

/**
 * B̂'s INPUT, C7's ATTRIBUTION, AND THE JUDGES OF W4 AND W5 — what the chained counterfactual
 * is fed, how its legs are named, and how its criteria can fail.
 *
 * PURE and TOTAL. The replay wires the journal in; nothing here reads or writes.
 *
 * ── THE THREE ALLOCATIONS A DECIDED ROW CARRIES, AND WHICH ONE B̂ MAY TAKE ────────────
 *
 * Established on the corpus (cycles 1838, 1839, 1840) before any of this was written:
 *
 *   `decisions.target_allocation`   the model's RAW proposal, before caps and before the
 *                                   band — {XRP 15, USDT 85} at 1839, a line it already held.
 *   `exposure_band_corrections.clamped_weight_percent`
 *                                   the proposal after the risk caps: the exact input the
 *                                   production corrector received (`clamp.applied`). The
 *                                   journaled FACT, one row per asset, since brick 2 (1817).
 *   `decisions.applied_allocation`  the EFFECTIVE target after the band and after the gate —
 *                                   {BNB 15, ETH 15, XRP 15, USDT 55} at 1839. Since the
 *                                   activation this is the CORRECTED allocation.
 *
 * B̂ is the bot under the correction: it must receive the model's UNCORRECTED intention and
 * apply the band on its own book. Feeding it `applied_allocation`, as the first version did,
 * made it correct a target the band had already corrected — it found nothing to do, attributed
 * the band's BNB and ETH buys at 1839 to the model, and reported zero band legs over a window
 * whose journal holds twelve planned and four executed.
 *
 * So B̂ takes the journaled clamped weights. In the official window that journal is
 * MANDATORY: a cycle without it is a named gap, never a recomputation. On the bench (cycles
 * before brick 2 journaled anything) the clamp is recomputed from the raw proposal with the
 * same pure function production uses, and said so — "the row is the fact, the recomputation
 * is a guess that happens to be right for now" (storedCycle.ts). Where both exist they are
 * compared, and W5 fails on any disagreement.
 */

export type IntentionSource = 'journal_clamped' | 'clamp_recomputed';

export interface ModelIntention {
  /** Reserve included, summing to 100 — the shape `correctToBand` expects. */
  allocation: Record<string, number>;
  source: IntentionSource;
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

/** The journal's clamped weights as an allocation, or null when the journal does not cover the universe. */
export function journaledClampedAllocation(
  lines: readonly JournalCorrectionLine[] | null | undefined,
  universe: readonly string[],
  reserveAsset: string,
): Record<string, number> | null {
  if (lines == null || lines.length === 0) return null;
  const byAsset = new Map(lines.map((line) => [line.asset, line]));
  const allocation: Record<string, number> = {};
  let deployed = 0;
  for (const asset of universe) {
    const line = byAsset.get(asset);
    if (line == null || !Number.isFinite(line.clampedWeightPercent)) return null;
    allocation[asset] = line.clampedWeightPercent;
    deployed += line.clampedWeightPercent;
  }
  allocation[reserveAsset] = round6(100 - deployed);
  return allocation;
}

export function modelIntentionFor(input: {
  targetAllocation: Record<string, number> | null;
  journalLines: readonly JournalCorrectionLine[] | null | undefined;
  universe: readonly string[];
  reserveAsset: string;
  /** Production's own clamp, bound to the running configuration. */
  clamp: (target: Record<string, number>) => Record<string, number>;
  /** In the official window the journal is mandatory; on the bench a recomputation is allowed. */
  journalMandatory: boolean;
}): ModelIntention | null {
  const journaled = journaledClampedAllocation(input.journalLines, input.universe, input.reserveAsset);
  if (journaled != null) return { allocation: journaled, source: 'journal_clamped' };
  if (input.journalMandatory) return null;
  if (input.targetAllocation == null) return null;
  return { allocation: input.clamp(input.targetAllocation), source: 'clamp_recomputed' };
}

/** Do two allocations agree on every line of the universe (and the reserve), to six decimals? */
export function allocationsAgree(
  a: Record<string, number>,
  b: Record<string, number>,
  universe: readonly string[],
  reserveAsset: string,
): { agree: boolean; worst: { asset: string; a: number; b: number } | null } {
  let worst: { asset: string; a: number; b: number } | null = null;
  let worstGap = 0;
  for (const asset of [...universe, reserveAsset]) {
    const x = a[asset] ?? 0;
    const y = b[asset] ?? 0;
    const gap = Math.abs(x - y);
    if (gap > worstGap) {
      worstGap = gap;
      worst = { asset, a: x, b: y };
    }
  }
  return { agree: worstGap <= 1e-6, worst: worstGap <= 1e-6 ? null : worst };
}

// ── C7 — THE ORIGIN OF EVERY LEG B̂ SENDS ──────────────────────────────────────────────

export interface AttributedLeg {
  asset: string;
  side: 'buy' | 'sell';
  notionalQuote: number;
  /** The journal's own convention: a line the band moved carries the band's origin, and only those. */
  origin: 'modele' | 'correction_de_bande' | 'allocation_de_secours';
  correctionPoints: number;
}

/**
 * Names each leg by the correction line of its asset — `correction_points ≠ 0` means the band
 * moved that line and the leg is the band's, exactly as `exposure_band_corrections` names its
 * own rows (constraint `origin_matches_move`). With no correction (a stop cycle, a cycle the
 * band left alone) every leg is the model's.
 */
export function attributeLegs(
  movements: readonly Movement[],
  lines: readonly CorrectedLine[] | null,
): AttributedLeg[] {
  const byAsset = new Map((lines ?? []).map((line) => [line.asset, line]));
  return movements.map((movement) => {
    const line = byAsset.get(movement.asset);
    const moved = line != null && line.correctionPoints !== 0;
    return {
      asset: movement.asset,
      side: movement.side,
      notionalQuote: movement.notional.toNumber(),
      origin: moved ? line.origin : 'modele',
      correctionPoints: line?.correctionPoints ?? 0,
    };
  });
}

// ── THE REAL JOURNAL — planned, executed, and planned-but-not-executed band legs ────────

export interface RealBandLeg {
  decisionId: number;
  asset: string;
  origin: 'correction_de_bande' | 'allocation_de_secours';
  correctionPoints: number;
  plannedSide: 'buy' | 'sell' | null;
  plannedNotionalQuote: number | null;
  bookedSide: 'buy' | 'sell' | null;
  bookedNotionalQuote: number | null;
  /**
   * For a planned leg that did not book, in this order of precedence: the corrector's own
   * suppression; the pilot holding the correction back that cycle (`pilot_hold`); the
   * transition gate refusing the whole vector (`applied_divergence_cause`), which drops the
   * strategic legs before the executor sees them; an intent the executor journaled as refused.
   * Only when none of those is journaled does the one path that journals nothing remain — the
   * executor's floor after the venue's step rounding — and it is reported as an INFERENCE, in
   * those words. (The gate and the hold were missing from the first version: first review round.)
   */
  notExecutedBecause: string | null;
}

/** What a cycle's own rows say about why its legs may never have reached the executor. */
export interface CycleExecutionFacts {
  /** `decisions.applied_divergence_cause` — set when the gate refused the vector. */
  gateRefusal: string | null;
  /** `exposure_band_observations.pilot_hold` — set when the correction was not allowed to act. */
  pilotHold: string | null;
  /**
   * Was the correction allowed to reach the orders — `mode = application` and no hold? When it
   * was not, a `booked_side` on a band-origin line is the uncorrected MODEL's own booking, and
   * the leg counts as planned-not-executed, never as executed by the band (third review round).
   * NULL when the cycle's band observation is absent: the fact is unreadable, and the leg is
   * reported as such — never as "not allowed" by default (sixth review round).
   */
  correctionAllowed: boolean | null;
}

export function realBandLegs(
  lines: readonly JournalCorrectionLine[],
  fromDecisionId: number,
  toDecisionId: number,
  /** Non-executed execution rows (rejected / failed) per decision and asset, when the replay read them. */
  refusedIntentReason: (decisionId: number, asset: string) => string | null,
  /** The cycle's own journaled causes — the gate's refusal and the pilot's hold. */
  cycleFacts: (decisionId: number) => CycleExecutionFacts,
): {
  /** Every leg the band WANTED — the line moved — whether it was planned, suppressed or booked. */
  wanted: RealBandLeg[];
  /**
   * Legs whose execution status cannot be read: the cycle's band observation is absent, so
   * whether the correction was allowed to act — and therefore whose booking it is — is unknown.
   * Named, and never counted as executed or as not executed.
   */
  unreadable: RealBandLeg[];
  /** The journal's own "planned": a `planned_side` — the corrector's floor let the leg through. */
  planned: RealBandLeg[];
  /** Wanted, and deleted by the corrector's own floor before any plan existed. */
  suppressedByCorrector: RealBandLeg[];
  executed: RealBandLeg[];
  /** Planned by the corrector, never booked by the band. */
  plannedNotExecuted: RealBandLeg[];
} {
  const wanted: RealBandLeg[] = [];
  for (const line of lines) {
    if (line.origin === 'modele' || line.correctionPoints === 0) continue;
    if (line.decisionId < fromDecisionId || line.decisionId > toDecisionId) continue;
    // A leg the corrector's own floor deleted has no planned side but a suppression: it was
    // wanted, and it is a planned-not-executed leg like the others (third review round).
    const suppressed = line.suppressedReason != null;
    if (line.plannedSide == null && line.bookedSide == null && !suppressed) continue;
    const facts = cycleFacts(line.decisionId);
    // EXECUTED BY THE BAND only when the correction was allowed to act: on a held cycle the
    // booking, if any, is the model's own. When that fact is UNREADABLE the leg is neither.
    const executedByBand = line.bookedSide != null && facts.correctionAllowed === true;
    let notExecutedBecause: string | null = null;
    if (facts.correctionAllowed == null && !suppressed) {
      notExecutedBecause = 'observation de bande absente sur ce cycle — impossible de dire si la correction a agi ni à qui est le booking';
    } else if (!executedByBand) {
      const refused = refusedIntentReason(line.decisionId, line.asset);
      notExecutedBecause =
        line.suppressedReason != null
          ? `supprimée par le correcteur (${line.suppressedReason})`
          : !facts.correctionAllowed
            ? `la correction n’a pas été appliquée ce cycle (${facts.pilotHold == null ? 'mode observation' : `pilot_hold ${facts.pilotHold}`})` +
              (line.bookedSide == null ? '' : ` — le booking ${line.bookedSide} est celui du modèle`)
            : facts.gateRefusal != null
              ? `la porte a refusé le vecteur entier (${facts.gateRefusal})`
              : refused != null
                ? `intention refusée par l’exécuteur (${refused})`
                : 'aucune ligne d’exécution : écartée avant l’exécuteur, sous le seuil après arrondi au pas de la place — déduit, rien de journalisé';
    }
    wanted.push({
      decisionId: line.decisionId,
      asset: line.asset,
      origin: line.origin,
      correctionPoints: line.correctionPoints,
      plannedSide: line.plannedSide ?? (suppressed ? (line.correctionPoints > 0 ? 'buy' : 'sell') : null),
      plannedNotionalQuote: line.plannedNotionalQuote ?? line.suppressedNotionalQuote,
      bookedSide: executedByBand ? line.bookedSide : null,
      bookedNotionalQuote: executedByBand ? line.bookedNotionalQuote : null,
      notExecutedBecause,
    });
  }
  const sorted = wanted.sort((a, b) => a.decisionId - b.decisionId || (a.asset < b.asset ? -1 : 1));
  const suppressedByCorrector = sorted.filter((leg) => leg.notExecutedBecause?.startsWith('supprimée par le correcteur') ?? false);
  const unreadable = sorted.filter((leg) => leg.notExecutedBecause?.startsWith('observation de bande absente') ?? false);
  const planned = sorted.filter((leg) => !suppressedByCorrector.includes(leg) && !unreadable.includes(leg));
  return {
    wanted: sorted,
    unreadable,
    planned,
    suppressedByCorrector,
    executed: planned.filter((leg) => leg.bookedSide != null),
    plannedNotExecuted: planned.filter((leg) => leg.bookedSide == null),
  };
}

// ── COVERAGE OF THE BEST-EFFORT LAYERS ────────────────────────────────────────────────
//
// Every layer the replay interprets is written best-effort by production, and an absence is
// not a fact: it must become a named gap, an `illisible` reading or a refusal — never a value.
// The helpers below say, for each layer, what "complete" means.

/**
 * The gate journal of a cycle is complete when EVERY asset of the universe has a verdict. A
 * partial map is not a smaller map: the corrector fails closed on an unjudged line, so a
 * cycle reconstructed on a partial map would freeze a line the real cycle did not.
 */
export function gateCoverageComplete(
  gates: ReadonlyMap<string, unknown> | undefined | null,
  universe: readonly string[],
): boolean {
  if (gates == null) return false;
  return universe.every((asset) => gates.has(asset));
}

/**
 * WHERE THE BAND JOURNAL BEGINS — the first cycle either of its two layers ever covered. Taken
 * from the observations alone, a first observation that failed to write while its corrections
 * landed would push the start past that cycle and drop it from the expected sequence, letting
 * the settled point advance over a hole (sixth review round). The union sees it.
 */
export function bandJournalStart(
  observationIds: Iterable<number>,
  correctionIds: Iterable<number>,
): number | null {
  let start: number | null = null;
  for (const id of [...observationIds, ...correctionIds]) {
    if (start == null || id < start) start = id;
  }
  return start;
}

// ── THE SETTLED POINT OF THE BAND LAYER ───────────────────────────────────────────────

/**
 * The last cycle whose BAND closure is proven complete.
 *
 * Production writes the transition verdicts, THEN the band observation, THEN the corrections
 * rows — so a cutoff proven on the gates alone does not prove the corrections journal this
 * replay now reads: a live cycle could show complete verdicts while its corrections are still
 * being written, and the cycle would become a named gap that `real_journal` and C8 silently
 * omit (second review round). The band layer's own completeness is therefore required too,
 * and the replay's cutoff is the smaller of the two.
 *
 * A cycle counts as complete when its observation row exists and, if that row says a
 * correction was computed, every asset of the universe has its corrections row. A cycle whose
 * observation says no correction was computed expects none.
 *
 * THE POINT STOPS BEFORE THE FIRST INCOMPLETE CYCLE, in decision order, and a complete cycle
 * after it never carries the point past the hole. The first version skipped an incomplete
 * cycle and went on to the next complete one — so a corrections write that failed and stayed
 * failed (`saveBandCorrections` swallows its error and later cycles carry on) would have left
 * that cycle INSIDE the replay window while `real_journal` and C8 silently omitted its lines
 * (fourth review round).
 *
 * AND IT IS WALKED ON THE CYCLES EXPECTED, not on the observations present. A scan over the
 * observation rows alone cannot see a row that is MISSING: `saveBandObservation` is
 * best-effort and production carries on to the corrections, so a cycle can hold its corrections
 * rows and no observation. Such a cycle is unsettled — its facts (mode, hold) are unreadable
 * and its executed legs would be reported as the model's — so the point stops on the cycle
 * before it, and a complete observation later never carries it past (fifth review round).
 */
export function bandSettledCutoff(
  /** Every cycle the band layer is EXPECTED to have written — the decisions since the journal began. */
  expectedCycleIds: readonly number[],
  observations: ReadonlyMap<number, { correctionComputed: boolean }>,
  correctionsRowsByDecision: ReadonlyMap<number, number>,
  universeSize: number,
): number | null {
  if (universeSize <= 0) return null;
  let cutoff: number | null = null;
  for (const id of [...new Set(expectedCycleIds)].sort((a, b) => a - b)) {
    const observation = observations.get(id);
    if (observation == null) break;
    const rows = correctionsRowsByDecision.get(id) ?? 0;
    if (observation.correctionComputed && rows < universeSize) break;
    cutoff = id;
  }
  return cutoff;
}

// ── THE JUDGES — W4 and W5, three-valued and able to fail ─────────────────────────────

/** What one reconstructed cycle of B̂ contributes to the judges. */
export interface CounterfactualCycle {
  decisionId: number;
  /** True when the code's stop owned a line and B̂ followed the real bot without correcting. */
  followedRealBot: boolean;
  /** The lines the correction produced (null when none was computed). */
  lines: readonly CorrectedLine[] | null;
  legs: readonly AttributedLeg[];
  /** B̂'s input allocation, and the recomputed clamp when the raw proposal allows one. */
  intention: ModelIntention;
  recomputedClamp: Record<string, number> | null;
}

export interface CriterionJudgement {
  status: CriterionStatus;
  population: number;
  problems: string[];
  facts: Record<string, number | string>;
}

/**
 * W4 — no leg the band creates touches a frozen line. Measured on B̂'s legs AND on the real
 * journal, and NON MESURABLE when no cycle in the window combines a frozen line with a band
 * move — a corpus that never put the rule to the test cannot call it verified.
 */
export function judgeW4(input: {
  cycles: readonly CounterfactualCycle[];
  journal: readonly JournalCorrectionLine[];
}): CriterionJudgement {
  const problems: string[] = [];
  let population = 0;
  let bandLegsOnFrozen = 0;
  let modelLegsOnFrozen = 0;
  for (const cycle of input.cycles) {
    if (cycle.lines == null) continue;
    const frozen = new Set(cycle.lines.filter((l) => !l.mayIncrease && !l.mayDecrease).map((l) => l.asset));
    const bandMoved = cycle.lines.some((l) => l.correctionPoints !== 0);
    if (frozen.size > 0 && bandMoved) population += 1;
    for (const leg of cycle.legs) {
      if (!frozen.has(leg.asset)) continue;
      if (leg.origin === 'modele') modelLegsOnFrozen += 1;
      else {
        bandLegsOnFrozen += 1;
        problems.push(`B̂ cycle ${cycle.decisionId} : la bande envoie ${leg.side} ${leg.asset} sur une ligne gelée`);
      }
    }
    // A frozen line the correction "moved" would be a contradiction in the correction itself.
    for (const line of cycle.lines) {
      if (frozen.has(line.asset) && line.correctionPoints !== 0) {
        problems.push(`B̂ cycle ${cycle.decisionId} : la correction déplace ${line.asset} de ${line.correctionPoints} pt sur une ligne gelée`);
      }
    }
  }
  let journalFrozenLines = 0;
  for (const line of input.journal) {
    if (line.cause !== 'gel') continue;
    journalFrozenLines += 1;
    if (line.correctionPoints !== 0 || (line.origin !== 'modele' && line.plannedSide != null)) {
      problems.push(`journal réel cycle ${line.decisionId} : ${line.asset} gelée et pourtant déplacée par la bande`);
    }
  }
  const status: CriterionStatus = problems.length > 0 ? 'fail' : population === 0 ? 'non_mesurable' : 'pass';
  return {
    status,
    population,
    problems,
    facts: {
      cycles_gel_et_correction: population,
      jambes_bande_sur_gel: bandLegsOnFrozen,
      jambes_modele_sur_gel: modelLegsOnFrozen,
      lignes_gelees_journal: journalFrozenLines,
    },
  };
}

/**
 * W5 — C7 is reconstructed and attributed on the data the replay produced.
 *
 *   * B̂'s input is the model's intention, never the applied allocation — proven by the source
 *     of every cycle and, where the raw proposal allows it, by the recomputed clamp agreeing
 *     with the journal;
 *   * every leg's origin follows its line (band ⇔ the band moved the line);
 *   * the reference cycle, when it is in the window: at 1839 the model asked for XRP 15 only,
 *     which it held — B̂ must send BNB and ETH as the BAND's and nothing on XRP;
 *   * NON MESURABLE when B̂ sends no band leg over the whole window.
 */
export interface ReferenceExpectation {
  decisionId: number;
  bandAssets: readonly string[];
  untouchedAssets: readonly string[];
}

export function judgeW5(input: {
  cycles: readonly CounterfactualCycle[];
  universe: readonly string[];
  reserveAsset: string;
  official: boolean;
  reference: ReferenceExpectation | null;
}): CriterionJudgement {
  const problems: string[] = [];
  let bandLegs = 0;
  let modelLegs = 0;
  let clampChecks = 0;
  let recomputedCycles = 0;
  for (const cycle of input.cycles) {
    if (cycle.followedRealBot) {
      // No correction was computed there: every leg is the real bot's, counted and not judged.
      modelLegs += cycle.legs.length;
      continue;
    }
    if (input.official && cycle.intention.source !== 'journal_clamped') {
      problems.push(`cycle ${cycle.decisionId} : en fenêtre officielle, l’entrée de B̂ n’est pas le journal (${cycle.intention.source})`);
    }
    if (cycle.intention.source === 'clamp_recomputed') recomputedCycles += 1;
    if (cycle.recomputedClamp != null && cycle.intention.source === 'journal_clamped') {
      clampChecks += 1;
      const check = allocationsAgree(cycle.intention.allocation, cycle.recomputedClamp, input.universe, input.reserveAsset);
      if (!check.agree && check.worst != null) {
        problems.push(
          `cycle ${cycle.decisionId} : le clamp recalculé diverge du journal sur ${check.worst.asset} ` +
            `(${check.worst.b} vs ${check.worst.a})`,
        );
      }
    }
    const byAsset = new Map((cycle.lines ?? []).map((l) => [l.asset, l]));
    for (const leg of cycle.legs) {
      const line = byAsset.get(leg.asset);
      const moved = line != null && line.correctionPoints !== 0;
      if (moved !== (leg.origin !== 'modele')) {
        problems.push(`cycle ${cycle.decisionId} : ${leg.asset} attribuée ${leg.origin} alors que la ligne ${moved ? 'est' : 'n’est pas'} déplacée par la bande`);
      }
      if (leg.origin === 'modele') modelLegs += 1;
      else bandLegs += 1;
    }
  }
  if (input.reference != null) {
    const cycle = input.cycles.find((c) => c.decisionId === input.reference!.decisionId);
    if (cycle != null) {
      for (const asset of input.reference.bandAssets) {
        const leg = cycle.legs.find((l) => l.asset === asset);
        if (leg == null) problems.push(`référence ${input.reference.decisionId} : aucune jambe B̂ sur ${asset}`);
        else if (leg.origin === 'modele') problems.push(`référence ${input.reference.decisionId} : ${asset} attribuée au modèle, attendu la bande`);
      }
      for (const asset of input.reference.untouchedAssets) {
        if (cycle.legs.some((l) => l.asset === asset)) {
          problems.push(`référence ${input.reference.decisionId} : une jambe B̂ sur ${asset}, que le modèle détenait déjà à sa cible`);
        }
      }
    }
  }
  const status: CriterionStatus = problems.length > 0 ? 'fail' : bandLegs === 0 ? 'non_mesurable' : 'pass';
  return {
    status,
    population: bandLegs + modelLegs,
    problems,
    facts: {
      jambes_bande: bandLegs,
      jambes_modele: modelLegs,
      controles_clamp: clampChecks,
      cycles_clamp_recalcule: recomputedCycles,
    },
  };
}
